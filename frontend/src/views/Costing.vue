<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>成本与毛利</h2>
        <p class="sub">一单一成本对象：面料 + 辅料 + 工缴 + 制造费用自动归集，发货按数量结转已售成本，后补费用自动补提。</p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="loadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>已售收入</span>
        <strong>¥{{ money(sum.sold_revenue) }}</strong>
        <small>{{ sum.orders || 0 }} 个成本对象</small>
      </div>
      <div class="stat">
        <span>已售成本</span>
        <strong>¥{{ money(sum.sold_cost) }}</strong>
        <small>未售在制 ¥{{ money(sum.unsold_cost) }}</small>
      </div>
      <div class="stat">
        <span>毛利</span>
        <strong :class="sum.gross_profit >= 0 ? 'amt-green' : 'amt-red'">¥{{ money(sum.gross_profit) }}</strong>
        <small>核价利润 ≠ 已实现利润</small>
      </div>
      <div class="stat">
        <span>毛利率</span>
        <strong :class="sum.margin >= 0 ? 'amt-green' : 'amt-red'">{{ money(sum.margin) }}%</strong>
        <small :class="sum.loss_orders ? 'amt-red' : ''">
          亏损单 {{ sum.loss_orders || 0 }} 个 · 预算差 ¥{{ money(sum.budget_gap) }}
        </small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="订单号 / 客户 / 款号" style="width: 240px" @keyup.enter="loadOrders" />
      <select class="select" v-model="filter" style="width: 130px" @change="loadOrders">
        <option value="">全部</option>
        <option value="loss">只看亏损</option>
      </select>
      <button class="btn btn-ghost" @click="loadOrders">查询</button>
      <div style="flex: 1"></div>
      <span class="muted" style="font-size: 12px">成本对象在订单首次发货时自动创建</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 148px">成本号</th>
            <th style="width: 148px">订单号</th>
            <th style="min-width: 140px">客户 / 款号</th>
            <th style="width: 66px">件数</th>
            <th style="width: 108px">收入</th>
            <th style="width: 104px">预算成本</th>
            <th style="width: 104px">实际成本</th>
            <th style="width: 92px">单件成本</th>
            <th style="width: 104px">已售成本</th>
            <th style="width: 104px">毛利</th>
            <th style="width: 82px">毛利率</th>
            <th style="width: 96px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ 'row-loss': r.sold_revenue > 0 && r.gross_profit < 0 }">
            <td>{{ r.cost_no }}</td>
            <td>{{ r.order_no }}</td>
            <td class="sub-cell">
              <div>{{ r.customer_name || '-' }}</div>
              <div class="muted" style="font-size: 11.5px">{{ r.style_no || '-' }}</div>
            </td>
            <td class="center">{{ r.qty }}</td>
            <td class="num">
              <div>{{ r.currency === 'USD' ? '$' + money(r.revenue_orig) : '¥' + money(r.revenue_cny) }}</div>
              <div v-if="r.currency === 'USD'" class="muted" style="font-size: 11px">¥{{ money(r.revenue_cny) }}</div>
            </td>
            <td class="num muted">{{ money(r.budget_cost) }}</td>
            <td class="num">
              <div>{{ money(r.actual_cost) }}</div>
              <div v-if="r.budget_gap" class="gap" :class="r.budget_gap > 0 ? 'up' : 'down'">
                {{ r.budget_gap > 0 ? '+' : '' }}{{ money(r.budget_gap) }}
              </div>
            </td>
            <td class="num">{{ money(r.unit_cost) }}</td>
            <td class="num">{{ money(r.sold_cost) }}</td>
            <td class="num strong" :class="r.gross_profit >= 0 ? 'amt-green' : 'amt-red'">{{ money(r.gross_profit) }}</td>
            <td class="num" :class="r.margin >= 0 ? 'amt-green' : 'amt-red'">{{ money(r.margin) }}%</td>
            <td class="ops">
              <button class="link-btn" @click="openDetail(r.order_id)">明细</button>
              <button class="link-btn" @click="recollect(r.order_id)">归集</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="12" class="empty-cell">还没有成本对象。订单发货后会自动创建，也可以在订单页手动触发归集。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 明细弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal xwide cx-modal">
        <div class="modal-head">
          <h3>
            {{ detail.cost_no }} · {{ detail.order_no }}
            <span class="muted" style="font-weight: 400; font-size: 12px">{{ detail.customer_name }} · {{ detail.style_no || '未填款号' }}</span>
          </h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <!-- 汇总条 -->
          <div class="cx-sum">
            <div><span>件数</span><b>{{ detail.qty }}</b></div>
            <div><span>收入</span><b>{{ detail.currency === 'USD' ? '$' + money(detail.revenue_orig) : '¥' + money(detail.revenue_cny) }}</b></div>
            <div><span>实际成本</span><b>¥{{ money(detail.actual_cost) }}</b></div>
            <div><span>单件成本</span><b>¥{{ money(detail.unit_cost) }}</b></div>
            <div><span>已售成本</span><b>¥{{ money(detail.sold_cost) }}</b></div>
            <div>
              <span>毛利</span>
              <b :class="detail.gross_profit >= 0 ? 'amt-green' : 'amt-red'">
                ¥{{ money(detail.gross_profit) }}（{{ money(detail.margin) }}%）
              </b>
            </div>
          </div>

          <!-- 成本层 -->
          <div class="cx-layers">
            <div v-for="l in detail.by_layer" :key="l.key" class="cx-layer">
              <div class="cx-layer-head">
                <span>{{ l.label }}</span>
                <b>¥{{ money(l.amount) }}</b>
              </div>
              <div class="cx-bar"><i :style="{ width: layerPct(l.amount) + '%' }" :class="'bg-' + l.key"></i></div>
              <div class="cx-layer-sub">{{ pct(l.amount) }}% · {{ l.count }} 项</div>
            </div>
            <div v-if="!detail.by_layer.length" class="cx-empty">
              还没有归集到成本。点右上角「重新归集」按开发单面辅料与工序工价算一遍。
            </div>
          </div>

          <!-- 明细 -->
          <div class="cx-sec">
            <div class="cx-sec-head">
              <h4>成本明细</h4>
              <div class="cx-add">
                <select class="select" v-model="addForm.layer" style="width: 150px">
                  <option value="freight">后补到仓费用</option>
                  <option value="rework">返工报废</option>
                  <option value="other">其他</option>
                  <option value="overhead">制造费用</option>
                </select>
                <input class="input" v-model="addForm.name" placeholder="名称，如 美线海运拼柜费" style="width: 190px" />
                <input class="input" type="number" step="0.01" v-model.number="addForm.amount" placeholder="金额" style="width: 110px" />
                <button class="btn btn-primary btn-sm" :disabled="saving" @click="addEntry">追加</button>
              </div>
            </div>
            <div class="table-wrap">
              <table class="data cx-tbl">
                <thead>
                  <tr>
                    <th style="width: 100px">成本层</th>
                    <th style="min-width: 190px">名称</th>
                    <th style="width: 84px">数量</th>
                    <th style="width: 82px">单价</th>
                    <th style="width: 96px">金额</th>
                    <th style="width: 90px">来源</th>
                    <th style="min-width: 150px">备注</th>
                    <th style="width: 54px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="e in detail.entries" :key="e.id">
                    <td><span class="tag" :class="layerTag(e.layer)">{{ layerLabel(e.layer) }}</span></td>
                    <td>{{ e.name }}</td>
                    <td class="num">{{ e.qty }}</td>
                    <td class="num">{{ money(e.unit_price) }}</td>
                    <td class="num strong">{{ money(e.amount) }}</td>
                    <td>
                      <span class="tag" :class="e.source === 'auto' ? 'blue' : 'gray'">{{ e.source === 'auto' ? '自动' : '手工' }}</span>
                    </td>
                    <td class="sub-cell">{{ e.remark || '-' }}</td>
                    <td>
                      <button v-if="e.source === 'manual'" class="link-btn danger" @click="delEntry(e)">删</button>
                    </td>
                  </tr>
                  <tr v-if="!detail.entries.length"><td colspan="8" class="empty-cell">没有成本明细</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 已售快照 -->
          <div class="cx-sec">
            <div class="cx-sec-head">
              <h4>已售结转记录</h4>
              <span class="muted" style="font-size: 12px">
                已发货 {{ detail.sold_qty }}/{{ detail.qty }} 件 · 未售成本 ¥{{ money(detail.unsold_cost) }}
              </span>
            </div>
            <div class="cx-timeline">
              <div v-for="s in detail.snapshots" :key="s.id" class="cx-snap">
                <span class="cx-snap-dot"></span>
                <div class="cx-snap-body">
                  <div class="cx-snap-head">
                    <b>第 {{ s.seq }} 次结转</b>
                    <span class="muted">{{ $fmt(s.created_at) }}</span>
                  </div>
                  <div class="cx-snap-line">
                    {{ s.qty }}/{{ s.total_qty }} 件 · 单件 ¥{{ money(s.unit_cost) }} ·
                    已售成本 ¥{{ money(s.sold_cost) }} · 已售收入 ¥{{ money(s.sold_revenue) }} ·
                    <b :class="s.gross_profit >= 0 ? 'amt-green' : 'amt-red'">毛利 ¥{{ money(s.gross_profit) }}</b>
                  </div>
                  <div class="cx-snap-note">{{ s.note }}</div>
                </div>
              </div>
              <div v-if="!detail.snapshots.length" class="cx-empty">还没发货，没有结转记录</div>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="detail = null">关闭</button>
          <button class="btn btn-ghost" :disabled="saving" @click="snapshot(detail.order_id)">按发货结转</button>
          <button class="btn btn-primary" :disabled="saving" @click="recollect(detail.order_id)">重新归集</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const sum = ref({});
const rows = ref([]);
const q = ref('');
const filter = ref('');
const detail = ref(null);
const saving = ref(false);
const addForm = ref({ layer: 'freight', name: '', amount: 0 });

const money = (v) => (Number(v) || 0).toFixed(2);

const LAYER_LABEL = {
  material: '面料', accessory: '辅料', labor: '工缴', overhead: '制造费用',
  other: '其他', freight: '后补到仓', rework: '返工报废'
};
const LAYER_TAG = {
  material: 'purple', accessory: 'blue', labor: 'orange',
  overhead: 'gray', other: 'gray', freight: 'red', rework: 'red'
};
const layerLabel = (k) => LAYER_LABEL[k] || k;
const layerTag = (k) => LAYER_TAG[k] || 'gray';
const pct = (v) => {
  const total = (detail.value && detail.value.actual_cost) || 0;
  return total > 0 ? ((Number(v) || 0) / total * 100).toFixed(1) : '0.0';
};
const layerPct = (v) => Number(pct(v));

async function loadSummary() {
  try { sum.value = await api.costingOverview(); } catch (e) { /* ignore */ }
}
async function loadOrders() {
  try { rows.value = await api.costingOrders({ q: q.value, status: filter.value }); }
  catch (e) { alert(e.message); }
}
async function loadAll() { await Promise.all([loadSummary(), loadOrders()]); }

async function openDetail(orderId) {
  try { detail.value = await api.costingOrder(orderId); }
  catch (e) { alert(e.message); }
}
async function recollect(orderId) {
  saving.value = true;
  try {
    const r = await api.collectCosting(orderId);
    if (detail.value && detail.value.order_id === Number(orderId)) detail.value = r;
    await loadAll();
    alert(`已重新归集：${r.collected} 项，实际成本 ¥${money(r.actual_cost)}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function snapshot(orderId) {
  saving.value = true;
  try {
    const r = await api.snapshotCosting(orderId);
    detail.value = r.object;
    await loadAll();
    alert(`已按发货 ${r.doneQty}/${r.totalQty} 件结转：已售成本 ¥${money(r.soldCost)}，毛利 ¥${money(r.grossProfit)}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function addEntry() {
  if (!detail.value) return;
  if (!(Number(addForm.value.amount) > 0)) return alert('请填写金额');
  saving.value = true;
  try {
    const r = await api.addCostEntry({
      order_id: detail.value.order_id,
      layer: addForm.value.layer,
      name: addForm.value.name || layerLabel(addForm.value.layer),
      amount: Number(addForm.value.amount)
    });
    detail.value = r;
    addForm.value = { layer: 'freight', name: '', amount: 0 };
    await loadAll();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function delEntry(e) {
  if (!confirm(`删除成本项「${e.name} ¥${money(e.amount)}」？`)) return;
  try {
    const r = await api.deleteCostEntry(e.id);
    detail.value = r;
    await loadAll();
  } catch (err) { alert(err.message); }
}

onMounted(loadAll);
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 19px; color: #16233b; }
.page-head .sub { margin: 0; font-size: 12.5px; color: #8a94a6; max-width: 720px; line-height: 1.6; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 14px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 19px; color: #16233b; font-variant-numeric: tabular-nums; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.row-loss { background: #fff7f8; }
.gap { font-size: 11px; }
.gap.up { color: #d92d45; }
.gap.down { color: #16a34a; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.center { text-align: center; }
.ops { white-space: nowrap; }
.muted { color: #8a94a6; }
.sub-cell { font-size: 12px; color: #5b6474; }
.empty-cell { text-align: center; color: #8a94a6; padding: 18px; }

.modal.xwide.cx-modal { width: 1240px; max-width: 97vw; }
.cx-modal .modal-body { max-height: 78vh; }
.cx-sum {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px;
  background: #f8fafd; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px;
}
.cx-sum span { display: block; font-size: 11.5px; color: #8a94a6; }
.cx-sum b { font-size: 13.5px; color: #16233b; font-variant-numeric: tabular-nums; }

.cx-layers { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin: 14px 0; }
.cx-layer { border: 1px solid #eef2f7; border-radius: 9px; padding: 8px 10px; background: #fff; }
.cx-layer-head { display: flex; justify-content: space-between; font-size: 12.5px; color: #33415a; }
.cx-layer-head b { font-variant-numeric: tabular-nums; }
.cx-bar { height: 7px; background: #f2f5fa; border-radius: 5px; overflow: hidden; margin: 6px 0 3px; }
.cx-bar i { display: block; height: 100%; border-radius: 5px; background: #2b6de5; }
.cx-bar i.bg-material { background: #7c5cff; }
.cx-bar i.bg-accessory { background: #2b6de5; }
.cx-bar i.bg-labor { background: #f59e0b; }
.cx-bar i.bg-overhead { background: #94a3b8; }
.cx-bar i.bg-other { background: #64748b; }
.cx-bar i.bg-freight { background: #d92d45; }
.cx-bar i.bg-rework { background: #b91c1c; }
.cx-layer-sub { font-size: 11px; color: #a9b4c5; }
.cx-empty { font-size: 12.5px; color: #8a94a6; padding: 10px 2px; }

.cx-sec { margin-top: 16px; }
.cx-sec-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.cx-sec-head h4 { margin: 0; font-size: 13px; color: #16233b; }
.cx-add { display: flex; gap: 6px; align-items: center; }
.cx-tbl { min-width: 860px; }

.cx-timeline { display: flex; flex-direction: column; gap: 8px; }
.cx-snap { display: flex; gap: 10px; }
.cx-snap-dot { width: 8px; height: 8px; border-radius: 50%; background: #2b6de5; margin-top: 6px; flex: none; }
.cx-snap-body { flex: 1; background: #fbfcfe; border: 1px solid #eef2f7; border-radius: 8px; padding: 7px 10px; }
.cx-snap-head { display: flex; justify-content: space-between; font-size: 12.5px; color: #16233b; }
.cx-snap-line { font-size: 12px; color: #5b6474; margin-top: 2px; line-height: 1.6; }
.cx-snap-note { font-size: 11px; color: #a9b4c5; margin-top: 2px; }
@media (max-width: 1100px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .cx-sum { grid-template-columns: repeat(3, 1fr); }
}
</style>
