<template><div class="sales-entry development-materials"><SalesOrderMaterials ref="editor" :item="item" :index="0" :readonly="readonly" hide-crafts /></div></template>
<script setup>
// 复用销售下单编辑器；仅在保存时转换协议，避免两套物料交互逐渐分叉。
import {reactive,ref,watch} from 'vue';
import SalesOrderMaterials from './SalesOrderMaterials.vue';
import {entryId} from '../utils/orderEntry';
import '../assets/sales-order-entry.css';
const props=defineProps({rows:Array,colors:String,readonly:Boolean});
const editor=ref(null),item=reactive({materials:[],material_groups:[],colors:[],color_images:{},crafts:[]});
watch(()=>props.rows,rows=>{
 item.material_groups=[];
 const seen=new Set();
 item.materials=(rows||[]).filter(row=>{let key;try{key=JSON.parse(row.entry_json||'{}').editor_material_key;}catch{}if(!key)return true;if(seen.has(key))return false;seen.add(key);return true;}).map(row=>{
  let saved={};try{saved=JSON.parse(row.entry_json||'{}');}catch{}
  return {...saved,key:entryId(),id:row.id,material_id:row.material_id,type:row.mat_type,role:row.mat_type==='accessory'?'辅料':'主料',name:row.material_name,unit:row.unit,width:saved.width||'',weight:saved.weight||'',spec:row.spec_info||'',supplier:row.supplier||'',ingredient:row.composition||'',one_use:row.one_use,price:saved.base_price??row.unit_price,loss:row.loss_rate,air_gap:row.air_gap||100,usage_part:row.use_part||'',remark:row.remark||'',order_image_url:saved.order_image_url??row.image_url??'',colors:saved.colors|| (row.colorway?[{colorway:row.colorway,color_no:row.color_no||'',price:row.unit_price,image_url:row.color_card_url||''}]:[])};
 });
 const colors=[...new Set([...(props.colors||'').split(/[,，/、\n]/).map(c=>c.trim()).filter(Boolean),...item.materials.flatMap(m=>m.colors.map(c=>c.colorway))])];
 item.colors=(colors.length?colors:['通配']).map(color=>({color,sizes:[{size:'通配',qty:1}]}));
},{immediate:true});
function serialize(){return item.materials.flatMap(m=>{
 const data=JSON.stringify({editor_material_key:m.key,shared_color:m.shared_color,shared_config:m.shared_config,usage_group_id:m.usage_group_id,colors_configured:m.colors_configured,colors:m.colors,order_image_url:m.order_image_url,width:m.width,weight:m.weight,base_price:m.price});
 const colors=m.colors.length?m.colors:[{colorway:'',price:m.colors_configured?0:m.price}];
 return colors.map(c=>({id:m.id,material_id:m.material_id,mat_type:m.type,material_name:m.name,unit:m.unit,composition:m.ingredient,supplier:m.supplier,spec_info:m.spec,one_use:m.one_use,unit_price:c.price??m.price,loss_rate:m.loss,air_gap:m.air_gap,use_part:m.usage_part,remark:m.remark,image_url:m.order_image_url,color_card_url:c.image_url||'',colorway:c.colorway,color_no:c.color_no||'',entry_json:data}));
});}

defineExpose({serialize,busy:()=>!!editor.value?.busy()});
</script>
<style scoped>
.sales-entry.development-materials{position:static;inset:auto;z-index:auto;display:block;min-width:0}.development-materials :deep(.entry-dialog-mask){z-index:1800}.development-materials :deep(.material-table){min-width:1150px}
</style>
