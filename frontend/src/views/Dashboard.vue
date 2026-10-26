<template>
  <div>
    <div class="page-head">
      <div>
        <h2>工作台</h2>
        <div class="sub">一屏掌握客户、产品、订单核心数据</div>
      </div>
    </div>

    <!-- 数据卡 -->
    <div class="cards">
      <div class="stat-card">
        <div class="label">客户总数</div>
        <div class="value">{{ stats.customers }}</div>
      </div>
      <div class="stat-card">
        <div class="label">产品总数</div>
        <div class="value">{{ stats.products }}</div>
      </div>
      <div class="stat-card">
        <div class="label">订单总数</div>
        <div class="value">{{ stats.orders }}</div>
      </div>
      <div class="stat-card accent">
        <div class="label">订单总金额</div>
        <div class="value">${{ formatMoney(stats.totalUsd) }}</div>
        <div style="font-size: 12px; opacity: 0.85; margin-top: 4px">≈ ¥{{ formatMoney(stats.totalAmount) }}</div>
      </div>
    </div>

    <!-- 订单状态分布 -->
    <div class="panel-card">
      <h3>订单状态分布</h3>
      <div v-if="!stats.byStatus.length" class="empty-cell">暂无订单数据</div>
      <div v-else style="display: flex; flex-wrap: wrap; gap: 10px">
        <div
          v-for="s in stats.byStatus"
          :key="s.status"
          style="display: flex; align-items: center; gap: 8px; padding: 10px 14px; border: 1px solid #eef2f7; border-radius: 10px"
        >
          <span class="tag" :class="statusTag(s.status)">{{ labelOf(s.status) }}</span>
          <strong style="color: #16305f">{{ s.c }}</strong>
        </div>
      </div>
    </div>

    <!-- 快捷入口 -->
    <div class="panel-card">
      <h3>快捷入口</h3>
      <div class="toolbar">
        <router-link class="btn btn-primary" to="/orders">＋ 新建订单</router-link>
        <router-link class="btn btn-ghost" to="/customers">客户管理</router-link>
        <router-link class="btn btn-ghost" to="/products">产品管理</router-link>
        <router-link class="btn btn-ghost" to="/blueprint">查看业务蓝图</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const stats = ref({ customers: 0, products: 0, orders: 0, totalAmount: 0, totalUsd: 0, byStatus: [] });
const labels = ref({});

const STATUS_TAG = {
  draft: 'gray',
  tech: 'blue',
  finance: 'orange',
  assigned: 'purple',
  production: 'orange',
  instock: 'green',
  shipped: 'green',
  closed: 'gray',
  cancelled: 'red'
};

function labelOf(s) {
  return labels.value[s] || s;
}
function statusTag(s) {
  return STATUS_TAG[s] || 'gray';
}
function formatMoney(v) {
  return Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

onMounted(async () => {
  try {
    const [s, meta] = await Promise.all([api.orderStats(), api.orderMeta()]);
    stats.value = s;
    labels.value = meta.labels || {};
  } catch (e) {
    /* 忽略，工作台不阻塞 */
  }
});
</script>
