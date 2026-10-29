<template>
  <div>
    <div class="page-head">
      <div>
        <h2>工序流程配置</h2>
        <div class="sub">
          订单跟踪看板上那一排节点就是这里配的。改名、调顺序、加自定义节点都不影响已下单的订单。
        </div>
      </div>
      <div style="display: flex; gap: 8px">
        <button v-if="canWrite" class="btn btn-ghost" @click="openTplNew">＋ 新建流程</button>
        <button class="btn btn-ghost" @click="$router.push('/order-tracking')">去订单跟踪</button>
      </div>
    </div>

    <div class="nf-layout">
      <!-- 左：流程列表 -->
      <div class="nf-side">
        <div class="nf-side-head">流程（{{ templates.length }}）</div>
        <div v-for="t in templates" :key="t.id" class="nf-tpl" :class="{ on: cur && cur.id === t.id }" @click="select(t.id)">
          <div class="nf-tpl-name">
            {{ t.name }}
            <span v-if="t.is_default" class="tag blue" style="font-size: 10px">默认</span>
          </div>
          <div class="nf-tpl-meta">
            {{ t.item_count }} 个节点<template v-if="t.off_count"> · 停用 {{ t.off_count }}</template>
            · {{ t.order_count }} 单在用
          </div>
        </div>
        <div v-if="!templates.length" class="nf-empty">还没有流程</div>
      </div>

      <!-- 右：节点清单 -->
      <div class="nf-main">
        <div v-if="!cur" class="empty-cell">选左边一个流程</div>
        <template v-else>
          <div class="nf-head">
            <div>
              <h3>{{ cur.name }}</h3>
              <div class="tiny muted">{{ cur.note || '—' }}</div>
            </div>
            <div style="display: flex; gap: 8px">
              <button v-if="canWrite && !cur.is_default" class="btn btn-ghost btn-sm" @click="makeDefault">设为默认</button>
              <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openTplEdit">改名称/备注</button>
              <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="openApply">应用到已有订单</button>
              <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openItemNew">＋ 新增节点</button>
            </div>
          </div>

          <div class="nf-tip">
            <b>改名随便改</b> —— 系统里「裁床单完成 → 标记裁剪节点」「首件确认 → 回写车缝节点」这些联动
            认的是节点的 <code>code</code>（{{ '`cut` / `sew`' }}），不是名字。
            所以你把「裁剪」改成「裁床」「开裁」，联动照样生效。
            <span v-if="cur.is_default" style="display: block; margin-top: 4px">
              这是默认流程：新订单没有指定流程时用它。
            </span>
          </div>

          <table class="data">
            <thead>
              <tr>
                <th style="width: 46px">顺序</th>
                <th>节点名称</th>
                <th style="width: 90px">code</th>
                <th style="width: 72px">必经</th>
                <th style="width: 96px">负责人</th>
                <th style="width: 74px">状态</th>
                <th style="width: 190px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in cur.items" :key="it.id" :class="{ 'nf-off': it.status === 'off' }">
                <td class="muted">{{ it.seq }}</td>
                <td>
                  <input v-if="editId === it.id" class="input" v-model="editName" style="width: 180px"
                    @keyup.enter="saveName(it)" @keyup.esc="editId = null" />
                  <template v-else>
                    <b>{{ it.name }}</b>
                    <span v-if="it.builtin" class="nf-bi">内置</span>
                  </template>
                </td>
                <td><code class="nf-code">{{ it.code }}</code></td>
                <td>
                  <button class="nf-req-tgl" :class="{ opt: !it.required }" :disabled="!canWrite"
                    title="点一下切换必经 / 可选（可选才能标「不适用」）"
                    @click="toggleReq(it)">{{ it.required ? '必经' : '可选' }}</button>
                </td>
                <td class="tiny">{{ roleLabel(it.role) }}</td>
                <td>
                  <span v-if="it.status === 'off'" class="tag red" style="font-size: 10px">已停用</span>
                  <span v-else class="tag green" style="font-size: 10px">启用</span>
                </td>
                <td>
                  <button v-if="canWrite && editId !== it.id" class="link-btn" @click="startEdit(it)">改名</button>
                  <button v-if="canWrite && i > 0" class="link-btn" title="上移" @click="move(i, -1)">▲</button>
                  <button v-if="canWrite && i < cur.items.length - 1" class="link-btn" title="下移" @click="move(i, 1)">▼</button>
                  <button v-if="canWrite" class="link-btn" :class="{ danger: it.status !== 'off' }"
                    :disabled="it.builtin" :title="it.builtin ? '内置节点不能停用（裁床单/首件确认要回写到它）' : ''"
                    @click="toggleStatus(it)">
                    {{ it.status === 'off' ? '启用' : '停用' }}
                  </button>
                </td>
              </tr>
              <tr v-if="!cur.items.length">
                <td colspan="7" class="empty-cell">这个流程还没有节点</td>
              </tr>
            </tbody>
          </table>

          <div class="nf-foot-note">
            <b>停用 ≠ 删除</b>：停用只影响新订单（不再带这个节点）。已下单的订单里那条记录原样保留 ——
            它代表「这张单确实走过这一步」，删了之后「这单做过什么」就缺一块。
          </div>
        </template>
      </div>
    </div>

    <!-- 新建 / 改流程 -->
    <div v-if="tplDlg.open" class="modal-mask" @click.self="tplDlg.open = false">
      <div class="modal" style="width: 460px">
        <div class="modal-head">
          <h3>{{ tplDlg.id ? '改流程' : '新建流程' }}</h3>
          <button class="x" @click="tplDlg.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fitem" style="margin-bottom: 12px">
            <label>流程名称 *</label>
            <input class="input" v-model="tplDlg.name" placeholder="如：梭织标准工序 / 现货快反流程 / 外协单" />
          </div>
          <div class="fitem">
            <label>说明</label>
            <textarea class="input" rows="2" v-model="tplDlg.note" placeholder="这套流程用在什么类型的单上"></textarea>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="tplDlg.open = false">取消</button>
          <button class="btn btn-primary" :disabled="tplDlg.saving" @click="saveTpl">保存</button>
        </div>
      </div>
    </div>

    <!-- 新增节点 -->
    <div v-if="itemDlg.open" class="modal-mask" @click.self="itemDlg.open = false">
      <div class="modal" style="width: 460px">
        <div class="modal-head">
          <h3>新增节点</h3>
          <button class="x" @click="itemDlg.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="fitem" style="margin-bottom: 12px">
            <label>节点名称 *</label>
            <input class="input" v-model="itemDlg.name" placeholder="如：票菲工艺单打印 / 领料 / 辅料配送 / 尾部" />
            <div class="tiny muted" style="margin-top: 4px">最多 20 字（看板一列放不下更长的）</div>
          </div>
          <div class="fitem" style="margin-bottom: 12px">
            <label>负责人</label>
            <select class="select" v-model="itemDlg.role">
              <option value="production">生产车间</option>
              <option value="warehouse">仓库</option>
              <option value="qc">质检</option>
              <option value="outsource">外协厂</option>
            </select>
          </div>
          <label class="nf-check">
            <input type="checkbox" v-model="itemDlg.required" />
            必经节点（不许标「不适用」；不勾则用不上时可以标不适用并写原因）
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="itemDlg.open = false">取消</button>
          <button class="btn btn-primary" :disabled="itemDlg.saving" @click="saveItem">添加</button>
        </div>
      </div>
    </div>

    <!-- 应用到已有订单：先看影响面 -->
    <div v-if="applyDlg.open" class="modal-mask" @click.self="applyDlg.open = false">
      <div class="modal" style="width: 640px">
        <div class="modal-head">
          <h3>应用到已有订单 · {{ cur ? cur.name : '' }}</h3>
          <button class="x" @click="applyDlg.open = false">×</button>
        </div>
        <div class="modal-body">
          <div class="nf-tip">
            只<b>追加</b>这些订单缺少的节点，<b>不删、不改名</b>。
            删会丢掉「这张单走过这一步」的记录；改名会让三个月后没人能证明当时它叫什么。
            <div style="margin-top: 5px">
              只补<b>在产（已分单 / 生产中 / 已入库）</b>的订单 ——
              给一张已结案的单补 13 个「待开始」节点，它在看板上就会从「已结案」变成「一步未动」，
              补数据反而把历史搞脏了。
            </div>
          </div>
          <div v-if="applyDlg.loading" class="mut" style="padding: 20px 0">正在核对影响面…</div>
          <template v-else-if="applyDlg.plan">
            <div v-if="applyDlg.plan.skipped_by_status" class="tiny muted" style="margin-bottom: 8px">
              已跳过 {{ applyDlg.plan.skipped_by_status }} 张非在产订单（草稿 / 已发货 / 已结案 / 已取消）。
            </div>
            <div v-if="!applyDlg.plan.total_orders" class="ok-box">
              在产订单都已经有这套节点了，不需要补。
            </div>
            <template v-else>
              <div class="warn-box">
                会给 <b>{{ applyDlg.plan.total_orders }}</b> 张订单补 <b>{{ applyDlg.plan.total_rows }}</b> 个节点：
              </div>
              <div class="ap-list">
                <div v-for="o in applyDlg.plan.orders" :key="o.order_id" class="ap-row">
                  <span class="mono">{{ o.order_no }}</span>
                  <span class="tag gray" style="font-size: 10px">{{ statusLabel(o.status) }}</span>
                  <span class="ap-add">+ {{ o.add.map(a => a.name).join('、') }}</span>
                </div>
              </div>
            </template>
          </template>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="applyDlg.open = false">关闭</button>
          <button class="btn btn-primary" :disabled="applyDlg.saving || !applyDlg.plan || !applyDlg.plan.total_orders"
            @click="doApply">
            {{ applyDlg.saving ? '写入中…' : '确认补 ' + (applyDlg.plan ? applyDlg.plan.total_rows : 0) + ' 个节点' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter();
const canWrite = can('node.flow');

const templates = ref([]);
const cur = ref(null);

function roleLabel(r) {
  return { production: '生产车间', warehouse: '仓库', qc: '质检', outsource: '外协厂' }[r] || r || '—';
}
function statusLabel(s) {
  return {
    draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
    instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
  }[s] || s;
}

async function loadList() {
  templates.value = await api.nodeFlowTemplates();
}

async function select(id) {
  cur.value = await api.nodeFlowTemplate(id);
  editId.value = null;
}

async function reload() {
  await loadList();
  if (cur.value) await select(cur.value.id);
}

/* ---------------- 改名 ---------------- */
const editId = ref(null);
const editName = ref('');
function startEdit(it) { editId.value = it.id; editName.value = it.name; }
async function saveName(it) {
  const name = editName.value.trim();
  if (!name) return;
  try {
    await api.updateNodeFlowItem(it.id, { name });
    editId.value = null;
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 必经 / 可选 ---------------- */
async function toggleReq(it) {
  try {
    await api.updateNodeFlowItem(it.id, { required: it.required ? 0 : 1 });
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 停用 / 启用 ---------------- */
async function toggleStatus(it) {
  try {
    await api.setNodeFlowItemStatus(it.id, it.status === 'off' ? 'active' : 'off');
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 排序 ---------------- */
async function move(i, dir) {
  const items = cur.value.items.slice();
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  const tmp = items[i];
  items[i] = items[j];
  items[j] = tmp;
  try {
    await api.reorderNodeFlow(cur.value.id, items.map((x) => x.id));
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 流程本体 ---------------- */
const tplDlg = reactive({ open: false, id: null, name: '', note: '', saving: false });
function openTplNew() {
  Object.assign(tplDlg, { open: true, id: null, name: '', note: '', saving: false });
}
function openTplEdit() {
  Object.assign(tplDlg, { open: true, id: cur.value.id, name: cur.value.name, note: cur.value.note || '', saving: false });
}
async function saveTpl() {
  if (!tplDlg.name.trim()) { alert('流程名称必填'); return; }
  tplDlg.saving = true;
  try {
    const r = await api.saveNodeFlowTemplate({ id: tplDlg.id, name: tplDlg.name.trim(), note: tplDlg.note });
    tplDlg.open = false;
    await loadList();
    await select(r.id);
  } catch (e) { alert(e.message); } finally { tplDlg.saving = false; }
}
async function makeDefault() {
  try {
    await api.setDefaultNodeFlow(cur.value.id);
    await reload();
  } catch (e) { alert(e.message); }
}

/* ---------------- 新增节点 ---------------- */
const itemDlg = reactive({ open: false, name: '', role: 'production', required: true, saving: false });
function openItemNew() {
  Object.assign(itemDlg, { open: true, name: '', role: 'production', required: true, saving: false });
}
async function saveItem() {
  if (!itemDlg.name.trim()) { alert('节点名称必填'); return; }
  itemDlg.saving = true;
  try {
    await api.addNodeFlowItem(cur.value.id, {
      name: itemDlg.name.trim(), role: itemDlg.role, required: itemDlg.required ? 1 : 0
    });
    itemDlg.open = false;
    await reload();
  } catch (e) { alert(e.message); } finally { itemDlg.saving = false; }
}

/* ---------------- 应用到已有订单 ---------------- */
const applyDlg = reactive({ open: false, loading: false, saving: false, plan: null });
async function openApply() {
  Object.assign(applyDlg, { open: true, loading: true, saving: false, plan: null });
  try {
    applyDlg.plan = await api.applyNodeFlow(cur.value.id, { dry_run: true });
  } catch (e) { alert(e.message); applyDlg.open = false; } finally { applyDlg.loading = false; }
}
async function doApply() {
  applyDlg.saving = true;
  try {
    const r = await api.applyNodeFlow(cur.value.id, { dry_run: false });
    applyDlg.open = false;
    alert(`已给 ${r.total_orders} 张订单补了 ${r.total_rows} 个节点`);
    await reload();
  } catch (e) { alert(e.message); } finally { applyDlg.saving = false; }
}

onMounted(async () => {
  await loadList();
  if (templates.value.length) await select(templates.value[0].id);
});
void router;
</script>

<style scoped>
.nf-layout { display: flex; gap: 14px; align-items: flex-start; }
.nf-side {
  width: 230px; flex: none; background: #fff; border: 1px solid #eef2f7;
  border-radius: 10px; overflow: hidden;
}
.nf-side-head {
  padding: 10px 12px; font-size: 12px; font-weight: 700; color: #5b6b80;
  background: #f7f9fd; border-bottom: 1px solid #eef2f7;
}
.nf-tpl { padding: 10px 12px; border-bottom: 1px solid #f4f7fb; cursor: pointer; }
.nf-tpl:hover { background: #f9fbfe; }
.nf-tpl.on { background: #eef4ff; border-left: 3px solid #2563eb; padding-left: 9px; }
.nf-tpl-name { font-size: 13px; color: #16233b; font-weight: 700; display: flex; align-items: center; gap: 5px; }
.nf-tpl-meta { font-size: 11px; color: #8a94a6; margin-top: 3px; }
.nf-empty { padding: 20px 12px; font-size: 12px; color: #98a2b3; text-align: center; }

.nf-main { flex: 1; min-width: 0; background: #fff; border: 1px solid #eef2f7; border-radius: 10px; padding: 14px 16px; }
.nf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.nf-head h3 { margin: 0 0 4px; font-size: 15px; color: #16233b; }

.nf-tip {
  font-size: 12px; line-height: 1.75; color: #33425c;
  background: #f7f9fd; border: 1px solid #e6ecf5; border-radius: 8px;
  padding: 10px 12px; margin-bottom: 12px;
}
.nf-tip code, .nf-code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  background: #eef2f7; border-radius: 3px; padding: 0 4px; font-size: 11px; color: #7c3aed;
}

.nf-req-tgl {
  border: 1px solid #e0e7f1; background: #f7f9fd; color: #5b6b80;
  border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;
}
.nf-req-tgl.opt { border-color: #fadfae; background: #fff7ea; color: #b45309; }
.nf-req-tgl:disabled { opacity: .75; cursor: not-allowed; }
.nf-bi { font-size: 9px; color: #2563eb; background: #e8f0ff; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
.nf-off { opacity: .5; }
.nf-foot-note { font-size: 11.5px; color: #8a94a6; line-height: 1.7; margin-top: 12px; }
.nf-check { display: flex; align-items: flex-start; gap: 7px; font-size: 12.5px; color: #33425c; line-height: 1.6; }

.ap-list { max-height: 260px; overflow: auto; border: 1px solid #eef2f7; border-radius: 8px; }
/* 用 grid 而不是 flex：flex 会把「生产中」这样的标签压成竖排两行，
   grid 的 auto auto 1fr 让前两列按内容宽度、第三列占剩余，不压缩 */
.ap-row {
  display: grid; grid-template-columns: auto auto 1fr;
  align-items: start; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid #f4f7fb; font-size: 12px;
}
.ap-row > .mono, .ap-row > .tag { white-space: nowrap; }
.ap-row:last-child { border-bottom: none; }
.ap-add { color: #15803d; font-size: 11.5px; }
.ok-box { background: #f0faf4; border: 1px solid #bfe8d2; color: #15803d; border-radius: 8px; padding: 11px 13px; font-size: 12.5px; }
.warn-box { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 8px; padding: 11px 13px; font-size: 12.5px; margin-bottom: 10px; }
</style>
