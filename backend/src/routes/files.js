/**
 * 私有附件下载（唯一入口）
 * ============================================================
 * GET  /api/files/att/:name        下载一个私有附件
 * POST /api/files/signed-url       换一条带过期时间的签名链接
 *
 * ## 为什么需要这个文件
 *
 * 附件（PDF / Word / Excel / zip / txt）里可能有报价、合同、成本表。
 * 早期它们和图片一起落在 `data/uploads`，而那个目录由 `/uploads` **整目录匿名托管** ——
 * 也就是说"给上传附件生成签名链接"这件事从来就没成立过：
 * 链接带不带签名，文件都在公网上，拿到地址就能下。
 *
 * 现在附件落在 `data/uploads/private/`，静态托管对 `private/` 一律 404，
 * 唯一的入口就是这里。两种放行方式：
 *
 *   1. **登录态**（`Authorization: Bearer`）—— 页面里点附件走这条；
 *   2. **短期签名**（`?expires=&sig=`）—— 发给外部（客户/供应商）的链接走这条，
 *      过期即失效，`sig` 用 `JWT_SECRET` 做 HMAC，改一个字都验不过。
 *
 * ## 权限不只是"登录"
 *
 * 如果这个文件被 `attachments` 表引用着、且挂在某张订单上，就按**订单归属**再判一次：
 * 同集团的别家主体不该因为"猜到一个文件名"读到别的分部的技术资料。
 * 文件名是 20 位随机十六进制，猜不到 —— 但"猜不到"不能当权限用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { db } = require('../db');
const { ok, fail } = require('../utils/http');
const { authRequired } = require('../middleware/auth');
const access = require('../services/access');
const CS = require('../access/companyScope');
const { PRIVATE_DIR } = require('./upload');

const router = express.Router();

/** 文件名只允许 20 位 hex + 白名单扩展名（服务端生成的格式，别的一律当非法） */
const NAME_RE = /^[0-9a-f]{16,40}\.(png|jpg|jpeg|webp|gif|pdf|doc|docx|xls|xlsx|zip|txt)$/i;

/** 文件名形态校验（不合规 → 400，与"文件不存在"分开） */
function validName(name) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return false;
  // 正则已经排除了 / 与 .. ，这里再用 basename 兜一次
  return path.basename(n) === n;
}

/** 存在的私有文件绝对路径；不存在返回 null */
function safePath(name) {
  const n = String(name || '');
  if (!validName(n)) return null;
  const full = path.join(PRIVATE_DIR, n);
  if (!full.startsWith(PRIVATE_DIR)) return null;
  return fs.existsSync(full) ? full : null;
}

function sign(name, expires) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`${name}:${expires}`).digest('hex').slice(0, 32);
}

function verifySig(name, expires, sig) {
  if (!expires || Number(expires) < Date.now()) return false;
  const want = sign(name, expires);
  const a = Buffer.from(String(sig || ''), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 尽力识别调用者：带 token 就验一遍（含"是否停用 / 角色 / 会话版本"）
 *
 * 这里不复用 `authRequired`：那个中间件在没 token 时直接 401，
 * 而本接口要允许"无 token 但签名有效"的外部访问。所以自己验一次，
 * 校验口径与中间件保持一致（否则会出现"页面能进、附件 401"或反之）。
 */
function userFromReq(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.jwtSecret);
    if (p.scope === 'customer') return null; // 客户 token 不认（附件是员工侧资产）
    const sess = access.sessionOf(p.sub);
    if (!sess || !Number(sess.active)) return null;
    if ((Number(p.tv) || 0) !== (Number(sess.token_version) || 0)) return null;
    return { ...p, role: sess.role, company_id: access.companyOf(p.sub) };
  } catch (e) {
    return null;
  }
}

/** 这个附件挂在哪张订单上？（attachments 表按 url 反查） */
function orderRefOf(url) {
  return db.prepare(
    "SELECT target_type, target_id FROM attachments WHERE url = ? AND target_type = 'order' LIMIT 1"
  ).get(url) || null;
}

function canAccessFile(user, name) {
  const ref = orderRefOf('/api/files/att/' + name);
  return !ref || CS.assertOrder(user, ref.target_id).ok;
}

/**
 * 下载
 *
 * 放行条件：签名有效 **或** 登录态有效；若文件挂在订单上，登录态这一路还要过订单归属。
 * 签名这一路不再查归属 —— 签名本身就是"某个有权限的人刚刚授权过"的凭据（且会过期）。
 */
function downloadHandler(req, res) {
  const name = String(req.params.name || '');
  // 先判形态（400）、再判授权（401）、最后才判存在（404）——
  // 顺序反了就等于给匿名请求一个"这个文件在不在"的探针
  if (!validName(name)) return fail(res, 400, '文件名不合法');

  const bySig = verifySig(name, req.query.expires, req.query.sig);
  if (!bySig) {
    const user = userFromReq(req);
    if (!user) return fail(res, 401, '请先登录，或使用带有效签名的下载链接');
    if (!canAccessFile(user, name)) return fail(res, 404, '文件不存在');
  }

  const full = safePath(name);
  if (!full) return fail(res, 404, '文件不存在');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.download(full, name);
}

router.get('/att/:name', downloadHandler);

/**
 * 换签名链接
 *
 * `ttl` 上限 24 小时：签名链接一旦发出去就收不回来（除非换 JWT_SECRET，
 * 而那会把所有人踢下线）。所以给一个"够用但不长"的上限，并写清提示。
 */
function signedUrlHandler(req, res) {
  const name = String((req.body && req.body.name) || '').replace(/^\/api\/files\/att\//, '');
  if (!validName(name)) return fail(res, 400, '文件名不合法');
  const user = userFromReq(req);
  if (!user) return fail(res, 401, '请先登录');
  if (!canAccessFile(user, name)) return fail(res, 404, '文件不存在');
  if (!safePath(name)) return fail(res, 404, '文件不存在');
  const ttl = Math.min(Number((req.body && req.body.ttl) || 600), 86400);
  const expires = Date.now() + ttl * 1000;
  const sig = sign(name, expires);
  return ok(res, {
    url: `/api/files/att/${encodeURIComponent(name)}?expires=${expires}&sig=${sig}`,
    expires_at: new Date(expires).toISOString(),
    ttl_seconds: ttl,
    note: '链接到期后自动失效；重新获取需再次登录授权'
  });
}

/** 登录用户才能签发（签发 = 授权，不能匿名） */
router.post('/signed-url', authRequired, signedUrlHandler);

module.exports = router;
module.exports.downloadHandler = downloadHandler;
module.exports.signedUrlHandler = signedUrlHandler;
module.exports.PRIVATE_DIR = PRIVATE_DIR;
module.exports.NAME_RE = NAME_RE;
