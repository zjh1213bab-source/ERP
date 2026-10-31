/**
 * 钉钉考勤接口客户端（只封装已验证的三个接口）
 * ============================================================
 *   1. GET  /gettoken                     换 access_token（有效期 7200s）
 *   2. POST /attendance/list              打卡**结果**（按排班卡点，每人每天最多 2 条）
 *   3. POST /attendance/listRecord        打卡**明细**（所有刷卡，含无效卡/位置）
 *
 * 几个必须在这一层处理掉的坑：
 *
 * - **token 要缓存**。钉钉给的 expires_in 是 7200 秒，但**频繁换 token 会被限流**，
 *   而且每次换都是一次 API 调用（标准版只有 1 万次/月）。这里提前 5 分钟过期，
 *   期间复用同一份。
 * - **token 失效要能自愈**。钉钉侧重启/风控会让 token 提前失效（errcode 40014/88/40001…），
 *   遇到就清缓存重取一次，而不是把失败原样抛给上层的定时任务 —— 否则每天要人工重启。
 * - **凭据没配要明确失败**。空 AppKey 直接抛 `DINGTALK_NOT_CONFIGURED`（409），
 *   绝不能让调用方以为"同步成功、只是没数据"。
 * - **时间窗最多 7 天**、**userIds 每次最多 50 个**，这是钉钉的硬限制，切分逻辑放在
 *   attendanceSync 里（那里知道业务要拉几天），这里只做单次请求。
 */
const config = require('../config');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

const cfg = () => config.dingtalk;
const base = () => cfg().baseUrl;

/** 凭据是否齐备（界面/接口靠这个区分「没配」和「配了但调不通」） */
function ready() {
  return !!(String(cfg().appKey || '').trim() && String(cfg().appSecret || '').trim());
}

function assertReady() {
  if (ready()) return;
  const e = bad('钉钉凭据未配置：请在 backend/.env 填 DINGTALK_APP_KEY / DINGTALK_APP_SECRET 后重启服务', 409);
  e.code = 'DINGTALK_NOT_CONFIGURED';
  throw e;
}

/** token 缓存：提前 5 分钟过期，避免"刚验证完就失效" */
let tokenCache = { token: '', expireAt: 0 };

function resetToken() { tokenCache = { token: '', expireAt: 0 }; }

async function httpJson(url, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg().timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {
      throw bad(`钉钉返回非 JSON（HTTP ${res.status}）：${String(text).slice(0, 140)}`, 502);
    }
    if (json && json.errcode && Number(json.errcode) !== 0) {
      const err = bad(`钉钉接口报错 ${json.errcode}：${json.errmsg || '(无描述)'}`, 502);
      err.errcode = Number(json.errcode);
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw bad(`钉钉接口超时（${cfg().timeoutMs}ms）`, 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** token 失效类错误码：清缓存重取一次即可，不必报警 */
const TOKEN_ERRORS = new Set([40014, 40001, 88, 42001, 41001]);

async function getToken(force = false) {
  assertReady();
  if (!force && tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token;
  const url = `${base()}/gettoken?appkey=${encodeURIComponent(cfg().appKey)}&appsecret=${encodeURIComponent(cfg().appSecret)}`;
  const j = await httpJson(url);
  if (!j.access_token) throw bad('钉钉未返回 access_token（检查 AppKey/AppSecret 是否属于同一应用）', 502);
  const ttlSec = Math.max(60, (Number(j.expires_in) || 7200) - 300);
  tokenCache = { token: j.access_token, expireAt: Date.now() + ttlSec * 1000 };
  return j.access_token;
}

/** 带 token 的 POST；token 失效时自动重试一次 */
async function postWithToken(path, body) {
  const doCall = async () => {
    const token = await getToken();
    return httpJson(`${base()}${path}?access_token=${encodeURIComponent(token)}`, { method: 'POST', body });
  };
  try {
    return await doCall();
  } catch (e) {
    if (e.errcode && TOKEN_ERRORS.has(Number(e.errcode))) {
      resetToken();
      return doCall();
    }
    throw e;
  }
}

/**
 * 打卡结果（按排班卡点）
 * @param {object} p
 * @param {string} p.from  'yyyy-MM-dd HH:mm:ss'，与 to 相隔 ≤7 天
 * @param {string} p.to
 * @param {string[]} [p.userIdList] 最多 50 个；不传＝按应用权限取范围内全部
 * @param {number} [p.offset]
 * @param {number} [p.limit] 默认 50
 * @returns {{records: object[], hasMore: boolean}}
 */
async function listResults({ from, to, userIdList, offset = 0, limit = 50 }) {
  const body = { workDateFrom: from, workDateTo: to, offset, limit };
  if (userIdList && userIdList.length) {
    if (userIdList.length > 50) throw bad('userIds 单次最多 50 个（钉钉限制）');
    body.userIdList = userIdList;
  }
  const j = await postWithToken('/attendance/list', body);
  return {
    records: j.recordresult || [],
    hasMore: j.hasMore === true || j.has_more === true
  };
}

/**
 * 打卡明细（所有刷卡记录，含无效卡与位置信息）
 * 本系统只用它补「无效卡/迟到待确认」的证据，不落位置（隐私）。
 */
async function listRecords({ from, to, userIds }) {
  if (!userIds || !userIds.length) throw bad('打卡明细必须指定 userIds');
  if (userIds.length > 50) throw bad('userIds 单次最多 50 个（钉钉限制）');
  const j = await postWithToken('/attendance/listRecord', { userIds, checkDateFrom: from, checkDateTo: to });
  return j.recordresult || [];
}

module.exports = { ready, assertReady, getToken, resetToken, listResults, listRecords, base };
