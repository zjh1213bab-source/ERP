<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>财务报表与关账</h2>
        <p class="sub">
          凭证<b>由业务单据自动生成</b>（开票 / 收付款 / 成本结转 / 工资 / 费用 / 折旧），不是手工录的；
          每张凭证生成时先校验借贷平衡，不平不入库。报表是分录的投影，不是另一套数。
          关账要过 <b>8 项检查</b>，缺一项关不掉；关账后本期凭证锁死，要改只能反关账并写原因。
        </p>
      </div>
      <div class="head-ops">
        <select class="select" v-model="period" style="width: 170px" @change="reloadAll">
          <option v-for="p in periods" :key="p.period" :value="p.period">
            {{ p.label }}{{ p.status === 'closed' ? ' · 已关账' : '' }}{{ p.is_current ? ' · 当期' : '' }}
          </option>
        </select>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite && status !== 'closed'" class="btn btn-ghost" @click="doGenerate">生成凭证</button>
        <button v-if="canWrite && status !== 'closed'" class="btn btn-ghost" @click="doCarry">损益结转</button>
        <button v-if="canWrite && status !== 'closed'" class="btn btn-primary" @click="doClose">关账</button>
        <button v-if="isAdmin && status === 'closed'" class="btn btn-ghost" @click="doReopen">反关账</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>营业收入</span><strong>{{ fmt(ov.income) }}</strong><small>本期开票确认</small></div>
      <div class="stat"><span>成本费用</span><strong>{{ fmt(ov.expense) }}</strong><small>成本 + 期间费用</small></div>
      <div class="stat" :class="ov.net_profit >= 0 ? 'st-good' : 'st-bad'">
        <span>本期净利润</span>
        <strong>{{ fmt(ov.net_profit) }}</strong>
        <small>{{ netHint }}</small>
      </div>
      <div class="stat"><span>资产总额</span><strong>{{ fmt(ov.asset_total) }}</strong><small>{{ ov.balanced ? '资产负债表平衡' : '表不平，请查凭证' }}</small></div>
      <div class="stat"><span>银行存款</span><strong>{{ fmt(ov.cash) }}</strong><small>期末余额</small></div>
      <div class="stat"><span>凭证 / 期间状态</span><strong>{{ ov.voucher_count }}<small style="display:inline;font-size:12px"> 张</small></strong>
        <small>{{ status === 'closed' ? '已关账（' + $fmtDate(ov.closed_at) + '）' : '未关账' }}</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'report' }" @click="tab = 'report'">财务报表</button>
        <button :class="{ on: tab === 'voucher' }" @click="tab = 'voucher'; loadVouchers()">
          会计凭证<span v-if="ov.unposted" class="tab-dot">{{ ov.unposted }}</span>
        </button>
        <button :class="{ on: tab === 'close' }" @click="tab = 'close'; loadChecks()">
          关账检查<span v-if="checkFail" class="tab-dot">{{ checkFail }}</span>
        </button>
        <button :class="{ on: tab === 'account' }" @click="tab = 'account'; loadAccounts()">科目表</button>
      </div>
      <template v-if="tab === 'report'">
        <div class="mini-tabs">
          <button v-for="r in REPORT_TYPES" :key="r.key" :class="{ on: rpt === r.key }" @click="rpt = r.key; loadReport()">
            {{ r.name }}
          </button>
        </div>
        <button class="btn btn-ghost" @click="exportReport">导出 CSV</button>
      </template>
      <template v-if="tab === 'voucher'">
        <select class="select" v-model="vSource" style="width: 140px" @change="loadVouchers">
          <option value="all">全部来源</option>
          <option v-for="(label, key) in SOURCE_LABEL" :key="key" :value="key">{{ label }}</option>
        </select>
        <button class="btn btn-ghost" @click="loadVouchers">查询</button>
      </template>
    </div>

    <p v-if="status === 'closed'" class="hint-bar">
      {{ periodLabel }} 已关账：本期凭证锁定，不能再生成、作废或改分录。确需调整请「反关账」（需 admin 权限并写原因），改完重新关账。
    </p>

    <!-- ==================== 一、财务报表 ==================== -->
    <div v-if="tab === 'report'">
      <!-- 资产负债表 -->
      <div v-if="rpt === 'balance-sheet'">
        <div v-if="!bs.assets" class="empty-cell">加载中…</div>
        <div v-else class="bs-grid">
          <div class="bs-col">
            <div class="bs-title">资产</div>
            <table class="bs-tbl">
              <tbody>
                <tr v-for="a in bs.assets" :key="a.code">
                  <td class="bs-name">{{ a.name }}<span class="bs-code">{{ a.code }}</span></td>
                  <td class="num" :class="a.amount < 0 ? 'amt-muted' : ''">{{ fmt(a.amount) }}</td>
                </tr>
                <tr class="bs-sum">
                  <td>资产合计</td>
                  <td class="num">{{ fmt(bs.asset_total) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="bs-col">
            <div class="bs-title">负债和所有者权益</div>
            <table class="bs-tbl">
              <tbody>
                <tr><td colspan="2" class="bs-group">负债</td></tr>
                <tr v-for="a in bs.liabilities" :key="a.code">
                  <td class="bs-name">{{ a.name }}<span class="bs-code">{{ a.code }}</span></td>
                  <td class="num">{{ fmt(a.amount) }}</td>
                </tr>
                <tr class="bs-sub">
                  <td>负债合计</td>
                  <td class="num">{{ fmt(bs.liability_total) }}</td>
                </tr>
                <tr><td colspan="2" class="bs-group">所有者权益</td></tr>
                <tr v-for="a in bs.equity" :key="a.code">
                  <td class="bs-name">{{ a.name }}<span class="bs-code">{{ a.code }}</span></td>
                  <td class="num">{{ fmt(a.amount) }}</td>
                </tr>
                <tr v-if="bs.profit_unposted" class="bs-name">
                  <td class="bs-name">本期未结转损益<span class="bs-code">待结转</span></td>
                  <td class="num">{{ fmt(bs.profit_unposted) }}</td>
                </tr>
                <tr class="bs-sub">
                  <td>权益合计</td>
                  <td class="num">{{ fmt(bs.equity_total) }}</td>
                </tr>
                <tr class="bs-sum">
                  <td>负债和所有者权益合计</td>
                  <td class="num">{{ fmt(bs.liability_equity_total) }}</td>
                </tr>
              </tbody>
            </table>
            <div class="bs-check" :class="bs.balanced ? 'ok' : 'bad'">
              {{ bs.balanced ? '✓ 资产 = 负债 + 所有者权益' : '✗ 不平，差额 ' + fmt(bs.diff) }}
            </div>
          </div>
        </div>
      </div>

      <!-- 利润表 -->
      <div v-else-if="rpt === 'income'">
        <div v-if="!is.income" class="empty-cell">加载中…</div>
        <div v-else class="table-wrap">
          <table class="rpt-tbl">
            <thead><tr><th>项目</th><th style="width: 110px">科目</th><th style="width: 160px" class="num">本期金额</th></tr></thead>
            <tbody>
              <tr><td colspan="3" class="bs-group">一、营业收入</td></tr>
              <tr v-for="a in is.income" :key="a.code">
                <td>{{ a.name }}</td><td class="mono tiny">{{ a.code }}</td>
                <td class="num">{{ fmt(a.amount) }}</td>
              </tr>
              <tr class="bs-sub"><td>营业收入合计</td><td></td><td class="num">{{ fmt(is.income_total) }}</td></tr>
              <tr><td colspan="3" class="bs-group">二、成本费用</td></tr>
              <tr v-for="a in is.expense" :key="a.code">
                <td>{{ a.name }}</td><td class="mono tiny">{{ a.code }}</td>
                <td class="num">{{ fmt(a.amount) }}</td>
              </tr>
              <tr class="bs-sub"><td>成本费用合计</td><td></td><td class="num">{{ fmt(is.expense_total) }}</td></tr>
              <tr class="bs-sum">
                <td>三、净利润</td><td></td>
                <td class="num" :class="is.net_profit >= 0 ? 'amt-green' : 'amt-red'">{{ fmt(is.net_profit) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="tiny muted" style="margin-top: 8px">
            口径：排除「损益结转」凭证 —— 结转是借收入贷本年利润，算进去会把收入费用互相抵平，利润表会变成 0。
          </p>
        </div>
      </div>

      <!-- 现金流量表 -->
      <div v-else-if="rpt === 'cash-flow'">
        <div v-if="cf.net_increase === undefined" class="empty-cell">加载中…</div>
        <div v-else class="table-wrap">
          <table class="rpt-tbl">
            <thead><tr><th>项目</th><th style="width: 160px" class="num">金额</th></tr></thead>
            <tbody>
              <tr><td colspan="2" class="bs-group">一、经营活动</td></tr>
              <tr v-for="x in cf.operating_in" :key="'in' + x.name">
                <td class="indent">流入 · {{ x.name }}</td><td class="num">{{ fmt(x.amount) }}</td>
              </tr>
              <tr class="bs-sub"><td>经营活动流入小计</td><td class="num">{{ fmt(cf.operating_in_total) }}</td></tr>
              <tr v-for="x in cf.operating_out" :key="'out' + x.name">
                <td class="indent">流出 · {{ x.name }}</td><td class="num">{{ fmt(x.amount) }}</td>
              </tr>
              <tr class="bs-sub"><td>经营活动流出小计</td><td class="num">{{ fmt(cf.operating_out_total) }}</td></tr>
              <tr class="bs-sub"><td>经营活动产生的现金流量净额</td><td class="num">{{ fmt(cf.operating_net) }}</td></tr>
              <tr><td colspan="2" class="bs-group">二、投资活动</td></tr>
              <tr v-for="x in cf.investing_out" :key="'iv' + x.name">
                <td class="indent">流出 · {{ x.name }}</td><td class="num">{{ fmt(x.amount) }}</td>
              </tr>
              <tr class="bs-sub"><td>投资活动净额</td><td class="num">{{ fmt(cf.investing_net) }}</td></tr>
              <tr v-if="cf.other_in.length || cf.other_out.length"><td colspan="2" class="bs-group">三、其他</td></tr>
              <tr v-for="x in cf.other_in" :key="'oi' + x.name">
                <td class="indent">流入 · {{ x.name }}</td><td class="num">{{ fmt(x.amount) }}</td>
              </tr>
              <tr v-for="x in cf.other_out" :key="'oo' + x.name">
                <td class="indent">流出 · {{ x.name }}</td><td class="num">{{ fmt(x.amount) }}</td>
              </tr>
              <tr class="bs-sum"><td>现金净增加额</td><td class="num">{{ fmt(cf.net_increase) }}</td></tr>
              <tr class="bs-sum"><td>期末现金余额</td><td class="num">{{ fmt(cf.closing_cash) }}</td></tr>
            </tbody>
          </table>
          <p class="tiny muted" style="margin-top: 8px">
            口径：以「银行存款」科目的分录为起点，按对方科目归类（应收/收入 → 经营流入；应付/薪酬/费用/存货 → 经营流出；固定资产 → 投资）。
          </p>
        </div>
      </div>

      <!-- 试算平衡表 -->
      <div v-else-if="rpt === 'trial-balance'">
        <div v-if="!tb.rows" class="empty-cell">加载中…</div>
        <div v-else class="table-wrap">
          <table class="tb-tbl">
            <thead>
              <tr>
                <th style="width: 90px">科目</th><th>名称</th><th style="width: 90px">类型</th>
                <th style="width: 120px" class="num">期初余额</th>
                <th style="width: 120px" class="num">本期借方</th>
                <th style="width: 120px" class="num">本期贷方</th>
                <th style="width: 120px" class="num">期末余额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in tb.rows" :key="r.code">
                <td class="mono">{{ r.code }}</td>
                <td>{{ r.name }}</td>
                <td class="tiny muted">{{ r.type_label }}</td>
                <td class="num">{{ r.begin ? fmt(r.begin) : '—' }}</td>
                <td class="num">{{ r.period_debit ? fmt(r.period_debit) : '—' }}</td>
                <td class="num">{{ r.period_credit ? fmt(r.period_credit) : '—' }}</td>
                <td class="num"><b>{{ r.end ? fmt(r.end) : '—' }}</b></td>
              </tr>
              <tr class="bs-sum">
                <td colspan="3">合计</td>
                <td class="num"></td>
                <td class="num">{{ fmt(tb.sum.debit) }}</td>
                <td class="num">{{ fmt(tb.sum.credit) }}</td>
                <td class="num"></td>
              </tr>
            </tbody>
          </table>
          <div class="bs-check" :class="tb.balanced ? 'ok' : 'bad'">
            {{ tb.balanced ? '✓ 本期借方 = 本期贷方 = ' + fmt(tb.sum.debit) : '✗ 借贷不平，差 ' + fmt(tb.sum.debit - tb.sum.credit) }}
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 二、会计凭证 ==================== -->
    <div v-else-if="tab === 'voucher'">
      <div class="issue-bar">
        <span>共 <b>{{ vouchers.length }}</b> 张；借方合计 {{ fmt(vouchers.reduce((a, v) => a + (v.status === 'posted' ? v.debit_total : 0), 0)) }}</span>
      </div>
      <div v-if="!vouchers.length" class="empty-cell">
        这个期间还没有凭证。点右上角「生成凭证」从业务单据拉取（开票 / 收付款 / 成本结转 / 工资 / 费用 / 折旧）。
      </div>
      <div v-else class="table-wrap">
        <table class="vch-tbl">
          <thead>
            <tr>
              <th style="width: 140px">凭证号</th>
              <th style="width: 96px">日期</th>
              <th style="width: 110px">来源</th>
              <th>摘要</th>
              <th style="width: 110px" class="num">借方</th>
              <th style="width: 110px" class="num">贷方</th>
              <th style="width: 60px" class="num">行数</th>
              <th style="width: 76px">状态</th>
              <th style="width: 120px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in vouchers" :key="v.id" :class="{ 'row-void': v.status === 'void' }">
              <td class="mono">{{ v.voucher_no }}</td>
              <td class="tiny">{{ v.biz_date }}</td>
              <td class="tiny">{{ v.source_label }}</td>
              <td class="wrap">{{ v.summary }}</td>
              <td class="num">{{ fmt(v.debit_total) }}</td>
              <td class="num">{{ fmt(v.credit_total) }}</td>
              <td class="num tiny">{{ v.line_count }}</td>
              <td>
                <span class="pill" :class="v.status === 'posted' ? 'st-posted' : 'st-void'">
                  {{ v.status === 'posted' ? '已过账' : '已作废' }}
                </span>
              </td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openVoucher(v)">看分录</button>
                <button v-if="canWrite && v.status === 'posted' && status !== 'closed'"
                  class="btn btn-ghost btn-sm" @click="doVoid(v)">作废</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、关账检查 ==================== -->
    <div v-else-if="tab === 'close'">
      <div class="close-head">
        <div>
          <b>{{ periodLabel }}</b>
          <span class="pill" :class="status === 'closed' ? 'st-posted' : 'st-open'">
            {{ status === 'closed' ? '已关账' : '未关账' }}
          </span>
          <p class="tiny muted" style="margin: 4px 0 0">
            {{ status === 'closed'
              ? `关账人 ${checksData.closed_by || '—'} · ${$fmt(checksData.closed_at)}`
              : '关账前必须过完下面 8 项；标注「提示」的不拦关账，但要人看过。' }}
          </p>
        </div>
        <div style="display: flex; gap: 8px">
          <button class="btn btn-ghost" @click="loadChecks">重新检查</button>
          <button v-if="canWrite && status !== 'closed'" class="btn btn-primary" @click="doClose">关账</button>
          <button v-if="isAdmin && status === 'closed'" class="btn btn-ghost" @click="doReopen">反关账</button>
        </div>
      </div>

      <div v-if="!checksData.checks" class="empty-cell">正在检查…</div>
      <div v-else class="check-list">
        <div v-for="c in checksData.checks" :key="c.code" class="check-item" :class="c.passed ? 'pass' : (c.severity === 'warn' ? 'warnc' : 'fail')">
          <div class="check-icon">{{ c.passed ? '✓' : (c.severity === 'warn' ? '!' : '✗') }}</div>
          <div class="check-body">
            <div class="check-name">
              {{ c.name }}
              <span v-if="c.severity === 'warn'" class="pill pill-warn">提示项</span>
            </div>
            <div class="tiny muted">{{ c.detail }}</div>
          </div>
        </div>
      </div>

      <div class="block" v-if="status === 'closed'">
        <h4>关账余额快照<small>关账当时的科目余额，事后改数不影响历史报表</small></h4>
        <div v-if="!snapshots.length" class="empty-cell">没有快照（关账时自动生成）。</div>
        <div v-else class="table-wrap">
          <table class="snap-tbl">
            <thead><tr><th style="width: 110px">科目</th><th style="width: 260px">名称</th><th class="num" style="width: 140px">期末借方</th><th class="num" style="width: 140px">期末贷方</th></tr></thead>
            <tbody>
              <tr v-for="s in snapshots" :key="s.account_code">
                <td class="mono">{{ s.account_code }}</td>
                <td>{{ accountName(s.account_code) }}</td>
                <td class="num">{{ s.debit_end ? fmt(s.debit_end) : '—' }}</td>
                <td class="num">{{ s.credit_end ? fmt(s.credit_end) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 四、科目表 ==================== -->
    <div v-else-if="tab === 'account'">
      <p class="hint-bar">
        科目表是报表归集的基础：资产/负债/权益/收入/成本费用五类，方向决定余额在借还是贷。
        <b>备抵科目</b>（如 1602 累计折旧）虽属资产类但余额在贷方，报表里从资产中扣除。
      </p>
      <div class="table-wrap">
        <table class="acc-tbl">
          <thead>
            <tr><th style="width: 100px">科目编码</th><th>名称</th><th style="width: 110px">类别</th><th style="width: 110px">余额方向</th></tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.code">
              <td class="mono">{{ a.code }}</td>
              <td>{{ a.name }}</td>
              <td class="tiny">{{ a.type_label }}</td>
              <td class="tiny">{{ a.direction === 'debit' ? '借方' : '贷方' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 凭证分录弹窗 -->
    <div v-if="vchModal" class="modal-mask" @click.self="vchModal = null">
      <div class="modal wide">
        <div class="vch-head">
          <div>
            <h3 style="margin: 0">{{ vchModal.voucher.voucher_no }}</h3>
            <p class="tiny muted" style="margin: 4px 0 0">
              {{ vchModal.voucher.biz_date }} · {{ vchModal.voucher.source_label }} · {{ vchModal.voucher.summary }}
            </p>
          </div>
          <span class="pill" :class="vchModal.voucher.status === 'posted' ? 'st-posted' : 'st-void'">
            {{ vchModal.voucher.status === 'posted' ? '已过账' : '已作废' }}
          </span>
        </div>
        <table class="line-tbl">
          <thead>
            <tr>
              <th style="width: 40px">#</th><th style="width: 110px">科目</th><th>摘要</th>
              <th style="width: 130px">往来</th>
              <th style="width: 110px" class="num">借方</th><th style="width: 110px" class="num">贷方</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in vchModal.entries" :key="e.id">
              <td class="tiny muted">{{ e.line_no }}</td>
              <td class="tiny"><span class="mono">{{ e.account_code }}</span> {{ e.account_name }}</td>
              <td class="wrap tiny">{{ e.summary || '—' }}</td>
              <td class="tiny muted">{{ e.partner_name || '—' }}</td>
              <td class="num">{{ e.debit ? fmt(e.debit) : '' }}</td>
              <td class="num">{{ e.credit ? fmt(e.credit) : '' }}</td>
            </tr>
            <tr class="bs-sum">
              <td colspan="4">合计</td>
              <td class="num">{{ fmt(vchModal.voucher.debit_total) }}</td>
              <td class="num">{{ fmt(vchModal.voucher.credit_total) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="vchModal = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';
import { auth } from '../store/auth';

const canWrite = computed(() => can('gl.write'));
const isAdmin = computed(() => auth.user?.role === 'admin');

const REPORT_TYPES = [
  { key: 'balance-sheet', name: '资产负债表' },
  { key: 'income', name: '利润表' },
  { key: 'cash-flow', name: '现金流量表' },
  { key: 'trial-balance', name: '试算平衡表' }
];
const SOURCE_LABEL = {
  ar_invoice: '应收开票', ap_invoice: '应付开票', payment: '收付款',
  cost_sold: '成本结转', payroll: '工资计提', expense: '行政费用',
  depreciation: '折旧', profit_carry: '损益结转', manual: '手工凭证'
};

const tab = ref('report');
const rpt = ref('balance-sheet');
const period = ref('');
const periods = ref([]);
const ov = ref({});
const bs = ref({});
const is = ref({});
const cf = ref({});
const tb = ref({});
const vouchers = ref([]);
const vSource = ref('all');
const accounts = ref([]);
const checksData = ref({});
const snapshots = ref([]);
const vchModal = ref(null);

const fmt = (v) => (Number(v) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const pct = (v) => (Number(v) * 100).toFixed(1) + '%';
const status = computed(() => ov.value.status || 'open');
/** 净利率在收入极小时会算出天文数字，那种情况直接说人话 */
const netHint = computed(() => {
  const inc = Number(ov.value.income) || 0;
  const net = Number(ov.value.net_profit) || 0;
  if (!inc) return '本期无收入';
  const rate = net / inc;
  if (Math.abs(rate) > 2) return net < 0 ? '本期成本费用高于收入' : '本期利润主要来自非经营项';
  return '净利率 ' + pct(rate);
});
const periodLabel = computed(() => ov.value.period_label || period.value);
const checkFail = computed(() => (checksData.value.error_fail || 0) + (checksData.value.warn_fail || 0));
const accountName = (code) => accounts.value.find((a) => a.code === code)?.name || code;

async function loadPeriods() {
  periods.value = await api.glPeriods();
  if (!period.value) {
    // 默认落在最近一个「已关账」期间：那才是账做完的一个月；
    // 没有已关账期间才退到当期（新账套第一次进来）。
    const closed = periods.value.find((p) => p.status === 'closed');
    const cur = closed || periods.value.find((p) => p.is_current) || periods.value[0];
    period.value = cur ? cur.period : '';
  }
}
async function loadOverview() {
  ov.value = await api.glOverview(period.value);
}
async function loadReport() {
  try {
    const d = await api.glReport(rpt.value, period.value);
    if (rpt.value === 'balance-sheet') bs.value = d;
    else if (rpt.value === 'income') is.value = d;
    else if (rpt.value === 'cash-flow') cf.value = d;
    else if (rpt.value === 'trial-balance') tb.value = d;
  } catch (e) {
    alert('报表加载失败：' + e.message);
  }
}
async function loadVouchers() {
  vouchers.value = await api.glVouchers({ period: period.value, source_type: vSource.value });
}
async function loadAccounts() {
  if (!accounts.value.length) accounts.value = await api.glAccounts();
}
async function loadChecks() {
  checksData.value = await api.glChecks(period.value);
  try { snapshots.value = []; } catch (e) { /* ignore */ }
  if (checksData.value.status === 'closed') {
    const t = await api.glReport('trial-balance', period.value);
    // 关账快照从试算平衡的期末列取（源数据一致）
    snapshots.value = (t.rows || []).map((r) => ({
      account_code: r.code,
      debit_end: r.direction === 'debit' ? Math.max(r.end, 0) : 0,
      credit_end: r.direction === 'credit' ? Math.max(r.end, 0) : 0
    }));
  }
}

async function reloadAll() {
  await Promise.all([loadOverview(), loadAccounts()]);
  if (tab.value === 'report') await loadReport();
  if (tab.value === 'voucher') await loadVouchers();
  if (tab.value === 'close') await loadChecks();
}

async function doGenerate() {
  if (!confirm(`按业务单据生成 ${period.value} 的凭证？\n已生成过的会跳过（幂等）。`)) return;
  try {
    const r = await api.glGenerate(period.value, {});
    await reloadAll();
    alert(`生成完成：新建 ${r.created} 张，跳过 ${r.skipped} 张${r.failed.length ? '，失败 ' + r.failed.length + ' 张：' + r.failed.join('；') : ''}`);
  } catch (e) { alert('生成失败：' + e.message); }
}

async function doCarry() {
  if (!confirm(`把 ${period.value} 的收入与费用结转到「本年利润」？\n关账前必须做，否则利润会重复累计。`)) return;
  try {
    const r = await api.glCarry(period.value);
    await reloadAll();
    alert(r.skipped ? '本期已结转，无需重复' : `结转完成：本期利润 ${fmt(r.profit)}`);
  } catch (e) { alert('结转失败：' + e.message); }
}

async function doClose() {
  if (!confirm(`关账 ${period.value}？\n关账后本期凭证锁定，不能再生成或作废。`)) return;
  try {
    const r = await api.glClose(period.value);
    await reloadAll();
    if (tab.value === 'close') await loadChecks();
    alert(`已关账：${r.voucher_count} 张凭证，借方合计 ${fmt(r.debit_total)}，本期利润 ${fmt(r.profit)}`);
  } catch (e) { alert('关账失败：\n' + e.message); }
}

async function doReopen() {
  const reason = prompt(`反关账 ${period.value} 的原因（至少 4 个字）：`);
  if (reason === null) return;
  try {
    await api.glReopen(period.value, { reason });
    await reloadAll();
    if (tab.value === 'close') await loadChecks();
    alert('已反关账，本期凭证恢复可改。');
  } catch (e) { alert('反关账失败：' + e.message); }
}

async function openVoucher(v) {
  vchModal.value = await api.glVoucher(v.id);
}

async function doVoid(v) {
  const reason = prompt(`作废 ${v.voucher_no} 的原因（至少 4 个字）：`);
  if (reason === null) return;
  try {
    await api.glVoidVoucher(v.id, { reason });
    await loadVouchers();
    await loadOverview();
  } catch (e) { alert('作废失败：' + e.message); }
}

async function exportReport() {
  try {
    const b = await downloadFile(`/api/gl/reports/${rpt.value}/export?period=${period.value}`);
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gl-${rpt.value}-${period.value}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert('导出失败：' + e.message); }
}

onMounted(async () => {
  await loadPeriods();
  await reloadAll();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.stat.st-good { background: #f2fbf5; border-color: #cfe9d8; }
.stat.st-good strong { color: #16a34a; }
.stat.st-bad { background: #fff5f6; border-color: #f6d4d9; }
.stat.st-bad strong { color: #d92d45; }
.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-muted { color: #94a3b8; }
.muted { color: #9aa4b5; }
.tiny { font-size: 11.5px; }
.wrap { white-space: normal; line-height: 1.55; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.ops { white-space: nowrap; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 12px; }
.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }
.issue-bar { display: flex; justify-content: space-between; font-size: 12.5px; color: #4a566e; margin-bottom: 10px; }
.row-void { background: #fafbfd; color: #9aa4b5; }

.mini-tabs { display: inline-flex; border: 1px solid #e2e8f2; border-radius: 8px; overflow: hidden; }
.mini-tabs button { border: 0; background: #fff; padding: 5px 12px; font-size: 12.5px; color: #5a6680; cursor: pointer; font-family: inherit; }
.mini-tabs button + button { border-left: 1px solid #eef2f8; }
.mini-tabs button.on { background: #eef4ff; color: #2b6de5; font-weight: 600; }

.pill { display: inline-block; font-size: 11px; border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
.st-posted { background: #eefaf2; color: #15803d; }
.st-void { background: #eef2f8; color: #8a94a6; }
.st-open { background: #fff6e8; color: #b46207; }
.pill-warn { background: #fdf3e3; color: #b46207; }

/* 资产负债表 */
.bs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.bs-col { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.bs-title { font-size: 13px; font-weight: 600; color: #16233b; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #eef2f8; }
.bs-tbl { width: 100%; }
.bs-tbl th, .bs-tbl td { padding: 5px 6px; }
.bs-name { color: #33415a; }
.bs-code { font-size: 10.5px; color: #b6bfcf; margin-left: 6px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.bs-group { font-size: 12px; color: #2b6de5; font-weight: 600; padding-top: 8px !important; }
.bs-sub td { border-top: 1px dashed #e9eef7; font-size: 12.5px; color: #4a566e; }
.bs-sum td { border-top: 2px solid #dfe6f0; font-weight: 700; color: #16233b; font-size: 13.5px; padding-top: 8px !important; }
.bs-check { margin-top: 10px; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; }
.bs-check.ok { background: #eefaf2; color: #15803d; }
.bs-check.bad { background: #fdecef; color: #c0243c; }

.rpt-tbl { min-width: 700px; width: 100%; }
.rpt-tbl th, .tb-tbl th, .vch-tbl th, .snap-tbl th, .acc-tbl th, .bs-tbl th { text-align: left; }
.rpt-tbl th.num, .tb-tbl th.num, .vch-tbl th.num, .snap-tbl th.num, .bs-tbl th.num { text-align: right; }
.rpt-tbl .bs-sum td.amt-green, .tb-tbl .bs-sum td.amt-green { color: #16a34a; }
.rpt-tbl .bs-sum td.amt-red, .tb-tbl .bs-sum td.amt-red { color: #d92d45; }
.indent { padding-left: 20px !important; color: #4a566e; }
.tb-tbl { min-width: 940px; width: 100%; }
.vch-tbl { min-width: 1080px; width: 100%; }
.snap-tbl { min-width: 660px; width: auto; }
.acc-tbl { min-width: 520px; width: 100%; }
.line-tbl { min-width: 100%; width: 100%; }

/* 关账检查 */
.close-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 13px 15px; margin-bottom: 12px; }
.close-head b { font-size: 14px; color: #16233b; margin-right: 8px; }
.check-list { display: grid; gap: 8px; }
.check-item { display: flex; align-items: flex-start; gap: 11px; background: #fff; border: 1px solid #e6ebf3; border-left: 3px solid #16a34a; border-radius: 10px; padding: 11px 13px; }
.check-item.fail { border-left-color: #d92d45; background: #fffafa; }
.check-item.warnc { border-left-color: #d97706; background: #fffdf7; }
.check-icon { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-top: 1px; background: #eefaf2; color: #15803d; }
.check-item.fail .check-icon { background: #fdecef; color: #c0243c; }
.check-item.warnc .check-icon { background: #fdf3e3; color: #b46207; }
.check-body { flex: 1; }
.check-name { font-size: 13px; color: #16233b; margin-bottom: 2px; }


.vch-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(20, 30, 48, 0.42); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: #fff; border-radius: 14px; padding: 18px 20px; width: 560px; max-width: 94vw; max-height: 92vh; overflow: auto; box-shadow: 0 18px 50px rgba(16, 30, 55, 0.22); }
.modal.wide { width: 880px; }
.modal-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .bs-grid { grid-template-columns: 1fr; }
  .modal, .modal.wide { width: 94vw; }
}
</style>
