<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>操作日志（审计）</h2>
        <p class="sub">
          所有写操作留痕。<b>每条都串在哈希链上</b>：改了任何一条，它后面的全部对不上，校验会指出断在第几条。
          链头水位单独存一张表 —— 所以<b>删掉最后几条也能被发现</b>。
          这里只记「谁在什么时候动了什么」，<b>不记单据内容</b>（记了日志本身就成泄密源）。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button class="btn btn-ghost" :disabled="busy" @click="doVerify">校验链</button>
        <button class="btn btn-ghost" :disabled="busy || !total" @click="doExport">导出 CSV</button>
        <button v-if="isAdmin" class="btn" :disabled="busy" @click="doArchive">归档</button>
      </div>
    </div>

    <div class="cards four">
      <div class="stat-card accent">
        <div class="label">日志总数</div>
        <div class="value">{{ fmtNum(stats.total) }}<small>条</small></div>
      </div>
      <div class="stat-card">
        <div class="label">今日写操作</div>
        <div class="value">{{ fmtNum(stats.today) }}<small>条</small></div>
      </div>
      <div class="stat-card">
        <div class="label">近 {{ stats.days || 14 }} 天失败请求</div>
        <div class="value" :style="{ color: stats.fail ? '#d92d45' : '#16a34a' }">
          {{ fmtNum(stats.fail) }}<small>条 / {{ stats.users || 0 }} 人</small>
        </div>
      </div>
      <div class="stat-card" :class="{ bad: chain && !chain.ok }">
        <div class="label">哈希链</div>
        <div class="value" :style="{ color: chain ? (chain.ok ? '#16a34a' : '#d92d45') : '#8a94a6' }">
          {{ chain ? (chain.ok ? '完整' : '断裂') : '未校验' }}
          <small v-if="chain">{{ fmtNum(chain.checked) }} 条</small>
        </div>
      </div>
    </div>

    <!-- 校验结果 -->
    <div v-if="chain && chain.ok" class="banner ok">
      <b>链校验通过</b>
      <span>
        逐条重算 {{ fmtNum(chain.checked) }} 条，序号 #{{ chain.range.from }} ~ #{{ chain.range.to }}；
        链头水位 #{{ chain.state.last_seq }}，归档水位 #{{ chain.state.anchor_seq }}。
        尾部哈希 <code>{{ short(chain.state.last_hash) }}</code>
      </span>
    </div>
    <div v-else-if="chain && !chain.ok" class="banner bad">
      <b>链校验未通过（{{ chain.problems.length }} 处）</b>
      <span>日志可能被改动或删除 —— 这在审计上是重大事项，先把下面几条截图留证，再排查。</span>
      <table class="data sm" style="margin-top: 8px">
        <thead><tr><th>问题</th><th>序号</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="(p, i) in chain.problems.slice(0, 8)" :key="i">
            <td class="mono tiny">{{ p.code }}</td>
            <td class="num">{{ p.seq == null ? '—' : p.seq }}</td>
            <td class="tiny">{{ p.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 筛选 -->
    <div class="panel-card">
      <div class="flt">
        <label>从 <input v-model="f.from" class="input" type="date" /></label>
        <label>到 <input v-model="f.to" class="input" type="date" /></label>
        <select v-model="f.username" class="select">
          <option value="">全部账号</option>
          <option v-for="u in facetsUsers" :key="u.username" :value="u.username">{{ u.username }}（{{ u.c }}）</option>
        </select>
        <select v-model="f.group" class="select">
          <option value="">全部大类</option>
          <option v-for="g in facetsGroups" :key="g.code" :value="g.code">{{ g.label }}（{{ g.count }}）</option>
        </select>
        <select v-model="f.action" class="select">
          <option value="">全部动作</option>
          <option v-for="a in facetsActions" :key="a.code" :value="a.code">{{ a.label }}（{{ a.count }}）</option>
        </select>
        <select v-model="f.result" class="select">
          <option value="">成功 + 失败</option>
          <option value="ok">只看成功</option>
          <option value="fail">只看失败</option>
        </select>
        <input v-model="f.q" class="input" placeholder="搜摘要 / 对象 / 路径 / 账号" style="min-width: 200px" @keyup.enter="search" />
        <button class="btn btn-primary" @click="search">查询</button>
        <button class="btn btn-ghost" @click="reset">重置</button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="panel-card">
      <div class="panel-h">
        <h3 style="margin: 0">日志（{{ fmtNum(total) }} 条）</h3>
        <span class="tiny muted">按序号倒序；「链」列悬停可看完整哈希</span>
      </div>
      <div class="table-wrap" style="max-height: 560px; overflow-y: auto">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 132px">时间</th>
              <th style="width: 64px" class="num">序号</th>
              <th>账号 / 岗位</th>
              <th>大类</th>
              <th>模块</th>
              <th>动作</th>
              <th>摘要</th>
              <th style="width: 62px">结果</th>
              <th style="width: 92px">链</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in rows" :key="l.id">
              <td class="tiny">{{ $fmtSec(l.created_at) }}</td>
              <td class="num mono tiny">{{ l.seq }}</td>
              <td>
                {{ l.username }}
                <span class="tag gray" v-if="l.role_label">{{ l.role_label }}</span>
              </td>
              <td class="tiny">{{ l.group_label }}</td>
              <td class="tiny"><b>{{ l.module_label }}</b></td>
              <td>
                <span class="tag" :class="tagOf(l.action)">{{ l.action_label }}</span>
              </td>
              <td class="tiny">{{ l.summary }}</td>
              <td>
                <span class="tag" :class="l.status < 400 ? 'green' : 'red'">{{ l.status }}</span>
              </td>
              <td class="mono tiny hash" :title="l.hash">{{ short(l.hash) }}</td>
            </tr>
            <tr v-if="!rows.length"><td colspan="9" class="empty">没有符合条件的日志</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button class="btn btn-ghost btn-sm" :disabled="page <= 1 || busy" @click="goto(page - 1)">上一页</button>
        <span class="tiny muted">第 {{ page }} / {{ pages || 1 }} 页</span>
        <button class="btn btn-ghost btn-sm" :disabled="page >= pages || busy" @click="goto(page + 1)">下一页</button>
      </div>
    </div>

    <!-- 归档 -->
    <div class="panel-card">
      <div class="panel-h">
        <h3 style="margin: 0">归档记录（{{ archives.length }}）</h3>
        <span class="tiny muted">归档是唯一能减少日志的方式：落成 JSONL 文件 + 文件哈希，然后才从主表移出</span>
      </div>
      <table class="data">
        <thead>
          <tr><th>编号</th><th>序号区间</th><th class="num">条数</th><th>文件</th><th>文件哈希</th><th>截止日期</th><th>操作人</th><th>时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in archives" :key="a.id">
            <td class="mono">{{ a.archive_no }}</td>
            <td class="mono tiny">#{{ a.from_seq }} ~ #{{ a.to_seq }}</td>
            <td class="num">{{ a.rows }}</td>
            <td class="mono tiny">{{ a.file }}</td>
            <td class="mono tiny" :title="a.file_sha256">{{ short(a.file_sha256) }}</td>
            <td class="tiny">{{ (a.cutoff || '').slice(0, 10) }}</td>
            <td class="tiny">{{ a.created_by }}</td>
            <td class="tiny">{{ $fmt(a.created_at) }}</td>
          </tr>
          <tr v-if="!archives.length"><td colspan="8" class="empty">还没有归档过（日志量大时再归档）</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadFile } from '../api';
import { can } from '../store/permissions';

const isAdmin = computed(() => can('audit.archive') || can('user.write'));

const busy = ref(false);
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pages = ref(1);
const pageSize = 50;
const stats = ref({});
const chain = ref(null);
const archives = ref([]);
const facets = ref({ users: [], groups: [], actions: [] });

const f = reactive({ from: '', to: '', username: '', group: '', action: '', result: '', q: '' });

const facetsUsers = computed(() => facets.value.users || []);
const facetsGroups = computed(() => facets.value.groups || []);
const facetsActions = computed(() => facets.value.actions || []);

const fmtNum = (v) => Number(v || 0).toLocaleString('zh-CN');
const short = (h) => (h ? String(h).slice(0, 8) + '…' : '—');
const tagOf = (a) =>
  ({ login: 'gray', create: 'green', update: 'blue', delete: 'red', approve: 'purple', flow: 'orange', export: 'gray' }[a] || 'gray');

/** 本地日界 → UTC ISO：库里存 UTC，用户选的是本地日期 */
function rangeParams() {
  const p = { ...f };
  if (f.from) p.from = new Date(f.from + 'T00:00:00').toISOString();
  if (f.to) p.to = new Date(f.to + 'T23:59:59.999').toISOString();
  return p;
}

async function loadList() {
  const d = await api.auditLogs({ ...rangeParams(), page: page.value, pageSize });
  rows.value = d.rows || [];
  total.value = d.total || 0;
  pages.value = d.pages || 1;
}

async function loadStats() {
  stats.value = await api.auditStats({ days: 14 });
}

async function loadFacets() {
  facets.value = await api.auditFacets();
}

async function loadArchives() {
  archives.value = await api.auditArchives();
}

async function reload() {
  busy.value = true;
  try {
    await Promise.all([loadList(), loadStats(), loadFacets(), loadArchives()]);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function search() {
  page.value = 1;
  loadList().catch((e) => alert(e.message));
}

function reset() {
  Object.assign(f, { from: '', to: '', username: '', group: '', action: '', result: '', q: '' });
  search();
}

function goto(p) {
  page.value = p;
  loadList().catch((e) => alert(e.message));
}

async function doVerify() {
  busy.value = true;
  try {
    chain.value = await api.auditVerify({});
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doExport() {
  busy.value = true;
  try {
    const blob = await downloadFile(api.auditExportPath(rangeParams()));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.download = `操作日志-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doArchive() {
  const days = prompt(
    '把多少天之前的日志归档？（归档后移出主表，但会留下 JSONL 文件与文件哈希，可查可核）\n最少 30 天：',
    '90'
  );
  if (days === null) return;
  const note = prompt('归档备注（例如「2026 上半年审计留档」，可留空）：', '') || '';
  busy.value = true;
  try {
    const r = await api.auditArchive({ before_days: Number(days), note });
    alert(`已归档 ${r.archive_no}：${r.rows} 条（#${r.from_seq} ~ #${r.to_seq}）\n文件：${r.file}`);
    await reload();
    chain.value = await api.auditVerify({});
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.cards.four {
  grid-template-columns: repeat(4, 1fr);
}
.stat-card.bad {
  border-color: #f3c6cd;
  background: #fdf3f4;
}
.flt {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.flt label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #6b7688;
}
.flt .input,
.flt .select {
  width: auto;
  min-width: 118px;
}
.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 10px;
}
.hash {
  color: #a0aabb;
  cursor: help;
}
@media (max-width: 900px) {
  .cards.four {
    grid-template-columns: repeat(2, 1fr);
  }
  .flt .input,
  .flt .select {
    width: 100%;
    min-width: 0;
  }
}
</style>
