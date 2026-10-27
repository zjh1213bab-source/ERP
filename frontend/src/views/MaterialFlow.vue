<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>备料领退与盘点差异</h2>
        <p class="sub">
          原料库存第一次有了<b>流水支撑</b>：谁收的、谁领的、退了几米、盘亏在哪一步，都查得到。
          <b>备料就占用</b>（避免两个车间各领满一份）、<b>发料才扣减</b>；欠发不会静默变齐套；
          退料不许超过已领未退；<b>盘点期间冻结收发</b>；有差异必须写原因，<b>没有采购价的差异只调数量、不计金额</b>。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite && tab === 'issues'" class="btn btn-primary" @click="openNewIssue">新建备料单</button>
        <button v-if="canWrite && tab === 'returns'" class="btn btn-primary" @click="openNewReturn">新建退料单</button>
        <button v-if="canWrite && tab === 'count'" class="btn btn-primary" @click="openNewTake">新建盘点</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat" :class="board.open_short_count ? 'st-warn' : ''">
        <span>待发与欠发</span>
        <strong>{{ board.open_short_count || 0 }}</strong>
        <small>张单还有原料没发出去</small>
      </div>
      <div class="stat">
        <span>已备料占用</span>
        <strong>{{ num(board.stat && board.stat.prepared) }}</strong>
        <small>张单，占着库存但车间还没领</small>
      </div>
      <div class="stat">
        <span>本期领料金额</span>
        <strong class="mono">{{ money(board.stat && board.stat.amount) }}</strong>
        <small>{{ board.from }} ~ {{ board.to }} 已发料</small>
      </div>
      <div class="stat" :class="board.running_take ? 'st-warn' : ''">
        <span>盘点状态</span>
        <strong class="sm">{{ board.running_take ? takeBoardLabel(board.running_take.status) : '无进行中' }}</strong>
        <small>{{ board.running_take ? board.running_take.take_no + freezeNote(board.running_take.status) : '库存可正常收发' }}</small>
      </div>
      <div class="stat" :class="board.last_take && board.last_take.uncosted_count ? 'st-bad' : ''">
        <span>上次盘点差异</span>
        <strong>{{ board.last_take ? board.last_take.diff_count : 0 }}</strong>
        <small v-if="board.last_take">
          盘盈 {{ money(board.last_take.gain_amount) }} / 盘亏 {{ money(board.last_take.loss_amount) }}
        </small>
        <small v-else>还没做过盘点</small>
      </div>
      <div class="stat" :class="zeroCount ? 'st-bad' : ''">
        <span>零库存原料</span>
        <strong>{{ zeroCount }}</strong>
        <small>齐套会被这些卡住</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'stock' }" @click="go('stock')">原料台账</button>
        <button :class="{ on: tab === 'issues' }" @click="go('issues')">备料与领料</button>
        <button :class="{ on: tab === 'returns' }" @click="go('returns')">退料</button>
        <button :class="{ on: tab === 'count' }" @click="go('count')">盘点差异</button>
      </div>
    </div>

    <!-- ==================== 原料台账 ==================== -->
    <div v-if="tab === 'stock'">
      <div class="toolbar">
        <select v-model="stockFilter.type" @change="loadStock">
          <option value="">全部类型</option>
          <option value="fabric">面料</option>
          <option value="accessory">辅料</option>
        </select>
        <label class="tiny muted chk"><input v-model="stockFilter.only_short" type="checkbox" />只看可用不足</label>
        <span class="grow"></span>
        <span class="tiny muted">
          账面 {{ stock.rows.length }} 种；占用合计 {{ num(stock.stat && stock.stat.reserved) }}；
          可用为负 {{ (stock.stat && stock.stat.shortage) || 0 }} 种
        </span>
      </div>
      <div class="help-bar">
        <b>三个数必须分得清</b>：<b>账面</b>＝仓库实物；<b>占用</b>＝已备料还没发出去（货还在仓里，但已被某张单定住）；<b>可用</b>＝账面 − 占用。
        只看账面会重复备料，只看可用会以为仓库空了。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>料号</th><th>名称</th><th>规格</th><th>单位</th>
              <th class="num">账面</th><th class="num">占用</th><th class="num">可用</th>
              <th class="num">本期入</th><th class="num">本期出</th>
              <th class="num">最近采购价</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in stockShown" :key="r.id" :class="{ 'row-bad': r.neg }">
              <td class="mono tiny">{{ r.code || '—' }}</td>
              <td>
                {{ r.name }}
                <span class="tag" :class="r.type === 'fabric' ? 'blue' : 'gray'">{{ r.type_label }}</span>
              </td>
              <td class="tiny muted">{{ r.spec || '—' }}</td>
              <td class="tiny">{{ r.unit || '—' }}</td>
              <td class="num" :class="{ red: r.neg }">{{ num(r.stock_qty) }}</td>
              <td class="num" :class="{ orange: r.reserved > 0 }">{{ r.reserved ? num(r.reserved) : '' }}</td>
              <td class="num"><b>{{ num(r.available) }}</b></td>
              <td class="num tiny ok-line">{{ r.in_qty ? '+' + num(r.in_qty) : '' }}</td>
              <td class="num tiny muted">{{ r.out_qty ? '−' + num(r.out_qty) : '' }}</td>
              <td class="num tiny">{{ r.price === null ? '—' : money(r.price) }}</td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="showLedger(r)">流水</button>
              </td>
            </tr>
            <tr v-if="!stockShown.length">
              <td colspan="11" class="empty">没有原料档案。请先在「系统设置 → 面料/辅料库」维护。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 备料与领料 ==================== -->
    <div v-if="tab === 'issues'">
      <div class="help-bar">
        <b>流程是一条线</b>：草稿（可以改）→ <b>备料</b>（占用库存，别人领不走）→ <b>发料</b>（真扣库存，写流水）→ 结案。
        实发小于需求时单据停在<b>「部分发出」</b>，欠多少一直挂在行上——车间少了料，齐套和成本都看得见。
      </div>
      <div class="toolbar">
        <select v-model="issueFilter.status" @change="loadIssues">
          <option value="">全部状态</option>
          <option v-for="(v, k) in dict.issue_status || {}" :key="k" :value="k">{{ v }}</option>
        </select>
        <input v-model="issueFilter.order_no" placeholder="订单号" class="inp" @keyup.enter="loadIssues" />
        <button class="btn btn-ghost btn-sm" @click="loadIssues">查询</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>单号</th><th>类型</th><th>订单</th><th>需求日</th>
              <th class="num">需求</th><th class="num">已发</th><th class="num">待发/欠发</th>
              <th class="num">金额</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in issues" :key="r.id" :class="{ 'row-warn': r.overdue }">
              <td class="mono tiny">{{ r.issue_no }}</td>
              <td class="tiny">{{ r.kind_label }}</td>
              <td class="tiny">{{ r.order_no || '—' }}</td>
              <td class="tiny" :class="{ red: r.overdue }">
                {{ r.req_date || '—' }}<span v-if="r.overdue" class="tag red">逾期</span>
              </td>
              <td class="num">{{ num(r.req_qty) }}</td>
              <td class="num">{{ num(r.issued_qty) }}</td>
              <td class="num" :class="{ orange: r.open_qty > 0 }">{{ r.open_qty ? num(r.open_qty) : '' }}</td>
              <td class="num tiny">{{ money(r.amount) }}</td>
              <td><span class="tag" :class="issueTag(r.status)">{{ r.status_label }}</span></td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openIssue(r.id)">明细</button>
              </td>
            </tr>
            <tr v-if="!issues.length">
              <td colspan="10" class="empty">还没有备料单。点右上「新建备料单」，选订单会自动带出用料。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 退料 ==================== -->
    <div v-if="tab === 'returns'">
      <div class="help-bar">
        退料是<b>领料的反向操作</b>，必须挂在一张已发料的单上——否则退回来的东西来路不明。
        <b>可退量 = 已发 − 已退</b>，退不了第二次。原因必填：余料退回、规格不符、质量不合格、订单取消。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>退料单</th><th>对应领料单</th><th>订单</th><th>类型</th>
              <th class="num">数量</th><th class="num">金额</th><th>原因</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in returns" :key="r.id">
              <td class="mono tiny">{{ r.return_no }}</td>
              <td class="mono tiny">{{ r.issue_no || '—' }}</td>
              <td class="tiny">{{ r.order_no || '—' }}</td>
              <td class="tiny">{{ r.type_label }}</td>
              <td class="num">{{ num(r.qty) }}</td>
              <td class="num tiny">{{ money(r.amount) }}</td>
              <td class="tiny wrap" style="max-width: 260px">{{ r.reason }}</td>
              <td><span class="tag" :class="r.status === 'confirmed' ? 'green' : (r.status === 'draft' ? 'orange' : 'gray')">{{ r.status_label }}</span></td>
              <td class="ops">
                <button v-if="canWrite && r.status === 'draft'" class="btn btn-primary btn-sm" @click="confirmReturn(r)">确认入库</button>
                <span v-else class="tiny muted">{{ r.confirmed_by || '—' }}</span>
              </td>
            </tr>
            <tr v-if="!returns.length">
              <td colspan="9" class="empty">还没有退料单。余料退回在领料详情里点「退料」。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 盘点 ==================== -->
    <div v-if="tab === 'count'">
      <div class="help-bar">
        <b>盘点是为了找差异，不是为了把账调平</b>。开始盘点即冻结原料收发，防止「边盘边动」；
        每条差异必须写原因（盘盈也要写）；<b>没盘的行不能当 0</b>，不许蒙混过关；
        没有采购价的原料只调数量、<b>金额留空显示「未计价」</b>，不拿 0 冒充「没损失」。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>盘点单</th><th>盘点日</th><th>类型</th>
              <th class="num">品种</th><th class="num">差异</th><th class="num">盘盈金额</th><th class="num">盘亏金额</th>
              <th class="num">未计价</th><th>盘点人</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in stocktakes" :key="r.id" :class="{ 'row-warn': r.status === 'submitted' }">
              <td class="mono tiny">{{ r.take_no }}</td>
              <td class="tiny">{{ r.take_date }}</td>
              <td class="tiny">原料</td>
              <td class="num">{{ r.item_count }}</td>
              <td class="num" :class="{ orange: r.diff_count > 0 }">{{ r.diff_count || '' }}</td>
              <td class="num tiny ok-line">{{ r.gain_amount ? money(r.gain_amount) : '' }}</td>
              <td class="num tiny red">{{ r.loss_amount ? money(r.loss_amount) : '' }}</td>
              <td class="num tiny" :class="{ red: r.uncosted_count > 0 }">{{ r.uncosted_count || '' }}</td>
              <td class="tiny">{{ r.counter || '—' }}</td>
              <td><span class="tag" :class="takeTag(r.status)">{{ r.status_label }}</span></td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openTake(r.id)">盘点表</button>
              </td>
            </tr>
            <tr v-if="!stocktakes.length">
              <td colspan="11" class="empty">还没有盘点单。点右上「新建盘点」会把有档案的原料全部列上。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 新建备料单 ==================== -->
    <div v-if="newIssue.open" class="modal-mask" @click.self="newIssue.open = false">
      <div class="modal wide">
        <h3>新建备料单</h3>
        <div class="fgrid">
          <label>类型
            <select v-model="newIssue.kind">
              <option value="order">订单备料</option>
              <option value="extra">车间补料</option>
              <option value="sample">打样领料</option>
            </select>
          </label>
          <label>订单
            <select v-model="newIssue.order_id" @change="loadSuggest">
              <option value="">请选择</option>
              <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || '' }}</option>
            </select>
          </label>
          <label>需求日 <input v-model="newIssue.req_date" type="date" /></label>
          <label>发料对象
            <select v-model="newIssue.receiver_type">
              <option value="own">本厂车间</option>
              <option value="outsource">外协工厂</option>
            </select>
          </label>
        </div>
        <label class="fl">说明{{ newIssue.kind === 'extra' ? '（补料必填原因）' : '' }}
          <input v-model="newIssue.note" placeholder="例如：首批裁片污损需补料" />
        </label>

        <div v-if="newIssue.loading" class="tiny muted" style="margin: 10px 0">正在按订单用料计算需求…</div>
        <div v-else-if="suggest && suggest.items && suggest.items.length" class="table-wrap" style="max-height: 320px">
          <table class="data">
            <thead>
              <tr>
                <th>原料</th><th>单位</th><th class="num">订单总用量</th><th class="num">已领</th>
                <th class="num">本次需求</th><th class="num">可用</th><th class="num">缺口</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in newIssue.items" :key="i" :class="{ 'row-bad': it.gap > 0 }">
                <td>
                  {{ it.name }}
                  <span v-if="!it.material_id" class="tag red">未关联档案</span>
                </td>
                <td class="tiny">{{ it.unit || '—' }}</td>
                <td class="num tiny">{{ num(it.order_total) }}</td>
                <td class="num tiny muted">{{ it.already_issued ? num(it.already_issued) : '' }}</td>
                <td class="num"><input v-model.number="it.req_qty" type="number" class="mini-inp" min="0" step="0.01" /></td>
                <td class="num tiny">{{ it.available === null ? '—' : num(it.available) }}</td>
                <td class="num tiny" :class="{ red: it.gap > 0 }">{{ it.gap > 0 ? num(it.gap) : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="tiny muted" style="margin: 10px 0">
          选订单后自动带出该单用料（来自订单的「面辅料用量」，含损耗）。没有用料记录就手工加行。
        </div>

        <div class="ops-row">
          <button class="btn btn-ghost btn-sm" @click="addManualRow">手工加一行</button>
          <span class="grow"></span>
          <span class="tiny muted">提交后是草稿，还要点「备料」才占用库存</span>
        </div>

        <div v-if="newIssue.manual.length" class="table-wrap" style="margin-top: 8px">
          <table class="data">
            <thead><tr><th>原料</th><th>单位</th><th class="num">需求</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in newIssue.manual" :key="'m' + i">
                <td>
                  <select v-model="m.material_id" style="min-width: 200px">
                    <option value="">请选择原料</option>
                    <option v-for="s in stock.rows" :key="s.id" :value="s.id">{{ s.name }}{{ s.spec ? ' / ' + s.spec : '' }}</option>
                  </select>
                </td>
                <td class="tiny">{{ unitOf(m.material_id) }}</td>
                <td class="num"><input v-model.number="m.req_qty" type="number" class="mini-inp" min="0" step="0.01" /></td>
                <td><button class="btn btn-ghost btn-sm" @click="newIssue.manual.splice(i, 1)">删</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-ops">
          <button class="btn btn-ghost" @click="newIssue.open = false">取消</button>
          <button class="btn btn-primary" :disabled="newIssue.saving" @click="submitIssue">
            {{ newIssue.saving ? '提交中…' : '创建（草稿）' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 领料单详情 ==================== -->
    <div v-if="detail.open" class="modal-mask" @click.self="detail.open = false">
      <div class="modal xxwide">
        <h3>
          {{ detail.data.issue_no }}
          <span class="tag" :class="issueTag(detail.data.status)">{{ detail.data.status_label }}</span>
          <span class="tag gray">{{ detail.data.kind_label }}</span>
        </h3>
        <div class="kv">
          <div><span>订单</span><b>{{ detail.data.order_no || '—' }}</b></div>
          <div><span>款名</span><b>{{ detail.data.style_no || '—' }}</b></div>
          <div><span>需求日</span><b>{{ detail.data.req_date || '—' }}</b></div>
          <div><span>已发金额</span><b>{{ money(detail.data.amount) }}</b></div>
          <div><span>备料</span><b>{{ detail.data.prepared_by || '—' }}</b><small>{{ detail.data.prepared_at || '' }}</small></div>
          <div><span>发料</span><b>{{ detail.data.issued_by || '—' }}</b><small>{{ detail.data.issued_at || '' }}</small></div>
        </div>
        <div v-if="detail.data.note" class="tiny muted" style="margin: 6px 0">说明：{{ detail.data.note }}</div>

        <div class="table-wrap" style="max-height: 300px">
          <table class="data">
            <thead>
              <tr>
                <th>原料</th><th>缸号</th><th class="num">需求</th><th class="num">已发</th>
                <th class="num">欠发</th><th class="num">已退</th><th class="num">可退</th><th class="num">可用(不含本单)</th><th class="num">金额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in detail.data.items" :key="it.id" :class="{ 'row-warn': it.short > 0 }">
                <td>{{ it.name }}<span v-if="it.spec" class="tiny muted"> · {{ it.spec }}</span></td>
                <td class="tiny mono">{{ it.batch_no || '—' }}</td>
                <td class="num">{{ num(it.req_qty) }}<span class="tiny muted">{{ it.unit }}</span></td>
                <td class="num">{{ num(it.issued_qty) }}</td>
                <td class="num" :class="{ orange: it.short > 0 }">{{ it.short ? num(it.short) : '' }}</td>
                <td class="num tiny muted">{{ it.returned_qty ? num(it.returned_qty) : '' }}</td>
                <td class="num tiny">{{ it.returnable ? num(it.returnable) : '' }}</td>
                <td class="num tiny" :class="{ red: it.available !== null && it.available < 0 }">{{ it.available === null ? '—' : num(it.available) }}</td>
                <td class="num tiny">{{ it.price === null ? '未计价' : money(it.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="detail.data.returns && detail.data.returns.length" style="margin-top: 12px">
          <h4 class="sec">退料记录</h4>
          <div v-for="r in detail.data.returns" :key="r.id" class="line-row">
            <span class="mono tiny">{{ r.return_no }}</span>
            <span class="tag gray">{{ r.type_label }}</span>
            <span>{{ num(r.qty) }} · {{ money(r.amount) }}</span>
            <span class="tiny muted">{{ r.reason }}</span>
            <span class="tag" :class="r.status === 'confirmed' ? 'green' : 'orange'">{{ r.status === 'confirmed' ? '已入库' : '草稿' }}</span>
          </div>
        </div>

        <div v-if="detail.data.ledgers && detail.data.ledgers.length" style="margin-top: 12px">
          <h4 class="sec">库存流水（这笔单动了什么）</h4>
          <div class="table-wrap" style="max-height: 180px">
            <table class="data">
              <thead><tr><th>时间</th><th>原料</th><th>类型</th><th class="num">数量</th><th>备注</th><th>操作人</th></tr></thead>
              <tbody>
                <tr v-for="l in detail.data.ledgers" :key="l.id">
                  <td class="tiny mono">{{ l.created_at }}</td>
                  <td class="tiny">{{ l.material_name }}</td>
                  <td class="tiny">{{ l.type_label || l.type }}</td>
                  <td class="num" :class="l.qty > 0 ? 'ok-line' : 'red'">{{ l.qty > 0 ? '+' : '' }}{{ num(l.qty) }}</td>
                  <td class="tiny wrap" style="max-width: 240px">{{ l.remark }}</td>
                  <td class="tiny">{{ l.operator }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="modal-ops">
          <button v-if="canWrite && detail.data.can && detail.data.can.cancel" class="btn btn-ghost" @click="cancelIssue">取消单据</button>
          <button v-if="canWrite && detail.data.can && detail.data.can.return" class="btn btn-ghost" @click="openReturnFromIssue">退料</button>
          <button v-if="canWrite && detail.data.can && detail.data.can.close" class="btn btn-ghost" @click="closeIssue">结案</button>
          <span class="grow"></span>
          <button class="btn btn-ghost" @click="detail.open = false">关闭</button>
          <button v-if="canWrite && detail.data.can && detail.data.can.issue" class="btn btn-primary" @click="openOut">发料</button>
          <button v-if="canWrite && detail.data.can && detail.data.can.prepare" class="btn btn-primary" @click="prepareIssue">备料（占用库存）</button>
        </div>
      </div>
    </div>

    <!-- ==================== 发料 ==================== -->
    <div v-if="out.open" class="modal-mask" @click.self="out.open = false">
      <div class="modal">
        <h3>发料出库</h3>
        <div class="help-inline">
          默认按未发量全发；可以少发（车间只要一部分），少发的部分会一直挂在「欠发」上。
          <b>发料会真扣库存并写流水</b>，发出去就退不回来，只能走退料。
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>原料</th><th class="num">未发</th><th class="num">可用</th><th class="num">本次发</th><th>缸号</th></tr></thead>
            <tbody>
              <tr v-for="it in out.items" :key="it.id">
                <td>{{ it.name }}</td>
                <td class="num tiny">{{ num(it.req_qty - it.issued_qty) }}</td>
                <td class="num tiny" :class="{ red: it.available !== null && it.available < 0 }">{{ it.available === null ? '—' : num(it.available) }}</td>
                <td class="num"><input v-model.number="it.send" type="number" class="mini-inp" min="0" step="0.01" /></td>
                <td><input v-model="it.batch_no" class="mini-inp" style="width: 84px; text-align: left" placeholder="选填" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="out.open = false">取消</button>
          <button class="btn btn-primary" @click="doOut">确认发料</button>
        </div>
      </div>
    </div>

    <!-- ==================== 退料弹窗 ==================== -->
    <div v-if="ret.open" class="modal-mask" @click.self="ret.open = false">
      <div class="modal">
        <h3>新建退料</h3>
        <div class="fgrid">
          <label>对应领料单
            <select v-model="ret.issue_id" @change="loadReturnItems">
              <option value="">请选择</option>
              <option v-for="i in returnableIssues" :key="i.id" :value="i.id">{{ i.issue_no }} · {{ i.order_no || '无订单' }} · {{ i.status_label }}</option>
            </select>
          </label>
          <label>类型
            <select v-model="ret.type">
              <option value="leftover">余料退回</option>
              <option value="wrong_spec">规格不符</option>
              <option value="defect">质量不合格</option>
              <option value="order_cancel">订单取消</option>
            </select>
          </label>
        </div>
        <label class="fl">原因（必填，≥4 字）
          <input v-model="ret.reason" placeholder="例如：裁床排版优化，余料退回仓库" />
        </label>
        <div v-if="ret.items.length" class="table-wrap">
          <table class="data">
            <thead><tr><th>原料</th><th class="num">已发</th><th class="num">已退</th><th class="num">可退</th><th class="num">本次退</th></tr></thead>
            <tbody>
              <tr v-for="it in ret.items" :key="it.id">
                <td>{{ it.name }}</td>
                <td class="num tiny">{{ num(it.issued_qty) }}</td>
                <td class="num tiny muted">{{ it.returned_qty ? num(it.returned_qty) : '' }}</td>
                <td class="num tiny">{{ num(it.returnable) }}</td>
                <td class="num"><input v-model.number="it.send" type="number" class="mini-inp" min="0" step="0.01" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="tiny muted" style="margin: 8px 0">选一张已发料的单，会列出可退明细。</div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="ret.open = false">取消</button>
          <button class="btn btn-primary" @click="submitReturn">创建退料单</button>
        </div>
      </div>
    </div>

    <!-- ==================== 盘点详情 ==================== -->
    <div v-if="take.open" class="modal-mask" @click.self="take.open = false">
      <div class="modal xxwide">
        <h3>
          {{ take.data.take_no }}
          <span class="tag" :class="takeTag(take.data.status)">{{ take.data.status_label }}</span>
          <span class="tiny muted">{{ take.data.take_date }} · 已盘 {{ take.data.counted }}/{{ take.data.items.length }}</span>
        </h3>
        <div class="kv">
          <div><span>差异条数</span><b :class="{ red: take.data.diff_count > 0 }">{{ take.data.diff_count || 0 }}</b></div>
          <div><span>盘盈</span><b class="ok-line">{{ take.data.gain_qty ? num(take.data.gain_qty) : 0 }}</b><small>{{ money(take.data.gain_amount) }}</small></div>
          <div><span>盘亏</span><b class="red">{{ take.data.loss_qty ? num(take.data.loss_qty) : 0 }}</b><small>{{ money(take.data.loss_amount) }}</small></div>
          <div><span>未计价差异</span><b :class="{ red: take.data.uncosted_count > 0 }">{{ take.data.uncosted_count || 0 }}</b><small>没有采购价，只调数量</small></div>
          <div><span>盘点人</span><b>{{ take.data.counter || '—' }}</b></div>
          <div><span>状态</span><b>{{ take.data.status_label }}</b></div>
        </div>
        <div v-if="take.data.status === 'counting'" class="warn-box" style="margin: 8px 0">
          盘点进行中：<b>原料的领料、退料、收货过账全部被拦住</b>，直到提交并落账或取消盘点。
        </div>
        <div class="table-wrap" style="max-height: 430px">
          <table class="data" style="min-width: 1000px">
            <thead>
              <tr>
                <th>原料</th><th>单位</th><th class="num">账面</th><th class="num">实盘</th>
                <th class="num">差异</th><th class="num">单价</th><th class="num">差异金额</th><th style="min-width: 200px">差异原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in take.data.items" :key="it.id" :class="{ 'row-warn': Math.abs(it.diff_qty) > 0.005 }">
                <td>{{ it.name }}</td>
                <td class="tiny">{{ it.unit || '—' }}</td>
                <td class="num">{{ num(it.book_qty) }}</td>
                <td class="num">
                  <input
                    v-if="editable(take.data)"
                    v-model="it.count_val"
                    type="number"
                    class="mini-inp"
                    step="0.01"
                    placeholder="未盘"
                  />
                  <span v-else>{{ it.count_qty === null ? '—' : num(it.count_qty) }}</span>
                </td>
                <td class="num" :class="diffClass(it.diff_qty)">{{ take.data.status === 'draft' || take.data.status === 'counting' ? liveDiff(it) : (it.diff_qty ? num(it.diff_qty) : '') }}</td>
                <td class="num tiny">{{ it.price === null ? '—' : money(it.price) }}</td>
                <td class="num tiny">
                  <span v-if="take.data.status === 'draft' || take.data.status === 'counting'">
                    {{ liveDiff(it) === '' ? '' : (it.price === null ? '未计价' : money(liveDiff(it) * it.price)) }}
                  </span>
                  <span v-else>{{ it.diff_amount === null ? '未计价' : money(it.diff_amount) }}</span>
                </td>
                <td>
                  <input
                    v-if="editable(take.data)"
                    v-model="it.reason"
                    class="reason-inp"
                    placeholder="有差异必须写，例如：边角料未登记"
                  />
                  <span v-else class="tiny wrap" style="display:block; white-space:normal; min-width:170px">{{ it.reason || '—' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="take.open = false">关闭</button>
          <span class="grow"></span>
          <button v-if="canWrite && take.data.status === 'draft'" class="btn btn-ghost" @click="cancelTake">取消盘点</button>
          <button v-if="canWrite && take.data.status === 'counting'" class="btn btn-ghost" @click="saveCount">保存盘点数</button>
          <button v-if="canWrite && take.data.status === 'draft'" class="btn btn-primary" @click="startTake">开始盘点（冻结收发）</button>
          <button v-if="canWrite && take.data.status === 'counting'" class="btn btn-primary" @click="submitTake">提交差异</button>
          <button v-if="canAdjust && take.data.status === 'submitted'" class="btn btn-primary" @click="adjustTake">落账（改库存）</button>
          <span v-if="take.data.status === 'submitted' && !canAdjust" class="tiny red">待仓库落账</span>
        </div>
      </div>
    </div>

    <!-- ==================== 流水弹窗 ==================== -->
    <div v-if="ledger.open" class="modal-mask" @click.self="ledger.open = false">
      <div class="modal wide">
        <h3>{{ ledger.material ? ledger.material.name : '原料流水' }} <span class="tiny muted">每一条增减的来路</span></h3>
        <div class="table-wrap" style="max-height: 420px">
          <table class="data">
            <thead><tr><th>时间</th><th>类型</th><th class="num">数量</th><th>单据</th><th>备注</th><th>操作人</th></tr></thead>
            <tbody>
              <tr v-for="l in ledger.rows" :key="l.id">
                <td class="tiny mono">{{ l.created_at }}</td>
                <td class="tiny">{{ l.type_label }}</td>
                <td class="num" :class="l.qty > 0 ? 'ok-line' : 'red'">{{ l.qty > 0 ? '+' : '' }}{{ num(l.qty) }}</td>
                <td class="tiny mono">{{ l.ref_no || '—' }}</td>
                <td class="tiny wrap" style="max-width: 280px">{{ l.remark || '—' }}</td>
                <td class="tiny">{{ l.operator }}</td>
              </tr>
              <tr v-if="!ledger.rows.length"><td colspan="6" class="empty">没有流水记录</td></tr>
            </tbody>
          </table>
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="ledger.open = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('issues');
const dict = ref({});
const board = ref({});
const stock = ref({ rows: [], stat: {} });
const issues = ref([]);
const returns = ref([]);
const stocktakes = ref([]);
const orders = ref([]);
const suggest = ref(null);

const stockFilter = reactive({ type: '', only_short: false });
const issueFilter = reactive({ status: '', order_no: '' });

const newIssue = reactive({ open: false, kind: 'order', order_id: '', req_date: '', receiver_type: 'own', note: '', items: [], manual: [], loading: false, saving: false });
const detail = reactive({ open: false, data: {} });
const out = reactive({ open: false, items: [] });
const ret = reactive({ open: false, issue_id: '', type: 'leftover', reason: '', items: [] });
const take = reactive({ open: false, data: { items: [] } });
const ledger = reactive({ open: false, material: null, rows: [] });

const canWrite = computed(() => can('matflow.write'));
const canAdjust = computed(() => can('matflow.adjust'));

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const money = (v) => (v === null || v === undefined ? '—' : '¥' + (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN'));
const takeLabel = (s) => ({ draft: '草稿', counting: '盘点中', submitted: '待调账', adjusted: '已调账', cancelled: '已取消' }[s] || s);
// 只有「盘点中 / 待调账」才真的冻结；草稿还没开始，库存照常收发（别写成已冻结）
const takeBoardLabel = (s) => ({ draft: '待开始', counting: '盘点中', submitted: '待落账' }[s] || takeLabel(s));
const freezeNote = (s) => ({ draft: '（未开始，库存可收发）', counting: '（库存已冻结）', submitted: '（待落账，仍冻结）' }[s] || '');

const issueTag = (s) => ({ draft: 'gray', prepared: 'orange', issued: 'green', partial: 'blue', closed: 'green', cancelled: 'gray' }[s] || 'gray');
const takeTag = (s) => ({ draft: 'gray', counting: 'orange', submitted: 'red', adjusted: 'green', cancelled: 'gray' }[s] || 'gray');
const diffClass = (d) => (Number(d) > 0.005 ? 'ok-line' : (Number(d) < -0.005 ? 'red' : ''));

const stockShown = computed(() => {
  const rows = stock.value.rows || [];
  return stockFilter.only_short ? rows.filter((r) => r.available < 0.005) : rows;
});
const zeroCount = computed(() => (stock.value.rows || []).filter((r) => r.stock_qty <= 0).length);
const returnableIssues = computed(() => (issues.value || []).filter((i) => ['issued', 'partial', 'closed'].includes(i.status)));

const editable = (t) => ['draft', 'counting'].includes(t.status);
const liveDiff = (it) => {
  const raw = it.count_val;
  if (raw === '' || raw === null || raw === undefined) return '';
  return num(Number(raw) - Number(it.book_qty));
};

function unitOf(id) {
  const m = (stock.value.rows || []).find((x) => String(x.id) === String(id));
  return m ? m.unit || '—' : '—';
}

async function loadAll() {
  dict.value = (await api.matflowDict()) || {};
  board.value = (await api.matflowBoard()) || {};
  const st = await api.matflowStock({});
  stock.value = st || { rows: [], stat: {} };
}

async function loadStock() {
  const st = await api.matflowStock({ type: stockFilter.type });
  stock.value = st || { rows: [], stat: {} };
}

async function loadIssues() {
  const r = await api.matflowIssues({ status: issueFilter.status, order_no: issueFilter.order_no });
  issues.value = (r && r.rows) || [];
}

async function loadReturns() {
  const r = await api.matflowReturns({});
  returns.value = (r && r.rows) || [];
}

async function loadTakes() {
  const r = await api.matflowStocktakes({});
  stocktakes.value = (r && r.rows) || [];
}

async function loadOrders() {
  try {
    const r = await api.orders({});
    orders.value = (r && (r.rows || r.list)) || (Array.isArray(r) ? r : []);
  } catch (e) {
    orders.value = [];
  }
}

async function reloadAll() {
  try {
    await Promise.all([loadAll(), loadIssues(), loadReturns(), loadTakes()]);
  } catch (e) {
    alert(e.message);
  }
}

function go(t) {
  tab.value = t;
  if (t === 'stock') loadStock().catch((e) => alert(e.message));
  if (t === 'issues') loadIssues().catch((e) => alert(e.message));
  if (t === 'returns') loadReturns().catch((e) => alert(e.message));
  if (t === 'count') loadTakes().catch((e) => alert(e.message));
}

/* ---------- 新建备料单 ---------- */
function openNewIssue() {
  newIssue.open = true;
  newIssue.kind = 'order';
  newIssue.order_id = '';
  newIssue.req_date = dict.value.today || '';
  newIssue.note = '';
  newIssue.items = [];
  newIssue.manual = [];
  suggest.value = null;
  if (!orders.value.length) loadOrders();
}

async function loadSuggest() {
  suggest.value = null;
  newIssue.items = [];
  if (!newIssue.order_id) return;
  newIssue.loading = true;
  try {
    const r = await api.matflowSuggest(newIssue.order_id);
    suggest.value = r;
    newIssue.items = (r.items || []).map((x) => ({ ...x }));
  } catch (e) {
    alert(e.message);
  } finally {
    newIssue.loading = false;
  }
}

function addManualRow() {
  newIssue.manual.push({ material_id: '', req_qty: 1 });
}

async function submitIssue() {
  const items = [];
  (newIssue.items || []).forEach((x) => {
    if (num(x.req_qty) > 0) {
      items.push({ material_id: x.material_id, name: x.name, spec: x.spec, unit: x.unit, req_qty: num(x.req_qty) });
    }
  });
  (newIssue.manual || []).forEach((m) => {
    if (!m.material_id) return;
    const row = (stock.value.rows || []).find((s) => String(s.id) === String(m.material_id));
    if (!row) return;
    items.push({ material_id: Number(m.material_id), name: row.name, spec: row.spec, unit: row.unit, req_qty: num(m.req_qty) });
  });
  if (!items.length) return alert('至少要有一样原料且数量大于 0');
  newIssue.saving = true;
  try {
    const d = await api.createMatflowIssue({
      kind: newIssue.kind,
      order_id: newIssue.order_id ? Number(newIssue.order_id) : null,
      req_date: newIssue.req_date,
      receiver_type: newIssue.receiver_type,
      note: newIssue.note,
      items
    });
    newIssue.open = false;
    await reloadAll();
    await openIssue(d.id);
  } catch (e) {
    alert(e.message);
  } finally {
    newIssue.saving = false;
  }
}

/* ---------- 详情与动作 ---------- */
async function openIssue(id) {
  try {
    const d = await api.matflowIssue(id);
    detail.data = d;
    detail.open = true;
  } catch (e) {
    alert(e.message);
  }
}

async function prepareIssue() {
  if (!confirm('备料会把这批原料占用住，别的单就领不走了。继续？')) return;
  try {
    detail.data = await api.prepareMatflowIssue(detail.data.id);
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

function openOut() {
  out.open = true;
  out.items = (detail.data.items || []).map((it) => ({
    id: it.id, name: it.name, req_qty: it.req_qty, issued_qty: it.issued_qty,
    available: it.available, send: num(it.req_qty - it.issued_qty), batch_no: it.batch_no || ''
  }));
}

async function doOut() {
  const items = out.items.map((x) => ({ id: x.id, issued_qty: num(x.send), batch_no: x.batch_no || null }));
  if (!items.some((x) => x.issued_qty > 0)) return alert('没有填任何发料数量');
  try {
    detail.data = await api.outMatflowIssue(detail.data.id, { items });
    out.open = false;
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function closeIssue() {
  const open = num(detail.data.open_qty);
  const note = open > 0 ? prompt(`还有 ${open} 没发出，结案要写说明（例如「余量车间自购」「订单已减量」）：`, '') : '';
  if (open > 0 && (note === null || note.trim().length < 4)) return alert('还有欠发，结案必须写说明（≥4 字）');
  try {
    detail.data = await api.closeMatflowIssue(detail.data.id, { note: note || '' });
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function cancelIssue() {
  const reason = prompt('取消备料单会释放占用。请写原因：', '');
  if (reason === null) return;
  try {
    detail.data = await api.cancelMatflowIssue(detail.data.id, { reason });
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- 退料 ---------- */
function openNewReturn() {
  ret.open = true;
  ret.issue_id = '';
  ret.type = 'leftover';
  ret.reason = '';
  ret.items = [];
}

function openReturnFromIssue() {
  ret.open = true;
  ret.issue_id = detail.data.id;
  ret.type = 'leftover';
  ret.reason = '';
  loadReturnItems();
}

async function loadReturnItems() {
  ret.items = [];
  if (!ret.issue_id) return;
  try {
    const d = await api.matflowIssue(ret.issue_id);
    ret.items = (d.items || []).filter((x) => x.returnable > 0.005).map((x) => ({
      id: x.id, name: x.name, issued_qty: x.issued_qty, returned_qty: x.returned_qty, returnable: x.returnable, send: 0
    }));
    if (!ret.items.length) alert('这张单没有可退的了（已发都已退回）');
  } catch (e) {
    alert(e.message);
  }
}

async function submitReturn() {
  const items = ret.items.filter((x) => num(x.send) > 0).map((x) => ({ issue_item_id: x.id, qty: num(x.send) }));
  if (!items.length) return alert('至少填一行退料数量');
  if (ret.reason.trim().length < 4) return alert('退料原因必填（≥4 字）');
  try {
    await api.createMatflowReturn({ issue_id: Number(ret.issue_id), type: ret.type, reason: ret.reason, items });
    ret.open = false;
    await reloadAll();
    tab.value = 'returns';
  } catch (e) {
    alert(e.message);
  }
}

async function confirmReturn(r) {
  if (!confirm(`确认把 ${num(r.qty)} 退料入库？入库后会加回可用库存。`)) return;
  try {
    await api.confirmMatflowReturn(r.id);
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- 盘点 ---------- */
function openNewTake() {
  if (board.value.running_take) {
    return alert(`已有未完成的盘点单 ${board.value.running_take.take_no}，先把它盘完或取消（两套账面数会打架）`);
  }
  if (!confirm('新建盘点会把所有原料列上并快照账面数（部分盘点请在盘点表里删行）。继续？')) return;
  createTake();
}

async function createTake() {
  try {
    const d = await api.createMatflowStocktake({ take_date: dict.value.today, counter: '' });
    await reloadAll();
    tab.value = 'count';
    await openTake(d.id);
  } catch (e) {
    alert(e.message);
  }
}

async function openTake(id) {
  try {
    const d = await api.matflowStocktake(id);
    d.items = (d.items || []).map((it) => ({
      ...it,
      count_val: it.count_qty === null || it.count_qty === undefined ? '' : it.count_qty,
      reason: it.reason || ''
    }));
    take.data = d;
    take.open = true;
  } catch (e) {
    alert(e.message);
  }
}

async function startTake() {
  try {
    const d = await api.startMatflowStocktake(take.data.id);
    await openTake(d.id);
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

function takePayload() {
  return take.data.items.map((it) => ({
    id: it.id,
    count_qty: it.count_val === '' || it.count_val === null ? null : Number(it.count_val),
    reason: it.reason
  }));
}

async function saveCount() {
  try {
    const d = await api.countMatflowStocktake(take.data.id, { items: takePayload() });
    await openTake(d.id);
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function submitTake() {
  try {
    const d = await api.submitMatflowStocktake(take.data.id, { items: takePayload() });
    await openTake(d.id);
    await reloadAll();
    alert('已提交。差异需要仓库落账后才会改库存。');
  } catch (e) {
    alert(e.message);
  }
}

async function adjustTake() {
  const n = take.data.diff_count || 0;
  const un = take.data.uncosted_count || 0;
  if (!confirm(`确认落账？会把 ${n} 条差异写进库存流水（盘盈/盘亏），并解除冻结。${un ? `其中 ${un} 条没有采购价，只调数量不计金额。` : ''}`)) return;
  try {
    const d = await api.adjustMatflowStocktake(take.data.id);
    await openTake(d.id);
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function cancelTake() {
  const reason = prompt('取消盘点会解除冻结，且本次实盘数作废。请写原因：', '');
  if (reason === null) return;
  try {
    const d = await api.cancelMatflowStocktake(take.data.id, { reason });
    await openTake(d.id);
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- 流水 ---------- */
async function showLedger(row) {
  ledger.material = row;
  ledger.open = true;
  try {
    const r = await api.matflowLedger({ material_id: row.id, limit: 200 });
    ledger.rows = (r && r.rows) || [];
  } catch (e) {
    ledger.rows = [];
  }
}

onMounted(async () => {
  await reloadAll();
  loadOrders();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
/* 本页弹窗用「标题 + 内容 + 底部操作」的简结构，补上内边距与底栏（全局 .modal 本身不带 padding） */
.modal { padding: 18px 20px; }
.modal > h3 { margin: 0 0 12px; font-size: 16px; color: #16233b; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.modal-ops { display: flex; align-items: center; gap: 8px; padding-top: 13px; margin-top: 14px; border-top: 1px solid #eef2f7; flex-wrap: wrap; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat strong.sm { font-size: 15px; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.help-bar { background: #f6f9fe; border: 1px solid #e2ebf8; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #4a5568; line-height: 1.7; margin-bottom: 12px; }
.help-inline { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; line-height: 1.65; margin-bottom: 10px; }
.warn-box { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; }

.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.grow { flex: 1; }
.inp { padding: 5px 8px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; }
.chk { display: flex; align-items: center; gap: 5px; }
.chk input { width: auto; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
table.data .mini-inp { width: 80px; min-width: 80px; box-sizing: border-box; }
.mini-inp { width: 80px; min-width: 80px; padding: 3px 6px; border: 1px solid #dfe5ef; border-radius: 6px; font-size: 12px; text-align: right; }
.reason-inp { width: 100%; min-width: 220px; box-sizing: border-box; padding: 4px 7px; border: 1px solid #dfe5ef; border-radius: 6px; font-size: 12px; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-bad { background: #fff6f7; }
.row-warn { background: #fffdf6; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }
.sec { font-size: 13px; color: #16305f; margin: 4px 0 8px; }
.line-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed #eef1f6; flex-wrap: wrap; }
.kv { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
.kv > div { background: #f8fafd; border-radius: 8px; padding: 7px 9px; }
.kv span { display: block; font-size: 11px; color: #8a94a6; }
.kv b { font-size: 13px; color: #16305f; }
.kv small { display: block; font-size: 10.5px; color: #9aa4b5; }
.fl { display: block; font-size: 12px; color: #5b6474; margin: 6px 0 0; }
.fl input { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }
.ops-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .page-head .pill { display: none; }
}
</style>
