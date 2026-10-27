<template>
  <div>
    <div class="page-head">
      <div>
        <h2>美仓发货</h2>
        <div class="sub">按美仓库存核对已入库订单，缺货高亮</div>
      </div>
      <div style="display: flex; gap: 10px">
        <router-link class="btn btn-ghost" to="/inventory">去调拨</router-link>
        <button class="btn btn-ghost" @click="load">刷新</button>
      </div>
    </div>

    <div class="cards" style="grid-template-columns: repeat(3, 1fr)">
      <div class="stat-card"><div class="label">待发货订单</div><div class="value">{{ list.length }}</div></div>
      <div class="stat-card"><div class="label">可整单发货</div><div class="value">{{ shippable }}</div></div>
      <div class="stat-card accent"><div class="label">缺货订单</div><div class="value">{{ list.length - shippable }}</div></div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>订单号</th><th>客户</th><th>款名</th><th>交期</th><th>缺货</th><th>操作</th></tr>
        </thead>
        <tbody>
          <template v-for="o in filtered" :key="o.id">
            <tr>
              <td><strong>{{ o.order_no }}</strong></td>
              <td>{{ o.customer_name || '-' }}</td>
              <td>{{ o.style_name || '-' }}</td>
              <td>{{ o.delivery_date || '-' }}</td>
              <td>
                <span v-if="o.canShip" class="tag green">齐套</span>
                <span v-else class="tag red">缺 {{ o.shortage }} 件</span>
              </td>
              <td>
                <button class="link-btn" @click="toggle(o.id)">{{ open[o.id] ? '收起' : '明细' }}</button>
                <button v-if="o.canShip && canShip" class="link-btn" :disabled="busy" @click="ship(o)">美仓发货</button>
                <button v-else-if="!o.canShip && canStock" class="link-btn" :disabled="busy" @click="autoFill(o)">一键补货</button>
                <button class="link-btn" @click="openOrder(o)">订单</button>
              </td>
            </tr>
            <tr v-if="open[o.id]">
              <td colspan="6" style="background: #fafcff">
                <table class="data">
                  <thead><tr><th>款号</th><th>产品</th><th>颜色</th><th>尺码</th><th>需求</th><th>美仓可用</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="(l, i) in o.lines" :key="i">
                      <td>{{ l.style_no || '-' }}</td>
                      <td>{{ l.product_name }}</td>
                      <td>{{ l.color || '-' }}</td>
                      <td>{{ l.size || '-' }}</td>
                      <td>{{ l.demand }}</td>
                      <td :style="{ color: l.ok ? '#16a34a' : '#d92d45', fontWeight: 700 }">{{ l.available }}</td>
                      <td><span v-if="l.ok" class="tag green">够</span><span v-else class="tag red">缺 {{ l.demand - l.available }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
          <tr v-if="!filtered.length"><td colspan="6" class="empty-cell">暂无待发货订单</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter();
const route = useRoute();
const list = ref([]);
const tab = ref('all');
const open = reactive({});
const busy = ref(false);
const canShip = computed(() => can('order.ship'));
const canStock = computed(() => can('stock.write'));

const tabs = [
  { key: 'all', label: '全部' },
  { key: 'ok', label: '可发货' },
  { key: 'short', label: '缺货' }
];

const shippable = computed(() => list.value.filter((o) => o.canShip).length);
const filtered = computed(() => {
  if (tab.value === 'ok') return list.value.filter((o) => o.canShip);
  if (tab.value === 'short') return list.value.filter((o) => !o.canShip);
  return list.value;
});

async function load() {
  try {
    list.value = await api.shipBoard({ warehouse: 'us' });
    if (route.query.expand === '1') list.value.forEach((o) => { open[o.id] = true; });
  } catch (e) { alert(e.message); }
}
function toggle(id) { open[id] = !open[id]; }
function openOrder(o) { router.push('/orders?order=' + o.id); }

async function ship(o) {
  if (!confirm(`确定从美仓发货订单 ${o.order_no}？`)) return;
  busy.value = true;
  try {
    await api.orderShip({ order_id: o.id, warehouse: 'us' });
    await load();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function autoFill(o) {
  if (!confirm(`按订单 ${o.order_no} 的缺口，从生产仓调拨到美仓（有多少补多少）？`)) return;
  busy.value = true;
  try {
    const r = await api.autoTransfer({ order_id: o.id });
    alert(`已调拨 ${r.moved} 件到美仓` + (r.results.some((x) => x.note === '生产仓也无库存') ? '（部分款色码生产仓也无库存）' : ''));
    await load();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(load);
</script>
