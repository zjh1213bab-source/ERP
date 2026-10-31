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
  /**
   * 要说清**缺哪一个**。只写"凭据未配置"时，人会以为自己填了 —— 钉钉控制台把 Secret
   * 显示成 `XHis_u16e8****EZBJm7DsKe` 这种遮罩值，直接复制就会填进一个假字符串，
   * 然后卡在"配了却调不通"上排查半天。
   */
  const missing = [];
  if (!String(cfg().appKey || '').trim()) missing.push('DINGTALK_APP_KEY');
  if (!String(cfg().appSecret || '').trim()) missing.push('DINGTALK_APP_SECRET');
  const e = bad(`钉钉凭据未配置：缺少 ${missing.join(' / ')}（在 backend/.env 填好后重启服务；Secret 不能填控制台的遮罩值，要点「查看」复制完整串）`, 409);
  e.code = 'DINGTALK_NOT_CONFIGURED';
  throw e;
}

/** token 缓存：提前 5 分钟过期，避免"刚验证完就失效" */
let tokenCache = { token: '', expireAt: 0 };

function resetToken() { tokenCache = { token: '', expireAt: 0 }; }

/**
 * 钉钉错误码 → 下一步该做什么
 *
 * 钉钉的 errmsg 只说"错了"，不说"怎么办"。这几个是接考勤时必然撞上的：
 * 60011 权限没开（哪怕 Secret 全对，也要在后台加权限**并重新发布应用**才生效）、
 * 60020 出口 IP 不在白名单、40089 凭据不匹配。把处置方式直接写进报错，
 * 省掉"拿到错误码再去翻文档"这一轮。
 */
const ERR_HINT = {
  60011: '应用缺少该接口权限：钉钉开放平台 → 权限管理 → 添加后**重新发布应用**才生效',
  60020: '服务器出口 IP 不在应用白名单：钉钉后台 → 应用 → 安全设置 → 服务器出口 IP',
  40089: 'AppKey 与 AppSecret 不匹配（确认属于同一个应用；Secret 不能用控制台的遮罩值）',
  40014: 'access_token 无效（已自动重取重试一次仍失败）',
  88: 'access_token 无效',
  90018: '参数不合法：检查日期窗口是否超过 7 天、userIds 是否超过 50 个',
  90007: '参数不合法（业务参数校验失败）'
};

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
      const code = Number(json.errcode);
      const hint = ERR_HINT[code];
      const err = bad(`钉钉接口报错 ${code}：${json.errmsg || '(无描述)'}${hint ? '　→ ' + hint : ''}`, 502);
      err.errcode = code;
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

/**
 * 连接自检（不写库、不需要员工映射）
 *
 * 为什么需要：同步本体要求"先绑了员工才跑"，于是凭据对不对、权限开没开这两件事
 * 没有独立验证入口 —— 人事只能等到映射完才发现权限没开。这里把链路拆成两步分别试：
 *   1. gettoken    → 凭据是否有效（AppKey/Secret 是否同一应用）
 *   2. attendance  → 应用是否被授予"查询企业考勤数据权限"
 * 只取 1 条记录，不返回任何人员信息。
 */
async function probe() {
  const steps = [];
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  const t0 = Date.now();
  try {
    const tk = await getToken();
    steps.push({ name: 'gettoken', ok: true, ms: Date.now() - t0, note: `已取得 token（${tk.length} 字符，缓存 2 小时）` });
  } catch (e) {
    steps.push({ name: 'gettoken', ok: false, ms: Date.now() - t0, error: e.message });
    return { configured: true, ok: false, steps };
  }

  const t1 = Date.now();
  try {
    const r = await listResults({ from: `${today} 00:00:00`, to: `${today} 23:59:59`, offset: 0, limit: 1 });
    steps.push({
      name: 'attendance.list', ok: true, ms: Date.now() - t1,
      note: r.records.length ? `今日可读（本页 ${r.records.length} 条）` : '可读，但今天还没有打卡记录'
    });
    return { configured: true, ok: true, steps };
  } catch (e) {
    steps.push({ name: 'attendance.list', ok: false, ms: Date.now() - t1, error: e.message });
    return { configured: true, ok: false, steps };
  }
}

module.exports = { ready, assertReady, getToken, resetToken, listResults, listRecords, probe, base };
