<template>
  <section ref="root" class="pre-upload-panel" @pointerdown="pasteActive=true" @dragover.prevent="dragging=true" @dragleave.self="dragging=false" @drop.prevent.stop="drop($event)">
    <button type="button" class="pre-upload-zone" :class="{dragging}" :disabled="disabled||uploading" @click="fileInput.click()">
      <svg viewBox="0 0 64 52" aria-hidden="true"><path fill="currentColor" d="M17 44C-3 44-2 19 16 17 23-4 49 0 49 16c21 1 21 28 1 28H17Z"/><path fill="var(--surface)" d="m32 17-12 13h8v16h8V30h8Z"/></svg>
      <span>{{uploading?'图片上传中…':'将图片拖到此处，或'}} <b v-if="!uploading">点击上传</b></span>
      <small>{{single?'支持点击、拖拽、Ctrl+V 粘贴；上传或替换本款图片。单张最大 3MB。':'支持多图、Ctrl+V 粘贴；每张图片新增一款，可继续上传细节图。单张最大 3MB。'}}</small>
    </button>
    <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" :multiple="!single" hidden @change="filesChanged($event)" />
    <p v-if="error" class="pre-upload-error" role="alert">{{error}}</p>
  </section>
</template>
<script setup>
import {ref,onMounted,onBeforeUnmount} from 'vue';
import {api} from '../api';
const props=defineProps({single:Boolean,disabled:Boolean,remaining:{type:Number,default:100}});
const emit=defineEmits(['images','uploading']);
const root=ref(null),fileInput=ref(null),uploading=ref(false),dragging=ref(false),error=ref('');
let pasteActive=true,alive=true;
// 逐张反馈成功结果，网络中断时保留已上传的款式，并显示失败文件名。
async function upload(files){
 if(props.disabled||uploading.value)return;
 const selected=Array.from(files||[]);if(!selected.length)return;
 error.value='';const failures=[];let remaining=props.remaining;
 uploading.value=true;emit('uploading',true);
 try{
  for(const file of (props.single?selected.slice(0,1):selected)){
   if(!alive)break;
   if(remaining<=0){failures.push('最多100款，其余图片未上传');break;}
   if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){failures.push(file.name+'：仅支持 PNG/JPG/WebP/GIF 图片');continue;}
   if(file.size>3*1024*1024){failures.push(file.name+'：超过3MB');continue;}
   try{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('读取图片失败'));reader.readAsDataURL(file);});
    const result=await api.upload(data);
    if(alive){emit('images',[result.url]);remaining--;}
   }catch(e){failures.push(file.name+'：'+(e.message||'上传失败，请重试'));}
  }
 }finally{error.value=failures.join('；');uploading.value=false;emit('uploading',false);}
}
function filesChanged(e){const files=Array.from(e.target.files||[]);e.target.value='';upload(files);}
function drop(e){dragging.value=false;pasteActive=true;upload(e.dataTransfer?.files);}
function pointer(e){if(!root.value?.getClientRects().length)return;pasteActive=!!e.target.closest('.pre-form')&&!e.target.closest('.img-up, .pre-archive-dialog');}
function paste(e){
 if(!pasteActive||props.disabled||uploading.value||!root.value?.getClientRects().length||e.target.closest('input,textarea,[contenteditable="true"],.img-up'))return;
 const files=Array.from(e.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
 if(files.length){e.preventDefault();e.stopImmediatePropagation();upload(files);}
}
onMounted(()=>{document.addEventListener('paste',paste,true);document.addEventListener('pointerdown',pointer,true);});
onBeforeUnmount(()=>{alive=false;document.removeEventListener('paste',paste,true);document.removeEventListener('pointerdown',pointer,true);});
</script>
<style scoped>
.pre-upload-panel{background:var(--surface);border:1px solid var(--line);padding:18px;box-shadow:0 2px 9px #142c4810;border-radius:4px;margin-bottom:12px}
.pre-upload-zone{width:100%;min-height:150px;border:1px dashed var(--line);background:var(--surface);color:var(--ink-mute);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;cursor:pointer;border-radius:5px}
.pre-upload-zone svg{width:54px;height:44px;opacity:.6}.pre-upload-zone b{color:var(--brand);font-weight:500}.pre-upload-zone small{font-size:11px}.pre-upload-zone.dragging,.pre-upload-zone:hover{border-color:var(--brand);background:var(--surface-2)}.pre-upload-zone:disabled{cursor:wait;opacity:.7}.pre-upload-error{color:var(--danger);margin:8px 0 0;font-size:12px}
</style>
