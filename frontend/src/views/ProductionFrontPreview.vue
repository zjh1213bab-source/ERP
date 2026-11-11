<template>
  <main class="preview-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">JUMP<small>COLOR</small></span><span class="brand-name">跳色科技<small>WORK WITH CLARITY</small></span></div>
      <div class="breadcrumbs">首页总览　/　生产前端　/　订单</div>
      <div class="account"><span>☷</span><b>系</b><span>系统管理员<small>跳色科技　⌄</small></span></div>
    </header>
    <aside class="sidebar">
      <div v-for="item in menu" :key="item.label" class="menu-group" :class="{active:item.label==='生产前端'}">
        <div class="menu-title"><span class="menu-icon">{{ item.icon }}</span>{{ item.label }}<span class="chevron">{{ item.children?'⌄':'' }}</span></div>
        <template v-if="item.label==='生产前端'"><div v-for="child in item.children" :key="child" class="menu-child" :class="{selected:child==='订单'}">{{ child }}</div></template>
      </div>
    </aside>
    <section class="workspace">
      <nav class="tabs"><span v-for="tabName in openTabs" :key="tabName" :class="{current:tabName==='订单'}">{{ tabName }}<i>×</i></span></nav>
      <div class="tab-scroll"><span></span></div>
      <div class="content">
        <section class="search-panel">
          <button class="outline" @click="searchOpen=!searchOpen">{{ searchOpen?'收起搜索':'展开搜索' }}</button>
          <div v-if="searchOpen" class="search-fields"><label>订单号<input v-model="search" placeholder="请输入订单号" /></label><label>款号<input placeholder="请输入款号" /></label><label>客户<input placeholder="请输入客户" /></label><button class="primary">查询</button><button class="outline" @click="search=''">重置</button></div>
        </section>
        <section class="board">
          <div class="board-head">
            <div class="filters">
              <button v-for="tab in filters" :key="tab.name" class="filter-card" :class="{chosen:activeFilter===tab.name}" @click="activeFilter=tab.name"><b>{{ tab.name }}</b><small>{{ tab.summary }}</small></button>
            </div>
            <div class="actions"><span>共 {{ rows.length }} 单</span><button class="outline page-size">12条/页　⌄</button><button class="outline square">‹</button><span>1 / 1</span><button class="outline square">›</button><button class="primary batch" @click="printAll">▣ 批量打印订单</button></div>
          </div>
          <div class="table-scroll"><table>
            <thead><tr><th>订单号</th><th>款号</th><th>款式</th><th>生产方式</th><th>接单工厂</th><th>当前进度</th><th>货期</th><th>创建时间</th><th>客户</th><th>操作</th></tr></thead>
            <tbody><template v-for="row in filteredRows" :key="row.number"><tr>
              <td class="order-no"><button @click="toggle(row.number)">{{ expanded.includes(row.number)?'▾':'▸' }}　{{ row.number }}</button></td><td>共 {{ row.styles }} 款</td><td>共 {{ row.colors }} 个花色</td><td>{{ row.production }}</td><td>{{ row.factory }}</td><td>{{ row.progress }}</td><td>{{ row.due }}</td><td>{{ row.created }}</td><td>{{ row.customer }}</td><td><button class="primary print" @click="printOne(row.number)">▣ {{ row.print }}</button></td>
            </tr><tr v-if="expanded.includes(row.number)" class="detail"><td colspan="10"><b>{{ row.number }}</b><span>款式：{{ row.styleNames }}</span><span>花色：{{ row.colorNames }}</span><span>生产方式：{{ row.production }}</span></td></tr></template></tbody>
          </table></div>
          <div class="horizontal"><span></span></div>
        </section>
      </div>
    </section>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </main>
</template>

<script setup>
import { computed, ref } from 'vue';

const menu = [
  { icon:'⌂', label:'首页总览' }, { icon:'▥', label:'我的工作', children:['我的待办'] },
  { icon:'▣', label:'我的待办' }, { icon:'✉', label:'内部邮箱' }, { icon:'♙', label:'人事薪酬' },
  { icon:'♧', label:'样衣管理', children:['样衣管理'] }, { icon:'🛒', label:'销售开单', children:['业务订单'] },
  { icon:'⌁', label:'技术开发', children:['开发管理'] }, { icon:'♧', label:'供应链部', children:['采购列表'] },
  { icon:'▤', label:'生产前端', children:['订单','裁床','仓库'] }, { icon:'♧', label:'生产后端', children:['车间','后整'] },
  { icon:'▦', label:'扫码查询' }, { icon:'▤', label:'美仓现货' }, { icon:'▣', label:'财务管理', children:['财务'] },
  { icon:'▦', label:'行政后勤' }, { icon:'♙', label:'智能助手' }, { icon:'⚙', label:'系统设置', children:['设置'] }, { icon:'◇', label:'审核', children:['审核'] }
];
const openTabs = ['首页总览','预下单','开发管理','业务订单','样衣管理','生产审核','分配订单','人事薪酬','内部邮箱','我的待办','单据归审','订单','裁床','行政后勤'];
const filters = [
  { name:'全部', summary:'9款/3单/1115件' }, { name:'本厂生产', summary:'7款/3单/895件' },
  { name:'裁片外发', summary:'3款/2单/220件' }, { name:'订单打印', summary:'9款/3单/1115件' }
];
const rows = [
  { number:'L8JAHR26061107003', styles:4, colors:11, production:'本厂生产、裁片外发', factory:'本厂、外发(待分配工厂)', progress:'待算料', due:'2026-12-03', created:'2026-11-08', customer:'ZEE', print:'再打印', styleNames:'GS-TZ-001、KR-NTTZ-0211、KACL-TZ-002成人、BYBS-TZ-001', colorNames:'藏青、白色、黑色、红色等' },
  { number:'13243214', styles:1, colors:2, production:'本厂生产', factory:'本厂', progress:'待打印下发', due:'2026-12-07', created:'2026-11-07', customer:'Victoria Fox', print:'打印订单', styleNames:'BRSI-WY-001成人', colorNames:'黑色、白色' },
  { number:'31534', styles:4, colors:5, production:'裁片外发、本厂生产', factory:'2.5、本厂', progress:'待打印下发、待仓库核料', due:'2026-12-02', created:'2026-11-07', customer:'Khulood Al-Busaidi', print:'打印订单', styleNames:'BRSI-WY-001成人、KR-NTTZ-0198、KR-BTZ-056、KR-LYQ-0228', colorNames:'藏青、黑色、白色、红色、灰色' }
];
const searchOpen=ref(false), search=ref(''), activeFilter=ref('全部'), expanded=ref([]), toast=ref('');
const filteredRows=computed(()=>rows.filter(row=>row.number.toLowerCase().includes(search.value.toLowerCase())));
let toastTimer;
function notify(message){toast.value=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.value='',1800);}
function toggle(number){expanded.value=expanded.value.includes(number)?expanded.value.filter(x=>x!==number):[...expanded.value,number];}
function printAll(){notify('已打开打印预览（本地演示）');}
function printOne(number){notify(`订单 ${number} 打印预览（本地演示）`);}
</script>

<style scoped>
*{box-sizing:border-box} .preview-shell{height:100vh;min-height:680px;background:#f5f8fc;color:#19324c;font:13px "Microsoft YaHei",Arial,sans-serif;overflow:hidden}.topbar{height:60px;background:#eaf7fd;border-bottom:1px solid #d9e7ef;display:flex;align-items:center;padding:0 28px;gap:26px}.brand{width:220px;display:flex;align-items:center;gap:25px;color:#060e17}.brand-mark{font:bold italic 23px Georgia;letter-spacing:-2px;line-height:20px}.brand-mark small{display:block;font:9px Arial;text-align:center;letter-spacing:1px}.brand-name{font-size:16px;white-space:nowrap}.brand-name small{display:block;font-size:10px;margin-top:3px}.breadcrumbs{flex:1;color:#101c27}.account{display:flex;align-items:center;gap:28px;color:#111}.account>span:last-child{font-size:13px}.account small{display:block;color:#576677;font-size:11px;margin-top:3px}.sidebar{position:absolute;top:60px;bottom:0;left:0;width:136px;background:#eaf7fd;border-right:5px solid #43576a;overflow:auto;color:#111}.menu-group{min-height:42px}.menu-title{height:42px;padding:0 12px;display:flex;align-items:center;gap:9px;white-space:nowrap;font-size:13px}.menu-icon{font-size:17px;width:14px;text-align:center}.chevron{margin-left:auto}.menu-group.active{color:#1569c5}.menu-group.active .menu-title{font-weight:600}.menu-child{height:38px;padding:11px 0 0 37px;color:#18242e}.menu-child.selected{background:#dff1fb;border-left:3px solid #126acb;color:#0964c8}.workspace{position:absolute;left:136px;right:0;top:60px;bottom:0;background:#f6f9fd}.tabs{height:40px;display:flex;align-items:center;gap:7px;padding:0 18px;overflow:hidden;white-space:nowrap;background:#fff}.tabs span{height:28px;border:1px solid #d7e1ec;padding:5px 10px;min-width:74px;font-size:12px;color:#15314a}.tabs span.current{background:#1669c2;border-color:#1669c2;color:#fff;font-weight:600}.tabs i{font-style:normal;margin-left:12px}.tab-scroll{height:13px;background:#fff;border-bottom:1px solid #edf0f4;padding:3px 18px}.tab-scroll span{display:block;width:66%;height:7px;background:#999;border-radius:8px}.content{padding:20px}.search-panel{min-height:64px;background:white;border:1px solid #cbd9e7;border-radius:8px;padding:14px 16px}.outline{height:34px;background:#fff;border:1px solid #c7d8ea;border-radius:5px;color:#1465bd;padding:0 14px}.search-fields{display:flex;align-items:end;gap:16px;padding:15px 0 3px}.search-fields label{display:grid;gap:5px}.search-fields input{height:33px;width:210px;border:1px solid #d3dfeb;border-radius:4px;padding:0 9px}.primary{height:34px;border:1px solid #196ac5;background:#196ac5;color:#fff;border-radius:5px;padding:0 12px}.board{margin-top:12px;border:1px solid #cbd9e7;border-radius:8px;background:white;overflow:hidden}.board-head{min-height:100px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #cbd9e7;gap:12px}.filters{display:flex;gap:8px}.filter-card{width:135px;height:81px;background:#f1f6fc;border:1px solid #bfd2e6;border-radius:6px;color:#1264bd;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px}.filter-card b{font-size:14px;font-weight:500}.filter-card small{font-size:12px}.filter-card.chosen{background:#1b6bc3;color:#fff;border-color:#1b6bc3;box-shadow:0 2px 5px #1264bd35}.filter-card.chosen b{font-weight:600}.actions{display:flex;align-items:center;gap:9px;white-space:nowrap;color:#294969}.page-size{height:32px;padding:0 12px}.square{width:29px;height:29px;padding:0;color:#8298ad}.batch{height:31px;margin-left:2px}.table-scroll{width:100%;overflow-x:auto}.table-scroll table{border-collapse:collapse;width:100%;min-width:1200px;table-layout:fixed;font-size:13px;color:#23466a}.table-scroll th,.table-scroll td{height:51px;padding:7px 9px;text-align:center;border-right:1px solid #dfe7f0;border-bottom:1px solid #dfe7f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.table-scroll th{height:43px;background:#f3f7fb;color:#304c69;font-weight:600}.table-scroll th:first-child,.table-scroll td:first-child{width:200px;text-align:left}.table-scroll th:nth-child(2){width:100px}.table-scroll th:nth-child(3){width:110px}.table-scroll th:nth-child(4){width:145px}.table-scroll th:nth-child(5){width:165px}.table-scroll th:nth-child(6){width:168px}.table-scroll th:nth-child(7),.table-scroll th:nth-child(8){width:100px}.table-scroll th:nth-child(9){width:135px}.table-scroll th:last-child{width:145px}.table-scroll tbody tr{background:#f1f6fc}.table-scroll tbody tr:hover{background:#eaf3fc}.order-no button{border:0;background:none;color:#1264bd;font:inherit;cursor:pointer;padding:0}.print{min-width:88px;height:30px}.detail td{background:#fff;text-align:left!important;padding:12px 18px}.detail span{margin-left:25px}.horizontal{height:15px;padding:3px 18px;background:#fff}.horizontal span{height:8px;display:block;background:#999;border-radius:8px;width:80%}.toast{position:fixed;top:75px;left:50%;transform:translateX(-50%);padding:10px 18px;background:#173a5e;color:white;border-radius:5px;box-shadow:0 4px 14px #0003}@media(max-width:900px){.sidebar{width:118px}.workspace{left:118px}.content{padding:12px}.board-head{align-items:flex-start;flex-direction:column}.actions{align-self:flex-end}.brand{width:auto}.breadcrumbs{display:none}}
</style>
