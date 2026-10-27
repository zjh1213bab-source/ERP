<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>税票银行与结算</h2>
        <p class="sub">
          银行流水导入后<b>按金额+方向+日期+对方</b>自动匹配收付款单，拿不准的留给人判断。
          对账把差额拆成两类未达账项：<b>银行记了企业没记</b>（手续费、结息、对方直汇）、<b>企业记了银行没记</b>（已制单未到账）。
          <b>调节后仍有差额不允许确认</b>——对账的意义就是把这个差找出来。本模块只核对，<b>不自动改账</b>。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill" :class="ov.unmatched_total ? 'p-orange' : 'p-green'">
          未匹配流水 {{ ov.unmatched_total || 0 }}
        </span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>账户数</span><strong>{{ ov.account_count || 0 }}</strong><small>启用中</small></div>
      <div class="stat" :class="(ov.statement_total || 0) !== (ov.book_total || 0) ? 'st-warn' : 'st-good'">
        <span>银行余额合计</span><strong>{{ money(ov.statement_total) }}</strong>
        <small>账面 {{ money(ov.book_total) }}</small>
      </div>
      <div class="stat" :class="ov.unmatched_total ? 'st-warn' : ''">
        <span>未匹配流水</span><strong>{{ ov.unmatched_total || 0 }}</strong><small>条待核对</small>
      </div>
      <div class="stat"><span>末次对账</span><strong>{{ ov.last_recon ? ov.last_recon.period : '—' }}</strong>
        <small>{{ ov.last_recon ? (ov.last_recon.status === 'confirmed' ? '已确认' : '草稿') : '还没做过对账' }}</small>
      </div>
      <div class="stat" :class="(ov.bills && ov.bills.due_30) ? 'st-warn' : ''">
        <span>票据 30 天内到期</span><strong>{{ (ov.bills && ov.bills.due_30) || 0 }}</strong>
        <small>应收在库 {{ money(ov.bills && ov.bills.receivable_total) }}</small>
      </div>
      <div class="stat"><span>应付票据</span><strong>{{ money(ov.bills && ov.bills.payable_total) }}</strong>
        <small>已贴现 {{ money(ov.bills && ov.bills.discounted) }}</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'lines' }" @click="go('lines')">银行流水<span v-if="ov.unmatched_total" class="tab-dot">{{ ov.unmatched_total }}</span></button>
        <button :class="{ on: tab === 'recon' }" @click="go('recon')">银行对账</button>
        <button :class="{ on: tab === 'bills' }" @click="go('bills')">票据台账</button>
        <button :class="{ on: tab === 'accounts' }" @click="go('accounts')">账户与导入</button>
      </div>
    </div>

    <!-- ========== 银行流水 ========== -->
    <div v-if="tab === 'lines'" class="block">
      <div class="toolbar">
        <select v-model="lineAccount" @change="loadLines">
          <option value="">全部账户</option>
          <option v-for="a in dict.accounts" :key="a.id" :value="a.id">{{ a.bank_name }} {{ a.account_masked }}</option>
        </select>
        <select v-model="lineStatus" @change="loadLines">
          <option value="">全部状态</option>
          <option value="unmatched">未匹配</option>
          <option value="auto">自动匹配</option>
          <option value="manual">手工匹配</option>
          <option value="ignored">已忽略</option>
        </select>
        <input v-model="lineQ" placeholder="摘要 / 对方户名" style="width: 160px" @keyup.enter="loadLines" />
        <button class="btn btn-ghost btn-sm" @click="loadLines">查询</button>
        <button v-if="canWrite" class="btn btn-primary btn-sm" :disabled="!lineAccount || autoRunning" @click="doAutoMatch">
          {{ autoRunning ? '匹配中…' : '自动匹配' }}
        </button>
        <span class="muted tiny">共 {{ lineStat.total || 0 }} 条 · 未匹配 {{ lineStat.unmatched || 0 }} · 已匹配 {{ lineStat.matched || 0 }}</span>
      </div>

      <div class="table-wrap">
        <table class="tb-tbl">
          <thead>
            <tr>
              <th style="width: 106px">交易日期</th>
              <th>摘要</th>
              <th style="width: 170px">对方户名</th>
              <th style="width: 110px" class="num">收入</th>
              <th style="width: 110px" class="num">支出</th>
              <th style="width: 116px" class="num">余额</th>
              <th style="width: 96px">状态</th>
              <th style="width: 150px">匹配单据</th>
              <th style="width: 148px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lines" :key="l.id" :class="l.match_status === 'unmatched' ? 'row-warn' : ''">
              <td class="tiny mono">{{ l.trade_date }}</td>
              <td class="tiny wrap">{{ l.summary || '—' }}</td>
              <td class="tiny">{{ l.counterparty || '—' }}</td>
              <td class="num" :class="l.direction === 'in' ? 'amt-green' : 'muted'">{{ l.direction === 'in' ? money(l.amount) : '' }}</td>
              <td class="num amt-red">{{ l.direction === 'out' ? money(l.amount) : '' }}</td>
              <td class="num tiny muted">{{ l.balance === null ? '—' : money(l.balance) }}</td>
              <td><span class="pill" :class="mcls(l.match_status)">{{ l.match_label }}</span></td>
              <td class="tiny mono">{{ l.pay_no || '—' }}</td>
              <td class="ops">
                <template v-if="canWrite">
                  <button v-if="l.match_status === 'unmatched'" class="btn btn-ghost btn-sm" @click="openMatch(l)">匹配</button>
                  <button v-if="l.match_status === 'unmatched'" class="btn btn-ghost btn-sm" @click="openIgnore(l)">忽略</button>
                  <button v-if="l.match_status === 'auto' || l.match_status === 'manual'" class="btn btn-ghost btn-sm" @click="doUnmatch(l)">取消</button>
                  <span v-if="l.match_status === 'ignored'" class="tiny muted">{{ l.note }}</span>
                </template>
              </td>
            </tr>
            <tr v-if="!lines.length"><td colspan="9" class="empty">没有流水。先到「账户与导入」粘贴对账单</td></tr>
          </tbody>
        </table>
      </div>

      <div class="hint-bar" style="margin-top: 10px">
        自动匹配只对<b>金额完全一致、方向一致、日期在 7 天内、且得分最高没有并列</b>的才动手；
        其余一律留给人工——宁可多点一次，也不要对错账。
      </div>
    </div>

    <!-- ========== 银行对账 ========== -->
    <div v-if="tab === 'recon'" class="block">
      <div class="toolbar">
        <select v-model="reconAccount" @change="loadPreview">
          <option v-for="a in dict.accounts.filter((x) => x.status === 'active')" :key="a.id" :value="a.id">{{ a.bank_name }} {{ a.account_masked }}</option>
        </select>
        <input v-model="reconPeriod" type="month" @change="loadPreview" />
        <label class="chk">期末余额
          <input v-model.number="stmtBalance" type="number" style="width: 130px" @change="loadPreview" placeholder="留空用流水余额" />
        </label>
        <button v-if="canWrite" class="btn btn-primary btn-sm" :disabled="!pv" @click="doCreateRecon">生成对账</button>
        <span class="muted tiny">留空则取该账户最后一条流水的余额</span>
      </div>

      <div v-if="pv" class="recon-box">
        <div class="rb-head">
          <b>{{ pv.account.bank_name }} {{ pv.account.account_masked }}</b>
          <span class="pill p-gray">{{ pv.period }} 期末 {{ pv.period_end }}</span>
          <span class="pill" :class="pv.balanced ? 'p-green' : 'p-red'">
            {{ pv.balanced ? '调节后平衡' : '差额 ' + money(pv.diff_amount) }}
          </span>
          <span v-if="pv.import_gap" class="pill p-orange">流水差 {{ money(pv.import_gap) }}</span>
        </div>

        <div class="recon-grid">
          <div class="rg-col">
            <div class="rg-title">银行对账单</div>
            <div class="rg-row"><span>期末余额</span><b>{{ money(pv.statement_balance) }}</b></div>
            <div class="rg-row"><span>加：企业已收 银行未收</span><b class="amt-green">{{ money(pv.book_only_in) }}</b></div>
            <div class="rg-row"><span>减：企业已付 银行未付</span><b class="amt-red">{{ money(pv.book_only_out) }}</b></div>
            <div class="rg-row total"><span>调节后银行余额</span><b>{{ money(pv.adjusted_statement) }}</b></div>
          </div>
          <div class="rg-col">
            <div class="rg-title">企业账面</div>
            <div class="rg-row"><span>账面余额</span><b>{{ money(pv.book_balance) }}</b></div>
            <div class="rg-row"><span>加：银行已收 企业未收</span><b class="amt-green">{{ money(pv.bank_only_in) }}</b></div>
            <div class="rg-row"><span>减：银行已付 企业未付</span><b class="amt-red">{{ money(pv.bank_only_out) }}</b></div>
            <div class="rg-row total"><span>调节后账面余额</span><b>{{ money(pv.adjusted_book) }}</b></div>
          </div>
        </div>

        <div v-if="pv.note" class="hint-warn">{{ pv.note }}</div>

        <h4 style="margin-top: 14px">未达账项 <small>{{ pv.items.length }} 条</small></h4>
        <div class="table-wrap">
          <table class="tb-tbl">
            <thead><tr><th style="width: 190px">类型</th><th style="width: 106px">日期</th>
              <th style="width: 70px">方向</th><th style="width: 110px" class="num">金额</th>
              <th style="width: 150px">单号</th><th>对方 / 摘要</th></tr></thead>
            <tbody>
              <tr v-for="(it, i) in pv.items" :key="i">
                <td class="tiny">
                  <span class="pill" :class="it.type === 'bank_only' ? 'p-orange' : 'p-blue'">{{ typeLabel(it.type) }}</span>
                </td>
                <td class="tiny mono">{{ it.trade_date }}</td>
                <td class="tiny">{{ it.direction === 'in' ? '收入' : '支出' }}</td>
                <td class="num">{{ money(it.amount) }}</td>
                <td class="tiny mono">{{ it.ref_no }}</td>
                <td class="tiny wrap">{{ it.counterparty || '' }} {{ it.summary || '' }}</td>
              </tr>
              <tr v-if="!pv.items.length"><td colspan="6" class="empty">没有未达账项，账实完全一致</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4 style="margin-top: 18px">对账历史</h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 150px">对账号</th><th style="width: 150px">账户</th><th style="width: 84px">月份</th>
            <th style="width: 110px" class="num">银行余额</th><th style="width: 110px" class="num">账面余额</th>
            <th style="width: 90px" class="num">差额</th><th style="width: 92px; padding-left: 12px">状态</th><th style="width: 120px">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in recons" :key="r.id" :class="r.diff_amount ? 'row-bad' : ''">
              <td class="tiny mono">{{ r.recon_no }}</td>
              <td class="tiny">{{ r.bank_name }} {{ r.account_masked }}</td>
              <td class="tiny mono">{{ r.period }}</td>
              <td class="num">{{ money(r.statement_balance) }}</td>
              <td class="num">{{ money(r.book_balance) }}</td>
              <td class="num" :class="r.diff_amount ? 'amt-red' : 'amt-green'">{{ money(r.diff_amount) }}</td>
              <td><span class="pill" :class="r.status === 'confirmed' ? 'p-green' : 'p-orange'">{{ r.status_label }}</span></td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openReconDetail(r)">明细</button>
                <button v-if="r.status !== 'confirmed' && canWrite" class="btn btn-ghost btn-sm" @click="doConfirm(r)">确认</button>
              </td>
            </tr>
            <tr v-if="!recons.length"><td colspan="8" class="empty">还没有对账记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 票据台账 ========== -->
    <div v-if="tab === 'bills'" class="block">
      <div class="toolbar">
        <select v-model="billType" @change="loadBills">
          <option value="">全部类型</option><option value="receivable">应收票据</option><option value="payable">应付票据</option>
        </select>
        <select v-model="billStatus" @change="loadBills">
          <option value="">全部状态</option>
          <option v-for="s in dict.bill_status" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
        <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openBill">＋ 登记票据</button>
        <span class="muted tiny">应收在库 {{ money(bills.receivable_total) }} · 应付在库 {{ money(bills.payable_total) }} · 30 天内到期 {{ bills.due_30 || 0 }} 张</span>
      </div>

      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 120px">类型</th><th style="width: 140px">票号</th><th style="width: 130px">承兑</th>
            <th style="width: 140px">出票人</th><th style="width: 110px" class="num">票面</th>
            <th style="width: 100px">出票日</th><th style="width: 100px">到期日</th>
            <th style="width: 96px" class="num">剩余天数</th><th style="width: 84px">状态</th>
            <th style="width: 150px">操作</th></tr></thead>
          <tbody>
            <tr v-for="b in bills.rows" :key="b.id" :class="b.overdue ? 'row-bad' : b.urgent ? 'row-warn' : ''">
              <td><span class="pill" :class="b.type === 'receivable' ? 'p-green' : 'p-blue'">{{ b.type_label }}</span></td>
              <td class="tiny mono">{{ b.bill_no }}</td>
              <td class="tiny">{{ b.accept_label }}<span v-if="b.acceptor" class="muted"> · {{ b.acceptor }}</span></td>
              <td class="tiny">{{ b.drawer || '—' }}</td>
              <td class="num">{{ money(b.amount) }}</td>
              <td class="tiny mono">{{ b.issue_date }}</td>
              <td class="tiny mono">{{ b.due_date }}</td>
              <td class="num tiny" :class="b.overdue ? 'amt-red' : b.urgent ? 'amt-orange' : ''">
                {{ b.days_left }}<span v-if="b.urgent" class="pill p-orange" style="margin-left: 4px">到期</span>
              </td>
              <td><span class="pill" :class="bcls(b.status)">{{ b.status_label }}</span></td>
              <td class="ops">
                <!-- 应收票据：我们收到的票，能托收/贴现/背书转让 -->
                <template v-if="canWrite && b.type === 'receivable' && b.status === 'holding'">
                  <button class="btn btn-ghost btn-sm" @click="openBillStatus(b, 'collected')">托收</button>
                  <button class="btn btn-ghost btn-sm" @click="openBillStatus(b, 'discounted')">贴现</button>
                  <button class="btn btn-ghost btn-sm" @click="openBillStatus(b, 'endorsed')">背书</button>
                </template>
                <button v-else-if="canWrite && b.type === 'receivable' && b.status === 'collected'"
                  class="btn btn-ghost btn-sm" @click="openBillStatus(b, 'settled')">收到款</button>
                <!-- 应付票据：我们开出去的票，只有兑付和作废 -->
                <template v-else-if="canWrite && b.type === 'payable' && b.status === 'holding'">
                  <button class="btn btn-ghost btn-sm" @click="openBillStatus(b, 'settled')">兑付</button>
                  <button class="btn btn-ghost btn-sm" @click="openBillStatus(b, 'void')">作废</button>
                </template>
                <span v-else class="tiny muted">{{ b.cash_in_date ? '到账 ' + b.cash_in_date : '—' }}</span>
              </td>
            </tr>
            <tr v-if="!bills.rows || !bills.rows.length"><td colspan="10" class="empty">没有票据</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 账户与导入 ========== -->
    <div v-if="tab === 'accounts'" class="block">
      <h4>银行账户<small>期初余额是对账起点，有流水后不让改</small></h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 130px">账户编码</th><th>开户行</th><th style="width: 110px">账号</th>
            <th style="width: 70px">币种</th><th style="width: 84px">类型</th>
            <th style="width: 110px" class="num">期初余额</th><th style="width: 100px">期初日</th>
            <th style="width: 76px">状态</th><th style="width: 90px">操作</th></tr></thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id" :class="a.status !== 'active' ? 'row-mute' : ''">
              <td class="tiny mono">{{ a.account_no }}</td>
              <td class="tiny">{{ a.bank_name }}</td>
              <td class="tiny mono">{{ a.account_masked || '—' }}</td>
              <td class="tiny">{{ a.currency }}</td>
              <td class="tiny">{{ a.type_label }}</td>
              <td class="num">{{ money(a.open_balance) }}</td>
              <td class="tiny mono">{{ a.open_date || '—' }}</td>
              <td><span class="pill" :class="a.status === 'active' ? 'p-green' : 'p-gray'">{{ a.status_label }}</span></td>
              <td class="ops">
                <button v-if="isAdmin && a.status === 'active'" class="btn btn-ghost btn-sm" @click="closeAccount(a)">销户</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="isAdmin" class="form-row" style="margin-top: 8px">
        <button class="btn btn-ghost btn-sm" @click="openAccount">＋ 新建账户</button>
      </div>

      <h4 style="margin-top: 18px">导入对账单<small>粘贴银行导出的 CSV，重复导入不会翻倍</small></h4>
      <div class="import-box">
        <div class="form-row">
          <select v-model="impAccount">
            <option v-for="a in dict.accounts.filter((x) => x.status === 'active')" :key="a.id" :value="a.id">{{ a.bank_name }} {{ a.account_masked }}</option>
          </select>
          <input v-model="impSource" placeholder="来源说明（例：工行 2026-11 对账单.xlsx）" style="flex: 1" />
        </div>
        <textarea v-model="impCsv" rows="7" placeholder="每行：日期,摘要,对方户名,收入,支出,余额&#10;2026-11-02,货款 美国ABC,示范客户·美国 ABC,12000,,150000&#10;2026-11-03,付面料款,蒙特布料,,8000,142000&#10;也支持 4 列带符号：日期,摘要,对方,+12000 或 -8000"></textarea>
        <div class="form-row">
          <button class="btn btn-primary btn-sm" :disabled="importing || !impCsv.trim()" @click="doImport">
            {{ importing ? '导入中…' : '导入' }}
          </button>
          <span class="muted tiny">{{ dict.csv_hint }}</span>
        </div>
      </div>

      <h4 style="margin-top: 18px">导入记录</h4>
      <div class="table-wrap">
        <table class="tb-tbl">
          <thead><tr><th style="width: 150px">批次号</th><th style="width: 150px">账户</th><th style="width: 120px">期间</th>
            <th>来源</th><th style="width: 70px" class="num">新增</th><th style="width: 70px" class="num">重复</th>
            <th style="width: 110px" class="num">收入</th><th style="width: 110px" class="num">支出</th><th style="width: 140px">时间</th></tr></thead>
          <tbody>
            <tr v-for="i in imports" :key="i.id">
              <td class="tiny mono">{{ i.import_no }}</td>
              <td class="tiny">{{ i.bank_name }} {{ i.account_masked }}</td>
              <td class="tiny mono">{{ i.period || '—' }}</td>
              <td class="tiny wrap">{{ i.source_name || '—' }}</td>
              <td class="num tiny">{{ i.line_count }}</td>
              <td class="num tiny" :class="i.dup_count ? 'amt-orange' : 'muted'">{{ i.dup_count }}</td>
              <td class="num">{{ money(i.in_total) }}</td>
              <td class="num">{{ money(i.out_total) }}</td>
              <td class="tiny mono">{{ i.created_at }}</td>
            </tr>
            <tr v-if="!imports.length"><td colspan="9" class="empty">还没有导入记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========== 弹窗：手工匹配 ========== -->
    <div v-if="modal === 'match'" class="modal-mask" @click.self="closeModal">
      <div class="modal xwide">
        <div class="modal-head"><h3>匹配收付款单</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="match-head" v-if="matchLine">
            <b>{{ matchLine.trade_date }}</b>
            <span class="pill" :class="matchLine.direction === 'in' ? 'p-green' : 'p-blue'">{{ matchLine.direction === 'in' ? '收入' : '支出' }}</span>
            <b>{{ money(matchLine.amount) }}</b>
            <span class="muted tiny">{{ matchLine.counterparty }} · {{ matchLine.summary }}</span>
          </div>
          <div class="table-wrap" style="margin-top: 10px">
            <table class="tb-tbl">
              <thead><tr><th style="width: 150px">单号</th><th style="width: 160px">对方</th>
                <th style="width: 110px" class="num">金额</th><th style="width: 106px">日期</th>
                <th style="width: 76px" class="num">得分</th><th>判定依据</th><th style="width: 80px">操作</th></tr></thead>
              <tbody>
                <tr v-for="c in cands" :key="c.payment_id" :class="c.taken ? 'row-mute' : ''">
                  <td class="tiny mono">{{ c.pay_no }}</td>
                  <td class="tiny">{{ c.partner_name || '—' }}</td>
                  <td class="num">{{ money(c.amount) }}</td>
                  <td class="tiny mono">{{ c.pay_date }}</td>
                  <td class="num tiny">{{ c.score }}</td>
                  <td class="tiny wrap">
                    <span v-for="(w, i) in c.why" :key="i" class="chip">{{ w }}</span>
                    <span v-if="c.taken" class="pill p-gray">已被别的流水占用</span>
                  </td>
                  <td class="ops">
                    <button v-if="!c.taken" class="btn btn-primary btn-sm" @click="doMatch(c)">匹配</button>
                  </td>
                </tr>
                <tr v-if="!cands.length"><td colspan="7" class="empty">没有金额一致的收付款单。这种情况多半是「银行已记企业未记」，需要在往来账补一张收款单</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>

    <!-- ========== 弹窗：忽略 ========== -->
    <div v-if="modal === 'ignore'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>忽略这条流水</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="hint-bar">忽略只是不再提示，它<b>仍会出现在对账的未达账项里</b>——钱确实到账了，企业账上确实没有。</div>
          <label>原因（至少 4 个字）</label>
          <input v-model="ignoreReason" placeholder="例：客户老板个人账户代付，已在客户档案登记" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doIgnore">确认忽略</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：新建账户 ========== -->
    <div v-if="modal === 'account'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>新建银行账户</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <label>账户编码（内部用）</label>
          <input v-model="accForm.account_no" placeholder="CN-ICBC-001" />
          <label>开户行</label>
          <input v-model="accForm.bank_name" placeholder="中国工商银行义乌支行" />
          <label>账号（尾号）</label>
          <input v-model="accForm.account_masked" placeholder="****8866" />
          <div class="two">
            <div><label>币种</label><input v-model="accForm.currency" placeholder="CNY" /></div>
            <div><label>类型</label>
              <select v-model="accForm.account_type">
                <option v-for="t in dict.account_types" :key="t.code" :value="t.code">{{ t.label }}</option>
              </select>
            </div>
          </div>
          <div class="two">
            <div><label>期初余额</label><input v-model.number="accForm.open_balance" type="number" /></div>
            <div><label>期初日期</label><input v-model="accForm.open_date" type="date" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doCreateAccount">创建</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：票据登记 ========== -->
    <div v-if="modal === 'bill'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>登记票据</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="two">
            <div><label>类型</label>
              <select v-model="billForm.type">
                <option value="receivable">应收票据（客户给我们）</option>
                <option value="payable">应付票据（我们给供应商）</option>
              </select>
            </div>
            <div><label>承兑</label>
              <select v-model="billForm.accept_type">
                <option value="bank">银行承兑</option><option value="commercial">商业承兑</option>
              </select>
            </div>
          </div>
          <label>票号</label>
          <input v-model="billForm.bill_no" placeholder="AC2026110001" />
          <div class="two">
            <div><label>出票人</label><input v-model="billForm.drawer" /></div>
            <div><label>承兑人</label><input v-model="billForm.acceptor" /></div>
          </div>
          <div class="two">
            <div><label>票面金额</label><input v-model.number="billForm.amount" type="number" /></div>
            <div><label>关联客户/供应商</label><input v-model="billForm.partner_name" /></div>
          </div>
          <div class="two">
            <div><label>出票日</label><input v-model="billForm.issue_date" type="date" /></div>
            <div><label>到期日</label><input v-model="billForm.due_date" type="date" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doCreateBill">登记</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：票据状态 ========== -->
    <div v-if="modal === 'billStatus'" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head"><h3>票据状态变更</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body">
          <div class="ack-sum" v-if="billTarget">
            {{ billTarget.bill_no }} · {{ money(billTarget.amount) }} →
            <b>{{ statusLabel(billStatusTarget) }}</b>
          </div>
          <div v-if="billStatusTarget === 'discounted'" class="two">
            <div><label>贴现率 %</label><input v-model.number="billExtra.discount_rate" type="number" step="0.01" /></div>
            <div><label>贴现息</label><input v-model.number="billExtra.discount_cost" type="number" /></div>
          </div>
          <label v-if="billStatusTarget === 'discounted'">到账日</label>
          <input v-if="billStatusTarget === 'discounted'" v-model="billExtra.cash_in_date" type="date" />
          <label>备注</label>
          <input v-model="billExtra.note" placeholder="可选" />
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" @click="doBillStatus">确认</button>
        </div>
      </div>
    </div>

    <!-- ========== 弹窗：对账明细 ========== -->
    <div v-if="modal === 'reconDetail'" class="modal-mask" @click.self="closeModal">
      <div class="modal xwide">
        <div class="modal-head"><h3>对账明细 {{ reconDetail && reconDetail.recon_no }}</h3><button class="x" @click="closeModal">×</button></div>
        <div class="modal-body" v-if="reconDetail">
          <div class="recon-grid">
            <div class="rg-col">
              <div class="rg-title">银行对账单</div>
              <div class="rg-row"><span>期末余额</span><b>{{ money(reconDetail.statement_balance) }}</b></div>
              <div class="rg-row"><span>加：企业已收 银行未收</span><b>{{ money(reconDetail.book_only_in) }}</b></div>
              <div class="rg-row"><span>减：企业已付 银行未付</span><b>{{ money(reconDetail.book_only_out) }}</b></div>
              <div class="rg-row total"><span>调节后</span><b>{{ money(reconDetail.adjusted_statement) }}</b></div>
            </div>
            <div class="rg-col">
              <div class="rg-title">企业账面</div>
              <div class="rg-row"><span>账面余额</span><b>{{ money(reconDetail.book_balance) }}</b></div>
              <div class="rg-row"><span>加：银行已收 企业未收</span><b>{{ money(reconDetail.bank_only_in) }}</b></div>
              <div class="rg-row"><span>减：银行已付 企业未付</span><b>{{ money(reconDetail.bank_only_out) }}</b></div>
              <div class="rg-row total"><span>调节后</span><b>{{ money(reconDetail.adjusted_book) }}</b></div>
            </div>
          </div>
          <div class="table-wrap" style="margin-top: 10px">
            <table class="tb-tbl">
              <thead><tr><th style="width: 190px">类型</th><th style="width: 106px">日期</th>
                <th style="width: 70px">方向</th><th style="width: 110px" class="num">金额</th>
                <th style="width: 150px">单号</th><th>对方 / 摘要</th></tr></thead>
              <tbody>
                <tr v-for="(it, i) in reconDetail.items" :key="i">
                  <td class="tiny">{{ it.type_label }}</td>
                  <td class="tiny mono">{{ it.trade_date }}</td>
                  <td class="tiny">{{ it.direction_label }}</td>
                  <td class="num">{{ money(it.amount) }}</td>
                  <td class="tiny mono">{{ it.ref_no }}</td>
                  <td class="tiny wrap">{{ it.counterparty || '' }} {{ it.summary || '' }}</td>
                </tr>
                <tr v-if="!reconDetail.items.length"><td colspan="6" class="empty">没有未达账项</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="closeModal">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';
import { can } from '../store/permissions';

const tab = ref('lines');
const ov = ref({});
const dict = ref({ accounts: [], bill_status: [] });
const accounts = ref([]);
const lines = ref([]);
const lineStat = ref({});
const lineAccount = ref('');
const lineStatus = ref('');
const lineQ = ref('');
const autoRunning = ref(false);
const imports = ref([]);
const recons = ref([]);
const bills = ref({ rows: [] });
const billType = ref('');
const billStatus = ref('');

const reconAccount = ref('');
const reconPeriod = ref('2026-10');
const stmtBalance = ref(null);
const pv = ref(null);

const impAccount = ref('');
const impSource = ref('');
const impCsv = ref('');
const importing = ref(false);

const modal = ref('');
const matchLine = ref(null);
const cands = ref([]);
const ignoreTarget = ref(null);
const ignoreReason = ref('');
const accForm = ref({ account_no: '', bank_name: '', account_masked: '', currency: 'CNY', account_type: 'basic', open_balance: 0, open_date: '' });
const billForm = ref({ type: 'receivable', accept_type: 'bank', bill_no: '', drawer: '', acceptor: '', amount: 0, partner_name: '', issue_date: '', due_date: '' });
const billTarget = ref(null);
const billStatusTarget = ref('');
const billExtra = ref({ discount_rate: 3.6, discount_cost: 0, cash_in_date: '', note: '' });
const reconDetail = ref(null);

const canWrite = computed(() => can('bank.write'));
const isAdmin = computed(() => (auth.user && auth.user.role) === 'admin');

const money = (v) => '¥' + (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mcls = (s) => ({ unmatched: 'p-orange', auto: 'p-green', manual: 'p-green', ignored: 'p-gray' }[s] || 'p-gray');
const bcls = (s) => ({ holding: 'p-orange', endorsed: 'p-blue', discounted: 'p-blue', collected: 'p-green', settled: 'p-gray', void: 'p-gray' }[s] || 'p-gray');
const typeLabel = (t) => (t === 'bank_only' ? '银行已记 企业未记' : '企业已记 银行未记');
const statusLabel = (s) => (dict.value.bill_status.find((x) => x.code === s) || {}).label || s;

function closeModal() { modal.value = ''; }
function toast(m) { window.alert(m); }

async function loadDict() {
  dict.value = await api.bankDict();
  if (dict.value.accounts.length && !lineAccount.value) {
    const act = dict.value.accounts.find((a) => a.status === 'active');
    if (act) { lineAccount.value = act.id; impAccount.value = act.id; reconAccount.value = act.id; }
  }
}

async function loadOverview() { ov.value = await api.bankOverview(); }
async function loadAccounts() { accounts.value = await api.bankAccounts(); }
async function loadImports() { imports.value = await api.bankImports(); }
async function loadRecons() { recons.value = await api.bankRecons(); }

async function loadLines() {
  const r = await api.bankLines({
    account_id: lineAccount.value || undefined,
    status: lineStatus.value || undefined,
    q: lineQ.value || undefined
  });
  lines.value = r.rows;
  lineStat.value = r.stat;
}

async function loadBills() {
  bills.value = await api.bankBills({ type: billType.value || undefined, status: billStatus.value || undefined });
}

async function loadPreview() {
  if (!reconAccount.value) return;
  try {
    pv.value = await api.bankPreview({
      account_id: reconAccount.value, period: reconPeriod.value,
      statement_balance: stmtBalance.value === null || stmtBalance.value === '' ? undefined : stmtBalance.value
    });
  } catch (e) { pv.value = null; toast(e.message || '加载失败'); }
}

function go(k) {
  tab.value = k;
  if (k === 'lines') loadLines();
  if (k === 'recon') { loadPreview(); loadRecons(); }
  if (k === 'bills') loadBills();
  if (k === 'accounts') { loadAccounts(); loadImports(); }
}

async function reloadAll() {
  await loadOverview();
  await loadDict();
  go(tab.value);
}

// ---------- 匹配 ----------
async function doAutoMatch() {
  autoRunning.value = true;
  try {
    const r = await api.bankAutoMatch({ account_id: lineAccount.value, days: 7 });
    toast(`扫描 ${r.total} 条：自动对上 ${r.matched} 条，需要人工判断 ${r.ambiguous} 条，无候选 ${r.none} 条`);
    await loadLines(); await loadOverview();
  } catch (e) { toast(e.message || '匹配失败'); }
  autoRunning.value = false;
}

async function openMatch(l) {
  matchLine.value = l;
  cands.value = await api.bankCandidates(l.id, { days: 15 });
  modal.value = 'match';
}

async function doMatch(c) {
  try {
    await api.bankMatch(matchLine.value.id, { payment_id: c.payment_id });
    closeModal(); toast('已匹配');
    await loadLines(); await loadOverview();
  } catch (e) { toast(e.message || '匹配失败'); }
}

async function doUnmatch(l) {
  if (!window.confirm(`取消与 ${l.pay_no} 的匹配？`)) return;
  try {
    await api.bankUnmatch(l.id);
    await loadLines(); await loadOverview();
  } catch (e) { toast(e.message || '取消失败'); }
}

function openIgnore(l) { ignoreTarget.value = l; ignoreReason.value = ''; modal.value = 'ignore'; }

async function doIgnore() {
  try {
    await api.bankIgnoreLine(ignoreTarget.value.id, { reason: ignoreReason.value });
    closeModal(); await loadLines(); await loadOverview();
    toast('已忽略（仍计入未达账项）');
  } catch (e) { toast(e.message || '操作失败'); }
}

// ---------- 对账 ----------
async function doCreateRecon() {
  try {
    const r = await api.createBankRecon({
      account_id: reconAccount.value, period: reconPeriod.value,
      statement_balance: stmtBalance.value === null || stmtBalance.value === '' ? undefined : stmtBalance.value,
      note: pv.value && pv.value.note
    });
    toast(`已生成 ${r.recon_no}，未达账项 ${r.items.length} 条，差额 ${money(r.diff_amount)}`);
    await loadRecons(); await loadOverview();
  } catch (e) { toast(e.message || '生成失败'); }
}

async function doConfirm(r) {
  try {
    await api.confirmBankRecon(r.id);
    toast('已确认');
    await loadRecons(); await loadOverview();
  } catch (e) { toast(e.message || '确认失败'); }
}

async function openReconDetail(r) {
  reconDetail.value = await api.bankRecon(r.id);
  modal.value = 'reconDetail';
}

// ---------- 票据 ----------
function openBill() {
  billForm.value = { type: 'receivable', accept_type: 'bank', bill_no: '', drawer: '', acceptor: '', amount: 0, partner_name: '', issue_date: '', due_date: '' };
  modal.value = 'bill';
}

async function doCreateBill() {
  try {
    await api.createBankBill(billForm.value);
    closeModal(); toast('已登记'); await loadBills(); await loadOverview();
  } catch (e) { toast(e.message || '登记失败'); }
}

function openBillStatus(b, status) {
  billTarget.value = b; billStatusTarget.value = status;
  billExtra.value = { discount_rate: 3.6, discount_cost: 0, cash_in_date: '', note: '' };
  modal.value = 'billStatus';
}

async function doBillStatus() {
  try {
    await api.setBankBillStatus(billTarget.value.id, { ...billExtra.value, status: billStatusTarget.value });
    closeModal(); toast('已更新'); await loadBills(); await loadOverview();
  } catch (e) { toast(e.message || '操作失败'); }
}

// ---------- 账户与导入 ----------
function openAccount() { accForm.value = { account_no: '', bank_name: '', account_masked: '', currency: 'CNY', account_type: 'basic', open_balance: 0, open_date: '' }; modal.value = 'account'; }

async function doCreateAccount() {
  try {
    await api.createBankAccount(accForm.value);
    closeModal(); toast('已创建'); await loadDict(); await loadAccounts(); await loadOverview();
  } catch (e) { toast(e.message || '创建失败'); }
}

async function closeAccount(a) {
  if (!window.confirm(`停用账户 ${a.account_no}？停用后不再出现在对账下拉里。`)) return;
  try {
    await api.updateBankAccount(a.id, { status: 'closed' });
    await loadAccounts(); await loadDict(); await loadOverview();
  } catch (e) { toast(e.message || '操作失败'); }
}

async function doImport() {
  importing.value = true;
  try {
    const r = await api.bankImport({ account_id: impAccount.value, source_name: impSource.value, csv: impCsv.value });
    toast(`导入 ${r.import_no}：新增 ${r.added} 条，重复跳过 ${r.dup} 条`);
    impCsv.value = '';
    await loadImports(); await loadOverviewSafe(); await loadLines();
  } catch (e) { toast(e.message || '导入失败'); }
  importing.value = false;
}

async function loadOverviewSafe() { try { await loadOverview(); } catch (e) { /* ignore */ } }

onMounted(async () => {
  await loadDict();
  await loadOverview();
  await loadLines();
  await loadRecons();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 18px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.stat.st-good { background: #f2fbf5; border-color: #cfe9d8; }
.stat.st-good strong { color: #16a34a; }
.stat.st-warn { background: #fffaf2; border-color: #f3e0c2; }
.stat.st-warn strong { color: #d97706; }

.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.tiny { font-size: 11.5px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.tb-tbl td.mono { white-space: nowrap; }
.num { text-align: right; }
.tb-tbl th { text-align: left; }
.tb-tbl th.num { text-align: right; padding-right: 12px; }
.tb-tbl td.num { padding-right: 12px; }
.wrap { white-space: normal; line-height: 1.55; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #a9b4c5; font-size: 12px; padding: 18px 0; }
.row-warn { background: #fffdf7; }
.row-bad { background: #fff7f8; }
.row-mute { background: #fafbfd; color: #9aa4b5; }

.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.75; margin: 0 0 12px; }
.hint-warn { background: #fffaf2; border: 1px solid #f3e0c2; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #b46207; margin: 10px 0 0; line-height: 1.7; }
.block { margin-top: 14px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }

.tabbar { display: flex; align-items: flex-start; margin-bottom: 6px; }
.tabbar .tabs { margin-left: 0; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.tabbar .tabs button { flex: 0 0 auto; white-space: nowrap; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }

.pill { display: inline-block; white-space: nowrap; font-size: 11px; border-radius: 5px; padding: 1px 6px; }
.p-green { background: #eaf7ef; color: #16803c; }
.p-orange { background: #fff4e5; color: #b46207; }
.p-red { background: #fdecef; color: #c0243c; }
.p-gray { background: #eef1f6; color: #6b7789; }
.p-blue { background: #eaf1ff; color: #2563eb; }
.chip { display: inline-block; white-space: nowrap; background: #eef2f8; color: #3d4a63; border-radius: 5px; padding: 0 5px; margin: 1px 4px 1px 0; font-size: 10.5px; }

.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.chk { font-size: 12px; color: #4a566e; display: flex; align-items: center; gap: 5px; }
input:not([type]), input[type='month'], input[type='number'], input[type='date'], select { border: 1px solid #dfe5ee; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; }
textarea { width: 100%; border: 1px solid #dfe5ee; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; line-height: 1.6; }
.form-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }

/* 对账 */
.recon-box { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.rb-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.rb-head b { font-size: 13px; color: #16233b; }
.recon-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.rg-col { background: #fafcff; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; }
.rg-title { font-size: 12px; font-weight: 600; color: #3d4a63; margin-bottom: 6px; }
.rg-row { display: flex; justify-content: space-between; font-size: 12px; color: #4a566e; padding: 3px 0; }
.rg-row b { font-family: ui-monospace, Menlo, Consolas, monospace; }
.rg-row.total { border-top: 1px dashed #e2e8f2; margin-top: 4px; padding-top: 6px; font-weight: 700; color: #16233b; }

.match-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: #16233b; background: #f8fafd; border-radius: 8px; padding: 9px 11px; }
.ack-sum { background: #f8fafd; border-radius: 8px; padding: 9px 11px; font-size: 12.5px; color: #3d4a63; line-height: 1.8; margin-bottom: 8px; }
.import-box { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.import-box textarea { margin-top: 8px; }

.modal-body label { display: block; font-size: 12px; color: #8a94a6; margin: 8px 0 4px; }
.modal-body input, .modal-body select { width: 100%; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

.tb-tbl { min-width: 1080px; width: 100%; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .recon-grid { grid-template-columns: 1fr; }
  .two { grid-template-columns: 1fr; }
}
</style>
