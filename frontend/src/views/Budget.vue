<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>预算管理</h2>
        <p class="sub">
          按<b>部门 × 费用科目 × 月份</b>编预算。<b>已用 = 已入账 + 已占用</b>——费用单提交了但凭证还没生成的那几天，
          额度也先按住，否则会出现「账面还有额度，大家一起花，月底一起超」。
          超预算<b>拦在单据提交前</b>，不是事后算出来告诉老板超了；特批必须写说明并留痕。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill" :class="ov.budget ? (ov.budget.status === 'active' ? 'p-green' : 'p-orange') : 'p-gray'">
          {{ ov.budget ? ov.budget.budget_no + ' · ' + ov.budget.status_label : '当年无生效预算' }}
        </span>
        <input v-model="period" type="month" @change="reload" />
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>预算总额</span><strong>{{ money(ov.totals && ov.totals.budget) }}</strong><small>{{ period }} · {{ deptCount }} 个部门</small></div>
      <div class="stat" :class="pctClass(ov.totals && ov.totals.used_pct)">
        <span>已用</span><strong>{{ money(ov.totals && ov.totals.used) }}</strong>
        <small>执行率 {{ (ov.totals && ov.totals.used_pct) || 0 }}%（时间进度 {{ ov.expect_pct || 0 }}%）</small>
      </div>
      <div class="stat"><span>其中已入账</span><strong>{{ money(ov.totals && ov.totals.actual) }}</strong><small>已生成凭证</small></div>
      <div class="stat" :class="(ov.totals && ov.totals.committed) ? 'st-warn' : ''">
        <span>其中已占用</span><strong>{{ money(ov.totals && ov.totals.committed) }}</strong><small>单据已提交未入账</small>
      </div>
      <div class="stat"><span>可用余额</span><strong>{{ money(ov.totals && ov.totals.available) }}</strong><small>预算 − 已用</small></div>
      <div class="stat" :class="(ov.totals && ov.totals.over_cnt) ? 'st-bad' : ''">
        <span>超预算科目</span><strong>{{ (ov.totals && ov.totals.over_cnt) || 0 }}</strong>
        <small>待确认超支 {{ ov.alert_open || 0 }} 条</small>
      </div>
    </div>

    <div v-if="ov.unassigned_expense > 0" class="hint-bar">
      本期还有 <b>{{ money(ov.unassigned_expense) }}</b> 费用<b>没有归部门</b>，不进入预算执行。
      在录入费用时选上部门，这部分钱才能被预算管住。
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'exec' }" @click="go('exec')">执行与差异</button>
        <button :class="{ on: tab === 'plan' }" @click="go('plan')">预算编制</button>
        <button :class="{ on: tab === 'adj' }" @click="go('adj')">调整单<span v-if="ov.pending_adj" class="tab-dot">{{ ov.pending_adj }}</span></button>
        <button :class="{ on: tab === 'alert' }" @click="go('alert')">超支留痕<span v-if="ov.alert_open" class="tab-dot">{{ ov.alert_open }}</span></button>
      </div>
    </div>

    <!-- ========== 执行与差异 ========== -->
    <div v-if="tab === 'exec'" class="block">
      <h4>部门执行<small>按执行率排序，超过时间进度太多的说明花得太快</small></h4>
      <div class="dept-grid">
        <div v-for="d in ov.by_dept" :key="d.department_id" class="dept-card"
          :class="d.used_pct > 100 ? 'dc-bad' : d.used_pct >= 90 ? 'dc-warn' : ''">
          <div class="dc-head"><b>{{ d.department_name }}</b><span>{{ d.used_pct }}%</span></div>
          <div class="dc-bar"><i :style="{ width: Math.min(100, d.used_pct) + '%' }" :class="d.used_pct > 100 ? 'bar-bad' : d.used_pct >= 90 ? 'bar-warn' : ''"></i></div>
          <div class="dc-num">
            <span>已用 {{ money(d.used) }}</span>
            <span class="muted">/ 预算 {{ money(d.budget) }}</span>
          </div>
          <div class="dc-foot">
            可用 <b :class="d.available < 0 ? 'amt-red' : ''">{{ money(d.available) }}</b>
            <span v-if="d.over_cnt" class="pill p-red">超 {{ d.over_cnt }} 项</span>
          </div>
        </div>
        <div v-if="!ov.by_dept || !ov.by_dept.length" class="empty-box">本期没有预算，先去「预算编制」建一份</div>
      </div>

      <h4 style="margin-top: 18px">明细<small>预算 / 已发生 / 已占用 / 可用 / 差异</small></h4>
      <div class="toolbar">
        <select v-model="filterDept" @change="loadExecution">
          <option value="">全部部门</option>
          <option v-for="d in dict.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <label class="chk"><input type="checkbox" v-model="onlyDiff" @change="loadExecution" /> 只看有差异的</label>
        <span class="muted tiny">合计 {{ exec.rows.length }} 行</span>
      </div>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead>
            <tr>
              <th style="width: 110px">部门</th><th style="width: 110px">科目</th>
              <th style="width: 100px" class="num">预算</th>
              <th style="width: 100px" class="num">已发生</th>
              <th style="width: 96px" class="num">已占用</th>
              <th style="width: 100px" class="num">可用</th>
              <th style="width: 88px" class="num">执行率</th>
              <th style="width: 96px">状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in exec.rows" :key="r.department_id + '|' + r.account_code" :class="r.flag === 'over' ? 'row-bad' : r.flag === 'near' ? 'row-warn' : ''">
              <td class="tiny">{{ r.department_name }}</td>
              <td class="tiny">{{ r.account_name }}</td>
              <td class="num">{{ money(r.budget) }}</td>
              <td class="num">{{ money(r.actual) }}</td>
              <td class="num" :class="r.committed ? 'amt-orange' : 'muted'">{{ money(r.committed) }}</td>
              <td class="num" :class="r.available < 0 ? 'amt-red' : ''">{{ money(r.available) }}</td>
              <td class="num">{{ r.used_pct }}%</td>
              <td>
                <span class="pill" :class="flagCls(r.flag)">{{ flagLabel(r.flag) }}</span>
              </td>
            </tr>
            <tr v-if="!exec.rows || !exec.rows.length"><td colspan="8" class="empty">本期没有预算明细</td></tr>
          </tbody>
        </table>
      </div>

      <h4 style="margin-top: 18px">未入账占用<small>这些单据已经把额度按住了，生成凭证后自动转为「已入账」</small></h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 110px">部门</th><th style="width: 110px">来源</th><th>说明</th>
            <th style="width: 90px">月份</th><th style="width: 100px" class="num">占用金额</th><th style="width: 90px">状态</th></tr></thead>
          <tbody>
            <tr v-for="c in commitments" :key="c.id">
              <td class="tiny">{{ c.department_name }}</td>
              <td class="tiny">{{ { expense: '费用单', payroll: '工资', purchase: '采购' }[c.source_type] || c.source_type }}</td>
              <td class="tiny wrap">{{ c.source_no || c.note || '—' }}</td>
              <td class="tiny mono">{{ c.period }}</td>
              <td class="num">{{ money(c.amount) }}</td>
              <td><span class="pill" :class="c.status === 'open' ? 'p-orange' : 'p-gray'">{{ c.status_label }}</span></td>
            </tr>
            <tr v-if="!commitments.length"><td colspan="6" class="empty">没有未入账的占用</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 预算编制 ========== -->
    <div v-if="tab === 'plan'" class="block">
      <div class="toolbar">
        <select v-model="planYear" @change="loadList">
          <option v-for="y in dict.years" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <button v-if="canWrite" class="btn btn-primary" @click="openNew">＋ 新建编制</button>
        <span class="muted tiny">同一年只能有一份「生效中」，新的生效会把旧的自动关闭</span>
      </div>

      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 150px">预算号</th><th>名称</th><th style="width: 60px" class="num">版本</th>
            <th style="width: 110px" class="num">总额</th><th style="width: 70px" class="num">条数</th>
            <th style="width: 80px" class="num">容忍</th><th style="width: 90px">状态</th>
            <th style="width: 110px">编制人</th><th style="width: 220px">操作</th></tr></thead>
          <tbody>
            <tr v-for="b in list" :key="b.id" :class="b.status === 'active' ? 'row-active' : ''">
              <td class="mono tiny">{{ b.budget_no }}</td>
              <td class="tiny">{{ b.name }}</td>
              <td class="num tiny">{{ b.version }}</td>
              <td class="num">{{ money(b.total_amount) }}</td>
              <td class="num tiny">{{ b.item_count }}</td>
              <td class="num tiny">{{ b.tolerance_pct }}%</td>
              <td><span class="pill" :class="bstatusCls(b.status)">{{ b.status_label }}</span></td>
              <td class="tiny">{{ b.created_by }}</td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openEdit(b)">{{ b.status === 'draft' ? '编辑' : '查看' }}</button>
                <button v-if="b.status === 'draft' && canApprove" class="btn btn-ghost btn-sm" @click="doApprove(b)">批准</button>
                <button v-if="b.status === 'draft' && canApprove" class="btn btn-ghost btn-sm" @click="openReject(b)">驳回</button>
                <button v-if="b.status === 'approved' && isAdmin" class="btn btn-primary btn-sm" @click="doActivate(b)">生效</button>
                <button v-if="b.status === 'active' && isAdmin" class="btn btn-ghost btn-sm" @click="doClose(b)">关闭</button>
              </td>
            </tr>
            <tr v-if="!list.length"><td colspan="9" class="empty">该年度还没有预算</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="cur" class="plan-box">
        <div class="pb-head">
          <b>{{ cur.budget_no }}</b>
          <span class="pill" :class="bstatusCls(cur.status)">{{ cur.status_label }}</span>
          <span class="muted tiny">{{ cur.name }}</span>
          <span class="pb-total">总额 {{ money(cur.total_amount) }}</span>
        </div>
        <div class="toolbar">
          <input v-model="planMonth" type="month" @change="fillMatrix" />
          <span class="muted tiny">按月份录入：部门 × 费用科目</span>
          <button v-if="cur.status === 'draft' && canWrite" class="btn btn-primary btn-sm" @click="saveMatrix">保存本月</button>
        </div>
        <div class="table-wrap">
          <table class="tb-tbl">
            <thead>
              <tr>
                <th style="width: 130px">部门</th>
                <th v-for="a in dict.accounts" :key="a.code" class="num">{{ a.name }}（{{ a.code }}）</th>
                <th style="width: 110px" class="num">小计</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in deptRows" :key="d.id">
                <td class="tiny">{{ d.name }}</td>
                <td v-for="a in dict.accounts" :key="a.code" class="num">
                  <input v-if="cur.status === 'draft' && canWrite" class="cell-input" type="number" min="0"
                    v-model.number="matrix[d.id + '_' + a.code]" @input="recalcRow(d.id)" />
                  <span v-else>{{ money(gridValue(d.id, a.code)) }}</span>
                </td>
                <td class="num"><b>{{ money(rowSum(d.id)) }}</b></td>
              </tr>
              <tr class="sum-row">
                <td>合计</td>
                <td v-for="a in dict.accounts" :key="a.code" class="num">{{ money(colSum(a.code)) }}</td>
                <td class="num"><b>{{ money(grandTotal) }}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="cur.status === 'draft' && canWrite" class="form-row">
          <input v-model="curTolerance" type="number" min="0" max="50" placeholder="容忍比例 %" style="width: 140px" />
          <span class="muted tiny">容忍比例：0 表示硬控；设 5 表示超 5% 内自动放行但留痕</span>
          <button class="btn btn-ghost btn-sm" @click="saveTolerance">保存容忍比例</button>
        </div>
      </div>
    </div>

    <!-- ========== 调整单 ========== -->
    <div v-if="tab === 'adj'" class="block">
      <div class="toolbar">
        <button v-if="canWrite" class="btn btn-primary" @click="openAdj">＋ 申请调整</button>
        <span class="muted tiny">生效/已批准的预算不能直接改数，只能走调整单；调减不能让预算变负</span>
      </div>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 150px">单号</th><th style="width: 80px">类型</th><th>从</th><th>到</th>
            <th style="width: 86px">月份</th><th style="width: 110px" class="num">金额</th>
            <th style="width: 90px">状态</th><th style="width: 190px">原因</th><th style="width: 150px">操作</th></tr></thead>
          <tbody>
            <tr v-for="a in adjustments" :key="a.id" :class="a.status === 'pending' ? 'row-warn' : ''">
              <td class="mono tiny">{{ a.adj_no }}</td>
              <td class="tiny">{{ a.type_label }}</td>
              <td class="tiny">{{ a.from_department_name ? a.from_department_name + ' · ' + a.from_account_code : '—' }}</td>
              <td class="tiny">{{ a.to_department_name ? a.to_department_name + ' · ' + a.to_account_code : '—' }}</td>
              <td class="tiny mono">{{ a.period }}</td>
              <td class="num">{{ money(a.amount) }}</td>
              <td><span class="pill" :class="a.status === 'approved' ? 'p-green' : a.status === 'rejected' ? 'p-gray' : 'p-orange'">{{ a.status_label }}</span></td>
              <td class="tiny wrap">{{ a.reason }}</td>
              <td class="ops">
                <template v-if="a.status === 'pending' && canApprove">
                  <button class="btn btn-primary btn-sm" @click="doApproveAdj(a)">批准</button>
                  <button class="btn btn-ghost btn-sm" @click="openRejectAdj(a)">驳回</button>
                </template>
                <span v-else-if="a.status === 'rejected'" class="tiny muted">{{ a.reject_reason }}</span>
              </td>
            </tr>
            <tr v-if="!adjustments.length"><td colspan="9" class="empty">没有调整单</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 超支留痕 ========== -->
    <div v-if="tab === 'alert'" class="block">
      <div class="hint-bar">
        这里记录的是<b>已经放行的超支</b>：要么在容忍比例内，要么填了超预算说明被特批。
        留痕的目的是事后能回答「这笔为什么超了、谁批的」。点「确认」时还要写处理意见（比如追加预算或下月压缩）。
      </div>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 172px">时间</th><th style="width: 108px">类型</th><th style="width: 100px">部门</th>
            <th style="width: 100px">科目</th><th style="width: 80px">月份</th>
            <th style="width: 100px" class="num">预算</th><th style="width: 100px" class="num">超支</th>
            <th style="padding-left: 12px">理由</th><th style="width: 104px">状态</th><th style="width: 84px">操作</th></tr></thead>
          <tbody>
            <tr v-for="a in alerts" :key="a.id" :class="a.type === 'over_budget' ? 'row-bad' : 'row-warn'">
              <td class="tiny mono">{{ a.created_at }}</td>
              <td class="tiny">{{ a.type_label }}</td>
              <td class="tiny">{{ a.department_name || '—' }}</td>
              <td class="tiny">{{ a.account_name || '—' }}</td>
              <td class="tiny mono">{{ a.period }}</td>
              <td class="num">{{ money(a.budget_amount) }}</td>
              <td class="num amt-red">{{ money(a.over_amount) }}</td>
              <td class="tiny wrap">{{ a.reason || '—' }}</td>
              <td><span class="pill" :class="a.status === 'acked' ? 'p-green' : 'p-orange'">{{ a.status_label }}</span></td>
              <td class="ops">
                <button v-if="a.status !== 'acked' && canWrite" class="btn btn-ghost btn-sm" @click="openAck(a)">确认</button>
                <span v-else class="tiny muted">{{ a.acked_by || '' }}</span>
              </td>
            </tr>
            <tr v-if="!alerts.length"><td colspan="10" class="empty">没有超支记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 弹窗：新建编制 ========== -->
    <div v-if="modal === 'new'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>新建预算编制</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>预算年度</label>
          <input v-model.number="newForm.fiscal_year" type="number" />
          <label>名称</label>
          <input v-model="newForm.name" placeholder="例：2027 年度费用预算" />
          <label>容忍比例（%）</label>
          <input v-model.number="newForm.tolerance_pct" type="number" min="0" max="50" />
          <label>起始月份（默认 1 月，先建空表再逐月填）</label>
          <input v-model="newForm.start_month" type="month" />
          <div class="hint-bar" style="margin-top: 10px">
            建好是<b>编制中</b>状态，不参与控制；批准后再点「生效」才会管钱。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doCreate">创建</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：驳回 ========== -->
    <div v-if="modal === 'reject'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>驳回</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>原因（至少 4 个字）</label>
          <input v-model="rejectReason" placeholder="例：生产部预算偏高，按去年实际重编" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doReject">确认驳回</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：调整申请 ========== -->
    <div v-if="modal === 'adj'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>申请预算调整</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>类型</label>
          <select v-model="adjForm.type">
            <option value="transfer">部门/科目间调剂</option>
            <option value="increase">追加</option>
            <option value="decrease">调减</option>
          </select>
          <div v-if="adjForm.type !== 'increase'" class="two">
            <div>
              <label>从（部门）</label>
              <select v-model.number="adjForm.from_department_id">
                <option v-for="d in dict.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
            </div>
            <div>
              <label>从（科目）</label>
              <select v-model="adjForm.from_account_code">
                <option v-for="a in dict.accounts" :key="a.code" :value="a.code">{{ a.name }}</option>
              </select>
            </div>
          </div>
          <div v-if="adjForm.type !== 'decrease'" class="two">
            <div>
              <label>到（部门）</label>
              <select v-model.number="adjForm.to_department_id">
                <option v-for="d in dict.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
            </div>
            <div>
              <label>到（科目）</label>
              <select v-model="adjForm.to_account_code">
                <option v-for="a in dict.accounts" :key="a.code" :value="a.code">{{ a.name }}</option>
              </select>
            </div>
          </div>
          <label>月份</label>
          <input v-model="adjForm.period" type="month" />
          <label>金额</label>
          <input v-model.number="adjForm.amount" type="number" min="0" />
          <label>原因（至少 8 个字）</label>
          <textarea v-model="adjForm.reason" rows="3" placeholder="预算变动要能讲清楚为什么"></textarea>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doAdj">提交</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：确认超支 ========== -->
    <div v-if="modal === 'ack'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>确认超支并写处理意见</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="ack-sum" v-if="ackTarget">
            {{ ackTarget.department_name }} · {{ ackTarget.account_name }} · {{ ackTarget.period }}
            <div>预算 {{ money(ackTarget.budget_amount) }}，超支 <b class="amt-red">{{ money(ackTarget.over_amount) }}</b></div>
            <div class="muted tiny">{{ ackTarget.reason }}</div>
          </div>
          <label>处理意见（至少 4 个字）</label>
          <input v-model="ackNote" placeholder="例：下月压缩招待费，本月不动预算" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doAck">确认</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';
import { can } from '../store/permissions';

const tab = ref('exec');
const period = ref('2026-10');
const ov = ref({});
const dict = ref({ departments: [], accounts: [], years: [] });
const exec = ref({ rows: [] });
const commitments = ref([]);
const list = ref([]);
const adjustments = ref([]);
const alerts = ref([]);
const cur = ref(null);
const matrix = ref({});
const planMonth = ref('2026-10');
const planYear = ref(2026);
const filterDept = ref('');
const onlyDiff = ref(false);

const modal = ref('');
const rejectReason = ref('');
const rejectTarget = ref(null);
const rejectKind = ref('');
const ackTarget = ref(null);
const ackNote = ref('');
const newForm = ref({ fiscal_year: 2027, name: '', tolerance_pct: 0, start_month: '2027-01' });
const adjForm = ref({
  type: 'transfer', from_department_id: 1, from_account_code: '6602',
  to_department_id: 4, to_account_code: '6602', period: '2026-10', amount: 0, reason: ''
});

const canWrite = computed(() => can('budget.write'));
const isAdmin = computed(() => (auth.user && auth.user.role) === 'admin');
const canApprove = computed(() => isAdmin.value || (auth.user && auth.user.role === 'finance'));

const money = (v) => '¥' + (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const deptCount = computed(() => (ov.value.by_dept || []).length);
const pctClass = (p) => (p > 100 ? 'st-bad' : p >= 90 ? 'st-warn' : '');
const bstatusCls = (s) => ({ active: 'p-green', approved: 'p-blue', draft: 'p-gray', closed: 'p-gray', rejected: 'p-red' }[s] || 'p-gray');
const flagCls = (f) => ({ over: 'p-red', near: 'p-orange', fast: 'p-blue', ok: 'p-green' }[f] || 'p-gray');
const flagLabel = (f) => ({ over: '超预算', near: '接近上限', fast: '花得快', ok: '正常' }[f] || f);

const deptRows = computed(() => dict.value.departments || []);

function closeModal() { modal.value = ''; }
function toast(m) { window.alert(m); }

async function loadDict() {
  dict.value = await api.budgetDict();
  if (dict.value.years && dict.value.years.length) planYear.value = dict.value.years[0];
}

async function loadOverview() {
  ov.value = await api.budgetOverview({ period: period.value });
}

async function loadExecution() {
  const r = await api.budgetExecution({
    period: period.value, department_id: filterDept.value || undefined,
    only_diff: onlyDiff.value ? 1 : undefined
  });
  exec.value = r;
  const c = await api.budgetCommitments({ status: 'open' });
  commitments.value = c;
}

async function loadList() {
  list.value = await api.budgetList({ year: planYear.value });
  if (list.value.length) {
    // 编制页优先打开「编制中」的那份（那里能改），没有才看生效中的
    const pick = list.value.find((b) => b.status === 'draft')
      || list.value.find((b) => b.status === 'active')
      || list.value[0];
    await openEdit(pick);
  } else {
    cur.value = null;
  }
}

async function loadAdjustments() {
  adjustments.value = await api.budgetAdjustments({});
}

async function loadAlerts() {
  alerts.value = await api.budgetAlerts({});
}

function go(k) {
  tab.value = k;
  if (k === 'exec') { loadExecution(); }
  if (k === 'plan') { loadList(); }
  if (k === 'adj') { loadAdjustments(); }
  if (k === 'alert') { loadAlerts(); }
}

async function reload() {
  await loadOverview();
  go(tab.value);
}

// ---------- 编制 ----------
async function openEdit(b) {
  const full = await api.budgetDetail(b.id);
  cur.value = full;
  curTolerance.value = full.tolerance_pct;
  planMonth.value = (full.items && full.items.length) ? full.items[0].period : `${full.fiscal_year}-01`;
  fillMatrix();
}

const curTolerance = ref(0);

function fillMatrix() {
  const m = {};
  (dict.value.departments || []).forEach((d) => {
    (dict.value.accounts || []).forEach((a) => { m[d.id + '_' + a.code] = 0; });
  });
  if (cur.value && cur.value.items) {
    cur.value.items.filter((it) => it.period === planMonth.value).forEach((it) => {
      if (it.department_id) m[it.department_id + '_' + it.account_code] = it.amount;
    });
  }
  matrix.value = m;
}

function gridValue(deptId, code) {
  if (!cur.value || !cur.value.items) return 0;
  const it = cur.value.items.find((x) => x.period === planMonth.value && x.department_id === deptId && x.account_code === code);
  return it ? it.amount : 0;
}
function rowSum(deptId) {
  return (dict.value.accounts || []).reduce((a, x) => a + Number(matrix.value[deptId + '_' + x.code] || 0), 0);
}
function colSum(code) {
  return (dict.value.departments || []).reduce((a, d) => a + Number(matrix.value[d.id + '_' + code] || 0), 0);
}
const grandTotal = computed(() => (dict.value.departments || []).reduce((a, d) => a + rowSum(d.id), 0));

function recalcRow() { /* 计算属性会自动跟随 matrix 变化，这里留空占位 */ }

async function saveMatrix() {
  if (!cur.value) return;
  // 只提交本月：先按「本月 + 其它月」拼出完整明细，避免保存时把别的月份冲掉
  const others = (cur.value.items || []).filter((it) => it.period !== planMonth.value)
    .map((it) => ({ department_id: it.department_id, account_code: it.account_code, period: it.period, amount: it.amount }));
  const curMonth = [];
  (dict.value.departments || []).forEach((d) => {
    (dict.value.accounts || []).forEach((a) => {
      const v = Number(matrix.value[d.id + '_' + a.code] || 0);
      if (v > 0) curMonth.push({ department_id: d.id, account_code: a.code, period: planMonth.value, amount: v });
    });
  });
  const items = others.concat(curMonth);
  if (!items.length) { toast('本月没有填任何金额，其它月份也没数据，至少要有一条'); return; }
  try {
    const r = await api.updateBudget(cur.value.id, { items });
    toast(`已保存，预算总额 ${money(r.total_amount)}（${r.item_count} 条）`);
    await loadList(); await loadOverview();
  } catch (e) { toast(e.message || '保存失败'); }
}

async function saveTolerance() {
  try {
    await api.updateBudget(cur.value.id, { tolerance_pct: curTolerance.value });
    toast('容忍比例已保存');
    await loadList();
  } catch (e) { toast(e.message || '保存失败'); }
}

function openNew() {
  const y = Number(planYear.value) || new Date().getFullYear();
  newForm.value = { fiscal_year: y, name: `${y} 年度费用预算`, tolerance_pct: 0, start_month: `${y}-01` };
  modal.value = 'new';
}

async function doCreate() {
  const f = newForm.value;
  if (!f.name) { toast('请填名称'); return; }
  // 建表时先给起始月放一条 0 元占位？后端要求至少一条明细，所以默认给一个 1 元占位会被当成真预算，
  // 这里改成直接建「起始月 + 全部部门 × 第一个科目 = 0」，0 元也是合法明细，编制页再逐月填。
  const items = (dict.value.departments || []).map((d) => ({
    department_id: d.id,
    account_code: (dict.value.accounts[0] || {}).code || '6602',
    period: f.start_month,
    amount: 0
  }));
  try {
    await api.createBudget({
      fiscal_year: f.fiscal_year, name: f.name,
      tolerance_pct: f.tolerance_pct, items
    });
    closeModal();
    toast('已创建（编制中），接下来逐月填金额');
    planYear.value = f.fiscal_year;
    await loadList(); await loadOverview();
  } catch (e) { toast(e.message || '创建失败'); }
}

async function doApprove(b) {
  try {
    await api.approveBudget(b.id);
    toast('已批准；再点「生效」才会开始管钱');
    await loadList(); await loadOverview();
  } catch (e) { toast(e.message || '批准失败'); }
}

function openReject(b) { rejectTarget.value = b; rejectKind.value = 'budget'; rejectReason.value = ''; modal.value = 'reject'; }

async function doReject() {
  try {
    if (rejectKind.value === 'budget') await api.rejectBudget(rejectTarget.value.id, { reason: rejectReason.value });
    else await api.rejectAdjustment(rejectTarget.value.id, { reason: rejectReason.value });
    closeModal(); toast('已驳回');
    await loadList(); await loadAdjustments(); await loadOverview();
  } catch (e) { toast(e.message || '驳回失败'); }
}

async function doActivate(b) {
  if (!window.confirm(`生效后同年度其它预算会自动关闭，确定让 ${b.budget_no} 生效？`)) return;
  try {
    const r = await api.activateBudget(b.id);
    toast(r.closed_previous && r.closed_previous.length
      ? `已生效；同时关闭了 ${r.closed_previous.join('、')}`
      : '已生效');
    await loadList(); await loadOverview();
  } catch (e) { toast(e.message || '生效失败'); }
}

async function doClose(b) {
  if (!window.confirm(`关闭 ${b.budget_no} 后不再参与控制，确定？`)) return;
  try {
    await api.closeBudget(b.id);
    toast('已关闭');
    await loadList(); await loadOverview();
  } catch (e) { toast(e.message || '关闭失败'); }
}

// ---------- 调整单 ----------
function openAdj() {
  adjForm.value = {
    type: 'transfer', from_department_id: 1, from_account_code: '6602',
    to_department_id: 4, to_account_code: '6602', period: period.value, amount: 0, reason: ''
  };
  modal.value = 'adj';
}

async function doAdj() {
  const b = ov.value.budget;
  if (!b) { toast('当年没有预算，无法调整'); return; }
  try {
    const r = await api.createBudgetAdjustment({ ...adjForm.value, budget_id: b.id });
    closeModal();
    toast(`已提交 ${r.adj_no}，等审批`);
    await loadAdjustments(); await loadOverview();
  } catch (e) { toast(e.message || '提交失败'); }
}

async function doApproveAdj(a) {
  try {
    await api.approveAdjustment(a.id);
    toast('已批准，预算额度立即生效');
    await loadAdjustments(); await loadOverview(); await loadExecution();
  } catch (e) { toast(e.message || '批准失败'); }
}

function openRejectAdj(a) { rejectTarget.value = a; rejectKind.value = 'adj'; rejectReason.value = ''; modal.value = 'reject'; }

// ---------- 超支确认 ----------
function openAck(a) { ackTarget.value = a; ackNote.value = ''; modal.value = 'ack'; }

async function doAck() {
  try {
    await api.ackBudgetAlert(ackTarget.value.id, { note: ackNote.value });
    closeModal(); toast('已确认');
    await loadAlerts(); await loadOverview();
  } catch (e) { toast(e.message || '确认失败'); }
}

onMounted(async () => {
  await loadDict();
  await loadOverview();
  await loadExecution();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 19px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.stat.st-warn { background: #fffaf2; border-color: #f3e0c2; }
.stat.st-warn strong { color: #d97706; }
.stat.st-bad { background: #fff5f6; border-color: #f6d4d9; }
.stat.st-bad strong { color: #d92d45; }

.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.amt-green { color: #16a34a; }
.muted { color: #9aa4b5; }
.tiny { font-size: 11.5px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.tb-tbl td.mono { white-space: nowrap; }
.num { text-align: right; }
.wrap { white-space: normal; line-height: 1.55; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #a9b4c5; font-size: 12px; padding: 18px 0; }
.empty-box { color: #a9b4c5; font-size: 12.5px; text-align: center; padding: 34px 0; grid-column: 1 / -1; }
.row-warn { background: #fffdf7; }
.row-bad { background: #fff7f8; }
.row-active { background: #f7fcf9; }

.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.75; margin: 0 0 12px; }
.block { margin-top: 14px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }

.tabbar { display: flex; align-items: flex-start; margin-bottom: 6px; }
.tabbar .tabs { margin-left: 0; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.tabbar .tabs button { flex: 0 0 auto; white-space: nowrap; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }

.pill { display: inline-block; white-space: nowrap; font-size: 11px; border-radius: 5px; padding: 1px 6px; }
.p-green { background: #eaf7ef; color: #16803c; }
.p-orange { background: #fff4e5; color: #b46207; }
.p-red { background: #fdecef; color: #c0243c; }
.p-gray { background: #eef1f6; color: #6b7789; }
.p-blue { background: #eaf1ff; color: #2563eb; }

/* 部门卡片 */
.dept-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.dept-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 10px 12px; }
.dept-card.dc-warn { border-color: #f3e0c2; background: #fffdf7; }
.dept-card.dc-bad { border-color: #f6d4d9; background: #fff7f8; }
.dc-head { display: flex; justify-content: space-between; align-items: baseline; }
.dc-head b { font-size: 12.5px; color: #16233b; }
.dc-head span { font-size: 13px; font-weight: 700; color: #4a566e; }
.dc-bar { height: 5px; background: #eef1f6; border-radius: 3px; margin: 7px 0 6px; overflow: hidden; }
.dc-bar i { display: block; height: 100%; background: #3b82f6; border-radius: 3px; }
.dc-bar i.bar-warn { background: #d97706; }
.dc-bar i.bar-bad { background: #d92d45; }
.dc-num { font-size: 11.5px; color: #4a566e; display: flex; gap: 4px; flex-wrap: wrap; }
.dc-foot { font-size: 11.5px; color: #8a94a6; margin-top: 4px; display: flex; justify-content: space-between; align-items: center; }

/* 编制矩阵 */
.plan-box { margin-top: 16px; background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.pb-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.pb-head b { font-size: 13px; color: #16233b; font-family: ui-monospace, Menlo, Consolas, monospace; }
.pb-total { margin-left: auto; font-size: 13px; font-weight: 700; color: #16233b; }
.cell-input { width: 96px; text-align: right; border: 1px solid #dfe5ee; border-radius: 6px; padding: 3px 6px; font-size: 12px; }
.sum-row td { background: #f8fafd; font-weight: 600; }

.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.chk { font-size: 12px; color: #4a566e; display: flex; align-items: center; gap: 4px; }
input:not([type]), input[type='month'], input[type='number'], select { border: 1px solid #dfe5ee; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; }
textarea { width: 100%; border: 1px solid #dfe5ee; border-radius: 8px; padding: 7px 9px; font-size: 12.5px; font-family: inherit; }
.form-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }

/* 表格 */
.tb-tbl { min-width: 1020px; width: 100%; }
.tb-tbl th { text-align: left; }
.tb-tbl th.num { text-align: right; padding-right: 12px; }
.tb-tbl td.num { padding-right: 12px; }

.modal-body label { display: block; font-size: 12px; color: #8a94a6; margin: 8px 0 4px; }
.modal-body input, .modal-body select { width: 100%; }
.modal-body textarea { width: 100%; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ack-sum { background: #f8fafd; border-radius: 8px; padding: 9px 11px; font-size: 12.5px; color: #3d4a63; line-height: 1.8; margin-bottom: 8px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .dept-grid { grid-template-columns: 1fr; }
  .two { grid-template-columns: 1fr; }
}
</style>
