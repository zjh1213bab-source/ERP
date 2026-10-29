<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal pk-modal">
      <div class="modal-head">
        <h3>
          订单信息看板
          <span v-if="sheet" class="pk-no mono">{{ sheet.order_no }}</span>
          <span v-if="sheet && sheet.overdue" class="tag red" style="font-size: 10px">超期</span>
        </h3>
        <button class="x" @click="close">×</button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="pk-mut" style="padding: 40px 0; text-align: center">加载中…</div>

        <template v-else-if="sheet">
          <!-- 顶部：款图 + 一眼要看的几个数 -->
          <div class="pk-top">
            <div class="pk-pic" :class="{ empty: !picUrl }" @click="picUrl && openImage(picUrl, sheet.order_no)">
              <img v-if="picUrl" :src="picUrl" alt="款图" @error="picBroken = true" />
              <template v-else>
                <span class="pk-pic-ico">款图</span>
                <span class="pk-pic-tip">{{ picBroken ? '图片打不开（文件可能损坏）' : '订单与打版都还没上传' }}</span>
              </template>
            </div>
            <div class="pk-hero">
              <div class="pk-hero-name">{{ v('style_name') || '—' }}</div>
              <div class="pk-hero-line">
                <span class="tag" :class="statusTag(sheet.status_raw)">{{ v('status') }}</span>
                <span class="tag" :class="sheet.type_raw === 'stock' ? 'blue' : 'purple'" style="font-size: 10px">
                  {{ v('type') }}
                </span>
                <span v-if="sheet.techpack" class="tag gray" style="font-size: 10px">
                  打版 {{ sheet.techpack.version }}{{ sheet.techpack.status === 'confirmed' ? ' · 已确认' : ' · 未确认' }}
                </span>
                <span v-if="sheet.overdue" class="tag red" style="font-size: 10px">超期</span>
              </div>
              <div class="pk-hero-kv">
                <div><label>客户</label><b>{{ v('customer_name') || '—' }}</b></div>
                <div><label>客户订单号</label><b>{{ v('cus_order_no') || '—' }}</b></div>
                <div><label>交期</label><b :class="{ late: sheet.overdue }">{{ v('delivery_date') || '—' }}</b></div>
                <div><label>金额</label><b>{{ v('total_amount') || '—' }}<span class="pk-usd"> / {{ v('total_usd') || '—' }}</span></b></div>
              </div>
            </div>
          </div>

          <!-- 分组：下单信息 / 款式信息（打版）/ 物料与工艺（打版）/ 备注 / 工序 -->
          <div v-for="g in shownGroups" :key="g.key" class="pk-block">
            <div class="pk-sec">
              {{ g.label }}
              <span class="pk-sub">{{ g.fields.filter(f => f.value).length }}/{{ g.fields.length }} 有值</span>
              <span v-if="g.key === 'style' && !sheet.techpack" class="pk-sub">（这张单还没有技术资料）</span>
            </div>
            <div class="pk-grid">
              <div v-for="f in g.fields" :key="f.key" class="pk-cell" :class="{ wide: f.wide, blank: !f.value }">
                <label>{{ f.label }}</label>
                <span>{{ f.value || '—' }}</span>
              </div>
            </div>
          </div>

          <!-- 颜色尺码明细 -->
          <div v-if="sheet.details.items.length" class="pk-block">
            <div class="pk-sec">颜色尺码明细<span class="pk-sub">{{ sheet.details.items.length }} 款</span></div>
            <table v-for="it in sheet.details.items" :key="it.id" class="data pk-tbl" style="margin-bottom: 8px">
              <thead>
                <tr>
                  <th colspan="4" style="text-align: left">
                    {{ it.product_name }}<span v-if="it.style_no" class="pk-sub"> · {{ it.style_no }}</span>
                  </th>
                </tr>
                <tr><th>颜色</th><th>尺码</th><th>数量</th><th>单价(USD)</th></tr>
              </thead>
              <tbody>
                <tr v-for="(sz, i) in it.sizes" :key="i">
                  <td>{{ sz.color || '—' }}</td>
                  <td>{{ sz.size || '—' }}</td>
                  <td>{{ sz.qty }}</td>
                  <td>{{ sz.usd_price }}</td>
                </tr>
                <tr v-if="!it.sizes.length"><td colspan="4" class="pk-mut">没有颜色尺码明细</td></tr>
              </tbody>
            </table>
          </div>

          <!-- 面辅料清单 -->
          <div v-if="sheet.details.materials.length" class="pk-block">
            <div class="pk-sec">面辅料清单<span class="pk-sub">{{ sheet.details.materials.length }} 项</span></div>
            <table class="data pk-tbl">
              <thead><tr><th>类型</th><th>名称</th><th>规格 / 成分</th><th>颜色</th><th>单位</th><th>单件用量</th><th>损耗</th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in sheet.details.materials" :key="i">
                  <td>{{ m.type === 'accessory' ? '辅料' : '面料' }}</td>
                  <td>{{ m.name || '—' }}</td>
                  <td>{{ [m.spec, m.composition].filter(Boolean).join(' / ') || '—' }}</td>
                  <td>{{ m.color || '—' }}</td>
                  <td>{{ m.unit || '—' }}</td>
                  <td>{{ m.one_use }}</td>
                  <td>{{ m.loss_rate }}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 尺码规格表 -->
          <div v-if="sheet.details.sizes.length" class="pk-block">
            <div class="pk-sec">尺码规格<span class="pk-sub">{{ sheet.details.sizes.length }} 行</span></div>
            <table class="data pk-tbl">
              <thead>
                <tr><th>部位</th><th v-for="c in sizeCols" :key="c">{{ c }}</th><th>公差</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in sizeRows" :key="row.part">
                  <td>{{ row.part }}</td>
                  <td v-for="c in sizeCols" :key="c">{{ row.vals[c] || '—' }}</td>
                  <td>{{ row.tolerance || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <div v-else class="pk-mut" style="padding: 40px 0; text-align: center">没读到这张订单</div>
      </div>

      <div class="modal-foot">
        <button class="btn btn-ghost" @click="close">关闭</button>
        <button class="btn btn-ghost" @click="goOrder">到订单详情</button>
        <button class="btn btn-primary" :disabled="!sheet" @click="openPrint">打印纸质订单</button>
      </div>
    </div>

    <!-- 打印字段勾选 -->
    <div v-if="printDlg.open" class="modal-mask" @click.self="printDlg.open = false">
      <div class="modal" style="width: 560px">
        <div class="modal-head">
          <h3>选择要打印的信息</h3>
          <button class="x" @click="printDlg.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="pk-mut" style="margin-bottom: 10px">
            勾上的才会上纸。给车间的工艺单要物料与工艺，给客户的确认单不要工序 —— 按组勾最快。
          </div>
          <div v-for="g in printDlg.groups" :key="g.key" class="pr-grp">
            <label class="pr-grp-head">
              <input type="checkbox" :checked="isGroupAll(g)" @change="toggleGroup(g, $event.target.checked)" />
              <b>{{ g.label }}</b>
            </label>
            <div class="pr-fields">
              <label v-for="f in g.fields" :key="f.key" class="pr-field">
                <input type="checkbox" :value="f.key" v-model="printDlg.picked" />
                {{ f.label }}
              </label>
            </div>
          </div>
          <label class="pr-opt">
            <input type="checkbox" v-model="printDlg.skipEmpty" />
            不打印空字段（没填的项留白，不印「—」）
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="printDlg.open = false">取消</button>
          <button class="btn btn-primary" :disabled="!printDlg.picked.length" @click="doPrint">
            打印 {{ printDlg.picked.length }} 个字段
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { openImage } from '../store/viewer';

const props = defineProps({
  open: { type: Boolean, default: false },
  orderId: { type: [Number, String], default: null }
});
const emit = defineEmits(['update:open']);

const router = useRouter();
const loading = ref(false);
const sheet = ref(null);
const picBroken = ref(false);

function statusTag(s) {
  return {
    draft: 'gray', tech: 'blue', finance: 'orange', assigned: 'purple', production: 'blue',
    instock: 'green', shipped: 'green', closed: 'gray', cancelled: 'red'
  }[s] || 'gray';
}

/**
 * 从后端算好的 groups 里按字段 key 取值
 *
 * 屏幕不自己拼字段 —— 打印页吃的是同一份数据（`/api/orders/:id/sheet`），
 * 两边才不会出现「屏幕有、纸上没有」这种没人发现得了的偏差。
 */
const fieldMap = computed(() => {
  const m = {};
  if (!sheet.value) return m;
  sheet.value.groups.forEach((g) => g.fields.forEach((f) => { m[f.key] = f.value; }));
  return m;
});
function v(key) { return fieldMap.value[key] || ''; }

/** 明细表那组没有单值字段，单独渲染，不占一行表格 */
const shownGroups = computed(() => (sheet.value ? sheet.value.groups.filter((g) => g.fields.length) : []));

const picUrl = computed(() => {
  if (!sheet.value || picBroken.value) return '';
  return sheet.value.thumb || '';
});

/** 尺码表是「部位 × 码」的矩阵：先按部位聚合，再摊到各码 */
const sizeCols = computed(() => {
  const set = new Set();
  ((sheet.value && sheet.value.details.sizes) || []).forEach((s) => { if (s.size) set.add(s.size); });
  return [...set];
});
const sizeRows = computed(() => {
  const list = (sheet.value && sheet.value.details.sizes) || [];
  const map = new Map();
  list.forEach((s) => {
    const part = s.part || '—';
    if (!map.has(part)) map.set(part, { part, vals: {}, tolerance: s.tolerance || '' });
    const row = map.get(part);
    if (s.size) row.vals[s.size] = s.value;
    if (s.tolerance && !row.tolerance) row.tolerance = s.tolerance;
  });
  return [...map.values()];
});

async function load() {
  if (!props.orderId) return;
  loading.value = true;
  sheet.value = null;
  picBroken.value = false;
  try {
    sheet.value = await api.orderSheet(props.orderId);
  } catch (e) {
    sheet.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.orderId], ([open]) => { if (open) load(); });

function close() { emit('update:open', false); }
function goOrder() {
  if (!sheet.value) return;
  const id = sheet.value.order_id;
  close();
  router.push({ path: '/orders', query: { order: id } });
}

/* ---------------- 打印：先勾字段再上纸 ---------------- */
const printDlg = ref({ open: false, groups: [], picked: [], skipEmpty: false });

function openPrint() {
  if (!sheet.value) return;
  const groups = shownGroups.value.map((g) => ({
    key: g.key, label: g.label,
    fields: g.fields.map((f) => ({ key: f.key, label: f.label }))
  }));
  printDlg.value = {
    open: true,
    groups,
    // 默认全勾：多数时候就是要整张纸，去掉几项比一项项加快
    picked: groups.flatMap((g) => g.fields.map((f) => f.key)),
    skipEmpty: false
  };
}
function isGroupAll(g) {
  return g.fields.every((f) => printDlg.value.picked.includes(f.key));
}
function toggleGroup(g, on) {
  const keys = g.fields.map((f) => f.key);
  const cur = printDlg.value.picked.filter((k) => !keys.includes(k));
  printDlg.value.picked = on ? [...cur, ...keys] : cur;
}
function doPrint() {
  const q = new URLSearchParams();
  q.set('fields', printDlg.value.picked.join(','));
  if (printDlg.value.skipEmpty) q.set('skip_empty', '1');
  const id = sheet.value.order_id;
  printDlg.value.open = false;
  window.open(`/print/order-sheet/${id}?${q.toString()}`, '_blank');
}
</script>

<style scoped>
.pk-modal { width: 900px; max-width: 96vw; }
.pk-mut { font-size: 12.5px; color: #8a94a6; line-height: 1.8; }
.pk-no { font-size: 13px; color: #2563eb; margin-left: 6px; }

.pk-top { display: flex; gap: 14px; margin-bottom: 4px; }
.pk-pic {
  width: 120px; height: 120px; flex: none; border-radius: 10px; overflow: hidden;
  background: #f4f6fa; border: 1px solid #e6ecf5; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.pk-pic img { width: 100%; height: 100%; object-fit: cover; }
.pk-pic.empty { cursor: default; flex-direction: column; gap: 4px; }
.pk-pic-ico { font-size: 12px; color: #b6bfcc; font-weight: 700; }
.pk-pic-tip { font-size: 10px; color: #c3cbd8; text-align: center; padding: 0 8px; line-height: 1.4; }

.pk-hero { flex: 1; min-width: 0; }
.pk-hero-name { font-size: 15px; font-weight: 700; color: #16233b; }
.pk-hero-line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0 9px; }
.pk-hero-kv { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 5px 10px; font-size: 12.5px; align-items: baseline; }
.pk-hero-kv > div { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.pk-hero-kv label { color: #8a94a6; white-space: nowrap; }
.pk-hero-kv b { color: #16233b; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk-usd { color: #98a2b3; font-weight: 400; }
.late { color: #d92d45 !important; }

.pk-block { border-top: 1px solid #eef2f7; padding-top: 11px; margin-top: 12px; }
.pk-sec {
  font-size: 13px; font-weight: 700; color: #16233b; margin-bottom: 8px;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.pk-sub { font-size: 11.5px; font-weight: 400; color: #8a94a6; }

/* 字段网格：两列，长文本（面料/工艺/客户要求）占整行 */
.pk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
.pk-cell { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; min-width: 0; }
.pk-cell.wide { grid-column: 1 / -1; }
.pk-cell label { color: #8a94a6; min-width: 84px; flex: none; }
.pk-cell span { color: #16233b; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.pk-cell.blank span { color: #c3cbd8; }

.pk-tbl { width: 100%; }
.pk-tbl th { font-size: 11px; }
.pk-tbl td { font-size: 11.5px; padding: 6px 10px !important; }

/* 打印勾选 */
.pr-grp { border: 1px solid #eef2f7; border-radius: 8px; padding: 9px 11px; margin-bottom: 8px; }
.pr-grp-head { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: #16233b; cursor: pointer; }
.pr-fields { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 7px; padding-left: 22px; }
.pr-field { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #4a5a72; cursor: pointer; }
.pr-opt { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: #33425c; margin-top: 6px; }
</style>
