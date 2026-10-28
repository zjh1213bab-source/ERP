<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>资金计划（13 周现金流）</h2>
        <p class="sub">
          回答「<b>这周钱够不够、哪周会断、差多少</b>」。支出侧全部按<b>已确定的单据</b>排：
          已开票应付按真实到期日、<b>逾期的全部排第 1 周</b>（不假设还能拖）、
          待开票（货已收票未到）按收货日+账期估算。<b>三档情景只改收入侧</b> ——
          「乐观」不能意味着「少还钱」。
        </p>
      </div>
      <div class="head-ops">
        <select v-model="scenario" class="select" style="width: 120px" @change="load">
          <option value="conservative">保守</option>
          <option value="base">基准</option>
          <option value="optimistic">乐观</option>
        </select>
        <select v-model.number="weeks" class="select" style="width: 100px" @change="load">
          <option :value="8">8 周</option>
          <option :value="13">13 周</option>
          <option :value="26">26 周</option>
        </select>
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="cards c5">
      <div class="stat-card accent">
        <div class="label">期初现金</div>
        <div class="value">{{ money(sum.opening_cash) }}<small>元</small></div>
        <div class="foot">总账 1002（库存现金+银行存款）</div>
      </div>
      <div class="stat-card">
        <div class="label">{{ plan.weeks || 13 }} 周预计回款</div>
        <div class="value" style="color: #16a34a">{{ money(sum.total_inflow) }}<small>元</small></div>
        <div class="foot">应收 {{ money(sum.ar_open) }} × 回收率</div>
      </div>
      <div class="stat-card">
        <div class="label">{{ plan.weeks || 13 }} 周预计支出</div>
        <div class="value" style="color: #d92d45">{{ money(sum.total_outflow) }}<small>元</small></div>
        <div class="foot">应付 {{ money(sum.ap_open) }} + 待票 {{ money(sum.ap_pending) }}</div>
      </div>
      <div class="stat-card" :class="{ warn: sum.gap }">
        <div class="label">最低点</div>
        <div class="value" :style="{ color: sum.gap ? '#d92d45' : '#16305f' }">
          {{ money(sum.min_cash) }}<small>元</small>
        </div>
        <div class="foot">{{ sum.min_week ? '第 ' + sum.min_week + ' 周' : '期初就是最低点' }}</div>
      </div>
      <div class="stat-card" :class="{ danger: sum.first_neg_week }">
        <div class="label">首次转负 / 缺口</div>
        <div class="value" :style="{ color: sum.first_neg_week ? '#d92d45' : '#16a34a' }">
          {{ sum.first_neg_week ? '第 ' + sum.first_neg_week + ' 周' : '不会断' }}
        </div>
        <div class="foot">{{ sum.gap ? '缺口 ' + money(sum.gap) + ' 元' : '现金全程为正' }}</div>
      </div>
    </div>

    <!-- 应收风险：这是最容易被自欺欺人的地方 -->
    <div v-if="sum.ar_at_risk" class="banner warn">
      <b>应收 {{ money(sum.ar_open) }} 里，按当前回收率只能收回 {{ money(sum.ar_expect) }}</b>
      <span>
        差的 <b>{{ money(sum.ar_at_risk) }}</b> 不是「晚点能收回」，而是按历史逾期表现<b>大概率收不回来</b>的部分
        （逾期越久折得越多：未到期 95%、逾期 90 天以上 25%）。
        做资金计划要按这个数算，不能按账面应收算 —— 否则计划永远「看起来很宽裕」。
      </span>
    </div>

    <!-- 三档对比 -->
    <div class="panel-card">
      <h3>三档情景对比</h3>
      <div class="table-wrap">
        <table class="data sm">
          <thead>
            <tr>
              <th>情景</th><th class="num">预计回款</th><th class="num">预计支出</th>
              <th class="num">期末现金</th><th class="num">最低点</th><th>断点周</th><th class="num">缺口</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in cmp.rows" :key="r.scenario" :class="{ 'row-cur': r.scenario === scenario }">
              <td>
                <b>{{ r.label }}</b>
                <span v-if="r.scenario === scenario" class="tag blue" style="margin-left: 6px">当前</span>
              </td>
              <td class="num">{{ money(r.total_inflow) }}</td>
              <td class="num">{{ money(r.total_outflow) }}</td>
              <td class="num strong">{{ money(r.closing_cash) }}</td>
              <td class="num" :style="{ color: r.min_cash < 0 ? '#d92d45' : '' }">{{ money(r.min_cash) }}</td>
              <td class="tiny" :style="{ color: r.first_neg_week ? '#d92d45' : '#16a34a' }">
                {{ r.first_neg_week ? '第 ' + r.first_neg_week + ' 周' : '不会断' }}
              </td>
              <td class="num" :style="{ color: r.gap ? '#d92d45' : '' }">{{ r.gap ? money(r.gap) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tiny muted" style="margin: 10px 0 0">
        三档<b>支出完全相同</b>（{{ cmp.outflow_consistent ? '已校验一致' : '⚠ 不一致，需排查' }}）——
        只有回款率不同。如果哪天看到「乐观情景支出更少」，那是错的。
      </p>
    </div>

    <!-- 逐周 -->
    <div class="panel-card">
      <div class="toolbar">
        <h3 style="margin: 0">逐周现金流</h3>
        <span class="spacer"></span>
        <span class="tiny muted">点某一行展开这一周的明细</span>
      </div>

      <div class="table-wrap" style="margin-top: 12px">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 60px">周</th>
              <th>区间</th>
              <th class="num">期初</th>
              <th class="num">流入</th>
              <th class="num">流出</th>
              <th class="num">净额</th>
              <th class="num">期末</th>
              <th style="width: 40px"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="w in plan.weeks_detail" :key="w.week_no">
              <tr
                :class="{ 'row-neg': w.closing < 0, 'row-open': expanded[w.week_no] }"
                style="cursor: pointer"
                @click="toggle(w.week_no)"
              >
                <td><b>{{ w.week_no }}</b></td>
                <td class="tiny nowrap">{{ w.week_start }} → {{ w.week_end }}</td>
                <td class="num">{{ money(w.opening) }}</td>
                <td class="num" style="color: #16a34a">{{ w.inflow ? money(w.inflow) : '—' }}</td>
                <td class="num" style="color: #d92d45">{{ w.outflow ? money(w.outflow) : '—' }}</td>
                <td class="num" :style="{ color: w.net < 0 ? '#d92d45' : w.net > 0 ? '#16a34a' : '' }">
                  {{ money(w.net) }}
                </td>
                <td class="num strong" :style="{ color: w.closing < 0 ? '#d92d45' : '' }">{{ money(w.closing) }}</td>
                <td class="tiny muted">{{ expanded[w.week_no] ? '▾' : '▸' }}</td>
              </tr>
              <tr v-if="expanded[w.week_no]" class="detail-row">
                <td colspan="8">
                  <div class="detail-grid">
                    <div>
                      <h4>流入（{{ w.inflow_items.length }}）</h4>
                      <div class="table-wrap scroll-box">
                      <table class="data sm">
                        <thead><tr><th>客户</th><th>单据</th><th>依据</th><th class="num">金额</th></tr></thead>
                        <tbody>
                          <tr v-for="(it, i) in w.inflow_items" :key="i">
                            <td class="tiny">{{ it.name || '—' }}</td>
                            <td class="mono tiny">{{ it.doc_no || '—' }}</td>
                            <td class="tiny muted">{{ it.basis }}</td>
                            <td class="num">{{ money(it.amount) }}</td>
                          </tr>
                          <tr v-if="!w.inflow_items.length"><td colspan="4" class="empty">这周没有预计回款</td></tr>
                        </tbody>
                      </table>
                      </div>
                    </div>
                    <div>
                      <h4>流出（{{ w.outflow_items.length }}）</h4>
                      <div class="table-wrap scroll-box">
                      <table class="data sm">
                        <thead><tr><th>对象</th><th>类别</th><th>依据</th><th class="num">金额</th></tr></thead>
                        <tbody>
                          <tr v-for="(it, i) in w.outflow_items" :key="i">
                            <td class="tiny">{{ it.name || '—' }}</td>
                            <td class="tiny">
                              {{ it.label }}
                              <span v-if="it.estimated" class="tag orange tiny">预计</span>
                            </td>
                            <td class="tiny muted">{{ it.basis }}</td>
                            <td class="num">{{ money(it.amount) }}</td>
                          </tr>
                          <tr v-if="!w.outflow_items.length"><td colspan="4" class="empty">这周没有预计支出</td></tr>
                        </tbody>
                      </table>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 回收率口径 -->
    <div class="panel-card">
      <h3>回款按逾期档打折（当前：{{ plan.scenario_label || '基准' }}）</h3>
      <div class="table-wrap">
        <table class="data sm">
          <thead><tr><th>档位</th><th class="num">张数</th><th class="num">未收金额</th><th class="num">回收率</th><th class="num">预计可收</th></tr></thead>
          <tbody>
            <tr v-for="b in plan.buckets" :key="b.key">
              <td>{{ b.label }}</td>
              <td class="num">{{ b.count }}</td>
              <td class="num">{{ money(b.full) }}</td>
              <td class="num">{{ b.rate }}%</td>
              <td class="num strong">{{ money(b.expect) }}</td>
            </tr>
            <tr v-if="!plan.buckets || !plan.buckets.length"><td colspan="5" class="empty">没有未收应收</td></tr>
          </tbody>
        </table>
      </div>
      <p class="tiny muted" style="margin: 10px 0 0">
        逾期越久，越不指望它早回来 —— 除了打折，还会把预计到账时间往后摊（逾期 1-30 天摊到第 1 周、
        31-60 天摊到第 3 周、90 天以上摊到第 8 周）。全压第一周会让预测看起来「下周钱就全到了」。
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';

const plan = ref({ summary: {}, weeks_detail: [], buckets: [], scenario_label: '基准' });
const cmp = ref({ rows: [], outflow_consistent: true });
const scenario = ref('base');
const weeks = ref(13);
const expanded = reactive({});

const sum = computed(() => plan.value.summary || {});

const money = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toggle(no) {
  expanded[no] = !expanded[no];
}

async function load() {
  try {
    const [p, c] = await Promise.all([
      api.cashflowPlan({ weeks: weeks.value, scenario: scenario.value }),
      api.cashflowCompare({ weeks: weeks.value })
    ]);
    plan.value = p;
    cmp.value = c;
    // 默认展开「现金最低」或「首次转负」那一周 —— 那才是需要看的
    Object.keys(expanded).forEach((k) => delete expanded[k]);
    const focus = p.summary.first_neg_week || p.summary.min_week;
    if (focus) expanded[focus] = true;
  } catch (e) {
    alert(e.message);
  }
}

async function reload() {
  await load();
}

onMounted(load);
</script>

<style scoped>
.cards.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.stat-card .foot { margin-top: 8px; font-size: 11.5px; color: #8a94a6; }
.stat-card.danger { border-color: #f6c9d0; background: #fffafb; }
.stat-card.warn { border-color: #f3ddb5; background: #fffdf7; }
.cards.c5 .stat-card .value { font-size: 22px; }

.banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: 13px; line-height: 1.7; border: 1px solid transparent; }
.banner.warn { background: #fff8ec; border-color: #f3ddb5; color: #8a5a12; }

.data td.num, .data th.num { white-space: nowrap; }
.data .tag { white-space: nowrap; }
.nowrap { white-space: nowrap; }
.row-cur td { background: #f6f9ff; }
.row-neg td { background: #fffafa; }
.row-open td { border-bottom: none; }
.detail-row > td { background: #fafbfd; padding: 12px 14px 16px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.detail-grid h4 { margin: 0 0 8px; font-size: 12.5px; color: #16233b; }
/* 第 1 周动辄 40 笔明细，不限高会把整页撑到 4000px，后面的周全被挤下去 */
.scroll-box { max-height: 320px; overflow-y: auto; }

@media (max-width: 900px) {
  .cards.c5 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
