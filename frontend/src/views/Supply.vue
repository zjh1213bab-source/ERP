<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>供给批次与预订</h2>
        <p class="sub">
          可买量 = <b>合格已上架实物 − 有效现货占用</b>，已拣是占用的子集<b>不重复扣</b>；未来可订只算<b>叶子批次</b>，
          已上架的批次归现货、未来可订按 0 算（同一批货不能卖两次）。<b>申请不占量，销售确认才占</b>；
          临时占用转订单时直接挂单、<b>不先释放再抢量</b>；短装<b>保留承诺、形成缺口</b>，人工评估替代。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>现货可买</span><strong>{{ num(ov.spot && ov.spot.sellable) }}</strong><small>实物 {{ num(ov.spot && ov.spot.on_hand) }} − 占用 {{ num(ov.spot && ov.spot.held_spot) }}</small></div>
      <div class="stat"><span>未来可订</span><strong>{{ num(ov.future_available) }}</strong><small>叶子批次合计</small></div>
      <div class="stat" :class="ov.projection && ov.projection.stale ? 'st-warn' : ''"><span>投影陈旧</span><strong>{{ (ov.projection && ov.projection.stale) || 0 }}</strong><small>超过 {{ dict.stale_min }} 分钟未刷新</small></div>
      <div class="stat" :class="ov.projection && ov.projection.anomaly ? 'st-bad' : ''"><span>负量异常</span><strong>{{ (ov.projection && ov.projection.anomaly) || 0 }}</strong><small>异常时禁止新占用</small></div>
      <div class="stat" :class="ov.requests && ov.requests.submitted ? 'st-warn' : ''"><span>待销售确认</span><strong>{{ (ov.requests && ov.requests.submitted) || 0 }}</strong><small>申请不占量</small></div>
      <div class="stat" :class="ov.shortages && ov.shortages.open ? 'st-bad' : ''"><span>缺口待处理</span><strong>{{ (ov.shortages && ov.shortages.open) || 0 }}</strong><small>{{ num(ov.shortages && ov.shortages.qty) }} 件</small></div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'proj' }" @click="go('proj')">可售口径<span v-if="ov.projection && ov.projection.anomaly" class="tab-dot">{{ ov.projection.anomaly }}</span></button>
        <button :class="{ on: tab === 'batch' }" @click="go('batch')">供给批次</button>
        <button :class="{ on: tab === 'booking' }" @click="go('booking')">预订与占用<span v-if="ov.requests && ov.requests.submitted" class="tab-dot">{{ ov.requests.submitted }}</span></button>
        <button :class="{ on: tab === 'short' }" @click="go('short')">缺口处理<span v-if="ov.shortages && ov.shortages.open" class="tab-dot">{{ ov.shortages.open }}</span></button>
      </div>
    </div>

    <!-- ==================== 一、可售口径 ==================== -->
    <div v-if="tab === 'proj'" class="block">
      <div class="hint-bar">
        ERP 库存事件是<b>唯一账源</b>，商城 / 小程序 / 销售确认读的都是<b>同一份投影</b>。
        数据超过 {{ dict.stale_min }} 分钟就标陈旧，<b>销售确认时会强制重算</b>；可买量为负会报警并<b>禁止新增占用</b>。
      </div>
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="pf.warehouse" @change="loadProj">
          <option value="">全部仓库</option>
          <option v-for="w in dict.warehouses" :key="w.k" :value="w.k">{{ w.v }}</option>
        </select>
        <input v-model="pf.q" class="kw" placeholder="款号 / SKU" @keyup.enter="loadProj" />
        <label class="chk"><input v-model="pf.anomaly" type="checkbox" true-value="1" false-value="" @change="loadProj" /> 只看异常</label>
        <button class="btn btn-ghost btn-sm" @click="loadProj">查询</button>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-primary" :disabled="saving" @click="doRefresh">{{ saving ? '刷新中…' : '刷新投影' }}</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>SKU</th><th>仓库</th><th class="num">实物</th><th class="num">有效占用</th><th class="num">其中已拣</th>
              <th class="num">可买量</th><th class="num">未来可订</th><th class="num">版本</th><th>刷新时间</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in proj" :key="p.id" :class="{ 'row-bad': p.anomaly }">
              <td class="nowrap"><b>{{ p.sku }}</b><div class="tiny muted">{{ p.style_no }} · {{ p.color || '—' }} · {{ p.size || '—' }}</div></td>
              <td class="tiny nowrap">{{ p.warehouse_label }}</td>
              <td class="num">{{ num(p.on_hand) }}</td>
              <td class="num">{{ num(p.held_spot) }}</td>
              <td class="num muted">{{ num(p.qty_picked) }}</td>
              <td class="num"><b :class="{ red: p.sellable < 0 }">{{ num(p.sellable) }}</b></td>
              <td class="num">{{ num(p.future_available) }}</td>
              <td class="num tiny">v{{ p.version }}</td>
              <td class="tiny nowrap">{{ p.computed_at }}</td>
              <td class="tiny">
                <span v-if="p.anomaly" class="tag red">负量</span>
                <span v-else-if="p.stale" class="tag orange">陈旧</span>
                <span v-else class="tag green">有效</span>
                <div v-if="p.anomaly" class="red tiny">{{ p.anomaly }}</div>
                <div v-else-if="p.note" class="muted tiny">{{ p.note }}</div>
              </td>
            </tr>
            <tr v-if="!proj.length"><td colspan="10" class="empty-cell">还没有投影数据，点「刷新投影」</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 二、供给批次 ==================== -->
    <div v-if="tab === 'batch'" class="block">
      <div class="hint-bar">
        同一批货从<b>在产 → 待发 → 在途 → 实收检验 → 上架</b>，每步迁移数量必须守恒；<b>未检的不能承诺</b>、<b>未检的不能上架</b>。
        部分到货拆子批，<b>父批不再单独算可订量</b>；短装保留承诺并形成缺口，不隐瞒也不超售。
      </div>
      <div class="toolbar" style="margin-bottom: 12px">
        <select v-model="bf.warehouse" @change="loadBatches">
          <option value="">全部仓库</option>
          <option v-for="w in dict.warehouses" :key="w.k" :value="w.k">{{ w.v }}</option>
        </select>
        <select v-model="bf.stage" @change="loadBatches">
          <option value="">全部阶段</option>
          <option v-for="s in dict.stage" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <label class="chk"><input v-model="bf.available" type="checkbox" true-value="1" false-value="" @change="loadBatches" /> 只看有可订量</label>
        <div class="spacer"></div>
        <button v-action="['supply','create']" v-if="canWrite" class="btn btn-primary btn-sm" @click="openBatchNew">＋ 新建批次</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th style="min-width: 132px">批次</th><th>款色码</th><th>阶段</th><th class="num">手上数量</th><th class="num">可承诺</th>
              <th class="num">已预订</th><th class="num">可订</th><th>交期 / 依据</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="b in batches" :key="b.id">
              <td><a class="lnk mono" style="white-space: nowrap" @click="openBatch(b.id)">{{ b.batch_no }}</a>
                <div class="tiny muted">{{ b.source_no || '—' }}</div></td>
              <td class="tiny nowrap">{{ b.style_no }} · {{ b.color || '—' }} · {{ b.size || '—' }}</td>
              <td><span class="tag" :class="stageTag(b.stage)">{{ b.stage_label }}</span>
                <div v-if="b.parent_batch_id" class="tiny muted">子批 / 父批 #{{ b.parent_batch_id }}</div></td>
              <td class="num">{{ num(b.stage_qty) }}</td>
              <td class="num">{{ num(b.committable) }}</td>
              <td class="num">{{ num(b.held_future) }}</td>
              <td class="num"><b :class="{ green: b.available > 0 }">{{ num(b.available) }}</b>
                <div v-if="b.excludes" class="tiny muted ex">{{ b.excludes }}</div></td>
              <td class="tiny nowrap">{{ b.eta_date || '—' }}
                <div class="muted">{{ b.eta_evidence || '未填依据' }}</div></td>
              <td class="nowrap">
                <button v-if="canWrite && b.next_stage" class="link-btn" @click="openMove(b)">推进</button>
                <button v-if="canWrite && b.stage === 'received_checked'" class="link-btn" @click="openInspect(b)">检验</button>
                <button v-if="canWrite && b.stage !== 'on_shelf'" class="link-btn" @click="openSplit(b)">拆分</button>
                <button v-if="canWrite" class="link-btn danger" @click="openShort(b)">短装</button>
              </td>
            </tr>
            <tr v-if="!batches.length"><td colspan="9" class="empty-cell">没有批次</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、预订与占用 ==================== -->
    <div v-if="tab === 'booking'" class="block">
      <div class="hint-bar">
        客户提交的申请只是<b>意向，不占量</b>；只有授权销售确认后，才按 <b>SKU × 供给批次</b> 建立占用。
        确认用<b>版本 + 幂等键 + 原子数量条件</b>执行：重试不会生成第二张，超量一定失败。
        临时占用到期会释放；<b>已拣的要先做实物回位确认</b>；转正式订单时占用直接挂单，数量<b>不回可卖池</b>。
      </div>

      <h4 class="sec">预订申请<small>提交不占量，确认才建占用</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="rf.status" @change="loadRequests">
          <option value="">全部状态</option>
          <option v-for="s in dict.req_status" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doExpireReq">清理过期申请</button>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openReqNew">＋ 代客申请</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>申请</th><th>客户</th><th>款色码</th><th class="num">数量</th><th>类型</th><th class="num">报价</th>
              <th>状态</th><th>有效期</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in requests" :key="r.id" :class="{ 'row-warn': r.is_expired }">
              <td class="nowrap"><a class="lnk" @click="openReq(r.id)">{{ r.request_no }}</a>
                <div class="tiny muted">{{ r.channel_label }}</div></td>
              <td class="tiny">{{ r.customer_name || '—' }}</td>
              <td class="tiny nowrap">{{ r.style_no }} · {{ r.color || '—' }} · {{ r.size || '—' }}</td>
              <td class="num">{{ num(r.qty) }}</td>
              <td><span class="tag" :class="r.kind === 'spot' ? 'blue' : 'purple'">{{ r.kind_label }}</span></td>
              <td class="num tiny">{{ r.quote_price ? money(r.quote_price, r.currency) : '—' }}</td>
              <td><span class="tag" :class="reqTag(r.status)">{{ r.status_label }}</span>
                <div v-if="r.reject_reason" class="tiny muted">{{ r.reject_reason }}</div></td>
              <td class="tiny nowrap" :class="{ red: r.is_expired }">{{ r.valid_until || '—' }}</td>
              <td class="nowrap">
                <button v-if="canConfirm && r.status === 'submitted'" class="link-btn" @click="openConfirm(r)">确认</button>
                <button v-action="['supply','reject']" v-if="canConfirm && r.status === 'submitted'" class="link-btn danger" @click="rejectReq(r)">驳回</button>
                <button v-if="canWrite && ['submitted','sales_confirmed'].includes(r.status)" class="link-btn" @click="cancelReq(r)">取消</button>
              </td>
            </tr>
            <tr v-if="!requests.length"><td colspan="9" class="empty-cell">没有申请</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="sec">占用<small>已拣是占用的子集，不再重复扣可售</small></h4>
      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="hf.status" @change="loadHolds">
          <option value="active">只看占用中</option>
          <option value="">全部</option>
          <option value="converted">已转订单</option>
          <option value="released">已释放</option>
          <option value="expired">已到期</option>
        </select>
        <div class="spacer"></div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="doExpireHold">清理到期占用</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>占用</th><th>类型</th><th>客户</th><th>款色码</th><th class="num">数量</th><th class="num">已拣</th>
              <th>到期</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="h in holds" :key="h.id" :class="{ 'row-bad': h.is_due }">
              <td class="nowrap mono tiny">{{ h.hold_no }}</td>
              <td><span class="tag" :class="h.kind === 'spot' ? 'blue' : 'purple'">{{ h.kind_label }}</span></td>
              <td class="tiny">{{ h.customer_name || '—' }}</td>
              <td class="tiny nowrap">{{ h.style_no }} · {{ h.color || '—' }} · {{ h.size || '—' }}</td>
              <td class="num">{{ num(h.qty) }}</td>
              <td class="num muted">{{ num(h.qty_picked) }}</td>
              <td class="tiny nowrap" :class="{ red: h.is_due }">{{ h.expires_at || '—' }}
                <div v-if="h.hours_left !== null && h.status === 'active'" class="muted">{{ h.hours_left }} 小时</div></td>
              <td><span class="tag" :class="holdTag(h.status)">{{ h.status_label }}</span>
                <div v-if="h.order_id" class="tiny muted">已挂订单 #{{ h.order_id }}</div></td>
              <td class="nowrap">
                <button v-if="canWrite && h.status === 'active'" class="link-btn" @click="openPicked(h)">拣货</button>
                <button v-if="canWrite && h.status === 'active'" class="link-btn" @click="openRelease(h)">释放</button>
                <button v-if="canWrite && h.status === 'active'" class="link-btn" @click="openConvert(h)">转订单</button>
              </td>
            </tr>
            <tr v-if="!holds.length"><td colspan="9" class="empty-cell">没有占用</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 四、缺口 ==================== -->
    <div v-if="tab === 'short'" class="block">
      <div class="hint-bar">
        短装导致承诺不足时<b>保留原承诺</b>并形成缺口，等人工评估：换替代批次 / 延期 / 取消 / 客户接受短装。
        <b>不隐瞒、不超售</b>——缺口没处理掉，这批货的占用一直挂着。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>缺口</th><th>批次</th><th>客户</th><th class="num">缺口数量</th><th class="num">原承诺</th>
              <th>处理方式</th><th>处理人 / 时间</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="s in shortages" :key="s.id">
              <td class="nowrap mono tiny">{{ s.shortage_no }}</td>
              <td class="tiny">#{{ s.batch_id }}<div class="muted">{{ s.sku }}</div></td>
              <td class="tiny">{{ s.customer_name || '—' }}</td>
              <td class="num"><b class="red">{{ num(s.qty_short) }}</b></td>
              <td class="num">{{ num(s.qty_committed) }}</td>
              <td><span class="tag" :class="s.resolution === 'open' ? 'red' : 'green'">{{ s.resolution_label }}</span>
                <div v-if="s.substitute_batch_id" class="tiny muted">替代批次 #{{ s.substitute_batch_id }}</div>
                <div v-if="s.note" class="tiny muted pre">{{ s.note }}</div></td>
              <td class="tiny nowrap">{{ s.decided_by || '—' }}<div class="muted">{{ s.decided_at || '' }}</div></td>
              <td><button v-if="canWrite && s.resolution === 'open'" class="link-btn" @click="openResolve(s)">处理</button></td>
            </tr>
            <tr v-if="!shortages.length"><td colspan="8" class="empty-cell">没有缺口</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 弹窗：新建批次 ==================== -->
    <div v-if="modal === 'batchNew'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>新建供给批次</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>仓库
              <select v-model="batchForm.warehouse">
                <option v-for="w in dict.warehouses" :key="w.k" :value="w.k">{{ w.v }}</option>
              </select>
            </label>
            <label>款号<input v-model="batchForm.style_no" /></label>
            <label>颜色<input v-model="batchForm.color" /></label>
            <label>尺码<input v-model="batchForm.size" /></label>
            <label>计划数量<input v-model="batchForm.qty_planned" type="number" /></label>
            <label>风险缓冲<input v-model="batchForm.risk_buffer" type="number" placeholder="不承诺的部分" /></label>
            <label>预计到仓<input v-model="batchForm.eta_date" type="date" /></label>
            <label>依据<input v-model="batchForm.eta_evidence" placeholder="排产单 / 船期 / 提单号" /></label>
          </div>
          <p class="tiny muted" style="margin-top: 8px">没填交期依据的批次，进「待发」时会被拦下来——客户预订要有交期依据。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveBatch">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：批次详情 ==================== -->
    <div v-if="modal === 'batch' && batchDetail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ batchDetail.batch_no }} · {{ batchDetail.sku }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="kv">
            <div><span>阶段</span><b>{{ batchDetail.stage_label }}</b><small>手上 {{ num(batchDetail.stage_qty) }}</small></div>
            <div><span>可承诺</span><b>{{ num(batchDetail.committable) }}</b><small>扣缓冲/冻结/短装</small></div>
            <div><span>已预订</span><b>{{ num(batchDetail.held_future) }}</b><small>未来供给占用</small></div>
            <div><span>可订</span><b class="green">{{ num(batchDetail.available) }}</b><small>{{ batchDetail.excludes || '可接新预订' }}</small></div>
          </div>
          <p class="tiny muted">计划 {{ num(batchDetail.qty_planned) }} · 产出 {{ num(batchDetail.qty_produced) }} · 待发 {{ num(batchDetail.qty_ready) }} ·
            在途 {{ num(batchDetail.qty_in_transit) }} · 实收 {{ num(batchDetail.qty_received) }} · 已检合格 {{ num(batchDetail.qty_checked_ok) }} ·
            上架 {{ num(batchDetail.qty_on_shelf) }} · 短装 {{ num(batchDetail.qty_short) }}</p>

          <h4 style="margin-top: 12px">迁移记录<small>数量守恒，占用随批次走</small></h4>
          <div class="tl">
            <div v-for="m in batchDetail.moves" :key="m.id" class="tl-row">
              <span class="tiny muted mono">{{ $fmt(m.created_at) }}</span>
              <span class="tag gray">{{ m.from_stage ? (stageLabel(m.from_stage) + ' → ') : '' }}{{ stageLabel(m.to_stage) }}</span>
              <span class="tiny">{{ m.qty }}</span>
              <span class="tiny muted">{{ m.note }}</span>
              <span v-if="m.holds_carried" class="tiny muted">（带占用 {{ m.holds_carried }} 条）</span>
            </div>
            <div v-if="!batchDetail.moves.length" class="empty-box">还没有迁移记录</div>
          </div>

          <h4 style="margin-top: 12px">该批次上的占用</h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>占用</th><th>客户</th><th class="num">数量</th><th>到期</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="h in batchDetail.holds" :key="h.id">
                  <td class="tiny mono">{{ h.hold_no }}</td><td class="tiny">{{ h.customer_name || '—' }}</td>
                  <td class="num">{{ num(h.qty) }}</td><td class="tiny">{{ h.expires_at || '—' }}</td>
                  <td class="tiny">{{ h.status_label }}</td>
                </tr>
                <tr v-if="!batchDetail.holds.length"><td colspan="5" class="empty-cell">没有占用</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：推进阶段 ==================== -->
    <div v-if="modal === 'move'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>推进 {{ moveForm.batch_no }}：{{ stageLabel(moveForm.from) }} → {{ stageLabel(moveForm.to) }}</h3>
          <button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>迁移数量<input v-model="moveForm.qty" type="number" :placeholder="'最多 ' + moveForm.capacity" /></label>
            <label v-if="moveForm.to === 'received_checked'">到仓签收单<input v-model="moveForm.receipt_no" /></label>
          </div>
          <label class="full">备注<input v-model="moveForm.note" /></label>
          <p class="tiny muted" style="margin-top: 8px">
            当前阶段手上 {{ moveForm.capacity }} 件，迁移后上游减少、下游增加，<b>总量不变</b>；
            批次上的有效占用会跟着走，不新增也不丢失。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveMove">确定</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：检验 ==================== -->
    <div v-if="modal === 'inspect'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>实收检验 · {{ inspectForm.batch_no }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="tiny muted">待检 {{ num(inspectForm.pending) }} 件。合格的才进可承诺；不合格的进短装，形成缺口不隐瞒。</p>
          <div class="fgrid">
            <label>合格数量<input v-model="inspectForm.qty_ok" type="number" /></label>
            <label>不合格数量<input v-model="inspectForm.qty_defect" type="number" /></label>
          </div>
          <label class="full">不合格原因<input v-model="inspectForm.reason" placeholder="有不合格品必填" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveInspect">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：拆分 / 短装 ==================== -->
    <div v-if="modal === 'split' || modal === 'short'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>{{ modal === 'split' ? '拆分子批' : '登记短装' }} · {{ subForm.batch_no }}</h3>
          <button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>{{ modal === 'split' ? '拆出数量' : '短装数量' }}<input v-model="subForm.qty" type="number" :placeholder="'当前 ' + subForm.capacity" /></label>
          </div>
          <label class="full">{{ modal === 'split' ? '说明' : '原因' }}<input v-model="subForm.note" :placeholder="modal === 'short' ? '来料不足 / 生产报废 / 运输破损' : '部分到货'" /></label>
          <p class="tiny muted" style="margin-top: 8px" v-if="modal === 'split'">
            拆出后父批数量减少、子批承接；<b>父批不再单独算可订量</b>，避免同一批货被算两次。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="modal === 'split' ? saveSplit() : saveShort()">确定</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：确认预订 ==================== -->
    <div v-if="modal === 'confirm'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>确认预订 · {{ confirmForm.request_no }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="tiny muted">客户 {{ confirmForm.customer_name }} 要 {{ confirmForm.style_no }} {{ confirmForm.color }} {{ confirmForm.size }} {{ num(confirmForm.qty) }} 件（{{ confirmForm.kind_label }}）。
            <b>确认后才会占量</b>。</p>
          <div class="fgrid">
            <label>确认数量<input v-model="confirmForm.qty" type="number" /></label>
            <label>占用有效期（小时）<input v-model="confirmForm.expires_in_hours" type="number" placeholder="默认 72" /></label>
            <label v-if="confirmForm.kind === 'future'">供给批次
              <select v-model="confirmForm.batch_id">
                <option :value="null">选择批次</option>
                <option v-for="b in leafBatches" :key="b.id" :value="b.id">
                  {{ b.batch_no }} · {{ b.stage_label }} · 可订 {{ b.available }}
                </option>
              </select>
            </label>
            <label v-if="confirmForm.kind === 'spot'">现货可买
              <input :value="spotLeft" disabled />
            </label>
          </div>
          <p class="tiny muted" style="margin-top: 8px">确认前会<b>强制重算</b>该 SKU 的可售/可订，不拿陈旧数据占量；超量会直接失败。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveConfirm">确认占用</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：代客申请 ==================== -->
    <div v-if="modal === 'reqNew'" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>代客提交申请</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="fgrid">
            <label>客户
              <select v-model="reqForm.customer_id">
                <option :value="null">不指定</option>
                <option v-for="c in dict.customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label>类型
              <select v-model="reqForm.kind">
                <option value="future">未来供给</option><option value="spot">现货</option>
              </select>
            </label>
            <label>款号<input v-model="reqForm.style_no" /></label>
            <label>颜色<input v-model="reqForm.color" /></label>
            <label>尺码<input v-model="reqForm.size" /></label>
            <label>数量<input v-model="reqForm.qty" type="number" /></label>
            <label>期望交期<input v-model="reqForm.expect_date" type="date" /></label>
            <label>报价<input v-model="reqForm.quote_price" type="number" /></label>
          </div>
          <p class="tiny muted" style="margin-top: 8px">申请只记录意向，<b>不占量</b>；等销售确认才建占用。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveReq">提交</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：申请详情 ==================== -->
    <div v-if="modal === 'req' && reqDetail" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>{{ reqDetail.request_no }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <div class="kv">
            <div><span>客户</span><b class="sm">{{ reqDetail.customer_name || '—' }}</b><small>{{ reqDetail.channel_label }}</small></div>
            <div><span>款色码</span><b class="sm">{{ reqDetail.style_no }} · {{ reqDetail.color }} · {{ reqDetail.size }}</b><small>{{ reqDetail.kind_label }}</small></div>
            <div><span>数量 / 报价</span><b>{{ num(reqDetail.qty) }}</b><small>{{ reqDetail.quote_price ? money(reqDetail.quote_price, reqDetail.currency) : '未报价' }}</small></div>
            <div><span>状态</span><b class="sm">{{ reqDetail.status_label }}</b><small>有效期 {{ reqDetail.valid_until || '—' }}</small></div>
          </div>
          <p v-if="reqDetail.hold" class="tiny">已生成占用：<b>{{ reqDetail.hold.hold_no }}</b> · {{ num(reqDetail.hold.qty) }} 件 · 到期 {{ reqDetail.hold.expires_at || '—' }}</p>
          <p v-if="reqDetail.batch" class="tiny">锁定批次：<b>{{ reqDetail.batch.batch_no }}</b>（{{ stageLabel(reqDetail.batch.stage) }}）</p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="modal = ''">关闭</button></div>
      </div>
    </div>

    <!-- ==================== 弹窗：拣货 / 释放 / 转订单 ==================== -->
    <div v-if="['picked','release','convert'].includes(modal)" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ modal === 'picked' ? '登记拣货' : (modal === 'release' ? '释放占用' : '占用转订单') }} · {{ holdForm.hold_no }}</h3>
          <button class="x" @click="modal = ''">×</button>
        </div>
        <div class="modal-body">
          <p class="tiny muted">占用 {{ num(holdForm.qty) }} 件，已拣 {{ num(holdForm.qty_picked) }} 件。</p>
          <div v-if="modal === 'picked'" class="fgrid">
            <label>本次拣货数量<input v-model="holdForm.pick_qty" type="number" /></label>
          </div>
          <div v-if="modal === 'release'">
            <label class="full">释放原因<input v-model="holdForm.reason" placeholder="客户取消 / 到期回收 / 录错" /></label>
            <label v-if="holdForm.qty_picked > 0" class="chk" style="margin-top: 8px">
              <input v-model="holdForm.confirm_picked" type="checkbox" /> 已确认实物回位（已拣 {{ num(holdForm.qty_picked) }} 件）
            </label>
          </div>
          <div v-if="modal === 'convert'" class="fgrid">
            <label>转成哪张订单
              <select v-model="holdForm.order_id">
                <option :value="null">选择订单</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ num(o.total_amount) }}</option>
              </select>
            </label>
            <p class="tiny muted">转订单时占用<b>直接挂单</b>，数量不回可卖池——否则中间那一刻会被别人抢走。</p>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveHoldAct">确定</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：处理缺口 ==================== -->
    <div v-if="modal === 'resolve' && resolveForm.id" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>处理缺口 · {{ resolveForm.shortage_no }}</h3><button class="x" @click="modal = ''">×</button></div>
        <div class="modal-body">
          <p class="tiny muted">客户 {{ resolveForm.customer_name }}，缺口 {{ num(resolveForm.qty_short) }} 件（原承诺 {{ num(resolveForm.qty_committed) }}）。</p>
          <div class="fgrid">
            <label>处理方式
              <select v-model="resolveForm.resolution">
                <option value="substitute">换替代批次</option>
                <option value="delay">延期交付</option>
                <option value="cancel">取消占用</option>
                <option value="written_off">客户接受短装</option>
              </select>
            </label>
            <label v-if="resolveForm.resolution === 'substitute'">替代批次
              <select v-model="resolveForm.substitute_batch_id">
                <option :value="null">选择批次</option>
                <option v-for="b in leafBatches" :key="b.id" :value="b.id">{{ b.batch_no }} · 可订 {{ b.available }}</option>
              </select>
            </label>
          </div>
          <label class="full">说明<input v-model="resolveForm.note" /></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="modal = ''">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveResolve">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('proj');
const dict = ref({});
const ov = ref({});
const saving = ref(false);
const modal = ref('');

const canWrite = computed(() => can('supply.write'));
const canConfirm = computed(() => can('supply.confirm'));

const num = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const money = (v, cur) => (cur === 'USD' ? '$' : '¥') + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const stageLabel = (k) => ((dict.value.stage || []).find((x) => x.k === k) || {}).v || k;
const stageTag = (s) => ({
  in_production: 'gray', ready_to_ship: 'blue', in_transit: 'purple',
  received_checked: 'orange', on_shelf: 'green', short: 'red', closed: 'gray'
}[s] || 'gray');
const reqTag = (s) => ({
  submitted: 'orange', sales_confirmed: 'green', converted: 'green',
  rejected: 'red', cancelled: 'gray', expired: 'gray'
}[s] || 'gray');
const holdTag = (s) => ({ active: 'blue', converted: 'green', released: 'gray', expired: 'orange' }[s] || 'gray');

/* ---------------- 可售口径 ---------------- */
const proj = ref([]);
const pf = reactive({ warehouse: '', q: '', anomaly: '' });
async function loadProj() {
  proj.value = await api.supplyProjection({ ...pf });
}
async function doRefresh() {
  saving.value = true;
  try {
    const r = await api.refreshSupplyProjection({ warehouse: pf.warehouse || undefined });
    await Promise.all([loadProj(), loadOv()]);
    alert(`已重算 ${r.refreshed} 个 SKU 的投影`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 批次 ---------------- */
const batches = ref([]);
const bf = reactive({ warehouse: '', stage: '', available: '' });
const batchDetail = ref(null);
const batchForm = reactive({ warehouse: 'us', style_no: '', color: '', size: '', qty_planned: 100, risk_buffer: 0, eta_date: '', eta_evidence: '' });
const moveForm = reactive({ id: null, batch_no: '', from: '', to: '', qty: '', capacity: 0, note: '', receipt_no: '' });
const inspectForm = reactive({ id: null, batch_no: '', pending: 0, qty_ok: '', qty_defect: '', reason: '' });
const subForm = reactive({ id: null, batch_no: '', qty: '', capacity: 0, note: '' });

async function loadBatches() {
  batches.value = await api.supplyBatches({ ...bf });
}
async function openBatch(id) {
  batchDetail.value = await api.supplyBatch(id);
  modal.value = 'batch';
}
function openBatchNew() {
  Object.assign(batchForm, { warehouse: 'us', style_no: '', color: '', size: '', qty_planned: 100, risk_buffer: 0, eta_date: '', eta_evidence: '' });
  modal.value = 'batchNew';
}
async function saveBatch() {
  saving.value = true;
  try {
    await api.createSupplyBatch({ ...batchForm });
    modal.value = '';
    await Promise.all([loadBatches(), loadOv(), loadProj()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
function openMove(b) {
  Object.assign(moveForm, {
    id: b.id, batch_no: b.batch_no, from: b.stage, to: b.next_stage,
    qty: b.stage_qty, capacity: b.stage_qty, note: '', receipt_no: ''
  });
  modal.value = 'move';
}
async function saveMove() {
  saving.value = true;
  try {
    await api.moveSupplyBatch(moveForm.id, { to_stage: moveForm.to, qty: moveForm.qty, note: moveForm.note });
    modal.value = '';
    await Promise.all([loadBatches(), loadOv(), loadProj()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
function openInspect(b) {
  Object.assign(inspectForm, { id: b.id, batch_no: b.batch_no, pending: b.qty_received, qty_ok: b.qty_received, qty_defect: 0, reason: '' });
  modal.value = 'inspect';
}
async function saveInspect() {
  saving.value = true;
  try {
    const r = await api.inspectSupplyBatch(inspectForm.id, {
      qty_ok: inspectForm.qty_ok, qty_defect: inspectForm.qty_defect, reason: inspectForm.reason
    });
    modal.value = '';
    await Promise.all([loadBatches(), loadOv(), loadProj(), loadShortages()]);
    if (r.shortages && r.shortages.length) alert(`检验完成，形成 ${r.shortages.length} 条缺口待处理`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
function openSplit(b) {
  Object.assign(subForm, { id: b.id, batch_no: b.batch_no, qty: '', capacity: b.stage_qty, note: '' });
  modal.value = 'split';
}
async function openShort(b) {
  Object.assign(subForm, { id: b.id, batch_no: b.batch_no, qty: '', capacity: b.stage_qty, note: '' });
  modal.value = 'short';
}
async function saveSplit() {
  saving.value = true;
  try {
    await api.splitSupplyBatch(subForm.id, { qty: subForm.qty, note: subForm.note });
    modal.value = '';
    await Promise.all([loadBatches(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function saveShort() {
  saving.value = true;
  try {
    const r = await api.shortSupplyBatch(subForm.id, { qty: subForm.qty, reason: subForm.note });
    modal.value = '';
    await Promise.all([loadBatches(), loadOv(), loadProj(), loadShortages()]);
    if (r.shortages && r.shortages.length) alert(`已登记短装，形成 ${r.shortages.length} 条缺口`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 申请与占用 ---------------- */
const requests = ref([]);
const holds = ref([]);
const rf = reactive({ status: '' });
const hf = reactive({ status: 'active' });
const confirmForm = reactive({ id: null, request_no: '', customer_name: '', style_no: '', color: '', size: '', qty: 0, kind: 'future', kind_label: '', batch_id: null, expires_in_hours: 72 });
const reqForm = reactive({ customer_id: null, kind: 'future', style_no: '', color: '', size: '', qty: 10, expect_date: '', quote_price: '' });
const reqDetail = ref(null);
const holdForm = reactive({ id: null, hold_no: '', qty: 0, qty_picked: 0, pick_qty: '', reason: '', confirm_picked: false, order_id: null });
const orders = ref([]);
const leafBatches = ref([]);

async function loadRequests() {
  requests.value = await api.supplyRequests({ ...rf });
}
async function loadHolds() {
  holds.value = await api.supplyHolds({ ...hf });
}
async function openReqNew() {
  Object.assign(reqForm, { customer_id: null, kind: 'future', style_no: '', color: '', size: '', qty: 10, expect_date: '', quote_price: '' });
  modal.value = 'reqNew';
}
async function saveReq() {
  saving.value = true;
  try {
    const c = (dict.value.customers || []).find((x) => x.id === reqForm.customer_id);
    await api.createSupplyRequest({ ...reqForm, customer_name: c ? c.name : null });
    modal.value = '';
    await Promise.all([loadRequests(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function openReq(id) {
  reqDetail.value = await api.supplyRequest(id);
  modal.value = 'req';
}
async function openConfirm(r) {
  const all = await api.supplyBatches({ warehouse: 'us' });
  leafBatches.value = all.filter((b) => b.style_no === r.style_no && b.status === 'active'
    && b.stage !== 'on_shelf' && (!b.children || b.children.length === 0));
  Object.assign(confirmForm, {
    id: r.id, request_no: r.request_no, customer_name: r.customer_name, style_no: r.style_no,
    color: r.color, size: r.size, qty: r.qty, kind: r.kind, kind_label: r.kind_label,
    batch_id: null, expires_in_hours: 72
  });
  modal.value = 'confirm';
}
const spotLeft = computed(() => {
  const p = proj.value.find((x) => x.style_no === confirmForm.style_no && (x.color || '') === (confirmForm.color || '') && (x.size || '') === (confirmForm.size || ''));
  return p ? num(p.sellable) : '—';
});
async function saveConfirm() {
  saving.value = true;
  try {
    await api.confirmSupplyRequest(confirmForm.id, {
      batch_id: confirmForm.batch_id, qty: confirmForm.qty, expires_in_hours: confirmForm.expires_in_hours
    });
    modal.value = '';
    await Promise.all([loadRequests(), loadHolds(), loadProj(), loadOv(), loadBatches()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function rejectReq(r) {
  const reason = prompt('驳回原因');
  if (!reason) return;
  try {
    await api.rejectSupplyRequest(r.id, { reason });
    await Promise.all([loadRequests(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function cancelReq(r) {
  const reason = prompt('取消原因', '客户取消');
  if (reason === null) return;
  try {
    await api.cancelSupplyRequest(r.id, { reason });
    await Promise.all([loadRequests(), loadHolds(), loadOv(), loadProj()]);
  } catch (e) { alert(e.message); }
}
async function doExpireReq() {
  try {
    const r = await api.expireSupplyRequests();
    alert(`已清理 ${r.expired} 条过期申请`);
    await Promise.all([loadRequests(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doExpireHold() {
  try {
    const r = await api.expireSupplyHolds();
    alert(`已释放 ${r.expired} 条到期占用${r.holds.length ? '：' + r.holds.join('、') : ''}`);
    await Promise.all([loadHolds(), loadProj(), loadOv()]);
  } catch (e) { alert(e.message); }
}
function openPicked(h) {
  Object.assign(holdForm, { id: h.id, hold_no: h.hold_no, qty: h.qty, qty_picked: h.qty_picked, pick_qty: '', reason: '', confirm_picked: false, order_id: null });
  modal.value = 'picked';
}
function openRelease(h) {
  Object.assign(holdForm, { id: h.id, hold_no: h.hold_no, qty: h.qty, qty_picked: h.qty_picked, pick_qty: '', reason: '', confirm_picked: false, order_id: null });
  modal.value = 'release';
}
async function openConvert(h) {
  const list = await api.orders({ limit: 200 });
  const rows = Array.isArray(list) ? list : (list.rows || []);
  orders.value = rows.filter((o) => !['draft', 'cancelled'].includes(o.status));
  Object.assign(holdForm, { id: h.id, hold_no: h.hold_no, qty: h.qty, qty_picked: h.qty_picked, pick_qty: '', reason: '', confirm_picked: false, order_id: null });
  modal.value = 'convert';
}
async function saveHoldAct() {
  saving.value = true;
  try {
    if (modal.value === 'picked') {
      await api.pickedSupplyHold(holdForm.id, { qty: holdForm.pick_qty });
    } else if (modal.value === 'release') {
      await api.releaseSupplyHold(holdForm.id, { reason: holdForm.reason, confirm_picked: holdForm.confirm_picked });
    } else {
      const r = await api.convertSupplyHold(holdForm.id, { order_id: holdForm.order_id });
      alert(r.note || '已转订单');
    }
    modal.value = '';
    await Promise.all([loadHolds(), loadProj(), loadOv(), loadRequests()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 缺口 ---------------- */
const shortages = ref([]);
const resolveForm = reactive({ id: null, shortage_no: '', customer_name: '', qty_short: 0, qty_committed: 0, resolution: 'substitute', substitute_batch_id: null, note: '' });
async function loadShortages() {
  shortages.value = await api.supplyShortages({});
}
async function openResolve(s) {
  const all = await api.supplyBatches({ warehouse: 'us' });
  leafBatches.value = all.filter((b) => b.status === 'active' && b.stage !== 'on_shelf' && (!b.children || b.children.length === 0) && b.id !== s.batch_id);
  Object.assign(resolveForm, {
    id: s.id, shortage_no: s.shortage_no, customer_name: s.customer_name,
    qty_short: s.qty_short, qty_committed: s.qty_committed,
    resolution: 'substitute', substitute_batch_id: null, note: ''
  });
  modal.value = 'resolve';
}
async function saveResolve() {
  saving.value = true;
  try {
    await api.resolveSupplyShortage(resolveForm.id, {
      resolution: resolveForm.resolution, substitute_batch_id: resolveForm.substitute_batch_id, note: resolveForm.note
    });
    modal.value = '';
    await Promise.all([loadShortages(), loadOv(), loadHolds(), loadProj()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 路由 ---------------- */
async function loadOv() {
  ov.value = await api.supplyOverview();
}
function go(k) {
  tab.value = k;
  if (k === 'proj') loadProj();
  if (k === 'batch') loadBatches();
  if (k === 'booking') { loadRequests(); loadHolds(); }
  if (k === 'short') loadShortages();
}
async function reloadAll() {
  dict.value = await api.supplyDict();
  await loadOv();
  go(tab.value);
}

onMounted(async () => {
  dict.value = await api.supplyDict();
  await loadOv();
  await loadProj();
});
</script>

<style scoped>
.page { max-width: 1560px; }
.page-head .sub { max-width: 1000px; }
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
.nowrap { white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, Consolas, monospace; }
.lnk { color: var(--brand); cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.link-btn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.link-btn.danger { color: #d92d45; }
.empty-box { text-align: center; color: #9aa4b5; padding: 20px 0; font-size: 13px; }
.empty-cell { text-align: center; color: #9aa4b5; padding: 28px 0 !important; }
.row-bad { background: #fffafb; }
.row-warn { background: #fffdf7; }
.chk { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--ink-soft); white-space: nowrap; }
.hint-bar { background: #f2f7ff; border: 1px solid #d6e4ff; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; color: var(--ink); margin-bottom: 12px; line-height: 1.75; }
.hint-bar b { color: #16305f; }
.sec { margin: 18px 0 10px; font-size: 14px; color: var(--ink); }
.sec small { margin-left: 8px; font-size: 12px; color: #9aa4b5; font-weight: 400; }
/* 弹窗里的小标题说明别和标题粘在一起 */
.modal-body h4 { margin: 12px 0 8px; font-size: 13.5px; color: var(--ink); }
.modal-body h4 small { margin-left: 8px; font-size: 12px; color: #9aa4b5; font-weight: 400; }
.ex { max-width: 190px; line-height: 1.4; }
.pre { white-space: pre-line; }

.fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.fgrid label, .full { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-soft); }
.fgrid input, .fgrid select, .full input, .full select { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; color: var(--ink); }
.full { margin-top: 10px; }
.kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
.kv div { background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; }
.kv span { font-size: 12px; color: var(--ink-mute); display: block; }
.kv b { font-size: 15px; color: #16305f; display: block; margin-top: 3px; }
.kv b.sm { font-size: 13px; }
.kv small { font-size: 12px; color: #9aa4b5; display: block; margin-top: 3px; }
.tl { border-left: 2px solid #e8eef8; padding-left: 10px; }
.tl-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; flex-wrap: wrap; }

@media (max-width: 1180px) {
  .stat-row, .kv { grid-template-columns: repeat(3, 1fr); }
  .fgrid { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .stat-row, .kv { grid-template-columns: 1fr 1fr; }
  .head-ops { flex-wrap: wrap; }
}
</style>
