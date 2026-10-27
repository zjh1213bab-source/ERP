<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>权限复核</h2>
        <p class="sub">
          这一页回答三个问题：<b>每个岗位到底能点什么</b>、<b>具体某个人跟同岗位差在哪</b>、<b>有没有一个人同时握着本该分开的两件事</b>。
          岗位默认权限由后端 <code>access/permissions.js</code> 统一给出；一人多岗取并集；个别差异用「收回」处理，<b>必须写理由</b>——半年后要能解释为什么这个人跟别人不一样。
          复核完点右上角<b>复核签字</b>，把当时的账号数、例外数、冲突数一起存档。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="load">刷新</button>
        <button v-if="isAdmin" class="btn" @click="openSign">复核签字</button>
      </div>
    </div>

    <div class="cards">
      <div class="stat-card accent">
        <div class="label">在册账号</div>
        <div class="value">{{ s.users || 0 }}<small>人</small></div>
      </div>
      <div class="stat-card">
        <div class="label">权限点</div>
        <div class="value">{{ s.perms || 0 }}<small>个</small></div>
      </div>
      <div class="stat-card">
        <div class="label">用户级例外</div>
        <div class="value">{{ s.exceptions || 0 }}<small>条</small></div>
      </div>
      <div class="stat-card">
        <div class="label">职责分离冲突</div>
        <div class="value" :style="{ color: s.conflicts ? '#d92d45' : '#16a34a' }">
          {{ s.conflicts || 0 }}<small>条 / 涉及 {{ s.conflict_users || 0 }} 人</small>
        </div>
      </div>
    </div>

    <div class="tabs mine">
      <button :class="{ on: tab === 'matrix' }" @click="tab = 'matrix'">岗位矩阵</button>
      <button :class="{ on: tab === 'users' }" @click="tab = 'users'">账号复核</button>
      <button :class="{ on: tab === 'sod' }" @click="tab = 'sod'">职责分离</button>
      <button :class="{ on: tab === 'history' }" @click="tab = 'history'; loadReviews()">复核记录</button>
    </div>

    <!-- ============ 岗位矩阵 ============ -->
    <div v-if="tab === 'matrix'" class="panel-card">
      <div class="io-row">
        <input v-model="kw" class="input" placeholder="搜权限点，如 craft / payroll / 库存" style="max-width: 320px" />
        <span class="tiny muted">共 {{ filteredPerms.length }} 个权限点 · 带 <span class="tag red">核</span> 的表示已在后端按高危路由拦截</span>
      </div>
      <div class="table-wrap" style="margin-top: 12px; overflow-y: auto; max-height: 900px">
        <table class="data matrix">
          <thead>
            <tr>
              <th style="text-align: left; min-width: 190px">权限点</th>
              <th v-for="r in roles" :key="r.code">
                {{ r.label }}<i v-if="r.code === 'admin'" class="hint">恒通过</i>
              </th>
            </tr>
            <tr class="count-row">
              <th style="text-align: left">该岗位权限数</th>
              <th v-for="r in roles" :key="r.code">{{ r.perm_count }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filteredPerms" :key="p.perm">
              <td style="text-align: left">
                <code class="perm">{{ p.perm }}</code>
                <span v-if="p.guarded" class="tag red" style="margin-left: 6px">核</span>
              </td>
              <td v-for="r in roles" :key="r.code">
                <span v-if="r.code === 'admin' || p.roles.includes(r.code)" class="yes">✓</span>
                <span v-else class="no">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============ 账号复核 ============ -->
    <div v-if="tab === 'users'">
      <div v-for="u in users" :key="u.id" class="panel-card user-card">
        <div class="uc-head" @click="toggle(u.id)">
          <div class="uc-main">
            <b>{{ u.name || u.username }}</b>
            <span class="tiny muted">{{ u.username }}</span>
            <span class="tag blue">{{ u.role_label }}</span>
            <span v-for="r in u.roles.filter((x) => x !== u.role)" :key="r" class="tag purple">
              兼 {{ roleLabel(r) }}
            </span>
            <span v-if="!u.active" class="tag gray">已停用</span>
          </div>
          <div class="uc-right">
            <span class="tiny muted">
              {{ u.isAdmin ? '恒通过' : u.perms.length + ' 个权限点' }}
            </span>
            <span v-if="u.exceptions.length" class="tag orange">{{ u.exceptions.length }} 条例外</span>
            <span class="tiny muted">{{ open[u.id] ? '收起' : '展开' }}</span>
          </div>
        </div>

        <div v-if="open[u.id]" class="uc-body">
          <div v-if="u.role === 'boss'" class="ro-note">
            只读岗位：没有任何业务录入权限，可以查看全部经营数据。需要他签字时走审批流，不靠按钮。
          </div>
          <div class="uc-cols">
            <div class="uc-col">
              <h5>生效权限（{{ u.isAdmin ? '全部' : u.perms.length }}）</h5>
              <div class="perm-cloud">
                <span
                  v-for="p in cloudOf(u)"
                  :key="p"
                  class="perm-chip"
                  :class="{ off: u.deny.includes(p) }"
                >{{ p }}</span>
                <span v-if="!u.isAdmin && !u.perms.length" class="tiny muted">无写权限（只读岗位）</span>
              </div>
            </div>
            <div class="uc-col side">
              <h5>与同岗位的差异</h5>
              <div v-if="!u.exceptions.length" class="tiny muted">无例外，完全按岗位默认</div>
              <div v-for="e in u.exceptions" :key="e.id" class="exc-row">
                <span class="tag" :class="e.effect === 'deny' ? 'red' : 'green'">
                  {{ e.effect === 'deny' ? '收回' : '放开' }}
                </span>
                <code class="perm">{{ e.perm }}</code>
                <div class="exc-reason">{{ e.reason }}</div>
                <button v-if="isAdmin" class="link-btn" @click="delExc(e)">撤销</button>
              </div>

              <div v-if="isAdmin" class="exc-form">
                <div class="tiny muted" style="margin-bottom: 6px">给这个账号单独调整一条</div>
                <select v-model="form.perm" class="input">
                  <option value="">选择权限点…</option>
                  <option v-for="p in (u.base.length ? u.base : allPerms)" :key="p" :value="p">{{ p }}</option>
                </select>
                <select v-model="form.effect" class="input" style="margin-top: 6px">
                  <option value="deny">收回（这个人不该有）</option>
                  <option value="allow">放开（有收回记录，但确认可以给他）</option>
                </select>
                <input v-model="form.reason" class="input" placeholder="理由（必填，写清为什么跟别人不一样）" style="margin-top: 6px" />
                <button class="btn" style="margin-top: 6px" :disabled="!form.perm || !form.reason" @click="saveExc(u)">
                  保存
                </button>
              </div>

              <div v-if="isAdmin" class="exc-form">
                <div class="tiny muted" style="margin-bottom: 6px">一人多岗（附加岗，与主岗取并集）</div>
                <div class="role-picks">
                  <button
                    v-for="r in roleOptions"
                    :key="r.code"
                    class="role-pick"
                    :class="{ on: draftRoles[u.id] && draftRoles[u.id].includes(r.code) }"
                    @click="toggleRole(u, r.code)"
                  >{{ r.label }}</button>
                </div>
                <button class="btn btn-ghost" style="margin-top: 8px" @click="saveRoles(u)">保存附加岗</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 职责分离 ============ -->
    <div v-if="tab === 'sod'">
      <div class="panel-card" style="padding: 14px 18px">
        <div class="tiny muted">
          判据：同一个账号同时握住左右两件事。<b>这里是提示，不是禁止</b>——小企业常常一个人干两份，
          直接拦死会让系统没法用。做法是识别出来、留痕、上补偿性控制（下面每条都给了建议）。
        </div>
      </div>
      <div v-for="x in sod" :key="x.rule.code" class="panel-card sod-card" :class="{ hit: x.hit }">
        <div class="sod-head">
          <span class="tag" :class="x.hit ? 'red' : 'green'">{{ x.hit ? '有冲突' : '无冲突' }}</span>
          <b>{{ x.rule.code }} · {{ x.rule.name }}</b>
          <span class="tiny muted">{{ x.rule.perm_a }} ↔ {{ x.rule.perm_b }}</span>
        </div>
        <div class="sod-body">
          <div v-if="x.hit" class="sod-users">
            <span v-for="u in x.users" :key="u.id" class="tag orange">{{ u.name || u.username }}</span>
            <span class="tiny muted">（A 侧 {{ x.holders_a }} 人 / B 侧 {{ x.holders_b }} 人）</span>
          </div>
          <div v-if="!x.hit" class="sod-users">
            <span class="tag green">非管理员账号无冲突</span>
            <span v-if="x.admin_holds" class="tiny muted">（系统管理员恒通过同时持有两端，不单独计数）</span>
          </div>
          <div class="sod-note">风险：{{ x.rule.note }}</div>
          <div class="sod-note">补偿建议：{{ x.rule.compensate }}</div>
        </div>
      </div>
    </div>

    <!-- ============ 复核记录 ============ -->
    <div v-if="tab === 'history'">
      <div class="table-wrap" style="overflow-y: auto">
        <table class="data">
          <thead>
            <tr>
              <th>编号</th>
              <th>周期</th>
              <th>范围</th>
              <th>账号</th>
              <th>例外</th>
              <th>冲突</th>
              <th>确认人</th>
              <th>时间</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in reviews" :key="r.id">
              <td><code class="perm">{{ r.review_no }}</code></td>
              <td>{{ r.period || '—' }}</td>
              <td class="tiny">{{ r.scope || '—' }}</td>
              <td>{{ r.users_total }}</td>
              <td>{{ r.exceptions_count }}</td>
              <td>{{ r.conflicts_count }}</td>
              <td>{{ r.signed_off_by || '未签字' }}</td>
              <td class="tiny">{{ r.signed_off_at || r.created_at }}</td>
              <td class="tiny">{{ r.note || '—' }}</td>
            </tr>
            <tr v-if="!reviews.length">
              <td colspan="9" class="tiny muted" style="text-align: center; padding: 20px">
                还没有复核记录。做完这一轮复核后点右上角「复核签字」留档。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 签字弹窗 -->
    <div v-if="sign.show" class="modal-mask" @click.self="sign.show = false">
      <div class="modal-box">
        <h3>复核签字</h3>
        <p class="tiny muted">
          签字会把<b>当前时点</b>的账号数、例外明细、冲突数一起存下来。以后有人问「当时是谁确认的」，翻这条记录。
        </p>
        <label>复核周期</label>
        <input v-model="sign.period" class="input" placeholder="如 2026Q4 / 上线前复核" />
        <label>复核范围</label>
        <input v-model="sign.scope" class="input" placeholder="如 全部在册账号（含多岗与例外）" />
        <label>确认人 <i class="req">*</i></label>
        <input v-model="sign.signed_off_by" class="input" placeholder="总经理 / 财务负责人姓名" />
        <label>说明</label>
        <input v-model="sign.note" class="input" placeholder="本轮调整了什么" />
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="sign.show = false">取消</button>
          <button class="btn" :disabled="!sign.signed_off_by" @click="doSign">签字存档</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';

const tab = ref('matrix');
const kw = ref('');
const roles = ref([]);
const perms = ref([]);
const users = ref([]);
const sod = ref([]);
const s = ref({});
const reviews = ref([]);
const open = reactive({});
const draftRoles = reactive({});
const isAdmin = computed(() => auth.user?.role === 'admin');
const allPerms = computed(() => perms.value.map((p) => p.perm));

const roleOptions = computed(() => roles.value.filter((r) => r.code !== 'admin'));

const filteredPerms = computed(() => {
  const k = kw.value.trim().toLowerCase();
  if (!k) return perms.value;
  return perms.value.filter((p) => p.perm.toLowerCase().includes(k));
});

function roleLabel(code) {
  const hit = roles.value.find((r) => r.code === code);
  return hit ? hit.label : code;
}

const form = reactive({ perm: '', effect: 'deny', reason: '' });
const sign = reactive({ show: false, period: '上线前复核', scope: '全部在册账号（含多岗与例外）', signed_off_by: '', note: '' });

async function load() {
  const d = await api.accessReview();
  roles.value = d.roles || [];
  perms.value = d.perms || [];
  users.value = d.users || [];
  sod.value = d.sod || [];
  s.value = d.summary || {};
  users.value.forEach((u) => {
    draftRoles[u.id] = u.roles.filter((r) => r !== u.role);
  });
}

async function loadReviews() {
  reviews.value = (await api.accessReviews()) || [];
}

function cloudOf(u) {
  if (u.isAdmin) return allPerms.value;
  return [...u.perms, ...u.deny];
}

function toggle(id) {
  open[id] = !open[id];
  form.perm = '';
  form.effect = 'deny';
  form.reason = '';
}

async function saveExc(u) {
  try {
    await api.accessSetException({
      user_id: u.id,
      perm: form.perm,
      effect: form.effect,
      reason: form.reason
    });
    form.perm = '';
    form.reason = '';
    await load();
    open[u.id] = true;
  } catch (e) {
    alert(e.message);
  }
}

async function delExc(e) {
  if (!confirm(`撤销这条例外？\n${e.perm}：${e.reason}`)) return;
  try {
    await api.accessDelException(e.id);
    await load();
  } catch (err) {
    alert(err.message);
  }
}

function toggleRole(u, code) {
  const list = draftRoles[u.id] || [];
  draftRoles[u.id] = list.includes(code) ? list.filter((x) => x !== code) : [...list, code];
}

async function saveRoles(u) {
  try {
    await api.accessSetRoles({ user_id: u.id, roles: draftRoles[u.id] || [] });
    await load();
    open[u.id] = true;
  } catch (e) {
    alert(e.message);
  }
}

function openSign() {
  sign.show = true;
}

async function doSign() {
  try {
    await api.accessSignOff({
      period: sign.period,
      scope: sign.scope,
      signed_off_by: sign.signed_off_by,
      note: sign.note
    });
    sign.show = false;
    sign.signed_off_by = '';
    sign.note = '';
    tab.value = 'history';
    await loadReviews();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  try {
    await load();
  } catch (e) {
    alert(e.message);
  }
});
</script>

<style scoped>
.tabs.mine {
  margin-left: 0;
  margin-bottom: 14px;
}
.io-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
table.matrix {
  table-layout: fixed;
  width: 100%;
}
table.matrix th,
table.matrix td {
  text-align: center;
  white-space: nowrap;
}
table.matrix th:first-child,
table.matrix td:first-child {
  width: 300px;
}
table.matrix thead th {
  font-size: 12px;
  padding-left: 2px;
  padding-right: 2px;
}
.hint {
  display: block;
  font-size: 10px;
  font-style: normal;
  font-weight: 500;
  color: #a6b0c0;
}
table.matrix tbody tr:hover {
  background: #f7faff;
}
.count-row th {
  font-size: 11px;
  color: #8a94a6;
  font-weight: 600;
  border-bottom: 1px solid #e6ebf3;
}
.yes {
  font-size: 15px;
  font-weight: 800;
  color: #2563eb;
}
.no {
  color: #d5dbe6;
}
code.perm {
  background: #f2f5fa;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11.5px;
  color: #3c4a63;
  white-space: nowrap;
}
.user-card {
  padding: 0;
  overflow: hidden;
}
.uc-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 13px 18px;
  cursor: pointer;
  gap: 12px;
}
.uc-head:hover {
  background: #f7faff;
}
.uc-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.uc-right {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}
.uc-body {
  border-top: 1px dashed #e6ebf3;
  padding: 14px 18px 16px;
  background: #fbfcfe;
}
.ro-note {
  background: #f2f7ff;
  border: 1px solid #dbe8ff;
  color: #2b5aa7;
  font-size: 12px;
  border-radius: 8px;
  padding: 8px 11px;
  margin-bottom: 12px;
}
.uc-cols {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 18px;
}
.uc-col h5 {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: #5b6474;
}
.perm-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 220px;
  overflow-y: auto;
}
.perm-chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: #eef2f9;
  color: #4a5a75;
}
.perm-chip.off {
  background: #fdecee;
  color: #d92d45;
  text-decoration: line-through;
}
.uc-col.side {
  border-left: 1px solid #eef1f6;
  padding-left: 16px;
}
.exc-row {
  border: 1px solid #f0e2d0;
  background: #fffbf4;
  border-radius: 9px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.exc-reason {
  font-size: 11.5px;
  color: #6b5a44;
  margin: 5px 0 0;
  line-height: 1.5;
}
.link-btn {
  background: none;
  border: none;
  color: #d92d45;
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
  margin-top: 4px;
}
.exc-form {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed #e6ebf3;
}
.role-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.role-pick {
  padding: 3px 9px;
  border: 1px solid #e2e8f2;
  background: #fff;
  border-radius: 16px;
  font-size: 11.5px;
  color: #5b6474;
  cursor: pointer;
}
.role-pick.on {
  background: #eaf1ff;
  border-color: #cfe0ff;
  color: #2563eb;
  font-weight: 700;
}
.sod-card {
  border-left: 3px solid #cfe8d8;
}
.sod-card.hit {
  border-left-color: #f0b4be;
}
.sod-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sod-body {
  margin-top: 8px;
  padding-left: 2px;
}
.sod-users {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.sod-note {
  font-size: 12px;
  color: #5b6474;
  line-height: 1.7;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 26, 46, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-box {
  background: #fff;
  border-radius: 14px;
  padding: 20px 22px;
  width: 460px;
  max-width: 92vw;
}
.modal-box h3 {
  margin: 0 0 6px;
  font-size: 16px;
}
.modal-box label {
  display: block;
  font-size: 12px;
  color: #5b6474;
  margin: 12px 0 5px;
}
.modal-box .req {
  color: #d92d45;
  font-style: normal;
}
.modal-ops {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
@media (max-width: 900px) {
  .uc-cols {
    grid-template-columns: 1fr;
  }
  .uc-col.side {
    border-left: none;
    padding-left: 0;
    border-top: 1px dashed #e6ebf3;
    padding-top: 12px;
  }
}
</style>
