<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>研发立项与 SKU 配码主档</h2>
        <p class="sub">
          研发立项回答一个问题：<b>这个月到底开发了几个款</b>。所以里程碑必须分开数——
          <b>开发款数只数「技术核准」</b>，销售接收 / 下单 / 投产 / 上架是过程事件，<b>相加不等于开发款数</b>。
          立项与预计首单量<b>只做计划</b>：不产生采购单、不产生生产单、不改库存。
          SKU 侧：<b>单花单码唯一</b>；套装 / 配码包 / 箱规是<b>有版本的组合关系</b>，库存基本单位是件，<b>套必须能换算成件</b>。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.current_date || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite && tab === 'proj'" class="btn btn-primary" @click="openNewProject">新建立项</button>
        <button v-if="canWrite && tab === 'sku'" class="btn btn-primary" @click="openNewSku">新建 SKU</button>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'board' }" @click="switchTab('board')">研发总览</button>
      <button :class="{ on: tab === 'proj' }" @click="switchTab('proj')">研发立项</button>
      <button :class="{ on: tab === 'sku' }" @click="switchTab('sku')">SKU 与配码</button>
    </div>

    <!-- ================= 总览 ================= -->
    <div v-if="tab === 'board'">
      <div class="stat-row">
        <div class="stat">
          <span>本月新立项</span>
          <strong>{{ num(board.stat && board.stat.month_new) }}</strong>
          <small>计划量 {{ num(board.stat && board.stat.month_target_qty) }} 件（仅参考）</small>
        </div>
        <div class="stat">
          <span>开发完成</span>
          <strong>{{ num(board.stat && board.stat.dev_completed) }}</strong>
          <small>技术核准 {{ num(board.stat && board.stat.tech_approved_all) }} 款，已扣返单 {{ num(board.stat && board.stat.repeat_count) }} 款</small>
        </div>
        <div class="stat">
          <span>销售接收</span>
          <strong>{{ num(board.stat && board.stat.sales_accepted) }}</strong>
          <small>与开发完成不是同一件事</small>
        </div>
        <div class="stat">
          <span>已下单</span>
          <strong>{{ num(board.stat && board.stat.ordered_projects) }}</strong>
          <small>{{ num(board.stat && board.stat.ordered_qty) }} 件（里程碑登记）</small>
        </div>
        <div class="stat">
          <span>首次上架</span>
          <strong>{{ num(board.stat && board.stat.launched_projects) }}</strong>
          <small>{{ num(board.stat && board.stat.launched_qty) }} 件</small>
        </div>
        <div class="stat" :class="board.stat && board.stat.overdue_launch ? 'st-warn' : ''">
          <span>逾期未上市</span>
          <strong>{{ num(board.stat && board.stat.overdue_launch) }}</strong>
          <small>计划上市日已过、还没上架</small>
        </div>
      </div>

      <div class="help-bar">
        <b>口径（写在服务层，不靠人记）：</b>{{ board.counting_note }}<br />
        <b>计划边界：</b>{{ board.plan_note }}　当前在研 {{ num(board.stat && board.stat.active) }} 款 · SKU {{ num(board.stat && board.stat.sku_total) }} 个
      </div>

      <div class="panel">
        <h4>里程碑分别计数（不可相加）</h4>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>里程碑</th><th>含义</th><th class="num">款数</th><th class="num">件数</th><th>计入开发款数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in board.milestones || []" :key="m.k">
                <td><b>{{ m.label }}</b></td>
                <td class="tiny muted">{{ msMeaning(m.k) }}</td>
                <td class="num">
                  {{ m.projects }}
                  <span v-if="m.projects_all !== undefined && m.projects_all !== m.projects" class="tiny muted">（含返单 {{ m.projects_all }}）</span>
                </td>
                <td class="num">{{ m.qty ? num(m.qty) : '—' }}</td>
                <td>
                  <span class="tag" :class="m.counted ? 'green' : 'gray'">{{ m.counted ? '计入' : '不计入' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint-inline">
          把这几行加起来（{{ (board.milestones || []).reduce((s, m) => s + num(m.projects), 0) }}）
          不等于开发款数（{{ num(board.stat && board.stat.dev_completed) }}）：一个款会走完多个里程碑，也会跨月。
        </div>
      </div>

      <div class="two-col">
        <div class="panel">
          <h4>阶段分布</h4>
          <div v-for="s in board.stage_stat || []" :key="s.stage" class="bar-row">
            <span class="bar-label">{{ s.label }}</span>
            <div class="bar-track"><div class="bar-fill" :style="{ width: barW(s.count) }"></div></div>
            <span class="bar-num">{{ s.count }}</span>
          </div>
        </div>
        <div class="panel">
          <h4>逾期未上市</h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>项目</th><th>款号</th><th>计划上市</th><th>当前阶段</th></tr></thead>
              <tbody>
                <tr v-for="o in board.overdue || []" :key="o.id">
                  <td class="mono tiny">{{ o.project_no }}</td>
                  <td>{{ o.style_no }}</td>
                  <td class="red">{{ o.plan_launch_date }}</td>
                  <td class="tiny">{{ o.stage_label }}</td>
                </tr>
                <tr v-if="!(board.overdue || []).length"><td colspan="4" class="empty">没有逾期项目</td></tr>
              </tbody>
            </table>
          </div>
          <h4 style="margin-top: 16px">SKU 构成</h4>
          <div v-for="x in board.sku_stat || []" :key="x.kind" class="bar-row">
            <span class="bar-label">{{ x.label }}</span>
            <div class="bar-track"><div class="bar-fill b2" :style="{ width: barW2(x.count) }"></div></div>
            <span class="bar-num">{{ x.count }}（生效 {{ x.active }}）</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 研发立项 ================= -->
    <div v-if="tab === 'proj'">
      <div class="toolbar">
        <input v-model="pf.keyword" class="inp" placeholder="款号 / 款名 / 项目号" style="width: 200px" />
        <select v-model="pf.stage" class="inp" style="width: 140px">
          <option value="">全部阶段</option>
          <option v-for="s in dict.stages || []" :key="s.k" :value="s.k">{{ s.label }}</option>
        </select>
        <select v-model="pf.source" class="inp" style="width: 140px">
          <option value="">全部来源</option>
          <option v-for="s in dict.source || []" :key="s.k" :value="s.k">{{ s.label }}</option>
        </select>
        <button class="btn btn-ghost" @click="loadProjects">查询</button>
        <span class="tiny muted">{{ rows.length }} 个立项</span>
      </div>

      <div class="panel">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>项目号</th><th>款号 / 款名</th><th>业务</th><th>来源</th><th>阶段</th>
                <th class="num">计划量</th><th>里程碑</th><th class="num">任务</th><th>计划上市</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.id" :class="{ 'row-warn': r.launch_overdue }">
                <td class="mono tiny">{{ r.project_no }}</td>
                <td>
                  <b>{{ r.style_no }}</b>
                  <div class="tiny muted">{{ r.style_name || '—' }}</div>
                </td>
                <td class="tiny">{{ r.biz_type === 'spot' ? '现货' : '定制' }}</td>
                <td class="tiny">
                  <span class="tag" :class="r.source === 'repeat' ? 'blue' : (r.source === 'new_pattern' ? 'purple' : 'gray')">{{ r.source_label }}</span>
                </td>
                <td><span class="tag" :class="stageTag(r.stage)">{{ r.stage_label }}</span></td>
                <td class="num tiny">{{ r.target_qty ? num(r.target_qty) : '—' }}</td>
                <td class="tiny">
                  <span v-for="m in r.milestones" :key="m" class="ms-dot" :class="m" :title="msLabel(m)"></span>
                  <span class="tiny muted" style="margin-left: 4px">{{ r.milestone_done }}/5</span>
                </td>
                <td class="num tiny">
                  {{ r.task_done }}/{{ r.task_count }}
                  <span v-if="r.task_blocked" class="red" :title="`${r.task_blocked} 个任务阻塞`">!</span>
                </td>
                <td class="tiny" :class="{ red: r.launch_overdue }">{{ r.plan_launch_date || '—' }}</td>
                <td class="ops">
                  <button class="btn btn-ghost btn-sm" @click="openProject(r.id)">明细</button>
                </td>
              </tr>
              <tr v-if="!rows.length"><td colspan="10" class="empty">还没有研发立项</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ================= SKU ================= -->
    <div v-if="tab === 'sku'">
      <div class="help-bar">
        <b>库存基本单位是「件」。</b>单件 SKU 的花型 + 颜色 + 尺码 + 客户范围唯一；
        套装用「套」卖，但必须能换算成件（配码里要写清 1 套 = 哪几件）；
        箱规是「一箱装多少件、尺码怎么配」；<b>停用的别名不删</b>，历史单据还要靠它反查。
      </div>
      <div class="toolbar">
        <input v-model="sf.keyword" class="inp" placeholder="SKU / 款名 / 花型 / 颜色" style="width: 220px" />
        <select v-model="sf.kind" class="inp" style="width: 120px">
          <option value="">全部类型</option>
          <option value="single">单件</option>
          <option value="set">套装</option>
        </select>
        <button class="btn btn-ghost" @click="loadSkus">查询</button>
        <span class="tiny muted">{{ skus.length }} 个 SKU</span>
      </div>

      <div class="panel">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>SKU</th><th>款号</th><th>花型 / 颜色 / 尺码</th><th>类型</th><th>单位</th>
                <th>配码 / 箱规</th><th>换算</th><th class="num">别名</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in skus" :key="s.id" :class="{ 'row-muted': s.status !== 'active' }">
                <td class="mono">{{ s.sku }}</td>
                <td class="tiny">{{ s.style_no }}</td>
                <td class="tiny">{{ s.pattern || '—' }} / {{ s.color || '—' }} / {{ s.size || '—' }}</td>
                <td><span class="tag" :class="s.kind === 'set' ? 'purple' : 'gray'">{{ s.kind_label }}</span></td>
                <td class="tiny">{{ s.unit }}</td>
                <td class="tiny">
                  <span v-if="s.pack_spec">{{ s.pack_spec.pack_no }} · {{ s.pack_spec.kind_label }} · {{ num(s.pack_spec.total_qty) }} 件</span>
                  <span v-else class="muted">—</span>
                </td>
                <td class="tiny">
                  <span v-if="s.kind === 'single'" class="ok-line">按件</span>
                  <span v-else-if="s.convertible" class="ok-line">可按套换算</span>
                  <span v-else class="red">缺配码，算不出件</span>
                </td>
                <td class="num tiny">{{ s.alias_count || '—' }}</td>
                <td><span class="tag" :class="s.status === 'active' ? 'green' : 'gray'">{{ s.status === 'active' ? '生效' : '停用' }}</span></td>
                <td class="ops"><button class="btn btn-ghost btn-sm" @click="openSku(s.id)">明细</button></td>
              </tr>
              <tr v-if="!skus.length"><td colspan="10" class="empty">还没有 SKU</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ============ 新建立项 ============ -->
    <div v-if="pnew.open" class="modal-mask" @click.self="pnew.open = false">
      <div class="modal wide">
        <h3>新建研发立项</h3>
        <div class="fgrid">
          <label class="fl">款号 <span class="red">*</span><input v-model="pnew.style_no" placeholder="研发期没有正式款号也先占位" /></label>
          <label class="fl">款名<input v-model="pnew.style_name" /></label>
          <label class="fl">品类<input v-model="pnew.category" placeholder="上衣 / 裤子 / 外套" /></label>
          <label class="fl">季节<input v-model="pnew.season" placeholder="26AW" /></label>
          <label class="fl">业务
            <select v-model="pnew.biz_type"><option value="spot">现货</option><option value="custom">定制</option></select>
          </label>
          <label class="fl">开发来源
            <select v-model="pnew.source">
              <option v-for="s in dict.source || []" :key="s.k" :value="s.k">{{ s.label }}</option>
            </select>
          </label>
          <label v-if="pnew.source === 'repeat'" class="fl">复用原项目
            <select v-model="pnew.reuse_project_id">
              <option value="">请选择</option>
              <option v-for="p in reusableProjects" :key="p.id" :value="p.id">{{ p.project_no }} · {{ p.style_no }}</option>
            </select>
          </label>
          <label v-if="pnew.source === 'new_pattern'" class="fl">批准分类人 <span class="red">*</span>
            <input v-model="pnew.classify_approved_by" placeholder="算不算新开发要有依据" />
          </label>
          <label class="fl">技术负责人<input v-model="pnew.owner" /></label>
          <label class="fl">销售对接<input v-model="pnew.sales_owner" /></label>
          <label class="fl">版师<input v-model="pnew.pattern_maker" /></label>
          <label class="fl">预计首单量<input v-model.number="pnew.target_qty" type="number" min="0" /></label>
          <label class="fl">目标出厂价<input v-model.number="pnew.target_price" type="number" min="0" step="0.01" /></label>
          <label class="fl">计划上市日<input v-model="pnew.plan_launch_date" type="date" /></label>
        </div>
        <div class="hint-inline">
          预计首单量与计划上市日<b>只做计划</b>：不会生成采购单、不会生成生产单、不改库存。
          <span v-if="pnew.source === 'repeat'">返单复用要选一个<b>版型已确认可复用</b>的原项目（做过投产或上架才允许）。</span>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="pnew.open = false">取消</button>
          <button class="btn btn-primary" @click="submitProject">保存</button>
        </div>
      </div>
    </div>

    <!-- ============ 项目详情 ============ -->
    <div v-if="pdet.open && pdet.data" class="modal-mask" @click.self="pdet.open = false">
      <div class="modal xxwide">
        <h3>
          {{ pdet.data.project_no }}
          <span class="tag" :class="stageTag(pdet.data.stage)" style="margin-left: 8px">{{ pdet.data.stage_label }}</span>
          <span class="tag" :class="pdet.data.source === 'repeat' ? 'blue' : 'gray'" style="margin-left: 6px">{{ pdet.data.source_label }}</span>
        </h3>
        <div v-if="pdet.data.counts_as_dev === 0" class="hint-inline" style="margin-top: 4px">
          这是<b>返单复用</b>：技术核准只是核对原版仍适用，<b>不计入开发款数</b>（否则每月开发款数会被返单撑大）。
        </div>
        <div class="kv">
          <div><span>款号</span><b>{{ pdet.data.style_no }}</b><small>{{ pdet.data.style_name || '—' }}</small></div>
          <div><span>技术负责人</span><b>{{ pdet.data.owner || '—' }}</b><small>{{ pdet.data.pattern_maker || '未派版师' }}</small></div>
          <div><span>计划量</span><b>{{ num(pdet.data.plan_vs_actual.target_qty) }}</b><small>仅计划</small></div>
          <div><span>已下单（里程碑）</span><b>{{ num(pdet.data.ordered_qty) }}</b><small>实际登记</small></div>
          <div><span>已上架</span><b>{{ num(pdet.data.launched_qty) }}</b><small>首次美仓</small></div>
          <div><span>版型</span><b>{{ pdet.data.pattern_no || '—' }}</b><small>{{ pdet.data.pattern_reusable ? '已确认可复用' : '未标可复用' }}</small></div>
          <div><span>样衣</span><b>{{ pdet.data.sample_no || '—' }}</b><small>核准前必须有</small></div>
        </div>

        <div class="sec">里程碑（时间线，一项一次）</div>
        <div class="ms-line">
          <div v-for="(m, i) in pdet.data.milestones || []" :key="m.id" class="ms-item">
            <div class="ms-node" :class="m.counted ? 'counted' : ''">{{ i + 1 }}</div>
            <div class="ms-body">
              <b>{{ m.label }}</b>
              <span v-if="m.counted" class="tag green" style="margin-left: 6px">计入开发款数</span>
              <div class="tiny muted">
                {{ m.occurred_on }}
                <span v-if="m.qty"> · {{ num(m.qty) }} 件</span>
                <span v-if="m.ref_no"> · {{ m.ref_no }}</span>
              </div>
              <div v-if="m.note" class="tiny">{{ m.note }}</div>
            </div>
          </div>
          <div v-if="!(pdet.data.milestones || []).length" class="tiny muted">还没有登记任何里程碑</div>
        </div>

        <div v-if="pdet.data.next_milestone" class="ms-form">
          <b>下一步：{{ pdet.data.next_milestone.label }}</b>
          <div class="ms-form-row">
            <label class="fl">发生日期<input v-model="ms.occurred_on" type="date" /></label>
            <label class="fl">件数{{ needsQty(pdet.data.next_milestone.k) ? ' *' : '' }}<input v-model.number="ms.qty" type="number" min="0" /></label>
            <label class="fl">单据号<input v-model="ms.ref_no" placeholder="订单号 / 工单号" /></label>
            <label class="fl" style="flex: 1">备注<input v-model="ms.note" /></label>
            <button v-if="canMs" class="btn btn-primary" @click="submitMilestone">登记</button>
          </div>
          <div class="tiny muted" style="margin-top: 4px">
            前一个事件没发生，后一个不许登记；技术核准前必须有样衣编号；「{{ pdet.data.next_milestone.label }}」只能登记一次的条件见字典。
          </div>
        </div>

        <div class="sec">研发任务（与大货订单分类型，不进订单）</div>
        <div class="table-wrap" style="max-height: 240px; overflow-y: auto">
          <table class="data" style="min-width: 820px">
            <thead><tr><th>类型</th><th>标题</th><th>负责人</th><th>截止</th><th>状态</th><th>产出 / 阻塞原因</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="t in pdet.data.tasks || []" :key="t.id">
                <td class="tiny">{{ t.kind_label }}</td>
                <td class="tiny">{{ t.title }}</td>
                <td class="tiny">{{ t.owner || '—' }}</td>
                <td class="tiny">{{ t.due_date || '—' }}</td>
                <td><span class="tag" :class="taskTag(t.status)">{{ taskLabel(t.status) }}</span></td>
                <td class="tiny wrap" style="min-width: 200px">
                  <span v-if="t.output" class="ok-line">{{ t.output }}</span>
                  <span v-else-if="t.blocked_reason" class="red">{{ t.blocked_reason }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td class="ops">
                  <button v-if="canWrite && t.status !== 'done'" class="btn btn-ghost btn-sm" @click="openTaskDone(t)">完成</button>
                  <button v-if="canWrite && t.status !== 'blocked'" class="btn btn-ghost btn-sm" @click="openTaskBlock(t)">阻塞</button>
                </td>
              </tr>
              <tr v-if="!(pdet.data.tasks || []).length"><td colspan="7" class="empty">还没有任务</td></tr>
            </tbody>
          </table>
        </div>
        <div class="task-add">
          <select v-model="nt.kind" class="inp" style="width: 110px">
            <option v-for="k in dict.task_kinds || []" :key="k.k" :value="k.k">{{ k.label }}</option>
          </select>
          <input v-model="nt.title" class="inp" placeholder="任务标题" style="width: 200px" />
          <input v-model="nt.owner" class="inp" placeholder="负责人" style="width: 120px" />
          <input v-model="nt.due_date" type="date" class="inp" style="width: 140px" />
          <button v-if="canWrite" class="btn btn-ghost" @click="submitTask">加任务</button>
        </div>

        <div class="sec">规则自检</div>
        <div class="checks">
          <div v-for="c in pdet.data.checks || []" :key="c.k" class="check" :class="c.ok ? 'ok' : 'bad'">
            <span class="ico">{{ c.ok ? '✓' : '✗' }}</span>{{ c.label }}
          </div>
        </div>

        <div class="modal-ops">
          <button class="btn btn-ghost" @click="pdet.open = false">关闭</button>
          <button v-if="canWrite && pdet.data.stage === 'draft'" class="btn btn-ghost" @click="advance('tech')">进入技术开发</button>
          <button v-if="canWrite && pdet.data.stage === 'tech'" class="btn btn-ghost" @click="advance('sample')">转入打样</button>
          <button v-if="canWrite && pdet.data.status === 'active'" class="btn btn-ghost" @click="closeProject">结案</button>
        </div>
      </div>
    </div>

    <!-- ============ 新建 SKU ============ -->
    <div v-if="snew.open" class="modal-mask" @click.self="snew.open = false">
      <div class="modal wide">
        <h3>新建 SKU</h3>
        <div class="fgrid">
          <label class="fl">SKU 编码 <span class="red">*</span><input v-model="snew.sku" placeholder="DV-K101-A-3T" /></label>
          <label class="fl">款号 <span class="red">*</span><input v-model="snew.style_no" /></label>
          <label class="fl">类型
            <select v-model="snew.kind" @change="snew.unit = snew.kind === 'set' ? '套' : '件'">
              <option value="single">单件</option><option value="set">套装</option>
            </select>
          </label>
          <label class="fl">花型<input v-model="snew.pattern" /></label>
          <label class="fl">颜色<input v-model="snew.color" /></label>
          <label class="fl">尺码<input v-model="snew.size" /></label>
          <label class="fl">条码<input v-model="snew.barcode" /></label>
          <label class="fl">基本单位<input v-model="snew.unit" disabled /></label>
        </div>
        <div class="hint-inline">
          <span v-if="snew.kind === 'single'">单件：同款 + 花型 + 颜色 + 尺码 + 客户范围 <b>只能有一个 SKU</b>。</span>
          <span v-else>套装：单位必须是「套」，建完要去「明细」里配组件，<b>没有组件的套装换算不出件数</b>。</span>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="snew.open = false">取消</button>
          <button class="btn btn-primary" @click="submitSku">保存</button>
        </div>
      </div>
    </div>

    <!-- ============ SKU 详情 ============ -->
    <div v-if="sdet.open && sdet.data" class="modal-mask" @click.self="sdet.open = false">
      <div class="modal xxwide">
        <h3>
          {{ sdet.data.sku }}
          <span class="tag" :class="sdet.data.kind === 'set' ? 'purple' : 'gray'" style="margin-left: 8px">{{ sdet.data.kind_label }}</span>
          <span class="tag" :class="sdet.data.status === 'active' ? 'green' : 'gray'" style="margin-left: 6px">{{ sdet.data.status === 'active' ? '生效' : '停用' }}</span>
        </h3>
        <div class="kv">
          <div><span>款号</span><b>{{ sdet.data.style_no }}</b><small>{{ sdet.data.style_name || '—' }}</small></div>
          <div><span>花型 / 颜色 / 尺码</span><b>{{ sdet.data.pattern || '—' }}</b><small>{{ sdet.data.color || '—' }} / {{ sdet.data.size || '—' }}</small></div>
          <div><span>基本单位</span><b>{{ sdet.data.unit }}</b><small>库存基本单位是件</small></div>
          <div><span>当前配码</span><b>{{ sdet.data.pack_spec ? sdet.data.pack_spec.pack_no : '—' }}</b><small>{{ sdet.data.pack_spec ? sdet.data.pack_spec.kind_label : '未挂' }}</small></div>
          <div><span>1 套/箱 = </span><b>{{ sdet.data.pack_spec ? num(sdet.data.pack_spec.total_qty) + ' 件' : '—' }}</b><small>由明细算出</small></div>
          <div><span>条码</span><b class="mono">{{ sdet.data.barcode || '—' }}</b><small>—</small></div>
          <div><span>客户专属</span><b>{{ sdet.data.customer_id ? '是' : '通用' }}</b><small>—</small></div>
        </div>

        <div class="sec">换算（库存单位是件，套必须能拆成件）</div>
        <div v-if="sdet.data.kind === 'set'" class="explode-box">
          <label class="fl" style="width: 120px">套数<input v-model.number="exp.qty" type="number" min="1" /></label>
          <button class="btn btn-ghost" @click="doExplode">换算</button>
          <div v-if="exp.result" class="explode-result">
            <b>{{ num(exp.result.qty) }} 套 = {{ num(exp.result.pieces) }} 件</b>
            <span class="tiny muted">（1 套 {{ num(exp.result.pieces_per_set) }} 件 · {{ exp.result.pack_no }} V{{ exp.result.version }}）</span>
            <div class="tiny" style="margin-top: 4px">
              <span v-for="c in exp.result.components" :key="c.sku_id" class="tag gray" style="margin-right: 6px">
                {{ c.sku }} × {{ num(c.qty_per_set) }} → {{ num(c.pieces) }} 件
              </span>
            </div>
          </div>
          <div v-else-if="!sdet.data.convertible" class="red tiny">这个套装没有生效的配码，换算不出件数——库存不能按套动</div>
        </div>
        <div v-else class="tiny muted">单件 SKU 按件计，无需换算。</div>

        <div class="sec">配码 / 箱规版本</div>
        <div class="table-wrap" style="max-height: 220px; overflow-y: auto">
          <table class="data" style="min-width: 780px">
            <thead><tr><th>编号</th><th>类型</th><th class="num">版本</th><th class="num">合计件数</th><th>明细</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="p in sdet.data.specs || []" :key="p.id">
                <td class="mono tiny">{{ p.pack_no }}</td>
                <td class="tiny">{{ p.kind_label }}</td>
                <td class="num tiny">V{{ p.version }}</td>
                <td class="num">{{ num(p.total_qty) }}</td>
                <td class="tiny wrap" style="min-width: 240px">
                  <span v-for="it in p.items" :key="it.id" class="tag gray" style="margin: 0 4px 3px 0">
                    {{ it.component ? it.component.sku : it.size }} × {{ num(it.qty) }}
                  </span>
                </td>
                <td><span class="tag" :class="p.status === 'active' ? 'green' : 'gray'">{{ specLabel(p.status) }}</span></td>
                <td class="ops">
                  <button v-if="canWrite && p.status !== 'active'" class="btn btn-ghost btn-sm" @click="activateSpec(p.id)">启用</button>
                </td>
              </tr>
              <tr v-if="!(sdet.data.specs || []).length"><td colspan="7" class="empty">还没有配码版本</td></tr>
            </tbody>
          </table>
        </div>

        <div class="sec">别名（停用不删，历史单据还要反查）</div>
        <div class="alias-line">
          <span v-for="a in sdet.data.aliases || []" :key="a.id" class="alias" :class="{ off: a.status !== 'active' }">
            {{ a.alias }}
            <small>{{ a.source === 'supplier' ? '供应商标法' : (a.source === 'system' ? '旧编码' : '客户叫法') }}{{ a.status === 'active' ? '' : ' · 已停用' }}</small>
            <small v-if="a.status !== 'active' && a.note" style="margin-left: 4px">（{{ a.note }}）</small>
            <button v-if="canWrite && a.status === 'active'" class="lnk" @click="disableAlias(a.id)">停用</button>
          </span>
          <span v-if="!(sdet.data.aliases || []).length" class="tiny muted">还没有别名</span>
        </div>
        <div class="task-add">
          <input v-model="al.alias" class="inp" placeholder="新别名" style="width: 180px" />
          <select v-model="al.source" class="inp" style="width: 140px">
            <option value="supplier">供应商叫法</option>
            <option value="customer">客户叫法</option>
            <option value="system">旧系统编码</option>
          </select>
          <button v-if="canWrite" class="btn btn-ghost" @click="submitAlias">加别名</button>
        </div>

        <div class="sec">新建配码版本</div>
        <div v-if="sdet.data.kind === 'set'">
          <div class="hint-inline">套装组件：选组件 SKU + 每套件数。<b>合计件数由明细算出，不手填</b>；组件不能是套装自己。</div>
          <div v-for="(it, i) in pk.items" :key="i" class="pitem">
            <select v-model="pk.items[i].component_sku_id" class="inp" style="width: 260px">
              <option value="">选组件 SKU</option>
              <option v-for="c in singleCandidates" :key="c.id" :value="c.id">{{ c.sku }} · {{ c.style_no }}</option>
            </select>
            <input v-model.number="pk.items[i].qty" type="number" min="1" class="inp" style="width: 90px" />
            <span class="tiny muted">件/套</span>
            <button class="lnk" @click="pk.items.splice(i, 1)">删除</button>
          </div>
          <button class="btn btn-ghost btn-sm" @click="pk.items.push({ component_sku_id: '', qty: 1 })">加一行</button>
        </div>
        <div v-else>
          <div class="hint-inline">箱规：一箱按尺码配比装。同尺码不能重复。</div>
          <div v-for="(it, i) in pk.items" :key="i" class="pitem">
            <input v-model="pk.items[i].size" class="inp" placeholder="尺码" style="width: 110px" />
            <input v-model.number="pk.items[i].qty" type="number" min="1" class="inp" style="width: 90px" />
            <span class="tiny muted">件/箱</span>
            <button class="lnk" @click="pk.items.splice(i, 1)">删除</button>
          </div>
          <button class="btn btn-ghost btn-sm" @click="pk.items.push({ size: '', qty: 1 })">加一行</button>
        </div>
        <div class="tiny muted" style="margin-top: 6px">
          本版合计：<b>{{ pkTotal }}</b> 件<span class="tiny muted">（只统计已选组件 / 已填尺码的行）</span> · 新版本默认草稿，启用后旧版自动作废（同时只有一版生效）
        </div>
        <button v-if="canWrite" class="btn btn-ghost" style="margin-top: 8px" @click="submitPack">保存为草稿</button>

        <div class="modal-ops">
          <button class="btn btn-ghost" @click="sdet.open = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- ============ 任务弹窗 ============ -->
    <div v-if="tsk.open" class="modal-mask" @click.self="tsk.open = false">
      <div class="modal">
        <h3>{{ tsk.mode === 'done' ? '完成任务' : '标记阻塞' }}</h3>
        <p class="tiny muted" style="margin-bottom: 8px">{{ tsk.title }}</p>
        <label v-if="tsk.mode === 'done'" class="fl">
          产出 <span class="red">*</span>
          <input v-model="tsk.output" placeholder="版型号 / 样衣号 / 工艺单号" />
          <span class="tiny muted">没写产出 = 没说做了啥，后面谁也不知道能不能打样</span>
        </label>
        <label v-else class="fl">
          阻塞原因 <span class="red">*</span>
          <input v-model="tsk.reason" placeholder="面料未到 / 客户未确认 / 工价未回" />
        </label>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="tsk.open = false">取消</button>
          <button class="btn btn-primary" @click="submitTaskStatus">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('board');
const dict = ref({});
const board = ref({ stat: {}, milestones: [], stage_stat: [], overdue: [], sku_stat: [] });
const rows = ref([]);
const skus = ref([]);

const canWrite = computed(() => can('devmaster.write'));
const canMs = computed(() => can('devmaster.milestone'));

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const stageTag = (s) => ({
  draft: 'gray', tech: 'blue', sample: 'orange', confirmed: 'purple',
  delivered: 'blue', ordered: 'green', launched: 'green', closed: 'gray'
}[s] || 'gray');
const specLabel = (s) => ({ draft: '草稿', active: '生效中', superseded: '已作废' }[s] || s);
const taskLabel = (s) => ({ todo: '待开始', doing: '进行中', done: '已完成', blocked: '阻塞', cancelled: '已取消' }[s] || s);
const taskTag = (s) => ({ todo: 'gray', doing: 'blue', done: 'green', blocked: 'red', cancelled: 'gray' }[s] || 'gray');

const msLabel = (k) => ({
  tech_approved: '技术核准', sales_accepted: '销售接收', order_placed: '正式下单',
  in_production: '实际投产', us_launched: '首次上架'
}[k] || k);
const msMeaning = (k) => ({
  tech_approved: '总部技术核准并定义「开发完成」——只有这一项计入开发款数',
  sales_accepted: '销售接收并确认本单款/花码/数量/版本/交付条件',
  order_placed: '正式下达订单（带件数与单据号，可多次）',
  in_production: '实际开工投产（可多次）',
  us_launched: '首次美仓上架（只记第一次，决定「上新款数」）'
}[k] || '');
const needsQty = (k) => ['order_placed', 'in_production', 'us_launched'].includes(k);

const maxStage = computed(() => Math.max(1, ...(board.value.stage_stat || []).map((x) => x.count)));
const barW = (n) => `${Math.round((n / maxStage.value) * 100)}%`;
const maxSku = computed(() => Math.max(1, ...(board.value.sku_stat || []).map((x) => x.count)));
const barW2 = (n) => `${Math.round((n / maxSku.value) * 100)}%`;

// ---------- 立项 ----------
const pf = reactive({ keyword: '', stage: '', source: '' });
const pnew = reactive({
  open: false, style_no: '', style_name: '', category: '', season: '', biz_type: 'spot',
  source: 'new', reuse_project_id: '', classify_approved_by: '', owner: '', sales_owner: '',
  pattern_maker: '', target_qty: 0, target_price: '', plan_launch_date: ''
});
const pdet = reactive({ open: false, data: null });
const ms = reactive({ occurred_on: '', qty: 0, ref_no: '', note: '' });
const nt = reactive({ kind: 'pattern', title: '', owner: '', due_date: '' });
const tsk = reactive({ open: false, mode: 'done', id: null, title: '', output: '', reason: '' });

const reusableProjects = computed(() =>
  rows.value.filter((r) => r.stage === 'launched' || r.milestones.includes('us_launched')));

// ---------- SKU ----------
const sf = reactive({ keyword: '', kind: '' });
const snew = reactive({ open: false, sku: '', style_no: '', kind: 'single', pattern: '', color: '', size: '', barcode: '', unit: '件' });
const sdet = reactive({ open: false, data: null });
const al = reactive({ alias: '', source: 'supplier' });
const pk = reactive({ items: [] });
const exp = reactive({ qty: 10, result: null });

const singleCandidates = computed(() => skus.value.filter((s) => s.kind === 'single' && s.status === 'active'));
const pkTotal = computed(() => pk.items
  .filter((x) => (sdet.data && sdet.data.kind === 'set' ? x.component_sku_id : x.size))
  .reduce((s, x) => s + num(x.qty), 0));

async function loadBoard() {
  board.value = await api.devBoard({});
}
async function loadProjects() {
  const r = await api.devProjects({ ...pf });
  rows.value = r.rows || [];
}
async function loadSkus() {
  const r = await api.devSkus({ ...sf });
  skus.value = r.rows || [];
}
async function reloadAll() {
  await Promise.all([loadBoard(), loadProjects(), loadSkus()]);
}

function switchTab(t) {
  tab.value = t;
  if (t === 'board') loadBoard();
  if (t === 'proj') loadProjects();
  if (t === 'sku') loadSkus();
}

function openNewProject() {
  Object.assign(pnew, {
    open: true, style_no: '', style_name: '', category: '', season: '', biz_type: 'spot',
    source: 'new', reuse_project_id: '', classify_approved_by: '', owner: '', sales_owner: '',
    pattern_maker: '', target_qty: 0, target_price: '', plan_launch_date: ''
  });
}

async function submitProject() {
  try {
    if (!pnew.style_no) return alert('款号必填');
    const body = { ...pnew };
    delete body.open;
    if (!body.reuse_project_id) delete body.reuse_project_id;
    if (!body.classify_approved_by) delete body.classify_approved_by;
    const r = await api.createDevProject(body);
    pnew.open = false;
    await loadProjects();
    await loadBoard();
    openProject(r.id);
  } catch (e) {
    alert(e.message);
  }
}

async function openProject(id) {
  pdet.data = await api.devProject(id);
  pdet.open = true;
  const next = pdet.data.next_milestone;
  Object.assign(ms, {
    occurred_on: dict.value.current_date || '',
    qty: needsQty(next ? next.k : '') ? 0 : 0,
    ref_no: '', note: ''
  });
  Object.assign(nt, { kind: 'pattern', title: '', owner: '', due_date: '' });
}

async function submitMilestone() {
  try {
    const next = pdet.data.next_milestone;
    if (!next) return alert('里程碑已全部登记');
    const body = { kind: next.k, occurred_on: ms.occurred_on, note: ms.note || undefined };
    if (ms.ref_no) body.ref_no = ms.ref_no;
    if (needsQty(next.k)) body.qty = num(ms.qty);
    const r = await api.addDevMilestone(pdet.data.id, body);
    pdet.data = r;
    await Promise.all([loadProjects(), loadBoard()]);
  } catch (e) {
    alert(e.message);
  }
}

async function advance(stage) {
  try {
    pdet.data = await api.advanceDevStage(pdet.data.id, { stage });
    await Promise.all([loadProjects(), loadBoard()]);
  } catch (e) {
    alert(e.message);
  }
}

async function closeProject() {
  const reason = prompt('结案原因（≥4 字）：完成上市 / 终止开发 / 取消');
  if (!reason) return;
  try {
    pdet.data = await api.closeDevProject(pdet.data.id, { reason });
    await Promise.all([loadProjects(), loadBoard()]);
  } catch (e) {
    alert(e.message);
  }
}

async function submitTask() {
  try {
    const r = await api.addDevTask(pdet.data.id, { ...nt });
    pdet.data = r.project;
  } catch (e) {
    alert(e.message);
  }
}

function openTaskDone(t) {
  Object.assign(tsk, { open: true, mode: 'done', id: t.id, title: `${t.kind_label} · ${t.title}`, output: '', reason: '' });
}
function openTaskBlock(t) {
  Object.assign(tsk, { open: true, mode: 'block', id: t.id, title: `${t.kind_label} · ${t.title}`, output: '', reason: '' });
}
async function submitTaskStatus() {
  try {
    const body = tsk.mode === 'done' ? { status: 'done', output: tsk.output } : { status: 'blocked', blocked_reason: tsk.reason };
    pdet.data = await api.setDevTaskStatus(tsk.id, body);
    tsk.open = false;
    await Promise.all([loadProjects(), loadBoard()]);
  } catch (e) {
    alert(e.message);
  }
}

// ---------- SKU ----------
function openNewSku() {
  Object.assign(snew, { open: true, sku: '', style_no: '', kind: 'single', pattern: '', color: '', size: '', barcode: '', unit: '件' });
}

async function submitSku() {
  try {
    if (!snew.sku || !snew.style_no) return alert('SKU 编码与款号必填');
    const body = { ...snew };
    delete body.open;
    const r = await api.createDevSku(body);
    snew.open = false;
    await Promise.all([loadSkus(), loadBoard()]);
    openSku(r.id);
  } catch (e) {
    alert(e.message);
  }
}

async function openSku(id) {
  sdet.data = await api.devSku(id);
  sdet.open = true;
  al.alias = '';
  al.source = 'supplier';
  pk.items = sdet.data.kind === 'set' ? [{ component_sku_id: '', qty: 1 }] : [{ size: '', qty: 1 }];
  exp.qty = 10;
  exp.result = null;
  if (!skus.value.length) await loadSkus();
}

async function doExplode() {
  try {
    exp.result = await api.explodeSku(sdet.data.id, num(exp.qty) || 1);
  } catch (e) {
    alert(e.message);
  }
}

async function submitAlias() {
  try {
    if (!al.alias) return alert('别名必填');
    sdet.data = await api.addSkuAlias(sdet.data.id, { alias: al.alias, source: al.source || 'supplier' });
    al.alias = '';
    await loadSkus();
  } catch (e) {
    alert(e.message);
  }
}

async function disableAlias(id) {
  const note = prompt('停用原因（新老系统切换 / 供应商改名 / 录入错误）：');
  if (!note) return;
  try {
    sdet.data = await api.disableSkuAlias(id, { note });
    await loadSkus();
  } catch (e) {
    alert(e.message);
  }
}

async function submitPack() {
  try {
    const items = pk.items
      .filter((x) => (sdet.data.kind === 'set' ? x.component_sku_id : x.size))
      .map((x) => (sdet.data.kind === 'set'
        ? { component_sku_id: Number(x.component_sku_id), qty: num(x.qty) }
        : { size: x.size, qty: num(x.qty) }));
    if (!items.length) return alert('配码明细不能为空');
    await api.createDevPack({ sku_id: sdet.data.id, kind: sdet.data.kind === 'set' ? 'set' : 'carton', items });
    await openSku(sdet.data.id);
    await Promise.all([loadSkus(), loadBoard()]);
  } catch (e) {
    alert(e.message);
  }
}

async function activateSpec(id) {
  try {
    await api.activateDevPack(id);
    await openSku(sdet.data.id);
    await loadSkus();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  dict.value = await api.devDict();
  await reloadAll();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }

.help-bar { background: #f6f9fe; border: 1px solid #e2ebf8; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #4a5568; line-height: 1.8; margin-bottom: 12px; }
.hint-inline { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; line-height: 1.7; margin: 8px 0; }

.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.sec { font-size: 13px; color: #16305f; margin: 18px 0 8px; font-weight: 700; }
.kv { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
.kv > div { background: #f8fafd; border-radius: 8px; padding: 7px 9px; }
.kv span { display: block; font-size: 11px; color: #8a94a6; }
.kv b { font-size: 13px; color: #16305f; }
.kv small { display: block; font-size: 10.5px; color: #9aa4b5; }

.bar-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
.bar-label { width: 84px; color: #5b6474; flex: none; }
.bar-track { flex: 1; height: 8px; background: #eef2f8; border-radius: 6px; overflow: hidden; }
.bar-fill { height: 100%; background: #2f6fed; border-radius: 6px; }
.bar-fill.b2 { background: #7c5cff; }
.bar-num { width: 92px; text-align: right; color: #16305f; font-weight: 700; flex: none; }

.ms-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #dfe5ef; margin-right: 2px; }
.ms-dot.tech_approved { background: #7c5cff; }
.ms-dot.sales_accepted { background: #2f6fed; }
.ms-dot.order_placed { background: #0ea5e9; }
.ms-dot.in_production { background: #16a34a; }
.ms-dot.us_launched { background: #d97706; }

.ms-line { border-left: 2px solid #e6ebf3; padding-left: 12px; margin: 6px 0 4px; }
.ms-item { display: flex; gap: 8px; margin-bottom: 10px; }
.ms-node { width: 20px; height: 20px; border-radius: 50%; background: #eef2f8; color: #5b6474; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.ms-node.counted { background: #7c5cff; color: #fff; }
.ms-body b { font-size: 12.5px; color: #16305f; }

.ms-form { background: #f8fafd; border-radius: 10px; padding: 10px 12px; margin: 6px 0 4px; }
.ms-form-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 6px; }
.fl { display: block; font-size: 12px; color: #5b6474; }
.fl input, .fl select { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }

.checks { display: flex; flex-wrap: wrap; gap: 8px; }
.check { font-size: 12px; padding: 5px 10px; border-radius: 8px; background: #f4f8f4; color: #166534; border: 1px solid #d6ebd9; }
.check.bad { background: #fff6f7; color: #b42318; border-color: #f6c6cd; }
.check .ico { font-weight: 800; margin-right: 5px; }

.task-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.explode-box { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; background: #f8fafd; border-radius: 10px; padding: 10px 12px; }
.explode-result { font-size: 12.5px; color: #16305f; }
.alias-line { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
.alias { background: #f8fafd; border: 1px solid #e6ebf3; border-radius: 8px; padding: 5px 9px; font-size: 12px; color: #16305f; }
.alias small { color: #8a94a6; margin-left: 6px; font-size: 10.5px; }
.alias.off { opacity: 0.55; text-decoration: line-through; }
.lnk { background: none; border: none; color: #2f6fed; font-size: 11.5px; cursor: pointer; padding: 0 2px; margin-left: 6px; }
.pitem { display: flex; gap: 8px; align-items: center; margin: 6px 0; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-warn { background: #fffdf6; }
.row-muted { opacity: 0.6; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }
.modal { padding: 18px 20px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .two-col { grid-template-columns: 1fr; }
  .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .page-head .pill { display: none; }
}
</style>
