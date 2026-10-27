<template>
  <div>
    <div class="page-head">
      <div>
        <h2>操作日志</h2>
        <div class="sub">所有写操作留痕（新增 / 修改 / 删除），仅管理员可见</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <div class="toolbar" style="margin-bottom: 14px">
      <select class="select" v-model="method" @change="load">
        <option value="">全部方法</option>
        <option value="POST">POST</option>
        <option value="PUT">PUT</option>
        <option value="PATCH">PATCH</option>
        <option value="DELETE">DELETE</option>
      </select>
      <input class="input" v-model="q" placeholder="搜索 账号 / 路径" @keyup.enter="load" style="width: 260px" />
      <button class="btn btn-ghost" @click="load">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>时间</th><th>账号</th><th>方法</th><th>路径</th><th>状态码</th><th>IP</th></tr></thead>
        <tbody>
          <tr v-for="l in list" :key="l.id">
            <td>{{ dateStr(l.created_at) }}</td>
            <td>{{ l.username }}</td>
            <td><span class="tag" :class="tagOf(l.method)">{{ l.method }}</span></td>
            <td style="font-family: monospace; font-size: 12px">{{ l.path }}</td>
            <td :style="{ color: l.status >= 400 ? '#d92d45' : '#16a34a', fontWeight: 600 }">{{ l.status }}</td>
            <td>{{ l.ip }}</td>
          </tr>
          <tr v-if="!list.length"><td colspan="6" class="empty-cell">暂无日志</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const list = ref([]);
const method = ref('');
const q = ref('');

const dateStr = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');
const tagOf = (m) => ({ POST: 'green', PUT: 'blue', PATCH: 'blue', DELETE: 'red' }[m] || 'gray');

async function load() {
  try { list.value = await api.auditLogs({ method: method.value, q: q.value, limit: 300 }); }
  catch (e) { alert(e.message); }
}
onMounted(load);
</script>
