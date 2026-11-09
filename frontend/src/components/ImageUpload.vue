<template>
  <div
    ref="uploadRoot"
    class="img-up"
    :class="{ disabled, active: isActive(), lg: size === 'lg', sm: size === 'sm', xs: size === 'xs' }"
    :title="tipText"
    @click="onClick"
    @dblclick="onDblClick"
    @pointerenter="enter($event)"
    @pointermove="move($event)"
    @pointerleave="leave()"
    @contextmenu.prevent="disabled ? null : pick()"
  >
    <img v-if="modelValue" :src="modelValue" />
    <div v-else class="ph">
      <span class="ico">＋</span>
      <span v-if="!disabled" class="hint">Ctrl+V</span>
    </div>

    <!-- 选中态提示：明确告诉用户现在按 Ctrl+V 就能贴进来 -->
    <div v-if="!modelValue && !disabled && isActive() && !uploading" class="ready">Ctrl+V 粘贴</div>

    <div v-if="modelValue && !disabled" class="mask">
      <button type="button" class="del" @click.stop="clear">删除</button>
    </div>
    <button v-if="!disabled && !uploading" type="button" class="up-btn" title="选择本地文件" @click.stop="pick">↑</button>

    <div v-if="uploading" class="busy">上传中…</div>
    <input ref="fileEl" type="file" accept="image/*" style="display: none" @change="onFile" />
  </div>
</template>

<script setup>
/**
 * 通用图片上传位：Ctrl+V 粘贴 / 双击或点右上角箭头选文件 / 拖拽图片
 *
 * 为什么不「单击就弹文件框」：
 *   系统文件选择框弹出会让页面失焦，关掉之后第一次 Ctrl+V 往往不生效，
 *   用户会以为「这里不能粘贴」。所以单击只做「选中」，粘贴随时可用；
 *   选文件走双击或右上角小箭头，两条路互不打扰。
 * 粘贴归属：同一页面可能有多个图片位，只有「被点过或鼠标悬停」的那个接收粘贴；
 *          若页面上只有一个图片位，挂载后自动接管粘贴。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { api } from '../api';
import { openImage } from '../store/viewer';
import { activeImageUpload as activeUid, nextImageUploadId } from '../store/uploadFocus';

const props = defineProps({
  modelValue: { type: String, default: '' },
  size: { type: String, default: 'md' },     // sm | md | lg
  disabled: { type: Boolean, default: false },
  hoverPaste: Boolean,
  maxMB: { type: Number, default: 3 },
  title: { type: String, default: '' }
});
const emit = defineEmits(['update:modelValue', 'uploaded', 'uploading']);

/* 全局只允许一个图片位处于「接收粘贴」状态 */
const uid = nextImageUploadId();

const fileEl = ref(null);
const uploadRoot = ref(null);
const uploading = ref(false);
const isActive = () => activeUid.value === uid;
let hoverPoint = null;
function enter(event) { hoverPoint = {x:event.clientX,y:event.clientY}; activate(); }
function move(event) { hoverPoint = {x:event.clientX,y:event.clientY}; if(props.hoverPaste&&!props.disabled)activate(); }
function leave() { hoverPoint=null; if(props.hoverPaste&&isActive())activeUid.value=null; }
function hoveredOwn() { return !!hoverPoint&&!!uploadRoot.value?.contains(document.elementFromPoint(hoverPoint.x,hoverPoint.y)); }

function activate() {
  if (!props.disabled) activeUid.value = uid;
}
const tipText = computed(() => {
  if (props.modelValue) {
    return props.disabled
      ? '点击查看大图'
      : '单击查看大图 · 右上角箭头或右键换图 · 悬停后 Ctrl+V 可替换';
  }
  return props.disabled ? '' : props.hoverPaste ? '鼠标指向这里按 Ctrl+V 粘贴，双击可选文件' : '单击选中后按 Ctrl+V 粘贴，双击可选文件';
});

/** 有图 → 看大图；无图 → 选中（准备粘贴） */
function onClick() {
  if (props.modelValue) { openImage(props.modelValue, props.title || '图片预览'); return; }
  if (props.disabled) return;
  activate();
}

/** 只有空位双击才选文件；有图时单击已经是预览，双击不再抢 */
function onDblClick() {
  if (!props.modelValue) pick();
}

function pick() {
  if (props.disabled) return;
  activate();
  fileEl.value && fileEl.value.click();
}

async function handleFile(file) {
  if (!file || uploading.value || props.disabled) return;
  if (!file.type.startsWith('image/')) return alert('只能上传图片');
  if (file.size > props.maxMB * 1024 * 1024) return alert(`图片不能超过 ${props.maxMB}MB`);
  uploading.value = true;
  emit('uploading', true);
  try {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const up = await api.upload(dataUrl);
    emit('update:modelValue', up.url);
    emit('uploaded', up.url);
  } catch (e) {
    alert(e.message || '上传失败');
  } finally {
    uploading.value = false;
    emit('uploading', false);
  }
}

function onFile(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  handleFile(f);
}

function clear() {
  emit('update:modelValue', '');
}

/* ---------- 粘贴 ---------- */
function onPaste(e) {
  if (e.defaultPrevented || props.disabled || !isActive() || uploading.value || !uploadRoot.value?.getClientRects().length) return;
  if (props.hoverPaste && !hoveredOwn()) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type && items[i].type.startsWith('image/')) {
      const file = items[i].getAsFile();
      if (file) {
        e.preventDefault();
        if(props.hoverPaste)e.stopImmediatePropagation();
        handleFile(file);
        return;
      }
    }
  }
}

/* ---------- 拖拽 ---------- */
function onDrop(e) {
  if (props.disabled || !isActive() || uploading.value || !uploadRoot.value?.getClientRects().length) return;
  if(props.hoverPaste&&!uploadRoot.value.contains(e.target))return;
  const dt = e.dataTransfer;
  if (!dt) return;
  const file = dt.files && dt.files[0];
  if (file && file.type.startsWith('image/')) {
    e.preventDefault();
    e.stopPropagation();
    handleFile(file);
  }
}
function onDragOver(e) { if (!props.disabled && isActive()) e.preventDefault(); }

let pasteBound = false;
function bindPaste() {
  if (pasteBound) return;
  document.addEventListener('paste', onPaste, props.hoverPaste);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  pasteBound = true;
}
function unbindPaste() {
  if (!pasteBound || isActive()) return;   // 还在用就别解绑，由下一个组件接管
  document.removeEventListener('paste', onPaste, props.hoverPaste);
  document.removeEventListener('dragover', onDragOver);
  document.removeEventListener('drop', onDrop);
  pasteBound = false;
}

onMounted(() => {
  bindPaste();
  // 页面上还没有任何图片位被激活时，默认由第一个接管粘贴
  if (activeUid.value === null && !props.disabled && !props.hoverPaste) activeUid.value = uid;
});
onBeforeUnmount(() => {
  if (activeUid.value === uid) activeUid.value = null;
  document.removeEventListener('paste', onPaste, props.hoverPaste);
  document.removeEventListener('dragover', onDragOver);
  document.removeEventListener('drop', onDrop);
  pasteBound = false;
});
</script>

<style scoped>
.img-up {
  position: relative; width: 72px; height: 72px; border-radius: 8px; overflow: hidden;
  border: 1px dashed #d6dfeb; background: var(--surface-2); cursor: pointer; flex: none;
  display: flex; align-items: center; justify-content: center;
}
.img-up.sm { width: 44px; height: 44px; border-radius: 6px; }
.img-up.lg { width: 96px; height: 96px; }
.img-up.xs { width: 34px; height: 34px; border-radius: 6px; }
.img-up.xs .ico { font-size: 13px; }
.img-up.xs .hint { display: none; }
.img-up img { width: 100%; height: 100%; object-fit: cover; }
.img-up .ph { display: flex; flex-direction: column; align-items: center; gap: 2px; color: var(--ink-mute); }
.img-up .ico { font-size: 16px; line-height: 1; }
.img-up .hint { font-size: 12px; }
.img-up:hover { border-color: #2b6de5; }
.img-up.active { border-color: #2b6de5; border-style: solid; box-shadow: 0 0 0 2px rgba(43, 109, 229, 0.18); }
.img-up .ready {
  position: absolute; left: 50%; bottom: 1px; transform: translateX(-50%);
  background: rgba(43, 109, 229, 0.92); color: #fff; font-size: 12px;
  padding: 0 4px; border-radius: 3px; white-space: nowrap; pointer-events: none;
}
.img-up.xs .ready { display: none; }
.img-up .up-btn {
  position: absolute; top: 0; right: 0; width: 14px; height: 14px; line-height: 12px;
  border: none; background: rgba(43, 109, 229, 0.9); color: #fff; font-size: 12px;
  border-radius: 0 0 0 4px; cursor: pointer; opacity: 0; transition: opacity 0.15s; padding: 0;
}
.img-up:hover .up-btn { opacity: 1; }
.img-up .mask {
  position: absolute; inset: 0; background: rgba(22, 35, 59, 0.5); color: #fff;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; font-size: 12px; opacity: 0; transition: opacity 0.15s;
}
.img-up:hover .mask { opacity: 1; }
.img-up .mask .del {
  border: none; background: rgba(255, 255, 255, 0.18); color: #fff; font-size: 12px;
  border-radius: 4px; padding: 1px 6px; cursor: pointer;
}
.img-up .busy {
  position: absolute; inset: 0; background: rgba(255, 255, 255, 0.86);
  display: flex; align-items: center; justify-content: center; font-size: 12px; color: #5b6474;
}
.img-up.disabled { cursor: default; opacity: 0.7; }
</style>
