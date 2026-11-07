<template>
  <div>
    <div class="page-head">
      <div>
        <h2>工作台</h2>
        <div class="sub">经营概览 · 待办提醒 · 近 7 日订单趋势</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <section class="review-summary"><h3>待审核事项 <b>{{reviewNotices.total}}</b><button class="link-btn" @click="refreshReviewNotices()">刷新</button></h3><div><router-link v-for="i in reviewNotices.items" :key="i.key" :to="i.to">{{i.label}} <strong>{{i.count}}</strong></router-link><span v-if="!reviewNotices.total">当前无待审核事项</span></div><p v-if="reviewNotices.error">待审核数据读取失败，请刷新重试</p></section>
    <div class="cards">
      <div class="stat-card">
        <div class="label">本月订单</div>
        <div class="value">{{ d.month.cnt }}</div>
      </div>
      <div class="stat-card accent">
        <div class="label">本月金额</div>
        <div class="value">${{ money(d.month.usd) }}</div>
        <div style="font-size: 12px; opacity: 0.85; margin-top: 4px">≈ ¥{{ money(d.month.cny) }}</div>
      </div>
      <div class="stat-card">
        <div class="label">在产订单</div>
        <div class="value">{{ d.inProd }}</div>
      </div>
      <div class="stat-card">
        <div class="label">待审批合计</div>
        <div class="value">{{ todoTotal }}</div>
      </div>
    </div>

    <!-- 提醒条 -->
    <div class="panel-card" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center">
      <span class="tag red" v-if="d.overdue">逾期 {{ d.overdue }} 单</span>
      <span class="tag orange" v-if="d.shortageOrders">美仓缺货 {{ d.shortageOrders }} 单</span>
      <span class="tag blue" v-if="d.techPending">待技术确认 {{ d.techPending }}</span>
      <span class="tag blue" v-if="d.costPending">待财务审核 {{ d.costPending }}</span>
      <span class="tag purple" v-if="d.toDispatch">待分单 {{ d.toDispatch }}</span>
      <span class="tag green" v-if="!d.overdue && !d.shortageOrders && !todoTotal">运转正常</span>
      <div style="flex: 1"></div>
      <router-link class="btn btn-ghost btn-sm" to="/approvals">去审批</router-link>
      <router-link class="btn btn-ghost btn-sm" to="/assistant">智能助手</router-link>
    </div>

    <div class="grid-2" style="align-items: start">
      <!-- 趋势 -->
      <div class="panel-card">
        <h3>近 7 日订单数</h3>
        <div style="display: flex; align-items: flex-end; gap: 8px; height: 140px; padding-top: 6px">
          <div v-for="t in d.trend" :key="t.date" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%">
            <div style="font-size: 11px; color: #5b6474; margin-bottom: 4px">{{ t.cnt }}</div>
            <div :style="{ height: barH(t.cnt) + '%', background: '#2b6de5', width: '100%', borderRadius: '6px 6px 0 0', minHeight: '2px' }"></div>
            <div style="font-size: 11px; color: var(--ink-mute); margin-top: 4px">{{ t.date }}</div>
          </div>
        </div>
      </div>

      <!-- 状态分布 -->
      <div class="panel-card">
        <h3>订单状态分布</h3>
        <div v-for="s in d.byStatus" :key="s.status" style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px">
          <span style="width: 70px; font-size: 12.5px; color: #5b6474">{{ statusLabel(s.status) }}</span>
          <div style="flex: 1; background: #f0f3f8; border-radius: 4px; height: 12px; overflow: hidden">
            <div :style="{ width: (s.cnt / maxStatus * 100) + '%' }" style="height: 100%; background: #64748b"></div>
          </div>
          <span style="width: 32px; text-align: right; font-weight: 700; font-size: 12px">{{ s.cnt }}</span>
        </div>
        <div v-if="!d.byStatus.length" class="empty-cell">暂无订单</div>
      </div>
    </div>

    <!-- 最近订单 -->
    <div class="panel-card">
      <h3>最近订单</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>金额</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="o in d.recent" :key="o.id" style="cursor: pointer" @click="$router.push('/orders?order=' + o.id)">
            <td><strong>{{ o.order_no }}</strong></td>
            <td>{{ o.customer_name || '-' }}</td>
            <td>{{ o.style_name || '-' }}</td>
            <td>¥{{ money(o.total_amount) }}</td>
            <td><span class="tag gray">{{ statusLabel(o.status) }}</span></td>
            <td>{{ dateStr(o.created_at) }}</td>
          </tr>
          <tr v-if="!d.recent.length"><td colspan="6" class="empty-cell">暂无订单</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 快捷入口 -->
    <div class="panel-card">
      <h3>快捷入口</h3>
      <div class="toolbar">
        <router-link class="btn btn-primary" to="/orders">＋ 新建订单</router-link>
        <router-link class="btn btn-ghost" to="/production">生产管理</router-link>
        <router-link class="btn btn-ghost" to="/inventory">库存管理</router-link>
        <router-link class="btn btn-ghost" to="/us-ship">美仓发货</router-link>
        <router-link class="btn btn-ghost" to="/reports">报表中心</router-link>
        <router-link class="btn btn-ghost" to="/scan">扫码查询</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import {reviewNotices,refreshReviewNotices} from '../store/reviewNotices';
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';

const d = reactive({
  month: { cnt: 0, usd: 0, cny: 0 },
  customers: 0, inProd: 0, techPending: 0, costPending: 0, toDispatch: 0, overdue: 0, shortageOrders: 0,
  byStatus: [], trend: [], recent: []
});

const STATUS = { draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单', production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消' };
const statusLabel = (s) => STATUS[s] || s;
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const dateStr = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');

const todoTotal = computed(() => Number(d.techPending) + Number(d.costPending) + Number(d.toDispatch));
const maxStatus = computed(() => Math.max(1, ...d.byStatus.map((s) => Number(s.cnt) || 0)));
const maxTrend = computed(() => Math.max(1, ...d.trend.map((t) => Number(t.cnt) || 0)));
function barH(cnt) { return Math.round(((Number(cnt) || 0) / maxTrend.value) * 100); }

async function load() {
  try { Object.assign(d, await api.dashboard()); }
  catch (e) { alert(e.message); }
}
onMounted(load);
</script>
