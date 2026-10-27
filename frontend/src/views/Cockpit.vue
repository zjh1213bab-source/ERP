<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>经营驾驶舱</h2>
        <p class="sub">钱够不够、哪里在漏 —— 只算有依据的数字，不预测还没签的单</p>
      </div>
      <div class="head-ops">
        <select v-model="period" class="sel" @change="loadAll">
          <option v-for="p in periodOptions" :key="p" :value="p">{{ p }}</option>
        </select>
        <select v-model="companyId" class="sel" @change="loadAll">
          <option value="">全集团</option>
          <option v-for="c in dict.companies" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
        </select>
      </div>
    </div>

    <!-- 预警 -->
    <div v-if="ov.alerts && ov.alerts.length" class="warn-box">
      <div class="warn-title">需要处理 {{ ov.alerts.length }} 项</div>
      <div v-for="(a, i) in ov.alerts" :key="i" class="warn-row" :class="'w-' + a.level">
        <span class="warn-badge">{{ a.level === 'high' ? '紧急' : '关注' }}</span>
        <div class="warn-body">
          <b>{{ a.title }}</b>
          <span>{{ a.detail }}</span>
          <em>{{ a.action }}</em>
        </div>
      </div>
    </div>
    <div v-else class="ok-box">本期没有触发预警 —— 逾期、缺口、集中度都在阈值内</div>

    <!-- 核心指标 -->
    <div class="stat-row">
      <div class="stat">
        <span>营业收入</span><strong>{{ money(ov.money && ov.money.income) }}</strong>
        <small>本期 {{ period }}（已排除损益结转）</small>
      </div>
      <div class="stat">
        <span>毛利率</span>
        <strong :class="gmClass">{{ pct(ov.money && ov.money.gross_margin) }}</strong>
        <small>{{ gmHint }}</small>
      </div>
      <div class="stat">
        <span>净利润</span>
        <strong :class="(ov.money && ov.money.net_profit) >= 0 ? 'amt-green' : 'amt-red'">{{ money(ov.money && ov.money.net_profit) }}</strong>
        <small>净利率 {{ pct(ov.money && ov.money.net_margin) }}</small>
      </div>
      <div class="stat" :class="cashGap ? 'stat-bad' : ''">
        <span>账面现金</span><strong>{{ money(ov.money && ov.money.cash) }}</strong>
        <small>{{ cashGap ? '预测第 ' + ov.cash_forecast.first_neg_week + ' 周转负' : '1002 银行存款期末' }}</small>
      </div>
      <div class="stat" :class="arPct >= 30 ? 'stat-bad' : arPct >= 15 ? 'stat-warn' : ''">
        <span>应收未收</span><strong>{{ money(ov.ar && ov.ar.total) }}</strong>
        <small>逾期 {{ ov.ar ? ov.ar.overdue_pct : 0 }}% · 平均逾期 {{ ov.ar ? ov.ar.avg_age : 0 }} 天</small>
      </div>
      <div class="stat">
        <span>应付未付</span><strong>{{ money(ov.ap && ov.ap.total) }}</strong>
        <small>逾期 {{ ov.ap ? ov.ap.overdue_pct : 0 }}% · {{ ov.ap ? ov.ap.count : 0 }} 笔</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="go(t.k)">
          {{ t.label }}<span v-if="t.dot" class="tab-dot">{{ t.dot }}</span>
        </button>
      </div>
    </div>

    <!-- ==================== 1. 现金预测 ==================== -->
    <div v-if="tab === 'cash'">
      <p class="hint-bar">
        <b>只算有依据的钱。</b>应收按到期日归周，<b>逾期按档打折</b>（逾得越久越难收，老账不会下周就回来）；
        应付按到期日全额排，<b>欠钱不打折</b>；工资与固定费用按历史月均刚性排入。
        <b>没有预测「还没签的订单」</b> —— 那是画饼，不是现金流。
      </p>

      <div class="fc-bar">
        <div class="fc-ctl">
          <label>基准日</label>
          <input v-model="fcForm.base_date" type="date" class="sel" />
          <label>周数</label>
          <select v-model.number="fcForm.weeks" class="sel">
            <option :value="8">8 周</option>
            <option :value="13">13 周</option>
            <option :value="26">26 周</option>
          </select>
          <label>按期回收率</label>
          <select v-model.number="fcForm.collect_rate" class="sel">
            <option :value="100">100%（乐观）</option>
            <option :value="95">95%</option>
            <option :value="90">90%（默认）</option>
            <option :value="80">80%（保守）</option>
          </select>
          <button v-if="canWrite" class="btn btn-primary btn-sm" :disabled="busy" @click="doForecast">
            {{ busy ? '计算中…' : '重新预测' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="loadForecasts">历史预测</button>
        </div>
      </div>

      <div v-if="fc" class="fc-body">
        <div class="fc-sum">
          <div class="fc-cell">
            <span>期初现金</span><b>{{ money(fc.opening_cash) }}</b>
          </div>
          <div class="fc-cell">
            <span>{{ fc.weeks }} 周流入</span><b class="amt-green">{{ money(fc.inflow_total) }}</b>
          </div>
          <div class="fc-cell">
            <span>{{ fc.weeks }} 周流出</span><b class="amt-red">{{ money(fc.outflow_total) }}</b>
          </div>
          <div class="fc-cell">
            <span>期末现金</span>
            <b :class="fc.closing_cash >= 0 ? 'amt-green' : 'amt-red'">{{ money(fc.closing_cash) }}</b>
          </div>
          <div class="fc-cell" :class="fc.gap_amount > 0 ? 'cell-bad' : 'cell-ok'">
            <span>{{ fc.gap_amount > 0 ? '最大缺口' : '最低现金' }}</span>
            <b :class="fc.gap_amount > 0 ? 'amt-red' : 'amt-green'">
              {{ money(fc.gap_amount > 0 ? fc.gap_amount : fc.min_cash) }}
            </b>
            <small v-if="fc.gap_amount > 0">第 {{ fc.first_neg_week }} 周转负 · 最深第 {{ fc.min_week }} 周</small>
            <small v-else>全程未出现缺口</small>
          </div>
        </div>

        <!-- 现金曲线 -->
        <div class="chart-card">
          <div class="chart-head">
            <b>现金余额走势</b>
            <small>柱子高度按绝对值缩放；红色为负（断粮）</small>
          </div>
          <!-- 零轴：正值向上、负值向下。同一方向堆柱子会让人以为「蓝的和红的一样高」 -->
          <div class="bars">
            <div v-for="w in fc.weeks_detail" :key="w.week_no" class="bar-col"
              :title="'W' + w.week_no + ' 余额 ' + money(w.closing)">
              <div class="bar-up">
                <div v-if="!w.is_negative" class="bar bar-pos" :style="{ height: barHeight(w.closing) }"></div>
              </div>
              <div class="bar-zero"></div>
              <div class="bar-down">
                <div v-if="w.is_negative" class="bar bar-neg" :style="{ height: barHeight(w.closing) }"></div>
              </div>
              <span class="bar-lab">{{ w.week_no }}</span>
            </div>
          </div>
          <div class="chart-foot">
            <span>W1 {{ fc.weeks_detail[0] && fc.weeks_detail[0].week_start }}</span>
            <span>W{{ fc.weeks }} {{ fc.weeks_detail[fc.weeks_detail.length - 1] && fc.weeks_detail[fc.weeks_detail.length - 1].week_end }}</span>
          </div>
        </div>

        <!-- 逐周明细 -->
        <div class="table-wrap">
          <table class="fc-tbl">
            <thead>
              <tr>
                <th style="width: 54px">周</th>
                <th style="width: 156px">区间</th>
                <th class="num" style="width: 116px">流入</th>
                <th class="num" style="width: 116px">流出</th>
                <th class="num" style="width: 112px">净额</th>
                <th class="num" style="width: 122px">期末余额</th>
                <th>主要构成</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in fc.weeks_detail" :key="w.week_no" :class="w.is_negative ? 'row-error' : ''">
                <td class="mono tiny">W{{ w.week_no }}</td>
                <td class="tiny">{{ w.week_start }} ~ {{ w.week_end }}</td>
                <td class="num amt-green">{{ w.inflow ? money(w.inflow) : '—' }}</td>
                <td class="num amt-red">{{ w.outflow ? money(w.outflow) : '—' }}</td>
                <td class="num" :class="w.net >= 0 ? 'amt-green' : 'amt-red'">{{ w.net ? money(w.net) : '—' }}</td>
                <td class="num" :class="w.is_negative ? 'amt-red' : ''"><b>{{ money(w.closing) }}</b></td>
                <td class="wrap tiny muted">{{ weekBrief(w) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="foot-note">
          预测假设：按期回收 {{ fc.collect_rate }}%；
          逾期 1-30 天 {{ fc.overdue_rates.d1_30 }}% / 31-60 天 {{ fc.overdue_rates.d31_60 }}% /
          61-90 天 {{ fc.overdue_rates.d61_90 }}% / 90 天以上 {{ fc.overdue_rates.d90p }}%。
          逾期应收按档摊到第 1/3/5/8 周 —— 老账不会下周就回来。
        </p>
      </div>
      <div v-else class="empty-box">还没有预测。选好基准日点「重新预测」。</div>
    </div>

    <!-- ==================== 2. 账龄 ==================== -->
    <div v-if="tab === 'aging'">
      <p class="hint-bar">
        <b>分档按「逾期天数」而不是「账龄」。</b>账期 90 天的单子开票第 60 天还是正常的，
        按开票日分档会把它误判成老账。两个口径都给了：账龄看「钱在外面多久」，逾期看「该收没收多久」。
      </p>

      <div class="ag-bar">
        <div class="mini-tabs">
          <button :class="{ on: agKind === 'ar' }" @click="switchAging('ar')">应收账款</button>
          <button :class="{ on: agKind === 'ap' }" @click="switchAging('ap')">应付账款</button>
        </div>
        <div class="ag-stat">
          <label class="chk"><input type="checkbox" v-model="includeIc" @change="loadAging" /> 含集团内部往来</label>
          <span>合计 <b>{{ money(ag.total) }}</b></span>
          <span>逾期 <b class="amt-red">{{ money(ag.overdue_amount) }}</b>（{{ ag.overdue_pct }}%）</span>
          <span>平均账龄 <b>{{ ag.avg_age_days }}</b> 天</span>
          <span>平均逾期 <b :class="ag.avg_overdue_days > 0 ? 'amt-red' : ''">{{ ag.avg_overdue_days }}</b> 天</span>
        </div>
      </div>

      <p v-if="ag.ic_excluded_count && !includeIc" class="ic-note">
        已剔除集团内部往来 {{ ag.ic_excluded_amount ? money(ag.ic_excluded_amount) : 0 }} 元（{{ ag.ic_excluded_count }} 张）——
        合并层面这些不是对外应收，算进账龄会把逾期占比抬高。勾选上方「含集团内部往来」可以看全量。
      </p>

      <!-- 分档条 -->
      <div class="bucket-row">
        <div v-for="b in ag.buckets" :key="b.key" class="bucket" :class="'bk-' + b.key">
          <span class="bk-label">{{ b.label }}</span>
          <b class="bk-amt">{{ money(b.amount) }}</b>
          <span class="bk-meta">{{ b.count }} 笔 · {{ b.pct }}%</span>
          <div class="bk-bar"><i :style="{ width: Math.max(b.pct, 0.6) + '%' }"></i></div>
        </div>
      </div>

      <!-- 按对方汇总 -->
      <div class="block">
        <h4>{{ agKind === 'ar' ? '按客户' : '按供应商' }} <small>金额从大到小，最上面那家先打电话</small></h4>
        <div class="table-wrap">
          <table class="party-tbl">
            <thead>
              <tr>
                <th style="width: 250px">{{ agKind === 'ar' ? '客户' : '供应商' }}</th>
                <th class="num" style="width: 130px">未结金额</th>
                <th class="num" style="width: 86px">占比</th>
                <th class="num" style="width: 80px">笔数</th>
                <th class="num" style="width: 106px">最长逾期</th>
                <th style="width: 116px">最早到期</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in ag.parties" :key="p.name">
                <td class="tiny">{{ p.name }}</td>
                <td class="num">{{ money(p.amount) }}</td>
                <td class="num muted">{{ p.pct }}%</td>
                <td class="num">{{ p.count }}</td>
                <td class="num" :class="p.max_overdue > 90 ? 'amt-red' : p.max_overdue > 30 ? 'amt-orange' : ''">
                  {{ p.max_overdue > 0 ? p.max_overdue + ' 天' : '未逾期' }}
                </td>
                <td class="tiny mono">{{ p.oldest_due }}</td>
                <td>
                  <span v-if="p.max_overdue > 90" class="pill p-bad">重点催收</span>
                  <span v-else-if="p.max_overdue > 30" class="pill p-wait">需跟进</span>
                  <span v-else-if="p.max_overdue > 0" class="pill p-wait">已逾期</span>
                  <span v-else class="pill p-ok">正常</span>
                </td>
              </tr>
              <tr v-if="!ag.parties.length">
                <td colspan="7" class="empty">本期没有未结{{ agKind === 'ar' ? '应收' : '应付' }}。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 逐单明细 -->
      <div class="block">
        <h4>逐单明细 <small>共 {{ ag.rows.length }} 张，按到期日排；已逾期的排在前面</small></h4>
        <div class="table-wrap">
          <table class="doc-tbl">
            <thead>
              <tr>
                <th style="width: 158px">单号</th>
                <th style="width: 210px">对方</th>
                <th class="num" style="width: 116px">金额</th>
                <th class="num" style="width: 116px">未结</th>
                <th style="width: 104px">开票日</th>
                <th style="width: 104px">到期日</th>
                <th class="num" style="width: 84px">账龄</th>
                <th class="num" style="width: 94px">逾期</th>
                <th style="width: 112px">分档</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in ag.rows" :key="r.id" :class="r.overdue_days > 90 ? 'row-error' : r.overdue_days > 0 ? 'row-warn' : ''">
                <td class="mono tiny">{{ r.bill_no }}</td>
                <td class="tiny">{{ r.party_name || '—' }}</td>
                <td class="num">{{ money(r.amount) }}</td>
                <td class="num"><b>{{ money(r.open_amount) }}</b></td>
                <td class="tiny mono">{{ r.bill_date }}</td>
                <td class="tiny mono">{{ r.due_date }}</td>
                <td class="num">{{ r.age_days }} 天</td>
                <td class="num" :class="r.overdue_days > 90 ? 'amt-red' : r.overdue_days > 0 ? 'amt-orange' : 'muted'">
                  {{ r.overdue_days > 0 ? r.overdue_days + ' 天' : '未到期' }}
                </td>
                <td class="tiny">{{ r.bucket_label }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 3. 经营指标 ==================== -->
    <div v-if="tab === 'kpi'">
      <p class="hint-bar">
        每个指标都标了口径 —— <b>没有口径的数字不能用</b>。
        周转类指标在日均收入/成本低于 500 元时显示「—」，因为小样本算出来的天数没有参考价值。
      </p>

      <div v-if="kpiSampleNote" class="note-box">{{ kpiSampleNote }}</div>

      <div class="kpi-grid">
        <div v-for="k in kpiList" :key="k.key" class="kpi-card" :class="kpiClass(k)">
          <div class="kpi-top">
            <span>{{ k.label }}</span>
            <em v-if="k.key === 'net_margin' || k.key === 'gross_margin' || k.key === 'cash_cycle' || k.key === 'top3_pct'" class="kpi-flag">关键</em>
          </div>
          <b class="kpi-val">{{ k.value === null ? '—' : fmtVal(k) }}</b>
          <div class="kpi-cal">{{ k.caliber }}</div>
        </div>
      </div>

      <div class="block">
        <h4>近 12 个月趋势 <small>收入/成本柱状 + 净利润折线（按当期口径实时算，不读快照）</small></h4>
        <div class="trend-card">
          <div class="trend-bars">
            <div v-for="t in trend" :key="t.period" class="tr-col"
              :title="t.period + (isEmptyMonth(t) ? '（本期无凭证）' : ' 收入 ' + money(t.income) + ' 净利 ' + money(t.net))">
              <!-- 没凭证的月份不能画成 0 高柱：那看起来像「这个月一分钱没做」，其实是系统还没数据 -->
              <div v-if="isEmptyMonth(t)" class="tr-none"><span>无</span></div>
              <div v-else class="tr-stack">
                <div class="tr-exp" :style="{ height: trH(t.expense) }"></div>
                <div class="tr-inc" :style="{ height: trH(t.income) }"></div>
              </div>
              <span class="tr-lab" :class="isEmptyMonth(t) ? 'tr-lab-empty' : ''">{{ t.period.slice(5) }}</span>
            </div>
          </div>
          <div class="trend-legend">
            <span><i class="lg-inc"></i>收入</span>
            <span><i class="lg-exp"></i>成本费用</span>
          </div>
        </div>
        <div class="table-wrap" style="margin-top: 10px">
          <table class="trend-tbl">
            <thead>
              <tr>
                <th style="width: 98px">期间</th>
                <th class="num">收入</th>
                <th class="num">成本费用</th>
                <th class="num">净利润</th>
                <th class="num">净利率</th>
                <th class="num">现金</th>
                <th class="num">应收</th>
                <th class="num">应付</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in trend" :key="t.period">
                <td class="mono tiny">{{ t.period }}</td>
                <td class="num">{{ isEmptyMonth(t) ? '—' : money(t.income) }}</td>
                <td class="num">{{ isEmptyMonth(t) ? '—' : money(t.expense) }}</td>
                <td class="num" :class="isEmptyMonth(t) ? 'muted' : t.net >= 0 ? 'amt-green' : 'amt-red'">
                  {{ isEmptyMonth(t) ? '—' : money(t.net) }}
                </td>
                <td class="num" :class="t.net >= 0 ? 'amt-green' : 'amt-red'">
                  {{ t.income > 0 ? Math.round((t.net / t.income) * 1000) / 10 + '%' : '—' }}
                </td>
                <td class="num">{{ money(t.cash) }}</td>
                <td class="num">{{ money(t.ar) }}</td>
                <td class="num">{{ money(t.ap) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 4. 预测回看 ==================== -->
    <div v-if="tab === 'variance'">
      <p class="hint-bar">
        <b>预测准不准，只有回看才知道。</b>把过去那些周的「预计收款」和实际收付款对上；
        如果连续几周都收不到预期的 60%，说明回款假设太乐观，应该把按期回收率往下调。
      </p>

      <div class="va-bar">
        <select v-model="vaId" class="sel" @change="loadVariance">
          <option v-for="f in forecasts" :key="f.id" :value="f.id">
            {{ f.forecast_no }} · 基准 {{ f.base_date }} · {{ f.weeks }} 周{{ f.base_date <= today ? '（可回看）' : '（全在未来）' }}{{ f.gap_amount > 0 ? ' · 有缺口' : '' }}
          </option>
        </select>
        <span class="tiny muted" style="margin-left: 8px">只能回看基准日已过去的批次</span>
      </div>

      <div v-if="va" class="va-body">
        <div v-if="!va.past_weeks" class="empty-box">
          这批预测的 {{ va.forecast.weeks }} 个周次都还没过去（基准日 {{ va.forecast.base_date }}），暂时没有实际数可比。<br />
          等几周再来看，或在上方选一个基准日更早的批次。
        </div>
        <template v-else>
          <div class="va-sum">
            <div class="va-cell">
              <span>已过去的周</span><b>{{ va.past_weeks }} 周</b>
            </div>
            <div class="va-cell">
              <span>预计流入</span><b>{{ money(va.plan_in_total) }}</b>
            </div>
            <div class="va-cell">
              <span>实际流入</span><b>{{ money(va.actual_in_total) }}</b>
            </div>
            <div class="va-cell" :class="va.accuracy >= 90 ? 'cell-ok' : va.accuracy >= 70 ? '' : 'cell-bad'">
              <span>达成率</span>
              <b :class="va.accuracy >= 90 ? 'amt-green' : va.accuracy >= 70 ? 'amt-orange' : 'amt-red'">
                {{ va.accuracy === null ? '—' : va.accuracy + '%' }}
              </b>
              <small>{{ accHint }}</small>
            </div>
          </div>

          <div v-if="va.no_actual_data" class="note-box">
            这段时间<b>没有任何收付款记录</b>，无法对比 —— 不是预测全错，而是实际数没登记。
            先把收付款补录到「往来账」，回看才有意义。
          </div>
          <div v-else-if="va.accuracy !== null && va.accuracy < 50" class="note-box">
            达成率只有 {{ va.accuracy }}%，说明当时的回款假设过于乐观。下一轮预测建议把「按期回收率」从
            {{ va.forecast.collect_rate }}% 往下调，别按满额排付款计划。
          </div>

          <div class="table-wrap">
            <table class="va-tbl">
              <thead>
                <tr>
                  <th style="width: 54px">周</th>
                  <th style="width: 156px">区间</th>
                  <th class="num" style="width: 116px">预计流入</th>
                  <th class="num" style="width: 116px">实际流入</th>
                  <th class="num" style="width: 108px">差异</th>
                  <th class="num" style="width: 116px">预计流出</th>
                  <th class="num" style="width: 116px">实际流出</th>
                  <th class="num" style="width: 108px">差异</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="w in va.weeks" :key="w.week_no" :class="!w.is_past ? 'row-future' : ''">
                  <td class="mono tiny">W{{ w.week_no }}</td>
                  <td class="tiny">{{ w.week_start }} ~ {{ w.week_end }}</td>
                  <td class="num">{{ money(w.plan_in) }}</td>
                  <td class="num">{{ w.is_past ? money(w.actual_in) : '—' }}</td>
                  <td class="num" :class="diffClass(w.in_diff)">{{ w.is_past ? money(w.in_diff) : '—' }}</td>
                  <td class="num">{{ money(w.plan_out) }}</td>
                  <td class="num">{{ w.is_past ? money(w.actual_out) : '—' }}</td>
                  <td class="num" :class="diffClass(w.out_diff)">{{ w.is_past ? money(w.out_diff) : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="foot-note">差异 = 实际 − 预计。流入为负说明收得比预期少；流出为负说明花得比预期慢（不一定是好事，可能是拖了账）。</p>
        </template>
      </div>
      <div v-else class="empty-box">还没有预测批次。先去「现金预测」跑一次。</div>
    </div>

    <!-- 历史预测弹窗 -->
    <div v-if="showHistory" class="modal-mask" @click.self="showHistory = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>历史预测</h3>
          <button class="x" @click="showHistory = false">×</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap">
            <table class="his-tbl">
              <thead>
                <tr>
                  <th style="width: 146px">批次号</th>
                  <th style="width: 100px">基准日</th>
                  <th style="width: 60px">周数</th>
                  <th class="num" style="width: 110px">期初</th>
                  <th class="num" style="width: 110px">期末</th>
                  <th class="num" style="width: 110px">缺口</th>
                  <th style="width: 84px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in forecasts" :key="f.id" :class="f.gap_amount > 0 ? 'row-error' : ''">
                  <td class="mono tiny">{{ f.forecast_no }}</td>
                  <td class="tiny">{{ f.base_date }}</td>
                  <td class="num">{{ f.weeks }}</td>
                  <td class="num">{{ money(f.opening_cash) }}</td>
                  <td class="num" :class="f.closing_cash >= 0 ? '' : 'amt-red'">{{ money(f.closing_cash) }}</td>
                  <td class="num" :class="f.gap_amount > 0 ? 'amt-red' : 'muted'">{{ f.gap_amount > 0 ? money(f.gap_amount) : '—' }}</td>
                  <td class="ops"><button class="btn btn-ghost btn-sm" @click="openForecast(f.id)">查看</button></td>
                </tr>
                <tr v-if="!forecasts.length">
                  <td colspan="7" class="empty">还没有预测记录。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showHistory = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('cockpit.write'));

const dict = ref({ companies: [], buckets: [] });
const ov = ref({ money: {}, ar: {}, ap: {}, alerts: [], cash_forecast: null });
const ag = ref({ buckets: [], parties: [], rows: [], total: 0, overdue_amount: 0, overdue_pct: 0, avg_age_days: 0, avg_overdue_days: 0 });
const fc = ref(null);
const forecasts = ref([]);
const va = ref(null);
const vaId = ref(null);
const kpiData = ref({ kpis: [], sample_note: null });
const trend = ref([]);
const busy = ref(false);
const showHistory = ref(false);

const today = ref('');
const period = ref('');
const companyId = ref('');
const agKind = ref('ar');
const includeIc = ref(false);
const tab = ref('cash');
const fcForm = reactive({ base_date: '', weeks: 13, collect_rate: 90 });

const tabs = computed(() => [
  { k: 'cash', label: '现金预测', dot: ov.value.cash_forecast && ov.value.cash_forecast.gap_amount > 0 ? '!' : 0 },
  { k: 'aging', label: '账龄分析', dot: ov.value.ar && ov.value.ar.overdue_pct >= 30 ? '!' : 0 },
  { k: 'kpi', label: '经营指标' },
  { k: 'variance', label: '预测回看' }
]);

const cashGap = computed(() => !!(ov.value.cash_forecast && ov.value.cash_forecast.gap_amount > 0));
const arPct = computed(() => (ov.value.ar && ov.value.ar.overdue_pct) || 0);
const gmClass = computed(() => {
  const v = ov.value.money && ov.value.money.gross_margin;
  if (v === null || v === undefined) return 'muted';
  return v >= 20 ? 'amt-green' : v >= 0 ? 'amt-orange' : 'amt-red';
});
const gmHint = computed(() => {
  const v = ov.value.money && ov.value.money.gross_margin;
  if (v === null || v === undefined) return '收入规模不足，样本过小';
  return v >= 30 ? '高于行业常见水平' : v >= 20 ? '健康' : v >= 0 ? '偏薄，注意成本' : '成本高于收入，查成本口径';
});
const kpiList = computed(() => kpiData.value.kpis || []);
const kpiSampleNote = computed(() => kpiData.value.sample_note);
const accHint = computed(() => {
  if (!va.value || va.value.accuracy === null) return '—';
  const a = va.value.accuracy;
  return a >= 90 ? '预测可信，可以按这个排款' : a >= 70 ? '偏差可接受，留意大额单笔' : '回款假设过于乐观，建议下调回收率';
});

const periodOptions = computed(() => {
  const out = [];
  const d = new Date();
  for (let i = 0; i < 15; i++) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
});

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v) {
  if (v === null || v === undefined) return '—';
  return v + '%';
}
function fmtVal(k) {
  if (k.value === null || k.value === undefined) return '—';
  if (k.unit === '元') return money(k.value);
  if (k.unit === '%') return k.value + '%';
  if (k.unit === '天') return k.value + ' 天';
  if (k.unit === '人') return k.value + ' 人';
  return String(k.value);
}
function kpiClass(k) {
  if (k.value === null || k.value === undefined) return 'kpi-na';
  if (['gross_margin', 'net_margin', 'gross_profit', 'net_profit', 'rev_per_head'].includes(k.key)) {
    return k.value >= 0 ? 'kpi-good' : 'kpi-bad';
  }
  if (k.key === 'cash_cycle') return k.value > 120 ? 'kpi-bad' : k.value > 90 ? 'kpi-warn' : 'kpi-good';
  if (k.key === 'top3_pct') return k.value >= 60 ? 'kpi-warn' : 'kpi-good';
  return '';
}
function diffClass(v) {
  if (v === null || v === undefined) return 'muted';
  return v >= 0 ? 'amt-green' : 'amt-red';
}

function barHeight(v) {
  const list = (fc.value && fc.value.weeks_detail) || [];
  // 上下各占一半：用「绝对值最大」做分母，正负两侧同一比例，才看得出谁更深
  const max = Math.max(...list.map((w) => Math.abs(Number(w.closing) || 0)), 1);
  return Math.max(2, Math.round((Math.abs(Number(v) || 0) / max) * 100)) + '%';
}
function trH(v) {
  const max = Math.max(...trend.value.map((t) => Math.max(t.income, t.expense)), 1);
  return Math.max(1, Math.round((Number(v) / max) * 100)) + '%';
}
/** 该月没有任何损益发生额 —— 视为「无数据」而不是「零收入」 */
function isEmptyMonth(t) {
  return Math.abs(Number(t.income) || 0) < 0.01 && Math.abs(Number(t.expense) || 0) < 0.01;
}
function weekBrief(w) {
  const parts = [];
  const inc = (w.inflow_items || []).map((x) => `${catLabel(x.category)} ${Math.round(x.amount)}`);
  const out = (w.outflow_items || []).map((x) => `${catLabel(x.category)} ${Math.round(x.amount)}`);
  if (inc.length) parts.push('进：' + inc.join('、'));
  if (out.length) parts.push('出：' + out.join('、'));
  return parts.join('；') || '—';
}
function catLabel(k) {
  return { ar_collect: '回款', ap_pay: '付货款', payroll: '工资', fixed_cost: '固定费用', tax: '税', other: '其他' }[k] || k;
}

function go(k) {
  tab.value = k;
  if (k === 'aging') loadAging();
  if (k === 'kpi') loadKpis();
  if (k === 'variance') loadVariance();
}

async function loadAll() {
  await Promise.all([loadOverview(), loadForecasts()]);
  if (tab.value === 'aging') loadAging();
  if (tab.value === 'kpi') loadKpis();
}

async function loadOverview(useBackendPeriod = false) {
  // useBackendPeriod=true 时不传期间，让后端按「最近已关账期间」决定 —— 当期往往还没开票，
  // 一进来毛利率/周转天数全是 —，看着像系统坏了
  ov.value = await api.cockpitOverview({
    period: useBackendPeriod ? undefined : period.value,
    company_id: companyId.value || undefined
  });
}
async function loadAging() {
  ag.value = await api.cockpitAging({
    kind: agKind.value,
    company_id: companyId.value || undefined,
    exclude_ic: includeIc.value ? 0 : 1
  });
}
function switchAging(k) {
  agKind.value = k;
  loadAging();
}
async function loadForecasts() {
  forecasts.value = await api.cockpitForecasts({ limit: 20 });
  const latest = forecasts.value.find((f) => !companyId.value || String(f.company_id) === String(companyId.value));
  if (latest) {
    fc.value = await api.cockpitForecast(latest.id);
    if (!vaId.value) vaId.value = latest.id;
  } else {
    fc.value = null;
  }
}
async function openForecast(id) {
  fc.value = await api.cockpitForecast(id);
  showHistory.value = false;
  tab.value = 'cash';
}
async function doForecast() {
  busy.value = true;
  try {
    await api.createForecast({
      base_date: fcForm.base_date,
      weeks: fcForm.weeks,
      collect_rate: fcForm.collect_rate,
      company_id: companyId.value || undefined
    });
    await loadForecasts();
    await loadOverview();
    if (fc.value && fc.value.gap_amount > 0) {
      alert(`预测完成：第 ${fc.value.first_neg_week} 周现金转负，最大缺口 ¥${money(fc.value.gap_amount)}`);
    }
  } catch (e) {
    alert(e.message || '预测失败');
  } finally {
    busy.value = false;
  }
}
async function loadKpis() {
  kpiData.value = await api.cockpitKpis({ period: period.value, company_id: companyId.value || undefined });
  trend.value = await api.cockpitTrend({ months: 12, company_id: companyId.value || undefined });
}
async function loadVariance() {
  if (!vaId.value) {
    va.value = null;
    return;
  }
  va.value = await api.forecastVariance(vaId.value);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

onMounted(async () => {
  dict.value = await api.cockpitDict();
  today.value = todayStr();
  period.value = today.value.slice(0, 7);
  fcForm.base_date = today.value;
  await loadOverview(true);
  // 总览默认看最近已关账期间，期间选择器要跟上，否则下拉显示的和数据对不上
  if (ov.value.period && ov.value.period !== period.value) period.value = ov.value.period;
  await Promise.all([loadForecasts(), loadKpis()]);
  // 回看要选「基准日已经过去」的那批：最新那批通常全在未来，没有实际数可比。
  // 注意用严格小于 —— 基准日就是今天的批次，8 周全在未来，一个可回看的周都没有。
  if (forecasts.value.length) {
    const pastList = forecasts.value.filter((f) => f.base_date < today.value);
    // forecasts 按基准日倒序，取最后一个 = 最接近今天的历史批次
    vaId.value = (pastList.length ? pastList[pastList.length - 1] : forecasts.value[forecasts.value.length - 1]).id;
  }
});
</script>

<style scoped>
.sel { font-size: 12.5px; padding: 5px 9px; border: 1px solid #dfe6f0; border-radius: 7px; background: #fff; color: #16233b; }
.sub { margin: 4px 0 0; font-size: 12.5px; color: #8a94a6; }
.head-ops { display: flex; align-items: center; gap: 8px; }

/* 预警 */
.warn-box { background: #fffaf3; border: 1px solid #f3e0c2; border-radius: 11px; padding: 11px 14px; margin-bottom: 13px; }
.warn-title { font-size: 12.5px; font-weight: 600; color: #b46207; margin-bottom: 8px; }
.warn-row { display: flex; gap: 9px; align-items: flex-start; padding: 6px 0; border-top: 1px dashed #f3e6d2; }
.warn-row:first-of-type { border-top: none; }
.warn-badge { flex: 0 0 auto; font-size: 10.5px; border-radius: 4px; padding: 1px 6px; margin-top: 1px; }
.w-hingh .warn-badge, .w-high .warn-badge { background: #fdecef; color: #c0243c; }
.w-mid .warn-badge { background: #fff3e0; color: #b46207; }
.warn-body b { display: block; font-size: 12.5px; color: #16233b; }
.warn-body span { display: block; font-size: 12px; color: #6b778c; line-height: 1.6; }
.warn-body em { display: block; font-size: 11.5px; color: #b46207; font-style: normal; margin-top: 2px; }
.ok-box { background: #f5fbf7; border: 1px solid #d6ecdd; border-radius: 11px; padding: 11px 14px; margin-bottom: 13px; font-size: 12.5px; color: #15803d; }

/* 指标卡 */
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 18px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.stat-bad { background: #fff6f7; border-color: #f6d4d9; }
.stat-bad strong { color: #d92d45; }
.stat-warn { background: #fffaf2; border-color: #f3e0c2; }

.tabbar { display: flex; align-items: flex-start; margin-bottom: 8px; }
.tabbar .tabs { margin-left: 0; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.tabbar .tabs button { flex: 0 0 auto; white-space: nowrap; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 10px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }

.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.75; margin: 0 0 12px; }
.note-box { background: #fffaf3; border: 1px solid #f3e0c2; border-radius: 9px; padding: 8px 12px; font-size: 12px; color: #b46207; margin-bottom: 12px; }
.foot-note { font-size: 11.5px; color: #9aa4b5; margin: 8px 0 0; line-height: 1.7; }
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
.row-warn { background: #fffdf7; }
.row-future { background: #fbfcfe; color: #9aa4b5; }

.pill { display: inline-block; white-space: nowrap; font-size: 11px; border-radius: 5px; padding: 1px 7px; }
.p-ok { background: #f0faf3; color: #16a34a; }
.p-wait { background: #fff8ec; color: #b46207; }
.p-bad { background: #fdecef; color: #c0243c; }

/* 现金预测 */
.fc-bar { margin-bottom: 10px; }
.fc-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: #6b778c; }
.fc-sum { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 12px; }
.fc-cell { background: #fff; border: 1px solid #e6ebf3; border-radius: 11px; padding: 10px 13px; }
.fc-cell span { display: block; font-size: 11.5px; color: #8a94a6; }
.fc-cell b { display: block; font-size: 17px; color: #16233b; margin: 3px 0 1px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.fc-cell small { font-size: 11px; color: #a9b4c5; }
.cell-ok { background: #f6fbf8; border-color: #d6ecdd; }
.cell-bad { background: #fff6f7; border-color: #f6d4d9; }

.chart-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 13px 15px; margin-bottom: 12px; }
.chart-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.chart-head b { font-size: 12.5px; color: #16233b; }
.chart-head small { font-size: 11px; color: #a9b4c5; }
.bars { display: flex; align-items: stretch; gap: 4px; height: 148px; }
.bar-col { flex: 1; height: 100%; display: flex; flex-direction: column; min-width: 0; }
.bar-up { flex: 1; display: flex; align-items: flex-end; }
.bar-down { flex: 1; display: flex; align-items: flex-start; }
.bar-zero { height: 1px; background: #dfe6f0; flex: 0 0 auto; }
.bar { width: 100%; min-height: 2px; transition: height 0.2s; }
.bar-pos { border-radius: 3px 3px 0 0; }
.bar-neg { border-radius: 0 0 3px 3px; }
.bar-pos { background: linear-gradient(180deg, #7fb3f5, #2b6de5); }
.bar-neg { background: linear-gradient(180deg, #f58a9c, #d92d45); }
.bar-lab { text-align: center; font-size: 9.5px; color: #b6bfcf; margin-top: 3px; }
.chart-foot { display: flex; justify-content: space-between; font-size: 10.5px; color: #b6bfcf; margin-top: 2px; }

.fc-tbl { min-width: 1000px; width: 100%; }
.fc-tbl th { text-align: left; }
.fc-tbl th.num, .fc-tbl td.num { text-align: right; padding-right: 12px; }

/* 账龄 */
.ag-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
.ag-stat { display: flex; gap: 16px; font-size: 12.5px; color: #6b778c; flex-wrap: wrap; }
.ag-stat b { color: #16233b; }
.chk { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: #4a566e; }
.chk input { margin: 0; }
.ic-note { background: #f8fafd; border: 1px solid #e4ecf7; border-radius: 8px; padding: 7px 11px; font-size: 11.5px; color: #6b778c; line-height: 1.65; margin: 0 0 10px; }
.mini-tabs { display: flex; gap: 6px; }
.mini-tabs button { font-size: 12.5px; padding: 5px 14px; border: 1px solid #dfe6f0; background: #fff; border-radius: 8px; color: #6b778c; cursor: pointer; }
.mini-tabs button.on { background: #eef4ff; border-color: #cfdcf5; color: #2b6de5; font-weight: 600; }

.bucket-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 4px; }
.bucket { background: #fff; border: 1px solid #e6ebf3; border-radius: 11px; padding: 10px 12px; }
.bk-label { display: block; font-size: 11.5px; color: #8a94a6; }
.bk-amt { display: block; font-size: 16px; color: #16233b; margin: 4px 0 2px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.bk-meta { font-size: 11px; color: #a9b4c5; }
.bk-bar { height: 4px; background: #f1f4f9; border-radius: 3px; margin-top: 7px; overflow: hidden; }
.bk-bar i { display: block; height: 100%; border-radius: 3px; background: #2b6de5; }
.bk-current .bk-bar i { background: #16a34a; }
.bk-d1_30 .bk-bar i { background: #f0b429; }
.bk-d31_60 .bk-bar i { background: #f08b29; }
.bk-d61_90 .bk-bar i { background: #e2553f; }
.bk-d90p .bk-bar i { background: #c0243c; }
.bk-d90p { background: #fff7f8; border-color: #f6d4d9; }

.party-tbl { min-width: 1000px; width: 100%; }
.party-tbl th { text-align: left; }
.party-tbl th.num, .party-tbl td.num { text-align: right; padding-right: 12px; }
.doc-tbl { min-width: 1160px; width: 100%; }
.doc-tbl th { text-align: left; }
.doc-tbl th.num, .doc-tbl td.num { text-align: right; padding-right: 12px; }

/* 经营指标 */
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 11px; }
.kpi-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.kpi-top { display: flex; justify-content: space-between; align-items: center; }
.kpi-top span { font-size: 12px; color: #8a94a6; }
.kpi-flag { font-size: 10px; font-style: normal; color: #2b6de5; background: #eef4ff; border-radius: 4px; padding: 1px 5px; }
.kpi-val { display: block; font-size: 20px; color: #16233b; margin: 6px 0 5px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.kpi-cal { font-size: 10.5px; color: #b0b9c8; line-height: 1.55; }
.kpi-good .kpi-val { color: #16a34a; }
.kpi-bad .kpi-val { color: #d92d45; }
.kpi-warn .kpi-val { color: #d97706; }
.kpi-warn { background: #fffaf3; border-color: #f3e0c2; }
.kpi-bad { background: #fff7f8; border-color: #f6d4d9; }
.kpi-na .kpi-val { color: #c3cbd8; }

.trend-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 13px 15px; }
.trend-bars { display: flex; align-items: flex-end; gap: 6px; height: 132px; }
.tr-col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
.tr-stack { flex: 1; display: flex; align-items: flex-end; gap: 2px; }
.tr-inc { flex: 1; background: linear-gradient(180deg, #7fb3f5, #2b6de5); border-radius: 2px 2px 0 0; min-height: 1px; }
.tr-exp { flex: 1; background: #ffd7dd; border-radius: 2px 2px 0 0; min-height: 1px; }
.tr-lab { text-align: center; font-size: 9.5px; color: #b6bfcf; margin-top: 3px; }
.tr-lab-empty { color: #d7dde8; }
.tr-none { flex: 1; display: flex; align-items: flex-end; justify-content: center; border-bottom: 1px dashed #eef1f7; }
.tr-none span { font-size: 9.5px; color: #d7dde8; padding-bottom: 2px; }
.trend-legend { display: flex; gap: 16px; font-size: 11px; color: #8a94a6; margin-top: 8px; }
.trend-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.lg-inc { background: #2b6de5; }
.lg-exp { background: #ffd7dd; }
.trend-tbl { min-width: 900px; width: 100%; }
.trend-tbl th { text-align: left; }
.trend-tbl th.num, .trend-tbl td.num { text-align: right; padding-right: 12px; }

/* 预测回看 */
.va-bar { margin-bottom: 10px; }
.va-sum { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
.va-cell { background: #fff; border: 1px solid #e6ebf3; border-radius: 11px; padding: 10px 13px; }
.va-cell span { display: block; font-size: 11.5px; color: #8a94a6; }
.va-cell b { display: block; font-size: 17px; color: #16233b; margin: 3px 0 1px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.va-cell small { font-size: 11px; color: #a9b4c5; }
.va-tbl { min-width: 940px; width: 100%; }
.va-tbl th { text-align: left; }
.va-tbl th.num, .va-tbl td.num { text-align: right; padding-right: 12px; }

.block { margin-top: 18px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: #16233b; }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 11.5px; color: #9aa4b5; }
.his-tbl { min-width: 760px; width: 100%; }
.his-tbl th { text-align: left; }
.his-tbl th.num, .his-tbl td.num { text-align: right; padding-right: 12px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .fc-sum { grid-template-columns: repeat(2, 1fr); }
  .va-sum { grid-template-columns: repeat(2, 1fr); }
  .bucket-row { grid-template-columns: repeat(2, 1fr); }
  .kpi-grid { grid-template-columns: 1fr; }
  .head-ops { flex-wrap: wrap; }
  .ag-stat { gap: 10px; }
  .bars { height: 96px; }
  .trend-bars { height: 104px; }
}
</style>
