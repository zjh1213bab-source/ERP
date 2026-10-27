/**
 * 系统管理：数据库备份下载（仅管理员）
 * GET /api/admin/backup -> 下载当前 SQLite 数据库快照（用 VACUUM INTO 保证 WAL 数据一致）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const config = require('../config');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/backup', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = path.join(os.tmpdir(), `erp-backup-${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/\\/g, '/')}'`);
  } catch (e) {
    // 兜底：直接复制文件（WAL 可能有少量未合并数据）
    try {
      fs.copyFileSync(config.dbPath, tmp);
    } catch (e2) {
      return fail(res, 500, '生成备份失败：' + e2.message);
    }
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="erp-backup-${stamp}.db"`);
  const stream = fs.createReadStream(tmp);
  stream.pipe(res);
  stream.on('close', () => { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });
}));

/**
 * 上传备份用于恢复（重启后生效）
 * POST /api/admin/restore { dataUrl | base64 }
 */
router.post('/restore', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const b = req.body || {};
  const b64 = b.base64 || String(b.dataUrl || '').replace(/^data:.*;base64,/, '');
  if (!b64) return fail(res, 400, '缺少文件内容');
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (e) {
    return fail(res, 400, '文件内容不合法');
  }
  if (buf.length < 100) return fail(res, 400, '文件过小，不像是有效数据库');
  if (buf.length > 50 * 1024 * 1024) return fail(res, 400, '文件不能超过 50MB');
  if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    return fail(res, 400, '不是有效的 SQLite 数据库文件');
  }
  const pending = path.join(path.dirname(config.dbPath), 'restore-pending.db');
  fs.writeFileSync(pending, buf);
  return ok(res, { message: '已接收备份。请重启后端服务（如 pm2 restart）后生效。' });
}));

module.exports = router;
