<template>
  <router-view />
  <ImageViewer />
</template>

<script setup>
// 根组件：路由出口 + 全局图片预览灯箱
import ImageViewer from './components/ImageViewer.vue';
</script>
