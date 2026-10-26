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
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>款号</th><th>产品名称</th><th>品类</th><th>单位</th><th>单价</th><th>状态</th>
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
              <span class="tag" :class="p.status === 'active' ? 'green' : 'gray'">
                {{ p.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td v-if="canWrite">
              <button class="link-btn" @click="openEdit(p)">编辑</button>
              <button v-if="p.status === 'active'" class="link-btn danger" @click="disable(p)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td :colspan="canWrite ? 7 : 6" class="empty-cell">暂无产品</td>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { hasRole } from '../store/auth';

const list = ref([]);
const q = ref('');
const status = ref('');
const canWrite = computed(() => hasRole('sales', 'tech'));

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

onMounted(load);
</script>
