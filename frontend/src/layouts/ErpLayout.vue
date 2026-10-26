<template>
  <div class="erp-shell">
    <!-- 侧边栏 -->
    <aside class="erp-sidebar">
      <div class="brand">
        <span class="dot"></span>
        跳色科技 ERP
      </div>
      <nav class="erp-nav">
        <router-link v-for="n in navs" :key="n.to" :to="n.to">
          <span class="nav-ico">{{ n.icon }}</span>
          {{ n.label }}
        </router-link>
      </nav>
      <div class="side-foot">100-500人企业版 · v1.0</div>
    </aside>

    <!-- 主区 -->
    <div class="erp-main">
      <header class="erp-topbar">
        <div class="crumb">{{ pageTitle }}</div>
        <div class="userbox">
          <span class="tag blue">{{ roleLabel }}</span>
          <span>{{ auth.user?.name || auth.user?.username }}</span>
          <div class="avatar">{{ initial }}</div>
          <button class="link-btn" @click="logout">退出</button>
        </div>
      </header>

      <section class="erp-content">
        <router-view />
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { auth, clearAuth, ROLE_LABELS } from '../store/auth';

const route = useRoute();
const router = useRouter();

const navs = [
  { to: '/dashboard', label: '工作台', icon: '📊' },
  { to: '/customers', label: '客户管理', icon: '👥' },
  { to: '/products', label: '产品管理', icon: '👕' },
  { to: '/orders', label: '销售订单', icon: '📋' },
  { to: '/development', label: '开发管理', icon: '🧵' },
  { to: '/blueprint', label: '业务蓝图', icon: '🗺️' },
  { to: '/settings', label: '系统设置', icon: '⚙️' }
];

const pageTitle = computed(() => route.meta.title || '工作台');
const roleLabel = computed(() => ROLE_LABELS[auth.user?.role] || auth.user?.role || '');
const initial = computed(() => {
  const n = auth.user?.name || auth.user?.username || '?';
  return n.slice(0, 1);
});

function logout() {
  clearAuth();
  router.push('/login');
}
</script>
