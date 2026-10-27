<template>
  <div>
    <div class="page-head">
      <div>
        <h2>客户管理</h2>
        <div class="sub">客户档案、联系人、等级与信用额度</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增客户</button>
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
      <table class="data">
        <thead>
          <tr>
            <th style="width: 56px">图片</th>
            <th>编号</th><th>客户名称</th><th>联系人</th><th>电话</th><th>等级</th>
            <th>信用额度</th><th>状态</th><th v-if="canWrite">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in list" :key="c.id">
            <td><div class="mini-thumb" :class="{ clickable: c.image_url }" @click="c.image_url && openImage(c.image_url, c.name || '')"><img v-if="c.image_url" :src="c.image_url" /><span v-else>-</span></div></td>
            <td>{{ c.code || '-' }}</td>
            <td><strong>{{ c.name }}</strong></td>
            <td>{{ c.contact || '-' }}</td>
            <td>{{ c.phone || '-' }}</td>
            <td><span class="tag" :class="c.level === 'A' ? 'green' : 'gray'">{{ c.level || '-' }}</span></td>
            <td>¥{{ Number(c.credit_limit || 0).toLocaleString() }}</td>
            <td>
              <span class="tag" :class="c.status === 'active' ? 'green' : 'gray'">
                {{ c.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td v-if="canWrite">
              <button class="link-btn" @click="openEdit(c)">编辑</button>
              <button v-if="c.status === 'active'" class="link-btn danger" @click="disable(c)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无客户</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗 -->
    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑客户' : '新增客户' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>客户图片 <span class="paste-tip">支持 Ctrl+V 直接粘贴图片</span></label>
              <ImageUpload v-model="form.image_url" size="lg" />
            </div>

            <div class="fitem"><label>客户名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>编号</label><input class="input" v-model="form.code" placeholder="可空" /></div>
            <div class="fitem"><label>联系人</label><input class="input" v-model="form.contact" /></div>
            <div class="fitem"><label>电话</label><input class="input" v-model="form.phone" /></div>
            <div class="fitem"><label>邮箱</label><input class="input" v-model="form.email" /></div>
            <div class="fitem">
              <label>等级</label>
              <select class="select" v-model="form.level">
                <option value="A">A</option><option value="B">B</option><option value="C">C</option>
              </select>
            </div>
            <div class="fitem"><label>信用额度</label><input class="input" type="number" v-model.number="form.credit_limit" /></div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.status">
                <option value="active">启用</option><option value="disabled">停用</option>
              </select>
            </div>
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
import CsvImport from '../components/CsvImport.vue';
import ImageUpload from '../components/ImageUpload.vue';

const list = ref([]);
const q = ref('');
const status = ref('');
const canWrite = computed(() => can('customer.write'));

const showModal = ref(false);
const saving = ref(false);
const blank = () => ({
  id: null, code: '', name: '', contact: '', phone: '', email: '',
  level: 'B', credit_limit: 0, status: 'active', remark: '', image_url: ''
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
  form.value = { ...c };
  showModal.value = true;
}

async function save() {
  if (!form.value.name) return alert('客户名称必填');
  saving.value = true;
  try {
    if (form.value.id) await api.updateCustomer(form.value.id, form.value);
    else await api.createCustomer(form.value);
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

onMounted(load);
</script>
