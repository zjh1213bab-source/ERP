<template>
  <div class="preorders-page">
    <div class="page-head">
      <div><h2>预下单</h2><div class="sub">客户需求阶段的意向订单，独立于销售正式订单；面辅料新品开发从这里关联预下单。</div></div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增预下单</button>
    </div>
    <div class="toolbar"><input class="input" v-model="q" placeholder="搜索预下单编号、客户或款名" @keyup.enter="load"/><button class="btn btn-ghost" @click="load">查询</button><span class="sub">{{ filtered.length }} 条预下单</span></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>预下单编号</th><th>客户</th><th>款名 / 款号</th><th>预估数量</th><th>目标交期</th><th>客户要求</th><th>录入时间</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead><tbody>
      <tr v-for="row in filtered" :key="row.id"><td><strong>{{ row.pre_order_no }}</strong></td><td>{{ row.customer_name }}</td><td>{{ row.style_name || '—' }}</td><td>{{ row.expected_qty || '—' }}</td><td>{{ row.target_date || '—' }}</td><td class="pre-note">{{ row.requirements || '—' }}</td><td>{{ fmt(row.created_at) }}</td><td><span class="tag green">可用于新品开发</span></td><td v-if="canWrite"><button class="link-btn" @click="edit(row)">编辑</button></td></tr>
      <tr v-if="!filtered.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无预下单。新增后可在“面辅料新品开发”中选择，正式销售订单列表不会混入预下单。</td></tr>
    </tbody></table></div>

    <div v-if="showForm" class="po-overlay" @click.self="showForm=false"><form class="po-modal" @submit.prevent="save">
      <div class="po-modal-head"><div><small>PRE-ORDER · SALES INTENT</small><h3>{{ form.id ? '编辑预下单' : '新增预下单' }}</h3></div><button type="button" class="po-close" @click="showForm=false">×</button></div>
      <div class="po-fields"><label>客户名称 <b>*</b><input v-model.trim="form.customer_name" required placeholder="客户 / 品牌名称"/></label><label>款名 / 款号<input v-model.trim="form.style_name" placeholder="客户款号或款式名称"/></label><label>预估数量<input v-model.number="form.expected_qty" type="number" min="0" placeholder="预估件数"/></label><label>目标交期<input v-model="form.target_date" type="date"/></label></div>
      <label class="po-requirements">订单 / 客户要求<textarea v-model="form.requirements" rows="3" placeholder="记录客户初步订单信息，可后续补充"></textarea></label>
      <div class="po-footer"><span>预下单只用于需求准备和开发跟进，不会创建正式销售订单。</span><button type="button" class="btn btn-ghost" @click="showForm=false">取消</button><button class="btn btn-primary" :disabled="busy">{{ form.id ? '保存' : '新增预下单' }}</button></div>
    </form></div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
const rows = ref([]), q = ref(''), showForm = ref(false), busy = ref(false);
const form = reactive({ id: null, customer_name: '', style_name: '', expected_qty: 0, target_date: '', requirements: '' });
const canWrite = computed(() => can('order.create'));
const filtered = computed(() => rows.value.filter((r) => !q.value.trim() || [r.pre_order_no,r.customer_name,r.style_name].some((x) => String(x || '').toLowerCase().includes(q.value.trim().toLowerCase()))));
const fmt = (v) => v ? new Date(v).toLocaleDateString('zh-CN') : '—';
async function load() { try { rows.value = await api.preOrders({}); } catch (e) { alert(e.message); } }
function openCreate() { Object.assign(form, { id: null, customer_name: '', style_name: '', expected_qty: 0, target_date: '', requirements: '' }); showForm.value = true; }
function edit(row) { Object.assign(form, { id: row.id, customer_name: row.customer_name, style_name: row.style_name || '', expected_qty: row.expected_qty || 0, target_date: row.target_date || '', requirements: row.requirements || '' }); showForm.value = true; }
async function save() { busy.value = true; try { const payload = { ...form }; if (form.id) await api.updatePreOrder(form.id, payload); else await api.createPreOrder(payload); showForm.value = false; await load(); } catch (e) { alert(e.message); } finally { busy.value = false; } }
onMounted(load);
</script>

<style scoped>
.preorders-page{color:var(--ink)}.preorders-page .toolbar{display:flex;gap:9px;align-items:center;margin-bottom:14px}.preorders-page .toolbar .sub{margin-left:auto}.pre-note{max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.po-overlay{position:fixed;inset:0;background:#101827a8;z-index:1000;display:grid;place-items:center;padding:18px}.po-modal{width:min(640px,100%);background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:15px;padding:22px;box-shadow:var(--shadow-md)}.po-modal-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:17px}.po-modal-head small{font-size:9px;letter-spacing:1.3px;color:var(--ink-mute);font-weight:800}.po-modal-head h3{margin:5px 0 0;font-size:19px}.po-close{border:0;width:29px;height:29px;border-radius:7px;background:var(--surface-2);color:var(--ink-soft);font-size:20px;cursor:pointer}.po-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.po-fields label,.po-requirements{display:grid;gap:6px;color:var(--ink-soft);font-size:11px}.po-fields b{color:#d45e54}.po-fields input,.po-requirements textarea{height:38px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:0 10px;font:inherit}.po-requirements{margin-top:13px}.po-requirements textarea{height:auto;padding:10px;resize:vertical}.po-footer{display:flex;align-items:center;gap:8px;margin-top:18px}.po-footer span{margin-right:auto;color:var(--ink-mute);font-size:10px;max-width:310px}.tag.green{background:#e7f7ee;color:#258452;border-radius:20px;padding:4px 8px;font-size:10px}@media(max-width:620px){.po-fields{grid-template-columns:1fr}.po-footer{flex-wrap:wrap}.po-footer span{flex-basis:100%;max-width:none}.preorders-page .toolbar{flex-wrap:wrap}}
</style>
