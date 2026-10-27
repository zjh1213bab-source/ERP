<template>
  <div class="lb-wrap">
    <div class="no-print lb-toolbar">
      <button class="btn btn-primary btn-sm" @click="doPrint">打印标签</button>
      <button class="btn btn-ghost btn-sm" @click="back">返回</button>
      <span class="lb-tip">每行 2 张，A4；条码为 Code128（订单-款号-色-码）</span>
    </div>

    <div v-if="!order" class="lb-loading">加载中…</div>

    <div v-else class="lb-sheet">
      <div class="lb-title no-print" style="margin-bottom: 8px">
        {{ order.order_no }} · {{ order.style_name || '' }} · 共 {{ labels.length }} 种色码
      </div>

      <div class="lb-grid">
        <div v-for="(l, i) in labels" :key="i" class="lb-label">
          <div class="lb-row1">
            <span class="lb-order">{{ order.order_no }}</span>
            <span class="lb-qty">×{{ l.qty }}</span>
          </div>
          <div class="lb-row2">{{ l.style_no || order.style_no || '-' }}</div>
          <div class="lb-row3">
            <span class="lb-color">{{ l.color || '均色' }}</span>
            <span class="lb-size">{{ l.size }}</span>
          </div>
          <svg class="lb-barcode" :data-code="l.code"></svg>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import JsBarcode from 'jsbarcode';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const order = ref(null);

const labels = computed(() => {
  if (!order.value) return [];
  const out = [];
  (order.value.items || []).forEach((it) => {
    (it.sizes || []).forEach((s) => {
      const ascii = (v) => String(v || '').replace(/[^\x20-\x7E]/g, '').trim();
      const code = [ascii(order.value.order_no), ascii(it.style_no), ascii(s.color), ascii(s.size)].filter(Boolean).join('-');
      out.push({ style_no: it.style_no, color: s.color, size: s.size, qty: s.qty, code: code || ascii(order.value.order_no) });
    });
  });
  return out;
});

function back() { router.back(); }
function doPrint() { window.print(); }

function renderBarcodes() {
  const nodes = document.querySelectorAll('.lb-barcode');
  nodes.forEach((el) => {
    const code = el.getAttribute('data-code') || '';
    try {
      JsBarcode(el, code, { format: 'CODE128', displayValue: false, height: 40, margin: 0 });
    } catch (e) { /* ignore */ }
  });
}

onMounted(async () => {
  try {
    order.value = await api.order(route.params.id);
    await nextTick();
    renderBarcodes();
  } catch (e) { alert(e.message); }
});
</script>

<style>
.lb-wrap { max-width: 900px; margin: 0 auto; padding: 14px; background: #f2f5fa; min-height: 100vh; }
.lb-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
.lb-tip { font-size: 12px; color: #8a94a6; }
.lb-loading { padding: 40px; text-align: center; color: #8a94a6; }

.lb-sheet { background: #fff; padding: 14px; border-radius: 6px; box-shadow: 0 2px 12px rgba(16, 32, 64, 0.08); }

.lb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lb-label {
  border: 1px dashed #9aa4b5; border-radius: 4px; padding: 8px 10px;
  height: 118px; box-sizing: border-box; display: flex; flex-direction: column;
}
.lb-row1 { display: flex; justify-content: space-between; font-size: 11px; color: #33415a; }
.lb-order { font-weight: 700; }
.lb-qty { font-weight: 700; }
.lb-row2 { font-size: 15px; font-weight: 800; margin-top: 2px; color: #111; }
.lb-row3 { display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px; }
.lb-barcode { width: 100%; height: 44px; margin-top: auto; }

@media print {
  @page { size: A4; margin: 10mm; }
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .lb-wrap { background: #fff; padding: 0; max-width: none; min-height: auto; }
  .lb-sheet { box-shadow: none; padding: 0; border-radius: 0; }
  .lb-label { break-inside: avoid; page-break-inside: avoid; }
}
</style>
