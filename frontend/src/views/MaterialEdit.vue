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
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : (isEdit ? '保存修改' : '保存并新建') }}
        </button>
      </div>
    </div>

    <div class="edit-body">
      <!-- 左：图片 + 状态 -->
      <aside class="side">
        <section class="panel-card">
          <h3>物料图片</h3>
          <ImageUpload v-model="form.image_url" size="lg" />
          <p class="tip">单击选中后按 Ctrl+V 粘贴，或点右上角箭头选文件；点图可看大图。</p>
        </section>

        <section class="panel-card">
          <h3>档案状态</h3>
          <div class="kv"><span>类型</span><b>{{ form.type === 'fabric' ? '面料' : '辅料' }}</b></div>
          <div class="kv"><span>状态</span><b>{{ form.status === 'inactive' ? '已停用' : '启用中' }}</b></div>
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

            <div class="fitem"><label>颜色</label><input class="input" v-model="form.color" placeholder="如 藏青 / 彩色 / 2色" /></div>
            <div class="fitem"><label>色号</label><input class="input" v-model="form.color_no" placeholder="如 印花001-1 / 79 / CH0602858" /></div>
            <div class="fitem"><label>单位</label><input class="input" v-model="form.unit" placeholder="米 / 个 / 套" /></div>
            <div class="fitem"><label>成份</label><input class="input" v-model="form.composition" placeholder="如 80%棉 20%氨纶" /></div>

            <div class="fitem"><label>供应商</label><input class="input" v-model="form.supplier" placeholder="如 明发织造" /></div>
            <div class="fitem full">
              <label>供应商信息</label>
              <input class="input" v-model="form.supplier_info" placeholder="地址 / 联系人 / 电话" />
            </div>
          </div>
        </section>

        <section class="panel-card">
          <h3>规格与库存</h3>
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
          <p class="tip">档案里的名称 / 供应商 / 规格 / 成份在开发单里是只读的；要改只能回到这里改。</p>
        </section>
      </div>
    </div>

    <div class="foot-bar">
      <span class="foot-hint" v-if="!isEdit">新档案保存后会立刻出现在「面辅料档案」列表，开发单里就能勾选到。</span>
      <div class="foot-acts">
        <button class="btn btn-ghost" @click="back">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : (isEdit ? '保存修改' : '保存并新建') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import ImageUpload from '../components/ImageUpload.vue';

const route = useRoute();
const router = useRouter();

const isEdit = computed(() => !!route.params.id);
const saving = ref(false);
const baseName = ref('');

function blank() {
  return {
    id: null, type: 'fabric', name: '', code: '', short_name: '', supplier: '', supplier_info: '',
    color: '', color_no: '', unit: '米', width: '', weight: '', air_gap: '', composition: '',
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
  } catch (e) { alert(e.message); }
});

function back() { router.push('/materials'); }

async function save() {
  if (!form.value.name || !form.value.name.trim()) return alert('物料名称必填');
  saving.value = true;
  try {
    const payload = { ...form.value };
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
  font-size: 12.5px; color: #2b6de5; cursor: pointer;
}
.crumb:hover { text-decoration: underline; }
.head-acts, .foot-acts { display: flex; gap: 10px; }
.edit-body { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; align-items: start; }
.side { display: flex; flex-direction: column; gap: 14px; }
.main { display: flex; flex-direction: column; gap: 14px; }
.panel-card h3 { margin: 0 0 12px; font-size: 13.5px; color: #16233b; }
.panel-card { padding: 16px 18px; }
.kv { display: flex; justify-content: space-between; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed #eef2f7; }
.kv:last-of-type { border-bottom: none; }
.kv span { color: #8a94a6; }
.kv b { color: #16233b; font-weight: 600; }
.req { color: #e5484d; }
.panel-card textarea {
  width: 100%; padding: 9px 11px; border: 1px solid #dfe5ef; border-radius: 8px;
  font-family: inherit; font-size: 13.5px; resize: vertical; color: #16233b;
}
.panel-card textarea:focus { outline: none; border-color: #2b6de5; }
.tip { font-size: 11.5px; color: #8a94a6; line-height: 1.6; margin: 8px 0 0; }
.foot-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 14px; padding: 12px 18px; background: #fff;
  border: 1px solid #e6ebf3; border-radius: 14px;
}
.foot-hint { font-size: 12px; color: #8a94a6; }
@media (max-width: 980px) {
  .edit-body { grid-template-columns: 1fr; }
}
</style>
