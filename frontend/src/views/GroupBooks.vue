<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>多主体与集团合并</h2>
        <p class="sub">
          每家主体独立记账、独立关账；内部往来要两侧对上；合并报表 = 各家加总 − 内部抵消
        </p>
      </div>
      <div class="head-ops">
        <span class="mode-pill">{{ ov.active_count }} 家启用 · {{ ov.scope_count }} 家纳入合并</span>
      </div>
    </div>

    <!-- 指标 -->
    <div class="stat-row">
      <div class="stat">
        <span>主体总数</span><strong>{{ ov.company_count }}</strong>
        <small>{{ typeHint }}</small>
      </div>
      <div class="stat">
        <span>纳入合并</span><strong>{{ ov.scope_count }}</strong>
        <small>启用且标记合并</small>
      </div>
      <div class="stat">
        <span>内部往来单位</span><strong>{{ ov.ic_party_count }}</strong>
        <small>双向登记才能配对</small>
      </div>
      <div class="stat" :class="ov.ic_diff_count ? 'stat-bad' : 'stat-good'">
        <span>内部往来差异</span><strong>{{ ov.ic_diff_count }} 笔</strong>
        <small>{{ ov.ic_diff_count ? (ov.ic_diff_period + ' 差 ¥' + money(ov.ic_diff_amount)) : '最近期间两侧已平' }}</small>
      </div>
      <div class="stat">
        <span>最近合并</span>
        <strong class="con-no">{{ ov.last_consolidation ? ov.last_consolidation.con_no : '—' }}</strong>
        <small>{{ ov.last_consolidation ? ov.last_consolidation.period + ' · ' + ov.last_consolidation.status_label : '还没做过合并' }}</small>
      </div>
      <div class="stat">
        <span>当前期间</span><strong>{{ period.slice(5) }}<i class="unit">月</i></strong>
        <small>{{ period.slice(0, 4) }} 年</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="go(t.k)">
          {{ t.label }}<span v-if="t.dot" class="tab-dot">{{ t.dot }}</span>
        </button>
      </div>
    </div>

    <!-- ==================== 1. 主体与账套 ==================== -->
    <div v-if="tab === 'companies'">
      <p class="hint-bar">
        <b>一家主体 = 一套账。</b>凭证号、会计期间、关账、余额快照都按主体隔离，两家都从「记-202609-0001」起编。
        总部只能有一个；<b>已注销前必须把期间全部关账</b>，否则会留下永远没人管的开账期间。
      </p>

      <div class="co-grid">
        <div v-for="c in companies" :key="c.id" class="co-card" :class="{ 'co-hq': c.type === 'headquarters', 'co-off': c.status !== 'active' }">
          <div class="co-top">
            <div>
              <div class="co-name">{{ c.name }}</div>
              <div class="co-code mono">{{ c.code }}</div>
            </div>
            <span class="pill" :class="c.type === 'headquarters' ? 'p-hq' : c.type === 'subsidiary' ? 'p-sub' : 'p-br'">
              {{ c.type_label }}
            </span>
          </div>
          <div class="co-meta">
            <div><span>本位币</span><b>{{ c.base_currency || 'CNY' }}</b></div>
            <div><span>税号</span><b class="mono tiny">{{ c.tax_no || '—' }}</b></div>
            <div><span>启用期间</span><b>{{ c.open_period || '—' }}</b></div>
            <div><span>合并范围</span><b :class="c.consolidation ? 'amt-green' : 'muted'">{{ c.consolidation_label }}</b></div>
          </div>
          <div class="co-nums">
            <div><b>{{ c.voucher_count }}</b><span>张凭证</span></div>
            <div><b>{{ c.closed_periods }}</b><span>个已关账</span></div>
            <div><b>{{ c.dept_count }}</b><span>个部门</span></div>
            <div><b>{{ c.user_count }}</b><span>个账号</span></div>
          </div>
          <div class="co-foot">
            <span class="pill" :class="c.status === 'active' ? 'p-ok' : 'p-off'">{{ c.status_label }}</span>
            <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openCompany(c)">编辑</button>
          </div>
        </div>

        <button v-if="canWrite" class="co-add" @click="openCompany(null)">
          <span>+</span>
          <small>新增主体</small>
        </button>
      </div>
    </div>

    <!-- ==================== 2. 分部对比 ==================== -->
    <div v-if="tab === 'segments'">
      <div class="seg-head">
        <div class="seg-period">
          <label>期间</label>
          <select v-model="period" @change="loadSegments">
            <option v-for="p in periodOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <span class="hint-inline">金额单位：元。净利率为「净利润 ÷ 收入」，无收入的期间显示 —</span>
      </div>

      <div class="table-wrap">
        <table class="seg-tbl">
          <thead>
            <tr>
              <th style="width: 210px">主体</th>
              <th style="width: 78px">类型</th>
              <th class="num" style="width: 118px">资产</th>
              <th class="num" style="width: 108px">负债</th>
              <th class="num" style="width: 118px">所有者权益</th>
              <th class="num" style="width: 108px">货币资金</th>
              <th class="num" style="width: 108px">收入</th>
              <th class="num" style="width: 108px">净利润</th>
              <th class="num" style="width: 82px">净利率</th>
              <th style="width: 88px">账套状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in segments.rows" :key="r.company_id">
              <td>
                <div class="co-cell">{{ r.name }}</div>
                <div class="mono tiny muted">{{ r.code }}</div>
              </td>
              <td><span class="pill" :class="r.type === 'headquarters' ? 'p-hq' : r.type === 'subsidiary' ? 'p-sub' : 'p-br'">{{ r.type_label }}</span></td>
              <td class="num">{{ money(r.asset) }}</td>
              <td class="num">{{ money(r.liability) }}</td>
              <td class="num">{{ money(r.equity) }}</td>
              <td class="num">{{ money(r.cash) }}</td>
              <td class="num">{{ money(r.income) }}</td>
              <td class="num" :class="r.net > 0 ? 'amt-green' : r.net < 0 ? 'amt-red' : ''">{{ money(r.net) }}</td>
              <td class="num" :class="r.net_margin > 0 ? 'amt-green' : r.net_margin < 0 ? 'amt-red' : 'muted'">
                {{ r.net_margin === null ? '—' : r.net_margin + '%' }}
              </td>
              <td><span class="pill" :class="r.period_status === 'closed' ? 'p-ok' : 'p-wait'">{{ r.period_status_label }}</span></td>
            </tr>
            <tr class="sum-row">
              <td colspan="2">合计</td>
              <td class="num">{{ money(segments.total.asset) }}</td>
              <td class="num">{{ money(segments.total.liability) }}</td>
              <td class="num">{{ money(segments.total.equity) }}</td>
              <td class="num">{{ money(segments.total.cash) }}</td>
              <td class="num">{{ money(segments.total.income) }}</td>
              <td class="num" :class="segments.total.net > 0 ? 'amt-green' : 'amt-red'">{{ money(segments.total.net) }}</td>
              <td class="num"></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="foot-note">合计是<b>简单加总</b>，含内部往来与内部交易，不等于合并数 —— 合并请到「合并报表」页签。</p>
    </div>

    <!-- ==================== 3. 内部往来 ==================== -->
    <div v-if="tab === 'ic'">
      <p class="hint-bar">
        <b>内部往来不平，合并报表就不可信。</b>义乌记「应收美国 80 万」、美国记「应付义乌 75 万」，
        差 5 万说明有一方漏记或多记。合并时按<b>两侧较小值</b>抵消（抵 75 万），剩下 5 万不抹平、单独提示 ——
        这样能看出来，而不是被悄悄抵掉。
      </p>

      <div class="ic-bar">
        <div class="ic-period">
          <label>期间</label>
          <select v-model="icPeriod" @change="loadIc">
            <option v-for="p in periodOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="ic-stat">
          <span>已平 <b class="amt-green">{{ ic.matched }}</b></span>
          <span>有差异 <b class="amt-red">{{ ic.diff }}</b></span>
          <span v-if="ic.ignored">已忽略 <b class="muted">{{ ic.ignored }}</b></span>
          <span v-if="ic.diff_amount">差 <b class="amt-red">¥{{ money(ic.diff_amount) }}</b></span>
        </div>
        <div class="ic-ops">
          <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openParty(null)">登记内部单位</button>
          <button v-if="canWrite" class="btn btn-primary btn-sm" :disabled="busy" @click="doScan">
            {{ busy ? '扫描中…' : '重新配对' }}
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="ic-tbl">
          <thead>
            <tr>
              <th style="width: 196px">债权方（记应收）</th>
              <th style="width: 196px">债务方（记应付）</th>
              <th class="num" style="width: 118px">债权金额</th>
              <th class="num" style="width: 118px">债务金额</th>
              <th class="num" style="width: 108px">差额</th>
              <th style="width: 86px">状态</th>
              <th>说明</th>
              <th style="width: 88px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in ic.rows" :key="l.id" :class="l.status === 'diff' ? 'row-error' : ''">
              <td class="tiny">{{ l.from_company_name }}</td>
              <td class="tiny">{{ l.to_company_name }}</td>
              <td class="num">{{ money(l.from_amount) }}</td>
              <td class="num">{{ money(l.to_amount) }}</td>
              <td class="num" :class="Math.abs(l.diff_amount) > 0.01 ? 'amt-red' : 'amt-green'">
                {{ Math.abs(l.diff_amount) < 0.01 ? '0.00' : money(l.diff_amount) }}
              </td>
              <td><span class="pill" :class="l.status === 'matched' ? 'p-ok' : l.status === 'ignored' ? 'p-off' : 'p-bad'">{{ l.status_label }}</span></td>
              <td class="wrap tiny muted">{{ l.note || '—' }}</td>
              <td class="ops">
                <button v-if="canWrite && l.status === 'diff'" class="btn btn-ghost btn-sm" @click="openIgnore(l)">忽略</button>
                <span v-else class="muted tiny">—</span>
              </td>
            </tr>
            <tr v-if="!ic.rows.length">
              <td colspan="8" class="empty">
                本期没有内部往来记录。先登记「内部往来单位」（本公司的哪个客户其实是集团内哪家公司），再点「重新配对」。
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 内部往来单位 -->
      <div class="block">
        <h4>内部往来单位 <small>双方都要登记，才能配对：A 记「客户是 B」，B 记「供应商是 A」</small></h4>
        <div class="table-wrap">
          <table class="party-tbl">
            <thead>
              <tr>
                <th style="width: 170px">本方主体</th>
                <th style="width: 170px">对方主体</th>
                <th style="width: 84px">往来类型</th>
                <th style="width: 230px">本方单据上的对方名称</th>
                <th style="width: 96px">抵消科目</th>
                <th style="width: 76px">状态</th>
                <th style="width: 76px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in parties" :key="p.id">
                <td class="tiny">{{ p.company_name }}</td>
                <td class="tiny">{{ p.counter_company_name }}</td>
                <td class="tiny">{{ p.kind === 'customer' ? '客户' : p.kind === 'supplier' ? '供应商' : '两者' }}</td>
                <td class="tiny">{{ p.ref_name }}</td>
                <td class="mono tiny">{{ p.offset_account }}</td>
                <td><span class="pill" :class="p.status === 'active' ? 'p-ok' : 'p-off'">{{ p.status === 'active' ? '启用' : '停用' }}</span></td>
                <td class="ops">
                  <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openParty(p)">编辑</button>
                </td>
              </tr>
              <tr v-if="!parties.length">
                <td colspan="7" class="empty">还没登记内部往来单位 —— 不登记的话，系统认不出「这笔交易是卖给集团内公司的」。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 4. 合并报表 ==================== -->
    <div v-if="tab === 'consolidation'">
      <div class="cn-bar">
        <div class="ic-period">
          <label>期间</label>
          <select v-model="conPeriod">
            <option v-for="p in periodOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <span class="hint-inline">合并范围：{{ ov.scope_count }} 家（启用 + 标记纳入合并）</span>
        <button v-if="canWrite" class="btn btn-primary btn-sm" :disabled="busy" @click="doConsolidate">
          {{ busy ? '计算中…' : '生成合并报表' }}
        </button>
      </div>

      <div v-if="cur" class="cn-body">
        <div class="cn-banner" :class="cur.balanced ? 'ok' : 'bad'">
          <div class="cn-banner-l">
            <b>{{ cur.balanced ? '资产 = 负债 + 所有者权益 ✓' : '合并后不平，差 ¥' + money(cur.diff_amount) }}</b>
            <span v-if="cur.ic_diff_cnt" class="cn-warn">
              另有 <b>{{ cur.ic_diff_cnt }}</b> 笔内部往来金额不一致 —— 报表虽然平，但<b>金额是虚的</b>，先去核对再对外报
            </span>
            <span v-else class="cn-ok">内部往来两侧全部对上</span>
          </div>
          <div class="cn-banner-r">
            <span class="pill" :class="cur.status === 'confirmed' ? 'p-ok' : 'p-wait'">{{ cur.status === 'confirmed' ? '已确认' : '草稿' }}</span>
            <span class="mono tiny">{{ cur.con_no }}</span>
          </div>
        </div>

        <!-- 三段：加总 → 抵消 → 合并后 -->
        <div class="cn-flow">
          <div class="cn-step">
            <div class="cn-step-t">① 各主体加总 <small>{{ cur.company_count }} 家</small></div>
            <div class="cn-kv"><span>资产</span><b>{{ money(cur.sum_asset) }}</b></div>
            <div class="cn-kv"><span>负债</span><b>{{ money(cur.sum_liability) }}</b></div>
            <div class="cn-kv"><span>所有者权益</span><b>{{ money(cur.sum_equity) }}</b></div>
            <div class="cn-kv"><span>收入</span><b>{{ money(cur.sum_income) }}</b></div>
            <div class="cn-kv"><span>成本费用</span><b>{{ money(cur.sum_expense) }}</b></div>
          </div>
          <div class="cn-arrow">−</div>
          <div class="cn-step">
            <div class="cn-step-t">② 内部抵消</div>
            <div class="cn-kv"><span>内部往来（资产）</span><b class="amt-orange">{{ money(cur.adj_asset) }}</b></div>
            <div class="cn-kv"><span>内部往来（负债）</span><b class="amt-orange">{{ money(cur.adj_liability) }}</b></div>
            <div class="cn-kv"><span>内部销售收入</span><b class="amt-orange">{{ money(cur.adj_income) }}</b></div>
            <div class="cn-kv"><span>内部采购成本</span><b class="amt-orange">{{ money(cur.adj_expense) }}</b></div>
            <div class="cn-kv muted"><span>取两侧较小值</span><b>不抹平差额</b></div>
          </div>
          <div class="cn-arrow">=</div>
          <div class="cn-step cn-final">
            <div class="cn-step-t">③ 合并数</div>
            <div class="cn-kv"><span>资产合计</span><b>{{ money(cur.asset_total) }}</b></div>
            <div class="cn-kv"><span>负债合计</span><b>{{ money(cur.liability_total) }}</b></div>
            <div class="cn-kv"><span>所有者权益</span><b>{{ money(cur.equity_total) }}</b></div>
            <div class="cn-kv"><span>营业收入</span><b>{{ money(cur.income_total) }}</b></div>
            <div class="cn-kv"><span>净利润</span><b class="amt-green">{{ money(cur.net_profit) }}</b></div>
          </div>
        </div>

        <!-- 抵消分录 -->
        <div class="block">
          <h4>抵消分录 <small>auto = 系统按内部往来映射自动生成；长期投资与未实现利润本版不做自动抵消</small></h4>
          <div class="table-wrap">
            <table class="adj-tbl">
              <thead>
                <tr>
                  <th style="width: 96px">类型</th>
                  <th style="width: 78px">科目</th>
                  <th style="width: 210px">科目名称</th>
                  <th class="num" style="width: 118px">借方</th>
                  <th class="num" style="width: 118px">贷方</th>
                  <th>摘要</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in cur.adjustments" :key="a.id">
                  <td><span class="pill" :class="a.type === 'ic_balance' ? 'p-ic' : 'p-tx'">{{ a.type_label }}</span></td>
                  <td class="mono tiny">{{ a.account_code }}</td>
                  <td class="tiny">{{ a.account_name }}</td>
                  <td class="num">{{ a.debit ? money(a.debit) : '' }}</td>
                  <td class="num">{{ a.credit ? money(a.credit) : '' }}</td>
                  <td class="wrap tiny muted">{{ a.summary }}</td>
                </tr>
                <tr v-if="!cur.adjustments.length">
                  <td colspan="6" class="empty">本期没有需要抵消的内部交易。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="cn-actions" v-if="canWrite">
          <button v-if="cur.status !== 'confirmed'" class="btn btn-primary btn-sm" @click="doConfirmCon">确认合并</button>
          <button v-else class="btn btn-ghost btn-sm" disabled>已确认</button>
          <button v-if="cur.status !== 'confirmed'" class="btn btn-ghost btn-sm" @click="doDeleteCon">删除草稿</button>
          <a class="btn btn-ghost btn-sm" :href="`/api/group/consolidations/${cur.id}/export`" target="_blank" rel="noopener">导出 CSV</a>
          <span class="tiny muted">确认后不可改 —— 对外报出的数字要能追到具体一批</span>
        </div>
      </div>

      <div v-else class="empty-box">
        还没有合并数据。选好期间点「生成合并报表」。
      </div>

      <!-- 历史批次 -->
      <div class="block">
        <h4>合并历史</h4>
        <div class="table-wrap">
          <table class="his-tbl">
            <thead>
              <tr>
                <th style="width: 148px">批次号</th>
                <th style="width: 86px">期间</th>
                <th class="num" style="width: 74px">主体数</th>
                <th class="num" style="width: 120px">合并资产</th>
                <th class="num" style="width: 120px">合并净利润</th>
                <th class="num" style="width: 110px">差异</th>
                <th class="num" style="width: 90px">IC 差异</th>
                <th style="width: 84px">状态</th>
                <th style="width: 130px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in history" :key="h.id" :class="!h.balanced ? 'row-error' : ''">
                <td class="mono tiny">{{ h.con_no }}</td>
                <td class="tiny">{{ h.period }}</td>
                <td class="num">{{ h.company_count }}</td>
                <td class="num">{{ money(h.asset_total) }}</td>
                <td class="num" :class="h.net_profit > 0 ? 'amt-green' : 'amt-red'">{{ money(h.net_profit) }}</td>
                <td class="num" :class="Math.abs(h.diff_amount) > 0.01 ? 'amt-red' : 'muted'">{{ money(h.diff_amount) }}</td>
                <td class="num" :class="h.ic_diff_cnt ? 'amt-orange' : 'muted'">{{ h.ic_diff_cnt }}</td>
                <td><span class="pill" :class="h.status === 'confirmed' ? 'p-ok' : 'p-wait'">{{ h.status_label }}</span></td>
                <td class="ops"><button class="btn btn-ghost btn-sm" @click="openCon(h)">查看</button></td>
              </tr>
              <tr v-if="!history.length">
                <td colspan="9" class="empty">还没有合并记录。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：主体 ==================== -->
    <div v-if="coForm.show" class="modal-mask" @click.self="coForm.show = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ coForm.id ? '编辑主体' : '新增主体' }}</h3>
          <button class="x" @click="coForm.show = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fi" v-if="!coForm.id">
              <label>主体编码 <em>*</em></label>
              <input v-model="coForm.code" placeholder="如 YW-BR，2-16 位大写字母数字" />
            </div>
            <div class="fi">
              <label>主体名称 <em>*</em></label>
              <input v-model="coForm.name" placeholder="如 跳色科技（义乌）分公司" />
            </div>
            <div class="fi">
              <label>简称</label>
              <input v-model="coForm.short_name" placeholder="报表里显示的短名" />
            </div>
            <div class="fi">
              <label>类型</label>
              <select v-model="coForm.type">
                <option value="headquarters">总部</option>
                <option value="branch">分公司</option>
                <option value="subsidiary">子公司</option>
              </select>
            </div>
            <div class="fi">
              <label>税号</label>
              <input v-model="coForm.tax_no" placeholder="统一社会信用代码 / EIN" />
            </div>
            <div class="fi">
              <label>法定代表人</label>
              <input v-model="coForm.legal_person" />
            </div>
            <div class="fi">
              <label>本位币</label>
              <select v-model="coForm.base_currency">
                <option value="CNY">CNY 人民币</option>
                <option value="USD">USD 美元</option>
                <option value="EUR">EUR 欧元</option>
                <option value="HKD">HKD 港币</option>
              </select>
            </div>
            <div class="fi" v-if="!coForm.id">
              <label>账套启用期间</label>
              <input v-model="coForm.open_period" placeholder="YYYY-MM，之前的数据不进账" />
            </div>
            <div class="fi">
              <label>上级主体</label>
              <select v-model="coForm.parent_id">
                <option value="">（无）</option>
                <option v-for="c in companies.filter((x) => !coForm.id || x.id !== coForm.id)" :key="c.id" :value="c.id">
                  {{ c.name }}
                </option>
              </select>
            </div>
            <div class="fi">
              <label>是否纳入合并</label>
              <select v-model="coForm.consolidation">
                <option :value="1">纳入合并</option>
                <option :value="0">不合并（仅投资/参股）</option>
              </select>
            </div>
            <div class="fi" v-if="coForm.id">
              <label>状态</label>
              <select v-model="coForm.status">
                <option value="active">启用</option>
                <option value="closed">已注销（需期间全部关账）</option>
              </select>
            </div>
            <div class="fi">
              <label>电话</label>
              <input v-model="coForm.phone" />
            </div>
            <div class="fi fi-full">
              <label>地址</label>
              <input v-model="coForm.addr" />
            </div>
          </div>
          <p class="tip">
            新建主体后要到「系统设置 → 用户」把账号归到这家主体，否则那边的人看不到这边的账。
            账套启用期间填了会自动建好第一个会计期间。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="coForm.show = false">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="saveCompany">保存</button>
        </div>
      </div>
    </div>

    <!-- ==================== 弹窗：内部往来单位 ==================== -->
    <div v-if="partyForm.show" class="modal-mask" @click.self="partyForm.show = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ partyForm.id ? '编辑内部往来单位' : '登记内部往来单位' }}</h3>
          <button class="x" @click="partyForm.show = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fi">
              <label>本方主体 <em>*</em></label>
              <select v-model="partyForm.company_id" :disabled="!!partyForm.id">
                <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="fi">
              <label>对方主体 <em>*</em></label>
              <select v-model="partyForm.counter_company_id" :disabled="!!partyForm.id">
                <option v-for="c in companies.filter((x) => x.id !== partyForm.company_id)" :key="c.id" :value="c.id">
                  {{ c.name }}
                </option>
              </select>
            </div>
            <div class="fi">
              <label>往来类型</label>
              <select v-model="partyForm.kind">
                <option value="customer">客户（我们卖给它）</option>
                <option value="supplier">供应商（我们向它买）</option>
                <option value="both">两者都有</option>
              </select>
            </div>
            <div class="fi">
              <label>抵消用科目</label>
              <input v-model="partyForm.offset_account" placeholder="1122 应收 / 2202 应付" />
            </div>
            <div class="fi fi-full">
              <label>本方单据上的对方名称 <em>*</em></label>
              <input v-model="partyForm.ref_name" placeholder="必须和发票/凭证上写的对方名称完全一致" />
            </div>
            <div class="fi fi-full">
              <label>备注</label>
              <input v-model="partyForm.note" />
            </div>
          </div>
          <p class="tip">
            <b>要双向登记。</b>义乌要登记「客户 = 美国子公司」，美国也要登记「供应商 = 义乌分公司」，
            系统才配得起对来。名称必须和单据上写的一致 —— 差一个字就认不出来。
          </p>
          <div class="fi" v-if="partyForm.id">
            <label>状态</label>
            <select v-model="partyForm.status">
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="partyForm.show = false">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="saveParty">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('group.write'));

const tabs = computed(() => [
  { k: 'companies', label: '主体与账套' },
  { k: 'segments', label: '分部对比' },
  { k: 'ic', label: '内部往来', dot: ic.value.diff || 0 },
  { k: 'consolidation', label: '合并报表' }
]);
const tab = ref('companies');
const busy = ref(false);

const ov = ref({ company_count: 0, active_count: 0, scope_count: 0, by_type: [], ic_party_count: 0, ic_diff_count: 0, ic_diff_amount: 0, last_consolidation: null });
const companies = ref([]);
const parties = ref([]);
const ic = ref({ rows: [], matched: 0, diff: 0, diff_amount: 0, ignored: 0 });
const segments = ref({ rows: [], total: {} });
const history = ref([]);
const cur = ref(null);

const period = ref('');
const icPeriod = ref('');
const conPeriod = ref('');

const typeHint = computed(() => {
  const b = ov.value.by_type || [];
  return b.filter((x) => x.count).map((x) => `${x.label} ${x.count}`).join(' · ') || '—';
});

/** 可选期间：近 15 个月倒序 */
const periodOptions = computed(() => {
  const out = [];
  const d = new Date();
  for (let i = 0; i < 15; i++) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1 - i;
    const dt = new Date(y, m - 1, 1);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
});

function money(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v, total) {
  if (!total) return '0%';
  return Math.round((v / total) * 1000) / 10 + '%';
}

function go(k) {
  tab.value = k;
  if (k === 'segments') loadSegments();
  if (k === 'ic') loadIc();
  if (k === 'consolidation') { loadHistory(); }
}

async function loadOverview() {
  ov.value = await api.groupOverview();
}
async function loadCompanies() {
  companies.value = await api.groupCompanies({ status: 'all' });
}
async function loadParties() {
  parties.value = await api.groupParties();
}
async function loadIc() {
  if (!icPeriod.value) icPeriod.value = period.value;
  ic.value = await api.groupIntercompany({ period: icPeriod.value });
}
async function loadSegments() {
  segments.value = await api.groupSegments({ period: period.value });
}
async function loadHistory() {
  history.value = await api.groupConsolidations({ limit: 20 });
  if (history.value.length && !cur.value) cur.value = await api.groupConsolidation(history.value[0].id);
}

/* ---------- 主体 ---------- */
const coForm = reactive({
  show: false, id: null, code: '', name: '', short_name: '', type: 'branch', tax_no: '',
  legal_person: '', base_currency: 'CNY', open_period: '', parent_id: '', consolidation: 1, status: 'active',
  phone: '', addr: ''
});

function openCompany(c) {
  Object.assign(coForm, {
    show: true, id: c ? c.id : null,
    code: c ? c.code : '', name: c ? c.name : '', short_name: c ? c.short_name : '',
    type: c ? c.type : 'branch', tax_no: c ? c.tax_no : '', legal_person: c ? c.legal_person : '',
    base_currency: c ? c.base_currency || 'CNY' : 'CNY',
    open_period: c ? c.open_period : period.value,
    parent_id: c ? c.parent_id || '' : (companies.value[0]?.id || ''),
    consolidation: c ? (c.consolidation ? 1 : 0) : 1,
    status: c ? c.status : 'active',
    phone: c ? c.phone : '', addr: c ? c.addr : ''
  });
}

async function saveCompany() {
  if (!coForm.name.trim()) return alert('请填主体名称');
  if (!coForm.id && !/^[A-Z0-9_-]{2,16}$/.test(String(coForm.code).toUpperCase())) {
    return alert('主体编码要是 2-16 位大写字母数字');
  }
  busy.value = true;
  try {
    const body = {
      name: coForm.name, short_name: coForm.short_name, type: coForm.type,
      tax_no: coForm.tax_no, legal_person: coForm.legal_person, base_currency: coForm.base_currency,
      parent_id: coForm.parent_id || null, consolidation: coForm.consolidation,
      phone: coForm.phone, addr: coForm.addr
    };
    if (coForm.id) {
      body.status = coForm.status;
      await api.updateGroupCompany(coForm.id, body);
    } else {
      body.code = coForm.code.toUpperCase();
      body.open_period = coForm.open_period;
      await api.createGroupCompany(body);
    }
    coForm.show = false;
    await Promise.all([loadOverview(), loadCompanies()]);
  } catch (e) {
    alert(e.message || '保存失败');
  } finally {
    busy.value = false;
  }
}

/* ---------- 内部往来单位 ---------- */
const partyForm = reactive({
  show: false, id: null, company_id: null, counter_company_id: null, kind: 'customer',
  ref_name: '', offset_account: '1122', status: 'active', note: ''
});

function openParty(p) {
  Object.assign(partyForm, {
    show: true, id: p ? p.id : null,
    company_id: p ? p.company_id : (companies.value[0]?.id || null),
    counter_company_id: p ? p.counter_company_id : (companies.value[1]?.id || null),
    kind: p ? p.kind : 'customer',
    ref_name: p ? p.ref_name : '',
    offset_account: p ? p.offset_account : '1122',
    status: p ? p.status : 'active',
    note: p ? p.note : ''
  });
}

async function saveParty() {
  if (!partyForm.ref_name.trim()) return alert('请填单据上的对方名称');
  if (partyForm.company_id === partyForm.counter_company_id) return alert('对方主体不能和本方一样');
  busy.value = true;
  try {
    const body = {
      company_id: partyForm.company_id, counter_company_id: partyForm.counter_company_id,
      kind: partyForm.kind, ref_name: partyForm.ref_name, offset_account: partyForm.offset_account,
      note: partyForm.note, status: partyForm.status
    };
    if (partyForm.id) await api.updateGroupParty(partyForm.id, body);
    else await api.createGroupParty(body);
    partyForm.show = false;
    await Promise.all([loadParties(), loadOverview()]);
  } catch (e) {
    alert(e.message || '保存失败');
  } finally {
    busy.value = false;
  }
}

async function doScan() {
  busy.value = true;
  try {
    const r = await api.groupScanIc({ period: icPeriod.value });
    await Promise.all([loadIc(), loadOverview()]);
    if (r.diff) alert(`配对完成：${r.matched} 对已平，${r.diff} 对有差异（合计差 ¥${money(r.diff_amount)}）`);
    else alert(`配对完成：${r.matched} 对全部对上`);
  } catch (e) {
    alert(e.message || '配对失败');
  } finally {
    busy.value = false;
  }
}

async function openIgnore(l) {
  const reason = prompt(`忽略「${l.from_company_name} → ${l.to_company_name}」差 ¥${money(l.diff_amount)} 的理由：\n（至少 4 个字，会留痕）`);
  if (reason === null) return;
  try {
    await api.groupIgnoreIc(l.id, { reason });
    await Promise.all([loadIc(), loadOverview()]);
  } catch (e) {
    alert(e.message || '操作失败');
  }
}

/* ---------- 合并 ---------- */
async function doConsolidate() {
  busy.value = true;
  try {
    cur.value = await api.createGroupConsolidation({ period: conPeriod.value });
    await Promise.all([loadHistory(), loadOverview()]);
    if (!cur.value.balanced) {
      alert(`合并后不平，差 ¥${money(cur.value.diff_amount)}，请检查各主体报表。`);
    } else if (cur.value.ic_diff_cnt) {
      alert(`合并报表已平，但有 ${cur.value.ic_diff_cnt} 笔内部往来金额不一致 —— 报表金额是虚的，建议先核对。`);
    }
  } catch (e) {
    alert(e.message || '生成失败');
  } finally {
    busy.value = false;
  }
}

async function openCon(h) {
  cur.value = await api.groupConsolidation(h.id);
}

async function doConfirmCon() {
  if (!cur.value) return;
  try {
    await api.confirmGroupConsolidation(cur.value.id);
    cur.value = await api.groupConsolidation(cur.value.id);
    await loadHistory();
  } catch (e) {
    alert(e.message || '确认失败');
  }
}

async function doDeleteCon() {
  if (!cur.value) return;
  if (!confirm(`删除草稿 ${cur.value.con_no}？`)) return;
  try {
    await api.deleteGroupConsolidation(cur.value.id);
    cur.value = null;
    await loadHistory();
  } catch (e) {
    alert(e.message || '删除失败');
  }
}

onMounted(async () => {
  const d = new Date();
  const cur0 = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  period.value = cur0;
  icPeriod.value = cur0;
  conPeriod.value = cur0;
  await Promise.all([loadOverview(), loadCompanies(), loadParties(), loadHistory()]);
  // 默认落在最近有合并记录的期间，否则用户一进来看到空的会以为没数据
  if (history.value.length) {
    cur.value = null;
    conPeriod.value = history.value[0].period;
    await openCon(history.value[0]);
  }
});
</script>

<style scoped>
.sub { margin: 4px 0 0; font-size: 12.5px; color: #8a94a6; }
.head-ops { display: flex; align-items: center; gap: 8px; }
.mode-pill { font-size: 12px; color: #4a566e; background: #f2f5fa; border: 1px solid #e2e8f2; border-radius: 20px; padding: 4px 12px; }

.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.stat .unit { font-style: normal; font-size: 12px; color: #8a94a6; margin-left: 2px; }
.stat .con-no { font-size: 14px; letter-spacing: 0.2px; }
.stat-good { background: #f5fbf7; border-color: #d6ecdd; }
.stat-good strong { color: #16a34a; }
.stat-bad { background: #fff6f7; border-color: #f6d4d9; }
.stat-bad strong { color: #d92d45; }

/* 页签单行横向滚动：换行会让父容器算不出高度，下一块内容会盖上来 */
.tabbar { display: flex; align-items: flex-start; margin-bottom: 8px; }
.tabbar .tabs { margin-left: 0; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.tabbar .tabs button { flex: 0 0 auto; white-space: nowrap; }

.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.75; margin: 0 0 12px; }
.hint-inline { font-size: 12px; color: #8a94a6; }
.foot-note { font-size: 11.5px; color: #9aa4b5; margin: 8px 0 0; }
.empty { text-align: center; color: #a3adbe; font-size: 12.5px; padding: 26px 10px; }
.empty-box { background: #fff; border: 1px dashed #dfe6f0; border-radius: 12px; padding: 40px; text-align: center; color: #a3adbe; font-size: 13px; }

.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.tiny { font-size: 11.5px; }
.wrap { white-space: normal; line-height: 1.55; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.num { text-align: right; }
.ops { white-space: nowrap; }
.row-error { background: #fff7f8; }
.sum-row td { background: #f7f9fd; font-weight: 600; color: #16233b; }

.pill { display: inline-block; white-space: nowrap; font-size: 11px; border-radius: 5px; padding: 1px 7px; }
.p-hq { background: #eef4ff; color: #2b6de5; }
.p-br { background: #f0f7f2; color: #15803d; }
.p-sub { background: #f5f0ff; color: #7c3aed; }
.p-ok { background: #f0faf3; color: #16a34a; }
.p-wait { background: #fff8ec; color: #b46207; }
.p-bad { background: #fdecef; color: #c0243c; }
.p-off { background: #f2f4f7; color: #8a94a6; }
.p-ic { background: #eef4ff; color: #2b6de5; }
.p-tx { background: #fff4e9; color: #b46207; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }

/* 主体卡片 */
.co-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.co-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 13px 15px; }
.co-card.co-hq { border-color: #cfdcf5; background: linear-gradient(180deg, #f7faff, #fff 42%); }
.co-card.co-off { opacity: 0.72; }
.co-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.co-name { font-size: 13.5px; font-weight: 600; color: #16233b; line-height: 1.4; }
.co-code { font-size: 11px; color: #a3adbe; margin-top: 2px; }
.co-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; margin: 11px 0; padding: 9px 0; border-top: 1px dashed #eef1f7; border-bottom: 1px dashed #eef1f7; }
.co-meta > div { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 11.5px; min-width: 0; }
.co-meta span { color: #9aa4b5; flex: 0 0 auto; }
.co-meta b { color: #3d4a63; font-weight: 500; overflow-wrap: anywhere; text-align: right; }
.co-nums { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 11px; }
.co-nums > div { text-align: center; }
.co-nums b { display: block; font-size: 15px; color: #16233b; }
.co-nums span { font-size: 11px; color: #9aa4b5; }
.co-foot { display: flex; justify-content: space-between; align-items: center; }
.co-add { border: 1px dashed #d5deec; border-radius: 12px; background: #fafcff; color: #8a94a6; min-height: 178px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; cursor: pointer; transition: 0.15s; }
.co-add:hover { border-color: #9fb6e0; color: #2b6de5; background: #f5f9ff; }
.co-add span { font-size: 26px; line-height: 1; }
.co-add small { font-size: 12px; }

/* 分部对比 */
.seg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.seg-period, .ic-period { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #6b778c; }
.seg-period select, .ic-period select { font-size: 12.5px; padding: 4px 8px; border: 1px solid #dfe6f0; border-radius: 7px; background: #fff; }
.seg-tbl { min-width: 1180px; width: 100%; }
.seg-tbl th { text-align: left; }
.seg-tbl th.num, .seg-tbl td.num { text-align: right; padding-right: 12px; }
.co-cell { font-size: 12.5px; color: #16233b; }

/* 内部往来 */
.ic-bar { display: flex; align-items: center; gap: 16px; margin-bottom: 10px; flex-wrap: wrap; }
.ic-stat { display: flex; gap: 14px; font-size: 12.5px; color: #6b778c; }
.ic-stat b { font-size: 13px; }
.ic-ops { margin-left: auto; display: flex; gap: 8px; }
.ic-tbl { min-width: 1080px; width: 100%; }
.ic-tbl th { text-align: left; }
.ic-tbl th.num, .ic-tbl td.num { text-align: right; padding-right: 12px; }
.party-tbl { min-width: 940px; width: 100%; }
.party-tbl th { text-align: left; }

/* 合并 */
.cn-bar { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; flex-wrap: wrap; }
.cn-bar .btn { margin-left: auto; }
.cn-banner { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; border-radius: 11px; padding: 11px 14px; margin-bottom: 13px; }
.cn-banner-l { flex: 1 1 auto; min-width: 0; }
.cn-banner.ok { background: #f4fbf6; border: 1px solid #d3ebdb; }
.cn-banner.bad { background: #fff6f7; border: 1px solid #f6d4d9; }
.cn-banner-l > b { display: block; font-size: 13.5px; color: #16233b; margin-bottom: 3px; }
.cn-warn b { display: inline; color: #b46207; }
.cn-ok b { display: inline; }
.cn-banner.bad .cn-banner-l b { color: #c0243c; }
.cn-warn { font-size: 12px; color: #b46207; line-height: 1.6; }
.cn-ok { font-size: 12px; color: #16a34a; }
.cn-banner-r { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }

.cn-flow { display: grid; grid-template-columns: 1fr 26px 1fr 26px 1.15fr; align-items: stretch; gap: 0; }
.cn-step { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.cn-step.cn-final { border-color: #cfe3d6; background: #fbfefc; }
.cn-step-t { font-size: 12.5px; font-weight: 600; color: #16233b; margin-bottom: 9px; }
.cn-step-t small { font-weight: 400; color: #a3adbe; margin-left: 6px; }
.cn-kv { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 12px; color: #6b778c; padding: 3px 0; }
.cn-kv b { color: #16233b; font-weight: 600; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; white-space: nowrap; }
.cn-kv.muted b { color: #a3adbe; font-family: inherit; font-weight: 400; font-size: 11.5px; }
.cn-arrow { display: flex; align-items: center; justify-content: center; color: #b6bfcf; font-size: 16px; }

.adj-tbl { min-width: 900px; width: 100%; }
.adj-tbl th { text-align: left; }
.adj-tbl th.num, .adj-tbl td.num { text-align: right; padding-right: 12px; }
.his-tbl { min-width: 1000px; width: 100%; }
.his-tbl th { text-align: left; }
.his-tbl th.num, .his-tbl td.num { text-align: right; padding-right: 12px; }
.cn-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.cn-actions .tiny { margin-left: auto; }

.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }

/* 弹窗表单 */
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.fi { display: flex; flex-direction: column; gap: 4px; }
.fi-full { grid-column: 1 / -1; }
.fi label { font-size: 12px; color: #6b778c; }
.fi label em { color: #d92d45; font-style: normal; }
.fi input, .fi select { font-size: 12.5px; padding: 6px 9px; border: 1px solid #dfe6f0; border-radius: 7px; background: #fff; color: #16233b; }
.fi input:focus, .fi select:focus { outline: none; border-color: #9fb6e0; }
.tip { font-size: 11.5px; color: #8a94a6; line-height: 1.7; margin: 12px 0 0; background: #f8fafd; border-radius: 8px; padding: 8px 10px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .co-grid { grid-template-columns: 1fr; }
  .co-add { min-height: 96px; }
  .cn-flow { grid-template-columns: 1fr; gap: 8px; }
  .cn-arrow { height: 18px; }
  .form-grid { grid-template-columns: 1fr; }
  .ic-ops { margin-left: 0; width: 100%; }
  .cn-bar .btn { margin-left: 0; }
}
</style>
