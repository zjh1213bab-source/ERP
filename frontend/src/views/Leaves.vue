<template>
  <div>
    <div class="page-head">
      <div>
        <h2>请假管理</h2>
        <div class="sub">员工请假申请与审批</div>
      </div>
      <button v-action="['leaves','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增请假</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="pending">待审批</option>
        <option value="approved">已通过</option>
        <option value="rejected">已驳回</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>员工</th><th>类型</th><th>开始</th><th>结束</th><th>天数</th><th>事由</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td><strong>{{ r.employee_name }}</strong></td>
            <td>{{ typeLabel(r.type) }}</td>
            <td>{{ r.start_date || '-' }}</td>
            <td>{{ r.end_date || '-' }}</td>
            <td>{{ r.days }}</td>
            <td>{{ r.reason || '-' }}</td>
            <td><span class="tag" :class="r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'orange'">{{ statusLabel(r.status) }}</span></td>
            <td v-if="canWrite">
              <button v-if="r.status === 'pending'" class="link-btn" @click="review(r, true)">通过</button>
              <button  v-if="r.status === 'pending'" class="link-btn danger" @click="review(r, false)">驳回</button>
              <button class="link-btn danger" @click="remove(r)">删</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无请假记录</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>新增请假</h3><button class="x" @click="showModal = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>员工 *</label>
              <select class="select" v-model.number="form.employee_id">
                <option :value="null">— 选择 —</option>
                <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.name }}（{{ e.department_name || '未分配' }}）</option>
              </select>
            </div>
            <div class="fitem">
              <label>类型</label>
              <select class="select" v-model="form.type">
                <option value="annual">年假</option><option value="sick">病假</option><option value="personal">事假</option><option value="other">其他</option>
              </select>
            </div>
            <div class="fitem"><label>开始</label><input class="input" type="date" v-model="form.start_date" /></div>
            <div class="fitem"><label>结束</label><input class="input" type="date" v-model="form.end_date" /></div>
            <div class="fitem"><label>天数</label><input class="input" type="number" step="0.5" v-model.number="form.days" /></div>
            <div class="fitem full"><label>事由</label><input class="input" v-model="form.reason" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '提交' }}</button>
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
const employees = ref([]);
const status = ref('');
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());
const canWrite = computed(() => can('leave.write'));

function blank() { return { employee_id: null, type: 'annual', start_date: '', end_date: '', days: 1, reason: '' }; }
const TYPE = { annual: '年假', sick: '病假', personal: '事假', other: '其他' };
const typeLabel = (t) => TYPE[t] || t;
const S = { pending: '待审批', approved: '已通过', rejected: '已驳回' };
const statusLabel = (s) => S[s] || s;

async function load() {
  try { list.value = await api.leaves({ status: status.value }); }
  catch (e) { alert(e.message); }
}
async function loadEmployees() {
  try { employees.value = await api.employees({ status: 'active' }); } catch (e) { /* ignore */ }
}

function openCreate() { form.value = blank(); showModal.value = true; }
async function save() {
  if (!form.value.employee_id) return alert('请选择员工');
  saving.value = true;
  try { await api.createLeave(form.value); showModal.value = false; await load(); }
  catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function review(r, approve) {
  try { await api.reviewLeave(r.id, approve); await load(); } catch (e) { alert(e.message); }
}
async function remove(r) {
  if (!confirm('删除该请假记录？')) return;
  try { await api.deleteLeave(r.id); await load(); } catch (e) { alert(e.message); }
}

onMounted(async () => {
  await loadEmployees();
  await load();
});
</script>
