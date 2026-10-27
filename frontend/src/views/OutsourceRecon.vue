<template>
  <div>
    <div class="page-head">
      <div>
        <h2>外协对账</h2>
        <div class="sub">按外协厂汇总分单件数与金额，逐单结算</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <div class="cards" style="grid-template-columns: repeat(3, 1fr)">
      <div class="stat-card"><div class="label">外协厂数量</div><div class="value">{{ list.length }}</div></div>
      <div class="stat-card"><div class="label">分单总额</div><div class="value">¥{{ money(totalAmount) }}</div></div>
      <div class="stat-card accent"><div class="label">未结算金额</div><div class="value">¥{{ money(totalUnsettled) }}</div></div>
    </div>

    <div class="panel-card">
      <h3>按外协厂汇总</h3>
      <table class="data">
        <thead><tr><th>外协厂</th><th>分单数</th><th>件数</th><th>金额</th><th>未结金额</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="f in list" :key="f.factory_id">
            <td><strong>{{ f.factory_name || '未指定' }}</strong></td>
            <td>{{ f.cnt }}</td>
            <td>{{ f.qty }}</td>
            <td>¥{{ money(f.amount) }}</td>
            <td><span class="tag" :class="Number(f.unsettled) > 0 ? 'orange' : 'green'">¥{{ money(f.unsettled) }}</span></td>
            <td><button class="link-btn" @click="openFactory(f)">{{ selected && selected.factory_id === f.factory_id ? '收起' : '明细' }}</button></td>
          </tr>
          <tr v-if="!list.length"><td colspan="6" class="empty-cell">暂无外协分单</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="selected" class="panel-card">
      <h3>{{ selected.factory_name }} · 分单明细</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>款名</th><th>数量</th><th>单价</th><th>金额</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ r.order_no || '-' }}</td>
            <td>{{ r.style_name || '-' }}</td>
            <td>{{ r.qty }}</td>
            <td>¥{{ money(r.price) }}</td>
            <td>¥{{ money(r.qty * r.price) }}</td>
            <td><span class="tag" :class="r.status === 'settled' ? 'green' : 'orange'">{{ r.status === 'settled' ? '已结算' : '未结算' }}</span></td>
            <td>
              <button v-if="canSettle && r.status !== 'settled'" class="link-btn" @click="settle(r, true)">结算</button>
              <button v-if="canSettle && r.status === 'settled'" class="link-btn danger" @click="settle(r, false)">取消结算</button>
            </td>
          </tr>
          <tr v-if="!rows.length"><td colspan="7" class="empty-cell">暂无明细</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { hasRole } from '../store/auth';

const list = ref([]);
const selected = ref(null);
const rows = ref([]);
const canSettle = computed(() => hasRole('finance'));

const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const totalAmount = computed(() => list.value.reduce((s, x) => s + Number(x.amount || 0), 0));
const totalUnsettled = computed(() => list.value.reduce((s, x) => s + Number(x.unsettled || 0), 0));

async function load() {
  try { list.value = await api.dispatchRecon(); }
  catch (e) { alert(e.message); }
}
async function openFactory(f) {
  if (selected.value && selected.value.factory_id === f.factory_id) {
    selected.value = null;
    rows.value = [];
    return;
  }
  selected.value = f;
  try { rows.value = await api.dispatchList({ factory_id: f.factory_id }); }
  catch (e) { alert(e.message); }
}
async function settle(r, settled) {
  try {
    await api.settleDispatch(r.id, settled);
    rows.value = await api.dispatchList({ factory_id: selected.value.factory_id });
    await load();
  } catch (e) { alert(e.message); }
}

onMounted(load);
</script>
