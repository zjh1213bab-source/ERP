<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>海外仓作业</h2>
        <p class="sub">
          美仓三件事：<b>柜到仓要上架才可售</b>（点收数量必须守恒：预报 = 实收 + 破损 + 短少，
          差额要写原因）；<b>套装与单品库存分开</b>（套装存独立库，组装扣组件、拆分回组件）；
          <b>运费按费率算出来再和账单比</b>（没有费率的承运商不出系统金额，不拿 0 元当基准）。
          库位只记「上架到哪」用于找货，不做逐单扣减。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-action="['wh','create']" v-if="canWrite && tab === 'asn'" class="btn btn-primary" @click="openAsnForm">＋ 新建发运单</button>
        <button v-action="['wh','create']" v-if="canWrite && tab === 'bundle'" class="btn btn-primary" @click="openBundleForm">＋ 新建套装</button>
        <button v-action="['wh','create']" v-if="canWrite && tab === 'loc'" class="btn btn-primary" @click="openLocForm()">＋ 新建库位</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>在途柜 / 件</span><strong>{{ board.stat.asn_in_transit || 0 }}</strong><small>{{ board.stat.asn_in_transit_qty || 0 }} 件在海上</small></div>
      <div class="stat"><span>待上架</span><strong :class="board.stat.receiving ? 'amt-orange' : ''">{{ board.stat.receiving || 0 }}</strong><small>点收完还没进库</small></div>
      <div class="stat"><span>可售库存</span><strong>{{ board.stat.sellable_qty || 0 }}</strong><small>已上架到可售区</small></div>
      <div class="stat"><span>套装库存</span><strong>{{ board.stat.bundle_qty || 0 }}</strong><small>与单品分开计</small></div>
      <div class="stat"><span>短少 / 破损</span><strong :class="(board.stat.short_qty || board.stat.damaged_qty) ? 'amt-red' : ''">{{ board.stat.short_qty || 0 }} / {{ board.stat.damaged_qty || 0 }}</strong><small>累计到仓差异</small></div>
      <div class="stat"><span>运费待核</span><strong :class="board.stat.freight_diff_cnt ? 'amt-orange' : ''">{{ board.stat.freight_diff_cnt || 0 }}</strong><small>差异 ${{ fmt(board.stat.freight_diff_amt) }}</small></div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'asn' }" @click="go('asn')">到仓与上架</button>
        <button :class="{ on: tab === 'loc' }" @click="go('loc')">库位与库存</button>
        <button :class="{ on: tab === 'bundle' }" @click="go('bundle')">套装拆组</button>
        <button :class="{ on: tab === 'freight' }" @click="go('freight')">运费核对</button>
      </div>
      <template v-if="tab === 'asn'">
        <select class="select" v-model="asnStatus" style="width: 130px" @change="loadAsns">
          <option value="all">全部状态</option>
          <option v-for="s in dict.asn_status" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </template>
      <template v-if="tab === 'freight'">
        <select class="select" v-model="billStatus" style="width: 130px" @change="loadBills">
          <option value="all">全部账单</option>
          <option value="pending">待核对</option>
          <option value="disputed">有争议</option>
          <option value="matched">已核平</option>
          <option value="settled">已结算</option>
        </select>
      </template>
    </div>

    <!-- ==================== 一、到仓与上架 ==================== -->
    <div v-if="tab === 'asn'">
      <div class="block">
        <h4>集货发运单<small>草稿 → 发运 → 到仓 → 点收 → 上架完成</small></h4>
        <div v-if="!asns.length" class="empty-cell">还没有发运单。先「新建发运单」把这一柜的预报明细录进去。</div>
        <div v-else class="table-wrap">
          <table class="asn-tbl">
            <thead>
              <tr>
                <th style="width: 148px">发运单号</th>
                <th style="width: 108px">柜号</th>
                <th style="width: 86px">船司</th>
                <th style="width: 90px">发运日</th>
                <th style="width: 90px">预计到仓</th>
                <th style="width: 84px" class="num">预报件数</th>
                <th style="width: 74px" class="num">实收</th>
                <th style="width: 80px" class="num">差</th>
                <th style="width: 110px">状态</th>
                <th style="width: 236px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in asns" :key="a.id" :class="{ 'row-warn': a.status === 'receiving' }">
                <td class="mono">{{ a.asn_no }}</td>
                <td class="mono tiny">{{ a.container_no || '—' }}</td>
                <td class="tiny">{{ a.carrier || '—' }}</td>
                <td class="tiny">{{ a.ship_date || '—' }}</td>
                <td class="tiny">{{ a.eta_date || '—' }}</td>
                <td class="num">{{ a.expect_qty }}</td>
                <td class="num">{{ a.received_qty || 0 }}</td>
                <td class="num" :class="a.short_qty || a.over_qty ? 'amt-red' : ''">
                  {{ a.short_qty ? '-' + a.short_qty : a.over_qty ? '+' + a.over_qty : '0' }}
                </td>
                <td><span class="pill" :class="'st-' + a.status">{{ a.status_label }}</span></td>
                <td class="ops">
                  <button v-if="canWrite && a.status === 'draft'" class="btn btn-primary btn-sm" @click="doShip(a)">发运</button>
                  <button v-if="canWrite && ['in_transit','arrived'].includes(a.status) && !a.rcv_count"
                    class="btn btn-primary btn-sm" @click="openReceive(a)">点收</button>
                  <button class="btn btn-ghost btn-sm" @click="viewAsn(a)">明细</button>
                  <button v-if="canWrite && ['draft','in_transit','arrived'].includes(a.status)"
                    class="btn btn-ghost btn-sm" @click="doCancel(a)">取消</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="block">
        <h4>点收单 · 待上架<small>点收完了不等于能卖，得上架到可售区才进库存</small></h4>
        <div v-if="!receipts.length" class="empty-cell">没有点收单。</div>
        <div v-else class="table-wrap">
          <table class="rcv-tbl">
            <thead>
              <tr>
                <th style="width: 150px">点收单号</th>
                <th style="width: 150px">来源发运单</th>
                <th style="width: 96px">到仓日</th>
                <th style="width: 80px" class="num">实收</th>
                <th style="width: 80px" class="num">破损</th>
                <th style="width: 80px" class="num">短少</th>
                <th style="width: 90px" class="num">已上架</th>
                <th style="width: 90px" class="num">待上架</th>
                <th style="width: 200px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in receipts" :key="r.id" :class="{ 'row-warn': r.to_put > 0 }">
                <td class="mono">{{ r.rcv_no }}</td>
                <td class="mono tiny">{{ r.asn_no }}</td>
                <td class="tiny">{{ r.arrive_date || '—' }}</td>
                <td class="num">{{ r.received_qty }}</td>
                <td class="num" :class="r.damaged_qty ? 'amt-orange' : ''">{{ r.damaged_qty }}</td>
                <td class="num" :class="r.short_qty ? 'amt-red' : ''">{{ r.short_qty }}</td>
                <td class="num">{{ r.put_qty || 0 }}</td>
                <td class="num"><b :class="r.to_put > 0 ? 'amt-orange' : 'amt-green'">{{ r.to_put }}</b></td>
                <td class="ops">
                  <button v-if="canWrite && r.to_put > 0" class="btn btn-primary btn-sm" @click="openPutaway(r)">上架</button>
                  <span v-if="r.to_put <= 0" class="ok-txt">已上完</span>
                  <button class="btn btn-ghost btn-sm" @click="viewReceipt(r)">明细</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 二、库位与库存 ==================== -->
    <div v-else-if="tab === 'loc'">
      <div class="block">
        <h4>库位<small>上架时的落位记录，用于找货；不做逐单扣减</small></h4>
        <div class="loc-grid">
          <div v-for="l in locations" :key="l.id" class="loc-card" :class="'z-' + l.zone">
            <div class="loc-head">
              <b class="mono">{{ l.code }}</b>
              <span class="pill" :class="'z-' + l.zone">{{ l.zone_label }}</span>
              <span v-if="l.status === 'locked'" class="pill pill-lock">已锁定</span>
            </div>
            <div class="loc-body">
              <div><span>上架累计</span><b>{{ l.put_qty }}</b></div>
              <div><span>涉及 SKU</span><b>{{ l.sku_count }}</b></div>
            </div>
            <div class="tiny muted">{{ l.aisle || '—' }}<span v-if="l.capacity"> · 容量 {{ l.capacity }}</span></div>
            <div class="loc-ops" v-if="canWrite">
              <button class="btn btn-ghost btn-sm" @click="toggleLoc(l)">{{ l.status === 'locked' ? '解锁' : '锁定' }}</button>
            </div>
          </div>
        </div>
        <div v-if="!locations.length" class="empty-cell">还没有库位。先「新建库位」，至少要有 1 个可售区。</div>
      </div>

      <div class="block">
        <h4>美仓可售库存<small>只有上架到「可售区」的量才会出现在这里</small></h4>
        <div v-if="!usStock.length" class="empty-cell">美仓还没有可售库存。</div>
        <div v-else class="table-wrap">
          <table class="stock-tbl">
            <thead>
              <tr>
                <th>款号</th><th>品名</th><th style="width: 100px">颜色</th>
                <th style="width: 80px">尺码</th><th style="width: 100px" class="num">可售数量</th>
                <th style="width: 140px">更新时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in usStock" :key="s.id">
                <td class="mono">{{ s.style_no }}</td>
                <td class="wrap">{{ s.product_name }}</td>
                <td class="tiny">{{ s.color || '—' }}</td>
                <td class="tiny">{{ s.size || '—' }}</td>
                <td class="num"><b>{{ s.qty }}</b></td>
                <td class="tiny muted">{{ $fmt(s.updated_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 三、套装拆组 ==================== -->
    <div v-else-if="tab === 'bundle'">
      <div class="bundle-grid">
        <div v-for="b in bundles" :key="b.id" class="bundle-card">
          <div class="bd-head">
            <div>
              <b>{{ b.name }}</b>
              <div class="rule-code">{{ b.bundle_sku }}</div>
            </div>
            <span v-if="b.status === 'disabled'" class="pill pill-lock">已停用</span>
          </div>
          <div class="bd-stat">
            <div><span>套装库存</span><b>{{ b.stock_qty }}</b></div>
            <div><span>可组装</span><b :class="b.can_kit > 0 ? 'amt-green' : 'amt-orange'">{{ b.can_kit }}</b></div>
            <div><span>售价</span><b>${{ fmt(b.sale_price) }}</b></div>
          </div>
          <table class="bd-tbl">
            <thead><tr><th>组件</th><th style="width: 70px" class="num">单套用量</th><th style="width: 70px" class="num">现有</th><th style="width: 70px" class="num">可组</th></tr></thead>
            <tbody>
              <tr v-for="i in b.items" :key="i.id" :class="{ 'row-warn': i.max_kits === 0 }">
                <td class="tiny">
                  <span class="mono">{{ i.style_no }}</span>
                  <span class="variant"> · {{ i.color || '-' }}/{{ i.size || '-' }}</span>
                </td>
                <td class="num">{{ i.qty_per }}</td>
                <td class="num" :class="i.stock < i.qty_per ? 'amt-red' : ''">{{ i.stock }}</td>
                <td class="num">{{ i.max_kits }}</td>
              </tr>
            </tbody>
          </table>
          <div class="bd-ops" v-if="canWrite">
            <button class="btn btn-primary btn-sm" :disabled="b.can_kit <= 0" @click="openKit(b, 'kit')">组装</button>
            <button class="btn btn-ghost btn-sm" :disabled="b.stock_qty <= 0" @click="openKit(b, 'unbundle')">拆分</button>
            <button class="btn btn-ghost btn-sm" @click="toggleBundle(b)">{{ b.status === 'active' ? '停用' : '启用' }}</button>
          </div>
        </div>
      </div>
      <div v-if="!bundles.length" class="empty-cell">还没有套装定义。套装编码要用独立编码，不能和单品款号重复。</div>

      <div class="block">
        <h4>组装 / 拆分记录</h4>
        <div v-if="!bundleOps.length" class="empty-cell">还没有操作记录。</div>
        <div v-else class="table-wrap">
          <table class="ops-tbl">
            <thead>
              <tr>
                <th style="width: 140px">单号</th><th style="width: 90px">类型</th>
                <th style="width: 150px">套装</th><th style="width: 80px" class="num">数量</th>
                <th style="width: 110px" class="num">操作前</th><th style="width: 110px" class="num">操作后</th>
                <th>备注</th><th style="width: 120px">时间</th><th style="width: 90px">操作人</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in bundleOps" :key="o.id">
                <td class="mono">{{ o.op_no }}</td>
                <td><span class="pill" :class="o.type === 'kit' ? 'st-done' : 'st-arrived'">{{ o.type_label }}</span></td>
                <td class="tiny">{{ o.bundle_sku }}</td>
                <td class="num">{{ o.qty }}</td>
                <td class="num muted">{{ o.before_qty }}</td>
                <td class="num"><b>{{ o.after_qty }}</b></td>
                <td class="wrap tiny">{{ o.remark || '—' }}</td>
                <td class="tiny muted">{{ $fmt(o.created_at).slice(5) }}</td>
                <td class="tiny">{{ o.operator || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 四、运费核对 ==================== -->
    <div v-else-if="tab === 'freight'">
      <p class="hint-bar">
        核对口径：按运单号找系统发货记录 → 用费率表（首重 + 续重 + 燃油）算出系统应付 →
        与账单金额比。<b>查不到运单记「无此单」</b>（可能是别家的单混进来），
        <b>计费重比实重高 5% 以上记「重量差」</b>，<b>系统有发货但账单没列记「漏计费」</b>。
        有未处理差异的账单不能结算。
      </p>
      <div v-if="!bills.length" class="empty-cell">还没有账单。</div>
      <div v-else class="table-wrap">
        <table class="bill-tbl">
          <thead>
            <tr>
              <th style="width: 130px">账单号</th>
              <th style="width: 96px">承运商</th>
              <th style="width: 170px">账期</th>
              <th style="width: 100px" class="num">账单金额</th>
              <th style="width: 100px" class="num">系统应付</th>
              <th style="width: 100px" class="num">差额</th>
              <th style="width: 80px" class="num">明细</th>
              <th style="width: 80px" class="num">差异</th>
              <th style="width: 86px">状态</th>
              <th style="width: 150px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in bills" :key="b.id" :class="{ 'row-warn': b.status === 'disputed' }">
              <td class="mono">{{ b.bill_no }}</td>
              <td class="tiny">{{ b.carrier }}</td>
              <td class="tiny">{{ b.period_from || '—' }} ~ {{ b.period_to || '—' }}</td>
              <td class="num">${{ fmt(b.total_amount) }}</td>
              <td class="num">${{ fmt(b.sys_amount) }}</td>
              <td class="num" :class="Math.abs(b.diff_amount) > 0.01 ? 'amt-red' : ''">${{ fmt(b.diff_amount) }}</td>
              <td class="num">{{ b.item_count }}</td>
              <td class="num" :class="b.diff_count ? 'amt-orange' : ''">{{ b.diff_count }}</td>
              <td><span class="pill" :class="'st-' + b.status">{{ billLabel(b.status) }}</span></td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openBill(b)">看明细</button>
                <button v-if="canWrite && b.status !== 'settled'" class="btn btn-ghost btn-sm" @click="doMatch(b)">重新核对</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="block">
        <h4>运费费率<small>系统应付金额的唯一基准；没有费率的承运商不出系统金额</small></h4>
        <div v-if="!rates.length" class="empty-cell">还没有费率。没有费率时账单只能标「无费率基准」，不能算差额。</div>
        <div v-else class="table-wrap">
          <table class="rate-tbl">
            <thead>
              <tr>
                <th style="width: 110px">承运商</th><th style="width: 100px">分区</th>
                <th style="width: 100px" class="num">首重 kg</th><th style="width: 110px" class="num">首重价</th>
                <th style="width: 110px" class="num">续重步长</th><th style="width: 110px" class="num">续重价</th>
                <th style="width: 100px" class="num">燃油</th><th style="width: 120px">生效日</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rates" :key="r.id">
                <td>{{ r.carrier }}</td>
                <td class="tiny">{{ r.zone }}</td>
                <td class="num">{{ r.first_weight }}</td>
                <td class="num">${{ fmt(r.first_price) }}</td>
                <td class="num">{{ r.add_weight }}</td>
                <td class="num">${{ fmt(r.add_price) }}</td>
                <td class="num">{{ r.fuel_pct }}%</td>
                <td class="tiny muted">{{ r.effective_from || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：新建发运单 ==================== -->
    <div v-if="asnForm" class="modal-mask">
      <div class="modal wide">
        <h3>新建集货发运单</h3>
        <div class="form-grid">
          <label class="fld"><span>柜号</span><input v-model="asnForm.container_no" placeholder="MATU7701234" /></label>
          <label class="fld"><span>船司</span><input v-model="asnForm.carrier" placeholder="Matson" /></label>
          <label class="fld"><span>发运日期</span><input v-model="asnForm.ship_date" type="date" /></label>
          <label class="fld"><span>预计到仓</span><input v-model="asnForm.eta_date" type="date" /></label>
          <label class="fld"><span>计划箱数</span><input v-model.number="asnForm.carton_plan" type="number" min="0" /></label>
        </div>
        <div class="line-head">
          <b>预报明细</b>
          <button class="btn btn-ghost btn-sm" @click="addAsnLine">＋ 加一行</button>
        </div>
        <table class="line-tbl">
          <thead><tr><th>款号</th><th>品名</th><th style="width: 86px">颜色</th><th style="width: 76px">尺码</th><th style="width: 96px">数量</th><th style="width: 110px">箱号</th><th style="width: 44px"></th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in asnForm.items" :key="i">
              <td><input v-model="l.style_no" class="cell-in" placeholder="LEJE-SY-001" /></td>
              <td><input v-model="l.product_name" class="cell-in" placeholder="品名" /></td>
              <td><input v-model="l.color" class="cell-in" /></td>
              <td><input v-model="l.size" class="cell-in" /></td>
              <td><input v-model.number="l.expect_qty" class="cell-in num" type="number" min="1" /></td>
              <td><input v-model="l.carton_no" class="cell-in" placeholder="C01-C06" /></td>
              <td><button class="btn btn-ghost btn-sm" @click="asnForm.items.splice(i, 1)">×</button></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="asnForm = null">取消</button>
          <button class="btn btn-primary" @click="submitAsn">创建</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：点收 ==================== -->
    <div v-if="rcvModal" class="modal-mask">
      <div class="modal wide">
        <h3>到仓点收 · {{ rcvModal.asn.asn_no }}</h3>
        <p class="tiny muted" style="margin-bottom: 10px">
          预报 {{ rcvModal.asn.expect_qty }} 件。实收 + 破损 与预报不一致时必须写原因，否则不让提交。
        </p>
        <div class="form-grid">
          <label class="fld"><span>到仓日期</span><input v-model="rcvModal.arrive_date" type="date" /></label>
          <label class="fld"><span>实际箱数</span><input v-model.number="rcvModal.carton_actual" type="number" min="0" /></label>
          <label class="fld"><span>整单备注</span><input v-model="rcvModal.note" placeholder="如：少一个外箱" /></label>
        </div>
        <table class="line-tbl">
          <thead>
            <tr>
              <th style="width: 200px">款号 / 色码</th><th style="width: 76px" class="num">预报</th>
              <th style="width: 96px">实收</th><th style="width: 92px">破损</th>
              <th style="width: 64px" class="num">差</th>
              <th>差异原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in rcvModal.lines" :key="l.asn_item_id">
              <td class="tiny">
                <span class="mono">{{ l.style_no }}</span>
                <span class="muted"> {{ l.color || '-' }}/{{ l.size || '-' }}</span>
              </td>
              <td class="num">{{ l.expect_qty }}</td>
              <td><input v-model.number="l.received_qty" class="cell-in num" type="number" min="0" /></td>
              <td><input v-model.number="l.damaged_qty" class="cell-in num" type="number" min="0" /></td>
              <td class="num" :class="lineDiff(l) ? 'amt-red' : 'amt-green'">{{ lineDiff(l) }}</td>
              <td><input v-model="l.diff_reason" class="cell-in" :placeholder="lineDiff(l) ? '必填' : '—'" /></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="rcvModal = null">取消</button>
          <button class="btn btn-primary" @click="submitReceive">确认点收</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：上架 ==================== -->
    <div v-if="putModal" class="modal-mask">
      <div class="modal wide">
        <h3>上架 · {{ putModal.receipt.rcv_no }}</h3>
        <p class="tiny muted" style="margin-bottom: 10px">
          只有上架到<b>可售区</b>的数量才进美仓可售库存；破损区、待检区只记位置不进可售。
        </p>
        <table class="line-tbl">
          <thead>
            <tr>
              <th>款号 / 色码</th><th style="width: 84px" class="num">待上架</th>
              <th style="width: 150px">库位</th><th style="width: 96px">本次数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in putModal.lines" :key="l.id">
              <td class="tiny">
                <span class="mono">{{ l.style_no }}</span>
                <span class="muted"> {{ l.color || '-' }}/{{ l.size || '-' }}</span>
              </td>
              <td class="num">{{ l.to_put }}</td>
              <td>
                <select v-model="l.location_code" class="cell-in">
                  <option v-for="o in putModal.locations" :key="o.id" :value="o.code">
                    {{ o.code }} · {{ o.zone_label }}
                  </option>
                </select>
              </td>
              <td><input v-model.number="l.qty" class="cell-in num" type="number" min="0" :max="l.to_put" /></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="putModal = null">取消</button>
          <button class="btn btn-primary" @click="submitPutaway">确认上架</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：组装 / 拆分 ==================== -->
    <div v-if="kitModal" class="modal-mask">
      <div class="modal">
        <h3>{{ kitModal.type === 'kit' ? '组装套装' : '拆分套装' }} · {{ kitModal.bundle.bundle_sku }}</h3>
        <p class="tiny muted" style="margin-bottom: 10px">
          <template v-if="kitModal.type === 'kit'">
            最多可组装 <b>{{ kitModal.bundle.can_kit }}</b> 套（受最少组件限制）。
            组件会从可售库存扣走，扣完直接进套装库存。
          </template>
          <template v-else>
            当前套装库存 <b>{{ kitModal.bundle.stock_qty }}</b> 套。拆分会把组件按单套用量退回可售库存。
          </template>
        </p>
        <label class="fld"><span>数量（套）</span><input v-model.number="kitModal.qty" type="number" min="1" /></label>
        <label class="fld"><span>备注</span><input v-model="kitModal.remark" placeholder="选填" /></label>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="kitModal = null">取消</button>
          <button class="btn btn-primary" @click="submitKit">确认{{ kitModal.type === 'kit' ? '组装' : '拆分' }}</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：新建套装 ==================== -->
    <div v-if="bundleForm" class="modal-mask">
      <div class="modal wide">
        <h3>新建套装</h3>
        <div class="form-grid">
          <label class="fld"><span>套装编码（不能与单品款号重复）</span><input v-model="bundleForm.bundle_sku" placeholder="SET-2026-01" /></label>
          <label class="fld"><span>名称</span><input v-model="bundleForm.name" placeholder="基础长裤双件套" /></label>
          <label class="fld"><span>售价</span><input v-model.number="bundleForm.sale_price" type="number" min="0" step="0.01" /></label>
        </div>
        <div class="line-head">
          <b>组件</b>
          <button class="btn btn-ghost btn-sm" @click="bundleForm.items.push({ style_no: '', product_name: '', color: '', size: '', qty_per: 1 })">＋ 加一行</button>
        </div>
        <table class="line-tbl">
          <thead><tr><th>款号</th><th>品名</th><th style="width: 86px">颜色</th><th style="width: 76px">尺码</th><th style="width: 100px">单套用量</th><th style="width: 44px"></th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in bundleForm.items" :key="i">
              <td><input v-model="l.style_no" class="cell-in" placeholder="LEJE-TZ-002" /></td>
              <td><input v-model="l.product_name" class="cell-in" /></td>
              <td><input v-model="l.color" class="cell-in" /></td>
              <td><input v-model="l.size" class="cell-in" /></td>
              <td><input v-model.number="l.qty_per" class="cell-in num" type="number" min="1" /></td>
              <td><button class="btn btn-ghost btn-sm" @click="bundleForm.items.splice(i, 1)">×</button></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="bundleForm = null">取消</button>
          <button class="btn btn-primary" @click="submitBundle">创建</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：新建库位 ==================== -->
    <div v-if="locForm" class="modal-mask">
      <div class="modal">
        <h3>新建库位</h3>
        <div class="form-grid">
          <label class="fld"><span>库位编码</span><input v-model="locForm.code" placeholder="US-A-03" /></label>
          <label class="fld">
            <span>库区类型</span>
            <select v-model="locForm.zone">
              <option v-for="z in dict.zones" :key="z.value" :value="z.value">{{ z.label }}</option>
            </select>
          </label>
          <label class="fld"><span>区/通道说明</span><input v-model="locForm.aisle" placeholder="A 区快出" /></label>
          <label class="fld"><span>容量（件）</span><input v-model.number="locForm.capacity" type="number" min="0" /></label>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="locForm = null">取消</button>
          <button class="btn btn-primary" @click="submitLoc">创建</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：账单明细 ==================== -->
    <div v-if="billModal" class="modal-mask">
      <div class="modal xxwide">
        <div class="bill-head">
          <div>
            <h3 style="margin: 0">{{ billModal.bill.bill_no }} · {{ billModal.bill.carrier }}</h3>
            <p class="tiny muted" style="margin: 4px 0 0">
              账期 {{ billModal.bill.period_from }} ~ {{ billModal.bill.period_to }} ·
              账单 ${{ fmt(billModal.bill.total_amount) }} ·
              系统 ${{ fmt(billModal.bill.sys_amount) }} ·
              差异 <b class="amt-red">${{ fmt(billModal.bill.diff_amount) }}</b>
            </p>
          </div>
          <div class="bill-ops">
            <button v-if="canWrite && billModal.bill.status !== 'settled'" class="btn btn-ghost btn-sm" @click="doMatch(billModal.bill)">重新核对</button>
            <button v-if="canWrite && billModal.bill.status !== 'settled'" class="btn btn-primary btn-sm" @click="doSettle(billModal.bill)">结算</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height: 52vh; overflow: auto">
          <table class="fi-tbl">
            <thead>
              <tr>
                <th style="width: 146px">运单号</th>
                <th style="width: 52px">订单</th>
                <th style="width: 78px">发货日</th>
                <th style="width: 68px">分区</th>
                <th style="width: 64px" class="num">计费重</th>
                <th style="width: 60px" class="num">实重</th>
                <th style="width: 76px" class="num">账单</th>
                <th style="width: 76px" class="num">系统</th>
                <th style="width: 76px" class="num">差额</th>
                <th style="width: 84px">类型</th>
                <th>说明</th>
                <th style="width: 142px">处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in billModal.items" :key="i.id" :class="{ 'row-warn': ['amount','weight','missing'].includes(i.diff_type) }">
                <td class="mono tiny">{{ i.tracking_no }}</td>
                <td class="tiny">{{ i.order_id || '—' }}</td>
                <td class="tiny">{{ i.ship_date || '—' }}</td>
                <td class="tiny">{{ i.zone || '—' }}</td>
                <td class="num">{{ i.weight || '—' }}</td>
                <td class="num">{{ i.act_weight || '—' }}</td>
                <td class="num">{{ i.bill_amount ? '$' + fmt(i.bill_amount) : '—' }}</td>
                <td class="num">{{ i.sys_amount ? '$' + fmt(i.sys_amount) : '—' }}</td>
                <td class="num" :class="Math.abs(i.diff) > 0.01 ? 'amt-red' : ''">{{ i.diff ? '$' + fmt(i.diff) : '—' }}</td>
                <td><span class="pill" :class="'dt-' + i.diff_type">{{ diffLabel(i.diff_type) }}</span></td>
                <td class="wrap tiny">{{ i.note || '—' }}</td>
                <td class="ops">
                  <template v-if="canWrite && ['amount','weight','missing'].includes(i.diff_type) && ['diff','disputed'].includes(i.status)">
                    <button class="btn btn-primary btn-sm" @click="resolve(i, 'accepted')">认账</button>
                    <button class="btn btn-ghost btn-sm" @click="resolve(i, 'disputed')">挂争议</button>
                  </template>
                  <span v-else-if="i.status === 'accepted'" class="ok-txt tiny">已认账</span>
                  <span v-else-if="i.status === 'disputed'" class="amt-orange tiny">争议中</span>
                  <span v-else-if="i.status === 'ok'" class="tiny muted">无需处理</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="billModal = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：ASN / 点收单明细 ==================== -->
    <div v-if="detailModal" class="modal-mask">
      <div class="modal xwide">
        <h3>{{ detailModal.title }}</h3>
        <div class="table-wrap">
          <table class="line-tbl">
            <thead>
              <tr>
                <th>款号 / 色码</th>
                <th style="width: 84px" class="num">预报</th>
                <th style="width: 84px" class="num">实收</th>
                <th style="width: 84px" class="num">破损</th>
                <th style="width: 84px" class="num">短少</th>
                <th style="width: 84px" class="num">已上架</th>
                <th>差异原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in detailModal.rows" :key="r.id">
                <td class="tiny">
                  <span class="mono">{{ r.style_no }}</span>
                  <span class="muted"> {{ r.color || '-' }}/{{ r.size || '-' }}</span>
                </td>
                <td class="num">{{ r.expect_qty }}</td>
                <td class="num">{{ r.received_qty === undefined ? '—' : r.received_qty }}</td>
                <td class="num">{{ r.damaged_qty || 0 }}</td>
                <td class="num" :class="r.short_qty ? 'amt-red' : ''">{{ r.short_qty || 0 }}</td>
                <td class="num">{{ r.put_qty || 0 }}</td>
                <td class="wrap tiny">{{ r.diff_reason || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="detailModal.putaways && detailModal.putaways.length" class="block" style="margin-top: 14px">
          <h4>上架落位</h4>
          <table class="line-tbl">
            <thead><tr><th style="width: 130px">库位</th><th style="width: 100px">库区</th><th style="width: 90px" class="num">数量</th><th style="width: 130px">时间</th></tr></thead>
            <tbody>
              <tr v-for="p in detailModal.putaways" :key="p.id">
                <td class="mono">{{ p.location_code }}</td>
                <td class="tiny">{{ p.zone_label }}</td>
                <td class="num">{{ p.qty }}</td>
                <td class="tiny muted">{{ $fmt(p.put_at).slice(5) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="detailModal = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import {useRoute} from 'vue-router';
import {watch} from 'vue';
import { localDate } from '../utils/time';
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('wh.write'));

const route=useRoute();
const tab = ref(route.query.tab==='loc'?'loc':'asn');
const dict = ref({ zones: [], asn_status: [], carriers: [] });
const board = ref({ stat: {}, arriving: [], receiving: [], loc_stat: [], bundle_stock: [], recent_ops: [] });
const asns = ref([]);
const receipts = ref([]);
const locations = ref([]);
const usStock = ref([]);
const bundles = ref([]);
const bundleOps = ref([]);
const bills = ref([]);
const rates = ref([]);

const asnStatus = ref(route.query.status==='in_transit'?'in_transit':'all');
watch(()=>route.fullPath,()=>{asnStatus.value=route.query.status==='in_transit'?'in_transit':'all';go(route.query.tab==='loc'?'loc':'asn');});
const billStatus = ref('all');

const asnForm = ref(null);
const rcvModal = ref(null);
const putModal = ref(null);
const kitModal = ref(null);
const bundleForm = ref(null);
const locForm = ref(null);
const billModal = ref(null);
const detailModal = ref(null);

const BILL_STATUS = { pending: '待核对', matched: '已核平', disputed: '有争议', settled: '已结算' };
const DIFF = { ok: '正常', amount: '金额差', weight: '重量差', missing: '无此单', no_rate: '无费率', extra: '漏计费' };
const billLabel = (s) => BILL_STATUS[s] || s;
const diffLabel = (s) => DIFF[s] || s;
const fmt = (v) => (Number(v) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

async function loadBoard() {
  board.value = await api.whBoard({ warehouse: 'us' });
}
async function loadDict() {
  dict.value = await api.whDict();
}
async function loadAsns() {
  asns.value = await api.whAsns({ status: asnStatus.value, warehouse: 'us' });
}
async function loadReceipts() {
  receipts.value = await api.whReceipts({ status: 'all' });
}
async function loadLocations() {
  locations.value = await api.whLocations({ warehouse: 'us' });
}
async function loadStock() {
  usStock.value = (await api.stock({ warehouse: 'us' })) || [];
}
async function loadBundles() {
  bundles.value = await api.whBundles({ warehouse: 'us' });
  bundleOps.value = await api.whBundleOps({ limit: 50 });
}
async function loadBills() {
  bills.value = await api.whBills({ status: billStatus.value });
  rates.value = await api.whRates();
}

async function reloadAll() {
  await Promise.all([loadBoard(), loadDict()]);
  if (tab.value === 'asn') { await loadAsns(); await loadReceipts(); }
  if (tab.value === 'loc') { await loadLocations(); await loadStock(); }
  if (tab.value === 'bundle') await loadBundles();
  if (tab.value === 'freight') await loadBills();
}

function go(t) {
  tab.value = t;
  if (t === 'asn') { loadAsns(); loadReceipts(); }
  if (t === 'loc') { loadLocations(); loadStock(); }
  if (t === 'bundle') loadBundles();
  if (t === 'freight') loadBills();
}

/* ---------------- ASN ---------------- */
function openAsnForm() {
  asnForm.value = {
    container_no: '', carrier: '', ship_date: localDate(),
    eta_date: '', carton_plan: 0,
    items: [{ style_no: '', product_name: '', color: '', size: '', expect_qty: 1, carton_no: '' }]
  };
}
function addAsnLine() {
  asnForm.value.items.push({ style_no: '', product_name: '', color: '', size: '', expect_qty: 1, carton_no: '' });
}
async function submitAsn() {
  try {
    const r = await api.whCreateAsn(asnForm.value);
    asnForm.value = null;
    await reloadAll();
    alert(`已创建 ${r.asn_no}，共 ${r.expect_qty} 件。下一步点「发运」。`);
  } catch (e) { alert('创建失败：' + e.message); }
}
async function doShip(a) {
  if (!confirm(`确认发运 ${a.asn_no}？`)) return;
  try { await api.whShipAsn(a.id, { ship_date: localDate() }); await reloadAll(); }
  catch (e) { alert('发运失败：' + e.message); }
}
async function doArrive(a) {
  if (!confirm(`标记 ${a.asn_no} 已到仓？到仓后才能点收。`)) return;
  try { await api.whArriveAsn(a.id, { arrive_date: localDate() }); await reloadAll(); }
  catch (e) { alert('操作失败：' + e.message); }
}
async function doCancel(a) {
  const reason = prompt(`取消 ${a.asn_no} 的原因（至少 4 个字）：`);
  if (reason === null) return;
  try { await api.whCancelAsn(a.id, { reason }); await reloadAll(); }
  catch (e) { alert('取消失败：' + e.message); }
}
async function viewAsn(a) {
  const d = await api.whAsn(a.id);
  detailModal.value = {
    title: `发运单 ${d.asn.asn_no} · ${d.asn.status_label}`,
    rows: d.rcv_items.length ? d.rcv_items : d.items,
    putaways: d.putaways
  };
}
async function openReceive(a) {
  const d = await api.whAsn(a.id);
  rcvModal.value = {
    asn: d.asn,
    arrive_date: localDate(),
    carton_actual: a.carton_plan || 0,
    note: '',
    lines: d.items.map((i) => ({
      asn_item_id: i.id, style_no: i.style_no, color: i.color, size: i.size,
      expect_qty: i.expect_qty, received_qty: i.expect_qty, damaged_qty: 0, diff_reason: ''
    }))
  };
}
function lineDiff(l) {
  const d = Number(l.expect_qty || 0) - Number(l.received_qty || 0) - Number(l.damaged_qty || 0);
  return Math.round(d * 100) / 100;
}
async function submitReceive() {
  try {
    const r = await api.whReceiveAsn(rcvModal.value.asn.id, {
      arrive_date: rcvModal.value.arrive_date,
      carton_actual: rcvModal.value.carton_actual,
      note: rcvModal.value.note,
      items: rcvModal.value.lines
    });
    rcvModal.value = null;
    await reloadAll();
    alert(`点收完成：实收 ${r.received_qty}，破损 ${r.damaged_qty}，短少 ${r.short_qty}。\n下一步到「点收单」里上架，上架后才进可售库存。`);
  } catch (e) { alert('点收失败：' + e.message); }
}

/* ---------------- 上架 ---------------- */
async function openPutaway(r) {
  const d = await api.whReceipt(r.id);
  const sellable = d.locations.filter((l) => l.zone === 'sellable');
  if (!sellable.length) { alert('没有可售区库位，请先到「库位与库存」新建一个可售区库位。'); return; }
  putModal.value = {
    receipt: d.receipt,
    locations: d.locations,
    lines: d.items.filter((i) => i.to_put > 0).map((i) => ({
      ...i, location_code: sellable[0].code, qty: i.to_put
    }))
  };
}
async function submitPutaway() {
  try {
    const r = await api.whPutaway(putModal.value.receipt.id, {
      items: putModal.value.lines.map((l) => ({ rcv_item_id: l.id, location_code: l.location_code, qty: l.qty }))
    });
    putModal.value = null;
    await reloadAll();
    alert(`上架完成：本次进可售 ${r.added_sellable} 件${r.all_done ? '，该柜已全部上架完成' : `，还剩 ${r.left_qty} 件待上架`}`);
  } catch (e) { alert('上架失败：' + e.message); }
}
async function viewReceipt(r) {
  const d = await api.whReceipt(r.id);
  detailModal.value = { title: `点收单 ${d.receipt.rcv_no}`, rows: d.items, putaways: d.putaways };
}

/* ---------------- 库位 ---------------- */
function openLocForm() {
  locForm.value = { code: '', zone: 'sellable', aisle: '', capacity: 0 };
}
async function submitLoc() {
  try {
    await api.whCreateLocation(locForm.value);
    locForm.value = null;
    await loadLocations();
  } catch (e) { alert('创建失败：' + e.message); }
}
async function toggleLoc(l) {
  try {
    await api.whUpdateLocation(l.id, { status: l.status === 'locked' ? 'active' : 'locked' });
    await loadLocations();
  } catch (e) { alert('操作失败：' + e.message); }
}

/* ---------------- 套装 ---------------- */
function openBundleForm() {
  bundleForm.value = {
    bundle_sku: '', name: '', sale_price: 0,
    items: [{ style_no: '', product_name: '', color: '', size: '', qty_per: 1 }]
  };
}
async function submitBundle() {
  try {
    await api.whCreateBundle(bundleForm.value);
    bundleForm.value = null;
    await reloadAll();
  } catch (e) { alert('创建失败：' + e.message); }
}
function openKit(b, type) {
  kitModal.value = {
    bundle: b, type,
    qty: type === 'kit' ? Math.min(1, b.can_kit) : Math.min(1, b.stock_qty),
    remark: ''
  };
}
async function submitKit() {
  const { bundle, type, qty, remark } = kitModal.value;
  try {
    const fn = type === 'kit' ? api.whKit : api.whUnbundle;
    const r = await fn(bundle.id, { qty: Number(qty), remark });
    kitModal.value = null;
    await reloadAll();
    alert(`${type === 'kit' ? '组装' : '拆分'}完成：${r.op_no}，套装库存 ${r.before_qty} → ${r.after_qty}`);
  } catch (e) { alert('操作失败：' + e.message); }
}
async function toggleBundle(b) {
  const next = b.status === 'active' ? 'disabled' : 'active';
  if (!confirm(`确认${next === 'active' ? '启用' : '停用'}套装 ${b.bundle_sku}？停用后不能组装。`)) return;
  try { await api.whUpdateBundle(b.id, { status: next }); await loadBundles(); }
  catch (e) { alert('操作失败：' + e.message); }
}

/* ---------------- 运费 ---------------- */
async function openBill(b) {
  billModal.value = await api.whBill(b.id);
}
async function doMatch(b) {
  try {
    const r = await api.whMatchBill(b.id);
    await loadBills();
    if (billModal.value) billModal.value = await api.whBill(b.id);
    alert(`核对完成：差异 ${r.diff_count} 条、无此单 ${r.missing_count} 条、漏计费 ${r.extra_count} 条，差额 $${fmt(r.diff_amount)}`);
  } catch (e) { alert('核对失败：' + e.message); }
}
async function resolve(it, status) {
  const note = prompt(status === 'accepted' ? '认账说明（至少 4 个字）：' : '争议说明（至少 4 个字）：');
  if (note === null) return;
  try {
    await api.whResolveFreight(it.id, { status, note });
    billModal.value = await api.whBill(billModal.value.bill.id);
    await loadBills();
  } catch (e) { alert('处理失败：' + e.message); }
}
async function doSettle(b) {
  if (!confirm(`确认结算 ${b.bill_no}？结算后不能再核对。`)) return;
  try {
    await api.whSettleBill(b.id);
    billModal.value = await api.whBill(b.id);
    await loadBills();
    await loadBoard();
    alert('已结算。');
  } catch (e) { alert('结算失败：' + e.message); }
}

onMounted(async () => {
  await Promise.all([loadBoard(), loadDict()]);
  await loadAsns();
  await loadReceipts();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.amt-blue { color: var(--brand); }
.muted { color: #9aa4b5; }
.tiny { font-size: 12px; }
.wrap { white-space: normal; line-height: 1.55; min-width: 120px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.variant { color: var(--ink-mute); margin-left: 2px; }
.num { text-align: right; }
.ops { white-space: nowrap; }
.ok-txt { color: #16a34a; font-size: 12px; }
.row-warn { background: #fffdf7; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 12px; }
.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 12px; color: #9aa4b5; }

.pill { display: inline-block; font-size: 12px; border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
.st-draft { background: #eef2f8; color: var(--ink-soft); }
.st-in_transit { background: #eef4ff; color: var(--brand); }
.st-arrived { background: #fff6e8; color: #b46207; }
.st-receiving { background: #fdf0e6; color: #c2410c; }
.st-done { background: #eefaf2; color: #15803d; }
.st-cancelled { background: #f3f4f6; color: #9aa4b5; }
.st-pending { background: #fff6e8; color: #b46207; }
.st-matched { background: #eefaf2; color: #15803d; }
.st-disputed { background: #fdecef; color: #c0243c; }
.st-settled { background: #eef2f8; color: var(--ink-soft); }
.pill-lock { background: #fdecef; color: #c0243c; }
.dt-ok { background: #eefaf2; color: #15803d; }
.dt-amount { background: #fdecef; color: #c0243c; }
.dt-weight { background: #fff6e8; color: #b46207; }
.dt-missing { background: #f3e8ff; color: #7c3aed; }
.dt-no_rate { background: #eef2f8; color: var(--ink-soft); }
.dt-extra { background: #eef4ff; color: var(--brand); }

.asn-tbl { min-width: 1110px; width: 100%; }
.rcv-tbl { min-width: 1000px; width: 100%; }
.stock-tbl { min-width: 800px; width: 100%; }
.ops-tbl { min-width: 1060px; width: 100%; }
.bill-tbl { min-width: 1180px; width: 100%; }
.rate-tbl { min-width: 900px; width: 100%; }
.fi-tbl { min-width: 1280px; width: 100%; }
.line-tbl { min-width: 100%; width: 100%; }
.line-tbl th, .line-tbl td { padding: 5px 6px; }

.loc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.loc-card { background: var(--surface); border: 1px solid #e6ebf3; border-left: 3px solid #2b6de5; border-radius: 10px; padding: 10px 12px; }
.loc-card.z-sellable { border-left-color: #16a34a; }
.loc-card.z-inspect { border-left-color: #2b6de5; }
.loc-card.z-damaged { border-left-color: #d92d45; }
.loc-card.z-return { border-left-color: #7c3aed; }
.loc-card.z-staging { border-left-color: #94a3b8; }
.loc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; flex-wrap: wrap; }
.loc-head b { font-size: 13px; color: var(--ink); }
.loc-body { display: flex; gap: 22px; margin-bottom: 5px; }
.loc-body > div { min-width: 64px; }
.loc-body span { display: block; font-size: 12px; color: var(--ink-mute); }
.loc-body b { font-size: 15px; color: var(--ink); }
.loc-ops { margin-top: 6px; }
.z-sellable.pill { background: #eefaf2; color: #15803d; }
.z-inspect.pill { background: #eef4ff; color: var(--brand); }
.z-damaged.pill { background: #fdecef; color: #c0243c; }
.z-return.pill { background: #f3e8ff; color: #7c3aed; }
.z-staging.pill { background: #eef2f8; color: var(--ink-soft); }

.bundle-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 12px; }
.bundle-card { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 13px 15px; }
.bd-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
.bd-head b { font-size: 14px; color: var(--ink); }
.rule-code { font-size: 12px; color: #a3adbe; font-family: ui-monospace, Menlo, Consolas, monospace; margin-top: 2px; }
.bd-stat { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 9px 0; border-top: 1px dashed #e9eef7; border-bottom: 1px dashed #e9eef7; margin-bottom: 9px; }
.bd-stat span { display: block; font-size: 12px; color: var(--ink-mute); }
.bd-stat b { font-size: 17px; color: var(--ink); }
.bd-tbl { width: 100%; margin-bottom: 9px; }
.bd-tbl th, .bd-tbl td { padding: 4px 5px; font-size: 12px; }
.bd-ops { display: flex; gap: 6px; }

.form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
.fld { display: block; }
.fld span { display: block; font-size: 12px; color: #6b7791; margin-bottom: 4px; }
.fld input, .fld select { width: 100%; border: 1px solid #dbe3ef; border-radius: 8px; padding: 6px 9px; font-size: 13px; font-family: inherit; }
.line-head { display: flex; justify-content: space-between; align-items: center; margin: 10px 0 6px; font-size: 13px; color: var(--ink); }
.cell-in { width: 100%; border: 1px solid #e2e8f2; border-radius: 6px; padding: 4px 6px; font-size: 12.5px; font-family: inherit; }
.cell-in.num { text-align: right; }
.modal-mask { position: fixed; inset: 0; background: rgba(20, 30, 48, 0.42); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: var(--surface); border-radius: 14px; padding: 18px 20px; width: 560px; max-width: 94vw; max-height: 92vh; overflow: auto; box-shadow: 0 18px 50px rgba(16, 30, 55, 0.22); }
.modal.wide { width: 880px; }
.modal.xwide { width: 1000px; }
.modal.xxwide { width: 1320px; }
.modal h3 { margin: 0 0 8px; font-size: 15px; color: var(--ink); }
.modal-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.bill-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.bill-ops { display: flex; gap: 6px; white-space: nowrap; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .form-grid { grid-template-columns: 1fr; }
  .bundle-grid { grid-template-columns: 1fr; }
  .modal, .modal.wide, .modal.xwide, .modal.xxwide { width: 94vw; }
}
</style>
