/**
 * 文件上传（款图 / 色卡 / 通用附件）
 * POST /api/upload        { dataUrl: "data:image/png;base64,..." }  -> { url: "/uploads/xxx.png" }
 * POST /api/upload/file   { dataUrl, filename }                     -> { url, filename, size, mime }
 *
 * 文件保存到 backend/data/uploads，通过 `/uploads` 提供访问
 * （静态托管的加固在 `server.js`：扩展名白名单 + nosniff + CSP sandbox + 非图片强制下载）。
 *
 * ## 这里防的是什么
 *
 * 1. **不能只认 MIME**。`data:image/png;base64,...` 里的 mime 是客户端自己写的字符串，
 *    改一下就能传任意内容。所以每个类型都验一遍**文件头**（magic number）：
 *    PNG 必须是 `89 50 4E 47…`、PDF 必须是 `%PDF-`、zip 家族必须是 `PK\x03\x04`……
 *    验不过就拒，不做"猜它想传什么"的补救。
 *
 * 2. **扩展名只能由 MIME 决定，不能由客户端文件名决定**。
 *    原来未知类型会从 `filename` 里抠扩展名（`evil.HTML` → `html`）——
 *    再配合 `/uploads` 的同源静态托管，就是一个**同源存储型 XSS**：
 *    上传的 HTML 在 ERP 域下执行，能读 localStorage 里的 token。
 *
 * 3. **不接受活动内容**。html / svg / js / swf / hta 一律不在白名单内，
 *    即使客户端声称是 `text/plain` 也会因为文件头/内容检查被拒。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

/**
 * 存储布局：**一公开一私有，物理分开**
 * ============================================================
 * ```
 * data/uploads/            公开区：只有图片（款图 / 色卡 / 现场照片），匿名可看
 *   photos/2026-10-01/…     由 services/photos.js 写入
 * data/uploads/private/     私有区：PDF / Office / zip / txt 等附件，**静态一律 404**
 * ```
 * ## 为什么要分开
 *
 * 之前所有上传都落同一个目录，而这个目录被 `/uploads` 整目录匿名托管。
 * 于是"签名下载"这件事在逻辑上是不成立的：链接带不带签名，文件都在公网上，
 * 拿到 `/uploads/xxx.pdf` 的人直接访问就行。把附件挪到 `private/` 之后，
 * 唯一的入口就是 `GET /api/files/att/:name`（登录 + 归属校验，或短期签名）。
 *
 * ## 公开区为什么只留图片
 *
 * 图片要在 `<img>` 里直接引用（全站上百处），走鉴权下载不现实，而图片本身不执行脚本；
 * 加 `nosniff` + `CSP sandbox` 之后风险边界是清楚的。PDF/Office/zip 不同 ——
 * 它们可能带客户报价、合同、成本表，属于"私有附件"，必须走鉴权。
 */
const DIR = path.resolve(__dirname, '../../data/uploads');
const PRIVATE_DIR = path.join(DIR, 'private');
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

/**
 * 一次性归位：把历史遗留在公开区的非图片文件挪进 private/
 *
 * 早期版本所有类型都写公开区（`/uploads/xxx.pdf`）。现在公开区只放图片，
 * 那些文件会变成"链接还在、文件也还在、就是不该在公网上"。
 * 这里搬走并打日志；**库里的引用不改**（都是图片；若真有非图片被引用，
 * 应从日志里人工确认后再改，而不是让脚本猜着改 JSON）。
 */
function migrateLegacyPrivateFiles() {
  let moved = 0;
  try {
    const names = fs.readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const keepExt = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
    names.forEach((name) => {
      const ext = path.extname(name).slice(1).toLowerCase();
      if (keepExt.has(ext)) return;
      try {
        fs.renameSync(path.join(DIR, name), path.join(PRIVATE_DIR, name));
        moved += 1;
      } catch (e) { /* 单文件失败不影响启动 */ }
    });
  } catch (e) { /* 目录读不了就跳过 */ }
  if (moved) {
    console.log(`[upload] 已把 ${moved} 个历史非图片文件从公开区移到 private/（公开区只留图片）`);
  }
}
migrateLegacyPrivateFiles();

const MAX_IMG = 3 * 1024 * 1024;   // 3MB
const MAX_FILE = 10 * 1024 * 1024; // 10MB

const { EXT_MAP, validateContent, decodeFile } = require('../services/uploadContent');

/** 图片上传（款图 / 色卡）：只走图片类型，走不了通用通道 */
router.post('/', authRequired, wrap(async (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return fail(res, 400, '仅支持 png/jpg/webp/gif 的 base64 图片');
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) return fail(res, 400, '图片为空');
  if (buf.length > MAX_IMG) return fail(res, 400, '图片不能超过 3MB');

  const mime = 'image/' + m[2].toLowerCase().replace('jpg', 'jpeg');
  validateContent(buf, mime);

  const ext = EXT_MAP[mime] || 'png';
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DIR, name), buf);
  return ok(res, { url: '/uploads/' + name });
}));

/** 通用文件（PDF / 图片 / Office / zip / txt），上限 10MB */
router.post('/file', authRequired, wrap(async (req, res) => {
  const { dataUrl, filename } = req.body || {};
  const { buf, mime, ext } = decodeFile(dataUrl, { maxBytes: MAX_FILE });

  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  /**
   * 图片 → 公开区（要在 `<img>` 里直接引用）；其余 → 私有区（走鉴权下载）
   *
   * 这条分流是按**内容类型**分的，不是按调用方：同一个 `/api/upload/file`，
   * 传截图存公开区、传报价单存私有区。调用方不需要知道这件事，
   * 但拿到的 `url` 会告诉他该用 `<img>` 还是走 `api.download()`。
   */
  const isImage = mime.startsWith('image/') && module.exports.SAFE_EXTS.has(ext);
  if (isImage) {
    fs.writeFileSync(path.join(DIR, name), buf);
    return ok(res, { url: '/uploads/' + name, name, filename: filename || name, size: buf.length, mime, private: false });
  }
  fs.writeFileSync(path.join(PRIVATE_DIR, name), buf);
  return ok(res, {
    url: '/api/files/att/' + name,
    name,
    filename: filename || name,
    size: buf.length,
    mime,
    private: true
  });
}));

module.exports = router;
module.exports.UPLOAD_DIR = DIR;
module.exports.PRIVATE_DIR = PRIVATE_DIR;
/** 给 server.js 的静态托管用：公开区只放图片 */
module.exports.SAFE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
/** 可以内联展示的类型（其余一律 attachment，不在浏览器里"打开"） */
module.exports.INLINE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
