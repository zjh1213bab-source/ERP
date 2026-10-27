<template>
  <div class="login-screen">
    <div class="login-box">
      <div class="logo">
        <span class="dot"></span>
        <h1>跳色科技 ERP</h1>
      </div>
      <p class="sub">企业资源管理系统 · 请登录后使用</p>

      <form @submit.prevent="submit">
        <div class="fitem" style="margin-bottom: 14px">
          <label>账号</label>
          <input class="input" v-model="username" autocomplete="username" placeholder="请输入账号" />
        </div>
        <div class="fitem" style="margin-bottom: 18px">
          <label>密码</label>
          <input
            class="input"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
          />
        </div>
        <button class="btn btn-primary btn-block" :disabled="loading">
          {{ loading ? '登录中…' : '登 录' }}
        </button>
        <p v-if="err" class="form-msg err" style="margin-top: 12px">{{ err }}</p>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { setAuth } from '../store/auth';

const router = useRouter();
const route = useRoute();
const username = ref('');
const password = ref('');
const loading = ref(false);
const err = ref('');

async function submit() {
  if (!username.value || !password.value) {
    err.value = '请输入账号和密码';
    return;
  }
  loading.value = true;
  err.value = '';
  try {
    const res = await api.login(username.value, password.value);
    setAuth(res.token, res.user);
    // 扫码进来时带了 redirect，登录后直接回到那张单据
    const back = route.query.redirect ? String(route.query.redirect) : '/dashboard';
    router.push(back);
  } catch (e) {
    err.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>
