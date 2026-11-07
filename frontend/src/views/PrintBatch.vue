<template>
  <div class="pb-wrap">
    <div class="no-print pb-bar">
      <b>批量打印</b>
      <select v-model="type" class="pb-sel" @change="reload">
        <option value="production">生产工单</option>
        <option value="packing">装箱单</option>
        <option value="shipping">发货单</option>
      </select>
      <input v-model="idsText" class="pb-input" placeholder="订单 ID，逗号分隔，如 12,13,14" />
      <button class="btn btn-primary btn-sm" @click="reload">加载</button>
      <button class="btn btn-ghost btn-sm" @click="doPrint">打印全部</button>
      <span class="pb-tip">
        共 {{ sheets.length }} 张<template v-if="failed.length">，{{ failed.length }} 张没取到</template>
      </span>
    </div>

    <div v-if="loading" class="pb-loading">加载中…</div>
    <div v-else-if="!sheets.length" class="pb-loading">
      没有可打印的单据。在上面的输入框里填订单 ID（在订单列表的链接里能看到，最后一串数字）。
    </div>

    <div v-for="(sh, si) in sheets" :key="si" class="pb-sheet">
      <div class="pb-head">
        <div class="pb-co">跳色科技有限公司</div>
        <h1>{{ title }}</h1>
        <div class="pb-meta">
          <span>单号：{{ sh.order.order_no }}</span>
          <span v-if="sh.tp">开发单：{{ sh.tp.version }}</span>
          <span>打印日期：{{ today }}</span>
        </div>
        <svg class="pb-barcode" :data-code="sh.order.order_no"></svg>
      </div>

      <table class="pb-info">
        <tbody>
          <tr>
            <th>客户</th><td>{{ sh.order.customer_name || '-' }}</td>
            <th>款名</th><td>{{ sh.order.style_name || '-' }}</td>
          </tr>
          <tr>
            <th>客户订单号</th><td>{{ sh.order.cus_order_no || '-' }}</td>
            <th>跟单员</th><td>{{ sh.order.manager || '-' }}</td>
          </tr>
          <tr>
            <th>下单日期</th><td>{{ sh.order.order_date || '-' }}</td>
            <th>交期</th><td>{{ sh.order.delivery_date || '-' }}</td>
          </tr>
        </tbody>
      </table>

      <table class="pb-table">
        <thead>
          <tr>
            <th style="width: 34px">序号</th>
            <th>款号</th>
            <th>品名</th>
            <th style="width: 70px">颜色</th>
            <th style="width: 56px">尺码</th>
            <th style="width: 56px">数量</th>
            <th v-if="type === 'packing'" style="width: 54px">箱号</th>
            <th v-if="type === 'packing'" style="width: 58px">毛重</th>
            <th v-if="type === 'packing'" style="width: 58px">净重</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in sh.lines" :key="i">
            <td>{{ i + 1 }}</td>
            <td>{{ l.style_no || '-' }}</td>
            <td>{{ l.product_name }}</td>
            <td>{{ l.color || '-' }}</td>
            <td>{{ l.size || '-' }}</td>
            <td class="num">{{ l.qty }}</td>
            <td v-if="type === 'packing'"></td>
            <td v-if="type === 'packing'"></td>
            <td v-if="type === 'packing'"></td>
          </tr>
          <tr class="pb-total">
            <td colspan="5">合计</td>
            <td class="num">{{ sh.qty }}</td>
            <td v-if="type === 'packing'" colspan="3"></td>
          </tr>
        </tbody>
      </table>

      <!-- 生产工单：工序（批量版精简，完整版请单张打印） -->
      <template v-if="type === 'production' && sh.nodes.length">
        <h2 class="pb-sec">生产工序</h2>
        <table class="pb-table">
          <thead>
            <tr>
              <th style="width: 34px">序号</th>
              <th>工序</th>
              <th style="width: 84px">计划完成</th>
              <th style="width: 74px">责任人</th>
              <th style="width: 70px">状态</th>
              <th style="width: 80px">系统报工</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(n, i) in sh.nodes" :key="n.id">
              <td>{{ i + 1 }}</td>
              <td>{{ n.name }}</td>
              <td>{{ n.plan_date || '' }}</td>
              <td>{{ n.operator || '' }}</td>
              <td>{{ { pending: '待开始', doing: '进行中', done: '已完成' }[n.status] || n.status }}</td>
              <td class="num">{{ sh.report ? sh.report[n.id] || '' : '' }}</td>
            </tr>
          </tbody>
        </table>
        <p class="pb-note">本页为批量简版：工艺明细、面辅料、裁床扎包、现场报工栏请用单张打印（订单详情 → 打印）。</p>
      </template>

      <div class="pb-sign">
        <template v-if="type === 'production'">
          <div>制单：________</div><div>审核：________</div><div>车间接收：________</div><div>日期：________</div>
        </template>
        <template v-else-if="type === 'packing'">
          <div>装箱人：________</div><div>复核人：________</div><div>日期：________</div>
        </template>
        <template v-else>
          <div>发货人：________</div><div>承运人：________</div><div>客户签收：________</div><div>日期：________</div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import JsBarcode from 'jsbarcode';
import { api } from '../api';

const route = useRoute();

const TITLES = { production: '生产工单', packing: '装箱单', shipping: '发货单' };

const type = ref(route.query.type ? String(route.query.type) : 'production');
const title = computed(() => TITLES[type.value] || '单据');
const idsText = ref(route.query.ids ? String(route.query.ids) : '');
const sheets = ref([]);
const failed = ref([]);
const loading = ref(false);
const today = new Date().toLocaleDateString('zh-CN');

function parseIds() {
  return String(idsText.value || '')
    .split(/[,，\s]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
}

async function reload() {
  const ids = parseIds();
  if (!ids.length) {
    sheets.value = [];
    failed.value = [];
    return;
  }
  loading.value = true;
  sheets.value = [];
  failed.value = [];
  try {
    // 一张一张取：某张权限不足/已删除不该拖垮整批
    for (const id of ids) {
      try {
        const order = await api.order(id);
        const lines = [];
        (order.items || []).forEach((it) => {
          (it.sizes || []).forEach((s) => {
            lines.push({ style_no: it.style_no, product_name: it.product_name, color: s.color, size: s.size, qty: s.qty });
          });
        });
        const qty = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
        const sh = { order, lines, qty, nodes: [], report: {}, tp: null };

        if (type.value === 'production') {
          const [nd, rep, cur] = await Promise.all([
            api.orderNodes(id).catch(() => []),
            api.reportSummary(id).catch(() => []),
            api.techpackCurrent(id).catch(() => null)
          ]);
          sh.nodes = nd || [];
          sh.tp = cur || null;
          const m = {};
          (Array.isArray(rep) ? rep : []).forEach((r) => {
            if (r.node_id) m[r.node_id] = Number(r.defect) ? `${r.ok}/不良${r.defect}` : String(r.ok || 0);
          });
          sh.report = m;
        }
        sheets.value.push(sh);
      } catch (e) {
        failed.value.push(id);
      }
    }
    await nextTick();
    renderBarcodes();
  } finally {
    loading.value = false;
  }
}

function renderBarcodes() {
  document.querySelectorAll('.pb-barcode').forEach((el, i) => {
    const sh = sheets.value[i];
    if (!sh) return;
    const code = String(sh.order.order_no || '').replace(/[^\x20-\x7E]/g, '').trim();
    if (!code) return;
    try {
      JsBarcode(el, code, { format: 'CODE128', height: 34, width: 1.1, fontSize: 11, margin: 0, displayValue: true });
    } catch (e) { /* 忽略 */ }
  });
}

function doPrint() {
  window.print();
}

onMounted(reload);
</script>

<style>
.pb-wrap { max-width: 960px; margin: 0 auto; padding: 14px; background: var(--bg); min-height: 100vh; }
.pb-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.pb-sel, .pb-input { border: 1px solid #d9e1ee; border-radius: 8px; padding: 6px 10px; font-size: 13px; background: var(--surface); }
.pb-input { min-width: 280px; }
.pb-tip { font-size: 12px; color: var(--ink-mute); }
.pb-loading { padding: 40px; text-align: center; color: var(--ink-mute); }

.pb-sheet {
  background: var(--surface); padding: 22px 26px; border-radius: 6px; margin-bottom: 16px;
  box-shadow: 0 2px 12px rgba(16, 32, 64, 0.08); color: var(--ink);
  font-size: 12.5px; line-height: 1.5;
}
.pb-head { text-align: center; border-bottom: 2px solid #1f2937; padding-bottom: 10px; margin-bottom: 12px; }
.pb-co { font-size: 13px; letter-spacing: 2px; color: var(--ink); }
.pb-head h1 { margin: 6px 0; font-size: 21px; letter-spacing: 4px; }
.pb-meta { display: flex; justify-content: space-between; font-size: 12px; color: #5b6474; }
.pb-barcode { display: block; margin: 8px auto 0; max-width: 240px; }

.pb-info { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
.pb-info th, .pb-info td { border: 1px solid #c9d2e0; padding: 6px 8px; font-size: 12px; }
.pb-info th { background: var(--bg); width: 92px; text-align: left; font-weight: 600; color: var(--ink); }

.pb-table { width: 100%; border-collapse: collapse; }
.pb-table th, .pb-table td { border: 1px solid #c9d2e0; padding: 5px 7px; font-size: 12px; }
.pb-table th { background: var(--bg); font-weight: 600; color: var(--ink); }
.pb-table .num { text-align: right; }
.pb-total td { font-weight: 700; background: #fafbfd; }

.pb-sec { font-size: 13px; margin: 14px 0 6px; padding-left: 8px; border-left: 3px solid #2b6de5; }
.pb-note { font-size: 12px; color: var(--ink-mute); margin: 6px 0 0; }
.pb-sign { display: flex; justify-content: space-between; gap: 10px; margin-top: 24px; padding-top: 10px; font-size: 12.5px; color: var(--ink); flex-wrap: wrap; }

@media print {
  @page { size: A4; margin: 12mm; }
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .pb-wrap { background: #fff; padding: 0; max-width: none; min-height: auto; }
  .pb-sheet {
    box-shadow: none; border-radius: 0; padding: 0 0 10mm; margin: 0;
    page-break-after: always;
  }
  .pb-sheet:last-child { page-break-after: auto; }
  .pb-table thead { display: table-header-group; }
  .pb-table tr { page-break-inside: avoid; }
  .pb-sec { page-break-after: avoid; }
  .pb-sheet { font-size: 11.5px; }
}
</style>
