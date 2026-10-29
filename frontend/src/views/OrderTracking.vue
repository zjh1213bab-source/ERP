<template>
  <div>
    <div class="page-head">
      <div>
        <h2>订单跟踪</h2>
        <div class="sub">
          一张单一行，工序从左到右走。节点取自「{{ board.template ? board.template.name : '—' }}」，
          点格子推进，点 ⋯ 记计划/责任人/留言。
        </div>
      </div>
      <div style="display: flex; gap: 8px">
        <button class="btn btn-ghost" @click="load">刷新</button>
        <button v-if="canFlow" class="btn btn-ghost" @click="$router.push('/node-flow')">节点流程配置</button>
      </div>
    </div>

    <div class="cards" style="grid-template-columns: repeat(4, 1fr)">
      <div class="stat-card">
        <div class="label">在跟订单</div>
        <div class="value">{{ summary.orders || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">平均进度</div>
        <div class="value">{{ summary.avg_progress || 0 }}%</div>
      </div>
      <div class="stat-card">
        <div class="label">一步未动</div>
        <div class="value">{{ summary.not_started || 0 }}</div>
      </div>
      <div class="stat-card accent">
        <div class="label">工序已走完</div>
        <div class="value">{{ summary.finished || 0 }}</div>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <select class="select" v-model="tplId" @change="load">
        <option v-for="t in templates" :key="t.id" :value="t.id">
          {{ t.name }}{{ t.is_default ? '（默认）' : '' }} · {{ t.order_count }} 单
        </option>
      </select>
      <select class="select" v-model="status" @change="load">
        <option value="">在产（已分单 / 生产中 / 已入库）</option>
        <option value="assigned">已分单</option>
        <option value="production">生产中</option>
        <option value="instock">已入库</option>
        <option value="shipped">已发货</option>
        <option value="closed">已结案</option>
      </select>
      <input class="input" v-model="q" placeholder="订单号 / 款名 / 客户 PO" @keyup.enter="load" style="width: 220px" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <span class="spacer"></span>
      <span class="tiny muted">图例：○ 待开始 · ▶ 进行中 · ✓ 已完成 · ⊘ 不适用</span>
    </div>

    <div v-if="!board.columns || !board.columns.length" class="empty-cell">
      这个流程还没有配置任何节点，先去「节点流程配置」里加几个
    </div>

    <div v-else class="trk-wrap">
      <table class="trk-table">
        <thead>
          <tr>
            <th class="trk-fixed">订单 / 进度</th>
            <th v-for="c in board.columns" :key="c.code" class="trk-col-head">
              <div class="trk-col-name" :title="c.builtin ? '系统内置节点（不能停用）' : '自定义节点'">
                {{ c.name }}<span v-if="c.builtin" class="trk-bi">内置</span>
              </div>
              <div class="trk-col-meta">
                <!-- 只标「可选」：绝大多数节点是必经的，13 列都挂「必经」纯噪音，
                     而真正需要提醒的恰恰是「这个可以不适用」的那几个 -->
                <span v-if="!c.required" class="trk-opt">可选</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in board.rows" :key="r.id">
            <td class="trk-fixed">
              <div class="trk-order">
                <a class="lnk mono" @click="$router.push('/orders?order=' + r.id)"><b>{{ r.order_no }}</b></a>
                <span class="tag" :class="statusTag(r.status)">{{ statusLabel(r.status) }}</span>
              </div>
              <div class="trk-style">{{ r.style_name || '—' }}</div>
              <div class="trk-cus">
                {{ r.customer_name || '—' }}
                <span v-if="r.delivery_date" :class="isLate(r) ? 'trk-late' : ''"> · 交期 {{ r.delivery_date }}</span>
              </div>
              <div class="trk-bar">
                <div class="trk-bar-in" :style="{ width: r.progress + '%' }"></div>
              </div>
              <div v-if="r.no_nodes" class="trk-prog trk-nonodes">
                未生成工序 · 订单还没转到「生产中」
              </div>
              <div v-else class="trk-prog">
                {{ r.progress }}% · {{ r.done_count }}/{{ r.total_count }}
                <span v-if="r.skipped_count"> · 跳过 {{ r.skipped_count }}</span>
              </div>
            </td>

            <!-- 还没生成工序的单：整行合并一句提示。
                 铺 13 个「未生成」既吵又没用 —— 它们不是 13 个问题，是同一个问题 -->
            <td v-if="r.no_nodes" :colspan="r.cells.length" class="trk-norow">
              <span>这张单还没生成工序 —— 订单转到「生产中」时自动按流程铺节点，</span>
              <span>或到「工序流程配置 → 应用到已有订单」里批量补。</span>
            </td>

            <template v-else>
            <td v-for="(cell, i) in r.cells" :key="cell.code" class="trk-cell"
              :class="cellClass(cell)" @click="advance(r, cell)"
              :title="cellTitle(r, cell)">
              <template v-if="cell.missing">
                <span class="trk-none">未生成</span>
              </template>
              <template v-else>
                <span class="trk-ico">{{ ico(cell.status) }}</span>
                <span class="trk-st">{{ stLabel(cell.status) }}</span>
                <span v-if="cell.status === 'done' && cell.actual_date" class="trk-date">{{ cell.actual_date.slice(5) }}</span>
                <span v-else-if="cell.status === 'skipped'" class="trk-date" :title="cell.skip_reason">有原因</span>
                <button class="trk-more" title="计划 / 责任人 / 留言" @click.stop="openNode(r, cell)">⋯</button>
                <span v-if="i < r.cells.length - 1" class="trk-arrow">›</span>
              </template>
            </td>

            <td v-for="cell in r.extra" :key="cell.code" class="trk-cell trk-extra" :class="cellClass(cell)"
              @click="advance(r, cell)" title="模板之外的节点（这张单单独加的或模板已停用的）">
              <span class="trk-ico">{{ ico(cell.status) }}</span>
              <span class="trk-st">{{ cell.name }}</span>
            </td>
            </template>
          </tr>
          <tr v-if="!board.rows || !board.rows.length">
            <td :colspan="(board.columns ? board.columns.length : 0) + 1" class="empty-cell">
              这个流程下没有符合条件的订单
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ================= 节点详情 / 留言 ================= -->
    <div v-if="dlg.open" class="modal-mask" @click.self="dlg.open = false">
      <div class="modal" style="width: 520px">
        <div class="modal-head">
          <h3>{{ dlg.node ? dlg.node.name : '' }} · {{ dlg.orderNo }}</h3>
          <button class="x" @click="dlg.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="nd-row">
            <label>状态</label>
            <div class="nd-chips">
              <button v-for="s in ['pending', 'doing', 'done', 'skipped']" :key="s" class="nd-chip"
                :class="{ on: dlg.status === s }" @click="dlg.status = s">{{ stLabel(s) }}</button>
            </div>
          </div>
          <div class="nd-row">
            <label>计划完成</label>
            <input class="input" type="date" v-model="dlg.plan_date" style="width: 180px" />
          </div>
          <div class="nd-row">
            <label>责任人</label>
            <input class="input" v-model="dlg.operator" placeholder="车间 / 外协厂 / 具体人" style="width: 220px" />
          </div>
          <div v-if="dlg.status === 'skipped'" class="nd-row nd-full">
            <label>不适用原因 *</label>
            <input class="input" v-model="dlg.skip_reason" placeholder="如：这单是现货款，不做水洗" />
            <div class="nd-hint">必经节点不能标不适用；真的不做请到「节点流程配置」把它的「必经」去掉。</div>
          </div>
          <div class="nd-row nd-full">
            <label>留言</label>
            <textarea class="input" rows="3" v-model="dlg.remark" placeholder="车间 / 跟单在这个环节要说明的事（会追加到节点备注）"></textarea>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="dlg.open = false">取消</button>
          <button class="btn btn-primary" :disabled="dlg.saving" @click="saveNode">
            {{ dlg.saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const templates = ref([]);
const tplId = ref(null);
const status = ref('');
const q = ref('');
const board = ref({ template: null, columns: [], rows: [], summary: {} });
const summary = ref({});
const canFlow = can('node.flow');

function statusLabel(s) {
  return {
    draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
    instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
  }[s] || s;
}
function statusTag(s) {
  return {
    assigned: 'purple', production: 'blue', instock: 'green',
    shipped: 'green', closed: 'gray', cancelled: 'red'
  }[s] || 'gray';
}
function stLabel(s) {
  return { pending: '待开始', doing: '进行中', done: '已完成', skipped: '不适用', none: '未生成' }[s] || s;
}
function ico(s) {
  return { pending: '○', doing: '▶', done: '✓', skipped: '⊘' }[s] || '·';
}
function cellClass(cell) {
  if (cell.missing) return 'is-missing';
  return 'is-' + cell.status;
}
function isLate(r) {
  if (!r.delivery_date) return false;
  return String(r.delivery_date).slice(0, 10) < new Date().toISOString().slice(0, 10)
    && r.progress < 100;
}
function cellTitle(r, cell) {
  if (cell.missing) return '这张单还没生成工序（订单还没转到「生产中」）';
  if (cell.status === 'done') return `已完成 ${cell.actual_date || ''}；如需回退请到订单详情`;
  if (cell.status === 'skipped') return '不适用：' + (cell.skip_reason || '');
  return cell.status === 'pending' ? '点一下 → 进行中' : '点一下 → 已完成';
}

async function load() {
  const [ts, b] = await Promise.all([
    api.nodeFlowTemplates(),
    api.nodeFlowBoard({ template_id: tplId.value || '', status: status.value, q: q.value })
  ]);
  templates.value = ts || [];
  if (!tplId.value && b && b.template) tplId.value = b.template.id;
  board.value = b || { template: null, columns: [], rows: [], summary: {} };
  summary.value = (b && b.summary) || {};
}

/**
 * 点格子推进：待开始 → 进行中 → 已完成
 *
 * 已完成/不适用**不响应点击**：这两态已经是「有结论」的状态，
 * 一不小心点掉就得回订单详情重来，而现场基本都是戴着手机手套在点。
 * 要回退走 ⋯ 面板。
 */
async function advance(r, cell) {
  if (cell.missing || !cell.node_id) {
    alert('这张单还没生成工序。先把订单流转到「生产中」，或到「节点流程配置」里点「应用到已有订单」。');
    return;
  }
  if (cell.status === 'done' || cell.status === 'skipped') return;
  const next = cell.status === 'pending' ? 'doing' : 'done';
  try {
    await api.updateNode(cell.node_id, { status: next });
    await load();
  } catch (e) { alert(e.message); }
}

const dlg = reactive({
  open: false, node: null, nodeId: null, orderNo: '', saving: false,
  status: 'pending', plan_date: '', operator: '', remark: '', skip_reason: ''
});
function openNode(r, cell) {
  if (!cell.node_id) return;
  dlg.open = true;
  dlg.nodeId = cell.node_id;
  dlg.node = cell;
  dlg.orderNo = r.order_no;
  dlg.status = cell.status;
  dlg.plan_date = cell.plan_date || '';
  dlg.operator = cell.operator || '';
  dlg.remark = '';
  dlg.skip_reason = cell.skip_reason || '';
}
async function saveNode() {
  dlg.saving = true;
  try {
    const body = {
      status: dlg.status,
      plan_date: dlg.plan_date || null,
      operator: dlg.operator || null
    };
    if (dlg.status === 'skipped') body.skip_reason = dlg.skip_reason;
    if (dlg.remark.trim()) {
      body.remark = ` [${new Date().toISOString().slice(0, 10)} ${dlg.remark.trim()}]`;
    }
    await api.updateNode(dlg.nodeId, body);
    dlg.open = false;
    await load();
  } catch (e) { alert(e.message); } finally { dlg.saving = false; }
}

onMounted(load);
</script>

<style scoped>
/* 看板横向会有 13+ 列，左侧订单列必须固定，否则右滑就不知道在看哪张单 */
.trk-wrap { overflow-x: auto; border: 1px solid #eef2f7; border-radius: 10px; background: #fff; }
.trk-table { border-collapse: separate; border-spacing: 0; width: 100%; }
.trk-table th, .trk-table td { padding: 0; border-bottom: 1px solid #eef2f7; vertical-align: middle; }

.trk-table thead th {
  background: #f7f9fd; font-size: 11.5px; font-weight: 700; color: #5b6b80;
  text-align: center; padding: 8px 4px; border-bottom: 1px solid #e4eaf3;
  position: sticky; top: 0; z-index: 3;
}
.trk-col-head { min-width: 78px; }
.trk-col-name { line-height: 1.3; white-space: nowrap; }
.trk-col-meta { margin-top: 3px; font-weight: 400; font-size: 10px; }
.trk-req { color: #8a94a6; }
.trk-opt { color: #d97706; }
.trk-bi { font-size: 9px; color: #2563eb; background: #e8f0ff; border-radius: 3px; padding: 0 3px; margin-left: 2px; }

/* 左侧固定列 */
.trk-fixed {
  position: sticky; left: 0; z-index: 4;
  background: #fff; min-width: 250px; max-width: 250px;
  padding: 10px 12px !important; text-align: left;
  border-right: 1px solid #e4eaf3;
}
.trk-table thead .trk-fixed { z-index: 5; background: #f7f9fd; }
.trk-order { display: flex; align-items: center; gap: 6px; }
.trk-order .mono { font-size: 12.5px; }
.trk-style { font-size: 12px; color: #33425c; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trk-cus { font-size: 11.5px; color: #8a94a6; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trk-late { color: #d92d45; font-weight: 700; }
.trk-bar { height: 6px; background: #eef1f6; border-radius: 4px; overflow: hidden; margin: 7px 0 3px; }
.trk-bar-in { height: 100%; background: #16a34a; transition: width .2s; }
.trk-prog { font-size: 11px; color: #6b7688; }
.trk-nonodes { color: #b45309; }

/* 节点格 */
.trk-cell {
  position: relative; text-align: center; cursor: pointer;
  min-width: 78px; height: 62px; font-size: 11.5px;
  border-left: 1px solid #f4f7fb;
}
.trk-cell:hover { background: #f4f8ff !important; }
.trk-ico { display: block; font-size: 13px; line-height: 1.2; }
.trk-st { display: block; font-size: 10.5px; }
.trk-date { display: block; font-size: 9.5px; color: #8a94a6; }
.trk-none { font-size: 10.5px; color: #b6bfcc; }
.trk-norow {
  background: repeating-linear-gradient(45deg, #fcfcfd, #fcfcfd 6px, #f8f9fb 6px, #f8f9fb 12px);
  color: #a8b2c1; font-size: 12px; padding: 0 14px !important; text-align: left;
  border-left: 1px solid #f4f7fb;
}

.is-pending { background: #fff; color: #98a2b3; }
.is-doing { background: #eef4ff; color: #2563eb; font-weight: 700; }
.is-done { background: #f0faf4; color: #15803d; font-weight: 700; }
.is-skipped { background: #fbfaf6; color: #b45309; }
.is-missing { background: repeating-linear-gradient(45deg, #fcfcfd, #fcfcfd 5px, #f7f8fa 5px, #f7f8fa 10px); color: #b6bfcc; }
.trk-extra { border-left: 2px dashed #e4eaf3; }

.trk-more {
  position: absolute; top: 2px; right: 2px;
  border: none; background: transparent; color: #b6bfcc;
  font-size: 13px; line-height: 1; cursor: pointer; padding: 0 3px;
}
.trk-more:hover { color: #2563eb; }
.trk-arrow { position: absolute; right: -6px; top: 50%; transform: translateY(-50%); color: #d6dde8; font-size: 14px; z-index: 2; }

/* 节点弹窗 */
.nd-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.nd-row.nd-full { display: block; }
.nd-row label { font-size: 12.5px; color: #5b6b80; min-width: 72px; }
.nd-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.nd-chip {
  border: 1px solid #e0e7f1; background: #fff; border-radius: 16px;
  padding: 4px 12px; font-size: 12px; color: #5b6b80; cursor: pointer;
}
.nd-chip.on { border-color: #2563eb; background: #eef4ff; color: #2563eb; font-weight: 700; }
.nd-hint { font-size: 11.5px; color: #8a94a6; margin-top: 5px; line-height: 1.6; }
</style>
