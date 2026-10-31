<template>
  <div>
    <div class="page-head">
      <div>
        <h2>考勤打卡</h2>
        <div class="sub">上下班打卡与月度考勤</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <div class="panel-card">
      <h3>今日打卡</h3>
      <div class="clock-row">
        <select class="select clock-select" v-model.number="employeeId">
          <option :value="null">— 选择员工 —</option>
          <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.name }}（{{ e.department_name || '未分配' }}）</option>
        </select>
        <div class="clock-btns">
          <button class="btn btn-primary" :disabled="!employeeId || busy" @click="clock('in')">上班打卡</button>
          <button class="btn btn-ghost" :disabled="!employeeId || busy" @click="clock('out')">下班打卡</button>
        </div>
        <span v-if="today" style="font-size: 13px; color: #33415a">
          今日：上班 {{ today.check_in || '-' }} / 下班 {{ today.check_out || '-' }}
          <span class="tag" :class="today.status === 'late' ? 'orange' : 'green'">{{ statusLabel(today.status) }}</span>
        </span>
      </div>
    </div>

    <div class="panel-card">
      <h3>月度考勤</h3>
      <div class="toolbar" style="margin-bottom: 12px">
        <input class="input" type="month" v-model="month" @change="load" style="width: 180px" />
      </div>
      <table class="data">
        <thead><tr><th>日期</th><th>员工</th><th>上班</th><th>下班</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="a in rows" :key="a.id">
            <td>{{ a.date }}</td><td>{{ a.employee_name }}</td><td>{{ a.check_in || '-' }}</td><td>{{ a.check_out || '-' }}</td>
            <td><span class="tag" :class="a.status === 'late' ? 'orange' : 'green'">{{ statusLabel(a.status) }}</span></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="5" class="empty-cell">暂无考勤记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- ============ 钉钉同步 ============ -->
    <div class="panel-card" v-if="!dtDenied">
      <div class="dt-head">
        <h3 style="margin: 0">钉钉同步</h3>
        <div class="dt-actions">
          <button class="btn btn-sm btn-ghost" :disabled="dtBusy" @click="runProbe()">连接自检</button>
          <button class="btn btn-sm btn-ghost" :disabled="dtBusy" @click="runSync(true)">试运行</button>
          <button class="btn btn-sm btn-primary" :disabled="dtBusy || !dt.status.configured" @click="runSync(false)">立即同步</button>
        </div>
      </div>

      <p class="dt-line">
        <span class="tag" :class="dt.status.configured ? 'green' : 'red'">
          {{ dt.status.configured ? '凭据已配置' : '凭据未配置' }}
        </span>
        <span>已绑定 <b>{{ dt.status.employees_mapped }}</b> / {{ dt.status.employees_total }} 名在职员工</span>
        <span v-if="dt.status.last_run" class="mut tiny">
          · 上次同步 {{ shortTime(dt.status.last_run.started_at) }}：
          <template v-if="dt.status.last_run.ok">新增 {{ dt.status.last_run.inserted }} / 更新 {{ dt.status.last_run.updated }}</template>
          <span v-else class="red">失败 —— {{ dt.status.last_run.error }}</span>
        </span>
      </p>

      <p v-if="!dt.status.configured" class="dt-hint">
        在 <code>backend/.env</code> 填 <code>DINGTALK_APP_KEY</code> / <code>DINGTALK_APP_SECRET</code> 后重启服务；
        钉钉应用还需添加「查询企业考勤数据权限」<b>并重新发布</b>，否则接口会报 60011。
      </p>

      <!-- 自检：分步结果，看清是"凭据不对"还是"权限没开" -->
      <div v-if="dt.probe" class="dt-probe">
        <div v-for="s in dt.probe.steps" :key="s.name" class="dt-step">
          <span class="tag" :class="s.ok ? 'green' : 'red'">{{ s.name }}</span>
          <span class="tiny" :class="s.ok ? 'mut' : 'red'">{{ s.ms }}ms · {{ s.ok ? s.note : s.error }}</span>
        </div>
      </div>

      <!-- 同步结果（试运行也走这里，避免"点了没反应"） -->
      <p v-if="dt.result" class="dt-result">
        <span class="tag" :class="dt.result.dry_run ? 'orange' : 'green'">{{ dt.result.dry_run ? '试运行（未写库）' : '已写入' }}</span>
        区间 {{ dt.result.from }} ~ {{ dt.result.to }} ·
        新增 {{ dt.result.inserted }} · 更新 {{ dt.result.updated }} ·
        跳过人工 {{ dt.result.skipped_manual }} · 未映射 {{ dt.result.unmatched }} ·
        无效卡 {{ dt.result.illegal }} · 接口调用 {{ dt.result.api_calls }} 次
      </p>

      <p class="dt-sub">员工 ↔ 钉钉 userid（未绑定的人不会被同步，考勤就看不到他）</p>
      <table class="data">
        <thead><tr><th style="width: 110px">工号</th><th style="width: 120px">姓名</th><th style="width: 140px">岗位</th><th>钉钉 userid</th><th style="width: 130px">操作</th></tr></thead>
        <tbody>
          <tr v-for="e in bindRows" :key="e.id">
            <td class="tiny mut">{{ e.code || '—' }}</td>
            <td>{{ e.name }}</td>
            <td class="mut tiny">{{ e.position || '—' }}</td>
            <td><input class="input dt-input" v-model="e._dt" placeholder="留空 = 不绑定" /></td>
            <td>
              <button class="btn btn-sm btn-ghost" :disabled="dtBusy" @click="saveMap(e)">保存</button>
              <button class="btn btn-sm btn-ghost" v-if="e.dingtalk_userid" :disabled="dtBusy" @click="clearMap(e)">解绑</button>
            </td>
          </tr>
          <tr v-if="!bindRows.length"><td colspan="5" class="empty-cell">还没有员工档案，先到「员工档案」录入再绑定</td></tr>
        </tbody>
      </table>

      <p class="dt-sub" v-if="dt.runs.length">最近同步记录</p>
      <table class="data" v-if="dt.runs.length">
        <thead><tr><th>时间</th><th>区间</th><th>结果</th><th>新增 / 更新</th><th>跳过人工</th><th>未映射</th><th>失败原因</th></tr></thead>
        <tbody>
          <tr v-for="r in dt.runs" :key="r.id">
            <td class="tiny mut">{{ shortTime(r.started_at) }}</td>
            <td class="tiny">{{ r.from_date }} ~ {{ r.to_date }}</td>
            <td><span class="tag" :class="r.ok ? 'green' : 'red'">{{ r.ok ? '成功' : '失败' }}</span></td>
            <td>{{ r.inserted }} / {{ r.updated }}</td>
            <td>{{ r.skipped_manual }}</td>
            <td :class="{ red: r.unmatched > 0 }">{{ r.unmatched }}</td>
            <td class="tiny red">{{ r.error || '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const employees = ref([]);
const employeeId = ref(null);
const month = ref(new Date().toISOString().slice(0, 7));
const rows = ref([]);
const busy = ref(false);

/* ---- 钉钉同步 ---- */
const dtBusy = ref(false);
const dtDenied = ref(false);   // 非 admin/hr 打开本页时整块隐藏，不弹 403
const bindRows = ref([]);
const dt = ref({
  status: { configured: false, employees_mapped: 0, employees_total: 0, last_run: null },
  probe: null,
  result: null,
  runs: []
});

const statusLabel = (s) => ({ normal: '正常', late: '迟到', leave: '请假', absent: '缺勤' }[s] || s);
const shortTime = (s) => String(s || '').replace('T', ' ').slice(0, 16);
const todayRecord = computed(() => rows.value.find((r) => r.employee_id === employeeId.value && r.date === new Date().toISOString().slice(0, 10)));
const today = computed(() => todayRecord.value || null);

async function load() {
  try { rows.value = await api.attendance({ month: month.value }); } catch (e) { alert(e.message); }
}
async function loadEmployees() {
  try {
    employees.value = await api.employees({ status: 'active' });
    // 复制一份用于编辑：直接改 employees 会把"已保存的值"和"输入框里的值"混在一起
    bindRows.value = employees.value.map((e) => ({ ...e, _dt: e.dingtalk_userid || '' }));
  } catch (e) { /* ignore */ }
}
async function clock(type) {
  if (!employeeId.value) return;
  busy.value = true;
  try { await api.clockAttendance(employeeId.value, type); await load(); }
  catch (e) { alert(e.message); } finally { busy.value = false; }
}

async function loadDt() {
  try {
    dt.value.status = await api.dingtalkStatus();
    dt.value.runs = await api.dingtalkRuns({ limit: 5 });
  } catch (e) {
    // 只有 admin/hr 能读打卡口径；其它角色打开这页不该看到红色报错
    if (/权限|403|forbidden/i.test(String(e.message || ''))) dtDenied.value = true;
  }
}

async function runProbe() {
  dtBusy.value = true;
  try { dt.value.probe = await api.dingtalkProbe(); }
  catch (e) { alert(e.message); } finally { dtBusy.value = false; }
}

async function runSync(dry) {
  dtBusy.value = true;
  try {
    dt.value.result = await api.dingtalkSync({ days: 3, dry_run: dry });
    await loadDt();
    await load();
  } catch (e) { alert(e.message); } finally { dtBusy.value = false; }
}

async function saveMap(e) {
  dtBusy.value = true;
  try {
    const uid = String(e._dt || '').trim();
    await api.dingtalkMap({ employee_id: e.id, dingtalk_userid: uid });
    e.dingtalk_userid = uid;
    await loadDt();
  } catch (err) { alert(err.message); } finally { dtBusy.value = false; }
}

async function clearMap(e) {
  e._dt = '';
  await saveMap(e);
}

onMounted(async () => {
  await loadEmployees();
  await load();
  await loadDt();
});
</script>

<style scoped>
.clock-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.clock-select { width: 220px; }
.clock-btns { display: flex; gap: 10px; }

/* 钉钉同步 */
.dt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.dt-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dt-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: #33415a; margin: 0 0 8px; }
.dt-hint { background: #fff8e8; border: 1px solid #f3dfae; color: #8a5a00; font-size: 12px; line-height: 1.7; padding: 10px 12px; border-radius: 8px; margin: 0 0 10px; }
.dt-probe { background: #f7f9fc; border: 1px solid #e6ebf3; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.dt-step { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
.dt-result { font-size: 13px; color: #16233b; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 6px; }
.dt-sub { font-size: 12px; color: #6b7a90; margin: 14px 0 8px; }
.dt-input { width: 100%; max-width: 260px; }

/* 手机上：员工下拉占满一行，两个打卡按钮左右各半，拇指够得着 */
@media (max-width: 480px) {
  .clock-select { width: 100%; }
  .clock-btns { width: 100%; }
  .clock-btns .btn { flex: 1; padding: 11px 0; }
  .dt-actions { width: 100%; }
  .dt-actions .btn { flex: 1; }
}
</style>
