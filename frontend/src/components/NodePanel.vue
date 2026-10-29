<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal np-modal">
      <div class="modal-head">
        <h3 class="np-title">
          {{ p ? p.node.name : '工序' }}
          <span v-if="p" class="np-no">{{ p.order ? p.order.order_no : '' }}</span>
          <span v-if="p" class="tag" :class="stTag(p.node.status)">{{ p.node.status_label }}</span>
          <span v-if="p" class="np-kind">{{ p.panel_label }}</span>
        </h3>
        <button class="x" @click="close">×</button>
      </div>

      <div v-if="loading" class="modal-body np-loading">加载中…</div>

      <div v-else-if="p" class="modal-body np-body">
        <!-- ============ 订单条 ============ -->
        <div class="np-strip">
          <span>客户：{{ (p.order && p.order.customer_name) || '—' }}</span>
          <span>款号：{{ (p.order && p.order.style_name) || '—' }}</span>
          <span>货期：{{ (p.order && p.order.delivery_date) || '未填' }}</span>
          <span v-if="p.node.skip_reason" class="np-skip">不适用：{{ p.node.skip_reason }}</span>
        </div>

        <!-- ============ 生产分配（仅分配节点） ============ -->
        <template v-if="p.assign">
          <div class="np-sec np-assign">
            <div class="np-sec-h">
              <b>生产分配</b>
              <span class="np-tiny">分配本厂还是发外协，在这里定，不用再跑到订单页分单</span>
            </div>

            <div class="np-astrip">
              <span class="np-abadge" :class="'m-' + p.assign.mode">{{ p.assign.mode_label }}</span>
              <span>订单 <b>{{ fmtQty(p.assign.order_qty) }}</b> 件</span>
              <span>已分配 <b>{{ fmtQty(p.assign.allocated) }}</b> 件</span>
              <span :class="{ 'np-gap': p.assign.pending_qty > 0 }">
                未分配 <b>{{ fmtQty(p.assign.pending_qty) }}</b> 件
              </span>
            </div>

            <div v-if="p.assign.dispatches.length" class="np-dlist">
              <div v-for="d in p.assign.dispatches" :key="d.id" class="np-drow">
                <span class="tag" :class="d.type === 'own' ? 'blue' : 'purple'">{{ d.type_label }}</span>
                <span class="np-dfac">{{ d.factory_name || '未指定承做方' }}</span>
                <span class="np-dqty">{{ fmtQty(d.qty) }} 件</span>
                <span class="tag" :class="d.status === 'settled' ? 'green' : 'gray'">{{ d.status_label }}</span>
              </div>
            </div>
            <div v-else class="np-empty np-empty-s">还没有分单记录：这张单还没定自己做还是发外协</div>

            <div v-if="!p.assign.can_assign" class="np-warn">{{ p.assign.block_reason }}</div>
            <div v-else-if="p.assign.full" class="np-warn">
              整单已分完（{{ fmtQty(p.assign.allocated) }} 件）。要改分配方式，请到「订单 → 分单」删掉原分单再分 ——
              这里不提供"改分配"，因为改完和已经发生的领料、裁床对不上。
            </div>
            <div v-else-if="!canWrite" class="np-empty np-empty-s">你没有分配权限（需要生产或管理员角色）</div>
            <template v-else>
              <div class="np-aform">
                <label>
                  <span>分配数量</span>
                  <input class="input" type="number" min="0" step="1" v-model.number="assignForm.qty" />
                </label>
                <label>
                  <span>外协厂（整单外发时必选）</span>
                  <select class="input" v-model="assignForm.factory_id">
                    <option value="">请选择</option>
                    <option v-for="f in outFactories" :key="f.id" :value="f.id">{{ f.name }}</option>
                  </select>
                </label>
                <label class="wide">
                  <span>说明（选填）</span>
                  <input class="input" v-model="assignForm.note" placeholder="例如：本厂车缝排满，转外协 B 做 320 件" />
                </label>
              </div>
              <div class="np-actions">
                <button class="btn btn-primary btn-sm" :disabled="assigning" @click="doAssign('own')">
                  {{ assigning ? '提交中…' : '分配本厂生产' }}
                </button>
                <button class="btn btn-sm" :disabled="assigning" @click="doAssign('outsource')">整单外发</button>
                <button class="btn btn-ghost btn-sm" :disabled="assigning" @click="doAssign('cut')">裁片外发</button>
                <span class="np-tiny">
                  本厂 {{ p.assign.own_factory ? p.assign.own_factory.name : '档案缺失' }} ·
                  外协 {{ outFactories.length }} 家可选
                </span>
              </div>
            </template>
          </div>
        </template>

        <!-- ============ 采购明细（仅采购类节点） ============ -->
        <template v-if="p.purchase">
          <div class="np-sec">
            <div class="np-sec-h">
              <b>{{ p.panel_label }}</b>
              <span class="np-sum">
                共 {{ p.purchase.summary.line_count }} 行 · 合计
                <b>{{ money(p.purchase.summary.total_amount) }}</b>
                <template v-if="p.purchase.summary.gap_lines">
                  · <span class="np-gap">{{ p.purchase.summary.gap_lines }} 行缺料（{{ money(p.purchase.summary.gap_amount) }}）</span>
                </template>
                <template v-else-if="p.purchase.summary.line_count"> · 已齐套</template>
              </span>
            </div>

            <div v-if="!p.purchase.lines.length" class="np-empty">
              {{ p.purchase.summary.empty_hint || '这张单没有对应的物料需求' }}
            </div>

            <div v-else class="np-tblwrap">
              <table class="np-tbl">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>下单颜色</th>
                    <th>物料名称</th>
                    <th>色号</th>
                    <th>规格信息</th>
                    <th class="r">需求</th>
                    <th class="r">单价</th>
                    <th class="r">物料总额</th>
                    <th class="r">库存</th>
                    <th class="r">缺口</th>
                    <th>供应商</th>
                    <th>状态</th>
                    <th>物料备注</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="l in p.purchase.lines" :key="l.id">
                    <td><span class="np-ty" :class="l.mat_type">{{ l.type_label }}</span></td>
                    <td>{{ l.colorway || '—' }}</td>
                    <td class="np-name">{{ l.material_name || '—' }}</td>
                    <td>{{ l.color_no || '—' }}</td>
                    <td class="np-spec">{{ l.spec_info || '—' }}</td>
                    <td class="r">{{ fmtQty(l.need_qty) }} {{ l.unit }}</td>
                    <td class="r">{{ l.unit_price ? money(l.unit_price) : '—' }}</td>
                    <td class="r"><b>{{ money(l.amount) }}</b></td>
                    <td class="r">{{ l.stock_qty === null ? '—' : fmtQty(l.stock_qty) }}</td>
                    <td class="r" :class="{ 'np-gap': l.gap_qty > 0 }">{{ l.gap_qty > 0 ? fmtQty(l.gap_qty) : '—' }}</td>
                    <td>{{ l.supplier || '—' }}</td>
                    <td>
                      <span class="tag" :class="l.gap_qty > 0 ? 'red' : 'green'">{{ l.status_label }}</span>
                    </td>
                    <td class="np-spec">{{ l.note || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="p.purchase.summary.calc_at" class="np-tiny">
              算料时间 {{ fmtTime(p.purchase.summary.calc_at) }} · 缺料数随「齐套与缺料」重算
            </div>
          </div>
        </template>

        <!-- ============ 通用：关联单据 ============ -->
        <div v-if="p.traces.length" class="np-sec">
          <div class="np-sec-h"><b>关联单据</b><span class="np-tiny">这单在这些单据里出现过</span></div>
          <div class="np-traces">
            <div v-for="t in p.traces" :key="t.label" class="np-trace">
              <span class="np-tlabel">{{ t.label }}</span>
              <span v-for="(it, i) in t.items" :key="i" class="np-tno mono">{{ it.no }}<em v-if="it.extra">{{ it.extra }}</em></span>
            </div>
          </div>
        </div>

        <!-- ============ 备注说明 ============ -->
        <div class="np-sec">
          <div class="np-sec-h"><b>备注说明</b><span class="np-tiny">追加在节点备注末尾，时间线里留一条</span></div>
          <textarea class="input np-ta" rows="2" v-model="form.remark"
            :placeholder="p.node.remark ? '已有备注：' + p.node.remark.slice(-80) : '这一环节要交代的事（拼色、返修、延期原因…）'"></textarea>
        </div>

        <!-- ============ 上传凭证 ============ -->
        <div class="np-sec">
          <div class="np-sec-h">
            <b>上传凭证</b>
            <span class="np-tiny">现场照片，谁传的、什么时候传的都进时间线</span>
            <span class="spacer"></span>
            <label v-if="canWrite" class="btn btn-ghost btn-sm np-up">
              {{ uploading ? '上传中…' : '＋ 选择照片' }}
              <input type="file" accept="image/*" multiple hidden @change="onPick" />
            </label>
          </div>
          <div v-if="!p.photos.length" class="np-empty np-empty-s">还没有凭证照片</div>
          <div v-else class="np-photos">
            <div v-for="ph in p.photos" :key="ph.id" class="np-photo" @click="openImage(ph.url, ph.note || p.node.name)">
              <img :src="ph.url" alt="" />
              <span class="np-photo-meta">{{ ph.uploader }} · {{ fmtTime(ph.at).slice(5, 16) }}</span>
            </div>
          </div>
        </div>

        <!-- ============ 操作记录 ============ -->
        <div class="np-sec">
          <div class="np-sec-h"><b>操作记录</b><span class="np-tiny">状态、计划、责任人、备注的每次改动</span></div>
          <div v-if="!p.timeline.length" class="np-empty np-empty-s">还没有操作记录</div>
          <div v-else class="np-time">
            <div v-for="(it, i) in p.timeline" :key="i" class="np-ev">
              <span class="np-ev-at mono">{{ fmtTime(it.at) }}</span>
              <span class="np-ev-badge" :class="'a-' + it.action">{{ actionLabel(it.action) }}</span>
              <span class="np-ev-detail">{{ it.detail || '—' }}</span>
              <span class="np-ev-op">{{ it.operator || '—' }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="p" class="modal-foot np-foot">
        <template v-if="canWrite">
          <div class="np-set">
            <!-- 分配节点的状态由「分配」动作决定：手工点绿会出现「已完成但未分配」 -->
            <template v-if="p.assign">
              <span>状态</span>
              <span class="np-tiny">由分配动作决定（本厂 / 外发），不能手点</span>
            </template>
            <template v-else>
              <span>状态</span>
              <button v-for="s in ['pending', 'doing', 'done', 'skipped']" :key="s" class="np-chip"
                :class="{ on: form.status === s }" @click="form.status = s">{{ stLabel(s) }}</button>
            </template>
            <span class="np-set-l">计划</span>
            <input class="input np-date" type="date" v-model="form.plan_date" />
            <span class="np-set-l">责任人</span>
            <input class="input np-op" v-model="form.operator" placeholder="车间 / 外协厂 / 具体人" />
          </div>
        </template>
        <button class="btn btn-ghost" @click="close">关闭</button>
        <button v-if="canWrite" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch, computed } from 'vue';
import { api } from '../api';
import { openImage } from '../store/viewer';
import { can } from '../store/permissions';
import { fmtTime } from '../utils/time';

const props = defineProps({
  open: { type: Boolean, default: false },
  nodeId: { type: [Number, String], default: null }
});
const emit = defineEmits(['update:open', 'changed']);

const p = ref(null);
const loading = ref(false);
const saving = ref(false);
const uploading = ref(false);
/** 节点编辑与「配置流程」同一个权限：后端 PATCH 只放行 admin / production */
const canWrite = computed(() => can('node.flow'));

const form = reactive({ status: 'pending', plan_date: '', operator: '', remark: '', skip_reason: '' });

/* ---------------- 生产分配 ---------------- */
const assigning = ref(false);
const assignForm = reactive({ qty: 0, factory_id: '', note: '' });
/** 只有外协厂能选：分给"本厂"却点外发，标签就假了 */
const outFactories = computed(() => ((p.value && p.value.assign && p.value.assign.factories) || []).filter((f) => f.type !== 'own'));

async function doAssign(mode) {
  if (!p.value || !p.value.assign) return;
  const a = p.value.assign;
  const qty = Number(assignForm.qty);
  if (!(qty > 0)) return alert('分配数量要大于 0');
  if (qty > a.pending_qty + 0.0001) return alert(`还有 ${a.pending_qty} 件没分配，填的 ${qty} 件超了`);
  if (mode === 'outsource' && !assignForm.factory_id) return alert('整单外发要先选外协厂：不选厂，后面排产、验货、对账都找不到人');
  const tip = mode === 'own'
    ? `确认把 ${qty} 件分给本厂？分完这一步就标完成。`
    : mode === 'outsource'
      ? `确认把 ${qty} 件发给「${(outFactories.value.find((f) => f.id === Number(assignForm.factory_id)) || {}).name}」？`
      : `裁片外发：订单整体仍按本厂入账，只是裁片那一环节发出去。确认继续？`;
  if (!confirm(tip)) return;
  assigning.value = true;
  try {
    const r = await api.assignNode(props.nodeId, {
      mode, qty, note: String(assignForm.note || '').trim() || undefined,
      factory_id: mode === 'outsource' ? Number(assignForm.factory_id) : undefined
    });
    emit('changed');
    await load();
    if (r && r.hint) alert(r.hint);
  } catch (e) { alert(e.message); } finally { assigning.value = false; }
}

const ST = { pending: '待开始', doing: '进行中', done: '已完成', skipped: '不适用' };
const stLabel = (s) => ST[s] || s;
const stTag = (s) => ({ pending: 'gray', doing: 'blue', done: 'green', skipped: 'orange' }[s] || 'gray');

const ACTION = {
  status: '状态', plan: '计划', operator: '责任人', remark: '备注', skip: '不适用', photo: '凭证', report: '报工',
  assign: '分配'
};
const actionLabel = (a) => ACTION[a] || a;

const money = (n) => `¥${(Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—');

function close() { emit('update:open', false); }

async function load() {
  if (!props.nodeId) return;
  loading.value = true;
  p.value = null;
  try {
    const d = await api.nodePanel(props.nodeId);
    p.value = d;
    form.status = d.node.status;
    form.plan_date = d.node.plan_date || '';
    form.operator = d.node.operator || '';
    form.skip_reason = d.node.skip_reason || '';
    form.remark = '';
    // 分配表单默认按「还剩多少没分配」预填：绝大多数单是一次分完的
    if (d.assign) {
      assignForm.qty = d.assign.pending_qty || 0;
      assignForm.factory_id = '';
      assignForm.note = '';
    }
  } catch (e) {
    alert(e.message);
    emit('update:open', false);
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.nodeId], ([o]) => { if (o) load(); }, { immediate: true });

async function save() {
  if (!p.value) return;
  saving.value = true;
  try {
    const body = { status: form.status, plan_date: form.plan_date || null, operator: form.operator || null };
    if (form.status === 'skipped') body.skip_reason = form.skip_reason || '';
    const txt = String(form.remark || '').trim();
    if (txt) {
      // 备注是**追加**不是覆盖：前一个人写的拼色要求不能被后一个人抹掉
      const stamp = ` [${new Date().toLocaleDateString('zh-CN')} ${txt}]`;
      body.remark = `${p.value.node.remark || ''}${stamp}`;
    }
    await api.updateNode(props.nodeId, body);
    emit('changed');
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

/* ---------------- 上传凭证 ---------------- */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(rd.result);
    rd.onerror = reject;
    rd.readAsDataURL(file);
  });
}
async function onPick(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length || !p.value) return;
  uploading.value = true;
  const failed = [];
  try {
    for (const f of files) {
      try {
        const dataUrl = await readAsDataUrl(f);
        await api.createPhoto({
          order_id: p.value.order.id,
          node_id: p.value.node.id,
          dataUrl,
          cat: 'other',
          note: f.name
        });
      } catch (err) { failed.push(f.name); }
    }
    await load();
    emit('changed');
  } finally {
    uploading.value = false;
    if (failed.length) alert(`这 ${failed.length} 张没传上：${failed.join('、')}`);
  }
}
</script>

<style scoped>
.np-modal { width: 1080px; max-width: 96vw; }
/* `.mono` 只定义在各页的 scoped 样式里，全局没有 —— 组件必须自带，否则等于没样式 */
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.np-title { display: flex; align-items: center; gap: 8px; }
.np-no { font-size: 12.5px; color: #8a94a6; font-weight: 400; }
.np-kind { font-size: 11px; color: #2563eb; background: #eef4ff; border-radius: 3px; padding: 1px 6px; font-weight: 400; }
.np-body { max-height: 62vh; overflow: auto; }
.np-loading { padding: 40px 0; text-align: center; color: #8a94a6; }

.np-strip {
  display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: #606266;
  background: #f7f9fc; border: 1px solid #eef2f7; border-radius: 4px; padding: 7px 10px; margin-bottom: 12px;
}
.np-skip { color: #b45309; }

.np-sec { margin-bottom: 14px; }
.np-sec-h { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 13px; color: #16233b; }
.np-sum { font-size: 12px; color: #606266; font-weight: 400; }
.np-gap { color: #d92d45; font-weight: 700; }
.np-tiny { font-size: 11px; color: #98a2b3; }

.np-tblwrap { max-height: 300px; overflow: auto; border: 1px solid #e6ecf5; border-radius: 4px; }
.np-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.np-tbl thead th {
  position: sticky; top: 0; z-index: 1; background: #f5f7fa; color: #5b6b80; font-weight: 700;
  text-align: left; padding: 7px 8px; white-space: nowrap; border-bottom: 1px solid #e6ecf5;
}
.np-tbl td { padding: 6px 8px; border-bottom: 1px solid #f4f7fb; color: #33425c; white-space: nowrap; }
.np-tbl tbody tr:hover { background: #fafbfd; }
.np-tbl .r { text-align: right; }
.np-name { font-weight: 600; }
.np-spec { color: #8a94a6; max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
.np-ty { font-size: 11px; border-radius: 3px; padding: 1px 5px; background: #eef4ff; color: #2563eb; }
.np-ty.accessory { background: #fff7ea; color: #b45309; }

.np-empty { padding: 18px 10px; text-align: center; color: #98a2b3; font-size: 12.5px; background: #fafbfd; border: 1px dashed #e6ecf5; border-radius: 4px; }
.np-empty-s { padding: 10px; }

.np-traces { display: flex; flex-direction: column; gap: 5px; }
.np-trace { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.np-tlabel { color: #8a94a6; min-width: 52px; }
.np-tno { background: #f4f7fb; border: 1px solid #e6ecf5; border-radius: 3px; padding: 1px 6px; color: #33425c; }
.np-tno em { font-style: normal; color: #98a2b3; margin-left: 4px; }

.np-ta { width: 100%; font-family: inherit; line-height: 1.6; }
.np-up { cursor: pointer; }

/* ---------- 生产分配 ---------- */
.np-astrip { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: #4a5568; padding: 8px 10px; background: #f7f9fc; border-radius: 6px; }
.np-astrip b { color: #16233b; font-size: 15px; }
.np-abadge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 12px; background: #eef1f6; color: #6b7688; }
.np-abadge.m-own { background: #e8f0ff; color: #2563eb; }
.np-abadge.m-outsource { background: #f0eaff; color: #7c3aed; }
.np-abadge.m-mixed { background: #fff2e0; color: #d97706; }
.np-dlist { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.np-drow { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 5px 8px; border: 1px solid #eef2f7; border-radius: 5px; }
.np-dfac { flex: 1; color: #33425c; }
.np-dqty { font-family: ui-monospace, Menlo, monospace; color: #16233b; font-weight: 700; }
.np-warn { margin-top: 8px; padding: 8px 10px; background: #fff8ec; border: 1px solid #f7e2bd; color: #a35f00; border-radius: 5px; font-size: 12px; line-height: 1.6; }
.np-aform { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.np-aform label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: #8a94a6; }
.np-aform label.wide { flex: 1; min-width: 200px; }
.np-aform input, .np-aform select { min-width: 110px; }
.np-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }

.np-photos { display: flex; gap: 8px; flex-wrap: wrap; }
.np-photo { width: 96px; cursor: pointer; }
.np-photo img { width: 96px; height: 96px; object-fit: cover; border-radius: 5px; border: 1px solid #e6ecf5; display: block; }
.np-photo-meta { display: block; font-size: 10.5px; color: #98a2b3; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.np-time { border-left: 2px solid #eef2f7; padding-left: 12px; }
.np-ev { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: 12px; }
.np-ev-at { color: #98a2b3; white-space: nowrap; }
.np-ev-badge { font-size: 10.5px; border-radius: 3px; padding: 1px 5px; background: #f2f6fc; color: #5b6b80; white-space: nowrap; }
.np-ev-badge.a-status { background: #eef4ff; color: #2563eb; }
.np-ev-badge.a-photo { background: #eef7f2; color: #15803d; }
.np-ev-badge.a-remark { background: #fff7ea; color: #b45309; }
.np-ev-detail { color: #33425c; flex: 1; min-width: 0; word-break: break-all; }
.np-ev-op { color: #8a94a6; white-space: nowrap; }

.np-foot { flex-wrap: wrap; gap: 8px; }
.np-set { display: flex; align-items: center; gap: 6px; margin-right: auto; flex-wrap: wrap; font-size: 12.5px; color: #606266; }
.np-set-l { margin-left: 6px; color: #8a94a6; }
.np-chip {
  border: 1px solid #dcdfe6; background: #fff; color: #606266; border-radius: 3px;
  padding: 3px 9px; font-size: 12px; cursor: pointer;
}
.np-chip.on { border-color: #1890ff; color: #1890ff; background: #eef4ff; }
.np-date { width: 140px; }
.np-op { width: 170px; }
</style>
