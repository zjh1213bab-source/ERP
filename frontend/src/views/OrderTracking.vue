<template>
  <div class="tracking-page">
    <div class="tracking-crumb">首页 / 订单 / <b>{{ assignment?"分配订单":"订单跟踪" }}</b></div>
    <section class="tracking-filter">
      <div class="filter-line">
        <label>PO号 <select v-model="filters.po_mode"><option value="like">模糊</option><option value="exact">精确</option></select><input v-model="filters.po" aria-label="PO号" placeholder="搜索PO号" @keyup.enter="search" /></label>
        <label>款号 <input v-model="filters.style" aria-label="款号" placeholder="搜索款号 / 客户款号" @keyup.enter="search" /></label>
        <button class="text-button" @click="batchOpen=true">批量搜索<span v-if="filters.batch"> · 已启用</span></button>
        <label><strong class="danger">订单状态</strong><select v-model="filters.status" @change="search"><option value="">全部</option><option v-for="(name,key) in statuses" :key="key" :value="key">{{ name }}</option></select></label>
        <label v-for="range in ranges" :key="range.key">{{ range.label }}<input type="date" v-model="filters[range.key+'_from']" @change="search" /><span>-</span><input type="date" v-model="filters[range.key+'_to']" @change="search" /></label>
      </div>
      <div class="filter-line">
        <label>标签 <select v-model="filters.order_type" @change="search"><option value="">请选择</option><option value="custom">定制</option><option value="stock">现货</option></select></label>
        <label>时间排序 <select v-model="filters.sort" @change="search"><option value="order">下单时间</option><option value="due">货期时间</option><option value="completed">发货完成时间</option></select></label>
        <label>排序类型 <select v-model="filters.sort_dir" @change="search"><option value="desc">倒序</option><option value="asc">正序</option></select></label>
        <label>搜索节点 <select v-model="filters.node_code" @change="filters.node_status='';search()"><option value="">请选择节点</option><option v-for="c in board.columns" :key="c.code" :value="c.code">{{ c.name }}</option></select></label>
        <label>节点状态 <select v-model="filters.node_status" :disabled="!filters.node_code" @change="search"><option value="">全部状态</option><option v-for="(name,key) in nodeStatuses" :key="key" :value="key">{{ name }}</option></select></label>
        <label>业务员 <input v-model="filters.manager" placeholder="搜索业务员" @keyup.enter="search" /></label>
        <label class="switch-label">无工序订单<input type="checkbox" v-model="filters.no_nodes" @change="search" /></label>
        <label class="switch-label">外发工艺订单<input type="checkbox" v-model="filters.out_craft" @change="search" /></label>
      </div>
      <div class="filter-line">
        <label>订单沟通内容 <input v-model="filters.communication" placeholder="搜索节点沟通内容" @keyup.enter="search" /></label>
        <button class="primary" @click="search">查询</button><button class="text-button" @click="reset">重置搜索</button>
        <span v-if="error" role="alert" class="danger">{{ error }}</span>
      </div>
      <div v-if="showDue" class="due-strip">
        <button class="due-card all" :class="{selected:dueSelection===''}" @click="selectDue('')"><b>全部</b><small>{{ countText(board.rows) }}</small></button>
        <button class="due-card late" :class="{selected:dueSelection==='overdue'}" @click="selectDue('overdue')"><b>{{ overduePercent }} 超期</b><small>{{ countText(overdueRows) }}</small></button>
        <button v-for="d in deliveryDays" :key="d.date" class="due-card" :class="{selected:dueSelection===d.date}" @click="selectDue(d.date)"><b>{{ d.date.slice(5) }} <em>{{ weekday(d.date) }}</em></b><small>{{ countText(d.rows) }}</small></button>
      </div>
      <button class="due-toggle text-button" @click="showDue=!showDue">{{ showDue?'收起货期':'展开货期' }}</button>
    </section>
    <section class="tracking-board">
      <nav class="tracking-tabs"><button v-for="t in tabs" :key="t.key" :class="{active:tab===t.key}" @click="tab=t.key;page=1">{{ t.label }}<sup v-if="t.count" :class="{danger:t.danger}">{{ t.count }}</sup></button></nav>
      <div class="tracking-tools">
        <button class="primary" @click="summaryOpen=true">同款汇总</button>
        <details class="more-menu"><summary class="primary">更多 ▾</summary><div><button @click="printRows">打印当前页工单</button><button @click="showDue=!showDue">{{ showDue?'隐藏':'显示' }}交期日历</button></div></details>
        <button v-if="can('node.flow')" class="primary" @click="router.push('/node-flow')">流程设置</button>
        <button class="help-button" @click="helpOpen=true">操作说明</button>
        <div class="view-switch"><button :class="{active:view==='cards'}" title="卡片视图" @click="view='cards'">▦</button><button :class="{active:view==='list'}" title="流程列表" @click="view='list'">☰</button><button :class="{active:view==='table'}" title="进度表格" @click="view='table'">▤</button></div>
        <span class="tool-space"></span><span>共 {{ filteredRows.length }} 条</span>
        <select v-model.number="pageSize"><option v-for="n in [12,24,48,96]" :key="n" :value="n">{{ n }}条/页</option></select>
        <div class="pager"><button :disabled="page===1" @click="page--">‹</button><button v-for="n in pageNumbers" :key="n" :class="{active:page===n}" @click="page=n">{{ n }}</button><span v-if="pageCount>5">… {{ pageCount }}</span><button :disabled="page===pageCount" @click="page++">›</button></div>
        <label>前往 <input class="goto" type="number" min="1" :max="pageCount" v-model="jump" @keyup.enter="goPage" @change="goPage" /> 页</label><button title="刷新订单" @click="load">⟳</button>
      </div>
      <p v-if="board.truncated" class="tracking-notice">当前匹配 {{ board.matched_total }} 单，仅加载前 5000 单。请缩小日期或 PO 范围后查看完整结果。</p>
      <div v-if="loading" class="tracking-empty">正在读取订单与工序数据…</div>
      <div v-else-if="!filteredRows.length" class="tracking-empty">没有符合条件的订单</div>
      <div v-else-if="view==='table'" class="tracking-table-wrap"><table class="tracking-table"><thead><tr><th>PO号 / 款号</th><th>客户</th><th>货期</th><th>数量</th><th>当前环节</th><th>流程完成率</th><th>操作</th></tr></thead><tbody><tr v-for="r in pagedRows" :key="r.id"><td>{{ r.order_no }}<br>{{ r.styles||r.style_name||'—' }}</td><td>{{ r.customer_name||'—' }}</td><td>{{ r.delivery_date||'—' }}</td><td>{{ r.order_qty }}</td><td>{{ r.current||statusText(r.status) }}</td><td>{{ r.total_count?r.progress+'%':'未生成工序' }}</td><td><button class="text-button" @click="openPeek(r.id)">详情</button></td></tr></tbody></table></div>
      <div v-else class="tracking-list" :class="{'card-view':view==='cards'}">
        <article v-for="r in pagedRows" :key="r.id" class="tracking-order">
          <div class="order-info">
            <button class="order-picture" @click="r.thumb?openImage(r.thumb,r.order_no):openPeek(r.id)"><img v-if="r.thumb&&!broken[r.id]" :src="r.thumb" alt="款式图" @error="broken[r.id]=true" /><span v-else class="picture-placeholder">暂无款图</span><span class="order-state" :class="r.status">{{ statusText(r.status) }}</span></button>
            <div class="order-metadata">
              <div><b>货期：</b>{{ r.delivery_date?fmtDate(r.delivery_date).slice(5):'未填' }} <span :class="r.overdue?'danger':'blue'">{{ deliveryHint(r) }}</span></div>
              <button class="text-button metadata-link" @click="openPeek(r.id)"><b>款号：</b>{{ r.styles||r.style_name||'—' }}</button>
              <button class="text-button metadata-link" @click="openPeek(r.id)"><b>PO号：</b>{{ r.cus_order_no||r.order_no }}</button>
              <div :title="r.colors"><b>颜色：</b>{{ r.colors||'—' }}</div><div><b>下单时间：</b>{{ fmtTime(r.order_date) }}</div><div><b>创建时间：</b>{{ fmtTime(r.created_at) }}</div><div><b>业务员：</b>{{ r.manager||'—' }}</div>
              <div class="order-labels"><span>{{ r.type==='stock'?'现货':'定制' }}</span><span>{{ assignText(r) }}</span><span v-if="r.no_nodes" class="danger">未生成工序</span></div>
            </div>
          </div>
          <div class="order-flow">
            <div class="flow-facts"><button class="flow-shortcut" @click="openPanel(r,firstCell(r))">☞ 流程 ›</button><span>下单({{ r.order_qty }})</span><span>在库({{ r.stock_qty }})</span><span class="flow-coverage">{{ r.total_count?'流程 '+r.progress+'%':'暂无流程' }}<template v-if="r.scan_pending"> · 待扫码：{{ r.scan_pending_names.join('、') }}</template></span></div>
            <div class="flow-scroll"><div class="flow-nodes"><div v-for="(cell,i) in [...r.cells,...r.extra]" :key="cell.node_id||cell.code" class="flow-node" :class="cell.status">
              <button class="node-detail" :disabled="!cell.node_id" @click="openPanel(r,cell)"><b>{{ cell.name }}</b><span class="node-dot">{{ cell.status==='done'?'✓':cell.status==='doing'?'▶':cell.status==='skipped'?'−':'○' }}</span></button>
              <div v-if="cell.overdue" class="danger">已超过计划交期</div><div v-else-if="cell.actual_date" class="node-date">{{ fmtTime(cell.actual_date) }}</div><div v-else-if="cell.plan_date" class="node-date">计划 {{ fmtDate(cell.plan_date) }}</div><div v-else class="node-date">-</div>
              <div v-if="['sew','inspect','pack','iron'].includes(cell.code)&&cell.progress!==null&&cell.progress!==undefined" class="node-progress" :title="'合格报工 '+cell.qty_ok+' / 订单 '+r.order_qty"><progress :value="cell.progress" max="100"></progress><span>{{ cell.progress }}%</span></div>
              <button v-if="cell.node_id" class="text-button node-chat" @click="openPanel(r,cell)">沟通</button><span v-if="i<r.cells.length+r.extra.length-1" class="node-arrow">»</span>
            </div><span v-if="r.no_nodes" class="no-flow">未生成工序，请从订单详情完成生产分配及流转。</span></div></div>
          </div>
          <div class="order-actions"><button v-if="assignment && can('order.dispatch')" v-action="['dispatch','create']" @click="openAssignment(r)">{{ r.pending_allocation>0?'分配':'分配记录' }}</button><button @click="printOrder(r.id)">打印</button><button @click="openPanel(r,firstCell(r))">工序</button><button @click="showExceptions(r)">异常</button><button @click="openPeek(r.id)">详情</button><button v-action="['orders','edit']" v-if="can('order.create')" @click="router.push({path:'/orders',query:{order:r.id}})">编辑</button><button @click="openPanel(r,firstCell(r))">沟通</button><button @click="openPeek(r.id)">更多</button></div>
        </article>
      </div>
    </section>
    <div v-if="allocation.open" class="modal-mask"><div class="modal tracking-modal">
      <div class="modal-head"><h3>分配订单 · {{ allocation.order?.order_no }}</h3><button class="x" :disabled="allocation.saving" @click="closeAssignment">×</button></div>
      <div class="modal-body">
        <p v-if="allocation.loading">正在加载分配资料…</p>
        <template v-else-if="allocation.context">
          <p>订单 {{ allocation.context.order_qty }} 件 · 已分配 {{ allocation.context.allocated }} 件 · 待分配 {{ allocation.context.pending_qty }} 件</p>
          <table class="tracking-table"><thead><tr><th>生产方式</th><th>承接工厂</th><th>数量</th><th>状态</th></tr></thead><tbody><tr v-for="d in allocation.context.dispatches" :key="d.id"><td>{{ d.type==='own'?'本厂生产':'整单外发' }}</td><td>{{ d.factory_name }}</td><td>{{ d.qty }}</td><td>{{ d.status_label }}</td></tr><tr v-if="!allocation.context.dispatches.length"><td colspan="4">暂无分配记录</td></tr></tbody></table>
          <fieldset v-if="allocation.context.pending_qty>0 && ['finance','assigned'].includes(allocation.context.order.status)" class="allocation-form" :disabled="allocation.saving">
            <label>生产方式<select v-model="allocation.mode" @change="allocation.factory_id=allocation.mode==='own'?(allocation.context.own_factory?.id||'local'):''"><option value="own">本厂生产</option><option value="outsource">整单外发</option></select></label>
            <label>承接工厂 <select v-model="allocation.factory_id"><option value="">请选择工厂</option><option v-if="allocation.mode==='own'&&!allocationFactories.length" value="local">本厂（内部生产）</option><option v-for="f in allocationFactories" :key="f.id" :value="f.id">{{ f.name }}</option></select></label>
            <label>分配数量 <input type="number" min="1" :max="allocation.context.pending_qty" v-model.number="allocation.qty" /></label>
            <label>备注 <input v-model="allocation.remark" maxlength="500" /></label>
            <p>裁片外发：先分配到本厂生产，再在“裁片外发与外协验货”登记扎包及承接工厂。</p>
          </fieldset>
          <p v-else>已分配完成或进入生产，不能重复分配。如需查看执行情况，点击工序或详情。</p>
        </template>
        <p v-if="allocation.error" role="alert" class="danger">{{ allocation.error }}</p>
      </div>
      <div class="modal-foot"><button :disabled="allocation.saving" @click="closeAssignment">关闭</button><button v-if="allocation.context?.pending_qty>0 && ['finance','assigned'].includes(allocation.context.order.status)" class="primary" :disabled="allocation.saving||allocation.loading" @click="saveAssignment">{{ allocation.saving?'分配中…':'确认分配' }}</button></div>
    </div></div>
    <NodePanel v-model:open="panelOpen" :node-id="nodeId" @changed="load" /><OrderPeek v-model:open="peekOpen" :order-id="peekId" />
    <div v-if="batchOpen||summaryOpen||helpOpen||exceptionOrder" class="modal-mask"><div class="modal tracking-modal"><div class="modal-head"><h3>{{ batchOpen?'批量搜索':summaryOpen?'同款汇总':exceptionOrder?'订单异常 · '+exceptionOrder.order_no:'订单跟踪操作说明' }}</h3><button class="x" @click="closeModal">×</button></div><div class="modal-body">
      <template v-if="batchOpen"><p>每行一个 PO 号或款号，支持逗号分隔，最多 100 项；按完整编号匹配。</p><textarea v-model="batchDraft" rows="9" aria-label="批量PO款号" placeholder="输入 PO 号或款号"></textarea></template>
      <template v-else-if="summaryOpen"><p>按当前筛选范围内的整单款式组合汇总，多款订单不拆分或重复计算金额。</p><table class="tracking-table"><thead><tr><th>款号 / 款式组合</th><th>订单数</th><th>数量</th></tr></thead><tbody><tr v-for="s in styleSummary" :key="s.style"><td>{{ s.style }}</td><td>{{ s.orders }}</td><td>{{ s.qty }}</td></tr></tbody></table></template>
      <template v-else-if="exceptionOrder"><p>未关闭日清异常：{{ exceptionOrder.exception_count }} 项</p><p>待处理返修：{{ exceptionOrder.rework_count }} 项</p><p>成本审核驳回：{{ exceptionOrder.cost_exception_count }} 项</p><p v-if="exceptionOrder.overdue" class="danger">订单超期 {{ exceptionOrder.days_late }} 天</p><p v-if="exceptionOrder.no_nodes">尚未生成生产工序</p><p v-if="!exceptionOrder.delivery_date">尚未填写交期</p><button class="primary" @click="openExceptionDetail">查看订单及关联处理记录</button></template>
      <template v-else><p>1. 组合 PO、款号、日期、节点状态后点击查询；交期卡片和页签即时筛选当前查询结果。</p><p>2. 点击工序或沟通，可查看计划、责任人、报工、凭证和操作记录，按岗位权限处理。</p><p>3. 灰色空圈表示未开始，蓝色表示进行中，绿色表示已完成。报工进度按各节点合格数量 / 订单件数计算。</p><p>4. 完成时间按发货节点实际完成时间筛选。成本异常指成本单审核被驳回；日清异常来自未关闭记录。</p><p>5. 只读跟踪不会推进订单；生产、入库、发货继续执行已有业务审核规则。</p></template>
    </div><div class="modal-foot"><button @click="closeModal">关闭</button><button v-if="batchOpen" class="primary" @click="applyBatch">搜索</button></div></div></div>
  </div>
</template>
<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import { openImage } from '../store/viewer';
import { fmtTime, fmtDate, localDate } from '../utils/time';
import NodePanel from '../components/NodePanel.vue';
import OrderPeek from '../components/OrderPeek.vue';
const props=defineProps({assignment:{type:Boolean,default:false}});
const router=useRouter(), loading=ref(false),error=ref(''),board=ref({rows:[],columns:[]}),broken=reactive({});
const defaults=()=>({po:'',po_mode:'like',style:'',batch:'',status:'',order_from:'',order_to:'',due_from:'',due_to:'',completed_from:'',completed_to:'',order_type:'',sort:'order',sort_dir:'desc',node_code:'',node_status:'',manager:'',no_nodes:false,out_craft:false,communication:''});
const filters=reactive(defaults());
const ranges=[{key:'order',label:'下单时间'},{key:'due',label:'货期时间'},{key:'completed',label:'完成时间'}];
const statuses={finance:'待分配',assigned:'已分单',production:'生产中',instock:'已入库',shipped:'已发货',closed:'已结案',cancelled:'作废'};
const nodeStatuses={pending:'未开始',doing:'进行中',done:'已完成',skipped:'不适用'};
const statusText=s=>statuses[s]||s;
const page=ref(1),pageSize=ref(48),jump=ref(1),tab=ref('all'),showDue=ref(true),dueSelection=ref(''),view=ref('list');
const unassigned=r=>r.pending_allocation>0&&['finance','assigned'].includes(r.status);
// 分配与车间跟踪共用展示组件，但各有独立入口、服务端范围及分类。
const tabDefinitions=computed(()=>props.assignment?
  [['all','全部',()=>true],['todo','待分配订单',unassigned],['outsource','整单外发',r=>r.assign_mode==='outsource'],['own','已分配本厂',r=>r.alloc_own>0]]:
  [['all','全部',()=>true],['own','本厂生产',r=>r.alloc_own>0],['cutout','裁片外发',r=>r.cut_dispatches>0],['rework','次品返修',r=>r.rework_count>0],['odd','订单异常',r=>r.exception_count>0],['cost','成本管控异常',r=>r.cost_exception_count>0],['void','作废订单',r=>r.status==='cancelled']]);

const dueRows=computed(()=>board.value.rows.filter(r=>!dueSelection.value||(dueSelection.value==='overdue'?r.overdue:String(r.delivery_date||'').slice(0,10)===dueSelection.value)));
const tabs=computed(()=>tabDefinitions.value.map(([key,label,match])=>({key,label,count:dueRows.value.filter(match).length,danger:['odd','cost','rework'].includes(key)})));
const filteredRows=computed(()=>dueRows.value.filter(tabDefinitions.value.find(t=>t[0]===tab.value)?.[2]||(()=>true)));
const pageCount=computed(()=>Math.max(1,Math.ceil(filteredRows.value.length/pageSize.value)));
const pagedRows=computed(()=>filteredRows.value.slice((page.value-1)*pageSize.value,page.value*pageSize.value));
const pageNumbers=computed(()=>{const start=Math.max(1,Math.min(page.value-2,pageCount.value-4));return Array.from({length:Math.min(5,pageCount.value)},(_,i)=>start+i);});
watch([pageCount,pageSize],()=>{page.value=Math.min(page.value,pageCount.value);jump.value=page.value;});watch(page,v=>{jump.value=v;});watch(pageSize,()=>{page.value=1;});
function goPage(){page.value=Math.max(1,Math.min(pageCount.value,Math.trunc(Number(jump.value))||1));jump.value=page.value;}
const overdueRows=computed(()=>board.value.rows.filter(r=>r.overdue));
const overduePercent=computed(()=>{const eligible=board.value.rows.filter(r=>r.delivery_date&&!['shipped','closed','cancelled'].includes(r.status));return eligible.length<5?'—':(overdueRows.value.length/eligible.length*100).toFixed(2)+'%';});
function countText(rows){const styles=new Set();rows.forEach(r=>String(r.styles||r.style_name||'').split(',').filter(Boolean).forEach(x=>styles.add(x)));return `${styles.size}款/${rows.length}单/${rows.reduce((n,r)=>n+Number(r.order_qty||0),0)}件`;}
const deliveryDays=computed(()=>{const map=new Map();for(const r of board.value.rows){const d=String(r.delivery_date||'').slice(0,10);if(!d)continue;if(!map.has(d))map.set(d,[]);map.get(d).push(r);}return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([date,rows])=>({date,rows}));});
const weekday=d=>['周日','周一','周二','周三','周四','周五','周六'][new Date(d+'T00:00:00').getDay()];
function selectDue(d){dueSelection.value=d;page.value=1;}
function deliveryHint(r){if(!r.delivery_date||['shipped','closed','cancelled'].includes(r.status))return '';if(r.overdue)return `超期${r.days_late}天`;const days=Math.round((new Date(fmtDate(r.delivery_date)+'T00:00:00')-new Date(localDate()+'T00:00:00'))/86400000);return `剩余${days}天`;}
function assignText(r){if(r.assign_mode==='none')return unassigned(r)?'待分配':'未记录分单';return r.assign_names||({own:'本厂生产',outsource:'整单外发',mixed:'本厂 + 外协'}[r.assign_mode]);}
let requestVersion=0;
async function load(){const version=++requestVersion;loading.value=true;error.value='';try{const read=props.assignment?api.dispatchBoard:api.nodeFlowBoard;const data=await read({...filters,tracking:1,tracking_view:props.assignment?'assignment':'factory',no_nodes:filters.no_nodes?1:'',out_craft:filters.out_craft?1:'',limit:5000});if(version===requestVersion)board.value=data;}catch(e){if(version===requestVersion){error.value=e.message;board.value={rows:[],columns:board.value.columns};}}finally{if(version===requestVersion)loading.value=false;}}
function search(){page.value=1;dueSelection.value='';load();}
function reset(){Object.assign(filters,defaults());tab.value='all';search();}
// 使用原分单接口。财务审核、超量和事务校验均由 ERP 后端执行。
const allocation=reactive({open:false,loading:false,saving:false,order:null,context:null,mode:'own',factory_id:'',qty:0,remark:'',error:''});
const allocationFactories=computed(()=>(allocation.context?.factories||[]).filter(f=>allocation.mode==='own'?f.type==='own':f.type!=='own'));
let allocationRequest=0;
async function openAssignment(order){const version=++allocationRequest;Object.assign(allocation,{open:true,loading:true,order,context:null,mode:'own',factory_id:'',qty:0,remark:'',error:''});try{const context=await api.dispatchContext(order.id);if(version!==allocationRequest)return;allocation.context=context;allocation.qty=context.pending_qty;allocation.factory_id=context.own_factory?.id||'local';}catch(e){if(version===allocationRequest)allocation.error=e.message;}finally{if(version===allocationRequest)allocation.loading=false;}}
function closeAssignment(){if(allocation.saving)return;allocationRequest++;allocation.open=false;}
async function saveAssignment(){if(allocation.saving)return;if(!allocation.factory_id){allocation.error='请选择承接工厂';return;}if(!Number.isFinite(allocation.qty)||allocation.qty<=0||allocation.qty>allocation.context.pending_qty){allocation.error='分配数量必须大于0且不能超过待分配数量';return;}allocation.saving=true;allocation.error='';try{await api.createDispatch({order_id:allocation.order.id,factory_id:allocation.factory_id==='local'?null:Number(allocation.factory_id),factory_name:allocation.factory_id==='local'?'本厂':'',type:allocation.mode,qty:allocation.qty,remark:allocation.remark});allocation.context=await api.dispatchContext(allocation.order.id);allocation.qty=allocation.context.pending_qty;await load();}catch(e){allocation.error=e.message;}finally{allocation.saving=false;}}
const panelOpen=ref(false),nodeId=ref(null),peekOpen=ref(false),peekId=ref(null);
function openPeek(id){peekId.value=id;peekOpen.value=true;}
function firstCell(r){return r.cells.find(c=>c.status==='doing')||r.cells.find(c=>c.status==='pending')||r.cells.find(c=>c.node_id);}
function openPanel(r,c){if(!c?.node_id){openPeek(r.id);return;}nodeId.value=c.node_id;panelOpen.value=true;}
function printOrder(id){window.open(`/print/production/${id}`,'_blank','noopener');}
function printRows(){if(!pagedRows.value.length)return;router.push({path:'/print/batch',query:{type:'production',ids:pagedRows.value.map(r=>r.id).join(',')}});}
const batchOpen=ref(false),batchDraft=ref(''),summaryOpen=ref(false),helpOpen=ref(false),exceptionOrder=ref(null);
watch(batchOpen,v=>{if(v)batchDraft.value=filters.batch;});
function closeModal(){batchOpen.value=false;summaryOpen.value=false;helpOpen.value=false;exceptionOrder.value=null;}
function applyBatch(){const items=[...new Set(batchDraft.value.split(/[\s,，;；]+/).filter(Boolean))];if(items.length>100){alert('一次最多搜索100项');return;}filters.batch=items.join('\n');closeModal();search();}
function showExceptions(r){exceptionOrder.value=r;}
function openExceptionDetail(){const id=exceptionOrder.value.id;closeModal();router.push({path:'/orders',query:{order:id}});}
const styleSummary=computed(()=>{const groups=new Map();for(const r of filteredRows.value){const style=r.styles||r.style_name||'未填款号';if(!groups.has(style))groups.set(style,{style,orders:0,qty:0});const x=groups.get(style);x.orders++;x.qty+=Number(r.order_qty)||0;}return [...groups.values()];});
watch(()=>props.assignment,()=>{closeAssignment();reset();});
onMounted(load);
</script>
<style scoped>
.tracking-page{--tracking-blue:#1890ff;--tracking-green:#35c88f;--tracking-line:var(--line);font-size:12px;color:var(--ink-soft);background:var(--surface);margin:-18px -20px 0;padding:8px;min-height:100%;}
.tracking-page button,.tracking-page select,.tracking-page input,.tracking-page textarea{font-size:12px;border:1px solid var(--line);border-radius:3px;background:var(--surface);color:var(--ink-soft);min-height:29px;padding:3px 10px;}
.tracking-page button{cursor:pointer;}.tracking-page button:disabled{opacity:.45;cursor:not-allowed;}.tracking-page button:hover:not(:disabled){border-color:var(--tracking-blue);}.tracking-page button.primary,.tracking-page summary.primary{background:var(--tracking-blue);border-color:var(--tracking-blue);color:#fff;}.tracking-page .text-button{border:0;background:transparent;color:var(--tracking-blue);padding:0 4px;min-height:22px;}.danger{color:var(--danger)!important;}.blue{color:var(--tracking-blue);}.tracking-crumb{padding:0 0 10px;color:var(--ink-mute);}.tracking-crumb b{color:var(--ink);}.tracking-filter{padding:4px 0 0;}.filter-line{display:flex;gap:10px 18px;flex-wrap:wrap;align-items:center;margin:0 0 7px;}.filter-line label{display:flex;align-items:center;gap:8px;white-space:nowrap;}.filter-line input:not([type]){width:180px;}.filter-line input[type=date]{width:127px;}.filter-line select{min-width:90px;}.filter-line input[type=checkbox]{appearance:none;width:36px;height:19px;min-height:19px;border:0;border-radius:12px;background:var(--surface-3);position:relative;padding:0;cursor:pointer;}.filter-line input[type=checkbox]:after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--surface);box-shadow:0 1px 3px #0002;}.filter-line input[type=checkbox]:checked{background:var(--tracking-blue);}.filter-line input[type=checkbox]:checked:after{left:19px;}
.due-strip{display:flex;gap:10px;overflow-x:auto;padding:4px 0 7px;}.tracking-page .due-card{flex:0 0 113px;padding:5px 9px;min-height:50px;display:grid;gap:3px;text-align:center;}.due-card.all{flex-basis:140px;color:var(--tracking-blue);}.due-card.late{flex-basis:140px;color:var(--danger);}.due-card.selected{border-color:var(--tracking-blue);background:color-mix(in srgb,var(--tracking-blue) 8%,var(--surface));}.due-card b{font-size:13px;color:var(--ink);}.due-card.all b,.due-card.late b{color:inherit;}.due-card em{font-style:normal;color:var(--ink-mute);font-size:11px;font-weight:400;}.due-card small{font-size:10px;white-space:nowrap;}.due-toggle{display:block;width:100%;height:26px;text-align:center;}.tracking-board{border:1px solid var(--line);margin-top:10px;}.tracking-tabs{display:flex;background:var(--surface-2);border-bottom:1px solid var(--line);overflow:auto;}.tracking-tabs button{flex:none;border:0;border-right:1px solid transparent;background:transparent;padding:9px 20px;min-height:36px;}.tracking-tabs button.active{background:var(--surface);color:var(--tracking-blue);border-right-color:var(--line);}.tracking-tabs sup{margin-left:3px;border-radius:8px;font-size:10px;}.tracking-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:7px 12px;border-bottom:1px solid var(--line);}.tracking-tools .help-button{background:#ff5058;color:white;border-color:#ff5058;}.tool-space{flex:1;}.view-switch,.pager{display:flex;align-items:center;gap:3px;}.view-switch button.active,.pager button.active{background:var(--tracking-blue);color:white;border-color:var(--tracking-blue);}.tracking-tools .goto{width:46px;text-align:center;}.more-menu{position:relative;}.more-menu summary{list-style:none;border-radius:3px;padding:6px 12px;cursor:pointer;}.more-menu>div{position:absolute;top:33px;left:0;z-index:5;min-width:154px;background:var(--surface);padding:6px;border:1px solid var(--line);box-shadow:var(--shadow-md);}.more-menu>div button{display:block;width:100%;text-align:left;border:0;}.tracking-list{padding:0 12px 12px;}.tracking-order{display:flex;border:1px solid var(--line);border-top:0;min-height:200px;}.order-info{display:flex;gap:10px;flex:0 0 350px;padding:10px 9px;border-right:1px solid var(--line);overflow:hidden;}.tracking-page .order-picture{position:relative;width:90px;height:132px;flex:none;padding:0;overflow:hidden;background:var(--surface-2);}.order-picture img{display:block;width:100%;height:110px;object-fit:contain;}.picture-placeholder{display:grid;place-items:center;height:110px;color:var(--ink-mute);}.order-state{position:absolute;bottom:0;left:0;right:0;height:22px;background:#ffa500;color:white;line-height:22px;}.order-state.closed,.order-state.cancelled{background:#87929c;}.order-state.instock{background:#38ac79;}.order-state.shipped{background:#1686dc;}.order-metadata{line-height:19px;min-width:0;flex:1;font-size:11px;color:var(--ink-soft);}.order-metadata>div,.tracking-page .metadata-link{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}.order-metadata b{color:var(--ink);font-weight:550;}.tracking-page .metadata-link{text-align:left;padding:0;min-height:19px;font-size:11px;}.order-labels{display:flex!important;flex-wrap:wrap;gap:4px;margin-top:3px;}.order-labels span{border:1px solid color-mix(in srgb,var(--tracking-green) 25%,var(--line));color:var(--tracking-green);padding:0 4px;border-radius:2px;line-height:15px;}.order-flow{min-width:0;flex:1;}.flow-facts{display:flex;align-items:center;gap:20px;padding:3px 8px;height:33px;color:#f69c18;font-size:11px;}.tracking-page .flow-shortcut{background:#04bf66;color:white;min-height:20px;height:20px;padding:0 6px;border:0;white-space:nowrap;}.flow-coverage{margin-left:auto;color:var(--ink-mute);white-space:nowrap;font-size:10px;max-width:45%;overflow:hidden;text-overflow:ellipsis;}.flow-scroll{overflow-x:auto;min-height:163px;}.flow-nodes{display:flex;min-width:max-content;min-height:150px;padding:12px 0 4px;}.flow-node{position:relative;width:132px;flex:none;text-align:center;}.tracking-page .node-detail{border:0;background:transparent;display:grid;gap:8px;justify-items:center;width:100%;}.node-detail b{height:30px;display:flex;align-items:end;justify-content:center;color:var(--ink-mute);font-size:12px;font-weight:550;}.node-dot{width:18px;height:18px;background:var(--ink-mute);color:white;border-radius:50%;display:grid;place-items:center;font-size:12px;}.done .node-dot{background:var(--tracking-green);}.doing .node-dot{background:var(--tracking-blue);}.skipped .node-dot{background:#d6a34a;}.done .node-detail b,.done .node-date{color:var(--tracking-green);}.doing .node-detail b,.doing .node-date{color:var(--tracking-blue);}.node-date{min-height:30px;max-width:110px;margin:0 auto;line-height:15px;overflow-wrap:anywhere;}.node-progress{display:flex;align-items:center;gap:4px;justify-content:center;font-size:10px;height:14px;}.node-progress progress{width:60px;height:5px;accent-color:var(--tracking-blue);}.node-chat{display:block;margin:0 auto;}.node-arrow{position:absolute;right:-7px;top:40px;font-size:27px;font-weight:300;color:color-mix(in srgb,var(--tracking-blue) 50%,transparent);}.no-flow{padding:40px 20px;color:var(--ink-mute);}.order-actions{display:grid;grid-template-columns:1fr 1fr;align-content:start;gap:1px 5px;width:102px;padding:12px 5px;flex:none;}.tracking-page .order-actions button{border:0;padding:0;min-height:25px;color:var(--tracking-blue);background:transparent;}.tracking-empty{padding:60px 20px;text-align:center;color:var(--ink-mute);}.tracking-notice{padding:0 12px;color:var(--warning);}.tracking-modal{width:760px;max-width:94vw;}.allocation-form{border:0;padding:16px 0;display:grid;grid-template-columns:1fr 1fr;gap:12px;}.allocation-form label{display:grid;gap:6px;}.allocation-form p{grid-column:1/-1;color:var(--ink-mute);}.tracking-modal textarea{width:100%;resize:vertical;}.tracking-table-wrap{overflow:auto;}.tracking-table{border-collapse:collapse;width:100%;font-size:12px;}.tracking-table th,.tracking-table td{border:1px solid var(--line);padding:10px;text-align:left;}.tracking-table th{background:var(--surface-2);}.card-view{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;padding-top:12px;}.card-view .tracking-order{flex-wrap:wrap;border-top:1px solid var(--line);}.card-view .order-info{flex-basis:100%;border-right:0;}.card-view .order-flow{width:100%;flex:auto;}.card-view .order-actions{width:100%;display:flex;justify-content:end;padding:5px 10px;gap:14px;}.card-view .flow-coverage{display:none;}
.filter-line:first-child{gap:8px 10px;}.filter-line:first-child input[type=date]{width:106px;}.filter-line:first-child label:first-child input{width:140px;}.filter-line:first-child label:nth-child(2) input{width:150px;}
@media(max-width:1100px){.order-info{flex-basis:290px;}.flow-node{width:115px;}.tracking-page{margin:0;padding:4px;}.tracking-tools{gap:5px;}.order-picture{width:72px!important;}.filter-line input:not([type]){width:145px;}}
@media print{.tracking-filter,.tracking-tools,.tracking-tabs,.order-actions{display:none;}.tracking-order{break-inside:avoid;}.flow-scroll{overflow:visible;}.flow-nodes{min-width:0;flex-wrap:wrap;}.tracking-page{margin:0;}}
</style>
