<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>齐套与缺料</h2>
        <p class="sub">
          需求按「单件用量 ×(1+损耗) × 件数」算；同一物料多单争抢时，按对客承诺日早的优先拿库存，再拿在途采购，剩下的才是真缺口。
        </p>
      </div>
      <div class="head-ops">
        <span v-if="calcAt" class="muted" style="font-size: 12px; margin-right: 8px">上次计算 {{ $fmt(calcAt) }}</span>
        <button class="btn btn-ghost" :disabled="busy" @click="recalc">重新计算</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>齐套可开工</span>
        <strong class="amt-green">{{ stat.ready || 0 }}</strong>
        <small>共 {{ stat.orders || 0 }} 张待生产订单</small>
      </div>
      <div class="stat">
        <span>部分齐套</span>
        <strong :class="stat.partial ? 'amt-orange' : ''">{{ stat.partial || 0 }}</strong>
        <small>可先裁，缝制要等料</small>
      </div>
      <div class="stat">
        <span>缺料停工</span>
        <strong :class="stat.short ? 'amt-red' : ''">{{ stat.short || 0 }}</strong>
        <small>主面料没到，不能裁剪</small>
      </div>
      <div class="stat">
        <span>缺口金额</span>
        <strong>¥{{ money(stat.gap_amount) }}</strong>
        <small>按档案单价估算</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="seg">
        <button :class="{ on: tab === 'order' }" @click="switchTab('order')">按订单</button>
        <button :class="{ on: tab === 'shortage' }" @click="switchTab('shortage')">采购建议</button>
      </div>
      <template v-if="tab === 'order'">
        <input class="input" v-model="q" placeholder="订单号 / 客户 / 款名" style="width: 220px" @keyup.enter="loadBoard" />
        <select class="select" v-model="state" style="width: 140px" @change="loadBoard">
          <option value="">全部状态</option>
          <option value="ready">齐套</option>
          <option value="partial">部分齐套</option>
          <option value="short">缺料</option>
        </select>
        <button class="btn btn-ghost" @click="loadBoard">查询</button>
      </template>
      <div style="flex: 1"></div>
      <span class="muted" style="font-size: 12px">缺料行会一直留在这里，直到采购到货或改用替代料</span>
    </div>

    <!-- 按订单 -->
    <div v-if="tab === 'order'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 148px">订单号</th>
            <th style="min-width: 160px">客户 / 款名</th>
            <th style="width: 64px">件数</th>
            <th style="width: 100px">承诺日</th>
            <th style="min-width: 190px">齐套判定</th>
            <th style="width: 82px">缺口行</th>
            <th style="width: 104px">缺口金额</th>
            <th style="width: 86px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.order_id" :class="rowCls(r.state)">
            <td>{{ r.order_no }}</td>
            <td class="sub-cell">
              <div>{{ r.customer_name || '-' }}</div>
              <div class="muted" style="font-size: 11.5px">{{ r.style_name || '-' }}</div>
            </td>
            <td class="center">{{ r.qty }}</td>
            <td>{{ r.promised_date || '-' }}</td>
            <td>
              <span class="tag" :class="stateTag(r.state)">{{ r.label }}</span>
              <span class="muted" style="font-size: 11.5px; margin-left: 6px">
                面料缺 {{ r.fabShort }} · 辅料缺 {{ r.accShort }}
              </span>
            </td>
            <td class="center" :class="r.gap_lines ? 'amt-red' : ''">{{ r.gap_lines }}</td>
            <td class="num" :class="r.gap_amount ? 'amt-red' : ''">{{ money(r.gap_amount) }}</td>
            <td class="ops"><button class="link-btn" @click="openOrder(r)">明细</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="8" class="empty-cell">没有待生产的订单（已发货 / 已结案的订单不参与齐套）</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 采购建议 -->
    <div v-if="tab === 'shortage'" class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="min-width: 200px">物料</th>
            <th style="width: 84px">类型</th>
            <th style="width: 110px">总缺口</th>
            <th style="width: 90px">影响订单</th>
            <th style="width: 100px">在途已达</th>
            <th style="width: 92px">单价</th>
            <th style="width: 106px">缺口金额</th>
            <th style="min-width: 130px">供应商</th>
            <th style="min-width: 170px">涉及订单</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in shortage" :key="i">
            <td>{{ s.material_name }}</td>
            <td><span class="tag" :class="s.mat_type === 'fabric' ? 'purple' : 'blue'">{{ s.mat_type === 'fabric' ? '面料' : '辅料' }}</span></td>
            <td class="num strong amt-red">{{ s.gap_qty }} {{ s.unit || '' }}</td>
            <td class="center">{{ s.order_count }} 单</td>
            <td class="num">{{ s.on_order ? s.on_order : '-' }}</td>
            <td class="num">{{ money(s.unit_price) }}</td>
            <td class="num">{{ money(s.gap_amount) }}</td>
            <td class="sub-cell">{{ s.supplier || '-' }}</td>
            <td class="sub-cell">{{ s.order_nos }}</td>
          </tr>
          <tr v-if="!shortage.length"><td colspan="9" class="empty-cell">没有缺口，全部齐套</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 订单明细 -->
    <div v-if="detail" class="modal-mask">
      <div class="modal xwide rq-modal">
        <div class="modal-head">
          <h3>
            {{ detail.order_no }} · 齐套明细
            <span class="muted" style="font-weight: 400; font-size: 12px">{{ detail.label }} · 缺口 ¥{{ money(detail.gap_amount) }}</span>
          </h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="rq-flow">
            <div class="rq-step" :class="detail.can_cut ? 'ok' : 'bad'">
              <span>P5 裁剪</span>
              <b>{{ detail.can_cut ? '面料齐，可开工' : '面料缺，不能裁剪' }}</b>
            </div>
            <div class="rq-step" :class="detail.can_sew ? 'ok' : 'bad'">
              <span>B1 缝制</span>
              <b>{{ detail.can_sew ? '辅料齐，可上线' : '辅料缺，缝制要等' }}</b>
            </div>
            <div class="rq-step" :class="detail.lines.every((l) => l.gap_qty <= 0.005) ? 'ok' : 'bad'">
              <span>P6 配辅料 · E1 出厂</span>
              <b>{{ detail.lines.every((l) => l.gap_qty <= 0.005) ? '全料齐，可排计划' : '有缺口，交期有风险' }}</b>
            </div>
          </div>

          <div class="table-wrap" style="margin-top: 12px">
            <table class="data rq-tbl">
              <thead>
                <tr>
                  <th style="width: 78px">类型</th>
                  <th style="min-width: 180px">物料</th>
                  <th style="width: 90px">款色 / 色号</th>
                  <th style="width: 96px">需求</th>
                  <th style="width: 86px">库存分配</th>
                  <th style="width: 86px">在途分配</th>
                  <th style="width: 96px">净缺口</th>
                  <th style="width: 86px">影响工序</th>
                  <th style="width: 86px">状态</th>
                  <th style="min-width: 150px">处理</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in detail.lines" :key="l.id" :class="{ 'row-red': l.gap_qty > 0.005 && !l.action.includes('ordered') }">
                  <td><span class="tag" :class="l.mat_type === 'fabric' ? 'purple' : 'blue'">{{ l.mat_type === 'fabric' ? '面料' : '辅料' }}</span></td>
                  <td>
                    <div>{{ l.material_name }}</div>
                    <div v-if="l.spec_info" class="muted" style="font-size: 11px">{{ l.spec_info }}</div>
                  </td>
                  <td class="sub-cell">{{ l.colorway || '-' }}<br />{{ l.color_no || '-' }}</td>
                  <td class="num">{{ l.need_qty }} {{ l.unit || '' }}</td>
                  <td class="num">{{ l.alloc_stock }}</td>
                  <td class="num">{{ l.alloc_po || '-' }}</td>
                  <td class="num strong" :class="l.gap_qty > 0.005 ? 'amt-red' : 'amt-green'">{{ l.gap_qty }}</td>
                  <td class="muted">{{ l.impact_node }}</td>
                  <td><span class="tag" :class="lineTag(l.status)">{{ lineText(l.status) }}</span></td>
                  <td>
                    <select class="select mini" :value="l.action" @change="setAction(l, $event.target.value)">
                      <option value="pending">待处理</option>
                      <option value="ordered">已下采购</option>
                      <option value="substituted">用替代料</option>
                      <option value="received">已到货</option>
                    </select>
                    <div v-if="l.note" class="muted" style="font-size: 11px">{{ l.note }}</div>
                  </td>
                </tr>
                <tr v-if="!detail.lines.length"><td colspan="10" class="empty-cell">这单的开发单还没有面辅料明细，先补开发单</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const tab = ref('order');
const stat = ref({});
const rows = ref([]);
const shortage = ref([]);
const q = ref('');
const state = ref('');
const calcAt = ref('');
const busy = ref(false);
const detail = ref(null);

const money = (v) => (Number(v) || 0).toFixed(2);

const stateTag = (s) => ({ ready: 'green', partial: 'orange', short: 'red', no_data: 'gray' }[s] || 'gray');
const lineTag = (s) => ({ ok: 'green', partial: 'orange', short: 'red', ordered: 'blue' }[s] || 'gray');
const lineText = (s) => ({ ok: '齐套', partial: '部分', short: '缺料', ordered: '已下单' }[s] || s);
const rowCls = (s) => ({ 'row-red': s === 'short', 'row-yellow': s === 'partial' });

async function loadBoard() {
  try {
    const d = await api.requirementBoard({ q: q.value, state: state.value });
    stat.value = d.stat || {};
    rows.value = d.rows || [];
    calcAt.value = d.calc_at || '';
  } catch (e) { alert(e.message); }
}
async function loadShortage() {
  try { shortage.value = await api.requirementShortage(); } catch (e) { alert(e.message); }
}
async function switchTab(t) {
  tab.value = t;
  if (t === 'shortage') await loadShortage();
  else await loadBoard();
}
async function recalc() {
  busy.value = true;
  try {
    const r = await api.calcRequirements();
    await Promise.all([loadBoard(), tab.value === 'shortage' ? loadShortage() : Promise.resolve()]);
    alert(`已重算：${r.orders} 张订单 / ${r.lines} 行需求`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}
async function openOrder(r) {
  try { detail.value = await api.requirementOrder(r.order_id); }
  catch (e) { alert(e.message); }
}
async function setAction(line, action) {
  try {
    await api.setRequirementAction(line.id, { action });
    detail.value = await api.requirementOrder(detail.value.order_id);
    await loadBoard();
  } catch (e) { alert(e.message); }
}

onMounted(() => { loadBoard(); });
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 19px; color: var(--ink); }
.page-head .sub { margin: 0; font-size: 12.5px; color: var(--ink-mute); max-width: 780px; line-height: 1.6; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 14px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 4px 0 2px; font-size: 21px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.row-red { background: #fff7f8; }
.row-yellow { background: #fffdf5; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.center { text-align: center; }
.ops { white-space: nowrap; }
.muted { color: var(--ink-mute); }
.sub-cell { font-size: 12px; color: #5b6474; }
.empty-cell { text-align: center; color: var(--ink-mute); padding: 18px; }

.modal.xwide.rq-modal { width: 1300px; max-width: 97vw; }
.rq-modal .modal-body { max-height: 78vh; }
.rq-flow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.rq-step { border: 1px solid #e6ebf3; border-radius: 10px; padding: 9px 12px; background: var(--surface); }
.rq-step.ok { border-color: #cfe9da; background: #f6fdf9; }
.rq-step.bad { border-color: #f8d3d8; background: #fff8f9; }
.rq-step span { display: block; font-size: 12px; color: var(--ink-mute); }
.rq-step b { font-size: 13px; color: var(--ink); }
.rq-step.bad b { color: #d92d45; }
.rq-step.ok b { color: #16a34a; }
.rq-tbl { min-width: 1180px; }
.table-wrap { overflow-x: auto; }
table.data th, table.data td { white-space: nowrap; }
.select.mini { padding: 3px 6px; font-size: 12px; }
/* 类型 tag 在窄列里会被压成竖排，收一下内边距 */
:deep(.tag) { white-space: nowrap; padding: 2px 6px; }
@media (max-width: 1100px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .rq-flow { grid-template-columns: 1fr; }
}
</style>
