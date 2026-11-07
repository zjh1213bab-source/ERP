<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>客户信用与账期</h2>
        <p class="sub">
          盯住<b>「还能不能再赊」</b>这一个问题。敞口 = 已开票未收 + 未开票订单余额
          （含<b>货已发出但票没开</b>的那部分 —— 账上最容易漏的就是它）。
          发货那一刻判定：超额度、逾期超过宽限期、客户被冻结，一律拦下，办放行单才能发。
          <b>额度填 0 = 不管理</b>，不是零额度；真要零额度请填 1 元。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openCfg">参数</button>
        <button v-action="['credit','export']" class="btn btn-ghost" @click="doExport">导出 CSV</button>
      </div>
    </div>

    <div class="cards c5">
      <div class="stat-card accent">
        <div class="label">已授信敞口</div>
        <div class="value">{{ money(summary.exposure_managed) }}<small>元</small></div>
        <div class="foot">额度合计 {{ money(summary.limit) }}</div>
      </div>
      <div class="stat-card" :class="{ danger: summary.over }">
        <div class="label">超额度客户</div>
        <div class="value" :style="{ color: summary.over ? '#d92d45' : '#16305f' }">
          {{ summary.over || 0 }}<small>家</small>
        </div>
        <div class="foot">已冻结 {{ summary.held || 0 }} 家</div>
      </div>
      <div class="stat-card" :class="{ danger: summary.overdue }">
        <div class="label">逾期未收</div>
        <div class="value" :style="{ color: summary.overdue_amount ? '#d92d45' : '#16305f' }">
          {{ money(summary.overdue_amount) }}<small>元</small>
        </div>
        <div class="foot">涉及 {{ summary.overdue || 0 }} 家</div>
      </div>
      <div class="stat-card">
        <div class="label">接近上限</div>
        <div class="value" :style="{ color: summary.near ? '#d97706' : '#16305f' }">
          {{ summary.near || 0 }}<small>家</small>
        </div>
        <div class="foot">占用 ≥ {{ Math.round((cfg.warn_ratio || 0.8) * 100) }}%</div>
      </div>
      <div class="stat-card">
        <div class="label">未设额度但有在途</div>
        <div class="value" :style="{ color: summary.shadow ? '#d97706' : '#16305f' }">
          {{ summary.shadow || 0 }}<small>家</small>
        </div>
        <div class="foot">共 {{ summary.customers }} 家客户 / 已授信 {{ summary.managed }}</div>
      </div>
    </div>

    <!-- 顶部提示：只说实话，不吓人 -->
    <div v-if="summary.over || summary.shadow" class="banner warn">
      <b>现在有 {{ summary.over }} 家超额度{{ summary.shadow ? `、${summary.shadow} 家没设额度却一直在赊` : '' }}</b>
      <span>
        超限的客户下次发货会被拦下。要么把额度调上去（写原因），要么让客户先回款，要么办放行单。
        没设额度的客户系统不拦 —— 但账面上等于没有授信，风险只能靠人盯。
      </span>
    </div>

    <div class="panel-card">
      <div class="toolbar">
        <input v-model="q" class="input" style="width: 220px" placeholder="客户名称 / 编号 / 业务员" @input="debouncedLoad" />
        <select v-model="risk" class="select" style="width: 150px" @change="load">
          <option value="">全部风险</option>
          <option value="hold">已冻结</option>
          <option value="over">超额度</option>
          <option value="overdue">有逾期</option>
          <option value="near">接近上限</option>
          <option value="ok">正常</option>
          <option value="unmanaged">未设额度</option>
        </select>
        <label class="chk"><input type="checkbox" v-model="onlyManaged" @change="load" /> 只看已设额度</label>
        <span class="spacer"></span>
        <span class="tiny muted">口径日 {{ board.as_of || '—' }}</span>
      </div>

      <div class="table-wrap" style="margin-top: 14px">
        <table class="data">
          <thead>
            <tr>
              <th>客户</th>
              <th class="num">信用额度</th>
              <th class="num">敞口</th>
              <th class="num">可用</th>
              <th style="min-width: 128px">占用</th>
              <th class="num">逾期</th>
              <th>风险</th>
              <th style="min-width: 168px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.customer.id">
              <td>
                <b>{{ r.customer.name }}</b>
                <div class="tiny muted">
                  {{ r.customer.code || '—' }}<template v-if="r.customer.owner_name"> · 业务员 {{ r.customer.owner_name }}</template>
                  · 账期 {{ r.customer.credit_days }} 天
                </div>
              </td>
              <td class="num">
                <template v-if="r.figures.limit > 0">{{ money(r.figures.limit) }}</template>
                <span v-else class="tiny muted">未设</span>
              </td>
              <td class="num">
                <b>{{ money(r.figures.exposure) }}</b>
                <div class="tiny muted">
                  票 {{ money(r.figures.billed_open) }} + 单 {{ money(r.figures.unbilled) }}
                </div>
              </td>
              <td class="num" :style="{ color: r.figures.available !== null && r.figures.available < 0 ? '#d92d45' : '' }">
                <template v-if="r.figures.available !== null">{{ money(r.figures.available) }}</template>
                <span v-else class="tiny muted">—</span>
              </td>
              <td>
                <div v-if="r.figures.usage_pct !== null" class="usage">
                  <div class="bar"><i :style="{ width: barWidth(r.figures.usage_pct), background: barColor(r.figures.usage_pct) }"></i></div>
                  <span class="pct" :style="{ color: barColor(r.figures.usage_pct) }">{{ r.figures.usage_pct }}%</span>
                </div>
                <span v-else class="tiny muted">—</span>
              </td>
              <td class="num" :style="{ color: r.figures.overdue ? '#d92d45' : '' }">
                <template v-if="r.figures.overdue">{{ money(r.figures.overdue) }}</template>
                <span v-else class="tiny muted">0</span>
                <div v-if="r.figures.max_overdue_days" class="tiny" style="color: #d92d45">
                  最长 {{ r.figures.max_overdue_days }} 天
                </div>
              </td>
              <td><span class="tag" :class="riskTag(r.risk)">{{ r.risk_label }}</span></td>
              <td class="ops">
                <button class="link-btn" @click="openDetail(r.customer.id)">明细</button>
                <button v-if="canWrite" class="link-btn" @click="openLimit(r)">调额</button>
                <button v-if="canWrite && r.customer.credit_status === 'hold'" class="link-btn warn-text" @click="openHold(r, 'release')">解冻</button>
                <button v-if="canWrite && r.customer.credit_status !== 'hold'" class="link-btn warn-text" @click="openHold(r, 'hold')">冻结</button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="8" class="empty">没有符合条件的客户</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 客户明细 ================= -->
    <div v-if="detail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ detail.customer.name }} · 信用明细</h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="dgrid">
            <div><label>信用额度</label><b>{{ detail.figures.limit > 0 ? money(detail.figures.limit) : '未设（不管理）' }}</b></div>
            <div><label>账期</label><b>{{ detail.customer.credit_days }} 天</b></div>
            <div><label>敞口合计</label><b>{{ money(detail.figures.exposure) }}</b></div>
            <div><label>可用额度</label>
              <b :style="{ color: detail.figures.available !== null && detail.figures.available < 0 ? '#d92d45' : '' }">
                {{ detail.figures.available === null ? '—' : money(detail.figures.available) }}
              </b>
            </div>
            <div><label>已开票未收</label><b>{{ money(detail.figures.billed_open) }}</b></div>
            <div><label>未开票订单</label><b>{{ money(detail.figures.unbilled) }}</b></div>
            <div><label>其中货已发未开票</label>
              <b :style="{ color: detail.figures.shipped_unbilled ? '#d97706' : '' }">{{ money(detail.figures.shipped_unbilled) }}</b>
            </div>
            <div><label>逾期</label>
              <b :style="{ color: detail.figures.overdue ? '#d92d45' : '' }">
                {{ money(detail.figures.overdue) }}<template v-if="detail.figures.max_overdue_days"> · 最长 {{ detail.figures.max_overdue_days }} 天</template>
              </b>
            </div>
          </div>

          <h4 class="sec">已开票未收（{{ (detail.invoices || []).length }} 张）</h4>
          <div class="table-wrap">
            <table class="data sm">
              <thead>
                <tr><th>发票号</th><th>开票日</th><th>到期日</th><th class="num">金额</th><th class="num">已收</th><th class="num">未收</th><th>状态</th></tr>
              </thead>
              <tbody>
                <tr v-for="v in detail.invoices" :key="v.id">
                  <td class="mono tiny">{{ v.bill_no }}</td>
                  <td class="tiny">{{ v.bill_date }}</td>
                  <td class="tiny">
                    {{ v.due_date }}
                    <i v-if="v.due_estimated" class="tiny muted" title="开票时没填到期日，按客户账期算的">（推算）</i>
                  </td>
                  <td class="num">{{ money(v.amount) }}</td>
                  <td class="num">{{ money(v.paid_amount) }}</td>
                  <td class="num strong">{{ money(v.open_amount) }}</td>
                  <td>
                    <span v-if="v.is_overdue" class="tag red">逾期 {{ v.overdue_days }} 天</span>
                    <span v-else class="tag gray">未到期</span>
                  </td>
                </tr>
                <tr v-if="!(detail.invoices || []).length"><td colspan="7" class="empty">没有未收发票</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec">未开票订单（{{ (detail.orders || []).length }} 张，合计 {{ money(detail.figures.unbilled) }}）</h4>
          <div class="table-wrap">
            <table class="data sm">
              <thead>
                <tr><th>订单号</th><th>状态</th><th class="num">订单金额</th><th class="num">已开票</th><th class="num">未开票余额</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="o in detail.orders" :key="o.id">
                  <td class="mono tiny">{{ o.order_no }}</td>
                  <td class="tiny">{{ statusLabel(o.status) }}</td>
                  <td class="num">{{ money(o.total_amount) }}</td>
                  <td class="num">{{ money(o.invoiced) }}</td>
                  <td class="num strong">{{ money(o.unbilled) }}</td>
                  <td>
                    <span v-if="o.shipped_unbilled" class="tag orange">货已发 · 票未开</span>
                  </td>
                </tr>
                <tr v-if="!(detail.orders || []).length"><td colspan="6" class="empty">没有在途订单</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec">变更记录</h4>
          <div class="events">
            <div v-for="(e, i) in detail.events" :key="i" class="ev">
              <span class="tag" :class="e.kind === 'hold' ? 'red' : e.kind === 'release' ? 'green' : e.kind === 'override' ? 'orange' : 'blue'">
                {{ e.kind === 'hold' ? '冻结' : e.kind === 'release' ? '解冻' : e.kind === 'override' ? '放行' : '调额' }}
              </span>
              <div class="ev-main">
                <b>{{ e.title }}</b>
                <div class="tiny muted">{{ e.reason }}{{ e.operator ? ' · ' + e.operator : '' }} · {{ $fmt(e.at) }}</div>
              </div>
            </div>
            <div v-if="!detail.events || !detail.events.length" class="empty">还没有变更记录</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 调额度 ================= -->
    <div v-if="limitForm.open" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>调整信用 · {{ limitForm.name }}</h3>
          <button class="x" @click="limitForm.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="frow">
            <label>信用额度（元）</label>
            <input v-model.number="limitForm.credit_limit" class="input" type="number" min="0" step="1000" />
            <p class="tiny muted">
              当前 {{ money(limitForm.old_limit) }}。填 <b>0 = 不管理</b>（系统不拦）；
              要「零额度、一分不许赊」请填 1。
            </p>
          </div>
          <div class="frow">
            <label>账期（天）</label>
            <input v-model.number="limitForm.credit_days" class="input" type="number" min="0" max="365" />
            <p class="tiny muted">开票时没填到期日的，按「开票日 + 账期」推算 —— 空着等于永不到期，系统不允许。</p>
          </div>
          <div class="frow">
            <label>变更原因（必填，≥4 字）</label>
            <input v-model="limitForm.reason" class="input" placeholder="例如：客户追加 50 万授信，已签担保函" />
          </div>
          <div v-if="limitPreview" class="preview">
            <span :class="limitPreview.over ? 'red' : 'green'">
              {{ limitPreview.over ? `调完仍超额 ${money(limitPreview.over)}` : `调完可用 ${money(limitPreview.available)}` }}
            </span>
            <span class="tiny muted">（按当前敞口 {{ money(limitPreview.exposure) }} 算）</span>
          </div>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="limitForm.open = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="saveLimit">保存</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 冻结 / 解冻 ================= -->
    <div v-if="holdForm.open" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ holdForm.action === 'hold' ? '冻结信用' : '解除冻结' }} · {{ holdForm.name }}</h3>
          <button class="x" @click="holdForm.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="banner" :class="holdForm.action === 'hold' ? 'warn' : 'ok'">
            <b>{{ holdForm.action === 'hold' ? '冻结后这家客户一律不许发货' : '解冻后按正常额度规则判定' }}</b>
            <span v-if="holdForm.action === 'hold'">
              不需要等到超限才冻 —— 听到风声、出事、老板一个电话，都可以先冻再核。
              当前敞口 {{ money(holdForm.exposure) }}。
            </span>
            <span v-else>
              解冻前确认：欠款是否清、争议是否谈完。解冻只是恢复判定，不会自动放宽额度。
            </span>
          </div>
          <div class="frow">
            <label>原因（必填，≥4 字）</label>
            <input v-model="holdForm.reason" class="input" :placeholder="holdForm.action === 'hold' ? '例如：客户所在国出现外汇管制传闻' : '例如：欠款已结清，财务确认解除'" />
          </div>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="holdForm.open = false">取消</button>
            <button class="btn" :class="holdForm.action === 'hold' ? 'btn-danger' : 'btn-primary'" :disabled="busy" @click="saveHold">
              {{ holdForm.action === 'hold' ? '确认冻结' : '确认解冻' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 参数 ================= -->
    <div v-if="cfgOpen" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>判定参数</h3>
          <button class="x" @click="cfgOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="frow">
            <label>逾期宽限期（天）</label>
            <input v-model.number="cfgForm.grace_days" class="input" type="number" min="0" max="90" />
            <p class="tiny muted">逾期在这个天数以内只警告不拦。设 0 = 一天都不宽限。客户财务走流程本来要几天，全按 0 会让业务没法干活。</p>
          </div>
          <div class="frow">
            <label>预警线（占用比例 %）</label>
            <input v-model.number="cfgForm.warn_ratio_pct" class="input" type="number" min="10" max="100" />
            <p class="tiny muted">占用到这个比例就标「接近上限」，提前让人去催款。</p>
          </div>
          <div class="frow">
            <label>默认账期（天）</label>
            <input v-model.number="cfgForm.default_days" class="input" type="number" min="0" max="365" />
            <p class="tiny muted">客户没单独设账期时用这个值推算到期日。</p>
          </div>
          <div class="form-foot">
            <button class="btn btn-ghost" @click="cfgOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="saveCfg">保存</button>
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

const rows = ref([]);
const board = ref({ summary: {}, config: {}, rows: [], as_of: '' });
const q = ref('');
const risk = ref('');
const onlyManaged = ref(false);
const busy = ref(false);
const detail = ref(null);
const cfgOpen = ref(false);
const cfgForm = reactive({ grace_days: 7, warn_ratio_pct: 80, default_days: 30 });

const limitForm = reactive({ open: false, id: null, name: '', credit_limit: 0, credit_days: 30, reason: '', old_limit: 0, exposure: 0 });
const holdForm = reactive({ open: false, id: null, name: '', action: 'hold', reason: '', exposure: 0 });

const summary = computed(() => board.value.summary || {});
const cfg = computed(() => board.value.config || {});

const canWrite = computed(() => can('credit.write'));

const STATUS_LABEL = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};
function statusLabel(s) { return STATUS_LABEL[s] || s || '—'; }

const money = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function riskTag(r) {
  return { hold: 'red', over: 'red', overdue: 'orange', near: 'orange', unmanaged: 'gray', ok: 'green' }[r] || 'gray';
}
function barColor(pct) {
  if (pct >= 100) return '#d92d45';
  if (pct >= 80) return '#d97706';
  return '#2b6de5';
}
function barWidth(pct) {
  // 超过 100% 也画满，但颜色变红 —— 条画到 130% 会溢出格子
  return Math.min(100, Math.max(2, Number(pct) || 0)) + '%';
}

// 调额预览：改之前就能看到「调完还差多少」，不必保存了才发现不够
const limitPreview = computed(() => {
  if (!limitForm.open) return null;
  const lim = Number(limitForm.credit_limit) || 0;
  const exp = Number(limitForm.exposure) || 0;
  if (lim <= 0) return { over: 0, available: null, exposure: exp, unmanaged: true };
  const avail = Math.round((lim - exp) * 100) / 100;
  return { over: avail < 0 ? -avail : 0, available: avail < 0 ? 0 : avail, exposure: exp };
});

let timer = null;
function debouncedLoad() {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
}

async function load() {
  try {
    const d = await api.creditBoard({
      q: q.value || undefined,
      risk: risk.value || undefined,
      only_managed: onlyManaged.value ? 1 : undefined
    });
    board.value = d;
    rows.value = d.rows || [];
  } catch (e) {
    alert(e.message);
  }
}

async function reload() {
  await load();
  if (detail.value) await openDetail(detail.value.customer.id);
}

async function openDetail(customerId) {
  try {
    detail.value = await api.creditDetail(customerId);
  } catch (e) {
    alert(e.message);
  }
}

function openLimit(r) {
  limitForm.open = true;
  limitForm.id = r.customer.id;
  limitForm.name = r.customer.name;
  limitForm.credit_limit = r.figures.limit;
  limitForm.credit_days = r.customer.credit_days;
  limitForm.reason = '';
  limitForm.old_limit = r.figures.limit;
  limitForm.exposure = r.figures.exposure;
}

async function saveLimit() {
  if (String(limitForm.reason || '').trim().length < 4) return alert('请写原因（至少 4 个字），以后要能解释给审计听');
  busy.value = true;
  try {
    await api.creditSetLimit(limitForm.id, {
      credit_limit: limitForm.credit_limit,
      credit_days: limitForm.credit_days,
      reason: limitForm.reason
    });
    limitForm.open = false;
    await reload();
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function openHold(r, action) {
  holdForm.open = true;
  holdForm.id = r.customer.id;
  holdForm.name = r.customer.name;
  holdForm.action = action;
  holdForm.reason = '';
  holdForm.exposure = r.figures.exposure;
}

async function saveHold() {
  if (String(holdForm.reason || '').trim().length < 4) return alert('请写原因（至少 4 个字）');
  busy.value = true;
  try {
    await api.creditHold(holdForm.id, { action: holdForm.action, reason: holdForm.reason });
    holdForm.open = false;
    await reload();
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function openCfg() {
  cfgForm.grace_days = Number(cfg.value.grace_days) || 0;
  cfgForm.warn_ratio_pct = Math.round((Number(cfg.value.warn_ratio) || 0.8) * 100);
  cfgForm.default_days = Number(cfg.value.default_days) || 30;
  cfgOpen.value = true;
}

async function saveCfg() {
  busy.value = true;
  try {
    await api.creditSaveConfig({
      grace_days: cfgForm.grace_days,
      warn_ratio: (Number(cfgForm.warn_ratio_pct) || 80) / 100,
      default_days: cfgForm.default_days
    });
    cfgOpen.value = false;
    await reload();
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function doExport() {
  downloadFile(
    api.creditExportPath({
      q: q.value || undefined,
      risk: risk.value || undefined,
      only_managed: onlyManaged.value ? 1 : undefined
    })
  );
}

onMounted(load);
</script>

<style scoped>
.cards.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.stat-card .foot { margin-top: 8px; font-size: 12px; color: var(--ink-mute); }
.stat-card.danger { border-color: #f6c9d0; background: #fffafb; }
.cards.c5 .stat-card .value { font-size: 24px; }

/* 提示条 */
.reason-list { margin: 6px 0 0; padding-left: 18px; }
/* 标题与说明分两行：挤在一行读起来像一句没断句的话 */
.banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: 13px; line-height: 1.7; border: 1px solid transparent; }
.banner b { font-weight: 700; }
.banner.warn { background: #fff8ec; border-color: #f3ddb5; color: #8a5a12; }
.banner.ok { background: #eefaf1; border-color: #c7ecd4; color: #17683a; }

/* 表格挤压时 flex 子项会被压到 0 宽，进度条直接消失 —— 给个下限保住它 */
.usage { display: flex; align-items: center; gap: 8px; min-width: 108px; }
.usage .bar { flex: 1 1 auto; min-width: 52px; height: 6px; border-radius: 4px; background: #eef1f6; overflow: hidden; }
.usage .bar i { display: block; height: 100%; border-radius: 4px; }
.usage .pct { font-size: 12px; font-weight: 700; min-width: 40px; text-align: right; }

.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-soft); }
.warn-text { color: #d97706 !important; }
.strong { font-weight: 700; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }

.dgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px 18px; padding: 4px 0 12px; }
.dgrid label { display: block; font-size: 12px; color: var(--ink-mute); margin-bottom: 4px; }
.dgrid b { font-size: 15px; color: var(--ink); }
.sec { margin: 18px 0 8px; font-size: 13.5px; color: var(--ink); }
.events { display: flex; flex-direction: column; gap: 10px; }
.ev { display: flex; gap: 10px; align-items: flex-start; }
.ev-main b { font-size: 13px; color: var(--ink); font-weight: 600; }

.frow { margin-bottom: 14px; }
.frow label { display: block; font-size: 12.5px; color: var(--ink-soft); margin-bottom: 5px; }
.frow .tiny { margin: 6px 0 0; }
.preview { padding: 10px 12px; border-radius: 10px; background: #f6f8fc; font-size: 13px; margin-bottom: 8px; }
.preview .red { color: #d92d45; font-weight: 700; }
.preview .green { color: #16a34a; font-weight: 700; }
.form-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }

/* 金额一律不换行：843,591.65 断成两行会让人误读成两个数 */
.data td.num, .data th.num { white-space: nowrap; }
/* 客户名 + 编号/账期两行小字，列太窄会挤成三行 */
.data td:first-child { min-width: 172px; }
/* 「明细 调额 解冻」三个按钮贴在一起，看着像一个词 */
.ops .link-btn + .link-btn { margin-left: 10px; }
/* 按钮和风险标签都不许折行：「超额度」被拆成「超额/度」像打错了字 */
.ops { white-space: nowrap; }
.data .tag { white-space: nowrap; }

@media (max-width: 900px) {
  .cards.c5 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .dgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
