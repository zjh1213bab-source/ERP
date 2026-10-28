<template>
  <div class="ps-wrap">
    <!-- 工具栏（打印时隐藏） -->
    <div class="ps-bar no-print">
      <button class="btn btn-ghost btn-sm" @click="back">← 返回</button>
      <div class="ps-tabs">
        <button :class="{ on: mode === 'public' }" @click="switchMode('public')">车间公示表</button>
        <button :class="{ on: mode === 'person' }" @click="switchMode('person')">个人工资条</button>
      </div>
      <span class="tiny muted">
        {{ mode === 'public' ? '姓名脱敏、按金额排名，贴车间墙上用' : '每人一条、虚线裁开，发到手上签字用' }}
      </span>
      <span class="sp"></span>
      <button class="btn btn-ghost btn-sm" @click="load">刷新</button>
      <button class="btn btn-primary btn-sm" @click="doPrint">打印 / 存 PDF</button>
    </div>

    <div v-if="err" class="ps-err no-print">
      <b>出不了工资条</b>
      <p>{{ err }}</p>
    </div>

    <div v-if="data" class="ps-sheet">
      <!-- 表头 -->
      <div class="ps-head">
        <div>
          <h1>{{ mode === 'public' ? '计件工资公示表' : '计件工资条' }}</h1>
          <div class="ps-sub">
            {{ data.run.period }} 月度核算 ·
            核算单 <b>{{ data.run.run_no }}</b> ·
            {{ data.run.employees_count }} 人 / {{ fmt(data.run.total_qty) }} 件 / ¥{{ money2(data.run.total_amount) }}
          </div>
        </div>
        <div class="ps-stamp">
          <div>确认人：{{ data.run.confirmed_by || '—' }}</div>
          <div>确认时间：{{ $fmt(data.run.confirmed_at) }}</div>
        </div>
      </div>

      <!-- 车间公示表 -->
      <table v-if="mode === 'public'" class="ps-table">
        <thead>
          <tr>
            <th style="width: 42px">序</th>
            <th style="width: 84px">工号</th>
            <th style="width: 130px">姓名</th>
            <th style="width: 96px">部门</th>
            <th class="r" style="width: 82px">件数</th>
            <th class="r" style="width: 100px">金额（元）</th>
            <th style="min-width: 140px">核对签字</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in data.rows" :key="r.employee_id">
            <td class="c">{{ r.seq }}</td>
            <td class="mono">{{ r.employee_code }}</td>
            <td><b>{{ r.mask_name }}</b></td>
            <td class="tiny">{{ r.department }}</td>
            <td class="r">{{ fmt(r.qty) }}</td>
            <td class="r b">¥{{ money(r.amount) }}</td>
            <td></td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="4" class="r"><b>合计</b></td>
            <td class="r b">{{ fmt(data.summary.total_qty) }}</td>
            <td class="r b">¥{{ money(data.summary.total_amount) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <!-- 个人工资条 -->
      <div v-else class="ps-cards">
        <div v-for="r in data.rows" :key="r.employee_id" class="ps-card">
          <div class="psc-head">
            <span class="psc-name">{{ r.employee_name }}</span>
            <span class="psc-code">{{ r.employee_code }}</span>
            <span class="psc-dept">{{ r.department }}</span>
          </div>
          <div class="psc-period">{{ data.run.period }} 计件 · {{ data.run.run_no }}</div>
          <table class="psc-table">
            <thead>
              <tr><th>工序 / 订单</th><th class="r">件数</th><th class="r">单价</th><th class="r">金额</th></tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in r.lines.slice(0, 8)" :key="i">
                <td>
                  {{ l.process_name }}
                  <span class="psc-order">{{ l.order_no }}</span>
                </td>
                <td class="r">{{ fmt(l.qty) }}</td>
                <td class="r">{{ money(l.unit_price) }}</td>
                <td class="r">{{ money(l.amount) }}</td>
              </tr>
              <tr v-if="r.lines.length > 8">
                <td colspan="4" class="tiny psc-more">另有 {{ r.lines.length - 8 }} 项明细，见系统「计件工资」页</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td class="r"><b>合计（{{ r.item_lines }} 笔）</b></td>
                <td class="r b">{{ fmt(r.qty) }}</td>
                <td></td>
                <td class="r b">¥{{ money(r.amount) }}</td>
              </tr>
            </tfoot>
          </table>
          <div class="psc-foot">
            <span>本人确认：</span>
            <span class="psc-sign"></span>
            <span class="psc-date">日期：</span>
            <span class="psc-sign short"></span>
          </div>
          <div v-if="r.capped_lines || r.att_flagged" class="psc-note">
            <span v-if="r.capped_lines">· 其中 {{ r.capped_lines }} 笔按上限封顶（超报/单日超出部分未计）</span>
            <span v-if="r.att_flagged">· 其中 {{ r.att_flagged }} 笔落在请假/缺勤日，已按规则处理</span>
          </div>
        </div>
      </div>

      <!-- 页脚口径：工人拿着条子来问时，纸面上要能自证 -->
      <div class="ps-foot">
        <div class="ps-terms">
          <b>口径说明</b>
          <span>① 只计合格数，不良不计；② 同一扎同一工序累计不超过扎件数，超出部分不计；</span>
          <span>③ 缺单价的工序不按 0 计，需先补价；④ 单价按报工日期生效版本取，改价不改历史。</span>
          <span v-if="data.run.capped_count">本期超报封顶 {{ data.run.capped_count }} 笔。</span>
          <span v-if="data.run.att_conflict_count">本期报工日请假/缺勤 {{ data.run.att_conflict_count }} 笔<template v-if="data.run.att_excluded_count">（其中 {{ data.run.att_excluded_count }} 笔已剔除不计）</template>。</span>
          <span v-if="data.run.unassigned_count">无法归属到人的报工 {{ data.run.unassigned_count }} 笔，未计入本表。</span>
        </div>
        <div class="ps-sign-line">
          <span>制表：________________</span>
          <span>审核：________________</span>
          <span>公示日期：____年____月____日</span>
          <span class="ps-gen">系统生成 {{ $fmt(now) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const runId = route.params.runId;
const mode = ref(route.query.mode === 'public' ? 'public' : 'person');
const data = ref(null);
const err = ref('');
const now = ref('');

const money = (v) => (Number(v) || 0).toFixed(2);
// 副标题里的合计要带千分位又要两位小数（toFixed 没有千分位，toLocaleString 默认会砍掉 .40）
const money2 = (v) =>
  Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v) => Number(v || 0).toLocaleString('zh-CN');

async function load() {
  err.value = '';
  try {
    data.value = await api.piecePayslips(runId, mode.value);
    now.value = new Date().toISOString();   // 显示交给 $fmt，口径与全站一致
  } catch (e) {
    data.value = null;
    err.value = e.message;
  }
}

function switchMode(m) {
  mode.value = m;
  load();
}

function doPrint() {
  window.print();
}

function back() {
  router.push('/piece-wage');
}

onMounted(load);
</script>

<style scoped>
.ps-wrap {
  min-height: 100vh;
  background: #eef1f6;
  padding: 14px;
}
.ps-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  max-width: 1100px;
  margin: 0 auto 14px;
  padding: 10px 14px;
  background: #fff;
  border: 1px solid #e6ebf3;
  border-radius: 12px;
}
.ps-bar .sp { flex: 1; }
.ps-tabs {
  display: inline-flex;
  border: 1px solid #dfe5ef;
  border-radius: 9px;
  overflow: hidden;
}
.ps-tabs button {
  border: 0;
  background: #fff;
  padding: 7px 14px;
  font-size: 13px;
  color: #4b5568;
  cursor: pointer;
}
.ps-tabs button.on {
  background: #2b6de5;
  color: #fff;
  font-weight: 700;
}
.ps-err {
  max-width: 1100px;
  margin: 0 auto;
  padding: 18px 20px;
  background: #fdf3f4;
  border: 1px solid #f3c6cd;
  border-radius: 12px;
  color: #b02a3c;
}
.ps-sheet {
  max-width: 1100px;
  margin: 0 auto;
  background: #fff;
  border-radius: 12px;
  padding: 22px 26px;
  box-shadow: 0 2px 12px rgba(16, 32, 64, 0.06);
}
.ps-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  border-bottom: 2px solid #16233b;
  padding-bottom: 10px;
  margin-bottom: 14px;
}
.ps-head h1 {
  margin: 0 0 4px;
  font-size: 20px;
  color: #16233b;
  letter-spacing: 1px;
}
.ps-sub {
  font-size: 12.5px;
  color: #6b7688;
}
.ps-stamp {
  text-align: right;
  font-size: 12px;
  color: #6b7688;
  line-height: 1.7;
}
.ps-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.ps-table th,
.ps-table td {
  border: 1px solid #d8dee9;
  padding: 7px 8px;
}
.ps-table th {
  background: #f4f6fa;
  font-weight: 700;
  color: #16233b;
}
.ps-table tfoot td {
  background: #f9fafc;
  font-weight: 700;
}
.ps-table .r { text-align: right; }
.ps-table .c { text-align: center; }
.ps-table .b { font-weight: 700; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }

/* 个人工资条：两列，虚线可裁 */
.ps-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.ps-card {
  border: 1px dashed #b9c2d0;
  border-radius: 6px;
  padding: 10px 12px 8px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.psc-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.psc-name {
  font-size: 15px;
  font-weight: 700;
  color: #16233b;
}
.psc-code {
  font-size: 11.5px;
  color: #8a94a6;
  font-family: ui-monospace, Consolas, monospace;
}
.psc-dept {
  font-size: 11.5px;
  color: #6b7688;
  margin-left: auto;
}
.psc-period {
  font-size: 11px;
  color: #8a94a6;
  margin: 2px 0 6px;
}
.psc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.psc-table th,
.psc-table td {
  border-bottom: 1px solid #edf0f5;
  padding: 3px 4px;
}
.psc-table th {
  color: #6b7688;
  font-weight: 700;
  text-align: left;
}
.psc-table .r { text-align: right; }
.psc-table .b { font-weight: 700; color: #16233b; }
.psc-table tfoot td {
  border-top: 1px solid #d8dee9;
  border-bottom: 0;
  padding-top: 5px;
}
.psc-order {
  color: #a0aabb;
  font-size: 10px;
  margin-left: 4px;
}
.psc-more { color: #8a94a6; text-align: center; }
.psc-note {
  margin-top: 4px;
  font-size: 10px;
  color: #b45309;
  line-height: 1.5;
}
.psc-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 11px;
  color: #4b5568;
}
.psc-sign {
  display: inline-block;
  border-bottom: 1px solid #9aa4b5;
  min-width: 96px;
  height: 14px;
}
.psc-sign.short { min-width: 70px; }
.psc-date { margin-left: 6px; }
.ps-foot {
  margin-top: 16px;
  border-top: 1px solid #e6ebf3;
  padding-top: 10px;
}
.ps-terms {
  font-size: 10.5px;
  color: #6b7688;
  line-height: 1.7;
}
.ps-terms b { color: #16233b; margin-right: 6px; }
.ps-terms span { margin-right: 8px; }
.ps-sign-line {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 11.5px;
  color: #4b5568;
}
.ps-gen {
  margin-left: auto;
  color: #a0aabb;
  font-size: 10.5px;
}

@media (max-width: 900px) {
  .ps-cards { grid-template-columns: 1fr; }
  .ps-head { flex-direction: column; }
  .ps-stamp { text-align: left; }
}

@media print {
  @page { size: A4; margin: 10mm; }
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .ps-wrap { background: #fff; padding: 0; }
  .ps-sheet {
    box-shadow: none;
    border-radius: 0;
    padding: 0;
    max-width: none;
  }
  .ps-table { font-size: 10.5px; }
  .ps-table th, .ps-table td { padding: 4px 5px; }
  .ps-table thead { display: table-header-group; }
  .ps-card { font-size: 10px; }
  .psc-table { font-size: 9.5px; }
  .ps-cards { gap: 6px; }
  /* 一张 A4 放 6 条（3 行 × 2 列）最舒服：再多字就小到看不清 */
  .ps-card { padding: 8px 10px 6px; }
}
</style>
