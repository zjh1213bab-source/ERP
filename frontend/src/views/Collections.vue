<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>应收催收</h2>
        <p class="sub">
          把「谁欠、多久、谁去催、客户答应哪天付」放到一处。任务按<b>客户</b>建（业务员是跟客户谈的，不是跟发票谈），
          剩余额<b>每次打开都从发票重算</b>；钱收齐后<b>自动结案</b>，不用人去点。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button class="btn btn-ghost" @click="doExport">导出 CSV</button>
        <button class="btn btn-ghost" @click="openBoard">逾期台账</button>
        <button v-if="canClose" class="btn btn-primary" @click="genAll">一键生成催收单</button>
      </div>
    </div>

    <div class="cards c5">
      <div class="stat-card accent">
        <div class="label">在催金额</div>
        <div class="value">{{ money(stats.active_amount) }}<small>元</small></div>
        <div class="foot">{{ stats.active_count }} 张任务在跟</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.promised.count }">
        <div class="label">客户已承诺</div>
        <div class="value" :style="{ color: stats.promised.count ? '#d97706' : '#16305f' }">
          {{ stats.promised.count }}<small>张</small>
        </div>
        <div class="foot">{{ money(stats.promised.amount) }} 元 · 等承诺日</div>
      </div>
      <div class="stat-card" :class="{ danger: stats.broken_count }">
        <div class="label">承诺跳票</div>
        <div class="value" :style="{ color: stats.broken_count ? '#d92d45' : '#16305f' }">
          {{ stats.broken_count }}<small>张</small>
        </div>
        <div class="foot">{{ money(stats.broken_amount) }} 元 · 答应过但没付</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.no_owner_count }">
        <div class="label">无人负责</div>
        <div class="value" :style="{ color: stats.no_owner_count ? '#d97706' : '#16305f' }">
          {{ stats.no_owner_count }}<small>张</small>
        </div>
        <div class="foot">解析不到业务员，需指派</div>
      </div>
      <div class="stat-card">
        <div class="label">已结案</div>
        <div class="value">{{ stats.closed.count }}<small>张</small></div>
        <div class="foot">{{ money(stats.closed.amount) }} 元已收 / 核销</div>
      </div>
    </div>

    <div class="panel-card">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === '' }" @click="setTab('')">未结</button>
          <button :class="{ on: tab === 'open' }" @click="setTab('open')">待跟进</button>
          <button :class="{ on: tab === 'following' }" @click="setTab('following')">已联系</button>
          <button :class="{ on: tab === 'promised' }" @click="setTab('promised')">已承诺</button>
          <button :class="{ on: tab === 'escalated' }" @click="setTab('escalated')">承诺跳票</button>
          <button :class="{ on: tab === 'closed' }" @click="setTab('closed')">已结案</button>
        </div>
        <label class="chk"><input type="checkbox" v-model="onlyMine" @change="load" />只看我的</label>
        <input v-model="q" class="input" style="width: 190px" placeholder="任务号 / 客户 / 负责人" @keyup.enter="load" />
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="min-width: 160px">任务号 / 客户</th>
              <th style="min-width: 120px">负责人</th>
              <th style="width: 84px">等级</th>
              <th style="width: 96px">状态</th>
              <th class="num" style="min-width: 108px">逾期金额</th>
              <th class="num" style="min-width: 104px">剩余未收</th>
              <th style="min-width: 120px">回收进度</th>
              <th style="min-width: 104px">承诺</th>
              <th class="num" style="width: 62px">跟进</th>
              <th style="min-width: 150px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" :class="{ 'row-hot': r.status === 'escalated' }">
              <td>
                <button class="link-btn mono" @click="openDetail(r.id)">{{ r.task_no }}</button>
                <div class="cust" :title="r.customer_name">{{ r.customer_name }}</div>
              </td>
              <td class="tiny">
                <template v-if="r.owner_name">{{ r.owner_name }}</template>
                <span v-else class="tag orange">待指派</span>
                <div class="tiny muted">{{ ownerSourceLabel(r.owner_source) }}</div>
              </td>
              <td><span class="tag" :class="levelClass(r.level)">{{ r.level_label }}</span></td>
              <td><span class="tag" :class="statusClass(r.status)">{{ r.status_label }}</span></td>
              <td class="num">{{ money(r.overdue_amount) }}</td>
              <td class="num strong">{{ money(r.remaining) }}</td>
              <td>
                <div class="bar-line">
                  <div class="bar"><i :style="{ width: Math.min(100, r.recover_rate) + '%' }"></i></div>
                  <span class="pct">{{ r.recover_rate }}%</span>
                </div>
                <div class="tiny muted">已收 {{ money(r.recovered) }}</div>
              </td>
              <td class="tiny nowrap">
                <template v-if="r.promise_date">
                  {{ r.promise_date }}
                  <div v-if="r.promise_late" class="tiny" style="color: #d92d45">
                    跳票 {{ r.promise_late_days }} 天
                  </div>
                  <div v-else class="tiny muted">¥{{ money(r.promise_amount) }}</div>
                </template>
                <span v-else class="muted">—</span>
              </td>
              <td class="num">{{ r.follow_count }}</td>
              <td class="ops">
                <button class="link-btn" @click="openDetail(r.id)">跟进</button>
                <button v-if="canClose && !r.owner_name" class="link-btn" @click="openAssign(r)">指派</button>
                <button v-if="canClose && r.status !== 'closed'" class="link-btn" @click="openClose(r)">结案</button>
                <button v-if="canClose && r.status === 'closed'" class="link-btn" @click="doReopen(r)">重开</button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="10" class="empty">没有符合条件的催收任务</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 逾期台账 ================= -->
    <div v-if="boardOpen" class="modal-mask" @click.self="boardOpen = false">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>逾期台账（还没派单的）</h3>
          <button class="x" @click="boardOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="banner info">
            <b>外部逾期 {{ money(board.summary.external_amount) }}，还有 {{ board.summary.untasked_count }} 家在裸奔</b>
            <span>
              集团内部往来（{{ money(board.summary.internal_amount) }}，{{ board.summary.internal_count }} 家）<b>不催收</b> ——
              给自家公司发催收单没意义，而且会把逾期总额虚高。判断依据是内部往来台账，不是名字里有没有「集团」。
            </span>
          </div>
          <div class="table-wrap" style="max-height: 420px; overflow-y: auto">
            <table class="data sm">
              <thead>
                <tr>
                  <th style="min-width: 180px">客户</th>
                  <th class="num">逾期金额</th>
                  <th class="num">发票</th>
                  <th class="num">最长逾期</th>
                  <th>等级</th>
                  <th>负责人</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in board.rows" :key="b.customer_id" :class="{ 'row-off': b.is_internal }">
                  <td>
                    <div class="cust-wrap">
                      <span class="ellip" :title="b.customer_name">{{ b.customer_name }}</span>
                      <!-- 「集团内部」不能跟客户名一起被省略号吃掉 —— 它决定这行催不催 -->
                      <span v-if="b.is_internal" class="tag gray">集团内部</span>
                    </div>
                  </td>
                  <td class="num strong">{{ money(b.overdue_amount) }}</td>
                  <td class="num">{{ b.invoice_count }}</td>
                  <td class="num">{{ b.max_overdue_days }} 天</td>
                  <td><span class="tag" :class="levelClass(b.level)">{{ b.level }}</span></td>
                  <td class="tiny">
                    {{ b.owner.name || '—' }}
                    <div v-if="!b.owner.name" class="tiny muted">解析不到业务员</div>
                  </td>
                  <td class="tiny">
                    <span v-if="b.is_internal" class="muted">不催收</span>
                    <span v-else-if="b.has_task" class="tag blue">{{ b.task.task_no }}</span>
                    <span v-else class="tag orange">未派单</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="boardOpen = false">关闭</button>
            <button v-if="canClose" class="btn btn-primary" @click="genAll">给所有未派单的生成</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 详情 / 跟进 ================= -->
    <div v-if="cur" class="modal-mask" @click.self="cur = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>
            {{ cur.task_no }}
            <span class="tag" :class="statusClass(cur.status)" style="margin-left: 8px">{{ cur.status_label }}</span>
            <!-- 状态标签已经是「承诺跳票」了，这里只补天数，别把四个字重复一遍 -->
            <span v-if="cur.live.promise_broken" class="tag red" style="margin-left: 6px">
              跳票 {{ cur.live.promise_overdue_days }} 天
            </span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <div class="dgrid">
            <div><span>客户</span><b>{{ cur.customer_name }}</b></div>
            <div><span>负责人</span><b>{{ cur.owner_name || '待指派' }}</b></div>
            <div><span>逾期金额（生成时）</span><b>¥{{ money(cur.overdue_amount) }}</b></div>
            <div><span>剩余未收（实时）</span><b class="big">¥{{ money(cur.live.remaining) }}</b></div>
            <div><span>等级</span><b>{{ cur.level_label }}</b></div>
            <div><span>最长逾期</span><b>{{ cur.max_overdue_days }} 天</b></div>
            <div><span>承诺日期</span><b>{{ cur.promise_date || '—' }}</b></div>
            <div><span>承诺金额</span><b>{{ cur.promise_amount ? '¥' + money(cur.promise_amount) : '—' }}</b></div>
          </div>

          <div v-if="cur.status === 'closed'" class="banner ok">
            <b>已结案：{{ cur.closed_reason_label }}</b>
            <span>{{ cur.closed_note || '（无说明）' }} · {{ cur.closed_by }} {{ $fmt(cur.closed_at) }}</span>
          </div>

          <!-- 记一次跟进 -->
          <div v-if="cur.status !== 'closed'" class="sec form-sec">
            <h4>记一次跟进</h4>
            <div class="frow">
              <label class="fld">
                <span>渠道</span>
                <select v-model="logForm.channel" class="select">
                  <option v-for="c in meta.channels" :key="c.code" :value="c.code">{{ c.label }}</option>
                </select>
              </label>
              <label class="fld">
                <span>结果</span>
                <select v-model="logForm.result" class="select">
                  <option v-for="x in meta.results" :key="x.code" :value="x.code">{{ x.label }}</option>
                </select>
              </label>
              <label class="fld">
                <span>对接人</span>
                <input v-model="logForm.contact" class="input" placeholder="客户那边的谁" />
              </label>
              <label class="fld">
                <span>承诺日期 {{ logForm.result === 'promised' ? '*' : '' }}</span>
                <input
                  v-model="logForm.promise_date"
                  type="date"
                  class="input"
                  :disabled="logForm.result !== 'promised'"
                />
              </label>
              <label class="fld">
                <span>承诺金额 {{ logForm.result === 'promised' ? '*' : '' }}</span>
                <input
                  v-model.number="logForm.promise_amount"
                  type="number"
                  class="input"
                  :disabled="logForm.result !== 'promised'"
                  :placeholder="logForm.result === 'promised' ? '金额' : ''"
                />
              </label>
            </div>
            <label class="fld block">
              <span>沟通记录{{ logForm.result === 'refused' || logForm.result === 'dispute' ? '（必填）' : '' }}</span>
              <input
                v-model="logForm.note"
                class="input"
                placeholder="例如：采购 Steve 确认本月 5 号前付清；或：对方称验收单未盖章，需补"
              />
            </label>
            <div class="log-foot">
              <span class="tiny muted">
                「答应付款」必须同时填<b>日期</b>和<b>金额</b> —— 只说「下周付」没法验证，下周就忘了。
              </span>
              <button class="btn btn-primary" :disabled="busy" @click="doLog">保存跟进</button>
            </div>
          </div>

          <!-- 发票 -->
          <div class="sec">
            <h4>挂着的发票（{{ cur.live.invoice_count }} 张，已收 {{ cur.live.settled_count }} 张）</h4>
            <table class="data sm">
              <thead>
                <tr>
                  <th>发票号</th><th>到期日</th>
                  <th class="num">挂单时未付</th><th class="num">现在未付</th>
                  <th class="num">逾期</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in cur.items" :key="it.id">
                  <td class="mono tiny">{{ it.bill_no }}</td>
                  <td class="tiny">{{ it.due_date || '—' }}</td>
                  <td class="num">{{ money(it.open_at_create) }}</td>
                  <td class="num strong">{{ money(it.open_now) }}</td>
                  <td class="num tiny">{{ it.overdue_days }} 天</td>
                  <td>
                    <span v-if="it.settled" class="tag green">已结清</span>
                    <span v-else-if="it.invoice_status === 'void'" class="tag gray">已作废</span>
                    <span v-else class="tag orange">未收</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 跟进记录 -->
          <div class="sec">
            <h4>跟进记录（{{ cur.logs.length }} 条）</h4>
            <div v-if="!cur.logs.length" class="tiny muted">还没有记录。第一次联系后在这里记一笔 —— 换人接手时才知道聊到哪了。</div>
            <div class="timeline">
              <div v-for="lg in cur.logs" :key="lg.id" class="tl-item">
                <div class="tl-dot" :class="lg.result"></div>
                <div class="tl-body">
                  <div class="tl-head">
                    <b>{{ lg.channel_label }}</b>
                    <span class="tag" :class="resultClass(lg.result)">{{ lg.result_label }}</span>
                    <span v-if="lg.contact" class="tiny muted">对接 {{ lg.contact }}</span>
                    <span class="spacer"></span>
                    <span class="tiny muted">{{ lg.operator }} · {{ $fmt(lg.created_at) }}</span>
                  </div>
                  <div v-if="lg.promise_date" class="tiny">
                    承诺 <b>{{ lg.promise_date }}</b> 付 <b>¥{{ money(lg.promise_amount) }}</b>
                  </div>
                  <div v-if="lg.note" class="tl-note">{{ lg.note }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="form-foot">
            <button class="btn btn-ghost" @click="cur = null">关闭</button>
            <button v-if="canClose && cur.status !== 'closed'" class="btn btn-ghost" @click="openClose(cur)">结案</button>
            <button v-if="canClose && !cur.owner_name && cur.status !== 'closed'" class="btn btn-primary" @click="openAssign(cur)">
              指派负责人
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 指派 ================= -->
    <div v-if="assignTarget" class="modal-mask" @click.self="assignTarget = null">
      <div class="modal">
        <div class="modal-head">
          <h3>指派负责人</h3>
          <button class="x" @click="assignTarget = null">×</button>
        </div>
        <div class="modal-body">
          <div class="banner warn">
            <b>这张单现在没人负责</b>
            <span>
              客户档案没填业务员，订单里也没有跟单员。系统<b>不按「谁最近碰过这单」猜</b> ——
              分错人的后果是「有人以为别人在催」，最后谁都没催。请明确指定。
            </span>
          </div>
          <label class="fld block">
            <span>指派给</span>
            <select v-model="assignForm.username" class="select">
              <option value="">请选择</option>
              <option v-for="o in meta.owners" :key="o.username" :value="o.username">
                {{ o.name }}（{{ o.username }}）
              </option>
            </select>
          </label>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="assignTarget = null">取消</button>
            <button class="btn btn-primary" :disabled="busy || !assignForm.username" @click="doAssign">确定</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 结案 ================= -->
    <div v-if="closeTarget" class="modal-mask" @click.self="closeTarget = null">
      <div class="modal">
        <div class="modal-head">
          <h3>结案</h3>
          <button class="x" @click="closeTarget = null">×</button>
        </div>
        <div class="modal-body">
          <div class="banner warn">
            <b>还有 ¥{{ money(closeTarget.remaining) }} 没收回</b>
            <span>
              钱收齐了系统会<b>自动结案</b>，不用在这里点。手动结案只适用于坏账、转法务、协议对冲这类
              —— 结完这张单就不再催了，请写清依据。
            </span>
          </div>
          <label class="fld block">
            <span>结案原因</span>
            <select v-model="closeForm.reason" class="select">
              <option v-for="x in meta.close_reasons" :key="x.code" :value="x.code">{{ x.label }}</option>
            </select>
          </label>
          <label class="fld block">
            <span>说明 {{ closeForm.reason === 'bad_debt' ? '（核销坏账至少 8 个字）' : '' }}</span>
            <input
              v-model="closeForm.note"
              class="input"
              placeholder="例如：客户已停业，律师函三次无回应，坏账审批单 BD-26-03"
            />
          </label>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="closeTarget = null">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doClose">确认结案</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('collection.write'));
const canClose = computed(() => can('collection.close'));

const money = (v) => (Number(v) || 0).toFixed(2);

const rows = ref([]);
const stats = ref({
  open: { count: 0, amount: 0 },
  following: { count: 0, amount: 0 },
  promised: { count: 0, amount: 0 },
  escalated: { count: 0, amount: 0 },
  closed: { count: 0, amount: 0 },
  active_count: 0,
  active_amount: 0,
  no_owner_count: 0,
  broken_count: 0,
  broken_amount: 0
});
const meta = ref({ channels: [], results: [], close_reasons: [], owners: [], statuses: [], levels: [] });
const tab = ref('');
const q = ref('');
const onlyMine = ref(false);
const busy = ref(false);

const board = ref({ rows: [], summary: {} });
const boardOpen = ref(false);
const cur = ref(null);
const assignTarget = ref(null);
const closeTarget = ref(null);
const assignForm = reactive({ username: '' });
const closeForm = reactive({ reason: 'bad_debt', note: '' });
const logForm = reactive({
  channel: 'wechat',
  result: 'promised',
  contact: '',
  promise_date: '',
  promise_amount: null,
  note: ''
});

async function load() {
  try {
    const params = {};
    if (tab.value) params.status = tab.value;
    if (q.value) params.q = q.value;
    if (onlyMine.value) params.owner = 'me';
    // 「只看我的」交给后端按登录人过滤（销售本来就是强制只看自己）
    if (onlyMine.value) delete params.owner;
    const d = await api.colList(params);
    rows.value = onlyMine.value
      ? (d.rows || []).filter((r) => r.owner_username === currentUsername())
      : d.rows;
    stats.value = d.summary;
  } catch (e) {
    alert(e.message);
  }
}
/** 从 localStorage 取当前账号（「只看我的」在前端过滤，避免再加一个后端参数） */
function currentUsername() {
  try {
    return (JSON.parse(localStorage.getItem('erp_user') || '{}') || {}).username || '';
  } catch (e) {
    return '';
  }
}

function setTab(t) {
  tab.value = t;
  load();
}

async function reload() {
  busy.value = true;
  try {
    await Promise.all([load(), api.colMeta().then((d) => (meta.value = d))]);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function doExport() {
  const params = {};
  if (tab.value) params.status = tab.value;
  if (q.value) params.q = q.value;
  downloadFile(api.colExportPath(params));
}

function statusClass(s) {
  return { open: 'gray', following: 'blue', promised: 'orange', escalated: 'red', closed: 'green' }[s] || 'gray';
}
function levelClass(l) {
  return { D1: 'gray', D2: 'blue', D3: 'orange', D4: 'red' }[l] || 'gray';
}
function resultClass(r) {
  return { promised: 'green', refused: 'red', dispute: 'red', partial: 'blue', no_answer: 'gray' }[r] || 'gray';
}
function ownerSourceLabel(s) {
  return { profile: '客户档案', order: '订单跟单员', manual: '人工指派', none: '无归属' }[s] || '';
}

/* ---------------- 台账 / 生成 ---------------- */
async function openBoard() {
  boardOpen.value = true;
  try {
    board.value = await api.colBoard();
  } catch (e) {
    alert(e.message);
  }
}

async function genAll() {
  if (!confirm('给所有「逾期且还没派单」的外部客户生成催收任务？\n（集团内部往来会自动跳过；已有任务的不会重复建）')) return;
  busy.value = true;
  try {
    const r = await api.colGenerate({ all: true, min_overdue_days: 1 });
    await load();
    await api.colMeta().then((d) => (meta.value = d));
    if (boardOpen.value) board.value = await api.colBoard();
    const skipped = (r.skipped || []).map((x) => `${x.customer_name}：${x.reason}`);
    alert(
      `生成 ${r.summary.created} 张（${money(r.summary.amount)} 元）\n` +
        (skipped.length ? `跳过 ${skipped.length} 家：\n` + skipped.slice(0, 8).join('\n') : '')
    );
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

/* ---------------- 详情 / 跟进 ---------------- */
async function openDetail(id) {
  try {
    cur.value = await api.colDetail(id);
    logForm.channel = 'wechat';
    logForm.result = 'promised';
    logForm.contact = '';
    logForm.promise_date = '';
    logForm.promise_amount = null;
    logForm.note = '';
  } catch (e) {
    alert(e.message);
  }
}

async function doLog() {
  if (!cur.value) return;
  if (logForm.result === 'promised' && (!logForm.promise_date || !logForm.promise_amount)) {
    return alert('「答应付款」必须填承诺日期和承诺金额 —— 只说「下周付」没法验证');
  }
  busy.value = true;
  try {
    cur.value = await api.colLog(cur.value.id, { ...logForm });
    await load();
    await api.colMeta().then((d) => (meta.value = d));
    logForm.note = '';
    logForm.promise_date = '';
    logForm.promise_amount = null;
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

/* ---------------- 指派 ---------------- */
function openAssign(r) {
  assignTarget.value = r;
  assignForm.username = '';
}
async function doAssign() {
  if (!assignTarget.value) return;
  busy.value = true;
  try {
    await api.colAssign(assignTarget.value.id, { username: assignForm.username });
    assignTarget.value = null;
    await load();
    if (cur.value) cur.value = await api.colDetail(cur.value.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

/* ---------------- 结案 / 重开 ---------------- */
function openClose(r) {
  closeTarget.value = r;
  closeForm.reason = 'bad_debt';
  closeForm.note = '';
}
async function doClose() {
  if (!closeTarget.value) return;
  busy.value = true;
  try {
    await api.colClose(closeTarget.value.id, { ...closeForm });
    closeTarget.value = null;
    await load();
    await api.colMeta().then((d) => (meta.value = d));
    cur.value = null;
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doReopen(r) {
  const reason = prompt(`重新打开「${r.task_no}」。\n为什么重开？（至少 4 个字）`, '');
  if (reason === null) return;
  try {
    await api.colReopen(r.id, { reason });
    await load();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(reload);
</script>

<style scoped>
.cards.c5 {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
.cards.c5 .stat-card .foot {
  white-space: normal;
  line-height: 1.5;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tabs button {
  padding: 6px 14px;
  border: 1px solid #e2e8f2;
  background: #fff;
  border-radius: 8px;
  font-size: 12.5px;
  color: #4b5568;
  cursor: pointer;
}
.tabs button.on {
  background: #16305f;
  border-color: #16305f;
  color: #fff;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #4b5568;
}
.data td.num,
.data th.num {
  white-space: nowrap;
}
.data .tag {
  white-space: nowrap;
}
.cust {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: #33415a;
}
/* 名字可省略，标签不能省略：用 flex + min-width:0 只压名字 */
.cust-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 250px;
}
.cust-wrap .ellip {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cust-wrap .tag {
  flex: none;
}
.nowrap {
  white-space: nowrap;
}
.ops {
  white-space: nowrap;
}
.ops .link-btn + .link-btn {
  margin-left: 10px;
}
.row-hot td {
  background: #fff8f9;
}
.row-off td {
  opacity: 0.55;
}
/* 回收进度条：与信用台账一致的写法 */
.bar-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 108px;
}
.bar-line .bar {
  flex: 1 1 auto;
  min-width: 46px;
  height: 6px;
  border-radius: 4px;
  background: #eef1f6;
  overflow: hidden;
}
.bar-line .bar i {
  display: block;
  height: 100%;
  background: #16a34a;
  border-radius: 4px;
}
.bar-line .pct {
  font-size: 11.5px;
  color: #6b7688;
  flex: none;
}
/* 表单 */
.frow {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.fld.block {
  margin-top: 10px;
}
.fld > span {
  font-size: 12.5px;
  color: #6b7688;
}
.form-sec {
  padding: 14px 16px;
  border: 1px solid #eef2f7;
  border-radius: 12px;
  background: #fbfcfe;
}
.log-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.log-foot .tiny {
  flex: 1;
}
/* 详情 */
.dgrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px 16px;
  margin-bottom: 14px;
}
.dgrid > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dgrid span {
  font-size: 11.5px;
  color: #8a94a6;
}
.dgrid b {
  font-size: 13px;
  color: #16233b;
  font-weight: 600;
}
.dgrid b.big {
  font-size: 15px;
  color: #d92d45;
}
.sec {
  margin-top: 16px;
}
.sec h4 {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: #16233b;
  font-weight: 700;
}
/* 跟进时间线 */
.timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 260px;
  overflow-y: auto;
  padding-right: 4px;
}
.tl-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.tl-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 6px;
  background: #cbd5e1;
}
.tl-dot.promised {
  background: #16a34a;
}
.tl-dot.refused,
.tl-dot.dispute {
  background: #d92d45;
}
.tl-dot.partial {
  background: #2563eb;
}
.tl-body {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: #fbfcfe;
  border: 1px solid #eef2f7;
}
.tl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.tl-head .spacer {
  flex: 1;
}
.tl-note {
  margin-top: 5px;
  font-size: 12.5px;
  color: #4b5568;
  line-height: 1.65;
}
.banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  border-radius: 12px;
  margin-bottom: 14px;
  font-size: 13px;
  line-height: 1.7;
  border: 1px solid transparent;
}

@media (max-width: 900px) {
  .cards.c5 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .frow,
  .dgrid {
    grid-template-columns: 1fr;
  }
}
</style>
