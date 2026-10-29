/**
 * 用户与角色（仅 admin）
 * GET  /api/users
 * POST /api/users            新建 { username, password, name, role, department_id, company_id?, extra_roles? }
 * PUT  /api/users/:id        修改 { name, role, active, password?, company_id?, extra_roles? }
 *
 * 角色清单以 src/access/permissions.js 为唯一来源，不在这里另抄一份。
 * 一人多岗：users.role 是主岗，user_roles 是附加岗，生效权限取并集。
 *
 * ## 这个文件管着两件"出过事"的事
 *
 * ### 1. 新建账号必须落公司主体
 *
 * 原来这里 INSERT 不带 `company_id`，列默认 NULL。而范围层对"没绑主体"的账号
 * 原本是「不加过滤」—— 于是**从管理页面上新建的业务账号能看到所有主体的数据**，
 * 页面上还看不出任何异常（列表有数、金额有数，只是多了别人的）。
 * 现在：单公司模式恒落唯一抬头；多主体模式必须给一个合法主体，
 * 非集团角色只能建自己主体的账号。`companyScope` 那边也改为对未绑定账号直接拒绝。
 *
 * ### 2. 停用 / 降权 / 改密必须让旧令牌立刻失效
 *
 * JWT 签出去就是 12 小时，服务端没有"撤回"。所以任何一次
 * 「该让人重新登录」的改动都要把 `users.token_version` +1，
 * 与令牌里的 `tv` 一比就失效（校验在 middleware/auth.js）。
 * 少做这一步的具体后果：人已经停用了，旧令牌还能改钱、还能导出。
 */
const express = require('express');
const { db, now } = require('../db');
const { hashPassword } = require('../auth/password');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { ROLES, ROLE_LABELS } = require('../access/permissions');
const CS = require('../access/companyScope');
const A = require('../services/access');

const router = express.Router();

function decorate(row) {
  if (!row) return row;
  const extra = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(row.id).map((r) => r.role);
  const company = row.company_id
    ? db.prepare('SELECT id, name, short_name FROM companies WHERE id = ?').get(row.company_id)
    : null;
  return {
    ...row,
    role_label: ROLE_LABELS[row.role] || row.role,
    extra_roles: extra,
    extra_role_labels: extra.map((r) => ROLE_LABELS[r] || r),
    company_name: company ? (company.short_name || company.name) : null,
    /**
     * 前端据此把这一行标红：没有主体归属的账号在多主体模式下会被直接拒绝访问，
     * 与其等用户投诉"登进去什么都点不了"，不如列表上就写着。
     */
    company_missing: !row.company_id
  };
}

/**
 * 解析「这次要写哪个主体」
 *
 * 三种情况分开处理，不要合成一行三元表达式：
 *   1. 单公司模式：忽略前端传的值，恒落抬头（客户端传 `company_id` 也不能改这个事实）；
 *   2. 多主体 + 显式指定：必须是存在的主体；非集团角色只能指定自己那个主体
 *      （否则销售能把新账号建到别的主体下，等于给自己开了个跨主体入口）；
 *   3. 多主体 + 没指定：落操作人自己的主体；操作人自己都没主体 → 拒绝并说清原因。
 *
 * @returns {{ id?:number, error?:string, status?:number }}
 */
function resolveCompanyId(req, wanted) {
  if (CS.isSingle()) return { id: Number(CS.header().id) || 1 };
  const n = Number(wanted) || 0;
  const sc = CS.of(req.user);
  if (n > 0) {
    const c = db.prepare('SELECT id FROM companies WHERE id = ?').get(n);
    if (!c) return { error: '指定的公司主体不存在', status: 400 };
    if (!sc.cross && n !== sc.companyId) {
      return { error: '只能为本公司创建/调整账号；跨主体请由集团管理员操作', status: 403 };
    }
    return { id: n };
  }
  if (!sc.companyId) {
    return { error: '请指定该账号所属的公司主体：不指定会导致其数据范围无法判定', status: 400 };
  }
  return { id: sc.companyId };
}

router.get(
  '/',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const rows = db
      .prepare(
        'SELECT id, username, name, role, company_id, department_id, active, created_at FROM users ORDER BY id'
      )
      .all();
    return ok(res, rows.map(decorate));
  })
);

router.get(
  '/roles',
  authRequired,
  wrap(async (req, res) =>
    ok(res, ROLES.map((code) => ({ code, label: ROLE_LABELS[code] || code })))
  )
);

router.post(
  '/',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.username || !b.password) return fail(res, 400, '账号和密码必填');
    if (!ROLES.includes(b.role)) return fail(res, 400, '角色不合法');
    if (String(b.password).length < 6) return fail(res, 400, '密码至少 6 位');
    const dup = db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(b.username);
    if (dup) return fail(res, 400, '账号已存在');

    // 主体归属先定下来再落库 —— 落完再补等于给了一个"短暂无归属"的窗口
    const comp = resolveCompanyId(req, b.company_id);
    if (comp.error) return fail(res, comp.status || 400, comp.error);

    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, name, role, company_id, department_id, active, created_at, token_version)
         VALUES (?,?,?,?,?,?,1,?,0)`
      )
      .run(b.username, hashPassword(b.password), b.name || b.username, b.role,
        comp.id, b.department_id || null, now());
    const id = Number(info.lastInsertRowid);
    if (Array.isArray(b.extra_roles) && b.extra_roles.length) {
      A.setExtraRoles({ userId: id, roles: b.extra_roles, operator: req.user.username || '' });
    }
    const row = db
      .prepare('SELECT id, username, name, role, company_id, department_id, active, created_at FROM users WHERE id = ?')
      .get(id);
    return ok(res, decorate(row));
  })
);

router.put(
  '/:id',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const exists = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!exists) return fail(res, 404, '用户不存在');
    const b = req.body || {};
    if (b.role && !ROLES.includes(b.role)) return fail(res, 400, '角色不合法');

    const nextRole = b.role || exists.role;
    const nextActive = b.active === undefined ? Number(exists.active) : (b.active ? 1 : 0);
    const self = id === Number(req.user.sub);

    /**
     * 自锁防护：管理员不能把自己停用、也不能把自己降成非管理员
     *
     * 这不是"多管闲事"—— 这两个操作一旦生效，改的人自己立刻失去管理页权限，
     * 而系统里如果只有他一个管理员，就再也没人能改回来了（只能改库）。
     */
    if (self && !nextActive) return fail(res, 400, '不能停用自己的账号');
    if (self && exists.role === 'admin' && nextRole !== 'admin') {
      return fail(res, 400, '不能取消自己的管理员角色，请由其他管理员操作');
    }

    // 主体归属：只有传了才动（没传 = 不改，保留历史归属）
    let nextCompany = exists.company_id;
    if (b.company_id !== undefined && b.company_id !== null && b.company_id !== '') {
      const comp = resolveCompanyId(req, b.company_id);
      if (comp.error) return fail(res, comp.status || 400, comp.error);
      nextCompany = comp.id;
    } else if (CS.isSingle() && !exists.company_id) {
      // 单公司模式下顺手把历史空归属补上（不清洗的话，切回多主体时这批人会全部被拒）
      nextCompany = Number(CS.header().id) || 1;
    }

    /**
     * 是否需要作废旧令牌
     *
     * 四个条件任一成立就 +1：改角色、停用/启用、改密码、换主体。
     * 「启用」也 +1 看着多余（启用不增加权限），但停用期间签发的令牌本来就不该复活 ——
     * 停用那一刻已经 +1 过了，再启用时旧令牌的 tv 早已落后，仍然无效。多 +1 无害。
     */
    const roleChanged = nextRole !== exists.role;
    const activeChanged = nextActive !== Number(exists.active);
    const pwdChanged = !!b.password;
    const companyChanged = Number(nextCompany || 0) !== Number(exists.company_id || 0);
    const revoke = roleChanged || activeChanged || pwdChanged || companyChanged;

    db.prepare(
      `UPDATE users SET name=?, role=?, active=?, company_id=?,
         token_version = COALESCE(token_version,0) + ?
       WHERE id=?`
    ).run(
      b.name || exists.name,
      nextRole,
      nextActive,
      nextCompany,
      revoke ? 1 : 0,
      id
    );
    if (b.password) {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), id);
    }
    if (Array.isArray(b.extra_roles)) {
      A.setExtraRoles({ userId: id, roles: b.extra_roles, operator: req.user.username || '' });
    }
    // 权限 / 主体 / 会话三份缓存一起清（clearCache 内部已覆盖 c{id} 与 s{id}）
    A.clearCache(id);

    const row = db
      .prepare('SELECT id, username, name, role, company_id, department_id, active, created_at FROM users WHERE id = ?')
      .get(id);
    return ok(res, { ...decorate(row), token_revoked: revoke });
  })
);

module.exports = router;
