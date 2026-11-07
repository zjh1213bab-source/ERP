<template>
  <details v-if="order.entry_json" class="entry-snapshot"><summary>查看下单颜色图片、客户尺码与分色物料</summary>
    <section v-for="it in order.items" :key="it.id"><h4>{{it.style_no||it.product_name}}</h4><div class="snapshot-images"><div v-for="(url,color) in meta(it).color_images" :key="color"><span>{{color}}</span><img v-if="url" :src="url" @click="openImage(url,color)"/></div></div><p v-if="Object.values(meta(it).customer_sizes||{}).some(Boolean)">客户尺码：<span v-for="(label,size) in meta(it).customer_sizes" :key="size">{{label?`${size} → ${label}　`:''}}</span></p></section>
    <section v-for="m in materials.filter(m=>m.entry_json)" :key="m.id"><h4>{{m.name}} · {{m.item?.item_style_no||m.item?.style_no||m.item?.product_name||'物料'}}</h4><div v-if="meta(m).order_image_url" class="snapshot-images"><span>本单物料照片</span><img :src="meta(m).order_image_url" @click="openImage(meta(m).order_image_url,m.name)"/></div><p>成分：{{m.ingredient||'—'}} · 使用部位：{{meta(m).usage_part||'—'}} · 空差：{{meta(m).air_gap}}%</p><div class="snapshot-table"><table><thead><tr><th>款色</th><th>颜色 / 色号</th><th>单价 CNY</th><th>单件用量</th><th>分码用量</th><th>图片</th></tr></thead><tbody><tr v-for="c in meta(m).colors" :key="c.colorway"><td>{{c.colorway}}</td><td>{{c.color_no||'—'}}</td><td>{{c.price??m.price}}</td><td>{{c.qty??m.one_use}}</td><td>{{(c.sizes||[]).map(s=>`${s.size}: ${s.one_use}`).join('、')||'沿用单件用量'}}</td><td><img v-if="c.image_url" :src="c.image_url" @click="openImage(c.image_url,c.colorway)"/></td></tr></tbody></table></div></section>
  </details>
</template>
<script setup>
import {openImage} from '../store/viewer';
defineProps({order:Object,materials:Array});
const meta=row=>JSON.parse(row.entry_json||'{}');
</script>
<style scoped>
.entry-snapshot{border:1px solid var(--line);border-radius:6px;padding:12px;margin:12px 0}.entry-snapshot summary{cursor:pointer;color:var(--brand)}.entry-snapshot section{margin:14px 0;border-top:1px solid var(--line)}.entry-snapshot h4{font-size:13px;margin:10px 0}.entry-snapshot p{font-size:12px;color:var(--ink-soft)}.snapshot-images{display:flex;gap:10px;flex-wrap:wrap}.snapshot-images>div{display:flex;flex-direction:column;font-size:11px}.entry-snapshot img{height:60px;width:60px;object-fit:contain;border:1px solid var(--line);border-radius:4px;cursor:zoom-in}.snapshot-table{overflow:auto}.snapshot-table table{border-collapse:collapse;width:100%;font-size:12px}.snapshot-table td,.snapshot-table th{padding:8px;border:1px solid var(--line);text-align:left}.snapshot-table th{background:var(--surface-soft,var(--bg))}
</style>
