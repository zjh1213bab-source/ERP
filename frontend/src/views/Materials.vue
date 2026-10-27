<template>
  <div>
    <div class="page-head">
      <div>
        <h2>面辅料档案</h2>
        <div class="sub">开发单的工艺单从这里选择调用；档案资料统一维护，开发单里只读，只允许补充色号与本单图片</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="showBase = true">＋ 新增面辅料</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <div class="seg">
        <button :class="{ on: type === '' }" @click="type = ''; load()">全部</button>
        <button :class="{ on: type === 'fabric' }" @click="type = 'fabric'; load()">面料</button>
        <button :class="{ on: type === 'accessory' }" @click="type = 'accessory'; load()">辅料</button>
      </div>
      <input class="input" v-model="q" placeholder="搜索 物料名称 / 编号 / 简称 / 供应商 / 色号" style="width: 340px" @keyup.enter="load" />
      <button class="btn btn-ghost" @click="load">查询</button>
      <label v-if="canWrite" class="btn btn-ghost" style="cursor: pointer">
        导入 CSV<input type="file" accept=".csv" style="display: none" @change="onCsv" />
      </label>
      <span class="hint">共 {{ list.length }} 条</span>
    </div>

    <div class="table-wrap">
      <table class="data mat-table">
        <thead>
          <tr>
            <th style="width: 60px">图片</th>
            <th style="width: 150px">供应商</th>
            <th style="width: 60px">类型</th>
            <th>物料名称 / 编号</th>
            <th style="width: 100px">简称</th>
            <th style="width: 110px">颜色</th>
            <th style="width: 110px">色号</th>
            <th style="width: 56px">单位</th>
            <th style="width: 170px">规格</th>
            <th style="width: 90px">库存</th>
            <th style="width: 150px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in list" :key="m.id" :class="{ off: m.status !== 'active' }">
            <td>
              <div class="thumb" :class="{ clickable: m.image_url }" @click="m.image_url && openImage(m.image_url, m.name || '')">
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
            <td>{{ m.color || '-' }}</td>
            <td>{{ m.color_no || '-' }}</td>
            <td>{{ m.unit || '-' }}</td>
            <td class="spec-cell">
              <div v-if="m.width">幅宽：{{ m.width }}</div>
              <div v-if="m.weight">克重：{{ m.weight }}</div>
              <div v-if="m.air_gap">空差：{{ m.air_gap }}</div>
              <div v-if="!m.width && !m.weight && !m.air_gap && m.spec">{{ m.spec }}</div>
            </td>
            <td>
              <span v-if="m.stock_qty">{{ m.stock_qty }} {{ m.unit || '' }}</span>
              <span v-else class="sub-line">-</span>
              <div v-if="m.stock_detail" class="sub-line nowrap-ellipsis" :title="m.stock_detail">{{ m.stock_detail }}</div>
            </td>
            <td>
              <button v-if="canWrite" class="link-btn" @click="openEdit(m)">编辑</button>
              <button v-if="canWrite" class="link-btn" @click="duplicate(m)">复制</button>
              <button v-if="canWrite && m.status === 'active'" class="link-btn danger" @click="disable(m)">停用</button>
              <span v-else-if="m.status !== 'active'" class="tag gray">已停用</span>
            </td>
          </tr>
          <tr v-if="!list.length"><td colspan="11" class="empty-cell">暂无档案，点右上角「新增档案」或导入 CSV</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 新增：先从档案里选一条作为基础（也可空白新建） -->
    <MaterialPicker
      :open="showBase"
      mode="base"
      @close="showBase = false"
      @base="useAsBase"
      @blank="goNew"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';
import MaterialPicker from '../components/MaterialPicker.vue';

const list = ref([]);
const q = ref('');
const type = ref('');
const showBase = ref(false);
const router = useRouter();

const canWrite = computed(() => can('development.write'));

async function load() {
  try { list.value = await api.materials({ type: type.value, q: q.value }); }
  catch (e) { alert(e.message); }
}

/** 编辑走独立页面（字段多，弹窗放不下） */
function openEdit(m) { router.push('/materials/' + m.id); }
function goNew() { router.push('/materials/new'); }
/** 选了基础档案：带着它去新建页，色号清空等用户改 */
function useAsBase(m) { router.push({ path: '/materials/new', query: { from: m.id } }); }

async function duplicate(m) {
  if (!confirm(`复制「${m.name}」成一条新档案？（复制后可改色号）`)) return;
  try { await api.duplicateMaterial(m.id); await load(); } catch (e) { alert(e.message); }
}

async function disable(m) {
  if (!confirm(`停用「${m.name}」？停用后开发单不能再选，但已引用的历史单不受影响。`)) return;
  try { await api.deleteMaterial(m.id); await load(); } catch (e) { alert(e.message); }
}

/** CSV 导入：类型,名称,编号,简称,供应商,供应商信息,颜色,色号,单位,幅宽,克重,空差,成份,规格说明 */
async function onCsv(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const text = await file.text();
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) return alert('CSV 至少要有表头 + 一行数据');
  const cols = rows[0].split(',').map((s) => s.trim());
  let okCount = 0, errCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(',').map((s) => s.trim());
    const get = (k) => {
      const idx = cols.indexOf(k);
      return idx >= 0 ? cells[idx] || '' : '';
    };
    const typeVal = get('类型') === '辅料' ? 'accessory' : 'fabric';
    const name = get('名称') || get('物料名称');
    if (!name) { errCount++; continue; }
    try {
      await api.createMaterial({
        type: typeVal, name, code: get('编号'), short_name: get('简称'),
        supplier: get('供应商'), supplier_info: get('供应商信息'),
        color: get('颜色'), color_no: get('色号'), unit: get('单位') || '米',
        width: get('幅宽'), weight: get('克重'), air_gap: get('空差'),
        composition: get('成份'), spec: get('规格说明')
      });
      okCount++;
    } catch (e) { errCount++; }
  }
  await load();
  alert(`导入完成：成功 ${okCount} 条${errCount ? '，失败 ' + errCount + ' 条' : ''}`);
}

onMounted(load);
</script>

<style scoped>
.hint { font-size: 12px; color: #8a94a6; }
.mat-table th, .mat-table td { vertical-align: middle; }
.mat-table .nowrap-ellipsis { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-line { font-size: 11.5px; color: #8a94a6; margin-top: 2px; }
.spec-cell { font-size: 12px; line-height: 1.5; color: #33415a; }
.thumb {
  width: 40px; height: 40px; border-radius: 6px; overflow: hidden; background: #f7f9fc;
  border: 1px solid #eef2f7; display: flex; align-items: center; justify-content: center;
}
.thumb.lg { width: 76px; height: 76px; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb .ph { font-size: 11px; color: #a9b4c5; }
tr.off td { opacity: 0.55; }
.tip { font-size: 11.5px; color: #8a94a6; margin: 8px 0 0; }
</style>
