<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>数据隐私与访问审计</h2>
        <p class="sub">
          身份证、手机号、工资、合同金额这些字段，<b>服务端返回时就已经是掩码</b>，不是前端藏起来的。
          谁能看明文由权限点决定 —— <b>管理员的技术权限不默认可读工资</b>，
          需要时走「一次性查看」，必须写理由，每次都留痕。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
      </div>
    </div>

    <div class="cards c4">
      <div class="stat-card accent">
        <div class="label">生效的字段规则</div>
        <div class="value">{{ stats.rules || 0 }}<small>条</small></div>
        <div class="foot">覆盖 {{ stats.tables || 0 }} 张表</div>
      </div>
      <div class="stat-card">
        <div class="label">今日访问留痕</div>
        <div class="value">{{ stats.today || 0 }}<small>次</small></div>
        <div class="foot">累计 {{ stats.logs || 0 }} 次</div>
      </div>
      <div class="stat-card" :class="{ danger: stats.reveals > 0 }">
        <div class="label">一次性查看</div>
        <div class="value">{{ stats.reveals || 0 }}<small>次</small></div>
        <div class="foot">无权限者查看明文（都写了理由）</div>
      </div>
      <div class="stat-card">
        <div class="label">导出留痕</div>
        <div class="value">{{ stats.exports || 0 }}<small>次</small></div>
        <div class="foot">含敏感字段的导出</div>
      </div>
    </div>

    <div class="panel-card">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'rules' }" @click="tab = 'rules'">脱敏规则</button>
          <button :class="{ on: tab === 'logs' }" @click="switchLogs">访问日志</button>
          <button :class="{ on: tab === 'reveal' }" @click="tab = 'reveal'">一次性查看</button>
        </div>
        <input v-if="tab === 'logs'" v-model="q" class="input" style="width: 190px" placeholder="账号 / 表名" />
      </div>

      <!-- 规则 -->
      <div v-if="tab === 'rules'">
        <div class="warn-box">
          <b>「留痕」开关对工资、合同、银行三类不可关闭</b> —— 关掉等于给「悄悄看」开后门。
          改规则立即生效（新请求就开始用），不影响已经返回的数据。
        </div>
        <div v-for="t in rules" :key="t.table_name" class="rule-block">
          <div class="rb-title">{{ tableLabel(t.table_name) }} <span class="mut">（{{ t.table_name }}）</span></div>
          <table class="data">
            <thead>
              <tr>
                <th>字段</th><th style="width: 110px">掩码方式</th><th style="width: 150px">保留位数</th>
                <th style="width: 150px">所需权限点</th><th style="width: 96px">留痕</th><th style="width: 90px">需理由</th>
                <th style="width: 70px">启用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in t.fields" :key="f.id">
                <td>
                  <div>{{ f.label }} <span class="mut">{{ f.field_name }}</span></div>
                  <div class="mut" v-if="f.note">{{ f.note }}</div>
                </td>
                <td>
                  <select v-model="f.mask_type" class="select" :disabled="!canAdmin" @change="saveRule(f)">
                    <option value="partial">部分保留</option>
                    <option value="hide">完全隐藏</option>
                  </select>
                </td>
                <td>
                  <div v-if="f.mask_type === 'partial'" class="keep-box">
                    <input v-model.number="f.keep_prefix" class="input" style="width: 44px" type="number" :disabled="!canAdmin" @change="saveRule(f)" />
                    <span class="mut">前 /</span>
                    <input v-model.number="f.keep_suffix" class="input" style="width: 44px" type="number" :disabled="!canAdmin" @change="saveRule(f)" />
                    <span class="mut">后</span>
                  </div>
                  <span v-else class="mut">—</span>
                </td>
                <td><span class="tag blue">{{ f.required_perm }}</span></td>
                <td>
                  <div class="log-box">
                    <span class="tag" :class="f.log_access ? 'green' : 'gray'">{{ f.log_access ? '开' : '关' }}</span>
                    <span v-if="isHardLog(f)" class="lock" title="工资/合同/银行类不允许关闭留痕">锁定</span>
                  </div>
                </td>
                <td>
                  <input v-model="f.require_reason" type="checkbox" :disabled="!canAdmin" @change="saveRule(f)" />
                </td>
                <td>
                  <input v-model="f.enabled" type="checkbox" :disabled="!canAdmin" @change="saveRule(f)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!rules.length" class="empty-cell">还没有配置脱敏规则</div>
      </div>

      <!-- 日志 -->
      <div class="table-wrap" v-if="tab === 'logs'">
        <table class="data log-tbl">
          <thead>
            <tr>
              <th style="width: 140px">时间</th><th style="width: 110px">账号</th>
              <th style="width: 90px">角色</th><th style="width: 190px">表.字段</th>
              <th style="width: 112px">动作</th><th style="width: 104px">授权</th>
              <th style="width: 70px">条数</th><th>理由</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in filteredLogs" :key="l.id">
              <td class="mut">{{ (l.created_at || '').slice(0, 16).replace('T', ' ') }}</td>
              <td>{{ l.user_name || l.username }}</td>
              <td class="mut">{{ l.role }}</td>
              <td class="mut">{{ l.table_name }}.{{ l.field_name }}</td>
              <td><span class="tag" :class="actTag(l.action)">{{ l.action_label }}</span></td>
              <td>
                <span class="tag" :class="l.granted ? 'green' : 'orange'">{{ l.granted_label }}</span>
              </td>
              <td>{{ l.row_count }}</td>
              <td class="mut">{{ l.reason || '—' }}</td>
            </tr>
            <tr v-if="!filteredLogs.length"><td colspan="8" class="empty-cell">还没有访问记录</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 一次性查看 -->
      <div v-if="tab === 'reveal'">
        <div class="warn-box">
          这个功能是给「没有该字段权限但确实需要核对」的人用的（比如运维排障）。
          <b>必须写理由，一次只查一条记录的字段</b>，每次都进审计日志。
          有权限的人直接用业务页面就行，不必走这里。
        </div>
        <div class="reveal-form">
          <div class="rf-row">
            <label>表</label>
            <select v-model="rv.table_name" class="select" style="width: 180px">
              <option v-for="t in meta.tables || []" :key="t.code" :value="t.code">{{ t.label }}</option>
            </select>
            <label>字段</label>
            <select v-model="rv.field_name" class="select" style="width: 200px">
              <option v-for="f in curFields" :key="f.id" :value="f.field_name">{{ f.label }}</option>
            </select>
            <label>记录 ID</label>
            <input v-model.number="rv.target_id" class="input" style="width: 100px" type="number" placeholder="如 12" />
          </div>
          <div class="rf-row">
            <label>理由</label>
            <input v-model="rv.reason" class="input" style="flex: 1" placeholder="为什么要看这个字段（至少 6 个字，会进审计日志）" />
            <button class="btn btn-primary" @click="doReveal">查看</button>
          </div>
        </div>
        <div v-if="rvResult" class="rv-result">
          <div class="rv-h">{{ rvResult.label }} · {{ rvResult.target_label || ('#' + rvResult.target_id) }}</div>
          <div class="rv-val">{{ rvResult.value === null || rvResult.value === '' ? '（该字段没有值）' : rvResult.value }}</div>
          <div class="mut">{{ rvResult.note }}</div>
          <div class="mut" v-if="rvResult.granted_by === 'reason'">授权方式：写理由后一次性查看</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canAdmin = computed(() => can('privacy.admin'));

const tab = ref('rules');
const q = ref('');
const rules = ref([]);
const logs = ref([]);
const stats = ref({});
const meta = ref({ tables: [] });
const rv = reactive({ table_name: 'employees', field_name: '', target_id: null, reason: '' });
const rvResult = ref(null);

const TABLE_LABEL = { employees: '员工', customers: '客户', suppliers: '供应商', payrolls: '工资单', admin_contracts: '行政合同' };
const tableLabel = (t) => TABLE_LABEL[t] || t;
const actTag = (a) => ({ list: 'blue', view: 'blue', export: 'purple', reveal: 'orange' }[a] || 'gray');
const isHardLog = (f) => ['payroll', 'bank', 'contract'].includes(f.category);

const curFields = computed(() => {
  const t = rules.value.find((x) => x.table_name === rv.table_name);
  return t ? t.fields : [];
});

const filteredLogs = computed(() => {
  if (!q.value) return logs.value;
  const k = q.value.toLowerCase();
  return logs.value.filter((l) => (l.username || '').toLowerCase().includes(k)
    || (l.user_name || '').toLowerCase().includes(k)
    || (l.table_name || '').toLowerCase().includes(k));
});

async function load() {
  const [r, s, m] = await Promise.all([api.pvRules(), api.pvStats(), api.pvMeta()]);
  rules.value = r;
  stats.value = s;
  meta.value = m;
  if (!rv.field_name && curFields.value.length) rv.field_name = curFields.value[0].field_name;
}

async function reload() {
  await load();
  if (tab.value === 'logs') logs.value = await api.pvLogs({});
}

async function switchLogs() {
  tab.value = 'logs';
  logs.value = await api.pvLogs({});
}

async function saveRule(f) {
  try {
    rules.value = await api.pvSaveRule(f.id, {
      mask_type: f.mask_type,
      keep_prefix: f.keep_prefix,
      keep_suffix: f.keep_suffix,
      required_perm: f.required_perm,
      log_access: f.log_access,
      require_reason: f.require_reason,
      enabled: f.enabled
    });
    stats.value = await api.pvStats();
  } catch (e) {
    alert(e.message);
    await load();
  }
}

async function doReveal() {
  rvResult.value = null;
  try {
    rvResult.value = await api.pvReveal({ ...rv });
    stats.value = await api.pvStats();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(load);
</script>

<style scoped>
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.cards.c4 { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.stat-card.danger { border-color: #f5c2c7; background: #fff8f8; }
.stat-card .foot { font-size: 11px; line-height: 1.45; }

.rule-block { margin-bottom: 18px; }
/* 日志表：标签不许折行；「表.字段」里的长字段串要在格子里断，不能撑宽整张表 */
.log-tbl .tag { white-space: nowrap; }
.log-tbl td:nth-child(4) { max-width: 190px; overflow-wrap: anywhere; font-size: 11.5px; }
.log-tbl td:nth-child(8) { min-width: 220px; }
.log-tbl td { vertical-align: middle; }
.rule-block table.data td { vertical-align: middle; }
/* 保留位数与留痕都不能折行：120px 里塞两个输入框加中文，竖排会完全读不懂 */
.keep-box, .log-box { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
/* 44px 的输入框扣掉默认 padding 只剩 22px，数字会被裁成半个字符 */
.keep-box .input { padding: 3px 4px; text-align: center; }
.lock { font-size: 10.5px; color: #b45309; background: #fff7e6; border-radius: 4px; padding: 1px 4px; }
.rb-title { font-size: 13px; font-weight: 700; color: #16233b; margin: 0 0 6px; }
.mut { color: #8a94a6; font-size: 11.6px; line-height: 1.5; }
.warn-box { background: #fffaf0; border: 1px solid #f2dfae; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; color: #7a6420; line-height: 1.7; margin-bottom: 14px; }

.reveal-form { background: #f8fafd; border: 1px solid #e6ebf3; border-radius: 10px; padding: 14px; }
.rf-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.rf-row label { font-size: 12.5px; color: #5b6474; min-width: 52px; }
.rv-result { margin-top: 14px; background: #f4fbf6; border: 1px solid #cfe9d8; border-radius: 10px; padding: 12px 16px; }
.rv-h { font-size: 12.8px; font-weight: 700; color: #166534; margin-bottom: 6px; }
.rv-val { font-size: 20px; font-weight: 800; color: #16305f; letter-spacing: .5px; margin-bottom: 6px; }

@media (max-width: 860px) {
  .page-head { flex-direction: column; align-items: flex-start; gap: 10px; }
  .head-ops { flex-wrap: wrap; width: 100%; }
  .tabs { flex-wrap: wrap; }
  .tabs button { white-space: nowrap; }
  .rf-row { flex-direction: column; align-items: stretch; }
  .rf-row label { min-width: 0; }
}
</style>
