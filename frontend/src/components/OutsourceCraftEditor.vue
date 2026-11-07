<template>
 <div class="outsource-editor">
  <div class="outsource-toolbar"><a href="/craft-types" target="_blank" rel="noopener">工艺档案（新增/编辑/停用） ↗</a><a href="/factories" target="_blank" rel="noopener">工艺厂档案 ↗</a><button class="btn btn-ghost btn-sm" @click="load()">刷新档案</button></div>
  <p v-if="error" class="outsource-error">{{error}}</p>
  <section v-for="phase in phases" :key="phase.key" class="outsource-phase">
   <header><b>{{phase.label}}</b><span>预计费用合计：¥{{total(phase.key).toFixed(2)}}</span></header>
   <fieldset :disabled="readonly||uploading>0"><div class="outsource-scroll"><table class="data"><thead><tr><th>序号</th><th>款色 *</th><th>图片</th><th>工艺名称（档案）*</th><th>工艺厂</th><th>电话 / 地址</th><th>数量</th><th>工艺单价（元）</th><th>预计费用</th><th>备注</th><th>操作</th></tr></thead><tbody>
    <tr v-for="(row,index) in phaseRows(phase.key)" :key="row.key"><td>{{index+1}}</td><td><input v-model.trim="row.color" :list="'outsource-colors-'+uid" maxlength="100" placeholder="选择或填写款色" /></td><td><ImageUpload v-model="row.image_url" :disabled="readonly" @uploading="trackUpload" /></td><td><select v-model.number="row.craft_type_id" @change="fillCraft(row)"><option :value="null">选择工艺档案</option><option v-if="row.craft_type_id&&!crafts.some(c=>c.id===row.craft_type_id)" :value="row.craft_type_id">{{row.name}}（原档案已停用）</option><option v-for="c in crafts" :key="c.id" :value="c.id">{{c.name}}</option></select></td><td><select v-model.number="row.factory_id" @change="fillFactory(row)"><option :value="null">暂未分配</option><option v-if="row.factory_id&&!factories.some(f=>f.id===row.factory_id)" :value="row.factory_id">{{row.factory_name}}（原档案已停用）</option><option v-for="f in factories" :key="f.id" :value="f.id">{{f.name}}</option></select></td><td>{{row.phone||'—'}}<small>{{row.address||'—'}}</small></td><td><input v-model.number="row.qty" type="number" min="0" max="10000000" step="0.001" /></td><td><input v-model.number="row.price" type="number" min="0" max="10000000" step="0.01" /></td><td>¥{{amount(row).toFixed(2)}}</td><td><textarea v-model="row.remark" maxlength="2000" rows="2" /></td><td><button type="button" class="link-btn" @click="copy(row)">复制到其他颜色</button><button type="button" class="link-btn danger" @click="remove(row)">删除</button></td></tr>
    <tr v-if="!phaseRows(phase.key).length"><td colspan="11" class="empty-cell">暂无{{phase.label}}，请从工艺档案添加</td></tr>
   </tbody></table></div><button v-if="!readonly" type="button" class="outsource-add" @click="add(phase.key)">＋ 添加工艺</button></fieldset>
  </section>
  <datalist :id="'outsource-colors-'+uid"><option v-for="color in colors" :key="color" :value="color" /></datalist>
 </div>
</template>
<script setup>
import {ref,onMounted} from 'vue';import {api} from '../api';import {entryId} from '../utils/orderEntry';import ImageUpload from './ImageUpload.vue';
const props=defineProps({modelValue:{type:Array,default:()=>[]},colors:{type:Array,default:()=>[]},readonly:Boolean});const emit=defineEmits(['update:modelValue','uploading']);
const uid=entryId(),crafts=ref([]),factories=ref([]),error=ref(''),uploading=ref(0),phases=[{key:'fabric',label:'面料工艺'},{key:'cut',label:'裁后工艺'}];
const phaseRows=phase=>props.modelValue.filter(r=>r.phase===phase),amount=r=>Math.round((Number(r.qty||0)*Number(r.price||0)+Number.EPSILON)*100)/100,total=phase=>phaseRows(phase).reduce((s,r)=>s+amount(r),0);
function trackUpload(active){const previous=uploading.value;uploading.value=Math.max(0,previous+(active?1:-1));if(!previous&&uploading.value)emit('uploading',true);if(previous&&!uploading.value)emit('uploading',false);}
async function load(){error.value='';const results=await Promise.allSettled([api.craftTypes({status:'active'}),api.factories({status:'active'})]);if(results[0].status==='fulfilled')crafts.value=results[0].value;else error.value='工艺档案读取失败：'+results[0].reason.message;if(results[1].status==='fulfilled')factories.value=results[1].value;else error.value+=' 工艺厂档案读取失败：'+results[1].reason.message;}
function add(phase){if(props.modelValue.length>=200)return alert('最多200条工艺');emit('update:modelValue',[...props.modelValue,{key:entryId(),phase,color:props.colors.length===1?props.colors[0]:'',craft_type_id:null,factory_id:null,name:'',qty:0,price:0,image_url:'',remark:''}]);}
function fillCraft(row){const craft=crafts.value.find(c=>c.id===row.craft_type_id);if(craft){row.name=craft.name;row.price=Number(craft.default_price||0);}}
function fillFactory(row){const factory=factories.value.find(f=>f.id===row.factory_id);Object.assign(row,{factory_name:factory?.name||'',phone:factory?.phone||'',address:factory?.address||''});}
function remove(row){emit('update:modelValue',props.modelValue.filter(r=>r.key!==row.key));}
function copy(row){if(props.modelValue.length>=200)return;emit('update:modelValue',[...props.modelValue,{...JSON.parse(JSON.stringify(row)),key:entryId(),color:''}]);}
onMounted(load);
</script>
<style scoped>
.outsource-toolbar{display:flex;gap:18px;align-items:center;margin:12px 0;font-size:12px}.outsource-phase{border:1px solid var(--line);margin:18px 0;background:var(--surface)}.outsource-phase header{display:flex;gap:18px;padding:10px;background:var(--surface-2);font-size:13px}.outsource-phase fieldset{border:0;min-width:0;padding:0;margin:0}.outsource-scroll{overflow:auto}.outsource-scroll table{min-width:1400px}.outsource-scroll input,.outsource-scroll select,.outsource-scroll textarea{width:100%;min-width:85px;max-width:200px;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:7px;border-radius:4px;font:inherit}.outsource-scroll small{display:block;max-width:180px;white-space:normal;color:var(--ink-mute)}.outsource-add{width:100%;padding:10px;border:0;border-top:1px dashed var(--line);color:var(--brand);background:var(--surface-2);cursor:pointer}.outsource-error{color:var(--danger)}
</style>
