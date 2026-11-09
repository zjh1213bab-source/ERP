<template>
  <div>
    <div class="page-head">
      <div>
        <h2>行政费用</h2>
        <div class="sub">房租 / 水电 / 办公 / 差旅 等日常支出登记与汇总</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 登记费用</button>
    </div>

    <div class="cards">
      <div class="stat-card"><div class="label">区间合计</div><div class="value">¥{{ money(sum.total) }}</div></div>
      <div class="stat-card"><div class="label">笔数</div><div class="value">{{ sum.count || 0 }}<small>笔</small></div></div>
      <div class="stat-card"><div class="label">最大类别</div><div class="value" style="font-size: 20px">{{ (sum.byCategory && sum.byCategory[0] && sum.byCategory[0].category) || '-' }}</div></div>
      <div class="stat-card"><div class="label">该类合计</div><div class="value">¥{{ money(sum.byCategory && sum.byCategory[0] && sum.byCategory[0].amount) }}</div></div>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <span class="muted" style="font-size: 12px">区间</span>
      <input class="input" type="date" v-model="from" style="width: 150px" @change="load" />
      <span class="muted" style="font-size: 12px">至</span>
      <input class="input" type="date" v-model="to" style="width: 150px" @change="load" />
      <select class="select" v-model="category" @change="load">
        <option value="">全部类别</option>
        <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
      <input class="input" v-model="q" placeholder="收款方 / 经办人 / 备注" @keyup.enter="load" style="width: 200px" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <button v-action="['admin-expenses','export']" class="btn btn-ghost btn-sm" @click="exportCsv">导出 CSV</button>
      <button class="btn btn-ghost btn-sm" @click="quickRange('month')">本月</button>
      <button class="btn btn-ghost btn-sm" @click="quickRange('lastMonth')">上月</button>
      <button class="btn btn-ghost btn-sm" @click="quickRange('year')">本年</button>
    </div>

    <div class="two-col">
      <div class="panel-card">
        <h3>按类别 <span class="hint">区间内占比</span></h3>
        <div v-for="c in sum.byCategory || []" :key="c.category" class="bar-row">
          <span class="bar-name">{{ c.category }}</span>
          <div class="bar-track"><div class="bar-fill" :style="{ width: pct(c.amount) + '%' }"></div></div>
          <span class="bar-val">¥{{ money(c.amount) }}</span>
        </div>
        <div v-if="!(sum.byCategory || []).length" class="empty-cell">暂无数据</div>
      </div>
      <div class="panel-card">
        <h3>按付款方式</h3>
        <table class="data">
          <thead><tr><th>方式</th><th class="num">金额</th></tr></thead>
          <tbody>
            <tr v-for="m in sum.byMethod || []" :key="m.method">
              <td>{{ m.method }}</td><td class="num">¥{{ money(m.amount) }}</td>
            </tr>
            <tr v-if="!(sum.byMethod || []).length"><td colspan="2" class="empty-cell">暂无数据</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="table-wrap">
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
      <table class="data">
        <thead>
          <tr><th>日期</th><th>类别</th><th class="num">金额</th><th>收款方</th><th>经办人</th><th>付款方式</th><th>备注</th><th v-if="canWrite" style="width: 110px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in pagination.rows" :key="r.id">
            <td>{{ r.expense_date }}</td>
            <td><span class="tag gray">{{ r.category }}</span></td>
            <td class="num"><strong>¥{{ money(r.amount) }}</strong></td>
            <td>{{ r.payee || '-' }}</td>
            <td>{{ r.handler || '-' }}</td>
            <td>{{ r.payment_method || '-' }}</td>
            <td>{{ r.remark || '-' }}</td>
            <td v-if="canWrite" style="white-space: nowrap">
              <button v-action="['admin-expenses','edit']" class="link-btn" @click="openEdit(r)">编辑</button>
              <button v-action="['admin-expenses','delete']" class="link-btn danger" @click="remove(r)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 8 : 7" class="empty-cell">该区间暂无费用记录</td></tr>
        </tbody>
      </table>
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
    </div>

    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑费用' : '登记费用' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>费用日期 *</label><input class="input" type="date" v-model="form.expense_date" /></div>
            <div class="fitem">
              <label>类别</label>
              <select class="select" v-model="form.category">
                <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div class="fitem"><label>金额（元）*</label><input class="input" type="number" step="0.01" v-model.number="form.amount" /></div>
            <div class="fitem">
              <label>付款方式</label>
              <select class="select" v-model="form.payment_method">
                <option value="转账">转账</option><option value="现金">现金</option>
                <option value="微信">微信</option><option value="支付宝">支付宝</option>
              </select>
            </div>
            <div class="fitem"><label>收款方</label><input class="input" v-model="form.payee" /></div>
            <div class="fitem"><label>经办人</label><input class="input" v-model="form.handler" /></div>
            <div class="fitem full"><label>备注</label><textarea v-model="form.remark" rows="2"></textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="showModal = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { localDate } from '../utils/time';
import ListPagination from '../components/ListPagination.vue';
import { useListPagination } from '../composables/useListPagination';
import { ref, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('expense.write'));

const today = new Date();
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const from = ref(ym(today) + '-01');
const to = ref(localDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)));

const categories = ref(['房租', '水电', '办公', '差旅', '招待', '快递', '薪酬福利', '其他']);
const list = ref([]);
const sum = ref({});
const category = ref('');
const q = ref('');
const showModal = ref(false);
const saving = ref(false);

const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => {
  const total = Number(sum.value.total) || 0;
  return total > 0 ? Math.round((Number(v) / total) * 100) : 0;
};

const blank = () => ({
  id: null, expense_date: localDate(), category: '办公',
  amount: 0, payee: '', handler: '', payment_method: '转账', remark: ''
});
const form = ref(blank());

async function load() {
  try {
    const params = { from: from.value, to: to.value, category: category.value, q: q.value };
    const [rows, s] = await Promise.all([api.adminExpenses(params), api.adminExpenseSummary(params)]);
    list.value = rows;
    sum.value = s;
  } catch (e) {
    alert(e.message);
  }
}

function quickRange(kind) {
  const d = new Date();
  if (kind === 'month') {
    from.value = ym(d) + '-01';
    to.value = localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  } else if (kind === 'lastMonth') {
    const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    from.value = ym(p) + '-01';
    to.value = localDate(new Date(p.getFullYear(), p.getMonth() + 1, 0));
  } else {
    from.value = d.getFullYear() + '-01-01';
    to.value = d.getFullYear() + '-12-31';
  }
  load();
}

function openCreate() {
  form.value = blank();
  showModal.value = true;
}
function openEdit(r) {
  form.value = { ...blank(), ...r };
  showModal.value = true;
}

async function save() {
  if (!form.value.expense_date) return alert('请选择费用日期');
  if (!(Number(form.value.amount) > 0)) return alert('金额必须大于 0');
  saving.value = true;
  try {
    const payload = { ...form.value };
    delete payload.created_at;
    if (payload.id) await api.updateAdminExpense(payload.id, payload);
    else await api.createAdminExpense(payload);
    showModal.value = false;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(r) {
  if (!confirm(`删除 ${r.expense_date} 的「${r.category}」¥${money(r.amount)}？`)) return;
  try {
    await api.deleteAdminExpense(r.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function exportCsv() {
  try {
    const qsStr = `?from=${from.value}&to=${to.value}&category=${encodeURIComponent(category.value)}&q=${encodeURIComponent(q.value)}`;
    const b = await downloadFile('/api/admin-expenses/export' + qsStr);
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'admin-expenses.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    alert(e.message);
  }
}

onMounted(load);

const pagination = useListPagination(() => list.value);
</script>

<style scoped>
.two-col { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; }
.bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; font-size: 13px; }
.bar-name { width: 64px; color: #4a566a; flex: none; }
.bar-track { flex: 1; height: 12px; background: #eef2f7; border-radius: 6px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--brand); border-radius: 6px; }
.bar-val { width: 104px; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; flex: none; }
@media (max-width: 900px) {
  .two-col { grid-template-columns: 1fr; }
}
</style>
