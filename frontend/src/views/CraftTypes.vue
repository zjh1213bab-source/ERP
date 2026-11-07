<template>
  <!--
    工序类别（一比一参考 2026-11-07 截图）
    - 视觉：搜索框 + 新增按钮 + 三列表格（工序类别 / 是否启用倍率 / 操作）+ 行内开关。
    - 数据：仍用 craft_types 工序档案表，不新建字典表；编辑弹窗保留
      名称/类别/单位/默认单价/说明，供开发单、订单工艺、计件单价等环节带出。
    - 倍率：开关真实读写「系统设置 → 工价倍率」的 process_scope.craft_type_ids，
      mode 切到 selected 后由 wageMultiplier.participation() 判定，非假开关。
    - 删除：文案照参考图，实际执行现有软停用（status='disabled'），历史报工/工资不丢。
  -->
  <div class="ct-page">
    <div class="ct-filter">
      <label>工序类别</label>
      <input class="ct-input" v-model="q" placeholder="搜索工序类别" />
      <span class="ct-count">共 {{ filtered.length }} 条</span>
    </div>

    <div class="ct-actions">
      <button v-action="['craft-types','create']" v-if="canWrite" class="ct-btn primary" @click="openCreate">新增工序类别</button>
      <span class="ct-mode" :title="modeHint">
        倍率参与：{{ rateConfig?.process_scope?.mode === 'selected' ? '仅本页勾选工序' : '全部工序' }}
      </span>
    </div>

    <p v-if="notice.text" class="ct-notice" :class="notice.type" role="status">{{ notice.text }}</p>

    <div class="ct-panel">
      <button class="ct-panel-btn" type="button" title="重新读取工序与倍率配置" @click="loadAll">↻</button>
      <table class="ct-table">
        <thead>
          <tr>
            <th>工序类别</th>
            <th>是否启用倍率</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.id">
            <td class="ct-name">{{ r.name }}</td>
            <td class="ct-rate">
              <span class="ct-flag" :class="{ on: !isEnabled(r) }">否</span>
              <button
                class="ct-switch" :class="{ on: isEnabled(r) }" type="button"
                :disabled="!canEditRate || rateSavingId === r.id" :title="rateHint(r)"
                :aria-label="`${r.name} 是否启用倍率`" @click="toggleRate(r)"
              ><i></i></button>
              <span class="ct-flag" :class="{ on: isEnabled(r) }">是</span>
            </td>
            <td class="ct-ops">
              <button v-action="['craft-types','edit']" v-if="canWrite" class="ct-link" @click="openEdit(r)">编辑</button>
              <button v-action="['craft-types','disable']" v-if="canWrite" class="ct-link danger" @click="remove(r)">删除</button>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="3" class="ct-empty">{{ q ? '没有匹配的工序类别' : '暂无工序类别，点「新增工序类别」添加' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="ct-foot">
      开关保存的是全局「工价倍率 → 参与倍率的工序范围」，仅影响之后的新报工计价，历史工资不回溯。
      「删除」为停用，历史报工、计件工资与倍率勾选引用均保留。
    </p>

    <!-- 编辑弹窗：字段沿用本地工序档案，保证与其他业务环节接得上 -->
    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑工序类别' : '新增工序类别' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>工序类别名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem">
              <label>类别</label>
              <select class="select" v-model="form.category">
                <option v-for="c in CATS" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
            </div>
            <div class="fitem"><label>单位</label><input class="input" v-model="form.unit" placeholder="件 / 米 / 个" /></div>
            <div class="fitem"><label>默认单价</label><input class="input" type="number" step="0.01" v-model.number="form.default_price" /></div>
            <div class="fitem full"><label>说明</label><input class="input" v-model="form.remark" placeholder="工艺要求 / 注意事项" /></div>
          </div>
          <p class="ct-modal-tip">类别 / 单位 / 默认单价 / 说明会供开发单、订单工艺与计件单价环节带出；是否启用倍率请在列表里的开关设置。</p>
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
import { hasRole } from '../store/auth';

const CATS = [
  { key: 'sewing', label: '车缝' },
  { key: 'print', label: '印花' },
  { key: 'embroidery', label: '绣花' },
  { key: 'wash', label: '洗水' },
  { key: 'finish', label: '后整' },
  { key: 'pack', label: '包装' },
  { key: 'other', label: '其他' }
];

const list = ref([]);
const q = ref('');
const showModal = ref(false);
const saving = ref(false);
const form = ref(blank());
const notice = ref({ text: '', type: 'ok' });
const rateConfig = ref(null);
const rateSavingId = ref(null);

const canWrite = computed(() => can('development.write'));
// PUT /api/settings/piece-multipliers 仅 admin；其余角色只读展示，不给出可点却必失败的开关
const canEditRate = computed(() => hasRole('admin'));
const modeHint = computed(() => canEditRate.value
  ? '切换任意开关后，全局倍率参与模式会变为「仅勾选工序参与」'
  : '仅管理员可修改倍率参与范围');

const filtered = computed(() => {
  const kw = String(q.value || '').trim().toLowerCase();
  return list.value
    .filter((r) => r.status === 'active')                 // 软停用后从列表消失，数据仍在库中
    .filter((r) => !kw || String(r.name || '').toLowerCase().includes(kw))
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));        // 导入顺序即截图顺序
});

const rateIds = computed(() => new Set((rateConfig.value?.process_scope?.craft_type_ids || []).map(Number)));
function isEnabled(r) {
  const c = rateConfig.value;
  if (!c) return false;
  if (c.process_scope?.mode === 'all') return true;      // 未初始化时全部参与
  return rateIds.value.has(Number(r.id));
}
function rateHint(r) {
  if (!canEditRate.value) return '仅管理员可修改倍率参与范围';
  if (!rateConfig.value) return '倍率配置读取失败，点右上角 ↻ 重试';
  return `${r.name}：当前${isEnabled(r) ? '参与' : '不参与'}工价倍率，点击切换`;
}

function blank() {
  return { id: null, name: '', category: 'sewing', unit: '件', default_price: 0, is_out: 0, image_url: '', remark: '' };
}
function say(text, type = 'ok') {
  notice.value = { text, type };
  if (text) setTimeout(() => { if (notice.value.text === text) notice.value = { text: '', type: 'ok' }; }, 6000);
}

async function loadCrafts() {
  list.value = await api.craftTypes({});
}
async function loadRate() {
  try { rateConfig.value = await api.wageMultipliers(); }
  catch (e) { rateConfig.value = null; console.warn('[craft-types] 倍率配置读取失败', e.message); }
}
async function loadAll() {
  try { await Promise.all([loadCrafts(), loadRate()]); say('已重新读取工序类别与倍率配置'); }
  catch (e) { say(e.message, 'err'); }
}
onMounted(() => { Promise.all([loadCrafts(), loadRate()]).catch((e) => say(e.message, 'err')); });

/**
 * 开关 → 真实写入全局工价倍率配置。
 * 后端 save() 要求完整 body（revision/enabled/tiers/process_scope）并用 revision 乐观锁，
 * 所以这里读一份、只改 craft_type_ids，其余原样回传；首次切换把 mode 固定为 selected。
 */
async function toggleRate(r) {
  const c = rateConfig.value;
  if (!c || !canEditRate.value || rateSavingId.value !== null) return;
  const ids = new Set((c.process_scope?.craft_type_ids || []).map(Number));
  if (isEnabled(r)) ids.delete(Number(r.id)); else ids.add(Number(r.id));
  const body = {
    revision: c.revision,
    enabled: c.enabled,
    tiers: (c.tiers || []).map((t) => ({ min: t.min, max: t.max ?? null, multiplier: t.multiplier })),
    process_scope: {
      mode: 'selected',
      categories: c.process_scope?.categories || [],
      craft_type_ids: [...ids],
      node_codes: c.process_scope?.node_codes || []
    }
  };
  rateSavingId.value = Number(r.id);
  try {
    rateConfig.value = await api.saveWageMultipliers(body);
    say(`「${r.name}」已${body.process_scope.craft_type_ids.includes(Number(r.id)) ? '启用' : '关闭'}工价倍率`);
  } catch (e) {
    say(e.message || '倍率保存失败', 'err');
    await loadRate();                                     // 409 等冲突时回到服务端最新状态
  } finally { rateSavingId.value = null; }
}

function openCreate() { form.value = blank(); showModal.value = true; }
function openEdit(r) { form.value = { ...blank(), ...r, is_out: Number(r.is_out) || 0 }; showModal.value = true; }

async function save() {
  if (!String(form.value.name || '').trim()) return say('请填写工序类别名称', 'err');
  saving.value = true;
  try {
    const d = { ...form.value };
    delete d.id; delete d.code; delete d.sort; delete d.is_out; delete d.image_url;
    if (form.value.id) await api.updateCraftType(form.value.id, d);
    else await api.createCraftType(d);
    showModal.value = false;
    await loadCrafts();
    say('工序类别已保存');
  } catch (e) { say(e.message, 'err'); } finally { saving.value = false; }
}

async function remove(r) {
  if (!confirm(`确定删除「${r.name}」？\n\n为保留历史报工与工资数据，实际执行停用（记录不删除）。`)) return;
  try {
    await api.deleteCraftType(r.id);
    await loadCrafts();
    say(`「${r.name}」已停用`);
  } catch (e) { say(e.message, 'err'); }
}
</script>

<style scoped>
/* ===== 一比一：筛选 / 按钮 / 表格 ===== */
.ct-page { font-size: 12.5px; color: var(--yc-ink-2, #606266); }
.ct-filter { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ct-filter > label { width: 58px; flex: none; text-align: right; font-weight: 500; color: var(--yc-ink, #303133); white-space: nowrap; }
.ct-input {
  width: 220px; height: 28px; padding: 0 8px; box-sizing: border-box;
  border: 1px solid var(--yc-line, #dcdfe6); border-radius: 3px;
  background: var(--yc-surface, #fff); color: var(--yc-ink-2, #606266); font-size: 12px;
}
.ct-input::placeholder { color: #b6bcc6; }
.ct-input:focus { outline: none; border-color: #1668f0; }
.ct-count { margin-left: auto; color: var(--yc-ink-3, #909399); font-size: 12px; }
.ct-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.ct-btn {
  height: 26px; padding: 0 12px; border-radius: 3px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.ct-btn.primary { background: #1668f0; border: 1px solid #1668f0; color: #fff; }
.ct-btn.primary:hover { background: #0f57d8; }
.ct-mode { color: var(--yc-ink-3, #909399); font-size: 11.5px; }
.ct-notice { margin: 0 0 10px; padding: 7px 12px; border-radius: 3px; font-size: 12px; }
.ct-notice.ok { background: #eaf3ff; color: #1668f0; }
.ct-notice.err { background: #fff0f0; color: #d03050; }

.ct-panel {
  position: relative; border: 1px solid var(--yc-line, #e4e9f0); border-radius: 4px;
  background: var(--yc-surface, #fff); overflow: hidden;
}
.ct-panel-btn {
  position: absolute; top: 6px; right: 8px; z-index: 2;
  width: 20px; height: 20px; display: grid; place-items: center;
  border: 1px solid var(--yc-line, #e4e9f0); border-radius: 2px;
  background: var(--yc-surface, #fff); color: var(--yc-ink-3, #909399);
  font-size: 12px; line-height: 1; cursor: pointer;
}
.ct-panel-btn:hover { color: #1668f0; border-color: #1668f0; }
.ct-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ct-table th, .ct-table td {
  border-bottom: 1px solid var(--yc-line, #e4e9f0); text-align: center;
  padding: 0 10px; height: 40px; font-size: 12.5px; font-weight: 400;
}
.ct-table th { background: var(--yc-page, #f5f7fa); color: var(--yc-ink, #303133); font-weight: 600; height: 38px; }
.ct-table th:first-child, .ct-table td:first-child { width: 44%; }
.ct-table th:nth-child(2), .ct-table td:nth-child(2) { width: 32%; }
.ct-table tbody tr:last-child td { border-bottom: 0; }
.ct-table tbody tr:hover { background: #f5f9ff; }
.ct-name { color: var(--yc-ink-2, #606266); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-empty { padding: 40px 10px; color: var(--yc-ink-3, #909399); }

.ct-rate { white-space: nowrap; }
.ct-rate > * { vertical-align: middle; }
.ct-flag { display: inline-block; min-width: 16px; color: var(--yc-ink-3, #909399); font-size: 12px; }
.ct-flag.on { color: #1668f0; font-weight: 600; }
.ct-switch {
  position: relative; display: inline-block; width: 32px; height: 17px; margin: 0 7px;
  border: 0; border-radius: 9px; background: #c8d0dc; cursor: pointer; transition: background .15s;
}
.ct-switch i {
  position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: left .15s;
}
.ct-switch.on { background: #1668f0; }
.ct-switch.on i { left: 17px; }
.ct-switch:disabled { opacity: .55; cursor: not-allowed; }
.ct-ops { white-space: nowrap; }
.ct-link { padding: 0 5px; border: 0; background: none; color: #1668f0; font-size: 12.5px; cursor: pointer; }
.ct-link:hover { text-decoration: underline; }
.ct-link.danger { color: #f56c6c; }
.ct-foot { margin: 10px 0 0; color: var(--yc-ink-3, #909399); font-size: 11.5px; line-height: 1.7; }
.ct-modal-tip { margin: 12px 0 0; color: var(--ink-mute); font-size: 12px; line-height: 1.7; }

/* 深色显示模式：容器跟随主题，蓝色开关与红色删除链接保持不变 */
:root[data-theme="dark"] .ct-table tbody tr:hover { background: #223045; }
:root[data-theme="dark"] .ct-notice.ok { background: #182d43; }
:root[data-theme="dark"] .ct-notice.err { background: #3a1f26; }
:root[data-theme="dark"] .ct-input::placeholder { color: #6b7684; }
</style>
