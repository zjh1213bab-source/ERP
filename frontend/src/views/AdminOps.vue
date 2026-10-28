<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>行政运营报表</h2>
        <p class="sub">
          八项固定指标：宿舍入住率、床位与押金、行政费用、饭卡资金、资产与实物领归、耗材收发结存、行政预算差异、工单超时与复验。
          <b>入住率 = 住用床日 / 可用床日</b>，不拿当前人数除年末床数；
          <b>费用只认已入账事实</b>，不含预算占用；<b>算不出来的写在「口径与未覆盖」里</b>，不拿 0 冒充没有。
          定版会把这八个数与口径一起冻结 —— 以后有人问「上个月看的时候不是这个数吗」，两份快照并排放。
        </p>
      </div>
      <div class="head-ops">
        <select v-model="period" class="select" style="width: 120px" @change="preview">
          <option v-for="p in meta.periods || []" :key="p" :value="p">{{ p }}</option>
        </select>
        <select v-model="companyId" class="select" style="width: 170px" @change="preview">
          <option :value="null">全部主体</option>
          <option v-for="c in meta.companies || []" :key="c.id" :value="c.id">{{ c.short_name || c.name }}</option>
        </select>
        <button class="btn btn-ghost" @click="preview">重新计算</button>
        <button v-if="canRun" class="btn btn-primary" @click="askRun">定版</button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card accent">
        <div class="label">宿舍入住率</div>
        <div class="value">{{ pct(dorm.occupancy_rate) }}</div>
        <div class="foot">住用 {{ dorm.used_bed_days || 0 }} / 可用 {{ dorm.available_bed_days || 0 }} 床日</div>
      </div>
      <div class="stat-card">
        <div class="label">行政费用</div>
        <div class="value">¥{{ money(expense.total) }}</div>
        <div class="foot">
          {{ expense.count || 0 }} 笔<template v-if="expense.mom_pct != null"> · 环比 {{ expense.mom_pct > 0 ? '+' : '' }}{{ expense.mom_pct }}%</template>
        </div>
      </div>
      <div class="stat-card" :class="{ warn: budget.diff > 0 }">
        <div class="label">预算执行</div>
        <div class="value">{{ pct(budget.used_pct) }}</div>
        <div class="foot">预算 ¥{{ money(budget.total) }} / 实际 ¥{{ money(budget.actual) }}</div>
      </div>
      <div class="stat-card" :class="{ warn: meal.diff_personal || meal.diff_subsidy }">
        <div class="label">饭卡资金</div>
        <div class="value">¥{{ money((meal.personal_balance || 0) + (meal.subsidy_balance || 0)) }}</div>
        <div class="foot">
          <span v-if="!meal.diff_personal && !meal.diff_subsidy">余额与流水一致</span>
          <span v-else class="red">与流水差 ¥{{ money((meal.diff_personal || 0) + (meal.diff_subsidy || 0)) }}</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="label">工单复验率</div>
        <div class="value">{{ pct(repair.verify_rate) }}</div>
        <div class="foot">已复验 {{ repair.verify_hit || 0 }} / 进入提交 {{ repair.verify_base || 0 }} 条</div>
      </div>
      <div class="stat-card" :class="{ warn: summary.high_count }">
        <div class="label">差异项</div>
        <div class="value">{{ findingsShown.length }}</div>
        <div class="foot">严重 {{ summary.high_count || 0 }} 条 · {{ currentRun ? '已定版' : '未定版' }}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'metrics' }" @click="tab = 'metrics'">八项指标</button>
          <button :class="{ on: tab === 'findings' }" @click="tab = 'findings'">差异清单（{{ findingsShown.length }}）</button>
          <button :class="{ on: tab === 'runs' }" @click="tab = 'runs'; loadRuns()">历史版本（{{ runs.length }}）</button>
        </div>
        <div class="head-ops">
          <span v-if="currentRun" class="tiny mut">
            当前查看：{{ currentRun.run_no }} · {{ ymd(currentRun.generated_at) }}
          </span>
          <span v-else class="tiny mut">当前为实时计算（未定版，差异不可分派）</span>
        </div>
      </div>

      <!-- ================= 八项指标 ================= -->
      <div v-if="tab === 'metrics'" class="sec-grid">
        <!-- 1+2 宿舍 -->
        <div class="sec">
          <div class="sec-h">
            <b>① 宿舍入住与床位</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('dorm')">住宿明细</button>
          </div>
          <div class="kv"><span>可用床日</span><b>{{ dorm.available_bed_days || 0 }}</b></div>
          <div class="kv"><span>住用床日</span><b>{{ dorm.used_bed_days || 0 }}</b></div>
          <div class="kv"><span>空床日</span><b>{{ dorm.empty_bed_days || 0 }}</b></div>
          <div class="kv"><span>入住率</span><b>{{ pct(dorm.occupancy_rate) }}</b></div>
          <div class="kv"><span>床位</span><b>{{ dorm.beds_total || 0 }} 张（可用 {{ dorm.beds_usable || 0 }} · 维修 {{ dorm.beds_maintenance || 0 }}）</b></div>
          <div class="kv"><span>在住 / 已退</span><b>{{ dorm.deposits ? dorm.deposits.active_count : 0 }} / {{ dorm.deposits ? dorm.deposits.checked_out_count : 0 }} 人</b></div>
          <div class="kv"><span>在住押金</span><b>¥{{ money(dorm.deposit_balance) }}</b></div>
          <div class="kv" v-if="dorm.deposits && dorm.deposits.checked_out_deposit">
            <span>退住押金</span><b class="red">¥{{ money(dorm.deposits.checked_out_deposit) }}（系统无退还记录，需人工核对）</b>
          </div>
          <div class="tiny mut sec-note">{{ dorm.maintenance_note }}</div>
        </div>

        <!-- 3 行政费用 -->
        <div class="sec">
          <div class="sec-h">
            <b>② 行政费用</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('expense')">费用明细</button>
          </div>
          <div class="kv"><span>合计</span><b>¥{{ money(expense.total) }}（{{ expense.count || 0 }} 笔）</b></div>
          <div class="kv" v-for="c in (expense.by_category || []).slice(0, 5)" :key="c.category">
            <span>{{ c.category }}</span><b>¥{{ money(c.amount) }}</b>
          </div>
          <div class="kv"><span>未归口</span>
            <b :class="{ red: expense.unassigned_count }">{{ expense.unassigned_count || 0 }} 笔 · ¥{{ money(expense.unassigned_amount) }}</b>
          </div>
          <div class="kv"><span>上月</span><b>¥{{ money(expense.prev_month ? expense.prev_month.total : 0) }}（{{ expense.prev_month ? expense.prev_month.period : '—' }}）</b></div>
          <div class="tiny mut sec-note">只认已入账的行政费用单，不含预算占用</div>
        </div>

        <!-- 4 饭卡 -->
        <div class="sec">
          <div class="sec-h">
            <b>③ 饭卡资金</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('meal')">账户与流水</button>
          </div>
          <div class="kv"><span>账户</span><b>{{ meal.accounts || 0 }} 个（活跃 {{ meal.active || 0 }} · 挂失 {{ meal.lost || 0 }}）</b></div>
          <div class="kv"><span>个人余额</span><b>¥{{ money(meal.personal_balance) }}</b></div>
          <div class="kv"><span>补贴余额</span><b>¥{{ money(meal.subsidy_balance) }}</b></div>
          <div class="kv"><span>流水净额</span>
            <b :class="{ red: meal.diff_personal || meal.diff_subsidy }">
              个人 ¥{{ money(meal.ledger_personal) }} · 补贴 ¥{{ money(meal.ledger_subsidy) }}
            </b>
          </div>
          <div class="kv" v-if="meal.diff_personal || meal.diff_subsidy"><span>差额</span>
            <b class="red">个人 {{ money(meal.diff_personal) }} · 补贴 {{ money(meal.diff_subsidy) }}</b>
          </div>
          <div class="kv"><span>本期消费</span><b>¥{{ money(meal.period_consume) }}（补贴 {{ money(meal.period_subsidy) }} / 充值 {{ money(meal.period_recharge) }}）</b></div>
          <div class="tiny mut sec-note">余额 = 流水加出来的；不相等说明有人绕过流水改过余额</div>
        </div>

        <!-- 5 资产与领归 -->
        <div class="sec">
          <div class="sec-h">
            <b>④ 固定资产与实物领归</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('asset')">资产清单</button>
          </div>
          <div class="kv"><span>固定资产</span><b>{{ asset.count || 0 }} 项（在用 {{ asset.in_use || 0 }} · 闲置 {{ asset.idle || 0 }} · 报废 {{ asset.scrapped || 0 }}）</b></div>
          <div class="kv"><span>原值 / 净值</span><b>¥{{ money(asset.original_total) }} / ¥{{ money(asset.net_total) }}</b></div>
          <div class="kv"><span>在手实物</span><b>{{ asset.custody ? asset.custody.open_cnt : 0 }} 条（超期 {{ asset.custody ? asset.custody.overdue_cnt : 0 }}）</b></div>
          <div class="kv"><span>损坏待处理</span><b :class="{ red: asset.custody && asset.custody.hold_cnt }">{{ asset.custody ? asset.custody.hold_cnt : 0 }} 件</b></div>
          <div class="kv"><span>定责未收回</span>
            <b :class="{ red: asset.custody && asset.custody.claim_unconfirmed }">
              {{ asset.custody ? asset.custody.claim_unconfirmed : 0 }} 笔 · ¥{{ money(asset.custody ? asset.custody.claim_unconfirmed_amount : 0) }}
            </b>
          </div>
          <div class="kv"><span>清退中</span><b>{{ asset.custody ? asset.custody.clearance_open : 0 }} 张</b></div>
          <div class="tiny mut sec-note">期末时点数；净值读自资产台账，不在报表里重算折旧</div>
        </div>

        <!-- 6 耗材 -->
        <div class="sec">
          <div class="sec-h">
            <b>⑤ 耗材收发结存</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('office')">收发与结存</button>
          </div>
          <div class="kv"><span>本期入库</span><b>{{ num(office.in_qty) }}</b></div>
          <div class="kv"><span>本期领用</span><b>{{ num(office.out_qty) }}</b></div>
          <div class="kv"><span>退回 / 调整</span><b>{{ num(office.back_qty) }} / {{ num(office.adjust_qty) }}</b></div>
          <div class="kv"><span>期末结存</span><b>{{ num(office.closing_qty) }}（{{ office.items || 0 }} 个物品）</b></div>
          <div class="kv"><span>低于最低</span><b :class="{ red: (office.low_stock || []).length }">{{ (office.low_stock || []).length }} 项</b></div>
          <div class="tiny mut sec-note">库存余额与流水合计逐项核对，不等即点名</div>
        </div>

        <!-- 7 预算 -->
        <div class="sec">
          <div class="sec-h">
            <b>⑥ 行政预算差异</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('budget')">预算科目</button>
          </div>
          <div class="kv"><span>预算版本</span><b>{{ budget.budget_no || '本期无生效预算' }}</b></div>
          <div class="kv"><span>预算</span><b>¥{{ money(budget.total) }}</b></div>
          <div class="kv"><span>实际</span><b>¥{{ money(budget.actual) }}</b></div>
          <div class="kv"><span>差异</span>
            <b :class="{ red: budget.diff > 0, 'green-t': budget.diff < 0 }">
              {{ budget.diff > 0 ? '+' : '' }}{{ money(budget.diff) }}
            </b>
          </div>
          <div class="kv"><span>执行率</span><b>{{ pct(budget.used_pct) }}（容忍 {{ budget.tolerance_pct || 0 }}%）</b></div>
          <div class="tiny mut sec-note">只对比「人事行政部」的已入账费用；未归口部门的费用不在这里</div>
        </div>

        <!-- 8 工单 -->
        <div class="sec">
          <div class="sec-h">
            <b>⑦ 工单超时与复验</b>
            <span class="sp"></span>
            <button class="btn btn-sm btn-ghost" @click="drill('repair')">工单明细</button>
          </div>
          <div class="kv"><span>本期报修</span><b>{{ repair.reported || 0 }} 条（未完成 {{ repair.open || 0 }}）</b></div>
          <div class="kv"><span>超期</span><b :class="{ red: repair.overdue }">{{ repair.overdue || 0 }} 条</b></div>
          <div class="kv"><span>无期限未完成</span><b>{{ repair.no_due || 0 }} 条</b></div>
          <div class="kv"><span>跳过复验</span><b :class="{ red: repair.skipped_verify }">{{ repair.skipped_verify || 0 }} 条</b></div>
          <div class="kv"><span>复验率</span><b>{{ pct(repair.verify_rate) }}（{{ repair.verify_hit || 0 }}/{{ repair.verify_base || 0 }}）</b></div>
          <div class="kv"><span>平均提交时长</span><b>{{ repair.avg_hours_to_submit == null ? '—' : repair.avg_hours_to_submit + ' 小时' }}</b></div>
          <div class="tiny mut sec-note">维修提交与复验放行必须两个人；提交后直接关单会被点名</div>
        </div>

        <!-- 口径 -->
        <div class="sec basis">
          <div class="sec-h"><b>口径与未覆盖</b></div>
          <div class="tiny">{{ basisText || (currentRun ? currentRun.basis : '') }}</div>
          <div class="coverage" v-if="coverage.length">
            <div class="cov-item" v-for="(c, i) in coverage" :key="i">· {{ c }}</div>
          </div>
          <div class="tiny mut" style="margin-top: 8px">更新时间：{{ ymd(previewAt) }}</div>
        </div>
      </div>

      <!-- ================= 差异清单 ================= -->
      <div v-else-if="tab === 'findings'">
        <div v-if="!currentRun" class="notice-warn">
          当前是实时计算，差异还没有单号、也不能分派。<b>点右上「定版」</b>后生成差异清单，之后按「分派 → 处理 → 复核关闭」走。
        </div>
        <div class="toolbar">
          <select v-model="fSeverity" class="select" style="width: 120px">
            <option value="">全部严重度</option>
            <option value="high">严重</option>
            <option value="mid">中等</option>
            <option value="low">提示</option>
          </select>
          <select v-model="fStatus" class="select" style="width: 130px">
            <option value="">全部状态</option>
            <option v-for="s in meta.finding_status || []" :key="s.code" :value="s.code">{{ s.label }}</option>
          </select>
          <span class="tiny mut">共 {{ filteredFindings.length }} 条</span>
        </div>
        <div class="table-wrap" v-if="filteredFindings.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 62px">严重度</th>
                <th style="width: 92px">指标</th>
                <th style="width: 210px">对象</th>
                <th style="width: 330px">应该 / 实际</th>
                <th style="width: 196px">状态与操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in filteredFindings" :key="f.id">
                <td><span class="tag" :class="sevCls(f.severity)">{{ f.severity_label }}</span></td>
                <td class="tiny">{{ f.metric_label }}</td>
                <td>
                  <div class="subj" :title="f.subject">{{ f.subject }}</div>
                  <div v-if="f.hint" class="tiny mut clamp2" :title="f.hint">{{ f.hint }}</div>
                </td>
                <td class="tiny">
                  <div class="ea"><span class="mut">应</span><span :title="f.expected">{{ f.expected || '—' }}</span></div>
                  <div class="ea"><span class="mut">实</span><span :title="f.actual">{{ f.actual || '—' }}</span></div>
                  <div v-if="f.diff != null" class="tiny red">差额 {{ money(f.diff) }} {{ f.unit || '' }}</div>
                </td>
                <td>
                  <div class="cell-ops">
                    <span class="tag" :class="stCls(f.status)">{{ f.status_label }}</span>
                    <span v-if="f.assignee" class="tiny mut">{{ f.assignee }}</span>
                  </div>
                  <div class="cell-btns" v-if="canReview">
                    <button v-if="f.status === 'open'" class="btn btn-sm btn-ghost" @click="openAssign(f)">分派</button>
                    <button v-if="['open','assigned'].includes(f.status)" class="btn btn-sm btn-primary" @click="openReview(f)">处理</button>
                    <button v-if="f.status === 'fixed'" class="btn btn-sm btn-primary" @click="openClose(f)">复核</button>
                    <button v-if="f.status !== 'closed'" class="btn btn-sm btn-ghost" @click="openIgnore(f)">忽略</button>
                  </div>
                  <div v-else class="tiny mut">只读</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">没有差异项。要么本月确实干净，要么还没定版（实时计算的差异在这里不展示操作）。</div>
      </div>

      <!-- ================= 历史版本 ================= -->
      <div v-else>
        <div class="table-wrap" v-if="runs.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 130px">报表号</th><th style="width: 90px">期间</th>
                <th style="width: 150px">主体</th><th class="num" style="width: 76px">差异</th>
                <th class="num" style="width: 76px">未关闭</th><th class="num" style="width: 76px">严重</th>
                <th style="width: 120px">入住率</th><th style="width: 130px">费用</th>
                <th style="width: 130px">生成</th><th style="width: 90px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in runs" :key="r.id">
                <td class="nowrap">{{ r.run_no }}</td>
                <td class="nowrap">{{ r.period }}</td>
                <td class="nowrap tiny">{{ r.company_name || '全部主体' }}</td>
                <td class="num">{{ r.finding_count }}</td>
                <td class="num" :class="{ red: r.open_count }">{{ r.open_count }}</td>
                <td class="num" :class="{ red: r.high_count }">{{ r.high_count }}</td>
                <td class="tiny">{{ pct(r.summary.occupancy_rate) }}</td>
                <td class="tiny">¥{{ money(r.summary.expense_total) }}</td>
                <td class="tiny nowrap">{{ r.generated_by }}<div class="mut">{{ ymd(r.generated_at) }}</div></td>
                <td class="ops"><button class="btn btn-sm btn-ghost" @click="openRun(r)">打开</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有定版过。选好期间点右上「定版」，这八个数与口径会被冻结成一份可对的快照。</div>
      </div>
    </div>

    <!-- ================= 定版确认 ================= -->
    <div class="modal-mask" v-if="runForm.open" @click.self="runForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>定版 {{ period }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="runForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            定版会把八项指标、口径说明与差异清单一起冻结成快照。之后数据补录不会改变这一版 ——
            要新数就再跑一次，两版并排放着对比。
          </div>
          <div class="kv"><span>期间</span><b>{{ period }}（{{ range.start }} ~ {{ range.end }}，{{ range.days }} 天）</b></div>
          <div class="kv"><span>主体</span><b>{{ currentCompanyName }}</b></div>
          <div class="kv"><span>将生成</span><b>{{ summary.finding_count || 0 }} 条差异（严重 {{ summary.high_count || 0 }}）</b></div>
          <div class="notice-warn" v-if="hasRun">
            该期间已经定版过（{{ hasRun.run_no }}）。继续会<b>生成新版本</b>，旧版本保留可对比。
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="runForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doRun">确认定版</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 下钻 ================= -->
    <div class="modal-mask" v-if="drillBox.open" @click.self="drillBox.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left"><b>{{ drillBox.title }}</b><span class="tag gray">{{ period }}</span></div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="drillBox.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div v-if="drillBox.note" class="notice-warn">{{ drillBox.note }}</div>
          <pre v-if="drillBox.raw" class="raw">{{ drillBox.raw }}</pre>
          <div v-else-if="drillBox.rows && drillBox.rows.length" class="table-wrap">
            <table class="data">
              <thead><tr><th v-for="c in drillBox.cols" :key="c.key">{{ c.label }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in drillBox.rows" :key="i">
                  <td v-for="c in drillBox.cols" :key="c.key" class="tiny" :class="{ nowrap: c.nowrap }">{{ c.fmt ? c.fmt(r[c.key], r) : (r[c.key] == null ? '—' : r[c.key]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="empty">没有明细数据。</div>
        </div>
      </div>
    </div>

    <!-- ================= 分派 ================= -->
    <div class="modal-mask" v-if="assignForm.open" @click.self="assignForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>分派 · {{ assignForm.f ? assignForm.f.subject : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="assignForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">分派只写「归谁查」，不改任何数据。处理完点「处理」写结果，再由别人复核关闭。</div>
          <div class="row">
            <label>分派给</label>
            <input v-model="assignForm.assignee" class="input" style="width: 160px" placeholder="姓名" />
            <label>期限</label>
            <input v-model="assignForm.due_date" class="input" type="date" style="width: 160px" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="assignForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doAssign">确认分派</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 已处理 ================= -->
    <div class="modal-mask" v-if="reviewForm.open" @click.self="reviewForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>已处理 · {{ reviewForm.f ? reviewForm.f.subject : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="reviewForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="reviewForm.f">
          <div class="tiny mut" style="margin-bottom: 8px">{{ reviewForm.f.expected }} → {{ reviewForm.f.actual }}</div>
          <div class="row">
            <label>处理结果</label>
            <textarea v-model="reviewForm.note" class="input" rows="3" style="flex: 1; min-width: 260px" placeholder="怎么处理的、涉及哪几张单（必填）"></textarea>
          </div>
          <div class="row">
            <label>处理人</label>
            <input v-model="reviewForm.assignee" class="input" style="width: 140px" placeholder="姓名" />
          </div>
          <div class="notice">提交后进入「已处理待复核」，<b>再由别人复核关闭</b> —— 自己处理自己关等于没有复核。</div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="reviewForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doReview">提交处理结果</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 复核关闭 ================= -->
    <div class="modal-mask" v-if="closeForm.open" @click.self="closeForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>复核关闭 · {{ closeForm.f ? closeForm.f.subject : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="closeForm.open = false">关闭</button>
        </div>
        <div class="modal-body" v-if="closeForm.f">
          <div class="kv"><span>处理结果</span><b>{{ closeForm.f.review_note || '（空）' }}</b></div>
          <div class="row">
            <label>复核结论</label>
            <textarea v-model="closeForm.note" class="input" rows="3" style="flex: 1; min-width: 260px" placeholder="核对过哪些单、结论是什么（必填）"></textarea>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="closeForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doClose">确认关闭</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 忽略 ================= -->
    <div class="modal-mask" v-if="ignoreForm.open" @click.self="ignoreForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>忽略差异 · {{ ignoreForm.f ? ignoreForm.f.subject : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="ignoreForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice-warn">忽略不是关闭。它表示「这条不算问题」，理由会留在清单上，下个月如果再出现也看得见。</div>
          <div class="row">
            <label>理由</label>
            <textarea v-model="ignoreForm.reason" class="input" rows="2" style="flex: 1; min-width: 240px" placeholder="≥6 字，写清楚为什么不算问题"></textarea>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="ignoreForm.open = false">取消</button>
            <button class="btn btn-primary" @click="doIgnore">确认忽略</button>
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

const tab = ref('metrics');
const period = ref(thisMonth);
const companyId = ref(null);

const meta = ref({});
const rep = ref({});
const runs = ref([]);
const currentRun = ref(null);
const previewAt = ref('');
const basisText = ref('');
const fSeverity = ref('');
const fStatus = ref('');

const canRun = computed(() => can('adminops.run'));
const canReview = computed(() => can('adminops.review'));

const num = (v) => Number(v || 0);
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '—' : `${v}%`);
const ymd = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');

const dorm = computed(() => rep.value.dorm || {});
const expense = computed(() => rep.value.expense || {});
const meal = computed(() => rep.value.meal || {});
const asset = computed(() => rep.value.asset || {});
const office = computed(() => rep.value.office || {});
const budget = computed(() => rep.value.budget || {});
const repair = computed(() => rep.value.repair || {});
const summary = computed(() => rep.value.summary || {});
const range = computed(() => rep.value.range || { start: '', end: '', days: 0 });
const coverage = computed(() => rep.value.coverage || []);

const findingsShown = computed(() => (currentRun.value ? currentRun.value.findings || [] : rep.value.findings || []));
const filteredFindings = computed(() =>
  findingsShown.value.filter((f) => (!fSeverity.value || f.severity === fSeverity.value) && (!fStatus.value || f.status === fStatus.value))
);
const currentCompanyName = computed(() => {
  const c = (meta.value.companies || []).find((x) => x.id === companyId.value);
  return c ? (c.short_name || c.name) : '全部主体';
});
const hasRun = computed(() => (runs.value || []).find((r) => r.period === period.value && (r.company_id || 0) === (companyId.value || 0)) || null);

const sevCls = (s) => ({ high: 'red', mid: 'orange', low: 'gray' }[s] || 'gray');
const stCls = (s) => ({ open: 'orange', assigned: 'blue', fixed: 'purple', closed: 'green', ignored: 'gray' }[s] || 'gray');

/* ---------------- 加载 ---------------- */
async function loadMeta() {
  try { meta.value = (await api.aoMeta()) || {}; } catch (e) { alert(e.message); }
}

async function preview() {
  try {
    const r = await api.aoPreview({ period: period.value, company_id: companyId.value || undefined });
    rep.value = r || {};
    basisText.value = buildBasis(r || {});
    previewAt.value = new Date().toISOString();
    currentRun.value = null;
    await loadRuns();
    const cur = hasRun.value;
    if (cur) await openRun(cur, true);   // 有定版就默认看定版
  } catch (e) { alert(e.message); }
}

/** 与服务端 basisText 同结构：页面上要能直接读到口径，不用再点开快照 */
function buildBasis(r) {
  const d = r.dorm || {};
  const e = r.expense || {};
  const m = r.meal || {};
  const b = r.budget || {};
  const o = r.office || {};
  const rp = r.repair || {};
  return [
    `入住率 = 住用床日 ${d.used_bed_days || 0} / 可用床日 ${d.available_bed_days || 0}`,
    `行政费用只认已入账 ¥${money(e.total)}，不含预算占用`,
    `饭卡：个人余额 ¥${money(m.personal_balance)} vs 流水 ¥${money(m.ledger_personal)}；补贴 ¥${money(m.subsidy_balance)} vs ¥${money(m.ledger_subsidy)}`,
    `耗材结存 ${o.closing_qty || 0}，与流水逐项核对`,
    `预算：${b.budget_no || '本期无生效预算'}`,
    `复验率 ${rp.verify_rate == null ? '样本不足不报' : rp.verify_rate + '%（' + (rp.verify_hit || 0) + '/' + (rp.verify_base || 0) + '）'}`
  ].join('；');
}

async function loadRuns() {
  try { runs.value = (await api.aoRuns({ period: period.value })) || []; } catch (e) { /* 静默 */ }
}

async function openRun(r, silent) {
  try {
    const d = await api.aoRunDetail(r.id);
    currentRun.value = d;
    rep.value = d.snapshot || rep.value;
    // 页面上的口径用「核心口径」那六句，不直接铺快照里的 basis ——
    // 快照里的 basis 把 coverage 也拼进去了，页面下面已经单独列一遍，会重复
    basisText.value = buildBasis(d.snapshot || rep.value);
    tab.value = silent ? 'metrics' : 'findings';
  } catch (e) { if (!silent) alert(e.message); }
}

/* ---------------- 定版 ---------------- */
const runForm = reactive({ open: false });
function askRun() { runForm.open = true; }
async function doRun() {
  try {
    const r = await api.aoRun({ period: period.value, company_id: companyId.value || undefined, force: !!hasRun.value });
    runForm.open = false;
    await loadRuns();
    await openRun(r, true);
    tab.value = 'findings';
  } catch (e) { alert(e.message); }
}

/* ---------------- 差异动作 ---------------- */
const assignForm = reactive({ open: false, f: null, assignee: '', due_date: '' });
function openAssign(f) { Object.assign(assignForm, { open: true, f, assignee: f.assignee || '', due_date: f.due_date || '' }); }
async function doAssign() {
  if (!assignForm.assignee.trim()) return alert('先填分派给谁');
  try {
    await api.aoAssign(assignForm.f.id, { assignee: assignForm.assignee, due_date: assignForm.due_date || undefined });
    assignForm.open = false;
    await refreshRun();
  } catch (e) { alert(e.message); }
}

const reviewForm = reactive({ open: false, f: null, note: '', assignee: '' });
function openReview(f) { Object.assign(reviewForm, { open: true, f, note: '', assignee: f.assignee || '' }); }
async function doReview() {
  if (!reviewForm.note.trim()) return alert('请写处理结果');
  try {
    await api.aoReview(reviewForm.f.id, { review_note: reviewForm.note, assignee: reviewForm.assignee || undefined });
    reviewForm.open = false;
    await refreshRun();
  } catch (e) { alert(e.message); }
}

const closeForm = reactive({ open: false, f: null, note: '' });
function openClose(f) { Object.assign(closeForm, { open: true, f, note: '' }); }
async function doClose() {
  if (!closeForm.note.trim()) return alert('请写复核结论');
  try {
    await api.aoClose(closeForm.f.id, { review_note: closeForm.note });
    closeForm.open = false;
    await refreshRun();
  } catch (e) { alert(e.message); }
}

const ignoreForm = reactive({ open: false, f: null, reason: '' });
function openIgnore(f) { Object.assign(ignoreForm, { open: true, f, reason: '' }); }
async function doIgnore() {
  if (ignoreForm.reason.trim().length < 6) return alert('忽略理由至少 6 个字');
  try {
    await api.aoIgnore(ignoreForm.f.id, { reason: ignoreForm.reason });
    ignoreForm.open = false;
    await refreshRun();
  } catch (e) { alert(e.message); }
}

async function refreshRun() {
  if (!currentRun.value) return;
  const d = await api.aoRunDetail(currentRun.value.id);
  currentRun.value = d;
  rep.value = d.snapshot || rep.value;
  await loadRuns();
}

/* ---------------- 下钻 ---------------- */
const drillBox = reactive({ open: false, title: '', cols: [], rows: [], note: '', raw: '' });
const TITLES = { dorm: '住宿明细', expense: '费用明细', meal: '饭卡账户与流水', asset: '资产清单', office: '耗材收发与结存', budget: '预算科目', repair: '工单明细' };

async function drill(metric) {
  try {
    const d = await api.aoDrill({ metric, period: period.value, company_id: companyId.value || undefined });
    Object.assign(drillBox, { open: true, title: TITLES[metric] || metric, note: d.note || '', rows: [], cols: [], raw: '' });
    if (metric === 'dorm' && d.rows && d.rows.stays) {
      drillBox.cols = [
        { key: 'room', label: '房间', fmt: (v, r) => `${r.building || ''}${r.room_no || ''}` },
        { key: 'bed_no', label: '床位' },
        { key: 'employee_name', label: '入住人' },
        { key: 'start_date', label: '起' },
        { key: 'end_date', label: '止', fmt: (v) => v || '在住' },
        { key: 'status', label: '状态', fmt: (v) => ({ active: '在住', checked_out: '已退', cancelled: '取消' }[v] || v) }
      ];
      drillBox.rows = d.rows.stays;
    } else if (metric === 'meal') {
      const accs = (d.rows && d.rows.accounts) || [];
      const txs = (d.rows && d.rows.transactions) || [];
      drillBox.raw = [
        '账户：',
        ...accs.map((a) => `  ${a.card_no || '-'} · 员工 #${a.employee_id} ${a.employee_name || ''} · 个人 ¥${a.balance} · 补贴 ¥${a.subsidy_balance} · ${a.status}`),
        '',
        '本期流水：',
        ...txs.map((x) => `  ${String(x.created_at).slice(0, 10)} ${x.type} ¥${x.amount}（个人 ${x.personal_delta} / 补贴 ${x.subsidy_delta}）${x.employee_name || ''} ${x.receipt_no || ''}`)
      ].join('\n');
    } else if (metric === 'office') {
      drillBox.cols = [
        { key: 'item_no', label: '编号', nowrap: true },
        { key: 'name', label: '物品' },
        { key: 'stock_qty', label: '库存' },
        { key: 'ledger_qty', label: '流水合计' },
        { key: 'min_qty', label: '最低' },
        { key: 'unit', label: '单位' }
      ];
      drillBox.rows = d.rows || [];
    } else if (metric === 'asset') {
      drillBox.cols = [
        { key: 'code', label: '资产编号', nowrap: true },
        { key: 'name', label: '名称' },
        { key: 'category', label: '类别' },
        { key: 'dept', label: '部门' },
        { key: 'keeper', label: '保管人' },
        { key: 'original_value', label: '原值', fmt: (v) => money(v) },
        { key: 'status', label: '状态', fmt: (v) => ({ in_use: '在用', idle: '闲置', scrapped: '已报废' }[v] || v) }
      ];
      drillBox.rows = d.rows || [];
    } else if (metric === 'budget') {
      drillBox.cols = [
        { key: 'department_name', label: '部门' },
        { key: 'account_code', label: '科目' },
        { key: 'account_name', label: '名称' },
        { key: 'amount', label: '预算', fmt: (v) => money(v) }
      ];
      drillBox.rows = d.rows || [];
    } else if (metric === 'repair') {
      drillBox.cols = [
        { key: 'repair_no', label: '工单号', nowrap: true },
        { key: 'facility', label: '设施' },
        { key: 'severity', label: '紧急度', fmt: (v) => ({ critical: '紧急', major: '重要', minor: '一般' }[v] || v) },
        { key: 'status', label: '状态', fmt: (v) => ({ reported: '已报修', repairing: '维修中', submitted: '已提交', verified: '已复验', closed: '已关闭', rejected: '不受理' }[v] || v) },
        { key: 'due_date', label: '期限', fmt: (v) => v || '无' },
        { key: 'verified_at', label: '复验', fmt: (v) => (v ? '有' : '无') }
      ];
      drillBox.rows = d.rows || [];
    } else {
      drillBox.cols = [
        { key: 'expense_date', label: '日期', nowrap: true },
        { key: 'category', label: '分类' },
        { key: 'amount', label: '金额', fmt: (v) => money(v) },
        { key: 'payee', label: '收款方' },
        { key: 'department_id', label: '部门', fmt: (v) => v || '未归口' }
      ];
      drillBox.rows = d.rows || [];
    }
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  await loadMeta();
  await preview();
});
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }

.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 100px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 11px; line-height: 1.4; }
.stat-card.warn { border-color: #fde68a; background: #fffdf5; }

.sec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.sec { border: 1px solid #eef1f6; border-radius: 10px; padding: 12px 14px; background: #fff; }
.sec-h { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
.sec-h .sp { flex: 1; }
.sec .kv { display: flex; gap: 8px; font-size: 12px; padding: 2.5px 0; align-items: baseline; }
.sec .kv > span { color: #7b8698; min-width: 84px; flex: 0 0 auto; }
.sec .kv > b { font-weight: 500; }
.sec-note { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #eef1f6; }
.sec.basis { grid-column: 1 / -1; background: #fbfcfe; }
.sec.basis .tiny { line-height: 1.75; color: #3d4757; }
.coverage { margin-top: 8px; }
.cov-item { font-size: 11.5px; color: #92400e; line-height: 1.7; }

.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.subj { font-size: 12px; font-weight: 600; white-space: normal; word-break: break-word; }
.clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ea { display: flex; gap: 6px; align-items: baseline; }
.ea > span:last-child { word-break: break-word; }
.cell-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 5px; }
.cell-btns { display: flex; gap: 5px; flex-wrap: wrap; }
.cell-btns .btn { padding: 3px 8px; font-size: 11.5px; }
.ell { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.ops .btn + .btn { margin-left: 6px; }

.notice { border: 1px solid #dbeafe; background: #f6faff; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #1e3a5f; margin-bottom: 10px; }
.notice-warn { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #92400e; margin-bottom: 10px; }

.modal.wide { width: min(1080px, 95vw); }
.mh-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.kv > span { color: #7b8698; min-width: 84px; flex: 0 0 auto; }
.kv > b { font-weight: 500; }
.raw { white-space: pre-wrap; font-size: 11.5px; line-height: 1.7; background: #f7f9fc; border-radius: 8px; padding: 10px 12px; max-height: 60vh; overflow: auto; margin: 0; }

.modal-body .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.modal-body .row label { font-size: 12px; color: #7b8698; flex: 0 0 auto; min-width: 62px; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .page-head .head-ops,
  .panel-head .head-ops { width: 100%; flex: 1 1 auto; flex-wrap: wrap; }
  .head-ops .select { flex: 1 1 45%; min-width: 0; }
  .head-ops .btn { flex: 1 1 40%; }
  .sec-grid { grid-template-columns: 1fr; }
}
</style>
