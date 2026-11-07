<template>
  <div class="mp-wrap">
    <div class="mp-bar">
      <button class="mp-back" @click="back">‹</button>
      <b>拍照留证</b>
      <span v-if="order" class="mp-no">{{ order.order_no }}</span>
    </div>

    <!-- 第一步：找单 -->
    <div v-if="!order" class="mp-card">
      <div class="mp-label">挂到哪张单</div>
      <div class="mp-scan">
        <input v-model="codeInput" class="mp-input" placeholder="扫工单码或输入订单号" @keyup.enter="loadOrder(codeInput)" />
        <button class="mp-go" @click="loadOrder(codeInput)">查</button>
      </div>
      <p class="mp-hint">照片要挂在订单上才有意义，否则三个月后没人知道这张图是哪一单的。</p>
      <div v-if="err" class="mp-err">{{ err }}</div>
    </div>

    <template v-else>
      <!-- 订单 -->
      <div class="mp-card mp-order">
        <div>
          <div class="mp-style">{{ order.style_name || '（未填款名）' }}</div>
          <div class="mp-tags">
            <span class="mp-tag blue">{{ statusLabel(order.status) }}</span>
            <span v-if="order.delivery_date" class="mp-tag gray">交期 {{ order.delivery_date }}</span>
          </div>
        </div>
        <button class="mp-link" @click="reset">换一张单</button>
      </div>

      <!-- 分类 -->
      <div class="mp-card">
        <div class="mp-label">这是什么照片</div>
        <div class="mp-cats">
          <button
            v-for="c in cats"
            :key="c.code"
            class="mp-cat"
            :class="{ on: cat === c.code }"
            @click="cat = c.code"
          >
            {{ c.label }}
          </button>
        </div>
        <p class="mp-hint">{{ catHint }}</p>

        <div class="mp-label" style="margin-top: 14px">工序（可选）</div>
        <select v-model="nodeId" class="mp-input mp-select">
          <option :value="null">不指定工序</option>
          <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }}</option>
        </select>

        <div class="mp-label" style="margin-top: 14px">
          说明
          <span v-if="cat === 'defect'" class="mp-req">必填</span>
        </div>
        <input v-model="note" class="mp-input" :placeholder="notePlaceholder" maxlength="80" />
        <p v-if="cat === 'defect'" class="mp-hint">
          不良照片必须写一句是什么问题，比如「左袖口跳线」「前片沾污」。只写「不良」等于没写。
        </p>
      </div>

      <!-- 拍照 -->
      <div class="mp-card">
        <div class="mp-label">拍照（已选 {{ shots.length }} 张）</div>
        <div class="mp-actions">
          <button class="mp-shot-btn" @click="cameraInput.click()">
            <span class="mp-shot-icon">📷</span>
            <b>拍一张</b>
          </button>
          <button class="mp-shot-btn ghost" @click="albumInput.click()">
            <span class="mp-shot-icon">🖼️</span>
            <b>从相册选</b>
          </button>
        </div>
        <!-- capture=environment：直接调后置摄像头，不经过文件管理器 -->
        <input ref="cameraInput" type="file" accept="image/*" capture="environment" class="mp-file" @change="onPick" />
        <input ref="albumInput" type="file" accept="image/*" multiple class="mp-file" @change="onPick" />

        <div v-if="shots.length" class="mp-thumbs">
          <div v-for="(s, i) in shots" :key="i" class="mp-thumb">
            <img :src="s.dataUrl" alt="" />
            <button class="mp-del" @click="shots.splice(i, 1)">×</button>
            <span class="mp-thumb-kb">{{ s.kb }}KB</span>
          </div>
        </div>

        <div v-if="busy" class="mp-busy">{{ busyText }}</div>
        <div v-if="err" class="mp-err">{{ err }}</div>

        <button class="mp-submit" :disabled="busy || !shots.length" @click="upload">
          {{ busy ? '处理中…' : `上传 ${shots.length} 张` }}
        </button>
        <p class="mp-hint" style="text-align: center">
          {{ auth.user?.name || auth.user?.username }} · {{ takenAt }}
        </p>
      </div>

      <!-- 已上传的 -->
      <div class="mp-card">
        <div class="mp-label">这单已上传的照片（{{ mine.length }}）</div>
        <div v-if="!mine.length" class="mp-empty">还没有照片</div>
        <div v-else class="mp-thumbs">
          <div v-for="p in mine" :key="p.id" class="mp-thumb" @click="preview = p">
            <img :src="p.url" alt="" />
            <span class="mp-thumb-cat" :class="p.cat">{{ p.cat_label }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- 大图 -->
    <div v-if="preview" class="mp-mask">
      <div class="mp-view">
        <img :src="preview.url" alt="" />
        <div class="mp-view-meta">
          <b>{{ preview.cat_label }}</b>
          <span v-if="preview.node_name"> · {{ preview.node_name }}</span>
          <div class="mp-view-note">{{ preview.note || '（没写说明）' }}</div>
          <div class="mp-view-sub">{{ preview.shot_at }} · {{ preview.uploader }}</div>
        </div>
        <button class="mp-view-close" @click="preview = null">关闭</button>
      </div>
    </div>

    <div v-if="toastMsg" class="mp-toast">{{ toastMsg }}</div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { auth } from '../store/auth';
import { compressImage, localDateTime } from '../utils/photo';

const route = useRoute();
const router = useRouter();

const codeInput = ref(String(route.query.no || ''));
const order = ref(null);
const nodes = ref([]);
const mine = ref([]);
const shots = ref([]);
const preview = ref(null);
const cat = ref('defect');
const nodeId = ref(null);
const note = ref('');
const err = ref('');
const busy = ref(false);
const busyText = ref('');
const takenAt = ref(localDateTime());
const cameraInput = ref(null);
const albumInput = ref(null);

const cats = ref([
  { code: 'defect', label: '不良', hint: '做坏了、有瑕疵、需要返工' },
  { code: 'incoming', label: '到货', hint: '来料破损、数量不符、包装异常' },
  { code: 'packing', label: '装箱', hint: '装箱现场、混装、箱唛' },
  { code: 'sample', label: '样品', hint: '样衣细节、客户确认的实物' },
  { code: 'other', label: '其他', hint: '现场情况留证' }
]);

const catHint = computed(() => (cats.value.find((c) => c.code === cat.value) || {}).hint || '');
const notePlaceholder = computed(() =>
  cat.value === 'defect' ? '例：左袖口跳线 3 处' : '例：3 箱外箱压损，已拍照报备'
);

const STATUS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};
function statusLabel(s) { return STATUS[s] || s; }

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
  const [full, nd, pics] = await Promise.all([
    api.order(id),
    api.orderNodes(id).catch(() => []),
    api.orderPhotos(id).catch(() => [])
  ]);
  order.value = full;
  nodes.value = nd || [];
  mine.value = pics || [];
  takenAt.value = localDateTime();
}

function reset() {
  order.value = null;
  nodes.value = [];
  mine.value = [];
  shots.value = [];
  note.value = '';
  nodeId.value = null;
}

/**
 * 选完照片立刻压缩。
 * 在这里压而不是上传时压：工人拍完就能看到「这张多大」，拍坏了当场重拍，
 * 而不是等上传失败再猜原因。
 */
async function onPick(e) {
  const files = Array.from((e.target && e.target.files) || []);
  e.target.value = ''; // 清空，否则同一张照片选第二次不触发 change
  if (!files.length) return;
  err.value = '';
  busy.value = true;

  for (let i = 0; i < files.length; i++) {
    busyText.value = `压缩第 ${i + 1}/${files.length} 张…`;
    try {
      const r = await compressImage(files[i]);
      shots.value.push(r);
    } catch (ex) {
      err.value = ex.message || '这张照片处理失败';
    }
  }

  busy.value = false;
  busyText.value = '';
}

async function upload() {
  if (!order.value || !shots.value.length) return;
  if (cat.value === 'defect' && String(note.value).trim().length < 2) {
    err.value = '不良照片必须写一句说明（后端也会拒），比如「左袖口跳线」';
    return;
  }
  busy.value = true;
  err.value = '';
  busyText.value = '上传中…';
  try {
    const payload = shots.value.map((s) => ({
      dataUrl: s.dataUrl,
      cat: cat.value,
      note: note.value || '',
      node_id: nodeId.value || null,
      taken_at: takenAt.value
    }));
    const r = await api.createPhotos({ order_id: order.value.id, photos: payload });
    shots.value = [];
    const okCount = r.saved_count || 0;
    const failCount = r.failed_count || 0;
    if (failCount) {
      err.value = `${okCount} 张成功，${failCount} 张失败：` + (r.failed || []).map((f) => f.message).join('；');
    }
    mine.value = (await api.orderPhotos(order.value.id).catch(() => [])) || [];
    toast(`已上传 ${okCount} 张`);
  } catch (e) {
    err.value = e.message || '上传失败';
  } finally {
    busy.value = false;
    busyText.value = '';
  }
}

const toastMsg = ref('');
let toastTimer = null;
function toast(msg) {
  toastMsg.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2400);
}

function back() {
  if (window.history.length > 1) router.back();
  else router.push('/m');
}

onMounted(async () => {
  try {
    const c = await api.photoCats();
    if (Array.isArray(c) && c.length) cats.value = c;
  } catch (e) { /* 用本地兜底 */ }
  if (route.query.no) loadOrder(route.query.no);
  if (route.query.order) openOrder(Number(route.query.order));
});
</script>

<style scoped>
.mp-wrap {
  max-width: 560px;
  margin: 0 auto;
  padding: 14px 14px 40px;
  min-height: 100vh;
  background: var(--bg);
}
.mp-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.mp-back {
  width: 34px; height: 34px; border-radius: 10px; border: 1px solid #dbe3ef;
  background: var(--surface); font-size: 20px; line-height: 1; color: var(--ink); cursor: pointer;
}
.mp-bar b { font-size: 15px; }
.mp-no { margin-left: auto; font-size: 12px; color: var(--ink-mute); }
.mp-card {
  background: var(--surface); border-radius: 14px; padding: 16px 14px;
  border: 1px solid #e6ebf3; margin-bottom: 12px;
}
.mp-label { font-size: 12.5px; color: var(--ink-soft); margin-bottom: 8px; font-weight: 600; }
.mp-req {
  margin-left: 6px; font-size: 12px; color: #d92d45; background: #fef5f6;
  border: 1px solid #f3c3cb; border-radius: 20px; padding: 1px 7px; font-weight: 700;
}
.mp-scan { display: flex; gap: 8px; }
.mp-input {
  flex: 1; width: 100%; border: 1px solid #d9e1ee; border-radius: 11px;
  padding: 13px; font-size: 15px; background: var(--surface);
}
.mp-select { appearance: none; }
.mp-go {
  flex: none; width: 58px; border: none; border-radius: 11px; background: var(--brand);
  color: var(--on-brand); font-size: 15px; font-weight: 700; cursor: pointer;
}
.mp-hint { font-size: 12px; color: #a6b0c0; margin: 8px 0 0; line-height: 1.7; }
.mp-err {
  margin-top: 10px; font-size: 12.5px; color: #d92d45; background: #fef5f6;
  border: 1px solid #f3c3cb; border-radius: 9px; padding: 8px 11px; line-height: 1.7;
}
.mp-order { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mp-style { font-size: 15px; font-weight: 700; color: var(--ink); }
.mp-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.mp-tag { font-size: 12px; padding: 2px 9px; border-radius: 20px; font-weight: 700; }
.mp-tag.blue { background: #e8f0ff; color: var(--brand); }
.mp-tag.gray { background: #eef1f6; color: var(--ink-soft); }
.mp-link { border: none; background: none; color: var(--brand); font-size: 12.5px; cursor: pointer; }
.mp-cats { display: flex; flex-wrap: wrap; gap: 8px; }
.mp-cat {
  padding: 9px 16px; border-radius: 22px; border: 1px solid #dbe3ef; background: var(--surface);
  font-size: 13.5px; color: #4a5769; cursor: pointer; min-height: 38px;
}
.mp-cat.on { background: var(--brand); border-color: #2563eb; color: var(--on-brand); font-weight: 700; }
.mp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mp-shot-btn {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 16px 10px; border-radius: 13px; border: 1px solid #2563eb;
  background: var(--brand); color: var(--on-brand); font-size: 13.5px; cursor: pointer;
}
.mp-shot-btn.ghost { background: var(--surface); color: var(--brand); }
.mp-shot-icon { font-size: 20px; line-height: 1; }
.mp-file { display: none; }
.mp-thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mp-thumb {
  position: relative; width: 84px; height: 84px; border-radius: 10px;
  overflow: hidden; border: 1px solid #e6ebf3; background: #f4f7fc;
}
.mp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mp-del {
  position: absolute; top: 2px; right: 2px; width: 20px; height: 20px;
  border: none; border-radius: 50%; background: rgba(20, 30, 50, 0.66);
  color: #fff; font-size: 13px; line-height: 1; cursor: pointer;
}
.mp-thumb-kb {
  position: absolute; left: 0; bottom: 0; right: 0; text-align: center;
  font-size: 12px; color: #fff; background: rgba(20, 30, 50, 0.5); padding: 1px 0;
}
.mp-thumb-cat {
  position: absolute; left: 3px; top: 3px; font-size: 12px; padding: 1px 6px;
  border-radius: 20px; background: rgba(255, 255, 255, 0.92); color: var(--brand); font-weight: 700;
}
.mp-thumb-cat.defect { color: #d92d45; }
.mp-busy { margin-top: 12px; font-size: 12.5px; color: var(--brand); }
.mp-submit {
  width: 100%; margin-top: 14px; padding: 15px; border: none; border-radius: 13px;
  background: var(--brand); color: var(--on-brand); font-size: 16px; font-weight: 700; cursor: pointer;
}
.mp-submit:disabled { background: #9db8ea; }
.mp-empty { padding: 14px 0; text-align: center; color: #a6b0c0; font-size: 12.5px; }
.mp-mask {
  position: fixed; inset: 0; background: rgba(12, 20, 36, 0.86);
  display: flex; align-items: center; justify-content: center; z-index: 80; padding: 16px;
}
.mp-view { width: 100%; max-width: 520px; }
.mp-view img { width: 100%; border-radius: 12px; display: block; background: #000; }
.mp-view-meta { color: #dfe6f2; font-size: 12.5px; margin-top: 10px; line-height: 1.8; }
.mp-view-note { color: #fff; font-size: 14px; margin-top: 2px; }
.mp-view-sub { color: #93a1b8; font-size: 12px; }
.mp-view-close {
  width: 100%; margin-top: 14px; padding: 13px; border: 1px solid #48566e;
  border-radius: 12px; background: transparent; color: #dfe6f2; font-size: 14px; cursor: pointer;
}
.mp-toast {
  position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%);
  background: rgba(22, 35, 59, 0.92); color: #fff; font-size: 13.5px;
  padding: 10px 20px; border-radius: 22px; z-index: 90;
}
</style>
