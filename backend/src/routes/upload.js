/**
 * 图片上传（款图 / 色卡）
 * POST /api/upload  { dataUrl: "data:image/png;base64,..." }  -> { url: "/uploads/xxx.png" }
 * 文件保存到 backend/data/uploads，通过 /uploads 静态访问
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
const DIR = path.resolve(__dirname, '../../data/uploads');
fs.mkdirSync(DIR, { recursive: true });

const MAX = 3 * 1024 * 1024; // 3MB

router.post('/', authRequired, wrap(async (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return fail(res, 400, '仅支持 png/jpg/webp/gif 的 base64 图片');
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) return fail(res, 400, '图片为空');
  if (buf.length > MAX) return fail(res, 400, '图片不能超过 3MB');
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DIR, name), buf);
  return ok(res, { url: '/uploads/' + name });
}));

// 通用文件（PDF / 图片 / Office / zip），上限 10MB
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

router.post('/file', authRequired, wrap(async (req, res) => {
  const { dataUrl, filename } = req.body || {};
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return fail(res, 400, '文件格式不正确');
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return fail(res, 400, '文件为空');
  if (buf.length > 10 * 1024 * 1024) return fail(res, 400, '文件不能超过 10MB');
  let ext = EXT_MAP[mime];
  if (!ext) {
    const guess = String(filename || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    ext = guess || 'bin';
  }
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DIR, name), buf);
  return ok(res, { url: '/uploads/' + name, filename: filename || name, size: buf.length, mime });
}));

module.exports = router;
module.exports.UPLOAD_DIR = DIR;
