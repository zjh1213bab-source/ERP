<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>裁片外发与外协验货交接</h2>
        <p class="sub">
          裁片外发不是「整单交给哪家做」，而是<b>具体哪几扎走了、回来几件、合格几件、短了为什么</b>。
          扎是唯一能追到缸号和裁片批次的单位，所以必须按扎发、按扎回。
          <b>没复核的扎不能发</b>（回来分不清是裁错还是车错）；<b>一扎不能同时在两张未完结单里</b>；
          回货验收<b>合格 + 不良 + 返工 必须等于回货数</b>；短数要写原因才许结案；交接三方都要留名。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.today || '—' }}</span>
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openNew">新建外发单</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>在途批次</span>
        <strong>{{ (board.stat && board.stat.open) || 0 }}</strong>
        <small>已发出还没回齐</small>
      </div>
      <div class="stat">
        <span>发出件数</span>
        <strong>{{ num(board.stat && board.stat.out_qty) }}</strong>
        <small>已回 {{ num(board.stat && board.stat.returned_qty) }}</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.accept_rate !== null && board.stat.accept_rate < 95 ? 'st-warn' : ''">
        <span>验收合格率</span>
        <strong>{{ board.stat && board.stat.accept_rate !== null ? num(board.stat.accept_rate) : '—' }}<i>%</i></strong>
        <small>合格 ÷ 已回</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.rejected_qty ? 'st-bad' : ''">
        <span>不良 / 返工</span>
        <strong>{{ num(board.stat && board.stat.rejected_qty) }}</strong>
        <small>不良件数（返工另计）</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.loss_qty ? 'st-warn' : ''">
        <span>差异件数</span>
        <strong>{{ num(board.stat && board.stat.loss_qty) }}</strong>
        <small>外协声明不再补的短数</small>
      </div>
      <div class="stat" :class="board.overdue && board.overdue.length ? 'st-bad' : ''">
        <span>逾期未回</span>
        <strong>{{ (board.overdue && board.overdue.length) || 0 }}</strong>
        <small>过了约定回货日</small>
      </div>
    </div>

    <div class="tabbar">
      <div class="tabs">
        <button :class="{ on: tab === 'list' }" @click="tab = 'list'">外发单</button>
        <button :class="{ on: tab === 'board' }" @click="tab = 'board'">外协看板</button>
      </div>
    </div>

    <!-- ==================== 外发单列表 ==================== -->
    <div v-if="tab === 'list'">
      <div class="help-bar">
        <b>一条链</b>：草稿（可改扎）→ <b>发出</b>（裁片走了）→ <b>回货验收</b>（合格/不良/返工分流 + 短数）→ <b>结案</b>（有差异必须写原因）。
        结案后扎才释放，才能再外发或回仓。
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>外发单</th><th>裁剪单</th><th>订单</th><th>外协厂</th>
              <th class="num">扎数</th><th class="num">发出</th><th class="num">已回</th>
              <th class="num">合格</th><th class="num">不良</th><th class="num">差异</th>
              <th class="num">加工费</th><th>约定回货</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" :class="{ 'row-bad': r.overdue }">
              <td class="mono tiny">{{ r.dispatch_no }}</td>
              <td class="tiny">{{ r.cut_no || '—' }}</td>
              <td class="tiny">{{ r.order_no || '—' }}</td>
              <td class="tiny">{{ r.factory_name }}</td>
              <td class="num">{{ r.bundle_count }}</td>
              <td class="num">{{ num(r.out_qty) }}</td>
              <td class="num" :class="{ orange: r.open_qty > 0 }">{{ num(r.returned_qty) }}</td>
              <td class="num tiny ok-line">{{ r.accepted_qty ? num(r.accepted_qty) : '' }}</td>
              <td class="num tiny red">{{ r.rejected_qty ? num(r.rejected_qty) : '' }}</td>
              <td class="num tiny" :class="{ orange: r.loss_qty > 0 }">{{ r.loss_qty ? num(r.loss_qty) : '' }}</td>
              <td class="num tiny">{{ money(r.amount) }}</td>
              <td class="tiny" :class="{ red: r.overdue }">
                {{ r.expect_return_date || '—' }}<span v-if="r.overdue" class="tag red">逾期</span>
              </td>
              <td><span class="tag" :class="statusTag(r.status)">{{ r.status_label }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="openDetail(r.id)">明细</button></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="14" class="empty">还没有外发单。点右上「新建外发单」，选裁剪单后按扎勾选。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 看板 ==================== -->
    <div v-if="tab === 'board'">
      <h4 class="sec">逾期未回 <span class="tiny muted">（过了约定回货日还在外协手上，跟单要催）</span></h4>
      <div v-if="board.overdue && board.overdue.length" class="table-wrap">
        <table class="data">
          <thead><tr><th>外发单</th><th>外协厂</th><th>订单</th><th>约定回货</th><th class="num">逾期天数</th><th class="num">未回件数</th></tr></thead>
          <tbody>
            <tr v-for="o in board.overdue" :key="o.id">
              <td class="mono tiny">{{ o.dispatch_no }}</td>
              <td class="tiny">{{ o.factory_name }}</td>
              <td class="tiny">{{ o.order_no || '—' }}</td>
              <td class="tiny">{{ o.expect_return_date }}</td>
              <td class="num red"><b>{{ o.days }}</b> 天</td>
              <td class="num">{{ num(o.open_qty) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="help-bar">没有逾期未回的外发单。</div>

      <h4 class="sec">外协合格率 <span class="tiny muted">（按验收合格率排；回货不足 50 件不排名——样品量太小，一个疵点就把合格率拉到 90%）</span></h4>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>外协厂</th><th class="num">批次</th><th class="num">已回</th><th class="num">合格</th><th class="num">不良</th><th class="num">合格率</th><th>能否排名</th></tr></thead>
          <tbody>
            <tr v-for="(f, i) in board.factories || []" :key="i">
              <td>{{ f.factory_name }}</td>
              <td class="num">{{ f.batches }}</td>
              <td class="num">{{ num(f.returned) }}</td>
              <td class="num ok-line">{{ num(f.accepted) }}</td>
              <td class="num red">{{ f.rejected ? num(f.rejected) : '' }}</td>
              <td class="num"><b>{{ f.rate === null ? '—' : num(f.rate) + '%' }}</b></td>
              <td class="tiny">
                <span v-if="f.rankable" class="tag green">可排名</span>
                <span v-else class="tag gray">样本不足</span>
              </td>
            </tr>
            <tr v-if="!(board.factories && board.factories.length)">
              <td colspan="7" class="empty">还没有回货数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ==================== 新建外发单 ==================== -->
    <div v-if="newDoc.open" class="modal-mask">
      <div class="modal xxwide">
        <h3>新建裁片外发单</h3>
        <div class="fgrid">
          <label>裁剪单
            <select v-model="newDoc.cut_order_id" @change="loadBundles">
              <option value="">请选择（只列已录合格裁片数的）</option>
              <option v-for="c in dict.cuts || []" :key="c.id" :value="c.id">{{ c.cut_no }} · {{ c.order_no }} · 合格 {{ num(c.qualified_qty) }}</option>
            </select>
          </label>
          <label>外协厂
            <select v-model="newDoc.factory_id">
              <option value="">请选择</option>
              <option v-for="f in dict.factories || []" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
          </label>
          <label>发出日期 <input v-model="newDoc.out_date" type="date" /></label>
          <label>约定回货日 <input v-model="newDoc.expect_return_date" type="date" /></label>
          <label>加工单价（元/件） <input v-model.number="newDoc.price" type="number" step="0.1" /></label>
        </div>
        <label class="fl">说明 <input v-model="newDoc.note" placeholder="选填" /></label>

        <div v-if="suggest" class="sug-bar">
          <span>合格裁片 <b>{{ num(suggest.cut.qualified_qty) }}</b></span>
          <span title="只算还没结案的外发单">未结案已发 <b>{{ num(suggest.sent_before) }}</b></span>
          <span title="合格裁片 − 未结案已发">剩余额度 <b>{{ num(suggest.remain_qualified) }}</b></span>
          <span title="按扎实际能勾的件数（已扣除未复核与在外发单里的扎）">本次可勾（按扎） <b>{{ num(suggest.can_send_qty) }}</b></span>
          <span>本次勾选 <b class="mono">{{ num(pickedQty) }}</b></span>
          <span v-if="suggest.uncheckable" class="red">未复核 {{ suggest.uncheckable }} 扎（不能选）</span>
          <span v-if="suggest.busy" class="orange">已在其他单 {{ suggest.busy }} 扎</span>
        </div>
        <div v-if="suggest && suggest.blockers && suggest.blockers.length" class="warn-box">{{ suggest.blockers.join('；') }}</div>

        <div v-if="suggest && suggest.bundles && suggest.bundles.length" class="table-wrap" style="max-height: 300px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr><th></th><th>扎号</th><th>床号/缸号</th><th>颜色</th><th>尺码</th><th class="num">件数</th><th>能否发</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in suggest.bundles" :key="b.id" :class="{ 'row-muted': !b.can_send }">
                <td><input v-model="b.checked_pick" type="checkbox" :disabled="!b.can_send" /></td>
                <td class="mono tiny">{{ b.bundle_no }}</td>
                <td class="tiny muted">{{ b.lot_no || '—' }}<span v-if="b.dye_lot"> / {{ b.dye_lot }}</span></td>
                <td class="tiny">{{ b.color || '—' }}</td>
                <td class="tiny">{{ b.size || '—' }}</td>
                <td class="num">{{ num(b.qty) }}</td>
                <td class="tiny">
                  <span v-if="!b.checked" class="tag red">未复核</span>
                  <span v-else-if="b.busy_dispatch" class="tag orange">在 {{ b.busy_dispatch }}</span>
                  <span v-else class="tag green">可发</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="tiny muted" style="margin: 10px 0">选裁剪单后列出可发的扎。</div>

        <div class="modal-ops">
          <button class="btn btn-ghost" @click="newDoc.open = false">取消</button>
          <button class="btn btn-primary" @click="submitNew">创建草稿</button>
        </div>
      </div>
    </div>

    <!-- ==================== 外发单详情 ==================== -->
    <div v-if="detail.open" class="modal-mask">
      <div class="modal xxwide">
        <h3>
          {{ detail.data.dispatch_no }}
          <span class="tag" :class="statusTag(detail.data.status)">{{ detail.data.status_label }}</span>
          <span class="tag gray">{{ detail.data.factory_name }}</span>
        </h3>
        <div class="kv">
          <div><span>裁剪单</span><b class="tiny mono">{{ detail.data.cut_no }}</b></div>
          <div><span>订单</span><b class="tiny">{{ detail.data.order_no || '—' }}</b></div>
          <div><span>发出 / 已回</span><b class="mono">{{ num(detail.data.out_qty) }} / {{ num(detail.data.returned_qty) }}</b><small>未回 {{ num(detail.data.open_qty) }}</small></div>
          <div><span>合格 / 不良 / 返工</span><b class="mono">{{ num(detail.data.accepted_qty) }} / {{ num(detail.data.rejected_qty) }} / {{ num(detail.data.rework_qty) }}</b>
            <small :class="detail.data.accepted_check ? 'ok-line' : 'red'">{{ detail.data.accepted_check ? '三分闭合' : '三分不闭合' }}</small>
          </div>
          <div><span>差异</span><b class="mono" :class="{ red: detail.data.loss_qty > 0 }">{{ num(detail.data.loss_qty) }}</b><small>声明不再补</small></div>
          <div><span>加工费</span><b class="mono">{{ money(detail.data.amount) }}</b><small>合格 {{ num(detail.data.accepted_qty) }} × ¥{{ num(detail.data.price) }}</small></div>
          <div><span>约定回货</span><b>{{ detail.data.expect_return_date || '—' }}</b></div>
        </div>
        <div v-if="detail.data.loss_reason" class="tiny muted" style="margin-bottom: 8px">差异原因：{{ detail.data.loss_reason }}</div>

        <h4 class="sec">发出明细（按扎）</h4>
        <div class="table-wrap" style="max-height: 240px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr><th>扎号</th><th>床号/缸号</th><th>颜色</th><th>尺码</th>
                <th class="num">发出</th><th class="num">已回</th><th class="num">合格</th><th class="num">不良</th><th class="num">返工</th><th class="num">短数</th><th class="num">未回</th></tr>
            </thead>
            <tbody>
              <tr v-for="it in detail.data.items" :key="it.id" :class="{ 'row-warn': it.open_qty > 0 }">
                <td class="mono tiny">{{ it.bundle_no }}</td>
                <td class="tiny muted">{{ it.lot_no || '—' }}<span v-if="it.dye_lot"> / {{ it.dye_lot }}</span></td>
                <td class="tiny">{{ it.color || '—' }}</td>
                <td class="tiny">{{ it.size || '—' }}</td>
                <td class="num">{{ num(it.qty) }}</td>
                <td class="num">{{ num(it.returned_qty) }}</td>
                <td class="num tiny ok-line">{{ it.accepted_qty ? num(it.accepted_qty) : '' }}</td>
                <td class="num tiny red">{{ it.rejected_qty ? num(it.rejected_qty) : '' }}</td>
                <td class="num tiny orange">{{ it.rework_qty ? num(it.rework_qty) : '' }}</td>
                <td class="num tiny" :class="{ red: it.short_qty > 0 }">{{ it.short_qty ? num(it.short_qty) : '' }}</td>
                <td class="num" :class="{ orange: it.open_qty > 0 }">{{ it.open_qty ? num(it.open_qty) : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h4 class="sec">回货验收记录 <span class="tiny muted">（外协可能分几次送回来，一批一条，三方签名）</span></h4>
        <div v-if="detail.data.receipts && detail.data.receipts.length" class="table-wrap" style="max-height: 220px; overflow-y: auto">
          <table class="data">
            <thead>
              <tr><th>回货单</th><th>日期</th><th class="num">回货</th><th class="num">合格</th><th class="num">不良</th>
                <th class="num">返工</th><th class="num">短数</th><th>交货人</th><th>接收人</th><th>验货人</th><th>结论</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in detail.data.receipts" :key="r.id">
                <td class="mono tiny">{{ r.receipt_no }}</td>
                <td class="tiny">{{ r.receive_date }}</td>
                <td class="num">{{ num(r.qty) }}</td>
                <td class="num ok-line">{{ num(r.accepted_qty) }}</td>
                <td class="num red">{{ r.rejected_qty ? num(r.rejected_qty) : '' }}</td>
                <td class="num orange">{{ r.rework_qty ? num(r.rework_qty) : '' }}</td>
                <td class="num">{{ r.short_qty ? num(r.short_qty) : '' }}</td>
                <td class="tiny">{{ r.handover_by }}</td>
                <td class="tiny">{{ r.received_by }}</td>
                <td class="tiny">{{ r.inspected_by }}</td>
                <td class="tiny"><span class="tag" :class="r.inspect_result === 'pass' ? 'green' : (r.inspect_result === 'reject' ? 'red' : 'orange')">{{ r.inspect_label }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="tiny muted" style="margin: 6px 0">还没有回货</div>
        <div v-for="r in detail.data.receipts || []" :key="'x' + r.id">
          <div v-if="r.short_reason" class="tiny" style="margin-top: 4px">短数原因（{{ r.receipt_no }}）：{{ r.short_reason }}</div>
        </div>

        <div class="modal-ops">
          <button v-if="canWrite && detail.data.can.cancel" class="btn btn-ghost" @click="cancelDoc">取消外发</button>
          <span class="grow"></span>
          <button class="btn btn-ghost" @click="detail.open = false">关闭</button>
          <button v-if="canWrite && detail.data.can.close" class="btn btn-ghost" @click="closeDoc">结案</button>
          <button v-if="canWrite && detail.data.can.send" class="btn btn-primary" @click="sendDoc">发出</button>
          <button v-if="canWrite && detail.data.can.receive" class="btn btn-primary" @click="openReceive">登记回货验收</button>
        </div>
      </div>
    </div>

    <!-- ==================== 回货验收 ==================== -->
    <div v-if="recv.open" class="modal-mask">
      <div class="modal xxwide">
        <h3>登记回货验收</h3>
        <div class="help-inline">
          每扎填本次回货数，并拆成<b>合格 + 不良 + 返工</b>（三块必须加起来等于回货数）。
          有不良/返工必须写原因；有短数（发了不补的）单独填并写原因。
          <b>交接三方都要留名</b>：外协交货人、本厂接收人、验货人。
        </div>
        <div class="fgrid">
          <label>回货日期 <input v-model="recv.receive_date" type="date" /></label>
          <label>验收结论
            <select v-model="recv.inspect_result">
              <option v-for="(v, k) in dict.inspect || {}" :key="k" :value="k">{{ v }}</option>
            </select>
          </label>
          <label>外协交货人 <input v-model="recv.handover_by" placeholder="如：外协厂 A · 老陈" /></label>
          <label>本厂接收人 <input v-model="recv.received_by" placeholder="仓管" /></label>
          <label>验货人 <input v-model="recv.inspected_by" placeholder="QC" /></label>
          <label>本次短数 <input v-model.number="recv.short_qty" type="number" placeholder="0" /></label>
        </div>
        <label class="fl">短数原因（有短数必填） <input v-model="recv.short_reason" placeholder="遗失 / 污损 / 外协自留" /></label>

        <div class="table-wrap" style="max-height: 280px; overflow-y: auto; margin-top: 10px">
          <table class="data">
            <thead>
              <tr><th>扎号</th><th class="num">未回</th><th class="num">本次回货</th><th class="num">合格</th>
                <th class="num">不良</th><th class="num">返工</th><th style="min-width: 180px">不良原因</th></tr>
            </thead>
            <tbody>
              <tr v-for="it in recv.items" :key="it.dispatch_item_id">
                <td class="mono tiny">{{ it.bundle_no }}</td>
                <td class="num tiny">{{ num(it.open) }}</td>
                <td class="num"><input v-model.number="it.qty" type="number" class="mini-inp" min="0" /></td>
                <td class="num"><input v-model.number="it.accepted_qty" type="number" class="mini-inp" min="0" /></td>
                <td class="num"><input v-model.number="it.rejected_qty" type="number" class="mini-inp" min="0" /></td>
                <td class="num"><input v-model.number="it.rework_qty" type="number" class="mini-inp" min="0" /></td>
                <td><input v-model="it.defect_reason" class="reason-inp" placeholder="有不良/返工必填" /></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-ops">
          <button class="btn btn-ghost" @click="recv.open = false">取消</button>
          <button class="btn btn-primary" @click="submitReceive">确认验收</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const tab = ref('list');
const dict = ref({});
const board = ref({ stat: {}, overdue: [], factories: [] });
const rows = ref([]);

const newDoc = reactive({ open: false, cut_order_id: '', factory_id: '', out_date: '', expect_return_date: '', price: 8, note: '' });
const suggest = ref(null);
const detail = reactive({ open: false, data: { items: [], receipts: [], can: {} } });
const recv = reactive({ open: false, receive_date: '', inspect_result: 'pass', handover_by: '', received_by: '', inspected_by: '', short_qty: 0, short_reason: '', items: [] });

const canWrite = computed(() => can('cutdispatch.write'));
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const money = (v) => (v === null || v === undefined ? '—' : '¥' + (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN'));
const statusTag = (s) => ({ draft: 'gray', sent: 'blue', partial: 'orange', returned: 'green', closed: 'green', cancelled: 'gray' }[s] || 'gray');

const pickedQty = computed(() => {
  if (!suggest.value) return 0;
  return (suggest.value.bundles || []).filter((b) => b.checked_pick).reduce((s, b) => s + num(b.qty), 0);
});

async function loadAll() {
  dict.value = (await api.cutDispatchDict()) || {};
  board.value = (await api.cutDispatchBoard({})) || { stat: {}, overdue: [], factories: [] };
  const r = await api.cutDispatchList({});
  rows.value = (r && r.rows) || [];
}

async function reloadAll() {
  try {
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

function openNew() {
  newDoc.open = true;
  newDoc.cut_order_id = '';
  newDoc.factory_id = '';
  newDoc.out_date = dict.value.today || '';
  newDoc.expect_return_date = '';
  newDoc.price = 8;
  newDoc.note = '';
  suggest.value = null;
}

async function loadBundles() {
  suggest.value = null;
  if (!newDoc.cut_order_id) return;
  try {
    const s = await api.cutDispatchSuggest(newDoc.cut_order_id);
    s.bundles = (s.bundles || []).map((b) => ({ ...b, checked_pick: false }));
    suggest.value = s;
  } catch (e) {
    alert(e.message);
  }
}

async function submitNew() {
  if (!newDoc.factory_id) return alert('请选外协厂');
  const ids = (suggest.value ? suggest.value.bundles : []).filter((b) => b.checked_pick).map((b) => b.id);
  if (!ids.length) return alert('至少要勾一扎');
  try {
    const d = await api.createCutDispatch({
      cut_order_id: Number(newDoc.cut_order_id),
      factory_id: Number(newDoc.factory_id),
      out_date: newDoc.out_date,
      expect_return_date: newDoc.expect_return_date || null,
      price: newDoc.price,
      note: newDoc.note,
      bundle_ids: ids
    });
    newDoc.open = false;
    await loadAll();
    await openDetail(d.id);
  } catch (e) {
    alert(e.message);
  }
}

async function openDetail(id) {
  try {
    detail.data = await api.cutDispatchDetail(id);
    detail.open = true;
  } catch (e) {
    alert(e.message);
  }
}

async function sendDoc() {
  if (!confirm(`确认发出 ${num(detail.data.out_qty)} 件裁片给 ${detail.data.factory_name}？`)) return;
  try {
    detail.data = await api.sendCutDispatch(detail.data.id);
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

function openReceive() {
  recv.open = true;
  recv.receive_date = dict.value.today || '';
  recv.inspect_result = 'pass';
  recv.handover_by = '';
  recv.received_by = '';
  recv.inspected_by = '';
  recv.short_qty = 0;
  recv.short_reason = '';
  recv.items = (detail.data.items || []).filter((it) => it.open_qty > 0).map((it) => ({
    dispatch_item_id: it.id, bundle_no: it.bundle_no, open: it.open_qty,
    qty: it.open_qty, accepted_qty: it.open_qty, rejected_qty: 0, rework_qty: 0, defect_reason: ''
  }));
}

async function submitReceive() {
  const items = recv.items.filter((x) => num(x.qty) > 0).map((x) => ({
    dispatch_item_id: x.dispatch_item_id, qty: num(x.qty),
    accepted_qty: num(x.accepted_qty), rejected_qty: num(x.rejected_qty), rework_qty: num(x.rework_qty),
    defect_reason: x.defect_reason
  }));
  if (!items.length) return alert('至少填一扎的回货数量');
  try {
    detail.data = await api.receiveCutDispatch(detail.data.id, {
      receive_date: recv.receive_date, inspect_result: recv.inspect_result,
      handover_by: recv.handover_by, received_by: recv.received_by, inspected_by: recv.inspected_by,
      short_qty: recv.short_qty || 0, short_reason: recv.short_reason, items
    });
    recv.open = false;
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function closeDoc() {
  const loss = num(detail.data.loss_qty);
  const note = prompt(`结案${loss ? `（未回 ${loss} 件）` : ''}。有差异必须写原因（遗失 / 污损 / 放弃追讨）：`, '');
  if (note === null) return;
  try {
    detail.data = await api.closeCutDispatch(detail.data.id, { loss_reason: note });
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function cancelDoc() {
  const reason = prompt('取消外发单会释放这些扎。请写原因：', '');
  if (reason === null) return;
  try {
    detail.data = await api.cancelCutDispatch(detail.data.id, { reason });
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(reloadAll);
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat strong i { font-size: 13px; font-style: normal; color: var(--ink-mute); margin-left: 2px; }
.stat small { display: block; font-size: 12px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.help-bar { background: #f6f9fe; border: 1px solid #e2ebf8; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #4a5568; line-height: 1.75; margin-bottom: 12px; }
.help-inline { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; line-height: 1.65; margin-bottom: 10px; }
.warn-box { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; margin: 8px 0; }

.sec { font-size: 13px; color: #16305f; margin: 18px 0 8px; }
.kv { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
.kv > div { background: #f8fafd; border-radius: 8px; padding: 7px 9px; }
.kv span { display: block; font-size: 12px; color: var(--ink-mute); }
.kv b { font-size: 13px; color: #16305f; }
.kv small { display: block; font-size: 12px; color: #9aa4b5; }
.fl { display: block; font-size: 12px; color: #5b6474; margin: 8px 0 0; }
.fl input { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }

.sug-bar { display: flex; gap: 16px; flex-wrap: wrap; background: #f8fafd; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; color: #5b6474; margin: 10px 0; }
.sug-bar b { color: #16305f; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
table.data .mini-inp { width: 80px; min-width: 80px; box-sizing: border-box; }
.mini-inp { width: 80px; min-width: 80px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; text-align: right; }
.reason-inp { width: 100%; min-width: 170px; box-sizing: border-box; padding: 4px 7px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-bad { background: #fff6f7; }
.row-warn { background: #fffdf6; }
.row-muted { opacity: 0.6; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }

.modal { padding: 18px 20px; }
.modal > h3 { margin: 0 0 12px; font-size: 16px; color: var(--ink); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.modal-ops { display: flex; align-items: center; gap: 8px; padding-top: 13px; margin-top: 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .page-head .pill { display: none; }
}
</style>
