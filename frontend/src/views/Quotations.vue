<template>
  <div class="quote-page">
    <div class="page-head quote-heading">
      <div>
        <h2>报价单</h2>
        <div class="sub">管理客户报价，跟进意向与订单转化</div>
      </div>
      <div class="quote-heading-actions">
        <details class="quote-help"><summary><UiIcon name="assist" />流程说明</summary><div class="quote-help-content"><strong>报价处理流程</strong><p>{{approvalNote}}</p></div></details>
        <button v-action="['quotations','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新建报价单</button>
      </div>
    </div>

    <section class="quote-records" aria-label="报价记录">
      <div class="quote-records-head">
        <div class="quote-records-title"><span class="quote-section-icon"><UiIcon name="sales" /></span><div><h3>报价记录</h3><p>查看报价进度与客户反馈</p></div></div>
        <form class="quote-filters" @submit.prevent="load">
      <div class="quote-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input class="input" v-model="q" placeholder="搜索报价单号 / 客户" aria-label="搜索报价单号或客户" /></div>
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option>
      </select>
      <button class="btn btn-ghost" type="submit">查询</button>
        </form>
      </div>
      <div class="quote-table-scroll">
      <table class="data">
        <thead>
          <tr>
            <th>报价单号</th><th>客户</th><th class="num">数量</th>
            <th class="num">金额 USD</th><th class="num">折人民币</th>
            <th>有效期至</th><th>状态</th><th style="width: 240px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pagination.rows" :key="r.id">
            <td class="quote-number"><strong>{{ r.quote_no }}</strong></td>
            <td><span :class="{'quote-cell-muted':!r.customer_name}">{{ r.customer_name || '未关联客户' }}</span></td>
            <td class="num">{{ r.total_qty }}</td>
            <td class="num quote-amount">${{ money(r.total_usd) }}</td>
            <td class="num quote-cell-muted">¥{{ money(r.total_amount) }}</td>
            <td><span :class="{'quote-cell-muted':!r.valid_until}">{{ r.valid_until || '未设置' }}</span></td>
            <td><span class="tag" :class="statusClass(r.status)">{{ labels[r.status] || r.status }}</span></td>
            <td class="quote-row-actions">
              <button class="link-btn" @click="openDetail(r)">明细</button>
              <button v-action="['quotations','edit']" v-if="r.status === 'draft' && canWrite" class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-if="r.status === 'draft' && canWrite" class="link-btn" @click="setStatus(r, 'sent')">发出</button>
              <button v-if="r.status === 'sent' && canWrite" class="link-btn" @click="setStatus(r, 'accepted')">客户接受</button>
              <button v-if="r.status === 'sent' && canWrite" class="link-btn danger" @click="setStatus(r, 'rejected')">客户拒绝</button>
              <button v-if="r.status === 'accepted' && canWrite" class="link-btn" @click="convert(r)">转订单</button>
              <button v-if="r.order_id" class="link-btn" @click="$router.push('/orders')">看订单</button>
              <button v-action="['quotations','delete']" v-if="r.status === 'draft' && canWrite" class="link-btn danger" @click="remove(r)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td colspan="8" class="empty-cell">暂无报价单</td>
          </tr>
        </tbody>
      </table>
      </div>
      <footer class="quote-records-foot" :class="{'single-page':pagination.total<=pagination.pageSize}">
        <span class="quote-result-count" aria-live="polite">共 <strong>{{pagination.total}}</strong> 条报价记录</span>
        <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
      </footer>
    </section>

    <!-- 新建 / 编辑 -->
    <div v-if="showForm" class="modal-mask">
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
                <th style="width: 100px">款式图片</th><th style="min-width: 200px">产品</th>
                <th style="width: 130px">颜色 / 花型</th>
                <th style="width: 100px">数量</th>
                <th style="width: 120px">单价 USD</th>
                <th style="width: 110px">金额 USD</th>
                <th style="width: 112px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in form.items" :key="i">
                <td><ImageUpload v-model="it.image_url" size="sm" title="报价款式图片" /><small class="muted">上传 / Ctrl+V</small></td>
                <td>
                  <select class="select" v-model="it.product_id" @change="onPickProduct(it)">
                    <option :value="null">— 手填 —</option>
                    <option v-for="p in products" :key="p.id" :value="p.id">{{ p.sku ? p.sku + ' · ' : '' }}{{ p.name }}</option>
                  </select>
                  <input v-if="!it.product_id" class="input" style="margin-top: 6px" v-model="it.product_name" placeholder="产品名称" />
                </td>
                <td>
                  <!-- 有产品就选该产品配好的颜色；否则手填（避免「印花1/印花001」两种写法） -->
                  <select v-if="colorOptions(it).length" class="select" v-model="it.color">
                    <option value="">— 选择 —</option>
                    <option v-for="o in colorOptions(it)" :key="o" :value="o">{{ o }}</option>
                    <option v-if="it.color && !colorOptions(it).includes(it.color)" :value="it.color">{{ it.color }}（原有）</option>
                  </select>
                  <input v-else class="input" v-model="it.color" placeholder="可选" maxlength="40" />
                </td>
                <td><input class="input" type="number" min="0" v-model.number="it.qty" /></td>
                <td><input class="input" type="number" step="0.01" v-model.number="it.price_usd" /></td>
                <td class="num">${{ money((Number(it.qty) || 0) * (Number(it.price_usd) || 0)) }}</td>
                <td style="white-space: nowrap">
                  <button class="link-btn" @click="takeTier(it)">阶梯价</button>
                  <button  class="link-btn danger" @click="form.items.splice(i, 1)">删除</button>
                </td>
              </tr>
              <tr v-if="!form.items.length">
                <td colspan="7" class="empty-cell">添加一行开始报价</td>
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
    <div v-if="detail" class="modal-mask">
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
              <tr><th>序号</th><th>款式图片</th><th>款号</th><th>产品</th><th class="num">数量</th><th class="num">单价 USD</th><th class="num">金额 USD</th><th class="num">金额 CNY</th><th>计价</th></tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in detail.items" :key="it.id">
                <td>{{ i + 1 }}</td><td><img v-if="it.image_url" :src="it.image_url" :alt="it.product_name" class="quote-photo" /><span v-else class="muted">—</span></td>
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
                <th colspan="4">合计</th>
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
import ListPagination from '../components/ListPagination.vue';
import ImageUpload from '../components/ImageUpload.vue';
import UiIcon from '../components/UiIcon.vue';
import { useListPagination } from '../composables/useListPagination';
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
const approvalNote=ref('当前无内部审批：业务员或管理员在报价单页发出，登记客户接受/拒绝后方可转订单；审批中心不处理报价单。');

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
    approvalNote.value=m.approval?.description || approvalNote.value;
  } catch (e) { /* 默认值兜底 */ }
}

async function loadBase() {
  try {
    const [cs, ps] = await Promise.all([api.customers({ status: 'active' }), api.products({ status: 'active' })]);
    customers.value = cs;
    products.value = ps;
  } catch (e) { /* ignore */ }
}

/** 该行产品配好的颜色名（产品列表已带 colors）；没配就返回空 → 退回手填 */
function colorOptions(it) {
  const p = it.product_id ? products.value.find((x) => x.id === it.product_id) : null;
  return p && p.colors ? p.colors.map((c) => c.name) : [];
}

function addItem() {
  form.value.items.push({ product_id: null, product_name: '',image_url:'', color: '', qty: 0, price_usd: 0 });
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
        product_id: it.product_id, product_name: it.product_name, sku: it.sku, color: it.color || '',
        qty: it.qty, price_usd: it.price_usd,image_url:it.image_url || ''
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
  if (!confirm(`把 ${row.quote_no} 转成销售订单？会生成一张草稿订单（颜色按报价行带到订单；尺码为「均码」占位，可在订单里按实际尺码细化）。`)) return;
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

const pagination = useListPagination(() => list.value);
</script>

<style scoped>
.quote-page {max-width:1440px;margin:0 auto;}
.quote-heading {align-items:center;margin-bottom:26px;}
.quote-heading-actions {display:flex;align-items:center;gap:12px;flex:none;}
.quote-help {position:relative;}
.quote-help summary {list-style:none;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-mute);padding:8px 10px;border-radius:7px;cursor:pointer;}
.quote-help summary::-webkit-details-marker {display:none;}
.quote-help summary:hover,.quote-help[open] summary {background:var(--surface);color:var(--brand);}
.quote-help summary svg {width:15px;height:15px;}
.quote-help-content {position:absolute;right:0;top:calc(100% + 10px);width:330px;max-width:80vw;z-index:25;padding:17px 19px;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-md);}
.quote-help-content strong {font-size:13px;font-weight:600;color:var(--ink);}
.quote-help-content p {font-size:12px;line-height:1.8;color:var(--ink-soft);margin:8px 0 0;}
.quote-records {border:1px solid var(--line);border-radius:13px;background:var(--surface);box-shadow:var(--shadow-sm);overflow:visible;}
.quote-records-head {display:flex;justify-content:space-between;align-items:center;gap:20px;padding:21px 23px;}
.quote-records-title {display:flex;align-items:center;gap:11px;flex:none;}
.quote-section-icon {display:grid;place-items:center;width:36px;height:38px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);color:var(--brand);}
.quote-records-title h3 {font-size:14px;font-weight:600;margin:0;color:var(--ink);}
.quote-records-title p {font-size:11px;color:var(--ink-mute);margin:3px 0 0;}
.quote-filters {display:flex;align-items:center;gap:9px;}
.quote-search {position:relative;width:260px;}
.quote-search>svg {position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--ink-mute);}
.quote-search .input {width:100%;padding-left:36px;}
.quote-filters>.select {min-width:110px;}
.quote-table-scroll {overflow-x:auto;}
.quote-table-scroll table.data {min-width:930px;}
.quote-table-scroll table.data th {padding:13px 20px;font-size:11px;color:var(--ink-mute);font-weight:550;border-top:1px solid var(--line);background:var(--surface-2);}
.quote-table-scroll table.data td {padding:22px 20px;font-variant-numeric:tabular-nums;}
.quote-number {min-width:210px;}
.quote-number strong {font-weight:600;letter-spacing:.1px;}
.quote-table-scroll table.data .quote-cell-muted {color:var(--ink-mute);}
.quote-table-scroll table.data .quote-amount {font-weight:600;}
.quote-row-actions {white-space:nowrap;}
.quote-row-actions .link-btn {padding:5px 7px;border-radius:5px;margin-right:2px;}
.quote-row-actions .link-btn:hover {background:var(--brand-soft);}
.quote-row-actions .link-btn.danger:hover {background:color-mix(in srgb,var(--danger) 8%,var(--surface));}
.quote-records-foot {display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 22px;border-top:1px solid var(--line);}
.quote-result-count {font-size:12px;color:var(--ink-mute);white-space:nowrap;}
.quote-result-count strong {font-weight:600;color:var(--ink-soft);margin:0 2px;}
.quote-records-foot :deep(.list-pagination) {padding:0;gap:14px;}
.quote-records-foot :deep(.pagination-summary) {display:none;}
.quote-records-foot.single-page :deep(.pagination-buttons) {display:none;}
@media(max-width:1100px) {.quote-records-head{align-items:flex-start;flex-direction:column;gap:16px;}.quote-filters{width:100%;}.quote-search{flex:1;width:auto;}}
@media(max-width:600px) {.quote-heading{align-items:flex-start;}.quote-heading-actions{flex-direction:column-reverse;align-items:flex-end;gap:5px;}.quote-help summary{font-size:11px;}.quote-records-head{padding:18px 16px;}.quote-filters{flex-wrap:wrap;}.quote-search{flex:1 1 100%;}.quote-filters>.select{flex:1;}.quote-records-foot{padding:14px 16px;flex-wrap:wrap;gap:12px;}.quote-records-foot :deep(.list-pagination){width:100%;}.quote-records-foot :deep(.pagination-size){margin-right:auto;}}
.quote-photo {width:64px;height:64px;object-fit:contain;cursor:zoom-in;border-radius:6px;}
</style>
