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
        <button :class="{ on: tab === 'att' }" @click="tab = 'att'">
          考勤联动<i v-if="attConflictCount" class="dot-bad"></i>
        </button>
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

      <!-- 诊断：都是「钱算不到人 / 算错人 / 算不准」的地方 -->
      <div v-if="attConflicts.length" class="diag bad">
        <div class="diag-h">
          <b>报工日请假/缺勤 {{ attConflicts.length }} 条</b>
          <span>
            考勤明确记了请假/旷工，那天却有以他名义的报工 —— 钱多半付错了人（代报 / 点错下拉框 / 虚报）。
            当前策略：<b>{{ attPolicyLabel }}</b>
          </span>
        </div>
        <table class="data sm">
          <thead>
            <tr><th>姓名</th><th>日期</th><th>当天考勤</th><th>订单</th><th>扎号</th><th>工序</th><th class="num">件数</th></tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in attConflicts.slice(0, 12)" :key="i">
              <td>{{ c.employee_name }}<span class="emp-code">{{ c.employee_code }}</span></td>
              <td class="tiny">{{ c.report_date }}</td>
              <td><span class="tag red">{{ c.att_label }}</span></td>
              <td class="mono tiny">{{ c.order_no }}</td>
              <td class="mono tiny">{{ c.bundle_no || '—' }}</td>
              <td>{{ c.process_name }}</td>
              <td class="num">{{ c.qty }}</td>
            </tr>
          </tbody>
        </table>
        <p class="tiny muted">
          处置：把报工改到真正干活的人名下；或到「考勤联动」把策略改成「剔除不计」（不付这笔）/「不许确认」（先清干净）。
        </p>
      </div>

      <div v-if="capRows.length" class="diag warn">
        <div class="diag-h">
          <b>件数封顶 {{ capRows.length }} 条</b>
          <span>日上限 / 缺勤封顶削掉的部分没计钱（先报先算，逐笔列出来核对）</span>
        </div>
        <table class="data sm">
          <thead>
            <tr><th>姓名</th><th>日期</th><th>订单</th><th>工序</th><th class="num">原报</th><th class="num">计入</th><th class="num">削掉</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in capRows.slice(0, 12)" :key="i">
              <td>{{ c.employee_name }}</td>
              <td class="tiny">{{ c.report_date }}</td>
              <td class="mono tiny">{{ c.order_no }}</td>
              <td>{{ c.process_name }}</td>
              <td class="num">{{ c.raw_qty }}</td>
              <td class="num">{{ c.counted }}</td>
              <td class="num over">{{ c.over }}</td>
              <td class="tiny">
                <span v-if="c.cap_kind === 'daily'">单日超 {{ c.daily_cap }} 件</span>
                <span v-else>月度超 {{ c.month_cap }} 件（出勤 {{ c.attended_days }} 天）</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

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

      <div v-if="noAttCount" class="diag info">
        <div class="diag-h">
          <b>无出勤记录 {{ noAttCount }} 条</b>
          <span>
            这些报工当天查不到考勤 —— <b>不等于缺勤</b>（计件车间常常不打卡、或考勤漏录），
            只作提示，不影响金额。要看细节去「考勤联动」页签。
          </span>
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
            <button v-action="['piece-wage','export']" v-if="run" class="btn btn-ghost btn-sm" @click="exportCsv">导出 CSV</button>
            <button v-if="run && run.status === 'confirmed'" class="btn btn-ghost btn-sm" @click="openPayslip(run.id)">
              出工资条
            </button>
            <button
              v-if="run && run.status === 'confirmed'"
              class="btn btn-ghost btn-sm"
              @click="openPayslip(run.id, 'public')"
            >
              车间公示表
            </button>
          </div>
        </div>
        <div class="table-wrap" style="max-height: 520px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr>
                <th>姓名</th><th>订单</th><th>扎号</th><th>工序</th><th>款号</th><th>报工日</th><th>考勤</th>
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
                <td class="tiny">{{ it.report_date || '—' }}</td>
                <td>
                  <span class="tag" :class="attTagClass(it.att_status)">{{ attLabel(it.att_status) }}</span>
                </td>
                <td class="num">{{ it.raw_qty }}</td>
                <td class="num">
                  {{ it.qty }}<i v-if="it.capped" class="cap">{{ it.cap_kind === 'month' ? '月封顶' : it.cap_kind === 'daily' ? '日封顶' : '封顶' }}</i>
                </td>
                <td class="num">{{ unitPrice(it.unit_price) }}<div v-if="it.wage_snapshot" class="tiny muted">{{ wageBasis(it.wage_snapshot) }}</div></td>
                <td class="num strong">¥{{ money(it.amount) }}</td>
                <td class="tiny">{{ it.rate_source === 'style' ? '款专属' : '通用' }}</td>
                <td class="tiny">{{ it.matched_by === 'id' ? '员工编号' : '姓名匹配' }}</td>
              </tr>
              <tr v-if="!viewItems.length"><td colspan="13" class="empty">没有明细</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ================= 考勤联动 ================= -->
    <template v-else-if="tab === 'att'">
      <div class="banner info">
        <b>报工那天人到底在不在</b>
        <span>
          计件的输入是报工，报工是人填的。<b>考勤明确写了请假/旷工，那天却有一笔以他名义的报工</b>，
          钱多半付错了人（代报 / 点错人 / 虚报）。这里只管这一件事，另加两道可选闸门：
          <b>单日件数上限</b>与<b>缺勤封顶</b>（月上限 = 日上限 × 出勤天数）。
          <b>查不到考勤不算异常</b> —— 计件车间常常不打卡，不能当旷工。
        </span>
      </div>

      <div v-if="canWrite" class="panel-card">
        <h3>闸门配置</h3>
        <div class="fgrid">
          <label>
            <span>每人每日计件上限（件，0 = 不限制）</span>
            <input v-model="cfgForm.daily_cap_qty" class="input" type="number" min="0" step="10" placeholder="0" />
          </label>
          <label>
            <span>月度封顶（按「日上限 × 出勤天数」）</span>
            <select v-model="cfgForm.month_cap" class="select">
              <option :value="1">启用（缺勤越多，能拿的件数越少）</option>
              <option :value="0">不启用（只按单日上限管）</option>
            </select>
          </label>
          <label class="full">
            <span>请假/缺勤当日报工怎么处理</span>
            <select v-model="cfgForm.attendance_policy" class="select">
              <option value="warn">只提示：照算金额，确认时要求写一句说明（默认，不误伤）</option>
              <option value="exclude">剔除不计：这些笔不算钱，逐笔列出给人核对</option>
              <option value="block">不许确认：先改报工归属，清干净才允许确认</option>
            </select>
          </label>
        </div>
        <div class="form-foot">
          <button class="btn btn-primary" :disabled="busy" @click="saveConfig">保存配置</button>
          <span class="tiny muted">
            日上限是「车间一天最多能做多少件」，只有厂里知道，系统不猜 —— 填 0 就是完全不管件数，只做考勤核对。
          </span>
        </div>
      </div>

      <div class="cards four">
        <div class="stat-card">
          <div class="label">有报工的人</div>
          <div class="value">{{ attBoard.summary ? attBoard.summary.employees : 0 }}<small>人</small></div>
        </div>
        <div class="stat-card">
          <div class="label">整月无考勤</div>
          <div class="value">{{ attBoard.summary ? attBoard.summary.no_attendance : 0 }}<small>人</small></div>
        </div>
        <div class="stat-card">
          <div class="label">被削件数</div>
          <div class="value" :style="{ color: attBoard.summary && attBoard.summary.capped_people ? '#d92d45' : '#8a94a6' }">
            {{ attBoard.summary ? attBoard.summary.capped_people : 0 }}<small>人 / {{ attBoard.summary ? attBoard.summary.total_over : 0 }} 件</small>
          </div>
        </div>
        <div class="stat-card">
          <div class="label">考勤冲突</div>
          <div class="value" :style="{ color: attBoard.summary && attBoard.summary.conflict_count ? '#d92d45' : '#8a94a6' }">
            {{ attBoard.summary ? attBoard.summary.conflict_count : 0 }}<small>笔</small>
          </div>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-h">
          <h3 style="margin: 0">考勤 × 计件对照（{{ period }}）</h3>
          <span class="tiny muted">
            月上限 = 日上限 {{ cfg.daily_cap_qty || 0 }} 件 × 出勤天数；日上限为 0 时不封顶
          </span>
        </div>
        <table class="data">
          <thead>
            <tr>
              <th>员工</th><th>部门</th>
              <th class="num">出勤</th><th class="num">迟到</th><th class="num">请假</th><th class="num">旷工</th>
              <th class="num">计件件数</th><th class="num">金额</th>
              <th class="num">月上限</th><th class="num">剩余</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in attBoard.rows || []" :key="r.employee_id">
              <td><b>{{ r.employee_name }}</b><span class="emp-code">{{ r.employee_code }}</span></td>
              <td class="tiny">{{ r.department || '—' }}</td>
              <td class="num">{{ r.attended_days }}</td>
              <td class="num">{{ r.late_days || 0 }}</td>
              <td class="num" :style="{ color: r.leave_days ? '#d97706' : '' }">{{ r.leave_days || 0 }}</td>
              <td class="num" :style="{ color: r.absent_days ? '#d92d45' : '' }">{{ r.absent_days || 0 }}</td>
              <td class="num">{{ r.qty }}</td>
              <td class="num strong">¥{{ money(r.amount) }}</td>
              <td class="num">
                {{ r.month_cap === null ? '不封顶' : r.month_cap }}
                <div v-if="r.cap_note" class="tiny muted">{{ r.cap_note }}</div>
              </td>
              <td class="num">{{ r.remain === null ? '—' : r.remain }}</td>
              <td class="tiny">
                <span v-if="!r.attendance_records" class="tag gray">整月无考勤</span>
                <span v-else-if="r.over > 0" class="tag red">削掉 {{ r.over }} 件</span>
                <span v-else-if="r.flagged" class="tag orange">冲突 {{ r.flagged }} 笔</span>
                <span v-else class="tag green">正常</span>
              </td>
            </tr>
            <tr v-if="!(attBoard.rows || []).length"><td colspan="11" class="empty">本月没有可计件的报工</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="attConflicts.length" class="diag bad">
        <div class="diag-h">
          <b>请假/缺勤当日的报工 {{ attConflicts.length }} 条</b>
          <span>当前策略：{{ attPolicyLabel }}</span>
        </div>
        <table class="data sm">
          <thead><tr><th>姓名</th><th>日期</th><th>考勤</th><th>订单</th><th>工序</th><th class="num">件数</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in attConflicts.slice(0, 20)" :key="i">
              <td>{{ c.employee_name }}</td>
              <td class="tiny">{{ c.report_date }}</td>
              <td><span class="tag red">{{ c.att_label }}</span></td>
              <td class="mono tiny">{{ c.order_no }}</td>
              <td>{{ c.process_name }}</td>
              <td class="num">{{ c.qty }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="attExcluded.length" class="diag warn">
        <div class="diag-h">
          <b>已剔除不计 {{ attExcluded.length }} 条（合计 ¥{{ money(attExcludedAmount) }}）</b>
          <span>策略是「剔除不计」，这些笔不付钱。人请假了活谁干的，得线下问清楚</span>
        </div>
        <table class="data sm">
          <thead><tr><th>姓名</th><th>日期</th><th>考勤</th><th>订单</th><th>工序</th><th class="num">件数</th><th class="num">金额</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in attExcluded.slice(0, 20)" :key="i">
              <td>{{ c.employee_name }}</td>
              <td class="tiny">{{ c.report_date }}</td>
              <td><span class="tag red">{{ c.att_label }}</span></td>
              <td class="mono tiny">{{ c.order_no }}</td>
              <td>{{ c.process_name }}</td>
              <td class="num">{{ c.qty }}</td>
              <td class="num">¥{{ money(c.amount) }}</td>
            </tr>
          </tbody>
        </table>
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
                <button  v-if="canWrite && r.status === 'active'" class="link-btn danger" @click="disableRate(r)">停用</button>
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
              <th class="num">金额</th><th class="num">缺价</th><th class="num">未归属</th><th class="num">考勤冲突</th>
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
              <td class="num" :style="{ color: r.att_conflict_count ? '#d92d45' : '#8a94a6' }">{{ r.att_conflict_count || 0 }}</td>
              <td class="tiny">{{ r.created_by || '' }}<br />{{ $fmt(r.created_at) }}</td>
              <td class="tiny">{{ r.confirmed_by || '—' }}<br />{{ r.confirmed_at ? $fmt(r.confirmed_at) : '' }}</td>
              <td>
                <button class="link-btn" @click="openRun(r.id)">查看</button>
                <button v-action="['piece-wage','export']" v-if="r.status === 'confirmed'" class="link-btn" @click="exportRun(r.id)">导出</button>
                <button v-if="r.status === 'confirmed'" class="link-btn" @click="openPayslip(r.id)">工资条</button>
                <button v-if="r.status === 'confirmed'" class="link-btn" @click="openPayslip(r.id, 'public')">公示表</button>
              </td>
            </tr>
            <tr v-if="!runs.length"><td colspan="12" class="empty">还没有核算单</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
const unitPrice=n=>Number(n).toFixed(6).replace(/\.?0+$/,'');
function wageBasis(raw){try{const s=JSON.parse(raw);return (s.color||'未填颜色')+' · '+s.color_qty+'件 · '+unitPrice(s.base_unit_price)+' × '+s.multiplier;}catch{return '计价快照待核对';}}
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const router = useRouter();

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

// ---------- 考勤联动 ----------
const cfg = ref({ daily_cap_qty: 0, month_cap: 1, attendance_policy: 'warn' });
const attBoard = ref({ rows: [], summary: null });
const cfgForm = reactive({ daily_cap_qty: 0, month_cap: 1, attendance_policy: 'warn' });

/** 请假/缺勤当日报工（铁证冲突） */
const attConflicts = computed(() => diag.value.attendance_conflict || []);
const attExcluded = computed(() => diag.value.excluded || []);
const attExcludedAmount = computed(() => attExcluded.value.reduce((s, x) => s + (Number(x.amount) || 0), 0));
const noAttCount = computed(() => (diag.value.no_attendance || []).length);

/** 日封顶与月封顶合成一张表（都是「削掉多少件」，分开显示反而看不清） */
const capRows = computed(() => {
  const d = diag.value;
  const rows = [
    ...(d.daily_capped || []).map((x) => ({ ...x, cap_kind: 'daily' })),
    ...(d.month_capped || []).map((x) => ({ ...x, cap_kind: 'month' }))
  ];
  return rows.sort(
    (a, b) => String(b.report_date || '').localeCompare(String(a.report_date || '')) || (b.over || 0) - (a.over || 0)
  );
});

/** 当前生效策略：优先看实时试算（配置刚改过就是新值），没有就退回核算单快照 */
const attPolicy = computed(() => {
  if (preview.value && preview.value.summary && preview.value.summary.att_policy) return preview.value.summary.att_policy;
  if (run.value && run.value.diagnostics && run.value.diagnostics.att_policy) return run.value.diagnostics.att_policy;
  return cfg.value.attendance_policy || 'warn';
});
const attPolicyLabel = computed(
  () =>
    ({ warn: '只提示（照算，确认要写说明）', exclude: '剔除不计（不付这笔钱）', block: '不许确认（先清干净）' }[
      attPolicy.value
    ] || attPolicy.value)
);
const attConflictCount = computed(() =>
  run.value ? Number(run.value.att_conflict_count) || 0 : attConflicts.value.length
);

const ATT_LABEL = { normal: '正常', late: '迟到', leave: '请假', absent: '旷工', none: '无记录' };
const attLabel = (s) => ATT_LABEL[s] || ATT_LABEL.none;
function attTagClass(s) {
  if (s === 'leave' || s === 'absent') return 'red';
  if (s === 'late') return 'orange';
  if (s === 'none' || !s) return 'gray';
  return 'green';
}

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

async function loadConfig() {
  const c = await api.pieceConfig();
  cfg.value = c;
  cfgForm.daily_cap_qty = c.daily_cap_qty;
  cfgForm.month_cap = c.month_cap;
  cfgForm.attendance_policy = c.attendance_policy;
}

async function loadBoard() {
  if (!period.value) return;
  attBoard.value = await api.pieceAttBoard(period.value);
}

async function saveConfig() {
  busy.value = true;
  try {
    cfg.value = await api.pieceConfigSave({
      ...cfgForm,
      daily_cap_qty: Number(cfgForm.daily_cap_qty) || 0
    });
    await Promise.all([loadPreview(), loadBoard()]);
    tab.value = 'att';
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function reload() {
  try {
    await Promise.all([loadPreview(), loadRuns(), loadRates(), loadConfig(), loadBoard()]);
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
  const conf = Number(run.value.att_conflict_count) || 0;
  // 无法归属（临时工）与「请假/缺勤日报工」都不阻塞确认，但必须留一句处理说明
  if ((un > 0 || conf > 0) && String(note).trim().length < 4) {
    const parts = [];
    if (un > 0) parts.push(`${un} 条报工无法归属到人（临时工/姓名对不上档案）`);
    if (conf > 0) parts.push(`${conf} 条报工落在请假/缺勤日（钱可能付错人）`);
    const t = prompt(
      `${parts.join('；')}。\n确认可以继续，但请写一句怎么处理（至少 4 个字）：`,
      un > 0 ? '临时工另行结算' : '请假当天为代报，已线下确认'
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

/** 出工资条 / 车间公示表：只对已确认的核算单开放（草案数字会变） */
function openPayslip(id, mode) {
  router.push({ path: '/payslip/' + id, query: mode ? { mode } : {} });
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
  background: var(--surface);
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
  color: var(--ink);
}
.diag-h span {
  font-size: 12px;
  color: var(--ink-mute);
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
  color: var(--ink);
}
.over {
  color: #d92d45;
  font-weight: 800;
}
.cap {
  display: inline-block;
  margin-left: 4px;
  font-size: 12px;
  font-style: normal;
  color: #d92d45;
  border: 1px solid #f3c3cb;
  border-radius: 4px;
  padding: 0 3px;
}
.empty {
  text-align: center;
  color: var(--ink-mute);
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
  background: var(--brand);
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
  font-size: 12px;
  color: #a0aabb;
}
.row-off td {
  opacity: 0.55;
}
/* 页签上的红点：有考勤冲突却在别的页签时也要看得见 */
.dot-bad {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 5px;
  border-radius: 50%;
  background: #d92d45;
  vertical-align: middle;
}
@media (max-width: 900px) {
  .cards.four {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
