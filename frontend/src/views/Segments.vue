<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>分公司经营对比</h2>
        <p class="sub">
          剔掉内部交易、统一口径之后，<b>哪家真正在赚钱、跟上期比好还是差</b>。
          内部收入只按<b>往来单位</b>认（认不出就不给对外收入，不拿「收入 − 0」冒充）；
          <b>合并数 ≠ 分部之和</b>，差额必须对得上内部交易，对不上就报差异、不抹平；
          <b>未关账的主体不参与排名</b>；环比没有同口径基数就显示「—」，不拿 0 当分母。
        </p>
      </div>
      <div class="head-ops">
        <input v-model="period" type="month" style="width:140px" @change="reloadAll" />
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button class="btn btn-ghost" @click="exportCsv">导出 CSV</button>
        <button v-if="canWrite" class="btn btn-primary" @click="doReport">出报告</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>分部合计收入</span>
        <strong>{{ money(bd.total && bd.total.income) }}</strong>
        <small>含内部交易，各家账上之和</small>
      </div>
      <div class="stat">
        <span>对外收入</span>
        <strong>{{ money(bd.total && bd.total.external_income) }}</strong>
        <small>剔掉内部交易后的真实盘子</small>
      </div>
      <div class="stat">
        <span>已识别内部收入</span>
        <strong>{{ money(bd.total && bd.total.ic_income) }}</strong>
        <small>按往来单位匹配出来的</small>
      </div>
      <div class="stat">
        <span>合并数 / 差额</span>
        <strong>{{ bd.consolidated ? money(bd.consolidated.income_total) : '—' }}</strong>
        <small :class="{ red: bd.ic_mismatch }">
          {{ bd.ic_amount === null ? '本期未生成合并' : '分部 − 合并 = ' + money(bd.ic_amount) + (bd.ic_mismatch ? '（与内部收入对不上）' : '') }}
        </small>
      </div>
      <div class="stat">
        <span>可比净利合计</span>
        <strong>{{ money(bd.total && bd.total.comparable_net) }}</strong>
        <small>账载 {{ money(bd.total && bd.total.net) }} · 调整 {{ money(bd.total && bd.total.adjust_total) }}</small>
      </div>
      <div class="stat" :class="blockIssues ? 'st-bad' : (bd.issue_count ? 'st-warn' : '')">
        <span>口径问题</span>
        <strong>{{ bd.issue_count || 0 }}</strong>
        <small>硬问题 {{ blockIssues }} 条（硬问题不许确认报告）</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'board' }" @click="tab = 'board'">对比总表</button>
        <button :class="{ on: tab === 'adj' }" @click="go('adj')">可比口径调整</button>
        <button :class="{ on: tab === 'report' }" @click="go('report')">报告快照</button>
      </div>
    </div>

    <!-- ==================== 一、对比总表 ==================== -->
    <div v-if="tab === 'board'" class="block">
      <div class="hint-bar">
        排名只看<b>已关账 + 对外收入算得出来</b>的主体；「内部依赖」= 内部收入 ÷ 总收入，超过 50% 说明这家主要靠集团内吃饭。
        「人均」用<b>生效任职</b>数在职，没有人数就显示「—」。金额都是本币，<b>不再乘一次汇率</b>（凭证入账时已折本币）。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>主体</th><th>排名</th><th class="num">收入(含内部)</th><th class="num">内部收入</th>
              <th class="num">对外收入</th><th class="num">占比</th><th class="num">净利</th><th class="num">可比净利</th>
              <th class="num">净利率</th><th class="num">费用率</th><th class="num">内部依赖</th>
              <th class="num">应收+存货</th><th class="num">人数</th><th class="num">人均对外</th>
              <th class="num">收入环比</th><th>期间</th><th>诊断</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in bd.companies" :key="c.company_id" :class="{ 'row-bad': c.net < 0, 'row-warn': c.period_status !== 'closed' }">
              <td>
                <a class="lnk" @click="openDrill(c.company_id)">{{ c.short_name }}</a>
                <div class="tiny muted">{{ c.type_label }} · {{ c.base_currency }}</div>
              </td>
              <td class="tiny">
                <span v-if="c.rank" class="rank">{{ c.rank }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="num tiny">{{ money(c.income) }}</td>
              <td class="num tiny" :class="{ muted: !c.ic_income }">{{ money(c.ic_income) }}</td>
              <td class="num tiny">
                <span v-if="c.external_income === null" class="red" title="内部往来单位没维护，算不出对外收入">算不出</span>
                <span v-else>{{ money(c.external_income) }}</span>
              </td>
              <td class="num tiny">{{ c.income_share === null ? '—' : c.income_share + '%' }}</td>
              <td class="num tiny" :class="{ red: c.net < 0 }">{{ money(c.net) }}</td>
              <td class="num tiny" :class="{ red: c.comparable_net < 0 }">{{ money(c.comparable_net) }}</td>
              <td class="num tiny">{{ pct(c.net_margin) }}</td>
              <td class="num tiny" :class="{ red: avgOpex && c.opex_ratio > avgOpex * 1.3 }">{{ pct(c.opex_ratio) }}</td>
              <td class="num tiny" :class="{ red: c.ic_ratio >= 50 }">{{ c.ic_ratio === null ? '—' : c.ic_ratio + '%' }}</td>
              <td class="num tiny">{{ money(c.working_capital) }}</td>
              <td class="num tiny">{{ c.headcount || '—' }}</td>
              <td class="num tiny">{{ c.per_capita_income === null ? '—' : money(c.per_capita_income) }}</td>
              <td class="num tiny" :class="{ green: c.income_mom > 0, red: c.income_mom < 0 }">
                {{ c.income_mom === null ? '—' : (c.income_mom > 0 ? '+' : '') + c.income_mom + '%' }}
                <div v-if="c.income_mom === null" class="tiny muted">上期无同口径数</div>
              </td>
              <td class="tiny">
                <span class="tag" :class="c.period_status === 'closed' ? 'green' : 'orange'">{{ c.period_status_label }}</span>
              </td>
              <td class="tiny wrap" style="max-width:170px">
                <span v-for="t in c.tags" :key="t.k" class="tag" :class="tagClass(t.k)">{{ t.label }}</span>
                <span v-if="!c.tags.length" class="muted">正常</span>
              </td>
              <td><button class="btn btn-ghost btn-sm" @click="openDrill(c.company_id)">明细</button></td>
            </tr>
            <tr v-if="!bd.companies || !bd.companies.length"><td colspan="18" class="empty-cell">没有主体</td></tr>
          </tbody>
          <tfoot v-if="bd.total">
            <tr class="foot">
              <td>合计</td><td></td>
              <td class="num">{{ money(bd.total.income) }}</td>
              <td class="num">{{ money(bd.total.ic_income) }}</td>
              <td class="num">{{ money(bd.total.external_income) }}</td>
              <td class="num">100%</td>
              <td class="num" :class="{ red: bd.total.net < 0 }">{{ money(bd.total.net) }}</td>
              <td class="num">{{ money(bd.total.comparable_net) }}</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td class="num">{{ money(bd.total.working_capital) }}</td>
              <td class="num">{{ bd.total.headcount }}</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <h3 class="sec-title">口径问题 <span class="muted tiny">共 {{ (bd.issues || []).length }} 条</span></h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>级别</th><th>主体</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="(i, idx) in bd.issues || []" :key="idx" :class="{ 'row-bad': i.level === 'block' }">
              <td><span class="tag" :class="i.level === 'block' ? 'red' : (i.level === 'warn' ? 'orange' : 'gray')">{{ i.level === 'block' ? '硬' : (i.level === 'warn' ? '警告' : '提示') }}</span></td>
              <td class="tiny">{{ i.company }}</td>
              <td class="tiny wrap">{{ i.detail }}</td>
            </tr>
            <tr v-if="!(bd.issues || []).length"><td colspan="3" class="empty-cell">没有口径问题</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 二、可比口径调整 ==================== -->
    <div v-if="tab === 'adj'" class="block">
      <div class="hint-bar">
        调整<b>不改账</b>：账载净利永远保留，调整只影响「可比净利」一列。
        <b>正数 = 可比利润更高</b>（例如剔除一笔一次性损失），<b>负数 = 更低</b>（例如补提总部费用分摊）。
        必须写清是什么，否则下个月没人记得为什么调过。
      </div>
      <div class="toolbar" style="margin-bottom: 10px">
        <div class="spacer"></div>
        <span class="muted tiny">{{ period }} 共 {{ adjustments.length }} 条，合计 {{ money(adjTotal) }}</span>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openAdj">＋ 登记调整</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>主体</th><th>类型</th><th class="num">金额</th><th>说明</th><th>登记</th><th v-if="canWrite"></th></tr></thead>
          <tbody>
            <tr v-for="a in adjustments" :key="a.id">
              <td class="tiny">{{ a.short_name || a.name }}</td>
              <td><span class="tag gray">{{ a.kind_label }}</span></td>
              <td class="num tiny" :class="{ red: a.amount < 0 }">{{ money(a.amount) }}</td>
              <td class="tiny wrap">{{ a.note }}</td>
              <td class="tiny muted">{{ a.created_by }} · {{ String(a.created_at).slice(0, 10) }}</td>
              <td v-if="canWrite"><button class="btn btn-ghost btn-sm" @click="delAdj(a)">删除</button></td>
            </tr>
            <tr v-if="!adjustments.length"><td :colspan="canWrite ? 6 : 5" class="empty-cell">本期没有调整，账载净利 = 可比净利</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、报告快照 ==================== -->
    <div v-if="tab === 'report'" class="block">
      <div class="hint-bar">
        出报告 = 把当期这张对比表<b>冻结成快照</b>；确认后数字不再变，后面再改账也不会悄悄改历史报告。
        要改就重新出一版。<b>有硬口径问题时不许确认</b>（对外收入都算不出来的表不能拿出去）。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>报告号</th><th>期间</th><th class="num">主体数</th><th class="num">分部收入</th><th class="num">对外收入</th>
              <th class="num">合并数</th><th class="num">差额</th><th class="num">问题</th><th>状态</th><th>生成 / 确认</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in reports" :key="r.id" :class="{ 'row-warn': r.status === 'confirmed' }">
              <td class="mono tiny">{{ r.report_no }}</td>
              <td class="tiny">{{ r.period }}</td>
              <td class="num tiny">{{ r.company_count }}</td>
              <td class="num tiny">{{ money(r.total_income) }}</td>
              <td class="num tiny">{{ money(r.total_external_income) }}</td>
              <td class="num tiny">{{ r.consolidated_income === null ? '—' : money(r.consolidated_income) }}</td>
              <td class="num tiny">{{ money(r.ic_amount) }}</td>
              <td class="num tiny" :class="{ red: r.issue_count }">{{ r.issue_count }}</td>
              <td><span class="tag" :class="r.status === 'confirmed' ? 'green' : 'orange'">{{ r.status === 'confirmed' ? '已确认·冻结' : '草稿' }}</span></td>
              <td class="tiny muted">
                {{ $fmt(r.created_at) }} {{ r.created_by }}
                <div v-if="r.confirmed_at">{{ $fmt(r.confirmed_at) }} {{ r.confirmed_by }}</div>
              </td>
              <td class="ops">
                <button v-if="r.status === 'draft' && canWrite" class="btn btn-primary btn-sm" @click="doConfirm(r)">确认</button>
                <button class="btn btn-ghost btn-sm" @click="viewReport(r.id)">查看</button>
              </td>
            </tr>
            <tr v-if="!reports.length"><td colspan="11" class="empty-cell">还没有报告，点右上角「出报告」</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 下钻 ==================== -->
    <div v-if="drill.open" class="modal-mask" @click.self="drill.open = false">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>{{ drillData.company && drillData.company.short_name }} · {{ period }}</h3>
          <button class="x" @click="drill.open = false">×</button>
        </div>
        <div class="modal-body">
          <div v-if="drillData.snapshot" class="dgrid">
            <div><span>收入</span><b>{{ money(drillData.snapshot.income) }}</b></div>
            <div><span>其中内部</span><b>{{ money(drillData.snapshot.ic_income) }}</b></div>
            <div><span>对外收入</span><b>{{ drillData.snapshot.external_income === null ? '算不出' : money(drillData.snapshot.external_income) }}</b></div>
            <div><span>成本</span><b>{{ money(drillData.snapshot.cost) }}</b></div>
            <div><span>期间费用</span><b>{{ money(drillData.snapshot.opex) }}</b></div>
            <div><span>净利</span><b>{{ money(drillData.snapshot.net) }}</b></div>
            <div><span>可比净利</span><b>{{ money(drillData.snapshot.comparable_net) }}</b></div>
            <div><span>应收</span><b>{{ money(drillData.snapshot.ar) }}</b></div>
            <div><span>存货</span><b>{{ money(drillData.snapshot.inventory) }}</b></div>
            <div><span>应付</span><b>{{ money(drillData.snapshot.ap) }}</b></div>
            <div><span>现金</span><b>{{ money(drillData.snapshot.cash) }}</b></div>
            <div><span>人数</span><b>{{ drillData.snapshot.headcount || '—' }}</b></div>
          </div>

          <div v-for="(i, idx) in drillData.issues || []" :key="'i' + idx" class="tiny" style="margin-top:6px">
            <span class="tag" :class="i.level === 'block' ? 'red' : (i.level === 'warn' ? 'orange' : 'gray')">{{ i.level === 'block' ? '硬' : (i.level === 'warn' ? '警告' : '提示') }}</span>
            {{ i.detail }}
          </div>

          <h4 class="sec-title">内部交易明细</h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>对方（单据上的名称）</th><th class="num">内部收入</th></tr></thead>
              <tbody>
                <tr v-for="d in (drillData.snapshot && drillData.snapshot.ic_detail) || []" :key="d.partner">
                  <td class="tiny">{{ d.partner }}</td>
                  <td class="num tiny">{{ money(d.amount) }}</td>
                </tr>
                <tr v-if="!drillData.snapshot || !drillData.snapshot.ic_detail.length"><td colspan="2" class="empty-cell">本期没有识别到内部收入</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec-title">待核对的往来名称 <span class="muted tiny">收入里有这些往来单位，但不在内部往来单位名单里</span></h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>往来名称</th><th class="num">收入</th></tr></thead>
              <tbody>
                <tr v-for="u in drillData.unmatched_partners || []" :key="u.name">
                  <td class="tiny">{{ u.name }}</td>
                  <td class="num tiny">{{ money(u.amount) }}</td>
                </tr>
                <tr v-if="!drillData.unmatched_partners || !drillData.unmatched_partners.length"><td colspan="2" class="empty-cell">没有待核对名称</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec-title">损益结构</h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>科目</th><th>名称</th><th class="num">金额</th></tr></thead>
              <tbody>
                <tr v-for="l in drillData.income_lines || []" :key="'in' + l.code">
                  <td class="mono tiny">{{ l.code }}</td><td class="tiny">收入 · {{ l.name }}</td>
                  <td class="num tiny">{{ money(l.amount) }}</td>
                </tr>
                <tr v-for="l in drillData.expense_lines || []" :key="'ex' + l.code">
                  <td class="mono tiny">{{ l.code }}</td><td class="tiny">费用 · {{ l.name }}</td>
                  <td class="num tiny">{{ money(l.amount) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="drill.open = false">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 调整弹窗 ==================== -->
    <div v-if="adj.open" class="modal-mask" @click.self="adj.open = false">
      <div class="modal">
        <div class="modal-head">
          <h3>登记可比口径调整</h3>
          <button class="x" @click="adj.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fgrid">
            <label><span>主体</span>
              <select v-model.number="adj.company_id">
                <option v-for="c in bd.companies || []" :key="c.company_id" :value="c.company_id">{{ c.short_name }}</option>
              </select>
            </label>
            <label><span>期间</span><input v-model="adj.period" type="month" /></label>
            <label><span>类型</span>
              <select v-model="adj.kind">
                <option v-for="k in (dict.adj_kind || [])" :key="k.k" :value="k.k">{{ k.v }}</option>
              </select>
            </label>
            <label><span>金额（正=可比利润更高）</span><input v-model.number="adj.amount" type="number" step="1000" /></label>
            <label class="full"><span>说明（必填）</span>
              <textarea v-model="adj.note" rows="2" placeholder="例如：剔除 9 月一次性清尾货折价损失 5 万"></textarea>
            </label>
          </div>
          <div class="tiny muted" style="margin-top:8px">调整不改账，只影响「可比净利」这一列。</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="adj.open = false">取消</button>
          <button class="btn btn-primary" @click="saveAdj">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 报告快照查看 ==================== -->
    <div v-if="snap.open" class="modal-mask" @click.self="snap.open = false">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>{{ snap.data && snap.data.report_no }} · {{ snap.data && snap.data.period }}（{{ snap.data && snap.data.status === 'confirmed' ? '已确认·冻结' : '草稿' }}）</h3>
          <button class="x" @click="snap.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="hint-bar">{{ snap.data && snap.data.note }}</div>
          <div class="table-wrap" style="margin-top:10px">
            <table class="data">
              <thead><tr><th>主体</th><th class="num">收入</th><th class="num">内部</th><th class="num">对外</th><th class="num">净利</th><th class="num">可比</th><th>期间</th></tr></thead>
              <tbody>
                <tr v-for="c in (snap.data && snap.data.payload && snap.data.payload.companies) || []" :key="c.company_id">
                  <td class="tiny">{{ c.short_name }}</td>
                  <td class="num tiny">{{ money(c.income) }}</td>
                  <td class="num tiny">{{ money(c.ic_income) }}</td>
                  <td class="num tiny">{{ c.external_income === null ? '算不出' : money(c.external_income) }}</td>
                  <td class="num tiny">{{ money(c.net) }}</td>
                  <td class="num tiny">{{ money(c.comparable_net) }}</td>
                  <td class="tiny">{{ c.period_status_label }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="snap.open = false">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const tab = ref('board');
const dict = ref({});
const period = ref('');
const bd = ref({ companies: [], total: {}, issues: [] });
const adjustments = ref([]);
const reports = ref([]);
const drill = reactive({ open: false });
const drillData = ref({});
const snap = reactive({ open: false, data: null });
const adj = reactive({ open: false, company_id: null, period: '', kind: 'one_off', amount: 0, note: '' });

const canWrite = computed(() => can('segment.write'));
const blockIssues = computed(() => (bd.value.issues || []).filter((i) => i.level === 'block').length);
const avgOpex = computed(() => bd.value.avg_opex_ratio);
const adjTotal = computed(() => adjustments.value.reduce((a, x) => a + Number(x.amount || 0), 0));

const money = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
};
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const tagClass = (k) => ({
  unclosed: 'orange', ic_unmapped: 'red', ic_unconfigured: 'gray', currency_review: 'gray',
  ic_heavy: 'purple', loss: 'red', opex_high: 'orange', capital_heavy: 'orange', no_headcount: 'gray'
}[k] || 'gray');

async function reloadAll() {
  try {
    dict.value = await api.segmentDict();
    if (!period.value) period.value = dict.value.current_period;
  } catch (e) { /* ignore */ }
  await loadBoard();
  if (tab.value === 'adj') await loadAdjustments();
  if (tab.value === 'report') await loadReports();
}

async function loadBoard() {
  try {
    bd.value = await api.segmentBoard({ period: period.value });
  } catch (e) {
    bd.value = { companies: [], total: {}, issues: [] };
  }
}

async function loadAdjustments() {
  try { adjustments.value = await api.segmentAdjustments({ period: period.value }); } catch (e) { adjustments.value = []; }
}

async function loadReports() {
  try { reports.value = await api.segmentReports({ period: period.value }); } catch (e) { reports.value = []; }
}

function go(t) {
  tab.value = t;
  if (t === 'adj') loadAdjustments();
  if (t === 'report') loadReports();
}

async function openDrill(id) {
  drill.open = true;
  drillData.value = {};
  try { drillData.value = await api.segmentCompany(id, { period: period.value }); } catch (e) { alert(e.message); }
}

function openAdj() {
  adj.open = true;
  adj.company_id = (bd.value.companies || [])[0] ? bd.value.companies[0].company_id : null;
  adj.period = period.value;
  adj.kind = 'one_off';
  adj.amount = 0;
  adj.note = '';
}

async function saveAdj() {
  try {
    await api.saveSegmentAdjustment({ ...adj, period: adj.period || period.value });
    adj.open = false;
    await loadAdjustments();
    await loadBoard();
  } catch (e) { alert(e.message); }
}

async function delAdj(a) {
  if (!confirm(`删除这条调整？${a.note}`)) return;
  try {
    await api.deleteSegmentAdjustment(a.id);
    await loadAdjustments();
    await loadBoard();
  } catch (e) { alert(e.message); }
}

async function doReport() {
  const note = prompt(`按 ${period.value} 出一版对比报告？可写一句说明`, '本期分部经营对比');
  if (note === null) return;
  try {
    const r = await api.createSegmentReport({ period: period.value, note });
    await loadReports();
    tab.value = 'report';
    alert(`已生成 ${r.report_no}（草稿），确认后冻结`);
  } catch (e) { alert(e.message); }
}

async function doConfirm(r) {
  if (!confirm(`确认 ${r.report_no}？确认后数字冻结，后面改账不会影响这一版。`)) return;
  try {
    await api.confirmSegmentReport(r.id, { note: '经营会确认' });
    await loadReports();
    alert('已确认并冻结');
  } catch (e) { alert(e.message); }
}

async function viewReport(id) {
  snap.open = true;
  snap.data = null;
  try { snap.data = await api.segmentReport(id); } catch (e) { alert(e.message); }
}

async function exportCsv() {
  try {
    const blob = await downloadFile(`/api/segments/export?period=${period.value}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `分部经营对比_${period.value}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}

onMounted(reloadAll);
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 20px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.15; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
table.data tfoot .foot td { background: #f7f9fd; font-weight: 700; border-top: 2px solid #e6ebf3; }

.tag { white-space: nowrap; margin: 0 4px 3px 0; }
table.data td.wrap .tag { display: inline-block; }
.rank { display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%; background: #eaf1ff; color: #2563eb; font-weight: 700; font-size: 11px; }
.sec-title { font-size: 14px; color: #16305f; margin: 20px 0 10px; }
.green { color: #16a34a; }
.ops { white-space: nowrap; }

.dgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dgrid div { background: #f7f9fd; border: 1px solid #eef2f7; border-radius: 8px; padding: 8px 10px; }
.dgrid span { display: block; font-size: 11.5px; color: #8a94a6; }
.dgrid b { display: block; font-size: 15px; color: #16305f; margin-top: 3px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
