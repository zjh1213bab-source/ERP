<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>原料收货检验</h2>
        <p class="sub">
          P3 到料 → 仓库点收（收料单）→ 来料检查 → 只有合格量进可用库存 → P4 配出合格量。
          收货不自动可用：待检的面料不会被齐套和裁床认作库存。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="loadBoard">刷新</button>
        <button class="btn btn-primary" @click="openNew">＋ 开收料单</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>待检</span>
        <strong :class="stat.pending_qty ? 'amt-orange' : ''">{{ stat.pending_orders || 0 }}</strong>
        <small>待检量 {{ stat.pending_qty || 0 }}</small>
      </div>
      <div class="stat">
        <span>本月收货</span>
        <strong>{{ stat.month_recv || 0 }}</strong>
        <small>{{ stat.month || '' }}</small>
      </div>
      <div class="stat">
        <span>本月合格率</span>
        <strong class="amt-green">{{ stat.pass_rate === null || stat.pass_rate === undefined ? '-' : stat.pass_rate + '%' }}</strong>
        <small>合格 {{ stat.month_pass || 0 }}</small>
      </div>
      <div class="stat">
        <span>冻结</span>
        <strong :class="stat.freeze_qty ? 'amt-blue' : ''">{{ stat.freeze_qty || 0 }}</strong>
        <small>待处置</small>
      </div>
      <div class="stat">
        <span>退回</span>
        <strong :class="stat.reject_qty ? 'amt-red' : ''">{{ stat.reject_qty || 0 }}</strong>
        <small>已回退采购行</small>
      </div>
      <div class="stat">
        <span>超收 / 短收</span>
        <strong :class="stat.diff_orders ? 'amt-red' : ''">{{ stat.diff_orders || 0 }}</strong>
        <small>需按原单调查</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="收料单 / 采购单 / 供应商" style="width: 230px" @keyup.enter="loadBoard" />
      <select class="select" v-model="status" style="width: 150px" @change="loadBoard">
        <option value="">全部状态</option>
        <option value="pending">待检</option>
        <option value="inspecting">检验中</option>
        <option value="partial">部分合格</option>
        <option value="passed">全部合格</option>
        <option value="rejected">全退</option>
        <option value="cancelled">已作废</option>
      </select>
      <button class="btn btn-ghost" @click="loadBoard">查询</button>
      <div style="flex: 1"></div>
      <span class="muted" style="font-size: 12px">点收后进「待检」，检验合格的那部分才进可用库存</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 152px">收料单</th>
            <th style="width: 140px">采购单</th>
            <th style="min-width: 150px">供应商</th>
            <th style="width: 100px">收货日</th>
            <th style="width: 64px">明细</th>
            <th style="width: 76px">应收</th>
            <th style="width: 76px">实收</th>
            <th style="width: 76px">待检</th>
            <th style="width: 76px">合格</th>
            <th style="width: 72px">冻结</th>
            <th style="width: 72px">退回</th>
            <th style="width: 100px">状态</th>
            <th style="width: 74px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ 'row-warn': r.status === 'pending', 'row-red': r.status === 'rejected' }">
            <td>{{ r.grn_no }}</td>
            <td class="sub-cell">{{ r.po_no || '-' }}</td>
            <td class="sub-cell">{{ r.supplier || '-' }}</td>
            <td>{{ r.receive_date || '-' }}</td>
            <td class="center">{{ r.line_count }}</td>
            <td class="num">{{ r.expect_qty }}</td>
            <td class="num strong">{{ r.receive_qty }}</td>
            <td class="num" :class="r.pending_qty ? 'amt-orange' : ''">{{ r.pending_qty || '-' }}</td>
            <td class="num amt-green">{{ r.pass_qty || '-' }}</td>
            <td class="num" :class="r.freeze_qty ? 'amt-blue' : ''">{{ r.freeze_qty || '-' }}</td>
            <td class="num" :class="r.reject_qty ? 'amt-red' : ''">{{ r.reject_qty || '-' }}</td>
            <td><span class="tag" :class="statusTag(r.status)">{{ r.status_label }}</span></td>
            <td class="ops"><button class="link-btn" @click="openDetail(r)">处理</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="13" class="empty-cell">还没有收料单。采购单点「到货」会自动生成，也可以点右上角「开收料单」</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 详情 / 处理 -->
    <div v-if="cur" class="modal-mask" @click.self="cur = null">
      <div class="modal xwide grn-modal">
        <div class="modal-head">
          <h3>
            {{ cur.grn_no }}
            <span class="muted" style="font-weight: 400; font-size: 12px">
              · {{ cur.po_no || '-' }} · {{ cur.supplier || '' }} · {{ cur.status_label }}
            </span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <div class="grn-sum">
            <div><span>应收</span><b>{{ cur.expect_qty }}</b></div>
            <div><span>实收</span><b>{{ cur.receive_qty }}</b></div>
            <div><span>待检</span><b :class="cur.pending_qty ? 'amt-orange' : ''">{{ cur.pending_qty }}</b></div>
            <div><span>合格</span><b class="amt-green">{{ cur.pass_qty }}</b></div>
            <div><span>冻结</span><b :class="cur.freeze_qty ? 'amt-blue' : ''">{{ cur.freeze_qty }}</b></div>
            <div><span>退回</span><b :class="cur.reject_qty ? 'amt-red' : ''">{{ cur.reject_qty }}</b></div>
            <div><span>超收</span><b :class="cur.over_qty ? 'amt-red' : ''">{{ cur.over_qty || 0 }}</b></div>
            <div><span>短收</span><b :class="cur.short_qty ? 'amt-orange' : ''">{{ cur.short_qty || 0 }}</b></div>
          </div>

          <div v-if="cur.over_qty" class="grn-warn">
            ⚠ 本单超收 {{ cur.over_qty }}，按原单调查（多送 / 磅差 / 单位换算），不要直接当库存用。
          </div>
          <div v-if="cur.short_qty" class="grn-warn warn-amber">
            短收 {{ cur.short_qty }}，采购行已收数量不含这批缺量，等供应商补发后重新点收。
          </div>
          <div v-if="cur.pending_qty" class="grn-warn warn-amber">
            还有 {{ cur.pending_qty }} 在「待检」，这部分不进可用库存；齐套和裁床都不会认。
          </div>

          <div class="grn-sec">
            <div class="grn-sec-head">
              <h4>收料明细（卷 / 缸 可追）</h4>
              <span class="muted" style="font-size: 12px">库位 {{ cur.warehouse || '原料库' }} · 点收人 {{ cur.receive_by || '-' }}</span>
            </div>
            <div class="table-wrap">
              <table class="data grn-tbl">
                <thead>
                  <tr>
                    <th style="min-width: 150px">物料</th>
                    <th style="width: 96px">规格</th>
                    <th style="width: 110px">卷号</th>
                    <th style="width: 110px">缸号</th>
                    <th style="width: 106px">库位</th>
                    <th style="width: 66px">应收</th>
                    <th style="width: 66px">实收</th>
                    <th style="width: 78px">差异</th>
                    <th style="width: 62px">待检</th>
                    <th style="width: 62px">合格</th>
                    <th style="width: 62px">冻结</th>
                    <th style="width: 62px">退回</th>
                    <th style="width: 88px">状态</th>
                    <th style="width: 76px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="it in cur.items" :key="it.id">
                    <td>{{ it.material_name }}</td>
                    <td class="sub-cell">{{ it.spec || '-' }}</td>
                    <td>{{ it.roll_no || '-' }}</td>
                    <td :class="it.dye_lot ? '' : 'muted'">{{ it.dye_lot || '未录' }}</td>
                    <td class="sub-cell">{{ it.location || '-' }}</td>
                    <td class="num">{{ it.expect_qty }}</td>
                    <td class="num strong">{{ it.receive_qty }}</td>
                    <td class="num" :class="it.diff_type === 'over' ? 'amt-red' : it.diff_type === 'short' ? 'amt-orange' : ''">
                      {{ it.diff_type === 'none' ? '-' : (it.diff_qty > 0 ? '+' : '') + it.diff_qty }}
                      <span v-if="it.diff_label" class="diff-lab">{{ it.diff_label }}</span>
                    </td>
                    <td class="num">{{ it.pending_qty || '-' }}</td>
                    <td class="num amt-green">{{ it.pass_qty || '-' }}</td>
                    <td class="num" :class="it.freeze_qty ? 'amt-blue' : ''">{{ it.freeze_qty || '-' }}</td>
                    <td class="num" :class="it.reject_qty ? 'amt-red' : ''">{{ it.reject_qty || '-' }}</td>
                    <td><span class="tag" :class="lineTag(it.status)">{{ it.status_label }}</span></td>
                    <td class="ops">
                      <button v-if="cur.status !== 'cancelled' && cur.status !== 'passed'" class="link-btn" @click="editLoc(it)">卷缸</button>
                      <button v-if="it.freeze_qty > 0" class="link-btn" @click="dispose(it)">处置</button>
                    </td>
                  </tr>
                  <tr v-if="!cur.items.length"><td colspan="14" class="empty-cell">没有明细</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 检验 -->
          <div v-if="cur.can_inspect" class="grn-sec inspect-box">
            <div class="grn-sec-head">
              <h4>来料检查</h4>
              <span class="muted" style="font-size: 12px">
                合格 + 冻结 + 退回 必须等于本次检验量；冻结 / 退回要写原因。只有合格量进可用库存。
              </span>
            </div>
            <div class="table-wrap">
              <table class="data ins-tbl">
                <thead>
                  <tr>
                    <th style="min-width: 140px">物料</th>
                    <th style="width: 66px">待检</th>
                    <th style="width: 92px">合格</th>
                    <th style="width: 92px">冻结</th>
                    <th style="width: 92px">退回</th>
                    <th style="min-width: 220px">原因（冻结 / 退回必填）</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="it in inspectable" :key="'i' + it.id">
                    <td>{{ it.material_name }}<span class="muted" style="font-size: 11px"> {{ it.unit || '' }}</span></td>
                    <td class="num">{{ it.pending_qty }}</td>
                    <td><input class="input cell num" type="number" v-model.number="ins[it.id].pass_qty" /></td>
                    <td><input class="input cell num" type="number" v-model.number="ins[it.id].freeze_qty" /></td>
                    <td><input class="input cell num" type="number" v-model.number="ins[it.id].reject_qty" /></td>
                    <td><input class="input cell" v-model="ins[it.id].note" placeholder="色差 / 克重不足 / 破损 / 规格不符" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 处置记录 -->
          <div v-if="cur.actions.length" class="grn-sec">
            <h4>处置记录</h4>
            <ul class="act-list">
              <li v-for="a in cur.actions" :key="a.id">
                <span class="tag" :class="a.action === 'release' ? 'green' : a.action === 'reject' ? 'red' : 'gray'">
                  {{ a.action === 'release' ? '冻结放行' : a.action === 'reject' ? '转退回' : '检验' }}
                </span>
                <b>{{ a.qty }}</b>
                <span class="sub-cell">{{ a.reason || '-' }}</span>
                <span class="muted">{{ a.operator }} · {{ $fmt(a.created_at) }}</span>
              </li>
            </ul>
          </div>
        </div>
        <div class="modal-foot">
          <span class="muted" style="margin-right: auto; font-size: 12px">
            <template v-if="cur.inspect_by">检验 {{ cur.inspect_by }} · {{ $fmt(cur.inspect_at) }}</template>
            <template v-else>点收 {{ $fmt(cur.receive_at) }}</template>
          </span>
          <button class="btn btn-ghost" @click="cur = null">关闭</button>
          <button v-if="cur.can_cancel" class="btn btn-danger" :disabled="busy" @click="cancelGrn">作废</button>
          <button v-if="cur.can_inspect" class="btn btn-primary" :disabled="busy" @click="submitInspect">提交检验</button>
          <span v-else-if="cur.status === 'passed'" class="tag green">全部合格，已进可用库存</span>
        </div>
      </div>
    </div>

    <!-- 开收料单 -->
    <div v-if="newOpen" class="modal-mask" @click.self="newOpen = false">
      <div class="modal xwide new-modal">
        <div class="modal-head">
          <h3>开收料单（点收）</h3>
          <button class="x" @click="newOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>采购单
              <select class="select" v-model.number="newForm.po_id" @change="loadPo" style="min-width: 260px">
                <option :value="0">请选择已下单的采购单</option>
                <option v-for="p in poList" :key="p.id" :value="p.id">{{ p.po_no }} · {{ p.supplier || '-' }}</option>
              </select>
            </label>
            <label>收货日期
              <input class="input" type="date" v-model="newForm.receive_date" />
            </label>
            <label>仓库
              <input class="input" v-model="newForm.warehouse" style="width: 110px" />
            </label>
          </div>
          <div v-if="newForm.po_id && poItems.length" class="table-wrap" style="margin-top: 12px">
            <table class="data new-tbl">
              <thead>
                <tr>
                  <th style="min-width: 160px">物料</th>
                  <th style="width: 88px">采购量</th>
                  <th style="width: 82px">已到</th>
                  <th style="width: 82px">应收</th>
                  <th style="width: 96px">实收 *</th>
                  <th style="width: 110px">卷号</th>
                  <th style="width: 110px">缸号</th>
                  <th style="width: 100px">库位</th>
                  <th style="min-width: 160px">超收原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(it, i) in poItems" :key="it.po_item_id">
                  <td>{{ it.material_name }}<span class="muted" style="font-size: 11px"> {{ it.unit || '' }}</span></td>
                  <td class="num">{{ it.qty }}</td>
                  <td class="num">{{ it.received_qty }}</td>
                  <td class="num">{{ it.expect_qty }}</td>
                  <td><input class="input cell num" type="number" v-model.number="newRow[i].receive_qty" /></td>
                  <td><input class="input cell" v-model="newRow[i].roll_no" /></td>
                  <td><input class="input cell" v-model="newRow[i].dye_lot" /></td>
                  <td><input class="input cell" v-model="newRow[i].location" /></td>
                  <td><input class="input cell" v-model="newRow[i].diff_reason" :placeholder="overOf(i) ? '超收必填' : ''" /></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="newForm.po_id" class="empty-cell">这张采购单没有可收的明细（已全部收齐或已取消）</div>
        </div>
        <div class="modal-foot">
          <span class="muted" style="margin-right: auto; font-size: 12px">点收后全部进「待检」，检验合格才进可用库存</span>
          <button class="btn btn-ghost" @click="newOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="busy || !newForm.po_id" @click="createGrn">确认点收</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const stat = ref({});
const rows = ref([]);
const q = ref('');
const status = ref('');
const cur = ref(null);
const busy = ref(false);

const newOpen = ref(false);
const poList = ref([]);
const poItems = ref([]);
const newRow = ref([]);
const newForm = ref({ po_id: 0, receive_date: new Date().toISOString().slice(0, 10), warehouse: '原料库' });

const ins = ref({});

const statusTag = (s) => ({ pending: 'orange', inspecting: 'blue', partial: 'purple', passed: 'green', rejected: 'red', cancelled: 'gray' }[s] || 'gray');
const lineTag = (s) => ({ pending: 'orange', passed: 'green', partial: 'purple', frozen: 'blue', rejected: 'red' }[s] || 'gray');

const inspectable = computed(() => (cur.value ? cur.value.items.filter((x) => x.pending_qty > 0) : []));

function overOf(i) {
  const it = poItems.value[i];
  if (!it) return false;
  const r = Number(newRow.value[i] && newRow.value[i].receive_qty) || 0;
  return r - Number(it.expect_qty) > 0.005;
}

async function loadBoard() {
  try {
    const d = await api.receiptBoard({ q: q.value, status: status.value });
    stat.value = d.stat || {};
    rows.value = d.rows || [];
  } catch (e) { alert(e.message); }
}

function buildIns(d) {
  const map = {};
  (d.items || []).filter((x) => x.pending_qty > 0).forEach((x) => {
    map[x.id] = { pass_qty: x.pending_qty, freeze_qty: 0, reject_qty: 0, note: '' };
  });
  ins.value = map;
}

async function openDetail(r) {
  try {
    const d = await api.receipt(r.id);
    cur.value = d;
    buildIns(d);
  } catch (e) { alert(e.message); }
}

async function refresh() {
  if (!cur.value) return;
  const d = await api.receipt(cur.value.id);
  cur.value = d;
  buildIns(d);
  await loadBoard();
}

async function editLoc(it) {
  const roll = prompt('卷号：', it.roll_no || '');
  if (roll === null) return;
  const dye = prompt('缸号（面料必填）：', it.dye_lot || '');
  if (dye === null) return;
  const loc = prompt('原料库位：', it.location || '');
  if (loc === null) return;
  busy.value = true;
  try {
    const d = await api.updateReceiptItem(cur.value.id, it.id, { roll_no: roll, dye_lot: dye, location: loc });
    cur.value = d;
    buildIns(d);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function submitInspect() {
  const list = inspectable.value.map((it) => ({
    id: it.id,
    pass_qty: Number(ins.value[it.id].pass_qty) || 0,
    freeze_qty: Number(ins.value[it.id].freeze_qty) || 0,
    reject_qty: Number(ins.value[it.id].reject_qty) || 0,
    note: ins.value[it.id].note
  })).filter((x) => x.pass_qty + x.freeze_qty + x.reject_qty > 0);
  if (!list.length) return alert('还没有填检验结果');
  busy.value = true;
  try {
    const before = cur.value.pass_qty;
    const d = await api.inspectReceipt(cur.value.id, list);
    cur.value = d;
    buildIns(d);
    await loadBoard();
    const added = Math.round((d.pass_qty - before) * 100) / 100;
    alert(added > 0 ? `检验已记账：合格 ${added} 已进可用库存` : '检验已记账，本次没有合格量进库存');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function dispose(it) {
  const action = confirm('点「确定」= 复核放行转合格；点「取消」= 转退回') ? 'release' : 'reject';
  const qty = Number(prompt(`处置数量（最多 ${it.freeze_qty}）：`, String(it.freeze_qty)));
  if (!(qty > 0)) return;
  const reason = prompt(action === 'release' ? '放行原因（让步接收 / 客户同意 / 复检合格）：' : '退货原因：');
  if (reason === null) return;
  if (!String(reason).trim()) return alert('处置必须写原因');
  busy.value = true;
  try {
    const d = await api.disposeReceiptItem(cur.value.id, it.id, { action, qty, reason: reason.trim() });
    cur.value = d;
    buildIns(d);
    await loadBoard();
    alert(action === 'release' ? `已放行 ${qty}，进可用库存` : `已转退回 ${qty}，采购行已收数量已回退`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function cancelGrn() {
  const reason = prompt('作废原因：');
  if (reason === null) return;
  if (!confirm('作废会回退采购行已收数量，确认？')) return;
  busy.value = true;
  try {
    const d = await api.cancelReceipt(cur.value.id, reason);
    cur.value = d;
    await loadBoard();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function openNew() {
  newOpen.value = true;
  newForm.value = { po_id: 0, receive_date: new Date().toISOString().slice(0, 10), warehouse: '原料库' };
  poItems.value = [];
  newRow.value = [];
  try {
    const list = await api.purchases({ status: 'ordered' });
    poList.value = list || [];
  } catch (e) { alert(e.message); }
}

async function loadPo() {
  poItems.value = [];
  newRow.value = [];
  if (!newForm.value.po_id) return;
  try {
    const d = await api.receiptPo(newForm.value.po_id);
    poItems.value = (d.items || []).filter((x) => x.expect_qty > 0);
    newRow.value = poItems.value.map((x) => ({
      receive_qty: x.expect_qty, roll_no: '', dye_lot: '', location: '', diff_reason: ''
    }));
  } catch (e) { alert(e.message); }
}

async function createGrn() {
  const items = poItems.value.map((it, i) => ({
    po_item_id: it.po_item_id,
    expect_qty: it.expect_qty,
    receive_qty: Number(newRow.value[i].receive_qty) || 0,
    roll_no: newRow.value[i].roll_no,
    dye_lot: newRow.value[i].dye_lot,
    location: newRow.value[i].location,
    diff_reason: newRow.value[i].diff_reason
  })).filter((x) => x.receive_qty > 0);
  if (!items.length) return alert('至少一行实收大于 0');
  busy.value = true;
  try {
    const d = await api.createReceipt({ ...newForm.value, items });
    newOpen.value = false;
    cur.value = d;
    buildIns(d);
    await loadBoard();
    const w = (d.warnings || []).slice();
    alert(`已开收料单 ${d.grn_no}，${d.receive_qty} 进待检` + (w.length ? '\n\n' + w.join('\n') : ''));
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(loadBoard);
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 19px; color: #16233b; }
.page-head .sub { margin: 0; font-size: 12.5px; color: #8a94a6; max-width: 880px; line-height: 1.65; }
.head-ops { display: flex; gap: 8px; }
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 14px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 21px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.amt-blue { color: #2b6de5 !important; }
.row-warn { background: #fffdf5; }
.row-red { background: #fff7f8; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.center { text-align: center; }
.ops { white-space: nowrap; }
.muted { color: #8a94a6; }
.sub-cell { font-size: 12px; color: #5b6474; }
.empty-cell { text-align: center; color: #8a94a6; padding: 16px; }
.table-wrap { overflow-x: auto; }
table.data th, table.data td { white-space: nowrap; }

.modal.xwide.grn-modal { width: 1400px; max-width: 98vw; }
.modal.xwide.new-modal { width: 1240px; max-width: 97vw; }
.grn-modal .modal-body { max-height: 74vh; }
.grn-sum { display: grid; grid-template-columns: repeat(8, 1fr); gap: 10px; background: #f8fafd; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; }
.grn-sum span { display: block; font-size: 11.5px; color: #8a94a6; }
.grn-sum b { font-size: 14px; color: #16233b; font-variant-numeric: tabular-nums; }
.grn-warn { margin-top: 10px; padding: 8px 12px; background: #fff8f9; border: 1px solid #f8d3d8; border-radius: 8px; font-size: 12.5px; color: #b91c1c; line-height: 1.6; }
.grn-warn.warn-amber { background: #fffdf5; border-color: #f6e3b6; color: #a16207; }
.grn-sec { margin-top: 16px; }
.grn-sec-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.grn-sec h4 { margin: 0; font-size: 13px; color: #16233b; }
.grn-tbl { min-width: 1220px; }
.ins-tbl { min-width: 760px; }
.new-tbl { min-width: 900px; }
.input.cell { padding: 3px 6px; font-size: 12px; height: 26px; width: 100%; min-width: 56px; }
.input.cell.num { text-align: right; }
.diff-lab { font-size: 10.5px; margin-left: 3px; }
.inspect-box { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; background: #fbfcfe; }
.form-row { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; }
.form-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5b6474; }
.act-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.act-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #33415a; }
@media (max-width: 1200px) {
  .stat-row { grid-template-columns: repeat(3, 1fr); }
  .grn-sum { grid-template-columns: repeat(4, 1fr); }
}
</style>
