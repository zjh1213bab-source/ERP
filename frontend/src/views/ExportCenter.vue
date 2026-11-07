<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>数据导出与订阅</h2>
        <div class="sub">
          数据出系统的最后一米：导什么、谁导的、带没带水印、掩了哪些字段 —— 这里全记着。
          只能从白名单选，不能自定义表。
        </div>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canSub" class="btn btn-primary" @click="runDue" :disabled="running">
          {{ running ? '执行中…' : `执行到期订阅${stats.due_subs ? '（' + stats.due_subs + ' 条到期）' : ''}` }}
        </button>
      </div>
    </div>

    <div class="cards c6">
      <div class="stat-card">
        <div class="label">本月导出</div>
        <div class="value">{{ stats.month_count || 0 }}<span class="unit">次</span></div>
        <div class="foot">{{ stats.month_rows || 0 }} 行 · 累计 {{ stats.total || 0 }} 次</div>
      </div>
      <div class="stat-card warn">
        <div class="label">敏感及以上</div>
        <div class="value">{{ stats.sensitive_count || 0 }}<span class="unit">次</span></div>
        <div class="foot">带水印、可反查到人</div>
      </div>
      <div class="stat-card">
        <div class="label">被掩码的行</div>
        <div class="value">{{ stats.masked_rows || 0 }}</div>
        <div class="foot">按字段权限在服务端掩掉</div>
      </div>
      <div class="stat-card">
        <div class="label">小样本抑制</div>
        <div class="value">{{ stats.suppressed_rows || 0 }}<span class="unit">组</span></div>
        <div class="foot">人数太少的分组不外发数值</div>
      </div>
      <div class="stat-card" :class="{ warn: stats.due_subs > 0 }">
        <div class="label">到期未执行</div>
        <div class="value">{{ stats.due_subs || 0 }}<span class="unit">条</span></div>
        <div class="foot">本部署无后台调度器，需点右上执行</div>
      </div>
      <div class="stat-card">
        <div class="label">待领取产出</div>
        <div class="value">{{ stats.pending_deliveries || 0 }}<span class="unit">份</span></div>
        <div class="foot">订阅生成后等收件人取</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'export' }" @click="tab = 'export'">导出中心</button>
          <button :class="{ on: tab === 'subs' }" @click="switchTab('subs')">
            周期订阅<span v-if="stats.due_subs" class="dot"></span>
          </button>
          <button :class="{ on: tab === 'jobs' }" @click="switchTab('jobs')">导出记录</button>
          <button :class="{ on: tab === 'trace' }" @click="switchTab('trace')">
            水印反查与产出<span v-if="stats.pending_deliveries" class="dot"></span>
          </button>
        </div>
        <div class="head-ops tiny mut" v-if="tab === 'jobs'">
          {{ jobScope === 'all' ? '可看全部人的导出记录（审计权限）' : '只显示你自己导的（看全部需要审计权限）' }}
        </div>
      </div>

      <!-- ==================== 导出中心 ==================== -->
      <div v-if="tab === 'export'" class="ex-grid">
        <div class="def-list">
          <div v-for="g in grouped" :key="g.module" class="def-group">
            <div class="def-group-h">{{ g.module }}</div>
            <a v-for="d in g.items" :key="d.def_key" class="def-item"
               :class="{ on: cur.def_key === d.def_key, off: !d.allowed }" @click="pick(d)">
              <div class="di-top">
                <span class="di-name">{{ d.name }}</span>
                <span class="tag" :class="sensCls(d.sensitivity)">{{ d.sensitivity_label }}</span>
              </div>
              <div class="tiny mut di-meta">
                {{ d.col_count }} 列<template v-if="d.perm"> · 需 {{ d.perm }}</template>
                <template v-if="!d.allowed"> · 无权限</template>
              </div>
            </a>
          </div>
        </div>

        <div class="def-main">
          <div v-if="!cur.def_key" class="empty">左边选一个数据集</div>
          <template v-else>
            <div class="dm-head">
              <div>
                <b>{{ cur.name }}</b>
                <span class="tag" :class="sensCls(cur.sensitivity)" style="margin-left: 6px">{{ cur.sensitivity_label }}</span>
              </div>
              <div class="tiny mut">
                单次上限 {{ cur.row_cap }} 行 · {{ cur.columns.length }} 列
                <template v-if="cur.small_sample"> · 小样本阈值 &lt;{{ cur.small_sample_min }} 人抑制</template>
              </div>
            </div>

            <div v-if="cur.note" class="notice">{{ cur.note }}</div>
            <div v-if="!cur.allowed" class="notice-warn">
              你没有「{{ cur.perm }}」权限，这个数据集只能看定义、不能导出（连预览也会被拒）。
            </div>

            <div class="params">
              <div v-for="p in cur.params" :key="p" class="pfield">
                <label>{{ paramLabel(p) }}</label>
                <input v-if="isDate(p)" v-model="paramVals[p]" class="input" type="date" />
                <input v-else-if="p === 'period'" v-model="paramVals[p]" class="input" type="month" />
                <input v-else v-model="paramVals[p]" class="input" :placeholder="paramHint(p)" />
              </div>
              <button class="btn btn-ghost" @click="doPreview" :disabled="!cur.allowed || previewing">
                {{ previewing ? '取数中…' : '预览前 5 行' }}
              </button>
            </div>

            <div class="cols-row">
              <span class="tiny mut">导出列（白名单，不可增删）：</span>
              <span v-for="c in cur.columns" :key="c.key" class="col-chip">{{ c.label }}</span>
            </div>

            <div v-if="preview" class="preview">
              <div class="pv-head">
                <b>预览</b>
                <span class="tiny mut">
                  命中 {{ preview.total_rows }} 行
                  <template v-if="preview.suppressed_rows"> · 小样本抑制 {{ preview.suppressed_rows }} 组</template>
                  （以下是脱敏后的样子，与导出完全一致）
                </span>
                <span v-if="preview.masked_fields && preview.masked_fields.length" class="mask-warn">
                  其中 {{ preview.masked_fields.join('、') }} 会按字段权限掩码 —— 导出后这些列是空的，不是系统坏了
                </span>
              </div>
              <div class="table-wrap">
                <table class="data">
                  <thead><tr><th v-for="c in preview.columns" :key="c.key">{{ c.label }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(row, i) in preview.sample" :key="i">
                      <td v-for="c in preview.columns" :key="c.key" class="tiny">{{ row[c.label] }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="!preview.sample.length" class="empty">这个条件下一行都没有</div>
            </div>

            <div class="run-box">
              <div class="rb-row">
                <label>导出理由（必填）</label>
                <input v-model="reason" class="input" style="flex: 1; min-width: 240px"
                       placeholder="例：月末与客户对账，需要未收明细" />
              </div>
              <div class="rb-foot">
                <span class="tiny mut">
                  导出的每一份文件都带水印；没有理由的导出记录，三个月后没人知道那次是干什么的。
                </span>
                <button class="btn btn-primary" :disabled="!cur.allowed || exporting" @click="doExport">
                  {{ exporting ? '生成中…' : '导出 CSV' }}
                </button>
              </div>
            </div>

            <div v-if="lastResult" class="hint-box">
              <b>已生成</b> {{ lastResult.jobNo }} · {{ lastResult.rows }} 行
              <template v-if="lastResult.maskedFields"> · 掩码字段：{{ lastResult.maskedFields }}</template>
              <br />水印 <code>{{ lastResult.watermark }}</code> —— 这份文件被转手，凭它就能查到是谁导的。
            </div>
          </template>
        </div>
      </div>

      <!-- ==================== 周期订阅 ==================== -->
      <div v-if="tab === 'subs'">
        <div v-if="stats.due_subs" class="notice-warn">
          有 {{ stats.due_subs }} 条订阅已到期该跑了，点右上「执行到期订阅」。
          本部署没有后台调度器（不引入隐式定时任务，避免和备份抢库），所以要么人点、要么运维用 crontab 调接口。
        </div>
        <div class="toolbar">
          <button v-if="canSub" class="btn btn-primary" @click="openSub">＋ 新建订阅</button>
          <span class="sp"></span>
          <span class="tiny mut">订阅必须有到期日 —— 没有到期日的订阅会一直跑下去，换岗离职也没人停</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 74px">编号</th>
                <th>订阅</th>
                <th style="width: 150px">数据集</th>
                <th style="width: 96px">频率</th>
                <th style="width: 104px">渠道</th>
                <th style="width: 170px">收件人</th>
                <th style="width: 116px">下次执行</th>
                <th style="width: 92px">状态</th>
                <th style="width: 178px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in subs" :key="s.id">
                <td class="nowrap tiny">{{ s.sub_no }}</td>
                <td>
                  <div class="subj">{{ s.name }}</div>
                  <div class="tiny mut clamp2">{{ s.note }}</div>
                </td>
                <td class="tiny">{{ s.def_name }}</td>
                <td class="tiny nowrap">{{ s.freq_label }}<div class="mut">{{ s.schedule_text }}</div></td>
                <td class="tiny nowrap">{{ s.channel_label }}</td>
                <td class="tiny">{{ s.recipients.join('、') }}</td>
                <td class="tiny nowrap">
                  <span :class="{ red: s.overdue }">{{ s.next_run_at || '—' }}</span>
                  <div class="mut">已跑 {{ s.run_count }} 次</div>
                </td>
                <td><span class="tag" :class="subCls(s.status)">{{ s.status_label }}</span></td>
                <td class="ops">
                  <template v-if="canSub">
                    <button v-if="s.status === 'active'" class="btn btn-sm btn-ghost" @click="subAction('pause', s)">暂停</button>
                    <button v-if="s.status === 'paused'" class="btn btn-sm btn-ghost" @click="subAction('resume', s)">恢复</button>
                    <button v-if="s.status !== 'expired'" class="btn btn-sm btn-ghost" @click="subAction('cancel', s)">终止</button>
                    <span v-if="s.status === 'expired'" class="tiny mut">已终止</span>
                  </template>
                  <span v-else class="tiny mut">只读</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!subs.length" class="empty">还没有订阅。订阅解决的是「每月都要手动导一次同样的表」。</div>
        <div class="hint-box">
          口径：订阅执行时用<b>订阅人自己的权限</b>取数 —— 换岗后被收掉的权限，订阅也会跟着停（会报错并留下记录）。
          邮件渠道在本部署<b>没有配置 SMTP</b>，投递会标「通道未配置」，产出落站内可取；不假装发成功。
        </div>
      </div>

      <!-- ==================== 导出记录 ==================== -->
      <div v-if="tab === 'jobs'">
        <div class="toolbar">
          <input v-model="jobQ" class="input" style="width: 200px" placeholder="单号 / 数据集 / 人 / 水印" @keyup.enter="loadJobs" />
          <select v-model="jobTrigger" class="select" @change="loadJobs">
            <option value="">全部触发方式</option>
            <option value="manual">手工导出</option>
            <option value="subscription">订阅执行</option>
          </select>
          <button class="btn btn-ghost" @click="loadJobs">查询</button>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 130px">单号</th>
                <th>数据集</th>
                <th style="width: 66px">敏感级</th>
                <th style="width: 86px">触发</th>
                <th style="width: 70px" class="num">行数</th>
                <th style="width: 160px">掩码字段</th>
                <th style="width: 190px">水印</th>
                <th style="width: 96px">导出人</th>
                <th style="width: 116px">时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="j in jobs" :key="j.id">
                <td class="nowrap tiny">{{ j.job_no }}</td>
                <td>
                  <div>{{ j.def_name }}</div>
                  <div v-if="j.reason" class="tiny mut clamp1" :title="j.reason">{{ j.reason }}</div>
                </td>
                <td><span class="tag" :class="sensCls(j.sensitivity)">{{ j.sensitivity_label }}</span></td>
                <td class="tiny nowrap">{{ j.trigger_label }}<div v-if="j.sub_no" class="mut">{{ j.sub_no }}</div></td>
                <td class="num tiny">{{ j.row_count }}</td>
                <td class="tiny">
                  <span v-if="j.masked_field_list.length">{{ j.masked_field_list.join('、') }}</span>
                  <span v-else class="mut">—</span>
                  <div v-if="j.suppressed_rows" class="mut">抑制 {{ j.suppressed_rows }} 组</div>
                </td>
                <td class="tiny wm">{{ j.watermark }}</td>
                <td class="tiny nowrap">{{ j.requester_name }}<div class="mut">{{ j.requester }}</div></td>
                <td class="tiny nowrap">{{ j.created_local }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!jobs.length" class="empty">这段时间没有导出记录</div>
      </div>

      <!-- ==================== 水印反查与产出 ==================== -->
      <div v-if="tab === 'trace'">
        <div class="trace-box">
          <div class="tb-h">水印反查</div>
          <div class="tiny mut" style="margin-bottom: 8px">
            把文件开头的注释行，或末列里的水印串贴进来（形如
            <code>EXP-CK202610280001-20261028-A7F3</code>）。也可以只贴单号。
          </div>
          <div class="tb-row">
            <input v-model="traceToken" class="input" style="flex: 1; min-width: 260px" placeholder="粘贴水印或导出单号" @keyup.enter="doTrace" />
            <button class="btn btn-primary" @click="doTrace" :disabled="tracing">反查</button>
          </div>
          <div v-if="traceErr" class="notice-warn" style="margin-top: 10px">{{ traceErr }}</div>
          <div v-if="traceRes" class="trace-res">
            <div class="kv"><span>导出单号</span><b>{{ traceRes.job_no }}</b></div>
            <div class="kv"><span>数据集</span><b>{{ traceRes.def_name }}</b></div>
            <div class="kv"><span>导出人</span><b>{{ traceRes.requester_name }}（{{ traceRes.requester || '—' }}）</b></div>
            <div class="kv"><span>导出时间</span><b>{{ traceRes.created_local }}</b></div>
            <div class="kv"><span>行数</span><b>{{ traceRes.row_count }} 行</b></div>
            <div class="kv"><span>导出理由</span><b>{{ traceRes.reason || '—' }}</b></div>
            <div class="kv"><span>掩码字段</span><b>{{ traceRes.masked_field_list && traceRes.masked_field_list.length ? traceRes.masked_field_list.join('、') : '无' }}</b></div>
            <div class="kv"><span>匹配方式</span><b>{{ traceRes.matched_by === 'watermark' ? '水印完全匹配' : '按单号匹配' }}</b></div>
            <div v-if="traceRes.partial" class="tiny mut" style="margin-top: 6px">
              你能确认「有这么一次导出」，但看全部信息需要审计权限（人事 / 财务 / 管理员）。
            </div>
          </div>
        </div>

        <div class="col-h" style="margin-top: 18px">我的订阅产出</div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th style="width: 200px">订阅</th>
                <th>数据集</th>
                <th style="width: 130px">单号</th>
                <th style="width: 70px" class="num">行数</th>
                <th style="width: 110px">状态</th>
                <th style="width: 70px" class="num">下载</th>
                <th style="width: 116px">生成时间</th>
                <th style="width: 96px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in deliveries" :key="d.id">
                <td>
                  <div>{{ d.sub_name || '（订阅已删除）' }}</div>
                  <div class="tiny mut">{{ d.sub_no }}</div>
                </td>
                <td class="tiny">{{ d.def_name }}</td>
                <td class="tiny nowrap">{{ d.job_no }}</td>
                <td class="num tiny">{{ d.row_count }}</td>
                <td>
                  <span class="tag" :class="delivCls(d.status)">{{ d.status_label }}</span>
                  <div v-if="d.notify_note" class="tiny mut clamp2" :title="d.notify_note">{{ d.notify_note }}</div>
                </td>
                <td class="num tiny">{{ d.download_count }}</td>
                <td class="tiny nowrap">{{ d.created_at ? d.created_at.slice(0, 16).replace('T', ' ') : '' }}</td>
                <td>
                  <button class="btn btn-sm btn-primary" @click="take(d)" :disabled="d.status === 'failed'">领取</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!deliveries.length" class="empty">还没有发给你（或你创建的）订阅产出</div>
      </div>
    </div>

    <!-- ================= 新建订阅 ================= -->
    <div class="modal-mask" v-if="subForm.open">
      <div class="modal">
        <div class="modal-head"><b>新建订阅</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="subForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            订阅 = 到点自动按同样条件导一份，放进收件人的「我的订阅产出」。
            <b>必须有到期日</b>，最长两年；到期不续就停。
          </div>
          <div class="row">
            <label>名称</label>
            <input v-model="subForm.name" class="input" style="flex: 1; min-width: 240px" placeholder="每月 1 日 · 应收账龄给财务" />
          </div>
          <div class="row">
            <label>数据集</label>
            <select v-model="subForm.def_key" class="select" style="width: 260px">
              <option value="">选择数据集</option>
              <option v-for="d in allowedDefs" :key="d.def_key" :value="d.def_key">{{ d.name }}（{{ d.sensitivity_label }}）</option>
            </select>
          </div>
          <div class="row">
            <label>频率</label>
            <select v-model="subForm.freq" class="select" style="width: 120px">
              <option value="monthly">每月</option>
              <option value="weekly">每周</option>
            </select>
            <template v-if="subForm.freq === 'monthly'">
              <label>几号</label>
              <select v-model.number="subForm.day_of_month" class="select" style="width: 100px">
                <option v-for="n in 28" :key="n" :value="n">{{ n }} 日</option>
              </select>
            </template>
            <template v-else>
              <label>周几</label>
              <select v-model.number="subForm.day_of_week" class="select" style="width: 110px">
                <option v-for="(w, i) in ['一', '二', '三', '四', '五', '六', '日']" :key="i" :value="i + 1">周{{ w }}</option>
              </select>
            </template>
          </div>
          <div class="row">
            <label>渠道</label>
            <select v-model="subForm.channel" class="select" style="width: 160px">
              <option value="inbox">站内可取</option>
              <option value="email">邮件（本部署未配置）</option>
            </select>
            <span class="tiny mut">邮件通道未配置时，投递会标「通道未配置」，产出仍在站内可取</span>
          </div>
          <div class="row">
            <label>收件人</label>
            <div class="recips">
              <label v-for="u in users" :key="u.username" class="ck">
                <input type="checkbox" :value="u.username" v-model="subForm.recipients" />
                {{ u.name }}<span class="mut tiny">（{{ u.username }}）</span>
              </label>
            </div>
          </div>
          <div class="row">
            <label>生效期</label>
            <input v-model="subForm.valid_from" class="input" type="date" style="width: 156px" />
            <span class="mut">至</span>
            <input v-model="subForm.valid_until" class="input" type="date" style="width: 156px" />
            <span class="tiny mut">必填，最长两年</span>
          </div>
          <div class="row">
            <label>用途</label>
            <input v-model="subForm.note" class="input" style="flex: 1; min-width: 240px" placeholder="这份数据定期发给谁、用来做什么（至少 4 字）" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="subForm.open = false">取消</button>
            <button class="btn btn-primary" @click="saveSub" :disabled="saving">创建</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, downloadPost } from '../api';

const tab = ref('export');
const meta = ref({ defs: [], users: [], stats: {} });
const stats = computed(() => meta.value.stats || {});
const users = computed(() => meta.value.users || []);
const canRun = computed(() => !!meta.value.can_run);
const canSub = computed(() => !!meta.value.can_subscribe);
const canAudit = computed(() => !!meta.value.can_audit);

const grouped = computed(() => {
  const map = new Map();
  (meta.value.defs || []).forEach((d) => {
    const m = d.module || '其它';
    if (!map.has(m)) map.set(m, []);
    map.get(m).push(d);
  });
  return Array.from(map.entries()).map(([module, items]) => ({ module, items }));
});
const allowedDefs = computed(() => (meta.value.defs || []).filter((d) => d.allowed));

const cur = ref({});
const paramVals = reactive({});
const preview = ref(null);
const previewing = ref(false);
const reason = ref('');
const exporting = ref(false);
const lastResult = ref(null);

const subs = ref([]);
const jobs = ref([]);
const deliveries = ref([]);
const jobQ = ref('');
const jobTrigger = ref('');
const jobScope = ref('self');

const traceToken = ref('');
const traceRes = ref(null);
const traceErr = ref('');
const tracing = ref(false);

const running = ref(false);
const saving = ref(false);

const subForm = reactive({
  open: false, name: '', def_key: '', freq: 'monthly', day_of_month: 1, day_of_week: 1,
  channel: 'inbox', recipients: [], valid_from: '', valid_until: '', note: ''
});

const SENS_CLS = { normal: 'gray', sensitive: 'orange', restricted: 'red' };
const sensCls = (s) => SENS_CLS[s] || 'gray';
const subCls = (s) => ({ active: 'green', paused: 'orange', expired: 'gray' }[s] || 'gray');
const delivCls = (s) => ({ pending: 'orange', taken: 'green', blocked: 'gray', failed: 'red' }[s] || 'gray');

const PARAM_LABEL = {
  as_of: '截至日期', from: '起始日期', to: '结束日期', period: '月份',
  status: '状态', level: '客户等级', kind: '实物类别', warehouse: '仓库', department_id: '部门ID'
};
const PARAM_HINT = {
  status: 'active / paid 等，留空=全部',
  level: 'A / B / C，留空=全部',
  kind: 'uniform / key / tool 等',
  warehouse: '仓库名，留空=全部',
  department_id: '数字，留空=全部'
};
const paramLabel = (p) => PARAM_LABEL[p] || p;
const paramHint = (p) => PARAM_HINT[p] || '留空=不限';
const isDate = (p) => ['as_of', 'from', 'to'].includes(p);

function todayStr(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadMeta() {
  meta.value = await api.exMeta();
}

async function reload() {
  await loadMeta();
  if (tab.value === 'subs') await loadSubs();
  if (tab.value === 'jobs') await loadJobs();
  if (tab.value === 'trace') await loadDeliveries();
}

function pick(d) {
  cur.value = d;
  preview.value = null;
  lastResult.value = null;
  reason.value = '';
  Object.keys(paramVals).forEach((k) => delete paramVals[k]);
}

async function doPreview() {
  if (!cur.value.def_key) return;
  previewing.value = true;
  try {
    preview.value = await api.exPreview(cur.value.def_key, { ...paramVals });
  } catch (e) {
    alert(e.message);
  } finally {
    previewing.value = false;
  }
}

async function doExport() {
  if (!cur.value.def_key) return;
  if (reason.value.trim().length < 4) return alert('请写导出理由（至少 4 个字）');
  exporting.value = true;
  try {
    const r = await downloadPost(`/api/exports/download/${cur.value.def_key}`, {
      params: { ...paramVals }, reason: reason.value
    });
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cur.value.name}-${r.jobNo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    lastResult.value = r;
    await loadMeta();
    await loadJobs();
  } catch (e) {
    alert(e.message);
  } finally {
    exporting.value = false;
  }
}

async function switchTab(t) {
  tab.value = t;
  if (t === 'subs') await loadSubs();
  if (t === 'jobs') await loadJobs();
  if (t === 'trace') await loadDeliveries();
}

async function loadSubs() {
  try {
    const r = await api.exSubs();
    subs.value = r.rows || [];
  } catch (e) { alert(e.message); }
}

async function loadJobs() {
  try {
    const r = await api.exJobs({ q: jobQ.value, trigger: jobTrigger.value });
    jobs.value = r.rows || [];
    jobScope.value = r.scope;
  } catch (e) { alert(e.message); }
}

async function loadDeliveries() {
  try {
    const r = await api.exDeliveries();
    deliveries.value = r.rows || [];
  } catch (e) { alert(e.message); }
}

function openSub() {
  Object.assign(subForm, {
    open: true, name: '', def_key: cur.value.def_key || '', freq: 'monthly', day_of_month: 1,
    day_of_week: 1, channel: 'inbox', recipients: [], valid_from: todayStr(),
    valid_until: todayStr(180), note: ''
  });
}

async function saveSub() {
  saving.value = true;
  try {
    await api.exSubSave({ ...subForm, open: undefined });
    subForm.open = false;
    await loadSubs();
    await loadMeta();
  } catch (e) {
    alert(e.message);
  } finally {
    saving.value = false;
  }
}

async function subAction(action, s) {
  const label = { pause: '暂停', resume: '恢复', cancel: '终止' }[action];
  if (!confirm(`确认${label}订阅「${s.name}」？`)) return;
  try {
    await api.exSubAction(action, s.id);
    await loadSubs();
    await loadMeta();
  } catch (e) { alert(e.message); }
}

async function runDue() {
  running.value = true;
  try {
    const r = await api.exRunDue({});
    const okText = (r.ok || []).map((x) => `${x.name}：${x.job_no}（${x.rows} 行）`).join('\n');
    const failText = (r.failed || []).map((x) => `${x.name}：${x.error}`).join('\n');
    alert(`到期 ${r.due_count} 条\n${okText || '（没有成功的）'}${failText ? '\n失败：\n' + failText : ''}`);
    await reload();
  } catch (e) {
    alert(e.message);
  } finally {
    running.value = false;
  }
}

async function doTrace() {
  traceErr.value = '';
  traceRes.value = null;
  if (!traceToken.value.trim()) return;
  tracing.value = true;
  try {
    traceRes.value = await api.exTrace(traceToken.value.trim());
  } catch (e) {
    traceErr.value = e.message;
  } finally {
    tracing.value = false;
  }
}

async function take(d) {
  try {
    const r = await downloadPost(`/api/exports/deliveries/${d.id}/take`, {});
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${d.def_name}-${d.job_no}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    if (r.changed) {
      alert('注意：源数据在这份产出生成之后发生了变化，下载的是「重新取数」的结果。导出记录里存的是当时那一刻的行数。');
    }
    await loadDeliveries();
  } catch (e) {
    alert(e.message);
  }
}

onMounted(async () => {
  await loadMeta();
  const first = allowedDefs.value[0] || (meta.value.defs || [])[0];
  if (first) pick(first);
});
</script>

<style scoped>
/* .panel-head 不是全局样式：每页要自己定义，否则 tabs 与右侧控件会各占一行 */
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head .tabs { flex-wrap: wrap; }
.panel-head .tabs button { flex: 0 0 auto; white-space: nowrap; position: relative; }
.panel-head .tabs .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #dc2626; margin-left: 4px; vertical-align: super; }

.cards.c6 { grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; }
.cards.c6 .stat-card { min-height: 98px; padding: 13px 12px; }
.cards.c6 .stat-card .value { font-size: 22px; margin-top: 5px; }
.cards.c6 .stat-card .foot { font-size: 12px; line-height: 1.4; }
.cards.c6 .stat-card .unit { font-size: 12px; margin-left: 3px; color: #7b8698; }
.stat-card.warn { border-color: color-mix(in srgb, var(--warning) 28%, var(--line)); background: color-mix(in srgb, var(--warning) 6%, var(--surface)); }

.tiny { font-size: 12px; line-height: 1.45; }
.mut { color: #7b8698; }
.red { color: #b91c1c; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.empty { padding: 26px 6px; color: #7b8698; font-size: 12.5px; }
.table-wrap { overflow-x: auto; }
table.data td { vertical-align: middle; }
table.data .tag { white-space: nowrap; }
.ops { white-space: nowrap; }
.ops .btn + .btn { margin-left: 6px; }
.subj { font-size: 12.5px; font-weight: 600; white-space: normal; word-break: break-word; }
.clamp1 { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wm { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }

.notice { border: 1px solid #dbeafe; background: #f6faff; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #1e3a5f; margin-bottom: 10px; }
.notice-warn { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #92400e; margin-bottom: 10px; }
.hint-box { border: 1px solid #bbf7d0; background: #f5fdf8; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #14532d; margin-top: 10px; }

.ex-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; align-items: start; }
.def-list { border: 1px solid #eef1f6; border-radius: 10px; padding: 8px; max-height: 620px; overflow: auto; }
.def-group + .def-group { margin-top: 10px; }
.def-group-h { font-size: 12px; color: #7b8698; padding: 2px 6px 6px; }
.def-item { display: block; padding: 7px 8px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.def-item:hover { background: var(--surface-2); }
.def-item.on { background: #eff6ff; border-color: #bfdbfe; }
.def-item.off { opacity: 0.55; }
.di-top { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
.di-name { font-size: 12.5px; word-break: break-word; }
.di-meta { margin-top: 2px; }

.def-main { min-width: 0; }
.dm-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.dm-head b { font-size: 14px; }

.params { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
.pfield { display: flex; flex-direction: column; gap: 4px; }
.pfield label { font-size: 12px; color: #7b8698; }
.pfield .input { width: 150px; }

.cols-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.col-chip { font-size: 12px; background: #f3f5f9; border: 1px solid #e6eaf2; border-radius: 6px; padding: 2px 7px; color: #43506b; }

.preview { border: 1px solid #eef1f6; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
.pv-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mask-warn { font-size: 12px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 2px 8px; }
.preview .table-wrap { max-height: 260px; }

.run-box { border: 1px solid #eef1f6; border-radius: 10px; padding: 12px; }
.rb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rb-row label { font-size: 12px; color: #7b8698; white-space: nowrap; }
.rb-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 10px; }

.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.toolbar .sp { flex: 1; }

.trace-box { border: 1px solid #eef1f6; border-radius: 10px; padding: 12px; }
.tb-h { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.tb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.trace-res { margin-top: 12px; border-top: 1px dashed #e6eaf2; padding-top: 10px; }
.kv { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; }
.kv > span { color: #7b8698; min-width: 74px; flex: 0 0 auto; }
.kv > b { font-weight: 500; word-break: break-word; }
.col-h { font-size: 12.5px; font-weight: 600; color: var(--ink); margin: 12px 0 6px; }

code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f3f5f9; padding: 1px 5px; border-radius: 4px; }

.modal-body .row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; flex-wrap: wrap; }
.modal-body .row > label:first-child { font-size: 12px; color: #7b8698; flex: 0 0 auto; min-width: 56px; }
.recips { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.recips .ck { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ink); min-width: 0; }

@media (max-width: 900px) {
  .ex-grid { grid-template-columns: 1fr; }
  .def-list { max-height: 260px; }
}

@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .panel-head { flex-direction: column; align-items: stretch; gap: 8px; }
  .panel-head .tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .page-head .head-ops,
  .panel-head .head-ops { width: 100%; flex: 1 1 auto; flex-wrap: wrap; }
  .page-head .head-ops .btn { flex: 1 1 45%; }
  .params { width: 100%; }
  .pfield { flex: 1 1 45%; }
  .pfield .input { width: 100%; }
  .params .btn { flex: 1 1 100%; }
  .rb-foot .btn { flex: 1 1 100%; }
}
</style>
