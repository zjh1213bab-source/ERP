<template>
  <div class="sg-wrap">
    <div class="sg-bar">
      <button class="sg-back" @click="back">‹</button>
      <b>扫码结果</b>
      <span class="sg-code">{{ code }}</span>
    </div>

    <div v-if="loading" class="sg-loading">正在查询…</div>

    <div v-else-if="order" class="sg-card">
      <div class="sg-no">{{ order.order_no }}</div>
      <div class="sg-style">{{ order.style_name || '（未填款名）' }}</div>

      <div class="sg-tags">
        <span class="sg-tag" :class="tagClass">{{ statusLabel }}</span>
        <span v-if="order.delivery_date" class="sg-tag gray">交期 {{ order.delivery_date }}</span>
      </div>

      <div class="sg-ops">
        <button class="sg-btn primary" @click="openOrder">
          打开订单
          <span>看工序、改状态、加附件</span>
        </button>
        <button class="sg-btn" @click="goReport">
          快速报工
          <span>车间做完一道工序就报</span>
        </button>
        <button class="sg-btn" @click="openPrint">
          打印工单
          <span>需要连打印机或存 PDF</span>
        </button>
      </div>
    </div>

    <div v-else class="sg-card">
      <div class="sg-fail">没有找到对应的单据</div>
      <p class="sg-hint">
        扫到的码是 <code>{{ code }}</code>。<br />
        可能是：码不属于订单（例如扎号、款号），或者这单已被删除。
      </p>
      <div class="sg-manual">
        <input v-model="manual" class="sg-input" placeholder="直接输入订单号，如 SO202610260005" @keyup.enter="search(manual)" />
        <button class="sg-btn primary" @click="search(manual)">查询</button>
      </div>
    </div>

    <div class="sg-tip">
      提示：把这张码用手机相机或微信扫一扫打开，可以直接进这个页面。
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const route = useRoute();
const router = useRouter();

const code = computed(() => String(route.params.code || ''));
const loading = ref(true);
const order = ref(null);
const manual = ref('');

const STATUS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案',
  cancelled: '已取消'
};
const statusLabel = computed(() => (order.value ? STATUS[order.value.status] || order.value.status : ''));
const tagClass = computed(() => {
  const s = order.value && order.value.status;
  if (s === 'closed' || s === 'shipped' || s === 'instock') return 'green';
  if (s === 'cancelled') return 'red';
  if (s === 'production' || s === 'assigned') return 'blue';
  return 'orange';
});

async function search(raw) {
  const no = String(raw || '').trim();
  if (!no) return;
  loading.value = true;
  order.value = null;
  try {
    order.value = await api.findOrder(no);
  } catch (e) {
    order.value = null;
  } finally {
    loading.value = false;
  }
}

function openOrder() {
  if (!order.value) return;
  // 订单列表已支持 ?order=<id> 自动打开详情弹窗
  router.push({ path: '/orders', query: { order: order.value.id } });
}

function goReport() {
  if (!order.value) return;
  router.push({ path: '/m/report', query: { no: order.value.order_no } });
}

function openPrint() {
  if (!order.value) return;
  router.push(`/print/production/${order.value.id}`);
}

function back() {
  if (window.history.length > 1) router.back();
  else router.push('/dashboard');
}

onMounted(() => search(code.value));
watch(code, (v) => search(v));
</script>

<style scoped>
/* 移动优先：车间工人单手操作，按钮要大 */
.sg-wrap {
  max-width: 560px;
  margin: 0 auto;
  padding: 14px 14px 40px;
  min-height: 100vh;
  background: #f2f5fa;
}
.sg-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.sg-back {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid #dbe3ef;
  background: #fff;
  font-size: 20px;
  line-height: 1;
  color: #33415a;
  cursor: pointer;
}
.sg-bar b {
  font-size: 15px;
}
.sg-code {
  margin-left: auto;
  font-size: 11.5px;
  color: #8a94a6;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sg-loading {
  padding: 50px 0;
  text-align: center;
  color: #8a94a6;
  font-size: 13px;
}
.sg-card {
  background: #fff;
  border-radius: 16px;
  padding: 20px 18px;
  box-shadow: 0 2px 12px rgba(16, 32, 64, 0.06);
}
.sg-no {
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 0.4px;
  color: #16233b;
}
.sg-style {
  margin-top: 5px;
  font-size: 14px;
  color: #4a5568;
}
.sg-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.sg-tag {
  font-size: 12px;
  padding: 3px 11px;
  border-radius: 20px;
  font-weight: 700;
}
.sg-tag.green { background: #e6f7ec; color: #16a34a; }
.sg-tag.blue { background: #e8f0ff; color: #2563eb; }
.sg-tag.orange { background: #fff2e0; color: #d97706; }
.sg-tag.red { background: #fdecee; color: #d92d45; }
.sg-tag.gray { background: #eef1f6; color: #6b7688; font-weight: 600; }

.sg-ops {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sg-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid #dbe3ef;
  background: #fff;
  color: #1f2a3d;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  text-align: left;
}
.sg-btn span {
  font-size: 11.5px;
  font-weight: 500;
  color: #8a94a6;
}
.sg-btn.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.sg-btn.primary span {
  color: rgba(255, 255, 255, 0.78);
}
.sg-btn:active {
  transform: scale(0.99);
}
.sg-fail {
  font-size: 16px;
  font-weight: 700;
  color: #d92d45;
}
.sg-hint {
  font-size: 12.5px;
  color: #6b7688;
  line-height: 1.9;
  margin: 8px 0 0;
}
.sg-hint code {
  background: #f2f5fa;
  padding: 1px 6px;
  border-radius: 5px;
}
.sg-manual {
  margin-top: 16px;
  display: flex;
  gap: 8px;
}
.sg-input {
  flex: 1;
  border: 1px solid #d9e1ee;
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 14px;
}
.sg-manual .sg-btn {
  width: auto;
  flex: none;
  padding: 11px 18px;
}
.sg-tip {
  margin-top: 16px;
  font-size: 11.5px;
  color: #a6b0c0;
  line-height: 1.8;
  text-align: center;
}
</style>
