<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>有限产能排程</h2>
        <p class="sub">
          把「订单 × 工序」排到<b>工作中心 × 日期 × 工时</b>上，<b>不许超卖产能</b>。
          没有班次日历的天按 0 小时算（不默认 8 小时）；设备停机先扣再排；没有单件定额的工序<b>不排</b>（0 工时等于无限产能）；
          缺料未到不许排产；窗口装不下、交期排不到，都<b>照实报</b>，不静默丢单。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ meta.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openBuild">生成排程</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>当前生效批次</span>
        <strong class="mono">{{ current && current.run_no ? current.run_no.slice(-4) : '—' }}</strong>
        <small>{{ current ? current.run_no : '还没有发布过排程' }}</small>
      </div>
      <div class="stat">
        <span>产能利用率</span>
        <strong>{{ current ? num(current.util_rate) : 0 }}<i>%</i></strong>
        <small>全窗口 工作中心 × 天</small>
      </div>
      <div class="stat" :class="current && current.late_count ? 'st-warn' : ''">
        <span>交期排不到</span>
        <strong>{{ (current && current.late_count) || 0 }}</strong>
        <small>单（已给出超期天数）</small>
      </div>
      <div class="stat">
        <span>满负荷天数</span>
        <strong>{{ (current && current.full_days) || 0 }}</strong>
        <small>利用率 ≥100% 的工作中心·天</small>
      </div>
      <div class="stat" :class="openBlocks ? 'st-bad' : ''">
        <span>硬冲突待处理</span>
        <strong>{{ openBlocks }}</strong>
        <small>不处理不能发布</small>
      </div>
      <div class="stat">
        <span>未排订单</span>
        <strong>{{ unscheduled.length }}</strong>
        <small>缺料 / 装不下 / 无定额</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'board' }" @click="go('board')">排程看板</button>
        <button :class="{ on: tab === 'runs' }" @click="go('runs')">排程批次</button>
        <button :class="{ on: tab === 'std' }" @click="go('std')">工序定额</button>
        <button :class="{ on: tab === 'cal' }" @click="go('cal')">班次日历</button>
      </div>
    </div>

    <!-- ==================== 一、排程看板 ==================== -->
    <div v-if="tab === 'board'" class="block">
      <div class="hint-bar">
        每一格是一个<b>工作中心的一天</b>：格子里的柱高 = 当天已排工时 ÷ 可用工时，颜色区分订单。
        <b>灰色</b>=休息/停产（0 小时），<b>斜纹</b>=当天有设备停机被扣掉的产能，<b>红点</b>=该格有超交期的工序。
        同一批次里「分 2 段」表示这批中途被插单打断过（产能先到先占，不是排错了）。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="boardRunId" @change="loadBoard">
          <option value="">当前生效批次</option>
          <option v-for="r in runs" :key="r.id" :value="r.id">{{ r.run_no }}（{{ runTag(r.status) }}）</option>
        </select>
        <div class="spacer"></div>
        <span class="muted tiny" v-if="board.run">窗口 {{ board.run.horizon_from }} ~ {{ board.run.horizon_to }}</span>
        <button class="btn btn-ghost btn-sm" @click="showLateOnly = !showLateOnly">{{ showLateOnly ? '显示全部' : '只看超期' }}</button>
      </div>

      <div v-if="!board.run" class="empty-box">还没有排程批次。点右上角「生成排程」按交期正排，或先到「班次日历」把未来三周班次配好。</div>

      <template v-else>
        <!-- 甘特 / 负荷矩阵 -->
        <div class="gantt-wrap">
          <div class="gantt" :style="gridStyle">
            <div class="g-cell g-head g-corner">工作中心</div>
            <div v-for="d in board.dates" :key="'h' + d" class="g-cell g-head" :class="{ rest: isRest(d) }">
              <div class="dow">{{ dow(d) }}</div>
              <div class="dnum">{{ d.slice(5) }}</div>
            </div>

            <template v-for="l in visibleLanes" :key="l.work_center">
              <div class="g-cell g-label">
                <div class="wc">{{ l.work_center }}</div>
                <div class="tiny muted">{{ num(l.used_hours) }} / {{ num(l.base_hours) }}h · {{ num(l.util_rate) }}%</div>
              </div>
              <div
                v-for="d in board.dates"
                :key="l.work_center + d"
                class="g-cell g-day"
                :class="{ rest: isRest(d), down: cellOf(l.work_center, d).down > 0, late: cellOf(l.work_center, d).late }"
                :title="tip(l.work_center, d)"
              >
                <div v-if="cellOf(l.work_center, d).down > 0" class="down-mark"></div>
                <div v-if="cellOf(l.work_center, d).items.length" class="bar">
                  <i
                    v-for="(it, i) in cellOf(l.work_center, d).items"
                    :key="i"
                    :style="{ flexGrow: it.hours, height: barH(l.work_center, d, it), background: colorOf(it.order_no) }"
                  ></i>
                </div>
                <span v-if="cellOf(l.work_center, d).late" class="dot"></span>
              </div>
            </template>
          </div>
        </div>

        <div class="legend">
          <span v-for="(c, no) in orderColors" :key="no"><i :style="{ background: c }"></i>{{ no }}</span>
        </div>

        <!-- 冲突 -->
        <h3 class="sec-title">冲突与风险 <span class="muted tiny">共 {{ conflicts.length }} 条，硬冲突 {{ openBlocks }} 条待处理</span></h3>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>级别</th><th>类型</th><th>订单</th><th>工序</th><th>工作中心</th><th class="num">指标</th><th>说明</th><th>处理</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in conflicts" :key="c.id" :class="{ 'row-bad': c.level === 'block' && !c.resolved }">
                <td><span class="tag" :class="c.level === 'block' ? 'red' : 'orange'">{{ c.level === 'block' ? '硬' : '软' }}</span></td>
                <td class="tiny">{{ c.type_label }}</td>
                <td class="mono tiny">{{ c.order_no || '—' }}</td>
                <td class="tiny">{{ c.process_name || '—' }}</td>
                <td class="tiny">{{ c.work_center || '—' }}</td>
                <td class="num tiny" style="min-width:52px">{{ c.metric ? num(c.metric) : '—' }}</td>
                <td class="tiny wrap" style="min-width: 260px">
                  {{ c.detail }}
                  <div v-if="c.suggestion" class="muted">建议：{{ c.suggestion }}</div>
                  <div v-if="c.resolved" class="ok-line">已处理：{{ c.resolved_note }}（{{ c.resolved_by }}）</div>
                </td>
                <td>
                  <button v-if="!c.resolved && canWrite" class="btn btn-ghost btn-sm" @click="openResolve(c)">{{ c.level === 'block' ? '处理' : '知悉' }}</button>
                  <span v-else-if="c.resolved" class="tag green">已处理</span>
                  <span v-else class="muted tiny">—</span>
                </td>
              </tr>
              <tr v-if="!conflicts.length"><td colspan="8" class="empty-cell">没有冲突，这批排得很干净</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 任务 -->
        <h3 class="sec-title">排程任务 <span class="muted tiny">{{ board.tasks.length }} 条{{ board.run.status === 'published' ? '（已发布，只读）' : '' }}</span></h3>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>订单</th><th>工序</th><th>工作中心</th><th class="num">件数</th><th class="num">工时</th>
                <th>开工</th><th>完工</th><th>交期</th><th class="num">分段</th><th>状态</th><th v-if="canWrite"></th></tr>
            </thead>
            <tbody>
              <tr v-for="t in shownTasks" :key="t.id" :class="{ 'row-warn': !t.finish_by_due }">
                <td class="mono tiny">{{ t.order_no }}<div class="muted">{{ t.style_no || '' }}</div></td>
                <td class="tiny">{{ t.process_name }}</td>
                <td class="tiny">{{ t.work_center }}</td>
                <td class="num tiny">{{ num(t.qty) }}</td>
                <td class="num tiny">{{ num(t.est_hours) }}<span v-if="t.setup_hours" class="muted"> +换款{{ num(t.setup_hours) }}</span></td>
                <td class="tiny">{{ t.start_at }}</td>
                <td class="tiny">{{ t.end_at }}</td>
                <td class="tiny" :class="{ red: !t.finish_by_due }">{{ t.due_date || '—' }}</td>
                <td class="num tiny">{{ t.segments > 1 ? t.segments + ' 段' : '1 段' }}</td>
                <td>
                  <span v-if="t.locked" class="tag purple">锁定</span>
                  <span v-else class="tag" :class="t.finish_by_due ? 'green' : 'red'">{{ t.finish_by_due ? '按期' : '超期' }}</span>
                </td>
                <td v-if="canWrite">
                  <button v-if="board.run.status !== 'published'" class="btn btn-ghost btn-sm" @click="openAdjust(t)">调整</button>
                  <span v-else class="muted tiny">—</span>
                </td>
              </tr>
              <tr v-if="!shownTasks.length"><td :colspan="canWrite ? 11 : 10" class="empty-cell">没有任务</td></tr>
            </tbody>
          </table>
        </div>

        <div v-if="changes.length" class="hint-bar" style="margin-top: 12px">
          <b>人工调整留痕（{{ changes.length }} 条）</b>
          <div v-for="c in changes.slice(0, 6)" :key="c.id" class="tiny" style="margin-top: 4px">
            · {{ c.created_at.slice(5, 16) }} {{ c.order_no }} {{ c.process_name }}：{{ c.field }} {{ c.old_value || '空' }} → {{ c.new_value || '空' }}；原因：{{ c.reason }}（{{ c.operator }}）
          </div>
        </div>
      </template>
    </div>

    <!-- ==================== 二、排程批次 ==================== -->
    <div v-if="tab === 'runs'" class="block">
      <div class="hint-bar">
        每次生成都是一个<b>新版本</b>：已发布的批次只读，改计划必须重排而不是原地改历史。
        人工锁定的任务在下一次重排时<b>原样保留并预占产能</b>（只能从当前生效批次继承）。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>批次</th><th>版本</th><th>窗口</th><th class="num">订单</th><th class="num">任务</th>
              <th class="num">冲突</th><th class="num">超期</th><th class="num">利用率</th><th>状态</th><th>创建</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id" :class="{ 'row-warn': r.is_current }">
              <td>
                <a class="lnk mono" @click="openRun(r.id)">{{ r.run_no }}</a>
                <div v-if="r.is_current" class="tiny ok-line">当前生效</div>
                <div v-else-if="r.note" class="tiny muted">{{ r.note }}</div>
              </td>
              <td class="tiny">V{{ r.version }}</td>
              <td class="tiny">{{ r.horizon_from }} ~ {{ r.horizon_to }}</td>
              <td class="num tiny">{{ r.order_count }}</td>
              <td class="num tiny">{{ r.task_count }}</td>
              <td class="num tiny">
                <span :class="{ red: r.block_count }">{{ r.conflict_count }}</span>
                <span v-if="r.block_count" class="muted"> / 硬 {{ r.block_count }}</span>
              </td>
              <td class="num tiny" :class="{ red: r.late_count }">{{ r.late_count }}</td>
              <td class="num tiny">{{ num(r.util_rate) }}%</td>
              <td><span class="tag" :class="tagOfStatus(r.status)">{{ statusLabel(r.status) }}</span></td>
              <td class="tiny muted">{{ String(r.created_at).slice(0, 16).replace('T', ' ') }}</td>
              <td class="ops">
                <button v-if="canPublish && r.status === 'draft'" class="btn btn-primary btn-sm" @click="doPublish(r)">发布</button>
                <button v-if="canPublish && !r.is_current && r.status !== 'archived'" class="btn btn-ghost btn-sm" @click="doArchive(r)">归档</button>
                <button v-if="!r.is_current" class="btn btn-ghost btn-sm" @click="openRun(r.id)">查看</button>
              </td>
            </tr>
            <tr v-if="!runs.length"><td colspan="11" class="empty-cell">还没有批次</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、工序定额 ==================== -->
    <div v-if="tab === 'std'" class="block">
      <div class="hint-bar">
        这是排程的<b>唯一工时口径</b>：单件标准工时（分钟/件）+ 换款调试（分钟/次）+ 效率系数。
        标红的行<b>不能参与排程</b>——没有定额的工序一律不排，不会按 0 工时糊过去。
        「备料 / 排版算料 / 成品入库 / 出库发运」属于计划与仓储动作，<b>不占工作中心产能</b>，不需要定额。
      </div>
      <div class="toolbar" style="margin-bottom: 10px">
        <div class="spacer"></div>
        <span class="muted tiny">共 {{ standards.length }} 条，未配置 {{ unconfigured.length }} 条</span>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openStd()">＋ 新增工序定额</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>工序</th><th>承做工作中心</th><th class="num">单件工时(分)</th><th class="num">理论产量(件/时)</th>
              <th class="num">换款(分)</th><th class="num">效率</th><th>设备数</th><th>备注</th><th v-if="canWrite"></th></tr>
          </thead>
          <tbody>
            <tr v-for="s in standards" :key="s.id" :class="{ 'row-bad': !s.configured }">
              <td><b>{{ s.process_name }}</b></td>
              <td class="tiny">{{ s.work_center || '未配置' }}</td>
              <td class="num tiny">{{ num(s.std_minutes) }}</td>
              <td class="num tiny">{{ s.pieces_per_hour ? num(s.pieces_per_hour) : '—' }}</td>
              <td class="num tiny">{{ num(s.setup_minutes) }}</td>
              <td class="num tiny">{{ num(s.efficiency) }}%</td>
              <td class="tiny">{{ eqCount(s.work_center) }} 台</td>
              <td class="tiny muted">{{ s.remark || '—' }}</td>
              <td v-if="canWrite"><button class="btn btn-ghost btn-sm" @click="openStd(s)">编辑</button></td>
            </tr>
            <tr v-if="!standards.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">还没有定额，先点右上角新增</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 四、班次日历 ==================== -->
    <div v-if="tab === 'cal'" class="block">
      <div class="hint-bar">
        <b>缺行 = 当天不可用</b>，系统不会替你假设 8 小时——所以生成排程前必须把窗口内的每一天显式写进来。
        批量填充会把<b>写库的每一天</b>都记下来（周末默认 0 小时），而不是「临时按 8 小时算」。
      </div>

      <div class="split">
        <div class="panel narrow">
          <h4>批量填充</h4>
          <div class="fgrid">
            <label class="full"><span>工作中心</span>
              <select v-model="calForm.work_center">
                <option value="">全部工作中心（{{ meta.work_centers ? meta.work_centers.length : 0 }} 个）</option>
                <option v-for="w in meta.work_centers || []" :key="w.work_center" :value="w.work_center">{{ w.work_center }}</option>
              </select>
            </label>
            <label><span>从</span><input v-model="calForm.from" type="date" /></label>
            <label><span>到</span><input v-model="calForm.to" type="date" /></label>
            <label><span>每天基准工时</span><input v-model.number="calForm.base_hours" type="number" step="0.5" min="0" max="24" /></label>
            <label><span>班次开始</span><input v-model.number="calForm.start_hour" type="number" step="1" min="0" max="23" /></label>
            <label class="full" style="flex-direction: row; align-items: center; gap: 8px">
              <input v-model="calForm.weekdays_only" type="checkbox" style="width: auto" />
              <span>周末自动设为 0 小时（推荐）</span>
            </label>
          </div>
          <button v-if="canWrite" class="btn btn-primary" style="margin-top: 10px" @click="doFill">写入班次日历</button>
          <div v-if="missing.length" class="warn-box">
            还有 <b>{{ missing.length }}</b> 个「工作中心 × 天」没配：{{ missing.slice(0, 6).map((m) => m.work_center + ' ' + m.date).join('、') }}{{ missing.length > 6 ? ' …' : '' }}
          </div>
          <div v-else class="ok-box">窗口内班次日历已配全</div>
        </div>

        <div class="panel grow">
          <h4>
            日历明细
            <span class="muted tiny">{{ calFilter.work_center || '全部' }} · {{ calData.from }} ~ {{ calData.to }}</span>
          </h4>
          <div class="toolbar" style="margin-bottom: 8px">
            <select v-model="calFilter.work_center" @change="loadCal" style="max-width: 160px">
              <option value="">全部工作中心</option>
              <option v-for="w in meta.work_centers || []" :key="w.work_center" :value="w.work_center">{{ w.work_center }}</option>
            </select>
            <input v-model="calFilter.from" type="date" @change="loadCal" />
            <input v-model="calFilter.to" type="date" @change="loadCal" />
          </div>
          <div class="table-wrap" style="max-height: 420px; overflow: auto">
            <table class="data">
              <thead><tr><th>日期</th><th>星期</th><th>工作中心</th><th class="num">基准工时</th><th class="num">班次开始</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="r in calRows" :key="r.id" :class="{ 'row-warn': !r.base_hours }">
                  <td class="mono tiny">{{ r.cal_date }}</td>
                  <td class="tiny">{{ dow(r.cal_date) }}</td>
                  <td class="tiny">{{ r.work_center }}</td>
                  <td class="num tiny">
                    <input
                      v-if="canWrite" class="mini-inp" type="number" step="0.5" min="0" max="24"
                      :value="r.base_hours" @change="saveCal(r, $event.target.value)"
                    />
                    <span v-else>{{ num(r.base_hours) }}</span>
                  </td>
                  <td class="num tiny">{{ num(r.start_hour) }}</td>
                  <td class="tiny muted">{{ r.note || '—' }}</td>
                </tr>
                <tr v-if="!calRows.length"><td colspan="6" class="empty-cell">这个区间还没有日历</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 生成排程弹窗 ==================== -->
    <div v-if="build.open" class="modal-mask" @click.self="build.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>生成排程</h3>
          <button class="x" @click="build.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fgrid">
            <label><span>窗口开始</span><input v-model="build.from" type="date" /></label>
            <label><span>窗口结束</span><input v-model="build.to" type="date" /></label>
            <label><span>排序算法</span>
              <select v-model="build.algo">
                <option value="edd">交期优先（EDD，先到期的先排）</option>
              </select>
            </label>
            <label><span>纳入订单</span>
              <select v-model="build.scope">
                <option value="orders">只排下面勾选的订单</option>
                <option value="all">排全部在产订单</option>
              </select>
            </label>
            <label class="full" style="flex-direction: row; gap: 18px; align-items: center">
              <label style="flex-direction: row; gap: 6px; align-items: center">
                <input v-model="build.carry_locked" type="checkbox" style="width: auto" /> 沿用上一版锁定任务（占产能不重排）
              </label>
              <label style="flex-direction: row; gap: 6px; align-items: center">
                <input v-model="build.material_gate" type="checkbox" style="width: auto" /> 缺料不许开工（按到货日推后）
              </label>
            </label>
          </div>

          <div v-if="build.scope === 'orders'" style="margin-top: 12px">
            <div class="toolbar" style="margin-bottom: 6px">
              <span class="tiny muted">可排订单 {{ poolShown.length }} 张，已选 {{ build.order_ids.length }} 张</span>
              <label class="tiny muted" style="display:flex;gap:5px;align-items:center"><input v-model="build.show_zero" type="checkbox" style="width:auto" />含 0 件订单</label>
              <div class="spacer"></div>
              <button class="btn btn-ghost btn-sm" @click="pickAll(true)">全选</button>
              <button class="btn btn-ghost btn-sm" @click="pickAll(false)">清空</button>
            </div>
            <div class="table-wrap" style="max-height: 240px; overflow: auto">
              <table class="data">
                <thead><tr><th></th><th>订单</th><th>款</th><th class="num">件数</th><th>交期</th><th>评审</th><th>缺料</th><th class="num">工序</th></tr></thead>
                <tbody>
                  <tr v-for="o in poolShown" :key="o.id" :class="{ 'row-warn': !o.qty }">
                    <td><input v-model="build.order_ids" type="checkbox" :value="o.id" style="width: auto" /></td>
                    <td class="mono tiny">{{ o.order_no }}</td>
                    <td class="tiny">{{ o.style_name || '—' }}</td>
                    <td class="num tiny">{{ num(o.qty) }}</td>
                    <td class="tiny">{{ o.due || '无' }}</td>
                    <td><span class="tag" :class="o.review === 'approved' ? 'green' : 'orange'">{{ o.review === 'approved' ? '已过' : (o.review || '未评') }}</span></td>
                    <td class="tiny">
                      <span v-if="o.shortage_count" class="red">缺 {{ o.shortage_count }} 项{{ o.shortage_no_eta ? '（无到货日）' : '' }}</span>
                      <span v-else class="muted">齐套</span>
                    </td>
                    <td class="num tiny">{{ o.process_count }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="build.preview" class="preview">
            <div class="pv-row">
              <span>预演结果</span>
              <b>任务 {{ build.preview.stats.task_count }} 条</b>
              <b>利用率 {{ num(build.preview.stats.util_rate) }}%</b>
              <b :class="{ red: build.preview.stats.late_count }">超期 {{ build.preview.stats.late_count }} 单</b>
              <b :class="{ red: build.preview.stats.block_count }">硬冲突 {{ build.preview.stats.block_count }} 条</b>
            </div>
            <div v-if="build.preview.missing && Object.keys(build.preview.missing).length" class="warn-box">
              班次日历没配全：{{ Object.keys(build.preview.missing).map((w) => w + ' ' + build.preview.missing[w].length + ' 天').join('、') }}
            </div>
            <div v-for="c in build.preview.conflicts.slice(0, 8)" :key="c.type + c.detail" class="pv-conf" :class="c.level">
              <span class="tag" :class="c.level === 'block' ? 'red' : 'orange'">{{ c.level === 'block' ? '硬' : '软' }}</span>
              {{ c.detail }}
            </div>
            <div v-if="build.preview.conflicts.length > 8" class="tiny muted">… 还有 {{ build.preview.conflicts.length - 8 }} 条</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="build.open = false">取消</button>
          <button class="btn btn-ghost" :disabled="build.loading" @click="doPreview">先预演</button>
          <button class="btn btn-primary" :disabled="build.loading" @click="doCreate">生成批次</button>
        </div>
      </div>
    </div>

    <!-- ==================== 处理冲突弹窗 ==================== -->
    <div v-if="resolve.open" class="modal-mask" @click.self="resolve.open = false">
      <div class="modal">
        <div class="modal-head">
          <h3>处理硬冲突</h3>
          <button class="x" @click="resolve.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="hint-bar">{{ resolve.row && resolve.row.detail }}</div>
          <div class="fgrid" style="margin-top: 10px">
            <label class="full"><span>处理意见（必填，写清怎么处理的）</span>
              <textarea v-model="resolve.note" rows="3" placeholder="例如：已决定这批拆 1500 件到外协，剩余本厂排，交期跟客户确认顺延一周"></textarea>
            </label>
          </div>
          <div class="tiny muted" style="margin-top: 8px">处理完才能发布。系统只留痕，<b>不会自动改订单交期或改库存</b>。</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="resolve.open = false">取消</button>
          <button class="btn btn-primary" @click="doResolve">确认处理</button>
        </div>
      </div>
    </div>

    <!-- ==================== 调整任务弹窗 ==================== -->
    <div v-if="adjust.open" class="modal-mask" @click.self="adjust.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>调整排程任务</h3>
          <button class="x" @click="adjust.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="hint-bar">
            {{ adjust.row && adjust.row.order_no }} · {{ adjust.row && adjust.row.process_name }} ·
            原：{{ adjust.row && adjust.row.start_at }} → {{ adjust.row && adjust.row.end_at }}（{{ adjust.row && num(adjust.row.est_hours) }}h，{{ adjust.row && adjust.row.work_center }}）
          </div>
          <div class="fgrid" style="margin-top: 10px">
            <label><span>开工（YYYY-MM-DD HH:mm）</span><input v-model="adjust.start_at" placeholder="2026-11-02 08:00" /></label>
            <label><span>完工（YYYY-MM-DD HH:mm）</span><input v-model="adjust.end_at" placeholder="2026-11-03 16:00" /></label>
            <label><span>工作中心</span>
              <select v-model="adjust.work_center">
                <option v-for="w in meta.work_centers || []" :key="w.work_center" :value="w.work_center">{{ w.work_center }}</option>
              </select>
            </label>
            <label><span>工时（小时）</span><input v-model.number="adjust.est_hours" type="number" step="0.5" min="0.5" /></label>
            <label class="full" style="flex-direction: row; gap: 6px; align-items: center">
              <input v-model="adjust.locked" type="checkbox" style="width: auto" />
              <span>锁定这条任务（下次重排原样保留并预占产能）</span>
            </label>
            <label class="full"><span>原因（必填，会写进调整留痕）</span>
              <textarea v-model="adjust.reason" rows="2" placeholder="例如：等首件确认放行后再整烫，整体推后一天"></textarea>
            </label>
          </div>
          <div class="tiny muted" style="margin-top: 8px">已发布的批次不能改：要改请重新生成新版本。</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="adjust.open = false">取消</button>
          <button class="btn btn-primary" @click="doAdjust">保存调整</button>
        </div>
      </div>
    </div>

    <!-- ==================== 工序定额弹窗 ==================== -->
    <div v-if="std.open" class="modal-mask" @click.self="std.open = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ std.id ? '编辑工序定额' : '新增工序定额' }}</h3>
          <button class="x" @click="std.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fgrid">
            <label><span>工序名称</span><input v-model="std.process_name" :disabled="!!std.id" placeholder="如 车缝" /></label>
            <label><span>承做工作中心</span>
              <select v-model="std.work_center">
                <option v-for="w in meta.work_centers || []" :key="w.work_center" :value="w.work_center">{{ w.work_center }}</option>
              </select>
            </label>
            <label><span>单件标准工时（分钟/件）</span><input v-model.number="std.std_minutes" type="number" step="0.05" min="0.05" /></label>
            <label><span>换款调试（分钟/次）</span><input v-model.number="std.setup_minutes" type="number" step="1" min="0" /></label>
            <label><span>效率系数（%）</span><input v-model.number="std.efficiency" type="number" step="1" min="1" max="100" /></label>
            <label><span>起做批量</span><input v-model.number="std.batch_min_qty" type="number" step="10" min="0" /></label>
            <label class="full"><span>备注</span><input v-model="std.remark" /></label>
          </div>
          <div class="tiny muted" style="margin-top: 8px">
            理论产量 = 60 ÷ 单件工时（不含效率）；排程实际用 单件工时 ÷ 效率 折算。单件工时必须 &gt; 0，否则该工序不能参与排程。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="std.open = false">取消</button>
          <button class="btn btn-primary" @click="doSaveStd">保存</button>
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
const meta = ref({});
const runs = ref([]);
const current = ref(null);
const pool = ref([]);
const standards = ref([]);
const boardRunId = ref('');
const board = ref({});
const changes = ref([]);
const conflicts = ref([]);
const showLateOnly = ref(false);

const calData = ref({ from: '', to: '', rows: [], missing: [] });
const calFilter = reactive({ work_center: '', from: '', to: '' });
const calForm = reactive({ work_center: '', from: '', to: '', base_hours: 8, start_hour: 8, weekdays_only: true });

const build = reactive({ open: false, from: '', to: '', algo: 'edd', scope: 'orders', order_ids: [], show_zero: false, carry_locked: true, material_gate: true, loading: false, preview: null });
const resolve = reactive({ open: false, row: null, note: '' });
const adjust = reactive({ open: false, row: null, start_at: '', end_at: '', work_center: '', est_hours: 0, locked: false, reason: '' });
const std = reactive({ open: false, id: null, process_name: '', work_center: '', std_minutes: 1, setup_minutes: 0, efficiency: 85, batch_min_qty: 0, remark: '' });

const canWrite = computed(() => can('schedule.write'));
const canPublish = computed(() => can('schedule.publish'));

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const statusLabel = (s) => ({ draft: '草稿', published: '已发布', archived: '已归档' }[s] || s);
const tagOfStatus = (s) => ({ draft: 'orange', published: 'green', archived: 'gray' }[s] || 'gray');
const runTag = (s) => statusLabel(s);

const openBlocks = computed(() => (board.value.conflicts || []).filter((c) => c.level === 'block' && !c.resolved).length);
const unscheduled = computed(() => {
  const ids = new Set((board.value.tasks || []).map((t) => t.order_no));
  return (board.value.conflicts || []).filter((c) => ['material_short', 'horizon_short', 'no_standard', 'no_qty'].includes(c.type) && !ids.has(c.order_no));
});
const unconfigured = computed(() => standards.value.filter((s) => !s.configured));
const poolShown = computed(() => (build.show_zero ? pool.value : pool.value.filter((o) => Number(o.qty) > 0)));

const PALETTE = ['#2b6de5', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#db2777', '#65a30d', '#475569', '#c2410c'];
const orderNoList = computed(() => {
  const list = [];
  (board.value.tasks || []).forEach((t) => { if (!list.includes(t.order_no)) list.push(t.order_no); });
  return list.sort();
});
const orderColors = computed(() => {
  const map = {};
  orderNoList.value.forEach((no, i) => { map[no] = PALETTE[i % PALETTE.length]; });
  return map;
});
const colorOf = (no) => orderColors.value[no] || '#94a3b8';

const gridStyle = computed(() => {
  const n = (board.value.dates || []).length || 1;
  return { gridTemplateColumns: `124px repeat(${n}, 42px)` };
});

const visibleLanes = computed(() => {
  const lanes = board.value.lanes || [];
  if (!showLateOnly.value) return lanes;
  return lanes.filter((l) => l.tasks.some((t) => !t.finish_by_due));
});

const shownTasks = computed(() => {
  const list = board.value.tasks || [];
  return showLateOnly.value ? list.filter((t) => !t.finish_by_due) : list;
});

// 需求：每格 = 工作中心 × 天，按订单堆叠
const cellIndex = computed(() => {
  const idx = {};
  (board.value.day_load || []).forEach((row) => {
    idx[`${row.work_center}|${row.date}`] = { base: row.base, avail: row.avail, down: row.down, used: row.used, items: [], late: false };
  });
  (board.value.tasks || []).forEach((t) => {
    Object.keys(t.day_load || {}).forEach((d) => {
      const h = Number(t.day_load[d]) || 0;
      if (h <= 0) return;
      const key = `${t.work_center}|${d}`;
      if (!idx[key]) idx[key] = { base: 0, avail: 0, down: 0, used: 0, items: [], late: false };
      idx[key].items.push({ order_no: t.order_no, process_name: t.process_name, hours: h, late: !t.finish_by_due });
      if (!t.finish_by_due) idx[key].late = true;
    });
  });
  Object.keys(idx).forEach((k) => { idx[k].items.sort((a, b) => b.hours - a.hours); });
  return idx;
});

const cellOf = (wc, d) => cellIndex.value[`${wc}|${d}`] || { base: 0, avail: 0, down: 0, used: 0, items: [], late: false };

const isRest = (d) => {
  const lanes = board.value.lanes || [];
  if (!lanes.length) return false;
  return lanes.every((l) => {
    const c = cellIndex.value[`${l.work_center}|${d}`];
    return !c || c.avail <= 0;
  });
};

const barH = (wc, d, it) => {
  const c = cellOf(wc, d);
  if (!c.avail) return '0%';
  return Math.min(100, (it.hours / c.avail) * 100) + '%';
};

const tip = (wc, d) => {
  const c = cellOf(wc, d);
  if (!c.avail && !c.used) return `${wc} ${d}：休息 / 停产（0 工时）`;
  const head = `${wc} ${d}：可用 ${num(c.avail)}h${c.down ? `（停机扣 ${num(c.down)}h）` : ''}，已排 ${num(c.used)}h，${c.avail ? num((c.used / c.avail) * 100) : 0}%`;
  const body = c.items.map((it) => `${it.order_no} ${it.process_name} ${num(it.hours)}h`).join('\n');
  return body ? `${head}\n${body}` : head;
};

const dow = (d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${d}T00:00:00`).getDay()];
const eqCount = (wc) => {
  const w = (meta.value.work_centers || []).find((x) => x.work_center === wc);
  return w ? w.eq_cnt : 0;
};

const calRows = computed(() => {
  const rows = calData.value.rows || [];
  return calFilter.work_center ? rows.filter((r) => r.work_center === calFilter.work_center) : rows;
});
const missing = computed(() => calData.value.missing || []);

function go(t) {
  tab.value = t;
  if (t === 'cal') loadCal();
  if (t === 'std') loadStandards();
  if (t === 'runs') loadRuns();
}

async function reloadAll() {
  await loadMeta();
  loadRuns();
  loadBoard();
  loadPool();
  loadStandards();
}

async function loadMeta() {
  try {
    meta.value = await api.scheduleMeta();
    current.value = meta.value.current_run || null;
    const t = meta.value.today;
    const add = (d, n) => {
      const x = new Date(`${d}T00:00:00`);
      x.setDate(x.getDate() + n);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    if (!build.from) { build.from = t; build.to = add(t, 30); }
    if (!calForm.from) { calForm.from = t; calForm.to = add(t, 21); }
    if (!calFilter.from) { calFilter.from = t; calFilter.to = add(t, 30); }
  } catch (e) { /* ignore */ }
}

async function loadRuns() {
  try { runs.value = await api.scheduleRuns(); } catch (e) { runs.value = []; }
}

async function loadBoard() {
  try {
    const id = boardRunId.value || (current.value && current.value.id);
    if (!id) { board.value = {}; conflicts.value = []; changes.value = []; return; }
    board.value = await api.scheduleRun(id);
    changes.value = await api.scheduleChanges({ run_id: id });
    conflicts.value = board.value.conflicts || [];
  } catch (e) {
    board.value = {};
  }
}

async function loadPool() {
  try { pool.value = await api.scheduleOrders(); } catch (e) { pool.value = []; }
}

async function loadStandards() {
  try { standards.value = await api.scheduleStandards(); } catch (e) { standards.value = []; }
}

async function loadCal() {
  try {
    const d = await api.scheduleCalendars({ from: calFilter.from, to: calFilter.to, work_center: calFilter.work_center });
    calData.value = d;
  } catch (e) { /* ignore */ }
}

function openRun(id) {
  boardRunId.value = id;
  tab.value = 'board';
  loadBoard();
}

function openBuild() {
  build.open = true;
  build.preview = null;
  if (!build.order_ids.length) build.order_ids = pool.value.filter((o) => Number(o.qty) > 0).map((o) => o.id);
}

function pickAll(on) {
  build.order_ids = on ? pool.value.filter((o) => Number(o.qty) > 0).map((o) => o.id) : [];
}

function buildPayload() {
  return {
    from: build.from,
    to: build.to,
    algo: build.algo,
    order_ids: build.scope === 'orders' ? build.order_ids : null,
    carry_locked: build.carry_locked,
    material_gate: build.material_gate
  };
}

async function doPreview() {
  build.loading = true;
  try {
    build.preview = await api.previewScheduleRun(buildPayload());
  } catch (e) {
    alert(e.message);
  } finally {
    build.loading = false;
  }
}

async function doCreate() {
  build.loading = true;
  try {
    const r = await api.createScheduleRun(buildPayload());
    build.open = false;
    await loadRuns();
    await loadMeta();
    boardRunId.value = r.run_id;
    await loadBoard();
    tab.value = 'board';
  } catch (e) {
    alert(e.message);
  } finally {
    build.loading = false;
  }
}

async function doPublish(r) {
  const note = prompt(`发布 ${r.run_no} 为当前生效排程？\n（硬冲突必须已逐条处理；发布后可加一句说明）`, '按此下发生产');
  if (note === null) return;
  try {
    await api.publishScheduleRun(r.id, { note });
    await loadRuns();
    await loadMeta();
    boardRunId.value = '';
    await loadBoard();
    alert('已发布为当前生效排程');
  } catch (e) {
    alert(e.message);
  }
}

async function doArchive(r) {
  if (!confirm(`归档 ${r.run_no}？归档后只读、不可再调整。`)) return;
  try {
    await api.archiveScheduleRun(r.id);
    await loadRuns();
  } catch (e) {
    alert(e.message);
  }
}

function openResolve(c) {
  resolve.open = true;
  resolve.row = c;
  resolve.note = '';
}

async function doResolve() {
  if (!resolve.note.trim()) return alert('必须写处理意见');
  try {
    await api.resolveScheduleConflict(resolve.row.id, { note: resolve.note.trim() });
    resolve.open = false;
    await loadBoard();
  } catch (e) {
    alert(e.message);
  }
}

function openAdjust(t) {
  adjust.open = true;
  adjust.row = t;
  adjust.start_at = t.start_at;
  adjust.end_at = t.end_at;
  adjust.work_center = t.work_center;
  adjust.est_hours = t.est_hours;
  adjust.locked = !!t.locked;
  adjust.reason = '';
}

async function doAdjust() {
  if (!adjust.reason.trim()) return alert('调整必须写原因');
  const body = {
    start_at: adjust.start_at,
    end_at: adjust.end_at,
    work_center: adjust.work_center,
    est_hours: adjust.est_hours,
    locked: adjust.locked ? 1 : 0,
    reason: adjust.reason.trim()
  };
  try {
    await api.patchScheduleTask(adjust.row.id, body);
    adjust.open = false;
    await loadBoard();
  } catch (e) {
    alert(e.message);
  }
}

function openStd(s) {
  std.open = true;
  std.id = s ? s.id : null;
  std.process_name = s ? s.process_name : '';
  std.work_center = s ? s.work_center : ((meta.value.work_centers || [])[0] || {}).work_center || '';
  std.std_minutes = s ? s.std_minutes : 1;
  std.setup_minutes = s ? s.setup_minutes : 0;
  std.efficiency = s ? s.efficiency : 85;
  std.batch_min_qty = s ? s.batch_min_qty : 0;
  std.remark = s ? s.remark || '' : '';
}

async function doSaveStd() {
  try {
    const body = {
      process_name: std.process_name,
      work_center: std.work_center,
      std_minutes: std.std_minutes,
      setup_minutes: std.setup_minutes,
      efficiency: std.efficiency,
      batch_min_qty: std.batch_min_qty,
      remark: std.remark
    };
    if (std.id) await api.updateScheduleStandard(std.id, body);
    else await api.saveScheduleStandard(body);
    std.open = false;
    await loadStandards();
    await loadMeta();
  } catch (e) {
    alert(e.message);
  }
}

async function doFill() {
  if (!canWrite.value) return;
  const body = { ...calForm };
  try {
    const r = await api.fillScheduleCalendars(body);
    await loadCal();
    await loadMeta();
    alert(`已写入 ${r.written} 行班次日历（${r.from} ~ ${r.to}）`);
  } catch (e) {
    alert(e.message);
  }
}

async function saveCal(row, val) {
  const hours = Number(val);
  if (!Number.isFinite(hours)) return;
  try {
    await api.saveScheduleCalendar({ work_center: row.work_center, cal_date: row.cal_date, base_hours: hours, start_hour: row.start_hour });
    await loadCal();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  await loadMeta();
  await loadRuns();
  await loadBoard();
  await loadPool();
  await loadStandards();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat strong i { font-size: 13px; font-style: normal; color: #8a94a6; margin-left: 2px; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.empty-box { background: #fff; border: 1px dashed #dfe5ef; border-radius: 12px; padding: 34px; text-align: center; color: #8a94a6; font-size: 13px; }
.sec-title { font-size: 14px; color: #16305f; margin: 20px 0 10px; }
.ok-line { color: #16a34a; }
.warn-box { margin-top: 10px; background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; color: #92400e; }
.ok-box { margin-top: 10px; background: #f2fbf5; border: 1px solid #c9ecd6; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; color: #15803d; }

.gantt-wrap { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; overflow-x: auto; padding: 8px; }
.gantt { display: grid; gap: 2px; min-width: max-content; }
.g-cell { border-radius: 6px; }
.g-head { background: #f5f8fd; text-align: center; padding: 4px 0; font-size: 11px; color: #5b6474; overflow: hidden; }
.g-head.rest { background: #eef1f6; color: #a3adbd; }
.g-corner { display: flex; align-items: center; justify-content: center; font-weight: 700; color: #16305f; }
.dow { font-size: 10px; color: #9aa4b5; }
.dnum { font-size: 11px; font-weight: 700; }
.g-label { background: #f8fafd; padding: 6px 8px; display: flex; flex-direction: column; justify-content: center; }
.g-label .wc { font-size: 12.5px; font-weight: 700; color: #16305f; }
.g-day { position: relative; height: 40px; background: #f8fafd; overflow: hidden; }
.g-day.rest { background: repeating-linear-gradient(45deg, #f1f3f7, #f1f3f7 5px, #e9edf3 5px, #e9edf3 10px); }
.g-day.late { box-shadow: inset 0 0 0 1px #f3c2c9; }
.bar { position: absolute; left: 3px; right: 3px; bottom: 3px; top: 3px; display: flex; align-items: flex-end; gap: 1px; }
.bar i { flex-grow: 1; flex-basis: 0; border-radius: 3px 3px 0 0; min-width: 2px; opacity: 0.92; }
.down-mark { position: absolute; inset: 0; background: repeating-linear-gradient(45deg, rgba(217, 45, 69, 0.12), rgba(217, 45, 69, 0.12) 4px, transparent 4px, transparent 8px); }
.dot { position: absolute; top: 3px; right: 3px; width: 5px; height: 5px; border-radius: 50%; background: #d92d45; }

.legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 2px 0; font-size: 11.5px; color: #5b6474; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }

.split { display: flex; gap: 14px; align-items: flex-start; }
.panel { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 14px; min-width: 300px; }
.panel.narrow { width: 380px; flex: none; min-width: 0; }
.panel.grow { flex: 1; min-width: 0; }
.panel h4 { margin: 0 0 10px; font-size: 13.5px; color: #16305f; display: flex; gap: 8px; align-items: baseline; }
table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
table.data .mini-inp { width: 56px; box-sizing: border-box; }
.mini-inp { width: 62px; padding: 3px 6px; border: 1px solid #dfe5ef; border-radius: 6px; font-size: 12px; text-align: right; }

.preview { margin-top: 14px; border-top: 1px dashed #e6ebf3; padding-top: 12px; }
.pv-row { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: #5b6474; margin-bottom: 8px; }
.pv-row b { color: #16305f; }
.pv-conf { font-size: 12px; padding: 5px 0; color: #5b6474; border-bottom: 1px dashed #f0f3f8; }
.pv-conf.block { color: #b42318; }

.ops { white-space: nowrap; }
@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split { flex-direction: column; }
  .panel { min-width: 0; width: 100%; }
}
</style>
