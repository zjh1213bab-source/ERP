<template>
  <div>
    <div class="page-head">
      <div>
        <h2>工序 / 外发工艺档案</h2>
        <div class="sub">车缝 / 印花 / 绣花 / 洗水 等工序标准档案，开发单与生产工单从这里选，默认单价一起带出；本厂/外发由生产分单确定；每款工序及顺序在打版时单独安排</div>
      </div>
      <button v-action="['craft-types','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增工序</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="seg">
        <button :class="{ on: category === '' }" @click="category = ''; load()">全部</button>
        <button v-for="c in CATS" :key="c.key" :class="{ on: category === c.key }" @click="category = c.key; load()">
          {{ c.label }}
        </button>
      </div>
      <input class="input" v-model="q" placeholder="搜索工序名称" style="width: 240px" @keyup.enter="load" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <span class="hint">共 {{ list.length }} 项</span>
    </div>

    <div class="table-wrap">
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
      <table class="data">
        <thead>
          <tr>
            <th>工序名称</th>
            <th style="width: 90px">类别</th>
            <th style="width: 60px">单位</th>
            <th style="width: 90px">默认单价</th>
            <th style="width: 70px">状态</th>
            <th>说明</th>
            <th v-if="canWrite" style="width: 110px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pagination.rows" :key="r.id">
            <td><strong>{{ r.name }}</strong></td>
            <td><span class="tag purple">{{ catLabel(r.category) }}</span></td>
            <td>{{ r.unit || '-' }}</td>
            <td>{{ r.default_price ? '¥' + Number(r.default_price).toFixed(2) : '-' }}</td>
            <td>
              <span class="tag" :class="r.status === 'active' ? 'green' : 'gray'">{{ r.status === 'active' ? '启用' : '停用' }}</span>
            </td>
            <td class="remark" :title="r.remark">{{ r.remark || '-' }}</td>
            <td v-if="canWrite">
              <button v-action="['craft-types','edit']" class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-action="['craft-types','disable']" v-if="r.status === 'active'" class="link-btn danger" @click="disable(r)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 7 : 6" class="empty-cell">暂无工序类别，点右上角「新增工序」</td></tr>
        </tbody>
      </table>
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
    </div>

    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑工序' : '新增工序' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>工序名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem">
              <label>类别</label>
              <select class="select" v-model="form.category">
                <option v-for="c in CATS" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
            </div>
            <div class="fitem"><label>单位</label><input class="input" v-model="form.unit" placeholder="件 / 米 / 个" /></div>
            <div class="fitem"><label>默认单价</label><input class="input" type="number" step="0.01" v-model.number="form.default_price" /></div>
            <div class="fitem full"><label>说明</label><input class="input" v-model="form.remark" placeholder="工艺要求 / 注意事项" /></div>
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
import ListPagination from '../components/ListPagination.vue';
import { useListPagination } from '../composables/useListPagination';
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const CATS = [
  { key: 'sewing', label: '车缝' },
  { key: 'print', label: '印花' },
  { key: 'embroidery', label: '绣花' },
  { key: 'wash', label: '洗水' },
  { key: 'finish', label: '后整' },
  { key: 'pack', label: '包装' },
  { key: 'other', label: '其他' }
];
const catLabel = (k) => (CATS.find((c) => c.key === k) || {}).label || k || '-';

const list = ref([]);
const q = ref('');
const category = ref('');
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());
const canWrite = computed(() => can('development.write'));

function blank() {
  return { id: null, name: '', category: 'sewing', unit: '件', default_price: 0, is_out: 0, image_url: '', remark: '' };
}

async function load() {
  try { list.value = await api.craftTypes({ q: q.value, category: category.value }); }
  catch (e) { alert(e.message); }
}
function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(r) { form.value = { ...blank(), ...r, is_out: Number(r.is_out) || 0 }; showModal.value = true; }

async function save() {
  if (!form.value.name) return alert('请填写工序名称');
  saving.value = true;
  try {
    const d = { ...form.value };
    delete d.id;
    delete d.code;
    delete d.sort;
    delete d.is_out;
    delete d.image_url;
    if (form.value.id) await api.updateCraftType(form.value.id, d);
    else await api.createCraftType(d);
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function disable(r) {
  if (!confirm(`停用「${r.name}」？`)) return;
  try { await api.deleteCraftType(r.id); await load(); } catch (e) { alert(e.message); }
}

onMounted(load);

const pagination = useListPagination(() => list.value);
</script>

<style scoped>
.hint { font-size: 12px; color: var(--ink-mute); }
.tip { font-weight: 400; font-size: 12px; color: var(--brand); margin-left: 6px; }
.thumb {
  width: 38px; height: 38px; border-radius: 6px; overflow: hidden; background: var(--surface-2);
  border: 1px solid var(--line); display: flex; align-items: center; justify-content: center;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb .ph { font-size: 12px; color: var(--ink-mute); }
.remark { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-wrap { overflow-x: auto; }
table.data { min-width: 920px; }
:deep(.tag) { white-space: nowrap; }
</style>
