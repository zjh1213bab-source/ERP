<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>应付与付款计划</h2>
        <p class="sub">
          不回答「一共欠多少」（驾驶舱有了），只回答<b>这周要付谁、多少钱、最晚哪天付</b>。
          应付 = 已开票未付 + <b>已收货未开票</b>（货到了票没到，也是确定要付的钱）。
          「待开票」的到期日是按<b>收货日 + 供应商账期</b>算的<b>预计</b>值，不算作逾期。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-action="['payable','export']" class="btn btn-ghost" @click="doExport">导出 CSV</button>
      </div>
    </div>

    <div class="cards c5">
      <div class="stat-card accent">
        <div class="label">应付合计</div>
        <div class="value">{{ money(summary.payable_total) }}<small>元</small></div>
        <div class="foot">票 {{ money(summary.open_amount) }} + 单 {{ money(summary.unbilled_amount) }}</div>
      </div>
      <div class="stat-card" :class="{ danger: summary.overdue }">
        <div class="label">已逾期</div>
        <div class="value" :style="{ color: summary.overdue ? '#d92d45' : '#16305f' }">
          {{ money(summary.overdue) }}<small>元</small>
        </div>
        <div class="foot">{{ summary.overdue_suppliers || 0 }} 家 · 最长 {{ summary.max_overdue_days || 0 }} 天</div>
      </div>
      <div class="stat-card" :class="{ warn: summary.due_7 }">
        <div class="label">7 天内到期</div>
        <div class="value" :style="{ color: summary.due_7 ? '#d97706' : '#16305f' }">
          {{ money(summary.due_7) }}<small>元</small>
        </div>
        <div class="foot">30 天内 {{ money(summary.due_30) }}</div>
      </div>
      <div class="stat-card">
        <div class="label">已收货未开票</div>
        <div class="value">{{ money(summary.unbilled_amount) }}<small>元</small></div>
        <div class="foot" :style="{ color: summary.unbilled_overdue_est ? '#d92d45' : '' }">
          其中预计已过期 {{ money(summary.unbilled_overdue_est) }}
        </div>
      </div>
      <div class="stat-card">
        <div class="label">未设账期的供应商</div>
        <div class="value" :style="{ color: summary.noterm_suppliers ? '#d97706' : '#16305f' }">
          {{ summary.noterm_suppliers || 0 }}<small>家</small>
        </div>
        <div class="foot">共 {{ summary.suppliers || 0 }} 家有欠款</div>
      </div>
    </div>

    <div v-if="summary.unbilled_overdue_est" class="banner warn">
      <b>有 {{ money(summary.unbilled_overdue_est) }} 元的货早就收了，票还没来</b>
      <span>
        按收货日 + 账期算，这批钱早就该付了，但因为还没有发票，在账龄里永远算「未到期」——
        <b>账上看不见，钱却一定要掏</b>。去催供应商开票，或者先把采购单的开票状态核一遍。
      </span>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'board' }" @click="tab = 'board'">供应商台账</button>
      <button :class="{ on: tab === 'plan' }" @click="tab = 'plan'">付款计划</button>
    </div>

    <!-- ================= 供应商台账 ================= -->
    <div v-if="tab === 'board'" class="panel-card">
      <div class="toolbar">
        <input v-model="q" class="input" style="width: 220px" placeholder="供应商名称 / 编号 / 联系人" @input="debouncedLoad" />
        <label class="chk"><input type="checkbox" v-model="onlyOverdue" @change="load" /> 只看逾期</label>
        <span class="spacer"></span>
        <span class="tiny muted">口径日 {{ board.as_of || '—' }}</span>
      </div>

      <div class="table-wrap" style="margin-top: 14px">
        <table class="data">
          <thead>
            <tr>
              <th>供应商</th>
              <th>账期</th>
              <th class="num">应付合计</th>
              <th class="num">逾期</th>
              <th class="num">7 天内</th>
              <th class="num">30 天内</th>
              <th class="num" style="min-width: 96px" title="已提交付款申请、还没付出去的金额">付款流程中</th>
              <th>最近到期</th>
              <th>状态</th>
              <th style="min-width: 130px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.supplier.id || 'name:' + r.supplier.name">
              <td>
                <b>{{ r.supplier.name }}</b>
                <div class="tiny muted">
                  {{ r.supplier.code || '—' }}<template v-if="r.supplier.contact"> · {{ r.supplier.contact }}</template>
                  <span v-if="!r.supplier.id" class="tag gray" style="margin-left: 6px" title="只有名字，供应商档案里没有这条记录">无档案</span>
                </div>
              </td>
              <td class="term-cell">
                <span :class="{ 'warn-text': r.supplier.term_days === null }" :title="r.supplier.payment_terms || ''">
                  {{ shortTerm(r) }}
                </span>
              </td>
              <td class="num">
                <b>{{ money(r.figures.payable_total) }}</b>
                <div class="tiny muted">
                  票 {{ money(r.figures.open_amount) }}<template v-if="r.figures.unbilled_amount"> + 单 {{ money(r.figures.unbilled_amount) }}</template>
                </div>
              </td>
              <td class="num" :style="{ color: r.figures.overdue ? '#d92d45' : '' }">
                <template v-if="r.figures.overdue">{{ money(r.figures.overdue) }}</template>
                <span v-else class="tiny muted">0</span>
                <div v-if="r.figures.max_overdue_days" class="tiny" style="color: #d92d45">最长 {{ r.figures.max_overdue_days }} 天</div>
              </td>
              <td class="num" :style="{ color: r.figures.due_7 ? '#d97706' : '' }">
                {{ r.figures.due_7 ? money(r.figures.due_7) : '0' }}
              </td>
              <td class="num">{{ r.figures.due_30 ? money(r.figures.due_30) : '0' }}</td>
              <td class="num" :style="{ color: r.figures.in_pipeline ? '#7c3aed' : '#8a94a6' }">
                <template v-if="r.figures.in_pipeline">
                  {{ money(r.figures.in_pipeline) }}
                  <div class="tiny muted">{{ r.figures.pipeline_count }} 张单</div>
                </template>
                <template v-else>—</template>
              </td>
              <td class="tiny nowrap">
                {{ r.figures.next_due || '—' }}
                <div v-if="r.figures.unbilled_est_due" class="tiny muted">待票 {{ r.figures.unbilled_est_due }}</div>
              </td>
              <td><span class="tag" :class="riskTag(r.risk)">{{ r.risk_label }}</span></td>
              <td class="ops">
                <!-- 没有档案的（老数据只存了名字）开不了明细也改不了账期，按钮直接不给，免得点了 404 -->
                <button v-if="r.supplier.id" class="link-btn" @click="openDetail(r.supplier.id)">明细</button>
                <button v-if="canWrite && r.supplier.id" class="link-btn" @click="openTerm(r)">改账期</button>
                <span v-if="!r.supplier.id" class="tiny muted">去客户档案里补</span>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="10" class="empty">没有应付</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 付款计划 ================= -->
    <div v-else>
      <div class="panel-card">
        <div class="toolbar">
          <label class="chk">
            看
            <select v-model.number="weeks" class="select" style="width: 100px" @change="loadPlan">
              <option :value="4">4 周</option>
              <option :value="8">8 周</option>
              <option :value="12">12 周</option>
            </select>
          </label>
          <span class="spacer"></span>
          <span class="tiny muted">
            逾期 {{ money(plan.summary ? plan.summary.overdue : 0) }} ·
            本周 {{ money(plan.summary ? plan.summary.due_this_week : 0) }} ·
            待开票 {{ money(plan.summary ? plan.summary.pending_unbilled : 0) }}
          </span>
        </div>
      </div>

      <div
        v-for="b in buckets"
        :key="b.key"
        class="panel-card week-card"
        :class="{ hot: b.key === 'overdue' && b.count, compact: !b.count }"
      >
        <div class="week-head">
          <div>
            <b>{{ b.label }}</b>
            <span class="tiny muted" v-if="b.from">{{ b.from }}<template v-if="b.to"> → {{ b.to }}</template></span>
          </div>
          <div class="week-sum">
            <b :style="{ color: b.key === 'overdue' && b.amount ? '#d92d45' : '#16305f' }">{{ money(b.amount) }}</b>
            <span class="tiny muted">{{ b.count }} 张 · {{ b.suppliers }} 家</span>
          </div>
        </div>
        <div v-if="b.count" class="table-wrap" style="margin-top: 10px">
          <table class="data sm">
            <thead>
              <tr><th>供应商</th><th>发票号</th><th>到期日</th><th class="num">未付金额</th><th v-if="b.key === 'overdue'">逾期天数</th></tr>
            </thead>
            <tbody>
              <tr v-for="v in b.invoices" :key="v.id">
                <td>{{ v.supplier_name }}</td>
                <td class="mono tiny">{{ v.bill_no }}</td>
                <td class="tiny">{{ v.due_date || '—' }}</td>
                <td class="num strong">{{ money(v.open_amount) }}</td>
                <td v-if="b.key === 'overdue'" class="tiny" style="color: #d92d45">{{ v.overdue_days }} 天</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="tiny muted empty-week">这一周没有到期应付</div>
      </div>

      <!-- 待开票 -->
      <div class="panel-card week-card pending-card">
        <div class="week-head">
          <div>
            <b>待开票（预计）</b>
            <span class="tiny muted">货已收、票未到 —— 按收货日 + 账期估算，不算逾期</span>
          </div>
          <div class="week-sum">
            <b>{{ money(plan.summary ? plan.summary.pending_unbilled : 0) }}</b>
            <span class="tiny muted">{{ plan.summary ? plan.summary.pending_count : 0 }} 张采购单</span>
          </div>
        </div>
        <div v-if="pending.length" class="table-wrap" style="margin-top: 10px">
          <table class="data sm">
            <thead>
              <tr><th>供应商</th><th>采购单</th><th>收货日</th><th>预计到期</th><th class="num">金额</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in shownPending" :key="p.id">
                <td>{{ p.supplier_name || '—' }}</td>
                <td class="mono tiny">{{ p.po_no }}</td>
                <td class="tiny">{{ p.received_date || '—' }}</td>
                <td class="tiny">
                  <template v-if="p.est_due">{{ p.est_due }}<i class="tiny muted">（预计）</i></template>
                  <span v-else class="muted">未设账期</span>
                </td>
                <td class="num strong">{{ money(p.amount) }}</td>
                <td>
                  <span v-if="p.est_due && p.est_due < today" class="tag red">预计已过期</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="pending.length > 10" class="more-row">
          <button class="link-btn" @click="showAllPending = !showAllPending">
            {{ showAllPending ? '收起' : `展开全部 ${pending.length} 条` }}
          </button>
        </div>
        <div v-if="!pending.length" class="tiny muted" style="margin-top: 6px">没有已收货未开票的采购单</div>
      </div>
    </div>

    <!-- ================= 供应商明细 ================= -->
    <div v-if="detail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ detail.supplier.name }} · 应付明细</h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="dgrid">
            <div><label>账期</label><b>{{ detail.supplier.term_label }}</b></div>
            <div><label>未付发票</label><b>{{ money(detail.figures.open_amount) }}</b></div>
            <div><label>已收货未开票</label><b>{{ money(detail.figures.unbilled_amount) }}</b></div>
            <div><label>应付合计</label><b>{{ money(detail.figures.payable_total) }}</b></div>
            <div><label>逾期</label>
              <b :style="{ color: detail.figures.overdue ? '#d92d45' : '' }">
                {{ money(detail.figures.overdue) }}<template v-if="detail.figures.max_overdue_days"> · 最长 {{ detail.figures.max_overdue_days }} 天</template>
              </b>
            </div>
            <div><label>联系人</label><b>{{ detail.supplier.contact || '—' }}</b></div>
          </div>

          <h4 class="sec">未付发票（{{ (detail.invoices || []).length }} 张）</h4>
          <div class="table-wrap">
            <table class="data sm">
              <thead><tr><th>发票号</th><th>开票日</th><th>到期日</th><th class="num">金额</th><th class="num">已付</th><th class="num">未付</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="v in detail.invoices" :key="v.id">
                  <td class="mono tiny">{{ v.bill_no }}</td>
                  <td class="tiny">{{ String(v.created_at || '').slice(0, 10) }}</td>
                  <td class="tiny">{{ v.due_date || '—' }}</td>
                  <td class="num">{{ money(v.amount) }}</td>
                  <td class="num">{{ money(v.paid_amount) }}</td>
                  <td class="num strong">{{ money(v.open_amount) }}</td>
                  <td>
                    <span v-if="v.is_overdue" class="tag red">逾期 {{ v.overdue_days }} 天</span>
                    <span v-else class="tag gray">未到期</span>
                  </td>
                </tr>
                <tr v-if="!(detail.invoices || []).length"><td colspan="7" class="empty">没有未付发票</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec">已收货未开票（{{ (detail.unbilled || []).length }} 张采购单）</h4>
          <div class="table-wrap">
            <table class="data sm">
              <thead><tr><th>采购单</th><th>收货日</th><th>预计到货</th><th class="num">金额</th></tr></thead>
              <tbody>
                <tr v-for="p in detail.unbilled" :key="p.id">
                  <td class="mono tiny">{{ p.po_no }}</td>
                  <td class="tiny">{{ p.received_date || '—' }}</td>
                  <td class="tiny">{{ p.expect_date || '—' }}</td>
                  <td class="num strong">{{ money(p.total_amount) }}</td>
                </tr>
                <tr v-if="!(detail.unbilled || []).length"><td colspan="4" class="empty">都已开票</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec">最近付款</h4>
          <div class="table-wrap">
            <table class="data sm">
              <thead><tr><th>付款单</th><th>日期</th><th class="num">金额</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="p in detail.payments" :key="p.id">
                  <td class="mono tiny">{{ p.pay_no }}</td>
                  <td class="tiny">{{ p.pay_date }}</td>
                  <td class="num">{{ money(p.amount) }}</td>
                  <td class="tiny">{{ p.status === 'reversed' ? '已冲销' : '已付款' }}</td>
                </tr>
                <tr v-if="!(detail.payments || []).length"><td colspan="4" class="empty">没有付款记录</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 改账期 ================= -->
    <div v-if="termForm.open" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>账期 · {{ termForm.name }}</h3>
          <button class="x" @click="termForm.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="frow">
            <label>账期说明（自由文本，如「月结 30 天」「现结」）</label>
            <input v-model="termForm.payment_terms" class="input" placeholder="月结30天" @input="reparse" />
          </div>
          <div class="frow">
            <label>账期天数（0 = 现结；填了就以这个为准）</label>
            <input v-model.number="termForm.term_days" class="input" type="number" min="0" max="365" />
            <p class="tiny muted">
              「月结 30 天」→ 30；「现结」→ 0。系统会自动从说明里读，
              读不出来（比如「按季度结」）就手工填。**到期日 = 开票日 + 天数**。
            </p>
          </div>
          <div v-if="termForm.parsed" class="preview">
            解析结果：<b>{{ termForm.parsed }} 天</b>
            <span class="tiny muted">（改完只影响之后的到期日；已开票的建议核对一下要不要重算）</span>
          </div>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="termForm.open = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="saveTerm">保存</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const tab = ref('board');
const board = ref({ summary: {}, rows: [], as_of: '' });
const rows = ref([]);
const q = ref('');
const onlyOverdue = ref(false);
const weeks = ref(8);
const plan = ref({ summary: {}, buckets: [], pending: [] });
const pending = ref([]);
const buckets = ref([]);
// 待开票动辄二三十条（每张采购单一行），默认只给 10 条 —— 这一块的用途是「知道有这笔钱」，
// 不是逐单核对；要核对点「展开全部」
const showAllPending = ref(false);
const detail = ref(null);
const busy = ref(false);

const termForm = reactive({ open: false, id: null, name: '', payment_terms: '', term_days: null, parsed: null });

const summary = computed(() => board.value.summary || {});
const canWrite = computed(() => can('payable.write'));
const today = computed(() => board.value.as_of || localDate());

const shownPending = computed(() => (showAllPending.value ? pending.value : pending.value.slice(0, 10)));

const money = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 表格里只写「30 天 / 现结 / 未设账期」，长的原始文本放 title（悬停可见） */
function shortTerm(r) {
  const d = r.supplier.term_days;
  if (d === null || d === undefined) return '未设账期';
  return Number(d) === 0 ? '现结' : Number(d) + ' 天';
}

function riskTag(r) {
  return { overdue: 'red', unbilled: 'orange', noterm: 'gray', ok: 'green' }[r] || 'gray';
}

let timer = null;
function debouncedLoad() {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
}

async function load() {
  try {
    const d = await api.payableBoard({ q: q.value || undefined, only_overdue: onlyOverdue.value ? 1 : undefined });
    board.value = d;
    rows.value = d.rows || [];
  } catch (e) {
    alert(e.message);
  }
}

async function loadPlan() {
  try {
    const d = await api.payableSchedule({ weeks: weeks.value });
    plan.value = d;
    buckets.value = d.buckets || [];
    pending.value = d.pending || [];
  } catch (e) {
    alert(e.message);
  }
}

async function reload() {
  await load();
  if (tab.value === 'plan') await loadPlan();
  if (detail.value) await openDetail(detail.value.supplier.id);
}

async function openDetail(id) {
  try {
    detail.value = await api.payableDetail(id);
  } catch (e) {
    alert(e.message);
  }
}

// 账期解析在前端也做一份轻量版：只是为了在弹窗里给个即时提示，
// 真正的解析与判定在后端（services/paymentTerms.js）
function parseLocal(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/现结|现金|预付|款到|货到付款/.test(s)) return 0;
  const m = s.match(/月结\s*(\d+)?\s*天?/);
  if (m) return m[1] === undefined ? 30 : Number(m[1]);
  const m3 = s.match(/^(\d{1,3})\s*天?$/);
  if (m3) return Number(m3[1]);
  return null;
}

function reparse() {
  const p = parseLocal(termForm.payment_terms);
  termForm.parsed = p;
  if (p !== null) termForm.term_days = p;
}

function openTerm(r) {
  termForm.open = true;
  termForm.id = r.supplier.id;
  termForm.name = r.supplier.name;
  termForm.payment_terms = r.supplier.payment_terms || '';
  termForm.term_days = r.supplier.term_days;
  termForm.parsed = r.supplier.term_days;
}

async function saveTerm() {
  busy.value = true;
  try {
    await api.payableSetTerm(termForm.id, {
      payment_terms: termForm.payment_terms,
      term_days: termForm.term_days
    });
    termForm.open = false;
    await reload();
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function doExport() {
  downloadFile(api.payableExportPath({ q: q.value || undefined, only_overdue: onlyOverdue.value ? 1 : undefined }));
}

onMounted(async () => {
  await Promise.all([load(), loadPlan()]);
});
</script>

<style scoped>
.cards.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.stat-card .foot { margin-top: 8px; font-size: 12px; color: var(--ink-mute); }
.stat-card.danger { border-color: #f6c9d0; background: #fffafb; }
.stat-card.warn { border-color: #f3ddb5; background: #fffdf7; }
.cards.c5 .stat-card .value { font-size: 23px; }

.tabs { display: flex; gap: 8px; margin-bottom: 14px; }
.tabs button {
  padding: 8px 18px; border-radius: 10px; border: 1px solid #e6ebf3; background: var(--surface);
  font-size: 13px; color: var(--ink-soft); cursor: pointer; font-weight: 600;
}
.tabs button.on { background: var(--brand); border-color: #2b6de5; color: var(--on-brand); }

.banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: 13px; line-height: 1.7; border: 1px solid transparent; }
.banner.warn { background: #fff8ec; border-color: #f3ddb5; color: #8a5a12; }

/* 十列比一屏宽 72px。收窄左右内边距（14→9）省 100px，比缩小字体更不影响可读性 */
.table-wrap table.data thead th,
.table-wrap table.data tbody td {
  padding-left: 9px;
  padding-right: 9px;
}
/* 兜底：万一还是放不下，「操作」列固定在右侧 —— 按钮永远可见，不用猜能不能横向滚 */
.data th:last-child,
.data td:last-child {
  position: sticky;
  right: 0;
  background: var(--surface);
  /* 不要加阴影：表格刚好放下时，这 8px 阴影会盖住隔壁「状态」标签的右半截 */
}
.data tbody tr:hover td:last-child {
  background: #f7faff;
}

.data td.num, .data th.num { white-space: nowrap; }
.data td:first-child { min-width: 172px; }
.nowrap { white-space: nowrap; }
.term-cell { white-space: nowrap; }
.data .tag { white-space: nowrap; }
.ops { white-space: nowrap; }
.ops .link-btn + .link-btn { margin-left: 10px; }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-soft); }
.warn-text { color: #d97706; }
.strong { font-weight: 700; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }

/* 8 周里常常有 4 周是空的，空周还占整块版面会把有内容的挤到下面看不见 */
.week-card { padding: 16px 20px; }
.week-card.compact { padding: 9px 20px; margin-bottom: 8px; }
.week-card.compact .week-head b { font-size: 13px; font-weight: 600; color: var(--ink-soft); }
.week-card.compact .week-sum b { font-size: 14px; color: var(--ink-mute); }
.empty-week { margin-top: 2px; }
.week-card.hot { border-color: #f6c9d0; background: #fffcfc; }
.week-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.week-head b { font-size: 14.5px; color: var(--ink); }
.week-head .tiny { margin-left: 8px; }
.week-sum { text-align: right; }
.week-sum b { font-size: 18px; font-weight: 800; }
.week-sum .tiny { display: block; margin-top: 2px; }
.pending-card { background: var(--surface-2); }
.more-row { margin-top: 8px; text-align: center; }

.dgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 18px; padding: 4px 0 12px; }
.dgrid label { display: block; font-size: 12px; color: var(--ink-mute); margin-bottom: 4px; }
.dgrid b { font-size: 15px; color: var(--ink); }
.sec { margin: 18px 0 8px; font-size: 13.5px; color: var(--ink); }
.frow { margin-bottom: 14px; }
.frow label { display: block; font-size: 12.5px; color: var(--ink-soft); margin-bottom: 5px; }
.frow .tiny { margin: 6px 0 0; }
.preview { padding: 10px 12px; border-radius: 10px; background: #f6f8fc; font-size: 13px; margin-bottom: 8px; }
.form-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }

@media (max-width: 900px) {
  .cards.c5 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .dgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
