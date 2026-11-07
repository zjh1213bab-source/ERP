<template>
  <div>
    <div class="page-head">
      <div>
        <h2>供应商档案</h2>
        <div class="sub">面辅料 / 加工 / 服务供应商统一维护，开发单与采购从这里调用</div>
      </div>
      <button v-action="['suppliers','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增供应商</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <select class="select" v-model="category" @change="load">
        <option value="">全部类型</option>
        <option v-for="c in CATS" :key="c.key" :value="c.key">{{ c.label }}</option>
      </select>
      <input class="input" v-model="q" placeholder="搜索 名称 / 编号 / 简称 / 联系人 / 电话" style="width: 300px" @keyup.enter="load" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <span class="hint">共 {{ list.length }} 家</span>
    </div>

    <div class="table-wrap">
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
      <table class="data">
        <thead>
          <tr>
            <th style="width: 58px">图片</th>
            <th style="width: 90px">编号</th>
            <th>供应商名称</th>
            <th style="width: 90px">简称</th>
            <th style="width: 110px">类型</th>
            <th style="width: 90px">联系人</th>
            <th style="width: 120px">电话</th>
            <th>地址</th>
            <th style="width: 110px">结算方式</th>
            <th style="width: 70px">交期</th>
            <th style="width: 70px">状态</th>
            <th v-if="canWrite" style="width: 110px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in pagination.rows" :key="s.id">
            <td>
              <div class="thumb" :class="{ clickable: s.image_url }" @click="s.image_url && openImage(s.image_url, s.name || '')">
                <img v-if="s.image_url" :src="s.image_url" />
                <span v-else class="ph">-</span>
              </div>
            </td>
            <td>{{ s.code || '-' }}</td>
            <td><strong>{{ s.name }}</strong></td>
            <td class="nw">{{ s.short_name || '-' }}</td>
            <td class="nw"><span class="tag blue">{{ catLabel(s.category) }}</span></td>
            <td>{{ s.contact || '-' }}</td>
            <td>{{ s.phone || '-' }}</td>
            <td class="addr" :title="s.address">{{ s.address || '-' }}</td>
            <td class="nw">{{ s.payment_terms || '-' }}</td>
            <td class="nw">{{ s.lead_days ? s.lead_days + ' 天' : '-' }}</td>
            <td class="nw">
              <span class="tag" :class="s.status === 'active' ? 'green' : 'gray'">{{ s.status === 'active' ? '启用' : '停用' }}</span>
            </td>
            <td v-if="canWrite">
              <button v-action="['suppliers','edit']" class="link-btn" @click="openEdit(s)">编辑</button>
              <button v-action="['suppliers','disable']" v-if="s.status === 'active'" class="link-btn danger" @click="disable(s)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 12 : 11" class="empty-cell">暂无供应商，点右上角「新增供应商」</td></tr>
        </tbody>
      </table>
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
    </div>

    <div v-if="showModal" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑供应商' : '新增供应商' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>图片 <span class="tip">支持 Ctrl+V 直接粘贴</span></label>
              <ImageUpload v-model="form.image_url" size="lg" />
            </div>
            <div class="fitem"><label>供应商编号</label><input class="input" v-model="form.code" /></div>
            <div class="fitem"><label>供应商名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>简称</label><input class="input" v-model="form.short_name" /></div>
            <div class="fitem">
              <label>类型</label>
              <select class="select" v-model="form.category">
                <option v-for="c in CATS" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
            </div>
            <div class="fitem"><label>联系人</label><input class="input" v-model="form.contact" /></div>
            <div class="fitem"><label>电话</label><input class="input" v-model="form.phone" /></div>
            <div class="fitem full"><label>地址</label><input class="input" v-model="form.address" /></div>
            <div class="fitem"><label>结算方式</label><input class="input" v-model="form.payment_terms" placeholder="月结30天 / 现结" /></div>
            <div class="fitem"><label>交货周期（天）</label><input class="input" type="number" v-model.number="form.lead_days" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="form.remark" /></div>
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
import { useRoute } from 'vue-router';
const route = useRoute();
import { can } from '../store/permissions';
import ImageUpload from '../components/ImageUpload.vue';

const CATS = [
  { key: 'material', label: '面辅料' },
  { key: 'process', label: '加工' },
  { key: 'service', label: '服务' },
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
  return {
    id: null, code: '', name: '', short_name: '', category: 'material', contact: '',
    phone: '', address: '', payment_terms: '', lead_days: 0, image_url: '', remark: ''
  };
}

async function load() {
  try { list.value = await api.suppliers({ q: q.value, category: category.value }); }
  catch (e) { alert(e.message); }
}
function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(s) { form.value = { ...blank(), ...s }; showModal.value = true; }

async function save() {
  if (!form.value.name) return alert('请填写供应商名称');
  saving.value = true;
  try {
    const d = { ...form.value };
    delete d.id;
    if (form.value.id) await api.updateSupplier(form.value.id, d);
    else await api.createSupplier(d);
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function disable(s) {
  if (!confirm(`停用「${s.name}」？`)) return;
  try { await api.deleteSupplier(s.id); await load(); } catch (e) { alert(e.message); }
}

onMounted(async () => { await load(); if (route.query.create === '1') openCreate(); });

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
.addr { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.tag) { white-space: nowrap; }
/* 窄列锁死不换行：否则视口一窄就被压成竖排单字 */
.nw { white-space: nowrap; }
:deep(.nw .tag) { padding: 2px 6px; }
/* 12 列的宽表：不设 min-width 会被容器压成竖排 */
.table-wrap { overflow-x: auto; }
table.data { min-width: 1280px; }
</style>
