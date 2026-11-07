<template>
 <div class="report-wage">
  <label>计件款式 / 颜色<select class="select" v-model="choice" @change="select"><option v-if="!choice" value="">请选择款式及颜色</option><option v-for="v in variants" :key="key(v)" :value="key(v)">{{v.style_no||v.product_name}} · {{v.color||'未填颜色'}} · {{v.color_qty}} 件</option></select></label>
  <button type="button" class="link-btn" :disabled="loading" @click="load(choice?JSON.parse(choice):null)">刷新工价</button>
  <p v-if="loading" class="sub">读取计件工价…</p><p v-else-if="error" class="form-msg err">{{error}}</p>
  <div v-else-if="quote&&!quote.requires_selection" class="quote-line"><strong>{{quote.unit_price===null?'基础工价待维护':fmt(quote.unit_price)+' 元/件'}}</strong><span class="sub">基础价 {{quote.base_unit_price===null?'—':fmt(quote.base_unit_price)}} × 倍率 {{quote.multiplier}} · 同款同色 {{quote.color_qty}} 件</span><span v-if="quote.participation_reason" class="sub">{{quote.process_category_label}} · {{quote.participation_reason}}</span></div>
  <p v-else class="sub">请选择款色后读取对应工价；报价按该颜色总件数，不按本次报工数量。</p>
 </div>
</template>
<script setup>
import {ref,watch} from 'vue';
import {api} from '../api';
const props=defineProps({nodeId:[Number,String],bundleNo:String,reportDate:String,selfService:Boolean});
const emit=defineEmits(['change']);const variants=ref([]),choice=ref(''),quote=ref(null),loading=ref(false),error=ref('');let sequence=0;
const key=v=>JSON.stringify([v.item_id,v.color]);const fmt=n=>Number(n).toFixed(6).replace(/\.?0+$/,'');
async function load(selected){const seq=++sequence;loading.value=true;error.value='';emit('change',null);try{
 const d=await (props.selfService?api.selfWorkQuote:api.reportWageQuote)({node_id:props.nodeId,bundle_no:props.bundleNo||'',report_date:props.reportDate||'',...(selected?{item_id:selected[0],color:selected[1]}:{})});if(seq!==sequence)return;
 quote.value=d;variants.value=d.variants||[];choice.value=d.requires_selection?'':key(d);if(!d.requires_selection)emit('change',{item_id:d.item_id,color:d.color,wage_config_revision:d.config_revision});
 }catch(e){if(seq===sequence){error.value=e.message;quote.value=null;}}finally{if(seq===sequence)loading.value=false;}}
function select(){if(choice.value)load(JSON.parse(choice.value));}
watch(()=>[props.nodeId,props.bundleNo,props.reportDate],()=>{if(props.nodeId)load();},{immediate:true});
</script>
<style scoped>
.report-wage{padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);margin:12px 0}.report-wage label{display:flex;flex-direction:column;gap:8px;font-size:13px}.report-wage .select{width:100%}.quote-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-top:12px}.quote-line strong{font-size:20px;color:var(--brand)}
</style>
