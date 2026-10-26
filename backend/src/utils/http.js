/**
 * 统一响应与异步包装
 */
function ok(res, data) {
  return res.json({ ok: true, data });
}

function fail(res, code, message) {
  return res.status(code).json({ ok: false, message });
}

/** 包装 async 路由，统一 catch 到错误中间件 */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** 生成单据号：前缀 + yyyymmdd + 4 位序号 */
function genNo(prefix, seq) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
  return `${prefix}${ymd}${String(seq).padStart(4, '0')}`;
}

module.exports = { ok, fail, wrap, genNo };
