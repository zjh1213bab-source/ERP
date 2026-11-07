<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>停单改量与供应商退料</h2>
        <p class="sub">
          原需求变更 → 未交协商 → 实物处置（退料）→ 贷项差异结算。
          取消/减量<b>不自动抹掉</b>在途、已领材料或供应商债务：减量只动「未交」，已收只能退不能停，退料要实物 + 贷项两道回执。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openNewChange()">＋ 开变更单</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openNewReturn()">＋ 开退料单</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>变更单</span><strong>{{ stat.changes || 0 }}</strong><small>减量 / 停单</small></div>
      <div class="stat"><span>待供方确认</span><strong :class="stat.pending_supplier ? 'amt-orange' : ''">{{ stat.pending_supplier || 0 }}</strong><small>未交协商中</small></div>
      <div class="stat"><span>退料单</span><strong>{{ stat.returns || 0 }}</strong><small>已收未用退回</small></div>
      <div class="stat"><span>待实物回执</span><strong :class="stat.pending_receipt ? 'amt-orange' : ''">{{ stat.pending_receipt || 0 }}</strong><small>还没退回实物</small></div>
      <div class="stat"><span>待贷项</span><strong :class="stat.pending_credit ? 'amt-blue' : ''">{{ stat.pending_credit || 0 }}</strong><small>实物退了等贷项</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'change' }" @click="tab = 'change'">改量 / 停单</button>
        <button :class="{ on: tab === 'return' }" @click="tab = 'return'">退料</button>
      </div>
    </div>

    <!-- ============ 变更单 ============ -->
    <div v-if="tab === 'change'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 140px">变更单</th><th style="width: 150px">供应商</th><th style="width: 160px">原采购单</th>
            <th style="width: 80px">类型</th><th style="width: 90px" class="num">减量(未交)</th>
            <th style="width: 90px" class="num">可退(已收)</th><th>原因</th>
            <th style="width: 110px">状态</th><th style="width: 210px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in changes" :key="c.id">
            <td class="mono">{{ c.change_no }}<div class="tiny">V{{ c.version }}</div></td>
            <td>{{ c.supplier_name || '-' }}</td>
            <td class="mono">{{ c.po_no }}</td>
            <td><span class="tag" :class="c.type === 'cancel' ? 'red' : 'blue'">{{ c.type === 'cancel' ? '停单' : '减量' }}</span></td>
            <td class="num">{{ fmt(c.reduce_qty) }}</td>
            <td class="num">{{ fmt(c.returnable_qty) }}</td>
            <td class="wrap tiny">{{ c.reason }}</td>
            <td><span class="tag" :class="chgTag(c.status)">{{ c.status_label }}</span></td>
            <td class="ops">
              <button class="link-btn" @click="openChange(c)">明细</button>
              <button v-if="canWrite && c.status === 'draft'" class="link-btn" @click="submitChange(c)">提交供方</button>
              <button v-if="canWrite && c.status === 'pending_supplier'" class="link-btn" @click="confirmChange(c, true)">供方确认</button>
              <button v-if="canWrite && c.status === 'confirmed'" class="link-btn" @click="effectiveChange(c)">生效</button>
              <button v-if="canWrite && ['draft','pending_supplier','rejected'].includes(c.status)" class="link-btn danger" @click="voidChange(c)">作废</button>
            </td>
          </tr>
          <tr v-if="!changes.length"><td colspan="9" class="empty-cell">还没有变更单。客户改单后，到这里对「未交」部分减量或停单</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        减量只动「未交」；已收未用的料走「退料」。整单停单要求先无到货，否则会被拦。
      </p>
    </div>

    <!-- ============ 退料单 ============ -->
    <div v-if="tab === 'return'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 140px">退料单</th><th style="width: 150px">供应商</th><th style="width: 160px">原采购单</th>
            <th style="width: 90px" class="num">退料量</th><th>原因</th>
            <th style="width: 200px">实物回执</th><th style="width: 200px">贷项回执</th>
            <th style="width: 110px">状态</th><th style="width: 150px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in returns" :key="r.id">
            <td class="mono">{{ r.return_no }}</td>
            <td>{{ r.supplier_name || '-' }}</td>
            <td class="mono">{{ r.po_no }}</td>
            <td class="num">{{ fmt(r.return_qty) }}</td>
            <td class="wrap tiny">{{ r.reason }}</td>
            <td class="tiny wrap">{{ r.physical_receipt_note || '—' }}<div v-if="r.physical_by" class="tiny">{{ r.physical_by }} {{ $fmt(r.physical_at) }}</div></td>
            <td class="tiny wrap">
              <template v-if="r.credit_note_no">{{ r.credit_note_no }} · ¥{{ fmt(r.credit_amount) }}</template>
              <span v-else>—</span>
            </td>
            <td><span class="tag" :class="retTag(r.status)">{{ r.status_label }}</span></td>
            <td class="ops">
              <button class="link-btn" @click="openReturn(r)">明细</button>
              <button v-if="canWrite && r.status === 'pending_receipt'" class="link-btn" @click="physicalReturn(r)">实物回执</button>
              <button v-if="canWrite && r.status === 'returned'" class="link-btn" @click="creditReturn(r)">贷项回执</button>
              <button v-if="canWrite && r.status === 'pending_receipt'" class="link-btn danger" @click="voidReturn(r)">作废</button>
            </td>
          </tr>
          <tr v-if="!returns.length"><td colspan="9" class="empty-cell">还没有退料单。已收未用的余料，从这里退给供应商</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        退料两道回执缺一不算完成：先实物（物流/签收，扣本厂可用库存），再贷项（供应商贷项凭证，冲减应付）。
      </p>
    </div>

    <!-- ============ 开变更单 ============ -->
    <div v-if="changeForm" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>开变更单（减量 / 停单）</h3><button class="x" @click="changeForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>采购单 *</label>
              <select class="select" v-model.number="changeForm.po_id" @change="loadPo">
                <option :value="null">— 选择 —</option>
                <option v-for="p in pos" :key="p.id" :value="p.id">{{ p.po_no }} · {{ p.supplier }}</option>
              </select>
            </div>
            <div class="fitem"><label>类型 *</label>
              <select class="select" v-model="changeForm.type">
                <option value="reduce">减量（动未交）</option>
                <option value="cancel">停单（整单取消）</option>
              </select>
            </div>
            <div class="fitem full"><label>变更原因 *</label><input class="input" v-model="changeForm.reason" placeholder="客户改单 / 停产 / 换料 / 交期取消…" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="changeForm.note" /></div>
          </div>

          <div v-if="poLines && changeForm.type === 'reduce'" class="table-wrap" style="margin-top: 12px">
            <table class="data">
              <thead><tr><th>物料</th><th style="width: 90px" class="num">采购量</th><th style="width: 80px" class="num">已收</th><th style="width: 80px" class="num">已领</th><th style="width: 90px" class="num">未交</th><th style="width: 110px" class="num">本次减量</th><th style="width: 90px" class="num">可退</th><th style="width: 70px">退料</th></tr></thead>
              <tbody>
                <tr v-for="l in poLines" :key="l.id">
                  <td>{{ l.name }}<div class="tiny">{{ l.spec || '' }}</div></td>
                  <td class="num">{{ fmt(l.qty) }}</td>
                  <td class="num">{{ fmt(l.received_qty) }}</td>
                  <td class="num">{{ fmt(l.issued_qty) }}</td>
                  <td class="num"><b :class="l.pending_qty ? '' : 'muted'">{{ fmt(l.pending_qty) }}</b></td>
                  <td class="num"><input class="input mini" type="number" min="0" v-model.number="l._reduce" :disabled="l.pending_qty <= 0" /></td>
                  <td class="num">{{ fmt(l.returnable_qty) }}</td>
                  <td class="center"><input type="checkbox" v-model="l._ret" :disabled="l.returnable_qty <= 0" /></td>
                </tr>
              </tbody>
            </table>
            <p v-if="poSummary" class="tiny" style="margin-top: 8px">已收合计 {{ fmt(poSummary.total_received) }}，未交 {{ fmt(poSummary.total_pending) }}，可退 {{ fmt(poSummary.total_returnable) }}</p>
          </div>
          <p v-if="changeForm.type === 'cancel'" class="tiny" style="margin-top: 10px">
            停单 = 整单取消所有「未交」量。若这张单已经有到货，会被拦下，需要改走「减量 + 退料」。
          </p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="changeForm = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="saveChange">保存草稿</button>
        </div>
      </div>
    </div>

    <!-- ============ 开退料单 ============ -->
    <div v-if="returnForm" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>开退料单</h3><button class="x" @click="returnForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>采购单 *</label>
              <select class="select" v-model.number="returnForm.po_id" @change="loadReturnPo">
                <option :value="null">— 选择 —</option>
                <option v-for="p in pos" :key="p.id" :value="p.id">{{ p.po_no }} · {{ p.supplier }}</option>
              </select>
            </div>
            <div class="fitem full"><label>退料原因 *</label><input class="input" v-model="returnForm.reason" placeholder="客户取消 / 换料 / 质量 / 超购…" /></div>
          </div>
          <div v-if="returnLines" class="table-wrap" style="margin-top: 12px">
            <table class="data">
              <thead><tr><th>物料</th><th style="width: 90px" class="num">已收</th><th style="width: 80px" class="num">已领</th><th style="width: 80px" class="num">已退</th><th style="width: 90px" class="num">可退</th><th style="width: 110px" class="num">本次退料</th></tr></thead>
              <tbody>
                <tr v-for="l in returnLines" :key="l.id">
                  <td>{{ l.name }}<div class="tiny">{{ l.spec || '' }}</div></td>
                  <td class="num">{{ fmt(l.received_qty) }}</td>
                  <td class="num">{{ fmt(l.issued_qty) }}</td>
                  <td class="num">{{ fmt(l.returned_qty) }}</td>
                  <td class="num"><b :class="l.returnable_qty ? '' : 'muted'">{{ fmt(l.returnable_qty) }}</b></td>
                  <td class="num"><input class="input mini" type="number" min="0" v-model.number="l._qty" :disabled="l.returnable_qty <= 0" /></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="returnForm = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="saveReturn">保存</button>
        </div>
      </div>
    </div>

    <!-- ============ 变更明细 ============ -->
    <div v-if="chgDetail" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ chgDetail.change_no }} · {{ chgDetail.supplier_name }}</h3>
          <button class="x" @click="chgDetail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="tiny" style="margin-bottom: 10px">类型 {{ chgDetail.type === 'cancel' ? '停单' : '减量' }} · {{ chgDetail.reason }}<span v-if="chgDetail.supplier_comment"> · 供方：{{ chgDetail.supplier_comment }}</span></div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>物料</th><th style="width: 90px" class="num">采购量</th><th style="width: 80px" class="num">已收</th><th style="width: 80px" class="num">已领</th><th style="width: 90px" class="num">本次减量</th><th style="width: 90px" class="num">减后</th><th style="width: 90px" class="num">可退</th><th style="width: 70px">退料</th></tr></thead>
              <tbody>
                <tr v-for="it in chgDetail.items" :key="it.id">
                  <td>{{ it.material_name }}<div class="tiny">{{ it.spec || '' }}</div></td>
                  <td class="num">{{ fmt(it.qty) }}</td>
                  <td class="num">{{ fmt(it.received_qty) }}</td>
                  <td class="num">{{ fmt(it.issued_qty) }}</td>
                  <td class="num">{{ fmt(it.reduce_qty) }}</td>
                  <td class="num"><b>{{ fmt(it.new_qty) }}</b></td>
                  <td class="num">{{ fmt(it.returnable_qty) }}</td>
                  <td class="center">{{ it.return_flag ? '是' : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="chgDetail = null">关闭</button></div>
      </div>
    </div>

    <!-- ============ 退料明细 ============ -->
    <div v-if="retDetail" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>{{ retDetail.return_no }} · {{ retDetail.supplier_name }}</h3><button class="x" @click="retDetail = null">×</button></div>
        <div class="modal-body">
          <div class="tiny" style="margin-bottom: 10px">{{ retDetail.reason }} · 状态 {{ retDetail.status_label }}</div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>物料</th><th style="width: 90px" class="num">退料量</th><th style="width: 90px" class="num">单价</th><th style="width: 110px" class="num">金额</th></tr></thead>
              <tbody>
                <tr v-for="it in retDetail.items" :key="it.id">
                  <td>{{ it.material_name }}<div class="tiny">{{ it.spec || '' }}</div></td>
                  <td class="num">{{ fmt(it.qty) }}</td>
                  <td class="num">{{ fmt(it.unit_price) }}</td>
                  <td class="num">{{ fmt(it.amount) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="retDetail = null">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('change');
const changes = ref([]);
const returns = ref([]);
const stat = ref({});
const pos = ref([]);
const busy = ref(false);
const formMsg = ref('');

const changeForm = ref(null);
const poLines = ref(null);
const poSummary = ref(null);
const returnForm = ref(null);
const returnLines = ref(null);
const chgDetail = ref(null);
const retDetail = ref(null);

const canWrite = computed(() => can('purchase.write'));

const fmt = (v) => (v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
function chgTag(s) { return { draft: 'gray', pending_supplier: 'orange', confirmed: 'blue', rejected: 'red', effective: 'green', voided: 'gray' }[s] || 'gray'; }
function retTag(s) { return { pending_receipt: 'orange', returned: 'blue', credited: 'blue', done: 'green', voided: 'gray' }[s] || 'gray'; }

function reduceOf(l) { if (l._reduce === undefined) l._reduce = 0; return l._reduce; }

async function loadBoard() {
  try {
    const d = await api.purchaseChangeBoard({});
    changes.value = d.changes;
    returns.value = d.returns;
    stat.value = d.stat;
  } catch (e) { alert(e.message); }
}
async function loadPos() {
  try {
    const d = await api.purchases({});
    pos.value = Array.isArray(d) ? d : (d.rows || []);
  } catch (e) { pos.value = []; }
}
function reload() { loadBoard(); }

function openNewChange() {
  formMsg.value = '';
  changeForm.value = { po_id: null, type: 'reduce', reason: '', note: '' };
  poLines.value = null;
  poSummary.value = null;
}
async function loadPo() {
  if (!changeForm.value.po_id) { poLines.value = null; poSummary.value = null; return; }
  try {
    const d = await api.purchaseChangePo(changeForm.value.po_id);
    poLines.value = d.lines.map((l) => ({ ...l, _reduce: 0, _ret: false }));
    poSummary.value = d.summary;
  } catch (e) { alert(e.message); }
}
async function saveChange() {
  formMsg.value = '';
  if (!changeForm.value.po_id) return (formMsg.value = '请选择采购单');
  if (!String(changeForm.value.reason || '').trim()) return (formMsg.value = '请写变更原因');
  busy.value = true;
  try {
    let body;
    if (changeForm.value.type === 'cancel') {
      body = { po_id: changeForm.value.po_id, type: 'cancel', reason: changeForm.value.reason, note: changeForm.value.note };
    } else {
      const items = (poLines.value || []).filter((l) => Number(l._reduce) > 0)
        .map((l) => ({ po_item_id: l.id, reduce_qty: l._reduce, return_flag: l._ret }));
      if (!items.length) return (formMsg.value = '请至少填一行减量');
      body = { po_id: changeForm.value.po_id, type: 'reduce', reason: changeForm.value.reason, note: changeForm.value.note, items };
    }
    const r = await api.createPurchaseChange(body);
    changeForm.value = null;
    await loadBoard();
    alert(`已建变更单 ${r.change_no}（${r.status_label}）。下一步「提交供方」`);
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

function openNewReturn() {
  formMsg.value = '';
  returnForm.value = { po_id: null, reason: '' };
  returnLines.value = null;
}
async function loadReturnPo() {
  if (!returnForm.value.po_id) { returnLines.value = null; return; }
  try {
    const d = await api.purchaseChangePo(returnForm.value.po_id);
    returnLines.value = d.lines.filter((l) => l.returnable_qty > 0).map((l) => ({ ...l, _qty: 0 }));
  } catch (e) { alert(e.message); }
}
async function saveReturn() {
  formMsg.value = '';
  if (!returnForm.value.po_id) return (formMsg.value = '请选择采购单');
  if (!String(returnForm.value.reason || '').trim()) return (formMsg.value = '请写退料原因');
  const items = (returnLines.value || []).filter((l) => Number(l._qty) > 0).map((l) => ({ po_item_id: l.id, qty: l._qty }));
  if (!items.length) return (formMsg.value = '请至少填一行退料数量');
  busy.value = true;
  try {
    const r = await api.createPurchaseReturn({ po_id: returnForm.value.po_id, reason: returnForm.value.reason, items });
    returnForm.value = null;
    await loadBoard();
    alert(`已建退料单 ${r.return_no}。先「实物回执」退回实物，再「贷项回执」结算`);
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

async function submitChange(c) {
  try { await api.submitPurchaseChange(c.id); await loadBoard(); } catch (e) { alert(e.message); }
}
async function confirmChange(c, agree) {
  if (!agree) {
    const comment = prompt('供方拒绝的理由：');
    if (comment === null) return;
    if (!String(comment).trim()) return alert('拒绝必须写理由');
    try { await api.confirmPurchaseChange(c.id, { agree: false, supplier_comment: comment.trim() }); await loadBoard(); } catch (e) { alert(e.message); }
    return;
  }
  try { await api.confirmPurchaseChange(c.id, { agree: true }); await loadBoard(); } catch (e) { alert(e.message); }
}
async function effectiveChange(c) {
  if (!confirm(`生效变更单 ${c.change_no}？会落到采购行（减量）或把采购单置为已取消`)) return;
  try { await api.effectivePurchaseChange(c.id); await loadBoard(); alert('已生效'); } catch (e) { alert(e.message); }
}
async function voidChange(c) {
  if (!confirm(`作废变更单 ${c.change_no}？`)) return;
  try { await api.voidPurchaseChange(c.id); await loadBoard(); } catch (e) { alert(e.message); }
}
async function openChange(c) { chgDetail.value = c; }
async function openReturn(r) { retDetail.value = r; }

async function physicalReturn(r) {
  const note = prompt(`登记「${r.return_no}」的实物回执（物流单号 / 供应商签收）：`);
  if (note === null) return;
  if (!String(note).trim()) return alert('必须填回执依据');
  try { await api.physicalReturn(r.id, { note: note.trim() }); await loadBoard(); alert('已登记实物回执，扣减本厂可用库存'); } catch (e) { alert(e.message); }
}
async function creditReturn(r) {
  const no = prompt(`登记「${r.return_no}」的贷项凭证号：`);
  if (no === null) return;
  if (!String(no).trim()) return alert('必须填贷项凭证号');
  const amt = prompt('贷项金额（冲减应付，可留 0 让财务填）：', String(r.return_amount || 0)) || '0';
  try { await api.creditReturn(r.id, { credit_note_no: no.trim(), credit_amount: Number(amt) || 0 }); await loadBoard(); alert('已收贷项凭证，退料完成'); } catch (e) { alert(e.message); }
}
async function voidReturn(r) {
  if (!confirm(`作废退料单 ${r.return_no}？`)) return;
  try { await api.voidReturn(r.id); await loadBoard(); } catch (e) { alert(e.message); }
}

onMounted(() => { loadBoard(); loadPos(); });
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 14px; }
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
.ops { white-space: nowrap; }
.wrap { white-space: normal !important; line-height: 1.55; }
.num { text-align: right; }
.center { text-align: center; }
.muted { color: #b6bfcc; }
.rule-note { margin: 10px 0 0; font-size: 12px; color: var(--ink-mute); line-height: 1.6; }
.input.mini { width: 90px; padding: 4px 8px; font-size: 12.5px; text-align: right; }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } }
</style>
