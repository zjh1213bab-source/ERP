<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>客户营销与消息</h2>
        <p class="sub">
          一个业务事件只产生<b>一条事件</b>，按订阅拆成多条<b>发送计划</b>；事件与发送<b>两层各自去重</b>。
          上新/到货提醒只在<b>发布审核通过 + 可售 &gt; 0</b> 后触发，且只发给订阅了该款号的客户。
          渠道不可用就<b>降级</b>（微信 → 站内 → 邮件），系统<b>不会声称已通过微信发出</b>。
          回执分「已提交 / 已送达 / 已读」，<b>打开邮件不算已读，更不算成交</b>。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>待发送</span><strong>{{ ov.outbox ? ov.outbox.queued : 0 }}</strong><small>已生成未提交</small></div>
      <div class="stat" :class="ov.outbox && ov.outbox.held ? 'st-warn' : ''"><span>频控暂缓</span><strong>{{ ov.outbox ? ov.outbox.held : 0 }}</strong><small>静默时段 / 超上限</small></div>
      <div class="stat"><span>已送达</span><strong>{{ ov.outbox ? ov.outbox.delivered : 0 }}</strong><small>含已读</small></div>
      <div class="stat"><span>已读</span><strong>{{ ov.outbox ? ov.outbox.read : 0 }}</strong><small>只认 read 回执</small></div>
      <div class="stat" :class="ov.outbox && ov.outbox.failed ? 'st-bad' : ''"><span>发送失败</span><strong>{{ ov.outbox ? ov.outbox.failed : 0 }}</strong><small>有限重试，超限转人工</small></div>
      <div class="stat"><span>今日发送</span><strong>{{ ov.outbox ? ov.outbox.today : 0 }}</strong><small>不含暂缓与跳过</small></div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'over' }" @click="go('over')">概览与渠道</button>
        <button :class="{ on: tab === 'subs' }" @click="go('subs')">订阅与频控</button>
        <button :class="{ on: tab === 'tpl' }" @click="go('tpl')">消息模板</button>
        <button :class="{ on: tab === 'box' }" @click="go('box')">发送与回执
          <span v-if="ov.outbox && ov.outbox.queued" class="tab-dot">{{ ov.outbox.queued }}</span>
        </button>
        <button :class="{ on: tab === 'alert' }" @click="go('alert')">到货提醒
          <span v-if="ov.alerts && ov.alerts.waiting" class="tab-dot">{{ ov.alerts.waiting }}</span>
        </button>
        <button :class="{ on: tab === 'attr' }" @click="go('attr')">效果归因</button>
      </div>
    </div>

    <!-- ==================== 一、概览与渠道 ==================== -->
    <div v-if="tab === 'over'" class="block">
      <div class="hint-bar">
        <b>渠道能力必须可验证</b>：站内是系统自带；邮件要过发信域验收；微信要有公众号授权与模板消息。
        没有依据的渠道一律按「未授权」，消息<b>降级到站内</b>，并记下 <b>degraded_from</b> —— 谁都能看出这条本来想走微信。
      </div>

      <div class="cap-grid">
        <div v-for="c in channels" :key="c.channel" class="cap-card" :class="c.usable ? 'cap-ok' : 'cap-no'">
          <div class="cap-top">
            <b>{{ c.channel_label }}</b>
            <span class="tag" :class="c.usable ? 'green' : 'red'">{{ c.usable ? '可用' : (c.status === 'disabled' ? '已停用' : '未授权') }}</span>
          </div>
          <div class="cap-line"><span>核验</span>{{ c.verify_status === 'verified' ? '已核验' : '未核验' }}</div>
          <div class="cap-line"><span>依据</span>{{ c.evidence || '—' }}</div>
          <div class="cap-line" v-if="c.reason"><span>原因</span>{{ c.reason }}</div>
          <div class="cap-line" v-if="c.channel === 'wechat'"><span>绑定</span>{{ c.bindings || 0 }} 位客户关注中</div>
          <button v-if="canApprove && c.channel !== 'site'" class="btn btn-ghost btn-sm cap-btn" @click="openCap(c)">设置</button>
        </div>
      </div>

      <div class="note-box" v-if="!ov.wechat_ready">
        <b>微信渠道当前不可用</b>：所有订阅了微信的客户，消息都会自动改走站内（有订阅时），
        页面不会显示「已通过微信发送」。要做真微信，需要先完成公众号认证与模板消息授权，再把渠道置为可用。
      </div>

      <h4 class="sec">订阅概况<small>退订营销只关营销，订单/服务/上新到货照常</small></h4>
      <div class="mini-grid">
        <div class="mini"><span>有订阅记录的客户</span><b>{{ (ov.subs && ov.subs.customers) || 0 }}</b></div>
        <div class="mini"><span>生效中的订阅</span><b>{{ (ov.subs && ov.subs.subscribed) || 0 }}</b></div>
        <div class="mini"><span>已退订营销</span><b>{{ (ov.subs && ov.subs.marketing_off) || 0 }}</b></div>
        <div class="mini" :class="ov.subs && ov.subs.email_unverified ? 'mini-warn' : ''"><span>订阅了邮件但未核验</span><b>{{ (ov.subs && ov.subs.email_unverified) || 0 }}</b></div>
      </div>

      <h4 class="sec">消息规则<small>下面这些不是提示文案，是代码里挡住的</small></h4>
      <ul class="rule-list">
        <li v-for="(n, i) in (ov.notes || [])" :key="i">{{ n }}</li>
      </ul>
    </div>

    <!-- ==================== 二、订阅与频控 ==================== -->
    <div v-if="tab === 'subs'" class="block">
      <div class="hint-bar">
        <b>订单通知与营销订阅分开授权</b>：退订营销<b>只关 marketing</b>，不影响订单、服务、上新到货。
        退订是<b>改状态不删行</b> —— 删了就没有「他什么时候退的、为什么退」的记录。
        邮箱订阅必须<b>核验通过</b>才算可用；未核验的邮件会在发送时降级到站内。
      </div>

      <h4 class="sec">发送频控<small>只作用于营销；业务通知不受营销频控限制</small></h4>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>范围</th><th>客户</th><th class="num">每日上限</th><th class="num">每周上限</th>
              <th class="num">最小间隔</th><th>静默时段（客户当地时间）</th><th class="num">摘要时点</th><th>说明</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rules" :key="r.id">
              <td class="nowrap"><span class="tag" :class="r.scope === 'global' ? 'blue' : 'purple'">{{ r.scope_label }}</span></td>
              <td class="tiny">{{ r.customer_id ? ('客户#' + r.customer_id) : '全部客户' }}</td>
              <td class="num">{{ r.max_per_day }}</td>
              <td class="num">{{ r.max_per_week }}</td>
              <td class="num tiny">{{ r.min_gap_minutes ? r.min_gap_minutes + ' 分钟' : '不限' }}</td>
              <td class="tiny nowrap">{{ r.quiet_start }} – {{ r.quiet_end }}</td>
              <td class="num tiny">{{ r.digest_hour }}:00</td>
              <td class="tiny muted">{{ r.note || '—' }}</td>
              <td><button v-action="['notify','edit']"  v-if="canApprove" class="link-btn" @click="openFreq(r)">编辑</button></td>
            </tr>
            <tr v-if="!rules.length"><td colspan="9" class="empty-cell">还没有频控规则</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec">订阅明细<small>客户 × 主题 × 渠道</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <input v-model="sf.q" class="kw" placeholder="客户名 / 编码" @keyup.enter="loadSubs" />
        <select v-model="sf.topic" @change="loadSubs">
          <option value="">全部主题</option>
          <option v-for="t in dict.topics || []" :key="t.k" :value="t.k">{{ t.v }}</option>
        </select>
        <select v-model="sf.channel" @change="loadSubs">
          <option value="">全部渠道</option>
          <option v-for="c in dict.channels || []" :key="c.k" :value="c.k">{{ c.v }}</option>
        </select>
        <select v-model="sf.status" @change="loadSubs">
          <option value="">全部状态</option>
          <option v-for="s in dict.sub_status || []" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <div class="spacer"></div>
        <button v-action="['notify','create']"  v-if="canWrite" class="btn btn-primary btn-sm" @click="openSub()">＋ 新增订阅</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>客户</th><th>主题</th><th>渠道</th><th>状态</th><th>邮箱核验</th><th>时区 / 频率</th>
              <th>订阅来源</th><th>退订时间与原因</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="s in subs" :key="s.id">
              <td class="tiny"><b>{{ s.customer_name }}</b><div class="muted mono">{{ s.customer_code }}</div></td>
              <td class="tiny nowrap">{{ s.topic_label }}</td>
              <td class="tiny nowrap">{{ s.channel_label }}</td>
              <td><span class="tag" :class="s.status === 'subscribed' ? 'green' : (s.status === 'unsubscribed' ? 'gray' : 'orange')">{{ s.status_label }}</span>
                <span v-if="!s.usable && s.status === 'subscribed'" class="tag red" style="margin-left: 4px">不可用</span></td>
              <td class="tiny" :class="{ orange: s.verify_status !== 'verified' }">{{ s.channel === 'email' ? s.verify_label : '—' }}</td>
              <td class="tiny nowrap">{{ s.timezone }}<div class="muted">{{ s.frequency }}</div></td>
              <td class="tiny">{{ s.opt_in_source || '—' }}</td>
              <td class="tiny muted wrap">{{ s.opt_out_at ? (s.opt_out_at + ' · ' + (s.opt_out_reason || '')) : '—' }}</td>
              <td class="nowrap">
                <button v-if="canWrite && s.channel === 'email' && s.status === 'subscribed' && s.verify_status !== 'verified'" class="link-btn" @click="askVerify(s)">核验</button>
                <button v-if="canWrite && s.topic === 'marketing' && s.status === 'subscribed'" class="link-btn danger" @click="unsubMarketing(s)">退订营销</button>
                <button v-if="canWrite && s.status === 'unsubscribed'" class="link-btn" @click="resub(s)">重新订阅</button>
              </td>
            </tr>
            <tr v-if="!subs.length"><td colspan="9" class="empty-cell">没有订阅记录</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec">微信绑定<small>绑定不等于可用：渠道未授权时一律降级</small></h4>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>客户</th><th>openid</th><th>关注状态</th><th>模板</th><th>最近同步</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="w in bindings" :key="w.id">
              <td class="tiny">{{ w.customer_name }}<div class="muted mono">{{ w.customer_code }}</div></td>
              <td class="tiny mono">{{ w.openid }}</td>
              <td><span class="tag" :class="w.subscribe_status === 'subscribed' ? 'green' : 'gray'">{{ w.subscribe_status === 'subscribed' ? '已关注' : (w.subscribe_status === 'unsubscribed' ? '已取关' : '未知') }}</span></td>
              <td class="tiny">{{ (w.template_ids || []).length }} 个</td>
              <td class="tiny mono">{{ w.last_sync_at || '—' }}</td>
              <td class="tiny muted">{{ w.note || '—' }}</td>
            </tr>
            <tr v-if="!bindings.length"><td colspan="6" class="empty-cell">还没有微信绑定</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、消息模板 ==================== -->
    <div v-if="tab === 'tpl'" class="block">
      <div class="hint-bar">
        模板按<b>事件 × 渠道 × 语言</b>分版本，同一组合<b>同时只能有一条生效</b>。改文案不是改原记录，而是
        <b>出新版本并把旧的标停用</b> —— 否则历史消息回看时对不上当时发的是什么。
        <b>制单人不能自己批准</b>；模板里必须有变量，否则发给谁都是同一句话。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="tf.event_key" @change="loadTpl">
          <option value="">全部事件</option>
          <option v-for="e in dict.events || []" :key="e.k" :value="e.k">{{ e.v }}</option>
        </select>
        <select v-model="tf.channel" @change="loadTpl">
          <option value="">全部渠道</option>
          <option v-for="c in dict.channels || []" :key="c.k" :value="c.k">{{ c.v }}</option>
        </select>
        <select v-model="tf.status" @change="loadTpl">
          <option value="">全部状态</option>
          <option v-for="s in dict.template_status || []" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <div class="spacer"></div>
        <button v-action="['notify','create']" v-if="canWrite" class="btn btn-primary btn-sm" @click="openTpl()">＋ 新建模板</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>模板号</th><th>事件</th><th>渠道</th><th>语言</th><th class="num">版本</th><th>状态</th>
              <th>标题</th><th>变量</th><th>批准</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tpls" :key="t.id">
              <td class="tiny mono nowrap">{{ t.template_no }}</td>
              <td class="tiny nowrap">{{ t.event_label }}</td>
              <td class="tiny nowrap">{{ t.channel_label }}</td>
              <td class="tiny">{{ t.lang === 'en' ? '英文' : '中文' }}</td>
              <td class="num tiny">V{{ t.version }}</td>
              <td><span class="tag" :class="{ approved: 'green', pending: 'orange', draft: 'gray', retired: 'red' }[t.status]">{{ t.status_label }}</span></td>
              <td class="tiny wrap">{{ t.subject }}</td>
              <td class="tiny muted nowrap">{{ (t.variables || []).join(' ') || '—' }}</td>
              <td class="tiny muted">{{ t.approved_by || '—' }}<div>{{ t.approved_at || '' }}</div></td>
              <td class="nowrap">
                <button class="link-btn" @click="openTplDetail(t.id)">查看</button>
                <button v-if="canWrite && t.status === 'draft'" class="link-btn" @click="submitTpl(t)">提交审核</button>
                <button v-if="canApprove && t.status === 'pending'" class="link-btn" @click="approveTpl(t)">批准</button>
                <button  v-if="canApprove && t.status === 'approved'" class="link-btn danger" @click="retireTpl(t)">停用</button>
                <button v-action="['notify','delete']" v-if="isAdmin && ['draft','pending'].includes(t.status)" class="link-btn danger" @click="deleteTpl(t)">删除</button>
              </td>
            </tr>
            <tr v-if="!tpls.length"><td colspan="10" class="empty-cell">没有模板</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 四、发送与回执 ==================== -->
    <div v-if="tab === 'box'" class="block">
      <div class="hint-bar">
        状态只往前走：<b>待发送 → 已提交 → 已送达 → 已读</b>。站内消息投递即送达；
        邮件与微信要等渠道回执。<b>没收到送达回执就报已读会被拒</b>（未知不算已读）。
        失败默认重试 3 次，仍失败就停在失败、转人工 —— <b>渠道失败不回滚任何订单</b>。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="of.status" @change="loadBox">
          <option value="">全部状态</option>
          <option v-for="s in dict.outbox_status || []" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <select v-model="of.channel" @change="loadBox">
          <option value="">全部渠道</option>
          <option v-for="c in dict.channels || []" :key="c.k" :value="c.k">{{ c.v }}</option>
        </select>
        <select v-model="of.event_key" @change="loadBox">
          <option value="">全部事件</option>
          <option v-for="e in dict.events || []" :key="e.k" :value="e.k">{{ e.v }}</option>
        </select>
        <div class="spacer"></div>
        <span class="muted tiny">共 {{ box.length }} 条</span>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="doDispatch">派发待发送</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>发送号</th><th>客户</th><th>事件</th><th>主题</th><th>渠道</th><th>状态</th>
              <th class="num">尝试</th><th>发送时间</th><th>回执</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="o in box" :key="o.id" :class="{ 'row-bad': o.status === 'failed', 'row-warn': o.status === 'held' || o.status === 'skipped' }">
              <td class="tiny mono nowrap"><a class="lnk" @click="openBox(o.id)">{{ o.outbox_no }}</a></td>
              <td class="tiny">{{ o.customer_name }}<div class="muted mono">{{ o.customer_code }}</div></td>
              <td class="tiny nowrap">{{ o.event_label }}</td>
              <td class="tiny nowrap">{{ o.topic_label }}</td>
              <td class="tiny nowrap">{{ o.channel_label }}
                <span v-if="o.degraded_from" class="tag orange" style="margin-left: 4px">由{{ degLabel(o.degraded_from) }}降级</span></td>
              <td><span class="tag" :class="boxTag(o.status)">{{ o.status_label }}</span>
                <div v-if="o.skip_reason" class="tiny muted wrap">{{ o.skip_reason }}</div></td>
              <td class="num tiny">{{ o.retry_cnt }}/{{ o.max_retry }}</td>
              <td class="tiny mono nowrap">{{ shortTime(o.sent_at) }}</td>
              <td class="tiny nowrap">
                <span v-if="o.status === 'read'">已读 {{ shortTime(o.read_at) }}</span>
                <span v-else-if="o.opened_at" class="orange">已打开·未读</span>
                <span v-else-if="o.delivered_at" class="muted">送达 {{ shortTime(o.delivered_at) }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="nowrap">
                <button class="link-btn" @click="openBox(o.id)">详情</button>
                <button v-if="canWrite && o.can_retry" class="link-btn" @click="retryOne(o)">重试</button>
              </td>
            </tr>
            <tr v-if="!box.length"><td colspan="10" class="empty-cell">没有发送记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 五、到货提醒 ==================== -->
    <div v-if="tab === 'alert'" class="block">
      <div class="hint-bar">
        客户在商城点「到货通知我」= 一条<b>等待中的提醒</b>。触发要同时满足：
        <b>商品发布审核通过</b> + <b>可售量 ≥ 阈值</b> + 客户<b>订阅了上新到货</b> + 账号有<b>商品权限</b>。
        少一个都停在等待，并写明原因 —— 不是「悄悄没发」。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="af.status" @change="loadAlerts">
          <option value="waiting">等待中</option>
          <option value="">全部</option>
          <option value="notified">已通知</option>
          <option value="cancelled">已取消</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doSweep">触发扫描</button>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openAlert()">＋ 登记提醒</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>提醒号</th><th>客户</th><th>款号</th><th>类型</th><th class="num">阈值</th><th class="num">当前可售</th>
              <th>商品状态</th><th>状态</th><th>未触发原因 / 通知时间</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="a in alerts" :key="a.id" :class="{ 'row-warn': a.status === 'waiting' && !a.ready }">
              <td class="tiny mono nowrap">{{ a.alert_no }}</td>
              <td class="tiny">{{ a.customer_name }}<div class="muted mono">{{ a.customer_code }}</div></td>
              <td class="tiny mono nowrap">{{ a.style_no }}<div class="muted">{{ a.product_name || '—' }}</div></td>
              <td class="tiny nowrap">{{ a.kind_label }}</td>
              <td class="num tiny">{{ a.threshold_qty }}</td>
              <td class="num tiny" :class="{ red: !a.sellable_qty }">{{ a.sellable_qty }}</td>
              <td class="tiny nowrap">
                <span class="tag" :class="a.product_status === 'published' ? 'green' : 'gray'">{{ a.product_status === 'published' ? '已发布' : (a.product_status === 'draft' ? '草稿' : '未进商城') }}</span>
              </td>
              <td><span class="tag" :class="{ waiting: 'orange', notified: 'green', cancelled: 'gray' }[a.status]">{{ a.status_label }}</span></td>
              <td class="tiny muted wrap">{{ a.status === 'waiting' ? (a.ready_reason || '已满足条件，等待扫描') : (a.notified_at || '—') }}</td>
              <td class="nowrap">
                <button v-if="canWrite && a.status === 'waiting'" class="link-btn danger" @click="cancelAlert(a)">取消</button>
              </td>
            </tr>
            <tr v-if="!alerts.length"><td colspan="10" class="empty-cell">没有提醒</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec">周期回访任务<small>超期先生成销售任务；没有营销授权不发促销消息</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <span class="muted tiny">按客户采购周期扫一遍超期客户，生成销售回访任务（写进 CRM 回访）；有营销订阅的才会顺带发一条补货提醒。</span>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doCycle">生成回访任务</button>
      </div>
      <div class="table-wrap" v-if="cycleResult">
        <table class="data">
          <thead><tr><th>客户</th><th class="num">超期天数</th><th>回访任务</th><th>补货消息</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in cycleResult.rows" :key="i">
              <td class="tiny">{{ r.customer }}</td>
              <td class="num tiny">{{ r.overdue }}</td>
              <td><span class="tag" :class="r.task ? 'green' : 'gray'">{{ r.task ? '已生成' : '已有' }}</span></td>
              <td><span class="tag" :class="r.message ? 'green' : 'gray'">{{ r.message ? '已生成' : '未发' }}</span></td>
              <td class="tiny muted">{{ r.reason || (r.outbox || []).join('、') }}</td>
            </tr>
            <tr v-if="!cycleResult.rows.length"><td colspan="5" class="empty-cell">没有超期客户</td></tr>
          </tbody>
        </table>
        <p class="tiny muted" style="margin-top: 8px">
          本次：生成回访任务 {{ cycleResult.tasks }} 条，补货消息 {{ cycleResult.messages }} 条，因无营销授权只建任务 {{ cycleResult.no_auth }} 户。
        </p>
      </div>
    </div>

    <!-- ==================== 六、效果归因 ==================== -->
    <div v-if="tab === 'attr'" class="block">
      <div class="hint-bar">
        <b>送达 / 阅读 / 询价 / 已确认订单</b> 分四层。<b>打开邮件不算已读，更不算成交</b>；
        订单只认<b>已确认</b>（草稿、已取消不算），窗口 7 天，同一张单只归给<b>最早一条触达</b>。
        归因是<b>快照</b>：销售交接、客户归属变化都<b>不回写历史归因</b>。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <input v-model="atf.from" type="date" class="kw" />
        <span class="muted tiny">至</span>
        <input v-model="atf.to" type="date" class="kw" />
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doAttrRefresh">重算归因</button>
      </div>

      <div class="mini-grid" v-if="attr.totals">
        <div class="mini"><span>发送</span><b>{{ attr.totals.sent }}</b></div>
        <div class="mini"><span>送达</span><b>{{ attr.totals.delivered }}</b></div>
        <div class="mini"><span>已读</span><b>{{ attr.totals.read }}</b><small>只计 read 回执</small></div>
        <div class="mini mini-warn"><span>仅打开未读</span><b>{{ attr.totals.opened_only }}</b><small>打开 ≠ 已读</small></div>
        <div class="mini"><span>归因询价</span><b>{{ attr.totals.inquiry }}</b></div>
        <div class="mini"><span>归因订单</span><b>{{ attr.totals.order }}</b></div>
        <div class="mini"><span>归因金额</span><b>{{ money(attr.totals.revenue_cny) }}</b></div>
      </div>

      <h4 class="sec">按客户<small>触达是消息数，询价/订单是去重后的单量</small></h4>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>客户</th><th class="num">发送</th><th class="num">送达</th><th class="num">送达率</th><th class="num">已读</th>
              <th class="num">阅读率</th><th class="num">询价</th><th class="num">订单</th><th class="num">归因金额</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in attr.customers || []" :key="r.key">
              <td class="tiny">{{ r.name }}</td>
              <td class="num tiny">{{ r.sent }}</td>
              <td class="num tiny">{{ r.delivered }}</td>
              <td class="num tiny">{{ r.delivered_rate }}%</td>
              <td class="num tiny">{{ r.read }}</td>
              <td class="num tiny">{{ r.read_rate }}%</td>
              <td class="num tiny">{{ r.inquiry }}</td>
              <td class="num tiny" :class="{ green: r.order }">{{ r.order }}</td>
              <td class="num tiny">{{ money(r.revenue_cny) }}</td>
            </tr>
            <tr v-if="!(attr.customers || []).length"><td colspan="9" class="empty-cell">这个区间没有触达</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec">按商品<small>商品级复盘，用来判断哪类上新值得推</small></h4>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>款号</th><th class="num">发送</th><th class="num">送达</th><th class="num">已读</th><th class="num">询价</th>
              <th class="num">订单</th><th class="num">归因金额</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in attr.styles || []" :key="r.key">
              <td class="tiny mono">{{ r.name }}</td>
              <td class="num tiny">{{ r.sent }}</td>
              <td class="num tiny">{{ r.delivered }}</td>
              <td class="num tiny">{{ r.read }}</td>
              <td class="num tiny">{{ r.inquiry }}</td>
              <td class="num tiny" :class="{ green: r.order }">{{ r.order }}</td>
              <td class="num tiny">{{ money(r.revenue_cny) }}</td>
            </tr>
            <tr v-if="!(attr.styles || []).length"><td colspan="7" class="empty-cell">这个区间没有商品触达</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tiny muted" style="margin-top: 8px">{{ attr.note }}</p>
    </div>

    <!-- ==================== 弹窗：渠道设置 ==================== -->
    <div v-if="modal === 'cap'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>渠道能力：{{ capForm.channel_label }}</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="hint-bar" style="margin-bottom: 12px">
            启用渠道必须<b>先完成授权验收</b>并写清依据。没有依据的渠道按未授权处理，消息会自动降级。
          </div>
          <div class="fgrid">
            <label>状态
              <select v-model="capForm.status">
                <option value="enabled">可用</option>
                <option value="disabled">停用</option>
                <option value="unauthorized">未授权</option>
              </select>
            </label>
            <label>核验
              <select v-model="capForm.verify_status">
                <option value="verified">已核验</option>
                <option value="unverified">未核验</option>
              </select>
            </label>
            <label class="full">授权 / 验收依据
              <input v-model="capForm.evidence" placeholder="例：邮件服务商 SMTP 验收单 MAIL-2026-10-08，SPF/DKIM 通过" />
            </label>
            <label class="full">备注 / 不可用原因
              <input v-model="capForm.reason" placeholder="例：公众号未认证，模板消息未开通" />
            </label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveCap">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：订阅 ==================== -->
    <div v-if="modal === 'sub'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>新增 / 修改订阅</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label class="full">客户
              <select v-model="subForm.customer_id" :disabled="!!subForm.id">
                <option :value="''">选择客户</option>
                <option v-for="c in dict.customers || []" :key="c.id" :value="c.id">{{ c.name }}（{{ c.code }}）</option>
              </select>
            </label>
            <label>主题
              <select v-model="subForm.topic" :disabled="!!subForm.id">
                <option v-for="t in dict.topics || []" :key="t.k" :value="t.k">{{ t.v }}</option>
              </select>
            </label>
            <label>渠道
              <select v-model="subForm.channel" :disabled="!!subForm.id">
                <option v-for="c in dict.channels || []" :key="c.k" :value="c.k">{{ c.v }}</option>
              </select>
            </label>
            <label>客户时区
              <select v-model="subForm.timezone">
                <option v-for="tz in dict.timezones || []" :key="tz" :value="tz">{{ tz }}</option>
              </select>
            </label>
            <label>营销频率
              <select v-model="subForm.frequency">
                <option v-for="f in dict.frequencies || []" :key="f.k" :value="f.k">{{ f.v }}</option>
              </select>
            </label>
          </div>
          <p class="tiny muted" style="margin-top: 10px">
            {{ subForm.topic === 'marketing'
              ? '营销订阅必须有明确来源（客户主动勾选 / 销售代订），退订只关营销，不影响订单与服务通知。'
              : '业务通知类订阅发的是订单、服务、到货信息，不属于营销。' }}
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveSub">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：频控 ==================== -->
    <div v-if="modal === 'freq'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>发送频控</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>范围
              <select v-model="freqForm.scope">
                <option value="global">全局默认</option>
                <option value="customer">客户例外</option>
              </select>
            </label>
            <label v-if="freqForm.scope === 'customer'">客户
              <select v-model="freqForm.customer_id">
                <option :value="''">选择客户</option>
                <option v-for="c in dict.customers || []" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label>每日上限<input v-model.number="freqForm.max_per_day" type="number" min="0" max="10" /></label>
            <label>每周上限<input v-model.number="freqForm.max_per_week" type="number" min="0" max="20" /></label>
            <label>最小间隔（分钟）<input v-model.number="freqForm.min_gap_minutes" type="number" min="0" /></label>
            <label>摘要时点（当地时间，点）<input v-model.number="freqForm.digest_hour" type="number" min="0" max="23" /></label>
            <label>静默开始<input v-model="freqForm.quiet_start" placeholder="21:00" /></label>
            <label>静默结束<input v-model="freqForm.quiet_end" placeholder="08:00" /></label>
            <label class="full">说明<input v-model="freqForm.note" /></label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveFreq">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：模板 ==================== -->
    <div v-if="modal === 'tpl'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>新建模板</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>事件
              <select v-model="tplForm.event_key">
                <option v-for="e in dict.events || []" :key="e.k" :value="e.k">{{ e.v }}</option>
              </select>
            </label>
            <label>渠道
              <select v-model="tplForm.channel">
                <option v-for="c in dict.channels || []" :key="c.k" :value="c.k">{{ c.v }}</option>
              </select>
            </label>
            <label>语言
              <select v-model="tplForm.lang">
                <option v-for="l in dict.langs || []" :key="l.k" :value="l.k">{{ l.v }}</option>
              </select>
            </label>
            <label class="full">标题<input v-model="tplForm.subject" placeholder="例：新品上架：{{product_name}}" /></label>
            <label class="full">正文<textarea v-model="tplForm.body" rows="6" class="ta" placeholder="可用变量：{{customer_name}} {{product_name}} {{style_no}} {{qty}} {{order_no}} {{status_label}}"></textarea></label>
            <label class="full">变更说明<input v-model="tplForm.change_note" placeholder="例：补上退订说明" /></label>
          </div>
          <p class="tiny muted">新建出来是草稿；提交审核后由财务批准，批准时同事件同渠道同语言的旧版本自动停用。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveTpl">保存草稿</button>
        </div>
      </div>
    </div>

    <div v-if="modal === 'tplDetail' && tplDetail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ tplDetail.subject }}<span class="mono tiny" style="margin-left: 8px">{{ tplDetail.template_no }}</span></h3>
          <button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="ob-meta">
            <span class="tag blue">{{ tplDetail.event_label }}</span>
            <span class="tag gray">{{ tplDetail.channel_label }}</span>
            <span class="tag gray">{{ tplDetail.lang === 'en' ? '英文' : '中文' }}</span>
            <span class="tag" :class="{ approved: 'green', pending: 'orange', draft: 'gray', retired: 'red' }[tplDetail.status]">{{ tplDetail.status_label }}</span>
            <span class="tiny muted">变量 {{ (tplDetail.variables || []).join('、') || '—' }}</span>
          </div>
          <pre class="body-pre">{{ tplDetail.body }}</pre>
          <h4 class="sec">版本历史<small>同组合只留一条生效，旧版保留可查</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th class="num">版本</th><th>状态</th><th>批准人</th><th>时间</th><th>变更说明</th></tr></thead>
              <tbody>
                <tr v-for="v in tplDetail.versions || []" :key="v.id">
                  <td class="num tiny">V{{ v.version }}</td>
                  <td class="tiny">{{ { approved: '生效', pending: '待审核', draft: '草稿', retired: '已停用' }[v.status] || v.status }}</td>
                  <td class="tiny">{{ v.approved_by || '—' }}</td>
                  <td class="tiny mono">{{ v.approved_at || '—' }}</td>
                  <td class="tiny muted">{{ v.change_note || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：发送详情 ==================== -->
    <div v-if="modal === 'box' && boxDetail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ boxDetail.subject }}<span class="mono tiny" style="margin-left: 8px">{{ boxDetail.outbox_no }}</span></h3>
          <button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="ob-meta">
            <span class="tag" :class="boxTag(boxDetail.status)">{{ boxDetail.status_label }}</span>
            <span class="tag gray">{{ boxDetail.channel_label }}</span>
            <span class="tag gray">{{ boxDetail.topic_label }}</span>
            <span v-if="boxDetail.degraded_from" class="tag orange">由「{{ degLabel(boxDetail.degraded_from) }}」降级</span>
            <span class="tiny muted">收件人 {{ boxDetail.recipient || '—' }} · 客户 {{ boxDetail.customer_name }}</span>
          </div>
          <div v-if="boxDetail.skip_reason" class="skip-box">
            <b>未发出原因：</b>{{ boxDetail.skip_reason }}
          </div>
          <pre class="body-pre">{{ boxDetail.body }}</pre>

          <h4 class="sec">回执时间线<small>打开不等于已读，未知也不算已读</small></h4>
          <div class="timeline">
            <div v-for="l in boxDetail.logs || []" :key="l.id" class="tl-row">
              <span class="tl-time mono">{{ $fmt(l.created_at) }}</span>
              <span class="tag" :class="logTag(l.event)">{{ logLabel(l.event) }}</span>
              <span class="tl-detail">{{ l.detail || '—' }}</span>
              <span class="tiny muted">{{ l.operator }}</span>
            </div>
            <div v-if="!(boxDetail.logs || []).length" class="empty-box">还没有回执</div>
          </div>

          <div v-if="canWrite && ['queued','held','failed'].includes(boxDetail.status)" class="act-row">
            <button class="btn btn-primary btn-sm" @click="sendOne">立即发送</button>
            <button v-if="boxDetail.status === 'failed'" class="btn btn-ghost btn-sm" @click="retryOne(boxDetail)">重试</button>
            <button class="btn btn-ghost btn-sm" @click="skipOne">跳过并写原因</button>
          </div>

          <div v-if="canWrite && ['submitted','delivered'].includes(boxDetail.status)" class="receipt-box">
            <div class="rb-title">报送渠道回执<small>只允许往前走；没送达就报已读会被拒</small></div>
            <div class="rb-row">
              <select v-model="rc.event">
                <option value="delivered">已送达</option>
                <option value="read">已读</option>
                <option value="opened">已打开（不置已读）</option>
                <option value="failed">发送失败</option>
              </select>
              <input v-model="rc.detail" class="kw" placeholder="渠道返回说明，如 250 OK / 550 mailbox unavailable" />
              <button class="btn btn-primary btn-sm" :disabled="saving" @click="submitReceipt">报送</button>
            </div>
            <p class="tiny muted" style="margin-top: 6px">{{ rcHint }}</p>
            <p class="tiny muted" v-if="boxDetail.status === 'read'">这条已经读完，回执只能往前走，没有可再报的状态。</p>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：到货提醒 ==================== -->
    <div v-if="modal === 'alert'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>登记到货 / 上新提醒</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="hint-bar" style="margin-bottom: 12px">
            客户必须先订阅<b>「上新与到货」</b>，账号要有<b>商品权限</b>。登记后不会立刻发，等商品发布且可售达到阈值才触发。
          </div>
          <div class="fgrid">
            <label class="full">客户
              <select v-model="alertForm.customer_id">
                <option :value="''">选择客户</option>
                <option v-for="c in dict.customers || []" :key="c.id" :value="c.id">{{ c.name }}（{{ c.code }}）</option>
              </select>
            </label>
            <label>款号<input v-model="alertForm.style_no" placeholder="例：N24-DEMO-01" /></label>
            <label>类型
              <select v-model="alertForm.kind">
                <option value="restock">到货提醒</option>
                <option value="new_product">上新提醒</option>
              </select>
            </label>
            <label>可售阈值<input v-model.number="alertForm.threshold_qty" type="number" min="1" /></label>
            <label class="full">备注<input v-model="alertForm.note" placeholder="例：客户在商城点了到货通知" /></label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveAlert">登记</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import { auth } from '../store/auth';

const tab = ref('over');
const dict = ref({});
const ov = ref({});
const channels = ref([]);
const saving = ref(false);
const modal = ref('');

const canWrite = computed(() => can('notify.write'));
const canApprove = computed(() => can('notify.approve'));
const isAdmin = computed(() => (auth.user && auth.user.role) === 'admin');

const shortTime = (t) => (t ? String(t).slice(5, 16) : '—');
const money = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const boxTag = (s) => ({
  queued: 'blue', held: 'orange', submitted: 'purple', delivered: 'green',
  read: 'green', failed: 'red', skipped: 'gray'
}[s] || 'gray');
const degLabel = (k) => ({ site: '站内', email: '邮件', wechat: '微信' }[k] || k);
const logLabel = (e) => ({
  generated: '已生成', held: '频控暂缓', skipped: '已跳过', submitted: '已提交',
  delivered: '已送达', read: '已读', opened: '已打开', failed: '失败', retry: '重试', degraded: '渠道降级'
}[e] || e);
const logTag = (e) => ({
  generated: 'gray', held: 'orange', skipped: 'gray', submitted: 'purple',
  delivered: 'green', read: 'green', opened: 'blue', failed: 'red', retry: 'orange', degraded: 'orange'
}[e] || 'gray');

/* ---------------- 概览 ---------------- */
async function loadOv() {
  ov.value = await api.notifyOverview();
  channels.value = await api.notifyChannels();
}

/* ---------------- 渠道 ---------------- */
const capForm = reactive({ channel: '', channel_label: '', status: 'unauthorized', verify_status: 'unverified', evidence: '', reason: '' });
function openCap(c) {
  Object.assign(capForm, { channel: c.channel, channel_label: c.channel_label, status: c.status, verify_status: c.verify_status, evidence: c.evidence || '', reason: c.reason || '' });
  modal.value = 'cap';
}
async function saveCap() {
  saving.value = true;
  try {
    await api.saveNotifyChannel({ ...capForm });
    await loadOv();
    closeModal();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 订阅与频控 ---------------- */
const subs = ref([]);
const rules = ref([]);
const bindings = ref([]);
const sf = reactive({ q: '', topic: '', channel: '', status: '' });
const subForm = reactive({ id: null, customer_id: '', topic: 'arrival', channel: 'site', timezone: 'Asia/Shanghai', frequency: 'immediate' });

async function loadSubs() {
  subs.value = await api.notifySubs({ ...sf });
  rules.value = await api.notifyFrequency();
  bindings.value = await api.notifyWechat({});
}

function openSub(s) {
  if (s) {
    Object.assign(subForm, { id: s.id, customer_id: s.customer_id, topic: s.topic, channel: s.channel, timezone: s.timezone, frequency: s.frequency });
  } else {
    Object.assign(subForm, { id: null, customer_id: '', topic: 'arrival', channel: 'site', timezone: 'Asia/Shanghai', frequency: 'immediate' });
  }
  modal.value = 'sub';
}

async function saveSub() {
  if (!subForm.customer_id) return alert('请选择客户');
  saving.value = true;
  try {
    await api.saveNotifySub({ ...subForm, status: 'subscribed' });
    await Promise.all([loadSubs(), loadOv()]);
    closeModal();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function unsubMarketing(s) {
  if (!confirm(`确认退订「${s.customer_name}」的营销消息？\n订单、服务、上新到货通知不受影响。`)) return;
  try {
    const r = await api.unsubNotifyMarketing(s.customer_id, { reason: '销售代客户操作退订' });
    await Promise.all([loadSubs(), loadOv()]);
    alert(`已退订 ${r.unsubscribed} 条营销订阅；保留业务订阅 ${r.business_subs_kept} 条。\n${r.note}`);
  } catch (e) { alert(e.message); }
}

async function resub(s) {
  try {
    await api.saveNotifySub({ customer_id: s.customer_id, topic: s.topic, channel: s.channel, status: 'subscribed', opt_in_source: 'sales' });
    await Promise.all([loadSubs(), loadOv()]);
  } catch (e) { alert(e.message); }
}

async function askVerify(s) {
  try {
    const r = await api.requestNotifyEmailVerify(s.customer_id);
    await loadSubs();
    // 生产环境由邮件发链接；演示环境直接确认，便于验收
    await api.confirmNotifyEmailVerify(s.customer_id, { token: r.verify_token });
    await loadSubs();
    alert('邮箱核验完成（生产环境会先发核验邮件，点链接后才算核验）。');
  } catch (e) { alert(e.message); }
}

const freqForm = reactive({ scope: 'global', customer_id: '', max_per_day: 1, max_per_week: 3, min_gap_minutes: 0, quiet_start: '21:00', quiet_end: '08:00', digest_hour: 10, note: '' });
function openFreq(r) {
  Object.assign(freqForm, {
    scope: r.scope, customer_id: r.customer_id || '', max_per_day: r.max_per_day,
    max_per_week: r.max_per_week, min_gap_minutes: r.min_gap_minutes,
    quiet_start: r.quiet_start, quiet_end: r.quiet_end, digest_hour: r.digest_hour, note: r.note || ''
  });
  modal.value = 'freq';
}
async function saveFreq() {
  saving.value = true;
  try {
    await api.saveNotifyFrequency({ ...freqForm });
    await loadSubs();
    closeModal();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 模板 ---------------- */
const tpls = ref([]);
const tplDetail = ref(null);
const tf = reactive({ event_key: '', channel: '', status: '' });
const tplForm = reactive({ event_key: 'new_product', channel: 'site', lang: 'zh', subject: '', body: '', change_note: '' });

async function loadTpl() {
  tpls.value = await api.notifyTemplates({ ...tf });
}
function openTpl() {
  Object.assign(tplForm, { event_key: 'new_product', channel: 'site', lang: 'zh', subject: '', body: '', change_note: '' });
  modal.value = 'tpl';
}
async function saveTpl() {
  saving.value = true;
  try {
    await api.createNotifyTemplate({ ...tplForm });
    await loadTpl();
    closeModal();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openTplDetail(id) {
  tplDetail.value = await api.notifyTemplate(id);
  modal.value = 'tplDetail';
}
async function submitTpl(t) {
  try { await api.submitNotifyTemplate(t.id); await loadTpl(); } catch (e) { alert(e.message); }
}
async function approveTpl(t) {
  try { await api.approveNotifyTemplate(t.id); await loadTpl(); } catch (e) { alert(e.message); }
}
async function deleteTpl(t) {
  if (!confirm(`删除模板 ${t.template_no}（V${t.version}）？只有在草稿或待审核时能删。`)) return;
  try { await api.deleteNotifyTemplate(t.id); await loadTpl(); } catch (e) { alert(e.message); }
}
async function retireTpl(t) {
  if (!confirm(`停用模板 V${t.version}？停用后该事件 / 渠道 / 语言就没有可用模板，相关消息会被跳过。`)) return;
  const reason = prompt('停用原因（必填）') || '';
  try { await api.retireNotifyTemplate(t.id, { reason }); await loadTpl(); } catch (e) { alert(e.message); }
}

/* ---------------- 发送与回执 ---------------- */
const box = ref([]);
const boxDetail = ref(null);
const of = reactive({ status: '', channel: '', event_key: '' });
const rc = reactive({ event: 'delivered', detail: '' });
const rcHint = computed(() => ({
  delivered: '用于邮件 / 微信：渠道确认已投递时报送。站内消息提交即送达，不用手工报。',
  read: '只有已送达的才能报已读。打开邮件请用「已打开」——那不改变阅读率。',
  opened: '只记录打开时间，状态与阅读率都不变。',
  failed: '失败会累加重试次数；未达上限 1 小时后自动重试，达到上限停在失败转人工。'
}[rc.event] || ''));

async function loadBox() {
  box.value = await api.notifyOutbox({ ...of });
}
async function openBox(id) {
  boxDetail.value = await api.notifyOutboxOne(id);
  rc.event = boxDetail.value.status === 'submitted' ? 'delivered' : 'read';
  rc.detail = '';
  modal.value = 'box';
}
async function doDispatch() {
  saving.value = true;
  try {
    const r = await api.dispatchNotify({});
    await Promise.all([loadBox(), loadOv()]);
    alert(`派发 ${r.total} 条：发出 ${r.sent}、频控暂缓 ${r.held}、跳过 ${r.skipped}、异常 ${r.failed}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function sendOne() {
  saving.value = true;
  try {
    const r = await api.sendNotify(boxDetail.value.id);
    boxDetail.value = r;
    await Promise.all([loadBox(), loadOv()]);
    if (r.held) alert(`被频控暂缓到 ${r.next_at}：\n${r.hold_reason}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function retryOne(o) {
  try {
    const r = await api.retryNotify(o.id);
    if (modal.value === 'box') boxDetail.value = r;
    await Promise.all([loadBox(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function skipOne() {
  const reason = prompt('跳过原因（必填）');
  if (!reason) return;
  try {
    boxDetail.value = await api.skipNotify(boxDetail.value.id, { reason });
    await Promise.all([loadBox(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function submitReceipt() {
  saving.value = true;
  try {
    boxDetail.value = await api.notifyReceipt(boxDetail.value.id, { ...rc });
    await Promise.all([loadBox(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 到货提醒 ---------------- */
const alerts = ref([]);
const af = reactive({ status: 'waiting' });
const alertForm = reactive({ customer_id: '', style_no: '', kind: 'restock', threshold_qty: 1, note: '' });
const cycleResult = ref(null);

async function loadAlerts() {
  alerts.value = await api.notifyAlerts({ ...af });
}
function openAlert() {
  Object.assign(alertForm, { customer_id: '', style_no: '', kind: 'restock', threshold_qty: 1, note: '' });
  modal.value = 'alert';
}
async function saveAlert() {
  saving.value = true;
  try {
    await api.createNotifyAlert({ ...alertForm });
    await Promise.all([loadAlerts(), loadOv()]);
    closeModal();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function doSweep() {
  saving.value = true;
  try {
    const r = await api.sweepNotifyAlerts();
    await Promise.all([loadAlerts(), loadBox(), loadOv()]);
    alert(`触发 ${r.fired} 条；仍在等待 ${r.waiting} 条${r.waiting_rows.length ? '：\n' + r.waiting_rows.map((w) => w.style_no + ' — ' + w.reason).join('\n') : ''}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function cancelAlert(a) {
  const reason = prompt('取消原因');
  if (!reason) return;
  try { await api.cancelNotifyAlert(a.id, { reason }); await loadAlerts(); } catch (e) { alert(e.message); }
}
async function doCycle() {
  saving.value = true;
  try {
    cycleResult.value = await api.notifyCycleTasks({});
    await Promise.all([loadBox(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 归因 ---------------- */
const attr = ref({});
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const atf = reactive({ from: daysAgo(29), to: daysAgo(0) });
async function loadAttr() {
  attr.value = await api.notifyAttribution({ ...atf });
}
async function doAttrRefresh() {
  saving.value = true;
  try {
    const r = await api.refreshNotifyAttribution({ days: 30 });
    await loadAttr();
    alert(`重算完成：送达 ${r.delivered}、阅读 ${r.read}、询价 ${r.inquiry}、订单 ${r.order}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 通用 ---------------- */
function closeModal() { modal.value = ''; }

async function reloadAll() {
  await loadOv();
  if (tab.value === 'subs') await loadSubs();
  if (tab.value === 'tpl') await loadTpl();
  if (tab.value === 'box') await loadBox();
  if (tab.value === 'alert') await loadAlerts();
  if (tab.value === 'attr') await loadAttr();
}

async function go(k) {
  tab.value = k;
  if (k === 'subs') await loadSubs();
  if (k === 'tpl') await loadTpl();
  if (k === 'box') await loadBox();
  if (k === 'alert') await loadAlerts();
  if (k === 'attr') await loadAttr();
}

onMounted(async () => {
  dict.value = await api.notifyDict();
  await loadOv();
});
</script>

<style scoped>
.page { max-width: 1560px; }
.page-head .sub { max-width: 1040px; }
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

.tabbar { display: flex; margin-bottom: 10px; }
.tabs { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; }
.tabs button { flex: 0 0 auto; white-space: nowrap; padding: 8px 14px; border: 1px solid #e2e8f2; background: var(--surface); border-radius: 9px; font-size: 13px; color: var(--ink-soft); cursor: pointer; font-family: inherit; }
.tabs button.on { background: var(--brand); border-color: #2b6de5; color: var(--on-brand); font-weight: 700; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; border-radius: 9px; padding: 0 5px; font-size: 12px; }

.toolbar select, .toolbar input, .kw { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; }
.spacer { flex: 1; }
.tiny { font-size: 12px; }
.muted { color: var(--ink-mute); }
.blue { color: var(--brand); }
.green { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }
.nowrap { white-space: nowrap; }
.wrap { word-break: break-word; }
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, Consolas, monospace; }
.lnk { color: var(--brand); cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.link-btn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.link-btn.danger { color: #d92d45; }
.empty-cell { text-align: center; color: #9aa4b5; padding: 28px 0 !important; }
.empty-box { text-align: center; color: #9aa4b5; padding: 18px 0; font-size: 13px; }
.tag { white-space: nowrap; }
.row-bad { background: #fffafb; }
.row-warn { background: #fffdf7; }
.sec { margin: 18px 0 8px; font-size: 13.5px; color: var(--ink); }
.sec small { margin-left: 8px; font-size: 12px; color: #9aa4b5; font-weight: 400; }

.cap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; align-items: start; }
.cap-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; position: relative; }
.cap-card.cap-ok { border-color: #cfe9d8; background: #fbfefc; }
.cap-card.cap-no { border-color: #f3d2d6; background: #fffbfb; }
.cap-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cap-top b { font-size: 13.5px; color: var(--ink); }
.cap-line { font-size: 12px; color: var(--ink-soft); line-height: 1.7; display: flex; gap: 6px; }
.cap-line span { flex: none; color: #9aa4b5; }
.cap-btn { margin-top: 8px; }

.note-box { margin-top: 12px; background: #fffaf2; border: 1px solid #f3dcb6; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; color: #6b5a3b; }
.mini-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.mini { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; }
.mini span { display: block; font-size: 12px; color: var(--ink-mute); }
.mini b { font-size: 18px; color: #16305f; }
.mini small { display: block; font-size: 12px; color: #9aa4b5; }
.mini.mini-warn { border-color: #f5d9a8; background: #fffdf7; }

.rule-list { margin: 0; padding-left: 20px; font-size: 12.5px; color: var(--ink-soft); line-height: 1.9; }

.ob-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.body-pre { margin: 0 0 10px; padding: 12px 14px; background: #f8fafd; border: 1px solid var(--line); border-radius: 9px;
  font-size: 12.5px; line-height: 1.75; color: var(--ink); white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.skip-box { background: #fffafb; border: 1px solid #f3c2c9; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #8a3b46; margin-bottom: 10px; }

.timeline { display: flex; flex-direction: column; gap: 6px; }
.tl-row { display: flex; align-items: center; gap: 8px; font-size: 12px; border-bottom: 1px dashed #f0f3f8; padding-bottom: 6px; }
.tl-time { color: var(--ink-mute); flex: none; }
.tl-detail { flex: 1; color: var(--ink); }

.act-row { display: flex; gap: 8px; margin-top: 12px; }
.receipt-box { margin-top: 14px; border-top: 1px dashed #e8edf6; padding-top: 12px; }
.rb-title { font-size: 13px; color: var(--ink); font-weight: 700; margin-bottom: 8px; }
.rb-title small { margin-left: 8px; font-weight: 400; font-size: 12px; color: #9aa4b5; }
.rb-row { display: flex; gap: 8px; align-items: center; }
.rb-row select { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; }
.rb-row .kw { flex: 1; }

.ta { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .cap-grid { grid-template-columns: 1fr; }
  .mini-grid { grid-template-columns: repeat(2, 1fr); }
  .head-ops { flex-wrap: wrap; justify-content: flex-end; }
  .rb-row { flex-wrap: wrap; }
  .rb-row .kw { width: 100%; }
}
</style>
