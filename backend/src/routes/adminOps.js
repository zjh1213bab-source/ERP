/**
 * 行政运营报表（TS-N14-09）
 * ========================================================================
 * - `/api/admin-ops/preview`    按期间现算一份（不落库，看最新数）
 * - `/api/admin-ops/run`        定版：把八项指标与口径冻成快照 + 生成差异清单
 * - `/api/admin-ops/runs`       历史版本（同一期间可以有多版，用于回答「上个月看时不是 68% 吗」）
 * - `/api/admin-ops/findings`   差异清单：分派 → 处理 → 复核关闭（或忽略，必须写理由）
 * - `/api/admin-ops/drill`      下钻源单（含人名，需 `adminops.detail`）
 *
 * 权限四层：
 * - 看汇总：全角色（行政数据本身不敏感，敏感的是「谁住哪张床」）
 * - 看明细/下钻：admin / hr / finance（人名与住宿单）
 * - 跑表定版：admin / hr / finance（定版后就是对外口径）
 * - 复核关闭：admin / hr / finance
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const S = require('../services/adminOps');
const B = require('../services/bedDays');

const router = express.Router();

const READ = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
const MANAGE = ['admin', 'hr', 'finance'];

const actor = (req) => (req.user && (req.user.name || req.user.username || req.user.sub)) || 'system';
const myRoles = (req) => (req.user.roles && req.user.roles.length ? req.user.roles : [req.user.role]);
const canDetail = (req) => myRoles(req).some((r) => MANAGE.includes(r));

/** 无明细权限时只给「姓 + *」，住哪张床、吃多少饭这类事不该全员可见 */
const maskName = (name) => {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.length <= 1 ? s : s[0] + '*'.repeat(Math.min(s.length - 1, 2));
};

router.get('/meta', authRequired, requireRole(...READ), wrap(async (req, res) => ok(res, S.meta())));

router.get('/preview', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const q = req.query || {};
  const rep = S.buildReport(String(q.period || ''), { company_id: q.company_id ? Number(q.company_id) : null });
  return ok(res, rep);
}));

router.get('/runs', authRequired, requireRole(...READ), wrap(async (req, res) =>
  ok(res, S.listRuns(req.query || {}))));

router.get('/runs/:id', authRequired, requireRole(...READ), wrap(async (req, res) =>
  ok(res, S.runDetail(req.params.id))));

// 定版会冻结口径，属高危
router.post('/run', authRequired, requireRole(...MANAGE), wrap(async (req, res) => {
  const b = req.body || {};
  return ok(res, S.runReport(String(b.period || ''), {
    company_id: b.company_id ? Number(b.company_id) : null,
    force: !!b.force,
    note: b.note
  }, actor(req)));
}));

router.get('/findings', authRequired, requireRole(...READ), wrap(async (req, res) =>
  ok(res, S.listFindings(req.query || {}))));

router.post('/assign/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.assignFinding(req.params.id, req.body || {}, actor(req)))));

// 处理（写处理结果，进入待复核）
router.post('/review/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.closeFinding(req.params.id, { ...(req.body || {}), stage: 'fixed' }, actor(req)))));

// 复核关闭
router.post('/close/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.closeFinding(req.params.id, { ...(req.body || {}), stage: 'close' }, actor(req)))));

router.post('/ignore/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.ignoreFinding(req.params.id, req.body || {}, actor(req)))));

/**
 * 下钻源单
 * 只给「这一段的所有源单」，不做「点某条差异跳到哪一单」的魔法 ——
 * 差异项里的 subject 是给人看的描述，不是主键；按它反查主键早晚查错。
 */
router.get('/drill', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const q = req.query || {};
  const metric = String(q.metric || '');
  const period = String(q.period || '');
  const companyId = q.company_id ? Number(q.company_id) : null;
  const rep = S.buildReport(period, { company_id: companyId });
  const detail = canDetail(req);
  const range = B.periodRange(period);

  let rows = [];
  let note = '';
  if (metric === 'dorm') {
    rows = db_rooms(rep, period);
    // 注意：dorm 返回的是 { by_room, stays } 而不是数组，脱敏要落在 stays 上。
    // 早先写成 rows.map 会直接抛 TypeError（对象没有 map），整页 500 而表单看不出原因。
    if (!detail) {
      rows = {
        ...rows,
        stays: rows.stays.map((x) => ({ ...x, employee_name: x.employee_name ? maskName(x.employee_name) : x.employee_name }))
      };
      note = '你只有汇总权限，入住人姓名已脱敏（需要人事/财务/管理员岗位看全名）';
    }
  } else if (metric === 'expense') {
    rows = rep.expense.rows;
  } else if (metric === 'meal') {
    rows = db_meal(period, detail ? null : maskName);
    if (!detail) note = '你只有汇总权限，账户姓名已脱敏';
  } else if (metric === 'asset') {
    rows = db.prepare('SELECT id, code, name, category, dept, keeper, status, original_value FROM assets ORDER BY id').all();
    if (!detail) rows = rows.map((x) => ({ ...x, keeper: x.keeper ? maskName(x.keeper) : x.keeper }));
  } else if (metric === 'office') {
    rows = db.prepare(`
      SELECT i.id, i.item_no, i.name, i.unit, i.min_qty,
        COALESCE(s.qty,0) AS stock_qty,
        COALESCE((SELECT SUM(qty) FROM office_ledger l WHERE l.item_id = i.id),0) AS ledger_qty
      FROM office_items i LEFT JOIN office_stock s ON s.item_id = i.id
      WHERE i.status = 'active' ORDER BY i.category, i.name`).all();
  } else if (metric === 'budget') {
    rows = rep.budget.items;
  } else if (metric === 'repair') {
    rows = rep.repair.rows;
  } else {
    return ok(res, { rows: [], note: '未知指标' });
  }
  return ok(res, { metric, period, range, rows, note, masked: !detail });
}));

/* 下钻用的两条查询放在路由里，避免服务层为了「给人看」再堆一层脱敏逻辑 */
function db_rooms(rep, period) {
  const stays = db.prepare(`
    SELECT s.id, s.bed_id, s.employee_id, e.name AS employee_name, s.start_date, s.end_date, s.status,
           b.bed_no, r.building, r.room_no
    FROM dorm_stays s
    LEFT JOIN dorm_beds b ON b.id = s.bed_id
    LEFT JOIN dorm_rooms r ON r.id = b.room_id
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.status IN ('active','checked_out') ORDER BY r.building, r.room_no, b.bed_no`).all();
  return { period, by_room: rep.dorm.by_room, stays };
}

function db_meal(period, masker) {
  const accs = db.prepare(`
    SELECT a.id, a.employee_id, e.name AS employee_name, a.card_no, a.balance, a.subsidy_balance, a.status
    FROM meal_accounts a LEFT JOIN employees e ON e.id = a.employee_id ORDER BY a.id`).all();
  const txs = db.prepare(`
    SELECT t.id, t.account_id, t.type, t.amount, t.personal_delta, t.subsidy_delta, t.receipt_no, t.created_at,
           e.name AS employee_name
    FROM meal_transactions t
    LEFT JOIN meal_accounts a ON a.id = t.account_id
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE strftime('%Y-%m', t.created_at, 'localtime') = ? ORDER BY t.id DESC`).all(period);
  if (!masker) return { accounts: accs, transactions: txs };
  return {
    accounts: accs.map((x) => ({ ...x, employee_name: masker(x.employee_name) })),
    transactions: txs.map((x) => ({ ...x, employee_name: masker(x.employee_name) }))
  };
}

module.exports = router;
