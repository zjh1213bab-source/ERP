<template>
  <div class="mh-wrap">
    <div class="mh-head">
      <div>
        <div class="mh-hi">{{ greeting }}，{{ auth.user?.name || auth.user?.username }}</div>
        <div class="mh-sub">{{ roleLabel }} · {{ today }}</div>
      </div>
      <button class="mh-out" @click="logout">退出</button>
    </div>

    <!-- 扫码 / 输单号：车间最常用的入口放最上面 -->
    <div class="mh-scan">
      <input
        v-model="code"
        class="mh-input"
        placeholder="扫单号条形码，或直接输入订单号"
        @keyup.enter="go"
      />
      <button class="mh-go" @click="go">查</button>
    </div>
    <div class="mh-hint">扫工单上的条码 / 二维码，或手输单号（如 SO202610260005）</div>

    <div class="mh-grid">
      <button class="mh-card primary" @click="goPage('/m/report')">
        <span class="mh-icon">📝</span>
        <b>扫码报工</b>
        <small>做完一道工序就报</small>
      </button>
      <button class="mh-card" @click="goPage('/inventory')">
        <span class="mh-icon">📦</span>
        <b>查库存</b>
        <small>款色码数量</small>
      </button>
      <button class="mh-card" @click="goPage('/approvals')">
        <span class="mh-icon">✅</span>
        <b>待我审批</b>
        <small>技术 / 财务 / 分单</small>
      </button>
      <button class="mh-card" @click="goPage('/dashboard')">
        <span class="mh-icon">📊</span>
        <b>电脑版</b>
        <small>工作台全功能</small>
      </button>
    </div>

    <div class="mh-sec">
      <div class="mh-sec-h">
        <b>最近订单</b>
        <button class="mh-more" @click="goPage('/orders')">全部 ›</button>
      </div>
      <div v-if="loading" class="mh-empty">加载中…</div>
      <div v-else-if="!recent.length" class="mh-empty">没有订单</div>
      <button v-for="o in recent" :key="o.id" class="mh-row" @click="open(o)">
        <div class="mh-row-main">
          <div class="mh-row-no">{{ o.order_no }}</div>
          <div class="mh-row-style">{{ o.style_name || '（未填款名）' }}</div>
        </div>
        <div class="mh-row-right">
          <span class="mh-tag" :class="tagClass(o.status)">{{ statusLabel(o.status) }}</span>
          <span class="mh-row-date">{{ o.delivery_date || '' }}</span>
        </div>
      </button>
    </div>

    <div class="mh-tip">
      手机上建议把本页加到桌面：浏览器菜单 →「添加到主屏幕」。<br />
      摄像头扫码需要 HTTPS；用系统相机扫工单上的二维码可以直接打开单据。
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { auth, clearAuth, ROLE_LABELS } from '../store/auth';

const router = useRouter();
const code = ref('');
const recent = ref([]);
const loading = ref(true);

const today = new Date().toLocaleDateString('zh-CN');
const roleLabel = computed(() => ROLE_LABELS[auth.user?.role] || auth.user?.role || '');
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '夜里好';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

const STATUS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案',
  cancelled: '已取消'
};
function statusLabel(s) { return STATUS[s] || s; }
function tagClass(s) {
  if (s === 'closed' || s === 'shipped' || s === 'instock') return 'green';
  if (s === 'cancelled') return 'red';
  if (s === 'production' || s === 'assigned') return 'blue';
  return 'orange';
}

function go() {
  const no = code.value.trim();
  if (!no) return;
  router.push('/s/' + encodeURIComponent(no));
}

function goPage(p) {
  router.push(p);
}

function open(o) {
  router.push({ path: '/orders', query: { order: o.id } });
}

function logout() {
  clearAuth();
  router.push('/login');
}

onMounted(async () => {
  try {
    const list = await api.orders({});
    recent.value = (Array.isArray(list) ? list : []).slice(0, 6);
  } catch (e) {
    recent.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.mh-wrap {
  max-width: 560px;
  margin: 0 auto;
  padding: 18px 14px 40px;
  min-height: 100vh;
  background: #f2f5fa;
}
.mh-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}
.mh-hi {
  font-size: 18px;
  font-weight: 800;
  color: #16233b;
}
.mh-sub {
  font-size: 12px;
  color: #8a94a6;
  margin-top: 4px;
}
.mh-out {
  border: 1px solid #dbe3ef;
  background: #fff;
  color: #6b7688;
  border-radius: 9px;
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.mh-scan {
  display: flex;
  gap: 8px;
}
.mh-input {
  flex: 1;
  border: 1px solid #d9e1ee;
  border-radius: 12px;
  padding: 14px 14px;
  font-size: 15px;
  background: #fff;
}
.mh-go {
  flex: none;
  width: 62px;
  border: none;
  border-radius: 12px;
  background: #2563eb;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}
.mh-hint {
  font-size: 11.5px;
  color: #a6b0c0;
  margin: 8px 0 16px;
  line-height: 1.7;
}
.mh-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 18px;
}
.mh-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 16px 14px;
  border-radius: 14px;
  border: 1px solid #e6ebf3;
  background: #fff;
  cursor: pointer;
  text-align: left;
}
.mh-card.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.mh-card b {
  font-size: 15px;
}
.mh-card small {
  font-size: 11.5px;
  color: #8a94a6;
}
.mh-card.primary small {
  color: rgba(255, 255, 255, 0.78);
}
.mh-icon {
  font-size: 20px;
  line-height: 1.2;
}
.mh-sec {
  background: #fff;
  border-radius: 14px;
  padding: 4px 0 6px;
  border: 1px solid #e6ebf3;
}
.mh-sec-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
}
.mh-sec-h b {
  font-size: 14px;
}
.mh-more {
  border: none;
  background: none;
  color: #2563eb;
  font-size: 12.5px;
  cursor: pointer;
}
.mh-empty {
  padding: 24px 14px;
  text-align: center;
  color: #a6b0c0;
  font-size: 12.5px;
}
.mh-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 11px 14px;
  border: none;
  border-top: 1px solid #f2f5fa;
  background: #fff;
  cursor: pointer;
  text-align: left;
}
.mh-row:active {
  background: #f7faff;
}
.mh-row-no {
  font-size: 13.5px;
  font-weight: 700;
  color: #16233b;
}
.mh-row-style {
  font-size: 12px;
  color: #8a94a6;
  margin-top: 2px;
}
.mh-row-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex: none;
}
.mh-tag {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 20px;
  font-weight: 700;
}
.mh-tag.green { background: #e6f7ec; color: #16a34a; }
.mh-tag.blue { background: #e8f0ff; color: #2563eb; }
.mh-tag.orange { background: #fff2e0; color: #d97706; }
.mh-tag.red { background: #fdecee; color: #d92d45; }
.mh-row-date {
  font-size: 11px;
  color: #b3bcca;
}
.mh-tip {
  margin-top: 16px;
  font-size: 11.5px;
  color: #a6b0c0;
  line-height: 1.9;
  text-align: center;
}
</style>
