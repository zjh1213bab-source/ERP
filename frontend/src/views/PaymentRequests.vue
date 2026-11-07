<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>付款申请</h2>
        <p class="sub">
          付款不能直接登记 —— 先<b>提单</b>、再<b>审批</b>、最后由出纳<b>执行付款</b>。
          申请金额由勾选的发票决定，不许手填；<b>同一个人不能既申请又批准</b>；<b>审批通过 ≠ 已付</b>，钱还得出纳按一下。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-action="['payment-requests','export']" class="btn btn-ghost" @click="doExport">导出 CSV</button>
        <button v-action="['payment-requests','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">新建付款申请</button>
      </div>
    </div>

    <div class="cards c5">
      <div class="stat-card">
        <div class="label">草稿</div>
        <div class="value">{{ stats.draft.count }}<small>张</small></div>
        <div class="foot">{{ money(stats.draft.amount) }} 元 · 已占额度</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.submitted.count }">
        <div class="label">审批中</div>
        <div class="value" :style="{ color: stats.submitted.count ? '#d97706' : '#16305f' }">
          {{ stats.submitted.count }}<small>张</small>
        </div>
        <div class="foot">{{ money(stats.submitted.amount) }} 元</div>
      </div>
      <div class="stat-card accent">
        <div class="label">待付款（已批）</div>
        <div class="value">{{ stats.approved.count }}<small>张</small></div>
        <div class="foot">{{ money(stats.approved.amount) }} 元 · 钱还没出门</div>
      </div>
      <div class="stat-card">
        <div class="label">已申请未付合计</div>
        <div class="value">{{ money(stats.pipeline_amount) }}<small>元</small></div>
        <div class="foot">审批中 + 已批准，资金要预留</div>
      </div>
      <div class="stat-card" :class="{ danger: stats.overdue_pending_count }">
        <div class="label">挂着逾期的申请</div>
        <div class="value" :style="{ color: stats.overdue_pending_count ? '#d92d45' : '#16305f' }">
          {{ stats.overdue_pending_count }}<small>条</small>
        </div>
        <div class="foot">这些发票早就到期了，还在等审批</div>
      </div>
    </div>

    <div class="panel-card">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === '' }" @click="setTab('')">全部</button>
          <button :class="{ on: tab === 'draft' }" @click="setTab('draft')">草稿</button>
          <button :class="{ on: tab === 'submitted' }" @click="setTab('submitted')">审批中</button>
          <button :class="{ on: tab === 'approved' }" @click="setTab('approved')">待付款</button>
          <button :class="{ on: tab === 'paid' }" @click="setTab('paid')">已付款</button>
        </div>
        <input v-model="q" class="input" style="width: 200px" placeholder="单号 / 供应商 / 理由" @keyup.enter="load" />
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="min-width: 150px">申请单号</th>
              <th style="min-width: 170px">供应商</th>
              <th class="num" style="min-width: 110px">金额</th>
              <th style="width: 96px">状态</th>
              <th style="min-width: 108px">计划付款</th>
              <th class="num" style="width: 62px">明细</th>
              <th style="min-width: 150px">审批进度</th>
              <th style="min-width: 190px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td>
                <button class="link-btn mono" @click="openDetail(r.id)">{{ r.req_no }}</button>
                <div class="tiny muted">{{ r.created_by }}</div>
              </td>
              <td class="sup-cell">
                {{ r.supplier_name || '—' }}
                <div class="tiny muted">{{ r.reason || '（无申请理由）' }}</div>
              </td>
              <td class="num strong">{{ money(r.amount) }}</td>
              <td><span class="tag" :class="statusClass(r.status)">{{ r.status_label }}</span></td>
              <td class="tiny nowrap">
                {{ r.plan_pay_date || '—' }}
                <div v-if="r.pay_date" class="tiny muted">实付 {{ r.pay_date }}</div>
              </td>
              <td class="num">{{ r.item_count }}</td>
              <td class="tiny">
                <span v-if="r.status === 'paid'" class="muted">已付款 {{ (r.paid_at || '').slice(0, 10) }}</span>
                <span v-else-if="r.status === 'approved'" class="tag green">已批准</span>
                <span v-else-if="r.status === 'submitted'" class="tag orange">审批中</span>
                <span v-else-if="r.status === 'cancelled'" class="muted">—</span>
                <span v-else class="muted">未提交</span>
              </td>
              <td class="ops">
                <button class="link-btn" @click="openDetail(r.id)">明细</button>
                <button v-if="canWrite && r.status === 'draft'" class="link-btn" @click="doSubmit(r)">提交</button>
                <button v-action="['payment-requests','delete']" v-if="canWrite && r.status === 'draft'" class="link-btn danger" @click="doDelete(r)">删除</button>
                <button v-if="canPay && r.status === 'approved'" class="link-btn strong" @click="openPay(r)">执行付款</button>
                <button
                  v-if="r.status !== 'paid' && r.status !== 'cancelled'"
                  class="link-btn"
                  @click="doCancel(r)"
                >
                  取消
                </button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="8" class="empty">没有符合条件的申请单</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 新建 ================= -->
    <div v-if="createOpen" class="modal-mask">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>新建付款申请</h3>
          <button class="x" @click="createOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="banner info">
            <b>金额由勾选的发票决定，不能手填总数</b>
            <span>
              允许填一个总数，就会出现「钱付了、账上应付还挂着」。所以先挑发票、再定每张付多少，
              合计自动算。同一张票被别的申请单占用时，可申请额会显示为剩余部分。
            </span>
          </div>

          <div class="frow">
            <label class="fld">
              <span>供应商 <i>*</i></span>
              <select v-model="form.supplier_id" class="select" @change="loadCandidates">
                <option value="">请选择（只列有未付应付的供应商）</option>
                <option v-for="s in meta.suppliers" :key="s.id" :value="s.id">
                  {{ s.name }}{{ s.payment_terms ? '（' + s.payment_terms + '）' : '' }}
                </option>
              </select>
            </label>
            <label class="fld">
              <span>计划付款日</span>
              <input v-model="form.plan_pay_date" type="date" class="input" />
            </label>
            <label class="fld">
              <span>付款方式</span>
              <select v-model="form.method" class="select">
                <option v-for="m in meta.methods" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="fld">
              <span>出账账户（可付款时再选）</span>
              <select v-model="form.bank_account_id" class="select">
                <option value="">付款时再选</option>
                <option v-for="a in meta.accounts" :key="a.id" :value="a.id">
                  {{ a.bank_name }} {{ a.account_masked }}
                </option>
              </select>
            </label>
          </div>
          <label class="fld block">
            <span>申请理由（给审批人看，写清为什么现在付） <i>*</i></span>
            <input v-model="form.reason" class="input" placeholder="例如：合同约定月结30天，本批货款已到账期，核对无误" />
          </label>

          <div v-if="form.supplier_id" class="cand-head">
            <b>可申请的发票（{{ cand.rows.length }} 张）</b>
            <span class="tiny muted">
              未付合计 {{ money(cand.summary.open_total) }} ·
              已被其他申请占用 {{ money(cand.summary.committed_total) }} ·
              可申请 {{ money(cand.summary.available_total) }}
            </span>
            <span class="spacer"></span>
            <button class="link-btn" @click="pickAll">全选可申请</button>
            <button class="link-btn" @click="picked = {}">清空</button>
          </div>

          <div v-if="form.supplier_id" class="table-wrap" style="max-height: 320px; overflow-y: auto">
            <table class="data sm">
              <thead>
                <tr>
                  <th style="width: 38px"></th>
                  <th style="min-width: 150px">发票号</th>
                  <th style="min-width: 260px">生产实际 / 结算依据</th>
                  <th style="min-width: 88px">到期日</th>
                  <th class="num" style="min-width: 92px">未付</th>
                  <th class="num" style="min-width: 92px">已占用</th>
                  <th class="num" style="min-width: 92px">可申请</th>
                  <th class="num" style="min-width: 120px">本次申请</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in cand.rows"
                  :key="c.id"
                  :class="{ 'row-off': c.fully_committed, 'row-sel': picked[c.id] !== undefined }"
                >
                  <td>
                    <input
                      type="checkbox"
                      :disabled="c.fully_committed"
                      :checked="picked[c.id] !== undefined"
                      @change="togglePick(c)"
                    />
                  </td>
                  <td class="mono tiny">
                    {{ c.bill_no }}
                    <span v-if="c.overdue_days" class="tag red" style="margin-left: 4px">逾期 {{ c.overdue_days }} 天</span>
                  </td>
                  <td class="tiny">
                    <template v-if="c.production_basis?.purchase">
                      <div>采购单：{{ c.production_basis.purchase.po_no }} · {{ purchaseStatusLabel(c.production_basis.purchase.status) }}</div>
                      <div>订单：{{ c.production_basis.order?.order_no || '备货采购' }}</div>
                      <div v-for="dispatch in c.production_basis.dispatches" :key="dispatch.id">{{ dispatch.type === 'outsource' ? '外发' : '本厂' }} · {{ dispatch.factory_name || '未指定工厂' }} · {{ dispatch.qty }} 件</div>
                      <div v-if="c.production_basis.order && !c.production_basis.dispatches.length">尚无有效生产分单</div>
                      <div v-for="receipt in c.production_basis.receipts" :key="receipt.id">{{ receipt.grn_no }} · {{ $fmtDate(receipt.receive_date) }} · {{ receiptStatusLabel(receipt.status) }}</div>
                      <div v-if="!c.production_basis.receipts.length">暂无收货验收记录，请核对来源凭据</div>
                      <div>供应商账期：{{ c.production_basis.term_days != null ? c.production_basis.term_days+'天' : c.production_basis.payment_terms || '未配置' }}</div>
                    </template>
                    <span v-else>{{ c.production_basis?.source === 'missing_purchase' ? '采购来源已缺失，需核对原单' : '非采购单来源，按应付发票及对账凭据核实' }}</span>
                  </td>
                  <td class="tiny nowrap">{{ c.due_date || '—' }}</td>
                  <td class="num">{{ money(c.open_amount) }}</td>
                  <td class="num" :style="{ color: c.committed ? '#d97706' : '#8a94a6' }">
                    {{ c.committed ? money(c.committed) : '—' }}
                    <div v-if="c.committed_by.length" class="tiny muted">
                      {{ c.committed_by.map((x) => x.req_no).join('、') }}
                    </div>
                  </td>
                  <td class="num">{{ money(c.available) }}</td>
                  <td class="num">
                    <input
                      v-if="picked[c.id] !== undefined"
                      v-model.number="picked[c.id]"
                      type="number"
                      class="input sm"
                      :max="c.available"
                      min="0"
                      step="0.01"
                    />
                    <span v-else class="muted tiny">未选</span>
                  </td>
                </tr>
                <tr v-if="!cand.rows.length"><td colspan="8" class="empty">该供应商没有可申请的应付发票</td></tr>
              </tbody>
            </table>
          </div>

          <div class="sum-bar">
            <span>已选 <b>{{ pickCount }}</b> 张</span>
            <span class="spacer"></span>
            <span>合计金额 <b class="big">¥{{ money(pickTotal) }}</b></span>
          </div>

          <div class="form-foot">
            <button class="btn btn-ghost" @click="createOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="busy || !pickCount" @click="doCreate(false)">存为草稿</button>
            <button class="btn btn-primary" :disabled="busy || !pickCount" @click="doCreate(true)">保存并提交审批</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 详情 ================= -->
    <div v-if="cur" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>
            {{ cur.req_no }}
            <span class="tag" :class="statusClass(cur.status)" style="margin-left: 8px">{{ cur.status_label }}</span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <div class="dgrid">
            <div><span>供应商</span><b>{{ cur.supplier_name || '—' }}</b></div>
            <div><span>申请金额</span><b>¥{{ money(cur.amount) }}</b></div>
            <div><span>计划付款日</span><b>{{ cur.plan_pay_date || '—' }}</b></div>
            <div><span>付款方式</span><b>{{ cur.method || '—' }}</b></div>
            <div><span>申请人</span><b>{{ cur.created_by }}</b></div>
            <div><span>提交时间</span><b class="tiny">{{ cur.submitted_at ? $fmt(cur.submitted_at) : '未提交' }}</b></div>
            <div><span>审批结果</span><b>{{ cur.decided_at ? $fmt(cur.decided_at) : '—' }}</b></div>
            <div><span>出账账户</span><b class="tiny">{{ cur.bank_account ? cur.bank_account.bank_name + ' ' + cur.bank_account.account_masked : '未指定' }}</b></div>
          </div>

          <div v-if="cur.reason" class="reason-box">
            <span class="tiny muted">申请理由</span>
            <div>{{ cur.reason }}</div>
          </div>

          <!-- 审批进度 -->
          <div v-if="cur.approval" class="sec">
            <h4>审批进度</h4>
            <div class="steps">
              <div
                v-for="t in cur.approval.tasks"
                :key="t.id"
                class="step"
                :class="{
                  done: t.status === 'approved',
                  now: t.status === 'pending' && t.step_no === cur.approval.current_step,
                  rej: t.status === 'rejected'
                }"
              >
                <div class="sn">{{ t.step_no }}</div>
                <div class="st">
                  <b>{{ t.step_name }}</b>
                  <span class="tiny">
                    <template v-if="t.status === 'approved'">{{ t.approver }} 已批准 · {{ $fmt(t.acted_at) }}</template>
                    <template v-else-if="t.status === 'rejected'">{{ t.approver }} 已驳回 · {{ t.remark || '' }}</template>
                    <template v-else>等待 {{ t.role }} 处理</template>
                  </span>
                  <span v-if="t.remark && t.status === 'approved'" class="tiny muted">意见：{{ t.remark }}</span>
                </div>
              </div>
            </div>
            <p v-if="cur.approval.status === 'pending'" class="tiny muted" style="margin-top: 8px">
              提示：审批要在「审批中心 → 待我审批」里做，这里只显示进度。
              <b>申请人不能批自己提交的单。</b>
            </p>
          </div>

          <!-- 明细 -->
          <div class="sec">
            <h4>发票明细（{{ cur.items.length }} 张，合计 ¥{{ money(cur.items_total) }}）</h4>
            <table class="data sm">
              <thead>
                <tr>
                  <th>发票号</th><th>到期日</th>
                  <th class="num">申请时未付</th><th class="num">本次付款</th>
                  <th class="num">现在未付</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in cur.items" :key="it.id">
                  <td class="mono tiny">{{ it.bill_no }}</td>
                  <td class="tiny">{{ it.due_date || '—' }}</td>
                  <td class="num">{{ money(it.open_amount) }}</td>
                  <td class="num strong">{{ money(it.amount) }}</td>
                  <td class="num">{{ it.open_now === null ? '—' : money(it.open_now) }}</td>
                  <td>
                    <span v-if="it.invoice_status === 'void'" class="tag red">已作废</span>
                    <span v-else-if="it.invoice_status === 'paid'" class="tag green">已付清</span>
                    <span v-else-if="it.invoice_status === 'partial'" class="tag orange">部分付</span>
                    <span v-else class="tag gray">未付</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 付款记录 -->
          <div v-if="cur.payment" class="sec">
            <h4>付款记录</h4>
            <div class="dgrid">
              <div><span>付款单号</span><b class="mono">{{ cur.payment.pay_no }}</b></div>
              <div><span>付款日期</span><b>{{ cur.payment.pay_date }}</b></div>
              <div><span>金额</span><b>¥{{ money(cur.payment.amount) }}</b></div>
              <div><span>状态</span><b>{{ payStatusLabel(cur.payment.status) }}</b></div>
            </div>
          </div>

          <div class="form-foot">
            <button class="btn btn-ghost" @click="cur = null">关闭</button>
            <button v-if="canWrite && cur.status === 'draft'" class="btn btn-primary" @click="doSubmit(cur)">提交审批</button>
            <button v-if="canPay && cur.status === 'approved'" class="btn btn-primary" @click="openPay(cur)">执行付款</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 执行付款 ================= -->
    <div v-if="payOpen" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>执行付款</h3>
          <button class="x" @click="payOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="banner warn">
            <b>这一步钱真的出去了</b>
            <span>
              点下去会生成正式付款流水并核销对应发票，应付台账、资金计划、银行对账会同时变。
              <b>金额不能在这个环节改</b> —— 要改请重新提交审批。
            </span>
          </div>
          <div class="dgrid">
            <div><span>申请单</span><b class="mono">{{ payTarget.req_no }}</b></div>
            <div><span>供应商</span><b>{{ payTarget.supplier_name }}</b></div>
            <div><span>批准金额</span><b>¥{{ money(payTarget.amount) }}</b></div>
            <div><span>明细</span><b>{{ payTarget.item_count }} 张发票</b></div>
          </div>
          <label class="fld block">
            <span>出账银行账户 <i>*</i></span>
            <select v-model="payForm.bank_account_id" class="select">
              <option value="">请选择账户</option>
              <option v-for="a in meta.accounts" :key="a.id" :value="a.id">
                {{ a.bank_name }} {{ a.account_masked }}（{{ a.currency }}）
              </option>
            </select>
          </label>
          <div class="frow">
            <label class="fld">
              <span>付款日期</span>
              <input v-model="payForm.pay_date" type="date" class="input" />
            </label>
            <label class="fld">
              <span>付款方式</span>
              <select v-model="payForm.method" class="select">
                <option v-for="m in meta.methods" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
          </div>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="payOpen = false">再想想</button>
            <button class="btn btn-primary" :disabled="busy || !payForm.bank_account_id" @click="doPay">
              确认付款 ¥{{ money(payTarget.amount) }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const purchaseStatusLabel = status => ({draft:'草稿',ordered:'已下单',partial:'部分到货',received:'已收货',cancelled:'已取消'})[status] || status;
const receiptStatusLabel = status => ({pending:'待检',inspecting:'检验中',partial:'部分合格',passed:'全部合格',rejected:'全退',cancelled:'作废'})[status] || status;

import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('paymentreq.write'));
const canPay = computed(() => can('paymentreq.pay'));

const money = (v) => (Number(v) || 0).toFixed(2);

const rows = ref([]);
const stats = ref({
  draft: { count: 0, amount: 0 },
  submitted: { count: 0, amount: 0 },
  approved: { count: 0, amount: 0 },
  paid: { count: 0, amount: 0 },
  pipeline_amount: 0,
  overdue_pending_count: 0
});
const meta = ref({ suppliers: [], accounts: [], methods: ['银行转账'], statuses: [] });
const tab = ref('');
const q = ref('');
const busy = ref(false);

const cur = ref(null);

/* ---------------- 列表 ---------------- */
async function load() {
  try {
    const params = {};
    if (tab.value) params.status = tab.value;
    if (q.value) params.q = q.value;
    const d = await api.prList(params);
    rows.value = d.rows;
    stats.value = d.summary;
  } catch (e) {
    alert(e.message);
  }
}
function setTab(t) {
  tab.value = t;
  load();
}

// 付款流水的状态是英文枚举（valid/confirmed/reversed），页面上直接显示等于没翻译
function payStatusLabel(s) {
  return (
    {
      valid: '有效',
      confirmed: '已确认',
      reversed: '已冲销',
      draft: '草稿'
    }[s] || s || '—'
  );
}

function statusClass(s) {
  return (
    {
      draft: 'gray',
      submitted: 'orange',
      approved: 'blue',
      paid: 'green',
      cancelled: 'gray'
    }[s] || 'gray'
  );
}

async function reload() {
  busy.value = true;
  try {
    await Promise.all([load(), api.prMeta().then((d) => (meta.value = d))]);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function doExport() {
  const params = {};
  if (tab.value) params.status = tab.value;
  if (q.value) params.q = q.value;
  downloadFile(api.prExportPath(params));
}

/* ---------------- 新建 ---------------- */
const createOpen = ref(false);
const form = reactive({
  supplier_id: '',
  plan_pay_date: new Date().toISOString().slice(0, 10),
  method: '银行转账',
  bank_account_id: '',
  reason: ''
});
const cand = ref({ rows: [], summary: { open_total: 0, committed_total: 0, available_total: 0 } });
// invoice_id → 本次申请金额（undefined 表示未勾选）
const picked = reactive({});

function openCreate() {
  createOpen.value = true;
  form.supplier_id = '';
  form.reason = '';
  form.plan_pay_date = new Date().toISOString().slice(0, 10);
  form.method = '银行转账';
  form.bank_account_id = '';
  cand.value = { rows: [], summary: { open_total: 0, committed_total: 0, available_total: 0 } };
  Object.keys(picked).forEach((k) => delete picked[k]);
}

async function loadCandidates() {
  Object.keys(picked).forEach((k) => delete picked[k]);
  if (!form.supplier_id) {
    cand.value = { rows: [], summary: { open_total: 0, committed_total: 0, available_total: 0 } };
    return;
  }
  try {
    cand.value = await api.prCandidates({ supplier_id: form.supplier_id });
  } catch (e) {
    alert(e.message);
  }
}

/** 勾选默认带全额（可申请额）——大部分场景就是全额付 */
function togglePick(c) {
  if (picked[c.id] !== undefined) delete picked[c.id];
  else picked[c.id] = c.available;
}

function pickAll() {
  cand.value.rows.forEach((c) => {
    if (!c.fully_committed && picked[c.id] === undefined) picked[c.id] = c.available;
  });
}

const pickCount = computed(() => Object.keys(picked).length);
const pickTotal = computed(() =>
  Object.keys(picked).reduce((s, id) => s + (Number(picked[id]) || 0), 0)
);

async function doCreate(submitAfter) {
  if (!form.supplier_id) return alert('先选供应商');
  if (String(form.reason || '').trim().length < 4) {
    return alert('申请理由至少写 4 个字 —— 审批人要知道为什么现在付这笔钱');
  }
  const items = Object.keys(picked)
    .map((id) => ({ invoice_id: Number(id), amount: Number(picked[id]) || 0 }))
    .filter((x) => x.amount > 0);
  if (!items.length) return alert('至少要勾一张发票并填金额');

  busy.value = true;
  try {
    const req = await api.prCreate({
      supplier_id: Number(form.supplier_id),
      items,
      plan_pay_date: form.plan_pay_date,
      method: form.method,
      bank_account_id: form.bank_account_id || undefined,
      reason: form.reason
    });
    if (submitAfter) {
      await api.prSubmit(req.id);
    }
    createOpen.value = false;
    await load();
    await api.prMeta().then((d) => (meta.value = d));
    cur.value = await api.prDetail(req.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

/* ---------------- 详情 / 操作 ---------------- */
async function openDetail(id) {
  try {
    cur.value = await api.prDetail(id);
  } catch (e) {
    alert(e.message);
  }
}

async function doSubmit(r) {
  if (!confirm(`提交「${r.req_no}」走审批？提交后明细不能再改，要改得先撤回。`)) return;
  busy.value = true;
  try {
    await api.prSubmit(r.id);
    await load();
    if (cur.value && cur.value.id === r.id) cur.value = await api.prDetail(r.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doCancel(r) {
  const reason = prompt(
    `取消「${r.req_no}」。\n取消会释放它占用的发票额度。请写原因（至少 4 个字）：`,
    ''
  );
  if (reason === null) return;
  busy.value = true;
  try {
    await api.prCancel(r.id, reason);
    await load();
    if (cur.value && cur.value.id === r.id) cur.value = await api.prDetail(r.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doDelete(r) {
  if (!confirm(`删除草稿「${r.req_no}」？\n只有草稿能删；已提交的单请用「取消」，否则审批记录会断。`)) return;
  try {
    await api.prDelete(r.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

/* ---------------- 执行付款 ---------------- */
const payOpen = ref(false);
const payTarget = ref(null);
const payForm = reactive({ bank_account_id: '', pay_date: '', method: '银行转账' });

function openPay(r) {
  payTarget.value = r;
  payForm.bank_account_id = r.bank_account_id || '';
  payForm.pay_date = new Date().toISOString().slice(0, 10);
  payForm.method = r.method || '银行转账';
  payOpen.value = true;
}

async function doPay() {
  if (!payForm.bank_account_id) return alert('必须选一个出账银行账户');
  const t = payTarget.value;
  if (
    !confirm(
      `确认从账户付出 ¥${money(t.amount)}？\n\n这一步之后钱就算付了，会生成正式付款流水并核销发票。\n如需撤回，只能走退款或红冲。`
    )
  )
    return;
  busy.value = true;
  try {
    const r = await api.prPay(t.id, {
      bank_account_id: Number(payForm.bank_account_id),
      pay_date: payForm.pay_date,
      method: payForm.method
    });
    payOpen.value = false;
    await load();
    await api.prMeta().then((d) => (meta.value = d));
    cur.value = await api.prDetail(r.id);
    alert(`已付款：${r.pay_no}`);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.cards.c5 {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
/* 5 张卡时每张只有 ~180px，「35000.00 元 · 钱还没出门」会把卡撑破 */
.cards.c5 .stat-card .foot {
  white-space: normal;
  line-height: 1.5;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tabs button {
  padding: 6px 14px;
  border: 1px solid #e2e8f2;
  background: var(--surface);
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--ink-soft);
  cursor: pointer;
}
.tabs button.on {
  background: #16305f;
  border-color: #16305f;
  color: #fff;
}
.data td.num,
.data th.num {
  white-space: nowrap;
}
/* 状态标签两字被挤成竖排「已/付/款」，读起来像乱码 */
.data .tag {
  white-space: nowrap;
}
.sup-cell {
  min-width: 168px;
  max-width: 210px;
}
/* 申请理由常常一句话，限一行 + 省略号；完整内容在详情里看 */
.sup-cell .tiny.muted {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nowrap {
  white-space: nowrap;
}
.ops {
  white-space: nowrap;
}
.ops .link-btn + .link-btn {
  margin-left: 10px;
}
.link-btn.danger {
  color: #d92d45;
}
.row-off td {
  opacity: 0.5;
}
.row-sel td {
  background: #f6f9ff;
}
.input.sm {
  width: 108px;
  padding: 3px 7px;
  font-size: 12.5px;
  text-align: right;
}
/* 表单 */
.frow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.fld.block {
  margin-bottom: 12px;
}
.fld > span {
  font-size: 12.5px;
  color: var(--ink-soft);
}
.fld > span i {
  color: #d92d45;
  font-style: normal;
}
.cand-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 14px 0 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.cand-head .spacer {
  flex: 1;
}
.sum-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: #f6f9ff;
  border: 1px solid #d6e4ff;
  font-size: 13px;
}
.sum-bar .spacer {
  flex: 1;
}
.sum-bar .big {
  font-size: 16px;
  color: #16305f;
}
/* 明细多时（供应商一次十几张票）按钮会跟着滚走，做成吸底 */
.form-foot {
  position: sticky;
  bottom: -18px;
  margin-top: 14px;
  padding: 12px 0 4px;
  background: var(--surface);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--line);
}
/* 详情 */
.dgrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px 16px;
  margin-bottom: 14px;
}
/* 窄弹窗（560px）放 4 列会把「绍兴恒信纺织有限公司」挤成两行 */
.modal:not(.wide):not(.xwide) .dgrid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.dgrid > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dgrid span {
  font-size: 12px;
  color: var(--ink-mute);
}
.dgrid b {
  font-size: 13px;
  color: var(--ink);
  font-weight: 600;
}
.reason-box {
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  margin-bottom: 14px;
  font-size: 13px;
  line-height: 1.7;
}
.sec {
  margin-top: 16px;
}
.sec h4 {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--ink);
  font-weight: 700;
}
/* 审批步骤 */
.steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--surface-2);
}
.step .sn {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #eef1f6;
  color: var(--ink-soft);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.step .st {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
}
.step.done {
  border-color: #bfe7cd;
  background: #f4fdf7;
}
.step.done .sn {
  background: #16a34a;
  color: #fff;
}
.step.now {
  border-color: #ffd9a8;
  background: #fffaf2;
}
.step.now .sn {
  background: #d97706;
  color: #fff;
}
.step.rej {
  border-color: #f8c9d0;
  background: #fff7f8;
}
.step.rej .sn {
  background: #d92d45;
  color: #fff;
}

@media (max-width: 900px) {
  .cards.c5 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .frow,
  .dgrid {
    grid-template-columns: 1fr;
  }
}
</style>
