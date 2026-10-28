<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>办公耗材与服务采购</h2>
        <p class="sub">
          办公用品有自己的仓库和流水，<b>和生产材料仓、成品仓完全分开</b> —— 领一箱 A4 纸不会从面料库存里扣。
          采购验收时一次做完三件事：<b>耗材入库、耐用品转资产、费用入账</b>，三者互不重复。
          最低库存只提示，不自动下单。
        </p>
      </div>
      <div class="head-ops">
        <input v-model="kw" class="input" style="width: 150px" placeholder="名称 / 单号 / 供应商" @keyup.enter="reload" />
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card">
        <div class="label">物品档案</div>
        <div class="value">{{ stats.items || 0 }}</div>
        <div class="foot">在用（耐用品 {{ durableCount }} 种）</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.low_stock }">
        <div class="label">低于最低库存</div>
        <div class="value">{{ stats.low_stock || 0 }}</div>
        <div class="foot">只提示，不自动采购</div>
      </div>
      <div class="stat-card accent">
        <div class="label">待审批申领</div>
        <div class="value">{{ stats.pending_req || 0 }}</div>
        <div class="foot">已批准待领用 {{ stats.to_issue || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">在途采购</div>
        <div class="value">{{ stats.open_po || 0 }}</div>
        <div class="foot">已批准 / 已下单</div>
      </div>
      <div class="stat-card">
        <div class="label">本月办公费用</div>
        <div class="value">{{ money(stats.month_expense) }}</div>
        <div class="foot">已入账的耗材 + 服务</div>
      </div>
      <div class="stat-card">
        <div class="label">本月转资产</div>
        <div class="value">{{ money(stats.month_asset) }}</div>
        <div class="foot">耐用品，不计费用</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'items' }" @click="tab = 'items'">耗材与库存（{{ items.length }}）</button>
          <button :class="{ on: tab === 'reqs' }" @click="tab = 'reqs'">申领（{{ reqs.length }}）</button>
          <button :class="{ on: tab === 'pos' }" @click="tab = 'pos'">采购与服务（{{ pos.length }}）</button>
        </div>
        <div class="head-ops">
          <button v-if="tab === 'items'" class="btn btn-ghost" @click="openItemForm()">新建物品</button>
          <button v-if="tab === 'reqs'" class="btn btn-primary" @click="openReqForm">提申领</button>
          <button v-if="tab === 'pos'" class="btn btn-primary" @click="openPoForm">新建采购</button>
        </div>
      </div>

      <!-- ---------------- 耗材与库存 ---------------- -->
      <div v-if="tab === 'items'">
        <div class="notice-warn" v-if="low.count">
          <b>{{ low.count }} 项低于最低库存</b>：{{ low.rows.map((r) => `${r.name}（${r.qty}/${r.min_qty}）`).join('、') }}
          <div class="tiny mut">{{ low.note }}</div>
        </div>
        <div class="table-wrap" v-if="items.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 132px">编号</th>
                <th style="width: 200px">名称 / 规格</th>
                <th style="width: 96px">分类</th>
                <th style="width: 92px">库存</th>
                <th style="width: 78px">最低</th>
                <th style="width: 92px">月限额</th>
                <th style="width: 132px">存放 / 说明</th>
                <th style="width: 150px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in items" :key="it.id">
                <td class="nowrap">{{ it.item_no }}</td>
                <td>
                  <div class="ell"><b>{{ it.name }}</b></div>
                  <div class="tiny mut ell">{{ it.spec || '—' }}</div>
                </td>
                <td><span class="tag gray">{{ it.category_label }}</span>
                  <span v-if="it.durable" class="tag purple">耐用品</span>
                </td>
                <td>
                  <span :class="{ 'red': it.low }">{{ num(it.qty) }}</span>
                  <span class="tiny mut"> {{ it.unit }}</span>
                  <div v-if="it.low" class="tiny red">建议补 {{ it.suggest_qty }}</div>
                </td>
                <td class="tiny">{{ num(it.min_qty) || '—' }}</td>
                <td class="tiny">{{ num(it.monthly_limit) || '不限' }}</td>
                <td class="tiny mut ell">
                  {{ it.durable ? (it.stock_note || '转资产') : (it.location || '—') }}
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="openItemForm(it)">编辑</button>
                  <button class="btn btn-sm btn-ghost" @click="openLedger(it)">流水</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有物品档案。点右上「新建物品」先把常用的纸笔、清洁用品建起来。</div>
      </div>

      <!-- ---------------- 申领 ---------------- -->
      <div v-else-if="tab === 'reqs'">
        <div class="table-wrap" v-if="reqs.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 140px">申领单</th>
                <th style="width: 118px">部门</th>
                <th style="width: 118px">申领人</th>
                <th style="width: 250px">事由</th>
                <th style="width: 128px">物品 / 数量</th>
                <th style="width: 96px">状态</th>
                <th style="width: 130px">采购合并</th>
                <th style="width: 88px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in reqs" :key="r.id">
                <td class="nowrap"><b>{{ r.req_no }}</b>
                  <div class="tiny mut">{{ (r.created_at || '').slice(0, 10) }}</div>
                </td>
                <td class="tiny">{{ r.dept_name || '—' }}</td>
                <td class="tiny">{{ r.requester_name || r.requester }}</td>
                <td class="tiny">
                  <div class="ell">{{ r.purpose }}</div>
                  <div v-if="r.exception_reason" class="tiny amber-t">超限额：{{ r.exception_reason }}</div>
                </td>
                <td class="tiny">
                  <div class="ell">{{ r.items.map((x) => x.item_name).join('、') }}</div>
                  <div class="mut">共 {{ num(r.total_qty) }}</div>
                </td>
                <td>
                  <span class="tag" :class="reqCls(r.status)">{{ r.status_label }}</span>
                  <div v-if="r.short" class="tiny red">库存不够出库</div>
                </td>
                <td class="tiny">
                  <span v-if="r.merged" class="tag blue">{{ r.merged.po_no }}</span>
                  <span v-else class="mut">—</span>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="openReq(r.id)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有申领单。</div>
      </div>

      <!-- ---------------- 采购与服务 ---------------- -->
      <div v-else>
        <div class="table-wrap" v-if="pos.length">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 140px">采购单</th>
                <th style="width: 84px">类型</th>
                <th style="width: 168px">供应商 / 服务商</th>
                <th style="width: 110px">归属部门</th>
                <th style="width: 100px">金额</th>
                <th style="width: 100px">计费用</th>
                <th style="width: 100px">转资产</th>
                <th style="width: 96px">状态</th>
                <th style="width: 88px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in pos" :key="p.id">
                <td class="nowrap"><b>{{ p.po_no }}</b>
                  <div class="tiny mut">{{ (p.created_at || '').slice(0, 10) }}</div>
                </td>
                <td><span class="tag" :class="p.kind === 'service' ? 'purple' : 'gray'">{{ p.kind_label }}</span></td>
                <td class="tiny ell">{{ p.supplier || '—' }}</td>
                <td class="tiny">{{ p.dept_name || '—' }}</td>
                <td class="num">{{ money(p.total_amount) }}</td>
                <td class="num">{{ p.status === 'received' || p.status === 'closed' ? money(p.expense_amount) : '—' }}</td>
                <td class="num">{{ p.status === 'received' || p.status === 'closed' ? money(p.asset_amount) : '—' }}</td>
                <td><span class="tag" :class="poCls(p.status)">{{ p.status_label }}</span></td>
                <td class="ops">
                  <button class="btn btn-sm btn-ghost" @click="openPo(p.id)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有采购单。</div>
      </div>
    </div>

    <!-- ---------------- 物品表单 ---------------- -->
    <div class="modal-mask" v-if="itemForm.open" @click.self="itemForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>{{ itemForm.id ? '编辑物品' : '新建物品' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="itemForm.open = false">取消</button></div>
        <div class="modal-body">
          <div class="row"><label>名称</label><input v-model="itemForm.name" class="input" style="flex: 1" placeholder="如 A4 打印纸" /></div>
          <div class="row"><label>规格</label><input v-model="itemForm.spec" class="input" style="flex: 1" placeholder="70g / 500 张一包" /></div>
          <div class="row">
            <label>分类</label>
            <select v-model="itemForm.category" class="input" style="width: 130px">
              <option v-for="c in meta.categories || []" :key="c.code" :value="c.code">{{ c.label }}</option>
            </select>
            <label>单位</label>
            <input v-model="itemForm.unit" class="input" style="width: 80px" />
          </div>
          <div class="row">
            <label>最低库存</label>
            <input v-model="itemForm.min_qty" class="input" type="number" style="width: 100px" />
            <label>部门月限额</label>
            <input v-model="itemForm.monthly_limit" class="input" type="number" style="width: 100px" />
            <span class="tiny mut">0 = 不限</span>
          </div>
          <div class="row">
            <label class="ck"><input type="checkbox" v-model="itemForm.durable" /> 耐用品（验收转资产，不进办公仓）</label>
          </div>
          <div class="row" v-if="itemForm.durable">
            <label>资产分类</label>
            <input v-model="itemForm.asset_category" class="input" style="width: 130px" placeholder="办公设备" />
            <label>折旧年限</label>
            <input v-model="itemForm.useful_years" class="input" type="number" style="width: 80px" />
          </div>
          <div class="modal-foot"><button class="btn btn-primary" @click="saveItem">保存</button></div>
        </div>
      </div>
    </div>

    <!-- ---------------- 流水 ---------------- -->
    <div class="modal-mask" v-if="ledgerBox.open" @click.self="ledgerBox.open = false">
      <div class="modal wide">
        <div class="modal-head"><b>{{ ledgerBox.item ? ledgerBox.item.name : '' }} · 收发明细</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="ledgerBox.open = false">关闭</button></div>
        <div class="modal-body">
          <div class="notice">入库为正、领用为负。库存数字永远等于这张表的合计 —— 对不上说明有人绕过流水改了库存。</div>
          <table class="data" v-if="ledgerBox.rows.length">
            <thead><tr><th style="width: 150px">时间</th><th style="width: 80px">类型</th><th style="width: 80px">数量</th><th style="width: 150px">来源单</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="l in ledgerBox.rows" :key="l.id">
                <td class="tiny nowrap">{{ (l.created_at || '').slice(0, 16).replace('T', ' ') }}</td>
                <td><span class="tag" :class="l.qty > 0 ? 'green' : 'gray'">{{ l.type_label }}</span></td>
                <td class="num" :class="l.qty > 0 ? 'green-t' : ''">{{ num(l.qty) }}</td>
                <td class="tiny nowrap">{{ l.ref_no || '—' }}</td>
                <td class="tiny mut">{{ l.note || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">还没有收发记录</div>
        </div>
      </div>
    </div>

    <!-- ---------------- 新建申领 ---------------- -->
    <div class="modal-mask" v-if="reqForm.open" @click.self="reqForm.open = false">
      <div class="modal wide">
        <div class="modal-head"><b>提申领</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="reqForm.open = false">取消</button></div>
        <div class="modal-body">
          <div class="row">
            <label>部门</label>
            <select v-model="reqForm.dept_id" class="input" style="width: 150px">
              <option :value="null">选择部门</option>
              <option v-for="d in meta.depts || []" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <label>申领人</label>
            <input v-model="reqForm.requester_name" class="input" style="width: 130px" placeholder="姓名" />
          </div>
          <div class="row"><label>事由</label>
            <input v-model="reqForm.purpose" class="input" style="flex: 1" placeholder="至少 4 个字：用来做什么（「办公用」三个字事后看不出为什么领）" /></div>
          <div class="col-h">领用明细</div>
          <table class="data">
            <thead><tr><th>物品</th><th style="width: 90px">库存</th><th style="width: 110px">数量</th><th style="width: 60px"></th></tr></thead>
            <tbody>
              <tr v-for="(ln, i) in reqForm.items" :key="i">
                <td>
                  <select v-model="ln.item_id" class="input" style="width: 100%">
                    <option :value="null">选择物品</option>
                    <option v-for="it in consumables" :key="it.id" :value="it.id">{{ it.name }}（{{ it.unit }}）</option>
                  </select>
                </td>
                <td class="tiny">{{ stockLabel(ln.item_id) }}</td>
                <td><input v-model="ln.qty_apply" class="input" type="number" style="width: 90px" /></td>
                <td><button class="btn btn-sm btn-ghost" @click="reqForm.items.splice(i, 1)" v-if="reqForm.items.length > 1">删</button></td>
              </tr>
            </tbody>
          </table>
          <div class="row"><button class="btn btn-sm btn-ghost" @click="reqForm.items.push({ item_id: null, qty_apply: 1 })">加一行</button>
            <span class="tiny mut">耐用品不在这里领 —— 它们验收时已转成资产卡，请在「资产台账」做领用登记</span></div>
          <div class="row"><label>例外说明</label>
            <input v-model="reqForm.exception_reason" class="input" style="flex: 1" placeholder="超出部门月限额时才需要填（≥6 字）" /></div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="saveReq(false)">存草稿</button>
            <button class="btn btn-primary" @click="saveReq(true)">提交审批</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ---------------- 申领详情 ---------------- -->
    <div class="modal-mask" v-if="reqDetail" @click.self="reqDetail = null">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left">
            <b>{{ reqDetail.req_no }}</b>
            <span class="tag" :class="reqCls(reqDetail.status)">{{ reqDetail.status_label }}</span>
            <span class="tag gray">{{ reqDetail.dept_name || '未填部门' }}</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="reqDetail = null">关闭</button>
        </div>
        <div class="modal-body">
          <div class="kv"><span>申领人</span><b>{{ reqDetail.requester_name || reqDetail.requester }}</b></div>
          <div class="kv"><span>事由</span><b>{{ reqDetail.purpose }}</b></div>
          <div class="kv" v-if="reqDetail.exception_reason"><span>例外说明</span><b class="amber-t">{{ reqDetail.exception_reason }}</b></div>
          <div class="kv" v-if="reqDetail.reject_reason"><span>驳回原因</span><b class="red">{{ reqDetail.reject_reason }}</b></div>
          <div class="kv" v-if="reqDetail.merged"><span>已合并到</span><b>{{ reqDetail.merged.po_no }}</b></div>

          <table class="data" style="margin-top: 10px">
            <thead>
              <tr><th>物品</th><th style="width: 80px">申请</th><th style="width: 110px">批</th><th style="width: 80px">已发</th><th style="width: 80px">已退</th><th style="width: 120px">库存 / 月已领</th></tr>
            </thead>
            <tbody>
              <tr v-for="it in reqDetail.items" :key="it.id">
                <td>{{ it.item_name }} <span class="tiny mut">{{ it.unit }}</span></td>
                <td class="num">{{ num(it.qty_apply) }}</td>
                <td>
                  <input v-if="reqDetail.status === 'submitted'" v-model="it.qty_approved" class="input" type="number" style="width: 80px" />
                  <span v-else class="num">{{ num(it.qty_approved) }}</span>
                </td>
                <td class="num">{{ num(it.qty_issued) }}</td>
                <td class="num">{{ num(it.qty_returned) }}</td>
                <td class="tiny">
                  库存 {{ num(it.available) }}
                  <span v-if="it.monthly_limit" class="mut"> / 月限 {{ it.monthly_limit }}，已领 {{ num(it.month_issued) }}</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="actions" v-if="reqDetail.can.submit || reqDetail.can.approve || reqDetail.can.issue || reqDetail.can.returnItems">
            <div class="row" v-if="reqDetail.can.submit">
              <button class="btn btn-primary" @click="doReqSubmit">提交审批</button>
              <span class="tiny mut">提交时会校验库存、重复领用与部门月限额</span>
            </div>
            <template v-if="reqDetail.can.approve">
              <div class="col-h">审批</div>
              <div class="row">
                <button class="btn btn-primary" @click="doReqApprove">按上面数量批准</button>
                <input v-model="reqAct.reject" class="input" style="flex: 1" placeholder="驳回原因（≥6 字，申领人会看到）" />
                <button class="btn btn-ghost" @click="doReqReject">驳回</button>
              </div>
            </template>
            <div class="row" v-if="reqDetail.can.issue">
              <button class="btn btn-primary" @click="doReqIssue">出库发料</button>
              <span class="tiny mut">出库才真正扣库存并记流水</span>
            </div>
            <template v-if="reqDetail.can.returnItems">
              <div class="col-h">退回</div>
              <div class="row">
                <input v-model="reqAct.returnQty" class="input" type="number" style="width: 100px" placeholder="退回数量" />
                <input v-model="reqAct.returnReason" class="input" style="flex: 1" placeholder="为什么退回" />
                <button class="btn btn-ghost" @click="doReqReturn">退回入库</button>
              </div>
              <div class="tiny mut">按第一行物品退回；要退多项请分次操作</div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- ---------------- 新建采购 ---------------- -->
    <div class="modal-mask" v-if="poForm.open" @click.self="poForm.open = false">
      <div class="modal wide">
        <div class="modal-head"><b>新建采购</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="poForm.open = false">取消</button></div>
        <div class="modal-body">
          <div class="row">
            <label>类型</label>
            <select v-model="poForm.kind" class="input" style="width: 120px">
              <option value="item">物品采购</option>
              <option value="service">服务采购</option>
            </select>
            <label>供应商</label>
            <input v-model="poForm.supplier" class="input" style="flex: 1" placeholder="供应商 / 服务商名称" />
          </div>
          <div class="row">
            <label>归属部门</label>
            <select v-model="poForm.dept_id" class="input" style="width: 150px">
              <option :value="null">默认行政</option>
              <option v-for="d in meta.depts || []" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <label>预计到货</label>
            <input v-model="poForm.expected_date" class="input" type="date" style="width: 150px" />
          </div>

          <template v-if="poForm.kind === 'item'">
            <div class="col-h">从已批准的申领合并<span class="mut tiny">（同一物品会自动汇总成一行，不用分开买）</span></div>
            <div v-if="approvedReqs.length" class="merge-box">
              <label v-for="r in approvedReqs" :key="r.id" class="ck merge-row">
                <input type="checkbox" :value="r.id" v-model="poForm.request_ids" />
                <span>{{ r.req_no }} · {{ r.dept_name || '—' }} · {{ r.items.map((x) => x.item_name + '×' + x.qty_approved).join('、') }}</span>
              </label>
            </div>
            <div v-else class="tiny mut" style="margin-bottom: 8px">没有已批准待采购的申领。</div>
            <div class="tiny mut" v-if="poForm.request_ids.length" style="margin-bottom: 8px">
              已选 {{ poForm.request_ids.length }} 张申领。合并后<b>单价需要再填</b>（申领里只有数量，没有价格）。
            </div>

            <div class="col-h">直接加物品<span class="mut tiny">（不通过申领，比如备库存）</span></div>
          </template>
          <div class="col-h" v-else>服务明细<span class="mut tiny">（保洁、维修、快递这类，没有库存，验收即计费）</span></div>

          <table class="data">
            <thead><tr><th>物品 / 服务</th><th style="width: 90px">数量</th><th style="width: 110px">单价</th><th style="width: 60px"></th></tr></thead>
            <tbody>
              <tr v-for="(ln, i) in poForm.items" :key="i">
                <td>
                  <select v-if="poForm.kind === 'item'" v-model="ln.item_id" class="input" style="width: 100%">
                    <option :value="null">选择物品</option>
                    <option v-for="it in allItems" :key="it.id" :value="it.id">{{ it.name }}{{ it.durable ? '（耐用品→转资产）' : '' }}</option>
                  </select>
                  <input v-else v-model="ln.item_name" class="input" style="width: 100%" placeholder="如 办公区保洁（10 月）" />
                </td>
                <td><input v-model="ln.qty" class="input" type="number" style="width: 76px" /></td>
                <td><input v-model="ln.price" class="input" type="number" style="width: 96px" /></td>
                <td><button class="btn btn-sm btn-ghost" @click="poForm.items.splice(i, 1)" v-if="poForm.items.length > 1">删</button></td>
              </tr>
            </tbody>
          </table>
          <div class="row"><button class="btn btn-sm btn-ghost" @click="poForm.items.push(blankPoLine())">加一行</button></div>

          <div class="modal-foot"><button class="btn btn-primary" @click="savePo">建单</button></div>
        </div>
      </div>
    </div>

    <!-- ---------------- 采购详情 ---------------- -->
    <div class="modal-mask" v-if="poDetail" @click.self="poDetail = null">
      <div class="modal wide">
        <div class="modal-head">
          <div class="mh-left">
            <b>{{ poDetail.po_no }}</b>
            <span class="tag" :class="poCls(poDetail.status)">{{ poDetail.status_label }}</span>
            <span class="tag" :class="poDetail.kind === 'service' ? 'purple' : 'gray'">{{ poDetail.kind_label }}</span>
          </div>
          <span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="poDetail = null">关闭</button>
        </div>
        <div class="modal-body">
          <div class="kv"><span>供应商</span><b>{{ poDetail.supplier || '—' }}</b></div>
          <div class="kv"><span>归属部门</span><b>{{ poDetail.dept_name || '未填（费用不会占预算）' }}</b></div>
          <div class="kv"><span>金额</span><b>{{ money(poDetail.total_amount) }}</b></div>
          <div class="kv" v-if="poDetail.sources.length"><span>合并申领</span><b>{{ poDetail.sources.map((s) => s.req_no).join('、') }}</b></div>
          <div class="kv" v-if="poDetail.status === 'received'">
            <span>验收结果</span>
            <b>计费用 {{ money(poDetail.expense_amount) }} · 转资产 {{ money(poDetail.asset_amount) }}</b>
          </div>

          <table class="data" style="margin-top: 10px">
            <thead><tr><th>明细</th><th style="width: 80px">数量</th><th style="width: 130px">单价</th><th style="width: 100px">金额</th><th style="width: 90px">归属</th></tr></thead>
            <tbody>
              <tr v-for="it in poDetail.items" :key="it.id">
                <td>{{ it.item_name }} <span class="tiny mut">{{ it.spec || '' }}</span></td>
                <td class="num">{{ num(it.qty) }} {{ it.unit || '' }}</td>
                <td>
                  <input v-if="canEditPrice" v-model="it.price" class="input" type="number" style="width: 110px" @change="savePrice(it)" />
                  <span v-else class="num">{{ money(it.price) }}</span>
                </td>
                <td class="num">{{ money(it.amount) }}</td>
                <td>
                  <span v-if="it.line_type === 'service'" class="tag purple">服务→费用</span>
                  <span v-else-if="it.durable" class="tag blue">耐用品→资产</span>
                  <span v-else class="tag gray">耗材→费用</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="hint-box" v-if="poDetail.status === 'received'">
            <b>验收已经做完三件事</b>：耗材入库并计入费用 {{ money(poDetail.expense_amount) }}；
            <template v-if="poDetail.asset_amount">耐用品 {{ money(poDetail.asset_amount) }} 已转成资产卡（在「资产台账」里能看到），<b>不再计入费用</b>；</template>
            费用已自动记入行政支出并占用预算。
          </div>

          <div class="actions" v-if="poDetail.can.approve || poDetail.can.receive || poDetail.can.cancel">
            <div class="row" v-if="poDetail.can.approve">
              <button class="btn btn-primary" @click="doPoApprove">审批通过</button>
              <button class="btn btn-ghost" @click="doPoOrder">标为已下单</button>
              <span class="tiny mut">金额为 0 不能审批，先把单价填上</span>
            </div>
            <div class="row" v-if="poDetail.can.receive">
              <select v-model="poAct.payment_method" class="input" style="width: 130px">
                <option value="转账">转账</option>
                <option value="现金">现金</option>
                <option value="月结">月结</option>
                <option value="其他">其他</option>
              </select>
              <button class="btn btn-primary" @click="doPoReceive">验收</button>
              <span class="tiny mut">验收会入库 / 转资产 / 生成费用，一次做完</span>
            </div>
            <div class="row" v-if="poDetail.can.cancel">
              <input v-model="poAct.cancel" class="input" style="flex: 1" placeholder="撤销原因（≥4 字）" />
              <button class="btn btn-ghost" @click="doPoCancel">撤销</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';

const tab = ref('items');
const kw = ref('');
const meta = ref({});
const stats = ref({});
const items = ref([]);
const reqs = ref([]);
const pos = ref([]);
const low = ref({ rows: [], count: 0, note: '' });
const reqDetail = ref(null);
const poDetail = ref(null);

const itemForm = reactive({
  open: false, id: null, name: '', spec: '', category: 'stationery', unit: '个',
  min_qty: 0, monthly_limit: 0, durable: false, asset_category: '', useful_years: 5
});
const ledgerBox = reactive({ open: false, item: null, rows: [] });
const reqForm = reactive({ open: false, dept_id: null, requester_name: '', purpose: '', exception_reason: '', items: [{ item_id: null, qty_apply: 1 }] });
const reqAct = reactive({ reject: '', returnQty: '', returnReason: '' });
const poForm = reactive({ open: false, kind: 'item', supplier: '', dept_id: null, expected_date: '', request_ids: [], items: [] });
const poAct = reactive({ payment_method: '转账', cancel: '' });

const num = (v) => Number(v || 0);
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const role = computed(() => (auth.user && auth.user.role) || '');
const canManage = computed(() => ['admin', 'hr', 'finance'].includes(role.value));

const allItems = computed(() => items.value);
const consumables = computed(() => items.value.filter((x) => !num(x.durable)));
const durableCount = computed(() => items.value.filter((x) => num(x.durable)).length);
const approvedReqs = computed(() => reqs.value.filter((r) => r.status === 'approved' && !r.merged));
const canEditPrice = computed(() => poDetail.value && ['draft', 'submitted'].includes(poDetail.value.status) && canManage.value);

const reqCls = (s) => ({ submitted: 'amber', approved: 'blue', issued: 'green', returned: 'purple', rejected: 'gray', draft: 'gray', closed: 'gray' }[s] || 'gray');
const poCls = (s) => ({ draft: 'gray', approved: 'blue', ordered: 'amber', received: 'green', closed: 'gray', cancelled: 'red' }[s] || 'gray');

function stockLabel(itemId) {
  const it = items.value.find((x) => x.id === itemId);
  return it ? `${num(it.qty)} ${it.unit}` : '—';
}

async function reload() {
  try {
    const m = await api.offMeta();
    meta.value = m;
    stats.value = m.stats || {};
  } catch (e) { /* 字典失败不该拖垮清单 */ }
  const q = kw.value ? { q: kw.value } : {};
  await Promise.all([
    api.offBoard(q).then((r) => { items.value = r || []; }).catch(() => { items.value = []; }),
    api.offRequests(kw.value ? { q: kw.value } : {}).then((r) => { reqs.value = r || []; }).catch(() => { reqs.value = []; }),
    api.offPurchases(kw.value ? { q: kw.value } : {}).then((r) => { pos.value = r || []; }).catch(() => { pos.value = []; }),
    api.offLowStock().then((r) => { low.value = r; }).catch(() => {})
  ]);
}

/* ---------------- 物品 ---------------- */
function openItemForm(it) {
  Object.assign(itemForm, {
    open: true,
    id: it ? it.id : null,
    name: it ? it.name : '',
    spec: it ? (it.spec || '') : '',
    category: it ? it.category : 'stationery',
    unit: it ? it.unit : '个',
    min_qty: it ? num(it.min_qty) : 0,
    monthly_limit: it ? num(it.monthly_limit) : 0,
    durable: it ? !!num(it.durable) : false,
    asset_category: it ? (it.asset_category || '') : '',
    useful_years: it ? (it.useful_years || 5) : 5
  });
}

async function saveItem() {
  try {
    await api.offSaveItem({ ...itemForm, durable: itemForm.durable ? 1 : 0 });
    itemForm.open = false;
    await reload();
  } catch (e) { alert(e.message); }
}

async function openLedger(it) {
  try {
    ledgerBox.item = it;
    ledgerBox.rows = await api.offLedger({ item_id: it.id });
    ledgerBox.open = true;
  } catch (e) { alert(e.message); }
}

/* ---------------- 申领 ---------------- */
function openReqForm() {
  Object.assign(reqForm, {
    open: true, dept_id: null, requester_name: '', purpose: '', exception_reason: '',
    items: [{ item_id: null, qty_apply: 1 }]
  });
}

async function saveReq(submit) {
  try {
    const r = await api.offSaveReq({
      dept_id: reqForm.dept_id,
      requester: (auth.user && auth.user.username) || 'me',
      requester_name: reqForm.requester_name,
      purpose: reqForm.purpose,
      exception_reason: reqForm.exception_reason,
      items: reqForm.items.filter((x) => x.item_id),
      submit
    });
    reqForm.open = false;
    await reload();
    alert(r.note || '已保存');
  } catch (e) { alert(e.message); }
}

async function openReq(id) {
  try {
    reqDetail.value = await api.offReqDetail(id);
    reqAct.reject = '';
    reqAct.returnQty = '';
    reqAct.returnReason = '';
  } catch (e) { alert(e.message); }
}

async function refreshReq() {
  if (!reqDetail.value) return;
  const id = reqDetail.value.id;
  reqDetail.value = await api.offReqDetail(id);
  await reload();
}

async function doReqSubmit() {
  try { await api.offReqSubmit(reqDetail.value.id); await refreshReq(); } catch (e) { alert(e.message); }
}
async function doReqApprove() {
  try {
    const r = await api.offReqApprove(reqDetail.value.id, {
      items: reqDetail.value.items.map((x) => ({ id: x.id, qty_approved: num(x.qty_approved) }))
    });
    await refreshReq();
    alert(r.note || '已批准');
  } catch (e) { alert(e.message); }
}
async function doReqReject() {
  try {
    await api.offReqReject(reqDetail.value.id, { reason: reqAct.reject });
    await refreshReq();
  } catch (e) { alert(e.message); }
}
async function doReqIssue() {
  try {
    const r = await api.offReqIssue(reqDetail.value.id);
    await refreshReq();
    alert(r.note);
  } catch (e) { alert(e.message); }
}
async function doReqReturn() {
  try {
    const first = reqDetail.value.items[0];
    const r = await api.offReqReturn(reqDetail.value.id, {
      items: [{ id: first.id, qty: num(reqAct.returnQty) }],
      reason: reqAct.returnReason
    });
    await refreshReq();
    alert(r.note);
  } catch (e) { alert(e.message); }
}

/* ---------------- 采购 ---------------- */
function blankPoLine() {
  return { item_id: null, item_name: '', qty: 1, price: 0 };
}

function openPoForm() {
  Object.assign(poForm, {
    open: true, kind: 'item', supplier: '', dept_id: null, expected_date: '',
    request_ids: [], items: [blankPoLine()]
  });
}

async function savePo() {
  try {
    const fromReq = poForm.kind === 'item' && poForm.request_ids.length > 0;
    const body = {
      kind: poForm.kind,
      supplier: poForm.supplier,
      dept_id: poForm.dept_id,
      expected_date: poForm.expected_date || null,
      request_ids: fromReq ? poForm.request_ids : [],
      items: fromReq ? [] : poForm.items
        .filter((x) => (poForm.kind === 'item' ? x.item_id : String(x.item_name || '').trim()))
        .map((x) => ({
          item_id: x.item_id,
          item_name: x.item_name,
          line_type: poForm.kind === 'service' ? 'service' : 'item',
          qty: num(x.qty),
          price: num(x.price)
        }))
    };
    const r = await api.offCreatePo(body);
    poForm.open = false;
    await reload();
    alert(`${r.po_no}：${r.note}`);
  } catch (e) { alert(e.message); }
}

async function openPo(id) {
  try {
    poDetail.value = await api.offPoDetail(id);
    poAct.cancel = '';
  } catch (e) { alert(e.message); }
}

async function refreshPo() {
  if (!poDetail.value) return;
  poDetail.value = await api.offPoDetail(poDetail.value.id);
  await reload();
}

async function savePrice(line) {
  try {
    await api.offPoPrices(poDetail.value.id, { items: [{ id: line.id, price: num(line.price) }] });
    await refreshPo();
  } catch (e) { alert(e.message); }
}

async function doPoApprove() {
  try { await api.offPoApprove(poDetail.value.id); await refreshPo(); } catch (e) { alert(e.message); }
}
async function doPoOrder() {
  try { await api.offPoOrder(poDetail.value.id, {}); await refreshPo(); } catch (e) { alert(e.message); }
}
async function doPoReceive() {
  if (!confirm('验收会同时：耗材入库、耐用品转资产、生成费用并占用预算。确认到货无误？')) return;
  try {
    const r = await api.offPoReceive(poDetail.value.id, { payment_method: poAct.payment_method });
    await refreshPo();
    alert(`验收完成：\n${r.note}`);
  } catch (e) { alert(e.message); }
}
async function doPoCancel() {
  try {
    const r = await api.offPoCancel(poDetail.value.id, { reason: poAct.cancel });
    await refreshPo();
    alert(r.note);
  } catch (e) { alert(e.message); }
}

onMounted(reload);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; }
.panel .tag { white-space: nowrap; }

.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 100px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 11px; line-height: 1.4; }
.stat-card.warn { border-color: #fde68a; background: #fffdf5; }

.ell { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiny { font-size: 11px; line-height: 1.45; }
.mut { color: #7b8698; }
.red { color: #b91c1c; }
.amber-t { color: #92400e; }
.green-t { color: #047857; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.empty { padding: 26px 6px; color: #7b8698; font-size: 12.5px; }
.table-wrap { overflow-x: auto; }
table.data td { vertical-align: middle; }
table.data .tag { white-space: nowrap; }
table.data td b { white-space: nowrap; }
table.data .btn { white-space: nowrap; }
.ops { white-space: nowrap; }
.ops .btn + .btn { margin-left: 6px; }

.notice { border: 1px solid #dbeafe; background: #f6faff; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #1e3a5f; margin-bottom: 10px; }
.notice-warn { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #92400e; margin-bottom: 10px; }
.hint-box { border: 1px solid #bbf7d0; background: #f5fdf8; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #14532d; margin-top: 10px; }

.modal.wide { width: min(1020px, 94vw); }
.mh-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.col-h { font-size: 12.5px; font-weight: 600; color: #16233b; margin: 12px 0 6px; }
.kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.kv > span { color: #7b8698; min-width: 70px; flex: 0 0 auto; }
.kv > b { font-weight: 500; }

.actions { border-top: 1px solid #eef1f6; margin-top: 14px; padding-top: 12px; }
.actions .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.actions .row label { font-size: 12px; color: #7b8698; }
.actions .row .btn { flex: 0 0 auto; }

.modal-body .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.modal-body .row label { font-size: 12px; color: #7b8698; flex: 0 0 auto; min-width: 58px; }
.modal-body .row label.ck { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.modal-body .row .btn { flex: 0 0 auto; }

.merge-box { border: 1px solid #eef1f6; border-radius: 9px; padding: 8px 11px; margin-bottom: 8px; max-height: 150px; overflow-y: auto; }
.merge-row { display: flex !important; align-items: flex-start; gap: 6px; font-size: 12px; padding: 3px 0; min-width: 0 !important; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .head-ops { flex-wrap: wrap; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
}
</style>
