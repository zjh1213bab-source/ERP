<template>
  <div>
    <div class="page-head">
      <div>
        <h2>人事行政</h2>
        <div class="sub">员工档案（部门 / 岗位 / 入职 / 状态）</div>
      </div>
      <div style="display: flex; gap: 8px">
        <button v-if="canWrite" class="btn btn-ghost" :disabled="accountBusy" @click="syncAccounts()">{{ accountBusy ? '同步中…' : '同步员工账号' }}</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openDtImport">从钉钉导入</button>
        <button v-action="['employees','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增员工</button>
      </div>
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

    <ListPagination v-model:page="page" v-model:page-size="pageSize" :total="list.length" />
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th style="width: 52px">头像</th><th>工号</th><th>姓名</th><th>部门</th><th>岗位</th><th>电话</th><th>入职日期</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
        <tbody>
          <tr v-for="e in pagedEmployees" :key="e.id">
            <td><div class="mini-thumb" :class="{ clickable: e.image_url, 'employee-initial': !e.image_url }" :title="e.name || '员工头像'" @click="e.image_url && openImage(e.image_url, e.name || '')"><img v-if="e.image_url" :src="e.image_url" :alt="e.name || '员工头像'" /><span v-else>{{ Array.from((e.name || '').trim())[0] || '员' }}</span></div></td>
            <td>{{ e.code || '-' }}</td>
            <td><strong>{{ e.name }}</strong></td>
            <td>{{ e.department_name || '-' }}</td>
            <td>{{ e.position || '-' }}</td>
            <td>{{ e.phone || '-' }}</td>
            <td>{{ e.hire_date || '-' }}</td>
            <td><span class="tag" :class="e.status === 'active' ? 'green' : 'gray'">{{ e.status === 'active' ? '在职' : '离职' }}</span></td>
            <td v-if="canWrite">
              <button v-action="['employees','edit']" class="link-btn" @click="openEdit(e)">编辑</button>
              <button v-action="['employees','disable']" v-if="e.status === 'active'" class="link-btn danger" @click="leave(e)">离职</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无员工</td></tr>
        </tbody>
      </table>
    </div>

    <ListPagination v-model:page="page" v-model:page-size="pageSize" :total="list.length" />

    <div v-if="showModal" class="modal-mask">
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
    <!-- 从钉钉通讯录导入 -->
    <div v-if="dt.open" class="modal-mask">
      <div class="modal" style="width: 820px; max-width: 94vw">
        <div class="modal-head"><h3>从钉钉导入员工</h3><button class="x" @click="dt.open = false">×</button></div>
        <div class="modal-body">
          <p class="dt-hint">
            钉钉应用需开通「通讯录部门信息读权限」与「通讯录部门成员读权限」，否则会报 60011。
            部门按名称对齐（同名不重复建）；员工按 <b>钉钉 userid → 工号 → 手机</b> 认人，<b>不按姓名合并</b>
            （同名不同人合并会把两人的考勤和工资搅在一起）。
          </p>
          <p v-if="dt.err" class="dt-err">{{ dt.err }}</p>
          <p v-if="dt.busy" class="mut tiny">正在读取钉钉通讯录…</p>

          <template v-if="dt.pv">
            <table class="data" style="margin-bottom: 10px">
              <tbody>
                <tr>
                  <th style="width: 130px">钉钉部门</th>
                  <td>{{ dt.pv.depts_total }} 个，将新建 {{ dt.pv.depts_to_create.length }} 个
                    <span v-if="dt.pv.depts_to_create.length" class="mut tiny">（{{ dt.pv.depts_to_create.join('、') }}）</span>
                  </td>
                </tr>
                <tr>
                  <th>员工</th>
                  <td>共 {{ dt.pv.employees_total }} 人：新增 {{ dt.pv.employees_new }} · 覆盖 {{ dt.pv.employees_update }}
                    <span v-if="dt.pv.problems" class="red"> · {{ dt.pv.problems }} 人资料不全（缺手机/姓名）</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="data">
              <thead><tr><th>姓名</th><th style="width: 90px">工号</th><th style="width: 120px">部门</th><th style="width: 110px">岗位</th><th style="width: 120px">手机</th><th style="width: 70px">动作</th></tr></thead>
              <tbody>
                <tr v-for="s in dt.pv.sample" :key="s.userid">
                  <td>{{ s.name || '—' }}</td>
                  <td class="tiny mut">{{ s.code || '—' }}</td>
                  <td>{{ s.dept_name || '—' }}</td>
                  <td class="mut tiny">{{ s.position || '—' }}</td>
                  <td class="tiny">{{ s.phone || '—' }}</td>
                  <td><span class="tag" :class="s.action === 'new' ? 'green' : 'orange'">{{ s.action === 'new' ? '新增' : '覆盖' }}</span></td>
                </tr>
              </tbody>
            </table>
            <p v-if="dt.pv.employees_total > dt.pv.sample.length" class="mut tiny">仅显示前 {{ dt.pv.sample.length }} 人</p>
          </template>

          <label class="dt-chk">
            <input type="checkbox" v-model="dt.replace" />
            先删除系统里「没有钉钉 userid」的员工（手工造/演示的那些；有考勤、工资或账号依赖时会整批拒绝）
          </label>

          <p v-if="dt.res" class="dt-res">
            已导入：新建部门 {{ dt.res.depts_created }} · 新增员工 {{ dt.res.employees_created }} ·
            覆盖 {{ dt.res.employees_updated }} · 删除旧员工 {{ dt.res.removed }} · 新建账号 {{ dt.res.accounts_created || 0 }}
            <span v-if="dt.res.account_issues?.length" class="red"> · {{ dt.res.account_issues.length }} 个账号待核对：{{ dt.res.account_issues.map(x => x.name + '：' + x.reason).join('；') }}</span>
            <span v-if="dt.res.no_dept" class="mut tiny"> · {{ dt.res.no_dept }} 人只在钉钉根部门（部门留空）</span>
            <span v-if="dt.res.conflicts.length" class="red"> · {{ dt.res.conflicts.length }} 人因 userid/工号/手机对上了不同的人被跳过</span>
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="dt.open = false">关闭</button>
          <button class="btn btn-ghost" :disabled="dt.busy" @click="dtPreview">重新读取</button>
          <button class="btn btn-primary" :disabled="dt.busy || !dt.pv" @click="dtImport">{{ dt.busy ? '处理中…' : '确认导入' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import ImageUpload from '../components/ImageUpload.vue';
import ListPagination from '../components/ListPagination.vue';
import { globalPageSize } from '../composables/useListPagination';

const list = ref([]);
const page = ref(1);
const pageSize = globalPageSize;
const pagedEmployees = computed(() => list.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch(pageSize, () => { page.value = 1; });
const departments = ref([]);
const q = ref('');
const status = ref('');
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());
const canWrite = computed(() => can('employee.write'));
const accountBusy = ref(false);
async function syncAccounts() {
  accountBusy.value = true;
  try {
    const result = await api.syncEmployeeAccounts();
    alert(`新增账号 ${result.created}，更新手机号 ${result.renamed}，保持原账号 ${result.unchanged}，离职停用 ${result.disabled}。` +
      (result.issues?.length ? '\n待核对：\n' + result.issues.map(item => item.name + '：' + item.reason).join('\n') : ''));
  } catch (error) { alert(error.message); }
  finally { accountBusy.value = false; }
}

function blank() { return { id: null, name: '', code: '', department_id: null, position: '', phone: '', hire_date: '', status: 'active', base_salary: 0, remark: '', image_url: '' }; }

async function load() {
  try {
    list.value = await api.employees({ q: q.value, status: status.value });
    // 查询、筛选、导入和保存均重置页码，避免原页码超出结果范围。
    page.value = 1;
  }
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

/* ---- 从钉钉通讯录导入 ---- */
const dt = ref({ open: false, busy: false, replace: false, pv: null, res: null, err: '' });

async function openDtImport() {
  dt.value = { open: true, busy: false, replace: false, pv: null, res: null, err: '' };
  await dtPreview();
}

async function dtPreview() {
  dt.value.busy = true;
  dt.value.err = '';
  dt.value.res = null;
  try { dt.value.pv = await api.dingtalkContactsPreview(); }
  catch (e) { dt.value.pv = null; dt.value.err = e.message; }
  finally { dt.value.busy = false; }
}

async function dtImport() {
  if (dt.value.replace && !confirm('将先删除系统里没有钉钉 userid 的员工，确认继续？')) return;
  dt.value.busy = true;
  dt.value.err = '';
  try {
    dt.value.res = await api.dingtalkContactsImport({ replace: dt.value.replace });
    await loadDepts();
    await load();
  } catch (e) { dt.value.err = e.message; }
  finally { dt.value.busy = false; }
}

onMounted(async () => {
  await loadDepts();
  await load();
});
</script>

<style scoped>
.employee-initial { background: rgba(49, 94, 232, 0.1); color: var(--brand); border-color: rgba(49, 94, 232, 0.18); font-size: 16px; font-weight: 700; }
.dt-hint { background: var(--surface-2); border: 1px solid #e6ebf3; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.7; color: var(--ink); margin: 0 0 10px; }
.dt-err { background: #fff1f0; border: 1px solid #ffc9c4; color: #b42318; font-size: 12px; line-height: 1.7; padding: 10px 12px; border-radius: 8px; margin: 0 0 10px; }
.dt-chk { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--ink); margin-top: 10px; line-height: 1.6; }
.dt-chk input { margin-top: 2px; }
.dt-res { background: #f0f9f2; border: 1px solid #bfe3c8; color: #1a6b32; font-size: 12px; padding: 10px 12px; border-radius: 8px; margin: 10px 0 0; }
</style>
