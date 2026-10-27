/**
 * 备份与恢复（仅管理员）
 * ============================================================
 * GET    /api/backup/overview                备份健康 + 磁盘占用 + 待恢复状态
 * POST   /api/backup/create                  立即在服务端生成一份备份
 * GET    /api/backup/list?kind=              备份历史
 * GET    /api/backup/:id/download            下载某份备份
 * POST   /api/backup/:id/verify              重新校验（文件可能已损坏）
 * DELETE /api/backup/:id                     删除备份
 * POST   /api/backup/restore/prepare         从已有备份准备恢复 { backup_id }
 * POST   /api/backup/restore/upload          上传文件准备恢复（raw binary）
 * POST   /api/backup/restore/rollback        撤销待恢复（重启前反悔）
 * GET    /api/backup/restore/pending         当前待恢复计划
 * GET    /api/backup/checks                  业务级校验（借贷平衡 / 库存一致）
 *
 * 恢复永远分两步：prepare 只是「摆好文件 + 校验 + 自动备份当前库」，
 * 真正换库在重启时由 db.js 调 backup-restore.applyPendingRestore() 完成。
 * 为什么不能在线换：SQLite 已打开的连接无法安全地换成另一个文件，
 * 硬换会导致一半请求读到旧库、一半读到新库。
 */
const express = require('express');
const fs = require('fs');

const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const B = require('../services/backup');
const BR = require('../services/backup-restore');

const router = express.Router();

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
  '/overview',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) =>
    ok(res, {
      health: B.backupHealth(),
      storage: B.storageInfo(),
      pending: B.pendingStatus(),
      recent: B.listJobs({ limit: 12 }),
      checks: B.businessChecks(),
      app_version: B.APP_VERSION
    })
  )
);

router.post(
  '/create',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const b = req.body || {};
    const job = B.createBackup({
      kind: 'manual',
      note: b.note || '',
      operator: req.user.username || req.user.name || ''
    });
    return ok(res, job);
  })
);

router.get(
  '/list',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => ok(res, B.listJobs({ kind: req.query.kind || '', limit: req.query.limit })))
);

router.get(
  '/:id/download',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const job = B.getJob(Number(req.params.id));
    if (!job) return fail(res, 404, '备份记录不存在');
    if (!job.file_path || !fs.existsSync(job.file_path)) return fail(res, 410, '备份文件已不在磁盘上');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${job.file_name}"`);
    const stream = fs.createReadStream(job.file_path);
    stream.pipe(res);
    stream.on('error', () => {
      try { res.end(); } catch (e) { /* ignore */ }
    });
  })
);

router.post(
  '/:id/verify',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => {
    const r = B.verifyJob(Number(req.params.id));
    return ok(res, r);
  })
);

router.delete(
  '/:id',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => ok(res, B.deleteJob(Number(req.params.id))))
);

router.post(
  '/restore/prepare',
  authRequired,
  requireRole(['admin']),
  guard((req, res) => {
    const b = req.body || {};
    if (!b.backup_id) throw new Error('请选择要恢复的备份');
    const r = B.prepareRestore({
      backupId: Number(b.backup_id),
      note: b.note || '',
      operator: req.user.username || req.user.name || ''
    });
    return ok(res, r);
  })
);

/**
 * 上传恢复：直接收二进制（不再走 base64）
 * 为什么改：11MB 的库 base64 后 15MB，撞上 express.json 的 8MB 上限直接 413；
 * 而且 base64 要在内存里多留一份。raw 上传不带膨胀，前端也不用 FileReader。
 */
router.post(
  '/restore/upload',
  authRequired,
  requireRole(['admin']),
  express.raw({ type: () => true, limit: '512mb' }),
  guard((req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1024) {
      throw new Error('没有收到文件内容（请用二进制方式上传 .db 文件）');
    }
    const r = B.prepareRestore({
      buffer: buf,
      note: (req.query.note || '').toString(),
      operator: req.user.username || req.user.name || ''
    });
    return ok(res, r);
  })
);

router.post(
  '/restore/rollback',
  authRequired,
  requireRole(['admin']),
  guard((req, res) =>
    ok(res, B.rollbackRestore({ operator: req.user.username || req.user.name || '' }))
  )
);

router.get(
  '/restore/pending',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => ok(res, B.pendingStatus()))
);

router.get(
  '/checks',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => ok(res, B.businessChecks()))
);

module.exports = router;
