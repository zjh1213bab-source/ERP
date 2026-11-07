<template>
  <Teleport to="body">
    <div v-if="viewer.open" class="iv-mask" role="dialog" aria-modal="true" aria-label="图片放大预览">
      <div class="iv-bar">
        <span class="iv-title">{{ viewer.title || '图片预览' }}</span>
        <div class="iv-acts">
          <button class="iv-btn" @click="zoomBy(0.2)" title="放大">＋</button>
          <button class="iv-btn" @click="zoomBy(-0.2)" title="缩小">－</button>
          <button class="iv-btn" @click="reset" title="原始大小">1:1</button>
          <button class="iv-btn" @click="openNew" title="新窗口打开">↗</button>
          <button class="iv-btn close" @click="close" title="关闭（Esc）">×</button>
        </div>
      </div>
      <div class="iv-body" @wheel.prevent="onWheel">
        <p v-if="failed" class="iv-error">图片加载失败，请关闭后重试。</p>
        <img v-else :src="viewer.url" :alt="viewer.title || '图片预览'" :style="{ transform: `scale(${scale})` }" @error="failed = true" @click.stop />
      </div>
      <div class="iv-tip">点击空白处或按 Esc 关闭 · 滚轮缩放</div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { viewer, closeImage } from '../store/viewer';

const scale = ref(1);
const failed = ref(false);
let previousOverflow = '';

function close() { closeImage(); }
function reset() { scale.value = 1; }
function zoomBy(d) {
  scale.value = Math.min(4, Math.max(0.3, Math.round((scale.value + d) * 10) / 10));
}
function onWheel(e) {
  e.deltaY < 0 ? zoomBy(0.1) : zoomBy(-0.1);
}
function openNew() {
  if (viewer.url) window.open(viewer.url, '_blank');
}

function onKey(e) {
  if (!viewer.open) return;
  if (e.key === 'Escape') close();
  if (e.key === '+' || e.key === '=') zoomBy(0.2);
  if (e.key === '-') zoomBy(-0.2);
}

watch(() => viewer.open, (v) => {
  if (v) { previousOverflow = document.body.style.overflow; scale.value = 1; failed.value = false; document.body.style.overflow = 'hidden'; }
  else document.body.style.overflow = previousOverflow;
});
watch(() => viewer.url, () => { scale.value = 1; failed.value = false; });

onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  if (viewer.open) document.body.style.overflow = previousOverflow;
});
</script>

<style scoped>
.iv-mask {
  position: fixed; inset: 0; z-index: 3000; background: rgba(10, 16, 28, 0.86);
  display: flex; flex-direction: column; backdrop-filter: blur(2px);
}
.iv-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; color: #e8eef7; font-size: 13px;
}
.iv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60vw; }
.iv-acts { display: flex; gap: 6px; }
.iv-btn {
  min-width: 30px; height: 28px; border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.1); color: #e8eef7; border-radius: 7px;
  font-size: 14px; cursor: pointer; line-height: 1; padding: 0 8px;
}
.iv-btn:hover { background: rgba(255, 255, 255, 0.2); }
.iv-btn.close { font-size: 18px; }
.iv-body {
  flex: 1; display: flex; align-items: center; justify-content: center;
  overflow: auto; padding: 0 16px;
}
.iv-body img {
  max-width: 92vw; max-height: 82vh; object-fit: contain;
  transition: transform 0.12s ease; border-radius: 4px; background: var(--surface);
}
.iv-tip { text-align: center; color: rgba(232, 238, 247, 0.55); font-size: 12px; padding: 8px 0 14px; }
.iv-error { color: #fff; }
</style>
