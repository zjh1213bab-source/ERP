<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>美仓作业计划</h2>
        <p class="sub">
          <b>一笔预留只能进一个未取消波次</b>（数据库唯一索引兜底），否则同一笔预留会被拣两次。
          拣货、复核、打包都<b>不扣库存</b>，<b>交承运那一刻才扣</b>并写库存流水；取消未拣直接释放，已拣的要先确认实物回位。
          库位结存 = <b>上架量 − 已交承运波次的拣出量</b>；头程 ETA 变更只提示受影响需求，<b>不自动改客户承诺</b>。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>待拣货行</span><strong>{{ (ov.waves && ov.waves.pending_items) || 0 }}</strong><small>已释放 / 拣货中</small></div>
      <div class="stat" :class="ov.waves && ov.waves.packed ? 'st-warn' : ''"><span>待交承运</span><strong>{{ (ov.waves && ov.waves.packed) || 0 }}</strong><small>已复核等提货</small></div>
      <div class="stat"><span>本月短拣</span><strong>{{ num(ov.waves && ov.waves.short_qty_month) }}</strong><small>件（已写原因）</small></div>
      <div class="stat" :class="ov.inbound && ov.inbound.delayed ? 'st-bad' : ''"><span>在途头程</span><strong>{{ (ov.inbound && ov.inbound.in_transit) || 0 }}</strong><small>延误 {{ (ov.inbound && ov.inbound.delayed) || 0 }} 单</small></div>
      <div class="stat" :class="ov.capacity && ov.capacity.near_full ? 'st-warn' : ''"><span>库位预警</span><strong>{{ (ov.capacity && ov.capacity.near_full) || 0 }}</strong><small>≥90% 或超容</small></div>
      <div class="stat"><span>库容占用</span><strong>{{ capPct }}%</strong><small>{{ num(ov.capacity && ov.capacity.used) }} / {{ num(ov.capacity && ov.capacity.capacity) }}</small></div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'wave' }" @click="go('wave')">拣货波次
          <span v-if="ov.waves && (ov.waves.released + ov.waves.picking)" class="tab-dot">{{ ov.waves.released + ov.waves.picking }}</span>
        </button>
        <button :class="{ on: tab === 'asn' }" @click="go('asn')">跨境头程
          <span v-if="ov.inbound && ov.inbound.delayed" class="tab-dot">{{ ov.inbound.delayed }}</span>
        </button>
        <button :class="{ on: tab === 'cap' }" @click="go('cap')">库容规划</button>
      </div>
    </div>

    <!-- ==================== 一、拣货波次 ==================== -->
    <div v-if="tab === 'wave'" class="block">
      <div class="hint-bar">
        波次从<b>有效现货占用</b>（或已上架批次的占用）生成，按库位排序拣货。复核必须<b>称重 + 唯一运单号</b>，
        有短拣必须写原因；<b>打印面单不等于交承运</b>，只有点「交承运」才出库。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="wf.status" @change="loadWaves">
          <option value="">全部状态</option>
          <option v-for="s in dict.wave_status || []" :key="s.k" :value="s.k">{{ s.v }}</option>
        </select>
        <div class="spacer"></div>
        <span class="muted tiny">共 {{ waves.length }} 条</span>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openCreateWave">＋ 生成波次</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>波次</th><th>状态</th><th class="num">行数</th><th class="num">件数</th><th class="num">已拣</th>
              <th class="num">短拣</th><th>承运 / 运单</th><th>时间</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="w in waves" :key="w.id" :class="{ 'row-warn': w.status === 'packed', 'row-bad': w.status === 'cancelled' }">
              <td><a class="lnk mono" @click="openWave(w.id)">{{ w.wave_no }}</a>
                <div class="tiny muted">{{ w.strategy === 'zone' ? '按库区顺序' : (w.strategy === 'order' ? '按订单顺序' : '手工选预留') }}</div></td>
              <td><span class="tag" :class="waveTag(w.status)">{{ w.status_label }}</span></td>
              <td class="num tiny">{{ w.item_cnt }}</td>
              <td class="num tiny">{{ num(w.qty_total) }}</td>
              <td class="num tiny">{{ num(w.qty_picked) }}<span v-if="w.unpicked" class="muted"> / 未拣 {{ num(w.unpicked) }}</span></td>
              <td class="num tiny" :class="{ red: w.short_qty }">{{ num(w.short_qty) }}</td>
              <td class="tiny nowrap">{{ w.carrier || '—' }}<div class="muted mono">{{ w.tracking_no || '—' }}</div></td>
              <td class="tiny mono nowrap">{{ shortTime(w.shipped_at || w.packed_at || w.released_at || w.created_at) }}</td>
              <td class="nowrap">
                <button class="link-btn" @click="openWave(w.id)">详情</button>
                <button v-if="canWrite && w.status === 'draft'" class="link-btn" @click="doRelease(w)">释放</button>
                <button v-if="canShip && w.status === 'packed'" class="link-btn" @click="doShip(w)">交承运</button>
                <button v-if="canShip && w.is_open" class="link-btn danger" @click="doCancel(w)">取消</button>
              </td>
            </tr>
            <tr v-if="!waves.length"><td colspan="9" class="empty-cell">没有波次</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 二、跨境头程 ==================== -->
    <div v-if="tab === 'asn'" class="block">
      <div class="hint-bar">
        头程只登记<b>运输事实</b>：段（ETD / ETA / 实际）、箱级短多错损。真实收货上架走「海外仓作业」，这里不改库存。
        箱级数量要<b>守恒</b>：实收 = 应到 − 短少 + 多到 − 破损；有差异必须写原因。改 ETA 必须写原因，并给出<b>受影响需求</b>（占用与待确认申请）。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="af.status" @change="loadAsns">
          <option value="">全部状态</option>
          <option value="in_transit">在途</option>
          <option value="arrived">已到仓</option>
          <option value="done">已收货</option>
        </select>
        <div class="spacer"></div>
        <span class="muted tiny">共 {{ asns.length }} 单</span>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>头程</th><th>承运 / 柜号</th><th>发运</th><th>预计到仓</th><th class="num">剩余</th>
              <th>运输段</th><th>箱差异</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="a in asns" :key="a.id" :class="{ 'row-bad': a.delayed }">
              <td><a class="lnk mono" @click="openAsn(a.id)">{{ a.asn_no }}</a>
                <div class="tiny muted">{{ a.warehouse }} ← {{ a.from_warehouse }}</div></td>
              <td class="tiny">{{ a.carrier || '—' }}<div class="muted mono">{{ a.container_no || '—' }}</div></td>
              <td class="tiny mono nowrap">{{ a.ship_date || '—' }}</td>
              <td class="tiny mono nowrap">{{ a.eta_effective || '—' }}</td>
              <td class="num tiny" :class="{ red: a.delayed, orange: a.due_soon }">
                {{ a.days_left === null ? '—' : (a.days_left < 0 ? '晚 ' + (-a.days_left) + ' 天' : a.days_left + ' 天') }}
              </td>
              <td class="tiny nowrap">{{ a.leg_cnt ? a.leg_arrived + '/' + a.leg_cnt + ' 段' : '未登记' }}</td>
              <td class="tiny nowrap">
                <span :class="{ red: a.short_qty_box, orange: a.damaged_qty_box }">短 {{ num(a.short_qty_box) }}</span>
                <span class="muted"> / 多 {{ num(a.over_qty_box) }}</span>
              </td>
              <td><span class="tag" :class="asnTag(a.status)">{{ asnLabel(a.status) }}</span></td>
              <td><button class="link-btn" @click="openAsn(a.id)">详情</button></td>
            </tr>
            <tr v-if="!asns.length"><td colspan="9" class="empty-cell">没有头程</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 三、库容规划 ==================== -->
    <div v-if="tab === 'cap'" class="block">
      <div class="hint-bar">
        库位占用 = <b>上架量 − 已交承运波次的拣出量</b>（两个都是既有账源，不再另建库存表）。
        接近 90% 标黄、超容标红；<b>上架建议只给放得下的库位</b>，放不下就明确拒绝，不让人先上架再发现超容。
      </div>

      <div class="sug-box">
        <div class="sug-title">上架建议<small>按「能放下的最小剩余」推荐，省大库位</small></div>
        <div class="sug-row">
          <label>数量<input v-model.number="sug.qty" type="number" min="1" /></label>
          <label>库区
            <select v-model="sug.zone">
              <option v-for="z in dict.zones || []" :key="z" :value="z">{{ z }}</option>
            </select>
          </label>
          <button class="btn btn-primary btn-sm" :disabled="sugging" @click="doSuggest">算一下</button>
        </div>
        <div v-if="sugResult" class="sug-result" :class="sugResult.blocked ? 'sug-no' : 'sug-ok'">
          <template v-if="sugResult.blocked">
            <b>放不下：</b>{{ sugResult.reason }}
          </template>
          <template v-else>
            <b>建议库位 {{ sugResult.location.code }}</b>（{{ sugResult.location.aisle || '' }}，剩余 {{ sugResult.free }}）
            <span class="tiny muted">· 备选 {{ (sugResult.candidates || []).length }} 个</span>
          </template>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>库位</th><th>库区</th><th>巷道</th><th class="num">容量</th><th class="num">已用</th>
              <th class="num">剩余</th><th>占用率</th><th class="num">SKU</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in caps" :key="l.id" :class="{ 'row-bad': l.anomaly, 'row-warn': l.near_full }">
              <td class="mono tiny nowrap">{{ l.code }}</td>
              <td class="tiny">{{ l.zone }}</td>
              <td class="tiny">{{ l.aisle || '—' }}</td>
              <td class="num tiny">{{ num(l.capacity) }}</td>
              <td class="num tiny">{{ num(l.used) }}</td>
              <td class="num tiny" :class="{ red: l.free < 0 }">{{ num(l.free) }}</td>
              <td>
                <div class="bar"><i :class="l.anomaly ? 'b-bad' : (l.near_full ? 'b-warn' : 'b-ok')" :style="{ width: Math.min(100, l.pct || 0) + '%' }"></i></div>
                <span class="tiny muted">{{ l.pct === null ? '未核定' : l.pct + '%' }}</span>
              </td>
              <td class="num tiny">{{ l.sku_cnt }}</td>
              <td>
                <span v-if="l.anomaly" class="tag red">超容</span>
                <span v-else-if="l.near_full" class="tag orange">接近满</span>
                <span v-else class="tag green">正常</span>
              </td>
            </tr>
            <tr v-if="!caps.length"><td colspan="9" class="empty-cell">没有库位</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 弹窗：生成波次 ==================== -->
    <div v-if="modal === 'create'" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head"><h3>生成拣货波次</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="hint-bar" style="margin-bottom: 12px">
            只列<b>现货占用</b>或<b>已上架批次</b>的占用；已在别的波次里、现货不足的会标出原因并不可选。
          </div>
          <div class="fgrid">
            <label>仓库
              <select v-model="cfg.warehouse">
                <option v-for="w in dict.warehouses || []" :key="w" :value="w">{{ w }}</option>
              </select>
            </label>
            <label>波次策略
              <select v-model="cfg.strategy">
                <option v-for="s in dict.strategies || []" :key="s.k" :value="s.k">{{ s.v }}</option>
              </select>
            </label>
            <label class="full">备注<input v-model="cfg.note" placeholder="例：下午 UPS 首班" /></label>
          </div>
          <h4 class="sec">可拣占用<small>勾选要进这一波次的预留</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th style="width: 42px"></th><th>预留</th><th>客户</th><th>SKU</th><th class="num">待拣</th>
                <th class="num">现货</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="c in candidates" :key="c.id" :class="{ 'row-bad': !c.pickable }">
                  <td><input v-model="cfg.hold_ids" type="checkbox" :value="c.id" :disabled="!c.pickable" /></td>
                  <td class="tiny mono nowrap">{{ c.hold_no }}</td>
                  <td class="tiny">{{ c.customer_name || '—' }}</td>
                  <td class="tiny nowrap">{{ c.style_no }} · {{ c.color || '—' }} · {{ c.size || '—' }}</td>
                  <td class="num tiny">{{ num(c.need) }}</td>
                  <td class="num tiny" :class="{ red: c.on_hand < c.need }">{{ num(c.on_hand) }}</td>
                  <td class="tiny muted">{{ c.blocked_reason || (c.batch_no ? '批次 ' + c.batch_no : '现货占用') }}</td>
                </tr>
                <tr v-if="!candidates.length"><td colspan="7" class="empty-cell">没有可拣的占用</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving || !cfg.hold_ids.length" @click="doCreateWave">生成</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：波次详情 ==================== -->
    <div v-if="modal === 'wave' && wave" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ wave.wave_no }}<span class="mono tiny" style="margin-left: 8px">{{ wave.status_label }}</span></h3>
          <button class="x" @click="closeModal">×</button>
        </div>
        <div class="modal-body">
          <div class="ob-meta">
            <span class="tag" :class="waveTag(wave.status)">{{ wave.status_label }}</span>
            <span class="tiny muted">{{ wave.warehouse }} · {{ wave.item_cnt }} 行 · {{ num(wave.qty_total) }} 件</span>
            <span v-if="wave.tracking_no" class="tag blue">{{ wave.carrier }} {{ wave.tracking_no }}</span>
            <span v-if="wave.package_weight" class="tiny muted">称重 {{ wave.package_weight }} kg</span>
            <span v-if="wave.shortfall" class="tag orange">短拣 {{ num(wave.shortfall) }} 件</span>
          </div>
          <div v-if="wave.short_reason" class="note-inline">短拣原因：{{ wave.short_reason }}</div>
          <div v-if="wave.cancel_reason" class="note-inline bad">取消原因：{{ wave.cancel_reason }}</div>

          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead>
                <tr><th class="num">序</th><th>库位</th><th>SKU</th><th class="num">应拣</th><th class="num">已拣</th>
                  <th class="num">短</th><th>状态</th><th>拣货</th></tr>
              </thead>
              <tbody>
                <tr v-for="it in wave.items" :key="it.id">
                  <td class="num tiny">{{ it.seq }}</td>
                  <td class="tiny mono nowrap">{{ it.loc_code || '—' }}
                    <div class="muted">{{ it.loc_source === 'capacity' ? '按容量分配' : (it.loc_source === 'manual' ? '手工指定' : '按库位结存') }}</div></td>
                  <td class="tiny nowrap">{{ it.style_no }} · {{ it.color || '—' }} · {{ it.size || '—' }}</td>
                  <td class="num tiny">{{ num(it.qty) }}</td>
                  <td class="num tiny">{{ num(it.qty_picked) }}</td>
                  <td class="num tiny" :class="{ red: it.qty_short }">{{ num(it.qty_short) }}</td>
                  <td><span class="tag" :class="itemTag(it.status)">{{ it.status_label }}</span></td>
                  <td class="nowrap">
                    <input v-if="canWrite && it.status === 'pending' && ['released','picking'].includes(wave.status)"
                      v-model.number="pickQty[it.id]" class="qty-in" type="number" min="1" :max="it.qty" />
                    <button v-if="canWrite && it.status === 'pending' && ['released','picking'].includes(wave.status)"
                      class="link-btn" @click="doPick(it)">拣</button>
                    <span v-else class="tiny muted">{{ it.picked_at ? shortTime(it.picked_at) : '—' }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="canWrite && ['released','picking'].includes(wave.status)" class="form-box">
            <div class="fb-title">复核称重<small>必须称重 + 唯一运单；有短拣要写原因</small></div>
            <div class="fgrid">
              <label>重量（kg）<input v-model.number="packForm.weight" type="number" step="0.1" min="0.1" /></label>
              <label>运单号<input v-model="packForm.tracking_no" placeholder="例：1Z-WHP-0009" /></label>
              <label>承运商<input v-model="packForm.carrier" placeholder="UPS / FedEx" /></label>
              <label class="full">短拣原因（有短拣时必填）<input v-model="packForm.short_reason" /></label>
            </div>
            <div style="margin-top: 8px">
              <button class="btn btn-primary btn-sm" :disabled="saving" @click="doPack">复核</button>
              <span class="tiny muted" style="margin-left: 8px">复核只打包，不扣库存；交承运才出库</span>
            </div>
          </div>

          <div v-if="canShip && wave.status === 'packed'" class="form-box">
            <div class="fb-title">交承运<small>这一刻才扣库存并收口占用</small></div>
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="doShip(wave)">确认交承运</button>
          </div>
        </div>
        <div class="modal-foot">
          <button v-if="isAdmin && wave.status === 'draft'" class="btn btn-ghost" style="color:#d92d45" @click="doDelete(wave)">删除草稿</button>
          <button class="btn btn-ghost" @click="closeModal">关闭</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：头程详情 ==================== -->
    <div v-if="modal === 'asn' && asn" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ asn.asn_no }}<span class="mono tiny" style="margin-left: 8px">{{ asn.carrier || '' }} {{ asn.container_no || '' }}</span></h3>
          <button class="x" @click="closeModal">×</button>
        </div>
        <div class="modal-body">
          <div class="ob-meta">
            <span class="tag" :class="asnTag(asn.status)">{{ asnLabel(asn.status) }}</span>
            <span class="tiny muted">发运 {{ asn.ship_date || '—' }} · 预计到仓 {{ asn.eta_date || '—' }}</span>
            <span v-if="asn.impacted" class="tag" :class="asn.impacted.cnt ? 'orange' : 'gray'">受影响需求 {{ asn.impacted.cnt }}</span>
          </div>

          <h4 class="sec">运输段<small>按顺序推进，上一段没到不能报下一段</small></h4>
          <div class="legs">
            <div v-for="l in asn.legs" :key="l.id" class="leg" :class="{ 'leg-done': l.status === 'arrived' }">
              <div class="leg-seq">{{ l.seq }}</div>
              <div class="leg-main">
                <b>{{ l.mode_label }}</b> <span class="muted tiny">{{ l.carrier || '—' }}</span>
                <div class="tiny">ETD {{ l.etd || '—' }} → ETA {{ l.eta || '—' }}
                  <span v-if="l.actual_at" class="green"> · 实际 {{ l.actual_at }}</span></div>
                <div v-if="l.note" class="tiny muted">{{ l.note }}</div>
              </div>
              <div class="leg-act">
                <span class="tag" :class="{ arrived: 'green', in_transit: 'blue', planned: 'gray' }[l.status]">{{ l.status_label }}</span>
                <button v-if="canWrite && l.status !== 'arrived'" class="link-btn" @click="doArrive(l)">登记到达</button>
              </div>
            </div>
            <div v-if="!asn.legs.length" class="empty-box">还没登记运输段</div>
          </div>
          <div v-if="canWrite" class="form-box">
            <div class="fb-title">加运输段<small>离港不能早于上一段到港</small></div>
            <div class="fgrid">
              <label>方式
                <select v-model="legForm.mode">
                  <option v-for="m in dict.modes || []" :key="m.k" :value="m.k">{{ m.v }}</option>
                </select>
              </label>
              <label>承运<input v-model="legForm.carrier" /></label>
              <label>ETD<input v-model="legForm.etd" type="date" /></label>
              <label>ETA<input v-model="legForm.eta" type="date" /></label>
              <label class="full">备注<input v-model="legForm.note" placeholder="例：洛杉矶港 → 安大略仓" /></label>
            </div>
            <button class="btn btn-primary btn-sm" style="margin-top: 8px" :disabled="saving" @click="doAddLeg">添加</button>
          </div>

          <h4 class="sec">箱级短多错损<small>实收 = 应到 − 短少 + 多到 − 破损</small></h4>
          <div class="table-wrap" style="box-shadow: none">
            <table class="data">
              <thead><tr><th>箱号</th><th>款号</th><th class="num">应到</th><th class="num">实收</th><th class="num">短少</th>
                <th class="num">多到</th><th class="num">破损</th><th>原因</th></tr></thead>
              <tbody>
                <tr v-for="bx in asn.boxes" :key="bx.id" :class="{ 'row-warn': bx.short_qty || bx.over_qty || bx.damaged_qty }">
                  <td class="mono tiny">{{ bx.carton_no }}</td>
                  <td class="tiny">{{ bx.style_no || '—' }}</td>
                  <td class="num tiny">{{ num(bx.expect_qty) }}</td>
                  <td class="num tiny">{{ num(bx.received_qty) }}</td>
                  <td class="num tiny" :class="{ red: bx.short_qty }">{{ num(bx.short_qty) }}</td>
                  <td class="num tiny" :class="{ orange: bx.over_qty }">{{ num(bx.over_qty) }}</td>
                  <td class="num tiny" :class="{ red: bx.damaged_qty }">{{ num(bx.damaged_qty) }}</td>
                  <td class="tiny muted wrap">{{ bx.reason || '—' }}</td>
                </tr>
                <tr v-if="!asn.boxes.length"><td colspan="8" class="empty-cell">还没有箱记录</td></tr>
              </tbody>
            </table>
          </div>
          <div v-if="canWrite" class="form-box">
            <div class="fb-title">登记箱<small>同一箱号重复提交为更新</small></div>
            <div class="fgrid">
              <label>箱号<input v-model="boxForm.carton_no" placeholder="C4" /></label>
              <label>款号<input v-model="boxForm.style_no" placeholder="WHP-DEMO-01" /></label>
              <label>应到<input v-model.number="boxForm.expect_qty" type="number" /></label>
              <label>实收<input v-model.number="boxForm.received_qty" type="number" /></label>
              <label>短少<input v-model.number="boxForm.short_qty" type="number" /></label>
              <label>多到<input v-model.number="boxForm.over_qty" type="number" /></label>
              <label>破损<input v-model.number="boxForm.damaged_qty" type="number" /></label>
              <label>原因<input v-model="boxForm.reason" placeholder="有差异必填" /></label>
            </div>
            <button class="btn btn-primary btn-sm" style="margin-top: 8px" :disabled="saving" @click="doAddBox">保存箱</button>
          </div>

          <h4 class="sec">改预计到仓<small>只提示受影响需求，不自动改客户承诺</small></h4>
          <div v-if="canWrite" class="form-box">
            <div class="fgrid">
              <label>新 ETA<input v-model="etaForm.eta_date" type="date" /></label>
              <label>原因<input v-model="etaForm.reason" placeholder="例：船期调整" /></label>
            </div>
            <div class="tiny muted" style="margin-top: 6px">
              当前受影响：有效占用 {{ asn.impacted ? asn.impacted.holds.length : 0 }} 条、待确认申请 {{ asn.impacted ? asn.impacted.requests.length : 0 }} 条
            </div>
            <button class="btn btn-ghost btn-sm" style="margin-top: 8px" :disabled="saving" @click="doChangeEta">提交变更</button>
          </div>

          <h4 class="sec" v-if="(asn.changes || []).length">变更留痕</h4>
          <div class="table-wrap" style="box-shadow: none" v-if="(asn.changes || []).length">
            <table class="data">
              <thead><tr><th>字段</th><th>原值</th><th>新值</th><th class="num">影响需求</th><th>原因</th><th>时间</th></tr></thead>
              <tbody>
                <tr v-for="c in asn.changes" :key="c.id">
                  <td class="tiny">{{ c.field === 'eta_date' ? '预计到仓' : c.field }}</td>
                  <td class="tiny mono">{{ c.from_value || '—' }}</td>
                  <td class="tiny mono">{{ c.to_value || '—' }}</td>
                  <td class="num tiny" :class="{ orange: c.impacted_cnt }">{{ c.impacted_cnt }}</td>
                  <td class="tiny muted">{{ c.reason || '—' }}</td>
                  <td class="tiny mono">{{ shortTime(c.created_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import { auth } from '../store/auth';

const tab = ref('wave');
const dict = ref({});
const ov = ref({});
const saving = ref(false);
const sugging = ref(false);
const modal = ref('');

const canWrite = computed(() => can('whplan.write'));
const canShip = computed(() => can('whplan.ship'));
const isAdmin = computed(() => (auth.user && auth.user.role) === 'admin');
const capPct = computed(() => {
  const c = ov.value.capacity || {};
  return c.capacity ? Math.round((Number(c.used || 0) / Number(c.capacity)) * 100) : 0;
});

const num = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const shortTime = (t) => (t ? String(t).slice(5, 16) : '—');
const waveTag = (s) => ({ draft: 'gray', released: 'blue', picking: 'purple', packed: 'orange', shipped: 'green', cancelled: 'red' }[s] || 'gray');
const itemTag = (s) => ({ pending: 'gray', picked: 'green', short: 'orange', cancelled: 'red' }[s] || 'gray');
const asnTag = (s) => ({ created: 'gray', in_transit: 'blue', arrived: 'green', receiving: 'orange', done: 'green', cancelled: 'red' }[s] || 'gray');
const asnLabel = (s) => ({ created: '待发运', in_transit: '在途', arrived: '已到仓', receiving: '收货中', done: '已收货', cancelled: '已取消' }[s] || s);

/* ---------------- 波次 ---------------- */
const waves = ref([]);
const wf = reactive({ status: '' });
const wave = ref(null);
const candidates = ref([]);
const cfg = reactive({ warehouse: 'us', strategy: 'zone', note: '', hold_ids: [] });
const pickQty = reactive({});
const packForm = reactive({ weight: '', tracking_no: '', carrier: 'UPS', short_reason: '' });

async function loadWaves() {
  waves.value = await api.whplanWaves({ ...wf });
}
async function openWave(id) {
  wave.value = await api.whplanWave(id);
  Object.keys(pickQty).forEach((k) => delete pickQty[k]);
  wave.value.items.forEach((it) => { pickQty[it.id] = it.qty; });
  packForm.weight = wave.value.package_weight || '';
  packForm.tracking_no = wave.value.tracking_no || '';
  packForm.carrier = wave.value.carrier || 'UPS';
  packForm.short_reason = wave.value.short_reason || '';
  modal.value = 'wave';
}
async function openCreateWave() {
  candidates.value = await api.whplanCandidates({ warehouse: cfg.warehouse });
  cfg.hold_ids = candidates.value.filter((c) => c.pickable).map((c) => c.id);
  cfg.note = '';
  modal.value = 'create';
}
async function doCreateWave() {
  saving.value = true;
  try {
    const r = await api.createWhplanWave({ warehouse: cfg.warehouse, strategy: cfg.strategy, note: cfg.note, hold_ids: cfg.hold_ids });
    await Promise.all([loadWaves(), loadOv()]);
    closeModal();
    if (r.skipped && r.skipped.length) {
      alert(`已生成 ${r.wave.wave_no}。\n以下占用没有进波次：\n` + r.skipped.map((s) => `· ${s.hold_no}：${s.reason}`).join('\n'));
    }
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function doRelease(w) {
  try { await api.releaseWhplanWave(w.id); await Promise.all([loadWaves(), loadOv()]); } catch (e) { alert(e.message); }
}
async function doPick(it) {
  try {
    wave.value = await api.pickWhplanItem(wave.value.id, it.id, { qty: pickQty[it.id] });
    await Promise.all([loadWaves(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doPack() {
  saving.value = true;
  try {
    wave.value = await api.packWhplanWave(wave.value.id, { ...packForm });
    await Promise.all([loadWaves(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function doShip(w) {
  if (!confirm(`确认 ${w.wave_no} 已交承运？\n这一刻才会扣库存并收口占用。`)) return;
  try {
    await api.shipWhplanWave(w.id);
    if (modal.value === 'wave') wave.value = await api.whplanWave(w.id);
    await Promise.all([loadWaves(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doCancel(w) {
  const reason = prompt('取消原因（必填）');
  if (!reason) return;
  const picked = Number(w.qty_picked || 0);
  const confirmReturn = picked > 0 ? confirm(`这个波次已拣 ${picked} 件，确认实物已回位？`) : true;
  if (picked > 0 && !confirmReturn) return;
  try {
    await api.cancelWhplanWave(w.id, { reason, confirm_return: confirmReturn });
    if (modal.value === 'wave') wave.value = await api.whplanWave(w.id);
    await Promise.all([loadWaves(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doDelete(w) {
  if (!confirm(`删除草稿 ${w.wave_no}？只有草稿能删。`)) return;
  try {
    await api.deleteWhplanWave(w.id);
    closeModal();
    await Promise.all([loadWaves(), loadOv()]);
  } catch (e) { alert(e.message); }
}

/* ---------------- 头程 ---------------- */
const asns = ref([]);
const af = reactive({ status: '' });
const asn = ref(null);
const legForm = reactive({ mode: 'ocean', carrier: '', etd: '', eta: '', note: '' });
const boxForm = reactive({ carton_no: '', style_no: '', expect_qty: 0, received_qty: 0, short_qty: 0, over_qty: 0, damaged_qty: 0, reason: '' });
const etaForm = reactive({ eta_date: '', reason: '' });

async function loadAsns() {
  asns.value = await api.whplanAsns({ ...af });
}
async function openAsn(id) {
  asn.value = await api.whplanAsn(id);
  legForm.etd = ''; legForm.eta = ''; legForm.note = ''; legForm.carrier = asn.value.carrier || '';
  Object.assign(boxForm, { carton_no: '', style_no: '', expect_qty: 0, received_qty: 0, short_qty: 0, over_qty: 0, damaged_qty: 0, reason: '' });
  etaForm.eta_date = asn.value.eta_date || '';
  etaForm.reason = '';
  modal.value = 'asn';
}
async function doAddLeg() {
  saving.value = true;
  try {
    await api.addWhplanLeg(asn.value.id, { ...legForm });
    asn.value = await api.whplanAsn(asn.value.id);
    await Promise.all([loadAsns(), loadOv()]);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function doArrive(l) {
  try {
    await api.arriveWhplanLeg(l.id, {});
    asn.value = await api.whplanAsn(asn.value.id);
    await Promise.all([loadAsns(), loadOv()]);
  } catch (e) { alert(e.message); }
}
async function doAddBox() {
  saving.value = true;
  try {
    await api.addWhplanBox(asn.value.id, { ...boxForm });
    asn.value = await api.whplanAsn(asn.value.id);
    await loadAsns();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function doChangeEta() {
  saving.value = true;
  try {
    const r = await api.changeWhplanEta(asn.value.id, { ...etaForm });
    asn.value = r.asn;
    await Promise.all([loadAsns(), loadOv()]);
    alert(`已改预计到仓 ${r.asn.eta_date}。受影响需求 ${r.impacted_cnt} 条，请人工确认是否要通知客户。`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 库容 ---------------- */
const caps = ref([]);
const sug = reactive({ qty: 30, zone: 'sellable' });
const sugResult = ref(null);

async function loadCaps() {
  caps.value = await api.whplanCapacity({});
}
async function doSuggest() {
  sugging.value = true;
  try {
    sugResult.value = await api.whplanSuggest({ warehouse: 'us', qty: sug.qty, zone: sug.zone });
  } catch (e) { alert(e.message); } finally { sugging.value = false; }
}

/* ---------------- 通用 ---------------- */
async function loadOv() {
  ov.value = await api.whplanOverview();
}
function closeModal() { modal.value = ''; }

async function go(k) {
  tab.value = k;
  if (k === 'wave') await loadWaves();
  if (k === 'asn') await loadAsns();
  if (k === 'cap') await loadCaps();
}
async function reloadAll() {
  await loadOv();
  if (tab.value === 'wave') await loadWaves();
  if (tab.value === 'asn') await loadAsns();
  if (tab.value === 'cap') await loadCaps();
}

onMounted(async () => {
  dict.value = await api.whplanDict();
  await loadOv();
  await loadWaves();
});
</script>

<style scoped>
.page { max-width: 1560px; }
.page-head .sub { max-width: 1040px; }
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
.orange { color: #d97706; }
.nowrap { white-space: nowrap; }
.wrap { word-break: break-word; }
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, Consolas, monospace; }
.lnk { color: var(--brand); cursor: pointer; font-weight: 600; }
.lnk:hover { text-decoration: underline; }
.link-btn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 12.5px; padding: 2px 4px; font-family: inherit; }
.link-btn.danger { color: #d92d45; }
.empty-cell { text-align: center; color: #9aa4b5; padding: 28px 0 !important; }
.empty-box { text-align: center; color: #9aa4b5; padding: 16px 0; font-size: 13px; }
.row-bad { background: #fffafb; }
.row-warn { background: #fffdf7; }
.tag { white-space: nowrap; }
.sec { margin: 16px 0 8px; font-size: 13.5px; color: var(--ink); }
.sec small { margin-left: 8px; font-size: 12px; color: #9aa4b5; font-weight: 400; }
.ob-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.note-inline { background: #fffdf7; border: 1px solid #f3dcb6; border-radius: 9px; padding: 8px 12px; font-size: 12.5px; color: #6b5a3b; margin-bottom: 10px; }
.note-inline.bad { background: #fffafb; border-color: #f3c2c9; color: #8a3b46; }

.qty-in { width: 68px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; font-family: inherit; }
.form-box { margin-top: 14px; border-top: 1px dashed #e8edf6; padding-top: 12px; }
.fb-title { font-size: 13px; color: var(--ink); font-weight: 700; margin-bottom: 8px; }
.fb-title small { margin-left: 8px; font-size: 12px; color: #9aa4b5; font-weight: 400; }
.form-box .fgrid label { font-size: 12px; }

.sug-box { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
.sug-title { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 8px; }
.sug-title small { margin-left: 8px; font-size: 12px; color: #9aa4b5; font-weight: 400; }
.sug-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.sug-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-soft); }
.sug-row input, .sug-row select { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; width: 140px; }
.sug-result { margin-top: 10px; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; }
.sug-ok { background: #f6fdf9; border: 1px solid #cfe9d8; color: #1f5134; }
.sug-no { background: #fffafb; border: 1px solid #f3c2c9; color: #8a3b46; }

.bar { height: 6px; background: #eef1f6; border-radius: 4px; overflow: hidden; width: 96px; }
.bar i { display: block; height: 100%; border-radius: 4px; }
.b-ok { background: #34a853; }
.b-warn { background: #f2a33c; }
.b-bad { background: #d92d45; }

.legs { display: flex; flex-direction: column; gap: 8px; }
.leg { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--surface-2); }
.leg-done { background: #f6fdf9; border-color: #cfe9d8; }
.leg-seq { width: 22px; height: 22px; border-radius: 50%; background: #e8f0ff; color: var(--brand); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.leg-main { flex: 1; font-size: 12.5px; color: var(--ink); }
.leg-act { display: flex; align-items: center; gap: 6px; flex: none; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .head-ops { flex-wrap: wrap; justify-content: flex-end; }
  .sug-row { flex-direction: column; align-items: stretch; }
  .sug-row input, .sug-row select { width: 100%; }
  .leg { flex-wrap: wrap; }
}
</style>
