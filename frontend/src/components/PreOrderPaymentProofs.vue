<template>
  <section ref="root" class="pre-payment-proofs" data-paste-owner="payment-proofs" tabindex="0" aria-label="付款凭证" @pointerdown.capture="activate()" @focusin="activate()" @paste="paste($event)" @dragover.prevent @drop.prevent.stop="drop($event)">
    <div v-if="!readonly" class="proof-toolbar">
      <button type="button" :disabled="disabled||uploading||modelValue.length>=10" @click="selectPaste()">＋ 粘贴付款凭证</button>
      <button type="button" :disabled="disabled||uploading||modelValue.length>=10" @click="fileInput.click()">选择文件</button>
      <span>{{uploading?'付款凭证上传中…':pasteReady?'已选中，按 Ctrl+V 粘贴图片，也可拖入文件。':'支持图片、PDF；每个不超过10MB，最多10个。'}}</span>
      <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" multiple hidden @change="filesChanged($event)" />
    </div>
    <p v-if="error" class="proof-error" role="alert">{{error}}</p>
    <div v-if="modelValue.length" class="proof-list">
      <article v-for="proof in modelValue" :key="proof.url" class="proof-card">
        <button v-if="previews[proof.url]" type="button" class="proof-picture" :aria-label="'查看付款凭证 '+proof.filename" @click="openImage(previews[proof.url],proof.filename)"><img :src="previews[proof.url]" :alt="proof.filename"/></button>
        <div v-else class="proof-file">{{proof.mime==='application/pdf'?'PDF':previewErrors[proof.url]?'预览失败':'图片加载中…'}}</div>
        <div class="proof-info"><b :title="proof.filename">{{proof.filename}}</b><small>{{formatSize(proof.size)}}</small><div class="proof-actions"><button type="button" @click="download(proof)">下载</button><button v-if="!readonly" type="button" :disabled="disabled||uploading" class="danger" @click="remove(proof.url)">移除</button></div></div>
      </article>
    </div>
    <p v-else class="proof-empty">暂无付款凭证</p>
  </section>
</template>
<script setup>
import {ref,watch,onBeforeUnmount} from 'vue';
import {api,downloadFile} from '../api';
import {activeImageUpload} from '../store/uploadFocus';
import {openImage} from '../store/viewer';
const props=defineProps({modelValue:{type:Array,default:()=>[]},disabled:Boolean,readonly:Boolean});
const emit=defineEmits(['update:modelValue','uploading']);
const root=ref(null),fileInput=ref(null),uploading=ref(false),pasteReady=ref(false),error=ref(''),previews=ref({}),previewErrors=ref({});
const pending=new Set();let alive=true;
function activate(){activeImageUpload.value=null;}
function selectPaste(){if(props.disabled||uploading.value)return;activate();pasteReady.value=true;root.value?.focus({preventScroll:true});}
const formatSize=size=>Number(size)>=1024*1024?(Number(size)/1024/1024).toFixed(1)+' MB':Math.max(1,Math.ceil(Number(size||0)/1024))+' KB';
async function upload(files){
 if(props.readonly||props.disabled||uploading.value)return;
 const selected=Array.from(files||[]);if(!selected.length)return;
 error.value='';const failures=[],next=[...props.modelValue];uploading.value=true;emit('uploading',true);
 try{for(const file of selected){
  if(!alive)break;
  if(next.length>=10){failures.push('最多10个付款凭证，其余文件未上传');break;}
  if(!['image/png','image/jpeg','image/webp','image/gif','application/pdf'].includes(file.type)){failures.push(file.name+'：仅支持图片或PDF');continue;}
  if(file.size>10*1024*1024){failures.push(file.name+'：超过10MB');continue;}
  try{const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('读取文件失败'));r.readAsDataURL(file);});const proof=await api.uploadPreOrderPaymentProof(dataUrl,file.name||'付款凭证.png');if(alive){next.push(proof);emit('update:modelValue',[...next]);}}catch(e){failures.push(file.name+'：'+(e.message||'上传失败'));}
 }}finally{error.value=failures.join('；');uploading.value=false;if(alive)emit('uploading',false);}
}
function filesChanged(e){const files=Array.from(e.target.files||[]);e.target.value='';upload(files);}
function drop(e){activate();upload(e.dataTransfer?.files);}
function paste(e){if(props.readonly||props.disabled||uploading.value)return;const files=Array.from(e.clipboardData?.items||[]).filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();e.stopPropagation();upload(files);}}
function remove(url){if(props.disabled||uploading.value)return;emit('update:modelValue',props.modelValue.filter(p=>p.url!==url));}
async function download(proof){try{await api.download(proof.url,proof.filename);}catch(e){error.value=e.message||'下载失败';}}
watch(()=>props.modelValue.map(p=>p.url),async()=>{
 const keep=new Set(props.modelValue.map(p=>p.url));for(const [url,blob] of Object.entries(previews.value))if(!keep.has(url)){URL.revokeObjectURL(blob);delete previews.value[url];delete previewErrors.value[url];}
 for(const proof of props.modelValue){
  if(!proof.mime?.startsWith('image/')||previews.value[proof.url]||pending.has(proof.url))continue;
  pending.add(proof.url);try{const blob=await downloadFile(proof.url);if(alive&&props.modelValue.some(p=>p.url===proof.url))previews.value[proof.url]=URL.createObjectURL(blob);}catch{if(alive)previewErrors.value[proof.url]=true;}finally{pending.delete(proof.url);}
 }
},{immediate:true});
onBeforeUnmount(()=>{alive=false;Object.values(previews.value).forEach(url=>URL.revokeObjectURL(url));if(uploading.value)emit('uploading',false);});
</script>
<style scoped>
.pre-payment-proofs{min-width:0;border:1px dashed var(--line);background:var(--surface-2);border-radius:4px;padding:12px}.pre-payment-proofs:focus{outline:2px solid var(--brand);outline-offset:2px}.proof-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.proof-toolbar button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:4px;padding:7px 12px;cursor:pointer;font-size:12px}.proof-toolbar span,.proof-empty{font-size:12px;color:var(--ink-mute)}.proof-toolbar button:disabled{opacity:.55;cursor:default}.proof-list{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px}.proof-card{display:flex;gap:10px;align-items:center;width:260px;max-width:100%;padding:9px;border:1px solid var(--line);border-radius:4px;background:var(--surface);box-sizing:border-box}.proof-picture,.proof-file{width:64px;height:64px;flex:none;display:grid;place-items:center;padding:0;border:1px solid var(--line);border-radius:3px;background:var(--surface-2);color:var(--ink-mute);font-size:11px}.proof-picture{cursor:zoom-in}.proof-picture img{max-width:100%;max-height:100%;object-fit:contain}.proof-info{display:flex;flex-direction:column;gap:5px;min-width:0}.proof-info b{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.proof-info small{font-size:11px;color:var(--ink-mute)}.proof-actions{display:flex;gap:12px}.proof-actions button{border:0;background:none;padding:0;color:var(--brand);font-size:12px;cursor:pointer}.proof-actions .danger{color:var(--danger)}.proof-actions button:disabled{opacity:.5;cursor:default}.proof-error{font-size:12px;color:var(--danger);margin:9px 0}.proof-empty{margin:10px 0 0}
</style>
