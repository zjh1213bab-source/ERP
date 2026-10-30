<template>
  <div>
    <div class="page-head">
      <div>
        <h2>审批中心</h2>
        <div class="sub">待技术确认 / 待财务审核 / 待分单 集中处理</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <div class="cards" style="grid-template-columns: repeat(3, 1fr)">
      <div class="stat-card"><div class="label">待技术确认</div><div class="value">{{ d.techpacks.length }}</div></div>
      <div class="stat-card"><div class="label">待财务审核</div><div class="value">{{ d.costs.length }}</div></div>
      <div class="stat-card accent"><div class="label">待分单</div><div class="value">{{ d.orders.length }}</div></div>
    </div>

    <!-- 待我审批（多级） -->
    <div class="panel-card">
      <h3>待我审批（多级流程）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>当前节点</th><th>总成本</th><th>出厂价</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td>{{ t.order_no || '-' }}</td>
            <td>{{ t.customer_name || '-' }}</td>
            <td>{{ t.style_name || '-' }}</td>
            <td><span class="tag blue">{{ t.step_name }}</span></td>
            <td>¥{{ money(t.total_cost) }}</td>
            <td>¥{{ money(t.factory_price) }}</td>
            <td>
              <button class="link-btn" @click="act(t, true)">通过</button>
              <button class="link-btn danger" @click="act(t, false)">驳回</button>
            </td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="7" class="empty-cell">暂无待我审批</td></tr>
        </tbody>
      </table>
      <p style="font-size: 12px; color: #8a94a6; margin-top: 8px">成本单默认两级审批：财务审核 → 总经理审批；逐级通过后才算财务通过，可分单。</p>
    </div>

    <!-- 待技术确认 -->
    <div class="panel-card">
      <h3>① 待技术确认（开发单）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>产品</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in d.techpacks" :key="t.id">
            <td>{{ t.order_no || '-' }}</td>
            <td>{{ t.customer_name || '-' }}</td>
            <td>{{ t.style_name || '-' }}</td>
            <td>{{ t.product_name }}</td>
            <td><span class="tag gray">待确认</span></td>
            <td>
              <button v-if="canTech" class="link-btn" @click="confirmTp(t)">确认</button>
              <button v-if="canTech" class="link-btn danger" @click="rejectTp(t)">驳回</button>
              <button class="link-btn" @click="openOrder(t.order_id)">订单</button>
            </td>
          </tr>
          <tr v-if="!d.techpacks.length"><td colspan="6" class="empty-cell">无</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 待财务审核 -->
    <div class="panel-card">
      <h3>② 待财务审核（成本单）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>总成本</th><th>出厂价</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in d.costs" :key="c.order_id">
            <td>{{ c.order_no || '-' }}</td>
            <td>{{ c.customer_name || '-' }}</td>
            <td>{{ c.style_name || '-' }}</td>
            <td>¥{{ money(c.total_cost) }}</td>
            <td>¥{{ money(c.factory_price) }}</td>
            <td>
              <button v-if="canFinance" class="link-btn" @click="review(c, true)">通过</button>
              <button v-if="canFinance" class="link-btn danger" @click="review(c, false)">驳回</button>
              <button class="link-btn" @click="openOrder(c.order_id)">订单</button>
            </td>
          </tr>
          <tr v-if="!d.costs.length"><td colspan="6" class="empty-cell">无</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 待分单 -->
    <div class="panel-card">
      <h3>③ 待分单（财务已通过）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>交期</th><th>金额</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="o in d.orders" :key="o.id">
            <td>{{ o.order_no }}</td>
            <td>{{ o.customer_name || '-' }}</td>
            <td>{{ o.style_name || '-' }}</td>
            <td>{{ o.delivery_date || '-' }}</td>
            <td>¥{{ money(o.total_amount) }}</td>
            <td><button class="link-btn" @click="openOrder(o.id)">去分单</button></td>
          </tr>
          <tr v-if="!d.orders.length"><td colspan="6" class="empty-cell">无</td></tr>
        </tbody>
      </table>
      <p style="font-size: 12px; color: #8a94a6; margin-top: 8px">分单在订单详情「分单（本厂/外协）」区块完成。</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter();
const d = reactive({ techpacks: [], costs: [], orders: [] });
const tasks = ref([]);

const canTech = computed(() => can('development.review'));
const canFinance = computed(() => can('cost.review'));
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

async function load() {
  try {
    const [r, mt] = await Promise.all([api.approvals(), api.myApprovalTasks()]);
    d.techpacks = r.techpacks || [];
    d.costs = r.costs || [];
    d.orders = r.orders || [];
    tasks.value = mt || [];
  } catch (e) { alert(e.message); }
}
async function act(t, approve) {
  const remark = approve ? prompt('审批意见（可空）') : prompt('驳回原因（可空）');
  try { await api.actApprovalTask(t.id, approve, remark || ''); await load(); }
  catch (e) { alert(e.message); }
}
function openOrder(id) { if (id) router.push('/orders?order=' + id); }

async function confirmTp(t) {
  try {
    // 与「订单页」同一条路：先取确认前检查，有缺口就把清单列出来（后端同一份判断）
    const chk = await api.techpackConfirmCheck(t.id);
    if (chk && !chk.ok) return alert(chk.message);
    await api.confirmTechpack(t.id);
    await load();
  } catch (e) { alert(e.message); }
}
async function rejectTp(t) {
  if (!confirm(`驳回开发单「${t.product_name}」？`)) return;
  try { await api.rejectTechpack(t.id); await load(); } catch (e) { alert(e.message); }
}
async function review(c, approve) {
  try { await api.reviewCost(c.order_id, approve, approve ? '同意' : '不通过'); await load(); }
  catch (e) { alert(e.message); }
}

onMounted(load);
</script>
