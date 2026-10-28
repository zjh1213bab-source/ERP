<template>
  <div class="lb-wrap">
    <!-- 工具栏 -->
    <div class="no-print lb-toolbar">
      <button class="btn btn-primary btn-sm" @click="doPrint">打印</button>
      <button class="btn btn-ghost btn-sm" @click="back">返回</button>

      <div class="lb-seg">
        <button :class="{ on: mode === 'bundle' }" :disabled="!bundles.length" @click="setMode('bundle')">
          扎标 <span class="lb-n">{{ bundles.length }}</span>
        </button>
        <button :class="{ on: mode === 'sku' }" @click="setMode('sku')">
          款色码标 <span class="lb-n">{{ skuLabels.length }}</span>
        </button>
      </div>

      <select v-if="mode === 'bundle'" v-model="size" class="lb-sel">
        <option value="big">大（6 张/页）</option>
        <option value="mid">中（12 张/页）</option>
        <option value="small">小（24 张/页）</option>
      </select>

      <template v-if="mode === 'bundle' && bundles.length">
        <span class="lb-tip">扎号范围</span>
        <input v-model="fromNo" class="lb-inp" placeholder="起始" />
        <span class="lb-tip">~</span>
        <input v-model="toNo" class="lb-inp" placeholder="截止" />
        <button class="btn btn-ghost btn-sm" @click="clearRange">全部</button>
      </template>
    </div>

    <div v-if="!order" class="lb-loading no-print">加载中…</div>

    <template v-else>
      <div class="no-print lb-head">
        <b>{{ order.order_no }}</b>
        <span>{{ order.style_name || '' }}</span>
        <span v-if="mode === 'bundle'">· 共 {{ shown.length }} 扎 / {{ shownQty }} 件</span>
        <span v-else>· 共 {{ skuLabels.length }} 种色码</span>
      </div>

      <div v-if="mode === 'bundle' && !bundles.length" class="no-print lb-empty">
        这单还没有裁床扎包。扎标按扎打印，先去「生产 → 裁床与扎包」把扎分出来。
      </div>
      <div v-if="mode === 'bundle' && size === 'small'" class="no-print lb-warn">
        小档 24 张/页时二维码只有约 14mm，手机不好扫。扎标建议用「中」或「大」。
      </div>

      <!-- 每页固定张数，打印时一页一张纸 -->
      <div v-for="(page, pi) in pages" :key="pi" class="lb-sheet" :class="'s-' + size">
        <div class="lb-grid" :class="mode === 'sku' ? 'g-sku' : 'g-' + size">
          <!-- ============ 扎标 ============ -->
          <template v-if="mode === 'bundle'">
            <div v-for="b in page" :key="b.id" class="lb-label lb-bundle">
              <div class="lb-b-top">
                <span class="lb-b-no">{{ b.bundle_no }}</span>
                <span class="lb-b-qty">×{{ b.qty }}</span>
              </div>
              <div class="lb-b-mid">
                <img v-if="b.qr" class="lb-b-qr" :src="b.qr" alt="" />
                <div class="lb-b-info">
                  <div class="lb-b-order">{{ order.order_no }}</div>
                  <div class="lb-b-style">{{ b.style_no || order.style_name || '-' }}</div>
                  <div class="lb-b-cs">
                    <span class="lb-b-color">{{ b.color || '均色' }}</span>
                    <span class="lb-b-size">{{ b.size }}</span>
                  </div>
                  <div class="lb-b-lot">
                    {{ b.dye_lot || b.bed_no ? [b.dye_lot, b.bed_no].filter(Boolean).join(' · ') : '无缸号记录' }}
                  </div>
                </div>
              </div>
              <div class="lb-b-foot">
                <span class="lb-b-co">跳色科技</span>
                <span v-if="b.mixed_dye_lot" class="lb-b-flag warn">混缸</span>
                <span v-if="b.checked" class="lb-b-flag ok">已复核</span>
                <span class="lb-b-date">{{ today }}</span>
              </div>
            </div>
          </template>

          <!-- ============ 款色码标（原样式，Code128） ============ -->
          <template v-else>
            <div v-for="(l, i) in page" :key="'s' + i" class="lb-label lb-sku">
              <div class="lb-row1">
                <span class="lb-order">{{ order.order_no }}</span>
                <span class="lb-qty">×{{ l.qty }}</span>
              </div>
              <div class="lb-row2">{{ l.style_no || order.style_name || '-' }}</div>
              <div class="lb-row3">
                <span class="lb-color">{{ l.color || '均色' }}</span>
                <span class="lb-size">{{ l.size }}</span>
              </div>
              <svg class="lb-barcode" :data-code="l.code"></svg>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import JsBarcode from 'jsbarcode';
import { api } from '../api';
import { qrDataUrl, scanUrl, lanBase } from '../utils/qr';

const route = useRoute();
const router = useRouter();

const PER_PAGE = { big: 6, mid: 12, small: 24 };

const order = ref(null);
const bundles = ref([]);
const mode = ref(route.query.mode === 'sku' ? 'sku' : 'bundle');
const size = ref(route.query.size || 'mid');
const fromNo = ref('');
const toNo = ref('');
const today = new Date().toLocaleDateString('zh-CN');

/** 款色码标（保持原口径：订单-款号-色-码，Code128） */
const skuLabels = computed(() => {
  if (!order.value) return [];
  const out = [];
  (order.value.items || []).forEach((it) => {
    (it.sizes || []).forEach((s) => {
      const ascii = (v) => String(v || '').replace(/[^\x20-\x7E]/g, '').trim();
      const code = [ascii(order.value.order_no), ascii(it.style_no), ascii(s.color), ascii(s.size)]
        .filter(Boolean)
        .join('-');
      out.push({
        style_no: it.style_no,
        color: s.color,
        size: s.size,
        qty: s.qty,
        code: code || ascii(order.value.order_no)
      });
    });
  });
  return out;
});

/** 扎号范围筛选：补打用（机器卡纸，只要补 8~14 扎） */
const shown = computed(() => {
  let list = bundles.value;
  if (fromNo.value) list = list.filter((b) => b.bundle_no >= fromNo.value);
  if (toNo.value) list = list.filter((b) => b.bundle_no <= toNo.value);
  return list;
});
const shownQty = computed(() => shown.value.reduce((a, b) => a + (Number(b.qty) || 0), 0));

const currentList = computed(() => (mode.value === 'bundle' ? shown.value : skuLabels.value));

const SKU_PER_PAGE = 8; // 款色码标固定 2 列 × 4 行

const pages = computed(() => {
  const n = mode.value === 'sku' ? SKU_PER_PAGE : PER_PAGE[size.value] || 12;
  const list = currentList.value;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
});

async function renderQrs() {
  if (!bundles.value.length) return;
  // 二维码内容「订单号-扎号」纯 ASCII；地址用局域网 IP，手机扫了才打得开
  const base = await lanBase(api);
  for (const b of bundles.value) {
    if (b.qr) continue;
    b.qr = await qrDataUrl(scanUrl(b.code, base), 320);
  }
}

function renderBarcodes() {
  document.querySelectorAll('.lb-barcode').forEach((el) => {
    if (el.dataset.done) return;
    const code = el.getAttribute('data-code') || '';
    try {
      JsBarcode(el, code, { format: 'CODE128', displayValue: false, height: 40, margin: 0 });
      el.dataset.done = '1';
    } catch (e) { /* 条码画不出来不影响标签其余内容 */ }
  });
}

function setMode(m) {
  mode.value = m;
  nextTick(() => (m === 'sku' ? renderBarcodes() : renderQrs()));
}
function clearRange() {
  fromNo.value = '';
  toNo.value = '';
}
function back() { router.back(); }
function doPrint() { window.print(); }

watch(size, () => nextTick(() => { if (mode.value === 'sku') renderBarcodes(); }));

onMounted(async () => {
  try {
    order.value = await api.order(route.params.id);
    // 扎的缸号/床次/复核状态不在订单详情里，单独取
    const r = await api.labelBundles(route.params.id).catch(() => null);
    if (r && Array.isArray(r.bundles) && r.bundles.length) {
      bundles.value = r.bundles.map((b) => ({ ...b, qr: '' }));
    } else {
      mode.value = 'sku';
    }
    await nextTick();
    if (mode.value === 'bundle') await renderQrs();
    else renderBarcodes();
  } catch (e) {
    alert(e.message);
  }
});
</script>

<style>
.lb-wrap { max-width: 960px; margin: 0 auto; padding: 14px; background: #f2f5fa; min-height: 100vh; }
.lb-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.lb-tip { font-size: 12px; color: #8a94a6; }
.lb-loading { padding: 40px; text-align: center; color: #8a94a6; }
.lb-head { font-size: 13px; color: #33415a; margin-bottom: 10px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.lb-head b { font-size: 14px; }
.lb-empty, .lb-warn {
  font-size: 12.5px; padding: 9px 12px; border-radius: 8px; margin-bottom: 10px; line-height: 1.7;
}
.lb-empty { background: #fffbf0; border: 1px solid #f0e0bb; color: #8a5a12; }
.lb-warn { background: #f2f7ff; border: 1px solid #dbe8ff; color: #2b5aa7; }

.lb-seg { display: inline-flex; border: 1px solid #d9e1ee; border-radius: 9px; overflow: hidden; }
.lb-seg button {
  border: none; background: #fff; color: #4a5769; font-size: 12.5px; padding: 7px 13px; cursor: pointer;
}
.lb-seg button + button { border-left: 1px solid #e6ebf3; }
.lb-seg button.on { background: #2563eb; color: #fff; font-weight: 700; }
.lb-seg button:disabled { color: #b9c2d0; cursor: not-allowed; }
.lb-n { font-size: 11px; opacity: 0.75; }
.lb-sel { border: 1px solid #d9e1ee; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; background: #fff; }
.lb-inp { border: 1px solid #d9e1ee; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; width: 96px; }

/* A4 纸张（尺寸用 mm，打印才准） */
.lb-sheet {
  width: 194mm; margin: 0 auto 14px; background: #fff; padding: 4mm;
  box-shadow: 0 2px 12px rgba(16, 32, 64, 0.08); border-radius: 4px; box-sizing: border-box;
}
.lb-grid { display: grid; gap: 3mm; }
.g-big { grid-template-columns: repeat(2, 1fr); }
.g-mid { grid-template-columns: repeat(3, 1fr); }
.g-small { grid-template-columns: repeat(4, 1fr); }
.g-sku { grid-template-columns: repeat(2, 1fr); }

.lb-label {
  border: 1px dashed #9aa4b5; border-radius: 3px; box-sizing: border-box;
  padding: 2mm; display: flex; flex-direction: column; overflow: hidden; background: #fff;
}

/* ---------- 扎标 ---------- */
.s-big .lb-bundle { height: 88mm; }
.s-mid .lb-bundle { height: 62mm; }
.s-small .lb-bundle { height: 43mm; }

.lb-b-top {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px solid #e6ebf3; padding-bottom: 1mm;
}
.lb-b-no { font-size: 15px; font-weight: 800; letter-spacing: 0.5px; color: #16233b; font-family: Consolas, Menlo, monospace; }
.s-big .lb-b-no { font-size: 22px; }
.s-small .lb-b-no { font-size: 11px; }
.lb-b-qty { font-size: 13px; font-weight: 800; color: #d92d45; }
.s-big .lb-b-qty { font-size: 18px; }
.s-small .lb-b-qty { font-size: 10px; }

.lb-b-mid { display: flex; gap: 2.5mm; align-items: center; justify-content: center; flex: 1; min-height: 0; padding: 1.5mm 0; }
.lb-b-qr { flex: none; width: 22mm; height: 22mm; display: block; }
.s-big .lb-b-qr { width: 42mm; height: 42mm; }
.s-mid .lb-b-qr { width: 30mm; height: 30mm; }
.s-small .lb-b-qr { width: 15mm; height: 15mm; }

.lb-b-info { min-width: 0; flex: 1; line-height: 1.35; }
.lb-b-order { font-size: 10px; color: #5b6474; font-family: Consolas, Menlo, monospace; }
/* 款号一行放不下就折两行：款号是核对的关键，截成「kr-tz-001 女…」等于没用 */
.lb-b-style {
  font-size: 11px; font-weight: 700; color: #1f2a3d; line-height: 1.25;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.lb-b-cs { display: flex; gap: 4px; align-items: baseline; margin-top: 0.5mm; }
.lb-b-color { font-size: 11px; color: #33415a; }
.lb-b-size { font-size: 15px; font-weight: 800; color: #16233b; }
.s-big .lb-b-order { font-size: 12px; }
.s-big .lb-b-style { font-size: 16px; }
.s-big .lb-b-color { font-size: 14px; }
.s-big .lb-b-size { font-size: 24px; }
.s-big .lb-b-lot { font-size: 11px; }
.s-big .lb-b-co, .s-big .lb-b-date { font-size: 10px; }
.s-mid .lb-b-order { font-size: 9px; }
.s-mid .lb-b-style { font-size: 12.5px; }
.s-mid .lb-b-size { font-size: 18px; }
.s-small .lb-b-order { font-size: 7px; }
.s-small .lb-b-style { font-size: 8px; }
.s-small .lb-b-color { font-size: 8px; }
.s-small .lb-b-size { font-size: 11px; }
.lb-b-lot { font-size: 9px; color: #8a94a6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.lb-b-foot {
  display: flex; align-items: center; gap: 4px; border-top: 1px solid #e6ebf3; padding-top: 1mm;
  font-size: 8.5px; color: #8a94a6;
}
.lb-b-co { font-weight: 700; color: #5b6474; }
.lb-b-date { margin-left: auto; }
.lb-b-flag { font-size: 8px; padding: 0 4px; border-radius: 8px; font-weight: 700; }
.lb-b-flag.ok { background: #eefaf2; color: #16a34a; border: 1px solid #cfe8d8; }
.lb-b-flag.warn { background: #fffbf0; color: #b45309; border: 1px solid #f0e0bb; }

/* ---------- 款色码标（原样式） ---------- */
.lb-sku { height: 30mm; justify-content: space-between; }
.lb-row1 { display: flex; justify-content: space-between; align-items: baseline; }
.lb-order { font-size: 11px; font-family: Consolas, Menlo, monospace; color: #33415a; font-weight: 700; }
.lb-qty { font-size: 12px; font-weight: 800; color: #16233b; }
.lb-row2 { font-size: 11px; font-weight: 700; color: #1f2a3d; margin-top: 1mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-row3 { display: flex; justify-content: space-between; align-items: baseline; margin-top: 1mm; }
.lb-color { font-size: 10.5px; color: #4a5769; }
.lb-size { font-size: 14px; font-weight: 800; color: #16233b; }
.lb-barcode { display: block; width: 100%; height: 12mm; margin-top: auto; }

/* ---------- 打印 ---------- */
@media print {
  @page { size: A4; margin: 8mm; }
  .no-print { display: none !important; }
  .lb-wrap { background: #fff; padding: 0; max-width: none; min-height: auto; }
  .lb-sheet {
    width: 194mm; margin: 0; padding: 0; box-shadow: none; border-radius: 0;
    page-break-after: always; break-after: page;
  }
  .lb-sheet:last-child { page-break-after: auto; break-after: auto; }
}
</style>
