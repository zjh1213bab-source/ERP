<template>
  <div class="yc-sample">
    <!-- 业务页签：保留原有「样衣档案 / 变更审核」闭环，只换档案页签的呈现 -->
    <div class="yc-page-tabs">
      <button :class="{ on: tab === 'archives' }" @click="tab = 'archives'">样衣档案</button>
      <button :class="{ on: tab === 'changes' }" @click="tab = 'changes'; loadChanges()">
        变更审核 <span v-if="pendingChanges.length" class="yc-tab-num">{{ pendingChanges.length }}</span>
      </button>
      <span class="yc-tabs-note">打版完成的样衣自动归档并锁定；修改须提交更改需求，审核通过后回打版流程重做</span>
    </div>

    <!-- ==================== 样衣档案：一比一卡片视图 ==================== -->
    <template v-if="tab === 'archives'">
      <!-- 筛选区：字段与截图一致；无真实数据的下拉显示「暂无数据」，不造枚举 -->
      <div class="yc-filter">
        <div class="yc-frow">
          <div class="yc-field">
            <label>款号</label><input class="yc-input" v-model="f.q" placeholder="搜索款号" @keyup.enter="page = 1" />
            <button class="yc-text-link" @click="batchOpen = true">批量搜索</button>
          </div>
          <div class="yc-field"><label>款名</label><input class="yc-input" v-model="f.style_name" placeholder="搜索款名" /></div>
          <div class="yc-field" :title="unsupportedHint('skc')"><label>SKC</label><input class="yc-input" v-model="f.skc" placeholder="搜索SKC" /></div>
          <div class="yc-field"><label>客户</label><select class="yc-select" v-model="f.customer"><option value="">搜索客户</option><option v-for="v in options.customer || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field"><label>设计师</label><select class="yc-select" v-model="f.designer"><option value="">搜索设计师</option><option v-for="v in options.designer || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field"><label>纸样师</label><select class="yc-select" v-model="f.pattern_maker"><option value="">搜索纸样师</option><option v-for="v in options.pattern_maker || []" :key="v">{{ v }}</option></select></div>
        </div>
        <div class="yc-frow">
          <div class="yc-field" :title="unsupportedHint('car_pattern_maker')"><label>车版师</label><select class="yc-select" v-model="f.car_pattern_maker"><option value="">搜索车版师</option></select></div>
          <div class="yc-field"><label>业务员</label><select class="yc-select" v-model="f.sales_owner"><option value="">搜索业务员</option><option v-for="v in options.sales_owner || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field" :title="unsupportedHint('factory')"><label>打版工厂</label><select class="yc-select" v-model="f.factory"><option value="">搜索工厂</option></select></div>
          <div class="yc-field"><label>创建人</label><select class="yc-select" v-model="f.created_by"><option value="">搜索创建人</option><option v-for="v in options.created_by || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field yc-wide">
            <label>创建时间</label>
            <div class="yc-date-range">
              <span class="yc-cal">▦</span>
              <input class="yc-input" type="date" v-model="f.created_from" />
              <span class="yc-dash">-</span>
              <input class="yc-input" type="date" v-model="f.created_to" />
            </div>
          </div>
        </div>
        <div class="yc-frow">
          <div class="yc-field"><label>系列</label><select class="yc-select" v-model="f.series"><option value="">选择系列</option><option v-for="v in options.series || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field"><label>品类</label><select class="yc-select" v-model="f.category"><option value="">选择品类</option><option v-for="v in options.category || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field"><label>品牌</label><select class="yc-select" v-model="f.brand"><option value="">搜索品牌</option><option v-for="v in options.brand || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field"><label>标签</label><select class="yc-select" v-model="f.label_name"><option value="">请选择</option><option v-for="v in options.label_name || []" :key="v">{{ v }}</option></select></div>
          <div class="yc-field"><label>客户款号</label><input class="yc-input" v-model="f.customer_style_no" placeholder="搜索客户款号" /></div>
          <div class="yc-field"><label>类型</label><select class="yc-select" v-model="f.type"><option value="">请选择类型</option><option v-for="v in options.type || []" :key="v">{{ v }}</option></select></div>
        </div>
        <div class="yc-frow yc-frow-actions">
          <span class="yc-filter-tip">筛选即时生效；流程数字为当前账号可见的全部开发款统计</span>
          <button class="yc-btn ghost" @click="resetFilters">重置</button>
          <button class="yc-btn primary" :disabled="busy" @click="load">刷新数据</button>
        </div>
      </div>

      <!-- 状态按钮 + 流程节点：数字全部来自后端真实统计，点击即筛选 -->
      <div class="yc-status">
        <button class="yc-state all" :class="{ on: !f.status && !f.node }" @click="clearBucket">全部</button>
        <button class="yc-state ordered" :class="{ on: f.status === 'ordered' }" @click="setStatus('ordered')">已下单</button>
        <button class="yc-state done" :class="{ on: f.status === 'done' }" @click="setStatus('done')">打版完成</button>
        <span class="yc-flow-label">流程</span><span class="yc-chev">»</span>
        <template v-for="(n, i) in nodes" :key="n.key">
          <button class="yc-node" :class="{ on: f.node === n.key, unsupported: !n.local }"
                  :title="n.local ? '点击查看该环节的开发款' : n.hint" @click="setNode(n)">
            {{ n.label }}: {{ n.count }}
          </button>
          <span v-if="i < nodes.length - 1" class="yc-chev">»</span>
        </template>
      </div>

      <!-- 操作按钮行 + 分页 -->
      <div class="yc-actions">
        <button class="yc-btn primary" @click="go('/development')" title="样衣由打版完成自动归档，新建请先建开发款">新增样衣</button>
        <div class="yc-dd">
          <button class="yc-btn primary" @click="toggleMenu('more')">更多 ▾</button>
          <div v-if="openMenu === 'more'" class="yc-dd-menu">
            <button @click="tab = 'changes'; loadChanges(); openMenu = ''">变更审核（{{ pendingChanges.length }}）</button>
            <button @click="showImagePanel = !showImagePanel; openMenu = ''">以图搜款</button>
            <button @click="resetFilters(); openMenu = ''">清空筛选</button>
            <button @click="load(); openMenu = ''">刷新列表</button>
          </div>
        </div>
        <div class="yc-dd">
          <button class="yc-btn primary" @click="toggleMenu('import')">导入 ▾</button>
          <div v-if="openMenu === 'import'" class="yc-dd-menu">
            <button @click="batchOpen = true; openMenu = ''">批量搜索款号</button>
            <button @click="go('/pre-orders'); openMenu = ''">从预下单选款</button>
          </div>
        </div>
        <div class="yc-dd">
          <button class="yc-btn primary" @click="toggleMenu('export')">导出 ▾</button>
          <div v-if="openMenu === 'export'" class="yc-dd-menu">
            <button @click="exportCsv(); openMenu = ''">导出当前结果 CSV</button>
          </div>
        </div>
        <button class="yc-btn primary" @click="go('/settings')">设置</button>
        <button class="yc-btn primary" @click="go('/pattern-board')">样衣模块设置</button>
        <button class="yc-btn primary" @click="openMenu = ''; showNotice('本系统暂未开放自定义字段设置，字段以开发单/打版阶段现有资料为准')">自定义字段设置</button>
        <div class="yc-pager">
          <span>共 <b>{{ filteredRows.length }}</b> 条</span>
          <select class="yc-select yc-pagesize" v-model.number="pageSize"><option v-for="s in pageSizeOptions" :key="s" :value="s">{{ s }}条/页</option></select>
          <button class="yc-pg" @click="page = Math.max(1, page - 1)">‹</button>
          <button v-for="p in visiblePages" :key="p" class="yc-pg" :class="{ on: p === page }" @click="page = p">{{ p }}</button>
          <span v-if="pageCount > 7" class="yc-pg-dots">…</span>
          <button v-if="pageCount > 7" class="yc-pg" :class="{ on: page === pageCount }" @click="page = pageCount">{{ pageCount }}</button>
          <button class="yc-pg" @click="page = Math.min(pageCount, page + 1)">›</button>
          <span>前往</span><input class="yc-input yc-goto" v-model.number="gotoPage" @keyup.enter="goPage(gotoPage)" /><span>页</span>
          <button class="yc-pg" title="刷新" @click="load">↻</button>
        </div>
      </div>

      <!-- 以图搜款面板：结果按 archive_id 与真实卡片关联 -->
      <div v-if="showImagePanel" class="yc-image-panel">
        <SampleImageSearch :q="f.q" :status="''" @results="showImageResults" @clear="clearImageFilter" />
        <button class="yc-text-link" @click="clearImageFilter">清除图搜结果</button>
      </div>
      <div v-if="notice" class="yc-notice">{{ notice }}</div>

      <!-- 卡片网格：4 列，字段全部来自真实数据，缺失显示「—」 -->
      <div class="yc-cards">
        <div v-for="row in pagedRows" :key="row.id" class="yc-card">
          <span class="yc-corner" :class="cornerClass(row)">{{ row.badge }}</span>
          <div class="yc-card-body">
            <div class="yc-thumb" :class="{ clickable: row.image_url && !broken[row.id] }" @click="row.image_url && !broken[row.id] && openImage(row.image_url, row.style_no || '')">
              <!-- 数据库只存图片路径，图片文件需单独交接；加载失败时如实显示占位，不显示破图 -->
              <img v-if="row.image_url && !broken[row.id]" :src="row.image_url" alt="" @error="broken[row.id] = true" />
              <span v-else>{{ row.image_url ? '图片待交接' : '暂无图' }}</span>
            </div>
            <div class="yc-info">
              <div class="yc-line"><b>款号：</b><span :title="row.style_no">{{ row.style_no || '—' }}</span></div>
              <div class="yc-line"><b>颜色：</b><span :title="row.colors">{{ row.colors || '—' }}</span></div>
              <div class="yc-line yc-ellip"><b>尺码：</b><span :title="row.size_range">{{ row.size_range || '—' }}</span></div>
              <div class="yc-line yc-ellip"><b>客户：</b><span :title="row.customer">{{ row.customer || '—' }}</span></div>
              <div class="yc-line"><b>创建时间：</b><span>{{ row.created_at ? $fmtDate(row.created_at) : '—' }}</span></div>
            </div>
          </div>
          <div class="yc-card-foot">
            <button class="yc-link" @click="detailRow(row)">详情</button>
            <button class="yc-link" @click="printRow(row)">打印</button>
            <button class="yc-link" @click="editRow(row)">编辑</button>
            <div class="yc-dd yc-dd-up">
              <button class="yc-link" @click="toggleRowMenu(row.id)">更多 ▾</button>
              <div v-if="rowMenu === row.id" class="yc-dd-menu">
                <button @click="copyStyleNo(row); rowMenu = ''">复制款号</button>
                <button @click="goFlow(row); rowMenu = ''">查看打版流程</button>
                <button @click="copyText(row.order_no, '关联单号'); rowMenu = ''">复制关联单号</button>
                <button @click="tab = 'changes'; loadChanges(); rowMenu = ''">变更审核</button>
              </div>
            </div>
          </div>
        </div>
        <div v-if="!pagedRows.length" class="yc-empty">
          {{ busy ? '正在加载…' : (rows.length ? '当前筛选条件下没有开发款，试试「重置」' : '暂无开发款；在开发管理建款并进入打版流程后会出现在这里') }}
        </div>
      </div>

      <div class="yc-pager yc-pager-bottom">
        <span>共 <b>{{ filteredRows.length }}</b> 条 · 第 {{ page }} / {{ pageCount }} 页</span>
        <button class="yc-pg" @click="page = Math.max(1, page - 1)">‹</button>
        <button class="yc-pg" @click="page = Math.min(pageCount, page + 1)">›</button>
      </div>

      <!-- 打印预览：只对真实字段排版，浏览器打印 -->
      <div v-if="printTarget" class="yc-print-sheet">
        <h2>样衣卡 · {{ printTarget.style_no || '—' }}</h2>
        <table>
          <tr><th>款号</th><td>{{ printTarget.style_no || '—' }}</td><th>款名</th><td>{{ printTarget.style_name || '—' }}</td></tr>
          <tr><th>颜色</th><td>{{ printTarget.colors || '—' }}</td><th>尺码</th><td>{{ printTarget.size_range || '—' }}</td></tr>
          <tr><th>客户</th><td>{{ printTarget.customer || '—' }}</td><th>创建时间</th><td>{{ printTarget.created_at || '—' }}</td></tr>
          <tr><th>当前环节</th><td>{{ printTarget.stage_label || '—' }}</td><th>关联单号</th><td>{{ printTarget.order_no || '—' }}</td></tr>
          <tr><th>设计师</th><td>{{ printTarget.designer || '—' }}</td><th>纸样师</th><td>{{ printTarget.pattern_maker || '—' }}</td></tr>
        </table>
        <button class="yc-btn ghost no-print" @click="printTarget = null">关闭</button>
      </div>
    </template>

    <!-- ==================== 变更审核：保留原表格与审核闭环 ==================== -->
    <template v-else>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 130px">样衣编号</th><th>款号 / 样衣</th><th>更改原因</th>
              <th style="width: 90px">申请人</th><th style="width: 110px">申请时间</th>
              <th style="width: 80px">状态</th><th style="width: 200px">审核</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in changes" :key="c.id">
              <td><strong>{{ c.archive_no }}</strong></td>
              <td>{{ c.style_no || '-' }}<div class="sub-line">{{ c.sample_name || '' }}</div></td>
              <td>{{ c.reason }}<div v-if="c.detail" class="sub-line">{{ c.detail }}</div><div v-if="c.review_note" class="sub-line">审核意见：{{ c.review_note }}</div></td>
              <td>{{ c.applicant || '-' }}</td>
              <td>{{ $fmtDate(c.created_at) }}</td>
              <td class="nw"><span class="tag" :class="changeTag(c.status)">{{ changeLabel(c.status) }}</span></td>
              <td class="nw">
                <template v-if="c.status === 'pending' && canReview">
                  <button class="link-btn" @click="review(c, true)">通过</button>
                  <button class="link-btn danger" @click="review(c, false)">驳回</button>
                </template>
                <span v-else-if="c.status !== 'pending'" class="sub-line">{{ c.reviewer }} · {{ $fmtDate(c.reviewed_at) }}</span>
                <span v-else class="sub-line">等待审核</span>
              </td>
            </tr>
            <tr v-if="!changes.length"><td colspan="7" class="empty-cell">暂无变更申请</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ==================== 详情弹窗（原样保留） ==================== -->
    <div v-if="detail" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>
            {{ detail.archive_no }} · {{ detail.style_no || detail.sample_name }}
            <span class="tag" :class="statusTag(detail.status)">{{ statusLabel(detail.status) }}</span>
            <span class="tag gray">已锁定快照</span>
          </h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="snap-grid">
            <div><label>款号</label><div>{{ snap.product_name || '-' }}</div></div>
            <div><label>版本</label><div>{{ detail.version || '-' }}</div></div>
            <div><label>客户款号</label><div>{{ snap.customer_style_no || '-' }}</div></div>
            <div><label>颜色</label><div>{{ snap.colors || '-' }}</div></div>
            <div><label>尺码</label><div>{{ snap.size_range || '-' }}</div></div>
            <div><label>打板尺码</label><div>{{ detail.pattern_size || '-' }}</div></div>
            <div><label>设计师</label><div>{{ snap.designer || '-' }}</div></div>
            <div><label>版师</label><div>{{ snap.pattern_maker || '-' }}</div></div>
            <div><label>客户</label><div>{{ detail.customer || '-' }}</div></div>
            <div><label>{{ snap.order && snap.order.is_pre_order ? '预下单编号' : '订单编号' }}</label><div>{{ snap.order && snap.order.order_no || '-' }}</div></div>
            <div><label>归档人</label><div>{{ detail.created_by || '-' }}</div></div>
          </div>
          <h3 class="sec">客户要求</h3><div class="snap-text">{{ snap.customer_req || '—' }}</div>
          <h3 class="sec">面辅料明细（快照）</h3>
          <div class="tbl-scroll"><table class="data snap-tbl">
            <thead><tr><th>类型</th><th>物料</th><th>色号</th><th>供应商</th><th>规格</th><th>单件用量</th><th>单价</th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in snap.materials || []" :key="i"><td>{{ m.mat_type === 'fabric' ? '面料' : '辅料' }}</td><td>{{ m.material_name }}</td><td>{{ m.color_no || '-' }}</td><td>{{ m.supplier || '-' }}</td><td>{{ m.spec_info || '-' }}</td><td>{{ m.one_use }}</td><td>{{ m.unit_price }}</td></tr>
              <tr v-if="!(snap.materials || []).length"><td colspan="7" class="empty-cell">无</td></tr>
            </tbody>
          </table></div>
          <h3 class="sec">本款工序（归档快照）</h3>
          <div v-for="group in [{key:'sewing',label:'车缝工序'},{key:'finish',label:'后整工序'}]" :key="group.key" class="tbl-scroll">
            <strong>{{ group.label }}</strong>
            <table class="data snap-tbl"><thead><tr><th>序号</th><th>名称</th><th>类别</th><th>单价</th><th>倍率</th><th>说明</th></tr></thead>
              <tbody><tr v-for="(step,index) in snap.processes?.[group.key] || []" :key="index"><td>{{ index+1 }}</td><td>{{ step.name }}</td><td>{{ step.category }}</td><td>{{ step.price }}</td><td>{{ step.ratio }}</td><td>{{ step.remark || '—' }}</td></tr>
              <tr v-if="!snap.processes?.[group.key]?.length"><td colspan="6">无工序快照（历史归档保留原记录）</td></tr></tbody></table>
          </div>
          <h3 class="sec">成衣尺寸（快照）</h3>
          <div class="tbl-scroll"><table class="data snap-tbl">
            <thead><tr><th>部位</th><th v-for="c in sizeCols" :key="c">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="r in sizeRows" :key="r.part"><td>{{ r.part }}</td><td v-for="c in sizeCols" :key="c">{{ r.map[c] || '' }}</td></tr>
              <tr v-if="!sizeRows.length"><td :colspan="sizeCols.length + 1" class="empty-cell">无</td></tr>
            </tbody>
          </table></div>
          <h3 class="sec">生产要求（快照）</h3>
          <div v-for="g in reqGroups" :key="g.key" class="req-g"><div class="req-t">{{ g.label }}</div><ol><li v-for="(r, i) in g.items" :key="i">{{ r.content }}</li></ol></div>
          <div v-if="!reqGroups.length" class="sub-line">无</div>
          <h3 class="sec">变更记录</h3>
          <div v-for="c in detail.changes || []" :key="c.id" class="chg-row">
            <span class="tag" :class="changeTag(c.status)">{{ changeLabel(c.status) }}</span> {{ c.reason }}
            <span class="sub-line">{{ c.applicant }} · {{ $fmt(c.created_at) }}</span>
            <span v-if="c.new_archive_no" class="sub-line">修改完成并归档为：{{ c.new_archive_no }}</span>
          </div>
          <div v-if="!(detail.changes || []).length" class="sub-line">暂无变更记录</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="detail = null">关闭</button>
          <button v-if="detail.status !== 'revised'" class="btn btn-primary" @click="openChange(detail)">提交更改需求</button>
        </div>
      </div>
    </div>

    <!-- ==================== 提交更改需求（原样保留） ==================== -->
    <div v-if="changeTarget" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>提交更改需求 · {{ changeTarget.archive_no }}</h3><button class="x" @click="changeTarget = null">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full"><label>更改原因 *</label><textarea v-model="changeForm.reason" rows="3" placeholder="如：客户要求门襟改 6 粒扣 / 面料换色"></textarea></div>
            <div class="fitem full"><label>详细说明</label><textarea v-model="changeForm.detail" rows="3" placeholder="具体改哪里、改到什么程度"></textarea></div>
          </div>
          <p class="tip">提交后需技术审核；通过后开发单解锁，回到打版流程的「制版」阶段重做，重新完成后自动生成新版本样衣。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="changeTarget = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="submitChange">提交</button>
        </div>
      </div>
    </div>

    <!-- 批量搜索款号 -->
    <div v-if="batchOpen" class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>批量搜索款号</h3><button class="x" @click="batchOpen = false">×</button></div>
        <div class="modal-body">
          <textarea v-model="batchText" rows="6" placeholder="每行一个，或用逗号 / 空格分隔；匹配款号、SKC、客户款号"></textarea>
          <p class="tip">只筛当前已加载的真实开发款，不产生新数据。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="batchKeys = []; batchOpen = false">清除</button>
          <button class="btn btn-primary" @click="applyBatch">应用</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
/**
 * 样衣管理（一比一改版）
 * ------------------------------------------------------------------
 * 视觉对齐参考系统：3 行筛选 / 3 状态按钮 + 11 流程胶囊 / 7 操作按钮 /
 * 4 列卡片网格 / 分页栏；卡片内部「详情 打印 编辑 更多」保持原位与原文案。
 *
 * 接线原则（不造假、不做死按钮）：
 *  - 数据：GET /api/sample-archives/workspace，联查 tech_packs + pattern_flows
 *          + orders/pre_orders + sample_archives，逐条复用 patternManagement.owns 权限。
 *  - 流程胶囊数字：后端按真实 current_stage / status 统计；本地无对应环节的
 *          两项（面辅料供应商选择、技术部审核）如实为 0 并带说明。
 *  - 详情 → 归档档案详情弹窗；未归档 → 打版流程办理页。
 *  - 编辑 → 申请变更（沿用锁定/审核闭环）；未归档 → 打版流程办理页。
 *  - 打印 → 本页真实字段生成打印卡，调用浏览器打印。
 *  - 新增样衣 → 开发管理（样衣不可手工新建，由打版完成自动归档）。
 *  - 自定义字段设置 → 明确提示未开放，不伪装成功。
 *  - 变更审核页签、详情快照、变更提交/审核逻辑全部原样保留。
 */
import SampleImageSearch from '../components/SampleImageSearch.vue';
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import { openImage } from '../store/viewer';
import { globalPageSize } from '../composables/useListPagination';

const route = useRoute();
const router = useRouter();
const tab = ref('archives');
const busy = ref(false);
const notice = ref('');
const showImagePanel = ref(false);
const openMenu = ref('');
const rowMenu = ref('');

// ---------- 数据 ----------
const rows = ref([]);
const nodes = ref([]);
const statusCounts = ref({});
const options = ref({});
const unsupported = ref([]);
const imageFilter = ref(null);
const batchKeys = ref([]);
const broken = ref({}); // 图片路径存在但文件未随代码交接时，记录加载失败的卡片

const emptyFilter = () => ({
  q: '', style_name: '', skc: '', customer: '', designer: '', pattern_maker: '',
  car_pattern_maker: '', sales_owner: '', factory: '', created_by: '',
  created_from: '', created_to: '', series: '', category: '', brand: '',
  label_name: '', customer_style_no: '', type: '', status: '', node: ''
});
const f = ref({ ...emptyFilter(), q: String((route.query && route.query.q) || '') });

async function load() {
  busy.value = true;
  try {
    const d = await api.sampleWorkspace({});
    rows.value = d.rows || [];
    nodes.value = d.nodes || [];
    statusCounts.value = d.statusCounts || {};
    options.value = d.options || {};
    unsupported.value = d.unsupported || [];
    page.value = 1;
  } catch (e) { alert(e.message); }
  finally { busy.value = false; }
}

function unsupportedHint(field) {
  const hit = unsupported.value.find((x) => x.field === field);
  return hit ? `${hit.label}：${hit.reason}` : '';
}
function resetFilters() {
  f.value = emptyFilter();
  batchKeys.value = [];
  imageFilter.value = null;
  page.value = 1;
}
function clearBucket() { f.value.status = ''; f.value.node = ''; page.value = 1; }
function setStatus(s) { f.value.status = f.value.status === s ? '' : s; f.value.node = ''; page.value = 1; }
function setNode(n) {
  if (!n.local) { showNotice(`${n.label}：${n.hint}`); return; }
  f.value.node = f.value.node === n.key ? '' : n.key;
  f.value.status = '';
  page.value = 1;
}
function showNotice(msg) { notice.value = msg; setTimeout(() => { notice.value = ''; }, 4000); }

// ---------- 筛选（本地即时；后端接口亦支持同名参数） ----------
const EQ_FIELDS = {
  skc: 'skc', customer: 'customer', designer: 'designer', pattern_maker: 'pattern_maker',
  car_pattern_maker: 'car_pattern_maker', sales_owner: 'sales_owner', factory: 'factory',
  created_by: 'created_by', series: 'series', category: 'category', brand: 'brand',
  label_name: 'label_name', type: 'type'
};
const filteredRows = computed(() => {
  const fw = f.value;
  const kw = String(fw.q || '').trim().toLowerCase();
  const like = (v, s) => String(v || '').toLowerCase().includes(s);
  return rows.value.filter((r) => {
    if (imageFilter.value && !imageFilter.value.has(Number(r.archive_id))) return false;
    if (batchKeys.value.length && !batchKeys.value.some((k) =>
      [r.style_no, r.skc, r.customer_style_no].some((v) => like(v, k.toLowerCase())))) return false;
    if (kw && ![r.style_no, r.skc, r.customer_style_no, r.style_name, r.customer, r.order_no]
      .some((v) => like(v, kw))) return false;
    if (fw.style_name && !like(r.style_name, String(fw.style_name).toLowerCase())) return false;
    if (fw.customer_style_no && !like(r.customer_style_no, String(fw.customer_style_no).toLowerCase())) return false;
    for (const [param, field] of Object.entries(EQ_FIELDS)) {
      if (fw[param] && String(r[field] || '') !== fw[param]) return false;
    }
    const day = String(r.created_at || '').slice(0, 10);
    if (fw.created_from && day < fw.created_from) return false;
    if (fw.created_to && day > fw.created_to) return false;
    if (fw.node && r.node !== fw.node) return false;
    if (fw.status === 'ordered' && !r.has_order) return false;
    if (fw.status === 'done' && r.node !== 'done') return false;
    return true;
  });
});

// ---------- 分页 ----------
// 「外观设置 → 所有列表每页条数」是全站共用设置，本页以它作为默认档位；
// 另外保留 12/24/48 的卡片网格档位供临时调整，设置变更时实时回到第一页。
const page = ref(1);
const pageSize = ref(globalPageSize.value);
const pageSizeOptions = computed(() => [...new Set([globalPageSize.value, 12, 24, 48])].sort((a, b) => a - b));
watch(globalPageSize, (v) => { pageSize.value = v; page.value = 1; });
const gotoPage = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / pageSize.value)));
const visiblePages = computed(() => {
  const n = pageCount.value;
  const end = n > 7 ? Math.min(6, n - 1) : n;
  return Array.from({ length: end }, (_, i) => i + 1);
});
const pagedRows = computed(() => filteredRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
function goPage(p) { const n = Number(p); if (Number.isFinite(n) && n >= 1) page.value = Math.min(pageCount.value, Math.floor(n)); }

// ---------- 操作按钮 ----------
function go(path) { openMenu.value = ''; router.push(path); }
function toggleMenu(k) { openMenu.value = openMenu.value === k ? '' : k; rowMenu.value = ''; }
function toggleRowMenu(id) { rowMenu.value = rowMenu.value === id ? '' : id; openMenu.value = ''; }
function goFlow(row) { router.push({ path: '/pattern-board', query: { techpack: String(row.tech_pack_id) } }); }

function detailRow(row) {
  // 已归档 → 现有详情弹窗（含锁定快照）；在产 → 打版流程办理页
  if (row.archive_id) return openDetail(row.archive_id);
  goFlow(row);
}
function editRow(row) {
  // 用户口径：编辑→申请变更，沿用「归档即锁定」规则；未归档款回流程里办理
  if (!row.archive_id) return goFlow(row);
  if (row.archive_status === 'revised') return showNotice('该样衣已出新版本，请在新版本上提变更');
  openChange({ id: row.archive_id, archive_no: row.archive_no || row.style_no });
}
const printTarget = ref(null);
function printRow(row) { printTarget.value = row; nextTick(() => window.print()); }

function copyText(v, label) {
  if (!v) return showNotice(`${label}为空`);
  navigator.clipboard?.writeText(String(v)).then(
    () => showNotice(`${label}已复制`),
    () => showNotice('复制失败，请手动选择文本')
  );
}
const copyStyleNo = (row) => copyText(row.style_no, '款号');

// CSV 导出：UTF-8 BOM + 公式注入防护（与采购导出同一口径）
function exportCsv() {
  const head = ['款号', '款名', '颜色', '尺码', '客户', '创建时间', '当前环节', '状态', '关联单号'];
  const cell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [head, ...filteredRows.value.map((r) => [
    r.style_no, r.style_name, r.colors, r.size_range, r.customer,
    r.created_at, r.stage_label, r.badge, r.order_no
  ])].map((cols) => cols.map(cell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + lines], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '样衣管理-' + localDate() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showNotice(`已导出 ${filteredRows.value.length} 条`);
}

// 图搜结果按 archive_id 与真实卡片关联，不替换成另一套假数据
function showImageResults(hits) {
  imageFilter.value = new Set((hits || []).map((h) => Number(h.id || h.archive_id)).filter(Boolean));
  page.value = 1;
  showNotice(imageFilter.value.size ? `图搜命中 ${imageFilter.value.size} 张已归档样衣` : '图搜未命中已归档样衣');
}
function clearImageFilter() { imageFilter.value = null; page.value = 1; }

const batchOpen = ref(false);
const batchText = ref('');
function applyBatch() {
  batchKeys.value = String(batchText.value || '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
  batchOpen.value = false;
  page.value = 1;
  showNotice(batchKeys.value.length ? `已按 ${batchKeys.value.length} 个关键词筛选` : '已清除批量筛选');
}

function cornerClass(row) {
  if (row.node === 'cancelled') return 'gray';
  if (row.archive_status === 'changing') return 'orange';
  if (row.node === 'done') return 'green';
  return '';
}

// ---------- 原有业务闭环（未改动） ----------
const changes = ref([]);
const detail = ref(null);
const changeTarget = ref(null);
const changeForm = ref({ reason: '', detail: '' });
const canReview = computed(() => can('pattern.review'));
const pendingChanges = computed(() => changes.value.filter((c) => c.status === 'pending'));
const snap = computed(() => (detail.value && detail.value.snapshot) || {});
const statusLabel = (s) => ({ locked: '已锁定', changing: '变更审核中', revised: '已出新版' }[s] || s);
const statusTag = (s) => ({ locked: 'green', changing: 'orange', revised: 'gray' }[s] || 'gray');
const changeLabel = (s) => ({ pending: '待审核', approved: '已通过', rejected: '已驳回' }[s] || s);
const changeTag = (s) => ({ pending: 'orange', approved: 'green', rejected: 'red' }[s] || 'gray');
const REQ_CATS = [
  { key: 'craft', label: '缝制工艺要求' }, { key: 'packing', label: '包装与标识要求' },
  { key: 'test', label: '测试与验货要求' }, { key: 'note', label: '其他注意事项' }
];
const sizeCols = computed(() => {
  const cols = [];
  (snap.value.sizes || []).forEach((s) => { if (!cols.includes(s.size)) cols.push(s.size); });
  return cols;
});
const sizeRows = computed(() => {
  const map = new Map();
  (snap.value.sizes || []).forEach((s) => {
    if (!map.has(s.part)) map.set(s.part, { part: s.part, map: {} });
    map.get(s.part).map[s.size] = s.value;
  });
  return [...map.values()];
});
const reqGroups = computed(() => {
  const rs = snap.value.requirements || [];
  return REQ_CATS.map((c) => ({ ...c, items: rs.filter((r) => r.category === c.key) })).filter((g) => g.items.length);
});
async function loadChanges() {
  try { changes.value = await api.sampleChanges({}); } catch (e) { alert(e.message); }
}
async function openDetail(id) {
  try { detail.value = await api.sampleArchive(id); } catch (e) { alert(e.message); }
}
function openChange(a) { changeTarget.value = a; changeForm.value = { reason: '', detail: '' }; }
async function submitChange() {
  if (!changeForm.value.reason.trim()) return alert('请填写更改原因');
  busy.value = true;
  try {
    await api.requestSampleChange(changeTarget.value.id, changeForm.value);
    changeTarget.value = null; detail.value = null;
    await load(); await loadChanges();
    alert('更改需求已提交，等待技术审核');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}
async function review(c, approve) {
  const note = prompt(approve ? '审核意见（可空）' : '驳回原因（可空）') || '';
  busy.value = true;
  try {
    await api.reviewSampleChange(c.id, { approve, note });
    await loadChanges(); await load();
    alert(approve ? '已通过：开发单解锁，可回打版流程重做' : '已驳回');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(async () => { await load(); await loadChanges(); });
</script>

<style scoped>
/* ===== 一比一样式：只作用于本页，不污染其他 90+ 页面 ===== */
.yc-sample { font-size: 12.5px; color: #303133; }
.yc-page-tabs { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.yc-page-tabs button {
  height: 28px; padding: 0 14px; border: 1px solid #dcdfe6; border-radius: 3px;
  background: #fff; color: #606266; font-size: 12.5px; cursor: pointer;
}
.yc-page-tabs button.on { background: #1668f0; border-color: #1668f0; color: #fff; }
.yc-tab-num { display: inline-grid; place-items: center; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 8px; background: #fff; color: #1668f0; font-size: 10px; }
.yc-tabs-note { margin-left: auto; color: #909399; font-size: 12px; }

/* 筛选区 */
.yc-filter { background: #fff; border: 1px solid #e4e9f0; border-radius: 4px; padding: 12px 14px 8px; margin-bottom: 10px; }
.yc-frow { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 10px; }
.yc-field { display: flex; align-items: center; gap: 6px; flex: 1 1 210px; min-width: 200px; }
.yc-field.yc-wide { flex: 2 1 430px; }
.yc-field > label { width: 58px; flex: none; text-align: right; color: #303133; white-space: nowrap; font-weight: 500; }
.yc-field > .yc-input, .yc-field > .yc-select { flex: 1; min-width: 0; width: auto; }
.yc-input, .yc-select {
  width: 100%; height: 28px; padding: 0 8px; border: 1px solid #dcdfe6; border-radius: 3px;
  background: #fff; color: #606266; font-size: 12px; box-sizing: border-box;
}
.yc-input::placeholder { color: #b6bcc6; }
.yc-input:focus, .yc-select:focus { outline: none; border-color: #1668f0; }
.yc-text-link { flex: none; padding: 0 2px; border: 0; background: none; color: #1668f0; font-size: 12px; cursor: pointer; white-space: nowrap; }
.yc-date-range { display: flex; align-items: center; gap: 3px; flex: 1; min-width: 0; }
.yc-date-range .yc-input { flex: 1; min-width: 0; padding: 0 4px; }
.yc-cal { color: #909399; }
.yc-dash { color: #909399; }
.yc-frow-actions { justify-content: flex-end; gap: 8px; margin-bottom: 2px; }
.yc-filter-tip { margin-right: auto; color: #909399; font-size: 11.5px; }

/* 按钮 */
.yc-btn { height: 26px; padding: 0 12px; border-radius: 3px; font-size: 12px; cursor: pointer; white-space: nowrap; }
.yc-btn.primary { background: #1668f0; border: 1px solid #1668f0; color: #fff; }
.yc-btn.primary:hover { background: #0f57d8; }
.yc-btn.ghost { background: #fff; border: 1px solid #dcdfe6; color: #606266; }
.yc-btn.ghost:hover { color: #1668f0; border-color: #1668f0; }

/* 状态行 */
.yc-status { display: flex; align-items: center; flex-wrap: nowrap; gap: 6px; padding: 9px 12px; background: #fff; border: 1px solid #e4e9f0; border-radius: 4px; margin-bottom: 10px; overflow-x: auto; white-space: nowrap; }
.yc-status > * { flex: none; }
.yc-status::-webkit-scrollbar { height: 6px; }
.yc-status::-webkit-scrollbar-thumb { background: #c8d6ea; border-radius: 3px; }
.yc-state { height: 24px; padding: 0 12px; border-radius: 3px; font-size: 12px; cursor: pointer; background: #fff; }
.yc-state.all { border: 1px solid #1668f0; color: #1668f0; }
.yc-state.ordered { border: 1px solid #b7e1a1; color: #4c9a2a; background: #f2fbe9; }
.yc-state.done { border: 1px solid #f5d9a6; color: #c8811a; background: #fff8e8; }
.yc-state.on { box-shadow: 0 0 0 2px rgba(22, 104, 240, .18); font-weight: 700; }
.yc-flow-label { margin-left: 6px; color: #303133; font-weight: 700; font-size: 12px; }
.yc-chev { color: #1668f0; font-size: 12px; }
.yc-node { height: 24px; padding: 0 10px; border: 1px solid #d6e8ff; border-radius: 14px; background: #eaf3ff; color: #1668f0; font-size: 12px; cursor: pointer; white-space: nowrap; }
.yc-node:hover { background: #dbeaff; }
.yc-node.on { background: #1668f0; border-color: #1668f0; color: #fff; font-weight: 700; }
.yc-node.unsupported { opacity: .62; border-style: dashed; cursor: help; }

/* 操作行 + 分页 */
.yc-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 9px 12px; background: #fff; border: 1px solid #e4e9f0; border-radius: 4px; margin-bottom: 12px; }
.yc-dd { position: relative; }
.yc-dd-menu { position: absolute; top: 28px; left: 0; z-index: 40; min-width: 178px; padding: 4px; background: #fff; border: 1px solid #dcdfe6; border-radius: 4px; box-shadow: 0 8px 22px rgba(20, 35, 61, .16); }
.yc-dd-menu button { display: block; width: 100%; text-align: left; padding: 6px 9px; border: 0; border-radius: 3px; background: none; color: #303133; font-size: 12px; cursor: pointer; white-space: nowrap; }
.yc-dd-menu button:hover { background: #eaf3ff; color: #1668f0; }
.yc-dd-up .yc-dd-menu { top: auto; bottom: 24px; left: auto; right: 0; }
.yc-pager { margin-left: auto; display: flex; align-items: center; gap: 5px; color: #606266; font-size: 12px; white-space: nowrap; }
.yc-pager b { color: #1668f0; }
.yc-pagesize { width: 92px; height: 24px; }
.yc-pg { min-width: 24px; height: 24px; padding: 0 5px; border: 1px solid #dcdfe6; border-radius: 3px; background: #fff; color: #606266; font-size: 12px; cursor: pointer; }
.yc-pg.on { background: #1668f0; border-color: #1668f0; color: #fff; }
.yc-pg-dots { padding: 0 2px; }
.yc-goto { width: 42px; height: 24px; text-align: center; }
.yc-pager-bottom { margin: 12px 0 0; padding: 8px 12px; background: #fff; border: 1px solid #e4e9f0; border-radius: 4px; }

/* 卡片 */
.yc-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.yc-card { position: relative; background: #fff; border: 1px solid #e4e9f0; border-radius: 6px; padding: 12px; min-height: 190px; display: flex; flex-direction: column; }
.yc-corner { position: absolute; top: 10px; right: 10px; padding: 2px 8px; border-radius: 3px; background: #f2f3f5; color: #909399; font-size: 11px; }
.yc-corner.green { background: #e8f7e4; color: #4c9a2a; }
.yc-corner.orange { background: #fff3e0; color: #c8811a; }
.yc-corner.gray { background: #f2f3f5; color: #909399; }
.yc-card-body { display: flex; gap: 12px; flex: 1; min-height: 0; }
.yc-thumb { width: 96px; height: 112px; flex: none; display: grid; place-items: center; overflow: hidden; background: #f0f1f3; border-radius: 3px; color: #b0b5bd; font-size: 11px; }
.yc-thumb img { width: 100%; height: 100%; object-fit: cover; }
.yc-thumb.clickable { cursor: pointer; }
.yc-info { flex: 1; min-width: 0; padding-top: 2px; }
.yc-line { display: flex; gap: 2px; line-height: 1.85; color: #606266; font-size: 12px; }
.yc-line b { color: #303133; font-weight: 600; flex: none; }
.yc-line span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yc-ellip span { display: block; }
.yc-card-foot { display: flex; align-items: center; gap: 12px; padding-top: 8px; margin-top: 6px; border-top: 1px solid #f0f2f5; }
.yc-link { padding: 0; border: 0; background: none; color: #1668f0; font-size: 12.5px; cursor: pointer; }
.yc-link:hover { text-decoration: underline; }
.yc-empty { grid-column: 1 / -1; padding: 44px 16px; text-align: center; color: #909399; background: #fff; border: 1px dashed #dcdfe6; border-radius: 6px; }

.yc-image-panel { margin-bottom: 10px; padding: 10px 12px; background: #fff; border: 1px solid #e4e9f0; border-radius: 4px; }
.yc-notice { margin-bottom: 10px; padding: 7px 12px; border-radius: 3px; background: #eaf3ff; color: #1668f0; font-size: 12px; }

/* 打印卡 */
.yc-print-sheet { display: none; }
.yc-print-sheet h2 { font-size: 18px; margin-bottom: 14px; }
.yc-print-sheet table { width: 100%; border-collapse: collapse; }
.yc-print-sheet th, .yc-print-sheet td { border: 1px solid #999; padding: 7px 10px; font-size: 13px; text-align: left; }
.yc-print-sheet th { width: 14%; background: #f2f2f2; }

/* 原详情页样式（保留） */
.nw { white-space: nowrap; }
.sub-line { font-size: 12px; color: var(--ink-mute); margin-top: 2px; }
.snap-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px 14px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.snap-grid label { display: block; font-size: 12px; color: var(--ink-mute); margin-bottom: 2px; }
.snap-grid div > div { font-size: 13px; color: var(--ink); }
.sec { font-size: 13.5px; margin: 16px 0 6px; color: var(--ink); }
.snap-text { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; font-size: 12.5px; line-height: 1.7; background: #fafcff; color: var(--ink); }
.tbl-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
.snap-tbl { border: none; min-width: 620px; }
.snap-tbl th, .snap-tbl td { white-space: nowrap; font-size: 12px; padding: 6px 8px; }
.req-g { margin-bottom: 8px; }
.req-t { font-weight: 700; font-size: 12px; color: var(--ink); }
.req-g ol { margin: 2px 0 0; padding-left: 20px; }
.req-g li { font-size: 12.5px; line-height: 1.7; color: var(--ink); }
.chg-row { font-size: 12.5px; color: var(--ink); padding: 4px 0; border-bottom: 1px dashed var(--line); }
.tip { font-size: 12px; color: var(--ink-mute); margin-top: 8px; }

@media (max-width: 1500px) { .yc-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 1100px) {
  .yc-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .yc-field { flex-basis: 240px; }
  .yc-field.yc-wide { flex-basis: 480px; }
}
@media (max-width: 900px) { .snap-grid { grid-template-columns: repeat(2, 1fr); } }

/* ===== 深色显示模式适配 =====
   外观设置切到「深色」时，本页一比一样式里的硬编码白底要跟随主题，
   否则会出现「深色侧栏 + 刺眼白卡片」。用 :root[data-theme="dark"] 限定，
   浅色模式（参考截图观感）完全不受影响；蓝色实心按钮、选中态与语义色保持不变。
   颜色取 yichuang-shell.css 里的全局 --yc-* 变量，避免再写死一套。 */
:root[data-theme="dark"] .yc-sample { color: var(--yc-ink); }
:root[data-theme="dark"] .yc-filter,
:root[data-theme="dark"] .yc-status,
:root[data-theme="dark"] .yc-actions,
:root[data-theme="dark"] .yc-pager-bottom,
:root[data-theme="dark"] .yc-image-panel,
:root[data-theme="dark"] .yc-card,
:root[data-theme="dark"] .yc-empty,
:root[data-theme="dark"] .yc-dd-menu {
  background: var(--yc-surface);
  border-color: var(--yc-line);
}
:root[data-theme="dark"] .yc-page-tabs button:not(.on),
:root[data-theme="dark"] .yc-input,
:root[data-theme="dark"] .yc-select,
:root[data-theme="dark"] .yc-pg:not(.on),
:root[data-theme="dark"] .yc-btn.ghost,
:root[data-theme="dark"] .yc-state.all {
  background: var(--yc-surface);
  border-color: var(--yc-line);
  color: var(--yc-ink-2);
}
:root[data-theme="dark"] .yc-field > label,
:root[data-theme="dark"] .yc-flow-label,
:root[data-theme="dark"] .yc-line,
:root[data-theme="dark"] .yc-line b,
:root[data-theme="dark"] .yc-pager,
:root[data-theme="dark"] .yc-tabs-note,
:root[data-theme="dark"] .yc-filter-tip,
:root[data-theme="dark"] .yc-dd-menu button { color: var(--yc-ink-2); }
:root[data-theme="dark"] .yc-card-foot { border-top-color: var(--yc-line); }
:root[data-theme="dark"] .yc-thumb { background: #2a3038; color: var(--yc-ink-3); }
:root[data-theme="dark"] .yc-corner { background: #2a3038; color: var(--yc-ink-2); }
:root[data-theme="dark"] .yc-node:not(.on) { background: var(--yc-blue-soft); border-color: var(--yc-line); }
:root[data-theme="dark"] .yc-dd-menu button:hover { background: var(--yc-blue-soft); }

@media print {
  .yc-sample > *:not(.yc-print-sheet) { display: none !important; }
  .yc-print-sheet { display: block !important; }
  .no-print { display: none !important; }
}
</style>
