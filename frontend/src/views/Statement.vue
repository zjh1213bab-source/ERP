<template>
  <div class="st-wrap">
    <!-- 工具栏（打印时隐藏） -->
    <div class="st-bar no-print">
      <button class="btn btn-ghost btn-sm" @click="router.back()">← 返回</button>
      <select v-model="customerId" class="select" style="min-width: 230px" @change="reload">
        <option v-for="c in customers" :key="c.id" :value="c.id">
          {{ c.name }}<template v-if="c.real_open">（结欠 {{ money(c.real_open) }}）</template>
        </option>
      </select>
      <label class="dt">从 <input v-model="from" class="input" type="date" @change="reload" /></label>
      <label class="dt">到 <input v-model="to" class="input" type="date" @change="reload" /></label>
      <span class="sp"></span>
      <button class="btn btn-ghost btn-sm" @click="reload">刷新</button>
      <button class="btn btn-primary btn-sm" :disabled="!data" @click="doPrint">打印对账函</button>
    </div>

    <!-- 内部提示（不打印） -->
    <div v-for="(w, i) in (data && data.warnings) || []" :key="'w' + i" class="st-warn no-print">
      <b>⚠ 这张单现在不能发出去</b>
      <p>{{ w }}</p>
    </div>
    <div v-for="(n, i) in (data && data.notices) || []" :key="'n' + i" class="st-note no-print">
      <b>提示</b>
      <p>{{ n }}</p>
    </div>

    <div v-if="err" class="st-warn no-print"><b>出不了对账单</b><p>{{ err }}</p></div>

    <div v-if="data" class="st-sheet">
      <div class="st-title">
        <h1>客户往来对账单</h1>
        <div class="st-sub">STATEMENT OF ACCOUNT</div>
      </div>

      <div class="st-meta">
        <div class="st-to">
          <div><span>致：</span><b>{{ data.customer.name }}</b></div>
          <div class="tiny" v-if="data.customer.contact || data.customer.phone">
            联系人：{{ data.customer.contact || '—' }}　电话：{{ data.customer.phone || '—' }}
          </div>
          <div class="tiny" v-if="data.customer.address">地址：{{ data.customer.address }}</div>
        </div>
        <div class="st-period">
          <div>对账期间：<b>{{ data.period.from }} ~ {{ data.period.to }}</b></div>
          <div class="tiny">出单日期：{{ $fmt(now) }}</div>
          <div class="tiny">对账单号：ST-{{ data.customer.id }}-{{ data.period.to.replace(/-/g, '') }}</div>
        </div>
      </div>

      <!-- 五个数：客户财务最先看的就是这一排 -->
      <table class="st-sum">
        <tbody>
          <tr>
            <td>
              <div class="k">期初余额</div>
              <div class="v">{{ money(data.summary.opening) }}</div>
            </td>
            <td>
              <div class="k">本期开票（{{ data.summary.invoice_count }} 张）</div>
              <div class="v add">{{ data.summary.invoice_amount ? '+' + money(data.summary.invoice_amount) : '0.00' }}</div>
            </td>
            <td>
              <div class="k">本期收款（{{ data.summary.payment_count }} 笔）</div>
              <div class="v sub">{{ data.summary.payment_amount ? '−' + money(data.summary.payment_amount) : '0.00' }}</div>
            </td>
            <td class="hl">
              <div class="k">期末结欠</div>
              <div class="v">{{ money(data.summary.closing) }}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="data.summary.unallocated > 0.005" class="st-unalloc">
        其中 <b>{{ money(data.summary.unallocated) }}</b> 元为已到账但尚未核销到具体发票的收款（不影响上述结欠金额）。
      </div>

      <!-- 流水 -->
      <table class="st-table">
        <thead>
          <tr>
            <th style="width: 92px">日期</th>
            <th style="width: 58px">类型</th>
            <th>单据号</th>
            <th style="width: 108px">订单号</th>
            <th class="r" style="width: 104px">增加（开票）</th>
            <th class="r" style="width: 104px">减少（收款）</th>
            <th class="r" style="width: 108px">余额</th>
            <th style="width: 116px">备注</th>
          </tr>
        </thead>
        <tbody>
          <tr class="opening">
            <td>{{ data.period.from }}</td>
            <td colspan="4"><b>期初余额</b></td>
            <td class="r">—</td>
            <td class="r b">{{ money(data.opening) }}</td>
            <td></td>
          </tr>
          <tr v-for="(r, i) in data.rows" :key="i">
            <td class="tiny">{{ r.date }}</td>
            <td>
              <span class="tag" :class="r.kind === 'invoice' ? 'blue' : 'green'">
                {{ r.kind === 'invoice' ? '开票' : '收款' }}
              </span>
            </td>
            <td class="mono">{{ r.no }}</td>
            <td class="mono tiny">{{ r.order_no || '—' }}</td>
            <td class="r">{{ r.debit ? money(r.debit) : '' }}</td>
            <td class="r">{{ r.credit ? money(r.credit) : '' }}</td>
            <td class="r b">{{ money(r.balance) }}</td>
            <td class="tiny">{{ r.note }}</td>
          </tr>
          <tr v-if="!data.rows.length">
            <td colspan="8" class="empty">本期无发生额</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="4" class="r"><b>本期合计 / 期末结欠</b></td>
            <td class="r b">{{ money(data.summary.invoice_amount) }}</td>
            <td class="r b">{{ money(data.summary.payment_amount) }}</td>
            <td class="r b">{{ money(data.summary.closing) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <!-- 说明 + 盖章 -->
      <div class="st-notes">
        <b>说明</b>
        <ol>
          <li>本对账单按「开票日 / 收款日」归集，不含未开票的发货与预收款；金额单位为人民币元。</li>
          <li>外币单据按开票日汇率折算，折算汇率见系统单据；如需原币明细可另外提供。</li>
          <li>如与贵司账面记录不符，请于收到本单后 <b>7 个工作日</b> 内提出，逾期未回复视为确认。</li>
          <li>核对无误后请在本单下方签章回传，作为双方往来账款的确认依据。</li>
        </ol>
      </div>

      <div class="st-seal">
        <div class="st-seal-col">
          <div class="st-seal-h">我方（出单方）</div>
          <div class="st-seal-box">财务专用章</div>
          <div class="st-seal-line">制单人：______________</div>
          <div class="st-seal-line">日期：____年____月____日</div>
        </div>
        <div class="st-seal-col">
          <div class="st-seal-h">贵司（确认方）</div>
          <div class="st-seal-box">单位盖章 / 财务章</div>
          <div class="st-seal-line">经办人签字：______________</div>
          <div class="st-seal-line">日期：____年____月____日</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const router = useRouter();

const customerId = ref(Number(route.params.customerId) || null);
const customers = ref([]);
const data = ref(null);
const err = ref('');
const now = ref('');

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
// 期间优先取 URL 参数（从财务页带过来时不用手选）
const from = ref(route.query.from || `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`);
const to = ref(route.query.to || `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(last)}`);

const money = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadCustomers() {
  customers.value = await api.statementCustomers();
  if (!customerId.value && customers.value.length) customerId.value = customers.value[0].id;
}

async function load() {
  if (!customerId.value) return;
  err.value = '';
  try {
    data.value = await api.statement(customerId.value, { from: from.value, to: to.value });
    now.value = new Date().toISOString();
  } catch (e) {
    data.value = null;
    err.value = e.message;
  }
}

async function reload() {
  await load();
}

function doPrint() {
  window.print();
}

onMounted(async () => {
  try {
    await loadCustomers();
    await load();
  } catch (e) {
    err.value = e.message;
  }
});
</script>

<style scoped>
.st-wrap {
  min-height: 100vh;
  background: #eef1f6;
  padding: 14px;
}
.st-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  max-width: 1000px;
  margin: 0 auto 12px;
  padding: 10px 14px;
  background: #fff;
  border: 1px solid #e6ebf3;
  border-radius: 12px;
}
.st-bar .sp { flex: 1; }
.st-bar .dt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #6b7688;
}
.st-bar .input { width: auto; }
.st-warn,
.st-note {
  max-width: 1000px;
  margin: 0 auto 10px;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 13px;
}
.st-warn {
  background: #fdf3f4;
  border: 1px solid #f3c6cd;
  color: #b02a3c;
}
.st-warn p,
.st-note p {
  margin: 6px 0 0;
  line-height: 1.7;
}
.st-note {
  background: #fff8e8;
  border: 1px solid #f5dfae;
  color: #92600a;
}
.st-sheet {
  max-width: 1000px;
  margin: 0 auto;
  background: #fff;
  border-radius: 12px;
  padding: 24px 30px 20px;
  box-shadow: 0 2px 12px rgba(16, 32, 64, 0.06);
}
.st-title {
  text-align: center;
  border-bottom: 2px solid #16233b;
  padding-bottom: 8px;
  margin-bottom: 14px;
}
.st-title h1 {
  margin: 0;
  font-size: 22px;
  letter-spacing: 6px;
  color: #16233b;
}
.st-sub {
  font-size: 10px;
  letter-spacing: 3px;
  color: #9aa4b5;
  margin-top: 2px;
}
.st-meta {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  font-size: 13px;
  color: #16233b;
  margin-bottom: 14px;
}
.st-to div { margin-bottom: 3px; }
.st-period { text-align: right; }
.st-period div { margin-bottom: 3px; }
.st-sum {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 6px;
}
.st-sum td {
  border: 1px solid #d8dee9;
  padding: 8px 12px;
  width: 25%;
}
.st-sum .k { font-size: 11.5px; color: #6b7688; }
.st-sum .v { font-size: 17px; font-weight: 700; color: #16233b; margin-top: 2px; }
.st-sum .v.add { color: #1d4ed8; }
.st-sum .v.sub { color: #15803d; }
.st-sum td.hl { background: #f4f7ff; }
.st-unalloc {
  font-size: 11.5px;
  color: #92600a;
  background: #fff8e8;
  border: 1px solid #f5dfae;
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 12px;
}
.st-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 6px;
}
.st-table th,
.st-table td {
  border: 1px solid #d8dee9;
  padding: 6px 7px;
}
.st-table th {
  background: #f4f6fa;
  font-weight: 700;
  color: #16233b;
}
.st-table .r { text-align: right; }
.st-table .b { font-weight: 700; }
.st-table .opening td { background: #f9fafc; }
.st-table tfoot td { background: #f4f6fa; font-weight: 700; }
.st-table .empty { text-align: center; color: #9aa4b5; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.st-notes {
  margin-top: 14px;
  font-size: 11px;
  color: #4b5568;
  line-height: 1.8;
}
.st-notes b { color: #16233b; }
.st-notes ol { margin: 4px 0 0 18px; padding: 0; }
.st-seal {
  display: flex;
  gap: 40px;
  margin-top: 20px;
}
.st-seal-col { flex: 1; font-size: 12px; color: #4b5568; }
.st-seal-h { font-weight: 700; color: #16233b; margin-bottom: 6px; }
.st-seal-box {
  height: 74px;
  border: 1px dashed #b9c2d0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c3cad6;
  font-size: 11px;
  margin-bottom: 8px;
}
.st-seal-line { margin-bottom: 4px; }

@media print {
  @page { size: A4; margin: 12mm; }
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .st-wrap { background: #fff; padding: 0; }
  .st-sheet {
    box-shadow: none;
    border-radius: 0;
    padding: 0;
    max-width: none;
  }
  .st-table { font-size: 10.5px; }
  .st-table th, .st-table td { padding: 4px 5px; }
  .st-table thead { display: table-header-group; }
  .st-table tr { page-break-inside: avoid; }
  .st-seal { page-break-inside: avoid; }
}
</style>
