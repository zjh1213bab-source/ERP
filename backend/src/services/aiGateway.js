/**
 * 模型网关（M17 N17-01）
 *
 * 职责：
 *   1. 供应商登记与就绪判定 —— 密钥只读环境变量，库里只存变量名与脱敏值
 *   2. 按数据分级路由 —— 薪资/绩效这类 restricted 场景只允许 restricted 级供应商处理，
 *      境外供应商（openai）即使有 key 也拿不到 restricted 数据
 *   3. 预算与超时 —— 月度预算用尽即拦，超时按 provider.timeout_ms 中断
 *   4. 每次调用写 ai_calls（含降级原因），前端能看见「这次到底是模型答的还是规则答的」
 *
 * 重要：本模块只负责「能不能调、调了花多少」，不负责业务判定。
 * 所有业务能力都必须在无模型时可用（规则降级），否则系统等于被外部服务绑死。
 */
const crypto = require('crypto');
const { db } = require('../db');
const { localNow } = require('./sla');

const SCOPE_RANK = { public: 0, internal: 1, restricted: 2 };

/** 场景 → 数据敏感级 + 中文名 */
const SCENES = {
  ask: { name: '业务问答', sensitivity: 'internal' },
  extract: { name: '需求抽取', sensitivity: 'internal' },
  explain: { name: '异常解释', sensitivity: 'internal' },
  reply: { name: '客服答复', sensitivity: 'internal' },
  weekly: { name: '周报与绩效解释', sensitivity: 'restricted' },
  eval: { name: '评测回归', sensitivity: 'internal' }
};

const DEFAULT_PROVIDERS = [
  {
    code: 'LLM-CN01', name: '国内主模型（DeepSeek）', vendor: 'deepseek',
    base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    key_env: 'AI_API_KEY', data_scope: 'restricted', region: 'cn',
    input_price: 0.001, output_price: 0.002, monthly_budget: 300,
    timeout_ms: 20000, priority: 10, status: 'planning',
    note: '境内服务，可处理薪资/绩效等受限数据；密钥只在服务端环境变量。'
  },
  {
    code: 'LLM-CN02', name: '国内备选模型（通义千问）', vendor: 'qwen',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
    key_env: 'AI_API_KEY_QWEN', data_scope: 'internal', region: 'cn',
    input_price: 0.0008, output_price: 0.002, monthly_budget: 200,
    timeout_ms: 20000, priority: 20, status: 'pending',
    note: '不绑定模型名，验证可替换即可；未配密钥时保持待启用。'
  },
  {
    code: 'LLM-OS01', name: '境外模型（仅公开/内部级）', vendor: 'openai',
    base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    key_env: 'AI_API_KEY_OS', data_scope: 'internal', region: 'overseas',
    input_price: 0.01, output_price: 0.03, monthly_budget: 100,
    timeout_ms: 15000, priority: 50, status: 'disabled',
    note: '数据出境，不允许处理薪资、成本、客户财务等受限数据。'
  }
];

/** 首次访问时补齐默认供应商（幂等，不覆盖已改过的配置） */
function ensureDefaults() {
  const ins = db.prepare(
    `INSERT INTO ai_providers (code,name,vendor,base_url,model,key_env,key_masked,data_scope,region,
       input_price,output_price,monthly_budget,used_amount,timeout_ms,priority,status,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`
  );
  const t = localNow();
  DEFAULT_PROVIDERS.forEach((p) => {
    if (db.prepare('SELECT id FROM ai_providers WHERE code=?').get(p.code)) return;
    ins.run(p.code, p.name, p.vendor, p.base_url, p.model, p.key_env, maskEnv(p.key_env),
      p.data_scope, p.region, p.input_price, p.output_price, p.monthly_budget,
      p.timeout_ms, p.priority, p.status, p.note, t, t);
  });
}

function maskEnv(envName) {
  const v = process.env[envName];
  if (!v) return '';
  return v.length <= 8 ? '****' : v.slice(0, 3) + '****' + v.slice(-3);
}

function hasKey(p) {
  return !!(p.key_env && process.env[p.key_env]);
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/** 供应商是否可用（就绪 + 预算 + 数据级别够） */
function usability(p, sensitivity) {
  if (p.status !== 'enabled') return { ok: false, reason: `供应商状态为「${statusLabel(p.status)}」` };
  if (!hasKey(p)) return { ok: false, reason: `未配置密钥（环境变量 ${p.key_env || '—'}）` };
  if (SCOPE_RANK[p.data_scope] < SCOPE_RANK[sensitivity]) {
    return { ok: false, reason: `数据级别不够：该场景需 ${sensitivity}，此供应商只允许 ${p.data_scope}` };
  }
  const left = r2(Number(p.monthly_budget) - Number(p.used_amount));
  if (Number(p.monthly_budget) > 0 && left <= 0) {
    return { ok: false, reason: `本月预算已用尽（${r2(p.used_amount)} / ${p.monthly_budget} 元）` };
  }
  return { ok: true, left };
}

function statusLabel(s) {
  return { planning: '规划中', pending: '待评审', enabled: '已启用', disabled: '已停用' }[s] || s;
}

/** 选一个可用供应商：数据级别够 → 预算够 → 优先级高优先 */
function pickProvider(sensitivity) {
  const rows = db.prepare('SELECT * FROM ai_providers ORDER BY priority ASC, id ASC').all();
  const tried = [];
  for (const p of rows) {
    const u = usability(p, sensitivity);
    if (u.ok) return { provider: p, left: u.left };
    // 只把「本该能用但被卡住」的记下来，便于告诉用户为什么降级
    if (p.status === 'enabled' || p.status === 'pending' || p.status === 'planning') {
      tried.push(`${p.code}：${u.reason}`);
    }
  }
  return { provider: null, tried };
}

function logCall(row) {
  const t = localNow();
  db.prepare(
    `INSERT INTO ai_calls (scene,sensitivity,provider_id,provider_code,model,actor,prompt_digest,prompt_len,
       tokens_in,tokens_out,cost,latency_ms,status,reason,http_code,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.scene, row.sensitivity, row.provider_id || null, row.provider_code || null, row.model || null,
    row.actor || null, row.prompt_digest || null, row.prompt_len || 0,
    row.tokens_in || 0, row.tokens_out || 0, r4(row.cost), row.latency_ms || 0,
    row.status, row.reason || null, row.http_code || null, t
  );
}

const digest = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
/** 粗估 token：中文约 1 字 ≈ 0.7 token，这里保守按 1 字 = 1 token 估 */
const estTokens = (s) => Math.max(1, Math.round(String(s || '').length));

/**
 * 调模型
 * @param {object} opts { scene, system, prompt, actor, sensitivity?, maxTokens?, temperature? }
 * @returns {{ok:boolean, answer?:string, source:string, reason?:string, provider?:string, model?:string, latency_ms?:number, cost?:number}}
 *          永远不抛异常 —— 失败一律返回 source='rule' 让上层走规则降级
 */
async function call(opts) {
  const scene = opts.scene || 'ask';
  const sceneDef = SCENES[scene] || { name: scene, sensitivity: 'internal' };
  const sensitivity = opts.sensitivity || sceneDef.sensitivity;
  const t0 = Date.now();

  const picked = pickProvider(sensitivity);
  const p = picked.provider;
  if (!p) {
    const reason = picked.tried && picked.tried.length
      ? '无可用模型：' + picked.tried[0]
      : `无可用模型：没有登记 ${sensitivity} 级供应商`;
    logCall({
      scene, sensitivity, actor: opts.actor, status: 'fallback', reason,
      prompt_len: String(opts.prompt || '').length, prompt_digest: digest(opts.prompt),
      latency_ms: Date.now() - t0
    });
    return { ok: false, source: 'rule', reason, latency_ms: Date.now() - t0 };
  }

  const key = process.env[p.key_env];
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: String(opts.system || '') },
      { role: 'user', content: String(opts.prompt || '') }
    ],
    temperature: opts.temperature === undefined ? 0.2 : opts.temperature
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(p.timeout_ms) || 15000);

  try {
    const resp = await fetch(String(p.base_url).replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const json = await resp.json().catch(() => ({}));
    const answer = json?.choices?.[0]?.message?.content;
    const latency = Date.now() - t0;

    if (!resp.ok || !answer) {
      const reason = `模型返回异常（HTTP ${resp.status}）${json?.error?.message ? '：' + json.error.message : ''}`;
      logCall({
        scene, sensitivity, provider_id: p.id, provider_code: p.code, model: p.model, actor: opts.actor,
        status: 'error', reason, http_code: resp.status, latency_ms: latency,
        prompt_len: String(opts.prompt || '').length, prompt_digest: digest(opts.prompt)
      });
      return { ok: false, source: 'rule', reason, provider: p.code, model: p.model, latency_ms: latency };
    }

    const tin = Number(json.usage?.prompt_tokens) || estTokens(opts.system + opts.prompt);
    const tout = Number(json.usage?.completion_tokens) || estTokens(answer);
    const cost = r4((tin / 1000) * Number(p.input_price) + (tout / 1000) * Number(p.output_price));

    db.prepare('UPDATE ai_providers SET used_amount=ROUND(used_amount+?,4), updated_at=? WHERE id=?')
      .run(cost, localNow(), p.id);
    logCall({
      scene, sensitivity, provider_id: p.id, provider_code: p.code, model: p.model, actor: opts.actor,
      status: 'ok', tokens_in: tin, tokens_out: tout, cost, latency_ms: latency,
      prompt_len: String(opts.prompt || '').length, prompt_digest: digest(opts.prompt)
    });

    return { ok: true, answer: String(answer).trim(), source: 'ai', provider: p.code, model: p.model, latency_ms: latency, cost };
  } catch (e) {
    clearTimeout(timer);
    const latency = Date.now() - t0;
    const reason = e.name === 'AbortError'
      ? `调用超时（>${p.timeout_ms}ms 已中断）`
      : `调用失败：${e.message}`;
    logCall({
      scene, sensitivity, provider_id: p.id, provider_code: p.code, model: p.model, actor: opts.actor,
      status: 'error', reason, latency_ms: latency,
      prompt_len: String(opts.prompt || '').length, prompt_digest: digest(opts.prompt)
    });
    return { ok: false, source: 'rule', reason, provider: p.code, model: p.model, latency_ms: latency };
  }
}

/** 网关总览：供应商、预算用量、近 7 天调用分布 */
function overview() {
  ensureDefaults();
  const providers = db.prepare('SELECT * FROM ai_providers ORDER BY priority ASC, id ASC').all().map((p) => {
    const u = usability(p, p.data_scope);
    return {
      id: p.id, code: p.code, name: p.name, vendor: p.vendor, model: p.model,
      base_url: p.base_url, key_env: p.key_env, key_masked: p.key_masked, has_key: hasKey(p),
      data_scope: p.data_scope, region: p.region, status: p.status, status_label: statusLabel(p.status),
      monthly_budget: r2(p.monthly_budget), used_amount: r2(p.used_amount),
      budget_left: r2(Number(p.monthly_budget) - Number(p.used_amount)),
      used_pct: Number(p.monthly_budget) > 0
        ? Math.min(100, Math.round((Number(p.used_amount) / Number(p.monthly_budget)) * 1000) / 10) : 0,
      timeout_ms: p.timeout_ms, priority: p.priority, note: p.note,
      ready: u.ok, blocked_reason: u.ok ? null : u.reason
    };
  });

  const callStat = db.prepare(
    `SELECT status, COUNT(*) c, COALESCE(SUM(cost),0) cost, COALESCE(AVG(latency_ms),0) ms
     FROM ai_calls WHERE created_at >= date('now','-30 day') GROUP BY status`
  ).all();
  const byScene = db.prepare(
    `SELECT scene, COUNT(*) c, COALESCE(SUM(cost),0) cost,
       SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok_cnt,
       SUM(CASE WHEN status='fallback' THEN 1 ELSE 0 END) fb_cnt
     FROM ai_calls GROUP BY scene ORDER BY c DESC`
  ).all();

  const today = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(cost),0) s FROM ai_calls WHERE substr(created_at,1,10)=date('now','localtime')").get();

  return {
    providers,
    ready_count: providers.filter((p) => p.ready).length,
    enabled_count: providers.filter((p) => p.status === 'enabled').length,
    has_any_key: providers.some((p) => p.has_key),
    call_stat: callStat,
    by_scene: byScene.map((s) => ({ ...s, scene_label: (SCENES[s.scene] || {}).name || s.scene })),
    today_calls: Number(today.c), today_cost: r2(today.s),
    total_cost: r2(db.prepare('SELECT COALESCE(SUM(cost),0) s FROM ai_calls').get().s),
    scenes: Object.entries(SCENES).map(([k, v]) => ({ code: k, name: v.name, sensitivity: v.sensitivity })),
    mode: providers.some((p) => p.ready) ? 'ai' : 'rule',
    mode_label: providers.some((p) => p.ready) ? '模型可用' : '规则模式（未接入模型，全部由确定性规则作答）'
  };
}

module.exports = {
  SCENES, SCOPE_RANK, ensureDefaults, call, overview, pickProvider, usability,
  hasKey, statusLabel, logCall, maskEnv, r2, r4
};
