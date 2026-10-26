<template>
  <div>
    <div class="page-head">
      <div>
        <h2>系统设置</h2>
        <div class="sub">汇率与面辅料主数据（供开发单选择）</div>
      </div>
    </div>

    <!-- 汇率 -->
    <section class="panel-card">
      <h3>汇率设置 <span class="hint">美元 → 人民币，下单时按此汇率折算</span></h3>
      <div class="toolbar">
        <div class="fitem" style="margin: 0">
          <label>1 美元 = 人民币</label>
          <input class="input" type="number" step="0.01" v-model.number="exchangeRate" style="width: 160px" :disabled="!isAdmin" />
        </div>
        <button v-if="isAdmin" class="btn btn-primary" :disabled="savingRate" @click="saveRate">
          {{ savingRate ? '保存中…' : '保存汇率' }}
        </button>
        <span class="form-msg ok" v-if="rateMsg">{{ rateMsg }}</span>
        <span v-if="!isAdmin" style="color: #8a94a6; font-size: 12.5px">仅管理员可修改</span>
      </div>
    </section>

    <!-- 面料库 -->
    <section class="panel-card">
      <h3>面料库 <span class="hint">开发单里从这里勾选</span></h3>
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" v-model="fForm.name" placeholder="面料名称 *" style="width: 200px" />
        <input class="input" v-model="fForm.spec" placeholder="规格/克重/幅宽" style="width: 180px" />
        <input class="input" v-model="fForm.supplier" placeholder="供应商" style="width: 160px" />
        <button class="btn btn-primary btn-sm" :disabled="!canWrite" @click="addMaterial('fabric')">＋ 添加面料</button>
      </div>
      <table class="data">
        <thead><tr><th>编码</th><th>名称</th><th>规格</th><th>供应商</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="m in fabrics" :key="m.id">
            <td>{{ m.code || '-' }}</td><td><strong>{{ m.name }}</strong></td><td>{{ m.spec || '-' }}</td>
            <td>{{ m.supplier || '-' }}</td>
            <td><span class="tag" :class="m.status === 'active' ? 'green' : 'gray'">{{ m.status === 'active' ? '启用' : '停用' }}</span></td>
            <td><button v-if="m.status === 'active' && canWrite" class="link-btn danger" @click="delMaterial(m)">停用</button></td>
          </tr>
          <tr v-if="!fabrics.length"><td colspan="6" class="empty-cell">暂无面料</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 辅料库 -->
    <section class="panel-card">
      <h3>辅料库 <span class="hint">开发单里从这里勾选</span></h3>
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" v-model="aForm.name" placeholder="辅料名称 *" style="width: 200px" />
        <input class="input" v-model="aForm.spec" placeholder="规格" style="width: 180px" />
        <input class="input" v-model="aForm.supplier" placeholder="供应商" style="width: 160px" />
        <button class="btn btn-primary btn-sm" :disabled="!canWrite" @click="addMaterial('accessory')">＋ 添加辅料</button>
      </div>
      <table class="data">
        <thead><tr><th>编码</th><th>名称</th><th>规格</th><th>供应商</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="m in accessories" :key="m.id">
            <td>{{ m.code || '-' }}</td><td><strong>{{ m.name }}</strong></td><td>{{ m.spec || '-' }}</td>
            <td>{{ m.supplier || '-' }}</td>
            <td><span class="tag" :class="m.status === 'active' ? 'green' : 'gray'">{{ m.status === 'active' ? '启用' : '停用' }}</span></td>
            <td><button v-if="m.status === 'active' && canWrite" class="link-btn danger" @click="delMaterial(m)">停用</button></td>
          </tr>
          <tr v-if="!accessories.length"><td colspan="6" class="empty-cell">暂无辅料</td></tr>
        </tbody>
      </table>
    </section>
    <!-- 尺码模板 -->
    <section class="panel-card">
      <h3>尺码模板 <span class="hint">下单时一键套用</span></h3>
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" v-model="stForm.name" placeholder="模板名称 *" style="width: 200px" />
        <input class="input" v-model="stForm.sizes" placeholder="尺码，逗号分隔，如 S,M,L,XL" style="width: 320px" />
        <button class="btn btn-primary btn-sm" :disabled="!canWrite" @click="addSizeTemplate">＋ 添加模板</button>
      </div>
      <table class="data">
        <thead><tr><th>名称</th><th>尺码</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in sizeTemplates" :key="t.id">
            <td><strong>{{ t.name }}</strong></td>
            <td>{{ t.sizes }}</td>
            <td><button v-if="canWrite" class="link-btn danger" @click="delSizeTemplate(t)">删除</button></td>
          </tr>
          <tr v-if="!sizeTemplates.length"><td colspan="3" class="empty-cell">暂无模板</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { hasRole } from '../store/auth';

const isAdmin = computed(() => hasRole('admin'));
const canWrite = computed(() => hasRole('tech', 'sales'));

const exchangeRate = ref(6.5);
const savingRate = ref(false);
const rateMsg = ref('');

const fabrics = ref([]);
const accessories = ref([]);
const fForm = ref({ name: '', spec: '', supplier: '' });
const aForm = ref({ name: '', spec: '', supplier: '' });
const sizeTemplates = ref([]);
const stForm = ref({ name: '', sizes: '' });

async function loadAll() {
  const [s, ms, st] = await Promise.all([api.settings(), api.materials({}), api.sizeTemplates()]);
  exchangeRate.value = s.exchangeRate;
  fabrics.value = ms.filter((m) => m.type === 'fabric');
  accessories.value = ms.filter((m) => m.type === 'accessory');
  sizeTemplates.value = st;
}

async function saveRate() {
  savingRate.value = true;
  rateMsg.value = '';
  try {
    const s = await api.saveSettings({ exchangeRate: exchangeRate.value });
    exchangeRate.value = s.exchangeRate;
    rateMsg.value = '✓ 已保存，新订单按新汇率折算（历史订单汇率不变）';
  } catch (e) {
    alert(e.message);
  } finally {
    savingRate.value = false;
  }
}

async function addMaterial(type) {
  const form = type === 'fabric' ? fForm : aForm;
  if (!form.value.name) return alert('请填写名称');
  try {
    await api.createMaterial({ type, name: form.value.name, spec: form.value.spec, supplier: form.value.supplier });
    form.value = { name: '', spec: '', supplier: '' };
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function delMaterial(m) {
  if (!confirm(`确定停用「${m.name}」？`)) return;
  try {
    await api.deleteMaterial(m.id);
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function addSizeTemplate() {
  if (!stForm.value.name || !stForm.value.sizes) return alert('请填写模板名称和尺码');
  try {
    await api.createSizeTemplate({ name: stForm.value.name, sizes: stForm.value.sizes });
    stForm.value = { name: '', sizes: '' };
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}
async function delSizeTemplate(t) {
  if (!confirm(`确定删除模板「${t.name}」？`)) return;
  try {
    await api.deleteSizeTemplate(t.id);
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(loadAll);
</script>
