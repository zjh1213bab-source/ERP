<template>
  <!-- 通用模块页头 / 统计概览条。
       只传 items 时渲染一排等宽统计卡（用于已有 .page-head 的页面）；
       传 title/description 时连标题、说明、操作按钮一起渲染（新模块直接用整套）。
       多根节点组件，不产生额外包裹层，不影响页面原有布局。 -->
  <div v-if="title || $slots.ops" class="mod-head">
    <div class="mod-head-text">
      <h2 v-if="title">{{ title }}</h2>
      <p v-if="description" class="mod-sub">{{ description }}</p>
    </div>
    <div v-if="$slots.ops" class="mod-ops"><slot name="ops" /></div>
  </div>
  <div v-if="items.length" class="mod-stats">
    <div v-for="(s, i) in items" :key="(s.label || '') + '-' + i" class="mod-stat" :class="s.tone ? 'tone-' + s.tone : ''">
      <span class="mod-stat-label">{{ s.label }}</span>
      <strong class="mod-stat-value">{{ s.value ?? 0 }}</strong>
      <small v-if="s.hint" class="mod-stat-hint">{{ s.hint }}</small>
    </div>
  </div>
  <slot />
</template>

<script setup>
/**
 * items: [{ label, value, hint, tone }]
 * - label 统计项名称；value 真实数值（页面从现有接口/computed 传入，不在此造假）；
 *   hint 下方小字说明；tone 可选 warn / danger / info，用于强调异常量。
 * - items 为空时不渲染卡片区，避免没有数据源的模块出现一排 0。
 */
defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  items: { type: Array, default: () => [] }
});
</script>

<style>
/* 非 scoped：全局注册后各页面共用同一套等宽卡片，样式跟随主题变量。 */
.mod-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.mod-head-text { min-width: 0; }
.mod-head h2 { margin: 0; font-size: 19px; color: var(--ink, var(--yc-ink)); }
.mod-sub { margin: 3px 0 0; font-size: 12.5px; color: var(--ink-mute, #7a879c); }
.mod-ops { display: flex; align-items: center; gap: 8px; flex: none; }
.mod-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.mod-stat {
  display: flex; flex-direction: column; gap: 6px;
  min-height: 74px; padding: 11px 14px;
  background: var(--yc-surface, #fff);
  border: 1px solid var(--yc-line, #e4e9f0);
  border-radius: 4px;
}
.mod-stat-label { font-size: 12px; color: var(--ink-mute, #7a879c); }
.mod-stat-value { font-size: 22px; font-weight: 700; line-height: 1; color: var(--yc-ink, #303133); }
.mod-stat-hint { font-size: 11px; color: var(--ink-mute, #7a879c); }
.mod-stat.tone-warn .mod-stat-value { color: #e6912c; }
.mod-stat.tone-danger .mod-stat-value { color: #e94f61; }
.mod-stat.tone-info .mod-stat-value { color: var(--yc-blue, #1769bd); }
@media (max-width: 760px) {
  .mod-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media print { .mod-stats { display: none; } }
</style>
