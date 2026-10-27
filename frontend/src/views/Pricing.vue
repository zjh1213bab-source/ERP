<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>价格快照与费用池</h2>
        <p class="sub">
          两件一直在 Excel 里靠人记的事：<b>车间水电折旧这些不归某一单的钱怎么摊到订单</b>，以及
          <b>出厂价改过几版、当时按哪一版卖的</b>。
          分摊<b>合计必须正好等于池额</b>（尾差归基数最大的，不许多一分少一分）；<b>制造费用才进产品成本</b>，
          管理/销售费用只做分析口径。价格本<b>发布即冻结</b>，改价发新版、旧版自动取代；
          <b>取不到成本的款不许发布</b>（不拿猜的成本定价），售价低于成本可以发但必须写说明。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite && tab === 'pool'" class="btn btn-primary" @click="openNewPool">新建费用池</button>
        <button v-if="canPrice && tab === 'book'" class="btn btn-primary" @click="openNewBook">新建价格本</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>本期费用池</span>
        <strong class="mono">{{ money(poolBoard.stat && poolBoard.stat.total) }}</strong>
        <small>{{ poolBoard.period || '—' }} 共 {{ (poolBoard.stat && poolBoard.stat.count) || 0 }} 个池</small>
      </div>
      <div class="stat">
        <span>已分摊</span>
        <strong class="mono">{{ money(poolBoard.stat && poolBoard.stat.allocated) }}</strong>
        <small>制造费用已写进成本对象</small>
      </div>
      <div class="stat" :class="poolBoard.stat && poolBoard.stat.unallocated ? 'st-warn' : ''">
        <span>待分摊</span>
        <strong class="mono">{{ money(poolBoard.stat && poolBoard.stat.unallocated) }}</strong>
        <small>{{ (poolBoard.stat && poolBoard.stat.draft) || 0 }} 个池还是草稿</small>
      </div>
      <div class="stat">
        <span>生效价格本</span>
        <strong class="mono sm">{{ currentBook ? 'V' + currentBook.version : '—' }}</strong>
        <small>{{ currentBook ? currentBook.book_no : '该范围还没有生效价' }}</small>
      </div>
      <div class="stat" :class="bookBoard.stat && bookBoard.stat.below_cost ? 'st-bad' : ''">
        <span>低于成本的价</span>
        <strong>{{ (bookBoard.stat && bookBoard.stat.below_cost) || 0 }}</strong>
        <small>生效版本里的项（发布时已说明）</small>
      </div>
      <div class="stat">
        <span>价格本总数</span>
        <strong>{{ (bookBoard.stat && bookBoard.stat.total) || 0 }}</strong>
        <small>草稿 {{ (bookBoard.stat && bookBoard.stat.draft) || 0 }} / 历史 {{ (bookBoard.stat && bookBoard.stat.superseded) || 0 }}</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'pool' }" @click="go('pool')">费用池</button>
        <button :class="{ on: tab === 'book' }" @click="go('book')">价格本（出厂价）</button>
        <button :class="{ on: tab === 'quote' }" @click="go('quote')">查价</button>
      </div>
    </div>

    <!-- ==================== 费用池 ==================== -->
    <div v-if="tab === 'pool'">
      <div class="help-bar">
        <b>池额 = 明细合计</b>（不能手填总额，手填就没人对得上明细）。分摊<b>只摊给本期有活动的成本对象</b>——
        三个月前结完的死单不该来分摊本月电费。分摊合计与池额差一分钱都不许结账。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>池号</th><th>期间</th><th>名称</th><th>类型</th><th>动因</th>
              <th class="num">明细</th><th class="num">池额</th><th class="num">已分摊</th>
              <th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in pools" :key="p.id" :class="{ 'row-warn': p.status === 'draft' && p.total_amount > 0 }">
              <td class="mono tiny">{{ p.pool_no }}</td>
              <td class="tiny">{{ p.period }}</td>
              <td>
                {{ p.name }}
                <span v-if="!p.in_cost" class="tag gray" title="不摊进产品成本，只做经营分析口径">不摊进成本</span>
              </td>
              <td class="tiny">{{ p.kind_label }}</td>
              <td class="tiny">{{ p.driver_label }}</td>
              <td class="num tiny">{{ p.expense_count }}</td>
              <td class="num">{{ money(p.total_amount) }}</td>
              <td class="num">
                {{ p.allocated_amount ? money(p.allocated_amount) : '' }}
                <span v-if="p.status === 'distributed' && Math.abs(p.diff) > 0.01" class="tag red">差 {{ money(p.diff) }}</span>
              </td>
              <td><span class="tag" :class="poolTag(p.status)">{{ p.status_label }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="openPool(p.id)">明细</button></td>
            </tr>
            <tr v-if="!pools.length">
              <td colspan="10" class="empty">还没有费用池。点右上「新建费用池」，先归类（制造 / 管理 / 销售）再录明细。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 价格本 ==================== -->
    <div v-if="tab === 'book'">
      <div class="help-bar">
        <b>价格本发布即冻结</b>：已发布的版本不许改，要改就基于它发新版，旧版自动转「已被新版取代」，
        历史订单仍按当时的版本查得到。<b>取不到单件成本的款不许发布</b>——成本没算清就不该定价。
        取价按<b>客户专价 → 通用价</b>优先，命中数量档取该档价，返回版本号做凭据。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>版本</th><th>范围</th><th>客户</th><th>币种</th><th>生效</th>
              <th class="num">项数</th><th class="num">低于成本</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in books" :key="b.id" :class="{ 'row-bad': b.below_cost_count > 0 && b.status === 'published' }">
              <td>
                <span class="mono tiny">{{ b.book_no }}</span>
                <span class="tag blue">V{{ b.version }}</span>
              </td>
              <td class="tiny">{{ b.scope_label }}</td>
              <td class="tiny">{{ b.customer_label }}</td>
              <td class="tiny">{{ b.currency }}</td>
              <td class="tiny">{{ b.effective_from }}<span v-if="b.effective_to"> ~ {{ b.effective_to }}</span></td>
              <td class="num">{{ b.item_count }}</td>
              <td class="num" :class="{ red: b.below_cost_count > 0 }">{{ b.below_cost_count || '' }}</td>
              <td><span class="tag" :class="bookTag(b.status)">{{ b.status_label }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="openBook(b.id)">价目表</button></td>
            </tr>
            <tr v-if="!books.length">
              <td colspan="9" class="empty">还没有价格本。点右上「新建价格本」，发布后才会有生效价。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 查价 ==================== -->
    <div v-if="tab === 'quote'">
      <div class="help-bar">
        查价返回的是<b>当时命中的那一版</b>：报价、下单、客户问价都以它为准。查不到不是 0 元，而是
        <b>「当前没有这个款/这个数量档的价」</b>——这时该去发版，不是去拍一个数。
      </div>
      <div class="toolbar">
        <input v-model="quoteForm.style_no" class="inp" placeholder="款号，如 LEJE-AW-2601" style="min-width: 220px" @keyup.enter="doQuote" />
        <input v-model.number="quoteForm.qty" class="inp" type="number" placeholder="数量" style="width: 110px" />
        <input v-model="quoteForm.size" class="inp" placeholder="尺码（可空）" style="width: 120px" />
        <input v-model="quoteForm.customer_id" class="inp" placeholder="客户 ID（可空）" style="width: 130px" />
        <button class="btn btn-primary btn-sm" @click="doQuote">查价</button>
      </div>
      <div v-if="quoteResult" style="margin-top: 12px">
        <div v-if="quoteResult.found" class="ok-box">
          <div class="q-head">
            <b>{{ quoteResult.style_no }}</b> × {{ quoteResult.qty }} 件 · {{ quoteResult.by_label }}
            <span class="tag blue">{{ quoteResult.book.book_no }} V{{ quoteResult.book.version }}</span>
          </div>
          <div class="q-grid">
            <div><span>单价</span><b class="mono">{{ money(quoteResult.item.price) }}</b></div>
            <div><span>金额</span><b class="mono">{{ money(quoteResult.amount) }}</b></div>
            <div><span>单件成本</span><b class="mono">{{ quoteResult.item.cost_unit === null ? '—' : money(quoteResult.item.cost_unit) }}</b></div>
            <div><span>毛利率</span><b :class="quoteResult.item.gross_margin !== null && quoteResult.item.gross_margin < 0 ? 'red' : 'ok-line'">
              {{ quoteResult.item.gross_margin === null ? '—' : num(quoteResult.item.gross_margin) + '%' }}</b></div>
            <div><span>毛利额</span><b class="mono">{{ quoteResult.gross_amount === null ? '—' : money(quoteResult.gross_amount) }}</b></div>
            <div><span>数量档</span><b>{{ quoteResult.item.min_qty }}{{ quoteResult.item.max_qty === null ? '+' : ' - ' + quoteResult.item.max_qty }}</b></div>
          </div>
          <div v-if="quoteResult.item.below_cost" class="tiny red" style="margin-top: 6px">
            这个档位售价低于成本，是发布时说明过的特价（清库存 / 战略客户）。
          </div>
        </div>
        <div v-else class="warn-box">{{ quoteResult.reason }}</div>
      </div>
    </div>

    <!-- ==================== 费用池详情 ==================== -->
    <div v-if="pool.open" class="modal-mask" @click.self="pool.open = false">
      <div class="modal xxwide">
        <h3>
          {{ pool.data.pool_no }}
          <span class="tag" :class="poolTag(pool.data.status)">{{ pool.data.status_label }}</span>
          <span class="tag gray">{{ pool.data.kind_label }}</span>
          <span class="tag blue">{{ pool.data.driver_label }}</span>
          <span v-if="!pool.data.in_cost" class="tag orange">不摊进产品成本</span>
        </h3>
        <div class="kv">
          <div><span>期间</span><b>{{ pool.data.period }}</b></div>
          <div><span>池额</span><b class="mono">{{ money(pool.data.total_amount) }}</b></div>
          <div><span>已分摊</span><b class="mono">{{ money(pool.data.alloc_sum) }}</b></div>
          <div><span>差额</span><b class="mono" :class="{ red: pool.data.status !== 'draft' && Math.abs(pool.data.total_amount - pool.data.alloc_sum) > 0.01 }">
            {{ money(pool.data.total_amount - pool.data.alloc_sum) }}</b></div>
          <div><span>基数合计</span><b>{{ num(pool.data.base_total) }}</b></div>
          <div><span>对象数</span><b>{{ pool.data.allocations.length }}</b></div>
        </div>
        <div v-if="pool.data.amount_mismatch" class="warn-box" style="margin-bottom: 10px">
          池额与明细合计不一致，数据被直接改过（正常流程不会发生），请核对。
        </div>

        <h4 class="sec">费用明细 <span class="tiny muted">（池额 = 这些明细的合计）</span></h4>
        <div class="table-wrap" style="max-height: 240px; overflow-y: auto">
          <table class="data">
            <thead><tr><th>日期</th><th>类别</th><th>说明</th><th class="num">金额</th><th>录入</th><th></th></tr></thead>
            <tbody>
              <tr v-for="e in pool.data.expenses" :key="e.id">
                <td class="tiny mono">{{ e.expense_date }}</td>
                <td class="tiny">{{ e.category }}</td>
                <td class="tiny wrap" style="max-width: 320px">{{ e.description }}</td>
                <td class="num" :class="{ red: e.amount < 0 }">{{ money(e.amount) }}</td>
                <td class="tiny muted">{{ e.created_by }}</td>
                <td>
                  <button v-if="canWrite && pool.data.can.remove_expense" class="btn btn-ghost btn-sm" @click="removeExpense(e)">删</button>
                </td>
              </tr>
              <tr v-if="!pool.data.expenses.length"><td colspan="6" class="empty">还没有明细，先加几笔</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="canWrite && pool.data.can.add_expense" class="add-row">
          <input v-model="expForm.expense_date" type="date" class="inp" />
          <input v-model="expForm.category" class="inp" placeholder="类别" style="width: 100px" />
          <input v-model="expForm.description" class="inp" placeholder="说明（必填）" style="min-width: 200px" />
          <input v-model.number="expForm.amount" type="number" class="inp" placeholder="金额" style="width: 120px" />
          <button class="btn btn-ghost btn-sm" @click="addExpense">加一笔</button>
        </div>

        <template v-if="pool.data.status === 'draft'">
          <h4 class="sec">分摊预览 <span class="tiny muted">（只算不落库；尾差归基数最大的对象）</span></h4>
          <div v-if="preview && preview.blockers && preview.blockers.length" class="warn-box">
            {{ preview.blockers.join('；') }}
          </div>
          <div v-else-if="preview" class="table-wrap" style="max-height: 280px; overflow-y: auto">
            <table class="data">
              <thead>
                <tr><th>订单</th><th>款号</th><th class="num">{{ preview.pool.driver_label }}</th><th class="num">占比</th><th class="num">分摊额</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in preview.rows" :key="r.cost_object_id">
                  <td class="tiny mono">{{ r.order_no }}</td>
                  <td class="tiny">{{ r.style_no || '—' }}</td>
                  <td class="num">{{ num(r.base) }}</td>
                  <td class="num tiny">{{ num(r.share_ratio) }}%</td>
                  <td class="num"><b>{{ money(r.amount) }}</b></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="2" class="tiny muted">合计 {{ preview.rows.length }} 个对象</td>
                  <td class="num tiny">{{ num(preview.base_total) }}</td>
                  <td class="num tiny">100%</td>
                  <td class="num"><b>{{ money(preview.total_amount) }}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </template>

        <template v-if="pool.data.status === 'distributed' || pool.data.status === 'closed'">
          <h4 class="sec">分摊结果</h4>
          <div class="table-wrap" style="max-height: 260px; overflow-y: auto">
            <table class="data">
              <thead><tr><th>订单</th><th class="num">基数</th><th class="num">占比</th><th class="num">分摊额</th><th>写成本</th></tr></thead>
              <tbody>
                <tr v-for="a in pool.data.allocations" :key="a.id">
                  <td class="tiny mono">{{ a.order_no }}</td>
                  <td class="num">{{ num(a.driver_base) }}</td>
                  <td class="num tiny">{{ num(a.share_ratio) }}%</td>
                  <td class="num"><b>{{ money(a.amount) }}</b></td>
                  <td class="tiny"><span class="tag" :class="a.in_cost ? 'green' : 'gray'">{{ a.in_cost ? '已进成本' : '仅分析' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <div class="modal-ops">
          <button v-if="canWrite && pool.data.can.revert" class="btn btn-ghost" @click="revertPool">撤销分摊</button>
          <span class="grow"></span>
          <button class="btn btn-ghost" @click="pool.open = false">关闭</button>
          <button v-if="canWrite && pool.data.can.close" class="btn btn-ghost" @click="closePool">结账</button>
          <button v-if="canWrite && pool.data.can.distribute" class="btn btn-primary" @click="doDistribute">确认分摊</button>
        </div>
      </div>
    </div>

    <!-- ==================== 新建费用池 ==================== -->
    <div v-if="newPool.open" class="modal-mask" @click.self="newPool.open = false">
      <div class="modal">
        <h3>新建费用池</h3>
        <div class="fgrid">
          <label>期间 <input v-model="newPool.period" type="month" /></label>
          <label>类型
            <select v-model="newPool.kind">
              <option value="manufacturing">制造费用（进产品成本）</option>
              <option value="admin">管理费用（不摊进成本）</option>
              <option value="selling">销售费用（不摊进成本）</option>
            </select>
          </label>
          <label>分摊动因
            <select v-model="newPool.driver">
              <option value="labor_hours">按工时</option>
              <option value="qty">按件数</option>
              <option value="material_amount">按材料额</option>
              <option value="revenue">按收入</option>
            </select>
          </label>
          <label>名称 <input v-model="newPool.name" placeholder="如 2026-10 车间制造费用" /></label>
        </div>
        <label class="fl">说明 <input v-model="newPool.note" placeholder="选填" /></label>
        <div class="help-inline" style="margin-top: 10px">
          只有<b>制造费用</b>会摊进成本对象的 overhead 层（进 actual_cost）；管理/销售费用只做经营分析口径，
          不摊进存货成本——否则库存虚高、毛利虚低。
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="newPool.open = false">取消</button>
          <button class="btn btn-primary" @click="submitPool">创建</button>
        </div>
      </div>
    </div>

    <!-- ==================== 价格本详情 ==================== -->
    <div v-if="book.open" class="modal-mask" @click.self="book.open = false">
      <div class="modal xxwide">
        <h3>
          {{ book.data.book_no }}
          <span class="tag blue">V{{ book.data.version }}</span>
          <span class="tag" :class="bookTag(book.data.status)">{{ book.data.status_label }}</span>
          <span class="tag gray">{{ book.data.scope_label }}</span>
          <span class="tag gray">{{ book.data.customer_label }}</span>
        </h3>
        <div class="kv">
          <div><span>生效</span><b>{{ book.data.effective_from }}</b><small>{{ book.data.effective_to ? '至 ' + book.data.effective_to : '至下一版' }}</small></div>
          <div><span>项数</span><b>{{ book.data.item_count }}</b></div>
          <div><span>低于成本</span><b :class="{ red: book.data.below_cost_count > 0 }">{{ book.data.below_cost_count }}</b></div>
          <div><span>取不到成本</span><b :class="{ red: book.data.cost_missing_count > 0 }">{{ book.data.cost_missing_count }}</b></div>
          <div><span>成本变动≥5%</span><b :class="{ orange: book.data.cost_drift_count > 0 }">{{ book.data.cost_drift_count || 0 }}</b><small>发布后成本变了，建议发新版</small></div>
          <div><span>均价区间</span><b class="mono tiny">{{ money(book.data.amount_stat.min_price) }} ~ {{ money(book.data.amount_stat.max_price) }}</b></div>
          <div><span>平均毛利率</span><b>{{ book.data.amount_stat.avg_margin === null ? '—' : num(book.data.amount_stat.avg_margin) + '%' }}</b></div>
        </div>
        <div v-if="book.data.publish_note" class="tiny muted" style="margin-bottom: 8px">发布说明：{{ book.data.publish_note }}</div>

        <div class="table-wrap" style="max-height: 440px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr>
                <th>款号</th><th>款名</th><th>尺码</th><th class="num">数量档</th>
                <th class="num">售价</th><th class="num">单件成本</th><th class="num">当前成本</th><th class="num">变动</th><th class="num">毛利率</th>
                <th>成本来源</th><th>备注</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in book.data.items" :key="i.id" :class="{ 'row-bad': i.below_cost }">
                <td class="mono tiny">{{ i.style_no }}</td>
                <td class="tiny">{{ i.style_name || '—' }}</td>
                <td class="tiny">{{ i.size || '不分码' }}</td>
                <td class="num tiny">{{ i.min_qty }}{{ i.max_qty === null ? '+' : '-' + i.max_qty }}</td>
                <td class="num"><b>{{ money(i.price) }}</b></td>
                <td class="num tiny">{{ i.cost_unit === null ? '取不到' : money(i.cost_unit) }}</td>
                <td class="num tiny muted">{{ i.cost_now === null ? '—' : money(i.cost_now) }}</td>
                <td class="num tiny" :class="i.cost_drift_alert ? 'orange' : (i.cost_drift === null ? '' : 'muted')">
                  {{ i.cost_drift === null ? '—' : (i.cost_drift > 0 ? '+' : '') + num(i.cost_drift) + '%' }}
                </td>
                <td class="num tiny" :class="i.gross_margin !== null && i.gross_margin < 0 ? 'red' : (i.gross_margin !== null ? 'ok-line' : '')">
                  {{ i.gross_margin === null ? '—' : num(i.gross_margin) + '%' }}
                </td>
                <td class="tiny">
                  <span class="tag" :class="i.cost_source === 'cost_object' ? 'green' : (i.cost_source === 'cost_sheet' ? 'blue' : 'red')">
                    {{ i.cost_source === 'cost_object' ? '成本对象' : (i.cost_source === 'cost_sheet' ? '核价单' : '缺') }}
                  </span>
                </td>
                <td class="tiny wrap" style="max-width: 160px">{{ i.note || '—' }}</td>
                <td>
                  <button v-if="canPrice && book.data.can.edit" class="btn btn-ghost btn-sm" @click="editItem(i)">改</button>
                </td>
              </tr>
              <tr v-if="!book.data.items.length"><td colspan="12" class="empty">还没有价格项</td></tr>
            </tbody>
          </table>
        </div>

        <div v-if="canPrice && book.data.can.edit" class="add-row">
          <input v-model="itemForm.style_no" class="inp" placeholder="款号" style="width: 180px" />
          <input v-model="itemForm.size" class="inp" placeholder="尺码(可空)" style="width: 100px" />
          <input v-model.number="itemForm.min_qty" class="inp" type="number" placeholder="起" style="width: 80px" />
          <input v-model.number="itemForm.max_qty" class="inp" type="number" placeholder="止(可空)" style="width: 90px" />
          <input v-model.number="itemForm.price" class="inp" type="number" placeholder="售价" style="width: 100px" />
          <button class="btn btn-ghost btn-sm" @click="saveItem">{{ itemForm.id ? '保存修改' : '加一档' }}</button>
          <button v-if="itemForm.id" class="btn btn-ghost btn-sm" @click="resetItemForm">取消</button>
        </div>

        <div class="modal-ops">
          <button v-if="canPrice && book.data.can.archive" class="btn btn-ghost" @click="archiveBook">归档（停止使用）</button>
          <span class="grow"></span>
          <button class="btn btn-ghost" @click="book.open = false">关闭</button>
          <button v-if="canPrice && book.data.can.publish" class="btn btn-primary" @click="doPublish">发布（冻结）</button>
        </div>
      </div>
    </div>

    <!-- ==================== 新建价格本 ==================== -->
    <div v-if="newBook.open" class="modal-mask" @click.self="newBook.open = false">
      <div class="modal">
        <h3>新建价格本</h3>
        <div class="fgrid">
          <label>范围
            <select v-model="newBook.scope">
              <option value="factory">出厂价（通用）</option>
              <option value="cost_plus">成本加成价</option>
            </select>
          </label>
          <label>客户 ID <input v-model="newBook.customer_id" placeholder="留空 = 通用价" /></label>
          <label>币种
            <select v-model="newBook.currency">
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label>生效日期 <input v-model="newBook.effective_from" type="date" /></label>
        </div>
        <label class="fl">说明 <input v-model="newBook.note" placeholder="如：本月调价，面料涨 4%" /></label>
        <div class="help-inline" style="margin-top: 10px">
          新建会<b>从当前生效版本复制价目</b>（改价最常见的姿势），改完再发布；
          已有生效版本时，新生效日期必须晚于它。
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="newBook.open = false">取消</button>
          <button class="btn btn-primary" @click="submitBook">创建草稿</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('pool');
const dict = ref({});
const poolBoard = ref({ stat: {}, period: '' });
const bookBoard = ref({ stat: {} });
const pools = ref([]);
const books = ref([]);

const pool = reactive({ open: false, data: { expenses: [], allocations: [], can: {} } });
const book = reactive({ open: false, data: { items: [], amount_stat: {}, can: {} } });
const preview = ref(null);

const expForm = reactive({ expense_date: '', category: '水电', description: '', amount: null });
const newPool = reactive({ open: false, period: '', kind: 'manufacturing', driver: 'labor_hours', name: '', note: '' });
const newBook = reactive({ open: false, scope: 'factory', customer_id: '', currency: 'CNY', effective_from: '', note: '' });
const itemForm = reactive({ id: null, style_no: '', size: '', min_qty: 1, max_qty: null, price: null });
const quoteForm = reactive({ style_no: '', qty: 100, size: '', customer_id: '' });
const quoteResult = ref(null);

const canWrite = computed(() => can('pricing.pool'));
const canPrice = computed(() => can('pricing.book'));

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const money = (v) => (v === null || v === undefined ? '—' : '¥' + (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN'));
const poolTag = (s) => ({ draft: 'gray', distributed: 'green', reverted: 'orange', closed: 'blue' }[s] || 'gray');
const bookTag = (s) => ({ draft: 'gray', published: 'green', superseded: 'orange', archived: 'gray' }[s] || 'gray');

const currentBook = computed(() => (books.value || []).find((b) => b.status === 'published' && !b.customer_id) || null);

async function loadAll() {
  dict.value = (await api.pricingDict()) || {};
  const b = await api.pricingBoard({});
  poolBoard.value = b.pools || { stat: {} };
  bookBoard.value = b.books || { stat: {} };
  const pr = await api.pricingPools({});
  pools.value = pr.rows || [];
  const br = await api.pricingBooks({});
  books.value = br.rows || [];
}

async function reloadAll() {
  try {
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

function go(t) {
  tab.value = t;
  reloadAll();
}

/* ---------- 费用池 ---------- */
async function openPool(id) {
  try {
    pool.data = await api.pricingPool(id);
    preview.value = null;
    if (pool.data.status === 'draft') {
      try { preview.value = await api.pricingPoolPreview(id); } catch (e) { preview.value = { blockers: [e.message], rows: [], total_amount: 0, base_total: 0 }; }
    }
    expForm.expense_date = dict.value.today || '';
    expForm.description = '';
    expForm.amount = null;
    pool.open = true;
  } catch (e) {
    alert(e.message);
  }
}

async function addExpense() {
  if (!expForm.description.trim()) return alert('说明必填');
  if (!expForm.amount) return alert('金额不能为空');
  try {
    pool.data = await api.addPoolExpense(pool.data.id, { ...expForm });
    preview.value = await api.pricingPoolPreview(pool.data.id);
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function removeExpense(e) {
  if (!confirm(`删除这笔「${e.description}」¥${num(e.amount)}？`)) return;
  try {
    pool.data = await api.removePoolExpense(e.id);
    preview.value = await api.pricingPoolPreview(pool.data.id);
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
}

async function doDistribute() {
  const pv = preview.value;
  if (!pv || (pv.blockers && pv.blockers.length)) return alert((pv && pv.blockers.join('；')) || '没有可分摊的对象');
  const extra = pool.data.in_cost ? '分摊额会写进成本对象的制造费用层（actual_cost 增加）' : '这个池不摊进产品成本，只记分析口径';
  if (!confirm(`确认分摊 ¥${num(pv.total_amount)} 到 ${pv.rows.length} 个成本对象？\n${extra}`)) return;
  try {
    pool.data = await api.distributePool(pool.data.id, { note: '按' + pv.pool.driver_label + '分摊' });
    preview.value = null;
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function revertPool() {
  const reason = prompt('撤销会删掉写入的成本分录并回滚 actual_cost。请写原因：', '');
  if (reason === null) return;
  try {
    pool.data = await api.revertPool(pool.data.id, { reason });
    preview.value = await api.pricingPoolPreview(pool.data.id);
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function closePool() {
  if (!confirm('结账后这个池不能再撤不能改。确认？')) return;
  try {
    pool.data = await api.closePool(pool.data.id);
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

function openNewPool() {
  newPool.open = true;
  newPool.period = dict.value.current_period || '';
  newPool.kind = 'manufacturing';
  newPool.driver = 'labor_hours';
  newPool.name = '';
  newPool.note = '';
}

async function submitPool() {
  try {
    const d = await api.createPricingPool({
      period: newPool.period, kind: newPool.kind, driver: newPool.driver,
      name: newPool.name || `${newPool.period} 费用池`, note: newPool.note
    });
    newPool.open = false;
    await loadAll();
    await openPool(d.id);
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- 价格本 ---------- */
async function openBook(id) {
  try {
    book.data = await api.pricingBook(id);
    resetItemForm();
    book.open = true;
  } catch (e) {
    alert(e.message);
  }
}

function resetItemForm() {
  itemForm.id = null;
  itemForm.style_no = '';
  itemForm.size = '';
  itemForm.min_qty = 1;
  itemForm.max_qty = null;
  itemForm.price = null;
}

function editItem(i) {
  itemForm.id = i.id;
  itemForm.style_no = i.style_no;
  itemForm.size = i.size;
  itemForm.min_qty = i.min_qty;
  itemForm.max_qty = i.max_qty;
  itemForm.price = i.price;
}

async function saveItem() {
  try {
    book.data = await api.upsertBookItem(book.data.id, { ...itemForm });
    resetItemForm();
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function doPublish() {
  const note = prompt(
    book.data.below_cost_count
      ? `有 ${book.data.below_cost_count} 项售价低于成本，发布必须写说明（清库存 / 战略客户 / 亏本接单）：`
      : '发布说明（选填）：',
    ''
  );
  if (note === null) return;
  try {
    book.data = await api.publishBook(book.data.id, { note });
    await loadAll();
    alert('已发布并冻结。同范围的旧版已自动转为「已被新版取代」，历史订单不受影响。');
  } catch (e) {
    alert(e.message);
  }
}

async function archiveBook() {
  const reason = prompt('归档后该范围将没有生效价。请写原因：', '');
  if (reason === null) return;
  try {
    book.data = await api.archiveBook(book.data.id, { reason });
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

function openNewBook() {
  newBook.open = true;
  newBook.scope = 'factory';
  newBook.customer_id = '';
  newBook.currency = 'CNY';
  newBook.effective_from = dict.value.today || '';
  newBook.note = '';
}

async function submitBook() {
  try {
    const d = await api.createPricingBook({
      scope: newBook.scope,
      customer_id: newBook.customer_id ? Number(newBook.customer_id) : null,
      currency: newBook.currency,
      effective_from: newBook.effective_from,
      note: newBook.note
    });
    newBook.open = false;
    await loadAll();
    await openBook(d.id);
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- 查价 ---------- */
async function doQuote() {
  if (!quoteForm.style_no.trim()) return alert('请填款号');
  try {
    quoteResult.value = await api.pricingQuote({
      style_no: quoteForm.style_no.trim(),
      qty: quoteForm.qty || 1,
      size: quoteForm.size || '',
      customer_id: quoteForm.customer_id || ''
    });
  } catch (e) {
    alert(e.message);
  }
}

onMounted(loadAll);
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat strong.sm { font-size: 16px; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.help-bar { background: #f6f9fe; border: 1px solid #e2ebf8; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #4a5568; line-height: 1.7; margin-bottom: 12px; }
.help-inline { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; line-height: 1.65; }
.warn-box { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 9px 12px; font-size: 12.5px; color: #92400e; line-height: 1.7; }
.ok-box { background: #f2fbf5; border: 1px solid #c9ecd6; border-radius: 12px; padding: 14px 16px; }

.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grow { flex: 1; }
.inp { padding: 5px 8px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; }
.add-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.sec { font-size: 13px; color: #16305f; margin: 16px 0 8px; }
.kv { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
.kv > div { background: #f8fafd; border-radius: 8px; padding: 7px 9px; }
.kv span { display: block; font-size: 11px; color: #8a94a6; }
.kv b { font-size: 13px; color: #16305f; }
.kv small { display: block; font-size: 10.5px; color: #9aa4b5; }
.fl { display: block; font-size: 12px; color: #5b6474; margin: 8px 0 0; }
.fl input { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }

.q-head { font-size: 13.5px; color: #14532d; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.q-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.q-grid span { display: block; font-size: 11px; color: #6a8f78; }
.q-grid b { font-size: 15px; color: #14532d; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-bad { background: #fff6f7; }
.row-warn { background: #fffdf6; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }

.modal { padding: 18px 20px; }
.modal > h3 { margin: 0 0 12px; font-size: 16px; color: #16233b; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.modal-ops { display: flex; align-items: center; gap: 8px; padding-top: 13px; margin-top: 14px; border-top: 1px solid #eef2f7; flex-wrap: wrap; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .q-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .page-head .pill { display: none; }
}
</style>
