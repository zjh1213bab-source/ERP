/**
 * 工序类别初始档案导入（幂等，可重复运行）
 * ------------------------------------------------------------
 * 数据来源：2026-11-07 用户提供的「工序类别」参考截图，按可见顺序录入 17 条，
 * 其中 5 条在截图里「是否启用倍率」为开。名称以放大后逐字核对为准。
 *
 * 做法：全部走现有 HTTP API（POST /api/craft-types、PUT /api/settings/piece-multipliers），
 * 不直接写表、不改表结构、不改 wageMultiplier 计价逻辑。倍率开关映射到全局配置
 * process_scope.craft_type_ids，由 wageMultiplier.participation() 真实判定。
 *
 * 用法：
 *   node scripts/seed-craft-categories-20261107.js              # 导入
 *   node scripts/seed-craft-categories-20261107.js --dry-run    # 只看计划
 *   ERP_BASE=http://127.0.0.1:3100 node scripts/...             # 指定后端
 *
 * 业务数据本身不入库（backend/data 已 gitignore），此脚本用于在其他环境复现。
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const BACKEND = path.resolve(__dirname, '..');
const BASE = process.env.ERP_BASE || 'http://127.0.0.1:3200';
const DRY = process.argv.includes('--dry-run');

// [名称, 截图里是否启用倍率]
const ROWS = [
  ['烫衬', false],
  ['配料配送', false],
  ['打气眼', true],
  ['点位', true],
  ['烫画', false],
  ['领料', false],
  ['领货', false],
  ['曲牙机', true],
  ['钉扣', false],
  ['打暗扣', false],
  ['花样机', true],
  ['加胸垫', false],
  ['钉纽扣', false],
  ['挂吊牌', false],
  ['烫标', false],
  ['双针', true],
  ['穿绳', false]
];

function readEnv() {
  const out = {};
  const file = path.join(BACKEND, '.env');
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

function adminToken() {
  const env = readEnv();
  if (!env.JWT_SECRET) throw new Error('backend/.env 缺少 JWT_SECRET');
  const db = new DatabaseSync(path.join(BACKEND, 'data', 'lan-preview.db'), { readOnly: true });
  const user = db.prepare("SELECT id, token_version FROM users WHERE username = 'admin'").get()
            || db.prepare('SELECT id, token_version FROM users ORDER BY id LIMIT 1').get();
  db.close();
  if (!user) throw new Error('业务库中找不到 admin 用户');
  return jwt.sign({ sub: user.id, tv: user.token_version }, env.JWT_SECRET, { expiresIn: '15m' });
}

const TOKEN = adminToken();
const unwrap = (j) => (j && j.data !== undefined ? j.data : j);

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${json.message || text.slice(0, 120)}`);
  return unwrap(json);
}

(async () => {
  console.log(`目标后端: ${BASE}${DRY ? '  [dry-run]' : ''}`);
  const existing = await call('GET', '/api/craft-types');
  const byName = new Map(existing.map((r) => [String(r.name).trim().toLowerCase(), r]));

  let created = 0, skipped = 0;
  for (const [name] of ROWS) {
    const hit = byName.get(name.toLowerCase());
    if (hit) {
      skipped++;
      if (hit.status !== 'active') console.log(`  注意：「${name}」已停用，未在页面显示（历史数据保留）`);
      continue;
    }
    if (DRY) { console.log(`  将新增: ${name}`); created++; continue; }
    const row = await call('POST', '/api/craft-types', {
      name,
      category: 'sewing',      // 截图未给类别，统一按车缝；可在页面「编辑」里调整
      unit: '件',
      default_price: 0,
      remark: '由 2026-11-07 工序类别参考截图导入'
    });
    byName.set(name.toLowerCase(), row);
    created++;
  }
  console.log(`工序档案：新增 ${created} 条，已存在跳过 ${skipped} 条`);

  const enabledNames = ROWS.filter(([, on]) => on).map(([name]) => name);
  const all = DRY ? [] : await call('GET', '/api/craft-types');
  const enabledIds = enabledNames
    .map((name) => all.find((r) => String(r.name).trim() === name && r.status === 'active')?.id)
    .filter((id) => Number.isInteger(Number(id)))
    .map(Number);
  console.log(`截图里启用倍率的 ${enabledNames.length} 条：${enabledNames.join('、')}`);
  if (DRY) { console.log('dry-run 结束，未写入任何数据'); return; }
  if (enabledIds.length !== enabledNames.length) throw new Error('部分启用倍率的工序未找到档案 id，请检查上一步');

  const cfg = await call('GET', '/api/settings/piece-multipliers');
  const scope = cfg.process_scope || { mode: 'all', categories: [], craft_type_ids: [], node_codes: [] };
  const currentIds = (scope.craft_type_ids || []).map(Number);
  // 首次初始化（mode=all）只让截图里启用的工序参与；
  // 已有 selected 配置时保留管理员原来的勾选，只补齐这 5 条，绝不擅自删别人的选择。
  const nextIds = scope.mode === 'all'
    ? enabledIds
    : [...new Set([...currentIds, ...enabledIds])];
  const unchanged = scope.mode === 'selected'
    && nextIds.length === currentIds.length
    && nextIds.every((id) => currentIds.includes(id));

  if (unchanged) {
    console.log('倍率参与范围已是目标状态，跳过保存');
  } else {
    const body = {
      revision: cfg.revision,
      enabled: cfg.enabled,
      tiers: (cfg.tiers || []).map((t) => ({ min: t.min, max: t.max ?? null, multiplier: t.multiplier })),
      process_scope: {
        mode: 'selected',
        categories: scope.categories || [],
        craft_type_ids: nextIds,
        node_codes: scope.node_codes || []
      }
    };
    await call('PUT', '/api/settings/piece-multipliers', body);
    console.log(`倍率参与范围已保存：mode=${body.process_scope.mode}，参与工序 ${nextIds.length} 条（版本 ${cfg.revision} → ${cfg.revision + 1}）`);
  }
  console.log('完成。仅影响之后的新报工计价，历史工资不回溯。');
})().catch((e) => { console.error('导入失败：' + e.message); process.exit(1); });
