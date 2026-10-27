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

const statusLabel = (s) => ({ normal: '正常', late: '迟到', leave: '请假', absent: '缺勤' }[s] || s);
const todayRecord = computed(() => rows.value.find((r) => r.employee_id === employeeId.value && r.date === new Date().toISOString().slice(0, 10)));
const today = computed(() => todayRecord.value || null);

async function load() {
  try { rows.value = await api.attendance({ month: month.value }); } catch (e) { alert(e.message); }
}
async function loadEmployees() {
  try { employees.value = await api.employees({ status: 'active' }); } catch (e) { /* ignore */ }
}
async function clock(type) {
  if (!employeeId.value) return;
  busy.value = true;
  try { await api.clockAttendance(employeeId.value, type); await load(); }
  catch (e) { alert(e.message); } finally { busy.value = false; }
}

onMounted(async () => {
  await loadEmployees();
  await load();
});
</script>

<style scoped>
.clock-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.clock-select { width: 220px; }
.clock-btns { display: flex; gap: 10px; }
/* 手机上：员工下拉占满一行，两个打卡按钮左右各半，拇指够得着 */
@media (max-width: 480px) {
  .clock-select { width: 100%; }
  .clock-btns { width: 100%; }
  .clock-btns .btn { flex: 1; padding: 11px 0; }
}
</style>
