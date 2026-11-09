<template>
  <section ref="root" class="pre-upload-panel" :data-paste-owner="detail?'style-details':'new-style-images'" :class="{'detail-tile':detail,'paste-selected':pasteFirst&&pasteActive||hoverEnabled&&hovered}" @pointerenter="enterHover($event)" @pointermove="moveHover($event)" @pointerleave="leaveHover()" @dragover.prevent="dragging=true" @dragleave.self="dragging=false" @drop.prevent.stop="drop($event)">
    <button ref="pasteZone" type="button" class="pre-upload-zone" :class="{dragging,selected:pasteFirst&&pasteActive||hoverEnabled&&hovered}" :disabled="disabled||uploading" :aria-pressed="pasteFirst||hoverEnabled?pasteActive||hovered:undefined" :aria-label="detail?'添加本款细节图':pasteFirst||hoverEnabled?'新款图片粘贴区':'上传款式图片'" @click="activateZone()">
      <template v-if="detail"><strong class="pre-detail-plus" aria-hidden="true">＋</strong><span class="pre-detail-hint">{{uploading?'上传中…':hovered?'Ctrl+V 粘贴':'添加细节图'}}</span></template>
      <template v-else>
      <svg viewBox="0 0 64 52" aria-hidden="true"><path fill="currentColor" d="M17 44C-3 44-2 19 16 17 23-4 49 0 49 16c21 1 21 28 1 28H17Z"/><path fill="var(--surface)" d="m32 17-12 13h8v16h8V30h8Z"/></svg>
      <span v-if="uploading">图片上传中…</span><span v-else-if="hoverEnabled"><b>{{hovered?'已指向这里，按 Ctrl+V 粘贴图片':pasteActive?'已选中，按 Ctrl+V 粘贴图片':'鼠标指向这里，按 Ctrl+V 粘贴图片'}}</b>，也可拖入图片</span><span v-else-if="pasteFirst"><b>{{pasteActive?'已选中，按 Ctrl+V 粘贴图片':'点击此处后按 Ctrl+V 粘贴图片'}}</b>，也可拖入图片</span><span v-else>将图片拖到此处，或 <b>点击上传</b></span>
      <small>{{single?'支持点击、拖拽、Ctrl+V 粘贴；上传或替换本款图片。单张最大 3MB。':'支持多图、Ctrl+V 粘贴；每张图片新增一款，可继续上传细节图。单张最大 3MB。'}}</small>
      </template>
    </button>
    <div v-if="!detail&&(pasteFirst||hoverEnabled)" class="pre-upload-actions"><span role="status">{{pasteActive||hovered?'粘贴到这里会新增款式，不会替换已有图片。':'每张图片新增一款。'}}</span><button type="button" :disabled="disabled||uploading" @click="chooseFiles()">选择文件</button></div>
    <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" :multiple="!single" hidden @change="filesChanged($event)" />
    <p v-if="error" class="pre-upload-error" role="alert">{{error}}</p>
  </section>
</template>
<script setup>
import {computed,ref,watch,onMounted,onBeforeUnmount} from 'vue';
import {api} from '../api';
import {activeImageUpload,nextImageUploadId} from '../store/uploadFocus';
import {maySelectImageDrop,mayPasteImageDrop,shouldReleaseImageDrop} from '../utils/imagePasteScope';
const props=defineProps({single:Boolean,disabled:Boolean,pasteFirst:Boolean,hoverPaste:Boolean,detail:Boolean,remaining:{type:Number,default:null}});
const emit=defineEmits(['images','uploading']);
const hoverEnabled=computed(()=>props.hoverPaste||props.detail);
const root=ref(null),pasteZone=ref(null),fileInput=ref(null),uploading=ref(false),dragging=ref(false),error=ref(''),pasteActive=ref(!props.pasteFirst&&!hoverEnabled.value),hovered=ref(false);
const pasteUid='new-style-'+nextImageUploadId();
let alive=true,hoverPoint=null;
function selectPaste(){pasteActive.value=true;activeImageUpload.value=pasteUid;}
function focusPaste(){if(props.disabled||uploading.value||!root.value?.getClientRects().length)return false;selectPaste();pasteZone.value?.focus();return document.activeElement===pasteZone.value;}
function chooseFiles(){if(props.disabled||uploading.value)return;selectPaste();fileInput.value?.click();}
function activateZone(){if(props.detail)chooseFiles();else if(props.pasteFirst||hoverEnabled.value)focusPaste();else chooseFiles();}
function enterHover(event){if(!hoverEnabled.value||props.disabled||uploading.value)return;hovered.value=true;hoverPoint={x:event.clientX,y:event.clientY};selectPaste();}
function moveHover(event){if(!hoverEnabled.value)return;hoverPoint={x:event.clientX,y:event.clientY};if(!hovered.value&&!props.disabled&&!uploading.value)enterHover(event);}
function leaveHover(){if(!hoverEnabled.value)return;hovered.value=false;hoverPoint=null;pasteActive.value=false;if(activeImageUpload.value===pasteUid)activeImageUpload.value=null;}
function hoverTarget(){return hoverEnabled.value&&hovered.value&&hoverPoint?document.elementFromPoint(hoverPoint.x,hoverPoint.y):null;}
defineExpose({focusPaste});
watch(activeImageUpload,value=>{if(value!==pasteUid&&value!==null)pasteActive.value=false;});
// 逐张反馈成功结果，网络中断时保留已上传的款式，并显示失败文件名。
async function upload(files){
 if(props.disabled||uploading.value)return;
 const selected=Array.from(files||[]);if(!selected.length)return;
 error.value='';const failures=[];let remaining=props.remaining??(props.detail?12:100);
 uploading.value=true;emit('uploading',true);
 try{
  for(const file of (props.single?selected.slice(0,1):selected)){
   if(!alive)break;
   if(remaining<=0){failures.push(props.detail?'最多12张细节图，其余图片未上传':'最多100款，其余图片未上传');break;}
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
function drop(e){dragging.value=false;if(props.disabled||uploading.value)return;selectPaste();pasteZone.value?.focus();upload(e.dataTransfer?.files);}
function targetState(event){
 const target=event.target?.nodeType===1?event.target:document.activeElement;
 const closest=selector=>target?.closest?.(selector),owner=closest('[data-paste-owner],.pre-payment-proofs');
 const dialog=closest('[role="dialog"],.modal'),scope=root.value?.closest('.pre-form,.dev-upload-modal')||root.value;
 return {ownTarget:!!root.value?.contains(target),insideScope:!!scope?.contains(target),hasPasteOwner:!!owner,foreignOwner:!!owner&&owner!==root.value,
  imageUpload:!!closest('.img-up'),editable:!!closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'),
  foreignDialog:!!closest('.pre-archive-dialog,.matrix-dialog-mask')||!!dialog&&!dialog.contains(root.value)};
}
function pointer(e){
 if(!root.value?.getClientRects().length)return;
 // 悬停模式不移动键盘焦点，原输入框收到 focusin 也不能夺走鼠标下图片区域的归属。
 if(e.type==='focusin'&&root.value.contains(hoverTarget()))return;
 const target=targetState(e);
 if(hoverEnabled.value&&e.type==='pointerdown'&&!target.ownTarget)leaveHover();
 // 转向付款凭证、表单输入或其他区域后，旧图片位不得继续接受全局 Ctrl+V。
 if(shouldReleaseImageDrop({...target,isCurrentOwner:activeImageUpload.value===pasteUid}))activeImageUpload.value=null;
 const selected=!props.disabled&&!uploading.value&&maySelectImageDrop({...target,pasteFirst:props.pasteFirst||hoverEnabled.value});
 pasteActive.value=selected;if(selected)selectPaste();
}
function paste(e){
 const files=Array.from(e.clipboardData?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
 if(!files.length)return; // 普通文本永远交给原输入框。
 const hoverIntent=hoverEnabled.value&&hovered.value,hit=hoverIntent?hoverTarget():null;
 const target=targetState(hoverIntent?{target:hit}:e),hoveredOwn=!!hit&&!!root.value?.contains(hit)&&!target.foreignOwner&&!target.foreignDialog;
 if(!mayPasteImageDrop({...target,selected:hoverIntent?false:pasteActive.value,hoveredOwn,visible:!!root.value?.getClientRects().length,disabled:props.disabled,uploading:uploading.value,otherImageActive:activeImageUpload.value!==null&&activeImageUpload.value!==pasteUid}))return;
 selectPaste();e.preventDefault();e.stopImmediatePropagation();upload(files);
}
onMounted(()=>{document.addEventListener('paste',paste,true);document.addEventListener('pointerdown',pointer,true);document.addEventListener('focusin',pointer,true);if(!props.pasteFirst&&!hoverEnabled.value&&!props.disabled&&root.value?.getClientRects().length)selectPaste();});
onBeforeUnmount(()=>{alive=false;if(activeImageUpload.value===pasteUid)activeImageUpload.value=null;document.removeEventListener('paste',paste,true);document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('focusin',pointer,true);});
</script>
<style scoped>
.pre-upload-panel{background:var(--surface);border:1px solid var(--line);padding:18px;box-shadow:0 2px 9px #142c4810;border-radius:4px;margin-bottom:12px}
.pre-upload-zone{width:100%;min-height:150px;border:1px dashed var(--line);background:var(--surface);color:var(--ink-mute);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;cursor:pointer;border-radius:5px}
.pre-upload-zone svg{width:54px;height:44px;opacity:.6}.pre-upload-zone b{color:var(--brand);font-weight:500}.pre-upload-zone small{font-size:11px}.pre-upload-zone.dragging,.pre-upload-zone:hover{border-color:var(--brand);background:var(--surface-2)}.pre-upload-zone:disabled{cursor:wait;opacity:.7}.pre-upload-error{color:var(--danger);margin:8px 0 0;font-size:12px}
.pre-upload-zone.selected{border-color:var(--brand);border-style:solid;background:var(--brand-soft);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 15%,transparent)}.pre-upload-zone:focus-visible{outline:2px solid var(--brand);outline-offset:3px}.pre-upload-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;font-size:12px;color:var(--ink-soft)}.pre-upload-actions button{border:1px solid var(--line);border-radius:4px;padding:7px 14px;background:var(--surface);color:var(--brand);cursor:pointer}.pre-upload-actions button:disabled{cursor:wait;opacity:.6}
.pre-upload-panel.detail-tile{width:96px;flex:none;padding:0;margin:0;border:0;background:transparent;box-shadow:none}.detail-tile .pre-upload-zone{width:96px;height:96px;min-height:96px;gap:5px;padding:8px;background:var(--surface-2)}.pre-detail-plus{font-size:30px;line-height:32px;font-weight:300;color:var(--ink-mute)}.pre-detail-hint{font-size:11px;color:var(--ink-soft)}.detail-tile .pre-upload-error{font-size:11px;overflow-wrap:anywhere;line-height:1.5}.detail-tile .pre-upload-zone.selected{background:var(--brand-soft)}
</style>
