/**
 * 统一配置读取（从 .env 载入，提供默认值）
 */
require('dotenv').config();
const path = require('path');

// backend/ 根目录
const ROOT = path.resolve(__dirname, '..');

function resolveDbPath(p) {
  const raw = p || './data/erp-mindmap.db';
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev_only_insecure_secret_change_me',
  tokenExpiresIn: process.env.TOKEN_EXPIRES_IN || '12h',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123456',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  dbPath: resolveDbPath(process.env.DB_PATH),
  exchangeRate: Number(process.env.EXCHANGE_RATE) || 6.5, // 美元->人民币 固定汇率
  isProd: process.env.NODE_ENV === 'production'
};
