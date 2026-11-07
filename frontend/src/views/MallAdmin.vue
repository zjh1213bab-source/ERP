<template>
  <div>
    <div class="page-head">
      <div>
        <h2>客户商城</h2>
        <div class="sub">商品上架 · 客户专属价 · 询价报价转订单 · 客户账号</div>
      </div>
      <div class="toolbar">
        <a class="btn btn-ghost" href="/mall/login" target="_blank" rel="noopener">打开展厅 ↗</a>
      </div>
    </div>

    <div class="cards">
      <div class="stat-card"><div class="label">在售商品</div><div class="value">{{ s.products || 0 }}</div></div>
      <div class="stat-card"><div class="label">待报价询价</div><div class="value">{{ (s.inquiries && s.inquiries.submitted) || 0 }}</div></div>
      <div class="stat-card"><div class="label">询价金额</div><div class="value">${{ money(s.amount_usd) }}</div></div>
      <div class="stat-card accent"><div class="label">成交转化率</div><div class="value">{{ s.conversion || 0 }}<small>%</small></div></div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="switchTab(t.key)">{{ t.label }}</button>
      </div>
    </div>

    <!-- ============ 商品 ============ -->
    <template v-if="tab === 'products'">
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" v-model="pq" placeholder="搜索名称 / 款号" @keyup.enter="loadProducts" style="width: 220px" />
        <select class="select" v-model="pstatus" @change="loadProducts">
          <option value="">全部状态</option>
          <option value="published">已上架</option>
          <option value="draft">草稿</option>
          <option value="off">已下架</option>
        </select>
        <button class="btn btn-ghost" @click="loadProducts">查询</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openProductForm()">＋ 发布商品</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>款号</th><th>名称</th><th>类别</th><th class="num">售价 USD</th>
              <th class="num">起订</th><th class="num">交期</th><th class="num">美仓可售</th>
              <th>标签</th><th>状态</th><th v-if="canWrite" style="width: 190px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in mallProducts" :key="p.id">
              <td>{{ p.style_no || '-' }}</td>
              <td><strong>{{ p.name_cn }}</strong><div class="muted">{{ p.name_en || '' }}</div></td>
              <td>{{ p.category || '-' }}</td>
              <td class="num">${{ money(p.price_usd) }}</td>
              <td class="num">{{ p.moq }}</td>
              <td class="num">{{ p.lead_days }} 天</td>
              <td class="num"><span :class="p.sellable > 0 ? 'tag green' : 'tag gray'">{{ p.sellable }}</span></td>
              <td>{{ p.tags || '-' }}</td>
              <td><span class="tag" :class="p.status === 'published' ? 'green' : p.status === 'draft' ? 'gray' : 'orange'">{{ statusLabel(p.status) }}</span></td>
              <td v-if="canWrite" style="white-space: nowrap">
                <button v-action="['mall-admin','edit']"  class="link-btn" @click="openProductForm(p)">编辑</button>
                <button v-if="p.status !== 'published'" class="link-btn" @click="setStatus(p, 'published')">上架</button>
                <button v-else class="link-btn" @click="setStatus(p, 'off')">下架</button>
                <button class="link-btn" @click="openPrice(p)">专属价</button>
                <button class="link-btn danger" @click="removeProduct(p)">删</button>
              </td>
            </tr>
            <tr v-if="!mallProducts.length"><td :colspan="canWrite ? 10 : 9" class="empty-cell">还没有商品，点「发布商品」从产品库上架</td></tr>
          </tbody>
        </table>
      </div>

    </template>

    <!-- ============ 询价 ============ -->
    <template v-else-if="tab === 'inquiries'">
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="istatus" @change="loadInquiries">
          <option value="">全部状态</option>
          <option value="submitted">待报价</option>
          <option value="quoted">已报价</option>
          <option value="confirmed">待转订单</option>
          <option value="converted">已转订单</option>
          <option value="cancelled">已取消</option>
        </select>
        <input class="input" v-model="iq" placeholder="询价单号 / 客户" @keyup.enter="loadInquiries" style="width: 220px" />
        <button class="btn btn-ghost" @click="loadInquiries">查询</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>询价单号</th><th>客户</th><th class="num">件数</th><th class="num">金额 USD</th><th>状态</th><th>下单时间</th><th>关联订单</th><th style="width: 200px">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in inquiries" :key="r.id">
              <td><strong>{{ r.inquiry_no }}</strong></td>
              <td>{{ r.customer_name || '-' }}</td>
              <td class="num">{{ r.total_qty }}</td>
              <td class="num">${{ money(r.total_usd) }}</td>
              <td><span class="tag" :class="statusTag(r.status)">{{ r.status_label }}</span></td>
              <td>{{ $fmt(r.created_at) }}</td>
              <td>{{ r.order_id ? '#' + r.order_id : '-' }}</td>
              <td style="white-space: nowrap">
                <button class="link-btn" @click="openInquiry(r)">明细</button>
                <button v-if="canWrite && ['submitted','quoted'].includes(r.status)" class="link-btn" @click="openQuote(r)">报价</button>
                <button v-if="canWrite && r.status === 'confirmed'" class="link-btn" @click="convert(r)">转订单</button>
              </td>
            </tr>
            <tr v-if="!inquiries.length"><td colspan="8" class="empty-cell">暂无询价单</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 客户账号 ============ -->
    <template v-else>
      <div class="toolbar" style="margin-bottom: 12px">
        <select class="select" v-model="acctCustomer" @change="loadAccounts" style="width: 240px">
          <option :value="null">全部客户</option>
          <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button v-if="canWrite" class="btn btn-primary" @click="openAccountForm()">＋ 开通账号</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openInviteForm()">发注册邀请</button>
        <button class="btn btn-ghost" @click="openAudits()">授权审计</button>
        <button v-if="canWrite" class="btn btn-ghost" @click="openNotify()">发通知</button>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>客户</th><th>登录账号</th><th>姓名</th><th>角色</th>
              <th style="min-width: 200px">生效权限</th>
              <th style="min-width: 180px">销售批准上限</th>
              <th>状态</th><th>最近登录</th><th v-if="canWrite" style="width: 230px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id">
              <td>{{ a.customer_name || '-' }}</td>
              <td><strong>{{ a.username }}</strong></td>
              <td>{{ a.name || '-' }}</td>
              <td><span class="tag" :class="a.role === 'owner' ? 'blue' : 'gray'">{{ a.role_label || (a.role === 'owner' ? '主账号' : '子账号') }}</span></td>
              <td class="perm-cell">{{ (a.perm_labels || []).join('、') || '-' }}</td>
              <td class="perm-cell">
                <template v-if="a.role === 'owner'">{{ (a.limit_labels || []).join('、') }}</template>
                <span v-else class="muted">随主账号</span>
              </td>
              <td><span class="tag" :class="a.status === 'active' ? 'green' : 'gray'">{{ a.status === 'active' ? '启用' : '停用' }}</span></td>
              <td>{{ a.last_login_at ? $fmt(a.last_login_at) : '未登录' }}</td>
              <td v-if="canWrite" style="white-space: nowrap">
                <button v-if="a.role === 'owner'" class="link-btn" @click="openApprove(a)">批准上限</button>
                <button class="link-btn" @click="resetPwd(a)">重置密码</button>
                <button  v-if="a.status === 'active'" class="link-btn danger" @click="setAccountStatus(a, 'disabled')">停用</button>
                <button  v-else class="link-btn" @click="setAccountStatus(a, 'active')">启用</button>
              </td>
            </tr>
            <tr v-if="!accounts.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">还没有商城账号，点「开通账号」或「发注册邀请」</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="invites.length" class="invite-box">
        <h4>注册邀请</h4>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>客户</th><th>角色</th><th>令牌</th><th>核验联系方式</th><th>有效期</th><th>状态</th><th>使用人</th><th v-if="canWrite"></th></tr></thead>
            <tbody>
              <tr v-for="v in invites" :key="v.id">
                <td>{{ v.customer_name || '-' }}</td>
                <td>{{ v.role_label }}</td>
                <td class="muted">{{ v.token_masked }}</td>
                <td>{{ v.contact || '-' }}</td>
                <td>{{ v.expires_at }}</td>
                <td><span class="tag" :class="v.status === 'pending' ? 'orange' : v.status === 'used' ? 'green' : 'gray'">{{ v.status_label }}</span></td>
                <td>{{ v.used_by_username || '-' }}</td>
                <td v-if="canWrite">
                  <button v-if="v.status === 'pending'" class="link-btn danger" @click="revokeInvite(v)">撤回</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ===== 商品表单 ===== -->
    <div v-if="productForm" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ productForm.id ? '编辑商城商品' : '发布商品到商城' }}</h3>
          <button class="x" @click="productForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div v-if="!productForm.id" class="fitem full">
              <label>从产品库选择（自动带出款号/类别/价格）</label>
              <select class="select" v-model.number="productForm.product_id" @change="pickProduct">
                <option :value="null">— 手工填写 —</option>
                <option v-for="p in products" :key="p.id" :value="p.id">{{ p.sku ? p.sku + ' · ' : '' }}{{ p.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>中文名称 *</label><input class="input" v-model="productForm.name_cn" /></div>
            <div class="fitem"><label>英文名称</label><input class="input" v-model="productForm.name_en" /></div>
            <div class="fitem"><label>款号</label><input class="input" v-model="productForm.style_no" /></div>
            <div class="fitem"><label>类别</label><input class="input" v-model="productForm.category" /></div>
            <div class="fitem"><label>售价 USD</label><input class="input" type="number" step="0.01" v-model.number="productForm.price_usd" /></div>
            <div class="fitem"><label>起订量</label><input class="input" type="number" v-model.number="productForm.moq" /></div>
            <div class="fitem"><label>交期（天）</label><input class="input" type="number" v-model.number="productForm.lead_days" /></div>
            <div class="fitem"><label>标签</label><input class="input" v-model="productForm.tags" placeholder="如 热销 / 新品" /></div>
            <div class="fitem full"><label>封面图 URL</label><input class="input" v-model="productForm.cover_image" /></div>
            <div class="fitem full"><label>商品说明</label><textarea v-model="productForm.description" rows="3"></textarea></div>
            <div class="fitem">
              <label>展示现货数量</label>
              <select class="select" v-model.number="productForm.visible_stock">
                <option :value="1">显示</option><option :value="0">隐藏（定制款）</option>
              </select>
            </div>
            <div class="fitem">
              <label>上架状态</label>
              <select class="select" v-model="productForm.status">
                <option value="published">上架</option><option value="draft">草稿</option><option value="off">下架</option>
              </select>
            </div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="productForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveProduct">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== 客户专属价 ===== -->
    <div v-if="priceModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>客户专属价 · {{ priceModal.name_cn }}</h3>
          <button class="x" @click="priceModal = null">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="font-size: 12px; margin: 0 0 12px">
            公开价 ${{ money(priceModal.price_usd) }}。给指定客户单独定价后，该客户在商城看到的即为专属价。
          </p>
          <div class="toolbar" style="margin-bottom: 12px">
            <select class="select" v-model="priceForm.customer_id" style="width: 200px">
              <option :value="null">— 选择客户 —</option>
              <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <input class="input" type="number" step="0.01" v-model.number="priceForm.price_usd" placeholder="专属价" style="width: 130px" />
            <input class="input" type="number" v-model.number="priceForm.moq" placeholder="起订(可空)" style="width: 130px" />
            <button class="btn btn-primary btn-sm" @click="savePrice">保存</button>
          </div>
          <table class="data">
            <thead><tr><th>客户</th><th class="num">专属价</th><th class="num">起订</th><th></th></tr></thead>
            <tbody>
              <tr v-for="r in priceRows" :key="r.id">
                <td>{{ r.customer_name || '客户 #' + r.customer_id }}</td>
                <td class="num">${{ money(r.price_usd) }}</td>
                <td class="num">{{ r.moq || '-' }}</td>
                <td><button class="link-btn danger" @click="removePrice(r)">删</button></td>
              </tr>
              <tr v-if="!priceRows.length"><td colspan="4" class="empty-cell">还没有专属价</td></tr>
            </tbody>
          </table>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="priceModal = null">关闭</button></div>
      </div>
    </div>

    <!-- ===== 报价 ===== -->
    <div v-if="quoteModal" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>报价 · {{ quoteModal.inquiry_no }}</h3>
          <button class="x" @click="quoteModal = null">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="font-size: 12px; margin: 0 0 10px">
            {{ quoteModal.customer_name }} · {{ quoteModal.total_qty }} 件 · 客户备注：{{ quoteModal.remark || '-' }}
          </p>
          <table class="data">
            <thead><tr><th>商品</th><th>款号</th><th class="num">数量</th><th class="num">客户预期价</th><th class="num">报价 USD</th><th class="num">小计</th></tr></thead>
            <tbody>
              <tr v-for="it in quoteItems" :key="it.id">
                <td>{{ it.name }}</td>
                <td>{{ it.style_no || '-' }}</td>
                <td class="num">{{ it.qty }}</td>
                <td class="num">${{ money(it.price_usd) }}</td>
                <td class="num"><input class="input" type="number" step="0.01" v-model.number="it.quote_price" style="width: 110px; text-align: right" /></td>
                <td class="num">${{ money((it.qty || 0) * (it.quote_price || 0)) }}</td>
              </tr>
            </tbody>
          </table>
          <div style="text-align: right; font-size: 13.5px; margin-top: 8px">
            报价合计 <strong>${{ money(quoteTotal) }}</strong>
          </div>
          <div class="fitem" style="margin-top: 12px">
            <label>报价说明（客户可见）</label>
            <textarea v-model="quoteForm.sales_remark" rows="2" placeholder="如：含常规包装，量大可再谈"></textarea>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="quoteModal = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="submitQuote">{{ saving ? '提交中…' : '提交报价并通知客户' }}</button>
        </div>
      </div>
    </div>

    <!-- ===== 询价明细 ===== -->
    <div v-if="inqDetail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>询价明细 · {{ inqDetail.inquiry_no }}</h3>
          <button class="x" @click="inqDetail = null">×</button>
        </div>
        <div class="modal-body">
          <table class="data" style="margin-bottom: 12px">
            <tbody>
              <tr><th style="width: 100px">客户</th><td>{{ inqDetail.customer_name }}</td>
                <th style="width: 100px">状态</th><td>{{ inqDetail.status_label }}</td></tr>
              <tr><th>联系人</th><td>{{ inqDetail.contact || '-' }}</td>
                <th>合计</th><td>${{ money(inqDetail.total_usd) }} / {{ inqDetail.total_qty }} 件</td></tr>
              <tr><th>客户备注</th><td colspan="3">{{ inqDetail.remark || '-' }}</td></tr>
              <tr><th>报价说明</th><td colspan="3">{{ inqDetail.sales_remark || '-' }}</td></tr>
            </tbody>
          </table>
          <table class="data">
            <thead><tr><th>商品</th><th>款号</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
            <tbody>
              <tr v-for="it in inqDetail.items" :key="it.id">
                <td>{{ it.name }}</td><td>{{ it.style_no || '-' }}</td>
                <td class="num">{{ it.qty }}</td><td class="num">${{ money(it.price_usd) }}</td>
                <td class="num">${{ money(it.amount_usd) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="inqDetail = null">关闭</button></div>
      </div>
    </div>

    <!-- ===== 开通账号 ===== -->
    <div v-if="accountForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>开通商城账号</h3>
          <button class="x" @click="accountForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>客户 *</label>
              <select class="select" v-model.number="accountForm.customer_id">
                <option :value="null">— 选择客户 —</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>登录账号 *（≥4 位）</label><input class="input" v-model="accountForm.username" /></div>
            <div class="fitem"><label>初始密码 *（≥6 位）</label><input class="input" v-model="accountForm.password" /></div>
            <div class="fitem"><label>姓名 / 称呼</label><input class="input" v-model="accountForm.name" /></div>
            <div class="fitem"><label>手机</label><input class="input" v-model="accountForm.phone" /></div>
          </div>
          <p class="muted" style="font-size: 12px; margin: 10px 0 0">
            该客户的第一个账号自动为「主账号」，后续添加的为「子账号」，数据按客户隔离。
          </p>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="accountForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveAccount">{{ saving ? '开通中…' : '开通' }}</button>
        </div>
      </div>
    </div>


    <!-- ===== 批准权限上限 ===== -->
    <div v-if="approveModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>批准客户可分配的权限上限 · {{ approveModal.name }}</h3>
          <button class="x" @click="approveModal = null">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="font-size: 12.5px; margin: 0 0 10px">
            客户主账号只能在这个范围内给子账号分配权限；收紧上限会同步收紧已开的子账号。
            主账号自己也受这个上限约束——不批财务，客户组织就看不到对账。
          </p>
          <div class="perm-grid">
            <label v-for="(label, key) in permDict" :key="key" class="perm-chk">
              <input type="checkbox" :value="key" v-model="approveForm.limit_perms" />
              <span><b>{{ label }}</b><i>{{ key }}</i></span>
            </label>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="approveModal = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveApprove">保存上限</button>
        </div>
      </div>
    </div>

    <!-- ===== 发注册邀请 ===== -->
    <div v-if="inviteForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>发注册邀请</h3>
          <button class="x" @click="inviteForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>客户 *</label>
              <select class="select" v-model.number="inviteForm.customer_id">
                <option :value="null">— 选择客户 —</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>账号类型</label>
              <select class="select" v-model="inviteForm.role">
                <option value="owner">主账号</option>
                <option value="purchase">采购子账号</option>
                <option value="orders">订单子账号</option>
                <option value="finance">财务子账号</option>
                <option value="member">其他子账号</option>
              </select>
            </div>
            <div class="fitem">
              <label>有效期（天）</label>
              <input class="input" type="number" v-model.number="inviteForm.days" />
            </div>
            <div class="fitem full">
              <label>核验用联系方式 *（手机或邮箱）</label>
              <input class="input" v-model="inviteForm.contact" placeholder="客户本人手机或邮箱，用于核验" />
            </div>
            <div class="fitem full">
              <label>备注</label>
              <input class="input" v-model="inviteForm.note" />
            </div>
          </div>
          <div v-if="inviteResult" class="invite-result">
            <div>邀请链接（发给客户本人，让他自己设密码）：</div>
            <code>{{ inviteResult.url }}</code>
            <div class="muted">令牌：{{ inviteResult.token }}</div>
            <div class="muted">有效期至 {{ inviteResult.expires_at }}，一次性，用过即废。</div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="inviteForm = null">关闭</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveInvite">生成邀请</button>
        </div>
      </div>
    </div>

    <!-- ===== 授权审计 ===== -->
    <div v-if="auditOpen" class="modal-mask">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>客户授权审计</h3>
          <button class="x" @click="auditOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>时间</th><th>动作</th><th>客户</th><th>账号</th><th>来源</th><th>操作人</th><th>变更</th></tr></thead>
              <tbody>
                <tr v-for="a in auditRows" :key="a.id">
                  <td class="muted">{{ $fmt(a.created_at) }}</td>
                  <td><span class="tag" :class="a.action === 'disable' || a.action === 'revoke' ? 'red' : a.action === 'create' || a.action === 'accept_invite' ? 'green' : 'gray'">{{ a.action_label }}</span></td>
                  <td>{{ a.customer_name || '-' }}</td>
                  <td>{{ a.username || '-' }}</td>
                  <td>{{ a.scope_label }}</td>
                  <td>{{ a.operator || '-' }}</td>
                  <td class="audit-detail">{{ a.after_json || a.before_json || '-' }}</td>
                </tr>
                <tr v-if="!auditRows.length"><td colspan="7" class="empty-cell">还没有授权记录</td></tr>
              </tbody>
            </table>
          </div>
          <p class="muted" style="font-size: 12px; margin-top: 10px">审计只读：普通业务用户不能修改或删除。</p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="auditOpen = false">关闭</button></div>
      </div>
    </div>

    <!-- ===== 发通知 ===== -->
    <div v-if="notifyForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>给客户发站内通知</h3>
          <button class="x" @click="notifyForm = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>客户 *</label>
              <select class="select" v-model.number="notifyForm.customer_id">
                <option :value="null">— 选择客户 —</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="fitem">
              <label>类型</label>
              <select class="select" v-model="notifyForm.type">
                <option value="promo">活动/上新</option><option value="arrival">到货</option><option value="system">系统</option>
              </select>
            </div>
            <div class="fitem"><label>标题 *</label><input class="input" v-model="notifyForm.title" /></div>
            <div class="fitem full"><label>内容</label><textarea v-model="notifyForm.body" rows="3"></textarea></div>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="notifyForm = null">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="sendNotify">{{ saving ? '发送中…' : '发送' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const TABS = [
  { key: 'products', label: '商品管理' },
  { key: 'inquiries', label: '询价处理' },
  { key: 'accounts', label: '客户账号' }
];
const canWrite = computed(() => can('mall.write'));

const tab = ref('products');
const s = reactive({});
const products = ref([]);
const customers = ref([]);
const mallProducts = ref([]);
const inquiries = ref([]);
const accounts = ref([]);
const invites = ref([]);
const permDict = ref({});
const approveModal = ref(null);
const approveForm = reactive({ limit_perms: [] });
const inviteForm = ref(null);
const inviteResult = ref(null);
const auditOpen = ref(false);
const auditRows = ref([]);

const pq = ref('');
const pstatus = ref('');
const iq = ref('');
const istatus = ref('');
const acctCustomer = ref(null);

const productForm = ref(null);
const priceModal = ref(null);
const priceRows = ref([]);
const priceForm = reactive({ customer_id: null, price_usd: 0, moq: null });
const quoteModal = ref(null);
const quoteItems = ref([]);
const quoteForm = reactive({ sales_remark: '' });
const inqDetail = ref(null);
const accountForm = ref(null);
const notifyForm = ref(null);
const saving = ref(false);
const formMsg = ref('');

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusLabel = (v) => ({ published: '已上架', draft: '草稿', off: '已下架' }[v] || v);
const statusTag = (v) => (v === 'converted' ? 'green' : v === 'confirmed' ? 'blue' : v === 'quoted' ? 'orange' : v === 'cancelled' ? 'gray' : 'gray');
const quoteTotal = computed(() => quoteItems.value.reduce((a, b) => a + (Number(b.qty) || 0) * (Number(b.quote_price) || 0), 0));

async function loadStats() { try { Object.assign(s, await api.mallStats()); } catch (e) { /* ignore */ } }
async function loadProducts() { try { mallProducts.value = await api.mallProducts({ q: pq.value, status: pstatus.value }); } catch (e) { alert(e.message); } }
async function loadInquiries() { try { inquiries.value = await api.mallInquiries({ q: iq.value, status: istatus.value }); } catch (e) { alert(e.message); } }
async function loadAccounts() {
  try {
    const d = await api.mallAccounts(acctCustomer.value || '');
    accounts.value = d.rows || [];
    permDict.value = d.perm_dict || {};
    invites.value = await api.mallInvites(acctCustomer.value || '');
  } catch (e) { alert(e.message); }
}

function openApprove(a) {
  formMsg.value = '';
  approveModal.value = a;
  approveForm.limit_perms = (a.limit_perms || []).slice();
}

async function saveApprove() {
  if (!approveForm.limit_perms.length) return alert('至少要批准一个权限点');
  formMsg.value = '';
  saving.value = true;
  try {
    const r = await api.approveMallAccount(approveModal.value.id, { limit_perms: approveForm.limit_perms });
    approveModal.value = null;
    await loadAccounts();
    alert(r.notice || '已保存');
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

function openInviteForm() {
  formMsg.value = '';
  inviteResult.value = null;
  inviteForm.value = { customer_id: acctCustomer.value || null, role: 'purchase', days: 7, contact: '', note: '' };
}

async function saveInvite() {
  formMsg.value = '';
  if (!inviteForm.value.customer_id) return alert('请选择客户');
  if (!String(inviteForm.value.contact || '').trim()) return alert('请填核验用的联系方式');
  saving.value = true;
  try {
    inviteResult.value = await api.createMallInvite({ ...inviteForm.value });
    await loadAccounts();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

async function revokeInvite(v) {
  if (!confirm('撤回这个邀请？撤回后链接立刻失效')) return;
  try { await api.revokeMallInvite(v.id); await loadAccounts(); } catch (e) { alert(e.message); }
}

async function openAudits() {
  try {
    auditRows.value = await api.mallAccountAudits(acctCustomer.value || '');
    auditOpen.value = true;
  } catch (e) { alert(e.message); }
}
async function loadBase() {
  try {
    const [ps, cs] = await Promise.all([api.products({ status: 'active' }), api.customers({ status: 'active' })]);
    products.value = ps;
    customers.value = cs;
  } catch (e) { /* ignore */ }
}

function switchTab(k) {
  tab.value = k;
  if (k === 'products') loadProducts();
  else if (k === 'inquiries') loadInquiries();
  else loadAccounts();
}

function openProductForm(p) {
  formMsg.value = '';
  productForm.value = p
    ? { ...p }
    : { id: null, product_id: null, name_cn: '', name_en: '', style_no: '', category: '', price_usd: 0,
      moq: 50, lead_days: 30, tags: '', cover_image: '', description: '', visible_stock: 1, status: 'published' };
}
function pickProduct() {
  const p = products.value.find((x) => x.id === productForm.value.product_id);
  if (!p) return;
  productForm.value.name_cn = p.name;
  productForm.value.style_no = p.sku;
  productForm.value.category = p.category;
  if (!productForm.value.price_usd) productForm.value.price_usd = Math.round((Number(p.price) / 6.5) * 100) / 100;
}
async function saveProduct() {
  formMsg.value = '';
  if (!productForm.value.name_cn) { formMsg.value = '中文名称必填'; return; }
  saving.value = true;
  try {
    if (productForm.value.id) await api.updateMallProduct(productForm.value.id, productForm.value);
    else await api.createMallProduct(productForm.value);
    productForm.value = null;
    await loadProducts();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function setStatus(p, status) {
  try { await api.setMallProductStatus(p.id, status); await loadProducts(); await loadStats(); } catch (e) { alert(e.message); }
}
async function removeProduct(p) {
  if (!confirm(`从商城删除「${p.name_cn}」？`)) return;
  try { await api.deleteMallProduct(p.id); await loadProducts(); await loadStats(); } catch (e) { alert(e.message); }
}

async function openPrice(p) {
  priceModal.value = p;
  priceRows.value = [];
  priceForm.customer_id = null;
  priceForm.price_usd = 0;
  priceForm.moq = null;
  await loadPrices(p.id);
}
async function loadPrices(mallProductId) {
  // 价格接口按客户查询，这里合并所有客户看过的价格：直接查全部客户较慢，改为查当前商品的所有记录
  try {
    const all = [];
    for (const c of customers.value) {
      const rows = await api.mallPrices(c.id);
      rows.filter((r) => r.mall_product_id === mallProductId)
        .forEach((r) => all.push({ ...r, customer_name: c.name }));
    }
    priceRows.value = all;
  } catch (e) { /* ignore */ }
}
async function savePrice() {
  formMsg.value = '';
  if (!priceForm.customer_id) { alert('请选择客户'); return; }
  if (!(priceForm.price_usd > 0)) { alert('请输入专属价'); return; }
  try {
    await api.saveMallPrice({
      customer_id: priceForm.customer_id,
      mall_product_id: priceModal.value.id,
      price_usd: priceForm.price_usd,
      moq: priceForm.moq || null
    });
    await loadPrices(priceModal.value.id);
  } catch (e) { alert(e.message); }
}
async function removePrice(r) {
  try { await api.deleteMallPrice(r.id); await loadPrices(priceModal.value.id); } catch (e) { alert(e.message); }
}

async function openInquiry(r) {
  try { inqDetail.value = await api.mallInquiry(r.id); } catch (e) { alert(e.message); }
}
async function openQuote(r) {
  formMsg.value = '';
  try {
    const d = await api.mallInquiry(r.id);
    quoteModal.value = d;
    quoteForm.sales_remark = d.sales_remark || '';
    quoteItems.value = d.items.map((it) => ({ ...it, quote_price: Number(it.price_usd) || 0 }));
  } catch (e) { alert(e.message); }
}
async function submitQuote() {
  formMsg.value = '';
  saving.value = true;
  try {
    await api.quoteMallInquiry(quoteModal.value.id, {
      items: quoteItems.value.map((it) => ({ id: it.id, price_usd: Number(it.quote_price) || 0 })),
      sales_remark: quoteForm.sales_remark || null
    });
    quoteModal.value = null;
    await loadInquiries();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function convert(r) {
  if (!confirm(`把询价单 ${r.inquiry_no} 转成销售订单？`)) return;
  try {
    const res = await api.convertMallInquiry(r.id);
    await loadInquiries();
    await loadStats();
    alert(`已生成订单 ${res.order_no}`);
  } catch (e) { alert(e.message); }
}

function openAccountForm() {
  formMsg.value = '';
  accountForm.value = { customer_id: null, username: '', password: '', name: '', phone: '' };
}
async function saveAccount() {
  formMsg.value = '';
  saving.value = true;
  try {
    await api.createMallAccount(accountForm.value);
    accountForm.value = null;
    await loadAccounts();
    await loadStats();
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}
async function setAccountStatus(a, status) {
  try { await api.updateMallAccount(a.id, { status }); await loadAccounts(); } catch (e) { alert(e.message); }
}
async function resetPwd(a) {
  const p = prompt(`给 ${a.username} 设置新密码（至少 6 位）：`);
  if (!p) return;
  try { await api.updateMallAccount(a.id, { password: p }); alert('密码已重置'); } catch (e) { alert(e.message); }
}

function openNotify() {
  formMsg.value = '';
  notifyForm.value = { customer_id: null, type: 'promo', title: '', body: '' };
}
async function sendNotify() {
  formMsg.value = '';
  if (!notifyForm.value.customer_id) { formMsg.value = '请选择客户'; return; }
  if (!notifyForm.value.title) { formMsg.value = '标题必填'; return; }
  saving.value = true;
  try {
    await api.mallNotify(notifyForm.value);
    notifyForm.value = null;
    alert('已发送');
  } catch (e) { formMsg.value = e.message; } finally { saving.value = false; }
}

onMounted(() => {
  loadStats();
  loadProducts();
  loadBase();
});
</script>

<style scoped>
.table-wrap table.data th, .table-wrap table.data td { white-space: nowrap; }
.table-wrap table.data td.perm-cell { white-space: normal; }
.perm-cell { font-size: 12px; color: #5b6474; max-width: 260px; white-space: normal; line-height: 1.5; }
.invite-box { margin-top: 18px; }
.invite-box h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.perm-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.perm-chk { display: flex; align-items: flex-start; gap: 8px; border: 1px solid #e8edf4; border-radius: 9px; padding: 8px 10px; cursor: pointer; }
.perm-chk:hover { background: #f8fafd; }
.perm-chk span { display: flex; flex-direction: column; gap: 2px; }
.perm-chk b { font-size: 12.5px; color: var(--ink); font-weight: 600; }
.perm-chk i { font-size: 12px; color: #9aa4b5; font-style: normal; }
.invite-result { margin-top: 12px; background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 10px 12px; font-size: 12.5px; line-height: 1.8; }
.invite-result code { display: block; background: var(--surface); border: 1px solid #e3e9f2; border-radius: 6px; padding: 6px 8px; margin: 6px 0; font-size: 12.5px; word-break: break-all; color: #1d4ed8; }
.audit-detail { max-width: 300px; white-space: normal; word-break: break-all; font-size: 12px; color: var(--ink-soft); }
</style>
