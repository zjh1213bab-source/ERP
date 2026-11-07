<template>
  <router-view />
  <ImageViewer />
</template>

<script setup>
// 根组件：路由出口 + 全局图片预览灯箱
import ImageViewer from './components/ImageViewer.vue';
import { onMounted, onBeforeUnmount,watch } from 'vue';
import {auth} from './store/auth';
import {loadAppearance} from './store/appearance';
let appearanceTimer;
function refreshAppearance(){if(auth.token && !document.hidden)loadAppearance().catch(()=>{});}
watch(()=>auth.token,refreshAppearance);
onMounted(()=>{refreshAppearance();appearanceTimer=setInterval(refreshAppearance,60000);window.addEventListener('focus',refreshAppearance);document.addEventListener('visibilitychange',refreshAppearance);});
onBeforeUnmount(()=>{clearInterval(appearanceTimer);window.removeEventListener('focus',refreshAppearance);document.removeEventListener('visibilitychange',refreshAppearance);});
import { openImage } from './store/viewer';

// 捕获阶段接管真实图片点击，避免触发表格选行/跳转或重复打开预览。
// 图片上传组件的删除/换图按钮并非 img，仍按原来的交互执行。
// 特殊装饰图片可用 data-no-image-preview 显式排除。
function previewImage(event) {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) return;
  if (target.closest('.iv-mask, [data-no-image-preview]')) return;
  const url = target.currentSrc || target.getAttribute('src');
  if (!url) return;
  event.preventDefault();
  event.stopPropagation();
  openImage(url, target.alt || target.title || '图片预览');
}
onMounted(() => document.addEventListener('click', previewImage, true));
onBeforeUnmount(() => document.removeEventListener('click', previewImage, true));
</script>

<style>
img:not([data-no-image-preview]) { cursor: zoom-in; }
.iv-mask img { cursor: default; }
@media print { img { cursor: default; } }
</style>
