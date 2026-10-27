<template>
  <div class="mg-wrap">
    <header class="mg-head">
      <div class="mg-brand"><span class="mg-logo">跳</span> 跳色科技 · 公开选品目录</div>
      <router-link class="mg-login" to="/mall/login">登录查看价格 →</router-link>
    </header>

    <div class="mg-body">
      <div class="mg-search">
        <input v-model="q" placeholder="搜索款号 / 名称" @keyup.enter="load" />
        <button @click="load">搜索</button>
      </div>
      <p class="mg-tip">访客可浏览款式概览；登录后可查看专属价格、起订量、现货数量并提交选品询价。</p>

      <div v-if="!list.length" class="mg-empty">没有匹配的款式</div>
      <div v-else class="mg-grid">
        <div v-for="p in list" :key="p.id" class="mg-card">
          <div class="mg-cover" :style="p.cover_image ? { backgroundImage: 'url(' + p.cover_image + ')' } : {}">
            <span v-if="!p.cover_image">{{ (p.name_cn || '款').slice(0, 2) }}</span>
          </div>
          <div class="mg-name">{{ p.name_cn }}</div>
          <div class="mg-sub">{{ p.style_no || '-' }} · {{ p.category || '成衣' }}</div>
          <div class="mg-lock">🔒 登录可见价格</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { mallApi } from '../../api/mall';

const q = ref('');
const list = ref([]);

async function load() {
  try { list.value = await mallApi.publicProducts(q.value); } catch (e) { alert(e.message); }
}
onMounted(load);
</script>

<style scoped>
.mg-wrap { min-height: 100vh; background: #f5f7fb; }
.mg-head { background: linear-gradient(90deg, #12365f, #1f5fae); color: #fff; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.mg-brand { display: flex; align-items: center; gap: 9px; font-size: 14.5px; font-weight: 700; }
.mg-logo { width: 30px; height: 30px; border-radius: 9px; background: rgba(255, 255, 255, 0.18); display: flex; align-items: center; justify-content: center; font-weight: 800; }
.mg-login { color: #fff; font-size: 12.5px; background: rgba(255, 255, 255, 0.16); padding: 6px 12px; border-radius: 20px; }
.mg-body { max-width: 1100px; margin: 0 auto; padding: 14px; }
.mg-search { display: flex; gap: 8px; }
.mg-search input { flex: 1; padding: 10px 13px; border: 1px solid #d8e1ee; border-radius: 10px; font-size: 13.5px; }
.mg-search button { padding: 10px 16px; border: 1px solid #1f5fae; background: #1f5fae; color: #fff; border-radius: 10px; cursor: pointer; }
.mg-tip { font-size: 11.5px; color: #8a9ab0; margin: 10px 0 14px; }
.mg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.mg-card { background: #fff; border: 1px solid #e8eef7; border-radius: 12px; overflow: hidden; padding-bottom: 10px; }
.mg-cover { height: 120px; background: #eef3fa center/cover no-repeat; display: flex; align-items: center; justify-content: center; color: #b9c9dd; font-weight: 800; font-size: 20px; }
.mg-name { padding: 9px 12px 0; font-size: 13.5px; font-weight: 700; color: #16233b; }
.mg-sub { padding: 2px 12px 0; font-size: 11.5px; color: #8a9ab0; }
.mg-lock { padding: 6px 12px 0; font-size: 11.5px; color: #b0894b; }
.mg-empty { text-align: center; color: #9aa8bc; padding: 60px 0; font-size: 13px; }
</style>
