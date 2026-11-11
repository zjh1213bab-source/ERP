<template>
  <main class="us-board">
    <header><div><h2>美仓现货 <small>独立业务</small></h2><p>商品、供货、仓储与批零履约统一工作区</p></div><button @click="load" :disabled="busy">{{busy?'正在读取…':'刷新看板'}}</button></header>
    <nav aria-label="美仓业务模块"><router-link v-for="([title,desc,to],i) in modules" :key="title" :to="to"><small>{{String(i+1).padStart(2,'0')}}</small><span><b>{{title}}</b><p>{{desc}}</p></span></router-link></nav>
    <p role="status">{{error || (stamp ? '统计时间：'+stamp+' · 美国仓库' : '正在读取美仓业务')}}</p>
    <div class="metrics"><router-link v-for="[title,val,unit,note,to] in metrics" :key="title" :to="to">{{title}} <i>↗</i><strong>{{val ?? '—'}} <small>{{unit}}</small></strong><p>{{note}}</p></router-link></div>
    <section><h3>现货全程</h3><p>点击阶段，查看对应业务</p><div class="flow"><router-link v-for="([label,to],i) in stages" :key="label" :to="to"><small>{{i+1}}</small><h4>{{label}}</h4>查看明细 →</router-link></div></section>
    <section><h3>SKU 供需</h3><p>按款式、花色和尺码核对在产、在途和仓内数量</p><table><thead><tr><th>商品 SKU</th><th>在产</th><th>在途</th><th>在库</th><th>占用</th><th>可售</th></tr></thead><tbody><tr v-for="s in overview?.rows" :key="s.key"><td>{{s.sku}}</td><td>{{s.in_production}}</td><td>{{s.in_transit}}</td><td>{{s.on_hand}}</td><td>{{s.held}}</td><td>{{s.sellable}}</td></tr></tbody></table><p v-if="!overview?.rows?.length">{{error?'请检查数据连接或账号权限':busy?'加载中':'暂无美仓供需记录'}}</p></section>
  </main>
</template>
<script setup>
import {computed,onMounted,ref} from 'vue';
import {api} from '../api';
const modules=[['经营看板','供需与业务全景','/us-stock'],['商品管理','款式 · 规格 · 上新','/products'],['备货管理','需求 · 补货 · 财审','/spot-ops'],['生产跟踪','分厂 · 进度 · 交期','/order-tracking'],['物流管理','在途 · 单证 · 运费','/overseas-warehouse'],['仓储管理','收货 · 库存 · 盘点','/wh-plan'],['订单发货','接单 · 拣配 · 售后','/us-ship'],['财务经营','成本 · 资金 · 结算','/finance']];
const stages=[['待开工','/production'],['生产中','/order-tracking'],['待终检','/quality'],['工厂待发','/production'],['运输在途','/overseas-warehouse?status=in_transit'],['美仓实物','/overseas-warehouse?tab=loc'],['预留发货','/wh-plan']];
const sea=ref(null),overview=ref(null),pending=ref(null),busy=ref(false),error=ref(''),stamp=ref('');
const metrics=computed(()=>{const s=overview.value?.stat||{};return [['美仓在库',s.on_hand,'件','美仓库存账面数量','/overseas-warehouse'],['可分配库存',s.sellable,'件','合格上架扣除有效占用','/spot-ops'],['海运在途',sea.value,'件','已发运且尚未到仓的柜货','/overseas-warehouse?status=in_transit'],['生产在产',s.in_production,'件','在产与运输分开统计','/order-tracking'],['待发订单',pending.value,'单','查看订单齐套与缺货','/us-ship']]});
async function load(){if(busy.value)return;busy.value=true;error.value='';try{const [a,b,c]=await Promise.allSettled([api.spotopsOverview({warehouse:'us',window_days:60}),api.shipBoard({warehouse:'us'}),api.whBoard({warehouse:'us'})]);sea.value=c.status==='fulfilled'?c.value.arriving.filter(a=>a.status==='in_transit').reduce((n,a)=>n+Number(a.expect_qty||0),0):null;overview.value=a.status==='fulfilled'?a.value:null;pending.value=b.status==='fulfilled'?b.value.length:null;error.value=[a,b,c].map((x,i)=>x.status==='rejected'?['供需数据','发货数据','海运数据'][i]+'读取失败':'').filter(Boolean).join('；');stamp.value=new Date().toLocaleString('zh-CN')}finally{busy.value=false}}
onMounted(load);
</script>
<style scoped>
.us-board{font-size:14px;color:var(--yc-ink)}header,.metrics,.flow,nav{display:flex;gap:12px}header{align-items:center;justify-content:space-between}h2,h3,h4{margin:0}small,p{font-size:12px}p{color:var(--yc-ink-2);margin:8px 0 16px}button,a,section{border:1px solid var(--yc-line);background:var(--yc-surface);border-radius:6px}button{padding:8px 14px;cursor:pointer;color:inherit}a{color:inherit;text-decoration:none;padding:16px;flex:1}a:hover{border-color:var(--yc-blue);color:var(--yc-blue)}nav{gap:0;overflow:auto}nav a{display:flex;gap:10px;min-width:120px;border-radius:0}nav a:first-child{border-bottom:3px solid var(--yc-blue);background:var(--yc-blue-soft)}nav p,.metrics p{margin:8px 0 0}.metrics strong{display:block;font-size:32px;margin:12px 0}.metrics i{float:right}.flow a{background:var(--yc-page)}h4{margin:14px 0 24px}section{margin:16px 0;padding:20px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--yc-line)}table{border-collapse:collapse;width:100%}@media(max-width:950px){.metrics,.flow{flex-wrap:wrap}.metrics a,.flow a{min-width:135px}}
</style>
