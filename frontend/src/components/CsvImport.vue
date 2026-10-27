<template>
  <span class="csv-import">
    <button class="btn btn-ghost btn-sm" :disabled="busy" @click="downloadTemplate">下载导入模板</button>
    <label class="btn btn-ghost btn-sm" :class="{ disabled: busy }" style="cursor: pointer">
      {{ busy ? '导入中…' : '批量导入 CSV' }}
      <input type="file" accept=".csv,text/csv" style="display: none" @change="onPick" />
    </label>
    <span v-if="msg" class="csv-msg" :class="err ? 'bad' : 'ok'">{{ msg }}</span>
  </span>
</template>

<script setup>
/**
 * CSV 批量导入按钮组
 * props.kind: customers | products | materials
 * 事件 done：导入成功后通知父级刷新列表
 */
import { ref } from 'vue';
import { api } from '../api';

const props = defineProps({
  kind: { type: String, required: true },
  label: { type: String, default: '' }
});
const emit = defineEmits(['done']);

const busy = ref(false);
const msg = ref('');
const err = ref(false);

/** 读取文件并尽量正确识别编码（Excel 中文环境常导出 GBK） */
async function readText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (text.includes('\uFFFD')) {
    try {
      text = new TextDecoder('gbk', { fatal: false }).decode(buf);
    } catch (e) { /* 浏览器不支持 gbk 时保留 utf-8 结果 */ }
  }
  return text.replace(/^\uFEFF/, '');
}

async function onPick(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  busy.value = true;
  msg.value = '';
  err.value = false;
  try {
    const csv = await readText(file);
    const r = await api.importCsv(props.kind, csv);
    const parts = [`新增 ${r.inserted} 条`, `更新 ${r.updated} 条`];
    if (r.errors && r.errors.length) {
      parts.push(`跳过 ${r.errors.length} 行`);
      err.value = true;
      msg.value = parts.join('，') + '　｜　' + r.errors.slice(0, 3).join('；');
    } else {
      msg.value = parts.join('，') + '　导入完成';
    }
    emit('done');
  } catch (e2) {
    err.value = true;
    msg.value = e2.message || '导入失败';
  } finally {
    busy.value = false;
  }
}

async function downloadTemplate() {
  try {
    const blob = await api.importTemplate(props.kind);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `import-${props.kind}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    err.value = true;
    msg.value = e.message || '模板下载失败';
  }
}
</script>

<style scoped>
.csv-import { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.csv-import .disabled { opacity: 0.6; pointer-events: none; }
.csv-msg { font-size: 12px; }
.csv-msg.ok { color: #1f9254; }
.csv-msg.bad { color: #c0392b; }
</style>
