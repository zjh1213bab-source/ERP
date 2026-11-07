<template>
  <nav class="list-pagination" aria-label="列表分页">
    <span class="pagination-summary" aria-live="polite">共 {{ total }} 条 · {{ start }}–{{ end }} 条</span>
    <label class="pagination-size">每页
      <select class="select" :value="pageSize" aria-label="每页显示条数" @change="changeSize">
        <option v-for="size in sizes" :key="size" :value="size">{{ size }} 条</option>
      </select>
    </label>
    <div class="pagination-buttons">
      <button class="btn btn-ghost" :disabled="page <= 1" @click="$emit('update:page', 1)">首页</button>
      <button class="btn btn-ghost" :disabled="page <= 1" @click="$emit('update:page', page - 1)">上一页</button>
      <span>{{ page }} / {{ pages }} 页</span>
      <button class="btn btn-ghost" :disabled="page >= pages" @click="$emit('update:page', page + 1)">下一页</button>
      <button class="btn btn-ghost" :disabled="page >= pages" @click="$emit('update:page', pages)">末页</button>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  total: { type: Number, required: true },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 },
  sizes: { type: Array, default: () => [10, 20, 50, 100] }
});
const emit = defineEmits(['update:page', 'update:pageSize']);
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const start = computed(() => props.total ? (props.page - 1) * props.pageSize + 1 : 0);
const end = computed(() => Math.min(props.page * props.pageSize, props.total));

function changeSize(event) {
  const size = Number(event.target.value);
  if (!props.sizes.includes(size)) return;
  emit('update:page', 1);
  emit('update:pageSize', size);
}
</script>

<style scoped>
.list-pagination { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 0; font-size: 13px; }
.pagination-summary { margin-right: auto; }
.pagination-size, .pagination-buttons { display: flex; align-items: center; gap: 8px; }
.pagination-size .select { width: 90px; }
.pagination-buttons .btn { padding: 6px 10px; }
.pagination-buttons span { white-space: nowrap; min-width: 64px; text-align: center; }
@media (max-width: 640px) { .pagination-buttons { width: 100%; justify-content: space-between; gap: 4px; } }
</style>
