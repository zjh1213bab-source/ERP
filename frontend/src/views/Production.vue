<template>
  <WarehouseWorkbench v-if="route.query.station === 'warehouse'" />
  <OperationWorkbench v-else-if="route.query.station" :station="String(route.query.station)"/>
  <div v-else>
    <div class="page-head">
      <div>
        <h2>生产管理</h2>
        <div class="sub">已分单 / 生产中 / 已入库订单的工序进度与交期</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <div class="cards" style="grid-template-columns: repeat(4, 1fr)">
      <div class="stat-card"><div class="label">已分单</div><div class="value">{{ countBy('assigned') }}</div></div>
      <div class="stat-card"><div class="label">生产中</div><div class="value">{{ countBy('production') }}</div></div>
      <div class="stat-card"><div class="label">已入库</div><div class="value">{{ countBy('instock') }}</div></div>
      <div class="stat-card accent"><div class="label">逾期订单</div><div class="value">{{ overdueCount }}</div></div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <div class="dev-grid">
      <div v-for="o in filtered" :key="o.id" class="dev-card" style="cursor: pointer" @click="open(o)">
        <div class="dev-body">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px">
            <strong class="nowrap-ellipsis" style="color: var(--ink); min-width: 0">{{ o.order_no }}</strong>
            <span class="tag" :class="statusTag(o.status)" style="flex: none; white-space: nowrap">{{ statusLabel(o.status) }}</span>
          </div>
          <div class="dev-sub" style="margin-top: 6px">{{ o.style_name || '-' }}</div>
          <div class="dev-sub">{{ o.customer_name || '-' }}</div>
          <div class="dev-sub">
            交期：{{ o.delivery_date || '-' }}
            <span v-if="isOverdue(o)" style="color: #d92d45; font-weight: 700">· 已逾期</span>
          </div>
          <div style="margin: 10px 0 6px; height: 8px; background: #eef1f6; border-radius: 6px; overflow: hidden">
            <div :style="{ width: pct(o) + '%' }" style="height: 100%; background: #16a34a"></div>
          </div>
          <div class="dev-sub">
            工序进度 {{ o.node_done }}/{{ o.node_total }}
            <span v-if="o.node_total == 0">（未初始化）</span>
            <span v-else-if="o.current_node">· 当前：{{ o.current_node }}</span>
            <span v-else>· 已全部完成</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="!filtered.length" class="empty-cell">暂无生产订单</div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
import OperationWorkbench from '../components/OperationWorkbench.vue';
import WarehouseWorkbench from './WarehouseWorkbench.vue';
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';

const router = useRouter(),route=useRoute();
const list = ref([]);
const tab = ref('all');

const tabs = [
  { key: 'all', label: '全部' },
  { key: 'assigned', label: '已分单' },
  { key: 'production', label: '生产中' },
  { key: 'instock', label: '已入库' }
];

const STATUS_LABEL = { assigned: '已分单', production: '生产中', instock: '已入库' };
const STATUS_TAG = { assigned: 'purple', production: 'orange', instock: 'green' };
const statusLabel = (s) => STATUS_LABEL[s] || s;
const statusTag = (s) => STATUS_TAG[s] || 'gray';

const today = localDate();
const isOverdue = (o) => o.delivery_date && o.delivery_date < today && o.status !== 'instock';
const pct = (o) => (o.node_total ? Math.round((o.node_done / o.node_total) * 100) : 0);

const filtered = computed(() => (tab.value === 'all' ? list.value : list.value.filter((o) => o.status === tab.value)));
const countBy = (s) => list.value.filter((o) => o.status === s).length;
const overdueCount = computed(() => list.value.filter(isOverdue).length);

function open(o) { router.push('/orders?order=' + o.id); }

async function load() {
  try { list.value = await api.productionBoard({}); }
  catch (e) { alert(e.message); }
}
onMounted(load);
</script>

<style scoped>
/* 订单号过长时省略，状态标签不被挤压成竖排 */
.nowrap-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
