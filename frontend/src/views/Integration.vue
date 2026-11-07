<template>
  <div>
    <div class="page-head">
      <div>
        <h2>外部接口</h2>
        <div class="sub">接入点与密钥 · 事件队列与失败补偿 · 物流人工校正 · 调用日志与 OpenAPI</div>
      </div>
      <div class="toolbar" style="margin: 0">
        <button v-if="canWrite" class="btn btn-primary" @click="doDispatch">处理待办事件</button>
        <button class="btn btn-ghost" @click="loadAll">刷新</button>
      </div>
    </div>

    <div v-if="s.warnings && s.warnings.length" class="alert-bar">
      <div v-for="(w, i) in s.warnings" :key="i" style="margin: 2px 0">⚠️ {{ w }}</div>
    </div>

    <div class="cards">
      <div class="stat-card">
        <div class="label">接入点</div>
        <div class="value">{{ (s.endpoints && s.endpoints.active) || 0 }}<small>/ {{ (s.endpoints && s.endpoints.total) || 0 }}</small></div>
        <div class="delta">启用 / 全部</div>
      </div>
      <div class="stat-card" :class="(s.events && (s.events.dead + s.events.failed)) ? 'accent' : ''">
        <div class="label">待处理事件</div>
        <div class="value">{{ (s.events && s.events.pending) || 0 }}<small>条</small></div>
        <div class="delta">待重试 {{ (s.events && s.events.failed) || 0 }} · 死信 {{ (s.events && s.events.dead) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">累计成功</div>
        <div class="value">{{ (s.events && s.events.success) || 0 }}<small>条</small></div>
        <div class="delta">共 {{ (s.events && s.events.total) || 0 }} 条事件</div>
      </div>
      <div class="stat-card" :class="(s.calls_24h && s.calls_24h.errors) ? 'accent' : ''">
        <div class="label">24h 接口调用</div>
        <div class="value">{{ (s.calls_24h && s.calls_24h.total) || 0 }}<small>次</small></div>
        <div class="delta">失败/受阻 {{ (s.calls_24h && s.calls_24h.errors) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">物流校正待批</div>
        <div class="value">{{ s.correct_pending || 0 }}<small>条</small></div>
        <div class="delta">人工校正需他人复核</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <!-- ==================== 接入点 ==================== -->
    <template v-if="tab === 'endpoints'">
      <div class="toolbar" style="margin-bottom: 12px">
        <button  v-if="canWrite" class="btn btn-primary" @click="openEndpoint()">＋ 新增接入点</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        每个接入点独立 API Key 与限流；外部调用 <code>POST /api/integration/ingest/&lt;code&gt;</code> 时必须带
        <code>X-Api-Key</code> 与 <code>event_id</code>（幂等键），否则会被拒。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>编码</th><th>名称</th><th>类型</th><th>关联店铺</th><th>API Key</th><th>限流</th><th>24h 调用</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in endpoints" :key="r.id">
              <td class="nowrap"><strong>{{ r.code }}</strong><div class="muted" style="font-size: 12px">{{ r.base_url || '-' }}</div></td>
              <td class="nowrap">{{ r.name }}</td>
              <td class="nowrap">{{ r.type_label }}</td>
              <td class="nowrap">{{ r.shop_name || '-' }}</td>
              <td class="nowrap muted" style="font-family: monospace">{{ r.api_key_masked }}</td>
              <td class="nowrap">{{ r.rate_limit_per_min }} 次/分</td>
              <td class="num">{{ r.calls_24h }}<span v-if="r.errors_24h" class="muted"> / 失败 {{ r.errors_24h }}</span></td>
              <td class="nowrap"><span class="tag" :class="r.status === 'active' ? 'green' : 'gray'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-action="['integration','edit']"  class="link-btn" @click="openEndpoint(r)">编辑</button>
                <button class="link-btn" @click="doRotate(r)">重置密钥</button>
              </td>
            </tr>
            <tr v-if="!endpoints.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无接入点</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="epModal" class="modal-mask">
        <div class="modal wide">
          <div class="modal-head"><h3>{{ epForm.id ? '编辑接入点' : '新增接入点' }}</h3><button class="link-btn" @click="epModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>编码 *</label><input class="input" v-model="epForm.code" :disabled="!!epForm.id" placeholder="amz-live（小写字母数字横线）" /></div>
              <div class="fitem"><label>名称 *</label><input class="input" v-model="epForm.name" /></div>
              <div class="fitem"><label>类型</label>
                <select class="select" v-model="epForm.type">
                  <option value="shop">电商店铺</option><option value="logistics">物流商</option>
                  <option value="payment">支付</option><option value="other">其他</option>
                </select>
              </div>
              <div class="fitem"><label>关联零售店铺（电商类）</label>
                <select class="select" v-model.number="epForm.shop_id">
                  <option :value="null">— 不关联 —</option>
                  <option v-for="x in shops" :key="x.id" :value="x.id">{{ x.shop_name }}</option>
                </select>
              </div>
              <div class="fitem"><label>接口地址</label><input class="input" v-model="epForm.base_url" /></div>
              <div class="fitem"><label>限流（次/分钟）</label><input class="input" type="number" v-model.number="epForm.rate_limit_per_min" /></div>
              <div class="fitem"><label>状态</label>
                <select class="select" v-model="epForm.status"><option value="active">启用</option><option value="disabled">停用</option></select>
              </div>
              <div class="fitem"><label>备注</label><input class="input" v-model="epForm.remark" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">新建后会自动生成 API Key，<strong>只在创建时显示一次</strong>，之后只显示掩码。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="epModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveEndpoint">保存</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 事件队列 ==================== -->
    <template v-if="tab === 'events'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="evStatus" @change="loadEvents">
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="failed">待重试</option>
          <option value="dead">死信</option>
          <option value="success">已成功</option>
        </select>
        <select class="select" v-model="evTopic" @change="loadEvents">
          <option value="">全部主题</option>
          <option value="retail.order">零售订单</option>
          <option value="shipment.event">物流事件</option>
          <option value="notification">站内通知</option>
        </select>
        <button class="btn btn-ghost" @click="loadEvents">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="doDispatch">立即处理</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        每条事件都有唯一 <strong>event_id 幂等键</strong>，重复推送只处理一次；失败按指数退避重试，超过 5 次进<strong>死信</strong>，可人工重放或放弃。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>事件</th><th>方向 / 接入点</th><th>主题</th><th>状态</th><th>尝试</th><th>下次重试</th><th>结果 / 错误</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in events" :key="r.id">
              <td class="nowrap"><strong style="font-family: monospace; font-size: 12px">{{ r.event_id }}</strong>
                <div class="muted" style="font-size: 12px">{{ $fmt(r.created_at) }}</div>
              </td>
              <td class="nowrap">{{ r.direction === 'in' ? '接收' : '发出' }}
                <div class="muted" style="font-size: 12px">{{ r.endpoint_name || r.endpoint_code || '-' }}</div>
              </td>
              <td class="nowrap">{{ r.topic_label }}</td>
              <td class="nowrap"><span class="tag" :class="evTag(r.status)">{{ r.status_label }}</span></td>
              <td class="num">{{ r.attempts }}/{{ r.max_attempts }}</td>
              <td class="nowrap muted">{{ r.next_retry_at ? $fmt(r.next_retry_at) : '-' }}</td>
              <td style="max-width: 320px; white-space: normal">
                <span v-if="r.result_ref" class="tag green">{{ r.result_ref }}</span>
                <span v-if="r.last_error" class="muted" style="font-size: 12px">{{ r.last_error }}</span>
              </td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="['failed','dead','pending'].includes(r.status)" class="link-btn" @click="doRetry(r)">重放</button>
                <button v-if="r.status !== 'dead' && r.status !== 'success'" class="link-btn danger" @click="doDrop(r)">放弃</button>
              </td>
            </tr>
            <tr v-if="!events.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无事件</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ==================== 物流校正 ==================== -->
    <template v-if="tab === 'shipments'">
      <div class="muted" style="font-size: 12.5px; margin: 0 0 12px">
        接口回传或人工登记的物流事件都可能出错。校正<strong>必须填理由</strong>，提交后只登记「待批准」，<strong>由他人复核批准才生效</strong>，并保留旧值、通知客户。无接口时人工登记会标明来源，不冒充实时定位。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>时间</th><th>订单</th><th>承运 / 单号</th><th>状态</th><th>地点</th><th>来源</th><th>校正</th><th v-if="canWrite">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in shipments" :key="r.id">
              <td class="nowrap">{{ $fmt(r.event_time || r.created_at) }}</td>
              <td class="nowrap">{{ r.order_no }}</td>
              <td class="nowrap">{{ r.carrier || '-' }}<div class="muted" style="font-size: 12px">{{ r.tracking_no || '' }}</div></td>
              <td style="max-width: 220px; white-space: normal">
                {{ r.status_text }}
                <div v-if="r.pending_correction" class="muted" style="font-size: 11.5px; color: #b07b12">
                  待批：{{ r.pending_correction.status_text || r.status_text }} / {{ r.pending_correction.location || r.location || '-' }}
                </div>
              </td>
              <td class="nowrap">{{ r.location || '-' }}</td>
              <td class="nowrap"><span class="tag" :class="r.source === 'api' ? 'blue' : 'gray'">{{ r.source_label }}</span></td>
              <td class="nowrap">
                <span v-if="r.corrected" class="tag orange">已校正</span>
                <span v-else-if="r.pending_correction" class="tag orange">待批准</span>
                <span v-else class="muted">-</span>
                <div v-if="r.correct_reason" class="muted" style="font-size: 11.5px; max-width: 200px; white-space: normal">{{ r.correct_reason }}</div>
              </td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="!r.pending_correction" class="link-btn" @click="openCorrect(r)">校正</button>
                <button v-if="r.pending_correction" class="link-btn" @click="doApproveCorrect(r)">批准</button>
                <button v-action="['integration','reject']" v-if="r.pending_correction" class="link-btn danger" @click="doRejectCorrect(r)">驳回</button>
              </td>
            </tr>
            <tr v-if="!shipments.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无物流事件</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="corModal" class="modal-mask">
        <div class="modal">
          <div class="modal-head"><h3>人工校正物流事件</h3><button class="link-btn" @click="corModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>当前状态</label><input class="input" :value="corForm.old_status" disabled /></div>
              <div class="fitem"><label>当前地点</label><input class="input" :value="corForm.old_location || '-'" disabled /></div>
              <div class="fitem"><label>更正后状态 *</label><input class="input" v-model="corForm.status_text" /></div>
              <div class="fitem"><label>更正后地点</label><input class="input" v-model="corForm.location" /></div>
              <div class="fitem full"><label>校正理由 *（必填，批准后留档）</label>
                <input class="input" v-model="corForm.reason" placeholder="如 承运商回传状态有误，人工核实后更正" />
              </div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">提交后进入「待批准」，需他人复核；批准时保留旧值并给客户推送物流更新通知。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="corModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveCorrect">提交校正</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 调用日志 / 交付 ==================== -->
    <template v-if="tab === 'logs'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="logEndpoint" @change="loadCalls">
          <option value="">全部接入点</option>
          <option v-for="r in endpoints" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <label class="muted" style="display: flex; align-items: center; gap: 6px; font-size: 13px">
          <input type="checkbox" v-model="logOnlyError" @change="loadCalls" /> 只看失败
        </label>
        <button class="btn btn-ghost" @click="loadCalls">查询</button>
        <button class="btn btn-ghost" @click="doOpenapi">查看 OpenAPI 清单</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>时间</th><th>接入点</th><th>请求</th><th>状态码</th><th>IP</th><th>耗时</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="r in calls" :key="r.id">
              <td class="nowrap">{{ $fmtSec(r.created_at) }}</td>
              <td class="nowrap">{{ r.endpoint_code || '-' }}</td>
              <td class="nowrap muted">{{ r.method }} {{ r.path }}</td>
              <td class="nowrap">
                <span class="tag" :class="r.status_code < 400 ? 'green' : r.status_code === 429 ? 'orange' : 'red'">{{ r.status_code }}</span>
              </td>
              <td class="nowrap muted">{{ r.ip || '-' }}</td>
              <td class="num">{{ r.duration_ms }} ms</td>
              <td style="max-width: 260px; white-space: normal">{{ r.note || '-' }}</td>
            </tr>
            <tr v-if="!calls.length"><td colspan="7" class="empty-cell">暂无调用记录</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="openapiText" style="margin-top: 16px">
        <div style="font-weight: 700; font-size: 13.5px; margin-bottom: 8px">OpenAPI 清单（交付资产）</div>
        <pre class="api-box">{{ openapiText }}</pre>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'endpoints', label: '接入点与密钥' },
  { key: 'events', label: '事件队列' },
  { key: 'shipments', label: '物流校正' },
  { key: 'logs', label: '调用日志 / 交付' }
];

const tab = ref('endpoints');
const canWrite = computed(() => can('integration.write'));
const s = ref({});
const saving = ref(false);
const formMsg = ref('');
const shops = ref([]);

const endpoints = ref([]);
const epModal = ref(false);
const epForm = reactive({});

const events = ref([]);
const evStatus = ref('');
const evTopic = ref('');

const shipments = ref([]);
const corModal = ref(false);
const corForm = reactive({});

const calls = ref([]);
const logEndpoint = ref('');
const logOnlyError = ref(false);
const openapiText = ref('');

function evTag(v) {
  return { pending: 'orange', failed: 'red', dead: 'red', success: 'green', processing: 'blue' }[v] || 'gray';
}

async function loadAll() {
  try { s.value = await api.integrationStats(); } catch (e) { /* ignore */ }
  try { shops.value = await api.channelShops({}); } catch (e) { shops.value = []; }
  await Promise.all([loadEndpoints(), loadEvents(), loadShipments(), loadCalls()]);
}

async function loadEndpoints() {
  try { endpoints.value = await api.integrationEndpoints(); } catch (e) { alert(e.message); }
}
async function loadEvents() {
  try {
    events.value = await api.integrationEvents({
      status: evStatus.value || undefined, topic: evTopic.value || undefined
    });
  } catch (e) { alert(e.message); }
}
async function loadShipments() {
  try { shipments.value = await api.integrationShipments({}); } catch (e) { alert(e.message); }
}
async function loadCalls() {
  try {
    calls.value = await api.integrationCalls({
      endpoint_id: logEndpoint.value || undefined,
      only_error: logOnlyError.value ? 1 : undefined
    });
  } catch (e) { alert(e.message); }
}

// ---------- 接入点 ----------
function openEndpoint(r) {
  formMsg.value = '';
  Object.keys(epForm).forEach((k) => delete epForm[k]);
  Object.assign(epForm, r ? { ...r } : {
    id: null, code: '', name: '', type: 'shop', base_url: '', rate_limit_per_min: 60,
    status: 'active', shop_id: null, remark: ''
  });
  epModal.value = true;
}

async function saveEndpoint() {
  formMsg.value = '';
  if (!epForm.name) { formMsg.value = '请填写名称'; return; }
  if (!epForm.id && !epForm.code) { formMsg.value = '请填写编码'; return; }
  saving.value = true;
  try {
    if (epForm.id) await api.updateIntegrationEndpoint(epForm.id, epForm);
    else {
      const r = await api.createIntegrationEndpoint(epForm);
      if (r.api_key_plain) alert(`接入点已创建。\n\nAPI Key（仅显示这一次）：\n${r.api_key_plain}\n\n请立即复制给对方系统，之后只能重置。`);
    }
    epModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doRotate(r) {
  if (!confirm(`重置「${r.name}」的 API Key？旧 Key 会立即失效，对方系统需同步更新。`)) return;
  try {
    const out = await api.rotateIntegrationKey(r.id);
    alert(`新 API Key（仅显示这一次）：\n${out.api_key_plain}`);
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 事件 ----------
async function doDispatch() {
  try {
    const r = await api.dispatchIntegration({ limit: 20 });
    await loadAll();
    if (r.processed) {
      alert(`处理 ${r.processed} 条：成功 ${r.success}，待重试 ${r.failed}，进死信 ${r.dead}`);
    } else {
      alert('没有到期的事件需要处理');
    }
  } catch (e) { alert(e.message); }
}

async function doRetry(r) {
  try {
    const out = await api.retryIntegrationEvent(r.id);
    await loadAll();
    if (out.ok) alert('重放成功' + (out.note ? '：' + out.note : ''));
    else alert(`重放失败${out.dead ? '（已进死信）' : ''}：${out.error}`);
  } catch (e) { alert(e.message); }
}

async function doDrop(r) {
  const reason = prompt('放弃原因');
  if (!reason) return;
  try { await api.dropIntegrationEvent(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 物流校正 ----------
function openCorrect(r) {
  formMsg.value = '';
  Object.keys(corForm).forEach((k) => delete corForm[k]);
  Object.assign(corForm, {
    id: r.id, old_status: r.status_text, old_location: r.location,
    status_text: r.status_text, location: r.location || '', reason: ''
  });
  corModal.value = true;
}

async function saveCorrect() {
  formMsg.value = '';
  if (!corForm.reason) { formMsg.value = '人工校正必须填写理由'; return; }
  saving.value = true;
  try {
    await api.correctShipment(corForm.id, {
      status_text: corForm.status_text, location: corForm.location, reason: corForm.reason
    });
    corModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doApproveCorrect(r) {
  if (!confirm(`批准对「${r.order_no}」物流状态的校正？将保留旧值并通知客户。`)) return;
  try { await api.approveShipmentCorrection(r.id); await loadAll(); } catch (e) { alert(e.message); }
}

async function doRejectCorrect(r) {
  const reason = prompt('驳回原因');
  if (!reason) return;
  try { await api.rejectShipmentCorrection(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 交付 ----------
async function doOpenapi() {
  try {
    const doc = await api.openapi();
    openapiText.value = JSON.stringify(doc, null, 2);
  } catch (e) { alert(e.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1100px; }
.api-box {
  background: #0f172a; color: #cbd5e1; padding: 14px 16px; border-radius: 10px;
  font-size: 12px; line-height: 1.55; max-height: 420px; overflow: auto; white-space: pre-wrap;
}
:deep(code) { background: #eef2f8; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
