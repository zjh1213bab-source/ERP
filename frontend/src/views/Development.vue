<template>
  <div class="dev-reference-page">
    <div class="page-head">
      <div>
        <h2>开发管理</h2>
        <div class="sub">打版流程：可打版 → 面辅料确认 → 制版 → 工艺 → 做样衣 → 业务确认</div>
      </div>
      <div style="display: flex; gap: 10px">
        <div class="seg">
          <button :class="{ on: view === 'card' }" @click="view = 'card'">卡片</button>
          <button :class="{ on: view === 'kanban' }" @click="view = 'kanban'">看板</button>
        </div>
        <button v-action="['techpacks','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增开发单</button>
      </div>
    </div>

    <section class="dev-reference-filters">
      <label>状态<select v-model="tab" class="select"><option v-for="t in tabs" :key="t.key" :value="t.key">{{t.label}}</option></select></label>
      <label v-for="f in filterFields" :key="f.key">{{f.label}}<input v-model="filters[f.key]" class="input" :placeholder="'搜索'+f.label" :list="'dev-filter-'+f.key"/><datalist :id="'dev-filter-'+f.key"><option v-for="name in choices(f.key)" :key="name" :value="name"/></datalist></label>
      <label>样品来源<select v-model="filters.origin" class="select"><option value="">全部来源</option><option value="pre">预下单</option><option value="order">销售订单</option></select></label>
      <label>款号<input class="input" v-model="filters.style" placeholder="搜索款号"/></label><button class="link-btn" @click="batchSearchOpen=true">批量搜索</button>
      <label>订单号<input class="input" v-model="filters.order_no" placeholder="搜索订单号"/></label>
      <label class="date-filter">上传时间<input class="input" type="date" v-model="filters.from"/><span>－</span><input class="input" type="date" v-model="filters.to"/></label>
      <label>综合搜索<input class="input" v-model="q" placeholder="订单号 / 款名 / 客户"/></label><button class="btn btn-ghost" @click="resetFilters()">重置</button>
    </section>
    <div class="dev-list-toolbar"><button v-action="['techpacks','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate()">上传图片 / 新增开发单</button><button v-action="['techpacks','edit']" v-if="canWrite" class="btn btn-ghost" :disabled="!selected.length" @click="assignmentOpen=true">批量设置业务员</button><label class="dev-select-all"><input type="checkbox" :checked="pageRows.length>0&&pageRows.every(r=>selected.includes(r.id))" @change="selectPage($event.target.checked)"/>本页全选</label><span class="dev-selected-note">已选 {{selected.length}} 项</span><div class="dev-pager"><span>共 {{filtered.length}} 款</span><select class="select" v-model.number="pageSize"><option v-for="n in [12,24,48,96]" :key="n" :value="n">{{n}}条/页</option></select><button class="btn btn-ghost" :disabled="page===1" @click="page--">‹</button><span>{{page}} / {{pages}}</span><button class="btn btn-ghost" :disabled="page>=pages" @click="page++">›</button><button class="btn btn-ghost" @click="load()">刷新</button></div></div>
    <div v-if="notice" class="dev-notice" role="status">{{notice}}</div>
    <div v-if="view === 'card'" class="dev-reference-list"><div class="dev-reference-grid"><article v-for="r in pageRows" :key="r.id" class="dev-reference-card" :class="{selected:selected.includes(r.id)}"><label class="dev-card-select"><input type="checkbox" :checked="selected.includes(r.id)" :aria-label="'选择'+(r.customer_style_no||r.product_name)" @change="selectOne(r.id,$event.target.checked)"/></label><button class="dev-cover" @click="openDetail(r)" :aria-label="'查看开发单'+r.product_name"><img v-if="r.image_url" :src="r.image_url" :alt="r.product_name" data-no-image-preview/><span v-else>暂无款式图片</span><b class="dev-card-state">{{stageLabel(r.stage)}}</b><span class="dev-card-caption">{{r.customer_style_no||r.product_name}}</span></button><div class="dev-reference-actions"><small>{{r.customer_name||'未关联客户'}} · {{r.version}}</small><button class="link-btn" @click="openDetail(r)">详情</button><button v-action="['techpacks','edit']" v-if="canWrite" class="link-btn" @click="openEdit(r)">编辑</button><router-link v-if="!['sample_review','new_review'].includes(r.stage)" class="link-btn" :to="{path:'/pattern-board',query:{techpack:r.id}}">打版流程</router-link></div></article></div><div v-if="!filtered.length" class="empty-cell">暂无匹配开发单</div></div>

    <!-- 看板视图 -->
    <div v-else class="kanban">
      <div class="kcol" v-for="s in STAGES" :key="s.key">
        <div class="kcol-head">
          <span>{{ s.label }}</span>
          <span class="kcount">{{ byStage[s.key].length }}</span>
        </div>
        <div class="kcol-body">
          <div v-for="r in byStage[s.key]" :key="r.id" class="kcard">
            <div class="kcard-title">{{ r.product_name }}</div>
            <div class="kcard-sub">{{ r.order_no || '-' }} · {{ r.customer_name || '-' }}</div>
            <div class="kcard-acts">
              <button class="link-btn" @click="openDetail(r)">详情</button>
              <button v-action="['techpacks','edit']" class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-if="!['confirmed','sample_review','new_review'].includes(s.key)" class="link-btn" @click="advance(r)">推进 →</button>
            </div>
          </div>
          <div v-if="!byStage[s.key].length" class="kempty">—</div>
        </div>
      </div>
    </div>

    <div v-if="batchSearchOpen" class="modal-mask"><section class="modal"><div class="modal-head"><h3>批量搜索款号</h3><button class="x" @click="batchSearchOpen=false">×</button></div><div class="modal-body"><textarea v-model="filters.batch" rows="10" placeholder="每行一个款号，支持逗号分隔"/></div><div class="modal-foot"><button class="btn btn-ghost" @click="filters.batch='';batchSearchOpen=false">清除</button><button class="btn btn-primary" @click="batchSearchOpen=false">应用</button></div></section></div>
    <div v-if="assignmentOpen" class="modal-mask"><section class="modal"><div class="modal-head"><h3>批量设置业务员 · {{selected.length}} 项</h3><button class="x" :disabled="assigning" @click="assignmentOpen=false">×</button></div><div class="modal-body"><select class="select" v-model="assignment"><option value="">选择有效业务员账号</option><option v-for="u in salespeople" :key="u.id" :value="u.name">{{u.name}}</option></select><p>已确认、已归档或变更审核中的开发单仍按现有规则拒绝修改，逐项显示处理结果。</p></div><div class="modal-foot"><button class="btn btn-ghost" :disabled="assigning" @click="assignmentOpen=false">取消</button><button class="btn btn-primary" :disabled="assigning||!assignment" @click="assignSales()">{{assigning?'处理中…':'保存'}}</button></div></section></div>
    <!-- 全屏图片建档：先建立开发草稿，面辅料、工艺、客户要求在详情继续填写并提交审核。 -->
    <div v-if="showModal" class="modal-mask dev-upload-mask"><section class="modal dev-upload-modal pre-form" role="dialog" aria-modal="true" aria-label="上传图片新增开发单">
      <header class="modal-head"><h3>上传图片 / 新增开发单</h3><button class="x" :disabled="saving||uploading" @click="closeCreate()">×</button></header>
      <div class="modal-body">
        <PreOrderImageDrop single :remaining="1" :disabled="saving" @images="urls=>form.image_url=urls[0]" @uploading="value=>uploading=value" />
        <section class="dev-upload-meta"><div class="dev-upload-fields">
          <label><span>关联订单 <b>*</b></span><select v-model.number="form.order_id" :disabled="saving"><option :value="null">请选择订单</option><option v-for="o in orders" :key="o.id" :value="o.id">{{o.order_no}} · {{o.customer_name||o.style_name}}</option></select></label>
          <label><span>客户</span><input :value="createOrder?.customer_name||'选择订单后自动带出'" readonly/></label>
          <label><span>业务员</span><input :value="createOrder?.manager||auth.user?.name||auth.user?.username||'—'" readonly/></label>
          <label><span>目标交期</span><input :value="createOrder?.delivery_date||'—'" readonly/></label>
          <label><span>版本</span><input v-model="form.version" readonly/></label>
          <label class="dev-upload-notice">先保存图片和款式资料；面辅料、外发工艺、客户要求在开发详情填写，提交审核通过后继续打版。</label>
        </div></section>
        <section class="dev-upload-preview"><article class="dev-upload-card"><div class="dev-upload-picture"><ImageUpload v-model="form.image_url" size="lg" :disabled="saving"/><p>点击图片放大查看 · 选中后可 Ctrl+V 替换</p></div><label><span>款式名称 <b>*</b></span><input v-model.trim="form.product_name" maxlength="255" placeholder="输入款式名称" /></label><label><span>备注</span><input v-model="form.remark" maxlength="2000" placeholder="请输入备注" /></label></article><div class="dev-upload-guide">{{form.image_url?'图片已上传，核对资料后保存':'将图片拖到上方，或点击空白处后粘贴图片'}}<small>每次保存建立一款开发草稿；已有订单的图片资料会保留在该开发单。</small></div></section>
      </div>
      <footer class="modal-foot"><span>点击空白处后可 Ctrl+V 粘贴图片。</span><button class="btn btn-ghost" :disabled="saving||uploading" @click="closeCreate()">关闭</button><button class="btn btn-primary" :disabled="saving||uploading" @click="save()">{{saving?'保存中…':'保存'}}</button></footer>
    </section></div>
    <!-- 开发详情（面辅料 / 成衣尺寸 / 生产要求） -->
    <TechPackDetail development-only :techpack-id="detailId" @close="detailId = null" @saved="load" @version-created="onVersionCreated" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import TechPackDetail from '../components/TechPackDetail.vue';
import MaterialPickerField from '../components/MaterialPickerField.vue';
import CraftEditor from '../components/CraftEditor.vue';
import PreOrderImageDrop from '../components/PreOrderImageDrop.vue';
import {auth} from '../store/auth';
import {entryId} from '../utils/orderEntry';
import ImageUpload from '../components/ImageUpload.vue';
import {localDate} from '../utils/time';

const route = useRoute();

const list = ref([]);
const q = ref('');
const view = ref('card');
const tab = ref('all');
const orders = ref([]);
const detailId = ref(null);

const showModal = ref(false);
const crafts = ref({ sewing: [], finish: [] });
const craftsOpen = ref(false);
const craftsDirty = ref(false);
const craftsLoadedFor = ref(null);
const saving = ref(false),uploading=ref(false);
const createOrder=computed(()=>orders.value.find(o=>o.id===form.value.order_id));
function closeCreate(){if(!saving.value&&!uploading.value)showModal.value=false;}
const form = ref(blank());

const canWrite = computed(() => can('development.write'));
/** 工序/工价是技术岗的活：与打版页 craft 阶段、接口 requireRole(['admin','tech']) 同一口径 */
const canCraft = computed(() => can('craft.write'));
const craftCount = computed(() => (crafts.value.sewing || []).length + (crafts.value.finish || []).length);
/** 车缝道数：后端确认校验要求 ≥1（只看有名称的行，与 normCraftRows 的过滤一致） */
const sewingCount = computed(() => (crafts.value.sewing || []).filter((r) => String(r.name || '').trim()).length);
const canReview = computed(() => can('development.review'));

const STAGES = [
  {key:'sample_review',label:'样衣待审核'},
  {key:'new_review',label:'新款待检查'},
  { key: 'draft', label: '可打版' },
  { key: 'material', label: '面辅料确认' },
  { key: 'pattern', label: '制版' },
  { key: 'craft', label: '工艺/工序' },
  { key: 'sample', label: '做样衣' },
  { key: 'biz', label: '业务确认' },
  { key: 'confirmed', label: '已完成' }
];
const tabs = [
  { key: 'all', label: '全部' },
  {key:'sample_review',label:'样衣待审核'},
  {key:'new_review',label:'新款待检查'},
  { key: 'draft', label: '待打版' },
  { key: 'doing', label: '打版中' },
  { key: 'confirmed', label: '已完成' }
];

const STAGE_TAG = { draft: 'gray', material: 'blue', pattern: 'purple', craft: 'blue', sample: 'orange', biz: 'orange', confirmed: 'green' };
const stageLabel = (s) => (STAGES.find((x) => x.key === s) || {}).label || s || '可打版';
const stageTag = (s) => STAGE_TAG[s] || 'gray';

const filterFields=[{key:'category',label:'分类'},{key:'series',label:'系列'},{key:'brand',label:'品牌'},{key:'designer',label:'设计师'},{key:'customer_name',label:'客户'},{key:'sales_owner',label:'业务员'}];
const emptyFilters=()=>({category:'',series:'',brand:'',designer:'',customer_name:'',sales_owner:'',origin:'',style:'',order_no:'',from:'',to:'',batch:''});
const filters=reactive(emptyFilters()),page=ref(1),pageSize=ref(12),selected=ref([]),batchSearchOpen=ref(false),assignmentOpen=ref(false),assignment=ref(''),assigning=ref(false),salespeople=ref([]),notice=ref('');
const choices=key=>[...new Set(list.value.map(r=>r[key]).filter(Boolean))].sort();
const filtered=computed(()=>list.value.filter(r=>{
 if(['sample_review','new_review'].includes(tab.value)&&r.stage!==tab.value)return false;
 if(tab.value==='draft'&&(r.stage||'draft')!=='draft')return false;
 if(tab.value==='confirmed'&&r.stage!=='confirmed')return false;
 if(tab.value==='doing'&&!['material','pattern','craft','sample','biz'].includes(r.stage))return false;
 if(filterFields.some(f=>filters[f.key]&&!String(r[f.key]||'').toLowerCase().includes(filters[f.key].toLowerCase())))return false;
 if(filters.origin==='pre'&&!r.pre_order_id||filters.origin==='order'&&!r.order_id)return false;
 const style=String(r.customer_style_no||r.product_name||'');
 if(filters.style&&!style.toLowerCase().includes(filters.style.toLowerCase()))return false;
 if(filters.order_no&&![r.business_order_no,r.order_no,r.pre_order_no].some(n=>String(n||'').toLowerCase().includes(filters.order_no.trim().toLowerCase())))return false;
 if(q.value&&![r.order_no,r.business_order_no,r.product_name,r.customer_name,r.customer_style_no].some(v=>String(v||'').toLowerCase().includes(q.value.toLowerCase())))return false;
 const date=localDate(r.created_at);if(filters.from&&date<filters.from||filters.to&&date>filters.to)return false;
 const batch=filters.batch.split(/[\n,，]/).map(x=>x.trim()).filter(Boolean);return !batch.length||batch.includes(style);
}));
const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/pageSize.value)));
const pageRows=computed(()=>filtered.value.slice((page.value-1)*pageSize.value,page.value*pageSize.value));
watch([filtered,pageSize],()=>{page.value=1;});
function resetFilters(){Object.assign(filters,emptyFilters());q.value='';tab.value='all';}
function selectOne(id,on){selected.value=on?[...new Set([...selected.value,id])]:selected.value.filter(x=>x!==id);}
function selectPage(on){for(const row of pageRows.value)selectOne(row.id,on);}
async function assignSales(){if(!assignment.value||assigning.value)return;assigning.value=true;const failures=[];let passed=0;for(const id of selected.value){try{await api.saveTechpackDetail(id,{sales_owner:assignment.value});passed++;}catch(e){failures.push(id+'：'+e.message);}}notice.value='业务员设置成功 '+passed+' 项'+(failures.length?'；未更新：'+failures.join('；'):'');assigning.value=false;assignmentOpen.value=false;selected.value=[];await load();}
const byStage = computed(() => {
  const m = {};
  STAGES.forEach((s) => (m[s.key] = []));
  filtered.value.forEach((r) => {
    const k = r.stage || 'draft';
    (m[k] || m.draft).push(r);
  });
  return m;
});

function blank() {
  return { id: null, order_id: null, product_name: '', version: 'V1', fabric_ids: [], accessory_ids: [], fabric_info: '', accessory_info: '', craft_info: '', customer_req: '', size_spec: '', image_url: '', remark: '' };
}

async function load() {
  try { list.value = await api.techpacksAll({});selected.value=selected.value.filter(id=>list.value.some(r=>r.id===id)); }
  catch (e) { alert(e.message); }
}
async function loadRefs() {
  // 物料档案不再在这里预载：选择器自己按需取（还要按类型分、按搜索词过服务端），
  // 页面进来就拉全量档案只是浪费一次请求
  orders.value = await api.orders({});
  if(canWrite.value)salespeople.value=await api.orderSalespeople();
}

/**
 * 工序明细：展开时才去取（新建的开发单还没有 id，必然是空表）
 *
 * 为什么不打开弹窗就拉：工序表只在用户点「展开填写」时才有意义；
 * 每次都拉一遍等于给列表翻页加一次多余请求。
 */
async function toggleCrafts() {
  if (craftsOpen.value) { craftsOpen.value = false; return; }
  craftsOpen.value = true;
  await loadCrafts(form.value.id);
}

async function loadCrafts(id) {
  if (!id) { crafts.value = { sewing: [], finish: [] }; craftsLoadedFor.value = 'new'; return; }
  if (craftsLoadedFor.value === id) return;
  try {
    const d = await api.techpackCrafts(id);
    crafts.value = { sewing: d.sewing || [], finish: d.finish || [] };
    craftsLoadedFor.value = id;
  } catch (e) {
    crafts.value = { sewing: [], finish: [] };
    craftsLoadedFor.value = id;
    alert('工序明细读取失败：' + e.message);
  }
}

/** 打开弹窗时重置工序状态：换了一条单子，不能把上一条的工序带过去 */
function resetCrafts() {
  crafts.value = { sewing: [], finish: [] };
  craftsOpen.value = false;
  craftsDirty.value = false;
  craftsLoadedFor.value = null;
}

function openCreate() { form.value = {...blank(),product_name:'新款-'+entryId().slice(0,12).toUpperCase()}; resetCrafts(); showModal.value = true; }
function openDetail(r) { detailId.value = r.id; }
function onVersionCreated(id) { detailId.value = id; load(); }
function openEdit(r) { openDetail(r); }

async function save() {
  if(saving.value||uploading.value)return;
  if (!form.value.order_id) return alert('请选择关联订单');
  if (!form.value.product_name) return alert('请填写产品/款号');
  const payload = {
    order_id: form.value.order_id,
    product_name: form.value.product_name,
    version: form.value.version,
    fabric_ids: form.value.fabric_ids.join(','),
    accessory_ids: form.value.accessory_ids.join(','),
    fabric_info: form.value.fabric_info,
    accessory_info: form.value.accessory_info,
    craft_info: form.value.craft_info,
    customer_req: form.value.customer_req,
    size_spec: form.value.size_spec,
    image_url: form.value.image_url,
    remark: form.value.remark
  };
  saving.value = true;
  try {
    let tpId = form.value.id;
    if (tpId) {
      await api.updateTechpack(tpId, payload);
    } else {
      // 新建时必须先拿到 id 才能写工序（工序挂在开发单的打版流程上）
      const created = await api.createTechpack(payload);
      tpId = created && created.id;
    }

    /**
     * 工序明细单独提交，且**只在展开过、且改过**的时候提交
     *
     * 两个原因：
     *   1. 没展开就没有加载，此时提交会把已有工序覆盖成空表；
     *   2. 工序写的是打版流程 craft 阶段的那份数据 —— 没改就别碰，
     *      免得把技术岗刚在打版页填的工价盖掉。
     * 失败时开发单已经保存了，必须说清楚"哪一半成功了"，否则用户会以为全丢了。
     */
    if (craftsOpen.value && craftsDirty.value && tpId && canCraft.value) {
      try {
        const out = await api.saveTechpackCrafts(tpId, crafts.value);
        crafts.value = { sewing: out.sewing || [], finish: out.finish || [] };
        craftsDirty.value = false;
      } catch (e) {
        alert('开发单已保存，但工序明细没保存成功：' + e.message + '\n（可稍后在「打版流程 → 工艺/工序明细」里补填）');
      }
    }

    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

async function advance(r) {
  const idx = STAGES.findIndex((s) => s.key === (r.stage || 'draft'));
  if (idx < 0 || idx >= STAGES.length - 1) return;
  const next = STAGES[idx + 1];
  try { await api.techpackStage(r.id, next.key); await load(); }
  catch (e) { alert(e.message); }
}

async function onImage(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { alert('图片不能超过 3MB'); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const up = await api.upload(reader.result);
      form.value.image_url = up.url;
    } catch (err) { alert(err.message); }
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}

onMounted(async () => {
  if (route.query.view === 'kanban') view.value = 'kanban';
  try { await loadRefs(); } catch (e) { /* ignore */ }
  await load();
});
</script>

<style scoped>
.dev-reference-page{--dev-accent:var(--brand,#1685ff)}
.dev-reference-filters{display:flex;align-items:center;flex-wrap:wrap;gap:12px 18px;padding:16px;background:var(--surface);border:1px solid var(--line);border-radius:4px}
.dev-reference-filters>label{display:flex;align-items:center;gap:10px;min-width:235px;font-size:12px;color:var(--ink-soft)}.dev-reference-filters .input,.dev-reference-filters .select{width:200px;min-width:0}.dev-reference-filters .date-filter{min-width:400px}.dev-reference-filters input[type=date]{width:160px}
.dev-list-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 0;padding:8px;background:var(--surface-2);border:1px solid var(--line)}.dev-list-toolbar .btn{font-size:12px;padding:7px 12px;min-height:30px}.dev-select-all{display:flex;align-items:center;gap:4px;font-size:12px;margin-left:8px}.dev-selected-note{font-size:12px;color:var(--ink-mute)}.dev-pager{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12px}.dev-pager .select{width:100px;padding:5px}.dev-reference-list{border:1px solid var(--line);border-top:0;padding:10px;background:var(--surface)}.dev-reference-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.dev-reference-card{position:relative;min-width:0;border:1px solid transparent}.dev-reference-card.selected{border-color:var(--dev-accent)}.dev-card-select{position:absolute;top:8px;left:8px;z-index:2;background:var(--surface);border-radius:3px;padding:2px}.dev-cover{display:block;position:relative;width:100%;height:220px;border:0;background:var(--surface-2);padding:0;cursor:pointer;overflow:hidden;color:var(--ink-mute)}.dev-cover img{width:100%;height:100%;object-fit:contain}.dev-card-caption{position:absolute;bottom:0;left:0;right:0;padding:10px 8px;color:#fff;background:#0008;text-align:left;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dev-card-state{position:absolute;bottom:46px;right:8px;padding:5px 7px;background:#0007;color:#fff;font-size:12px;font-weight:400}.dev-reference-actions{display:flex;align-items:center;gap:8px;padding:8px 4px;flex-wrap:wrap}.dev-reference-actions>small{margin-right:auto;color:var(--ink-mute);font-size:11px}.dev-reference-actions .link-btn{font-size:12px}.dev-notice{padding:10px;border:1px solid var(--line);background:var(--surface-2);font-size:12px;white-space:pre-wrap}
@media(max-width:1200px){.dev-reference-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:800px){.dev-reference-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dev-reference-filters>label{min-width:0;flex:1 1 240px}.dev-reference-filters .date-filter{min-width:0;flex-wrap:wrap}.dev-reference-filters .input,.dev-reference-filters .select{flex:1}.dev-pager{margin-left:0}.dev-cover{height:180px}}@media(max-width:480px){.dev-reference-grid{grid-template-columns:1fr}.dev-pager{flex-wrap:wrap}.dev-reference-filters .date-filter{flex-direction:column;align-items:stretch}}

/* 工艺工序：说明 + 可展开的明细表 */
.craft-bar { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.craft-tip { font-size: 12px; color: var(--ink-mute); }
.craft-dirty { font-size: 12px; color: #d46b08; }
/* 缺车缝工序时的提醒（后端确认校验的同一口径） */
.craft-miss { font-size: 12px; color: #c0392b; }
.craft-wrap { margin-top: 8px; padding: 8px; border: 1px dashed #d9e2ef; border-radius: 10px; background: #fbfcff; }

.dev-upload-mask{z-index:1200;padding:0!important}.modal.dev-upload-modal{position:fixed;inset:0;max-width:none;width:100vw;height:100vh;max-height:100vh;margin:0;border-radius:0;display:flex;flex-direction:column}.dev-upload-modal>.modal-head{padding:12px 20px;flex:none}.dev-upload-modal .modal-head h3{font-size:14px}.dev-upload-modal>.modal-body{flex:1;min-height:0;overflow:auto;padding:18px 24px;background:var(--surface)}.dev-upload-modal>.modal-foot{flex:none;padding:12px 20px;background:var(--surface)}.dev-upload-modal .modal-foot>span{margin-right:auto;font-size:12px;color:var(--ink-mute)}.dev-upload-meta,.dev-upload-preview{border:1px solid var(--line);box-shadow:0 2px 9px #142c4810;border-radius:4px;padding:18px;margin-top:12px;background:var(--surface)}.dev-upload-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px 24px}.dev-upload-fields label,.dev-upload-card>label{display:flex;align-items:center;gap:10px;font-size:12px;min-width:0}.dev-upload-fields label>span{white-space:nowrap;min-width:62px;color:var(--ink-soft)}.dev-upload-fields select,.dev-upload-fields input,.dev-upload-card>label input{border:1px solid var(--line);border-radius:3px;height:32px;background:var(--surface);color:var(--ink);font:inherit;padding:5px 8px;min-width:0;flex:1;box-sizing:border-box}.dev-upload-fields input[readonly]{background:var(--surface-2);color:var(--ink-mute)}.dev-upload-modal b{color:var(--danger)}.dev-upload-notice{grid-column:span 3;color:var(--ink-mute);font-size:12px}.dev-upload-preview{display:flex;gap:24px;align-items:center;min-height:220px}.dev-upload-card{padding:18px;border:1px solid var(--line);border-radius:4px;width:390px;max-width:100%;box-sizing:border-box;box-shadow:0 2px 8px #142c4810;display:grid;gap:12px}.dev-upload-picture{display:flex;align-items:center;gap:16px}.dev-upload-picture p{font-size:11px;line-height:1.8;color:var(--ink-mute)}.dev-upload-guide{color:var(--ink-soft);font-size:13px}.dev-upload-guide small{display:block;color:var(--ink-mute);font-size:12px;margin-top:10px}@media(max-width:1100px){.dev-upload-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.dev-upload-notice{grid-column:span 2}}@media(max-width:650px){.dev-upload-fields{grid-template-columns:1fr}.dev-upload-notice{grid-column:auto}.dev-upload-preview{flex-direction:column;align-items:stretch}.dev-upload-modal>.modal-body{padding:12px}.dev-upload-modal .modal-foot{flex-wrap:wrap}}
</style>
