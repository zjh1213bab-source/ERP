<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>长期投资抵消</h2>
        <p class="sub">
          合并报表里最容易搞错的一块：母公司账上的<b>长期股权投资</b>和子公司账上的<b>实收资本</b>是同一笔钱的两种记法，
          直接相加就把同一块钱算了两次。
          <b>只有子公司才抵消</b>（独立法人、有股权），分公司直接并入；
          差额是<b>商誉</b>（或负商誉），非全资还要确认<b>少数股东权益</b>。
          抵消后<b>资产 = 负债 + 权益</b>必须仍然成立——这是真平衡，不是两边一起虚增。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openNewInv">新建投资</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>长期股权投资</span>
        <strong>{{ (board.stat && board.stat.active) || 0 }}</strong>
        <small>笔持有中{{ board.stat && board.stat.disposed ? ` / ${board.stat.disposed} 笔已处置` : '' }}</small>
      </div>
      <div class="stat">
        <span>长投账面价值</span>
        <strong class="mono">{{ money(board.stat && board.stat.book_value) }}</strong>
        <small>初始成本 {{ money(board.stat && board.stat.cost) }}</small>
      </div>
      <div class="stat">
        <span>权益法核算</span>
        <strong>{{ (board.stat && board.stat.equity_method) || 0 }}</strong>
        <small>其余为成本法（分红不动账面）</small>
      </div>
      <div class="stat" :class="offset.total && offset.total.goodwill ? '' : ''">
        <span>本期商誉</span>
        <strong class="mono">{{ money(offset.total && offset.total.goodwill) }}</strong>
        <small>长投 − 应享权益（不摊销，每年减值测试）</small>
      </div>
      <div class="stat">
        <span>少数股东权益</span>
        <strong class="mono">{{ money(offset.total && offset.total.minority_equity) }}</strong>
        <small>子公司权益 × 少数股东比例</small>
      </div>
      <div class="stat" :class="(offset.total && !offset.total.balanced) || (offset.check && !offset.check.asset_eq_equity) ? 'st-bad' : ''">
        <span>抵消自检</span>
        <strong class="sm">
          {{ offset.total && offset.total.balanced && offset.check && offset.check.asset_eq_equity ? '平衡' : '待检查' }}
        </strong>
        <small>借贷相等 + 资产权益影响恒等</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'inv' }" @click="tab = 'inv'">长期股权投资</button>
        <button :class="{ on: tab === 'offset' }" @click="goOffset">抵消预览</button>
      </div>
    </div>

    <!-- ==================== 投资列表 ==================== -->
    <div v-if="tab === 'inv'">
      <div class="help-bar">
        <b>成本法</b>：账面 = 初始投资成本，子公司分红只确认投资收益、<b>不冲减账面</b>。
        <b>权益法</b>：账面 = 成本 + 累计损益调整 − 累计分红，<b>亏损以账面减至 0 为限</b>（超出部分是「未确认投资损失」，只能账外备查，不能把长投记成负数）。
        持股变化必须留痕，账面价值可逐笔回溯。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>编号</th><th>被投企业</th><th>类型</th><th>核算方法</th>
              <th class="num">持股</th><th class="num">投资成本</th><th class="num">损益调整</th>
              <th class="num">已分红</th><th class="num">账面价值</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" :class="{ 'row-muted': r.status !== 'active' }">
              <td class="mono tiny">{{ r.inv_no }}</td>
              <td>
                {{ r.investee_name }}
                <span v-if="r.investee_type === 'branch'" class="tag orange">分公司？</span>
              </td>
              <td class="tiny">{{ r.investee_type === 'subsidiary' ? '子公司' : (r.investee_type === 'branch' ? '分公司' : '—') }}</td>
              <td><span class="tag" :class="r.method === 'equity' ? 'blue' : 'gray'">{{ r.method_label }}</span></td>
              <td class="num">{{ num(r.share_pct) }}%</td>
              <td class="num tiny">{{ money(r.acquire_cost) }}</td>
              <td class="num tiny" :class="{ 'ok-line': r.equity_adjust > 0, red: r.equity_adjust < 0 }">
                {{ r.equity_adjust ? money(r.equity_adjust) : '' }}
              </td>
              <td class="num tiny muted">{{ r.dividend_received ? money(r.dividend_received) : '' }}</td>
              <td class="num"><b>{{ money(r.book_value) }}</b></td>
              <td><span class="tag" :class="r.status === 'active' ? 'green' : 'gray'">{{ r.status_label }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="openInv(r.id)">明细</button></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="11" class="empty">还没有长期股权投资。子公司不做长投抵消，合并时资产与权益会同时虚增。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="dict.branches && dict.branches.length" class="help-bar" style="margin-top: 12px">
        <b>不参与抵消的主体</b>：{{ dict.branches.map((b) => b.name).join('、') }} —— 分公司不是独立法人，没有股权与实收资本，合并时<b>直接并入</b>。
      </div>
    </div>

    <!-- ==================== 抵消预览 ==================== -->
    <div v-if="tab === 'offset'">
      <div class="toolbar">
        <label class="tiny muted">期间</label>
        <input v-model="period" class="inp" type="month" @change="goOffset" />
        <span class="grow"></span>
        <span class="tiny muted">抵消结果已包含在「多主体与集团合并」生成的合并表中</span>
      </div>

      <div v-if="offset.issues && offset.issues.length" style="margin: 12px 0">
        <div v-for="(x, i) in offset.issues" :key="i" class="issue" :class="'lv-' + x.level">
          <b>{{ x.level === 'block' ? '阻断' : (x.level === 'warn' ? '注意' : '提示') }}</b> {{ x.detail }}
        </div>
      </div>

      <div v-for="x in offset.items" :key="x.investment_id" class="offset-card">
        <div class="oc-head">
          <b>{{ x.investee_name }}</b>
          <span class="tag blue">持股 {{ num(x.share_pct) }}%</span>
          <span class="tag gray">{{ x.method_label }}</span>
          <span v-if="x.minority_equity" class="tag orange">少数股东 {{ num(x.minority_pct) }}%</span>
        </div>
        <div class="oc-grid">
          <div><span>子公司权益</span><b class="mono">{{ money(x.equity_total) }}</b></div>
          <div><span>母公司应享</span><b class="mono">{{ money(x.share_equity) }}</b></div>
          <div><span>长投账面</span><b class="mono">{{ money(x.book_value) }}</b></div>
          <div><span>商誉</span><b class="mono" :class="{ 'ok-line': x.goodwill > 0 }">{{ x.goodwill ? money(x.goodwill) : '—' }}</b></div>
          <div><span>负商誉（计损益）</span><b class="mono" :class="{ orange: x.bargain_gain > 0 }">{{ x.bargain_gain ? money(x.bargain_gain) : '—' }}</b></div>
          <div><span>少数股东权益</span><b class="mono">{{ x.minority_equity ? money(x.minority_equity) : '—' }}</b></div>
        </div>
        <div class="oc-rows">
          <span class="tiny muted">子公司权益构成：</span>
          <span v-for="e in x.equity_rows" :key="e.code" class="tag gray">{{ e.name }} {{ money(e.amount) }}</span>
        </div>
      </div>

      <div v-if="offset.adjs && offset.adjs.length" style="margin-top: 18px">
        <h4 class="sec">抵消分录</h4>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>科目</th><th class="num">借方</th><th class="num">贷方</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="(a, i) in offset.adjs" :key="i">
                <td class="tiny"><span class="mono">{{ a.account_code }}</span> {{ a.account_name }}</td>
                <td class="num" :class="{ 'ok-line': a.debit > 0 }">{{ a.debit ? money(a.debit) : '' }}</td>
                <td class="num" :class="{ red: a.credit > 0 }">{{ a.credit ? money(a.credit) : '' }}</td>
                <td class="tiny wrap" style="max-width: 460px">{{ a.summary }}</td>
              </tr>
              <tr class="sum-row">
                <td class="tiny"><b>合计</b></td>
                <td class="num"><b>{{ money(offset.total.debit) }}</b></td>
                <td class="num"><b>{{ money(offset.total.credit) }}</b></td>
                <td class="tiny" :class="offset.total.balanced ? 'ok-line' : 'red'">
                  {{ offset.total.balanced ? '借贷平衡' : '借贷不平：不出这张合并表' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="help-bar" style="margin-top: 14px">
        <b>为什么抵消后还能平衡</b>：
        资产端冲减长投 {{ money(offset.total && offset.total.investment_offset) }}、加回商誉 {{ money(offset.total && offset.total.goodwill) }}，
        权益端冲减子公司权益、加回少数股东权益 {{ money(offset.total && offset.total.minority_equity) }}，
        两边净影响都是 {{ money(offset.total && offset.total.asset_adj) }}（差 {{ num(offset.check && offset.check.diff) }}）。
        恒等式：<code>商誉 = 长投 − 子公司权益 × 持股比例</code>，所以资产影响必然等于权益影响。
      </div>
    </div>

    <!-- ==================== 投资详情 ==================== -->
    <div v-if="inv.open" class="modal-mask" @click.self="inv.open = false">
      <div class="modal xxwide">
        <h3>
          {{ inv.data.inv_no }}
          <span class="tag" :class="inv.data.method === 'equity' ? 'blue' : 'gray'">{{ inv.data.method_label }}</span>
          <span class="tag" :class="inv.data.status === 'active' ? 'green' : 'gray'">{{ inv.data.status_label }}</span>
        </h3>
        <div class="kv">
          <div><span>投资方</span><b>{{ inv.data.investor_name }}</b></div>
          <div><span>被投企业</span><b>{{ inv.data.investee_name }}</b><small>{{ inv.data.investee_type === 'subsidiary' ? '子公司' : inv.data.investee_type }}</small></div>
          <div><span>持股比例</span><b>{{ num(inv.data.share_pct) }}%</b><small v-if="inv.data.minority_pct">少数股东 {{ num(inv.data.minority_pct) }}%</small></div>
          <div><span>投资成本</span><b class="mono">{{ money(inv.data.acquire_cost) }}</b><small>{{ inv.data.acquire_date }} 取得</small></div>
          <div><span>损益调整</span><b class="mono">{{ money(inv.data.equity_adjust) }}</b><small>仅权益法</small></div>
          <div><span>已分红</span><b class="mono">{{ money(inv.data.dividend_received) }}</b></div>
          <div><span>账面价值</span><b class="mono">{{ money(inv.data.book_value) }}</b></div>
        </div>
        <div class="help-inline" style="margin: 4px 0 10px">{{ inv.data.method_note }}</div>

        <h4 class="sec">变动留痕 <span class="tiny muted">（每一笔都改得动账面，可逐笔回溯）</span></h4>
        <div class="table-wrap" style="max-height: 260px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr><th>日期</th><th>类型</th><th class="num">金额</th><th class="num">持股变化</th><th class="num">账面变化</th><th>原因</th><th>操作人</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in inv.data.changes" :key="c.id">
                <td class="tiny mono">{{ c.change_date }}</td>
                <td class="tiny">{{ c.type_label }}</td>
                <td class="num" :class="c.amount > 0 ? 'ok-line' : (c.amount < 0 ? 'red' : '')">
                  {{ c.amount ? (c.amount > 0 ? '+' : '') + money(c.amount) : '—' }}
                </td>
                <td class="num tiny">{{ num(c.share_before) }}% → {{ num(c.share_after) }}%</td>
                <td class="num tiny muted">{{ money(c.book_before) }} → {{ money(c.book_after) }}</td>
                <td class="tiny wrap" style="max-width: 260px">{{ c.reason || '—' }}</td>
                <td class="tiny">{{ c.operator }}</td>
              </tr>
              <tr v-if="!inv.data.changes.length"><td colspan="7" class="empty">没有变动记录</td></tr>
            </tbody>
          </table>
        </div>

        <div v-if="canWrite && inv.data.status === 'active'" class="add-row">
          <select v-model="chg.type" class="inp">
            <option value="equity_share">权益法确认损益</option>
            <option value="dividend">收到分红</option>
            <option value="increase">增持</option>
            <option value="decrease">减持</option>
          </select>
          <input v-model.number="chg.amount" type="number" class="inp" placeholder="金额" style="width: 120px" />
          <input v-model.number="chg.share_pct" type="number" class="inp" placeholder="新持股%" style="width: 110px" />
          <input v-model="chg.change_date" type="date" class="inp" />
          <input v-model="chg.reason" class="inp" placeholder="原因（必填）" style="min-width: 200px" />
          <button class="btn btn-ghost btn-sm" @click="saveChange">记一笔</button>
        </div>

        <div class="modal-ops">
          <button v-if="canWrite && inv.data.status === 'active'" class="btn btn-ghost" @click="disposeInv">处置</button>
          <span class="grow"></span>
          <button class="btn btn-ghost" @click="inv.open = false">关闭</button>
          <button v-if="canWrite && inv.data.status === 'active'" class="btn btn-ghost" @click="toggleMethod">
            改为{{ inv.data.method === 'cost' ? '权益法' : '成本法' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 新建投资 ==================== -->
    <div v-if="newInv.open" class="modal-mask" @click.self="newInv.open = false">
      <div class="modal">
        <h3>新建长期股权投资</h3>
        <div class="fgrid">
          <label>被投企业
            <select v-model="newInv.investee_id">
              <option value="">请选择子公司</option>
              <option v-for="s in dict.subsidiaries || []" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <label>核算方法
            <select v-model="newInv.method">
              <option value="cost">成本法（账面 = 投资成本）</option>
              <option value="equity">权益法（随子公司损益调整）</option>
            </select>
          </label>
          <label>投资成本 <input v-model.number="newInv.acquire_cost" type="number" placeholder="必须大于 0" /></label>
          <label>持股比例 % <input v-model.number="newInv.share_pct" type="number" placeholder="0 ~ 100" /></label>
          <label>取得日 <input v-model="newInv.acquire_date" type="date" /></label>
        </div>
        <label class="fl">备注 <input v-model="newInv.note" placeholder="如：全资收购，投资成本高于应享权益部分为商誉" /></label>
        <div class="help-inline" style="margin-top: 10px">
          只有<b>子公司</b>能建长投（分公司没有股权）；同一家子公司同时只能有一条有效投资，
          持股变化请走「增持/减持」，不要重复建。
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="newInv.open = false">取消</button>
          <button class="btn btn-primary" @click="submitInv">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('inv');
const dict = ref({});
const board = ref({ stat: {} });
const rows = ref([]);
const period = ref('');
const offset = ref({ items: [], adjs: [], total: {}, check: {}, issues: [] });

const inv = reactive({ open: false, data: { changes: [] } });
const chg = reactive({ type: 'dividend', amount: null, share_pct: null, change_date: '', reason: '' });
const newInv = reactive({ open: false, investee_id: '', method: 'cost', acquire_cost: null, share_pct: 100, acquire_date: '', note: '' });

const canWrite = computed(() => can('investment.write'));
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const money = (v) => (v === null || v === undefined ? '—' : '¥' + (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN'));

async function loadAll() {
  dict.value = (await api.investmentDict()) || {};
  board.value = (await api.investmentBoard()) || { stat: {} };
  const r = await api.investmentList({});
  rows.value = (r && r.rows) || [];
  if (!period.value) {
    const d = new Date();
    period.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}

async function loadOffset() {
  try {
    offset.value = await api.investmentOffsets(period.value);
  } catch (e) {
    alert(e.message);
  }
}

async function reloadAll() {
  try {
    await loadAll();
    await loadOffset();
  } catch (e) {
    alert(e.message);
  }
}

function goOffset() {
  tab.value = 'offset';
  loadOffset();
}

async function openInv(id) {
  try {
    inv.data = await api.investmentDetail(id);
    chg.type = inv.data.method === 'equity' ? 'equity_share' : 'dividend';
    chg.amount = null;
    chg.share_pct = inv.data.share_pct;
    chg.change_date = dict.value.today || '';
    chg.reason = '';
    inv.open = true;
  } catch (e) {
    alert(e.message);
  }
}

async function saveChange() {
  if (!chg.amount) return alert('金额不能为空');
  if (!chg.reason || chg.reason.trim().length < 4) return alert('必须写原因（≥4 字）');
  try {
    inv.data = await api.addInvestmentChange(inv.data.id, { ...chg });
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function toggleMethod() {
  const next = inv.data.method === 'cost' ? 'equity' : 'cost';
  const reason = prompt(`改为${next === 'equity' ? '权益法' : '成本法'}必须写原因：`, '');
  if (reason === null) return;
  try {
    inv.data = await api.changeInvestmentMethod(inv.data.id, { method: next, reason });
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function disposeInv() {
  const reason = prompt('处置会清零持股与账面价值。请写原因：', '');
  if (reason === null) return;
  try {
    inv.data = await api.disposeInvestment(inv.data.id, { reason });
    await reloadAll();
  } catch (e) {
    alert(e.message);
  }
}

function openNewInv() {
  newInv.open = true;
  newInv.investee_id = '';
  newInv.method = 'cost';
  newInv.acquire_cost = null;
  newInv.share_pct = 100;
  newInv.acquire_date = dict.value.today || '';
  newInv.note = '';
}

async function submitInv() {
  try {
    const d = await api.createInvestment({
      company_id: 1,
      investee_id: Number(newInv.investee_id),
      method: newInv.method,
      acquire_cost: newInv.acquire_cost,
      share_pct: newInv.share_pct,
      acquire_date: newInv.acquire_date,
      note: newInv.note
    });
    newInv.open = false;
    await reloadAll();
    await openInv(d.id);
  } catch (e) {
    alert(e.message);
  }
}

onMounted(reloadAll);
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat strong.sm { font-size: 16px; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.help-bar { background: #f6f9fe; border: 1px solid #e2ebf8; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #4a5568; line-height: 1.75; margin-bottom: 12px; }
.help-inline { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; line-height: 1.65; }
.help-bar code { background: #eef3fb; padding: 1px 5px; border-radius: 4px; font-size: 12px; }

.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.grow { flex: 1; }
.inp { padding: 5px 8px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; }
.add-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.sec { font-size: 13px; color: #16305f; margin: 16px 0 8px; }
.kv { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
.kv > div { background: #f8fafd; border-radius: 8px; padding: 7px 9px; }
.kv span { display: block; font-size: 11px; color: #8a94a6; }
.kv b { font-size: 13px; color: #16305f; }
.kv small { display: block; font-size: 10.5px; color: #9aa4b5; }
.fl { display: block; font-size: 12px; color: #5b6474; margin: 8px 0 0; }
.fl input { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }

.issue { font-size: 12.5px; padding: 7px 11px; border-radius: 8px; margin-bottom: 6px; line-height: 1.6; }
.issue.lv-block { background: #fff6f7; border: 1px solid #f6c6cd; color: #b42318; }
.issue.lv-warn { background: #fffaf1; border: 1px solid #f7d9a8; color: #92400e; }
.issue.lv-info { background: #f6f9fe; border: 1px solid #e2ebf8; color: #4a5568; }

.offset-card { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
.oc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; font-size: 13.5px; color: #16305f; }
.oc-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.oc-grid span { display: block; font-size: 11px; color: #8a94a6; }
.oc-grid b { font-size: 14px; color: #16305f; }
.oc-rows { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
table.data tr.sum-row { background: #f8fafd; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-muted { opacity: 0.62; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }

.modal { padding: 18px 20px; }
.modal > h3 { margin: 0 0 12px; font-size: 16px; color: #16233b; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.modal-ops { display: flex; align-items: center; gap: 8px; padding-top: 13px; margin-top: 14px; border-top: 1px solid #eef2f7; flex-wrap: wrap; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .oc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .page-head .pill { display: none; }
}
</style>
