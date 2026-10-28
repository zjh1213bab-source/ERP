<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>扎级完工进度</h2>
        <p class="sub">
          车间按<b>扎</b>作业，所以进度也要按扎看：这一页把每扎走到了哪一道工序摆成一张表。
          <b>完工只看末道工序</b>（成品入库），不看「最后一条报工」——
          做完整烫就当完工，是车间最常见的误判；末道报了但不足件数记为<b>短数</b>，短数是钱。
          <b>只统计记了扎号的报工</b>，没记的单独列出，不摊派到扎上。
        </p>
      </div>
      <div class="head-ops">
        <select v-model.number="orderId" class="select" style="min-width: 230px" @change="load">
          <option v-for="o in orders" :key="o.id" :value="o.id">
            {{ o.order_no }} · {{ o.style_name || '未填款名' }}（{{ o.bundles }} 扎）
          </option>
        </select>
        <button class="btn btn-ghost" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="!orders.length" class="panel-card">
      <p class="muted">还没有裁床扎包。这张单要先在「裁床与扎包」分扎，才有统计单位。</p>
    </div>

    <template v-else>
      <div class="cards five">
        <div class="stat-card accent">
          <div class="label">本单扎数 / 件数</div>
          <div class="value">{{ s.bundles || 0 }}<small>扎 / {{ s.total_qty || 0 }} 件</small></div>
        </div>
        <div class="stat-card">
          <div class="label">完工（{{ s.final_process || '末道' }}达标）</div>
          <div class="value" style="color: #16a34a">
            {{ s.done || 0 }}<small>扎 / {{ s.done_qty || 0 }} 件</small>
          </div>
        </div>
        <div class="stat-card">
          <div class="label">在制</div>
          <div class="value" style="color: #2563eb">{{ s.doing || 0 }}<small>扎</small></div>
        </div>
        <div class="stat-card">
          <div class="label">短数（末道不足）</div>
          <div class="value" :style="{ color: s.short ? '#d92d45' : '#8a94a6' }">
            {{ s.short || 0 }}<small>扎 / 差 {{ s.short_qty || 0 }} 件</small>
          </div>
        </div>
        <div class="stat-card">
          <div class="label">未开工</div>
          <div class="value" :style="{ color: s.idle ? '#d97706' : '#8a94a6' }">{{ s.idle || 0 }}<small>扎</small></div>
        </div>
      </div>

      <!-- 口径提示：不写清楚，页面上的数就会被误读 -->
      <div v-if="notices.length" class="notice-box">
        <div v-for="(n, i) in notices" :key="i" class="nt" :class="n.level">{{ n.text }}</div>
      </div>

      <div class="bar">
        <div class="tabs">
          <button v-for="f in FILTERS" :key="f.key" :class="{ on: filter === f.key }" @click="filter = f.key">
            {{ f.label }}<template v-if="f.key !== 'all'"> {{ countOf(f.key) }}</template>
          </button>
        </div>
        <label class="switch">
          <input v-model="showAll" type="checkbox" />
          显示全部 {{ processes.length }} 道工序
        </label>
        <span class="tiny muted">横向可滚 · 点扎号看这一扎的报工</span>
      </div>

      <div class="table-wrap bp-wrap">
        <table class="data bp-table">
          <thead>
            <tr>
              <th class="c-no">扎号</th>
              <th class="c-sku">颜色 / 尺码</th>
              <th class="c-qty">件数</th>
              <th class="c-state">状态</th>
              <th v-for="p in shownProcesses" :key="p.name" class="c-proc" :class="{ final: p.name === s.final_process }">
                <i class="sq">{{ p.seq }}</i>
                <span class="pn">{{ p.name }}</span>
                <i v-if="p.name === s.final_process" class="pf">末道</i>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in rows" :key="b.id" :class="{ 'row-over': b.over }">
              <td class="c-no">
                <a class="bno" @click="openBundle(b)">{{ b.bundle_no }}</a>
                <i v-if="!b.checked" class="chk">待复核</i>
              </td>
              <td class="c-sku">
                <span>{{ b.color || '均色' }} / {{ b.size || '-' }}</span>
                <span v-if="b.dye_lot || b.bed_no" class="lot">{{ [b.dye_lot, b.bed_no].filter(Boolean).join(' · ') }}</span>
              </td>
              <td class="c-qty num">{{ b.qty }}</td>
              <td class="c-state">
                <span class="tag" :class="STATUS[b.status].cls">{{ STATUS[b.status].label }}</span>
                <i v-if="b.over" class="over-tip">超报</i>
                <i class="prog">{{ b.touched }}/{{ processes.length }} 道</i>
              </td>
              <td
                v-for="p in shownProcesses"
                :key="p.name"
                class="c-proc"
                :class="cellClass(b, p)"
                :title="cellTitle(b, p)"
              >
                <template v-if="b.cells[p.name]">
                  <span class="ok">{{ b.cells[p.name].ok }}</span>
                  <span v-if="b.cells[p.name].defect" class="df">+{{ b.cells[p.name].defect }}不良</span>
                </template>
                <span v-else class="none">·</span>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td :colspan="4 + shownProcesses.length" class="empty">没有符合条件的扎</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 未归扎报工：单独列出，不摊派 -->
      <div v-if="s.unassigned_reports" class="panel-card unassigned">
        <h3>未归扎报工（{{ s.unassigned_reports }} 条 / 合格 {{ s.unassigned_qty }} 件）</h3>
        <p class="tiny muted">
          这些报工没有记扎号，无法归到具体扎。它们<b>没有</b>算进上面的扎级进度 ——
          摊派上去会让进度看起来更漂亮，但查不出是谁做的。
        </p>
        <table class="data">
          <thead>
            <tr><th>工序</th><th>合格件数</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in unassignedByNode" :key="u.name">
              <td>{{ u.name }}</td>
              <td class="num">{{ u.qty }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 单扎明细 -->
    <div v-if="picked" class="mask" @click.self="picked = null">
      <div class="dlg">
        <div class="dlg-h">
          <b>扎 {{ picked.bundle_no }}</b>
          <span class="muted">{{ picked.color || '均色' }} / {{ picked.size }} · {{ picked.qty }} 件</span>
          <button class="btn btn-ghost btn-sm" style="margin-left: auto" @click="picked = null">关闭</button>
        </div>
        <div class="dlg-b">
          <div class="kv">
            <span>裁剪单</span><b>{{ picked.cut_no || '-' }}</b>
            <span>缸号 / 床次</span><b>{{ [picked.dye_lot, picked.bed_no].filter(Boolean).join(' · ') || '-' }}</b>
            <span>裁片复核</span>
            <b :style="{ color: picked.checked ? '#16a34a' : '#d97706' }">{{ picked.checked ? '已复核' : '待复核' }}</b>
            <span>末道（{{ s.final_process }}）</span><b>{{ picked.final_ok }} / {{ picked.qty }} 件</b>
            <span>已走工序</span><b>{{ picked.touched }} / {{ processes.length }} 道</b>
          </div>
          <table class="data">
            <thead>
              <tr><th>工序</th><th>合格</th><th>不良</th><th>报工日期</th><th>是否达标</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in processes" :key="p.name">
                <td>{{ p.name }}<i v-if="p.name === s.final_process" class="pf">末道</i></td>
                <template v-if="picked.cells[p.name]">
                  <td class="num">{{ picked.cells[p.name].ok }}</td>
                  <td class="num" :style="{ color: picked.cells[p.name].defect ? '#d92d45' : '#8a94a6' }">
                    {{ picked.cells[p.name].defect }}
                  </td>
                  <td>{{ picked.cells[p.name].last_date || '-' }}</td>
                  <td>
                    <span v-if="picked.cells[p.name].ok >= picked.qty" class="tag green">达标</span>
                    <span v-else class="tag orange">不足 {{ picked.qty - picked.cells[p.name].ok }} 件</span>
                  </td>
                </template>
                <template v-else>
                  <td class="none" colspan="4">未报工</td>
                </template>
              </tr>
            </tbody>
          </table>
          <p class="tiny muted" style="margin-top: 10px">
            要按扎追溯「谁做的」，扫扎标报工才会自动记扎号；在电脑上直接报工不会记扎。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

const STATUS = {
  done: { label: '完工', cls: 'green' },
  doing: { label: '在制', cls: 'blue' },
  short: { label: '短数', cls: 'red' },
  idle: { label: '未开工', cls: 'gray' }
};
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未完工' },
  { key: 'short', label: '短数' },
  { key: 'over', label: '超报' },
  { key: 'idle', label: '未开工' }
];

const orders = ref([]);
const orderId = ref(null);
const processes = ref([]);
const bundles = ref([]);
const s = ref({});
const notices = ref([]);
const filter = ref('all');
const showAll = ref(false);
const picked = ref(null);

/** 默认只显示「有报工的工序 + 末道」，13 道全铺出来大半是空格 */
const shownProcesses = computed(() => {
  if (showAll.value) return processes.value;
  const final = s.value.final_process;
  return processes.value.filter(
    (p) => p.name === final || bundles.value.some((b) => b.cells[p.name])
  );
});

const rows = computed(() => {
  const list = bundles.value;
  const f = filter.value;
  if (f === 'all') return list;
  if (f === 'open') return list.filter((b) => b.status !== 'done');
  if (f === 'short') return list.filter((b) => b.status === 'short');
  if (f === 'over') return list.filter((b) => b.over);
  if (f === 'idle') return list.filter((b) => b.status === 'idle');
  return list;
});

function countOf(key) {
  const list = bundles.value;
  if (key === 'open') return list.filter((b) => b.status !== 'done').length;
  if (key === 'short') return list.filter((b) => b.status === 'short').length;
  if (key === 'over') return list.filter((b) => b.over).length;
  if (key === 'idle') return list.filter((b) => b.status === 'idle').length;
  return list.length;
}

const unassignedByNode = ref([]);

function cellClass(b, p) {
  const c = b.cells[p.name];
  if (!c) return 'none-cell';
  if (b.qty > 0 && c.ok > b.qty) return 'over-cell';
  if (b.qty > 0 && c.ok >= b.qty) return 'full-cell';
  // 末道不足件数 = 短数，这一格必须显眼：短数是钱，混在「在制蓝」里会被漏掉
  if (p.name === s.value.final_process) return 'short-cell';
  return 'part-cell';
}

function cellTitle(b, p) {
  const c = b.cells[p.name];
  if (!c) return `${b.bundle_no} 未报 ${p.name}`;
  const extra = c.defect ? `，不良 ${c.defect}` : '';
  return `${b.bundle_no} ${p.name}：合格 ${c.ok} / 扎 ${b.qty} 件${extra}（${c.last_date || '无日期'}）`;
}

function openBundle(b) {
  picked.value = b;
}

async function load() {
  if (!orderId.value) return;
  const r = await api.bundleProgress(orderId.value);
  processes.value = r.processes || [];
  bundles.value = r.bundles || [];
  s.value = r.summary || {};
  notices.value = r.notices || [];
  unassignedByNode.value = r.unassigned_by_node || [];
}

async function boot() {
  try {
    orders.value = await api.bundleProgressOrders();
    if (orders.value.length) {
      orderId.value = orders.value[0].id;
      await load();
    }
  } catch (e) {
    alert(e.message);
  }
}

onMounted(boot);
</script>

<style scoped>
.cards.five {
  grid-template-columns: repeat(5, 1fr);
}
.notice-box {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nt {
  border-radius: 10px;
  padding: 10px 13px;
  font-size: 12.5px;
  line-height: 1.7;
  border: 1px solid #dbe8ff;
  background: #f4f8ff;
  color: #2b5aa7;
}
.nt.warn {
  border-color: #f5dcb4;
  background: #fffaf2;
  color: #a45c07;
}
.nt.bad {
  border-color: #f3c3cb;
  background: #fef5f6;
  color: #a81b31;
}
.nt b {
  margin-right: 8px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.bar .tabs {
  margin-left: 0;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #5b6474;
  cursor: pointer;
}
.bp-wrap {
  overflow-y: auto;
  max-height: calc(100vh - 380px);
  /* .page 是 flex 且高度受限（手机上 = 视口高度），不给 flex:none 会被压成 2px，
     表格整块消失（页面还在，就是看不见表） */
  flex: none;
}
.bp-table {
  min-width: 900px;
}
.bp-table th,
.bp-table td {
  white-space: nowrap;
  vertical-align: middle;
}
.c-no {
  width: 96px;
  position: sticky;
  left: 0;
  background: #fff;
  z-index: 2;
}
.bp-table thead .c-no {
  background: #f7f9fd;
}
.bno {
  font-family: Consolas, Menlo, monospace;
  font-weight: 800;
  color: #2563eb;
  cursor: pointer;
}
.bno:hover {
  text-decoration: underline;
}
.chk {
  display: block;
  font-size: 10.5px;
  font-style: normal;
  color: #d97706;
}
.c-sku {
  width: 132px;
}
.c-sku .lot {
  display: block;
  font-size: 10.5px;
  color: #8a94a6;
}
.c-qty {
  width: 62px;
  text-align: right;
}
.c-state {
  width: 108px;
}
.over-tip {
  display: block;
  font-size: 10.5px;
  font-style: normal;
  color: #d92d45;
  font-weight: 700;
}
.c-proc {
  width: 74px;
  text-align: center;
  padding: 6px 4px !important;
}
.c-proc .sq {
  display: block;
  font-size: 9px;
  font-style: normal;
  color: #9aa6b8;
  font-weight: 700;
}
.prog {
  display: block;
  font-size: 10px;
  font-style: normal;
  color: #a0aabb;
  margin-top: 3px;
}
.c-proc .pn {
  display: block;
  font-size: 11px;
  font-weight: 600;
}
.c-proc .pf {
  display: block;
  font-size: 9.5px;
  font-style: normal;
  color: #2563eb;
  font-weight: 700;
}
.ok {
  font-size: 13px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.df {
  display: block;
  font-size: 9.5px;
  color: #d92d45;
}
.none {
  color: #c9d2e0;
}
.none-cell {
  background: #fbfcfe;
}
.part-cell .ok {
  color: #2563eb;
}
.full-cell {
  background: #f2fbf5;
}
.full-cell .ok {
  color: #16a34a;
}
.over-cell {
  background: #fdecee;
}
.over-cell .ok {
  color: #d92d45;
}
.short-cell {
  background: #fff4f5;
}
.short-cell .ok {
  color: #d92d45;
  font-weight: 900;
}
.short-cell .ok::after {
  content: ' 缺';
  font-size: 9px;
  font-weight: 700;
}
.row-over .c-no {
  box-shadow: inset 3px 0 0 #d92d45;
}
.empty {
  text-align: center;
  color: #8a94a6;
  padding: 26px 0 !important;
}
.unassigned h3 {
  font-size: 14px;
}
.mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 26, 44, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  padding: 20px;
}
.dlg {
  background: #fff;
  border-radius: 14px;
  width: 780px;
  max-width: 100%;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dlg-h {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid #eef1f6;
}
.dlg-b {
  padding: 16px 18px;
  overflow: auto;
}
.kv {
  display: grid;
  grid-template-columns: 104px 1fr 104px 1fr;
  gap: 8px 12px;
  font-size: 12.5px;
  margin-bottom: 14px;
}
.kv span {
  color: #8a94a6;
}
.kv b {
  font-weight: 600;
  color: #1f2a3d;
  overflow-wrap: anywhere;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 900px) {
  .cards.five {
    grid-template-columns: repeat(2, 1fr);
  }
  .kv {
    grid-template-columns: 90px 1fr;
  }
}
@media (max-width: 600px) {
  /* 手机上固定列占满屏就没法看工序了：颜色/尺码收进「点扎号看明细」，
     状态列压窄，留出横向空间给工序 */
  .bp-table .c-sku {
    display: none;
  }
  .c-no {
    width: 74px;
  }
  .c-qty {
    width: 52px;
  }
  .c-state {
    width: 84px;
  }
  .bp-table {
    min-width: 760px;
  }
  .c-proc {
    width: 62px;
  }
  .bar .switch,
  .bar .tiny {
    font-size: 11.5px;
  }
}
</style>
