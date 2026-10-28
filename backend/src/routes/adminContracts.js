/**
 * 行政合同与履约日历 + 印章独立授权（原型 TS-N14-06 / TS-N14-05 剩余部分）
 *
 * 核心口径（写死，不靠人记）：
 * 1. **不同公司印章独立授权**：用印/借章必须命中 seal_grants 的有效授权，admin 例外
 * 2. **用印绑定最终文件版本**：申请时记录 contract_id + doc_hash（合同当前版本的内容指纹）；
 *    合同出新版本 → 未用印的申请自动置 recheck_required=1，**不能直接登记用印**
 * 3. **用印完成留回执**，归还单独登记；借章要写预计归还日，逾期进日历
 * 4. 合同到期前按 `renewal_notice_days` 生成「续约通知」任务；付款/验收/押金返还按条款生成任务
 * 5. **提醒不自动改状态、不自动扣款、不自动续约**：里程碑只标逾期，续签/终止必须人工+写依据
 * 6. 续签必须写依据；终止必须写原因；归档保留不删除
 * 7. 敏感档案（access_level=controlled）查看要写访问日志
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const privacy = require('../services/privacy');
const { reqCtx } = require('../utils/reqCtx');

const router = express.Router();
const READ = ['admin', 'boss', 'sales', 'tech', 'finance', 'production', 'warehouse', 'hr'];
const WRITE = ['admin', 'hr'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const EPS = 0.005;

function localDate(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}
function nextNo(table, col, prefix) {
  let seq = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c) + 1;
  let no = genNo(prefix, seq);
  while (db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${col} = ?`).get(no)) no = genNo(prefix, ++seq);
  return no;
}

const CONTRACT_TYPE = { lease: '租赁', property: '物业', canteen: '食堂', insurance: '保险', service: '服务采购', other: '其他' };
const CONTRACT_STATUS = { draft: '草稿', active: '履约中', renewed: '已续签', terminated: '已终止', archived: '已归档' };
const MS_TYPE = { payment: '付款', acceptance: '服务验收', renewal_notice: '续约通知', deposit_return: '押金返还', other: '其他' };
const MS_STATUS = { pending: '待办', done: '已完成', overdue: '已逾期', waived: '已豁免' };
const GRANT_SCOPE = { use: '用印', borrow: '借章', all: '用印+借章' };
const USAGE_KIND = { use: '用印', borrow: '借章' };
const USAGE_STATUS = { pending: '待批', approved: '已批待用', used: '已用印', borrowed: '已借出', returned: '已归还', rejected: '已驳回' };

/** 当前登录人（回库取姓名与岗位，token 里没有） */
function actor(req) {
  const u = db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  return {
    id: u.id || req.user.sub,
    username: u.username || req.user.username,
    name: u.name || req.user.username,
    role: u.role || req.user.role
  };
}

/**
 * 印章授权校验：按「公司 + 印章 + 人/岗位/角色 + 范围 + 有效期」命中
 * admin 例外（系统管理员），其余一律要有 explicitly 授权
 */
function grantCheck(seal, user, scope) {
  if (user.role === 'admin') return { ok: true, via: 'admin', note: '系统管理员例外' };
  const rows = db.prepare(
    "SELECT * FROM seal_grants WHERE seal_id = ? AND status = 'active' AND scope IN (?, 'all')"
  ).all(seal.id, scope);
  const t = localDate();
  const live = rows.filter((r) => (!r.valid_from || r.valid_from <= t) && (!r.valid_to || r.valid_to >= t));
  const hit = live.find((r) =>
    (r.grantee_type === 'person' && (r.grantee === user.username || r.grantee === user.name)) ||
    (r.grantee_type === 'role' && r.grantee === user.role) ||
    (r.grantee_type === 'position' && r.grantee === user.name));
  if (!hit) {
    const who = rows.length ? '有授权记录但已过期' : '从未授权';
    return {
      ok: false,
      reason: `「${seal.company || '该公司'}」的「${seal.name}」没有${GRANT_SCOPE[scope] || scope}授权给你（${user.username}，${who}）。不同公司的印章独立授权，请先由行政主管授权`
    };
  }
  return { ok: true, via: hit };
}

function logAccess(req, docType, docId, docName, accessLevel, action, allowed, reason) {
  const u = actor(req);
  db.prepare(
    `INSERT INTO doc_access_logs (doc_type, doc_id, doc_name, access_level, action, allowed, operator, operator_role, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(docType, docId || null, docName || null, accessLevel || 'public', action, allowed ? 1 : 0,
    u.username, u.role, reason || null, now());
}

function msView(m) {
  const t = localDate();
  const days = daysBetween(t, m.due_date);
  const overdue = m.status === 'pending' && days !== null && days < 0;
  return {
    ...m,
    type_label: MS_TYPE[m.type] || m.type,
    status_label: overdue ? '已逾期' : (MS_STATUS[m.status] || m.status),
    effective_status: overdue ? 'overdue' : m.status,
    days_left: days,
    amount: m.amount === null || m.amount === undefined ? null : round2(m.amount)
  };
}

function contractView(c) {
  const t = localDate();
  const ms = db.prepare('SELECT * FROM admin_contract_milestones WHERE contract_id = ? ORDER BY due_date, id').all(c.id).map(msView);
  const openMs = ms.filter((m) => m.effective_status === 'pending' || m.effective_status === 'overdue');
  const versions = db.prepare('SELECT * FROM admin_contract_versions WHERE contract_id = ? ORDER BY version DESC').all(c.id);
  const usages = db.prepare(
    `SELECT u.*, s.name AS seal_name FROM seal_usages u LEFT JOIN seals s ON s.id = u.seal_id
     WHERE u.contract_id = ? ORDER BY u.id DESC`
  ).all(c.id).map((u) => ({ ...u, kind_label: USAGE_KIND[u.kind] || u.kind, status_label: USAGE_STATUS[u.status] || u.status }));
  const daysToEnd = daysBetween(t, c.end_date);
  const noticeDate = c.end_date ? addDays(c.end_date, -Number(c.renewal_notice_days || 30)) : null;
  return {
    ...c,
    type_label: CONTRACT_TYPE[c.type] || c.type,
    status_label: CONTRACT_STATUS[c.status] || c.status,
    amount: round2(c.amount),
    deposit: round2(c.deposit),
    days_to_end: daysToEnd,
    notice_date: noticeDate,
    expiring: c.status === 'active' && daysToEnd !== null ? (daysToEnd < 0 ? 'expired' : daysToEnd <= 30 ? '30' : daysToEnd <= 90 ? '90' : null) : null,
    current_doc_hash: versions.length ? versions[0].doc_hash : null,
    versions,
    milestones: ms,
    open_milestones: openMs.length,
    next_milestone: openMs[0] || null,
    seal_usages: usages,
    sealed: usages.some((u) => u.status === 'used' || u.status === 'returned'),
    can_edit: c.status !== 'archived',
    can_seal: !!c.seal_id && c.status === 'active'
  };
}

function full(id) {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(id);
  if (!c) return null;
  return contractView(c);
}

/** 合同建单时按条款自动铺里程碑（只是任务，不产生钱） */
function autoMilestones(contractId, body, startDate, endDate, noticeDays) {
  const t = now();
  const ins = db.prepare(
    `INSERT INTO admin_contract_milestones (contract_id, type, title, due_date, amount, status, note, created_at, updated_at)
     VALUES (?,?,?,?,?, 'pending', ?, ?, ?)`
  );
  let n = 0;
  // 续约通知：到期前 N 天
  if (endDate) {
    const notice = addDays(endDate, -Number(noticeDays || 30));
    ins.run(contractId, 'renewal_notice', `续约通知（到期前 ${noticeDays || 30} 天）`, notice, null, '提醒不自动续约，须人工决定', t, t);
    n++;
  }
  // 押金返还
  if (Number(body.deposit) > 0 && body.deposit_return_date) {
    ins.run(contractId, 'deposit_return', `押金返还 ${round2(body.deposit)}`, body.deposit_return_date, Number(body.deposit), '押金不自动从账上冲回，须验收后人工确认', t, t);
    n++;
  }
  // 付款计划
  (Array.isArray(body.payments) ? body.payments : []).forEach((p) => {
    if (!p || !p.due_date) return;
    ins.run(contractId, 'payment', p.title || `付款 ${round2(p.amount)}`, p.due_date, Number(p.amount) || 0, p.note || null, t, t);
    n++;
  });
  // 服务验收
  (Array.isArray(body.acceptances) ? body.acceptances : []).forEach((a) => {
    if (!a || !a.due_date) return;
    ins.run(contractId, 'acceptance', a.title || '服务验收', a.due_date, null, a.note || null, t, t);
    n++;
  });
  // 期限本身也进日历（到期任务）
  if (endDate) {
    ins.run(contractId, 'other', '合同到期日', endDate, null, '到期不等于自动终止，须人工续签或终止', t, t);
    n++;
  }
  void startDate;
  return n;
}

// ============================================================
// 一、总览
// ============================================================
router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const t = localDate();
  const contracts = db.prepare('SELECT * FROM admin_contracts ORDER BY (end_date IS NULL), end_date').all().map(contractView);
  const active = contracts.filter((c) => c.status === 'active');
  const expiring30 = active.filter((c) => c.days_to_end !== null && c.days_to_end >= 0 && c.days_to_end <= 30);
  const overdueContracts = active.filter((c) => c.days_to_end !== null && c.days_to_end < 0);

  const allMs = db.prepare('SELECT * FROM admin_contract_milestones ORDER BY due_date').all().map(msView)
    .filter((m) => ['pending', 'overdue'].includes(m.effective_status));
  const msOverdue = allMs.filter((m) => m.effective_status === 'overdue');

  const seals = db.prepare('SELECT * FROM seals ORDER BY company, id').all();
  const grants = db.prepare("SELECT * FROM seal_grants WHERE status = 'active'").all();
  const unsealed = seals.filter((s) => s.status === 'active' && !grants.some((g) => g.seal_id === s.id));

  const certs = db.prepare("SELECT * FROM certificates WHERE status = 'valid'").all().map((c) => {
    const d = daysBetween(t, c.expire_date);
    return { ...c, days_left: d, expiring: d === null ? null : d < 0 ? 'expired' : d <= 30 ? '30' : d <= 90 ? '90' : null };
  });

  const borrowOpen = db.prepare(
    "SELECT u.*, s.name AS seal_name, s.company AS seal_company FROM seal_usages u LEFT JOIN seals s ON s.id = u.seal_id WHERE u.kind = 'borrow' AND u.status = 'borrowed'"
  ).all().map((u) => {
    const d = daysBetween(t, u.expect_return_date);
    return { ...u, days_left: d, overdue: d !== null && d < 0 };
  });

  const pendingSeal = db.prepare("SELECT COUNT(*) c FROM seal_usages WHERE status IN ('pending','approved')").get().c;
  const recheckSeal = db.prepare("SELECT COUNT(*) c FROM seal_usages WHERE recheck_required = 1 AND status IN ('pending','approved')").get().c;

  return ok(res, {
    contracts,
    stat: {
      contracts: contracts.length,
      active: active.length,
      expiring30: expiring30.length,
      overdue_contracts: overdueContracts.length,
      milestones_open: allMs.length,
      milestones_overdue: msOverdue.length,
      seals: seals.length,
      seals_ungranted: unsealed.length,
      certs: certs.length,
      certs_expiring30: certs.filter((c) => c.expiring === '30' || c.expiring === 'expired').length,
      seal_pending: pendingSeal,
      seal_recheck: recheckSeal,
      borrow_open: borrowOpen.length,
      borrow_overdue: borrowOpen.filter((b) => b.overdue).length
    },
    alerts: [
      ...expiring30.map((c) => ({ kind: 'contract', level: 'warn', label: `合同「${c.name}」${c.days_to_end} 天后到期`, to: '/admin-contracts' })),
      ...overdueContracts.map((c) => ({ kind: 'contract', level: 'risk', label: `合同「${c.name}」已过期 ${Math.abs(c.days_to_end)} 天未续签/终止`, to: '/admin-contracts' })),
      ...msOverdue.slice(0, 6).map((m) => ({ kind: 'milestone', level: 'warn', label: `${MS_TYPE[m.type] || ''}「${m.title}」逾期 ${Math.abs(m.days_left)} 天`, to: '/admin-contracts' })),
      ...certs.filter((c) => c.expiring === 'expired').map((c) => ({ kind: 'cert', level: 'risk', label: `证照「${c.name}」已过期（${c.expire_date}）`, to: '/admin-contracts' })),
      ...borrowOpen.filter((b) => b.overdue).map((b) => ({ kind: 'seal', level: 'risk', label: `「${b.seal_name}」借出未还，已逾期 ${Math.abs(b.days_left)} 天`, to: '/admin-contracts' })),
      ...(recheckSeal ? [{ kind: 'seal', level: 'warn', label: `${recheckSeal} 张用印申请因文件版本变化需重核`, to: '/admin-contracts' }] : [])
    ],
    dict: {
      type: CONTRACT_TYPE, status: CONTRACT_STATUS, ms_type: MS_TYPE, ms_status: MS_STATUS,
      grant_scope: GRANT_SCOPE, usage_kind: USAGE_KIND, usage_status: USAGE_STATUS
    },
    note: '到期/付款/验收/押金返还只生成任务并进日历，提醒不自动改状态、不自动扣款、不自动续约'
  });
}));

// ============================================================
// 二、行政合同台账（TS-N14-06）
// ============================================================
router.get('/contracts', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status, type, q, expiring } = req.query;
  const cond = [];
  const params = [];
  if (status) { cond.push('status = ?'); params.push(status); }
  if (type) { cond.push('type = ?'); params.push(type); }
  if (q) { cond.push('(name LIKE ? OR contract_no LIKE ? OR counterparty LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  let rows = db.prepare(
    `SELECT * FROM admin_contracts ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY (end_date IS NULL), end_date, id DESC`
  ).all(...params).map(contractView);
  if (expiring === '30') rows = rows.filter((r) => r.expiring === '30' || r.expiring === 'expired');
  if (expiring === '90') rows = rows.filter((r) => ['30', '90', 'expired'].includes(r.expiring));
  // 合同金额按 contract.sensitive 脱敏（财务与老板可看明文）
  return ok(res, { rows: privacy.maskRows('admin_contracts', rows, reqCtx(req, { action: 'list' })), dict: { type: CONTRACT_TYPE, status: CONTRACT_STATUS, ms_type: MS_TYPE } });
}));

router.get('/contracts/:id', authRequired, requireRole(READ), wrap(async (req, res) => {
  const c = full(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  return ok(res, c);
}));

router.post('/contracts', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return fail(res, 400, '请填合同名称');
  if (!String(b.counterparty || '').trim()) return fail(res, 400, '请填对手方（合同和谁签的）');
  if (!CONTRACT_TYPE[b.type]) return fail(res, 400, `合同类型应为 ${Object.keys(CONTRACT_TYPE).join(' / ')}`);
  if (!b.start_date || !b.end_date) return fail(res, 400, '起止日期必填（没有期限就没法进履约日历）');
  if (b.end_date < b.start_date) return fail(res, 400, '到期日不能早于起始日');
  if (!String(b.owner || '').trim()) return fail(res, 400, '请填合同责任人（到期找谁）');
  const amt = Number(b.amount) || 0;
  if (amt < 0) return fail(res, 400, '合同金额不能是负数');
  if (Number(b.deposit) > 0 && !b.deposit_return_date) return fail(res, 400, '填了押金就必须写押金应返还日（否则押金没人跟）');

  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO admin_contracts (contract_no, name, type, company, counterparty, owner, amount, currency,
         deposit, deposit_return_date, sign_date, start_date, end_date, renewal_notice_days, current_version,
         seal_id, status, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?, 'active', ?,?,?,?)`
    ).run(nextNo('admin_contracts', 'contract_no', 'XZ'), String(b.name).trim(), b.type,
      b.company || null, String(b.counterparty).trim(), String(b.owner).trim(),
      round2(amt), b.currency || 'CNY', round2(b.deposit) || 0, b.deposit_return_date || null,
      b.sign_date || null, b.start_date, b.end_date, Number(b.renewal_notice_days) || 30,
      b.seal_id || null, b.remark || null, actor(req).username, t, t);
    id = Number(info.lastInsertRowid);
    // 首版文件
    db.prepare(
      `INSERT INTO admin_contract_versions (contract_id, version, doc_name, doc_hash, attachment, change_note, changed_by, changed_at)
       VALUES (?,1,?,?,?, '初始版本', ?, ?)`
    ).run(id, b.doc_name || `${b.name}.pdf`, b.doc_hash || null, b.attachment || null, actor(req).username, t);
    const n = autoMilestones(id, b, b.start_date, b.end_date, b.renewal_notice_days);
    db.exec('COMMIT');
    return ok(res, { ...full(id), notice: `已建合同并铺 ${n} 条履约任务（只提醒，不自动付款/续约）` });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.put('/contracts/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  if (c.status === 'archived') return fail(res, 400, '已归档合同不能改；要改请先取消归档');
  const b = req.body || {};
  if (b.end_date && b.start_date && b.end_date < b.start_date) return fail(res, 400, '到期日不能早于起始日');
  db.prepare(
    `UPDATE admin_contracts SET name=?, type=?, company=?, counterparty=?, owner=?, amount=?, currency=?,
       deposit=?, deposit_return_date=?, sign_date=?, start_date=?, end_date=?, renewal_notice_days=?,
       seal_id=?, remark=?, updated_at=? WHERE id=?`
  ).run(
    b.name !== undefined ? b.name : c.name, b.type || c.type,
    b.company !== undefined ? b.company : c.company,
    b.counterparty !== undefined ? b.counterparty : c.counterparty,
    b.owner !== undefined ? b.owner : c.owner,
    b.amount !== undefined ? round2(b.amount) : c.amount,
    b.currency || c.currency,
    b.deposit !== undefined ? round2(b.deposit) : c.deposit,
    b.deposit_return_date !== undefined ? b.deposit_return_date : c.deposit_return_date,
    b.sign_date !== undefined ? b.sign_date : c.sign_date,
    b.start_date || c.start_date, b.end_date || c.end_date,
    b.renewal_notice_days !== undefined ? Number(b.renewal_notice_days) : c.renewal_notice_days,
    b.seal_id !== undefined ? b.seal_id : c.seal_id,
    b.remark !== undefined ? b.remark : c.remark, now(), c.id);
  return ok(res, full(c.id));
}));

/** 合同出新版本（改正文）→ 未用印的申请全部标记需重核 */
router.post('/contracts/:id/versions', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  if (c.status === 'archived') return fail(res, 400, '已归档合同不能再出文件版本');
  const b = req.body || {};
  const note = String(b.change_note || '').trim();
  if (!note) return fail(res, 400, '改正文必须写变更说明（后续重核用印要看）');
  if (!b.doc_hash && !b.attachment && !b.doc_name) return fail(res, 400, '请填文件名称或内容指纹，否则无法判断是不是「最终版本」');

  const t = now();
  const ver = Number(c.current_version) + 1;
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO admin_contract_versions (contract_id, version, doc_name, doc_hash, attachment, change_note, changed_by, changed_at, seal_recheck_required)
       VALUES (?,?,?,?,?,?,?,?, 1)`
    ).run(c.id, ver, b.doc_name || null, b.doc_hash || null, b.attachment || null, note, actor(req).username, t);
    db.prepare('UPDATE admin_contracts SET current_version = ?, updated_at = ? WHERE id = ?').run(ver, t, c.id);
    // 未用印的申请重核：文件变了，章不能就这么盖
    const affected = db.prepare(
      "SELECT id, usage_no FROM seal_usages WHERE contract_id = ? AND status IN ('pending','approved')"
    ).all(c.id);
    affected.forEach((u) => {
      db.prepare("UPDATE seal_usages SET recheck_required = 1, recheck_reason = ?, doc_hash = NULL, updated_at = ? WHERE id = ?")
        .run(`合同正文已更新到 V${ver}（${note}），需按最终版本重新提交审批`, t, u.id);
    });
    db.exec('COMMIT');
    return ok(res, {
      version: ver,
      recheck: affected.length,
      notice: affected.length
        ? `已出 V${ver}；${affected.length} 张未用印申请已被标记「需重核」（${affected.map((x) => x.usage_no).join('、')}）`
        : `已出 V${ver}`
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** 续签：必须写依据；旧合同转 renewed，期限顺延（也可指向已新建合同） */
router.post('/contracts/:id/renew', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  if (['archived', 'terminated'].includes(c.status)) return fail(res, 400, `合同是「${CONTRACT_STATUS[c.status]}」，不能续签`);
  if (c.status === 'renewed') return fail(res, 400, '这份合同已经续签过了');
  const b = req.body || {};
  const basis = String(b.renewal_basis || '').trim();
  if (!basis) return fail(res, 400, '续签必须写依据（履约评价 / 价格谈判 / 服务验收结果）');
  if (!b.end_date) return fail(res, 400, '续签必须填新的到期日');
  if (b.end_date <= c.end_date) return fail(res, 400, `新到期日 ${b.end_date} 必须晚于原到期日 ${c.end_date}`);
  const t = now();

  db.prepare(
    "UPDATE admin_contracts SET status = 'renewed', renewal_basis = ?, end_date = ?, updated_at = ? WHERE id = ?"
  ).run(basis, b.end_date, t, c.id);
  // 续签后旧的续约通知任务作废，按新到期日重排
  db.prepare("DELETE FROM admin_contract_milestones WHERE contract_id = ? AND type = 'renewal_notice' AND status = 'pending'").run(c.id);
  db.prepare(
    `INSERT INTO admin_contract_milestones (contract_id, type, title, due_date, status, note, created_at, updated_at)
     VALUES (?, 'renewal_notice', ?, ?, 'pending', ?, ?, ?)`
  ).run(c.id, `续约通知（续签后重排）`, addDays(b.end_date, -Number(c.renewal_notice_days || 30)),
    `依据：${basis}`, t, t);
  // 转回履约中（续签完成即可继续履约）
  db.prepare("UPDATE admin_contracts SET status = 'active' WHERE id = ?").run(c.id);
  return ok(res, { ...full(c.id), notice: `已续签至 ${b.end_date}，依据已留档` });
}));

/** 终止：必须写原因 */
router.post('/contracts/:id/terminate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  if (c.status === 'terminated') return fail(res, 400, '已经终止过了');
  if (c.status === 'archived') return fail(res, 400, '已归档合同不能再终止');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '终止合同必须写原因');
  const t = now();
  db.prepare("UPDATE admin_contracts SET status = 'terminated', terminated_reason = ?, terminated_by = ?, terminated_at = ?, updated_at = ? WHERE id = ?")
    .run(reason, actor(req).username, t, t, c.id);
  // 终止后未完成的付款/验收任务不再追，但押金返还要留着
  // 终止后：付款/验收/续约/到期提醒都转豁免（押金返还仍保留，钱要退）
  db.prepare("UPDATE admin_contract_milestones SET status = 'waived', note = COALESCE(note || ' | ', '') || ?, updated_at = ? WHERE contract_id = ? AND status = 'pending' AND type IN ('payment','acceptance','renewal_notice','other')")
    .run(`合同已终止：${reason}`, t, c.id);
  return ok(res, { ...full(c.id), notice: '已终止；付款/验收/续约任务转豁免，押金返还仍保留跟踪' });
}));

router.post('/contracts/:id/archive', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  const t = now();
  const back = (req.body || {}).undo === true;
  db.prepare("UPDATE admin_contracts SET status = ?, archived_at = ?, archive_note = COALESCE(?, archive_note), updated_at = ? WHERE id = ?")
    .run(back ? 'active' : 'archived', back ? null : t, (req.body || {}).note || null, t, c.id);
  return ok(res, { ...full(c.id), notice: back ? '已取消归档' : '已归档（保留不删除，可追溯）' });
}));

// ============================================================
// 三、履约里程碑与日历
// ============================================================
router.post('/contracts/:id/milestones', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '合同不存在');
  const b = req.body || {};
  if (!MS_TYPE[b.type]) return fail(res, 400, `任务类型应为 ${Object.keys(MS_TYPE).join(' / ')}`);
  if (!b.due_date) return fail(res, 400, '请填到期日');
  if (!String(b.title || '').trim()) return fail(res, 400, '请填任务标题');
  const t = now();
  const info = db.prepare(
    `INSERT INTO admin_contract_milestones (contract_id, type, title, due_date, amount, status, note, created_at, updated_at)
     VALUES (?,?,?,?,?, 'pending', ?, ?, ?)`
  ).run(c.id, b.type, String(b.title).trim(), b.due_date,
    b.amount === undefined || b.amount === null ? null : round2(b.amount), b.note || null, t, t);
  return ok(res, { id: Number(info.lastInsertRowid), contract: full(c.id) });
}));

/** 完成任务：必须有证据（付款要有凭证号，验收要有结论） */
router.post('/milestones/:id/done', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const m = db.prepare('SELECT * FROM admin_contract_milestones WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '任务不存在');
  if (m.status === 'done') return fail(res, 400, '这个任务已经完成了');
  if (m.status === 'waived') return fail(res, 400, '任务已豁免，不用再完成');
  const evidence = String((req.body || {}).evidence || '').trim();
  if (!evidence) return fail(res, 400, '完成任务必须写证据（付款凭证号 / 验收结论 / 押金到账凭证）');
  const t = now();
  db.prepare("UPDATE admin_contract_milestones SET status = 'done', done_at = ?, done_by = ?, evidence = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?")
    .run(t, actor(req).username, evidence, (req.body || {}).note || null, t, m.id);
  return ok(res, { id: m.id, contract: full(m.contract_id), notice: '已完成。提醒类任务完成只留痕，不会自动产生付款单据' });
}));

router.post('/milestones/:id/waive', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const m = db.prepare('SELECT * FROM admin_contract_milestones WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '任务不存在');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '豁免必须写原因');
  if (m.type === 'deposit_return') return fail(res, 400, '押金返还任务不能豁免：押金必须实际退回或转抵扣并留凭证');
  const t = now();
  db.prepare("UPDATE admin_contract_milestones SET status = 'waived', note = COALESCE(note || ' | ', '') || ?, updated_at = ? WHERE id = ?")
    .run(`豁免：${reason}`, t, m.id);
  return ok(res, { id: m.id, contract: full(m.contract_id) });
}));

/** 统一履约日历：合同任务 + 证照到期 + 借章逾期 */
router.get('/calendar', authRequired, requireRole(READ), wrap(async (req, res) => {
  const from = req.query.from || localDate();
  const to = req.query.to || addDays(localDate(), 90);
  const t = localDate();

  const ms = db.prepare(
    "SELECT * FROM admin_contract_milestones WHERE status IN ('pending','overdue') AND due_date <= ? ORDER BY due_date"
  ).all(to).map((m) => {
    const c = db.prepare('SELECT id, name, contract_no, counterparty FROM admin_contracts WHERE id = ?').get(m.contract_id);
    return { ...msView(m), source: 'milestone', contract: c || null };
  });

  const certs = db.prepare("SELECT * FROM certificates WHERE status = 'valid' AND expire_date IS NOT NULL AND expire_date <= ? ORDER BY expire_date")
    .all(to).map((c) => ({
      source: 'certificate', id: c.id, type: c.type, title: `${c.name}到期（${c.company || ''}）`,
      due_date: c.expire_date, days_left: daysBetween(t, c.expire_date),
      effective_status: daysBetween(t, c.expire_date) < 0 ? 'overdue' : 'pending',
      note: `保管：${c.holder || '-'}`
    }));

  const borrows = db.prepare(
    "SELECT u.*, s.name AS seal_name, s.company AS seal_company FROM seal_usages u LEFT JOIN seals s ON s.id = u.seal_id WHERE u.kind = 'borrow' AND u.status = 'borrowed' AND u.expect_return_date <= ? ORDER BY u.expect_return_date"
  ).all(to).map((u) => ({
    source: 'seal_borrow', id: u.id, title: `「${u.seal_name}」借出归还（${u.applicant}）`,
    due_date: u.expect_return_date, days_left: daysBetween(t, u.expect_return_date),
    effective_status: daysBetween(t, u.expect_return_date) < 0 ? 'overdue' : 'pending',
    note: `用途：${u.purpose}`
  }));

  const items = [...ms, ...certs, ...borrows]
    .filter((x) => x.due_date >= from || x.effective_status === 'overdue')
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

  return ok(res, {
    from, to, items,
    stat: {
      total: items.length,
      overdue: items.filter((x) => x.effective_status === 'overdue').length,
      this_week: items.filter((x) => x.days_left !== null && x.days_left >= 0 && x.days_left <= 7).length,
      payment: ms.filter((m) => m.type === 'payment').length,
      deposit: ms.filter((m) => m.type === 'deposit_return').length
    },
    note: '日历只提醒，不会自动改合同状态或自动付款续约'
  });
}));

// ============================================================
// 四、印章独立授权（TS-N14-05）
// ============================================================
router.get('/seal-grants', authRequired, requireRole(READ), wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.seal_id) { cond.push('g.seal_id = ?'); params.push(Number(req.query.seal_id)); }
  if (req.query.company) { cond.push('g.company = ?'); params.push(req.query.company); }
  if (req.query.status) { cond.push('g.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT g.*, s.name AS seal_name, s.company AS seal_company, s.status AS seal_status
     FROM seal_grants g LEFT JOIN seals s ON s.id = g.seal_id ` +
    (cond.length ? 'WHERE ' + cond.join(' AND ') + ' ' : '') + 'ORDER BY g.company, g.seal_id, g.id'
  ).all(...params).map((g) => {
    const t = localDate();
    const expired = g.valid_to && g.valid_to < t;
    return {
      ...g,
      scope_label: GRANT_SCOPE[g.scope] || g.scope,
      status_label: g.status === 'revoked' ? '已撤销' : expired ? '已过期' : '有效',
      effective_status: g.status === 'revoked' ? 'revoked' : expired ? 'expired' : 'active'
    };
  });
  const seals = db.prepare('SELECT id, company, name, keeper, status FROM seals ORDER BY company, id').all();
  return ok(res, {
    rows, seals,
    coverage: seals.map((s) => ({
      seal_id: s.id, company: s.company, name: s.name, keeper: s.keeper,
      grants: rows.filter((g) => g.seal_id === s.id && g.effective_status === 'active').length,
      warning: s.status === 'active' && !rows.some((g) => g.seal_id === s.id && g.effective_status === 'active')
        ? '没有有效授权：这家公司的章谁都盖不了（除系统管理员）' : null
    })),
    dict: { grant_scope: GRANT_SCOPE },
    note: '不同公司印章独立授权；授权可给到人/角色/岗位，并带有效期'
  });
}));

router.post('/seal-grants', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const seal = db.prepare('SELECT * FROM seals WHERE id = ?').get(b.seal_id);
  if (!seal) return fail(res, 404, '印章不存在');
  if (!String(b.grantee || '').trim()) return fail(res, 400, '请填被授权人（姓名 / 角色 / 岗位）');
  if (!['person', 'role', 'position'].includes(b.grantee_type || 'person')) return fail(res, 400, '授权对象类型应为 person / role / position');
  if (!['use', 'borrow', 'all'].includes(b.scope || 'use')) return fail(res, 400, '授权范围应为 use / borrow / all');
  if (b.valid_from && b.valid_to && b.valid_to < b.valid_from) return fail(res, 400, '授权截止日不能早于起始日');
  const t = now();
  const info = db.prepare(
    `INSERT INTO seal_grants (seal_id, company, grantee, grantee_type, scope, valid_from, valid_to, status, granted_by, granted_at, remark)
     VALUES (?,?,?,?,?,?,?, 'active', ?,?,?)`
  ).run(seal.id, seal.company, String(b.grantee).trim(), b.grantee_type || 'person', b.scope || 'use',
    b.valid_from || localDate(), b.valid_to || null, actor(req).username, t, b.remark || null);
  return ok(res, { id: Number(info.lastInsertRowid), notice: `已授权「${seal.company} · ${seal.name}」给 ${b.grantee}` });
}));

router.post('/seal-grants/:id/revoke', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const g = db.prepare('SELECT * FROM seal_grants WHERE id = ?').get(req.params.id);
  if (!g) return fail(res, 404, '授权不存在');
  if (g.status === 'revoked') return fail(res, 400, '这条授权已经撤销了');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '撤销授权必须写原因');
  db.prepare("UPDATE seal_grants SET status = 'revoked', revoke_reason = ? WHERE id = ?").run(reason, g.id);
  return ok(res, { id: g.id, status: 'revoked' });
}));

// ============================================================
// 五、用印 / 借章（复用 seal_usages，补授权、版本重核、借还）
// ============================================================
router.get('/seal-usages', authRequired, requireRole(READ), wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('u.status = ?'); params.push(req.query.status); }
  if (req.query.kind) { cond.push('u.kind = ?'); params.push(req.query.kind); }
  if (req.query.contract_id) { cond.push('u.contract_id = ?'); params.push(Number(req.query.contract_id)); }
  const rows = db.prepare(
    `SELECT u.*, s.name AS seal_name, s.company AS seal_company, c.name AS contract_name, c.contract_no
     FROM seal_usages u LEFT JOIN seals s ON s.id = u.seal_id LEFT JOIN admin_contracts c ON c.id = u.contract_id ` +
    (cond.length ? 'WHERE ' + cond.join(' AND ') + ' ' : '') + 'ORDER BY u.id DESC LIMIT 200'
  ).all(...params).map((u) => {
    const d = u.expect_return_date ? daysBetween(localDate(), u.expect_return_date) : null;
    return {
      ...u,
      kind_label: USAGE_KIND[u.kind] || u.kind,
      status_label: USAGE_STATUS[u.status] || u.status,
      days_left: d,
      borrow_overdue: u.kind === 'borrow' && u.status === 'borrowed' && d !== null && d < 0
    };
  });
  return ok(res, { rows, dict: { usage_kind: USAGE_KIND, usage_status: USAGE_STATUS } });
}));

router.post('/seal-usages', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const a = actor(req);
  const seal = db.prepare('SELECT * FROM seals WHERE id = ?').get(b.seal_id);
  if (!seal) return fail(res, 404, '印章不存在');
  if (seal.status !== 'active') return fail(res, 400, '该印章已停用，不能再申请');

  const kind = b.kind === 'borrow' ? 'borrow' : 'use';
  const purpose = String(b.purpose || '').trim();
  if (!purpose) return fail(res, 400, '请填写用途（用印/借章要能说清干什么）');

  // 1) 印章独立授权门禁
  const g = grantCheck(seal, a, kind);
  if (!g.ok) return fail(res, 400, g.reason);

  // 2) 借章必须写预计归还日
  if (kind === 'borrow' && !b.expect_return_date) return fail(res, 400, '借章必须填预计归还日（否则没人跟）');
  if (kind === 'borrow' && b.expect_return_date < localDate()) return fail(res, 400, '预计归还日不能早于今天');

  // 3) 用印要绑合同 → 必须对上「当前版本」的内容指纹
  let docHash = b.doc_hash || null;
  let contractId = b.contract_id ? Number(b.contract_id) : null;
  if (contractId) {
    const c = db.prepare('SELECT * FROM admin_contracts WHERE id = ?').get(contractId);
    if (!c) return fail(res, 404, '关联的合同不存在');
    if (c.status === 'archived') return fail(res, 400, '合同已归档，不能再申请用印');
    const cur = db.prepare('SELECT * FROM admin_contract_versions WHERE contract_id = ? ORDER BY version DESC LIMIT 1').get(contractId);
    if (cur && cur.doc_hash) {
      if (!docHash) docHash = cur.doc_hash;
      else if (docHash !== cur.doc_hash) {
        return fail(res, 400, `你提交的文件不是「当前最终版本」（当前 V${cur.version}）。修改正文后必须重新提交审批，不能用旧版本盖章`);
      }
    }
    if (c.seal_id && Number(c.seal_id) !== seal.id) {
      return fail(res, 400, `这份合同约定用「${(db.prepare('SELECT name FROM seals WHERE id = ?').get(c.seal_id) || {}).name || '其他章'}」，与所选印章不一致`);
    }
  }
  if (kind === 'use' && !String(b.doc_name || '').trim()) return fail(res, 400, '用印必须写文件名称');

  const t = now();
  const info = db.prepare(
    `INSERT INTO seal_usages (usage_no, seal_id, applicant, purpose, doc_name, doc_version, kind, contract_id,
       doc_hash, status, remark, created_at, updated_at, expect_return_date)
     VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?,?,?,?)`
  ).run(nextNo('seal_usages', 'usage_no', 'YY'), seal.id, a.name, purpose,
    b.doc_name || null, b.doc_version || null, kind, contractId, docHash,
    b.remark || null, t, t, kind === 'borrow' ? b.expect_return_date : null);
  return ok(res, {
    id: Number(info.lastInsertRowid),
    granted_via: g.via === 'admin' ? '系统管理员例外' : `授权 #${g.via.id}`,
    notice: `已提交${USAGE_KIND[kind]}申请（${seal.company} · ${seal.name}）。批准后用印/借出都留回执`
  });
}));

/** 批准（版本变了要重核） */
router.post('/seal-usages/:id/approve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const u = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(req.params.id);
  if (!u) return fail(res, 404, '申请不存在');
  if (u.status !== 'pending') return fail(res, 400, `申请状态是「${USAGE_STATUS[u.status]}」，只有待批能批准`);
  if (u.recheck_required) return fail(res, 400, `文件版本已变化需重核：${u.recheck_reason || ''}。请按最终版本重新提交`);
  const t = now();
  db.prepare("UPDATE seal_usages SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?")
    .run(actor(req).username, t, t, u.id);
  return ok(res, { id: u.id, status: 'approved', status_label: USAGE_STATUS.approved });
}));

/** 登记用印（必回执） */
router.post('/seal-usages/:id/use', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const u = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(req.params.id);
  if (!u) return fail(res, 404, '申请不存在');
  if (u.kind !== 'use') return fail(res, 400, '这是借章申请，请走借出登记');
  if (u.status !== 'approved') return fail(res, 400, '只有已批准状态可以登记用印');
  if (u.recheck_required) return fail(res, 400, `文件版本已变化需重核：${u.recheck_reason || ''}。不能用旧版本盖章`);
  // 再核一次：合同当前版本指纹是否还等于申请时记的
  if (u.contract_id) {
    const cur = db.prepare('SELECT * FROM admin_contract_versions WHERE contract_id = ? ORDER BY version DESC LIMIT 1').get(u.contract_id);
    if (cur && cur.doc_hash && u.doc_hash && cur.doc_hash !== u.doc_hash) {
      db.prepare("UPDATE seal_usages SET recheck_required = 1, recheck_reason = ? WHERE id = ?")
        .run('登记用印时发现合同已有新版本，需重核', u.id);
      return fail(res, 400, '合同正文已更新，需按最终版本重新审批后再盖章');
    }
  }
  const receipt = String((req.body || {}).receipt_no || '').trim();
  if (!receipt) return fail(res, 400, '登记用印必须填写回执号（不能用「点了就算」）');
  const t = now();
  db.prepare("UPDATE seal_usages SET status = 'used', used_at = ?, receipt_no = ?, updated_at = ? WHERE id = ?").run(t, receipt, t, u.id);
  return ok(res, { id: u.id, status: 'used', status_label: USAGE_STATUS.used, notice: '已用印，回执已留档' });
}));

/** 借出登记 */
router.post('/seal-usages/:id/borrow', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const u = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(req.params.id);
  if (!u) return fail(res, 404, '申请不存在');
  if (u.kind !== 'borrow') return fail(res, 400, '这是用印申请，请走登记用印');
  if (u.status !== 'approved') return fail(res, 400, '只有已批准状态可以借出');
  if (!u.expect_return_date) return fail(res, 400, '借章没有预计归还日，不能借出');
  const t = now();
  db.prepare("UPDATE seal_usages SET status = 'borrowed', borrow_out_at = ?, updated_at = ? WHERE id = ?").run(t, t, u.id);
  return ok(res, { id: u.id, status: 'borrowed', status_label: USAGE_STATUS.borrowed, notice: `已借出，应于 ${u.expect_return_date} 前归还` });
}));

/** 归还（用印/借章都要留回执） */
router.post('/seal-usages/:id/return', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const u = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(req.params.id);
  if (!u) return fail(res, 404, '申请不存在');
  if (!['used', 'borrowed'].includes(u.status)) return fail(res, 400, `申请状态是「${USAGE_STATUS[u.status]}」，只有已用印/已借出能登记归还`);
  const receipt = String((req.body || {}).return_receipt || '').trim();
  if (!receipt) return fail(res, 400, '归还必须填归还回执（谁收的、什么时候收的）');
  const t = now();
  db.prepare("UPDATE seal_usages SET status = 'returned', returned_at = ?, return_receipt = ?, updated_at = ? WHERE id = ?")
    .run(t, receipt, t, u.id);
  const late = u.expect_return_date && u.expect_return_date < localDate();
  return ok(res, {
    id: u.id, status: 'returned',
    status_label: USAGE_STATUS.returned,
    notice: late ? `已归还，但超出预计归还日（应还 ${u.expect_return_date}），已记录` : '已归还，回执已留档'
  });
}));

router.post('/seal-usages/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const u = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(req.params.id);
  if (!u) return fail(res, 404, '申请不存在');
  if (!['pending', 'approved'].includes(u.status)) return fail(res, 400, '当前状态不能驳回');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '驳回必须写原因');
  const t = now();
  db.prepare("UPDATE seal_usages SET status = 'rejected', remark = COALESCE(remark || ' | ', '') || ?, updated_at = ? WHERE id = ?")
    .run(`驳回：${reason}`, t, u.id);
  return ok(res, { id: u.id, status: 'rejected' });
}));

// ============================================================
// 六、证照档案与访问留痕
// ============================================================
router.get('/certificates', authRequired, requireRole(READ), wrap(async (req, res) => {
  const t = localDate();
  const rows = db.prepare("SELECT * FROM certificates WHERE status = 'valid' ORDER BY (expire_date IS NULL), expire_date").all().map((c) => {
    const d = daysBetween(t, c.expire_date);
    return {
      ...c,
      type_label: { license: '营业执照', permit: '许可证', lease: '租赁合同', insurance: '保险', other: '其他' }[c.type] || c.type,
      days_left: d,
      expiring: d === null ? null : d < 0 ? 'expired' : d <= 30 ? '30' : d <= 90 ? '90' : null,
      access_label: c.access_level === 'public' ? '可公开' : '受控'
    };
  });
  return ok(res, rows);
}));

/** 查看/下载敏感档案：留痕后再给（controlled 的必须记） */
router.post('/certificates/:id/view', authRequired, requireRole(READ), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '证照不存在');
  const action = (req.body || {}).action || 'view';
  logAccess(req, 'certificate', c.id, c.name, c.access_level || 'controlled', action, true, (req.body || {}).reason || null);
  return ok(res, {
    certificate: c,
    notice: c.access_level === 'public' ? '已记录访问' : '该证照为受控档案，本次访问已留痕（谁、什么时候、看了什么）'
  });
}));

router.get('/access-logs', authRequired, requireRole(READ), wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.doc_type) { cond.push('doc_type = ?'); params.push(req.query.doc_type); }
  if (req.query.doc_id) { cond.push('doc_id = ?'); params.push(Number(req.query.doc_id)); }
  const rows = db.prepare(
    `SELECT * FROM doc_access_logs ${cond.length ? 'WHERE ' + cond.join(' AND ') + ' ' : ''} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  return ok(res, {
    rows,
    stat: {
      total: rows.length,
      controlled: rows.filter((r) => r.access_level === 'controlled').length,
      denied: rows.filter((r) => !r.allowed).length
    },
    note: '敏感原件不进全员可见范围；访问留痕便于事后追溯'
  });
}));

// ============================================================
// 七、字典
// ============================================================
router.get('/dict', authRequired, wrap(async (req, res) => {
  return ok(res, {
    type: CONTRACT_TYPE, status: CONTRACT_STATUS, ms_type: MS_TYPE, ms_status: MS_STATUS,
    grant_scope: GRANT_SCOPE, usage_kind: USAGE_KIND, usage_status: USAGE_STATUS,
    note: '合同只做台账与履约提醒；采购与客户合同仍归各自模块，可索引不复制'
  });
}));

module.exports = router;
module.exports.grantCheck = grantCheck;
