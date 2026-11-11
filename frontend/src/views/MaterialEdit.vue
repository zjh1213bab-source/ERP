<template>
  <div class="matedit">
    <div class="page-head">
      <div>
        <button class="crumb" type="button" @click="back">← 返回面辅料档案</button>
        <h2>{{ isEdit ? '编辑物料档案' : '新增物料档案' }}</h2>
        <div class="sub">
          {{ isEdit
            ? `${form.code || '—'} · ${form.name || '未命名'} · 改动只影响之后新建的单子，已确认的工艺单保持原样`
            : (baseName ? `已从「${baseName}」带出资料，改完保存就是一条新档案` : '填写资料后保存；同类物料建议先「从档案选择」带出再改，省得重复录入') }}
        </div>
      </div>
      <div class="head-acts">
        <button class="btn btn-ghost" @click="back">取消</button>
        <button v-action="['materials',isEdit?'edit':'create']" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : (isEdit ? '保存修改' : '保存并新建') }}
        </button>
      </div>
    </div>

    <div class="edit-body">
      <!-- 左：图片 + 状态 -->
      <aside class="side">
        <section class="panel-card">
          <h3>色卡本封面照片</h3>
          <ImageUpload v-model="form.image_url" size="lg" />
          <p class="tip">此处仅保存色卡本封面。具体物料照片在业务下单时上传，仅用于该订单，不同步到档案。支持 Ctrl+V 粘贴，点图可放大。</p>
        </section>

        <section class="panel-card">
          <h3>档案状态</h3>
          <div class="kv"><span>类型</span><b>{{ form.type === 'fabric' ? '面料' : '辅料' }}</b></div>
          <div class="kv"><span>状态</span><b>{{ form.status === 'disabled' ? '已停用' : '启用中' }}</b></div>
          <div class="kv" v-if="isEdit"><span>档案编号</span><b>#{{ form.id }}</b></div>
          <p class="tip">停用后开发单选不到这条，但已引用它的历史单据不受影响。</p>
        </section>
      </aside>

      <!-- 右：字段 -->
      <div class="main">
        <section class="panel-card">
          <h3>基本信息</h3>
          <div class="form-grid">
            <div class="fitem">
              <label>类型 <span class="req">*</span></label>
              <select class="select" v-model="form.type">
                <option value="fabric">面料</option>
                <option value="accessory">辅料</option>
              </select>
            </div>
            <div class="fitem">
              <label>物料名称 <span class="req">*</span></label>
              <input class="input" v-model="form.name" placeholder="如 220G棉拉印花 通配" />
            </div>
            <div class="fitem"><label>物料编号</label><input class="input" v-model="form.code" placeholder="如 2099" /></div>
            <div class="fitem"><label>简称</label><input class="input" v-model="form.short_name" placeholder="如 2099" /></div>
            <div class="fitem"><label>档案单价（元/单位）</label><input class="input" type="number" min="0" step="0.01" v-model.number="form.unit_price" /></div>
            <div class="fitem"><label>单位</label><input class="input" v-model="form.unit" placeholder="米 / 个 / 套" /></div>
            <div class="fitem"><label>成份</label><input class="input" v-model="form.composition" placeholder="如 80%棉 20%氨纶" /></div>

            <div class="fitem full"><label>供应商档案</label>
              <select class="select" v-model.number="form.supplier_id" @change="selectSupplier()">
                <option :value="null">— 暂不指定 —</option>
                <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}{{ s.code ? ' · '+s.code : '' }}</option>
              </select>
              <div><button class="link-btn" type="button" @click="newSupplier()">＋ 新页面新增供应商</button><button class="link-btn" type="button" @click="loadSuppliers()">刷新供应商</button></div>
            </div>
          </div>
        </section>

        <section class="panel-card">
          <h3>规格与库存</h3>
          <div v-if="isEdit" class="fitem"><label>规格修改原因 <span class="req" v-if="specChanged">*</span></label><input class="input" v-model="changeReason" maxlength="500" placeholder="修改幅宽、克重、空差或规格说明时必填" /></div>
          <div class="form-grid">
            <div class="fitem"><label>幅宽</label><input class="input" v-model="form.width" placeholder="如 160cm" /></div>
            <div class="fitem"><label>克重</label><input class="input" v-model="form.weight" placeholder="如 220g" /></div>
            <div class="fitem"><label>空差</label><input class="input" v-model="form.air_gap" placeholder="如 100%" /></div>
            <div class="fitem"><label>库存数</label><input class="input" type="number" v-model.number="form.stock_qty" /></div>
            <div class="fitem full"><label>规格说明</label><input class="input" v-model="form.spec" placeholder="补充说明（如 四面弹 / 双面绒），没有可空" /></div>
            <div class="fitem full"><label>库存明细</label><input class="input" v-model="form.stock_detail" placeholder="如 A仓 1200米 / 待检 300米" /></div>
          </div>
        </section>

        <section class="panel-card">
          <h3>备注</h3>
          <textarea class="input" rows="3" v-model="form.remark" placeholder="其他需要说明的，比如客户指定、检验要求等"></textarea>
          <p class="tip">色号在业务单据填写，单价从本档案取值；规格只能在本档案修改并留痕；业务单据的成分编辑不影响档案。</p>
        </section>
        <section v-if="isEdit" class="panel-card">
          <h3>档案修改记录</h3>
          <p v-if="!history.length" class="tip">暂无修改记录（历史档案从本次升级后开始记录）</p>
          <div v-for="record in history" :key="record.id" class="history-row">
            <strong>V{{ record.version }} · {{ record.operator_name || '系统' }} · {{ $fmt(record.created_at) }}</strong>
            <p>{{ record.reason || '档案资料维护' }}</p><p class="tip">{{ changesOf(record) }}</p>
          </div>
        </section>
      </div>
    </div>

    <div class="foot-bar">
      <span class="foot-hint" v-if="!isEdit">新档案保存后会立刻出现在「面辅料档案」列表，开发单里就能勾选到。</span>
      <div class="foot-acts">
        <button class="btn btn-ghost" @click="back">取消</button>
        <button v-action="['materials',isEdit?'edit':'create']" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : (isEdit ? '保存修改' : '保存并新建') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import ImageUpload from '../components/ImageUpload.vue';

const route = useRoute();
const router = useRouter();

const isEdit = computed(() => !!route.params.id);
const saving = ref(false);
const baseName = ref('');
const suppliers = ref([]);
const history = ref([]);
const changeReason = ref('');
const originalSpec = ref('');
const specKeys = ['width','weight','air_gap','spec'];
const specSnapshot = value => JSON.stringify(specKeys.map(key => value[key] || ''));
const specChanged = computed(() => originalSpec.value !== specSnapshot(form.value));
async function loadSuppliers() {
  try {
    suppliers.value = await api.suppliers({ status: 'active' });
    if (!form.value.supplier_id && form.value.supplier) form.value.supplier_id = suppliers.value.find(s => s.name === form.value.supplier)?.id || null;
    if (form.value.supplier_id) selectSupplier();
  } catch (error) { alert(error.message); }
}
function selectSupplier() {
  const supplier = suppliers.value.find(s => s.id === form.value.supplier_id);
  form.value.supplier = supplier?.name || '';
  form.value.supplier_info = supplier ? [supplier.address, supplier.contact, supplier.phone].filter(Boolean).join(' / ') : '';
}
function newSupplier() { window.open(router.resolve({ path: '/suppliers', query: { create: '1' } }).href, '_blank', 'noopener'); }
const fieldLabels = { spec: '规格说明', width: '幅宽', weight: '克重', air_gap: '空差', name: '名称', composition: '成分', supplier: '供应商' };
function changesOf(record) {
  return Object.keys(fieldLabels).filter(key => String(record.before[key] || '') !== String(record.after[key] || ''))
    .map(key => `${fieldLabels[key]}：${record.before[key] || '—'} → ${record.after[key] || '—'}`).join('；') || '基础资料维护';
}


function blank() {
  return {
    id: null, version: 1, supplier_id: null, type: 'fabric', name: '', code: '', short_name: '', supplier: '', supplier_info: '',
    unit_price: 0, unit: '米', width: '', weight: '', air_gap: '', composition: '',
    spec: '', stock_qty: 0, stock_detail: '', image_url: '', remark: '', status: 'active'
  };
}
const form = ref(blank());

onMounted(async () => {
  try {
    if (isEdit.value) {
      const d = await api.material(route.params.id);
      form.value = { ...blank(), ...d };
    } else if (route.query.from) {
      // 从档案带一条出来当基础：保留资料，色号清空（同款换色最常见）
      const d = await api.material(route.query.from);
      baseName.value = d.name || '';
      form.value = { ...blank(), ...d, id: null, color_no: '', status: 'active' };
    }
    originalSpec.value = specSnapshot(form.value);
    await loadSuppliers();
    if (isEdit.value) history.value = await api.materialHistory(route.params.id);
    window.addEventListener('focus', loadSuppliers);
  } catch (e) { alert(e.message); }
});
onBeforeUnmount(() => window.removeEventListener('focus', loadSuppliers));

function back() { router.push('/materials'); }

async function save() {
  if (!form.value.name || !form.value.name.trim()) return alert('物料名称必填');
  saving.value = true;
  try {
    if (isEdit.value && specChanged.value && !changeReason.value.trim()) { saving.value = false; return alert('修改规格请填写原因'); }
    const payload = { ...form.value, change_reason: changeReason.value };
    delete payload.id;
    if (isEdit.value) await api.updateMaterial(route.params.id, payload);
    else await api.createMaterial(payload);
    router.push('/materials');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
</script>

<style scoped>
.crumb {
  border: none; background: none; padding: 0; margin-bottom: 4px;
  font-size: 12.5px; color: var(--brand); cursor: pointer;
}
.crumb:hover { text-decoration: underline; }
.head-acts, .foot-acts { display: flex; gap: 10px; }
.edit-body { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; align-items: start; }
.side { display: flex; flex-direction: column; gap: 14px; }
.main { display: flex; flex-direction: column; gap: 14px; }
.panel-card h3 { margin: 0 0 12px; font-size: 13.5px; color: var(--ink); }
.panel-card { padding: 16px 18px; }
.kv { display: flex; justify-content: space-between; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed var(--line); }
.kv:last-of-type { border-bottom: none; }
.kv span { color: var(--ink-mute); }
.kv b { color: var(--ink); font-weight: 600; }
.req { color: #e5484d; }
.panel-card textarea {
  width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
  font-family: inherit; font-size: 13.5px; resize: vertical; color: var(--ink);
}
.panel-card textarea:focus { outline: none; border-color: #2b6de5; }
.tip { font-size: 12px; color: var(--ink-mute); line-height: 1.6; margin: 8px 0 0; }
.foot-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 14px; padding: 12px 18px; background: var(--surface);
  border: 1px solid #e6ebf3; border-radius: 14px;
}
.foot-hint { font-size: 12px; color: var(--ink-mute); }
@media (max-width: 980px) {
  .edit-body { grid-template-columns: 1fr; }
}
</style>

<style scoped>.history-row { padding: 10px 0; border-bottom: 1px solid #e6ebf3; font-size: 12px; }.history-row p { margin: 6px 0; }</style>
