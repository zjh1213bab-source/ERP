<template>
  <div class="style-images">
    <div><label>款式效果图</label><ImageUpload v-if="!readonly" :disabled="disabled" :model-value="effectImageUrl || ''" @uploading="trackUpload" @update:model-value="$emit('update:effectImageUrl',$event)" size="lg" /><img v-else-if="effectImageUrl" :src="effectImageUrl" alt="款式效果图" /><span v-else class="sub">未上传</span></div>
    <div class="style-detail"><label>款式细节图（最多12张）</label>
      <div class="style-gallery"><div v-for="(url,index) in detailImages" :key="index">
        <ImageUpload v-if="!readonly" :disabled="disabled" :model-value="url" @uploading="trackUpload" @update:model-value="setImage(index,$event)" /><img v-else-if="url" :src="url" alt="款式细节图" />
        <button v-if="!readonly" type="button" :disabled="disabled||uploadCount>0" class="link-btn danger" @click="remove(index)">移除</button>
      </div><button v-if="!readonly && detailImages.length<12" :disabled="disabled" type="button" class="btn btn-ghost btn-sm" @click="$emit('update:detailImages',[...detailImages,''])">＋ 细节图</button></div>
    </div>
  </div>
</template>
<script setup>
import ImageUpload from './ImageUpload.vue';
import {ref} from 'vue';
const props=defineProps({effectImageUrl:{type:String,default:''},detailImages:{type:Array,default:()=>[]},readonly:Boolean,disabled:Boolean});
const emit=defineEmits(['update:effectImageUrl','update:detailImages','uploading']);
const uploadCount=ref(0);
function trackUpload(active){const previous=uploadCount.value;uploadCount.value=Math.max(0,previous+(active?1:-1));if(!previous&&uploadCount.value)emit('uploading',true);else if(previous&&!uploadCount.value)emit('uploading',false);}
function setImage(index,url){const rows=[...props.detailImages];rows[index]=url;emit('update:detailImages',rows);}
function remove(index){emit('update:detailImages',props.detailImages.filter((_,i)=>i!==index));}
</script>
<style scoped>
.style-images{display:flex;gap:20px;flex-wrap:wrap;margin:10px 0}.style-images label{display:block;font-size:12px;color:var(--ink-soft);margin-bottom:8px}.style-gallery{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}.style-gallery>div{display:flex;flex-direction:column}.style-images img{width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}.style-detail{flex:1;min-width:220px}
</style>
