<template>
  <div>
    <div class="page-head">
      <div>
        <h2>库存管理</h2>
        <div class="sub">生产仓（中国） / 美仓（美国）成品库存台账</div>
      </div>
      <div style="display: flex; gap: 10px">
        <button v-if="canWrite" class="btn btn-ghost" @click="openTransfer">调拨</button>
        <button class="btn btn-ghost" @click="load">刷新</button>
      </div>
    </div>

    <div class="cards" style="grid-template-columns: repeat(4, 1fr)">
      <div class="stat-card"><div class="label">生产仓 件数</div><div class="value">{{ summary.cn.qty }}</div></div>
      <div class="stat-card"><div class="label">生产仓 SKU</div><div class="value">{{ summary.cn.skus }}</div></div>
      <div class="stat-card"><div class="label">美仓 件数</div><div class="value">{{ summary.us.qty }}</div></div>
      <div class="stat-card"><div class="label">美仓 SKU</div><div class="value">{{ summary.us.skus }}</div></div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: wh === 'cn' }" @click="wh = 'cn'; load()">生产仓</button>
        <button :class="{ on: wh === 'us' }" @click="wh = 'us'; load()">美仓</button>
      </div>
      <input class="input" v-model="q" placeholder="搜索 款号 / 产品 / 颜色" @keyup.enter="load" style="width: 240px" />
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>款号</th><th>产品</th><th>颜色</th><th>尺码</th><th>数量</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in list" :key="s.id">
            <td><strong>{{ s.style_no || '-' }}</strong></td>
            <td>{{ s.product_name || '-' }}</td>
            <td>{{ s.color || '-' }}</td>
            <td>{{ s.size || '-' }}</td>
            <td><strong>{{ s.qty }}</strong></td>
            <td>{{ dateStr(s.updated_at) }}</td>
            <td><button v-if="canWrite" class="link-btn" @click="openAdjust(s)">调整</button></td>
          </tr>
          <tr v-if="!list.length"><td colspan="7" class="empty-cell">暂无库存</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 调整 -->
    <div v-if="adj" class="modal-mask" @click.self="adj = null">
      <div class="modal">
        <div class="modal-head"><h3>库存调整</h3><button class="x" @click="adj = null">×</button></div>
        <div class="modal-body">
          <p style="font-size: 13px; color: #33415a">{{ adj.product_name }} / {{ adj.color || '-' }} / {{ adj.size || '-' }} · 现有 {{ adj.qty }}</p>
          <div class="form-grid">
            <div class="fitem"><label>调整数量（正数增加，负数减少）</label><input class="input" type="number" v-model.number="adjQty" /></div>
            <div class="fitem"><label>备注</label><input class="input" v-model="adjRemark" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="adj = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doAdjust">确定</button>
        </div>
      </div>
    </div>

    <!-- 调拨 -->
    <div v-if="showTransfer" class="modal-mask" @click.self="showTransfer = false">
      <div class="modal">
        <div class="modal-head"><h3>库存调拨</h3><button class="x" @click="showTransfer = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>调出仓库</label><select class="select" v-model="tf.from"><option value="cn">生产仓</option><option value="us">美仓</option></select></div>
            <div class="fitem"><label>调入仓库</label><select class="select" v-model="tf.to"><option value="us">美仓</option><option value="cn">生产仓</option></select></div>
            <div class="fitem"><label>款号</label><input class="input" v-model="tf.style_no" /></div>
            <div class="fitem"><label>产品名</label><input class="input" v-model="tf.product_name" /></div>
            <div class="fitem"><label>颜色</label><input class="input" v-model="tf.color" /></div>
            <div class="fitem"><label>尺码</label><input class="input" v-model="tf.size" /></div>
            <div class="fitem"><label>数量</label><input class="input" type="number" v-model.number="tf.qty" /></div>
            <div class="fitem"><label>备注</label><input class="input" v-model="tf.remark" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showTransfer = false">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doTransfer">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const list = ref([]);
const summary = ref({ cn: { qty: 0, skus: 0 }, us: { qty: 0, skus: 0 } });
const wh = ref('cn');
const q = ref('');
const busy = ref(false);
const canWrite = computed(() => can('stock.write'));

const adj = ref(null);
const adjQty = ref(0);
const adjRemark = ref('');

const showTransfer = ref(false);
const tf = ref({ from: 'cn', to: 'us', style_no: '', product_name: '', color: '', size: '', qty: 1, remark: '' });

const dateStr = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');

async function load() {
  try {
    const [s, su] = await Promise.all([api.stock({ warehouse: wh.value, q: q.value }), api.stockSummary()]);
    list.value = s;
    summary.value = su;
  } catch (e) { alert(e.message); }
}

function openAdjust(s) { adj.value = s; adjQty.value = 0; adjRemark.value = ''; }
async function doAdjust() {
  if (!adj.value || !adjQty.value) return alert('调整数量不能为 0');
  busy.value = true;
  try {
    await api.stockAdjust({ warehouse: wh.value, style_no: adj.value.style_no, product_name: adj.value.product_name, color: adj.value.color, size: adj.value.size, qty: adjQty.value, remark: adjRemark.value });
    adj.value = null;
    await load();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

function openTransfer() { showTransfer.value = true; }
async function doTransfer() {
  if (tf.value.from === tf.value.to) return alert('调出与调入不能相同');
  busy.value = true;
  try {
    await api.stockTransfer(tf.value);
    showTransfer.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(load);
</script>
