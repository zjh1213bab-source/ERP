<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>生产交付效率与质量</h2>
        <p class="sub">
          固定看<b>准交率、延期原因、工序效率、一次合格率、返工报废率、在制龄、材料利用、计划实际差异</b>。
          每个指标都带分母与覆盖率 —— <b>算不出来就写「—」，不填 0、不取平均、不拿分子当分母</b>。
        </p>
      </div>
      <div class="head-ops">
        <input v-model="period" type="month" class="input" style="width: 150px" @change="reload" />
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button class="btn btn-ghost" @click="doExport('on_time')">导出准交</button>
        <button class="btn btn-ghost" @click="doExport('efficiency')">导出效率</button>
      </div>
    </div>

    <!-- 口径：这八条必须让人看见，否则数字会被误读 -->
    <details class="caliber" open>
      <summary>口径说明（点开看八条，都是「不美化」的边界）</summary>
      <ol>
        <li v-for="(c, i) in data.calibers || []" :key="i" v-html="md(c)"></li>
      </ol>
    </details>

    <!-- KPI -->
    <div class="cards c6">
      <div class="stat-card accent">
        <div class="label">准交率</div>
        <div class="value">{{ data.kpi && data.kpi.on_time_rate != null ? data.kpi.on_time_rate + '%' : '—' }}</div>
        <div class="foot">{{ data.kpi ? data.kpi.on_time_detail : '' }} · {{ data.on_time ? data.on_time.primary_label : '' }}</div>
      </div>
      <div class="stat-card">
        <div class="label">一次合格率</div>
        <div class="value">{{ data.kpi && data.kpi.fpy != null ? data.kpi.fpy + '%' : '—' }}</div>
        <div class="foot">复验合格不计入</div>
      </div>
      <div class="stat-card" :class="{ danger: data.kpi && data.kpi.rework_rate > 10 }">
        <div class="label">返工率</div>
        <div class="value">{{ data.kpi && data.kpi.rework_rate != null ? data.kpi.rework_rate + '%' : '—' }}</div>
        <div class="foot">报废率 {{ data.kpi && data.kpi.scrap_rate != null ? data.kpi.scrap_rate + '%' : '—' }}</div>
      </div>
      <div class="stat-card">
        <div class="label">工序效率</div>
        <div class="value">{{ data.kpi && data.kpi.efficiency != null ? data.kpi.efficiency + '%' : '—' }}</div>
        <div class="foot">工时覆盖 {{ data.kpi && data.kpi.hour_coverage != null ? data.kpi.hour_coverage + '%' : '—' }}</div>
      </div>
      <div class="stat-card">
        <div class="label">在制平均龄</div>
        <div class="value">{{ data.kpi && data.kpi.wip_avg_age != null ? data.kpi.wip_avg_age : '—' }}<small>天</small></div>
        <div class="foot">在制 {{ data.kpi ? data.kpi.wip_total : 0 }} 单</div>
      </div>
      <div class="stat-card">
        <div class="label">裁片合格率</div>
        <div class="value">{{ data.kpi && data.kpi.cut_pass_rate != null ? data.kpi.cut_pass_rate + '%' : '—' }}</div>
        <div class="foot">只算已验完的</div>
      </div>
    </div>

    <!-- 覆盖率 -->
    <div class="panel-card">
      <div class="panel-head">
        <div class="tabs">
          <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="switchTab(t.key)">{{ t.label }}</button>
        </div>
        <span class="muted">期间 {{ data.period || '—' }}</span>
      </div>

      <div class="cov-box">
        <div class="cov-h">各指标的数据基础（覆盖率不到 100% 就说明这个数只代表一部分）</div>
        <table class="data cov-table">
          <thead>
            <tr><th>指标</th><th style="width: 110px">可用 / 总数</th><th style="width: 96px">覆盖率</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in data.coverage || []" :key="c.item">
              <td>{{ c.item }}</td>
              <td>{{ c.available }} / {{ c.total }}</td>
              <td>
                <span :class="covTag(c.rate)">{{ c.rate == null ? '—' : c.rate + '%' }}</span>
              </td>
              <td class="mut">{{ c.note || '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 1. 准交与延期 -->
      <div v-if="tab === 'ontime'">
        <div class="two">
          <div class="mini">
            <div class="mini-h">按实际发运（本期交出去的单里准时几张）</div>
            <div class="mini-v">{{ fmt(data.on_time && data.on_time.by_shipped.rate) }}</div>
            <div class="mut">{{ data.on_time ? `${data.on_time.by_shipped.on_time_count} / ${data.on_time.by_shipped.sample} 准时 · ${data.on_time.by_shipped.not_shipped_count} 未发运` : '' }}</div>
            <div class="mut">{{ data.on_time && data.on_time.by_shipped.rate_note }}</div>
          </div>
          <div class="mini">
            <div class="mini-h">按承诺日到期（本期该交的单里准时几张）</div>
            <div class="mini-v">{{ fmt(data.on_time && data.on_time.by_due.rate) }}</div>
            <div class="mut">{{ data.on_time ? `${data.on_time.by_due.on_time_count} / ${data.on_time.by_due.sample} 准时 · ${data.on_time.by_due.late_count} 延期 · ${data.on_time.by_due.not_shipped_count} 未发运` : '' }}</div>
            <div class="mut">{{ data.on_time && data.on_time.by_due.rate_note }}</div>
          </div>
        </div>

        <div class="two" style="margin-top: 14px">
          <div>
            <div class="sec-h">按订单类型</div>
            <table class="data">
              <thead><tr><th>类型</th><th>单数</th><th>准时</th><th>延期</th><th>未发运</th><th>准交率</th></tr></thead>
              <tbody>
                <tr v-for="r in (data.on_time && data.on_time.by_type) || []" :key="r.type">
                  <td>{{ r.type === 'custom' ? '定制' : (r.type === 'stock' ? '现货' : r.type) }}</td>
                  <td>{{ r.total }}</td><td>{{ r.on_time }}</td><td>{{ r.late }}</td><td>{{ r.not_shipped }}</td>
                  <td>{{ fmt(r.rate) }}</td>
                </tr>
                <tr v-if="!((data.on_time && data.on_time.by_type) || []).length"><td colspan="6" class="empty-cell">本期没有到期或发运的订单</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <div class="sec-h">延期原因（没填的单独列，不归到「其他」）</div>
            <table class="data">
              <thead><tr><th>原因</th><th style="width: 80px">单数</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in (data.on_time && data.on_time.reasons) || []" :key="i">
                  <td :class="{ warnText: !r.reason }">{{ r.label }}</td>
                  <td>{{ r.count }}</td>
                </tr>
                <tr v-if="!((data.on_time && data.on_time.reasons) || []).length"><td colspan="2" class="empty-cell">没有延期单</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="sec-h" style="margin-top: 16px">明细（按延期天数从多到少）</div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>订单号</th><th>客户</th><th>款号</th><th>件数</th><th>原承诺</th><th>实际发运</th><th>状态</th><th>延期</th><th>原因</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in (data.on_time && data.on_time.rows) || []" :key="r.order_no">
                <td>{{ r.order_no }}</td>
                <td>{{ r.customer_name }}</td>
                <td>{{ r.style_no }}</td>
                <td>{{ r.qty }}</td>
                <td>{{ r.promised_date }}</td>
                <td>{{ r.actual_ship_date || '—' }}</td>
                <td><span class="tag" :class="r.status === '准时' ? 'green' : (r.status === '延期' ? 'red' : 'orange')">{{ r.status }}</span></td>
                <td>{{ r.late_days || 0 }} 天</td>
                <td class="mut">{{ r.delay_reason || '（未填）' }}</td>
              </tr>
              <tr v-if="!((data.on_time && data.on_time.rows) || []).length"><td colspan="9" class="empty-cell">本期没有可比的交期数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 2. 工厂段与等待 -->
      <div v-if="tab === 'segment'">
        <div class="warn-box">
          <b>客户准交率不能靠剔除下单前等待来美化。</b>
          下面这张是「工厂段」口径（P1 裁床算料 → E1 出厂发运，实际 vs 计划），
          与上面的客户准交率<b>并列</b>，不相减 —— 两者差的那段是下单前等待与客户变更。
          当前客户准交 {{ fmt(data.on_time && data.on_time.rate) }}，工厂段达成 {{ fmt(data.segments && data.segments.factory_rate) }}。
        </div>

        <div class="sec-h">节点间等待时长（上一节点实际结束 → 下一节点实际开始）</div>
        <table class="data">
          <thead><tr><th>下游节点</th><th>样本</th><th>平均等待</th><th>最长等待</th></tr></thead>
          <tbody>
            <tr v-for="w in (data.segments && data.segments.waits) || []" :key="w.code">
              <td>{{ w.name }}</td><td>{{ w.count }}</td>
              <td>{{ w.avg }} 天</td>
              <td :class="{ warnText: w.max > 2 }">{{ w.max }} 天</td>
            </tr>
            <tr v-if="!((data.segments && data.segments.waits) || []).length"><td colspan="4" class="empty-cell">没有节点实际时间，算不出等待时长（不编造天数）</td></tr>
          </tbody>
        </table>

        <div class="sec-h" style="margin-top: 16px">逐单分解</div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>订单号</th><th>T0</th><th>下单前等待</th><th>工厂段实际</th><th>工厂段计划</th><th>工厂段达标</th><th>节点等待合计</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in (data.segments && data.segments.rows) || []" :key="r.order_no">
                <td>{{ r.order_no }}</td>
                <td>{{ r.t0_at || '—' }}</td>
                <td>{{ r.pre_factory_days == null ? '—' : r.pre_factory_days + ' 天' }}</td>
                <td>{{ r.factory_days == null ? '—' : r.factory_days + ' 天' }}</td>
                <td>{{ r.factory_plan_days == null ? '—' : r.factory_plan_days + ' 天' }}</td>
                <td>
                  <span v-if="r.factory_ok === null" class="mut">无计划天数</span>
                  <span v-else class="tag" :class="r.factory_ok ? 'green' : 'red'">{{ r.factory_ok ? '达标' : '超期' }}</span>
                </td>
                <td>{{ r.total_wait_days }} 天</td>
              </tr>
              <tr v-if="!((data.segments && data.segments.rows) || []).length"><td colspan="7" class="empty-cell">没有节点实际时间</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 3. 工序效率 -->
      <div v-if="tab === 'eff'">
        <div class="warn-box">
          <b>效率的分母只取填了工时的报工。</b>{{ data.efficiency && data.efficiency.calc_basis }}；
          标准工时缺失的工序不参与计算。分母为 0 时显示「—」，不显示 0%（那是没数据，不是效率为零）。
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>工序</th><th>报工</th><th>其中填工时</th><th>合格件</th><th>不良件</th><th>工序合格率</th><th>标准单件分钟</th><th>标准工时</th><th>实际工时</th><th>效率</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in (data.efficiency && data.efficiency.rows) || []" :key="r.process">
                <td>{{ r.process }}</td>
                <td>{{ r.reports }}</td>
                <td>{{ r.reports_with_hours }}</td>
                <td>{{ r.qty_ok }}</td>
                <td>{{ r.qty_defect }}</td>
                <td>{{ fmt(r.pass_rate) }}</td>
                <td>{{ r.std_minutes == null ? '—' : r.std_minutes }}</td>
                <td>{{ r.std_hours == null ? '—' : r.std_hours }}</td>
                <td>{{ r.actual_hours || '—' }}</td>
                <td>
                  <b :class="{ warnText: r.efficiency != null && r.efficiency < 60 }">{{ r.efficiency == null ? '—' : r.efficiency + '%' }}</b>
                </td>
                <td class="mut">{{ r.efficiency_note || '' }}</td>
              </tr>
              <tr v-if="!((data.efficiency && data.efficiency.rows) || []).length"><td colspan="11" class="empty-cell">本期没有报工</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 4. 质量 -->
      <div v-if="tab === 'quality'">
        <div class="warn-box">
          {{ data.quality && data.quality.fpy_note }}
          <span v-if="data.quality && data.quality.input_qty_note"> · {{ data.quality.input_qty_note }}</span>
        </div>
        <div class="two">
          <div>
            <div class="sec-h">返工按工序（哪道工序出问题）</div>
            <table class="data">
              <thead><tr><th>工序</th><th>单数</th><th>返工件数</th><th>报废件数</th></tr></thead>
              <tbody>
                <tr v-for="r in (data.quality && data.quality.by_node) || []" :key="r.node">
                  <td>{{ r.node }}</td><td>{{ r.count }}</td><td>{{ r.qty }}</td><td>{{ r.scrap }}</td>
                </tr>
                <tr v-if="!((data.quality && data.quality.by_node) || []).length"><td colspan="4" class="empty-cell">本期没有返工报废</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <div class="sec-h">责任归属（没填的单独列）</div>
            <table class="data">
              <thead><tr><th>责任方</th><th style="width: 80px">单数</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in (data.quality && data.quality.by_responsibility) || []" :key="i">
                  <td :class="{ warnText: !r.responsibility }">{{ r.label }}</td><td>{{ r.count }}</td>
                </tr>
                <tr v-if="!((data.quality && data.quality.by_responsibility) || []).length"><td colspan="2" class="empty-cell">无</td></tr>
              </tbody>
            </table>
            <div class="sec-h" style="margin-top: 14px">质检单</div>
            <div class="mut">
              本期 {{ data.quality ? data.quality.inspection.count : 0 }} 张，
              合格 {{ data.quality ? data.quality.inspection.pass_qty : 0 }} / 不合格 {{ data.quality ? data.quality.inspection.fail_qty : 0 }}，
              判定不合格 {{ data.quality ? data.quality.inspection.failed_count : 0 }} 张。
              <span v-if="data.quality && data.quality.inspection.note">{{ data.quality.inspection.note }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. 在制与计划 -->
      <div v-if="tab === 'wip'">
        <div class="sec-h">在制龄分档（起算：首个工序实际开始 → T0 → 建单日）</div>
        <div class="cards c4" style="margin-bottom: 12px">
          <div v-for="b in (data.wip && data.wip.buckets) || []" :key="b.key" class="stat-card">
            <div class="label">{{ b.label }}</div>
            <div class="value">{{ b.count }}<small>单</small></div>
            <div class="foot">{{ (b.orders || []).slice(0, 3).join('、') }}{{ (b.orders || []).length > 3 ? ' 等' : '' }}</div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>订单号</th><th>款名</th><th>类型</th><th>状态</th><th>起算日</th><th>起算依据</th><th>在制天数</th><th>交期</th><th>逾期</th></tr></thead>
            <tbody>
              <tr v-for="r in (data.wip && data.wip.rows) || []" :key="r.order_no">
                <td>{{ r.order_no }}</td><td>{{ r.style_name }}</td>
                <td>{{ r.type === 'custom' ? '定制' : '现货' }}</td>
                <td>{{ r.status }}</td>
                <td>{{ r.base_date || '—' }}</td>
                <td class="mut">{{ r.base_source }}</td>
                <td><b :class="{ warnText: r.age_days > 30 }">{{ r.age_days == null ? '—' : r.age_days }}</b></td>
                <td>{{ r.delivery_date || '—' }}</td>
                <td :class="{ warnText: r.overdue_days > 0 }">{{ r.overdue_days == null ? '—' : r.overdue_days + ' 天' }}</td>
              </tr>
              <tr v-if="!((data.wip && data.wip.rows) || []).length"><td colspan="9" class="empty-cell">没有在制订单</td></tr>
            </tbody>
          </table>
        </div>

        <div class="sec-h" style="margin-top: 18px">计划 vs 实际（工序）</div>
        <div class="warn-box" v-if="data.plan_vs_actual && data.plan_vs_actual.note">
          {{ data.plan_vs_actual.note }}
        </div>
        <table class="data">
          <thead><tr><th>工序</th><th>完成条数</th><th>有计划日</th><th>平均偏差</th><th>延期</th><th>提前</th></tr></thead>
          <tbody>
            <tr v-for="r in (data.plan_vs_actual && data.plan_vs_actual.rows) || []" :key="r.process">
              <td>{{ r.process }}</td><td>{{ r.done }}</td><td>{{ r.with_plan }}</td>
              <td :class="{ warnText: r.avg_dev > 0 }">{{ r.avg_dev == null ? '—' : r.avg_dev + ' 天' }}</td>
              <td>{{ r.late }}</td><td>{{ r.early }}</td>
            </tr>
            <tr v-if="!((data.plan_vs_actual && data.plan_vs_actual.rows) || []).length"><td colspan="6" class="empty-cell">本期没有完成的工序</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 6. 材料与下钻 -->
      <div v-if="tab === 'drill'">
        <div class="two">
          <div>
            <div class="sec-h">裁床与余料</div>
            <div class="mut" style="margin-bottom: 8px">{{ data.material && data.material.cut_pass_note }}</div>
            <table class="data">
              <thead><tr><th>指标</th><th>值</th></tr></thead>
              <tbody>
                <tr><td>裁床单</td><td>{{ data.material ? data.material.orders : 0 }}（已验完 {{ data.material ? data.material.finished_orders : 0 }}）</td></tr>
                <tr><td>裁片总数</td><td>{{ data.material ? data.material.cut_qty : 0 }}</td></tr>
                <tr><td>合格裁片</td><td>{{ data.material ? data.material.qualified_qty : 0 }}</td></tr>
                <tr><td>裁片合格率</td><td>{{ fmt(data.material && data.material.cut_pass_rate) }}</td></tr>
                <tr><td>余料（米）</td><td>{{ data.material ? data.material.leftover_m : 0 }}</td></tr>
                <tr><td>裁差件数</td><td>{{ data.material ? data.material.diff_qty : 0 }}</td></tr>
                <tr>
                  <td>材料利用率</td>
                  <td class="mut">— · {{ data.material ? data.material.utilization_note : '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <div class="sec-h">交期分解（可下钻的四段）</div>
            <table class="data">
              <thead><tr><th>段落</th><th>样本</th><th>平均天数</th><th>说明</th></tr></thead>
              <tbody>
                <tr>
                  <td>技术制版（创建→确认）</td>
                  <td>{{ data.lead ? data.lead.tech.sample : 0 }} / {{ data.lead ? data.lead.sample : 0 }}</td>
                  <td>{{ data.lead && data.lead.tech.avg_days != null ? data.lead.tech.avg_days + ' 天' : '—' }}</td>
                  <td class="mut">{{ (data.lead && data.lead.tech.note) || '' }}</td>
                </tr>
                <tr>
                  <td>销售接收</td>
                  <td colspan="2">T0 即起点</td>
                  <td class="mut">{{ data.lead ? data.lead.sales_receive.note : '' }}</td>
                </tr>
                <tr>
                  <td>厂方资料接收等待</td>
                  <td>{{ data.lead ? data.lead.factory_receive.sample : 0 }} / {{ data.lead ? data.lead.sample : 0 }}</td>
                  <td>{{ data.lead && data.lead.factory_receive.avg_days != null ? data.lead.factory_receive.avg_days + ' 天' : '—' }}</td>
                  <td class="mut">{{ (data.lead && data.lead.factory_receive.note) || '' }}</td>
                </tr>
                <tr>
                  <td>在制变更等待</td>
                  <td>{{ data.lead ? data.lead.change_pause.count : 0 }} 次</td>
                  <td>{{ data.lead && data.lead.change_pause.avg_wait_days != null ? data.lead.change_pause.avg_wait_days + ' 天' : '—' }}</td>
                  <td class="mut">客户确认耗时；交期影响合计 {{ data.lead && data.lead.change_pause.total_delta_days != null ? data.lead.change_pause.total_delta_days + ' 天' : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <div class="mut" style="margin-top: 8px">
              没有源事件的段落显示「—」，<b>不填 0 天</b>：0 天意味着「瞬间完成」，和「没有记录」是两件事。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';

const now = new Date();
const period = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
const tab = ref('ontime');
const data = reactive({ kpi: null, on_time: null, segments: null, efficiency: null, quality: null, wip: null, plan_vs_actual: null, material: null, lead: null, coverage: [], calibers: [] });

const tabs = [
  { key: 'ontime', label: '准交与延期' },
  { key: 'segment', label: '工厂段与等待' },
  { key: 'eff', label: '工序效率' },
  { key: 'quality', label: '质量' },
  { key: 'wip', label: '在制与计划' },
  { key: 'drill', label: '材料与下钻' }
];

const fmt = (v) => (v == null ? '—' : v + '%');
const md = (s) => String(s || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const covTag = (r) => (r == null ? 'tag gray' : (r >= 99 ? 'tag green' : (r >= 70 ? 'tag orange' : 'tag red')));

async function load() {
  const d = await api.prOverview({ period: period.value });
  Object.keys(data).forEach((k) => { if (k in d) data[k] = d[k]; });
}

async function reload() {
  await load();
}

function switchTab(k) {
  tab.value = k;
}

function doExport(kind) {
  downloadFile(api.prExportPath({ kind, period: period.value }));
}

onMounted(load);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
/* 六张 KPI 卡：内容宽度只有 1080 左右，卡片给到 165 上下就会把说明文字挤成三行，
   所以统一给最小高度 + 收紧说明字号，避免高度不齐 */
.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 112px; padding: 14px 12px; }
.cards.c6 .stat-card .value { font-size: 23px; margin-top: 6px; }
.cards.c6 .stat-card .foot { font-size: 11px; line-height: 1.45; }
.caliber { background: #f7f9fd; border: 1px solid #e2e9f4; border-radius: 12px; padding: 10px 16px; margin-bottom: 16px; }
.caliber summary { cursor: pointer; font-size: 13px; font-weight: 700; color: #16305f; }
.caliber ol { margin: 10px 0 4px; padding-left: 20px; color: #4a5875; font-size: 12.5px; line-height: 1.75; }
.cov-box { background: #fbfcfe; border: 1px solid #eef2f7; border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; }
.cov-h { font-size: 12.8px; font-weight: 700; color: #16233b; margin-bottom: 8px; }
.cov-table { background: transparent; }
.cov-table thead th { background: transparent; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.mini { border: 1px solid #eef2f7; border-radius: 10px; padding: 12px 14px; }
.mini-h { font-size: 12.5px; color: #6b7688; }
.mini-v { font-size: 26px; font-weight: 800; color: #16305f; margin: 6px 0 4px; }
.sec-h { font-size: 13px; font-weight: 700; color: #16233b; margin: 0 0 8px; }
.mut { color: #8a94a6; font-size: 11.8px; line-height: 1.6; }
.muted { color: #8a94a6; font-size: 12px; }
.warnText { color: #d92d45; font-weight: 600; }
.warn-box { background: #fffaf0; border: 1px solid #f2dfae; border-radius: 10px; padding: 10px 14px; font-size: 12.6px; color: #7a6420; line-height: 1.7; margin-bottom: 14px; }
.stat-card.danger { border-color: #f5c2c7; background: #fff8f8; }
@media (max-width: 860px) {
  .two { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; align-items: flex-start; gap: 10px; }
  .head-ops { flex-wrap: wrap; width: 100%; }
  .tabs { flex-wrap: wrap; }
  .tabs button { white-space: nowrap; }
}
</style>
