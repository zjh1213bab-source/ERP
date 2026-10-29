<template>
  <div>
    <div class="page-head">
      <div>
        <h2>报价单</h2>
        <div class="sub">按数量阶梯自动取价 → 报价 → 一键转销售订单</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新建报价单</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索报价单号 / 客户" @keyup.enter="load" style="width: 240px" />
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>报价单号</th><th>客户</th><th class="num">数量</th>
            <th class="num">金额 USD</th><th class="num">折人民币</th>
            <th>有效期至</th><th>状态</th><th style="width: 240px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td><strong>{{ r.quote_no }}</strong></td>
            <td>{{ r.customer_name || '-' }}</td>
            <td class="num">{{ r.total_qty }}</td>
            <td class="num">${{ money(r.total_usd) }}</td>
            <td class="num">¥{{ money(r.total_amount) }}</td>
            <td>{{ r.valid_until || '-' }}</td>
            <td><span class="tag" :class="statusClass(r.status)">{{ labels[r.status] || r.status }}</span></td>
            <td>
              <button class="link-btn" @click="openDetail(r)">明细</button>
              <button v-if="r.status === 'draft' && canWrite" class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-if="r.status === 'draft' && canWrite" class="link-btn" @click="setStatus(r, 'sent')">发出</button>
              <button v-if="r.status === 'sent' && canWrite" class="link-btn" @click="setStatus(r, 'accepted')">客户接受</button>
              <button v-if="r.status === 'sent' && canWrite" class="link-btn danger" @click="setStatus(r, 'rejected')">客户拒绝</button>
              <button v-if="r.status === 'accepted' && canWrite" class="link-btn" @click="convert(r)">转订单</button>
              <button v-if="r.order_id" class="link-btn" @click="$router.push('/orders')">看订单</button>
              <button v-if="r.status === 'draft' && canWrite" class="link-btn danger" @click="remove(r)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td colspan="8" class="empty-cell">暂无报价单</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新建 / 编辑 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑报价单 ' + form.quote_no : '新建报价单' }}</h3>
          <button class="x" @click="showForm = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem">
              <label>客户</label>
              <select class="select" v-model="form.customer_id">
                <option :value="null">— 请选择 —</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="fitem"><label>有效期至</label><input class="input" type="date" v-model="form.valid_until" /></div>
            <div class="fitem"><label>贸易条款</label><input class="input" v-model="form.trade_terms" placeholder="FOB / CIF / EXW" /></div>
            <div class="fitem"><label>交货天数</label><input class="input" type="number" v-model.number="form.delivery_days" /></div>
            <div class="fitem full"><label>备注</label><textarea v-model="form.remark" rows="2"></textarea></div>
          </div>

          <h4 style="margin: 16px 0 8px; font-size: 14px">
            明细 <span class="muted" style="font-weight: 400; font-size: 12px">数量变化后点「取阶梯价」按当前档位重算</span>
          </h4>
          <table class="data">
            <thead>
              <tr>
                <th style="min-width: 200px">产品</th>
                <th style="width: 100px">数量</th>
                <th style="width: 120px">单价 USD</th>
                <th style="width: 110px">金额 USD</th>
                <th style="width: 112px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in form.items" :key="i">
                <td>
                  <select class="select" v-model="it.product_id" @change="onPickProduct(it)">
                    <option :value="null">— 手填 —</option>
                    <option v-for="p in products" :key="p.id" :value="p.id">{{ p.sku ? p.sku + ' · ' : '' }}{{ p.name }}</option>
                  </select>
                  <input v-if="!it.product_id" class="input" style="margin-top: 6px" v-model="it.product_name" placeholder="产品名称" />
                </td>
                <td><input class="input" type="number" min="0" v-model.number="it.qty" /></td>
                <td><input class="input" type="number" step="0.01" v-model.number="it.price_usd" /></td>
                <td class="num">${{ money((Number(it.qty) || 0) * (Number(it.price_usd) || 0)) }}</td>
                <td style="white-space: nowrap">
                  <button class="link-btn" @click="takeTier(it)">阶梯价</button>
                  <button class="link-btn danger" @click="form.items.splice(i, 1)">删除</button>
                </td>
              </tr>
              <tr v-if="!form.items.length">
                <td colspan="5" class="empty-cell">添加一行开始报价</td>
              </tr>
            </tbody>
          </table>
          <div class="toolbar" style="margin-top: 10px">
            <button class="btn btn-ghost btn-sm" @click="addItem">＋ 添加行</button>
            <button class="btn btn-ghost btn-sm" @click="repriceAll">全部按阶梯价重算</button>
            <span style="margin-left: auto; font-size: 13px">
              合计 <strong>${{ money(totalUsd) }}</strong>　≈ <strong>¥{{ money(totalUsd * rate) }}</strong>
              <span class="muted" style="font-size: 12px">（汇率 {{ rate }}）</span>
            </span>
          </div>
          <p v-if="formMsg" class="form-msg err">{{ formMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showForm = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 明细 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal xwide">
        <div class="modal-head">
          <h3>报价单 {{ detail.quote_no }}</h3>
          <button class="x" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <table class="data" style="margin-bottom: 14px">
            <tbody>
              <tr><th style="width: 110px">客户</th><td>{{ detail.customer_name || '-' }}</td>
                <th style="width: 110px">状态</th><td>{{ labels[detail.status] || detail.status }}</td></tr>
              <tr><th>有效期至</th><td>{{ detail.valid_until || '-' }}</td>
                <th>贸易条款</th><td>{{ detail.trade_terms || '-' }}</td></tr>
              <tr><th>交货天数</th><td>{{ detail.delivery_days || 0 }} 天</td>
                <th>汇率</th><td>{{ detail.rate }}</td></tr>
              <tr><th>备注</th><td colspan="3">{{ detail.remark || '-' }}</td></tr>
            </tbody>
          </table>
          <table class="data">
            <thead>
              <tr><th>序号</th><th>款号</th><th>产品</th><th class="num">数量</th><th class="num">单价 USD</th><th class="num">金额 USD</th><th class="num">金额 CNY</th><th>计价</th></tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in detail.items" :key="it.id">
                <td>{{ i + 1 }}</td>
                <td>{{ it.sku || '-' }}</td>
                <td>{{ it.product_name }}</td>
                <td class="num">{{ it.qty }}</td>
                <td class="num">${{ money(it.price_usd) }}</td>
                <td class="num">${{ money(it.amount_usd) }}</td>
                <td class="num">¥{{ money(it.amount_cny) }}</td>
                <td><span class="tag" :class="it.tier_id ? 'green' : 'gray'">{{ it.tier_id ? '阶梯价' : '手工价' }}</span></td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th colspan="3">合计</th>
                <th class="num">{{ detail.total_qty }}</th>
                <th></th>
                <th class="num">${{ money(detail.total_usd) }}</th>
                <th class="num">¥{{ money(detail.total_amount) }}</th>
                <th></th>
              </tr>
            </tfoot>
          </table>
          <div class="toolbar" style="margin-top: 12px">
            <button class="btn btn-ghost btn-sm" @click="printQuote(detail)">打印 / 存 PDF</button>
            <button v-if="detail.status === 'draft' && canWrite" class="btn btn-ghost btn-sm" @click="reprice(detail)">按阶梯价重算</button>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter();
const canWrite = computed(() => can('quote.write'));

const list = ref([]);
const customers = ref([]);
const products = ref([]);
const q = ref('');
const status = ref('');
const labels = ref({ draft: '草稿', sent: '已发出', accepted: '已接受', rejected: '已拒绝', converted: '已转订单' });
const rate = ref(6.5);

const showForm = ref(false);
const saving = ref(false);
const formMsg = ref('');
const detail = ref(null);

const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusClass = (s) => (s === 'accepted' || s === 'converted' ? 'green' : s === 'rejected' ? 'red' : s === 'sent' ? 'blue' : 'gray');

const blankForm = () => ({
  id: null, quote_no: '', customer_id: null, valid_until: '', trade_terms: '', delivery_days: 30, remark: '', items: []
});
const form = ref(blankForm());

const totalUsd = computed(() =>
  form.value.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price_usd) || 0), 0)
);

async function load() {
  try {
    list.value = await api.quotations({ q: q.value, status: status.value });
  } catch (e) {
    alert(e.message);
  }
}

async function loadMeta() {
  try {
    const m = await api.quotationMeta();
    labels.value = m.labels;
    rate.value = m.rate;
  } catch (e) { /* 默认值兜底 */ }
}

async function loadBase() {
  try {
    const [cs, ps] = await Promise.all([api.customers({ status: 'active' }), api.products({ status: 'active' })]);
    customers.value = cs;
    products.value = ps;
  } catch (e) { /* ignore */ }
}

function addItem() {
  form.value.items.push({ product_id: null, product_name: '', qty: 0, price_usd: 0 });
}

function onPickProduct(it) {
  const p = products.value.find((x) => x.id === it.product_id);
  if (!p) return;
  it.product_name = p.name;
  it.sku = p.sku;
  it.price_usd = Number(p.price) || 0;
  if (Number(it.qty) > 0) takeTier(it);
}

async function takeTier(it) {
  if (!it.product_id) return;
  try {
    const r = await api.priceTierLookup(it.product_id, Number(it.qty) || 0);
    it.price_usd = Number(r.price_usd) || 0;
  } catch (e) {
    alert(e.message);
  }
}

async function repriceAll() {
  for (const it of form.value.items) {
    if (it.product_id) await takeTier(it);
  }
}

function openCreate() {
  form.value = blankForm();
  formMsg.value = '';
  addItem();
  showForm.value = true;
}

async function openEdit(row) {
  formMsg.value = '';
  try {
    const d = await api.quotation(row.id);
    form.value = {
      id: d.id, quote_no: d.quote_no, customer_id: d.customer_id,
      valid_until: d.valid_until || '', trade_terms: d.trade_terms || '',
      delivery_days: d.delivery_days || 0, remark: d.remark || '',
      items: d.items.map((it) => ({
        product_id: it.product_id, product_name: it.product_name, sku: it.sku,
        qty: it.qty, price_usd: it.price_usd
      }))
    };
    showForm.value = true;
  } catch (e) {
    alert(e.message);
  }
}

async function save() {
  formMsg.value = '';
  const items = form.value.items.filter((it) => Number(it.qty) > 0);
  if (!items.length) {
    formMsg.value = '至少填写一行有效明细（数量 > 0）';
    return;
  }
  saving.value = true;
  try {
    const payload = {
      customer_id: form.value.customer_id,
      valid_until: form.value.valid_until || null,
      trade_terms: form.value.trade_terms || null,
      delivery_days: Number(form.value.delivery_days) || 0,
      remark: form.value.remark || null,
      items
    };
    if (form.value.id) await api.updateQuotation(form.value.id, payload);
    else await api.createQuotation(payload);
    showForm.value = false;
    await load();
  } catch (e) {
    formMsg.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function openDetail(row) {
  try {
    detail.value = await api.quotation(row.id);
  } catch (e) {
    alert(e.message);
  }
}

async function setStatus(row, to) {
  const txt = labels.value[to] || to;
  if (!confirm(`确认把 ${row.quote_no} 标记为「${txt}」？`)) return;
  try {
    await api.setQuotationStatus(row.id, to);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function convert(row) {
  if (!confirm(`把 ${row.quote_no} 转成销售订单？会生成一张草稿订单（颜色/尺码为待定占位，可在订单里细化）。`)) return;
  try {
    const r = await api.convertQuotation(row.id);
    await load();
    if (confirm(`已生成订单 ${r.order_no}，现在去订单页？`)) router.push('/orders');
  } catch (e) {
    alert(e.message);
  }
}

async function reprice(row) {
  try {
    detail.value = await api.repriceQuotation(row.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function remove(row) {
  if (!confirm(`确定删除 ${row.quote_no}？`)) return;
  try {
    await api.deleteQuotation(row.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

function printQuote(d) {
  const w = window.open(`/print/quote/${d.id}`, '_blank');
  if (!w) alert('浏览器拦截了新窗口，请允许弹窗后重试');
}

onMounted(() => {
  load();
  loadMeta();
  loadBase();
});
</script>
