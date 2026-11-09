<template>
  <div v-if="open" class="modal-mask picker-mask">
    <div class="modal xwide picker">
      <div class="modal-head">
        <h3>
          {{ mode === 'base' ? '从档案选择基础物料' : '选择面辅料' }}
          <span class="hint">{{ mode === 'base' ? '选中后把它的资料带到新建页，改完保存就是一条新档案' : '勾选后加入本单，档案资料只读' }}</span>
        </h3>
        <button type="button" class="x" @click="close">×</button>
      </div>

      <div class="modal-body">
        <div class="picker-bar">
          <input class="input" v-model="kw.name" placeholder="物料名称 / 编号" style="width: 190px" @keyup.enter="load" />
          <input class="input" v-model="kw.short" placeholder="简称" style="width: 110px" @keyup.enter="load" />
          <select class="select" v-model="kw.supplier" style="width: 170px" @change="load">
            <option value="">全部供应商</option>
            <option v-for="s in suppliers" :key="s" :value="s">{{ s }}</option>
          </select>
          <select class="select" v-model="kw.type" style="width: 110px" @change="load">
            <option value="">全部类型</option>
            <option value="fabric">面料</option>
            <option value="accessory">辅料</option>
          </select>
          <button type="button" class="btn btn-ghost btn-sm" @click="load">查询</button>
          <div style="flex: 1"></div>
          <button type="button" class="btn btn-ghost btn-sm" @click="openArchive">＋ 新增料</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="reloadAll">刷新档案</button>
        </div>

        <div class="picker-scroll">
          <table class="data picker-table">
            <thead>
              <tr>
                <th v-if="mode !== 'base'" style="width: 36px">
                  <input type="checkbox" :checked="allChecked" @change="toggleAll($event.target.checked)" />
                </th>
                <th style="width: 56px">色卡本封面</th>
                <th style="width: 140px">供应商信息</th>
                <th style="width: 60px">类型</th>
                <th style="min-width: 180px">物料名称/编号</th>
                <th style="width: 90px">简称</th>
                <th style="width: 52px">单位</th>
                <th style="width: 150px">规格</th>
                <th style="width: 100px">库存明细</th>
                <th style="width: 96px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in list" :key="m.id" :class="{ sel: picked.has(m.id) }">
                <td v-if="mode !== 'base'"><input type="checkbox" :checked="picked.has(m.id)" @change="toggle(m.id, $event.target.checked)" /></td>
                <td>
                  <div class="thumb">
                    <img v-if="m.image_url" :src="m.image_url" />
                    <span v-else class="ph">-</span>
                  </div>
                </td>
                <td>
                  <div class="nowrap-ellipsis" :title="m.supplier">{{ m.supplier || '-' }}</div>
                  <div class="sub-line nowrap-ellipsis" :title="m.supplier_info">{{ m.supplier_info || '' }}</div>
                </td>
                <td><span class="tag" :class="m.type === 'fabric' ? 'purple' : 'blue'">{{ m.type === 'fabric' ? '面料' : '辅料' }}</span></td>
                <td>
                  <strong>{{ m.name }}</strong>
                  <div v-if="m.code" class="sub-line">{{ m.code }}</div>
                </td>
                <td>{{ m.short_name || '-' }}</td>
                <td>{{ m.unit || '-' }}</td>
                <td class="spec-cell">
                  <div v-if="m.width">幅宽：{{ m.width }}</div>
                  <div v-if="m.weight">克重：{{ m.weight }}</div>
                  <div v-if="m.air_gap">空差：{{ m.air_gap }}</div>
                  <div v-if="!m.width && !m.weight && !m.air_gap && m.spec">{{ m.spec }}</div>
                </td>
                <td>
                  <span v-if="m.stock_qty">{{ m.stock_qty }}{{ m.unit || '' }}</span>
                  <span v-else class="sub-line">-</span>
                </td>
                <td class="ops">
                  <button type="button" v-if="mode === 'base'" class="link-btn" @click="useAsBase(m)">用作基础</button>
                  <template v-else>
                    <button type="button" class="link-btn" @click="pickOne(m)">加入</button>
                    <button type="button" class="link-btn" :disabled="copying === m.id" @click="copyOne(m)">
                      {{ copying === m.id ? '…' : '复制' }}
                    </button>
                  </template>
                </td>
              </tr>
              <tr v-if="!list.length"><td :colspan="mode === 'base' ? 11 : 12" class="empty-cell">没有匹配的档案，先去「面辅料档案」建立，或调整筛查条件</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="modal-foot">
        <span class="sel-count">
          {{ mode === 'base' ? '点「用作基础」把这条资料带到新建页；档案里没有的可以先空白新建' : '已选 ' + picked.size + ' 条' }}
        </span>
        <button type="button" class="btn btn-ghost" @click="close">关闭</button>
        <template v-if="mode === 'base'">
          <button type="button" class="btn btn-primary" @click="blankNew">空白新建</button>
        </template>
        <button type="button" v-else class="btn btn-primary" :disabled="!picked.size" @click="confirm">确定加入</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { api } from '../api';

const props = defineProps({
  open: { type: Boolean, default: false },
  type: { type: String, default: '' },       // 预筛类型：fabric / accessory / ''
  mode: { type: String, default: 'pick' },   // pick = 加入本单；base = 用作新档案的基础资料
  /**
   * 已经选中的 id：打开时回填勾选状态
   *
   * 有了它，二次打开弹窗不会"看不出哪些已经加过"，也不会重复加入同一条。
   */
  selected: { type: Array, default: () => [] }
});
const emit = defineEmits(['close', 'picked', 'base', 'blank']);

const list = ref([]);
const suppliers = ref([]);
const kw = ref({ name: '', short: '', supplier: '', type: props.type || '' });
const picked = ref(new Set());
const copying = ref(0);
/**
 * 看过的行（id → 行），跨多次查询累积
 *
 * 原来 `confirm()` 只在**当前筛选结果**里找已勾的 id —— 先搜"棉"勾两条、再搜"涤"
 * 勾一条，点确定只会带出后面那条，前面两条静默丢了。物料多的时候这是必然发生的操作路径。
 * 现在按 id 从 `seen` 里取，勾过的都在。
 */
const seen = ref(new Map());

const allChecked = computed(() => list.value.length > 0 && list.value.every((m) => picked.value.has(m.id)));

async function load() {
  try {
    const all = await api.materials({ type: kw.value.type });
    // 供应商下拉用全量档案去重，避免筛选后越选越少
    suppliers.value = [...new Set(all.map((m) => m.supplier).filter(Boolean))].sort();
    const next = new Map(seen.value);
    all.forEach((m) => next.set(m.id, m));
    seen.value = next;
    const name = kw.value.name.trim().toLowerCase();
    const short = kw.value.short.trim().toLowerCase();
    list.value = all.filter((m) => {
      if (kw.value.supplier && m.supplier !== kw.value.supplier) return false;
      if (name) {
        const hit = [m.name, m.code].some((v) => (v || '').toLowerCase().includes(name));
        if (!hit) return false;
      }
      if (short && !(m.short_name || '').toLowerCase().includes(short)) return false;
      return m.status === 'active';
    });
  } catch (e) { alert(e.message); }
}

function reloadAll() { kw.value = { name: '', short: '', supplier: '', type: '' }; load(); }

function toggle(id, on) {
  const s = new Set(picked.value);
  if (on) s.add(id); else s.delete(id);
  picked.value = s;
}
function toggleAll(on) {
  picked.value = on ? new Set(list.value.map((m) => m.id)) : new Set();
}

function confirm() {
  // 按 id 从 seen 里取，**不按当前筛选列表取** —— 否则先搜 A 勾、再搜 B 勾，
  // 确定时只会带出 B 那几条，A 的两条静默消失（物料多时这是必经路径）
  const ids = [...picked.value];
  const rows = ids.map((id) => seen.value.get(id)).filter(Boolean);
  emit('picked', rows);
  picked.value = new Set();
  emit('close');
}
/** 「加入」：单条直接加入，不关闭弹窗，方便连续挑多行 */
function pickOne(m) {
  emit('picked', [m]);
  picked.value = new Set();
}

/**
 * 复制档案：同款换色号时最常用 —— 复制一条出生份草稿，改色号/颜色即可。
 * 复制出来的记录 id 是新的，自动加入已选，省得再找一遍。
 */
async function copyOne(m) {
  if (copying.value) return;
  copying.value = m.id;
  try {
    const row = await api.duplicateMaterial(m.id);
    await load();
    if (row && row.id) {
      picked.value = new Set([...picked.value, row.id]);
      alert(`已复制成新档案：${row.name}${row.color_no ? '（色号 ' + row.color_no + '）' : ''}\n已自动勾选，可直接加入本单；要改名称/色号请到「档案 → 面辅料档案」编辑。`);
    }
  } catch (e) { alert(e.message); } finally { copying.value = 0; }
}

/** 档案里没有的物料：直接去档案页新建（新标签，不打断当前单子） */
function openArchive() {
  window.open('/materials', '_blank');
}

/** base 模式：把这条档案当模板，交给父组件跳新建页 */
function useAsBase(m) {
  emit('base', m);
  emit('close');
}
function blankNew() {
  emit('blank');
  emit('close');
}

function close() {
  picked.value = new Set();
  emit('close');
}

watch(() => props.open, (v) => {
  if (v) {
    // 回填已选（父组件传进来的），再拉一次档案（别人可能刚新建过）
    picked.value = new Set((props.selected || []).map(Number).filter(Boolean));
    kw.value.type = props.type || '';
    load();
  }
});
</script>

<style scoped>
/* 提高特异性：全局 .modal.xwide 是 1000px，这里要更宽才放得下 12 列 */
.modal.xwide.picker { width: 1360px; max-width: 97vw; }
.picker-mask { z-index: 1200; }
.hint { font-weight: 400; font-size: 12px; color: var(--ink-mute); margin-left: 6px; }
.picker-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.picker-scroll { overflow: auto; max-height: 56vh; border: 1px solid var(--line); border-radius: 8px; }
.picker-table { border: none; min-width: 1180px; }
.picker-table th, .picker-table td { padding: 5px 7px; font-size: 12px; vertical-align: middle; white-space: nowrap; }
.picker-table tr.sel { background: #f2f7ff; }
.picker-table .ops { white-space: nowrap; }
.picker-table .ops .link-btn + .link-btn { margin-left: 6px; }
.picker-table .nowrap-ellipsis { max-width: 138px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-line { font-size: 12px; color: var(--ink-mute); margin-top: 1px; }
.spec-cell { font-size: 12px; line-height: 1.45; color: var(--ink); white-space: normal; }
.thumb {
  width: 36px; height: 36px; border-radius: 5px; overflow: hidden; background: var(--surface-2);
  border: 1px solid var(--line); display: flex; align-items: center; justify-content: center;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb .ph { font-size: 12px; color: var(--ink-mute); }
.sel-count { margin-right: auto; font-size: 12.5px; color: #5b6474; }
</style>
