<template>
  <div>
    <div class="page-head">
      <div>
        <h2>工厂 / 外协</h2>
        <div class="sub">本厂与外协厂主数据，供订单分单选择</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增工厂</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <select class="select" v-model="type" @change="load">
        <option value="">全部类型</option>
        <option value="own">本厂</option>
        <option value="outsource">外协</option>
      </select>
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th style="width: 52px">图片</th><th>编码</th><th>名称</th><th>类型</th><th>联系人</th><th>电话</th><th>地址</th><th>状态</th><th v-if="canWrite">操作</th></tr></thead>
        <tbody>
          <tr v-for="f in list" :key="f.id">
            <td><div class="mini-thumb" :class="{ clickable: f.image_url }" @click="f.image_url && openImage(f.image_url, f.name || '')"><img v-if="f.image_url" :src="f.image_url" /><span v-else>-</span></div></td>
            <td>{{ f.code || '-' }}</td>
            <td><strong>{{ f.name }}</strong></td>
            <td><span class="tag" :class="f.type === 'own' ? 'blue' : 'purple'">{{ f.type === 'own' ? '本厂' : '外协' }}</span></td>
            <td>{{ f.contact || '-' }}</td>
            <td>{{ f.phone || '-' }}</td>
            <td>{{ f.address || '-' }}</td>
            <td><span class="tag" :class="f.status === 'active' ? 'green' : 'gray'">{{ f.status === 'active' ? '启用' : '停用' }}</span></td>
            <td v-if="canWrite">
              <button class="link-btn" @click="openEdit(f)">编辑</button>
              <button v-if="f.status === 'active'" class="link-btn danger" @click="disable(f)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无工厂</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-head"><h3>{{ form.id ? '编辑工厂' : '新增工厂' }}</h3><button class="x" @click="showModal = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem full">
              <label>工厂图片 <span class="paste-tip">支持 Ctrl+V 直接粘贴图片</span></label>
              <ImageUpload v-model="form.image_url" size="lg" />
            </div>

            <div class="fitem"><label>名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>编码</label><input class="input" v-model="form.code" /></div>
            <div class="fitem"><label>类型</label><select class="select" v-model="form.type"><option value="own">本厂</option><option value="outsource">外协</option></select></div>
            <div class="fitem"><label>联系人</label><input class="input" v-model="form.contact" /></div>
            <div class="fitem"><label>电话</label><input class="input" v-model="form.phone" /></div>
            <div class="fitem"><label>地址</label><input class="input" v-model="form.address" /></div>
            <div class="fitem"><label>状态</label><select class="select" v-model="form.status"><option value="active">启用</option><option value="disabled">停用</option></select></div>
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
import ImageUpload from '../components/ImageUpload.vue';

const list = ref([]);
const type = ref('');
const status = ref('');
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());
const canWrite = computed(() => can('factory.write'));

function blank() { return { id: null, name: '', code: '', type: 'outsource', contact: '', phone: '', address: '', status: 'active', image_url: '' }; }

async function load() {
  try { list.value = await api.factories({ type: type.value, status: status.value }); }
  catch (e) { alert(e.message); }
}
function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(f) { form.value = { ...f }; showModal.value = true; }

async function save() {
  if (!form.value.name) return alert('请填写名称');
  saving.value = true;
  try {
    if (form.value.id) await api.updateFactory(form.value.id, form.value);
    else await api.createFactory(form.value);
    showModal.value = false;
    await load();
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}
async function disable(f) {
  if (!confirm(`确定停用「${f.name}」？`)) return;
  try { await api.deleteFactory(f.id); await load(); }
  catch (e) { alert(e.message); }
}

onMounted(load);
</script>
