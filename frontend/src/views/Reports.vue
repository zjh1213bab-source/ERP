<template>
  <div>
    <div class="page-head">
      <div>
        <h2>报表中心</h2>
        <div class="sub">订单 / 生产 / 库存 / 缺货 / 毛利 / 客户 / 工厂 / 账期，均可导出 Excel</div>
      </div>
      <button class="btn btn-primary" :disabled="exporting" @click="doExport">
        {{ exporting ? '导出中…' : '导出当前报表' }}
      </button>
    </div>

    <div class="toolbar" style="margin-bottom: 16px">
      <div class="tabs" style="margin-left: 0">
        <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="switchTab(t.key)">{{ t.label }}</button>
      </div>
      <input
        v-if="hasPeriod"
        class="input"
        type="month"
        v-model="period"
        style="width: 150px; margin-left: auto"
        @change="load"
      />
      <button v-if="hasPeriod" class="btn btn-ghost btn-sm" @click="clearPeriod">全部时间</button>
    </div>

    <!-- ============ 订单 ============ -->
    <template v-if="tab === 'orders'">
      <div class="cards">
        <div class="stat-card"><div class="label">订单总数</div><div class="value">{{ d.orders.total.cnt }}</div></div>
        <div class="stat-card"><div class="label">金额 USD</div><div class="value">${{ money(d.orders.total.usd) }}</div></div>
        <div class="stat-card"><div class="label">金额 CNY</div><div class="value">¥{{ money(d.orders.total.cny) }}</div></div>
        <div class="stat-card"><div class="label">客户数（Top榜）</div><div class="value">{{ d.orders.topCustomers.length }}</div></div>
      </div>
      <div class="panel-card">
        <h3>状态分布（订单数）</h3>
        <div v-for="r in d.orders.byStatus" :key="r.status" class="bar-row">
          <span class="bar-name">{{ statusLabel(r.status) }}</span>
          <div class="bar-track"><div class="bar-fill" :style="{ width: (r.cnt / maxStatus * 100) + '%' }"></div></div>
          <span class="bar-val">{{ r.cnt }}</span>
        </div>
        <div v-if="!d.orders.byStatus.length" class="empty-cell">暂无数据</div>
      </div>
      <div class="panel-card">
        <h3>按状态</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>状态</th><th class="num">订单数</th><th class="num">金额 USD</th><th class="num">金额 CNY</th></tr></thead>
            <tbody>
              <tr v-for="r in d.orders.byStatus" :key="r.status">
                <td>{{ statusLabel(r.status) }}</td><td class="num">{{ r.cnt }}</td>
                <td class="num">${{ money(r.usd) }}</td><td class="num">¥{{ money(r.cny) }}</td>
              </tr>
              <tr v-if="!d.orders.byStatus.length"><td colspan="4" class="empty-cell">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel-card">
        <h3>客户金额 Top 10</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>客户</th><th class="num">订单数</th><th class="num">金额 USD</th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in d.orders.topCustomers" :key="i"><td>{{ c.name }}</td><td class="num">{{ c.cnt }}</td><td class="num">${{ money(c.usd) }}</td></tr>
              <tr v-if="!d.orders.topCustomers.length"><td colspan="3" class="empty-cell">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 生产 ============ -->
    <template v-if="tab === 'production'">
      <div class="cards">
        <div class="stat-card"><div class="label">在产订单</div><div class="value">{{ d.production.inProd }}</div></div>
        <div class="stat-card"><div class="label">工序完成率</div><div class="value">{{ prodPct }}%</div></div>
        <div class="stat-card accent"><div class="label">逾期订单</div><div class="value">{{ d.production.overdue }}</div></div>
        <div class="stat-card"><div class="label">工序总数</div><div class="value">{{ d.production.nodeTotal }}</div></div>
      </div>
      <div class="panel-card">
        <h3>工序进度分布</h3>
        <div v-for="r in d.production.byNode" :key="r.name" class="bar-row">
          <span class="bar-name">{{ r.name }}</span>
          <div class="bar-track" style="display: flex">
            <div :style="{ width: seg(r.done, r) + '%' }" style="background: #16a34a; height: 100%"></div>
            <div :style="{ width: seg(r.doing, r) + '%' }" style="background: #f59e0b; height: 100%"></div>
            <div :style="{ width: seg(r.pending, r) + '%' }" style="background: #cbd5e1; height: 100%"></div>
          </div>
          <span class="bar-legend">{{ r.done || 0 }} / {{ r.doing || 0 }} / {{ r.pending || 0 }}</span>
        </div>
        <div class="muted" style="font-size: 11.5px; margin-top: 6px">绿=已完成　橙=进行中　灰=待开始</div>
      </div>
      <div class="panel-card">
        <h3>各工序情况</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>工序</th><th class="num">已完成</th><th class="num">进行中</th><th class="num">待开始</th></tr></thead>
            <tbody>
              <tr v-for="r in d.production.byNode" :key="r.name">
                <td><strong>{{ r.name }}</strong></td><td class="num">{{ r.done || 0 }}</td>
                <td class="num">{{ r.doing || 0 }}</td><td class="num">{{ r.pending || 0 }}</td>
              </tr>
              <tr v-if="!d.production.byNode.length"><td colspan="4" class="empty-cell">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 库存 ============ -->
    <template v-if="tab === 'stock'">
      <div class="cards">
        <div class="stat-card"><div class="label">生产仓 件数</div><div class="value">{{ whQty('cn') }}</div></div>
        <div class="stat-card"><div class="label">生产仓 SKU</div><div class="value">{{ whSku('cn') }}</div></div>
        <div class="stat-card"><div class="label">美仓 件数</div><div class="value">{{ whQty('us') }}</div></div>
        <div class="stat-card"><div class="label">美仓 SKU</div><div class="value">{{ whSku('us') }}</div></div>
      </div>
      <div class="panel-card">
        <h3>按款库存</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>仓库</th><th>款号</th><th class="num">库存件数</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in d.stock.byStyle" :key="i">
                <td>{{ r.warehouse === 'cn' ? '生产仓' : '美仓' }}</td><td>{{ r.style_no || '-' }}</td>
                <td class="num"><strong>{{ r.qty }}</strong></td>
              </tr>
              <tr v-if="!d.stock.byStyle.length"><td colspan="3" class="empty-cell">暂无库存</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 缺货 ============ -->
    <template v-if="tab === 'shortage'">
      <div class="cards">
        <div class="stat-card"><div class="label">缺货订单</div><div class="value">{{ d.shortage.ordersShort }}</div></div>
        <div class="stat-card accent"><div class="label">缺货件数</div><div class="value">{{ d.shortage.totalShort }}</div></div>
        <div class="stat-card"><div class="label">缺货明细行</div><div class="value">{{ d.shortage.rows.length }}</div></div>
        <div class="stat-card"><div class="label">说明</div><div class="value" style="font-size: 14px; line-height: 1.4">按美仓可用量核对</div></div>
      </div>
      <div class="panel-card">
        <h3>缺货明细（按美仓）</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>订单号</th><th>客户</th><th>款号</th><th>颜色</th><th>尺码</th><th class="num">需求</th><th class="num">美仓可用</th><th class="num">缺货</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in d.shortage.rows" :key="i">
                <td>{{ r.order_no }}</td><td>{{ r.customer_name || '-' }}</td><td>{{ r.style_no || '-' }}</td>
                <td>{{ r.color || '-' }}</td><td>{{ r.size || '-' }}</td><td class="num">{{ r.demand }}</td>
                <td class="num">{{ r.available }}</td><td class="num"><span class="tag red">{{ r.lack }}</span></td>
              </tr>
              <tr v-if="!d.shortage.rows.length"><td colspan="8" class="empty-cell">暂无缺货</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 毛利 ============ -->
    <template v-if="tab === 'profit'">
      <div class="cards">
        <div class="stat-card"><div class="label">收入（已核算订单）</div><div class="value">¥{{ money(d.profit.summary.revenue_costed) }}</div></div>
        <div class="stat-card"><div class="label">成本合计</div><div class="value">¥{{ money(d.profit.summary.cost) }}</div></div>
        <div class="stat-card accent"><div class="label">毛利</div><div class="value">¥{{ money(d.profit.summary.profit) }}</div></div>
        <div class="stat-card"><div class="label">毛利率</div><div class="value">{{ d.profit.summary.margin || 0 }}<small>%</small></div></div>
      </div>

      <div v-if="d.profit.warnings && d.profit.warnings.length" class="alert-bar">
        <div v-for="(w, i) in d.profit.warnings" :key="i" style="margin: 2px 0">⚠️ {{ w }}</div>
      </div>

      <div class="panel-card">
        <h3>按客户毛利</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>客户</th><th class="num">单数</th><th class="num">收入</th><th class="num">成本</th><th class="num">毛利</th><th class="num">毛利率</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in d.profit.byCustomer" :key="i">
                <td>{{ r.name }}</td><td class="num">{{ r.cnt }}</td>
                <td class="num">¥{{ money(r.revenue) }}</td><td class="num">¥{{ money(r.cost) }}</td>
                <td class="num"><strong>¥{{ money(r.profit) }}</strong></td>
                <td class="num"><span class="tag" :class="r.margin >= 20 ? 'green' : r.margin >= 10 ? 'orange' : 'red'">{{ r.margin }}%</span></td>
              </tr>
              <tr v-if="!d.profit.byCustomer.length"><td colspan="6" class="empty-cell">还没有审核通过的成本单，无法计算毛利</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel-card">
        <h3>订单毛利明细</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th class="num">收入</th><th class="num">成本</th><th class="num">毛利</th><th class="num">毛利率</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="r in d.profit.rows" :key="r.id">
                <td>{{ r.order_no }}</td><td>{{ r.customer_name }}</td><td>{{ r.style_name || '-' }}</td>
                <td class="num">¥{{ money(r.revenue) }}</td>
                <td class="num">{{ r.has_cost ? '¥' + money(r.cost) : '-' }}</td>
                <td class="num">{{ r.profit === null ? '-' : '¥' + money(r.profit) }}</td>
                <td class="num">
                  <span v-if="r.margin === null" class="tag gray">缺成本单</span>
                  <span v-else class="tag" :class="r.margin >= 20 ? 'green' : r.margin >= 10 ? 'orange' : 'red'">{{ r.margin }}%</span>
                </td>
                <td>{{ statusLabel(r.status) }}</td>
              </tr>
              <tr v-if="!d.profit.rows.length"><td colspan="8" class="empty-cell">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 客户贡献 ============ -->
    <template v-if="tab === 'customers'">
      <div class="cards">
        <div class="stat-card"><div class="label">活跃客户</div><div class="value">{{ d.customers.summary.active }}</div></div>
        <div class="stat-card"><div class="label">合计金额 CNY</div><div class="value">¥{{ money(d.customers.summary.total_cny) }}</div></div>
        <div class="stat-card accent"><div class="label">第一大客户占比</div><div class="value">{{ d.customers.summary.top1_share }}<small>%</small></div></div>
        <div class="stat-card"><div class="label">逾期单合计</div><div class="value">{{ overdueTotal }}</div></div>
      </div>
      <div v-if="d.customers.summary.top1_share > 50" class="alert-bar">
        ⚠️ 第一大客户占本期金额 {{ d.customers.summary.top1_share }}%，客户集中度偏高，建议分散风险。
      </div>
      <div class="panel-card">
        <h3>客户贡献明细</h3>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>客户</th><th>等级</th><th class="num">单数</th><th class="num">件数</th>
                <th class="num">金额 USD</th><th class="num">金额 CNY</th><th class="num">占比</th>
                <th class="num">单均 USD</th><th class="num">毛利</th><th class="num">毛利率</th>
                <th class="num">逾期单</th><th>最近下单</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in d.customers.rows" :key="r.name + r.customer_id">
                <td><strong>{{ r.name }}</strong></td>
                <td><span class="tag gray">{{ r.level }}</span></td>
                <td class="num">{{ r.cnt }}</td>
                <td class="num">{{ r.qty }}</td>
                <td class="num">${{ money(r.usd) }}</td>
                <td class="num">¥{{ money(r.cny) }}</td>
                <td class="num">
                  <div class="mini-track"><div class="mini-fill" :style="{ width: Math.min(100, r.share) + '%' }"></div></div>
                  {{ r.share }}%
                </td>
                <td class="num">${{ money(r.avg_usd) }}</td>
                <td class="num">{{ r.profit === null ? '-' : '¥' + money(r.profit) }}</td>
                <td class="num">{{ r.margin === null ? '-' : r.margin + '%' }}</td>
                <td class="num"><span v-if="r.overdue_cnt" class="tag red">{{ r.overdue_cnt }}</span><span v-else class="muted">-</span></td>
                <td>{{ r.last_at }}</td>
              </tr>
              <tr v-if="!d.customers.rows.length"><td colspan="12" class="empty-cell">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 工厂产能 ============ -->
    <template v-if="tab === 'factories'">
      <div class="cards">
        <div class="stat-card"><div class="label">工厂/外协数</div><div class="value">{{ d.factories.summary.factories }}</div></div>
        <div class="stat-card"><div class="label">累计分单件数</div><div class="value">{{ d.factories.summary.qty }}</div></div>
        <div class="stat-card"><div class="label">分单金额</div><div class="value">¥{{ money(d.factories.summary.amount) }}</div></div>
        <div class="stat-card accent"><div class="label">未结算金额</div><div class="value">¥{{ money(d.factories.summary.unsettled) }}</div></div>
      </div>
      <div class="panel-card">
        <h3>产能与对账</h3>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>工厂</th><th>类型</th><th class="num">分单次数</th><th class="num">件数</th>
                <th class="num">占比</th><th class="num">金额</th><th class="num">已结算</th><th class="num">未结算</th>
                <th class="num">平均单价</th><th class="num">在产订单</th><th class="num">近 30 天件数</th><th>最近分单</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in d.factories.rows" :key="i">
                <td><strong>{{ r.name }}</strong></td>
                <td><span class="tag" :class="r.type === '外协' ? 'purple' : 'blue'">{{ r.type }}</span></td>
                <td class="num">{{ r.cnt }}</td>
                <td class="num">{{ r.qty }}</td>
                <td class="num">{{ factoryShare(r) }}%</td>
                <td class="num">¥{{ money(r.amount) }}</td>
                <td class="num">¥{{ money(r.settled) }}</td>
                <td class="num">
                  <span :class="r.unsettled > 0 ? 'tag orange' : 'muted'">¥{{ money(r.unsettled) }}</span>
                </td>
                <td class="num">¥{{ money(r.unit_price) }}</td>
                <td class="num">{{ r.in_prod }}</td>
                <td class="num">{{ r.qty_30d }}</td>
                <td>{{ r.last_at }}</td>
              </tr>
              <tr v-if="!d.factories.rows.length"><td colspan="12" class="empty-cell">还没有分单记录</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 账期 ============ -->
    <template v-if="tab === 'receivables'">
      <div class="cards">
        <div class="stat-card"><div class="label">已发货未结案</div><div class="value">{{ d.receivables.summary.open_orders }}<small>单</small></div></div>
        <div class="stat-card accent"><div class="label">敞口金额</div><div class="value">¥{{ money(d.receivables.summary.open_amount) }}</div></div>
        <div class="stat-card"><div class="label">超 60 天</div><div class="value">{{ d.receivables.summary.overdue60_orders }}<small>单 / ¥{{ money(d.receivables.summary.overdue60_amount) }}</small></div></div>
        <div class="stat-card">
          <div class="label">平均回款周期</div>
          <div class="value">{{ d.receivables.summary.avg_cycle === null ? '—' : d.receivables.summary.avg_cycle }}<small>{{ d.receivables.summary.avg_cycle === null ? '' : '天' }}</small></div>
        </div>
      </div>
      <div class="panel-card">
        <h3>账龄分布</h3>
        <div v-for="b in d.receivables.buckets" :key="b.bucket" class="bar-row">
          <span class="bar-name">{{ b.bucket }} 天</span>
          <div class="bar-track"><div class="bar-fill" :class="b.bucket === '90+' ? 'warn' : ''" :style="{ width: agePct(b.amount) + '%' }"></div></div>
          <span class="bar-val">¥{{ money(b.amount) }}</span>
        </div>
        <div class="muted" style="font-size: 11.5px; margin-top: 6px">
          账龄自「首次发货」起算；系统暂无收款台账，敞口 = 已发货未结案订单金额。平均回款周期取「发货→结案」样本 {{ d.receivables.summary.closed_samples }} 单。
        </div>
      </div>
      <div class="panel-card">
        <h3>按客户敞口</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>客户</th><th class="num">未结单数</th><th class="num">敞口金额</th><th class="num">最老账龄</th><th>最老订单</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in d.receivables.byCustomer" :key="i">
                <td><strong>{{ r.name }}</strong></td><td class="num">{{ r.cnt }}</td>
                <td class="num">¥{{ money(r.amount) }}</td>
                <td class="num"><span class="tag" :class="r.max_age > 60 ? 'red' : r.max_age > 30 ? 'orange' : 'gray'">{{ r.max_age }} 天</span></td>
                <td>{{ r.oldest || '-' }}</td>
              </tr>
              <tr v-if="!d.receivables.byCustomer.length"><td colspan="5" class="empty-cell">没有未结案的已发货订单</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel-card">
        <h3>明细</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th class="num">金额 CNY</th><th class="num">金额 USD</th><th>发货日</th><th class="num">账龄</th><th>账龄段</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in d.receivables.rows" :key="i">
                <td>{{ r.order_no }}</td><td>{{ r.customer_name }}</td><td>{{ r.style_name || '-' }}</td>
                <td class="num">¥{{ money(r.amount) }}</td><td class="num">${{ money(r.usd) }}</td>
                <td>{{ r.ship_date }}</td>
                <td class="num"><span class="tag" :class="r.age_days > 60 ? 'red' : r.age_days > 30 ? 'orange' : 'gray'">{{ r.age_days === null ? '-' : r.age_days + ' 天' }}</span></td>
                <td>{{ r.bucket }}</td>
              </tr>
              <tr v-if="!d.receivables.rows.length"><td colspan="8" class="empty-cell">暂无敞口</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';

const tabs = [
  { key: 'orders', label: '订单统计', period: false },
  { key: 'production', label: '生产统计', period: false },
  { key: 'stock', label: '库存统计', period: false },
  { key: 'shortage', label: '缺货统计', period: false },
  { key: 'profit', label: '毛利分析', period: true },
  { key: 'customers', label: '客户贡献', period: true },
  { key: 'factories', label: '工厂产能', period: false },
  { key: 'receivables', label: '账期分析', period: false }
];
const FILE = {
  orders: 'orders-report.csv', production: 'production-report.csv', stock: 'stock-report.csv',
  shortage: 'shortage-report.csv', profit: 'profit-report.csv', customers: 'customer-report.csv',
  factories: 'factory-report.csv', receivables: 'receivables-report.csv'
};
const STATUS_LABEL = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

const tab = ref('orders');
const period = ref('');
const exporting = ref(false);

const emptyProfit = { summary: {}, byCustomer: [], missing: [], rows: [] };
const d = reactive({
  orders: { total: { cnt: 0, usd: 0, cny: 0 }, byStatus: [], byType: [], topCustomers: [] },
  production: { inProd: 0, nodeDone: 0, nodeTotal: 0, overdue: 0, byNode: [] },
  stock: { byWarehouse: [], byStyle: [] },
  shortage: { ordersShort: 0, totalShort: 0, rows: [] },
  profit: { ...emptyProfit },
  customers: { summary: {}, rows: [] },
  factories: { summary: {}, rows: [] },
  receivables: { summary: {}, buckets: [], byCustomer: [], rows: [] }
});

const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const statusLabel = (s) => STATUS_LABEL[s] || s;
const hasPeriod = computed(() => {
  const t = tabs.find((x) => x.key === tab.value);
  return !!(t && t.period);
});
const prodPct = computed(() => (d.production.nodeTotal ? Math.round((d.production.nodeDone / d.production.nodeTotal) * 100) : 0));
const maxStatus = computed(() => Math.max(1, ...d.orders.byStatus.map((r) => Number(r.cnt) || 0)));
const overdueTotal = computed(() => (d.customers.rows || []).reduce((s, r) => s + (Number(r.overdue_cnt) || 0), 0));

function seg(v, row) {
  const total = (Number(row.done) || 0) + (Number(row.doing) || 0) + (Number(row.pending) || 0);
  return total ? ((Number(v) || 0) / total) * 100 : 0;
}
const whQty = (w) => (d.stock.byWarehouse.find((x) => x.warehouse === w) || {}).qty || 0;
const whSku = (w) => (d.stock.byWarehouse.find((x) => x.warehouse === w) || {}).skus || 0;

const factoryQtyTotal = computed(() => (d.factories.rows || []).reduce((s, r) => s + (Number(r.qty) || 0), 0));
function factoryShare(r) {
  const t = factoryQtyTotal.value;
  return t > 0 ? Math.round((Number(r.qty) / t) * 10000) / 100 : 0;
}
const ageMax = computed(() => Math.max(1, ...(d.receivables.buckets || []).map((b) => Number(b.amount) || 0)));
function agePct(v) {
  return ageMax.value > 0 ? (Number(v) || 0) / ageMax.value * 100 : 0;
}

async function load() {
  try {
    if (tab.value === 'orders') d.orders = await api.statsOrders();
    else if (tab.value === 'production') d.production = await api.statsProduction();
    else if (tab.value === 'stock') d.stock = await api.statsStock();
    else if (tab.value === 'shortage') d.shortage = await api.statsShortage();
    else if (tab.value === 'profit') d.profit = await api.statsProfit(period.value);
    else if (tab.value === 'customers') d.customers = await api.statsCustomers(period.value);
    else if (tab.value === 'factories') d.factories = await api.statsFactories();
    else d.receivables = await api.statsReceivables();
  } catch (e) { alert(e.message); }
}

function switchTab(k) { tab.value = k; load(); }
function clearPeriod() { period.value = ''; load(); }

async function doExport() {
  exporting.value = true;
  try {
    const p = hasPeriod.value && period.value ? '?period=' + period.value + '&export=1' : '?export=1';
    const blob = await downloadFile(`/api/stats/${tab.value}${p}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE[tab.value] || 'report.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); } finally { exporting.value = false; }
}

onMounted(load);
</script>

<style scoped>
.bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.bar-name { width: 82px; flex: none; font-size: 12.5px; color: #5b6474; }
.bar-track { flex: 1; background: #f0f3f8; border-radius: 4px; height: 14px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--brand); }
.bar-fill.warn { background: #d92d45; }
.bar-val { width: 96px; flex: none; text-align: right; font-weight: 700; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.bar-legend { width: 96px; flex: none; font-size: 12px; color: var(--ink-mute); }
.alert-bar { background: #fff7e6; border: 1px solid #ffd591; color: #ad6800; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }
.num { text-align: right; }
.mini-track { display: inline-block; vertical-align: middle; width: 54px; height: 6px; background: #eef2f7; border-radius: 3px; overflow: hidden; margin-right: 6px; }
.mini-fill { height: 100%; background: var(--brand); }
.table-wrap { overflow-x: auto; }
</style>
