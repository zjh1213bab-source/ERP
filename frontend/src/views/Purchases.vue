<template>
  <div>
    <div class="page-head">
      <div>
        <h2>采购管理</h2>
        <div class="sub">面辅料采购单：下单 → 到货点收（生成收料单进待检，来料检查合格才进可用库存）</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增采购单</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索 单号 / 供应商" @keyup.enter="load" style="width: 240px" />
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="draft">草稿</option>
        <option value="ordered">已下单</option>
        <option value="received">已收货</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>单号</th><th>供应商</th><th>金额</th><th>下单日</th><th>预计到货</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="p in list" :key="p.id">
            <td><strong>{{ p.po_no }}</strong></td>
            <td>{{ p.supplier || '-' }}</td>
            <td>¥{{ money(p.total_amount) }}</td>
            <td>{{ p.order_date || '-' }}</td>
            <td>{{ p.expect_date || '-' }}</td>
            <td><span class="tag" :class="tagOf(p.status)">{{ statusLabel(p.status) }}</span></td>
            <td>
              <button class="link-btn" @click="openDetail(p.id)">明细</button>
              <button v-if="p.status === 'draft' && canWrite" class="link-btn" @click="order(p)">下单</button>
              <button v-if="p.status === 'draft' && canWrite" class="link-btn danger" @click="remove(p)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td colspan="7" class="empty-cell">暂无采购单</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 新建 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
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
            <div class="fitem"><label>下单日期</label><input class="input" type="date" v-model="form.order_date" /></div>
            <div class="fitem"><label>预计到货</label><input class="input" type="date" v-model="form.expect_date" /></div>
            <div class="fitem full"><label>备注</label><input class="input" v-model="form.remark" /></div>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">采购明细</h3>
          <div v-for="(it, i) in form.items" :key="i" style="border: 1px solid #eef2f7; border-radius: 8px; padding: 10px; margin-bottom: 8px">
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
              <span style="font-size: 12.5px; color: #8a94a6">小计 ¥{{ money((it.qty || 0) * (it.price || 0)) }}</span>
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
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ detail.po_no }} · <span class="tag" :class="tagOf(detail.status)">{{ statusLabel(detail.status) }}</span></h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid" style="margin-bottom: 12px">
            <div><span style="color: #8a94a6; font-size: 12.5px">供应商</span><div><strong>{{ detail.supplier || '-' }}</strong></div></div>
            <div><span style="color: #8a94a6; font-size: 12.5px">金额</span><div>¥{{ money(detail.total_amount) }}</div></div>
            <div><span style="color: #8a94a6; font-size: 12.5px">下单日期</span><div>{{ detail.order_date || '-' }}</div></div>
            <div><span style="color: #8a94a6; font-size: 12.5px">预计到货</span><div>{{ detail.expect_date || '-' }}</div></div>
          </div>

          <table class="data" style="border: 1px solid #eef2f7; border-radius: 8px; overflow: hidden">
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

          <div v-if="detail.status !== 'received' && canWrite" style="margin-top: 12px">
            <button class="btn btn-primary btn-sm" :disabled="receiving" @click="receive">确认到货（生成收料单）</button>
            <span style="font-size: 12px; color: #8a94a6; margin-left: 8px">到货先进「待检」，检验合格后才进可用库存</span>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="detail = null">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

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

const S = { draft: '草稿', ordered: '已下单', received: '已收货', cancelled: '已取消' };
const T = { draft: 'gray', ordered: 'blue', received: 'green', cancelled: 'red' };
const statusLabel = (s) => S[s] || s;
const tagOf = (s) => T[s] || 'gray';
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function blankItem() { return { material_id: null, name: '', spec: '', unit: '', qty: 1, price: 0 }; }
function blank() { return { supplier_id: null, supplier: '', order_date: '', expect_date: '', remark: '', items: [blankItem()] }; }
const total = computed(() => form.value.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));

async function load() {
  try { list.value = await api.purchases({ q: q.value, status: status.value }); }
  catch (e) { alert(e.message); }
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

function openCreate() { form.value = blank(); showCreate.value = true; }
function addItem() { form.value.items.push(blankItem()); }
function removeItem(i) { if (form.value.items.length > 1) form.value.items.splice(i, 1); }
function pickMaterial(it) {
  const m = materials.value.find((x) => x.id === it.material_id);
  if (!m) return;
  it.name = m.name;
  it.spec = m.spec || '';
}

async function save() {
  const items = form.value.items.filter((it) => it.name && Number(it.qty) > 0);
  if (!items.length) return alert('请至少填写一条有效明细');
  if (!form.value.supplier_id) return alert('请选择供应商档案（评价和收货要对得上）');
  saving.value = true;
  try {
    const r = await api.createPurchase({ ...form.value, items });
    showCreate.value = false;
    await load();
    await loadSups();
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
</script>
