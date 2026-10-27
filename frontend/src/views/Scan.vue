<template>
  <div>
    <div class="page-head">
      <div>
        <h2>扫码查询</h2>
        <div class="sub">扫标签条码或手动输入标签码，快速打开订单</div>
      </div>
    </div>

    <div class="panel-card">
      <h3>输入 / 扫描标签码</h3>
      <div class="toolbar" style="margin-bottom: 10px">
        <input class="input" v-model="code" placeholder="如 SO202610260003-LEJE-WY-003-110" @keyup.enter="search" style="flex: 1" />
        <button class="btn btn-primary" :disabled="loading" @click="search">{{ loading ? '查询中…' : '查询' }}</button>
        <button v-if="canScan" class="btn btn-ghost" @click="toggleScan">{{ scanning ? '停止扫描' : '摄像头扫描' }}</button>
      </div>

      <div v-if="scanning" style="margin-top: 10px">
        <video ref="videoRef" autoplay playsinline muted style="width: 100%; max-width: 420px; border-radius: 10px; background: #000"></video>
        <p style="font-size: 12px; color: #8a94a6">将条码对准摄像头…</p>
      </div>

      <p v-if="msg" class="form-msg" :class="msgType">{{ msg }}</p>
    </div>

    <div v-if="result" class="panel-card">
      <h3>查询结果</h3>
      <div class="form-grid">
        <div><span style="color: #8a94a6; font-size: 12.5px">订单号</span><div><strong>{{ result.order_no }}</strong></div></div>
        <div><span style="color: #8a94a6; font-size: 12.5px">款名</span><div>{{ result.style_name || '-' }}</div></div>
        <div><span style="color: #8a94a6; font-size: 12.5px">状态</span><div>{{ statusLabel(result.status) }}</div></div>
      </div>
      <div style="margin-top: 12px; display: flex; gap: 10px">
        <button class="btn btn-primary btn-sm" @click="openOrder">打开订单</button>
        <button class="btn btn-ghost btn-sm" @click="openPrint">打印生产单</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();
const code = ref('');
const loading = ref(false);
const msg = ref('');
const msgType = ref('err');
const result = ref(null);

const scanning = ref(false);
const videoRef = ref(null);
let stream = null;
let detector = null;
let rafId = null;

const canScan = computed(() => typeof window !== 'undefined' && 'BarcodeDetector' in window);
const S = { draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单', production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消' };
const statusLabel = (s) => S[s] || s;

async function search() {
  if (!code.value.trim()) return;
  loading.value = true;
  msg.value = '';
  result.value = null;
  try {
    result.value = await api.findOrder(code.value.trim());
  } catch (e) {
    msgType.value = 'err';
    msg.value = e.message;
  } finally {
    loading.value = false;
  }
}
function openOrder() { if (result.value) router.push('/orders?order=' + result.value.id); }
function openPrint() { if (result.value) window.open('/print/production/' + result.value.id, '_blank'); }

async function toggleScan() {
  if (scanning.value) return stopScan();
  try {
    detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'qr_code', 'ean_13'] });
  } catch (e) { detector = null; }
  if (!detector) { msgType.value = 'err'; msg.value = '当前浏览器不支持条码识别，请手动输入'; return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    scanning.value = true;
    if (videoRef.value) {
      videoRef.value.srcObject = stream;
      await videoRef.value.play();
    }
    loop();
  } catch (e) {
    msgType.value = 'err';
    msg.value = '无法打开摄像头：' + e.message;
  }
}
async function loop() {
  if (!scanning.value || !videoRef.value) return;
  try {
    const codes = await detector.detect(videoRef.value);
    if (codes && codes.length) {
      code.value = codes[0].rawValue;
      stopScan();
      await search();
      return;
    }
  } catch (e) { /* ignore */ }
  rafId = setTimeout(loop, 350);
}
function stopScan() {
  scanning.value = false;
  if (rafId) { clearTimeout(rafId); rafId = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
onBeforeUnmount(stopScan);
</script>
