<template>
  <div v-if="enabled && route.path!=='/assistant'" class="assistant-widget">
    <div v-if="chat.opened" class="floating-chat" @keydown.esc="chat.opened=false"><AssistantChat closable @close="chat.opened=false" /></div>
    <button type="button" class="assistant-launcher" :aria-expanded="chat.opened" :aria-label="chat.opened?'收起智能助手':'打开智能助手'" @click="chat.opened=!chat.opened"><UiIcon name="assist" /><span>{{ chat.opened?'收起助手':'智能助手' }}</span></button>
  </div>
</template>
<script setup>
import { computed } from 'vue';import { useRoute } from 'vue-router';
import AssistantChat from './AssistantChat.vue';import UiIcon from './UiIcon.vue';
import { chat } from '../store/assistantChat';import { canVisit } from '../store/navigation';
const route=useRoute(),enabled=computed(()=>canVisit('/assistant'));
</script>
<style scoped>
.assistant-widget{position:fixed;right:24px;bottom:24px;z-index:90}.assistant-launcher{display:flex;align-items:center;gap:9px;margin-left:auto;border:1px solid color-mix(in srgb,var(--brand) 25%,var(--line));border-radius:16px;background:var(--brand);color:var(--on-brand);height:48px;padding:0 18px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:var(--shadow-md)}.floating-chat{width:410px;max-width:calc(100vw - 32px);height:min(720px,calc(100dvh - 112px));margin-bottom:14px;box-shadow:var(--shadow-md);border-radius:20px}.assistant-launcher:focus-visible{outline:2px solid var(--brand);outline-offset:4px}@media(max-width:600px){.assistant-widget{right:12px;bottom:14px}.floating-chat{width:calc(100vw - 24px);height:calc(100dvh - 100px);max-width:none}.assistant-launcher{height:44px;padding:0 14px}}@media print{.assistant-widget{display:none}}
</style>
