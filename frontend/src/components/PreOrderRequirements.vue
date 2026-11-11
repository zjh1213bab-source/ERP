<template>
  <BusinessRequirement :model-value="meta.business_requirement" :disabled="disabled" @update:model-value="set('business_requirement',$event)"/>
  <details class="pre-craft-fold" open><summary>工艺选择与要求</summary><div class="pre-requirements" :inert="disabled">
    <div class="requirement-axis"><label>工艺选择</label><OrderAxisSelect :model-value="meta.crafts||[]" :options="craftOptions" :sort-names="sortNames" label="工艺" kind="crafts" :max="100" @update:model-value="set('crafts',$event)" /></div>
    <label class="requirement-note">工艺要求<input :value="meta.craft_note||''" :disabled="disabled" maxlength="2000" placeholder="填写本款工艺、部位及其他要求" @input="set('craft_note',$event.target.value)" /></label>
    <span v-if="loading" class="sub">档案加载中…</span><p v-if="error" role="alert">{{error}} <button type="button" @click="load(true)">重新加载</button></p>
  </div></details>
</template>
<script>
let catalogRequest;
</script>
<script setup>
import {computed,ref,onMounted} from 'vue';
import {api} from '../api';
import BusinessRequirement from './BusinessRequirement.vue';
import OrderAxisSelect from './OrderAxisSelect.vue';
const props=defineProps({item:{type:Object,required:true},disabled:Boolean});
const meta=computed(()=>props.item.matrix_meta||{}),materialOptions=ref([]),craftOptions=ref([]),error=ref(''),loading=ref(false);
const sortNames=values=>[...new Set(values)].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
function set(key,value){if(props.disabled)return;props.item.matrix_meta={colors:[],sizes:[],color_images:{},split_price:false,...meta.value,[key]:value};}
async function load(refresh=false){loading.value=true;error.value='';try{if(refresh||!catalogRequest)catalogRequest=Promise.all([api.materials({status:'active'}),api.craftTypes({status:'active'})]).catch(e=>{catalogRequest=null;throw e;});const [materials,crafts]=await catalogRequest;materialOptions.value=sortNames(materials.map(m=>[m.type==='fabric'?'面料':'辅料',m.code,m.name,m.spec].filter(Boolean).join(' · ')));craftOptions.value=sortNames(crafts.map(c=>c.name));}catch(e){error.value='档案加载失败：'+e.message;}finally{loading.value=false;}}
onMounted(()=>load());
</script>
<style scoped>
.pre-craft-fold{margin-bottom:16px;border:1px solid var(--line);border-radius:4px}.pre-craft-fold summary{padding:12px;background:var(--surface-2);cursor:pointer}.pre-craft-fold .pre-requirements{padding:12px;margin:0;border:0}

.requirement-axis :deep(.axis-trigger.chips){display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-height:38px;padding:5px 24px 5px 6px;border:1px solid var(--line);border-radius:4px;background:var(--surface);font-size:12px;color:var(--ink-soft)}.requirement-axis :deep(.chips>span){display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border:1px solid var(--line);padding:2px 4px;border-radius:3px;overflow-wrap:anywhere}.requirement-axis :deep(.chips>span>button){border:0;padding:0;background:var(--line);color:var(--ink-mute);border-radius:50%;width:14px;height:14px;line-height:12px;font-size:11px}.requirement-axis :deep(.axis-popover input),.requirement-axis :deep(.axis-popover button){border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:6px;border-radius:3px}.requirement-axis :deep(.axis-option-grid button.selected){border-color:var(--brand);color:var(--brand);background:var(--brand-soft)}
.pre-requirements{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:0 0 16px;margin-bottom:16px;border-bottom:1px solid var(--line)}.requirement-axis{display:flex;align-items:center;gap:8px;flex:1;min-width:280px}.requirement-axis>label{white-space:nowrap;font-size:13px}.requirement-axis :deep(.order-axis-select){flex:1}.requirement-note{display:flex;align-items:center;gap:8px;flex:1;min-width:300px;font-size:13px}.requirement-note input{flex:1;min-width:0;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:9px;border-radius:4px}.pre-requirements p{color:var(--danger);font-size:12px}
</style>
