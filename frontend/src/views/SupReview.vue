<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>供方信息协同与技术再次审核</h2>
        <p class="sub">
          技术包核准要走三段，<b>顺序不能反</b>：<b>A1</b> 本单谁处理、版自制还是外发还是复用 →
          <b>A2</b> 材料是哪家的、什么规格、什么价（<b>有版本</b>）→ <b>A3</b> 技术复审并核准（<b>必须引用同版本 A2</b>）。
          换了供方、改了规格或用替代材料，<b>原核准自动失效</b>——找不到依据的核准就是拍板。
          <b>找料样料与正式大货采购分开</b>：仅样料必须写批准依据，且不能直接当大货买。
        </p>
      </div>
      <div class="head-ops">
        <span class="pill p-gray">{{ dict.current_date || '—' }}</span>
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <span>技术包</span>
        <strong>{{ num(board.stat && board.stat.packs) }}</strong>
        <small>进入协同流程的</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.a1_pending ? 'st-warn' : ''">
        <span>A1 待分工</span>
        <strong>{{ num(board.stat && board.stat.a1_pending) }}</strong>
        <small>还没派技术负责人 / 分工未确认</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.a2_pending ? 'st-warn' : ''">
        <span>A2 待供方确认</span>
        <strong>{{ num(board.stat && board.stat.a2_pending) }}</strong>
        <small>供货条件没齐或还是草稿</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.a3_pending ? 'st-warn' : ''">
        <span>A3 待复审</span>
        <strong>{{ num(board.stat && board.stat.a3_pending) }}</strong>
        <small>还没做技术复审</small>
      </div>
      <div class="stat" :class="board.stat && board.stat.a3_stale ? 'st-bad' : ''">
        <span>A3 已失效</span>
        <strong>{{ num(board.stat && board.stat.a3_stale) }}</strong>
        <small>供货条件变了，必须重审</small>
      </div>
      <div class="stat">
        <span>仅样料物料</span>
        <strong>{{ num(board.stat && board.stat.sample_only_materials) }}</strong>
        <small>不能直接大货采购</small>
      </div>
    </div>

    <div class="help-bar">
      <b>为什么 A3 会失效：</b>{{ board.rule_note }}
    </div>

    <div class="toolbar">
      <div class="seg">
        <button :class="{ on: filter === '' }" @click="setFilter('')">全部</button>
        <button v-for="s in board.stages || []" :key="s.k" :class="{ on: filter === s.k }" @click="setFilter(s.k)">
          {{ s.label }} <i>{{ s.count }}</i>
        </button>
      </div>
      <input v-model="kw" class="inp" placeholder="款名 / 款号 / 版型号" style="width: 220px" />
    </div>

    <div class="panel">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>技术包</th><th>款号 / 版型</th><th>A1 制版分工</th>
              <th class="num">物料</th><th class="num">已确认</th><th class="num">仅样料</th>
              <th class="num">复审生效</th><th class="num">已失效</th><th>阶段</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.tech_pack_id" :class="rowClass(r.stage)">
              <td>
                <b>#{{ r.tech_pack_id }}</b>
                <div class="tiny muted">{{ r.product_name || '—' }}</div>
              </td>
              <td class="tiny">
                {{ r.style_no || '—' }}
                <div class="muted">{{ r.pattern_no || '无版号' }}</div>
              </td>
              <td class="tiny">
                <span v-if="r.scope_label" class="tag" :class="r.pattern_scope === 'reuse' ? 'blue' : (r.pattern_scope === 'outsource' ? 'purple' : 'gray')">{{ r.scope_label }}</span>
                <span v-else class="muted">未分工</span>
                <span v-if="r.a1_status === 'draft'" class="tag orange" style="margin-left: 4px">未确认</span>
              </td>
              <td class="num tiny">{{ r.materials }}</td>
              <td class="num tiny" :class="{ red: r.confirmed < r.materials }">{{ r.confirmed }}</td>
              <td class="num tiny" :class="{ orange: r.sample_only }">{{ r.sample_only || '—' }}</td>
              <td class="num tiny ok-line">{{ r.reviews_live || '—' }}</td>
              <td class="num tiny" :class="{ red: r.reviews_stale }">{{ r.reviews_stale || '—' }}</td>
              <td><span class="tag" :class="stageTag(r.stage)">{{ r.stage_label }}</span></td>
              <td class="ops"><button class="btn btn-ghost btn-sm" @click="open(r.tech_pack_id)">协同</button></td>
            </tr>
            <tr v-if="!shown.length"><td colspan="10" class="empty">没有符合条件的技术包</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================= 详情 ================= -->
    <div v-if="det.open && det.data" class="modal-mask">
      <div class="modal xxwide review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" @keydown.esc.stop="det.open = false">
        <header class="review-header"><h3 id="review-title">
          #{{ det.data.tech_pack.id }} {{ det.data.tech_pack.product_name }}
          <span class="tag" :class="stageTag(det.data.stage)" style="margin-left: 8px">{{ det.data.stage_label }}</span>
          <span class="tag gray" style="margin-left: 6px">技术包 {{ det.data.tech_pack.status === 'confirmed' ? '已核准' : '未核准' }}</span>
        </h3><button type="button" class="btn btn-ghost" autofocus @click="det.open = false">关闭</button></header>

        <div class="review-body" tabindex="0" aria-label="协同与复审明细"><div v-if="det.data.problems.length" class="warn-box">
          <b>还差这些：</b>
          <div v-for="(p, i) in det.data.problems" :key="i">· {{ p }}</div>
        </div>

        <!-- A1 -->
        <div class="step">
          <div class="step-head">
            <span class="step-no" :class="det.data.assignment && det.data.assignment.status === 'confirmed' ? 'done' : 'todo'">A1</span>
            <b>技术处理与制版分工</b>
            <span v-if="det.data.assignment" class="tag" :class="det.data.assignment.status === 'confirmed' ? 'green' : 'orange'" style="margin-left: 8px">
              {{ det.data.assignment.status === 'confirmed' ? '已确认' : '草稿' }}
            </span>
          </div>
          <div v-if="det.data.assignment && canWrite" class="hint-line">
            当前：{{ det.data.assignment.tech_owner }} · {{ det.data.assignment.scope_label }}
            <span v-if="det.data.assignment.pattern_vendor_name">（{{ det.data.assignment.pattern_vendor_name }}）</span>
            <span v-if="det.data.assignment.pattern_scope === 'reuse'">（复用技术包 #{{ det.data.assignment.reuse_tech_pack_id }}）</span>
            · 版费 {{ money(det.data.assignment.pattern_price) }}
            <button v-if="det.data.assignment.status === 'draft'" class="btn btn-ghost btn-sm" style="margin-left: 8px" @click="confirmA1">确认分工</button>
            <button class="lnk" style="margin-left: 8px" @click="editA1">改分工</button>
          </div>
          <div v-if="a1.edit || !det.data.assignment" class="fgrid">
            <label class="fl">技术处理人 <span class="red">*</span><input v-model="a1.tech_owner" /></label>
            <label class="fl">制版分工
              <select v-model="a1.pattern_scope">
                <option v-for="s in dict.pattern_scope || []" :key="s.k" :value="s.k">{{ s.label }}</option>
              </select>
            </label>
            <label v-if="a1.pattern_scope === 'outsource'" class="fl">版房（外发）
              <select v-model="a1.pattern_vendor_id">
                <option value="">请选择</option>
                <option v-for="s in options.suppliers || []" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </label>
            <label v-if="a1.pattern_scope === 'reuse'" class="fl">原技术包（已核准）
              <select v-model="a1.reuse_tech_pack_id">
                <option value="">请选择</option>
                <option v-for="p in options.reusable_packs || []" :key="p.id" :value="p.id">#{{ p.id }} {{ p.product_name }}</option>
              </select>
            </label>
            <label class="fl">版费<input v-model.number="a1.pattern_price" type="number" min="0" /></label>
            <label class="fl">完成期限<input v-model="a1.due_date" type="date" /></label>
            <label class="fl" style="grid-column: span 2">备注<input v-model="a1.note" /></label>
          </div>
          <div v-if="a1.edit || !det.data.assignment" class="step-ops">
            <button v-if="a1.edit" class="btn btn-ghost btn-sm" @click="a1.edit = false">取消</button>
            <button class="btn btn-primary btn-sm" @click="saveA1">保存分工</button>
          </div>
        </div>

        <!-- A2 -->
        <div class="step">
          <div class="step-head">
            <span class="step-no" :class="det.data.current_confirms.length && det.data.current_confirms.every((c) => c.status === 'confirmed') ? 'done' : 'todo'">A2</span>
            <b>材料供货条件（有版本）</b>
            <span class="tiny muted" style="margin-left: 8px">同物料只能有一版生效；换供方/改规格会出新版本</span>
          </div>
          <div class="table-wrap" style="max-height: 260px; overflow-y: auto">
            <table class="data" style="min-width: 1020px">
              <thead>
                <tr>
                  <th>物料</th><th>规格 / 成分</th><th>供方</th><th>来源</th>
                  <th class="num">单价</th><th class="num">交期</th><th class="num">版本</th>
                  <th>样料依据 / 批准依据</th><th>状态</th><th>采购</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in det.data.confirms" :key="c.id" :class="{ 'row-muted': !c.is_current }">
                  <td class="tiny">{{ c.material_name }}</td>
                  <td class="tiny wrap" style="min-width: 130px">{{ c.spec }}<div class="muted">{{ c.composition || '—' }}</div></td>
                  <td class="tiny">{{ c.supplier_name }}</td>
                  <td class="tiny">
                    <span class="tag" :class="c.source_type === 'sample_only' ? 'orange' : (c.source_type === 'new_dev' ? 'purple' : 'gray')">{{ c.source_label }}</span>
                  </td>
                  <td class="num tiny">{{ c.unit_price === null ? '—' : money(c.unit_price) }}</td>
                  <td class="num tiny">{{ c.lead_days || '—' }}</td>
                  <td class="num tiny">
                    V{{ c.version }}
                    <span v-if="!c.is_current" class="tag gray" style="margin-left: 4px">已作废</span>
                  </td>
                  <td class="tiny wrap" style="min-width: 180px">
                    <div>{{ c.sample_basis || '—' }}</div>
                    <div v-if="c.approval_ref" class="orange">{{ c.approval_ref }}</div>
                  </td>
                  <td><span class="tag" :class="c.status === 'confirmed' ? 'green' : 'orange'">{{ c.status === 'confirmed' ? '已确认' : '草稿' }}</span></td>
                  <td class="tiny">
                    <span v-if="c.can_purchase" class="ok-line">可</span>
                    <span v-else class="red" title="仅样料：找料与正式大货采购分开">不可</span>
                  </td>
                  <td class="ops">
                    <button v-if="canWrite && c.is_current && c.status !== 'confirmed'" class="btn btn-ghost btn-sm" @click="confirmA2(c.id)">确认</button>
                    <button v-if="canWrite && c.is_current && c.status === 'confirmed' && c.conclusion !== 'reject'" class="btn btn-ghost btn-sm" @click="openReview(c)">复审</button>
                  </td>
                </tr>
                <tr v-if="!det.data.confirms.length"><td colspan="11" class="empty">还没有供方确认</td></tr>
              </tbody>
            </table>
          </div>
          <div v-if="canWrite" class="a2-form">
            <div class="fgrid">
              <label class="fl">物料名称 <span class="red">*</span><input v-model="a2.material_name" placeholder="精梳棉双面布 280G" /></label>
              <label class="fl">适用规格 <span class="red">*</span><input v-model="a2.spec" placeholder="160cm/米" /></label>
              <label class="fl">成分<input v-model="a2.composition" placeholder="100% 棉" /></label>
              <label class="fl">供方 <span class="red">*</span>
                <select v-model="a2.supplier_id">
                  <option value="">请选择</option>
                  <option v-for="s in options.suppliers || []" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
              </label>
              <label class="fl">来源
                <select v-model="a2.source_type">
                  <option v-for="s in dict.source_type || []" :key="s.k" :value="s.k">{{ s.label }}</option>
                </select>
              </label>
              <label class="fl">单价<input v-model.number="a2.unit_price" type="number" min="0" step="0.01" /></label>
              <label class="fl">交期（天）<input v-model.number="a2.lead_days" type="number" min="0" /></label>
              <label class="fl">需求号<input v-model="a2.requirement_no" placeholder="找料任务号" /></label>
              <label class="fl" :class="{ req: a2.source_type !== 'existing' }">样料依据
                <input v-model="a2.sample_basis" placeholder="色卡号 / 样布编号" />
              </label>
              <label class="fl" :class="{ req: a2.source_type === 'sample_only' }">批准依据
                <input v-model="a2.approval_ref" placeholder="谁批准了这次找料" />
              </label>
            </div>
            <div class="tiny muted">
              <span v-if="a2.source_type === 'existing'">现有成熟供方：只核对适用性，不要求重新开发。</span>
              <span v-else-if="a2.source_type === 'new_dev'">新开发供方：必须写样料依据。</span>
              <span v-else>仅样料：必须写批准依据，且<b>不能直接大货采购</b>——大货要另走正式确认。</span>
            </div>
            <button class="btn btn-primary btn-sm" style="margin-top: 6px" @click="saveA2">保存为新版本</button>
          </div>
        </div>

        <!-- A3 -->
        <div class="step">
          <div class="step-head">
            <span class="step-no" :class="det.data.reviews.some((r) => r.live && r.conclusion !== 'reject') ? 'done' : 'todo'">A3</span>
            <b>技术复审与核准</b>
            <span class="tiny muted" style="margin-left: 8px">必须引用当前版本的 A2；供货条件一变，这里自动失效</span>
          </div>
          <div class="table-wrap" style="max-height: 220px; overflow-y: auto">
            <table class="data" style="min-width: 880px">
              <thead>
                <tr><th>复审号</th><th>物料</th><th class="num">引用版本</th><th>结论</th><th>差异原因</th><th>核准人</th><th>是否有效</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in det.data.reviews" :key="r.id" :class="{ 'row-bad': r.stale && r.conclusion !== 'reject' }">
                  <td class="mono tiny">{{ r.review_no }}</td>
                  <td class="tiny">{{ r.material_name || '—' }}</td>
                  <td class="num tiny">V{{ r.confirm_version }}</td>
                  <td><span class="tag" :class="conclTag(r.conclusion)">{{ conclLabel(r.conclusion) }}</span></td>
                  <td class="tiny wrap" style="min-width: 200px">{{ r.diff_reason || '—' }}</td>
                  <td class="tiny">{{ r.approved_by || '—' }}</td>
                  <td class="tiny">
                    <span v-if="r.conclusion === 'reject'" class="muted">退回项</span>
                    <span v-else-if="r.stale" class="red">已失效</span>
                    <span v-else class="ok-line">有效</span>
                    <div v-if="r.stale" class="tiny red" style="white-space: normal">{{ r.stale_reason }}</div>
                  </td>
                </tr>
                <tr v-if="!det.data.reviews.length"><td colspan="7" class="empty">还没有复审记录</td></tr>
              </tbody>
            </table>
          </div>

          <div v-if="canWrite && rv.open" class="a2-form">
            <div class="a3-title">复审「{{ rv.material_name }}」· 引用 {{ rv.confirm_no }} V{{ rv.confirm_version }}</div>
            <div class="fgrid">
              <label class="fl">复审结论
                <select v-model="rv.conclusion">
                  <option v-for="c in dict.conclusion || []" :key="c.k" :value="c.k">{{ c.label }}</option>
                </select>
              </label>
              <label class="fl">核准人 <span class="red">*</span><input v-model="rv.approved_by" /></label>
              <label class="fl" style="grid-column: span 2" :class="{ req: rv.conclusion !== 'pass' }">
                差异原因 {{ rv.conclusion !== 'pass' ? '（必填）' : '（可选）' }}
                <input v-model="rv.diff_reason" placeholder="差在哪、要业务确认什么" />
              </label>
            </div>
            <div class="step-ops">
              <button class="btn btn-ghost btn-sm" @click="rv.open = false">取消</button>
              <button class="btn btn-primary btn-sm" @click="saveReview">提交复审</button>
            </div>
          </div>
          <div v-else-if="canWrite" class="tiny muted">在 A2 表格里点「复审」选一条已确认的供货条件。</div>
        </div>

        </div><div class="modal-ops">
          <button class="btn btn-ghost" @click="det.open = false">关闭</button>
          <button v-if="canWrite" class="btn btn-primary" :disabled="!det.data.can_approve" @click="approve">
            核准技术包
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const dict = ref({});
const board = ref({ stat: {}, stages: [], rows: [] });
const options = ref({ suppliers: [], reusable_packs: [] });
const filter = ref('');
const kw = ref('');

const canWrite = computed(() => can('supreview.write'));

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100) / 100);
const money = (v) => (v === null || v === undefined ? '—' : '¥' + (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN'));
const stageTag = (s) => ({
  a1_pending: 'gray', a2_pending: 'orange', a3_pending: 'orange', a3_stale: 'red', ready: 'green'
}[s] || 'gray');
const conclLabel = (c) => ({ pass: '通过', conditional: '有条件通过', reject: '退回' }[c] || c);
const conclTag = (c) => ({ pass: 'green', conditional: 'orange', reject: 'red' }[c] || 'gray');
const rowClass = (s) => (s === 'a3_stale' ? 'row-bad' : (s === 'ready' ? '' : 'row-warn'));

const shown = computed(() => {
  const k = kw.value.trim().toLowerCase();
  return (board.value.rows || []).filter((r) => {
    if (filter.value && r.stage !== filter.value) return false;
    if (!k) return true;
    return [r.product_name, r.style_no, r.pattern_no].some((x) => String(x || '').toLowerCase().includes(k));
  });
});

const det = reactive({ open: false, data: null });
const a1 = reactive({ edit: false, tech_owner: '', pattern_scope: 'self', pattern_vendor_id: '', reuse_tech_pack_id: '', pattern_price: null, due_date: '', note: '' });
const a2 = reactive({
  material_name: '', spec: '', composition: '', supplier_id: '', source_type: 'existing',
  unit_price: null, lead_days: null, requirement_no: '', sample_basis: '', approval_ref: ''
});
const rv = reactive({ open: false, confirm_id: null, confirm_no: '', confirm_version: 1, material_name: '', conclusion: 'pass', approved_by: '', diff_reason: '' });

async function reload() {
  const [b, o] = await Promise.all([api.supBoard({}), api.supOptions()]);
  board.value = b;
  options.value = o;
}

function setFilter(k) {
  filter.value = k;
}

async function open(id) {
  det.data = await api.supPack(id);
  det.open = true;
  a1.edit = false;
  if (det.data.assignment) {
    Object.assign(a1, {
      tech_owner: det.data.assignment.tech_owner || '',
      pattern_scope: det.data.assignment.pattern_scope || 'self',
      pattern_vendor_id: det.data.assignment.pattern_vendor_id || '',
      reuse_tech_pack_id: det.data.assignment.reuse_tech_pack_id || '',
      pattern_price: det.data.assignment.pattern_price,
      due_date: det.data.assignment.due_date || '',
      note: det.data.assignment.note || ''
    });
  } else {
    Object.assign(a1, { tech_owner: '', pattern_scope: 'self', pattern_vendor_id: '', reuse_tech_pack_id: '', pattern_price: null, due_date: '', note: '' });
  }
  Object.assign(a2, {
    material_name: '', spec: '', composition: '', supplier_id: '', source_type: 'existing',
    unit_price: null, lead_days: null, requirement_no: '', sample_basis: '', approval_ref: ''
  });
  rv.open = false;
}

function editA1() {
  a1.edit = true;
}

async function saveA1() {
  try {
    const body = { ...a1 };
    delete body.edit;
    if (!body.pattern_vendor_id) delete body.pattern_vendor_id;
    if (!body.reuse_tech_pack_id) delete body.reuse_tech_pack_id;
    if (det.data.assignment && det.data.assignment.status === 'confirmed') body.force = 1;
    det.data = await api.saveSupAssignment(det.data.tech_pack.id, body);
    a1.edit = false;
    await reload();
  } catch (e) {
    alert(e.message);
  }
}

async function confirmA1() {
  try {
    det.data = await api.confirmSupAssignment(det.data.tech_pack.id);
    await reload();
  } catch (e) {
    alert(e.message);
  }
}

async function saveA2() {
  try {
    if (!a2.material_name || !a2.spec || !a2.supplier_id) return alert('物料名称、适用规格、供方必填');
    det.data = await api.createSupConfirm(det.data.tech_pack.id, { ...a2 });
    Object.assign(a2, { material_name: '', spec: '', composition: '', supplier_id: '', source_type: 'existing', unit_price: null, lead_days: null, requirement_no: '', sample_basis: '', approval_ref: '' });
    await reload();
  } catch (e) {
    alert(e.message);
  }
}

async function confirmA2(id) {
  try {
    det.data = await api.confirmSupConfirm(id);
    await reload();
  } catch (e) {
    alert(e.message);
  }
}

function openReview(c) {
  Object.assign(rv, {
    open: true, confirm_id: c.id, confirm_no: c.confirm_no, confirm_version: c.version,
    material_name: c.material_name, conclusion: 'pass', approved_by: '', diff_reason: ''
  });
}

async function saveReview() {
  try {
    det.data = await api.createSupReview(det.data.tech_pack.id, {
      confirm_id: rv.confirm_id, conclusion: rv.conclusion,
      approved_by: rv.approved_by, diff_reason: rv.diff_reason
    });
    rv.open = false;
    await reload();
  } catch (e) {
    alert(e.message);
  }
}

async function approve() {
  try {
    det.data = await api.approveSupPack(det.data.tech_pack.id, {});
    await reload();
    alert('技术包已核准');
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  dict.value = await api.supDict();
  await reload();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 14px 0 16px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat small { display: block; font-size: 12px; color: #9aa4b5; margin-top: 4px; }
.stat.st-warn { border-color: #f7d9a8; background: #fffaf1; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.help-bar { background: #f6f9fe; border: 1px solid #e2ebf8; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #4a5568; line-height: 1.8; margin-bottom: 12px; }
.warn-box { background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 9px 12px; font-size: 12px; color: #92400e; line-height: 1.75; margin: 6px 0 10px; }

.seg { display: flex; gap: 6px; flex-wrap: wrap; }
.seg button { padding: 5px 11px; border: 1px solid var(--line); background: var(--surface); border-radius: 8px; font-size: 12.5px; color: #5b6474; cursor: pointer; }
.seg button.on { background: #16305f; border-color: #16305f; color: #fff; }
.seg button i { font-style: normal; opacity: .7; margin-left: 3px; }

.step { border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; margin: 12px 0; }
.step-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 13px; color: #16305f; }
.step-no { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 20px; border-radius: 6px; font-size: 12px; font-weight: 800; }
.step-no.done { background: #e8f5ec; color: #16a34a; }
.step-no.todo { background: #eef2f8; color: var(--ink-soft); }
.step-ops { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.hint-line { font-size: 12px; color: #5b6474; background: #f8fafd; border-radius: 8px; padding: 6px 10px; margin-bottom: 8px; }

.fgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.fl { display: block; font-size: 12px; color: #5b6474; }
.fl input, .fl select { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }
.fl.req { color: #92400e; }

.a2-form { background: #f8fafd; border-radius: 10px; padding: 10px 12px; margin-top: 10px; }
.a3-title { font-size: 12.5px; color: #16305f; font-weight: 700; margin-bottom: 8px; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
.ops { white-space: nowrap; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-warn { background: #fffdf6; }
.row-bad { background: #fff6f7; }
.row-muted { opacity: .6; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }
.lnk { background: none; border: none; color: #2f6fed; font-size: 12px; cursor: pointer; padding: 0 2px; }
.modal.review-dialog { display:flex; flex-direction:column; max-height:calc(100dvh - 32px); overflow:hidden; padding:0; }
.review-header, .review-dialog > .modal-ops { flex:none; padding:12px 20px; }
.review-header { display:flex; align-items:center; justify-content:space-between; gap:12px; }.review-header h3 { margin:0; }
.review-body { min-height:0; overflow:auto; overscroll-behavior:contain; padding:4px 20px 16px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fgrid { grid-template-columns: 1fr; }
  .page-head .pill { display: none; }
}
</style>
