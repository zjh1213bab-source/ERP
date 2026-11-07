import { ref, watch, computed, reactive } from 'vue';

export const PAGE_SIZES = [10, 20, 50, 100];
const STORAGE_KEY = 'erp_list_page_size';
function savedSize() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return PAGE_SIZES.includes(value) ? value : 10;
  } catch { return 10; }
}
// 同一个浏览器的全部业务列表共用设置，保存失败不影响当前页面。
export const globalPageSize = ref(savedSize());
watch(globalPageSize, (value) => {
  if (!PAGE_SIZES.includes(value)) { globalPageSize.value = 10; return; }
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* 浏览器禁用存储时仍可使用 */ }
});
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY || event.key === null) globalPageSize.value = savedSize();
});

export function useListPagination(source) {
  const page = ref(1);
  const total = computed(() => source()?.length || 0);
  const pages = computed(() => Math.max(1, Math.ceil(total.value / globalPageSize.value)));
  watch([source, globalPageSize], () => { page.value = 1; }, { flush: 'sync' });
  watch(pages, (count) => { page.value = Math.min(page.value, count); }, { flush: 'sync' });
  const rows = computed(() => (source() || []).slice((page.value - 1) * globalPageSize.value, page.value * globalPageSize.value));
  return reactive({ page, pageSize: globalPageSize, total, rows });
}
