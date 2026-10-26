<template>
  <div class="blueprint-page">
    <div class="page-head bp-head">
      <div>
        <h2>业务蓝图</h2>
        <div class="sub">跳色科技 ERP 全模块业务逻辑（原思维导图，仅展示）</div>
      </div>
      <div class="toolbar">
        <router-link class="btn btn-ghost" to="/dashboard">返回工作台</router-link>
      </div>
    </div>

    <div class="bp-canvas" style="position: relative">
      <MindMap v-if="config" :config="config" />
      <div v-else class="state-tip" :class="{ err: !!err }">
        {{ err || '加载业务蓝图…' }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import MindMap from '../components/MindMap.vue';
import { api } from '../api';

const config = ref(null);
const err = ref('');

onMounted(async () => {
  try {
    config.value = await api.blueprint();
  } catch (e) {
    err.value = '加载失败：' + e.message;
  }
});
</script>
