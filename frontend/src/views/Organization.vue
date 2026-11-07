<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>组织编制与岗位</h2>
        <p class="sub">
          编制是<b>批准那一刻占用</b>的，不是起草时——所以满编必须走超编特批并写原因。
          一个人同一时刻<b>只能有一条生效任职</b>；换岗不能改原来那条，必须结束旧的 + 起新的，否则查不到「去年在哪个岗」。
          雇佣公司和服务公司分开记：技术部归总部雇佣，但服务各公司。
          交易路线里<b>签约方 ≠ 卖方就必须有服务协议</b>，这是三流一致的问题，不是形式。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">编制 {{ ov.headcount || 0 }} · 在职 {{ ov.in_service || 0 }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <template v-if="tab === 'pos'">
        <div class="stat"><span>在编岗位</span><strong>{{ ov.pos_total || 0 }}</strong><small>编制合计 {{ ov.headcount || 0 }} 人</small></div>
        <div class="stat"><span>在职</span><strong>{{ ov.in_service || 0 }}</strong><small>填报率 {{ ov.fill_rate === null || ov.fill_rate === undefined ? '—' : ov.fill_rate + '%' }}</small></div>
        <div class="stat"><span>空缺</span><strong>{{ ov.vacant || 0 }}</strong><small>还有位置没人</small></div>
        <div class="stat" :class="ov.over_positions ? 'st-bad' : ''"><span>超编岗位</span><strong>{{ ov.over_positions || 0 }}</strong><small>{{ (ov.over_names || []).join('、') || '无' }}</small></div>
        <div class="stat"><span>待批任职</span><strong>{{ ov.emp_pending || 0 }}</strong><small>占编要等批准</small></div>
        <div class="stat"><span>30 天内到期</span><strong>{{ ov.emp_expiring || 0 }}</strong><small>任职结束日</small></div>
      </template>
      <template v-else-if="tab === 'emp'">
        <div class="stat"><span>生效任职</span><strong>{{ empCount('effective') }}</strong><small>当前在岗</small></div>
        <div class="stat"><span>待批</span><strong>{{ empCount('pending') }}</strong><small>批准才占编</small></div>
        <div class="stat"><span>草稿</span><strong>{{ empCount('draft') }}</strong><small>还没提交</small></div>
        <div class="stat"><span>已结束</span><strong>{{ empCount('ended') }}</strong><small>历史保留</small></div>
        <div class="stat" :class="overCount ? 'st-warn' : ''"><span>超编特批</span><strong>{{ overCount }}</strong><small>有原因留痕</small></div>
        <div class="stat"><span>服务外派</span><strong>{{ serviceCount }}</strong><small>雇佣≠服务主体</small></div>
      </template>
      <template v-else-if="tab === 'route'">
        <div class="stat"><span>路线</span><strong>{{ ov.route_total || 0 }}</strong><small>条</small></div>
        <div class="stat"><span>已确认</span><strong>{{ ov.route_confirmed || 0 }}</strong><small>可直接下单</small></div>
        <div class="stat" :class="ov.route_pending ? 'st-warn' : ''"><span>条款待配</span><strong>{{ ov.route_pending || 0 }}</strong><small>不能确认</small></div>
        <div class="stat" :class="signMismatchCount ? '' : ''"><span>代签路线</span><strong>{{ signMismatchCount }}</strong><small>签约≠卖方，须有协议</small></div>
        <div class="stat"><span>涉及主体</span><strong>{{ dict.companies.length }}</strong><small>家</small></div>
        <div class="stat"><span>规则</span><strong class="tiny-strong">三流一致</strong><small>合同/发票/收款</small></div>
      </template>
      <template v-else>
        <div class="stat"><span>有效授权</span><strong>{{ ov.scope_effective || 0 }}</strong><small>有到期日</small></div>
        <div class="stat"><span>待批</span><strong>{{ ov.scope_pending || 0 }}</strong><small>不能自己批</small></div>
        <div class="stat" :class="ov.scope_expiring ? 'st-warn' : ''"><span>30 天内到期</span><strong>{{ ov.scope_expiring || 0 }}</strong><small>要续期</small></div>
        <div class="stat" :class="ov.scope_expired ? 'st-bad' : ''"><span>已过期未失效</span><strong>{{ ov.scope_expired || 0 }}</strong><small>点「到期清扫」</small></div>
        <div class="stat"><span>授权账号</span><strong>{{ scopes.length }}</strong><small>条记录（含历史）</small></div>
        <div class="stat"><span>说明</span><strong class="tiny-strong">看数据用</strong><small>不参与费用分摊</small></div>
      </template>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'pos' }" @click="go('pos')">岗位与编制</button>
        <button :class="{ on: tab === 'emp' }" @click="go('emp')">任职关系<span v-if="ov.emp_pending" class="tab-dot">{{ ov.emp_pending }}</span></button>
        <button :class="{ on: tab === 'route' }" @click="go('route')">交易路线</button>
        <button :class="{ on: tab === 'scope' }" @click="go('scope')">主体视图<span v-if="ov.scope_pending" class="tab-dot">{{ ov.scope_pending }}</span></button>
      </div>
    </div>

    <!-- ==================== 岗位与编制 ==================== -->
    <div v-if="tab === 'pos'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="posFilter.company_id" @change="loadPositions">
          <option value="">全部公司</option>
          <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="posFilter.department_id" @change="loadPositions">
          <option value="">全部部门</option>
          <option v-for="d in deptsOfCompany" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <div class="seg">
          <button :class="{ on: posView === 'card' }" @click="posView = 'card'">按部门</button>
          <button :class="{ on: posView === 'tree' }" @click="posView = 'tree'">汇报关系</button>
        </div>
        <div class="spacer"></div>
        <button v-action="['org','create']" v-if="canWrite" class="btn btn-primary" @click="openPosition()">＋ 新建岗位</button>
      </div>

      <div v-if="posView === 'card'" class="dept-grid">
        <div v-for="g in deptGroups" :key="g.key" class="dept-card">
          <div class="dc-head">
            <b>{{ g.name }}</b>
            <span class="muted tiny">编制 {{ g.headcount }} · 在职 {{ g.in_service }}</span>
          </div>
          <div v-for="p in g.positions" :key="p.id" class="pos-row" :class="p.over ? 'pr-bad' : (p.vacant === 0 && p.headcount ? 'pr-warn' : '')"
            @click="openPositionDetail(p.id)">
            <div class="pr-main">
              <span class="pr-title">{{ p.title }}</span>
              <span class="tag gray">{{ p.sequence_label }}</span>
              <span v-if="p.reports_to_title" class="tiny muted">报 {{ p.reports_to_title }}</span>
            </div>
            <div class="pr-num">
              <b>{{ p.in_service }}<i>/{{ p.headcount || '—' }}</i></b>
              <span v-if="p.over" class="tiny red">超编 {{ p.over }}</span>
              <span v-else-if="p.vacant" class="tiny muted">缺 {{ p.vacant }}</span>
              <span v-else-if="p.headcount" class="tiny orange">满编</span>
            </div>
            <div class="pr-bar"><i :style="{ width: barWidth(p) }" :class="p.over ? 'bar-bad' : (p.vacant === 0 && p.headcount ? 'bar-warn' : 'bar-ok')"></i></div>
          </div>
          <div v-if="!g.positions.length" class="tiny muted" style="padding: 6px 0">该部门还没有核定岗位</div>
        </div>
        <div v-if="!deptGroups.length" class="empty-box">还没有岗位，先新建一个</div>
      </div>

      <div v-else class="tree">
        <div v-for="n in flatTree" :key="n.id" class="tree-row" :style="{ paddingLeft: (n.depth * 22 + 10) + 'px' }"
          @click="openPositionDetail(n.id)">
          <span class="tree-line">{{ n.depth ? '└' : '▪' }}</span>
          <b>{{ n.title }}</b>
          <span class="tag gray">{{ n.sequence_label }}</span>
          <span class="tiny muted">{{ n.department_name || '—' }}</span>
          <div class="spacer"></div>
          <span class="tiny">{{ n.in_service }}/{{ n.headcount || '—' }}</span>
          <span v-if="n.over" class="tag red">超编</span>
          <span v-else-if="n.vacant" class="tag gray">缺 {{ n.vacant }}</span>
        </div>
        <div v-if="!flatTree.length" class="empty-box">该范围内没有岗位</div>
      </div>
    </div>

    <!-- ==================== 任职关系 ==================== -->
    <div v-if="tab === 'emp'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="empFilter.status" @change="loadEmployments">
          <option value="">全部状态</option>
          <option value="effective">生效中</option>
          <option value="pending">待批</option>
          <option value="draft">草稿</option>
          <option value="ended">已结束</option>
          <option value="rejected">已驳回</option>
        </select>
        <select v-model="empFilter.company_id" @change="loadEmployments">
          <option value="">全部雇佣公司</option>
          <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <input v-model="empFilter.q" class="input" placeholder="搜工号 / 姓名 / 单号" @keyup.enter="loadEmployments" />
        <div class="spacer"></div>
        <button v-action="['org','create']" v-if="canWrite" class="btn btn-primary" @click="openEmployment()">＋ 新建任职</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>任职单</th><th>员工</th><th>雇佣公司</th><th>服务主体</th><th>岗位</th><th>类型</th><th>起止</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="e in employments" :key="e.id" :class="{ 'row-pending': e.status === 'pending' }">
              <td class="nowrap"><a class="lnk" @click="openEmpDetail(e.id)">{{ e.employment_no }}</a>
                <div v-if="e.prev_employment_id" class="tiny muted">调岗转入</div></td>
              <td>{{ e.employee_name }}</td>
              <td>{{ e.employer_name }}</td>
              <td><span :class="e.service_company_id ? '' : 'muted'">{{ e.service_name }}</span></td>
              <td>{{ e.position_title || '—' }}<div class="tiny muted">{{ e.department_name }}</div></td>
              <td class="tiny">{{ e.type_label }}<span v-if="e.over_headcount" class="tag orange" style="margin-left:4px">超编</span></td>
              <td class="tiny nowrap">{{ e.start_date }}<template v-if="e.end_date"> ~ {{ e.end_date }}</template>
                <div v-if="e.expiring_soon" class="tiny orange">还剩 {{ e.days_left }} 天</div></td>
              <td><span class="tag" :class="empTag(e.status)">{{ e.status_label }}</span></td>
              <td class="ops">
                <button class="link-btn" @click="openEmpDetail(e.id)">详情</button>
                <button v-if="canWrite && e.status === 'draft'" class="link-btn" @click="submitEmp(e)">提交</button>
                <button v-if="canApprove && e.status === 'pending'" class="link-btn" @click="tryApprove(e)">批准</button>
                <button v-if="canWrite && e.status === 'effective'" class="link-btn" @click="openTransfer(e)">调岗</button>
              </td>
            </tr>
            <tr v-if="!employments.length"><td colspan="9" class="empty-cell">没有符合条件的任职</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 交易路线 ==================== -->
    <div v-if="tab === 'route'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="routeFilter.status" @change="loadRoutes">
          <option value="">全部状态</option>
          <option v-for="s in dict.route_status" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite || canApprove" class="btn btn-primary" @click="openRoute()">＋ 登记路线</button>
      </div>

      <div class="hint-bar">
        一单生意里六个角色：<b>卖方</b>（开票）<b>买方</b>（外部客户主体，多为空）、<b>履约方</b>（实际发货/生产）、<b>货主</b>（库存归谁）、
        <b>签约方</b>、<b>付款方</b>。签约方与卖方不是同一家时必须登记<b>服务协议</b>——谁签合同、谁开票、谁收款对不上，就是三流不一致。
      </div>

      <div class="route-list">
        <div v-for="r in routes" :key="r.id" class="route-card" :class="{ 'rc-bad': r.need_agreement }">
          <div class="rc-top">
            <span class="tag" :class="routeTag(r.status)">{{ r.status_label }}</span>
            <span class="tag gray">{{ r.biz_label }}</span>
            <span v-if="r.sign_mismatch" class="tag orange">代签</span>
            <span v-if="r.need_agreement" class="tag red">缺服务协议</span>
            <div class="spacer"></div>
            <span class="tiny muted">{{ r.route_no }}</span>
          </div>
          <h5>{{ r.name }}</h5>
          <div class="route-map">
            <span><i>卖方</i>{{ r.seller_name || '—' }}</span>
            <span><i>签约</i>{{ r.sign_name || '—' }}</span>
            <span><i>履约</i>{{ r.fulfill_name || '—' }}</span>
            <span><i>货主</i>{{ r.owner_name || '—' }}</span>
            <span><i>付款</i>{{ r.pay_name || '—' }}</span>
          </div>
          <div class="rc-foot">
            <span v-if="r.service_agreement" class="tiny">服务协议 {{ r.service_agreement }}<template v-if="r.service_fee_rate"> · 费率 {{ r.service_fee_rate }}%</template></span>
            <span v-else class="tiny muted">无服务协议</span>
            <div class="spacer"></div>
            <button v-if="canApprove && r.status !== 'confirmed' && r.status !== 'disabled'" class="link-btn" @click="confirmRoute(r)">确认</button>
            <button  v-if="canApprove && r.status === 'confirmed'" class="link-btn danger" @click="disableRoute(r)">停用</button>
            <button class="link-btn" @click="openRouteDetail(r.id)">详情</button>
          </div>
        </div>
        <div v-if="!routes.length" class="empty-box">还没有登记交易路线</div>
      </div>
    </div>

    <!-- ==================== 主体视图 ==================== -->
    <div v-if="tab === 'scope'" class="block">
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="scopeFilter.status" @change="loadScopes">
          <option value="">全部状态</option>
          <option v-for="s in dict.scope_status" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canApprove" class="btn btn-ghost" @click="sweepScopes">到期清扫</button>
        <button v-if="canWrite || canApprove" class="btn btn-primary" @click="openScope()">＋ 申请授权范围</button>
      </div>

      <div class="hint-bar">
        这里管的是<b>能看什么数据</b>：可见公司、字段范围（不看薪资 / 不看成本）、能不能集团汇总。
        <b>股权比例不是权限，也不等于费用分摊比例</b>——授权只回答「能不能看」，不参与核算。
        必须有到期日，到期自动失效；<b>申请人与批准人不能是同一个人</b>。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>授权单</th><th>账号</th><th>可见公司</th><th>字段范围</th><th>汇总</th><th>有效期</th><th>版本</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="s in scopes" :key="s.id" :class="{ 'row-pending': s.status === 'pending' }">
              <td class="nowrap"><a class="lnk" @click="openScopeDetail(s.id)">{{ s.scope_no }}</a>
                <div class="tiny muted">{{ s.reason }}</div></td>
              <td>{{ s.username }}<div class="tiny muted">{{ s.role_label }}</div></td>
              <td class="tiny">{{ (s.companies || []).map((c) => c.name).join('、') || '—' }}</td>
              <td class="tiny">{{ s.field_label }}</td>
              <td class="tiny">{{ s.agg_label }}</td>
              <td class="tiny nowrap">{{ s.effective_from || '—' }} ~ {{ s.expires_at || '—' }}
                <div v-if="s.expiring_soon" class="tiny orange">还剩 {{ s.days_left }} 天</div>
                <div v-if="s.status === 'effective' && s.days_left !== null && s.days_left < 0" class="tiny red">已过期 {{ Math.abs(s.days_left) }} 天</div></td>
              <td class="tiny">V{{ s.relation_version }}</td>
              <td><span class="tag" :class="scopeTag(s.status)">{{ s.status_label }}</span></td>
              <td class="ops">
                <button v-if="canWrite && s.status === 'draft'" class="link-btn" @click="submitScope(s)">提交</button>
                <button v-if="canApprove && s.status === 'pending'" class="link-btn" @click="approveScope(s)">批准</button>
                <button v-action="['org','reject']" v-if="canApprove && s.status === 'pending'" class="link-btn danger" @click="openRejectScope(s)">驳回</button>
                <button v-if="(canWrite || canApprove) && (s.status === 'effective' || s.status === 'expired')" class="link-btn" @click="renewScope(s)">续期</button>
              </td>
            </tr>
            <tr v-if="!scopes.length"><td colspan="9" class="empty-cell">没有授权记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 新建/编辑岗位 ==================== -->
    <div v-if="modal === 'position'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ posForm.id ? '编辑岗位' : '新建岗位' }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld"><span>岗位名称 *</span><input v-model="posForm.title" placeholder="如 车缝组长" /></label>
            <label class="fld"><span>归属公司 *</span>
              <select v-model="posForm.company_id" :disabled="!!posForm.id">
                <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="fld"><span>部门</span>
              <select v-model="posForm.department_id">
                <option :value="null">不指定</option>
                <option v-for="d in deptsOfFormCompany" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
            </label>
            <label class="fld"><span>序列</span>
              <select v-model="posForm.sequence"><option v-for="s in dict.sequences" :key="s.key" :value="s.key">{{ s.label }}</option></select>
            </label>
            <label class="fld"><span>职级（1 最高）</span><input v-model.number="posForm.grade" type="number" min="1" max="9" /></label>
            <label class="fld"><span>编制数（0=未核定）</span><input v-model.number="posForm.headcount" type="number" min="0" max="999" /></label>
            <label class="fld"><span>汇报给</span>
              <select v-model="posForm.reports_to_id">
                <option :value="null">直接汇报总经理</option>
                <option v-for="p in otherPositions" :key="p.id" :value="p.id">{{ p.title }}（{{ p.department_name || '—' }}）</option>
              </select>
            </label>
            <label class="fld"><span>生效日期</span><input v-model="posForm.effective_from" type="date" /></label>
            <label class="fld wide"><span>备注</span><input v-model="posForm.remark" /></label>
          </div>
          <p class="tiny muted">编制为 0 表示未核定，不参与超编校验；汇报关系不能成环（A 报 B、B 又报回 A 会被拦）。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="savePosition">保存</button>
        </div>
      </div>
    </div>

    <!-- 岗位详情 -->
    <div v-if="modal === 'posDetail' && curPos" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ curPos.title }} <span class="mono tiny">{{ curPos.code }}</span></h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag gray">{{ curPos.sequence_label }}</span>
            <span class="tag" :class="curPos.over ? 'red' : curPos.vacant ? 'gray' : 'green'">
              在职 {{ curPos.in_service }} / 编制 {{ curPos.headcount || '未核定' }}
            </span>
            <span class="tiny muted">{{ curPos.company_name }} · {{ curPos.department_name || '未分部门' }}
              <template v-if="curPos.reports_to_title"> · 汇报 {{ curPos.reports_to_title }}</template></span>
          </div>
          <div class="gate-row">
            <div class="gate gate-ok"><div class="g-head"><b>编制</b><span>{{ curPos.headcount || '未核定' }}</span></div><div class="g-detail">核定人数</div></div>
            <div class="gate" :class="curPos.over ? 'gate-bad' : 'gate-ok'">
              <div class="g-head"><b>在职</b><span>{{ curPos.in_service }}</span></div>
              <div class="g-detail">{{ curPos.over ? '超编 ' + curPos.over + ' 人' : (curPos.vacant ? '空缺 ' + curPos.vacant + ' 人' : '满编') }}</div>
            </div>
            <div class="gate gate-na"><div class="g-head"><b>填报率</b><span>{{ curPos.fill_rate === null ? '—' : curPos.fill_rate + '%' }}</span></div><div class="g-detail">在职 ÷ 编制</div></div>
          </div>

          <h4>在岗人员<small>只列生效中的任职</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>员工</th><th>雇佣公司</th><th>服务主体</th><th>开始</th><th>类型</th></tr></thead>
              <tbody>
                <tr v-for="s in curPos.staff" :key="s.id">
                  <td>{{ s.employee_name }}<span class="tiny muted"> {{ s.employee_code }}</span></td>
                  <td class="tiny">{{ s.employer_name }}</td>
                  <td class="tiny">{{ s.service_name }}</td>
                  <td class="tiny nowrap">{{ s.start_date }}</td>
                  <td class="tiny">{{ s.type_label }}</td>
                </tr>
                <tr v-if="!curPos.staff.length"><td colspan="5" class="empty-cell">还没有人在这个岗</td></tr>
              </tbody>
            </table>
          </div>

          <h4 style="margin-top: 14px">汇报链<small>往上走到头</small></h4>
          <div class="chain">
            <span v-for="(c, i) in curPos.chain" :key="i" class="chain-item">
              {{ c.title }}<em v-if="c.dept">（{{ c.dept }}）</em>
              <span v-if="i < curPos.chain.length - 1" class="chain-sep">→</span>
            </span>
          </div>
        </div>
        <div class="modal-foot">
          <button v-if="canWrite" class="btn btn-ghost" @click="editPosition(curPos)">编辑编制</button>
          <button class="btn btn-ghost" @click="modal = ''">关闭</button>
        </div>
      </div>
    </div>

    <!-- 新建任职 -->
    <div v-if="modal === 'employment'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>新建任职</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld"><span>员工 *</span>
              <select v-model="empForm.employee_id" @change="guessEmployer">
                <option :value="null">选择员工</option>
                <option v-for="e in dict.employees" :key="e.id" :value="e.id">{{ e.name }}（{{ e.code }}）</option>
              </select>
            </label>
            <label class="fld"><span>雇佣公司 *</span>
              <select v-model="empForm.employer_company_id">
                <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="fld"><span>服务公司</span>
              <select v-model="empForm.service_company_id">
                <option :value="null">全部主体</option>
                <option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="fld"><span>岗位 *</span>
              <select v-model="empForm.position_id">
                <option :value="null">选择岗位</option>
                <option v-for="p in positionsForEmployer" :key="p.id" :value="p.id">{{ p.title }}（{{ p.in_service }}/{{ p.headcount || '未核定' }}）</option>
              </select>
            </label>
            <label class="fld"><span>任职类型</span>
              <select v-model="empForm.employment_type"><option v-for="t in dict.emp_types" :key="t.key" :value="t.key">{{ t.label }}</option></select>
            </label>
            <label class="fld"><span>开始日期 *</span><input v-model="empForm.start_date" type="date" /></label>
            <label class="fld"><span>结束日期</span><input v-model="empForm.end_date" type="date" /></label>
            <label class="fld"><span>变动原因</span><input v-model="empForm.reason" placeholder="新入职 / 外派" /></label>
          </div>
          <p class="tiny muted">岗位必须属于雇佣公司（不能拿义乌的岗挂在总部雇佣上）。同一员工已有生效任职时会被拦，换岗请用「调岗」。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveEmployment">保存为草稿</button>
        </div>
      </div>
    </div>

    <!-- 任职详情 -->
    <div v-if="modal === 'empDetail' && curEmp" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ curEmp.employment_no }} · {{ curEmp.employee_name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="empTag(curEmp.status)">{{ curEmp.status_label }}</span>
            <span class="tag gray">{{ curEmp.type_label }}</span>
            <span v-if="curEmp.over_headcount" class="tag orange">超编特批</span>
            <span class="tiny muted">{{ curEmp.start_date }} ~ {{ curEmp.end_date || '至今' }}</span>
          </div>
          <div class="kv">
            <div><span>雇佣公司</span><b>{{ curEmp.employer_name }}</b></div>
            <div><span>服务主体</span><b>{{ curEmp.service_name }}</b></div>
            <div><span>岗位</span><b>{{ curEmp.position_title || '—' }}</b></div>
            <div><span>部门</span><b>{{ curEmp.department_name || '—' }}</b></div>
            <div><span>变动原因</span><b>{{ curEmp.reason || '—' }}</b></div>
            <div><span>批准人</span><b>{{ curEmp.approved_by || '—' }}</b></div>
          </div>
          <div v-if="curEmp.headcount_check" class="gate-row">
            <div class="gate gate-ok"><div class="g-head"><b>编制</b><span>{{ curEmp.headcount_check.headcount || '未核定' }}</span></div><div class="g-detail">该岗位核定</div></div>
            <div class="gate gate-ok"><div class="g-head"><b>已在职</b><span>{{ curEmp.headcount_check.in_service }}</span></div><div class="g-detail">生效任职人数</div></div>
            <div class="gate" :class="curEmp.headcount_check.would_exceed ? 'gate-bad' : 'gate-ok'">
              <div class="g-head"><b>批准后</b><span>{{ curEmp.headcount_check.would_exceed ? '超编' : '占编' }}</span></div>
              <div class="g-detail">{{ curEmp.headcount_check.would_exceed ? '必须特批并写原因' : '在编制内' }}</div>
            </div>
          </div>
          <div v-if="curEmp.over_reason" class="pw-blocked" style="margin-top: 10px">
            <b>超编原因：</b>{{ curEmp.over_reason }}
          </div>
          <div v-if="curEmp.reject_reason" class="pw-blocked" style="margin-top: 10px">
            <b>驳回原因：</b>{{ curEmp.reject_reason }}
          </div>
          <div v-if="curEmp.prev" class="tiny muted" style="margin-top: 10px">
            调岗来源：{{ curEmp.prev.employment_no }}（{{ curEmp.prev.position_title }}，{{ curEmp.prev.status_label }}）——批准后旧任职自动结束
          </div>
        </div>
        <div class="modal-foot">
          <button v-if="canWrite && curEmp.status === 'draft'" class="btn btn-primary" @click="submitEmp(curEmp)">提交审批</button>
          <button v-if="canApprove && curEmp.status === 'pending'" class="btn btn-primary" @click="tryApprove(curEmp)">批准</button>
          <button v-if="canWrite && curEmp.status === 'effective'" class="btn btn-ghost" @click="startEnd(curEmp)">结束任职</button>
          <button class="btn btn-ghost" @click="modal = ''">关闭</button>
        </div>
      </div>
    </div>

    <!-- 批准（含超编特批） -->
    <div v-if="modal === 'approveEmp' && approveTarget" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>批准任职</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="det-line">{{ approveTarget.employee_name }} → {{ approveTarget.position_title }}
            <span class="tiny muted">（{{ approveTarget.employer_name }}）</span></p>
          <div v-if="approveTarget.headcount_check && approveTarget.headcount_check.would_exceed" class="pw-blocked">
            <b>该岗位已满编</b>：编制 {{ approveTarget.headcount_check.headcount }}、在职 {{ approveTarget.headcount_check.in_service }}。
            确需超编请勾选特批并写原因，批准后记为超编任职。
          </div>
          <label v-if="approveTarget.headcount_check && approveTarget.headcount_check.would_exceed" class="chk" style="margin-top: 10px">
            <input v-model="approveForm.over_headcount" type="checkbox" /> 超编特批
          </label>
          <label v-if="approveForm.over_headcount" class="fld" style="margin-top: 8px">
            <span>超编原因 *</span><textarea v-model="approveForm.over_reason" rows="2" placeholder="如 双十一临时增员，预计 3 个月后恢复" />
          </label>
          <p v-if="approveTarget.prev" class="tiny muted" style="margin-top: 10px">
            批准后旧任职 {{ approveTarget.prev.employment_no }} 将自动结束（结束日 = 新任职开始日前一天）。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="doApprove">确认批准</button>
        </div>
      </div>
    </div>

    <!-- 调岗 -->
    <div v-if="modal === 'transfer' && transferTarget" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>调岗 · {{ transferTarget.employee_name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="tiny muted">当前：{{ transferTarget.position_title }}（{{ transferTarget.employer_name }}）。调岗是「起草新任职」，批准后旧任职自动结束。</p>
          <div class="form-grid">
            <label class="fld wide"><span>新岗位 *</span>
              <select v-model="transferForm.position_id">
                <option :value="null">选择岗位</option>
                <option v-for="p in positionsForEmployer" :key="p.id" :value="p.id">{{ p.title }}（{{ p.in_service }}/{{ p.headcount || '未核定' }}）</option>
              </select>
            </label>
            <label class="fld"><span>开始日期 *</span><input v-model="transferForm.start_date" type="date" /></label>
            <label class="fld"><span>原因</span><input v-model="transferForm.reason" placeholder="调岗 / 晋升" /></label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="doTransfer">生成待批任职</button>
        </div>
      </div>
    </div>

    <!-- 结束任职 -->
    <div v-if="modal === 'endEmp' && endTarget" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>结束任职</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="det-line">{{ endTarget.employee_name }} · {{ endTarget.position_title }}</p>
          <label class="fld"><span>结束日期 *</span><input v-model="endForm.end_date" type="date" /></label>
          <p class="tiny muted">结束不是删除：这条任职会保留为「已结束」，查历史时能看到。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" @click="doEnd">确认结束</button>
        </div>
      </div>
    </div>

    <!-- 交易路线 -->
    <div v-if="modal === 'route'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>登记交易路线</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld wide"><span>路线名称 *</span><input v-model="routeForm.name" placeholder="如 义乌代总部销售（收服务费）" /></label>
            <label class="fld"><span>业务类型</span>
              <select v-model="routeForm.biz_type"><option v-for="b in dict.route_biz" :key="b.key" :value="b.key">{{ b.label }}</option></select>
            </label>
            <label class="fld"><span>卖方（开票）*</span>
              <select v-model="routeForm.seller_company_id"><option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fld"><span>签约方 *</span>
              <select v-model="routeForm.sign_company_id"><option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fld"><span>履约方 *</span>
              <select v-model="routeForm.fulfill_company_id"><option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fld"><span>货主 *</span>
              <select v-model="routeForm.goods_owner_company_id"><option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fld"><span>付款方</span>
              <select v-model="routeForm.pay_company_id"><option v-for="c in dict.companies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fld"><span>服务协议编号</span><input v-model="routeForm.service_agreement" placeholder="签约≠卖方时必填" /></label>
            <label class="fld"><span>服务费率 %</span><input v-model.number="routeForm.service_fee_rate" type="number" min="0" max="100" /></label>
            <label class="fld wide"><span>备注</span><input v-model="routeForm.note" /></label>
          </div>
          <p v-if="routeSignMismatch && !routeForm.service_agreement" class="tiny red">
            签约方与卖方不是同一家 —— 不填服务协议编号不许保存（三流一致）。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveRoute">保存为草稿</button>
        </div>
      </div>
    </div>

    <div v-if="modal === 'routeDetail' && curRoute" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ curRoute.name }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="routeTag(curRoute.status)">{{ curRoute.status_label }}</span>
            <span class="tag gray">{{ curRoute.biz_label }}</span>
            <span class="tiny muted mono">{{ curRoute.route_no }}</span>
          </div>
          <div class="route-map big">
            <span><i>卖方</i>{{ curRoute.seller_name || '—' }}</span>
            <span><i>签约</i>{{ curRoute.sign_name || '—' }}</span>
            <span><i>履约</i>{{ curRoute.fulfill_name || '—' }}</span>
            <span><i>货主</i>{{ curRoute.owner_name || '—' }}</span>
            <span><i>付款</i>{{ curRoute.pay_name || '—' }}</span>
          </div>
          <div class="kv" style="margin-top: 12px">
            <div><span>服务协议</span><b>{{ curRoute.service_agreement || '无' }}</b></div>
            <div><span>服务费率</span><b>{{ curRoute.service_fee_rate === null || curRoute.service_fee_rate === undefined ? '—' : curRoute.service_fee_rate + '%' }}</b></div>
            <div><span>卖方名下订单</span><b>{{ curRoute.order_cnt }} 张</b></div>
            <div><span>备注</span><b>{{ curRoute.note || '—' }}</b></div>
          </div>
          <p class="tiny muted">订单主体与路线不一致时这里只做对照提示，不会自动改订单的归属主体。</p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- 申请授权范围 -->
    <div v-if="modal === 'scope'" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>申请授权范围</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label class="fld"><span>账号 *</span>
              <select v-model="scopeForm.user_id">
                <option :value="null">选择账号</option>
                <option v-for="u in dict.users" :key="u.id" :value="u.id">{{ u.username }}（{{ u.name || u.role }}）</option>
              </select>
            </label>
            <label class="fld"><span>到期日 *</span><input v-model="scopeForm.expires_at" type="date" /></label>
            <label class="fld"><span>字段范围</span>
              <select v-model="scopeForm.field_scope"><option v-for="f in dict.field_scopes" :key="f.key" :value="f.key">{{ f.label }}</option></select>
            </label>
            <label class="fld"><span>汇总范围</span>
              <select v-model="scopeForm.aggregate_scope"><option v-for="a in dict.agg_scopes" :key="a.key" :value="a.key">{{ a.label }}</option></select>
            </label>
            <label class="fld wide"><span>可见公司 *</span>
              <div class="ck-list">
                <label v-for="c in dict.companies" :key="c.id" class="chk">
                  <input type="checkbox" :value="c.id" v-model="scopeCompanies" /> {{ c.name }}
                </label>
              </div>
            </label>
            <label class="fld wide"><span>用途 *</span><input v-model="scopeForm.reason" placeholder="要对什么数据做什么（不能写「工作需要」）" /></label>
          </div>
          <p class="tiny muted">必须有到期日；集团汇总至少要选两家公司；申请人与批准人不能是同一个人。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveScope">保存为草稿</button>
        </div>
      </div>
    </div>

    <div v-if="modal === 'scopeDetail' && curScope" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ curScope.scope_no }} · {{ curScope.username }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="det-top">
            <span class="tag" :class="scopeTag(curScope.status)">{{ curScope.status_label }}</span>
            <span class="tag gray">V{{ curScope.relation_version }}</span>
            <span class="tiny muted">{{ curScope.effective_from || '—' }} ~ {{ curScope.expires_at || '—' }}</span>
          </div>
          <div class="kv">
            <div><span>账号</span><b>{{ curScope.username }}（{{ curScope.role_label }}）</b></div>
            <div><span>字段范围</span><b>{{ curScope.field_label }}</b></div>
            <div><span>汇总范围</span><b>{{ curScope.agg_label }}</b></div>
            <div><span>申请人</span><b>{{ curScope.requested_by || '—' }}</b></div>
            <div><span>批准人</span><b>{{ curScope.approved_by || '—' }}</b></div>
            <div><span>到期</span><b>{{ curScope.expires_at || '—' }}<template v-if="curScope.days_left !== null"> · 剩 {{ curScope.days_left }} 天</template></b></div>
            <div class="wide"><span>可见公司</span><b>{{ (curScope.companies || []).map((c) => c.name).join('、') || '—' }}</b></div>
            <div class="wide"><span>用途</span><b>{{ curScope.reason || '—' }}</b></div>
          </div>
          <div v-if="curScope.reject_reason" class="pw-blocked"><b>驳回原因：</b>{{ curScope.reject_reason }}</div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <div v-if="modal === 'rejectScope' && rejectTarget" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>驳回授权申请</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="det-line">{{ rejectTarget.scope_no }} · {{ rejectTarget.username }}</p>
          <label class="fld"><span>驳回原因 *</span><textarea v-model="rejectReason" rows="3" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" @click="doRejectScope">确认驳回</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('pos');
const posView = ref('card');
const dict = ref({
  companies: [], departments: [], employees: [], users: [], positions: [],
  sequences: [], emp_types: [], emp_status: [], route_biz: [], route_status: [],
  field_scopes: [], agg_scopes: [], scope_status: []
});
const ov = ref({});
const positions = ref([]);
const employments = ref([]);
const routes = ref([]);
const scopes = ref([]);

const posFilter = ref({ company_id: '', department_id: '' });
const empFilter = ref({ status: '', company_id: '', q: '' });
const routeFilter = ref({ status: '' });
const scopeFilter = ref({ status: '' });

const modal = ref('');
const saving = ref(false);
const curPos = ref(null);
const curEmp = ref(null);
const curRoute = ref(null);
const curScope = ref(null);
const approveTarget = ref(null);
const approveForm = ref({ over_headcount: false, over_reason: '' });
const transferTarget = ref(null);
const transferForm = ref({ position_id: null, start_date: '', reason: '调岗' });
const endTarget = ref(null);
const endForm = ref({ end_date: '' });
const rejectTarget = ref(null);
const rejectReason = ref('');

const posForm = ref({});
const empForm = ref({});
const routeForm = ref({});
const scopeForm = ref({});
const scopeCompanies = ref([]);

const canWrite = computed(() => can('org.write'));
const canApprove = computed(() => can('org.approve'));

const empTag = (s) => ({ draft: 'gray', pending: 'orange', effective: 'green', ended: 'gray', rejected: 'red' }[s] || 'gray');
const routeTag = (s) => ({ draft: 'gray', confirmed: 'green', pending_terms: 'orange', disabled: 'gray' }[s] || 'gray');
const scopeTag = (s) => ({ draft: 'gray', pending: 'orange', effective: 'green', expired: 'red', rejected: 'red' }[s] || 'gray');

const deptsOfCompany = computed(() => (posFilter.value.company_id
  ? dict.value.departments.filter((d) => Number(d.company_id) === Number(posFilter.value.company_id))
  : dict.value.departments));
const deptsOfFormCompany = computed(() => dict.value.departments.filter((d) => Number(d.company_id) === Number(posForm.value.company_id)));
const positionsForEmployer = computed(() => positions.value.filter((p) => Number(p.company_id) === Number(empForm.value.employer_company_id || transferTarget.value?.employer_company_id)));
const otherPositions = computed(() => positions.value.filter((p) => p.id !== posForm.value.id));

/** 按部门分组（同一部门下按职级排） */
const deptGroups = computed(() => {
  const map = new Map();
  positions.value.filter((p) => p.status === 'active').forEach((p) => {
    const k = p.department_id || 0;
    if (!map.has(k)) {
      map.set(k, {
        key: k,
        name: p.department_name || '未分部门',
        headcount: 0, in_service: 0, positions: []
      });
    }
    const g = map.get(k);
    g.positions.push(p);
    g.headcount += p.headcount || 0;
    g.in_service += p.in_service || 0;
  });
  return [...map.values()].sort((a, b) => a.key - b.key);
});

/** 汇报树拍平（带缩进层级） */
const flatTree = computed(() => {
  const byId = new Map(positions.value.map((p) => [p.id, p]));
  const out = [];
  const walk = (node, depth) => {
    out.push({ ...node, depth });
    positions.value.filter((p) => p.reports_to_id === node.id).forEach((c) => walk(c, depth + 1));
  };
  positions.value.filter((p) => !p.reports_to_id || !byId.has(p.reports_to_id)).forEach((r) => walk(r, 0));
  return out;
});

const empCount = (s) => employments.value.filter((e) => e.status === s).length;
const overCount = computed(() => employments.value.filter((e) => e.over_headcount).length);
const serviceCount = computed(() => employments.value.filter((e) => e.status === 'effective' && e.service_company_id).length);
const routeSignMismatch = computed(() => Number(routeForm.value.seller_company_id) !== Number(routeForm.value.sign_company_id));
/** 签约方与卖方不是同一家的路线数（这些必须有服务协议） */
const signMismatchCount = computed(() => routes.value.filter((r) => r.sign_mismatch).length);

const barWidth = (p) => {
  if (!p.headcount) return '0%';
  return Math.min(100, Math.round((p.in_service / p.headcount) * 100)) + '%';
};

/** ---------- 加载 ---------- */
/** 把后端的分组结构摊平成卡片好用的键（注意：要把入参传进来，不能读 ov.value，
 *  否则映射作用在旧对象上，紧接着又被原始返回值覆盖 → 卡片全是 0） */
function mapOv(d) {
  return Object.assign({}, d, {
    pos_total: d.positions ? d.positions.total : 0,
    headcount: d.positions ? d.positions.headcount : 0,
    in_service: d.positions ? d.positions.in_service : 0,
    vacant: d.positions ? d.positions.vacant : 0,
    over_positions: d.positions ? d.positions.over_positions : 0,
    over_names: d.positions ? d.positions.over_names : [],
    fill_rate: d.positions ? d.positions.fill_rate : null,
    emp_pending: d.employments ? d.employments.pending : 0,
    emp_expiring: d.employments ? d.employments.expiring_30d : 0,
    route_total: d.routes ? d.routes.total : 0,
    route_confirmed: d.routes ? d.routes.confirmed : 0,
    route_pending: d.routes ? d.routes.pending_terms : 0,
    route_no_agreement: d.routes ? d.routes.no_agreement : 0,
    scope_effective: d.scopes ? d.scopes.effective : 0,
    scope_pending: d.scopes ? d.scopes.pending : 0,
    scope_expiring: d.scopes ? d.scopes.expiring_30d : 0,
    scope_expired: d.scopes ? d.scopes.expired_today : 0
  });
}
async function loadOv() {
  ov.value = mapOv(await api.orgOverview());
}
async function loadPositions() {
  positions.value = await api.orgPositions({
    company_id: posFilter.value.company_id,
    department_id: posFilter.value.department_id
  });
}
async function loadEmployments() {
  employments.value = await api.orgEmployments(empFilter.value);
}
async function loadRoutes() {
  routes.value = await api.orgRoutes(routeFilter.value);
}
async function loadScopes() {
  scopes.value = await api.orgScopes(scopeFilter.value);
}
async function reloadAll() {
  await loadOv();
  if (tab.value === 'pos') await loadPositions();
  if (tab.value === 'emp') await loadEmployments();
  if (tab.value === 'route') await loadRoutes();
  if (tab.value === 'scope') await loadScopes();
}
function go(t) {
  tab.value = t;
  if (t === 'pos') loadPositions();
  if (t === 'emp') loadEmployments();
  if (t === 'route') loadRoutes();
  if (t === 'scope') loadScopes();
}

/** ---------- 岗位 ---------- */
function openPosition() {
  posForm.value = {
    id: null, title: '', company_id: dict.value.companies[0]?.id, department_id: null,
    sequence: 'ops', grade: null, headcount: 0, reports_to_id: null, effective_from: '', remark: ''
  };
  modal.value = 'position';
}
function editPosition(p) {
  posForm.value = {
    id: p.id, title: p.title, company_id: p.company_id, department_id: p.department_id,
    sequence: p.sequence, grade: p.grade, headcount: p.headcount, reports_to_id: p.reports_to_id,
    effective_from: p.effective_from, remark: p.remark
  };
  modal.value = 'position';
}
async function savePosition() {
  saving.value = true;
  try {
    const f = posForm.value;
    if (f.id) await api.updateOrgPosition(f.id, f);
    else await api.createOrgPosition(f);
    modal.value = '';
    await Promise.all([loadPositions(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openPositionDetail(id) {
  curPos.value = await api.orgPosition(id);
  modal.value = 'posDetail';
}

/** ---------- 任职 ---------- */
function guessEmployer() {
  const e = dict.value.employees.find((x) => x.id === empForm.value.employee_id);
  if (!e) return;
  // 员工档案里有部门 → 按部门所属公司预填雇佣公司
  const d = dict.value.departments.find((x) => x.id === e.department_id);
  if (d) empForm.value.employer_company_id = d.company_id;
}
function openEmployment() {
  empForm.value = {
    employee_id: null, employer_company_id: dict.value.companies[0]?.id, service_company_id: null,
    position_id: null, employment_type: 'fulltime', start_date: new Date().toISOString().slice(0, 10),
    end_date: '', reason: '新入职'
  };
  modal.value = 'employment';
}
async function saveEmployment() {
  saving.value = true;
  try {
    await api.createOrgEmployment(empForm.value);
    modal.value = '';
    await Promise.all([loadEmployments(), loadOv(), loadPositions()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openEmpDetail(id) {
  curEmp.value = await api.orgEmployment(id);
  modal.value = 'empDetail';
}
async function submitEmp(e) {
  try {
    await api.submitOrgEmployment(e.id);
    await Promise.all([loadEmployments(), loadOv()]);
    if (modal.value === 'empDetail') curEmp.value = await api.orgEmployment(e.id);
  } catch (err) { alert(err.message); }
}
/** 批准前先看会不会超编：会超编就弹窗要特批原因，别让人点完才知道 */
async function tryApprove(e) {
  const d = await api.orgEmployment(e.id);
  approveTarget.value = d;
  approveForm.value = { over_headcount: false, over_reason: '' };
  modal.value = 'approveEmp';
}
async function doApprove() {
  saving.value = true;
  try {
    await api.approveOrgEmployment(approveTarget.value.id, approveForm.value);
    modal.value = '';
    await Promise.all([loadEmployments(), loadOv(), loadPositions()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
function openTransfer(e) {
  transferTarget.value = e;
  const d = new Date(); d.setDate(d.getDate() + 1);
  transferForm.value = { position_id: null, start_date: d.toISOString().slice(0, 10), reason: '调岗' };
  modal.value = 'transfer';
}
async function doTransfer() {
  saving.value = true;
  try {
    await api.orgTransfer(transferTarget.value.employee_id, transferForm.value);
    modal.value = '';
    await Promise.all([loadEmployments(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
function startEnd(e) {
  endTarget.value = e;
  endForm.value = { end_date: new Date().toISOString().slice(0, 10) };
  modal.value = 'endEmp';
}
async function doEnd() {
  try {
    await api.endOrgEmployment(endTarget.value.id, endForm.value);
    modal.value = '';
    await Promise.all([loadEmployments(), loadOv(), loadPositions()]);
  } catch (e) { alert(e.message); }
}

/** ---------- 路线 ---------- */
function openRoute() {
  const c0 = dict.value.companies[0]?.id;
  routeForm.value = {
    name: '', biz_type: 'spot', seller_company_id: c0, sign_company_id: c0,
    fulfill_company_id: c0, goods_owner_company_id: c0, pay_company_id: c0,
    service_agreement: '', service_fee_rate: null, note: ''
  };
  modal.value = 'route';
}
async function saveRoute() {
  saving.value = true;
  try {
    await api.createOrgRoute(routeForm.value);
    modal.value = '';
    await Promise.all([loadRoutes(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function confirmRoute(r) {
  if (!confirm(`确认路线「${r.name}」？确认后主体不能再改。`)) return;
  try {
    await api.confirmOrgRoute(r.id, {});
    await Promise.all([loadRoutes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function disableRoute(r) {
  const note = prompt('停用原因（必填）：') || '';
  if (!note) return;
  try {
    await api.orgRouteStatus(r.id, { status: 'disabled', note });
    await Promise.all([loadRoutes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function openRouteDetail(id) {
  curRoute.value = await api.orgRoute(id);
  modal.value = 'routeDetail';
}

/** ---------- 授权 ---------- */
function openScope() {
  const d = new Date(); d.setDate(d.getDate() + 180);
  scopeForm.value = {
    user_id: null, field_scope: 'full', aggregate_scope: 'company',
    expires_at: d.toISOString().slice(0, 10), reason: ''
  };
  scopeCompanies.value = [];
  modal.value = 'scope';
}
async function saveScope() {
  saving.value = true;
  try {
    await api.createOrgScope({ ...scopeForm.value, company_ids: scopeCompanies.value.join(',') });
    modal.value = '';
    await Promise.all([loadScopes(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function submitScope(s) {
  try {
    await api.submitOrgScope(s.id);
    await Promise.all([loadScopes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function approveScope(s) {
  if (!confirm(`批准 ${s.username} 的授权范围？`)) return;
  try {
    await api.approveOrgScope(s.id, {});
    await Promise.all([loadScopes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
function openRejectScope(s) {
  rejectTarget.value = s;
  rejectReason.value = '';
  modal.value = 'rejectScope';
}
async function doRejectScope() {
  try {
    await api.rejectOrgScope(rejectTarget.value.id, { reason: rejectReason.value });
    modal.value = '';
    await Promise.all([loadScopes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function renewScope(s) {
  const d = new Date(); d.setDate(d.getDate() + 180);
  const expires = prompt('续期到哪天（YYYY-MM-DD）：', d.toISOString().slice(0, 10));
  if (!expires) return;
  try {
    await api.renewOrgScope(s.id, { expires_at: expires });
    await Promise.all([loadScopes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function sweepScopes() {
  try {
    const r = await api.sweepOrgScopes();
    alert(`已把 ${r.swept} 条到期授权置为失效${r.scopes?.length ? '：' + r.scopes.join('、') : ''}`);
    await Promise.all([loadScopes(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function openScopeDetail(id) {
  curScope.value = await api.orgScope(id);
  modal.value = 'scopeDetail';
}

onMounted(async () => {
  dict.value = await api.orgDict();
  await loadOv();
  await loadPositions();
});
</script>

<style scoped>
.page { max-width: 1500px; }
.head-ops { display: flex; align-items: center; gap: 10px; flex: none; flex-wrap: nowrap; }
.head-ops .btn { white-space: nowrap; }
.pill { display: inline-block; white-space: nowrap; font-size: 12px; font-weight: 700; border-radius: 6px; padding: 4px 9px; }
.p-gray { background: #eef1f6; color: var(--ink-soft); }

.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { font-size: 12px; color: var(--ink-mute); display: block; }
.stat strong { font-size: 22px; color: #16305f; display: block; margin-top: 4px; line-height: 1.1; }
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
.toolbar .input { min-width: 180px; }
.chk { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--ink-soft); }
.ck-list { display: flex; flex-wrap: wrap; gap: 12px; }
.spacer { flex: 1; }
.tiny { font-size: 12px; }
.muted { color: var(--ink-mute); }
.red { color: #d92d45; }
.orange { color: #d97706; }
.lnk { color: var(--brand); cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: none; background: var(--surface); padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: inherit; color: var(--ink-soft); }
.seg button.on { background: #eef4ff; color: var(--brand); font-weight: 700; }
.empty-box { grid-column: 1/-1; text-align: center; color: #9aa4b5; padding: 34px 0; font-size: 13px; }
.hint-bar { background: #f2f7ff; border: 1px solid #d6e4ff; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; color: var(--ink); margin-bottom: 12px; line-height: 1.7; }
.hint-bar b { color: #16305f; }
.nowrap { white-space: nowrap; }
.link-btn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.link-btn.danger { color: #d92d45; }
.row-pending { background: #fffdf7; }
.bar { height: 6px; background: #eef2f7; border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; }
.bar-ok { background: var(--brand); }
.bar-warn { background: #f59e0b; }
.bar-bad { background: #d92d45; }

/* 编制卡 */
.dept-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; align-items: start; }
.dept-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.dc-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.dc-head b { font-size: 14px; color: var(--ink); }
.pos-row { padding: 8px 6px; border-radius: 8px; cursor: pointer; border-bottom: 1px dashed #f0f3f8; }
.pos-row:hover { background: #f8fafd; }
.pos-row.pr-bad { background: #fffafa; }
.pos-row.pr-warn { background: #fffdf7; }
.pr-main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pr-title { font-size: 13px; font-weight: 600; color: var(--ink); }
.pr-num { display: flex; align-items: baseline; gap: 8px; margin-top: 3px; }
.pr-num b { font-size: 13px; color: #16305f; }
.pr-num b i { font-style: normal; font-size: 12px; color: #9aa4b5; }
.pr-bar { margin-top: 4px; height: 5px; background: #eef2f7; border-radius: 4px; overflow: hidden; }
.pr-bar i { display: block; height: 100%; }

/* 汇报树 */
.tree { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 8px 6px; }
.tree-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.tree-row:hover { background: #f8fafd; }
.tree-line { color: #b9c4d6; width: 14px; }
.tree-row .spacer { flex: 1; }

/* 路线卡 */
.route-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); gap: 12px; align-items: start; }
.route-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px; }
.route-card.rc-bad { border-color: #f3c2c9; background: #fffafa; }
.rc-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rc-top .spacer { flex: 1; }
.route-card h5 { margin: 8px 0; font-size: 14px; color: var(--ink); }
.route-map { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--ink); }
.route-map.big { font-size: 12.5px; gap: 10px 22px; }
.route-map span { display: flex; align-items: baseline; gap: 5px; }
.route-map i { font-style: normal; color: #9aa4b5; font-size: 12px; }
.rc-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
.rc-foot .spacer { flex: 1; }

/* 弹窗内 */
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-grid .wide { grid-column: 1/-1; }
.fld { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--ink-soft); }
.fld > span { font-weight: 600; }
.fld input, .fld select, .fld textarea {
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px;
  font-family: inherit; width: 100%; box-sizing: border-box; background: var(--surface);
}
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
.modal-body h4 { font-size: 13px; color: var(--ink); margin: 14px 0 8px; }
.modal-body h4 small { font-weight: 400; color: #9aa4b5; margin-left: 6px; font-size: 12px; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; margin-bottom: 12px; }
.kv > div { display: flex; gap: 10px; font-size: 12.5px; border-bottom: 1px dashed #f0f3f8; padding-bottom: 5px; }
.kv > div.wide { grid-column: 1/-1; }
.kv span { color: var(--ink-mute); width: 90px; flex: none; }
.kv b { color: var(--ink); font-weight: 600; }
.chain { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink); }
.chain-item em { font-style: normal; color: #9aa4b5; font-size: 12px; }
.chain-sep { color: #b9c4d6; margin-left: 6px; }
.pw-blocked { background: #fffafa; border: 1px solid #f3c2c9; border-radius: 9px; padding: 10px 12px; font-size: 12.5px; color: var(--ink); line-height: 1.7; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .form-grid, .kv, .gate-row { grid-template-columns: 1fr; }
  .dept-grid, .route-list { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; align-items: flex-start; }
  .head-ops { flex-wrap: wrap; }
  .toolbar .input { min-width: 0; width: 100%; }
}
</style>
