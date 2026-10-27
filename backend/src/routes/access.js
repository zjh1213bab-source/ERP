/**
 * 岗位权限复核
 * ============================================================
 * GET    /api/access/permissions        全量权限点表（前端启动时同步，替代本地硬编码）
 * GET    /api/access/me                 当前账号的生效权限（按钮显隐以此为准）
 * GET    /api/access/roles              角色清单 + 各角色默认权限点
 * GET    /api/access/review             复核矩阵：用户 × 生效权限 + 例外 + 多岗 + 职责冲突
 * POST   /api/access/exceptions         设置例外 { user_id, perm, effect, reason }
 * DELETE /api/access/exceptions/:id     撤销例外
 * POST   /api/access/roles              设置附加岗 { user_id, roles: [] }
 * GET    /api/access/sod                职责分离规则与冲突
 * GET    /api/access/reviews            复核签字记录
 * POST   /api/access/reviews            记录一次复核（签字留痕）
 *
 * 谁能看：管理员 + 人事行政（复核要两个岗位一起过，不能只有 IT 自己说了算）
 * 谁能改：只有管理员。改权限的动作必须收敛到一个口，否则复核没有意义。
 */
const express = require('express');
const { now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const A = require('../services/access');

const router = express.Router();

/** 统一把 service 抛的错变成 400，避免 500 噪音 */
function guard(fn) {
  return (req, res) => {
    try {
      return fn(req, res);
    } catch (e) {
      return fail(res, 400, e.message || '操作失败');
    }
  };
}

router.get(
  '/permissions',
  authRequired,
  wrap(async (req, res) =>
    ok(res, {
      roles: A.ROLES,
      role_labels: A.ROLE_LABELS,
      perms: A.PERMS,
      sod_rules: A.SOD_RULES
    })
  )
);

router.get(
  '/me',
  authRequired,
  wrap(async (req, res) => {
    const eff = A.effective(req.user.sub, req.user.role);
    return ok(res, {
      user_id: req.user.sub,
      role: req.user.role,
      roles: eff.roles,
      is_admin: eff.isAdmin,
      perms: eff.isAdmin ? A.allPerms() : eff.perms,
      denied: eff.deny,
      allowed_by_exception: eff.allow
    });
  })
);

router.get(
  '/roles',
  authRequired,
  wrap(async (req, res) =>
    ok(
      res,
      A.ROLES.map((r) => {
        const perms = Object.keys(A.PERMS).filter((p) => (A.PERMS[p] || []).includes(r));
        return { code: r, label: A.ROLE_LABELS[r], perms, perm_count: perms.length };
      })
    )
  )
);

router.get(
  '/review',
  authRequired,
  requireRole(['admin', 'hr']),
  wrap(async (req, res) => ok(res, A.reviewMatrix()))
);

router.post(
  '/exceptions',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => {
    const b = req.body || {};
    const row = A.setException({
      userId: Number(b.user_id),
      perm: b.perm,
      effect: b.effect || 'deny',
      reason: b.reason,
      operator: req.user.username || req.user.name || ''
    });
    return ok(res, row);
  })
);

router.delete(
  '/exceptions/:id',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => ok(res, A.removeException(Number(req.params.id))))
);

router.post(
  '/roles',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => {
    const b = req.body || {};
    const roles = A.setExtraRoles({
      userId: Number(b.user_id),
      roles: b.roles || [],
      operator: req.user.username || req.user.name || ''
    });
    return ok(res, { user_id: Number(b.user_id), extra_roles: roles });
  })
);

router.get(
  '/sod',
  authRequired,
  requireRole(['admin', 'hr']),
  wrap(async (req, res) => ok(res, A.sodConflicts()))
);

router.get(
  '/reviews',
  authRequired,
  requireRole(['admin', 'hr']),
  wrap(async (req, res) => ok(res, A.listReviews()))
);

router.post(
  '/reviews',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => {
    const b = req.body || {};
    if (!b.signed_off_by) throw new Error('请填写复核确认人（签字）');
    const row = A.signOff({
      period: b.period,
      scope: b.scope,
      signedOffBy: b.signed_off_by,
      note: b.note,
      operator: req.user.username || req.user.name || ''
    });
    return ok(res, row);
  })
);

module.exports = router;
