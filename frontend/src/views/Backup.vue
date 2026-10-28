<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>备份与恢复</h2>
        <p class="sub">
          备份的价值只在恢复那一刻体现，所以这一页测的是<b>能不能恢复</b>，不是「能不能下载」。
          恢复分两步：<b>准备</b>（校验文件 → <b>先自动备份当前库</b> → 摆好待恢复文件）和<b>重启生效</b>
          （后端启动时校验并替换文件）。中间任何一步都能反悔：准备完可以撤销，替换前的旧库会改名留档。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="load">刷新</button>
        <label class="btn btn-ghost file-btn">
          上传备份恢复
          <input type="file" accept=".db,.sqlite,.sqlite3" @change="onPick" />
        </label>
        <button class="btn" @click="create">立即备份</button>
      </div>
    </div>

    <!-- 待恢复提醒：这是最容易被忽略的状态，必须置顶且显眼 -->
    <div v-if="pending.pending" class="banner danger">
      <div class="bn-main">
        <b>有备份等着恢复 —— 重启后端才会生效</b>
        <div class="bn-sub">
          待恢复文件 {{ (pending.size / 1024 / 1024).toFixed(2) }} MB
          <template v-if="pending.plan">
            ，来源 {{ pending.plan.source && pending.plan.source.job_no ? pending.plan.source.job_no : '上传文件' }}
            ，准备于 {{ pending.plan.at }}
            ，回滚点 {{ pending.plan.rollback_job_no }}
          </template>
        </div>
        <div class="bn-cmd">
          重启命令：<code>pm2 restart erp</code> 或关掉后端进程重新 <code>node src/server.js</code>
        </div>
      </div>
      <button class="btn btn-ghost" @click="rollback">撤销恢复</button>
    </div>

    <!-- 备份健康告警 -->
    <div v-else-if="health.level !== 'ok'" class="banner" :class="health.level === 'danger' ? 'danger' : 'warn'">
      <div class="bn-main">
        <b>{{ health.message }}</b>
        <div class="bn-sub">
          建议挂一个每日任务：<code>ADMIN_PASS=你的密码 node scripts/backup-cron.js</code>
        </div>
      </div>
      <button class="btn btn-ghost" @click="create">马上备份</button>
    </div>

    <div class="cards">
      <div class="stat-card" :class="{ accent: !pending.pending }">
        <div class="label">最近备份</div>
        <div class="value" style="font-size: 20px">
          {{ health.last_job ? hoursText(health.hours_since) : '无' }}
        </div>
        <div class="tiny" :style="{ opacity: 0.75 }">{{ health.last_job ? health.last_job.job_no : '从未备份' }}</div>
      </div>
      <div class="stat-card">
        <div class="label">备份文件</div>
        <div class="value">{{ storage.files || 0 }}<small>份 / {{ storage.total_human }}</small></div>
      </div>
      <div class="stat-card">
        <div class="label">已替换的旧库</div>
        <div class="value">{{ storage.replaced_count || 0 }}<small>份 / {{ storage.replaced_total_human }}</small></div>
      </div>
      <div class="stat-card">
        <div class="label">数据健康</div>
        <div class="value" :style="{ color: badChecks ? '#d92d45' : '#16a34a' }">
          {{ checks.length - badChecks }}<small>/ {{ checks.length }} 项通过</small>
        </div>
      </div>
    </div>

    <div class="tabs mine">
      <button :class="{ on: tab === 'list' }" @click="tab = 'list'">备份历史</button>
      <button :class="{ on: tab === 'checks' }" @click="tab = 'checks'">数据健康</button>
      <button :class="{ on: tab === 'how' }" @click="tab = 'how'">恢复怎么做</button>
    </div>

    <!-- ============ 备份历史 ============ -->
    <div v-if="tab === 'list'" class="table-wrap" style="overflow-y: auto">
      <table class="data">
        <thead>
          <tr>
            <th>编号</th>
            <th>类型</th>
            <th>时间</th>
            <th>大小</th>
            <th>表数</th>
            <th>关键表行数</th>
            <th>校验</th>
            <th>恢复状态</th>
            <th style="width: 210px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in list" :key="j.id">
            <td><code class="mono">{{ j.job_no }}</code></td>
            <td>
              <span class="tag" :class="kindTag(j.kind)">{{ kindLabel(j.kind) }}</span>
            </td>
            <td class="tiny">{{ fmt(j.created_at) }}</td>
            <td>{{ j.kind === 'restore' ? '—' : j.size_human }}</td>
            <td>{{ j.tables_count || '—' }}</td>
            <td>{{ j.rows_total || '—' }}</td>
            <td>
              <span class="tag" :class="j.verify_status === 'ok' ? 'green' : j.verify_status === 'failed' ? 'red' : 'gray'">
                {{ j.verify_status === 'ok' ? '通过' : j.verify_status === 'failed' ? '失败' : '未校验' }}
              </span>
              <div v-if="j.verify_status === 'failed'" class="tiny" style="color: #d92d45; max-width: 220px">
                {{ j.verify_note }}
              </div>
            </td>
            <td>
              <span v-if="j.restore_status" class="tag" :class="j.restore_status === 'applied' ? 'blue' : 'orange'">
                {{ restoreLabel(j.restore_status) }}
              </span>
              <span v-else class="tiny muted">—</span>
            </td>
            <td class="ops">
              <button v-if="j.exists && j.kind !== 'restore'" class="link-btn" @click="download(j)">下载</button>
              <button v-if="j.exists && j.kind !== 'restore'" class="link-btn" @click="verify(j)">校验</button>
              <button v-if="j.exists && j.kind !== 'restore'" class="link-btn strong" @click="askRestore(j)">恢复</button>
              <button v-if="j.kind !== 'restore'" class="link-btn danger" @click="remove(j)">删除</button>
              <span v-if="!j.exists && j.kind !== 'restore'" class="tiny muted">文件已清理</span>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td colspan="9" class="tiny muted" style="text-align: center; padding: 26px">
              还没有备份。上线前至少要有一份，并且挂上每日定时备份。
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ============ 数据健康 ============ -->
    <div v-if="tab === 'checks'">
      <div class="panel-card" style="padding: 14px 18px">
        <div class="tiny muted">
          这些是<b>当前库自身</b>的检查，跟恢复无关。恢复成功后如果库里本来有脏数据，这里仍然会报 ——
          所以它不参与「恢复是否成功」的判定，恢复只看行数一致与标记回滚。
        </div>
      </div>
      <div v-for="c in checks" :key="c.key" class="panel-card check-row" :class="{ bad: c.pass === false }">
        <div class="cr-head">
          <span class="tag" :class="c.pass === false ? 'red' : 'green'">
            {{ c.pass === false ? '待处理' : '正常' }}
          </span>
          <b>{{ c.item }}</b>
          <span class="tag gray">{{ c.severity === 'hard' ? '硬性' : '数据' }}</span>
        </div>
        <div class="cr-note">{{ c.note }}</div>
      </div>
    </div>

    <!-- ============ 怎么做 ============ -->
    <div v-if="tab === 'how'" class="panel-card">
      <h4 style="margin-top: 0">恢复的三个阶段（每一步都能反悔）</h4>
      <ol class="steps">
        <li>
          <b>准备</b>：选一份备份（或上传文件）→ 系统先<b>校验</b>（完整性 / 关键表 / 非空库）
          → 校验不过直接拒绝，绝不会把坏文件盖上去 → 校验通过后<b>自动把当前库备份一份</b>（回滚点）
          → 写出待恢复文件。
        </li>
        <li>
          <b>撤销（可选）</b>：准备完但还没重启，随时可以点「撤销恢复」，待恢复文件会改名归档，当前库不受影响。
        </li>
        <li>
          <b>重启生效</b>：后端启动时<b>再校验一次</b>待恢复文件 → 把旧库改名到 <code>data/replaced/</code>
          → <b>删掉旧库的 -wal / -shm</b>（不删会把旧事务重放到新库上）→ 换文件。
          校验不过就放弃恢复、继续用旧库 —— 宁可恢复失败，也不能把库弄坏。
        </li>
      </ol>
      <h4>退回上一版</h4>
      <p class="tiny muted" style="line-height: 1.9">
        换下来的旧库都在 <code>data/replaced/</code> 里，需要回退时：停服务 → 把
        <code>replaced-xxxx.db</code> 改名成 <code>erp-mindmap.db</code>（同时删掉同目录的
        <code>-wal</code> / <code>-shm</code>）→ 启动。
      </p>
      <h4>定时备份</h4>
      <p class="tiny muted" style="line-height: 1.9">
        <code>ADMIN_PASS=你的密码 node scripts/backup-cron.js</code> —— 挂到系统计划任务，建议每天 02:00 跑。
        服务端保留策略：手动备份留最近 30 份、恢复前自动备份留 10 份、定时备份留 15 份。
      </p>
      <h4>演练</h4>
      <p class="tiny muted" style="line-height: 1.9">
        <code>node scripts/restore-drill.js --phase prepare</code> → 重启后端 →
        <code>--phase verify</code>，会自动生成 <code>docs/DRILL-REPORT.md</code>。
        上线前跑一次并留档，之后每季度跑一次。
      </p>
    </div>

    <!-- 恢复确认弹层 -->
    <div v-if="confirm.show" class="modal-mask" @click.self="confirm.show = false">
      <div class="modal-box">
        <h3>确认恢复这份备份？</h3>
        <div class="cf-target">
          <div><span class="tiny muted">备份</span> <code class="mono">{{ confirm.job.job_no }}</code></div>
          <div><span class="tiny muted">时间</span> {{ fmt(confirm.job.created_at) }}</div>
          <div><span class="tiny muted">大小</span> {{ confirm.job.size_human }} / {{ confirm.job.tables_count }} 张表</div>
        </div>
        <div class="cf-warn">
          <b>恢复后，这份备份之后产生的数据都会消失。</b>
          系统会先用当前库自动备份一份作为回滚点，恢复要重启后端才生效，重启前可以撤销。
        </div>
        <label>恢复原因（会记进留档）</label>
        <input v-model="confirm.note" class="input" placeholder="如：误删客户数据，回滚到 10-28 02:00 的备份" />
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="confirm.show = false">取消</button>
          <button class="btn btn-danger" @click="doRestore">准备恢复</button>
        </div>
      </div>
    </div>

    <!-- 上传预检结果 -->
    <div v-if="prep.show" class="modal-mask" @click.self="prep.show = false">
      <div class="modal-box wide">
        <h3>预检通过，已准备恢复</h3>
        <p class="tiny muted">
          文件校验通过，并且已经把当前库自动备份成回滚点 <code>{{ prep.data.rollback_job_no }}</code>。
          <b>重启后端才会真正换库</b>，重启前可以随时撤销。
        </p>
        <div class="kv-grid">
          <div><span>完整性校验</span><b>{{ prep.data.checks.integrity }}</b></div>
          <div><span>表数</span><b>{{ prep.data.checks.tables }}</b></div>
          <div><span>关键表行数</span><b>{{ prep.data.checks.rows_total }}</b></div>
          <div><span>回滚点</span><b>{{ prep.data.rollback_job_no }}</b></div>
        </div>
        <div v-if="prep.data.checks.warnings && prep.data.checks.warnings.length" class="cf-warn soft">
          <div v-for="(w, i) in prep.data.checks.warnings" :key="i">· {{ w }}</div>
        </div>
        <div class="cf-warn">
          <b>现在去重启后端。</b>启动时会再校验一次并替换文件，旧库会留档到 <code>data/replaced/</code>。
        </div>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="prep.show = false; load()">知道了</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, uploadBinary, downloadFile } from '../api';
import { fmtTimeSec } from '../utils/time';

const tab = ref('list');
const list = ref([]);
const checks = ref([]);
const health = ref({});
const storage = ref({});
const pending = ref({ pending: false });

const confirm = reactive({ show: false, job: {}, note: '' });
const prep = reactive({ show: false, data: {} });

const badChecks = computed(() => checks.value.filter((c) => c.pass === false).length);

// 后端存 UTC ISO，直接截 19 位会差 8 小时 —— 统一走 utils/time
function fmt(s) {
  return fmtTimeSec(s);
}
function hoursText(h) {
  if (h === null || h === undefined) return '—';
  if (h < 1) return '刚刚';
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
function kindLabel(k) {
  return { manual: '手动', pre_restore: '恢复前', auto: '定时', drill: '演练', restore: '恢复' }[k] || k;
}
function kindTag(k) {
  return { manual: 'blue', pre_restore: 'orange', auto: 'purple', drill: 'gray', restore: 'green' }[k] || 'gray';
}
function restoreLabel(s) {
  return { pending: '待重启生效', applied: '已生效', rolled_back: '已撤销', failed: '失败' }[s] || s;
}

async function load() {
  const d = await api.backupOverview();
  health.value = d.health || {};
  storage.value = d.storage || {};
  pending.value = d.pending || { pending: false };
  list.value = d.recent || [];
  checks.value = d.checks || [];
}

async function create() {
  const note = prompt('这次备份的说明（可留空）', '手动备份');
  if (note === null) return;
  try {
    const j = await api.backupCreate({ note });
    alert(`已生成 ${j.job_no}\n${(j.size_bytes / 1024 / 1024).toFixed(2)} MB / ${j.tables_count} 张表 / 校验 ${j.verify_status}`);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function verify(j) {
  try {
    const r = await api.backupVerify(j.id);
    const c = r.checks || {};
    alert(c.ok ? `校验通过\n完整性 ${c.integrity}\n${c.tables} 张表 / 关键表 ${c.rows_total} 行` : `校验未通过：\n${(c.errors || []).join('\n')}`);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function download(j) {
  try {
    const blob = await downloadFile(`/api/backup/${j.id}/download`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = j.file_name || 'backup.db';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(e.message);
  }
}

function askRestore(j) {
  confirm.job = j;
  confirm.note = '';
  confirm.show = true;
}

async function doRestore() {
  confirm.show = false;
  try {
    const r = await api.backupPrepare({ backup_id: confirm.job.id, note: confirm.note });
    prep.data = r;
    prep.show = true;
    await load();
  } catch (e) {
    alert(e.message);
  }
}

function onPick(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  if (!confirm(`上传 ${f.name}（${(f.size / 1024 / 1024).toFixed(2)} MB）准备恢复？\n\n会先校验文件，并把当前库自动备份成回滚点。`)) return;
  (async () => {
    try {
      const r = await uploadBinary('/api/backup/restore/upload', f, { note: '上传文件恢复' });
      prep.data = r;
      prep.show = true;
      await load();
    } catch (e) {
      alert(e.message);
    }
  })();
}

async function rollback() {
  if (!confirm('撤销待恢复？当前库不会有任何变化。')) return;
  try {
    const r = await api.backupRollback();
    alert('已撤销。待恢复文件已归档到：\n' + r.archived);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function remove(j) {
  if (!confirm(`删除备份 ${j.job_no}？\n文件会一起删掉，无法找回。`)) return;
  try {
    await api.backupDelete(j.id);
    await load();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  try {
    await load();
  } catch (e) {
    alert(e.message);
  }
});
</script>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-radius: 12px;
  padding: 14px 18px;
  margin-bottom: 18px;
  border: 1px solid #f0d8b8;
  background: #fffaf2;
}
.banner.danger {
  border-color: #f3c3cb;
  background: #fef5f6;
}
.banner .bn-main b {
  font-size: 14px;
  color: #1f2a3d;
}
.banner .bn-sub {
  font-size: 12px;
  color: #6b7688;
  margin-top: 5px;
}
.banner .bn-cmd {
  font-size: 11.5px;
  color: #8a94a6;
  margin-top: 6px;
}
.banner code,
.panel-card code {
  background: #eef2f9;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11.5px;
}
.mono {
  background: #f2f5fa;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11.5px;
  white-space: nowrap;
}
.tabs.mine {
  margin-left: 0;
  margin-bottom: 14px;
}
td.ops {
  white-space: nowrap;
}
table.data td.ops .link-btn + .link-btn {
  margin-left: 8px;
}
.link-btn {
  background: none;
  border: none;
  color: #2563eb;
  font-size: 12px;
  cursor: pointer;
  padding: 0 6px 0 0;
}
.link-btn.strong {
  font-weight: 700;
}
.link-btn.danger {
  color: #d92d45;
}
.check-row {
  padding: 14px 18px;
  border-left: 3px solid #cfe8d8;
}
.check-row.bad {
  border-left-color: #f0b4be;
}
.cr-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.cr-note {
  font-size: 12px;
  color: #5b6474;
  margin-top: 6px;
}
.steps {
  margin: 10px 0 18px;
  padding-left: 20px;
  font-size: 12.5px;
  color: #4a5568;
  line-height: 2;
}
.steps b {
  color: #1f2a3d;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 26, 46, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-box {
  background: #fff;
  border-radius: 14px;
  padding: 20px 22px;
  width: 480px;
  max-width: 92vw;
}
.modal-box.wide {
  width: 560px;
}
.modal-box h3 {
  margin: 0 0 8px;
  font-size: 16px;
}
.modal-box label {
  display: block;
  font-size: 12px;
  color: #5b6474;
  margin: 14px 0 5px;
}
.cf-target {
  background: #f7faff;
  border: 1px solid #e6ebf3;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.9;
  margin-bottom: 12px;
}
.cf-warn {
  background: #fef5f6;
  border: 1px solid #f3c3cb;
  color: #a3283c;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.8;
}
.cf-warn.soft {
  background: #fffaf2;
  border-color: #f0d8b8;
  color: #8a6a3a;
}
.kv-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 14px;
  margin: 14px 0;
}
.kv-grid > div {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px dashed #eef1f6;
  padding-bottom: 6px;
  font-size: 12.5px;
}
.kv-grid span {
  color: #8a94a6;
}
.modal-ops {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.btn-danger {
  background: #d92d45;
  color: #fff;
  border-color: #d92d45;
}
.file-btn {
  position: relative;
  overflow: hidden;
  cursor: pointer;
}
.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
@media (max-width: 900px) {
  .kv-grid {
    grid-template-columns: 1fr;
  }
  .banner {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
