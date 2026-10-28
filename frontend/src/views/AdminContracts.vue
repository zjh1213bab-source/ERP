<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>行政合同与证照印章</h2>
        <p class="sub">
          租赁/物业/食堂/保险/服务采购统一台账。到期、付款、验收、押金返还按条款生成任务进日历，
          <b>提醒不自动改状态、不自动扣款、不自动续约</b>。印章<b>按公司独立授权</b>，用印绑定最终文件版本，改正文要重核；
          借章登记归还，敏感原件访问留痕。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openContractForm()">＋ 新建合同</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>合同</span><strong>{{ board.stat.contracts || 0 }}</strong><small>履约中 {{ board.stat.active || 0 }}</small></div>
      <div class="stat"><span>30 天内到期</span><strong :class="board.stat.expiring30 ? 'amt-orange' : ''">{{ board.stat.expiring30 || 0 }}</strong><small>要决定续签还是终止</small></div>
      <div class="stat"><span>已过期未处理</span><strong :class="board.stat.overdue_contracts ? 'amt-red' : ''">{{ board.stat.overdue_contracts || 0 }}</strong><small>风险</small></div>
      <div class="stat"><span>履约任务待办</span><strong>{{ board.stat.milestones_open || 0 }}</strong><small>逾期 {{ board.stat.milestones_overdue || 0 }}</small></div>
      <div class="stat"><span>印章</span><strong>{{ board.stat.seals || 0 }}</strong><small :class="board.stat.seals_ungranted ? 'amt-red' : ''">未授权 {{ board.stat.seals_ungranted || 0 }}</small></div>
      <div class="stat"><span>证照临期/过期</span><strong :class="board.stat.certs_expiring30 ? 'amt-orange' : ''">{{ board.stat.certs_expiring30 || 0 }}</strong><small>共 {{ board.stat.certs || 0 }} 张</small></div>
      <div class="stat"><span>用印待办</span><strong :class="board.stat.seal_pending ? 'amt-orange' : ''">{{ board.stat.seal_pending || 0 }}</strong><small>需重核 {{ board.stat.seal_recheck || 0 }}</small></div>
      <div class="stat"><span>借章未还</span><strong :class="board.stat.borrow_overdue ? 'amt-red' : ''">{{ board.stat.borrow_open || 0 }}</strong><small>逾期 {{ board.stat.borrow_overdue || 0 }}</small></div>
    </div>

    <div v-if="board.alerts && board.alerts.length" class="alert-strip">
      <span class="alert-title">需要处理</span>
      <span v-for="(a, i) in board.alerts.slice(0, 8)" :key="i" class="alert-chip" :class="a.level">
        {{ a.label }}
      </span>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'c' }" @click="tab = 'c'">合同台账</button>
        <button :class="{ on: tab === 'cal' }" @click="tab = 'cal'; loadCalendar()">履约日历</button>
        <button :class="{ on: tab === 'seal' }" @click="tab = 'seal'; loadSeals()">印章与授权</button>
        <button :class="{ on: tab === 'cert' }" @click="tab = 'cert'; loadCerts()">证照档案</button>
      </div>
      <template v-if="tab === 'c'">
        <input v-model="q" class="input" placeholder="合同名 / 编号 / 对手方" style="width: 200px" @keyup.enter="loadContracts" />
        <select class="select" v-model="fStatus" style="width: 130px" @change="loadContracts">
          <option value="">全部状态</option>
          <option v-for="(v, k) in dict.status" :key="k" :value="k">{{ v }}</option>
        </select>
        <select class="select" v-model="fExpiring" style="width: 130px" @change="loadContracts">
          <option value="">全部期限</option>
          <option value="30">30 天内到期</option>
          <option value="90">90 天内到期</option>
        </select>
        <button class="btn btn-ghost" @click="loadContracts">查询</button>
      </template>
      <template v-if="tab === 'seal' && canWrite">
        <button class="btn btn-ghost btn-sm" @click="openGrantForm()">＋ 印章授权</button>
        <button class="btn btn-primary btn-sm" @click="openUsageForm()">＋ 用印 / 借章申请</button>
      </template>
    </div>

    <!-- ==================== 合同台账 ==================== -->
    <div v-if="tab === 'c'" class="table-wrap">
      <table class="data ct-tbl">
        <thead>
          <tr>
            <th style="width: 150px">合同编号</th><th>合同名称</th><th style="width: 84px">类型</th>
            <th style="width: 88px">责任</th><th style="width: 190px">期限</th>
            <th style="width: 92px">状态</th><th class="num" style="width: 96px">金额</th>
            <th class="num" style="width: 90px">押金</th>
            <th style="width: 210px">下一任务</th>
            <th style="width: 190px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in contracts" :key="c.id" :class="{ 'row-risk': c.expiring === 'expired', 'row-warn': c.expiring === '30' }">
            <td class="mono">{{ c.contract_no }}<div class="tiny muted">V{{ c.current_version }}</div></td>
            <td>{{ c.name }}<div class="tiny muted">{{ c.company || '-' }} ← {{ c.counterparty }}</div></td>
            <td><span class="tag gray">{{ c.type_label }}</span></td>
            <td>{{ c.owner || '-' }}</td>
            <td class="tiny">{{ c.start_date }} ~ {{ c.end_date }}
              <div v-if="c.days_to_end !== null" :class="c.days_to_end < 0 ? 'amt-red' : c.days_to_end <= 30 ? 'amt-orange' : 'muted'">
                {{ c.days_to_end < 0 ? '已过期 ' + Math.abs(c.days_to_end) + ' 天' : '剩 ' + c.days_to_end + ' 天' }}
              </div>
            </td>
            <td><span class="tag" :class="ctTag(c.status)">{{ c.status_label }}</span></td>
            <td class="num">{{ money(c.amount) }}</td>
            <td class="num" :class="c.deposit ? '' : 'muted'">{{ c.deposit ? money(c.deposit) : '-' }}</td>
            <td class="tiny">
              <template v-if="c.next_milestone">
                <span :class="c.next_milestone.effective_status === 'overdue' ? 'amt-red' : ''">
                  {{ c.next_milestone.type_label }} · {{ c.next_milestone.due_date }}
                  <span v-if="c.next_milestone.effective_status === 'overdue'">（逾期）</span>
                </span>
                <div class="muted">{{ c.next_milestone.title }}</div>
              </template>
              <span v-else class="muted">无待办</span>
            </td>
            <td class="ops">
              <button class="link-btn" @click="openContract(c)">详情</button>
              <button v-if="canWrite && c.status === 'active'" class="link-btn" @click="renew(c)">续签</button>
              <button v-if="canWrite && c.status === 'active'" class="link-btn danger" @click="terminate(c)">终止</button>
              <button v-if="canWrite" class="link-btn" @click="archive(c)">{{ c.status === 'archived' ? '取消归档' : '归档' }}</button>
            </td>
          </tr>
          <tr v-if="!contracts.length"><td colspan="10" class="empty-cell">还没有行政合同，点「新建合同」建第一份</td></tr>
        </tbody>
      </table>
    </div>

    <!-- ==================== 履约日历 ==================== -->
    <div v-if="tab === 'cal'">
      <div class="cal-head">
        <span>范围：{{ cal.from }} ~ {{ cal.to }}</span>
        <span class="tag gray">共 {{ cal.stat.total || 0 }} 项</span>
        <span class="tag red">逾期 {{ cal.stat.overdue || 0 }}</span>
        <span class="tag orange">7 天内 {{ cal.stat.this_week || 0 }}</span>
        <span class="tag">付款 {{ cal.stat.payment || 0 }}</span>
        <span class="tag">押金返还 {{ cal.stat.deposit || 0 }}</span>
        <span class="tiny muted">只提醒，不会自动付款或自动续约</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th style="width: 110px">到期日</th><th style="width: 90px">来源</th><th>事项</th><th style="width: 96px">类型</th><th class="num" style="width: 90px">金额</th><th style="width: 100px">状态</th><th style="width: 170px">操作</th></tr></thead>
          <tbody>
            <tr v-for="(x, i) in cal.items" :key="i" :class="{ 'row-risk': x.effective_status === 'overdue' }">
              <td class="mono">{{ x.due_date }}
                <div class="tiny" :class="x.effective_status === 'overdue' ? 'amt-red' : 'muted'">
                  {{ x.days_left === null ? '' : x.days_left < 0 ? '逾期 ' + Math.abs(x.days_left) + ' 天' : x.days_left + ' 天后' }}
                </div>
              </td>
              <td><span class="tag" :class="srcTag(x.source)">{{ srcLabel(x.source) }}</span></td>
              <td>{{ x.title }}<div v-if="x.contract" class="tiny muted">{{ x.contract.contract_no }} {{ x.contract.name }}</div>
                <div v-if="x.note" class="tiny muted">{{ x.note }}</div>
              </td>
              <td class="tiny">{{ x.type_label || '-' }}</td>
              <td class="num">{{ x.amount ? money(x.amount) : '-' }}</td>
              <td><span class="tag" :class="x.effective_status === 'overdue' ? 'red' : 'orange'">{{ x.effective_status === 'overdue' ? '已逾期' : '待办' }}</span></td>
              <td class="ops">
                <template v-if="x.source === 'milestone'">
                  <button v-if="canWrite" class="link-btn" @click="doneMs(x)">完成</button>
                  <button v-if="canWrite && x.type !== 'deposit_return'" class="link-btn" @click="waiveMs(x)">豁免</button>
                </template>
                <span v-else class="tiny muted">去对应模块处理</span>
              </td>
            </tr>
            <tr v-if="!cal.items.length"><td colspan="7" class="empty-cell">这段时间没有到期事项</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 印章与授权 ==================== -->
    <div v-if="tab === 'seal'">
      <div class="seal-grid">
        <div v-for="s in sealCoverage" :key="s.seal_id" class="seal-card" :class="{ warn: s.warning }">
          <div class="sc-name">{{ s.name }}<span class="tag gray">{{ s.company }}</span></div>
          <div class="sc-meta">保管：{{ s.keeper || '-' }}</div>
          <div class="sc-meta" :class="s.grants ? 'amt-green' : 'amt-red'">有效授权 {{ s.grants }} 条</div>
          <div v-if="s.warning" class="tiny amt-red">{{ s.warning }}</div>
        </div>
      </div>

      <h4 class="sec-title">授权清单<span class="tiny muted"> · 不同公司印章独立授权，可给到人 / 角色 / 岗位，带有效期</span></h4>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th style="width: 150px">公司 / 印章</th><th style="width: 130px">被授权人</th><th style="width: 90px">对象类型</th><th style="width: 90px">范围</th><th style="width: 180px">有效期</th><th style="width: 90px">状态</th><th style="width: 110px">授权人</th><th style="width: 90px"></th></tr></thead>
          <tbody>
            <tr v-for="g in grants" :key="g.id">
              <td>{{ g.seal_company }} · {{ g.seal_name }}</td>
              <td><b>{{ g.grantee }}</b></td>
              <td class="tiny">{{ { person: '个人', role: '角色', position: '岗位' }[g.grantee_type] || g.grantee_type }}</td>
              <td class="tiny">{{ g.scope_label }}</td>
              <td class="tiny">{{ g.valid_from || '-' }} ~ {{ g.valid_to || '长期' }}</td>
              <td><span class="tag" :class="g.effective_status === 'active' ? 'green' : g.effective_status === 'expired' ? 'orange' : 'gray'">{{ g.status_label }}</span></td>
              <td class="tiny">{{ g.granted_by || '-' }}</td>
              <td><button v-if="canWrite && g.effective_status === 'active'" class="link-btn danger" @click="revokeGrant(g)">撤销</button></td>
            </tr>
            <tr v-if="!grants.length"><td colspan="8" class="empty-cell">还没有任何授权：除系统管理员外谁都盖不了章</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec-title">用印与借章</h4>
      <div class="table-wrap">
        <table class="data tu-tbl">
          <thead>
            <tr>
              <th style="width: 130px">申请号</th><th style="width: 82px">类别</th><th style="width: 130px">印章</th>
              <th>用途 / 文件</th><th style="width: 92px">申请人</th><th style="width: 96px">状态</th>
              <th style="width: 155px">版本/重核</th><th style="width: 175px">回执 / 应还</th><th style="width: 200px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in usages" :key="u.id" :class="{ 'row-risk': u.recheck_required || u.borrow_overdue }">
              <td class="mono">{{ u.usage_no }}<div class="tiny muted">{{ $fmtDate(u.created_at) }}</div></td>
              <td><span class="tag" :class="u.kind === 'borrow' ? 'orange' : 'gray'">{{ u.kind_label }}</span></td>
              <td>{{ u.seal_company }}<div class="tiny muted">{{ u.seal_name }}</div></td>
              <td class="tiny wrap">
                {{ u.purpose }}
                <div v-if="u.doc_name" class="muted">文件：{{ u.doc_name }}</div>
                <div v-if="u.contract_name" class="muted">关联合同：{{ u.contract_no }} {{ u.contract_name }}</div>
              </td>
              <td>{{ u.applicant || '-' }}</td>
              <td><span class="tag" :class="usTag(u.status)">{{ u.status_label }}</span></td>
              <td class="tiny">
                <span v-if="u.recheck_required" class="amt-red">需重核</span>
                <span v-else-if="u.doc_hash" class="amt-green">已绑最终版</span>
                <span v-else class="muted">未绑版本</span>
                <div v-if="u.recheck_reason" class="muted">{{ u.recheck_reason }}</div>
              </td>
              <td class="tiny">
                <span v-if="u.receipt_no">用印回执 {{ u.receipt_no }}</span>
                <span v-if="u.return_receipt" class="muted">归还：{{ u.return_receipt }}</span>
                <span v-if="u.kind === 'borrow' && u.status === 'borrowed'" :class="u.borrow_overdue ? 'amt-red' : ''">
                  应还 {{ u.expect_return_date }}{{ u.borrow_overdue ? '（逾期 ' + Math.abs(u.days_left) + ' 天）' : '' }}
                </span>
              </td>
              <td class="ops">
                <button v-if="canWrite && u.status === 'pending'" class="link-btn" @click="approveUsage(u)">批准</button>
                <button v-if="canWrite && u.status === 'approved' && u.kind === 'use'" class="link-btn" @click="doUse(u)">登记用印</button>
                <button v-if="canWrite && u.status === 'approved' && u.kind === 'borrow'" class="link-btn" @click="doBorrow(u)">借出</button>
                <button v-if="canWrite && ['used', 'borrowed'].includes(u.status)" class="link-btn" @click="doReturn(u)">归还</button>
                <button v-if="canWrite && ['pending', 'approved'].includes(u.status)" class="link-btn danger" @click="rejectUsage(u)">驳回</button>
              </td>
            </tr>
            <tr v-if="!usages.length"><td colspan="9" class="empty-cell">没有用印或借章记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 证照档案 ==================== -->
    <div v-if="tab === 'cert'">
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th style="width: 150px">公司</th><th style="width: 100px">类型</th><th>名称</th><th style="width: 130px">证号</th><th style="width: 100px">发证机关</th><th style="width: 110px">有效期</th><th style="width: 110px">到期</th><th style="width: 90px">保管</th><th style="width: 80px">访问</th><th style="width: 110px"></th></tr></thead>
          <tbody>
            <tr v-for="c in certs" :key="c.id" :class="{ 'row-risk': c.expiring === 'expired', 'row-warn': c.expiring === '30' }">
              <td>{{ c.company || '-' }}</td>
              <td class="tiny">{{ c.type_label }}</td>
              <td>{{ c.name }}<span class="tag gray" style="margin-left: 6px">{{ c.access_label }}</span></td>
              <td class="mono tiny">{{ c.cert_no || '-' }}</td>
              <td class="tiny">{{ c.issued_by || '-' }}</td>
              <td class="tiny">{{ c.issue_date || '-' }} ~ {{ c.expire_date || '长期' }}</td>
              <td class="tiny">
                <span v-if="c.expiring === 'expired'" class="amt-red">已过期 {{ Math.abs(c.days_left) }} 天</span>
                <span v-else-if="c.days_left !== null" :class="c.days_left <= 30 ? 'amt-orange' : 'muted'">剩 {{ c.days_left }} 天</span>
                <span v-else class="muted">长期</span>
              </td>
              <td class="tiny">{{ c.holder || '-' }}</td>
              <td><span class="tag" :class="c.access_level === 'public' ? 'gray' : 'orange'">{{ c.access_level === 'public' ? '公开' : '受控' }}</span></td>
              <td><button class="link-btn" @click="viewCert(c)">查看</button></td>
            </tr>
            <tr v-if="!certs.length"><td colspan="10" class="empty-cell">没有证照（在「后勤管理」里登记证照）</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec-title">访问日志<span class="tiny muted"> · 敏感原件不留全员可见，查看即留痕</span></h4>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th style="width: 150px">时间</th><th style="width: 100px">档案</th><th>名称</th><th style="width: 90px">级别</th><th style="width: 80px">动作</th><th style="width: 130px">操作人</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="l in accessLogs" :key="l.id">
              <td class="tiny mono">{{ $fmt(l.created_at) }}</td>
              <td class="tiny">{{ { certificate: '证照', contract: '合同', seal_usage: '用印' }[l.doc_type] || l.doc_type }}</td>
              <td>{{ l.doc_name }}</td>
              <td><span class="tag" :class="l.access_level === 'public' ? 'gray' : 'orange'">{{ l.access_level === 'public' ? '公开' : '受控' }}</span></td>
              <td class="tiny">{{ { view: '查看', download: '下载', print: '打印' }[l.action] || l.action }}</td>
              <td class="tiny">{{ l.operator }}<div class="muted">{{ l.operator_role }}</div></td>
              <td class="tiny muted">{{ l.reason || '-' }}</td>
            </tr>
            <tr v-if="!accessLogs.length"><td colspan="7" class="empty-cell">还没有访问记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 合同详情 ================= -->
    <div v-if="cur" class="modal-mask" @click.self="cur = null">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>{{ cur.name }} <span class="tag" :class="ctTag(cur.status)">{{ cur.status_label }}</span>
            <span class="tag gray">V{{ cur.current_version }}</span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <div class="ct-meta">
            <span>编号 <b>{{ cur.contract_no }}</b></span>
            <span>类型 <b>{{ cur.type_label }}</b></span>
            <span>公司 <b>{{ cur.company || '-' }}</b></span>
            <span>对手方 <b>{{ cur.counterparty }}</b></span>
            <span>责任人 <b>{{ cur.owner || '-' }}</b></span>
            <span>金额 <b>{{ money(cur.amount) }}</b></span>
            <span>押金 <b>{{ cur.deposit ? money(cur.deposit) : '无' }}</b></span>
            <span>期限 <b>{{ cur.start_date }} ~ {{ cur.end_date }}</b></span>
            <span>续约提醒 <b>到期前 {{ cur.renewal_notice_days }} 天</b></span>
          </div>
          <p v-if="cur.status === 'terminated'" class="hint-bar amt-red">已终止：{{ cur.terminated_reason }}（{{ cur.terminated_by }} · {{ $fmt(cur.terminated_at) }}）</p>
          <p v-if="cur.renewal_basis" class="hint-bar">续签依据：{{ cur.renewal_basis }}</p>

          <div class="row-between">
            <h4 class="sec-title">文件版本</h4>
            <button v-if="canWrite && cur.status !== 'archived'" class="btn btn-ghost btn-sm" @click="openVersionForm()">＋ 出新版本（改正文）</button>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width: 70px">版本</th><th>文件</th><th style="width: 200px">内容指纹</th><th>变更说明</th><th style="width: 110px">修改人</th><th style="width: 130px">时间</th></tr></thead>
              <tbody>
                <tr v-for="v in cur.versions" :key="v.id">
                  <td><b>V{{ v.version }}</b></td>
                  <td>{{ v.doc_name || '-' }}</td>
                  <td class="mono tiny">{{ v.doc_hash || '未记录' }}</td>
                  <td class="tiny wrap">{{ v.change_note || '-' }}</td>
                  <td class="tiny">{{ v.changed_by || '-' }}</td>
                  <td class="tiny">{{ $fmt(v.changed_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="tiny muted" style="margin-top: 6px">改正文出新版本后，未用印的申请会自动转「需重核」，不能用旧版本盖章。</p>

          <h4 class="sec-title">履约任务</h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width: 96px">类型</th><th>事项</th><th style="width: 100px">到期</th><th class="num" style="width: 90px">金额</th><th style="width: 90px">状态</th><th style="width: 110px">完成</th><th style="width: 150px">操作</th></tr></thead>
              <tbody>
                <tr v-for="m in cur.milestones" :key="m.id" :class="{ 'row-risk': m.effective_status === 'overdue' }">
                  <td class="tiny">{{ m.type_label }}</td>
                  <td>{{ m.title }}<div v-if="m.evidence" class="tiny muted">证据：{{ m.evidence }}</div>
                    <div v-if="m.note" class="tiny muted">{{ m.note }}</div>
                  </td>
                  <td class="mono tiny">{{ m.due_date }}</td>
                  <td class="num">{{ m.amount ? money(m.amount) : '-' }}</td>
                  <td><span class="tag" :class="msTag(m.effective_status)">{{ m.status_label }}</span></td>
                  <td class="tiny">{{ m.done_at ? $fmtDate(m.done_at) + ' ' + (m.done_by || '') : '-' }}</td>
                  <td class="ops">
                    <button v-if="canWrite && ['pending', 'overdue'].includes(m.effective_status)" class="link-btn" @click="doneMs(m, cur)">完成</button>
                    <button v-if="canWrite && m.effective_status !== 'done' && m.type !== 'deposit_return' && m.effective_status !== 'waived'" class="link-btn" @click="waiveMs(m, cur)">豁免</button>
                  </td>
                </tr>
                <tr v-if="!cur.milestones.length"><td colspan="7" class="empty-cell">没有履约任务</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="sec-title">用印记录</h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width: 130px">申请号</th><th style="width: 70px">类别</th><th>用途</th><th style="width: 96px">状态</th><th style="width: 150px">回执</th></tr></thead>
              <tbody>
                <tr v-for="u in cur.seal_usages" :key="u.id">
                  <td class="mono">{{ u.usage_no }}</td>
                  <td class="tiny">{{ u.kind_label }}</td>
                  <td class="tiny wrap">{{ u.purpose }}</td>
                  <td><span class="tag" :class="usTag(u.status)">{{ u.status_label }}</span></td>
                  <td class="tiny">{{ u.receipt_no || '-' }}</td>
                </tr>
                <tr v-if="!cur.seal_usages.length"><td colspan="5" class="empty-cell">还没有用印记录</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="cur = null">关闭</button>
          <button v-if="canWrite && cur.status === 'active'" class="btn btn-ghost" @click="openUsageForm(cur)">申请用印</button>
          <button v-if="canWrite && cur.status === 'active'" class="btn btn-ghost" @click="renew(cur)">续签</button>
          <button v-if="canWrite && cur.status === 'active'" class="btn btn-primary" @click="terminate(cur)">终止</button>
        </div>
      </div>
    </div>

    <!-- ================= 新建合同 ================= -->
    <div v-if="ctForm" class="modal-mask" @click.self="ctForm = null">
      <div class="modal xwide">
        <div class="modal-head"><h3>新建行政合同</h3><button class="x" @click="ctForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full"><label>合同名称 *</label><input class="input" v-model="ctForm.name" placeholder="城北仓库租赁合同" /></div>
            <div class="fitem">
              <label>类型 *</label>
              <select class="select" v-model="ctForm.type">
                <option v-for="(v, k) in dict.type" :key="k" :value="k">{{ v }}</option>
              </select>
            </div>
            <div class="fitem"><label>签约公司</label><input class="input" v-model="ctForm.company" placeholder="义乌市珂睿服饰" /></div>
            <div class="fitem"><label>对手方 *</label><input class="input" v-model="ctForm.counterparty" placeholder="城北物流园管委会" /></div>
            <div class="fitem"><label>责任人 *</label><input class="input" v-model="ctForm.owner" placeholder="谁跟这份合同" /></div>
            <div class="fitem"><label>合同金额</label><input class="input" type="number" v-model.number="ctForm.amount" /></div>
            <div class="fitem">
              <label>币种</label>
              <select class="select" v-model="ctForm.currency"><option value="CNY">CNY</option><option value="USD">USD</option></select>
            </div>
            <div class="fitem"><label>押金</label><input class="input" type="number" v-model.number="ctForm.deposit" /></div>
            <div class="fitem"><label>押金应返还日</label><input class="input" type="date" v-model="ctForm.deposit_return_date" /></div>
            <div class="fitem"><label>签订日</label><input class="input" type="date" v-model="ctForm.sign_date" /></div>
            <div class="fitem"><label>起始日 *</label><input class="input" type="date" v-model="ctForm.start_date" /></div>
            <div class="fitem"><label>到期日 *</label><input class="input" type="date" v-model="ctForm.end_date" /></div>
            <div class="fitem"><label>续约提醒（提前天数）</label><input class="input" type="number" v-model.number="ctForm.renewal_notice_days" /></div>
            <div class="fitem">
              <label>约定用章</label>
              <select class="select" v-model.number="ctForm.seal_id">
                <option :value="null">未约定</option>
                <option v-for="s in sealList" :key="s.id" :value="s.id">{{ s.company }} · {{ s.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>首版文件名称</label><input class="input" v-model="ctForm.doc_name" placeholder="城北仓库租赁合同V1.pdf" /></div>
            <div class="fitem full"><label>文件内容指纹（可选，用于判断「最终版本」）</label><input class="input" v-model="ctForm.doc_hash" placeholder="上传后的哈希或合同编号+版本" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="ctForm.remark" /></div>
          </div>

          <h4 class="sec-title">付款计划（会生成付款任务，只提醒不自动付）</h4>
          <div v-for="(p, i) in ctForm.payments" :key="i" class="pay-row">
            <input class="input" type="date" v-model="p.due_date" />
            <input class="input" type="number" v-model.number="p.amount" placeholder="金额" style="width: 110px" />
            <input class="input" v-model="p.title" placeholder="首期租金" />
            <button class="link-btn danger" @click="ctForm.payments.splice(i, 1)">移除</button>
          </div>
          <button class="link-btn" @click="ctForm.payments.push({ due_date: '', amount: 0, title: '' })">＋ 加一期付款</button>

          <h4 class="sec-title">服务验收</h4>
          <div v-for="(a, i) in ctForm.acceptances" :key="i" class="pay-row">
            <input class="input" type="date" v-model="a.due_date" />
            <input class="input" v-model="a.title" placeholder="仓库交付验收（面积/消防/水电）" />
            <button class="link-btn danger" @click="ctForm.acceptances.splice(i, 1)">移除</button>
          </div>
          <button class="link-btn" @click="ctForm.acceptances.push({ due_date: '', title: '' })">＋ 加一项验收</button>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="ctForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveContract">创建</button>
        </div>
      </div>
    </div>

    <!-- ================= 出新版本 ================= -->
    <div v-if="verForm" class="modal-mask" @click.self="verForm = null">
      <div class="modal">
        <div class="modal-head"><h3>合同出新版本（改正文）</h3><button class="x" @click="verForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">
            当前 <b>V{{ verForm.contract.current_version }}</b>。<br />
            出新版本后，所有<b>未用印</b>的申请会自动转「需重核」，必须按新版本重新提交审批才能盖章。
          </p>
          <div class="form-grid">
            <div class="fitem"><label>文件名称 *</label><input class="input" v-model="verForm.doc_name" placeholder="合同V2.pdf" /></div>
            <div class="fitem"><label>内容指纹</label><input class="input" v-model="verForm.doc_hash" placeholder="改版后的哈希/编号" /></div>
            <div class="fitem full"><label>变更说明 *</label><textarea v-model="verForm.change_note" rows="3" placeholder="租金条款改按季度支付，增加周末加班保洁"></textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="verForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveVersion">出新版本</button>
        </div>
      </div>
    </div>

    <!-- ================= 用印/借章申请 ================= -->
    <div v-if="usForm" class="modal-mask" @click.self="usForm = null">
      <div class="modal xwide">
        <div class="modal-head"><h3>用印 / 借章申请</h3><button class="x" @click="usForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">
            印章按公司独立授权：没有授权会被直接拒绝。用印要绑「最终文件版本」，合同改过正文必须重新审批。
          </p>
          <div class="form-grid">
            <div class="fitem">
              <label>类别 *</label>
              <select class="select" v-model="usForm.kind">
                <option value="use">用印</option>
                <option value="borrow">借章（外带）</option>
              </select>
            </div>
            <div class="fitem">
              <label>印章 *</label>
              <select class="select" v-model.number="usForm.seal_id">
                <option v-for="s in sealList" :key="s.id" :value="s.id">{{ s.company }} · {{ s.name }}</option>
              </select>
            </div>
            <div class="fitem full"><label>用途 *</label><input class="input" v-model="usForm.purpose" placeholder="租赁合同签署（三份）" /></div>
            <div v-if="usForm.kind === 'use'" class="fitem"><label>文件名称 *</label><input class="input" v-model="usForm.doc_name" placeholder="城北仓库租赁合同V2.pdf" /></div>
            <div v-if="usForm.kind === 'borrow'" class="fitem"><label>预计归还日 *</label><input class="input" type="date" v-model="usForm.expect_return_date" /></div>
            <div class="fitem">
              <label>关联合同（绑版本）</label>
              <select class="select" v-model.number="usForm.contract_id" @change="onUsageContract">
                <option :value="null">不关联</option>
                <option v-for="c in board.contracts" :key="c.id" :value="c.id">{{ c.contract_no }} {{ c.name }}</option>
              </select>
            </div>
            <div class="fitem full"><label>文件内容指纹</label>
              <input class="input" v-model="usForm.doc_hash" :placeholder="usForm.contract_id ? '留空自动取合同当前版本指纹' : '可选'" />
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="usForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveUsage">提交申请</button>
        </div>
      </div>
    </div>

    <!-- ================= 印章授权 ================= -->
    <div v-if="grantForm" class="modal-mask" @click.self="grantForm = null">
      <div class="modal">
        <div class="modal-head"><h3>印章授权</h3><button class="x" @click="grantForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">不同公司印章独立授权；可以按人 / 角色 / 岗位授权，带有效期。没授权的公司章谁都盖不了。</p>
          <div class="form-grid">
            <div class="fitem full">
              <label>印章 *</label>
              <select class="select" v-model.number="grantForm.seal_id">
                <option v-for="s in sealList" :key="s.id" :value="s.id">{{ s.company }} · {{ s.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>被授权人 *</label><input class="input" v-model="grantForm.grantee" placeholder="sales01 / 行政主管" /></div>
            <div class="fitem">
              <label>对象类型</label>
              <select class="select" v-model="grantForm.grantee_type">
                <option value="person">个人（账号或姓名）</option>
                <option value="role">角色（sales / finance…）</option>
                <option value="position">岗位</option>
              </select>
            </div>
            <div class="fitem">
              <label>范围</label>
              <select class="select" v-model="grantForm.scope">
                <option value="use">仅用印</option>
                <option value="borrow">仅借章</option>
                <option value="all">用印 + 借章</option>
              </select>
            </div>
            <div class="fitem"><label>有效期至（空=长期）</label><input class="input" type="date" v-model="grantForm.valid_to" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="grantForm.remark" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="grantForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveGrant">授权</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('admincontract.write'));

const tab = ref('c');
const q = ref('');
const fStatus = ref('');
const fExpiring = ref('');
const board = reactive({ stat: {}, alerts: [], contracts: [] });
const contracts = ref([]);
const cal = reactive({ from: '', to: '', items: [], stat: {} });
const grants = ref([]);
const sealCoverage = ref([]);
const sealList = ref([]);
const usages = ref([]);
const certs = ref([]);
const accessLogs = ref([]);
const dict = ref({ type: {}, status: {}, ms_type: {}, grant_scope: {} });
const cur = ref(null);
const ctForm = ref(null);
const verForm = ref(null);
const usForm = ref(null);
const grantForm = ref(null);
const saving = ref(false);

function money(v) { return '¥' + (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('zh-CN'); }
function ctTag(s) { return { draft: 'gray', active: 'green', renewed: 'blue', terminated: 'red', archived: 'gray' }[s] || 'gray'; }
function msTag(s) { return { pending: 'orange', overdue: 'red', done: 'green', waived: 'gray' }[s] || 'gray'; }
function usTag(s) { return { pending: 'orange', approved: 'blue', used: 'green', borrowed: 'orange', returned: 'gray', rejected: 'red' }[s] || 'gray'; }
function srcLabel(s) { return { milestone: '合同任务', certificate: '证照', seal_borrow: '借章' }[s] || s; }
function srcTag(s) { return { milestone: 'gray', certificate: 'blue', seal_borrow: 'orange' }[s] || 'gray'; }

async function loadBoard() {
  const d = await api.adminContractBoard();
  Object.assign(board, d);
  contracts.value = d.contracts || [];
  if (d.dict) dict.value = { ...dict.value, ...d.dict };
}

async function loadContracts() {
  const d = await api.adminContracts({ q: q.value, status: fStatus.value, expiring: fExpiring.value });
  contracts.value = d.rows || [];
}

async function loadCalendar() {
  const d = await api.adminCalendar({});
  Object.assign(cal, d);
}

async function loadSeals() {
  const g = await api.sealGrants({});
  grants.value = g.rows || [];
  sealCoverage.value = g.coverage || [];
  sealList.value = g.seals || [];
  const u = await api.adminSealUsages({});
  usages.value = u.rows || [];
}

async function loadCerts() {
  certs.value = await api.adminCertificates();
  const l = await api.adminAccessLogs({});
  accessLogs.value = l.rows || [];
}

async function reloadAll() {
  await loadBoard();
  if (tab.value === 'cal') await loadCalendar();
  if (tab.value === 'seal') await loadSeals();
  if (tab.value === 'cert') await loadCerts();
}

async function openContract(c) {
  try { cur.value = await api.adminContract(c.id); } catch (e) { alert(e.message); }
}

async function refreshCur() {
  if (cur.value) {
    try { cur.value = await api.adminContract(cur.value.id); } catch (e) { /* ignore */ }
  }
  await loadBoard();
}

/* ---------- 新建合同 ---------- */
function openContractForm() {
  ctForm.value = {
    name: '', type: 'lease', company: '', counterparty: '', owner: '',
    amount: 0, currency: 'CNY', deposit: 0, deposit_return_date: '', sign_date: '',
    start_date: '', end_date: '', renewal_notice_days: 30, seal_id: null,
    doc_name: '', doc_hash: '', remark: '', payments: [], acceptances: []
  };
  if (!sealList.value.length) api.sealGrants({}).then((g) => { sealList.value = g.seals || []; }).catch(() => {});
}

async function saveContract() {
  const f = ctForm.value;
  if (!f.name || !f.counterparty || !f.owner) return alert('合同名称、对手方、责任人都必填');
  if (!f.start_date || !f.end_date) return alert('起止日期必填（没有期限就进不了履约日历）');
  saving.value = true;
  try {
    const r = await api.createAdminContract(f);
    ctForm.value = null;
    await loadBoard();
    alert(r.notice || '已创建');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------- 版本 ---------- */
function openVersionForm() {
  verForm.value = { contract: cur.value, doc_name: '', doc_hash: '', change_note: '' };
}
async function saveVersion() {
  const f = verForm.value;
  if (!f.change_note.trim()) return alert('改正文必须写变更说明');
  saving.value = true;
  try {
    const r = await api.addAdminContractVersion(f.contract.id, { doc_name: f.doc_name, doc_hash: f.doc_hash, change_note: f.change_note });
    verForm.value = null;
    await refreshCur();
    await loadSeals();
    alert(r.notice || '已出新版本');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------- 续签 / 终止 / 归档 ---------- */
async function renew(c) {
  const basis = prompt(`续签「${c.name}」的依据（履约评价 / 价格谈判 / 验收结果）：`);
  if (basis === null) return;
  if (!String(basis).trim()) return alert('续签必须写依据');
  const end = prompt('新的到期日（YYYY-MM-DD）：', c.end_date);
  if (!end) return;
  try {
    const r = await api.renewAdminContract(c.id, { renewal_basis: basis.trim(), end_date: end });
    await refreshCur();
    alert(r.notice || '已续签');
  } catch (e) { alert(e.message); }
}

async function terminate(c) {
  const reason = prompt(`终止「${c.name}」的原因（必须写，会留档）：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('终止必须写原因');
  try {
    const r = await api.terminateAdminContract(c.id, { reason: reason.trim() });
    await refreshCur();
    alert(r.notice || '已终止');
  } catch (e) { alert(e.message); }
}

async function archive(c) {
  const back = c.status === 'archived';
  if (!back && !confirm(`归档「${c.name}」？归档后不能改，但记录保留可追溯`)) return;
  try {
    await api.archiveAdminContract(c.id, { undo: back });
    await refreshCur();
    alert(back ? '已取消归档' : '已归档');
  } catch (e) { alert(e.message); }
}

/* ---------- 里程碑 ---------- */
async function doneMs(m, fromDetail) {
  const ev = prompt(`完成「${m.title}」的证据（付款凭证号 / 验收结论 / 押金到账凭证）：`);
  if (ev === null) return;
  if (!String(ev).trim()) return alert('完成任务必须写证据');
  try {
    const r = await api.doneAdminMilestone(m.id, { evidence: ev.trim() });
    if (fromDetail) await refreshCur(); else { await loadCalendar(); await loadBoard(); }
    alert(r.notice || '已完成');
  } catch (e) { alert(e.message); }
}

async function waiveMs(m, fromDetail) {
  const reason = prompt(`豁免「${m.title}」的原因：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('豁免必须写原因');
  try {
    await api.waiveAdminMilestone(m.id, { reason: reason.trim() });
    if (fromDetail) await refreshCur(); else { await loadCalendar(); await loadBoard(); }
    alert('已豁免');
  } catch (e) { alert(e.message); }
}

/* ---------- 用印 / 借章 ---------- */
function openUsageForm(contract) {
  if (!sealList.value.length) {
    api.sealGrants({}).then((g) => { sealList.value = g.seals || []; }).catch(() => {});
  }
  usForm.value = {
    kind: 'use', seal_id: sealList.value.length ? sealList.value[0].id : null,
    purpose: '', doc_name: '', contract_id: contract ? contract.id : null,
    doc_hash: '', expect_return_date: ''
  };
}

function onUsageContract() {
  const cid = usForm.value.contract_id;
  if (!cid) return;
  const c = board.contracts.find((x) => x.id === cid);
  if (c) {
    if (c.seal_id) usForm.value.seal_id = c.seal_id;
    const v = (c.versions || [])[0];
    if (v && v.doc_name && !usForm.value.doc_name) usForm.value.doc_name = v.doc_name;
  }
}

async function saveUsage() {
  const f = usForm.value;
  if (!f.purpose.trim()) return alert('请填用途');
  if (f.kind === 'use' && !String(f.doc_name || '').trim()) return alert('用印必须写文件名称');
  if (f.kind === 'borrow' && !f.expect_return_date) return alert('借章必须填预计归还日');
  saving.value = true;
  try {
    const r = await api.createAdminSealUsage(f);
    usForm.value = null;
    await loadSeals();
    await refreshCur();
    alert(r.notice || '已提交');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function approveUsage(u) {
  try {
    await api.approveSealUsage(u.id);
    await loadSeals();
    alert('已批准');
  } catch (e) { alert(e.message); }
}

async function doUse(u) {
  const r = prompt(`登记用印「${u.doc_name || u.purpose}」的回执号：`);
  if (r === null) return;
  if (!String(r).trim()) return alert('用印必须填回执号');
  try {
    const res = await api.useSeal(u.id, { receipt_no: r.trim() });
    await loadSeals();
    alert(res.notice || '已用印');
  } catch (e) { alert(e.message); }
}

async function doBorrow(u) {
  if (!confirm(`确认借出「${u.seal_name}」？应于 ${u.expect_return_date} 前归还`)) return;
  try {
    const res = await api.borrowSeal(u.id);
    await loadSeals();
    alert(res.notice || '已借出');
  } catch (e) { alert(e.message); }
}

async function doReturn(u) {
  const r = prompt('归还回执（谁收的、章体是否完好）：', '行政部已收，章体完好');
  if (r === null) return;
  if (!String(r).trim()) return alert('归还必须填回执');
  try {
    const res = await api.returnSeal(u.id, { return_receipt: r.trim() });
    await loadSeals();
    alert(res.notice || '已归还');
  } catch (e) { alert(e.message); }
}

async function rejectUsage(u) {
  const reason = prompt('驳回原因：');
  if (reason === null) return;
  if (!String(reason).trim()) return alert('驳回必须写原因');
  try {
    await api.rejectSealUsage(u.id, { reason: reason.trim() });
    await loadSeals();
    alert('已驳回');
  } catch (e) { alert(e.message); }
}

/* ---------- 授权 ---------- */
function openGrantForm() {
  if (!sealList.value.length) {
    api.sealGrants({}).then((g) => { sealList.value = g.seals || []; }).catch(() => {});
  }
  grantForm.value = {
    seal_id: sealList.value.length ? sealList.value[0].id : null,
    grantee: '', grantee_type: 'person', scope: 'use', valid_to: '', remark: ''
  };
}

async function saveGrant() {
  const f = grantForm.value;
  if (!String(f.grantee || '').trim()) return alert('请填被授权人');
  saving.value = true;
  try {
    const r = await api.createSealGrant(f);
    grantForm.value = null;
    await loadSeals();
    alert(r.notice || '已授权');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function revokeGrant(g) {
  const reason = prompt(`撤销「${g.grantee}」对「${g.seal_name}」的授权，原因：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('撤销必须写原因');
  try {
    await api.revokeSealGrant(g.id, { reason: reason.trim() });
    await loadSeals();
    alert('已撤销');
  } catch (e) { alert(e.message); }
}

/* ---------- 证照 ---------- */
async function viewCert(c) {
  try {
    const r = await api.viewAdminCertificate(c.id, { action: 'view', reason: '工作查阅' });
    await loadCerts();
    alert(`${c.name}\n\n${r.notice}`);
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  try { dict.value = await api.adminContractDict(); } catch (e) { /* ignore */ }
  await loadBoard();
  try {
    const g = await api.sealGrants({});
    sealList.value = g.seals || [];
  } catch (e) { /* ignore */ }
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(8, 1fr); gap: 9px; margin-bottom: 12px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 10px 12px; }
.stat span { font-size: 11.5px; color: #8a94a6; }
.stat strong { display: block; margin: 3px 0 1px; font-size: 19px; color: #16233b; }
.stat small { font-size: 11px; color: #a9b4c5; }
.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.tiny { font-size: 11.5px; }
.wrap { white-space: normal; line-height: 1.55; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.row-warn { background: #fffaf2; }
.row-risk { background: #fff7f8; }
.ops { white-space: nowrap; }

.alert-strip { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; background: #fff; border: 1px solid #f0e2d2;
  border-radius: 10px; padding: 9px 12px; margin-bottom: 12px; }
.alert-title { font-size: 12px; font-weight: 700; color: #a15c11; margin-right: 4px; }
.alert-chip { font-size: 11.5px; padding: 2px 9px; border-radius: 10px; background: #fff7ec; color: #8a5a17; }
.alert-chip.risk { background: #fdecee; color: #b3263c; }

.cal-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 12.5px; color: #5b6474;
  background: #f8fafd; border: 1px solid #e8eef7; border-radius: 10px; padding: 9px 12px; margin-bottom: 10px; }
.seal-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 6px; }
.seal-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.seal-card.warn { border-color: #f3c9cd; background: #fff9fa; }
.sc-name { font-size: 13.5px; font-weight: 700; color: #16233b; display: flex; align-items: center; gap: 7px; }
.sc-meta { font-size: 12px; color: #6b7688; margin-top: 4px; }
.sec-title { margin: 16px 0 8px; font-size: 13px; color: #16233b; }
.ct-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12.5px; color: #5b6474;
  background: #f8fafd; border: 1px solid #e8eef7; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
.ct-meta b { color: #16233b; }
.row-between { display: flex; align-items: center; justify-content: space-between; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px;
  font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 10px; }
.pay-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.pay-row .input { flex: 1; }
.ct-tbl { min-width: 1280px; }
.tu-tbl { min-width: 1240px; }
.tu-tbl td .tag { white-space: nowrap; }
.tu-tbl td:nth-child(7) div.muted { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
@media (max-width: 1400px) { .stat-row { grid-template-columns: repeat(4, 1fr); } .seal-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .seal-grid { grid-template-columns: 1fr; } }
</style>
