<template>
  <div>
    <div class="page-head">
      <div>
        <h2>智能助手</h2>
        <div class="sub">问数 · 经营解读 · 风险预警（全部基于系统实时数据，无需外部模型）</div>
      </div>
      <button class="btn btn-ghost" @click="loadAll">刷新</button>
    </div>

    <!-- 智能问数 -->
    <div class="panel-card">
      <h3>智能问数 <span class="hint">直接问，返回真实数据</span></h3>
      <div class="toolbar" style="margin-bottom: 10px">
        <input class="input" v-model="q" placeholder="订单号 / 客户名 / 款号，或问：逾期订单、美仓缺货、库存、本月工资、行政费用…" @keyup.enter="ask" style="flex: 1; min-width: 260px" />
        <button class="btn btn-primary" :disabled="asking" @click="ask">{{ asking ? '查询中…' : '查询' }}</button>
      </div>
      <div class="chips">
        <button v-for="c in CHIPS" :key="c" class="chip" @click="quickAsk(c)">{{ c }}</button>
      </div>

      <div v-if="result" style="margin-top: 14px">
        <div class="ans-head">
          <strong>{{ result.title }}</strong>
          <span class="muted" style="font-size: 12.5px">{{ result.summary }}</span>
        </div>
        <div class="table-wrap" v-if="result.rows && result.rows.length">
          <table class="data">
            <thead>
              <tr><th v-for="c in result.columns" :key="c.key" :style="{ textAlign: c.align || 'left' }">{{ c.label }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in result.rows" :key="i">
                <td v-for="c in result.columns" :key="c.key" :style="{ textAlign: c.align || 'left' }">{{ fmtCell(row[c.key]) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="toolbar" style="margin-top: 10px">
          <router-link v-for="l in result.links || []" :key="l.to" :to="l.to" class="btn btn-ghost btn-sm">{{ l.text }}</router-link>
          <button class="btn btn-ghost btn-sm" style="margin-left: auto" :disabled="explaining" @click="explain">
            {{ explaining ? '生成中…' : '让 AI 解读这段数据' }}
          </button>
        </div>
        <pre v-if="aiText" class="ai-box">{{ aiText }}</pre>
      </div>
    </div>

    <!-- 经营解读 -->
    <div class="panel-card">
      <div class="toolbar" style="margin-bottom: 12px">
        <h3 style="margin: 0">经营解读</h3>
        <input class="input" type="month" v-model="period" style="width: 150px" @change="loadReport" />
        <span class="muted" style="font-size: 12px">对比：上月 {{ report.compare && report.compare.prevPeriod }} · 去年同月 {{ report.compare && report.compare.lastYear }}</span>
      </div>

      <div class="cards">
        <div class="stat-card">
          <div class="label">本月订单额（USD）</div>
          <div class="value">${{ money(m.usd) }}</div>
          <div class="delta" :class="cls(m.usdGrowth)">环比 {{ pct(m.usdGrowth) }}</div>
        </div>
        <div class="stat-card">
          <div class="label">订单数</div>
          <div class="value">{{ m.orders }}</div>
          <div class="delta" :class="cls(m.ordersGrowth)">环比 {{ pct(m.ordersGrowth) }}</div>
        </div>
        <div class="stat-card">
          <div class="label">本月发货 / 入库</div>
          <div class="value">{{ m.shipped || 0 }}<small>/ {{ m.instock || 0 }} 单</small></div>
          <div class="delta">结案 {{ m.closed || 0 }} 单</div>
        </div>
        <div class="stat-card accent">
          <div class="label">不良率 / 在产</div>
          <div class="value">{{ m.defectRate || 0 }}<small>%</small></div>
          <div class="delta">在产 {{ m.inProd || 0 }} 单 · 逾期 {{ m.overdue || 0 }} 单</div>
        </div>
      </div>

      <div class="concl">
        <div v-for="(c, i) in report.conclusions || []" :key="i" class="concl-row">
          <span class="concl-tag">{{ c.title }}</span>
          <span>{{ c.text }}</span>
        </div>
      </div>

      <div class="two-col">
        <div>
          <h4 class="sub-h">风险提示</h4>
          <ul class="bullet risk">
            <li v-for="(r, i) in report.risks || []" :key="i">{{ r }}</li>
          </ul>
        </div>
        <div>
          <h4 class="sub-h">建议关注</h4>
          <ul class="bullet tip">
            <li v-for="(t, i) in report.tips || []" :key="i">{{ t }}</li>
          </ul>
        </div>
      </div>

      <div class="two-col" style="margin-top: 6px">
        <div>
          <h4 class="sub-h">本月 TOP 客户</h4>
          <table class="data">
            <thead><tr><th>客户</th><th class="num">单数</th><th class="num">金额USD</th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in m.topCustomers || []" :key="i">
                <td>{{ c.name }}</td><td class="num">{{ c.cnt }}</td><td class="num">${{ money(c.usd) }}</td>
              </tr>
              <tr v-if="!(m.topCustomers || []).length"><td colspan="3" class="empty-cell">本月暂无订单</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <h4 class="sub-h">本月 TOP 款</h4>
          <table class="data">
            <thead><tr><th>款</th><th class="num">件数</th><th class="num">金额USD</th></tr></thead>
            <tbody>
              <tr v-for="(s, i) in m.topStyles || []" :key="i">
                <td>{{ s.name }}</td><td class="num">{{ s.qty }}</td><td class="num">${{ money(s.usd) }}</td>
              </tr>
              <tr v-if="!(m.topStyles || []).length"><td colspan="3" class="empty-cell">本月暂无明细</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 风险预警 -->
    <div class="panel-card">
      <h3>风险预警</h3>
      <div v-if="!d.alerts.length" class="empty-cell">暂无</div>
      <div v-for="(a, i) in d.alerts" :key="i" class="alert-row">
        <span class="tag" :class="a.level === 'danger' ? 'red' : a.level === 'warn' ? 'orange' : a.level === 'ok' ? 'green' : 'blue'">
          {{ a.level === 'danger' ? '紧急' : a.level === 'warn' ? '注意' : a.level === 'ok' ? '正常' : '待办' }}
        </span>
        <span style="font-size: 13px; flex: 1">{{ a.text }}</span>
        <router-link v-if="a.to" :to="a.to" class="link-btn">去处理 →</router-link>
      </div>
    </div>

    <div class="two-col">
      <div class="panel-card">
        <h3>逾期订单</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>订单号</th><th>客户</th><th>交期</th><th></th></tr></thead>
            <tbody>
              <tr v-for="o in d.overdue" :key="o.id">
                <td>{{ o.order_no }}</td>
                <td>{{ o.customer_name || '-' }}</td>
                <td style="color: #d92d45; font-weight: 700">{{ o.delivery_date }}</td>
                <td><button class="link-btn" @click="$router.push('/orders?order=' + o.id)">查看</button></td>
              </tr>
              <tr v-if="!d.overdue.length"><td colspan="4" class="empty-cell">无逾期</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel-card">
        <h3>3 天内到期（未发货）</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>订单号</th><th>客户</th><th>交期</th><th></th></tr></thead>
            <tbody>
              <tr v-for="o in d.dueSoon" :key="o.id">
                <td>{{ o.order_no }}</td>
                <td>{{ o.customer_name || '-' }}</td>
                <td style="font-weight: 700; color: #d97706">{{ o.delivery_date }}</td>
                <td><button class="link-btn" @click="$router.push('/orders?order=' + o.id)">查看</button></td>
              </tr>
              <tr v-if="!(d.dueSoon || []).length"><td colspan="4" class="empty-cell">无临期订单</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel-card">
      <h3>低库存（&lt; 20 件）</h3>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>仓库</th><th>款号</th><th>产品</th><th>颜色</th><th>尺码</th><th class="num">数量</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in d.lowStock" :key="i">
              <td>{{ s.warehouse === 'cn' ? '生产仓' : '美仓' }}</td>
              <td>{{ s.style_no || '-' }}</td>
              <td>{{ s.product_name || '-' }}</td>
              <td>{{ s.color || '-' }}</td>
              <td>{{ s.size || '-' }}</td>
              <td class="num"><span class="tag orange">{{ s.qty }}</span></td>
            </tr>
            <tr v-if="!d.lowStock.length"><td colspan="6" class="empty-cell">无低库存</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';

const CHIPS = ['逾期订单', '美仓缺货', '库存', '本月工资', '行政费用', '报价单', '在产订单', '固定资产'];

const now = new Date();
const period = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
const d = reactive({ alerts: [], overdue: [], dueSoon: [], lowStock: [] });
const report = reactive({ metrics: {}, conclusions: [], risks: [], tips: [], compare: {} });
const m = computed(() => report.metrics || {});

const q = ref('');
const result = ref(null);
const asking = ref(false);
const explaining = ref(false);
const aiText = ref('');

const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (g) => (g === null || g === undefined ? '—' : (g >= 0 ? '+' : '') + g + '%');
const cls = (g) => (g === null || g === undefined ? '' : g >= 0 ? 'up' : 'down');
const fmtCell = (v) => (v === null || v === undefined || v === '' ? '-' : v);

async function ask() {
  if (!q.value.trim()) return;
  asking.value = true;
  aiText.value = '';
  try {
    result.value = await api.assistantQuery(q.value.trim());
  } catch (e) {
    alert(e.message);
  } finally {
    asking.value = false;
  }
}

function quickAsk(text) {
  q.value = text;
  ask();
}

/** 用大模型（或规则式）对刚查到的数据做一段解读 */
async function explain() {
  if (!result.value) return;
  explaining.value = true;
  aiText.value = '';
  try {
    const prompt = `请解读这段查询结果：${result.value.title}。${result.value.summary}。数据：` +
      JSON.stringify(result.value.rows.slice(0, 10));
    const r = await api.aiChat(prompt);
    aiText.value = r.answer;
  } catch (e) {
    aiText.value = e.message;
  } finally {
    explaining.value = false;
  }
}

async function loadInsights() {
  try { Object.assign(d, await api.insights()); } catch (e) { alert(e.message); }
}

async function loadReport() {
  try {
    const r = await api.assistantReport(period.value);
    Object.assign(report, r);
  } catch (e) {
    alert(e.message);
  }
}

function loadAll() {
  loadInsights();
  loadReport();
}

onMounted(loadAll);
</script>

<style scoped>
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  border: 1px solid #dfe5ef; background: #f8fafd; color: #3d4a5f; border-radius: 20px;
  padding: 5px 12px; font-size: 12.5px; cursor: pointer;
}
.chip:hover { border-color: #2563eb; color: #2563eb; background: #eff5ff; }
.ans-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ai-box {
  white-space: pre-wrap; background: #fafcff; border: 1px solid #eef2f7; border-radius: 8px;
  padding: 10px 12px; font-size: 13px; margin: 10px 0 0; font-family: inherit; color: #2b3648;
}
.delta { font-size: 12px; color: #8a94a6; margin-top: 8px; }
.delta.up { color: #d92d45; }
.delta.down { color: #16a34a; }
.concl { margin: 6px 0 16px; }
.concl-row { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px dashed #eef2f7; font-size: 13px; color: #2b3648; }
.concl-tag { flex: none; width: 84px; color: #2563eb; font-weight: 700; font-size: 12.5px; }
.sub-h { margin: 0 0 8px; font-size: 13.5px; color: #16233b; }
.bullet { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.9; }
.bullet.risk { color: #b42318; }
.bullet.tip { color: #4a5568; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.alert-row { display: flex; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px dashed #eef2f7; }
.num { text-align: right; }
@media (max-width: 900px) {
  .two-col { grid-template-columns: 1fr; }
}
</style>
