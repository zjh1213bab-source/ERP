<template>
  <div>
    <div class="page-head">
      <div>
        <h2>样衣管理</h2>
        <div class="sub">打版完成的样衣自动归档并锁定；要修改必须提交更改需求，审核通过后才能回到打版流程重做</div>
      </div>
      <div class="tabs" style="margin: 0">
        <button :class="{ on: tab === 'archives' }" @click="tab = 'archives'">样衣档案 {{ list.length }}</button>
        <button :class="{ on: tab === 'changes' }" @click="tab = 'changes'; loadChanges()">
          变更审核 {{ pendingChanges.length }}
        </button>
      </div>
    </div>

    <!-- ========== 样衣档案 ========== -->
    <template v-if="tab === 'archives'">
      <div class="toolbar" style="margin-bottom: 14px">
        <input class="input" v-model="q" placeholder="搜索 样衣编号 / 款号 / 名称 / 客户" style="width: 300px" @keyup.enter="load" />
        <select class="select" v-model="status" @change="load">
          <option value="">全部状态</option>
          <option value="locked">已锁定</option>
          <option value="changing">变更审核中</option>
          <option value="revised">已出新版</option>
        </select>
        <button class="btn btn-ghost" @click="load">查询</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 56px">图片</th>
              <th style="width: 130px">样衣编号</th>
              <th>款号 / 样衣名称</th>
              <th style="width: 70px">版本</th>
              <th style="width: 100px">打板尺码</th>
              <th style="width: 150px">客户</th>
              <th style="width: 110px">归档时间</th>
              <th style="width: 80px">状态</th>
              <th style="width: 170px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in list" :key="a.id">
              <td>
                <div class="mini-thumb" :class="{ clickable: a.image_url }" @click="a.image_url && openImage(a.image_url, a.sample_name || a.archive_no || '')">
                  <img v-if="a.image_url" :src="a.image_url" /><span v-else>-</span>
                </div>
              </td>
              <td><strong>{{ a.archive_no }}</strong></td>
              <td>
                {{ a.style_no || '-' }}
                <div class="sub-line">{{ a.sample_name || '' }}</div>
              </td>
              <td>{{ a.version || '-' }}</td>
              <td class="nw">{{ a.pattern_size || '-' }}</td>
              <td class="nowrap-ellipsis" :title="a.customer">{{ a.customer || '-' }}</td>
              <td>{{ (a.locked_at || a.created_at || '').slice(0, 10) }}</td>
              <td class="nw">
                <span class="tag" :class="statusTag(a.status)">{{ statusLabel(a.status) }}</span>
                <span v-if="a.pending_changes" class="tag orange" style="margin-left: 4px">待审</span>
              </td>
              <td class="nw">
                <button class="link-btn" @click="openDetail(a.id)">查看</button>
                <button v-if="a.status !== 'revised'" class="link-btn" @click="openChange(a)">申请变更</button>
              </td>
            </tr>
            <tr v-if="!list.length"><td colspan="9" class="empty-cell">还没有归档样衣，打版流程走完会自动归档</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ========== 变更审核 ========== -->
    <template v-else>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 130px">样衣编号</th>
              <th>款号 / 样衣</th>
              <th>更改原因</th>
              <th style="width: 90px">申请人</th>
              <th style="width: 110px">申请时间</th>
              <th style="width: 80px">状态</th>
              <th style="width: 200px">审核</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in changes" :key="c.id">
              <td><strong>{{ c.archive_no }}</strong></td>
              <td>{{ c.style_no || '-' }}<div class="sub-line">{{ c.sample_name || '' }}</div></td>
              <td>
                {{ c.reason }}
                <div v-if="c.detail" class="sub-line">{{ c.detail }}</div>
                <div v-if="c.review_note" class="sub-line">审核意见：{{ c.review_note }}</div>
              </td>
              <td>{{ c.applicant || '-' }}</td>
              <td>{{ (c.created_at || '').slice(0, 10) }}</td>
              <td class="nw"><span class="tag" :class="changeTag(c.status)">{{ changeLabel(c.status) }}</span></td>
              <td class="nw">
                <template v-if="c.status === 'pending' && canReview">
                  <button class="link-btn" @click="review(c, true)">通过</button>
                  <button class="link-btn danger" @click="review(c, false)">驳回</button>
                </template>
                <span v-else-if="c.status !== 'pending'" class="sub-line">{{ c.reviewer }} · {{ (c.reviewed_at || '').slice(0, 10) }}</span>
                <span v-else class="sub-line">等待审核</span>
              </td>
            </tr>
            <tr v-if="!changes.length"><td colspan="7" class="empty-cell">暂无变更申请</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 详情 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>
            {{ detail.archive_no }} · {{ detail.style_no || detail.sample_name }}
            <span class="tag" :class="statusTag(detail.status)">{{ statusLabel(detail.status) }}</span>
            <span class="tag gray">已锁定快照</span>
          </h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="snap-grid">
            <div><label>款号</label><div>{{ snap.product_name || '-' }}</div></div>
            <div><label>版本</label><div>{{ detail.version || '-' }}</div></div>
            <div><label>客户款号</label><div>{{ snap.customer_style_no || '-' }}</div></div>
            <div><label>颜色</label><div>{{ snap.colors || '-' }}</div></div>
            <div><label>尺码</label><div>{{ snap.size_range || '-' }}</div></div>
            <div><label>打板尺码</label><div>{{ detail.pattern_size || '-' }}</div></div>
            <div><label>设计师</label><div>{{ snap.designer || '-' }}</div></div>
            <div><label>版师</label><div>{{ snap.pattern_maker || '-' }}</div></div>
            <div><label>客户</label><div>{{ detail.customer || '-' }}</div></div>
            <div><label>归档人</label><div>{{ detail.created_by || '-' }}</div></div>
          </div>

          <h3 class="sec">客户要求</h3>
          <div class="snap-text">{{ snap.customer_req || '—' }}</div>

          <h3 class="sec">面辅料明细（快照）</h3>
          <div class="tbl-scroll">
            <table class="data snap-tbl">
              <thead><tr><th>类型</th><th>物料</th><th>色号</th><th>供应商</th><th>规格</th><th>单件用量</th><th>单价</th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in snap.materials || []" :key="i">
                  <td>{{ m.mat_type === 'fabric' ? '面料' : '辅料' }}</td>
                  <td>{{ m.material_name }}</td>
                  <td>{{ m.color_no || '-' }}</td>
                  <td>{{ m.supplier || '-' }}</td>
                  <td>{{ m.spec_info || '-' }}</td>
                  <td>{{ m.one_use }}</td>
                  <td>{{ m.unit_price }}</td>
                </tr>
                <tr v-if="!(snap.materials || []).length"><td colspan="7" class="empty-cell">无</td></tr>
              </tbody>
            </table>
          </div>

          <h3 class="sec">成衣尺寸（快照）</h3>
          <div class="tbl-scroll">
            <table class="data snap-tbl">
              <thead>
                <tr><th>部位</th><th v-for="c in sizeCols" :key="c">{{ c }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in sizeRows" :key="r.part">
                  <td>{{ r.part }}</td>
                  <td v-for="c in sizeCols" :key="c">{{ r.map[c] || '' }}</td>
                </tr>
                <tr v-if="!sizeRows.length"><td :colspan="sizeCols.length + 1" class="empty-cell">无</td></tr>
              </tbody>
            </table>
          </div>

          <h3 class="sec">生产要求（快照）</h3>
          <div v-for="g in reqGroups" :key="g.key" class="req-g">
            <div class="req-t">{{ g.label }}</div>
            <ol><li v-for="(r, i) in g.items" :key="i">{{ r.content }}</li></ol>
          </div>
          <div v-if="!reqGroups.length" class="sub-line">无</div>

          <h3 class="sec">变更记录</h3>
          <div v-for="c in detail.changes || []" :key="c.id" class="chg-row">
            <span class="tag" :class="changeTag(c.status)">{{ changeLabel(c.status) }}</span>
            {{ c.reason }}
            <span class="sub-line">{{ c.applicant }} · {{ (c.created_at || '').slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <div v-if="!(detail.changes || []).length" class="sub-line">暂无变更记录</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="detail = null">关闭</button>
          <button v-if="detail.status !== 'revised'" class="btn btn-primary" @click="openChange(detail)">提交更改需求</button>
        </div>
      </div>
    </div>

    <!-- 提交更改需求 -->
    <div v-if="changeTarget" class="modal-mask" @click.self="changeTarget = null">
      <div class="modal">
        <div class="modal-head">
          <h3>提交更改需求 · {{ changeTarget.archive_no }}</h3>
          <button class="x" @click="changeTarget = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>更改原因 *</label>
              <textarea v-model="changeForm.reason" rows="3" placeholder="如：客户要求门襟改 6 粒扣 / 面料换色"></textarea>
            </div>
            <div class="fitem full">
              <label>详细说明</label>
              <textarea v-model="changeForm.detail" rows="3" placeholder="具体改哪里、改到什么程度"></textarea>
            </div>
          </div>
          <p class="tip">提交后需技术审核；通过后开发单解锁，回到打版流程的「制版」阶段重做，重新完成后自动生成新版本样衣。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="changeTarget = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="submitChange">提交</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('archives');
const list = ref([]);
const changes = ref([]);
const route = useRoute();
const q = ref(String((route.query && route.query.q) || ''));
const status = ref('');
const detail = ref(null);
const changeTarget = ref(null);
const changeForm = ref({ reason: '', detail: '' });
const busy = ref(false);

const canReview = computed(() => can('pattern.review'));
const pendingChanges = computed(() => changes.value.filter((c) => c.status === 'pending'));

const snap = computed(() => (detail.value && detail.value.snapshot) || {});

const statusLabel = (s) => ({ locked: '已锁定', changing: '变更审核中', revised: '已出新版' }[s] || s);
const statusTag = (s) => ({ locked: 'green', changing: 'orange', revised: 'gray' }[s] || 'gray');
const changeLabel = (s) => ({ pending: '待审核', approved: '已通过', rejected: '已驳回' }[s] || s);
const changeTag = (s) => ({ pending: 'orange', approved: 'green', rejected: 'red' }[s] || 'gray');

const REQ_CATS = [
  { key: 'craft', label: '缝制工艺要求' },
  { key: 'packing', label: '包装与标识要求' },
  { key: 'test', label: '测试与验货要求' },
  { key: 'note', label: '其他注意事项' }
];

const sizeCols = computed(() => {
  const cols = [];
  (snap.value.sizes || []).forEach((s) => { if (!cols.includes(s.size)) cols.push(s.size); });
  return cols;
});
const sizeRows = computed(() => {
  const map = new Map();
  (snap.value.sizes || []).forEach((s) => {
    if (!map.has(s.part)) map.set(s.part, { part: s.part, map: {} });
    map.get(s.part).map[s.size] = s.value;
  });
  return [...map.values()];
});
const reqGroups = computed(() => {
  const rs = snap.value.requirements || [];
  return REQ_CATS.map((c) => ({ ...c, items: rs.filter((r) => r.category === c.key) })).filter((g) => g.items.length);
});

async function load() {
  try { list.value = await api.sampleArchives({ q: q.value, status: status.value }); }
  catch (e) { alert(e.message); }
}
async function loadChanges() {
  try { changes.value = await api.sampleChanges({}); }
  catch (e) { alert(e.message); }
}
async function openDetail(id) {
  try { detail.value = await api.sampleArchive(id); }
  catch (e) { alert(e.message); }
}
function openChange(a) {
  changeTarget.value = a;
  changeForm.value = { reason: '', detail: '' };
}
async function submitChange() {
  if (!changeForm.value.reason.trim()) return alert('请填写更改原因');
  busy.value = true;
  try {
    await api.requestSampleChange(changeTarget.value.id, changeForm.value);
    changeTarget.value = null;
    detail.value = null;
    await load();
    alert('更改需求已提交，等待技术审核');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}
async function review(c, approve) {
  const note = prompt(approve ? '审核意见（可空）' : '驳回原因（可空）') || '';
  busy.value = true;
  try {
    await api.reviewSampleChange(c.id, { approve, note });
    await loadChanges();
    await load();
    alert(approve ? '已通过：开发单解锁，可回打版流程重做' : '已驳回');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(async () => { await load(); await loadChanges(); });
</script>

<style scoped>
.nw { white-space: nowrap; }
.sub-line { font-size: 11.5px; color: #8a94a6; margin-top: 2px; }
.nowrap-ellipsis { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.snap-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px 14px; padding-bottom: 10px; border-bottom: 1px solid #eef2f7; }
.snap-grid label { display: block; font-size: 11.5px; color: #8a94a6; margin-bottom: 2px; }
.snap-grid div > div { font-size: 13px; color: #16233b; }

.sec { font-size: 13.5px; margin: 16px 0 6px; color: #16233b; }
.snap-text {
  border: 1px solid #eef2f7; border-radius: 8px; padding: 8px 10px;
  white-space: pre-wrap; font-size: 12.5px; line-height: 1.7; background: #fafcff; color: #33415a;
}
.tbl-scroll { overflow-x: auto; border: 1px solid #eef2f7; border-radius: 8px; }
.snap-tbl { border: none; min-width: 620px; }
.snap-tbl th, .snap-tbl td { white-space: nowrap; font-size: 12px; padding: 6px 8px; }

.req-g { margin-bottom: 8px; }
.req-t { font-weight: 700; font-size: 12px; color: #33415a; }
.req-g ol { margin: 2px 0 0; padding-left: 20px; }
.req-g li { font-size: 12.5px; line-height: 1.7; color: #33415a; }

.chg-row { font-size: 12.5px; color: #33415a; padding: 4px 0; border-bottom: 1px dashed #eef2f7; }
.tip { font-size: 11.5px; color: #8a94a6; margin-top: 8px; }

@media (max-width: 900px) {
  .snap-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
