<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>异常日清</h2>
        <p class="sub">
          把技术、缺料、质量、产能、人事、资金六类异常汇到一张清单，每条都能点回原单。
          <b>「今日必办」只收升级事项</b>（严重级 / 超 SLA 没人认领 / 过了预计解决日），
          不是把所有待办重列一遍 —— 不然每天刷出两百条，第三次就没人打开了。
        </p>
      </div>
      <div class="head-ops">
        <span class="stamp" v-if="daily.data_until">数据截止 {{ daily.data_until }}</span>
        <button class="btn btn-ghost" @click="openRules">规则与阈值</button>
        <button class="btn btn-ghost" @click="reload">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" :disabled="scanning" @click="doScan">
          {{ scanning ? '扫描中…' : '重新扫描' }}
        </button>
      </div>
    </div>

    <!-- 归口计数：点一下就筛 -->
    <div class="cards cat">
      <div
        v-for="c in summary"
        :key="c.category"
        class="stat-card"
        :class="{ accent: filterCat === c.category, danger: c.escalated > 0 && filterCat !== c.category }"
        @click="pickCat(c.category)"
      >
        <div class="label">{{ c.label }}</div>
        <div class="value">{{ c.count }}<small>条</small></div>
        <div class="foot">{{ c.escalated ? c.escalated + ' 条已升级' : '无升级' }}</div>
      </div>
    </div>

    <!-- 覆盖率：没算进去的部分必须说出来，否则「0 异常」会被当成「没问题」 -->
    <div class="cov" v-if="gaps.length">
      <div class="cov-head">判定覆盖率提示 —— 下面这些<b>没有算进异常数</b>，不代表没问题</div>
      <ul>
        <li v-for="(g, i) in gaps" :key="i">{{ g }}</li>
      </ul>
    </div>

    <div class="panel-card">
      <div class="panel-head">
        <div class="tabs">
          <button :class="{ on: tab === 'must' }" @click="tab = 'must'">今日必办 ({{ daily.must.length }})</button>
          <button :class="{ on: tab === 'doing' }" @click="tab = 'doing'">处理中 ({{ daily.doing.length }})</button>
          <button :class="{ on: tab === 'closed' }" @click="switchClosed">已关闭</button>
          <button :class="{ on: tab === 'report' }" @click="switchReport">日报初稿</button>
        </div>
        <input v-if="tab !== 'report'" v-model="q" class="input" style="width: 200px" placeholder="异常 / 单号 / 条目号" />
        <span class="muted" v-if="tab !== 'report'">今日系统按事实消除 <b>{{ daily.auto_resolved_today || 0 }}</b> 条（不计入人工完成）<template v-if="meta.stats && meta.stats.ignored"> · 已标遗留 <b>{{ meta.stats.ignored }}</b> 条（不再提醒）</template></span>
      </div>

      <!-- 必办 / 处理中 -->
      <div class="table-wrap" v-if="tab === 'must' || tab === 'doing'">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 82px">原因</th>
              <th style="width: 96px">类别</th>
              <th>异常</th>
              <th style="width: 108px">影响</th>
              <th style="width: 142px">归属</th>
              <th style="width: 88px">状态</th>
              <th style="width: 148px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in currentRows" :key="r.id">
              <td>
                <span class="tag" :class="r.escalated ? 'red' : (r.severity === 'serious' ? 'orange' : 'gray')">{{ r.why || (r.severity === 'serious' ? '严重级' : '常规') }}</span>
              </td>
              <td>{{ r.category_label }}</td>
              <td>
                <div class="ttl" @click="openDetail(r)">{{ r.title }}</div>
                <div class="mut">{{ r.rule_name }} · {{ r.source_no }} · 首见 {{ r.first_day }}<span v-if="r.seen_count > 1"> · 已重复检出 {{ r.seen_count }} 次</span></div>
              </td>
              <td>
                <div v-if="r.impact_amount != null">{{ money(r.impact_amount) }} 元</div>
                <div v-else-if="r.impact_qty">{{ num(r.impact_qty) }} <span class="mut">件/量</span></div>
                <div v-else class="mut" :title="r.impact_note || ''">—</div>
              </td>
              <td>
                <div>{{ r.owner_dept || '—' }}</div>
                <div class="mut">
                  <span v-if="r.owner_name">{{ r.owner_name }}</span>
                  <span v-else class="tag gray">待指派</span>
                </div>
              </td>
              <td><span class="tag" :class="statusTag(r.status)">{{ r.status_label }}</span></td>
              <td class="ops">
                <button v-if="canWrite && !r.owner_name" class="btn btn-sm btn-ghost" @click="doClaim(r)">认领</button>
                <button class="btn btn-sm btn-primary" @click="openDetail(r)">处理</button>
              </td>
            </tr>
            <tr v-if="!currentRows.length">
              <td colspan="7" class="empty-cell">{{ tab === 'must' ? '今天没有升级事项，保持住' : '没有在处理中的异常' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 已关闭 -->
      <div class="table-wrap" v-if="tab === 'closed'">
        <table class="data">
          <thead>
            <tr>
              <th style="width: 96px">类别</th>
              <th>异常</th>
              <th style="width: 120px">处理人</th>
              <th style="width: 150px">结果</th>
              <th style="width: 110px">复核</th>
              <th style="width: 90px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in closedRowsView" :key="r.id">
              <td>{{ r.category_label }}</td>
              <td>
                <div class="ttl" @click="openDetail(r)">{{ r.title }}</div>
                <div class="mut">{{ r.rule_name }} · 关闭于 {{ (r.closed_at || '').slice(0, 16).replace('T', ' ') }}</div>
              </td>
              <td>{{ r.closed_by || '—' }}</td>
              <td class="mut">{{ r.result }}</td>
              <td>
                <span class="tag" :class="r.review_status === 'passed' ? 'green' : (r.review_status === 'rejected' ? 'red' : 'orange')">
                  {{ r.review_status === 'passed' ? '已复核' : (r.review_status === 'rejected' ? '打回' : '待复核') }}
                </span>
              </td>
              <td><button class="btn btn-sm btn-ghost" @click="openDetail(r)">查看</button></td>
            </tr>
            <tr v-if="!closedRowsView.length"><td colspan="6" class="empty-cell">还没有关闭记录</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 日报初稿 -->
      <div v-if="tab === 'report' && report" class="report">
        <div class="rep-note">{{ report.basis }}</div>
        <div class="rep-grid">
          <div class="rep-col" v-for="(s, k) in report.sections" :key="k">
            <div class="rep-h">{{ s.title }} <b>{{ s.rows.length }}</b></div>
            <div v-if="!s.rows.length" class="mut" style="padding: 8px 0">无</div>
            <div v-for="r in s.rows.slice(0, 12)" :key="r.id" class="rep-row" @click="openDetail(r)">
              <span class="rep-t">{{ r.title }}</span>
              <span class="mut">{{ r.owner_name || '待指派' }}</span>
            </div>
            <div v-if="s.rows.length > 12" class="mut">…另有 {{ s.rows.length - 12 }} 条</div>
          </div>
        </div>
        <div class="rep-owner">
          <span class="rep-h">按责任人分布</span>
          <span class="tag gray" v-for="o in report.by_owner" :key="o.owner">{{ o.owner }} {{ o.count }}</span>
          <span v-if="!report.by_owner.length" class="mut">无</span>
        </div>
        <div class="cov" v-if="report.coverage && (report.coverage.rules || []).some((x) => x.skipped)">
          <div class="cov-head">本日报的口径说明（数据不全的地方已标注，未做任何推算）</div>
          <ul>
            <li v-for="c in (report.coverage.rules || []).filter((x) => x.skipped)" :key="c.rule">{{ c.name }}：{{ c.skip_reason }}</li>
            <li v-for="g in report.coverage.category_gaps || []" :key="g.category">{{ g.category_label }}：{{ g.reason }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 详情 / 处理 -->
    <div class="modal-mask" v-if="detail" @click.self="closeDetail">
      <div class="modal wide">
        <div class="m-head">
          <div>
            <h3>{{ detail.title }}</h3>
            <div class="mut">
              {{ detail.item_no }} · {{ detail.rule_name }} · {{ detail.category_label }} ·
              <span class="tag" :class="statusTag(detail.status)">{{ detail.status_label }}</span>
              <span class="tag red" v-if="detail.escalated">已升级</span>
            </div>
          </div>
          <button class="link-btn" @click="closeDetail">关闭</button>
        </div>

        <div class="m-body">
          <div class="kv">
            <div><span>原单</span><b>
              <a v-if="detail.source_type === 'order'" href="#" @click.prevent="gotoOrder(detail.source_id)">{{ detail.source_no }}</a>
              <template v-else>{{ detail.source_no }}</template>
            </b></div>
            <div><span>影响</span><b>{{ detail.impact_amount != null ? money(detail.impact_amount) + ' 元' : (detail.impact_qty != null ? num(detail.impact_qty) : '—') }}</b></div>
            <div><span>口径</span><b class="mut">{{ detail.impact_note || '—' }}</b></div>
            <div><span>归属</span><b>{{ detail.owner_dept || '—' }} / <span v-if="detail.owner_name">{{ detail.owner_name }}（{{ detail.owner_source_label }}）</span><span v-else class="tag gray">待指派</span></b></div>
            <div><span>首见</span><b>{{ detail.first_day }}，已检出 {{ detail.seen_count }} 次</b></div>
            <div><span>判定规则</span><b class="mut">{{ detail.rule_note }}</b></div>
          </div>

          <div class="desc" v-if="detail.detail">{{ detail.detail }}</div>

          <div class="warn-box" v-if="detail.escalated">
            <b>升级原因：</b>{{ detail.escalate_reason }}
            <div class="mut">升级只是提醒，系统不会自动改单据状态、不会扣绩效、不会扣工资。</div>
          </div>

          <div class="done-box" v-if="detail.status === 'closed'">
            <div><span>原因</span>{{ detail.cause }}</div>
            <div><span>结果</span>{{ detail.result }}</div>
            <div><span>处理人</span>{{ detail.closed_by }} · {{ (detail.closed_at || '').slice(0, 16).replace('T', ' ') }}</div>
            <div>
              <span>复核</span>
              <span class="tag" :class="detail.review_status === 'passed' ? 'green' : (detail.review_status === 'rejected' ? 'red' : 'orange')">
                {{ detail.review_status === 'passed' ? '已通过' : (detail.review_status === 'rejected' ? '已打回' : '待复核') }}
              </span>
              <span class="mut" v-if="detail.reviewed_by"> {{ detail.reviewed_by }} {{ detail.review_note || '' }}</span>
            </div>
          </div>

          <!-- 动作区 -->
          <div class="act-bar" v-if="canWrite && activeStatus">
            <button v-if="!detail.owner_name" class="btn btn-sm btn-ghost" @click="doClaim(detail)">我来认领</button>
            <button class="btn btn-sm btn-ghost" @click="panel = panel === 'assign' ? '' : 'assign'">指派 / 转派</button>
            <button class="btn btn-sm btn-ghost" @click="panel = panel === 'note' ? '' : 'note'">加备注</button>
            <button class="btn btn-sm btn-ghost" @click="panel = panel === 'ignore' ? '' : 'ignore'">标为数据遗留</button>
            <button class="btn btn-sm btn-primary" @click="panel = panel === 'close' ? '' : 'close'">关闭</button>
            <button
              v-if="canReview && detail.status === 'closed' && detail.review_status !== 'passed'"
              class="btn btn-sm btn-ghost"
              @click="panel = panel === 'review' ? '' : 'review'"
            >复核</button>
          </div>

          <div class="form-box" v-if="panel === 'assign'">
            <div class="row2">
              <select v-model="assignForm.to_username" class="select">
                <option value="">选接收人</option>
                <option v-for="u in meta.users" :key="u.username" :value="u.username">{{ u.name }}（{{ u.role }}）</option>
              </select>
            </div>
            <textarea v-model="assignForm.reason" class="input" rows="2" placeholder="转派原因（至少 4 个字，事后要能查为什么换人）"></textarea>
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doAssign">确认指派</button></div>
          </div>

          <div class="form-box" v-if="panel === 'close'">
            <div class="lbl">原因（为什么会发生）</div>
            <textarea v-model="closeForm.cause" class="input" rows="2" placeholder="例如：技术确认卡在面料成分复核"></textarea>
            <div class="lbl">处理结果（具体怎么解决的）</div>
            <textarea v-model="closeForm.result" class="input" rows="2" placeholder="例如：已补成分检测报告，技术今日确认放行"></textarea>
            <div class="lbl">预计解决日（可空；填了到期没关会自动升级）</div>
            <input v-model="closeForm.expect_date" type="date" class="input" />
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doClose">确认关闭</button></div>
          </div>

          <div class="form-box" v-if="panel === 'note'">
            <textarea v-model="noteForm.note" class="input" rows="2" placeholder="补充说明（不改状态）"></textarea>
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doNote">保存备注</button></div>
          </div>

          <div class="form-box" v-if="panel === 'ignore'">
            <div class="lbl">为什么不再提醒（必填，至少 4 个字）</div>
            <textarea v-model="ignoreForm.reason" class="input" rows="2" placeholder="例如：历史演示夹具单，无真实技术包，不参与日清"></textarea>
            <div class="lbl">豁免到期日（可空＝永久；到期后会被自动重新检出）</div>
            <input v-model="ignoreForm.until" type="date" class="input" />
            <div class="form-foot"><button class="btn btn-sm btn-primary" @click="doIgnore">确认标为数据遗留</button></div>
            <div class="mut" style="margin-top: 6px">
              标为遗留不是「当它没发生」：状态单独记、不算处理完成，扫描结果里会显示被压住的条数。
            </div>
          </div>

          <div class="form-box" v-if="panel === 'review'">
            <textarea v-model="reviewForm.note" class="input" rows="2" placeholder="复核意见（不通过必填）"></textarea>
            <div class="form-foot">
              <button class="btn btn-sm btn-primary" @click="doReview(true)">复核通过</button>
              <button class="btn btn-sm btn-ghost" @click="doReview(false)">打回重办</button>
            </div>
          </div>

          <div class="acts">
            <div class="acts-h">动作流水</div>
            <div v-for="a in detail.actions" :key="a.id" class="act-row">
              <span class="act-t">{{ (a.created_at || '').slice(0, 16).replace('T', ' ') }}</span>
              <span class="tag" :class="a.action === 'close' ? 'green' : (a.action === 'auto_resolve' ? 'gray' : (a.action === 'escalate' ? 'red' : 'blue'))">{{ a.action_label }}</span>
              <span class="act-o">{{ a.operator || '系统' }}</span>
              <span class="act-r">{{ a.reason || '' }}<span v-if="a.target"> → {{ a.target }}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 规则与阈值 -->
    <div class="modal-mask" v-if="rulesOpen" @click.self="rulesOpen = false">
      <div class="modal wide">
        <div class="m-head">
          <div>
            <h3>规则与阈值</h3>
            <div class="mut">阈值改了<b>下次扫描生效</b>，不动已经生成的条目；判定口径写在这里，不藏在代码里。</div>
          </div>
          <button class="link-btn" @click="rulesOpen = false">关闭</button>
        </div>
        <div class="m-body">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>规则</th>
                  <th style="width: 90px">类别</th>
                  <th style="width: 70px">级</th>
                  <th style="width: 130px">阈值</th>
                  <th style="width: 110px">SLA(小时)</th>
                  <th style="width: 80px">启用</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rules" :key="r.code">
                  <td>
                    <div>{{ r.name }}</div>
                    <div class="mut">{{ r.rule_note }}</div>
                  </td>
                  <td>{{ r.category_label }}</td>
                  <td><span class="tag" :class="r.severity === 'serious' ? 'orange' : 'gray'">{{ r.severity === 'serious' ? '严重' : '常规' }}</span></td>
                  <td>
                    <input v-model.number="r._threshold" class="input" style="width: 74px" type="number" />
                    <span class="mut">{{ r.threshold_unit === 'hour' ? '小时' : '天' }}</span>
                  </td>
                  <td><input v-model.number="r._sla" class="input" style="width: 74px" type="number" /></td>
                  <td><input type="checkbox" v-model="r._enabled" :disabled="!canRule" /></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="form-foot" style="margin-top: 12px" v-if="canRule">
            <button class="btn btn-primary" @click="saveRules">保存全部</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter();
const canWrite = computed(() => can('exception.write'));
const canReview = computed(() => can('exception.review'));
const canRule = computed(() => can('exception.rule'));

const money = (v) => (Number(v) || 0).toFixed(2);
const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? n : n.toFixed(2);
};
const statusTag = (s) => ({ open: 'orange', claimed: 'blue', handling: 'blue', waiting: 'purple', closed: 'green', auto_resolved: 'gray' }[s] || 'gray');

const tab = ref('must');
const q = ref('');
const filterCat = ref('');
const scanning = ref(false);
const daily = ref({ must: [], doing: [], summary: [], auto_resolved_today: 0, data_until: null });
const meta = ref({ users: [], categories: [] });
const report = ref(null);
const closedRows = ref([]);
const rules = ref([]);
const rulesOpen = ref(false);

const detail = ref(null);
const panel = ref('');
const assignForm = reactive({ to_username: '', reason: '' });
const closeForm = reactive({ cause: '', result: '', expect_date: '' });
const noteForm = reactive({ note: '' });
const reviewForm = reactive({ note: '' });
const ignoreForm = reactive({ reason: '', until: '' });

const summary = computed(() => daily.value.summary || []);

/** 覆盖率缺口：规则自身跳过的 + 没有规则的类别，都要摆出来 */
const gaps = computed(() => {
  const out = [];
  const cov = daily.value.coverage;
  if (cov && Array.isArray(cov.rules)) {
    cov.rules.forEach((c) => { if (c.skipped > 0 && c.skip_reason) out.push(`${c.name}：${c.skip_reason}`); });
  }
  if (cov && Array.isArray(cov.category_gaps)) {
    cov.category_gaps.forEach((g) => out.push(`${g.category_label}：${g.reason}`));
  }
  return out;
});

const activeStatus = computed(() => detail.value && ['open', 'claimed', 'handling', 'waiting'].includes(detail.value.status));

function match(r) {
  if (filterCat.value && r.category !== filterCat.value) return false;
  if (!q.value) return true;
  const k = q.value.toLowerCase();
  return (r.title || '').toLowerCase().includes(k)
    || (r.source_no || '').toLowerCase().includes(k)
    || (r.item_no || '').toLowerCase().includes(k);
}

const currentRows = computed(() => (daily.value[tab.value] || []).filter(match));
const closedRowsView = computed(() => closedRows.value.filter(match));

async function loadDaily() {
  daily.value = await api.excDaily({});
}

async function load() {
  // 两次请求分开：字典失败（比如某条统计 SQL 多挂一个参数）不该把整张清单拖成空白 ——
  // 清单才是这个页面存在的理由
  daily.value = await api.excDaily({});
  try {
    meta.value = await api.excMeta({});
  } catch (e) {
    console.error('字典加载失败（清单仍可用）', e);
  }
}

async function reload() {
  await load();
  if (tab.value === 'closed') await switchClosed();
  if (tab.value === 'report') await switchReport();
}

async function doScan() {
  scanning.value = true;
  try {
    const r = await api.excScan({});
    await reload();
    alert(
      `扫描完成（数据截止 ${r.data_until}）\n` +
      `新开 ${r.opened} 条 · 仍存在 ${r.refreshed} 条 · 系统按事实消除 ${r.auto_resolved} 条 · 升级 ${r.escalated} 条\n` +
      `今日必办 ${r.must_do} 条`
    );
  } catch (e) {
    alert(e.message);
  } finally {
    scanning.value = false;
  }
}

function pickCat(c) {
  filterCat.value = filterCat.value === c ? '' : c;
}

async function switchClosed() {
  tab.value = 'closed';
  closedRows.value = await api.excList({ status: 'closed' });
}

async function switchReport() {
  tab.value = 'report';
  report.value = await api.excReport({});
}

function openDetail(r) {
  panel.value = '';
  api.excDetail(r.id).then((d) => {
    detail.value = d;
    closeForm.cause = d.cause || '';
    closeForm.result = '';
    closeForm.expect_date = d.expect_date || '';
    noteForm.note = '';
    reviewForm.note = '';
    assignForm.to_username = '';
    assignForm.reason = '';
  }).catch((e) => alert(e.message));
}

function closeDetail() {
  detail.value = null;
  panel.value = '';
}

async function refreshDetail() {
  if (!detail.value) return;
  detail.value = await api.excDetail(detail.value.id);
  await loadDaily();
  if (tab.value === 'closed') await switchClosed();
}

async function doClaim(r) {
  try {
    await api.excClaim(r.id);
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doAssign() {
  try {
    await api.excAssign(detail.value.id, { to_username: assignForm.to_username, reason: assignForm.reason });
    panel.value = '';
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doClose() {
  try {
    await api.excClose(detail.value.id, { ...closeForm });
    panel.value = '';
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doNote() {
  try {
    await api.excNote(detail.value.id, { note: noteForm.note });
    panel.value = '';
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doReview(pass) {
  try {
    await api.excReview(detail.value.id, { pass, note: reviewForm.note });
    panel.value = '';
    await refreshDetail();
  } catch (e) { alert(e.message); }
}

async function doIgnore() {
  try {
    await api.excIgnore(detail.value.id, { reason: ignoreForm.reason, until: ignoreForm.until || null });
    panel.value = '';
    ignoreForm.reason = '';
    ignoreForm.until = '';
    closeDetail();
    await load();
  } catch (e) { alert(e.message); }
}

function gotoOrder(id) {
  router.push({ path: '/orders', query: { order: id } });
}

async function openRules() {
  rulesOpen.value = true;
  const list = await api.excRules();
  rules.value = list.map((r) => ({ ...r, _threshold: r.threshold, _sla: r.sla_hours, _enabled: !!r.enabled }));
}

async function saveRules() {
  try {
    for (const r of rules.value) {
      await api.excSaveRule(r.code, { threshold: r._threshold, sla_hours: r._sla, enabled: r._enabled });
    }
    rulesOpen.value = false;
    alert('已保存，下次扫描生效（不追溯已生成的条目）');
    await reload();
  } catch (e) { alert(e.message); }
}

onMounted(load);
</script>

<style scoped>
.stamp { font-size: 12px; color: #8a94a6; margin-right: 8px; }
.cards.cat { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.cards.cat .stat-card { cursor: pointer; }
.stat-card.danger { border-color: #f5c2c7; background: #fff8f8; }
.ttl { font-weight: 600; color: #16233b; cursor: pointer; }
.ttl:hover { color: #2563eb; }
.mut { color: #8a94a6; font-size: 11.8px; line-height: 1.5; }
.muted { color: #8a94a6; font-size: 12px; }
.ops { white-space: nowrap; }
.ops .btn + .btn { margin-left: 8px; }

.cov { background: #fffaf0; border: 1px solid #f2dfae; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; }
.cov-head { font-size: 13px; font-weight: 700; color: #8a6d1f; margin-bottom: 6px; }
.cov ul { margin: 0; padding-left: 18px; color: #7a6420; font-size: 12.5px; line-height: 1.7; }

.report .rep-note { background: #f5f8fd; border-left: 3px solid #2b6de5; padding: 10px 14px; font-size: 12.5px; color: #4a5875; margin-bottom: 14px; border-radius: 6px; }
.rep-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.rep-col { border: 1px solid #eef2f7; border-radius: 10px; padding: 12px 14px; }
.rep-h { font-size: 13px; font-weight: 700; color: #16233b; margin-bottom: 8px; }
.rep-h b { color: #2563eb; }
.rep-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed #eef2f7; cursor: pointer; }
.rep-row:last-child { border-bottom: none; }
.rep-row:hover .rep-t { color: #2563eb; }
.rep-t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rep-owner { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rep-owner .rep-h { margin: 0 6px 0 0; }

.modal.wide { max-width: 860px; width: 92vw; }
.m-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.m-head h3 { margin: 0 0 4px; font-size: 16px; }
.m-body { max-height: 68vh; overflow-y: auto; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; font-size: 12.8px; margin-bottom: 12px; }
.kv > div { display: flex; gap: 8px; }
.kv span { color: #8a94a6; min-width: 62px; }
.kv b { font-weight: 600; color: #16233b; }
.desc { background: #f8fafd; border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #3d4a63; margin-bottom: 12px; }
.warn-box { background: #fff5f5; border: 1px solid #f8d7da; border-radius: 8px; padding: 10px 12px; font-size: 12.6px; color: #a32035; margin-bottom: 12px; }
.done-box { background: #f4fbf6; border: 1px solid #cfe9d8; border-radius: 8px; padding: 10px 12px; font-size: 12.8px; margin-bottom: 12px; }
.done-box > div { display: flex; gap: 10px; padding: 3px 0; }
.done-box span:first-child { color: #6b7688; min-width: 52px; }
.act-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.form-box { background: #f8fafd; border: 1px solid #e6ebf3; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.form-box .lbl { font-size: 12px; color: #6b7688; margin: 6px 0 4px; }
.form-box .input, .form-box .select { width: 100%; }
.form-foot { margin-top: 8px; display: flex; gap: 8px; }
.acts { border-top: 1px solid #eef2f7; padding-top: 10px; }
.acts-h { font-size: 12.5px; font-weight: 700; color: #16233b; margin-bottom: 6px; }
.act-row { display: flex; gap: 10px; align-items: baseline; font-size: 12.3px; padding: 4px 0; border-bottom: 1px dashed #f0f3f8; }
.act-t { color: #9aa4b5; width: 118px; flex: none; }
.act-o { color: #4a5875; width: 76px; flex: none; }
.act-r { color: #3d4a63; flex: 1; }
a { color: #2563eb; }

/* 窄屏：标题与按钮要换行，否则「重新扫描」会被挤出屏幕右边缘；
   tabs 不许把「已关闭」拆成两行 */
@media (max-width: 720px) {
  .page-head { flex-direction: column; align-items: flex-start; gap: 10px; }
  .head-ops { flex-wrap: wrap; width: 100%; }
  .head-ops .btn { padding: 7px 11px; font-size: 12.5px; }
  .tabs { flex-wrap: wrap; }
  .tabs button { white-space: nowrap; }
  .kv { grid-template-columns: 1fr; }
  .modal.wide { width: 96vw; }
}
</style>
