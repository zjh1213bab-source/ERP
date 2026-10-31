/**
 * 多端与外部接口（对齐原型 TS-M25 N25-03 / 04 / 05 / 06）
 * ------------------------------------------------------------
 * N25-03 业务事件与失败补偿
 *   - 每次外部推送都带 **event_id 幂等键**：重复推送只处理一次，不会重复成单/扣货/通知
 *   - 处理失败进入重试队列（指数退避），超过上限进**死信**，可人工重放或标记放弃
 *   - 业务落库与消息通知分离：先把事件存下来，再由 dispatch 处理，故障可追踪
 * N25-04 物流接入与人工校正
 *   - 人工校正保留旧值、理由、批准人与时间，批准后才生效并通知客户
 *   - 无接口时由授权人员维护真实事件并标注来源，不冒充实时定位
 * N25-05 接口安全
 *   - 外部入口按接入点独立 API Key；按接入点限流；所有调用（含鉴权失败/限流）写调用日志
 *   - 私有文件下载用带过期时间的签名链接，撤销后旧链接不能续取
 * N25-06 上线运维与交付资产
 *   - 自动生成 OpenAPI 清单，便于交付与二次对接
 */
const crypto = require('crypto');
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const mall = require('../services/mall');
const attendanceSync = require('../services/attendanceSync');
const dingtalk = require('../services/dingtalk');
/** 私有附件的签名与下载只有一份实现（routes/files.js），这里只做别名 */
const { downloadHandler: DownloadHandler, signedUrlHandler: SignedUrlHandler } = require('./files');

const router = express.Router();
const WRITE = ['admin', 'hr'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const EP_TYPE = { shop: '电商店铺', logistics: '物流商', payment: '支付', other: '其他' };
const TOPIC = {
  'retail.order': '零售订单',
  'shipment.event': '物流事件',
  notification: '站内通知',
  'stock.sync': '库存同步'
};
const EVENT_STATUS = {
  pending: '待处理', processing: '处理中', success: '已成功', failed: '待重试', dead: '死信'
};

// ---------- 限流（内存滑动窗口，重启即清空，生产应换 Redis） ----------
const hits = new Map();
function rateLimited(endpoint) {
  const limit = Number(endpoint.rate_limit_per_min) || 0;
  if (!limit) return false;
  const key = endpoint.id;
  const nowMs = Date.now();
  const arr = (hits.get(key) || []).filter((t) => nowMs - t < 60000);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return true;
  }
  arr.push(nowMs);
  hits.set(key, arr);
  return false;
}

function logCall({ endpointId, code, method, p, status, ip, ms, note }) {
  try {
    db.prepare(
      `INSERT INTO integration_calls (endpoint_id, endpoint_code, method, path, status_code, ip, duration_ms, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(endpointId || null, code || null, method, p, status, ip || null, ms || 0, note || null, now());
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 6 ? '*'.repeat(s.length) : s.slice(0, 3) + '****' + s.slice(-3);
}

/**
 * 接入密钥的存储与校验（v1.68 改）
 * ============================================================
 * 原来 `integration_endpoints.api_key` 存**明文**，并且：
 *   - 列表接口 `GET /endpoints` 直接把它吐给前端（`...r` 展开）；
 *   - 校验写成 `key !== ep.api_key`（普通字符串比较，理论上可被计时侧信道逐步逼近）；
 *   - ingress 还允许从**请求体** `body.api_key` 读 Key —— 于是 Key 会跟着 payload
 *     一起被写进 `integration_events.payload`，等于把密钥存了两份，还进了备份包。
 *
 * 现在：
 *   - 只存 `sha256(Key)`（`api_key_hash`）+ 一段掩码（`api_key_hint`，用于界面展示）；
 *   - 只从 `X-Api-Key` 请求头读，请求体里的一律不看；
 *   - 比对用 `timingSafeEqual`（先比长度再比内容，长度差直接返回 false）；
 *   - 落库前把 payload 里的凭证类字段抹掉，备份包与事件表里都不再出现密钥。
 *
 * 为什么用 sha256 而不是 scrypt：API Key 是 32 字节随机串（不是人记的密码），
 * 没有字典可撞，sha256 足够；而入口每来一次请求都要校验，scrypt 的 30-60ms
 * 会直接变成吞吐上限。
 */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function verifyKey(plain, ep) {
  const stored = String(ep.api_key_hash || '');
  if (!stored) return false;
  const calc = Buffer.from(sha256(plain), 'hex');
  const want = Buffer.from(stored, 'hex');
  if (calc.length !== want.length) return false;
  return crypto.timingSafeEqual(calc, want);
}

/** 凭证类字段：落库前一律抹掉（大小写与命名风格都覆盖） */
const SECRET_FIELD = /^(api[-_]?key|apikey|access[-_]?key|secret|client[-_]?secret|password|passwd|pwd|token|access[-_]?token|refresh[-_]?token|authorization|sign|signature|cookie)$/i;

/** 递归脱敏：返回新对象，不改原对象（原对象还要给业务用） */
function redact(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  Object.keys(value).forEach((k) => {
    out[k] = SECRET_FIELD.test(k) ? '***' : redact(value[k], depth + 1);
  });
  return out;
}

// ============================================================
// 外部入口：带 API Key + 限流 + 幂等
// ============================================================
router.post('/ingest/:code', wrap(async (req, res) => {
  const started = Date.now();
  const ep = db.prepare('SELECT * FROM integration_endpoints WHERE code = ?').get(req.params.code);
  if (!ep) {
    logCall({ code: req.params.code, method: 'POST', p: req.path, status: 404, ip: req.ip });
    return fail(res, 404, '接入点不存在');
  }
  if (ep.status !== 'active') {
    logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 403, ip: req.ip, note: '接入点已停用' });
    return fail(res, 403, '接入点已停用');
  }
  if (ep.auth_type === 'api_key') {
    /**
     * **只认请求头**。原来还接受 `body.api_key`，后果有两层：
     *   1. 密钥跟着业务报文一起被 `JSON.stringify` 存进 `integration_events.payload`；
     *   2. 它会出现在死信列表、重试日志、备份包里 —— 一次排查就得把密钥发给一圈人。
     * 请求头不落库，且网关/日志的常规脱敏规则都覆盖 `X-Api-Key`。
     */
    const key = req.headers['x-api-key'];
    if (!key) {
      logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 401, ip: req.ip, note: '缺少 X-Api-Key 请求头' });
      return fail(res, 401, '缺少 X-Api-Key 请求头');
    }
    if (!verifyKey(key, ep)) {
      logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 401, ip: req.ip, note: 'API Key 不正确' });
      return fail(res, 401, 'API Key 不正确');
    }
  }
  if (rateLimited(ep)) {
    logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 429, ip: req.ip, note: `超过限流 ${ep.rate_limit_per_min}/min` });
    return fail(res, 429, `超过该接入点限流（${ep.rate_limit_per_min} 次/分钟）`);
  }

  const b = req.body || {};
  const eventId = b.event_id || req.headers['x-idempotency-key'];
  if (!eventId) {
    logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 400, ip: req.ip, note: '缺少幂等键' });
    return fail(res, 400, '缺少 event_id（幂等键），重试会重复成单，请务必带上');
  }
  const topic = b.topic;
  if (!topic) {
    logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 400, ip: req.ip, note: '缺少 topic' });
    return fail(res, 400, '缺少 topic');
  }

  // 幂等：同一 event_id 重复推送直接返回原结果，不重复处理
  const exist = db.prepare('SELECT * FROM integration_events WHERE event_id = ?').get(String(eventId));
  if (exist) {
    logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 200, ip: req.ip, note: '重复事件（幂等命中）' });
    return ok(res, {
      duplicate: true,
      event_id: exist.event_id,
      status: exist.status,
      status_label: EVENT_STATUS[exist.status] || exist.status,
      result_ref: exist.result_ref,
      message: '该 event_id 已处理过，本次不重复落库'
    });
  }

  const t = now();
  /**
   * 落库前脱敏：`payload` 是外部系统推来的整包报文，里面可能带对方的 key/token/签名。
   * 事件表会被列表页、死信重试、备份包三处读到 —— 不该成为密钥的第二份副本。
   */
  const safePayload = JSON.stringify(redact(b.payload || b));
  const r = db.prepare(
    `INSERT INTO integration_events (event_id, direction, endpoint_id, topic, payload, status, attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(String(eventId), 'in', ep.id, topic, safePayload, 'pending', 0, t, t);
  db.prepare('UPDATE integration_endpoints SET last_call_at=? WHERE id=?').run(t, ep.id);
  logCall({ endpointId: ep.id, code: ep.code, method: 'POST', p: req.path, status: 202, ip: req.ip, ms: Date.now() - started });

  return ok(res, {
    duplicate: false,
    event_db_id: Number(r.lastInsertRowid),
    event_id: String(eventId),
    status: 'pending',
    message: '已接收，等待处理（可调用 dispatch 或等待定时任务）'
  });
}));

// ---------- 钉钉考勤同步 ----------
/**
 * 为什么单独一组接口，而不是让外部系统直接 POST /ingest：
 * 拉取方向相反 —— 这里是**本系统主动去钉钉取数**，走的是出网请求 + 应用凭证，
 * 与"别人推给我们"的接入点不是一回事（那套用 X-Api-Key + 幂等键）。
 *
 * 权限统一给 admin / hr（WRITE）：打卡数据是人事口径，业务角色只读即可，
 * 不给它们触发同步的能力 —— 一次误触发会把当天考勤整批重算。
 *
 * 定时触发不走这里：计划任务直接跑 `node scripts/sync-attendance.js`，
 * 免得为了一个后台任务把管理员口令/token 落到计划任务里。
 */
router.get('/dingtalk/status', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, attendanceSync.status())));

/**
 * 连接自检：分别验证「凭据能不能换到 token」与「应用有没有考勤读权限」。
 * 不需要任何员工映射，也不写库 —— 装完凭据先点这个，比直接跑同步更容易定位问题。
 */
router.get('/dingtalk/probe', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  return ok(res, await dingtalk.probe());
}));

router.get('/dingtalk/runs', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, attendanceSync.recentRuns(req.query.limit))));

router.post('/dingtalk/sync', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const me = req.user || {};
  const r = await attendanceSync.sync({
    from: b.from, to: b.to, days: b.days,
    dryRun: !!b.dry_run,
    operator: me.name || me.username || ''
  });
  return ok(res, r);
}));

/** 员工 ↔ 钉钉 userid 映射（唯一的映射入口，不做姓名/手机号猜测） */
router.post('/dingtalk/map', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  return ok(res, attendanceSync.mapEmployee(req.body || {}));
}));

// ---------- 签名下载（私有文件短期授权） ----------
/**
 * 这两个接口现在只是**别名**，真正实现在 `routes/files.js`
 *
 * 之前这里自己拼了一个目录：`path.join(__dirname,'..','..','uploads')` = `backend/uploads`，
 * 而上传接口写的是 `backend/data/uploads` —— 两个目录根本不是同一个，
 * 于是"给刚上传的附件换签名链接"必然 404（源码里也没有任何东西往 `backend/uploads` 写）。
 *
 * 现在统一：文件在 `data/uploads/private/`，签名与下载只有一份实现，
 * 旧路径继续可用（对接方/文档里已经写了这两个地址），行为与 `/api/files/*` 完全一致。
 */
router.post('/files/signed-url', authRequired, wrap(async (req, res) => {
  // 兼容两种入参：`{name}` 或完整的 `/api/files/att/xxx`（页面拿到的 url 直接丢进来即可）
  const raw = String((req.body && req.body.name) || '').trim();
  if (!raw) return fail(res, 400, '请提供文件名');
  return SignedUrlHandler(req, res);
}));

/** 签名文件下载（无需登录，但必须持有效签名且未过期） */
router.get('/files/:name', (req, res) => DownloadHandler(req, res));

// ============================================================
// 事件处理：把 payload 落到业务表
// ============================================================
function handleEvent(ev) {
  let payload = {};
  try { payload = JSON.parse(ev.payload || '{}'); } catch (e) { throw new Error('payload 不是合法 JSON'); }

  if (ev.topic === 'retail.order') {
    const shop = payload.shop_id
      ? db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(payload.shop_id)
      : db.prepare('SELECT * FROM channel_shops WHERE code = ?').get(payload.shop_code || '');
    if (!shop) throw new Error(`找不到店铺：${payload.shop_code || payload.shop_id || '(未提供)'}`);
    const items = Array.isArray(payload.items) ? payload.items.filter((i) => i && (i.qty || i.style_no)) : [];
    if (!items.length) throw new Error('订单没有商品明细');
    if (!payload.channel_order_no) throw new Error('缺少渠道订单号');

    const dup = db.prepare('SELECT retail_no FROM retail_orders WHERE shop_id = ? AND channel_order_no = ?')
      .get(shop.id, payload.channel_order_no);
    if (dup) return { ref: dup.retail_no, note: `渠道订单已存在，跳过（${dup.retail_no}）` };

    const t2 = now();
    const goods = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
    let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM retail_orders').get().c) + 1;
    let no = genNo('RT', seq);
    while (db.prepare('SELECT 1 AS x FROM retail_orders WHERE retail_no = ?').get(no)) no = genNo('RT', ++seq);

    db.exec('BEGIN');
    try {
      const r = db.prepare(
        `INSERT INTO retail_orders (retail_no, channel_order_no, shop_id, company, mode, order_date, currency, rate,
           goods_amount, discount, tax, shipping_fee, paid_amount, pay_status, receiver, remark, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(no, payload.channel_order_no, shop.id, shop.company || null, 'agency',
        payload.order_date || t2.slice(0, 10), shop.currency || 'USD', 6.5,
        round2(goods), 0, 0, 0, round2(payload.paid_amount !== undefined ? payload.paid_amount : goods),
        'pending', payload.receiver || null, `接口推送（${ev.event_id}）`, 'integration', t2, t2);
      const rid = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO retail_order_items (retail_id, sku, style_no, name, color, size, qty, price, amount, cost)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      items.forEach((i) => {
        const qty = Number(i.qty) || 1;
        const price = Number(i.price) || 0;
        insItem.run(rid, i.sku || null, i.style_no || i.sku || null, i.name || null, i.color || null,
          i.size || null, qty, price, round2(qty * price), Number(i.cost) || 0);
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ref: no, note: `已生成零售单 ${no}` };
  }

  if (ev.topic === 'shipment.event') {
    let orderId = payload.order_id;
    if (!orderId && payload.order_no) {
      const o = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(payload.order_no);
      if (!o) throw new Error(`订单不存在：${payload.order_no}`);
      orderId = o.id;
    }
    if (!orderId) throw new Error('缺少订单号');
    if (!payload.status_text) throw new Error('缺少物流状态');
    db.prepare(
      `INSERT INTO shipment_events (order_id, carrier, tracking_no, event_time, status_text, location,
         source, verified, visible, remark, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(orderId, payload.carrier || null, payload.tracking_no || null, payload.event_time || now(),
      payload.status_text, payload.location || null, 'api', 1, 1,
      `接口推送（${ev.event_id}）`, 'integration', now());
    return { ref: `order:${orderId}`, note: '已写入物流事件' };
  }

  if (ev.topic === 'notification') {
    let customerId = payload.customer_id;
    if (!customerId && payload.order_no) {
      const o = db.prepare(
        'SELECT customer_id FROM orders WHERE order_no = ?'
      ).get(payload.order_no);
      if (!o) throw new Error(`订单不存在：${payload.order_no}`);
      customerId = o.customer_id;
    }
    if (!customerId) throw new Error('缺少客户');
    if (!payload.title) throw new Error('缺少通知标题');
    const id = mall.pushMessage({
      customerId, type: payload.type || 'system', title: payload.title,
      body: payload.body || null, refType: 'integration', refId: ev.id
    });
    return { ref: `message:${id}`, note: '已推送客户站内信' };
  }

  throw new Error(`暂不支持的事件主题：${ev.topic}`);
}

/** 处理单条事件（供 dispatch 与手动重试复用） */
function processEvent(ev) {
  const t = now();
  db.prepare("UPDATE integration_events SET status='processing', updated_at=? WHERE id=?").run(t, ev.id);
  try {
    const out = handleEvent(ev);
    db.prepare("UPDATE integration_events SET status='success', attempts=attempts+1, result_ref=?, last_error=NULL, next_retry_at=NULL, processed_at=?, updated_at=? WHERE id=?")
      .run(out.ref || null, t, t, ev.id);
    return { ok: true, note: out.note, ref: out.ref };
  } catch (e) {
    const attempts = Number(ev.attempts) + 1;
    const maxA = Number(ev.max_attempts) || 5;
    const dead = attempts >= maxA;
    // 指数退避：2^attempts 分钟，最多 60 分钟
    const delayMin = Math.min(Math.pow(2, attempts), 60);
    const next = new Date(Date.now() + delayMin * 60000).toISOString();
    db.prepare(
      `UPDATE integration_events SET status=?, attempts=?, last_error=?, next_retry_at=?, updated_at=? WHERE id=?`
    ).run(dead ? 'dead' : 'failed', attempts, String(e.message || e), dead ? null : next, t, ev.id);
    return { ok: false, error: String(e.message || e), dead, attempts };
  }
}

/**
 * 调度：处理到期的 pending / failed 事件
 * 生产可挂定时任务，这里手动触发 + 前端按钮
 */
router.post('/dispatch', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const limit = Math.min(Number((req.body && req.body.limit) || 20), 100);
  const t = now();
  const rows = db.prepare(
    `SELECT * FROM integration_events
     WHERE status = 'pending'
        OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= ?))
     ORDER BY id LIMIT ?`
  ).all(t, limit);

  const results = rows.map((ev) => ({ event_id: ev.event_id, topic: ev.topic, ...processEvent(ev) }));
  return ok(res, {
    processed: results.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.dead).length,
    dead: results.filter((r) => r.dead).length,
    results
  });
}));

// ============================================================
// 管理端
// ============================================================
router.get('/stats', authRequired, wrap(async (req, res) => {
  const t = now();
  const ep = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN status=\'active\' THEN 1 ELSE 0 END) AS active FROM integration_endpoints').get();
  const ev = db.prepare(
    `SELECT
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) AS dead,
       SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
       COUNT(*) AS total
     FROM integration_events`
  ).get();
  const calls = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
     FROM integration_calls WHERE created_at >= ?`
  ).get(new Date(Date.now() - 86400000).toISOString());
  const correctPending = db.prepare(
    'SELECT COUNT(*) AS c FROM shipment_events WHERE correct_pending IS NOT NULL'
  ).get().c;

  return ok(res, {
    endpoints: { total: Number(ep.total) || 0, active: Number(ep.active) || 0 },
    events: {
      pending: Number(ev.pending) || 0,
      failed: Number(ev.failed) || 0,
      dead: Number(ev.dead) || 0,
      success: Number(ev.success) || 0,
      total: Number(ev.total) || 0
    },
    calls_24h: { total: Number(calls.total) || 0, errors: Number(calls.errors) || 0 },
    correct_pending: Number(correctPending) || 0,
    warnings: [
      Number(ev.dead) > 0 ? `${ev.dead} 条事件进入死信，需人工介入` : null,
      Number(ev.failed) > 0 ? `${ev.failed} 条事件待重试` : null,
      Number(correctPending) > 0 ? `${correctPending} 条物流校正待批准` : null,
      Number(calls.errors) > 0 ? `近 24 小时有 ${calls.errors} 次接口调用失败或受阻` : null
    ].filter(Boolean)
  });
}));

/**
 * 接入点对外视图
 *
 * **显式列字段，不再 `...r` 展开**：展开的写法会把后来新增的敏感列
 * （`api_key` / `api_key_hash`）自动带出去 —— 这正是原来列表能读到明文的路径。
 * 以后再加列，这里是"想加才加"，不会默认泄露。
 */
function epView(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    type_label: EP_TYPE[r.type] || r.type,
    base_url: r.base_url,
    auth_type: r.auth_type,
    rate_limit_per_min: r.rate_limit_per_min,
    status: r.status,
    status_label: r.status === 'active' ? '启用' : '停用',
    shop_id: r.shop_id,
    shop_name: r.shop_id ? (db.prepare('SELECT shop_name FROM channel_shops WHERE id = ?').get(r.shop_id) || {}).shop_name : null,
    last_call_at: r.last_call_at,
    remark: r.remark,
    created_at: r.created_at,
    updated_at: r.updated_at,
    /** 掩码：让人能认出"这是哪一把"，但认出来也拿不去用 */
    api_key_masked: r.api_key_hint || (r.api_key ? maskKey(r.api_key) : ''),
    /** 是否已设置密钥（没设的接入点在出口是不可用的，列表上要看得出来） */
    api_key_set: !!(r.api_key_hash || r.api_key)
  };
}

router.get('/endpoints', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM integration_endpoints ORDER BY id').all();
  return ok(res, rows.map((r) => {
    const stat = db.prepare(
      `SELECT COUNT(*) AS cnt, SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errs
       FROM integration_calls WHERE endpoint_id = ? AND created_at >= ?`
    ).get(r.id, new Date(Date.now() - 86400000).toISOString());
    return { ...epView(r), calls_24h: Number(stat.cnt) || 0, errors_24h: Number(stat.errs) || 0 };
  }));
}));

router.post('/endpoints', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.code) return fail(res, 400, '请填写接入点编码');
  if (!b.name) return fail(res, 400, '请填写接入点名称');
  if (!/^[a-z0-9_-]{2,32}$/i.test(b.code)) return fail(res, 400, '编码只能包含字母、数字、下划线、短横线（2-32 位）');
  const t = now();
  const apiKey = String(b.api_key || '').trim() || 'ik_' + crypto.randomBytes(12).toString('hex');
  if (apiKey.length < 16) return fail(res, 400, 'API Key 至少 16 位（太短的密钥可以被穷举）');
  try {
    const r = db.prepare(
      `INSERT INTO integration_endpoints (code, name, type, base_url, auth_type, api_key_hash, api_key_hint, rate_limit_per_min, status, shop_id, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(b.code, b.name, b.type || 'shop', b.base_url || null, b.auth_type || 'api_key',
      sha256(apiKey), maskKey(apiKey),
      Number(b.rate_limit_per_min) || 60, b.status || 'active', b.shop_id || null, b.remark || null, t, t);
    /**
     * 明文只在这里出现一次 —— 之后任何接口都拿不到（库里只有哈希）。
     * 这是哈希存储的必然代价：丢了只能重置，不能"再查一次"。
     */
    return ok(res, {
      ...epView(db.prepare('SELECT * FROM integration_endpoints WHERE id = ?').get(r.lastInsertRowid)),
      api_key_plain: apiKey,
      warning: '这是唯一一次显示明文 Key，请立刻复制给对方；之后只能重置，无法再查看'
    });
  } catch (e) {
    return fail(res, 400, /UNIQUE/.test(e.message) ? '接入点编码已存在' : e.message);
  }
}));

router.put('/endpoints/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM integration_endpoints WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '接入点不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE integration_endpoints SET name=?, type=?, base_url=?, rate_limit_per_min=?, status=?, shop_id=?, remark=?, updated_at=? WHERE id=?`
  ).run(b.name || row.name, b.type || row.type, b.base_url ?? row.base_url,
    b.rate_limit_per_min !== undefined ? Number(b.rate_limit_per_min) || 0 : row.rate_limit_per_min,
    b.status || row.status, b.shop_id !== undefined ? b.shop_id : row.shop_id,
    b.remark ?? row.remark, now(), row.id);
  return ok(res, epView(db.prepare('SELECT * FROM integration_endpoints WHERE id = ?').get(row.id)));
}));

/** 重置 API Key（旧 Key 立即失效） */
router.post('/endpoints/:id/rotate-key', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM integration_endpoints WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '接入点不存在');
  const key = 'ik_' + crypto.randomBytes(12).toString('hex');
  // 只写哈希与掩码；顺手把可能残留的明文列清空（老库用 UPDATE 才能保证清掉）
  db.prepare('UPDATE integration_endpoints SET api_key_hash=?, api_key_hint=?, api_key=NULL, updated_at=? WHERE id=?')
    .run(sha256(key), maskKey(key), now(), row.id);
  return ok(res, {
    api_key_plain: key,
    api_key_masked: maskKey(key),
    message: '旧 Key 已失效，请同步更新对方系统。这是唯一一次显示明文，之后只能再次重置'
  });
}));

router.get('/events', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('e.status = ?'); params.push(req.query.status); }
  if (req.query.topic) { cond.push('e.topic = ?'); params.push(req.query.topic); }
  if (req.query.direction) { cond.push('e.direction = ?'); params.push(req.query.direction); }
  const rows = db.prepare(
    `SELECT e.*, p.code AS endpoint_code, p.name AS endpoint_name FROM integration_events e
     LEFT JOIN integration_endpoints p ON p.id = e.endpoint_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY e.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map((r) => ({
    ...r,
    status_label: EVENT_STATUS[r.status] || r.status,
    topic_label: TOPIC[r.topic] || r.topic
  })));
}));

/** 手动重放（死信或待重试） */
router.post('/events/:id/retry', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM integration_events WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '事件不存在');
  if (ev.status === 'success') return fail(res, 400, '已成功的事件无需重放');
  db.prepare("UPDATE integration_events SET status='pending', next_retry_at=NULL, updated_at=? WHERE id=?").run(now(), ev.id);
  const out = processEvent(db.prepare('SELECT * FROM integration_events WHERE id = ?').get(ev.id));
  return ok(res, out);
}));

/** 标记放弃（不再自动重试） */
router.post('/events/:id/drop', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM integration_events WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '事件不存在');
  db.prepare("UPDATE integration_events SET status='dead', last_error=COALESCE(?, last_error), updated_at=? WHERE id=?")
    .run((req.body && req.body.reason) || '人工标记放弃', now(), ev.id);
  return ok(res, { id: ev.id, status: 'dead' });
}));

router.get('/calls', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.endpoint_id) { cond.push('endpoint_id = ?'); params.push(Number(req.query.endpoint_id)); }
  if (req.query.only_error) { cond.push('status_code >= 400'); }
  const rows = db.prepare(
    `SELECT * FROM integration_calls ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows);
}));

// ============================================================
// N25-04 物流人工校正
// ============================================================
function evtView(r) {
  let pending = null;
  try { pending = r.correct_pending ? JSON.parse(r.correct_pending) : null; } catch (e) { pending = null; }
  return {
    ...r,
    source_label: r.source === 'api' ? '接口同步' : '人工登记',
    verified_label: Number(r.verified) ? '已核实' : '待核实',
    pending_correction: pending,
    corrected: !!r.correct_at
  };
}

router.get('/shipments', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.pending) cond.push('correct_pending IS NOT NULL');
  if (req.query.order_id) { cond.push('order_id = ?'); params.push(Number(req.query.order_id)); }
  const rows = db.prepare(
    `SELECT e.*, o.order_no, COALESCE(c.name, '散客') AS customer_name
     FROM shipment_events e LEFT JOIN orders o ON o.id = e.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY COALESCE(e.event_time, e.created_at) DESC, e.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map(evtView));
}));

/**
 * 提交校正：只登记待批准，不直接改值
 * 校正必须给理由，批准后才生效并通知客户
 */
router.post('/shipments/:id/correct', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '物流事件不存在');
  const b = req.body || {};
  if (!b.reason || !String(b.reason).trim()) return fail(res, 400, '人工校正必须填写理由');
  const patch = {};
  if (b.status_text !== undefined) patch.status_text = b.status_text;
  if (b.location !== undefined) patch.location = b.location;
  if (b.event_time !== undefined) patch.event_time = b.event_time;
  if (!Object.keys(patch).length) return fail(res, 400, '请至少修改一项（状态/地点/时间）');

  db.prepare(
    'UPDATE shipment_events SET correct_pending=?, correct_reason=?, correct_by=?, correct_at=? WHERE id=?'
  ).run(JSON.stringify(patch), String(b.reason).trim(), req.user.username, now(), ev.id);
  return ok(res, evtView(db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(ev.id)));
}));

/** 批准校正：应用新值 + 保留旧值 + 通知客户 */
router.post('/shipments/:id/correct/approve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '物流事件不存在');
  if (!ev.correct_pending) return fail(res, 400, '该事件没有待批准的校正');
  if (ev.correct_by && ev.correct_by === req.user.username && req.user.role !== 'admin') {
    return fail(res, 400, '提交校正的人不能自己批准，请由他人复核');
  }
  let patch = {};
  try { patch = JSON.parse(ev.correct_pending); } catch (e) { patch = {}; }
  const before = { status_text: ev.status_text, location: ev.location, event_time: ev.event_time };

  try {
    db.exec('BEGIN');
    db.prepare(
      `UPDATE shipment_events SET status_text=?, location=?, event_time=?, correct_from=?, correct_reason=COALESCE(?, correct_reason),
         correct_pending=NULL, correct_approved_by=?, correct_approved_at=?, customer_notified=1 WHERE id=?`
    ).run(
      patch.status_text !== undefined ? patch.status_text : ev.status_text,
      patch.location !== undefined ? patch.location : ev.location,
      patch.event_time !== undefined ? patch.event_time : ev.event_time,
      JSON.stringify(before), ev.correct_reason, req.user.username, now(), ev.id
    );
    // 通知客户：物流信息有更新
    const o = db.prepare('SELECT order_no, customer_id FROM orders WHERE id = ?').get(ev.order_id);
    if (o && o.customer_id) {
      mall.pushMessage({
        customerId: o.customer_id,
        type: 'order',
        title: '物流信息更新',
        body: `订单 ${o.order_no} 的物流状态已更正为「${patch.status_text || ev.status_text}」。`,
        refType: 'shipment_event',
        refId: ev.id
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, evtView(db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(ev.id)));
}));

router.post('/shipments/:id/correct/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '物流事件不存在');
  if (!ev.correct_pending) return fail(res, 400, '该事件没有待批准的校正');
  db.prepare('UPDATE shipment_events SET correct_pending=NULL, correct_reason=COALESCE(?, correct_reason) WHERE id=?')
    .run((req.body && req.body.reason) || '校正被驳回', ev.id);
  return ok(res, evtView(db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(ev.id)));
}));

// ============================================================
// N25-06 交付资产：OpenAPI 清单
// ============================================================
router.get('/openapi.json', authRequired, wrap(async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const paths = {
    '/api/auth/login': { post: { summary: '员工登录', tags: ['认证'] } },
    '/api/mall/auth/login': { post: { summary: '客户商城登录', tags: ['认证'] } },
    '/api/orders': { get: { summary: '订单列表', tags: ['销售'] }, post: { summary: '创建订单', tags: ['销售'] } },
    '/api/orders/{id}/transition': { post: { summary: '订单状态流转（含硬门槛）', tags: ['销售'] } },
    '/api/quotations': { get: { summary: '报价单列表', tags: ['销售'] }, post: { summary: '创建报价单', tags: ['销售'] } },
    '/api/channel/shops': { get: { summary: '零售店铺映射', tags: ['零售渠道'] } },
    '/api/channel/retail-orders': { get: { summary: '零售订单', tags: ['零售渠道'] }, post: { summary: '新建零售单', tags: ['零售渠道'] } },
    '/api/channel/retail-orders/{id}/ship': { post: { summary: '零售发货（需支付已核）', tags: ['零售渠道'] } },
    '/api/channel/quotas': { get: { summary: '批零配额', tags: ['零售渠道'] } },
    '/api/channel/settlements/generate': { post: { summary: '生成结算批', tags: ['零售渠道'] } },
    '/api/confirm/seals': { get: { summary: '样衣封样列表', tags: ['客户确认'] }, post: { summary: '新建封样版本', tags: ['客户确认'] } },
    '/api/confirm/changes/{id}/approve': { post: { summary: '变更提交客户确认', tags: ['客户确认'] } },
    '/api/qc/inspections': { get: { summary: '检验单', tags: ['质量'] }, post: { summary: '开检验单', tags: ['质量'] } },
    '/api/qc/batches/{batchNo}/trace': { get: { summary: '批次全链路追溯', tags: ['质量'] } },
    '/api/hr/contracts': { get: { summary: '劳动合同', tags: ['人事'] }, post: { summary: '新建合同', tags: ['人事'] } },
    '/api/facility/dorm/checkin': { post: { summary: '宿舍入住（区间不重叠）', tags: ['后勤'] } },
    '/api/facility/meal/transactions': { post: { summary: '餐费流水', tags: ['后勤'] } },
    '/api/stats/profit': { get: { summary: '毛利分析', tags: ['报表'] } },
    '/api/assistant/query': { post: { summary: '智能问数', tags: ['助手'] } },
    '/api/integration/ingest/{code}': {
      post: {
        summary: '外部事件入口（需 X-Api-Key 与 event_id 幂等键）',
        tags: ['外部接口'],
        parameters: [
          { name: 'X-Api-Key', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'code', in: 'path', required: true, schema: { type: 'string' } }
        ]
      }
    },
    '/api/integration/dispatch': { post: { summary: '处理待办事件（重试/死信）', tags: ['外部接口'] } },
    '/api/integration/files/signed-url': { post: { summary: '获取私有文件签名下载链接', tags: ['外部接口'] } }
  };
  return ok(res, {
    openapi: '3.0.3',
    info: {
      title: '衣创 ERP 接口清单',
      version: '1.0.12',
      description: '本文件由系统自动生成，仅列出主要业务接口；完整接口见 docs/API.md。'
    },
    servers: [{ url: base }],
    tags: [
      { name: '认证' }, { name: '销售' }, { name: '零售渠道' }, { name: '客户确认' },
      { name: '质量' }, { name: '人事' }, { name: '后勤' }, { name: '报表' },
      { name: '助手' }, { name: '外部接口' }
    ],
    paths
  });
}));

module.exports = router;
