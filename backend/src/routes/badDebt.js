/**
 * 坏账准备计提
 *
 * GET  /api/bad-debt/policy?company_id=      计提比例（按主体）
 * PUT  /api/bad-debt/policy                  保存比例 {company_id, items:[{bucket, rate, note}]}
 * GET  /api/bad-debt/preview?period=&company_id=  测算（不写库）
 * POST /api/bad-debt/post                    过账 {period, force, company_id}
 * GET  /api/bad-debt/history?company_id=     计提历史
 * GET  /api/bad-debt/aging?period=           账龄明细（页面展开用）
 *
 * ⚠️ 字面量路由全部写在前面，且本模块没有 /:id，不受顺序影响；
 * 但 /preview、/policy 这类字面量仍然前置，避免以后加 /:period 时踩坑。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const CS = require('../access/companyScope');
const B = require('../services/badDebt');

const router = express.Router();

// 计提影响利润表和资产，只给财务和管理员看；老板只读
const READ = ['admin', 'boss', 'finance'];

/**
 * 主体一律服务端判定
 *
 * ⚠️ 本模块目前**未挂载**（server.js 里挂载 `/api/bad-debt` 的那一行被注释掉了，
 * 财务模块暂缓）。这里仍然改，是因为它是一颗地雷：一旦重新打开，
 * 原来那套「req.query.company_id 直接进服务层」会让 finance 随手读别家的
 * 计提比例、账龄明细与计提历史。重新上线时不用再回头查一遍。
 */
const coId = (req, raw, act) => CS.resolveCompany(req.user, raw, { action: act || '查看坏账计提', concrete: true });
const WRITE = ['admin', 'finance'];

router.get(
  '/policy',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, B.policy(coId(req, req.query.company_id))))
);

router.put(
  '/policy',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    return ok(res, B.savePolicy(b.items || b.list, coId(req, b.company_id, '保存坏账计提比例')));
  })
);

router.get(
  '/preview',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const period = String(req.query.period || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      const e = new Error('请指定期间（格式 YYYY-MM）');
      e.status = 400;
      throw e;
    }
    return ok(res, B.preview(period, coId(req, req.query.company_id)));
  })
);

router.get(
  '/aging',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const period = String(req.query.period || '').slice(0, 7);
    // 月末必须用 periodRange 算：拼 '-31' 到了 2 月/4 月就是非法日期
    const gl = require('../services/gl');
    const asOf = /^\d{4}-\d{2}$/.test(period)
      ? gl.periodRange(period).end
      : new Date().toISOString().slice(0, 10);
    return ok(res, B.aging(asOf, coId(req, req.query.company_id, '查看账龄明细')));
  })
);

router.post(
  '/post',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    const r = B.post(String(b.period || '').slice(0, 7), {
      force: b.force === true || b.force === 1,
      operator: req.user.username,
      company_id: coId(req, b.company_id, '过账坏账计提')
    });
    return ok(res, r);
  })
);

router.get(
  '/history',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, B.history(coId(req, req.query.company_id, '查看计提历史'), req.query.limit)))
);

module.exports = router;
