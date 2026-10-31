<template>
  <div>
    <div class="page-head">
      <div>
        <h2>产品管理</h2>
        <div class="sub">款号、主图、颜色（一款多色）、尺码、单价</div>
      </div>
      <button v-if="canWrite" class="btn btn-primary" @click="openCreate">＋ 新增产品</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <input class="input" v-model="q" placeholder="搜索名称 / 款号 / 品类 / 颜色" @keyup.enter="load" style="width: 260px" />
      <select class="select" v-model="status" @change="load">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <button class="btn btn-ghost" @click="load">查询</button>
      <CsvImport v-if="canWrite" kind="products" @done="load" />
    </div>

    <div class="table-wrap">
      <table class="data prod-table">
        <thead>
          <tr>
            <th style="width: 56px">图片</th>
            <th style="width: 110px">款号</th>
            <th>产品名称 / 品类</th>
            <th style="width: 150px">颜色</th>
            <th style="width: 120px">尺码</th>
            <th style="width: 86px">单价</th>
            <th style="width: 72px">阶梯价</th>
            <th style="width: 68px">状态</th>
            <th v-if="canWrite" style="width: 132px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in list" :key="p.id">
            <td>
              <img v-if="p.image_url" class="thumb" :src="p.image_url" :alt="p.name" @click="openImage(p.image_url, p.name)" />
              <span v-else class="thumb ph">无图</span>
            </td>
            <td>{{ p.sku || '-' }}</td>
            <td>
              <strong>{{ p.name }}</strong>
              <div class="sub-line">
                <span v-if="p.category">{{ p.category }}</span>
                <span v-if="p.unit"> / {{ p.unit }}</span>
              </div>
            </td>
            <td>
              <template v-if="p.colors && p.colors.length">
                <span
                  v-for="c in p.colors"
                  :key="c.id"
                  class="chip"
                  :class="{ clickable: !!c.image_url, pic: !!c.image_url }"
                  :title="c.image_url ? `${c.name}（点开看图）` : c.name"
                  @click="c.image_url && openImage(c.image_url, c.name)"
                >{{ c.name }}</span>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <template v-if="p.sizes && p.sizes.length">
                <span v-for="s in p.sizes" :key="s.id" class="chip size">{{ s.size }}</span>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td>¥{{ Number(p.price || 0).toLocaleString() }}</td>
            <td>
              <span v-if="tierCount(p.id)" class="tag green">{{ tierCount(p.id) }} 档</span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span class="tag" :class="p.status === 'active' ? 'green' : 'gray'">
                {{ p.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
            <td v-if="canWrite">
              <button class="link-btn" @click="openTiers(p)">阶梯价</button>
              <button class="link-btn" @click="openEdit(p)">编辑</button>
              <button v-if="p.status === 'active'" class="link-btn danger" @click="disable(p)">停用</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td :colspan="canWrite ? 9 : 8" class="empty-cell">暂无产品</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-mask" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑产品' : '新增产品' }}</h3>
          <button class="x" @click="showModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="fitem"><label>产品名称 *</label><input class="input" v-model="form.name" /></div>
            <div class="fitem"><label>款号 SKU</label><input class="input" v-model="form.sku" placeholder="唯一" /></div>
            <div class="fitem"><label>品类</label><input class="input" v-model="form.category" /></div>
            <div class="fitem"><label>单位</label><input class="input" v-model="form.unit" /></div>
            <div class="fitem"><label>单价</label><input class="input" type="number" v-model.number="form.price" /></div>
            <div class="fitem">
              <label>状态</label>
              <select class="select" v-model="form.status">
                <option value="active">启用</option><option value="disabled">停用</option>
              </select>
            </div>
            <div class="fitem full">
              <label>产品主图</label>
              <div class="img-row">
                <ImageUpload v-model="form.image_url" size="lg" title="产品主图" />
                <div class="img-tip muted">
                  单击选中后 <b>Ctrl+V</b> 可直接粘贴截图；双击或右上角箭头选文件。<br />
                  主图用于产品列表与报价单；每个颜色还能单独配图。
                </div>
              </div>
            </div>

            <div class="fitem full">
              <label>颜色 / 花型（一款多色，可逐色配图）</label>
              <div class="color-list">
                <div v-for="(c, i) in form.colors" :key="i" class="color-row">
                  <ImageUpload v-model="c.image_url" size="sm" :title="c.name || '颜色图'" />
                  <input class="input" v-model="c.name" :placeholder="`印花00${i + 1}`" maxlength="40" />
                  <button class="link-btn danger" @click="form.colors.splice(i, 1)">删除</button>
                </div>
                <button class="btn btn-ghost btn-sm" @click="addColor">＋ 添加颜色</button>
                <span class="muted tiny" v-if="form.colors.length">共 {{ form.colors.length }} 个颜色</span>
              </div>
            </div>

            <div class="fitem full">
              <label>尺码</label>
              <div class="size-chips">
                <span v-for="(s, i) in form.sizes" :key="s + i" class="chip size">
                  {{ s }}<b class="x" @click="form.sizes.splice(i, 1)">×</b>
                </span>
                <span v-if="!form.sizes.length" class="muted tiny">还没加尺码</span>
              </div>
              <div class="size-add">
                <input
                  class="input"
                  v-model="sizeText"
                  placeholder="输入尺码后回车，可用逗号/空格分隔多个（如 S,M,L 或 3T 4T 5T）"
                  @keyup.enter="addSizes"
                />
                <button class="btn btn-ghost btn-sm" @click="addSizes">添加</button>
              </div>
              <div class="quick-sizes">
                <span class="muted tiny">常用：</span>
                <button v-for="s in QUICK_SIZES" :key="s" class="qsize" @click="addSize(s)">{{ s }}</button>
              </div>
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

    <!-- 阶梯价 -->
    <div v-if="tierModal" class="modal-mask" @click.self="tierModal = false">
      <div class="modal">
        <div class="modal-head">
          <h3>阶梯价 · {{ tierProduct.name }}</h3>
          <button class="x" @click="tierModal = false">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="margin: 0 0 12px; font-size: 12px">
            按订单数量匹配单价（美金）。起始数量升序填写；区间结束数量留空表示「以上」。报价单与下单时会自动取匹配到的价格。
          </p>
          <table class="data">
            <thead>
              <tr><th style="width: 130px">起始数量 ≥</th><th style="width: 130px">结束数量 ≤</th><th style="width: 130px">单价 USD</th><th style="width: 60px"></th></tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in tierRows" :key="i">
                <td><input class="input" type="number" min="1" v-model.number="t.min_qty" /></td>
                <td><input class="input" type="number" min="0" v-model.number="t.max_qty" placeholder="不限" /></td>
                <td><input class="input" type="number" step="0.01" v-model.number="t.price_usd" /></td>
                <td><button class="link-btn danger" @click="tierRows.splice(i, 1)">删除</button></td>
              </tr>
              <tr v-if="!tierRows.length">
                <td colspan="4" class="empty-cell">还没有阶梯，点下方「添加一档」</td>
              </tr>
            </tbody>
          </table>
          <button class="btn btn-ghost btn-sm" style="margin-top: 10px" @click="addTierRow">＋ 添加一档</button>
          <p v-if="tierMsg" class="form-msg" :class="tierErr ? 'err' : 'ok'">{{ tierMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="tierModal = false">关闭</button>
          <button class="btn btn-primary" :disabled="tierSaving" @click="saveTiers">{{ tierSaving ? '保存中…' : '保存阶梯价' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';
import { openImage } from '../store/viewer';
import CsvImport from '../components/CsvImport.vue';
import ImageUpload from '../components/ImageUpload.vue';

const list = ref([]);
const q = ref('');
const status = ref('');
const canWrite = computed(() => can('product.write'));

const showModal = ref(false);
const saving = ref(false);
const blank = () => ({
  id: null,
  sku: '',
  name: '',
  category: '',
  unit: '件',
  price: 0,
  status: 'active',
  remark: '',
  image_url: '',
  colors: [],
  sizes: []
});
const form = ref(blank());
const sizeText = ref('');
const QUICK_SIZES = ['S', 'M', 'L', 'XL', 'XXL', '均码', '2T', '3T', '4T'];

/** 颜色行：名称 + 自己的图（印花不同图不同） */
function addColor() {
  form.value.colors.push({ name: '', image_url: '' });
}
function addSize(s) {
  const v = String(s || '').trim();
  if (!v) return;
  // 前端也去重：重复添加不报错，只是不加第二遍（和接口口径一致）
  if (form.value.sizes.some((x) => x.toUpperCase() === v.toUpperCase())) return;
  form.value.sizes.push(v);
}
function addSizes() {
  const parts = sizeText.value.split(/[,，\s、;；]+/).filter(Boolean);
  parts.forEach(addSize);
  sizeText.value = '';
}

async function load() {
  try {
    list.value = await api.products({ q: q.value, status: status.value });
  } catch (e) {
    alert(e.message);
  }
}
function openCreate() {
  form.value = blank();
  sizeText.value = '';
  showModal.value = true;
}
function openEdit(p) {
  form.value = {
    ...p,
    image_url: p.image_url || '',
    colors: (p.colors || []).map((c) => ({ name: c.name, image_url: c.image_url || '' })),
    sizes: (p.sizes || []).map((s) => s.size)
  };
  sizeText.value = '';
  showModal.value = true;
}
async function save() {
  if (!form.value.name) return alert('产品名称必填');
  // 只提交"填了名字或者有图"的颜色行：空行是点了「添加颜色」还没填，不该变成校验错误
  const colors = form.value.colors
    .filter((c) => String(c.name || '').trim() || String(c.image_url || '').trim())
    .map((c) => ({ name: String(c.name || '').trim(), image_url: c.image_url || '' }));
  const noName = colors.find((c) => !c.name);
  if (noName) return alert('有个颜色只传了图没填名称：请补上名称（如 印花001）');
  saving.value = true;
  try {
    const body = { ...form.value, colors, sizes: form.value.sizes };
    if (form.value.id) await api.updateProduct(form.value.id, body);
    else await api.createProduct(body);
    showModal.value = false;
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}
async function disable(p) {
  if (!confirm(`确定停用产品「${p.name}」？`)) return;
  try {
    await api.deleteProduct(p.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

// ---------- 阶梯价 ----------
const allTiers = ref([]);
const tierModal = ref(false);
const tierProduct = ref({ id: 0, name: '' });
const tierRows = ref([]);
const tierSaving = ref(false);
const tierMsg = ref('');
const tierErr = ref(false);

function tierCount(pid) {
  return allTiers.value.filter((t) => t.product_id === pid).length;
}

async function loadTiers() {
  try {
    allTiers.value = await api.priceTiers();
  } catch (e) {
    allTiers.value = [];
  }
}

async function openTiers(p) {
  tierProduct.value = { id: p.id, name: p.name };
  tierMsg.value = '';
  tierErr.value = false;
  try {
    const rows = await api.priceTiers(p.id);
    tierRows.value = rows.map((t) => ({ min_qty: t.min_qty, max_qty: t.max_qty || 0, price_usd: t.price_usd }));
  } catch (e) {
    tierRows.value = [];
  }
  if (!tierRows.value.length) {
    tierRows.value = [
      { min_qty: 1, max_qty: 99, price_usd: Number(p.price) || 0 },
      { min_qty: 100, max_qty: 499, price_usd: 0 },
      { min_qty: 500, max_qty: 0, price_usd: 0 }
    ];
  }
  tierModal.value = true;
}

function addTierRow() {
  const last = tierRows.value[tierRows.value.length - 1];
  const nextMin = last ? (Number(last.max_qty) || Number(last.min_qty) || 0) + 1 : 1;
  tierRows.value.push({ min_qty: nextMin, max_qty: 0, price_usd: 0 });
}

async function saveTiers() {
  tierSaving.value = true;
  tierMsg.value = '';
  tierErr.value = false;
  try {
    const rows = tierRows.value
      .filter((t) => Number(t.min_qty) >= 1)
      .map((t) => ({
        min_qty: Number(t.min_qty),
        max_qty: Number(t.max_qty) > 0 ? Number(t.max_qty) : null,
        price_usd: Number(t.price_usd) || 0
      }));
    await api.savePriceTiers(tierProduct.value.id, rows);
    tierMsg.value = `已保存 ${rows.length} 档阶梯价`;
    await loadTiers();
  } catch (e) {
    tierErr.value = true;
    tierMsg.value = e.message;
  } finally {
    tierSaving.value = false;
  }
}

onMounted(() => {
  load();
  loadTiers();
});
</script>

<style scoped>
/* 列表里的图片位：固定 40px，避免高矮不一把行撑歪 */
.thumb {
  width: 40px; height: 40px; border-radius: 6px; object-fit: cover;
  border: 1px solid #e2e8f0; display: block; cursor: zoom-in; background: #f7f9fc;
}
.thumb.ph {
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: #a9b4c5; cursor: default; border-style: dashed;
}
.sub-line { font-size: 11.5px; color: #8a94a6; margin-top: 2px; }
.tiny { font-size: 11.5px; }

/* 颜色 / 尺码小标签 */
.chip {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 7px; margin: 0 4px 4px 0; border-radius: 10px;
  background: #eef3fb; color: #2b4a7d; font-size: 11.5px; line-height: 18px;
  border: 1px solid #dbe6f7; white-space: nowrap;
}
.chip.clickable { cursor: zoom-in; }
.chip.pic::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%; background: #2b6de5; display: inline-block;
}
.chip.size { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
.chip .x {
  cursor: pointer; color: #94a3b8; font-weight: 400; margin-left: 2px;
}
.chip .x:hover { color: #dc2626; }

/* 主图位 */
.img-row { display: flex; gap: 12px; align-items: flex-start; }
.img-tip { font-size: 12px; line-height: 1.7; max-width: 330px; }

/* 颜色行：图 + 名称 + 删除 */
.color-list { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.color-row { display: flex; gap: 8px; align-items: center; width: 100%; }
.color-row .input { flex: 1; min-width: 0; max-width: 320px; }

/* 尺码 */
.size-chips { margin-bottom: 8px; }
.size-add { display: flex; gap: 8px; }
.size-add .input { flex: 1; }
.quick-sizes { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.qsize {
  border: 1px solid #dbe6f7; background: #f7faff; color: #2b4a7d;
  border-radius: 10px; padding: 1px 9px; font-size: 11.5px; cursor: pointer;
}
.qsize:hover { border-color: #2b6de5; color: #2b6de5; }
</style>
