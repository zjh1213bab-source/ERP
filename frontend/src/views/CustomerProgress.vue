<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>客户进度发布</h2>
        <p class="sub">
          内部照常报工，<b>客户只看我们主动发布过的快照</b>。三条路线（本厂 / 裁片外发 / 整单外发）阶段不同；
          <b>裁片外发没全部回货、或后整与终检没做完，页面不会出现「完工 / 可发货」</b>。
          快照里不含工厂名、加工费、返工数、工人姓名。
        </p>
      </div>
      <div class="head-ops">
        <input v-model="kw" class="input" style="width: 150px" placeholder="单号 / 款式" @keyup.enter="loadOrders" />
        <button class="btn btn-ghost" @click="loadOrders">筛选</button>
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card">
        <div class="label">生产中订单</div>
        <div class="value">{{ meta.stats ? meta.stats.orders_in_production : '—' }}</div>
        <div class="foot">含已发货未关单</div>
      </div>
      <div class="stat-card accent">
        <div class="label">已对外发布</div>
        <div class="value">{{ meta.stats ? meta.stats.published : '—' }}</div>
        <div class="foot">客户当前能看到</div>
      </div>
      <div class="stat-card">
        <div class="label">发布版本</div>
        <div class="value">{{ meta.stats ? meta.stats.versions : '—' }}</div>
        <div class="foot">撤回 {{ meta.stats ? meta.stats.withdrawn : 0 }} 版（留痕不删）</div>
      </div>
      <div class="stat-card">
        <div class="label">本厂</div>
        <div class="value">{{ meta.stats ? meta.stats.inhouse : '—' }}</div>
        <div class="foot">6 个阶段</div>
      </div>
      <div class="stat-card">
        <div class="label">裁片外发</div>
        <div class="value">{{ meta.stats ? meta.stats.cut_outsource : '—' }}</div>
        <div class="foot">回厂后整 + 终检</div>
      </div>
      <div class="stat-card">
        <div class="label">整单外发</div>
        <div class="value">{{ meta.stats ? meta.stats.full_outsource : '—' }}</div>
        <div class="foot">只 3 个阶段</div>
      </div>
    </div>

    <div class="split">
      <!-- 左：订单列表 -->
      <div class="panel list">
        <div class="panel-head">
          <b>订单</b>
          <span class="mut tiny">{{ rows.length }} 单可发布</span>
        </div>
        <div class="rows">
          <div v-for="r in rows" :key="r.id" class="row" :class="{ on: detail && detail.order.id === r.id }" @click="open(r)">
            <div class="row-top">
              <b>{{ r.order_no }}</b>
              <span class="tag" :class="r.published ? 'green' : 'gray'">{{ r.published ? 'v' + r.live_version : '未发布' }}</span>
            </div>
            <div class="mut tiny">{{ r.style_name || '—' }} · {{ r.customer_name || '未挂客户' }}</div>
            <div class="row-mid">
              <span class="tag blue" v-if="r.route">{{ r.route_label }}</span>
              <span class="mini-bar"><i :style="{ width: (r.progress_pct || 0) + '%' }"></i></span>
              <span class="mut tiny">{{ r.done_count }}/{{ r.stage_count }}</span>
            </div>
            <div class="row-flags">
              <span v-if="r.can_complete" class="tag green">可完工</span>
              <span v-if="r.stale" class="tag orange">内部已推进·待重发</span>
            </div>
          </div>
          <div v-if="!rows.length" class="empty">没有符合条件的订单</div>
        </div>
      </div>

      <!-- 右：详情 -->
      <div class="panel detail" v-if="detail">
        <div class="panel-head">
          <div>
            <b>{{ detail.order.order_no }}</b>
            <span class="mut tiny"> · {{ detail.order.style_name || '—' }} · 交期 {{ detail.order.delivery_date || '待定' }}</span>
          </div>
          <div class="head-ops">
            <select v-model="routeForm.route" class="input" style="width: 120px" :disabled="!canRoute">
              <option v-for="r in meta.routes || []" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
            <button class="btn btn-sm btn-ghost" :disabled="!canRoute" @click="saveRoute">改路线</button>
            <button class="btn btn-sm btn-primary" :disabled="!canPublish" @click="doPublish">发布</button>
          </div>
        </div>

        <div class="cols">
          <!-- 内部真实进度 -->
          <div class="col">
            <div class="col-h">内部真实进度<span class="mut tiny">（不外发）</span></div>
            <div class="stage-list">
              <div v-for="s in detail.stages" :key="s.key" class="stage" :class="s.status">
                <span class="dot"></span>
                <div class="stage-body">
                  <div class="stage-lb">{{ s.label }}</div>
                  <div class="mut tiny">
                    {{ s.status === 'done' ? '已完成' : s.status === 'doing' ? '进行中' : '未开始' }}
                    <template v-if="s.key === 'outsource' && s.dispatch_count">
                      · 交出 {{ num(s.out_qty) }} / 已回 {{ num(s.returned_qty) }} / 验收 {{ num(s.accepted_qty) }}
                    </template>
                    <template v-if="s.done_at"> · {{ s.done_at }}</template>
                  </div>
                </div>
              </div>
            </div>
            <div class="blk" v-if="detail.blockers.length">
              <div class="blk-h">还不能说完工（{{ detail.blockers.length }} 项）</div>
              <ul><li v-for="(b, i) in detail.blockers" :key="i">{{ b }}</li></ul>
            </div>
            <div class="blk ok" v-else>
              <div class="blk-h">六阶段已完成</div>
              <div class="mut tiny">可以对外说「已完工，可安排发货」。</div>
            </div>
            <div class="hide-box">
              <div class="mut tiny">客户永远看不到：{{ (detail.internal_only.hidden || []).join('、') }}</div>
              <div class="mut tiny">内部返工 {{ num(detail.internal_only.qty_defect) }} 件 · 累计合格 {{ num(detail.internal_only.qty_ok) }} 件</div>
            </div>
          </div>

          <!-- 客户将看到的 -->
          <div class="col">
            <div class="col-h">客户将看到<span class="mut tiny">（发布后生效）</span></div>
            <div class="preview">
              <div class="pv-head">
                <span class="tag" :class="preview.route === 'cut_outsource' ? 'orange' : 'blue'">{{ preview.route_label }}</span>
                <span class="mut tiny">{{ preview.done_count }}/{{ preview.stage_count }} 阶段 · {{ preview.progress_pct }}%</span>
                <span v-if="preview.completion_label" class="tag green">{{ preview.completion_label }}</span>
                <span v-else class="tag gray">不显示完工</span>
              </div>
              <div class="pv-steps">
                <div v-for="s in preview.stages || []" :key="s.key" class="pv-step" :class="s.status">
                  <span class="dot"></span>
                  <div>
                    <div class="pv-lb">{{ s.label }}</div>
                    <div class="mut tiny">{{ s.status_label }}<template v-if="s.done_at"> · {{ s.done_at }}</template></div>
                  </div>
                </div>
              </div>
              <div class="mut tiny pv-note" v-if="preview.note">{{ preview.note }}</div>
              <div class="mut tiny pv-note" v-if="preview.plan_finish">预计完成：{{ preview.plan_finish }}</div>
            </div>
            <div class="warn-box" v-if="(preview.warnings || []).length">
              <div class="warn-h">发布前先看这两点</div>
              <ul><li v-for="(w, i) in preview.warnings" :key="i">{{ w }}</li></ul>
            </div>
            <div class="rule">{{ preview.rule_note }}</div>

            <div class="pub-opts">
              <label class="chk">
                <input type="checkbox" v-model="pubForm.show_qty" />
                对外显示累计合格数 <span class="mut tiny">（默认不给：产量属商业信息）</span>
              </label>
              <input v-model="pubForm.note" class="input" placeholder="内部备注（不发客户）" />
            </div>
          </div>
        </div>

        <div class="hist">
          <div class="col-h">版本历史<span class="mut tiny">（撤回不删行，版本号只增不减）</span></div>
    <table class="data">
      <thead><tr><th style="width: 70px">版本</th><th style="width: 90px">状态</th><th style="width: 110px">发布</th><th>说明</th><th style="width: 76px">操作</th></tr></thead>
      <tbody>
        <tr v-for="h in history" :key="h.id">
          <td>v{{ h.version_no }}</td>
          <td><span class="tag" :class="h.status === 'published' ? 'green' : 'gray'">{{ h.status === 'published' ? '生效中' : '已撤回' }}</span></td>
          <td class="tiny mut">{{ (h.published_at || '').slice(0, 10) }}<br />{{ h.published_by || '' }}</td>
          <td class="tiny">
            {{ h.done_count }}/{{ h.stage_count }} 阶段{{ h.can_complete ? ' · 可完工' : '' }}
            <div class="mut" v-if="h.withdraw_reason">撤回：{{ h.withdraw_reason }}</div>
          </td>
          <td>
            <button v-if="h.status === 'published'" class="btn btn-sm btn-ghost" :disabled="!canPublish" @click="doWithdraw(h)">撤回</button>
            <span v-else class="mut tiny">—</span>
          </td>
        </tr>
        <tr v-if="!history.length"><td colspan="5" class="empty">还没对外发布过</td></tr>
      </tbody>
    </table>
        </div>
      </div>
      <div class="panel detail" v-else>
        <p class="empty">左侧选一张订单，看内部进度和「客户会看到什么」</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';

const role = computed(() => auth.user?.role || '');
const canPublish = computed(() => ['admin', 'sales'].includes(role.value));
const canRoute = computed(() => ['admin', 'sales', 'production'].includes(role.value));

const meta = ref({});
const rows = ref([]);
const kw = ref('');
const detail = ref(null);
const preview = ref({});
const history = ref([]);
const pubForm = reactive({ show_qty: false, note: '' });
const routeForm = reactive({ route: 'inhouse' });

const num = (v) => Number(v || 0).toLocaleString('zh-CN');

async function reload() {
  const m = await api.cpMeta();
  meta.value = m;
  await loadOrders();
}
async function loadOrders() {
  rows.value = await api.cpOrders({ q: kw.value || undefined });
}
async function open(r) {
  const [it, pv, h] = await Promise.all([api.cpInternal(r.id), api.cpPreview(r.id, { show_qty: pubForm.show_qty ? 1 : 0 }), api.cpHistory(r.id)]);
  detail.value = it;
  preview.value = pv;
  history.value = h || [];
  routeForm.route = it.route;
  pubForm.note = '';
}
async function refreshPreview() {
  const id = detail.value.order.id;
  preview.value = await api.cpPreview(id, { show_qty: pubForm.show_qty ? 1 : 0 });
}
async function doPublish() {
  const id = detail.value.order.id;
  if (!confirm(`把「${detail.value.order.order_no}」的进度发布给客户？\n\n发布后客户立刻能看到；如需修改可撤回后重发（版本号会 +1）。`)) return;
  try {
    const out = await api.cpPublish(id, { show_qty: pubForm.show_qty, note: pubForm.note });
    await Promise.all([loadOrders(), reload()]);
    await open(rows.value.find((x) => x.id === id) || { id });
    const warn = (out.warnings || []).length ? '\n\n注意：\n· ' + out.warnings.join('\n· ') : '';
    alert(`已发布 v${out.version_no}：${out.note}${warn}`);
  } catch (e) { alert(e.message); }
}
async function doWithdraw(h) {
  const reason = prompt('撤回原因（至少 4 个字）——客户那边已经看到了，撤回本身就是一次沟通');
  if (!reason) return;
  try {
    const out = await api.cpWithdraw(h.id, { reason });
    await loadOrders();
    await open({ id: detail.value.order.id });
    alert(out.note);
  } catch (e) { alert(e.message); }
}
async function saveRoute() {
  try {
    const out = await api.cpSetRoute(detail.value.order.id, { route: routeForm.route });
    if (out.warning) alert(out.warning);
    await loadOrders();
    await open({ id: detail.value.order.id });
  } catch (e) { alert(e.message); }
}

onMounted(reload);
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel .tag { white-space: nowrap; }
.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 102px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 11px; line-height: 1.4; }

.split { display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }

.list .rows { min-width: 0; max-height: 620px; overflow-y: auto; margin: -4px; padding: 4px; }
/* 注意：全局 .row 是表单行（display:flex），这里必须覆盖回 block，否则单号会被挤成一个字母 */
.list .row { display: block; border: 1px solid #eef1f6; border-radius: 10px; padding: 9px 11px; margin-bottom: 8px; cursor: pointer; }
.row:hover { border-color: #cfe0ff; background: #fbfdff; }
.row.on { border-color: #2563eb; background: #f4f8ff; }
.row > div { min-width: 0; }
.row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.row-top b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.row-top .tag { flex: 0 0 auto; }
.row-mid .tag { flex: 0 0 auto; }
.row-mid { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.row-flags { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
.mini-bar { flex: 1; height: 5px; border-radius: 3px; background: #e8edf6; overflow: hidden; min-width: 40px; }
.mini-bar i { display: block; height: 100%; background: #2563eb; }

.detail .cols { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 16px; }
@media (max-width: 900px) { .detail .cols { grid-template-columns: 1fr; } }
.col-h { font-weight: 600; font-size: 12.5px; color: #16233b; margin-bottom: 8px; }

/* 内部阶段：完成实心、进行中描边、未开始灰 */
.stage { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px dashed #eef1f6; }
.stage .dot { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; margin-top: 5px; flex: 0 0 auto; }
.stage.done .dot { background: #10b981; }
.stage.doing .dot { background: #fff; border: 2px solid #2563eb; box-shadow: 0 0 0 2px #dbeafe; }
.stage-lb { font-size: 12.5px; }
.stage.pending .stage-lb { color: #94a3b8; }

.blk { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 9px 11px; margin-top: 10px; }
.blk.ok { border-color: #a7f3d0; background: #ecfdf5; }
.blk-h { font-size: 12.5px; font-weight: 600; color: #92400e; margin-bottom: 4px; }
.blk.ok .blk-h { color: #047857; }
.blk ul { margin: 0 0 0 16px; font-size: 11.5px; color: #92400e; line-height: 1.7; }
.hide-box { margin-top: 10px; }
.hist { margin-top: 16px; border-top: 1px solid #eef1f6; padding-top: 12px; }
.hist table.data td { vertical-align: top; }
.hist table.data td:last-child { white-space: nowrap; }

.preview { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; background: #fcfeff; }
.pv-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.pv-steps { display: flex; gap: 8px; flex-wrap: wrap; }
.pv-step { display: flex; gap: 5px; align-items: flex-start; min-width: 84px; flex: 1 1 84px; }
.pv-step .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; margin-top: 5px; flex: 0 0 auto; }
.pv-step.done .dot { background: #10b981; }
.pv-step.doing .dot { background: #fff; border: 2px solid #2563eb; }
.pv-lb { font-size: 12px; }
.pv-step.pending .pv-lb { color: #94a3b8; }
.pv-note { margin-top: 7px; line-height: 1.6; }

.warn-box { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 8px 11px; margin-top: 9px; }
.warn-h { font-size: 12px; font-weight: 600; color: #92400e; margin-bottom: 3px; }
.warn-box ul { margin: 0 0 0 16px; font-size: 11.5px; color: #92400e; line-height: 1.65; }
.rule { margin-top: 9px; font-size: 11.5px; color: #475569; background: #f8fafc; border-radius: 8px; padding: 8px 10px; line-height: 1.65; }
.pub-opts { margin-top: 10px; display: flex; flex-direction: column; gap: 7px; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.pub-opts .input { width: 100%; }

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .head-ops { flex-wrap: wrap; }
  .detail .cols { grid-template-columns: 1fr; }
}
</style>
