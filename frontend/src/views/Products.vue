<template>
  <div>
    <div class="page-head">
      <div>
        <h2>产品管理</h2>
        <div class="sub">款号、品类、单价</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增产品</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索名称 / 款号 / 品类" @keyup.enter="load" style="width: 260px" />
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
      <CsvImport v-if="canWrite" kind="products" @done="load" />
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>款号</th><th>产品名称</th><th>品类</th><th>单位</th><th>单价</th><th>阶梯价</th><th>状态</th>
            <th v-if="canWrite">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in list" :key="p.id">
            <td>{{ p.sku || '-' }}</td>
            <td><strong>{{ p.name }}</strong></td>
            <td>{{ p.category || '-' }}</td>
            <td>{{ p.unit || '-' }}</td>
            <td>¥{{ Number(p.price || 0).toLocaleString() }}</td>
            <td>
              <span v-if="tierCount(p.id)" class="tag green">{{ tierCount(p.id) }} 档</span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span class="tag" :class="p.status === 'active' ? 'green' : 'gray'">
                {{ p.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td v-if="canWrite">
              <button class="link-btn" @click="openTiers(p)">阶梯价</button>
              <button class="link-btn" @click="openEdit(p)">编辑</button>
              <button v-if="p.status === 'active'" class="link-btn danger" @click="disable(p)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无产品</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑产品' : '新增产品' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>产品名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>款号 SKU</label><input class="input" v-model="form.sku" placeholder="唯一" /></div>
            <div class="fitem"><label>品类</label><input class="input" v-model="form.category" /></div>
            <div class="fitem"><label>单位</label><input class="input" v-model="form.unit" /></div>
            <div class="fitem"><label>单价</label><input class="input" type="number" v-model.number="form.price" /></div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.status">
                <option value="active">启用</option><option value="disabled">停用</option>
              </select>
            </div>
            <div class="fitem full"><label>备注</label><textarea v-model="form.remark" rows="2"></textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 阶梯价 -->
    <div v-if="tierModal" class="modal-mask" @click.self="tierModal = false">
      <div class="modal">
        <div class="modal-head">
          <h3>阶梯价 · {{ tierProduct.name }}</h3>
          <button class="x" @click="tierModal = false">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="margin: 0 0 12px; font-size: 12px">
            按订单数量匹配单价（美金）。起始数量升序填写；区间结束数量留空表示「以上」。报价单与下单时会自动取匹配到的价格。
          </p>
          <table class="data">
            <thead>
              <tr><th style="width: 130px">起始数量 ≥</th><th style="width: 130px">结束数量 ≤</th><th style="width: 130px">单价 USD</th><th style="width: 60px"></th></tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in tierRows" :key="i">
                <td><input class="input" type="number" min="1" v-model.number="t.min_qty" /></td>
                <td><input class="input" type="number" min="0" v-model.number="t.max_qty" placeholder="不限" /></td>
                <td><input class="input" type="number" step="0.01" v-model.number="t.price_usd" /></td>
                <td><button class="link-btn danger" @click="tierRows.splice(i, 1)">删除</button></td>
              </tr>
              <tr v-if="!tierRows.length">
                <td colspan="4" class="empty-cell">还没有阶梯，点下方「添加一档」</td>
              </tr>
            </tbody>
          </table>
          <button class="btn btn-ghost btn-sm" style="margin-top: 10px" @click="addTierRow">＋ 添加一档</button>
          <p v-if="tierMsg" class="form-msg" :class="tierErr ? 'err' : 'ok'">{{ tierMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="tierModal = false">关闭</button>
          <button class="btn btn-primary" :disabled="tierSaving" @click="saveTiers">{{ tierSaving ? '保存中…' : '保存阶梯价' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import CsvImport from '../components/CsvImport.vue';

const list = ref([]);
const q = ref('');
const status = ref('');
const canWrite = computed(() => can('product.write'));

const showModal = ref(false);
const saving = ref(false);
const blank = () => ({ id: null, sku: '', name: '', category: '', unit: '件', price: 0, status: 'active', remark: '' });
const form = ref(blank());

async function load() {
  try {
    list.value = await api.products({ q: q.value, status: status.value });
  } catch (e) {
    alert(e.message);
  }
}
function openCreate() {
  form.value = blank();
  showModal.value = true;
}
function openEdit(p) {
  form.value = { ...p };
  showModal.value = true;
}
async function save() {
  if (!form.value.name) return alert('产品名称必填');
  saving.value = true;
  try {
    if (form.value.id) await api.updateProduct(form.value.id, form.value);
    else await api.createProduct(form.value);
    showModal.value = false;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}
async function disable(p) {
  if (!confirm(`确定停用产品「${p.name}」？`)) return;
  try {
    await api.deleteProduct(p.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

// ---------- 阶梯价 ----------
const allTiers = ref([]);
const tierModal = ref(false);
const tierProduct = ref({ id: 0, name: '' });
const tierRows = ref([]);
const tierSaving = ref(false);
const tierMsg = ref('');
const tierErr = ref(false);

function tierCount(pid) {
  return allTiers.value.filter((t) => t.product_id === pid).length;
}

async function loadTiers() {
  try {
    allTiers.value = await api.priceTiers();
  } catch (e) {
    allTiers.value = [];
  }
}

async function openTiers(p) {
  tierProduct.value = { id: p.id, name: p.name };
  tierMsg.value = '';
  tierErr.value = false;
  try {
    const rows = await api.priceTiers(p.id);
    tierRows.value = rows.map((t) => ({ min_qty: t.min_qty, max_qty: t.max_qty || 0, price_usd: t.price_usd }));
  } catch (e) {
    tierRows.value = [];
  }
  if (!tierRows.value.length) {
    tierRows.value = [
      { min_qty: 1, max_qty: 99, price_usd: Number(p.price) || 0 },
      { min_qty: 100, max_qty: 499, price_usd: 0 },
      { min_qty: 500, max_qty: 0, price_usd: 0 }
    ];
  }
  tierModal.value = true;
}

function addTierRow() {
  const last = tierRows.value[tierRows.value.length - 1];
  const nextMin = last ? (Number(last.max_qty) || Number(last.min_qty) || 0) + 1 : 1;
  tierRows.value.push({ min_qty: nextMin, max_qty: 0, price_usd: 0 });
}

async function saveTiers() {
  tierSaving.value = true;
  tierMsg.value = '';
  tierErr.value = false;
  try {
    const rows = tierRows.value
      .filter((t) => Number(t.min_qty) >= 1)
      .map((t) => ({
        min_qty: Number(t.min_qty),
        max_qty: Number(t.max_qty) > 0 ? Number(t.max_qty) : null,
        price_usd: Number(t.price_usd) || 0
      }));
    await api.savePriceTiers(tierProduct.value.id, rows);
    tierMsg.value = `已保存 ${rows.length} 档阶梯价`;
    await loadTiers();
  } catch (e) {
    tierErr.value = true;
    tierMsg.value = e.message;
  } finally {
    tierSaving.value = false;
  }
}

onMounted(() => {
  load();
  loadTiers();
});
</script>
