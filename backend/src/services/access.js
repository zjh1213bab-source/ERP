/**
 * 权限生效计算 / 职责分离检查 / 复核留痕
 * ============================================================
 * 生效权限 = 主岗 ∪ 附加岗 的默认权限 − deny 例外 + allow 例外
 *
 * 三层为什么要这样叠：
 *   岗位默认（PERMS）   —— 按岗定，覆盖 90% 的人
 *   附加岗（user_roles）—— 一人多岗，取并集，不改主岗
 *   例外（exceptions）  —— 只剩个别差异：某人这块不给（deny）、某人那块要给（allow）
 *
 * allow 的作用范围被刻意限制成「抵消同一权限点的 deny」，不做跨角色提权。
 * 否则「给他开个口子」这句人话，最后会变成一张谁也不敢动的暗权表。
 */
const { db, now } = require('../db');
const {
  ROLES, ROLE_LABELS, PERMS, GUARDED, WRITE_METHODS, SOD_RULES,
  permsOfRole, allPerms
} = require('../access/permissions');

const CACHE_TTL = 20 * 1000;
const _cache = new Map();

function cached(key, fn) {
  const hit = _cache.get(key);
  const ts = Date.now();
  if (hit && ts - hit.at < CACHE_TTL) return hit.v;
  const v = fn();
  _cache.set(key, { v, at: ts });
  return v;
}

function clearCache(userId) {
  if (!userId) return _cache.clear();
  // 一个用户可能有多条缓存键（u1 角色、e1:sales 生效权限），按前缀清
  ['u' + userId, 'e' + userId + ':'].forEach((k) => {
    _cache.delete(k);
    [..._cache.keys()].filter((x) => k.endsWith(':') && x.startsWith(k)).forEach((x) => _cache.delete(x));
  });
}

/** 主岗 + 附加岗（去重、过滤非法值） */
function rolesOf(userId, primaryRole) {
  return cached('u' + userId, () => {
    let extra = [];
    try {
      extra = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId).map((r) => r.role);
    } catch (e) {
      extra = []; // 老库还没跑 DDL 时不要炸
    }
    const list = [primaryRole, ...extra].filter((r) => ROLES.includes(r));
    return [...new Set(list)];
  });
}

function exceptionsOf(userId) {
  try {
    return db.prepare('SELECT perm, effect, reason FROM access_exceptions WHERE user_id = ?').all(userId);
  } catch (e) {
    return [];
  }
}

/**
 * 计算某用户的生效权限
 * @returns {{roles:string[], base:string[], deny:string[], allow:string[], perms:string[], isAdmin:boolean}}
 */
function effective(userId, primaryRole) {
  return cached('e' + userId + ':' + primaryRole, () => computeEffective(userId, primaryRole));
}

function computeEffective(userId, primaryRole) {
  const roles = rolesOf(userId, primaryRole);
  const isAdmin = primaryRole === 'admin';
  const base = new Set();
  roles.forEach((r) => permsOfRole(r).forEach((p) => base.add(p)));

  const exc = exceptionsOf(userId);
  const deny = exc.filter((e) => e.effect === 'deny').map((e) => e.perm);
  const allow = exc.filter((e) => e.effect === 'allow').map((e) => e.perm);

  const perms = new Set(base);
  deny.forEach((p) => perms.delete(p));
  // allow 只把「被 deny 掉的」加回来，不会凭空创造角色外的权限
  allow.forEach((p) => { if (base.has(p)) perms.add(p); });

  if (isAdmin) {
    // admin 恒通过：不代表拥有一切权限点（业务按钮仍按岗位走），但业务判断上视为全通
    return { roles, base: [...base], deny: [], allow, perms: [...perms], isAdmin: true };
  }
  return { roles, base: [...base], deny, allow, perms: [...perms], isAdmin: false };
}

/** 是否持有某权限点 */
function hasPerm(userId, primaryRole, perm) {
  const eff = effective(userId, primaryRole);
  if (eff.isAdmin) return true;
  return eff.perms.includes(perm);
}

/**
 * 高危路由拦截：命中被 deny 的权限点 → 拒绝
 * 未登记的权限点不拦（只在前端隐藏按钮），这是有意保留的边界。
 * @returns {{perm:string, reason:string}|null}
 */
function matchDeny(req) {
  const u = req.user;
  if (!u) return null;
  const eff = effective(u.sub, u.role);
  if (eff.isAdmin) return null;
  if (!eff.deny.length) return null;

  const method = req.method.toUpperCase();
  const url = (req.originalUrl || req.url || '').split('?')[0];

  for (const g of GUARDED) {
    if (!eff.deny.includes(g.perm)) continue;
    if (eff.allow.includes(g.perm)) continue; // 个别开口子，放行
    if (g.method !== '*' && g.method !== method) continue;
    if (url === g.prefix || url.startsWith(g.prefix + '/')) {
      const hit = exceptionsOf(u.sub).find((e) => e.perm === g.perm && e.effect === 'deny');
      return { perm: g.perm, reason: hit && hit.reason ? hit.reason : '该权限已按岗位复核结果收回' };
    }
  }
  return null;
}

/** 某权限点被哪些角色拥有（用于报告/页面说明） */
function rolesWithPerm(perm) {
  return (PERMS[perm] || []).slice();
}

// ---------------- 例外维护 ----------------

function setException({ userId, perm, effect, reason, operator }) {
  if (!userId) throw new Error('缺少用户');
  if (!PERMS[perm]) throw new Error('权限点不存在：' + perm);
  if (!['deny', 'allow'].includes(effect)) throw new Error('effect 只能是 deny / allow');
  if (!reason || !String(reason).trim()) {
    // 复核要能解释「为什么」—— 没理由的收回，半年后就没人知道原因了
    throw new Error('必须填写理由（复核时要能解释这条调整）');
  }
  const user = db.prepare('SELECT id, role, name FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');
  if (user.role === 'admin') throw new Error('系统管理员恒通过，不需要设置例外');

  const exists = db.prepare('SELECT id FROM access_exceptions WHERE user_id = ? AND perm = ?').get(userId, perm);
  if (exists) {
    db.prepare('UPDATE access_exceptions SET effect=?, reason=?, created_by=?, created_at=? WHERE id=?')
      .run(effect, String(reason).trim(), operator || '', now(), exists.id);
  } else {
    db.prepare(
      'INSERT INTO access_exceptions (user_id, perm, effect, reason, created_by, created_at) VALUES (?,?,?,?,?,?)'
    ).run(userId, perm, effect, String(reason).trim(), operator || '', now());
  }
  clearCache(userId);
  return db.prepare('SELECT * FROM access_exceptions WHERE user_id = ? AND perm = ?').get(userId, perm);
}

function removeException(id) {
  const row = db.prepare('SELECT * FROM access_exceptions WHERE id = ?').get(id);
  if (!row) throw new Error('例外不存在');
  db.prepare('DELETE FROM access_exceptions WHERE id = ?').run(id);
  clearCache(row.user_id);
  return { id: Number(id) };
}

/** 设置附加岗（多岗） */
function setExtraRoles({ userId, roles, operator }) {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');
  const list = [...new Set((roles || []).filter((r) => ROLES.includes(r) && r !== user.role && r !== 'admin'))];
  list.forEach((r) => {
    const dup = db.prepare('SELECT id FROM user_roles WHERE user_id = ? AND role = ?').get(userId, r);
    if (!dup) {
      db.prepare('INSERT INTO user_roles (user_id, role, granted_by, created_at) VALUES (?,?,?,?)')
        .run(userId, r, operator || '', now());
    }
  });
  // 删掉不再要的
  const keep = new Set(list);
  db.prepare('SELECT id, role FROM user_roles WHERE user_id = ?').all(userId).forEach((r) => {
    if (!keep.has(r.role)) db.prepare('DELETE FROM user_roles WHERE id = ?').run(r.id);
  });
  clearCache(userId);
  return db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId).map((r) => r.role);
}

// ---------------- 职责分离 ----------------

/**
 * 扫描全部在用账号的职责分离冲突
 * @returns {{rule:object, users:object[], hit:boolean}[]}
 */
function sodConflicts() {
  const users = db.prepare('SELECT id, username, name, role, active FROM users WHERE active = 1 ORDER BY id').all();
  const effMap = {};
  users.forEach((u) => { effMap[u.id] = effective(u.id, u.role); });

  return SOD_RULES.map((rule) => {
    const holdersA = users.filter((u) => effMap[u.id].isAdmin || effMap[u.id].perms.includes(rule.perm_a));
    const holdersB = users.filter((u) => effMap[u.id].isAdmin || effMap[u.id].perms.includes(rule.perm_b));
    const both = holdersA.filter((a) => holdersB.some((b) => b.id === a.id));
    // 系统管理员恒通过，必然「全中」。把它单独标出来，不让它把 10 条规则全染红，
    // 否则真正需要关注的岗位冲突会被淹没。
    const bothReal = both.filter((u) => u.role !== 'admin');
    return {
      rule,
      holders_a: holdersA.length,
      holders_b: holdersB.length,
      users: bothReal.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role })),
      admin_holds: both.some((u) => u.role === 'admin'),
      hit: bothReal.length > 0
    };
  });
}

// ---------------- 复核视图 ----------------

function nextReviewNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const prefix = 'RV' + day;
  const row = db.prepare(
    "SELECT review_no FROM access_reviews WHERE review_no LIKE ? ORDER BY review_no DESC LIMIT 1"
  ).get(prefix + '%');
  let seq = 1;
  if (row) {
    const n = parseInt(String(row.review_no).slice(prefix.length), 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return prefix + p(seq);
}

/**
 * 复核页要的全部数据：用户 × 生效权限 + 例外 + 多岗 + 冲突
 */
function reviewMatrix() {
  const users = db.prepare('SELECT id, username, name, role, department_id, active FROM users ORDER BY id').all();
  const rows = users.map((u) => {
    const eff = effective(u.id, u.role);
    const exc = exceptionsOf(u.id);
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      role_label: ROLE_LABELS[u.role] || u.role,
      department_id: u.department_id,
      active: u.active,
      roles: eff.roles,
      base: eff.base,
      deny: eff.deny,
      allow: eff.allow,
      perms: eff.perms,
      exceptions: exc,
      isAdmin: eff.isAdmin
    };
  });
  const sod = sodConflicts();
  return {
    roles: ROLES.map((r) => ({ code: r, label: ROLE_LABELS[r], perms: permsOfRole(r), perm_count: permsOfRole(r).length })),
    perms: Object.keys(PERMS).map((p) => ({ perm: p, roles: PERMS[p], guarded: GUARDED.some((g) => g.perm === p) })),
    users: rows,
    sod,
    summary: {
      users: rows.length,
      active: rows.filter((r) => r.active).length,
      perms: Object.keys(PERMS).length,
      exceptions: rows.reduce((s, r) => s + r.exceptions.length, 0),
      conflicts: sod.filter((s) => s.hit).length,
      conflict_users: [...new Set(sod.flatMap((s) => s.users.map((u) => u.id)))].length
    }
  };
}

/** 记录一次复核（签字留痕） */
function signOff({ period, scope, operator, signedOffBy, note }) {
  const m = reviewMatrix();
  const no = nextReviewNo();
  const changes = m.users
    .filter((u) => u.exceptions.length)
    .map((u) => ({ user: u.username, exceptions: u.exceptions }));

  db.prepare(
    `INSERT INTO access_reviews
     (review_no, period, scope, users_total, perms_total, exceptions_count, conflicts_count, changes,
      signed_off_by, signed_off_at, note, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    no, period || '', scope || '全部在册账号',
    m.summary.users, m.summary.perms, m.summary.exceptions, m.summary.conflicts,
    JSON.stringify(changes),
    signedOffBy || '', signedOffBy ? now() : '',
    note || '', operator || '', now()
  );
  return db.prepare('SELECT * FROM access_reviews WHERE review_no = ?').get(no);
}

function listReviews() {
  return db.prepare('SELECT * FROM access_reviews ORDER BY id DESC').all();
}

/**
 * 某用户属于哪个法人主体（`company_id`）
 *
 * 走 20 秒缓存：每个请求都要用，但主体几乎不变；
 * 改了归属最多 20 秒生效，比"重启才生效"好，也比"每请求一次查询"省。
 */
function companyOf(userId) {
  const key = 'c' + userId;
  return cached(key, () => {
    try {
      const r = db.prepare('SELECT company_id FROM users WHERE id = ?').get(userId);
      return r && r.company_id ? Number(r.company_id) : null;
    } catch (e) { return null; }
  });
}

module.exports = {
  ROLES, ROLE_LABELS, PERMS, SOD_RULES, GUARDED, WRITE_METHODS,
  allPerms, rolesWithPerm,
  rolesOf, effective, hasPerm, matchDeny, companyOf,
  setException, removeException, setExtraRoles,
  sodConflicts, reviewMatrix, signOff, listReviews,
  clearCache
};
