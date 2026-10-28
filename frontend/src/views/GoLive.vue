<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>上线检查清单</h2>
        <p class="sub">
          回答一个问题：<b>今天能不能上线，凭据是什么</b>。能自动验的（烟测残留、孤儿行、默认密码、
          备份文件是否真在盘上、借贷是否平衡）交给系统跑；人只负责培训签收、并行计划这类真要判断的事。
          <b>自动项不能人工改成「通过」</b> —— 这是清单和橡皮章之间唯一的分界线。
        </p>
      </div>
      <div class="head-ops">
        <select v-model="roundId" class="select" style="width: 236px" @change="openRound(roundId)">
          <option v-for="r in rounds" :key="r.id" :value="r.id">
            {{ r.round_no }} · {{ r.scope_label }} · {{ r.status_label }}
          </option>
          <option v-if="!rounds.length" :value="null">还没有评估轮次</option>
        </select>
        <button v-if="canRun" class="btn btn-primary" @click="newForm.open = true">新建一轮评估</button>
      </div>
    </div>

    <div v-if="!cur" class="panel-card empty-box">
      <b>还没有评估轮次。</b>
      点右上「新建一轮评估」，系统会跑一遍 16 项自动检查、生成 26 项清单，然后逐项处理。
      每次要上线都新建一轮 —— 换一天再跑是另一轮，「上线那天到底验了什么」才有据可查。
    </div>

    <template v-else>
      <!-- 结论条 -->
      <div class="verdict" :class="verdictCls">
        <div class="v-left">
          <div class="v-badge">{{ cur.status_label }}</div>
          <div class="v-text">
            <div v-if="cur.status === 'signed'" class="v-title">
              已签署：<b>{{ cur.conclusion_label }}</b>
              <span class="mut">· {{ cur.signed_by }} · {{ fmt(cur.signed_at) }}</span>
            </div>
            <div v-else-if="cur.status === 'blocked'" class="v-title">
              还有 <b>{{ cur.blocker_open }}</b> 个阻塞项未通过，现在只能签「暂不上线」
            </div>
            <div v-else-if="cur.status === 'ready'" class="v-title">阻塞项已全部解除，可以签署</div>
            <div v-else class="v-title">
              人工项还剩 <b>{{ cur.manual_total - cur.manual_done }}</b> 项待验（阻塞项 {{ cur.blocker_open }}）
            </div>
            <div v-if="cur.withdrawn_reason" class="v-note">撤回原因：{{ cur.withdrawn_reason }}</div>
            <div v-if="cur.sign_note" class="v-note">签署说明：{{ cur.sign_note }}</div>
          </div>
        </div>
        <div class="v-right">
          <span class="tiny mut" v-if="cur.last_refresh_at">自动项最近重跑：{{ fmt(cur.last_refresh_at) }}</span>
          <button v-if="canRun && cur.can_refresh" class="btn btn-ghost" :disabled="busy" @click="doRefresh">
            {{ busy ? '检查中…' : '重跑自动检查' }}
          </button>
          <button v-if="canSign && cur.status === 'signed'" class="btn btn-ghost" @click="askWithdraw">撤回</button>
          <button v-if="canSign && cur.can_sign" class="btn btn-primary" @click="openSign">签署</button>
        </div>
      </div>

      <!-- 统计 -->
      <div class="cards c6">
        <div class="stat-card">
          <div class="label">自动检查</div>
          <div class="value">{{ cur.auto_pass }}<small>/ {{ cur.auto_total }}</small></div>
          <div class="foot">其余看红项</div>
        </div>
        <div class="stat-card" :class="{ warn: cur.auto_fail }">
          <div class="label">自动不通过</div>
          <div class="value red">{{ cur.auto_fail }}</div>
          <div class="foot">代码判定不通过</div>
        </div>
        <div class="stat-card">
          <div class="label">自动有提示</div>
          <div class="value">{{ cur.auto_warn }}</div>
          <div class="foot">要人判断</div>
        </div>
        <div class="stat-card">
          <div class="label">人工已验</div>
          <div class="value">{{ cur.manual_done }}<small>/ {{ cur.manual_total }}</small></div>
          <div class="foot">含不适用</div>
        </div>
        <div class="stat-card" :class="{ warn: cur.blocker_open }">
          <div class="label">阻塞项</div>
          <div class="value red">{{ cur.blocker_open }}</div>
          <div class="foot">不签准予上线</div>
        </div>
        <div class="stat-card">
          <div class="label">口径</div>
          <div class="value sm">{{ cur.scope_label }}</div>
          <div class="foot">计划 {{ cur.plan_date }}</div>
        </div>
      </div>

      <!-- 阻塞项清单 -->
      <div v-if="cur.open_blockers.length" class="blocker-box">
        <div class="bb-head">阻塞项 {{ cur.open_blockers.length }} 个 · 这些不解除，签不了「准予上线」</div>
        <div v-for="b in cur.open_blockers" :key="b.item_key" class="bb-row">
          <span class="tag red">{{ b.status === 'warn' ? '有提示' : '未通过' }}</span>
          <b>{{ b.title }}</b>
          <span class="mut tiny">{{ b.result || '尚未验' }}</span>
        </div>
      </div>

      <!-- 六大块 -->
      <div v-for="sec in cur.sections" :key="sec.key" class="panel-card">
        <div class="sec-head">
          <h3>{{ sec.label }}<span class="sec-note">{{ sec.note }}</span></h3>
          <span class="sec-meta">
            {{ sec.done }}/{{ sec.total }}
            <span v-if="sec.blocked" class="red"> · 阻塞 {{ sec.blocked }}</span>
          </span>
        </div>

        <div class="item-list">
          <div v-for="it in sec.items" :key="it.id" class="item" :class="'st-' + it.status">
            <div class="i-main">
              <div class="i-title">
                <span class="tag" :class="statusCls(it.status)">{{ it.status_label }}</span>
                <span class="tag" :class="sevCls(it.severity)">{{ it.severity_label }}</span>
                <span class="tag gray">{{ it.kind_label }}</span>
                <b class="i-name">{{ it.title }}</b>
                <span v-if="it.owner" class="tiny mut">· {{ it.owner }}</span>
              </div>
              <div class="i-detail">{{ it.detail }}</div>
              <div v-if="it.result" class="i-result" :class="it.status === 'fail' ? 'red' : (it.status === 'warn' ? 'amber-t' : '')">
                {{ it.result }}
              </div>
              <div v-if="it.evidence" class="i-evidence"><span class="ev-label">证据</span>{{ it.evidence }}</div>
              <div v-if="it.na_reason" class="i-evidence"><span class="ev-label">不适用</span>{{ it.na_reason }}</div>
              <div v-if="it.kind === 'auto'" class="i-how">判定口径：{{ it.how }}</div>
              <div v-if="it.done_by && it.kind === 'manual'" class="tiny mut i-who">
                {{ it.done_by }} 于 {{ fmt(it.done_at) }} 判定
              </div>
            </div>
            <div class="i-ops">
              <button
                v-if="canRun && it.kind === 'manual' && cur.can_sign"
                class="btn btn-sm btn-ghost"
                @click="openManual(it)"
              >判定</button>
              <span v-if="it.kind === 'auto'" class="tiny mut auto-hint">自动项</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 签署快照 -->
      <div v-if="cur.snapshot" class="panel-card">
        <div class="sec-head">
          <h3>签署时冻结的快照<span class="sec-note">签完再改库，这一轮的结论与数字不会跟着变</span></h3>
          <span class="sec-meta">{{ fmt(cur.snapshot.frozen_at) }}</span>
        </div>
        <div class="snap-grid">
          <div><span class="mut">结论</span><b>{{ cur.conclusion_label }}</b></div>
          <div><span class="mut">通过</span>{{ cur.snapshot.counts.pass }}</div>
          <div><span class="mut">不通过</span><span class="red">{{ cur.snapshot.counts.fail }}</span></div>
          <div><span class="mut">有提示</span>{{ cur.snapshot.counts.warn }}</div>
          <div><span class="mut">不适用</span>{{ cur.snapshot.counts.na }}</div>
          <div><span class="mut">待处理</span>{{ cur.snapshot.counts.pending }}</div>
          <div><span class="mut">签署人</span>{{ cur.signed_by }}</div>
          <div><span class="mut">冻结项数</span>{{ cur.snapshot.items.length }}</div>
        </div>
        <div class="hint-box">
          这份快照里存了每一项当时的结论、证据与判定人。以后再问「上线那天验了什么」，
          翻的是这一页，不是现在重跑一遍 —— 重跑出来的数字是今天的，不是那天的。
        </div>
      </div>
    </template>

    <!-- ================= 新建评估 ================= -->
    <div class="modal-mask" v-if="newForm.open" @click.self="newForm.open = false">
      <div class="modal">
        <div class="modal-head"><b>新建一轮评估</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="newForm.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            新建会<b>立即跑一遍 16 项自动检查</b>并存成新的一轮。之前轮次不受影响 ——
            一份清单被反复勾选，就再也说不清「上线那天到底验了什么」。
          </div>
          <div class="row">
            <label>交付口径</label>
            <select v-model="newForm.scope" class="select" style="flex: 1">
              <option value="production">正式上线（要求无演示数据）</option>
              <option value="demo">演示库交付（允许演示数据）</option>
            </select>
          </div>
          <div class="row">
            <label>环境标签</label>
            <input v-model="newForm.env_label" class="input" style="flex: 1" placeholder="如：生产环境 · 总部 / 客户现场" />
          </div>
          <div class="row">
            <label>计划上线日</label>
            <input v-model="newForm.plan_date" class="input" type="date" style="width: 170px" />
            <label>版本</label>
            <input v-model="newForm.app_version" class="input" style="width: 130px" placeholder="如 1.43.0" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="newForm.open = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doNew">
              {{ busy ? '正在跑检查…' : '生成并开始评估' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 人工判定 ================= -->
    <div class="modal-mask" v-if="mf.open" @click.self="mf.open = false">
      <div class="modal wide">
        <div class="modal-head"><b>判定 · {{ mf.item ? mf.item.title : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="mf.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            <b>判「通过」必须写证据</b>（签字单号 / 文件路径 / 会议纪要），否则这条通过无法复核；
            判「不适用」必须写清理由，否则清单会被「不适用」填满，看起来全绿、实际一条都没验。
          </div>
          <div class="mf-detail">{{ mf.item ? mf.item.detail : '' }}</div>
          <div class="mf-how" v-if="mf.item">怎么验：{{ mf.item.how }}</div>

          <div class="row">
            <label>结论</label>
            <select v-model="mf.status" class="select" style="width: 150px">
              <option value="pass">通过</option>
              <option value="fail">不通过</option>
              <option value="na">不适用</option>
              <option value="pending">退回待处理</option>
            </select>
            <label>责任人</label>
            <input v-model="mf.owner" class="input" style="width: 150px" placeholder="姓名" />
          </div>
          <div class="row">
            <label>结论说明</label>
            <input v-model="mf.result" class="input" style="flex: 1" placeholder="如：六岗负责人均签字，争议 3 项当场调整" />
          </div>
          <div class="row">
            <label>证据</label>
            <input v-model="mf.evidence" class="input" style="flex: 1" placeholder="签字件档号 / 文件路径 / 会议纪要编号（判通过时必填）" />
          </div>
          <div class="row" v-if="mf.status === 'na'">
            <label>不适用理由</label>
            <input v-model="mf.na_reason" class="input" style="flex: 1" placeholder="为什么这一项对本轮不适用（至少 6 字）" />
          </div>
          <div v-if="!canRun" class="hint-box">你只有查看权限，判定需要「上线推进」权限（管理员 / 人事）。</div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="mf.open = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doManual">保存判定</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 签署 ================= -->
    <div class="modal-mask" v-if="sf.open" @click.self="sf.open = false">
      <div class="modal">
        <div class="modal-head"><b>签署 · {{ cur ? cur.round_no : '' }}</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="sf.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            签署会把<b>当前全部 26 项的结论、证据、判定人与统计</b>一起冻结成快照。
            签完之后不许刷新、不许改判定；要改必须先撤回并写明原因。
          </div>
          <div v-if="cur && cur.open_blockers.length" class="sign-block">
            还有 {{ cur.open_blockers.length }} 个阻塞项没过，<b>只能签「暂不上线」</b>：
            <div v-for="b in cur.open_blockers" :key="b.item_key" class="sb-row">· {{ b.title }}</div>
          </div>
          <div class="row">
            <label>结论</label>
            <select v-model="sf.conclusion" class="select" style="flex: 1">
              <option value="go" :disabled="cur && cur.open_blockers.length > 0">准予上线</option>
              <option value="conditional" :disabled="cur && cur.open_blockers.length > 0">有条件上线（遗留项限期关闭）</option>
              <option value="no_go">暂不上线</option>
            </select>
          </div>
          <div class="row">
            <label>说明</label>
            <textarea v-model="sf.note" class="input" rows="3" style="flex: 1"
              placeholder="选「有条件上线」或「暂不上线」时必须写：遗留哪几项、谁负责、什么时候关闭" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="sf.open = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doSign">确认签署</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 撤回 ================= -->
    <div class="modal-mask" v-if="wf.open" @click.self="wf.open = false">
      <div class="modal">
        <div class="modal-head"><b>撤回已签署的结论</b><span class="sp"></span>
          <button class="btn btn-sm btn-ghost" @click="wf.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="notice">
            撤回不会删除这一轮，它会被标成「已撤回」并留下原因。
            要改结论请撤回后<b>新建一轮</b>重新评估 —— 直接把已签的轮次改回去，
            历史签署就失去意义了。
          </div>
          <div class="row">
            <label>撤回原因</label>
            <input v-model="wf.reason" class="input" style="flex: 1" placeholder="如：上线前发现期初库存有差异，需重新盘库（至少 6 字）" />
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="wf.open = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doWithdraw">确认撤回</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canRun = computed(() => can('golive.run'));
const canSign = computed(() => can('golive.sign'));

const rounds = ref([]);
const roundId = ref(null);
const cur = ref(null);
const busy = ref(false);

const newForm = reactive({ open: false, scope: 'production', env_label: '生产环境', plan_date: '', app_version: '' });
const mf = reactive({ open: false, item: null, status: 'pass', result: '', evidence: '', na_reason: '', owner: '' });
const sf = reactive({ open: false, conclusion: 'go', note: '' });
const wf = reactive({ open: false, reason: '' });

const qs = (o) => {
  const p = new URLSearchParams();
  Object.keys(o || {}).forEach((k) => { if (o[k] !== null && o[k] !== undefined && o[k] !== '') p.append(k, o[k]); });
  const s = p.toString();
  return s ? '?' + s : '';
};

function fmt(v) {
  if (!v) return '—';
  return String(v).replace('T', ' ').slice(0, 16);
}
function statusCls(s) {
  return { pass: 'green', fail: 'red', warn: 'orange', na: 'gray', pending: 'gray' }[s] || 'gray';
}
function sevCls(s) {
  return { blocker: 'red', required: 'blue', nice: 'gray' }[s] || 'gray';
}

const verdictCls = computed(() => {
  if (!cur.value) return '';
  if (cur.value.status === 'signed') return cur.value.conclusion === 'go' ? 'ok' : 'mute';
  if (cur.value.status === 'blocked') return 'bad';
  if (cur.value.status === 'ready') return 'ok';
  return 'idle';
});

async function loadRounds(keep) {
  const list = await api.glRounds();
  rounds.value = list || [];
  if (!keep || !roundId.value) {
    roundId.value = rounds.value.length ? rounds.value[0].id : null;
  }
  if (roundId.value) await openRound(roundId.value);
  else cur.value = null;
}

async function openRound(id) {
  if (!id) return;
  roundId.value = id;
  cur.value = await api.glRound(id);
}

async function doNew() {
  busy.value = true;
  try {
    const r = await api.glCreate({
      scope: newForm.scope,
      env_label: newForm.env_label,
      plan_date: newForm.plan_date || undefined,
      app_version: newForm.app_version || undefined
    });
    newForm.open = false;
    await loadRounds();
    await openRound(r.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

async function doRefresh() {
  busy.value = true;
  try {
    const r = await api.glRefresh(cur.value.id);
    cur.value = r;
    const ch = r.refresh_changes || [];
    await loadRounds(true);
    await openRound(r.id);
    alert(ch.length
      ? `重跑完成，${ch.length} 项结论有变化：\n` + ch.map((x) => `· ${x.item_key}：${x.from} → ${x.to}`).join('\n')
      : '重跑完成，自动项结论没有变化');
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function openManual(it) {
  Object.assign(mf, {
    open: true, item: it,
    status: ['pass', 'fail', 'na'].includes(it.status) ? it.status : 'pass',
    result: it.result || '', evidence: it.evidence || '',
    na_reason: it.na_reason || '', owner: it.owner || ''
  });
}

async function doManual() {
  busy.value = true;
  try {
    cur.value = await api.glManual(mf.item.id, {
      status: mf.status, result: mf.result, evidence: mf.evidence,
      na_reason: mf.na_reason, owner: mf.owner
    });
    mf.open = false;
    await loadRounds(true);
    await openRound(cur.value.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function openSign() {
  Object.assign(sf, {
    open: true,
    conclusion: cur.value && cur.value.open_blockers.length ? 'no_go' : 'go',
    note: ''
  });
}
async function doSign() {
  busy.value = true;
  try {
    cur.value = await api.glSign(cur.value.id, { conclusion: sf.conclusion, note: sf.note });
    sf.open = false;
    await loadRounds(true);
    await openRound(cur.value.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

function askWithdraw() { Object.assign(wf, { open: true, reason: '' }); }
async function doWithdraw() {
  busy.value = true;
  try {
    cur.value = await api.glWithdraw(cur.value.id, { reason: wf.reason });
    wf.open = false;
    await loadRounds(true);
    await openRound(cur.value.id);
  } catch (e) {
    alert(e.message);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try { await loadRounds(); } catch (e) { alert(e.message); }
});
</script>

<style scoped>
/* 全局没有这些类，页面要自己定义；不定义就是普通 div，卡片、结论条全部变成裸文字 */
.empty-box { padding: 34px 22px; text-align: center; color: #5b6b80; font-size: 13px; line-height: 1.9; }

.verdict { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  border-radius: 14px; padding: 14px 18px; margin-bottom: 18px; border: 1px solid #e6ebf3; background: #fff; }
.verdict.ok { background: #f0faf3; border-color: #cdebd8; }
.verdict.bad { background: #fdf3f4; border-color: #f7d3d7; }
.verdict.idle { background: #f7f9fd; border-color: #e2e9f5; }
.verdict.mute { background: #f6f7f9; border-color: #e6e9ef; }
.v-left { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
.v-badge { background: #16233b; color: #fff; border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.verdict.ok .v-badge { background: #16a34a; }
.verdict.bad .v-badge { background: #d92d45; }
.v-title { font-size: 14px; color: #16233b; line-height: 1.6; }
.v-note { font-size: 12.5px; color: #5b6b80; margin-top: 5px; line-height: 1.7; max-width: 900px; }
.v-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.cards.c6 { grid-template-columns: repeat(6, 1fr); }
.stat-card .value.sm { font-size: 15px; line-height: 1.5; padding-top: 6px; }
/* 六列时每张只有 190px 左右，说明文字不控行高会挤成三四行 */
.stat-card .foot { font-size: 11px; line-height: 1.65; margin-top: 6px; color: #95a0b3; }

.blocker-box { background: #fff; border: 1px solid #f7d3d7; border-radius: 14px; padding: 14px 18px; margin-bottom: 18px; }
.bb-head { font-size: 13px; font-weight: 700; color: #d92d45; margin-bottom: 10px; }
.bb-row { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; padding: 5px 0; border-top: 1px dashed #f4e3e5; flex-wrap: wrap; }
.bb-row:first-of-type { border-top: none; }

.panel-card h3 { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.sec-note { font-size: 11.5px; color: #95a0b3; font-weight: 400; }
.sec-meta { font-size: 12px; color: #6b7688; white-space: nowrap; }

.item-list { display: flex; flex-direction: column; }
.item { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
  padding: 12px 0; border-top: 1px solid #f0f4f9; }
.item:first-child { border-top: none; }
.item.st-fail { background: linear-gradient(90deg, #fdf6f6 0%, #fff 60%); margin: 0 -10px; padding-left: 10px; padding-right: 10px; border-radius: 8px; }
.i-main { min-width: 0; flex: 1; }
.i-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.i-name { font-size: 13.5px; color: #16233b; }
.i-detail { font-size: 12px; color: #7d8798; line-height: 1.75; margin-top: 5px; }
.i-result { font-size: 12.5px; color: #33425c; line-height: 1.75; margin-top: 6px;
  background: #f7f9fd; border-radius: 7px; padding: 6px 9px; word-break: break-word; }
.i-result.amber-t { background: #fffaf0; color: #92400e; }
.i-evidence { font-size: 12px; color: #5b6b80; line-height: 1.75; margin-top: 5px; word-break: break-word; }
.ev-label { display: inline-block; font-size: 10.5px; background: #eef3fa; color: #1f5fae; border-radius: 4px;
  padding: 1px 6px; margin-right: 6px; vertical-align: 1px; }
.i-how { font-size: 11px; color: #9aa5b6; line-height: 1.7; margin-top: 5px; }
.i-who { margin-top: 4px; }
.i-ops { display: flex; align-items: center; gap: 6px; flex: none; padding-top: 2px; }
.auto-hint { white-space: nowrap; }

.mf-detail { font-size: 12.5px; color: #5b6b80; line-height: 1.8; margin: 10px 0 6px;
  background: #f7f9fd; border-radius: 8px; padding: 10px 12px; }
.mf-how { font-size: 12px; color: #7d8798; line-height: 1.75; margin-bottom: 12px; }
.sign-block { background: #fdf3f4; border: 1px solid #f7d3d7; border-radius: 8px;
  padding: 10px 12px; font-size: 12.5px; color: #a3283a; line-height: 1.8; margin: 10px 0; }
.sb-row { font-size: 12px; color: #8b3346; }

.snap-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 18px; font-size: 12.5px; margin-bottom: 12px; }
.snap-grid > div { display: flex; gap: 8px; align-items: baseline; }
.hint-box { background: #f7f9fd; border-left: 3px solid #c9d8ef; border-radius: 6px;
  padding: 10px 12px; font-size: 12px; color: #5b6b80; line-height: 1.8; }

.row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.row label { font-size: 12.5px; color: #5b6b80; white-space: nowrap; }
.notice { background: #f7f9fd; border-radius: 8px; padding: 10px 12px; font-size: 12.5px;
  color: #33425c; line-height: 1.8; margin-bottom: 12px; }

@media (max-width: 1180px) {
  .cards.c6 { grid-template-columns: repeat(3, 1fr); }
  .snap-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 620px) {
  .page-head { flex-direction: column; align-items: stretch; }
  .page-head .head-ops { width: 100%; flex: 1 1 auto; flex-wrap: wrap; }
  .page-head .head-ops .select { flex: 1 1 100%; min-width: 0; }
  .page-head .head-ops .btn { flex: 1 1 100%; }
  .cards.c6 { grid-template-columns: repeat(2, 1fr); }
  .verdict { flex-direction: column; }
  .v-right { width: 100%; }
  .v-right .btn { flex: 1 1 auto; }
  .item { flex-direction: column; }
  .i-ops { width: 100%; }
  .i-ops .btn { flex: 1 1 auto; }
  .snap-grid { grid-template-columns: 1fr; }
}
</style>
