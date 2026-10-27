<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>接单评审与交期承诺</h2>
        <p class="sub">
          一单一条承诺：前端裁床、后端缝制、物料齐套三项分别确认才能承接；对客承诺日 / 内部计划日 / 最新预测 / 实际出厂四个日期独立保留。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="loadAll">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>待评审</span>
        <strong :class="stat.pending ? 'amt-orange' : ''">{{ stat.pending || 0 }}</strong>
        <small>未评审不能进技术确认</small>
      </div>
      <div class="stat">
        <span>已通过</span>
        <strong class="amt-green">{{ stat.approved || 0 }}</strong>
        <small>驳回 {{ stat.rejected || 0 }} 条</small>
      </div>
      <div class="stat">
        <span>红色预警</span>
        <strong :class="stat.risk_red ? 'amt-red' : ''">{{ stat.risk_red || 0 }}</strong>
        <small>预测超过承诺日</small>
      </div>
      <div class="stat">
        <span>缓冲不足</span>
        <strong :class="stat.risk_yellow ? 'amt-orange' : ''">{{ stat.risk_yellow || 0 }}</strong>
        <small>已交付 {{ stat.done || 0 }} 单</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="订单号 / 客户 / 款号" style="width: 230px" @keyup.enter="loadBoard" />
      <select class="select" v-model="review" style="width: 130px" @change="loadBoard">
        <option value="">全部评审状态</option>
        <option value="pending">待评审</option>
        <option value="approved">已通过</option>
        <option value="rejected">未通过</option>
      </select>
      <select class="select" v-model="risk" style="width: 130px" @change="loadBoard">
        <option value="">全部风险</option>
        <option value="red">红色预警</option>
        <option value="yellow">缓冲不足</option>
        <option value="done">已交付</option>
      </select>
      <button class="btn btn-ghost" @click="loadBoard">查询</button>
      <div style="flex: 1"></div>
      <span class="muted" style="font-size: 12px">月产能 {{ cap.capacity_per_month || 5000 }} 件 · 在制 {{ cap.wip_qty || 0 }} 件</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 148px">订单号</th>
            <th style="min-width: 150px">客户 / 款号</th>
            <th style="width: 62px">件数</th>
            <th style="width: 96px">T0 起算</th>
            <th style="width: 100px">对客承诺</th>
            <th style="width: 100px">内部计划</th>
            <th style="width: 100px">最新预测</th>
            <th style="width: 90px">偏差</th>
            <th style="width: 96px">进度</th>
            <th style="width: 82px">评审</th>
            <th style="width: 86px">风险</th>
            <th style="width: 110px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ 'row-red': r.risk_level === 'red', 'row-yellow': r.risk_level === 'yellow' }">
            <td>{{ r.order_no }}</td>
            <td class="sub-cell">
              <div>{{ r.customer_name || '-' }}</div>
              <div class="muted" style="font-size: 11.5px">{{ r.style_no || '-' }}</div>
            </td>
            <td class="center">{{ r.qty }}</td>
            <td>{{ r.t0_at || '-' }}</td>
            <td>{{ r.promised_date || '-' }}</td>
            <td class="muted">{{ r.planned_date || '-' }}</td>
            <td :class="gapCls(r)">{{ r.forecast_date || '-' }}</td>
            <td :class="gapCls(r)">
              {{ r.promise_gap === 0 ? '准时' : (r.promise_gap > 0 ? '超 ' + r.promise_gap + ' 天' : '提前 ' + Math.abs(r.promise_gap) + ' 天') }}
            </td>
            <td>
              <div class="prog"><i :style="{ width: (r.progress || 0) + '%' }"></i></div>
              <span class="muted" style="font-size: 11px">{{ r.progress || 0 }}%</span>
            </td>
            <td><span class="tag" :class="reviewTag(r.review_status)">{{ reviewText(r.review_status) }}</span></td>
            <td><span class="tag" :class="riskTag(r.risk_level)">{{ riskText(r.risk_level) }}</span></td>
            <td class="ops">
              <button class="link-btn" @click="openReview(r)">{{ r.review_status === 'approved' ? '复核' : '评审' }}</button>
              <button class="link-btn" @click="openTimeline(r)">时间轴</button>
            </td>
          </tr>
          <tr v-if="!rows.length"><td colspan="12" class="empty-cell">还没有订单承诺记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 评审弹窗 -->
    <div v-if="cur" class="modal-mask" @click.self="cur = null">
      <div class="modal xwide cm-modal">
        <div class="modal-head">
          <h3>
            接单评审 · {{ cur.order_no }}
            <span class="muted" style="font-weight: 400; font-size: 12px">{{ cur.customer_name }} · {{ cur.qty }} 件</span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <!-- 三时钟 -->
          <div class="ck-clock">
            <div><span>T0 起算</span><b>{{ cur.t0_at || '待定' }}</b><em>{{ t0SourceText(cur.t0_source) }}</em></div>
            <div><span>对客承诺日</span><b>{{ form.promised_date || '待填' }}</b><em>答应客户的日期</em></div>
            <div><span>内部计划日</span><b class="muted">{{ cur.planned_date || '待排' }}</b><em>按路线节点推算</em></div>
            <div><span>最新预测</span><b :class="gapCls(cur)">{{ cur.forecast_date || '-' }}</b><em>按实绩 + 剩余工时</em></div>
          </div>

          <h4 class="cm-h4">
            承接确认
            <span class="muted" style="font-weight: 400; font-size: 12px">三项必须分别确认，任一项不通过即不承接</span>
          </h4>
          <div class="cm-checks">
            <label class="cm-check" :class="{ on: form.front_ok }">
              <input type="checkbox" v-model="form.front_ok" />
              <div>
                <b>前端：裁床 · 算料</b>
                <span>裁床档期、算料人力能否在本周内启动</span>
              </div>
            </label>
            <label class="cm-check" :class="{ on: form.back_ok }">
              <input type="checkbox" v-model="form.back_ok" />
              <div>
                <b>后端：缝制 · 后道</b>
                <span>缝制线 / 后道工位是否有档期，是否需要外发</span>
              </div>
            </label>
            <label class="cm-check" :class="{ on: form.material_ok }">
              <input type="checkbox" v-model="form.material_ok" />
              <div>
                <b>物料：齐套或供应可靠</b>
                <span>面料辅料已有库存，或供应商确认到货日</span>
              </div>
            </label>
          </div>

          <!-- 产能负荷参考 -->
          <div class="cm-cap">
            <div class="cm-cap-item"><span>月产能</span><b>{{ cap.capacity_per_month }} 件</b></div>
            <div class="cm-cap-item"><span>当前在制</span><b>{{ cap.wip_qty }} 件</b></div>
            <div class="cm-cap-item"><span>本单</span><b>{{ cur.qty }} 件</b></div>
            <div class="cm-cap-item">
              <span>负荷</span>
              <b :class="cap.load_pct > 100 ? 'amt-red' : cap.load_pct > 80 ? 'amt-orange' : 'amt-green'">{{ cap.load_pct }}%</b>
            </div>
            <div class="cm-cap-advice">{{ cap.advice }}</div>
          </div>

          <div class="form-grid" style="grid-template-columns: 1fr 1fr; margin-top: 12px">
            <div class="fitem">
              <label>对客承诺交期 *</label>
              <input class="input" type="date" v-model="form.promised_date" />
              <div v-if="planHint" class="cm-tip" :class="planHint.cls">{{ planHint.text }}</div>
            </div>
            <div class="fitem">
              <label>承接路线</label>
              <select class="select" v-model="form.route_type" :disabled="cur.total_nodes > 0">
                <option value="inhouse">本厂生产（P1…B1 → H1 → H2 → E1）</option>
                <option value="outsource">裁片外发（P1…P6 → C1 → C2 → C3 → H1 → H2 → E1）</option>
              </select>
            </div>
            <div class="fitem full">
              <label>评审意见 * <span class="muted" style="font-weight: 400">写清承接依据；不能承接时写原因</span></label>
              <textarea rows="3" v-model="form.note" placeholder="如：裁床 11/02-11/04 有空档，缝制线 11 月起排，面料供应商确认 7 天到货；如需提前需外发裁片"></textarea>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <span v-if="!allOk" class="cm-warn">有环节未勾选，将记为「不通过」</span>
          <button class="btn btn-ghost" @click="cur = null">关闭</button>
          <button class="btn btn-primary" :disabled="saving" @click="saveReview">提交评审</button>
        </div>
      </div>
    </div>

    <!-- 时间轴弹窗 -->
    <div v-if="tl" class="modal-mask" @click.self="tl = null">
      <div class="modal xwide cm-modal">
        <div class="modal-head">
          <h3>
            交期时间轴 · {{ tl.order_no }}
            <span class="muted" style="font-weight: 400; font-size: 12px">
              {{ tl.route_type === 'outsource' ? '裁片外发路线' : '本厂路线' }} · 进度 {{ tl.progress }}%
            </span>
          </h3>
          <button class="x" @click="tl = null">×</button>
        </div>
        <div class="modal-body">
          <div class="ck-clock">
            <div><span>T0</span><b>{{ tl.t0_at || '-' }}</b><em>{{ t0SourceText(tl.t0_source) }}</em></div>
            <div><span>承诺日</span><b>{{ tl.promised_date || '-' }}</b><em>对客户</em></div>
            <div><span>计划日</span><b>{{ tl.planned_date || '-' }}</b><em>内部</em></div>
            <div><span>预测 / 实际</span><b :class="gapCls(tl)">{{ tl.actual_ship_date || tl.forecast_date || '-' }}</b><em>{{ tl.actual_ship_date ? '已实际出厂' : '最新预测' }}</em></div>
          </div>

          <div class="table-wrap" style="margin-top: 12px">
            <table class="data tl-tbl">
              <thead>
                <tr>
                  <th style="width: 44px">#</th>
                  <th style="width: 52px">节点</th>
                  <th style="min-width: 150px">名称</th>
                  <th style="width: 70px">标准时长</th>
                  <th style="width: 116px">计划起止</th>
                  <th style="width: 92px">实际完成</th>
                  <th style="width: 92px">督办日</th>
                  <th style="width: 78px">延期</th>
                  <th style="width: 92px">状态</th>
                  <th style="width: 130px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="n in tl.nodes" :key="n.id" :class="{ 'row-red': n.overdue }">
                  <td class="center">{{ n.seq }}</td>
                  <td><span class="tag gray">{{ n.code }}</span></td>
                  <td>{{ n.name }}</td>
                  <td class="center">{{ n.plan_days === null ? '待配置' : n.plan_days + ' 天' }}</td>
                  <td class="muted">{{ shortD(n.start_date) }} → {{ shortD(n.end_date) }}</td>
                  <td>{{ n.actual_end || '-' }}</td>
                  <td :class="n.overdue ? 'amt-red' : 'muted'">{{ n.supervise_date || '-' }}</td>
                  <td class="center" :class="n.delay_days ? 'amt-red' : ''">{{ n.delay_days ? '+' + n.delay_days + ' 天' : '-' }}</td>
                  <td><span class="tag" :class="nodeTag(n.status)">{{ n.status_text }}</span></td>
                  <td class="ops">
                    <button v-if="n.status === 'pending'" class="link-btn" @click="setNode(n, 'running')">开工</button>
                    <button v-if="n.status === 'running'" class="link-btn" @click="setNode(n, 'done')">完成</button>
                    <button v-if="n.status === 'done'" class="link-btn" @click="setNode(n, 'pending')">撤销</button>
                    <span v-if="n.note" class="muted" style="font-size: 11px">{{ n.note }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted" style="font-size: 11.5px; margin-top: 8px">
            督办日是跟踪点（T0 后第 5 / 7 / 9 / 11 / 12 / 14 天检查对应节点），不是必定完工日；红色行表示已过督办日但节点还没完成。
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="tl = null">关闭</button>
          <button class="btn btn-ghost" :disabled="saving" @click="reforecast(tl)">重算预测</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const stat = ref({});
const rows = ref([]);
const q = ref('');
const risk = ref('');
const review = ref('');
const cap = ref({ capacity_per_month: 5000, wip_qty: 0, load_pct: 0, advice: '' });

const cur = ref(null);
const tl = ref(null);
const saving = ref(false);
const form = ref(blankForm());

function blankForm() {
  return { front_ok: false, back_ok: false, material_ok: false, promised_date: '', note: '', route_type: 'inhouse' };
}

const allOk = computed(() => form.value.front_ok && form.value.back_ok && form.value.material_ok);

const planHint = computed(() => {
  if (!cur.value || !form.value.promised_date) return null;
  if (!allOk.value) {
    const miss = [];
    if (!form.value.front_ok) miss.push('前端裁床');
    if (!form.value.back_ok) miss.push('后端缝制');
    if (!form.value.material_ok) miss.push('物料');
    return { cls: 'bad', text: `承接有缺口（${miss.join('、')}），即使日期宽松也不能通过评审` };
  }
  const planned = cur.value.planned_date;
  const fc = cur.value.forecast_date;
  if (fc && form.value.promised_date < fc) {
    return { cls: 'bad', text: `承诺日早于最新预测（${fc}），按现在的排产做不到，需要压缩工期或外发` };
  }
  if (planned && form.value.promised_date < planned) {
    return { cls: 'warn', text: `承诺日早于内部计划日（${planned}），需额外协调产能` };
  }
  return { cls: 'ok', text: '承诺日晚于内部计划与预测，可承接' };
});

const shortD = (d) => (d ? String(d).slice(5) : '-');
const t0SourceText = (s) => ({ confirm: '按订单确认', payment: '按款项到账', both: '确认与到账同日' }[s] || '—');
const reviewText = (s) => ({ pending: '待评审', approved: '已通过', rejected: '未通过' }[s] || s);
const reviewTag = (s) => ({ pending: 'orange', approved: 'green', rejected: 'red' }[s] || 'gray');
const riskText = (s) => ({ none: '待定', yellow: '缓冲不足', red: '超期', done: '已交付' }[s] || s);
const riskTag = (s) => ({ none: 'gray', yellow: 'orange', red: 'red', done: 'green' }[s] || 'gray');
const nodeTag = (s) => ({ pending: 'gray', running: 'blue', done: 'green', skipped: 'gray' }[s] || 'gray');
const gapCls = (r) => {
  if (!r || !r.forecast_date || !r.promised_date) return '';
  const gap = r.promise_gap || 0;
  if (r.risk_level === 'done') return 'amt-green';
  if (gap > 0) return 'amt-red';
  if (gap > -3) return 'amt-orange';
  return 'amt-green';
};

async function loadBoard() {
  try {
    const d = await api.commitmentBoard({ q: q.value, risk: risk.value, review: review.value });
    stat.value = d.stat || {};
    rows.value = d.rows || [];
  } catch (e) { alert(e.message); }
}
async function loadCap(orderId) {
  try { cap.value = await api.commitmentCapacity(orderId); } catch (e) { /* ignore */ }
}
async function loadAll() { await Promise.all([loadBoard(), loadCap()]); }

async function openReview(r) {
  try {
    const d = await api.commitmentByOrder(r.order_id);
    cur.value = d;
    cap.value = d.capacity || cap.value;
    form.value = {
      front_ok: !!d.front_ok,
      back_ok: !!d.back_ok,
      material_ok: !!d.material_ok,
      promised_date: d.promised_date || '',
      note: d.review_note || '',
      route_type: d.route_type || 'inhouse'
    };
  } catch (e) { alert(e.message); }
}

async function saveReview() {
  if (!cur.value) return;
  if (!form.value.promised_date) return alert('请填写对客承诺交期');
  if (!form.value.note.trim()) return alert('请填写评审意见');
  saving.value = true;
  try {
    await api.reviewCommitment(cur.value.id, {
      front_ok: form.value.front_ok,
      back_ok: form.value.back_ok,
      material_ok: form.value.material_ok,
      promised_date: form.value.promised_date,
      note: form.value.note.trim()
    });
    cur.value = null;
    await loadAll();
    alert(allOk.value ? '评审已通过，该订单可以做技术确认了' : '已记录为「未通过」，订单不能进入技术确认');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function openTimeline(r) {
  try { tl.value = await api.commitmentByOrder(r.order_id); }
  catch (e) { alert(e.message); }
}

async function setNode(n, status) {
  saving.value = true;
  try {
    const r = await api.updateCommitmentNode(tl.value.id, n.id, { status });
    tl.value = r;
    await loadBoard();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function reforecast(c) {
  saving.value = true;
  try {
    const r = await api.reforecastCommitment(c.id);
    tl.value = r.commitment;
    await loadBoard();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

onMounted(loadAll);
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 19px; color: #16233b; }
.page-head .sub { margin: 0; font-size: 12.5px; color: #8a94a6; max-width: 760px; line-height: 1.6; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 14px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 21px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.row-red { background: #fff7f8; }
.row-yellow { background: #fffdf5; }
.num { text-align: right; }
.center { text-align: center; }
.ops { white-space: nowrap; }
.muted { color: #8a94a6; }
.sub-cell { font-size: 12px; color: #5b6474; }
.empty-cell { text-align: center; color: #8a94a6; padding: 18px; }
.prog { height: 6px; background: #f2f5fa; border-radius: 4px; overflow: hidden; margin-bottom: 2px; }
.prog i { display: block; height: 100%; background: #2b6de5; border-radius: 4px; }

.modal.xwide.cm-modal { width: 1180px; max-width: 97vw; }
.cm-modal .modal-body { max-height: 78vh; }
.ck-clock { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: #f8fafd; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; }
.ck-clock span { display: block; font-size: 11.5px; color: #8a94a6; }
.ck-clock b { font-size: 14px; color: #16233b; font-variant-numeric: tabular-nums; }
.ck-clock em { display: block; font-style: normal; font-size: 11px; color: #a9b4c5; margin-top: 1px; }

.cm-h4 { margin: 16px 0 8px; font-size: 13px; color: #16233b; }
.cm-checks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.cm-check {
  display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px;
  border: 1px solid #e6ebf3; border-radius: 10px; background: #fff; cursor: pointer;
}
.cm-check.on { border-color: #16a34a; background: #f6fdf9; }
.cm-check input { margin-top: 2px; }
.cm-check b { display: block; font-size: 12.5px; color: #16233b; }
.cm-check span { display: block; font-size: 11.5px; color: #8a94a6; line-height: 1.5; margin-top: 2px; }

.cm-cap { display: flex; align-items: center; gap: 18px; margin-top: 12px; padding: 9px 12px; background: #f8fafd; border: 1px solid #eef2f7; border-radius: 10px; flex-wrap: wrap; }
.cm-cap-item span { font-size: 11.5px; color: #8a94a6; margin-right: 4px; }
.cm-cap-item b { font-size: 13px; color: #16233b; }
.cm-cap-advice { margin-left: auto; font-size: 12px; color: #2b6de5; }
.cm-tip { font-size: 11.5px; margin-top: 3px; }
.cm-tip.ok { color: #16a34a; }
.cm-tip.warn { color: #d97706; }
.cm-tip.bad { color: #d92d45; }
.cm-warn { margin-right: auto; font-size: 12px; color: #d97706; }
.tl-tbl { min-width: 1100px; }
/* 日期、状态这类窄列一换行就变竖排，整表锁死不折行，超出横向滚 */
.table-wrap { overflow-x: auto; }
table.data th, table.data td { white-space: nowrap; }
.sub-cell div { white-space: nowrap; }
@media (max-width: 1100px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .ck-clock { grid-template-columns: repeat(2, 1fr); }
  .cm-checks { grid-template-columns: 1fr; }
}
</style>
