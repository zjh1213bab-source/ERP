/**
 * 系统设置（汇率等）
 * GET  /api/settings        登录可读
 * PUT  /api/settings        管理员保存
 */
const express = require('express');
const { getSettings, saveSettings } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, wrap(async (req, res) => ok(res, getSettings())));

router.put('/', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.exchangeRate !== undefined) {
    const rate = Number(b.exchangeRate);
    if (!(rate > 0)) return fail(res, 400, '汇率必须为正数');
    patch.exchangeRate = rate;
  }
  return ok(res, saveSettings(patch));
}));

module.exports = router;
