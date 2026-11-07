<template>
  <div class="craft-catalog-picker">
    <div class="catalog-select">
      <input v-model="query" class="input" placeholder="搜索工序名称" :disabled="disabled" aria-label="搜索工序档案" />
      <select v-model.number="selectedId" class="select" :disabled="disabled" aria-label="选择工序档案">
        <option :value="0">从工序类别选择</option>
        <option v-for="item in filtered" :key="item.id" :value="item.id">{{ categoryLabel(item.category) }} · {{ item.name }}</option>
      </select>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled || !selectedId" @click="addSelected()">加入本款</button>
      <button v-if="canCreate" type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="creating = !creating">＋ 新建工序并加入</button>
      <button type="button" class="link-btn" :disabled="disabled || busy" @click="load()">刷新</button>
    </div>
    <div v-if="creating" class="catalog-create">
      <div class="form-grid">
        <div class="fitem"><label>工序名称 <span style="color:#dc2626">*</span></label><input v-model="draft.name" maxlength="60" class="input" :disabled="busy || disabled" /></div>
        <div class="fitem"><label>类别</label><select v-model="draft.category" class="select" :disabled="busy || disabled"><option v-for="(label,key) in categories" :key="key" :value="key">{{ label }}</option></select></div>
        <div class="fitem"><label>单位</label><input v-model="draft.unit" maxlength="16" class="input" :disabled="busy || disabled" /></div>
        <div class="fitem"><label>默认单价</label><input v-model.number="draft.default_price" class="input" type="number" min="0" step="0.01" :disabled="busy || disabled" /></div>
        <div class="fitem"><label>说明</label><input v-model="draft.remark" maxlength="120" class="input" :disabled="busy || disabled" /></div>
      </div>
      <p class="catalog-hint">保存到工序类别档案，并加入当前样版；当前样版还需点击保存。其他款式不会自动添加。</p>
      <button type="button" class="btn btn-primary btn-sm" :disabled="busy || disabled" @click="create()">{{ busy ? '保存中…' : '保存到档案并加入本款' }}</button>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="creating = false">取消</button>
    </div>
    <p v-if="error" class="catalog-error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
const props = defineProps({ disabled: Boolean, category: { type: String, default: 'sewing' } });
const emit = defineEmits(['selected']);
const categories = { sewing:'车缝',print:'印花',embroidery:'绣花',wash:'洗水',finish:'后整',pack:'包装',other:'其他' };
const categoryLabel = key => categories[key] || key;
const query = ref(''), selectedId = ref(0), items = ref([]), creating = ref(false), busy = ref(false), error = ref('');
const canCreate = computed(() => can('development.write') || can('craft.write'));
const blank = () => ({ name:'',category:props.category,unit:'件',default_price:0,remark:'' });
const draft = ref(blank());
const filtered = computed(() => items.value.filter(item => item.name.toLowerCase().includes(query.value.trim().toLowerCase())));
async function load() { error.value=''; try { items.value=await api.craftTypes({status:'active'}); } catch(e) { error.value=e.message; } }
function addSelected() { if(props.disabled)return;const item=items.value.find(item => item.id===selectedId.value);if(item)emit('selected',item); }
async function create() {
  if(props.disabled || busy.value)return;
  if(!draft.value.name.trim()){error.value='请填写工序名称';return;}
  busy.value=true;error.value='';
  try {const item=await api.createCraftType({...draft.value,name:draft.value.name.trim()});await load();emit('selected',item);creating.value=false;draft.value=blank();}
  catch(e){error.value=e.message;}finally{busy.value=false;}
}
onMounted(load);
</script>
<style scoped>
.craft-catalog-picker { width:100%; }
.catalog-select { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:8px 0; }
.catalog-select > .input { width:160px; }.catalog-select > .select { min-width:180px; width:auto; max-width:100%; }
.catalog-create { border:1px solid var(--line); border-radius:8px; padding:12px; margin:8px 0; }
.catalog-hint { font-size:12px; margin:10px 0; color:var(--ink-soft); }.catalog-error { color:#dc2626; font-size:12px; }
</style>
