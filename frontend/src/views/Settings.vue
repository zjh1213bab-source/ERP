<template>
  <div>
    <div class="page-head">
      <div>
        <h2>系统设置</h2>
        <div class="sub">工价倍率、汇率与基础资料配置</div>
      </div>
    </div>

    <WageMultiplierSettings />
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
        <span v-if="!isAdmin" style="color: var(--ink-mute); font-size: 12.5px">仅管理员可修改</span>
      </div>
    </section>

    <!-- 面辅料主数据已独立成「面辅料档案」页 -->
    <section class="panel-card">
      <h3>面辅料档案 <span class="hint">开发单里从这里选择调用</span></h3>
      <p style="font-size: 13px; color: #5b6474; margin: 8px 0 12px">
        面料 / 辅料的名称、编号、简称、供应商、颜色、色号、规格、成份、图片都在「面辅料档案」里统一维护；开发单只引用、不改档案。
      </p>
      <router-link class="btn btn-primary btn-sm" to="/materials">打开面辅料档案</router-link>
    </section>
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
            <td><button  v-if="canWrite" class="link-btn danger" @click="delSizeTemplate(t)">删除</button></td>
          </tr>
          <tr v-if="!sizeTemplates.length"><td colspan="3" class="empty-cell">暂无模板</td></tr>
        </tbody>
      </table>
    </section>
    <!-- 数据备份 -->
    <section v-if="isAdmin" class="panel-card">
      <h3>数据备份 <span class="hint">下载当前数据库快照（.db，可用于迁移/恢复）</span></h3>
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="backing" @click="backup">{{ backing ? '生成中…' : '下载数据库备份' }}</button>
        <label class="btn btn-ghost" style="cursor: pointer">
          {{ restoring ? '上传中…' : '上传备份恢复（.db）' }}
          <input type="file" accept=".db,application/octet-stream" style="display: none" @change="restore" />
        </label>
        <span class="form-msg ok" v-if="backupMsg">{{ backupMsg }}</span>
      </div>
      <p class="form-msg ok" v-if="restoreMsg" style="margin: 8px 0 0">{{ restoreMsg }}</p>
      <p style="font-size: 12px; color: var(--ink-mute); margin: 8px 0 0">
        恢复会上传 .db 并暂存，重启后端服务后生效；建议先「下载数据库备份」留底再操作。
      </p>
    </section>
  </div>
</template>

<script setup>
import WageMultiplierSettings from '../components/WageMultiplierSettings.vue';
import { ref, computed, onMounted } from 'vue';
import { api, downloadFile } from '../api';
import { hasRole } from '../store/auth';
import CsvImport from '../components/CsvImport.vue';

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
const backing = ref(false);
const backupMsg = ref('');
const restoring = ref(false);
const restoreMsg = ref('');

async function restore(ev) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  if (!confirm('上传后将覆盖当前数据库（重启后端后生效），确定继续？')) { ev.target.value = ''; return; }
  restoring.value = true;
  restoreMsg.value = '';
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const b64 = String(reader.result).replace(/^data:.*;base64,/, '');
      const r = await api.restoreDb(b64);
      restoreMsg.value = '✓ ' + r.message;
    } catch (e) { alert(e.message); } finally { restoring.value = false; ev.target.value = ''; }
  };
  reader.readAsDataURL(f);
}

async function backup() {
  backing.value = true;
  backupMsg.value = '';
  try {
    const blob = await downloadFile('/api/admin/backup');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'erp-backup.db';
    a.click();
    URL.revokeObjectURL(url);
    backupMsg.value = '✓ 备份已下载';
  } catch (e) { alert(e.message); } finally { backing.value = false; }
}

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
