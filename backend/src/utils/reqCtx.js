/**
 * 请求上下文（给脱敏与留痕用）
 *
 * 为什么要单独抽：留痕需要「谁、什么时候、从哪来」。
 * 每个路由各写一份 `req.headers['x-forwarded-for'].split(',')[0]` 迟早会出现
 * 有的路由取了代理 IP、有的没取，日志里一半是内网地址 —— 出事时对不上。
 */
function reqCtx(req, extra = {}) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '')
    .split(',')[0]
    .trim();
  return {
    user: req.user,
    ip: ip || null,
    ua: String(req.headers['user-agent'] || '').slice(0, 200) || null,
    ...extra
  };
}

module.exports = { reqCtx };
