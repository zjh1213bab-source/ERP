<template>
  <div ref="wrapRef" class="canvas-wrap">
    <svg ref="svgRef"></svg>
    <button class="reset-btn" @click="fitView(true)">重置视图</button>
    <div v-if="error" class="state-tip err">{{ error }}</div>
  </div>
</template>

<script setup>
/**
 * 放射式思维导图画布（d3 v7 + foreignObject 富文本卡片）
 * - 拖拽平移 / 滚轮缩放：d3.zoom
 * - 卡片点击折叠/展开：隐藏明细，高度自适应
 * - hover 高亮：CSS
 * - 重置视图：fitView 自动居中缩放
 */
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as d3 from 'd3';

const props = defineProps({
  config: { type: Object, default: null }
});

const wrapRef = ref(null);
const svgRef = ref(null);
const error = ref('');

const CENTER_R = 150;
const COLLAPSE_KEY = 'erp-mm-collapsed';
// 折叠状态存 localStorage（刷新保持）
let collapsed = new Set();
try {
  collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
} catch (e) {
  collapsed = new Set();
}

let svg = null;
let scene = null;
let gEdges = null;
let gCenter = null;
let gNodes = null;
let zoomBehavior = null;
let didInitialFit = false;

/** HTML 转义，避免后台录入内容破坏结构 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 计算「卡片中心 -> 目标点」射线与卡片矩形的交点（用于连线吸附卡片边缘） */
function rectEdgePoint(cx, cy, w, h, tx, ty) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2;
  const hh = h / 2;
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** 初始化 SVG 图层、渐变、缩放行为 */
function setupSvg() {
  const width = wrapRef.value.clientWidth || 1200;
  const height = wrapRef.value.clientHeight || 800;

  svg = d3.select(svgRef.value).attr('width', width).attr('height', height);

  // 中心节点渐变
  const defs = svg.append('defs');
  const grad = defs
    .append('radialGradient')
    .attr('id', 'centerGrad')
    .attr('cx', '38%')
    .attr('cy', '30%')
    .attr('r', '78%');
  grad.append('stop').attr('offset', '0%').attr('stop-color', '#3b6fe0');
  grad.append('stop').attr('offset', '100%').attr('stop-color', '#152c70');

  scene = svg.append('g').attr('class', 'scene');
  gEdges = scene.append('g').attr('class', 'edges');
  gCenter = scene.append('g').attr('class', 'center');
  gNodes = scene.append('g').attr('class', 'nodes');

  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.15, 2.2])
    .on('zoom', (event) => {
      scene.attr('transform', event.transform);
    });

  svg.call(zoomBehavior).on('dblclick.zoom', null);
}

/** 绘制中心节点 */
function drawCenter(center) {
  if (!center) return;

  gCenter
    .append('circle')
    .attr('r', CENTER_R)
    .attr('fill', 'url(#centerGrad)')
    .attr('stroke', '#ffffff')
    .attr('stroke-width', 6);

  // 外圈细环，增加层次
  gCenter
    .append('circle')
    .attr('r', CENTER_R + 9)
    .attr('fill', 'none')
    .attr('stroke', 'rgba(37,99,235,0.35)')
    .attr('stroke-width', 2);

  gCenter
    .append('foreignObject')
    .attr('x', -CENTER_R + 16)
    .attr('y', -CENTER_R + 16)
    .attr('width', CENTER_R * 2 - 32)
    .attr('height', CENTER_R * 2 - 32)
    .append('xhtml:div')
    .attr('class', 'center-fo')
    .html(`
      <div class="c-title">${esc(center.title || '')}</div>
      <div class="c-sub">${esc(center.subtitle || '')}</div>
      <div class="c-tags">${esc(center.tags || '')}</div>
    `);
}

/** 主渲染：清空并重建所有节点与连线 */
function render() {
  if (!svg || !props.config) return;
  const cfg = props.config;

  gEdges.selectAll('*').remove();
  gCenter.selectAll('*').remove();
  gNodes.selectAll('*').remove();

  drawCenter(cfg.center);

  const modules = Array.isArray(cfg.modules) ? cfg.modules : [];
  const cards = [];

  modules.forEach((m) => {
    const w = Number(m.w) || 300;
    const cx = Number(m.x) || 0;
    const cy = Number(m.y) || 0;
    const isCollapsed = collapsed.has(m.id);

    const g = gNodes
      .append('g')
      .attr('class', 'node')
      .attr('transform', `translate(${cx},${cy})`);

    const fo = g
      .append('foreignObject')
      .attr('x', -w / 2)
      .attr('y', -10)
      .attr('width', w)
      .attr('height', 4000);

    const div = fo
      .append('xhtml:div')
      .attr('class', 'mm-card' + (isCollapsed ? ' collapsed' : ''))
      .attr('style', `--c:${m.color || '#64748b'};width:${w}px;`);

    div.html(`
      <div class="mm-card-head">
        <span class="mm-no">${esc(m.no ?? '')}</span>
        <span class="mm-title">${esc(m.title || '未命名模块')}</span>
      </div>
      <ul class="mm-items">
        ${(Array.isArray(m.items) ? m.items : []).map((it) => `<li>${esc(it)}</li>`).join('')}
      </ul>
      ${m.footer ? `<div class="mm-foot">${esc(m.footer)}</div>` : ''}
    `);

    // 测量真实高度并垂直居中
    const h = div.node().offsetHeight || 80;
    fo.attr('height', h).attr('y', -h / 2);

    // 点击折叠/展开
    div.on('click', (event) => {
      event.stopPropagation();
      toggleCollapse(m.id);
    });

    cards.push({ m, w, h, cx, cy });
  });

  // 连线：中心 -> 卡片边缘（贝塞尔曲线，颜色取模块色）
  cards.forEach(({ m, w, h, cx, cy }) => {
    const p = rectEdgePoint(cx, cy, w, h, 0, 0);
    const dist = Math.hypot(p.x, p.y) || 1;
    const ux = p.x / dist;
    const uy = p.y / dist;
    const start = { x: ux * CENTER_R, y: uy * CENTER_R };
    const c1 = { x: start.x + (p.x - start.x) * 0.45, y: start.y + (p.y - start.y) * 0.45 };
    const c2 = { x: start.x + (p.x - start.x) * 0.78, y: start.y + (p.y - start.y) * 0.78 };

    gEdges
      .append('path')
      .attr('d', `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p.x},${p.y}`)
      .attr('fill', 'none')
      .attr('stroke', m.color || '#94a3b8')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.5);
  });

  if (!didInitialFit) {
    didInitialFit = true;
    nextTick(() => fitView(false));
  }
}

/** 折叠 / 展开 */
function toggleCollapse(id) {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch (e) {
    /* ignore */
  }
  render(); // 重新测量高度并重绘连线（保持当前缩放位置）
}

/** 居中缩放至全览 */
function fitView(animate = true) {
  if (!scene || !wrapRef.value) return;
  const width = wrapRef.value.clientWidth;
  const height = wrapRef.value.clientHeight;
  if (!width || !height) return;

  let bbox;
  try {
    bbox = scene.node().getBBox();
  } catch (e) {
    return;
  }
  if (!bbox || !bbox.width || !bbox.height) return;

  const pad = 56;
  const scale = Math.min((width - pad * 2) / bbox.width, (height - pad * 2) / bbox.height, 1.15);
  const tx = width / 2 - (bbox.x + bbox.width / 2) * scale;
  const ty = height / 2 - (bbox.y + bbox.height / 2) * scale;
  const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

  if (animate) {
    svg.transition().duration(450).call(zoomBehavior.transform, transform);
  } else {
    svg.call(zoomBehavior.transform, transform);
  }
}

/** 尺寸变化：更新画布尺寸 */
function onResize() {
  if (!wrapRef.value || !svg) return;
  svg.attr('width', wrapRef.value.clientWidth).attr('height', wrapRef.value.clientHeight);
}

onMounted(() => {
  nextTick(() => {
    setupSvg();
    render();
  });
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});

// 配置变化（首次加载 / 后台保存后刷新）重新渲染
watch(
  () => props.config,
  () => {
    if (!svg) return;
    didInitialFit = false;
    nextTick(() => render());
  }
);

defineExpose({ fitView });
</script>
