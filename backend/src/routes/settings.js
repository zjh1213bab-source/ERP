/**
 * 系统设置（汇率等）
 * GET  /api/settings        登录可读
 * PUT  /api/settings        管理员保存
 */
const os = require('os');
const express = require('express');
const config = require('../config');
const { getSettings, saveSettings } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, wrap(async (req, res) => ok(res, getSettings())));

/**
 * 局域网访问地址（登录即可读）
 *
 * 为什么需要：单据上的二维码是「扫码直达链接」。如果管理员是用 127.0.0.1 打开页面打印的，
 * 二维码里就会是 127.0.0.1 —— 手机扫了打不开（指向手机自己）。
 * 所以前端生成二维码时优先用这里的局域网 IP。
 */
router.get('/lan', authRequired, wrap(async (req, res) => {
  const ips = [];
  Object.values(os.networkInterfaces()).forEach((list) => {
    (list || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    });
  });
  const port = config.port;
  return ok(res, {
    port,
    ips,
    urls: ips.map((ip) => `http://${ip}:${port}`),
    hostname: os.hostname()
  });
}));

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
