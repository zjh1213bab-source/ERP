<template>
  <div class="ir-wrap">
    <!-- 工具栏（打印时隐藏） -->
    <div class="ir-bar no-print">
      <button class="btn btn-ghost btn-sm" @click="back">‹ 返回</button>
      <b>验货报告</b>
      <span class="ir-bar-no">{{ snap.order ? snap.order.order_no : '' }}</span>
      <span class="ir-spacer"></span>
      <select v-if="history.length" v-model.number="curId" class="inp sm" @change="openVersion">
        <option v-if="isPreview" :value="null" disabled>历史版本（{{ history.length }}）</option>
        <option v-for="h in history" :key="h.id" :value="h.id">
          v{{ h.version }} · {{ h.report_no }} · {{ fmt(h.generated_at) }}
        </option>
      </select>
      <button class="btn btn-ghost btn-sm" @click="loadPreview" :disabled="busy">刷新预览</button>
      <button class="btn btn-sm" @click="generate" :disabled="busy">
        {{ busy ? '处理中…' : (isPreview ? '生成报告' : '重新生成') }}
      </button>
      <button class="btn btn-ghost btn-sm" @click="print">打印 / 另存为 PDF</button>
    </div>

    <div v-if="err" class="ir-err no-print">{{ err }}</div>

    <div v-if="loading" class="ir-loading no-print">加载中…</div>

    <!-- 报告纸张 -->
    <div v-else-if="snap.order" class="sheet">
      <!-- 抬头 -->
      <div class="sheet-head">
        <div>
          <div class="co">跳色科技 · 服装事业部</div>
          <h1>验 货 报 告</h1>
          <div class="sub">INSPECTION REPORT</div>
        </div>
        <div class="head-meta">
          <div><span>报告编号</span><b>{{ isPreview ? '（未生成）' : report.report_no }}</b></div>
          <div><span>版本</span><b>{{ isPreview ? '预览' : 'v' + report.version }}</b></div>
          <div><span>生成时间</span><b>{{ isPreview ? fmt(snap.generated_at) : fmt(report.generated_at) }}</b></div>
          <div><span>生成人</span><b>{{ isPreview ? (auth.user?.name || auth.user?.username) : (report.generated_by || '—') }}</b></div>
        </div>
      </div>

      <div v-if="isPreview" class="preview-note no-print">
        下面是<b>实时预览</b>，还没有编号。确认照片全了、验货结论是最新那张之后，点右上角「生成报告」出正式版。
        正式版会存快照：之后内部再报工、再补照片，这份报告不会跟着变。
      </div>

      <!-- 结论条 -->
      <div class="verdict" :class="qcClass">
        <div class="verdict-key">验货结论</div>
        <div class="verdict-val">{{ snap.qc.result_label }}</div>
        <div class="verdict-meta">
          <span v-if="snap.qc.inspection_no">依据 {{ snap.qc.inspection_no }}</span>
          <span v-else>本单尚无已完成的验货记录</span>
          <span v-if="snap.qc.inspect_date">· {{ snap.qc.inspect_date }}</span>
          <span v-if="snap.qc.inspector">· 验货 {{ snap.qc.inspector }}</span>
        </div>
      </div>

      <!-- 一、订单信息 -->
      <h2>一、订单信息</h2>
      <table class="kv">
        <tbody>
          <tr><th>订单号</th><td>{{ snap.order.order_no }}</td><th>客户</th><td>{{ snap.order.customer_name }}</td></tr>
          <tr><th>款名</th><td>{{ snap.order.style_name || '—' }}</td><th>客户订单号</th><td>{{ snap.order.cus_order_no || '—' }}</td></tr>
          <tr><th>跟单员</th><td>{{ snap.order.manager || '—' }}</td><th>订单状态</th><td>{{ snap.order.status_label }}</td></tr>
          <tr><th>下单日期</th><td>{{ snap.order.order_date || '—' }}</td><th>交期</th><td>{{ snap.order.delivery_date || '—' }}</td></tr>
          <tr><th>交货方式</th><td>{{ snap.order.delivery_method || '—' }}</td><th>贸易条款</th><td>{{ snap.order.trade_terms || '—' }}</td></tr>
          <tr><th>总数量</th><td><b>{{ snap.total_qty }}</b> 件</td><th>包装要求</th><td>{{ snap.order.packaging || '—' }}</td></tr>
          <tr v-if="snap.order.shop_name"><th>店铺</th><td>{{ snap.order.shop_name }}</td><th>店铺单号</th><td>{{ snap.order.shop_order_no || '—' }}</td></tr>
        </tbody>
      </table>

      <!-- 二、款色码明细 -->
      <h2>二、款色码明细</h2>
      <table class="grid-table">
        <thead>
          <tr><th style="width: 46px">序号</th><th>品名</th><th style="width: 100px">款号</th><th style="width: 70px">颜色</th><th style="width: 70px">数量</th></tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in snap.item_lines" :key="i">
            <td>{{ i + 1 }}</td>
            <td>{{ l.product_name }}</td>
            <td>{{ l.style_no || '—' }}</td>
            <td>{{ l.color || '—' }}</td>
            <td class="num">{{ l.qty }}</td>
          </tr>
          <tr v-if="!snap.item_lines.length"><td colspan="5" class="muted center">无明细</td></tr>
          <tr class="total"><td colspan="4">合计</td><td class="num">{{ snap.total_qty }}</td></tr>
        </tbody>
      </table>

      <!-- 尺码矩阵 -->
      <template v-if="snap.size_matrix && snap.size_matrix.sizes.length">
        <h3>尺码配比</h3>
        <table class="grid-table">
          <thead>
            <tr><th v-for="s in snap.size_matrix.sizes" :key="s">{{ s }}</th><th>合计</th></tr>
          </thead>
          <tbody>
            <tr>
              <td v-for="c in snap.size_matrix.counts" :key="c.size" class="num">{{ c.qty }}</td>
              <td class="num"><b>{{ snap.total_qty }}</b></td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- 三、验货结果 -->
      <h2>三、验货结果</h2>
      <template v-if="snap.qc.inspections.length">
        <table class="grid-table">
          <thead>
            <tr>
              <th style="width: 118px">验货单号</th><th style="width: 52px">类型</th><th style="width: 82px">验货日期</th>
              <th style="width: 62px">抽检</th><th style="width: 62px">合格</th><th style="width: 62px">不合格</th>
              <th style="width: 78px">判定</th><th>标准 / 备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ins in snap.qc.inspections" :key="ins.id">
              <td>{{ ins.inspect_no }}</td>
              <td>{{ ins.type_label }}</td>
              <td>{{ ins.inspect_date || '—' }}</td>
              <td class="num">{{ ins.sample_qty }}</td>
              <td class="num">{{ ins.pass_qty }}</td>
              <td class="num">{{ ins.fail_qty }}</td>
              <td :class="resultClass(ins.aql_result)">{{ ins.status !== 'done' ? '未完成' : resultLabel(ins.aql_result) }}</td>
              <td>
                {{ ins.standard_name || '—' }}
                <span v-if="ins.remark">· {{ ins.remark }}</span>
                <span v-if="ins.critical_ng" class="ng-flag">含致命项不合格</span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 检验项明细 -->
        <template v-for="ins in snap.qc.inspections" :key="'items' + ins.id">
          <h3 v-if="ins.items.length">{{ ins.inspect_no }} 检验项（不良 {{ ins.ng_count }} 项）</h3>
          <table v-if="ins.items.length" class="grid-table items">
            <thead>
              <tr>
                <th style="width: 32px">#</th><th style="width: 158px">检验项</th><th>标准要求</th>
                <th style="width: 96px">实测</th><th style="width: 56px">结果</th><th style="width: 86px">备注</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in ins.items" :key="it.seq">
                <td>{{ it.seq }}</td>
                <td>
                  {{ it.item_name }}
                  <span v-if="it.critical" class="crit">致命</span>
                </td>
                <td>{{ it.standard || '—' }}</td>
                <td>{{ it.actual || '—' }}</td>
                <td :class="it.result === 'ng' ? 'ng' : 'ok'">{{ it.result === 'ng' ? '不合格' : it.result === 'ok' ? '合格' : '—' }}</td>
                <td>{{ it.remark || '' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
      <div v-else class="empty-line">本单没有验货记录。未验货不出合格结论 —— 需要出报告请先在「质量与合规」建验货单并完成判定。</div>

      <!-- 四、质量异常 -->
      <h2>四、质量异常</h2>
      <table v-if="snap.issues.length" class="grid-table">
        <thead>
          <tr>
            <th style="width: 118px">异常单号</th><th style="width: 56px">类型</th><th style="width: 56px">等级</th>
            <th style="width: 52px">数量</th><th>问题描述</th><th style="width: 62px">状态</th><th style="width: 80px">责任人</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in snap.issues" :key="x.issue_no">
            <td>{{ x.issue_no }}</td>
            <td>{{ issueType(x.type) }}</td>
            <td :class="x.severity === 'critical' ? 'ng' : ''">{{ severity(x.severity) }}</td>
            <td class="num">{{ x.qty }}</td>
            <td>{{ x.description }}</td>
            <td>{{ x.status === 'closed' ? '已关闭' : '处理中' }}</td>
            <td>{{ x.owner || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-line">无质量异常记录。</div>
      <div v-if="snap.issues_open" class="warn-line">
        生成报告时仍有 <b>{{ snap.issues_open }}</b> 条异常未关闭 —— 报告对外前请确认是否可以放行。
      </div>

      <!-- 五、首件与生产 -->
      <h2>五、首件确认与生产情况</h2>
      <table class="kv">
        <tbody>
          <tr>
            <th>首件确认</th>
            <td>
              <template v-if="snap.first_article">
                {{ snap.first_article.fa_no }} · {{ faStatus(snap.first_article.status) }}
                <span v-if="snap.first_article.conclusion">· {{ snap.first_article.conclusion }}</span>
              </template>
              <span v-else>—</span>
            </td>
            <th>报工累计</th>
            <td>合格 {{ snap.production.ok_qty }} / 不良 {{ snap.production.defect_qty }}</td>
          </tr>
          <tr>
            <th>工序不良率</th>
            <td>
              {{ snap.production.defect_rate === null ? '暂无报工' : snap.production.defect_rate + '%' }}
            </td>
            <th>累计工时</th>
            <td>{{ snap.production.hours }} 小时</td>
          </tr>
        </tbody>
      </table>

      <!-- 六、现场照片 -->
      <h2>六、现场照片（{{ snap.photos_count }} 张）</h2>
      <template v-if="snap.photos_count">
        <template v-for="g in snap.photos_by_cat" :key="g.cat">
          <h3 :class="g.cat === 'defect' ? 'cat-defect' : ''">{{ g.label }}（{{ g.items.length }} 张）</h3>
          <div class="photos">
            <figure v-for="p in g.items" :key="p.id">
              <img :src="p.url" :alt="p.note || g.label" />
              <figcaption>
                <b>{{ p.note || '（未写说明）' }}</b>
                <span>{{ p.node_name ? p.node_name + ' · ' : '' }}{{ fmt(p.shot_at) }}</span>
              </figcaption>
            </figure>
          </div>
        </template>
      </template>
      <div v-else class="empty-line">本单没有现场照片。</div>

      <!-- 结论与签字 -->
      <h2>七、结论与签字</h2>
      <div class="conclusion">
        <p v-if="snap.qc.result === 'pass'">
          经抽检，本批产品符合约定标准，判定<b>合格</b>，同意出货。
        </p>
        <p v-else-if="snap.qc.result === 'conditional'">
          经抽检，本批产品存在轻微问题，经双方确认后可<b>让步接收</b>，具体以后附异常单处理意见为准。
        </p>
        <p v-else-if="snap.qc.result === 'fail'">
          经抽检，本批产品<b>不合格</b>，需返工或重新生产后再次验货，不得出货。
        </p>
        <p v-else>
          本批产品<b>尚未完成验货</b>，本报告仅汇总当前生产与现场情况，不作为出货依据。
        </p>
        <p class="tiny-note">
          说明：本报告为 {{ fmt(isPreview ? snap.generated_at : report.generated_at) }} 的数据快照，
          之后系统内的变动不改变本报告内容。照片未经修图处理。
        </p>
      </div>

      <table class="sign">
        <tbody>
          <tr>
            <th>验货人</th><td></td>
            <th>验货日期</th><td></td>
            <th>客户确认</th><td></td>
          </tr>
        </tbody>
      </table>
      <p class="tiny-note">签字即表示已核对本报告所列数量、验货结论与现场照片。</p>
    </div>

    <div v-else-if="!loading" class="ir-loading no-print">没有数据</div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { auth } from '../store/auth';
import { fmtTime } from '../utils/time';

const route = useRoute();
const router = useRouter();

const orderId = computed(() => Number(route.params.orderId));
const snap = ref({});
const report = ref({});
const history = ref([]);
const curId = ref(null);
const loading = ref(false);
const busy = ref(false);
const err = ref('');

const isPreview = computed(() => !report.value.report_no);
const qcClass = computed(() => {
  const r = snap.value.qc && snap.value.qc.result;
  return { pass: 'ok', conditional: 'warn', fail: 'bad', none: 'none' }[r] || 'none';
});

const RESULT_LABEL = { pass: '合格', fail: '不合格', conditional: '让步接收', none: '未验货' };
function resultLabel(r) { return RESULT_LABEL[r] || (r || '—'); }
function resultClass(r) {
  return r === 'pass' ? 'ok' : r === 'fail' ? 'ng' : r === 'conditional' ? 'warn' : '';
}
function issueType(t) {
  return { rework: '返工', concession: '让步', scrap: '报废', complaint: '客诉' }[t] || t || '—';
}
function severity(s) {
  return { critical: '致命', major: '严重', minor: '轻微' }[s] || s || '—';
}
function faStatus(s) {
  return { draft: '待检', pending: '待确认', passed: '通过', rejected: '不通过', released: '已放行' }[s] || s || '—';
}
/**
 * 后端 now() 是 UTC ISO，直接截断会差 8 小时（早上 8 点生成 → 显示 00:18）。
 * 交给 fmtTime 判时区：带 Z 的转本地，业务日期（本地字符串）原样。
 */
function fmt(s) {
  return fmtTime(s);
}

async function loadPreview() {
  loading.value = true;
  err.value = '';
  try {
    const [s, hist] = await Promise.all([
      api.inspectionPreview(orderId.value),
      api.inspectionHistory(orderId.value).catch(() => [])
    ]);
    snap.value = s;
    history.value = hist || [];
    report.value = {};
    curId.value = null;
  } catch (e) {
    err.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function openVersion() {
  if (!curId.value) return;
  loading.value = true;
  err.value = '';
  try {
    const r = await api.inspectionGet(curId.value);
    report.value = r;
    snap.value = r.snapshot || {};
  } catch (e) {
    err.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function generate() {
  busy.value = true;
  err.value = '';
  try {
    const r = await api.inspectionCreate({ order_id: orderId.value });
    report.value = r;
    snap.value = r.snapshot || {};
    history.value = (await api.inspectionHistory(orderId.value).catch(() => [])) || [];
    curId.value = r.id;
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

function print() {
  window.print();
}

function back() {
  if (window.history.length > 1) router.back();
  else router.push('/orders');
}

onMounted(async () => {
  // 带 ?report=id 时直接打开那一版（从别的页面点进来）
  const rid = route.query.report;
  if (rid) {
    loading.value = true;
    try {
      const r = await api.inspectionGet(rid);
      report.value = r;
      snap.value = r.snapshot || {};
      history.value = (await api.inspectionHistory(r.order_id).catch(() => [])) || [];
      curId.value = r.id;
    } catch (e) {
      err.value = e.message;
    } finally {
      loading.value = false;
    }
    return;
  }
  loadPreview();
});
</script>

<style scoped>
.ir-wrap { background: #eef2f7; min-height: 100vh; padding: 0 0 40px; }
.ir-bar {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  background: #fff; border-bottom: 1px solid #e2e8f1; position: sticky; top: 0; z-index: 10;
  flex-wrap: wrap;
}
.ir-bar b { font-size: 14px; }
.ir-bar-no { font-size: 12.5px; color: #8a94a6; }
.ir-spacer { flex: 1; }
.inp.sm { padding: 5px 9px; font-size: 12px; border: 1px solid #d9e1ee; border-radius: 8px; max-width: 260px; }
.ir-err {
  margin: 12px 16px 0; font-size: 12.5px; color: #d92d45; background: #fef5f6;
  border: 1px solid #f3c3cb; border-radius: 9px; padding: 9px 12px;
}
.ir-loading { padding: 60px 0; text-align: center; color: #8a94a6; font-size: 13px; }

/* A4 纸张 */
.sheet {
  width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff;
  padding: 16mm 15mm 14mm; box-shadow: 0 2px 18px rgba(30, 50, 90, 0.1);
  color: #1f2a3d; font-size: 12px; line-height: 1.65;
}
.sheet-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  padding-bottom: 12px; border-bottom: 2px solid #1f2a3d;
}
.co { font-size: 11px; color: #6b7688; letter-spacing: 0.5px; }
.sheet-head h1 { margin: 4px 0 0; font-size: 25px; letter-spacing: 5px; font-weight: 800; }
.sheet-head .sub { font-size: 9.5px; color: #94a0b2; letter-spacing: 2px; }
.head-meta { font-size: 10.5px; color: #4a5769; text-align: right; min-width: 210px; }
.head-meta div { display: flex; justify-content: flex-end; gap: 8px; }
.head-meta span { color: #8a94a6; }
.head-meta b { font-weight: 700; }

.preview-note {
  margin: 10px 0 0; padding: 9px 12px; border-radius: 6px; font-size: 11px;
  background: #f2f7ff; border: 1px solid #dbe8ff; color: #2b5aa7; line-height: 1.7;
}

/* 结论条 */
.verdict {
  display: flex; align-items: center; gap: 14px; margin: 14px 0 4px;
  padding: 11px 16px; border-radius: 8px; border: 1px solid #e2e8f1; background: #f7f9fd;
}
.verdict-key { font-size: 11px; color: #6b7688; letter-spacing: 1px; }
.verdict-val { font-size: 22px; font-weight: 800; letter-spacing: 2px; }
.verdict-meta { font-size: 10.5px; color: #6b7688; }
.verdict.ok { background: #f2fbf5; border-color: #cfe8d8; }
.verdict.ok .verdict-val { color: #16a34a; }
.verdict.bad { background: #fef5f6; border-color: #f3c3cb; }
.verdict.bad .verdict-val { color: #d92d45; }
.verdict.warn { background: #fffbf0; border-color: #f0e0bb; }
.verdict.warn .verdict-val { color: #b45309; }
.verdict.none .verdict-val { color: #6b7688; }

h2 {
  font-size: 13.5px; margin: 18px 0 7px; padding-bottom: 4px;
  border-bottom: 1px solid #dfe6f0; font-weight: 800;
}
h3 { font-size: 12px; margin: 12px 0 6px; color: #33415a; font-weight: 700; }
h3.cat-defect { color: #d92d45; }

table { width: 100%; border-collapse: collapse; }
.kv th, .kv td, .grid-table th, .grid-table td, .sign th, .sign td {
  border: 1px solid #dfe6f0; padding: 5px 7px; font-size: 11px; vertical-align: top;
}
.kv th { background: #f7f9fd; color: #5b6474; font-weight: 700; width: 78px; white-space: nowrap; }
.grid-table th { background: #f7f9fd; color: #5b6474; font-weight: 700; text-align: left; }
.grid-table td.num, .grid-table th.num { text-align: right; }
.num { text-align: right; }
.grid-table tr.total td { background: #fbfcfe; font-weight: 700; }
.center { text-align: center; }
.muted { color: #94a0b2; }
.ok { color: #16a34a; font-weight: 700; }
.ng { color: #d92d45; font-weight: 700; }
.warn { color: #b45309; font-weight: 700; }
.ng-flag {
  display: inline-block; margin-left: 6px; font-size: 9.5px; color: #d92d45;
  border: 1px solid #f3c3cb; border-radius: 10px; padding: 0 6px;
}
.crit {
  display: inline-block; font-size: 9px; color: #d92d45; border: 1px solid #f3c3cb;
  border-radius: 3px; padding: 0 3px; margin-left: 3px;
}
.items td { font-size: 10.5px; }
/* 检验项列不折行：折了会把这一行撑高，六行表看起来参差不齐 */
.items td:nth-child(2) { white-space: nowrap; }
.items .crit { white-space: nowrap; }
.empty-line {
  padding: 9px 11px; font-size: 11px; color: #8a94a6;
  background: #fbfcfe; border: 1px dashed #dfe6f0; border-radius: 6px;
}
.warn-line {
  margin-top: 7px; padding: 7px 10px; font-size: 11px;
  background: #fffbf0; border: 1px solid #f0e0bb; border-radius: 6px; color: #8a5a12;
}

/* 照片 */
.photos {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 6px;
}
.photos figure {
  margin: 0; border: 1px solid #e2e8f1; border-radius: 5px; overflow: hidden;
  page-break-inside: avoid; break-inside: avoid;
}
.photos img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #f2f5fa; }
.photos figcaption { padding: 4px 6px 5px; font-size: 9.5px; line-height: 1.45; }
.photos figcaption b { display: block; font-size: 10px; font-weight: 700; color: #1f2a3d; }
.photos figcaption span { color: #8a94a6; }

.conclusion p { margin: 0 0 6px; font-size: 11.5px; line-height: 1.9; }
.tiny-note { font-size: 10px; color: #8a94a6; line-height: 1.7; }
.sign { margin-top: 14px; }
.sign th { background: #f7f9fd; width: 96px; text-align: left; }
.sign td { height: 34px; }

/* ============ 打印 ============ */
@media print {
  @page { size: A4; margin: 12mm 10mm; }
  .no-print { display: none !important; }
  .ir-wrap { background: #fff; padding: 0; }
  .sheet {
    width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; font-size: 11px;
  }
  h2 { page-break-after: avoid; break-after: avoid; }
  h3 { page-break-after: avoid; break-after: avoid; }
  table { page-break-inside: auto; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  thead { display: table-header-group; }
  .photos { gap: 6px; }
  .photos img { aspect-ratio: 4 / 3; }
  .verdict { page-break-inside: avoid; }
}
</style>
