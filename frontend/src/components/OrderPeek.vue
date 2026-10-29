<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal pk-modal">
      <div class="modal-head">
        <h3>订单速览 · {{ order ? order.order_no : '' }}</h3>
        <button class="x" @click="close">×</button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="pk-mut" style="padding: 30px 0; text-align: center">加载中…</div>

        <template v-else-if="order">
          <!-- ---------- 顶部：款图 + 基本信息 ---------- -->
          <div class="pk-top">
            <div class="pk-pic" :class="{ empty: !picUrl }" @click="picUrl && openImage(picUrl, order.order_no)">
              <img v-if="picUrl" :src="picUrl" alt="款图" @error="picBroken = true" />
              <template v-else>
                <span class="pk-pic-ico">款图</span>
                <span class="pk-pic-tip">{{ thumb ? '图片打不开（文件可能损坏）' : '订单与打版都还没上传' }}</span>
              </template>
            </div>

            <div class="pk-meta">
              <div class="pk-row1">
                <b class="pk-no mono">{{ order.order_no }}</b>
                <span class="tag" :class="statusTag(order.status)">{{ statusLabel(order.status) }}</span>
                <span class="tag" :class="order.type === 'stock' ? 'blue' : 'purple'" style="font-size: 10px">
                  {{ order.type === 'stock' ? '现货' : '定制' }}
                </span>
              </div>
              <div class="pk-name">{{ order.style_name || '—' }}</div>
              <div class="pk-kv">
                <span>客户</span><b>{{ order.customer_name || '—' }}</b>
                <span>客户款号</span><b>{{ order.cus_order_no || '—' }}</b>
                <span>下单</span><b>{{ fmt(order.order_date) }}</b>
                <span>交期</span><b :class="{ late: isLate }">{{ fmt(order.delivery_date) }}</b>
                <span>金额</span><b>¥{{ money(order.total_amount) }}<span class="pk-usd"> / ${{ money(order.total_usd) }}</span></b>
                <span>跟单</span><b>{{ order.manager || '—' }}</b>
              </div>
            </div>
          </div>

          <!-- ---------- 工序进度 ---------- -->
          <div v-if="nodes.length" class="pk-block">
            <div class="pk-sec">
              工序进度
              <span class="pk-sub">{{ doneCount }}/{{ nodes.length }} 已完成<template v-if="curNode"> · 当前：{{ curNode.name }}</template></span>
            </div>
            <div class="pk-nodes">
              <span v-for="n in nodes" :key="n.id" class="pk-node" :class="'is-' + n.status"
                :title="n.actual_date ? '完成于 ' + n.actual_date : ''">{{ n.name }}</span>
            </div>
          </div>

          <!-- ---------- 打版（技术资料）填写的信息 ---------- -->
          <div class="pk-block">
            <div class="pk-sec">
              打版信息
              <span v-if="tp" class="pk-sub">
                {{ tp.version }} · {{ stageLabel(tp.stage) }} · {{ tp.status === 'confirmed' ? '已确认' : '未确认' }}
              </span>
              <span v-else class="pk-sub">这张单还没有技术资料</span>
            </div>

            <div v-if="!tp" class="pk-mut">
              打版（技术资料）还在<code>开发管理</code>里没建，所以这里没有可看的内容。
              建好并确认之后，这里会显示面料、辅料、工艺、客户要求与尺码表。
            </div>

            <template v-else>
              <div class="pk-kv pk-kv2">
                <span>款号</span><b>{{ tp.product_name || '—' }}</b>
                <span>品类</span><b>{{ tp.category || '—' }}</b>
                <span>客户款号</span><b>{{ tp.customer_style_no || '—' }}</b>
                <span>品牌</span><b>{{ tp.brand || '—' }}</b>
                <span>设计师</span><b>{{ tp.designer || '—' }}</b>
                <span>打版师</span><b>{{ tp.pattern_maker || '—' }}</b>
                <span>版单号</span><b class="mono">{{ tp.pattern_no || '—' }}</b>
                <span>系列 / 波段</span><b>{{ [tp.series, tp.wave].filter(Boolean).join(' / ') || '—' }}</b>
                <span>尺码范围</span><b>{{ tp.size_range || '—' }}</b>
                <span>颜色</span><b>{{ tp.colors || '—' }}</b>
              </div>

              <div class="pk-txt-grid">
                <div><label>面料</label><p>{{ tp.fabric_info || '—' }}</p></div>
                <div><label>辅料</label><p>{{ tp.accessory_info || '—' }}</p></div>
                <div><label>工艺 / 工序</label><p>{{ tp.craft_info || '—' }}</p></div>
                <div><label>客户要求</label><p>{{ tp.customer_req || '—' }}</p></div>
              </div>

              <div v-if="tp.materials && tp.materials.length" class="pk-table-wrap">
                <div class="pk-mini">面辅料清单（{{ tp.materials.length }}）</div>
                <table class="data pk-tbl">
                  <thead>
                    <tr><th>类型</th><th>名称</th><th>规格</th><th>单位</th><th>单件用量</th><th>损耗</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="m in tp.materials" :key="m.id">
                      <td>{{ m.type === 'accessory' ? '辅料' : '面料' }}</td>
                      <td>{{ m.name }}</td>
                      <td>{{ m.spec || '—' }}</td>
                      <td>{{ m.unit || '—' }}</td>
                      <td>{{ m.one_use || 0 }}</td>
                      <td>{{ m.loss || 0 }}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="tp.sizes && tp.sizes.length" class="pk-table-wrap">
                <div class="pk-mini">
                  尺码规格（{{ tp.sizes.length }}）
                  <span v-if="tp.size_spec" class="pk-mut" style="font-weight: 400"> · {{ tp.size_spec }}</span>
                </div>
                <table class="data pk-tbl">
                  <thead>
                    <tr><th>部位</th><th v-for="s in sizeCols" :key="s">{{ s }}</th><th>公差</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in sizeRows" :key="row.part">
                      <td>{{ row.part }}</td>
                      <td v-for="s in sizeCols" :key="s">{{ (row.vals && row.vals[s]) || '—' }}</td>
                      <td>{{ row.tolerance || '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="tp.requirements && tp.requirements.length" class="pk-block" style="margin-top: 8px">
                <div class="pk-mini">其他要求（{{ tp.requirements.length }}）</div>
                <div v-for="r in tp.requirements" :key="r.id" class="pk-req">
                  <b>{{ r.title || r.name || '要求' }}</b>
                  <span>{{ r.content || r.value || '' }}</span>
                </div>
              </div>
            </template>
          </div>
        </template>

        <div v-else class="pk-mut" style="padding: 30px 0; text-align: center">没读到这张订单</div>
      </div>

      <div class="modal-foot">
        <button class="btn btn-ghost" @click="close">关闭</button>
        <button class="btn btn-ghost" @click="goOrder">到订单详情</button>
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
const order = ref(null);
const tp = ref(null);
const nodes = ref([]);

function statusLabel(s) {
  return {
    draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
    instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
  }[s] || s;
}
function statusTag(s) {
  return {
    draft: 'gray', tech: 'blue', finance: 'orange', assigned: 'purple', production: 'blue',
    instock: 'green', shipped: 'green', closed: 'gray', cancelled: 'red'
  }[s] || 'gray';
}
function stageLabel(s) {
  return {
    draft: '草稿', material: '选料', pattern: '打版', craft: '工艺',
    sample: '样衣', biz: '业务确认', confirmed: '已确认'
  }[s] || s || '—';
}
function fmt(v) { return v ? String(v).slice(0, 10) : '—'; }
function money(v) { return Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }

/** 款图：订单图优先，没有再取打版图 —— 与后端 board 的 thumb 同一口径 */
const thumb = computed(() => {
  if (!order.value) return '';
  return order.value.image_url || (tp.value && tp.value.image_url) || '';
});

/** 图加载失败（库里真有坏文件）时退回占位，不留空白块 */
const picBroken = ref(false);
const picUrl = computed(() => (picBroken.value ? '' : thumb.value));

const isLate = computed(() => {
  const d = order.value && order.value.delivery_date;
  if (!d) return false;
  return String(d).slice(0, 10) < new Date().toISOString().slice(0, 10)
    && order.value.status !== 'closed' && order.value.status !== 'shipped';
});
const doneCount = computed(() => nodes.value.filter((n) => n.status === 'done' || n.status === 'skipped').length);
const curNode = computed(() => nodes.value.find((n) => n.status === 'doing')
  || nodes.value.find((n) => n.status === 'pending') || null);

/**
 * 尺码表是「部位 × 尺码」的矩阵，但库里存的可能是
 * (a) 每行一个部位 + 各码数值，或 (b) 每行一个「部位+码」。
 * 这里两种都收：先按部位聚，再摊到各码上。
 */
const sizeCols = computed(() => {
  const set = new Set();
  (tp.value && tp.value.sizes ? tp.value.sizes : []).forEach((s) => {
    if (s.size) set.add(s.size);
  });
  return [...set];
});
const sizeRows = computed(() => {
  const list = (tp.value && tp.value.sizes) || [];
  const map = new Map();
  list.forEach((s) => {
    const part = s.part || s.position || s.item || '—';
    if (!map.has(part)) map.set(part, { part, vals: {}, tolerance: s.tolerance || '' });
    const row = map.get(part);
    if (s.size) row.vals[s.size] = s.value !== undefined && s.value !== null ? s.value : s.measure;
    if (s.tolerance && !row.tolerance) row.tolerance = s.tolerance;
  });
  return [...map.values()];
});

async function load() {
  if (!props.orderId) return;
  loading.value = true;
  order.value = null; tp.value = null; nodes.value = []; picBroken.value = false;
  try {
    const [o, t, nd] = await Promise.all([
      api.order(props.orderId).catch(() => null),
      api.techpackCurrent(props.orderId).catch(() => null),
      api.orderNodes(props.orderId).catch(() => [])
    ]);
    order.value = o;
    tp.value = t;
    nodes.value = nd || [];
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.orderId], ([open]) => { if (open) load(); });

function close() { emit('update:open', false); }
function goOrder() {
  if (!order.value) return;
  close();
  router.push({ path: '/orders', query: { order: order.value.id } });
}
</script>

<style scoped>
.pk-modal { width: 860px; max-width: 96vw; }
.pk-mut { font-size: 12.5px; color: #8a94a6; line-height: 1.8; }
.pk-mut code { background: #eef2f7; border-radius: 3px; padding: 0 4px; }

/* 顶部：款图 + 基本信息 */
.pk-top { display: flex; gap: 14px; margin-bottom: 14px; }
.pk-pic {
  width: 132px; height: 132px; flex: none; border-radius: 10px; overflow: hidden;
  background: #f4f6fa; border: 1px solid #e6ecf5; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.pk-pic img { width: 100%; height: 100%; object-fit: cover; }
.pk-pic.empty { cursor: default; flex-direction: column; gap: 4px; }
.pk-pic-ico { font-size: 12px; color: #b6bfcc; font-weight: 700; }
.pk-pic-tip { font-size: 10px; color: #c3cbd8; text-align: center; padding: 0 8px; line-height: 1.4; }

.pk-meta { flex: 1; min-width: 0; }
.pk-row1 { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.pk-no { font-size: 15px; color: #16233b; }
.pk-name { font-size: 13.5px; color: #33425c; margin: 5px 0 9px; }

.pk-kv {
  display: grid; grid-template-columns: auto 1fr auto 1fr;
  gap: 5px 10px; font-size: 12.5px; align-items: baseline;
}
.pk-kv > span { color: #8a94a6; white-space: nowrap; }
.pk-kv > b { color: #16233b; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.pk-kv2 { grid-template-columns: auto 1fr auto 1fr; margin-bottom: 10px; }
.pk-usd { color: #98a2b3; font-weight: 400; }
.late { color: #d92d45 !important; }

/* 区块 */
.pk-block { border-top: 1px solid #eef2f7; padding-top: 11px; margin-top: 11px; }
.pk-sec {
  font-size: 13px; font-weight: 700; color: #16233b; margin-bottom: 8px;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.pk-sub { font-size: 11.5px; font-weight: 400; color: #8a94a6; }

.pk-nodes { display: flex; flex-wrap: wrap; gap: 5px; }
.pk-node {
  font-size: 11.5px; padding: 2px 8px; border-radius: 12px;
  background: #f4f6fa; color: #98a2b3; border: 1px solid #eef2f7;
}
.pk-node.is-doing { background: #eef4ff; color: #2563eb; border-color: #c7dbfc; font-weight: 700; }
.pk-node.is-done { background: #f0faf4; color: #15803d; border-color: #bfe8d2; }
.pk-node.is-skipped { background: #fbfaf6; color: #b45309; border-color: #f2e6cc; }

/* 打版信息里的「字段表」和「四段长文本」是两块内容，用虚线隔开 ——
   不隔的话两列字段紧挨着两列文本，看起来像同一张四列表，容易读串行 */
.pk-txt-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px;
  margin-top: 11px; padding-top: 11px; border-top: 1px dashed #e6ecf5;
}
.pk-txt-grid label { display: block; font-size: 11.5px; color: #8a94a6; margin-bottom: 2px; }
.pk-txt-grid p { margin: 0; font-size: 12.5px; color: #33425c; line-height: 1.7; white-space: pre-wrap; }

.pk-table-wrap { margin-top: 10px; }
.pk-mini { font-size: 12px; color: #5b6b80; font-weight: 700; margin-bottom: 5px; }
.pk-tbl { width: 100%; }
.pk-tbl th { font-size: 11px; }
.pk-tbl td { font-size: 11.5px; padding: 6px 10px !important; }

.pk-req { font-size: 12.5px; color: #33425c; line-height: 1.7; padding: 3px 0; }
.pk-req b { color: #16233b; margin-right: 6px; }
</style>
