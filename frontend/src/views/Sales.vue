<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>销售与客户</h2>
        <p class="sub">
          线索<b>不是收入</b>（商机金额只用于排优先级）；客户复购周期只由<b>有效采购订单</b>刷新，内部转单 / 样衣 / 免费补发都不算，回访也不刷新。
          提成按<b>已批准回款</b>计提，来源行全公司防重；提成单批准后只生成<b>一笔薪酬来源</b>，不自动扣薪。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">今天 {{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>线索在跟</span><strong>{{ ov.leads ? ov.leads.total - ov.leads.by_stage.won - ov.leads.by_stage.lost : 0 }}</strong><small>不含已成交 / 已丢单</small></div>
      <div class="stat" :class="ov.leads && ov.leads.late_response ? 'st-bad' : ''"><span>响应超时</span><strong>{{ ov.leads ? ov.leads.late_response : 0 }}</strong><small>一次都没回过</small></div>
      <div class="stat"><span>公海线索</span><strong>{{ ov.leads ? ov.leads.pool : 0 }}</strong><small>可认领</small></div>
      <div class="stat" :class="ov.cycles && ov.cycles.escalated ? 'st-bad' : ''"><span>周期超期</span><strong>{{ ov.cycles ? ov.cycles.overdue : 0 }}</strong><small>其中需升级 {{ ov.cycles ? ov.cycles.escalated : 0 }}</small></div>
      <div class="stat" :class="ov.handovers && ov.handovers.open ? 'st-warn' : ''"><span>待接收交接</span><strong>{{ ov.handovers ? ov.handovers.open : 0 }}</strong><small>客户未转移</small></div>
      <div class="stat" :class="ov.commissions && ov.commissions.pending ? 'st-warn' : ''"><span>提成待复核</span><strong>{{ ov.commissions ? ov.commissions.pending : 0 }}</strong><small>{{ money(ov.commissions && ov.commissions.approved_amount_this_period) }} 本期已批</small></div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'leads' }" @click="go('leads')">线索与商机<span v-if="ov.leads && ov.leads.late_response" class="tab-dot">{{ ov.leads.late_response }}</span></button>
        <button :class="{ on: tab === 'cycle' }" @click="go('cycle')">周期预警<span v-if="ov.cycles && ov.cycles.overdue" class="tab-dot">{{ ov.cycles.overdue }}</span></button>
        <button :class="{ on: tab === 'value' }" @click="go('value')">客户价值</button>
        <button :class="{ on: tab === 'commission' }" @click="go('commission')">目标与提成</button>
        <button :class="{ on: tab === 'handover' }" @click="go('handover')">客户交接</button>
      </div>
    </div>

    <!-- ==================== 一、线索与商机 ==================== -->
    <div v-if="tab === 'leads'" class="block">
      <div class="hint-bar">
        线索 → 需求确认 → 样衣 → <b>转真实订单</b>或丢单，每一步都要留证据。<b>预计商机金额不是收入</b>，不进目标也不进提成；
        跟进必须写下次动作日期和证据，否则线索会变成「聊过一次就没下文」。重复线索只<b>建议合并</b>，客户档案不自动合并。
      </div>

      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="lf.stage" @change="loadLeads">
          <option value="">全部阶段</option>
          <option v-for="s in dict.lead_stage" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <select v-model="lf.owner_user_id" @change="loadLeads">
          <option value="">全部主责</option>
          <option v-for="u in dict.users" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
        <label class="chk"><input v-model="lf.pool" type="checkbox" true-value="1" false-value="" @change="loadLeads" /> 只看公海</label>
        <input v-model="lf.q" class="kw" placeholder="客户 / 线索号" @keyup.enter="loadLeads" />
        <button class="btn btn-ghost btn-sm" @click="loadLeads">查询</button>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doSweep">回收超时线索</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openLeadNew">＋ 新建线索</button>
      </div>

      <div class="funnel">
        <div v-for="s in dict.lead_stage" :key="s.k" class="fn-item" :class="'fn-' + s.k">
          <span>{{ s.v }}</span>
          <b>{{ (ov.leads && ov.leads.by_stage[s.k]) || 0 }}</b>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>线索</th><th>客户 / 需求</th><th>来源</th><th>阶段</th><th class="num">预计金额</th><th>主责</th><th>下次动作</th><th>响应</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="l in leads" :key="l.id" :class="{ 'row-bad': l.is_response_late }">
              <td class="nowrap"><a class="lnk" @click="openLead(l.id)">{{ l.lead_no }}</a>
                <div class="tiny muted">{{ (l.created_at || '').slice(0, 10) }}</div></td>
              <td><b>{{ l.customer_name_raw }}</b>
                <div class="tiny muted">{{ [l.contact, l.country].filter(Boolean).join(' · ') || '—' }}<span v-if="l.dup_cnt"> · 有 {{ l.dup_cnt }} 条疑似重复</span></div></td>
              <td class="tiny nowrap">{{ l.source_label }}</td>
              <td><span class="tag" :class="stageTag(l.stage)">{{ l.stage_label }}</span>
                <div v-if="l.lost_reason_label" class="tiny muted">{{ l.lost_reason_label }}</div></td>
              <td class="num nowrap">{{ l.est_amount ? money(l.est_amount, l.est_currency) : '—' }}
                <div class="tiny muted">非收入</div></td>
              <td class="nowrap">{{ l.owner_name || '公海' }}</td>
              <td class="tiny nowrap" :class="{ red: l.is_next_late }">{{ l.next_action_date || '—' }}
                <div class="muted">{{ l.next_action || '未填写' }}</div></td>
              <td><span class="tag" :class="l.is_response_late ? 'red' : (l.first_response_at ? 'green' : 'gray')">
                {{ l.is_response_late ? '超时' : (l.first_response_at ? '已响应' : '待响应') }}</span></td>
              <td class="nowrap">
                <button class="link-btn" @click="openLead(l.id)">详情</button>
                <button v-if="canWrite && l.in_pool" class="link-btn" @click="claim(l)">认领</button>
              </td>
            </tr>
            <tr v-if="!leads.length"><td colspan="9" class="empty-cell">还没有线索</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 二、周期预警 ==================== -->
    <div v-if="tab === 'cycle'" class="block">
      <div class="hint-bar">
        应购日 = 最近<b>有效采购</b>日 + 批准周期。<b>宽限期只管要不要升级，不改「已超期」这个事实</b>；
        周期未知不是空白，必须写原因、责任人、复核日——<b>不能编 0 天</b>（填 0 会让客户天天超期，预警立刻失效）。
        回访只留痕，<b>不刷新采购日</b>。
      </div>

      <div class="alert-grid">
        <div class="al al-red"><span>已超期</span><b>{{ alerts.counts.overdue }}</b><small>需联系挽回</small></div>
        <div class="al al-orange"><span>超期且超宽限</span><b>{{ alerts.counts.escalated }}</b><small>应升级到主管</small></div>
        <div class="al"><span>7 天内到期</span><b>{{ alerts.counts.soon }}</b><small>提前打招呼</small></div>
        <div class="al"><span>周期未知</span><b>{{ ov.cycles ? ov.cycles.unknown : 0 }}</b><small>要有复核日</small></div>
      </div>

      <div class="toolbar" style="margin: 12px 0">
        <select v-model="cf.scope" @change="loadCycles">
          <option value="active">有周期 / 有采购的客户</option>
          <option value="all">全部客户（含从无往来）</option>
        </select>
        <select v-model="cf.status" @change="loadCycles">
          <option value="">全部周期状态</option>
          <option v-for="s in dict.cycle_status" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <label class="chk"><input v-model="cf.overdue" type="checkbox" true-value="1" false-value="" @change="loadCycles" /> 只看超期</label>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doRefreshCycle">按有效订单刷新采购日</button>
        <button class="btn btn-ghost btn-sm" @click="loadInfer">推断周期（只建议）</button>
      </div>

      <div v-if="inferList.length" class="panel-card infer">
        <h3>系统推断的周期<small>按历史间隔取中位数，仅作建议；采纳会写进周期变更留痕</small></h3>
        <div v-for="x in inferList" :key="x.customer_id" class="inf-row">
          <b>{{ x.customer_name }}</b>
          <span class="tiny muted">{{ x.sample_cnt }} 次采购 · 间隔 {{ x.gaps.join(' / ') }} 天 → 建议 <b>{{ x.suggested_days }}</b> 天</span>
          <div class="spacer"></div>
          <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="acceptInfer(x)">采纳</button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>客户</th><th>归属</th><th>周期状态</th><th class="num">周期</th><th>最近有效采购</th><th>应购日</th><th>超期</th><th>宽限</th><th class="num">3/6/12 月</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in cycles" :key="r.customer_id" :class="{ 'row-bad': r.escalated, 'row-warn': r.is_overdue && !r.escalated }">
              <td><b>{{ r.customer_name }}</b><div class="tiny muted">{{ r.customer_code }}</div></td>
              <td class="tiny nowrap">{{ r.owner_name || '未归属' }}</td>
              <td><span class="tag" :class="cycleTag(r.status)">{{ r.status_label }}</span>
                <div v-if="r.reason" class="tiny muted rsn" :title="r.reason">{{ r.reason }}</div></td>
              <td class="num nowrap">{{ r.cycle_days ? r.cycle_days + ' 天' : '—' }}</td>
              <td class="tiny nowrap">{{ r.last_purchase_date || '—' }}</td>
              <td class="tiny nowrap">{{ r.next_due_date || '—' }}</td>
              <td class="nowrap">
                <span v-if="r.is_overdue" class="tag" :class="r.escalated ? 'red' : 'orange'">{{ r.overdue_days }} 天</span>
                <span v-else-if="r.due_in_days !== null" class="tiny muted">{{ r.due_in_days >= 0 ? r.due_in_days + ' 天后' : '—' }}</span>
                <span v-else class="tiny muted">—</span>
                <div v-if="r.is_overdue && !r.escalated" class="tiny muted">宽限内</div>
              </td>
              <td class="tiny">{{ r.grace_days || 0 }} 天</td>
              <td class="num tiny nowrap">{{ r.win3 }} / {{ r.win6 }} / {{ r.win12 }}</td>
              <td class="nowrap">
                <button v-if="canWrite" class="link-btn" @click="openCycle(r)">维护</button>
                <button v-if="canWrite" class="link-btn" @click="openFollowup(r)">回访</button>
              </td>
            </tr>
            <tr v-if="!cycles.length"><td colspan="10" class="empty-cell">没有符合条件的客户</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、客户价值 ==================== -->
    <div v-if="tab === 'value'" class="block">
      <div class="hint-bar">
        订单额 / 确认收入 / 回款 / 毛利<b>各有时间与币种口径</b>，不要拿订单额当回款。
        <b>销售业绩 ≠ 财务收入</b>；集团内部转单单独标注、不计业绩。
        <b>缺成本的客户不进毛利榜</b>——不是「毛利 0」，是「算不出来」。
      </div>

      <div class="toolbar" style="margin-bottom: 12px">
        <input v-model="rf.from" type="date" />
        <span class="muted tiny">至</span>
        <input v-model="rf.to" type="date" />
        <select v-model="rf.metric" @change="loadRanking">
          <option value="amount">按订单净额</option>
          <option value="revenue">按确认收入</option>
          <option value="collection">按回款</option>
          <option value="gross">按毛利</option>
        </select>
        <label class="chk"><input v-model="rf.exclude_internal" type="checkbox" true-value="1" false-value="" @change="loadRanking" /> 剔除集团内部</label>
        <button class="btn btn-ghost btn-sm" @click="loadRanking">刷新</button>
        <div class="spacer"></div>
        <span class="muted tiny">合计 {{ money(ranking.total) }} · 毛利待核 {{ ranking.pending_cnt }} 家</span>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th style="width: 60px">排名</th><th>客户</th><th>归属</th><th class="num">订单净额</th><th class="num">采购事件</th>
              <th class="num">确认收入</th><th class="num">回款</th><th class="num">毛利</th><th class="num">覆盖率</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in ranking.rows" :key="r.customer_id" :class="{ 'row-off': !r.rank }">
              <td><b v-if="r.rank">{{ r.rank }}</b><span v-else class="tag orange">待核</span></td>
              <td><b>{{ r.customer_name }}</b><div class="tiny muted">{{ r.customer_code }}</div></td>
              <td class="tiny nowrap">{{ r.owner_name }}</td>
              <td class="num nowrap">{{ money(r.orders_net) }}</td>
              <td class="num">{{ r.order_cnt }}</td>
              <td class="num nowrap">{{ money(r.revenue) }}</td>
              <td class="num nowrap">{{ money(r.collection) }}</td>
              <td class="num nowrap">{{ r.gross_ready ? money(r.gross) : '—' }}</td>
              <td class="num nowrap">{{ r.coverage === null ? '—' : r.coverage + '%' }}</td>
              <td class="tiny" :class="{ red: r.is_internal }">{{ r.note }}</td>
            </tr>
            <tr v-if="!ranking.rows.length"><td colspan="10" class="empty-cell">这段时间没有可排名的客户</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tiny muted" style="margin-top: 8px">{{ ranking.note }}</p>
    </div>

    <!-- ==================== 四、目标与提成 ==================== -->
    <div v-if="tab === 'commission'" class="block">
      <div class="hint-bar">
        目标完成率必须能看到<b>分子和分母</b>，且按各自口径取数。提成<b>不预设百分比</b>——基数、阶梯、归属都由公司批准，规则改版是「新增 + 旧的标已替代」。
        同一条回款 / 发票 / 毛利行<b>全公司只能计提一次</b>（库里有唯一索引兜底）；退款与坏账调整必须指向来源单据，且<b>不自动扣薪</b>。
      </div>

      <h4 class="sec">销售目标<small>批准后生效；同一期间同一团队只留一个生效版本</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <input v-model="tf.period" type="month" @change="loadTargets" />
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openTargetNew">＋ 新建目标版</button>
      </div>
      <div v-for="t in targets" :key="t.id" class="tgt">
        <div class="tgt-head">
          <b>{{ t.period }} · {{ t.team || '全部团队' }}</b>
          <span class="tag" :class="t.status === 'approved' ? 'green' : (t.status === 'draft' ? 'gray' : 'blue')">{{ t.status_label }}</span>
          <span class="tiny muted">V{{ t.version }} · {{ t.item_cnt }} 项 · 目标合计 {{ money(t.total_target) }}</span>
          <div class="spacer"></div>
          <button v-if="canApprove && t.status === 'draft'" class="btn btn-primary btn-sm" @click="approveTarget(t)">批准</button>
          <button class="link-btn" @click="openTarget(t.id)">看达成</button>
        </div>
      </div>
      <div v-if="!targets.length" class="empty-box">这个期间还没有目标版</div>

      <h4 class="sec">提成规则<small>阶梯是超额累进（不是全额跳档）</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openRuleNew">＋ 新建规则</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>规则</th><th>基数口径</th><th>阶梯</th><th>退款扣减</th><th>生效起</th><th>状态</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in rules" :key="r.id">
              <td><b>{{ r.name }}</b><div class="tiny muted">{{ r.rule_no }}</div></td>
              <td class="tiny nowrap">{{ r.base_type_label }}</td>
              <td class="tiny">{{ r.tiers.map((t) => (t.from / 10000) + '万' + (t.to === null ? '以上' : '–' + (t.to / 10000) + '万') + '：' + t.rate + '%').join('　') }}</td>
              <td class="tiny">{{ r.deduct_refund ? '扣减（须有来源）' : '不扣减' }}</td>
              <td class="tiny nowrap">{{ r.effective_from }}</td>
              <td><span class="tag" :class="r.status === 'approved' ? 'green' : (r.status === 'draft' ? 'gray' : 'orange')">{{ r.status_label }}</span></td>
              <td><button v-if="canApprove && r.status === 'draft'" class="link-btn" @click="approveRule(r)">批准</button></td>
            </tr>
            <tr v-if="!rules.length"><td colspan="7" class="empty-cell">还没有提成规则（系统不预设百分比）</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec">提成单<small>先试算 → 生成草稿 → 财务复核 → 引薪酬</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <input v-model="cmf.period" type="month" @change="loadCommissions" />
        <select v-model="cmf.status" @change="loadCommissions">
          <option value="">全部状态</option>
          <option value="draft">草稿</option><option value="reviewing">待复核</option>
          <option value="approved">已批准</option><option value="settled">已引薪酬</option><option value="rejected">已驳回</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openCommNew">＋ 试算 / 新建提成</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>提成单</th><th>业务员</th><th>期间</th><th>基数口径</th><th class="num">基数</th><th class="num">提成</th>
            <th class="num">调整</th><th class="num">净额</th><th>状态</th><th>薪酬来源</th><th></th></tr></thead>
          <tbody>
            <tr v-for="c in commissions" :key="c.id">
              <td class="nowrap"><a class="lnk" @click="openComm(c.id)">{{ c.commission_no }}</a></td>
              <td class="nowrap">{{ c.user_name }}<div class="tiny muted">{{ c.dept_snapshot || '—' }}</div></td>
              <td class="tiny nowrap">{{ c.period }}</td>
              <td class="tiny nowrap">{{ c.base_type_label }}</td>
              <td class="num nowrap">{{ money(c.base_amount) }}</td>
              <td class="num nowrap">{{ money(c.amount) }}</td>
              <td class="num nowrap" :class="{ red: c.refund_adj || c.bad_debt_adj }">{{ money((c.refund_adj || 0) + (c.bad_debt_adj || 0)) }}</td>
              <td class="num nowrap"><b>{{ money(c.net_amount) }}</b></td>
              <td><span class="tag" :class="c.status === 'approved' || c.status === 'settled' ? 'green' : (c.status === 'reviewing' ? 'orange' : 'gray')">{{ c.status_label }}</span></td>
              <td class="tiny nowrap">{{ c.payroll_ref || '—' }}</td>
              <td class="nowrap">
                <button class="link-btn" @click="openComm(c.id)">明细</button>
                <button v-if="canApprove && c.status === 'reviewing'" class="link-btn" @click="commAct(c, 'approved')">通过</button>
                <button v-if="canWrite && c.status === 'draft'" class="link-btn" @click="commAct(c, 'reviewing')">提交</button>
              </td>
            </tr>
            <tr v-if="!commissions.length"><td colspan="11" class="empty-cell">还没有提成单</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 五、客户交接 ==================== -->
    <div v-if="tab === 'handover'" class="block">
      <div class="hint-bar">
        交接只转移<b>客户归属与未结任务</b>，<b>不改历史业绩</b>——已批提成单里的部门与主管快照保持原样。
        接收人必须是<b>有销售权限的在职账号</b>，只能由接收人本人确认接收；未结订单数在<b>提交时快照</b>，之后订单变化不影响当时口径。
      </div>
      <div class="toolbar" style="margin-bottom: 12px">
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary" @click="openHandoverNew">＋ 新建交接</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>交接单</th><th>原主责 → 接收人</th><th>原因</th><th>客户</th><th class="num">未结订单</th><th class="num">未结任务</th><th>状态</th><th></th></tr></thead>
          <tbody>
            <tr v-for="h in handovers" :key="h.id">
              <td class="nowrap"><a class="lnk" @click="openHandover(h.id)">{{ h.handover_no }}</a></td>
              <td class="nowrap">{{ h.from_name }} → <b>{{ h.to_name }}</b></td>
              <td class="tiny">{{ h.reason_label }}</td>
              <td class="tiny">{{ h.customers.map((c) => c.name).join('、') }}</td>
              <td class="num">{{ h.open_order_cnt }}</td>
              <td class="num">{{ h.open_task_cnt }}</td>
              <td><span class="tag" :class="h.status === 'done' ? 'green' : (h.status === 'pending' ? 'orange' : 'gray')">{{ h.status_label }}</span></td>
              <td class="nowrap">
                <button class="link-btn" @click="openHandover(h.id)">详情</button>
                <button v-if="canWrite && h.status === 'draft'" class="link-btn" @click="handoverAct(h, 'pending')">提交</button>
                <button v-if="canWrite && h.status === 'pending'" class="link-btn" @click="handoverAct(h, 'received')">确认接收</button>
                <button v-if="canApprove && h.status === 'received'" class="link-btn" @click="handoverAct(h, 'done')">完成转移</button>
              </td>
            </tr>
            <tr v-if="!handovers.length"><td colspan="8" class="empty-cell">没有交接单</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 弹窗：新建线索 ==================== -->
    <div v-if="modal === 'leadNew'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>新建线索</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>来源
              <select v-model="leadForm.source">
                <option v-for="s in dict.lead_source" :key="s.k" :value="s.k">{{ s.v }}</option>
              </select>
            </label>
            <label>平台线索 ID<input v-model="leadForm.source_ref" placeholder="同一条线索只进一次（查重键）" /></label>
            <label>客户名称<input v-model="leadForm.customer_name_raw" placeholder="新客户也要写可识别的名字" /></label>
            <label>匹配老客户
              <select v-model="leadForm.customer_id">
                <option :value="null">新客户</option>
                <option v-for="c in dict.customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label>联系人<input v-model="leadForm.contact" /></label>
            <label>国家<input v-model="leadForm.country" /></label>
            <label>预计商机金额<input v-model="leadForm.est_amount" type="number" placeholder="仅参考，不是收入" /></label>
            <label>主责
              <select v-model="leadForm.owner_user_id">
                <option :value="null">不指派（进公海）</option>
                <option v-for="u in dict.users" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
            </label>
          </div>
          <p class="tiny muted" style="margin-top: 8px">预计商机金额只用于排优先级，<b>不进收入、不进目标、不进提成</b>。不指派主责的线索进公海，可由销售认领。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveLead">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：线索详情 ==================== -->
    <div v-if="modal === 'lead' && lead" class="modal-mask" @click.self="modal = ''">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ lead.customer_name_raw }} <span class="mono tiny">{{ lead.lead_no }}</span></h3>
          <button class="x" @click="modal = ''">×</button>
        </div>
        <div class="modal-body">
          <div class="ld-meta">
            <span class="tag" :class="stageTag(lead.stage)">{{ lead.stage_label }}</span>
            <span class="tag gray">{{ lead.source_label }}</span>
            <span v-if="lead.is_response_late" class="tag red">响应超时</span>
            <span v-if="lead.is_next_late" class="tag orange">跟进逾期</span>
            <span class="tiny muted">主责 {{ lead.owner_name || '公海' }} · 响应期限 {{ lead.response_due || '—' }}
              <template v-if="lead.first_response_at"> · 首次响应 {{ lead.first_response_at }}</template></span>
          </div>

          <div class="kv">
            <div><span>预计商机金额</span><b>{{ lead.est_amount ? money(lead.est_amount, lead.est_currency) : '—' }}</b><small>仅参考，不是收入</small></div>
            <div><span>下次动作</span><b>{{ lead.next_action_date || '—' }}</b><small>{{ lead.next_action || '未填写' }}</small></div>
            <div><span>关联订单</span><b>{{ lead.order ? lead.order.order_no : '—' }}</b><small>{{ lead.order ? '订单已同源关联' : '未转订单' }}</small></div>
            <div><span>丢单原因</span><b>{{ lead.lost_reason_label || '—' }}</b><small>{{ lead.lost_note || '' }}</small></div>
          </div>

          <div v-if="lead.dups && lead.dups.length" class="dup-box">
            <b>疑似重复线索</b>（只建议合并，客户档案不自动合并）
            <div v-for="d in lead.dups" :key="d.id" class="dup-row">
              <span class="mono tiny">{{ d.lead_no }}</span>
              <span class="tiny">{{ d.owner_name || '公海' }}</span>
              <span class="tiny muted">{{ d.created_at }}</span>
              <div class="spacer"></div>
              <button v-if="canWrite && lead.stage !== 'lost'" class="link-btn" @click="mergeInto(d)">合并到这条</button>
            </div>
          </div>

          <div class="act-row">
            <span class="tiny muted">推进阶段：</span>
            <button v-for="s in lead.next_stages" :key="s" class="btn btn-ghost btn-sm" :disabled="!canWrite" @click="openStage(s)">
              → {{ stageLabel(s) }}
            </button>
            <div class="spacer"></div>
            <button v-if="canWrite && lead.in_pool" class="btn btn-ghost btn-sm" @click="claim(lead)">认领</button>
            <button v-if="canWrite && !lead.in_pool && ['new','qualifying'].includes(lead.stage)" class="btn btn-ghost btn-sm" @click="recycle(lead)">回收公海</button>
          </div>

          <div v-if="canWrite && !['won','lost'].includes(lead.stage)" class="fu-box">
            <h4>登记跟进<small>必须写证据和下次动作日期，否则等于没跟</small></h4>
            <textarea v-model="followForm.note" rows="2" placeholder="这次谈了什么"></textarea>
            <div class="fgrid">
              <label>证据<input v-model="followForm.evidence" placeholder="聊天记录 / 邮件编号 / 会议纪要" /></label>
              <label>下次动作<input v-model="followForm.next_action" /></label>
              <label>下次日期<input v-model="followForm.next_action_date" type="date" /></label>
            </div>
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveFollow">登记</button>
          </div>

          <h4 style="margin-top: 16px">流转记录</h4>
          <div class="tl">
            <div v-for="g in lead.logs" :key="g.id" class="tl-row">
              <span class="tiny muted mono">{{ g.created_at }}</span>
              <span class="tag gray">{{ logAction(g.action) }}</span>
              <span class="tiny">{{ g.note }}</span>
              <span v-if="g.evidence" class="tiny muted">（{{ g.evidence }}）</span>
            </div>
            <div v-if="!lead.logs.length" class="empty-box">还没有记录</div>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：阶段推进（丢单原因 / 转订单） ==================== -->
    <div v-if="modal === 'stage'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>推进到「{{ stageLabel(stageForm.to) }}」</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div v-if="stageForm.to === 'lost'" class="fgrid">
            <label>丢单原因
              <select v-model="stageForm.lost_reason">
                <option v-for="s in dict.lost_reason" :key="s.k" :value="s.k">{{ s.v }}</option>
              </select>
            </label>
            <label>说明<input v-model="stageForm.lost_note" placeholder="其他原因必填" /></label>
          </div>
          <div v-if="stageForm.to === 'won'" class="fgrid">
            <label>转成哪张订单
              <select v-model="stageForm.order_id">
                <option :value="null">选择订单</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.customer_name || ('客户#' + o.customer_id) }} · {{ money(o.total_amount) }}</option>
              </select>
            </label>
            <p class="tiny muted">线索不能凭空变成订单：必须挂到<b>已确认</b>的订单上，且订单客户要与线索客户一致。</p>
          </div>
          <label class="full">备注<input v-model="stageForm.note" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveStage">确定</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：维护周期 ==================== -->
    <div v-if="modal === 'cycle'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>维护采购周期 · {{ cycleForm.customer_name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>周期状态
              <select v-model="cycleForm.status">
                <option v-for="s in dict.cycle_status" :key="s.k" :value="s.k">{{ s.v }}</option>
              </select>
            </label>
            <label>周期天数<input v-model="cycleForm.cycle_days" type="number" :disabled="cycleForm.status !== 'known' && cycleForm.status !== 'seasonal'" /></label>
            <label>宽限天数<input v-model="cycleForm.grace_days" type="number" placeholder="只管是否升级" /></label>
            <label>责任人
              <select v-model="cycleForm.owner_user_id">
                <option v-for="u in dict.users" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
            </label>
            <label>复核日<input v-model="cycleForm.review_date" type="date" /></label>
          </div>
          <label class="full">原因 / 依据
            <input v-model="cycleForm.reason" placeholder="周期未知必须写原因（不知道多久买一次是常态）" />
          </label>
          <p class="tiny muted" style="margin-top: 8px">
            <b>周期未知不填 0 天</b>：填 0 会让「应购日 = 采购日」，客户天天超期。未知要留原因、责任人和复核日。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveCycle">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：回访 ==================== -->
    <div v-if="modal === 'followup'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>登记回访 · {{ followupForm.customer_name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <label class="full">这次联系的结果<input v-model="followupForm.contact_note" placeholder="客户说了什么" /></label>
          <div class="fgrid">
            <label>结果
              <select v-model="followupForm.result">
                <option v-for="s in dict.follow_result" :key="s.k" :value="s.k">{{ s.v }}</option>
              </select>
            </label>
            <label>下次联系<input v-model="followupForm.next_date" type="date" /></label>
            <label>证据<input v-model="followupForm.evidence" /></label>
          </div>
          <p class="tiny muted" style="margin-top: 8px">回访只留痕，<b>不会刷新采购日</b>；只有真实有效订单才刷新复购周期。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveFollowup">登记</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：目标达成 ==================== -->
    <div v-if="modal === 'target' && targetDetail" class="modal-mask" @click.self="modal = ''">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ targetDetail.period }} 目标达成</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>业务员</th><th>指标</th><th class="num">目标</th><th class="num">实际</th><th class="num">差异</th><th>达成率</th><th>口径</th></tr></thead>
              <tbody>
                <tr v-for="i in targetDetail.items" :key="i.id">
                  <td class="nowrap">{{ i.user_name }}</td>
                  <td class="tiny nowrap">{{ i.metric_label }}</td>
                  <td class="num">{{ money(i.target_amount) }}</td>
                  <td class="num">{{ money(i.actual) }}</td>
                  <td class="num" :class="{ red: i.gap < 0, green: i.gap > 0 }">{{ money(i.gap) }}</td>
                  <td><span class="tag" :class="i.hit_rate >= 100 ? 'green' : (i.hit_rate >= 60 ? 'orange' : 'red')">{{ i.hit_rate === null ? '—' : i.hit_rate + '%' }}</span></td>
                  <td class="tiny muted nowrap">{{ i.formula }}</td>
                </tr>
                <tr v-if="!targetDetail.items.length"><td colspan="7" class="empty-cell">没有明细</td></tr>
              </tbody>
            </table>
          </div>
          <p class="tiny muted" style="margin-top: 8px">实际按<b>客户归属人</b>归集，集团内部转单不计；订单额 / 收入 / 回款 / 毛利各自取自己的表，不互相替代。</p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：新建目标 ==================== -->
    <div v-if="modal === 'targetNew'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>新建目标版</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>期间<input v-model="targetForm.period" type="month" /></label>
            <label>团队<input v-model="targetForm.team" /></label>
          </div>
          <div v-for="(it, i) in targetForm.items" :key="i" class="trow">
            <select v-model="it.user_name">
              <option v-for="u in dict.users.filter((x) => x.role === 'sales')" :key="u.id" :value="u.name">{{ u.name }}</option>
            </select>
            <select v-model="it.metric">
              <option v-for="m in dict.metric" :key="m.k" :value="m.k">{{ m.v }}</option>
            </select>
            <input v-model="it.target_amount" type="number" placeholder="目标金额" />
            <button class="link-btn danger" @click="targetForm.items.splice(i, 1)">删</button>
          </div>
          <button class="btn btn-ghost btn-sm" @click="targetForm.items.push({ user_name: (dict.users[0] || {}).name, metric: 'amount', target_amount: 0 })">＋ 加一行</button>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveTarget">保存草稿</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：新建规则 ==================== -->
    <div v-if="modal === 'rule'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>新建提成规则</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>规则名<input v-model="ruleForm.name" /></label>
            <label>基数口径
              <select v-model="ruleForm.base_type">
                <option v-for="b in dict.base_type" :key="b.k" :value="b.k">{{ b.v }}</option>
              </select>
            </label>
            <label>生效起始<input v-model="ruleForm.effective_from" type="date" /></label>
            <label class="chk"><input v-model="ruleForm.deduct_refund" type="checkbox" /> 退款扣减（须有来源）</label>
          </div>
          <h4>阶梯<small>超额累进；终点留空表示「以上」</small></h4>
          <div v-for="(t, i) in ruleForm.tiers" :key="i" class="trow">
            <input v-model="t.from" type="number" placeholder="起" />
            <input v-model="t.to" type="number" placeholder="止（空=以上）" />
            <input v-model="t.rate" type="number" step="0.1" placeholder="费率 %" />
            <button class="link-btn danger" @click="ruleForm.tiers.splice(i, 1)">删</button>
          </div>
          <button class="btn btn-ghost btn-sm" @click="ruleForm.tiers.push({ from: 0, to: null, rate: 1 })">＋ 加一档</button>
          <p class="tiny muted" style="margin-top: 8px">系统<b>不预设百分比</b>：基数、阶梯、归属都要公司批准；批准后旧的同口径规则自动标为「已被替代」。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveRule">保存草稿</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：试算 / 新建提成 ==================== -->
    <div v-if="modal === 'commNew'" class="modal-mask" @click.self="modal = ''">
      <div class="modal wide">
        <div class="modal-head"><h3>试算提成</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>期间<input v-model="commForm.period" type="month" /></label>
            <label>业务员
              <select v-model="commForm.user_name">
                <option v-for="u in dict.users.filter((x) => x.role === 'sales')" :key="u.id" :value="u.name">{{ u.name }}</option>
              </select>
            </label>
            <label>规则
              <select v-model="commForm.rule_id">
                <option :value="null">按基数口径自动选已批准规则</option>
                <option v-for="r in rules.filter((x) => x.status === 'approved')" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </label>
            <label class="chk"><input type="checkbox" @click="doPreview" /> 先试算（不落库）</label>
          </div>

          <div v-if="preview" class="pv">
            <div class="pv-head">
              <b>{{ preview.user_name }} · {{ preview.period }} · {{ preview.base_type_label }}</b>
              <div class="spacer"></div>
              <span class="tiny muted">{{ preview.rule_name }}</span>
              <button class="btn btn-primary btn-sm" :disabled="saving || !preview.sources.length" @click="saveComm">生成草稿</button>
            </div>
            <div class="pv-grid">
              <div><span>提成基数</span><b>{{ money(preview.base_amount) }}</b></div>
              <div><span>提成金额</span><b class="blue">{{ money(preview.amount) }}</b></div>
              <div><span>来源行</span><b>{{ preview.sources.length }}</b><small>已被计过 {{ preview.already_taken.length }} 条</small></div>
            </div>
            <div class="pv-tier">
              <span v-for="(d, i) in preview.detail" :key="i" class="tiny">
                {{ (d.from / 10000) }}万{{ d.to === null ? '以上' : '-' + (d.to / 10000) + '万' }} × {{ d.rate }}% = {{ money(d.amount) }}
              </span>
            </div>
            <div class="table-wrap" style="box-shadow: none; margin-top: 8px">
              <table class="data">
                <thead><tr><th>来源单据</th><th>类型</th><th>日期</th><th class="num">金额</th></tr></thead>
                <tbody>
                  <tr v-for="(s, i) in preview.sources" :key="i">
                    <td class="tiny mono">{{ s.source_no }}</td>
                    <td class="tiny nowrap">{{ srcTypeLabel(s.source_type) }}</td>
                    <td class="tiny nowrap">{{ s.source_date }}</td>
                    <td class="num">{{ money(s.amount) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="preview.already_taken_note" class="tiny" style="color: #d92d45">{{ preview.already_taken_note }}</p>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：提成单详情 ==================== -->
    <div v-if="modal === 'comm' && commDetail" class="modal-mask" @click.self="modal = ''">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ commDetail.commission_no }} · {{ commDetail.user_name }}</h3>
          <button class="x" @click="modal = ''">×</button>
        </div>
        <div class="modal-body">
          <div class="pv-grid">
            <div><span>期间</span><b>{{ commDetail.period }}</b></div>
            <div><span>基数口径</span><b class="sm">{{ commDetail.base_type_label }}</b></div>
            <div><span>提成基数</span><b>{{ money(commDetail.base_amount) }}</b></div>
            <div><span>提成金额</span><b>{{ money(commDetail.amount) }}</b></div>
            <div><span>调整</span><b :class="{ red: commDetail.refund_adj || commDetail.bad_debt_adj }">{{ money((commDetail.refund_adj || 0) + (commDetail.bad_debt_adj || 0)) }}</b></div>
            <div><span>净额</span><b class="blue">{{ money(commDetail.net_amount) }}</b></div>
          </div>
          <p class="tiny muted">归属快照：{{ commDetail.dept_snapshot || '—' }} · 规则 {{ commDetail.rule_no || '—' }} · 状态 {{ commDetail.status_label }}
            <template v-if="commDetail.payroll_ref"> · 薪酬来源 {{ commDetail.payroll_ref }}</template></p>

          <h4 style="margin-top: 12px">来源行<small>同一条回款 / 发票 / 毛利全公司只能计提一次</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>类型</th><th>来源单据</th><th>日期</th><th class="num">金额</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="s in commDetail.sources" :key="s.id" :class="{ 'row-off': s.kind === 'adjust' }">
                  <td class="tiny nowrap">{{ s.kind === 'adjust' ? (s.source_type === 'refund' ? '退款调整' : '坏账调整') : '计提来源' }}</td>
                  <td class="tiny mono nowrap">{{ s.source_no }}</td>
                  <td class="tiny nowrap">{{ s.source_date }}</td>
                  <td class="num nowrap" :class="{ red: s.amount < 0 }">{{ money(s.amount) }}</td>
                  <td class="tiny muted">{{ s.note || '—' }}</td>
                </tr>
                <tr v-if="!commDetail.sources.length"><td colspan="5" class="empty-cell">没有来源行</td></tr>
              </tbody>
            </table>
          </div>

          <div v-if="canWrite && ['draft','rejected'].includes(commDetail.status)" class="adj-box">
            <h4>加退款 / 坏账调整<small>必须指向已计提的来源单据，且不自动扣薪</small></h4>
            <div class="fgrid">
              <label>类型
                <select v-model="adjustForm.source_type">
                  <option value="refund">退款</option><option value="bad_debt">坏账</option>
                </select>
              </label>
              <label>来源单据号
                <select v-model="adjustForm.source_no">
                  <option v-for="s in commDetail.sources.filter((x) => x.kind === 'base')" :key="s.id" :value="s.source_no">{{ s.source_no }}</option>
                </select>
              </label>
              <label>调整金额<input v-model="adjustForm.amount" type="number" placeholder="正数会自动按扣减记" /></label>
              <label>说明<input v-model="adjustForm.note" /></label>
            </div>
            <button class="btn btn-ghost btn-sm" :disabled="saving" @click="saveAdjust">加调整</button>
          </div>

          <div class="act-row" style="margin-top: 12px">
            <span class="tiny muted">当前可执行：</span>
            <button v-for="n in commDetail.next" :key="n" class="btn btn-ghost btn-sm"
              :disabled="(n === 'reviewing' || n === 'rejected') ? !canWrite : !canApprove"
              @click="commAct(commDetail, n)">{{ commStatusLabel(n) }}</button>
            <button v-if="canApprove && commDetail.status === 'approved'" class="btn btn-primary btn-sm" @click="linkPayroll(commDetail)">引薪酬（只生成一笔）</button>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：新建交接 ==================== -->
    <div v-if="modal === 'handoverNew'" class="modal-mask" @click.self="modal = ''">
      <div class="modal">
        <div class="modal-head"><h3>新建客户交接</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>原主责
              <select v-model="handoverForm.from_user_id">
                <option v-for="u in dict.users" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
            </label>
            <label>接收人
              <select v-model="handoverForm.to_user_id">
                <option v-for="u in dict.users.filter((x) => x.role === 'sales')" :key="u.id" :value="u.id">{{ u.name }}</option>
              </select>
            </label>
            <label>原因
              <select v-model="handoverForm.reason">
                <option v-for="r in dict.handover_reason" :key="r.k" :value="r.k">{{ r.v }}</option>
              </select>
            </label>
          </div>
          <label class="full">交接哪些客户
            <select v-model="handoverForm.customer_ids" multiple size="6">
              <option v-for="c in dict.customers" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="full">说明<input v-model="handoverForm.note" /></label>
          <p class="tiny muted" style="margin-top: 6px">接收人必须有销售权限；未结订单与任务数在提交时<b>快照</b>；完成后只改归属，<b>历史提成快照不变</b>。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveHandover">保存草稿</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：交接详情 ==================== -->
    <div v-if="modal === 'handover' && handoverDetail" class="modal-mask" @click.self="modal = ''">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ handoverDetail.handover_no }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="ld-meta">
            <span class="tag blue">{{ handoverDetail.status_label }}</span>
            <span class="tiny muted">{{ handoverDetail.from_name }} → {{ handoverDetail.to_name }} · {{ handoverDetail.reason_label }}</span>
            <span v-if="handoverDetail.accepted_at" class="tag green">已接收 {{ handoverDetail.accepted_at }}</span>
          </div>
          <h4>客户（{{ handoverDetail.customers.length }}）</h4>
          <div class="chips">
            <span v-for="c in handoverDetail.customers" :key="c.id" class="chip">{{ c.name }}</span>
          </div>
          <h4 style="margin-top: 12px">未结订单（提交时快照 {{ handoverDetail.open_order_cnt }} 张）</h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>订单号</th><th>状态</th><th class="num">金额</th></tr></thead>
              <tbody>
                <tr v-for="o in handoverDetail.open_orders" :key="o.id">
                  <td class="tiny mono">{{ o.order_no }}</td><td class="tiny">{{ orderStatusLabel(o.status) }}</td>
                  <td class="num">{{ money(o.total_amount, o.currency) }}</td>
                </tr>
                <tr v-if="!handoverDetail.open_orders.length"><td colspan="3" class="empty-cell">没有未结订单</td></tr>
              </tbody>
            </table>
          </div>
          <h4 style="margin-top: 12px">未结线索（{{ handoverDetail.open_leads.length }}）</h4>
          <div class="chips">
            <span v-for="l in handoverDetail.open_leads" :key="l.id" class="chip">{{ l.lead_no }} · {{ l.customer_name_raw }}</span>
            <span v-if="!handoverDetail.open_leads.length" class="tiny muted">没有未结线索</span>
          </div>
          <div class="act-row" style="margin-top: 14px">
            <button v-for="n in handoverDetail.next" :key="n" class="btn btn-ghost btn-sm" @click="handoverAct(handoverDetail, n)">
              {{ { pending: '提交接收', received: '确认接收', done: '完成转移', cancelled: '取消交接' }[n] || n }}
            </button>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('leads');
const dict = ref({});
const ov = ref({});
const saving = ref(false);
const modal = ref('');

const canWrite = computed(() => can('crm.write'));
const canApprove = computed(() => can('crm.approve'));

/** 金额按币种给符号：美金记 $，人民币记 ¥，其他币种直接带代码（不要给美金套 ¥） */
const money = (v, cur) => {
  const n = Number(v || 0);
  const c = cur || 'CNY';
  const sym = c === 'USD' ? '$' : (c === 'CNY' ? '¥' : '');
  const s = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-' : '') + sym + s + (sym ? '' : ' ' + c);
};
const stageLabel = (k) => ((dict.value.lead_stage || []).find((x) => x.k === k) || {}).v || k;
const commStatusLabel = (k) => ({ reviewing: '提交复核', approved: '批准', rejected: '驳回', settled: '引薪酬', draft: '退回草稿' }[k] || k);
const stageTag = (s) => ({ new: 'gray', qualifying: 'blue', sampling: 'purple', won: 'green', lost: 'red' }[s] || 'gray');
const cycleTag = (s) => ({ unknown: 'orange', known: 'green', seasonal: 'blue', oneoff: 'gray' }[s] || 'gray');
const logAction = (a) => ({ create: '新建', assign: '分配', claim: '认领', follow: '跟进', recycle: '回收公海', merge: '合并', stage: '推进' }[a] || a);
const srcTypeLabel = (k) => ({ payment: '收款单', ar_invoice: '应收发票', cost_object: '成本对象（毛利）', refund: '退款', bad_debt: '坏账' }[k] || k);
const orderStatusLabel = (k) => ({
  draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
  instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
}[k] || k);

/* ---------------- 概览 ---------------- */
async function loadOv() {
  ov.value = await api.crmOverview();
}

/* ---------------- 线索 ---------------- */
const leads = ref([]);
const lf = reactive({ stage: '', owner_user_id: '', pool: '', q: '' });
const lead = ref(null);
const leadForm = reactive({ source: 'manual', source_ref: '', customer_name_raw: '', customer_id: null, contact: '', country: '', est_amount: '', owner_user_id: null });
const followForm = reactive({ note: '', evidence: '', next_action: '', next_action_date: '' });
const stageForm = reactive({ to: '', lost_reason: 'price', lost_note: '', order_id: null, note: '' });
const orders = ref([]);

async function loadLeads() {
  leads.value = await api.crmLeads({ ...lf });
}
function openLeadNew() {
  Object.assign(leadForm, { source: 'manual', source_ref: '', customer_name_raw: '', customer_id: null, contact: '', country: '', est_amount: '', owner_user_id: null });
  modal.value = 'leadNew';
}
async function saveLead() {
  saving.value = true;
  try {
    await api.createCrmLead({ ...leadForm });
    modal.value = '';
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openLead(id) {
  lead.value = await api.crmLead(id);
  Object.assign(followForm, { note: '', evidence: '', next_action: '', next_action_date: '' });
  modal.value = 'lead';
}
async function saveFollow() {
  saving.value = true;
  try {
    await api.followCrmLead(lead.value.id, { ...followForm });
    await openLead(lead.value.id);
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openStage(to) {
  Object.assign(stageForm, { to, lost_reason: 'price', lost_note: '', order_id: null, note: '' });
  if (to === 'won') {
    // 只有「已确认」的订单能作为线索转单目标（草稿单不算成交）
    const list = await api.orders({ limit: 200 });
    const rows = Array.isArray(list) ? list : (list.rows || []);
    orders.value = rows.filter((o) => !['draft', 'cancelled'].includes(o.status));
  }
  modal.value = 'stage';
}
async function saveStage() {
  saving.value = true;
  try {
    const body = { to: stageForm.to, note: stageForm.note };
    if (stageForm.to === 'lost') { body.lost_reason = stageForm.lost_reason; body.lost_note = stageForm.lost_note; }
    if (stageForm.to === 'won') body.order_id = stageForm.order_id;
    await api.crmLeadStage(lead.value.id, body);
    modal.value = '';
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function claim(l) {
  try {
    await api.claimCrmLead(l.id);
    if (modal.value === 'lead') await openLead(l.id);
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function recycle(l) {
  const reason = '主管判定：长期无跟进，回收公海';
  try {
    await api.recycleCrmLead(l.id, { reason });
    modal.value = '';
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function mergeInto(d) {
  if (!confirm(`把 ${d.lead_no} 合并到当前线索？只合并线索，客户档案不会自动合并。`)) return;
  try {
    await api.mergeCrmLead(lead.value.id, { into_id: d.id });
    await openLead(d.id);
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doSweep() {
  try {
    const r = await api.sweepCrmPool();
    alert(`已回收 ${r.recycled} 条响应超时的线索${r.recycled ? '：' + r.leads.join('、') : ''}`);
    await Promise.all([loadLeads(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/* ---------------- 周期 ---------------- */
const cycles = ref([]);
const alerts = ref({ counts: { overdue: 0, escalated: 0, soon: 0 } });
const inferList = ref([]);
const cf = reactive({ status: '', overdue: '', scope: 'active' });
const cycleForm = reactive({ customer_id: null, customer_name: '', status: 'known', cycle_days: 30, grace_days: 0, owner_user_id: null, review_date: '', reason: '' });
const followupForm = reactive({ customer_id: null, customer_name: '', contact_note: '', result: 'replied', next_date: '', evidence: '', kind: 'cycle_due' });

async function loadCycles() {
  cycles.value = await api.crmCycles({ ...cf });
}
async function loadAlerts() {
  alerts.value = await api.crmCycleAlerts({});
}
async function loadInfer() {
  inferList.value = await api.crmCycleInfer();
  if (!inferList.value.length) alert('没有可推断的客户（至少要有 3 次有效采购）');
}
async function acceptInfer(x) {
  try {
    await api.acceptCrmInference({ customer_id: x.customer_id, days: x.suggested_days });
    inferList.value = inferList.value.filter((y) => y.customer_id !== x.customer_id);
    await Promise.all([loadCycles(), loadAlerts(), loadOv()]);
  } catch (e) { alert(e.message); }
}
function openCycle(r) {
  Object.assign(cycleForm, {
    customer_id: r.customer_id, customer_name: r.customer_name, status: r.status,
    cycle_days: r.cycle_days || 30, grace_days: r.grace_days || 0,
    owner_user_id: r.owner_user_id || null, review_date: r.review_date || '', reason: r.reason || ''
  });
  modal.value = 'cycle';
}
async function saveCycle() {
  saving.value = true;
  try {
    await api.saveCrmCycle({ ...cycleForm });
    modal.value = '';
    await Promise.all([loadCycles(), loadAlerts(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
function openFollowup(r) {
  Object.assign(followupForm, { customer_id: r.customer_id, customer_name: r.customer_name, contact_note: '', result: 'replied', next_date: '', evidence: '', kind: 'cycle_due' });
  modal.value = 'followup';
}
async function saveFollowup() {
  saving.value = true;
  try {
    await api.addCrmFollowup({ ...followupForm });
    modal.value = '';
    await Promise.all([loadCycles(), loadAlerts(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function doRefreshCycle() {
  try {
    const r = await api.refreshCrmCycles();
    alert(`已按有效订单刷新 ${r.refreshed} 个客户的采购日`);
    await Promise.all([loadCycles(), loadAlerts(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/* ---------------- 客户价值 ---------------- */
const ranking = ref({ rows: [], total: 0, pending_cnt: 0, note: '' });
const rf = reactive({ from: '', to: '', metric: 'revenue', exclude_internal: '' });
async function loadRanking() {
  ranking.value = await api.crmRanking({ ...rf });
}

/* ---------------- 目标 ---------------- */
const targets = ref([]);
const tf = reactive({ period: '' });
const targetDetail = ref(null);
const targetForm = reactive({ period: '', team: '外贸一部', items: [] });
async function loadTargets() {
  targets.value = await api.crmTargets(tf.period ? { period: tf.period } : {});
}
async function openTarget(id) {
  targetDetail.value = await api.crmTarget(id);
  modal.value = 'target';
}
function openTargetNew() {
  Object.assign(targetForm, {
    period: tf.period || (dict.value.today || '').slice(0, 7), team: '外贸一部',
    items: [{ user_name: ((dict.value.users || [])[0] || {}).name, metric: 'amount', target_amount: 0 }]
  });
  modal.value = 'targetNew';
}
async function saveTarget() {
  saving.value = true;
  try {
    await api.createCrmTarget({ ...targetForm });
    modal.value = '';
    await loadTargets();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function approveTarget(t) {
  try {
    await api.approveCrmTarget(t.id);
    await Promise.all([loadTargets(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/* ---------------- 提成 ---------------- */
const rules = ref([]);
const commissions = ref([]);
const cmf = reactive({ period: '', status: '' });
const ruleForm = reactive({ name: '', base_type: 'collection', effective_from: '', deduct_refund: true, tiers: [] });
const commForm = reactive({ period: '', user_name: '', rule_id: null });
const commDetail = ref(null);
const preview = ref(null);
const adjustForm = reactive({ source_type: 'refund', source_no: '', amount: '', note: '' });

async function loadRules() {
  rules.value = await api.crmRules({});
}
async function loadCommissions() {
  commissions.value = await api.crmCommissions({ ...cmf });
}
function openRuleNew() {
  Object.assign(ruleForm, {
    name: '', base_type: 'collection', effective_from: (dict.value.today || '').slice(0, 8) + '01',
    deduct_refund: true, tiers: [{ from: 0, to: 100000, rate: 1 }, { from: 100000, to: null, rate: 1.5 }]
  });
  modal.value = 'rule';
}
async function saveRule() {
  saving.value = true;
  try {
    await api.createCrmRule({ ...ruleForm });
    modal.value = '';
    await loadRules();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function approveRule(r) {
  try {
    await api.approveCrmRule(r.id);
    await loadRules();
  } catch (e) { alert(e.message); }
}
function openCommNew() {
  Object.assign(commForm, {
    period: (dict.value.today || '').slice(0, 7),
    user_name: ((dict.value.users || []).filter((u) => u.role === 'sales')[0] || {}).name,
    rule_id: null
  });
  preview.value = null;
  modal.value = 'commNew';
}
async function doPreview() {
  try {
    preview.value = await api.crmPreviewCommission({ ...commForm });
  } catch (e) { alert(e.message); preview.value = null; }
}
async function saveComm() {
  saving.value = true;
  try {
    const c = await api.createCrmCommission({ ...commForm });
    modal.value = '';
    await Promise.all([loadCommissions(), loadOv()]);
    await openComm(c.id);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openComm(id) {
  commDetail.value = await api.crmCommission(id);
  Object.assign(adjustForm, { source_type: 'refund', source_no: '', amount: '', note: '' });
  modal.value = 'comm';
}
async function saveAdjust() {
  saving.value = true;
  try {
    await api.adjustCrmCommission(commDetail.value.id, { ...adjustForm });
    await openComm(commDetail.value.id);
    await loadCommissions();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function commAct(c, to) {
  try {
    if (to === 'rejected') {
      const reason = prompt('驳回原因');
      if (!reason) return;
      await api.crmCommissionStatus(c.id, { to, reason });
    } else {
      await api.crmCommissionStatus(c.id, { to });
    }
    if (modal.value === 'comm') await openComm(c.id);
    await Promise.all([loadCommissions(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function linkPayroll(c) {
  try {
    const r = await api.linkCrmPayroll(c.id, { payroll_period: c.period });
    alert(`已生成薪酬来源 ${r.payroll_ref}`);
    await openComm(c.id);
    await Promise.all([loadCommissions(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/* ---------------- 交接 ---------------- */
const handovers = ref([]);
const handoverDetail = ref(null);
const handoverForm = reactive({ from_user_id: null, to_user_id: null, reason: 'transfer', customer_ids: [], note: '' });
async function loadHandovers() {
  handovers.value = await api.crmHandovers({});
}
function openHandoverNew() {
  const sales = (dict.value.users || []).filter((u) => u.role === 'sales');
  Object.assign(handoverForm, {
    from_user_id: sales[0] ? sales[0].id : null, to_user_id: sales[1] ? sales[1].id : null,
    reason: 'transfer', customer_ids: [], note: ''
  });
  modal.value = 'handoverNew';
}
async function saveHandover() {
  saving.value = true;
  try {
    await api.createCrmHandover({ ...handoverForm, customer_ids: (handoverForm.customer_ids || []).join(',') });
    modal.value = '';
    await Promise.all([loadHandovers(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openHandover(id) {
  handoverDetail.value = await api.crmHandover(id);
  modal.value = 'handover';
}
async function handoverAct(h, to) {
  try {
    let note;
    if (to === 'cancelled') {
      note = prompt('取消原因');
      if (!note) return;
    }
    const r = await api.crmHandoverStatus(h.id, { to, note });
    if (to === 'done') alert(`已完成转移：移动未结线索 ${r.moved_leads} 条。历史提成快照不变。`);
    if (modal.value === 'handover') handoverDetail.value = await api.crmHandover(h.id);
    await Promise.all([loadHandovers(), loadOv(), loadCycles()]);
  } catch (e) { alert(e.message); }
}

/* ---------------- 路由 ---------------- */
function go(k) {
  tab.value = k;
  if (k === 'leads') loadLeads();
  if (k === 'cycle') { loadCycles(); loadAlerts(); }
  if (k === 'value') loadRanking();
  if (k === 'commission') { loadTargets(); loadRules(); loadCommissions(); }
  if (k === 'handover') loadHandovers();
}
async function reloadAll() {
  dict.value = await api.crmDict();
  await loadOv();
  go(tab.value);
}

onMounted(async () => {
  dict.value = await api.crmDict();
  const t = dict.value.today || '';
  tf.period = t.slice(0, 7);
  cmf.period = t.slice(0, 7);
  rf.to = t;
  rf.from = t.slice(0, 4) + '-01-01';
  await loadOv();
  await loadLeads();
});
</script>

<style scoped>
.page { max-width: 1560px; }
.page-head .sub { max-width: 980px; }
.head-ops { display: flex; align-items: center; gap: 10px; flex: none; flex-wrap: nowrap; }
.head-ops .btn { white-space: nowrap; }
.pill { display: inline-block; white-space: nowrap; font-size: 11.5px; font-weight: 700; border-radius: 6px; padding: 4px 9px; }
.p-gray { background: #eef1f6; color: #6b7688; }

.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { font-size: 12px; color: #8a94a6; display: block; }
.stat strong { font-size: 21px; color: #16305f; display: block; margin-top: 4px; line-height: 1.1; }
.stat small { font-size: 11px; color: #9aa4b5; display: block; margin-top: 4px; }
.stat.st-warn { border-color: #f5d9a8; background: #fffdf7; }
.stat.st-bad { border-color: #f3c2c9; background: #fffafb; }

.tabbar { display: flex; margin-bottom: 10px; }
.tabs { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; }
.tabs button {
  flex: 0 0 auto; white-space: nowrap; padding: 8px 14px; border: 1px solid #e2e8f2; background: #fff;
  border-radius: 9px; font-size: 13px; color: #4b5568; cursor: pointer; font-family: inherit;
}
.tabs button.on { background: #2b6de5; border-color: #2b6de5; color: #fff; font-weight: 700; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; border-radius: 9px; padding: 0 5px; font-size: 10.5px; }

.toolbar select, .toolbar input, .kw { padding: 7px 10px; border: 1px solid #dfe5ef; border-radius: 8px; font-size: 13px; font-family: inherit; }
.spacer { flex: 1; }
.tiny { font-size: 11.5px; }
.muted { color: #8a94a6; }
.blue { color: #2563eb; }
.green { color: #16a34a; }
.red { color: #d92d45; }
.nowrap { white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, Consolas, monospace; }
.lnk { color: #2563eb; cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.link-btn { background: none; border: none; color: #2563eb; cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.link-btn.danger { color: #d92d45; }
.empty-box { text-align: center; color: #9aa4b5; padding: 20px 0; font-size: 13px; }
.empty-cell { text-align: center; color: #9aa4b5; padding: 28px 0 !important; }
.row-bad { background: #fffafb; }
.row-warn { background: #fffdf7; }
.row-off { background: #fbfcfe; color: #8a94a6; }
.chk { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: #4b5568; white-space: nowrap; }
.hint-bar { background: #f2f7ff; border: 1px solid #d6e4ff; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; color: #33415a; margin-bottom: 12px; line-height: 1.75; }
.hint-bar b { color: #16305f; }
.sec { margin: 18px 0 10px; font-size: 14px; color: #16233b; }
.sec small { margin-left: 8px; font-size: 11.5px; color: #9aa4b5; font-weight: 400; }

/* 漏斗 */
.funnel { display: flex; gap: 8px; margin-bottom: 12px; }
.fn-item { flex: 1; background: #fff; border: 1px solid #e6ebf3; border-radius: 11px; padding: 10px 12px; }
.fn-item span { font-size: 12px; color: #8a94a6; display: block; }
.fn-item b { font-size: 20px; color: #16305f; }
.fn-won { border-color: #bfe6cd; background: #f7fdfa; }
.fn-lost { border-color: #f3d4d8; background: #fffafb; }

/* 预警卡 */
.alert-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.al { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.al span { font-size: 12px; color: #8a94a6; display: block; }
.al b { font-size: 24px; color: #16305f; display: block; margin-top: 4px; }
.al small { font-size: 11px; color: #9aa4b5; }
.al-red { border-color: #f3c2c9; background: #fffafb; }
.al-red b { color: #d92d45; }
.al-orange { border-color: #f5d9a8; background: #fffdf7; }
.al-orange b { color: #d97706; }

.infer { margin-bottom: 12px; }
.infer h3 { display: flex; align-items: baseline; gap: 8px; }
.infer h3 small { font-size: 11.5px; color: #9aa4b5; font-weight: 400; }
.inf-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px dashed #eef2f7; font-size: 13px; }
.inf-row:last-child { border-bottom: none; }

.tgt { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; }
.tgt-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* 表单/弹窗 */
.fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.fgrid label, .full { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #6b7688; }
.fgrid input, .fgrid select, .full input, .full select {
  padding: 7px 10px; border: 1px solid #dfe5ef; border-radius: 8px; font-size: 13px; font-family: inherit; color: #1f2937;
}
.full { margin-top: 10px; }
.trow { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 8px; margin-bottom: 6px; align-items: center; }
.trow input, .trow select { padding: 6px 9px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 13px; font-family: inherit; }
.ld-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
.kv div { background: #fbfcfe; border: 1px solid #eef2f7; border-radius: 10px; padding: 9px 11px; }
.kv span { font-size: 11.5px; color: #8a94a6; display: block; }
.kv b { font-size: 14px; color: #16305f; display: block; margin-top: 3px; }
.kv small { font-size: 10.5px; color: #9aa4b5; display: block; margin-top: 3px; }
.dup-box { background: #fffdf7; border: 1px solid #f5e3b3; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; margin-bottom: 10px; }
.dup-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.act-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed #eef2f7; }
.fu-box { background: #fbfcfe; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; margin-top: 10px; }
.fu-box h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.fu-box h4 small { margin-left: 8px; font-size: 11px; color: #9aa4b5; font-weight: 400; }
.fu-box textarea { width: 100%; padding: 8px 10px; border: 1px solid #dfe5ef; border-radius: 8px; font-size: 13px; font-family: inherit; margin-bottom: 8px; box-sizing: border-box; }
.tl { border-left: 2px solid #e8eef8; padding-left: 10px; }
.tl-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
.rsn { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pv { border: 1px solid #e6ebf3; border-radius: 10px; padding: 12px 14px; margin-top: 12px; background: #fbfcfe; }
.pv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.pv-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.pv-grid div { background: #fff; border: 1px solid #eef2f7; border-radius: 9px; padding: 8px 10px; }
.pv-grid span { font-size: 11.5px; color: #8a94a6; display: block; }
.pv-grid b { font-size: 15px; color: #16305f; display: block; margin-top: 2px; }
.pv-grid b.sm { font-size: 13px; }
.pv-grid small { font-size: 10.5px; color: #9aa4b5; display: block; margin-top: 2px; }
.pv-tier { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; color: #4b5568; }
.adj-box { background: #fbfcfe; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; margin-top: 12px; }
.adj-box h4 { margin: 0 0 8px; font-size: 13px; }
.adj-box h4 small { margin-left: 8px; font-size: 11px; color: #9aa4b5; font-weight: 400; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { background: #f2f7ff; border: 1px solid #d6e4ff; color: #2563eb; border-radius: 14px; padding: 3px 10px; font-size: 12px; }

@media (max-width: 1180px) {
  .stat-row, .alert-grid, .kv, .pv-grid { grid-template-columns: repeat(3, 1fr); }
  .fgrid { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .stat-row, .alert-grid, .kv, .pv-grid { grid-template-columns: 1fr 1fr; }
  .funnel { flex-wrap: wrap; }
  .fn-item { flex: 1 1 30%; }
  .head-ops { flex-wrap: wrap; }
  .trow { grid-template-columns: 1fr 1fr; }
}
</style>
