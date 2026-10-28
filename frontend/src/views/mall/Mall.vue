<template>
  <div class="ml-shell">
    <header class="ml-head">
      <div class="ml-brand">
        <span class="ml-logo">跳</span>
        <div>
          <div class="ml-co">跳色科技 · 客户选品中心</div>
          <div class="ml-co-en">TIAOSE · CUSTOMER ORDER PORTAL</div>
        </div>
      </div>
      <div class="ml-user">
        <span class="ml-cust">{{ info.customer && info.customer.name }}</span>
        <span class="ml-acc">{{ account.name || account.username }}</span>
        <span v-if="info.account && info.account.role_label" class="ml-role">{{ info.account.role_label }}</span>
        <button class="ml-link" @click="changePwd">改密码</button>
        <button class="ml-link" @click="logout">退出</button>
      </div>
    </header>

    <nav class="ml-tabs">
      <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="switchTab(t.key)">
        {{ t.label }}
        <span v-if="t.key === 'confirm' && badge.pending_confirm" class="ml-badge">{{ badge.pending_confirm }}</span>
        <span v-else-if="t.key === 'messages' && badge.unread" class="ml-badge">{{ badge.unread }}</span>
        <span v-else-if="t.key === 'inquiries' && badge.inquiries" class="ml-badge">{{ badge.inquiries }}</span>
        <span v-else-if="t.key === 'favorites' && badge.favorites" class="ml-dot"></span>
      </button>
    </nav>

    <main class="ml-main">
      <!-- ============ 商品 ============ -->
      <section v-if="tab === 'products'">
        <div class="ml-filter">
          <input class="ml-input" v-model="q" placeholder="搜索款号 / 名称 / 标签" @keyup.enter="loadProducts" />
          <button class="ml-btn" @click="loadProducts">搜索</button>
        </div>
        <div class="ml-chips">
          <button class="ml-chip" :class="{ on: !category }" @click="pickCategory('')">全部</button>
          <button v-for="c in categories" :key="c.category" class="ml-chip" :class="{ on: category === c.category }"
            @click="pickCategory(c.category)">{{ c.category }} {{ c.cnt }}</button>
        </div>

        <div v-if="loading.products" class="ml-empty">加载中…</div>
        <div v-else-if="!products.length" class="ml-empty">没有符合条件的商品</div>
        <div v-else class="ml-grid">
          <div v-for="p in products" :key="p.id" class="ml-card" @click="openProduct(p)">
            <div class="ml-cover" :style="p.cover_image ? { backgroundImage: 'url(' + p.cover_image + ')' } : {}">
              <span v-if="!p.cover_image" class="ml-cover-ph">{{ (p.name_cn || '款').slice(0, 2) }}</span>
              <span v-if="p.tags" class="ml-tag">{{ p.tags }}</span>
            </div>
            <div class="ml-card-body">
              <div class="ml-card-title">{{ p.name_cn }}</div>
              <div class="ml-card-sub">{{ p.style_no || '-' }} · {{ p.category_label }}</div>
              <div class="ml-card-price">
                <strong>${{ money(p.price_usd) }}</strong>
                <span class="ml-moq">起订 {{ p.moq }}</span>
              </div>
              <div class="ml-card-foot">
                <span v-if="p.sellable === null" class="ml-muted">定制款</span>
                <span v-else-if="p.in_stock" class="ml-stock">现货 {{ p.sellable }}</span>
                <span v-else class="ml-muted">需排产</span>
                <button class="ml-fav" :class="{ on: p.favorite }" @click.stop="toggleFav(p)">
                  {{ p.favorite ? '★' : '☆' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 收藏 ============ -->
      <section v-else-if="tab === 'favorites'">
        <div v-if="!favorites.length" class="ml-empty">还没有收藏的商品，去「商品」里点 ☆ 收藏</div>
        <div v-else class="ml-grid">
          <div v-for="p in favorites" :key="p.id" class="ml-card" @click="openProduct(p)">
            <div class="ml-cover" :style="p.cover_image ? { backgroundImage: 'url(' + p.cover_image + ')' } : {}">
              <span v-if="!p.cover_image" class="ml-cover-ph">{{ (p.name_cn || '款').slice(0, 2) }}</span>
            </div>
            <div class="ml-card-body">
              <div class="ml-card-title">{{ p.name_cn }}</div>
              <div class="ml-card-sub">{{ p.style_no || '-' }}</div>
              <div class="ml-card-price"><strong>${{ money(p.price_usd) }}</strong><span class="ml-moq">起订 {{ p.moq }}</span></div>
              <div class="ml-card-foot">
                <span class="ml-muted">{{ p.in_stock ? '现货 ' + p.sellable : '需排产' }}</span>
                <button class="ml-fav on" @click.stop="toggleFav(p)">★</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 我的询价 ============ -->
      <section v-else-if="tab === 'inquiries'">
        <div v-if="!inquiries.length" class="ml-empty">还没有询价单，去「商品」选款后提交</div>
        <div v-else class="ml-list">
          <div v-for="q2 in inquiries" :key="q2.id" class="ml-row" @click="openInquiry(q2)">
            <div>
              <strong>{{ q2.inquiry_no }}</strong>
              <div class="ml-muted">{{ q2.total_qty }} 件 · {{ $fmtDate(q2.created_at) }}</div>
            </div>
            <div class="ml-row-right">
              <span class="ml-amount">${{ money(q2.total_usd) }}</span>
              <span class="ml-status" :class="'s-' + q2.status">{{ q2.status_label }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 我的订单 ============ -->
      <section v-else-if="tab === 'orders'">
        <div v-if="!orders.length" class="ml-empty">暂无订单</div>
        <div v-else class="ml-list">
          <div v-for="o in orders" :key="o.id" class="ml-row" @click="openOrder(o)">
            <div>
              <strong>{{ o.order_no }}</strong>
              <div class="ml-muted">{{ o.style_name || '-' }} · 交期 {{ o.delivery_date || '待定' }}</div>
              <!-- 有已发布进度才显示；没发布就不占用一行（不显示「0%」误导客户） -->
              <div v-if="progressMap[o.id]" class="ml-mini">
                <span class="ml-mini-bar"><i :style="{ width: (progressMap[o.id].progress_pct || 0) + '%' }"></i></span>
                <span class="ml-muted">
                  {{ progressMap[o.id].current_stage ? progressMap[o.id].current_stage.label : '—' }}
                  · {{ progressMap[o.id].done_count }}/{{ progressMap[o.id].stage_count }} 阶段
                </span>
                <span v-if="progressMap[o.id].completed" class="ml-done-tag">已完工</span>
              </div>
            </div>
            <div class="ml-row-right">
              <span v-if="amountVisible" class="ml-amount">${{ money(o.total_usd) }}</span>
              <span v-else class="ml-hidden-amt">金额不可见</span>
              <span class="ml-status" :class="'o-' + o.status">{{ o.status_label }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 待确认（样衣 / 变更 / 交期） ============ -->
      <section v-else-if="tab === 'confirm'">
        <div class="ml-msg-head">
          <span class="ml-muted">共 {{ confirmations.total }} 项待您确认</span>
        </div>
        <div v-if="!confirmations.total" class="ml-empty">暂时没有需要确认的事项</div>

        <template v-else>
          <div v-if="confirmations.seals.length" class="ml-block">
            <div class="ml-block-title">样衣封样确认</div>
            <div v-for="x in confirmations.seals" :key="'s' + x.id" class="ml-card-row">
              <div class="ml-card-main">
                <div><strong>{{ x.sample_name || x.style_no || '样衣' }}</strong> · {{ x.version }}</div>
                <div class="ml-muted">订单 {{ x.order_no }} · 发出 {{ $fmtDate(x.sent_at) }}</div>
                <div class="ml-muted">内容校验值 {{ x.content_hash }}</div>
                <div v-if="x.attachments.length" class="ml-muted">
                  附件：<span v-for="(a, i) in x.attachments" :key="i">{{ a.name }}{{ i < x.attachments.length - 1 ? '、' : '' }}</span>
                </div>
              </div>
              <div class="ml-card-act">
                <button class="ml-btn primary" @click="actSeal(x, true)">确认样衣</button>
                <button class="ml-btn" @click="actSeal(x, false)">提修改</button>
              </div>
            </div>
          </div>

          <div v-if="confirmations.changes.length" class="ml-block">
            <div class="ml-block-title">订单变更确认</div>
            <div v-for="x in confirmations.changes" :key="'c' + x.id" class="ml-card-row">
              <div class="ml-card-main">
                <div><strong>{{ x.type_label }}</strong> · {{ x.title }}</div>
                <div class="ml-muted">订单 {{ x.order_no }} · 变更号 {{ x.change_no }}</div>
                <div class="ml-muted">影响：在制 {{ x.affected_in_production }} 件，剩余可变更 {{ x.remaining_qty }} 件，金额影响 {{ x.price_delta }}，交期影响 {{ x.delivery_delta_days }} 天</div>
                <div v-if="x.assess_note" class="ml-muted">说明：{{ x.assess_note }}</div>
              </div>
              <div class="ml-card-act">
                <button class="ml-btn primary" @click="actChange(x, true)">同意变更</button>
                <button class="ml-btn" @click="actChange(x, false)">不接受</button>
              </div>
            </div>
          </div>

          <div v-if="confirmations.deliveries.length" class="ml-block">
            <div class="ml-block-title">交期变动确认</div>
            <div v-for="x in confirmations.deliveries" :key="'d' + x.id" class="ml-card-row">
              <div class="ml-card-main">
                <div><strong>{{ x.kind_label }}</strong>：{{ x.promised_date || '未定' }} → {{ x.new_date }}</div>
                <div class="ml-muted">订单 {{ x.order_no }} · {{ x.delay_days === null ? '' : (x.delay_days > 0 ? '延后' : '提前') + Math.abs(x.delay_days) + ' 天' }}</div>
                <div v-if="x.reason" class="ml-muted">原因：{{ x.reason }}</div>
              </div>
              <div class="ml-card-act">
                <button class="ml-btn primary" @click="actDelivery(x, true)">接受</button>
                <button class="ml-btn" @click="actDelivery(x, false)">不接受</button>
              </div>
            </div>
          </div>
        </template>
      </section>

      <!-- ============ 售后 ============ -->
      <section v-else-if="tab === 'after'">
        <div class="ml-msg-head">
          <span class="ml-muted">
            提了售后，业务受理后你可以在这里看到处理到哪一步。质量问题、错款、破损请<b>上传照片</b> ——
            没有照片业务没法向工厂说明。
          </span>
          <button class="ml-btn primary" @click="openAfterForm">提新售后</button>
        </div>

        <!-- 提交表单 -->
        <div v-if="afterForm.open" class="ml-block ml-after-form">
          <div class="ml-block-title">提新售后</div>
          <div class="ml-form-row">
            <label>订单</label>
            <select v-model="afterForm.order_id" class="ml-input" style="flex: 1" @change="afterForm.order_item_id = null">
              <option :value="null">选择订单</option>
              <option v-for="o in afterOptions" :key="o.id" :value="o.id">{{ o.order_no }}（{{ o.style_name || '-' }}）</option>
            </select>
          </div>
          <div class="ml-form-row" v-if="afterForm.order_id">
            <label>款式</label>
            <select v-model="afterForm.order_item_id" class="ml-input" style="flex: 1">
              <option :value="null">选择款</option>
              <option v-for="it in currentItems" :key="it.id" :value="it.id" :disabled="it.available <= 0">
                {{ it.style_no }} · {{ it.product_name }}（可提 {{ it.available }} 件）
              </option>
            </select>
          </div>
          <div class="ml-form-row">
            <label>原因</label>
            <select v-model="afterForm.reason_code" class="ml-input" style="width: 140px">
              <option v-for="r in afterReasons" :key="r.code" :value="r.code">{{ r.label }}</option>
            </select>
            <label>怎么处理</label>
            <select v-model="afterForm.resolution" class="ml-input" style="width: 140px">
              <option v-for="r in afterResolutions" :key="r.code" :value="r.code">{{ r.label }}</option>
            </select>
          </div>
          <div class="ml-form-row">
            <label>数量</label>
            <input v-model="afterForm.qty" class="ml-input" type="number" style="width: 100px" />
            <label>索赔金额</label>
            <input v-model="afterForm.amount_claim" class="ml-input" type="number" style="width: 120px" />
            <span class="ml-muted" v-if="currentItem">最多 {{ currentItem.qty }} 件 / 货款 {{ currentItem.amount_usd }}</span>
          </div>
          <div class="ml-form-row">
            <label>说明</label>
            <textarea v-model="afterForm.reason" class="ml-input" rows="2" style="flex: 1"
              placeholder="至少 8 个字：什么问题、多少件、客户怎么反馈的"></textarea>
          </div>
          <div class="ml-form-row">
            <label>照片</label>
            <input type="file" accept="image/*" multiple @change="onAfterPhotos" />
            <span class="ml-muted">{{ afterForm.photos.length }} 张{{ needPhoto ? '（该原因必须上传）' : '' }}</span>
          </div>
          <div class="ml-form-foot">
            <button class="ml-btn" @click="afterForm.open = false">取消</button>
            <button class="ml-btn primary" @click="submitAfter">提交</button>
          </div>
        </div>

        <!-- 我的售后单 -->
        <div v-if="!afterRowList.length" class="ml-empty">还没有售后记录</div>
        <div v-else class="ml-list">
          <div v-for="r in afterRowList" :key="r.id" class="ml-after-row" @click="openAfterDetail(r.id)">
            <div class="ml-after-main">
              <div>
                <strong>{{ r.ticket_no }}</strong>
                <span class="ml-pill" :class="r.status === 'settled' ? 'g' : (r.status === 'rejected' ? '' : 'r')">{{ r.status_label }}</span>
                <span class="ml-muted"> · {{ r.order_no }} · {{ r.style_no }} × {{ r.qty }}</span>
              </div>
              <div class="ml-muted">{{ r.reason_label }} → {{ r.resolution_label }}</div>
              <div class="ml-muted">{{ r.progress_text }}</div>
              <div class="ml-muted" v-if="r.refund_status === 'paid'">
                已退款 {{ r.refund_amount }} {{ r.currency }}
              </div>
            </div>
            <div class="ml-after-act">
              <button v-if="r.status === 'submitted'" class="ml-btn" @click.stop="cancelAfter(r)">撤销</button>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 消息 ============ -->
      <section v-else-if="tab === 'messages'">
        <div class="ml-msg-head">
          <span class="ml-muted">共 {{ messages.length }} 条，未读 {{ badge.unread }}</span>
          <button v-if="badge.unread" class="ml-btn" @click="readAll">全部标为已读</button>
        </div>
        <div v-if="!messages.length" class="ml-empty">暂无消息</div>
        <div v-else class="ml-list">
          <div v-for="m in messages" :key="m.id" class="ml-msg" :class="{ unread: !m.read_at }" @click="readMsg(m)">
            <div class="ml-msg-title">
              <span class="ml-type" :class="'t-' + m.type">{{ typeLabel(m.type) }}</span>
              {{ m.title }}
            </div>
            <div class="ml-msg-body">{{ m.body }}</div>
            <div class="ml-muted">{{ $fmt(m.created_at) }}</div>
          </div>
        </div>
      </section>

      <!-- ============ 对账（财务子账号） ============ -->
      <section v-else-if="tab === 'finance'">
        <div class="ml-msg-head">
          <span class="ml-muted">只含本组织的应收与货款，不含内部成本</span>
        </div>
        <div class="ml-sum-row">
          <div><span>账单数</span><b>{{ finance.summary.bills || 0 }}</b></div>
          <div><span>应收合计</span><b>¥{{ money(finance.summary.total) }}</b></div>
          <div><span>已收</span><b class="g">¥{{ money(finance.summary.paid) }}</b></div>
          <div><span>未收</span><b class="r">¥{{ money(finance.summary.open) }}</b></div>
          <div><span>逾期未收</span><b :class="finance.summary.overdue ? 'r' : ''">¥{{ money(finance.summary.overdue) }}</b></div>
          <div><span>回款率</span><b>{{ finance.summary.paid_rate === null ? '-' : finance.summary.paid_rate + '%' }}</b></div>
        </div>
        <div v-if="!finance.rows.length" class="ml-empty">还没有账单</div>
        <table v-else class="ml-table">
          <thead><tr><th>账单号</th><th>订单</th><th>币种</th><th class="num">原币</th><th class="num">折人民币</th><th class="num">已收</th><th class="num">未收</th><th>到期</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="b in finance.rows" :key="b.id" :class="{ 'ml-overdue': b.overdue }">
              <td>{{ b.bill_no }}</td>
              <td>{{ b.order_no || '-' }}</td>
              <td>{{ b.currency }}</td>
              <td class="num">{{ money(b.amount_orig) }}</td>
              <td class="num">{{ money(b.amount) }}</td>
              <td class="num">{{ money(b.paid_amount) }}</td>
              <td class="num strong">{{ money(b.open_amount) }}</td>
              <td>{{ b.due_date || '-' }}<span v-if="b.overdue" class="ml-pill r">逾期</span></td>
              <td><span class="ml-status" :class="b.status === 'paid' ? 'o-closed' : 'o-production'">{{ b.status_label }}</span></td>
            </tr>
          </tbody>
        </table>

        <!-- 对账资料：只显示公司已授权的文件 -->
        <div class="ml-block" style="margin-top: 16px">
          <div class="ml-block-title">对账资料下载</div>
          <div class="ml-muted" style="margin-bottom: 8px">
            这里只有公司<b>已授权</b>给你的对账单文件。文件是发布当时的定版，后续账务变动不追溯 ——
            你手上那份纸和我们系统里的数永远一致。
          </div>
          <div v-if="!statements.length" class="ml-empty">暂无已授权的对账文件</div>
          <table v-else class="ml-table">
            <thead>
              <tr><th>文件号</th><th>期间</th><th>版本</th><th class="num">本期开票</th><th class="num">本期收款</th><th class="num">期末结欠</th><th>授权日</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="s in statements" :key="s.id">
                <td>{{ s.file_no }}</td>
                <td>{{ s.period_from }} ~ {{ s.period_to }}</td>
                <td>v{{ s.version_no }}</td>
                <td class="num">{{ money(s.amount_invoiced) }}</td>
                <td class="num">{{ money(s.amount_paid) }}</td>
                <td class="num strong">{{ money(s.amount_closing) }}</td>
                <td>{{ (s.granted_at || '').slice(0, 10) }}</td>
                <td><button class="ml-btn primary" @click="dlStatement(s)">下载</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ============ 成员与授权（主账号） ============ -->
      <section v-else-if="tab === 'members'">
        <div class="ml-msg-head">
          <span class="ml-muted">你们组织可分配的权限上限：</span>
          <span v-for="l in members.limit_labels" :key="l" class="ml-pill">{{ l }}</span>
        </div>
        <div class="ml-hint">主账号只能在业务员批准的权限上限内开子账号；不同的人用不同账号，不要共用主账号密码。</div>

        <div class="ml-block">
          <div class="ml-block-title">开子账号</div>
          <div class="ml-form-row">
            <input class="ml-input" v-model="newMember.username" placeholder="登录账号（≥4 位）" />
            <input class="ml-input" v-model="newMember.password" placeholder="初始密码（≥6 位）" />
            <input class="ml-input" v-model="newMember.name" placeholder="姓名" />
            <select class="ml-input" v-model="newMember.role">
              <option value="purchase">采购</option>
              <option value="orders">订单</option>
              <option value="finance">财务</option>
              <option value="member">其他</option>
            </select>
            <button class="ml-btn primary" @click="createMember">开通</button>
          </div>
          <div class="ml-perm-row">
            <span class="ml-muted">权限：</span>
            <label v-for="(label, key) in members.perm_dict" :key="key" class="ml-chk" :class="{ off: !members.limit.includes(key) }">
              <input type="checkbox" :value="key" v-model="newMember.perms" :disabled="!members.limit.includes(key)" />
              {{ label }}
            </label>
          </div>
        </div>

        <table class="ml-table">
          <thead><tr><th>姓名</th><th>登录账号</th><th>角色</th><th>权限</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="m in members.rows" :key="m.id">
              <td>{{ m.name }}<span v-if="m.is_self" class="ml-pill">我</span></td>
              <td>{{ m.username }}</td>
              <td>{{ m.role_label }}</td>
              <td class="ml-perms">{{ (m.perm_labels || []).join('、') }}</td>
              <td><span class="ml-status" :class="m.status === 'active' ? 'o-closed' : 'o-cancelled'">{{ m.status === 'active' ? '启用' : '已停用' }}</span></td>
              <td>{{ m.last_login_at ? $fmt(m.last_login_at) : '-' }}</td>
              <td class="ml-ops">
                <template v-if="m.role !== 'owner'">
                  <button class="ml-link" @click="editPerms(m)">改权限</button>
                  <button class="ml-link" @click="toggleMember(m)">{{ m.status === 'active' ? '停用' : '启用' }}</button>
                  <button class="ml-link" @click="resetPwd(m)">重置密码</button>
                </template>
                <span v-else class="ml-muted">主账号变更需业务员核验</span>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="ml-block">
          <div class="ml-block-title">授权审计（只读留痕）</div>
          <div v-if="!audits.length" class="ml-muted">还没有记录</div>
          <div v-for="a in audits" :key="a.id" class="ml-audit-row">
            <span class="ml-pill">{{ a.action_label }}</span>
            <b>{{ a.username || '-' }}</b>
            <span class="ml-muted">{{ a.scope_label }} · {{ a.operator }}</span>
            <span class="ml-muted">{{ $fmt(a.created_at) }}</span>
          </div>
        </div>
      </section>
    </main>

    <!-- 选品车浮动条 -->
    <div v-if="cart.length && tab !== 'inquiries'" class="ml-cartbar">
      <span>已选 <strong>{{ cart.length }}</strong> 款 · 合计 <strong>${{ money(cartTotal) }}</strong></span>
      <button class="ml-btn ghost" @click="cart = []; saveCart()">清空</button>
      <button class="ml-btn primary" @click="openCart">去提交询价</button>
    </div>

    <!-- 商品详情 -->
    <div v-if="detail" class="ml-mask" @click.self="detail = null">
      <div class="ml-modal">
        <button class="ml-x" @click="detail = null">×</button>
        <div class="ml-modal-cover" :style="detail.cover_image ? { backgroundImage: 'url(' + detail.cover_image + ')' } : {}">
          <span v-if="!detail.cover_image" class="ml-cover-ph">{{ (detail.name_cn || '款').slice(0, 2) }}</span>
        </div>
        <h3>{{ detail.name_cn }}</h3>
        <div class="ml-muted">{{ detail.style_no }} · {{ detail.category_label }} · 交期约 {{ detail.lead_days }} 天</div>
        <p class="ml-desc">{{ detail.description || '暂无描述' }}</p>

        <table v-if="detail.tiers && detail.tiers.length" class="ml-table">
          <thead><tr><th>数量区间</th><th>单价 USD</th></tr></thead>
          <tbody>
            <tr v-for="(t, i) in detail.tiers" :key="i">
              <td>{{ t.min_qty }}{{ t.max_qty ? '-' + t.max_qty : '+' }} 件</td>
              <td>${{ money(t.price_usd) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="ml-buy">
          <div>
            <div class="ml-price-big">${{ money(detail.price_usd) }}</div>
            <div class="ml-muted">起订 {{ detail.moq }} 件{{ detail.sellable !== null ? ' · 现货 ' + detail.sellable : '' }}</div>
          </div>
          <div class="ml-qty">
            <button @click="qty = Math.max(detail.moq, qty - detail.moq)">−</button>
            <input v-model.number="qty" type="number" :min="detail.moq" />
            <button @click="qty = qty + detail.moq">＋</button>
          </div>
        </div>
        <div class="ml-modal-acts">
          <button class="ml-btn ghost" @click="toggleFav(detail)">{{ detail.favorite ? '★ 已收藏' : '☆ 收藏' }}</button>
          <button class="ml-btn primary" @click="addToCart">加入选品车</button>
        </div>
      </div>
    </div>

    <!-- 提交询价 -->
    <div v-if="cartOpen" class="ml-mask" @click.self="cartOpen = false">
      <div class="ml-modal">
        <button class="ml-x" @click="cartOpen = false">×</button>
        <h3>提交选品询价</h3>
        <table class="ml-table">
          <thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in cart" :key="c.id">
              <td>{{ c.name_cn }}<div class="ml-muted">{{ c.style_no }}</div></td>
              <td class="num">
                <input class="ml-num" type="number" v-model.number="c.qty" :min="c.moq" />
              </td>
              <td class="num">${{ money(c.price_usd) }}</td>
              <td class="num">${{ money((c.qty || 0) * (c.price_usd || 0)) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="ml-total">合计 <strong>${{ money(cartTotal) }}</strong>（{{ cartQty }} 件）</div>
        <label class="ml-label">联系人 / 联系方式</label>
        <input class="ml-input wide" v-model="form.contact" placeholder="如：Tom 13800000000" />
        <label class="ml-label">需求说明</label>
        <textarea class="ml-input wide" v-model="form.remark" rows="3" placeholder="颜色、尺码、到货时间、贸易条款等"></textarea>
        <p v-if="formMsg" class="ml-err">{{ formMsg }}</p>
        <div class="ml-modal-acts">
          <button class="ml-btn" @click="cartOpen = false">再想想</button>
          <button class="ml-btn primary" :disabled="submitting" @click="submitInquiry">
            {{ submitting ? '提交中…' : '提交询价' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 询价详情 -->
    <div v-if="inqDetail" class="ml-mask" @click.self="inqDetail = null">
      <div class="ml-modal">
        <button class="ml-x" @click="inqDetail = null">×</button>
        <h3>{{ inqDetail.inquiry_no }}
          <span class="ml-status" :class="'s-' + inqDetail.status">{{ inqDetail.status_label }}</span>
        </h3>
        <div class="ml-muted">{{ $fmt(inqDetail.created_at) }} ·
          {{ inqDetail.total_qty }} 件 · ${{ money(inqDetail.total_usd) }}</div>
        <table class="ml-table">
          <thead><tr><th>商品</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
          <tbody>
            <tr v-for="it in inqDetail.items" :key="it.id">
              <td>{{ it.name }}<div class="ml-muted">{{ it.style_no || '-' }}</div></td>
              <td class="num">{{ it.qty }}</td>
              <td class="num">${{ money(it.price_usd) }}</td>
              <td class="num">${{ money(it.amount_usd) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="inqDetail.remark" class="ml-note"><strong>我的需求：</strong>{{ inqDetail.remark }}</div>
        <div v-if="inqDetail.sales_remark" class="ml-note"><strong>业务回复：</strong>{{ inqDetail.sales_remark }}</div>
        <div v-if="inqDetail.order_id" class="ml-note ok">已生成订单，可在「我的订单」查看进度。</div>
        <div class="ml-modal-acts">
          <button v-if="['submitted', 'quoted'].includes(inqDetail.status)" class="ml-btn" @click="cancelInquiry(inqDetail)">取消询价</button>
          <button v-if="inqDetail.status === 'quoted'" class="ml-btn primary" @click="confirmInquiry(inqDetail)">确认报价</button>
        </div>
      </div>
    </div>

    <!-- 订单详情 -->
    <div v-if="orderDetail" class="ml-mask" @click.self="orderDetail = null">
      <div class="ml-modal">
        <button class="ml-x" @click="orderDetail = null">×</button>
        <h3>{{ orderDetail.order_no }}
          <span class="ml-status" :class="'o-' + orderDetail.status">{{ orderDetail.status_label }}</span>
        </h3>
        <div class="ml-muted">{{ orderDetail.style_name || '-' }} · 交期 {{ orderDetail.delivery_date || '待定' }}
          <template v-if="orderDetail.amount_visible"> · ${{ money(orderDetail.total_usd) }}（≈¥{{ money(orderDetail.total_amount) }}）</template>
          <template v-else> · 金额不可见（当前账号没有「看对账与账单」权限）</template>
        </div>
        <!-- 生产进度：只显示业务已发布的快照；未发布时明说，不留空白让客户猜 -->
        <div class="ml-pg" v-if="orderProgress && orderProgress.published">
          <div class="ml-pg-head">
            <b>生产进度</b>
            <span class="ml-muted">{{ orderProgress.route_label }} · 第 {{ orderProgress.version_no }} 版 · 更新于 {{ $fmt(orderProgress.published_at) }}</span>
            <span v-if="orderProgress.completed" class="ml-done-tag ml-done-lg">已完工，可安排发货</span>
          </div>
          <div class="ml-steps">
            <div v-for="s in orderProgress.stages" :key="s.key" class="ml-step" :class="s.status">
              <span class="ml-step-dot"></span>
              <div>
                <div class="ml-step-lb">{{ s.label }}</div>
                <div class="ml-muted">{{ s.status_label }}<template v-if="s.done_at"> · {{ s.done_at }}</template></div>
              </div>
            </div>
          </div>
          <div class="ml-muted ml-pg-note" v-if="orderProgress.note">{{ orderProgress.note }}</div>
          <div class="ml-muted ml-pg-note" v-if="orderProgress.plan_finish">预计完成：{{ orderProgress.plan_finish }}</div>
        </div>
        <div class="ml-note" v-else-if="orderProgress && orderProgress.published === false">
          该订单还没有对外发布生产进度，如需了解请联系业务员
        </div>

        <div class="ml-timeline">
          <div v-for="(t, i) in orderDetail.timeline" :key="i" class="ml-tl-item">
            <span class="ml-tl-dot"></span>
            <span class="ml-tl-label">{{ t.label }}</span>
            <span class="ml-muted">{{ $fmt(t.created_at) }}</span>
          </div>
        </div>
        <table class="ml-table">
          <thead><tr><th>产品</th><th>颜色</th><th>尺码</th><th class="num">数量</th><th v-if="orderDetail.amount_visible" class="num">单价</th></tr></thead>
          <tbody>
            <tr v-for="(it, i) in orderDetail.items" :key="i">
              <td>{{ it.product_name }}<div class="ml-muted">{{ it.style_no || '-' }}</div></td>
              <td>{{ it.color || '-' }}</td>
              <td>{{ it.size || '-' }}</td>
              <td class="num">{{ it.size_qty || it.qty }}</td>
              <td v-if="orderDetail.amount_visible" class="num">${{ money(it.usd_price) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { mallApi as api, clearMallAuth, getMallUser, downloadStatement } from '../../api/mall';

const router = useRouter();
// 标签按权限点显示（服务端同样校验，前端只是不给看不到的入口）
const ALL_TABS = [
  { key: 'products', label: '商品', perm: 'catalog.view' },
  { key: 'favorites', label: '收藏', perm: 'catalog.view' },
  { key: 'inquiries', label: '我的询价', perm: 'inquiry.create' },
  { key: 'orders', label: '我的订单', perm: 'order.view' },
  { key: 'after', label: '售后', perm: 'order.view' },
  { key: 'confirm', label: '待确认', perm: 'order.confirm' },
  { key: 'finance', label: '对账', perm: 'finance.view' },
  { key: 'members', label: '成员', perm: 'member.manage' },
  { key: 'messages', label: '消息', perm: null }
];
const perms = computed(() => (info.account && info.account.perms) || []);
const tabs = computed(() => ALL_TABS.filter((t) => !t.perm || perms.value.includes(t.perm)));
const amountVisible = computed(() => perms.value.includes('finance.view'));

const tab = ref('products');
const q = ref('');
const category = ref('');
const products = ref([]);
const favorites = ref([]);
const categories = ref([]);
const inquiries = ref([]);
const orders = ref([]);
const messages = ref([]);
const confirmations = reactive({ seals: [], changes: [], deliveries: [], total: 0 });
const badge = reactive({ unread: 0, inquiries: 0, orders: 0, favorites: 0 });
const loading = reactive({ products: false });
const info = reactive({ account: {}, customer: {}, rate: 6.5 });
const account = computed(() => getMallUser() || {});

const detail = ref(null);
const qty = ref(1);
const cart = ref([]);
const cartOpen = ref(false);
const submitting = ref(false);
const formMsg = ref('');
const form = reactive({ contact: '', remark: '' });
const inqDetail = ref(null);
const orderDetail = ref(null);
// 客户看到的进度是业务发布过的快照，不是内部实时数据
const orderProgress = ref(null);
const progressMap = ref({});

// 对账 / 成员
const finance = reactive({ rows: [], summary: {} });
// 对账资料（只有公司已授权的文件出现在这里）
const statements = ref([]);

// 售后
const afterRowList = ref([]);
const afterOptions = ref([]);
const afterReasons = ref([]);
const afterResolutions = ref([]);
const afterForm = reactive({
  open: false, order_id: null, order_item_id: null, reason_code: 'quality',
  resolution: 'return', qty: '', amount_claim: '', reason: '', photos: []
});
const currentItems = computed(() => {
  const o = afterOptions.value.find((x) => x.id === afterForm.order_id);
  return o ? o.items : [];
});
const currentItem = computed(() => currentItems.value.find((x) => x.id === afterForm.order_item_id) || null);
// 这三个原因不给照片，业务没法向工厂举证
const needPhoto = computed(() => ['quality', 'wrong_item', 'damaged'].includes(afterForm.reason_code));

const members = reactive({ rows: [], limit: [], limit_labels: [], perm_dict: {}, role_presets: {} });
const audits = ref([]);
const newMember = reactive({ username: '', password: '', name: '', role: 'member', perms: [] });

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cartTotal = computed(() => cart.value.reduce((s, c) => s + (Number(c.qty) || 0) * (Number(c.price_usd) || 0), 0));
const cartQty = computed(() => cart.value.reduce((s, c) => s + (Number(c.qty) || 0), 0));
const typeLabel = (t) => ({ order: '订单', promo: '活动', arrival: '到货', system: '系统' }[t] || '通知');

function switchTab(k) { tab.value = k; loadTab(); }

async function loadProducts() {
  loading.products = true;
  try {
    products.value = await api.products({ q: q.value, category: category.value });
  } catch (e) { alert(e.message); } finally { loading.products = false; }
}
function pickCategory(c) { category.value = c; loadProducts(); }

async function loadTab() {
  try {
    if (tab.value === 'products') await loadProducts();
    else if (tab.value === 'favorites') favorites.value = await api.favorites();
    else if (tab.value === 'inquiries') inquiries.value = await api.inquiries();
    else if (tab.value === 'orders') {
      const d = await api.orders();
      orders.value = Array.isArray(d) ? d : (d.rows || []);
      // 进度只拿「已发布」的那些：没发布过的订单不会出现在这里，列表上就不显示进度条
      try {
        const p = await api.progress();
        const map = {};
        (p.rows || []).forEach((x) => { map[x.order_id] = x; });
        progressMap.value = map;
      } catch (e) { progressMap.value = {}; }
    }
    else if (tab.value === 'confirm') Object.assign(confirmations, await api.confirmations());
    else if (tab.value === 'finance') {
      Object.assign(finance, await api.finance());
      // 对账文件单独一次请求：就算文件拿不到，账单也不能跟着空白
      try { statements.value = (await api.statements()).rows || []; } catch (e) { statements.value = []; }
    }
    else if (tab.value === 'after') await loadAfter();
    else if (tab.value === 'members') await loadMembers();
    else messages.value = await api.messages();
    await loadBadge();
  } catch (e) { alert(e.message); }
}
/* ---------------- 售后 ---------------- */
async function loadAfter() {
  try {
    afterRowList.value = (await api.afterSales()).rows || [];
  } catch (e) { afterRowList.value = []; }
}

async function openAfterForm() {
  afterForm.open = true;
  if (!afterOptions.value.length) {
    try {
      const d = await api.afterSaleOptions();
      afterOptions.value = d.orders || [];
      afterReasons.value = d.reasons || [];
      afterResolutions.value = d.resolutions || [];
    } catch (e) { alert(e.message); }
  }
}

// 图片转 dataURL 再提交：客户侧没有独立上传通道，服务端会落盘并记路径
function onAfterPhotos(ev) {
  const files = Array.from(ev.target.files || []);
  files.forEach((f) => {
    if (afterForm.photos.length >= 6) return;
    if (!/^image\//.test(f.type)) { alert(`${f.name} 不是图片`); return; }
    if (f.size > 3.5 * 1024 * 1024) { alert(`${f.name} 超过 3.5MB，请压缩后再传`); return; }
    const rd = new FileReader();
    rd.onload = () => afterForm.photos.push({ dataUrl: rd.result, filename: f.name });
    rd.readAsDataURL(f);
  });
  ev.target.value = '';
}

async function submitAfter() {
  try {
    const r = await api.submitAfterSale({
      order_id: afterForm.order_id,
      order_item_id: afterForm.order_item_id,
      qty: Number(afterForm.qty),
      amount_claim: Number(afterForm.amount_claim || 0),
      reason_code: afterForm.reason_code,
      resolution: afterForm.resolution,
      reason: afterForm.reason,
      photos: afterForm.photos
    });
    alert(r.note);
    afterForm.open = false;
    Object.assign(afterForm, {
      open: false, order_id: null, order_item_id: null, reason_code: 'quality',
      resolution: 'return', qty: '', amount_claim: '', reason: '', photos: []
    });
    await loadAfter();
  } catch (e) { alert(e.message); }
}

async function cancelAfter(r) {
  if (!confirm(`确定撤销 ${r.ticket_no}？业务已经看到的记录会保留。`)) return;
  try {
    await api.cancelAfterSale(r.id);
    await loadAfter();
  } catch (e) { alert(e.message); }
}

async function openAfterDetail(id) {
  try {
    const d = await api.afterSaleDetail(id);
    const tr = d.tracks || {};
    const lines = [
      `${d.ticket_no}　${d.status_label}`,
      `订单 ${d.order_no} · ${d.style_no} × ${d.qty}`,
      `${d.reason_label} → ${d.resolution_label}`,
      `客户描述：${d.reason}`,
      '',
      `退款：${d.refund_status_label}${d.refund_amount ? `（${d.refund_amount} ${d.currency}，${d.refund_method || ''}）` : ''}`,
      `实物实收：${tr.receipt ? tr.receipt.label : '不涉及'}`,
      `质量检验：${tr.inspect ? tr.inspect.label : '不涉及'}`,
      `再上架：${tr.restock ? tr.restock.label : '不涉及'}`
    ];
    if (d.conclusion) lines.push('', `处理结论：${d.conclusion}`);
    if (d.reject_reason) lines.push('', `驳回原因：${d.reject_reason}`);
    alert(lines.join('\n'));
  } catch (e) { alert(e.message); }
}

async function dlStatement(s) {
  try {
    await downloadStatement(s.id);
  } catch (e) { alert(e.message); }
}

async function loadBadge() {
  try { Object.assign(badge, await api.summary()); } catch (e) { /* ignore */ }
}

async function openProduct(p) {
  try {
    detail.value = await api.product(p.id);
    qty.value = detail.value.moq;
  } catch (e) { alert(e.message); }
}

async function toggleFav(p) {
  try {
    const r = await api.toggleFavorite(p.id);
    p.favorite = r.favorite;
    if (detail.value && detail.value.id === p.id) detail.value.favorite = r.favorite;
    if (tab.value === 'favorites') favorites.value = await api.favorites();
    await loadBadge();
  } catch (e) { alert(e.message); }
}

function saveCart() {
  localStorage.setItem('mall_cart', JSON.stringify(cart.value));
}
function addToCart() {
  if (!detail.value) return;
  const exist = cart.value.find((c) => c.id === detail.value.id);
  if (exist) exist.qty = Number(exist.qty) + Number(qty.value);
  else cart.value.push({
    id: detail.value.id, name_cn: detail.value.name_cn, style_no: detail.value.style_no,
    moq: detail.value.moq, price_usd: detail.value.price_usd, qty: Number(qty.value)
  });
  saveCart();
  detail.value = null;
}
function openCart() { formMsg.value = ''; cartOpen.value = true; }

async function submitInquiry() {
  formMsg.value = '';
  const items = cart.value.filter((c) => Number(c.qty) > 0);
  if (!items.length) { formMsg.value = '请填写数量'; return; }
  submitting.value = true;
  try {
    const r = await api.createInquiry({
      contact: form.contact || null,
      remark: form.remark || null,
      items: items.map((c) => ({ mall_product_id: c.id, qty: Number(c.qty), remark: null }))
    });
    cart.value = [];
    saveCart();
    cartOpen.value = false;
    form.remark = '';
    inqDetail.value = r;
    tab.value = 'inquiries';
    await loadTab();
    if (inqDetail.value) inqDetail.value = await api.inquiry(r.id);
  } catch (e) {
    formMsg.value = e.message;
  } finally {
    submitting.value = false;
  }
}

async function openInquiry(row) {
  try { inqDetail.value = await api.inquiry(row.id); } catch (e) { alert(e.message); }
}
async function openOrder(row) {
  try {
    orderDetail.value = await api.order(row.id);
    // 进度单独取：没发布的订单返回 {published:false}，页面上说明「暂未发布」而不是空白
    try { orderProgress.value = await api.orderProgress(row.id); } catch (e) { orderProgress.value = null; }
  } catch (e) { alert(e.message); }
}
async function confirmInquiry(row) {
  if (!confirm(`确认 ${row.inquiry_no} 的报价 $${money(row.total_usd)}？`)) return;
  try {
    inqDetail.value = await api.confirmInquiry(row.id);
    await loadTab();
  } catch (e) { alert(e.message); }
}
async function cancelInquiry(row) {
  if (!confirm(`取消询价单 ${row.inquiry_no}？`)) return;
  try {
    inqDetail.value = await api.cancelInquiry(row.id);
    await loadTab();
  } catch (e) { alert(e.message); }
}
async function readMsg(m) {
  if (m.read_at) return;
  try { await api.readMessage(m.id); m.read_at = new Date().toISOString(); await loadBadge(); } catch (e) { /* ignore */ }
}
async function actSeal(x, accepted) {
  const comment = prompt(accepted ? '确认意见（可留空）' : '请填写修改意见');
  if (comment === null) return;
  try {
    await api.confirmSeal(x.id, { accepted, comment });
    Object.assign(confirmations, await api.confirmations());
    await loadBadge();
    alert(accepted ? '已确认，我们会按此版本安排大货' : '已提交修改意见，业务会联系您');
  } catch (e) { alert(e.message); }
}

async function actChange(x, accepted) {
  const comment = prompt(accepted ? '确认意见（可留空）' : '不接受的原因');
  if (comment === null) return;
  try {
    await api.confirmChange(x.id, { accepted, comment });
    Object.assign(confirmations, await api.confirmations());
    await loadBadge();
    alert(accepted ? '已同意，生产工位签收后执行' : '已反馈不接受，业务会与您沟通');
  } catch (e) { alert(e.message); }
}

async function actDelivery(x, accepted) {
  const comment = prompt(accepted ? '确认意见（可留空）' : '不接受的原因');
  if (comment === null) return;
  try {
    await api.confirmDelivery(x.id, { accepted, comment });
    Object.assign(confirmations, await api.confirmations());
    await loadBadge();
    alert(accepted ? '已确认新交期' : '已反馈不接受，业务会与您沟通');
  } catch (e) { alert(e.message); }
}

async function readAll() {
  try { await api.readAll(); messages.value = await api.messages(); await loadBadge(); } catch (e) { alert(e.message); }
}

async function loadMembers() {
  const d = await api.members();
  members.rows = d.rows || [];
  members.limit = d.limit || [];
  members.limit_labels = d.limit_labels || [];
  members.perm_dict = d.perm_dict || {};
  members.role_presets = d.role_presets || {};
  audits.value = await api.audits();
  if (!newMember.perms.length) newMember.perms = (members.role_presets[newMember.role] || []).filter((x) => members.limit.includes(x));
}

async function createMember() {
  if (!newMember.username || !newMember.password) return alert('请填登录账号和初始密码');
  try {
    const r = await api.createMember({ ...newMember });
    alert(r.notice || '已开通');
    newMember.username = ''; newMember.password = ''; newMember.name = ''; newMember.perms = [];
    await loadMembers();
  } catch (e) { alert(e.message); }
}

async function editPerms(m) {
  const avail = Object.entries(members.perm_dict).map(([k, v]) => `${k}=${v}`).join('\n');
  const cur = prompt(`改「${m.name}」的权限（逗号分隔权限点，只能在上限内）\n\n${avail}\n\n权限上限：${members.limit.join(',')}`, (m.perms || []).join(','));
  if (cur === null) return;
  const perms = String(cur).split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const r = await api.updateMember(m.id, { perms, note: '主账号调整权限' });
    alert(r.notice || '已保存');
    await loadMembers();
  } catch (e) { alert(e.message); }
}

async function toggleMember(m) {
  const next = m.status === 'active' ? 'disabled' : 'active';
  if (next === 'disabled' && !confirm(`停用「${m.name}」？停用后他下一次请求就会被踢下线`)) return;
  try {
    const r = await api.updateMember(m.id, { status: next });
    alert(r.notice || '已保存');
    await loadMembers();
  } catch (e) { alert(e.message); }
}

async function resetPwd(m) {
  if (!confirm(`重置「${m.name}」的密码？会生成一次性新密码`)) return;
  try {
    const r = await api.resetMemberPwd(m.id, {});
    alert(`新密码：${r.password}\n${r.notice}`);
    await loadMembers();
  } catch (e) { alert(e.message); }
}

async function changePwd() {
  const oldPwd = prompt('原密码：');
  if (oldPwd === null) return;
  const newPwd = prompt('新密码（至少 6 位）：');
  if (newPwd === null) return;
  try {
    const r = await api.changePwd({ old_password: oldPwd, new_password: newPwd });
    alert(r.notice || '密码已更新');
  } catch (e) { alert(e.message); }
}

function logout() {
  clearMallAuth();
  router.push('/mall/login');
}

onMounted(async () => {
  try {
    const me = await api.me();
    Object.assign(info, me);
  } catch (e) {
    router.push('/mall/login');
    return;
  }
  try { cart.value = JSON.parse(localStorage.getItem('mall_cart') || '[]'); } catch (e) { cart.value = []; }
  try { categories.value = await api.categories(); } catch (e) { /* ignore */ }
  await loadTab();
});
</script>

<style scoped>
.ml-shell { min-height: 100vh; background: #f5f7fb; color: #1e2a3a; padding-bottom: 90px; }
.ml-head {
  background: linear-gradient(90deg, #12365f, #1f5fae); color: #fff;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 18px; flex-wrap: wrap;
}
.ml-brand { display: flex; align-items: center; gap: 10px; }
.ml-logo {
  width: 34px; height: 34px; border-radius: 10px; background: rgba(255, 255, 255, 0.18);
  display: flex; align-items: center; justify-content: center; font-weight: 800;
}
.ml-co { font-size: 15px; font-weight: 700; }
.ml-co-en { font-size: 9.5px; letter-spacing: 1.4px; opacity: 0.75; }
.ml-user { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
.ml-cust { opacity: 0.9; }
.ml-acc { background: rgba(255, 255, 255, 0.16); padding: 2px 9px; border-radius: 20px; }
.ml-link { background: none; border: none; color: #cfe0f8; cursor: pointer; font-size: 12.5px; }

.ml-tabs { display: flex; gap: 4px; padding: 10px 14px 0; background: #fff; border-bottom: 1px solid #e8eef7; overflow-x: auto; }
.ml-tabs button {
  border: none; background: none; padding: 9px 14px; font-size: 13.5px; color: #5b6b80;
  border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; position: relative;
}
.ml-tabs button.on { color: #1f5fae; border-bottom-color: #1f5fae; font-weight: 700; }
.ml-badge {
  display: inline-block; min-width: 16px; height: 16px; line-height: 16px; padding: 0 4px;
  background: #e5484d; color: #fff; border-radius: 10px; font-size: 10px; margin-left: 4px; text-align: center;
}
.ml-dot { display: inline-block; width: 6px; height: 6px; background: #e5484d; border-radius: 50%; margin-left: 4px; vertical-align: middle; }

.ml-main { padding: 14px; max-width: 1180px; margin: 0 auto; }
.ml-filter { display: flex; gap: 8px; margin-bottom: 10px; }
.ml-input {
  flex: 1; padding: 9px 12px; border: 1px solid #d8e1ee; border-radius: 9px; font-size: 13.5px; background: #fff;
}
.ml-input.wide { width: 100%; margin-bottom: 10px; box-sizing: border-box; }
.ml-btn {
  padding: 9px 14px; border: 1px solid #d8e1ee; background: #fff; color: #1f5fae;
  border-radius: 9px; font-size: 13px; cursor: pointer;
}
.ml-btn.primary { background: #1f5fae; border-color: #1f5fae; color: #fff; font-weight: 600; }
.ml-btn.ghost { background: #f1f5fb; }
.ml-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.ml-chip { border: 1px solid #dfe7f2; background: #fff; color: #4a5b70; border-radius: 20px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.ml-chip.on { background: #eaf2ff; border-color: #1f5fae; color: #1f5fae; font-weight: 600; }

.ml-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.ml-card { background: #fff; border: 1px solid #e8eef7; border-radius: 12px; overflow: hidden; cursor: pointer; }
.ml-cover {
  height: 132px; background: #eef3fa center/cover no-repeat; display: flex; align-items: center; justify-content: center; position: relative;
}
.ml-cover-ph { font-size: 22px; font-weight: 800; color: #b9c9dd; }
.ml-tag { position: absolute; left: 8px; top: 8px; background: #ff7a45; color: #fff; font-size: 10.5px; padding: 2px 7px; border-radius: 20px; }
.ml-card-body { padding: 10px 12px 12px; }
.ml-card-title { font-size: 13.5px; font-weight: 700; color: #16233b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ml-card-sub { font-size: 11.5px; color: #8a9ab0; margin: 3px 0 6px; }
.ml-card-price { display: flex; align-items: baseline; gap: 6px; }
.ml-card-price strong { font-size: 16px; color: #d4380d; }
.ml-moq { font-size: 11px; color: #8a9ab0; }
.ml-card-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.ml-stock { font-size: 11px; color: #15803d; background: #e9f8ee; padding: 1px 7px; border-radius: 20px; }
.ml-muted { font-size: 11.5px; color: #8a9ab0; }
.ml-fav { border: none; background: none; font-size: 17px; color: #c9d5e5; cursor: pointer; line-height: 1; }
.ml-fav.on { color: #f5a623; }

.ml-list { display: flex; flex-direction: column; gap: 8px; }
.ml-row {
  background: #fff; border: 1px solid #e8eef7; border-radius: 11px; padding: 12px 14px;
  display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer;
}
.ml-row-right { text-align: right; }
.ml-amount { display: block; font-weight: 700; color: #16233b; font-size: 14px; }
.ml-status { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 20px; background: #eef1f6; color: #5b6b80; }
.ml-status.s-quoted, .ml-status.o-production { background: #eaf2ff; color: #1f5fae; }
.ml-status.s-confirmed, .ml-status.o-shipped { background: #e9f8ee; color: #15803d; }
.ml-status.s-converted, .ml-status.o-closed { background: #e9f8ee; color: #15803d; }
.ml-status.s-cancelled, .ml-status.o-cancelled { background: #fdeceb; color: #c0392b; }

.ml-msg-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.ml-msg { background: #fff; border: 1px solid #e8eef7; border-radius: 11px; padding: 11px 14px; cursor: pointer; }
.ml-msg.unread { border-left: 3px solid #1f5fae; }
.ml-msg-title { font-size: 13.5px; font-weight: 700; color: #16233b; display: flex; gap: 8px; align-items: center; }
.ml-msg-body { font-size: 12.5px; color: #4a5b70; margin: 5px 0 4px; line-height: 1.6; }
.ml-type { font-size: 10.5px; padding: 1px 7px; border-radius: 20px; background: #eef1f6; color: #5b6b80; font-weight: 600; }
.ml-type.t-order { background: #eaf2ff; color: #1f5fae; }
.ml-type.t-promo { background: #fff2e8; color: #a8541a; }
.ml-type.t-arrival { background: #e9f8ee; color: #15803d; }

.ml-empty { text-align: center; color: #9aa8bc; font-size: 13px; padding: 46px 0; }

.ml-cartbar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
  background: #fff; border-top: 1px solid #e2e9f3; padding: 10px 16px;
  display: flex; align-items: center; justify-content: flex-end; gap: 10px; font-size: 13px;
  box-shadow: 0 -6px 20px rgba(20, 40, 80, 0.07);
}
.ml-cartbar span { margin-right: auto; color: #4a5b70; }

.ml-mask { position: fixed; inset: 0; background: rgba(14, 25, 40, 0.5); z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding: 4vh 12px; overflow: auto; }
.ml-modal { background: #fff; border-radius: 14px; width: 560px; max-width: 100%; padding: 18px 18px 20px; position: relative; }
.ml-x { position: absolute; right: 12px; top: 10px; border: none; background: none; font-size: 22px; color: #9aa8bc; cursor: pointer; }
.ml-modal h3 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ml-modal-cover { height: 150px; border-radius: 11px; background: #eef3fa center/cover no-repeat; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; }
.ml-desc { font-size: 12.5px; color: #4a5b70; line-height: 1.7; margin: 8px 0; }
.ml-block { margin: 14px 0 4px; }
.ml-block-title { font-size: 13px; font-weight: 700; color: #16233b; margin: 0 0 8px 2px; }
.ml-card-row {
  display: flex; gap: 10px; justify-content: space-between; align-items: flex-start;
  background: #fff; border: 1px solid #e8eef7; border-radius: 12px;
  padding: 12px 14px; margin-bottom: 8px;
}
.ml-card-main { font-size: 13px; color: #16233b; line-height: 1.6; min-width: 0; }
.ml-card-act { display: flex; flex-direction: column; gap: 6px; flex: none; }
.ml-card-act .ml-btn { white-space: nowrap; }
@media (max-width: 480px) {
  .ml-card-row { flex-direction: column; }
  .ml-card-act { flex-direction: row; width: 100%; }
  .ml-card-act .ml-btn { flex: 1; }
}
.ml-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12.5px; }
.ml-table th, .ml-table td { border-bottom: 1px solid #eef2f8; padding: 7px 6px; text-align: left; }
.ml-table th { color: #7c8ba1; font-weight: 600; font-size: 11.5px; background: #f8fafd; }
.ml-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.ml-buy { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.ml-price-big { font-size: 20px; font-weight: 800; color: #d4380d; }
.ml-qty { display: flex; align-items: center; gap: 4px; }
.ml-qty button { width: 32px; height: 32px; border: 1px solid #d8e1ee; background: #f7fafd; border-radius: 8px; font-size: 16px; cursor: pointer; }
.ml-qty input { width: 68px; text-align: center; padding: 7px 4px; border: 1px solid #d8e1ee; border-radius: 8px; }
.ml-num { width: 70px; text-align: right; padding: 5px 6px; border: 1px solid #d8e1ee; border-radius: 7px; }
.ml-modal-acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
.ml-total { text-align: right; font-size: 13.5px; margin-top: 6px; }
.ml-label { display: block; font-size: 12px; color: #5b6b80; margin: 8px 0 4px; font-weight: 600; }
.ml-note { background: #f8fafd; border: 1px solid #eef2f8; border-radius: 9px; padding: 9px 11px; font-size: 12.5px; margin-top: 8px; line-height: 1.6; }
.ml-note.ok { background: #f1fbf4; border-color: #cdebd8; color: #15803d; }
.ml-err { color: #c0392b; font-size: 12.5px; margin: 6px 0 0; }
.ml-timeline { margin: 10px 0; }
.ml-tl-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 3px 0; }
.ml-tl-dot { width: 8px; height: 8px; border-radius: 50%; background: #1f5fae; flex: none; }
.ml-tl-label { font-weight: 600; color: #16233b; min-width: 84px; }

@media (max-width: 640px) {
  .ml-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .ml-cover { height: 108px; }
  .ml-main { padding: 10px; }
  .ml-co { font-size: 13.5px; }
  .ml-co-en { display: none; }
  .ml-modal { padding: 14px; }
}

/* ===== 成员与对账（TS-N21-03/04） ===== */
.ml-role { font-size: 11.5px; color: #5b6474; background: #eef2f8; border-radius: 10px; padding: 2px 8px; white-space: nowrap; }
.ml-user { flex-wrap: nowrap; gap: 8px; }
.ml-cust { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ml-acc { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ml-hidden-amt { font-size: 12px; color: #9aa4b5; }
.ml-sum-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin: 10px 0 14px; }
.ml-sum-row > div { background: #f8fafc; border: 1px solid #e8edf4; border-radius: 10px; padding: 10px 12px; }
.ml-sum-row span { display: block; font-size: 11.5px; color: #7c8798; }
.ml-sum-row b { font-size: 16px; color: #16233b; }
.ml-sum-row b.g { color: #16a34a; }
.ml-sum-row b.r { color: #d92d45; }
.ml-overdue { background: #fff7f8; }
.ml-pill { display: inline-block; position: static; background: #eef2f8; color: #5b6474; border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 6px; }
.ml-pill.r { background: #fdecee; color: #d92d45; }
.ml-hint { font-size: 12px; color: #7c8798; background: #f8fafc; border: 1px solid #e8edf4; border-radius: 8px; padding: 8px 10px; margin: 8px 0 12px; line-height: 1.6; }
.ml-form-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ml-input { border: 1px solid #dfe6ef; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; min-width: 130px; background: #fff; }
.ml-perm-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; font-size: 12.5px; }
.ml-chk { display: inline-flex; align-items: center; gap: 4px; color: #33415a; cursor: pointer; }
.ml-chk.off { color: #b6bfcc; cursor: not-allowed; }
.ml-perms { font-size: 12px; color: #5b6474; max-width: 260px; }
.ml-ops { white-space: nowrap; }
.ml-audit-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed #eef2f7; color: #33415a; }
.ml-audit-row:last-child { border-bottom: none; }
/* ---- 生产进度（客户侧只看已发布快照） ---- */
.ml-mini { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11.5px; flex-wrap: wrap; }
.ml-mini-bar { display: inline-block; width: 66px; height: 5px; border-radius: 3px; background: #e8edf6; overflow: hidden; }
.ml-mini-bar i { display: block; height: 100%; background: #2563eb; border-radius: 3px; }
.ml-done-tag { font-size: 10.5px; color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 4px; padding: 1px 5px; }
.ml-done-lg { font-size: 12px; padding: 2px 8px; }
.ml-pg { border: 1px solid #e6ebf3; border-radius: 10px; padding: 11px 13px; margin: 10px 0; background: #fcfeff; }
.ml-pg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 9px; font-size: 13px; }
.ml-pg-head .ml-muted { font-size: 11.5px; }
.ml-steps { display: flex; gap: 10px; flex-wrap: wrap; }
/* 阶段条：已完成实心、进行中描边加粗、未开始灰色，一眼能数出做到第几步 */
.ml-step { display: flex; gap: 6px; align-items: flex-start; min-width: 92px; flex: 1 1 92px; }
.ml-step-dot { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; margin-top: 4px; flex: 0 0 auto; }
.ml-step-lb { font-size: 12px; color: #16233b; }
.ml-step.done .ml-step-dot { background: #10b981; }
.ml-step.doing .ml-step-dot { background: #fff; border: 2px solid #2563eb; box-shadow: 0 0 0 2px #dbeafe; }
.ml-step.pending .ml-step-lb { color: #94a3b8; }
.ml-pg-note { margin-top: 8px; font-size: 11.5px; line-height: 1.6; }

/* ---- 售后 ---- */
.ml-after-form { border: 1px solid #dbeafe; background: #f8fbff; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
.ml-after-form .ml-form-row { margin-bottom: 8px; }
.ml-after-form label { font-size: 12px; color: #667085; flex: 0 0 auto; min-width: 48px; }
.ml-after-form .ml-input { min-width: 0; }
.ml-form-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.ml-after-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; background: #fff; }
.ml-after-row:hover { border-color: #d7e3f4; background: #fbfdff; }
.ml-after-main { min-width: 0; font-size: 12.5px; line-height: 1.65; }
.ml-after-main > div:first-child { margin-bottom: 2px; }
.ml-after-act { flex: 0 0 auto; }
</style>
