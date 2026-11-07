<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>现场照片</h2>
        <p class="sub">
          车间与仓库的问题都是<b>当场看得见、事后说不清</b>。这一页把手机上拍的现场照片集中起来：
          按订单 / 分类 / 日期 / 工序筛，点开看大图与说明。
          <b>不良照片必须写一句说明</b>（比如「左袖口跳线」），否则三个月后没人看得懂；
          删除是<b>软删除</b>——照片是证据，物理删掉之后「当时到底什么样」就永远说不清了。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="load">刷新</button>
        <button class="btn btn-ghost" @click="goShoot">手机拍照页</button>
      </div>
    </div>

    <div class="cards">
      <div class="stat-card accent">
        <div class="label">照片总数</div>
        <div class="value">{{ s.total || 0 }}<small>张</small></div>
      </div>
      <div class="stat-card">
        <div class="label">涉及订单</div>
        <div class="value">{{ s.orders || 0 }}<small>单</small></div>
      </div>
      <div class="stat-card">
        <div class="label">不良照片</div>
        <div class="value" :style="{ color: defectCount ? '#d92d45' : '#16a34a' }">
          {{ defectCount }}<small>张</small>
        </div>
      </div>
      <div class="stat-card">
        <div class="label">占用空间</div>
        <div class="value">{{ s.size_mb || 0 }}<small>MB</small></div>
      </div>
    </div>

    <!-- 近 14 天 -->
    <div class="panel">
      <div class="panel-h">
        <b>近 14 天拍摄量</b>
        <span class="tiny muted">压到长边 1600px / 0.82 质量，一张约 200–400KB，不压缩传不动</span>
      </div>
      <div class="trend">
        <div v-for="d in s.days || []" :key="d.date" class="trend-col">
          <div class="trend-bar-wrap">
            <div class="trend-bar" :style="{ height: barH(d.count) }" :title="`${d.date} · ${d.count} 张`"></div>
          </div>
          <div class="trend-n" :class="{ zero: !d.count }">{{ d.count || '' }}</div>
          <div class="trend-d">{{ d.date.slice(5) }}</div>
        </div>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="filters">
      <div class="cats">
        <button class="chip" :class="{ on: !cat }" @click="setCat('')">
          全部 <span class="chip-n">{{ s.total || 0 }}</span>
        </button>
        <button
          v-for="c in s.cats || []"
          :key="c.code"
          class="chip"
          :class="{ on: cat === c.code, danger: c.code === 'defect' && c.count > 0 }"
          @click="setCat(c.code)"
        >
          {{ c.label }} <span class="chip-n">{{ c.count }}</span>
        </button>
      </div>
      <div class="filter-row">
        <input v-model="keyword" class="inp" placeholder="搜单号 / 款名 / 说明" @keyup.enter="load(0)" />
        <input v-model="from" type="date" class="inp date" />
        <span class="tilde">~</span>
        <input v-model="to" type="date" class="inp date" />
        <button class="btn btn-ghost sm" @click="load(0)">查询</button>
        <button class="btn btn-ghost sm" @click="resetFilter">重置</button>
      </div>
    </div>

    <!-- 网格 -->
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!rows.length" class="empty">
      这段时间没有照片。到手机上打开「拍照留证」拍一张试试。
    </div>
    <div v-else class="grid">
      <div v-for="p in rows" :key="p.id" class="cell" @click="open(p)">
        <img :src="p.url" :alt="p.note || p.cat_label" loading="lazy" />
        <span class="cell-cat" :class="p.cat">{{ p.cat_label }}</span>
        <div class="cell-foot">
          <div class="cell-no">{{ p.order_no || '—' }}</div>
          <div class="cell-note">{{ p.note || (p.node_name ? p.node_name : '（没写说明）') }}</div>
        </div>
      </div>
    </div>

    <div v-if="rows.length" class="more">
      <span class="tiny muted">已显示 {{ rows.length }} / {{ total }} 张</span>
      <button v-if="hasMore" class="btn btn-ghost sm" :disabled="loading" @click="load(rows.length)">
        加载更多
      </button>
    </div>

    <!-- 大图 -->
    <div v-if="cur" class="mask">
      <div class="viewer">
        <img :src="cur.url" alt="" />
        <div class="viewer-side">
          <div class="viewer-top">
            <span class="cell-cat big" :class="cur.cat">{{ cur.cat_label }}</span>
            <span class="tiny muted">{{ cur.size_kb }}KB</span>
          </div>
          <div class="viewer-note">{{ cur.note || '（没写说明）' }}</div>
          <dl class="meta">
            <dt>订单</dt>
            <dd>
              <a v-if="cur.order_no" class="link" @click="goOrder(cur)">{{ cur.order_no }}</a>
              <span v-else>—</span>
            </dd>
            <dt>款名</dt>
            <dd>{{ cur.style_name || '—' }}</dd>
            <dt>工序</dt>
            <dd>{{ cur.node_name || '未指定' }}</dd>
            <dt>拍摄</dt>
            <dd>{{ cur.shot_at }}</dd>
            <dt>上传人</dt>
            <dd>{{ cur.uploader || '—' }}</dd>
          </dl>
          <div class="viewer-ops">
            <button v-if="cur.order_id !== undefined || cur.order_no" class="btn btn-ghost sm" @click="goOrder(cur)">
              看订单
            </button>
            <button v-action="['photos','delete']" v-if="can('photo.write')" class="btn btn-ghost sm danger" @click="del(cur)">删除</button>
          </div>
          <p class="tiny muted">删除只是加一个标记，文件仍保留在服务器上——照片是证据，不能真删。</p>
        </div>
        <button class="viewer-close" @click="cur = null">×</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter();

const s = ref({});
const rows = ref([]);
const total = ref(0);
const hasMore = ref(false);
const loading = ref(false);
const cur = ref(null);
const cat = ref('');
const keyword = ref('');
const from = ref('');
const to = ref('');

const defectCount = computed(() => {
  const c = (s.value.cats || []).find((x) => x.code === 'defect');
  return c ? c.count : 0;
});

const maxDay = computed(() => Math.max(1, ...((s.value.days || []).map((d) => d.count))));
function barH(n) {
  if (!n) return '2px';
  return Math.max(6, Math.round((n / maxDay.value) * 62)) + 'px';
}

async function load(offset = 0) {
  loading.value = true;
  try {
    const params = { limit: 60, offset };
    if (cat.value) params.cat = cat.value;
    if (keyword.value) params.keyword = keyword.value;
    if (from.value) params.from = from.value;
    if (to.value) params.to = to.value;
    const [st, list] = await Promise.all([
      api.photoStats({ from: from.value || undefined, to: to.value || undefined }),
      api.photos(params)
    ]);
    s.value = st || {};
    const next = (list && list.rows) || [];
    rows.value = offset ? rows.value.concat(next) : next;
    total.value = (list && list.total) || 0;
    hasMore.value = !!(list && list.has_more);
  } catch (e) {
    alert(e.message);
  } finally {
    loading.value = false;
  }
}

function setCat(c) {
  cat.value = c;
  load(0);
}

function resetFilter() {
  cat.value = '';
  keyword.value = '';
  from.value = '';
  to.value = '';
  load(0);
}

function open(p) {
  cur.value = p;
}

function goOrder(p) {
  if (!p.target_id) return;
  router.push({ path: '/orders', query: { order: p.target_id } });
}

function goShoot() {
  router.push('/m/photo');
}

async function del(p) {
  if (!confirm(`删除这张照片？\n\n${p.order_no || ''} · ${p.cat_label} · ${p.note || '无说明'}`)) return;
  try {
    await api.deletePhoto(p.id);
    cur.value = null;
    load(0);
  } catch (e) {
    alert(e.message);
  }
}

onMounted(() => load(0));
</script>

<style scoped>
.sub { font-size: 12.5px; color: var(--ink-soft); line-height: 1.9; margin: 6px 0 0; max-width: 900px; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.panel {
  background: var(--surface); border: 1px solid #e6ebf3; border-radius: 14px;
  padding: 14px 16px; margin-bottom: 14px;
}
.panel-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.panel-h b { font-size: 13.5px; }
.trend { display: flex; align-items: flex-end; gap: 4px; }
.trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
.trend-bar-wrap { width: 100%; height: 66px; display: flex; align-items: flex-end; justify-content: center; }
.trend-bar { width: 100%; max-width: 26px; background: var(--brand); border-radius: 3px 3px 0 0; opacity: 0.85; }
.trend-n { font-size: 12px; color: var(--ink-soft); height: 12px; }
.trend-n.zero { color: transparent; }
.trend-d { font-size: 12px; color: #a6b0c0; }

.filters {
  background: var(--surface); border: 1px solid #e6ebf3; border-radius: 14px;
  padding: 12px 14px; margin-bottom: 14px;
}
.cats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.chip {
  border: 1px solid #dbe3ef; background: var(--surface); color: #4a5769; border-radius: 20px;
  padding: 6px 14px; font-size: 12.5px; cursor: pointer;
}
.chip.on { background: var(--brand); border-color: #2563eb; color: var(--on-brand); font-weight: 700; }
.chip.danger:not(.on) { border-color: #f3c3cb; color: #d92d45; }
.chip-n { font-size: 12px; opacity: 0.75; margin-left: 2px; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.inp {
  border: 1px solid #d9e1ee; border-radius: 9px; padding: 7px 11px; font-size: 12.5px;
  min-width: 200px;
}
.inp.date { min-width: 0; width: 140px; }
.tilde { color: #a6b0c0; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.cell {
  position: relative; background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px;
  overflow: hidden; cursor: pointer; transition: box-shadow 0.15s;
}
.cell:hover { box-shadow: 0 4px 16px rgba(30, 50, 90, 0.12); }
.cell img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; background: #f4f7fc; }
.cell-cat {
  position: absolute; left: 7px; top: 7px; font-size: 12px; font-weight: 700;
  padding: 2px 8px; border-radius: 20px; background: rgba(255, 255, 255, 0.94); color: var(--brand);
}
.cell-cat.defect { color: #d92d45; }
.cell-cat.incoming { color: #b45309; }
.cell-cat.packing { color: #0f766e; }
.cell-cat.sample { color: #7c3aed; }
.cell-cat.big { position: static; font-size: 12px; }
.cell-foot { padding: 7px 9px 9px; }
.cell-no { font-size: 12px; color: var(--ink-mute); }
.cell-note {
  font-size: 12.5px; color: #1f2a3d; margin-top: 2px; line-height: 1.45;
  /* 两行截断：「左袖口跳线 3 处，已停线待返工」一行放不下，截成一行等于没说 */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; min-height: 36px;
}
.empty {
  background: var(--surface); border: 1px dashed #dbe3ef; border-radius: 14px;
  padding: 40px 0; text-align: center; color: #a6b0c0; font-size: 13px;
}
.more { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 18px 0; }
.link { color: var(--brand); cursor: pointer; }
.btn.danger { color: #d92d45; border-color: #f3c3cb; }

.mask {
  position: fixed; inset: 0; background: rgba(12, 20, 36, 0.86);
  display: flex; align-items: center; justify-content: center; z-index: 90; padding: 24px;
}
.viewer {
  position: relative; display: flex; gap: 0; max-width: 1080px; width: 100%;
  background: #16233b; border-radius: 14px; overflow: hidden; max-height: 86vh;
}
.viewer > img {
  flex: 1; min-width: 0; object-fit: contain; background: #0d1626;
  max-height: 86vh;
}
.viewer-side {
  width: 300px; flex: none; padding: 18px; color: #dfe6f2;
  border-left: 1px solid #26344e; overflow-y: auto;
}
.viewer-top { display: flex; align-items: center; justify-content: space-between; padding-right: 30px; }
.viewer-note { font-size: 15px; color: #fff; margin: 10px 0 14px; line-height: 1.6; }
.meta { margin: 0; display: grid; grid-template-columns: 56px 1fr; gap: 7px 10px; font-size: 12.5px; }
.meta dt { color: #8b9ab2; }
.meta dd { margin: 0; color: #dfe6f2; }
.viewer-ops { display: flex; gap: 8px; margin: 16px 0 8px; }
.viewer-side .muted { color: #7b8aa3; }
.viewer-side .btn { background: transparent; color: #cfe0ff; border-color: #3a4a66; }
.viewer-side .btn.danger { color: #ff9aa9; border-color: #6b3340; }
.viewer-close {
  position: absolute; right: 10px; top: 8px; width: 30px; height: 30px;
  border: none; border-radius: 50%; background: rgba(20, 30, 50, 0.6);
  color: #fff; font-size: 20px; line-height: 1; cursor: pointer;
}

@media (max-width: 900px) {
  .cards { grid-template-columns: 1fr 1fr; }
  .viewer { flex-direction: column; }
  .viewer-side { width: 100%; border-left: none; border-top: 1px solid #26344e; }
  .viewer > img { max-height: 52vh; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
}
</style>
