<template>
  <section class="wh-workbench page">
    <div class="page-head">
      <div>
        <h2>前端仓库工作台</h2>
        <p class="sub">生产前端 · 核料备料、到货验收、裁床交接、辅料配套与车间发料</p>
      </div>
      <div class="head-actions">
        <span v-if="loading" class="tag gray">正在刷新</span>
        <span v-else class="tag green">业务数据已同步</span>
        <button class="btn btn-ghost" @click="load">刷新</button>
      </div>
    </div>

    <section class="panel flow-panel">
      <div class="panel-head">
        <div><b>仓库货物流转</b><small>每一步沿用现有采购、原料检验、库存流水和生产工序单据</small></div>
        <span class="tag blue">库存账单一来源</span>
      </div>
      <div class="flow-track">
        <router-link v-for="(step, i) in flow" :key="step.title" class="flow-step" :to="step.to">
          <i>{{ i + 1 }}</i><span><b>{{ step.title }}</b><small>{{ step.note }}</small></span><em v-if="i < flow.length - 1">›</em>
        </router-link>
      </div>
      <div class="flow-note"><b>流转规则：</b>仓库先核对裁床整单算料与可用预料，缺料跟进采购；采购到货先点收、后检验，只有合格数量进入可用库存。裁床领料按单占用并在实发时扣账；裁片回仓后配齐辅料，车间提前申请并经仓库确认后交接。</div>
    </section>

    <div v-if="errors.length" class="warn-box load-warning">
      部分工作队列暂时无法读取：{{ errors.join('、') }}。可刷新重试；已有正常读取的队列仍可使用。
    </div>

    <div class="stats-grid">
      <button class="stat-card" @click="go('/requirements')"><span>齐套 / 缺料待跟进</span><strong>{{ shortageCards }}</strong><small>按订单与物料需求查看</small></button>
      <button class="stat-card" :class="receiptPending ? 'warn' : ''" @click="go('/receipts')"><span>原料待验收</span><strong>{{ receiptPending }}</strong><small>{{ qty(receiptData.stat?.pending_qty) }} 件 / 米待检</small></button>
      <button class="stat-card" :class="issueShort ? 'warn' : ''" @click="go('/material-flow')"><span>备料欠发</span><strong>{{ issueShort }}</strong><small>含备料占用与部分发料</small></button>
      <button class="stat-card" @click="go('/purchases')"><span>采购未收齐</span><strong>{{ openPurchases }}</strong><small>采购跟进与预计到货</small></button>
      <button class="stat-card" :class="lowStock ? 'danger' : ''" @click="go('/material-flow')"><span>原料可用不足</span><strong>{{ lowStock }}</strong><small>按账面减已备占用计算</small></button>
    </div>

    <div class="main-grid">
      <section class="panel queue-panel">
        <div class="panel-head"><div><b>仓库待办队列</b><small>点击进入对应单据办理页</small></div><router-link class="btn btn-ghost btn-sm" to="/material-flow">打开备料领退</router-link></div>
        <div class="queue-list">
          <router-link class="queue-item" to="/requirements">
            <span class="queue-icon blue">▦</span><span class="queue-copy"><b>整单算料 / 仓库核料</b><small>复核面辅料需求、现有合格预料和订单缺口</small></span><strong>{{ shortageCards }}<small>订单</small></strong><span class="arrow">›</span>
          </router-link>
          <router-link class="queue-item" to="/purchases">
            <span class="queue-icon orange">＋</span><span class="queue-copy"><b>缺料采购跟进</b><small>查看采购下单、供应商承诺和待收齐物料</small></span><strong>{{ openPurchases }}<small>单</small></strong><span class="arrow">›</span>
          </router-link>
          <router-link class="queue-item" to="/receipts">
            <span class="queue-icon green">✓</span><span class="queue-copy"><b>到货待检 / 入库</b><small>登记卷号、缸号、库位；合格量才增加可用库存</small></span><strong>{{ receiptPending }}<small>单</small></strong><span class="arrow">›</span>
          </router-link>
          <router-link class="queue-item" to="/material-flow">
            <span class="queue-icon blue">⇧</span><span class="queue-copy"><b>裁床领料 / 面辅料发放</b><small>先备料占用，实际发料时扣减并记录库存流水</small></span><strong>{{ issueShort }}<small>单</small></strong><span class="arrow">›</span>
          </router-link>
          <router-link class="queue-item" :to="{ path: '/production', query: { station: 'workshop' } }">
            <span class="queue-icon purple">⇄</span><span class="queue-copy"><b>车间领货申请 / 发料交接</b><small>查看车间当前领料工序，确认配齐后交接</small></span><strong>{{ workshopTasks.length }}<small>单</small></strong><span class="arrow">›</span>
          </router-link>
        </div>
      </section>

      <section class="panel stock-panel">
        <div class="panel-head"><div><b>原料库存概况</b><small>账面、占用、可用分开显示，避免重复备料</small></div><router-link class="btn btn-ghost btn-sm" to="/material-flow">查看台账</router-link></div>
        <div class="stock-summary">
          <div><span>原料品种</span><b>{{ stockData.stat?.total ?? stockData.rows?.length ?? 0 }}</b></div>
          <div><span>备料占用</span><b>{{ qty(stockData.stat?.reserved) }}</b></div>
          <div><span>可用不足</span><b :class="lowStock ? 'red' : ''">{{ stockData.stat?.shortage ?? lowStock }}</b></div>
        </div>
        <div v-if="stockRows.length" class="stock-table-wrap">
          <table class="data stock-table">
            <thead><tr><th>物料</th><th>类型</th><th class="num">账面</th><th class="num">占用</th><th class="num">可用</th></tr></thead>
            <tbody><tr v-for="r in stockRows" :key="r.id" :class="{ 'row-warn': r.available <= 0 }"><td>{{ r.name }}<small>{{ r.code || r.spec || '—' }}</small></td><td>{{ r.type_label }}</td><td class="num">{{ qty(r.stock_qty) }}</td><td class="num">{{ qty(r.reserved) }}</td><td class="num" :class="r.available <= 0 ? 'red' : ''"><b>{{ qty(r.available) }}</b></td></tr></tbody>
          </table>
        </div>
        <div v-else class="empty-cell">暂无原料库存数据</div>
      </section>
    </div>

    <section class="panel order-panel">
      <div class="panel-head"><div><b>生产订单中的仓库工序</b><small>只显示当前待办落在领料、采购入库或辅料配送环节的订单</small></div><router-link class="btn btn-ghost btn-sm" to="/production?station=cut">查看生产协同</router-link></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>订单 / 款名</th><th>当前仓库工序</th><th>客户</th><th>货期</th><th>生产方式</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="r in warehouseTasks.slice(0, 10)" :key="r.id">
              <td><b>{{ r.order_no }}</b><small>{{ r.style_name || '—' }}</small></td><td><span class="tag blue">{{ currentNode(r)?.name || r.current || '仓库待办' }}</span></td><td>{{ r.customer_name || '—' }}</td><td>{{ r.delivery_date || '—' }}</td><td>{{ r.cut_dispatches ? '裁片外发 / 本厂' : '本厂生产' }}</td><td><router-link class="link-btn" :to="{ path: '/orders', query: { order: r.id } }">订单详情</router-link></td>
            </tr>
            <tr v-if="!warehouseTasks.length"><td class="empty-cell" colspan="6">当前没有工序停留在仓库节点的生产订单</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="materialData.running_take" class="freeze-alert"><b>原料盘点冻结中：</b>{{ materialData.running_take.take_no }} · {{ takeLabel(materialData.running_take.status) }}。盘点完成前，原料收发操作会受系统控制。</div>
    <div class="workbench-foot">库存余额与流水沿用 ERP 现有原料账；采购、待检收货、备料领料和生产节点仍由各自单据办理。本工作台汇总队列，不直接改写库存。</div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();
const loading = ref(false);
const errors = ref([]);
const nodeRows = ref([]);
const receiptData = ref({ stat: {}, rows: [] });
const materialData = ref({ stat: {}, open_short: [], running_take: null });
const stockData = ref({ stat: {}, rows: [] });
const purchaseData = ref({ cards: [] });

const flow = [
  { title: '算料核料', note: '预料 / 缺口', to: '/requirements' },
  { title: '缺料采购', note: '下单 / 交期', to: '/purchases' },
  { title: '到货验收', note: '点收 / 检验', to: '/receipts' },
  { title: '裁床备料', note: '占用 / 发料', to: '/material-flow' },
  { title: '裁片回仓', note: '按扎 / 数量', to: '/cuts' },
  { title: '辅料配套', note: '按订单齐套', to: '/material-flow' },
  { title: '车间交接', note: '确认 / 发放', to: { path: '/production', query: { station: 'workshop' } } }
];

const stockRows = computed(() => (stockData.value.rows || [])
  .filter((r) => r.available <= 0 || r.reserved > 0)
  .sort((a, b) => Number(a.available) - Number(b.available))
  .slice(0, 8));
const lowStock = computed(() => Number(stockData.value.stat?.shortage ?? (stockData.value.rows || []).filter((r) => r.available < 0.005).length));
const shortageCards = computed(() => (purchaseData.value.cards || []).filter((c) => c.fabric_status === 'pending' || c.accessory_status === 'pending').length);
const openPurchases = computed(() => {
  const all = (purchaseData.value.cards || []).flatMap((c) => c.purchases || []);
  return new Set(all.filter((p) => ['draft', 'ordered'].includes(p.status)).map((p) => p.id)).size;
});
const issueShort = computed(() => Number(materialData.value.open_short_count || 0));
const nodeOpen = (r) => {
  const nodes = [...(r.cells || []), ...(r.extra || [])];
  return nodes.find((n) => n.code === r.current_code && !n.missing && !['done', 'skipped', 'none'].includes(n.status));
};
const currentNode = (r) => nodeOpen(r);
const isWarehouseNode = (r) => {
  const n = nodeOpen(r);
  return !!n && /(领料|入库|采购|辅料配送|备料)/.test(n.name || '');
};
const warehouseTasks = computed(() => nodeRows.value.filter(isWarehouseNode));
const workshopTasks = computed(() => warehouseTasks.value.filter((r) => /(辅料配送|车间|缝制)/.test(nodeOpen(r)?.name || '')));

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}
function takeLabel(s) { return ({ draft: '待开始', counting: '盘点中', submitted: '待调账' })[s] || s || '进行中'; }
function go(path) { router.push(path); }

async function load() {
  loading.value = true;
  errors.value = [];
  const jobs = [
    ['订单工序', () => api.nodeFlowBoard({ tracking: 1, tracking_view: 'factory', limit: 5000 }), (d) => { nodeRows.value = d.rows || []; }],
    ['采购工作台', () => api.purchaseWorkspace(), (d) => { purchaseData.value = d || { cards: [] }; }],
    ['原料待检', () => api.receiptBoard({}), (d) => { receiptData.value = d || { stat: {}, rows: [] }; }],
    ['备料领料', () => api.matflowBoard(), (d) => { materialData.value = d || {}; }],
    ['原料库存', () => api.matflowStock({}), (d) => { stockData.value = d || { stat: {}, rows: [] }; }]
  ];
  const results = await Promise.allSettled(jobs.map(([, request]) => request()));
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') jobs[i][2](result.value);
    else errors.value.push(jobs[i][0]);
  });
  loading.value = false;
}

onMounted(load);
</script>

<style scoped>
.wh-workbench{padding:4px}.head-actions{display:flex;align-items:center;gap:8px}.panel{border:1px solid var(--line);border-radius:4px;background:var(--surface);margin:14px 0}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}.panel-head b{display:block;font-size:14px}.panel-head small{display:block;color:var(--ink-mute);font-size:11px;margin-top:4px}.flow-track{display:grid;grid-template-columns:repeat(7,minmax(115px,1fr));gap:8px;padding:15px}.flow-step{position:relative;display:flex;align-items:center;gap:8px;min-height:58px;padding:9px;border:1px solid var(--line);border-radius:3px;background:var(--surface-2);color:var(--ink);text-decoration:none}.flow-step:hover{border-color:var(--brand);color:var(--brand)}.flow-step i{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;font-style:normal;background:var(--brand-soft);color:var(--brand);flex:none}.flow-step b{display:block;font-size:11px}.flow-step small{display:block;color:var(--ink-mute);font-size:10px;margin-top:3px}.flow-step em{position:absolute;right:-8px;z-index:1;background:var(--surface);font-style:normal;color:var(--ink-mute)}.flow-note{margin:0 15px 15px;padding:10px 12px;border-radius:3px;background:var(--surface-2);font-size:11px;color:var(--ink-mute);line-height:1.7}.flow-note b{color:var(--ink)}.stats-grid{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:10px}.stat-card{min-height:96px;text-align:left;border:1px solid var(--line);border-radius:4px;background:var(--surface);padding:12px 14px;color:var(--ink);cursor:pointer}.stat-card:hover{border-color:var(--brand);background:var(--surface-2)}.stat-card span,.stat-card small{display:block;color:var(--ink-mute);font-size:11px}.stat-card strong{display:block;font-size:24px;margin:4px 0;color:var(--brand)}.stat-card.warn strong{color:var(--warning)}.stat-card.danger strong{color:var(--danger)}.main-grid{display:grid;grid-template-columns:minmax(420px,1.3fr) minmax(350px,1fr);gap:14px}.queue-list{padding:4px 14px}.queue-item{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}.queue-item:last-child{border-bottom:0}.queue-item:hover .queue-copy b,.queue-item:hover .arrow{color:var(--brand)}.queue-icon{width:30px;height:30px;display:grid;place-items:center;border-radius:4px;background:var(--surface-2);font-weight:700}.queue-icon.blue{color:var(--brand)}.queue-icon.orange{color:var(--warning)}.queue-icon.green{color:var(--success)}.queue-icon.purple{color:var(--brand)}.queue-copy{flex:1}.queue-copy b{display:block;font-size:12px}.queue-copy small{display:block;color:var(--ink-mute);font-size:10px;margin-top:3px}.queue-item>strong{text-align:right;font-size:17px;color:var(--brand)}.queue-item>strong small{display:block;font-size:9px;color:var(--ink-mute);font-weight:400}.arrow{color:var(--ink-mute);font-size:18px}.stock-summary{display:grid;grid-template-columns:repeat(3,1fr);padding:13px 15px;border-bottom:1px solid var(--line)}.stock-summary div{border-right:1px solid var(--line);padding:0 10px}.stock-summary div:last-child{border:0}.stock-summary span{display:block;font-size:10px;color:var(--ink-mute)}.stock-summary b{display:block;font-size:17px;margin-top:3px}.stock-table-wrap{max-height:275px;overflow:auto;padding:0 12px 12px}.stock-table{font-size:11px}.stock-table td,.stock-table th{padding:8px}.stock-table small{display:block;color:var(--ink-mute);font-size:9px;margin-top:3px}.order-panel .table-wrap{overflow:auto}.order-panel table{min-width:860px}.load-warning{margin:12px 0}.freeze-alert{margin-top:13px;padding:11px 14px;background:var(--surface-2);border:1px solid var(--line);color:var(--warning);font-size:12px}.workbench-foot{margin:10px 2px;color:var(--ink-mute);font-size:10px}@media(max-width:1250px){.flow-track{grid-template-columns:repeat(4,minmax(120px,1fr))}.stats-grid{grid-template-columns:repeat(3,minmax(130px,1fr))}.main-grid{grid-template-columns:1fr}}@media(max-width:720px){.flow-track{grid-template-columns:repeat(2,minmax(125px,1fr))}.flow-step em{display:none}.stats-grid{grid-template-columns:repeat(2,minmax(120px,1fr))}.panel-head{align-items:flex-start;flex-direction:column}}
</style>

