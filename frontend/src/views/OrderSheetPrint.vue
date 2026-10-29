<template>
  <div class="osp">
    <div v-if="loading" class="osp-loading">加载中…</div>
    <div v-else-if="!sheet" class="osp-loading">没读到这张订单</div>

    <template v-else>
      <div class="osp-head">
        <div>
          <h1>订单信息表</h1>
          <div class="osp-sub">
            {{ sheet.order_no }}
            <span v-if="sheet.overdue" class="osp-od">超期</span>
            <span class="osp-print-time">打印于 {{ printedAt }}</span>
          </div>
        </div>
        <div class="osp-act">
          <button class="btn btn-ghost no-print" @click="goBack">返回</button>
          <button class="btn btn-primary no-print" @click="doPrint">打印</button>
        </div>
      </div>

      <!-- 按勾选渲染：只出选中的组与字段 -->
      <section v-for="g in groupsToShow" :key="g.key" class="osp-sec">
        <h2>{{ g.label }}</h2>
        <table class="osp-kv">
          <tbody>
            <tr v-for="(row, ri) in layoutRows(g.fields)" :key="ri">
              <!-- 长文本（面料 / 工艺 / 客户要求 / 备注）独占整行，
                   跟着两列配对走会在右边留两个空格子，像漏印了 -->
              <template v-if="row.wide">
                <th>{{ row.cell.label }}</th>
                <td colspan="3" class="wide">{{ row.cell.value || '' }}</td>
              </template>
              <template v-else>
                <template v-for="f in row.cells" :key="f.key">
                  <th>{{ f.label }}</th>
                  <td>{{ f.value || '' }}</td>
                </template>
                <template v-if="row.cells.length === 1">
                  <th></th><td></td>
                </template>
              </template>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 颜色尺码明细 -->
      <section v-if="showDetail && sheet.details.items.length" class="osp-sec">
        <h2>颜色尺码明细</h2>
        <table v-for="it in sheet.details.items" :key="it.id" class="osp-tbl">
          <thead>
            <tr><th colspan="4" class="osp-tbl-title">{{ it.product_name }}<span v-if="it.style_no"> · {{ it.style_no }}</span></th></tr>
            <tr><th>颜色</th><th>尺码</th><th>数量</th><th>单价(USD)</th></tr>
          </thead>
          <tbody>
            <tr v-for="(sz, i) in it.sizes" :key="i">
              <td>{{ sz.color || '' }}</td><td>{{ sz.size || '' }}</td>
              <td class="num">{{ sz.qty }}</td><td class="num">{{ sz.usd_price }}</td>
            </tr>
            <tr v-if="!it.sizes.length"><td colspan="4">没有颜色尺码明细</td></tr>
          </tbody>
        </table>
      </section>

      <!-- 面辅料清单 -->
      <section v-if="showMaterials && sheet.details.materials.length" class="osp-sec">
        <h2>面辅料清单</h2>
        <table class="osp-tbl">
          <thead><tr><th>类型</th><th>名称</th><th>规格 / 成分</th><th>颜色</th><th>单位</th><th>单件用量</th><th>损耗</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in sheet.details.materials" :key="i">
              <td>{{ m.type === 'accessory' ? '辅料' : '面料' }}</td>
              <td>{{ m.name || '' }}</td>
              <td>{{ [m.spec, m.composition].filter(Boolean).join(' / ') || '' }}</td>
              <td>{{ m.color || '' }}</td>
              <td>{{ m.unit || '' }}</td>
              <td class="num">{{ m.one_use }}</td>
              <td class="num">{{ m.loss_rate }}%</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="osp-foot">
        <span>签字：________________</span>
        <span>日期：________________</span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { fmtDate } from '../utils/time';

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const sheet = ref(null);

/**
 * 勾选的字段：`?fields=a,b,c`
 *
 * 没传就全打 —— 从地址栏直接打开时不该是一张空纸。
 * 这个参数由速览弹窗的「打印纸质订单」生成，字段清单也来自后端同一份定义。
 */
const picked = computed(() => {
  const raw = String(route.query.fields || '').trim();
  return raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : null;
});
const skipEmpty = computed(() => String(route.query.skip_empty || '') === '1');

const groupsToShow = computed(() => {
  if (!sheet.value) return [];
  return sheet.value.groups
    .filter((g) => g.fields.length)
    .map((g) => ({
      ...g,
      fields: g.fields.filter((f) => {
        if (picked.value && !picked.value.includes(f.key)) return false;
        // 「不打印空字段」：没填的整行不占位，纸面更紧凑
        if (skipEmpty.value && !f.value) return false;
        return true;
      })
    }))
    .filter((g) => g.fields.length);
});

/** 明细/清单这类表格类内容：勾了 detail 组或没指定字段时打印 */
const showDetail = computed(() => !picked.value || picked.value.includes('items'));
const showMaterials = computed(() => !picked.value || picked.value.includes('materials'));

const printedAt = fmtDate(new Date().toISOString());

/**
 * 排成表格行：普通字段两两并排，`wide` 字段独占一行
 *
 * 不能简单 `chunk(2)`：那样「订单备注」会跟一个空单元格配对，
 * 打印出来右边多两个空框，像漏印了内容。
 */
function layoutRows(fields) {
  const rows = [];
  let buf = [];
  const flush = () => { if (buf.length) { rows.push({ wide: false, cells: buf }); buf = []; } };
  fields.forEach((f) => {
    if (f.wide) {
      flush();
      rows.push({ wide: true, cell: f });
    } else {
      buf.push(f);
      if (buf.length === 2) flush();
    }
  });
  flush();
  return rows;
}

function doPrint() { window.print(); }
function goBack() { router.back(); }

onMounted(async () => {
  try {
    sheet.value = await api.orderSheet(route.params.id);
  } catch (e) {
    sheet.value = null;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.osp {
  max-width: 820px; margin: 0 auto; padding: 28px 30px 60px;
  background: #fff; color: #16233b; font-size: 13px; line-height: 1.6;
}
.osp-loading { padding: 80px 0; text-align: center; color: #98a2b3; }

.osp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 2px solid #16233b; padding-bottom: 10px; }
.osp-head h1 { margin: 0; font-size: 20px; letter-spacing: 1px; }
.osp-sub { font-size: 12.5px; color: #4a5a72; margin-top: 4px; }
.osp-od { color: #d92d45; font-weight: 700; margin-left: 6px; }
.osp-print-time { color: #98a2b3; margin-left: 10px; }
.osp-act { display: flex; gap: 8px; }

.osp-sec { margin-top: 16px; page-break-inside: avoid; }
.osp-sec h2 {
  font-size: 13px; margin: 0 0 6px; padding: 3px 8px;
  background: #f2f5fa; border-left: 3px solid #2563eb; color: #16233b;
}

.osp-kv { width: 100%; border-collapse: collapse; }
.osp-kv th, .osp-kv td {
  border: 1px solid #dfe5ee; padding: 4px 8px; font-size: 12.5px;
  text-align: left; vertical-align: top;
}
.osp-kv th { width: 88px; background: #fafbfd; color: #5b6b80; font-weight: 400; white-space: nowrap; }
.osp-kv td.wide { white-space: pre-wrap; }

.osp-tbl { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.osp-tbl th, .osp-tbl td { border: 1px solid #dfe5ee; padding: 4px 8px; font-size: 12px; }
.osp-tbl th { background: #fafbfd; color: #5b6b80; font-weight: 400; text-align: left; }
.osp-tbl-title { background: #f2f5fa !important; font-weight: 700 !important; color: #16233b !important; }
.num { text-align: right; font-variant-numeric: tabular-nums; }

.osp-foot {
  margin-top: 28px; padding-top: 10px; border-top: 1px dashed #c3cbd8;
  display: flex; justify-content: space-between; font-size: 12.5px; color: #4a5a72;
}

/* 打印时只留纸面：按钮、阴影、背景色都去掉 */
@media print {
  .no-print { display: none !important; }
  .osp { max-width: none; padding: 0; font-size: 12px; }
  .osp-sec h2 { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .osp-kv th, .osp-tbl th { background: #f6f7f9 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
