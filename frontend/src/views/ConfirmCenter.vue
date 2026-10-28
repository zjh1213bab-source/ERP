<template>
  <div>
    <div class="page-head">
      <div>
        <h2>客户确认</h2>
        <div class="sub">样衣封样确认 · 订单与工艺变更双向确认 · 交期变动与物流跟踪</div>
      </div>
      <button class="btn btn-ghost" @click="loadAll">刷新</button>
    </div>

    <div v-if="s.warnings && s.warnings.length" class="alert-bar">
      <div v-for="(w, i) in s.warnings" :key="i" style="margin: 2px 0">⚠️ {{ w }}</div>
    </div>

    <div class="cards">
      <div class="stat-card" :class="(s.seals && s.seals.waiting_customer) ? 'accent' : ''">
        <div class="label">待客户确认样衣</div>
        <div class="value">{{ (s.seals && s.seals.waiting_customer) || 0 }}<small>份</small></div>
        <div class="delta">已双确认 {{ (s.seals && s.seals.done) || 0 }} · 待技术与批准后发样</div>
      </div>
      <div class="stat-card">
        <div class="label">变更待签收</div>
        <div class="value">{{ (s.changes && s.changes.waiting_sign) || 0 }}<small>项</small></div>
        <div class="delta">评估中 {{ (s.changes && s.changes.assessing) || 0 }} · 待客户确认 {{ (s.changes && s.changes.waiting_customer) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">交期变动待确认</div>
        <div class="value">{{ (s.deliveries && s.deliveries.pending) || 0 }}<small>条</small></div>
        <div class="delta">已执行变更 {{ (s.changes && s.changes.effective) || 0 }} 项</div>
      </div>
      <div class="stat-card">
        <div class="label">物流待核实</div>
        <div class="value">{{ (s.shipments && s.shipments.unverified) || 0 }}<small>条</small></div>
        <div class="delta">人工登记 {{ (s.shipments && s.shipments.manual) || 0 }} / 共 {{ (s.shipments && s.shipments.total) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">逾期未发</div>
        <div class="value">{{ s.overdue_orders || 0 }}<small>单</small></div>
        <div class="delta">已过承诺交期且未发货</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <!-- ==================== 样衣封样 ==================== -->
    <template v-if="tab === 'seals'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="sealStatus" @change="loadSeals">
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="sent">待客户确认</option>
          <option value="confirmed">客户已确认</option>
          <option value="rejected">客户要求修改</option>
          <option value="superseded">已被替代</option>
        </select>
        <button class="btn btn-ghost" @click="loadSeals">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openSeal()">＋ 新建封样版本</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        客户确认 ≠ 总部技术批准，<strong>两条都要有</strong>才算封样完成。确认绑定的是「内容校验值」：附件或规格一改，校验值就变，必须重新确认。新建版本后旧版本自动置「已被替代」，<strong>旧版本的确认不能解除新版本的阻塞</strong>。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>封样单</th><th>订单 / 款</th><th>版本</th><th>内容校验值</th><th>客户确认</th><th>技术批准</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in seals" :key="r.id">
              <td class="nowrap">
                <strong>{{ r.seal_no }}</strong>
                <div class="muted" style="font-size: 12px">{{ r.sample_name || '-' }}</div>
              </td>
              <td class="nowrap">
                {{ r.order_no || '-' }}
                <div class="muted" style="font-size: 12px">{{ r.customer_name }}</div>
              </td>
              <td class="nowrap">
                {{ r.version }}
                <span v-if="r.is_latest" class="tag blue" style="margin-left: 4px">最新</span>
              </td>
              <td class="nowrap muted" style="font-family: monospace">{{ r.content_hash }}</td>
              <td class="nowrap">
                <span v-if="r.customer_confirmed_at" class="tag green">{{ r.customer_confirmed_by || '客户' }}</span>
                <span v-else class="muted">-</span>
                <div v-if="r.customer_comment" class="muted" style="font-size: 11.5px; max-width: 180px; white-space: normal">{{ r.customer_comment }}</div>
              </td>
              <td class="nowrap">
                <span class="tag" :class="r.tech_approved ? 'green' : 'gray'">{{ r.tech_approved ? '已批准' : '未批准' }}</span>
              </td>
              <td class="nowrap">
                <span class="tag" :class="sealTag(r.status)">{{ r.status_label }}</span>
                <div v-if="r.blocked && r.is_latest" class="muted" style="font-size: 11.5px; color: #c0392b">阻塞技术确认</div>
              </td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="!r.tech_approved && r.status !== 'superseded'" class="link-btn" @click="doTechApprove(r)">技术批准</button>
                <button v-if="r.tech_approved && r.status === 'draft'" class="link-btn" @click="doSendSeal(r)">发样给客户</button>
                <button v-if="r.status === 'sent' || r.status === 'draft'" class="link-btn" @click="doRejectSeal(r)">登记修改</button>
                <button class="link-btn" @click="openSeal(r.order_id)">新版本</button>
              </td>
            </tr>
            <tr v-if="!seals.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无封样记录</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="sealModal" class="modal-mask" @click.self="sealModal = false">
        <div class="modal">
          <div class="modal-head"><h3>新建封样版本</h3><button class="link-btn" @click="sealModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem full">
                <label>订单 *</label>
                <select class="select" v-model.number="sealForm.order_id" @change="pickOrderStyle">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '-' }}（{{ o.customer_name }}）</option>
                </select>
              </div>
              <div class="fitem"><label>款号</label><input class="input" v-model="sealForm.style_no" /></div>
              <div class="fitem"><label>样衣名称</label><input class="input" v-model="sealForm.sample_name" placeholder="如 主样·藏青" /></div>
              <div class="fitem"><label>版本（留空自动递增）</label><input class="input" v-model="sealForm.version" placeholder="V1 / V2" /></div>
              <div class="fitem"><label>附件（名称|地址，每行一条）</label><input class="input" v-model="sealForm.attachText" placeholder="正面.jpg|/uploads/a.jpg" /></div>
              <div class="fitem full"><label>备注（参与校验值计算）</label><input class="input" v-model="sealForm.remark" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">创建后同订单的旧版本会自动置「已被替代」。校验值由款号、名称、版本、附件与备注一起算出。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="sealModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveSeal">创建</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 变更确认 ==================== -->
    <template v-if="tab === 'changes'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="changeStatus" @change="loadChanges">
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="assessing">评估中</option>
          <option value="pending_customer">待客户确认</option>
          <option value="confirmed">客户已确认</option>
          <option value="effective">已生效执行</option>
          <option value="rejected">已驳回</option>
        </select>
        <button class="btn btn-ghost" @click="loadChanges">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openChange()">＋ 新建变更</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        必经链路：<strong>影响评估 → 总部批准 → 客户双向确认 → 生产工位签收 → 生效</strong>。变更只作用于「剩余数量」（总件数 − 已交数量），不追溯已交付部分；未做影响评估不能提交客户。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>变更号</th><th>订单</th><th>类型</th><th>变更内容</th><th>影响评估</th><th>剩余范围</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in changes" :key="r.id">
              <td class="nowrap"><strong>{{ r.change_no }}</strong><div class="muted" style="font-size: 12px">{{ r.customer_name }}</div></td>
              <td class="nowrap">{{ r.order_no }}<div class="muted" style="font-size: 12px">{{ r.style_name || '-' }}</div></td>
              <td class="nowrap">{{ r.type_label }}</td>
              <td class="nowrap" style="max-width: 240px; white-space: normal">{{ r.title }}</td>
              <td class="nowrap">
                在制 {{ r.affected_in_production }} · 已交 {{ r.delivered_qty }}
                <div class="muted" style="font-size: 11.5px">金额 {{ r.price_delta }} · 交期 {{ r.delivery_delta_days }} 天</div>
              </td>
              <td class="num">{{ r.remaining_qty }}</td>
              <td class="nowrap">
                <span class="tag" :class="changeTag(r.status)">{{ r.status_label }}</span>
                <div v-if="r.status === 'confirmed' && !r.workstation_signed" class="muted" style="font-size: 11.5px; color: #b07b12">待工位签收</div>
              </td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="!['confirmed','effective','rejected'].includes(r.status)" class="link-btn" @click="openAssess(r)">评估</button>
                <button v-if="['draft','assessing'].includes(r.status)" class="link-btn" @click="doApproveChange(r)">提交客户</button>
                <button v-if="r.status === 'confirmed' && !r.workstation_signed" class="link-btn" @click="doSignChange(r)">工位签收</button>
                <button v-if="!['effective','rejected'].includes(r.status)" class="link-btn danger" @click="doRejectChange(r)">驳回</button>
              </td>
            </tr>
            <tr v-if="!changes.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无变更单</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="changeModal" class="modal-mask" @click.self="changeModal = false">
        <div class="modal wide">
          <div class="modal-head"><h3>{{ changeForm.id ? '影响评估 · ' + changeForm.change_no : '新建变更' }}</h3><button class="link-btn" @click="changeModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem full" v-if="!changeForm.id">
                <label>订单 *</label>
                <select class="select" v-model.number="changeForm.order_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '-' }}</option>
                </select>
              </div>
              <div class="fitem">
                <label>变更类型</label>
                <select class="select" v-model="changeForm.type">
                  <option value="craft">工艺</option>
                  <option value="qty">数量</option>
                  <option value="price">价格</option>
                  <option value="delivery">交期</option>
                  <option value="material">面辅料</option>
                </select>
              </div>
              <div class="fitem"><label>变更内容 *</label><input class="input" v-model="changeForm.title" placeholder="如 袖口改为 2×2 罗纹" /></div>
              <div class="fitem"><label>影响在制数量</label><input class="input" type="number" v-model.number="changeForm.affected_in_production" /></div>
              <div class="fitem"><label>已交数量</label><input class="input" type="number" v-model.number="changeForm.delivered_qty" /></div>
              <div class="fitem"><label>剩余可变更数量</label><input class="input" type="number" v-model.number="changeForm.remaining_qty" /></div>
              <div class="fitem"><label>金额影响（元/件）</label><input class="input" type="number" step="0.01" v-model.number="changeForm.price_delta" /></div>
              <div class="fitem"><label>成本影响（元/件）</label><input class="input" type="number" step="0.01" v-model.number="changeForm.cost_delta" /></div>
              <div class="fitem"><label>交期影响（天）</label><input class="input" type="number" v-model.number="changeForm.delivery_delta_days" /></div>
              <div class="fitem"><label>影响材料说明</label><input class="input" v-model="changeForm.affected_materials" /></div>
              <div class="fitem full"><label>影响评估说明 *（提交客户前必填）</label>
                <textarea v-model="changeForm.assess_note" rows="3" placeholder="在制多少件需处理、材料是否受影响、费用与交期影响"></textarea>
              </div>
              <div class="fitem"><label>变更前</label><input class="input" v-model="changeForm.beforeText" placeholder="如 平口包边" /></div>
              <div class="fitem"><label>变更后</label><input class="input" v-model="changeForm.afterText" placeholder="如 2×2 罗纹" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">
              交期类变更提交客户时会自动登记一条交期变动记录（原承诺保留不覆盖）。
            </p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="changeModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveChange">{{ changeForm.id ? '保存评估' : '创建' }}</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 交期与物流 ==================== -->
    <template v-if="tab === 'delivery'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="deliveryStatus" @change="loadDeliveries">
          <option value="">全部交期状态</option>
          <option value="pending">待客户确认</option>
          <option value="confirmed">客户已确认</option>
          <option value="rejected">客户不接受</option>
        </select>
        <button class="btn btn-ghost" @click="loadDeliveries">查询</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openDelivery()">＋ 登记交期变动</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openEvent()">＋ 登记物流事件</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        <strong>原承诺与最新预计分开存</strong>，后者不覆盖前者，客户两侧都能看到。物流事件区分「接口同步」与「人工登记（经业务核实）」，未核实的会明确标「待核实」，不冒充实时直连。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>订单</th><th>类型</th><th>原承诺</th><th>最新预计</th><th>延后</th><th>原因</th><th>客户确认</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in deliveries" :key="r.id">
              <td class="nowrap">{{ r.order_no }}<div class="muted" style="font-size: 12px">{{ r.customer_name }}</div></td>
              <td class="nowrap">{{ r.kind_label }}</td>
              <td class="nowrap">{{ r.promised_date || '未定' }}</td>
              <td class="nowrap"><strong>{{ r.new_date }}</strong></td>
              <td class="num"><span :style="r.delay_days > 0 ? 'color:#c0392b;font-weight:700' : ''">{{ r.delay_days === null ? '-' : (r.delay_days > 0 ? '+' : '') + r.delay_days }}</span></td>
              <td style="max-width: 220px; white-space: normal">{{ r.reason || '-' }}</td>
              <td class="nowrap"><span class="tag" :class="r.status === 'confirmed' ? 'green' : r.status === 'rejected' ? 'red' : 'orange'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'pending'" class="link-btn" @click="doConfirmDelivery(r)">代录客户确认</button>
              </td>
            </tr>
            <tr v-if="!deliveries.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无交期变动</td></tr>
          </tbody>
        </table>
      </div>

      <div style="font-weight: 700; font-size: 13.5px; margin: 18px 0 8px">物流事件</div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>时间</th><th>订单</th><th>承运 / 单号</th><th>状态</th><th>地点</th><th>来源</th><th>核实</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in shipments" :key="e.id">
              <td class="nowrap">{{ $fmt(e.event_time || e.created_at) }}</td>
              <td class="nowrap">{{ e.order_no }}</td>
              <td class="nowrap">{{ e.carrier || '-' }}<div class="muted" style="font-size: 12px">{{ e.tracking_no || '' }}</div></td>
              <td style="max-width: 200px; white-space: normal">{{ e.status_text }}</td>
              <td class="nowrap">{{ e.location || '-' }}</td>
              <td class="nowrap"><span class="tag" :class="e.source === 'api' ? 'blue' : 'gray'">{{ e.source_label }}</span></td>
              <td class="nowrap"><span class="tag" :class="e.verified ? 'green' : 'orange'">{{ e.verified_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="!e.verified" class="link-btn" @click="doVerifyEvent(e)">标记已核实</button>
                <button class="link-btn danger" @click="doDeleteEvent(e)">删除</button>
              </td>
            </tr>
            <tr v-if="!shipments.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无物流事件</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="deliveryModal" class="modal-mask" @click.self="deliveryModal = false">
        <div class="modal">
          <div class="modal-head"><h3>登记交期变动</h3><button class="link-btn" @click="deliveryModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem full">
                <label>订单 *</label>
                <select class="select" v-model.number="deliveryForm.order_id" @change="pickPromised">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · 承诺 {{ o.delivery_date || '未定' }}</option>
                </select>
              </div>
              <div class="fitem"><label>原承诺（只读）</label><input class="input" :value="deliveryForm.promised_date || '未定'" disabled /></div>
              <div class="fitem"><label>最新预计 *</label><input class="input" type="date" v-model="deliveryForm.new_date" /></div>
              <div class="fitem"><label>类型</label>
                <select class="select" v-model="deliveryForm.kind">
                  <option value="etd">预计出厂</option>
                  <option value="eta_wh">预计到仓</option>
                  <option value="eta_customer">预计送达</option>
                </select>
              </div>
              <div class="fitem full"><label>原因</label><input class="input" v-model="deliveryForm.reason" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">登记后会推消息给客户确认；原承诺日期保持不变。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="deliveryModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveDelivery">登记</button>
          </div>
        </div>
      </div>

      <div v-if="eventModal" class="modal-mask" @click.self="eventModal = false">
        <div class="modal">
          <div class="modal-head"><h3>登记物流事件</h3><button class="link-btn" @click="eventModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem full">
                <label>订单 *</label>
                <select class="select" v-model.number="eventForm.order_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }}</option>
                </select>
              </div>
              <div class="fitem"><label>承运商</label><input class="input" v-model="eventForm.carrier" placeholder="Matson" /></div>
              <div class="fitem"><label>运单号</label><input class="input" v-model="eventForm.tracking_no" /></div>
              <div class="fitem"><label>事件时间</label><input class="input" type="datetime-local" v-model="eventForm.event_time" /></div>
              <div class="fitem"><label>地点</label><input class="input" v-model="eventForm.location" /></div>
              <div class="fitem full"><label>物流状态 *</label><input class="input" v-model="eventForm.status_text" placeholder="如 已装船离港" /></div>
              <div class="fitem"><label>来源</label>
                <select class="select" v-model="eventForm.source">
                  <option value="manual">人工登记</option>
                  <option value="api">接口同步</option>
                </select>
              </div>
              <div class="fitem"><label>是否已核实</label>
                <select class="select" v-model.number="eventForm.verified">
                  <option :value="0">待核实</option>
                  <option :value="1">已核实</option>
                </select>
              </div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="eventModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveEvent">登记</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'seals', label: '样衣封样' },
  { key: 'changes', label: '订单与工艺变更' },
  { key: 'delivery', label: '交期与物流' }
];

const tab = ref('seals');
const canWrite = computed(() => can('confirm.write'));
const s = ref({});
const saving = ref(false);
const formMsg = ref('');
const orders = ref([]);

const seals = ref([]);
const sealStatus = ref('');
const sealModal = ref(false);
const sealForm = reactive({});

const changes = ref([]);
const changeStatus = ref('');
const changeModal = ref(false);
const changeForm = reactive({});

const deliveries = ref([]);
const deliveryStatus = ref('');
const deliveryModal = ref(false);
const deliveryForm = reactive({});
const shipments = ref([]);
const eventModal = ref(false);
const eventForm = reactive({});

function sealTag(v) {
  return { draft: 'gray', sent: 'orange', confirmed: 'green', rejected: 'red', superseded: 'gray' }[v] || 'gray';
}
function changeTag(v) {
  return {
    draft: 'gray', assessing: 'orange', pending_customer: 'blue',
    confirmed: 'green', effective: 'green', rejected: 'red'
  }[v] || 'gray';
}

async function loadAll() {
  try { s.value = await api.confirmStats(); } catch (e) { /* 概览失败不阻塞 */ }
  try { orders.value = await api.orders(); } catch (e) { orders.value = []; }
  await Promise.all([loadSeals(), loadChanges(), loadDeliveries(), loadShipments()]);
}

async function loadSeals() {
  try { seals.value = await api.seals({ status: sealStatus.value || undefined }); } catch (e) { alert(e.message); }
}
async function loadChanges() {
  try { changes.value = await api.orderChanges({ status: changeStatus.value || undefined }); } catch (e) { alert(e.message); }
}
async function loadDeliveries() {
  try { deliveries.value = await api.deliveries({ status: deliveryStatus.value || undefined }); } catch (e) { alert(e.message); }
}
async function loadShipments() {
  try { shipments.value = await api.shipments({}); } catch (e) { alert(e.message); }
}

// ---------- 封样 ----------
function openSeal(orderId) {
  formMsg.value = '';
  Object.keys(sealForm).forEach((k) => delete sealForm[k]);
  Object.assign(sealForm, {
    order_id: orderId || null, style_no: '', sample_name: '', version: '', attachText: '', remark: ''
  });
  if (orderId) pickOrderStyle();
  sealModal.value = true;
}

function pickOrderStyle() {
  const o = orders.value.find((x) => x.id === sealForm.order_id);
  if (o && !sealForm.style_no) sealForm.style_no = o.style_name || '';
}

async function saveSeal() {
  formMsg.value = '';
  if (!sealForm.order_id) { formMsg.value = '请选择订单'; return; }
  saving.value = true;
  try {
    const attachments = String(sealForm.attachText || '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const [name, url] = l.split('|');
        return { name: (name || '').trim(), url: (url || '').trim() };
      });
    await api.createSeal({
      order_id: sealForm.order_id, style_no: sealForm.style_no, sample_name: sealForm.sample_name,
      version: sealForm.version || undefined, remark: sealForm.remark, attachments
    });
    sealModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doTechApprove(r) {
  try { await api.techApproveSeal(r.id); await loadAll(); } catch (e) { alert(e.message); }
}
async function doSendSeal(r) {
  try { await api.sendSeal(r.id); await loadAll(); } catch (e) { alert(e.message); }
}
async function doRejectSeal(r) {
  const comment = prompt('客户提出的修改意见');
  if (!comment) return;
  try { await api.rejectSeal(r.id, { comment }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 变更 ----------
function openChange(r) {
  formMsg.value = '';
  Object.keys(changeForm).forEach((k) => delete changeForm[k]);
  Object.assign(changeForm, r ? {
    id: r.id, change_no: r.change_no, order_id: r.order_id, type: r.type, title: r.title,
    affected_in_production: r.affected_in_production, delivered_qty: r.delivered_qty,
    remaining_qty: r.remaining_qty, price_delta: r.price_delta, cost_delta: r.cost_delta,
    delivery_delta_days: r.delivery_delta_days, affected_materials: r.affected_materials || '',
    assess_note: r.assess_note || '',
    beforeText: r.before ? JSON.stringify(r.before) : '', afterText: r.after ? JSON.stringify(r.after) : ''
  } : {
    id: null, order_id: null, type: 'craft', title: '', affected_in_production: 0, delivered_qty: 0,
    remaining_qty: 0, price_delta: 0, cost_delta: 0, delivery_delta_days: 0,
    affected_materials: '', assess_note: '', beforeText: '', afterText: ''
  });
  changeModal.value = true;
}

async function saveChange() {
  formMsg.value = '';
  if (!changeForm.title) { formMsg.value = '请填写变更内容'; return; }
  saving.value = true;
  try {
    const before = changeForm.beforeText ? { value: changeForm.beforeText } : null;
    const after = changeForm.afterText ? { value: changeForm.afterText } : null;
    if (changeForm.id) {
      await api.updateOrderChange(changeForm.id, {
        title: changeForm.title, type: changeForm.type, before, after,
        affected_in_production: changeForm.affected_in_production, delivered_qty: changeForm.delivered_qty,
        remaining_qty: changeForm.remaining_qty, price_delta: changeForm.price_delta,
        cost_delta: changeForm.cost_delta, delivery_delta_days: changeForm.delivery_delta_days,
        affected_materials: changeForm.affected_materials, assess_note: changeForm.assess_note
      });
    } else {
      if (!changeForm.order_id) { formMsg.value = '请选择订单'; saving.value = false; return; }
      await api.createOrderChange({
        order_id: changeForm.order_id, type: changeForm.type, title: changeForm.title,
        before, after, affected_in_production: changeForm.affected_in_production,
        delivered_qty: changeForm.delivered_qty, remaining_qty: changeForm.remaining_qty,
        price_delta: changeForm.price_delta, cost_delta: changeForm.cost_delta,
        delivery_delta_days: changeForm.delivery_delta_days, affected_materials: changeForm.affected_materials
      });
    }
    changeModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

function openAssess(r) { openChange(r); }

async function doApproveChange(r) {
  if (!confirm(`提交变更 ${r.change_no} 给客户确认？`)) return;
  try { await api.approveOrderChange(r.id); await loadAll(); } catch (e) { alert(e.message); }
}
async function doSignChange(r) {
  if (!confirm(`确认生产工位已签收变更 ${r.change_no}？签收后变更正式生效执行。`)) return;
  try { await api.signOrderChange(r.id); await loadAll(); } catch (e) { alert(e.message); }
}
async function doRejectChange(r) {
  const reason = prompt('驳回原因');
  if (!reason) return;
  try { await api.rejectOrderChange(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 交期与物流 ----------
function openDelivery() {
  formMsg.value = '';
  Object.keys(deliveryForm).forEach((k) => delete deliveryForm[k]);
  Object.assign(deliveryForm, { order_id: null, promised_date: '', new_date: '', kind: 'etd', reason: '' });
  deliveryModal.value = true;
}

function pickPromised() {
  const o = orders.value.find((x) => x.id === deliveryForm.order_id);
  deliveryForm.promised_date = o ? o.delivery_date : '';
}

async function saveDelivery() {
  formMsg.value = '';
  if (!deliveryForm.order_id) { formMsg.value = '请选择订单'; return; }
  if (!deliveryForm.new_date) { formMsg.value = '请填写最新预计日期'; return; }
  saving.value = true;
  try {
    await api.createDeliveryChange(deliveryForm);
    deliveryModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doConfirmDelivery(r) {
  const comment = prompt('客户确认意见（线下沟通记录）');
  if (comment === null) return;
  try { await api.confirmDeliveryChange(r.id, { accepted: true, comment }); await loadAll(); } catch (e) { alert(e.message); }
}

function openEvent() {
  formMsg.value = '';
  Object.keys(eventForm).forEach((k) => delete eventForm[k]);
  Object.assign(eventForm, {
    order_id: null, carrier: '', tracking_no: '', event_time: '', location: '',
    status_text: '', source: 'manual', verified: 0
  });
  eventModal.value = true;
}

async function saveEvent() {
  formMsg.value = '';
  if (!eventForm.order_id) { formMsg.value = '请选择订单'; return; }
  if (!eventForm.status_text) { formMsg.value = '请填写物流状态'; return; }
  saving.value = true;
  try {
    await api.createShipmentEvent({
      ...eventForm,
      event_time: eventForm.event_time ? new Date(eventForm.event_time).toISOString() : undefined
    });
    eventModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doVerifyEvent(e) {
  try { await api.verifyShipmentEvent(e.id); await loadAll(); } catch (err) { alert(err.message); }
}
async function doDeleteEvent(e) {
  if (!confirm('删除该物流事件？')) return;
  try { await api.deleteShipmentEvent(e.id); await loadAll(); } catch (err) { alert(err.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1080px; }
</style>
