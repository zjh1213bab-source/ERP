<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>裁床与扎包</h2>
        <p class="sub">
          P5 实际裁剪：按床次记录布卷、缸号、层数与排料图；裁完按扎包交付。错缸、数量不符、扎包对不上，都不放行。
        </p>
      </div>
      <div class="head-ops"><button class="btn btn-ghost" @click="loadBoard">刷新</button></div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>待开裁</span>
        <strong :class="stat.draft ? 'amt-orange' : ''">{{ stat.draft || 0 }}</strong>
        <small>计划 {{ stat.plan_qty || 0 }} 件</small>
      </div>
      <div class="stat">
        <span>裁剪中</span>
        <strong class="amt-blue">{{ stat.cutting || 0 }}</strong>
        <small>已开裁未完成</small>
      </div>
      <div class="stat">
        <span>裁剪完成</span>
        <strong class="amt-green">{{ stat.cut_done || 0 }}</strong>
        <small>实裁 {{ stat.cut_qty || 0 }} 件</small>
      </div>
      <div class="stat">
        <span>已交接</span>
        <strong>{{ stat.handed || 0 }}</strong>
        <small :class="stat.mixed ? 'amt-red' : ''">混缸 {{ stat.mixed || 0 }} 单</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="裁剪单号 / 订单号 / 款号" style="width: 240px" @keyup.enter="loadBoard" />
      <select class="select" v-model="status" style="width: 140px" @change="loadBoard">
        <option value="">全部状态</option>
        <option value="draft">待开裁</option>
        <option value="cutting">裁剪中</option>
        <option value="cut_done">裁剪完成</option>
        <option value="handed">已交接</option>
      </select>
      <button class="btn btn-ghost" @click="loadBoard">查询</button>
      <div style="flex: 1"></div>
      <span class="muted" style="font-size: 12px">面料未齐套的订单不能开裁，先去「齐套与缺料」处理</span>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th style="width: 144px">裁剪单号</th>
            <th style="width: 144px">订单号</th>
            <th style="min-width: 150px">款号</th>
            <th style="width: 82px">计划</th>
            <th style="width: 66px">床次</th>
            <th style="width: 82px">实裁</th>
            <th style="width: 82px">裁差</th>
            <th style="width: 90px">扎包</th>
            <th style="width: 78px">余料</th>
            <th style="width: 96px">面料</th>
            <th style="width: 88px">状态</th>
            <th style="width: 74px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ 'row-red': !r.fabric_ok, 'row-warn': r.mixed_dye_lot }">
            <td>{{ r.cut_no }}</td>
            <td>{{ r.order_no }}</td>
            <td class="sub-cell">{{ r.style_no || '-' }}</td>
            <td class="num">{{ r.plan_qty }}</td>
            <td class="center">{{ r.lot_count || '-' }}</td>
            <td class="num">{{ r.total_cut_qty || '-' }}</td>
            <td class="num" :class="r.diff_qty ? 'amt-red' : ''">{{ r.diff_qty ? (r.diff_qty > 0 ? '+' : '') + r.diff_qty : '-' }}</td>
            <td class="num">{{ r.bundle_count ? r.bundle_count + ' 扎 / ' + r.bundle_qty : '-' }}</td>
            <td class="num">{{ r.leftover_m ? r.leftover_m + ' m' : '-' }}</td>
            <td>
              <span class="tag" :class="r.fabric_ok ? 'green' : 'red'" :title="r.fabric_reason || ''">
                {{ r.fabric_ok ? '齐套' : '缺料' }}
              </span>
            </td>
            <td><span class="tag" :class="statusTag(r.status)">{{ statusText(r.status) }}</span></td>
            <td class="ops"><button class="link-btn" @click="openDetail(r)">裁剪</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="12" class="empty-cell">没有待裁剪的订单（订单进入已分单/生产后才会出现在这里）</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 裁剪详情 -->
    <div v-if="cur" class="modal-mask" @click.self="cur = null">
      <div class="modal xwide cut-modal">
        <div class="modal-head">
          <h3>
            {{ cur.cut_no }} · {{ cur.order_no }}
            <span class="muted" style="font-weight: 400; font-size: 12px">{{ cur.style_no || '' }} · {{ statusText(cur.status) }}</span>
          </h3>
          <button class="x" @click="cur = null">×</button>
        </div>
        <div class="modal-body">
          <!-- 汇总 -->
          <div class="cut-sum">
            <div><span>计划</span><b>{{ cur.plan_qty }}</b></div>
            <div><span>实裁</span><b>{{ cur.total_cut_qty || 0 }}</b></div>
            <div><span>裁差</span><b :class="cur.diff_qty ? 'amt-red' : ''">{{ cur.diff_qty ? (cur.diff_qty > 0 ? '+' : '') + cur.diff_qty : '0' }}</b></div>
            <div><span>合格裁片</span><b class="amt-green">{{ cur.status === 'cut_done' || cur.status === 'handed' ? cur.qualified_qty : '待确认' }}</b></div>
            <div><span>疵片</span><b>{{ cur.reject_qty || 0 }}</b></div>
            <div><span>余料</span><b>{{ cur.leftover_m || 0 }} m</b></div>
            <div><span>缸号</span><b>{{ (cur.dye_lots || []).join(' / ') || '待录' }}</b></div>
          </div>

          <div v-if="!cur.fabric_gate.ok" class="cut-warn">
            ⚠ {{ cur.fabric_gate.reason }}
          </div>
          <div v-if="cur.mixed_dye_lot" class="cut-warn">
            ⚠ 本单存在多个缸号（混缸），已完成原因说明：{{ cur.diff_reason || '未填' }}
          </div>

          <!-- 床次 -->
          <div class="cut-sec">
            <div class="cut-sec-head">
              <h4>裁剪床次</h4>
              <div class="cut-ops">
                <button v-if="cur.status === 'draft'" class="btn btn-primary btn-sm" :disabled="busy" @click="startCut">
                  开始开裁
                </button>
                <button v-if="cur.status === 'cutting' || cur.status === 'cut_done'" class="btn btn-ghost btn-sm" :disabled="busy" @click="addLot">
                  ＋ 添加床次
                </button>
              </div>
            </div>
            <div class="table-wrap">
              <table class="data lot-tbl">
                <thead>
                  <tr>
                    <th style="width: 58px">床号</th>
                    <th style="width: 96px">缸号 *</th>
                    <th style="width: 94px">布卷</th>
                    <th style="width: 74px">幅宽</th>
                    <th style="width: 62px">层数</th>
                    <th style="width: 104px">排料图</th>
                    <th style="width: 74px">计划</th>
                    <th style="width: 74px">实裁</th>
                    <th style="width: 70px">余料</th>
                    <th style="width: 84px">状态</th>
                    <th style="width: 48px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="l in cur.lots" :key="l.id">
                    <td class="center">{{ l.bed_no || l.seq }}</td>
                    <td>{{ l.dye_lot || '-' }}</td>
                    <td class="sub-cell">{{ l.fabric_roll || '-' }}</td>
                    <td>{{ l.width || '-' }}</td>
                    <td class="center">{{ l.layers }}</td>
                    <td class="sub-cell">{{ l.marker_no || '-' }}</td>
                    <td class="num">{{ l.plan_qty }}</td>
                    <td class="num strong">{{ l.actual_qty }}</td>
                    <td class="num">{{ l.leftover_m || 0 }}</td>
                    <td><span class="tag" :class="l.status === 'done' ? 'green' : 'blue'">{{ l.status === 'done' ? '已裁' : '裁剪中' }}</span></td>
                    <td><button class="link-btn danger" @click="delLot(l)">删</button></td>
                  </tr>
                  <tr v-if="!cur.lots.length">
                    <td colspan="11" class="empty-cell">
                      {{ cur.status === 'draft' ? '还没开裁，点右上角「开始开裁」' : '还没有床次记录，点「＋ 添加床次」录入' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 扎包 -->
          <div class="cut-sec">
            <div class="cut-sec-head">
              <h4>扎包</h4>
              <div class="cut-ops">
                <span class="muted" style="font-size: 12px">每扎</span>
                <input class="input mini-num" type="number" v-model.number="perBundle" />
                <span class="muted" style="font-size: 12px">件</span>
                <button class="btn btn-ghost btn-sm" :disabled="busy" @click="genBundles">按尺码生成</button>
                <button class="btn btn-ghost btn-sm" :disabled="busy || !cur.bundles.length" @click="checkAll">全部复核</button>
              </div>
            </div>
            <div class="bundle-wrap">
              <div v-for="b in cur.bundles" :key="b.id" class="bundle" :class="b.status">
                <span class="bno">{{ b.bundle_no }}</span>
                <span class="bsize">{{ b.color || '-' }} / {{ b.size || '-' }}</span>
                <span class="bqty">{{ b.qty }} 件</span>
                <button v-if="b.status === 'created'" class="link-btn" @click="checkBundle(b)">复核</button>
                <span v-else class="tag green" style="font-size: 10px">已复核</span>
              </div>
              <div v-if="!cur.bundles.length" class="empty-cell" style="padding: 12px">
                还没有扎包，点「按尺码生成」按实裁数量自动拆扎
              </div>
            </div>
            <div class="bundle-sum" v-if="cur.bundles.length">
              共 {{ cur.bundle_count }} 扎 · {{ cur.bundle_qty }} 件
              <span :class="cur.bundle_diff ? 'amt-red' : 'amt-green'">
                （与合格裁片 {{ cur.qualified_qty || cur.total_cut_qty }} 件
                {{ cur.bundle_diff ? '相差 ' + cur.bundle_diff : '一致' }}）
              </span>
            </div>
          </div>

          <!-- 完成裁剪 -->
          <div v-if="cur.status === 'cutting'" class="cut-sec finish-box">
            <h4>完成裁剪</h4>
            <div class="finish-row">
              <label>合格裁片</label>
              <input class="input mini-num" type="number" v-model.number="finishForm.qualified_qty" />
              <label>疵片</label>
              <input class="input mini-num" type="number" v-model.number="finishForm.reject_qty" />
              <label>裁差原因</label>
              <input class="input" v-model="finishForm.diff_reason" placeholder="有裁差必填，如：幅宽不足少排 2 件" style="flex: 1" />
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <span v-if="cur.checked_by" class="muted" style="margin-right: auto; font-size: 12px">
            复核人 {{ cur.checked_by }}
          </span>
          <button class="btn btn-ghost" @click="cur = null">关闭</button>
          <button v-if="cur.status === 'cut_done'" class="btn btn-primary" :disabled="busy" @click="handover">P6 交接给缝制</button>
          <button v-if="cur.status === 'cutting'" class="btn btn-primary" :disabled="busy" @click="finish">完成裁剪</button>
          <span v-if="cur.status === 'handed'" class="tag green">已交接 {{ (cur.handover_at || '').slice(0, 10) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const stat = ref({});
const rows = ref([]);
const q = ref('');
const status = ref('');
const cur = ref(null);
const busy = ref(false);
const perBundle = ref(20);
const finishForm = ref({ qualified_qty: 0, reject_qty: 0, diff_reason: '' });

const statusText = (s) => ({ draft: '待开裁', cutting: '裁剪中', cut_done: '裁剪完成', handed: '已交接' }[s] || s);
const statusTag = (s) => ({ draft: 'gray', cutting: 'blue', cut_done: 'green', handed: 'purple' }[s] || 'gray');
const money = (v) => (Number(v) || 0).toFixed(2);

async function loadBoard() {
  try {
    const d = await api.cutBoard({ q: q.value, status: status.value });
    stat.value = d.stat || {};
    rows.value = d.rows || [];
  } catch (e) { alert(e.message); }
}

async function openDetail(r) {
  try {
    const d = await api.cutByOrder(r.order_id);
    cur.value = d;
    perBundle.value = d.bundle_rule || 20;
    finishForm.value = {
      qualified_qty: d.total_cut_qty || d.plan_qty,
      reject_qty: 0,
      diff_reason: d.diff_reason || ''
    };
  } catch (e) { alert(e.message); }
}

async function refresh() {
  if (!cur.value) return;
  const d = await api.cutByOrder(cur.value.order_id);
  cur.value = d;
  await loadBoard();
}

async function startCut() {
  busy.value = true;
  try {
    await api.startCut(cur.value.id);
    await refresh();
    alert('已开裁。开始录入床次，注意同单缸号必须一致');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function addLot() {
  const dye = prompt('缸号（必填，同单必须一致）：', cur.value.dye_lots[0] || '');
  if (dye === null) return;
  if (!dye.trim()) return alert('缸号必填');
  const layers = Number(prompt('拉布层数：', '30'));
  if (!(layers > 0)) return alert('层数必须大于 0');
  const actual = Number(prompt('本床实裁件数：', String(layers)));
  busy.value = true;
  try {
    await api.saveCutLot(cur.value.id, {
      dye_lot: dye.trim(), layers, actual_qty: actual,
      plan_qty: actual, fabric_roll: '', width: '', marker_no: '', marker_len: 0, leftover_m: 0
    });
    await refresh();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function delLot(l) {
  if (!confirm(`删除 ${l.bed_no || l.seq + ' 床'}？挂在它下面的扎包会一起删掉`)) return;
  try { await api.deleteCutLot(cur.value.id, l.id); await refresh(); } catch (e) { alert(e.message); }
}

async function genBundles() {
  if (cur.value.status === 'draft') return alert('先开裁并录入床次，再生成扎包');
  if (!confirm(`按每扎 ${perBundle.value} 件生成扎包？会覆盖已有扎包`)) return;
  busy.value = true;
  try {
    const r = await api.generateCutBundles(cur.value.id, { per_bundle: perBundle.value, replace: true });
    cur.value = r;
    await loadBoard();
    alert(`已生成 ${r.bundle_count} 扎，共 ${r.bundle_qty} 件`);
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function checkBundle(b) {
  try {
    const r = await api.saveCutBundle(cur.value.id, { id: b.id, status: 'checked' });
    cur.value = r;
  } catch (e) { alert(e.message); }
}

async function checkAll() {
  busy.value = true;
  try {
    for (const b of cur.value.bundles.filter((x) => x.status === 'created')) {
      await api.saveCutBundle(cur.value.id, { id: b.id, status: 'checked' });
    }
    await refresh();
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function finish() {
  const f = finishForm.value;
  if (!(f.qualified_qty > 0)) return alert('合格裁片数必须大于 0');
  const diff = (cur.value.total_cut_qty || 0) - cur.value.plan_qty;
  if (diff !== 0 && !String(f.diff_reason).trim()) {
    return alert(`实裁与计划相差 ${diff} 件，请填写裁差原因`);
  }
  busy.value = true;
  try {
    await api.finishCut(cur.value.id, {
      qualified_qty: f.qualified_qty,
      reject_qty: f.reject_qty,
      diff_reason: String(f.diff_reason).trim()
    });
    await refresh();
    alert('裁剪已完成，「裁剪」工序节点已同步为已完成');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function handover() {
  busy.value = true;
  try {
    await api.handoverCut(cur.value.id);
    await refresh();
    alert('已交接给缝制（P6 辅料交接完成）');
  } catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(loadBoard);
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 19px; color: #16233b; }
.page-head .sub { margin: 0; font-size: 12.5px; color: #8a94a6; max-width: 780px; line-height: 1.6; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 14px; }
.stat span { font-size: 12px; color: #8a94a6; }
.stat strong { display: block; margin: 4px 0 2px; font-size: 21px; color: #16233b; }
.stat small { font-size: 11.5px; color: #a9b4c5; }
.amt-green { color: #16a34a !important; }
.amt-red { color: #d92d45 !important; }
.amt-orange { color: #d97706 !important; }
.amt-blue { color: #2b6de5 !important; }
.row-red { background: #fff7f8; }
.row-warn { background: #fffdf5; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.center { text-align: center; }
.ops { white-space: nowrap; }
.muted { color: #8a94a6; }
.sub-cell { font-size: 12px; color: #5b6474; }
.empty-cell { text-align: center; color: #8a94a6; padding: 16px; }
.table-wrap { overflow-x: auto; }
table.data th, table.data td { white-space: nowrap; }

.modal.xwide.cut-modal { width: 1240px; max-width: 97vw; }
.cut-modal .modal-body { max-height: 76vh; }
.cut-sum { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; background: #f8fafd; border: 1px solid #eef2f7; border-radius: 10px; padding: 10px 12px; }
.cut-sum span { display: block; font-size: 11.5px; color: #8a94a6; }
.cut-sum b { font-size: 14px; color: #16233b; font-variant-numeric: tabular-nums; }
.cut-warn { margin-top: 10px; padding: 8px 12px; background: #fff8f9; border: 1px solid #f8d3d8; border-radius: 8px; font-size: 12.5px; color: #b91c1c; line-height: 1.6; }
.cut-sec { margin-top: 16px; }
.cut-sec-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.cut-sec-head h4 { margin: 0; font-size: 13px; color: #16233b; }
.cut-ops { display: flex; align-items: center; gap: 6px; }
.lot-tbl { min-width: 940px; }
.mini-num { width: 76px; padding: 4px 8px; font-size: 12.5px; text-align: center; }

.bundle-wrap { display: flex; flex-wrap: wrap; gap: 6px; max-height: 168px; overflow-y: auto; padding: 8px; border: 1px solid #eef2f7; border-radius: 8px; background: #fbfcfe; }
.bundle { display: flex; align-items: center; gap: 6px; background: #fff; border: 1px solid #e6ebf3; border-radius: 7px; padding: 4px 8px; font-size: 12px; }
.bundle.checked { border-color: #cfe9da; background: #f6fdf9; }
.bundle.handed { border-color: #dbe4f5; background: #f5f8ff; }
.bundle .bno { font-weight: 700; color: #16233b; font-variant-numeric: tabular-nums; }
.bundle .bsize { color: #5b6474; }
.bundle .bqty { color: #8a94a6; }
.bundle-sum { margin-top: 6px; font-size: 12px; color: #5b6474; }

.finish-box { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; background: #fbfcfe; }
.finish-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.finish-row label { font-size: 12.5px; color: #5b6474; }
@media (max-width: 1100px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .cut-sum { grid-template-columns: repeat(3, 1fr); }
}
</style>
