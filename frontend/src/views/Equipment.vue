<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>设备停机与产能</h2>
        <p class="sub">
          停机登记 → 维修 → <b>安全复核</b> → 产能恢复。只做设备日历、停机报修与受影响排程，不建 IoT 采集平台。
          <b>维修占用期间不承诺产能</b>；安全放行必须指定责任人人工确认，系统不自动放行。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openDowntime()">＋ 登记停机</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>设备</span><strong>{{ board.stat.equipment || 0 }}</strong><small>{{ board.stat.work_centers || 0 }} 个工作中心</small></div>
      <div class="stat"><span>运行中</span><strong class="amt-green">{{ board.stat.running || 0 }}</strong><small>可承诺产能</small></div>
      <div class="stat"><span>停机 / 保养</span><strong :class="board.stat.down ? 'amt-red' : ''">{{ board.stat.down || 0 }}</strong><small>不承诺产能</small></div>
      <div class="stat"><span>未结停机单</span><strong :class="board.stat.open_downtimes ? 'amt-orange' : ''">{{ board.stat.open_downtimes || 0 }}</strong><small>含计划保养</small></div>
      <div class="stat"><span>待安全复核</span><strong :class="board.stat.pending_safety ? 'amt-orange' : ''">{{ board.stat.pending_safety || 0 }}</strong><small>修完等放行</small></div>
      <div class="stat"><span>在停产能损失</span><strong :class="board.stat.loss_open ? 'amt-red' : ''">{{ fmt(board.stat.loss_open) }}</strong><small>件（未恢复）</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'eq' }" @click="tab = 'eq'">设备台账</button>
        <button :class="{ on: tab === 'dt' }" @click="tab = 'dt'">停机与维修</button>
        <button :class="{ on: tab === 'cap' }" @click="tab = 'cap'; loadCapacity()">产能日历</button>
      </div>
      <select class="select" v-model="wc" style="width: 150px" @change="reload">
        <option value="">全部工作中心</option>
        <option v-for="w in board.work_centers" :key="w" :value="w">{{ w }}</option>
      </select>
      <input v-model="q" class="input" placeholder="设备 / 单号 / 原因" style="width: 200px" @keyup.enter="reload" />
      <button class="btn btn-ghost" @click="reload">查询</button>
    </div>

    <!-- ============ 设备台账 ============ -->
    <div v-if="tab === 'eq'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 90px">编号</th><th>设备</th><th style="width: 80px">类型</th>
            <th style="width: 120px">工作中心</th><th style="width: 110px" class="num">台时产能</th>
            <th style="width: 100px">状态</th><th style="width: 100px">责任人</th>
            <th style="width: 110px">下次保养</th><th style="width: 220px">当前停机</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in board.equipment" :key="e.id" :class="{ 'row-down': e.status !== 'running' }">
            <td class="mono">{{ e.eq_no }}</td>
            <td>{{ e.name }}<div class="tiny">{{ e.location || '' }}</div></td>
            <td>{{ e.type_label }}</td>
            <td>{{ e.work_center }}</td>
            <td class="num">{{ fmt(e.capacity_per_hour) }} 件/时</td>
            <td><span class="tag" :class="e.status === 'running' ? 'green' : e.status === 'stopped' ? 'red' : 'orange'">{{ e.status_label }}</span></td>
            <td>{{ e.owner || '-' }}</td>
            <td :class="dueSoon(e.next_maintain_at) ? 'warn' : ''">{{ e.next_maintain_at || '-' }}</td>
            <td class="tiny">
              <template v-if="e.open_downtime">
                <span class="tag" :class="dtTag(e.open_downtime.status)">{{ e.open_downtime.status_label }}</span>
                {{ e.open_downtime.dt_no }} · {{ e.open_downtime.reason }}
              </template>
              <span v-else class="muted">正常</span>
            </td>
          </tr>
          <tr v-if="!board.equipment.length"><td colspan="9" class="empty-cell">还没有设备，先建设备台账</td></tr>
        </tbody>
      </table>
      <p class="rule-note">台时产能（件/小时）是算停机损失的基数；停机的设备不计入可承诺产能。</p>
    </div>

    <!-- ============ 停机与维修 ============ -->
    <div v-if="tab === 'dt'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 140px">维修单</th><th style="width: 160px">设备</th><th style="width: 110px">工作中心</th>
            <th style="width: 90px">类型</th><th style="width: 150px">停机时段</th>
            <th style="width: 90px" class="num">占用工时</th><th style="width: 90px" class="num">产能损失</th>
            <th>原因 / 维修</th><th style="width: 110px">状态</th><th style="width: 190px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in dtRows" :key="r.id">
            <td class="mono">{{ r.dt_no }}</td>
            <td>{{ r.eq_name }}<div class="tiny mono">{{ r.eq_no }}</div></td>
            <td>{{ r.work_center }}</td>
            <td><span class="tag" :class="r.type === 'breakdown' ? 'red' : 'blue'">{{ r.type_label }}</span></td>
            <td class="tiny">{{ $fmt(r.start_at) }}<br />→ {{ r.end_at ? $fmt(r.end_at) : '未恢复' }}</td>
            <td class="num">{{ fmt(r.occupied_hours) }}</td>
            <td class="num">{{ fmt(r.capacity_loss) }}<div class="tiny">件</div></td>
            <td class="wrap tiny">
              {{ r.reason }}
              <div v-if="r.repair_note" style="margin-top: 2px">维修：{{ r.repair_note }}</div>
              <div v-if="r.safety_note" style="margin-top: 2px">放行：{{ r.safety_by }} · {{ r.safety_note }}</div>
              <div v-if="r.affected_orders && r.affected_orders.length" style="margin-top: 2px">
                影响：<span v-for="o in r.affected_orders" :key="o.order_id" class="pill">{{ o.order_no }}</span>
              </div>
            </td>
            <td><span class="tag" :class="dtTag(r.status)">{{ r.status_label }}</span></td>
            <td class="ops">
              <button v-if="canWrite && ['planned','pending_repair'].includes(r.status)" class="link-btn" @click="doStartRepair(r)">
                {{ r.status === 'planned' ? '开始保养' : '开始维修' }}
              </button>
              <button v-if="canWrite && r.status === 'repairing'" class="link-btn" @click="finishRepair(r)">结束维修</button>
              <button v-if="canWrite && r.status === 'pending_safety'" class="link-btn" @click="openSafety(r)">安全放行</button>
              <button v-if="canWrite && r.status !== 'recovered' && r.status !== 'cancelled'" class="link-btn danger" @click="cancelDt(r)">作废</button>
              <span v-if="r.status === 'recovered'" class="tiny">{{ r.safety_by }}</span>
            </td>
          </tr>
          <tr v-if="!dtRows.length"><td colspan="10" class="empty-cell">没有停机记录</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        不能跳过安全复核直接恢复产能；放行人须为设备责任人 / 生产主管，登记人本人不能自己放行（admin 除外）。
      </p>
    </div>

    <!-- ============ 产能日历 ============ -->
    <div v-if="tab === 'cap'">
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" type="date" v-model="capDate" style="width: 160px" @change="loadCapacity" />
        <button class="btn btn-ghost btn-sm" @click="loadCapacity">查看当天</button>
        <span class="tiny">{{ cap.date }} · 基准台时 {{ fmt(cap.base_hours) }}h · 停机占用 {{ fmt(cap.downtime_hours) }}h · 可用 {{ fmt(cap.available_hours) }}h · 损失 {{ fmt(cap.loss_qty) }} 件</span>
      </div>

      <div v-if="capBoard.rows && capBoard.rows.length" class="table-wrap" style="margin-bottom: 14px">
        <table class="data">
          <thead>
            <tr><th>工作中心</th><th class="num" style="width: 90px">设备</th><th class="num" style="width: 100px">基准台时</th>
              <th class="num" style="width: 100px">停机占用</th><th class="num" style="width: 100px">可用台时</th>
              <th class="num" style="width: 100px">可用产能</th><th class="num" style="width: 100px">产能损失</th><th style="width: 120px">利用率</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in capBoard.rows" :key="r.work_center">
              <td><b>{{ r.work_center }}</b></td>
              <td class="num">{{ r.equipment_count }}</td>
              <td class="num">{{ fmt(r.base_hours) }}</td>
              <td class="num" :class="r.downtime_hours ? 'warn' : 'muted'">{{ fmt(r.downtime_hours) }}</td>
              <td class="num">{{ fmt(r.available_hours) }}</td>
              <td class="num">{{ fmt(r.available_qty) }}</td>
              <td class="num" :class="r.loss_qty ? 'warn' : 'muted'">{{ fmt(r.loss_qty) }}</td>
              <td>
                <div class="bar"><i :style="{ width: (r.utilization || 0) + '%' }" :class="{ low: (r.utilization || 100) < 90 }"></i></div>
                <span class="tiny">{{ r.utilization === null ? '-' : r.utilization + '%' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cap-box">
        <div class="cap-title">
          {{ cap.work_center }} · {{ cap.date }}
          <span class="tag" :class="cap.downtime_hours ? 'orange' : 'green'">{{ cap.downtime_hours ? '有停机占用' : '可满产能' }}</span>
        </div>
        <p class="tiny" style="margin: 4px 0 8px">{{ cap.promise_note }}</p>
        <div class="cap-grid">
          <div><span>基准台时</span><b>{{ fmt(cap.base_hours) }} h</b></div>
          <div><span>停机占用</span><b :class="cap.downtime_hours ? 'amt-red' : ''">{{ fmt(cap.downtime_hours) }} h</b></div>
          <div><span>可用台时</span><b class="amt-green">{{ fmt(cap.available_hours) }} h</b></div>
          <div><span>基准产能</span><b>{{ fmt(cap.base_qty) }} 件</b></div>
          <div><span>可用产能</span><b>{{ fmt(cap.available_qty) }} 件</b></div>
          <div><span>产能损失</span><b :class="cap.loss_qty ? 'amt-red' : ''">{{ fmt(cap.loss_qty) }} 件</b></div>
        </div>

        <div v-if="cap.detail && cap.detail.length" style="margin-top: 12px">
          <div class="sec-title">当天停机明细</div>
          <div v-for="(d, i) in cap.detail" :key="i" class="mini-row">
            <span class="mono">{{ d.dt_no }}</span>
            <span>{{ d.equipment }}</span>
            <span class="tiny">{{ d.from }} → {{ d.to }}</span>
            <span class="pill">{{ d.hours }} h</span>
            <span class="pill price">损失 {{ d.qty }} 件</span>
            <span class="tag gray">{{ d.status }}</span>
          </div>
        </div>

        <div v-if="cap.risk_orders && cap.risk_orders.length" style="margin-top: 12px">
          <div class="sec-title">受影响订单（交期要重新确认）</div>
          <div v-for="o in cap.risk_orders" :key="o.id" class="mini-row">
            <span class="mono">{{ o.order_no }}</span>
            <span>{{ o.style_name }}</span>
            <span class="tiny">交期 {{ o.delivery_date || '未定' }}</span>
            <span class="tag gray">{{ o.status }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 登记停机 ============ -->
    <div v-if="dtForm" class="modal-mask" @click.self="dtForm = null">
      <div class="modal">
        <div class="modal-head"><h3>登记停机 / 保养</h3><button class="x" @click="dtForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>设备 *</label>
              <select class="select" v-model.number="dtForm.equipment_id">
                <option :value="null">— 选择设备 —</option>
                <option v-for="e in board.equipment" :key="e.id" :value="e.id" :disabled="!!e.open_downtime">
                  {{ e.eq_no }} · {{ e.name }}（{{ e.work_center }}{{ e.open_downtime ? ' · 已有未结单' : '' }}）
                </option>
              </select>
            </div>
            <div class="fitem">
              <label>类型 *</label>
              <select class="select" v-model="dtForm.type">
                <option value="breakdown">故障停机</option>
                <option value="maintenance">计划保养</option>
                <option value="changeover">换款调试</option>
                <option value="power">停电 / 外部</option>
              </select>
            </div>
            <div class="fitem"><label>停机开始 *</label><input class="input" type="datetime-local" v-model="dtForm.start_at" /></div>
            <div class="fitem full"><label>原因 *</label><input class="input" v-model="dtForm.reason" placeholder="主轴异响、针距不稳" /></div>
            <div class="fitem full"><label>维修任务</label><input class="input" v-model="dtForm.repair_task" placeholder="更换主轴轴承、重新校针距" /></div>
          </div>

          <div class="sec-title" style="margin-top: 12px">受影响排程（登记了就会在产能页提示交期风险）</div>
          <div class="pick-row">
            <select class="select" v-model.number="pick.order_id" style="flex: 1">
              <option :value="null">— 选择订单 —</option>
              <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '' }}</option>
            </select>
            <input class="input" v-model="pick.note" placeholder="影响说明（延误 1 天）" style="flex: 1.4" />
            <button class="btn btn-ghost btn-sm" @click="addPick">加入</button>
          </div>
          <div v-if="dtForm.affected_orders.length" style="margin-top: 8px">
            <div v-for="(o, i) in dtForm.affected_orders" :key="i" class="mini-row">
              <span class="mono">{{ o.order_no }}</span>
              <span class="tiny">{{ o.note || '' }}</span>
              <button class="link-btn danger" @click="dtForm.affected_orders.splice(i, 1)">移除</button>
            </div>
          </div>

          <p class="tiny" style="margin-top: 10px">登记后设备立即置为停机/保养，<b>不再计入可承诺产能</b>；恢复要经安全复核。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="dtForm = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="saveDowntime">登记</button>
        </div>
      </div>
    </div>

    <!-- ============ 安全放行 ============ -->
    <div v-if="safety" class="modal-mask" @click.self="safety = null">
      <div class="modal">
        <div class="modal-head"><h3>安全复核放行 · {{ safety.dt_no }}</h3><button class="x" @click="safety = null">×</button></div>
        <div class="modal-body">
          <div class="tiny" style="margin-bottom: 10px">
            设备 {{ safety.eq_name }}（{{ safety.work_center }}）· 停机 {{ safety.occupied_hours }} 小时 · 维修：{{ safety.repair_note }}
          </div>
          <div class="form-grid">
            <div class="fitem"><label>安全放行责任人 *</label><input class="input" v-model="safety._by" placeholder="张组长 / 设备责任人" /></div>
            <div class="fitem"><label>恢复时间 *</label><input class="input" type="datetime-local" v-model="safety._end" /></div>
            <div class="fitem full"><label>安全复核依据 *</label><textarea v-model="safety._note" rows="2" placeholder="试机正常、防护罩复位、试缝 3 件合格"></textarea></div>
          </div>
          <p class="tiny" style="margin-top: 8px">放行后产能立即可用；系统不自动放行，必须人工确认。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="safety = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doSafety">确认放行</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('eq');
const wc = ref('');
const q = ref('');
const board = reactive({ equipment: [], open_downtimes: [], work_centers: [], stat: {} });
const dtRows = ref([]);
const dtStat = ref({});
const orders = ref([]);
const cap = reactive({});
const capBoard = reactive({ rows: [] });
const capDate = ref(new Date().toISOString().slice(0, 10));
const busy = ref(false);
const formMsg = ref('');

const dtForm = ref(null);
const safety = ref(null);
const pick = reactive({ order_id: null, note: '' });

const canWrite = computed(() => can('equipment.write'));
const fmt = (v) => (v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
function dtTag(s) {
  return { planned: 'blue', pending_repair: 'orange', repairing: 'orange', pending_safety: 'orange', recovered: 'green', cancelled: 'gray' }[s] || 'gray';
}
function dueSoon(d) {
  if (!d) return false;
  const diff = (Date.parse(d) - Date.now()) / 86400000;
  return diff <= 7;
}

async function loadBoard() {
  try {
    const d = await api.equipmentBoard({ work_center: wc.value, q: q.value });
    board.equipment = d.equipment;
    board.open_downtimes = d.open_downtimes;
    board.work_centers = d.work_centers;
    board.stat = d.stat;
  } catch (e) { alert(e.message); }
}
async function loadDowntimes() {
  try {
    const d = await api.downtimes({ work_center: wc.value, q: q.value });
    dtRows.value = d.rows;
    dtStat.value = d.stat;
  } catch (e) { alert(e.message); }
}
async function loadCapacity() {
  try {
    const d = await api.equipmentCapacity({ work_center: wc.value, date: capDate.value });
    Object.assign(cap, d);
    const b = await api.equipmentCapacityBoard({ date: capDate.value });
    capBoard.rows = b.rows;
  } catch (e) { alert(e.message); }
}
async function loadOrders() {
  try {
    const d = await api.orders();
    orders.value = (Array.isArray(d) ? d : d.rows || []).filter((o) => !['closed', 'cancelled'].includes(o.status));
  } catch (e) { orders.value = []; }
}
function reload() {
  loadBoard();
  if (tab.value === 'dt') loadDowntimes();
  if (tab.value === 'cap') loadCapacity();
}

function openDowntime() {
  formMsg.value = '';
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  dtForm.value = { equipment_id: null, type: 'breakdown', start_at: nowLocal, reason: '', repair_task: '', affected_orders: [] };
  pick.order_id = null;
  pick.note = '';
}
function addPick() {
  if (!pick.order_id) return alert('请选择订单');
  const o = orders.value.find((x) => x.id === pick.order_id);
  if (!o) return;
  if (dtForm.value.affected_orders.some((x) => x.order_id === o.id)) return alert('这个订单已经加过了');
  dtForm.value.affected_orders.push({ order_id: o.id, order_no: o.order_no, note: pick.note || null });
  pick.order_id = null;
  pick.note = '';
}
async function saveDowntime() {
  formMsg.value = '';
  if (!dtForm.value.equipment_id) return (formMsg.value = '请选择设备');
  if (!String(dtForm.value.reason || '').trim()) return (formMsg.value = '请写停机原因');
  busy.value = true;
  try {
    const r = await api.createDowntime({ ...dtForm.value });
    dtForm.value = null;
    await loadBoard();
    if (tab.value === 'dt') await loadDowntimes();
    alert(`已登记 ${r.dt_no}（${r.status_label}）。设备已从可承诺产能里扣除`);
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

async function doStartRepair(r) {
  try { await api.startRepair(r.id); await loadBoard(); await loadDowntimes(); } catch (e) { alert(e.message); }
}
async function finishRepair(r) {
  const note = prompt(`结束维修 ${r.dt_no}：换/修了什么？`);
  if (note === null) return;
  if (!String(note).trim()) return alert('必须写维修内容');
  try {
    const res = await api.finishRepair(r.id, { repair_note: note.trim() });
    await loadBoard(); await loadDowntimes();
    alert(res.notice || '维修完成，等安全复核');
  } catch (e) { alert(e.message); }
}
function openSafety(r) {
  formMsg.value = '';
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  safety.value = { ...r, _by: '', _end: nowLocal, _note: '' };
}
async function doSafety() {
  formMsg.value = '';
  if (!String(safety.value._by || '').trim()) return (formMsg.value = '请填安全放行责任人');
  if (!String(safety.value._note || '').trim()) return (formMsg.value = '请写安全复核依据');
  busy.value = true;
  try {
    const res = await api.safetyRelease(safety.value.id, {
      safety_by: safety.value._by, safety_note: safety.value._note, end_at: safety.value._end
    });
    safety.value = null;
    await loadBoard(); await loadDowntimes();
    if (tab.value === 'cap') await loadCapacity();
    alert(res.notice || '已安全放行');
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}
async function cancelDt(r) {
  const reason = prompt(`作废 ${r.dt_no} 的原因（误报 / 重复登记）：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('必须写原因');
  try {
    await api.cancelDowntime(r.id, { reason: reason.trim() });
    await loadBoard(); await loadDowntimes();
  } catch (e) { alert(e.message); }
}

onMounted(() => {
  loadBoard();
  loadDowntimes();
  loadOrders();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
.tiny { font-size: 11.5px; color: #8a94a6; line-height: 1.5; }
.warn { color: #d92d45; }
.muted { color: #b6bfcc; }
.ops { white-space: nowrap; }
.wrap { white-space: normal !important; line-height: 1.55; }
.num { text-align: right; }
.row-down { background: #fffaf2; }
:deep(.tag) { white-space: nowrap; }
.rule-note { margin: 10px 0 0; font-size: 11.5px; color: #8a94a6; line-height: 1.6; }
.pill { display: inline-block; background: #f2f5fa; color: #5b6474; border-radius: 10px; padding: 1px 8px; font-size: 11.5px; margin: 2px 4px 0 0; }
.pill.price { background: #fff7e8; color: #a4670a; }
.cap-box { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 14px 16px; }
.cap-title { font-size: 13px; font-weight: 700; color: #16233b; display: flex; align-items: center; gap: 8px; }
.cap-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.cap-grid > div { background: #f8fafc; border: 1px solid #e8edf4; border-radius: 10px; padding: 9px 11px; }
.cap-grid span { display: block; font-size: 11.5px; color: #7c8798; }
.cap-grid b { font-size: 16px; color: #16233b; }
.sec-title { font-size: 12.5px; font-weight: 700; color: #16233b; margin: 6px 0 6px; }
.mini-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed #eef2f7; }
.bar { height: 6px; background: #eef2f7; border-radius: 4px; overflow: hidden; margin-bottom: 3px; }
.bar i { display: block; height: 100%; background: #22c55e; }
.bar i.low { background: #f59e0b; }
.pick-row { display: flex; gap: 8px; align-items: center; }
@media (max-width: 1280px) { .stat-row { grid-template-columns: repeat(3, 1fr); } .cap-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .cap-grid { grid-template-columns: repeat(2, 1fr); } .pick-row { flex-wrap: wrap; } }
</style>
