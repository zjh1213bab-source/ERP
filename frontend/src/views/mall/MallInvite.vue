<template>
  <div class="iv-wrap">
    <div class="iv-card">
      <div class="iv-brand">
        <span class="iv-logo">跳</span>
        <div>
          <div class="iv-co">跳色科技 · 客户选品中心</div>
          <div class="iv-sub">凭业务员邀请注册账号</div>
        </div>
      </div>

      <div v-if="loading" class="iv-muted">正在核验邀请…</div>

      <div v-else-if="err" class="iv-err">
        ⚠ {{ err }}
        <div class="iv-muted" style="margin-top: 8px">请联系你的业务员重新发送邀请。</div>
      </div>

      <template v-else-if="info">
        <div class="iv-info">
          <div><span>客户组织</span><b>{{ info.customer ? info.customer.name : '-' }}</b></div>
          <div><span>账号类型</span><b>{{ info.role_label }}</b></div>
          <div><span>核验联系方式</span><b>{{ maskedContact }}</b></div>
          <div><span>邀请有效期</span><b>{{ info.expires_at }}</b></div>
        </div>

        <form class="iv-form" @submit.prevent="submit">
          <label>
            登录账号
            <input class="input" v-model="form.username" placeholder="4-32 位字母数字或 _ . -" autocomplete="username" />
          </label>
          <label>
            姓名 / 称呼
            <input class="input" v-model="form.name" placeholder="用于对账与沟通" />
          </label>
          <label>
            手机（可选）
            <input class="input" v-model="form.phone" />
          </label>
          <label>
            邮箱（可选）
            <input class="input" v-model="form.email" />
          </label>
          <label>
            设置密码
            <input class="input" type="password" v-model="form.password" placeholder="至少 6 位" autocomplete="new-password" />
          </label>
          <label>
            再输一次
            <input class="input" type="password" v-model="form.password2" autocomplete="new-password" />
          </label>
          <p v-if="formMsg" class="iv-err">{{ formMsg }}</p>
          <button class="iv-btn" type="submit" :disabled="busy">{{ busy ? '提交中…' : '完成注册并登录' }}</button>
          <p class="iv-muted" style="font-size: 12px; margin-top: 10px">
            这个邀请只能用一次。密码由你自己设置，业务员不会知道。
          </p>
        </form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mallApi as api, setMallAuth } from '../../api/mall';

const route = useRoute();
const router = useRouter();
const token = route.params.token;
const loading = ref(true);
const err = ref('');
const info = ref(null);
const busy = ref(false);
const formMsg = ref('');
const form = reactive({ username: '', name: '', phone: '', email: '', password: '', password2: '' });

const maskedContact = computed(() => {
  const c = String((info.value && info.value.contact) || '');
  if (!c) return '-';
  if (c.includes('@')) {
    const [a, d] = c.split('@');
    return a.slice(0, 2) + '***@' + d;
  }
  return c.slice(0, 3) + '****' + c.slice(-2);
});

async function submit() {
  formMsg.value = '';
  if (!form.username || form.username.length < 4) return (formMsg.value = '登录账号至少 4 位');
  if (!form.name) return (formMsg.value = '请填姓名或称呼');
  if (!form.password || form.password.length < 6) return (formMsg.value = '密码至少 6 位');
  if (form.password !== form.password2) return (formMsg.value = '两次密码不一致');
  busy.value = true;
  try {
    const r = await api.acceptInvite(token, {
      username: form.username, password: form.password, name: form.name,
      phone: form.phone || null, email: form.email || null
    });
    setMallAuth(r.token, r.account);
    router.push('/mall');
  } catch (e) { formMsg.value = e.message; } finally { busy.value = false; }
}

onMounted(async () => {
  try {
    info.value = await api.inviteInfo(token);
  } catch (e) { err.value = e.message; } finally { loading.value = false; }
});
</script>

<style scoped>
.iv-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #eef3fb 0%, var(--surface-2) 60%, #eef6f3 100%); padding: 24px; }
.iv-card { width: 460px; max-width: 100%; background: var(--surface); border: 1px solid #e6ebf3; border-radius: 16px; padding: 26px 26px 22px; box-shadow: 0 12px 32px rgba(22, 35, 59, 0.08); }
.iv-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
.iv-logo { width: 38px; height: 38px; border-radius: 11px; background: #16233b; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; }
.iv-co { font-size: 14.5px; font-weight: 700; color: var(--ink); }
.iv-sub { font-size: 12px; color: var(--ink-mute); margin-top: 2px; }
.iv-info { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: #f8fafd; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 16px; }
.iv-info span { display: block; font-size: 12px; color: var(--ink-mute); }
.iv-info b { font-size: 13px; color: var(--ink); }
.iv-form { display: flex; flex-direction: column; gap: 10px; }
.iv-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5b6474; }
.iv-btn { margin-top: 6px; border: none; border-radius: 10px; background: var(--brand); color: var(--on-brand); font-size: 14px; font-weight: 600; padding: 11px 0; cursor: pointer; }
.iv-btn:disabled { background: #a8c0ee; cursor: default; }
.iv-err { background: #fff8f9; border: 1px solid #f8d3d8; border-radius: 8px; padding: 9px 11px; font-size: 12.5px; color: #b91c1c; line-height: 1.6; }
.iv-muted { font-size: 12.5px; color: var(--ink-mute); }
</style>
