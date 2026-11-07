<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>售后与对账资料</h2>
        <p class="sub">
          客户在商城自己提售后，业务在这里受理。<b>退款、实物实收、质量检验、再上架、追偿五条轨道各自独立</b> ——
          退了钱不等于货回来了，货回来了也不等于能再上架。
          <b>退款不会动库存</b>：良品只有经仓库检验判定后才进可售。
        </p>
      </div>
      <div class="head-ops">
        <input v-model="kw" class="input" style="width: 150px" placeholder="单号 / 客户 / 订单" @keyup.enter="reload" />
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card accent">
        <div class="label">待受理</div>
        <div class="value">{{ stats.pending_accept || 0 }}</div>
        <div class="foot">客户已提，还没人回</div>
      </div>
      <div class="stat-card">
        <div class="label">处理中</div>
        <div class="value">{{ stats.open || 0 }}</div>
        <div class="foot">含待受理</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.overdue }">
        <div class="label">已超时限</div>
        <div class="value">{{ stats.overdue || 0 }}</div>
        <div class="foot">过了承诺回复日</div>
      </div>
      <div class="stat-card">
        <div class="label">待退款</div>
        <div class="value">{{ stats.refund_pending || 0 }}</div>
        <div class="foot">受理了还没退</div>
      </div>
      <div class="stat-card">
        <div class="label">已退金额</div>
        <div class="value">{{ money(stats.refund_paid_amount) }}</div>
        <div class="foot">累计（原币合计）</div>
      </div>
      <div class="stat-card">
        <div class="label">追偿中</div>
        <div class="value">{{ stats.recovery_open || 0 }}</div>
        <div class="foot">应向工厂/供应商要回 {{ money(stats.recovery_pending_amount) }}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'ticket' }" @click="tab = 'ticket'">售后单（{{ tickets.length }}）</button>
          <button :class="{ on: tab === 'file' }" @click="tab = 'file'">对账资料（{{ files.length }}）</button>
        </div>
        <div class="head-ops" v-if="tab === 'ticket'">
          <select v-model="statusFilter" class="input" style="width: 110px" @change="loadTickets">
            <option value="open">未结案</option>
            <option value="">全部</option>
            <option value="submitted">待受理</option>
            <option value="settled">已结案</option>
            <option value="rejected">已驳回</option>
          </select>
        </div>
        <div class="head-ops" v-else>
          <button class="btn btn-primary" @click="openGenerate">生成对账单</button>
        </div>
      </div>

      <!-- ---------------- 售后单 ---------------- -->
      <div v-if="tab === 'ticket'">
        <div class="table-wrap" v-if="tickets.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 154px">单号</th>
                <th style="width: 170px">客户 / 订单</th>
                <th style="width: 120px">款 / 数量</th>
                <th style="width: 92px">原因</th>
                <th style="width: 92px">处理方式</th>
                <th style="width: 132px">退款</th>
                <th style="width: 172px">实物（实收 / 判定）</th>
                <th style="width: 100px">时限</th>
                <th style="width: 92px">状态</th>
                <th style="width: 88px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in tickets" :key="r.id" :class="{ dim: r.status === 'settled' || r.status === 'rejected' }">
                <td>
                  <b>{{ r.ticket_no }}</b>
                  <div class="tiny mut">{{ (r.created_at || '').slice(0, 10) }}</div>
                </td>
                <td>
                  <div class="ell">{{ r.customer_name || '—' }}</div>
                  <div class="tiny mut ell">{{ r.order_no || '—' }}</div>
                </td>
                <td>
                  <div class="ell">{{ r.style_no || '—' }}</div>
                  <div class="tiny mut">{{ num(r.qty) }} 件 · 索赔 {{ money(r.amount_claim) }}</div>
                </td>
                <td><span class="tag gray">{{ r.reason_label }}</span></td>
                <td class="tiny">{{ r.resolution_label }}</td>
                <td>
                  <span v-if="r.refund_status === 'paid'" class="tag green">已退 {{ money(r.refund_amount) }}</span>
                  <span v-else-if="r.refund_status === 'pending'" class="tag amber">待退款</span>
                  <span v-else class="mut">不涉及</span>
                </td>
                <td class="tiny">
                  <div v-if="r.tracks.receipt.code === &#39;none&#39;" class="mut">不涉及实物</div>
                  <template v-else>
                    <div>{{ r.tracks.receipt.label }}</div>
                    <div class="mut">{{ r.tracks.inspect.label }}</div>
                  </template>
                </td>
                <td class="tiny">
                  <span v-if="r.status === 'settled' || r.status === 'rejected'" class="mut">—</span>
                  <span v-else-if="r.overdue" class="tag red">逾期 {{ r.overdue_days }} 天</span>
                  <span v-else>{{ r.due_date || '—' }}</span>
                </td>
                <td><span class="tag" :class="stCls(r.status)">{{ r.status_label }}</span></td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="openDetail(r.id)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有售后单。客户在商城「我的订单 → 售后」里提交后会出现在这里。</div>
      </div>

      <!-- ---------------- 对账资料 ---------------- -->
      <div v-else>
        <div class="notice">
          客户下载的是<b>发布那一刻的定版快照</b>，之后内部账再变也不追溯 —— 这样客户核对的是他手上那份纸。
          撤销后立即失效，每次下载都会留痕。
        </div>
        <div class="table-wrap" v-if="files.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 130px">文件号</th>
                <th style="width: 140px">客户</th>
                <th style="width: 176px">期间</th>
                <th style="width: 44px">版本</th>
                <th style="width: 94px">本期开票</th>
                <th style="width: 94px">本期收款</th>
                <th style="width: 100px">期末结欠</th>
                <th style="width: 96px">状态</th>
                <th style="width: 116px">授权</th>
                <th style="width: 120px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in files" :key="f.id">
                <td><b>{{ f.file_no }}</b></td>
                <td class="ell">{{ f.customer_name }}</td>
                <td class="tiny nowrap">{{ f.period_from }} ~ {{ f.period_to }}</td>
                <td class="tiny">v{{ f.version_no }}</td>
                <td class="num">{{ money(f.amount_invoiced) }}</td>
                <td class="num">{{ money(f.amount_paid) }}</td>
                <td class="num"><b>{{ money(f.amount_closing) }}</b></td>
                <td>
                  <span class="tag" :class="f.status === 'published' ? 'green' : (f.status === 'revoked' ? 'red' : 'gray')">
                    {{ f.status_label }}
                  </span>
                  <div v-if="f.expired" class="tiny red">已过期</div>
                </td>
                <td class="tiny">
                  <div v-if="f.granted_by">{{ f.granted_by }}</div>
                  <div class="mut nowrap">{{ (f.granted_at || '').slice(0, 10) || '—' }}</div>
                  <div class="mut" v-if="f.download_count">下载 {{ f.download_count }} 次</div>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="previewFile(f)">预览</button>
                  <button v-if="f.status === 'draft'" class="btn btn-sm btn-primary" @click="publishFile(f)">授权</button>
                  <button v-if="f.status === 'published'" class="btn btn-sm btn-ghost" @click="revokeFile(f)">撤销</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有对账文件。点右上「生成对账单」，选客户与月份即可。</div>
      </div>
    </div>

    <!-- ---------------- 详情弹窗 ---------------- -->
    <div class="modal-mask" v-if="detail">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left">
            <b>{{ detail.ticket_no }}</b>
            <span class="tag" :class="stCls(detail.status)">{{ detail.status_label }}</span>
            <span class="tag gray">{{ detail.reason_label }}</span>
            <span class="tag gray">{{ detail.resolution_label }}</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="detail = null">关闭</button>
        </div>
        <div class="modal-body">
          <div class="cols">
            <div>
              <div class="col-h">基本信息</div>
              <div class="kv"><span>客户</span><b>{{ detail.customer_name || '—' }}</b></div>
              <div class="kv"><span>订单</span><b>{{ detail.order_no || '—' }}（{{ detail.order ? detail.order.status : '—' }}）</b></div>
              <div class="kv"><span>款 / 数量</span><b>{{ detail.style_no || '—' }} · {{ num(detail.qty) }} 件</b></div>
              <div class="kv"><span>索赔金额</span><b>{{ money(detail.amount_claim) }} {{ detail.currency }}</b></div>
              <div class="kv"><span>提出时间</span><b>{{ (detail.created_at || '').slice(0, 16).replace('T', ' ') }}</b></div>
              <div class="kv"><span>主责 / 时限</span><b>{{ detail.owner_label || '待指派' }} · {{ detail.due_date || '—' }}
                <span v-if="detail.overdue" class="tag red">逾期 {{ detail.overdue_days }} 天</span></b></div>
              <div class="reason-box">
                <div class="col-h">客户描述</div>
                <p>{{ detail.reason }}</p>
              </div>
              <div class="photos" v-if="detail.photos && detail.photos.length">
                <a v-for="p in detail.photos" :key="p.id" :href="p.url" target="_blank">
                  <img :src="p.url" :alt="p.filename" />
                </a>
              </div>
              <div class="tiny mut" v-else>客户没有上传照片</div>
            </div>

            <div>
              <div class="col-h">五条轨道</div>
              <div class="track" :class="trackCls(detail.refund_status)">
                <div class="t-name">退款</div>
                <div class="t-val">
                  <b>{{ detail.refund_status_label }}</b>
                  <span v-if="detail.refund_status === 'paid'">{{ money(detail.refund_amount) }} · {{ detail.refund_method }}</span>
                </div>
                <div class="t-note tiny mut">
                  {{ detail.goods_returned === 1 ? '货物会回厂' : (detail.goods_returned === 0 ? '货物不回厂（客户保留）' : '—') }}
                </div>
              </div>
              <div class="track" :class="trackCls(detail.tracks.receipt.code)">
                <div class="t-name">实物实收</div>
                <div class="t-val"><b>{{ detail.tracks.receipt.label }}</b></div>
                <div class="t-note tiny mut">
                  <span v-if="detail.stock_return">退货单 {{ detail.stock_return.return_no }}（仓库点收）</span>
                  <span v-else-if="detail.tracks.receipt.code !== &#39;none&#39;">受理后自动生成退货单，等客户寄回</span>
                  <span v-else>不涉及实物</span>
                </div>
              </div>
              <div class="track" :class="trackCls(detail.tracks.inspect.code)">
                <div class="t-name">质量检验</div>
                <div class="t-val"><b>{{ detail.tracks.inspect.label }}</b></div>
                <div class="t-note tiny mut">良品/次品/报废由仓库逐件判定</div>
              </div>
              <div class="track" :class="trackCls(detail.tracks.restock.code)">
                <div class="t-name">再上架</div>
                <div class="t-val"><b>{{ detail.tracks.restock.label }}</b></div>
                <div class="t-note tiny mut">只有良品才进可售，不走退款逻辑</div>
              </div>
              <div class="track" :class="trackCls(detail.recovery_status === 'done' ? 'done' : (detail.recovery_status === 'pending' ? 'pending' : 'none'))">
                <div class="t-name">追偿</div>
                <div class="t-val">
                  <b>{{ detail.recovery_status_label }}</b>
                  <span v-if="detail.recovery_amount">{{ money(detail.recovery_amount) }} · {{ detail.recovery_party_label }}</span>
                </div>
                <div class="t-note tiny mut">向工厂/供应商要回，与客户退款两条线</div>
              </div>

              <div class="blockers" v-if="detail.settle_blockers && detail.settle_blockers.length">
                <div class="b-h">还不能结案</div>
                <ul><li v-for="(b, i) in detail.settle_blockers" :key="i">{{ b }}</li></ul>
              </div>
              <div class="done-box" v-else-if="detail.status === 'settled'">
                <div class="b-h">结案结论</div>
                <p>{{ detail.conclusion }}</p>
              </div>
              <div class="done-box reject" v-if="detail.status === 'rejected'">
                <div class="b-h">驳回原因</div>
                <p>{{ detail.reject_reason }}</p>
              </div>
            </div>
          </div>

          <!-- 动作区 -->
          <div class="actions" v-if="detail.status === 'submitted'">
            <div class="col-h">受理</div>
            <div class="row">
              <label>主责</label>
              <select v-model="act.owner_role" class="input" style="width: 120px">
                <option value="">按原因自动定</option>
                <option v-for="o in meta.owners || []" :key="o.code" :value="o.code">{{ o.label }}</option>
              </select>
              <label>回复时限</label>
              <input v-model="act.due_date" class="input" type="date" style="width: 150px" />
              <button class="btn btn-primary" @click="doAccept">受理</button>
            </div>
            <div class="row">
              <label>驳回原因</label>
              <input v-model="act.reject" class="input" style="flex: 1" placeholder="≥6 字，写清为什么不属售后范围（客户会看到）" />
              <button v-action="['after-sales','reject']" class="btn btn-ghost" @click="doReject">驳回</button>
            </div>
            <div class="tiny mut">受理「退货退款 / 返修」时会自动在仓库生成退货单草稿，等客户把货寄回后由仓库点收判定。</div>
          </div>

          <div class="actions" v-else-if="detail.status === 'accepted' || detail.status === 'handling'">
            <div class="col-h">退款<span class="mut tiny">（只动钱，不动库存）</span></div>
            <div class="row" v-if="canRefund">
              <label>金额</label>
              <input v-model="act.amount" class="input" type="number" style="width: 110px" :placeholder="String(detail.amount_claim)" />
              <label>方式</label>
              <select v-model="act.method" class="input" style="width: 150px">
                <option value="原路退回">原路退回</option>
                <option value="抵扣下批货款">抵扣下批货款</option>
                <option value="线下支付">线下支付</option>
              </select>
              <label class="ck"><input type="checkbox" v-model="act.goods_returned" /> 货物会回厂</label>
              <button class="btn btn-primary" @click="doRefund" :disabled="detail.refund_status === 'paid'">
                {{ detail.refund_status === 'paid' ? '已退款' : '登记退款' }}
              </button>
            </div>
            <div class="row" v-if="canRefund">
              <label>备注</label>
              <input v-model="act.refund_note" class="input" style="flex: 1" placeholder="为什么这么退（客户保留货物时必须写清）" />
            </div>
            <div class="tiny mut" v-if="!canRefund">你没有退款权限（财务 / 管理员），可先催办或让财务处理。</div>

            <div class="col-h" style="margin-top: 12px">追偿</div>
            <div class="row">
              <label>对象</label>
              <select v-model="act.party" class="input" style="width: 130px">
                <option value="">选择</option>
                <option v-for="p in meta.parties || []" :key="p.code" :value="p.code">{{ p.label }}</option>
              </select>
              <label>金额</label>
              <input v-model="act.recovery_amount" class="input" type="number" style="width: 100px" />
              <input v-model="act.recovery_note" class="input" style="flex: 1" placeholder="依据（如：面料批次问题，按合同追 60%）" />
              <button class="btn btn-ghost" @click="doRecovery" :disabled="detail.recovery_status === 'done'">登记追偿</button>
            </div>

            <div class="col-h" style="margin-top: 12px">结案</div>
            <div class="row">
              <input v-model="act.conclusion" class="input" style="flex: 1" placeholder="≥8 字：处理了什么、客户是否认可（客户会看到）" />
              <button class="btn btn-primary" @click="doSettle">结案</button>
            </div>
            <div class="tiny mut" v-if="detail.settle_blockers && detail.settle_blockers.length">
              上面列出的 {{ detail.settle_blockers.length }} 项没走完，结案会被拦下。
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ---------------- 生成对账单 ---------------- -->
    <div class="modal-mask" v-if="gen.open">
      <div class="modal">
        <div class="modal-head"><b>生成对账单</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="gen.open = false">取消</button></div>
        <div class="modal-body">
          <div class="row">
            <label>客户</label>
            <select v-model="gen.customer_id" class="input" style="flex: 1">
              <option :value="null">选择客户</option>
              <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="row">
            <label>月份</label>
            <input v-model="gen.period" class="input" type="month" style="width: 160px" />
            <label>类型</label>
            <select v-model="gen.kind" class="input" style="width: 140px">
              <option value="monthly">月度对账</option>
              <option value="payment_notice">付款通知</option>
            </select>
          </div>
          <div class="notice">
            生成的是<b>草稿</b>，客户看不到。确认金额无误后点「授权」，客户才能在商城下载；
            内部校验差（有发票被手工改过 / 收款没走流水）不为 0 时不允许授权。
          </div>
          <div class="modal-foot">
            <button class="btn btn-primary" @click="doGenerate" :disabled="!gen.customer_id || !gen.period">生成</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { auth } from '../store/auth';

const tab = ref('ticket');
const kw = ref('');
const statusFilter = ref('open');
const tickets = ref([]);
const files = ref([]);
const meta = ref({});
const stats = ref({});
const detail = ref(null);
const customers = ref([]);

const gen = reactive({ open: false, customer_id: null, period: '', kind: 'monthly' });
const act = reactive({
  owner_role: '', due_date: '', reject: '',
  amount: '', method: '原路退回', goods_returned: false, refund_note: '',
  party: '', recovery_amount: '', recovery_note: '', conclusion: ''
});

const role = computed(() => (auth.user && auth.user.role) || '');
const canRefund = computed(() => ['admin', 'finance'].includes(role.value));

const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (v) => Number(v || 0);
const stCls = (s) => ({
  submitted: 'amber', accepted: 'blue', handling: 'blue', settled: 'green', rejected: 'gray', cancelled: 'gray'
}[s] || 'gray');
// 轨道状态配色：done 绿 / pending 橙 / 其余灰
const trackCls = (c) => ({ done: 'done', paid: 'done', passed: 'done', received: 'done', partial: 'warn', failed: 'bad', pending: 'warn' }[c] || 'idle');

async function loadTickets() {
  try {
    const q = {};
    if (statusFilter.value) q.status = statusFilter.value;
    if (kw.value) q.q = kw.value;
    tickets.value = await api.asList(q);
  } catch (e) { alert(e.message); }
}

async function loadFiles() {
  try {
    const q = {};
    if (kw.value) q.q = kw.value;
    files.value = await api.sfList(q);
  } catch (e) { alert(e.message); }
}

async function reload() {
  try {
    const m = await api.asMeta();
    meta.value = m;
    stats.value = m.stats || {};
  } catch (e) { /* 字典失败不该拖垮清单 */ }
  await Promise.all([loadTickets(), loadFiles()]);
}

async function openDetail(id) {
  try {
    detail.value = await api.asDetail(id);
    Object.assign(act, {
      owner_role: detail.value.owner_role || '', due_date: detail.value.due_date || '',
      reject: '', amount: String(detail.value.amount_claim || ''), method: '原路退回',
      goods_returned: detail.value.goods_returned === 1, refund_note: '',
      party: '', recovery_amount: '', recovery_note: '', conclusion: ''
    });
  } catch (e) { alert(e.message); }
}

async function refreshDetail() {
  if (!detail.value) return;
  const id = detail.value.id;
  detail.value = await api.asDetail(id);
  await loadTickets();
  const m = await api.asMeta();
  stats.value = m.stats || {};
}

async function doAccept() {
  try {
    const r = await api.asAccept(detail.value.id, { owner_role: act.owner_role || undefined, due_date: act.due_date || undefined });
    await refreshDetail();
    alert(r.note);
  } catch (e) { alert(e.message); }
}

async function doReject() {
  try {
    await api.asReject(detail.value.id, { reason: act.reject });
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doRefund() {
  try {
    const r = await api.asRefund(detail.value.id, {
      amount: Number(act.amount), method: act.method,
      goods_returned: act.goods_returned ? 1 : 0, note: act.refund_note
    });
    await refreshDetail();
    alert(r.note);
  } catch (e) { alert(e.message); }
}

async function doRecovery() {
  try {
    const r = await api.asRecovery(detail.value.id, {
      party: act.party, amount: Number(act.recovery_amount), note: act.recovery_note
    });
    await refreshDetail();
    alert(r.note);
  } catch (e) { alert(e.message); }
}

async function doSettle() {
  try {
    await api.asSettle(detail.value.id, { conclusion: act.conclusion });
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

/* ---------------- 对账资料 ---------------- */
async function openGenerate() {
  gen.open = true;
  if (!gen.period) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    gen.period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (!customers.value.length) {
    try { customers.value = await api.statementCustomers(); } catch (e) { alert(e.message); }
  }
}

async function doGenerate() {
  try {
    const r = await api.sfGenerate({ customer_id: gen.customer_id, period: gen.period, kind: gen.kind });
    gen.open = false;
    await Promise.all([loadFiles(), refreshStats()]);
    const warn = (r.warnings || []).length ? '\n\n注意：\n· ' + r.warnings.join('\n· ') : '';
    alert(`已生成 ${r.file_no}（v${r.version_no}），期末结欠 ${money(r.amount_closing)}${warn}`);
  } catch (e) { alert(e.message); }
}

async function publishFile(f) {
  if (!confirm(`确定把 ${f.file_no} 授权给客户下载？客户看到的就是这份定版数。`)) return;
  try {
    const r = await api.sfPublish(f.id);
    await Promise.all([loadFiles(), refreshStats()]);
    const extra = (r.superseded || []).length ? `\n同时把旧版本 ${r.superseded.join('、')} 置为失效` : '';
    const warn = (r.warnings || []).length ? '\n\n注意：\n· ' + r.warnings.join('\n· ') : '';
    alert(`已授权${extra}${warn}`);
  } catch (e) { alert(e.message); }
}

async function revokeFile(f) {
  const reason = prompt(`撤销 ${f.file_no} 的原因（≥4 字，客户可能已经下载过）：`);
  if (!reason) return;
  try {
    await api.sfRevoke(f.id, { reason });
    await Promise.all([loadFiles(), refreshStats()]);
  } catch (e) { alert(e.message); }
}

async function previewFile(f) {
  try {
    const blob = await downloadFile(api.sfPreviewPath(f.id));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `preview-${f.file_no}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { alert(e.message); }
}

async function refreshStats() {
  try {
    const m = await api.asMeta();
    stats.value = m.stats || {};
  } catch (e) { /* ignore */ }
}

onMounted(reload);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }
.panel .tag { white-space: nowrap; }

.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 100px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 12px; line-height: 1.4; }
.stat-card.warn { border-color: #fde68a; background: #fffdf5; }

.ell { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiny { font-size: 12px; line-height: 1.45; }
.mut { color: #7b8698; }
.red { color: #b91c1c; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.dim td { color: var(--ink-mute); }
.empty { padding: 26px 6px; color: #7b8698; font-size: 12.5px; }
.table-wrap { overflow-x: auto; }
/* 单元格里的标签与单号一律不折行：折成「已撤 / 销」「详 / 情」这种竖排完全读不懂 */
table.data .tag { white-space: nowrap; }
table.data td b { white-space: nowrap; }
table.data td.nowrap { white-space: nowrap; }
/* 这个类会用在 div 上（授权日期），只写 td.nowrap 的话类名形同虚设 */
.nowrap { white-space: nowrap; }
table.data .btn { white-space: nowrap; }
table.data td { vertical-align: middle; }
.ops { white-space: nowrap; }
.ops .btn + .btn { margin-left: 6px; }

.notice { border: 1px solid #dbeafe; background: #f6faff; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #1e3a5f; margin-bottom: 10px; }

/* 弹窗 */
.modal.wide { width: min(1020px, 94vw); }
.mh-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
@media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
.col-h { font-size: 12.5px; font-weight: 600; color: var(--ink); margin-bottom: 7px; }
.kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.kv > span { color: #7b8698; min-width: 74px; flex: 0 0 auto; }
.kv > b { font-weight: 500; }
.reason-box { border: 1px solid #eef1f6; background: #fbfdff; border-radius: 9px; padding: 8px 11px; margin: 10px 0; }
.reason-box p { margin: 0; font-size: 12px; line-height: 1.7; }
.photos { display: flex; gap: 8px; flex-wrap: wrap; }
.photos img { width: 84px; height: 84px; object-fit: cover; border-radius: 8px; border: 1px solid #e6ebf3; }

/* 五条轨道：一眼看出哪条卡住 */
.track { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 2px 8px; padding: 6px 9px; border-radius: 8px; border: 1px solid #eef1f6; margin-bottom: 6px; background: #fcfdff; }
.track .t-name { font-size: 12px; color: #7b8698; grid-row: span 2; align-self: center; }
.track .t-val { font-size: 12px; }
.track .t-note { grid-column: 2; }
.track.done { border-color: #bbf7d0; background: #f5fdf8; }
.track.done .t-name { color: #047857; }
.track.warn { border-color: #fde68a; background: #fffdf5; }
.track.warn .t-name { color: #92400e; }
.track.bad { border-color: #fecaca; background: #fff7f7; }
.track.bad .t-name { color: #b91c1c; }

.blockers { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 8px 11px; margin-top: 8px; }
.b-h { font-size: 12px; font-weight: 600; color: #92400e; margin-bottom: 3px; }
.blockers ul { margin: 0 0 0 16px; font-size: 12px; color: #92400e; line-height: 1.7; }
.done-box { border: 1px solid #bbf7d0; background: #f5fdf8; border-radius: 9px; padding: 8px 11px; margin-top: 8px; }
.done-box .b-h { color: #047857; }
.done-box p { margin: 0; font-size: 12px; line-height: 1.7; }
.done-box.reject { border-color: var(--line); background: #fafafa; }
.done-box.reject .b-h { color: #4b5563; }

.actions { border-top: 1px solid #eef1f6; margin-top: 14px; padding-top: 12px; }
.actions .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.actions .row label { font-size: 12px; color: #7b8698; flex: 0 0 auto; }
.actions .row label.ck { display: inline-flex; align-items: center; gap: 4px; }
.actions .row .btn { flex: 0 0 auto; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .head-ops { flex-wrap: wrap; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
}
</style>
