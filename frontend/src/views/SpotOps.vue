<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>现货经营与备货</h2>
        <p class="sub">
          <b>可售不是库存</b>：可售 = 已上架合格 − 有效现货占用；<b>只有带预计到货时间的在途/在产才算可承诺</b>，
          在产但不知道什么时候到的不虚增覆盖天数。销速按自然日摊，<b>样本不足（窗口内有出库天数不够）只观察、不给补货量</b>；
          覆盖天数 = 可承诺量 ÷ 日均销。补货量按「目标覆盖 + 安全天数」倒算并取整到批量；
          <b>下单日过了就标「来不及」，但系统不会自动插单、不会自动改交期</b>。
          停补只看三件事（覆盖过长 / 库龄过老 / 零出库），<b>毛利不参与补货决策</b>。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ ov.as_of || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openGen">生成提案</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>现货在库 / 可售</span>
        <strong>{{ num(ov.stat && ov.stat.on_hand) }}</strong>
        <small>可售 {{ num(ov.stat && ov.stat.sellable) }} · 占用 {{ num(ov.stat && ov.stat.held) }}（{{ num(ov.stat && ov.stat.held_pct) }}%）</small>
      </div>
      <div class="stat">
        <span>日均销（{{ ov.window_days || 60 }} 天口径）</span>
        <strong>{{ num(ov.stat && ov.stat.daily_out) }}</strong>
        <small>在途 {{ num(ov.stat && ov.stat.in_transit) }} · 在产 {{ num(ov.stat && ov.stat.in_production) }}</small>
      </div>
      <div class="stat">
        <span>整体覆盖天数</span>
        <strong>{{ (ov.stat && ov.stat.cover_days) === null ? '—' : (ov.stat && ov.stat.cover_days) }}</strong>
        <small>可承诺量 ÷ 日均销</small>
      </div>
      <div class="stat st-warn">
        <span>需要补货</span>
        <strong>{{ (ov.stat && ov.stat.replenish_style) || 0 }}</strong>
        <small>款（含断码 {{ (ov.stat && ov.stat.broken_style) || 0 }} 款）</small>
      </div>
      <div class="stat" :class="ov.stat && ov.stat.stop_style ? 'st-bad' : ''">
        <span>建议停补</span>
        <strong>{{ (ov.stat && ov.stat.stop_style) || 0 }}</strong>
        <small>款（覆盖/库龄/零出库）</small>
      </div>
      <div class="stat">
        <span>无 ETA 的供给</span>
        <strong>{{ (ov.stat && ov.stat.no_eta_cnt) || 0 }}</strong>
        <small>处（算不可承诺）</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'overview' }" @click="go('overview')">现货经营总览</button>
        <button :class="{ on: tab === 'proposal' }" @click="go('proposal')">补货与停补提案
          <span v-if="pendingCount" class="tab-dot">{{ pendingCount }}</span>
        </button>
        <button :class="{ on: tab === 'policy' }" @click="go('policy')">备货策略</button>
      </div>
    </div>

    <!-- ==================== 一、现货经营总览 ==================== -->
    <div v-if="tab === 'overview'" class="block">
      <div class="hint-bar">
        按款看：卖多快、还能卖多久、会不会断、哪个码断了。<b>覆盖天数</b>条越长越安全（红色 = 周期内就断）；<b>「—」表示样本不足</b>，
        不是 0。点款号可以下钻到每个颜色的每个码。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="win" @change="loadOverview">
          <option :value="30">销速口径：近 30 天</option>
          <option :value="60">销速口径：近 60 天</option>
          <option :value="90">销速口径：近 90 天</option>
        </select>
        <select v-model="filterKind" @change="noop">
          <option value="">全部款</option>
          <option value="replenish">只看要补货</option>
          <option value="stop">只看要停补</option>
          <option value="broken">只看断码</option>
        </select>
        <div class="spacer"></div>
        <span class="muted tiny">{{ shownStyles.length }} 款 / {{ ov.stat && ov.stat.sku_count }} SKU</span>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>款号 / 款名</th><th>建议</th><th class="num">在库</th><th class="num">可售</th>
              <th class="num">在途</th><th class="num">在产</th><th class="num">日均销</th>
              <th style="width:150px">覆盖天数</th><th class="num">库龄</th><th class="num">售罄率</th>
              <th>断码</th><th></th></tr>
          </thead>
          <tbody>
            <template v-for="s in shownStyles" :key="s.style_no">
              <tr :class="{ 'row-warn': s.has_replenish, 'row-bad': s.has_stop }">
                <td>
                  <a class="lnk mono" @click="drill(s.style_no)">{{ s.style_no }}</a>
                  <div class="tiny muted">{{ s.product_name || '—' }}<span v-if="s.category"> · {{ s.category }}</span></div>
                </td>
                <td><span class="tag" :class="tagOfSuggest(s.suggestion)">{{ s.suggestion }}</span></td>
                <td class="num tiny">{{ num(s.on_hand) }}</td>
                <td class="num tiny">{{ num(s.sellable) }}</td>
                <td class="num tiny">{{ num(s.in_transit) }}</td>
                <td class="num tiny">{{ num(s.in_production) }}<span v-if="s.no_eta_cnt" class="red" :title="`有 ${s.no_eta_cnt} 处供给没有预计到货时间，未计入覆盖天数`">*</span></td>
                <td class="num tiny">{{ num(s.daily_out) }}</td>
                <td>
                  <div class="cov">
                    <div class="cov-bar"><i :style="{ width: covWidth(s.cover_days), background: covColor(s.cover_days) }"></i></div>
                    <span class="tiny" :class="{ muted: s.cover_days === null }">{{ s.cover_days === null ? '—' : s.cover_days + ' 天' }}</span>
                  </div>
                </td>
                <td class="num tiny" :class="{ red: s.age_days > 90 }">{{ s.age_days }} 天</td>
                <td class="num tiny">{{ num(s.sell_through) }}%</td>
                <td class="tiny">
                  <span v-if="s.broken_sizes.length" class="tag red">{{ s.broken_sizes.join('/') }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td><button class="btn btn-ghost btn-sm" @click="drill(s.style_no)">明细</button></td>
              </tr>
            </template>
            <tr v-if="!shownStyles.length"><td colspan="12" class="empty-cell">没有匹配的款</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 二、补货与停补提案 ==================== -->
    <div v-if="tab === 'proposal'" class="block">
      <div class="hint-bar">
        一次生成 = 一个批次，历史批次只读。批准只记录<b>批准数量</b>，不会自动下采购单或生产单；
        <b>驳回必须写原因</b>；批准数量不能超过建议量（要加量请改策略或重新生成）。
      </div>

      <div class="toolbar" style="margin-bottom: 10px">
        <select v-model="runId" @change="loadRun">
          <option value="">选择批次</option>
          <option v-for="r in runs" :key="r.id" :value="r.id">
            {{ r.run_no }}（{{ statusLabel(r.status) }}｜{{ r.as_of_date }}｜{{ r.line_count }} 条）
          </option>
        </select>
        <div class="spacer"></div>
        <span v-if="run.run" class="muted tiny">
          窗口 {{ run.run.window_days }} 天 · 补货 {{ run.run.replenish_count }} / 停补 {{ run.run.stop_count }} /
          来不及 {{ run.run.urgent_count }} / 样本不足 {{ run.run.sample_short_count }}
        </span>
        <button v-if="canWrite && run.run && run.run.status === 'draft'" class="btn btn-primary btn-sm" @click="doPublish">下发给销售</button>
      </div>

      <div v-if="!run.run" class="empty-box">还没有提案批次。点右上角「生成提案」按当前销速算一批。</div>

      <template v-else>
        <div class="chips">
          <button v-for="c in kindTabs" :key="c.k" class="chip" :class="{ on: kindFilter === c.k }" @click="kindFilter = c.k">
            {{ c.label }} <b>{{ c.count }}</b>
          </button>
        </div>

        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>款 / 色 / 码</th><th>类型</th><th>原因</th><th class="num">可售</th><th class="num">可承诺</th>
                <th class="num">日均</th><th class="num">覆盖</th><th>断货日</th><th class="num">建议量</th>
                <th>建议下单日</th><th>优先级</th><th>状态</th><th v-if="canWrite"></th></tr>
            </thead>
            <tbody>
              <tr v-for="l in shownLines" :key="l.id"
                  :class="{ 'row-bad': l.kind === 'stop', 'row-warn': l.urgent }">
                <td>
                  <div class="mono tiny">{{ l.style_no }}</div>
                  <div class="tiny muted">{{ l.product_name || '' }} · {{ l.color || '—' }} / {{ l.size || '—' }}</div>
                </td>
                <td><span class="tag" :class="l.kind === 'replenish' ? 'blue' : (l.kind === 'stop' ? 'red' : 'gray')">{{ l.kind_label }}</span></td>
                <td class="tiny wrap" style="min-width:280px">
                  <span class="rc">{{ l.reason_label }}</span>
                  <div class="muted">{{ l.reason }}</div>
                </td>
                <td class="num tiny">{{ num(l.sellable) }}</td>
                <td class="num tiny">{{ num(l.qty_available) }}</td>
                <td class="num tiny">{{ num(l.daily_out) }}</td>
                <td class="num tiny" :class="{ muted: l.cover_days === null }">{{ l.cover_days === null ? '—' : num(l.cover_days) }}</td>
                <td class="tiny">{{ l.stockout_date || '—' }}</td>
                <td class="num tiny"><b v-if="l.suggest_qty">{{ num(l.suggest_qty) }}</b><span v-else class="muted">—</span></td>
                <td class="tiny" :class="{ red: l.urgent }">
                  {{ l.suggest_order_date || '—' }}
                  <span v-if="l.urgent" class="tag red">来不及</span>
                </td>
                <td><span class="tag" :class="prioTag(l.priority)">{{ l.priority }}</span></td>
                <td>
                  <span class="tag" :class="statusTag(l.status)">{{ l.status_label }}</span>
                  <div v-if="l.expired" class="tiny red">超过 14 天未决策，销速已变，建议重算</div>
                </td>
                <td v-if="canWrite">
                  <button v-if="l.status === 'pending'" class="btn btn-ghost btn-sm" @click="openDecide(l)">决策</button>
                  <span v-else class="muted tiny">{{ l.decided_by || '—' }}</span>
                </td>
              </tr>
              <tr v-if="!shownLines.length"><td :colspan="canWrite ? 13 : 12" class="empty-cell">这个分组没有建议</td></tr>
            </tbody>
          </table>
        </div>

        <div v-if="approved.run" class="hint-bar" style="margin-top: 12px">
          <b>已批准待下单（{{ approved.run.run_no }}，合计 {{ num(approved.total) }} 件）</b>
          <span class="muted">—— 系统只给清单，下单请到采购 / 生产模块</span>
          <div class="appr">
            <span v-for="a in approved.rows" :key="a.style_no + a.color + a.size" class="appr-item">
              {{ a.style_no }} {{ a.color }}/{{ a.size }} <b>{{ num(a.qty) }}</b>
              <em v-if="a.need_by">（{{ a.need_by }} 前下单）</em>
            </span>
          </div>
        </div>

        <div v-if="run.decisions && run.decisions.length" class="hint-bar" style="margin-top: 10px">
          <b>决策留痕（{{ run.decisions.length }} 条）</b>
          <div v-for="d in run.decisions.slice(0, 8)" :key="d.id" class="tiny" style="margin-top: 3px">
            · {{ String(d.created_at).slice(5, 16).replace('T', ' ') }} {{ actionLabel(d.action) }}
            {{ num(d.qty_before) }} → {{ num(d.qty_after) }}；{{ d.note || '（无备注）' }}（{{ d.operator }}）
          </div>
        </div>
      </template>
    </div>

    <!-- ==================== 三、备货策略 ==================== -->
    <div v-if="tab === 'policy'" class="block">
      <div class="hint-bar">
        策略按 <b>按款 → 类目 → 全局 → 内置默认</b> 逐级回退；没配就用默认值并标注。
        <b>目标覆盖</b>决定补多少，<b>生产周期</b>决定最迟什么时候下单，<b>停补阈值</b>决定什么时候喊停。
        改了策略要<b>重新生成提案</b>才生效——历史批次不追溯。
      </div>
      <div class="toolbar" style="margin-bottom: 10px">
        <div class="spacer"></div>
        <button v-if="canPolicy" class="btn btn-primary btn-sm" @click="openPolicy()">＋ 新增策略</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>范围</th><th>款号 / 类目</th><th class="num">目标覆盖</th><th class="num">安全天数</th>
              <th class="num">生产周期</th><th class="num">起订量</th><th class="num">批量</th>
              <th class="num">停补覆盖</th><th class="num">停补库龄</th><th class="num">零出库</th><th class="num">样本天数</th>
              <th>状态</th><th v-if="canPolicy"></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in policies" :key="p.id">
              <td><span class="tag" :class="p.scope === 'global' ? 'purple' : (p.scope === 'style' ? 'blue' : 'gray')">{{ scopeLabel(p.scope) }}</span></td>
              <td class="mono tiny">{{ p.scope === 'style' ? p.style_no : (p.scope === 'category' ? p.category : '全部') }}</td>
              <td class="num tiny">{{ num(p.target_cover_days) }}</td>
              <td class="num tiny">{{ num(p.safety_days) }}</td>
              <td class="num tiny">{{ num(p.lead_time_days) }}</td>
              <td class="num tiny">{{ num(p.min_order_qty) }}</td>
              <td class="num tiny">{{ num(p.lot_size) }}</td>
              <td class="num tiny">{{ num(p.stop_cover_days) }}</td>
              <td class="num tiny">{{ num(p.stop_age_days) }}</td>
              <td class="num tiny">{{ p.dead_days }} 天</td>
              <td class="num tiny">{{ p.min_sample_days }} 天</td>
              <td><span class="tag" :class="p.status === 'active' ? 'green' : 'gray'">{{ p.status === 'active' ? '启用' : '停用' }}</span></td>
              <td v-if="canPolicy">
                <button class="btn btn-ghost btn-sm" @click="openPolicy(p)">编辑</button>
                <button v-if="p.scope !== 'global'" class="btn btn-ghost btn-sm" @click="delPolicy(p)">删除</button>
              </td>
            </tr>
            <tr v-if="!policies.length"><td :colspan="canPolicy ? 13 : 12" class="empty-cell">还没有策略，全部用内置默认</td></tr>
          </tbody>
        </table>
      </div>
      <div class="hint-bar" style="margin-top: 10px">
        <b>内置默认（没有任何配置时使用）</b>：目标覆盖 {{ (dict.defaults && dict.defaults.target_cover_days) || 60 }} 天 ·
        安全 {{ (dict.defaults && dict.defaults.safety_days) || 15 }} 天 ·
        周期 {{ (dict.defaults && dict.defaults.lead_time_days) || 45 }} 天 ·
        起订 {{ (dict.defaults && dict.defaults.min_order_qty) || 100 }} 件 ·
        批量 {{ (dict.defaults && dict.defaults.lot_size) || 50 }} 件 ·
        停补：覆盖 > {{ (dict.defaults && dict.defaults.stop_cover_days) || 120 }} 天 / 库龄 > {{ (dict.defaults && dict.defaults.stop_age_days) || 90 }} 天 / {{ (dict.defaults && dict.defaults.dead_days) || 30 }} 天零出库
      </div>
    </div>

    <!-- ==================== 下钻：SKU 明细 ==================== -->
    <div v-if="drillOpen" class="modal-mask" @click.self="drillOpen = false">
      <div class="modal xxwide">
        <div class="modal-head">
          <h3>{{ drillStyle }} 逐码明细</h3>
          <button class="x" @click="drillOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr><th>颜色 / 码</th><th>建议</th><th class="num">在库</th><th class="num">占用</th><th class="num">可售</th>
                  <th class="num">在途</th><th class="num">在产</th><th class="num">日均</th><th class="num">覆盖</th>
                  <th class="num">库龄</th><th class="num">售罄率</th><th>原因</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in drillRows" :key="r.key" :class="{ 'row-warn': r.kind === 'replenish', 'row-bad': r.kind === 'stop' }">
                  <td class="tiny">{{ r.color || '—' }} / {{ r.size || '—' }}<div class="mono muted">{{ r.sku }}</div></td>
                  <td><span class="tag" :class="r.kind === 'replenish' ? 'blue' : (r.kind === 'stop' ? 'red' : 'gray')">{{ kindLabel(r.kind) }}</span></td>
                  <td class="num tiny">{{ num(r.on_hand) }}</td>
                  <td class="num tiny">{{ num(r.held) }}</td>
                  <td class="num tiny">{{ num(r.sellable) }}</td>
                  <td class="num tiny">{{ num(r.in_transit) }}</td>
                  <td class="num tiny">{{ num(r.in_production) }}</td>
                  <td class="num tiny">{{ num(r.daily_out) }}</td>
                  <td class="num tiny" :class="{ muted: r.cover_days === null }">{{ r.cover_days === null ? '—' : num(r.cover_days) }}</td>
                  <td class="num tiny">{{ r.age_days }}</td>
                  <td class="num tiny">{{ num(r.sell_through) }}%</td>
                  <td class="tiny wrap" style="min-width:240px">
                    <span class="rc">{{ r.reason_label }}</span>
                    <div class="muted">{{ r.reason }}</div>
                  </td>
                </tr>
                <tr v-if="!drillRows.length"><td colspan="12" class="empty-cell">没有明细</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="drillOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- ==================== 决策弹窗 ==================== -->
    <div v-if="decide.open" class="modal-mask" @click.self="decide.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>决策：{{ decide.row && decide.row.style_no }} {{ decide.row && decide.row.color }}/{{ decide.row && decide.row.size }}</h3>
          <button class="x" @click="decide.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="hint-bar">
            <b>{{ decide.row && decide.row.reason_label }}</b>：{{ decide.row && decide.row.reason }}
          </div>
          <div class="fgrid" style="margin-top: 10px">
            <label><span>决策</span>
              <select v-model="decide.action">
                <option value="approve" :disabled="!decide.row || decide.row.kind !== 'replenish'">批准（按下单量）</option>
                <option value="reject">驳回（不补 / 不停）</option>
                <option value="defer">暂缓（再观察）</option>
              </select>
            </label>
            <label v-if="decide.action === 'approve'"><span>批准数量（≤ 建议 {{ decide.row && num(decide.row.suggest_qty) }}）</span>
              <input v-model.number="decide.qty" type="number" min="1" step="1" />
            </label>
            <label class="full"><span>备注{{ decide.action === 'approve' ? '（可选）' : '（必填）' }}</span>
              <textarea v-model="decide.note" rows="2" placeholder="例如：这码确实要断，按建议量下单；或：这款刚谈下批发客户，先不停"></textarea>
            </label>
          </div>
          <div class="tiny muted" style="margin-top: 8px">
            系统只记录决策，<b>不会自动下采购单 / 生产单 / 改库存</b>。批准后到「采购管理」或「销售订单」按批准数量下单。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="decide.open = false">取消</button>
          <button class="btn btn-primary" @click="doDecide">确认决策</button>
        </div>
      </div>
    </div>

    <!-- ==================== 生成提案弹窗 ==================== -->
    <div v-if="gen.open" class="modal-mask" @click.self="gen.open = false">
      <div class="modal">
        <div class="modal-head">
          <h3>生成补货 / 停补提案</h3>
          <button class="x" @click="gen.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fgrid">
            <label><span>销速统计窗口</span>
              <select v-model="gen.window_days">
                <option :value="30">近 30 天</option>
                <option :value="60">近 60 天</option>
                <option :value="90">近 90 天</option>
              </select>
            </label>
            <label><span>备注</span><input v-model="gen.note" placeholder="例如：本季度第一次补货评审" /></label>
          </div>
          <div class="tiny muted" style="margin-top: 8px">
            会按当前库存、在途/在产（只算有 ETA 的）、近 N 天出库重新算一遍；历史批次不受影响。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="gen.open = false">取消</button>
          <button class="btn btn-primary" :disabled="gen.loading" @click="doGenerate">生成</button>
        </div>
      </div>
    </div>

    <!-- ==================== 策略弹窗 ==================== -->
    <div v-if="policy.open" class="modal-mask" @click.self="policy.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ policy.id ? '编辑备货策略' : '新增备货策略' }}</h3>
          <button class="x" @click="policy.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fgrid">
            <label><span>范围</span>
              <select v-model="policy.scope" :disabled="!!policy.id">
                <option value="global">全局（兜底）</option>
                <option value="category">按类目</option>
                <option value="style">按款</option>
              </select>
            </label>
            <label v-if="policy.scope === 'style'"><span>款号</span><input v-model="policy.style_no" :disabled="!!policy.id" placeholder="如 SXO-05" /></label>
            <label v-if="policy.scope === 'category'"><span>类目</span><input v-model="policy.category" :disabled="!!policy.id" placeholder="如 outerwear_cat" /></label>
            <label><span>目标覆盖天数</span><input v-model.number="policy.target_cover_days" type="number" min="1" /></label>
            <label><span>安全天数</span><input v-model.number="policy.safety_days" type="number" min="0" /></label>
            <label><span>生产周期（下单到可售）</span><input v-model.number="policy.lead_time_days" type="number" min="1" /></label>
            <label><span>最小起订量</span><input v-model.number="policy.min_order_qty" type="number" min="0" /></label>
            <label><span>补货批量倍数</span><input v-model.number="policy.lot_size" type="number" min="1" /></label>
            <label><span>停补：覆盖超过（天）</span><input v-model.number="policy.stop_cover_days" type="number" min="0" /></label>
            <label><span>停补：库龄超过（天）</span><input v-model.number="policy.stop_age_days" type="number" min="0" /></label>
            <label><span>停补：零出库天数</span><input v-model.number="policy.dead_days" type="number" min="0" /></label>
            <label><span>最小样本天数</span><input v-model.number="policy.min_sample_days" type="number" min="1" /></label>
            <label><span>状态</span>
              <select v-model="policy.status">
                <option value="active">启用</option>
                <option value="disabled">停用</option>
              </select>
            </label>
            <label class="full"><span>备注</span><input v-model="policy.note" /></label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="policy.open = false">取消</button>
          <button class="btn btn-primary" @click="doSavePolicy">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('overview');
const dict = ref({});
const ov = ref({ stat: {}, styles: [] });
const win = ref(60);
const filterKind = ref('');
const runs = ref([]);
const runId = ref('');
const run = ref({});
const kindFilter = ref('');
const approved = ref({ rows: [] });
const policies = ref([]);
const drillOpen = ref(false);
const drillStyle = ref('');
const drillRows = ref([]);

const gen = reactive({ open: false, window_days: 60, note: '', loading: false });
const decide = reactive({ open: false, row: null, action: 'approve', qty: 0, note: '' });
const policy = reactive({
  open: false, id: null, scope: 'global', style_no: '', category: '',
  target_cover_days: 60, safety_days: 15, lead_time_days: 45, min_order_qty: 100, lot_size: 50,
  stop_cover_days: 120, stop_age_days: 90, dead_days: 30, min_sample_days: 5, status: 'active', note: ''
});

const canWrite = computed(() => can('spotops.write'));
const canPolicy = computed(() => can('spotops.policy'));

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const statusLabel = (s) => ({ draft: '草稿', published: '已下发', archived: '已归档' }[s] || s);
const statusTag = (s) => ({ pending: 'orange', approved: 'green', rejected: 'gray', deferred: 'blue' }[s] || 'gray');
const prioTag = (p) => (p === 'P1' ? 'red' : (p === 'P2' ? 'orange' : 'gray'));
const scopeLabel = (s) => ({ global: '全局', category: '类目', style: '按款' }[s] || s);
const kindLabel = (k) => ({ replenish: '补货', stop: '停补', watch: '观察' }[k] || k);
const actionLabel = (a) => ({ approve: '批准', reject: '驳回', defer: '暂缓' }[a] || a);
const tagOfSuggest = (s) => ({
  补货: 'blue', '补货 + 停补': 'red', 停补: 'red', 观察: 'orange', 正常: 'green', 数据异常: 'purple'
}[s] || 'gray');

const shownStyles = computed(() => {
  const list = ov.value.styles || [];
  if (!filterKind.value) return list;
  if (filterKind.value === 'replenish') return list.filter((s) => s.has_replenish);
  if (filterKind.value === 'stop') return list.filter((s) => s.has_stop);
  return list.filter((s) => s.broken_sizes && s.broken_sizes.length);
});

const pendingCount = computed(() => (run.value.lines || []).filter((l) => l.status === 'pending').length);

const kindTabs = computed(() => {
  const lines = run.value.lines || [];
  const counts = { '': lines.length, replenish: 0, stop: 0, watch: 0 };
  lines.forEach((l) => { counts[l.kind] = (counts[l.kind] || 0) + 1; });
  return [
    { k: '', label: '全部', count: counts[''] },
    { k: 'replenish', label: '补货', count: counts.replenish },
    { k: 'stop', label: '停补', count: counts.stop },
    { k: 'watch', label: '观察', count: counts.watch }
  ];
});

const shownLines = computed(() => {
  const lines = run.value.lines || [];
  return kindFilter.value ? lines.filter((l) => l.kind === kindFilter.value) : lines;
});

const covWidth = (d) => {
  if (d === null || d === undefined) return '6%';
  return Math.min(100, Math.max(4, (Number(d) / 120) * 100)) + '%';
};
const covColor = (d) => {
  if (d === null || d === undefined) return '#cbd5e1';
  const v = Number(d);
  if (v <= 20) return '#d92d45';
  if (v <= 45) return '#d97706';
  if (v <= 90) return '#16a34a';
  return '#94a3b8';
};

const noop = () => {};

function go(t) {
  tab.value = t;
  if (t === 'proposal' && !runs.value.length) loadRuns();
  if (t === 'policy') loadPolicies();
}

async function reloadAll() {
  loadDict();
  loadOverview();
  loadRuns();
  loadPolicies();
}

async function loadDict() {
  try { dict.value = await api.spotopsDict(); } catch (e) { /* ignore */ }
}
async function loadOverview() {
  try { ov.value = await api.spotopsOverview({ warehouse: 'us', window_days: win.value }); } catch (e) { ov.value = { stat: {}, styles: [] }; }
}
async function loadRuns() {
  try {
    runs.value = await api.spotopsRuns({ warehouse: 'us' });
    if (!runId.value && runs.value.length) {
      const cur = runs.value.find((r) => r.is_current) || runs.value[0];
      runId.value = cur.id;
      await loadRun();
    }
  } catch (e) { runs.value = []; }
}
async function loadRun() {
  if (!runId.value) { run.value = {}; return; }
  try {
    run.value = await api.spotopsRun(runId.value);
    approved.value = await api.spotopsApproved({ warehouse: 'us' });
  } catch (e) { run.value = {}; }
}
async function loadPolicies() {
  try { policies.value = (await api.spotopsPolicies({ warehouse: 'us' })).rows; } catch (e) { policies.value = []; }
}

async function drill(styleNo) {
  drillStyle.value = styleNo;
  drillOpen.value = true;
  try {
    const d = await api.spotopsSkus({ warehouse: 'us', window_days: win.value, style_no: styleNo });
    drillRows.value = d.rows || [];
  } catch (e) { drillRows.value = []; }
}

function openGen() {
  gen.open = true;
  gen.window_days = win.value;
  gen.note = '';
}
async function doGenerate() {
  gen.loading = true;
  try {
    const r = await api.createSpotopsRun({ warehouse: 'us', window_days: gen.window_days, note: gen.note });
    gen.open = false;
    await loadRuns();
    runId.value = r.run_id;
    await loadRun();
    await loadOverview();
    tab.value = 'proposal';
  } catch (e) {
    alert(e.message);
  } finally {
    gen.loading = false;
  }
}

async function doPublish() {
  const note = prompt('把这一批提案下发给销售？可写一句说明', '本批补货/停补建议已评审');
  if (note === null) return;
  try {
    await api.publishSpotopsRun(runId.value, { note });
    await loadRuns();
    await loadRun();
    alert('已下发（只记录状态，不会自动下单）');
  } catch (e) {
    alert(e.message);
  }
}

function openDecide(l) {
  decide.open = true;
  decide.row = l;
  decide.action = l.kind === 'replenish' ? 'approve' : 'reject';
  decide.qty = Number(l.suggest_qty) || 0;
  decide.note = '';
}
async function doDecide() {
  const body = { action: decide.action, note: decide.note };
  if (decide.action === 'approve') body.qty = decide.qty;
  try {
    const r = await api.decideSpotopsLine(decide.row.id, body);
    decide.open = false;
    await loadRun();
    await loadOverview();
    if (r.note) console.log(r.note);
  } catch (e) {
    alert(e.message);
  }
}

function openPolicy(p) {
  policy.open = true;
  policy.id = p ? p.id : null;
  policy.scope = p ? p.scope : 'global';
  policy.style_no = p ? p.style_no : '';
  policy.category = p ? p.category : '';
  policy.target_cover_days = p ? p.target_cover_days : 60;
  policy.safety_days = p ? p.safety_days : 15;
  policy.lead_time_days = p ? p.lead_time_days : 45;
  policy.min_order_qty = p ? p.min_order_qty : 100;
  policy.lot_size = p ? p.lot_size : 50;
  policy.stop_cover_days = p ? p.stop_cover_days : 120;
  policy.stop_age_days = p ? p.stop_age_days : 90;
  policy.dead_days = p ? p.dead_days : 30;
  policy.min_sample_days = p ? p.min_sample_days : 5;
  policy.status = p ? p.status : 'active';
  policy.note = p ? (p.note || '') : '';
}
async function doSavePolicy() {
  try {
    await api.saveSpotopsPolicy({ ...policy, warehouse: 'us' });
    policy.open = false;
    await loadPolicies();
  } catch (e) {
    alert(e.message);
  }
}
async function delPolicy(p) {
  if (!confirm(`删除 ${scopeLabel(p.scope)} 策略？删除后会回退到上一级配置。`)) return;
  try {
    await api.deleteSpotopsPolicy(p.id);
    await loadPolicies();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  await loadDict();
  await loadOverview();
  await loadRuns();
  await loadPolicies();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.empty-box { background: #fff; border: 1px dashed #dfe5ef; border-radius: 12px; padding: 34px; text-align: center; color: #8a94a6; font-size: 13px; }
table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }

.cov { display: flex; align-items: center; gap: 8px; }
.cov-bar { flex: 1; height: 6px; background: #eef1f6; border-radius: 4px; overflow: hidden; min-width: 60px; }
.cov-bar i { display: block; height: 100%; border-radius: 4px; }
.rc { display: inline-block; padding: 1px 7px; border-radius: 20px; background: #eef1f6; color: #5b6474; font-size: 11px; margin-right: 6px; }

.chips { display: flex; gap: 8px; margin-bottom: 10px; }
.chip { padding: 6px 14px; border: 1px solid #e2e8f2; background: #fff; border-radius: 20px; font-size: 12.5px; color: #5b6474; cursor: pointer; }
.chip.on { background: #eaf1ff; border-color: #cfe0ff; color: #2563eb; font-weight: 700; }
.chip b { margin-left: 4px; color: #16305f; }

.appr { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.appr-item { background: #fff; border: 1px solid #e6ebf3; border-radius: 8px; padding: 5px 10px; font-size: 12px; }
.appr-item em { font-style: normal; color: #8a94a6; }

.tab-dot { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 5px; border-radius: 10px; background: #d92d45; color: #fff; font-size: 10.5px; line-height: 16px; text-align: center; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chips { flex-wrap: wrap; }
}
</style>
