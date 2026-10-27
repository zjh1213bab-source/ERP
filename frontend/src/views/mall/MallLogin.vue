<template>
  <div class="mll-wrap">
    <div class="mll-box">
      <div class="mll-brand">
        <span class="mll-logo">跳</span>
        <div>
          <div class="mll-co">跳色科技 · 客户选品中心</div>
          <div class="mll-sub">用业务员开通的商城账号登录，可查看专属价格、提交选品询价、跟踪订单进度</div>
        </div>
      </div>

      <label class="mll-label">登录账号</label>
      <input class="mll-input" v-model="username" placeholder="如 abc001" @keyup.enter="doLogin" autocomplete="username" />
      <label class="mll-label">密码</label>
      <input class="mll-input" type="password" v-model="password" placeholder="请输入密码" @keyup.enter="doLogin" autocomplete="current-password" />

      <p v-if="err" class="mll-err">{{ err }}</p>
      <button class="mll-btn" :disabled="loading" @click="doLogin">{{ loading ? '登录中…' : '登录' }}</button>

      <div class="mll-tip">
        还没有账号？请联系你的业务员开通。<br />
        演示账号：<code>abc001</code> / <code>abc123456</code>
      </div>

      <div class="mll-guest">
        <span>先随便看看？</span>
        <router-link to="/mall/guest">浏览公开目录 →</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { mallApi, setMallAuth } from '../../api/mall';

const router = useRouter();
const username = ref('');
const password = ref('');
const err = ref('');
const loading = ref(false);

async function doLogin() {
  err.value = '';
  if (!username.value || !password.value) { err.value = '请输入账号和密码'; return; }
  loading.value = true;
  try {
    const r = await mallApi.login(username.value.trim(), password.value);
    setMallAuth(r.token, r.account);
    router.replace('/mall');
  } catch (e) {
    err.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.mll-wrap {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(140deg, #12365f, #1f5fae 60%, #2f7bc9); padding: 20px;
}
.mll-box { width: 420px; max-width: 100%; background: #fff; border-radius: 16px; padding: 26px 26px 22px; box-shadow: 0 22px 60px rgba(8, 24, 46, 0.3); }
.mll-brand { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 20px; }
.mll-logo {
  width: 40px; height: 40px; border-radius: 11px; flex: none;
  background: linear-gradient(140deg, #1f5fae, #2f7bc9); color: #fff;
  display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18px;
}
.mll-co { font-size: 16px; font-weight: 800; color: #16233b; }
.mll-sub { font-size: 11.5px; color: #8a9ab0; margin-top: 4px; line-height: 1.6; }
.mll-label { display: block; font-size: 12.5px; font-weight: 600; color: #5b6b80; margin: 12px 0 6px; }
.mll-input { width: 100%; box-sizing: border-box; padding: 11px 13px; border: 1px solid #d8e1ee; border-radius: 10px; font-size: 14px; }
.mll-input:focus { outline: none; border-color: #1f5fae; box-shadow: 0 0 0 3px rgba(31, 95, 174, 0.12); }
.mll-btn {
  width: 100%; margin-top: 18px; padding: 12px; border: none; border-radius: 10px;
  background: #1f5fae; color: #fff; font-size: 14.5px; font-weight: 700; cursor: pointer;
}
.mll-btn:disabled { opacity: 0.6; }
.mll-err { color: #c0392b; font-size: 12.5px; margin: 10px 0 0; }
.mll-tip { font-size: 11.5px; color: #8a9ab0; margin-top: 14px; line-height: 1.7; }
.mll-tip code { background: #f1f5fb; padding: 1px 5px; border-radius: 4px; color: #1f5fae; }
.mll-guest { margin-top: 14px; padding-top: 12px; border-top: 1px dashed #e8eef7; font-size: 12px; color: #8a9ab0; display: flex; justify-content: space-between; }
.mll-guest a { color: #1f5fae; }
</style>
