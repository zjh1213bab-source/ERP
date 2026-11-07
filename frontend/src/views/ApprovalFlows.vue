<template>
  <div>
    <div class="page-head">
      <div>
        <h2>审批流配置</h2>
        <div class="sub">按金额区间配置多级审批步骤（当前支持成本单）</div>
      </div>
      <button v-action="['approval-flows','create']" class="btn btn-primary" @click="openCreate">＋ 新增流程</button>
    </div>

    <div class="table-wrap">
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
      <table class="data">
        <thead><tr><th>名称</th><th>目标</th><th>金额区间</th><th>审批步骤</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="f in pagination.rows" :key="f.id">
            <td><strong>{{ f.name }}</strong></td>
            <td>{{ f.target_type === 'cost' ? '成本单' : f.target_type }}</td>
            <td>¥{{ money(f.min_amount) }} ~ ¥{{ money(f.max_amount) }}</td>
            <td>{{ f.steps.map((s) => s.name).join(' → ') }}</td>
            <td><span class="tag" :class="f.active ? 'green' : 'gray'">{{ f.active ? '启用' : '停用' }}</span></td>
            <td>
              <button v-action="['approval-flows','edit']" class="link-btn" @click="openEdit(f)">编辑</button>
              <button v-action="['approval-flows','disable']"  v-if="f.active" class="link-btn danger" @click="disable(f)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td colspan="6" class="empty-cell">暂无流程</td></tr>
        </tbody>
      </table>
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
    </div>

    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>{{ form.id ? '编辑流程' : '新增流程' }}</h3><button class="x" @click="showModal = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>目标类型</label><select class="select" v-model="form.target_type"><option value="cost">成本单</option><option value="payment">付款申请</option><option value="order_change">客户订单变更</option></select></div>
            <div class="fitem"><label>金额下限</label><input class="input" type="number" v-model.number="form.min_amount" /></div>
            <div class="fitem"><label>金额上限</label><input class="input" type="number" v-model.number="form.max_amount" /></div>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">审批步骤（从上到下依次）</h3>
          <div v-for="(s, i) in form.steps" :key="i" class="row" style="margin-bottom: 8px">
            <div class="fitem" style="width: 150px"><label>角色</label>
              <select class="select" v-model="s.role">
                <option v-for="r in roles" :key="r" :value="r">{{ roleLabel(r) }}</option>
              </select>
            </div>
            <div class="fitem" style="flex: 1; margin: 0"><label>节点名称</label><input class="input" v-model="s.name" placeholder="如 财务审核" /></div>
            <button class="link-btn danger" @click="removeStep(i)" :disabled="form.steps.length === 1">删</button>
          </div>
          <button class="btn btn-ghost btn-sm" @click="addStep">＋ 加一级</button>
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
import { ref, onMounted } from 'vue';
import { api } from '../api';
import { ROLE_LABELS } from '../store/auth';
import { ROLES } from '../store/permissions';

const list = ref([]);
const showModal = ref(false);
const saving = ref(false);
// 审批步骤的角色取值与权限矩阵保持一致（否则新增岗位配不出审批流）
const roles = [...ROLES];
const form = ref(blank());

const roleLabel = (r) => ROLE_LABELS[r] || r;
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });

function blank() {
  return { id: null, name: '', target_type: 'cost', min_amount: 0, max_amount: 999999999, steps: [{ role: 'finance', name: '财务审核' }] };
}

async function load() {
  try { list.value = await api.approvalFlows(); } catch (e) { alert(e.message); }
}
function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(f) { form.value = { ...f, steps: JSON.parse(JSON.stringify(f.steps)) }; showModal.value = true; }
function addStep() { form.value.steps.push({ role: 'admin', name: '总经理审批' }); }
function removeStep(i) { if (form.value.steps.length > 1) form.value.steps.splice(i, 1); }

async function save() {
  if (!form.value.name) return alert('请填写名称');
  saving.value = true;
  try {
    if (form.value.id) await api.updateApprovalFlow(form.value.id, form.value);
    else await api.createApprovalFlow(form.value);
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function disable(f) {
  if (!confirm(`停用流程「${f.name}」？`)) return;
  try { await api.deleteApprovalFlow(f.id); await load(); } catch (e) { alert(e.message); }
}

onMounted(load);

const pagination = useListPagination(() => list.value);
</script>
