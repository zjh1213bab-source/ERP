<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>技能矩阵与岗位资格</h2>
        <p class="sub">
          回答三个排产要问的问题：<b>这道工序现在有几个人真能上</b>、<b>这个人能不能上</b>、<b>下个月谁会掉资格</b>。
          等级只来自<b>考核评定</b>；报工只算「做过」的证据，不参与评级 —— 干得多不等于干得好。
        </p>
      </div>
      <div class="head-ops">
        <select v-model="dept" class="input" style="width: 130px" @change="loadMatrix">
          <option value="">全部部门</option>
          <option v-for="d in meta.departments || []" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <input v-model="kw" class="input" style="width: 140px" placeholder="姓名 / 工号 / 岗位" @keyup.enter="loadMatrix" />
        <button class="btn btn-ghost" @click="loadMatrix">筛选</button>
        <button class="btn btn-primary" @click="openAssess()">评定技能</button>
      </div>
    </div>

    <details class="caliber" open>
      <summary>口径说明（点开看五条，都是「不美化」的边界）</summary>
      <ol>
        <li><b>等级只来自评定</b>：报工次数只作证据回填，不参与评级 —— 报工多可能只是干得多，也可能是返工最多的那个。</li>
        <li><b>证据来源分开记</b>：考核评定 / 仅有报工 / 本人自报。<b>只有「考核评定」且等级达标的才算可独立上岗</b>，其余只能看不能派工。</li>
        <li><b>证书过期即失效，记录不删</b>：状态转「已过期」，「曾经有」和「现在没有」是两件事。</li>
        <li><b>查不到人不拦</b>：报工人不在员工档案时不拦报工，只计入「未归属报工」去补档案 —— 不能让 HR 的数据质量决定车间能不能开工。</li>
        <li><b>本模块不扣钱、不打分</b>：只有资格与覆盖。破格放行必须写理由 + 有期限 + 留痕。</li>
      </ol>
    </details>

    <div class="cards c6">
      <div class="stat-card">
        <div class="label">在岗人数</div>
        <div class="value">{{ meta.stats ? meta.stats.employees : '—' }}</div>
        <div class="foot">有技能记录 {{ meta.stats ? meta.stats.skill_rows : 0 }} 条</div>
      </div>
      <div class="stat-card accent">
        <div class="label">已评定</div>
        <div class="value">{{ meta.stats ? meta.stats.assessed : '—' }}</div>
        <div class="foot">可作派工依据</div>
      </div>
      <div class="stat-card" :class="{ warn: meta.stats && meta.stats.evidence_only > meta.stats.assessed }">
        <div class="label">仅有报工</div>
        <div class="value">{{ meta.stats ? meta.stats.evidence_only : '—' }}</div>
        <div class="foot">做过但没评定</div>
      </div>
      <div class="stat-card" :class="{ danger: meta.stats && meta.stats.restricted > 0 }">
        <div class="label">受限工序</div>
        <div class="value">{{ meta.stats ? meta.stats.restricted : '—' }}</div>
        <div class="foot">没资格不许上机</div>
      </div>
      <div class="stat-card" :class="{ danger: exp && exp.summary && exp.summary.overdue > 0 }">
        <div class="label">{{ expDays }} 天内到期</div>
        <div class="value">{{ exp && exp.summary ? exp.summary.total : '—' }}</div>
        <div class="foot">已过期 {{ exp && exp.summary ? exp.summary.overdue : 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">培训完成率</div>
        <div class="value">{{ meta.stats && meta.stats.training_rate != null ? meta.stats.training_rate + '%' : '—' }}</div>
        <div class="foot">通过 / 全部安排</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
        </div>
        <span class="mut" v-if="tab === 'matrix'">格子颜色：<b class="g">绿</b>=达标可上岗 · <b class="a">黄</b>=有记录但不够门槛 · <b class="r">红</b>=已过期 · 灰=仅有报工</span>
        <span class="mut" v-else-if="tab === 'coverage'">合格人数按「等级 ≥ 门槛 且 未过期」算，仅报工过的不算</span>
        <span class="mut" v-else-if="tab === 'rules'">受限开关一开，没资格的人当场报不了工 —— 系统会先提示有几人合格</span>
      </div>

      <!-- ============ 矩阵 ============ -->
      <div v-if="tab === 'matrix'">
        <div class="matrix-wrap">
          <table class="data matrix">
            <thead>
              <tr>
                <th class="sticky-col" style="width: 168px">员工</th>
                <th style="width: 92px">岗位</th>
                <th v-for="p in matrix.processes || []" :key="p.process_name" :title="p.work_center || ''">
                  {{ p.process_name }}
                  <span v-if="p.restricted" class="req-dot" title="受限工序">限</span>
                  <div class="req-lv">{{ p.has_requirement ? p.min_level + '级' : '无门槛' }}</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in matrix.rows || []" :key="r.employee_id">
                <td class="sticky-col">
                  <div class="who">{{ r.name }} <span class="mut">{{ r.code }}</span></div>
                  <div class="mut tiny">{{ r.dept }}</div>
                </td>
                <td class="mut tiny">{{ r.position || '—' }}</td>
                <td v-for="p in matrix.processes || []" :key="p.process_name" class="cell" @click="openAssess(r, p)">
                  <template v-if="r.cells[p.process_name]">
                    <span class="lv" :class="lvClass(r.cells[p.process_name], p)">
                      {{ r.cells[p.process_name].level_label }}
                    </span>
                    <span v-if="r.cells[p.process_name].override_until" class="ov" :title="'破格放行至 ' + r.cells[p.process_name].override_until">破</span>
                  </template>
                  <span v-else class="dash">·</span>
                </td>
              </tr>
              <tr v-if="!(matrix.rows || []).length">
                <td :colspan="(matrix.processes || []).length + 2" class="empty">没有匹配的员工</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mut tiny" style="margin-top: 8px">
          点任意格子可对该员工评定这道工序。共 {{ (matrix.rows || []).length }} 人 × {{ (matrix.processes || []).length }} 道工序；
          会 2 道以上且达标的 {{ matrix.summary ? matrix.summary.multi_skill : 0 }} 人。
          <template v-if="matrix.without_skill">
            另有 <b>{{ matrix.without_skill }}</b> 人（在职 {{ matrix.summary ? matrix.summary.employees_all : '' }} 人）
            <b>一条技能记录都没有</b>，未列入矩阵 —— 不显示不等于不存在，这类人排产时等于「不可用」。
          </template>
        </p>
      </div>

      <!-- ============ 覆盖缺口 ============ -->
      <div v-if="tab === 'coverage'">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 120px">工序</th>
              <th style="width: 100px">工作中心</th>
              <th style="width: 86px">门槛</th>
              <th style="width: 74px">是否受限</th>
              <th style="width: 86px">合格 / 需要</th>
              <th style="width: 70px">缺口</th>
              <th style="width: 84px">仅报工</th>
              <th style="width: 70px">已过期</th>
              <th style="width: 70px">破格</th>
              <th>合格人员</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="x in cov.list || []" :key="x.process_name">
              <td><b>{{ x.process_name }}</b></td>
              <td class="mut">{{ x.work_center || '—' }}</td>
              <td>{{ x.min_level_label }}</td>
              <td><span class="tag" :class="x.restricted ? 'orange' : 'gray'">{{ x.restricted ? '受限' : '只提示' }}</span></td>
              <td><b>{{ x.qualified }}</b> / {{ x.min_headcount }}</td>
              <td>
                <span v-if="x.gap" class="tag red">缺 {{ x.gap }}</span>
                <span v-else class="tag green">够</span>
              </td>
              <td class="mut">{{ x.evidence_only || 0 }}</td>
              <td :class="{ red: x.expired > 0 }">{{ x.expired || 0 }}</td>
              <td :class="{ amp: x.overrides > 0 }">{{ x.overrides || 0 }}</td>
              <td class="tiny">
                <span v-if="x.people.length">{{ x.people.map((p) => p.name + '(' + p.level + '级)').join('、') }}</span>
                <span v-else class="mut">无人合格<template v-if="x.note"> · {{ x.note }}</template></span>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="two">
          <div class="box">
            <div class="box-h">排程/报工用到、但没建门槛的工序（{{ (cov.unmapped || []).length }}）</div>
            <p class="mut tiny">这些工序现在<b>既没有资格门槛，也没有标准工时</b>，排产时按设备产能排，实际有没有人会做没人知道。</p>
            <table class="data" v-if="(cov.unmapped || []).length">
              <tbody>
                <tr v-for="u in cov.unmapped" :key="u.process_name">
                  <td style="width: 140px"><b>{{ u.process_name }}</b></td>
                  <td class="mut">被 {{ u.node_count }} 个生产节点使用</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="mut tiny">所有生产节点用到的工序都已建门槛。</p>
          </div>
          <div class="box">
            <div class="box-h">报工能不能归到人</div>
            <p class="mut tiny">
              共 {{ cov.summary ? cov.summary.report_total : 0 }} 条报工，
              <b>{{ cov.summary ? cov.summary.report_no_employee : 0 }}</b> 条查不到员工档案
              （可归属率 {{ cov.summary && cov.summary.report_employee_rate != null ? cov.summary.report_employee_rate + '%' : '—' }}）。
              查不到人的报工<b>不拦</b>，但这部分技能永远进不了矩阵 —— 该补档案，不是该堵报工。
            </p>
            <p class="mut tiny" style="margin-top: 8px">
              汇总：够 {{ cov.summary ? cov.summary.ok : 0 }} 道 · 缺人 {{ cov.summary ? cov.summary.short : 0 }} 道 ·
              无人 {{ cov.summary ? cov.summary.none : 0 }} 道 · 受限 {{ cov.summary ? cov.summary.restricted : 0 }} 道
            </p>
          </div>
        </div>
      </div>

      <!-- ============ 到期提醒 ============ -->
      <div v-if="tab === 'expiring'">
        <div class="panel-head" style="margin-bottom: 10px">
          <div class="mut">技能复评 / 资格证书 / 复训，三种到期合并看</div>
          <select v-model.number="expDays" class="input" style="width: 120px" @change="loadExp">
            <option :value="30">30 天内</option>
            <option :value="60">60 天内</option>
            <option :value="90">90 天内</option>
            <option :value="180">180 天内</option>
          </select>
        </div>
        <table class="data">
          <thead>
            <tr>
              <th style="width: 96px">类型</th>
              <th style="width: 110px">员工</th>
              <th>事项</th>
              <th style="width: 110px">到期日</th>
              <th style="width: 96px">剩余</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(x, i) in exp.rows || []" :key="i">
              <td><span class="tag" :class="x.kind === 'cert' ? 'blue' : (x.kind === 'skill' ? 'purple' : 'gray')">{{ x.kind_label }}</span></td>
              <td>{{ x.employee_name }}</td>
              <td>{{ x.item }}</td>
              <td>{{ x.expire_date }}</td>
              <td>
                <span v-if="x.overdue" class="tag red">已过期 {{ -x.days_left }} 天</span>
                <span v-else :class="{ amp: x.days_left <= 30 }">{{ x.days_left }} 天</span>
              </td>
            </tr>
            <tr v-if="!(exp.rows || []).length"><td colspan="5" class="empty">这段时间没有到期的资格</td></tr>
          </tbody>
        </table>
      </div>

      <!-- ============ 证书 ============ -->
      <div v-if="tab === 'certs'">
        <div class="panel-head" style="margin-bottom: 10px">
          <div class="mut">员工个人资格证（公司证照在「行政合同」里，两回事）</div>
          <button class="btn btn-primary btn-sm" @click="openCert()">登记证书</button>
        </div>
        <div class="form-box" v-if="certPanel">
          <div class="row">
            <label>员工</label>
            <select v-model.number="certForm.employee_id" class="input">
              <option :value="0">选择员工</option>
              <option v-for="e in employees" :key="e.employee_id" :value="e.employee_id">{{ e.name }}（{{ e.code }}）</option>
            </select>
            <label>证书类型</label>
            <input v-model="certForm.cert_type" class="input" placeholder="叉车证 / 电工证 / 质检资格" />
          </div>
          <div class="row">
            <label>证书号</label>
            <input v-model="certForm.cert_no" class="input" />
            <label>发证机关</label>
            <input v-model="certForm.issuer" class="input" />
            <label>到期日</label>
            <input v-model="certForm.expire_date" type="date" class="input" />
          </div>
          <div class="form-foot">
            <button class="btn btn-sm btn-primary" @click="submitCert">保存</button>
            <button class="btn btn-sm btn-ghost" @click="certPanel = false">取消</button>
          </div>
        </div>
        <table class="data">
          <thead>
            <tr>
              <th style="width: 110px">员工</th>
              <th style="width: 150px">类型</th>
              <th style="width: 150px">证书号</th>
              <th style="width: 130px">发证机关</th>
              <th style="width: 110px">到期日</th>
              <th style="width: 90px">状态</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in certs" :key="c.id">
              <td>{{ c.employee_name }}</td>
              <td>{{ c.cert_type }}</td>
              <td class="mut">{{ c.cert_no || '—' }}</td>
              <td class="mut">{{ c.issuer || '—' }}</td>
              <td>{{ c.expire_date || '长期' }}</td>
              <td><span class="tag" :class="certTag(c)">{{ certLabel(c) }}</span></td>
              <td class="tiny mut">{{ c.remark || '' }}</td>
            </tr>
            <tr v-if="!certs.length"><td colspan="7" class="empty">还没有登记证书</td></tr>
          </tbody>
        </table>
      </div>

      <!-- ============ 培训 ============ -->
      <div v-if="tab === 'training'">
        <div class="panel-head" style="margin-bottom: 10px">
          <div class="mut">课程 / 考试 / 复训都在这里；<b>不通过与不扣款、不自动降级</b>，只提示安排复训</div>
          <button class="btn btn-primary btn-sm" @click="openTrain()">安排培训</button>
        </div>
        <div class="form-box" v-if="trainPanel">
          <div class="row">
            <label>员工</label>
            <select v-model.number="trainForm.employee_id" class="input">
              <option :value="0">选择员工</option>
              <option v-for="e in employees" :key="e.employee_id" :value="e.employee_id">{{ e.name }}</option>
            </select>
            <label>课程</label>
            <input v-model="trainForm.course_name" class="input" placeholder="课程名称" />
            <label>类型</label>
            <select v-model="trainForm.course_type" class="input">
              <option v-for="t in meta.course_types || []" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
            <label>计划日</label>
            <input v-model="trainForm.planned_at" type="date" class="input" />
          </div>
          <div class="form-foot">
            <button class="btn btn-sm btn-primary" @click="submitTrain">保存</button>
            <button class="btn btn-sm btn-ghost" @click="trainPanel = false">取消</button>
          </div>
        </div>
        <table class="data">
          <thead>
            <tr>
              <th style="width: 100px">员工</th>
              <th>课程</th>
              <th style="width: 100px">类型</th>
              <th style="width: 104px">计划 / 完成</th>
              <th style="width: 74px">成绩</th>
              <th style="width: 88px">结果</th>
              <th style="width: 104px">复训到期</th>
              <th style="width: 140px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in trainings" :key="r.id">
              <td>{{ r.employee_name }}</td>
              <td>{{ r.course_name }}</td>
              <td class="mut tiny">{{ typeLabel(r.course_type) }}</td>
              <td class="tiny">{{ r.planned_at || '—' }}<br /><span class="mut">{{ r.finished_at || '未完成' }}</span></td>
              <td>{{ r.score == null ? '—' : r.score }}</td>
              <td><span class="tag" :class="r.result === 'pass' ? 'green' : (r.result === 'fail' ? 'red' : 'gray')">{{ resultLabel(r.result) }}</span></td>
              <td class="tiny">{{ r.expire_date || '—' }}</td>
              <td>
                <template v-if="r.result === 'pending'">
                  <button class="btn btn-sm btn-ghost" @click="finishTrain(r, 'pass')">通过</button>
                  <button class="btn btn-sm btn-ghost" @click="finishTrain(r, 'fail')">不通过</button>
                </template>
                <span v-else class="mut tiny">已登记</span>
              </td>
            </tr>
            <tr v-if="!trainings.length"><td colspan="8" class="empty">还没有培训记录</td></tr>
          </tbody>
        </table>
      </div>

      <!-- ============ 工序门槛 ============ -->
      <div v-if="tab === 'rules'">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 130px">工序</th>
              <th style="width: 120px">工作中心</th>
              <th style="width: 110px">最低等级</th>
              <th style="width: 110px">至少几人</th>
              <th style="width: 110px">受限</th>
              <th style="width: 120px">当前合格</th>
              <th style="width: 120px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in meta.processes || []" :key="r.id">
              <td><b>{{ r.process_name }}</b></td>
              <td class="mut">{{ r.work_center || '—' }}</td>
              <td>
                <select v-model.number="r.min_level" class="input" style="width: 96px" :disabled="!canRule">
                  <option v-for="l in meta.levels || []" :key="l.value" :value="l.value">{{ l.label }}</option>
                </select>
              </td>
              <td><input v-model.number="r.min_headcount" type="number" min="1" class="input" style="width: 70px" :disabled="!canRule" /></td>
              <td>
                <label class="sw">
                  <input type="checkbox" v-model="r.restrictedBool" :disabled="!canRule" />
                  <span>{{ r.restricted ? '受限' : '只提示' }}</span>
                </label>
              </td>
              <td>
                <span class="tag" :class="covOf(r.process_name).qualified >= r.min_headcount ? 'green' : 'red'">
                  {{ covOf(r.process_name).qualified }} / {{ r.min_headcount }}
                </span>
              </td>
              <td><button class="btn btn-sm btn-ghost" :disabled="!canRule" @click="saveReq(r)">保存</button></td>
            </tr>
          </tbody>
        </table>
        <p class="mut tiny" style="margin-top: 8px">
          建议顺序：先看「覆盖缺口」里哪几道工序真的人不够，把够人的先设受限，缺人的先补人再设 ——
          一次全打开的结果是车间当场停线。
        </p>
      </div>
    </div>

    <!-- ============ 评定面板 ============ -->
    <div class="modal-mask" v-if="assessPanel">
      <div class="modal">
        <div class="modal-h">
          <b>评定技能</b>
          <span class="mut tiny">{{ assessForm.employee_name }} · {{ assessForm.process_name }}</span>
          <button class="btn btn-sm btn-ghost" @click="assessPanel = false">关闭</button>
        </div>
        <div class="modal-b">
          <div class="row">
            <label>等级</label>
            <select v-model.number="assessForm.level" class="input">
              <option v-for="l in meta.levels || []" :key="l.value" :value="l.value">{{ l.label }}（{{ l.value }} 级）</option>
            </select>
            <label>有效期至</label>
            <input v-model="assessForm.valid_until" type="date" class="input" />
          </div>
          <div class="row">
            <label>评定依据</label>
            <textarea v-model="assessForm.evidence" class="input" rows="3"
              placeholder="考了什么、做了几件、返工多少、谁在旁边看（至少 4 个字，写不清就别评）"></textarea>
          </div>
          <p class="hint" v-if="currentSkill">{{ currentSkillText }}</p>
          <p class="hint warn" v-else>这道工序还没有这个人的记录，评定后将从「仅有报工」升级为「考核评定」。</p>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="openOverrideFromAssess" v-if="needOverrideHint">开破格放行</button>
            <button class="btn btn-ghost danger-text" @click="revokeSkill" v-if="currentSkill && currentSkill.level">撤销资格</button>
            <button class="btn btn-primary" @click="submitAssess">保存评定</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 破格面板 ============ -->
    <div class="modal-mask" v-if="ovPanel">
      <div class="modal">
        <div class="modal-h">
          <b>破格放行</b>
          <span class="mut tiny">{{ ovForm.employee_name }} · {{ ovForm.process_name }}</span>
          <button class="btn btn-sm btn-ghost" @click="ovPanel = false">关闭</button>
        </div>
        <div class="modal-b">
          <p class="hint">破格不是绕过规则，是<b>把例外写清楚</b>：谁批的、为什么、到什么时候为止。会进覆盖清单。</p>
          <div class="row">
            <label>有效期至</label>
            <input v-model="ovForm.valid_until" type="date" class="input" />
          </div>
          <div class="row">
            <label>理由</label>
            <textarea v-model="ovForm.reason" class="input" rows="3" placeholder="至少 6 个字：为什么这次可以，限制到什么范围"></textarea>
          </div>
          <div class="modal-foot"><button class="btn btn-primary" @click="submitOverride">提交</button></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';

const tabs = [
  { key: 'matrix', label: '技能矩阵' },
  { key: 'coverage', label: '覆盖缺口' },
  { key: 'expiring', label: '到期提醒' },
  { key: 'certs', label: '资格证书' },
  { key: 'training', label: '培训记录' },
  { key: 'rules', label: '工序门槛' }
];

const tab = ref('matrix');
const dept = ref('');
const kw = ref('');
const expDays = ref(90);

const meta = ref({});
const matrix = ref({});
const cov = ref({});
const exp = ref({});
const certs = ref([]);
const trainings = ref([]);

const roles = computed(() => [].concat(auth.user?.roles || auth.user?.role || []));
const canRule = computed(() => roles.value.some((r) => ['admin', 'hr'].includes(r)));

// 矩阵里的员工清单，供下拉选择
const employees = computed(() => (matrix.value.rows || []).map((r) => ({ employee_id: r.employee_id, name: r.name, code: r.code })));

function lvClass(cell, proc) {
  if (cell.status === 'expired') return 'expired';
  if (cell.status === 'revoked') return 'revoked';
  if (proc.has_requirement && cell.meets) return 'ok';
  if (cell.source === 'actual') return 'evidence';
  return 'short';
}

const covOf = (name) => (cov.value.list || []).find((x) => x.process_name === name) || { qualified: 0 };

function certTag(c) {
  if (c.status === 'revoked') return 'gray';
  if (c.expire_date && c.expire_date < new Date().toISOString().slice(0, 10)) return 'red';
  return 'green';
}
function certLabel(c) {
  if (c.status === 'revoked') return '已作废';
  if (c.expire_date && c.expire_date < new Date().toISOString().slice(0, 10)) return '已过期';
  return '有效';
}
const typeLabel = (v) => ((meta.value.course_types || []).find((x) => x.value === v) || {}).label || v;
const resultLabel = (v) => ({ pass: '通过', fail: '未通过', pending: '待完成' }[v] || v);

async function loadMeta() {
  meta.value = await api.skMeta();
  (meta.value.processes || []).forEach((p) => { p.restrictedBool = !!p.restricted; });
}
async function loadMatrix() {
  matrix.value = await api.skMatrix({ department_id: dept.value || undefined, q: kw.value || undefined });
}
async function loadCov() { cov.value = await api.skCoverage(); }
async function loadExp() { exp.value = await api.skExpiring({ days: expDays.value }); }
async function loadCerts() { certs.value = await api.skCerts({}); }
async function loadTrainings() { trainings.value = await api.skTrainings({}); }

async function loadAll() {
  await Promise.all([loadMeta(), loadMatrix(), loadCov(), loadExp(), loadCerts(), loadTrainings()]);
}

/* ---------------- 评定 ---------------- */
const assessPanel = ref(false);
const currentSkill = ref(null);
const assessForm = reactive({ employee_id: 0, employee_name: '', process_name: '', level: 2, valid_until: '', evidence: '' });

const currentSkillText = computed(() => {
  const s = currentSkill.value;
  if (!s || !s.level) return '';
  return `当前：${s.level_label}（${s.source_label}）` + (s.valid_until ? ` · 有效期至 ${s.valid_until}` : '') +
    (s.report_count ? ` · 报工 ${s.report_count} 次` : '');
});
// 现在不合格但工序受限 → 提示可以走破格
const needOverrideHint = computed(() => {
  const s = currentSkill.value;
  const p = (matrix.value.processes || []).find((x) => x.process_name === assessForm.process_name);
  return !!(p && p.restricted && (!s || !s.meets));
});

function openAssess(row, proc) {
  const emp = row || (matrix.value.rows || [])[0];
  if (!emp) { alert('没有可评定的员工'); return; }
  assessForm.employee_id = emp.employee_id;
  assessForm.employee_name = emp.name;
  assessForm.process_name = proc ? proc.process_name : ((matrix.value.processes || [])[0] || {}).process_name || '';
  if (!assessForm.process_name) { alert('还没有工序门槛，请先到「工序门槛」建一条'); return; }
  currentSkill.value = (emp.cells || {})[assessForm.process_name] || null;
  assessForm.level = currentSkill.value && currentSkill.value.level ? currentSkill.value.level : 2;
  assessForm.valid_until = (currentSkill.value && currentSkill.value.valid_until) || '';
  assessForm.evidence = '';
  assessPanel.value = true;
}

async function submitAssess() {
  try {
    const r = await api.skAssess({
      employee_id: assessForm.employee_id,
      process_name: assessForm.process_name,
      level: assessForm.level,
      valid_until: assessForm.valid_until || null,
      evidence: assessForm.evidence
    });
    assessPanel.value = false;
    await loadAll();
    if (r.downgraded) alert(`已从 ${r.before.level} 级降为 ${r.level} 级（复评未达标）`);
  } catch (e) { alert(e.message); }
}

async function revokeSkill() {
  const reason = prompt('撤销原因（至少 4 个字）');
  if (!reason) return;
  try {
    await api.skRevoke({ employee_id: assessForm.employee_id, process_name: assessForm.process_name, reason });
    assessPanel.value = false;
    await loadAll();
  } catch (e) { alert(e.message); }
}

/* ---------------- 破格 ---------------- */
const ovPanel = ref(false);
const ovForm = reactive({ employee_id: 0, employee_name: '', process_name: '', valid_until: '', reason: '' });

function openOverrideFromAssess() {
  ovForm.employee_id = assessForm.employee_id;
  ovForm.employee_name = assessForm.employee_name;
  ovForm.process_name = assessForm.process_name;
  ovForm.valid_until = '';
  ovForm.reason = '';
  assessPanel.value = false;
  ovPanel.value = true;
}
async function submitOverride() {
  try {
    await api.skOverride(ovForm);
    ovPanel.value = false;
    await loadAll();
  } catch (e) { alert(e.message); }
}

/* ---------------- 证书 ---------------- */
const certPanel = ref(false);
const certForm = reactive({ employee_id: 0, cert_type: '', cert_no: '', issuer: '', expire_date: '' });
function openCert() { certForm.employee_id = 0; certForm.cert_type = ''; certForm.cert_no = ''; certForm.issuer = ''; certForm.expire_date = ''; certPanel.value = true; }
async function submitCert() {
  try {
    await api.skAddCert(certForm);
    certPanel.value = false;
    await loadAll();
  } catch (e) { alert(e.message); }
}

/* ---------------- 培训 ---------------- */
const trainPanel = ref(false);
const trainForm = reactive({ employee_id: 0, course_name: '', course_type: 'skill', planned_at: '' });
function openTrain() { trainForm.employee_id = 0; trainForm.course_name = ''; trainForm.course_type = 'skill'; trainForm.planned_at = ''; trainPanel.value = true; }
async function submitTrain() {
  try {
    await api.skAddTraining(trainForm);
    trainPanel.value = false;
    await loadTrainings();
  } catch (e) { alert(e.message); }
}
async function finishTrain(row, result) {
  const score = prompt(`登记「${row.course_name}」成绩（可留空）`, '');
  try {
    const r = await api.skFinishTraining(row.id, { result, score: score === '' ? null : Number(score) });
    await Promise.all([loadTrainings(), loadMeta()]);
    if (r.note) alert(r.note);
  } catch (e) { alert(e.message); }
}

/* ---------------- 门槛 ---------------- */
async function saveReq(r) {
  try {
    const out = await api.skSaveReq({
      process_name: r.process_name,
      work_center: r.work_center,
      min_level: r.min_level,
      min_headcount: r.min_headcount,
      restricted: !!r.restrictedBool
    });
    await Promise.all([loadMeta(), loadCov(), loadMatrix()]);
    if (out.warnings && out.warnings.length) alert(out.warnings.join('\n'));
  } catch (e) { alert(e.message); }
}

onMounted(loadAll);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
/* tabs 按钮不许被压缩成竖排文字 */
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }
.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 108px; padding: 14px 12px; }
.cards.c6 .stat-card .value { font-size: 23px; margin-top: 6px; }
.cards.c6 .stat-card .foot { font-size: 12px; line-height: 1.45; }

/* 12 道工序 × 24 人的表必须有横向滚动，且首列（员工）要钉住，
   否则滚到右边就不知道这一行是谁 */
.matrix-wrap { overflow-x: auto; border: 1px solid #eef1f6; border-radius: 10px; }
table.matrix { min-width: 100%; }
table.matrix th, table.matrix td { white-space: nowrap; text-align: center; padding: 5px 6px; font-size: 12px; }
table.matrix th { font-size: 12px; line-height: 1.3; }
table.matrix .req-lv { font-size: 12px; color: var(--ink-mute); font-weight: 400; }
table.matrix .req-dot { font-size: 12px; color: #b45309; background: #fff7e6; border-radius: 3px; padding: 0 3px; margin-left: 2px; }
.sticky-col { position: sticky; left: 0; background: var(--surface); z-index: 2; text-align: left !important; }
table.matrix thead .sticky-col { background: var(--surface-2); }
.who { font-weight: 600; font-size: 12.5px; }
.tiny { font-size: 12px; }
table.matrix .cell { cursor: pointer; }
table.matrix .cell:hover { background: #f1f5ff; }
.lv { display: inline-block; min-width: 38px; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
.lv.ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.lv.short { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
.lv.expired, .lv.revoked { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; text-decoration: line-through; }
.lv.evidence { background: #f1f5f9; color: var(--ink-soft); border: 1px dashed #cbd5e1; }
.ov { font-size: 12px; color: #7c3aed; margin-left: 4px; vertical-align: top; }
.dash { color: #cbd5e1; }

.panel .tag { white-space: nowrap; }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
.box { border: 1px solid #eef1f6; border-radius: 10px; padding: 12px 14px; }
.box-h { font-weight: 600; font-size: 13px; margin-bottom: 6px; }

.caliber { background: var(--surface-2); border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
.caliber summary { cursor: pointer; font-size: 12.5px; color: var(--ink-soft); }
.caliber ol { margin: 8px 0 0 18px; font-size: 12px; color: var(--ink-soft); line-height: 1.75; }

.form-box { border: 1px solid #e6ebf3; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: #fcfdff; }
.form-box .row, .modal-b .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.form-box .row label, .modal-b .row label { font-size: 12px; color: var(--ink-soft); min-width: 62px; }
.form-box .row .input, .modal-b .row .input { flex: 1; min-width: 120px; }
.form-foot { display: flex; gap: 8px; justify-content: flex-end; }

.sw { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }

@media (max-width: 620px) {
  /* 窄屏：标题区与筛选区各自成块，「评定技能」不能被挤出屏幕 */
  .page-head { flex-direction: column; align-items: stretch; }
  .head-ops { flex-wrap: wrap; }
  .head-ops .input { flex: 1; min-width: 96px; width: auto !important; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  /* tabs 不许把每个字压成一列，改成横向滚动 */
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; margin-left: 0; padding-bottom: 2px; }
  .panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }
  .two { grid-template-columns: 1fr; }
}

.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: var(--surface); border-radius: 12px; width: 560px; max-width: 94vw; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25); }
.modal-h { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #eef1f6; }
.modal-h b { flex: 0 0 auto; }
.modal-h .mut { flex: 1; }
.modal-b { padding: 14px 16px; }
.modal-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.hint { font-size: 12px; color: var(--ink-soft); background: var(--surface-2); border-radius: 6px; padding: 7px 9px; margin: 6px 0; }
.hint.warn { color: #b45309; background: #fffbeb; }
.danger-text { color: #b91c1c; }

.g { color: #047857; } .a { color: #b45309; } .r { color: #b91c1c; }
.amp { color: #b45309; font-weight: 600; }
.red { color: #b91c1c; }
</style>
