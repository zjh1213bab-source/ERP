<template>
  <div class="sales-reference">
    <div class="sales-reference-crumb">首页 / 销售 / <b>业务订单</b></div>
    <section class="sales-list-filters">
      <label>PO单号<input v-model="q" placeholder="搜索PO单号 / 销售单号" /></label>
      <label>店铺信息<input v-model="salesFilters.shop" placeholder="搜索店铺信息" /></label>
      <label>店铺订单号<input v-model="salesFilters.shopOrder" placeholder="搜索店铺订单号" /></label>
      <label>客户<select v-model="salesFilters.customer"><option value="">选择客户</option><option v-for="c in salesCustomers" :key="c" :value="c">{{ c }}</option></select></label>
      <label>业务员<select v-model="salesFilters.manager"><option value="">选择业务员</option><option v-for="m in salesManagers" :key="m" :value="m">{{ m }}</option></select></label>
      <label>标签<select v-model="salesFilters.tag"><option value="">请选择标签</option><option v-for="t in salesTags" :key="t" :value="t">{{ t }}</option></select></label>
      <label class="sales-date-filter">单据日期<input type="date" v-model="salesFilters.start" /> - <input type="date" v-model="salesFilters.end" /></label>
      <label>交货天数<input type="number" min="0" v-model="salesFilters.days" placeholder="搜索交货天数" /></label>
      <label>订单状态<select v-model="status"><option value="">全部</option><option v-for="(lb,k) in labels" :key="k" :value="k">{{ lb }}</option></select></label>
      <label>审核状态<select v-model="salesFilters.approval"><option value="">请选择成本审核状态</option><option value="approved">成本审核通过</option><option value="pending">成本待审核</option><option value="rejected">成本已驳回</option><option value="none">未提交成本单</option></select></label>
      <label>订单类型<select v-model="type"><option value="">全部</option><option value="custom">定制</option><option value="stock">现货</option></select></label>
      <button @click="resetSalesFilters()">重置</button>
    </section>
    <section class="sales-reference-panel">
      <div class="sales-list-toolbar"><button v-action="['orders','create']" v-if="canCreate" class="sales-primary" @click="openCreate()">新增业务下单</button><details class="sales-more"><summary>更多 ▾</summary><div><button @click="openTrace()">单号反查</button><button v-action="['orders','export']" v-if="canExport" @click="exportCsv()">导出 Excel</button><button @click="batchPrint()">批量打印工单</button></div></details><ReferencePager v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" @refresh="load()" /></div>
      <div class="sales-list-scroll"><table class="sales-list-table"><thead><tr><th><input type="checkbox" :checked="allChecked" title="全选本页" @change="toggleAll" /> 客户</th><th>备注</th><th>客户/PO单号</th><th>店铺信息</th><th>标签</th><th>下单商品款号</th><th>下单总数量</th><th>总金额 USD</th><th>业务员</th><th>附件</th><th>日期</th><th>打版进度</th><th>生产进度</th></tr></thead><tbody>
      <tr v-for="o in pagination.rows" :key="o.id" :class="{'row-sel':selected.includes(o.id)}">
        <td><input type="checkbox" :checked="selected.includes(o.id)" @change="toggleOne(o.id)" /><button class="sales-text" @click="openDetail(o.id)">{{ o.customer_name||'—' }}</button></td>
        <td><span class="sales-remark" :title="o.remark">{{ o.remark||'—' }}</span><TrialNotice :record="o" /></td>
        <td><button class="sales-text" @click="openDetail(o.id)">{{ o.order_no }}</button></td>
        <td class="sales-shop"><div>店铺名称：{{ o.shop_name||'—' }}</div><div>店铺订单号：{{ o.shop_order_no||'—' }}</div></td>
        <td><span v-for="tag in o.tags" :key="tag" class="sales-label">{{ tag }}</span><span v-if="!o.tags?.length" class="sales-label">{{ o.type==='stock'?'现货':'定制' }}</span></td>
        <td><div class="sales-style-count">共 {{ o.items?.length||0 }} 款</div><div class="sales-style-grid"><button v-for="item in o.items" :key="item.id" @click="openDetail(o.id)"><img v-if="item.effect_image_url" :src="item.effect_image_url" alt="款式图片" /><span v-else class="sales-no-photo">暂无图片</span><span :title="item.style_no||item.product_name">{{ item.style_no||item.product_name||'待命名' }}</span></button></div></td>
        <td><button class="sales-blue" @click="openDetail(o.id)">{{ o.quantity||0 }}</button></td><td>{{ money(o.total_usd) }}</td><td>{{ o.manager||'—' }}</td>
        <td><a v-for="(a,i) in o.attachments" :key="a.url" :href="a.url" target="_blank" rel="noopener noreferrer" class="sales-file">{{ a.filename||a.name||'附件 '+(i+1) }}</a><span v-if="!o.attachments?.length">—</span></td>
        <td class="sales-dates"><div>货期：{{ o.delivery_days==null?'—':o.delivery_days+'天' }}</div><div>单据：{{ fmtTime(o.order_date||o.created_at) }}</div><div v-if="o.delivery_date">交期：{{ o.delivery_date }}</div></td>
        <td><button class="sales-outline" @click="patternOrder=o">查看详情</button></td>
        <td><span class="sales-label" :class="{'muted':!o.node_total}">{{ labels[o.status]||o.status }}</span><small v-if="o.node_total">{{ o.node_done }}/{{ o.node_total }} 节点</small><button class="sales-blue" @click="openDetail(o.id)">查看详情</button></td>
      </tr><tr v-if="!pagination.total"><td colspan="13" class="sales-empty">暂无符合条件的业务订单</td></tr></tbody></table></div>
    </section>
    <div v-if="patternOrder" class="modal-mask"><section class="modal sales-pattern-dialog"><div class="modal-head"><h3>打版进度 · {{ patternOrder.order_no }}</h3><button class="x" @click="patternOrder=null">×</button></div><div class="modal-body"><article v-for="item in patternOrder.items" :key="item.id"><img v-if="item.effect_image_url" :src="item.effect_image_url" alt="款式图片" /><div><b>{{ item.style_no||item.product_name||'待命名' }}</b><p>{{ item.pattern?.flow_status==='done'?'打版完成':item.pattern?.flow_status==='running'?'打版中':item.pattern?.flow_status==='hold'?'打版暂停':'未完成打版' }} · {{ item.pattern?.version||'—' }}</p></div><button v-if="item.pattern" class="sales-outline" @click="router.push({path:'/pattern-board',query:{techpack:item.pattern.id}})">查看打版流程</button></article><p v-if="!patternOrder.items?.length">暂无商品</p></div><div class="modal-foot"><button @click="patternOrder=null">关闭</button></div></section></div>

    <!-- ============ 批量操作条（勾选后出现） ============ -->
    <div v-if="selected.length" class="batch-bar">
      <b>已选 {{ selected.length }} 单</b>
      <span class="tiny muted">一次最多 200 单；逐单校验，能过的过、过不去的会列出来</span>
      <span class="spacer"></span>
      <select v-model="batchTo" class="select" style="min-width: 150px">
        <option value="">目标状态…</option>
        <option v-for="(lb, k) in batchLabels" :key="k" :value="k">{{ lb }}</option>
      </select>
      <button class="btn btn-primary" :disabled="!batchTo" @click="openBatch">批量流转</button>
      <button class="btn btn-ghost" @click="selected = []">清空选择</button>
    </div>

    <!-- ============ 批量流转弹窗：先预检，再执行 ============ -->
    <div v-if="batchOpen" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>批量流转 → {{ batchToLabel }}</h3>
          <button class="x" @click="closeBatch">×</button>
        </div>
        <div class="modal-body">
          <!-- 第一步：预检 -->
          <template v-if="!batchResult">
            <div class="banner info">
              <b>先预检，再执行</b>
              <span>
                预检<b>只读不写</b>：逐单告诉你哪几单能过、哪几单会被拦、拦在哪个门槛上。
                批量不是「一键全改」，是 N 次独立操作 —— 每单的门槛照样要过。
              </span>
            </div>

            <div class="bfield">
              <label>
                <span>备注（会写进每单的流转记录，留痕用）</span>
                <input v-model="batchNote" class="input" placeholder="例如：客户确认后统一推进" />
              </label>
              <label class="bchk">
                <input type="checkbox" v-model="batchAllOrNothing" />
                整批一致（任一单不合格则整批不动，适合强一致场景）
              </label>
              <p class="tiny muted" v-if="batchTo === 'closed'">
                结案要求应收已收清；未收清的会被拦下并显示欠款金额。
              </p>
            </div>

            <div v-if="!batchPreview" class="form-foot">
              <button class="btn btn-primary" :disabled="batchBusy" @click="doPrecheck">
                {{ batchBusy ? '预检中…' : '开始预检' }}
              </button>
            </div>

            <div v-else>
              <div class="pre-sum">
                <span class="tag green">可流转 {{ batchPreview.ok_count }} 单</span>
                <span v-if="batchPreview.fail_count" class="tag red">被拦 {{ batchPreview.fail_count }} 单</span>
                <span class="tiny muted">共 {{ batchPreview.requested }} 单</span>
              </div>

              <div v-if="batchPreview.fail.length" class="table-wrap" style="max-height: 300px; overflow-y: auto; margin-top: 10px">
                <table class="data sm">
                  <thead><tr><th>订单号</th><th>当前状态</th><th>被拦原因</th></tr></thead>
                  <tbody>
                    <tr v-for="f in batchPreview.fail" :key="f.id">
                      <td class="mono tiny">{{ f.order_no || ('#' + f.id) }}</td>
                      <td class="tiny">{{ labels[f.status] || f.status || '—' }}</td>
                      <td class="tiny">{{ f.reason }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="form-foot">
                <button class="btn btn-ghost" :disabled="batchBusy" @click="batchPreview = null">重新预检</button>
                <button class="btn btn-primary" :disabled="batchBusy || !batchPreview.ok_count" @click="doExecute">
                  确认执行 {{ batchPreview.ok_count }} 单
                </button>
                <span v-if="batchPreview.fail_count" class="tiny muted">被拦的 {{ batchPreview.fail_count }} 单不会被动</span>
              </div>
            </div>
          </template>

          <!-- 第二步：结果（逐单，不许一句「部分成功」带过） -->
          <template v-else>
            <div class="banner" :class="batchResult.fail_count ? 'warn' : 'ok'">
              <b>{{ batchResult.batch_no ? '批次 ' + batchResult.batch_no : '整批未执行' }}</b>
              <span>
                成功 {{ batchResult.ok_count }} 单 / 失败 {{ batchResult.fail_count }} 单
                <template v-if="batchResult.batch_no">· 批次号已写进每单的流转记录，可按批追溯</template>
              </span>
            </div>

            <div v-if="batchResult.ok.length" class="pre-sum">
              <span class="tag green">已流转</span>
              <span class="tiny">{{ batchResult.ok.map((x) => x.order_no).join('、') }}</span>
            </div>

            <div v-if="batchResult.fail.length" class="table-wrap" style="max-height: 280px; overflow-y: auto; margin-top: 10px">
              <table class="data sm">
                <thead><tr><th>订单号</th><th>当前状态</th><th>失败原因</th></tr></thead>
                <tbody>
                  <tr v-for="f in batchResult.fail" :key="f.id">
                    <td class="mono tiny">{{ f.order_no || ('#' + f.id) }}</td>
                    <td class="tiny">{{ labels[f.status] || f.status || '—' }}</td>
                    <td class="tiny">{{ f.reason }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="form-foot">
              <button class="btn btn-primary" @click="closeBatch">关闭并刷新列表</button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 新下单工作台与详情复用原有订单链路，面辅料在后端同事务保存。 -->
    <SalesOrderEntry v-if="showCreate" :initial="form" :customers="customers" :products="products" :rate="rate" :templates="sizeTemplates" @close="showCreate=false" @saved="entrySaved" @templates-changed="loadRefs()" />

    <!-- ================= 详情 ================= -->
    <div v-if="detail" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>
            <span class="mono">{{ detail.order_no }}</span>
            · <span class="tag" :class="tagOf(detail.status)">{{ labels[detail.status] }}</span>
            <button v-if="canRename(detail)" class="btn btn-sm btn-ghost" style="margin-left: 8px" @click="openRename">
              改订单号
            </button>
          </h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <TrialNotice :record="detail" :compact="false" />
          <OrderEntrySnapshot :order="detail" :materials="orderMats" />
          <div v-if="detail.entry_json" class="order-entry-summary">
            <span v-for="(value,key) in entrySummary(detail)" :key="key"><small>{{key}}</small> <b>{{value}}</b></span>
          </div>
          <div class="form-grid" style="margin-bottom: 14px">
            <div><span style="color: var(--ink-mute); font-size: 12.5px">客户</span><div><strong>{{ detail.customer_name_snapshot || detail.customer_name || '-' }}</strong></div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">类型</span><div>{{ detail.type === 'stock' ? '现货' : '定制' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">款名</span><div>{{ detail.style_name || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">客户订单号</span><div>{{ detail.cus_order_no || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">跟单员</span><div>{{ detail.manager || '-' }}</div></div>
            <div v-if="detail.order_no_logs && detail.order_no_logs.length">
              <span style="color: var(--ink-mute); font-size: 12.5px">改号历史</span>
              <div class="tiny">
                <div v-for="g in detail.order_no_logs" :key="g.id" class="mut">
                  {{ g.old_no }} → <b>{{ g.new_no }}</b> · {{ g.operator }} · {{ (g.created_at || '').slice(0, 10) }}
                </div>
              </div>
            </div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">交期</span><div>{{ detail.delivery_date || '-' }}</div></div><div><span class="muted">最新预计交期</span><div>{{detail.latest_delivery_date || '—'}}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">合计</span><div><strong>${{ money(detail.total_usd) }} / ¥{{ money(detail.total_amount) }}</strong> <span style="color:var(--ink-mute);font-size:12px">@{{ detail.rate }}</span></div></div>
          </div>
          <div class="form-grid" style="margin-bottom: 14px">
            <div><span style="color: var(--ink-mute); font-size: 12.5px">下单日期</span><div>{{ detail.order_date || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">交货方式</span><div>{{ detail.delivery_method || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">贸易条款</span><div>{{ detail.trade_terms || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">包装要求</span><div>{{ detail.packaging || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">店铺名称</span><div>{{ detail.shop_name || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">店铺订单编号</span><div>{{ detail.shop_order_no || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">交货天数</span><div>{{ detail.delivery_days || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">运费</span><div>{{ detail.entry_json ? '$' : '¥' }}{{ money(detail.freight) }}</div></div>
          </div>

          <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px">
            <button class="btn btn-ghost btn-sm" @click="goPrint('production')">打印生产单</button>
            <button class="btn btn-ghost btn-sm" @click="goPrint('packing')">打印装箱单</button>
            <div class="sub">收货联系人：{{ detail.recipient_name || '—' }} · {{ detail.recipient_phone || '—' }} · 收货地址：{{ detail.shipping_address || '—' }}</div>
            <button class="btn btn-ghost btn-sm" @click="goPrint('shipping')">打印发货单</button>
            <button class="btn btn-ghost btn-sm" @click="goLabels">打印标签</button>
            <button class="btn btn-ghost btn-sm" @click="goInspection">验货报告</button>
          </div>

          <div style="display: flex; gap: 14px; align-items: center; margin-bottom: 14px">
            <div style="width: 96px; height: 96px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fafcff">
              <img v-if="detail.image_url" :src="detail.image_url" style="width: 100%; height: 100%; object-fit: cover" />
              <span v-else style="font-size: 12px; color: var(--ink-mute)">无款图</span>
            </div>
            <div>
              <label class="btn btn-ghost btn-sm" style="cursor: pointer">
                上传款图<input type="file" accept="image/*" style="display: none" @change="onOrderImage" />
              </label>
              <div style="font-size: 11.5px; color: var(--ink-mute); margin-top: 6px">png/jpg，≤3MB</div>
            </div>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">
            附件
            <span v-if="photoAtts.length" style="font-size: 12px; font-weight: 500; color: var(--ink-mute)">
              · 其中现场照片 {{ photoAtts.length }} 张
            </span>
          </h3>

          <!-- 看图比看文件名有用：图片走缩略图，其余走文件行 -->
          <div v-if="photoAtts.length" class="att-grid">
            <div v-for="a in photoAtts" :key="a.id" class="att-cell" @click="shot = a">
              <img :src="a.url" alt="" loading="lazy" />
              <span class="att-cat" :class="a.cat">{{ catLabel(a.cat) }}</span>
              <div class="att-note">{{ a.note || a.filename }}</div>
            </div>
          </div>

          <div v-if="fileAtts.length" style="margin-bottom: 8px">
            <div v-for="a in fileAtts" :key="a.id" style="display: flex; gap: 10px; align-items: center; font-size: 13px; padding: 4px 0; border-bottom: 1px dashed var(--line)">
              <a href="#" @click.prevent="openAtt(a)" style="color: var(--brand)">{{ a.filename }}</a>
              <span style="color: var(--ink-mute)">{{ Math.round((a.size || 0) / 1024) }} KB</span>
              <button class="link-btn danger" @click="removeAttachment(a.id)">删</button>
            </div>
          </div>
          <div v-if="!attachments.length" style="font-size: 12.5px; color: var(--ink-mute); margin-bottom: 8px">暂无附件</div>
          <div style="margin-bottom: 14px; display: flex; align-items: center; gap: 10px">
            <label class="btn btn-ghost btn-sm" style="cursor: pointer">
              上传附件<input type="file" multiple style="display: none" @change="onAttachments" />
            </label>
            <span style="font-size: 11.5px; color: var(--ink-mute)">{{ attUploading ? '上传中…' : 'PDF / 图片 / Office，单个 ≤10MB' }}</span>
          </div>

          <div v-for="style in detail.items || []" :key="'images-'+style.id" v-show="style.effect_image_url || style.detail_images?.length"><strong>{{ style.product_name }} · {{ style.style_no || '' }}</strong><StyleImageFields :effect-image-url="style.effect_image_url || ''" :detail-images="style.detail_images || []" readonly /></div>
          <div style="margin: 12px 0 8px; display: flex; justify-content: space-between; align-items: center">
            <h3 style="margin: 0; font-size: 14px">明细（款 / 颜色 / 尺码）</h3>
            <button v-if="canEditItems" class="btn btn-ghost btn-sm" @click="openItemsEditor">完善颜色尺码</button>
          </div>
          <div v-if="itemsEditing" style="border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #fcfdff">
            <div class="banner info" style="margin-bottom: 10px"><b>草稿明细</b><span>确认每款的颜色、尺码和数量；保存后会重算订单金额。订单进入技术确认后不可再改。</span></div>
            <div v-for="(it, ii) in itemEditForm" :key="ii" style="border-bottom: 1px solid var(--line); padding: 8px 0 12px; margin-bottom: 8px">
              <div class="form-grid">
                <div class="fitem"><label>产品名称</label><input class="input" v-model="it.product_name" /></div>
                <div class="fitem"><label>款号</label><input class="input" v-model="it.style_no" /></div>
              </div>
              <table class="data sm" style="margin: 8px 0">
                <thead><tr><th>颜色</th><th>尺码</th><th>数量</th><th>美金单价</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="(s, si) in it.sizes" :key="si">
                    <td><input class="input" v-model="s.color" placeholder="如藏青" /></td>
                    <td><input class="input" v-model="s.size" placeholder="S/M/L/均码" /></td>
                    <td><input class="input" type="number" min="0" v-model.number="s.qty" /></td>
                    <td><input class="input" type="number" min="0" step="0.01" v-model.number="s.usd_price" /></td>
                    <td><button  class="link-btn danger" @click="removeEditSize(it, si)">删除</button></td>
                  </tr>
                </tbody>
              </table>
              <div style="display: flex; gap: 8px">
                <button class="btn btn-ghost btn-sm" @click="addEditSize(it)">＋ 添加颜色尺码</button>
                <button  v-if="itemEditForm.length > 1" class="btn btn-ghost btn-sm" @click="itemEditForm.splice(ii, 1)">删除该款</button>
              </div>
            </div>
            <div style="display: flex; gap: 8px; justify-content: space-between">
              <button class="btn btn-ghost btn-sm" @click="addEditItem">＋ 添加款式</button>
              <div style="display: flex; gap: 8px">
                <button class="btn btn-ghost btn-sm" :disabled="itemEditBusy" @click="itemsEditing = false">取消</button>
                <button class="btn btn-primary btn-sm" :disabled="itemEditBusy" @click="saveItemsEditor">{{ itemEditBusy ? '保存中…' : '保存明细' }}</button>
              </div>
            </div>
          </div>
          <div v-for="it in detail.items" :key="it.id" style="margin-bottom: 12px">
            <div style="font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 6px">
              {{ it.product_name }} <span v-if="it.style_no" style="color:var(--brand);font-weight:600">· {{ it.style_no }}</span>
              <span style="color:var(--ink-mute);font-weight:400"> · {{ it.qty }} 件 · ${{ money(it.amount_usd) }} / ¥{{ money(it.amount_cny) }}</span>
            </div>
            <div v-for="(g, gi) in it.colors" :key="gi" style="margin-bottom: 8px">
              <div style="font-size: 12.5px; color: var(--brand); font-weight: 700; margin-bottom: 4px">颜色：{{ g.color || '（未填）' }} · {{ g.qty }} 件 · ${{ money(g.amount_usd) }}</div>
              <table class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden">
                <thead><tr><th>尺码</th><th>数量</th><th>美金单价</th><th>人民币单价</th><th>小计($)</th></tr></thead>
                <tbody>
                  <tr v-for="s in g.sizes" :key="s.id">
                    <td>{{ s.size }}</td><td>{{ s.qty }}</td><td>${{ money(s.usd_price) }}</td><td>¥{{ money(s.cny_price) }}</td><td>${{ money(s.amount_usd) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 工艺明细 -->
          <h3 style="margin: 16px 0 8px; font-size: 14px">工艺明细</h3>
          <table v-if="crafts.length" class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 8px">
            <thead><tr><th>工艺</th><th>数量</th><th>单价</th><th>倍率</th><th>FOB价</th><th>洗水/裁剪</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="c in crafts" :key="c.id">
                <td><strong>{{ c.name }}</strong></td><td>{{ c.qty }}</td><td>¥{{ money(c.price) }}</td>
                <td>{{ c.rate }}</td><td>¥{{ money(c.fob_price) }}</td>
                <td>{{ [c.is_wash ? '洗水' : '', c.is_cut ? '裁剪' : ''].filter(Boolean).join('/') || '-' }}</td>
                <td><button class="link-btn danger" @click="delCraft(c.id)">删</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else style="font-size: 12.5px; color: var(--ink-mute); margin-bottom: 8px">暂无工艺明细</div>
          <div v-if="canCraftWrite" style="margin-bottom: 6px">
            <button v-if="!craftAdding" class="btn btn-ghost btn-sm" @click="craftAdding = true">＋ 添加工艺</button>
            <div v-else style="border: 1px solid var(--line); border-radius: 10px; padding: 12px">
              <div class="form-grid">
                <div class="fitem"><label>工艺名称 *</label><input class="input" v-model="craftForm.name" placeholder="印花/绣花/洗水/车缝…" /></div>
                <div class="fitem"><label>数量</label><input class="input" type="number" v-model.number="craftForm.qty" /></div>
                <div class="fitem"><label>单价</label><input class="input" type="number" v-model.number="craftForm.price" /></div>
                <div class="fitem"><label>倍率</label><input class="input" type="number" v-model.number="craftForm.rate" /></div>
                <div class="fitem"><label>FOB 价</label><input class="input" type="number" v-model.number="craftForm.fob_price" /></div>
                <div class="fitem">
                  <label>标签</label>
                  <div style="display: flex; gap: 14px; padding-top: 8px; font-size: 12.5px">
                    <label><input type="checkbox" v-model="craftForm.is_wash" /> 洗水</label>
                    <label><input type="checkbox" v-model="craftForm.is_cut" /> 裁剪</label>
                  </div>
                </div>
                <div class="fitem full"><label>工艺说明</label><input class="input" v-model="craftForm.instruction" /></div>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 8px">
                <button class="btn btn-primary btn-sm" :disabled="craftBusy" @click="addCraft">提交</button>
                <button class="btn btn-ghost btn-sm" @click="craftAdding = false">取消</button>
              </div>
            </div>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">流转记录</h3>
          <ul class="timeline">
            <li v-for="lg in detail.logs" :key="lg.id">
              <div class="t-main">{{ lg.from_status ? (labels[lg.from_status] || lg.from_status) + ' → ' : '创建 · ' }}{{ labels[lg.to_status] || lg.to_status }}</div>
              <div class="t-sub">{{ lg.operator }} · {{ dateStr(lg.created_at) }} <span v-if="lg.note">· {{ lg.note }}</span></div>
            </li>
          </ul>

          <!-- 开发单 -->
          <h3 style="margin: 16px 0 8px; font-size: 14px">开发单 / 技术资料</h3>
          <table v-if="techpacks.length" class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 8px">
            <thead><tr><th>产品/款号</th><th>版本</th><th>状态</th><th>确认人</th><th style="width: 250px">操作</th></tr></thead>
            <tbody>
              <template v-for="tp in techpacks" :key="tp.id">
                <tr>
                  <td>{{ tp.product_name }}</td><td>{{ tp.version }}</td>
                  <td><span class="tag" :class="tpTag(tp.status)">{{ tpLabel(tp.status) }}</span></td>
                  <td>{{ tp.confirmed_by || '-' }}</td>
                  <td>
                    <button class="link-btn" @click="tpOpen[tp.id] = !tpOpen[tp.id]">{{ tpOpen[tp.id] ? '收起' : '摘要' }}</button>
                    <button class="link-btn" @click="tpDetailId = tp.id">明细</button>
                    <button class="link-btn" @click="printTechpack(tp.id)">打印工艺单</button>
                    <button v-if="tp.status !== 'confirmed' && canTechReview" class="link-btn" @click="confirmTp(tp.id)">确认</button>
                  </td>
                </tr>
                <tr v-if="tpOpen[tp.id]">
                  <td colspan="5" style="background: #fafcff">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12.5px; color: var(--ink)">
                      <div><strong>面料：</strong>{{ matNames(tp.fabric_ids, fabrics) }}<span v-if="tp.fabric_info">（{{ tp.fabric_info }}）</span></div>
                      <div><strong>辅料：</strong>{{ matNames(tp.accessory_ids, accessories) }}<span v-if="tp.accessory_info">（{{ tp.accessory_info }}）</span></div>
                      <div><strong>工艺工序：</strong>{{ tp.craft_info || '—' }}</div>
                      <div><strong>客户要求：</strong>{{ tp.customer_req || '—' }}</div>
                      <div style="grid-column: 1 / -1"><strong>尺码规格：</strong>{{ tp.size_spec || '—' }}</div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-else style="font-size: 12.5px; color: var(--ink-mute); margin-bottom: 8px">暂无开发单</div>

          <div v-if="canTechWrite" style="margin-bottom: 6px">
            <button v-action="['orders','create']"  v-if="!tpAdding" class="btn btn-ghost btn-sm" @click="tpAdding = true">＋ 新增开发单</button>
            <div v-else style="border: 1px solid var(--line); border-radius: 10px; padding: 12px">
              <div class="form-grid">
                <div class="fitem"><label>产品/款号 *</label><input class="input" v-model="tpForm.product_name" /></div>
                <div class="fitem"><label>版本</label><input class="input" v-model="tpForm.version" /></div>
                <div class="fitem full">
                  <label>选择面料 *</label>
                  <MaterialPickerField v-model="tpForm.fabric_ids" type="fabric" />
                  <input class="input" v-model="tpForm.fabric_info" placeholder="面料补充说明（可空）" style="margin-top: 6px" />
                </div>
                <div class="fitem full">
                  <label>选择辅料 *</label>
                  <MaterialPickerField v-model="tpForm.accessory_ids" type="accessory" />
                  <input class="input" v-model="tpForm.accessory_info" placeholder="辅料补充说明（可空）" style="margin-top: 6px" />
                </div>
                <div class="fitem full">
                  <label>工艺工序 *</label>
                  <textarea v-model="tpForm.craft_info" rows="2" placeholder="印花/绣花/水洗/车缝等"></textarea>
                  <div style="font-size: 11.5px; color: var(--ink-mute); margin-top: 4px">
                    工序明细（类别 / 单价 / 倍率 / 负责人）在「开发管理 → 编辑开发单 → 展开填写工序明细」里填，与「订单工序」页是同一份数据。
                  </div>
                </div>
                <div class="fitem full"><label>客户要求 *</label><textarea v-model="tpForm.customer_req" rows="2" placeholder="尺码表/包装/标签/测试要求"></textarea></div>
                <div class="fitem full"><label>尺码规格说明</label><input class="input" v-model="tpForm.size_spec" /></div>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 8px">
                <button class="btn btn-primary btn-sm" :disabled="tpBusy" @click="addTechpack">提交</button>
                <button class="btn btn-ghost btn-sm" @click="tpAdding = false">取消</button>
              </div>
              <p style="font-size: 11.5px; color: var(--ink-mute); margin: 8px 0 0">带 * 为定制订单技术确认前的必填项。</p>
            </div>
          </div>

          <!-- 面辅料用量 -->
          <h3 style="margin: 16px 0 8px; font-size: 14px">面辅料用量</h3>
          <!-- 12 列（多了「款」「适用颜色」）在详情弹窗里放不下：给最小宽度并允许横向滚，
               否则名称与款会被压成两行，一屏只能看清四五行 -->
          <div v-if="orderMats.length" style="overflow-x: auto; margin-bottom: 8px">
          <table class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden; min-width: 1000px">
            <thead><tr><th>类型</th><th>名称</th><th>款</th><th>适用颜色</th><th>单位</th><th>单件用量</th><th>损耗%</th><th>总用量</th><th>单价</th><th>金额</th><th>供应商</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="m in orderMats" :key="m.id">
                <td><span class="tag" :class="m.type === 'fabric' ? 'blue' : 'purple'">{{ m.type === 'fabric' ? '面料' : '辅料' }}</span></td>
                <td><strong>{{ m.name }}</strong><div v-if="m.spec" style="font-size: 11px; color: var(--ink-mute)">{{ m.spec }}</div></td>
                <td>
                  <span v-if="m.item">{{ m.item.style_no || m.item.product_name }}</span>
                  <span v-else class="tag gray" style="font-size: 10px">订单通用</span>
                </td>
                <td style="font-size: 12px">
                  {{ m.color_summary }}
                  <button v-if="canMatWrite && m.item" class="link-btn" style="margin-left: 4px" @click="openColorDlg(m)">配颜色</button>
                </td>
                <td>{{ m.unit || '-' }}</td><td>{{ m.one_use }}</td><td>{{ m.loss }}</td><td>{{ money(m.total_use) }}</td>
                <td>¥{{ money(m.price) }}</td><td>¥{{ money(m.amount) }}</td><td>{{ m.supplier || '-' }}</td>
                <td><button class="link-btn danger" @click="delMat(m.id)">删</button></td>
              </tr>
            </tbody>
          </table>
          </div>
          <div v-else style="font-size: 12.5px; color: var(--ink-mute); margin-bottom: 8px">暂无面辅料用量</div>
          <div v-if="orderMats.length" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px">
            <div>面料成本 <strong>¥{{ money(fabricCost) }}</strong> · 辅料成本 <strong>¥{{ money(accessoryCost) }}</strong></div>
            <button v-if="canCostWrite" class="btn btn-ghost btn-sm" @click="applyMatCost">带入成本单</button>
          </div>
          <div v-if="canMatWrite" style="margin-bottom: 6px">
            <button v-if="!matAdding" class="btn btn-ghost btn-sm" @click="matAdding = true">＋ 添加面辅料</button>
            <div v-else style="border: 1px solid var(--line); border-radius: 10px; padding: 12px">
              <div class="form-grid">
                <div class="fitem">
                  <label>从料库选择</label>
                  <select class="select" v-model.number="matForm.material_id" @change="pickMat">
                    <option :value="null">— 请选择物料档案 —</option>
                    <option v-for="m in allMats" :key="m.id" :value="m.id">{{ m.type === 'fabric' ? '面料' : '辅料' }} · {{ m.name }}</option>
                  </select>
                </div>
                <div class="fitem">
                  <label>这个料用在哪一款</label>
                  <select class="select" v-model.number="matForm.item_id" @change="matForm.colors = []; matForm.all_colors = false">
                    <option :value="null">订单通用（不分款）</option>
                    <option v-for="it in (detail.items || [])" :key="it.id" :value="it.id">
                      {{ it.style_no || it.product_name }}（{{ it.qty }} 件）
                    </option>
                  </select>
                </div>
                <div v-if="matForm.item_id" class="fitem full">
                  <label>适用颜色（不勾 = 未指定，用量按整款件数算）</label>
                  <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center">
                    <label style="font-size: 12.5px; display: flex; gap: 4px; align-items: center">
                      <input type="checkbox" v-model="matForm.all_colors" /> 该款所有颜色
                    </label>
                    <template v-if="!matForm.all_colors">
                      <label v-for="c in matItemColors" :key="c.color" style="font-size: 12.5px; display: flex; gap: 4px; align-items: center">
                        <input type="checkbox" :value="c.color" v-model="matForm.colors" /> {{ c.color }}（{{ c.qty }} 件）
                      </label>
                      <span v-if="!matItemColors.length" style="font-size: 12px; color: var(--ink-mute)">这个款还没录颜色</span>
                    </template>
                  </div>
                </div>
                <div class="fitem"><label>类型</label><select class="select" v-model="matForm.type"><option value="fabric">面料</option><option value="accessory">辅料</option></select></div>
                <div class="fitem"><label>名称 *</label><input class="input" v-model="matForm.name" /></div>
                <div class="fitem"><label>单位</label><input class="input" v-model="matForm.unit" placeholder="米/个/码" /></div>
                <div class="fitem"><label>单件用量</label><input class="input" type="number" v-model.number="matForm.one_use" /></div>
                <div class="fitem"><label>损耗率 %</label><input class="input" type="number" v-model.number="matForm.loss" /></div>
                <div class="fitem"><label>单价</label><input class="input" type="number" v-model.number="matForm.price" /></div>
                <div class="fitem"><label>成分</label><input class="input" v-model="matForm.ingredient" /></div>
                <div class="fitem"><label>规格</label><input class="input" v-model="matForm.spec" readonly title="规格只能在物料档案中修改" /></div>
                <div class="fitem"><label>供应商</label><input class="input" v-model="matForm.supplier" /></div>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 8px">
                <button class="btn btn-primary btn-sm" :disabled="matBusy" @click="addMat">提交</button>
                <button class="btn btn-ghost btn-sm" @click="matAdding = false">取消</button>
              </div>
              <p style="font-size: 11.5px; color: var(--ink-mute); margin: 8px 0 0">
                总用量按「所选款的件数」算（不打勾颜色时）；勾了颜色则按各色件数分别累加，都含损耗。
                订单通用物料按整单件数算。
              </p>
            </div>
          </div>

          <!-- 成本财务 -->
          <h3 style="margin: 16px 0 8px; font-size: 14px">成本与财务审核</h3>
          <div v-if="cost" style="font-size: 13px; margin-bottom: 8px">
            <span class="tag" :class="costTag(cost.status)">{{ costLabel(cost.status) }}</span>
            <span style="color: var(--ink-mute); margin-left: 8px">总成本 ¥{{ money(cost.total_cost) }} · 出厂价 ¥{{ money(cost.factory_price) }}
              <span v-if="cost.reviewed_by"> · 审核人 {{ cost.reviewed_by }}</span><span v-if="cost.review_opinion"> · {{ cost.review_opinion }}</span>
            </span>
          </div>
          <div v-if="canCostWrite" class="form-grid" style="margin-bottom: 8px">
            <div class="fitem"><label>材料费</label><input class="input" type="number" v-model.number="costForm.material_cost" /></div>
            <div class="fitem"><label>辅料费</label><input class="input" type="number" v-model.number="costForm.accessory_cost" /></div>
            <div class="fitem"><label>做工费</label><input class="input" type="number" v-model.number="costForm.labor_cost" /></div>
            <div class="fitem"><label>水电房租/管理</label><input class="input" type="number" v-model.number="costForm.overhead_cost" /></div>
            <div class="fitem"><label>其他</label><input class="input" type="number" v-model.number="costForm.other_cost" /></div>
            <div class="fitem"><label>加价率 %</label><input class="input" type="number" v-model.number="costForm.profit_rate" /></div>
          </div>
          <div v-if="canCostWrite" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
            <div style="font-size: 13px; color: var(--ink)">总成本 <strong>¥{{ money(costTotalPreview) }}</strong> · 出厂价 <strong style="color: #16305f">¥{{ money(costPricePreview) }}</strong></div>
            <button class="btn btn-primary btn-sm" :disabled="costBusy" @click="saveCost">保存成本单</button>
          </div>
          <div v-if="cost && cost.status === 'pending' && canFinanceReview" class="node-actions" style="margin-bottom: 6px">
            <button class="btn btn-primary btn-sm" :disabled="costBusy" @click="reviewCost(true)">✓ 审核通过</button>
            <button class="btn btn-danger btn-sm" :disabled="costBusy" @click="reviewCost(false)">✗ 驳回</button>
          </div>

          <!-- 分单 -->
          <h3 style="margin: 16px 0 8px; font-size: 14px">分单（本厂 / 外协）</h3>
          <table v-if="dispatches.length" class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 8px">
            <thead><tr><th>工厂</th><th>类型</th><th>数量</th><th>单价</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="d in dispatches" :key="d.id">
                <td><strong>{{ d.factory_name }}</strong></td>
                <td><span class="tag" :class="d.type === 'own' ? 'blue' : 'purple'">{{ d.type === 'own' ? '本厂' : '外协' }}</span></td>
                <td>{{ d.qty }}</td>
                <td>¥{{ money(d.price) }}</td>
                <td>{{ d.remark || '-' }}</td>
                <td><button class="link-btn danger" @click="removeDispatch(d.id)">删</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else style="font-size: 12.5px; color: var(--ink-mute); margin-bottom: 8px">未分单</div>
          <div v-if="orderQty > 0" class="pre-sum" style="margin-bottom: 8px">
            <span>订单总量 <b>{{ orderQty }}</b> 件</span>
            <span>已有效分单 <b>{{ dispatchedQty }}</b> 件</span>
            <span :class="dispatchRemaining ? 'tag orange' : 'tag green'">待分 {{ dispatchRemaining }} 件</span>
          </div>
          <template v-if="canDispatch && ['finance', 'assigned'].includes(detail.status)">
            <div class="form-grid" style="margin-bottom: 8px">
              <div class="fitem">
                <label>工厂 *</label>
                <select class="select" v-model.number="dispatchForm.factory_id">
                  <option :value="null">— 选择工厂 —</option>
                  <option v-for="f in factories" :key="f.id" :value="f.id">{{ f.name }}（{{ f.type === 'own' ? '本厂' : '外协' }}）</option>
                </select>
              </div>
              <div class="fitem"><label>数量（最多 {{ dispatchRemaining }} 件）</label><input class="input" type="number" min="0" :max="dispatchRemaining" v-model.number="dispatchForm.qty" /></div>
              <div class="fitem"><label>单价</label><input class="input" type="number" v-model.number="dispatchForm.price" /></div>
              <div class="fitem"><label>备注</label><input class="input" v-model="dispatchForm.remark" /></div>
            </div>
            <div style="margin-bottom: 6px; display: flex; align-items: center; gap: 10px">
              <button class="btn btn-primary btn-sm" :disabled="dispatchBusy" @click="doDispatch">提交分单</button>
              <span style="font-size: 12px; color: var(--ink-mute)">分单数量覆盖整单后才会推进到「已分单」（需财务已审核通过）</span>
            </div>
          </template>

          <!-- 生产工序进度 -->
          <h3 style="margin: 16px 0 8px; font-size: 14px">
            生产工序进度
            <span v-if="nodes.length" style="font-weight: 400; color: var(--ink-mute); font-size: 12.5px">（已完成 {{ doneCount }} / {{ nodes.length }}）</span>
          </h3>
          <div v-if="nodes.length">
            <div style="height: 8px; background: #eef1f6; border-radius: 6px; overflow: hidden; margin-bottom: 10px">
              <div :style="{ width: (nodes.length ? (doneCount / nodes.length * 100) : 0) + '%' }" style="height: 100%; background: #16a34a"></div>
            </div>
            <div class="node-scroll">
            <table class="data node-table" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden">
              <thead><tr><th>工序</th><th>状态</th><th>计划完成</th><th>实际完成</th><th>责任人</th><th>备注</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="n in nodes" :key="n.id">
                  <td class="nowrap"><strong>{{ n.name }}</strong>
                    <div v-if="aggOf(n.id).ok || aggOf(n.id).defect" style="font-size: 11px; color: var(--ink-mute)">
                      已报工 {{ aggOf(n.id).ok }} 件<span v-if="aggOf(n.id).defect"> · 不良 {{ aggOf(n.id).defect }}</span>
                    </div>
                  </td>
                  <td>
                    <select class="select" v-model="n.status" :disabled="!canNodeWrite" style="padding: 4px 8px">
                      <option value="pending">待开始</option><option value="doing">进行中</option><option value="done">已完成</option>
                    </select>
                  </td>
                  <td><input class="input" type="date" v-model="n.plan_date" :disabled="!canNodeWrite" style="padding: 4px 6px" /></td>
                  <td><input class="input" type="date" v-model="n.actual_date" :disabled="!canNodeWrite" style="padding: 4px 6px" /></td>
                  <td><input class="input" v-model="n.operator" :disabled="!canNodeWrite" style="padding: 4px 6px; width: 90px" /></td>
                  <td><input class="input" v-model="n.remark" :disabled="!canNodeWrite" style="padding: 4px 6px" /></td>
                  <td>
                    <button v-if="canNodeWrite" class="link-btn" :disabled="nodeBusy" @click="saveNode(n)">保存</button>
                    <button v-if="canNodeWrite" class="link-btn" @click="openReport(n)">报工</button>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <div style="margin-top: 8px; font-size: 12px; color: var(--ink-mute)">进入「生产中」会自动生成 13 道工序；状态改为「已完成」时自动补实际完成日期。</div>
          </div>
          <div v-else style="font-size: 12.5px; color: var(--ink-mute)">
            暂无工序。
            <button v-if="canNodeWrite" class="link-btn" :disabled="nodeBusy" @click="initNodes">初始化工序（13 道）</button>
          </div>

          <div v-if="canStockWrite" style="margin: 12px 0 4px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center">
            <button v-if="detail.status === 'production'" class="btn btn-ghost btn-sm" :disabled="busy" @click="doInstock">成品入库（生产仓）</button>
            <button v-if="canShip && detail.status === 'instock'" class="btn btn-primary btn-sm" :disabled="busy" @click="doShip()">发货出库（生产仓）</button>
            <span v-if="detail.status === 'shipped'" style="font-size: 12.5px; color: #16a34a">已发货</span>
          </div>

          <div v-if="detail.purchases && detail.purchases.length" style="margin-top: 16px">
            <h3 style="margin: 0 0 8px; font-size: 14px">
              关联采购 <span class="tiny mut">（这张订单的料买了没有）</span>
            </h3>
            <table class="data">
              <thead>
                <tr><th>采购单号</th><th>供应商</th><th>状态</th><th>下单日</th><th class="num">金额</th></tr>
              </thead>
              <tbody>
                <tr v-for="po in detail.purchases" :key="po.id">
                  <td class="mono tiny">{{ po.po_no }}</td>
                  <td>{{ po.supplier }}</td>
                  <td class="tiny">{{ po.status }}</td>
                  <td class="tiny">{{ po.order_date || '-' }}</td>
                  <td class="num">¥{{ Number(po.total_amount || 0).toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">可执行操作</h3>
          <div class="node-actions">
            <button v-for="t in nextStates" :key="t" class="btn" :class="t === 'cancelled' ? 'btn-danger' : 'btn-primary'" :disabled="busy" @click="doTransition(t)">→ {{ labels[t] || t }}</button>
            <button v-if="canRollback" class="btn btn-ghost rollback-btn" :disabled="busy" @click="openRollback">
              ↩ 反审退回
            </button>
            <span v-if="!nextStates.length && !canRollback" style="color: var(--ink-mute); font-size: 13px">当前状态无可执行操作</span>
          </div>
          <p v-if="canRollback" class="rollback-tip">
            生产、技术或财务环节发现问题时，可以把订单退回前面的环节（如退回业务重新确认），退回会同步冲销库存、重置工序，并记入流转记录。
          </p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="detail = null">关闭</button></div>
      </div>
    </div>

    <!-- 反审退回 -->
    <!-- ================= 订单号反查 ================= -->
    <OrderNoTrace v-model="traceOpen" :initial-no="traceSeed" @open-order="onTraceOpenOrder" />

    <!-- ================= 改订单号 ================= -->
    <div v-if="renForm.open" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>改订单号 · {{ renForm.oldNo }}</h3>
          <button class="x" @click="renForm.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="notice" style="background:var(--surface-2);border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.8;color:#33425c;margin-bottom:12px">
            订单号是全流程的锚点。<b>改了之后，生产任务、裁片外发、领料单、计件明细、售后工单、采购订单上印的号会一起跟着变</b> ——
            不跟着变的话，车间按单号找货就会找不到，而系统里显示一切正常。
            所以这里先让你看清影响面，再决定要不要改。
          </div>

          <div class="row" style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
            <label style="font-size:12.5px;color:#5b6b80;white-space:nowrap">新订单号</label>
            <input class="input" style="flex:1" v-model="renForm.next"
              placeholder="输入新的订单号，如客户改单后的 PO 号" @keyup.enter="doPreview" />
            <button class="btn btn-ghost" :disabled="renForm.checking" @click="doPreview">
              {{ renForm.checking ? '检查中…' : '检查影响' }}
            </button>
          </div>

          <div v-if="renForm.preview" style="font-size:12.5px;line-height:1.9">
            <div class="ren-arrow">
              <span class="old">{{ renForm.preview.old_no }}</span>
              <span>→</span>
              <span class="new">{{ renForm.preview.new_no }}</span>
              <span v-if="!renForm.preview.changed" class="tag orange">与当前一致</span>
            </div>
            <div v-if="renForm.preview.conflict" class="tag red">
              该号已被 #{{ renForm.preview.conflict.id }} 占用，不能使用
            </div>
            <template v-else-if="!renForm.preview.impacts.length">
              <div class="mut">这张订单目前没有下游单据挂着，改号只影响订单本身。</div>
            </template>
            <template v-else>
              <div>会连带改 <b>{{ renForm.preview.total_rows }}</b> 行：</div>
              <div class="ren-imp">
                <span v-for="im in renForm.preview.impacts" :key="im.table">
                  {{ im.label }} {{ im.rows }} 行
                </span>
              </div>
            </template>
          </div>

          <div class="row" style="display:flex;gap:8px;align-items:flex-start;margin-top:12px">
            <label style="font-size:12.5px;color:#5b6b80;white-space:nowrap;padding-top:8px">改号原因</label>
            <textarea class="input" style="flex:1" rows="2" v-model="renForm.reason"
              placeholder="必填（至少 6 字），如：客户要求改用其系统 PO 号 / 下单时打错一位（至少 6 字）"></textarea>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px">
            <button class="btn btn-ghost" @click="renForm.open = false">取消</button>
            <button class="btn btn-primary" :disabled="renForm.saving || !renForm.preview || !renForm.preview.changed || renForm.preview.conflict"
              @click="doRename">
              {{ renForm.saving ? '改号中…' : '确认改号' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="rollbackOpen" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>反审退回 · {{ detail.order_no }}</h3>
          <button class="x" @click="rollbackOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid" style="grid-template-columns: 1fr">
            <div class="fitem">
              <label>退回到 *</label>
              <select class="select" v-model="rollbackTo">
                <option v-for="s in rollbackTargets" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>退回原因 * <span style="font-weight: 400; color: var(--ink-mute)">会写进流转记录</span></label>
              <textarea rows="3" v-model="rollbackReason" placeholder="如：面料到货后发现色差，需退回业务重新与客户确认面辅料"></textarea>
            </div>
          </div>
          <div class="tip-warn">{{ rollbackHint }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="rollbackOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="doRollback">确认退回</button>
        </div>
      </div>
    </div>

    <!-- 报工 -->
    <div v-if="reportNode" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>报工 · {{ reportNode.name }}</h3><button class="x" @click="reportNode = null">×</button></div>
        <div class="modal-body">
          <table v-if="reports.length" class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 10px">
            <thead><tr><th>日期</th><th>合格</th><th>不良</th><th>工时</th><th>操作人</th><th></th></tr></thead>
            <tbody>
              <tr v-for="r in reports" :key="r.id">
                <td>{{ r.report_date }}</td><td>{{ r.qty_ok }}</td><td>{{ r.qty_defect }}</td><td>{{ r.hours }}</td><td>{{ r.operator }}</td>
                <td><button class="link-btn danger" @click="delReport(r.id)">删</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else style="font-size: 12.5px; color: var(--ink-mute); margin-bottom: 10px">暂无报工记录</div>
          <ReportWageQuote :node-id="reportNode.id" :report-date="reportForm.report_date" @change="reportWageSelection=$event" />
          <div class="form-grid">
            <div class="fitem"><label>日期</label><input class="input" type="date" v-model="reportForm.report_date" /></div>
            <div class="fitem"><label>合格数</label><input class="input" type="number" v-model.number="reportForm.qty_ok" /></div>
            <div class="fitem"><label>不良数</label><input class="input" type="number" v-model.number="reportForm.qty_defect" /></div>
            <div class="fitem"><label>工时</label><input class="input" type="number" v-model.number="reportForm.hours" /></div>
            <div class="fitem"><label>操作人</label><input class="input" v-model="reportForm.operator" /></div>
            <div class="fitem"><label>备注</label><input class="input" v-model="reportForm.remark" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="reportNode = null">关闭</button>
          <button class="btn btn-primary" :disabled="reportBusy||!reportWageSelection" @click="addReport">添加报工</button>
        </div>
      </div>
    </div>

    <!-- 开发详情：面辅料 / 成衣尺寸 / 生产要求（与开发管理同一个组件） -->
    <TechPackDetail :techpack-id="tpDetailId" @close="tpDetailId = null" @saved="reloadTechpacks" @version-created="onTpVersionCreated" />

    <!-- 现场照片大图（附件区缩略图点开） -->
    <div v-if="shot" class="shot-mask">
      <div class="shot-box">
        <img :src="shot.url" alt="" />
        <div class="shot-meta">
          <span class="att-cat big" :class="shot.cat">{{ catLabel(shot.cat) }}</span>
          <b>{{ shot.note || '（没写说明）' }}</b>
          <span class="tiny">{{ shot.node_name || '未指定工序' }} · {{ shot.shot_at || shot.created_at }} · {{ shot.uploader }}</span>
          <div class="shot-ops">
            <a :href="shot.url" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">原图</a>
            <button class="btn btn-ghost btn-sm" @click="shot = null">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- ================= 物料配颜色（款 × 颜色） ================= -->
  <div v-if="colorDlg.open" class="modal-mask">
    <div class="modal" style="width: 720px">
      <div class="modal-head">
        <h3>{{ colorDlg.name }}<span style="font-size: 12px; color: var(--ink-mute); margin-left: 8px">{{ colorDlg.styleNo }}</span></h3>
        <button class="x" @click="colorDlg.open = false">×</button>
      </div>
      <div class="modal-body">
        <p class="tiny" style="margin: 0 0 10px">
          选了「该款所有颜色」，这条物料就跟着该款每个颜色走；要按色区分色号或用量，就逐个勾选并在右侧填写。
        </p>

        <div style="display: flex; gap: 18px; align-items: center; margin-bottom: 12px">
          <label style="font-size: 13px; display: flex; gap: 6px; align-items: center">
            <input type="radio" :value="true" v-model="colorDlg.all" /> 该款所有颜色通用
          </label>
          <label style="font-size: 13px; display: flex; gap: 6px; align-items: center">
            <input type="radio" :value="false" v-model="colorDlg.all" /> 按颜色分别指定
          </label>
        </div>

        <div v-if="colorDlg.all" class="ok-box" style="font-size: 12.5px">
          该款现用 {{ colorDlg.avail.length }} 个颜色，全部使用这条物料。以后该款加颜色，也会自动跟着用。
        </div>

        <table v-else class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden">
          <thead>
            <tr>
              <th style="width: 40px"></th>
              <th>颜色</th>
              <th style="width: 90px">件数</th>
              <th style="width: 130px">该色色号</th>
              <th style="width: 130px">该色单件用量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in colorDlg.rows" :key="r.colorway">
              <td><input type="checkbox" v-model="r.checked" /></td>
              <td><b>{{ r.colorway }}</b></td>
              <td class="tiny">{{ r.pcs }}</td>
              <td><input class="input" v-model="r.color_no" :disabled="!r.checked" placeholder="如 79" /></td>
              <td>
                <input class="input" type="number" step="0.01" v-model="r.qty" :disabled="!r.checked"
                  :placeholder="'空 = 沿用单件用量'" />
              </td>
            </tr>
            <tr v-if="!colorDlg.rows.length">
              <td colspan="5" class="empty-cell">这个款还没有录入颜色，先到「款式明细」里加颜色</td>
            </tr>
          </tbody>
        </table>

        <p class="tiny" style="margin: 8px 0 0">
          总用量按勾中的颜色分别累计：Σ(该色单件用量 × 该色件数) ×(1+损耗)。不填「该色单件用量」时用物料行的单件用量。
        </p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" @click="colorDlg.open = false">取消</button>
        <button class="btn btn-primary" :disabled="colorDlg.saving" @click="saveColorDlg">
          {{ colorDlg.saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>

  <CreditBlockModal
    v-if="blockCheck"
    :model-value="!!blockCheck"
    :check="blockCheck"
    :order-id="blockOrder ? blockOrder.id : null"
    :order-no="blockOrder ? blockOrder.no : ''"
    warehouse="cn"
    @close="blockCheck = null; blockOrder = null"
    @released="doShip($event.id)"
  />
</template>

<script setup>
import {preOrderMatrixForSales} from '../utils/preOrderMatrixTransfer';
import TrialNotice from '../components/TrialNotice.vue';
import SalesOrderEntry from '../components/SalesOrderEntry.vue';
import OrderEntrySnapshot from '../components/OrderEntrySnapshot.vue';
import { localDate, fmtTime } from '../utils/time';
import ReportWageQuote from '../components/ReportWageQuote.vue';
import StyleImageFields from '../components/StyleImageFields.vue';
import ReferencePager from '../components/ReferencePager.vue';
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, exportOrders } from '../api';
import CreditBlockModal from '../components/CreditBlockModal.vue';
import { auth } from '../store/auth';
import { can } from '../store/permissions';
import TechPackDetail from '../components/TechPackDetail.vue';
import MaterialPickerField from '../components/MaterialPickerField.vue';
import OrderNoTrace from '../components/OrderNoTrace.vue';

const route = useRoute();
const router = useRouter();

const list = ref([]);
// ---------- 批量流转 ----------
const selected = ref([]);          // 勾选的订单 id
const batchOpen = ref(false);
const batchTo = ref('');           // 目标状态
const batchNote = ref('');
const batchAllOrNothing = ref(false);
const batchPreview = ref(null);    // 预检结果（dry run）
const batchResult = ref(null);     // 执行结果
const batchBusy = ref(false);
const q = ref('');
const status = ref('');
const type = ref('');

const labels = ref({});
const flow = ref({});
const roles = ref({});
const rate = ref(6.5);

const customers = ref([]);
const products = ref([]);
const fabrics = ref([]);
const accessories = ref([]);
const sizeTemplates = ref([]);

const showCreate = ref(false);
const saving = ref(false);
const detail = ref(null);
const busy = ref(false);
const itemsEditing = ref(false);
const itemEditBusy = ref(false);
const itemEditForm = ref([]);

const techpacks = ref([]);
const cost = ref(null);
const samples = ref([]);
const tpOpen = reactive({});
const tpDetailId = ref(null);
const tpForm = ref(blankTp());
const tpAdding = ref(false);
const tpBusy = ref(false);
const costForm = ref({ material_cost: 0, accessory_cost: 0, labor_cost: 0, overhead_cost: 0, other_cost: 0, profit_rate: 30 });
const costBusy = ref(false);

const crafts = ref([]);
const craftAdding = ref(false);
const craftBusy = ref(false);
const craftForm = ref({ name: '', qty: 0, price: 0, rate: 0, fob_price: 0, is_wash: false, is_cut: false, instruction: '' });

const orderMats = ref([]);
const matAdding = ref(false);
const matBusy = ref(false);
const matForm = ref({
  material_id: null, type: 'fabric', name: '', unit: '', one_use: 0, loss: 0, price: 0,
  spec: '', ingredient: '', supplier: '', mat_color: '',
  /* 挂到哪个款、该款哪些颜色用这个料 */
  item_id: null, all_colors: false, colors: []
});

/** 当前所选款有哪些颜色（选款后才出现勾选项） */
const matItemColors = computed(() => {
  const items = (detail.value && detail.value.items) || [];
  const it = items.find((x) => Number(x.id) === Number(matForm.value.item_id));
  if (!it) return [];
  const seen = new Map();
  (it.colors || []).forEach((c) => {
    if (!c.color) return;
    seen.set(c.color, (seen.get(c.color) || 0) + (Number(c.qty) || 0));
  });
  return [...seen.entries()].map(([color, qty]) => ({ color, qty }));
});

/**
 * 配颜色弹窗
 *
 * 两种模式：该款所有颜色通用 / 按色指定。后者每色可填色号与该色单件用量 —— 
 * 同一块底布在不同印花色上色号不同、用量也常常不同（花回长度不一样）。
 */
const colorDlg = reactive({ open: false, id: null, name: '', styleNo: '', all: false, rows: [], avail: [], saving: false });

async function openColorDlg(m) {
  try {
    const d = await api.orderMaterialColors(m.id);
    colorDlg.id = m.id;
    colorDlg.name = m.name;
    colorDlg.styleNo = (m.item && (m.item.style_no || m.item.product_name)) || '';
    colorDlg.all = Number(d.all_colors) === 1;
    colorDlg.avail = d.item_colors || [];
    colorDlg.rows = colorDlg.avail.map((c) => {
      // 服务端返回的字段是 colorway（不是 color）—— 写错会得到一排空白的颜色
      const cw = c.colorway || c.color;
      const hit = (d.colors || []).find((x) => x.colorway === cw);
      return {
        colorway: cw,
        pcs: c.qty,
        checked: !!hit,
        color_no: hit ? (hit.color_no || '') : '',
        qty: hit && hit.qty !== null && hit.qty !== undefined ? hit.qty : ''
      };
    });
    colorDlg.open = true;
  } catch (e) { alert(e.message); }
}

async function saveColorDlg() {
  if (!colorDlg.all && !colorDlg.rows.some((r) => r.checked)) {
    // 一个色都不勾、又不是「全部通用」，等于这条物料没有颜色信息 —— 用量口径会退回整款件数
    if (!confirm('一个颜色都没勾，这条物料会变成「未指定颜色」，用量按整款件数算。确定？')) return;
  }
  colorDlg.saving = true;
  try {
    const body = colorDlg.all
      ? { all_colors: 1 }
      : {
        all_colors: 0,
        colors: colorDlg.rows.filter((r) => r.checked).map((r) => ({
          colorway: r.colorway,
          color_no: r.color_no || null,
          qty: r.qty === '' ? null : Number(r.qty)
        }))
      };
    await api.setOrderMaterialColors(colorDlg.id, body);
    colorDlg.open = false;
    orderMats.value = await api.orderMaterials(detail.value.id);
  } catch (e) { alert(e.message); } finally { colorDlg.saving = false; }
}

const nodes = ref([]);
const nodeBusy = ref(false);

const dispatches = ref([]);
const factories = ref([]);
const dispatchBusy = ref(false);
const dispatchForm = ref({ factory_id: null, qty: 0, price: 0, remark: '' });

const reportNode = ref(null);
const reportWageSelection=ref(null);
const reportRequestNo=ref('');
const reports = ref([]);
const reportBusy = ref(false);
const reportForm = ref({ report_date: '', qty_ok: 0, qty_defect: 0, hours: 0, operator: '', remark: '' });
const reportAgg = ref({});

const attachments = ref([]);
/** 附件区：图片走缩略图（现场照片看一眼比看文件名有用），其他走文件行 */
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const photoAtts = computed(() => (attachments.value || []).filter((a) => IMG_EXT.test(a.url || '')));
const fileAtts = computed(() => (attachments.value || []).filter((a) => !IMG_EXT.test(a.url || '')));
const shot = ref(null);
const CAT_LABELS = { defect: '不良', incoming: '到货', packing: '装箱', sample: '样品', other: '其他' };
function catLabel(c) { return CAT_LABELS[c] || '其他'; }
const attUploading = ref(false);

const allChecked = computed(() => pagination.rows.length > 0 && pagination.rows.every(o => selected.value.includes(o.id)));
const batchToLabel = computed(() => labels.value[batchTo.value] || batchTo.value || '未选');
const batchLabels = computed(() => Object.fromEntries(Object.entries(labels.value).filter(([key]) => !['instock', 'shipped'].includes(key))));

function toggleAll() {
  const ids = pagination.rows.map(o => o.id);
  selected.value = allChecked.value ? selected.value.filter(id => !ids.includes(id)) : [...new Set([...selected.value, ...ids])];
}
function toggleOne(id) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}

function openBatch() {
  if (!batchTo.value) return alert('先选目标状态');
  if (!selected.value.length) return;
  batchOpen.value = true;
  batchPreview.value = null;
  batchResult.value = null;
  batchNote.value = '';
}

function closeBatch() {
  batchOpen.value = false;
  batchPreview.value = null;
  batchResult.value = null;
  selected.value = [];
  load();
}

async function doPrecheck() {
  batchBusy.value = true;
  try {
    batchPreview.value = await api.orderBatchTransition({
      ids: selected.value,
      to: batchTo.value,
      dry_run: 1
    });
  } catch (e) {
    alert(e.message);
  } finally {
    batchBusy.value = false;
  }
}

async function doExecute() {
  const pv = batchPreview.value;
  if (!pv) return;
  const tip = batchAllOrNothing.value
    ? `整批模式：这 ${pv.requested} 单必须全部满足条件才执行，任一失败整批不动。继续？`
    : `将把 ${pv.ok_count} 单流转到「${batchToLabel.value}」。\n被拦的 ${pv.fail_count} 单不会被动。继续？`;
  if (!confirm(tip)) return;
  batchBusy.value = true;
  try {
    batchResult.value = await api.orderBatchTransition({
      ids: selected.value,
      to: batchTo.value,
      note: batchNote.value,
      all_or_nothing: batchAllOrNothing.value ? 1 : 0
    });
    batchPreview.value = null;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    batchBusy.value = false;
  }
}

// 信用拦截弹窗（发货被拦时用；放行后回调 doShip 续发）
const blockCheck = ref(null);
const blockOrder = ref(null);

const canCreate = computed(() => can('order.create'));
const canEditItems = computed(() => Boolean(detail.value && detail.value.status === 'draft' && can('order.create')));
const canExport = computed(() => can('order.export'));

/* ---------------- 改订单号 ---------------- */
const renForm = reactive({ open: false, oldNo: '', next: '', reason: '', preview: null, checking: false, saving: false });

/**
 * 能不能改号
 *
 * 与后端同一套判断（后端仍会再拦一次，这里只是别让人白点）：
 *   已发货 / 已结案 / 已取消 —— 号已经在系统外（面单、对账单、结算），不许改
 *   生产中 / 已入库 —— 车间仓库正按这个号找货，只有管理员能改
 */
function canRename(o) {
  if (!o || !can('order.rename')) return false;
  if (['shipped', 'closed', 'cancelled'].includes(o.status)) return false;
  if (['production', 'instock'].includes(o.status) && auth.user && auth.user.role !== 'admin') return false;
  return true;
}

function openRename() {
  Object.assign(renForm, { open: true, oldNo: detail.value.order_no, next: detail.value.order_no, reason: '', preview: null, checking: false, saving: false });
}

async function doPreview() {
  renForm.checking = true;
  try {
    renForm.preview = await api.orderNoPreview(detail.value.id, renForm.next);
  } catch (e) {
    alert(e.message);
    renForm.preview = null;
  } finally {
    renForm.checking = false;
  }
}

async function doRename() {
  if (!renForm.reason.trim() || renForm.reason.trim().length < 6) {
    alert('请写清改号原因（至少 6 个字）');
    return;
  }
  renForm.saving = true;
  try {
    const r = await api.renameOrderNo(detail.value.id, { order_no: renForm.next, reason: renForm.reason });
    renForm.open = false;
    const NL = String.fromCharCode(10);
    const rows = r.synced.map((x) => `- ${x.label} ${x.rows} 行`);
    const tip = r.total_rows
      ? [`已改号：${r.old_no} → ${r.new_no}，同时更新了 ${r.total_rows} 行下游单据`, ...rows].join(NL)
      : `已改号：${r.old_no} → ${r.new_no}（没有下游单据需要同步）`;
    alert(tip);
    detail.value = await api.order(detail.value.id);
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    renForm.saving = false;
  }
}

/**
 * 批量打印：拿当前列表里的订单一次性出工单。
 * 限 50 张——一次打上百张会卡住浏览器，而且纸质工单一次性也发不了那么多。
 */
function batchPrint() {
  const ids = (list.value || []).map((o) => o.id).slice(0, 50);
  if (!ids.length) {
    alert('当前列表没有订单');
    return;
  }
  const tip = ids.length >= 50 ? '（只取前 50 张）' : '';
  if (!confirm(`批量打印 ${ids.length} 张生产工单${tip}？\n\n工艺明细、面辅料、裁床扎包等完整内容请单张打印。`)) return;
  router.push({ path: '/print/batch', query: { type: 'production', ids: ids.join(',') } });
}
const canTechWrite = computed(() => can('development.write'));
/**
 * 颜色/花型的维护权（product.color.write：只有技术 + 管理员）
 * 下单时「选颜色」人人可做；「新增颜色」会改产品主数据，影响以后所有订单与库存口径，所以单独一道门。
 */
const canColorWrite = computed(() => can('product.color.write'));
const canTechReview = computed(() => can('development.review'));
const canCostWrite = computed(() => can('cost.write'));
const canFinanceReview = computed(() => can('cost.review'));
const canCraftWrite = computed(() => can('craft.write'));
const canMatWrite = computed(() => can('material.write'));
const canNodeWrite = computed(() => can('node.write'));
const canStockWrite = computed(() => can('order.instock'));
const canShip = computed(() => can('order.ship'));
const canDispatch = computed(() => can('order.dispatch'));
const orderQty = computed(() => {
  if (!detail.value) return 0;
  return detail.value.items.reduce((s, it) => s + Number(it.qty || 0), 0);
});
const dispatchedQty = computed(() => dispatches.value.reduce((sum, row) => {
  const hasFactory = Boolean(row.factory_id || (String(row.factory_name || '').trim() && String(row.factory_name).trim() !== '未指定'));
  return sum + (hasFactory ? Number(row.qty) || 0 : 0);
}, 0));
const dispatchRemaining = computed(() => Math.max(0, Math.round((orderQty.value - dispatchedQty.value) * 10000) / 10000));
const doneCount = computed(() => nodes.value.filter((n) => n.status === 'done').length);
const allMats = computed(() => [...fabrics.value, ...accessories.value]);
const fabricCost = computed(() => orderMats.value.filter((m) => m.type === 'fabric').reduce((s, m) => s + Number(m.amount || 0), 0));
const accessoryCost = computed(() => orderMats.value.filter((m) => m.type === 'accessory').reduce((s, m) => s + Number(m.amount || 0), 0));

const DEFAULT_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

function blankTp() {
  return { product_name: '', version: 'V1', fabric_ids: [], accessory_ids: [], fabric_info: '', accessory_info: '', craft_info: '', customer_req: '', size_spec: '' };
}
function blankColor(color = '', sizes = null) {
  const list = sizes && sizes.length ? sizes : DEFAULT_SIZES;
  return { color, sizes: list.map((s) => ({ size: s, qty: 0, usd_price: 0 })) };
}
function blankItem() {
  return { product_id: null, product_name: '', style_no: '', sku: '', remark:'', effect_image_url:'', detail_images:[], source_pre_order_item_id:null, expected_qty:0, colors: [blankColor()] };
}
function blankForm() {
  return { source_pre_order_id:null, source_pre_order_version:null, order_no: '', type: 'custom', customer_id: null, customer_name_snapshot: '', recipient_name: '', recipient_phone: '', shipping_address: '', style_name: '', cus_order_no: '', manager: '', order_date: '', delivery_method: '', packaging: '', trade_terms: '', shop_name: '', shop_order_no: '', delivery_days: 0, freight: 0, delivery_date: '', remark: '', items: [blankItem()] };
}
const form = ref(blankForm());
// 切换客户时同步重置，避免把上一客户的收货资料带到新订单。
function fillCustomerShipping() {
  const customer = customers.value.find(c => c.id === form.value.customer_id);
  form.value.customer_name_snapshot = customer?.name || '';
  form.value.recipient_name = customer?.contact || '';
  form.value.recipient_phone = customer?.phone || '';
  form.value.shipping_address = customer?.shipping_address || '';
}


const colorQty = (c) => c.sizes.reduce((s, x) => s + (Number(x.qty) || 0), 0);
const colorUsd = (c) => c.sizes.reduce((s, x) => s + (Number(x.qty) || 0) * (Number(x.usd_price) || 0), 0);
const itemQty = (it) => it.colors.reduce((s, c) => s + colorQty(c), 0);
const itemUsd = (it) => it.colors.reduce((s, c) => s + colorUsd(c), 0);
const orderUsd = computed(() => form.value.items.reduce((s, it) => s + itemUsd(it), 0));
const orderCny = computed(() => Math.round(orderUsd.value * rate.value * 100) / 100);

const costTotalPreview = computed(() =>
  ['material_cost', 'accessory_cost', 'labor_cost', 'overhead_cost', 'other_cost'].reduce((s, k) => s + (Number(costForm.value[k]) || 0), 0)
);
const costPricePreview = computed(() => Math.round(costTotalPreview.value * (1 + (Number(costForm.value.profit_rate) || 0) / 100) * 100) / 100);

/** 反审：可退回的目标（当前状态之前的所有环节，不含已发货/已结案） */
const ROLLBACK_CHAIN = ['draft', 'tech', 'finance', 'assigned', 'production', 'instock'];
const rollbackOpen = ref(false);
const rollbackTo = ref('draft');
const rollbackReason = ref('');
const canRollback = computed(() => {
  if (!detail.value) return false;
  const cur = detail.value.status;
  return ROLLBACK_CHAIN.includes(cur) && ROLLBACK_CHAIN.indexOf(cur) > 0;
});
const rollbackTargets = computed(() => {
  if (!detail.value) return [];
  const idx = ROLLBACK_CHAIN.indexOf(detail.value.status);
  return ROLLBACK_CHAIN.slice(0, Math.max(idx, 0)).map((s) => ({ value: s, label: labels.value[s] || s }));
});
const rollbackHint = computed(() => {
  const cur = detail.value ? detail.value.status : '';
  const parts = [];
  if (cur === 'instock') parts.push('已入库的货会按库存流水冲销回生产仓');
  if (cur === 'production' || cur === 'instock') parts.push('13 道工序全部重置为待开始，返工需重新报工');
  if (cur === 'assigned') parts.push('分单信息保留，退回后可重新分单');
  parts.push('退回原因会写进流转记录，前后状态都可追溯');
  return '退回后：' + parts.join('；') + '。';
});

function openRollback() {
  rollbackReason.value = '';
  rollbackTo.value = rollbackTargets.value.length ? rollbackTargets.value[0].value : 'draft';
  rollbackOpen.value = true;
}
async function doRollback() {
  if (!detail.value) return;
  if (!rollbackReason.value.trim()) return alert('请填写退回原因');
  const label = labels.value[rollbackTo.value] || rollbackTo.value;
  if (!confirm(`确认把订单退回「${label}」？会产生库存与工序回滚。`)) return;
  busy.value = true;
  try {
    const r = await api.rollbackOrder(detail.value.id, rollbackTo.value, rollbackReason.value.trim());
    detail.value = r.order;
    await load();
    await loadP2(detail.value.id);
    rollbackOpen.value = false;
    const ef = r.effects || {};
    const extra = [];
    if (ef.stockReversed) extra.push(`冲销库存 ${ef.stockReversed} 件`);
    if (ef.nodesReset) extra.push(`重置工序 ${ef.nodesReset} 道`);
    alert(`已退回「${label}」` + (extra.length ? '\n' + extra.join('，') : ''));
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

const nextStates = computed(() => {
  if (!detail.value) return [];
  const cur = detail.value.status;
  const next = [...(flow.value[cur] || [])];
  if (cur !== 'closed' && cur !== 'cancelled') next.push('cancelled');
  return next.filter((t) => !['instock', 'shipped'].includes(t) && (auth.user?.role === 'admin' || (roles.value[t] || []).includes(auth.user?.role)));
});

const TAG = { draft: 'gray', tech: 'blue', finance: 'orange', assigned: 'purple', production: 'orange', instock: 'green', shipped: 'green', closed: 'gray', cancelled: 'red' };
const TP_TAG = { draft: 'gray', confirmed: 'green', rejected: 'red' };
const TP_LABEL = { draft: '草稿', confirmed: '已确认', rejected: '已驳回' };
const COST_TAG = { draft: 'gray', pending: 'orange', approved: 'green', rejected: 'red' };
const COST_LABEL = { draft: '草稿', pending: '待审核', approved: '已通过', rejected: '已驳回' };
const tagOf = (s) => TAG[s] || 'gray';
const tpTag = (s) => TP_TAG[s] || 'gray';
const tpLabel = (s) => TP_LABEL[s] || s;
const costTag = (s) => COST_TAG[s] || 'gray';
const costLabel = (s) => COST_LABEL[s] || s;
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const dateStr = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');

function matNames(ids, list) {
  if (!ids) return '—';
  const arr = String(ids).split(',').filter(Boolean);
  const names = arr.map((id) => (list.find((m) => String(m.id) === String(id)) || {}).name).filter(Boolean);
  return names.length ? names.join('、') : '—';
}

async function loadMeta() {
  const meta = await api.orderMeta();
  labels.value = meta.labels || {};
  flow.value = meta.flow || {};
  roles.value = meta.roles || {};
  if (meta.rate) rate.value = meta.rate;
}
async function loadRefs() {
  const [cs, ps, ms, st, fs] = await Promise.all([api.customers({}), api.products({}), api.materials({}), api.sizeTemplates(), api.factories({ status: 'active' })]);
  customers.value = cs;
  products.value = ps;
  fabrics.value = ms.filter((m) => m.type === 'fabric' && m.status === 'active');
  accessories.value = ms.filter((m) => m.type === 'accessory' && m.status === 'active');
  sizeTemplates.value = st;
  factories.value = fs;
}
async function load() {
  try { list.value = await api.orders({view:'reference'}); }
  catch (e) { alert(e.message); }
}

function openCreate() { form.value = blankForm(); showCreate.value = true; }
function addItem() { form.value.items.push(blankItem()); }
function removeItem(i) { if (form.value.items.length > 1) form.value.items.splice(i, 1); }
function addColor(it) { it.colors.push(blankColor('', productSizeNames(it))); }
function removeColor(it, ci) { if (it.colors.length > 1) it.colors.splice(ci, 1); }
function addSize(c) { c.sizes.push({ size: '', qty: 0, usd_price: 0 }); }
function removeSize(c, si) { if (c.sizes.length > 1) c.sizes.splice(si, 1); }

/** 当前行选中的产品（产品列表已带 colors / sizes，见 GET /api/products） */
function productOf(it) {
  return it.product_id ? products.value.find((x) => x.id === it.product_id) || null : null;
}
/** 该产品配好的颜色名（下拉选项）。没配就是空数组 → 退回手填 */
function colorOptions(it) {
  const p = productOf(it);
  return p && p.colors ? p.colors.map((c) => c.name) : [];
}
/** 该产品配好的尺码；没配用默认 S~XXL */
function productSizeNames(it) {
  const p = productOf(it);
  const list = p && p.sizes && p.sizes.length ? p.sizes.map((s) => s.size) : DEFAULT_SIZES;
  return list;
}

/**
 * 选产品：把「颜色」和「尺码」按产品主数据铺好，并**保留已经填过的数量与单价**
 * （销售先填数量再改产品是常见操作，直接清空比填错更让人恼火）。
 */
function pickProduct(it) {
  const p = products.value.find((x) => x.id === it.product_id);
  if (!p) return;
  it.product_name = p.name;
  const usd = rate.value > 0 ? Math.round((Number(p.price) / rate.value) * 100) / 100 : 0;

  const sizes = productSizeNames(it);
  const colors = (p.colors || []).map((c) => c.name);

  // 旧值按「颜色 + 尺码」两个键对齐（不分大小写），改名/重选产品都不会把数字清零
  const prevColor = new Map(it.colors.map((c) => [String(c.color || '').trim().toUpperCase(), c]));
  const prevCell = (prev, size) => {
    if (!prev) return null;
    const hit = prev.sizes.find((s) => String(s.size || '').trim().toUpperCase() === String(size).toUpperCase());
    return hit || null;
  };

  if (colors.length) {
    it.colors = colors.map((name) => {
      const prev = prevColor.get(name.toUpperCase());
      return {
        color: name,
        sizes: sizes.map((size) => {
          const cell = prevCell(prev, size);
          return { size, qty: cell ? cell.qty : 0, usd_price: (cell && cell.usd_price) || usd };
        })
      };
    });
  } else {
    // 产品还没配颜色：保留现有颜色组，只把尺码换成产品尺码
    it.colors.forEach((c) => {
      const keep = c.sizes;
      c.sizes = sizes.map((size) => {
        const cell = prevCell({ sizes: keep }, size);
        return { size, qty: cell ? cell.qty : 0, usd_price: (cell && cell.usd_price) || usd };
      });
    });
  }
}

/** 新增颜色到产品主数据（需 product.color.write），成功后直接选上 */
async function addColorToProduct(it) {
  if (!canColorWrite.value) return;
  if (!it.product_id) return alert('请先选择产品，再新增颜色');
  const name = (prompt('新增颜色 / 花型名称（会写进产品主数据，以后所有订单都能选）') || '').trim();
  if (!name) return;
  try {
    const p = await api.addProductColor(it.product_id, { name });
    // 刷新本地产品缓存，让下拉立刻出现新颜色
    const idx = products.value.findIndex((x) => x.id === it.product_id);
    if (idx >= 0) products.value[idx] = p;
    const empty = it.colors.find((c) => !String(c.color || '').trim());
    if (empty) empty.color = name;
    else it.colors.push(blankColor(name, productSizeNames(it)));
  } catch (e) {
    alert(e.message);
  }
}
function applySizeTemplate(it, tid) {
  const t = sizeTemplates.value.find((x) => String(x.id) === String(tid));
  if (!t) return;
  const sizes = String(t.sizes).split(',').map((s) => s.trim()).filter(Boolean);
  it.colors.forEach((c) => {
    const priceMap = {};
    c.sizes.forEach((s) => { priceMap[s.size] = s.usd_price; });
    c.sizes = sizes.map((s) => ({ size: s, qty: 0, usd_price: priceMap[s] || 0 }));
  });
}

function validateForm() {
  for (const it of form.value.items) {
    if (!it.product_name && !it.product_id) return '请为每个款选择或填写产品';
    for (const c of it.colors) {
      const filled = c.sizes.filter((s) => Number(s.qty) > 0);
      if (filled.length && !String(c.color || '').trim()) return '存在有数量但未填写颜色的颜色组';
      if (filled.length && filled.some((s) => !s.size)) return '存在未填写尺码名的行';
    }
    if (!it.colors.some((c) => c.sizes.some((s) => Number(s.qty) > 0))) return `款「${it.product_name || '未命名'}」没有填写任何尺码数量`;
  }
  return '';
}

function entrySummary(order) {
  const e=JSON.parse(order.entry_json||'{}');
  return {'标签':(e.tags||[]).join('、'),'商品 USD':money(e.goods_usd),'税费 USD':money(e.tax_usd),'运费 USD':money(e.freight_usd),'优惠 USD':money(e.discount_usd),'附加 USD':money(e.surcharge_usd),'约定定金 USD':money(e.deposit_usd),'约定尾款 USD':money(e.balance_usd)};
}
async function entrySaved(created) {
  showCreate.value=false;
  await load();
  await router.replace({path:'/orders',query:{order:created.id}});
  await openDetail(created.id);
}

async function saveOrder() {
  const err = validateForm();
  if (err) return alert(err);
  const items = form.value.items.map((it) => ({
    product_id: it.product_id,
    product_name: it.product_name || '未命名产品',
    style_no: it.style_no,
    sku: it.sku,
    remark:it.remark,
    effect_image_url:it.effect_image_url,
    detail_images:it.detail_images || [],
    source_pre_order_item_id:it.source_pre_order_item_id,
    colors: it.colors.map((c) => ({
      color: c.color,
      sizes: c.sizes.filter((s) => Number(s.qty) > 0).map((s) => ({ size: s.size, qty: s.qty, usd_price: s.usd_price }))
    })).filter((c) => c.sizes.length)
  }));
  // 订单号是全流程锚点：前端先拦一次，避免跑到后端才被打回（后端仍会校验唯一性）
  if (!String(form.value.order_no || '').trim()) {
    alert('请填写订单号 —— 业务手工填写，不能留空');
    return;
  }
  saving.value = true;
  try {
    const created = await api.createOrder({
      source_pre_order_id:form.value.source_pre_order_id,
      source_pre_order_version:form.value.source_pre_order_version,
      order_no: String(form.value.order_no).trim(),
      type: form.value.type,
      customer_id: form.value.customer_id,
      recipient_name: form.value.recipient_name,
      recipient_phone: form.value.recipient_phone,
      shipping_address: form.value.shipping_address,
      style_name: form.value.style_name,
      cus_order_no: form.value.cus_order_no,
      manager: form.value.manager,
      order_date: form.value.order_date || null,
      delivery_method: form.value.delivery_method,
      packaging: form.value.packaging,
      trade_terms: form.value.trade_terms,
      shop_name: form.value.shop_name,
      shop_order_no: form.value.shop_order_no,
      delivery_days: form.value.delivery_days,
      freight: form.value.freight,
      delivery_date: form.value.delivery_date || null,
      remark: form.value.remark,
      items
    });
    showCreate.value = false;
    await load();
    if(form.value.source_pre_order_id) { await router.replace({path:'/orders',query:{order:created.id}});await openDetail(created.id); }
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function loadP2(id) {
  const [tp, cs, sp, cf, om, nd, su, dp, att] = await Promise.all([api.techpacks(id), api.cost(id), api.samples(id), api.crafts(id), api.orderMaterials(id), api.orderNodes(id), api.reportSummary(id), api.dispatches(id), api.attachments({ target_type: 'order', target_id: id })]);
  techpacks.value = tp || [];
  cost.value = cs || null;
  samples.value = sp || [];
  crafts.value = cf || [];
  orderMats.value = om || [];
  nodes.value = nd || [];
  dispatches.value = dp || [];
  attachments.value = att || [];
  dispatchForm.value.qty = dispatchRemaining.value;
  const agg = {};
  (su || []).forEach((r) => { agg[r.node_id] = { ok: Number(r.ok) || 0, defect: Number(r.defect) || 0, hours: Number(r.hours) || 0 }; });
  reportAgg.value = agg;
  if (cs) costForm.value = { material_cost: cs.material_cost, accessory_cost: cs.accessory_cost, labor_cost: cs.labor_cost, overhead_cost: cs.overhead_cost, other_cost: cs.other_cost, profit_rate: cs.profit_rate };
}
const aggOf = (id) => reportAgg.value[id] || { ok: 0, defect: 0, hours: 0 };
/* ---------------- 订单号反查 ---------------- */
const traceOpen = ref(false);
/**
 * 打开反查时预填的号：**只带搜索框里已经敲的内容**。
 *
 * 不兜底「列表第一张单的号」—— 用户没敲东西却被预填一个别人的号，
 * 看上去像「系统在查这张单」，查出来的结果会被当成自己的。
 * 空着就让 placeholder 给个格式示例，由用户自己决定查哪个号。
 */
const traceSeed = ref('');
function openTrace() {
  traceSeed.value = String(q.value || '').trim();
  traceOpen.value = true;
}
function onTraceOpenOrder(id) {
  traceOpen.value = false;
  openDetail(id);
}

async function openDetail(id) {
  try { detail.value = await api.order(id); itemsEditing.value = false; tpAdding.value = false; await loadP2(id); }
  catch (e) { alert(e.message); }
}
function openItemsEditor() {
  if (!canEditItems.value) return;
  itemEditForm.value = (detail.value.items || []).map((it) => ({
    id:it.id,effect_image_url:it.effect_image_url,detail_images:it.detail_images || [],
    product_id: it.product_id,
    product_name: it.product_name || '',
    style_no: it.style_no || '',
    sku: it.sku || '',
    remark: it.remark || '',
    sizes: (it.sizes || []).map((s) => ({ color: s.color || '', size: s.size || '', qty: Number(s.qty) || 0, usd_price: Number(s.usd_price) || 0 }))
  }));
  if (!itemEditForm.value.length) itemEditForm.value.push({ product_id: null, product_name: '', style_no: '', sku: '', remark: '', sizes: [{ color: '', size: '', qty: 0, usd_price: 0 }] });
  itemsEditing.value = true;
}
function addEditItem() {
  itemEditForm.value.push({ product_id: null, product_name: '', style_no: '', sku: '', remark: '', sizes: [{ color: '', size: '', qty: 0, usd_price: 0 }] });
}
function addEditSize(item) { item.sizes.push({ color: '', size: '', qty: 0, usd_price: 0 }); }
function removeEditSize(item, index) { item.sizes.splice(index, 1); }
async function saveItemsEditor() {
  if (!detail.value) return;
  for (const item of itemEditForm.value) {
    if (!item.product_name.trim()) return alert('每款都必须填写产品名称');
    if (!item.sizes.some((s) => Number(s.qty) > 0)) return alert(`款「${item.product_name}」至少要有一条有效数量`);
  }
  itemEditBusy.value = true;
  try {
    detail.value = await api.updateOrderItems(detail.value.id, itemEditForm.value);
    itemsEditing.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { itemEditBusy.value = false; }
}
async function addTechpack() {
  if (!tpForm.value.product_name) return alert('请填写产品/款号');
  tpBusy.value = true;
  try {
    const payload = {
      order_id: detail.value.id,
      product_name: tpForm.value.product_name,
      version: tpForm.value.version,
      fabric_ids: tpForm.value.fabric_ids.join(','),
      accessory_ids: tpForm.value.accessory_ids.join(','),
      fabric_info: tpForm.value.fabric_info,
      accessory_info: tpForm.value.accessory_info,
      craft_info: tpForm.value.craft_info,
      customer_req: tpForm.value.customer_req,
      size_spec: tpForm.value.size_spec
    };
    await api.createTechpack(payload);
    tpForm.value = blankTp();
    tpAdding.value = false;
    techpacks.value = await api.techpacks(detail.value.id);
  } catch (e) { alert(e.message); } finally { tpBusy.value = false; }
}
async function confirmTp(id) {
  try {
    /**
     * 先问一次"还差什么"（定制订单：面辅料/客户要求/至少 1 道车缝工序）。
     * 检查与确认走的是后端同一个 confirmBlocks()，所以不会出现"检查说没问题、点了却被拒"；
     * 有缺口时把清单直接列出来，比点完等一句报错更容易知道该去哪补。
     */
    const chk = await api.techpackConfirmCheck(id);
    if (chk && !chk.ok) return alert(chk.message);
    await api.confirmTechpack(id);
    techpacks.value = await api.techpacks(detail.value.id);
  } catch (e) { alert(e.message); }
}
/** 开发明细保存后刷新列表（状态/确认人可能变） */
async function reloadTechpacks() {
  if (!detail.value) return;
  try { techpacks.value = await api.techpacks(detail.value.id); } catch (e) { /* ignore */ }
}
function printTechpack(id) { window.open('/print/techpack/' + id, '_blank'); }
function onTpVersionCreated(id) { tpDetailId.value = id; reloadTechpacks(); }
async function saveCost() {
  costBusy.value = true;
  try { cost.value = await api.saveCost(detail.value.id, costForm.value); }
  catch (e) { alert(e.message); } finally { costBusy.value = false; }
}
async function reviewCost(approve) {
  costBusy.value = true;
  try { cost.value = await api.reviewCost(detail.value.id, approve, approve ? '同意' : '不通过'); }
  catch (e) { alert(e.message); } finally { costBusy.value = false; }
}
async function addCraft() {
  if (!craftForm.value.name) return alert('请填写工艺名称');
  craftBusy.value = true;
  try {
    await api.createCraft({ order_id: detail.value.id, ...craftForm.value });
    craftForm.value = { name: '', qty: 0, price: 0, rate: 0, fob_price: 0, is_wash: false, is_cut: false, instruction: '' };
    craftAdding.value = false;
    crafts.value = await api.crafts(detail.value.id);
  } catch (e) { alert(e.message); } finally { craftBusy.value = false; }
}
async function delCraft(id) {
  if (!confirm('确定删除该工艺？')) return;
  try { await api.deleteCraft(id); crafts.value = await api.crafts(detail.value.id); }
  catch (e) { alert(e.message); }
}

function pickMat() {
  const m = allMats.value.find((x) => x.id === matForm.value.material_id);
  if (!m) return;
  matForm.value.type = m.type;
  matForm.value.name = m.name;
  matForm.value.spec = [m.width && '幅宽'+m.width, m.weight && '克重'+m.weight, m.air_gap && '空差'+m.air_gap, m.spec].filter(Boolean).join(' ');
  matForm.value.ingredient = m.composition || '';
  matForm.value.unit = m.unit || '';
  matForm.value.colors = [];
  matForm.value.supplier = m.supplier || '';
}
async function addMat() {
  if (!matForm.value.name) return alert('请填写料名');
  matBusy.value = true;
  try {
    const f = matForm.value;
    await api.createOrderMaterial({
      order_id: detail.value.id,
      material_id: f.material_id,
      type: f.type,
      name: f.name,
      unit: f.unit,
      one_use: f.one_use,
      loss: f.loss,
      price: f.price,
      spec: f.spec,
      ingredient: f.ingredient,
      supplier: f.supplier,
      item_id: f.item_id || null,
      all_colors: f.all_colors ? 1 : 0,
      // 勾了颜色就按色存；勾了「所有颜色」则不传 colors（后端会清空子表）
      colors: (!f.all_colors && f.colors.length)
        ? f.colors.map((c) => ({ colorway: c, color_no: null, qty: null }))
        : undefined
    });
    matForm.value = {
      material_id: null, type: 'fabric', name: '', unit: '', one_use: 0, loss: 0, price: 0,
      spec: '', ingredient: '', supplier: '', mat_color: '', item_id: null, all_colors: false, colors: []
    };
    matAdding.value = false;
    orderMats.value = await api.orderMaterials(detail.value.id);
  } catch (e) { alert(e.message); } finally { matBusy.value = false; }
}
async function delMat(id) {
  if (!confirm('确定删除该面辅料？')) return;
  try { await api.deleteOrderMaterial(id); orderMats.value = await api.orderMaterials(detail.value.id); }
  catch (e) { alert(e.message); }
}
function applyMatCost() {
  costForm.value.material_cost = Math.round(fabricCost.value * 100) / 100;
  costForm.value.accessory_cost = Math.round(accessoryCost.value * 100) / 100;
}

async function initNodes() {
  nodeBusy.value = true;
  try { nodes.value = await api.initNodes(detail.value.id); }
  catch (e) { alert(e.message); } finally { nodeBusy.value = false; }
}
async function saveNode(n) {
  nodeBusy.value = true;
  try {
    const updated = await api.updateNode(n.id, { status: n.status, plan_date: n.plan_date, actual_date: n.actual_date, operator: n.operator, remark: n.remark });
    const i = nodes.value.findIndex((x) => x.id === n.id);
    if (i >= 0) nodes.value[i] = updated;
  } catch (e) { alert(e.message); } finally { nodeBusy.value = false; }
}
async function doDispatch() {
  if (!dispatchForm.value.factory_id) return alert('请选择工厂');
  dispatchBusy.value = true;
  try {
    const r = await api.createDispatch({ order_id: detail.value.id, ...dispatchForm.value });
    dispatches.value = r.dispatches;
    detail.value = await api.order(detail.value.id);
    await load();
    dispatchForm.value = { factory_id: null, qty: dispatchRemaining.value, price: 0, remark: '' };
  } catch (e) { alert(e.message); } finally { dispatchBusy.value = false; }
}
async function removeDispatch(id) {
  if (!confirm('确定删除该分单？')) return;
  try {
    await api.deleteDispatch(id);
    dispatches.value = await api.dispatches(detail.value.id);
    dispatchForm.value.qty = dispatchRemaining.value;
    detail.value = await api.order(detail.value.id);
    await load();
  }
  catch (e) { alert(e.message); }
}

async function doInstock() {  if (!confirm('按订单明细入库到生产仓？库存将增加，订单状态变为「已入库」。')) return;
  busy.value = true;
  try {
    await api.orderInstock({ order_id: detail.value.id, warehouse: 'cn' });
    detail.value = await api.order(detail.value.id);
    await load();
    await loadP2(detail.value.id);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}
async function doShip(overrideId) {
  // @click="doShip" 会把 MouseEvent 当第一个参数传进来（不是 null，也不是 id）。
  // 直接透给后端会变成「放行单 id 是个事件对象」，报一句看不懂的 SQL 错误。
  // 所以这里只认数字 id，其余一律当「没用放行单」。
  const ovId = Number.isFinite(Number(overrideId)) && overrideId !== null && overrideId !== undefined
    ? Number(overrideId)
    : null;
  if (!ovId && !confirm('按订单明细从生产仓发货出库？库存将扣减，订单状态变为「已发货」。')) return;
  busy.value = true;
  try {
    await api.orderShip({ order_id: detail.value.id, warehouse: 'cn', credit_override_id: ovId || undefined });
    detail.value = await api.order(detail.value.id);
    await load();
    await loadP2(detail.value.id);
    blockCheck.value = null;
  } catch (e) {
    // 信用受限：给结构化弹窗，而不是一句 alert 让人无路可走
    if (e.code === 'CREDIT_BLOCK') {
      blockOrder.value = { id: detail.value.id, no: detail.value.order_no };
      blockCheck.value = e.data;
      return;
    }
    alert(e.message);
  } finally { busy.value = false; }
}

function goPrint(type) {
  if (!detail.value) return;
  window.open(`/print/${type}/${detail.value.id}`, '_blank');
}
/** 验货报告：整单快照，可打印/另存 PDF 直接发客户 */
function goInspection() {
  const id = detail.value && detail.value.id;
  if (!id) return;
  router.push('/inspection/' + id);
}

function goLabels() {
  if (!detail.value) return;
  window.open(`/labels/${detail.value.id}`, '_blank');
}

async function exportCsv() {
  try {
    const blob = await exportOrders({ q: q.value, status: status.value, type: type.value });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'orders.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}

async function onOrderImage(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { alert('图片不能超过 3MB'); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const up = await api.upload(reader.result);
      await api.setOrderImage(detail.value.id, up.url);
      detail.value = await api.order(detail.value.id);
    } catch (err) { alert(err.message); }
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}

async function onAttachments(ev) {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  attUploading.value = true;
  try {
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { alert(`${f.name} 超过 10MB，已跳过`); continue; }
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      const up = await api.uploadFile(dataUrl, f.name);
      await api.createAttachment({ target_type: 'order', target_id: detail.value.id, filename: f.name, url: up.url, size: up.size, mime: up.mime });
    }
    attachments.value = await api.attachments({ target_type: 'order', target_id: detail.value.id });
  } catch (e) { alert(e.message); } finally { attUploading.value = false; ev.target.value = ''; }
}
async function removeAttachment(id) {
  if (!confirm('删除该附件？')) return;
  try { await api.deleteAttachment(id); attachments.value = await api.attachments({ target_type: 'order', target_id: detail.value.id }); }
  catch (e) { alert(e.message); }
}

/**
 * 打开附件
 *
 * 图片在公开区（`/uploads/…`）→ 直接开；
 * PDF / Office / zip 在私有区（`/api/files/att/…`）→ 带 token 下载（`api.download`）。
 */
async function openAtt(a) {
  const url = String((a && a.url) || '');
  if (!url) return;
  try {
    if (url.startsWith('/uploads/')) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    await api.download(url, (a && a.filename) || 'attachment');
  } catch (e) { alert(e.message); }
}

async function openReport(n) { reportWageSelection.value=null;reportRequestNo.value=globalThis.crypto?.randomUUID?.()||('report_'+Date.now()+'_'+Math.random().toString(36).slice(2));reportNode.value = n;
  reportForm.value = { report_date: localDate(), qty_ok: 0, qty_defect: 0, hours: 0, operator: '', remark: '' };
  try { reports.value = await api.reports({ node_id: n.id }); } catch (e) { reports.value = []; }
}
async function addReport() {
  if (!reportNode.value) return;
  reportBusy.value = true;
  try {
    await api.createReport({ node_id: reportNode.value.id, order_id: detail.value.id, ...reportForm.value,...reportWageSelection.value,request_no:reportRequestNo.value });
    reports.value = await api.reports({ node_id: reportNode.value.id });
    reportRequestNo.value=globalThis.crypto?.randomUUID?.()||('report_'+Date.now()+'_'+Math.random().toString(36).slice(2));
    reportForm.value = { report_date: localDate(), qty_ok: 0, qty_defect: 0, hours: 0, operator: '', remark: '' };
    await loadP2(detail.value.id);
  } catch (e) { alert(e.message); } finally { reportBusy.value = false; }
}
async function delReport(id) {
  try {
    await api.deleteReport(id);
    reports.value = await api.reports({ node_id: reportNode.value.id });
    await loadP2(detail.value.id);
  } catch (e) { alert(e.message); }
}
async function doTransition(to) {
  if (!detail.value) return;
  const note = to === 'cancelled' ? prompt('取消原因（可空）') ?? '' : '';
  busy.value = true;
  try {
    detail.value = await api.transitionOrder(detail.value.id, to, note);
    await load();
    await loadP2(detail.value.id);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function importPreOrder(id) {
  try {
    const draft=await api.preOrderDraft(id);
    form.value={...blankForm(),source_pre_order_id:draft.id,source_pre_order_version:draft.version,
      order_no:draft.order_no,customer_id:draft.customer_id,customer_name_snapshot:draft.customer_name,
      recipient_name:draft.recipient_name || '',recipient_phone:draft.recipient_phone || '',shipping_address:draft.shipping_address || '',
      pre_order_total_usd:draft.total_usd,pre_order_payment_ratio:draft.payment_ratio,deposit:draft.total_usd!=null&&draft.payment_ratio!=null?Math.round(Number(draft.total_usd)*Number(draft.payment_ratio))/100:0,
      manager:draft.manager || '',delivery_date:draft.target_date || '',remark:draft.requirements || '',style_name:draft.style_name || '',
      items:draft.items.map(item=>({...blankItem(),product_name:item.product_name||item.style_no||'图片新款（待命名）',style_no:item.style_no || '',remark:item.remark || '',expected_qty:item.expected_qty,...preOrderMatrixForSales(item),source_pre_order_item_id:item.id,sample_archive_id:item.source_type==='archive'?item.sample_archive_id:null,effect_image_url:item.effect_image_url || '',detail_images:[...(item.detail_images || [])]}))};
    showCreate.value=true;
  }catch(error){alert(error.message);}
}
watch(()=>route.query.pre_order,id=>{if(id)importPreOrder(id);});

onMounted(async () => {
  try { await Promise.all([loadMeta(), loadRefs()]); } catch (e) { /* ignore */ }
  await load();
  const oid = route.query.order;
  if (oid) openDetail(oid);
  if (route.query.pre_order) await importPreOrder(route.query.pre_order);
  else if (route.query.new) openCreate();
});

// List filtering is read-only: every amount remains the persisted order snapshot.
const salesFilters=reactive({shop:'',shopOrder:'',customer:'',manager:'',tag:'',start:'',end:'',days:'',approval:''});
const patternOrder=ref(null);
const salesCustomers=computed(()=>[...new Set(list.value.map(o=>o.customer_name).filter(Boolean))]);
const salesManagers=computed(()=>[...new Set(list.value.map(o=>o.manager).filter(Boolean))]);
const salesTags=computed(()=>[...new Set(list.value.flatMap(o=>o.tags||[]))]);
const includesText=(value,term)=>String(value||'').toLowerCase().includes(String(term).trim().toLowerCase());
const filteredSales=computed(()=>list.value.filter(o=>{
 const date=fmtTime(o.order_date||o.created_at,true);
 return (!q.value||includesText(o.order_no,q.value))&&(!status.value||o.status===status.value)&&(!type.value||o.type===type.value)&&includesText(o.shop_name,salesFilters.shop)&&includesText(o.shop_order_no,salesFilters.shopOrder)&&(!salesFilters.customer||o.customer_name===salesFilters.customer)&&(!salesFilters.manager||o.manager===salesFilters.manager)&&(!salesFilters.tag||(o.tags||[]).includes(salesFilters.tag))&&(!salesFilters.start||date>=salesFilters.start)&&(!salesFilters.end||date<=salesFilters.end)&&(salesFilters.days===''||(o.delivery_days!=null&&Number(o.delivery_days)===Number(salesFilters.days)))&&(!salesFilters.approval||o.cost_status===salesFilters.approval);
}));
const pagination=reactive({page:1,pageSize:12,total:computed(()=>filteredSales.value.length),rows:computed(()=>filteredSales.value.slice((pagination.page-1)*pagination.pageSize,pagination.page*pagination.pageSize))});
watch([q,status,type,()=>({...salesFilters})],()=>{pagination.page=1;});
function resetSalesFilters(){q.value='';status.value='';type.value='';Object.keys(salesFilters).forEach(k=>salesFilters[k]='');pagination.page=1;}

</script>

<style scoped>
/* 订单号必填标记与说明：全局没有这两个类，不定义就是普通文字、看不出哪项必填 */
.req { color: #d92d45; font-weight: 700; }
.fitem .hint { font-size: 12px; color: var(--ink-mute); line-height: 1.55; margin-top: 4px; }
/* 改号弹窗里的影响面清单 */
.ren-imp { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
.ren-imp span { font-size: 12px; background: #eef3fa; color: #1f5fae; border-radius: 20px; padding: 2px 9px; }
.ren-arrow { display: flex; align-items: center; gap: 10px; font-size: 13px; margin: 10px 0; flex-wrap: wrap; }
.ren-arrow .old { color: var(--ink-mute); text-decoration: line-through; }
.ren-arrow .new { color: var(--ink); font-weight: 700; }
/* 工序表 7 列挤在弹窗里会把「成品入库」压成竖排：外层横向滚动 + 单元格不折行 */
.rollback-btn { border-color: #f0c9cf; color: #d92d45; }
.rollback-btn:hover { background: #fdecee; }
.rollback-tip { margin: 8px 0 0; font-size: 12px; color: var(--ink-mute); line-height: 1.6; }
.node-scroll { overflow-x: auto; }
.node-table { min-width: 760px; }
.node-table th,
.node-table td { white-space: nowrap; }

/* 附件区缩略图 */
.att-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.att-cell {
  position: relative;
  border: 1px solid #e6ebf3;
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  background: var(--surface-2);
}
.att-cell img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; }
.att-cat {
  position: absolute;
  left: 5px;
  top: 5px;
  font-size: 12px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--brand);
}
.att-cat.defect { color: #d92d45; }
.att-cat.incoming { color: #b45309; }
.att-cat.packing { color: #0f766e; }
.att-cat.sample { color: #7c3aed; }
.att-cat.big { position: static; font-size: 12px; }
.att-note {
  font-size: 12px;
  color: #4a5769;
  padding: 4px 6px 6px;
  line-height: 1.45;
  /* 两行截断：一行放不下「左袖口跳线 3 处，已停线待返工」这种说明 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 30px;
}

/* 大图 */
.shot-mask {
  position: fixed;
  inset: 0;
  background: rgba(14, 22, 38, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
  padding: 24px;
}
.shot-box {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  max-width: 960px;
  width: 100%;
  background: #16233b;
  border-radius: 14px;
  padding: 16px;
  max-height: 88vh;
}
.shot-box img {
  max-height: 76vh;
  max-width: 62%;
  object-fit: contain;
  border-radius: 10px;
  background: #0d1626;
}
.shot-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  color: #dfe6f2;
  font-size: 13px;
}
.shot-meta b { color: #fff; font-size: 14.5px; line-height: 1.6; }
.shot-meta .tiny { color: #8b9ab2; font-size: 12px; }
.shot-ops { display: flex; gap: 8px; margin-top: 6px; }
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 10px 14px;
  border: 1px solid #d6e4ff;
  border-radius: 12px;
  background: #eef4ff;
}
.batch-bar .spacer { flex: 1; }
.row-sel td { background: #f6f9ff; }
.pre-sum { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bfield { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.bfield label > span { display: block; font-size: 12.5px; color: var(--ink-soft); margin-bottom: 5px; }
.bchk { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-soft); }
.modal.wide .data.sm td { vertical-align: top; }
/* 颜色提示：不抢注意力，只解释「为什么这里只能选不能改」 */
.color-hint { font-size: 12px; color: var(--ink-mute); margin: -2px 0 6px; line-height: 1.6; }
</style>

<style scoped>
.order-entry-summary{display:flex;gap:16px;flex-wrap:wrap;padding:12px;background:var(--surface-soft,var(--bg));border:1px solid var(--line);border-radius:6px;margin-bottom:14px}.order-entry-summary small{color:var(--ink-mute);margin-right:5px}
</style>

<style scoped>

.sales-reference{--list-accent:#1890ff;color:var(--ink)}.sales-reference-crumb{font-size:12px;color:var(--ink-mute);padding:0 0 12px}.sales-list-filters{display:flex;gap:24px 14px;flex-wrap:wrap;background:var(--surface);padding:22px 14px 28px;margin-bottom:18px}.sales-list-filters label{display:flex;align-items:center;gap:10px;white-space:nowrap;font-weight:600;font-size:12px}.sales-list-filters input,.sales-list-filters select{font:inherit;color:var(--ink);border:1px solid var(--line);background:var(--surface);border-radius:3px;height:30px;padding:0 10px;width:160px;min-width:0}.sales-list-filters label:first-child input{width:200px}.sales-list-filters .sales-date-filter input{width:135px}.sales-reference button{font:inherit;cursor:pointer}.sales-list-filters>button{background:var(--surface);color:var(--list-accent);border:1px solid var(--line);padding:4px 14px;border-radius:3px}.sales-reference-panel{border:1px solid var(--line);background:var(--surface)}.sales-list-toolbar{display:flex;gap:10px;align-items:center;padding:8px 6px;border-bottom:1px solid var(--line);background:var(--surface-2);flex-wrap:wrap}.sales-primary{background:var(--list-accent);border:1px solid var(--list-accent);color:white;border-radius:3px;padding:7px 12px}.sales-list-scroll{overflow:auto;max-height:calc(100vh - 310px)}.sales-list-table{width:100%;min-width:1760px;border-collapse:collapse;table-layout:fixed;font-size:12px}.sales-list-table th,.sales-list-table td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:center;padding:10px 8px;overflow-wrap:anywhere}.sales-list-table th{height:38px;background:var(--surface-2);position:sticky;top:0;z-index:1;white-space:nowrap}.sales-list-table td{height:158px}.sales-list-table th:nth-child(1){width:90px}.sales-list-table th:nth-child(2){width:120px}.sales-list-table th:nth-child(3){width:155px}.sales-list-table th:nth-child(4){width:160px}.sales-list-table th:nth-child(6){width:235px}.sales-list-table th:nth-child(11){width:165px}.sales-list-table th:nth-child(12){width:110px}.sales-text,.sales-blue{border:0;padding:2px;background:none;color:var(--ink)}.sales-text:hover,.sales-blue{color:var(--list-accent)}.sales-remark{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.sales-shop{text-align:left!important;font-size:11px;line-height:1.9}.sales-label{display:inline-block;background:color-mix(in srgb,#35ca86 13%,var(--surface));border:1px solid color-mix(in srgb,#35ca86 30%,var(--line));color:#159653;border-radius:3px;font-size:11px;margin:2px;padding:1px 5px}.sales-label.muted{color:var(--ink-mute);background:var(--surface-2);border-color:var(--line)}.sales-style-count{font-size:11px;color:var(--ink-mute);text-align:left;margin-bottom:5px}.sales-style-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:140px;overflow:auto;align-content:start}.sales-style-grid button{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:6px 4px;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}.sales-style-grid button>span:last-child{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;width:100%;font-size:11px}.sales-style-grid img,.sales-no-photo{height:46px;width:46px;object-fit:contain;background:var(--surface-2)}.sales-no-photo{font-size:10px;display:grid;place-items:center;color:var(--ink-mute)}.sales-file{display:block;color:var(--list-accent);margin:5px 0}.sales-dates{text-align:left!important;line-height:1.9;font-size:11px}.sales-dates>div:first-child{color:#f85555}.sales-outline{color:var(--list-accent);background:color-mix(in srgb,var(--list-accent) 8%,var(--surface));border:1px solid color-mix(in srgb,var(--list-accent) 40%,var(--line));padding:5px 14px;border-radius:3px;font-size:11px!important}.sales-list-table td>small{display:block;color:var(--ink-mute);font-size:11px;margin:5px}.sales-list-table .row-sel{background:color-mix(in srgb,var(--list-accent) 5%,var(--surface))}.sales-more{position:relative;font-size:12px}.sales-more summary{cursor:pointer;list-style:none;border:1px solid var(--line);border-radius:3px;padding:6px 12px}.sales-more>div{position:absolute;left:0;top:34px;z-index:10;background:var(--surface);box-shadow:0 4px 14px #0002;border:1px solid var(--line);min-width:150px}.sales-more button{display:block;width:100%;text-align:left;border:0;background:none;color:var(--ink);padding:10px}.sales-more button:hover{background:var(--surface-2)}.sales-pattern-dialog{width:min(800px,94vw);display:flex;flex-direction:column;max-height:90vh}.sales-pattern-dialog .modal-body{overflow:auto}.sales-pattern-dialog article{display:flex;align-items:center;gap:18px;padding:14px 0;border-bottom:1px solid var(--line)}.sales-pattern-dialog article>img{width:70px;height:80px;object-fit:contain}.sales-pattern-dialog article>div{flex:1}.sales-pattern-dialog p{color:var(--ink-mute);font-size:12px}.sales-empty{color:var(--ink-mute)}

</style>
