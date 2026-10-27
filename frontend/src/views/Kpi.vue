<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>岗位绩效与申诉</h2>
        <p class="sub">
          按<b>岗位族</b>配置指标，不用一套指标考核所有岗位。当前分 = 基准分 − <b>已确认</b>扣分；
          <b>建议扣分和待复核分不进最终分</b>。扣分必须有证据并经授权主管复核，同一事件不重复扣。
          未结申诉的单据标「暂定」，不能当无争议最终分用。绩效分<b>不自动等同扣薪或处分</b>。
        </p>
      </div>
      <div class="head-ops">
        <select class="select" v-model.number="cycleId" style="width: 210px" @change="reloadAll">
          <option v-for="c in cycles" :key="c.id" :value="c.id">
            {{ c.cycle_no }}（{{ c.start_date }} ~ {{ c.end_date }}）{{ c.status === 'frozen' ? '· 已冻结' : '' }}
          </option>
        </select>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="createCycle">＋ 生成周期</button>
        <button v-if="canWrite" class="btn btn-primary" @click="generate">生成本期绩效</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>考核人数</span><strong>{{ board.stat.people || 0 }}</strong><small>{{ board.cycle ? board.cycle.cycle_no : '未选周期' }}</small></div>
      <div class="stat"><span>平均分</span><strong :class="avgClass">{{ board.stat.avg_score === null || board.stat.avg_score === undefined ? '-' : board.stat.avg_score }}</strong><small>按当前分算</small></div>
      <div class="stat"><span>待复核项</span><strong :class="board.stat.pending_items ? 'amt-orange' : ''">{{ board.stat.pending_items || 0 }}</strong><small>建议分未生效</small></div>
      <div class="stat"><span>申诉中</span><strong :class="board.stat.open_appeals ? 'amt-red' : ''">{{ board.stat.open_appeals || 0 }}</strong><small>未结不算最终分</small></div>
      <div class="stat"><span>暂定单</span><strong :class="board.stat.not_final ? 'amt-orange' : ''">{{ board.stat.not_final || 0 }}</strong><small>有未结申诉</small></div>
      <div class="stat"><span>没匹配模板</span><strong :class="board.stat.template_missing ? 'amt-red' : ''">{{ board.stat.template_missing || 0 }}</strong><small>岗位族未配置</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'score' }" @click="tab = 'score'">绩效看板</button>
        <button :class="{ on: tab === 'rule' }" @click="tab = 'rule'; loadTemplates()">规则与模板</button>
        <button :class="{ on: tab === 'appeal' }" @click="tab = 'appeal'; loadAppeals()">
          申诉与复核<span v-if="appealStat.open" class="tab-dot">{{ appealStat.open }}</span>
        </button>
      </div>
      <template v-if="tab === 'score'">
        <input v-model="q" class="input" placeholder="姓名 / 岗位" style="width: 180px" @keyup.enter="loadScores" />
        <button class="btn btn-ghost" @click="loadScores">查询</button>
        <button v-if="cycle && cycle.status !== 'frozen' && canReview" class="btn btn-ghost" @click="freezeCycle">冻结本期</button>
      </template>
      <template v-if="tab === 'rule'">
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openTemplateForm()">＋ 新建模板</button>
      </template>
    </div>

    <p v-if="cycle && cycle.status === 'frozen'" class="hint-bar">
      本周期已冻结：分数已定版，规则版本不再追溯改动。已确认的扣分只能通过申诉复核调整（保留原记录）。
    </p>

    <!-- ==================== 一、绩效看板 ==================== -->
    <div v-if="tab === 'score'">
      <div v-if="!scores.length" class="empty-cell" style="background: #fff; border-radius: 12px; padding: 26px">
        这个周期还没有绩效单。先确认「规则与模板」里对应岗位族已有批准模板，再点「生成本周绩效」。
      </div>
      <div v-else class="table-wrap">
        <table class="data score-tbl">
          <thead>
            <tr>
              <th style="width: 130px">员工</th><th style="width: 90px">岗位</th>
              <th style="width: 170px">当前分</th>
              <th style="width: 78px" class="num">基准</th>
              <th style="width: 88px" class="num">建议扣</th>
              <th style="width: 88px" class="num">已确认</th>
              <th style="width: 110px">状态</th>
              <th style="width: 150px">模板</th>
              <th>说明</th>
              <th style="width: 130px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in scores" :key="s.id" :class="{ 'row-warn': s.not_final }">
              <td><b>{{ s.employee_name }}</b><div class="tiny">{{ s.department_name || '' }}</div></td>
              <td>{{ s.position || '-' }}</td>
              <td>
                <div class="score-cell">
                  <b :class="scoreClass(s.current_score)">{{ s.current_score === null ? '-' : s.current_score }}</b>
                  <span v-if="s.not_final" class="tag orange">暂定</span>
                  <div class="bar"><i :style="{ width: barWidth(s.current_score) }" :class="scoreClass(s.current_score)"></i></div>
                </div>
              </td>
              <td class="num">{{ s.base_score }}</td>
              <td class="num" :class="s.suggested_score ? 'amt-orange' : 'muted'">{{ s.suggested_score ? '-' + s.suggested_score : '0' }}</td>
              <td class="num" :class="s.confirmed_score ? 'amt-red' : 'muted'">{{ s.confirmed_score ? '-' + s.confirmed_score : '0' }}</td>
              <td><span class="tag" :class="scoreTag(s.status)">{{ s.status_label }}</span></td>
              <td class="tiny">{{ s.template_no }} V{{ s.template_version }}</td>
              <td class="tiny">
                <span v-if="s.not_final" class="warn">有未结申诉，当前分不是最终分</span>
                <span v-else-if="s.suggested_score > 0">建议分未生效，等主管逐项复核</span>
                <span v-else-if="s.confirmed_score > 0">已按规则扣分，可点开看明细</span>
                <span v-else class="muted">本期无扣分</span>
              </td>
              <td>
                <button class="link-btn" @click="openScore(s)">明细</button>
                <button v-if="canReview && s.status === 'pending_review'" class="link-btn" @click="confirmScore(s)">确认</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 待复核清单 -->
      <div v-if="board.pending && board.pending.length" class="block">
        <h4>待复核的建议扣分（{{ board.pending.length }} 项）<span class="tiny muted">· 建议分不计入当前分，复核确认后才生效</span></h4>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th style="width: 100px">员工</th><th style="width: 160px">指标</th><th class="num" style="width: 70px">建议扣</th><th>证据</th><th style="width: 120px">状态</th><th style="width: 200px">操作</th></tr></thead>
            <tbody>
              <tr v-for="p in board.pending" :key="p.id">
                <td>{{ p.employee_name }}</td>
                <td>{{ p.rule_name }}</td>
                <td class="num amt-orange">-{{ p.suggested_score }}</td>
                <td class="tiny wrap">{{ p.evidence }}</td>
                <td><span class="tag orange">{{ p.review_label }}</span></td>
                <td>
                  <button v-if="canReview && p.review_status === 'pending'" class="link-btn" @click="confirmItem(p)">确认扣分</button>
                  <button v-if="canReview && p.review_status === 'pending'" class="link-btn danger" @click="rejectItem(p)">驳回</button>
                  <button v-if="p.review_status === 'unconfigured'" class="link-btn" @click="openScoreById(p.score_id)">看规则</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 二、规则与模板 ==================== -->
    <div v-if="tab === 'rule'">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 150px">模板号</th><th>模板名称</th><th style="width: 90px">岗位族</th>
              <th style="width: 70px" class="num">版本</th><th style="width: 74px" class="num">指标</th>
              <th style="width: 90px" class="num">权重合计</th><th style="width: 92px">状态</th>
              <th style="width: 92px" class="num">已用</th><th style="width: 110px">生效日</th>
              <th style="width: 190px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in templates" :key="t.id">
              <td class="mono">{{ t.template_no }}</td>
              <td>{{ t.name }}<div class="tiny">{{ t.department_name || '通用' }}</div></td>
              <td><span class="tag gray">{{ t.job_family }}</span></td>
              <td class="num">V{{ t.version }}</td>
              <td class="num">{{ t.rule_count }}</td>
              <td class="num" :class="t.weight_ok ? 'amt-green' : 'amt-red'">{{ t.weight_sum }}%</td>
              <td><span class="tag" :class="tplTag(t.status)">{{ t.status_label }}</span></td>
              <td class="num">{{ t.used_count }} 单</td>
              <td class="tiny">{{ t.effective_from || '-' }}</td>
              <td>
                <button class="link-btn" @click="openTemplate(t)">查看规则</button>
                <button v-if="canWrite && t.status === 'draft'" class="link-btn" @click="submitTemplate(t)">提交审批</button>
                <button v-if="canReview && t.status === 'pending_review'" class="link-btn" @click="approveTemplate(t)">批准</button>
                <button v-if="canReview && t.status === 'pending_review'" class="link-btn danger" @click="rejectTemplate(t)">驳回</button>
                <button v-if="canWrite && t.status === 'approved'" class="link-btn" @click="newVersion(t)">出新版</button>
                <button v-if="t.status !== 'approved' && t.rule_count" class="link-btn" @click="simulate(t)">模拟试算</button>
              </td>
            </tr>
            <tr v-if="!templates.length"><td colspan="10" class="empty-cell">还没有绩效模板，先按岗位族建模板</td></tr>
          </tbody>
        </table>
      </div>
      <p class="hint-bar" style="margin-top: 12px">
        规则要点：指标必须写清定义、计算口径、目标、数据源、例外条件、扣分上限、复核人，缺一项不许提交审批；
        权重合计必须 100%；<b>未批准的模板只能「模拟试算」，不发布正式绩效</b>。已批准版本不原地改，要调整请「出新版」。
      </p>
    </div>

    <!-- ==================== 三、申诉与复核 ==================== -->
    <div v-if="tab === 'appeal'">
      <div class="stat-row" style="grid-template-columns: repeat(5, 1fr)">
        <div class="stat"><span>申诉总数</span><strong>{{ appealStat.total || 0 }}</strong></div>
        <div class="stat"><span>未结</span><strong :class="appealStat.open ? 'amt-orange' : ''">{{ appealStat.open || 0 }}</strong></div>
        <div class="stat"><span>超期未办</span><strong :class="appealStat.overdue ? 'amt-red' : ''">{{ appealStat.overdue || 0 }}</strong><small>3 天未受理</small></div>
        <div class="stat"><span>调整 / 撤销</span><strong class="amt-green">{{ (appealStat.adjusted || 0) + (appealStat.revoked || 0) }}</strong><small>改分成功</small></div>
        <div class="stat"><span>维持原判</span><strong>{{ appealStat.upheld || 0 }}</strong></div>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 140px">申诉号</th><th style="width: 90px">员工</th>
              <th style="width: 150px">指标</th><th style="width: 120px">类型</th>
              <th style="width: 70px" class="num">原分</th><th style="width: 70px" class="num">新分</th>
              <th>理由</th><th style="width: 110px">状态</th>
              <th style="width: 110px">复核人</th><th style="width: 200px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in appeals" :key="a.id" :class="{ 'row-warn': a.overdue }">
              <td class="mono">{{ a.appeal_no }}<div class="tiny">{{ a.cycle_no }}</div></td>
              <td>{{ a.employee_name }}</td>
              <td>{{ a.rule_name || '-' }}</td>
              <td class="tiny">{{ a.reason_type_label }}</td>
              <td class="num amt-red">-{{ a.original_score }}</td>
              <td class="num" :class="a.new_score !== null && a.new_score !== undefined ? 'amt-green' : ''">
                {{ a.new_score === null || a.new_score === undefined ? '-' : '-' + a.new_score }}
              </td>
              <td class="tiny wrap">{{ a.reason }}
                <div v-if="a.evidence" class="muted">证据：{{ a.evidence }}</div>
                <div v-if="a.decision_note" class="muted">复核意见：{{ a.decision_note }}</div>
              </td>
              <td>
                <span class="tag" :class="a.status === 'decided' ? 'green' : a.overdue ? 'red' : 'orange'">{{ a.status_label }}</span>
                <div v-if="a.overdue" class="tiny amt-red">超期未受理</div>
              </td>
              <td class="tiny">{{ a.reviewer || '-' }}</td>
              <td>
                <button v-if="canReview && a.status === 'submitted'" class="link-btn" @click="acceptAppeal(a)">受理</button>
                <button v-if="canReview && (a.status === 'submitted' || a.status === 'accepted')" class="link-btn" @click="decideAppeal(a)">复核</button>
                <button v-if="a.status === 'submitted'" class="link-btn danger" @click="withdrawAppeal(a)">撤回</button>
              </td>
            </tr>
            <tr v-if="!appeals.length"><td colspan="10" class="empty-cell">没有申诉记录</td></tr>
          </tbody>
        </table>
      </div>
      <p class="hint-bar" style="margin-top: 12px">
        申诉口径：申诉后保留原记录并标「争议中」，分数变暂定；<b>复核人不能是原扣分确认人</b>，涉及主管本人转上一级/人事；
        复核只能调低或撤销，不能加重；逾期只提醒，<b>不自动判员工败诉</b>。
      </p>
    </div>

    <!-- ================= 个人绩效明细 ================= -->
    <div v-if="cur" class="modal-mask" @click.self="cur = null">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>
            {{ cur.employee_name }} · {{ cur.cycle_no }} 绩效明细
            <span class="tag" :class="scoreTag(cur.status)">{{ cur.status_label }}</span>
            <span v-if="cur.provisional" class="tag orange">暂定</span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <div class="score-head">
            <div class="score-big">
              <span>当前分</span>
              <b :class="scoreClass(cur.current_score)">{{ cur.current_score === null ? '-' : cur.current_score }}</b>
              <small v-if="cur.provisional">暂定（有未结申诉）</small>
              <small v-else-if="cur.status === 'closed'">已定版（周期冻结）</small>
            </div>
            <div class="score-formula">
              基准 <b>{{ cur.base_score }}</b> − 已确认扣分 <b class="amt-red">{{ cur.confirmed_score }}</b>
              <span class="muted"> ＝ 当前分 {{ cur.current_score }}</span>
              <div class="tiny muted">
                建议扣分 {{ cur.suggested_score }}（未复核，不计入）· 待复核 {{ cur.pending_score }} ·
                申诉中 {{ cur.appeal_score }}
              </div>
            </div>
            <div class="score-meta">
              <div>模板：{{ cur.template ? cur.template.template_no + ' V' + cur.template.version : '-' }}</div>
              <div>周期：{{ cur.cycle ? cur.cycle.start_date + ' ~ ' + cur.cycle.end_date : '-' }}
                <span class="tag gray">{{ cur.cycle ? cur.cycle.status_label : '' }}</span>
              </div>
              <div v-if="cur.notice" class="amt-orange tiny">{{ cur.notice }}</div>
            </div>
          </div>

          <h4 class="sec-title">扣分明细（{{ cur.items.length }} 项）</h4>
          <div class="table-wrap">
            <table class="data item-tbl">
              <thead>
                <tr>
                  <th style="width: 150px">指标</th><th style="width: 80px">类别</th>
                  <th style="width: 100px" class="num">目标 / 实际</th>
                  <th style="width: 66px" class="num">建议</th>
                  <th style="width: 66px" class="num">确认</th>
                  <th>证据</th>
                  <th style="width: 96px">复核</th>
                  <th style="width: 96px">申诉</th>
                  <th style="width: 190px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in cur.items" :key="it.id" :class="{ 'row-warn': it.appeal_status === 'appealing' }">
                  <td>{{ it.rule_name }}<div class="tiny muted">{{ it.rule_code || '' }}</div></td>
                  <td class="tiny">{{ cur.category_labels[it.category] || it.category || '-' }}</td>
                  <td class="num tiny">
                    {{ it.target_value === null ? '—' : it.target_value + unitOf(it) }} /
                    {{ it.actual_value === null ? '—' : it.actual_value + unitOf(it) }}
                  </td>
                  <td class="num" :class="it.suggested_score ? 'amt-orange' : 'muted'">{{ it.suggested_score || 0 }}</td>
                  <td class="num" :class="it.effective_score ? 'amt-red' : 'muted'">{{ it.effective_score || 0 }}</td>
                  <td class="tiny wrap">{{ it.evidence }}
                    <div v-if="it.review_note" class="muted">复核意见：{{ it.review_note }}</div>
                  </td>
                  <td><span class="tag" :class="reviewTag(it.review_status)">{{ it.review_label }}</span></td>
                  <td>
                    <span class="tag" :class="it.appeal_status === 'appealing' ? 'orange' : it.appeal_status === 'none' ? 'gray' : 'green'">
                      {{ it.appeal_label }}
                    </span>
                  </td>
                  <td class="ops">
                    <template v-if="canReview && it.review_status === 'pending'">
                      <button class="link-btn" @click="confirmItem(it)">确认</button>
                      <button class="link-btn danger" @click="rejectItem(it)">驳回</button>
                    </template>
                    <button v-if="it.review_status === 'confirmed' && it.appeal_status === 'none'" class="link-btn" @click="openAppeal(it)">提交申诉</button>
                    <span v-if="it.review_status === 'unconfigured'" class="tiny muted">时限未核定，待配置</span>
                  </td>
                </tr>
                <tr v-if="!cur.items.length"><td colspan="9" class="empty-cell">本期没有产生扣分项（达标或无数据）</td></tr>
              </tbody>
            </table>
          </div>

          <div v-if="cur.appeals && cur.appeals.length" class="block">
            <h4 class="sec-title">申诉记录</h4>
            <div v-for="a in cur.appeals" :key="a.id" class="appeal-row">
              <span class="tag" :class="a.decision === 'pending' ? 'orange' : 'green'">{{ a.status_label }}</span>
              <b>{{ a.appeal_no }}</b>
              <span class="tiny">{{ a.reason_type_label }}</span>
              <span class="tiny muted">{{ a.reason }}</span>
              <span class="tiny">
                原扣 {{ a.original_score }}
                <template v-if="a.decision !== 'pending'"> → {{ a.decision_label }} {{ a.new_score }}</template>
              </span>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="cur = null">关闭</button>
          <button v-if="canReview && !cycleFrozen && cur.status !== 'confirmed' && cur.status !== 'closed'"
                  class="btn btn-primary" @click="confirmScore(cur)">确认这张单</button>
        </div>
      </div>
    </div>

    <!-- ================= 模板详情 ================= -->
    <div v-if="tpl" class="modal-mask" @click.self="tpl = null">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>{{ tpl.name }} <span class="tag gray">V{{ tpl.version }}</span>
            <span class="tag" :class="tplTag(tpl.status)">{{ tpl.status_label }}</span>
          </h3>
          <button class="x" @click="tpl = null">×</button>
        </div>
        <div class="modal-body">
          <p class="hint-bar" v-if="tpl.locked_reason">{{ tpl.locked_reason }}</p>
          <div class="tpl-meta">
            <span>岗位族 <b>{{ tpl.job_family }}</b></span>
            <span>岗位 <b>{{ tpl.job_title || '整族通用' }}</b></span>
            <span>部门 <b>{{ tpl.department_name || '全公司' }}</b></span>
            <span>基准分 <b>{{ tpl.base_score }}</b></span>
            <span>权重合计 <b :class="Math.abs(tpl.weight_sum - 100) < 0.01 ? 'amt-green' : 'amt-red'">{{ tpl.weight_sum }}%</b></span>
          </div>
          <div class="table-wrap">
            <table class="data rule-tbl">
              <thead>
                <tr>
                  <th style="width: 130px">指标</th><th style="width: 66px">类别</th>
                  <th style="width: 54px" class="num">权重</th>
                  <th style="width: 92px" class="num">目标</th>
                  <th style="min-width: 170px">定义 / 计算口径</th>
                  <th style="width: 110px">数据源</th>
                  <th style="width: 66px" class="num">扣分上限</th>
                  <th style="width: 88px">复核人</th>
                  <th style="min-width: 150px">例外条件</th>
                  <th style="width: 90px">完整性</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in tpl.rules" :key="r.id">
                  <td>{{ r.name }}<div class="tiny muted">{{ r.code || '' }}</div></td>
                  <td class="tiny">{{ r.category_label }}</td>
                  <td class="num">{{ r.weight }}%</td>
                  <td class="num tiny">{{ r.target_value === null ? '待配置' : r.target_value + (r.unit || '') }}</td>
                  <td class="tiny wrap"><b>{{ r.definition }}</b><div class="muted">{{ r.formula }}</div></td>
                  <td class="tiny">{{ r.data_source_label }}</td>
                  <td class="num">{{ r.cap_score }}</td>
                  <td class="tiny">{{ r.reviewer || '-' }}</td>
                  <td class="tiny wrap muted">{{ r.exception_note || '-' }}</td>
                  <td>
                    <span v-if="!r.missing.length" class="tag green">齐全</span>
                    <span v-else class="tag red">缺 {{ r.missing.join('/') }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="block" v-if="tpl.versions && tpl.versions.length > 1">
            <h4 class="sec-title">版本历史</h4>
            <div class="ver-row" v-for="v in tpl.versions" :key="v.id">
              <b>V{{ v.version }}</b><span class="mono tiny">{{ v.template_no }}</span>
              <span class="tag" :class="tplTag(v.status)">{{ statusLabel(v.status) }}</span>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="tpl = null">关闭</button>
          <button v-if="canWrite && tpl.status === 'draft'" class="btn btn-primary" @click="submitTemplate(tpl); tpl = null">提交审批</button>
        </div>
      </div>
    </div>

    <!-- ================= 新建模板 ================= -->
    <div v-if="tplForm" class="modal-mask" @click.self="tplForm = null">
      <div class="modal">
        <div class="modal-head"><h3>新建绩效模板</h3><button class="x" @click="tplForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full"><label>模板名称 *</label><input class="input" v-model="tplForm.name" placeholder="缝制岗位周度绩效" /></div>
            <div class="fitem">
              <label>岗位族 *</label>
              <select class="select" v-model="tplForm.job_family">
                <option v-for="f in dict.job_families" :key="f" :value="f">{{ f }}</option>
              </select>
            </div>
            <div class="fitem"><label>具体岗位（可空）</label><input class="input" v-model="tplForm.job_title" placeholder="留空表示整族通用" /></div>
            <div class="fitem">
              <label>部门</label>
              <select class="select" v-model.number="tplForm.department_id">
                <option :value="null">全公司</option>
                <option v-for="d in deps" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>周期基准分 *</label><input class="input" type="number" v-model.number="tplForm.base_score" /></div>
            <div class="fitem full"><label>说明</label><input class="input" v-model="tplForm.remark" /></div>
          </div>
          <p class="hint-bar">建完后在「查看规则」里配置指标；指标定义/口径/数据源/扣分上限/复核人缺一项不许提交审批。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="tplForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveTemplate">创建</button>
        </div>
      </div>
    </div>

    <!-- ================= 模拟试算 ================= -->
    <div v-if="sim" class="modal-mask" @click.self="sim = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>模拟试算 · {{ sim.template.name }} V{{ sim.template.version }}
            <span class="tag orange">{{ sim.template.status_label }}</span>
          </h3>
          <button class="x" @click="sim = null">×</button>
        </div>
        <div class="modal-body">
          <p class="hint-bar amt-orange">{{ sim.notice }}</p>
          <p class="tiny muted">试算周期：{{ sim.cycle.cycle_no }}（{{ sim.cycle.start_date }} ~ {{ sim.cycle.end_date }}）</p>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th style="width: 110px">员工</th><th style="width: 90px">岗位</th><th class="num" style="width: 80px">建议合计</th><th class="num" style="width: 90px">试算分</th><th>逐项</th></tr></thead>
              <tbody>
                <tr v-for="r in sim.rows" :key="r.employee_id">
                  <td>{{ r.employee_name }}</td>
                  <td class="tiny">{{ r.position }}</td>
                  <td class="num" :class="r.suggested_total ? 'amt-orange' : 'muted'">{{ r.suggested_total ? '-' + r.suggested_total : '0' }}</td>
                  <td class="num"><b>{{ r.simulated_score }}</b></td>
                  <td class="tiny wrap">
                    <span v-for="(d, i) in r.detail" :key="i" class="sim-item">
                      {{ d.rule }}：{{ d.unconfigured ? '待配置（不扣）' : (d.suggested ? '-' + d.suggested + ' 分（' + d.note + '）' : '达标') }}
                    </span>
                  </td>
                </tr>
                <tr v-if="!sim.rows.length"><td colspan="5" class="empty-cell">这个岗位族下没有在职员工</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="sim = null">关闭</button></div>
      </div>
    </div>

    <!-- ================= 提交申诉 ================= -->
    <div v-if="appealForm" class="modal-mask" @click.self="appealForm = null">
      <div class="modal">
        <div class="modal-head"><h3>提交绩效申诉</h3><button class="x" @click="appealForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">
            扣分项：<b>{{ appealForm.item.rule_name }}</b>（扣 {{ appealForm.item.confirmed_score }} 分）<br />
            提交后原记录保留并标「争议中」，逾期也只提醒，不自动判员工败诉。
          </p>
          <div class="form-grid">
            <div class="fitem">
              <label>申诉类型 *</label>
              <select class="select" v-model="appealForm.reason_type">
                <option v-for="(label, k) in dict.reason_types" :key="k" :value="k">{{ label }}</option>
              </select>
            </div>
            <div class="fitem"><label>提交人</label><input class="input" v-model="appealForm.submitted_by" placeholder="员工本人 / 人事代登记" /></div>
            <div class="fitem full"><label>申诉理由 *</label><textarea v-model="appealForm.reason" rows="3" placeholder="说清任务归属、数据错误、外部依赖、截止变更或证据不足"></textarea></div>
            <div class="fitem full"><label>补充证据</label><textarea v-model="appealForm.evidence" rows="2" placeholder="检验记录号、邮件、来料报告…"></textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="appealForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitAppeal">提交申诉</button>
        </div>
      </div>
    </div>

    <!-- ================= 独立复核 ================= -->
    <div v-if="decideForm" class="modal-mask" @click.self="decideForm = null">
      <div class="modal">
        <div class="modal-head"><h3>申诉复核 · {{ decideForm.appeal.appeal_no }}</h3><button class="x" @click="decideForm = null">×</button></div>
        <div class="modal-body">
          <p class="hint-bar">
            {{ decideForm.appeal.employee_name }} 对「{{ decideForm.appeal.rule_name }}」扣
            {{ decideForm.appeal.original_score }} 分提出申诉：<br />
            <b>{{ decideForm.appeal.reason_type_label }}</b> · {{ decideForm.appeal.reason }}
            <div v-if="decideForm.appeal.evidence" class="muted tiny">证据：{{ decideForm.appeal.evidence }}</div>
            <div class="tiny amt-orange" style="margin-top: 6px">
              原扣分确认人：{{ decideForm.appeal.item_reviewed_by || '-' }}（复核人不能是同一人）
            </div>
          </p>
          <div class="form-grid">
            <div class="fitem">
              <label>复核结论 *</label>
              <select class="select" v-model="decideForm.decision">
                <option value="uphold">维持原判（扣分不变）</option>
                <option value="reduce">调整（调低扣分）</option>
                <option value="revoke">撤销（扣分归零）</option>
              </select>
            </div>
            <div class="fitem">
              <label>调整后扣分</label>
              <input class="input" type="number" min="0" v-model.number="decideForm.new_score" :disabled="decideForm.decision !== 'reduce'" />
            </div>
            <div class="fitem"><label>复核人 *</label><input class="input" v-model="decideForm.reviewer" placeholder="不能与原确认人相同" /></div>
            <div class="fitem full"><label>复核理由 *（记录改分前后值）</label><textarea v-model="decideForm.note" rows="3" placeholder="核对证据后为什么维持 / 调低 / 撤销"></textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="decideForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitDecide">提交复核</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('kpi.write'));
const canReview = computed(() => can('kpi.review'));

const tab = ref('score');
const cycleId = ref(null);
const q = ref('');
const cycles = ref([]);
const cycle = ref(null);
const board = reactive({ rows: [], pending: [], appeals: [], stat: {}, cycle: null });
const scores = ref([]);
const templates = ref([]);
const appeals = ref([]);
const appealStat = ref({});
const dict = ref({ job_families: [], reason_types: {}, categories: {} });
const deps = ref([]);
const cur = ref(null);
const tpl = ref(null);
const sim = ref(null);
const saving = ref(false);
const tplForm = ref(null);
const appealForm = ref(null);
const decideForm = ref(null);

const cycleFrozen = computed(() => !!(cycle.value && cycle.value.status === 'frozen'));
const avgClass = computed(() => {
  const v = board.stat.avg_score;
  if (v === null || v === undefined) return '';
  return v >= 95 ? 'amt-green' : v >= 90 ? '' : 'amt-red';
});

function fmt(v) { return v === null || v === undefined ? 0 : Math.round(Number(v) * 100) / 100; }
function unitOf(it) {
  return (it.rule_snapshot && it.rule_snapshot.unit) || '';
}
function scoreClass(v) { return v === null || v === undefined ? '' : v >= 95 ? 'amt-green' : v >= 90 ? 'amt-orange' : 'amt-red'; }
function barWidth(v) { return Math.max(0, Math.min(100, Number(v) || 0)) + '%'; }
function scoreTag(s) { return { draft: 'gray', pending_review: 'orange', confirmed: 'green', appealing: 'red', closed: 'gray' }[s] || 'gray'; }
function reviewTag(s) { return { pending: 'orange', confirmed: 'green', rejected: 'gray', unconfigured: 'red' }[s] || 'gray'; }
function tplTag(s) { return { draft: 'gray', pending_review: 'orange', approved: 'green', retired: 'gray' }[s] || 'gray'; }
function statusLabel(s) { return { draft: '草稿', pending_review: '待复核', approved: '已批准', retired: '已停用' }[s] || s; }

async function loadCycles() {
  cycles.value = await api.kpiCycles();
  if (!cycles.value.length && canWrite.value) {
    await api.kpiCreateCycle({ weeks: 3 });
    cycles.value = await api.kpiCycles();
  }
  if (!cycleId.value && cycles.value.length) {
    // 默认选「今天所在的那一周」，没有就取最近一周（不要落到最早的历史周期）
    const today = new Date();
    const t = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const inRange = cycles.value.find((c) => c.start_date <= t && c.end_date >= t);
    const open = cycles.value.find((c) => c.status !== 'frozen');
    const newest = cycles.value.slice().sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
    cycleId.value = (inRange || open || newest).id;
  }
  cycle.value = cycles.value.find((c) => c.id === cycleId.value) || null;
}

async function loadScores() {
  const d = await api.kpiScores({ cycle_id: cycleId.value, q: q.value });
  cycle.value = d.cycle;
  scores.value = d.rows || [];
  Object.assign(board, {
    stat: d.stat || {}, cycle: d.cycle,
    pending: board.pending, rows: scores.value
  });
}

async function loadBoard() {
  if (!cycleId.value) return;
  const d = await api.kpiBoard({ cycle_id: cycleId.value });
  Object.assign(board, d);
  scores.value = d.rows || [];
  if (d.cycle) cycle.value = d.cycle;
}

async function loadTemplates() {
  const d = await api.kpiTemplates();
  templates.value = d.rows || [];
}

async function loadAppeals() {
  const d = await api.kpiAppeals({ cycle_id: cycleId.value });
  appeals.value = d.rows || [];
  appealStat.value = d.stat || {};
}

async function reloadAll() {
  await loadCycles();
  if (tab.value === 'score') await loadBoard();
  if (tab.value === 'rule') await loadTemplates();
  if (tab.value === 'appeal') await loadAppeals();
  if (cycleId.value) {
    const b = await api.kpiBoard({ cycle_id: cycleId.value });
    board.stat = b.stat || {};
    board.cycle = b.cycle;
  }
}

async function generate() {
  if (!cycleId.value) return alert('请先选择或生成考核周期');
  if (!confirm(`按当前已批准模板生成本期绩效？\n\n只会生成「建议扣分」，不计入当前分，需主管逐项复核。`)) return;
  try {
    const r = await api.kpiGenerate({ cycle_id: cycleId.value });
    await reloadAll();
    const lines = (r.results || []).map((x) => x.skipped
      ? `${x.employee_name}：跳过（${x.skipped}）`
      : `${x.employee_name}：新增 ${x.added} 项，建议扣 ${x.suggested_score} 分`);
    alert(`${r.notice}\n\n${lines.join('\n')}`);
  } catch (e) { alert(e.message); }
}

async function createCycle() {
  const n = prompt('生成最近几周的考核周期？（1-26）', '3');
  if (!n) return;
  try {
    const r = await api.kpiCreateCycle({ weeks: Number(n) });
    await loadCycles();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function freezeCycle() {
  if (!confirm('冻结本周？冻结后分数定版，规则版本不再追溯，待复核项必须先复核完。')) return;
  try {
    const r = await api.kpiFreezeCycle(cycleId.value);
    await reloadAll();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function openScore(s) {
  try {
    cur.value = await api.kpiScore(s.id);
  } catch (e) { alert(e.message); }
}

async function openScoreById(id) {
  const s = scores.value.find((x) => x.id === id) || { id };
  await openScore(s);
}

async function confirmItem(it) {
  const v = prompt(`确认扣分：「${it.rule_name}」\n建议扣 ${it.suggested_score} 分\n\n确认扣分（不能高于建议分）：`, it.suggested_score);
  if (v === null) return;
  const note = prompt('复核依据（写清核对了什么证据）：', '已核对报工与考勤记录');
  if (note === null) return;
  try {
    const r = await api.kpiConfirmItem(it.id, { action: 'confirm', confirmed_score: Number(v), note });
    if (cur.value) cur.value = await api.kpiScore(cur.value.id);
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function rejectItem(it) {
  const reason = prompt(`驳回「${it.rule_name}」的扣分建议，原因（非本人责任 / 证据不足 / 已登记外部依赖…）：`);
  if (reason === null) return;
  if (!String(reason).trim()) return alert('驳回必须写原因');
  try {
    const r = await api.kpiRejectItem(it.id, { action: 'reject', note: reason });
    if (cur.value) cur.value = await api.kpiScore(cur.value.id);
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function confirmScore(s) {
  try {
    const r = await api.kpiConfirmScore(s.id);
    if (cur.value) cur.value = await api.kpiScore(cur.value.id);
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

function openTemplate(t) {
  api.kpiTemplate(t.id).then((d) => { tpl.value = d; }).catch((e) => alert(e.message));
}

function openTemplateForm() {
  tplForm.value = { name: '', job_family: '缝制', job_title: '', department_id: null, base_score: 100, remark: '' };
}

async function saveTemplate() {
  if (!tplForm.value.name) return alert('请填模板名称');
  saving.value = true;
  try {
    const r = await api.kpiCreateTemplate({ ...tplForm.value });
    tplForm.value = null;
    await loadTemplates();
    alert(r.notice);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function submitTemplate(t) {
  try {
    const r = await api.kpiSubmitTemplate(t.id);
    await loadTemplates();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function approveTemplate(t) {
  if (!confirm(`批准「${t.name} V${t.version}」并发布？\n\n批准后同岗位族的旧版本会转「已停用」，历史周期仍按旧版本结算。`)) return;
  try {
    const r = await api.kpiApproveTemplate(t.id, { agree: true });
    await loadTemplates();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function rejectTemplate(t) {
  const note = prompt('驳回原因：');
  if (note === null) return;
  if (!String(note).trim()) return alert('驳回必须写原因');
  try {
    const r = await api.kpiApproveTemplate(t.id, { agree: false, note });
    await loadTemplates();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function newVersion(t) {
  if (!confirm(`基于「${t.name} V${t.version}」出 V${Number(t.version) + 1} 草稿？\n\n旧版本继续用于已冻结周期。`)) return;
  try {
    const r = await api.kpiNewVersion(t.id);
    await loadTemplates();
    alert(r.notice);
  } catch (e) { alert(e.message); }
}

async function simulate(t) {
  try {
    sim.value = await api.kpiSimulate(t.id, { cycle_id: cycleId.value });
  } catch (e) { alert(e.message); }
}

function openAppeal(it) {
  appealForm.value = {
    item: it, reason_type: 'task_own', submitted_by: cur.value ? cur.value.employee_name : '',
    reason: '', evidence: ''
  };
}

async function submitAppeal() {
  const f = appealForm.value;
  if (!f.reason || f.reason.trim().length < 4) return alert('请把申诉理由写清楚');
  saving.value = true;
  try {
    const r = await api.kpiCreateAppeal({ item_id: f.item.id, reason_type: f.reason_type, reason: f.reason, evidence: f.evidence });
    appealForm.value = null;
    if (cur.value) cur.value = await api.kpiScore(cur.value.id);
    await loadBoard();
    alert(`${r.notice}\n申诉号 ${r.appeal_no}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function acceptAppeal(a) {
  try {
    await api.kpiAcceptAppeal(a.id);
    await loadAppeals();
    alert('已受理，转独立复核');
  } catch (e) { alert(e.message); }
}

function decideAppeal(a) {
  decideForm.value = {
    appeal: a, decision: 'uphold', new_score: 0,
    reviewer: a.item_reviewed_by ? '' : 'admin',
    note: ''
  };
}

async function submitDecide() {
  const f = decideForm.value;
  if (!f.note || !f.note.trim()) return alert('复核必须写理由');
  if (!f.reviewer || !f.reviewer.trim()) return alert('请填复核人');
  saving.value = true;
  try {
    const r = await api.kpiDecideAppeal(f.appeal.id, {
      decision: f.decision, new_score: f.new_score, reviewer: f.reviewer.trim(), note: f.note
    });
    decideForm.value = null;
    await loadAppeals();
    await loadBoard();
    alert(r.notice);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function withdrawAppeal(a) {
  if (!confirm('撤回这条申诉？撤回后扣分保持不变。')) return;
  try {
    await api.kpiWithdrawAppeal(a.id);
    await loadAppeals();
    alert('已撤回');
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  try { dict.value = await api.kpiDict(); } catch (e) { /* ignore */ }
  try { deps.value = await api.departments(); } catch (e) { deps.value = []; }
  await loadCycles();
  if (tab.value === 'score') await loadBoard();
  if (!board.stat || board.stat.people === undefined) {
    await loadScores();
  }
  // 申诉计数用于页签角标
  try {
    const ap = await api.kpiAppeals({});
    appealStat.value = ap.stat || {};
  } catch (e) { /* ignore */ }
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.warn { color: #d97706; }
.tiny { font-size: 11.5px; }
.wrap { white-space: normal; line-height: 1.55; min-width: 160px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.row-warn { background: #fffaf2; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 12px; }
.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.sec-title { margin: 16px 0 8px; font-size: 13px; color: #16233b; }

.score-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.score-cell b { font-size: 17px; }
.bar { width: 100%; height: 5px; background: #eef2f8; border-radius: 3px; overflow: hidden; margin-top: 3px; }
.bar i { display: block; height: 100%; background: #2b6de5; border-radius: 3px; }
.bar i.amt-green { background: #16a34a; }
.bar i.amt-orange { background: #d97706; }
.bar i.amt-red { background: #d92d45; }

.score-tbl { min-width: 1180px; }
.item-tbl { min-width: 1040px; }
.rule-tbl { min-width: 1060px; }
.ops { white-space: nowrap; }

.score-head { display: grid; grid-template-columns: 170px 1fr 300px; gap: 16px; align-items: start;
  background: #f8fafd; border: 1px solid #e8eef7; border-radius: 12px; padding: 14px 16px; margin-bottom: 6px; }
.score-big span { display: block; font-size: 12px; color: #8a94a6; }
.score-big b { font-size: 34px; line-height: 1.1; }
.score-big small { display: block; font-size: 11.5px; color: #d97706; margin-top: 2px; }
.score-formula { font-size: 13px; color: #33415a; line-height: 1.8; }
.score-meta { font-size: 12px; color: #6b7688; line-height: 1.9; text-align: right; }
.appeal-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed #eef2f7; flex-wrap: wrap; }
.appeal-row:last-child { border-bottom: none; }
.tpl-meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; color: #5b6474; background: #f8fafd;
  border: 1px solid #e8eef7; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; }
.tpl-meta b { color: #16233b; }
.ver-row { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 5px 0; }
.sim-item { display: block; padding: 1px 0; }
@media (max-width: 1280px) { .stat-row { grid-template-columns: repeat(3, 1fr); } .score-head { grid-template-columns: 1fr; } .score-meta { text-align: left; } }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } }
</style>
