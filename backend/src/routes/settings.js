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
const scope = require('../access/companyScope');

const router = express.Router();
const wageMultiplier=require('../services/wageMultiplier');
router.get('/piece-multipliers',authRequired,requireRole(['admin','hr','finance','production']),wrap(async(req,res)=>ok(res,wageMultiplier.view())));
router.put('/piece-multipliers',authRequired,requireRole(['admin']),wrap(async(req,res)=>ok(res,wageMultiplier.save(req.body,req.user))));
const appearance=require('../services/appearance');
// 装饰性外观可由所有已登录员工读取；只有管理员能发布全站修改。
router.get('/appearance',authRequired,wrap(async(req,res)=>ok(res,appearance.readAppearance())));
router.put('/appearance',authRequired,requireRole(['admin']),wrap(async(req,res)=>ok(res,appearance.saveAppearance(req.body,req.user))));

/**
 * 系统设置（汇率等）
 *
 * 额外带两个**只读派生值**（不写进 app_config，否则 env 改了也不生效）：
 *   - single_company：是否单公司模式 —— 前端据此隐藏「集团管理」入口与公司筛选；
 *   - company_header：唯一公司抬头 —— 单据、报表、打印都用它。
 *
 * 为什么不让前端自己判断：模式是后端配置（env），前端猜错就会漏出多主体入口，
 * 或者在一家公司的库上显示一堆空的分部筛选。
 */
router.get('/', authRequired, wrap(async (req, res) => ok(res, {
  ...getSettings(),
  single_company: scope.isSingle(),
  company_header: scope.header()
})));

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
  /**
   * 注意：这里只按**白名单**挑字段存（目前只有 exchangeRate）。
   * GET 附加的 `single_company` / `company_header` 是配置的投影，不是设置项 ——
   * 一旦被写进 app_config，下次 env 改了也会被旧值盖住，而没人会想到去查这张表。
   */
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
