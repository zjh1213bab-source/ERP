<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>真实数据导入</h2>
        <p class="sub">
          上线期初导入是<b>一次性、不可重来</b>的操作，所以这一页只做一件事：<b>先看清每一行会发生什么，再决定写不写</b>。
          预览只算不写；提交<b>默认整批事务</b>——有一行错就整批不写，避免导一半的数据最难收拾。
          <b>期初库存只能导一次</b>：同一 仓+款+色+码 已有期初流水就拒绝（重复导入会把库存翻倍）；已有真实库存的也拒绝，那种情况要走盘点。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'in' }" @click="tab = 'in'">导入</button>
      <button :class="{ on: tab === 'batches' }" @click="tab = 'batches'; loadBatches()">导入记录</button>
    </div>

    <!-- ============ 导入 ============ -->
    <div v-if="tab === 'in'">
      <div class="panel">
        <h4>1. 选择要导什么</h4>
        <div class="type-grid">
          <div
            v-for="t in types"
            :key="t.type"
            class="type-card"
            :class="{ on: form.type === t.type }"
            @click="pickType(t)"
          >
            <div class="tc-head">
              <b>{{ t.label }}</b>
              <span class="tag gray">{{ t.group }}</span>
            </div>
            <div class="tiny muted">{{ t.unique }}</div>
          </div>
        </div>
        <div v-if="cur" class="type-note">
          <b>{{ cur.label }}</b> · {{ cur.note }}
        </div>
      </div>

      <div v-if="cur" class="panel">
        <h4>2. 准备数据</h4>
        <div class="io-row">
          <button class="btn btn-ghost" @click="downloadTemplate">下载模板（CSV）</button>
          <span class="tiny muted">模板里有一行示例；Excel 另存为「CSV UTF-8」，或直接从 Excel 复制粘贴（制表符也能识别）</span>
        </div>

        <div class="field-hint">
          <span v-for="f in cur.fields" :key="f.k" class="fh" :class="{ req: f.required }">
            {{ f.label }}<i v-if="f.required">*</i><small v-if="f.hint">（{{ f.hint }}）</small>
          </span>
        </div>

        <div class="io-row" style="margin-top: 10px">
          <label class="btn btn-ghost file-btn">
            选择 CSV 文件
            <input type="file" accept=".csv,text/csv" style="display: none" @change="onFile" />
          </label>
          <span v-if="form.file_name" class="tiny muted">{{ form.file_name }}</span>
          <button v-if="form.csv" class="lnk" @click="form.csv = ''; form.file_name = ''; pv = null">清空</button>
        </div>

        <label class="fl" style="margin-top: 10px">
          或直接粘贴（首行为表头）
          <textarea v-model="form.csv" class="ta" rows="7" placeholder="仓库,款号,款名,颜色,尺码,数量&#10;生产仓,LEJE-1001,示例款,藏青,3T,120"></textarea>
        </label>

        <div class="io-row" style="margin-top: 10px">
          <button class="btn btn-primary" :disabled="!form.csv || busy" @click="doPreview">预览（不写库）</button>
          <span v-if="pv" class="tiny muted">{{ pv.hint }}</span>
        </div>
      </div>

      <!-- 预览结果 -->
      <div v-if="pv" class="panel">
        <h4>3. 预览结果</h4>
        <div class="stat-row">
          <div class="stat">
            <span>总行数</span><strong>{{ pv.stat.total }}</strong>
            <small>分隔符 {{ pv.delimiter === '\t' ? '制表符' : (pv.delimiter === ';' ? '分号' : '逗号') }}</small>
          </div>
          <div class="stat"><span>将新增</span><strong class="ok-line">{{ pv.stat.new }}</strong><small>库里没有的</small></div>
          <div class="stat"><span>将覆盖</span><strong class="orange">{{ pv.stat.update }}</strong><small>按唯一键匹配到已有的</small></div>
          <div class="stat" :class="pv.stat.error ? 'st-bad' : ''">
            <span>有问题</span><strong>{{ pv.stat.error }}</strong><small>{{ pv.stat.error ? '默认整批不写' : '可以提交' }}</small>
          </div>
        </div>

        <div class="table-wrap" style="max-height: 420px; overflow-y: auto">
          <table class="data" style="min-width: 720px">
            <thead>
              <tr><th class="num">行号</th><th>动作</th><th>关键内容</th><th>问题</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in pv.rows" :key="r.line" :class="rowClass(r.action)">
                <td class="num tiny">{{ r.line }}</td>
                <td>
                  <span class="tag" :class="actionTag(r.action)">{{ actionLabel(r.action) }}</span>
                </td>
                <td class="tiny wrap" style="min-width: 220px">{{ r.preview }}</td>
                <td class="tiny wrap" style="min-width: 280px">
                  <div v-for="(e, i) in r.errors" :key="i" class="red">· {{ e }}</div>
                  <span v-if="!r.errors.length" class="muted">—</span>
                </td>
              </tr>
              <tr v-if="!pv.rows.length"><td colspan="4" class="empty">没有数据行</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="pv.truncated" class="tiny muted" style="margin-top: 6px">预览只显示前 500 行（提交时会处理全部）</div>

        <div class="commit-box">
          <label v-if="pv.stat.error" class="chk">
            <input v-model="form.skip_errors" type="checkbox" />
            跳过有问题的行（只导能导的）—— <b class="orange">不推荐</b>：导进去的数据会残缺，事后很难补
          </label>
          <label class="fl" style="max-width: 320px">
            备注（会记进导入记录）
            <input v-model="form.note" placeholder="例如：2026-10-31 期初库存盘点数" />
          </label>
          <div class="io-row">
            <button class="btn btn-primary" :disabled="busy || (pv.stat.error && !form.skip_errors)" @click="doCommit">
              确认导入
            </button>
            <span class="tiny muted">
              {{ pv.stat.error && !form.skip_errors ? '有错误行，先改文件或用「跳过错误行」' : `将写入 ${pv.stat.new + pv.stat.update} 条` }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="last" class="panel">
        <h4>导入完成</h4>
        <div class="done-box">
          <div><span>批次号</span><b class="mono">{{ last.batch_no }}</b></div>
          <div><span>类型</span><b>{{ last.label }}</b></div>
          <div><span>新增</span><b class="ok-line">{{ last.new }}</b></div>
          <div><span>覆盖</span><b class="orange">{{ last.update }}</b></div>
          <div><span>跳过</span><b :class="{ red: last.skipped }">{{ last.skipped }}</b></div>
        </div>
        <div class="tiny muted" style="margin-top: 8px">去「导入记录」可以查这一批的明细与错误行。</div>
      </div>
    </div>

    <!-- ============ 记录 ============ -->
    <div v-if="tab === 'batches'">
      <div class="panel">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>批次号</th><th>类型</th><th>文件</th><th class="num">总行</th>
                <th class="num">成功</th><th class="num">新增</th><th class="num">覆盖</th>
                <th class="num">错误</th><th class="num">跳过</th><th>状态</th><th>操作人</th><th>时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in batches" :key="b.id" :class="{ 'row-bad': b.status === 'failed' }">
                <td class="mono tiny">{{ b.batch_no }}</td>
                <td class="tiny">{{ b.type_label || b.type }}</td>
                <td class="tiny muted">{{ b.file_name || '粘贴' }}</td>
                <td class="num tiny">{{ b.total_rows }}</td>
                <td class="num tiny">{{ b.ok_rows }}</td>
                <td class="num tiny ok-line">{{ b.new_rows }}</td>
                <td class="num tiny orange">{{ b.update_rows }}</td>
                <td class="num tiny" :class="{ red: b.error_rows }">{{ b.error_rows }}</td>
                <td class="num tiny" :class="{ red: b.skipped_rows }">{{ b.skipped_rows }}</td>
                <td><span class="tag" :class="b.status === 'committed' ? 'green' : 'red'">{{ b.status === 'committed' ? '已写入' : '失败' }}</span></td>
                <td class="tiny">{{ b.operator || '—' }}</td>
                <td class="tiny muted">{{ fmt(b.created_at) }}</td>
              </tr>
              <tr v-if="!batches.length"><td colspan="12" class="empty">还没有导入记录</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { auth } from '../store/auth';
import { fmtTime } from '../utils/time';
import { can } from '../store/permissions';

const tab = ref('in');
const types = ref([]);
const batches = ref([]);
const pv = ref(null);
const last = ref(null);
const busy = ref(false);

const form = reactive({ type: '', csv: '', file_name: '', skip_errors: false, note: '' });

const canCommit = computed(() => can('importops.commit'));
const cur = computed(() => types.value.find((t) => t.type === form.type) || null);
const base = (import.meta.env.VITE_API_BASE || '') + '';

const actionLabel = (a) => ({ new: '新增', update: '覆盖', error: '有问题' }[a] || a);
const actionTag = (a) => ({ new: 'green', update: 'orange', error: 'red' }[a] || 'gray');
const rowClass = (a) => (a === 'error' ? 'row-bad' : (a === 'update' ? 'row-warn' : ''));
// 统一走 utils/time：带时区(Z)的转本地，不带时区的原样
const fmt = (s) => (s ? fmtTime(s) : '—');

function pickType(t) {
  form.type = t.type;
  form.csv = '';
  form.file_name = '';
  form.skip_errors = false;
  form.note = '';
  pv.value = null;
  last.value = null;
}

function onFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  // 只认 UTF-8：GBK 会变乱码，提前提示比导进去再发现好
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    if (/\uFFFD/.test(text)) {
      alert('文件不是 UTF-8 编码（出现乱码字符）。请在 Excel 里「另存为 → CSV UTF-8」后重试。');
      return;
    }
    form.csv = text;
    form.file_name = f.name;
    pv.value = null;
    last.value = null;
  };
  reader.readAsText(f, 'utf-8');
}

async function downloadTemplate() {
  try {
    // 模板是 CSV 文件，api 层只解析 JSON，这里直接带 token 取原文
    const res = await fetch(`/api/importops/template/${form.type}`, {
      headers: { Authorization: 'Bearer ' + auth.token }
    });
    if (!res.ok) throw new Error('模板下载失败');
    saveBlob(await res.blob(), `import-${form.type}.csv`);
  } catch (e) {
    alert(e.message);
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function doPreview() {
  busy.value = true;
  last.value = null;
  try {
    pv.value = await api.importPreview({ type: form.type, csv: form.csv });
    if (pv.value.stat.error) form.skip_errors = false;
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doCommit() {
  if (!canCommit.value) return alert('当前角色没有导入写入权限（需要管理员或财务）');
  if (!confirm(`确认导入 ${pv.value.stat.new + pv.value.stat.update} 条？写入后不能自动撤销。`)) return;
  busy.value = true;
  try {
    const r = await api.importCommit({
      type: form.type,
      csv: form.csv,
      opts: { skip_errors: form.skip_errors ? 1 : 0, file_name: form.file_name || null, note: form.note || null }
    });
    last.value = r;
    pv.value = null;
    form.csv = '';
    form.file_name = '';
    await loadBatches();
  } catch (e) {
    const d = e.data || e.payload;
    alert(e.message);
    if (d && d.rows) pv.value = { ...pv.value, stat: d.stat, rows: d.rows };
  } finally {
    busy.value = false;
  }
}

async function loadBatches() {
  const r = await api.importBatches({});
  batches.value = r.rows || [];
}

async function reload() {
  types.value = (await api.importTypes()).types || [];
  if (!form.type && types.value.length) pickType(types.value[0]);
  await loadBatches();
}

onMounted(reload);
</script>

<style scoped>
.type-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.type-card { border: 1px solid #e6ebf3; border-radius: 10px; padding: 10px 12px; cursor: pointer; background: #fff; }
.type-card:hover { border-color: #c7d7f0; }
.type-card.on { border-color: #2f6fed; background: #f5f9ff; box-shadow: 0 0 0 2px rgba(47, 111, 237, .12); }
.tc-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; font-size: 13px; color: #16305f; }

.type-note { margin-top: 10px; background: #fffaf1; border: 1px solid #f7d9a8; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #92400e; line-height: 1.7; }

.io-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.file-btn { cursor: pointer; }
.field-hint { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.fh { font-size: 12px; background: #f8fafd; border: 1px solid #e6ebf3; border-radius: 7px; padding: 3px 8px; color: #5b6474; }
.fh.req { border-color: #f6c6cd; color: #b42318; }
.fh i { color: #d92d45; font-style: normal; margin-left: 1px; }
.fh small { color: #9aa4b5; }

.ta { width: 100%; margin-top: 4px; padding: 8px 10px; border: 1px solid #dfe5ef; border-radius: 8px; font-size: 12px; font-family: ui-monospace, Menlo, monospace; box-sizing: border-box; line-height: 1.6; }
.fl { display: block; font-size: 12px; color: #5b6474; }
.fl input { width: 100%; margin-top: 4px; padding: 6px 9px; border: 1px solid #dfe5ef; border-radius: 7px; font-size: 12.5px; box-sizing: border-box; }

.stat-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 10px 0 12px; }
.stat { background: #fff; border: 1px solid #e6ebf3; border-radius: 12px; padding: 12px 14px; }
.stat span { display: block; font-size: 12px; color: #8a94a6; }
.stat strong { display: block; font-size: 22px; font-weight: 800; color: #16305f; margin-top: 6px; line-height: 1.1; }
.stat small { display: block; font-size: 11px; color: #9aa4b5; margin-top: 4px; }
.stat.st-bad { border-color: #f6c6cd; background: #fff6f7; }

.commit-box { margin-top: 12px; background: #f8fafd; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #5b6474; }
.chk input { width: auto; }

.done-box { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; color: #5b6474; }
.done-box span { color: #8a94a6; margin-right: 5px; }
.done-box b { color: #16305f; }

table.data th, table.data td { white-space: nowrap; }
table.data td.wrap { white-space: normal; }
.empty { text-align: center; color: #9aa4b5; padding: 22px 0 !important; font-size: 12.5px; }
.row-warn { background: #fffdf6; }
.row-bad { background: #fff6f7; }
.ok-line { color: #16a34a; }
.red { color: #d92d45; }
.orange { color: #d97706; }
.lnk { background: none; border: none; color: #2f6fed; font-size: 12px; cursor: pointer; }

@media (max-width: 900px) {
  .type-grid { grid-template-columns: 1fr; }
  .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
