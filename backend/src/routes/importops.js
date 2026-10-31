/**
 * 上线准备：真实数据导入 —— 路由
 * ============================================================
 * 权限：读（看模板与历史）所有业务角色；预览 admin/finance/sales/tech/warehouse；
 *       提交（会写库）admin / finance
 * 说明：期初库存会动库存与流水，所以提交只放 admin 与财务，业务角色只能预览。
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/importOps');
const scope = require('../access/companyScope');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const PREVIEW = ['admin', 'finance', 'sales', 'tech', 'warehouse'];
const COMMIT = ['admin', 'finance'];

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      if (e.payload) return res.status(code).json({ ok: false, message: e.message, data: e.payload });
      return fail(res, code, e.message);
    }
  };
}

const opName = (req) =>
  (req.user && (req.user.name || req.user.username)) || String((req.user && (req.user.id || req.user.sub)) || 'system');

router.get('/types', authRequired, guard(() => ({ types: S.typeList() })));

router.get('/template/:type', authRequired, (req, res) => {
  try {
    const csv = S.template(req.params.type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.type}.csv"`);
    return res.send(csv);
  } catch (e) {
    return fail(res, 404, e.message);
  }
});

router.post('/preview', authRequired, requireRole(...PREVIEW),
  guard((req) => S.preview(req.body && req.body.type, req.body && req.body.csv)));

// 角色必须**写全**，不能用 `requireRole(...COMMIT, 'hr')` 这种展开：
// 静态审计（scripts/rbac-audit.js）认的是字面量，展开写法会让这个路由
// 直接从 RBAC 清单里消失 —— 等于给自己制造一个审计盲区（已实测踩到）。
router.post('/commit', authRequired, requireRole('admin', 'finance', 'hr'),
  guard((req) => {
    const b = req.body || {};
    /**
     * 人事要能导员工档案，但**不能导期初库存**（那会动库存与流水，只放管理员/财务）。
     * 所以 COMMIT 里加 hr，再用类型卡住 —— 比"人人都能导全部类型"安全得多。
     */
    if (req.user.role === 'hr' && b.type !== 'employees') {
      const e = new Error('人事只能提交员工档案导入；其它类型（含期初库存）仅限管理员/财务');
      e.code = 403;
      throw e;
    }
    const opts = { ...(b.opts || b), company_id: scope.writeCompanyOf(req.user) };
    return S.commit(b.type, b.csv, opts, opName(req));
  }));

router.get('/batches', authRequired, guard((req) => ({ rows: S.batches(req.query || {}) })));

router.get('/batches/:id', authRequired, guard((req) => S.batchDetail(req.params.id)));

module.exports = router;
module.exports.READ = READ;
