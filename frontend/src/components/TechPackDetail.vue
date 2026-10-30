<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal xwide tp-modal">
      <div class="modal-head">
        <h3>
          开发详情
          <span v-if="tp" class="tag" :class="statusTag">{{ statusLabel }}</span>
          <span v-if="tp" style="font-weight: 400; font-size: 12.5px; color: #8a94a6; margin-left: 8px">
            {{ tp.order ? tp.order.order_no : '' }} · {{ tp.version }}
          </span>
        </h3>
        <button class="x" @click="close">×</button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="tp-loading">加载中…</div>

        <template v-else-if="tp">
          <!--
            确认前还差什么 —— 由后端 confirmBlocks() 算出（与确认接口同一份判断）。
            只在草稿状态下显示；已确认的单后端直接返回空数组。
            写清楚"缺哪项、去哪补"，否则只会看到一句"不能确认"，人不知道该动哪里。
          -->
          <div v-if="tp.confirm_blocks && tp.confirm_blocks.length" class="tp-gate">
            <div class="g-head">
              还不能确认 —— 差 {{ tp.confirm_blocks.length }} 项
              <span class="g-sub">（定制订单确认前必填，确认后明细锁定）</span>
            </div>
            <ul>
              <li v-for="b in tp.confirm_blocks" :key="b.key">
                <span class="g-label">{{ b.label }}</span>
                <span class="g-detail">{{ b.detail }}</span>
                <span class="g-where">→ {{ b.where }}</span>
              </li>
            </ul>
          </div>

          <!-- ---------- 头部信息 ---------- -->
          <div class="tp-head">
            <div class="tp-img">
              <ImageUpload v-model="tp.image_url" size="lg" :disabled="!editable" />
            </div>
            <div class="tp-info">
              <div class="tp-cell"><label>款号</label><div class="v">{{ tp.product_name || '-' }}</div></div>
              <div class="tp-cell"><label>客户款号</label><input v-model="head.customer_style_no" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>客户</label><div class="v">{{ tp.order ? tp.order.customer_name || '-' : '-' }}</div></div>
              <div class="tp-cell"><label>状态</label><div class="v"><span class="tag" :class="statusTag">{{ statusLabel }}</span></div></div>
              <div class="tp-cell"><label>颜色</label><input v-model="head.colors" :disabled="!editable" class="input" placeholder="藏青/燕麦" /></div>
              <div class="tp-cell"><label>尺码</label><input v-model="head.size_range" :disabled="!editable" class="input" placeholder="S/M/L" /></div>
              <div class="tp-cell"><label>设计师</label><input v-model="head.designer" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>车版师</label><input v-model="head.pattern_maker" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>纸样号</label><input v-model="head.pattern_no" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>分类</label><input v-model="head.category" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>标签</label><input v-model="head.label_name" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>系列</label><input v-model="head.series" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>波段</label><input v-model="head.wave" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>业务员</label><input v-model="head.sales_owner" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>PO 单号</label><input v-model="head.po_no" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>品牌</label><input v-model="head.brand" :disabled="!editable" class="input" /></div>
              <div class="tp-cell"><label>交货日期</label><input v-model="head.delivery_date" :disabled="!editable" type="date" class="input" /></div>
              <div class="tp-cell"><label>备注</label><input v-model="head.remark" :disabled="!editable" class="input" /></div>
            </div>
          </div>

          <!-- ---------- 页签 ---------- -->
          <div class="tabs tp-tabs">
            <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
              {{ t.label }}
              <span v-if="t.key === 'material' && materials.length" class="cnt">{{ materials.length }}</span>
              <span v-if="t.key === 'size' && sizeRows.length" class="cnt">{{ sizeRows.length }}</span>
              <span v-if="t.key === 'req' && requirements.length" class="cnt">{{ requirements.length }}</span>
            </button>
          </div>

          <!-- ========== 概览：客户要求 ========== -->
          <div v-if="tab === 'overview'">
            <h4 class="tp-h4">客户要求</h4>
            <textarea v-model="head.customer_req" :disabled="!editable" rows="5" class="tp-ta"
              placeholder="尺码表 / 包装 / 标签 / 测试要求 / 交期…（会打印在工艺单与总单上）"></textarea>

            <h4 class="tp-h4">工艺 / 工序说明</h4>
            <textarea v-model="head.craft_info" :disabled="!editable" rows="4" class="tp-ta"
              placeholder="印花 / 绣花 / 水洗 / 车缝 / 锁眼 / 整烫…"></textarea>

            <h4 class="tp-h4">尺码规格说明</h4>
            <input v-model="head.size_spec" :disabled="!editable" class="input" style="width: 100%"
              placeholder="如：按客户提供的尺寸表，允许 ±1cm 公差" />

            <h4 class="tp-h4">打版流程</h4>
            <div class="tp-steps">
              <div v-for="(s, i) in STAGES" :key="s.key" class="tp-step" :class="{ on: i <= stageIndex, cur: i === stageIndex }">
                <span class="dot">{{ i + 1 }}</span>{{ s.label }}
              </div>
            </div>
            <p v-if="editable" class="tp-tip">提示：流程推进用列表里的「推进 →」，这里只做展示。</p>
          </div>

          <!-- ========== 面辅料信息（从档案选择，档案字段只读） ========== -->
          <div v-if="tab === 'material'">
            <div class="tp-bar">
              <div class="seg">
                <button :class="{ on: matFilter === 'all' }" @click="matFilter = 'all'">全部</button>
                <button :class="{ on: matFilter === 'fabric' }" @click="matFilter = 'fabric'">面料</button>
                <button :class="{ on: matFilter === 'accessory' }" @click="matFilter = 'accessory'">辅料</button>
              </div>
              <div style="display: flex; gap: 8px" v-if="editable">
                <button class="btn btn-primary btn-sm" @click="pickerOpen = true; pickerType = ''">＋ 添加面辅料</button>
                <button class="btn btn-ghost btn-sm" @click="addManual('fabric')">＋ 手工面料行</button>
                <button class="btn btn-ghost btn-sm" @click="addManual('accessory')">＋ 手工辅料行</button>
              </div>
            </div>

            <div class="tp-scroll">
              <table class="data tp-mat">
                <thead>
                  <tr>
                    <th style="width: 60px">类型</th>
                    <th style="width: 96px">款色</th>
                    <th style="min-width: 240px">物料名称 / 规格</th>
                    <th style="width: 180px">色号</th>
                    <th style="min-width: 140px">供应商</th>
                    <th style="width: 130px">成份 <span style="font-weight:400">可改</span></th>
                    <th style="width: 54px">单位</th>
                    <th style="width: 84px">单件用量</th>
                    <th style="width: 66px">损耗%</th>
                    <th style="width: 66px">空差%</th>
                    <th style="width: 76px">单价</th>
                    <th style="width: 76px">单件金额</th>
                    <th style="width: 110px">备注</th>
                    <th style="width: 72px">物料图</th>
                    <th style="width: 72px">色卡图</th>
                    <th v-if="editable" style="width: 44px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(m, idx) in shownMaterials" :key="idx" :class="{ 'from-arc': !!m.material_id }">
                    <td>
                      <span v-if="m.material_id" class="tag" :class="m.mat_type === 'fabric' ? 'purple' : 'blue'">
                        {{ m.mat_type === 'fabric' ? '面料' : '辅料' }}
                      </span>
                      <select v-else v-model="m.mat_type" :disabled="!editable" class="select mini">
                        <option value="fabric">面料</option>
                        <option value="accessory">辅料</option>
                      </select>
                    </td>
                    <td><input v-model="m.colorway" :disabled="!editable" class="input mini" placeholder="印花001" /></td>
                    <td>
                      <div v-if="m.material_id" class="locked" :title="m.material_name">
                        <span class="lock">🔒</span>{{ m.material_name }}
                        <div v-if="m.spec_info" class="sub">{{ m.spec_info }}</div>
                      </div>
                      <template v-else>
                        <input v-model="m.material_name" :disabled="!editable" class="input mini" placeholder="物料名称 / 规格" />
                        <input v-model="m.spec_info" :disabled="!editable" class="input mini mt2" placeholder="规格：幅宽/克重/空差" />
                        <input v-model="m.composition" :disabled="!editable" class="input mini mt2" placeholder="成份" />
                      </template>
                    </td>
                    <td><input v-model="m.color_no" :disabled="!editable" class="input mini" placeholder="可自填" /></td>
                    <td>
                      <div v-if="m.material_id" class="locked">
                        {{ m.supplier || '-' }}
                        <div v-if="m.supplier_info" class="sub" :title="m.supplier_info">{{ m.supplier_info }}</div>
                      </div>
                      <input v-else v-model="m.supplier" :disabled="!editable" class="input mini" />
                    </td>
                    <td>
                      <!-- 成份允许本单覆盖：水洗标 / 烫画标按客户指定填 -->
                      <input v-model="m.composition" :disabled="!editable" class="input mini" placeholder="按客户指定" />
                    </td>
                    <td>
                      <div v-if="m.material_id" class="locked center">{{ m.unit || '-' }}</div>
                      <input v-else v-model="m.unit" :disabled="!editable" class="input mini" />
                    </td>
                    <td><input v-model.number="m.one_use" :disabled="!editable" type="number" step="0.01" class="input mini" /></td>
                    <td><input v-model.number="m.loss_rate" :disabled="!editable" type="number" step="0.1" class="input mini" /></td>
                    <td><input v-model.number="m.air_gap" :disabled="!editable" type="number" step="0.1" class="input mini" /></td>
                    <td><input v-model.number="m.unit_price" :disabled="!editable" type="number" step="0.01" class="input mini" /></td>
                    <td class="num">{{ money(m.one_use * m.unit_price) }}</td>
                    <td><input v-model="m.remark" :disabled="!editable" class="input mini" /></td>
                    <td class="pic">
                      <ImageUpload v-model="m.image_url" size="xs" :disabled="!editable" />
                    </td>
                    <td class="pic">
                      <ImageUpload v-model="m.color_card_url" size="xs" :disabled="!editable" />
                    </td>
                    <td v-if="editable"><button class="link-btn danger" @click="delMat(m)">删</button></td>
                  </tr>
                  <tr v-if="!shownMaterials.length">
                    <td :colspan="editable ? 16 : 15" class="empty-cell">
                      还没有面辅料。点「＋ 添加面辅料」从档案里挑；档案里没有的物料，先去「档案 → 面辅料档案」建档
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="tp-sum">
              共 {{ shownMaterials.length }} 行 · 单件物料成本合计 <strong>{{ money(matTotal) }}</strong> 元
              <span v-if="orderQty" style="color: #8a94a6"> · 按订单 {{ orderQty }} 件估算总额 {{ money(matTotal * orderQty) }} 元</span>
              <span class="tp-legend">🔒 = 档案资料，本单只读；色号、图片、用量、单价可在本单补充</span>
            </div>
          </div>
          <!-- ========== 成衣尺寸 ========== -->
          <div v-if="tab === 'size'">
            <div class="tp-bar">
              <div style="display: flex; gap: 8px; align-items: center">
                <span class="tp-hint">按部位 × 尺码填写，单位 cm；可填「68±1」这种带公差写法</span>
              </div>
              <div style="display: flex; gap: 8px" v-if="editable">
                <button class="btn btn-ghost btn-sm" @click="pullSizes">从订单带出尺码</button>
                <button class="btn btn-ghost btn-sm" @click="addPart">＋ 部位</button>
                <button class="btn btn-ghost btn-sm" @click="addSizeCol">＋ 尺码</button>
              </div>
            </div>

            <div class="tp-scroll" v-if="sizeParts.length && sizeCols.length">
              <table class="data tp-size">
                <thead>
                  <tr>
                    <th style="min-width: 110px">部位 \ 尺码</th>
                    <th v-for="(s, si) in sizeCols" :key="si" style="width: 100px">
                      <div class="col-head">
                        <input :value="s" :disabled="!editable" class="input mini center" @change="(e) => renameSizeCol(si, e.target.value)" />
                        <button v-if="editable" class="x-mini" @click="delSizeCol(si)">×</button>
                      </div>
                    </th>
                    <th v-if="editable" style="width: 48px"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(p, pi) in sizeParts" :key="pi">
                    <td>
                      <input :value="p" :disabled="!editable" class="input mini" @change="(e) => renamePart(pi, e.target.value)" />
                    </td>
                    <td v-for="(s, si) in sizeCols" :key="si">
                      <input v-model="cells[cellKey(p, s)]" :disabled="!editable" class="input mini center" placeholder="-" />
                    </td>
                    <td v-if="editable"><button class="link-btn danger" @click="delPart(pi)">删</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="empty-cell">
              还没有尺寸数据。
              <button v-if="editable" class="link-btn" @click="pullSizes">从订单带出尺码骨架</button>
            </div>
          </div>

          <!-- ========== 生产要求 ========== -->
          <div v-if="tab === 'req'">
            <div class="tp-bar">
              <span class="tp-hint">按分类逐条写，打印时按分类分组显示</span>
              <button v-if="editable" class="btn btn-ghost btn-sm" @click="addReq('craft')">＋ 添加要求</button>
            </div>

            <div v-for="g in REQ_CATS" :key="g.key" class="req-group">
              <div class="req-head">
                <strong>{{ g.label }}</strong>
                <button v-if="editable" class="link-btn" @click="addReq(g.key)">＋ 添加</button>
              </div>
              <div v-for="(r, i) in reqOf(g.key)" :key="i" class="req-row">
                <span class="req-no">{{ i + 1 }}</span>
                <input v-model="r.content" :disabled="!editable" class="input" style="flex: 1" placeholder="填写要求内容" />
                <button v-if="editable" class="link-btn danger" @click="delReq(r)">删</button>
              </div>
              <div v-if="!reqOf(g.key).length" class="req-empty">—</div>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-foot tp-foot">
        <span v-if="tp && tp.status === 'confirmed'" class="tp-lock">已确认，明细已锁定（如需修改请新建版本）</span>
        <button class="btn btn-ghost" @click="print">打印工艺单</button>
        <button v-if="tp && tp.status === 'confirmed'" class="btn btn-ghost" :disabled="saving" @click="newVersion">
          新建版本
        </button>
        <button class="btn btn-ghost" @click="close">关闭</button>
        <button v-if="editable" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存明细' }}
        </button>
      </div>
    </div>

    <!-- 面辅料档案选择器 -->
    <MaterialPicker
      :open="pickerOpen"
      :type="pickerType || (matFilter === 'all' ? '' : matFilter)"
      @close="pickerOpen = false; pickerType = ''"
      @picked="onPicked"
    />

  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import MaterialPicker from './MaterialPicker.vue';
import ImageUpload from './ImageUpload.vue';

const props = defineProps({ techpackId: { type: [Number, String], default: null } });
const emit = defineEmits(['close', 'saved', 'version-created']);

const TABS = [
  { key: 'overview', label: '概览与客户要求' },
  { key: 'material', label: '面辅料信息' },
  { key: 'size', label: '成衣尺寸' },
  { key: 'req', label: '生产要求' }
];
const STAGES = [
  { key: 'draft', label: '可打版' },
  { key: 'material', label: '面辅料确认' },
  { key: 'pattern', label: '制版' },
  { key: 'craft', label: '工艺/工序' },
  { key: 'sample', label: '做样衣' },
  { key: 'biz', label: '业务确认' },
  { key: 'confirmed', label: '已完成' }
];
const REQ_CATS = [
  { key: 'craft', label: '缝制工艺要求' },
  { key: 'packing', label: '包装与标识要求' },
  { key: 'test', label: '测试与验货要求' },
  { key: 'note', label: '其他注意事项' }
];
const HEAD_KEYS = [
  'customer_style_no', 'designer', 'pattern_maker', 'pattern_no', 'category', 'label_name',
  'series', 'wave', 'sales_owner', 'po_no', 'brand', 'colors', 'size_range', 'delivery_date',
  'customer_req', 'craft_info', 'size_spec', 'remark'
];

const open = ref(false);
const loading = ref(false);
const saving = ref(false);
const tab = ref('overview');
const tp = ref(null);
const head = ref({});
const materials = ref([]);
const requirements = ref([]);
const matFilter = ref('all');
const pickerOpen = ref(false);
const pickerType = ref('');

const sizeParts = ref([]);
const sizeCols = ref([]);
const cells = ref({});


const editable = computed(() => tp.value && tp.value.status !== 'confirmed' && can('development.write'));
const statusLabel = computed(() => {
  if (!tp.value) return '';
  const s = tp.value.status;
  if (s === 'confirmed') return '已确认';
  if (s === 'rejected') return '已退回';
  return '待审核';
});
const statusTag = computed(() => ({ confirmed: 'green', rejected: 'red' }[tp.value && tp.value.status] || 'blue'));
const stageIndex = computed(() => Math.max(0, STAGES.findIndex((s) => s.key === (tp.value && tp.value.stage))));

const shownMaterials = computed(() =>
  matFilter.value === 'all' ? materials.value : materials.value.filter((m) => m.mat_type === matFilter.value)
);
const matTotal = computed(() => materials.value.reduce((s, m) => s + (Number(m.one_use) || 0) * (Number(m.unit_price) || 0), 0));
const orderQty = computed(() => {
  if (!tp.value || !tp.value.order || !Array.isArray(tp.value.order.items)) return 0;
  return tp.value.order.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
});

const sizeRows = computed(() => {
  const out = [];
  sizeParts.value.forEach((p) => sizeCols.value.forEach((s) => out.push({ part: p, size: s, value: cells.value[cellKey(p, s)] || '' })));
  return out;
});

const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
const cellKey = (p, s) => p + '||' + s;

function reqOf(cat) {
  return requirements.value.filter((r) => r.category === cat);
}

async function load(id) {
  loading.value = true;
  try {
    const data = await api.techpackFull(id);
    tp.value = data;
    const h = {};
    HEAD_KEYS.forEach((k) => (h[k] = data[k] || ''));
    head.value = h;
    materials.value = (data.materials || []).map((m) => ({ ...m }));
    requirements.value = (data.requirements || []).map((r) => ({ ...r }));
    buildGrid(data.sizes || []);
    tab.value = 'overview';
  } catch (e) {
    alert(e.message);
    close();
  } finally {
    loading.value = false;
  }
}

function buildGrid(rows) {
  const parts = [];
  const cols = [];
  const c = {};
  rows.forEach((r) => {
    if (!parts.includes(r.part)) parts.push(r.part);
    if (!cols.includes(r.size)) cols.push(r.size);
    c[cellKey(r.part, r.size)] = r.value || '';
  });
  sizeParts.value = parts;
  sizeCols.value = cols;
  cells.value = c;
}

/* ---------- 面辅料行 ---------- */
/** 从档案挑中后转成本单明细行：档案字段只读，色号/图片/用量在本单填 */
function rowFromArchive(a) {
  const spec = [];
  if (a.width) spec.push('幅宽' + a.width);
  if (a.weight) spec.push('克重' + a.weight);
  if (a.air_gap) spec.push('空差' + a.air_gap);
  const gapNum = Number(String(a.air_gap || '').replace(/[^\d.]/g, ''));
  return {
    material_id: a.id,
    mat_type: a.type,
    colorway: a.color || head.value.colors || '',
    material_name: a.name,
    color_no: a.color_no || '',
    supplier: a.supplier || '',
    supplier_info: a.supplier_info || '',
    spec_info: spec.length ? spec.join(' ') : (a.spec || ''),
    composition: a.composition || '',
    unit: a.unit || '',
    one_use: 0,
    loss_rate: 0,
    air_gap: Number.isFinite(gapNum) ? gapNum : 0,
    unit_price: 0,
    fabric_param: a.spec || '',
    remark: '',
    image_url: a.image_url || '',
    color_card_url: ''
  };
}

function onPicked(rows) {
  let added = 0, dup = 0;
  (rows || []).forEach((a) => {
    if (materials.value.some((m) => m.material_id === a.id)) { dup++; return; }
    materials.value.push(rowFromArchive(a));
    added++;
  });
  matFilter.value = 'all';
  if (!added && dup) alert('这几条物料已经在清单里了，直接填用量即可');
  else if (added && dup) alert(`已加入 ${added} 条，另有 ${dup} 条已在清单里已跳过`);
}

/** 手工行：档案里没有的物料临时用，全部字段可编辑（打印时会照常出现） */
function addManual(type) {
  materials.value.push({
    material_id: null,
    mat_type: type, colorway: head.value.colors || '', material_name: '', color_no: '',
    supplier: '', supplier_info: '', spec_info: '', composition: '',
    unit: type === 'fabric' ? '米' : '个', one_use: 0, loss_rate: 0, air_gap: 0, unit_price: 0,
    fabric_param: '', remark: '', image_url: '', color_card_url: ''
  });
  matFilter.value = 'all';
}
function delMat(m) {
  const i = materials.value.indexOf(m);
  if (i >= 0) materials.value.splice(i, 1);
}

/* ---------- 成衣尺寸 ---------- */
function addPart() {
  let name = '新部位';
  let i = 2;
  while (sizeParts.value.includes(name)) name = '新部位' + i++;
  sizeParts.value.push(name);
  sizeCols.value.forEach((s) => (cells.value[cellKey(name, s)] = ''));
}
function delPart(pi) {
  const p = sizeParts.value[pi];
  sizeParts.value.splice(pi, 1);
  Object.keys(cells.value).forEach((k) => { if (k.startsWith(p + '||')) delete cells.value[k]; });
}
function addSizeCol() {
  let name = '新码';
  let i = 2;
  while (sizeCols.value.includes(name)) name = '新码' + i++;
  sizeCols.value.push(name);
  sizeParts.value.forEach((p) => (cells.value[cellKey(p, name)] = ''));
}
function delSizeCol(si) {
  const s = sizeCols.value[si];
  sizeCols.value.splice(si, 1);
  Object.keys(cells.value).forEach((k) => { if (k.endsWith('||' + s)) delete cells.value[k]; });
}
/** 部位改名：把该行已填的尺寸搬到新键上，避免数据丢失 */
function renamePart(pi, name) {
  const old = sizeParts.value[pi];
  const val = String(name || '').trim();
  if (!val || val === old) return;
  sizeCols.value.forEach((s) => {
    const v = cells.value[cellKey(old, s)];
    delete cells.value[cellKey(old, s)];
    cells.value[cellKey(val, s)] = v || '';
  });
  sizeParts.value[pi] = val;
}
/** 尺码列改名：同理搬数据 */
function renameSizeCol(si, name) {
  const old = sizeCols.value[si];
  const val = String(name || '').trim();
  if (!val || val === old) return;
  sizeParts.value.forEach((p) => {
    const v = cells.value[cellKey(p, old)];
    delete cells.value[cellKey(p, old)];
    cells.value[cellKey(p, val)] = v || '';
  });
  sizeCols.value[si] = val;
}

async function pullSizes() {
  if (!tp.value) return;
  if (sizeRows.value.some((r) => r.value)) {
    if (!confirm('已有尺寸数据，从订单带出会清空现填的内容，确认继续？')) return;
  }
  try {
    const data = await api.techpackSizesFromOrder(tp.value.id, { overwrite: true });
    tp.value = data;
    buildGrid(data.sizes || []);
    if (data.size_range) head.value.size_range = data.size_range;
  } catch (e) { alert(e.message); }
}

/* ---------- 生产要求 ---------- */
function addReq(cat) {
  requirements.value.push({ category: cat, content: '' });
}
function delReq(r) {
  const i = requirements.value.indexOf(r);
  if (i >= 0) requirements.value.splice(i, 1);
}

/* ---------- 保存 ---------- */
async function save() {
  if (!tp.value) return;
  saving.value = true;
  try {
    const payload = {
      ...head.value,
      image_url: tp.value.image_url || '',
      materials: materials.value.map((m) => ({ ...m })),
      requirements: requirements.value.filter((r) => r.content && r.content.trim()),
      sizes: sizeRows.value
        .filter((r) => r.part && r.size)
        .map((r) => ({ part: r.part, size: r.size, value: r.value }))
    };
    const data = await api.saveTechpackDetail(tp.value.id, payload);
    tp.value = data;
    const h = {};
    HEAD_KEYS.forEach((k) => (h[k] = data[k] || ''));
    head.value = h;
    materials.value = (data.materials || []).map((m) => ({ ...m }));
    requirements.value = (data.requirements || []).map((r) => ({ ...r }));
    buildGrid(data.sizes || []);
    emit('saved', data);
    alert('已保存');
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

function print() {
  if (!tp.value) return;
  window.open('/print/techpack/' + tp.value.id, '_blank');
}

/** 已确认的开发单不可改：复制成新版本草稿再改 */
async function newVersion() {
  if (!tp.value) return;
  if (!confirm('将以当前内容新建一个版本（草稿），原版本保留可追溯。继续？')) return;
  saving.value = true;
  try {
    const data = await api.newTechpackVersion(tp.value.id);
    emit('version-created', data.id);
    emit('saved', data);
  } catch (e) { alert(e.message); } finally { saving.value = false; }
}

function close() {
  open.value = false;
  tp.value = null;
  emit('close');
}

watch(() => props.techpackId, (id) => {
  if (id) { open.value = true; load(id); }
  else { open.value = false; tp.value = null; }
}, { immediate: true });

defineExpose({ reload: () => tp.value && load(tp.value.id) });
</script>

<style scoped>
/* 确认前缺口提示条：橙色，放在明细最上面，一眼能看到"还差什么" */
.tp-gate {
  margin: 0 0 12px; padding: 9px 12px; border: 1px solid #ffe1b8; background: #fffbf3;
  border-radius: 8px; font-size: 12.5px; color: #8a5a10;
}
.tp-gate .g-head { font-weight: 600; color: #d46b08; }
.tp-gate .g-sub { font-weight: 400; color: #a8763a; font-size: 11.5px; }
.tp-gate ul { margin: 6px 0 0; padding-left: 18px; }
.tp-gate li { line-height: 1.7; }
.tp-gate .g-label { font-weight: 600; }
.tp-gate .g-detail { color: #7a4a08; }
.tp-gate .g-where { color: #a8763a; font-size: 11.5px; margin-left: 4px; }
.modal.xwide.tp-modal { width: 1420px; max-width: 96vw; }
.tp-loading { padding: 40px; text-align: center; color: #8a94a6; }

/* 头部 */
.tp-head { display: flex; gap: 14px; padding-bottom: 12px; border-bottom: 1px solid #eef2f7; }
.tp-img {
  position: relative; width: 96px; height: 118px; flex: none; border: 1px solid #eef2f7;
  border-radius: 8px; background: #f7f9fc; display: flex; align-items: center; justify-content: center;
  font-size: 30px; overflow: hidden;
}
.tp-img img { width: 100%; height: 100%; object-fit: cover; }
.tp-img-btn {
  position: absolute; bottom: 0; left: 0; right: 0; text-align: center; font-size: 11px;
  background: rgba(22, 35, 59, 0.72); color: #fff; padding: 3px 0; cursor: pointer;
}
.tp-info { flex: 1; display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px 12px; }
.tp-cell { min-width: 0; }
.tp-cell label { display: block; font-size: 11.5px; color: #8a94a6; margin-bottom: 2px; }
.tp-cell .v { font-size: 13px; color: #16233b; padding: 5px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-cell .input { width: 100%; padding: 5px 8px; font-size: 12.5px; }

/* 页签 */
.tp-tabs { margin: 12px 0 10px; }
.tp-tabs .cnt {
  display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 8px;
  background: #eef2f7; color: #5b6474; font-size: 10.5px; line-height: 15px;
}

.tp-h4 { margin: 14px 0 6px; font-size: 13px; color: #16233b; }
.tp-ta { width: 100%; padding: 8px 10px; border: 1px solid #dce3ee; border-radius: 8px; font-size: 12.5px; line-height: 1.6; resize: vertical; }
.tp-tip { font-size: 11.5px; color: #8a94a6; margin-top: 8px; }

.tp-steps { display: flex; gap: 6px; flex-wrap: wrap; }
.tp-step {
  display: flex; align-items: center; gap: 5px; font-size: 12px; color: #98a2b3;
  border: 1px solid #eef2f7; border-radius: 20px; padding: 4px 10px 4px 4px;
}
.tp-step .dot {
  width: 17px; height: 17px; border-radius: 50%; background: #eef2f7; color: #98a2b3;
  display: flex; align-items: center; justify-content: center; font-size: 10.5px;
}
.tp-step.on { color: #16233b; border-color: #cfe0ff; background: #f5f9ff; }
.tp-step.on .dot { background: #2b6de5; color: #fff; }
.tp-step.cur { border-color: #2b6de5; }

/* 工具条 */
.tp-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.tp-hint { font-size: 11.5px; color: #8a94a6; }

/* 横向滚动容器 */
.tp-scroll { overflow-x: auto; border: 1px solid #eef2f7; border-radius: 8px; }

/* 面辅料表 */
.tp-mat { border: none; min-width: 1540px; }
.tp-mat th, .tp-mat td { white-space: nowrap; padding: 5px 6px; font-size: 12px; vertical-align: middle; }
.tp-mat .input.mini, .tp-mat .select.mini { width: 100%; min-width: 0; padding: 4px 6px; font-size: 12px; }
.tp-mat td.num { text-align: right; font-weight: 600; color: #16233b; }
.tp-mat .thumb {
  width: 34px; height: 34px; border: 1px dashed #d6dfeb; border-radius: 6px; overflow: hidden;
  display: flex; align-items: center; justify-content: center; cursor: pointer; background: #fbfcfe;
}
.tp-mat .thumb img { width: 100%; height: 100%; object-fit: cover; }
.tp-mat .ph { font-size: 14px; color: #a9b4c5; }

/* 档案来源行：档案字段只读，浅底 + 锁标区分，避免误以为可以改 */
.tp-mat tr.from-arc td { background: #fbfcfe; }
.tp-mat .locked { font-size: 12px; color: #33415a; line-height: 1.35; max-width: 190px; }
.tp-mat .locked.center { text-align: center; }
.tp-mat .locked .sub {
  font-size: 11px; color: #8a94a6; max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tp-mat .lock { font-size: 9px; margin-right: 3px; opacity: 0.5; }
.tp-mat .mt2 { margin-top: 3px; }
.tp-legend { margin-left: 10px; font-size: 11.5px; color: #a0aab9; }
.tp-sum { margin-top: 8px; font-size: 12.5px; color: #5b6474; }

/* 尺寸表 */
.tp-size { border: none; }
.tp-size th:first-child, .tp-size td:first-child { width: 150px; max-width: 150px; }
.tp-size th, .tp-size td { padding: 4px 6px; font-size: 12px; white-space: nowrap; }
.tp-size .input.mini { width: 100%; padding: 4px 6px; font-size: 12px; }
.tp-size .center { text-align: center; }
.tp-size .col-head { display: flex; align-items: center; gap: 2px; }
.tp-size .x-mini { border: none; background: none; color: #c2ccdb; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
.tp-size .x-mini:hover { color: #d92d45; }

/* 生产要求 */
.req-group { border: 1px solid #eef2f7; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.req-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 12.5px; color: #16233b; }
.req-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.req-no { width: 18px; font-size: 11.5px; color: #98a2b3; }
.req-empty { font-size: 12px; color: #c2ccdb; }

/* 底部 */
.tp-foot { align-items: center; }
.tp-lock { margin-right: auto; font-size: 12px; color: #b26a00; }

@media (max-width: 900px) {
  .tp-info { grid-template-columns: repeat(2, 1fr); }
  .tp-head { flex-direction: column; }
  .tp-img { width: 100%; height: 140px; }
  .tp-lock { display: none; }
}
</style>
