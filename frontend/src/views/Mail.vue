<template>
  <div class="mail-page">
    <!-- 左：文件夹 -->
    <aside class="rail">
      <button class="btn btn-primary write-btn" @click="openCompose()">＋ 写邮件</button>
      <nav class="folders">
        <button v-for="f in folders" :key="f.key" class="folder" :class="{ active: folder === f.key }" @click="switchFolder(f.key)">
          <span class="f-ico">{{ f.icon }}</span>
          <span class="f-label">{{ f.label }}</span>
          <span v-if="badgeOf(f.key)" class="f-badge">{{ badgeOf(f.key) }}</span>
        </button>
      </nav>
      <div class="rail-foot">
        <button class="link-btn" @click="openStats">投递与确认统计</button>
        <button class="link-btn" @click="openDelegates">代理授权</button>
      </div>
    </aside>

    <!-- 中：列表 -->
    <section class="list">
      <div class="list-head">
        <input class="input search" v-model="q" placeholder="搜主题 / 正文 / 单号" @keyup.enter="loadBox" />
        <select class="select type-sel" v-model="typeFilter" @change="loadBox">
          <option value="">全部类型</option>
          <option value="normal">普通沟通</option>
          <option value="confirm">需确认</option>
          <option value="task">需办理</option>
        </select>
      </div>
      <div class="rows">
        <button v-for="r in rows" :key="r.id" class="mrow" :class="{ active: cur && cur.id === r.id, unread: r.unread }" @click="openMail(r.id)">
          <div class="m-top">
            <span class="m-sender">{{ folder === 'sent' ? '发给 ' + (r.to_names || '-') : r.sender_name }}</span>
            <span class="m-time">{{ shortTime(r.created_at) }}</span>
          </div>
          <div class="m-subject">
            <span v-if="r.unread" class="dot"></span>
            <span v-if="r.star" class="star">★</span>
            {{ r.subject }}
            <span v-if="r.attach_count" class="clip">📎</span>
          </div>
          <div class="m-snippet">{{ r.snippet }}</div>
          <div class="m-tags">
            <span class="tag" :class="typeTag(r.type)">{{ r.type_label }}</span>
            <span v-if="r.must_ack && r.ack_state === 'pending'" class="tag orange">待我确认</span>
            <span v-else-if="r.ack_state === 'questioned'" class="tag purple">已提疑问</span>
            <span v-else-if="r.ack_state === 'acked' && r.must_ack" class="tag green">已确认</span>
            <span v-if="r.task" class="tag blue">协同任务</span>
            <span v-if="r.status === 'recalled'" class="tag gray">已撤回</span>
            <span v-if="r.status === 'corrected'" class="tag gray">已更正</span>
          </div>
        </button>
        <div v-if="!rows.length" class="empty">{{ emptyText }}</div>
      </div>
    </section>

    <!-- 右：阅读 / 任务列表 -->
    <section class="reader">
      <!-- 需我办理：协同任务清单 -->
      <template v-if="folder === 'tasks' && !cur">
        <div class="reader-head"><h3>需我办理的协同任务</h3></div>
        <div class="reader-body">
          <div v-for="t in myTasks" :key="t.id" class="task-card">
            <div class="t-top">
              <span class="tag blue">{{ t.task_no }}</span>
              <b>{{ t.title }}</b>
              <span class="muted">期限 {{ t.due_at ? $fmt(t.due_at) : '未定' }}</span>
            </div>
            <div class="t-req">{{ t.requirement || '（未填完成要求）' }}</div>
            <div class="t-foot">
              <span class="muted">来自 {{ t.message_no }} · {{ t.sender_name }}</span>
              <div>
                <button class="link-btn" @click="openMail(t.message_id)">看原邮件</button>
                <button class="link-btn" @click="doneTask(t)">完成</button>
              </div>
            </div>
          </div>
          <div v-if="!myTasks.length" class="empty">没有待办的协同任务</div>
        </div>
      </template>

      <template v-else-if="cur">
        <div class="reader-head">
          <div>
            <h3>{{ cur.subject }}</h3>
            <div class="rh-meta">
              <span class="tag" :class="typeTag(cur.type)">{{ cur.type_label }}</span>
              <span class="tag gray">{{ cur.message_no }}</span>
              <span v-if="cur.version > 1" class="tag orange">V{{ cur.version }}</span>
              <span v-if="cur.acting_for" class="tag purple">代 {{ cur.acting_for }} 发</span>
              <span class="muted">{{ cur.sender_name }}<template v-if="cur.sender_dept"> · {{ cur.sender_dept }}</template> · {{ timeText(cur.created_at) }}</span>
            </div>
          </div>
          <div class="rh-ops">
            <button class="link-btn" @click="toggleFlag('star')">{{ cur.mine && cur.mine.star ? '★ 取消星标' : '☆ 星标' }}</button>
            <button v-if="isRecipient" class="link-btn" @click="toggleFlag('archived')">{{ cur.mine.archived ? '移出归档' : '归档' }}</button>
            <button v-if="isRecipient" class="link-btn" @click="toggleFlag('trash')">{{ cur.mine.trash ? '还原' : '删除' }}</button>
            <button class="link-btn" @click="openCompose('reply')">回复</button>
            <button v-if="hasCc" class="link-btn" @click="openCompose('reply_all')">回复全部</button>
            <button class="link-btn" @click="openCompose('forward')">转发</button>
          </div>
        </div>

        <div class="reader-body">
          <!-- 撤回 / 更正提示 -->
          <div v-if="cur.status === 'recalled'" class="bar gray">这封信已撤回{{ cur.recall_reason ? '：' + cur.recall_reason : '' }}</div>
          <div v-if="cur.status === 'corrected'" class="bar gray">
            这封信已更正，原文保留作为留痕。以更正版为准。
            <button v-if="cur.corrected_by" class="link-btn" @click="openMail(cur.corrected_by)">看更正版</button>
          </div>
          <div v-if="cur.recall_reason && cur.status !== 'recalled' && cur.status !== 'corrected'" class="bar gray">
            撤回结果：{{ cur.recall_reason }}
          </div>

          <!-- 需确认：本人待确认 -->
          <div v-if="needMyAck" class="bar amber">
            这封邮件要求你确认知悉，截止 {{ cur.confirm_due || '未设置' }}。
            <button class="btn btn-primary btn-sm" @click="doAck">确认知悉</button>
            <button class="btn btn-ghost btn-sm" @click="doQuestion">提出疑问</button>
          </div>
          <div v-else-if="cur.mine && cur.mine.ack_state === 'acked'" class="bar green">
            你已于 {{ timeText(cur.mine.ack_at) }} 确认知悉{{ cur.mine.ack_note ? '：' + cur.mine.ack_note : '' }}
            <span v-if="cur.mine.is_delegate" class="tag purple">由 {{ cur.mine.delegate_by }} 代确认</span>
          </div>
          <div v-else-if="cur.mine && cur.mine.ack_state === 'questioned'" class="bar purple">
            你提出了疑问：{{ cur.mine.question }}
            <template v-if="cur.mine.answer"><br />发件人答复：{{ cur.mine.answer }}（答复后仍需你自己确认）</template>
            <template v-else><br />等发件人答复，答复后仍需你自己确认。</template>
          </div>

          <!-- 发件人：答复疑问 -->
          <div v-if="isSender && questionedRows.length" class="bar purple">
            <div v-for="r in questionedRows" :key="r.id" style="margin-bottom: 6px">
              {{ r.name }} 的疑问：{{ r.question }}
              <button class="link-btn" @click="doAnswer(r)">答复</button>
            </div>
          </div>

          <!-- 源单投影（只读） -->
          <div v-if="cur.source" class="source-card">
            <div class="src-main">
              <span class="tag blue">关联业务</span>
              <b>{{ cur.source.label }}</b>
              <span class="tag" :class="cur.source.status === 'closed' ? 'gray' : 'green'">{{ cur.source.status_label }}</span>
            </div>
            <div class="src-note">
              只读投影：办理与结案都在原单里做，邮件里改不了状态。回复「好了」不等于业务完成。
              <router-link v-if="cur.source.link" :to="cur.source.link" class="link-btn">打开原单 →</router-link>
            </div>
          </div>

          <!-- 协同任务 -->
          <div v-if="cur.task" class="task-card">
            <div class="t-top">
              <span class="tag blue">{{ cur.task.task_no }}</span>
              <b>{{ cur.task.title }}</b>
              <span class="tag" :class="cur.task.status === 'done' ? 'green' : 'orange'">{{ cur.task.status === 'done' ? '已完成' : '待办' }}</span>
            </div>
            <div class="t-req">主责 {{ cur.task.owner }} · 期限 {{ cur.task.due_at ? $fmt(cur.task.due_at) : '未定' }} · {{ cur.task.requirement || '未填完成要求' }}</div>
            <div v-if="cur.task.status !== 'done'" class="t-foot">
              <span class="muted">一项交付物一名主责，不许抄送人人有份</span>
              <button class="link-btn" @click="doneTask(cur.task)">标记完成</button>
            </div>
            <div v-else class="t-foot"><span class="muted">完成于 {{ timeText(cur.task.done_at) }}{{ cur.task.done_note ? '：' + cur.task.done_note : '' }}</span></div>
          </div>

          <!-- 正文 -->
          <div class="body">{{ cur.body }}</div>

          <!-- 附件 -->
          <div v-if="cur.attachments.length" class="attach">
            <div class="a-title">附件 {{ cur.attachments.length }} 个（下载前会重新校验权限）</div>
            <a v-for="(a, i) in cur.attachments" :key="i" class="a-row" :href="a.url" target="_blank" rel="noopener">
              📎 {{ a.name }} <span class="muted">{{ fmtSize(a.size) }}</span>
            </a>
          </div>

          <!-- 回执明细 -->
          <div class="rcpt">
            <div class="rc-title">
              回执明细
              <span class="muted">
                必确认 {{ cur.ack_summary.must }} · 已确认 {{ cur.ack_summary.acked }} · 提疑问 {{ cur.ack_summary.questioned }} · 待确认 {{ cur.ack_summary.pending }}
                <template v-if="cur.ack_summary.failed"> · 投递失败 {{ cur.ack_summary.failed }}</template>
                <template v-if="cur.ack_summary.recalled"> · 已撤回 {{ cur.ack_summary.recalled }}</template>
              </span>
            </div>
            <div class="table-wrap">
              <table class="data rc-tbl">
                <thead>
                  <tr>
                    <th>收件人</th><th>类型</th><th>投递</th><th>首次打开</th><th>确认</th><th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in cur.recipients" :key="r.id">
                    <td>{{ r.name }}<span class="muted" style="font-size:11px"> {{ r.department || '' }}</span></td>
                    <td><span class="tag" :class="r.kind === 'to' ? 'blue' : 'gray'">{{ r.kind_label }}</span></td>
                    <td>
                      <span class="tag" :class="r.delivery_status === 'delivered' ? 'green' : r.delivery_status === 'failed' ? 'red' : 'gray'">{{ r.delivery_label }}</span>
                    </td>
                    <td>{{ r.first_read_at ? timeText(r.first_read_at) : '未打开' }}</td>
                    <td>
                      <span v-if="r.kind === 'cc'" class="muted">默认知悉</span>
                      <span v-else class="tag" :class="r.ack_state === 'acked' ? 'green' : r.ack_state === 'questioned' ? 'purple' : r.must_ack ? 'orange' : 'gray'">{{ r.ack_label }}</span>
                    </td>
                    <td class="note-cell">{{ r.ack_note || r.question || r.fail_reason || r.answer || '' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 会话其他信 -->
          <div v-if="others.length" class="thread">
            <div class="rc-title">同一会话（{{ others.length }} 封，只有你参与过的才看得到）</div>
            <button v-for="m in others" :key="m.id" class="th-row" @click="openMail(m.id)">
              <span class="tag gray">{{ m.version > 1 ? 'V' + m.version : 'V1' }}</span>
              <span class="th-sub">{{ m.subject }}</span>
              <span class="muted">{{ m.sender_name }} · {{ shortTime(m.created_at) }}</span>
            </button>
          </div>
        </div>

        <div class="reader-foot">
          <span class="muted" style="margin-right: auto; font-size: 12px">
            阅读、确认、办理三件事互相独立：读过不等于确认，确认不等于业务办完。
          </span>
          <button v-if="isSender && cur.ack_summary.failed" class="btn btn-ghost btn-sm" @click="doRetry">重试失败投递</button>
          <button v-if="isSender && cur.status !== 'recalled'" class="btn btn-ghost btn-sm" @click="doCorrect">更正</button>
          <button v-if="isSender && cur.status !== 'recalled'" class="btn btn-danger btn-sm" @click="doRecall">撤回</button>
        </div>
      </template>

      <template v-else>
        <div class="empty big">
          <div class="e-ico">✉️</div>
          <p>选一封邮件看正文，或者写一封新的。</p>
          <p class="muted" style="font-size: 12.5px">
            附件与源单都受权限控制；读过、确认、业务办完是三件独立的事。
          </p>
        </div>
      </template>
    </section>

    <!-- 写信 -->
    <div v-if="compose" class="modal-mask" @click.self="compose = null">
      <div class="modal xwide compose-modal">
        <div class="modal-head">
          <h3>{{ composeTitle }}</h3>
          <button class="x" @click="compose = null">×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <label>类型
              <select class="select" v-model="form.type">
                <option value="normal">普通沟通（不强制确认、不转任务）</option>
                <option value="confirm">需确认（收件人逐人确认知悉）</option>
                <option value="task">需办理（关联唯一任务）</option>
              </select>
            </label>
            <label>代理发信
              <select class="select" v-model="form.acting_for">
                <option value="">本人发信</option>
                <option v-for="d in myDelegateOut" :key="d.id" :value="d.owner">代 {{ d.owner }} 发</option>
              </select>
            </label>
          </div>

          <div class="pick">
            <div class="pick-row">
              <span class="pick-label">收件人</span>
              <select class="select" v-model="pickTo" style="width: 220px">
                <option value="">选员工或群组</option>
                <option v-for="g in groups" :key="g.code" :value="g.code">群组：{{ g.name }}（{{ g.count }}）</option>
                <option v-for="c in contacts" :key="c.username" :value="c.username">{{ c.label }}</option>
              </select>
              <button class="btn btn-ghost btn-sm" @click="addPick('to')">加入</button>
              <span v-for="(x, i) in form.to" :key="'t' + i" class="chip">
                {{ labelOf(x) }}<button class="chip-x" @click="form.to.splice(i, 1)">×</button>
              </span>
            </div>
            <div class="pick-row">
              <span class="pick-label">抄送</span>
              <select class="select" v-model="pickCc" style="width: 220px">
                <option value="">选员工或群组</option>
                <option v-for="g in groups" :key="g.code" :value="g.code">群组：{{ g.name }}（{{ g.count }}）</option>
                <option v-for="c in contacts" :key="c.username" :value="c.username">{{ c.label }}</option>
              </select>
              <button class="btn btn-ghost btn-sm" @click="addPick('cc')">加入</button>
              <span v-for="(x, i) in form.cc" :key="'c' + i" class="chip cc">
                {{ labelOf(x) }}<button class="chip-x" @click="form.cc.splice(i, 1)">×</button>
              </span>
              <span class="muted" style="font-size: 11.5px">抄送默认知悉，不承担确认义务</span>
            </div>
          </div>

          <label class="full">主题
            <input class="input" v-model="form.subject" placeholder="写清楚是什么事、要对方做什么" />
          </label>
          <label class="full">正文
            <textarea class="input ta" rows="7" v-model="form.body" placeholder="发送后不能原地改正文，只能发更正版。想清楚再发。"></textarea>
          </label>

          <div v-if="form.type === 'confirm'" class="form-grid">
            <label>确认截止
              <input class="input" type="datetime-local" v-model="form.confirm_due" />
            </label>
            <div class="hint">收件人里只有「收件人」需要逐人确认；抄送默认知悉。提出疑问不算确认。</div>
          </div>

          <template v-if="form.type === 'task'">
            <div class="form-grid">
              <label>关联业务（有原任务就选，只读投影）
                <select class="select" v-model="srcKey">
                  <option value="">不关联（建协同任务）</option>
                  <option v-for="s in sourceOptions" :key="s.key" :value="s.key">{{ s.label }}</option>
                </select>
              </label>
              <label>办理期限
                <input class="input" type="date" v-model="form.task_due" />
              </label>
            </div>
            <div v-if="!form.source_type" class="form-grid">
              <label>协同任务标题
                <input class="input" v-model="form.task.title" placeholder="一项交付物一条任务" />
              </label>
              <label>唯一主责人
                <select class="select" v-model="form.task.owner">
                  <option value="">选主责人</option>
                  <option v-for="c in contacts" :key="c.username" :value="c.username">{{ c.label }}</option>
                </select>
              </label>
              <label class="span2">完成要求
                <input class="input" v-model="form.task.requirement" placeholder="交付物长什么样、按什么口径" />
              </label>
            </div>
          </template>

          <div class="attach-row">
            <span class="pick-label">附件</span>
            <input ref="fileEl" type="file" multiple style="display: none" @change="onFiles" />
            <button class="btn btn-ghost btn-sm" @click="$refs.fileEl.click()">选择文件</button>
            <span v-for="(a, i) in form.attachments" :key="i" class="chip">
              📎 {{ a.name }}<button class="chip-x" @click="form.attachments.splice(i, 1)">×</button>
            </span>
            <span class="muted" style="font-size: 11.5px">单个 ≤10MB；附件记录大小与哈希</span>
          </div>

          <div v-if="composeWarn" class="warn">{{ composeWarn }}</div>
        </div>
        <div class="modal-foot">
          <span class="muted" style="margin-right: auto; font-size: 12px">
            发送前会重新校验：账号有效性、收件范围、源单访问权限、附件状态
          </span>
          <button class="btn btn-ghost" @click="compose = null">取消</button>
          <button class="btn btn-primary" :disabled="sending" @click="doSend">发送</button>
        </div>
      </div>
    </div>

    <!-- 统计 -->
    <div v-if="statsOpen" class="modal-mask" @click.self="statsOpen = false">
      <div class="modal">
        <div class="modal-head"><h3>投递与确认统计</h3><button class="x" @click="statsOpen = false">×</button></div>
        <div class="modal-body">
          <div class="stat-grid">
            <div><span>已发送信件</span><b>{{ stats.sent_messages || 0 }}</b></div>
            <div><span>投递行</span><b>{{ stats.lines || 0 }}</b></div>
            <div><span>已送达</span><b class="g">{{ stats.delivered || 0 }}</b></div>
            <div><span>失败</span><b :class="stats.failed ? 'r' : ''">{{ stats.failed || 0 }}</b></div>
            <div><span>已撤回</span><b>{{ stats.recalled || 0 }}</b></div>
            <div><span>已打开</span><b>{{ stats.opened || 0 }}</b></div>
            <div><span>必确认行</span><b>{{ stats.must_ack || 0 }}</b></div>
            <div><span>已确认</span><b class="g">{{ stats.acked || 0 }}</b></div>
            <div><span>提疑问</span><b>{{ stats.questioned || 0 }}</b></div>
            <div><span>确认率</span><b>{{ stats.ack_rate === null ? '-' : stats.ack_rate + '%' }}</b></div>
          </div>
          <p class="muted" style="font-size: 12.5px; margin-top: 12px">
            投递以「信件 × 收件人」计；确认只统计必确认行；失败、撤回、疑问各列，不当作成功。
            已读率不用于考核员工。
          </p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="statsOpen = false">关闭</button></div>
      </div>
    </div>

    <!-- 代理授权 -->
    <div v-if="delegateOpen" class="modal-mask" @click.self="delegateOpen = false">
      <div class="modal">
        <div class="modal-head"><h3>代理授权</h3><button class="x" @click="delegateOpen = false">×</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <label>代理人
              <select class="select" v-model="dgForm.agent">
                <option value="">选员工</option>
                <option v-for="c in contacts" :key="c.username" :value="c.username">{{ c.label }}</option>
              </select>
            </label>
            <label>范围
              <select class="select" v-model="dgForm.scope">
                <option value="ack">只代确认</option>
                <option value="send">只代发</option>
                <option value="all">全部</option>
              </select>
            </label>
            <label>开始<input class="input" type="date" v-model="dgForm.start_at" /></label>
            <label>结束<input class="input" type="date" v-model="dgForm.end_at" /></label>
            <label class="span2">原因<input class="input" v-model="dgForm.reason" /></label>
          </div>
          <button class="btn btn-primary btn-sm" style="margin-top: 10px" @click="saveDelegate">新增授权</button>
          <div class="table-wrap" style="margin-top: 12px">
            <table class="data">
              <thead><tr><th>委托人</th><th>代理人</th><th>范围</th><th>起止</th><th>状态</th><th></th></tr></thead>
              <tbody>
                <tr v-for="d in delegates" :key="d.id">
                  <td>{{ d.owner }}</td>
                  <td>{{ d.agent }}</td>
                  <td>{{ d.scope === 'all' ? '全部' : d.scope === 'ack' ? '只代确认' : '只代发' }}</td>
                  <td class="muted nowrap">{{ $fmt(d.start_at) }} ~ {{ $fmt(d.end_at) }}</td>
                  <td>
                    <span class="tag" :class="d.effective ? 'green' : 'gray'">{{ d.effective ? '有效' : d.expired ? '已过期' : d.status }}</span>
                  </td>
                  <td><button v-if="d.effective" class="link-btn danger" @click="revokeDelegate(d)">撤销</button></td>
                </tr>
                <tr v-if="!delegates.length"><td colspan="6" class="empty">还没有代理授权</td></tr>
              </tbody>
            </table>
          </div>
          <p class="muted" style="font-size: 12px; margin-top: 10px">
            代理有起止时间与范围；代理确认会记录「由谁代确认」，不伪造本人知悉。
          </p>
        </div>
        <div class="modal-foot"><button class="btn btn-ghost" @click="delegateOpen = false">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { fmtTime } from '../utils/time';

const folders = [
  { key: 'inbox', label: '收件箱', icon: '📥' },
  { key: 'pending', label: '待我确认', icon: '🔔' },
  { key: 'tasks', label: '需我办理', icon: '📌' },
  { key: 'sent', label: '已发送', icon: '📤' },
  { key: 'starred', label: '星标', icon: '★' },
  { key: 'archived', label: '归档', icon: '🗄' },
  { key: 'trash', label: '回收站', icon: '🗑' }
];

const folder = ref('inbox');
const q = ref('');
const typeFilter = ref('');
const rows = ref([]);
const counts = ref({});
const cur = ref(null);
const others = ref([]);
const myTasks = ref([]);
const contacts = ref([]);
const groups = ref([]);
const delegates = ref([]);

const compose = ref(null);
const composeWarn = ref('');
const sending = ref(false);
const pickTo = ref('');
const pickCc = ref('');
const srcKey = ref('');
const fileEl = ref(null);

const statsOpen = ref(false);
const stats = ref({});
const delegateOpen = ref(false);
const dgForm = ref({ agent: '', scope: 'ack', start_at: '', end_at: '', reason: '' });

const blankForm = () => ({
  action: 'new', parent_id: null, subject: '', body: '', type: 'normal',
  to: [], cc: [], attachments: [], acting_for: '', confirm_due: '', task_due: '',
  source_type: null, source_id: null,
  task: { title: '', owner: '', requirement: '' }
});
const form = ref(blankForm());

const typeTag = (t) => ({ normal: 'gray', confirm: 'orange', task: 'blue' }[t] || 'gray');
const badgeOf = (k) => {
  if (k === 'inbox') return counts.value.inbox_unread || 0;
  return counts.value[k] || 0;
};

const isSender = computed(() => !!cur.value && cur.value.sender === myName());
const isRecipient = computed(() => !!cur.value && !!cur.value.mine);
const needMyAck = computed(() => {
  const m = cur.value && cur.value.mine;
  return !!(m && m.must_ack && m.ack_state === 'pending' && !isSender.value && cur.value.status !== 'recalled');
});
const hasCc = computed(() => !!(cur.value && cur.value.cc && cur.value.cc.length));
const questionedRows = computed(() => ((cur.value && cur.value.recipients) || []).filter((r) => r.ack_state === 'questioned'));
const myDelegateOut = computed(() => delegates.value.filter((d) => d.owner === myName() && d.effective && d.scope !== 'ack'));
const emptyText = computed(() => {
  if (folder.value === 'tasks') return '协同任务在右侧列表 →';
  if (folder.value === 'trash') return '回收站是空的';
  return q.value ? '没有匹配的邮件' : '这个文件夹里还没有邮件';
});
const composeTitle = computed(() => {
  if (!compose.value) return '写邮件';
  if (compose.value.mode === 'reply') return '回复';
  if (compose.value.mode === 'reply_all') return '回复全部';
  if (compose.value.mode === 'forward') return '转发';
  return '写邮件';
});
const sourceOptions = ref([]);

function myName() {
  try {
    const u = JSON.parse(localStorage.getItem('erp_user') || '{}');
    return u.username || '';
  } catch (e) { return ''; }
}

const shortTime = (s) => {
  if (!s) return '';
  const d = new Date(s);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
};
const timeText = (s) => (s ? fmtTime(s) : '-');
const fmtSize = (n) => {
  const v = Number(n) || 0;
  if (!v) return '';
  return v > 1048576 ? (v / 1048576).toFixed(1) + 'MB' : Math.round(v / 1024) + 'KB';
};
const labelOf = (code) => {
  if (code === 'all') return '全体员工';
  if (String(code).startsWith('dept:')) {
    const g = groups.value.find((x) => x.code === code);
    return g ? g.name : code;
  }
  const c = contacts.value.find((x) => x.username === code);
  return c ? c.name + '（' + (c.department || '未分部门') + '）' : code;
};

async function loadBox() {
  try {
    if (folder.value === 'tasks') {
      myTasks.value = await api.mailTasksMine({ status: 'open' });
      rows.value = [];
      cur.value = null;
      const u = await api.mailUnread();
      counts.value = { ...counts.value, tasks: u.my_tasks || 0 };
      return;
    }
    const d = await api.mailBox({ folder: folder.value, q: q.value, type: typeFilter.value });
    rows.value = d.rows || [];
    counts.value = d.counts || {};
    const u = await api.mailUnread();
    counts.value.tasks = u.my_tasks || 0;
    cur.value = null;
    others.value = [];
  } catch (e) { alert(e.message); }
}

async function switchFolder(k) {
  folder.value = k;
  await loadBox();
}

async function loadMeta() {
  try {
    const c = await api.mailContacts();
    contacts.value = c.contacts || [];
    groups.value = c.groups || [];
    delegates.value = await api.mailDelegates() || [];
  } catch (e) { /* 静默 */ }
}

async function openMail(id) {
  try {
    const d = await api.mailMessage(id);
    cur.value = d;
    others.value = (d.thread || []).filter((x) => x.id !== d.id);
    await loadBoxCounts();
  } catch (e) { alert(e.message); }
}

async function loadBoxCounts() {
  try {
    const u = await api.mailUnread();
    counts.value = { ...counts.value, inbox: u.inbox, pending: u.need_ack, tasks: u.my_tasks };
  } catch (e) { /* 静默 */ }
}

async function toggleFlag(kind) {
  if (!cur.value || !cur.value.mine) return;
  const patch = {};
  if (kind === 'star') patch.star = cur.value.mine.star ? 0 : 1;
  if (kind === 'archived') patch.archived = cur.value.mine.archived ? 0 : 1;
  if (kind === 'trash') patch.trash = cur.value.mine.trash ? 0 : 1;
  try {
    await api.flagMail(cur.value.id, patch);
    const d = await api.mailMessage(cur.value.id);
    cur.value = d;
    await loadBox();
    if (patch.trash) cur.value = null;
  } catch (e) { alert(e.message); }
}

async function doAck() {
  const note = prompt('确认备注（可留空）：', '') || '';
  try {
    const d = await api.ackMail(cur.value.id, { note: note.trim() });
    cur.value = d;
    await loadBoxCounts();
    alert('已确认知悉。注意：确认知悉不等于业务办完。');
  } catch (e) { alert(e.message); }
}

async function doQuestion() {
  const question = prompt('你的疑问（提问不算确认）：', '');
  if (question === null) return;
  if (!String(question).trim()) return alert('请写清楚疑问');
  try {
    const d = await api.questionMail(cur.value.id, { question: question.trim() });
    cur.value = d;
    await loadBoxCounts();
  } catch (e) { alert(e.message); }
}

async function doAnswer(row) {
  const answer = prompt(`答复 ${row.name}：`, '');
  if (answer === null) return;
  if (!String(answer).trim()) return alert('请填写答复内容');
  try {
    const d = await api.answerMail(cur.value.id, { recipient_id: row.id, answer: answer.trim() });
    cur.value = d;
  } catch (e) { alert(e.message); }
}

async function doRecall() {
  const reason = prompt('撤回原因（必填）：', '发错了');
  if (reason === null) return;
  if (!String(reason).trim()) return alert('撤回必须写原因');
  if (!confirm('逐人撤回：已读或已确认的收件人收不回来。继续？')) return;
  try {
    const d = await api.recallMail(cur.value.id, reason.trim());
    alert(d.notice || '已撤回');
    const fresh = await api.mailMessage(cur.value.id);
    cur.value = fresh;
    await loadBox();
  } catch (e) { alert(e.message); }
}

async function doCorrect() {
  const body = prompt('更正后的正文：', cur.value.body);
  if (body === null) return;
  const reason = prompt('更正原因（原信哪里不对）：', '');
  if (reason === null) return;
  if (!String(reason).trim()) return alert('更正必须写原因');
  try {
    const d = await api.correctMail(cur.value.id, { body, reason: reason.trim() });
    alert(d.notice || '已发更正版');
    await openMail(d.id);
    await loadBox();
  } catch (e) { alert(e.message); }
}

async function doRetry() {
  try {
    const d = await api.retryMail(cur.value.id);
    alert(`重试完成：成功 ${d.delivery.delivered}，失败 ${d.delivery.failed}`);
    await openMail(cur.value.id);
  } catch (e) { alert(e.message); }
}

async function doneTask(t) {
  const note = prompt('完成说明（可留空）：', '') || '';
  try {
    await api.doneMailTask(t.id, { note: note.trim() });
    alert('已结案');
    if (folder.value === 'tasks') await loadBox();
    else if (cur.value) await openMail(cur.value.id);
  } catch (e) { alert(e.message); }
}

/* ---------- 写信 ---------- */
function openCompose(mode) {
  const f = blankForm();
  if (mode && cur.value) {
    f.action = mode === 'reply' ? 'reply' : mode === 'reply_all' ? 'reply_all' : 'forward';
    f.parent_id = cur.value.id;
    if (mode === 'reply') {
      f.to = [cur.value.sender];
      f.subject = /^Re:/i.test(cur.value.subject) ? cur.value.subject : 'Re: ' + cur.value.subject;
    } else if (mode === 'reply_all') {
      f.to = [cur.value.sender, ...cur.value.to.map((x) => x.username)].filter((x, i, a) => a.indexOf(x) === i && x !== myName());
      f.cc = cur.value.cc.map((x) => x.username).filter((x) => x !== myName());
      f.subject = /^Re:/i.test(cur.value.subject) ? cur.value.subject : 'Re: ' + cur.value.subject;
    } else {
      f.subject = /^Fwd:/i.test(cur.value.subject) ? cur.value.subject : 'Fwd: ' + cur.value.subject;
      f.body = `\n\n---------- 转发原文 ----------\n${cur.value.sender_name}：${cur.value.body}`;
      f.source_type = cur.value.source_type;
      f.source_id = cur.value.source_id;
    }
    f.type = cur.value.type === 'confirm' ? 'confirm' : cur.value.type === 'task' ? 'task' : 'normal';
  }
  form.value = f;
  composeWarn.value = '';
  srcKey.value = f.source_type && f.source_id ? `${f.source_type}:${f.source_id}` : '';
  compose.value = { mode: mode || 'new' };
}

function addPick(kind) {
  const v = kind === 'to' ? pickTo.value : pickCc.value;
  if (!v) return;
  const arr = kind === 'to' ? form.value.to : form.value.cc;
  if (!arr.includes(v)) arr.push(v);
  if (kind === 'to') pickTo.value = ''; else pickCc.value = '';
}

async function onFiles(e) {
  const files = [...(e.target.files || [])];
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { alert(`${f.name} 超过 10MB`); continue; }
    const dataUrl = await new Promise((res) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result);
      rd.readAsDataURL(f);
    });
    try {
      const up = await api.uploadFile(dataUrl, f.name);
      form.value.attachments.push({
        name: up.filename || f.name, url: up.url, size: up.size, ext: (f.name.split('.').pop() || '').toLowerCase(),
        hash: fnv(dataUrl)
      });
    } catch (err) { alert(`${f.name} 上传失败：${err.message}`); }
  }
  e.target.value = '';
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

async function doSend() {
  const f = form.value;
  composeWarn.value = '';
  if (!f.to.length) return alert('至少要有一个收件人');
  if (!String(f.subject).trim()) return alert('请填主题');
  if (!String(f.body).trim()) return alert('正文不能为空');
  if (f.type === 'confirm' && !f.confirm_due) return alert('需确认邮件必须填确认截止');
  if (f.type === 'task') {
    if (!f.task_due) return alert('需办理邮件必须填办理期限');
    if (!f.source_type && (!f.task.title || !f.task.owner)) return alert('没有原任务时，协同任务必须有标题和唯一主责人');
  }
  if (srcKey.value) {
    const [t, id] = srcKey.value.split(':');
    f.source_type = t;
    f.source_id = Number(id);
  } else if (f.action === 'new') {
    f.source_type = null;
    f.source_id = null;
  }
  sending.value = true;
  try {
    const payload = { ...f, request_no: 'WEB' + Date.now() + Math.random().toString(36).slice(2, 8) };
    const d = await api.sendMail(payload);
    compose.value = null;
    await loadBox();
    if (d.warnings && d.warnings.length) alert('已发送。\n\n' + d.warnings.join('\n'));
    await openMail(d.id);
  } catch (e) { composeWarn.value = e.message; } finally { sending.value = false; }
}

async function openStats() {
  try {
    stats.value = await api.mailStats();
    statsOpen.value = true;
  } catch (e) { alert(e.message); }
}

async function openDelegates() {
  try {
    delegates.value = await api.mailDelegates() || [];
    dgForm.value = {
      agent: '', scope: 'ack',
      start_at: new Date().toISOString().slice(0, 10),
      end_at: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      reason: ''
    };
    delegateOpen.value = true;
  } catch (e) { alert(e.message); }
}

async function saveDelegate() {
  const d = dgForm.value;
  if (!d.agent) return alert('请选代理人');
  try {
    await api.saveMailDelegate({ ...d, owner: myName() });
    delegates.value = await api.mailDelegates() || [];
    alert('已授权');
  } catch (e) { alert(e.message); }
}

async function revokeDelegate(d) {
  if (!confirm(`撤销 ${d.owner} → ${d.agent} 的代理？`)) return;
  try {
    await api.revokeMailDelegate(d.id);
    delegates.value = await api.mailDelegates() || [];
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  await loadMeta();
  await loadBox();
  // 源单选项：拿最近的几张单做只读关联
  try {
    const [orders, fas, grns] = await Promise.all([
      api.orders().catch(() => []),
      api.faBoard().catch(() => ({ rows: [] })),
      api.receiptBoard().catch(() => ({ rows: [] }))
    ]);
    const opts = [];
    (Array.isArray(orders) ? orders : orders.rows || [])
      .filter((o) => !['closed', 'cancelled'].includes(o.status))
      .slice(0, 5).forEach((o) => opts.push({ key: `order:${o.id}`, label: `订单 ${o.order_no}（${o.style_name || ''}）` }));
    ((fas && fas.rows) || []).filter((r) => r.fa).slice(0, 5).forEach((r) => opts.push({ key: `first_article:${r.fa.id}`, label: `首件 ${r.fa.fa_no}` }));
    ((grns && grns.rows) || []).slice(0, 5).forEach((r) => opts.push({ key: `receipt:${r.id}`, label: `收料 ${r.grn_no}` }));
    sourceOptions.value = opts;
  } catch (e) { /* 静默 */ }
});
</script>

<style scoped>
.mail-page { display: grid; grid-template-columns: 178px 336px 1fr; gap: 12px; height: calc(100vh - 120px); min-height: 560px; }
.rail { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; padding: 12px 10px; display: flex; flex-direction: column; }
.write-btn { width: 100%; margin-bottom: 10px; }
.folders { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.folder { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: none; background: transparent; border-radius: 8px; cursor: pointer; font-size: 13px; color: #33415a; text-align: left; }
.folder:hover { background: #f4f7fc; }
.folder.active { background: #e8f0ff; color: #1d4ed8; font-weight: 700; }
.f-ico { width: 16px; text-align: center; }
.f-label { flex: 1; }
.f-badge { background: #d92d45; color: #fff; font-size: 10.5px; border-radius: 10px; padding: 1px 6px; font-weight: 700; }
.rail-foot { border-top: 1px solid #eef2f7; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }

.list { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; }
.list-head { padding: 10px; border-bottom: 1px solid #eef2f7; display: flex; gap: 6px; }
.search { flex: 1; font-size: 12.5px; padding: 6px 9px; }
.type-sel { width: 96px; font-size: 12px; padding: 6px 4px; }
.rows { overflow-y: auto; flex: 1; }
.mrow { display: block; width: 100%; text-align: left; border: none; background: transparent; border-bottom: 1px solid #f2f5f9; padding: 10px 12px; cursor: pointer; }
.mrow:hover { background: #f9fbfe; }
.mrow.active { background: #eef4ff; }
.mrow.unread .m-subject { font-weight: 700; color: #16233b; }
.m-top { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #5b6474; }
.m-sender { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-time { color: #a9b4c5; flex: 0 0 auto; }
.m-subject { font-size: 13px; color: #33415a; margin: 3px 0 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-subject .dot { display: inline-block; width: 6px; height: 6px; background: #2b6de5; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.m-subject .star { color: #f59e0b; margin-right: 3px; }
.m-snippet { font-size: 11.5px; color: #9aa4b5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-tags { display: flex; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
.m-tags .tag { font-size: 10.5px; padding: 1px 7px; }

.reader { background: #fff; border: 1px solid #e6ebf3; border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; }
.reader-head { padding: 14px 18px 10px; border-bottom: 1px solid #eef2f7; display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.reader-head h3 { margin: 0 0 6px; font-size: 16px; color: #16233b; line-height: 1.4; }
.rh-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.rh-ops { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; flex: 0 0 auto; }
.reader-body { padding: 14px 18px; overflow-y: auto; flex: 1; }
.reader-foot { border-top: 1px solid #eef2f7; padding: 10px 18px; display: flex; gap: 8px; align-items: center; }
.bar { padding: 9px 12px; border-radius: 9px; font-size: 12.5px; margin-bottom: 10px; line-height: 1.7; }
.bar.gray { background: #f5f7fa; border: 1px solid #e6ebf3; color: #5b6474; }
.bar.amber { background: #fffdf5; border: 1px solid #f6e3b6; color: #a16207; }
.bar.green { background: #f3fbf6; border: 1px solid #cfe9da; color: #15803d; }
.bar.purple { background: #f8f5ff; border: 1px solid #e2d7fb; color: #6d28d9; }
.source-card { border: 1px solid #dbe4f5; background: #f6f9ff; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
.src-main { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #16233b; }
.src-note { font-size: 11.5px; color: #6b7688; margin-top: 5px; line-height: 1.6; }
.body { white-space: pre-wrap; font-size: 13.5px; line-height: 1.85; color: #33415a; padding: 6px 0 10px; }
.attach { margin: 8px 0 12px; }
.a-title { font-size: 12px; color: #6b7688; margin-bottom: 6px; }
.a-row { display: block; font-size: 12.5px; color: #2b6de5; padding: 4px 0; text-decoration: none; }
.rcpt { border-top: 1px dashed #e6ebf3; padding-top: 10px; margin-top: 8px; }
.rc-title { font-size: 12.5px; font-weight: 700; color: #16233b; margin-bottom: 8px; }
.rc-title .muted { font-weight: 400; font-size: 11.5px; margin-left: 6px; }
.rc-tbl { min-width: 640px; font-size: 12px; }
.rc-tbl th, .rc-tbl td { padding: 7px 10px; }
.note-cell { max-width: 240px; white-space: normal; color: #5b6474; }
.thread { margin-top: 14px; border-top: 1px dashed #e6ebf3; padding-top: 10px; }
.th-row { display: flex; align-items: center; gap: 8px; width: 100%; border: none; background: #fafbfd; border-radius: 8px; padding: 7px 10px; margin-bottom: 5px; cursor: pointer; font-size: 12.5px; text-align: left; }
.th-row:hover { background: #f2f6fd; }
.th-sub { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #33415a; }
.task-card { border: 1px solid #dbe4f5; background: #f8fafd; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
.t-top { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #16233b; flex-wrap: wrap; }
.t-req { font-size: 12px; color: #5b6474; margin-top: 6px; line-height: 1.6; }
.t-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 11.5px; }
.empty { text-align: center; color: #9aa4b5; padding: 28px 12px; font-size: 12.5px; }
.empty.big { padding-top: 15vh; }
.e-ico { font-size: 34px; margin-bottom: 10px; }
.empty.big p { margin: 4px 0; font-size: 13px; color: #5b6474; }

.modal.xwide.compose-modal { width: 900px; max-width: 97vw; }
.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 10px; }
.form-grid label, label.full { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5b6474; margin-bottom: 10px; }
.form-grid .span2 { grid-column: span 2; }
.hint { font-size: 11.5px; color: #8a94a6; align-self: end; padding-bottom: 8px; line-height: 1.6; }
.pick { border: 1px solid #eef2f7; border-radius: 10px; padding: 10px; margin-bottom: 12px; background: #fbfcfe; }
.pick-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.pick-row:last-child { margin-bottom: 0; }
.pick-label { font-size: 12px; color: #5b6474; width: 44px; flex: 0 0 auto; }
.chip { display: inline-flex; align-items: center; gap: 4px; background: #e8f0ff; color: #1d4ed8; border-radius: 14px; padding: 2px 6px 2px 9px; font-size: 11.5px; }
.chip.cc { background: #f0f2f6; color: #5b6474; }
.chip-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; }
.attach-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0 4px; }
.input.ta { line-height: 1.7; font-family: inherit; resize: vertical; }
.warn { margin-top: 10px; padding: 8px 12px; background: #fff8f9; border: 1px solid #f8d3d8; border-radius: 8px; font-size: 12.5px; color: #b91c1c; }
.stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.stat-grid > div { background: #f8fafd; border: 1px solid #eef2f7; border-radius: 9px; padding: 9px 11px; }
.stat-grid span { display: block; font-size: 11.5px; color: #8a94a6; }
.stat-grid b { font-size: 17px; color: #16233b; }
.stat-grid b.g { color: #16a34a; }
.stat-grid b.r { color: #d92d45; }
.table-wrap { overflow-x: auto; }
.table-wrap table.data { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.table-wrap table.data th { text-align: left; padding: 8px 10px; background: #f7f9fc; color: #5b6474; font-size: 12px; }
.table-wrap table.data td { padding: 7px 10px; border-bottom: 1px solid #eef2f7; }
.table-wrap table.data td.empty { text-align: center; color: #9aa4b5; padding: 14px; }
@media (max-width: 1200px) {
  .mail-page { grid-template-columns: 1fr; height: auto; }
  .rail { flex-direction: row; align-items: center; overflow-x: auto; }
  .folders { flex-direction: row; }
  .rail-foot { border: none; flex-direction: row; }
  .reader { min-height: 480px; }
}
</style>
