<template>
  <div>
    <div class="page-head">
      <div>
        <h2>往来账</h2>
        <div class="sub">应收 / 应付 / 收付款核销；发货自动开应收，收款后订单才能结案</div>
      </div>
      <div style="display: flex; gap: 10px">
        <button class="btn btn-ghost" @click="loadAll">刷新</button>
        <button class="btn btn-primary" @click="openPay('in')">＋ 登记收款</button>
        <button class="btn btn-ghost" @click="openPay('out')">＋ 登记付款</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>应收未收（USD）</span>
        <strong class="amt-red">${{ money(sum.ar_open_usd) }}</strong>
        <small>折合 ¥{{ money(sum.ar_open) }} · {{ sum.ar_count || 0 }} 张未结</small>
      </div>
      <div class="stat">
        <span>已开票（USD）</span>
        <strong>${{ money(sum.ar_total_usd) }}</strong>
        <small>已收 ${{ money(sum.ar_paid_usd) }} · 逾期 ¥{{ money(sum.ar_overdue) }}</small>
      </div>
      <div class="stat">
        <span>本月收款</span>
        <strong class="amt-green">¥{{ money(sum.month_in) }}</strong>
        <small>已核销款项（本币口径）</small>
      </div>
      <div class="stat">
        <span>本月付款</span>
        <strong>¥{{ money(sum.month_out) }}</strong>
        <small>{{ sum.ap_count || 0 }} 张应付未付 ¥{{ money(sum.ap_open) }}</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="seg">
        <button :class="{ on: tab === 'ar' }" @click="switchTab('ar')">应收</button>
        <button :class="{ on: tab === 'ap' }" @click="switchTab('ap')">应付</button>
        <button :class="{ on: tab === 'pay' }" @click="switchTab('pay')">收付款</button>
        <button :class="{ on: tab === 'aging' }" @click="switchTab('aging')">账龄</button>
      </div>
      <input v-if="tab === 'ar' || tab === 'ap'" class="input" v-model="q" placeholder="单号 / 对象 / 备注" style="width: 220px" @keyup.enter="loadInvoices" />
      <select v-if="tab === 'ar' || tab === 'ap'" class="select" v-model="status" style="width: 130px" @change="loadInvoices">
        <option value="">全部状态</option>
        <option value="unpaid">未收/未付</option>
        <option value="partial">部分</option>
        <option value="paid">已结清</option>
        <option value="void">已作废</option>
      </select>
      <button v-if="tab === 'ar' || tab === 'ap'" class="btn btn-ghost" @click="loadInvoices">查询</button>
    </div>

    <!-- 应收 / 应付 -->
    <div v-if="tab === 'ar' || tab === 'ap'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 150px">单号</th>
            <th style="min-width: 150px">{{ tab === 'ar' ? '客户' : '供应商' }}</th>
            <th style="min-width: 140px">来源</th>
            <th style="width: 118px">金额</th>
            <th style="width: 118px">已{{ tab === 'ar' ? '收' : '付' }}</th>
            <th style="width: 118px">未结</th>
            <th style="width: 105px">到期日</th>
            <th style="width: 80px">账龄</th>
            <th style="width: 86px">状态</th>
            <th style="width: 120px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in invoices" :key="r.id" :class="{ 'row-overdue': r.overdue }">
            <td>{{ r.bill_no }}</td>
            <td>{{ tab === 'ar' ? r.customer_name : r.supplier_name }}</td>
            <td class="sub-cell">{{ sourceText(r) }}</td>
            <td class="num">
              <div class="dual" :class="{ usd: isUsd(r) }">{{ curText(r, r.amount_orig) }}</div>
              <div v-if="isUsd(r)" class="dual-sub">¥{{ money(r.amount) }}</div>
            </td>
            <td class="num">
              <div class="dual" :class="{ usd: isUsd(r) }">{{ curText(r, r.paid_amount / (r.rate || 1)) }}</div>
              <div v-if="isUsd(r)" class="dual-sub">¥{{ money(r.paid_amount) }}</div>
            </td>
            <td class="num strong">
              <div class="dual" :class="{ usd: isUsd(r) }">{{ curText(r, r.open_amount_orig) }}</div>
              <div v-if="isUsd(r)" class="dual-sub">¥{{ money(r.open_amount) }}</div>
            </td>
            <td>{{ r.due_date || '-' }}</td>
            <td class="center">{{ r.aging_days }} 天</td>
            <td><span class="tag" :class="statusTag(r.status)">{{ statusText(r.status) }}</span></td>
            <td class="ops">
              <button v-if="r.status !== 'paid' && r.status !== 'void'" class="link-btn" @click="openPay(tab === 'ar' ? 'in' : 'out', r)">登记</button>
              <button v-if="r.status !== 'void' && !r.paid_amount" class="link-btn danger" @click="voidInvoice(r)">作废</button>
              <span v-if="r.status === 'void'" class="sub-cell">{{ r.void_reason || '已作废' }}</span>
            </td>
          </tr>
          <tr v-if="!invoices.length"><td colspan="10" class="empty-cell">暂无记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 收付款 -->
    <div v-if="tab === 'pay'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 150px">单号</th>
            <th style="width: 70px">方向</th>
            <th style="min-width: 150px">对象</th>
            <th style="width: 100px">金额</th>
            <th style="width: 100px">方式</th>
            <th style="width: 105px">日期</th>
            <th style="min-width: 200px">核销明细</th>
            <th style="width: 86px">状态</th>
            <th style="width: 80px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in payments" :key="p.id">
            <td>{{ p.pay_no }}</td>
            <td>
              <span class="tag" :class="p.direction === 'in' ? 'green' : 'blue'">{{ p.direction === 'in' ? '收款' : '付款' }}</span>
            </td>
            <td>{{ p.partner_name }}</td>
            <td class="num strong">
              <div class="dual" :class="{ usd: p.currency === 'USD' }">
                {{ p.currency === 'USD' ? '$' + money(p.amount_orig) : '¥' + money(p.amount_orig || p.amount) }}
              </div>
              <div v-if="p.currency === 'USD'" class="dual-sub">¥{{ money(p.amount) }} @{{ p.rate }}</div>
            </td>
            <td>{{ p.method || '-' }}</td>
            <td>{{ p.pay_date || '-' }}</td>
            <td class="sub-cell">
              <span v-if="!p.allocations || !p.allocations.length" class="muted">未核销（挂账）</span>
              <span v-for="a in p.allocations" :key="a.id" class="alloc-chip">{{ a.bill_no }} ¥{{ money(a.amount) }}</span>
            </td>
            <td><span class="tag" :class="p.status === 'valid' ? 'green' : 'gray'">{{ p.status === 'valid' ? '有效' : '已红冲' }}</span></td>
            <td>
              <button v-if="p.status === 'valid'" class="link-btn danger" @click="reversePay(p)">红冲</button>
            </td>
          </tr>
          <tr v-if="!payments.length"><td colspan="9" class="empty-cell">还没有收付款记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 账龄 -->
    <div v-if="tab === 'aging'" class="aging-wrap">
      <div class="seg" style="margin-bottom: 12px">
        <button :class="{ on: agingKind === 'ar' }" @click="agingKind = 'ar'; loadAging()">应收账龄</button>
        <button :class="{ on: agingKind === 'ap' }" @click="agingKind = 'ap'; loadAging()">应付账龄</button>
      </div>
      <div class="aging-list">
        <div v-for="b in agingRows" :key="b.key" class="aging-item">
          <div class="aging-head">
            <span>{{ b.label }}</span>
            <strong>¥{{ money(b.value) }}</strong>
          </div>
          <div class="aging-bar"><i :style="{ width: b.pct + '%' }" :class="b.cls"></i></div>
        </div>
      </div>
      <p class="muted" style="font-size: 12px; margin-top: 12px">
        按到期日归集：未到期、逾期 1-30 天、31-60 天、61-90 天、90 天以上。逾期越久越要盯。
      </p>
    </div>

    <!-- 登记收付款 -->
    <div v-if="payOpen" class="modal-mask" @click.self="payOpen = false">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ payForm.direction === 'in' ? '登记收款' : '登记付款' }}</h3>
          <button class="x" @click="payOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>{{ payForm.direction === 'in' ? '客户' : '供应商' }} *</label>
              <select class="select" v-model="payForm.partner_id" @change="onPartnerChange">
                <option :value="null">请选择</option>
                <option v-for="p in partners" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>币种 *</label>
              <select class="select" v-model="payForm.currency">
                <option value="USD">USD 美金</option>
                <option value="CNY">CNY 人民币</option>
              </select>
            </div>
            <div class="fitem">
              <label>{{ payForm.currency === 'USD' ? '美金金额 *' : '金额 *' }}</label>
              <input class="input" type="number" step="0.01" v-model.number="payForm.amount" />
              <div v-if="payForm.currency === 'USD'" class="fitem-tip">
                × {{ payForm.rate }} = <b>折合 ¥{{ money(payForm.amount * payForm.rate) }}</b>（核销按本币）
              </div>
            </div>
            <div v-if="payForm.currency === 'USD'" class="fitem">
              <label>汇率（1 USD = ? CNY）</label>
              <input class="input" type="number" step="0.0001" v-model.number="payForm.rate" />
            </div>
            <div class="fitem">
              <label>收付方式</label>
              <select class="select" v-model="payForm.method">
                <option>银行转账</option>
                <option>现金</option>
                <option>承兑汇票</option>
                <option>平台结算</option>
              </select>
            </div>
            <div class="fitem">
              <label>日期</label>
              <input class="input" type="date" v-model="payForm.pay_date" />
            </div>
            <div class="fitem full">
              <label>备注</label>
              <input class="input" v-model="payForm.remark" placeholder="如：首款 40%、尾款、银行退回重付" />
            </div>
          </div>

          <h4 style="margin: 14px 0 8px; font-size: 13px">
            核销到哪些单据
            <span class="muted" style="font-weight: 400">勾选后自动按未结金额填入，可改</span>
          </h4>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th style="width: 40px"></th>
                  <th style="width: 150px">单号</th>
                  <th style="width: 105px">到期日</th>
                  <th style="width: 100px">未结金额</th>
                  <th style="width: 130px">本次核销（¥）</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="inv in openInvoices" :key="inv.id">
                  <td><input type="checkbox" :checked="allocOf(inv.id).checked" @change="toggleAlloc(inv, $event.target.checked)" /></td>
                  <td>{{ inv.bill_no }}</td>
                  <td>{{ inv.due_date || '-' }}</td>
                  <td class="num">
                    <div class="dual" :class="{ usd: isUsd(inv) }">{{ curText(inv, inv.open_amount_orig) }}</div>
                    <div v-if="isUsd(inv)" class="dual-sub">¥{{ money(inv.open_amount) }}</div>
                  </td>
                  <td>
                    <input class="input" type="number" step="0.01" :disabled="!allocOf(inv.id).checked"
                           :value="allocOf(inv.id).amount" @input="setAlloc(inv.id, $event.target.value)" />
                  </td>
                </tr>
                <tr v-if="!openInvoices.length"><td colspan="5" class="empty-cell">这个对象没有未结单据，可以直接登记为往来款</td></tr>
              </tbody>
            </table>
          </div>
          <div class="pay-foot">
            <span>核销合计 <strong>¥{{ money(allocTotal) }}</strong></span>
            <span :class="allocTotal > payForm.amount * (payForm.currency === 'USD' ? payForm.rate : 1) + 0.005 ? 'amt-red' : 'muted'">
              收付金额 {{ payForm.currency === 'USD' ? '$' + money(payForm.amount) + '（¥' + money(payForm.amount * payForm.rate) + '）' : '¥' + money(payForm.amount) }}，
              未核销 ¥{{ money(Math.max(0, payForm.amount * (payForm.currency === 'USD' ? payForm.rate : 1) - allocTotal)) }}
            </span>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="payOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="savePay">{{ saving ? '提交中…' : '确认登记' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const tab = ref('ar');
const q = ref('');
const status = ref('');
const sum = ref({});
const invoices = ref([]);
const payments = ref([]);
const agingKind = ref('ar');
const aging = ref({ buckets: {}, count: 0 });

const payOpen = ref(false);
const saving = ref(false);
const partners = ref([]);
const openInvoices = ref([]);
const allocs = ref({});
const payForm = ref(blankPay());

const money = (v) => (Number(v) || 0).toFixed(2);
/** 外币单据判断 */
const isUsd = (r) => (r && r.currency === 'USD');
/** 按单据币种显示金额：USD 显示 $，其它显示 ¥ */
function curText(r, v) {
  const n = money(v);
  return isUsd(r) ? '$' + n : '¥' + n;
}

function blankPay() {
  return {
    direction: 'in', partner_id: null, currency: 'CNY', rate: 6.5, amount: 0,
    method: '银行转账', pay_date: new Date().toISOString().slice(0, 10), remark: ''
  };
}

function statusText(s) {
  return { unpaid: '未结', partial: '部分', paid: '已结清', void: '已作废' }[s] || s;
}
function statusTag(s) {
  return { unpaid: 'orange', partial: 'blue', paid: 'green', void: 'gray' }[s] || 'gray';
}
function sourceText(r) {
  const map = { order: '订单', retail: '零售', purchase: '采购', outsource: '外协', expense: '费用', manual: '手工' };
  const src = map[r.source] || r.source;
  const link = r.order_id ? ` #${r.order_id}` : r.purchase_id ? ` #${r.purchase_id}` : '';
  return (r.remark || '') + ' · ' + src + link;
}

async function loadSummary() {
  try { sum.value = await api.financeSummary(); } catch (e) { /* ignore */ }
}
async function loadInvoices() {
  try {
    invoices.value = await api.financeInvoices(tab.value, { q: q.value, status: status.value });
  } catch (e) { alert(e.message); }
}
async function loadPayments() {
  try { payments.value = await api.financePayments(); } catch (e) { alert(e.message); }
}
async function loadAging() {
  try {
    aging.value = await api.financeAging(agingKind.value);
  } catch (e) { alert(e.message); }
}
const agingRows = computed(() => {
  const b = aging.value.buckets || {};
  const list = [
    { key: 'current', label: '未到期', value: b.current || 0, cls: 'ok' },
    { key: 'd30', label: '逾期 1-30 天', value: b.d30 || 0, cls: 'warn' },
    { key: 'd60', label: '逾期 31-60 天', value: b.d60 || 0, cls: 'warn2' },
    { key: 'd90', label: '逾期 61-90 天', value: b.d90 || 0, cls: 'bad' },
    { key: 'over90', label: '逾期 90 天以上', value: b.over90 || 0, cls: 'bad' }
  ];
  const max = Math.max(1, ...list.map((x) => x.value));
  return list.map((x) => ({ ...x, pct: Math.round((x.value / max) * 100) }));
});

/** 切页签要重新取数，否则表格还是上一个页签的内容 */
async function switchTab(t) {
  tab.value = t;
  q.value = '';
  status.value = '';
  if (t === 'ar' || t === 'ap') await loadInvoices();
  else if (t === 'pay') await loadPayments();
  else await loadAging();
}

async function loadAll() {
  await Promise.all([loadSummary(), loadInvoices(), loadPayments(), loadAging()]);
}

async function openPay(direction, inv) {
  payForm.value = blankPay();
  payForm.value.direction = direction;
  allocs.value = {};
  openInvoices.value = [];
  payOpen.value = true;
  try {
    partners.value = direction === 'in'
      ? ((await api.customers({ pageSize: 500 })) || []).map((c) => ({ id: c.id, name: c.name }))
      : ((await api.suppliers({})) || []).map((s) => ({ id: s.id, name: s.name }));
    if (inv) {
      payForm.value.partner_id = direction === 'in' ? inv.customer_id : inv.supplier_id;
      // 从美金单据点「登记」时，直接美金口径带出，避免人工换算
      if (isUsd(inv)) {
        payForm.value.currency = 'USD';
        payForm.value.rate = Number(inv.rate) || 6.5;
        payForm.value.amount = Number(inv.open_amount_orig) || 0;
      } else {
        payForm.value.amount = inv.open_amount;
      }
      await onPartnerChange();
      toggleAlloc(inv, true);
    }
  } catch (e) { alert(e.message); }
}

async function onPartnerChange() {
  allocs.value = {};
  openInvoices.value = [];
  if (!payForm.value.partner_id) return;
  try {
    openInvoices.value = await api.financeOpenInvoices(
      payForm.value.direction === 'in' ? 'ar' : 'ap',
      payForm.value.partner_id
    );
  } catch (e) { /* ignore */ }
}

const allocOf = (id) => allocs.value[id] || { checked: false, amount: 0 };
function toggleAlloc(inv, on) {
  const next = { ...allocs.value };
  if (on) {
    next[inv.id] = { checked: true, amount: inv.open_amount };
    // 没填金额时顺手把收付金额带成核销合计（按当前币种取原币或本币）
    if (!payForm.value.amount) {
      payForm.value.amount = payForm.value.currency === 'USD'
        ? (Number(inv.open_amount_orig) || 0)
        : inv.open_amount;
    }
  } else {
    delete next[inv.id];
  }
  allocs.value = next;
}
function setAlloc(id, v) {
  const next = { ...allocs.value };
  if (next[id]) next[id] = { ...next[id], amount: Number(v) || 0 };
  allocs.value = next;
}
const allocTotal = computed(() =>
  Object.keys(allocs.value).reduce((s, k) => s + (Number(allocs.value[k].amount) || 0), 0)
);

async function savePay() {
  const f = payForm.value;
  if (!f.partner_id) return alert('请选择对象');
  if (!(Number(f.amount) > 0)) return alert('金额必须大于 0');
  if (f.currency === 'USD' && !(Number(f.rate) > 0)) return alert('请填写汇率');
  const localAmount = f.currency === 'USD' ? Number(f.amount) * Number(f.rate) : Number(f.amount);
  if (allocTotal.value > localAmount + 0.005) return alert('核销合计超过收付金额（按本币比较）');
  const partner = partners.value.find((p) => p.id === f.partner_id);
  saving.value = true;
  try {
    const allocations = Object.keys(allocs.value)
      .filter((k) => allocs.value[k].checked && Number(allocs.value[k].amount) > 0)
      .map((k) => ({ invoice_id: Number(k), amount: Number(allocs.value[k].amount) }));
    const payload = {
      direction: f.direction,
      partner_id: f.partner_id,
      partner_name: partner ? partner.name : '',
      currency: f.currency,
      method: f.method,
      pay_date: f.pay_date,
      remark: f.remark,
      allocations
    };
    if (f.currency === 'USD') {
      payload.amount_orig = Number(f.amount);
      payload.rate = Number(f.rate);
    } else {
      payload.amount = Number(f.amount);
    }
    const r = await api.createPayment(payload);
    payOpen.value = false;
    await loadAll();
    const head = f.currency === 'USD'
      ? `已登记 ${r.pay_no}：$ ${money(r.amount_orig)} × ${r.rate} = ¥${money(r.amount)}`
      : `已登记 ${r.pay_no}：¥${money(r.amount)}`;
    alert(head + `，核销 ¥${money(r.allocated)}` + (r.unallocated ? `，未核销 ¥${money(r.unallocated)}` : ''));
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function reversePay(p) {
  const reason = prompt(`红冲 ${p.pay_no}（¥${money(p.amount)}）的理由：`);
  if (!reason || !reason.trim()) return;
  try {
    await api.reversePayment(p.id, reason.trim());
    await loadAll();
    alert('已红冲，核销金额已退回对应单据');
  } catch (e) { alert(e.message); }
}

async function voidInvoice(r) {
  const reason = prompt(`作废 ${r.bill_no} 的理由：`);
  if (!reason || !reason.trim()) return;
  try {
    await api.voidInvoice(tab.value, r.id, reason.trim());
    await loadInvoices();
    await loadSummary();
  } catch (e) { alert(e.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat {
  background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 16px;
  display: flex; flex-direction: column; gap: 3px;
}
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { font-size: 20px; color: #16233b; font-weight: 600; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-red { color: #d92d45 !important; }
.amt-green { color: #16a34a !important; }
.num { text-align: right; }
.num.strong { font-weight: 600; color: #16233b; }
.center { text-align: center; }
.sub-cell { font-size: 11.5px; color: #8a94a6; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-overdue td { background: #fffafa; }
.muted { color: #a9b4c5; }
.alloc-chip {
  display: inline-block; background: #eef4ff; color: #2b6de5; border-radius: 4px;
  padding: 0 6px; margin: 1px 4px 1px 0; font-size: 11px;
}
.ops { white-space: nowrap; }
.pay-foot {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 10px; font-size: 12.5px; color: #5b6474;
}
.aging-wrap { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 16px 18px; }
.aging-list { display: flex; flex-direction: column; gap: 12px; }
.aging-head { display: flex; justify-content: space-between; font-size: 13px; color: #33415a; margin-bottom: 5px; }
.aging-bar { height: 10px; background: #f2f5fa; border-radius: 6px; overflow: hidden; }
.aging-bar i { display: block; height: 100%; border-radius: 6px; }
.aging-bar i.ok { background: #16a34a; }
.aging-bar i.warn { background: #eab308; }
.aging-bar i.warn2 { background: #f97316; }
.aging-bar i.bad { background: #d92d45; }
/* 双币展示：原币为主，本币小字换算 */
.dual { font-variant-numeric: tabular-nums; }
.dual.usd { color: #1a56b8; }
.dual-sub { font-size: 11px; color: #8a94a6; font-weight: 400; margin-top: 1px; font-variant-numeric: tabular-nums; }
.fitem-tip { font-size: 11.5px; color: #8a94a6; margin-top: 3px; }
.fitem-tip b { color: #1a56b8; }
@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
}
</style>
