<template>
 <div class="purchase-lines"><table><thead><tr v-if="mode==='materials'"><th>物料</th><th>类型</th><th>款色 / 色号</th><th>单位</th><th>单件用量</th><th>需求参考</th><th>规格</th><th>供应商</th></tr><tr v-else-if="mode==='lines'"><th>采购单号</th><th>订单号</th><th>物料</th><th>单位</th><th>数量</th><th>已到</th><th>单价</th><th>金额</th><th>状态</th><th>操作</th></tr><tr v-else><th>收料单号</th><th>采购单号</th><th>物料</th><th>到货</th><th>合格</th><th>待检</th><th>退回</th><th>到货日期</th><th>操作</th></tr></thead><tbody>
 <template v-for="r in rows" :key="r.key+':'+r.id"><tr v-if="mode==='materials'"><td><img v-if="r.image_url" :src="r.image_url" alt="本单物料图" @click="openImage(r.image_url,r.material_name)" />{{ r.material_name }}</td><td>{{ r.mat_type==='fabric'?'面料':'辅料' }}</td><td>{{ r.colorway||'—' }} / {{ r.color_no||'—' }}</td><td>{{ r.unit||'—' }}</td><td>{{ r.one_use>0?r.one_use:'—' }}</td><td>{{ r.need_qty??'—' }}</td><td>{{ r.spec_info||'—' }}</td><td>{{ r.supplier||'—' }}</td></tr>
 <tr v-else-if="mode==='lines'"><td>{{ r.po_no }}</td><td>{{ r.order_no||'备货采购' }}</td><td>{{ r.name }}</td><td>{{ r.unit||'—' }}</td><td>{{ r.qty }}</td><td>{{ r.received_qty }}</td><td>¥{{ money(r.price) }}</td><td>¥{{ money(r.amount) }}</td><td>{{ status[r.status]||r.status }}</td><td><button @click="$emit('purchase',r.po_id)">明细</button></td></tr>
 <tr v-else><td>{{ r.grn_no }}</td><td>{{ r.po_no }}</td><td>{{ r.material_name }}</td><td>{{ r.receive_qty }}</td><td>{{ r.pass_qty }}</td><td>{{ r.pending_qty }}</td><td>{{ r.reject_qty }}</td><td>{{ r.receive_date||'—' }}</td><td><button v-if="canVisit('/receipts')" @click="$emit('receipt',r.grn_id)">来料检验</button></td></tr></template>
 <tr v-if="!rows.length"><td :colspan="mode==='materials'?8:10" class="empty">暂无记录</td></tr></tbody></table></div>
</template>
<script setup>
import {openImage} from '../store/viewer';
import {canVisit} from '../store/navigation';
defineProps({mode:String,rows:{type:Array,default:()=>[]}});defineEmits(['purchase','receipt']);
const status={draft:'草稿',ordered:'已下单',received:'已收货',cancelled:'已取消',closed:'已结案'};
const money=v=>Number(v||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
</script>
<style scoped>
.purchase-lines{overflow:auto;}table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;}th,td{border:1px solid var(--line);padding:10px;text-align:left;}th{background:var(--surface-2);font-weight:550;}td{background:var(--surface);color:var(--ink-soft);}button{border:0;background:transparent;color:#1890ff;cursor:pointer;}img{width:36px;height:36px;object-fit:contain;vertical-align:middle;margin-right:7px;cursor:zoom-in;}.empty{text-align:center;padding:45px;color:var(--ink-mute);}
</style>
