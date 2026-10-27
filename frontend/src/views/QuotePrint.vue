<template>
  <div class="qp-page">
    <div class="qp-toolbar no-print">
      <button class="btn btn-primary btn-sm" @click="doPrint">打印</button>
      <button class="btn btn-ghost btn-sm" @click="back">返回</button>
      <span class="qp-tip">打印时选「另存为 PDF」即可导出报价单</span>
    </div>

    <div v-if="!quote" class="qp-loading">加载中…</div>

    <div v-else class="qp-sheet">
      <div class="qp-head">
        <div>
          <div class="qp-co">跳色科技有限公司</div>
          <div class="qp-co-en">TIAOSE TECHNOLOGY CO., LTD.</div>
        </div>
        <div class="qp-title">
          <h1>报价单</h1>
          <div class="qp-title-en">QUOTATION</div>
        </div>
      </div>

      <table class="qp-meta">
        <tbody>
          <tr>
            <th>报价单号</th><td>{{ quote.quote_no }}</td>
            <th>日期</th><td>{{ (quote.created_at || '').slice(0, 10) }}</td>
          </tr>
          <tr>
            <th>客户</th><td>{{ quote.customer_name || '-' }}</td>
            <th>有效期至</th><td>{{ quote.valid_until || '-' }}</td>
          </tr>
          <tr>
            <th>贸易条款</th><td>{{ quote.trade_terms || '-' }}</td>
            <th>交货期</th><td>{{ quote.delivery_days || 0 }} 天</td>
          </tr>
        </tbody>
      </table>

      <table class="qp-table">
        <thead>
          <tr>
            <th style="width: 38px">#</th>
            <th style="width: 110px">款号</th>
            <th>产品名称</th>
            <th style="width: 70px">数量</th>
            <th style="width: 84px">单价 USD</th>
            <th style="width: 96px">金额 USD</th>
            <th style="width: 96px">金额 CNY</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(it, i) in quote.items" :key="it.id">
            <td>{{ i + 1 }}</td>
            <td>{{ it.sku || '-' }}</td>
            <td>{{ it.product_name }}</td>
            <td class="num">{{ it.qty }}</td>
            <td class="num">{{ fmt(it.price_usd) }}</td>
            <td class="num">{{ fmt(it.amount_usd) }}</td>
            <td class="num">{{ fmt(it.amount_cny) }}</td>
          </tr>
          <tr v-if="!quote.items.length"><td colspan="7" class="num">无明细</td></tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3" class="qp-total-label">合计 TOTAL</td>
            <td class="num">{{ quote.total_qty }}</td>
            <td></td>
            <td class="num">{{ fmt(quote.total_usd) }}</td>
            <td class="num">{{ fmt(quote.total_amount) }}</td>
          </tr>
        </tfoot>
      </table>

      <div class="qp-words">
        合计金额（美元）：<strong>{{ upperUsd }}</strong>
        <span class="qp-rate">汇率：1 USD = {{ quote.rate }} CNY</span>
      </div>

      <div class="qp-note" v-if="quote.remark">
        <div class="qp-note-title">备注</div>
        <div>{{ quote.remark }}</div>
      </div>

      <div class="qp-terms">
        <div class="qp-note-title">报价说明</div>
        <ol>
          <li>本报价以美元计价，人民币金额按报价日汇率折算，仅作参考。</li>
          <li>报价有效期至 {{ quote.valid_until || '以确认时为准' }}，逾期需重新核价。</li>
          <li>以上单价基于所示数量区间；数量变化时价格按阶梯价重新核定。</li>
          <li>交期自收到订金及确认样起算。</li>
        </ol>
      </div>

      <div class="qp-sign">
        <div>
          <div class="qp-sign-line"></div>
          <div class="qp-sign-label">客户确认（签字 / 盖章）</div>
        </div>
        <div>
          <div class="qp-sign-line"></div>
          <div class="qp-sign-label">业务员 / 日期</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const quote = ref(null);

const fmt = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 美元金额转英文大写（简版，支持到百万级，用于单据规范） */
const upperUsd = computed(() => {
  const n = Number(quote.value && quote.value.total_usd) || 0;
  const ones = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
    'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
  const under1000 = (x) => {
    let s = '';
    if (x >= 100) { s += ones[Math.floor(x / 100)] + ' HUNDRED'; x %= 100; if (x) s += ' AND '; }
    if (x >= 20) { s += tens[Math.floor(x / 10)]; if (x % 10) s += '-' + ones[x % 10]; }
    else if (x > 0) s += ones[x];
    return s;
  };
  const int = Math.floor(n);
  const cents = Math.round((n - int) * 100);
  let rest = int;
  const parts = [];
  const millions = Math.floor(rest / 1000000); rest %= 1000000;
  const thousands = Math.floor(rest / 1000); rest %= 1000;
  if (millions) parts.push(under1000(millions) + ' MILLION');
  if (thousands) parts.push(under1000(thousands) + ' THOUSAND');
  if (rest) parts.push(under1000(rest));
  const words = parts.length ? parts.join(' ') : 'ZERO';
  return `SAY US DOLLARS ${words} AND ${String(cents).padStart(2, '0')}/100 ONLY`;
});

function doPrint() { window.print(); }
function back() { if (window.history.length > 1) router.back(); else router.push('/quotations'); }

onMounted(async () => {
  try {
    quote.value = await api.quotation(route.params.id);
  } catch (e) {
    alert(e.message);
  }
});
</script>

<style scoped>
.qp-page { min-height: 100vh; background: #eef1f5; padding: 20px; }
.qp-toolbar { max-width: 900px; margin: 0 auto 14px; display: flex; gap: 8px; align-items: center; }
.qp-tip { font-size: 12px; color: #6b7688; }
.qp-loading { text-align: center; padding: 60px; color: #8a94a6; }
.qp-sheet {
  max-width: 900px; margin: 0 auto; background: #fff; border-radius: 8px;
  padding: 40px 44px 48px; box-shadow: 0 4px 18px rgba(20, 30, 50, 0.1); color: #1b2430;
  font-size: 13px; line-height: 1.6;
}
.qp-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1b2430; padding-bottom: 14px; }
.qp-co { font-size: 19px; font-weight: 700; letter-spacing: 1px; }
.qp-co-en { font-size: 11px; color: #6b7688; letter-spacing: 0.6px; }
.qp-title { text-align: right; }
.qp-title h1 { margin: 0; font-size: 26px; letter-spacing: 6px; }
.qp-title-en { font-size: 11px; color: #6b7688; letter-spacing: 3px; }

.qp-meta { width: 100%; border-collapse: collapse; margin: 18px 0; }
.qp-meta th, .qp-meta td { border: 1px solid #d7dde6; padding: 7px 10px; text-align: left; }
.qp-meta th { width: 96px; background: #f6f8fa; font-weight: 600; color: #4a566a; }

.qp-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
.qp-table th, .qp-table td { border: 1px solid #d7dde6; padding: 7px 8px; }
.qp-table thead th { background: #f6f8fa; font-weight: 600; color: #4a566a; }
.qp-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.qp-table tfoot td { background: #f6f8fa; font-weight: 700; }
.qp-total-label { text-align: right; letter-spacing: 1px; }

.qp-words { margin: 6px 0 16px; font-size: 12px; color: #2b3648; }
.qp-rate { margin-left: 12px; color: #6b7688; }
.qp-note, .qp-terms { margin-bottom: 14px; }
.qp-note-title { font-weight: 700; margin-bottom: 4px; color: #2b3648; }
.qp-terms ol { margin: 0; padding-left: 18px; color: #4a566a; font-size: 12px; }

.qp-sign { display: flex; gap: 60px; margin-top: 44px; }
.qp-sign > div { flex: 1; }
.qp-sign-line { border-bottom: 1px solid #1b2430; height: 34px; }
.qp-sign-label { font-size: 12px; color: #6b7688; margin-top: 6px; }

@media print {
  .no-print { display: none !important; }
  .qp-page { background: #fff; padding: 0; }
  .qp-sheet { box-shadow: none; border-radius: 0; padding: 0; max-width: none; }
}
</style>
