<template>
  <div>
    <div class="page-head">
      <div>
        <h2>人事行政</h2>
        <div class="sub">员工档案（部门 / 岗位 / 入职 / 状态）</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增员工</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索 姓名 / 工号 / 岗位" @keyup.enter="load" style="width: 240px" />
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="active">在职</option>
        <option value="left">离职</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th style="width: 52px">图片</th><th>工号</th><th>姓名</th><th>部门</th><th>岗位</th><th>电话</th><th>入职日期</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
        <tbody>
          <tr v-for="e in list" :key="e.id">
            <td><div class="mini-thumb" :class="{ clickable: e.image_url }" @click="e.image_url && openImage(e.image_url, e.name || '')"><img v-if="e.image_url" :src="e.image_url" /><span v-else>-</span></div></td>
            <td>{{ e.code || '-' }}</td>
            <td><strong>{{ e.name }}</strong></td>
            <td>{{ e.department_name || '-' }}</td>
            <td>{{ e.position || '-' }}</td>
            <td>{{ e.phone || '-' }}</td>
            <td>{{ e.hire_date || '-' }}</td>
            <td><span class="tag" :class="e.status === 'active' ? 'green' : 'gray'">{{ e.status === 'active' ? '在职' : '离职' }}</span></td>
            <td v-if="canWrite">
              <button class="link-btn" @click="openEdit(e)">编辑</button>
              <button v-if="e.status === 'active'" class="link-btn danger" @click="leave(e)">离职</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无员工</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-head"><h3>{{ form.id ? '编辑员工' : '新增员工' }}</h3><button class="x" @click="showModal = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>员工照片 <span class="paste-tip">支持 Ctrl+V 直接粘贴图片</span></label>
              <ImageUpload v-model="form.image_url" size="lg" />
            </div>

            <div class="fitem"><label>姓名 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>工号</label><input class="input" v-model="form.code" /></div>
            <div class="fitem">
              <label>部门</label>
              <select class="select" v-model.number="form.department_id">
                <option :value="null">— 未分配 —</option>
                <option v-for="dp in departments" :key="dp.id" :value="dp.id">{{ dp.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>岗位</label><input class="input" v-model="form.position" /></div>
            <div class="fitem"><label>电话</label><input class="input" v-model="form.phone" /></div>
            <div class="fitem"><label>入职日期</label><input class="input" type="date" v-model="form.hire_date" /></div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.status"><option value="active">在职</option><option value="left">离职</option></select>
            </div>
            <div class="fitem"><label>基本工资（元/月）</label><input class="input" type="number" step="0.01" v-model.number="form.base_salary" /></div>
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
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import ImageUpload from '../components/ImageUpload.vue';

const list = ref([]);
const departments = ref([]);
const q = ref('');
const status = ref('');
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());
const canWrite = computed(() => can('employee.write'));

function blank() { return { id: null, name: '', code: '', department_id: null, position: '', phone: '', hire_date: '', status: 'active', base_salary: 0, remark: '', image_url: '' }; }

async function load() {
  try { list.value = await api.employees({ q: q.value, status: status.value }); }
  catch (e) { alert(e.message); }
}
async function loadDepts() {
  try { departments.value = await api.departments(); } catch (e) { /* ignore */ }
}
function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(e) { form.value = { ...e }; showModal.value = true; }

async function save() {
  if (!form.value.name) return alert('请填写姓名');
  saving.value = true;
  try {
    if (form.value.id) await api.updateEmployee(form.value.id, form.value);
    else await api.createEmployee(form.value);
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function leave(e) {
  if (!confirm(`确认「${e.name}」离职？`)) return;
  try { await api.deleteEmployee(e.id); await load(); } catch (err) { alert(err.message); }
}

onMounted(async () => {
  await loadDepts();
  await load();
});
</script>
