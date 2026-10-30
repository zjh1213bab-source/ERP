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
          <div class="dev-img">
            <img v-if="r.image_url" :src="r.image_url" style="width: 100%; height: 100%; object-fit: cover" />
            <span v-else>👕</span>
          </div>
          <div class="dev-body">
            <div class="dev-name" :title="r.product_name">{{ r.product_name }}</div>
            <div class="dev-sub">{{ r.order_no || '-' }}</div>
            <div class="dev-sub">{{ r.customer_name || '-' }} · {{ r.version }}</div>
            <div style="margin: 8px 0">
              <span class="tag" :class="stageTag(r.stage)">{{ stageLabel(r.stage) }}</span>
            </div>
            <div class="dev-acts">
              <button class="link-btn" @click="openDetail(r)">详情</button>
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
              <button class="link-btn" @click="openDetail(r)">详情</button>
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
              <label>款图 / 色卡</label>
              <div style="display: flex; gap: 12px; align-items: center">
                <div style="width: 80px; height: 80px; border: 1px solid #eef2f7; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fafcff">
                  <img v-if="form.image_url" :src="form.image_url" style="width: 100%; height: 100%; object-fit: cover" />
                  <span v-else style="font-size: 11px; color: #8a94a6">无</span>
                </div>
                <label class="btn btn-ghost btn-sm" style="cursor: pointer">
                  上传<input type="file" accept="image/*" style="display: none" @change="onImage" />
                </label>
              </div>
            </div>
            <!--
              面料/辅料不再平铺成几十个复选框（档案一多就找不到东西、也看不出选过哪些），
              改成"已选标签 + 弹窗选择"：弹窗里可按名称/简称/供应商/类型筛选，表格多选。
            -->
            <div class="fitem full">
              <label>面料 *</label>
              <MaterialPickerField v-model="form.fabric_ids" type="fabric" />
              <input class="input" v-model="form.fabric_info" placeholder="面料补充说明（可空）" style="margin-top: 6px" />
            </div>
            <div class="fitem full">
              <label>辅料 *</label>
              <MaterialPickerField v-model="form.accessory_ids" type="accessory" />
              <input class="input" v-model="form.accessory_info" placeholder="辅料补充说明（可空）" style="margin-top: 6px" />
            </div>
            <!--
              工艺工序：一段说明 + 可展开的工序明细表
              「展开填写」里的表格与「订单工序」页是**同一份数据**（打版流程 craft 阶段），
              所以这里填完，去打版页能看到；打版页改了，这里再打开也是改后的。
            -->
            <div class="fitem full">
              <label>工艺工序 *</label>
              <textarea v-model="form.craft_info" rows="2" placeholder="工艺要点 / 特殊要求（可空）"></textarea>
              <div class="craft-bar">
                <button type="button" class="btn btn-ghost btn-sm" @click="toggleCrafts">
                  {{ craftsOpen ? '收起工序明细' : '展开填写工序明细' }}
                  <template v-if="craftCount">（{{ craftCount }} 道）</template>
                </button>
                <span v-if="!canCraft" class="craft-tip">工序与工价由技术岗填写，这里只读</span>
                <span v-else-if="craftsDirty && craftsOpen" class="craft-dirty">工序有改动，保存后生效</span>
                <!-- 定制订单确认前必须有车缝工序（后端 confirmBlocks 同一口径），提前在这里说 -->
                <span v-if="craftsOpen && !sewingCount" class="craft-miss">确认前需至少 1 道车缝工序</span>
              </div>
              <div v-if="craftsOpen" class="craft-wrap">
                <CraftEditor v-model="crafts" :disabled="!canCraft" @change="craftsDirty = true" />
              </div>
            </div>
            <div class="fitem full"><label>客户要求 *</label><textarea v-model="form.customer_req" rows="3" placeholder="尺码表 / 包装 / 标签 / 测试要求 / 交期"></textarea></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="form.remark" /></div>
          </div>
          <p style="font-size: 11.5px; color: #8a94a6; margin: 10px 0 0">带 * 为业务确认前必填项（定制订单，工序明细需至少 1 道车缝）。确认后锁定，需新建版本修改。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
    <!-- 开发详情（面辅料 / 成衣尺寸 / 生产要求） -->
    <TechPackDetail :techpack-id="detailId" @close="detailId = null" @saved="load" @version-created="onVersionCreated" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import TechPackDetail from '../components/TechPackDetail.vue';
import MaterialPickerField from '../components/MaterialPickerField.vue';
import CraftEditor from '../components/CraftEditor.vue';

const route = useRoute();

const list = ref([]);
const q = ref('');
const view = ref('card');
const tab = ref('all');
const orders = ref([]);
const detailId = ref(null);

const showModal = ref(false);
const crafts = ref({ sewing: [], finish: [] });
const craftsOpen = ref(false);
const craftsDirty = ref(false);
const craftsLoadedFor = ref(null);
const saving = ref(false);
const form = ref(blank());

const canWrite = computed(() => can('development.write'));
/** 工序/工价是技术岗的活：与打版页 craft 阶段、接口 requireRole(['admin','tech']) 同一口径 */
const canCraft = computed(() => can('craft.write'));
const craftCount = computed(() => (crafts.value.sewing || []).length + (crafts.value.finish || []).length);
/** 车缝道数：后端确认校验要求 ≥1（只看有名称的行，与 normCraftRows 的过滤一致） */
const sewingCount = computed(() => (crafts.value.sewing || []).filter((r) => String(r.name || '').trim()).length);
const canReview = computed(() => can('development.review'));

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
  return { id: null, order_id: null, product_name: '', version: 'V1', fabric_ids: [], accessory_ids: [], fabric_info: '', accessory_info: '', craft_info: '', customer_req: '', size_spec: '', image_url: '', remark: '' };
}

async function load() {
  try { list.value = await api.techpacksAll({ q: q.value }); }
  catch (e) { alert(e.message); }
}
async function loadRefs() {
  // 物料档案不再在这里预载：选择器自己按需取（还要按类型分、按搜索词过服务端），
  // 页面进来就拉全量档案只是浪费一次请求
  orders.value = await api.orders({});
}

/**
 * 工序明细：展开时才去取（新建的开发单还没有 id，必然是空表）
 *
 * 为什么不打开弹窗就拉：工序表只在用户点「展开填写」时才有意义；
 * 每次都拉一遍等于给列表翻页加一次多余请求。
 */
async function toggleCrafts() {
  if (craftsOpen.value) { craftsOpen.value = false; return; }
  craftsOpen.value = true;
  await loadCrafts(form.value.id);
}

async function loadCrafts(id) {
  if (!id) { crafts.value = { sewing: [], finish: [] }; craftsLoadedFor.value = 'new'; return; }
  if (craftsLoadedFor.value === id) return;
  try {
    const d = await api.techpackCrafts(id);
    crafts.value = { sewing: d.sewing || [], finish: d.finish || [] };
    craftsLoadedFor.value = id;
  } catch (e) {
    crafts.value = { sewing: [], finish: [] };
    craftsLoadedFor.value = id;
    alert('工序明细读取失败：' + e.message);
  }
}

/** 打开弹窗时重置工序状态：换了一条单子，不能把上一条的工序带过去 */
function resetCrafts() {
  crafts.value = { sewing: [], finish: [] };
  craftsOpen.value = false;
  craftsDirty.value = false;
  craftsLoadedFor.value = null;
}

function openCreate() { form.value = blank(); resetCrafts(); showModal.value = true; }
function openDetail(r) { detailId.value = r.id; }
function onVersionCreated(id) { detailId.value = id; load(); }
function openEdit(r) {
  form.value = {
    ...r,
    fabric_ids: r.fabric_ids ? String(r.fabric_ids).split(',').filter(Boolean).map(Number) : [],
    accessory_ids: r.accessory_ids ? String(r.accessory_ids).split(',').filter(Boolean).map(Number) : []
  };
  resetCrafts();
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
    image_url: form.value.image_url,
    remark: form.value.remark
  };
  saving.value = true;
  try {
    let tpId = form.value.id;
    if (tpId) {
      await api.updateTechpack(tpId, payload);
    } else {
      // 新建时必须先拿到 id 才能写工序（工序挂在开发单的打版流程上）
      const created = await api.createTechpack(payload);
      tpId = created && created.id;
    }

    /**
     * 工序明细单独提交，且**只在展开过、且改过**的时候提交
     *
     * 两个原因：
     *   1. 没展开就没有加载，此时提交会把已有工序覆盖成空表；
     *   2. 工序写的是打版流程 craft 阶段的那份数据 —— 没改就别碰，
     *      免得把技术岗刚在打版页填的工价盖掉。
     * 失败时开发单已经保存了，必须说清楚"哪一半成功了"，否则用户会以为全丢了。
     */
    if (craftsOpen.value && craftsDirty.value && tpId && canCraft.value) {
      try {
        const out = await api.saveTechpackCrafts(tpId, crafts.value);
        crafts.value = { sewing: out.sewing || [], finish: out.finish || [] };
        craftsDirty.value = false;
      } catch (e) {
        alert('开发单已保存，但工序明细没保存成功：' + e.message + '\n（可稍后在「打版流程 → 工艺/工序明细」里补填）');
      }
    }

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

async function onImage(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { alert('图片不能超过 3MB'); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const up = await api.upload(reader.result);
      form.value.image_url = up.url;
    } catch (err) { alert(err.message); }
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}

onMounted(async () => {
  if (route.query.view === 'kanban') view.value = 'kanban';
  try { await loadRefs(); } catch (e) { /* ignore */ }
  await load();
});
</script>

<style scoped>
/* 工艺工序：说明 + 可展开的明细表 */
.craft-bar { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.craft-tip { font-size: 11.5px; color: #8a94a6; }
.craft-dirty { font-size: 11.5px; color: #d46b08; }
/* 缺车缝工序时的提醒（后端确认校验的同一口径） */
.craft-miss { font-size: 11.5px; color: #c0392b; }
.craft-wrap { margin-top: 8px; padding: 8px; border: 1px dashed #d9e2ef; border-radius: 10px; background: #fbfcff; }
</style>
