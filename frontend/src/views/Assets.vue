<template>
  <div>
    <div class="page-head">
      <div>
        <h2>固定资产</h2>
        <div class="sub">办公设备 / 车辆 / 机器 · 直线法折旧，车辆年检到期提醒</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增资产</button>
    </div>

    <div class="cards">
      <div class="stat-card"><div class="label">资产数（在用+闲置）</div><div class="value">{{ (s.in_use || 0) + (s.idle || 0) }}<small>项</small></div></div>
      <div class="stat-card"><div class="label">原值合计</div><div class="value">¥{{ money(s.original_total) }}</div></div>
      <div class="stat-card"><div class="label">净值合计</div><div class="value">¥{{ money(s.net_total) }}</div></div>
      <div class="stat-card"><div class="label">月折旧</div><div class="value">¥{{ money(s.monthly_depreciation) }}</div></div>
    </div>

    <div v-if="s.dueSoon && s.dueSoon.length" class="alert-bar">
      ⏰ 30 天内年检/保养到期：{{ s.dueSoon.map((x) => (x.plate_no ? x.plate_no + ' ' : '') + x.name + '（' + x.next_check_date + '）').join('；') }}
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <input class="input" v-model="q" placeholder="搜索名称 / 编号 / 保管人 / 车牌" @keyup.enter="load" style="width: 240px" />
      <select class="select" v-model="category" @change="load">
        <option value="">全部类别</option>
        <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
      </select>
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="in_use">在用</option>
        <option value="idle">闲置</option>
        <option value="scrapped">已报废</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>编号</th><th>名称</th><th>类别</th><th>使用部门</th><th>保管人</th>
            <th>购置日期</th><th class="num">原值</th><th class="num">已用月</th>
            <th class="num">月折旧</th><th class="num">累计折旧</th><th class="num">净值</th>
            <th>年检到期</th><th>状态</th><th v-if="canWrite" style="width: 170px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in list" :key="a.id">
            <td class="nowrap">{{ a.code || '-' }}</td>
            <td class="nowrap"><strong>{{ a.name }}</strong><span v-if="a.plate_no" class="muted"> · {{ a.plate_no }}</span></td>
            <td class="nowrap">{{ a.category || '-' }}</td>
            <td class="nowrap">{{ a.dept || '-' }}</td>
            <td class="nowrap">{{ a.keeper || '-' }}</td>
            <td class="nowrap">{{ a.purchase_date || '-' }}</td>
            <td class="num">{{ money(a.original_value) }}</td>
            <td class="num">{{ a.months_used }}</td>
            <td class="num">{{ money(a.monthly_depreciation) }}</td>
            <td class="num">{{ money(a.accumulated_depreciation) }}</td>
            <td class="num"><strong>{{ money(a.net_value) }}</strong></td>
            <td class="nowrap">
              <span v-if="a.next_check_date" :class="isDueSoon(a.next_check_date) ? 'due-tag' : ''">{{ a.next_check_date }}</span>
              <span v-else class="muted">-</span>
            </td>
            <td class="nowrap"><span class="tag" :class="a.status === 'in_use' ? 'green' : a.status === 'idle' ? 'orange' : 'gray'">{{ a.status_label }}</span></td>
            <td v-if="canWrite" style="white-space: nowrap">
              <button class="link-btn" @click="openEdit(a)">编辑</button>
              <button v-if="a.status !== 'scrapped'" class="link-btn" @click="setStatus(a, 'scrapped')">报废</button>
              <button v-if="a.status === 'idle'" class="link-btn" @click="setStatus(a, 'in_use')">启用</button>
              <button class="link-btn danger" @click="remove(a)">删除</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 14 : 13" class="empty-cell">暂无资产</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑资产' : '新增资产' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>资产名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>资产编号</label><input class="input" v-model="form.code" placeholder="可空" /></div>
            <div class="fitem">
              <label>类别</label>
              <select class="select" v-model="form.category">
                <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div class="fitem"><label>使用部门</label><input class="input" v-model="form.dept" /></div>
            <div class="fitem"><label>保管人</label><input class="input" v-model="form.keeper" /></div>
            <div class="fitem"><label>购置日期</label><input class="input" type="date" v-model="form.purchase_date" /></div>
            <div class="fitem"><label>原值（元）</label><input class="input" type="number" step="0.01" v-model.number="form.original_value" /></div>
            <div class="fitem"><label>折旧年限（年）</label><input class="input" type="number" step="0.5" v-model.number="form.useful_years" /></div>
            <div class="fitem"><label>残值率</label><input class="input" type="number" step="0.01" v-model.number="form.salvage_rate" /></div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.status">
                <option value="in_use">在用</option><option value="idle">闲置</option><option value="scrapped">已报废</option>
              </select>
            </div>
            <div v-if="form.category === '车辆'" class="fitem"><label>车牌号</label><input class="input" v-model="form.plate_no" /></div>
            <div v-if="form.category === '车辆'" class="fitem"><label>下次年检/保养</label><input class="input" type="date" v-model="form.next_check_date" /></div>
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
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const CATEGORIES = ['电子设备', '办公家具', '车辆', '机器设备', '其他'];
const canWrite = computed(() => can('asset.write'));

const list = ref([]);
const s = ref({});
const q = ref('');
const category = ref('');
const status = ref('');
const showModal = ref(false);
const saving = ref(false);

const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const blank = () => ({
  id: null, code: '', name: '', category: '电子设备', dept: '', keeper: '',
  purchase_date: new Date().toISOString().slice(0, 10), original_value: 0,
  salvage_rate: 0.05, useful_years: 5, plate_no: '', next_check_date: '',
  status: 'in_use', remark: ''
});
const form = ref(blank());

function isDueSoon(d) {
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return d <= in30;
}

async function load() {
  try {
    const [rows, sum] = await Promise.all([
      api.assets({ q: q.value, category: category.value, status: status.value }),
      api.assetSummary()
    ]);
    list.value = rows;
    s.value = sum;
  } catch (e) {
    alert(e.message);
  }
}

function openCreate() {
  form.value = blank();
  showModal.value = true;
}
function openEdit(a) {
  form.value = { ...blank(), ...a };
  showModal.value = true;
}

async function save() {
  if (!form.value.name) return alert('资产名称必填');
  saving.value = true;
  try {
    const payload = { ...form.value };
    delete payload.months_used;
    delete payload.monthly_depreciation;
    delete payload.accumulated_depreciation;
    delete payload.net_value;
    delete payload.status_label;
    if (payload.id) await api.updateAsset(payload.id, payload);
    else await api.createAsset(payload);
    showModal.value = false;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function setStatus(a, to) {
  const label = { scrapped: '报废', in_use: '启用' }[to] || to;
  if (!confirm(`确定把「${a.name}」${label}？`)) return;
  try {
    await api.setAssetStatus(a.id, to);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function remove(a) {
  if (!confirm(`删除「${a.name}」？此操作不可恢复。`)) return;
  try {
    await api.deleteAsset(a.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(load);
</script>

<style scoped>
.alert-bar { background: #fff7e6; border: 1px solid #ffd591; color: #ad6800; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }
.due-tag { color: #d92d45; font-weight: 700; }
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { min-width: 1300px; }
</style>
