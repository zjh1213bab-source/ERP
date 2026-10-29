/**
 * 统一配置读取（从 .env 载入，提供默认值）
 *
 * ## 默认值为什么必须被"检查"而不是"信任"
 *
 * 这里每个默认值都是为了让**开发机拿到就能跑**：示例 JWT 密钥、admin/admin123456、
 * CORS 通配。这些值一旦跟着交付包装到生产，等于把后台大门敞开
 * （示例密钥 = 谁都能自己签一个管理员 token）。
 *
 * 所以默认值要靠两道闸门兜：
 *   1. `securityAudit()` —— 启动时算一遍，生产环境有 fatal 项直接拒绝启动（server.js 执行）；
 *   2. 上线清单 `CHECKS.secret_changed` / `CHECKS.default_pwd` / `CHECKS.cors_origin`。
 * 只做第 2 道不够：清单要有人主动去点，而"能起来"这件事没人会主动怀疑。
 */
require('dotenv').config();
const path = require('path');

// backend/ 根目录
const ROOT = path.resolve(__dirname, '..');

function resolveDbPath(p) {
  const raw = p || './data/erp-mindmap.db';
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

/** 示例值：出现在生产配置里就是事故 */
const DEFAULT_JWT_SECRET = 'dev_only_insecure_secret_change_me';
const DEFAULT_ADMIN_PASSWORD = 'admin123456';

const cfg = {
  port: parseInt(process.env.PORT, 10) || 3000,
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  tokenExpiresIn: process.env.TOKEN_EXPIRES_IN || '12h',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  dbPath: resolveDbPath(process.env.DB_PATH),
  exchangeRate: Number(process.env.EXCHANGE_RATE) || 6.5, // 美元->人民币 固定汇率
  isProd: process.env.NODE_ENV === 'production',
  DEFAULT_JWT_SECRET,
  DEFAULT_ADMIN_PASSWORD
};

/**
 * 配置自检：返回 [{ key, level, msg }]
 *   level = 'fatal' 生产环境出现即拒绝启动
 *   level = 'warn'  只提示，不影响启动
 */
cfg.securityAudit = function securityAudit() {
  const issues = [];
  const secret = String(process.env.JWT_SECRET || '');
  if (!secret) {
    issues.push({ key: 'JWT_SECRET', level: 'fatal', msg: 'JWT_SECRET 未设置，正在用示例密钥 —— 任何人都能伪造管理员 token（生成：openssl rand -hex 32）' });
  } else if (secret === DEFAULT_JWT_SECRET) {
    issues.push({ key: 'JWT_SECRET', level: 'fatal', msg: 'JWT_SECRET 仍是示例值，等于公开了签发密钥' });
  } else if (secret.length < 32) {
    issues.push({ key: 'JWT_SECRET', level: 'warn', msg: `JWT_SECRET 只有 ${secret.length} 位，建议 32 位以上随机串` });
  }

  const pwd = String(process.env.ADMIN_PASSWORD || '');
  if (!pwd) {
    issues.push({ key: 'ADMIN_PASSWORD', level: 'fatal', msg: 'ADMIN_PASSWORD 未设置：首次初始化会建出 admin/admin123456' });
  } else if (pwd === DEFAULT_ADMIN_PASSWORD) {
    issues.push({ key: 'ADMIN_PASSWORD', level: 'fatal', msg: 'ADMIN_PASSWORD 仍是 admin123456' });
  }

  const cors = String(process.env.CORS_ORIGIN || '').trim();
  if (!cors || cors === '*') {
    issues.push({ key: 'CORS_ORIGIN', level: 'fatal', msg: 'CORS_ORIGIN 未设置或为 *：任何站点都能带 token 调接口（同域反代部署请设为本站域名）' });
  }

  if (!cfg.isProd) {
    issues.push({ key: 'NODE_ENV', level: 'warn', msg: `NODE_ENV=${process.env.NODE_ENV || '(未设置)'}；生产部署要设为 production，否则上面几条只会提示、不会拦住启动` });
  }
  return issues;
};

/** 只返回会让生产启动失败的那几条 */
cfg.fatalIssues = function fatalIssues() {
  return cfg.securityAudit().filter((i) => i.level === 'fatal');
};

module.exports = cfg;
