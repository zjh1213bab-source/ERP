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

/** 只接受这些类型；扩展名由它决定，客户端传什么都不影响 */
const EXT_MAP = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
  'text/plain': 'txt'
};

const startsWith = (buf, bytes) => buf.length >= bytes.length && buf.slice(0, bytes.length).equals(Buffer.from(bytes));

/**
 * 文件头校验：内容与声明的类型必须对得上
 *
 * 按"家族"分三类，因为 Office 与 zip 共用 `PK\x03\x04`、doc 与 xls 共用 OLE 头 ——
 * 想精确到具体 Office 子类型需要解包（成本不值得），
 * 而这三类的风险等级相同（都是二进制文档，不会在浏览器里执行脚本）。
 */
const SIG = {
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),            // %PDF-
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),                         // GIF8
  'image/webp': (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF'
    && b.slice(8, 12).toString('latin1') === 'WEBP',
  // zip 家族：普通 zip / 空档 / 分卷，三种本地文件头都算
  'zip': (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b
    && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  // OLE 复合文档（老版 doc / xls）
  'ole': (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
};

/** mime → 用哪个签名家族校验 */
const FAMILY = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/msword': 'ole',
  'application/vnd.ms-excel': 'ole'
};

/**
 * 纯文本检查：不允许出现明显是二进制的内容
 *
 * `text/plain` 没有固定文件头，所以反过来判 —— 出现 NUL 字节或大量非可打印字符
 * 就当成"不是文本"。这不追求严格（文本本来就没有魔数），
 * 目的只是不让 `text/plain` 成为绕过类型检查的后门。
 */
function looksLikeText(buf) {
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i += 1) {
    const c = buf[i];
    if (c === 0) return false;
    // 允许 \t \n \r 与 ASCII 可打印，以及 UTF-8 多字节（>= 0x80）
    if (c < 0x09 || (c > 0x0d && c < 0x20)) bad += 1;
  }
  return bad / Math.max(n, 1) < 0.02;
}

const EXT_WHITELIST = new Set(Object.values(EXT_MAP).concat(['jpeg']));

/** 图片上传（款图 / 色卡）：只走图片类型，走不了通用通道 */
router.post('/', authRequired, wrap(async (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return fail(res, 400, '仅支持 png/jpg/webp/gif 的 base64 图片');
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) return fail(res, 400, '图片为空');
  if (buf.length > MAX_IMG) return fail(res, 400, '图片不能超过 3MB');

  const mime = 'image/' + m[2].toLowerCase().replace('jpg', 'jpeg');
  const fam = FAMILY[mime];
  if (!fam || !SIG[fam](buf)) return fail(res, 400, '图片内容与声明的类型不符（不是有效的图片文件）');

  const ext = EXT_MAP[mime] || 'png';
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DIR, name), buf);
  return ok(res, { url: '/uploads/' + name });
}));

/** 通用文件（PDF / 图片 / Office / zip / txt），上限 10MB */
router.post('/file', authRequired, wrap(async (req, res) => {
  const { dataUrl, filename } = req.body || {};
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return fail(res, 400, '文件格式不正确');
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return fail(res, 400, '文件为空');
  if (buf.length > MAX_FILE) return fail(res, 400, '文件不能超过 10MB');

  /**
   * 未知 MIME 直接拒绝 —— 不再"从文件名猜扩展名"
   *
   * 这是整条加固的关键一步。只要还允许"猜"，客户端就能通过
   * `filename: 'x.html'` 把任意内容落成 .html，而 `/uploads` 是同源静态目录。
   */
  const ext = EXT_MAP[mime];
  if (!ext || !EXT_WHITELIST.has(ext)) {
    return fail(res, 400, '不支持的文件类型。允许：PDF / Word / Excel / 图片(png/jpg/webp/gif) / zip / txt');
  }

  // 内容校验：二进制类型验文件头，纯文本验"看起来像文本"
  if (mime === 'text/plain') {
    if (!looksLikeText(buf)) return fail(res, 400, '文件内容不是纯文本');
  } else {
    const fam = FAMILY[mime];
    if (!fam || !SIG[fam](buf)) {
      return fail(res, 400, '文件内容与声明的类型不符（扩展名与实际格式不一致）');
    }
  }

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
