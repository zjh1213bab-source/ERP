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

  /**
   * 单公司模式（默认开）
   * ============================================================
   * 这套系统实际只服务一家公司，所以多主体（集团内多个法人主体）那套范围隔离默认**关闭**：
   * 所有人看到的是同一套数据、所有单据用同一个公司抬头。
   *
   * ## 开关管什么
   *
   *   true  → 范围模块（src/access/companyScope.js）全部短路：
   *           不按主体过滤、写入固定落抬头、跨主体访问不再返回 404
   *           （因为"跨主体"这个概念不存在了）；
   *   false → 完全恢复多主体隔离（8 个域的 112 条范围断言重新生效）。
   *
   * ## 为什么保留代码而不是删掉
   *
   * 隔离逻辑分布在 8 个域、几十处调用上。删掉容易，以后要用就得重写一遍，
   * 而且删的过程中最容易漏掉"某处本来就该按主体过滤"的判断。
   * 所以做法是**在一个地方短路**（companyScope），各域代码一行不动 ——
   * 等价于"把多公司逻辑注释掉，但留着一个总闸"。
   *
   * ## 怎么切回多主体
   *
   *   .env 里写 SINGLE_COMPANY=0 后重启即可，数据不用迁
   *   （company_id 一直在写，只是不再拿来过滤）。
   *
   * ⚠️ 多主体模式下才有意义的规则（单公司模式下不会触发，代码保留）：
   *    「一笔收付款只结同一主体的账」、「跨主体返回 404 不泄露存在性」、
   *    「无 company_id 列的表按归属表达式推主体」。
   */
  singleCompany: process.env.SINGLE_COMPANY !== '0',

  /**
   * 反向代理信任级别（决定 `req.ip` 到底是谁）
   *
   * 为什么必须显式配：登录限流是**按 IP 分桶**的。Nginx 反代后，
   * 不配 trust proxy 时 `req.ip` 恒为 `127.0.0.1` —— 全公司所有人共用一个桶，
   * 20 次/分钟一满，连正常登录的人都会被锁在门外（而且限流看起来"生效了"，
   * 只是锁错了人）。配过头（`true`）则相反：请求头里的 X-Forwarded-For
   * 由客户端自己填，攻击者每次换个假 IP 就能绕开限流。
   *
   * 默认 `loopback`：只信任本机反代（本项目推荐的同机 Nginx 部署形态），
   * 此时取 X-Forwarded-For 里最右侧的"非可信"地址 —— 也就是 Nginx 追加的真实客户端 IP。
   * 前后端不同机 / 走了云负载均衡时，按实际网段配（如 `10.0.0.0/8`）。
   * 完全直连（不反代）时写 `0` 关掉。
   */
  trustProxy: (() => {
    const raw = String(process.env.TRUST_PROXY ?? 'loopback').trim();
    if (!raw || raw === '0' || raw.toLowerCase() === 'false') return false;
    if (raw === '1' || raw.toLowerCase() === 'true') return 1;
    if (/^\d+$/.test(raw)) return Number(raw);
    if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
    return raw; // loopback / linklocal / uniquelocal / 具体网段
  })(),

  /**
   * 登录限流参数（按 IP 与按账号两道）
   *
   * 放在 config 里而不是硬编码在中间件：上线后如果发现"早高峰前台登录被锁"，
   * 改环境变量重启即可，不用改代码重新打包。
   *
   * 三个阈值分别对应三件事（详见 `middleware/loginLimit.js` 文件头）：
   *   attemptMax —— 防 CPU 洪水，给得松（正常办公远达不到）
   *   failIpMax  —— 防单机撞库，按「失败」计数，成功登录不占额度
   *   failMax    —— 同账号连续失败几次开始锁，之后逐次翻倍
   */
  loginLimit: {
    attemptMax: Number(process.env.LOGIN_ATTEMPT_MAX) || 120,   // 每 IP 每窗口总尝试上限
    failIpMax: Number(process.env.LOGIN_FAIL_IP_MAX) || 20,     // 每 IP 每窗口失败上限
    windowMs: (Number(process.env.LOGIN_WINDOW_SEC) || 60) * 1000,
    failMax: Number(process.env.LOGIN_FAIL_MAX) || 5,           // 同账号连续失败几次开始锁
    lockMs: (Number(process.env.LOGIN_LOCK_SEC) || 300) * 1000,
    lockMaxMs: (Number(process.env.LOGIN_LOCK_MAX_SEC) || 1800) * 1000
  },

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
