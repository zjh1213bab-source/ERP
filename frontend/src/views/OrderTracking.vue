<template>
  <div class="po-page">
    <div class="po-crumb">首页 / 订单 / <b>生产订单</b></div>

    <!-- ================= 筛选区（三行，对齐参考系统） ================= -->
    <div class="po-filter">
      <div class="po-frow">
        <div class="po-fitem">
          <span class="po-flabel">PO号</span>
          <select class="po-fsel" v-model="poMode" style="width: 76px">
            <option value="like">模糊</option>
            <option value="exact">精确</option>
          </select>
          <input class="po-finput" v-model="q" placeholder="搜索PO号" @keyup.enter="load" style="width: 150px" />
        </div>
        <div class="po-fitem">
          <span class="po-flabel">款号</span>
          <input class="po-finput" v-model="q" placeholder="搜索款号/客户款号" @keyup.enter="load" style="width: 190px" />
        </div>
        <button class="po-btn po-btn-primary" @click="load">批量搜索</button>
        <div class="po-fitem">
          <span class="po-flabel">订单状态</span>
          <select class="po-fsel" v-model="status" @change="onFilter" style="width: 120px">
            <option value="">全部状态</option>
            <option value="assigned">已分单</option>
            <option value="production">生产中</option>
            <option value="instock">已入库</option>
            <option value="shipped">已发货</option>
            <option value="closed">已结案</option>
            <option value="cancelled">已取消</option>
          </select>
        </div>
        <div class="po-fitem">
          <span class="po-flabel">下单时间</span>
          <input class="po-finput" type="date" v-model="orderFrom" @change="onFilter" style="width: 128px" />
          <span class="po-fsep">-</span>
          <input class="po-finput" type="date" v-model="orderTo" @change="onFilter" style="width: 128px" />
        </div>
      </div>

      <div class="po-frow">
        <div class="po-fitem">
          <span class="po-flabel">货期时间</span>
          <input class="po-finput" type="date" v-model="dueFrom" @change="onFilter" style="width: 128px" />
          <span class="po-fsep">-</span>
          <input class="po-finput" type="date" v-model="dueTo" @change="onFilter" style="width: 128px" />
        </div>
        <div class="po-fitem">
          <span class="po-flabel">标签</span>
          <select class="po-fsel" v-model="tagFilter" @change="onFilter" style="width: 104px">
            <option value="">请选择</option>
            <option value="custom">定制</option>
            <option value="stock">现货</option>
          </select>
        </div>
        <div class="po-fitem">
          <span class="po-flabel">时间排序</span>
          <select class="po-fsel" v-model="sort" @change="onFilter" style="width: 106px">
            <option value="due">货期时间</option>
            <option value="order">下单时间</option>
          </select>
        </div>
        <div class="po-fitem">
          <span class="po-flabel">排序类型</span>
          <select class="po-fsel" v-model="sortDir" @change="onFilter" style="width: 84px">
            <option value="asc">正序</option>
            <option value="desc">倒序</option>
          </select>
        </div>
      </div>

      <div class="po-frow">
        <div class="po-fitem">
          <span class="po-flabel">搜索节点</span>
          <select class="po-fsel" v-model="nodeCode" @change="onFilter" style="width: 116px">
            <option value="">请选择</option>
            <option v-for="c in board.columns" :key="c.code" :value="c.code">{{ c.name }}</option>
          </select>
        </div>
        <div class="po-fitem">
          <span class="po-flabel">节点状态</span>
          <select class="po-fsel" v-model="nodeStatus" :disabled="!nodeCode" @change="onFilter" style="width: 106px">
            <option value="">搜索状态</option>
            <option value="pending">未开始</option>
            <option value="doing">进行中</option>
            <option value="done">已完成</option>
            <option value="skipped">不适用</option>
          </select>
        </div>
        <div class="po-fitem">
          <span class="po-flabel">业务员</span>
          <input class="po-finput" v-model="manager" placeholder="搜索业务员" @keyup.enter="load" style="width: 116px" />
        </div>
        <label class="po-switch">
          <input type="checkbox" v-model="noNodes" @change="onFilter" />
          无工序订单
        </label>
        <label class="po-switch">
          <input type="checkbox" v-model="noDue" @change="onFilter" />
          外发工艺订单
        </label>
        <div class="po-fitem">
          <span class="po-flabel">订单沟通内容</span>
          <input class="po-finput" v-model="q" placeholder="搜索订单沟通内容" @keyup.enter="load" style="width: 150px" />
        </div>
        <a class="po-reset" @click="resetAll">重置搜索</a>
      </div>
    </div>

    <!-- ================= 展开货期 ================= -->
    <div class="po-expand" @click="showDue = !showDue">{{ showDue ? '收起货期' : '展开货期' }}</div>
    <div v-if="showDue" class="po-duebar">
      <div v-for="d in dueStrip" :key="d.date" class="po-dueday" :class="{ hot: d.overdue > 0, on: d.date === today }">
        <div class="po-duedate">{{ d.label }}</div>
        <div class="po-duenum">{{ d.count }}<span v-if="d.overdue" class="po-dueod">/{{ d.overdue }}</span></div>
      </div>
      <div v-if="!dueStrip.length" class="po-duenone">当前筛选下没有填了货期的订单</div>
    </div>

    <!-- ================= Tab ================= -->
    <div class="po-tabs">
      <button v-for="t in tabs" :key="t.key" class="po-tab" :class="{ on: tab === t.key }" @click="setTab(t.key)">
        {{ t.label }}<span v-if="t.count" class="po-tabnum" :class="{ danger: t.danger }">({{ t.count }})</span>
      </button>
    </div>

    <!-- ================= 工具行 ================= -->
    <div class="po-tools">
      <button class="po-btn">两款汇总</button>
      <button class="po-btn">更多 <span class="po-caret">▾</span></button>
      <button class="po-btn" @click="canFlow && $router.push('/node-flow')">流程设置</button>
      <button class="po-btn">操作视频</button>
      <div class="po-view">
        <button class="po-vbtn on" title="列表视图">☰</button>
        <button class="po-vbtn" title="看板视图" @click="$router.push('/node-flow')">▦</button>
      </div>
      <span class="po-spacer"></span>
      <span class="po-total">共 {{ filteredRows.length }} 条</span>
      <select class="po-fsel" v-model.number="pageSize" @change="page = 1" style="width: 92px">
        <option :value="12">12条/页</option>
        <option :value="50">50条/页</option>
        <option :value="200">200条/页</option>
      </select>
      <div class="po-pager">
        <button class="po-pg" :disabled="page <= 1" @click="page--">‹</button>
        <button v-for="p in pageList" :key="p" class="po-pg" :class="{ on: p === page }" @click="page = p">{{ p }}</button>
        <button class="po-pg" :disabled="page >= pageCount" @click="page++">›</button>
      </div>
      <span class="po-goto">前往 <input class="po-finput" style="width: 44px; text-align: center" v-model.number="page" /> 页</span>
    </div>

    <!-- ================= 订单列表 ================= -->
    <div class="po-list">
      <div v-if="loading" class="po-empty">加载中…</div>
      <div v-else-if="!pagedRows.length" class="po-empty">没有符合条件的订单</div>

      <div v-for="r in pagedRows" :key="r.id" class="po-item">
        <!-- ---------- 左：订单信息 ---------- -->
        <div class="po-info">
          <div class="po-info-content">
            <span class="po-pin" :title="r.no_nodes ? '未生成工序' : '已生成工序'">●</span>
            <div class="po-img" :class="{ empty: !thumbOf(r) }" @click="thumbOf(r) && openImage(r.thumb, r.order_no)">
              <img v-if="thumbOf(r)" :src="r.thumb" alt="" @error="onThumbErr(r.id)" />
              <span v-else class="po-img-ph">{{ phText(r) }}<em>无图</em></span>
              <div class="po-state" :class="'st-' + r.status">{{ statusLabel(r.status) }}</div>
              <div v-if="r.type === 'custom'" class="po-re">首单</div>
            </div>
            <div class="po-text">
              <div class="po-row po-due-row">
                <template v-if="r.delivery_date">
                  货期：<b>{{ String(r.delivery_date).slice(5) }}</b>
                  <span v-if="r.overdue" class="po-left-od">超期{{ r.days_late }}天</span>
                  <span v-else class="po-left-ok">剩余{{ daysLeft(r) }}天</span>
                </template>
                <span v-else class="po-nodue">未填货期</span>
              </div>
              <div class="po-row clickable" @click="openPeek(r.id)">款号：{{ r.style_name || '—' }}</div>
              <div class="po-row clickable" @click="openPeek(r.id)">PO号：{{ r.order_no }}</div>
              <div class="po-row">客户：{{ r.customer_name || '—' }}</div>
              <div class="po-row">跟单员：{{ r.manager || '—' }}</div>
              <div class="po-row">
                工厂：<b :class="{ 'po-unassigned': r.assign_mode === 'none' }">{{ assignText(r) }}</b>
              </div>
              <div class="po-row">创建时间：{{ r.order_date ? String(r.order_date).slice(0, 10) : '—' }}</div>
              <div class="po-row">业务员：{{ r.manager || '—' }}</div>
              <div class="po-tags">
                <span class="po-tag">{{ r.type === 'stock' ? '现货' : '定制' }}</span>
                <span v-if="isUnassigned(r)" class="po-tag warn">待分配</span>
                <span v-else-if="r.assign_mode === 'none'" class="po-tag gray">未记录分单</span>
                <span v-else-if="r.assign_mode === 'outsource'" class="po-tag out">外发</span>
                <span v-if="r.cut_dispatches > 0" class="po-tag">裁片外发</span>
                <span v-if="r.overdue" class="po-tag danger">超期</span>
                <span v-if="r.no_nodes" class="po-tag warn">无工序</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ---------- 中：工序节点 ---------- -->
        <div class="po-flow">
          <div class="po-flow-left">
            <div class="po-flow-scroll">
              <div class="po-flow-list">
                <!-- 整格可点：点开这一步的弹窗（采购类看明细，其余看备注/凭证/操作记录）。
                     「沟通」单独一个按钮，stop 掉冒泡，仍然是原来的留言弹窗 ——
                     两件事：查看这一环节的状态与证据 / 跟这一环节的人说话。 -->
                <div v-for="(cell, i) in r.cells" :key="cell.code" class="po-fnode">
                  <div class="po-fnode-in" :class="{ clickable: !!cell.node_id }"
                    :title="cell.node_id ? '点开看这一步的明细与记录' : '这单还没生成工序'"
                    @click.stop="openPanel(r, cell)">
                    <div class="po-fnode-name">
                      <div class="po-fnode-title">{{ cell.name }}</div>
                    </div>
                    <div class="po-fnode-body">
                      <i class="po-fico" :class="'is-' + cell.status">{{ ico(cell.status) }}</i>
                      <div class="po-fnode-sub" :class="'is-' + cell.status">{{ subOf(cell) }}</div>
                      <div class="po-chat" @click.stop="openNode(r, cell)">沟通</div>
                    </div>
                  </div>
                  <span v-if="i < r.cells.length - 1" class="po-farrow">»</span>
                </div>
                <div v-if="!r.cells.length" class="po-flow-none">未生成工序</div>
              </div>
            </div>
          </div>

          <!-- ---------- 右：操作 ---------- -->
          <div class="po-ops">
            <a class="po-op" @click="openPeek(r.id)">打印</a>
            <a class="po-op" @click="openPeek(r.id)">工序</a>
            <a class="po-op" @click="openPeek(r.id)">异常</a>
            <a class="po-op" @click="openPeek(r.id)">详情</a>
            <a class="po-op" @click="openPeek(r.id)">编辑</a>
            <a class="po-op" @click="openNode(r, firstOpenCell(r))">沟通</a>
            <a class="po-op po-op-more" @click="openPeek(r.id)">更多</a>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 工序节点面板（按节点类型分化） ================= -->
    <NodePanel v-model:open="panelOpen" :node-id="panelNodeId" @changed="load" />

    <!-- ================= 订单信息看板 ================= -->
    <OrderPeek v-model:open="peekOpen" :order-id="peekId" />

    <!-- ================= 节点：计划 / 责任人 / 沟通 ================= -->
    <div v-if="dlg.open" class="modal-mask" @click.self="dlg.open = false">
      <div class="modal" style="width: 480px">
        <div class="modal-head">
          <h3>{{ dlg.name }} · {{ dlg.orderNo }}</h3>
          <button class="x" @click="dlg.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="po-dlg-row">
            <label>状态</label>
            <div class="po-chips">
              <button v-for="s in ['pending', 'doing', 'done', 'skipped']" :key="s" class="po-chip"
                :class="{ on: dlg.status === s }" @click="dlg.status = s">{{ stLabel(s) }}</button>
            </div>
          </div>
          <div class="po-dlg-row">
            <label>计划完成</label>
            <input class="input" type="date" v-model="dlg.plan_date" style="width: 170px" />
          </div>
          <div class="po-dlg-row">
            <label>责任人</label>
            <input class="input" v-model="dlg.operator" placeholder="车间 / 外协厂 / 具体人" style="width: 220px" />
          </div>
          <div v-if="dlg.status === 'skipped'" class="po-dlg-row">
            <label>不适用原因 *</label>
            <input class="input" v-model="dlg.skip_reason" placeholder="如：这单是现货款，不做水洗" />
          </div>
          <div class="po-dlg-row" style="display: block">
            <label style="display: block; margin-bottom: 5px">沟通 / 留言</label>
            <textarea class="input" rows="3" v-model="dlg.remark" placeholder="在这个环节要说明的事，会追加到节点备注"></textarea>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="dlg.open = false">取消</button>
          <button class="btn btn-primary" :disabled="dlg.saving" @click="saveNode">{{ dlg.saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue';
import { api } from '../api';
import { openImage } from '../store/viewer';
import { can } from '../store/permissions';
import OrderPeek from '../components/OrderPeek.vue';
import NodePanel from '../components/NodePanel.vue';

const loading = ref(false);
const board = ref({ template: null, columns: [], rows: [], stats: {}, summary: {} });
const templates = ref([]);
const tplId = ref(null);

/* ---- 筛选（对齐参考系统的三行） ---- */
const poMode = ref('like');
const q = ref('');
const status = ref('');
const orderFrom = ref('');
const orderTo = ref('');
const dueFrom = ref('');
const dueTo = ref('');
const tagFilter = ref('');
const sort = ref('due');
const sortDir = ref('asc');
const manager = ref('');
const nodeCode = ref('');
const nodeStatus = ref('');
const noNodes = ref(false);
const noDue = ref(false);

const tab = ref('all');
const showDue = ref(false);
const page = ref(1);
const pageSize = ref(12);
const canFlow = can('node.flow');

const today = new Date().toISOString().slice(0, 10);

const statusLabel = (s) => ({
  draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
  instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
}[s] || s);
const stLabel = (s) => ({ pending: '待开始', doing: '进行中', done: '已完成', skipped: '不适用' }[s] || s);

/**
 * 节点图标：与参考系统一致 —— 全部是「圆圈打勾」，靠颜色区分状态
 * （灰 待开始 / 蓝 进行中 / 绿 已完成 / 橙 不适用）。
 * 不用四种不同形状：看板上 13 个节点 × 20 行，形状多了反而看不出进度到哪。
 */
/**
 * 节点图标
 *
 * 原来不管什么状态都返回 ✓，只靠颜色区分 —— 于是「还没开始」的格子在截图里
 * 看起来也是打勾的。加了「分配」这类真动作之后这很要命：待分配的单看起来
 * 像已经分过了，而实际上一件都没分。没做的就是空心圈，做过的才打勾。
 */
const ico = (s) => ({
  done: '✓',
  skipped: '⊘',
  doing: '▶',
  pending: '○',
  none: '–'
}[s] || '○');

/** 节点下那行小字：完成就给日期，在办给「进行中」，其余给「-」（参考系统也是这么留的） */
function subOf(cell) {
  if (cell.status === 'done' && cell.actual_date) return String(cell.actual_date).slice(5);
  if (cell.status === 'doing') return '进行中';
  if (cell.status === 'skipped') return '不适用';
  return '-';
}

/* ---- 款图 ---- */
const broken = reactive({});
function onThumbErr(id) { broken[id] = true; }
function thumbOf(r) { return broken[r.id] ? '' : (r.thumb || ''); }
function phText(r) {
  const m = String(r.style_name || '').match(/[\u4e00-\u9fa5]/);
  if (m) return m[0];
  return String(r.order_no || '?').trim().slice(0, 1);
}

/**
 * 「工厂」这一行显示什么
 *
 * 全部从分单事实来：没分单就是「未分配」，不许默认为「本厂」——
 * 原来这行是写死的「本厂」，于是还没定谁做的单也显示"本厂生产"，
 * 谁也没法从看板上看出哪些单还悬着。
 *
 * 已经投产（production/instock）却没分单记录的，是**老数据缺口**，
 * 不能标成「待分配」——那会让每一张老单都跳出来喊"还没分配"，
 * 反而淹掉真正等着分配的新单。
 */
function assignText(r) {
  const names = String(r.assign_names || '').split(',').filter(Boolean);
  if (r.assign_mode === 'none') {
    return ['finance', 'assigned'].includes(r.status) ? '未分配' : '未记录分单';
  }
  if (r.assign_mode === 'outsource') return names.length ? `外协 · ${names.join(' / ')}` : '整单外发';
  if (r.assign_mode === 'mixed') {
    const ownName = names.find((n) => /本厂|自有/.test(n));
    const others = names.filter((n) => n !== ownName);
    return `本厂${others.length ? ' + ' + others.join(' / ') : ' + 外协'}`;
  }
  return names.length && !/本厂|自有/.test(names[0]) ? names[0] : '本厂';
}

/** 真正「等着分配」的单：还没定归属，且还没投产 */
function isUnassigned(r) {
  return r.assign_mode === 'none' && ['finance', 'assigned'].includes(r.status);
}

function daysLeft(r) {
  if (!r.delivery_date) return '';
  const d = new Date(String(r.delivery_date).slice(0, 10) + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

/* ---- Tab：全部在前端过滤，切换不再请求，所以点起来是即时的 ---- */
const tabs = computed(() => {
  const rows = board.value.rows || [];
  return [
    { key: 'all', label: '全部', count: rows.length },
    { key: 'todo', label: '待分配订单', count: rows.filter((r) => isUnassigned(r)).length },
    { key: 'own', label: '本厂生产', count: rows.filter((r) => r.alloc_own > 0).length },
    { key: 'outsource', label: '整单外发', count: rows.filter((r) => r.assign_mode === 'outsource').length },
    { key: 'cutout', label: '裁片外发', count: rows.filter((r) => r.cut_dispatches > 0).length },
    { key: 'instock', label: '已入库', count: rows.filter((r) => r.status === 'instock').length },
    { key: 'overdue', label: '超期订单', count: rows.filter((r) => r.overdue).length, danger: true },
    { key: 'odd', label: '订单异常', count: rows.filter((r) => !r.delivery_date || r.no_nodes).length, danger: true },
    { key: 'void', label: '作废订单', count: rows.filter((r) => r.status === 'cancelled').length }
  ];
});
/**
 * 「待分配订单」= 还没定自己做还是发外协（**看分单事实，不看节点状态**）
 *
 * 原来按「流程第一个节点还没动」判。加了分配动作之后这就不准了：
 * 节点可以被标「不适用」、也可以被人手工点绿，但"这单给了谁做"只有分单表知道。
 * 而且节点判定把「在产但没分单记录」的老单也一并算成待分配，
 * 于是真正的待分配单被埋在一堆老数据里。
 */
function setTab(k) { tab.value = k; page.value = 1; }

const filteredRows = computed(() => {
  const rows = board.value.rows || [];
  switch (tab.value) {
    case 'todo': return rows.filter((r) => isUnassigned(r));
    case 'own': return rows.filter((r) => r.alloc_own > 0);
    case 'outsource': return rows.filter((r) => r.assign_mode === 'outsource');
    case 'cutout': return rows.filter((r) => r.cut_dispatches > 0);
    case 'instock': return rows.filter((r) => r.status === 'instock');
    case 'overdue': return rows.filter((r) => r.overdue);
    case 'odd': return rows.filter((r) => !r.delivery_date || r.no_nodes);
    case 'void': return rows.filter((r) => r.status === 'cancelled');
    default: return rows;
  }
});

const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / pageSize.value)));
const pagedRows = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filteredRows.value.slice(start, start + pageSize.value);
});
const pageList = computed(() => {
  const n = pageCount.value;
  let from = Math.max(1, page.value - 2);
  const to = Math.min(n, from + 4);
  from = Math.max(1, to - 4);
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
});

/** 货期横条：按交期聚合，一眼看出哪几天压单多、哪几天有超期 */
const dueStrip = computed(() => {
  const map = new Map();
  (board.value.rows || []).forEach((r) => {
    const d = r.delivery_date ? String(r.delivery_date).slice(0, 10) : '';
    if (!d) return;
    if (!map.has(d)) map.set(d, { date: d, count: 0, overdue: 0 });
    const x = map.get(d);
    x.count += 1;
    if (r.overdue) x.overdue += 1;
  });
  return [...map.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 21)
    .map((x) => ({ ...x, label: x.date.slice(5).replace('-', '.') }));
});

function onFilter() { page.value = 1; load(); }

async function load() {
  loading.value = true;
  try {
    const [ts, b] = await Promise.all([
      api.nodeFlowTemplates(),
      api.nodeFlowBoard({
        template_id: tplId.value || '',
        status: status.value,
        q: q.value,
        manager: manager.value,
        order_from: orderFrom.value,
        order_to: orderTo.value,
        due_from: dueFrom.value,
        due_to: dueTo.value,
        no_due: noDue.value ? 1 : '',
        node_code: nodeCode.value,
        node_status: nodeStatus.value,
        sort: sort.value,
        limit: 500
      })
    ]);
    templates.value = ts || [];
    board.value = b || { template: null, columns: [], rows: [], stats: {}, summary: {} };
    if (!tplId.value && b && b.template) tplId.value = b.template.id;
  } finally {
    loading.value = false;
  }
}

function resetAll() {
  q.value = ''; status.value = ''; orderFrom.value = ''; orderTo.value = '';
  dueFrom.value = ''; dueTo.value = ''; tagFilter.value = ''; manager.value = '';
  nodeCode.value = ''; nodeStatus.value = ''; noNodes.value = false; noDue.value = false;
  sort.value = 'due'; sortDir.value = 'asc';
  tab.value = 'all'; page.value = 1;
  load();
}

/* ---- 速览 / 打印 ---- */
const peekOpen = ref(false);
const peekId = ref(null);
function openPeek(id) { if (!id) return; peekId.value = id; peekOpen.value = true; }

/* ---- 节点面板：点格子打开，内容由后端按节点的 panel 类型决定 ---- */
const panelOpen = ref(false);
const panelNodeId = ref(null);
function openPanel(r, cell) {
  if (!cell || !cell.node_id) { openPeek(r.id); return; }
  panelNodeId.value = cell.node_id;
  panelOpen.value = true;
}

/* ---- 节点弹窗（沟通留言，保留原样） ---- */
function firstOpenCell(r) {
  return (r.cells || []).find((c) => c.status === 'doing')
    || (r.cells || []).find((c) => c.status === 'pending')
    || (r.cells || [])[0];
}
const dlg = reactive({
  open: false, nodeId: null, orderNo: '', name: '', saving: false,
  status: 'pending', plan_date: '', operator: '', remark: '', skip_reason: ''
});
function openNode(r, cell) {
  if (!cell || !cell.node_id) { openPeek(r.id); return; }
  dlg.open = true;
  dlg.nodeId = cell.node_id;
  dlg.orderNo = r.order_no;
  dlg.name = cell.name;
  dlg.status = cell.status;
  dlg.plan_date = cell.plan_date || '';
  dlg.operator = cell.operator || '';
  dlg.remark = '';
  dlg.skip_reason = cell.skip_reason || '';
}
async function saveNode() {
  dlg.saving = true;
  try {
    const body = { status: dlg.status, plan_date: dlg.plan_date || null, operator: dlg.operator || null };
    if (dlg.status === 'skipped') body.skip_reason = dlg.skip_reason;
    if (dlg.remark.trim()) body.remark = ` [${today} ${dlg.remark.trim()}]`;
    await api.updateNode(dlg.nodeId, body);
    dlg.open = false;
    await load();
  } catch (e) { alert(e.message); } finally { dlg.saving = false; }
}

onMounted(load);
</script>

<style scoped>
/* 配色与尺寸对齐参考系统（衣创生产订单） */
.po-page {
  --po-blue: #1890ff; --po-line: #eaebed; --po-gray: #808080;
  --po-orange: #ffa500; --po-text: #606266;
  background: #f0f2f5; padding: 8px;
}

/* 面包屑：参考页顶部是「首页 / 订单 / 生产订单」，没有大标题 */
.po-crumb { font-size: 12.5px; color: #909399; padding: 2px 4px 8px; }
.po-crumb b { color: #303133; font-weight: 600; }

/* ---------- 筛选区 ---------- */
.po-filter { background: #fff; padding: 10px 12px 4px; border-radius: 3px; }
.po-frow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.po-fitem { display: flex; align-items: center; gap: 6px; }
.po-flabel { font-size: 12.5px; color: #606266; white-space: nowrap; }
.po-finput, .po-fsel {
  height: 30px; border: 1px solid #dcdfe6; border-radius: 3px;
  padding: 0 8px; font-size: 12.5px; color: #303133; background: #fff; outline: none;
}
.po-finput:focus, .po-fsel:focus { border-color: var(--po-blue); }
.po-fsel { cursor: pointer; }
.po-fsel:disabled { background: #f5f7fa; color: #c0c4cc; }
.po-fsep { color: #c0c4cc; font-size: 12px; }
.po-btn {
  height: 30px; padding: 0 12px; border: 1px solid #dcdfe6; border-radius: 3px;
  background: #fff; color: #606266; font-size: 12.5px; cursor: pointer;
}
.po-btn:hover { border-color: #c6e2ff; color: var(--po-blue); }
.po-btn-primary { background: var(--po-blue); border-color: var(--po-blue); color: #fff; }
.po-btn-primary:hover { background: #40a9ff; color: #fff; }
.po-caret { font-size: 10px; color: #909399; }
.po-switch { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: #606266; cursor: pointer; }
.po-reset { font-size: 12.5px; color: var(--po-blue); cursor: pointer; margin-left: 4px; }

/* ---------- 展开货期 ---------- */
.po-expand {
  text-align: center; font-size: 12.5px; color: var(--po-blue);
  padding: 3px 0 7px; cursor: pointer; background: #fff;
}
.po-expand:hover { text-decoration: underline; }
.po-duebar { display: flex; gap: 4px; overflow-x: auto; background: #fff; padding: 0 12px 10px; }
.po-dueday { min-width: 60px; border: 1px solid #ebeef5; border-radius: 3px; padding: 4px 6px; text-align: center; background: #fafafa; }
.po-dueday.hot { border-color: #fde2e2; background: #fef0f0; }
.po-dueday.on { border-color: var(--po-blue); background: #ecf5ff; }
.po-duedate { font-size: 11px; color: #909399; }
.po-duenum { font-size: 13px; font-weight: 700; color: #303133; }
.po-dueod { color: #f56c6c; font-size: 11px; font-weight: 400; }
.po-duenone { font-size: 12px; color: #c0c4cc; padding: 8px 0; }

/* ---------- Tab ---------- */
.po-tabs { display: flex; gap: 2px; background: #fff; padding: 0 12px; border-bottom: 1px solid var(--po-line); overflow-x: auto; }
.po-tab { border: none; background: transparent; padding: 9px 14px; font-size: 13px; color: #606266; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; }
.po-tab:hover { color: var(--po-blue); }
.po-tab.on { color: var(--po-blue); border-bottom-color: var(--po-blue); font-weight: 700; }
.po-tabnum { display: inline-block; margin-left: 3px; font-size: 11px; font-weight: 700; color: #909399; }
.po-tabnum.danger { color: #f56c6c; }

/* ---------- 工具行 ---------- */
.po-tools { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #fff; flex-wrap: wrap; }
.po-view { display: flex; border: 1px solid #dcdfe6; border-radius: 3px; overflow: hidden; }
.po-vbtn { width: 30px; height: 28px; border: none; background: #fff; color: #909399; cursor: pointer; font-size: 13px; }
.po-vbtn.on { background: var(--po-blue); color: #fff; }
.po-spacer { flex: 1; }
.po-total { font-size: 12.5px; color: #606266; }
.po-pager { display: flex; gap: 3px; }
.po-pg { min-width: 26px; height: 26px; border: 1px solid #dcdfe6; border-radius: 3px; background: #fff; color: #606266; font-size: 12px; cursor: pointer; }
.po-pg.on { background: var(--po-blue); border-color: var(--po-blue); color: #fff; }
.po-pg:disabled { opacity: .4; cursor: not-allowed; }
.po-goto { font-size: 12.5px; color: #606266; display: flex; align-items: center; gap: 4px; }

/* ---------- 订单行 ---------- */
.po-list { background: #fff; padding: 10px; }
.po-empty { padding: 46px 0; text-align: center; color: #909399; font-size: 13px; }
.po-item { display: flex; border: 1px solid var(--po-line); border-radius: 3px; margin-bottom: 8px; background: #fff; }
.po-item:hover { box-shadow: 0 1px 6px rgba(0, 0, 0, .06); }

/* 左：信息 */
.po-info { width: 388px; flex: none; border-right: 1px solid #f2f3f5; }
.po-info-content { display: flex; gap: 6px; padding: 8px; }
.po-pin { color: var(--po-blue); font-size: 10px; line-height: 14px; }
.po-img { width: 100px; height: 140px; flex: none; position: relative; border-radius: 2px; overflow: hidden; background: #f5f7fa; cursor: pointer; }
.po-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.po-img.empty { cursor: default; display: flex; align-items: center; justify-content: center; }
.po-img-ph { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 20px; font-weight: 700; color: #c8d0dc; }
.po-img-ph em { font-size: 10px; font-style: normal; font-weight: 400; color: #d6dde8; }
/* 状态是一道压在图片底部的色带 —— 参考系统就是这样，比单独放个标签更省地方 */
.po-state { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; line-height: 22px; text-align: center; font-size: 12px; color: #fff; background: #ffa500; }
.po-state.st-production { background: #ffa500; }
.po-state.st-assigned { background: #909399; }
.po-state.st-instock { background: #67c23a; }
.po-state.st-shipped { background: #409eff; }
.po-state.st-closed { background: #b1b3b8; }
.po-state.st-cancelled { background: #f56c6c; }
.po-re { position: absolute; right: 0; top: 0; background: #f56c6c; color: #fff; font-size: 11px; padding: 1px 5px; border-bottom-left-radius: 4px; }

.po-text { flex: 1; min-width: 0; font-size: 12px; line-height: 19px; color: var(--po-text); }
.po-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.po-row.clickable { cursor: pointer; }
.po-row.clickable:hover { color: var(--po-blue); }
.po-due-row b { color: #303133; }
.po-left-od { color: #f56c6c; font-weight: 700; margin-left: 4px; }
.po-left-ok { color: #e6a23c; margin-left: 4px; }
.po-nodue { color: #f56c6c; }
.po-tags { display: flex; gap: 4px; margin-top: 2px; flex-wrap: wrap; }
.po-tag { font-size: 10.5px; line-height: 15px; padding: 0 5px; border-radius: 2px; background: #f0f9eb; color: #67c23a; border: 1px solid #e1f3d8; }
.po-tag.danger { background: #fef0f0; color: #f56c6c; border-color: #fde2e2; }
.po-tag.warn { background: #fdf6ec; color: #e6a23c; border-color: #faecd8; }
.po-tag.out { background: #f4f0ff; color: #7c3aed; border-color: #e6dbff; }
.po-tag.gray { background: #f4f6f9; color: #8a94a6; border-color: #e9edf3; }
.po-unassigned { color: #e6a23c !important; font-weight: 400; }

/* 中：工序 */
.po-flow { flex: 1; min-width: 0; display: flex; }
.po-flow-left { flex: 1; min-width: 0; overflow: hidden; }
.po-flow-scroll { overflow-x: auto; padding: 4px 0 0; }
.po-flow-list { display: flex; align-items: flex-start; min-height: 148px; }
.po-flow-none { padding: 46px 16px; color: #c0c4cc; font-size: 12.5px; }

.po-fnode { width: 120px; flex: none; position: relative; text-align: center; }
.po-fnode-in { border-radius: 4px; padding-top: 2px; }
.po-fnode-in.clickable { cursor: pointer; }
.po-fnode-in.clickable:hover { background: #f7fbff; box-shadow: inset 0 0 0 1px #d6e8ff; }
.po-fnode-name { height: 58px; display: flex; align-items: flex-end; justify-content: center; padding: 0 4px; }
.po-fnode-title { font-size: 13px; font-weight: 700; color: var(--po-gray); line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.po-fnode-body { height: 84px; padding-top: 5px; }
.po-fico { font-size: 20px; line-height: 1; font-style: normal; color: var(--po-gray); display: block; }
.po-fico.is-done { color: #67c23a; }
.po-fico.is-doing { color: var(--po-blue); }
.po-fico.is-skipped { color: #e6a23c; }
.po-fnode-sub { font-size: 12px; color: var(--po-gray); line-height: 19px; }
.po-fnode-sub.is-done { color: #67c23a; }
.po-fnode-sub.is-doing { color: var(--po-blue); }
.po-chat { font-size: 12.5px; color: var(--po-blue); cursor: pointer; line-height: 20px; }
.po-chat:hover { text-decoration: underline; }
.po-farrow { position: absolute; right: -5px; top: 96px; color: #c0c4cc; font-size: 15px; z-index: 2; }

/* 右：操作（两列） */
.po-ops { width: 120px; flex: none; display: flex; flex-wrap: wrap; align-content: flex-start; padding: 8px 6px; }
.po-op { width: 54px; font-size: 12.5px; color: var(--po-blue); cursor: pointer; line-height: 22px; text-align: center; }
.po-op:hover { text-decoration: underline; }
.po-op-more { width: 108px; text-align: left; padding-left: 22px; }

/* 节点弹窗 */
.po-dlg-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.po-dlg-row label { font-size: 12.5px; color: #5b6b80; min-width: 76px; }
.po-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.po-chip { border: 1px solid #e0e7f1; background: #fff; border-radius: 16px; padding: 4px 12px; font-size: 12px; color: #5b6b80; cursor: pointer; }
.po-chip.on { border-color: var(--po-blue); background: #ecf5ff; color: var(--po-blue); font-weight: 700; }
</style>
