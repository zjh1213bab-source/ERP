<template>
  <section class="sample-image-search" tabindex="0" v-if="canAction('sample-archives', 'image-search')" aria-label="样衣以图搜款" @click="$event.currentTarget.focus()">
    <div class="image-search-copy"><strong>以图搜款 <span class="tag">AI</span></strong><p>上传款式照片，查找相近样衣。图片仅在本机处理，相似度供选款参考。</p></div>
    <div class="image-search-actions">
      <img v-if="preview" :src="preview" alt="查询图片" class="query-thumb" />
      <button class="btn btn-primary" :disabled="running" @click="fileInput.click()">{{ running ? '正在查找…' : '上传图片搜款' }}</button>
      <button v-if="preview && !running" class="btn btn-ghost" @click="search()">重新检索</button>
      <button v-if="preview || message" class="btn btn-ghost" @click="reset()">返回全部样衣</button>
      <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" hidden @change="pick($event)" />
    </div>
    <div v-if="message" class="image-search-message" role="status">{{ message }}</div>
    <div v-else class="image-search-hint">支持 JPG / PNG / WebP，最大 3MB；也可点击此区域后粘贴图片。首次检索会自动建立样衣索引。</div>
  </section>
</template>

<script setup>
import { ref, onBeforeUnmount, onMounted } from 'vue';
import { api } from '../api';
import { canAction } from '../store/permissions';
const props = defineProps({ q: String, status: String });
const emit = defineEmits(['results', 'clear']);
const preview = ref(''), message = ref(''), running = ref(false), fileInput = ref();
let generation = 0, timer, stopped = false;
function reset() { generation++; clearTimeout(timer); running.value = false; preview.value = ''; message.value = ''; emit('clear'); if (fileInput.value) fileInput.value.value = ''; }
async function read(file) {
  if (running.value || !file) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 3*1024*1024) { message.value = '请选择不超过3MB的 JPG、PNG 或 WebP 图片'; return; }
  const current = ++generation;
  try {
    const image = await new Promise((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(Error('图片读取失败')); r.readAsDataURL(file); });
    if (stopped || current !== generation) return;
    preview.value = image; await search();
  } catch (e) { message.value = e.message; }
}
function pick(e) { read(e.target.files?.[0]); }
async function search() {
  if (!preview.value || running.value) return;
  const current = ++generation; running.value = true; message.value = '正在读取图片特征…';
  const filterQ = props.q, filterStatus = props.status;
  const update = async job => {
    if (stopped || current !== generation) return;
    if (job.state === 'error') { running.value = false; message.value = job.message; return; }
    if (job.state === 'done') {
      if (props.q !== filterQ || props.status !== filterStatus) { running.value = false; message.value = '筛选条件已变化，请重新检索'; return; }
      running.value = false; emit('results', job.matches);
      message.value = job.total ? `找到 ${job.matches.length} 款，按相似度排序${job.skipped ? '；有 '+job.skipped+' 张图片缺失或不支持' : ''}。相似度不是确认可用的依据。` : '当前筛选范围没有带图片的样衣，请先完成打版归档。'; return;
    }
    message.value = job.state === 'queued' ? '检索排队中…' : `正在检索 ${job.done} / ${job.total} 款，首次建立索引可能需要一些时间…`;
    timer = setTimeout(async () => { try { await update(await api.sampleImageSearchResult(job.id)); } catch (e) { if (current === generation) { running.value = false; message.value = e.message; } } }, 1000);
  };
  try { await update(await api.sampleImageSearch({ dataUrl: preview.value, q: props.q, status: props.status })); }
  catch (e) { if (current === generation) { running.value = false; message.value = e.message; } }
}
function paste(e) {
  const image = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  // 只在图搜区域有焦点时接管粘贴，避免抢走其他表单的图片上传。
  if (image && document.activeElement?.closest('.sample-image-search')) { e.preventDefault(); read(image.getAsFile()); }
}
onMounted(() => document.addEventListener('paste', paste));
onBeforeUnmount(() => { stopped = true; generation++; clearTimeout(timer); document.removeEventListener('paste', paste); });
</script>

<style scoped>
.sample-image-search { padding:22px; margin-bottom:18px; border:1px solid var(--line); border-radius:12px; background:var(--surface); display:flex; flex-wrap:wrap; gap:16px; align-items:center; }
.image-search-copy { flex:1; min-width:230px; }.image-search-copy strong { font-size:17px; color:var(--ink); }.image-search-copy p,.image-search-hint,.image-search-message { color:var(--ink-mute); font-size:12px; line-height:1.7; margin:7px 0 0; }
.image-search-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }.query-thumb { width:56px; height:56px; object-fit:contain; border:1px solid var(--line); border-radius:8px; background:var(--surface-2); }
.image-search-message,.image-search-hint { flex-basis:100%; margin:0; }
</style>
