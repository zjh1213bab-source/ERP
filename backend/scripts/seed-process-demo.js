/**
 * 流程超时升级 / 代理 / SOP 制度演示数据（可重复执行）
 *
 * 覆盖：
 *  - 审批待办三态：已超时（-22h）/ 临近到期（剩 3h）/ 无主（角色没有在职账号）
 *  - 代理：tech01 休假 → prod01 代理（覆盖 cost，7 天有效）+ 一条已过期
 *  - 升级：一个任务已升级给人事并写原因
 *  - 提醒：一条已发送记录（演示去重后不再重复打扰）
 *  - SOP：生效（岗位签收未齐）/ 生效（全员待签收）/ 待批准 / 已废止（旧制度可追不默认用）
 *
 * 用法：node scripts/seed-process-demo.js [--reset]
 */
const { db, now } = require('../src/db');

const RESET = process.argv.includes('--reset');
const PWD = 'admin123456';
const BASE = process.env.SEED_BASE || 'http://127.0.0.1:3000';

function localNow(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 19).replace('T', ' ');
}
function localDate(d = new Date()) { return localNow(d).slice(0, 10); }
function hoursAgo(h) { return localNow(new Date(Date.now() - h * 3600000)); }
function daysFrom(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
}
/** ISO 字符串（approval_tasks.created_at 惯用 UTC ISO） */
function isoHoursAgo(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

async function req(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) return { s: r.status, j, error: j.message || 'HTTP ' + r.status };
  return { s: r.status, j };
}
const login = async (u, p) => (await req(null, 'POST', '/api/auth/login', { username: u, password: p })).j.data.token;

if (RESET) {
  db.exec('BEGIN');
  try {
    // 只清「演示造出来的」未结实例，保留历史已批记录
    db.prepare("DELETE FROM approval_reminders").run();
    db.prepare("DELETE FROM approval_tasks WHERE instance_id IN (SELECT id FROM approval_instances WHERE status = 'pending')").run();
    db.prepare("DELETE FROM approval_instances WHERE status = 'pending'").run();
    db.prepare('DELETE FROM approval_delegates').run();
    db.prepare('DELETE FROM sop_acks').run();
    db.prepare('DELETE FROM sop_versions').run();
    db.prepare('DELETE FROM sop_documents').run();
    db.exec('COMMIT');
    console.log('已清空演示用的未结审批 / 代理 / SOP');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

(async () => {
/* ---------- 1. 造未结审批（超时 / 临近 / 无主） ---------- */
const flow = db.prepare("SELECT * FROM approval_flows WHERE target_type = 'cost' AND active = 1 ORDER BY id LIMIT 1").get();
// 给默认流程配时限：财务 8 小时、总经理 24 小时；超时升级给 admin
db.prepare('UPDATE approval_flows SET sla_hours = 24, escalate_role = ?, steps = ? WHERE id = ?').run(
  'admin',
  JSON.stringify([
    { role: 'finance', name: '财务审核', sla_hours: 8, escalate_to: 'admin' },
    { role: 'admin', name: '总经理审批', sla_hours: 24, escalate_to: 'admin' }
  ]),
  flow.id
);

const pendCount = db.prepare("SELECT COUNT(*) c FROM approval_instances WHERE status = 'pending'").get().c;
const pendIds = [];
if (!pendCount) {
  const mk = (targetId, ageHours, step1Role, step1Name) => {
    const info = db.prepare(
      "INSERT INTO approval_instances (target_type, target_id, flow_id, current_step, status, created_at) VALUES ('cost',?,?,1,'pending',?)"
    ).run(targetId, flow.id, isoHoursAgo(ageHours));
    const iid = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO approval_tasks (instance_id, step_no, role, step_name, status) VALUES (?,1,?,?,'pending')")
      .run(iid, step1Role, step1Name);
    // 第 2 步也建（未轮到，但保留流程完整）
    db.prepare("INSERT INTO approval_tasks (instance_id, step_no, role, step_name, status) VALUES (?,2,'admin','总经理审批','pending')")
      .run(iid);
    pendIds.push(iid);
    return iid;
  };

  // 订单 5：30 小时前送审，第 1 步财务 8h 时限 → 已超时 22 小时
  const i1 = mk(5, 30, 'finance', '财务审核');
  // 订单 11：21 小时前送审，财务 8h → 也超时（用于升级演示）
  const i2 = mk(11, 21, 'finance', '财务审核');
  // 订单 9：6 小时前送审 → 财务还剩 2 小时（临近到期）
  const i3 = mk(9, 6, 'finance', '财务审核');
  // 订单 1：28 小时前送审，但角色写成 qc（系统没有这个角色）→ 无主，进升级队列
  const i4 = mk(1, 28, 'qc', '质检确认');

  // 把第 2 步按 SLA 补好（用 sla 服务算）
  const { refreshDue } = require('../src/services/sla');
  refreshDue();
  console.log(`已造 ${pendIds.length} 个未结审批：超时 2 / 临近 1 / 无主 1（实例 ${[i1, i2, i3, i4].join(',')}）`);
} else {
  console.log(`已有 ${pendCount} 个未结审批，跳过造数`);
}

/* ---------- 2. 代理授权 ---------- */
const dgCount = db.prepare('SELECT COUNT(*) c FROM approval_delegates').get().c;
if (!dgCount) {
  db.exec('BEGIN');
  try {
    // tech01 休假，成本审批交 prod01（7 天）
    db.prepare(
      `INSERT INTO approval_delegates (from_user, to_user, target_types, valid_from, valid_to, status, reason, created_by, created_at)
       VALUES ('tech01','prod01','cost',?,?, 'active','技术负责人出差 7 天，成本审批暂交生产主管', 'admin', ?)`
    ).run(daysFrom(-3), daysFrom(7), localNow());
    // 一条已过期（演示「有记录但过期不算」）
    db.prepare(
      `INSERT INTO approval_delegates (from_user, to_user, target_types, valid_from, valid_to, status, reason, created_by, created_at)
       VALUES ('fin01','sales01','cost',?,?, 'active','会计年假（已结束）', 'admin', ?)`
    ).run(daysFrom(-20), daysFrom(-10), localNow());
    db.exec('COMMIT');
    console.log('代理：tech01→prod01 生效中；fin01→sales01 已过期');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- 3. 升级一个超时任务 + 发一条提醒 ---------- */
const A = await login('admin', PWD);
const pendTasks = db.prepare(
  `SELECT t.*, i.target_id FROM approval_tasks t JOIN approval_instances i ON i.id = t.instance_id
   WHERE t.status = 'pending' AND i.status = 'pending' AND t.step_no = 1 ORDER BY t.id`
).all();
const t1 = pendTasks[0];
const t2 = pendTasks[1];
if (t1 && !t1.escalated_to) {
  const r = await req(A, 'POST', `/api/process/tasks/${t1.id}/escalate`, {
    escalated_to: 'hr01',
    reason: `财务审核已超时 22 小时，客户催金蝶开票，先交人事协查资料后转回财务`
  });
  console.log('升级：', r.j.ok ? r.j.data.notice : r.error);
}
if (t2 && !t2.remind_count) {
  const r = await req(A, 'POST', `/api/process/tasks/${t2.id}/remind`, {});
  console.log('提醒：', r.j.ok ? r.j.data.message : r.error);
}

/* ---------- 4. SOP / 制度 ---------- */
const sopPlans = [
  {
    title: '车缝工序首件确认 SOP', category: 'sop', position: '车工', owner: '生产主管 赵主管',
    company: '义乌市珂睿服饰',
    doing: '1) 从裁床收扎后先取 1 件做首件；2) 按技术版冻结尺寸表逐部位测量；3) 对照工位工艺卡验关键工艺（针距/线迹/罗纹对位）；4) 拍照留证并在系统登记实测值。',
    inputs: '冻结版技术资料（confirmed 版本）、尺码规格表、工位工艺卡、裁床扎包单、量具（软尺/游标卡尺）',
    done_criteria: '全部尺寸在公差内、关键工艺项无 NG、外观无色差无线头、质检复核放行后才允许批量投产。',
    escalate_path: '资料不全 → 退回总部技术；不可制造 → 退回销售与客户确认；质检不放行 → 升级生产主管，2 小时未响应升级至总经办。',
    change_note: '首版：补充「未放行不许报工」的系统门禁说明'
  },
  {
    title: '面料来料检验 SOP', category: 'sop', position: null, owner: '仓储主管 周仓管',
    company: '义乌市珂睿服饰',
    doing: '1) 到货点收录卷号/缸号/库位；2) 抽样验色差、克重、幅宽、疵点；3) 按合格/冻结/退回分流登记；4) 合格部分才入可用库存。',
    inputs: '采购单、送货单、缸差报告、验布机与克重仪、抽样标准（AQL 2.5）',
    done_criteria: '每卷有缸号与库位、检验结论齐全、冻结与退回写明原因、可用库存只增加合格数量。',
    escalate_path: '超收或短收 → 采购核查原单；色差超标 → 冻结待客户确认，48 小时未回复升级销售；连续两批不合格 → 供应商评价扣分并考虑停单。',
    change_note: '首版：明确「收货不自动可用」'
  },
  {
    title: '客户投诉处理制度', category: 'policy', position: null, owner: '销售负责人 销售小王',
    company: '义乌市珂睿服饰',
    doing: '1) 24 小时内登记客诉（订单号/款号/问题描述/证据）；2) 判定责任归属（生产/来料/运输/客户标准变更）；3) 给出处理方案并留痕；4) 复盘并更新对应 SOP。',
    inputs: '客诉邮件或聊天记录、成品照片、检验记录、出货记录、合同条款',
    done_criteria: '客诉有唯一编号、责任判定有依据、客户确认处理方案、复盘结论已写入对应 SOP 或制度。',
    escalate_path: '涉及索赔金额 > 1 万元 → 升级总经办；判定为我方责任 → 同步供应商评价或返工报废流程；客户要求退货 → 走退货与贷项流程。',
    change_note: '首版'
  }
];

for (const p of sopPlans) {
  const exist = db.prepare('SELECT * FROM sop_documents WHERE title = ?').get(p.title);
  if (exist) continue;
  let r = await req(A, 'POST', '/api/process/sop', { title: p.title, category: p.category, position: p.position, owner: p.owner, company: p.company });
  if (!r.j.ok) { console.log('建制度失败', p.title, r.error); continue; }
  const id = r.j.data.id;
  r = await req(A, 'POST', `/api/process/sop/${id}/versions`, {
    doing: p.doing, inputs: p.inputs, done_criteria: p.done_criteria, escalate_path: p.escalate_path, change_note: p.change_note
  });
  if (!r.j.ok) { console.log('加版本失败', p.title, r.error); continue; }
  const ver = r.j.data.version;
  if (p.title === '客户投诉处理制度') {
    console.log(`SOP：${p.title} 停在 V${ver} 待批准（演示「未批准不生效」）`);
    continue;
  }
  r = await req(A, 'POST', `/api/process/sop/${id}/publish`, { version: ver, effective_date: localDate() });
  if (!r.j.ok) { console.log('发布失败', p.title, r.error); continue; }
  console.log(`SOP：${p.title} V${ver} 已生效，签收待办 ${r.j.data.ack_targets} 份`);
}

// 车缝 SOP 部分签收（演示「待补签」）
const sew = db.prepare("SELECT * FROM sop_documents WHERE title = '车缝工序首件确认 SOP'").get();
if (sew && sew.status === 'effective') {
  const pending = db.prepare('SELECT * FROM sop_acks WHERE doc_id = ? AND version = ? AND acked_at IS NULL ORDER BY id').all(sew.id, sew.current_version);
  const done = db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ? AND acked_at IS NOT NULL').get(sew.id, sew.current_version).c;
  if (!done && pending.length >= 2) {
    // 前两人已签收
    const tNow = localNow();
    pending.slice(0, 2).forEach((a) => {
      db.prepare('UPDATE sop_acks SET acked_at = ?, note = ? WHERE id = ?').run(tNow, '已读完并在工位确认', a.id);
    });
    console.log(`SOP 签收：车缝 SOP 已签 ${2} 人，剩 ${pending.length - 2} 人待补签`);
  }
}

// 一份已废止的旧制度（演示「旧制度可追但不默认用」）
const oldDoc = db.prepare('SELECT * FROM sop_documents WHERE title = ?').get('样品管理办法（2024 版，已废止）');
if (!oldDoc) {
  const r1 = await req(A, 'POST', '/api/process/sop', {
    title: '样品管理办法（2024 版，已废止）', category: 'policy', position: null, owner: '总经办'
  });
  if (r1.j.ok) {
    const id = r1.j.data.id;
    const r2 = await req(A, 'POST', `/api/process/sop/${id}/versions`, {
      doing: '样品登记在 Excel 台账，由业务助理每周更新。',
      inputs: '打样单、客户确认邮件',
      done_criteria: '样品寄出并在台账登记',
      escalate_path: '客户 7 天未回复 → 业务主管催办',
      change_note: '2024 版'
    });
    if (r2.j.ok) {
      await req(A, 'POST', `/api/process/sop/${id}/publish`, { version: 1, effective_date: daysFrom(-400) });
      const r3 = await req(A, 'POST', `/api/process/sop/${id}/retire`, { reason: '已被「打版流程与样衣归档」替代：纸质台账改为系统样衣版本管理与客户在线确认' });
      console.log('SOP：旧《样品管理办法》已废止（可查但不作为现行做法）', r3.j.ok ? '' : r3.error);
    }
  }
}

/* ---------- 5. 汇总 ---------- */
const board = (await req(A, 'GET', '/api/process/board')).j.data;
console.log('\n=== 流程与制度看板 ===');
console.log('stat', JSON.stringify(board.stat));
console.log('升级/超时队列：');
board.queue.slice(0, 8).forEach((t) => {
  console.log(`  #${t.id} ${t.target_label || ''} ${t.step_name} | 截止 ${t.due_at} | ${t.hours_left === null ? '-' : t.hours_left < 0 ? '超时 ' + Math.abs(t.hours_left) + 'h' : '剩 ' + t.hours_left + 'h'} | 主责 ${t.owner.who || '（无）'} ${t.owner.note}`);
});
console.log('代理：', board.delegates.map((d) => `${d.from_user}→${d.to_user}(${d.status_label})`).join(' | '));
const sop = (await req(A, 'GET', '/api/process/sop')).j.data.rows;
console.log('制度：');
sop.forEach((d) => console.log(`  ${d.doc_no} ${d.title} ${d.status_label} V${d.current_version} 签收 ${d.ack_done}/${d.ack_total}`));
console.log('\n完成。打开「人事行政 → 流程与制度」或「审批 → 超时升级」查看。');
process.exit(0);
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
