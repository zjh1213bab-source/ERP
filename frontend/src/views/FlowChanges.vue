<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>流程变更与发布审计</h2>
        <p class="sub">
          审批流是<b>制度</b>不是代码：改制度这件事本身要留痕、可回滚，而且<b>不能让正在走的单子跟着变形</b>。
          四步链路 —— 创建变更 → <b>试运行（拿历史单对比路径）</b> → 发布（定生效日）→ 可回滚。
          <b>没有试运行证据不许发布。</b>
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openCreate">发起变更</button>
      </div>
    </div>

    <!-- 三条门槛 -->
    <div class="gates">
      <div class="gate">
        <b>关键角色不许悄悄删</b>
        财务、总经理这类角色从流程里消失时，试运行会单独列出来，发布必须写理由。
      </div>
      <div class="gate">
        <b>生效日不能倒签</b>
        不能今天发布、生效日写上周 —— 那等于偷偷改历史，上个月的审批记录会突然「不合流程」。
      </div>
      <div class="gate">
        <b>在途单默认不动</b>
        发布只影响之后新建的单。要迁移必须显式选，且只迁「一步都没开始」的 —— 已批过一半的迁移会打回起点。
      </div>
    </div>

    <!-- 流程清单 -->
    <div class="panel-card">
      <div class="panel-head">
        <div class="sec-title">流程清单（{{ flows.length }} 条）</div>
        <span class="muted">点流程看版本历史</span>
      </div>
      <div class="flow-grid">
        <div
          v-for="f in flows"
          :key="f.flow_key"
          class="flow-card"
          :class="{ on: activeKey === f.flow_key }"
          @click="pickFlow(f.flow_key)"
        >
          <div class="fc-top">
            <span class="fc-name">{{ f.current ? f.current.name : f.flow_key }}</span>
            <span class="tag blue" v-if="f.current">v{{ f.current.version_no }}</span>
          </div>
          <div class="fc-path">{{ f.current ? f.current.path : '—' }}</div>
          <div class="fc-foot">
            <span>在途 <b>{{ f.inflight }}</b> 单</span>
            <span>{{ f.version_count }} 个版本</span>
            <span v-if="f.drafts" class="tag orange">{{ f.drafts }} 个待处理变更</span>
          </div>
        </div>
        <div v-if="!flows.length" class="empty-cell">还没有流程版本记录（先跑 scripts/apply-flowversion-ddl.js 初始化）</div>
      </div>

      <div v-if="activeKey" class="ver-box">
        <div class="sec-h">版本历史 · {{ activeKey }}</div>
        <table class="data">
          <thead><tr><th style="width: 70px">版本</th><th>路径</th><th style="width: 100px">状态</th><th style="width: 100px">生效日</th><th style="width: 140px">发布</th><th style="width: 140px">来源变更</th></tr></thead>
          <tbody>
            <tr v-for="v in verList" :key="v.id">
              <td><b>v{{ v.version_no }}</b></td>
              <td>{{ v.path }}</td>
              <td><span class="tag" :class="verTag(v.status)">{{ v.status_label }}</span></td>
              <td>{{ v.effective_from || '—' }}</td>
              <td class="mut">{{ v.published_at ? (v.published_at || '').slice(0, 16).replace('T', ' ') + ' ' + (v.published_by || '') : '—' }}</td>
              <td class="mut">{{ v.source_change_no || '（初始化）' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 变更单与审计 -->
    <div class="panel-card">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'changes' }" @click="tab = 'changes'">变更单 ({{ changes.length }})</button>
          <button :class="{ on: tab === 'audits' }" @click="switchAudits">审计流水</button>
        </div>
        <input v-model="q" class="input" style="width: 190px" placeholder="变更号 / 标题 / 流程" />
      </div>

      <div class="table-wrap" v-if="tab === 'changes'">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 140px">变更号</th>
              <th>标题</th>
              <th style="width: 150px">路径变化</th>
              <th style="width: 110px">试运行</th>
              <th style="width: 96px">状态</th>
              <th style="width: 90px">在途</th>
              <th style="width: 96px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in filteredChanges" :key="c.id">
              <td>{{ c.change_no }}</td>
              <td>
                <div class="ttl" @click="openDetail(c)">{{ c.title }}</div>
                <div class="mut">{{ c.flow_key }} · {{ c.created_by }}</div>
              </td>
              <td class="mut">
                <span v-if="c.from_version && c.to_version">v{{ c.from_version.version_no }} → v{{ c.to_version.version_no }}（{{ c.to_version.step_count }} 级）</span>
                <span v-else>—</span>
              </td>
              <td>
                <span v-if="c.trial_summary" class="mut">
                  {{ c.trial_summary.changed_count }}/{{ c.trial_summary.sample }} 单路径变
                </span>
                <span v-else class="tag gray">未试运行</span>
              </td>
              <td><span class="tag" :class="chgTag(c.status)">{{ c.status_label }}</span></td>
              <td>{{ c.inflight_count != null ? c.inflight_count : '—' }}</td>
              <td><button class="btn btn-sm btn-ghost" @click="openDetail(c)">查看</button></td>
            </tr>
            <tr v-if="!filteredChanges.length"><td colspan="7" class="empty-cell">还没有变更记录。点右上角「发起变更」开始。</td></tr>
          </tbody>
        </table>
      </div>

      <div class="table-wrap" v-if="tab === 'audits'">
        <table class="data">
          <thead><tr><th style="width: 150px">时间</th><th style="width: 110px">动作</th><th style="width: 130px">变更号</th><th>流程</th><th style="width: 110px">操作人</th></tr></thead>
          <tbody>
            <tr v-for="a in audits" :key="a.id">
              <td class="mut">{{ (a.created_at || '').slice(0, 16).replace('T', ' ') }}</td>
              <td><span class="tag" :class="auditTag(a.action)">{{ a.action_label }}</span></td>
              <td class="mut">{{ a.change_no || '—' }}</td>
              <td class="mut">{{ a.flow_key }}</td>
              <td>{{ a.actor }}</td>
            </tr>
            <tr v-if="!audits.length"><td colspan="5" class="empty-cell">还没有审计记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 发起变更 -->
    <div class="modal-mask" v-if="createOpen">
      <div class="modal wide">
        <div class="m-head">
          <div><h3>发起流程变更</h3><div class="mut">创建后是草稿，必须试运行才能发布。</div></div>
          <button class="link-btn" @click="createOpen = false">关闭</button>
        </div>
        <div class="m-body">
          <div class="lbl">改哪条流程</div>
          <select v-model="form.flow_key" class="select" @change="onFlowChange">
            <option value="">选流程</option>
            <option v-for="f in flows" :key="f.flow_key" :value="f.flow_key">{{ f.current ? f.current.name : f.flow_key }}</option>
          </select>

          <div class="lbl">变更标题（4 字以上，要能看出改了什么）</div>
          <input v-model="form.title" class="input" placeholder="例如：付款审批加一级财务复核" />

          <div class="lbl">变更原因（6 字以上）</div>
          <textarea v-model="form.reason" class="input" rows="2" placeholder="为什么要改？例如：出现过错付，需要第二人复核"></textarea>

          <div class="lbl">影响节点（可选，人工填写）</div>
          <input v-model="form.impact_nodes" class="input" placeholder="例如：付款申请审批、出纳付款" />

          <div class="lbl">新流程步骤（当前 {{ form.steps.length }} 级）</div>
          <div class="step-editor">
            <div v-for="(s, i) in form.steps" :key="i" class="step-row">
              <span class="step-no">{{ i + 1 }}</span>
              <select v-model="s.role" class="select" style="width: 130px">
                <option v-for="r in meta.roles" :key="r.code" :value="r.code">{{ r.label }}</option>
              </select>
              <input v-model="s.name" class="input" style="flex: 1" placeholder="步骤名（如 财务复核）" />
              <input v-model.number="s.sla_hours" class="input" style="width: 76px" type="number" placeholder="SLA" />
              <button class="btn btn-sm btn-ghost" @click="moveStep(i, -1)" :disabled="i === 0">↑</button>
              <button class="btn btn-sm btn-ghost" @click="moveStep(i, 1)" :disabled="i === form.steps.length - 1">↓</button>
              <button class="btn btn-sm btn-ghost" @click="removeStep(i)" :disabled="form.steps.length <= 1">删</button>
            </div>
            <button class="btn btn-sm btn-ghost" @click="addStep">+ 加一级</button>
          </div>
          <div class="mut" style="margin-top: 6px">
            提示：删掉财务或总经理这类关键角色时，发布会被要求写理由 —— 想删可以，但删了会被记下来。
          </div>

          <div class="form-foot">
            <button class="btn btn-primary" @click="doCreate">创建草稿</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 变更详情 -->
    <div class="modal-mask" v-if="detail">
      <div class="modal wide">
        <div class="m-head">
          <div>
            <h3>{{ detail.title }}</h3>
            <div class="mut">
              {{ detail.change_no }} · {{ detail.flow_key }} ·
              <span class="tag" :class="chgTag(detail.status)">{{ detail.status_label }}</span>
              <span class="tag orange" v-if="detail.trial_summary && detail.trial_summary.removed_critical_roles && detail.trial_summary.removed_critical_roles.length">删关键角色</span>
            </div>
          </div>
          <button class="link-btn" @click="detail = null">关闭</button>
        </div>
        <div class="m-body">
          <div class="kv">
            <div><span>变更原因</span><b>{{ detail.reason }}</b></div>
            <div><span>影响节点</span><b>{{ detail.impact_nodes || '未填写' }}</b></div>
            <div><span>原路径</span><b class="mut">{{ detail.from_version ? detail.from_version.path : '—' }}</b></div>
            <div><span>新路径</span><b>{{ detail.to_version ? detail.to_version.path : '—' }}</b></div>
            <div><span>生效日</span><b>{{ detail.effective_from || '未发布' }}</b></div>
            <div><span>在途影响</span><b>{{ detail.inflight_count != null ? detail.inflight_count + ' 单' + (detail.inflight_migrated ? '（迁移 ' + detail.inflight_migrated + '）' : '') : '未评估' }}</b></div>
          </div>

          <!-- 试运行证据 -->
          <div class="trial-box" v-if="detail.trial_summary">
            <div class="tb-h">试运行证据（拿近 {{ detail.trial_summary.trial_days }} 天历史单对比）</div>
            <div class="tb-stats">
              <div><b>{{ detail.trial_summary.sample }}</b><span>样本单</span></div>
              <div><b>{{ detail.trial_summary.same_count }}</b><span>路径不变</span></div>
              <div :class="{ warn: detail.trial_summary.changed_count }"><b>{{ detail.trial_summary.changed_count }}</b><span>路径变化</span></div>
              <div v-if="detail.trial_summary.removed_critical_roles && detail.trial_summary.removed_critical_roles.length" class="warn">
                <b>{{ detail.trial_summary.removed_critical_roles.length }}</b><span>关键角色被删</span>
              </div>
            </div>
            <div class="tb-verdict">{{ detail.trial_summary.verdict }}</div>
            <div class="mut" v-if="detail.trial_summary.removed_critical_note">{{ detail.trial_summary.removed_critical_note }}</div>
            <div class="mut" v-if="detail.trial_summary.amount_range">{{ detail.trial_summary.amount_range }}</div>
            <table class="data" v-if="(detail.trial_summary.changed_samples || []).length" style="margin-top: 8px">
              <thead><tr><th style="width: 90px">单据</th><th>原路径</th><th>新路径</th><th style="width: 70px">级数差</th></tr></thead>
              <tbody>
                <tr v-for="(s, i) in (detail.trial_summary.changed_samples || []).slice(0, 6)" :key="i">
                  <td class="mut">#{{ s.instance_id }}</td>
                  <td class="mut">{{ s.old_path }}</td>
                  <td>{{ s.new_path }}</td>
                  <td :class="{ warnText: s.delta }">{{ s.delta > 0 ? '+' + s.delta : s.delta }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="warn-box" v-else>
            还没有试运行。<b>没有试运行证据不许发布</b> —— 先点下面的「试运行」。
          </div>

          <!-- 影响分析 -->
          <div class="sec-h">在途单影响（{{ detail.impact ? detail.impact.inflight_total : 0 }} 单）</div>
          <div v-if="detail.impact && detail.impact.inflight_total">
            <div class="mut">
              可安全迁移 {{ detail.impact.migratable }} 单 · 已在处理中 {{ detail.impact.in_progress }} 单
              <span v-if="detail.impact.in_progress_note"> —— {{ detail.impact.in_progress_note }}</span>
            </div>
          </div>
          <div v-else class="mut">当前没有在途单受影响。</div>

          <!-- 动作区 -->
          <div class="act-bar" v-if="canWrite && ['draft', 'trialed', 'published'].includes(detail.status)">
            <button v-if="detail.status === 'draft'" class="btn btn-sm btn-primary" @click="doTrial">试运行</button>
            <button v-if="detail.status === 'trialed'" class="btn btn-sm btn-primary" @click="panel = panel === 'publish' ? '' : 'publish'">发布</button>
            <button v-if="detail.status === 'published'" class="btn btn-sm btn-ghost" @click="panel = panel === 'rollback' ? '' : 'rollback'">回滚</button>
            <button v-if="detail.status === 'draft' || detail.status === 'trialed'" class="btn btn-sm btn-ghost" @click="panel = panel === 'reject' ? '' : 'reject'">作废</button>
          </div>

          <div class="form-box" v-if="panel === 'publish'">
            <div class="lbl">生效日（不能早于今天）</div>
            <input v-model="pubForm.effective_from" type="date" class="input" />
            <div class="lbl">在途单处理</div>
            <select v-model="pubForm.migration_mode" class="select">
              <option value="keep_old">在途单保持原版本（推荐）</option>
              <option value="migrate">把未开始的在途单迁到新版本</option>
            </select>
            <div class="lbl" v-if="pubForm.migration_mode === 'migrate'">迁移原因（必填，6 字以上）</div>
            <input v-if="pubForm.migration_mode === 'migrate'" v-model="pubForm.migration_note" class="input" placeholder="为什么要把在途单也换过来" />
            <div class="lbl" v-if="needCriticalNote">删关键角色的理由（必填，8 字以上）</div>
            <textarea v-if="needCriticalNote" v-model="pubForm.critical_role_note" class="input" rows="2" placeholder="例如：财务复核已并入财务审核流程，由同一人双次确认替代"></textarea>
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doPublish">确认发布</button></div>
          </div>

          <div class="form-box" v-if="panel === 'rollback'">
            <div class="lbl">回滚原因（必填，6 字以上）</div>
            <textarea v-model="rbForm.reason" class="input" rows="2" placeholder="例如：财务复核岗还没到位，先回滚到单人审核"></textarea>
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doRollback">确认回滚</button></div>
          </div>

          <div class="form-box" v-if="panel === 'reject'">
            <div class="lbl">作废原因（必填）</div>
            <input v-model="rjForm.reason" class="input" placeholder="为什么不改这条流程了" />
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doReject">确认作废</button></div>
          </div>

          <!-- 审计 -->
          <div class="acts" v-if="(detail.audits || []).length">
            <div class="acts-h">审计流水</div>
            <div v-for="a in detail.audits" :key="a.id" class="act-row">
              <span class="act-t">{{ (a.created_at || '').slice(0, 16).replace('T', ' ') }}</span>
              <span class="tag" :class="auditTag(a.action)">{{ a.action_label }}</span>
              <span class="act-o">{{ a.actor }}</span>
              <span class="act-r">{{ auditText(a) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('flowchange.write'));

const flows = ref([]);
const changes = ref([]);
const audits = ref([]);
const verList = ref([]);
const activeKey = ref('');
const tab = ref('changes');
const q = ref('');
const meta = ref({ roles: [], critical_roles: [] });
const detail = ref(null);
const panel = ref('');

const createOpen = ref(false);
const form = reactive({ flow_key: '', title: '', reason: '', impact_nodes: '', steps: [] });

const pubForm = reactive({ effective_from: today(), migration_mode: 'keep_old', migration_note: '', critical_role_note: '' });
const rbForm = reactive({ reason: '' });
const rjForm = reactive({ reason: '' });

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const verTag = (s) => ({ published: 'green', superseded: 'gray', rolled_back: 'red', draft: 'orange', trial: 'blue' }[s] || 'gray');
const chgTag = (s) => ({ published: 'green', rolled_back: 'red', trialed: 'blue', draft: 'orange', rejected: 'gray' }[s] || 'gray');
const auditTag = (a) => ({ publish: 'green', rollback: 'red', trial: 'blue', create: 'orange', init: 'gray', reject: 'gray', migrate: 'purple' }[a] || 'gray');

const needCriticalNote = computed(() => {
  const s = detail.value && detail.value.trial_summary;
  return !!(s && s.removed_critical_roles && s.removed_critical_roles.length);
});

const filteredChanges = computed(() => {
  if (!q.value) return changes.value;
  const k = q.value.toLowerCase();
  return changes.value.filter((c) => (c.change_no || '').toLowerCase().includes(k)
    || (c.title || '').toLowerCase().includes(k) || (c.flow_key || '').toLowerCase().includes(k));
});

function auditText(a) {
  const d = a.detail || {};
  const bits = [];
  if (d.title) bits.push(d.title);
  if (d.reason) bits.push('原因：' + d.reason);
  if (d.sample != null) bits.push(`样本 ${d.sample} 单，路径变化 ${d.changed}`);
  if (d.effective_from) bits.push('生效日 ' + d.effective_from);
  if (d.migration_mode) bits.push(d.migration_mode === 'migrate' ? `迁移 ${d.migrated || 0} 单` : '在途单保持原版本');
  if (d.removed_critical_roles && d.removed_critical_roles.length) bits.push('删关键角色：' + d.removed_critical_roles.join('、'));
  if (d.rolled_back_version) bits.push(`v${d.rolled_back_version} → v${d.restored_version}`);
  if (d.note) bits.push(d.note);
  return bits.join(' · ');
}

async function load() {
  flows.value = await api.fcFlows();
  changes.value = await api.fcChanges({});
}

async function reload() {
  await load();
  if (activeKey.value) verList.value = await api.fcVersions(activeKey.value);
  if (tab.value === 'audits') audits.value = await api.fcAudits({});
}

async function pickFlow(key) {
  activeKey.value = activeKey.value === key ? '' : key;
  if (activeKey.value) verList.value = await api.fcVersions(activeKey.value);
}

async function switchAudits() {
  tab.value = 'audits';
  audits.value = await api.fcAudits({});
}

function openCreate() {
  // 默认选中第一条流程并带出它当前的步骤 —— 空编辑器会让人以为功能坏了
  const first = flows.value.find((f) => f.current) || flows.value[0];
  form.flow_key = first ? first.flow_key : '';
  form.title = '';
  form.reason = '';
  form.impact_nodes = '';
  form.steps = [];
  createOpen.value = true;
  if (first) onFlowChange();
}

function onFlowChange() {
  const f = flows.value.find((x) => x.flow_key === form.flow_key);
  if (!f || !f.current) { form.steps = []; return; }
  form.steps = (f.current.steps || []).map((s) => ({ role: s.role, name: s.name || '', sla_hours: s.sla_hours || 24 }));
}

function addStep() {
  form.steps.push({ role: 'finance', name: '', sla_hours: 24 });
}

function removeStep(i) {
  if (form.steps.length <= 1) return;
  form.steps.splice(i, 1);
}

function moveStep(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= form.steps.length) return;
  const tmp = form.steps[i];
  form.steps[i] = form.steps[j];
  form.steps[j] = tmp;
  form.steps = [...form.steps];
}

async function doCreate() {
  try {
    const d = await api.fcCreate({ ...form, steps: form.steps });
    createOpen.value = false;
    await load();
    openDetail(d);
  } catch (e) { alert(e.message); }
}

async function openDetail(c) {
  panel.value = '';
  try {
    const d = await api.fcDetail(c.id);
    detail.value = d;
    pubForm.effective_from = today();
    pubForm.migration_mode = 'keep_old';
    pubForm.migration_note = '';
    pubForm.critical_role_note = '';
    rbForm.reason = '';
    rjForm.reason = '';
  } catch (e) { alert(e.message); }
}

async function refreshDetail() {
  if (!detail.value) return;
  detail.value = await api.fcDetail(detail.value.id);
  await load();
  if (activeKey.value) verList.value = await api.fcVersions(activeKey.value);
}

async function doTrial() {
  try {
    await api.fcTrial(detail.value.id, { days: 90 });
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doPublish() {
  try {
    await api.fcPublish(detail.value.id, { ...pubForm });
    panel.value = '';
    await refreshDetail();
    alert('已发布。生效日起新发起的单按新流程走，已发起的单保持原版本。');
  } catch (e) { alert(e.message); }
}

async function doRollback() {
  try {
    await api.fcRollback(detail.value.id, { reason: rbForm.reason });
    panel.value = '';
    await refreshDetail();
    alert('已回滚到上一版。');
  } catch (e) { alert(e.message); }
}

async function doReject() {
  try {
    await api.fcReject(detail.value.id, { reason: rjForm.reason });
    panel.value = '';
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  meta.value = await api.fcMeta();
  await load();
});
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.gates { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 16px; }
.gate { background: #fffaf0; border: 1px solid #f2dfae; border-radius: 10px; padding: 10px 14px; font-size: 12.4px; color: #7a6420; line-height: 1.65; }
.gate b { display: block; color: #8a6d1f; margin-bottom: 3px; }

.sec-title { font-size: 14px; font-weight: 700; color: var(--ink); }
.sec-h { font-size: 13px; font-weight: 700; color: var(--ink); margin: 14px 0 8px; }

.flow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.flow-card { border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; min-height: 96px; cursor: pointer; transition: border-color .15s, background .15s; }
.flow-card:hover { border-color: #b9cdf3; background: #fafcff; }
.flow-card.on { border-color: #2b6de5; background: #f5f9ff; }
.fc-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.fc-name { font-weight: 700; color: var(--ink); font-size: 13.5px; }
.fc-path { color: #4a5875; font-size: 12.3px; margin: 6px 0; line-height: 1.5; }
.fc-foot { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--ink-mute); }
.fc-foot b { color: #16305f; }

.ver-box { margin-top: 14px; }

.ttl { font-weight: 600; color: var(--ink); cursor: pointer; }
.ttl:hover { color: var(--brand); }
.mut { color: var(--ink-mute); font-size: 12px; line-height: 1.55; }
.muted { color: var(--ink-mute); font-size: 12px; }
.warnText { color: #d92d45; font-weight: 600; }

.modal.wide { max-width: 880px; width: 93vw; }
.m-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.m-head h3 { margin: 0 0 4px; font-size: 16px; }
.m-body { max-height: 70vh; overflow-y: auto; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; font-size: 12.8px; margin-bottom: 12px; }
.kv > div { display: flex; gap: 8px; }
.kv span { color: var(--ink-mute); min-width: 64px; }
.kv b { font-weight: 600; color: var(--ink); }

.trial-box { background: #f5f9ff; border: 1px solid #d6e4fb; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
.tb-h { font-size: 12.8px; font-weight: 700; color: #16305f; margin-bottom: 8px; }
.tb-stats { display: flex; gap: 22px; flex-wrap: wrap; margin-bottom: 8px; }
.tb-stats > div { display: flex; flex-direction: column; }
.tb-stats b { font-size: 20px; font-weight: 800; color: #16305f; line-height: 1.1; }
.tb-stats span { font-size: 12px; color: #7a869a; }
.tb-stats .warn b { color: #d92d45; }
.tb-verdict { font-size: 12.6px; color: var(--ink); background: var(--surface); border-radius: 6px; padding: 7px 10px; margin-bottom: 6px; }

.warn-box { background: #fffaf0; border: 1px solid #f2dfae; border-radius: 10px; padding: 10px 14px; font-size: 12.6px; color: #7a6420; line-height: 1.7; margin-bottom: 14px; }
.act-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.form-box { background: #f8fafd; border: 1px solid #e6ebf3; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.form-box .lbl { font-size: 12px; color: var(--ink-soft); margin: 6px 0 4px; }
.form-box .input, .form-box .select { width: 100%; }
.form-foot { margin-top: 10px; display: flex; gap: 8px; }
.lbl { font-size: 12px; color: var(--ink-soft); margin: 10px 0 4px; }
.step-editor { display: flex; flex-direction: column; gap: 8px; }
.step-row { display: flex; gap: 6px; align-items: center; }
.step-no { width: 20px; text-align: center; color: var(--ink-mute); font-size: 12px; }

.acts { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 12px; }
.acts-h { font-size: 12.5px; font-weight: 700; color: var(--ink); margin-bottom: 6px; }
.act-row { display: flex; gap: 10px; align-items: baseline; font-size: 12.2px; padding: 4px 0; border-bottom: 1px dashed #f0f3f8; }
.act-t { color: #9aa4b5; width: 118px; flex: none; }
.act-o { color: #4a5875; width: 84px; flex: none; }
.act-r { color: #3d4a63; flex: 1; }

@media (max-width: 860px) {
  .kv { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; align-items: flex-start; gap: 10px; }
  .head-ops { flex-wrap: wrap; width: 100%; }
  .modal.wide { width: 96vw; }
  .step-row { flex-wrap: wrap; }
}
</style>
