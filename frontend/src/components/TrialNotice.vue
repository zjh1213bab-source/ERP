<template>
  <span v-if="trial && compact" class="tag orange" title="内部流程实测，不代表真实签样、出入库或收款">内部实测</span>
  <div v-else-if="trial" class="trial-notice" role="note">内部流程实测记录 · 不代表真实签样、出入库或收款；按要求保留供复核。</div>
</template>
<script setup>
import { computed } from 'vue';
const props=defineProps({record:Object,compact:{type:Boolean,default:true}});
const trial=computed(()=>[props.record?.remark,props.record?.requirements].some(s=>typeof s==='string'&&s.includes('__SMOKE_流程实测保留_')));
</script>
<style scoped>
.trial-notice { margin-bottom:16px;padding:12px 16px;border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:8px;background:var(--surface-2);color:var(--ink);font-size:13px;line-height:1.6; }
</style>
