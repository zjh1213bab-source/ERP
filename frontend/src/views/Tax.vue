<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>税负测算</h2>
        <p class="sub">
          按<b>主体 × 税区 × 期间</b>算，税率从「税政配置」取——<b>不会用 13% 默认值代算</b>，没配就直说没配。
          销项按<b>不含税收入</b>乘税率，进项按<b>采购票据含税价</b>换算；应纳增值税为负是<b>留抵</b>不是退税，附加税以<b>应纳增值税</b>为基数。
          测算<b>不等于已申报</b>，确认只是内部确认这一版数字。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">本期合计 {{ money(ov.total_burden_this_period) }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>当期（{{ ov.period || '—' }}）税负</span><strong>{{ money(ov.total_burden_this_period) }}</strong><small>各主体相加</small></div>
      <div class="stat" :class="ov.pending ? 'st-warn' : ''"><span>待确认批次</span><strong>{{ ov.pending || 0 }}</strong><small>草稿可重算</small></div>
      <div class="stat"><span>已确认</span><strong>{{ ov.confirmed || 0 }}</strong><small>历史留档</small></div>
      <div class="stat" :class="ov.no_policy ? 'st-bad' : ''"><span>未配税率主体</span><strong>{{ ov.no_policy || 0 }}</strong><small>没配不许测算</small></div>
      <div class="stat"><span>生效政策</span><strong>{{ activePolicies }}</strong><small>条（含已替代 {{ supersededPolicies }}）</small></div>
      <div class="stat"><span>口径</span><strong class="tiny-strong">不含申报</strong><small>测算 ≠ 已申报</small></div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'calc' }" @click="go('calc')">税负测算</button>
        <button :class="{ on: tab === 'policy' }" @click="go('policy')">税政配置<span v-if="ov.no_policy" class="tab-dot">{{ ov.no_policy }}</span></button>
      </div>
    </div>

    <!-- ==================== 测算 ==================== -->
    <div v-if="tab === 'calc'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="form.company_id">
          <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="form.tax_region">
          <option v-for="r in dict.regions" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select>
        <input v-model="form.period" type="month" />
        <button class="btn btn-primary" :disabled="loading" @click="doPreview">{{ loading ? '测算中…' : '测算' }}</button>
        <div class="spacer"></div>
        <span class="muted tiny">先预览再保存；同一期间已确认的批次不能重算，要改先作废</span>
      </div>

      <div v-if="preview" class="calc-card">
        <div class="cc-head">
          <div>
            <b>{{ preview.company_name }} · {{ preview.region_label }} · {{ preview.period }}</b>
            <span class="muted tiny">　收入 {{ money(preview.revenue_total) }}（其中出口 {{ money(preview.export_revenue) }}）</span>
          </div>
          <div class="spacer"></div>
          <span class="tag" :class="preview.burden_rate < 0 ? 'blue' : 'green'">税负率 {{ preview.burden_rate }}%</span>
          <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveRun">保存为草稿</button>
        </div>

        <div class="calc-grid">
          <div class="cg-item"><span>销项税额</span><b>{{ money(preview.output_tax) }}</b><small>内销 {{ money(preview.domestic_revenue) }} × {{ rateOf('vat') }}%</small></div>
          <div class="cg-item"><span>进项税额</span><b>{{ money(preview.input_tax) }}</b><small>采购 {{ money(preview.purchase_total) }} ÷ (1+{{ rateOf('vat') }}%) × {{ rateOf('vat') }}%</small></div>
          <div class="cg-item" :class="preview.vat_payable ? 'cg-bad' : ''"><span>应纳增值税</span><b>{{ money(preview.vat_payable) }}</b>
            <small v-if="preview.credit_carry">留抵 {{ money(preview.credit_carry) }}（结转下期）</small><small v-else>销项 − 进项</small></div>
          <div class="cg-item"><span>附加税</span><b>{{ money(preview.surcharge_amount) }}</b><small>应纳增值税 × {{ rateOf('surcharge') }}%</small></div>
          <div class="cg-item"><span>企业所得税</span><b>{{ money(preview.cit_amount) }}</b><small>利润 {{ money(preview.profit_total) }} × {{ rateOf('cit') }}%</small></div>
          <div class="cg-item"><span>出口退税（估算）</span><b>{{ money(preview.rebate_amount) }}</b><small>免抵退取小{{ preview.exempt_offset ? '，免抵 ' + money(preview.exempt_offset) : '' }}</small></div>
        </div>

        <div class="calc-total">
          <span>合计税负</span>
          <b :class="preview.total_burden < 0 ? 'blue' : ''">{{ money(preview.total_burden) }}</b>
          <span class="muted tiny">= 应纳增值税 + 附加税 + 所得税 − 出口退税估算；退得多时合计为负，属正常</span>
        </div>

        <div v-for="(w, i) in preview.warnings" :key="i" class="warn-row">{{ w }}</div>

        <h4 style="margin-top: 14px">算式与取数<small>每一行都能对回单据，不是黑箱</small></h4>
        <div class="table-wrap" style="box-shadow: none">
          <table class="data">
            <thead><tr><th style="width: 150px">税种</th><th class="num" style="width: 130px">计税依据</th><th class="num" style="width: 70px">税率</th>
              <th class="num" style="width: 130px">税额</th><th>算式</th><th style="width: 220px">取数来源</th></tr></thead>
            <tbody>
              <tr v-for="it in preview.items" :key="it.label">
                <td><b>{{ it.label }}</b><div v-if="it.note" class="tiny muted">{{ it.note }}</div></td>
                <td class="num">{{ money(it.base_amount) }}</td>
                <td class="num">{{ it.rate === null || it.rate === undefined ? '—' : it.rate + '%' }}</td>
                <td class="num" :class="it.amount > 0 ? '' : 'muted'">{{ money(it.amount) }}</td>
                <td class="tiny">{{ it.formula }}</td>
                <td class="tiny muted">{{ it.source }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4 style="margin-top: 18px">历史批次<small>同一期间已确认的不能再算，要改先作废</small></h4>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>批次</th><th>主体</th><th>税区</th><th>期间</th><th class="num">收入</th>
            <th class="num">应纳增值税</th><th class="num">所得税</th><th class="num">合计税负</th><th class="num">税负率</th><th>状态</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="nowrap"><a class="lnk" @click="openRun(r.id)">{{ r.run_no }}</a></td>
              <td>{{ r.company_name }}</td>
              <td class="tiny">{{ r.region_label }}</td>
              <td class="nowrap">{{ r.period }}</td>
              <td class="num">{{ money(r.revenue_total) }}</td>
              <td class="num">{{ money(r.vat_payable) }}</td>
              <td class="num">{{ money(r.cit_amount) }}</td>
              <td class="num" :class="r.total_burden < 0 ? 'blue' : ''">{{ money(r.total_burden) }}</td>
              <td class="num" :class="r.burden_rate > 15 ? 'red' : ''" :title="r.burden_rate > 15 ? '税负率偏高，多半是进项票未收齐或成本未入账' : ''">{{ r.burden_rate }}%</td>
              <td><span class="tag" :class="runTag(r.status)">{{ r.status_label }}</span></td>
              <td class="ops"><button class="link-btn" @click="openRun(r.id)">明细</button></td>
            </tr>
            <tr v-if="!runs.length"><td colspan="11" class="empty-cell">还没有测算批次，先点上面的「测算」</td></tr>
          </tbody>
        </table>
      </div>

      <h4 style="margin-top: 18px">税负率趋势<small>近 6 期（当前主体 / 税区），每期只取最新一版</small></h4>
      <div class="trend">
        <div v-for="t in trend" :key="t.period" class="tr-col">
          <div class="tr-bar"><i :style="{ height: barH(t.burden_rate) }" :class="t.burden_rate < 0 ? 'bar-blue' : 'bar-ok'"></i></div>
          <b>{{ t.burden_rate }}%</b>
          <span>{{ t.period.slice(5) }}月</span>
        </div>
        <div v-if="!trend.length" class="empty-box">还没有可对比的期间</div>
      </div>
    </div>

    <!-- ==================== 税政配置 ==================== -->
    <div v-if="tab === 'policy'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="polFilter.company_id" @change="loadPolicies">
          <option value="">全部主体</option>
          <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="polFilter.status" @change="loadPolicies">
          <option value="">全部状态</option>
          <option value="active">生效</option>
          <option value="superseded">已被替代</option>
        </select>
        <div class="spacer"></div>
        <button v-action="['tax','create']"  class="btn btn-primary" @click="openPolicy">＋ 新增税率</button>
      </div>

      <div class="hint-bar">
        同一主体、同一税区、同一税种，<b>同时只能有一条生效税率</b>。改税率不是「编辑原记录」，而是新增一条并把旧的标为<b>已被替代</b>——
        否则上个月的测算会跟着新税率变，历史无法解释。美国税区没有增值税，不要求配 vat。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>主体</th><th>税区</th><th>税种</th><th class="num">税率</th><th>价格口径</th>
            <th>生效期</th><th>政策文号</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="p in policies" :key="p.id" :class="{ 'row-off': p.status !== 'active' }">
              <td>{{ p.company_name }}</td>
              <td class="tiny">{{ p.region_label }}</td>
              <td>{{ p.type_label }}</td>
              <td class="num"><b>{{ p.rate }}%</b></td>
              <td class="tiny">{{ p.price_includes_tax_label }}</td>
              <td class="tiny nowrap">{{ p.effective_from }} ~ {{ p.effective_to || '长期' }}</td>
              <td class="tiny muted">{{ p.policy_no || '—' }}</td>
              <td><span class="tag" :class="p.status === 'active' ? 'green' : 'gray'">{{ p.status_label }}</span></td>
            </tr>
            <tr v-if="!policies.length"><td colspan="8" class="empty-cell">还没有税政配置</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增税率 -->
    <div v-if="modal === 'policy'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>新增税率</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld"><span>主体 *</span>
              <select v-model="polForm.company_id"><option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fld"><span>税区 *</span>
              <select v-model="polForm.tax_region"><option v-for="r in dict.regions" :key="r.key" :value="r.key">{{ r.label }}</option></select>
            </label>
            <label class="fld"><span>税种 *</span>
              <select v-model="polForm.tax_type"><option v-for="t in dict.tax_types" :key="t.key" :value="t.key">{{ t.label }}</option></select>
            </label>
            <label class="fld"><span>税率（%）*</span><input v-model.number="polForm.rate" type="number" min="0" max="100" step="0.01" /></label>
            <label class="fld"><span>价格口径</span>
              <select v-model="polForm.price_includes_tax">
                <option :value="1">含税价（采购票据）</option>
                <option :value="0">不含税价（收入）</option>
              </select>
            </label>
            <label class="fld"><span>生效日 *</span><input v-model="polForm.effective_from" type="date" /></label>
            <label class="fld"><span>截止日</span><input v-model="polForm.effective_to" type="date" /></label>
            <label class="fld"><span>政策文号</span><input v-model="polForm.policy_no" placeholder="如 财政部 税务总局公告2019年第39号" /></label>
            <label class="fld wide"><span>备注</span><input v-model="polForm.remark" /></label>
          </div>
          <p class="tiny muted">保存后旧的生效税率会自动标为「已被替代」，历史批次仍引用当时那条。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="savePolicy">保存</button>
        </div>
      </div>
    </div>

    <!-- 批次明细 -->
    <div v-if="modal === 'run' && curRun" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ curRun.run_no }} · {{ curRun.company_name }} · {{ curRun.period }}</h3>
          <button class="x" @click="modal = ''">×</button>
        </div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="runTag(curRun.status)">{{ curRun.status_label }}</span>
            <span class="tag gray">{{ curRun.region_label }}</span>
            <span class="tiny muted">收入 {{ money(curRun.revenue_total) }} · 合计税负 {{ money(curRun.total_burden) }} · 税负率 {{ curRun.burden_rate }}%</span>
          </div>

          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th style="width: 150px">税种</th><th class="num" style="width: 120px">依据</th><th class="num" style="width: 66px">税率</th>
                <th class="num" style="width: 120px">税额</th><th>算式</th></tr></thead>
              <tbody>
                <tr v-for="it in curRun.items" :key="it.id">
                  <td><b>{{ it.label }}</b><div v-if="it.note" class="tiny muted">{{ it.note }}</div></td>
                  <td class="num">{{ money(it.base_amount) }}</td>
                  <td class="num">{{ it.rate === null ? '—' : it.rate + '%' }}</td>
                  <td class="num">{{ money(it.amount) }}</td>
                  <td class="tiny">{{ it.formula }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h4 style="margin-top: 14px">当时用的税率<small>政策改版后这里仍显示当年那条</small></h4>
          <div class="kv">
            <div v-for="(v, k) in (curRun.policy || {})" :key="k">
              <span>{{ typeLabel(k) }}</span><b>{{ v.rate }}%（{{ v.effective_from }} 起）</b>
            </div>
          </div>
          <div v-if="curRun.note" class="tiny muted">备注：{{ curRun.note }}</div>
          <div class="warn-row" style="margin-top: 10px">测算不等于已申报；本批 {{ curRun.status === 'confirmed' ? '已内部确认' : '仍为草稿' }}，申报以税务机关核定为准。</div>
        </div>
        <div class="modal-foot">
          <button v-action="['tax','export']" class="btn btn-ghost" @click="exportRun(curRun)">导出底稿</button>
          <button v-if="curRun.status === 'draft'" class="btn btn-primary" @click="doConfirm">确认这一版</button>
          <button v-if="curRun.status !== 'void'" class="btn btn-ghost" @click="openVoid">作废</button>
          <button class="btn btn-ghost" @click="modal = ''">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="modal === 'void'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>作废测算批次</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="det-line">{{ curRun && curRun.run_no }}</p>
          <label class="fld"><span>作废原因 *</span><textarea v-model="voidReason" rows="3" placeholder="如 收入未入齐，需重算" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" @click="doVoid">确认作废</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
import { ref, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const tab = ref('calc');
const dict = ref({ companies: [], regions: [], tax_types: [], run_status: [] });
const ov = ref({});
const loading = ref(false);
const saving = ref(false);
const preview = ref(null);
const runs = ref([]);
const policies = ref([]);
const trend = ref([]);
const curRun = ref(null);
const modal = ref('');
const voidReason = ref('');

const form = ref({ company_id: null, tax_region: 'CN', period: '' });
const polFilter = ref({ company_id: '', status: '' });
const polForm = ref({});

const canWrite = computed(() => can('tax.write'));
const activePolicies = computed(() => policies.value.filter((p) => p.status === 'active').length);
const supersededPolicies = computed(() => policies.value.filter((p) => p.status === 'superseded').length);

const money = (v) => '¥' + (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const runTag = (s) => ({ draft: 'orange', confirmed: 'green', void: 'gray' }[s] || 'gray');
const typeLabel = (k) => ({ vat: '增值税', surcharge: '附加税', cit: '企业所得税', export_rebate: '出口退税', stamp: '印花税' }[k] || k);
const rateOf = (type) => {
  const p = policies.value.find((x) => x.company_id === preview.value?.company_id
    && x.tax_region === preview.value?.tax_region && x.tax_type === type && x.status === 'active');
  return p ? p.rate : '—';
};
const barH = (rate) => {
  const max = Math.max(2, ...trend.value.map((t) => Math.abs(t.burden_rate || 0)));
  return Math.max(4, Math.round((Math.abs(rate || 0) / max) * 96)) + '%';
};

async function loadOv() {
  ov.value = await api.taxOverview();
}
async function loadPolicies() {
  policies.value = await api.taxPolicies(polFilter.value);
}
async function loadRuns() {
  runs.value = await api.taxRuns({ company_id: form.value.company_id, tax_region: form.value.tax_region });
}
async function loadTrend() {
  trend.value = await api.taxTrend({ company_id: form.value.company_id || 1, tax_region: form.value.tax_region, months: 6 });
}
async function reloadAll() {
  await loadOv();
  if (tab.value === 'calc') { await loadRuns(); await loadTrend(); } else { await loadPolicies(); }
}
function go(t) {
  tab.value = t;
  if (t === 'calc') { loadRuns(); loadTrend(); } else { loadPolicies(); }
}

async function doPreview() {
  loading.value = true;
  preview.value = null;
  try {
    preview.value = await api.taxPreview({
      company_id: form.value.company_id,
      tax_region: form.value.tax_region,
      period: form.value.period
    });
    if (!policies.value.length) await loadPolicies();
  } catch (e) {
    alert(e.message);
  } finally {
    loading.value = false;
  }
}

async function saveRun() {
  saving.value = true;
  try {
    const r = await api.saveTaxRun({
      company_id: preview.value.company_id,
      tax_region: preview.value.tax_region,
      period: preview.value.period
    });
    await Promise.all([loadRuns(), loadOv(), loadTrend()]);
    curRun.value = r;
    modal.value = 'run';
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function openRun(id) {
  curRun.value = await api.taxRun(id);
  modal.value = 'run';
}
async function doConfirm() {
  const note = prompt('确认备注（可空）：', '与账面对账后确认') || '';
  try {
    curRun.value = await api.confirmTaxRun(curRun.value.id, { note });
    await Promise.all([loadRuns(), loadOv()]);
  } catch (e) { alert(e.message); }
}
function openVoid() {
  voidReason.value = '';
  modal.value = 'void';
}
async function doVoid() {
  try {
    curRun.value = await api.voidTaxRun(curRun.value.id, { reason: voidReason.value });
    modal.value = 'run';
    await Promise.all([loadRuns(), loadOv(), loadTrend()]);
  } catch (e) { alert(e.message); }
}
async function exportRun(r) {
  try {
    const blob = await downloadFile(`/api/tax/runs/${r.id}/export`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tax-${r.run_no}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}

function openPolicy() {
  const c0 = dict.value.companies[0];
  polForm.value = {
    company_id: c0 ? c0.id : 1, tax_region: 'CN', tax_type: 'vat', rate: 13,
    price_includes_tax: 1, effective_from: dict.value.today || localDate(),
    effective_to: '', policy_no: '', remark: ''
  };
  modal.value = 'policy';
}
async function savePolicy() {
  saving.value = true;
  try {
    await api.createTaxPolicy(polForm.value);
    modal.value = '';
    await Promise.all([loadPolicies(), loadOv()]);
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  dict.value = await api.taxDict();
  form.value.company_id = dict.value.companies[0] ? dict.value.companies[0].id : 1;
  form.value.period = (dict.value.today || localDate()).slice(0, 7);
  await loadOv();
  await loadPolicies();
  await loadRuns();
  await loadTrend();
});
</script>

<style scoped>
.page { max-width: 1500px; }
.page-head .sub { max-width: 940px; }
.head-ops { display: flex; align-items: center; gap: 10px; flex: none; flex-wrap: nowrap; }
.head-ops .btn { white-space: nowrap; }
.pill { display: inline-block; white-space: nowrap; font-size: 12px; font-weight: 700; border-radius: 6px; padding: 4px 9px; }
.p-gray { background: #eef1f6; color: var(--ink-soft); }

.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { font-size: 12px; color: var(--ink-mute); display: block; }
.stat strong { font-size: 21px; color: #16305f; display: block; margin-top: 4px; line-height: 1.1; }
.stat small { font-size: 12px; color: #9aa4b5; display: block; margin-top: 4px; }
.stat.st-warn { border-color: #f5d9a8; background: #fffdf7; }
.stat.st-bad { border-color: #f3c2c9; background: #fffafb; }
.tiny-strong { font-size: 15px !important; }

.tabbar { display: flex; margin-bottom: 10px; }
.tabs { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; }
.tabs button {
  flex: 0 0 auto; white-space: nowrap; padding: 8px 14px; border: 1px solid #e2e8f2; background: var(--surface);
  border-radius: 9px; font-size: 13px; color: var(--ink-soft); cursor: pointer; font-family: inherit;
}
.tabs button.on { background: var(--brand); border-color: #2b6de5; color: var(--on-brand); font-weight: 700; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; border-radius: 9px; padding: 0 5px; font-size: 12px; }

.toolbar select, .toolbar input { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; }
.spacer { flex: 1; }
.tiny { font-size: 12px; }
.muted { color: var(--ink-mute); }
.blue { color: var(--brand); }
.red { color: #d92d45; font-weight: 700; }
.nowrap { white-space: nowrap; }
.lnk { color: var(--brand); cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.link-btn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.empty-box { text-align: center; color: #9aa4b5; padding: 20px 0; font-size: 13px; }
.row-off { background: var(--surface-2); color: var(--ink-mute); }
.hint-bar { background: #f2f7ff; border: 1px solid #d6e4ff; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; color: var(--ink); margin-bottom: 12px; line-height: 1.7; }
.hint-bar b { color: #16305f; }

.calc-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px 16px; margin-bottom: 6px; }
.cc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.cc-head .spacer { flex: 1; }
.cc-head b { font-size: 14px; color: var(--ink); }
.calc-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.cg-item { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--surface-2); }
.cg-item span { font-size: 12px; color: var(--ink-mute); display: block; }
.cg-item b { font-size: 16px; color: #16305f; display: block; margin-top: 3px; }
.cg-item small { font-size: 12px; color: #9aa4b5; display: block; margin-top: 4px; line-height: 1.4; }
.cg-item.cg-bad { background: #fffdf7; border-color: #f5d9a8; }
.calc-total { display: flex; align-items: baseline; gap: 10px; margin-top: 12px; padding: 10px 12px; background: #f7faff; border: 1px solid #dbe7ff; border-radius: 10px; }
.calc-total span { font-size: 12px; color: var(--ink-soft); }
.calc-total b { font-size: 20px; color: #16305f; }
.warn-row { margin-top: 8px; font-size: 12px; color: #8a5b00; background: #fffdf5; border: 1px solid #f5e3b3; border-radius: 8px; padding: 7px 10px; line-height: 1.6; }

.trend { display: flex; align-items: flex-end; gap: 18px; background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 16px 18px; min-height: 140px; }
.tr-col { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 60px; }
.tr-bar { height: 92px; width: 26px; display: flex; align-items: flex-end; }
.tr-bar i { display: block; width: 100%; border-radius: 5px 5px 0 0; }
.bar-ok { background: var(--brand); }
.bar-blue { background: #8fb4f5; }
.tr-col b { font-size: 12px; color: #16305f; }
.tr-col span { font-size: 12px; color: #9aa4b5; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-grid .wide { grid-column: 1/-1; }
.fld { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--ink-soft); }
.fld > span { font-weight: 600; }
.fld input, .fld select, .fld textarea {
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px;
  font-family: inherit; width: 100%; box-sizing: border-box; background: var(--surface);
}
.det-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.det-line { margin: 0 0 8px; font-size: 13.5px; color: var(--ink); }
.modal-body h4 { font-size: 13px; color: var(--ink); margin: 0 0 8px; }
.modal-body h4 small { font-weight: 400; color: #9aa4b5; margin-left: 6px; font-size: 12px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; }
.kv > div { display: flex; gap: 10px; font-size: 12.5px; border-bottom: 1px dashed #f0f3f8; padding-bottom: 5px; }
.kv span { color: var(--ink-mute); width: 110px; flex: none; }
.kv b { color: var(--ink); font-weight: 600; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .calc-grid { grid-template-columns: repeat(2, 1fr); }
  .form-grid, .kv { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; align-items: flex-start; }
  .head-ops { flex-wrap: wrap; }
  .trend { overflow-x: auto; }
}
</style>
