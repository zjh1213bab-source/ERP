<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>返工报废与生产结单</h2>
        <p class="sub">
          异常 → 返工/报废批准 → 复验 → 余料/费用清理 → 结单。
          结单先查 <b>未交 / 在制 / 余料 / 工费 / 质量未决</b>：有硬阻塞不许结；只是没交或余料没清，只能<b>部分关闭 + 争议挂账</b>。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openNew">＋ 返工/报废单</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>返工报废单</span><strong>{{ rwStat.total || 0 }}</strong><small>损失 ¥{{ fmt(rwStat.loss) }}</small></div>
      <div class="stat"><span>待批准</span><strong :class="rwStat.pending_approve ? 'amt-orange' : ''">{{ rwStat.pending_approve || 0 }}</strong><small>自己开单不能自己批</small></div>
      <div class="stat"><span>返工中</span><strong :class="rwStat.in_progress ? 'amt-blue' : ''">{{ rwStat.in_progress || 0 }}</strong><small>占着结单</small></div>
      <div class="stat"><span>报废件数</span><strong :class="rwStat.qty_scrap ? 'amt-red' : ''">{{ fmt(rwStat.qty_scrap) }}</strong><small>已核销</small></div>
      <div class="stat"><span>可结单</span><strong class="amt-green">{{ clStat.closable || 0 }}</strong><small>检查全过</small></div>
      <div class="stat"><span>结单受限</span><strong :class="clStat.blocked ? 'amt-red' : ''">{{ clStat.blocked || 0 }}</strong><small>有硬阻塞</small></div>
      <div class="stat"><span>已结 / 部分</span><strong>{{ clStat.closed || 0 }} / {{ clStat.partial || 0 }}</strong><small>全结 / 部分关闭</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'rework' }" @click="tab = 'rework'">返工报废</button>
        <button :class="{ on: tab === 'close' }" @click="tab = 'close'">生产结单</button>
      </div>
      <input class="input" v-model="q" placeholder="单号 / 订单号 / 原因" style="width: 220px" @keyup.enter="reload" />
      <button class="btn btn-ghost" @click="reload">查询</button>
    </div>

    <!-- ============ 返工报废 ============ -->
    <div v-if="tab === 'rework'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 140px">处理单</th><th style="width: 150px">订单</th><th style="width: 110px">原工序</th>
            <th style="width: 70px">类型</th><th style="width: 80px" class="num">不良</th>
            <th style="width: 90px" class="num">返工/报废</th><th style="width: 90px" class="num">次数</th>
            <th style="width: 90px" class="num">损失</th><th>原因</th>
            <th style="width: 100px">状态</th><th style="width: 200px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in reworks" :key="r.id">
            <td class="mono">{{ r.rw_no }}<div class="tiny">{{ r.source_label }} · {{ r.responsibility || '-' }}</div></td>
            <td class="mono">{{ r.order_no }}<div class="tiny">{{ r.style_name || '' }}</div></td>
            <td>{{ r.node_name || '-' }}</td>
            <td><span class="tag" :class="r.type === 'scrap' ? 'red' : 'blue'">{{ r.type_label }}</span></td>
            <td class="num">{{ fmt(r.qty) }}</td>
            <td class="num">
              <span v-if="r.qty_ok">合格 {{ fmt(r.qty_ok) }}</span>
              <span v-else-if="r.qty_scrap" class="warn">报废 {{ fmt(r.qty_scrap) }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td class="num">{{ r.rework_times }}<span class="tiny"> 次</span></td>
            <td class="num">{{ fmt(r.cost_total) }}</td>
            <td class="wrap tiny">{{ r.reason }}</td>
            <td><span class="tag" :class="rwTag(r.status)">{{ r.status_label }}</span></td>
            <td class="ops">
              <button v-if="canWrite && r.status === 'draft'" class="link-btn" @click="doSubmit(r)">提交批准</button>
              <button v-if="canWrite && r.status === 'pending_approve'" class="link-btn" @click="doApprove(r, true)">批准</button>
              <button  v-if="canWrite && r.status === 'pending_approve'" class="link-btn danger" @click="doApprove(r, false)">驳回</button>
              <button v-if="canWrite && r.status === 'approved' && r.type === 'rework'" class="link-btn" @click="doStart(r)">开始返工</button>
              <button v-if="canWrite && r.status === 'in_progress'" class="link-btn" @click="openReinspect(r)">复验</button>
              <button v-if="canWrite && r.status === 'approved' && r.type === 'scrap'" class="link-btn" @click="doScrap(r)">核销报废</button>
              <span v-if="r.status === 'closed'" class="tiny">{{ r.reinspect_note }}</span>
            </td>
          </tr>
          <tr v-if="!reworks.length"><td colspan="11" class="empty-cell">还没有返工/报废单</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        返工必须复验通过才闭环；复验不通过回到「返工中」并累计次数。闭环时损失自动进成本对象的 rework 层，毛利真实扣减。
      </p>
    </div>

    <!-- ============ 生产结单 ============ -->
    <div v-if="tab === 'close'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 160px">订单</th><th style="width: 120px">订单状态</th>
            <th style="width: 130px">工序完成</th><th style="width: 90px" class="num">未交</th>
            <th style="width: 110px" class="num">未闭环返工</th><th style="width: 90px" class="num">质量未决</th>
            <th>结单检查</th><th style="width: 120px">结单记录</th><th style="width: 110px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in closings" :key="r.order_id">
            <td class="mono">{{ r.order_no }}<div class="tiny">{{ r.style_name || '' }}</div></td>
            <td><span class="tag gray">{{ r.order_status }}</span></td>
            <td>{{ r.total_nodes ? r.total_nodes - r.wip_nodes + ' / ' + r.total_nodes : '未生成工序' }}</td>
            <td class="num" :class="r.unshipped ? 'warn' : ''">{{ fmt(r.unshipped) }}</td>
            <td class="num"><span :class="r.open_rework_cnt ? 'warn' : ''">{{ r.open_rework_cnt }}</span></td>
            <td class="num"><span :class="r.open_qc_cnt ? 'warn' : ''">{{ r.open_qc_cnt }}</span></td>
            <td class="wrap">
              <template v-if="r.can_close">
                <span class="tag green">通过</span>
                <span v-for="w in r.warns" :key="w.key" class="tag orange" style="margin-left: 4px">{{ w.label }}</span>
              </template>
              <template v-else>
                <span v-for="b in r.blocked" :key="b.key" class="tag red" style="margin-right: 4px">{{ b.label }}</span>
              </template>
            </td>
            <td class="tiny">
              <template v-if="r.closure">{{ r.closure.close_no }}<br />{{ r.closure.close_type_label }}</template>
              <span v-else class="muted">未结</span>
            </td>
            <td class="ops">
              <button class="link-btn" @click="openGate(r)">检查</button>
              <button v-if="canWrite && r.can_close" class="link-btn" @click="openClose(r)">结单</button>
            </td>
          </tr>
          <tr v-if="!closings.length"><td colspan="9" class="empty-cell">没有可结单的订单</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        硬阻塞：未闭环返工/报废、质量未决、工序未完成 → 不许结单。软提示：未交未出库、余料未清 → 只能部分关闭 + 争议挂账。
      </p>
    </div>

    <!-- ============ 新建返工/报废单 ============ -->
    <div v-if="form" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>新建返工 / 报废单</h3><button class="x" @click="form = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>订单 *</label>
              <select class="select" v-model.number="form.order_id" @change="loadNodes">
                <option :value="null">— 选择订单 —</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '' }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>处理方式 *</label>
              <select class="select" v-model="form.type">
                <option value="rework">返工（可修复）</option>
                <option value="scrap">报废（不可修复）</option>
              </select>
            </div>
            <div class="fitem">
              <label>原工序</label>
              <select class="select" v-model.number="form.node_id">
                <option :value="null">— 不指定 —</option>
                <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.seq }}. {{ n.name }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>来源</label>
              <select class="select" v-model="form.source">
                <option value="inhouse">本厂</option>
                <option value="outsource">外协</option>
                <option value="supplier">供方</option>
                <option value="customer">客户端</option>
              </select>
            </div>
            <div class="fitem"><label>责任方</label><input class="input" v-model="form.responsibility" placeholder="一车间 / 恒泰 / 蒙特布料" /></div>
            <div class="fitem"><label>不良数量 *</label><input class="input" type="number" v-model.number="form.qty" /></div>
            <div class="fitem"><label>人工损失</label><input class="input" type="number" v-model.number="form.cost_labor" placeholder="返工工时 × 单价" /></div>
            <div class="fitem"><label>材料损失</label><input class="input" type="number" v-model.number="form.cost_material" placeholder="报废材料 / 补料" /></div>
            <div class="fitem full"><label>不良原因 *</label><textarea v-model="form.reason" rows="2" placeholder="领口罗纹车线跳针，需拆线重车"></textarea></div>
            <div class="fitem full"><label>证据 / 照片说明</label><input class="input" v-model="form.evidence" /></div>
          </div>
          <p class="tiny" style="margin-top: 8px">报废必须填损失金额；返工单在复验通过时才把损失写进成本。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="form = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="save">保存</button>
        </div>
      </div>
    </div>

    <!-- ============ 复验 ============ -->
    <div v-if="reinspect" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>复验 · {{ reinspect.rw_no }}</h3><button class="x" @click="reinspect = null">×</button></div>
        <div class="modal-body">
          <div class="tiny" style="margin-bottom: 10px">{{ reinspect.reason }} · 不良 {{ fmt(reinspect.qty) }} 件</div>
          <div class="fitem"><label>本次返工后合格量</label><input class="input" type="number" v-model.number="reinspect._qty_ok" /></div>
          <div class="fitem" style="margin-top: 10px"><label>复验依据 *</label><textarea v-model="reinspect._note" rows="2" placeholder="抽检 5 件无跳针，18 件可入库，2 件降级"></textarea></div>
          <div class="radio-list" style="margin-top: 10px">
            <label><input type="radio" value="pass" v-model="reinspect._result" /><span><b>通过，闭环</b><i>损失进成本 rework 层</i></span></label>
            <label><input type="radio" value="fail" v-model="reinspect._result" /><span><b>不通过</b><i>回到返工中，返工次数 +1</i></span></label>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="reinspect = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doReinspect">提交复验</button>
        </div>
      </div>
    </div>

    <!-- ============ 结单检查 ============ -->
    <div v-if="gate" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>结单检查 · {{ gate.order.order_no }}</h3><button class="x" @click="gate = null">×</button></div>
        <div class="modal-body">
          <div class="chk-grid">
            <div class="chk" :class="gate.open_rework_cnt ? 'bad' : 'ok'">
              <span>未闭环返工报废</span><b>{{ gate.open_rework_cnt }} 张</b><i>{{ fmt(gate.open_rework_qty) }} 件</i>
            </div>
            <div class="chk" :class="gate.open_qc_cnt ? 'bad' : 'ok'">
              <span>质量未决</span><b>{{ gate.open_qc_cnt }} 项</b><i>QC 未关闭</i>
            </div>
            <div class="chk" :class="gate.wip_nodes ? 'bad' : 'ok'">
              <span>工序完成</span><b>{{ gate.total_nodes - gate.wip_nodes }} / {{ gate.total_nodes }}</b><i>剩 {{ gate.wip_nodes }} 道</i>
            </div>
            <div class="chk" :class="gate.unshipped ? 'warn' : 'ok'">
              <span>未交</span><b>{{ fmt(gate.unshipped) }} 件</b><i>未出库</i>
            </div>
            <div class="chk" :class="gate.leftover_m ? 'warn' : 'ok'">
              <span>余料</span><b>{{ fmt(gate.leftover_m) }} 米</b><i>待清理</i>
            </div>
            <div class="chk" :class="gate.cost_open ? 'warn' : 'ok'">
              <span>成本归集</span><b>{{ gate.cost_open ? '未归集' : '已归集' }}</b><i>可结后补</i>
            </div>
          </div>
          <div v-if="gate.blocked.length" class="verdict bad">
            <b>结单受限</b>
            <div v-for="b in gate.blocked" :key="b.key">· {{ b.label }}<span v-if="b.detail" class="tiny">（{{ b.detail }}）</span></div>
          </div>
          <div v-else-if="gate.warns.length" class="verdict warn">
            <b>只能部分关闭 + 争议挂账</b>
            <div v-for="w in gate.warns" :key="w.key">· {{ w.label }}</div>
          </div>
          <div v-else class="verdict ok"><b>可以全结</b><div class="tiny">五项检查都过了</div></div>
          <div v-if="gate.notes && gate.notes.length" class="tiny" style="margin-top: 8px">
            提示：{{ gate.notes.map((n) => n.label).join('、') }}（不拦结单）
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="gate = null">关闭</button>
          <button v-if="canWrite && gate.can_close" class="btn btn-primary" @click="openCloseFromGate">去结单</button>
        </div>
      </div>
    </div>

    <!-- ============ 结单 ============ -->
    <div v-if="closeForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>生产结单 · {{ closeForm.order_no }}</h3><button class="x" @click="closeForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>结单类型</label>
              <select class="select" v-model="closeForm.close_type">
                <option value="full" :disabled="!!(closeForm._warns && closeForm._warns.length)">全结（无未清项）</option>
                <option value="partial">部分关闭 + 争议挂账</option>
              </select>
            </div>
            <div class="fitem"><label>实际结单日期 *</label><input class="input" type="date" v-model="closeForm.actual_close_date" /></div>
          </div>
          <div v-if="closeForm.close_type === 'partial'" style="margin-top: 12px">
            <div class="fitem"><label>争议挂账说明 *（未决的是什么、谁跟）</label><textarea v-model="closeForm.dispute_note" rows="2" placeholder="客户要求分两批出货，余 300 件等指定船期"></textarea></div>
            <div class="form-grid" style="margin-top: 10px">
              <div class="fitem"><label>余额来源 *</label><input class="input" v-model="closeForm.balance_source" placeholder="未交（待发货）/ 在制 / 质量 / 余料" /></div>
              <div class="fitem"><label>未决项跟进人</label><input class="input" v-model="closeForm.follow_up_owner" placeholder="赵主管" /></div>
            </div>
          </div>
          <p class="tiny" style="margin-top: 10px">实际日期与录入时间分开记录：补录也留真实录入时间，事后可查。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeForm = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doClose">确认结单</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('rework');
const q = ref('');
const reworks = ref([]);
const closings = ref([]);
const rwStat = ref({});
const clStat = ref({});
const orders = ref([]);
const nodes = ref([]);
const busy = ref(false);
const formMsg = ref('');

const form = ref(null);
const reinspect = ref(null);
const gate = ref(null);
const closeForm = ref(null);

const canWrite = computed(() => can('production.write') || can('qc.write'));
const fmt = (v) => (v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
function rwTag(s) {
  return { draft: 'gray', pending_approve: 'orange', approved: 'blue', in_progress: 'blue', closed: 'green', rejected: 'red' }[s] || 'gray';
}

async function loadRework() {
  try {
    const d = await api.reworkBoard({ q: q.value });
    reworks.value = d.rows;
    rwStat.value = d.stat;
  } catch (e) { alert(e.message); }
}
async function loadClose() {
  try {
    const d = await api.closeBoard({ q: q.value });
    closings.value = d.rows;
    clStat.value = d.stat;
  } catch (e) { alert(e.message); }
}
async function loadOrders() {
  try {
    const d = await api.orders();
    orders.value = (Array.isArray(d) ? d : d.rows || []).filter((o) => !['draft', 'cancelled'].includes(o.status));
  } catch (e) { orders.value = []; }
}
function reload() {
  if (tab.value === 'rework') loadRework();
  else loadClose();
}

function openNew() {
  formMsg.value = '';
  form.value = { order_id: null, type: 'rework', node_id: null, source: 'inhouse', responsibility: '', qty: 0, cost_labor: 0, cost_material: 0, reason: '', evidence: '' };
  nodes.value = [];
}
async function loadNodes() {
  nodes.value = [];
  form.value.node_id = null;
  if (!form.value.order_id) return;
  try {
    nodes.value = await api.reworkNodes(form.value.order_id);
  } catch (e) { nodes.value = []; }
}
async function save() {
  formMsg.value = '';
  if (!form.value.order_id) return (formMsg.value = '请选择订单');
  if (!(Number(form.value.qty) > 0)) return (formMsg.value = '不良数量必须大于 0');
  if (!String(form.value.reason || '').trim()) return (formMsg.value = '请写不良原因');
  busy.value = true;
  try {
    const r = await api.createRework({ ...form.value });
    form.value = null;
    await loadRework();
    alert(`已建 ${r.rw_no}（${r.status_label}）。下一步「提交批准」`);
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

async function doSubmit(r) {
  try { await api.submitRework(r.id); await loadRework(); } catch (e) { alert(e.message); }
}
async function doApprove(r, agree) {
  if (!agree) {
    const note = prompt('驳回理由：');
    if (note === null) return;
    if (!String(note).trim()) return alert('驳回必须写理由');
    try { await api.approveRework(r.id, { agree: false, note: note.trim() }); await loadRework(); } catch (e) { alert(e.message); }
    return;
  }
  try { await api.approveRework(r.id, { agree: true }); await loadRework(); } catch (e) { alert(e.message); }
}
async function doStart(r) {
  try { await api.startRework(r.id); await loadRework(); } catch (e) { alert(e.message); }
}
function openReinspect(r) {
  formMsg.value = '';
  reinspect.value = { ...r, _qty_ok: r.qty, _note: '', _result: 'pass' };
}
async function doReinspect() {
  formMsg.value = '';
  if (!String(reinspect.value._note || '').trim()) return (formMsg.value = '请写复验依据');
  busy.value = true;
  try {
    const r = await api.reinspectRework(reinspect.value.id, {
      result: reinspect.value._result,
      qty_ok: reinspect.value._qty_ok,
      note: reinspect.value._note
    });
    reinspect.value = null;
    await loadRework();
    await loadClose();
    alert(r.notice || '已提交复验');
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}
async function doScrap(r) {
  const note = prompt(`核销报废 ${r.rw_no}（${r.qty} 件，损失 ¥${r.cost_total}）的处置依据：`);
  if (note === null) return;
  if (!String(note).trim()) return alert('必须写处置依据');
  try {
    const res = await api.scrapRework(r.id, { qty_scrap: r.qty, note: note.trim() });
    await loadRework();
    await loadClose();
    alert(res.notice || '已核销');
  } catch (e) { alert(e.message); }
}

async function openGate(r) {
  try {
    gate.value = await api.closeGate(r.order_id);
  } catch (e) { alert(e.message); }
}
function openCloseFromGate() {
  const g = gate.value;
  gate.value = null;
  openClose({ order_id: g.order.id, order_no: g.order.order_no, can_close: g.can_close, warns: g.warns, blocked: g.blocked });
}
function openClose(r) {
  formMsg.value = '';
  const today = localDate();
  closeForm.value = {
    order_id: r.order_id,
    order_no: r.order_no || '',
    _warns: r.warns || [],
    close_type: (r.warns && r.warns.length) ? 'partial' : 'full',
    actual_close_date: today,
    dispute_note: '',
    balance_source: (r.warns && r.warns.length) ? r.warns[0].label : '',
    follow_up_owner: ''
  };
}
async function doClose() {
  formMsg.value = '';
  if (!closeForm.value.actual_close_date) return (formMsg.value = '请填实际结单日期');
  if (closeForm.value.close_type === 'partial') {
    if (!String(closeForm.value.dispute_note || '').trim()) return (formMsg.value = '部分关闭必须写争议挂账说明');
    if (!String(closeForm.value.balance_source || '').trim()) return (formMsg.value = '部分关闭必须写余额来源');
  }
  busy.value = true;
  try {
    const r = await api.closeOrder({
      order_id: closeForm.value.order_id,
      close_type: closeForm.value.close_type,
      actual_close_date: closeForm.value.actual_close_date,
      dispute_note: closeForm.value.dispute_note,
      balance_source: closeForm.value.balance_source,
      follow_up_owner: closeForm.value.follow_up_owner
    });
    closeForm.value = null;
    await loadClose();
    alert(r.notice || '已结单');
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

onMounted(() => {
  loadRework();
  loadClose();
  loadOrders();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.amt-blue { color: var(--brand) !important; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.tiny { font-size: 12px; color: var(--ink-mute); line-height: 1.5; }
.warn { color: #d92d45; }
.muted { color: #b6bfcc; }
.ops { white-space: nowrap; }
.wrap { white-space: normal !important; line-height: 1.55; }
.num { text-align: right; }
.rule-note { margin: 10px 0 0; font-size: 12px; color: var(--ink-mute); line-height: 1.6; }
.chk-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
.chk { border: 1px solid #e8edf4; border-radius: 10px; padding: 9px 11px; background: #fafbfd; }
.chk span { display: block; font-size: 12px; color: var(--ink-mute); }
.chk b { display: block; font-size: 15px; color: var(--ink); margin: 3px 0 1px; }
.chk i { font-size: 12px; color: var(--ink-mute); font-style: normal; }
.chk.ok { background: #f4fbf6; border-color: #d6efdd; }
.chk.warn { background: #fffaf2; border-color: #f3e2c4; }
.chk.bad { background: #fff6f7; border-color: #f6d9dd; }
.verdict { border-radius: 10px; padding: 10px 12px; font-size: 12.5px; line-height: 1.7; }
.verdict b { display: block; margin-bottom: 4px; }
.verdict.ok { background: #f4fbf6; color: #12864a; border: 1px solid #d6efdd; }
.verdict.warn { background: #fffaf2; color: #a4670a; border: 1px solid #f3e2c4; }
.verdict.bad { background: #fff6f7; color: #b7233a; border: 1px solid #f6d9dd; }
.radio-list { display: flex; flex-direction: column; gap: 8px; }
.radio-list label { display: flex; align-items: flex-start; gap: 8px; border: 1px solid #e8edf4; border-radius: 9px; padding: 9px 11px; cursor: pointer; }
.radio-list span { display: flex; flex-direction: column; gap: 2px; }
.radio-list b { font-size: 12.5px; color: var(--ink); font-weight: 600; }
.radio-list i { font-size: 12px; color: var(--ink-mute); font-style: normal; }
@media (max-width: 1280px) { .stat-row { grid-template-columns: repeat(4, 1fr); } .chk-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .chk-grid { grid-template-columns: 1fr; } }
</style>
