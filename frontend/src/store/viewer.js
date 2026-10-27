/**
 * 全局图片预览（灯箱）
 * 用法：openImage(url, title)
 *      <div @click="openImage(img)">…
 * 由 App.vue 里的 <ImageViewer /> 承载渲染，任何页面/弹窗都能调用。
 */
import { reactive } from 'vue';

export const viewer = reactive({
  open: false,
  url: '',
  title: ''
});

export function openImage(url, title = '') {
  if (!url) return;
  viewer.url = url;
  viewer.title = title;
  viewer.open = true;
}

export function closeImage() {
  viewer.open = false;
}
