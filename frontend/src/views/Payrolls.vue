<template>
  <div>
    <div class="page-head">
      <div>
        <h2>薪酬核算</h2>
        <div class="sub">按在职员工生成月度工资单 · 缺勤/加班/奖金可调 · 确认后发放</div>
      </div>
      <div class="toolbar">
        <input class="input" type="month" v-model="period" style="width: 150px" @change="load" />
        <button v-if="canWrite" class="btn btn-primary" :disabled="generating" @click="generate">
          {{ generating ? '生成中…' : '生成工资单' }}
        </button>
      </div>
    </div>

    <!-- 汇总 -->
    <div class="cards">
      <div class="stat-card"><div class="label">人数</div><div class="value">{{ summary.count || 0 }}<small>人</small></div></div>
      <div class="stat-card"><div class="label">应发合计</div><div class="value">¥{{ money(summary.gross_pay) }}</div></div>
      <div class="stat-card accent"><div class="label">实发合计</div><div class="value">¥{{ money(summary.net_pay) }}</div></div>
      <div class="stat-card"><div class="label">个税合计</div><div class="value">¥{{ money(summary.tax) }}</div></div>
    </div>
    <div class="muted" style="font-size: 12px; margin: -8px 0 14px">
      个人社保合计 ¥{{ money(summary.social_insurance) }}　·　加班费合计 ¥{{ money(summary.overtime_pay) }}　·　奖金合计 ¥{{ money(summary.bonus) }}　·　<b>计件合计 ¥{{ money(summary.piece_wage) }}</b>　·　当月工作日 {{ summary.work_days || 0 }} 天
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="draft">草稿</option>
        <option value="confirmed">已确认</option>
        <option value="paid">已发放</option>
      </select>
      <button class="btn btn-ghost" @click="load">刷新</button>
      <button v-if="canWrite" class="btn btn-ghost btn-sm" :disabled="!draftIds.length" @click="batch('confirm')">
        批量确认（{{ draftIds.length }}）
      </button>
      <button v-if="canWrite" class="btn btn-ghost btn-sm" :disabled="!confirmedIds.length" @click="batch('pay')">
        批量发放（{{ confirmedIds.length }}）
      </button>
      <button class="btn btn-ghost btn-sm" @click="exportCsv">导出 CSV</button>
      <span class="muted" style="font-size: 12px; margin-left: auto">有 {{ list.length }} 条记录</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 34px"><input type="checkbox" :checked="allChecked" @change="toggleAll" /></th>
            <th>部门</th><th>姓名</th>
            <th class="num">基本工资</th>
            <th class="num">应出勤</th><th class="num">实出勤</th>
            <th class="num">请假</th><th class="num">缺勤</th>
            <th class="num">加班(h)</th>
            <th class="num">加班费</th><th class="num">奖金</th><th class="num">补贴</th>
            <th class="num">计件</th>
            <th class="num">扣款</th><th class="num">社保</th><th class="num">个税</th>
            <th class="num">应发</th><th class="num">实发</th>
            <th>状态</th><th style="width: 150px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td><input type="checkbox" :value="r.id" v-model="checked" /></td>
            <td class="nowrap">{{ r.department || '-' }}</td>
            <td class="nowrap"><strong>{{ r.employee_name }}</strong></td>
            <td class="num">{{ money(r.base_salary) }}</td>
            <td class="num">{{ r.work_days }}</td>
            <td class="num">{{ r.actual_days }}</td>
            <td class="num">{{ r.leave_days || 0 }}</td>
            <td class="num">{{ r.absent_days || 0 }}</td>
            <td class="num">{{ r.overtime_hours || 0 }}</td>
            <td class="num">{{ money(r.overtime_pay) }}</td>
            <td class="num">{{ money(r.bonus) }}</td>
            <td class="num">{{ money(r.allowance) }}</td>
            <td class="num" :style="{ color: r.piece_wage ? '#2563eb' : '#8a94a6', fontWeight: r.piece_wage ? 700 : 400 }">
              {{ money(r.piece_wage) }}
            </td>
            <td class="num">{{ money(r.deduction) }}</td>
            <td class="num">{{ money(r.social_insurance) }}</td>
            <td class="num">{{ money(r.tax) }}</td>
            <td class="num"><strong>{{ money(r.gross_pay) }}</strong></td>
            <td class="num"><strong>{{ money(r.net_pay) }}</strong></td>
            <td class="nowrap"><span class="tag" :class="r.status === 'paid' ? 'green' : r.status === 'confirmed' ? 'blue' : 'gray'">{{ r.status_label }}</span></td>
            <td style="white-space: nowrap">
              <button v-if="r.status === 'draft' && canWrite" class="link-btn" @click="openEdit(r)">调整</button>
              <button v-if="r.status === 'draft' && canWrite" class="link-btn" @click="act(r, 'confirm')">确认</button>
              <button v-if="r.status === 'confirmed' && canWrite" class="link-btn" @click="act(r, 'pay')">发放</button>
              <button v-if="r.status === 'draft' && canWrite" class="link-btn danger" @click="remove(r)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td colspan="19" class="empty-cell">
              本月还没有工资单，点右上「生成工资单」（需先在人事行政·员工档案里填「基本工资」）
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 调整 -->
    <div v-if="edit" class="modal-mask" @click.self="edit = null">
      <div class="modal">
        <div class="modal-head">
          <h3>调整工资 · {{ edit.employee_name }}（{{ edit.period }}）</h3>
          <button class="x" @click="edit = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>基本工资（只读）</label><input class="input" :value="money(edit.base_salary)" disabled /></div>
            <div class="fitem"><label>应出勤（只读）</label><input class="input" :value="edit.work_days + ' 天'" disabled /></div>
            <div class="fitem"><label>请假天数</label><input class="input" type="number" step="0.5" v-model.number="edit.leave_days" /></div>
            <div class="fitem"><label>缺勤天数</label><input class="input" type="number" step="0.5" v-model.number="edit.absent_days" /></div>
            <div class="fitem"><label>加班小时</label><input class="input" type="number" step="0.5" v-model.number="edit.overtime_hours" /></div>
            <div class="fitem"><label>奖金</label><input class="input" type="number" step="0.01" v-model.number="edit.bonus" /></div>
            <div class="fitem"><label>补贴</label><input class="input" type="number" step="0.01" v-model.number="edit.allowance" /></div>
            <div class="fitem">
              <label>计件工资（只读，来自计件核算单）</label>
              <input class="input" :value="money(edit.piece_wage)" disabled />
            </div>
            <div class="fitem"><label>其他扣款</label><input class="input" type="number" step="0.01" v-model.number="edit.deduction" /></div>
            <div class="fitem"><label>个人社保</label><input class="input" type="number" step="0.01" v-model.number="edit.social_insurance" /></div>
            <div class="fitem full"><label>备注</label><textarea v-model="edit.remark" rows="2"></textarea></div>
          </div>
          <table class="data" style="margin-top: 14px">
            <tbody>
              <tr><th style="width: 130px">日薪</th><td>¥{{ money(edit.daily_salary) }}</td>
                <th style="width: 130px">缺勤扣款</th><td>¥{{ money(edit.absent_cut) }}</td></tr>
              <tr><th>加班费</th><td>¥{{ money(edit.overtime_pay) }}</td>
                <th>个税</th><td>¥{{ money(edit.tax) }}</td></tr>
              <tr><th>应发</th><td><strong>¥{{ money(edit.gross_pay) }}</strong></td>
                <th>实发</th><td><strong>¥{{ money(edit.net_pay) }}</strong></td></tr>
            </tbody>
          </table>
          <p class="muted" style="font-size: 12px; margin: 10px 0 0">
            个税按「应发 − 个人社保 − 5000」套月度税率表（3%~45% 含速算扣除）；保存后自动重算，可再手工改社保。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="edit = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存并重算' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('payroll.write'));

const now = new Date();
const period = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
const status = ref('');
const list = ref([]);
const summary = ref({});
const checked = ref([]);
const generating = ref(false);
const saving = ref(false);
const edit = ref(null);

const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const draftIds = computed(() => list.value.filter((r) => r.status === 'draft').map((r) => r.id));
const confirmedIds = computed(() => list.value.filter((r) => r.status === 'confirmed').map((r) => r.id));
const allChecked = computed(() => list.value.length > 0 && checked.value.length === list.value.length);

function toggleAll(e) {
  checked.value = e.target.checked ? list.value.map((r) => r.id) : [];
}

async function load() {
  try {
    const [rows, sum] = await Promise.all([
      api.payrolls({ period: period.value, status: status.value }),
      api.payrollSummary(period.value)
    ]);
    list.value = rows;
    summary.value = sum;
    checked.value = [];
  } catch (e) {
    alert(e.message);
  }
}

async function generate() {
  if (!confirm(`按在职员工生成 ${period.value} 的工资单？已存在且为草稿的会被重算。`)) return;
  generating.value = true;
  try {
    const r = await api.generatePayrolls(period.value, true);
    await load();
    const lines = [
      `生成完成：新增 ${r.created} 条，重算 ${r.refreshed} 条，跳过 ${r.skipped} 条（已确认/已发放不覆盖）`
    ];
    if (r.piece_wage_run) {
      lines.push(
        `\n计件工资：带入 ${r.piece_wage_employees} 人 / ¥${money(r.piece_wage_total)}（核算单 ${r.piece_wage_run.run_no}，总额 ¥${money(r.piece_wage_run.total_amount)}）`
      );
      // 计件算出来了但工资单已确认/已发放 → 钱进不去，必须说出来
      if (r.warnings && r.warnings.length) {
        lines.push(`\n⚠ 有 ${r.warnings.length} 人的计件没进单：`);
        r.warnings.slice(0, 6).forEach((w) => {
          lines.push(`  · ${w.employee_name}：${w.reason}，计件 ¥${money(w.piece_wage)} 未带入`);
        });
        if (r.warnings.length > 6) lines.push(`  … 还有 ${r.warnings.length - 6} 人，去「计件工资」页核对`);
      }
    } else {
      lines.push('\n本月还没有「已确认」的计件核算单，计件列全部为 0（去「计件工资」生成并确认）');
    }
    alert(lines.join('\n'));
  } catch (e) {
    alert(e.message);
  } finally {
    generating.value = false;
  }
}

function openEdit(r) {
  edit.value = { ...r };
}

async function save() {
  saving.value = true;
  try {
    const payload = {
      leave_days: Number(edit.value.leave_days) || 0,
      absent_days: Number(edit.value.absent_days) || 0,
      overtime_hours: Number(edit.value.overtime_hours) || 0,
      bonus: Number(edit.value.bonus) || 0,
      allowance: Number(edit.value.allowance) || 0,
      deduction: Number(edit.value.deduction) || 0,
      social_insurance: Number(edit.value.social_insurance) || 0,
      remark: edit.value.remark || null
    };
    await api.updatePayroll(edit.value.id, payload);
    edit.value = null;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function act(r, action) {
  const txt = action === 'confirm' ? '确认' : '标记发放';
  if (!confirm(`确定${txt} ${r.employee_name} 的工资单？`)) return;
  try {
    if (action === 'confirm') await api.confirmPayroll(r.id);
    else await api.payPayroll(r.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function batch(action) {
  const ids = action === 'confirm' ? draftIds.value : confirmedIds.value;
  if (!ids.length) return;
  const txt = action === 'confirm' ? '确认' : '发放';
  if (!confirm(`批量${txt} ${ids.length} 条工资单？`)) return;
  try {
    const r = await api.batchPayroll(action, ids);
    await load();
    alert(`${txt}完成：成功 ${r.changed} 条，跳过 ${r.skipped} 条`);
  } catch (e) {
    alert(e.message);
  }
}

async function remove(r) {
  if (!confirm(`删除 ${r.employee_name} 的工资单？`)) return;
  try {
    await api.deletePayroll(r.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function exportCsv() {
  try {
    const b = await downloadFile('/api/payrolls/export?period=' + period.value);
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-${period.value}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    alert(e.message);
  }
}

onMounted(load);
</script>

<style scoped>
/* 工资单列多，桌面端也允许横向滚动，避免文字被挤成竖排 */
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1280px; }
.nowrap { white-space: nowrap; }
</style>
