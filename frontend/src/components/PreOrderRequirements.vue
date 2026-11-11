<template>
 <details open class="craft"><summary>外发工艺　<small>已启用</small></summary>
 <OutsourceCraftEditor by-product :readonly="disabled" :model-value="meta.outsource_rows || []" @update:model-value="set('outsource_rows',$event)" @uploading="$emit('uploading',$event)"/></details>
 <BusinessRequirement :disabled="disabled" :model-value="meta.business_requirement" @update:model-value="set('business_requirement',$event)"/>
</template>
<script setup>
import {computed} from 'vue';
import OutsourceCraftEditor from './OutsourceCraftEditor.vue';
import BusinessRequirement from './BusinessRequirement.vue';
const props=defineProps({item:{type:Object,required:true},disabled:Boolean});
defineEmits(['uploading']);
const meta=computed(()=>props.item.matrix_meta||{});
function set(key,value){if(!props.disabled)props.item.matrix_meta={colors:[],sizes:[],color_images:{},split_price:false,...meta.value,[key]:value};}
</script>
<style scoped>
.craft{border:1px solid var(--line);padding:10px;border-radius:5px}.craft summary{background:var(--surface-2);padding:12px;cursor:pointer;font-weight:bold}.craft small{font-size:12px;color:var(--ink-mute);font-weight:400}
</style>
