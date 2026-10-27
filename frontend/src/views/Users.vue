<template>
  <div>
    <div class="page-head">
      <div>
        <h2>用户与角色</h2>
        <div class="sub">账号、角色权限、启用停用</div>
      </div>
      <button class="btn btn-primary" @click="openCreate">＋ 新增用户</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in list" :key="u.id">
            <td><strong>{{ u.username }}</strong></td>
            <td>{{ u.name || '-' }}</td>
            <td><span class="tag blue">{{ roleLabel(u.role) }}</span></td>
            <td><span class="tag" :class="u.active ? 'green' : 'gray'">{{ u.active ? '启用' : '停用' }}</span></td>
            <td>{{ dateStr(u.created_at) }}</td>
            <td><button class="link-btn" @click="openEdit(u)">编辑</button></td>
          </tr>
          <tr v-if="!list.length"><td colspan="6" class="empty-cell">暂无用户</td></tr>
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
            <div class="fitem full">
              <label>{{ form.id ? '重置密码（留空则不改）' : '密码 *' }}</label>
              <input class="input" type="password" v-model="form.password" autocomplete="new-password" />
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
import { ref, onMounted } from 'vue';
import { api } from '../api';
import { ROLE_LABELS } from '../store/auth';
import { ROLES } from '../store/permissions';

const list = ref([]);
// 角色清单以权限矩阵为准（后端唯一来源 → 前端 perm-table.js），不再手写一份
const roles = ref([...ROLES]);
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());

const roleLabel = (r) => ROLE_LABELS[r] || r;
const dateStr = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');

function blank() { return { id: null, username: '', name: '', role: 'sales', active: 1, password: '' }; }

async function load() {
  try { list.value = await api.users(); } catch (e) { alert(e.message); }
}

function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(u) { form.value = { ...u, password: '' }; showModal.value = true; }

async function save() {
  if (!form.value.username) return alert('请填写账号');
  if (!form.value.id && !form.value.password) return alert('请填写密码');
  saving.value = true;
  try {
    if (form.value.id) {
      await api.updateUser(form.value.id, {
        name: form.value.name,
        role: form.value.role,
        active: form.value.active,
        password: form.value.password || undefined
      });
    } else {
      await api.createUser({
        username: form.value.username,
        password: form.value.password,
        name: form.value.name,
        role: form.value.role
      });
    }
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

onMounted(load);
</script>
