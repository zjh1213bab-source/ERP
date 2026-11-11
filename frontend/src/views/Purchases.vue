<template>
  <div class="purchase-page">
    <div class="purchase-crumb">首页 / 采购 / <b>{{scopeLabel}}</b></div>
    <section class="purchase-filters">
      <label>款号<input v-model="search.style" placeholder="搜索款号 / 客户款号" @input="page=1" /></label>
      <label>单号<input v-model="search.number" placeholder="搜索采购单号 / 订单号" @input="page=1" /></label>
      <label>PO单号<input v-model="search.po" placeholder="搜索PO单号" @input="page=1" /></label>
      <label v-for="field in stateFilters" :key="field.key">{{ field.label }}<select v-model="search[field.key]" @change="page=1"><option value="">请选择状态</option><option v-for="(label,value) in purchaseStates" :key="value" :value="value">{{ label }}</option></select></label>
      <label>采购员<input v-model="search.buyer" placeholder="搜索采购员（建单人）" list="purchase-buyers" @input="page=1" /><datalist id="purchase-buyers"><option v-for="n in buyers" :key="n" :value="n" /></datalist></label>
      <label>客户<input v-model="search.customer" placeholder="搜索客户" @input="page=1" /></label>
      <label>工厂<input v-model="search.factory" placeholder="搜索工厂" @input="page=1" /></label>
      <label class="date-filter">创建时间<input type="date" v-model="search.from" @change="page=1" /> - <input type="date" v-model="search.to" @change="page=1" /></label>
      <label>颜色<input v-model="search.color" placeholder="搜索颜色" @input="page=1" /></label>
      <label>审核状态<select v-model="search.audit" @change="page=1"><option value="">全部审核状态</option><option value="not_required">按现有流程直接下单</option></select></label>
      <button class="text-button" @click="resetSearch">重置</button>
    </section>
    <section class="purchase-workspace">
      <nav class="purchase-tabs"><button v-for="t in workspaceTabs" :key="t.key" :class="{active:tab===t.key}" @click="tab=t.key;page=1">{{ t.label }}</button></nav>
      <div class="purchase-tools">
        <button v-action="['purchases','create']" v-if="canWrite" class="p-primary" @click="openCreate()">新增采购单</button>
        <button v-action="['purchases','order']" v-if="canWrite" class="p-warning" :disabled="batchBusy||!selectedDrafts.length" @click="batchOrder">{{ batchBusy?'确认中…':'批量确认下单' }}<template v-if="selectedDrafts.length"> ({{ selectedDrafts.length }})</template></button>
        <button v-if="canVisit('/order-allocation')" class="p-primary" @click="router.push('/order-allocation')">分配订单</button>
        <button class="p-primary" @click="exportOpen=true">按订单号导出明细</button><span class="tools-space"></span><span>共 {{ activeRows.length }} 条</span>
        <select v-model.number="pageSize" @change="page=1"><option v-for="n in [9,18,36,72]" :key="n" :value="n">{{ n }}条/页</option></select>
        <div class="purchase-pager"><button :disabled="page<=1" @click="page--">‹</button><button v-for="n in pages" :key="n" :class="{active:n===page}" @click="page=n">{{ n }}</button><span v-if="pageCount>5">…{{ pageCount }}</span><button :disabled="page>=pageCount" @click="page++">›</button></div>
        <label>前往<input type="number" min="1" :max="pageCount" class="page-jump" v-model="jump" @change="jumpPage" @keyup.enter="jumpPage" />页</label><button title="刷新采购资料" @click="load">⟳</button>
      </div>
      <p v-if="workspace.truncated" class="purchase-notice">当前显示前5000条订单或采购单，请按单号进入对应单据核对完整记录。</p>
      <p v-if="notice" class="purchase-notice" role="status">{{ notice }}</p><p v-if="workspaceError" class="purchase-error" role="alert">{{ workspaceError }}</p>
      <div v-if="workspaceLoading" class="purchase-empty">正在加载采购与收料记录…</div>
      <div v-else-if="tab==='orders'" class="purchase-card-grid">
        <article v-for="card in pageRows" :key="card.key" class="purchase-order-card">
          <div class="purchase-card-image" @click="card.thumb&&openImage(card.thumb,card.style_name)"><img v-if="card.thumb&&!imageErrors[card.key]" :src="card.thumb" alt="款式效果图" @error="imageErrors[card.key]=true" /><span v-else>暂无款图</span><small>{{ card.order_id?(card.type==='custom'?'定制':'现货'):'备货采购' }}</small></div>
          <div class="purchase-card-content">
            <header><label class="card-select"><input type="checkbox" :checked="cardSelected(card)" :disabled="!draftIds(card).length" @change="toggleCard(card)" aria-label="选择草稿采购单" /></label><button class="card-title" :title="card.style_name" @click="openCard(card)">款号：{{ card.style_name }}</button><span class="purchase-state" :class="card.status">{{ purchaseStates[card.status] }}</span></header>
            <div class="card-meta"><div>面料采购：<span class="purchase-state" :class="card.fabric_status">{{ purchaseStates[card.fabric_status] }}</span></div><div>辅料采购：<span class="purchase-state" :class="card.accessory_status">{{ purchaseStates[card.accessory_status] }}</span></div>
              <button class="text-button" @click="card.order_id&&router.push({path:'/orders',query:{order:card.order_id}})">订单号:{{ card.order_no||'未关联' }}</button><button class="text-button po-link" :title="card.purchase_nos" @click="openCard(card,'lines')">采购单号:{{ card.purchase_nos||'未建单' }}</button>
              <div class="full" :title="card.po_no">PO单号:{{ card.po_no||'—' }}</div><div :title="card.colors">颜色：{{ card.colors||'—' }}</div><div :title="card.sizes">尺码：{{ card.sizes||'—' }}</div><div>标签：{{ card.type==='custom'?'定制':'现货' }}</div><div :title="card.factory_names">加工厂：{{ card.factory_names||'未分配' }}</div><div :title="card.buyer_names">采购员：{{ card.buyer_names||'—' }}</div><div>下单时间：{{ fmtDate(card.order_date) }}</div>
            </div>
            <footer><button v-action="['purchases','create']" v-if="canWrite" class="p-primary" @click="buyCard(card)">采购</button><button class="p-primary" @click="openCard(card)">明细</button><button class="p-primary" :disabled="!card.purchase_ids.length" @click="printCard(card)">打印</button><button class="p-primary" @click="openConversation(card)">沟通</button><details><summary class="p-primary">更多⌄</summary><div><button @click="openCard(card,'materials')">物料清单</button><button v-if="card.order_id&&canVisit('/cuts')" @click="router.push({path:'/cuts',query:{layout_order:card.order_id}})">填写排版采购米数</button><button @click="openCard(card,'returns')">回料明细</button><button v-if="card.order_id" @click="router.push({path:'/orders',query:{order:card.order_id}})">订单详情</button></div></details></footer>
          </div>
        </article><div v-if="!pageRows.length" class="purchase-empty">暂无符合条件的订单</div>
      </div>
      <PurchaseWorkspaceTable v-else-if="!workspaceLoading" :mode="tab" :rows="pageRows" @purchase="openDetail" @receipt="goReceipt" />
    </section>
    <div v-if="workspaceCard" class="modal-mask"><div class="modal purchase-context"><div class="modal-head"><h3>采购明细 · {{ workspaceCard.order_no||workspaceCard.purchase_nos }}</h3><button class="x" @click="workspaceCard=null">×</button></div><div class="modal-body"><nav class="purchase-tabs"><button v-for="t in workspaceTabs.filter(t=>t.key!=='orders')" :key="t.key" :class="{active:cardTab===t.key}" @click="cardTab=t.key">{{ t.label }}</button></nav><PurchaseWorkspaceTable :mode="cardTab" :rows="cardRows" @purchase="openDetail" @receipt="goReceipt" /><div class="context-pos"><div v-for="p in workspaceCard.purchases" :key="p.id"><b>{{ p.po_no }}</b> · {{ p.supplier }} · {{ statusLabel(p.status) }} <button @click="openDetail(p.id)">打开采购单</button><button v-action="['purchases','order']" v-if="p.status==='draft'&&canWrite" @click="order(p)">确认下单</button><button v-action="['purchases','delete']" v-if="p.status==='draft'&&canWrite" @click="remove(p)">删除草稿</button></div></div></div><div class="modal-foot"><button @click="workspaceCard=null">关闭</button><button v-action="['purchases','create']" v-if="canWrite" class="p-primary" @click="openCreate(workspaceCard)">新增采购单</button></div></div></div>
    <div v-if="conversation" class="modal-mask"><div class="modal"><div class="modal-head"><h3>采购沟通</h3><button class="x" :disabled="noteBusy" @click="conversation=null">×</button></div><div class="modal-body"><p>{{ conversation.order_no||'备货采购' }}</p><pre class="conversation-history">{{ conversation.order_remark||'暂无订单备注' }}</pre><div v-for="p in conversation.purchases" :key="p.id"><b>{{ p.po_no }}</b><pre class="conversation-history">{{ p.remark||'暂无采购留言' }}</pre></div><template v-if="canWrite&&conversation.purchases.length"><label>采购单<select v-model.number="notePo"><option v-for="p in conversation.purchases" :key="p.id" :value="p.id">{{ p.po_no }}</option></select></label><textarea v-model="noteText" rows="4" maxlength="2000" placeholder="输入采购沟通内容" /></template><p v-else-if="!conversation.purchases.length">尚未建立采购单，新建后可在这里追加采购留言。</p></div><div class="modal-foot"><button :disabled="noteBusy" @click="conversation=null">关闭</button><button v-if="canWrite&&conversation.purchases.length" v-action="['purchases','note']" class="p-primary" :disabled="noteBusy||!noteText.trim()" @click="sendNote">发送</button></div></div></div>

    <div v-if="exportOpen" class="modal-mask"><section class="modal"><header class="modal-head"><h3>按订单号导出采购明细</h3><button class="x" :disabled="exportBusy" @click="exportOpen=false">×</button></header><div class="modal-body"><p>输入订单号或客户订单号，可换行、逗号分隔，最多100个。导出包含全部款式物料，按供应商分类排列。</p><textarea class="input" v-model="exportNumbers" rows="6" placeholder="输入订单号"/><p>排版采购需求米数取裁床保存值，未填显示“未填写”；不会采用技术预估值。</p><p role="alert">{{exportError}}</p></div><footer class="modal-foot"><button :disabled="exportBusy" @click="exportOpen=false">关闭</button><button class="p-primary" :disabled="exportBusy||!exportNumbers.trim()" @click="exportDetails">{{exportBusy?'导出中…':'导出CSV表格'}}</button></footer></section></div>
    <!-- 新建 -->
    <div v-if="showCreate" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head"><h3>新增采购单</h3><button class="x" @click="showCreate = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>供应商 *</label>
              <select class="select" v-model.number="form.supplier_id">
                <option :value="null">— 选择供应商档案 —</option>
                <option v-for="sp in sups" :key="sp.id" :value="sp.id">
                  {{ sp.name }}{{ qualNote(sp.id) ? ' · ' + qualNote(sp.id) : '' }}
                </option>
              </select>
              <div v-if="blocked" class="form-msg err" style="margin-top: 6px">{{ blocked }}</div>
            </div>
            <div class="fitem">
              <label>关联订单号</label>
              <div style="display:flex;gap:6px">
                <input class="input" style="flex:1" v-model="form.order_no" placeholder="选填：这张订单的料（备货采购可不填）" />
                <button type="button" class="btn btn-ghost btn-sm" style="white-space:nowrap"
                  :disabled="!String(form.order_no || '').trim()" @click="openTrace(form.order_no)">查这个号</button>
              </div>
              <div class="p-hint">填了必须与已有订单号一致；订单改号时这里的号会自动跟着变。不确定就先点「查这个号」，敲错一位会列出相近的号</div>
            </div>
            <div class="fitem"><label>下单日期</label><input class="input" type="date" v-model="form.order_date" /></div>
            <div class="fitem"><label>预计到货</label><input class="input" type="date" v-model="form.expect_date" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="form.remark" /></div>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">采购明细</h3>
          <div v-for="(it, i) in form.items" :key="i" style="border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 8px">
            <div class="form-grid">
              <div class="fitem">
                <label>从料库选择</label>
                <select class="select" v-model.number="it.material_id" @change="pickMaterial(it)">
                  <option :value="null">— 自定义 —</option>
                  <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.type === 'fabric' ? '面料' : '辅料' }} · {{ m.name }}</option>
                </select>
              </div>
              <div class="fitem"><label>名称 *</label><input class="input" v-model="it.name" /></div>
              <div class="fitem"><label>规格</label><input class="input" v-model="it.spec" /></div>
              <div class="fitem"><label>单位</label><input class="input" v-model="it.unit" /></div>
              <div class="fitem"><label>数量</label><input class="input" type="number" v-model.number="it.qty" /></div>
              <div class="fitem"><label>单价</label><input class="input" type="number" v-model.number="it.price" /></div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px">
              <span style="font-size: 12.5px; color: var(--ink-mute)">小计 ¥{{ money((it.qty || 0) * (it.price || 0)) }}</span>
              <button class="link-btn danger" @click="removeItem(i)" :disabled="form.items.length === 1">删</button>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="addItem">＋ 添加一行</button>
          <div style="text-align: right; font-weight: 700; margin-top: 10px">合计：¥{{ money(total) }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showCreate = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存草稿' }}</button>
        </div>
      </div>
    </div>

    <!-- 明细 / 收货 -->
    <div v-if="detail" class="modal-mask">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ detail.po_no }} · <span class="tag" :class="tagOf(detail.status)">{{ statusLabel(detail.status) }}</span></h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid" style="margin-bottom: 12px">
            <div><span style="color: var(--ink-mute); font-size: 12.5px">供应商</span><div><strong>{{ detail.supplier || '-' }}</strong></div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">金额</span><div>¥{{ money(detail.total_amount) }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">下单日期</span><div>{{ detail.order_date || '-' }}</div></div>
            <div><span style="color: var(--ink-mute); font-size: 12.5px">预计到货</span><div>{{ detail.expect_date || '-' }}</div></div>
          </div>

          <table class="data" style="border: 1px solid var(--line); border-radius: 8px; overflow: hidden">
            <thead><tr><th>物料</th><th>规格</th><th>单位</th><th>数量</th><th>已到</th><th>未到</th><th>单价</th><th>金额</th><th v-if="detail.status !== 'received'">本次到货</th></tr></thead>
            <tbody>
              <tr v-for="it in detail.items" :key="it.id">
                <td><strong>{{ it.name }}</strong></td>
                <td>{{ it.spec || '-' }}</td>
                <td>{{ it.unit || '-' }}</td>
                <td>{{ it.qty }}</td>
                <td>{{ it.received_qty }}</td>
                <td>{{ Math.max(0, it.qty - it.received_qty) }}</td>
                <td>¥{{ money(it.price) }}</td>
                <td>¥{{ money(it.amount) }}</td>
                <td v-if="detail.status !== 'received'">
                  <input class="input" type="number" v-model.number="recv[it.id]" style="width: 90px; padding: 4px 6px" />
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="detail.status === 'ordered' && canWrite" style="margin-top: 12px">
            <button v-action="['purchases','receive']" class="btn btn-primary btn-sm" :disabled="receiving" @click="receive">确认到货（生成收料单）</button>
            <span style="font-size: 12px; color: var(--ink-mute); margin-left: 8px">到货先进「待检」，检验合格后才进可用库存</span>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="detail = null">关闭</button></div>
      </div>
    </div>

    <!-- 订单号反查：填关联订单前先确认这个号是谁的单 -->
    <OrderNoTrace v-model="traceOpen" :initial-no="traceSeed" @open-order="onTraceOpenOrder" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import {canVisit} from '../store/navigation';
import OrderNoTrace from '../components/OrderNoTrace.vue';
import PurchaseWorkspaceTable from '../components/PurchaseWorkspaceTable.vue';
import {fmtDate} from '../utils/time';
import {openImage} from '../store/viewer';

const exportOpen=ref(false),exportBusy=ref(false),exportNumbers=ref(''),exportError=ref('');
async function exportDetails(){exportBusy.value=true;exportError.value='';try{await api.download('/api/purchases/order-details.csv?order_numbers='+encodeURIComponent(exportNumbers.value),'采购订单明细.csv');}catch(e){exportError.value=e.message;}finally{exportBusy.value=false;}}
const list = ref([]);
const materials = ref([]);
const q = ref('');
const status = ref('');
const showCreate = ref(false);
const saving = ref(false);
const detail = ref(null);
const receiving = ref(false);
const recv = reactive({});
const form = ref(blank());
const canWrite = can('purchase.write');

const router = useRouter();
const route=useRoute();
const scope=computed(()=>route.query.scope);
const scopeLabel=computed(()=>scope.value==='order'?'订单采购核对':scope.value==='advance'?'提前采购':'采购列表');

/* 订单号反查：填号之前先确认这个号是别人的哪张单 —— 敲错一位就挂到别人的单上了 */
const traceOpen = ref(false);
const traceSeed = ref('');
function openTrace(seed) {
  traceSeed.value = String(seed || form.value.order_no || q.value || '').trim();
  traceOpen.value = true;
}
function onTraceOpenOrder(id) {
  traceOpen.value = false;
  router.push({ path: '/orders', query: { order: id } });
}

const S = { draft: '草稿', ordered: '已下单', received: '已收货', cancelled: '已取消' };
const T = { draft: 'gray', ordered: 'blue', received: 'green', cancelled: 'red' };
const statusLabel = (s) => S[s] || s;
const tagOf = (s) => T[s] || 'gray';
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function blankItem() { return { material_id: null, name: '', spec: '', unit: '', qty: 1, price: 0 }; }
function blank() { return { supplier_id: null, supplier: '', order_no: '', order_date: '', expect_date: '', remark: '', items: [blankItem()] }; }
const total = computed(() => form.value.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));

async function load() {
 workspaceLoading.value=true;workspaceError.value='';
 try {workspace.value=await api.purchaseWorkspace();list.value=workspace.value.cards.flatMap(c=>c.purchases);if(workspaceCard.value)workspaceCard.value=workspace.value.cards.find(c=>c.key===workspaceCard.value.key)||null;if(conversation.value)conversation.value=workspace.value.cards.find(c=>c.key===conversation.value.key)||null;selectedIds.value=selectedIds.value.filter(id=>list.value.some(p=>p.id===id&&p.status==='draft'));}
 catch(e){workspaceError.value=e.message;}finally{workspaceLoading.value=false;}
}
async function loadMaterials() {
  try { materials.value = await api.materials({ status: 'active' }); } catch (e) { /* ignore */ }
}

// 供应商档案 + 当前资格（下单门禁按它卡）
const sups = ref([]);
const quals = ref({});
async function loadSups() {
  try {
    const d = await api.suppliers({ status: 'active' });
    sups.value = Array.isArray(d) ? d : (d.rows || []);
  } catch (e) { sups.value = []; }
  try {
    const q = await api.supplierQualifications();
    const m = {};
    (q || []).forEach((x) => { m[x.supplier_id] = x; });
    quals.value = m;
  } catch (e) { quals.value = {}; }
}
function qualNote(id) {
  const q = quals.value[id];
  if (!q) return '';
  return { qualified: '合格供方', conditional: '有条件', observing: '观察期', suspended: '暂停新单' }[q.status] || q.status;
}
const blocked = computed(() => {
  const q = quals.value[form.value.supplier_id];
  if (!q) return '';
  if (q.status === 'suspended') return `这家供应商资格为「暂停新单」：${q.reason || ''}。下单会被拒，请先处理整改或用其他供方`;
  if (q.status === 'conditional') return `有条件下单：${q.reason || ''}`;
  if (q.status === 'observing') return '观察期供应商：可下单，但别一次压满产能';
  return '';
});

function openCreate(card) {
 form.value=blank();if(card?.key){form.value.order_no=card.order_no;const remaining=(card.material_rows||[]).filter(m=>m.material_id&&m.need_qty>0).map(m=>{const bought=card.purchase_lines.filter(l=>l.material_id===m.material_id&&l.status!=='cancelled').reduce((n,l)=>n+Number(l.qty),0);return {material_id:m.material_id,name:m.material_name,spec:m.spec_info||'',unit:m.unit||'',qty:Math.max(0,m.need_qty-bought),price:Number(m.unit_price)||0};}).filter(i=>i.qty>0);if(remaining.length)form.value.items=remaining;}
 showCreate.value=true;
}
function addItem() { form.value.items.push(blankItem()); }
function removeItem(i) { if (form.value.items.length > 1) form.value.items.splice(i, 1); }
function pickMaterial(it) {
  const m = materials.value.find((x) => x.id === it.material_id);
  if (!m) return;
  it.name = m.name;
  it.spec = m.spec || m.spec_info || '';
  it.unit = m.unit || '';
}

async function save() {
  const items = form.value.items.filter((it) => it.name && Number(it.qty) > 0);
  if (!items.length) return alert('请至少填写一条有效明细');
  if (!form.value.supplier_id) return alert('请选择供应商档案（评价和收货要对得上）');
  saving.value = true;
  try {
    const payload = { ...form.value, items };
    if (!String(payload.order_no || '').trim()) delete payload.order_no;
    const r = await api.createPurchase(payload);
    showCreate.value = false;
    await load();
    await loadSups();
    workspaceCard.value=null;
    if (r.qualification_warning) alert(`已建单 ${r.po_no}\n\n注意：${r.qualification_warning}`);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function order(p) {
  if (!confirm(`确定对采购单 ${p.po_no} 下单？`)) return;
  try { await api.orderPurchase(p.id); await load(); } catch (e) { alert(e.message); }
}
async function remove(p) {
  if (!confirm(`删除采购单 ${p.po_no}？`)) return;
  try { await api.deletePurchase(p.id); await load(); } catch (e) { alert(e.message); }
}
async function openDetail(id) {
  try {
    detail.value = await api.purchase(id);
    Object.keys(recv).forEach((k) => delete recv[k]);
    detail.value.items.forEach((it) => { recv[it.id] = Math.max(0, it.qty - it.received_qty); });
  } catch (e) { alert(e.message); }
}
async function receive() {
  const items = Object.entries(recv).map(([id, qty]) => ({ id: Number(id), qty: Number(qty) || 0 })).filter((x) => x.qty > 0);
  if (!items.length) return alert('请填写到货数量');
  receiving.value = true;
  try {
    const r = await api.receivePurchase(detail.value.id, items);
    detail.value = r;
    await load();
    alert(r.notice || '已生成收料单，待来料检查');
  } catch (e) { alert(e.message); } finally { receiving.value = false; }
}

onMounted(async () => {
  await loadMaterials();
  await loadSups();
  await load();
});

const workspace=ref({cards:[]}),workspaceLoading=ref(false),workspaceError=ref(''),notice=ref(''),tab=ref('orders'),workspaceCard=ref(null),cardTab=ref('materials'),imageErrors=reactive({});
const workspaceTabs=[{key:'orders',label:'按订单采购'},{key:'materials',label:'物料清单'},{key:'lines',label:'采购明细'},{key:'returns',label:'回料明细'}];
watch(scope,v=>{page.value=1;tab.value=v==='order'?'materials':'orders';}, {immediate:false});
if(scope.value==='order')tab.value='materials';
const stateFilters=[{key:'status',label:'采购状态'},{key:'fabric_status',label:'面料采购状态'},{key:'accessory_status',label:'辅料采购状态'}];
const purchaseStates={pending:'待采购',ordering:'采购中',received:'已到货',cancelled:'已取消',unknown:'未登记'};
const search=reactive({style:'',number:'',po:'',status:'',fabric_status:'',accessory_status:'',buyer:'',customer:'',factory:'',from:'',to:'',color:'',audit:''});
const filteredCards=computed(()=>workspace.value.cards.filter(c=>{
 if(scope.value==='order'&&!c.order_id || scope.value==='advance'&&c.order_id)return false;
 const includes=(value,q)=>!q||String(value||'').toLowerCase().includes(q.trim().toLowerCase());
 return includes(c.style_name,search.style)&&includes(c.order_no+' '+c.purchase_nos,search.number)&&includes(c.po_no,search.po)&&includes(c.buyer_names,search.buyer)&&includes(c.customer_name,search.customer)&&includes(c.factory_names,search.factory)&&includes(c.colors,search.color)&&stateFilters.every(f=>!search[f.key]||c[f.key]===search[f.key])&&(!search.audit||c.audit_status===search.audit)&&(!search.from||fmtDate(c.created_at)>=search.from)&&(!search.to||fmtDate(c.created_at)<=search.to);
}));
function rowsOf(card,mode){return mode==='materials'?card.material_rows:mode==='lines'?card.purchase_lines:card.receipts;}
const activeRows=computed(()=>tab.value==='orders'?filteredCards.value:filteredCards.value.flatMap(c=>rowsOf(c,tab.value)));
const cardRows=computed(()=>workspaceCard.value?rowsOf(workspaceCard.value,cardTab.value):[]);
const buyers=computed(()=>[...new Set(workspace.value.cards.flatMap(c=>c.buyer_names.split(' / ')).filter(Boolean))]);
const page=ref(1),pageSize=ref(9),jump=ref(1),pageCount=computed(()=>Math.max(1,Math.ceil(activeRows.value.length/pageSize.value)));
const pageRows=computed(()=>activeRows.value.slice((page.value-1)*pageSize.value,page.value*pageSize.value));
const pages=computed(()=>{const start=Math.max(1,Math.min(page.value-2,pageCount.value-4));return Array.from({length:Math.min(5,pageCount.value)},(_,i)=>start+i);});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});watch(page,v=>jump.value=v);
function jumpPage(){page.value=Math.max(1,Math.min(pageCount.value,Math.trunc(Number(jump.value))||1));jump.value=page.value;}
function resetSearch(){Object.keys(search).forEach(k=>search[k]='');page.value=1;}
function openCard(card,mode='materials'){workspaceCard.value=card;cardTab.value=mode;}
function buyCard(card){if(card.purchases.length)openCard(card,'lines');else openCreate(card);}
function goReceipt(id){router.push({path:'/receipts',query:{receipt:id}});}
function printCard(card){if(!card.purchase_ids.length)return;window.open('/print/purchase/'+card.purchase_ids.join(','),'_blank','noopener');}
const selectedIds=ref([]),batchBusy=ref(false),selectedDrafts=computed(()=>list.value.filter(p=>p.status==='draft'&&selectedIds.value.includes(p.id)));
function draftIds(card){return card.purchases.filter(p=>p.status==='draft').map(p=>p.id);}
function cardSelected(card){const ids=draftIds(card);return ids.length>0&&ids.every(id=>selectedIds.value.includes(id));}
function toggleCard(card){const ids=draftIds(card),was=cardSelected(card);selectedIds.value=was?selectedIds.value.filter(id=>!ids.includes(id)):[...new Set([...selectedIds.value,...ids])];}
async function batchOrder(){if(batchBusy.value||!selectedDrafts.value.length)return;if(!confirm('确认对选中的 '+selectedDrafts.value.length+' 张草稿采购单下单？'))return;batchBusy.value=true;let passed=0;const failures=[];for(const p of [...selectedDrafts.value]){try{await api.orderPurchase(p.id);passed++;}catch(e){failures.push(p.po_no+'：'+e.message);}}await load();batchBusy.value=false;notice.value='已确认下单 '+passed+' 张'+(failures.length?'；失败：'+failures.join('；'):'');}
const conversation=ref(null),noteText=ref(''),notePo=ref(null),noteBusy=ref(false);
function openConversation(card){conversation.value=card;noteText.value='';notePo.value=card.purchase_ids[0]||null;}
async function sendNote(){if(noteBusy.value)return;const p=conversation.value?.purchases.find(p=>p.id===notePo.value);if(!p)return;noteBusy.value=true;try{await api.purchaseNote(p.id,{message:noteText.value,updated_at:p.updated_at});noteText.value='';await load();}catch(e){alert(e.message);}finally{noteBusy.value=false;}}

</script>

<style scoped>
/* 关联订单号下面那行说明：全局没有这个类，不定义就与输入框贴在一起看不出层级 */
.p-hint { font-size: 12px; color: var(--ink-mute); line-height: 1.55; margin-top: 4px; }

/* Reference purchase workspace: compact filters, three columns, quiet surfaces; theme tokens support dark mode. */
.purchase-page{--purchase-blue:#1890ff;font-size:12px;background:var(--surface);color:var(--ink);padding:8px;margin:-18px -20px 0;min-height:100%;}
.purchase-crumb{color:var(--ink-mute);padding:0 0 14px;}.purchase-crumb b{color:var(--ink-soft);}
.purchase-filters{display:flex;gap:9px 18px;flex-wrap:wrap;align-items:center;padding:0 0 26px;}
.purchase-filters label{display:flex;align-items:center;gap:12px;white-space:nowrap;font-weight:550;}
.purchase-page input,.purchase-page select,.purchase-page textarea{border:1px solid var(--line);background:var(--surface);color:var(--ink-soft);border-radius:3px;min-height:29px;padding:4px 10px;font-size:12px;}
.purchase-filters input:not([type]),.purchase-filters select{width:170px;}.date-filter input[type=date]{width:126px;}
.purchase-page button{cursor:pointer;font-size:12px;}.purchase-page button:disabled{opacity:.45;cursor:not-allowed;}
.purchase-page .text-button{border:0;background:transparent;color:var(--purchase-blue);padding:2px 0;text-align:left;min-width:0;}
.purchase-workspace{border:1px solid var(--line);}.purchase-tabs{display:flex;background:var(--surface-2);border-bottom:1px solid var(--line);overflow:auto;}.purchase-tabs button{white-space:nowrap;border:0;border-right:1px solid transparent;background:transparent;color:var(--ink-mute);padding:10px 18px;min-height:35px;}.purchase-tabs button.active{border-right-color:var(--line);color:var(--purchase-blue);background:var(--surface);}
.purchase-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 14px 8px;padding:5px 0;border-bottom:1px solid var(--line);color:var(--ink-soft);}.purchase-tools>button,.purchase-context .modal-foot>button{padding:6px 13px;border:1px solid var(--line);background:var(--surface);border-radius:3px;color:var(--ink-soft);}.tools-space{flex:1;}.purchase-page .p-primary{border:1px solid var(--purchase-blue);background:var(--purchase-blue);color:#fff;border-radius:3px;padding:6px 12px;}.purchase-page .p-warning{border:1px solid #ffb800;background:#ffb800;color:#fff;border-radius:3px;}.purchase-tools select{min-height:25px;}.purchase-tools label{display:flex;align-items:center;gap:6px;}.purchase-page .page-jump{width:44px;text-align:center;min-height:25px;}.purchase-pager{display:flex;gap:3px;align-items:center;}.purchase-pager button{width:27px;height:26px;border:0;border-radius:3px;background:var(--surface-2);color:var(--ink-soft);}.purchase-pager button.active{background:var(--purchase-blue);color:#fff;}
.purchase-card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:0 14px 16px;}.purchase-order-card{display:flex;align-items:stretch;border:1px solid var(--line);border-radius:6px;padding:12px 9px;gap:9px;box-shadow:0 2px 7px #1836520c;background:var(--surface);min-height:234px;}.purchase-card-image{width:96px;flex:none;height:180px;position:relative;background:var(--surface-2);border-radius:3px;overflow:hidden;cursor:zoom-in;display:grid;place-items:center;color:var(--ink-mute);}.purchase-card-image img{width:100%;height:158px;object-fit:contain;background:var(--surface);}.purchase-card-image small{position:absolute;bottom:0;left:0;right:0;background:#808080;color:#fff;text-align:center;height:22px;line-height:22px;font-size:11px;}.purchase-card-content{min-width:0;flex:1;}.purchase-card-content header{display:flex;align-items:center;gap:4px;min-height:28px;margin-bottom:8px;}.purchase-page .card-title{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;background:transparent;border:0;color:var(--ink);padding:0;flex:1;min-width:0;}.card-select{display:grid;place-items:center;}.purchase-page .card-select input{width:12px;height:12px;min-height:12px;padding:0;margin:0;accent-color:var(--purchase-blue);}.purchase-state{display:inline-block;font-size:11px;font-weight:400;color:var(--ink-mute);padding:2px 5px;border-radius:3px;white-space:nowrap;background:var(--surface-2);}.purchase-state.ordering{color:#ef8f20;background:color-mix(in srgb,#ffb84d 15%,var(--surface));}.purchase-state.pending{color:#1687ef;background:color-mix(in srgb,#1890ff 10%,var(--surface));}.purchase-state.received{color:var(--success);background:color-mix(in srgb,var(--success) 10%,var(--surface));}
.card-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;font-size:11px;color:var(--ink);}.card-meta>div,.card-meta>button{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}.card-meta .full{grid-column:1/-1;}.purchase-page .po-link{color:#e99514;}.purchase-card-content footer{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;}.purchase-card-content footer button,.purchase-card-content footer summary{padding:6px 10px;white-space:nowrap;}.purchase-card-content details{position:relative;}.purchase-card-content summary{list-style:none;cursor:pointer;}.purchase-card-content details>div{position:absolute;right:0;top:34px;z-index:3;min-width:120px;padding:5px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-md);}.purchase-card-content details>div button{display:block;width:100%;border:0;background:var(--surface);color:var(--ink-soft);text-align:left;}
.purchase-empty{padding:60px 20px;text-align:center;color:var(--ink-mute);grid-column:1/-1;}.purchase-notice{padding:0 14px;color:var(--warning);}.purchase-error{padding:0 14px;color:var(--danger);}.purchase-context{width:1100px;max-width:95vw;}.context-pos{display:grid;gap:9px;margin-top:14px;}.context-pos button{color:var(--purchase-blue);border:0;background:transparent;}.conversation-history{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:var(--surface-2);padding:10px;border:1px solid var(--line);border-radius:3px;max-height:220px;overflow:auto;}.purchase-page textarea{width:100%;margin-top:12px;}
@media(max-width:1450px){.purchase-card-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.purchase-page{margin:0;}}
@media(max-width:850px){.purchase-card-grid{grid-template-columns:1fr;}.purchase-filters{gap:9px;}.purchase-filters input:not([type]),.purchase-filters select{width:150px;}}

</style>
