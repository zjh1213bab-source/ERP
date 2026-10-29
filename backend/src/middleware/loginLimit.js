/**
 * 登录限流（内存滑动窗口 + 账号失败退避）
 * ============================================================
 * ## 为什么登录必须限流
 *
 * 登录是**唯一一个不需要 token 就能让服务端干重活**的接口：每来一次请求，
 * 服务端都要跑一遍 `scryptSync`（默认参数约 30-60ms CPU）。不加限制时：
 *   - 猜密码：脚本按字典逐个试，试到就是管理员；
 *   - 打 CPU：几十个并发就能把单进程后端压死（Node 单线程 + 同步 scrypt），
 *     全站业务跟着卡 —— 攻击者不需要任何权限就能造成停服。
 *
 * ## 三道闸，各挡各的
 *
 *   1. **尝试总数 / IP**（默认 120 次/分钟）—— 只挡 CPU 洪水，额度给得很松。
 *   2. **失败次数 / IP**（默认 20 次/分钟）—— 挡「一台机器换着账号撞库」。
 *   3. **连续失败 / 账号**（默认 5 次起锁 5 分钟，逐次翻倍，30 分钟封顶）——
 *      挡「换着 IP 打同一个账号」。
 *
 * ## 为什么成功登录不计入「失败」额度
 *
 * 一开始是"所有请求都计数"，结果正常办公场景立刻出问题：早高峰前台三台电脑
 * 共用一个出口 IP，一起登录就把额度吃满，后面的人被锁在门外 —— 限流看起来生效了，
 * 只是锁错了人。所以计数分两类：**尝试**只受宽松的洪水阈值约束，
 * **失败**才计入严格阈值（失败才是攻击信号，成功登录不是）。
 *
 * ## 为什么锁「账号」而不只是锁「IP」
 *
 * 锁 IP 会连坐同办公室的人（共用公网 IP 很常见），而攻击者换个代理就绕过。
 * 账号维度锁的是真正的目标。提示语里不区分"账号不存在"和"密码错"，
 * 避免这个接口变成账号枚举工具。
 *
 * ## 内存实现的天花板
 *
 * 计数存在进程内：重启清空、多实例各算各的（等于额度乘以实例数）。
 * 单实例部署够用；上多实例时换 Redis —— 接口形状（middleware / recordFail /
 * recordSuccess）就是为这个留的，替换实现不用改调用方。
 */
const config = require('../config');
const { fail } = require('../utils/http');

/** 超过这个量级顺手清一遍过期项，避免长期运行内存只增不减 */
const PRUNE_AT = 5000;

function create(params) {
  const p = params || {};
  const cfgLimit = config.loginLimit;
  const tag = p.name || 'login';
  const attemptMax = Number(p.attemptMax) || cfgLimit.attemptMax;
  const failIpMax = Number(p.failIpMax) || cfgLimit.failIpMax;
  const windowMs = Number(p.windowMs) || cfgLimit.windowMs;
  const failMax = Number(p.failMax) || cfgLimit.failMax;
  const lockMs = Number(p.lockMs) || cfgLimit.lockMs;
  const lockMaxMs = Number(p.lockMaxMs) || cfgLimit.lockMaxMs;

  /** ip → { all: [ts], bad: [ts] } */
  const ipHits = new Map();
  /** 账号（小写）→ { n: 连续失败次数, until: 锁到什么时候 } */
  const fails = new Map();

  const ipKey = (req) => tag + ':ip:' + (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
  const userKey = (u) => tag + ':u:' + String(u || '').trim().toLowerCase();

  function prune(nowMs) {
    if (ipHits.size + fails.size < PRUNE_AT) return;
    ipHits.forEach((v, k) => {
      v.all = v.all.filter((t) => nowMs - t < windowMs);
      v.bad = v.bad.filter((t) => nowMs - t < windowMs);
      if (!v.all.length && !v.bad.length) ipHits.delete(k);
    });
    fails.forEach((v, k) => { if (!v.until && !v.n) fails.delete(k); });
  }

  /**
   * 前置检查：账号锁定 → IP 失败额度 → IP 尝试总额度
   *
   * 顺序有讲究：先判账号锁、再消耗 IP 额度。反过来的话，锁定期内多试几次
   * 就会把同办公室其他人都拖下水。
   */
  function middleware(req, res, next) {
    const nowMs = Date.now();
    prune(nowMs);

    const uname = String((req.body && req.body.username) || '').trim().toLowerCase();
    req._loginUser = uname;

    if (uname) {
      const f = fails.get(userKey(uname));
      if (f && f.until > nowMs) {
        const sec = Math.ceil((f.until - nowMs) / 1000);
        res.setHeader('Retry-After', String(sec));
        return fail(res, 429, `该账号连续登录失败次数过多，已临时锁定，请约 ${Math.ceil(sec / 60)} 分钟后再试`);
      }
    }

    const k = ipKey(req);
    const bucket = ipHits.get(k) || { all: [], bad: [] };
    bucket.all = bucket.all.filter((t) => nowMs - t < windowMs);
    bucket.bad = bucket.bad.filter((t) => nowMs - t < windowMs);
    const winSec = Math.ceil(windowMs / 1000);

    if (bucket.bad.length >= failIpMax) {
      ipHits.set(k, bucket);
      res.setHeader('Retry-After', String(winSec));
      return fail(res, 429, `本机登录失败次数过多（每 ${winSec} 秒最多 ${failIpMax} 次），请稍后再试`);
    }
    if (bucket.all.length >= attemptMax) {
      ipHits.set(k, bucket);
      res.setHeader('Retry-After', String(winSec));
      return fail(res, 429, `登录尝试过于频繁（每 ${winSec} 秒最多 ${attemptMax} 次），请稍后再试`);
    }
    bucket.all.push(nowMs);
    ipHits.set(k, bucket);
    return next();
  }

  /**
   * 记一次失败
   *
   * 账号维度：连续失败累加，达到 `failMax` 开始计时锁；
   * IP 维度：只记失败时间戳（供上面的严格阈值用）。
   */
  function recordFail(req, username) {
    const nowMs = Date.now();
    const k = ipKey(req);
    const bucket = ipHits.get(k) || { all: [], bad: [] };
    bucket.bad.push(nowMs);
    ipHits.set(k, bucket);

    const uname = String(username !== undefined ? username : req._loginUser || '').trim().toLowerCase();
    if (!uname) return;
    const cur = fails.get(userKey(uname)) || { n: 0, until: 0 };
    const n = cur.n + 1;
    let until = 0;
    if (n >= failMax) {
      // 5 次 → 5 分钟，6 次 → 10 分钟，7 次 → 20 分钟，之后封顶 30 分钟
      const step = Math.min(n - failMax, 10);
      until = nowMs + Math.min(lockMs * Math.pow(2, step), lockMaxMs);
    }
    fails.set(userKey(uname), { n, until });
  }

  /** 登录成功：清掉该账号的连续失败计数（IP 的尝试计数保留，防止「成功一次重置配额」） */
  function recordSuccess(req, username) {
    const uname = String(username !== undefined ? username : req._loginUser || '').trim().toLowerCase();
    if (uname) fails.delete(userKey(uname));
  }

  /** 仅供冒烟/运维复位（不对外暴露成接口） */
  function reset() {
    ipHits.clear();
    fails.clear();
  }

  return {
    middleware,
    recordFail,
    recordSuccess,
    reset,
    _limits: { attemptMax, failIpMax, windowMs, failMax, lockMs, lockMaxMs }
  };
}

module.exports = { create };
