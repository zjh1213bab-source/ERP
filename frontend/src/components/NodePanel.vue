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
            <span>状态</span>
            <button v-for="s in ['pending', 'doing', 'done', 'skipped']" :key="s" class="np-chip"
              :class="{ on: form.status === s }" @click="form.status = s">{{ stLabel(s) }}</button>
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

const ST = { pending: '待开始', doing: '进行中', done: '已完成', skipped: '不适用' };
const stLabel = (s) => ST[s] || s;
const stTag = (s) => ({ pending: 'gray', doing: 'blue', done: 'green', skipped: 'orange' }[s] || 'gray');

const ACTION = {
  status: '状态', plan: '计划', operator: '责任人', remark: '备注', skip: '不适用', photo: '凭证', report: '报工'
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
