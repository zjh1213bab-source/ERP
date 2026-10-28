/**
 * 操作日志 / 审计
 * ============================================================
 * 一句话：**这条日志能不能拿给外人看？** 不能就别叫审计。
 *
 * 过去的日志只有 `谁 在什么时候 请求了哪个 URL`，三个问题：
 *   ① 能改 —— 直接改库删掉一条，没人看得出来；
 *   ② 看不懂 —— `POST /api/orders/123/tech` 对审计员等于天书；
 *   ③ 交不出去 —— 导出就是一张没有边界的表格，对方无法确认「是不是全的」。
 *
 * 这一版加三样，一件都不能少：
 *
 * **1. 哈希链（`seq` + `prev_hash` + `hash`）**
 *    每条日志算 `sha256(上一条hash | 序号 | 账号 | 方法 | 路径 | 状态码 | 时间)`。
 *    改任何一条的内容 → 该条 hash 变 → 后面每一条都对不上，`verify()` 直接指出断在第几条。
 *
 * **2. 链头水位（`audit_chain_state`）**
 *    光有链只防「改」，不防「删」：把最后 100 条删掉，剩下的链依然自洽。
 *    所以另存一张单行表记住 `last_seq / last_hash`，删日志不动它 ——
 *    `verify()` 发现「库里最大 seq < 记录的水位」就报尾部被删。
 *    归档（合法删除）会把 `anchor_seq/anchor_hash` 往前推，所以「合法删」和「偷偷删」分得开。
 *
 * **3. 业务语义（module / action / target / summary）**
 *    把 URL 翻译成人话：「销售订单 orders#123 · 流转」。外行也看得懂。
 *
 * 三条边界（写死，别越界）：
 *   - **只记事实，不记内容**：记「谁动了哪张单」，不记单里写了什么（body 里有密码、有金额，
 *     日志一旦记 body，日志本身就成了泄密源）。所以这里永远不碰 req.body。
 *   - **失败也要记**：401/403 反复出现往往是在试探权限，比成功操作更值得看。
 *   - **日志只追加**：不提供「删除单条」接口。归档是唯一的移除方式，且必须留文件 + 哈希。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const { db, now } = require('../db');
const { ROLE_LABELS } = require('../access/permissions');

const GENESIS = '0'.repeat(64);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

// ---------------- 语义翻译 ----------------

/**
 * 子域 → [大类, 中文]。key 就是 /api/ 后的第一段。
 * 为什么要分两层：**展示要具体，统计要归纳**。
 * 表格里写「计件」「总账」「验货」才有用；但统计图上 87 个子域没法看，得归到 9 个大类。
 * （教训：一开始只用大类当 module，结果 system 被 auth/users/access/settings/ai 反复覆盖，
 *  标签最后变成最后一条的「附件」——一个 code 多个 label 必须显式分层。）
 */
const DOMAINS = {
  // 系统
  auth: ['system', '登录'], users: ['system', '账号'], access: ['system', '权限复核'],
  settings: ['system', '系统设置'], admin: ['system', '系统管理'], backup: ['system', '数据备份'],
  audit: ['system', '操作日志'],
  notify: ['system', '消息通知'], mail: ['system', '内部邮件'], integration: ['system', '外部接口'],
  photos: ['system', '照片'], upload: ['system', '附件上传'], dq: ['system', '数据质量'],
  importops: ['system', '数据导入'], import: ['system', '数据导入'],
  assistant: ['system', '智能助手'], ai: ['system', 'AI 能力'], kpi: ['system', 'KPI'],
  // 销售
  orders: ['sales', '销售订单'], 'order-nodes': ['production', '工序'],
  customers: ['sales', '客户'], quotations: ['sales', '报价'], 'price-tiers': ['sales', '阶梯价'],
  pricing: ['sales', '定价'], crm: ['sales', '客户关系'], channel: ['sales', '渠道'],
  mall: ['sales', '客户商城'], 'mall-admin': ['sales', '商城管理'],
  // 营销
  mkt: ['marketing', '营销素材'], segments: ['marketing', '客群分层'],
  // 技术
  techpacks: ['tech', '开发单'], devmaster: ['tech', '研发立项'], 'pattern-flows': ['tech', '版型流程'],
  'craft-types': ['tech', '工艺类型'], requirements: ['tech', '需求'],
  samples: ['tech', '打样'], 'sample-archives': ['tech', '样衣归档'],
  // 生产
  production: ['production', '生产'], reports: ['production', '报工'], labels: ['production', '扎标'],
  cuts: ['production', '裁床'], cutdispatch: ['production', '裁片外发'], process: ['production', '工序'],
  'production-close': ['production', '生产关单'], reworks: ['production', '返工'],
  qc: ['production', '质检'], inspection: ['production', '验货报告'],
  'first-articles': ['production', '首件确认'], schedule: ['production', '排程'],
  equipment: ['production', '设备'], facility: ['production', '产能'],
  factories: ['production', '分厂'], dispatch: ['production', '分单'],
  // 仓储
  stock: ['warehouse', '库存'], spot: ['warehouse', '现货库龄'], spotops: ['warehouse', '现货操作'],
  wh: ['warehouse', '仓储作业'], whplan: ['warehouse', '仓配计划'], warehouse: ['warehouse', '仓储'],
  purchases: ['warehouse', '采购'], 'purchase-changes': ['warehouse', '采购变更'],
  receipts: ['warehouse', '收货'], materials: ['warehouse', '面辅料'], matflow: ['warehouse', '领退料'],
  suppliers: ['warehouse', '供应商'], 'supplier-evals': ['warehouse', '供应商评价'],
  supreview: ['warehouse', '供方复审'], supply: ['warehouse', '供应协同'],
  commitments: ['warehouse', '供货承诺'],
  // 财务
  gl: ['finance', '总账'], finance: ['finance', '财务'], costing: ['finance', '成本核算'],
  costs: ['finance', '成本单'], budget: ['finance', '预算'], bank: ['finance', '银行'],
  tax: ['finance', '税金'], assets: ['finance', '固定资产'], investment: ['finance', '长期投资'],
  group: ['finance', '集团合并'], cockpit: ['finance', '经营驾驶舱'],
  'admin-expenses': ['finance', '行政费用'], 'admin-contracts': ['hr', '行政合同'],
  // 人事
  payrolls: ['hr', '工资'], 'piece-wage': ['hr', '计件'], employees: ['hr', '员工'],
  leaves: ['hr', '请假'], attendance: ['hr', '考勤'], org: ['hr', '组织编制'], hr: ['hr', '人事'],
  // 审批
  approvals: ['flow', '审批中心'], 'approval-flows': ['flow', '审批流配置'], confirm: ['flow', '确认中心']
};

const GROUP_LABEL = {
  sales: '销售', marketing: '营销', tech: '技术', production: '生产',
  warehouse: '仓储', finance: '财务', hr: '人事', flow: '审批', system: '系统', other: '其他'
};

const ACTION_LABEL = {
  login: '登录',
  create: '新建',
  update: '修改',
  delete: '删除',
  approve: '审批',
  flow: '流转',
  export: '导出',
  other: '其他'
};

function domainOf(p) {
  const m = String(p || '').split('?')[0].match(/^\/api\/([a-zA-Z0-9-]+)/);
  const key = m ? m[1].toLowerCase() : 'other';
  const hit = DOMAINS[key];
  return { code: key, label: hit ? hit[1] : '其他', group: hit ? hit[0] : 'other' };
}

const moduleLabelOf = (code) => (DOMAINS[code] ? DOMAINS[code][1] : '其他');
const groupLabelOf = (code) => GROUP_LABEL[code] || '其他';

/** 动作：先看路径特征（业务流转/审批/导出），再看 HTTP 方法 */
function actionOf(method, p) {
  const m = String(method || '').toUpperCase();
  if (/\/(login|logout)$/.test(p)) return 'login';
  if (/(\/export|\/download|\/backup|\/restore)/.test(p)) return 'export';
  if (m === 'DELETE') return 'delete';
  if (/\/(approve|confirm|review|act|settle|sign|verify|post|close|void|publish|activate|submit)\b/.test(p)) return 'approve';
  if (/\/(tech|finance|assign|ship|instock|outstock|transfer|receive|reject|cancel|start|finish|complete)\b/.test(p)) return 'flow';
  if (m === 'POST') return 'create';
  if (m === 'PUT' || m === 'PATCH') return 'update';
  return 'other';
}

/** 对象：/api/orders/123/tech → orders#123；/api/piece-wage/runs/9/confirm → piece-wage#9 */
function targetOf(p) {
  const parts = String(p || '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] !== 'api' || !parts[1]) return null;
  // id 不一定在第三段（/runs/9/confirm），沿路找第一个纯数字段
  const id = parts.slice(2).find((x) => /^\d+$/.test(x));
  return id ? `${parts[1]}#${id}` : parts[1];
}

function classify(method, p) {
  const dom = domainOf(p);
  const action = actionOf(method, p);
  const target = targetOf(p);
  // auth / users 这类「路径首段本身就是模块名」的不重复显示，否则会写成「登录 auth · 登录」
  const showTarget = target && target !== dom.code;
  const act = ACTION_LABEL[action] || action;
  // 「登录 · 登录」也没意义 —— 动作名和模块名相同就只说一次
  const head = dom.label + (showTarget ? ' ' + target : '');
  const summary = act === dom.label ? head : `${head} · ${act}`;
  return {
    module: dom.code,
    module_label: dom.label,
    module_group: dom.group,
    group_label: groupLabelOf(dom.group),
    action,
    target,
    summary
  };
}

// ---------------- 哈希链 ----------------

/** 参与哈希的字段与顺序：回填和实时写入必须完全一致，否则校验必断 */
function chainHash(row, prev) {
  return crypto
    .createHash('sha256')
    .update([prev || GENESIS, row.seq, row.username || '', row.method || '', row.path || '', row.status || 0, row.created_at || ''].join('|'))
    .digest('hex');
}

function chainState() {
  let st = db.prepare('SELECT * FROM audit_chain_state WHERE id = 1').get();
  if (!st) {
    db.prepare(
      'INSERT INTO audit_chain_state (id, last_seq, last_hash, anchor_seq, anchor_hash, updated_at) VALUES (1, 0, ?, 0, ?, ?)'
    ).run(GENESIS, GENESIS, now());
    st = db.prepare('SELECT * FROM audit_chain_state WHERE id = 1').get();
  }
  return st;
}

/**
 * 追加一条（唯一的写入口）
 * 在响应 finish 时调用，任何异常都不能影响响应 —— 调用方必须 try/catch
 */
function append({ username, role, method, path, status, ip, duration }) {
  const t = now();
  const cls = classify(method, path);
  const st = chainState();
  const seq = Number(st.last_seq) + 1;
  const prev = st.last_hash || GENESIS;
  const row = {
    seq,
    username: username || 'anonymous',
    method: String(method || '').toUpperCase(),
    path: String(path || ''),
    status: Number(status) || 0,
    created_at: t
  };
  const hash = chainHash(row, prev);

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO audit_logs
         (username, method, path, status, ip, created_at, seq, prev_hash, hash, module, module_group, action, target, summary, actor_role, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(row.username, row.method, row.path, row.status, ip || '', t, seq, prev, hash,
      cls.module, cls.module_group, cls.action, cls.target, cls.summary, role || null, duration == null ? null : Math.round(duration));
    db.prepare('UPDATE audit_chain_state SET last_seq = ?, last_hash = ?, updated_at = ? WHERE id = 1').run(seq, hash, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { seq, hash };
}

/**
 * 校验链
 * @param {{from?:number,to?:number}} q seq 范围（不传就全校，超过 20 万条自动只查尾部）
 * @returns {{ok:boolean, checked:number, problems:Array, head:object, tail:object, state:object}}
 */
function verify(q = {}) {
  const st = chainState();
  const total = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE seq IS NOT NULL').get().c;
  const problems = [];
  const push = (code, message, seq) => problems.push({ code, message, seq: seq == null ? null : Number(seq) });

  const first = db.prepare('SELECT seq, prev_hash, hash FROM audit_logs WHERE seq IS NOT NULL ORDER BY seq ASC LIMIT 1').get();
  const last = db.prepare('SELECT seq, prev_hash, hash FROM audit_logs WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1').get();

  // ① 头部水位：归档会推进 anchor，所以第一条的 prev_hash 必须等于 anchor_hash
  const anchorSeq = Number(st.anchor_seq) || 0;
  const anchorHash = st.anchor_hash || GENESIS;
  if (first) {
    if (Number(first.seq) !== anchorSeq + 1) {
      push('HEAD_GAP', `头部不连续：最早一条是 #${first.seq}，按归档水位应该从 #${anchorSeq + 1} 开始（中间有日志被删）`, first.seq);
    }
    if (first.prev_hash !== anchorHash) {
      push('HEAD_HASH', `头部哈希对不上归档水位（#${first.seq} 的 prev_hash 与 watermark 不一致）`, first.seq);
    }
  } else if (total === 0 && Number(st.last_seq) > 0) {
    push('EMPTY', `库里有 ${st.last_seq} 条的历史水位，但日志表是空的（全被删了？）`, null);
  }

  // ② 尾部水位：删掉最后几条，链自身依然自洽，只能靠 state 抓
  if (last) {
    if (Number(last.seq) !== Number(st.last_seq)) {
      push('TAIL_SEQ', `尾部缺失：库里最大序号 #${last.seq}，水位记录是 #${st.last_seq}（尾部被删了 ${Number(st.last_seq) - Number(last.seq)} 条）`, last.seq);
    } else if (last.hash !== st.last_hash) {
      push('TAIL_HASH', `尾部哈希与水位不一致（#${last.seq} 被改过，或被替换）`, last.seq);
    }
  }

  // ③ 逐条重算（范围可限）
  const from = q.from ? Number(q.from) : (first ? Number(first.seq) : 1);
  const to = q.to ? Number(q.to) : (last ? Number(last.seq) : 0);
  const CAP = 200000;
  const rows = to >= from
    ? db.prepare('SELECT seq, username, method, path, status, created_at, prev_hash, hash FROM audit_logs WHERE seq BETWEEN ? AND ? ORDER BY seq ASC LIMIT ?').all(from, to, CAP)
    : [];

  let expectSeq = from;
  let expectPrev = null;
  rows.forEach((r, i) => {
    if (Number(r.seq) !== expectSeq && problems.length < 50) {
      push('SEQ_GAP', `序号断档：#${expectSeq} 之后直接是 #${r.seq}（中间缺 ${Number(r.seq) - expectSeq} 条）`, r.seq);
    }
    if (i === 0) expectPrev = r.prev_hash;
    else if (r.prev_hash !== expectPrev && problems.length < 50) {
      push('LINK', `#${r.seq} 的 prev_hash 与上一条的 hash 对不上（链接断开）`, r.seq);
    }
    const calc = chainHash(r, r.prev_hash);
    if (calc !== r.hash && problems.length < 50) {
      push('HASH', `#${r.seq} 内容被改过：重算 hash 与记录不一致`, r.seq);
    }
    expectPrev = r.hash;
    expectSeq = Number(r.seq) + 1;
  });

  return {
    ok: problems.length === 0,
    checked: rows.length,
    total: Number(total),
    problems,
    range: { from, to },
    head: first ? { seq: Number(first.seq), hash: first.hash } : null,
    tail: last ? { seq: Number(last.seq), hash: last.hash } : null,
    state: {
      last_seq: Number(st.last_seq),
      last_hash: st.last_hash,
      anchor_seq: anchorSeq,
      anchor_hash: anchorHash,
      updated_at: st.updated_at
    }
  };
}

// ---------------- 查询 ----------------

function buildWhere(q = {}) {
  const where = [];
  const params = [];
  if (q.from) { where.push('created_at >= ?'); params.push(String(q.from)); }
  if (q.to) { where.push('created_at <= ?'); params.push(String(q.to)); }
  if (q.username) { where.push('username = ?'); params.push(q.username); }
  if (q.module) { where.push('module = ?'); params.push(q.module); }
  if (q.group) { where.push('module_group = ?'); params.push(q.group); }
  if (q.action) { where.push('action = ?'); params.push(q.action); }
  if (q.result === 'ok') where.push('status < 400');
  else if (q.result === 'fail') where.push('status >= 400');
  if (q.status) { where.push('status = ?'); params.push(Number(q.status)); }
  if (q.q) {
    where.push("(IFNULL(summary,'') LIKE ? OR path LIKE ? OR IFNULL(target,'') LIKE ? OR username LIKE ?)");
    const k = `%${q.q}%`;
    params.push(k, k, k, k);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function list(q = {}) {
  const page = Math.max(1, Number(q.page) || 1);
  // 下限给 1 而不是 10：调用方要 3 条就给他 3 条（曾被下限卡成 10 条，误以为是分页坏了）
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 500);
  const w = buildWhere(q);
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${w.sql}`).get(...w.params).c;
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${w.sql} ORDER BY seq DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...w.params, pageSize, (page - 1) * pageSize)
    .map((r) => ({
      ...r,
      role_label: ROLE_LABELS[r.actor_role] || r.actor_role || '',
      module_label: moduleLabelOf(r.module),
      group_label: groupLabelOf(r.module_group),
      action_label: ACTION_LABEL[r.action] || r.action || '—'
    }));
  return { rows, total: Number(total), page, pageSize, pages: Math.ceil(total / pageSize) };
}

/** 筛选项清单（下拉用，只给库里真出现过的值） */
function facets() {
  const users = db.prepare('SELECT username, COUNT(*) c FROM audit_logs GROUP BY username ORDER BY c DESC LIMIT 40').all();
  const domains = db
    .prepare('SELECT module, COUNT(*) c FROM audit_logs WHERE module IS NOT NULL GROUP BY module ORDER BY c DESC')
    .all()
    .map((x) => ({ code: x.module, label: moduleLabelOf(x.module), count: Number(x.c) }));
  const groups = db
    .prepare('SELECT module_group, COUNT(*) c FROM audit_logs WHERE module_group IS NOT NULL GROUP BY module_group ORDER BY c DESC')
    .all()
    .map((x) => ({ code: x.module_group, label: groupLabelOf(x.module_group), count: Number(x.c) }));
  const acts = db
    .prepare('SELECT action, COUNT(*) c FROM audit_logs WHERE action IS NOT NULL GROUP BY action ORDER BY c DESC')
    .all()
    .map((x) => ({ code: x.action, label: ACTION_LABEL[x.action] || x.action, count: Number(x.c) }));
  return { users, modules: domains, groups, actions: acts, groups_label: GROUP_LABEL };
}

function stats({ days = 14 } = {}) {
  const d = Math.min(Math.max(Number(days) || 14, 1), 90);
  const since = new Date(Date.now() - d * 86400000).toISOString();
  const total = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE seq IS NOT NULL').get().c;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE created_at >= ?').get(todayStart.toISOString()).c;
  const fail = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE created_at >= ? AND status >= 400').get(since).c;
  const users = db.prepare('SELECT COUNT(DISTINCT username) c FROM audit_logs WHERE created_at >= ?').get(since).c;
  const byGroup = db
    .prepare('SELECT module_group, COUNT(*) c, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) f FROM audit_logs WHERE created_at >= ? GROUP BY module_group ORDER BY c DESC')
    .all(since)
    .map((x) => ({ code: x.module_group, label: groupLabelOf(x.module_group), count: Number(x.c), fail: Number(x.f) }));
  const byModule = db
    .prepare('SELECT module, COUNT(*) c, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) f FROM audit_logs WHERE created_at >= ? GROUP BY module ORDER BY c DESC LIMIT 12')
    .all(since)
    .map((x) => ({ code: x.module, label: moduleLabelOf(x.module), count: Number(x.c), fail: Number(x.f) }));
  const byAction = db
    .prepare('SELECT action, COUNT(*) c FROM audit_logs WHERE created_at >= ? GROUP BY action ORDER BY c DESC')
    .all(since)
    .map((x) => ({ code: x.action, label: ACTION_LABEL[x.action] || x.action, count: Number(x.c) }));
  const byUser = db
    .prepare('SELECT username, COUNT(*) c, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) f FROM audit_logs WHERE created_at >= ? GROUP BY username ORDER BY c DESC LIMIT 10')
    .all(since)
    .map((x) => ({ username: x.username, count: Number(x.c), fail: Number(x.f) }));
  const trend = db
    .prepare("SELECT substr(created_at, 1, 10) d, COUNT(*) c, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) f FROM audit_logs WHERE created_at >= ? GROUP BY d ORDER BY d")
    .all(since)
    .map((x) => ({ date: x.d, count: Number(x.c), fail: Number(x.f) }));
  const st = chainState();
  return {
    days: d,
    total: Number(total),
    today: Number(today),
    fail: Number(fail),
    users: Number(users),
    by_group: byGroup,
    by_module: byModule,
    by_action: byAction,
    by_user: byUser,
    trend,
    state: { last_seq: Number(st.last_seq), anchor_seq: Number(st.anchor_seq) || 0, updated_at: st.updated_at }
  };
}

// ---------------- 导出 ----------------

const CSV_HEAD = ['时间', '序号', '账号', '岗位', '大类', '模块', '动作', '对象', '结果', '状态码', 'IP', '摘要', '当前哈希'];

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * 导出 CSV（带 BOM）
 * 头部写清「范围 / 条数 / 序号区间」+ 校验结论；响应头里再给哈希，收件人可复核
 */
function exportCsv(q = {}, operator) {
  const w = buildWhere(q);
  const rows = db.prepare(`SELECT * FROM audit_logs ${w.sql} ORDER BY seq ASC`).all(...w.params);
  if (!rows.length) throw bad('这个范围内没有日志可导出');
  const seqs = rows.map((r) => Number(r.seq)).filter((n) => !isNaN(n));
  const fromSeq = seqs.length ? Math.min(...seqs) : 0;
  const toSeq = seqs.length ? Math.max(...seqs) : 0;
  const v = verify({ from: fromSeq, to: toSeq });

  const meta = {
    rows: rows.length,
    from_seq: fromSeq,
    to_seq: toSeq,
    first_hash: rows[0].hash,
    last_hash: rows[rows.length - 1].hash,
    verified: v.ok,
    problems: v.problems.length,
    exported_by: operator || 'system',
    exported_at: now()
  };

  const head = [
    `# 操作日志导出 | 导出人 ${meta.exported_by} | ${meta.exported_at}`,
    `# 范围 ${q.from || (rows[0] && rows[0].created_at) || '全部'} ~ ${q.to || (rows[rows.length - 1] && rows[rows.length - 1].created_at) || '至今'} | 条数 ${meta.rows} | 序号 #${meta.from_seq} ~ #${meta.to_seq}`,
    `# 链校验：${v.ok ? '通过' : '未通过（' + v.problems.length + ' 处问题）'} | 逐条重算 ${v.checked} 条 | 起 ${meta.first_hash} | 止 ${meta.last_hash}`,
    '# 说明：日志只记录「谁在什么时候做了什么」，不记录单据内容；任何一条被改动或删除都会使链断裂',
    ''
  ];
  const body = rows.map((r) =>
    [
      r.created_at, r.seq, r.username, ROLE_LABELS[r.actor_role] || r.actor_role || '', groupLabelOf(r.module_group), moduleLabelOf(r.module),
      ACTION_LABEL[r.action] || r.action || '', r.target || '', r.status < 400 ? '成功' : '失败', r.status, r.ip || '',
      r.summary || '', r.hash
    ].map(esc).join(',')
  );
  const csv = head.join('\n') + '\n' + CSV_HEAD.join(',') + '\n' + body.join('\n') + '\n';
  const buf = Buffer.from('\uFEFF' + csv, 'utf8');
  meta.file_sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { buffer: buf, meta };
}

// ---------------- 归档 ----------------

function archiveDir() {
  const d = pathMod.resolve(__dirname, '../../data/audit-archives');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function nextArchiveNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const prefix = `AUD${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const maxRow = db.prepare('SELECT archive_no FROM audit_archives WHERE archive_no LIKE ? ORDER BY archive_no DESC LIMIT 1').get(prefix + '%');
  let seq = 1;
  if (maxRow) {
    const n = parseInt(String(maxRow.archive_no).slice(prefix.length + 1), 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return prefix + '-' + String(seq).padStart(2, '0');
}

/**
 * 归档：把「保留期之前」的日志落成 JSONL 文件并移出主表
 * 只切「连续前缀」—— 否则剩余行的 seq 会断档，链校验必报
 * @returns {object} 归档记录
 */
function archive({ beforeDays = 90, operator, note } = {}) {
  const days = Math.max(Number(beforeDays) || 90, 1);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // 切割点：第一条「在新期内」的 seq；它之前的全部归档（保证连续）
  const keep = db.prepare('SELECT MIN(seq) s FROM audit_logs WHERE created_at >= ? AND seq IS NOT NULL').get(cutoff).s;
  const bound = keep == null ? Number.MAX_SAFE_INTEGER : Number(keep);
  const rows = db.prepare('SELECT * FROM audit_logs WHERE seq IS NOT NULL AND seq < ? ORDER BY seq ASC').all(bound);
  if (!rows.length) throw bad(`${days} 天内没有更早的日志可归档（切分点 ${cutoff.slice(0, 10)}）`);

  const no = nextArchiveNo();
  const file = pathMod.join(archiveDir(), no + '.jsonl');
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, lines, 'utf8');
  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  const fromSeq = Number(rows[0].seq);
  const toSeq = Number(rows[rows.length - 1].seq);
  const lastHash = rows[rows.length - 1].hash;
  const t = now();

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM audit_logs WHERE seq IS NOT NULL AND seq < ?').run(bound);
    db.prepare(
      `INSERT INTO audit_archives
         (archive_no, from_seq, to_seq, rows, first_hash, last_hash, file, file_sha256, cutoff, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, fromSeq, toSeq, rows.length, rows[0].hash, lastHash, pathMod.basename(file), fileHash, cutoff, note || null, operator || 'system', t);
    // 水位往前推：之后链校验从新 anchor 接续，这样「合法归档」不会被误判成「偷偷删」
    db.prepare('UPDATE audit_chain_state SET anchor_seq = ?, anchor_hash = ?, updated_at = ? WHERE id = 1').run(toSeq, lastHash, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    try { fs.unlinkSync(file); } catch (err) { /* ignore */ }
    throw e;
  }

  return db.prepare('SELECT * FROM audit_archives WHERE archive_no = ?').get(no);
}

function listArchives() {
  return db.prepare('SELECT * FROM audit_archives ORDER BY id DESC LIMIT 50').all();
}

/** 回填历史日志（迁移脚本用）：按 id 顺序补 seq / 链 / 语义 */
function backfill(batch = 2000) {
  const cfg = db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE seq IS NULL").get().c;
  if (!cfg) return { updated: 0, total: chainState().last_seq };
  const rows = db.prepare('SELECT * FROM audit_logs WHERE seq IS NULL ORDER BY id ASC').all();
  const st = chainState();
  let seq = Number(st.last_seq) || 0;
  let prev = st.last_hash || GENESIS;

  const upd = db.prepare(
    `UPDATE audit_logs SET seq = ?, prev_hash = ?, hash = ?, module = ?, module_group = ?, action = ?, target = ?, summary = ? WHERE id = ?`
  );
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    db.exec('BEGIN');
    try {
      slice.forEach((r) => {
        seq += 1;
        const hash = chainHash({ ...r, seq }, prev);
        const cls = classify(r.method, r.path);
        upd.run(seq, prev, hash, cls.module, cls.module_group, cls.action, cls.target, cls.summary, r.id);
        prev = hash;
        n++;
      });
      db.prepare('UPDATE audit_chain_state SET last_seq = ?, last_hash = ?, updated_at = ? WHERE id = 1').run(seq, prev, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { updated: n, total: seq, last_hash: prev };
}

/**
 * 只重算语义（module / module_group / action / target / summary），不动链。
 * 分类规则改了（比如补了新子域）用它刷历史，hash 不受影响 ——
 * 因为 hash 只覆盖 seq/账号/方法/路径/状态/时间，不含这几列。
 */
function backfillSemantics(batch = 2000) {
  const rows = db.prepare('SELECT id, method, path FROM audit_logs').all();
  const upd = db.prepare('UPDATE audit_logs SET module = ?, module_group = ?, action = ?, target = ?, summary = ? WHERE id = ?');
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    db.exec('BEGIN');
    try {
      slice.forEach((r) => {
        const cls = classify(r.method, r.path);
        upd.run(cls.module, cls.module_group, cls.action, cls.target, cls.summary, r.id);
        n++;
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return { updated: n };
}

module.exports = {
  GENESIS,
  ACTION_LABEL,
  GROUP_LABEL,
  DOMAINS,
  moduleLabelOf,
  groupLabelOf,
  classify,
  chainHash,
  append,
  verify,
  list,
  facets,
  stats,
  exportCsv,
  archive,
  listArchives,
  chainState,
  backfill,
  backfillSemantics
};
