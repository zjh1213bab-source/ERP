<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>供应商评价与备用产能</h2>
        <p class="sub">
          真实样本 → 评价 → 整改 / 备用验证 → 供货资格。样本全部取自收料单，不手填；
          <b>样本不足不排名</b>；备用工厂必须技术 / 封样 / 合规三项验证都过才可用，<b>不自动选最低价</b>。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openCollect()">＋ 生成评价</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>供应商</span><strong>{{ stat.suppliers || 0 }}</strong><small>在用档案</small></div>
      <div class="stat"><span>已排名</span><strong class="amt-green">{{ stat.ranked || 0 }}</strong><small>样本足够</small></div>
      <div class="stat"><span>样本不足</span><strong :class="stat.insufficient ? 'amt-orange' : ''">{{ stat.insufficient || 0 }}</strong><small>不参与排名</small></div>
      <div class="stat"><span>需改进</span><strong :class="stat.improve ? 'amt-orange' : ''">{{ stat.improve || 0 }}</strong><small>C / D 级</small></div>
      <div class="stat"><span>暂停新单</span><strong :class="stat.suspended ? 'amt-red' : ''">{{ stat.suspended || 0 }}</strong><small>下单会被拦</small></div>
      <div class="stat"><span>待闭环整改</span><strong :class="stat.open_rects ? 'amt-orange' : ''">{{ stat.open_rects || 0 }}</strong><small>未验证通过</small></div>
      <div class="stat"><span>可用备用</span><strong>{{ stat.backups_verified || 0 }}</strong><small>待验证 {{ stat.backups_pending || 0 }}</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'eval' }" @click="tab = 'eval'">评价与排名</button>
        <button :class="{ on: tab === 'qual' }" @click="tab = 'qual'; loadQuals()">供货资格</button>
        <button :class="{ on: tab === 'rect' }" @click="tab = 'rect'; loadRects()">整改</button>
        <button :class="{ on: tab === 'backup' }" @click="tab = 'backup'; loadBackups()">备用产能</button>
      </div>
      <template v-if="tab === 'eval'">
        <input class="input" v-model="q" placeholder="供应商 / 编号 / 简称" style="width: 200px" @keyup.enter="loadBoard" />
        <select class="select" v-model="only" style="width: 150px" @change="loadBoard">
          <option value="">全部</option>
          <option value="ranked">只看已排名</option>
          <option value="improve">只看需改进</option>
          <option value="insufficient">只看样本不足</option>
        </select>
        <button class="btn btn-ghost" @click="loadBoard">查询</button>
      </template>
    </div>

    <!-- ================= 评价与排名 ================= -->
    <div v-if="tab === 'eval'" class="table-wrap">
      <table class="data eval-tbl">
        <thead>
          <tr>
            <th style="width: 52px">名次</th>
            <th style="width: 150px">供方</th>
            <th style="width: 190px">公司 / 类型</th>
            <th style="width: 150px">观察期</th>
            <th style="width: 88px" class="num">准交样本</th>
            <th style="width: 96px" class="num">不良样本</th>
            <th style="width: 110px" class="num">剩余负荷</th>
            <th style="width: 160px">评价</th>
            <th style="width: 130px">供货资格</th>
            <th style="width: 170px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.supplier_id" :class="{ 'row-suspend': r.qualification && r.qualification.status === 'suspended' }">
            <td class="center">
              <span v-if="r.rank" class="rank">{{ r.rank }}</span>
              <span v-else class="na">—</span>
            </td>
            <td>
              <div class="sup-name">{{ r.name }}</div>
              <div class="tiny">{{ r.contact || '' }} {{ r.phone ? '· ' + r.phone : '' }}</div>
            </td>
            <td>
              <div>{{ r.code || '-' }}</div>
              <div class="tiny">{{ catLabel(r.category) }}</div>
            </td>
            <td class="tiny">
              <template v-if="r.ev">{{ r.ev.period_start }} ~ {{ r.ev.period_end }}<br /><span class="mono">{{ r.ev.ev_no }}</span></template>
              <span v-else>未评价</span>
            </td>
            <td class="num">
              <template v-if="r.ev">
                <b>{{ r.ev.on_time_count }}/{{ r.ev.sample_total }}</b>
                <div class="tiny" :class="r.ev.on_time_rate !== null && r.ev.on_time_rate < 80 ? 'warn' : ''">准交 {{ r.ev.on_time_rate === null ? '-' : r.ev.on_time_rate + '%' }}</div>
                <div v-if="r.ev.no_due_count" class="tiny">另有 {{ r.ev.no_due_count }} 单无承诺日</div>
              </template>
              <span v-else>-</span>
            </td>
            <td class="num">
              <template v-if="r.ev">
                <b :class="r.ev.defect_rate > 3 ? 'warn' : ''">{{ r.ev.defect_rate === null ? '-' : r.ev.defect_rate + '%' }}</b>
                <div class="tiny">退 {{ fmt(r.ev.reject_qty) }} / 冻 {{ fmt(r.ev.freeze_qty) }}</div>
                <div v-if="r.ev.short_orders" class="tiny warn">短收 {{ r.ev.short_orders }} 单</div>
              </template>
              <span v-else>-</span>
            </td>
            <td class="num">
              <template v-if="r.ev && r.ev.remaining_qty !== null">
                {{ fmt(r.ev.remaining_qty) }}
                <div class="tiny">产能 {{ fmt(r.ev.capacity_qty) }}</div>
              </template>
              <span v-else class="tiny">未登记备用</span>
            </td>
            <td>
              <template v-if="r.ev">
                <span class="tag" :class="gradeTag(r.ev.grade)">{{ r.ev.grade_label }}</span>
                <span v-if="r.ev.score !== null" class="score">{{ r.ev.score }}</span>
                <div class="tiny">{{ r.ev.status_label }}<span v-if="r.ev.late_count"> · 迟 {{ r.ev.late_count }} 单</span></div>
              </template>
              <span v-else class="tiny">—</span>
            </td>
            <td>
              <span v-if="r.qualification" class="tag" :class="qualTag(r.qualification.status)">{{ r.qualification.status_label }}</span>
              <span v-else class="tiny">未定</span>
              <div v-if="r.open_rects" class="tiny warn">整改 {{ r.open_rects }} 张未闭环</div>
            </td>
            <td class="ops">
              <button class="link-btn" @click="openDetail(r)">明细</button>
              <button v-if="canWrite" class="link-btn" @click="openCollect(r)">评价</button>
              <button v-if="canWrite && r.ev" class="link-btn" @click="openDecide(r)">落资格</button>
            </td>
          </tr>
          <tr v-if="!rows.length"><td colspan="10" class="empty-cell">没有匹配的供应商</td></tr>
        </tbody>
      </table>
    </div>

    <p v-if="tab === 'eval'" class="rule-note">
      口径：{{ ruleText }}
    </p>

    <!-- ================= 供货资格 ================= -->
    <div v-if="tab === 'qual'" class="table-wrap">
      <table class="data">
        <thead>
          <tr><th style="width: 200px">供应商</th><th style="width: 130px">资格</th><th style="width: 90px">类型</th><th>依据</th><th style="width: 110px">待闭环整改</th><th style="width: 160px">最近决定</th></tr>
        </thead>
        <tbody>
          <tr v-for="q in quals" :key="q.supplier_id">
            <td><b>{{ q.supplier_name }}</b><div class="tiny">{{ q.code || '' }}</div></td>
            <td><span class="tag" :class="qualTag(q.status)">{{ q.status_label }}</span></td>
            <td class="tiny">{{ catLabel(q.category) }}</td>
            <td class="wrap">{{ q.reason || '-' }}</td>
            <td class="num"><span :class="q.open_rects ? 'warn' : ''">{{ q.open_rects || 0 }}</span></td>
            <td class="tiny">{{ q.decided_by || '-' }}<br />{{ $fmt(q.decided_at) }}</td>
          </tr>
          <tr v-if="!quals.length"><td colspan="6" class="empty-cell">还没有落过供货资格：先在「评价与排名」里做一次评价并点「落资格」</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        采购下单会按这里的资格卡：<b>暂停新单</b>的供应商建不了采购单；有条件 / 观察期可以下，但会提示原因。
      </p>
    </div>

    <!-- ================= 整改 ================= -->
    <div v-if="tab === 'rect'" class="table-wrap">
      <table class="data">
        <thead>
          <tr><th style="width: 140px">整改单</th><th style="width: 160px">供应商</th><th>问题</th><th>整改要求</th><th style="width: 100px">期限</th><th style="width: 110px">状态</th><th style="width: 180px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rects" :key="r.id" :class="{ 'row-suspend': r.overdue }">
            <td class="mono">{{ r.rect_no }}</td>
            <td>{{ r.supplier_name }}</td>
            <td class="wrap">{{ r.issue }}</td>
            <td class="wrap">{{ r.action }}</td>
            <td>{{ r.due_date || '-' }}<div v-if="r.overdue" class="tiny warn">已逾期</div></td>
            <td><span class="tag" :class="rectTag(r.status)">{{ r.status_label }}</span></td>
            <td class="ops">
              <template v-if="canWrite">
                <button v-if="r.status === 'open' || r.status === 'failed'" class="link-btn" @click="openSubmit(r)">提交整改</button>
                <button v-if="r.status !== 'verified'" class="link-btn" @click="openVerify(r)">验证</button>
              </template>
              <span v-if="r.status === 'verified'" class="tiny">{{ r.verify_note }}</span>
            </td>
          </tr>
          <tr v-if="!rects.length"><td colspan="7" class="empty-cell">没有整改单</td></tr>
        </tbody>
      </table>
      <p class="rule-note">
        整改验证通过后：还有别的单没闭环就继续「有条件」，全闭环且最近评价达 A/B 才回到「合格」；验证不通过直接「暂停新单」。
      </p>
    </div>

    <!-- ================= 备用产能 ================= -->
    <div v-if="tab === 'backup'">
      <div class="toolbar" style="margin-bottom: 12px">
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openBackup()">＋ 登记备用产能</button>
        <input class="input" v-model="pickQty" type="number" placeholder="需求量" style="width: 110px" />
        <input class="input" v-model="pickScope" placeholder="范围（面料 / 印花 / 成衣加工）" style="width: 200px" />
        <button class="btn btn-ghost btn-sm" @click="doPick">备用选源</button>
        <span v-if="pickNote" class="tiny" style="max-width: 520px">{{ pickNote }}</span>
      </div>

      <div v-if="picks.length" class="pick-box">
        <div class="pick-title">可用备选（按综合分 → 剩余负荷排序，报价只展示不参与排序）</div>
        <div v-for="p in picks" :key="p.id" class="pick-row">
          <span class="tag green">{{ p.grade_label }}</span>
          <b>{{ p.supplier_name }}</b>
          <span class="tiny">{{ p.scope }} · {{ p.item_desc }}</span>
          <span class="pill">综合分 {{ p.score === null ? '样本不足' : p.score }}</span>
          <span class="pill">准交 {{ p.on_time_rate === null ? '-' : p.on_time_rate + '%' }}</span>
          <span class="pill">剩余 {{ fmt(p.remaining_qty) }}</span>
          <span class="pill price">参考价 {{ p.price_ref === null ? '-' : p.price_ref }}</span>
          <span class="pill">{{ p.lead_days || '-' }} 天</span>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th style="width: 170px">供应商</th><th style="width: 110px">范围</th><th>可做品类</th><th style="width: 200px">三项验证</th><th style="width: 120px" class="num">产能 / 剩余</th><th style="width: 90px" class="num">参考价</th><th style="width: 100px">状态</th><th style="width: 160px">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="b in backups" :key="b.id">
              <td><b>{{ b.supplier_name }}</b><div class="tiny">{{ b.code || '' }}</div></td>
              <td>{{ b.scope || '-' }}</td>
              <td class="wrap">{{ b.item_desc || '-' }}</td>
              <td>
                <span class="vchk" :class="{ on: b.tech_ok }">技术</span>
                <span class="vchk" :class="{ on: b.sample_ok }">封样</span>
                <span class="vchk" :class="{ on: b.compliance_ok }">合规</span>
                <div v-if="b.missing && b.missing.length" class="tiny warn">缺 {{ b.missing.join('、') }}</div>
              </td>
              <td class="num">{{ fmt(b.capacity_qty) }}<div class="tiny">剩余 {{ fmt(b.remaining_qty) }}</div></td>
              <td class="num">{{ b.price_ref === null ? '-' : b.price_ref }}</td>
              <td><span class="tag" :class="bakTag(b.status)">{{ b.status_label }}</span></td>
              <td class="ops">
                <template v-if="canWrite && b.status !== 'verified'">
                  <button class="link-btn" @click="openBackup(b)">编辑</button>
                  <button class="link-btn" @click="openBakVerify(b)">验证</button>
                  <button class="link-btn danger" @click="rejectBackup(b)">判不通过</button>
                </template>
                <span v-else-if="b.status === 'verified'" class="tiny">{{ b.verify_note || '已验证' }}</span>
              </td>
            </tr>
            <tr v-if="!backups.length"><td colspan="8" class="empty-cell">还没有备用产能记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============ 生成评价 ============ -->
    <div v-if="collectOpen" class="modal-mask" @click.self="collectOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>生成供应商评价</h3>
          <button class="x" @click="collectOpen = false">×</button>
        </div>
        <div class="modal-body">
          <p class="tiny" style="margin: 0 0 12px">
            样本从观察期内的收料单自动汇总（实际到货日 vs 采购承诺日、合格/冻结/退回数量），不需要手填。
          </p>
          <div class="form-grid">
            <div class="fitem full">
              <label>供应商 *</label>
              <select class="select" v-model.number="cForm.supplier_id">
                <option :value="null">— 选择供应商 —</option>
                <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}（{{ s.code || s.category }}）</option>
              </select>
            </div>
            <div class="fitem"><label>观察期起 *</label><input class="input" type="date" v-model="cForm.period_start" /></div>
            <div class="fitem"><label>观察期止 *</label><input class="input" type="date" v-model="cForm.period_end" /></div>
            <div class="fitem">
              <label>报价条件分（0-100，空=60 中性）</label>
              <input class="input" type="number" v-model="cForm.price_score" placeholder="按账期/含运/含税综合打" />
            </div>
            <div class="fitem">
              <label>有效产能（月，空=取备用产能）</label>
              <input class="input" type="number" v-model="cForm.capacity_qty" />
            </div>
            <div class="fitem full"><label>结论 / 证据</label><input class="input" v-model="cForm.conclusion" placeholder="如：本季度交付稳定，可放量" /></div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="collectOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doCollect">汇总样本并评价</button>
        </div>
      </div>
    </div>

    <!-- ============ 落供货资格 ============ -->
    <div v-if="decideRow" class="modal-mask" @click.self="decideRow = null">
      <div class="modal">
        <div class="modal-head">
          <h3>落供货资格 · {{ decideRow.name }}</h3>
          <button class="x" @click="decideRow = null">×</button>
        </div>
        <div class="modal-body">
          <div class="dec-sum">
            <span class="tag" :class="gradeTag(decideRow.ev.grade)">{{ decideRow.ev.grade_label }}</span>
            <span class="pill">综合 {{ decideRow.ev.score === null ? '-' : decideRow.ev.score }}</span>
            <span class="pill">准交 {{ decideRow.ev.on_time_rate === null ? '-' : decideRow.ev.on_time_rate + '%' }}</span>
            <span class="pill">不良 {{ decideRow.ev.defect_rate === null ? '-' : decideRow.ev.defect_rate + '%' }}</span>
            <span class="pill">样本 {{ decideRow.ev.sample_total }} 单</span>
          </div>
          <div class="radio-list">
            <label :class="{ dis: decideRow.ev.status === 'insufficient' || !['A','B'].includes(decideRow.ev.grade) }">
              <input type="radio" value="keep" v-model="dForm.action" />
              <span><b>维持合格供方</b><i>只对 A / B 级且无未闭环整改的可用</i></span>
            </label>
            <label>
              <input type="radio" value="rectify" v-model="dForm.action" />
              <span><b>开整改单，降为有条件供货</b><i>C 级走这条：写清问题与整改要求</i></span>
            </label>
            <label>
              <input type="radio" value="suspend" v-model="dForm.action" />
              <span><b>暂停新单</b><i>D 级走这条：采购下单会被直接拦住</i></span>
            </label>
            <label>
              <input type="radio" value="verify_backup" v-model="dForm.action" />
              <span><b>转备用验证（观察期）</b><i>样本不足时说「先做几单验证」，去备用产能登记三项验证</i></span>
            </label>
          </div>
          <div v-if="dForm.action === 'rectify' || dForm.action === 'suspend'" class="form-grid" style="margin-top: 12px">
            <div class="fitem full"><label>问题 *</label><textarea v-model="dForm.issue" rows="2" placeholder="准交率 60%，5 单里 2 单迟到（3 天、5 天）…"></textarea></div>
            <div class="fitem full"><label>整改要求 *</label><textarea v-model="dForm.action_req" rows="2" placeholder="排产提前 3 天，延迟须提前 3 天书面通知…"></textarea></div>
            <div class="fitem"><label>整改期限</label><input class="input" type="date" v-model="dForm.due_date" /></div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="decideRow = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doDecide">确认</button>
        </div>
      </div>
    </div>

    <!-- ============ 评价明细 ============ -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ detail.supplier.name }} · 评价明细</h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="sec-title">历史评价</div>
          <div class="table-wrap" style="margin-bottom: 14px">
            <table class="data">
              <thead>
                <tr><th style="width: 150px">评价单</th><th style="width: 150px">观察期</th><th class="num" style="width: 80px">样本</th><th class="num" style="width: 90px">准交率</th><th class="num" style="width: 90px">不良率</th><th class="num" style="width: 80px">综合分</th><th style="width: 110px">等级</th><th>结论</th></tr>
              </thead>
              <tbody>
                <tr v-for="e in detail.evaluations" :key="e.id">
                  <td class="mono">{{ e.ev_no }}</td>
                  <td class="tiny">{{ e.period_start }} ~ {{ e.period_end }}</td>
                  <td class="num">{{ e.sample_total }}</td>
                  <td class="num">{{ e.on_time_rate === null ? '-' : e.on_time_rate + '%' }}</td>
                  <td class="num">{{ e.defect_rate === null ? '-' : e.defect_rate + '%' }}</td>
                  <td class="num"><b>{{ e.score === null ? '-' : e.score }}</b></td>
                  <td><span class="tag" :class="gradeTag(e.grade)">{{ e.grade_label }}</span></td>
                  <td class="tiny wrap">{{ e.conclusion || '-' }}</td>
                </tr>
                <tr v-if="!detail.evaluations.length"><td colspan="8" class="empty-cell">还没有评价</td></tr>
              </tbody>
            </table>
          </div>

          <div class="sec-title">样本来源（收料单，最新一期的交付明细）</div>
          <div class="table-wrap" style="margin-bottom: 14px">
            <table class="data">
              <thead>
                <tr><th style="width: 150px">收料单</th><th style="width: 150px">采购单</th><th style="width: 110px">承诺日</th><th style="width: 110px">到货日</th><th style="width: 90px">迟到</th><th class="num" style="width: 90px">实收</th><th class="num" style="width: 90px">合格</th><th class="num" style="width: 80px">冻结</th><th class="num" style="width: 80px">退回</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in lastSamples" :key="s.grn_id">
                  <td class="mono">{{ s.grn_no }}</td>
                  <td class="mono">{{ s.po_no || '-' }}</td>
                  <td>{{ s.expect_date || '未设' }}</td>
                  <td>{{ s.receive_date }}</td>
                  <td :class="s.late_days ? 'warn' : ''">{{ s.late_days ? s.late_days + ' 天' : '准交' }}</td>
                  <td class="num">{{ fmt(s.receive_qty) }}</td>
                  <td class="num">{{ fmt(s.receive_qty - s.freeze_qty - s.reject_qty) }}</td>
                  <td class="num">{{ fmt(s.freeze_qty) }}</td>
                  <td class="num" :class="s.reject_qty ? 'warn' : ''">{{ fmt(s.reject_qty) }}</td>
                </tr>
                <tr v-if="!lastSamples.length"><td colspan="9" class="empty-cell">这一期没有样本</td></tr>
              </tbody>
            </table>
          </div>

          <div class="sec-title">整改与备用</div>
          <div v-if="detail.rectifications.length">
            <div v-for="r in detail.rectifications" :key="r.id" class="mini-row">
              <span class="tag" :class="rectTag(r.status)">{{ r.status_label }}</span>
              <b class="mono">{{ r.rect_no }}</b>
              <span class="tiny">{{ r.issue }}</span>
            </div>
          </div>
          <div v-if="detail.backups.length">
            <div v-for="b in detail.backups" :key="b.id" class="mini-row">
              <span class="tag" :class="bakTag(b.status)">{{ b.status_label }}</span>
              <span>{{ b.scope }} · {{ b.item_desc }}</span>
              <span class="tiny">产能 {{ fmt(b.capacity_qty) }} / 剩余 {{ fmt(b.remaining_qty) }}</span>
            </div>
          </div>
          <div v-if="!detail.rectifications.length && !detail.backups.length" class="tiny">没有整改单，也没有登记备用产能</div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="detail = null">关闭</button></div>
      </div>
    </div>

    <!-- ============ 提交整改 ============ -->
    <div v-if="rectSub" class="modal-mask" @click.self="rectSub = null">
      <div class="modal">
        <div class="modal-head"><h3>提交整改 · {{ rectSub.rect_no }}</h3><button class="x" @click="rectSub = null">×</button></div>
        <div class="modal-body">
          <div class="tiny" style="margin-bottom: 8px">问题：{{ rectSub.issue }}<br />要求：{{ rectSub.action }}</div>
          <div class="fitem"><label>整改做了什么 *</label><textarea v-model="rectSub._note" rows="3" placeholder="已把排产提前 3 天，退回批次改全检后发"></textarea></div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="rectSub = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doSubmitRect">提交</button>
        </div>
      </div>
    </div>

    <!-- ============ 验证整改 ============ -->
    <div v-if="rectVer" class="modal-mask" @click.self="rectVer = null">
      <div class="modal">
        <div class="modal-head"><h3>验证整改 · {{ rectVer.rect_no }}</h3><button class="x" @click="rectVer = null">×</button></div>
        <div class="modal-body">
          <div class="fitem"><label>验证依据 *</label><textarea v-model="rectVer._note" rows="3" placeholder="10 月两批均准交，抽检 200 件无退回"></textarea></div>
          <div class="radio-list" style="margin-top: 10px">
            <label><input type="radio" :value="true" v-model="rectVer._pass" /><span><b>通过</b><i>闭环后按最近评价决定回到合格还是有条件</i></span></label>
            <label><input type="radio" :value="false" v-model="rectVer._pass" /><span><b>不通过</b><i>直接暂停新单</i></span></label>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="rectVer = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doVerifyRect">提交验证</button>
        </div>
      </div>
    </div>

    <!-- ============ 登记备用产能 ============ -->
    <div v-if="bakForm" class="modal-mask" @click.self="bakForm = null">
      <div class="modal">
        <div class="modal-head"><h3>{{ bakForm.id ? '编辑' : '登记' }}备用产能</h3><button class="x" @click="bakForm = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>供应商 *</label>
              <select class="select" v-model.number="bakForm.supplier_id">
                <option :value="null">— 选择 —</option>
                <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>适用范围 *</label><input class="input" v-model="bakForm.scope" placeholder="面料 / 辅料 / 成衣加工 / 水洗 / 印花" /></div>
            <div class="fitem"><label>可做品类 / 款号范围</label><input class="input" v-model="bakForm.item_desc" /></div>
            <div class="fitem"><label>有效产能（月）</label><input class="input" type="number" v-model="bakForm.capacity_qty" /></div>
            <div class="fitem"><label>已占用</label><input class="input" type="number" v-model="bakForm.used_qty" /></div>
            <div class="fitem"><label>参考价</label><input class="input" type="number" step="0.01" v-model="bakForm.price_ref" /></div>
            <div class="fitem"><label>承诺交期（天）</label><input class="input" type="number" v-model="bakForm.lead_days" /></div>
            <div class="fitem full"><label>证据（封样单号 / 验厂报告 / 资质到期日）</label><input class="input" v-model="bakForm.evidence" /></div>
          </div>
          <p class="tiny" style="margin-top: 10px">登记后仍为「待验证」，需在列表里点「验证」把技术 / 封样 / 合规三项都勾上才算可用。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="bakForm = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doSaveBackup">保存</button>
        </div>
      </div>
    </div>

    <!-- ============ 备用三项验证 ============ -->
    <div v-if="bakVer" class="modal-mask" @click.self="bakVer = null">
      <div class="modal">
        <div class="modal-head"><h3>三项验证 · {{ bakVer.supplier_name }}</h3><button class="x" @click="bakVer = null">×</button></div>
        <div class="modal-body">
          <div class="radio-list">
            <label><input type="checkbox" v-model="bakVer.tech_ok" /><span><b>技术验证</b><i>设备与工艺能不能做这个品类</i></span></label>
            <label><input type="checkbox" v-model="bakVer.sample_ok" /><span><b>封样验证</b><i>打出来的样对不对（对色、尺寸、手感）</i></span></label>
            <label><input type="checkbox" v-model="bakVer.compliance_ok" /><span><b>合规验证</b><i>资质、验厂、环保在有效期内</i></span></label>
          </div>
          <div class="fitem" style="margin-top: 12px"><label>验证说明</label><textarea v-model="bakVer.verify_note" rows="2" placeholder="技术可做、封样对色通过、排污许可在有效期内"></textarea></div>
          <p class="tiny" style="margin-top: 8px">三项必须全勾才能置为「可用」——缺一项就不允许把单下给它。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="bakVer = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doVerifyBackup">置为可用</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('eval');
const rows = ref([]);
const stat = ref({});
const ruleText = ref('');
const q = ref('');
const only = ref('');
const busy = ref(false);
const formMsg = ref('');

const quals = ref([]);
const rects = ref([]);
const backups = ref([]);
const suppliers = ref([]);

const collectOpen = ref(false);
const cForm = ref({});
const decideRow = ref(null);
const dForm = ref({ action: 'keep' });
const detail = ref(null);
const rectSub = ref(null);
const rectVer = ref(null);
const bakForm = ref(null);
const bakVer = ref(null);
const picks = ref([]);
const pickQty = ref('');
const pickScope = ref('');
const pickNote = ref('');

const canWrite = computed(() => can('supplier.write'));

const CATS = { material: '面辅料', process: '加工', service: '服务', other: '其他' };
const catLabel = (c) => CATS[c] || c || '-';

const fmt = (v) => (v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));

function gradeTag(g) {
  return { A: 'green', B: 'blue', C: 'orange', D: 'red', NA: 'gray' }[g] || 'gray';
}
function qualTag(s) {
  return { qualified: 'green', conditional: 'orange', observing: 'blue', suspended: 'red' }[s] || 'gray';
}
function rectTag(s) {
  return { open: 'orange', submitted: 'blue', verified: 'green', failed: 'red' }[s] || 'gray';
}
function bakTag(s) {
  return { verified: 'green', pending: 'orange', rejected: 'red', expired: 'gray' }[s] || 'gray';
}

// 明细里「最新一期」的样本：用评价单的观察期回查收料单
const lastSamples = ref([]);

async function loadBoard() {
  try {
    const d = await api.supplierEvalBoard({ q: q.value, only: only.value });
    rows.value = d.rows;
    stat.value = d.stat;
    ruleText.value = d.rule;
  } catch (e) { alert(e.message); }
}

async function loadQuals() {
  try { quals.value = await api.supplierQualifications(); } catch (e) { alert(e.message); }
}
async function loadRects() {
  try { rects.value = await api.supplierRects({}); } catch (e) { alert(e.message); }
}
async function loadBackups() {
  try { backups.value = await api.supplierBackups({}); } catch (e) { alert(e.message); }
}
async function loadSuppliers() {
  try {
    const d = await api.suppliers();
    suppliers.value = Array.isArray(d) ? d : (d.rows || []);
  } catch (e) { suppliers.value = []; }
}

function reload() {
  loadBoard();
  if (tab.value === 'qual') loadQuals();
  if (tab.value === 'rect') loadRects();
  if (tab.value === 'backup') loadBackups();
}

function openCollect(row) {
  formMsg.value = '';
  const end = new Date();
  const start = new Date(Date.now() - 90 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  cForm.value = {
    supplier_id: row ? row.supplier_id : null,
    period_start: iso(start),
    period_end: iso(end),
    price_score: '',
    capacity_qty: '',
    conclusion: ''
  };
  collectOpen.value = true;
}

async function doCollect() {
  formMsg.value = '';
  if (!cForm.value.supplier_id) return (formMsg.value = '请选择供应商');
  busy.value = true;
  try {
    const r = await api.collectSupplierEval({ ...cForm.value });
    collectOpen.value = false;
    await loadBoard();
    const e = r.evaluation;
    let msg = `已生成 ${e.ev_no}\n准交 ${e.on_time_count}/${e.sample_total}（${e.on_time_rate === null ? '-' : e.on_time_rate + '%'}）· 不良率 ${e.defect_rate === null ? '-' : e.defect_rate + '%'} · 综合 ${e.score === null ? '-' : e.score} · ${e.grade_label}`;
    if (r.warnings && r.warnings.length) msg += '\n\n' + r.warnings.join('\n');
    alert(msg);
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

function openDecide(row) {
  formMsg.value = '';
  decideRow.value = row;
  const good = ['A', 'B'].includes(row.ev.grade) && row.ev.status !== 'insufficient' && !row.open_rects;
  dForm.value = {
    action: good ? 'keep' : row.ev.grade === 'D' ? 'suspend' : row.ev.status === 'insufficient' ? 'verify_backup' : 'rectify',
    issue: '',
    action_req: '',
    due_date: ''
  };
}

async function doDecide() {
  formMsg.value = '';
  busy.value = true;
  try {
    const r = await api.decideSupplierEval(decideRow.value.ev.id, { ...dForm.value });
    decideRow.value = null;
    await loadBoard();
    const qq = r.qualification;
    alert(
      qq ? `已更新为「${qq.status_label}」` :
      `已开整改单 ${r.rect_no}`
    );
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

async function openDetail(row) {
  try {
    const d = await api.supplierEvalDetail(row.supplier_id);
    lastSamples.value = d.last_samples || [];
    detail.value = d;
  } catch (e) { alert(e.message); }
}

function openSubmit(r) {
  formMsg.value = '';
  rectSub.value = { ...r, _note: '' };
}
async function doSubmitRect() {
  formMsg.value = '';
  if (!String(rectSub.value._note || '').trim()) return (formMsg.value = '请写明整改做了什么');
  busy.value = true;
  try {
    await api.submitSupplierRect(rectSub.value.id, { submit_note: rectSub.value._note });
    rectSub.value = null;
    await loadRects();
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

function openVerify(r) {
  formMsg.value = '';
  rectVer.value = { ...r, _note: '', _pass: true };
}
async function doVerifyRect() {
  formMsg.value = '';
  if (!String(rectVer.value._note || '').trim()) return (formMsg.value = '请写明验证依据');
  busy.value = true;
  try {
    const r = await api.verifySupplierRect(rectVer.value.id, { pass: rectVer.value._pass, note: rectVer.value._note });
    rectVer.value = null;
    await loadRects();
    loadBoard();
    alert(`整改${r.rectification.status_label}。资格：${r.qualification ? r.qualification.status_label : '-'}`);
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

function openBackup(b) {
  formMsg.value = '';
  bakForm.value = b
    ? { ...b }
    : { supplier_id: null, scope: '', item_desc: '', capacity_qty: '', used_qty: 0, price_ref: '', lead_days: '', evidence: '' };
}
async function doSaveBackup() {
  formMsg.value = '';
  if (!bakForm.value.supplier_id) return (formMsg.value = '请选择供应商');
  if (!String(bakForm.value.scope || '').trim()) return (formMsg.value = '请填适用范围');
  busy.value = true;
  try {
    await api.saveSupplierBackup({ ...bakForm.value });
    bakForm.value = null;
    await loadBackups();
    loadBoard();
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

function openBakVerify(b) {
  formMsg.value = '';
  bakVer.value = {
    ...b,
    tech_ok: !!b.tech_ok,
    sample_ok: !!b.sample_ok,
    compliance_ok: !!b.compliance_ok
  };
}
async function doVerifyBackup() {
  formMsg.value = '';
  busy.value = true;
  try {
    await api.verifySupplierBackup(bakVer.value.id, {
      tech_ok: bakVer.value.tech_ok,
      sample_ok: bakVer.value.sample_ok,
      compliance_ok: bakVer.value.compliance_ok,
      verify_note: bakVer.value.verify_note,
      evidence: bakVer.value.evidence
    });
    bakVer.value = null;
    await loadBackups();
    loadBoard();
    alert('已置为可用');
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

async function rejectBackup(b) {
  const note = prompt(`判「${b.supplier_name} · ${b.scope}」不通过的原因：`);
  if (note === null) return;
  if (!String(note).trim()) return alert('必须写原因');
  try {
    await api.rejectSupplierBackup(b.id, { verify_note: note.trim() });
    await loadBackups();
    loadBoard();
  } catch (e) { alert(e.message); }
}

async function doPick() {
  try {
    const d = await api.supplierBackupPick({ qty: pickQty.value, scope: pickScope.value });
    picks.value = d.rows;
    pickNote.value = d.sort_note;
    if (!d.rows.length) alert('没有已通过三项验证的备用产能，先去登记并验证');
  } catch (e) { alert(e.message); }
}

onMounted(() => {
  loadBoard();
  loadSuppliers();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.amt-blue { color: #2b6de5 !important; }
@media (max-width: 1280px) { .stat-row { grid-template-columns: repeat(4, 1fr); } }
@media (max-width: 760px) { .stat-row { grid-template-columns: repeat(2, 1fr); } }
.eval-tbl { min-width: 1080px; }
.row-suspend { background: #fff7f8; }
.center { text-align: center; }
.num { text-align: right; }
.rank { display: inline-block; min-width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 11px; background: #eaf1ff; color: #2563eb; font-weight: 700; font-size: 12px; }
.na { color: #b6bfcc; }
.sup-name { font-weight: 600; color: #16233b; }
.tiny { font-size: 11.5px; color: #8a94a6; line-height: 1.5; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
.score { margin-left: 6px; font-weight: 700; color: #16233b; }
.warn { color: #d92d45; }
.ops { white-space: nowrap; }
.wrap { white-space: normal !important; line-height: 1.55; }
.rule-note { margin: 10px 0 0; font-size: 11.5px; color: #8a94a6; line-height: 1.6; }
.sec-title { font-size: 12.5px; font-weight: 700; color: #16233b; margin: 4px 0 8px; }
.mini-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed #eef2f7; }
.pill { display: inline-block; background: #f2f5fa; color: #5b6474; border-radius: 10px; padding: 1px 8px; font-size: 11.5px; margin-right: 4px; }
.pill.price { background: #fff7e8; color: #a4670a; }
.pick-box { border: 1px solid #dbe4f5; background: #f7faff; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
.pick-title { font-size: 12px; font-weight: 700; color: #2563eb; margin-bottom: 8px; }
.pick-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; padding: 4px 0; }
.vchk { display: inline-block; font-size: 11px; border-radius: 9px; padding: 1px 7px; background: #f2f5fa; color: #a6b0c0; margin-right: 4px; }
.vchk.on { background: #e9f8ef; color: #12864a; font-weight: 600; }
.dec-sum { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.radio-list { display: flex; flex-direction: column; gap: 8px; }
.radio-list label { display: flex; align-items: flex-start; gap: 8px; border: 1px solid #e8edf4; border-radius: 9px; padding: 9px 11px; cursor: pointer; }
.radio-list label.dis { opacity: .5; cursor: not-allowed; }
.radio-list span { display: flex; flex-direction: column; gap: 2px; }
.radio-list b { font-size: 12.5px; color: #16233b; font-weight: 600; }
.radio-list i { font-size: 11.5px; color: #8a94a6; font-style: normal; }
</style>
