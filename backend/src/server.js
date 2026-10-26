/**
 * 跳色科技公司 ERP 系统 —— 后端入口
 * Express + SQLite(better-sqlite3 / node:sqlite) + JWT
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('./config');
require('./db'); // 初始化数据库 + 建表 + 播种

const authRoutes = require('./routes/auth');
const mindmapRoutes = require('./routes/mindmap'); // 业务蓝图（原脑图）
const customerRoutes = require('./routes/customers');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const techpackRoutes = require('./routes/techpacks');
const costRoutes = require('./routes/costs');
const sampleRoutes = require('./routes/samples');
const settingsRoutes = require('./routes/settings');
const materialRoutes = require('./routes/materials');
const craftRoutes = require('./routes/crafts');
const orderMaterialRoutes = require('./routes/orderMaterials');
const sizeTemplateRoutes = require('./routes/sizeTemplates');
const orderNodeRoutes = require('./routes/orderNodes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

// ---------- CORS ----------
const corsOrigin =
  config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim());
app.use(cors({ origin: corsOrigin, credentials: false }));

// ---------- 访问日志 ----------
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()}  ${req.method} ${req.originalUrl}  ${res.statusCode}  ${Date.now() - start}ms`
    );
  });
  next();
});

// ---------- 基础 ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'erp-system', uptime: process.uptime() });
});

// ---------- 业务路由 ----------
app.use('/api/auth', authRoutes);
app.use('/api/mindmap', mindmapRoutes); // 业务蓝图
app.use('/api/blueprint', mindmapRoutes); // 别名
app.use('/api/customers', customerRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/techpacks', techpackRoutes);
app.use('/api/costs', costRoutes);
app.use('/api/samples', sampleRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/crafts', craftRoutes);
app.use('/api/order-materials', orderMaterialRoutes);
app.use('/api/size-templates', sizeTemplateRoutes);
app.use('/api/order-nodes', orderNodeRoutes);

// ---------- 前端 dist 托管（单机部署 / 局域网预览） ----------
const distDir = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log('[erp] 检测到前端 dist，已启用静态托管');
}

// ---------- 接口 404 ----------
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, message: '接口不存在' });
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ ok: false, message: err.message || '服务器内部错误' });
});

app.listen(config.port, () => {
  console.log('\n========================================');
  console.log('  跳色科技 ERP 系统 后端已启动');
  console.log(`  地址:     http://127.0.0.1:${config.port}`);
  console.log(`  健康检查: http://127.0.0.1:${config.port}/api/health`);
  console.log(`  管理员:   ${config.adminUsername}`);
  console.log('========================================\n');
});
