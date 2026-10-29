<template>
  <div>
    <div class="page-head">
      <div>
        <h2>用户与角色</h2>
        <div class="sub">账号、角色权限、启用停用、公司主体归属</div>
      </div>
      <button class="btn btn-primary" @click="openCreate">＋ 新增用户</button>
    </div>

    <!--
      未归属提醒：这类账号在多主体模式下会被直接拒绝访问（不是"少看几条"），
      与其等人投诉"登进去什么都点不了"，不如在列表上方就说清楚。
    -->
    <div v-if="missingCompany.length" class="warn-bar">
      <strong>{{ missingCompany.length }} 个账号没有公司主体归属：</strong>
      {{ missingCompany.map(u => u.username).join('、') }}
      <span class="muted">—— 多主体模式下这些账号会被拒绝访问，请在编辑里指定公司</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>账号</th><th>姓名</th><th>角色</th>
            <th v-if="!single">公司主体</th>
            <th>状态</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in list" :key="u.id">
            <td><strong>{{ u.username }}</strong></td>
            <td>{{ u.name || '-' }}</td>
            <td><span class="tag blue">{{ roleLabel(u.role) }}</span></td>
            <td v-if="!single">
              <span class="tag" :class="u.company_missing ? 'red' : 'gray'">
                {{ u.company_name || '未指定' }}
              </span>
            </td>
            <td><span class="tag" :class="u.active ? 'green' : 'gray'">{{ u.active ? '启用' : '停用' }}</span></td>
            <td>{{ dateStr(u.created_at) }}</td>
            <td><button class="link-btn" @click="openEdit(u)">编辑</button></td>
          </tr>
          <tr v-if="!list.length">
            <td :colspan="single ? 6 : 7" class="empty-cell">暂无用户</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-head"><h3>{{ form.id ? '编辑用户' : '新增用户' }}</h3><button class="x" @click="showModal = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>账号 *</label><input class="input" v-model="form.username" :disabled="!!form.id" /></div>
            <div class="fitem"><label>姓名</label><input class="input" v-model="form.name" /></div>
            <div class="fitem">
              <label>角色 *</label>
              <select class="select" v-model="form.role">
                <option v-for="r in roles" :key="r" :value="r">{{ roleLabel(r) }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.active">
                <option :value="1">启用</option><option :value="0">停用</option>
              </select>
            </div>
            <!-- 单公司模式只有一个主体，不摆一个只有一项的下拉（会让人以为选错了） -->
            <div v-if="!single" class="fitem">
              <label>公司主体 {{ form.id ? '' : '*' }}</label>
              <select class="select" v-model="form.company_id">
                <option :value="null">（未指定 — 不推荐）</option>
                <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <div class="hint">决定这个账号能看到哪些主体的数据；不确定就选本公司。</div>
            </div>
            <div v-else class="fitem">
              <label>公司主体</label>
              <div class="readonly-box">{{ headerName || '本公司' }}<span class="muted">（单公司模式，不可选）</span></div>
            </div>
            <div class="fitem full">
              <label>{{ form.id ? '重置密码（留空则不改）' : '密码 *' }}</label>
              <input class="input" type="password" v-model="form.password" autocomplete="new-password" />
              <div v-if="form.id" class="hint">改密码 / 停用 / 改角色 / 换主体都会让该账号已登录的会话立即失效。</div>
            </div>
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
import { ROLE_LABELS } from '../store/auth';
import { ROLES } from '../store/permissions';

const list = ref([]);
// 角色清单以权限矩阵为准（后端唯一来源 → 前端 perm-table.js），不再手写一份
const roles = ref([...ROLES]);
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());

/**
 * 单公司模式与主体清单都从后端取，前端不自己猜
 *
 * `single` 决定要不要显示「公司主体」这一列/这一项；单公司模式下显示一个
 * 只有一项的下拉，用户会以为是自己漏选了别的主体。
 */
const single = ref(true);
const headerName = ref('');
const companies = ref([]);

const roleLabel = (r) => ROLE_LABELS[r] || r;
const dateStr = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');
const missingCompany = computed(() => list.value.filter((u) => u.company_missing && u.active));

function blank() {
  return { id: null, username: '', name: '', role: 'sales', active: 1, password: '', company_id: null };
}

async function loadMeta() {
  try {
    const s = await api.settings();
    single.value = s.single_company !== false;
    headerName.value = (s.company_header && (s.company_header.short_name || s.company_header.name)) || '';
  } catch (e) { /* 取不到就按单公司处理（更保守：不让人误选主体） */ }
  if (!single.value) {
    try {
      const d = await api.groupDict();
      companies.value = d.companies || [];
    } catch (e) { companies.value = []; }
  }
}

async function load() {
  try { list.value = await api.users(); } catch (e) { alert(e.message); }
}

function openCreate() {
  form.value = blank();
  // 默认落在本公司/当前默认主体上，避免"新建即无归属"
  if (!single.value && companies.value.length) {
    const own = companies.value[0];
    form.value.company_id = own ? own.id : null;
  }
  showModal.value = true;
}
function openEdit(u) { form.value = { ...u, password: '' }; showModal.value = true; }

async function save() {
  if (!form.value.username) return alert('请填写账号');
  if (!form.value.id && !form.value.password) return alert('请填写密码');
  saving.value = true;
  try {
    if (form.value.id) {
      const body = {
        name: form.value.name,
        role: form.value.role,
        active: form.value.active,
        password: form.value.password || undefined
      };
      // 只有多主体模式才带主体；单公司模式后端会忽略，但少传一个字段少一层误会
      if (!single.value && form.value.company_id) body.company_id = form.value.company_id;
      const out = await api.updateUser(form.value.id, body);
      if (out && out.token_revoked) {
        // 权限/密码变了 → 旧令牌作废。这里只提示，不影响管理员自己的会话。
        console.info('该账号已登录的会话已失效（角色/状态/密码/主体有变更）');
      }
    } else {
      const body = {
        username: form.value.username,
        password: form.value.password,
        name: form.value.name,
        role: form.value.role
      };
      if (!single.value && form.value.company_id) body.company_id = form.value.company_id;
      await api.createUser(body);
    }
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

onMounted(async () => { await loadMeta(); await load(); });
</script>

<style scoped>
.warn-bar {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  font-size: 13px;
  color: #874d00;
}
.readonly-box {
  padding: 7px 10px;
  border: 1px dashed #d9d9d9;
  border-radius: 4px;
  background: #fafafa;
  font-size: 13px;
}
.hint { margin-top: 4px; font-size: 12px; color: #8c8c8c; }
</style>
