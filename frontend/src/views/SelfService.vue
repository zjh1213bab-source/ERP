<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>我的自助</h2>
        <p class="sub">
          看自己的<b>考勤、工资条、技能到期</b>；补卡、请假、资料更正、薪资申诉都在这里提交。
          <b>只能看自己的</b> —— 范围由账号绑定的员工档案决定，不是按姓名猜的。
        </p>
      </div>
      <div class="head-ops">
        <span class="tag" :class="ov.bound ? 'green' : 'orange'">{{ ov.bound ? (ov.me && ov.me.name) : '未绑定员工档案' }}</span>
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <!-- 未绑定：把话说明白，别让人以为系统坏了 -->
    <div class="notice warn" v-if="!ov.bound">
      <b>当前账号还没绑定员工档案</b>
      <p>{{ ov.hint }}</p>
      <p class="mut tiny">
        为什么不自动按姓名匹配：库里 10 个账号（系统管理员 / 销售小王 / 李工…）没有一个能对上员工档案，
        按名字猜会把「销售小王」绑到「王芳」身上 —— 那就是把别人的工资给人看了。
      </p>
    </div>

    <div class="cards c6" v-if="ov.bound">
      <div class="stat-card">
        <div class="label">本月出勤</div>
        <div class="value">{{ ov.attendance.present }}<small>天</small></div>
        <div class="foot">迟到 {{ ov.attendance.late }} · 缺勤 {{ ov.attendance.absent }}</div>
      </div>
      <div class="stat-card">
        <div class="label">今年已休</div>
        <div class="value">{{ ov.leave.total_days }}<small>天</small></div>
        <div class="foot">未配置额度，只列已批已休</div>
      </div>
      <div class="stat-card accent">
        <div class="label">最近一次实发</div>
        <div class="value">{{ latestPay ? money(latestPay.net_pay) : '—' }}</div>
        <div class="foot">{{ latestPay ? latestPay.period + ' · ' + latestPay.status_label : '还没有已确认工资单' }}</div>
      </div>
      <div class="stat-card">
        <div class="label">年内已发合计</div>
        <div class="value">{{ money(ov.payslips.year_paid) }}</div>
        <div class="foot">{{ ov.payslips.count }} 张工资条</div>
      </div>
      <div class="stat-card">
        <div class="label">我的技能</div>
        <div class="value">{{ ov.skills.count }}</div>
        <div class="foot">可独立上岗 {{ ov.skills.can_work_alone }} 项</div>
      </div>
      <div class="stat-card" :class="{ danger: ov.requests.open > 0 }">
        <div class="label">未结申请</div>
        <div class="value">{{ ov.requests.open }}</div>
        <div class="foot">{{ (ov.skills.expiring || []).length }} 项资格 60 天内到期</div>
      </div>
    </div>

    <div class="panel" v-if="ov.bound || isStaff">
      <div class="panel-head">
        <div class="tabs">
          <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
        </div>
        <span class="mut tiny" v-if="tab === 'pay'">只显示已确认/已发放的工资条；核算中的不显示（看了又改只会制造申诉）</span>
        <span class="mut tiny" v-else-if="tab === 'req'">批准后不会改已发放的工资，只生成下一期调整单</span>
        <span class="mut tiny" v-else-if="tab === 'manage'">驳回也要写结论 —— 员工拿到「已驳回」三个字等于没回复</span>
        <span class="mut tiny" v-else-if="tab === 'bind'">绑错账号就是「看到别人的工资」，只给人事与管理员</span>
        <span class="mut tiny" v-else-if="tab === 'team'">仅出勤与休假天数：不含工资金额，不含请假类型（病假属敏感）</span>
      </div>

      <!-- ============ 概览 ============ -->
      <div v-if="tab === 'overview'">
        <div class="two" v-if="ov.bound">
          <div class="box">
            <div class="box-h">我的档案</div>
            <table class="kv">
              <tr><td>工号 / 姓名</td><td><b>{{ ov.me.code }}</b> · {{ ov.me.name }}</td></tr>
              <tr><td>部门 / 岗位</td><td>{{ ov.me.dept || '—' }} · {{ ov.me.position || '—' }}</td></tr>
              <tr><td>入职日期</td><td>{{ ov.me.hire_date || '—' }}</td></tr>
              <tr><td>手机号</td><td>{{ ov.me.phone || '—' }} <span class="mut tiny">（要改走「资料更正」）</span></td></tr>
              <tr><td>紧急联系人</td><td>{{ ov.me.emergency_contact || '—' }}</td></tr>
            </table>
          </div>
          <div class="box">
            <div class="box-h">本月考勤（{{ ov.month }}）</div>
            <table class="kv">
              <tr><td>出勤</td><td>{{ ov.attendance.present }} 天（其中迟到 {{ ov.attendance.late }} 天）</td></tr>
              <tr><td>请假 / 缺勤</td><td>{{ ov.attendance.leave }} / {{ ov.attendance.absent }} 天</td></tr>
              <tr><td>假期使用</td>
                <td>
                  <span v-if="!(ov.leave.used || []).length" class="mut">今年还没有已批准的请假</span>
                  <span v-else>{{ ov.leave.used.map((x) => typeLabel(x.type) + ' ' + x.days + ' 天').join('、') }}</span>
                  <div class="mut tiny">{{ ov.leave.quota_note }}</div>
                </td>
              </tr>
            </table>
            <p class="mut tiny" v-if="ov.attendance.note">{{ ov.attendance.note }}</p>
          </div>
        </div>

        <div class="box" style="margin-top: 12px" v-if="ov.bound">
          <div class="box-h">我的技能与资格（60 天内到期）</div>
          <p v-if="!(ov.skills.expiring || []).length" class="mut tiny">最近 60 天没有到期的技能或证书。</p>
          <table class="data" v-else>
            <thead><tr><th style="width: 110px">类型</th><th>事项</th><th style="width: 120px">到期日</th></tr></thead>
            <tbody>
              <tr v-for="(x, i) in ov.skills.expiring" :key="i">
                <td><span class="tag" :class="x.kind === 'cert' ? 'blue' : 'purple'">{{ x.kind === 'cert' ? '资格证书' : '技能复评' }}</span></td>
                <td>{{ x.item }}</td>
                <td :class="{ red: x.date < today }">{{ x.date }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ============ 我的工资条 ============ -->
      <div v-if="tab === 'pay'">
        <p class="mut tiny" v-if="!ov.bound">绑定员工档案后才能看工资条。</p>
        <template v-else>
          <table class="data" v-if="payslips.length">
            <thead>
              <tr>
                <th style="width: 110px">工资期间</th>
                <th style="width: 120px">应发</th>
                <th style="width: 120px">实发</th>
                <th style="width: 100px">状态</th>
                <th style="width: 180px">申诉期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in payslips" :key="p.id">
                <td><b>{{ p.period }}</b></td>
                <td>{{ money(p.gross_pay) }}</td>
                <td><b>{{ money(p.net_pay) }}</b></td>
                <td><span class="tag" :class="p.status === 'paid' ? 'green' : 'blue'">{{ p.status_label }}</span></td>
                <td class="tiny">
                  <span v-if="p.appeal_window.open">至 {{ p.appeal_window.end }}</span>
                  <span v-else class="mut">已于 {{ p.appeal_window.end }} 截止</span>
                </td>
                <td>
                  <button class="btn btn-sm btn-ghost" @click="openPayslip(p)">看明细</button>
                  <button class="btn btn-sm btn-ghost" v-if="p.appeal_window.open" @click="openAppeal(p)">提申诉</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty">{{ ov.payslips.note || '还没有已确认的工资单' }}</p>
        </template>

        <!-- 明细抽屉 -->
        <div class="detail" v-if="detail">
          <div class="detail-h">
            <b>{{ detail.period }} 工资明细</b>
            <span class="tag" :class="detail.viewer === 'self' ? 'green' : 'orange'">{{ detail.viewer === 'self' ? '本人查看' : '人事代查' }}</span>
            <button class="btn btn-sm btn-ghost" @click="detail = null">关闭</button>
          </div>
          <table class="kv two-col">
            <tr><td>基本工资</td><td>{{ money(detail.base_salary) }}</td><td>出勤天数</td><td>{{ detail.actual_days }} / {{ detail.work_days }}</td></tr>
            <tr><td>加班费</td><td>{{ money(detail.overtime_pay) }}</td><td>加班小时</td><td>{{ detail.overtime_hours }}</td></tr>
            <tr><td>奖金 / 补贴</td><td>{{ money(detail.bonus) }} / {{ money(detail.allowance) }}</td><td>计件工资</td><td>{{ money(detail.piece_wage) }}</td></tr>
            <tr><td>扣款</td><td class="red">{{ money(detail.deduction) }}</td><td>社保 / 个税</td><td>{{ money(detail.social_insurance) }} / {{ money(detail.tax) }}</td></tr>
            <tr><td><b>应发</b></td><td><b>{{ money(detail.gross_pay) }}</b></td><td><b>实发</b></td><td><b>{{ money(detail.net_pay) }}</b></td></tr>
          </table>
          <p class="mut tiny" v-if="(detail.adjustments || []).length">
            这期已有关联调整：{{ detail.adjustments.map((a) => a.adj_no + '（' + (a.amount > 0 ? '补发 ' : '扣回 ') + Math.abs(a.amount) + '）').join('、') }}
          </p>
          <p class="mut tiny" v-if="(detail.pending_appeals || []).length">
            处理中的申诉：{{ detail.pending_appeals.map((x) => x.ticket_no).join('、') }}
          </p>
        </div>
      </div>

      <!-- ============ 我的申请 ============ -->
      <div v-if="tab === 'req'">
        <div class="panel-head" style="margin-bottom: 10px">
          <div class="mut tiny">补卡只能补最近 30 天；资料只能改手机号与紧急联系人；部门、岗位、工资、银行卡走线下</div>
          <div class="head-ops" v-if="ov.bound">
            <button class="btn btn-sm btn-ghost" @click="openForm('makeup')">补卡</button>
            <button class="btn btn-sm btn-ghost" @click="openForm('leave')">请假</button>
            <button class="btn btn-sm btn-ghost" @click="openForm('profile')">资料更正</button>
            <button class="btn btn-sm btn-primary" @click="openAppealFromTab">薪资申诉</button>
          </div>
        </div>

        <div class="form-box" v-if="form.open">
          <div class="form-h"><b>{{ formTitle }}</b><span class="mut tiny">{{ formHint }}</span></div>

          <div class="row" v-if="form.type === 'makeup'">
            <label>日期</label><input v-model="form.payload.date" type="date" class="input" :max="today" />
            <label>上班</label><input v-model="form.payload.check_in" type="time" class="input" />
            <label>下班</label><input v-model="form.payload.check_out" type="time" class="input" />
          </div>

          <div class="row" v-if="form.type === 'leave'">
            <label>开始</label><input v-model="form.payload.start_date" type="date" class="input" />
            <label>结束</label><input v-model="form.payload.end_date" type="date" class="input" />
            <label>天数</label><input v-model.number="form.payload.days" type="number" step="0.5" class="input" style="width: 88px" />
          </div>

          <div class="row" v-if="form.type === 'profile'">
            <label>要改</label>
            <select v-model="form.payload.field" class="input">
              <option v-for="f in meta.profile_fields || []" :key="f.value" :value="f.value">{{ f.label }}</option>
            </select>
            <label>改成</label><input v-model="form.payload.value" class="input" placeholder="新的内容" />
          </div>

          <div class="row" v-if="form.type === 'payroll'">
            <label>工资单</label>
            <select v-model.number="form.payload.payroll_id" class="input">
              <option :value="0">选择期间</option>
              <option v-for="p in appealable" :key="p.id" :value="p.id">{{ p.period }}（实发 {{ money(p.net_pay) }}）</option>
            </select>
            <label>诉求金额</label>
            <input v-model.number="form.payload.claim_amount" type="number" class="input" style="width: 110px" placeholder="可留空" />
          </div>

          <div class="row">
            <label>原因</label>
            <textarea v-model="form.reason" class="input" rows="2" placeholder="至少 5 个字：说清哪一天、什么事、要什么结果"></textarea>
          </div>
          <div class="form-foot">
            <button class="btn btn-sm btn-ghost" @click="form.open = false">取消</button>
            <button class="btn btn-sm btn-primary" @click="submitForm">提交</button>
          </div>
        </div>

        <table class="data" v-if="(ov.requests.recent || []).length">
          <thead>
            <tr>
              <th style="width: 140px">单号</th>
              <th style="width: 100px">类型</th>
              <th>内容</th>
              <th style="width: 100px">状态</th>
              <th style="width: 110px">回复期限</th>
              <th style="width: 90px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in ov.requests.recent" :key="r.id">
              <td class="tiny">{{ r.ticket_no }}</td>
              <td><span class="tag gray">{{ r.type_label || typeLabel2(r.type) }}</span></td>
              <td class="tiny">{{ r.title }}</td>
              <td><span class="tag" :class="statusTag(r.status)">{{ statusLabel(r.status) }}</span></td>
              <td class="tiny" :class="{ red: r.due_date < today && ['submitted', 'reviewing'].includes(r.status) }">{{ r.due_date }}</td>
              <td>
                <button class="btn btn-sm btn-ghost" v-if="['submitted', 'reviewing'].includes(r.status)" @click="withdraw(r)">撤回</button>
                <span v-else class="mut tiny">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty">还没有提交过申请</p>
      </div>

      <!-- ============ 受理台 ============ -->
      <div v-if="tab === 'manage'">
        <div class="panel-head" style="margin-bottom: 10px">
          <div class="mut tiny">待受理 {{ staffSummary.pending }} 条 · 超期未回 {{ staffSummary.overdue }} 条</div>
          <select v-model="staffFilter" class="input" style="width: 130px" @change="loadStaff">
            <option value="">全部状态</option>
            <option value="submitted">待受理</option>
            <option value="approved">已批准</option>
            <option value="rejected">已驳回</option>
          </select>
        </div>
        <table class="data">
          <thead>
            <tr>
              <th style="width: 136px">单号 / 类型</th>
              <th style="width: 100px">员工</th>
              <th>内容</th>
              <th style="width: 96px">状态</th>
              <th style="width: 96px">期限</th>
              <th style="width: 176px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in staffRows" :key="r.id">
              <td class="tiny">{{ r.ticket_no }}<br /><span class="tag gray">{{ r.type_label }}</span></td>
              <td>{{ r.employee_name }}</td>
              <td class="tiny">
                <div>{{ r.title }}</div>
                <div class="mut">{{ r.reason }}</div>
                <div class="mut" v-if="r.payload && r.payload.period">期间 {{ r.payload.period }} · 诉求 {{ r.payload.claim_amount || '—' }}</div>
                <div class="mut" v-if="r.conclusion">结论：{{ r.conclusion }}</div>
              </td>
              <td><span class="tag" :class="statusTag(r.status)">{{ statusLabel(r.status) }}</span></td>
              <td class="tiny" :class="{ red: r.overdue }">
                {{ r.due_date }}<span v-if="r.overdue" class="tag red">超期</span>
              </td>
              <td>
                <template v-if="['submitted', 'reviewing'].includes(r.status)">
                  <button class="btn btn-sm btn-ghost" @click="openReview(r, true)">批准</button>
                  <button class="btn btn-sm btn-ghost" @click="openReview(r, false)">驳回</button>
                </template>
                <span v-else class="mut tiny">{{ r.decided_by || '—' }}</span>
              </td>
            </tr>
            <tr v-if="!staffRows.length"><td colspan="6" class="empty">没有待处理的申请</td></tr>
          </tbody>
        </table>

        <div class="form-box" v-if="review.open">
          <div class="form-h">
            <b>{{ review.approve ? '批准' : '驳回' }} · {{ review.row.ticket_no }}</b>
            <span class="mut tiny">{{ review.row.type_label }} · {{ review.row.employee_name }}</span>
          </div>
          <div class="row" v-if="review.approve && review.row.type === 'payroll'">
            <label>调整金额</label>
            <input v-model.number="review.adjust_amount" type="number" class="input" style="width: 120px" placeholder="正=补发 负=扣回" />
            <label>项目</label>
            <select v-model="review.adjust_item" class="input">
              <option v-for="i in meta.adjust_items || []" :key="i.value" :value="i.value">{{ i.label }}</option>
            </select>
            <span class="mut tiny">生效期＝下一期（已发放的那期不动）</span>
          </div>
          <div class="row">
            <label>结论</label>
            <textarea v-model="review.conclusion" class="input" rows="2" placeholder="至少 5 个字：核实了什么、为什么这样处理"></textarea>
          </div>
          <div class="form-foot">
            <button class="btn btn-sm btn-ghost" @click="review.open = false">取消</button>
            <button class="btn btn-sm btn-primary" @click="submitReview">提交结论</button>
          </div>
        </div>

        <div class="box" style="margin-top: 14px" v-if="adjustments.length">
          <div class="box-h">工资调整单（批准申诉后生成，下一期生效）</div>
          <table class="data">
            <thead>
              <tr><th style="width: 130px">调整单</th><th style="width: 100px">员工</th><th style="width: 100px">生效期</th><th style="width: 110px">金额</th><th style="width: 90px">状态</th><th>原因</th></tr>
            </thead>
            <tbody>
              <tr v-for="a in adjustments" :key="a.id">
                <td class="tiny">{{ a.adj_no }}</td>
                <td>{{ a.employee_name }}</td>
                <td>{{ a.period }}</td>
                <td :class="a.amount > 0 ? 'green' : 'red'"><b>{{ a.amount > 0 ? '+' : '' }}{{ money(a.amount) }}</b></td>
                <td><span class="tag" :class="a.status === 'applied' ? 'green' : 'orange'">{{ a.status === 'applied' ? '已带入' : '待带入' }}</span></td>
                <td class="tiny mut">{{ a.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ============ 账号绑定 ============ -->
      <div v-if="tab === 'bind'">
        <div class="panel-head" style="margin-bottom: 10px">
          <div class="mut tiny">已绑定 {{ bindSummary.bound }} / {{ bindSummary.users }} 个账号 · 未绑定 {{ bindSummary.unbound }} 个（这些人看不到自己的工资）</div>
          <button class="btn btn-sm btn-primary" @click="openBind">绑定账号</button>
        </div>
        <div class="form-box" v-if="bindForm.open">
          <div class="row">
            <label>账号</label>
            <select v-model.number="bindForm.user_id" class="input">
              <option :value="0">选择账号</option>
              <option v-for="u in bindings.filter((x) => !x.bound)" :key="u.id" :value="u.id">{{ u.username }}（{{ u.name }} / {{ u.role }}）</option>
            </select>
            <label>员工</label>
            <select v-model.number="bindForm.employee_id" class="input">
              <option :value="0">选择员工</option>
              <option v-for="e in bindable" :key="e.id" :value="e.id" :disabled="!e.bindable">
                {{ e.name }}（{{ e.code }} · {{ e.position || '—' }}）{{ e.bindable ? '' : ' 已绑定 ' + e.bound_user }}
              </option>
            </select>
          </div>
          <p class="hint">绑定后该账号只能看自己的考勤与工资；看别人仍走各自岗位权限。</p>
          <div class="form-foot">
            <button class="btn btn-sm btn-ghost" @click="bindForm.open = false">取消</button>
            <button class="btn btn-sm btn-primary" @click="submitBind">绑定</button>
          </div>
        </div>
        <table class="data">
          <thead>
            <tr><th style="width: 130px">账号</th><th style="width: 110px">姓名</th><th style="width: 96px">角色</th><th style="width: 90px">状态</th><th>绑定的员工</th><th style="width: 100px">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in bindings" :key="u.id">
              <td class="tiny">{{ u.username }}</td>
              <td>{{ u.name }}</td>
              <td class="mut tiny">{{ u.role }}</td>
              <td><span class="tag" :class="u.bound ? 'green' : 'orange'">{{ u.bound ? '已绑定' : '未绑定' }}</span></td>
              <td class="tiny">
                <span v-if="u.bound">{{ u.employee_name }}（{{ u.code }} · {{ u.position || '—' }}）</span>
                <span v-else class="mut">— 看不到工资条 —</span>
              </td>
              <td><button class="btn btn-sm btn-ghost" v-if="u.bound" @click="unbind(u)">解绑</button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ============ 团队摘要 ============ -->
      <div v-if="tab === 'team'">
        <p class="mut tiny" v-if="teamError">{{ teamError }}</p>
        <template v-else>
          <p class="mut tiny">{{ team.boundary }}</p>
          <div class="cards c4" v-if="team.summary">
            <div class="stat-card"><div class="label">在册</div><div class="value">{{ team.summary.people }}</div><div class="foot">本月 {{ team.month }}</div></div>
            <div class="stat-card"><div class="label">出勤合计</div><div class="value">{{ team.summary.present }}<small>天</small></div><div class="foot">按人天累加</div></div>
            <div class="stat-card"><div class="label">迟到 / 缺勤</div><div class="value">{{ team.summary.late }} / {{ team.summary.absent }}</div><div class="foot">天</div></div>
            <div class="stat-card"><div class="label">请假合计</div><div class="value">{{ team.summary.leave }}<small>天</small></div><div class="foot">不区分类型</div></div>
          </div>
          <table class="data">
            <thead>
              <tr><th style="width: 110px">工号</th><th style="width: 120px">姓名</th><th style="width: 140px">岗位</th><th style="width: 90px">出勤</th><th style="width: 80px">迟到</th><th style="width: 80px">缺勤</th><th>请假</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in team.rows || []" :key="r.employee_id">
                <td class="tiny mut">{{ r.code }}</td>
                <td>{{ r.name }}</td>
                <td class="mut tiny">{{ r.position || '—' }}</td>
                <td><b>{{ r.present_days }}</b> 天</td>
                <td :class="{ red: r.late_days > 0 }">{{ r.late_days }}</td>
                <td :class="{ red: r.absent_days > 0 }">{{ r.absent_days }}</td>
                <td>{{ r.leave_days }} 天</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';

const today = new Date().toLocaleDateString('sv-SE');
const role = computed(() => auth.user?.role || '');
const TABS_ALL = [
  { key: 'overview', label: '我的概览' },
  { key: 'pay', label: '我的工资条' },
  { key: 'req', label: '我的申请' }
];
const TABS_MANAGE = { key: 'manage', label: '受理台' };
const TABS_BIND = { key: 'bind', label: '账号绑定' };
const TABS_TEAM = { key: 'team', label: '团队摘要' };

const isStaff = computed(() => ['admin', 'hr', 'finance'].includes(role.value));
const tabs = computed(() => {
  // 未绑定员工档案时，「我的工资条 / 我的申请」没有内容可看，直接不列（不给空面板）
  const t = ov.value.bound ? [...TABS_ALL] : [TABS_ALL[0]];
  if (['admin', 'hr', 'finance'].includes(role.value)) t.push(TABS_MANAGE);
  if (['admin', 'hr'].includes(role.value)) t.push(TABS_BIND);
  t.push(TABS_TEAM);
  return t;
});

const tab = ref('overview');
const ov = ref({ bound: false, attendance: {}, leave: {}, payslips: {}, skills: {}, requests: {} });
const meta = ref({});
const payslips = ref([]);
const detail = ref(null);
const bindings = ref([]);
const bindSummary = ref({ users: 0, bound: 0, unbound: 0 });
const bindable = ref([]);
const staffRows = ref([]);
const staffFilter = ref('');
const staffSummary = ref({ pending: 0, overdue: 0 });
const team = ref({});
const teamError = ref('');
const adjustments = ref([]);

const latestPay = computed(() => (ov.value.payslips?.latest || [])[0] || null);
const appealable = computed(() => payslips.value.filter((p) => p.appeal_window && p.appeal_window.open));

const money = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const typeLabel = (v) => ({ annual: '年假', personal: '事假', sick: '病假', marriage: '婚假', maternity: '产假' }[v] || v);
const typeLabel2 = (v) => ((meta.value.types || []).find((x) => x.value === v) || {}).label || v;
const statusLabel = (v) => ({ submitted: '待受理', reviewing: '处理中', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回' }[v] || v);
const statusTag = (v) => ({ submitted: 'blue', reviewing: 'orange', approved: 'green', rejected: 'red', withdrawn: 'gray' }[v] || 'gray');

async function reload() {
  const [m, o] = await Promise.all([api.selfMeta(), api.selfOverview()]);
  meta.value = m;
  ov.value = o;
  if (o.bound) {
    const r = await api.selfPayslips();
    payslips.value = r.rows || [];
  } else {
    payslips.value = [];
  }
  if (['admin', 'hr'].includes(role.value)) await loadBindings();
  if (['admin', 'hr', 'finance'].includes(role.value)) await loadStaff();
  await loadTeam();
}

async function loadBindings() {
  const r = await api.selfBindings({});
  bindings.value = r.rows || [];
  bindSummary.value = r.summary || { users: 0, bound: 0, unbound: 0 };
  bindable.value = (await api.selfBindable({})) || [];
}
async function loadStaff() {
  const rows = await api.selfAllRequests({ status: staffFilter.value || undefined });
  staffRows.value = rows || [];
  const st = (await api.selfMeta()).stats || {};
  staffSummary.value = { pending: st.pending || 0, overdue: st.overdue || 0 };
  adjustments.value = (await api.selfAdjustments({})) || [];
}
async function loadTeam() {
  try {
    team.value = await api.selfTeam();
    teamError.value = '';
  } catch (e) {
    team.value = {};
    teamError.value = e.message;
  }
}

/* ---- 工资条 ---- */
async function openPayslip(p) {
  try { detail.value = await api.selfPayslip(p.id); } catch (e) { alert(e.message); }
}

/* ---- 申请表单 ---- */
const form = reactive({ open: false, type: '', reason: '', payload: {} });
const formTitle = computed(() => ({ makeup: '补卡申请', leave: '请假申请', profile: '资料更正', payroll: '薪资申诉' }[form.type] || ''));
const formHint = computed(() => ((meta.value.types || []).find((x) => x.value === form.type) || {}).hint || '');

function openForm(type, preset = {}) {
  form.open = true;
  form.type = type;
  form.reason = '';
  form.payload = {
    date: today,
    check_in: '',
    check_out: '',
    start_date: today,
    end_date: today,
    days: 1,
    field: (meta.value.profile_fields || [])[0]?.value || 'phone',
    value: '',
    payroll_id: 0,
    claim_amount: null,
    ...preset
  };
}
function openAppeal(p) {
  openForm('payroll', { payroll_id: p.id });
  tab.value = 'req';
}
function openAppealFromTab() {
  if (!appealable.value.length) {
    alert('没有在申诉期内的工资单（只算已确认/已发放，且 30 天内）');
    return;
  }
  openForm('payroll', { payroll_id: appealable.value[0].id });
}

async function submitForm() {
  try {
    const out = await api.selfSubmit({ type: form.type, reason: form.reason, payload: form.payload });
    form.open = false;
    await reload();
    alert(`已提交 ${out.ticket_no}，${out.note}`);
  } catch (e) { alert(e.message); }
}

async function withdraw(r) {
  if (!confirm(`撤回 ${r.ticket_no}？`)) return;
  try { await api.selfWithdraw(r.id); await reload(); } catch (e) { alert(e.message); }
}

/* ---- 受理 ---- */
const review = reactive({ open: false, row: null, approve: true, conclusion: '', adjust_amount: null, adjust_item: 'other' });
function openReview(r, approve) {
  review.open = true;
  review.row = r;
  review.approve = approve;
  review.conclusion = '';
  review.adjust_amount = r.payload && r.payload.claim_amount ? r.payload.claim_amount : null;
  review.adjust_item = r.type === 'payroll' ? 'piece_wage' : 'other';
}
async function submitReview() {
  try {
    const out = await api.selfReview(review.row.id, {
      approve: review.approve,
      conclusion: review.conclusion,
      adjust_amount: review.adjust_amount,
      adjust_item: review.adjust_item
    });
    review.open = false;
    await reload();
    alert(out.side_effect || out.conclusion);
  } catch (e) { alert(e.message); }
}

/* ---- 绑定 ---- */
const bindForm = reactive({ open: false, user_id: 0, employee_id: 0 });
function openBind() { bindForm.open = true; bindForm.user_id = 0; bindForm.employee_id = 0; }
async function submitBind() {
  try {
    const out = await api.selfBind({ user_id: bindForm.user_id, employee_id: bindForm.employee_id });
    bindForm.open = false;
    await loadBindings();
    alert(`${out.username} 已绑定到 ${out.employee_name}`);
  } catch (e) { alert(e.message); }
}
async function unbind(u) {
  if (!confirm(`解绑 ${u.username}？解绑后该账号看不到任何个人数据`)) return;
  try { await api.selfUnbind(u.id); await loadBindings(); } catch (e) { alert(e.message); }
}

onMounted(reload);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
/* tabs 按钮不许被压缩成竖排文字 */
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }
.panel .tag { white-space: nowrap; }

.card-note { background: #f8fafc; border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
.cards.c4 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 12px; }
.cards.c6 .stat-card, .cards.c4 .stat-card { min-height: 104px; padding: 14px 12px; }
.cards.c6 .stat-card .value, .cards.c4 .stat-card .value { font-size: 22px; margin-top: 6px; }
.cards .stat-card .foot { font-size: 11px; line-height: 1.45; }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
.box { border: 1px solid #eef1f6; border-radius: 10px; padding: 12px 14px; }
.box-h { font-weight: 600; font-size: 13px; margin-bottom: 8px; }

table.kv { width: 100%; font-size: 12.5px; }
table.kv td { padding: 5px 6px; border-bottom: 1px dashed #eef1f6; vertical-align: top; }
table.kv td:first-child { width: 110px; color: #64748b; }
table.kv.two-col td:first-child, table.kv.two-col td:nth-child(3) { width: 96px; color: #64748b; }

.detail { border: 1px solid #e6ebf3; border-radius: 10px; padding: 12px 14px; margin-top: 12px; background: #fcfdff; }
.detail-h { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.detail-h .tag { flex: 0 0 auto; }
.detail-h .btn { margin-left: auto; }

.form-box { border: 1px solid #e6ebf3; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: #fcfdff; }
.form-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.form-box .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.form-box .row label { font-size: 12px; color: #64748b; min-width: 52px; }
.form-box .row .input { flex: 1; min-width: 100px; }
.form-foot { display: flex; gap: 8px; justify-content: flex-end; }

.notice { border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
.notice.warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.notice p { margin: 6px 0 0; font-size: 12.5px; line-height: 1.6; }
.hint { font-size: 11.5px; color: #64748b; background: #f8fafc; border-radius: 6px; padding: 7px 9px; margin: 6px 0; }
.red { color: #b91c1c; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .head-ops { flex-wrap: wrap; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; margin-left: 0; padding-bottom: 2px; }
  .two { grid-template-columns: 1fr; }
}
</style>
