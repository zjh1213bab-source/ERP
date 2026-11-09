<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>数据质量与业务勾稽</h2>
        <p class="sub">
          把<b>订单账、库存账、财务账</b>三本账放在一起对：每一笔都要能双边查到凭证，单边改动就算不平。
          规则只给判定（期望值 / 实际值 / <b>差额</b>），不替人拍板；
          <b>自动修复只做「由明细重算汇总」</b>这一类，涉及数量认定与单据归属的一律转人工。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canRun" class="btn btn-primary" :disabled="running" @click="runCheck">
          {{ running ? '勾稽中…' : '立即勾稽' }}
        </button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat stat-health" :class="healthClass">
        <span>数据健康分</span>
        <strong>{{ summary.health === null || summary.health === undefined ? '—' : summary.health }}</strong>
        <small>{{ summary.last_run ? '上次 ' + $fmt(summary.last_run.created_at).slice(5) : '还没勾稽过' }}</small>
      </div>
      <div class="stat"><span>严重不平</span><strong class="amt-red">{{ summary.counters.error || 0 }}</strong><small>必须处理</small></div>
      <div class="stat"><span>需要关注</span><strong class="amt-orange">{{ summary.counters.warn || 0 }}</strong><small>规则告警</small></div>
      <div class="stat"><span>提示项</span><strong class="amt-blue">{{ summary.counters.info || 0 }}</strong><small>不急但别忘</small></div>
      <div class="stat"><span>可自动修</span><strong>{{ summary.last_run ? summary.last_run.fixable_cnt : 0 }}</strong><small>按明细重算</small></div>
      <div class="stat"><span>累计修复</span><strong class="amt-green">{{ summary.fix_count || 0 }}</strong><small>都有留痕</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'overview' }" @click="go('overview')">勾稽总览</button>
        <button :class="{ on: tab === 'issues' }" @click="go('issues')">
          问题明细<span v-if="summary.counters.open" class="tab-dot">{{ summary.counters.open }}</span>
        </button>
        <button :class="{ on: tab === 'reconcile' }" @click="go('reconcile')">三账对齐</button>
        <button :class="{ on: tab === 'history' }" @click="go('history')">执行历史</button>
        <button :class="{ on: tab === 'rules' }" @click="go('rules')">规则说明</button>
      </div>
      <template v-if="tab === 'issues'">
        <select class="select" v-model="filter.severity" style="width: 110px" @change="loadIssues">
          <option value="all">全部级别</option>
          <option value="error">严重</option>
          <option value="warn">关注</option>
          <option value="info">提示</option>
        </select>
        <select class="select" v-model="filter.status" style="width: 110px" @change="loadIssues">
          <option value="open">待处理</option>
          <option value="fixed">已修复</option>
          <option value="ignored">已忽略</option>
          <option value="all">全部状态</option>
        </select>
        <select class="select" v-model="filter.rule_code" style="width: 190px" @change="loadIssues">
          <option value="">全部规则</option>
          <option v-for="r in rules" :key="r.code" :value="r.code">{{ r.code }} {{ r.name }}</option>
        </select>
        <input v-model="filter.keyword" class="input" placeholder="单号 / 说明" style="width: 160px" @keyup.enter="loadIssues" />
        <button class="btn btn-ghost" @click="loadIssues">查询</button>
        <button v-if="canRun" class="btn btn-ghost" @click="exportCsv">导出 CSV</button>
      </template>
      <template v-if="tab === 'reconcile'">
        <label class="chk"><input type="checkbox" v-model="recOnlyDiff" @change="loadReconcile" /> 只看差异单</label>
        <input v-model="recKeyword" class="input" placeholder="订单号 / 客户" style="width: 160px" @keyup.enter="loadReconcile" />
        <button class="btn btn-ghost" @click="loadReconcile">查询</button>
      </template>
    </div>

    <p v-if="!summary.last_run" class="hint-bar">
      还没有执行过勾稽。点右上角「立即勾稽」，系统会按启用的规则把三本账跑一遍，给出每个单据的期望值与实际值差额。
    </p>

    <!-- ==================== 一、勾稽总览 ==================== -->
    <div v-if="tab === 'overview'">
      <div class="ov-grid">
        <div class="ov-card">
          <div class="ov-head">
            <b>健康分趋势</b>
            <small>最近 {{ summary.trend.length }} 次</small>
          </div>
          <div class="spark">
            <div v-for="(p, i) in summary.trend" :key="p.id" class="spark-col" :title="`${p.run_no} · ${p.health} 分 · ${p.issue_count} 项`">
              <i :style="{ height: Math.max(4, p.health) + '%', background: barColor(p.health) }"></i>
            </div>
            <div v-if="!summary.trend.length" class="spark-empty">暂无历史</div>
          </div>
          <div class="spark-axis">
            <span v-if="summary.trend.length">{{ summary.trend[0].created_at.slice(5, 10) }}</span>
            <span v-if="summary.trend.length">{{ summary.trend[summary.trend.length - 1].created_at.slice(5, 10) }}</span>
          </div>
          <div class="ov-fix" v-if="summary.last_run">
            <div class="ov-fix-title">
              较上次（{{ $fmt(summary.last_run.created_at).slice(5) }}）
              <span v-if="!summary.last_run.new_cnt && !summary.last_run.fixed_cnt && !summary.last_run.recur_cnt" class="muted">
                · 问题集合无变化
              </span>
            </div>
            <div>
              <span>本批次新增</span><b class="amt-red">{{ summary.last_run.new_cnt }}</b>
            </div>
            <div>
              <span>已消除</span><b class="amt-green">{{ summary.last_run.fixed_cnt }}</b>
            </div>
            <div>
              <span>复发</span><b class="amt-orange">{{ summary.last_run.recur_cnt }}</b>
            </div>
          </div>
        </div>

        <div class="ov-card">
          <div class="ov-head"><b>口径说明</b></div>
          <ul class="ov-note">
            <li><b>健康分</b> = 100 − 严重×3 − 关注×1 − 提示×0.25（每档封顶，问题再多也不打到 0）。</li>
            <li><b>只有算出差额的才算勾稽</b>，给不出差额的检查只做提示，不进严重级。</li>
            <li><b>可自动修</b>仅限余额、汇总、状态位这类能由明细推导的字段；改前改后都会落留痕。</li>
            <li><b>同一问题不重复计数</b>：按「规则+单据+字段」去重，跨批次只累加出现次数。</li>
            <li>本模块<b>只判定不阻断</b>，不影响下单、发货、结单流程。</li>
          </ul>
        </div>
      </div>

      <div v-for="grp in ruleGroups" :key="grp.kind" class="block">
        <h4>
          {{ grp.label }}
          <small>{{ grp.desc }}</small>
        </h4>
        <div class="table-wrap">
          <table class="ov-tbl">
            <thead>
              <tr>
                <th style="width: 46px">状态</th>
                <th>规则</th>
                <th style="width: 88px" class="num">问题</th>
                <th style="width: 88px" class="num">可修</th>
                <th style="width: 128px">最近发现</th>
                <th style="width: 240px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in grp.rows" :key="r.code" :class="{ 'row-warn': r.level === 'error' }">
                <td><span class="dot" :class="'dot-' + r.level"></span></td>
                <td>
                  <div class="rule-name">{{ r.name }}</div>
                  <div class="rule-code">{{ r.code }}<span v-if="!r.enabled" class="off-tag">已停用</span></div>
                  <div class="rule-desc" :title="r.desc">{{ r.desc }}</div>
                </td>
                <td class="num"><b :class="cntClass(r.level)">{{ r.open_cnt }}</b></td>
                <td class="num">{{ r.fixable_cnt || 0 }}</td>
                <td class="tiny muted">{{ r.last_seen_at ? r.last_seen_at.slice(5, 16) : '—' }}</td>
                <td class="ops">
                  <button v-if="r.open_cnt" class="btn btn-ghost btn-sm" @click="viewRule(r.code)">看明细</button>
                  <button v-if="r.fixable_cnt && canRun" class="btn btn-primary btn-sm" @click="fixRule(r)">修这 {{ r.fixable_cnt }} 项</button>
                  <span v-if="!r.open_cnt" class="ok-txt">已对齐</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 二、问题明细 ==================== -->
    <div v-else-if="tab === 'issues'">
      <div class="issue-bar">
        <span>
          共 <b>{{ issues.length }}</b> 条
          <template v-if="filter.status === 'open'">待处理</template>
          问题；筛选范围内可自动修
          <b>{{ fixableCount }}</b> 条
        </span>
        <button v-if="canRun && summary.last_run && fixableCount" class="btn btn-primary btn-sm" @click="fixAllInRun">
          批量修复本批次（{{ fixableCount }}）
        </button>
      </div>

      <div v-if="!issues.length" class="empty-cell">没有符合条件的问题。切到「已修复 / 已忽略」可以看历史处理记录。</div>
      <div v-else class="table-wrap">
        <table class="issue-tbl">
          <thead>
            <tr>
              <th style="width: 66px">级别</th>
              <th style="width: 150px">规则</th>
              <th style="width: 170px">对象</th>
              <th style="width: 92px">字段</th>
              <th style="width: 110px" class="num">期望值</th>
              <th style="width: 110px" class="num">实际值</th>
              <th style="width: 92px" class="num">差额</th>
              <th>说明</th>
              <th style="width: 74px">次数</th>
              <th style="width: 210px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in issues" :key="i.id" :class="'row-' + i.severity">
              <td><span class="pill" :class="'pill-' + i.severity">{{ sevLabel(i.severity) }}</span></td>
              <td>
                <div class="tiny">{{ i.rule_name }}</div>
                <div class="rule-code">{{ i.rule_code }}</div>
              </td>
              <td class="mono wrap">{{ i.entity_no || '—' }}</td>
              <td class="tiny muted">{{ i.field || '—' }}</td>
              <td class="num">{{ i.expect_val }}</td>
              <td class="num">{{ i.actual_val }}</td>
              <td class="num" :class="i.diff_val ? 'amt-orange' : ''">{{ i.diff_val || '—' }}</td>
              <td class="wrap">{{ i.message }}</td>
              <td class="num tiny">{{ i.seen_cnt }}</td>
              <td class="ops">
                <template v-if="i.status === 'open'">
                  <button v-if="i.fixable && canRun" class="btn btn-primary btn-sm" @click="fixOne(i)">自动修</button>
                  <button v-if="canRun" class="btn btn-ghost btn-sm" @click="openIgnore(i)">忽略</button>
                </template>
                <template v-else-if="i.status === 'ignored'">
                  <span class="tiny muted" :title="i.ignore_reason">已忽略</span>
                  <button v-if="canRun" class="btn btn-ghost btn-sm" @click="reopen(i)">恢复</button>
                </template>
                <template v-else-if="i.status === 'fixed'">
                  <span class="tiny ok-txt">{{ i.fixed_by === 'auto-detect' ? '已消除' : '已修复' }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、三账对齐 ==================== -->
    <div v-else-if="tab === 'reconcile'">
      <p class="hint-bar">
        一行一张订单：<b>订单账</b>（接单件数 / 订单金额）→ <b>库存账</b>（入库 / 出库）→ <b>财务账</b>（已开票 / 已收款）。
        出库大于接单是超发，开票大于订单额是超开，收款大于开票是重复收款；已结单却零出库/零开票说明账没走完。
      </p>
      <div class="rec-sum">
        <div class="rec-sum-item"><span>订单件数</span><b>{{ rec.total.order_qty || 0 }}</b></div>
        <div class="rec-sum-item"><span>已入库</span><b>{{ rec.total.in_qty || 0 }}</b></div>
        <div class="rec-sum-item"><span>已出库</span><b>{{ rec.total.out_qty || 0 }}</b></div>
        <div class="rec-sum-item"><span>订单金额</span><b>¥{{ fmt(rec.total.total_amount) }}</b></div>
        <div class="rec-sum-item"><span>已开票</span><b>¥{{ fmt(rec.total.ar_amount) }}</b></div>
        <div class="rec-sum-item"><span>已收款</span><b>¥{{ fmt(rec.total.ar_paid) }}</b></div>
        <div class="rec-sum-item" :class="rec.total.diff_count ? 'amt-red' : 'amt-green'">
          <span>差异单</span><b>{{ rec.total.diff_count || 0 }} / {{ rec.total.count || 0 }}</b>
        </div>
      </div>

      <div v-if="!rec.rows.length" class="empty-cell">没有订单数据。</div>
      <div v-else class="table-wrap">
        <table class="rec-tbl">
          <thead>
            <tr>
              <th>订单号</th>
              <th>客户</th>
              <th style="width: 92px">状态</th>
              <th style="width: 80px" class="num">接单</th>
              <th style="width: 80px" class="num">入库</th>
              <th style="width: 80px" class="num">出库</th>
              <th style="width: 80px" class="num">数量差</th>
              <th style="width: 110px" class="num">订单金额</th>
              <th style="width: 110px" class="num">已开票</th>
              <th style="width: 110px" class="num">已收款</th>
              <th style="width: 110px" class="num">金额差</th>
              <th style="width: 180px">标记</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rec.rows" :key="r.id" :class="{ 'row-issue': r.flag === 'error', 'row-warn': r.flag === 'warn' }">
              <td class="mono">{{ r.order_no }}</td>
              <td class="wrap">{{ r.customer_name || '—' }}</td>
              <td class="tiny">{{ statusLabel(r.status) }}</td>
              <td class="num">{{ r.order_qty }}</td>
              <td class="num">{{ r.in_qty }}</td>
              <td class="num">{{ r.out_qty }}</td>
              <td class="num" :class="r.qty_diff < 0 ? 'amt-red' : ''">{{ r.qty_diff }}</td>
              <td class="num">{{ fmt(r.total_amount) }}</td>
              <td class="num">{{ fmt(r.ar_amount) }}</td>
              <td class="num">{{ fmt(r.ar_paid) }}</td>
              <td class="num" :class="r.amt_diff < 0 ? 'amt-red' : ''">{{ fmt(r.amt_diff) }}</td>
              <td class="ops">
                <span v-if="!r.flags.length" class="pill pill-ok">三账相符</span>
                <span v-for="f in r.flags" :key="f" class="pill pill-tag">{{ f }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 四、执行历史 ==================== -->
    <div v-else-if="tab === 'history'">
      <div class="block">
        <h4>勾稽批次<small>每次执行都留一份快照，可对比新增与已消除</small></h4>
        <div v-if="!runs.length" class="empty-cell">还没有执行记录。</div>
        <div v-else class="table-wrap">
          <table class="run-tbl">
            <thead>
              <tr>
                <th style="width: 168px">批次号</th>
                <th style="width: 128px">执行时间</th>
                <th style="width: 70px" class="num">规则</th>
                <th style="width: 70px" class="num">问题</th>
                <th style="width: 66px" class="num">严重</th>
                <th style="width: 66px" class="num">关注</th>
                <th style="width: 66px" class="num">提示</th>
                <th style="width: 66px" class="num">新增</th>
                <th style="width: 66px" class="num">已消除</th>
                <th style="width: 66px" class="num">复发</th>
                <th style="width: 80px" class="num">健康分</th>
                <th style="width: 78px" class="num">耗时</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in runs" :key="r.id">
                <td class="mono">{{ r.run_no }}</td>
                <td class="tiny">{{ $fmt(r.created_at) }}</td>
                <td class="num">{{ r.rule_count }}</td>
                <td class="num"><b>{{ r.issue_count }}</b></td>
                <td class="num amt-red">{{ r.error_cnt }}</td>
                <td class="num amt-orange">{{ r.warn_cnt }}</td>
                <td class="num amt-blue">{{ r.info_cnt }}</td>
                <td class="num">{{ r.new_cnt }}</td>
                <td class="num amt-green">{{ r.fixed_cnt }}</td>
                <td class="num" :class="r.recur_cnt ? 'amt-orange' : ''">{{ r.recur_cnt }}</td>
                <td class="num"><b :class="scoreClass(r.health)">{{ r.health }}</b></td>
                <td class="num tiny">{{ r.duration_ms }}ms</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="block">
        <h4>修复留痕<small>谁在什么时候把哪个数从多少改成了多少</small></h4>
        <div v-if="!fixes.length" class="empty-cell">还没有自动修复记录。</div>
        <div v-else class="table-wrap">
          <table class="fix-tbl">
            <thead>
              <tr>
                <th style="width: 128px">时间</th>
                <th style="width: 150px">规则</th>
                <th>对象</th>
                <th>改动</th>
                <th style="width: 120px">操作人</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in fixes" :key="f.id">
                <td class="tiny">{{ $fmt(f.created_at).slice(5) }}</td>
                <td class="tiny">{{ f.rule_name || f.fix_key }}</td>
                <td class="mono wrap">{{ f.entity_no || f.target }}</td>
                <td class="wrap">{{ f.message }}</td>
                <td class="tiny">{{ f.operator }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 五、规则说明 ==================== -->
    <div v-else-if="tab === 'rules'">
      <p class="hint-bar">
        规则是判定标准，不是报表口径。停用规则后下次勾稽不再执行它，历史问题保留但不再更新。
      </p>
      <div class="table-wrap">
        <table class="rule-tbl">
          <thead>
            <tr>
              <th style="width: 160px">规则</th>
              <th style="width: 66px">级别</th>
              <th style="width: 76px">可自动修</th>
              <th>判定口径与修复建议</th>
              <th style="width: 88px">启用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rules" :key="r.code">
              <td>
                <div class="rule-name">{{ r.name }}</div>
                <div class="rule-code">{{ r.code }}</div>
                <div class="tiny muted">{{ r.category === 'balance' ? '账账对齐' : '数据质量' }}</div>
              </td>
              <td><span class="pill" :class="'pill-' + r.severity">{{ sevLabel(r.severity) }}</span></td>
              <td class="tiny">{{ r.fixable ? '可以' : '人工核对' }}</td>
              <td class="wrap">
                <div>{{ r.desc }}</div>
                <div class="tiny muted" style="margin-top: 3px">建议：{{ r.suggest }}</div>
              </td>
              <td>
                <label class="switch" :class="{ on: r.enabled }">
                  <input type="checkbox" :checked="r.enabled" :disabled="!isAdmin" @change="toggleRule(r, $event)" />
                  <i></i>
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 忽略弹窗 -->
    <div v-if="ignoreTarget" class="modal-mask">
      <div class="modal">
        <h3>忽略这条勾稽问题</h3>
        <p class="tiny muted" style="margin-bottom: 10px">{{ ignoreTarget.rule_code }} · {{ ignoreTarget.entity_no }}</p>
        <label class="fld">
          <span>忽略理由（必填，至少 4 个字）</span>
          <textarea v-model="ignoreForm.reason" rows="3" placeholder="例如：客供面料不计价，已确认无需开票"></textarea>
        </label>
        <label class="fld">
          <span>有效期（天，留空表示长期有效）</span>
          <input v-model.number="ignoreForm.days" type="number" min="0" placeholder="如 30" />
        </label>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="ignoreTarget = null">取消</button>
          <button class="btn btn-primary" @click="confirmIgnore">确认忽略</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
import { ref, reactive, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';
import { auth } from '../store/auth';

const canRun = computed(() => can('dq.write'));
const isAdmin = computed(() => auth.user?.role === 'admin');

const tab = ref('overview');
const running = ref(false);
const summary = ref({ last_run: null, health: null, trend: [], by_rule: [], counters: {}, fix_count: 0, rule_total: 0 });
const rules = ref([]);
const issues = ref([]);
const runs = ref([]);
const fixes = ref([]);
const rec = ref({ rows: [], total: {} });
const recOnlyDiff = ref(false);
const recKeyword = ref('');
const filter = reactive({ severity: 'all', status: 'open', rule_code: '', keyword: '' });
const ignoreTarget = ref(null);
const ignoreForm = reactive({ reason: '', days: 0 });

const SEV = { error: '严重', warn: '关注', info: '提示' };
const STATUS = {
  draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
  instock: '已入库', shipped: '已发货', closed: '已结单', cancelled: '已取消'
};
const sevLabel = (s) => SEV[s] || s;
const statusLabel = (s) => STATUS[s] || s;
const fmt = (v) => (Number(v) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const healthClass = computed(() => {
  const h = summary.value.health;
  if (h === null || h === undefined) return '';
  if (h >= 85) return 'h-good';
  if (h >= 60) return 'h-mid';
  return 'h-bad';
});
const scoreClass = (h) => (h >= 85 ? 'amt-green' : h >= 60 ? 'amt-orange' : 'amt-red');
const barColor = (h) => (h >= 85 ? '#16a34a' : h >= 60 ? '#d97706' : '#d92d45');
const cntClass = (lv) => (lv === 'error' ? 'amt-red' : lv === 'warn' ? 'amt-orange' : lv === 'info' ? 'amt-blue' : 'amt-green');
const fixableCount = computed(() => issues.value.filter((i) => i.status === 'open' && i.fixable).length);

/** 规则行：合并规则定义与命中统计 */
const ruleGroups = computed(() => {
  const stat = {};
  (summary.value.by_rule || []).forEach((b) => { stat[b.rule_code] = b; });
  const mk = (kind, label, desc) => ({
    kind,
    label,
    desc,
    rows: rules.value
      .filter((r) => r.kind === kind)
      .map((r) => {
        const s = stat[r.code] || {};
        const open = Number(s.open_cnt) || 0;
        return {
          ...r,
          open_cnt: open,
          fixable_cnt: Number(s.fixable_cnt) || 0,
          last_seen_at: s.last_seen_at || null,
          level: !open ? 'ok' : Number(s.error_cnt) ? 'error' : Number(s.warn_cnt) ? 'warn' : 'info'
        };
      })
  });
  return [
    mk('balance', '账账对齐', '订单 / 库存 / 财务 / 成本 / 采购之间必须双边相符'),
    mk('quality', '数据质量', '主数据与单据字段的完整性与可追溯性')
  ];
});

async function loadSummary() {
  summary.value = await api.dqSummary();
}
async function loadRules() {
  rules.value = await api.dqRules();
}
async function loadIssues() {
  const d = await api.dqIssues({
    status: filter.status,
    severity: filter.severity,
    rule_code: filter.rule_code,
    keyword: filter.keyword
  });
  issues.value = d.rows || [];
}
async function loadRuns() {
  runs.value = await api.dqRuns({ limit: 20 });
  fixes.value = await api.dqFixes({ limit: 30 });
}
async function loadReconcile() {
  rec.value = await api.dqReconcile({
    only: recOnlyDiff.value ? 'diff' : '',
    keyword: recKeyword.value
  });
}

async function reloadAll() {
  await Promise.all([loadSummary(), loadRules()]);
  if (tab.value === 'issues') await loadIssues();
  if (tab.value === 'history') await loadRuns();
  if (tab.value === 'reconcile') await loadReconcile();
}

function go(t) {
  tab.value = t;
  if (t === 'issues') loadIssues();
  if (t === 'reconcile') loadReconcile();
  if (t === 'history') loadRuns();
  if (t === 'rules') loadRules();
}

async function runCheck() {
  running.value = true;
  try {
    const r = await api.dqRun({});
    await reloadAll();
    alert(
      `勾稽完成：${r.run_no}\n规则 ${r.rule_count} 条，问题 ${r.issue_count} 项` +
      `（严重 ${r.error_cnt} / 关注 ${r.warn_cnt} / 提示 ${r.info_cnt}）\n` +
      `新增 ${r.new_cnt}，已消除 ${r.fixed_cnt}，复发 ${r.recur_cnt}\n健康分 ${r.health}`
    );
  } catch (e) {
    alert('勾稽失败：' + e.message);
  } finally {
    running.value = false;
  }
}

function viewRule(code) {
  filter.rule_code = code;
  filter.status = 'open';
  filter.severity = 'all';
  tab.value = 'issues';
  loadIssues();
}

async function fixOne(i) {
  if (!confirm(`按明细重算「${i.entity_no}」的 ${i.field}？\n期望 ${i.expect_val}，当前 ${i.actual_val}`)) return;
  try {
    await api.dqFixIssue(i.id);
    await Promise.all([loadIssues(), loadSummary()]);
  } catch (e) {
    alert('修复失败：' + e.message);
  }
}

/** 按规则批量修：逐条调用，保证每条独立留痕与独立失败不影响其他 */
async function fixRule(r) {
  if (!confirm(`修复「${r.name}」下 ${r.fixable_cnt} 条可自动修的问题？`)) return;
  const d = await api.dqIssues({ status: 'open', rule_code: r.code, severity: 'all' });
  const list = (d.rows || []).filter((x) => x.fixable);
  let ok = 0;
  let bad = 0;
  for (const it of list) {
    try {
      await api.dqFixIssue(it.id);
      ok += 1;
    } catch (e) {
      bad += 1;
    }
  }
  await reloadAll();
  alert(`修复完成：成功 ${ok} 条${bad ? `，失败 ${bad} 条` : ''}`);
}

async function fixAllInRun() {
  if (!summary.value.last_run) return;
  if (!confirm(`批量修复本批次全部可自动修的问题（${fixableCount.value} 条）？`)) return;
  try {
    const r = await api.dqFixAll(summary.value.last_run.id);
    await reloadAll();
    alert(`批量修复完成：成功 ${r.fixed}，跳过 ${r.skipped}，失败 ${r.failed}`);
  } catch (e) {
    alert('批量修复失败：' + e.message);
  }
}

function openIgnore(i) {
  ignoreTarget.value = i;
  ignoreForm.reason = '';
  ignoreForm.days = 0;
}

async function confirmIgnore() {
  if (String(ignoreForm.reason || '').trim().length < 4) {
    alert('请填写至少 4 个字的忽略理由');
    return;
  }
  try {
    await api.dqIgnoreIssue(ignoreTarget.value.id, {
      reason: ignoreForm.reason.trim(),
      days: Number(ignoreForm.days) || 0
    });
    ignoreTarget.value = null;
    await Promise.all([loadIssues(), loadSummary()]);
  } catch (e) {
    alert('忽略失败：' + e.message);
  }
}

async function reopen(i) {
  try {
    await api.dqReopenIssue(i.id);
    await Promise.all([loadIssues(), loadSummary()]);
  } catch (e) {
    alert('恢复失败：' + e.message);
  }
}

async function toggleRule(r, ev) {
  const enabled = ev.target.checked;
  try {
    await api.dqToggleRule(r.code, enabled);
    r.enabled = enabled;
  } catch (e) {
    ev.target.checked = !enabled;
    alert('操作失败：' + e.message);
  }
}

async function exportCsv() {
  try {
    const b = await downloadFile('/api/dq/export?status=' + filter.status);
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dq-issues-${localDate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('导出失败：' + e.message);
  }
}

onMounted(async () => {
  await reloadAll();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.stat-health strong { font-size: 26px; }
.stat-health.h-good { background: #f2fbf5; border-color: #cfe9d8; }
.stat-health.h-good strong { color: #16a34a; }
.stat-health.h-mid { background: #fffaf2; border-color: #f3e0c2; }
.stat-health.h-mid strong { color: #d97706; }
.stat-health.h-bad { background: #fff5f6; border-color: #f6d4d9; }
.stat-health.h-bad strong { color: #d92d45; }

.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.amt-blue { color: var(--brand); }
.muted { color: #9aa4b5; }
.tiny { font-size: 12px; }
.wrap { white-space: normal; line-height: 1.55; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.ops { white-space: nowrap; }
.ok-txt { color: #16a34a; font-size: 12px; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 12px; }
.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 12px; color: #9aa4b5; }
.row-warn { background: #fffdf7; }
.row-error { background: #fff7f8; }
.row-info { background: #fbfdff; }
.row-issue { background: #fff7f8; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 12px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }
.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: #4a566e; }

/* 总览 */
.ov-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; margin-bottom: 4px; }
.ov-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 13px 15px; }
.ov-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.ov-head b { font-size: 13px; color: var(--ink); }
.ov-head small { font-size: 12px; color: #9aa4b5; }
.spark { display: flex; align-items: flex-end; gap: 5px; height: 92px; position: relative; justify-content: flex-start; }
.spark-col { flex: 1; max-width: 46px; height: 100%; display: flex; align-items: flex-end; }
.spark-col i { display: block; width: 100%; border-radius: 3px 3px 0 0; min-height: 4px; transition: height 0.2s; }
.spark-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #b6bfcf; font-size: 12px; }
.spark-axis { display: flex; justify-content: space-between; font-size: 12px; color: #b6bfcf; margin-top: 4px; }
.ov-fix { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; padding-top: 11px; border-top: 1px dashed #e9eef7; }
.ov-fix-title { grid-column: 1 / -1; font-size: 12px; color: var(--ink-mute); margin-bottom: 2px; }
.ov-fix span { display: block; font-size: 12px; color: var(--ink-mute); }
.ov-fix b { font-size: 17px; }
.ov-note { margin: 0; padding-left: 17px; font-size: 12.5px; color: #3d4a63; line-height: 1.85; }
.ov-note li { margin-bottom: 3px; }

.ov-tbl { min-width: 900px; width: 100%; }
.rule-name { font-size: 12.5px; color: var(--ink); }
.rule-code { font-size: 12px; color: #a3adbe; font-family: ui-monospace, Menlo, Consolas, monospace; }
.rule-desc { font-size: 12px; color: var(--ink-mute); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 620px; }
.off-tag { margin-left: 6px; background: #eef2f8; color: var(--ink-mute); border-radius: 4px; padding: 0 4px; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
.dot-error { background: #d92d45; }
.dot-warn { background: #d97706; }
.dot-info { background: var(--brand); }
.dot-ok { background: #16a34a; }

.pill { display: inline-block; font-size: 12px; border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
.pill-error { background: #fdecef; color: #c0243c; }
.pill-warn { background: #fdf3e3; color: #b46207; }
.pill-info { background: #eef4ff; color: var(--brand); }
.pill-ok { background: #eefaf2; color: #15803d; }
.pill-tag { background: #fdf3e3; color: #b46207; margin-right: 4px; }

/* 问题明细 */
.issue-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12.5px; color: #4a566e; margin-bottom: 10px; }
.issue-tbl { min-width: 1320px; width: 100%; }
.issue-tbl td { vertical-align: top; }

/* 三账对齐 */
.rec-sum { display: grid; grid-template-columns: repeat(7, 1fr); gap: 9px; margin-bottom: 12px; }
.rec-sum-item { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 10px; padding: 9px 11px; }
.rec-sum-item span { display: block; font-size: 12px; color: var(--ink-mute); }
.rec-sum-item b { font-size: 16px; color: var(--ink); }
.rec-sum-item.amt-red b { color: #d92d45; }
.rec-sum-item.amt-green b { color: #16a34a; }
.rec-tbl { min-width: 1240px; width: 100%; }
.run-tbl { min-width: 1080px; width: 100%; }
.fix-tbl { min-width: 860px; width: 100%; }
.rule-tbl { min-width: 1000px; width: 100%; }

/* 开关 */
.switch { position: relative; display: inline-block; width: 36px; height: 20px; }
.switch input { display: none; }
.switch i { position: absolute; inset: 0; background: #d6dee9; border-radius: 10px; transition: 0.2s; }
.switch i::after { content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: var(--surface); border-radius: 50%; transition: 0.2s; }
.switch.on i { background: var(--brand); }
.switch.on i::after { transform: translateX(16px); }

/* 弹窗 */
.modal-mask { position: fixed; inset: 0; background: rgba(20, 30, 48, 0.42); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: var(--surface); border-radius: 14px; padding: 18px 20px; width: 420px; max-width: 92vw; box-shadow: 0 18px 50px rgba(16, 30, 55, 0.22); }
.modal h3 { margin: 0 0 6px; font-size: 15px; color: var(--ink); }
.fld { display: block; margin-bottom: 11px; }
.fld span { display: block; font-size: 12px; color: #6b7791; margin-bottom: 4px; }
.fld textarea, .fld input { width: 100%; border: 1px solid #dbe3ef; border-radius: 8px; padding: 7px 9px; font-size: 13px; font-family: inherit; }
.modal-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .ov-grid { grid-template-columns: 1fr; }
  .rec-sum { grid-template-columns: repeat(2, 1fr); }
}
</style>
