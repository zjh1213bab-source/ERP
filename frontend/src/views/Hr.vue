<template>
  <div>
    <div class="page-head">
      <div>
        <h2>招聘与合同</h2>
        <div class="sub">招聘入职 · 转调离 · 劳动合同与续签 · 调薪</div>
      </div>
      <button class="btn btn-ghost" @click="loadAll">刷新</button>
    </div>

    <div v-if="s.warnings && s.warnings.length" class="alert-bar">
      <div v-for="(w, i) in s.warnings" :key="i" style="margin: 2px 0">⚠️ {{ w }}</div>
    </div>

    <div class="cards">
      <div class="stat-card">
        <div class="label">在招需求 / 缺口</div>
        <div class="value">{{ (s.recruit && s.recruit.open_req) || 0 }}<small>/ {{ (s.recruit && s.recruit.open_head) || 0 }} 人</small></div>
        <div class="delta">候选人管道 {{ (s.recruit && s.recruit.pipeline) || 0 }} 人</div>
      </div>
      <div class="stat-card" :class="(s.contracts && s.contracts.expiring30) ? 'accent' : ''">
        <div class="label">合同 30 天内到期</div>
        <div class="value">{{ (s.contracts && s.contracts.expiring30) || 0 }}<small>份</small></div>
        <div class="delta">已过期 {{ (s.contracts && s.contracts.expired) || 0 }} · 90 天内 {{ (s.contracts && s.contracts.expiring90) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">合同未交付</div>
        <div class="value">{{ (s.contracts && s.contracts.undelivered) || 0 }}<small>份</small></div>
        <div class="delta">需双方各执一份</div>
      </div>
      <div class="stat-card">
        <div class="label">待生效异动</div>
        <div class="value">{{ (s.movements && s.movements.pending) || 0 }}<small>项</small></div>
        <div class="delta">已调岗 {{ (s.movements && s.movements.moved) || 0 }} · 离职 {{ (s.movements && s.movements.resigned) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">调薪待生效</div>
        <div class="value">{{ ((s.adjustments && s.adjustments.draft) || 0) + ((s.adjustments && s.adjustments.approved) || 0) }}<small>条</small></div>
        <div class="delta">累计月增 ¥{{ money(s.adjustments && s.adjustments.salary_delta) }}</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <!-- ==================== 招聘 ==================== -->
    <template v-if="tab === 'recruit'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="recruitStatus" @change="loadRecruitments">
          <option value="">全部状态</option>
          <option value="open">在招</option>
          <option value="paused">暂停</option>
          <option value="closed">已关闭</option>
        </select>
        <button class="btn btn-ghost" @click="loadRecruitments">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openRecruit()">＋ 新增招聘需求</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        需求人数与已到岗分开记，<strong>招满自动关闭</strong>；候选人从「已投递」推进到「已入职」后，系统直接生成员工档案并回写到岗人数。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>需求单</th><th>岗位 / 部门</th><th>需求 / 到岗</th><th>缺口</th><th>候选人</th><th>薪资范围</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in recruitments" :key="r.id">
              <td class="nowrap"><strong>{{ r.req_no }}</strong><div class="muted" style="font-size: 12px">{{ $fmtDate(r.opened_at) }} 起 · {{ r.opened_days }} 天</div></td>
              <td class="nowrap">{{ r.position }}<div class="muted" style="font-size: 12px">{{ r.department_name || '-' }}</div></td>
              <td class="nowrap">{{ r.headcount }} / {{ r.hired }}</td>
              <td class="num"><span :style="r.gap > 0 ? '' : 'color:#1e874b;font-weight:700'">{{ r.gap }}</span></td>
              <td class="nowrap">{{ r.candidates }} 人<div class="muted" style="font-size: 12px">在流程 {{ r.pipeline }}</div></td>
              <td class="nowrap">{{ r.salary_range || '-' }}</td>
              <td class="nowrap"><span class="tag" :class="r.status === 'open' ? 'green' : r.status === 'paused' ? 'orange' : 'gray'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button class="link-btn" @click="openCandidates(r)">候选人</button>
                <button class="link-btn" @click="openRecruit(r)">编辑</button>
                <button class="link-btn danger" @click="removeRecruit(r)">删除</button>
              </td>
            </tr>
            <tr v-if="!recruitments.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无招聘需求</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 需求弹窗 -->
      <div v-if="recruitModal" class="modal-mask" @click.self="recruitModal = false">
        <div class="modal">
          <div class="modal-head"><h3>{{ recruitForm.id ? '编辑招聘需求' : '新增招聘需求' }}</h3><button class="link-btn" @click="recruitModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>岗位 *</label><input class="input" v-model="recruitForm.position" /></div>
              <div class="fitem"><label>部门</label>
                <select class="select" v-model.number="recruitForm.department_id">
                  <option :value="null">— 未指定 —</option>
                  <option v-for="d in departments" :key="d.id" :value="d.id">{{ d.name }}</option>
                </select>
              </div>
              <div class="fitem"><label>需求人数</label><input class="input" type="number" v-model.number="recruitForm.headcount" /></div>
              <div class="fitem"><label>薪资范围</label><input class="input" v-model="recruitForm.salary_range" placeholder="8-11K" /></div>
              <div class="fitem"><label>招聘渠道</label><input class="input" v-model="recruitForm.channel" /></div>
              <div class="fitem"><label>负责人</label><input class="input" v-model="recruitForm.owner" /></div>
              <div class="fitem full"><label>任职要求</label><textarea v-model="recruitForm.requirement" rows="2"></textarea></div>
              <div class="fitem"><label>状态</label>
                <select class="select" v-model="recruitForm.status">
                  <option value="open">在招</option>
                  <option value="paused">暂停</option>
                  <option value="closed">已关闭</option>
                </select>
              </div>
              <div class="fitem"><label>备注</label><input class="input" v-model="recruitForm.remark" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="recruitModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveRecruit">保存</button>
          </div>
        </div>
      </div>

      <!-- 候选人弹窗 -->
      <div v-if="candModal" class="modal-mask" @click.self="candModal = false">
        <div class="modal xwide">
          <div class="modal-head">
            <h3>候选人 · {{ currentRecruit && currentRecruit.position }}</h3>
            <button class="link-btn" @click="candModal = false">关闭</button>
          </div>
          <div class="modal-body">
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>姓名</th><th>来源</th><th>期望 / Offer</th><th>阶段</th><th>面试记录</th><th v-if="canWrite">操作</th></tr></thead>
                <tbody>
                  <tr v-for="c in candidates" :key="c.id">
                    <td class="nowrap"><strong>{{ c.name }}</strong><div class="muted" style="font-size: 12px">{{ c.phone || '-' }}</div></td>
                    <td class="nowrap">{{ c.source || '-' }}</td>
                    <td class="num">¥{{ money(c.expected_salary) }}<div class="muted" style="font-size: 11.5px">offer ¥{{ money(c.offer_salary) }}</div></td>
                    <td class="nowrap"><span class="tag" :class="candTag(c.stage)">{{ c.stage_label }}</span></td>
                    <td style="max-width: 220px; white-space: normal">{{ c.interview_note || '-' }}</td>
                    <td v-if="canWrite" class="nowrap">
                      <button v-if="c.stage === 'applied'" class="link-btn" @click="advanceCand(c, 'interview')">进入面试</button>
                      <button v-if="c.stage === 'interview'" class="link-btn" @click="advanceCand(c, 'offer')">发 offer</button>
                      <button v-if="c.stage === 'offer'" class="link-btn" @click="doHire(c)">办理入职</button>
                      <button v-if="!['hired','rejected'].includes(c.stage)" class="link-btn danger" @click="advanceCand(c, 'rejected')">不通过</button>
                    </td>
                  </tr>
                  <tr v-if="!candidates.length"><td :colspan="canWrite ? 6 : 5" class="empty-cell">暂无候选人</td></tr>
                </tbody>
              </table>
            </div>

            <div v-if="canWrite" class="form-grid" style="margin-top: 14px">
              <div class="fitem"><label>候选人姓名</label><input class="input" v-model="candForm.name" /></div>
              <div class="fitem"><label>电话</label><input class="input" v-model="candForm.phone" /></div>
              <div class="fitem"><label>来源</label><input class="input" v-model="candForm.source" /></div>
              <div class="fitem"><label>期望薪资</label><input class="input" type="number" v-model.number="candForm.expected_salary" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button v-if="canWrite" class="btn btn-ghost" @click="addCandidate">＋ 添加候选人</button>
            <button class="btn btn-primary" @click="candModal = false">完成</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 转调离 ==================== -->
    <template v-if="tab === 'movement'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="movType" @change="loadMovements">
          <option value="">全部类型</option>
          <option value="onboard">入职</option>
          <option value="regular">转正</option>
          <option value="transfer">调岗</option>
          <option value="promote">晋升</option>
          <option value="resign">离职</option>
        </select>
        <select class="select" v-model="movStatus" @change="loadMovements">
          <option value="">全部状态</option>
          <option value="pending">待生效</option>
          <option value="effective">已生效</option>
          <option value="cancelled">已撤销</option>
        </select>
        <button class="btn btn-ghost" @click="loadMovements">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openMovement()">＋ 新建异动</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        <strong>生效才改档案</strong>：生效日未到会先挂「待生效」，避免提前把部门岗位改错；离职必须先填交接清单，离职生效时未到期的劳动合同自动置「已解除」。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>异动单</th><th>员工</th><th>类型</th><th>生效日</th><th>变动内容</th><th>交接</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in movements" :key="r.id">
              <td class="nowrap"><strong>{{ r.mov_no }}</strong></td>
              <td class="nowrap">{{ r.employee_name }}</td>
              <td class="nowrap">{{ r.type_label }}</td>
              <td class="nowrap">{{ r.effective_date }}<div v-if="r.due" class="muted" style="font-size: 11.5px; color: #b07b12">已到期待处理</div></td>
              <td class="nowrap" style="max-width: 260px; white-space: normal">
                <span v-if="r.type === 'transfer' || r.type === 'promote'">{{ r.from_department_name || '-' }} → {{ r.to_department_name || '-' }}<span v-if="r.to_position"> · {{ r.to_position }}</span></span>
                <span v-else-if="r.type === 'resign'">{{ r.from_department_name || '-' }} · {{ r.reason || '离职' }}</span>
                <span v-else>{{ r.to_department_name || r.from_department_name || '-' }} {{ r.to_position || '' }}</span>
              </td>
              <td class="nowrap">
                <span v-if="r.handover_total">{{ r.handover_done }}/{{ r.handover_total }}</span>
                <span v-else class="muted">-</span>
              </td>
              <td class="nowrap"><span class="tag" :class="r.status === 'effective' ? 'green' : r.status === 'cancelled' ? 'gray' : 'orange'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'pending'" class="link-btn" @click="doApplyMovement(r)">生效</button>
                <button v-if="r.status === 'pending'" class="link-btn danger" @click="doCancelMovement(r)">撤销</button>
              </td>
            </tr>
            <tr v-if="!movements.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">暂无异动记录</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="movModal" class="modal-mask" @click.self="movModal = false">
        <div class="modal wide">
          <div class="modal-head"><h3>新建人事异动</h3><button class="link-btn" @click="movModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>员工 *</label>
                <select class="select" v-model.number="movForm.employee_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.name }}（{{ e.department_name || '未分配' }} · {{ e.position || '-' }}）</option>
                </select>
              </div>
              <div class="fitem"><label>异动类型 *</label>
                <select class="select" v-model="movForm.type">
                  <option value="regular">转正</option>
                  <option value="transfer">调岗</option>
                  <option value="promote">晋升</option>
                  <option value="resign">离职</option>
                </select>
              </div>
              <div class="fitem"><label>生效日期 *</label><input class="input" type="date" v-model="movForm.effective_date" /></div>
              <div class="fitem"><label>目标部门</label>
                <select class="select" v-model.number="movForm.to_department_id">
                  <option :value="null">— 不变 —</option>
                  <option v-for="d in departments" :key="d.id" :value="d.id">{{ d.name }}</option>
                </select>
              </div>
              <div class="fitem"><label>目标岗位</label><input class="input" v-model="movForm.to_position" /></div>
              <div class="fitem"><label>原因</label><input class="input" v-model="movForm.reason" /></div>
              <div class="fitem full"><label>交接清单（离职必填，每行：任务 | 负责人 | 已完成）</label>
                <textarea v-model="movForm.handoverText" rows="3" placeholder="样衣与纸样移交 | 李四 | 否"></textarea>
              </div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="movModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveMovement">提交</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 劳动合同 ==================== -->
    <template v-if="tab === 'contract'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="contractFilter" @change="loadContracts">
          <option value="">全部合同</option>
          <option value="30">30 天内到期</option>
          <option value="90">90 天内到期</option>
        </select>
        <button class="btn btn-ghost" @click="loadContracts">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openContract()">＋ 新建合同</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        同一员工<strong>不允许两份时间重叠的有效合同</strong>；试用期必须落在合同期内；合同签完要登记<strong>交付员工的证据</strong>（双方各执一份）。续签会生成新合同并指向原合同。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>合同号</th><th>员工</th><th>类型</th><th>期限</th><th>试用期</th><th>剩余</th><th>交付</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in contracts" :key="r.id">
              <td class="nowrap"><strong>{{ r.contract_no }}</strong><div class="muted" style="font-size: 12px">签 {{ r.sign_date || '-' }}</div></td>
              <td class="nowrap">{{ r.employee_name }}<div class="muted" style="font-size: 12px">{{ r.department_name || '-' }}</div></td>
              <td class="nowrap">{{ r.type_label }}</td>
              <td class="nowrap">{{ r.start_date }} ~ {{ r.end_date || '无固定' }}</td>
              <td class="nowrap">{{ r.probation_end || '-' }}</td>
              <td class="nowrap">
                <span v-if="r.days_left !== null" :style="r.days_left < 0 ? 'color:#c0392b;font-weight:700' : r.days_left <= 30 ? 'color:#b07b12;font-weight:700' : ''">{{ r.days_left }} 天</span>
                <span v-else class="muted">-</span>
                <div v-if="r.expiring === 'expired'" class="muted" style="font-size: 11.5px; color: #c0392b">已过期未续签</div>
                <div v-else-if="r.expiring === '30'" class="muted" style="font-size: 11.5px; color: #b07b12">30 天内到期</div>
              </td>
              <td class="nowrap">
                <span class="tag" :class="r.delivery_status === 'delivered' ? 'green' : 'orange'">{{ r.delivery_label }}</span>
              </td>
              <td class="nowrap"><span class="tag" :class="r.status === 'active' ? 'green' : r.status === 'terminated' ? 'red' : 'gray'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.delivery_status === 'pending'" class="link-btn" @click="doDeliver(r)">登记交付</button>
                <button v-if="['active'].includes(r.status)" class="link-btn" @click="doRenew(r)">续签</button>
                <button v-if="['active','renewed'].includes(r.status)" class="link-btn danger" @click="doTerminate(r)">解除</button>
              </td>
            </tr>
            <tr v-if="!contracts.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无合同</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="contractModal" class="modal-mask" @click.self="contractModal = false">
        <div class="modal wide">
          <div class="modal-head"><h3>新建劳动合同</h3><button class="link-btn" @click="contractModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>员工 *</label>
                <select class="select" v-model.number="contractForm.employee_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}（{{ e.department_name || '未分配' }}）</option>
                </select>
              </div>
              <div class="fitem"><label>合同类型</label>
                <select class="select" v-model="contractForm.type">
                  <option value="fixed">固定期限</option>
                  <option value="open">无固定期限</option>
                  <option value="internship">实习</option>
                  <option value="labor">劳务</option>
                </select>
              </div>
              <div class="fitem"><label>签订日期</label><input class="input" type="date" v-model="contractForm.sign_date" /></div>
              <div class="fitem"><label>开始日期 *</label><input class="input" type="date" v-model="contractForm.start_date" /></div>
              <div class="fitem"><label>结束日期{{ contractForm.type === 'open' ? '（无固定期限不需填）' : ' *' }}</label>
                <input class="input" type="date" v-model="contractForm.end_date" :disabled="contractForm.type === 'open'" />
              </div>
              <div class="fitem"><label>试用期结束</label><input class="input" type="date" v-model="contractForm.probation_end" /></div>
              <div class="fitem full"><label>备注</label><input class="input" v-model="contractForm.remark" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="contractModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveContract">保存</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 调薪 ==================== -->
    <template v-if="tab === 'salary'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="adjStatus" @change="loadAdjustments">
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="approved">已批准</option>
          <option value="effective">已生效</option>
          <option value="cancelled">已取消</option>
        </select>
        <button class="btn btn-ghost" @click="loadAdjustments">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openAdjustment()">＋ 新建调薪</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        调薪留前后值与生效日；<strong>生效后才回写员工基本工资</strong>，历史可追溯。生效日未到会挂「已批准待生效」，到期再执行。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>调薪单</th><th>员工</th><th>类型</th><th>调整前</th><th>调整后</th><th>幅度</th><th>生效日</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in adjustments" :key="r.id">
              <td class="nowrap"><strong>{{ r.adj_no }}</strong><div class="muted" style="font-size: 12px">{{ r.reason || '-' }}</div></td>
              <td class="nowrap">{{ r.employee_name }}<div class="muted" style="font-size: 12px">{{ r.department_name || '-' }}</div></td>
              <td class="nowrap">{{ r.type_label }}</td>
              <td class="num">¥{{ money(r.before_salary) }}</td>
              <td class="num"><strong>¥{{ money(r.after_salary) }}</strong></td>
              <td class="num"><span :style="r.diff > 0 ? 'color:#1e874b' : 'color:#c0392b'">{{ r.diff > 0 ? '+' : '' }}{{ money(r.diff) }}</span>
                <div class="muted" style="font-size: 11.5px">{{ r.diff_pct === null ? '-' : r.diff_pct + '%' }}</div>
              </td>
              <td class="nowrap">{{ r.effective_date }}<div v-if="r.due" class="muted" style="font-size: 11.5px; color: #b07b12">可执行生效</div></td>
              <td class="nowrap"><span class="tag" :class="r.status === 'effective' ? 'green' : r.status === 'approved' ? 'blue' : r.status === 'cancelled' ? 'gray' : 'orange'">{{ r.status_label }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="r.status === 'draft'" class="link-btn" @click="doApproveAdj(r)">批准</button>
                <button v-if="r.status === 'approved'" class="link-btn" @click="doApplyAdj(r)">生效</button>
                <button v-if="['draft','approved'].includes(r.status)" class="link-btn danger" @click="doCancelAdj(r)">取消</button>
              </td>
            </tr>
            <tr v-if="!adjustments.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无调薪记录</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="adjModal" class="modal-mask" @click.self="adjModal = false">
        <div class="modal">
          <div class="modal-head"><h3>新建调薪</h3><button class="link-btn" @click="adjModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>员工 *</label>
                <select class="select" v-model.number="adjForm.employee_id" @change="pickSalary">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="e in activeEmployees" :key="e.id" :value="e.id">{{ e.name }}（当前 ¥{{ money(e.base_salary) }}）</option>
                </select>
              </div>
              <div class="fitem"><label>调薪类型</label>
                <select class="select" v-model="adjForm.type">
                  <option value="annual">年度调薪</option>
                  <option value="regular">转正调薪</option>
                  <option value="promote">晋升调薪</option>
                  <option value="adjust">个别调整</option>
                </select>
              </div>
              <div class="fitem"><label>调整前（当前工资）</label><input class="input" :value="'¥' + money(adjForm.before_salary)" disabled /></div>
              <div class="fitem"><label>调整后 *</label><input class="input" type="number" step="0.01" v-model.number="adjForm.after_salary" /></div>
              <div class="fitem"><label>生效日期 *</label><input class="input" type="date" v-model="adjForm.effective_date" /></div>
              <div class="fitem"><label>调薪原因</label><input class="input" v-model="adjForm.reason" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">
              调整后 ¥{{ money(adjForm.after_salary) }}，较当前
              <strong>{{ adjForm.before_salary > 0 ? (Math.round(((adjForm.after_salary - adjForm.before_salary) / adjForm.before_salary) * 10000) / 100) + '%' : '-' }}</strong>
            </p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="adjModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveAdjustment">保存</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'recruit', label: '招聘' },
  { key: 'movement', label: '转调离' },
  { key: 'contract', label: '劳动合同' },
  { key: 'salary', label: '调薪' }
];

const tab = ref('recruit');
const canWrite = computed(() => can('hr.write'));
const s = ref({});
const saving = ref(false);
const formMsg = ref('');
const employees = ref([]);
const departments = ref([]);
const activeEmployees = computed(() => employees.value.filter((e) => e.status === 'active'));

const recruitments = ref([]);
const recruitStatus = ref('');
const recruitModal = ref(false);
const recruitForm = reactive({});
const candModal = ref(false);
const candidates = ref([]);
const currentRecruit = ref(null);
const candForm = reactive({});

const movements = ref([]);
const movType = ref('');
const movStatus = ref('');
const movModal = ref(false);
const movForm = reactive({});

const contracts = ref([]);
const contractFilter = ref('');
const contractModal = ref(false);
const contractForm = reactive({});

const adjustments = ref([]);
const adjStatus = ref('');
const adjModal = ref(false);
const adjForm = reactive({});

const money = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function candTag(v) {
  return { applied: 'gray', interview: 'orange', offer: 'blue', hired: 'green', rejected: 'red' }[v] || 'gray';
}

async function loadAll() {
  try { s.value = await api.hrStats(); } catch (e) { /* 概览失败不阻塞 */ }
  try {
    employees.value = await api.employees();
    departments.value = await api.departments();
  } catch (e) { /* ignore */ }
  await Promise.all([loadRecruitments(), loadMovements(), loadContracts(), loadAdjustments()]);
}

async function loadRecruitments() {
  try { recruitments.value = await api.hrRecruitments({ status: recruitStatus.value || undefined }); } catch (e) { alert(e.message); }
}
async function loadMovements() {
  try { movements.value = await api.hrMovements({ type: movType.value || undefined, status: movStatus.value || undefined }); } catch (e) { alert(e.message); }
}
async function loadContracts() {
  try { contracts.value = await api.hrContracts({ expiring: contractFilter.value || undefined }); } catch (e) { alert(e.message); }
}
async function loadAdjustments() {
  try { adjustments.value = await api.hrAdjustments({ status: adjStatus.value || undefined }); } catch (e) { alert(e.message); }
}

// ---------- 招聘 ----------
function openRecruit(r) {
  formMsg.value = '';
  Object.keys(recruitForm).forEach((k) => delete recruitForm[k]);
  Object.assign(recruitForm, r ? { ...r } : {
    id: null, position: '', department_id: null, headcount: 1, salary_range: '', channel: '',
    owner: '', requirement: '', status: 'open', remark: ''
  });
  recruitModal.value = true;
}

async function saveRecruit() {
  formMsg.value = '';
  if (!recruitForm.position) { formMsg.value = '请填写招聘岗位'; return; }
  saving.value = true;
  try {
    if (recruitForm.id) await api.updateHrRecruitment(recruitForm.id, recruitForm);
    else await api.createHrRecruitment(recruitForm);
    recruitModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function removeRecruit(r) {
  if (!confirm(`删除招聘需求「${r.position}」？`)) return;
  try { await api.deleteHrRecruitment(r.id); await loadAll(); } catch (e) { alert(e.message); }
}

async function openCandidates(r) {
  formMsg.value = '';
  currentRecruit.value = r;
  Object.keys(candForm).forEach((k) => delete candForm[k]);
  Object.assign(candForm, { name: '', phone: '', source: '', expected_salary: 0 });
  await refreshCandidates();
  candModal.value = true;
}

async function refreshCandidates() {
  if (!currentRecruit.value) return;
  try { candidates.value = await api.hrCandidates({ recruitment_id: currentRecruit.value.id }); } catch (e) { alert(e.message); }
}

async function addCandidate() {
  formMsg.value = '';
  if (!candForm.name) { formMsg.value = '请填写候选人姓名'; return; }
  try {
    await api.createHrCandidate({ ...candForm, recruitment_id: currentRecruit.value.id });
    Object.assign(candForm, { name: '', phone: '', source: '', expected_salary: 0 });
    await refreshCandidates();
    await loadAll();
  } catch (e) { formMsg.value = e.message; }
}

async function advanceCand(c, stage) {
  let payload = { stage };
  if (stage === 'offer') {
    const v = prompt(`请填写 offer 薪资（期望 ¥${money(c.expected_salary)}）`, c.expected_salary || '');
    if (v === null) return;
    payload.offer_salary = Number(v) || 0;
    const d = prompt('预计入职日期（YYYY-MM-DD，可留空）');
    if (d) payload.expected_onboard = d;
  }
  if (stage === 'rejected') {
    const note = prompt('不通过原因');
    if (note === null) return;
    payload.interview_note = note;
  }
  try {
    await api.updateHrCandidate(c.id, payload);
    await refreshCandidates();
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function doHire(c) {
  if (!confirm(`为「${c.name}」办理入职？将生成员工档案，基本工资按 offer ¥${money(c.offer_salary)}。`)) return;
  try {
    const r = await api.hireHrCandidate(c.id, {});
    alert(`已生成员工档案（ID ${r.employee_id}），入职日 ${r.hire_date}`);
    await refreshCandidates();
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 转调离 ----------
function openMovement() {
  formMsg.value = '';
  Object.keys(movForm).forEach((k) => delete movForm[k]);
  Object.assign(movForm, {
    employee_id: null, type: 'transfer', effective_date: '', to_department_id: null,
    to_position: '', reason: '', handoverText: ''
  });
  movModal.value = true;
}

async function saveMovement() {
  formMsg.value = '';
  if (!movForm.employee_id) { formMsg.value = '请选择员工'; return; }
  if (!movForm.effective_date) { formMsg.value = '请填写生效日期'; return; }
  const handover = String(movForm.handoverText || '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const [task, owner, done] = l.split('|').map((x) => (x || '').trim());
      return { task, owner: owner || '', done: /是|y|yes|1/i.test(done || '') };
    });
  saving.value = true;
  try {
    await api.createHrMovement({
      employee_id: movForm.employee_id, type: movForm.type, effective_date: movForm.effective_date,
      to_department_id: movForm.to_department_id, to_position: movForm.to_position,
      reason: movForm.reason, handover
    });
    movModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doApplyMovement(r) {
  let force = false;
  if (r.effective_date > new Date().toISOString().slice(0, 10)) {
    if (!confirm(`生效日 ${r.effective_date} 还没到，是否立即生效（提前执行）？`)) return;
    force = true;
  } else if (!confirm(`确认异动 ${r.mov_no} 生效？生效后会立即改写员工档案。`)) {
    return;
  }
  try { await api.applyHrMovement(r.id, { force }); await loadAll(); } catch (e) { alert(e.message); }
}

async function doCancelMovement(r) {
  const reason = prompt('撤销原因');
  if (reason === null) return;
  try { await api.cancelHrMovement(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 合同 ----------
function openContract() {
  formMsg.value = '';
  Object.keys(contractForm).forEach((k) => delete contractForm[k]);
  Object.assign(contractForm, {
    employee_id: null, type: 'fixed', sign_date: '', start_date: '', end_date: '', probation_end: '', remark: ''
  });
  contractModal.value = true;
}

async function saveContract() {
  formMsg.value = '';
  if (!contractForm.employee_id) { formMsg.value = '请选择员工'; return; }
  saving.value = true;
  try {
    await api.createHrContract(contractForm);
    contractModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doDeliver(r) {
  const evidence = prompt('交付证据（签收单号 / 扫描件路径）');
  if (!evidence) return;
  try { await api.deliverHrContract(r.id, { evidence }); await loadAll(); } catch (e) { alert(e.message); }
}

async function doRenew(r) {
  const end = prompt(`续签合同结束日期（原合同 ${r.start_date} ~ ${r.end_date}）`, '');
  if (!end) return;
  try {
    const n = await api.renewHrContract(r.id, { end_date: end, type: 'fixed' });
    alert(`已生成新合同 ${n.contract_no}（${n.start_date} ~ ${n.end_date}）`);
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function doTerminate(r) {
  const reason = prompt('解除原因');
  if (!reason) return;
  try { await api.terminateHrContract(r.id, { reason }); await loadAll(); } catch (e) { alert(e.message); }
}

// ---------- 调薪 ----------
function openAdjustment() {
  formMsg.value = '';
  Object.keys(adjForm).forEach((k) => delete adjForm[k]);
  Object.assign(adjForm, {
    employee_id: null, type: 'annual', before_salary: 0, after_salary: 0, effective_date: '', reason: ''
  });
  adjModal.value = true;
}

function pickSalary() {
  const e = employees.value.find((x) => x.id === adjForm.employee_id);
  adjForm.before_salary = e ? Number(e.base_salary) || 0 : 0;
  adjForm.after_salary = adjForm.before_salary;
}

async function saveAdjustment() {
  formMsg.value = '';
  if (!adjForm.employee_id) { formMsg.value = '请选择员工'; return; }
  saving.value = true;
  try {
    await api.createHrAdjustment(adjForm);
    adjModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doApproveAdj(r) {
  try { await api.approveHrAdjustment(r.id); await loadAll(); } catch (e) { alert(e.message); }
}
async function doApplyAdj(r) {
  let force = false;
  if (r.effective_date > new Date().toISOString().slice(0, 10)) {
    if (!confirm(`生效日 ${r.effective_date} 还没到，是否立即生效？`)) return;
    force = true;
  }
  try { await api.applyHrAdjustment(r.id, { force }); await loadAll(); } catch (e) { alert(e.message); }
}
async function doCancelAdj(r) {
  if (!confirm('取消该调薪？')) return;
  try { await api.cancelHrAdjustment(r.id); await loadAll(); } catch (e) { alert(e.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1080px; }
</style>
