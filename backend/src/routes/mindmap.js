/**
 * 脑图配置接口
 * GET  /api/mindmap        公开读取（访客 / 前端展示页）
 * PUT  /api/mindmap        管理员保存（需登录，Bearer Token）
 */
const express = require('express');

const requireAuth = require('../middleware/auth');
const { getMindmap, saveMindmap } = require('../db');

const router = express.Router();

// ---------- 公开：读取脑图 ----------
router.get('/', (req, res) => {
  const result = getMindmap();
  if (!result) {
    return res.status(404).json({ ok: false, message: '脑图配置尚未初始化' });
  }
  res.json({ ok: true, data: result.data, updatedAt: result.updatedAt });
});

// ---------- 管理员：保存脑图 ----------
router.put('/', requireAuth, (req, res) => {
  const data = req.body && req.body.data;

  // 基本结构校验：必须含 modules 数组，且每个模块有 id / title
  if (!data || typeof data !== 'object' || !Array.isArray(data.modules)) {
    return res.status(400).json({ ok: false, message: '数据格式不合法：需包含 modules 数组' });
  }
  const invalid = data.modules.find(
    (m) => m == null || typeof m !== 'object' || m.id == null || typeof m.title !== 'string'
  );
  if (invalid) {
    return res.status(400).json({ ok: false, message: '存在不合法的模块节点（需包含 id 与 title）' });
  }

  const updatedAt = saveMindmap(data);
  res.json({ ok: true, updatedAt });
});

module.exports = router;
