<template>
  <div>
    <div class="page-head">
      <div>
        <h2>零售与渠道</h2>
        <div class="sub">平台与主体映射 · 零售订单与支付核对 · 批零库存配额 · 渠道费率与经营损益</div>
      </div>
      <div class="toolbar" style="margin: 0">
        <button class="btn btn-ghost" @click="loadAll">刷新</button>
      </div>
    </div>

    <!-- 预警 -->
    <div v-if="s.warnings && s.warnings.length" class="alert-bar">
      <div v-for="(w, i) in s.warnings" :key="i" style="margin: 2px 0">⚠️ {{ w }}</div>
    </div>

    <!-- KPI -->
    <div class="cards">
      <div class="stat-card">
        <div class="label">在营店铺</div>
        <div class="value">{{ s.shops || 0 }}<small>个</small></div>
        <div class="delta">未授权 {{ s.unauthorized_shops || 0 }} 个</div>
      </div>
      <div class="stat-card" :class="(s.orders && s.orders.pay_pending) ? 'accent' : ''">
        <div class="label">支付待核</div>
        <div class="value">{{ (s.orders && s.orders.pay_pending) || 0 }}<small>单</small></div>
        <div class="delta">未核对不释放拣配 · 异常 {{ (s.orders && s.orders.pay_mismatch) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">零售实付</div>
        <div class="value">${{ money(s.amount && s.amount.paid) }}</div>
        <div class="delta">已退款 ${{ money(s.amount && s.amount.refund) }} · 已发货 {{ (s.orders && s.orders.shipped) || 0 }} 单</div>
      </div>
      <div class="stat-card" :class="(s.quota && (s.quota.over_limit || s.quota.shortage)) ? 'accent' : ''">
        <div class="label">配额预警</div>
        <div class="value">{{ ((s.quota && s.quota.over_limit) || 0) + ((s.quota && s.quota.shortage) || 0) }}<small>条</small></div>
        <div class="delta">超额 {{ (s.quota && s.quota.over_limit) || 0 }} · 缺实物 {{ (s.quota && s.quota.shortage) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">已确认贡献</div>
        <div class="value">${{ money(s.settlement && s.settlement.confirmed_contribution) }}</div>
        <div class="delta">预估 ${{ money(s.settlement && s.settlement.estimated_contribution) }} · 差异批 {{ (s.settlement && s.settlement.diff_batches) || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">售后待处理</div>
        <div class="value">{{ (s.after_sales && s.after_sales.open) || 0 }}<small>单</small></div>
        <div class="delta">退货待收实物 {{ (s.after_sales && s.after_sales.return_pending) || 0 }}</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>
    </div>

    <!-- ==================== 1. 平台与主体映射 ==================== -->
    <template v-if="tab === 'shops'">
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" v-model="shopQ" placeholder="搜索店铺 / 编码 / 公司" @keyup.enter="loadShops" style="width: 240px" />
        <select class="select" v-model="shopPlatform" @change="loadShops">
          <option value="">全部平台</option>
          <option v-for="p in meta.platforms" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <button class="btn btn-ghost" @click="loadShops">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openShop()">＋ 新增店铺映射</button>
      </div>

      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        店铺数量与公司数量没有固定一一关系：同一公司可开多店，同一店铺也可跨主体经营。经营主体、签约主体、开票主体、收款主体、履约仓分开登记，<strong>不因发货仓位自动认定收入归属</strong>。
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>映射 ID</th><th>平台 / 店铺</th><th>经营主体</th><th>签约主体</th><th>收款主体</th>
              <th>履约仓</th><th>费率</th><th>接口授权</th><th>订单</th><th v-if="canWrite">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shops" :key="r.id">
              <td class="nowrap muted">{{ r.code || '-' }}</td>
              <td class="nowrap">
                <strong>{{ r.shop_name }}</strong>
                <div class="muted" style="font-size: 12px">{{ r.platform_label }}</div>
              </td>
              <td class="nowrap">{{ r.company || '-' }}</td>
              <td class="nowrap">{{ r.contract_party || '-' }}</td>
              <td class="nowrap">{{ r.payee_party || '-' }}</td>
              <td class="nowrap">{{ r.warehouse_label }}</td>
              <td class="nowrap">{{ r.fee_rate }}%</td>
              <td class="nowrap">
                <span class="tag" :class="r.api_status === 'authorized' ? 'green' : r.api_status === 'limited' ? 'orange' : 'gray'">{{ r.api_label }}</span>
                <div v-if="r.api_note" class="muted" style="font-size: 11.5px; max-width: 220px; white-space: normal">{{ r.api_note }}</div>
              </td>
              <td class="nowrap">{{ r.order_count }} 单 / ${{ money(r.paid_total) }}</td>
              <td v-if="canWrite" class="nowrap">
                <button class="link-btn" @click="openShop(r)">编辑</button>
                <button class="link-btn" @click="openVerify(r)">接口授权</button>
                <button class="link-btn danger" @click="removeShop(r)">删除</button>
              </td>
            </tr>
            <tr v-if="!shops.length"><td :colspan="canWrite ? 10 : 9" class="empty-cell">暂无店铺映射</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ==================== 2. 零售订单与支付核对 ==================== -->
    <template v-if="tab === 'orders'">
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" v-model="orderQ" placeholder="渠道订单号 / 内部单号 / 收件人" @keyup.enter="loadOrders" style="width: 230px" />
        <select class="select" v-model="orderShop" @change="loadOrders">
          <option value="">全部店铺</option>
          <option v-for="r in shops" :key="r.id" :value="r.id">{{ r.shop_name }}</option>
        </select>
        <select class="select" v-model="orderPay" @change="loadOrders">
          <option value="">全部支付状态</option>
          <option value="pending">支付待核</option>
          <option value="checked">回执已核</option>
          <option value="mismatch">核对异常</option>
        </select>
        <select class="select" v-model="orderFulfill" @change="loadOrders">
          <option value="">全部履约状态</option>
          <option value="waiting">待预留</option>
          <option value="reserved">已预留</option>
          <option value="shortage">缺货待补</option>
          <option value="shipped">已发货</option>
        </select>
        <button class="btn btn-ghost" @click="loadOrders">查询</button>
        <button class="btn btn-ghost" @click="exportOrders">导出 CSV</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openOrder()">＋ 新建零售单</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>渠道订单</th><th>店铺 / 主体</th><th>模式</th><th>SKU / 数量</th>
              <th>实付</th><th>已退款</th><th>支付核对</th><th>履约</th><th>结算</th><th v-if="canWrite">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in orders" :key="r.id">
              <td class="nowrap">
                <strong>{{ r.channel_order_no }}</strong>
                <div class="muted" style="font-size: 12px">{{ r.retail_no }} · {{ r.order_date || '-' }}</div>
              </td>
              <td class="nowrap">
                {{ r.shop_name }}
                <div class="muted" style="font-size: 12px">{{ r.company || '-' }}</div>
              </td>
              <td class="nowrap">{{ r.mode_label }}</td>
              <td class="nowrap">
                {{ r.sku_text || '-' }}
                <div class="muted" style="font-size: 12px">{{ r.total_qty }} 件</div>
              </td>
              <td class="num">${{ money(r.paid_amount) }}</td>
              <td class="num">${{ money(r.refund_amount) }}</td>
              <td class="nowrap">
                <span class="tag" :class="r.pay_status === 'checked' ? 'green' : r.pay_status === 'mismatch' ? 'red' : 'orange'">{{ r.pay_label }}</span>
              </td>
              <td class="nowrap">
                <span class="tag" :class="r.fulfill_status === 'shipped' ? 'green' : r.fulfill_status === 'shortage' ? 'red' : r.fulfill_status === 'reserved' ? 'blue' : 'gray'">{{ r.fulfill_label }}</span>
              </td>
              <td class="nowrap muted">{{ r.settle_status === 'settled' ? '已结算' : '未结算' }}</td>
              <td v-if="canWrite" class="nowrap">
                <button class="link-btn" @click="openOrderDetail(r.id)">详情</button>
                <button v-if="r.pay_status !== 'checked' && r.fulfill_status !== 'shipped'" class="link-btn" @click="openPay(r)">核对支付</button>
                <button v-if="r.pay_status === 'checked' && r.fulfill_status === 'waiting'" class="link-btn" @click="doReserve(r)">预留</button>
                <button v-if="r.pay_status === 'checked' && ['waiting','reserved','shortage'].includes(r.fulfill_status)" class="link-btn" @click="doShip(r)">发货</button>
                <button v-if="r.fulfill_status !== 'shipped' && r.fulfill_status !== 'cancelled'" class="link-btn danger" @click="doCancel(r)">取消</button>
              </td>
            </tr>
            <tr v-if="!orders.length"><td :colspan="canWrite ? 10 : 9" class="empty-cell">暂无零售订单</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 新建零售单 -->
      <div v-if="orderModal" class="modal-mask" @click.self="orderModal = false">
        <div class="modal xwide">
          <div class="modal-head">
            <h3>新建零售单</h3>
            <button class="link-btn" @click="orderModal = false">关闭</button>
          </div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem">
                <label>店铺 *</label>
                <select class="select" v-model.number="form.shop_id" @change="pickShop">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="r in shops" :key="r.id" :value="r.id">{{ r.shop_name }}（{{ r.platform_label }}）</option>
                </select>
              </div>
              <div class="fitem">
                <label>渠道订单号 *</label>
                <input class="input" v-model="form.channel_order_no" placeholder="平台上的订单号，同店不可重复" />
              </div>
              <div class="fitem">
                <label>下单日期</label>
                <input class="input" type="date" v-model="form.order_date" />
              </div>
              <div class="fitem">
                <label>经营模式</label>
                <select class="select" v-model="form.mode">
                  <option value="agency">总部代理零售</option>
                  <option value="direct">直营</option>
                </select>
              </div>
              <div class="fitem">
                <label>收件人</label>
                <input class="input" v-model="form.receiver" />
              </div>
              <div class="fitem">
                <label>实付金额（留空按明细自动算）</label>
                <input class="input" type="number" step="0.01" v-model.number="form.paid_amount" />
              </div>
              <div class="fitem full">
                <label>收件地址</label>
                <input class="input" v-model="form.address" />
              </div>
            </div>

            <div class="section-title" style="margin: 16px 0 8px; font-weight: 700; font-size: 13.5px">商品明细</div>
            <div class="table-wrap">
              <table class="data">
                <thead>
                  <tr><th>SKU / 款号</th><th>品名</th><th>颜色</th><th>尺码</th><th>数量</th><th>单价</th><th>成本</th><th>金额</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="(it, i) in form.items" :key="i">
                    <td><input class="input" v-model="it.style_no" style="width: 130px" placeholder="LEJE-TZ-002" /></td>
                    <td><input class="input" v-model="it.name" style="width: 160px" /></td>
                    <td><input class="input" v-model="it.color" style="width: 80px" /></td>
                    <td><input class="input" v-model="it.size" style="width: 70px" /></td>
                    <td><input class="input" type="number" v-model.number="it.qty" style="width: 70px" /></td>
                    <td><input class="input" type="number" step="0.01" v-model.number="it.price" style="width: 90px" /></td>
                    <td><input class="input" type="number" step="0.01" v-model.number="it.cost" style="width: 90px" /></td>
                    <td class="num nowrap">${{ money((it.qty || 0) * (it.price || 0)) }}</td>
                    <td><button class="link-btn danger" @click="form.items.splice(i, 1)">删</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button class="btn btn-ghost btn-sm" style="margin-top: 8px" @click="addLine">＋ 加一行</button>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
            <p class="muted" style="font-size: 12px; margin-top: 8px">
              零售单建档后为「支付待核」，<strong>支付未核对不会释放拣配</strong>；未授权接口的店铺只能走这类受控录入。
            </p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="orderModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveOrder">{{ saving ? '保存中…' : '创建' }}</button>
          </div>
        </div>
      </div>

      <!-- 支付核对 -->
      <div v-if="payModal" class="modal-mask" @click.self="payModal = false">
        <div class="modal">
          <div class="modal-head"><h3>核对支付回执</h3><button class="link-btn" @click="payModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem"><label>渠道订单</label><input class="input" :value="payForm.channel_order_no" disabled /></div>
              <div class="fitem"><label>订单实付</label><input class="input" :value="'$' + money(payForm.paid_amount)" disabled /></div>
              <div class="fitem"><label>回执金额</label><input class="input" type="number" step="0.01" v-model.number="payForm.receipt_amount" /></div>
              <div class="fitem"><label>支付回执号</label><input class="input" v-model="payForm.pay_ref" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">
              回执金额与订单实付不一致时必须标记「核对异常」，不允许强行通过——否则会带着错账进入结算。
            </p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="doMismatch">标记核对异常</button>
            <button class="btn btn-primary" :disabled="saving" @click="doCheckPay">核对通过</button>
          </div>
        </div>
      </div>

      <!-- 订单详情 -->
      <div v-if="detail" class="modal-mask" @click.self="detail = null">
        <div class="modal xwide">
          <div class="modal-head">
            <h3>{{ detail.channel_order_no }} · {{ detail.retail_no }}</h3>
            <button class="link-btn" @click="detail = null">关闭</button>
          </div>
          <div class="modal-body">
            <div class="cards" style="margin-bottom: 14px">
              <div class="stat-card"><div class="label">实付</div><div class="value">${{ money(detail.paid_amount) }}</div><div class="delta">已退 ${{ money(detail.refund_amount) }}</div></div>
              <div class="stat-card"><div class="label">商品成本</div><div class="value">${{ money(detail.cost_amount) }}</div><div class="delta">毛利 ${{ money(detail.gross_profit) }}</div></div>
              <div class="stat-card"><div class="label">支付</div><div class="value" style="font-size: 15px">{{ detail.pay_label }}</div><div class="delta">{{ detail.pay_ref || '无回执号' }}</div></div>
              <div class="stat-card"><div class="label">履约</div><div class="value" style="font-size: 15px">{{ detail.fulfill_label }}</div><div class="delta">{{ detail.settle_label }}</div></div>
            </div>

            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>SKU</th><th>品名</th><th>颜色</th><th>尺码</th><th>数量</th><th>单价</th><th>金额</th><th>成本</th></tr></thead>
                <tbody>
                  <tr v-for="i in detail.items" :key="i.id">
                    <td class="nowrap">{{ i.style_no || i.sku || '-' }}</td>
                    <td class="nowrap">{{ i.name || '-' }}</td>
                    <td class="nowrap">{{ i.color || '-' }}</td>
                    <td class="nowrap">{{ i.size || '-' }}</td>
                    <td class="num">{{ i.qty }}</td>
                    <td class="num">${{ money(i.price) }}</td>
                    <td class="num">${{ money(i.amount) }}</td>
                    <td class="num">${{ money(i.cost) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="detail.after_sales.length" style="margin-top: 16px">
              <div style="font-weight: 700; font-size: 13.5px; margin-bottom: 8px">售后记录</div>
              <div class="table-wrap">
                <table class="data">
                  <thead><tr><th>售后单</th><th>类型</th><th>原因</th><th>退款</th><th>退款状态</th><th>退回状态</th></tr></thead>
                  <tbody>
                    <tr v-for="a in detail.after_sales" :key="a.id">
                      <td class="nowrap">{{ a.no }}</td>
                      <td class="nowrap">{{ a.type_label }}</td>
                      <td>{{ a.reason || '-' }}</td>
                      <td class="num">${{ money(a.refund_amount) }}</td>
                      <td class="nowrap"><span class="tag" :class="a.refund_status === 'done' ? 'green' : 'orange'">{{ a.refund_label }}</span></td>
                      <td class="nowrap"><span class="tag" :class="a.return_status === 'received' ? 'green' : a.return_status === 'pending' ? 'orange' : 'gray'">{{ a.return_label }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div v-if="detail.remark" class="muted" style="margin-top: 12px; font-size: 12.5px; white-space: pre-wrap">{{ detail.remark }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 3. 售后 ==================== -->
    <template v-if="tab === 'aftersales'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="asRefund" @change="loadAfterSales">
          <option value="">全部退款状态</option>
          <option value="draft">草稿</option>
          <option value="done">已退款</option>
          <option value="rejected">已驳回</option>
        </select>
        <select class="select" v-model="asReturn" @change="loadAfterSales">
          <option value="">全部退回状态</option>
          <option value="pending">待退回</option>
          <option value="received">已收到</option>
          <option value="not_required">无需退回</option>
        </select>
        <button class="btn btn-ghost" @click="loadAfterSales">查询</button>
        <button class="btn btn-ghost" @click="tab = 'orders'">去零售单建售后</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        <strong>渠道退款与实物退回不能互相替代</strong>：钱退了不代表货回来了，货到了也不代表钱退了，两个状态分别推进、各自留痕。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>售后单</th><th>零售单</th><th>类型</th><th>原因</th><th>退款金额</th><th>退款状态</th><th>退回状态</th><th>退回数量</th><th>是否回补</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="a in afterSales" :key="a.id">
              <td class="nowrap"><strong>{{ a.no }}</strong><div class="muted" style="font-size: 12px">{{ (a.created_at || '').slice(0, 10) }}</div></td>
              <td class="nowrap">{{ a.channel_order_no || '-' }}<div class="muted" style="font-size: 12px">{{ a.retail_no }}</div></td>
              <td class="nowrap">{{ a.type_label }}</td>
              <td>{{ a.reason || '-' }}</td>
              <td class="num">${{ money(a.refund_amount) }}</td>
              <td class="nowrap"><span class="tag" :class="a.refund_status === 'done' ? 'green' : a.refund_status === 'rejected' ? 'red' : 'orange'">{{ a.refund_label }}</span></td>
              <td class="nowrap"><span class="tag" :class="a.return_status === 'received' ? 'green' : a.return_status === 'pending' ? 'orange' : 'gray'">{{ a.return_label }}</span></td>
              <td class="num">{{ a.return_qty || 0 }}</td>
              <td class="nowrap muted">{{ a.restock ? '回补' : '-' }}</td>
              <td v-if="canWrite" class="nowrap">
                <button v-if="a.refund_status !== 'done' && a.refund_status !== 'rejected'" class="link-btn" @click="doRefund(a)">确认退款</button>
                <button v-if="a.return_status === 'pending'" class="link-btn" @click="doReceive(a)">收到实物</button>
                <button v-if="a.refund_status !== 'done' && a.refund_status !== 'rejected'" class="link-btn danger" @click="doReject(a)">驳回</button>
              </td>
            </tr>
            <tr v-if="!afterSales.length"><td :colspan="canWrite ? 10 : 9" class="empty-cell">暂无售后单</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ==================== 4. 批零库存配额 ==================== -->
    <template v-if="tab === 'quotas'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="quotaShop" @change="loadQuotas">
          <option value="">全部店铺</option>
          <option v-for="r in shops" :key="r.id" :value="r.id">{{ r.shop_name }}</option>
        </select>
        <button class="btn btn-ghost" @click="loadQuotas">查询</button>
        <button class="btn btn-ghost" @click="doSyncAll">重算全部预留</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openQuota()">＋ 提交配额</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        <strong>配额不是第二份实物</strong>：可分配 = min（渠道限额 − 已预留，该货主实物可用量）。同货主库存批零共享，多个渠道各自设限额时，实际能卖的上限仍受同一批现货约束。
      </div>
      <div v-if="overCommitted.length" class="alert-bar">
        <div v-for="(o, i) in overCommitted" :key="i" style="margin: 2px 0">
          ⚠️ {{ o.style_no }}（{{ o.owner }}）：各渠道限额合计 {{ o.limit_sum }} 件，但实物可用只有 {{ o.stock }} 件，超出 {{ o.over }} 件 —— 先到先得，后到的预留会被拦，需补货或下调限额。
        </div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>配额计划</th><th>店铺</th><th>货主</th><th>款号</th><th>合格上架</th><th>全渠道预留</th><th>本店预留</th><th>渠道限额</th><th>可分配</th><th>状态</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="q in quotas" :key="q.id">
              <td class="nowrap muted">{{ q.plan_no || '-' }}</td>
              <td class="nowrap">{{ q.shop_name }}</td>
              <td class="nowrap">{{ q.owner }}</td>
              <td class="nowrap"><strong>{{ q.style_no }}</strong><div class="muted" style="font-size: 12px">{{ q.product_name || '-' }}</div></td>
              <td class="num">{{ q.stock }}</td>
              <td class="num">{{ q.reserved_all }}</td>
              <td class="num">{{ q.reserved }}</td>
              <td class="num">{{ q.channel_limit }}</td>
              <td class="num">
                <span :style="q.allocatable > 0 ? '' : 'color:#c0392b;font-weight:700'">{{ q.allocatable }}</span>
                <div v-if="q.over_limit" class="muted" style="font-size: 11.5px; color: #c0392b">超额承诺</div>
                <div v-else-if="q.shortage" class="muted" style="font-size: 11.5px; color: #c0392b">预留超实物</div>
              </td>
              <td class="nowrap"><span class="tag" :class="q.status === 'active' ? 'green' : 'gray'">{{ q.status === 'active' ? '生效' : '暂停' }}</span></td>
              <td v-if="canWrite" class="nowrap">
                <button class="link-btn" @click="openUsage(q)">占用明细</button>
                <button class="link-btn" @click="openQuota(q)">调整</button>
              </td>
            </tr>
            <tr v-if="!quotas.length"><td :colspan="canWrite ? 11 : 10" class="empty-cell">暂无配额</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="quotaModal" class="modal-mask" @click.self="quotaModal = false">
        <div class="modal">
          <div class="modal-head"><h3>提交配额调整</h3><button class="link-btn" @click="quotaModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem">
                <label>店铺 *</label>
                <select class="select" v-model.number="quotaForm.shop_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="r in shops" :key="r.id" :value="r.id">{{ r.shop_name }}</option>
                </select>
              </div>
              <div class="fitem"><label>款号 *</label><input class="input" v-model="quotaForm.style_no" /></div>
              <div class="fitem"><label>品名</label><input class="input" v-model="quotaForm.product_name" /></div>
              <div class="fitem"><label>货主</label><input class="input" v-model="quotaForm.owner" /></div>
              <div class="fitem"><label>渠道限额</label><input class="input" type="number" v-model.number="quotaForm.channel_limit" /></div>
              <div class="fitem"><label>预售到货日</label><input class="input" type="date" v-model="quotaForm.pre_sale_date" /></div>
              <div class="fitem full"><label>备注</label><input class="input" v-model="quotaForm.remark" /></div>
            </div>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="quotaModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveQuota">提交</button>
          </div>
        </div>
      </div>

      <div v-if="usage" class="modal-mask" @click.self="usage = null">
        <div class="modal wide">
          <div class="modal-head"><h3>占用明细 · {{ usage.quota.style_no }}</h3><button class="link-btn" @click="usage = null">关闭</button></div>
          <div class="modal-body">
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>渠道订单</th><th>SKU</th><th>颜色/尺码</th><th>数量</th><th>支付</th><th>履约</th></tr></thead>
                <tbody>
                  <tr v-for="r in usage.rows" :key="r.id">
                    <td class="nowrap">{{ r.channel_order_no }}</td>
                    <td class="nowrap">{{ r.style_no }}</td>
                    <td class="nowrap">{{ r.color || '-' }} / {{ r.size || '-' }}</td>
                    <td class="num">{{ r.qty }}</td>
                    <td class="nowrap">{{ r.pay_label }}</td>
                    <td class="nowrap">{{ r.fulfill_label }}</td>
                  </tr>
                  <tr v-if="!usage.rows.length"><td colspan="6" class="empty-cell">暂无占用</td></tr>
                </tbody>
              </table>
            </div>
            <div class="muted" style="margin-top: 10px; font-size: 12.5px">合计占用 {{ usage.total_qty }} 件</div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 5. 结算损益 ==================== -->
    <template v-if="tab === 'settlements'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="stlShop" @change="loadSettlements">
          <option value="">全部店铺</option>
          <option v-for="r in shops" :key="r.id" :value="r.id">{{ r.shop_name }}</option>
        </select>
        <button class="btn btn-ghost" @click="loadSettlements">查询</button>
        <button class="btn btn-ghost" @click="exportSettlements">导出 CSV</button>
        <button v-if="canWrite" class="btn btn-primary" @click="stlModal = true">生成结算批</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: -4px 0 12px">
        商品毛利只扣成本；<strong>贡献 = 实付 − 退款 − 商品成本 − 平台费 − 广告费 − 履约费 − 其他</strong>。系统按费率算出来的是「预估」，必须拿平台账单核对后才能当最终利润。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>结算批</th><th>店铺</th><th>期间</th><th>订单</th><th>实付</th><th>平台费</th><th>广告/履约</th><th>退款</th><th>商品毛利</th><th>贡献</th><th>口径</th><th>差异</th><th v-if="canWrite">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in settlements" :key="r.id">
              <td class="nowrap"><strong>{{ r.batch_no }}</strong><div class="muted" style="font-size: 12px">{{ r.status_label }}</div></td>
              <td class="nowrap">{{ r.shop_name }}</td>
              <td class="nowrap">{{ r.period_start || '-' }} ~ {{ r.period_end || '-' }}</td>
              <td class="num">{{ r.order_count }}</td>
              <td class="num">${{ money(r.order_amount) }}</td>
              <td class="num">${{ money(r.platform_fee) }}</td>
              <td class="num">${{ money((r.ad_fee || 0) + (r.fulfillment_fee || 0)) }}</td>
              <td class="num">${{ money(r.refund_amount) }}</td>
              <td class="num">${{ money(r.gross_profit) }}<div class="muted" style="font-size: 11.5px">{{ r.gross_margin }}%</div></td>
              <td class="num">
                <strong :style="r.contribution < 0 ? 'color:#c0392b' : ''">${{ money(r.contribution) }}</strong>
                <div class="muted" style="font-size: 11.5px">{{ r.contribution_margin }}%</div>
              </td>
              <td class="nowrap"><span class="tag" :class="r.profit_basis === 'confirmed' ? 'green' : 'gray'">{{ r.basis_label }}</span></td>
              <td class="num">{{ r.diff_amount ? '$' + money(r.diff_amount) : '-' }}</td>
              <td v-if="canWrite" class="nowrap">
                <button class="link-btn" @click="openStl(r.id)">明细</button>
                <button v-if="r.profit_basis !== 'confirmed'" class="link-btn" @click="openConfirm(r)">核对账单</button>
              </td>
            </tr>
            <tr v-if="!settlements.length"><td :colspan="canWrite ? 13 : 12" class="empty-cell">暂无结算批</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="stlModal" class="modal-mask" @click.self="stlModal = false">
        <div class="modal">
          <div class="modal-head"><h3>生成结算批（按费率预估）</h3><button class="link-btn" @click="stlModal = false">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem">
                <label>店铺 *</label>
                <select class="select" v-model.number="stlForm.shop_id">
                  <option :value="null">— 请选择 —</option>
                  <option v-for="r in shops" :key="r.id" :value="r.id">{{ r.shop_name }}（费率 {{ r.fee_rate }}%）</option>
                </select>
              </div>
              <div class="fitem"><label>期间起</label><input class="input" type="date" v-model="stlForm.period_start" /></div>
              <div class="fitem"><label>期间止</label><input class="input" type="date" v-model="stlForm.period_end" /></div>
              <div class="fitem"><label>广告费（$）</label><input class="input" type="number" step="0.01" v-model.number="stlForm.ad_fee" /></div>
              <div class="fitem"><label>履约费（$）</label><input class="input" type="number" step="0.01" v-model.number="stlForm.fulfillment_fee" /></div>
              <div class="fitem"><label>其他费用（$）</label><input class="input" type="number" step="0.01" v-model.number="stlForm.other_fee" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">只统计该店铺「支付已核 + 未结算」的零售订单；生成后这些订单会标记为已结算，避免重复计入。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="stlModal = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="doGenerateStl">生成</button>
          </div>
        </div>
      </div>

      <div v-if="stlConfirm" class="modal-mask" @click.self="stlConfirm = null">
        <div class="modal">
          <div class="modal-head"><h3>核对平台账单 · {{ stlConfirm.batch_no }}</h3><button class="link-btn" @click="stlConfirm = null">关闭</button></div>
          <div class="modal-body">
            <div class="form-grid">
              <div class="fitem full"><label>账单来源 *</label><input class="input" v-model="cfForm.source" placeholder="如 Amazon Settlement Report 2026-10" /></div>
              <div class="fitem"><label>账单实付（$）</label><input class="input" type="number" step="0.01" v-model.number="cfForm.order_amount" /></div>
              <div class="fitem"><label>平台费用（$）</label><input class="input" type="number" step="0.01" v-model.number="cfForm.platform_fee" /></div>
              <div class="fitem"><label>广告费（$）</label><input class="input" type="number" step="0.01" v-model.number="cfForm.ad_fee" /></div>
              <div class="fitem"><label>履约费（$）</label><input class="input" type="number" step="0.01" v-model.number="cfForm.fulfillment_fee" /></div>
              <div class="fitem"><label>退款（$）</label><input class="input" type="number" step="0.01" v-model.number="cfForm.refund_amount" /></div>
              <div class="fitem"><label>其他费用（$）</label><input class="input" type="number" step="0.01" v-model.number="cfForm.other_fee" /></div>
            </div>
            <p class="muted" style="font-size: 12px; margin-top: 10px">与系统预估不一致时会自动标记「有差异」并记录差额；所有扣项都必须有账单来源，预估不能当最终利润。</p>
            <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="stlConfirm = null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="doConfirmStl">确认账单</button>
          </div>
        </div>
      </div>

      <div v-if="stlDetail" class="modal-mask" @click.self="stlDetail = null">
        <div class="modal wide">
          <div class="modal-head"><h3>结算明细 · {{ stlDetail.batch_no }}</h3><button class="link-btn" @click="stlDetail = null">关闭</button></div>
          <div class="modal-body">
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>零售单</th><th>渠道订单</th><th>日期</th><th>实付</th><th>退款</th></tr></thead>
                <tbody>
                  <tr v-for="o in stlDetail.orders" :key="o.id">
                    <td class="nowrap">{{ o.retail_no }}</td>
                    <td class="nowrap">{{ o.channel_order_no }}</td>
                    <td class="nowrap">{{ o.order_date || '-' }}</td>
                    <td class="num">${{ money(o.paid_amount) }}</td>
                    <td class="num">${{ money(o.refund_amount) }}</td>
                  </tr>
                  <tr v-if="!stlDetail.orders.length"><td colspan="5" class="empty-cell">无订单</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 店铺映射弹窗 -->
    <div v-if="shopModal" class="modal-mask" @click.self="shopModal = false">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ shopForm.id ? '编辑店铺映射' : '新增店铺映射' }}</h3><button class="link-btn" @click="shopModal = false">关闭</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>映射 ID / 店铺编码</label><input class="input" v-model="shopForm.code" placeholder="AMZ-US-01" /></div>
            <div class="fitem"><label>平台 *</label>
              <select class="select" v-model="shopForm.platform">
                <option v-for="p in meta.platforms" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </div>
            <div class="fitem"><label>店铺名称 *</label><input class="input" v-model="shopForm.shop_name" /></div>
            <div class="fitem"><label>经营主体</label><input class="input" v-model="shopForm.company" /></div>
            <div class="fitem"><label>注册执照</label><input class="input" v-model="shopForm.reg_license" /></div>
            <div class="fitem"><label>签约主体 / 经营委托方</label><input class="input" v-model="shopForm.contract_party" /></div>
            <div class="fitem"><label>开票主体</label><input class="input" v-model="shopForm.invoice_party" /></div>
            <div class="fitem"><label>收款主体</label><input class="input" v-model="shopForm.payee_party" /></div>
            <div class="fitem"><label>履约仓</label>
              <select class="select" v-model="shopForm.warehouse">
                <option value="us">美仓</option>
                <option value="cn">生产仓</option>
              </select>
            </div>
            <div class="fitem"><label>渠道综合费率（%）</label><input class="input" type="number" step="0.01" v-model.number="shopForm.fee_rate" /></div>
            <div class="fitem"><label>接口授权</label>
              <select class="select" v-model="shopForm.api_status">
                <option v-for="a in meta.api_status" :key="a.value" :value="a.value">{{ a.label }}</option>
              </select>
            </div>
            <div class="fitem"><label>状态</label>
              <select class="select" v-model="shopForm.status">
                <option value="active">生效</option>
                <option value="paused">暂停</option>
              </select>
            </div>
            <div class="fitem full"><label>接口授权 / 限流说明</label><input class="input" v-model="shopForm.api_note" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="shopForm.remark" /></div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="shopModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveShop">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 接口授权核弹窗 -->
    <div v-if="verifyModal" class="modal-mask" @click.self="verifyModal = false">
      <div class="modal">
        <div class="modal-head"><h3>核查接口授权 · {{ verifyForm.shop_name }}</h3><button class="link-btn" @click="verifyModal = false">关闭</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full"><label>授权状态</label>
              <select class="select" v-model="verifyForm.api_status">
                <option v-for="a in meta.api_status" :key="a.value" :value="a.value">{{ a.label }}</option>
              </select>
            </div>
            <div class="fitem full"><label>授权与限流说明</label><input class="input" v-model="verifyForm.api_note" /></div>
          </div>
          <p class="muted" style="font-size: 12px; margin-top: 10px">外部 API 权限与限流必须先验证再标记「已授权」；未授权店铺只能走受控导入，避免「以为已经对接了」。</p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="verifyModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveVerify">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'shops', label: '平台与主体映射' },
  { key: 'orders', label: '零售订单与支付核对' },
  { key: 'aftersales', label: '售后' },
  { key: 'quotas', label: '库存配额' },
  { key: 'settlements', label: '结算损益' }
];

const tab = ref('shops');
const canWrite = computed(() => can('channel.write'));
const s = ref({});
const meta = ref({ platforms: [], api_status: [] });
const saving = ref(false);
const formMsg = ref('');

const shops = ref([]);
const shopQ = ref('');
const shopPlatform = ref('');
const shopModal = ref(false);
const shopForm = reactive({});
const verifyModal = ref(false);
const verifyForm = reactive({});

const orders = ref([]);
const orderQ = ref('');
const orderShop = ref('');
const orderPay = ref('');
const orderFulfill = ref('');
const orderModal = ref(false);
const form = reactive({ items: [] });
const payModal = ref(false);
const payForm = reactive({});
const detail = ref(null);

const afterSales = ref([]);
const asRefund = ref('');
const asReturn = ref('');

const quotas = ref([]);
const quotaShop = ref('');
const quotaModal = ref(false);
const quotaForm = reactive({});
const usage = ref(null);

const settlements = ref([]);
const stlShop = ref('');
const stlModal = ref(false);
const stlForm = reactive({});
const stlConfirm = ref(null);
const cfForm = reactive({});
const stlDetail = ref(null);

const money = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 同货主同款：各渠道限额相加是否已超过实物（配额不是第二份库存的核心体现） */
const overCommitted = computed(() => {
  const g = {};
  quotas.value.forEach((q) => {
    const k = (q.style_no || '') + '|' + (q.owner || '');
    if (!g[k]) g[k] = { style_no: q.style_no, owner: q.owner, limit_sum: 0, stock: q.stock || 0 };
    g[k].limit_sum += Number(q.channel_limit) || 0;
    g[k].stock = Math.max(g[k].stock, Number(q.stock) || 0);
  });
  return Object.values(g)
    .filter((o) => o.stock > 0 && o.limit_sum > o.stock)
    .map((o) => ({ ...o, over: o.limit_sum - o.stock }));
});

function err(e) {
  formMsg.value = e && e.message ? e.message : String(e);
  alert(formMsg.value);
}

async function loadAll() {
  try {
    const [st, m] = await Promise.all([api.channelStats(), api.channelMeta()]);
    s.value = st;
    meta.value = m;
  } catch (e) { /* 概览失败不影响分页 */ }
  await Promise.all([loadShops(), loadOrders(), loadAfterSales(), loadQuotas(), loadSettlements()]);
}

async function loadShops() {
  try {
    shops.value = await api.channelShops({ q: shopQ.value || undefined, platform: shopPlatform.value || undefined });
  } catch (e) { err(e); }
}

async function loadOrders() {
  try {
    orders.value = await api.retailOrders({
      q: orderQ.value || undefined,
      shop_id: orderShop.value || undefined,
      pay_status: orderPay.value || undefined,
      fulfill_status: orderFulfill.value || undefined
    });
  } catch (e) { err(e); }
}

async function loadAfterSales() {
  try {
    afterSales.value = await api.afterSales({
      refund_status: asRefund.value || undefined,
      return_status: asReturn.value || undefined
    });
  } catch (e) { err(e); }
}

async function loadQuotas() {
  try {
    quotas.value = await api.channelQuotas({ shop_id: quotaShop.value || undefined });
  } catch (e) { err(e); }
}

async function loadSettlements() {
  try {
    settlements.value = await api.channelSettlements({ shop_id: stlShop.value || undefined });
  } catch (e) { err(e); }
}

// ---------- 店铺 ----------
function openShop(r) {
  formMsg.value = '';
  Object.keys(shopForm).forEach((k) => delete shopForm[k]);
  Object.assign(shopForm, r ? { ...r } : {
    id: null, code: '', platform: 'amazon', shop_name: '', company: '', reg_license: '',
    contract_party: '', invoice_party: '', payee_party: '', warehouse: 'us', fee_rate: 15,
    api_status: 'unauthorized', api_note: '', status: 'active', remark: ''
  });
  shopModal.value = true;
}

async function saveShop() {
  if (!shopForm.shop_name) { formMsg.value = '店铺名称必填'; return; }
  saving.value = true;
  formMsg.value = '';
  try {
    if (shopForm.id) await api.updateChannelShop(shopForm.id, shopForm);
    else await api.createChannelShop(shopForm);
    shopModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

function openVerify(r) {
  formMsg.value = '';
  Object.assign(verifyForm, { id: r.id, shop_name: r.shop_name, api_status: r.api_status, api_note: r.api_note || '' });
  verifyModal.value = true;
}

async function saveVerify() {
  saving.value = true;
  formMsg.value = '';
  try {
    await api.verifyChannelShop(verifyForm.id, { api_status: verifyForm.api_status, api_note: verifyForm.api_note });
    verifyModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function removeShop(r) {
  if (!confirm(`确定删除店铺映射「${r.shop_name}」？`)) return;
  try {
    await api.deleteChannelShop(r.id);
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 零售单 ----------
function addLine() {
  form.items.push({ style_no: '', name: '', color: '', size: '', qty: 1, price: 0, cost: 0 });
}

function openOrder() {
  formMsg.value = '';
  Object.keys(form).forEach((k) => delete form[k]);
  Object.assign(form, {
    shop_id: shops.value[0] ? shops.value[0].id : null, channel_order_no: '', order_date: '',
    mode: 'agency', receiver: '', paid_amount: '', address: '', items: []
  });
  addLine();
  orderModal.value = true;
}

function pickShop() {
  const s2 = shops.value.find((x) => x.id === form.shop_id);
  if (s2 && s2.warehouse) form.warehouse = s2.warehouse;
}

async function saveOrder() {
  formMsg.value = '';
  if (!form.shop_id) { formMsg.value = '请选择店铺'; return; }
  if (!form.channel_order_no) { formMsg.value = '渠道订单号必填'; return; }
  if (!form.items.length) { formMsg.value = '请至少填一行明细'; return; }
  saving.value = true;
  try {
    await api.createRetailOrder({ ...form, items: form.items.filter((i) => i.style_no || i.name) });
    orderModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

function openPay(r) {
  formMsg.value = '';
  Object.assign(payForm, {
    id: r.id, channel_order_no: r.channel_order_no, paid_amount: r.paid_amount,
    receipt_amount: r.paid_amount, pay_ref: r.pay_ref || ''
  });
  payModal.value = true;
}

async function doCheckPay() {
  saving.value = true;
  formMsg.value = '';
  try {
    await api.checkRetailPay(payForm.id, {
      action: 'check', receipt_amount: payForm.receipt_amount, pay_ref: payForm.pay_ref
    });
    payModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doMismatch() {
  const reason = prompt('请填写核对异常原因（如：回执金额与订单不一致）');
  if (reason === null) return;
  saving.value = true;
  formMsg.value = '';
  try {
    await api.checkRetailPay(payForm.id, { action: 'mismatch', pay_ref: payForm.pay_ref, reason });
    payModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doReserve(r) {
  try {
    await api.reserveRetail(r.id);
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function doShip(r) {
  if (!confirm(`确认发货「${r.channel_order_no}」？将从美仓扣减实物库存并写流水。`)) return;
  try {
    await api.shipRetail(r.id, {});
    await loadAll();
  } catch (e) {
    alert(e.message);
    await loadAll();
  }
}

async function doCancel(r) {
  const reason = prompt('取消原因（可留空）');
  if (reason === null) return;
  try {
    await api.cancelRetail(r.id, { reason });
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function openOrderDetail(id) {
  try {
    detail.value = await api.retailOrder(id);
  } catch (e) { alert(e.message); }
}

function exportOrders() {
  downloadFile('/api/channel/retail-orders/export', 'retail-orders.csv').catch((e) => alert(e.message));
}

// ---------- 售后 ----------
async function doRefund(a) {
  const ref = prompt(`确认退款 $${money(a.refund_amount)}？（填平台退款单号，可留空）`);
  if (ref === null) return;
  try {
    await api.confirmRefund(a.id, { refund_ref: ref });
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function doReceive(a) {
  const restock = confirm('收到实物。是否按良品回补库存？\n\n确定 = 回补库存；取消 = 只登记收到，货不放回可售库存');
  try {
    await api.receiveReturn(a.id, { restock, qty: a.return_qty });
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function doReject(a) {
  const reason = prompt('驳回原因');
  if (!reason) return;
  try {
    await api.rejectAfterSale(a.id, { reason });
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 配额 ----------
function openQuota(q) {
  formMsg.value = '';
  Object.keys(quotaForm).forEach((k) => delete quotaForm[k]);
  Object.assign(quotaForm, q ? {
    shop_id: q.shop_id, style_no: q.style_no, product_name: q.product_name || '',
    owner: q.owner, channel_limit: q.channel_limit, pre_sale_date: q.pre_sale_date || '', remark: q.remark || ''
  } : { shop_id: null, style_no: '', product_name: '', owner: '总部货主', channel_limit: 0, pre_sale_date: '', remark: '' });
  quotaModal.value = true;
}

async function saveQuota() {
  formMsg.value = '';
  if (!quotaForm.shop_id || !quotaForm.style_no) { formMsg.value = '店铺与款号必填'; return; }
  saving.value = true;
  try {
    await api.saveChannelQuota(quotaForm);
    quotaModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function openUsage(q) {
  try {
    usage.value = await api.quotaUsage(q.id);
  } catch (e) { alert(e.message); }
}

async function doSyncAll() {
  if (!quotas.value.length) return;
  try {
    for (const q of quotas.value) await api.syncQuota(q.id);
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ---------- 结算 ----------
function openConfirm(r) {
  formMsg.value = '';
  Object.assign(cfForm, {
    id: r.id, source: r.source || '', order_amount: r.order_amount, platform_fee: r.platform_fee,
    ad_fee: r.ad_fee, fulfillment_fee: r.fulfillment_fee, refund_amount: r.refund_amount, other_fee: r.other_fee
  });
  stlConfirm.value = r;
}

async function doGenerateStl() {
  formMsg.value = '';
  if (!stlForm.shop_id) { formMsg.value = '请选择店铺'; return; }
  saving.value = true;
  try {
    await api.generateSettlement(stlForm);
    stlModal.value = false;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function doConfirmStl() {
  formMsg.value = '';
  if (!cfForm.source) { formMsg.value = '请填写账单来源'; return; }
  saving.value = true;
  try {
    await api.confirmSettlement(cfForm.id, cfForm);
    stlConfirm.value = null;
    await loadAll();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function openStl(id) {
  try {
    stlDetail.value = await api.channelSettlement(id);
  } catch (e) { alert(e.message); }
}

function exportSettlements() {
  downloadFile('/api/channel/settlements/export', 'channel-settlements.csv').catch((e) => alert(e.message));
}

onMounted(loadAll);
</script>

<style scoped>
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1080px; }
</style>
