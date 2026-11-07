<template>
  <div>
    <div class="page-head">
      <div>
        <h2>客户管理</h2>
        <div class="sub">客户档案、联系人、等级与信用额度</div>
      </div>
      <button v-action="['customers','create']" v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增客户</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索名称 / 编号 / 联系人" @keyup.enter="load" style="width: 260px" />
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
      <CsvImport v-if="canWrite" kind="customers" @done="load" />
    </div>

    <div class="table-wrap">
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
      <table class="data">
        <thead>
          <tr>
            <th>编号</th><th>客户名称</th><th>联系人</th><th>电话</th><th>等级</th>
            <th>绑定业务员 / 下单周期</th><th>最近下单</th><th>近1年 · 单数 / 人民币</th><th>近2年 · 单数 / 人民币</th><th>信用额度</th><th>状态</th><th v-if="canWrite">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in pagination.rows" :key="c.id">
            <td>{{ c.code || '-' }}</td>
            <td><strong>{{ c.name }}</strong></td>
            <td>{{ c.contact || '-' }}</td>
            <td>{{ c.phone || '-' }}</td>
            <td><span class="tag" :class="c.level === 'L0' ? 'green' : 'gray'">{{ ({ A: 'L1', B: 'L2', C: 'L3' })[c.level] || c.level || '-' }}</span></td>
            <td>{{ c.owner_name || '未绑定' }}<div class="sub">{{ c.order_cycle_days ? c.order_cycle_days+'天 / '+(c.cycle_overdue?'已超期':'周期内') : '预警关闭' }}</div></td>
            <td>{{ c.last_order_date || '尚未下单' }}<div class="sub">间隔 {{ c.days_since_order }} 天</div></td>
            <td>{{ c.orders_1y }} 单 / ¥{{ Number(c.amount_1y).toLocaleString() }}</td>
            <td>{{ c.orders_2y }} 单 / ¥{{ Number(c.amount_2y).toLocaleString() }}</td>
            <td>¥{{ Number(c.credit_limit || 0).toLocaleString() }}</td>
            <td>
              <span class="tag" :class="c.status === 'active' ? 'green' : 'gray'">
                {{ c.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td v-if="canWrite">
              <button v-action="['customers','edit']" class="link-btn" @click="openEdit(c)">编辑</button>
              <button v-action="['customers','disable']" v-if="c.status === 'active'" class="link-btn danger" @click="disable(c)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td :colspan="canWrite ? 12 : 11" class="empty-cell">暂无客户</td>
          </tr>
        </tbody>
      </table>
      <ListPagination v-model:page="pagination.page" v-model:page-size="pagination.pageSize" :total="pagination.total" />
    </div>

    <!-- 弹窗 -->
    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑客户' : '新增客户' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">

            <div class="fitem"><label>客户名称 <b class="required-star">*</b></label><input class="input" v-model="form.name" required /></div>
            <div class="fitem"><label>编号</label><input class="input" v-model="form.code" placeholder="可空" /></div>
            <div class="fitem"><label>客户国家/地区</label><input class="input" v-model="form.country" placeholder="如 United States" /></div>
            <div class="fitem"><label>客户类型</label><select class="select" v-model="form.customer_type"><option value="company">公司</option><option value="individual">个人</option></select></div>
            <div class="fitem"><label>联系人 <b class="required-star">*</b></label><input class="input" v-model="form.contact" required /></div>
            <div class="fitem"><label>联系人职位</label><input class="input" v-model="form.contact_title" /></div>
            <div class="fitem"><label>电话</label><input class="input" v-model="form.phone" /></div>
            <div class="fitem"><label>邮箱 <b class="required-star">*</b></label><input class="input" type="email" v-model="form.email" required /></div>
            <div class="fitem full"><label>注册地址</label><input class="input" v-model="form.registered_address" /></div>
            <div class="fitem full"><label>账单地址</label><input class="input" v-model="form.billing_address" /></div>
            <div class="fitem full"><label>收货地址</label><input class="input" v-model="form.shipping_address" /></div>
            <div class="fitem"><label>税务/VAT 编号</label><input class="input" v-model="form.tax_id" /></div>
            <div class="fitem"><label>结算币种</label><select class="select" v-model="form.currency"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option><option>JPY</option><option>CNY</option></select></div>
            <div class="fitem"><label>付款条款</label><input class="input" v-model="form.payment_terms" placeholder="如 T/T 30% 定金" /></div>
            <div class="fitem"><label>贸易条款</label><input class="input" v-model="form.incoterms" placeholder="如 FOB Shanghai" /></div>
            <div class="fitem">
              <label>等级</label>
              <select class="select" v-model="form.level">
                <option v-for="level in ['L0','L1','L2','L3','L4']" :key="level" :value="level">{{ level }}</option>
              </select>
            </div>
            <div class="fitem"><label>信用额度</label><input class="input" type="number" v-model.number="form.credit_limit" /></div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.status">
                <option :disabled="!$canAction('customers','enable')" value="active">启用</option><option :disabled="!$canAction('customers','disable')" value="disabled">停用</option>
              </select>
            </div>
            <div class="fitem"><label>绑定业务员</label><select class="select" v-model="form.owner_user_id"><option :value="null">未绑定</option><option v-for="u in salespeople" :key="u.id" :value="u.id">{{ u.name || u.username }}</option></select></div>
            <div class="fitem"><label>下单周期（天）</label><input class="input" type="number" min="0" max="3650" v-model.number="form.order_cycle_days" /><small>0 关闭；超期自动发内部邮件，每次下单周期仅提醒一次。</small></div>
            <div class="fitem full sub">统计采用近12／24个月正式订单，排除草稿与作废单；金额为人民币订单快照。未下单客户从启用时计时。</div>
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
import ListPagination from '../components/ListPagination.vue';
import { useListPagination } from '../composables/useListPagination';
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import CsvImport from '../components/CsvImport.vue';

const list = ref([]);
const salespeople=ref([]);
const q = ref('');
const status = ref('');
const canWrite = computed(() => can('customer.write'));

const showModal = ref(false);
const saving = ref(false);
const blank = () => ({
  id: null, owner_user_id:null, order_cycle_days:0, code: '', name: '', contact: '', phone: '', email: '',
  country: '', customer_type: 'company', contact_title: '', registered_address: '', billing_address: '',
  shipping_address: '', tax_id: '', currency: 'USD', payment_terms: '', incoterms: '',
  level: 'L2', credit_limit: 0, status: 'active', remark: ''
});
const form = ref(blank());

async function load() {
  try {
    list.value = await api.customers({ q: q.value, status: status.value });
  } catch (e) {
    alert(e.message);
  }
}

function openCreate() {
  form.value = blank();
  showModal.value = true;
}
function openEdit(c) {
  form.value = { ...blank(), ...c, level: ({ A: 'L1', B: 'L2', C: 'L3' })[c.level] || c.level || 'L2' };
  showModal.value = true;
}

async function save() {
  if (!form.value.name?.trim() || !form.value.contact?.trim() || !form.value.email?.trim()) return alert('客户名称、联系人和邮箱为必填项');
  saving.value = true;
  try {
    const payload={...form.value};delete payload.image_url;
    if (form.value.id) await api.updateCustomer(form.value.id, payload);
    else await api.createCustomer(payload);
    showModal.value = false;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function disable(c) {
  if (!confirm(`确定停用客户「${c.name}」？`)) return;
  try {
    await api.deleteCustomer(c.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async()=>{await load();if(canWrite.value){try{salespeople.value=await api.customerSalespeople();}catch(e){alert(e.message);}}});

const pagination = useListPagination(() => list.value);
</script>

<style scoped>
.required-star { color: #dc2626 !important; font-weight: 700; margin-left: 3px; }
</style>
