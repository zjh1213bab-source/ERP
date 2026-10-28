<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>计件工资</h2>
        <p class="sub">
          按<b>扎级报工的合格件数 × 工序单价</b>算工钱，一个月出一张核算单，确认后由工资单自动带入。
          四条口径：<b>只算合格数</b>（不良不付）、<b>超报按扎件数封顶</b>（同扎同工序累计不可能超过件数，超出部分是报工错了）、
          <b>缺单价绝不按 0 算</b>（按 0 等于白干，确认时直接拒）、<b>归人认不出就不猜</b>（重名/临时工进「无法归属」清单）。
          单价<b>按生效日版本化</b>：今天调价不会改上个月已经算过的钱。
        </p>
      </div>
      <div class="head-ops">
        <select v-model="period" class="select" style="min-width: 132px" @change="reload">
          <option v-for="p in periods" :key="p" :value="p">{{ p }}</option>
        </select>
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" :disabled="!preview || busy" @click="createRun">
          生成核算草案
        </button>
      </div>
    </div>

    <div class="cards four">
      <div class="stat-card accent">
        <div class="label">本月计件金额</div>
        <div class="value">¥{{ money(viewSummary.total_amount) }}<small>{{ viewSummary.employees_count || 0 }} 人</small></div>
      </div>
      <div class="stat-card">
        <div class="label">计件数量</div>
        <div class="value">{{ viewSummary.total_qty || 0 }}<small>件</small></div>
      </div>
      <div class="stat-card">
        <div class="label">明细行</div>
        <div class="value">{{ viewSummary.items_count || 0 }}<small>行</small></div>
      </div>
      <div class="stat-card">
        <div class="label">超报封顶</div>
        <div class="value" :style="{ color: viewSummary.capped_count ? '#d92d45' : '#8a94a6' }">
          {{ viewSummary.capped_count || 0 }}<small>笔</small>
        </div>
      </div>
    </div>

    <div class="tabs-row">
      <div class="tabs">
        <button :class="{ on: tab === 'calc' }" @click="tab = 'calc'">本月核算</button>
        <button :class="{ on: tab === 'rates' }" @click="tab = 'rates'">单价维护</button>
        <button :class="{ on: tab === 'runs' }" @click="tab = 'runs'">历史核算</button>
      </div>
      <span class="tiny muted" v-if="run">
        当前查看：<b>{{ run.run_no }}</b>（{{ run.status_label }}）
        <button class="link-btn" style="margin-left: 6px" @click="run = null">回到实时试算</button>
      </span>
      <span class="tiny muted" v-else>当前为<b>实时试算</b>（未落库）</span>
    </div>

    <!-- ================= 本月核算 ================= -->
    <template v-if="tab === 'calc'">
      <!-- 状态提示 -->
      <div v-if="run && run.status === 'confirmed'" class="banner ok">
        <b>已确认 {{ run.run_no }}</b>
        <span>
          这份核算单冻结了，{{ run.period }} 的工资单会带入 ¥{{ money(run.total_amount) }}（{{ run.employees_count }} 人）。
          要改只能先作废（需写理由）。
        </span>
      </div>
      <div v-else-if="run && run.status === 'void'" class="banner bad">
        <b>已作废 {{ run.run_no }}</b><span>原因：{{ run.void_reason }}</span>
      </div>
      <div v-else-if="run && drift" class="banner warn">
        <b>草案与当前数据不一致</b>
        <span>
          草案金额 ¥{{ money(run.total_amount) }}，实时试算 ¥{{ money(preview.summary.total_amount) }}
          —— 生成草案后又有报工/改价。建议重新生成草案再确认（草案可覆盖）。
        </span>
      </div>

      <!-- 诊断：三块，都是「钱算不到人/算不准」的地方 -->
      <div v-if="diag.missing_rate && diag.missing_rate.length" class="diag bad">
        <div class="diag-h">
          <b>缺单价 {{ diag.missing_rate.length }} 条</b>
          <span>按 0 算等于白干，所以这些不计金额；补全单价后才允许确认</span>
        </div>
        <table class="data sm">
          <thead><tr><th>订单</th><th>款号</th><th>工序</th><th>件数</th><th>姓名</th><th>日期</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in diag.missing_rate.slice(0, 12)" :key="i">
              <td>{{ m.order_no }}</td>
              <td>{{ m.style_no || '（通用）' }}</td>
              <td>{{ m.process_name }}</td>
              <td class="num">{{ m.qty }}</td>
              <td>{{ m.employee_name }}</td>
              <td>{{ m.report_date }}</td>
              <td class="tiny">{{ m.note }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="diag.missing_rate.length > 12" class="tiny muted">还有 {{ diag.missing_rate.length - 12 }} 条，去「单价维护」补齐。</p>
      </div>

      <div v-if="diag.unassigned && diag.unassigned.length" class="diag warn">
        <div class="diag-h">
          <b>无法归属 {{ diag.unassigned.length }} 条</b>
          <span>报工没记人、或姓名对不上员工档案。不猜 —— 先补档案或补报工</span>
        </div>
        <table class="data sm">
          <thead><tr><th>订单</th><th>扎号</th><th>工序</th><th>件数</th><th>报工人</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="(u, i) in diag.unassigned.slice(0, 12)" :key="i">
              <td>{{ u.order_no }}</td>
              <td>{{ u.bundle_no || '—' }}</td>
              <td>{{ u.process_name }}</td>
              <td class="num">{{ u.qty }}</td>
              <td>{{ u.operator || '（空）' }}</td>
              <td class="tiny">{{ u.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="diag.capped && diag.capped.length" class="diag bad">
        <div class="diag-h">
          <b>超报封顶 {{ diag.capped.length }} 条</b>
          <span>同一扎同一工序累计合格数超过这扎件数，超出部分没计钱（先报先算）</span>
        </div>
        <table class="data sm">
          <thead><tr><th>订单</th><th>扎号</th><th>工序</th><th>姓名</th><th>原报</th><th>计入</th><th>超出</th><th>扎件数</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in diag.capped.slice(0, 12)" :key="i">
              <td>{{ c.order_no }}</td>
              <td>{{ c.bundle_no }}</td>
              <td>{{ c.process_name }}</td>
              <td>{{ c.employee_name }}</td>
              <td class="num">{{ c.raw_qty }}</td>
              <td class="num">{{ c.counted }}</td>
              <td class="num over">{{ c.over }}</td>
              <td class="num">{{ c.bundle_qty }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="diag.no_bundle && diag.no_bundle.length" class="diag info">
        <div class="diag-h">
          <b>未记扎号 {{ diag.no_bundle.length }} 条</b>
          <span>电脑上直接报工不会记扎，无法用扎件数封顶（金额照算，但少了这层校验）</span>
        </div>
      </div>

      <!-- 按人汇总 -->
      <div class="panel-card">
        <h3>按人汇总（{{ viewByEmployee.length }} 人）</h3>
        <table class="data">
          <thead>
            <tr><th>员工</th><th>部门</th><th class="num">计件数量</th><th class="num">明细行</th><th class="num">计件金额</th><th>占比</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in viewByEmployee" :key="e.employee_id">
              <td><b>{{ e.employee_name }}</b><span class="emp-code">{{ e.employee_code }}</span></td>
              <td>{{ e.department || '—' }}</td>
              <td class="num">{{ e.qty }}</td>
              <td class="num">{{ e.items }}</td>
              <td class="num strong">¥{{ money(e.amount) }}</td>
              <td>
                <div class="ratio"><i :style="{ width: pct(e.amount) }"></i></div>
              </td>
            </tr>
            <tr v-if="!viewByEmployee.length"><td colspan="6" class="empty">本月没有可计件的报工</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 明细 -->
      <div class="panel-card">
        <div class="panel-h">
          <h3 style="margin: 0">计件明细（{{ viewItems.length }} 行）</h3>
          <div class="head-ops">
            <button v-if="run && canApprove" class="btn btn-ghost btn-sm" :disabled="busy" @click="confirmRun">
              确认核算
            </button>
            <button v-if="run && canApprove && run.status !== 'void'" class="btn btn-ghost btn-sm" :disabled="busy" @click="voidRun">
              作废
            </button>
            <button v-if="run" class="btn btn-ghost btn-sm" @click="exportCsv">导出 CSV</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height: 520px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr>
                <th>姓名</th><th>订单</th><th>扎号</th><th>工序</th><th>款号</th>
                <th class="num">报工合格</th><th class="num">计件数量</th><th class="num">单价</th>
                <th class="num">金额</th><th>取价</th><th>归人</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in viewItems" :key="i">
                <td>{{ it.employee_name }}</td>
                <td class="mono tiny">{{ it.order_no }}</td>
                <td class="mono tiny">{{ it.bundle_no || '—' }}</td>
                <td>{{ it.process_name }}</td>
                <td class="tiny">{{ it.style_no || '（通用）' }}</td>
                <td class="num">{{ it.raw_qty }}</td>
                <td class="num">
                  {{ it.qty }}<i v-if="it.capped" class="cap">封顶</i>
                </td>
                <td class="num">{{ money(it.unit_price) }}</td>
                <td class="num strong">¥{{ money(it.amount) }}</td>
                <td class="tiny">{{ it.rate_source === 'style' ? '款专属' : '通用' }}</td>
                <td class="tiny">{{ it.matched_by === 'id' ? '员工编号' : '姓名匹配' }}</td>
              </tr>
              <tr v-if="!viewItems.length"><td colspan="11" class="empty">没有明细</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ================= 单价维护 ================= -->
    <template v-else-if="tab === 'rates'">
      <div class="banner info">
        <b>改价不改历史</b>
        <span>
          单价按<b>生效日版本化</b>：查找时取「生效日 ≤ 报工日期」里最新的一条，款专属价优先于通用价。
          所以今天加一条 11-01 生效的新价，10 月已经算过的钱一分都不会变。已被核算用过的单价<b>不允许改金额</b>。
        </span>
      </div>

      <div v-if="canWrite" class="panel-card">
        <h3>新增单价</h3>
        <div class="fgrid">
          <label>
            <span>款号（留空 = 通用价）</span>
            <select v-model="rateForm.style_no" class="select">
              <option value="">通用（所有款）</option>
              <option v-for="s in meta.styles || []" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <label>
            <span>工序</span>
            <select v-model="rateForm.process_name" class="select">
              <option value="">选工序</option>
              <option v-for="p in meta.processes || []" :key="p.name" :value="p.name">{{ p.name }}</option>
            </select>
          </label>
          <label>
            <span>单价（元/件）</span>
            <input v-model="rateForm.unit_price" class="input" type="number" step="0.01" min="0" placeholder="0.00" />
          </label>
          <label>
            <span>生效日</span>
            <input v-model="rateForm.effective_from" class="input" type="date" />
          </label>
          <label>
            <span>失效日（可空）</span>
            <input v-model="rateForm.effective_to" class="input" type="date" />
          </label>
          <label class="full">
            <span>备注</span>
            <input v-model="rateForm.note" class="input" placeholder="例如：2026 秋冬工艺调价" />
          </label>
        </div>
        <div class="form-foot">
          <button class="btn btn-primary" :disabled="busy" @click="saveRate">保存单价</button>
          <span class="tiny muted">同一款 + 同一工序 + 同一生效日只能有一条（否则取价会摇摆）</span>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-h">
          <h3 style="margin: 0">单价清单（{{ rates.length }} 条）</h3>
          <span class="tiny muted">款专属价 → 通用价，各取「已生效里最新」的一条</span>
        </div>
        <table class="data">
          <thead>
            <tr><th>款号</th><th>工序</th><th class="num">单价</th><th>生效期间</th><th>状态</th><th>备注</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rates" :key="r.id" :class="{ 'row-off': r.status !== 'active' }">
              <td>
                <span v-if="r.style_no" class="tag blue">{{ r.style_no }}</span>
                <span v-else class="tag gray">通用</span>
              </td>
              <td>{{ r.process_name }}</td>
              <td class="num strong">¥{{ money(r.unit_price) }}</td>
              <td class="tiny">{{ r.effective_from }} ~ {{ r.effective_to || '长期' }}</td>
              <td>
                <span class="tag" :class="r.status === 'active' ? 'green' : 'gray'">
                  {{ r.status === 'active' ? '生效' : '停用' }}
                </span>
              </td>
              <td class="tiny">{{ r.note || '' }}</td>
              <td>
                <button v-if="canWrite && r.status === 'active'" class="link-btn danger" @click="disableRate(r)">停用</button>
                <span v-else class="tiny muted">—</span>
              </td>
            </tr>
            <tr v-if="!rates.length"><td colspan="7" class="empty">还没有单价，先加一条</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ================= 历史核算 ================= -->
    <template v-else>
      <div class="panel-card">
        <h3>核算单（近 60 条）</h3>
        <table class="data">
          <thead>
            <tr>
              <th>编号</th><th>月份</th><th>状态</th><th class="num">人数</th><th class="num">件数</th>
              <th class="num">金额</th><th class="num">缺价</th><th class="num">未归属</th>
              <th>制单</th><th>确认</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="mono">{{ r.run_no }}</td>
              <td>{{ r.period }}</td>
              <td>
                <span class="tag" :class="{ draft: 'gray', confirmed: 'green', void: 'red' }[r.status]">
                  {{ r.status_label }}
                </span>
              </td>
              <td class="num">{{ r.employees_count }}</td>
              <td class="num">{{ r.total_qty }}</td>
              <td class="num strong">¥{{ money(r.total_amount) }}</td>
              <td class="num" :style="{ color: r.missing_rate_count ? '#d92d45' : '#8a94a6' }">{{ r.missing_rate_count }}</td>
              <td class="num" :style="{ color: r.unassigned_count ? '#d97706' : '#8a94a6' }">{{ r.unassigned_count }}</td>
              <td class="tiny">{{ r.created_by || '' }}<br />{{ $fmt(r.created_at) }}</td>
              <td class="tiny">{{ r.confirmed_by || '—' }}<br />{{ r.confirmed_at ? $fmt(r.confirmed_at) : '' }}</td>
              <td>
                <button class="link-btn" @click="openRun(r.id)">查看</button>
                <button v-if="r.status === 'confirmed'" class="link-btn" @click="exportRun(r.id)">导出</button>
              </td>
            </tr>
            <tr v-if="!runs.length"><td colspan="11" class="empty">还没有核算单</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('piecewage.write'));
const canApprove = computed(() => can('piecewage.approve'));

/** 本地今天：toISOString 是 UTC，晚 8 点后会算成前一天 */
function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const tab = ref('calc');
const busy = ref(false);
const period = ref('');
const periods = ref([]);
const meta = ref({ processes: [], styles: [], periods: [] });
const preview = ref(null);
const run = ref(null);
const runs = ref([]);
const rates = ref([]);

const rateForm = reactive({
  style_no: '',
  process_name: '',
  unit_price: '',
  effective_from: localToday(),
  effective_to: '',
  note: ''
});

const money = (v) => (Number(v) || 0).toFixed(2);

/** 有核算单就看快照，否则看实时试算 —— 两者不能混着看，会看不出差异 */
const viewSummary = computed(() =>
  run.value ? run.value : (preview.value && preview.value.summary) || {}
);
const viewByEmployee = computed(() =>
  run.value ? run.value.by_employee || [] : (preview.value && preview.value.by_employee) || []
);
const viewItems = computed(() =>
  run.value ? run.value.items || [] : (preview.value && preview.value.items) || []
);
const diag = computed(() => (run.value ? run.value.diagnostics || {} : (preview.value && preview.value.diagnostics) || {}));

/** 草案金额与实时试算不一致 → 提示重算（报告改了/单价调了） */
const drift = computed(() => {
  if (!run.value || !preview.value || run.value.status !== 'draft') return false;
  return Math.abs(Number(run.value.total_amount) - Number(preview.value.summary.total_amount)) >= 0.01;
});

const maxAmount = computed(() => Math.max(1, ...viewByEmployee.value.map((e) => Number(e.amount) || 0)));
function pct(amount) {
  return Math.min(100, Math.round(((Number(amount) || 0) / maxAmount.value) * 100)) + '%';
}

async function loadMeta() {
  const m = await api.pieceMeta();
  meta.value = m;
  periods.value = m.periods && m.periods.length ? m.periods : [localToday().slice(0, 7)];
  if (!period.value) period.value = periods.value[0];
}

async function loadPreview() {
  if (!period.value) return;
  preview.value = await api.piecePreview(period.value);
}

async function loadRuns() {
  runs.value = await api.pieceRuns({});
}

async function loadRates() {
  rates.value = await api.pieceRates({});
}

async function reload() {
  try {
    await Promise.all([loadPreview(), loadRuns(), loadRates()]);
  } catch (e) {
    alert(e.message);
  }
}

async function createRun() {
  busy.value = true;
  try {
    run.value = await api.pieceCreateRun({ period: period.value });
    await Promise.all([loadRuns(), loadPreview()]);
    tab.value = 'calc';
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function confirmRun() {
  if (!run.value) return;
  let note = run.value.note || '';
  const un = Number(run.value.unassigned_count) || 0;
  // 无法归属的报工不阻塞确认（临时工很常见），但必须留一句处理说明
  if (un > 0 && String(note).trim().length < 4) {
    const t = prompt(
      `还有 ${un} 条报工无法归属到人（临时工/姓名对不上档案）。\n` +
        '确认可以继续，但请写一句怎么处理（至少 4 个字）：',
      '临时工另行结算'
    );
    if (t === null) return;
    note = t;
  }
  const tip =
    `确认 ${run.value.run_no}？\n\n` +
    `${run.value.employees_count} 人 / ${run.value.total_qty} 件 / ¥${money(run.value.total_amount)}\n\n` +
    '确认后这份核算单冻结，工资单会带入这个金额；要改只能作废重开（作废需写理由）。';
  if (!confirm(tip)) return;
  busy.value = true;
  try {
    run.value = await api.pieceConfirm(run.value.id, note);
    await loadRuns();
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function voidRun() {
  if (!run.value) return;
  const reason = prompt('作废理由（至少 4 个字，以后要能解释）：', '');
  if (reason === null) return;
  busy.value = true;
  try {
    run.value = await api.pieceVoid(run.value.id, reason);
    await Promise.all([loadRuns(), loadPreview()]);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function openRun(id) {
  try {
    run.value = await api.pieceRun(id);
    tab.value = 'calc';
  } catch (e) {
    alert(e.message);
  }
}

async function exportRun(id) {
  try {
    const blob = await downloadFile(api.pieceExportPath(id));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `计件工资-${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e.message);
  }
}

function exportCsv() {
  if (run.value) return exportRun(run.value.id);
  alert('先「生成核算草案」，明细才有编号可导出');
}

async function saveRate() {
  busy.value = true;
  try {
    await api.pieceRateSave({ ...rateForm, unit_price: Number(rateForm.unit_price) });
    rateForm.process_name = '';
    rateForm.unit_price = '';
    rateForm.note = '';
    await Promise.all([loadRates(), loadPreview()]);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function disableRate(r) {
  if (!confirm(`停用「${r.style_no || '通用'} / ${r.process_name} / ¥${money(r.unit_price)}」？\n\n停用后不再被选中，历史核算不受影响。`)) return;
  try {
    await api.pieceRateUpdate(r.id, { status: 'disabled' });
    await Promise.all([loadRates(), loadPreview()]);
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  try {
    await loadMeta();
    await reload();
  } catch (e) {
    alert(e.message);
  }
});
</script>

<style scoped>
.cards.four {
  grid-template-columns: repeat(4, 1fr);
}
/* 金额长（¥11167.40）时「7 人」会贴在数字后面，换行显示更清楚 */
.cards.four .stat-card .value small {
  display: block;
  margin-left: 0;
  margin-top: 6px;
  font-size: 12px;
  font-weight: 600;
}
.tabs-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 4px 0 14px;
  flex-wrap: wrap;
}
.tabs-row .tabs {
  margin-left: 0;
}
.banner {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  flex-wrap: wrap;
  border-radius: 10px;
  padding: 10px 13px;
  font-size: 12.5px;
  line-height: 1.75;
  margin-bottom: 14px;
  border: 1px solid #dbe8ff;
  background: #f4f8ff;
  color: #2b5aa7;
}
.banner b {
  flex: none;
}
.banner.ok {
  border-color: #bfe9cd;
  background: #f2fbf5;
  color: #16794a;
}
.banner.warn {
  border-color: #f5dcb4;
  background: #fffaf2;
  color: #a45c07;
}
.banner.bad {
  border-color: #f3c3cb;
  background: #fef5f6;
  color: #a81b31;
}
.diag {
  border: 1px solid #e6ebf3;
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
  background: #fff;
  /* 诊断表列多（订单/扎号/工序/件数/姓名/原因），窄屏要能横向滚动，
     否则会被卡片裁掉右边几列 */
  overflow-x: auto;
}
.diag.bad {
  border-color: #f5cdd4;
}
.diag.warn {
  border-color: #f3ddb8;
}
.diag.info {
  border-color: #e2e8f2;
}
.diag-h {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.diag-h b {
  font-size: 13px;
  color: #16233b;
}
.diag-h span {
  font-size: 11.5px;
  color: #8a94a6;
}
table.data.sm th,
table.data.sm td {
  font-size: 12px;
  padding: 6px 8px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.strong {
  font-weight: 800;
  color: #16233b;
}
.over {
  color: #d92d45;
  font-weight: 800;
}
.cap {
  display: inline-block;
  margin-left: 4px;
  font-size: 9.5px;
  font-style: normal;
  color: #d92d45;
  border: 1px solid #f3c3cb;
  border-radius: 4px;
  padding: 0 3px;
}
.empty {
  text-align: center;
  color: #8a94a6;
  padding: 22px 0 !important;
}
.ratio {
  width: 110px;
  height: 7px;
  background: #eef1f6;
  border-radius: 4px;
  overflow: hidden;
}
.ratio i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #4f8cf7, #2563eb);
}
.panel-h {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.form-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.emp-code {
  display: inline-block;
  margin-left: 7px;
  font-size: 11px;
  color: #a0aabb;
}
.row-off td {
  opacity: 0.55;
}
@media (max-width: 900px) {
  .cards.four {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
