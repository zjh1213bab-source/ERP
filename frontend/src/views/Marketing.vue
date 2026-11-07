<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>营销与素材</h2>
        <p class="sub">
          上新<b>不等于</b>技术确认，也不等于排产：这里只检查依赖（素材 / 技术 / 到仓），不回头改生产状态。
          素材必须带<b>授权范围与有效期</b>，客户专属花型不能给别的客户用；AI 生成的素材只能当草稿，人工审核过才能上架。
          活动按<b>币种各记一套账</b>，账单币种不一致直接拒；归因收入已剔除未确认订单与集团内部转单，且<b>归因收入 ≠ 净利润</b>。
        </p>
      </div>
      <div class="head-ops">
        <span v-if="ov.launch_rate !== null && ov.launch_rate !== undefined" class="pill p-gray">
          按期上新率 {{ ov.launch_rate }}%
        </span>
        <input v-if="tab === 'cal'" v-model="month" type="month" @change="loadCal" />
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <template v-if="tab === 'cal'">
        <div class="stat"><span>待资料</span><strong>{{ st('draft') }}</strong><small>还没开始备素材</small></div>
        <div class="stat"><span>素材筹备</span><strong>{{ st('material') }}</strong><small>设计/美工在产出</small></div>
        <div class="stat"><span>资料确认</span><strong>{{ st('ready') }}</strong><small>等齐资料就能上</small></div>
        <div class="stat"><span>已上新</span><strong>{{ ov.launched || 0 }}</strong><small>按期 {{ ov.on_time || 0 }} 条</small></div>
        <div class="stat" :class="ov.overdue ? 'st-bad' : ''"><span>已逾期未上</span><strong>{{ ov.overdue || 0 }}</strong><small>计划日已过仍在筹备</small></div>
        <div class="stat"><span>7 天内要上</span><strong>{{ ov.due_soon_7d || 0 }}</strong><small>留给设计的时间不多了</small></div>
      </template>
      <template v-else-if="tab === 'asset'">
        <div class="stat"><span>可用素材</span><strong>{{ ov.approved || 0 }}</strong><small>审核通过且在授权期内</small></div>
        <div class="stat"><span>待审</span><strong>{{ ov.pending || 0 }}</strong><small>含 AI 生成</small></div>
        <div class="stat" :class="ov.expiring_30d ? 'st-warn' : ''"><span>30 天内到期</span><strong>{{ ov.expiring_30d || 0 }}</strong><small>到期即不可用</small></div>
        <div class="stat" :class="ov.expired ? 'st-bad' : ''"><span>已过期</span><strong>{{ ov.expired || 0 }}</strong><small>要续期或换图</small></div>
        <div class="stat"><span>客户专属</span><strong>{{ ov.exclusive || 0 }}</strong><small>只能给登记客户用</small></div>
        <div class="stat"><span>素材总数</span><strong>{{ ov.asset_total || 0 }}</strong><small>含草稿与作废</small></div>
      </template>
      <template v-else-if="tab === 'camp'">
        <div v-for="g in campByCur" :key="g.currency" class="stat">
          <span>{{ g.currency }} 预算 / 已花</span>
          <strong>{{ money(g.budget, g.currency) }}</strong>
          <small>已花 {{ money(g.actual, g.currency) }} · 归因 {{ money(g.revenue, g.currency) }}</small>
        </div>
        <div class="stat" :class="ov.over_budget ? 'st-bad' : ''"><span>超预算活动</span><strong>{{ ov.over_budget || 0 }}</strong><small>执行中或已账单</small></div>
        <div class="stat"><span>投放中</span><strong>{{ ov.camp_running || 0 }}</strong><small>已批准/执行中</small></div>
        <div class="stat"><span>说明</span><strong class="tiny-strong">按币种分开</strong><small>不做跨币种合计</small></div>
      </template>
      <template v-else>
        <div class="stat"><span>待行动</span><strong>{{ rvCount('open') }}</strong><small>已立项未动手</small></div>
        <div class="stat"><span>执行中</span><strong>{{ rvCount('doing') }}</strong><small>动作在推进</small></div>
        <div class="stat"><span>已关闭</span><strong>{{ rvCount('done') }}</strong><small>行动项全部完成</small></div>
        <div class="stat" :class="ov.overdue_actions ? 'st-bad' : ''"><span>逾期行动项</span><strong>{{ ov.overdue_actions || 0 }}</strong><small>过了期限没完成</small></div>
        <div class="stat"><span>行动闭环率</span><strong>{{ revReport.actions ? revReport.actions.close_rate : '—' }}<i v-if="revReport.actions">%</i></strong><small>完成+取消 ÷ 全部</small></div>
        <div class="stat"><span>复盘总数</span><strong>{{ ov.review_total || 0 }}</strong><small>本模块累计</small></div>
      </template>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'cal' }" @click="go('cal')">上新日历<span v-if="ov.overdue" class="tab-dot">{{ ov.overdue }}</span></button>
        <button :class="{ on: tab === 'asset' }" @click="go('asset')">品牌素材与授权<span v-if="ov.expiring_30d" class="tab-dot">{{ ov.expiring_30d }}</span></button>
        <button :class="{ on: tab === 'camp' }" @click="go('camp')">活动预算与效果</button>
        <button :class="{ on: tab === 'rev' }" @click="go('rev')">运营复盘与协同<span v-if="ov.overdue_actions" class="tab-dot">{{ ov.overdue_actions }}</span></button>
      </div>
    </div>

    <!-- ==================== 上新日历 ==================== -->
    <div v-if="tab === 'cal'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <div class="seg">
          <button :class="{ on: view === 'cal' }" @click="view = 'cal'">日历</button>
          <button :class="{ on: view === 'list' }" @click="view = 'list'">列表</button>
        </div>
        <select v-model="taskFilter" @change="loadTasks">
          <option value="">全部状态</option>
          <option v-for="s in dict.task_status" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <label class="chk"><input v-model="onlyOverdue" type="checkbox" @change="loadTasks" /> 只看逾期</label>
        <span class="muted tiny">{{ view === 'cal' ? month : '全部' }} 共 {{ calTasks.length }} 条</span>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary" @click="openTask()">＋ 新建上新任务</button>
      </div>

      <!-- 日历 -->
      <div v-if="view === 'cal'" class="cal">
        <div class="cal-head">
          <span v-for="w in ['周一','周二','周三','周四','周五','周六','周日']" :key="w">{{ w }}</span>
        </div>
        <div class="cal-body">
          <div v-for="(c, i) in calCells" :key="i" class="cal-cell" :class="{ out: !c.date, today: c.date === dict.today }">
            <div v-if="c.date" class="cal-day">
              <span>{{ Number(c.date.slice(8)) }}</span>
              <em v-if="c.date === dict.today">今天</em>
            </div>
            <div v-for="t in c.tasks" :key="t.id" class="cal-chip" :class="chipClass(t)" @click="openTaskDetail(t.id)" :title="t.title">
              <b>{{ t.style_no || t.product_name }}</b>
              <i>{{ t.channel || '未填渠道' }}</i>
            </div>
          </div>
        </div>
        <div class="cal-legend">
          <span><i class="lg lg-gray"></i>待资料</span>
          <span><i class="lg lg-blue"></i>素材筹备</span>
          <span><i class="lg lg-purple"></i>资料确认</span>
          <span><i class="lg lg-green"></i>已上新</span>
          <span><i class="lg lg-red"></i>逾期未上</span>
        </div>
      </div>

      <!-- 列表 -->
      <div v-else class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>任务</th><th>款号 / 款名</th><th>类型</th><th>渠道 / 店铺</th><th>计划上线</th><th>状态</th><th>延迟</th><th>主责</th><th>素材</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in calTasks" :key="t.id">
              <td><a class="lnk" @click="openTaskDetail(t.id)">{{ t.task_no }}</a><div class="tiny muted">{{ t.title }}</div></td>
              <td>{{ t.style_no || '—' }}<div class="tiny muted">{{ t.product_name }}</div></td>
              <td><span class="tag" :class="t.biz_type === 'custom' ? 'purple' : 'gray'">{{ t.biz_type === 'custom' ? '定制' : '现货' }}</span></td>
              <td>{{ t.channel || '—' }}<div class="tiny muted">{{ t.shop_name }}</div></td>
              <td class="nowrap">{{ t.plan_launch_date || '—' }}</td>
              <td>
                <span class="tag" :class="statusTag(t.status)">{{ t.status_label }}</span>
                <div v-if="t.is_overdue" class="tiny red">逾期 {{ Math.abs(t.days_left) }} 天</div>
              </td>
              <td>
                <span v-if="t.delay_days === null" class="muted">—</span>
                <span v-else :class="t.delay_days > 0 ? 'red' : 'green'">{{ t.delay_days > 0 ? '+' + t.delay_days + ' 天' : '按期' }}</span>
              </td>
              <td>{{ t.owner || '—' }}</td>
              <td>{{ t.asset_cnt }}</td>
              <td><button class="link-btn" @click="openTaskDetail(t.id)">详情</button></td>
            </tr>
            <tr v-if="!calTasks.length"><td colspan="10" class="empty-cell">本月没有上新任务</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 素材 ==================== -->
    <div v-if="tab === 'asset'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="assetFilter.kind" @change="loadAssets">
          <option value="">全部类型</option>
          <option v-for="k in dict.asset_kind" :key="k.key" :value="k.key">{{ k.label }}</option>
        </select>
        <select v-model="assetFilter.status" @change="loadAssets">
          <option value="">全部状态</option>
          <option v-for="s in dict.asset_status" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <select v-model="assetFilter.scope" @change="loadAssets">
          <option value="">全部授权范围</option>
          <option v-for="s in dict.asset_scope" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <label class="chk"><input v-model="assetFilter.expiring" type="checkbox" true-value="1" false-value="" @change="loadAssets" /> 只看 30 天内到期</label>
        <div class="spacer"></div>
        <button v-if="canApprove" class="btn btn-ghost" @click="sweep">把已到期素材置为过期</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openAsset()">＋ 登记素材</button>
      </div>

      <div class="asset-grid">
        <div v-for="a in assets" :key="a.id" class="asset-card" :class="{ dead: a.status === 'expired' || a.status === 'revoked' }">
          <div class="ac-top">
            <span class="tag" :class="assetTag(a.status)">{{ a.status_label }}</span>
            <span class="tag" :class="a.scope === 'exclusive' ? 'red' : a.scope === 'public' ? 'gray' : 'blue'">{{ a.scope_label }}</span>
            <span v-if="a.ai_generated" class="tag purple">AI 生成</span>
            <div class="spacer"></div>
            <span class="tiny muted">{{ a.asset_no }}</span>
          </div>
          <h5>{{ a.title }}</h5>
          <div class="ac-meta">
            <span>{{ a.kind_label }} · {{ a.version || '无版本' }}</span>
            <span v-if="a.style_no">款号 {{ a.style_no }}</span>
            <span v-if="a.tech_version">对齐 {{ a.tech_version }}</span>
          </div>
          <div class="ac-lic">
            <div><span class="muted">版权来源</span>{{ a.license_label }}</div>
            <div><span class="muted">授权范围</span>
              {{ a.scope === 'exclusive' ? ('仅 ' + (a.customer_name || '未指定客户')) : a.scope === 'channel' ? (a.channel_list.join(' / ') || '未填渠道') : '公开可用' }}
            </div>
            <div><span class="muted">有效期</span>
              <template v-if="a.license_to">
                {{ a.license_from || '—' }} ~ {{ a.license_to }}
                <b v-if="a.days_left !== null" :class="a.days_left < 0 ? 'red' : a.days_left <= 30 ? 'orange' : 'green'">
                  （{{ a.days_left < 0 ? '已过期 ' + Math.abs(a.days_left) + ' 天' : '剩 ' + a.days_left + ' 天' }}）
                </b>
              </template>
              <template v-else>长期（未填到期日）</template>
            </div>
            <div><span class="muted">被引用</span>{{ a.used_by }} 条上新任务</div>
          </div>
          <div class="ac-ops">
            <button class="link-btn" @click="openAssetDetail(a.id)">详情</button>
            <button v-if="canWrite && a.status === 'draft'" class="link-btn" @click="submitAsset(a)">提交审核</button>
            <button v-if="canWrite && a.status === 'pending'" class="link-btn" @click="openReviewAsset(a)">审核</button>
            <button v-if="canWrite && a.status === 'approved'" class="link-btn danger" @click="openRevokeAsset(a)">作废</button>
          </div>
          <div v-if="a.review_note" class="ac-note">审核意见：{{ a.review_note }}</div>
        </div>
        <div v-if="!assets.length" class="empty-box">没有符合条件的素材</div>
      </div>
    </div>

    <!-- ==================== 活动 ==================== -->
    <div v-if="tab === 'camp'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="campFilter.status" @change="loadCamps">
          <option value="">全部状态</option>
          <option v-for="s in dict.campaign_status" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <select v-model="campFilter.currency" @change="loadCamps">
          <option value="">全部币种</option>
          <option v-for="c in dict.currencies" :key="c" :value="c">{{ c }}</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary" @click="openCamp()">＋ 新建活动</button>
      </div>

      <div class="hint-bar">
        归因只算<b>已排产之后</b>的订单；<b>未确认订单</b>与<b>集团内部转单</b>不算增长，渠道对不上的也不记功。
        归因收入是订单金额，<b>不是净利润</b>；跨币种不做合计。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>活动</th><th>渠道 / 店铺</th><th>币种</th><th>期间</th><th class="num">批准预算</th><th class="num">已发生</th><th>执行</th><th class="num">归因订单</th><th class="num">归因收入</th><th class="num">ROAS</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="c in campaigns" :key="c.id">
              <td><a class="lnk" @click="openCampDetail(c.id)">{{ c.name }}</a><div class="tiny muted">{{ c.campaign_no }}</div></td>
              <td>{{ c.channel || '—' }}<div class="tiny muted">{{ c.shop_name }}</div></td>
              <td><span class="tag gray">{{ c.currency }}</span></td>
              <td class="tiny nowrap">{{ c.start_date || '—' }} ~ {{ c.end_date || '—' }}<div class="muted">归因 +{{ c.attribution_days }} 天</div></td>
              <td class="num">{{ money(c.budget_amount, c.currency) }}</td>
              <td class="num" :class="c.over_budget ? 'red' : ''">{{ money(c.actual_amount, c.currency) }}</td>
              <td>
                <div class="bar"><i :style="{ width: Math.min(100, c.over_rate || 0) + '%' }" :class="c.over_budget ? 'bar-bad' : 'bar-ok'"></i></div>
                <span class="tiny" :class="c.over_budget ? 'red' : 'muted'">{{ c.over_rate === null ? '—' : c.over_rate + '%' }}</span>
              </td>
              <td class="num">{{ c.attributed_orders }}</td>
              <td class="num">{{ money(c.attributed_revenue, c.currency) }}</td>
              <td class="num">{{ c.roas === null ? '—' : c.roas }}</td>
              <td><span class="tag" :class="campTag(c.status)">{{ c.status_label }}</span></td>
              <td>
                <button class="link-btn" @click="openCampDetail(c.id)">归因</button>
                <button v-if="canApprove && c.status === 'draft'" class="link-btn" @click="approveCamp(c)">批准</button>
                <button v-if="canWrite && ['approved','running'].includes(c.status)" class="link-btn" @click="openBill(c)">记账单</button>
              </td>
            </tr>
            <tr v-if="!campaigns.length"><td colspan="12" class="empty-cell">还没有活动</td></tr>
          </tbody>
        </table>
      </div>

      <h4 style="margin: 20px 0 10px">按币种汇总<small>各币种独立，绝不混加</small></h4>
      <div class="cur-grid">
        <div v-for="g in campReport.currencies" :key="g.currency" class="cur-card">
          <div class="cc-head"><b>{{ g.currency }}</b><span class="muted">{{ g.cnt }} 个活动</span></div>
          <div class="cc-row"><span>预算</span><b>{{ money(g.budget, g.currency) }}</b></div>
          <div class="cc-row"><span>已发生</span><b :class="g.over_budget ? 'red' : ''">{{ money(g.actual, g.currency) }}</b></div>
          <div class="cc-row"><span>归因收入</span><b>{{ money(g.revenue, g.currency) }}</b></div>
          <div class="cc-row"><span>归因订单</span><b>{{ g.orders }}</b></div>
          <div class="cc-row"><span>ROAS</span><b>{{ g.roas === null ? '—' : g.roas }}</b></div>
          <div class="cc-row"><span>归因毛利（CNY）</span><b>{{ money(g.gross_cny, 'CNY') }}</b></div>
          <div class="cc-foot">毛利来自成本对象结转，<b>不等于净利润</b></div>
        </div>
        <div v-if="!campReport.currencies.length" class="empty-box">没有已批准的活动</div>
      </div>
    </div>

    <!-- ==================== 复盘 ==================== -->
    <div v-if="tab === 'rev'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="revFilter.status" @change="loadReviews">
          <option value="">全部状态</option>
          <option v-for="s in dict.review_status" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <select v-model="revFilter.category" @change="loadReviews">
          <option value="">全部分类</option>
          <option v-for="s in dict.review_category" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary" @click="openReview()">＋ 登记复盘</button>
      </div>

      <div class="hint-bar">
        复盘要把缺货、客诉、技术延期<b>反馈到源头</b>（采购/技术/PMC），不是只写投放报表。
        每条行动项必须有<b>负责人和期限</b>，没完成的复盘不能关闭。
      </div>

      <div class="rev-list">
        <div v-for="r in reviews" :key="r.id" class="rev-card" :class="{ 'rc-bad': r.overdue_cnt > 0 }">
          <div class="rc-top">
            <span class="tag" :class="revTag(r.status)">{{ r.status_label }}</span>
            <span class="tag gray">{{ r.category_label }}</span>
            <span class="tiny muted">{{ r.period }} · {{ r.review_no }}</span>
            <div class="spacer"></div>
            <span v-if="r.overdue_cnt" class="tag red">逾期 {{ r.overdue_cnt }}</span>
          </div>
          <h5>{{ r.topic }}</h5>
          <div class="rc-meta">
            <span>证据：{{ r.evidence || '—' }}</span>
            <span>主责：{{ r.owner || '未指定' }}</span>
            <span>期限：{{ r.due_date || '—' }}</span>
          </div>
          <div class="rc-prog">
            <div class="bar"><i :style="{ width: (r.action_cnt ? (r.done_cnt / r.action_cnt) * 100 : 0) + '%' }" class="bar-ok"></i></div>
            <span class="tiny">行动 {{ r.done_cnt }}/{{ r.action_cnt }} 完成</span>
            <div class="spacer"></div>
            <button class="link-btn" @click="openRevDetail(r.id)">处理</button>
          </div>
        </div>
        <div v-if="!reviews.length" class="empty-box">还没有复盘记录</div>
      </div>

      <h4 style="margin: 20px 0 10px">按原因分布<small>看问题主要出在哪个环节</small></h4>
      <div class="cat-grid">
        <div v-for="c in revReport.by_category" :key="c.key" class="cat-card">
          <div class="cc-head"><b>{{ c.label }}</b><span class="muted">{{ c.cnt }} 条</span></div>
          <div class="bar"><i :style="{ width: (revReport.reviews.length ? (c.cnt / revReport.reviews.length) * 100 : 0) + '%' }" class="bar-ok"></i></div>
          <div class="tiny muted" style="margin-top: 6px">已关闭 {{ c.done }} · 行动 {{ c.actions }} · 逾期 {{ c.overdue }}</div>
        </div>
        <div v-if="!revReport.by_category.length" class="empty-box">暂无数据</div>
      </div>
    </div>

    <!-- ==================== 新建任务 ==================== -->
    <div v-if="modal === 'task'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>新建上新任务</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld"><span>任务名 *</span><input v-model="taskForm.title" placeholder="如 MK-S001 早秋开衫 天猫首波" /></label>
            <label class="fld"><span>类型 *</span>
              <select v-model="taskForm.biz_type">
                <option value="stock">现货上新（要求有库存）</option>
                <option value="custom">定制上新（要求技术确认）</option>
              </select>
            </label>
            <label class="fld"><span>款号</span><input v-model="taskForm.style_no" placeholder="MK-S001" /></label>
            <label class="fld"><span>款名</span><input v-model="taskForm.product_name" /></label>
            <label class="fld"><span>渠道</span><input v-model="taskForm.channel" list="mk-channels" placeholder="天猫旗舰店" /></label>
            <label class="fld"><span>店铺</span><input v-model="taskForm.shop_name" list="mk-channels" /></label>
            <label class="fld"><span>客户（专属上新才填）</span>
              <select v-model="taskForm.customer_id">
                <option :value="null">不指定</option>
                <option v-for="c in dict.customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="fld"><span>计划上线</span><input v-model="taskForm.plan_launch_date" type="date" /></label>
            <label class="fld"><span>主责</span><input v-model="taskForm.owner" placeholder="运营-林夏" /></label>
            <label class="fld"><span>关联活动</span>
              <select v-model="taskForm.campaign_id">
                <option :value="null">不挂活动</option>
                <option v-for="c in campaigns" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="fld wide"><span>依赖说明</span><input v-model="taskForm.depends" placeholder="合规资料 / 可靠到仓" /></label>
          </div>
          <p class="tiny muted">建好后是「待资料」，要先绑可用素材才能到「资料确认」，三项门槛（素材/技术/到仓）全过才能上新。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitTask">创建</button>
        </div>
      </div>
    </div>

    <!-- ==================== 任务详情 ==================== -->
    <div v-if="modal === 'taskDetail' && curTask" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ curTask.task_no }} · {{ curTask.title }}</h3>
          <button class="x" @click="modal = ''">×</button>
        </div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="statusTag(curTask.status)">{{ curTask.status_label }}</span>
            <span class="tag" :class="curTask.biz_type === 'custom' ? 'purple' : 'gray'">{{ curTask.biz_type === 'custom' ? '定制' : '现货' }}</span>
            <span class="tag gray">{{ curTask.channel || '未填渠道' }}</span>
            <span class="muted tiny">计划 {{ curTask.plan_launch_date || '—' }}
              <template v-if="curTask.actual_launch_date"> · 实际 {{ curTask.actual_launch_date }}</template>
              <template v-if="curTask.delay_days !== null"> · {{ curTask.delay_days > 0 ? '延期 ' + curTask.delay_days + ' 天' : '按期' }}</template>
            </span>
          </div>

          <div class="gate-row">
            <div v-for="g in curTask.gates.items" :key="g.key" class="gate" :class="g.ok ? 'gate-ok' : (g.required ? 'gate-bad' : 'gate-na')">
              <div class="g-head">
                <b>{{ g.label }}</b>
                <span>{{ g.ok ? '通过' : (g.required ? '未过' : '不要求') }}</span>
              </div>
              <div class="g-detail">{{ g.detail }}</div>
            </div>
          </div>
          <p v-if="!curTask.gates.ok" class="tiny red" style="margin: 6px 0 0">
            卡在：{{ curTask.gates.blocking.join('、') }} —— 营销不能替技术或仓库做决定，这里只拦不让上新。
          </p>

          <div class="two-col">
            <div>
              <h4>任务步骤<small>谁卡住看得见</small></h4>
              <div class="step-list">
                <div v-for="s in curTask.steps" :key="s.id" class="step" :class="{ done: s.status === 'done' }">
                  <span class="st-dot"></span>
                  <div class="st-body">
                    <b>{{ s.seq }}. {{ s.name }}</b>
                    <div class="tiny muted">{{ s.owner || '未指定' }}<template v-if="s.due_date"> · 期限 {{ s.due_date }}</template>
                      <template v-if="s.status === 'done'"> · 完成 {{ $fmtDate(s.done_at) }}</template>
                    </div>
                  </div>
                  <button v-if="canWrite && s.status !== 'done'" class="link-btn" @click="finishStep(s)">完成</button>
                </div>
                <div v-if="canWrite" class="step-add">
                  <input v-model="stepName" class="input" placeholder="加一步，如「直播口播稿」" />
                  <button class="btn btn-sm btn-ghost" @click="addStep">加</button>
                </div>
              </div>

              <h4 style="margin-top: 16px">流转记录</h4>
              <div class="log-list">
                <div v-for="l in curTask.logs" :key="l.id" class="log">
                  <span class="tiny muted">{{ $fmt(l.created_at) }}</span>
                  <span>{{ l.from_status ? (labelOf(l.from_status) + ' → ') : '' }}<b>{{ labelOf(l.to_status) }}</b></span>
                  <span class="tiny muted">{{ l.operator }}{{ l.note ? ' · ' + l.note : '' }}</span>
                </div>
              </div>
            </div>

            <div>
              <h4>已绑素材<small>绑定时已核过授权</small></h4>
              <div class="bound-list">
                <div v-for="a in curTask.assets" :key="a.id" class="bound" :class="{ blocked: a.blocked }">
                  <div>
                    <b>{{ a.title }}</b>
                    <div class="tiny muted">{{ a.asset_no }} · {{ a.version || '无版本' }} · {{ a.scope_label }}
                      <template v-if="a.license_to"> · 至 {{ a.license_to }}</template>
                    </div>
                    <div v-if="a.blocked" class="tiny red">{{ a.blocked }}</div>
                  </div>
                  <button v-if="canWrite" class="link-btn danger" @click="unbind(a)">解绑</button>
                </div>
                <div v-if="!curTask.assets.length" class="tiny muted">还没绑素材</div>
              </div>
              <div v-if="canWrite" class="bind-add">
                <select v-model="bindAssetId">
                  <option :value="null">选择可用素材…</option>
                  <option v-for="a in bindableAssets" :key="a.id" :value="a.id">{{ a.title }}（{{ a.scope_label }}）</option>
                </select>
                <button class="btn btn-sm btn-ghost" :disabled="!bindAssetId" @click="doBind">绑定</button>
              </div>
              <p class="tiny muted" style="margin-top: 8px">
                客户专属素材只列本任务客户的；渠道素材只列本渠道的；过期的一律不出现。
              </p>
            </div>
          </div>

          <div v-if="blockerText !== null && canWrite" class="blocker-box">
            <label class="fld"><span>登记卡点（给别人看的一句话）</span>
              <input v-model="blockerText" class="input" placeholder="如：开发单未确认，面料克重还要再确认一版" />
            </label>
          </div>
        </div>
        <div class="modal-foot">
          <span class="muted tiny" style="margin-right: auto">推进状态只是营销侧动作，不会改动开发单、订单或库存状态</span>
          <button v-for="n in curTask.next" :key="n" class="btn"
            :class="n === 'cancelled' ? 'btn-ghost' : 'btn-primary'"
            :disabled="n === 'launched' && !curTask.gates.ok"
            :title="n === 'launched' && !curTask.gates.ok ? '上新门槛未过：' + curTask.gates.blocking.join('、') : ''"
            @click="advance(n)">
            {{ n === 'cancelled' ? '取消任务' : '推进到「' + labelOf(n) + '」' }}
          </button>
          <button class="btn btn-ghost" @click="modal = ''">关闭</button>
        </div>
      </div>
    </div>

    <!-- ==================== 素材登记 ==================== -->
    <div v-if="modal === 'asset'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>登记素材</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld wide"><span>素材名称 *</span><input v-model="assetForm.title" placeholder="如 MK-S001 主图 V2" /></label>
            <label class="fld"><span>类型</span>
              <select v-model="assetForm.kind"><option v-for="k in dict.asset_kind" :key="k.key" :value="k.key">{{ k.label }}</option></select>
            </label>
            <label class="fld"><span>版本</span><input v-model="assetForm.version" placeholder="IMG-V2" /></label>
            <label class="fld"><span>款号</span><input v-model="assetForm.style_no" /></label>
            <label class="fld"><span>对齐技术资料版本</span><input v-model="assetForm.tech_version" placeholder="TECH-V2" /></label>
            <label class="fld"><span>版权来源 *</span>
              <select v-model="assetForm.license_source"><option v-for="k in dict.license_source" :key="k.key" :value="k.key">{{ k.label }}</option></select>
            </label>
            <label class="fld"><span>授权范围 *</span>
              <select v-model="assetForm.scope"><option v-for="k in dict.asset_scope" :key="k.key" :value="k.key">{{ k.label }}</option></select>
            </label>
            <label v-if="assetForm.scope === 'exclusive'" class="fld"><span>专属客户 *</span>
              <select v-model="assetForm.customer_id">
                <option :value="null">请选择</option>
                <option v-for="c in dict.customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label v-if="assetForm.scope === 'channel'" class="fld"><span>授权渠道 *</span>
              <input v-model="assetForm.channels" placeholder="天猫旗舰店,抖音小店" />
            </label>
            <label class="fld"><span>授权开始</span><input v-model="assetForm.license_from" type="date" /></label>
            <label class="fld"><span>授权到期</span><input v-model="assetForm.license_to" type="date" /></label>
            <label class="fld wide"><span>文件地址</span><input v-model="assetForm.url" placeholder="/uploads/xxx.jpg" /></label>
          </div>
          <p class="tiny muted">
            客户专属必须指定客户；指定渠道必须填渠道；AI 生成必须填对齐的技术资料版本，且只能停在草稿等人工审核。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitAssetForm">保存为草稿</button>
        </div>
      </div>
    </div>

    <!-- 素材审核 / 作废 -->
    <div v-if="modal === 'assetReview'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>{{ reviewMode === 'revoke' ? '作废素材' : '审核素材' }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="det-line"><b>{{ reviewTarget && reviewTarget.title }}</b></p>
          <p class="tiny muted">授权：{{ reviewTarget && reviewTarget.scope_label }} · 有效期至 {{ reviewTarget && (reviewTarget.license_to || '未填') }} · 来源 {{ reviewTarget && reviewTarget.license_label }}</p>
          <label class="fld"><span>{{ reviewMode === 'revoke' ? '作废原因 *' : '审核意见（驳回必填）' }}</span>
            <textarea v-model="reviewNote" rows="3" placeholder="通过写依据（与哪版技术资料一致）；驳回写作废/退回原因" />
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button v-if="reviewMode === 'revoke'" class="btn btn-danger" @click="doRevoke">确认作废</button>
          <template v-else>
            <button class="btn btn-ghost" @click="doReview(false)">驳回到草稿</button>
            <button class="btn btn-primary" @click="doReview(true)">审核通过</button>
          </template>
        </div>
      </div>
    </div>

    <div v-if="modal === 'assetDetail' && curAsset" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ curAsset.asset_no }} · {{ curAsset.title }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="kv">
            <div><span>状态</span><b>{{ curAsset.status_label }}</b></div>
            <div><span>类型 / 版本</span><b>{{ curAsset.kind_label }} · {{ curAsset.version || '—' }}</b></div>
            <div><span>授权范围</span><b>{{ curAsset.scope_label }}</b></div>
            <div><span>专属客户</span><b>{{ curAsset.customer_name || '—' }}</b></div>
            <div><span>授权渠道</span><b>{{ curAsset.channel_list.join(' / ') || '—' }}</b></div>
            <div><span>版权来源</span><b>{{ curAsset.license_label }}</b></div>
            <div><span>有效期</span><b>{{ (curAsset.license_from || '—') + ' ~ ' + (curAsset.license_to || '长期') }}</b></div>
            <div><span>对齐技术资料</span><b>{{ curAsset.tech_version || '—' }}</b></div>
            <div><span>审核</span><b>{{ curAsset.reviewed_by || '—' }} {{ $fmt(curAsset.reviewed_at) }}</b></div>
          </div>
          <p v-if="curAsset.review_note" class="tiny muted">审核意见：{{ curAsset.review_note }}</p>
          <h4>被这些任务引用</h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>任务</th><th>渠道</th><th>计划上线</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="t in curAsset.tasks" :key="t.id">
                  <td>{{ t.task_no }}<div class="tiny muted">{{ t.title }}</div></td>
                  <td>{{ t.channel || '—' }}</td>
                  <td>{{ t.plan_launch_date || '—' }}</td>
                  <td><span class="tag" :class="statusTag(t.status)">{{ t.status_label }}</span></td>
                </tr>
                <tr v-if="!curAsset.tasks.length"><td colspan="4" class="empty-cell">还没被任何任务引用</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 新建活动 ==================== -->
    <div v-if="modal === 'camp'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>新建活动</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld wide"><span>活动名 *</span><input v-model="campForm.name" placeholder="如 天猫早秋上新投放" /></label>
            <label class="fld"><span>币种 *</span>
              <select v-model="campForm.currency"><option v-for="c in dict.currencies" :key="c" :value="c">{{ c }}</option></select>
            </label>
            <label class="fld"><span>预算（原币）*</span><input v-model.number="campForm.budget_amount" type="number" min="0" /></label>
            <label class="fld"><span>渠道</span><input v-model="campForm.channel" list="mk-channels" /></label>
            <label class="fld"><span>店铺（归因用）</span><input v-model="campForm.shop_name" list="mk-channels" /></label>
            <label class="fld"><span>开始</span><input v-model="campForm.start_date" type="date" /></label>
            <label class="fld"><span>结束</span><input v-model="campForm.end_date" type="date" /></label>
            <label class="fld"><span>归因窗口（天）</span><input v-model.number="campForm.attribution_days" type="number" min="0" max="90" /></label>
            <label class="fld"><span>负责人</span><input v-model="campForm.owner" /></label>
            <label class="fld wide"><span>备注</span><input v-model="campForm.note" /></label>
          </div>
          <p class="tiny muted">一个活动一种币种。账单币种必须与活动一致，不同币种不能相加。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitCamp">创建（草稿）</button>
        </div>
      </div>
    </div>

    <!-- 记账单 -->
    <div v-if="modal === 'bill' && curCamp" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>登记账单 · {{ curCamp.name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="tiny muted">活动币种 {{ curCamp.currency }}，账单必须同币种。</p>
          <div class="form-grid">
            <label class="fld"><span>日期 *</span><input v-model="billForm.bill_date" type="date" /></label>
            <label class="fld"><span>金额 *</span><input v-model.number="billForm.amount" type="number" min="0" /></label>
            <label class="fld"><span>币种</span><input v-model="billForm.currency" /></label>
            <label class="fld"><span>来源</span>
              <select v-model="billForm.source"><option v-for="s in dict.bill_source" :key="s.key" :value="s.key">{{ s.label }}</option></select>
            </label>
            <label class="fld"><span>供应商/平台</span><input v-model="billForm.vendor" /></label>
            <label class="fld"><span>单号</span><input v-model="billForm.ref_no" /></label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitBill">登记</button>
        </div>
      </div>
    </div>

    <!-- 活动归因 -->
    <div v-if="modal === 'campDetail' && curCamp" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>{{ curCamp.campaign_no }} · {{ curCamp.name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="campTag(curCamp.status)">{{ curCamp.status_label }}</span>
            <span class="tag gray">{{ curCamp.currency }}</span>
            <span class="muted tiny">{{ curCamp.start_date }} ~ {{ curCamp.end_date }} · 归因窗口 +{{ curCamp.attribution_days }} 天</span>
          </div>

          <div class="gate-row">
            <div class="gate gate-ok"><div class="g-head"><b>预算</b><span>{{ money(curCamp.budget_amount, curCamp.currency) }}</span></div><div class="g-detail">批准预算</div></div>
            <div class="gate" :class="curCamp.over_budget ? 'gate-bad' : 'gate-ok'">
              <div class="g-head"><b>已发生</b><span>{{ money(curCamp.actual_amount, curCamp.currency) }}</span></div>
              <div class="g-detail">{{ curCamp.over_budget ? '已超预算，需说明' : '未超预算' }}</div>
            </div>
            <div class="gate gate-ok"><div class="g-head"><b>归因收入</b><span>{{ money(curCamp.attributed_revenue, curCamp.currency) }}</span></div><div class="g-detail">{{ curCamp.live_attribution.counted_cnt }} 张订单 · ROAS {{ curCamp.live_attribution.roas === null ? '—' : curCamp.live_attribution.roas }}</div></div>
          </div>

          <div class="two-col">
            <div>
              <h4>计入归因的订单（{{ curCamp.live_attribution.counted_cnt }}）</h4>
              <div class="table-wrap" style="box-shadow: none">
                <table class="data">
                  <thead><tr><th>订单</th><th>日期</th><th>客户</th><th class="num">金额</th></tr></thead>
                  <tbody>
                    <tr v-for="o in curCamp.live_attribution.counted" :key="o.id">
                      <td class="nowrap">{{ o.order_no }}</td><td class="nowrap">{{ o.order_date }}</td>
                      <td>{{ o.customer_name || '—' }}</td>
                      <td class="num">{{ money(o.revenue, curCamp.currency) }}</td>
                    </tr>
                    <tr v-if="!curCamp.live_attribution.counted.length"><td colspan="4" class="empty-cell">窗口内没有符合条件的订单</td></tr>
                  </tbody>
                </table>
              </div>
              <h4 style="margin-top: 16px">账单（{{ curCamp.bills.length }}）</h4>
              <div class="table-wrap" style="box-shadow: none">
                <table class="data">
                  <thead><tr><th>日期</th><th>来源</th><th>供应商</th><th>单号</th><th class="num">金额</th></tr></thead>
                  <tbody>
                    <tr v-for="b in curCamp.bills" :key="b.id">
                      <td class="nowrap">{{ b.bill_date }}</td><td class="nowrap">{{ b.source_label }}</td><td>{{ b.vendor || '—' }}</td>
                      <td class="tiny nowrap">{{ b.ref_no || '—' }}</td>
                      <td class="num">{{ money(b.amount, b.currency) }}</td>
                    </tr>
                    <tr v-if="!curCamp.bills.length"><td colspan="5" class="empty-cell">还没登记账单</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h4>被剔除的「假增长」</h4>
              <div class="excl">
                <div class="ex-item">
                  <b>未确认销售</b><span>{{ curCamp.live_attribution.excluded.unconfirmed.cnt }} 单</span>
                  <div class="tiny muted">还在草稿/技术/财务，没排产，下单不等于卖掉</div>
                </div>
                <div class="ex-item">
                  <b>集团内部转单</b><span>{{ curCamp.live_attribution.excluded.internal.cnt }} 单</span>
                  <div class="tiny muted">
                    <template v-if="curCamp.live_attribution.excluded.internal.orders.length">
                      {{ curCamp.live_attribution.excluded.internal.orders.map((o) => o.order_no + '（' + (o.customer_name || '') + '）').join('、') }}
                    </template>
                    <template v-else>内部往来单位名单见集团合并模块</template>
                  </div>
                </div>
                <div class="ex-item">
                  <b>渠道对不上</b><span>{{ curCamp.live_attribution.excluded.channel.cnt }} 单</span>
                  <div class="tiny muted">店铺/渠道不是 {{ curCamp.live_attribution.match_key }}</div>
                </div>
                <div class="ex-item"><b>窗口外</b><span>{{ Math.max(0, curCamp.live_attribution.scanned - curCamp.live_attribution.counted_cnt - curCamp.live_attribution.excluded.unconfirmed.cnt - curCamp.live_attribution.excluded.internal.cnt - curCamp.live_attribution.excluded.channel.cnt) }} 单</span><div class="tiny muted">扫描了 {{ curCamp.live_attribution.scanned }} 单</div></div>
              </div>
              <p class="tiny muted" style="margin-top: 10px">
                ROAS = 归因收入 ÷ 实际花费（同币种）。本币毛利 {{ money(curCamp.live_attribution.gross_cny, 'CNY') }} 来自成本对象结转，
                <b>不等于净利润</b>（没摊营销以外费用与税）。
              </p>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button v-if="canWrite && ['approved','running'].includes(curCamp.status)" class="btn btn-ghost" @click="openBill(curCamp)">记账单</button>
          <button v-if="canWrite && curCamp.status === 'approved'" class="btn btn-primary" @click="campAdvance('running')">开始投放</button>
          <button v-if="canWrite && curCamp.status === 'running'" class="btn btn-primary" :disabled="!curCamp.bills.length" @click="campAdvance('billed')">账单登记完</button>
          <button v-if="canWrite && curCamp.status === 'billed'" class="btn btn-primary" @click="campAdvance('closed')">复核关闭</button>
          <button class="btn btn-ghost" @click="modal = ''">关闭</button>
        </div>
      </div>
    </div>

    <!-- ==================== 新建复盘 ==================== -->
    <div v-if="modal === 'review'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>登记复盘</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld wide"><span>主题 *</span><input v-model="revForm.topic" placeholder="如 MK-S002 断码，上新首周缺 M/L" /></label>
            <label class="fld"><span>期间</span><input v-model="revForm.period" type="month" /></label>
            <label class="fld"><span>原因分类 *</span>
              <select v-model="revForm.category"><option v-for="c in dict.review_category" :key="c.key" :value="c.key">{{ c.label }}</option></select>
            </label>
            <label class="fld"><span>主责</span><input v-model="revForm.owner" /></label>
            <label class="fld"><span>期限</span><input v-model="revForm.due_date" type="date" /></label>
            <label class="fld wide"><span>证据（单号/事件/工单）*</span><input v-model="revForm.evidence" placeholder="如 售后工单 SH-20261012-018，退货原因「颜色偏灰」" /></label>
            <label class="fld wide"><span>原因分析</span><textarea v-model="revForm.findings" rows="2" /></label>
          </div>
          <p class="tiny muted">登记后是草稿，要加至少 1 条「有负责人和期限」的行动项才能进入待行动。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitReview">创建</button>
        </div>
      </div>
    </div>

    <!-- 复盘详情 -->
    <div v-if="modal === 'revDetail' && curRev" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>{{ curRev.review_no }} · {{ curRev.topic }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="revTag(curRev.status)">{{ curRev.status_label }}</span>
            <span class="tag gray">{{ curRev.category_label }}</span>
            <span class="muted tiny">{{ curRev.period }} · 主责 {{ curRev.owner || '未指定' }} · 期限 {{ curRev.due_date || '—' }}</span>
          </div>
          <div class="kv">
            <div class="wide"><span>证据</span><b>{{ curRev.evidence || '—' }}</b></div>
            <div class="wide"><span>原因分析</span><b>{{ curRev.findings || '—' }}</b></div>
          </div>

          <h4>行动项<small>没写负责人和期限的不让加</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>行动</th><th>负责人</th><th>期限</th><th>状态</th><th>结果</th><th></th></tr></thead>
              <tbody>
                <tr v-for="a in curRev.actions" :key="a.id" :class="{ 'row-bad': a.is_overdue }">
                  <td>{{ a.action }}</td>
                  <td>{{ a.owner }}</td>
                  <td>{{ a.due_date }}<span v-if="a.is_overdue" class="tiny red"> 逾期</span></td>
                  <td>{{ actionLabel(a.status) }}</td>
                  <td class="tiny muted">{{ a.result || '—' }}</td>
                  <td>
                    <button v-if="canWrite && a.status !== 'done'" class="link-btn" @click="openActionDone(a)">完成</button>
                    <button v-if="canWrite && a.status === 'pending'" class="link-btn" @click="setAction(a, 'doing')">开始</button>
                  </td>
                </tr>
                <tr v-if="!curRev.actions.length"><td colspan="6" class="empty-cell">还没有行动项</td></tr>
              </tbody>
            </table>
          </div>

          <div v-if="canWrite && curRev.status !== 'done'" class="action-add">
            <input v-model="actionForm.action" class="input" placeholder="行动内容" />
            <input v-model="actionForm.owner" class="input" placeholder="负责人 *" />
            <input v-model="actionForm.due_date" class="input" type="date" />
            <button class="btn btn-sm btn-primary" @click="submitAction">加行动项</button>
          </div>
        </div>
        <div class="modal-foot">
          <button v-if="canWrite && curRev.status === 'draft'" class="btn btn-primary" @click="revAdvance('open')">立项（待行动）</button>
          <button v-if="canWrite && curRev.status === 'open'" class="btn btn-primary" @click="revAdvance('doing')">开始执行</button>
          <button v-if="canWrite && ['open','doing'].includes(curRev.status)" class="btn" :disabled="curRev.open_actions > 0" @click="revAdvance('done')">
            {{ curRev.open_actions > 0 ? '还有 ' + curRev.open_actions + ' 条未完成' : '关闭复盘' }}
          </button>
          <button class="btn btn-ghost" @click="modal = ''">关闭</button>
        </div>
      </div>
    </div>

    <!-- 行动完成 -->
    <div v-if="modal === 'actionDone'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>完成行动项</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="det-line">{{ actionTarget && actionTarget.action }}</p>
          <label class="fld"><span>结果 *</span><textarea v-model="actionResult" rows="3" placeholder="做了什么、效果如何" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" @click="doActionDone">确认完成</button>
        </div>
      </div>
    </div>

    <datalist id="mk-channels">
      <option v-for="c in dict.channels" :key="c" :value="c" />
    </datalist>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('cal');
const view = ref('cal');
const month = ref(new Date().toISOString().slice(0, 7));
const dict = ref({
  channels: [], companies: [], customers: [], task_status: [], asset_kind: [], asset_scope: [],
  asset_status: [], license_source: [], campaign_status: [], bill_source: [], review_status: [],
  review_category: [], currencies: ['CNY', 'USD'], today: ''
});
const ov = ref({});
const calTasks = ref([]);
const taskFilter = ref('');
const onlyOverdue = ref(false);

const assets = ref([]);
const assetFilter = ref({ kind: '', status: '', scope: '', expiring: '' });
const curAsset = ref(null);

const campaigns = ref([]);
const campFilter = ref({ status: '', currency: '' });
const curCamp = ref(null);
const campReport = ref({ currencies: [] });

const reviews = ref([]);
const revFilter = ref({ status: '', category: '' });
const curRev = ref(null);
const revReport = ref({ by_category: [], actions: null, reviews: [] });

const curTask = ref(null);
const modal = ref('');
const saving = ref(false);
const stepName = ref('');
const bindAssetId = ref(null);
const blockerText = ref(null);

const taskForm = ref({});
const assetForm = ref({});
const campForm = ref({});
const billForm = ref({});
const revForm = ref({});
const actionForm = ref({ action: '', owner: '', due_date: '' });
const actionTarget = ref(null);
const actionResult = ref('');
const reviewTarget = ref(null);
const reviewMode = ref('review');
const reviewNote = ref('');

const canWrite = computed(() => can('mkt.write'));
const canApprove = computed(() => can('mkt.review'));

const money = (v, cur = 'CNY') => {
  const n = Number(v) || 0;
  const s = n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cur === 'USD' ? '$' : '¥') + s;
};
const st = (k) => (ov.value.by_status && ov.value.by_status[k]) || 0;
const rvCount = (k) => (reviews.value || []).filter((r) => r.status === k).length;
const campByCur = computed(() => (campReport.value.currencies || []).slice(0, 2));

const labelOf = (s) => {
  const m = { draft: '待资料', material: '素材筹备', ready: '资料确认', launched: '已上新', reviewed: '已复盘', cancelled: '已取消' };
  return m[s] || s;
};
const actionLabel = (s) => ({ pending: '未开始', doing: '进行中', done: '已完成', cancelled: '已取消' }[s] || s);
const statusTag = (s) => ({ draft: 'gray', material: 'blue', ready: 'purple', launched: 'green', reviewed: 'gray', cancelled: 'gray' }[s] || 'gray');
const assetTag = (s) => ({ draft: 'gray', pending: 'orange', approved: 'green', expired: 'red', revoked: 'red' }[s] || 'gray');
const campTag = (s) => ({ draft: 'gray', approved: 'blue', running: 'green', billed: 'orange', closed: 'gray', cancelled: 'gray' }[s] || 'gray');
const revTag = (s) => ({ draft: 'gray', open: 'orange', doing: 'blue', done: 'green' }[s] || 'gray');
const chipClass = (t) => {
  if (t.is_overdue) return 'ch-red';
  return ({ draft: 'ch-gray', material: 'ch-blue', ready: 'ch-purple', launched: 'ch-green', reviewed: 'ch-green', cancelled: 'ch-gray' }[t.status] || 'ch-gray');
};

/** ---------- 数据加载 ---------- */
async function loadOv() {
  ov.value = await api.mktOverview();
  // 概览里的键名与卡片的对应
  ov.value.asset_total = ov.value.assets ? ov.value.assets.total : 0;
  ov.value.approved = ov.value.assets ? ov.value.assets.approved : 0;
  ov.value.pending = ov.value.assets ? ov.value.assets.pending : 0;
  ov.value.expiring_30d = ov.value.assets ? ov.value.assets.expiring_30d : 0;
  ov.value.expired = ov.value.assets ? ov.value.assets.expired : 0;
  ov.value.exclusive = ov.value.assets ? ov.value.assets.exclusive : 0;
  ov.value.by_status = ov.value.tasks ? ov.value.tasks.by_status : {};
  ov.value.launched = ov.value.tasks ? ov.value.tasks.launched : 0;
  ov.value.on_time = ov.value.tasks ? ov.value.tasks.on_time : 0;
  ov.value.overdue = ov.value.tasks ? ov.value.tasks.overdue : 0;
  ov.value.due_soon_7d = ov.value.tasks ? ov.value.tasks.due_soon_7d : 0;
  ov.value.launch_rate = ov.value.tasks ? ov.value.tasks.launch_rate : null;
  ov.value.over_budget = ov.value.campaigns ? ov.value.campaigns.over_budget : 0;
  ov.value.camp_running = ov.value.campaigns ? ov.value.campaigns.running : 0;
  ov.value.overdue_actions = ov.value.reviews ? ov.value.reviews.overdue_actions : 0;
  ov.value.review_total = ov.value.reviews ? ov.value.reviews.total : 0;
}

async function loadTasks() {
  // 日历按月看；列表要能看全部，否则「下月才上线」的任务在列表里像丢了
  calTasks.value = await api.mktTasks({
    month: view.value === 'cal' ? month.value : '',
    status: taskFilter.value,
    overdue: onlyOverdue.value ? 1 : ''
  });
}
const loadCal = () => loadTasks();

async function loadAssets() {
  assets.value = await api.mktAssets({
    kind: assetFilter.value.kind,
    status: assetFilter.value.status,
    scope: assetFilter.value.scope,
    expiring: assetFilter.value.expiring
  });
}
async function loadCamps() {
  campaigns.value = await api.mktCampaigns({ status: campFilter.value.status, currency: campFilter.value.currency });
  campReport.value = await api.mktReportCampaign();
}
async function loadReviews() {
  reviews.value = await api.mktReviews({ status: revFilter.value.status, category: revFilter.value.category });
  revReport.value = await api.mktReportReview();
}
async function reloadAll() {
  await loadOv();
  if (tab.value === 'cal') await loadTasks();
  if (tab.value === 'asset') await loadAssets();
  if (tab.value === 'camp') await loadCamps();
  if (tab.value === 'rev') await loadReviews();
}
function go(t) {
  tab.value = t;
  if (t === 'cal') loadTasks();
  if (t === 'asset') loadAssets();
  if (t === 'camp') loadCamps();
  if (t === 'rev') loadReviews();
}

/** 日历格子：周一起，铺满整月 */
// 日历与列表的取数范围不同（日历按月、列表看全部），切换视图必须重新取
watch(view, () => loadTasks());

const calCells = computed(() => {
  const [y, m] = month.value.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ date: '', tasks: [] });
  for (let d = 1; d <= days; d++) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ date, tasks: calTasks.value.filter((t) => t.plan_launch_date === date) });
  }
  while (cells.length % 7 !== 0) cells.push({ date: '', tasks: [] });
  return cells;
});

/** 绑定素材候选：后端还会再校验一次，这里只是减少误选 */
const bindableAssets = computed(() => {
  const t = curTask.value;
  if (!t) return [];
  return assets.value.filter((a) => {
    if (a.status !== 'approved') return false;
    if (t.assets && t.assets.some((x) => x.id === a.id)) return false;
    if (a.scope === 'exclusive') return Number(a.customer_id || 0) === Number(t.customer_id || 0);
    if (a.scope === 'channel') return !a.channel_list.length || a.channel_list.includes(t.channel);
    return true;
  });
});

/** ---------- 任务 ---------- */
function openTask() {
  taskForm.value = {
    title: '', biz_type: 'stock', style_no: '', product_name: '', channel: '', shop_name: '',
    customer_id: null, plan_launch_date: '', owner: '', campaign_id: null, depends: ''
  };
  if (!campaigns.value.length) loadCamps();
  modal.value = 'task';
}
async function submitTask() {
  saving.value = true;
  try {
    await api.createMktTask(taskForm.value);
    modal.value = '';
    await Promise.all([loadTasks(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openTaskDetail(id) {
  curTask.value = await api.mktTask(id);
  blockerText.value = curTask.value.blocker || '';
  stepName.value = '';
  bindAssetId.value = null;
  if (!assets.value.length) await loadAssets();
  modal.value = 'taskDetail';
}
async function advance(to) {
  let note = '';
  if (to !== 'launched' && to !== 'reviewed') {
    note = prompt(`推进到「${labelOf(to)}」，写个原因（退回时必填）：`) || '';
  }
  try {
    curTask.value = await api.mktTaskStatus(curTask.value.id, { to, note });
    // 卡点顺手存一下
    if (blockerText.value !== (curTask.value.blocker || '')) {
      await api.updateMktTask(curTask.value.id, { blocker: blockerText.value });
      curTask.value = await api.mktTask(curTask.value.id);
    }
    await Promise.all([loadTasks(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function finishStep(s) {
  try {
    await api.setMktStep(curTask.value.id, s.id, { status: 'done' });
    curTask.value = await api.mktTask(curTask.value.id);
  } catch (e) { alert(e.message); }
}
async function addStep() {
  if (!stepName.value.trim()) return;
  try {
    await api.addMktStep(curTask.value.id, { name: stepName.value.trim() });
    stepName.value = '';
    curTask.value = await api.mktTask(curTask.value.id);
  } catch (e) { alert(e.message); }
}
async function doBind() {
  try {
    curTask.value = await api.bindMktAsset(curTask.value.id, { asset_id: bindAssetId.value });
    bindAssetId.value = null;
    await Promise.all([loadTasks(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function unbind(a) {
  if (!confirm(`解绑素材 ${a.title}？`)) return;
  try {
    curTask.value = await api.unbindMktAsset(curTask.value.id, a.id);
    await Promise.all([loadTasks(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/** ---------- 素材 ---------- */
function openAsset() {
  assetForm.value = {
    title: '', kind: 'image', version: '', style_no: '', tech_version: '',
    license_source: 'own', scope: 'channel', customer_id: null, channels: '',
    license_from: dict.value.today, license_to: '', url: ''
  };
  modal.value = 'asset';
}
async function submitAssetForm() {
  saving.value = true;
  try {
    await api.createMktAsset(assetForm.value);
    modal.value = '';
    await Promise.all([loadAssets(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function submitAsset(a) {
  try {
    await api.submitMktAsset(a.id);
    await Promise.all([loadAssets(), loadOv()]);
  } catch (e) { alert(e.message); }
}
function openReviewAsset(a) {
  reviewTarget.value = a;
  reviewMode.value = 'review';
  reviewNote.value = '';
  modal.value = 'assetReview';
}
function openRevokeAsset(a) {
  reviewTarget.value = a;
  reviewMode.value = 'revoke';
  reviewNote.value = '';
  modal.value = 'assetReview';
}
async function doReview(pass) {
  try {
    await api.reviewMktAsset(reviewTarget.value.id, { pass, note: reviewNote.value });
    modal.value = '';
    await Promise.all([loadAssets(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doRevoke() {
  try {
    await api.revokeMktAsset(reviewTarget.value.id, { note: reviewNote.value });
    modal.value = '';
    await Promise.all([loadAssets(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function openAssetDetail(id) {
  curAsset.value = await api.mktAsset(id);
  modal.value = 'assetDetail';
}
async function sweep() {
  try {
    const r = await api.sweepMktAssets();
    alert(`已把 ${r.swept} 个到期素材置为过期${r.assets && r.assets.length ? '：' + r.assets.join('、') : ''}`);
    await Promise.all([loadAssets(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/** ---------- 活动 ---------- */
function openCamp() {
  campForm.value = {
    name: '', channel: '', shop_name: '', currency: 'CNY', budget_amount: 0,
    start_date: dict.value.today, end_date: '', attribution_days: 7, owner: '', note: ''
  };
  modal.value = 'camp';
}
async function submitCamp() {
  saving.value = true;
  try {
    await api.createMktCampaign(campForm.value);
    modal.value = '';
    await Promise.all([loadCamps(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function approveCamp(c) {
  if (!confirm(`批准「${c.name}」预算 ${money(c.budget_amount, c.currency)}？`)) return;
  try {
    await api.approveMktCampaign(c.id, {});
    await Promise.all([loadCamps(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function openCampDetail(id) {
  curCamp.value = await api.mktCampaign(id);
  modal.value = 'campDetail';
}
function openBill(c) {
  curCamp.value = c;
  billForm.value = {
    bill_date: dict.value.today, amount: 0, currency: c.currency, vendor: '', ref_no: '', source: 'ads'
  };
  modal.value = 'bill';
}
async function submitBill() {
  saving.value = true;
  try {
    curCamp.value = await api.addMktBill(curCamp.value.id, billForm.value);
    modal.value = 'campDetail';
    await Promise.all([loadCamps(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function campAdvance(to) {
  let note = '';
  if (to === 'closed') note = prompt('复核关闭，写点结论（超预算必填）：') || '';
  try {
    curCamp.value = await api.mktCampaignStatus(curCamp.value.id, { to, note });
    await Promise.all([loadCamps(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/** ---------- 复盘 ---------- */
function openReview() {
  revForm.value = {
    topic: '', period: dict.value.today.slice(0, 7), category: 'shortage',
    evidence: '', owner: '', due_date: '', findings: ''
  };
  modal.value = 'review';
}
async function submitReview() {
  saving.value = true;
  try {
    await api.createMktReview(revForm.value);
    modal.value = '';
    await Promise.all([loadReviews(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openRevDetail(id) {
  curRev.value = await api.mktReview(id);
  actionForm.value = { action: '', owner: '', due_date: '' };
  modal.value = 'revDetail';
}
async function submitAction() {
  try {
    curRev.value = await api.addMktAction(curRev.value.id, actionForm.value);
    actionForm.value = { action: '', owner: '', due_date: '' };
    await Promise.all([loadReviews(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function setAction(a, status) {
  try {
    curRev.value = await api.setMktAction(curRev.value.id, a.id, { status });
    await loadReviews();
  } catch (e) { alert(e.message); }
}
function openActionDone(a) {
  actionTarget.value = a;
  actionResult.value = '';
  modal.value = 'actionDone';
}
async function doActionDone() {
  try {
    curRev.value = await api.setMktAction(curRev.value.id, actionTarget.value.id, { status: 'done', result: actionResult.value });
    modal.value = 'revDetail';
    await Promise.all([loadReviews(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function revAdvance(to) {
  try {
    curRev.value = await api.mktReviewStatus(curRev.value.id, { to });
    await Promise.all([loadReviews(), loadOv()]);
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  dict.value = await api.mktDict();
  await loadOv();
  await loadTasks();
});
</script>

<style scoped>
.page { max-width: 1500px; }
.head-ops { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; flex: none; max-width: 480px; justify-content: flex-end; }
.head-ops .btn { white-space: nowrap; }
.head-ops input[type='month'] { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }

.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { font-size: 12px; color: var(--ink-mute); display: block; }
.stat strong { font-size: 22px; color: #16305f; display: block; margin-top: 4px; line-height: 1.1; }
.stat strong i { font-size: 13px; font-style: normal; }
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

.toolbar select, .toolbar .input { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; }
.chk { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--ink-soft); }
.spacer { flex: 1; }
.pill { display: inline-block; white-space: nowrap; font-size: 12px; font-weight: 700; border-radius: 6px; padding: 4px 9px; }
.p-gray { background: #eef1f6; color: var(--ink-soft); }
.tiny { font-size: 12px; }
.nowrap { white-space: nowrap; }
.muted { color: var(--ink-mute); }
.red { color: #d92d45; }
.green { color: #16a34a; }
.orange { color: #d97706; }
.lnk { color: var(--brand); cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: none; background: var(--surface); padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: inherit; color: var(--ink-soft); }
.seg button.on { background: #eef4ff; color: var(--brand); font-weight: 700; }
.empty-box { grid-column: 1/-1; text-align: center; color: #9aa4b5; padding: 34px 0; font-size: 13px; }

/* 日历 */
.cal { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 14px; overflow: hidden; }
.cal-head { display: grid; grid-template-columns: repeat(7, 1fr); background: var(--surface-2); border-bottom: 1px solid #e6ebf3; }
.cal-head span { padding: 10px 12px; font-size: 12px; font-weight: 700; color: #5b6474; text-align: center; }
.cal-body { display: grid; grid-template-columns: repeat(7, 1fr); }
.cal-cell { min-height: 96px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 6px 7px; }
.cal-cell:nth-child(7n) { border-right: none; }
.cal-cell.out { background: var(--surface-2); }
.cal-cell.today { background: #f4f8ff; box-shadow: inset 0 0 0 2px #cfe0ff; }
.cal-day { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.cal-day span { font-size: 12px; font-weight: 700; color: #5b6474; }
.cal-day em { font-size: 12px; color: var(--brand); font-style: normal; font-weight: 700; }
.cal-chip {
  border-radius: 6px; padding: 3px 6px; margin-bottom: 3px; cursor: pointer; font-size: 12px;
  display: flex; flex-direction: column; overflow: hidden;
}
.cal-chip b { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-chip i { font-style: normal; font-size: 12px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ch-gray { background: #eef1f6; color: #5b6474; }
.ch-blue { background: #e8f0ff; color: var(--brand); }
.ch-purple { background: #f0eaff; color: #7c3aed; }
.ch-green { background: #e6f7ec; color: #16a34a; }
.ch-red { background: #fdecee; color: #d92d45; }
.cal-legend { display: flex; gap: 16px; padding: 10px 14px; font-size: 12px; color: var(--ink-soft); flex-wrap: wrap; }
.cal-legend .lg { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; }
.lg-gray { background: #eef1f6; } .lg-blue { background: #e8f0ff; } .lg-purple { background: #f0eaff; }
.lg-green { background: #e6f7ec; } .lg-red { background: #fdecee; }

/* 素材卡 */
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
.asset-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.asset-card.dead { background: #fcfcfd; border-style: dashed; }
.ac-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ac-top .spacer { flex: 1; }
.asset-card h5 { margin: 0; font-size: 14px; color: var(--ink); }
.ac-meta { font-size: 12px; color: var(--ink-mute); display: flex; gap: 10px; flex-wrap: wrap; }
.ac-lic { font-size: 12px; color: var(--ink); display: flex; flex-direction: column; gap: 3px; border-top: 1px dashed var(--line); padding-top: 8px; }
.ac-lic .muted { display: inline-block; width: 68px; }
.ac-ops { display: flex; gap: 4px; flex-wrap: wrap; border-top: 1px dashed var(--line); padding-top: 6px; }
.ac-note { font-size: 12px; color: var(--ink-mute); background: #f8fafd; border-radius: 6px; padding: 6px 8px; }
.link-btn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.link-btn.danger { color: #d92d45; }
.btn-danger { background: #d92d45; border-color: #d92d45; color: #fff; }

/* 活动 */
.bar { height: 6px; background: #eef2f7; border-radius: 4px; overflow: hidden; min-width: 60px; }
.bar i { display: block; height: 100%; }
.bar-ok { background: var(--brand); }
.bar-bad { background: #d92d45; }
.cur-grid, .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.cur-card, .cat-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px; }
.cc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.cc-head b { font-size: 15px; color: var(--ink); }
.cc-row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 3px 0; color: var(--ink); }
.cc-row b { font-variant-numeric: tabular-nums; }
.cc-foot { font-size: 12px; color: #9aa4b5; margin-top: 8px; border-top: 1px dashed var(--line); padding-top: 6px; }
.hint-bar { background: #f2f7ff; border: 1px solid #d6e4ff; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; color: var(--ink); margin-bottom: 12px; line-height: 1.7; }
.hint-bar b { color: #16305f; }

/* 复盘卡 */
.rev-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
.rev-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px; }
.rev-card.rc-bad { border-color: #f3c2c9; }
.rc-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rc-top .spacer { flex: 1; }
.rev-card h5 { margin: 8px 0 6px; font-size: 14px; color: var(--ink); }
.rc-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--ink-mute); margin-bottom: 8px; }
.rc-prog { display: flex; align-items: center; gap: 8px; }
.rc-prog .spacer { flex: 1; }

/* 弹窗内 */
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-grid .wide { grid-column: 1/-1; }
.fld { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--ink-soft); }
.fld > span { font-weight: 600; }
.fld input, .fld select, .fld textarea, .input {
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px;
  font-family: inherit; width: 100%; box-sizing: border-box; background: var(--surface);
}
.form-grid .wide span { display: block; }
.det-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.det-line { margin: 0 0 8px; font-size: 13.5px; color: var(--ink); }
.gate-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 6px; }
.gate { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; }
.gate-ok { background: #f6fdf9; border-color: #c6ecd5; }
.gate-bad { background: #fffafa; border-color: #f3c2c9; }
.gate-na { background: var(--surface-2); border-style: dashed; }
.g-head { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ink); }
.g-head span { font-weight: 700; }
.gate-ok .g-head span { color: #16a34a; }
.gate-bad .g-head span { color: #d92d45; }
.gate-na .g-head span { color: #9aa4b5; }
.g-detail { font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 12px; }
.two-col h4, .modal-body h4 { font-size: 13px; color: var(--ink); margin: 0 0 8px; }
.two-col h4 small, .modal-body h4 small { font-weight: 400; color: #9aa4b5; margin-left: 6px; font-size: 12px; }
.step-list { display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; align-items: center; gap: 8px; padding: 7px 9px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; }
.step.done { background: #f6fdf9; border-color: #d8f0e2; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; background: #c7d2e3; flex: none; }
.step.done .st-dot { background: #16a34a; }
.st-body { flex: 1; min-width: 0; }
.st-body b { font-size: 12.5px; color: var(--ink); font-weight: 600; }
.step-add, .bind-add, .action-add { display: flex; gap: 8px; margin-top: 8px; }
.step-add .input, .bind-add select { flex: 1; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 12.5px; font-family: inherit; }
.action-add .input { flex: 1; }
.log-list { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
.log { display: flex; gap: 8px; font-size: 12px; color: var(--ink); align-items: baseline; }
.log .tiny { flex: none; width: 130px; }
.bound-list { display: flex; flex-direction: column; gap: 6px; }
.bound { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.bound.blocked { border-color: #f3c2c9; background: #fffafa; }
.bound > div { flex: 1; min-width: 0; }
.bound b { font-size: 12.5px; color: var(--ink); }
.blocker-box { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 10px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; margin-bottom: 12px; }
.kv > div { display: flex; gap: 10px; font-size: 12.5px; border-bottom: 1px dashed #f0f3f8; padding-bottom: 5px; }
.kv > div.wide { grid-column: 1/-1; }
.kv span { color: var(--ink-mute); width: 96px; flex: none; }
.kv b { color: var(--ink); font-weight: 600; }
.excl { display: flex; flex-direction: column; gap: 8px; }
.ex-item { border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; background: var(--surface-2); }
.ex-item b { font-size: 12.5px; color: var(--ink); margin-right: 8px; }
.ex-item > span { font-size: 13px; font-weight: 700; color: #d92d45; }
.row-bad { background: #fffafa; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .form-grid, .two-col, .gate-row, .kv { grid-template-columns: 1fr; }
  .asset-grid, .rev-list, .cur-grid, .cat-grid { grid-template-columns: 1fr; }
  .cal { overflow-x: auto; }
  .cal-head, .cal-body { min-width: 720px; }
  .page-head { flex-direction: column; align-items: flex-start; }
}
</style>
