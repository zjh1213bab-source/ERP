<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>薪酬计件与工资核对</h2>
        <p class="sub">
          只做一件事：<b>工资单里的计件数，能不能对回已确认的核算单</b>。
          应发、个税、实发都用同一份公式<b>独立重算</b>再和库里存的比 ——
          若直接读库里的应发，手工改过的单子永远「没问题」，核对就成了打印件。
          <b>差额不会自动改工资单</b>：要动钱必须登记调整单（下一期生效）并写原因。
          境外主体（本位币非 CNY）只核对金额来源，不套国内 5000 免征额与月度税率表。
        </p>
      </div>
      <div class="head-ops">
        <select v-model="period" class="select" style="width: 118px" @change="preview">
          <option v-for="p in meta.periods || []" :key="p" :value="p">{{ p }}</option>
        </select>
        <select v-model="companyId" class="select" style="width: 168px" @change="preview">
          <option :value="null">全部主体</option>
          <option v-for="c in meta.companies || []" :key="c.id" :value="c.id">{{ c.short_name || c.name }}</option>
        </select>
        <button class="btn btn-ghost" @click="preview">重新计算</button>
        <button v-if="canRun" class="btn btn-primary" @click="askRun">生成核对批次</button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card">
        <div class="label">核对人数</div>
        <div class="value">{{ s.items || 0 }}</div>
        <div class="foot">本期有计件或有工资单的人</div>
      </div>
      <div class="stat-card">
        <div class="label">一致</div>
        <div class="value green-t">{{ s.ok || 0 }}</div>
        <div class="foot">计件与应发都对得上</div>
      </div>
      <div class="stat-card" :class="{ warn: s.diff }">
        <div class="label">有差异</div>
        <div class="value red">{{ s.diff || 0 }}</div>
        <div class="foot">需登记调整单或写说明</div>
      </div>
      <div class="stat-card">
        <div class="label">政策待配</div>
        <div class="value">{{ s.policy || 0 }}</div>
        <div class="foot">境外主体，未套国内税</div>
      </div>
      <div class="stat-card" :class="{ warn: s.missing }">
        <div class="label">缺工资单</div>
        <div class="value">{{ s.missing || 0 }}</div>
        <div class="foot">有计件但没生成工资</div>
      </div>
      <div class="stat-card" :class="{ warn: s.piece_diff }">
        <div class="label">计件差额</div>
        <div class="value">¥{{ money(s.piece_diff) }}</div>
        <div class="foot">应计 ¥{{ money(s.piece_expected) }} / 工资单 ¥{{ money(s.piece_in_payroll) }}</div>
      </div>
    </div>

    <div v-if="(batch && batch.batch_issues) && batch.batch_issues.length" class="notice-warn">
      <b>批次数据本身有问题：</b>
      <div v-for="(x, i) in batch.batch_issues" :key="i">· {{ x.msg }}</div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'items' }" @click="tab = 'items'">核对明细（{{ rows.length }}）</button>
          <button :class="{ on: tab === 'runs' }" @click="tab = 'runs'; loadRuns()">历史批次（{{ runs.length }}）</button>
          <button :class="{ on: tab === 'basis' }" @click="tab = 'basis'">口径与未覆盖</button>
        </div>
        <div class="head-ops">
          <span v-if="batch" class="tiny mut">
            批次 {{ batch.check_no }} · {{ batch.status === 'reviewed' ? '已核对完成' : '待核对' }} · {{ ymd(batch.created_at) }}
          </span>
          <span v-else class="tiny mut">实时核对（未生成批次，差异不能登记）</span>
          <button v-if="batch && batch.status !== 'reviewed' && canFix" class="btn btn-sm btn-primary" @click="askReview">完成核对</button>
        </div>
      </div>

      <!-- ================= 明细 ================= -->
      <div v-if="tab === 'items'">
        <div v-if="!batch" class="notice-warn">
          当前是实时核对结果。要登记差异或标记完成，请先点右上「生成核对批次」——
          批次会把这版结论冻结，之后按行处理。
        </div>
        <div class="toolbar">
          <select v-model="fStatus" class="select" style="width: 130px">
            <option value="">全部状态</option>
            <option v-for="x in meta.statuses || []" :key="x.code" :value="x.code">{{ x.label }}</option>
          </select>
          <span class="tiny mut">共 {{ filtered.length }} 行</span>
        </div>
        <div class="table-wrap" v-if="filtered.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 104px">员工</th>
                <th style="width: 88px">部门</th>
                <th class="num" style="width: 86px">计件应计</th>
                <th class="num" style="width: 86px">工资单计件</th>
                <th class="num" style="width: 74px">差额</th>
                <th class="num" style="width: 108px">应发</th>
                <th class="num" style="width: 108px">实发</th>
                <th style="width: 88px">结论</th>
                <th style="width: 176px">处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in filtered" :key="r.employee_id">
                <td class="nowrap">
                  <b>{{ r.employee_name }}</b>
                  <div v-if="r.currency !== 'CNY'" class="tiny mut">{{ r.currency }}</div>
                </td>
                <td class="tiny nowrap">{{ r.department || '—' }}</td>
                <td class="num">{{ money(r.piece_expected) }}</td>
                <td class="num">{{ money(r.piece_in_payroll) }}</td>
                <td class="num" :class="{ red: Math.abs(r.piece_diff) >= 0.01 }">{{ r.piece_diff ? money(r.piece_diff) : '—' }}</td>
                <td class="num tiny">
                  <template v-if="diffOf(r.gross_stored, r.gross_recalc)">
                    <span class="red">{{ money(r.gross_stored) }}</span>
                    <div class="red">算 {{ money(r.gross_recalc) }}</div>
                  </template>
                  <span v-else>{{ money(r.gross_stored) }}</span>
                </td>
                <td class="num tiny">
                  <template v-if="diffOf(r.net_stored, r.net_recalc)">
                    <span class="red">{{ money(r.net_stored) }}</span>
                    <div class="red">算 {{ money(r.net_recalc) }}</div>
                  </template>
                  <span v-else>{{ money(r.net_stored) }}</span>
                </td>
                <td>
                  <span class="tag" :class="stCls(r.status)">{{ r.status_label }}</span>
                  <div v-if="r.adj_no" class="tiny mut">{{ r.adj_no }}</div>
                  <div v-else-if="(r.issues || []).length" class="tiny mut" :title="(r.issues || []).map((x) => x.msg).join('；')">
                    {{ (r.issues || []).length }} 条提示
                  </div>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="openSources(r)">计件来源</button>
                  <button v-if="batch && canFix && ['diff','missing'].includes(r.status) && !r.adj_no" class="btn btn-sm btn-primary" @click="openDiff(r)">登记差异</button>
                  <button v-if="batch && canFix && r.status !== 'ok'" class="btn btn-sm btn-ghost" @click="openNote(r)">说明</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">没有需要核对的人。要么本期没计件也没工资单，要么筛选条件太窄。</div>

        <div class="legend">
          <div class="tiny mut">
            「应发」「实发」列一致时只显示一个数；若显示两个（下面一行以「算」开头，红色），说明工资单里的数与按公式重算的结果不同 —— 工资单被改过但没重算。
            「差额」= 工资单计件 − 计件应计，正数代表多发。
          </div>
        </div>
      </div>

      <!-- ================= 历史 ================= -->
      <div v-else-if="tab === 'runs'">
        <div class="table-wrap" v-if="runs.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 132px">批次号</th><th style="width: 86px">期间</th>
                <th style="width: 140px">主体</th>
                <th class="num" style="width: 66px">人数</th><th class="num" style="width: 66px">差异</th>
                <th class="num" style="width: 78px">政策待配</th><th class="num" style="width: 78px">缺工资单</th>
                <th class="num" style="width: 96px">计件差额</th>
                <th style="width: 86px">状态</th><th style="width: 132px">生成</th><th style="width: 74px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in runs" :key="r.id">
                <td class="nowrap">{{ r.check_no }}</td>
                <td class="nowrap">{{ r.period }}</td>
                <td class="tiny nowrap">{{ r.company_name || '全部主体' }}</td>
                <td class="num">{{ r.items_count }}</td>
                <td class="num" :class="{ red: r.diff_count }">{{ r.diff_count }}</td>
                <td class="num">{{ r.policy_count }}</td>
                <td class="num" :class="{ red: r.missing_count }">{{ r.missing_count }}</td>
                <td class="num tiny">{{ money(r.piece_diff) }}</td>
                <td><span class="tag" :class="r.status === 'reviewed' ? 'green' : 'orange'">{{ r.status === 'reviewed' ? '已核对' : '待核对' }}</span></td>
                <td class="tiny nowrap">{{ r.created_by }}<div class="mut">{{ ymd(r.created_at) }}</div></td>
                <td class="ops"><button class="btn btn-sm btn-ghost" @click="openBatch(r)">打开</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有生成过核对批次。</div>
      </div>

      <!-- ================= 口径 ================= -->
      <div v-else>
        <div class="col-h">本期口径</div>
        <div class="basis-txt">{{ basisText }}</div>
        <div class="col-h" style="margin-top: 16px">算不出来 / 没纳入的</div>
        <div v-if="coverage.length" class="cov">
          <div class="cov-item" v-for="(c, i) in coverage" :key="i">· {{ c }}</div>
        </div>
        <div v-else class="tiny mut">无</div>
        <div class="col-h" style="margin-top: 16px">六条核对规则</div>
        <table class="data rules">
          <tbody>
            <tr><td style="width: 150px"><b>计件只认已确认</b></td><td>草稿是试算、作废是不要的。同期间出现两个已确认批次 → 整批标红，不允许挑一个先用。</td></tr>
            <tr><td><b>独立重算</b></td><td>应发/个税/实发按「工资公式」重算，与库里存的比。直接读库里的应发等于没核。</td></tr>
            <tr><td><b>差额不自动改单</b></td><td>要动钱走「工资调整单」（下一期生效）并写原因；直接改已确认工资单事后没人认。</td></tr>
            <tr><td><b>境外主体不套国内口径</b></td><td>本位币非 CNY → 状态「政策待配」，只核对来源与金额。</td></tr>
            <tr><td><b>调整单要看有没有带进来</b></td><td>本期 pending 的计件调整单要点名；报销/借款出现在调整单里单独提示 —— 那不是工资。</td></tr>
            <tr><td><b>离职补薪是事实</b></td><td>已离职仍发薪只做提示，但必须写原因，否则第二年审计会问。</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 生成批次 ================= -->
    <div class="modal-mask" v-if="runForm.open" @click.self="runForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>生成核对批次 · {{ period }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="runForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            批次会把这版核对结论冻结成单子，之后逐行处理（登记调整单或写说明），
            全部处理完才能「完成核对」。
          </div>
          <div class="kv"><span>人数</span><b>{{ s.items || 0 }}（差异 {{ s.diff || 0 }} · 政策待配 {{ s.policy || 0 }} · 缺工资单 {{ s.missing || 0 }}）</b></div>
          <div class="kv"><span>计件</span><b>应计 ¥{{ money(s.piece_expected) }} / 工资单 ¥{{ money(s.piece_in_payroll) }}</b></div>
          <div class="notice-warn" v-if="hasRun">该期间已生成过批次（{{ hasRun.check_no }}），继续会生成新版本。</div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="runForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doRun">确认生成</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 计件来源 ================= -->
    <div class="modal-mask" v-if="srcBox.open" @click.self="srcBox.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left"><b>{{ srcBox.name }} · 计件来源</b>
            <span class="tag gray">{{ period }}</span>
            <span class="tag">{{ srcBox.rows.length }} 条报工</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="srcBox.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="kv"><span>计件合计</span><b>{{ srcBox.total_qty }} 件 / ¥{{ money(srcBox.total_amount) }}</b></div>
          <div class="kv" v-if="srcBox.payroll"><span>工资单</span><b>计件 ¥{{ money(srcBox.payroll.piece_wage) }} · 应发 ¥{{ money(srcBox.payroll.gross_pay) }} · {{ payStatusLabel(srcBox.payroll.status) }}</b></div>
          <table class="data" v-if="srcBox.rows.length">
            <thead>
              <tr><th style="width: 92px">日期</th><th style="width: 120px">订单</th><th>款号 / 工序</th><th style="width: 74px">扎包</th>
                <th class="num" style="width: 64px">报工</th><th class="num" style="width: 64px">计件</th>
                <th class="num" style="width: 66px">单价</th><th class="num" style="width: 76px">金额</th><th style="width: 60px">封顶</th></tr>
            </thead>
            <tbody>
              <tr v-for="(x, i) in srcBox.rows" :key="i">
                <td class="tiny nowrap">{{ x.report_date || '—' }}</td>
                <td class="tiny nowrap">{{ x.order_no || '—' }}</td>
                <td class="tiny">{{ x.style_no || '—' }} / {{ x.process_name }}</td>
                <td class="tiny nowrap">{{ x.bundle_no || '—' }}</td>
                <td class="num tiny">{{ x.raw_qty }}</td>
                <td class="num tiny">{{ x.qty }}</td>
                <td class="num tiny">{{ x.unit_price }}</td>
                <td class="num">{{ money(x.amount) }}</td>
                <td class="tiny">{{ x.capped ? '是' : '' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">这个人本期没有计入的报工。</div>
        </div>
      </div>
    </div>

    <!-- ================= 登记差异 ================= -->
    <div class="modal-mask" v-if="diffForm.open" @click.self="diffForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>登记工资差异 · {{ diffForm.row ? diffForm.row.employee_name : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="diffForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="diffForm.row">
          <div class="kv"><span>计件</span><b>应计 ¥{{ money(diffForm.row.piece_expected) }} / 工资单 ¥{{ money(diffForm.row.piece_in_payroll) }} / 差 {{ money(diffForm.row.piece_diff) }}</b></div>
          <div class="kv" v-if="diffForm.row.status === 'missing'"><span>情况</span><b class="red">有计件但本期没有工资单，工资需要补发</b></div>
          <div class="row">
            <label>调整金额</label>
            <input v-model.number="diffForm.amount" class="input" type="number" style="width: 130px" />
            <span class="tiny mut">正数补发、负数扣回；默认按差额</span>
          </div>
          <div class="row">
            <label>生效期</label>
            <input v-model="diffForm.period" class="input" style="width: 120px" placeholder="YYYY-MM" />
            <span class="tiny mut">默认下一期（本期工资单已确认，不改历史）</span>
          </div>
          <div class="row">
            <label>原因</label>
            <textarea v-model="diffForm.reason" class="input" rows="2" style="flex: 1; min-width: 240px"
              placeholder="≥6 字，写清楚为什么差、依据哪张单"></textarea>
          </div>
          <div class="notice">
            确认后会生成一张「工资调整单」（状态待带入），由薪酬模块在生效期带入工资单。
            <b>不会改动本期已确认的工资单。</b>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="diffForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doDiff">生成调整单</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 写说明 ================= -->
    <div class="modal-mask" v-if="noteForm.open" @click.self="noteForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>核对说明 · {{ noteForm.row ? noteForm.row.employee_name : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="noteForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="noteForm.row">
          <div class="tiny mut" style="margin-bottom: 8px">
            {{ (noteForm.row.issues || []).map((x) => x.msg).join('；') || '无差异说明' }}
          </div>
          <div class="row">
            <label>说明</label>
            <textarea v-model="noteForm.note" class="input" rows="3" style="flex: 1; min-width: 250px"
              placeholder="为什么可以接受 / 已与谁核实 / 什么时候补（必填）"></textarea>
          </div>
          <div class="notice">写说明不改钱，只留结论。有差额要动钱，请用「登记差异」生成调整单。</div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="noteForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doNote">保存说明</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 完成核对 ================= -->
    <div class="modal-mask" v-if="reviewForm.open" @click.self="reviewForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>完成核对 · {{ batch ? batch.check_no : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="reviewForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            完成后批次锁定为「已核对」。有差异的行必须已经登记调整单或写了说明，否则会被拦住。
          </div>
          <div class="kv"><span>未处理</span><b :class="{ red: unhandled.length }">{{ unhandled.length }} 行</b></div>
          <div class="row">
            <label>备注</label>
            <input v-model="reviewForm.note" class="input" style="flex: 1; min-width: 220px" placeholder="可空，例如「已与车间核对，10 月补发」" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="reviewForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doReview">确认完成</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const D = new Date();
const thisMonth = `${D.getFullYear()}-${String(D.getMonth() + 1).padStart(2, '0')}`;

const tab = ref('items');
const period = ref(thisMonth);
const companyId = ref(null);
const meta = ref({});
const rep = ref({});
const batch = ref(null);
const runs = ref([]);
const fStatus = ref('');

const canRun = computed(() => can('paycheck.run'));
const canFix = computed(() => can('paycheck.fix'));

const num = (v) => Number(v || 0);
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const ymd = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');
const diffOf = (a, b) => Math.abs(num(a) - num(b)) >= 0.01;
const stCls = (s) => ({ ok: 'green', diff: 'red', policy: 'blue', missing: 'orange', pending: 'gray' }[s] || 'gray');
const payStatusLabel = (s) => ({ draft: '草稿', confirmed: '已确认', paid: '已发放' }[s] || s);

const s = computed(() => {
  if (batch.value && batch.value.payload && batch.value.payload.summary) return batch.value.payload.summary;
  return rep.value.summary || {};
});
const rows = computed(() => (batch.value ? batch.value.items || [] : rep.value.items || []));
const filtered = computed(() => rows.value.filter((r) => !fStatus.value || r.status === fStatus.value));
const coverage = computed(() => (batch.value && batch.value.payload ? batch.value.payload.coverage || [] : rep.value.coverage || []));
const hasRun = computed(() => (runs.value || []).find((r) => r.period === period.value && (r.company_id || 0) === (companyId.value || 0)) || null);
const unhandled = computed(() => rows.value.filter((r) => ['diff', 'missing'].includes(r.status) && !r.adj_no && !(r.review_note || '').trim()));

const basisText = computed(() => {
  const x = s.value || {};
  return [
    `口径：计件只认已确认批次（${(x.runs || []).map((r) => r.run_no).join('、') || '本期无'}），应计 ¥${money(x.piece_expected)}`,
    `工资单计件合计 ¥${money(x.piece_in_payroll)}，差额 ¥${money(x.piece_diff)}`,
    `应发差额合计 ¥${money(x.gross_diff_total)}，实发差额合计 ¥${money(x.net_diff_total)}`,
    `应发 = 基本工资 + 加班费 + 奖金 + 补贴 + 计件 − 扣款 − 缺勤扣；个税按月度税率表（5000 免征额）`
  ].join('；');
});

/* ---------------- 加载 ---------------- */
async function loadMeta() {
  try { meta.value = (await api.pcMeta()) || {}; } catch (e) { alert(e.message); }
}

async function preview() {
  try {
    const r = await api.pcPreview({ period: period.value, company_id: companyId.value || undefined });
    rep.value = r || {};
    batch.value = null;
    await loadRuns();
    const cur = hasRun.value;
    if (cur) await openBatch(cur, true);
  } catch (e) { alert(e.message); }
}

async function loadRuns() {
  try { runs.value = (await api.pcRuns({ period: period.value })) || []; } catch (e) { /* 静默 */ }
}

async function openBatch(r, silent) {
  try {
    batch.value = await api.pcRunDetail(r.id);
    if (!silent) tab.value = 'items';
  } catch (e) { if (!silent) alert(e.message); }
}

/* ---------------- 生成批次 ---------------- */
const runForm = reactive({ open: false });
function askRun() { runForm.open = true; }
async function doRun() {
  try {
    const r = await api.pcRun({ period: period.value, company_id: companyId.value || undefined, force: !!hasRun.value });
    runForm.open = false;
    await loadRuns();
    batch.value = r;
    tab.value = 'items';
  } catch (e) { alert(e.message); }
}

/* ---------------- 计件来源 ---------------- */
const srcBox = reactive({ open: false, name: '', rows: [], total_qty: 0, total_amount: 0, payroll: null });
async function openSources(r) {
  const runId = batch.value ? batch.value.id : (hasRun.value ? hasRun.value.id : null);
  if (!runId) return alert('先「生成核对批次」，才能按批次查计件来源');
  try {
    const d = await api.pcSources({ run_id: runId, employee_id: r.employee_id });
    Object.assign(srcBox, {
      open: true, name: r.employee_name, rows: d.rows || [],
      total_qty: d.total_qty || 0, total_amount: d.total_amount || 0, payroll: d.payroll || null
    });
  } catch (e) { alert(e.message); }
}

/* ---------------- 登记差异 ---------------- */
const diffForm = reactive({ open: false, row: null, amount: 0, period: '', reason: '' });
function openDiff(r) {
  // 缺工资单 = 该发没发 → 默认补发全额；其他情况按差额（正数=多发要扣回）
  const amount = r.status === 'missing' ? Number(r.piece_expected || 0) : Number(r.piece_diff || 0);
  Object.assign(diffForm, {
    open: true, row: r, amount,
    period: nextPeriod(period.value), reason: ''
  });
}
function nextPeriod(p) {
  const [y, m] = String(p).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
async function doDiff() {
  if (!diffForm.reason.trim()) return alert('请写原因');
  if (Math.abs(Number(diffForm.amount)) < 0.01) return alert('调整金额不能为 0');
  try {
    const r = await api.pcDiff(diffForm.row.id, {
      amount: diffForm.amount, period: diffForm.period, reason: diffForm.reason
    });
    diffForm.open = false;
    await openBatch(batch.value, true);
    alert(`已生成调整单 ${r.adj_no}（${r.period} 生效，¥${money(r.amount)}）`);
  } catch (e) { alert(e.message); }
}

/* ---------------- 写说明 ---------------- */
const noteForm = reactive({ open: false, row: null, note: '' });
function openNote(r) { Object.assign(noteForm, { open: true, row: r, note: r.review_note || '' }); }
async function doNote() {
  if (!noteForm.note.trim()) return alert('请写说明');
  try {
    await api.pcAnnotate(noteForm.row.id, { review_note: noteForm.note });
    noteForm.open = false;
    await openBatch(batch.value, true);
  } catch (e) { alert(e.message); }
}

/* ---------------- 完成核对 ---------------- */
const reviewForm = reactive({ open: false, note: '' });
function askReview() { Object.assign(reviewForm, { open: true, note: '' }); }
async function doReview() {
  try {
    batch.value = await api.pcReview(batch.value.id, { note: reviewForm.note || undefined });
    reviewForm.open = false;
    await loadRuns();
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  await loadMeta();
  await preview();
});
</script>

<style scoped>
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }

.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 100px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 11px; line-height: 1.4; }
.stat-card.warn { border-color: #fde68a; background: #fffdf5; }

.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.tiny { font-size: 11px; line-height: 1.45; }
.mut { color: #7b8698; }
.red { color: #b91c1c; }
.green-t { color: #047857; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.empty { padding: 26px 6px; color: #7b8698; font-size: 12.5px; }
.table-wrap { overflow-x: auto; }
table.data td { vertical-align: middle; }
table.data .tag { white-space: nowrap; }
table.data .btn { white-space: nowrap; }
.ops { white-space: nowrap; }
.ops .btn + .btn { margin-left: 5px; }
.ops .btn { padding: 3px 8px; font-size: 11.5px; }

.legend { margin-top: 10px; }
.col-h { font-size: 12.5px; font-weight: 600; color: #16233b; margin: 12px 0 6px; }
.basis-txt { font-size: 12px; line-height: 1.8; color: #3d4757; background: #fbfcfe; border: 1px solid #eef1f6; border-radius: 9px; padding: 10px 12px; }
.cov-item { font-size: 11.5px; color: #92400e; line-height: 1.8; }
.cov { background: #fffdf5; border: 1px solid #fde68a; border-radius: 9px; padding: 8px 12px; }
table.rules td { font-size: 12px; line-height: 1.7; border-top: 1px solid #eef1f6; }

.notice { border: 1px solid #dbeafe; background: #f6faff; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #1e3a5f; margin-bottom: 10px; }
.notice-warn { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #92400e; margin-bottom: 10px; }

.modal.wide { width: min(1040px, 95vw); }
.mh-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.kv > span { color: #7b8698; min-width: 78px; flex: 0 0 auto; }
.kv > b { font-weight: 500; }
.modal-body .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.modal-body .row label { font-size: 12px; color: #7b8698; flex: 0 0 auto; min-width: 66px; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .page-head .head-ops,
  .panel-head .head-ops { width: 100%; flex: 1 1 auto; flex-wrap: wrap; }
  .head-ops .select { flex: 1 1 45%; min-width: 0; }
  .head-ops .btn { flex: 1 1 40%; }
}
</style>
