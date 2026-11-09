<template><details class="pre-material-details" open><summary>物料详情 · {{editor.materials.length}} 项 <small>面料 / 辅料</small></summary><div class="sales-entry pre-material-editor"><SalesOrderMaterials :item="editor" :index="0" :readonly="disabled" hide-crafts @uploading="$emit('uploading',$event)" /></div><p v-if="legacy.length" class="sub">历史物料名称：{{legacy.join('、')}}。请从档案选择对应物料补全明细。</p></details></template>
<script setup>
import {reactive,watch,computed} from 'vue';
import SalesOrderMaterials from './SalesOrderMaterials.vue';
import {preOrderMatrixForSales} from '../utils/preOrderMatrixTransfer';
import '../assets/sales-order-entry.css';
const props=defineProps({item:Object,disabled:Boolean});defineEmits(['uploading']);
const editor=reactive({materials:[],material_groups:[],colors:[],color_images:{},crafts:[]});
const legacy=computed(()=>props.item.matrix_meta?.materials||[]);
watch(()=>props.item,item=>{editor.materials=JSON.parse(JSON.stringify(item.matrix_meta?.material_details||[]));editor.material_groups=JSON.parse(JSON.stringify(item.matrix_meta?.material_groups||[]));},{immediate:true});
watch(()=>[props.item.size_prices,props.item.matrix_meta?.colors,props.item.matrix_meta?.sizes,props.item.matrix_meta?.color_images],()=>{const axes=preOrderMatrixForSales(props.item);editor.colors=axes.colors;editor.color_images=axes.color_images;},{immediate:true,deep:true});
watch(()=>[editor.materials,editor.material_groups],()=>{props.item.matrix_meta={colors:[],sizes:[],color_images:{},split_price:false,...props.item.matrix_meta,material_details:editor.materials,material_groups:editor.material_groups};},{deep:true});
</script>
<style scoped>
.pre-material-details{border:1px solid var(--line);border-radius:4px;margin-top:16px}.pre-material-details>summary{padding:14px;background:var(--surface-2);cursor:pointer;font-weight:600}.pre-material-details small{font-weight:400;color:var(--ink-mute);margin-left:12px}.sales-entry.pre-material-editor{position:static;inset:auto;display:block;z-index:auto;padding:12px;background:var(--surface);min-width:0}.pre-material-editor :deep(.material-table){min-width:1200px}.pre-material-editor :deep(.entry-dialog-mask),.pre-material-editor :deep(.picker-mask){z-index:1900}
</style>
