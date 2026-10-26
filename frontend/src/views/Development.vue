<template>
  <div>
    <div class="page-head">
      <div>
        <h2>开发管理</h2>
        <div class="sub">打版流程：可打版 → 面辅料确认 → 制版 → 工艺 → 做样衣 → 业务确认</div>
      </div>
      <div style="display: flex; gap: 10px">
        <div class="seg">
          <button :class="{ on: view === 'card' }" @click="view = 'card'">卡片</button>
          <button :class="{ on: view === 'kanban' }" @click="view = 'kanban'">看板</button>
        </div>
        <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增开发单</button>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索 订单号 / 款名 / 产品 / 客户" @keyup.enter="load" style="width: 260px" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <div class="tabs">
        <button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- 卡片视图 -->
    <div v-if="view === 'card'">
      <div class="dev-grid">
        <div v-for="r in filtered" :key="r.id" class="dev-card">
          <div class="dev-img">👕</div>
          <div class="dev-body">
            <div class="dev-name" :title="r.product_name">{{ r.product_name }}</div>
            <div class="dev-sub">{{ r.order_no || '-' }}</div>
            <div class="dev-sub">{{ r.customer_name || '-' }} · {{ r.version }}</div>
            <div style="margin: 8px 0">
              <span class="tag" :class="stageTag(r.stage)">{{ stageLabel(r.stage) }}</span>
            </div>
            <div class="dev-acts">
              <button class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-if="r.stage !== 'confirmed'" class="link-btn" @click="advance(r)">推进 →</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="!filtered.length" class="empty-cell">暂无开发单</div>
    </div>

    <!-- 看板视图 -->
    <div v-else class="kanban">
      <div class="kcol" v-for="s in STAGES" :key="s.key">
        <div class="kcol-head">
          <span>{{ s.label }}</span>
          <span class="kcount">{{ byStage[s.key].length }}</span>
        </div>
        <div class="kcol-body">
          <div v-for="r in byStage[s.key]" :key="r.id" class="kcard">
            <div class="kcard-title">{{ r.product_name }}</div>
            <div class="kcard-sub">{{ r.order_no || '-' }} · {{ r.customer_name || '-' }}</div>
            <div class="kcard-acts">
              <button class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-if="s.key !== 'confirmed'" class="link-btn" @click="advance(r)">推进 →</button>
            </div>
          </div>
          <div v-if="!byStage[s.key].length" class="kempty">—</div>
        </div>
      </div>
    </div>

    <!-- 编辑器 -->
    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑开发单' : '新增开发单' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>关联订单 *</label>
              <select class="select" v-model.number="form.order_id" :disabled="!!form.id">
                <option :value="null">— 请选择订单 —</option>
                <option v-for="o in orders" :key="o.id" :value="o.id">{{ o.order_no }} · {{ o.style_name || o.customer_name || '' }}</option>
              </select>
            </div>
            <div class="fitem"><label>产品 / 款号 *</label><input class="input" v-model="form.product_name" /></div>
            <div class="fitem"><label>版本</label><input class="input" v-model="form.version" /></div>
            <div class="fitem"><label>尺码规格说明</label><input class="input" v-model="form.size_spec" /></div>
            <div class="fitem full">
              <label>面料 *（勾选）</label>
              <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 6px">
                <label v-for="m in fabrics" :key="m.id" style="font-size: 12.5px; display: flex; gap: 4px; align-items: center">
                  <input type="checkbox" :value="m.id" v-model="form.fabric_ids" /> {{ m.name }} <span style="color: #8a94a6">{{ m.spec || '' }}</span>
                </label>
                <span v-if="!fabrics.length" style="color: #8a94a6; font-size: 12.5px">面料库为空，请到系统设置添加</span>
              </div>
              <input class="input" v-model="form.fabric_info" placeholder="面料补充说明（可空）" />
            </div>
            <div class="fitem full">
              <label>辅料 *（勾选）</label>
              <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 6px">
                <label v-for="m in accessories" :key="m.id" style="font-size: 12.5px; display: flex; gap: 4px; align-items: center">
                  <input type="checkbox" :value="m.id" v-model="form.accessory_ids" /> {{ m.name }} <span style="color: #8a94a6">{{ m.spec || '' }}</span>
                </label>
                <span v-if="!accessories.length" style="color: #8a94a6; font-size: 12.5px">辅料库为空，请到系统设置添加</span>
              </div>
              <input class="input" v-model="form.accessory_info" placeholder="辅料补充说明（可空）" />
            </div>
            <div class="fitem full"><label>工艺工序 *</label><textarea v-model="form.craft_info" rows="3" placeholder="印花 / 绣花 / 水洗 / 车缝 / 锁眼 / 整烫…"></textarea></div>
            <div class="fitem full"><label>客户要求 *</label><textarea v-model="form.customer_req" rows="3" placeholder="尺码表 / 包装 / 标签 / 测试要求 / 交期"></textarea></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="form.remark" /></div>
          </div>
          <p style="font-size: 11.5px; color: #8a94a6; margin: 10px 0 0">带 * 为业务确认前必填项（定制订单）。确认后锁定，需新建版本修改。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { hasRole } from '../store/auth';

const route = useRoute();

const list = ref([]);
const q = ref('');
const view = ref('card');
const tab = ref('all');
const orders = ref([]);
const fabrics = ref([]);
const accessories = ref([]);

const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());

const canWrite = computed(() => hasRole('tech', 'sales'));

const STAGES = [
  { key: 'draft', label: '可打版' },
  { key: 'material', label: '面辅料确认' },
  { key: 'pattern', label: '制版' },
  { key: 'craft', label: '工艺/工序' },
  { key: 'sample', label: '做样衣' },
  { key: 'biz', label: '业务确认' },
  { key: 'confirmed', label: '已完成' }
];
const tabs = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '待打版' },
  { key: 'doing', label: '打版中' },
  { key: 'confirmed', label: '已完成' }
];

const STAGE_TAG = { draft: 'gray', material: 'blue', pattern: 'purple', craft: 'blue', sample: 'orange', biz: 'orange', confirmed: 'green' };
const stageLabel = (s) => (STAGES.find((x) => x.key === s) || {}).label || s || '可打版';
const stageTag = (s) => STAGE_TAG[s] || 'gray';

const filtered = computed(() => {
  if (tab.value === 'all') return list.value;
  if (tab.value === 'draft') return list.value.filter((r) => (r.stage || 'draft') === 'draft');
  if (tab.value === 'confirmed') return list.value.filter((r) => r.stage === 'confirmed');
  return list.value.filter((r) => ['material', 'pattern', 'craft', 'sample', 'biz'].includes(r.stage));
});
const byStage = computed(() => {
  const m = {};
  STAGES.forEach((s) => (m[s.key] = []));
  list.value.forEach((r) => {
    const k = r.stage || 'draft';
    (m[k] || m.draft).push(r);
  });
  return m;
});

function blank() {
  return { id: null, order_id: null, product_name: '', version: 'V1', fabric_ids: [], accessory_ids: [], fabric_info: '', accessory_info: '', craft_info: '', customer_req: '', size_spec: '', remark: '' };
}

async function load() {
  try { list.value = await api.techpacksAll({ q: q.value }); }
  catch (e) { alert(e.message); }
}
async function loadRefs() {
  const [os, ms] = await Promise.all([api.orders({}), api.materials({})]);
  orders.value = os;
  fabrics.value = ms.filter((m) => m.type === 'fabric' && m.status === 'active');
  accessories.value = ms.filter((m) => m.type === 'accessory' && m.status === 'active');
}

function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(r) {
  form.value = {
    ...r,
    fabric_ids: r.fabric_ids ? String(r.fabric_ids).split(',').filter(Boolean).map(Number) : [],
    accessory_ids: r.accessory_ids ? String(r.accessory_ids).split(',').filter(Boolean).map(Number) : []
  };
  showModal.value = true;
}

async function save() {
  if (!form.value.order_id) return alert('请选择关联订单');
  if (!form.value.product_name) return alert('请填写产品/款号');
  const payload = {
    order_id: form.value.order_id,
    product_name: form.value.product_name,
    version: form.value.version,
    fabric_ids: form.value.fabric_ids.join(','),
    accessory_ids: form.value.accessory_ids.join(','),
    fabric_info: form.value.fabric_info,
    accessory_info: form.value.accessory_info,
    craft_info: form.value.craft_info,
    customer_req: form.value.customer_req,
    size_spec: form.value.size_spec,
    remark: form.value.remark
  };
  saving.value = true;
  try {
    if (form.value.id) await api.updateTechpack(form.value.id, payload);
    else await api.createTechpack(payload);
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function advance(r) {
  const idx = STAGES.findIndex((s) => s.key === (r.stage || 'draft'));
  if (idx < 0 || idx >= STAGES.length - 1) return;
  const next = STAGES[idx + 1];
  try { await api.techpackStage(r.id, next.key); await load(); }
  catch (e) { alert(e.message); }
}

onMounted(async () => {
  if (route.query.view === 'kanban') view.value = 'kanban';
  try { await loadRefs(); } catch (e) { /* ignore */ }
  await load();
});
</script>
