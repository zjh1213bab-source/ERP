<template>
  <div class="mr-wrap">
    <div class="mr-bar">
      <button class="mr-back" @click="back">‹</button>
      <b>扫码报工</b>
      <span v-if="order" class="mr-no">{{ order.order_no }}</span>
    </div>

    <!-- 第一步：找单 -->
    <div v-if="!order" class="mr-card">
      <div class="mr-label">订单号</div>
      <div class="mr-scan">
        <input v-model="codeInput" class="mr-input" placeholder="扫工单条码或输入单号" @keyup.enter="loadOrder(codeInput)" />
        <button class="mr-go" @click="loadOrder(codeInput)">查</button>
      </div>
      <p class="mr-hint">扫工单上的条码就能带出单号；输入后按回车也行。</p>
      <div v-if="err" class="mr-err">{{ err }}</div>
    </div>

    <!-- 第二步：选工序 -->
    <template v-else>
      <div class="mr-card">
        <div class="mr-order">
          <div class="mr-style">{{ order.style_name || '（未填款名）' }}</div>
          <div class="mr-tags">
            <span class="mr-tag blue">{{ statusLabel(order.status) }}</span>
            <span v-if="order.delivery_date" class="mr-tag gray">交期 {{ order.delivery_date }}</span>
          </div>
        </div>
        <button class="mr-link" @click="order = null">换一张单</button>
      </div>

      <div class="mr-card">
        <div class="mr-label">选工序（点一下就报）</div>
        <div class="mr-nodes">
          <button
            v-for="n in nodes"
            :key="n.id"
            class="mr-node"
            :class="{ done: n.status === 'done', doing: n.status === 'doing' }"
            @click="pick(n)"
          >
            <div class="mr-node-main">
              <b>{{ n.name }}</b>
              <span class="mr-node-sub">
                {{ n.status === 'done' ? '已完成' : n.status === 'doing' ? '进行中' : '待开始' }}
                <template v-if="reportMap[n.id]"> · 已报 {{ reportMap[n.id].ok }}<template v-if="reportMap[n.id].defect"> / 不良 {{ reportMap[n.id].defect }}</template></template>
              </span>
            </div>
            <span class="mr-node-qty">{{ reportMap[n.id] ? reportMap[n.id].ok : '' }}</span>
          </button>
          <div v-if="!nodes.length" class="mr-empty">这单还没有工序（订单进生产后会自动生成 13 道）</div>
        </div>
      </div>
    </template>

    <!-- 第三步：填数（底部抽屉） -->
    <div v-if="picked" class="mr-mask" @click.self="picked = null">
      <div class="mr-sheet">
        <div class="mr-sheet-h">
          <b>{{ picked.name }}</b>
          <button class="mr-x" @click="picked = null">×</button>
        </div>
        <div class="mr-fields">
          <label>
            合格数
            <input v-model.number="form.qty_ok" type="number" inputmode="numeric" min="0" class="mr-num" />
          </label>
          <label>
            不良数
            <input v-model.number="form.qty_defect" type="number" inputmode="numeric" min="0" class="mr-num" />
          </label>
          <label>
            工时
            <input v-model.number="form.hours" type="number" inputmode="decimal" min="0" step="0.5" class="mr-num" />
          </label>
        </div>
        <input v-model="form.remark" class="mr-input" placeholder="备注（不良原因写这里）" />
        <div v-if="err" class="mr-err">{{ err }}</div>
        <button class="mr-submit" :disabled="saving" @click="submit">
          {{ saving ? '提交中…' : '提交报工' }}
        </button>
        <p class="mr-hint" style="text-align: center">
          报工人：{{ auth.user?.name || auth.user?.username }} · 日期：{{ today }}
        </p>
      </div>
    </div>

    <div v-if="toastMsg" class="mr-toast">{{ toastMsg }}</div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { auth } from '../store/auth';

const route = useRoute();
const router = useRouter();

const codeInput = ref(String(route.query.no || ''));
const order = ref(null);
const nodes = ref([]);
const reports = ref([]);
const picked = ref(null);
const saving = ref(false);
const err = ref('');
// 本地日期：toISOString 是 UTC，晚上 8 点后（GMT+8）会算成"昨天"
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const today = localDate();

const form = reactive({ qty_ok: 0, qty_defect: 0, hours: 0, remark: '' });

const STATUS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};
function statusLabel(s) { return STATUS[s] || s; }

const reportMap = computed(() => {
  const m = {};
  (reports.value || []).forEach((r) => {
    if (!r.node_id) return;
    m[r.node_id] = { ok: Number(r.ok) || 0, defect: Number(r.defect) || 0 };
  });
  return m;
});

async function loadOrder(raw) {
  const no = String(raw || '').trim();
  if (!no) return;
  err.value = '';
  try {
    const o = await api.findOrder(no);
    await openOrder(o.id);
  } catch (e) {
    err.value = e.message || '没找到这张单';
    order.value = null;
  }
}

async function openOrder(id) {
  const [full, nd, rep] = await Promise.all([
    api.order(id),
    api.orderNodes(id).catch(() => []),
    api.reportSummary(id).catch(() => [])
  ]);
  order.value = full;
  nodes.value = nd || [];
  reports.value = Array.isArray(rep) ? rep : [];
}

function pick(n) {
  picked.value = n;
  form.qty_ok = 0;
  form.qty_defect = 0;
  form.hours = 0;
  form.remark = '';
  err.value = '';
}

async function submit() {
  if (!order.value || !picked.value) return;
  if (!form.qty_ok && !form.qty_defect) {
    err.value = '合格数和不良数至少填一个';
    return;
  }
  saving.value = true;
  err.value = '';
  try {
    await api.createReport({
      order_id: order.value.id,
      node_id: picked.value.id,
      qty_ok: Number(form.qty_ok) || 0,
      qty_defect: Number(form.qty_defect) || 0,
      hours: Number(form.hours) || 0,
      remark: form.remark || '',
      report_date: today
    });
    picked.value = null;
    // 重新拉一次累计，让工人看到刚报的数
    const rep = await api.reportSummary(order.value.id).catch(() => []);
    reports.value = Array.isArray(rep) ? rep : [];
    const nd = await api.orderNodes(order.value.id).catch(() => []);
    nodes.value = nd || [];
    toast('报工成功');
  } catch (e) {
    err.value = e.message || '提交失败';
  } finally {
    saving.value = false;
  }
}

const toastMsg = ref('');
let toastTimer = null;
function toast(msg) {
  toastMsg.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2200);
}

function back() {
  if (window.history.length > 1) router.back();
  else router.push('/m');
}

onMounted(() => {
  if (route.query.no) loadOrder(route.query.no);
});
</script>

<style scoped>
.mr-wrap {
  max-width: 560px;
  margin: 0 auto;
  padding: 14px 14px 40px;
  min-height: 100vh;
  background: #f2f5fa;
}
.mr-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.mr-back {
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
.mr-bar b { font-size: 15px; }
.mr-no {
  margin-left: auto;
  font-size: 12px;
  color: #8a94a6;
}
.mr-card {
  background: #fff;
  border-radius: 14px;
  padding: 16px 14px;
  border: 1px solid #e6ebf3;
  margin-bottom: 12px;
}
.mr-label {
  font-size: 12.5px;
  color: #6b7688;
  margin-bottom: 8px;
  font-weight: 600;
}
.mr-scan { display: flex; gap: 8px; }
.mr-input {
  flex: 1;
  width: 100%;
  border: 1px solid #d9e1ee;
  border-radius: 11px;
  padding: 13px 13px;
  font-size: 15px;
  background: #fff;
}
.mr-go {
  flex: none;
  width: 58px;
  border: none;
  border-radius: 11px;
  background: #2563eb;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}
.mr-hint {
  font-size: 11.5px;
  color: #a6b0c0;
  margin: 8px 0 0;
  line-height: 1.7;
}
.mr-err {
  margin-top: 10px;
  font-size: 12.5px;
  color: #d92d45;
  background: #fef5f6;
  border: 1px solid #f3c3cb;
  border-radius: 9px;
  padding: 8px 11px;
  line-height: 1.7;
}
.mr-order { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mr-style { font-size: 15px; font-weight: 700; color: #16233b; }
.mr-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.mr-tag {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 20px;
  font-weight: 700;
}
.mr-tag.blue { background: #e8f0ff; color: #2563eb; }
.mr-tag.gray { background: #eef1f6; color: #6b7688; }
.mr-link {
  margin-top: 10px;
  border: none;
  background: none;
  color: #2563eb;
  font-size: 12.5px;
  padding: 0;
  cursor: pointer;
}
.mr-nodes { display: flex; flex-direction: column; gap: 8px; }
.mr-node {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 13px;
  border-radius: 11px;
  border: 1px solid #e6ebf3;
  background: #fff;
  cursor: pointer;
  text-align: left;
}
.mr-node:active { background: #f7faff; }
.mr-node.done { background: #f7fdf9; border-color: #cfe8d8; }
.mr-node.doing { background: #f6faff; border-color: #cfe0ff; }
.mr-node-main { display: flex; flex-direction: column; gap: 3px; }
.mr-node-main b { font-size: 14px; color: #1f2a3d; }
.mr-node-sub { font-size: 11.5px; color: #8a94a6; }
.mr-node-qty {
  font-size: 13px;
  font-weight: 800;
  color: #2563eb;
  min-width: 34px;
  text-align: right;
}
.mr-empty { padding: 20px 0; text-align: center; color: #a6b0c0; font-size: 12.5px; }

/* 底部抽屉 */
.mr-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 26, 46, 0.42);
  display: flex;
  align-items: flex-end;
  z-index: 60;
}
.mr-sheet {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  background: #fff;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
}
.mr-sheet-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.mr-sheet-h b { font-size: 16px; }
.mr-x {
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  color: #a6b0c0;
  cursor: pointer;
}
.mr-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
  margin-bottom: 10px;
}
.mr-fields label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: #6b7688;
  min-width: 0; /* 不加这行，input 的默认宽度会把三列撑出屏幕，工时框就看不见了 */
}
.mr-num {
  width: 100%;
  min-width: 0;
  border: 1px solid #d9e1ee;
  border-radius: 10px;
  padding: 11px 10px;
  font-size: 17px;
  font-weight: 700;
  text-align: center;
  color: #16233b;
}
.mr-submit {
  width: 100%;
  margin-top: 14px;
  padding: 15px;
  border: none;
  border-radius: 13px;
  background: #2563eb;
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.mr-submit:disabled { background: #9db8ea; }
.mr-toast {
  position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%);
  background: rgba(22, 35, 59, 0.92); color: #fff; font-size: 13.5px;
  padding: 10px 20px; border-radius: 22px; z-index: 70;
}
</style>
