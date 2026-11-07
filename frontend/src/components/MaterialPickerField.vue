<template>
  <div class="mpf">
    <div v-if="ids.length" class="mpf-chips">
      <span v-for="id in ids" :key="id" class="mpf-chip" :class="{ gone: !rowOf(id) }">
        <span class="mpf-name" :title="titleOf(id)">{{ nameOf(id) }}</span>
        <span v-if="specOf(id)" class="mpf-spec">{{ specOf(id) }}</span>
        <button type="button" class="mpf-x" title="移除" @click="remove(id)">×</button>
      </span>
    </div>

    <div class="mpf-ops">
      <button type="button" class="btn btn-ghost btn-sm" @click="open = true">
        ＋ 选择{{ typeLabel }}
      </button>
      <span class="mpf-count">
        已选 {{ ids.length }} 条
        <template v-if="archiveTotal">· 档案 {{ archiveTotal }} 条</template>
      </span>
      <button v-if="ids.length" type="button" class="link-btn" @click="emit('update:modelValue', [])">清空</button>
      <span v-if="!archiveTotal" class="mpf-warn">物料档案为空，请先到「面辅料档案」建立</span>
    </div>

    <MaterialPicker
      :open="open"
      :type="type"
      :selected="ids"
      @close="open = false"
      @picked="onPicked"
    />
  </div>
</template>

<script setup>
/**
 * 面辅料选择字段（弹窗选择 + 已选标签）
 * ============================================================
 * ## 为什么不再用一屏复选框
 *
 * 开发单/订单里原来是「把整个面料库平铺成几十个复选框」。档案只有十几条时还能忍，
 * 30 条以上就开始找不到东西：名称长得像、规格挤在一行、页面被撑高到要滚两屏，
 * 而且看不出"哪些已经选过"（勾选状态只能一个个找）。
 *
 * 现在：**已选用标签显示**（名称 + 规格，可单独移除），选择走已有的
 * `MaterialPicker` 弹窗（名称/简称/供应商/类型筛选 + 表格多选 + 复制档案）。
 * 弹窗里的查询走服务端 `?type=&q=`，档案涨到几千条也不会把页面拖慢。
 *
 * ## 两个容易出错的点
 *
 * 1. **已选 id 的档案可能已经被删/停用**：这时标签显示 `#12（档案已不存在）`，
 *    但**不自动把 id 从值里删掉** —— 历史单子要能原样保存，静默丢数据比显示难看严重得多。
 * 2. **名字从档案里取**：父页面只存 id，标签上的名称由这里查档案得到，
 *    避免父页面各存一份名称字符串导致改名后两处不一致。
 */
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api';
import MaterialPicker from './MaterialPicker.vue';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  type: { type: String, default: 'fabric' },   // fabric / accessory
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const archive = ref([]);

const ids = computed(() => (props.modelValue || []).map(Number).filter(Boolean));
const typeLabel = computed(() => (props.type === 'accessory' ? '辅料' : '面料'));
const archiveTotal = computed(() => archive.value.length);

const byId = computed(() => {
  const m = new Map();
  archive.value.forEach((r) => m.set(Number(r.id), r));
  return m;
});
const rowOf = (id) => byId.value.get(Number(id)) || null;
const nameOf = (id) => {
  const r = rowOf(id);
  return r ? r.name : `#${id}（档案已不存在）`;
};
const specOf = (id) => {
  const r = rowOf(id);
  if (!r) return '';
  const bits = [r.width && `幅宽${r.width}`, r.weight && `克重${r.weight}`, r.spec]
    .filter(Boolean);
  return bits.join(' · ');
};
const titleOf = (id) => {
  const r = rowOf(id);
  if (!r) return '该物料在档案里已删除或停用；历史单据保留原样，不会自动移除';
  return [r.name, r.code, r.supplier, r.unit].filter(Boolean).join(' / ');
};

async function loadArchive() {
  try {
    archive.value = await api.materials({ type: props.type, status: 'active' });
  } catch (e) {
    archive.value = [];
  }
}

function remove(id) {
  emit('update:modelValue', ids.value.filter((x) => Number(x) !== Number(id)));
}

/** 弹窗「确定」回来的是档案行：合并去重，保持选择顺序 */
function onPicked(rows) {
  const cur = ids.value.slice();
  (rows || []).forEach((r) => {
    const id = Number(r.id);
    if (id && !cur.includes(id)) cur.push(id);
  });
  emit('update:modelValue', cur);
  // 新挑的物料可能刚建过档案，刷新一次保证标签能显示名字
  loadArchive();
}

onMounted(loadArchive);
watch(() => props.type, loadArchive);
</script>

<style scoped>
.mpf { display: flex; flex-direction: column; gap: 6px; }
.mpf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mpf-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 9px;
  border-radius: 14px;
  background: #f2f7ff;
  border: 1px solid #d6e4ff;
  font-size: 12.5px;
  color: #1f2d3d;
  max-width: 100%;
}
.mpf-chip.gone { background: #fff7e6; border-color: #ffd591; color: #874d00; }
.mpf-name { font-weight: 500; }
.mpf-spec { color: #7a869a; font-size: 12px; }
.mpf-x {
  border: none;
  background: transparent;
  color: #7a869a;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.mpf-x:hover { color: #d4380d; }
.mpf-ops { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mpf-count { font-size: 12px; color: var(--ink-mute); }
.mpf-warn { font-size: 12px; color: #d46b08; }
</style>
