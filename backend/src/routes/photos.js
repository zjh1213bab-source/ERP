/**
 * 现场照片留证
 *
 * GET    /api/photos/cats                 分类口径（前后端共用一份）
 * GET    /api/photos                      照片墙列表 ?order_id&cat&node_id&from&to&keyword&limit&offset
 * GET    /api/photos/stats                顶部指标（张数/订单数/占用/分类分布/近 14 天）
 * GET    /api/photos/order/:id            某张单的全部照片（订单详情附件区用）
 * POST   /api/photos                      拍一张：{ order_id, dataUrl, cat, note, node_id, taken_at }
 * POST   /api/photos/batch                一次传多张（手机连拍）
 * DELETE /api/photos/:id                  软删除（只能删自己的，admin 除外）
 */
const express = require('express');
const P = require('../services/photos');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// 拍照是车间/仓库/技术/销售的现场动作；财务与人事不产生现场照片
const WRITE = ['admin', 'production', 'warehouse', 'tech', 'sales'];

router.get('/cats', authRequired, wrap(async (req, res) => ok(res, P.CATS)));

router.get(
  '/',
  authRequired,
  wrap(async (req, res) => ok(res, P.list(req.query)))
);

router.get(
  '/stats',
  authRequired,
  wrap(async (req, res) => ok(res, { ...P.stats(req.query), disk: P.diskUsage() }))
);

router.get(
  '/order/:id',
  authRequired,
  wrap(async (req, res) =>
    ok(res, P.list({ order_id: Number(req.params.id), limit: 200 }).rows)
  )
);

router.post(
  '/',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    const row = P.save({
      order_id: b.order_id,
      dataUrl: b.dataUrl,
      cat: b.cat,
      note: b.note,
      node_id: b.node_id,
      taken_at: b.taken_at,
      uploader: req.user.username
    });
    return ok(res, row);
  })
);

/**
 * 连拍上传：手机上一张一张发，网络抖动时不会「全部重来」。
 * 返回 saved / failed 两段，前端把失败的单独提示，成功的照常进列表。
 */
router.post(
  '/batch',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const list = Array.isArray(req.body && req.body.photos) ? req.body.photos : [];
    if (!list.length) return fail(res, 400, '没有要上传的照片');
    if (list.length > 12) return fail(res, 400, '一次最多 12 张，请分批上传');

    const saved = [];
    const failed = [];
    list.forEach((p, i) => {
      try {
        saved.push(
          P.save({
            order_id: p.order_id || (req.body && req.body.order_id),
            dataUrl: p.dataUrl,
            cat: p.cat || (req.body && req.body.cat),
            note: p.note || (req.body && req.body.note),
            node_id: p.node_id || (req.body && req.body.node_id),
            taken_at: p.taken_at || (req.body && req.body.taken_at),
            uploader: req.user.username
          })
        );
      } catch (e) {
        failed.push({ index: i, message: e.message });
      }
    });
    return ok(res, { saved, failed, saved_count: saved.length, failed_count: failed.length });
  })
);

router.delete(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const u = { username: req.user.username, role: req.user.role, roles: req.user.roles };
    return ok(res, P.remove(req.params.id, u));
  })
);

module.exports = router;
