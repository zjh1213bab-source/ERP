<template>
  <div class="fitem full">
    <label>实际应用内容 *</label>
    <p v-if="error" class="form-msg err">{{error}}</p>
    <template v-if="type==='delivery'"><label>最新预计出厂日期（保留原承诺）</label><input class="input" type="date" :value="modelValue.new_date" @input="set('new_date',$event.target.value)" /></template>
    <template v-else>
      <select class="select" :value="modelValue.row_id || ''" @change="pick($event.target.value)">
        <option value="">请选择要变更的明细</option>
        <option v-for="row in rows" :key="row.id" :value="row.id">{{row.label}}</option>
      </select>
      <template v-if="modelValue.row_id">
        <label v-if="type==='material'">替换为物料档案（可选）<select class="select" :value="modelValue.material_id || ''" @change="set('material_id',Number($event.target.value)||null)"><option value="">保留当前物料</option><option v-for="m in materials.filter(m=>m.type===rows.find(r=>r.id==modelValue.row_id)?.type)" :key="m.id" :value="m.id">{{m.name}} · {{m.spec}}</option></select><small class="muted">规格、单位及供应商从档案带出，不能手改；本单修改不回写主档。</small></label>
        <label v-if="type==='qty'">变更后数量<input class="input" type="number" min="1" :value="modelValue.qty" @input="set('qty',Number($event.target.value))" /></label>
        <label v-if="type==='price'">变更后美元单价<input class="input" type="number" min="0" step="0.01" :value="modelValue.usd_price" @input="set('usd_price',Number($event.target.value))" /></label>
        <label v-for="field in textFields" :key="field.key">{{field.label}}<textarea rows="2" maxlength="4000" :value="modelValue[field.key]" @input="set(field.key,$event.target.value)"></textarea></label>
      </template>
    </template>
    <small class="muted">批准、客户确认及工位签收全部完成后才应用。数量/价格限分单前，应用后成本单需重新审核；已有交付的非交期变更须拆分剩余单。</small>
  </div>
</template>
<script setup>
import {ref,computed,watch} from 'vue';
import {api} from '../api';
const props=defineProps({orderId:[Number,String],type:String,modelValue:{type:Object,default:()=>({})}});
const emit=defineEmits(['update:modelValue']);
const rows=ref([]),materials=ref([]),error=ref('');let request=0;
const textFields=computed(()=>props.type==='craft'?[{key:'instruction',label:'执行工艺说明'},{key:'remark',label:'备注'}]:props.type==='material'?[{key:'ingredient',label:'本单成分'},{key:'mat_color',label:'本单颜色/色号'},{key:'remark',label:'备注'}]:[]);
function set(key,value){emit('update:modelValue',{...props.modelValue,[key]:value});}
function pick(id){const row=rows.value.find(r=>r.id===Number(id));if(!row){emit('update:modelValue',{});return;}const p={row_id:row.id};if(props.type==='qty')p.qty=row.qty;if(props.type==='price')p.usd_price=row.usd_price;for(const f of textFields.value)p[f.key]=row[f.key] || '';emit('update:modelValue',p);}
watch(()=>[props.orderId,props.type],async()=>{
 const sequence=++request;error.value='';rows.value=[];if(!props.orderId || props.type==='delivery')return;
 try{let list=[];
  if(['qty','price'].includes(props.type)){const o=await api.order(props.orderId);list=o.items.flatMap(i=>i.sizes.map(s=>({...s,label:`${i.product_name} · ${s.color} · ${s.size} · ${s.qty}件 / $${s.usd_price}`})));}
  else if(props.type==='craft')list=(await api.crafts(props.orderId)).map(r=>({...r,label:r.name}));
  else {list=(await api.orderMaterials(props.orderId)).map(r=>({...r,label:r.name}));materials.value=await api.materials({status:'active'});}
  if(sequence===request)rows.value=list;
 }catch(e){if(sequence===request)error.value=e.message;}
},{immediate:true});
</script>
