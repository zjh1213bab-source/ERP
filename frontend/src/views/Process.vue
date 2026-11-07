<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>流程超时升级与岗位 SOP</h2>
        <p class="sub">
          待办可分配但<b>不可失主</b>：主责按「原审批人 → 有效代理 → 升级接收」流转，历史保留。
          <b>财务与工艺等关键审批超时只升级到人，绝不自动通过</b>。同一任务同一级别只提醒一次，按风险汇总不轰炸。
          制度只有<b>生效版本</b>是当前执行依据，旧版可查但不作为现行做法。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canReview" class="btn btn-ghost" @click="scan">扫描超时</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openSopForm()">＋ 新建制度/SOP</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>在办待办</span><strong>{{ board.stat.pending || 0 }}</strong><small>只算当前步</small></div>
      <div class="stat"><span>已超时</span><strong :class="board.stat.overdue ? 'amt-red' : ''">{{ board.stat.overdue || 0 }}</strong><small>只升级不自动通过</small></div>
      <div class="stat"><span>临近到期</span><strong :class="board.stat.soon ? 'amt-orange' : ''">{{ board.stat.soon || 0 }}</strong><small>4 小时内</small></div>
      <div class="stat"><span>无主任务</span><strong :class="board.stat.no_owner ? 'amt-red' : ''">{{ board.stat.no_owner || 0 }}</strong><small>角色无人且无代理</small></div>
      <div class="stat"><span>已升级</span><strong>{{ board.stat.escalated || 0 }}</strong><small>换人但不换审批要求</small></div>
      <div class="stat"><span>生效代理</span><strong>{{ board.stat.delegate_active || 0 }}</strong><small>休假/调动用</small></div>
      <div class="stat"><span>生效制度</span><strong>{{ board.stat.sop_effective || 0 }}</strong><small>当前执行依据</small></div>
      <div class="stat"><span>待补签</span><strong :class="board.stat.sop_pending_ack ? 'amt-orange' : ''">{{ board.stat.sop_pending_ack || 0 }}</strong><small>岗位未签收</small></div>
    </div>

    <div class="tabs" style="margin-bottom: 12px">
      <button :class="{ on: tab === 'queue' }" @click="tab = 'queue'">超时与升级</button>
      <button :class="{ on: tab === 'dele' }" @click="tab = 'dele'; loadDelegates()">代理与时限</button>
      <button :class="{ on: tab === 'sop' }" @click="tab = 'sop'; loadSops()">制度与 SOP</button>
    </div>

    <!-- ==================== 一、超时与升级 ==================== -->
    <div v-if="tab === 'queue'">
      <div class="table-wrap">
        <table class="data q-tbl">
          <thead>
            <tr>
              <th style="width: 64px">#</th><th>等待中的事</th><th style="width: 96px">步骤</th>
              <th style="width: 130px">截止</th><th style="width: 92px">剩余</th>
              <th style="width: 150px">当前主责</th><th style="width: 96px">状态</th>
              <th style="width: 210px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in board.queue" :key="t.id" :class="{ 'row-risk': t.overdue, 'row-warn': t.soon }">
              <td class="mono">{{ t.id }}</td>
              <td>
                {{ t.target_label || '-' }}
                <div class="tiny muted">{{ t.target_type }} #{{ t.target_id }}</div>
              </td>
              <td class="tiny">{{ t.step_name }}<div class="muted">{{ t.role }}</div></td>
              <td class="mono tiny" style="white-space: nowrap">{{ $fmt(t.due_at) }}<div class="muted">SLA {{ t.sla_hours }}h</div></td>
              <td class="tiny">
                <span v-if="t.hours_left === null" class="muted">-</span>
                <span v-else-if="t.hours_left < 0" class="amt-red">超时 {{ Math.abs(t.hours_left) }}h</span>
                <span v-else :class="t.hours_left <= 4 ? 'amt-orange' : ''">剩 {{ t.hours_left }}h</span>
              </td>
              <td class="tiny">
                <b>{{ t.owner.who || '（无主）' }}</b>
                <div class="muted">{{ t.owner.note }}</div>
                <div v-if="t.escalated_to" class="amt-orange">已升级给 {{ t.escalated_to }}</div>
              </td>
              <td>
                <span class="tag" :class="t.overdue ? 'red' : t.soon ? 'orange' : 'gray'">
                  {{ t.overdue ? '已超时' : t.soon ? '临近' : '在办' }}
                </span>
                <div v-if="t.no_owner" class="tiny amt-red">无主</div>
              </td>
              <td class="ops">
                <button v-if="canReview" class="link-btn" @click="remind(t)">提醒</button>
                <button v-if="canReview" class="link-btn" @click="escalate(t)">升级</button>
                <button v-if="canReview && t.escalated_to && !t.received_by" class="link-btn" @click="receive(t)">接收</button>
                <button v-if="canReview" class="link-btn" @click="delegateTask(t)">代理转交</button>
                <span class="tiny muted">不自动通过</span>
              </td>
            </tr>
            <tr v-if="!board.queue.length"><td colspan="8" class="empty-cell">没有超时或在办卡住的待办</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="board.reminders && board.reminders.length" class="block">
        <h4>最近提醒（同一任务同一级别只发一次）</h4>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th style="width: 150px">时间</th><th style="width: 90px">级别</th><th style="width: 120px">发给</th><th>内容</th></tr></thead>
            <tbody>
              <tr v-for="r in board.reminders" :key="r.id">
                <td class="mono tiny">{{ $fmt(r.sent_at) }}</td>
                <td><span class="tag" :class="r.level === 'overdue' ? 'red' : r.level === 'escalate' ? 'orange' : 'gray'">
                  {{ r.level === 'overdue' ? '超时' : r.level === 'escalate' ? '升级' : '临近' }}
                </span></td>
                <td class="tiny">{{ r.to_user || r.to_role || '-' }}</td>
                <td class="tiny wrap">{{ r.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 二、代理与时限 ==================== -->
    <div v-if="tab === 'dele'">
      <div class="row-between">
        <h4 class="sec-title">审批代理授权<span class="tiny muted"> · 休假/调动按有效授权转交，原责任与历史保留；没授权就走升级队列</span></h4>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openDelegateForm()">＋ 设置代理</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th style="width: 110px">原审批人</th><th style="width: 110px">代理人</th><th style="width: 90px">覆盖类型</th>
              <th style="width: 180px">有效期</th><th style="width: 90px">状态</th><th>原因</th><th style="width: 90px"></th></tr>
          </thead>
          <tbody>
            <tr v-for="d in delegates" :key="d.id">
              <td><b>{{ d.from_user }}</b></td>
              <td>{{ d.to_user }}</td>
              <td class="tiny">{{ typeLabel(d.target_types) }}</td>
              <td class="tiny">{{ d.valid_from || '-' }} ~ {{ d.valid_to || '长期' }}</td>
              <td><span class="tag" :class="d.effective_status === 'active' ? 'green' : d.effective_status === 'expired' ? 'orange' : 'gray'">{{ d.status_label }}</span></td>
              <td class="tiny wrap">{{ d.reason }}</td>
              <td><button v-if="canWrite && d.effective_status === 'active'" class="link-btn danger" @click="revokeDelegate(d)">撤销</button></td>
            </tr>
            <tr v-if="!delegates.length"><td colspan="7" class="empty-cell">还没有代理授权</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec-title">各流程时限（SLA）<span class="tiny muted"> · 关键节点不设「超时自动通过」，超时只升级到人</span></h4>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th style="width: 170px">流程</th><th style="width: 90px">对象</th><th style="width: 90px">默认时限</th><th style="width: 110px">超时升级给</th><th>各步时限</th><th style="width: 90px"></th></tr></thead>
          <tbody>
            <tr v-for="f in flows" :key="f.id" :class="{ 'muted-row': !f.active }">
              <td>{{ f.name }}<span v-if="!f.active" class="tag gray" style="margin-left: 6px">停用</span></td>
              <td class="tiny">{{ typeLabel(f.target_type) }}</td>
              <td class="num">{{ f.sla_hours }}h</td>
              <td class="tiny">{{ f.escalate_role || '-' }}</td>
              <td class="tiny">
                <span v-for="s in f.steps" :key="s.step_no" class="step-chip">
                  {{ s.step_no }}. {{ s.name }} · {{ s.sla_hours }}h
                  <template v-if="s.escalate_to"> → {{ s.escalate_to }}</template>
                </span>
              </td>
              <td><button v-if="canAdmin && f.active" class="link-btn" @click="editSla(f)">改时限</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、制度与 SOP ==================== -->
    <div v-if="tab === 'sop'">
      <div class="toolbar" style="margin-bottom: 10px">
        <input v-model="sopQ" class="input" placeholder="制度名称 / 编号" style="width: 200px" @keyup.enter="loadSops" />
        <select class="select" v-model="sopStatus" style="width: 130px" @change="loadSops">
          <option value="">全部状态</option>
          <option v-for="(v, k) in dict.sop_status" :key="k" :value="k">{{ v }}</option>
        </select>
        <button class="btn btn-ghost" @click="loadSops">查询</button>
      </div>
      <div class="table-wrap">
        <table class="data s-tbl">
          <thead>
            <tr>
              <th style="width: 140px">编号</th><th>制度 / SOP</th><th style="width: 96px">类别</th>
              <th style="width: 96px">适用岗位</th><th style="width: 76px">生效版</th>
              <th style="width: 92px">状态</th><th style="width: 110px">生效日</th>
              <th style="width: 130px">签收</th><th style="width: 190px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in sops" :key="d.id">
              <td class="mono">{{ d.doc_no }}</td>
              <td>{{ d.title }}<div class="tiny muted">{{ d.owner }}</div></td>
              <td><span class="tag gray">{{ d.category_label }}</span></td>
              <td class="tiny">{{ d.position || '全岗位' }}</td>
              <td class="tiny">{{ d.current_version ? 'V' + d.current_version : '-' }}</td>
              <td><span class="tag" :class="d.status === 'effective' ? 'green' : d.status === 'retired' ? 'gray' : d.status === 'pending' ? 'orange' : 'gray'">{{ d.status_label }}</span></td>
              <td class="tiny">{{ d.effective_date || '-' }}</td>
              <td class="tiny">
                <span v-if="d.ack_total" :class="d.ack_pending ? 'amt-orange' : 'amt-green'">{{ d.ack_done }}/{{ d.ack_total }}{{ d.ack_pending ? ' 待补签' : ' 已齐' }}</span>
                <span v-else class="muted">-</span>
              </td>
              <td class="ops">
                <button class="link-btn" @click="openSop(d)">查看</button>
                <button v-if="canWrite && d.status !== 'retired'" class="link-btn" @click="openVersionForm(d)">出新版</button>
                <button v-if="canReview && d.status === 'pending'" class="link-btn" @click="publish(d)">批准生效</button>
                <button v-if="canReview && d.status === 'effective'" class="link-btn danger" @click="retire(d)">废止</button>
              </td>
            </tr>
            <tr v-if="!sops.length"><td colspan="9" class="empty-cell">还没有制度，点「新建制度/SOP」开始编制</td></tr>
          </tbody>
        </table>
      </div>
      <p class="hint-bar" style="margin-top: 12px">
        制度必须写全四要素：<b>做法 / 输入 / 完成标准 / 升级路径</b>，缺一项不许发布。发布后按适用岗位生成签收待办；
        旧版本转「已废止」，可查询追溯，但不作为现行做法。
      </p>
    </div>

    <!-- ================= 制度详情 ================= -->
    <div v-if="cur" class="modal-mask">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>{{ cur.title }}
            <span class="tag" :class="cur.status === 'effective' ? 'green' : cur.status === 'retired' ? 'gray' : 'orange'">{{ cur.status_label }}</span>
            <span class="tag gray">{{ cur.doc_no }}</span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <div class="sop-meta">
            <span>类别 <b>{{ cur.category_label }}</b></span>
            <span>适用岗位 <b>{{ cur.position || '全岗位' }}</b></span>
            <span>责任人 <b>{{ cur.owner }}</b></span>
            <span>生效版 <b>{{ cur.current_version ? 'V' + cur.current_version : '未发布' }}</b></span>
            <span>生效日 <b>{{ cur.effective_date || '-' }}</b></span>
            <span>批准人 <b>{{ cur.approved_by || '-' }}</b></span>
          </div>
          <p v-if="cur.status === 'retired'" class="hint-bar amt-red">
            已废止：{{ cur.retire_reason }}。历史版本可查，但<b>不作为现行做法</b>。
          </p>

          <div v-if="cur.current_version_detail" class="four-grid">
            <div class="four-card">
              <div class="four-title">做法</div>
              <div class="four-body">{{ cur.current_version_detail.doing }}</div>
            </div>
            <div class="four-card">
              <div class="four-title">输入</div>
              <div class="four-body">{{ cur.current_version_detail.inputs }}</div>
            </div>
            <div class="four-card">
              <div class="four-title">完成标准</div>
              <div class="four-body">{{ cur.current_version_detail.done_criteria }}</div>
            </div>
            <div class="four-card">
              <div class="four-title">升级路径</div>
              <div class="four-body">{{ cur.current_version_detail.escalate_path }}</div>
            </div>
          </div>
          <p v-else class="hint-bar">还没有生效版本，先写完 V1 四要素再批准。</p>

          <h4 class="sec-title">版本历史</h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width: 70px">版本</th><th style="width: 90px">状态</th><th>变更说明</th><th style="width: 110px">编制人</th><th style="width: 130px">时间</th></tr></thead>
              <tbody>
                <tr v-for="v in cur.versions" :key="v.id">
                  <td><b>V{{ v.version }}</b></td>
                  <td><span class="tag" :class="v.status === 'effective' ? 'green' : v.status === 'retired' ? 'gray' : 'orange'">{{ v.status_label }}</span></td>
                  <td class="tiny wrap">{{ v.change_note || '-' }}</td>
                  <td class="tiny">{{ v.created_by || '-' }}</td>
                  <td class="tiny">{{ $fmt(v.created_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec-title">岗位签收<span class="tiny muted"> · 生效版才有签收义务</span></h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width: 70px">版本</th><th style="width: 120px">员工</th><th style="width: 100px">岗位</th><th style="width: 100px">状态</th><th style="width: 150px">签收时间</th><th></th></tr></thead>
              <tbody>
                <tr v-for="a in cur.acks" :key="a.id" :class="{ 'row-warn': a.version === cur.current_version && !a.acked_at }">
                  <td>V{{ a.version }}</td>
                  <td>{{ a.employee_name }}</td>
                  <td class="tiny">{{ a.position || '-' }}</td>
                  <td><span class="tag" :class="a.acked_at ? 'green' : 'orange'">{{ a.acked_at ? '已签收' : '待补签' }}</span></td>
                  <td class="tiny">{{ a.acked_at ? $fmt(a.acked_at) : '-' }}</td>
                  <td><button v-if="!a.acked_at && a.version === cur.current_version" class="link-btn" @click="ack(a)">登记签收</button></td>
                </tr>
                <tr v-if="!cur.acks.length"><td colspan="6" class="empty-cell">还没有签收记录（制度未发布或岗位无人）</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="cur = null">关闭</button>
          <button v-if="canWrite && cur.status !== 'retired'" class="btn btn-ghost" @click="openVersionForm(cur)">出新版</button>
          <button v-if="canReview && cur.status === 'pending'" class="btn btn-primary" @click="publish(cur)">批准生效</button>
        </div>
      </div>
    </div>

    <!-- ================= 新建制度 ================= -->
    <div v-if="sopForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>新建制度 / SOP</h3><button class="x" @click="sopForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full"><label>名称 *</label><input class="input" v-model="sopForm.title" placeholder="车缝工序首件确认 SOP" /></div>
            <div class="fitem">
              <label>类别</label>
              <select class="select" v-model="sopForm.category">
                <option v-for="(v, k) in dict.sop_category" :key="k" :value="k">{{ v }}</option>
              </select>
            </div>
            <div class="fitem"><label>适用岗位（空=全岗位）</label><input class="input" v-model="sopForm.position" placeholder="车工" /></div>
            <div class="fitem"><label>公司</label><input class="input" v-model="sopForm.company" /></div>
            <div class="fitem"><label>制度责任人 *</label><input class="input" v-model="sopForm.owner" placeholder="以后谁维护" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="sopForm.remark" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="sopForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveSop">创建</button>
        </div>
      </div>
    </div>

    <!-- ================= 写新版 ================= -->
    <div v-if="verForm" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>编制新版本 · {{ verForm.doc.title }}</h3><button class="x" @click="verForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">四要素缺一项不许提交批准：<b>做法 / 输入 / 完成标准 / 升级路径</b>。</p>
          <div class="form-grid">
            <div class="fitem full"><label>做法 *</label><textarea v-model="verForm.doing" rows="3" placeholder="第 1 步…第 2 步…"></textarea></div>
            <div class="fitem full"><label>输入 *</label><textarea v-model="verForm.inputs" rows="2" placeholder="需要哪些资料/工具/系统单据"></textarea></div>
            <div class="fitem full"><label>完成标准 *</label><textarea v-model="verForm.done_criteria" rows="2" placeholder="什么条件算做完、谁验收"></textarea></div>
            <div class="fitem full"><label>升级路径 *</label><textarea v-model="verForm.escalate_path" rows="2" placeholder="遇什么问题找谁、多久升级"></textarea></div>
            <div class="fitem full"><label>变更说明</label><input class="input" v-model="verForm.change_note" placeholder="这版改了什么" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="verForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveVersion">保存草稿</button>
        </div>
      </div>
    </div>

    <!-- ================= 设置代理 ================= -->
    <div v-if="dgForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>设置审批代理</h3><button class="x" @click="dgForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">只在有效期内、覆盖对应业务类型时才允许转交；原审批人责任仍保留在记录里。</p>
          <div class="form-grid">
            <div class="fitem"><label>原审批人 *</label><input class="input" v-model="dgForm.from_user" placeholder="fin01" /></div>
            <div class="fitem"><label>代理人 *</label><input class="input" v-model="dgForm.to_user" placeholder="sales01" /></div>
            <div class="fitem"><label>覆盖业务类型</label><input class="input" v-model="dgForm.target_types" placeholder="cost（空=全部）" /></div>
            <div class="fitem"><label>有效期至</label><input class="input" type="date" v-model="dgForm.valid_to" /></div>
            <div class="fitem full"><label>原因 *</label><input class="input" v-model="dgForm.reason" placeholder="休假 / 出差 / 调动" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="dgForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveDelegate">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import { auth } from '../store/auth';

const canWrite = computed(() => can('process.write'));
const canReview = computed(() => can('process.review'));
const canAdmin = computed(() => (auth.user && auth.user.role === 'admin'));

const tab = ref('queue');
const board = reactive({ stat: {}, queue: [], escalated: [], reminders: [], delegates: [], sop: {} });
const delegates = ref([]);
const flows = ref([]);
const sops = ref([]);
const dict = ref({ sop_status: {}, sop_category: {} });
const sopQ = ref('');
const sopStatus = ref('');
const cur = ref(null);
const sopForm = ref(null);
const verForm = ref(null);
const dgForm = ref(null);
const saving = ref(false);

const TYPE_LABEL = { cost: '成本审核', order: '订单', techpack: '技术资料' };
function typeLabel(v) {
  if (!v) return '全部';
  return String(v).split(',').map((x) => TYPE_LABEL[x.trim()] || x.trim()).join(' / ');
}

async function loadBoard() {
  const d = await api.processBoard();
  Object.assign(board, d);
  if (d.dict) dict.value = { ...dict.value, ...d.dict };
}

async function loadDelegates() {
  const d = await api.processDelegates();
  delegates.value = d.rows || [];
  const s = await api.processSla();
  flows.value = s.flows || [];
}

async function loadSops() {
  const d = await api.sops({ q: sopQ.value, status: sopStatus.value });
  sops.value = d.rows || [];
  if (d.dict) dict.value = { ...dict.value, ...d.dict };
}

async function reloadAll() {
  await loadBoard();
  if (tab.value === 'dele') await loadDelegates();
  if (tab.value === 'sop') await loadSops();
}

async function scan() {
  try {
    const r = await api.processScan();
    await loadBoard();
    const lines = (r.overdue || []).map((x) => `#${x.id} ${x.target} 超时 ${x.hours_over}h（${x.owner.who || '无主'}）`);
    alert(`${r.notice}\n\n${lines.length ? lines.join('\n') : '暂无超时'}`);
  } catch (e) { alert(e.message); }
}

/* ---------- 待办操作 ---------- */
async function remind(t) {
  try {
    const r = await api.processRemind(t.id);
    await loadBoard();
    alert(`${r.message}\n\n${r.notice}`);
  } catch (e) { alert(e.message); }
}

async function escalate(t) {
  const to = prompt(`把「${t.target_label || '#' + t.id}」升级给谁（账号或姓名）：`, t.escalate_role || '');
  if (to === null) return;
  if (!String(to).trim()) return alert('必须指定接手人');
  const reason = prompt('升级原因（超时多久、影响什么）：');
  if (reason === null) return;
  if (!String(reason).trim()) return alert('升级必须写原因');
  try {
    const r = await api.processEscalate(t.id, { escalated_to: to.trim(), reason: reason.trim() });
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function receive(t) {
  try {
    const r = await api.processReceive(t.id);
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function delegateTask(t) {
  const from = prompt('原审批人（谁的审批权要转）：', t.original_approver || t.role);
  if (from === null) return;
  const to = prompt('代理人：');
  if (to === null) return;
  try {
    const r = await api.processDelegateTask(t.id, { from_user: from.trim(), to_user: to.trim() });
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

/* ---------- 代理 ---------- */
function openDelegateForm() {
  dgForm.value = { from_user: '', to_user: '', target_types: 'cost', valid_to: '', reason: '' };
}

async function saveDelegate() {
  const f = dgForm.value;
  if (!f.from_user || !f.to_user) return alert('原审批人和代理人都必填');
  if (!f.reason.trim()) return alert('必须写原因');
  saving.value = true;
  try {
    const r = await api.processCreateDelegate(f);
    dgForm.value = null;
    await loadDelegates();
    alert(r.notice);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function revokeDelegate(d) {
  const reason = prompt(`撤销「${d.from_user} → ${d.to_user}」的代理，原因：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('撤销必须写原因');
  try {
    const r = await api.processRevokeDelegate(d.id, { reason: reason.trim() });
    await loadDelegates();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function editSla(f) {
  const h = prompt(`「${f.name}」默认时限（小时）：`, f.sla_hours);
  if (h === null) return;
  const steps = f.steps.map((s) => ({ role: s.role, name: s.name, sla_hours: Number(s.sla_hours), escalate_to: s.escalate_to }));
  try {
    const r = await api.processUpdateSla(f.id, { sla_hours: Number(h), steps });
    await loadDelegates();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

/* ---------- 制度 ---------- */
function openSopForm() {
  sopForm.value = { title: '', category: 'sop', position: '', company: '义乌市珂睿服饰', owner: '', remark: '' };
}

async function saveSop() {
  const f = sopForm.value;
  if (!f.title.trim()) return alert('请填名称');
  if (!f.owner.trim()) return alert('请填制度责任人');
  saving.value = true;
  try {
    const r = await api.createSop(f);
    sopForm.value = null;
    await loadSops();
    alert(r.notice);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function openSop(d) {
  try { cur.value = await api.sop(d.id); } catch (e) { alert(e.message); }
}

function openVersionForm(d) {
  verForm.value = { doc: d, doing: '', inputs: '', done_criteria: '', escalate_path: '', change_note: '' };
}

async function saveVersion() {
  const f = verForm.value;
  const miss = [];
  if (!f.doing.trim()) miss.push('做法');
  if (!f.inputs.trim()) miss.push('输入');
  if (!f.done_criteria.trim()) miss.push('完成标准');
  if (!f.escalate_path.trim()) miss.push('升级路径');
  if (miss.length) return alert(`四要素不齐，缺：${miss.join('、')}`);
  saving.value = true;
  try {
    const r = await api.addSopVersion(f.doc.id, {
      doing: f.doing, inputs: f.inputs, done_criteria: f.done_criteria, escalate_path: f.escalate_path, change_note: f.change_note
    });
    verForm.value = null;
    await loadSops();
    alert(r.notice);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function publish(d) {
  if (!confirm(`批准「${d.title}」当前版本生效？\n\n生效后旧版本转「已废止」，并按适用岗位生成签收待办。`)) return;
  try {
    const r = await api.publishSop(d.id, {});
    await loadSops();
    if (cur.value) cur.value = await api.sop(cur.value.id);
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function retire(d) {
  const reason = prompt(`废止「${d.title}」的原因（会被谁替代 / 为什么不再适用）：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('废止必须写原因');
  try {
    const r = await api.retireSop(d.id, { reason: reason.trim() });
    await loadSops();
    if (cur.value) cur.value = await api.sop(cur.value.id);
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function ack(a) {
  if (!confirm(`登记「${a.employee_name}」已签收 V${a.version}？`)) return;
  try {
    const r = await api.ackSop(cur.value.id, { employee_id: a.employee_id, note: '岗位现场签收' });
    cur.value = await api.sop(cur.value.id);
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  try { dict.value = await api.processDict(); } catch (e) { /* ignore */ }
  await loadBoard();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(8, 1fr); gap: 9px; margin-bottom: 12px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 10px 12px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 3px 0 1px; font-size: 19px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.tiny { font-size: 12px; }
.wrap { white-space: normal; line-height: 1.55; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.row-warn { background: #fffaf2; }
.row-risk { background: #fff7f8; }
.muted-row { opacity: .65; }
.ops { white-space: nowrap; }
.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.sec-title { margin: 16px 0 8px; font-size: 13px; color: var(--ink); }
.row-between { display: flex; align-items: center; justify-content: space-between; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px;
  font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 10px; }
.q-tbl { min-width: 1180px; }
.s-tbl { min-width: 1180px; }
.s-tbl .tag, .q-tbl .tag { white-space: nowrap; }
.step-chip { display: inline-block; background: #eef2f8; color: #5b6474; border-radius: 10px; padding: 1px 8px; margin: 2px 4px 2px 0; font-size: 12px; }
.sop-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12.5px; color: #5b6474;
  background: #f8fafd; border: 1px solid #e8eef7; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
.sop-meta b { color: var(--ink); }
.four-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 4px; }
.four-card { background: var(--surface-2); border: 1px solid #e8eef7; border-radius: 10px; padding: 10px 12px; }
.four-title { font-size: 12px; font-weight: 700; color: var(--brand); margin-bottom: 4px; }
.four-body { font-size: 12.5px; color: var(--ink); line-height: 1.7; white-space: pre-wrap; }
@media (max-width: 1400px) { .stat-row { grid-template-columns: repeat(4, 1fr); } }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .four-grid { grid-template-columns: 1fr; } }
</style>
