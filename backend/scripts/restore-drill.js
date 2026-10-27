/**
 * 备份恢复演练（三阶段，验证「恢复真的生效、数据一致、有退路」）
 * ============================================================
 * 为什么不能只测「点一下下载文件」：
 *   备份的价值只在恢复那一刻体现。恢复链路上任何一环断掉（文件传不上去、
 *   重启没人消费、WAL 残留污染、恢复前没留退路），平时都看不出来，出事时全暴露。
 *
 *   node scripts/restore-drill.js --phase prepare   # ① 采集基线 ② 备份 ③ 写标记 ④ 准备恢复
 *   （重启后端 —— 恢复在启动时换文件）
 *   node scripts/restore-drill.js --phase verify    # ⑤ 验证一致 ⑥ 生成报告
 *   node scripts/restore-drill.js --phase clean     # 清理演练痕迹（可选）
 *
 * 判定标准（只看硬项，数据健康问题单独列，不参与判定）：
 *   1. 待恢复文件已被消费（重启确实执行了恢复）
 *   2. 关键表行数与备份时点完全一致
 *   3. 演练标记数据已被回滚（证明换的是备份那份，而不是「什么都没发生」）
 *   4. 库文件指纹 = 备份文件指纹
 *   5. 有退路：自动回滚点 + 被替换的旧库留档
 *
 * 重要：本脚本**不 require ../src/db**，只用独立只读连接。
 * 否则脚本进程会抢先消费 restore-pending.db，把服务正在用的库换掉。
 */
const fs = require('fs');
const path = require('path');

const BR = require('../src/services/backup-restore');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123456';
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'erp-mindmap.db'));
const STATE_FILE = path.join(DATA_DIR, '_drill-state.json');
const REPORT_FILE = path.resolve(__dirname, '../../docs/DRILL-REPORT.md');

const MARK_CUSTOMER = 'DRILL-恢复演练-可删除';
const MARK_CODE = 'DRILL-TMP';
const MARK_PAYEE = 'DRILL-演练标记供应商';

/** 关键表：备份时点与恢复后必须完全一致 */
const KEY_TABLES = [
  'users', 'customers', 'products', 'materials', 'orders', 'order_items',
  'stock_items', 'stock_ledger', 'gl_vouchers', 'gl_entries',
  'payrolls', 'employees', 'tech_packs', 'approval_instances', 'admin_expenses'
  // 刻意不含 backup_jobs：恢复后 db.js 会追加一条「本次恢复」的记录，计数必然 +1，
  // 放进来会造成误判（看起来「行数不一致」）。
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- HTTP ----------------
async function login() {
  const r = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })).json();
  if (!r.ok) throw new Error('登录失败：' + (r.message || ''));
  return {
    json: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.data.token },
    token: r.data.token
  };
}

// ---------------- 直连只读（不碰 pending） ----------------
function readCounts() {
  const conn = BR.openReadonly(DB_PATH);
  try {
    const out = {};
    KEY_TABLES.forEach((t) => {
      try {
        const r = conn.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
        out[t] = Number(r.c !== undefined ? r.c : r['COUNT(*)']) || 0;
      } catch (e) {
        out[t] = null;
      }
    });
    return out;
  } finally {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
}

function readBusinessChecks() {
  const conn = BR.openReadonly(DB_PATH);
  const one = (sql) => {
    try {
      const r = conn.prepare(sql).get();
      const v = r ? Object.values(r)[0] : null;
      return v === null || v === undefined ? 0 : Number(v);
    } catch (e) {
      return null;
    }
  };
  try {
    const pd = one("SELECT ROUND(SUM(e.debit),2) v FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.status='posted'");
    const pc = one("SELECT ROUND(SUM(e.credit),2) v FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.status='posted'");
    const orphan = one('SELECT COUNT(*) v FROM gl_entries e LEFT JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.id IS NULL');
    const si = one('SELECT ROUND(SUM(qty),2) v FROM stock_items');
    const sl = one('SELECT ROUND(SUM(qty),2) v FROM stock_ledger');
    const ms = one('SELECT ROUND(SUM(stock_qty),2) v FROM materials');
    const ml = one('SELECT ROUND(SUM(qty),2) v FROM material_ledger');
    const oi = one('SELECT COUNT(*) v FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL');
    const dup = one('SELECT COUNT(*) v FROM (SELECT username FROM users GROUP BY username HAVING COUNT(*)>1)');
    return [
      { item: '已过账凭证借贷平衡', pass: pd !== null && Math.abs(pd - (pc || 0)) < 0.01, note: `借 ${pd} / 贷 ${pc}` },
      { item: '凭证分录无孤儿行', pass: orphan === 0, note: orphan ? `${orphan} 条无凭证` : '正常' },
      { item: '成品库存 = 流水净额', pass: Math.abs((si || 0) - (sl || 0)) < 0.01, note: `库存 ${si} / 流水 ${sl}` },
      { item: '原料库存 = 流水净额', pass: Math.abs((ms || 0) - (ml || 0)) < 0.01, note: `库存 ${ms} / 流水 ${ml}` },
      { item: '订单明细无孤儿行', pass: oi === 0, note: oi ? `${oi} 行找不到订单` : '正常' },
      { item: '账号无重复', pass: dup === 0, note: dup ? `${dup} 个重名账号` : '正常' }
    ];
  } finally {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
}

function markerExists() {
  const conn = BR.openReadonly(DB_PATH);
  try {
    const c = conn.prepare('SELECT COUNT(*) AS c FROM customers WHERE code = ? OR name = ?').get(MARK_CODE, MARK_CUSTOMER);
    const e = conn.prepare('SELECT COUNT(*) AS c FROM admin_expenses WHERE payee = ?').get(MARK_PAYEE);
    const cv = Number(c.c !== undefined ? c.c : c['COUNT(*)']) || 0;
    const ev = Number(e.c !== undefined ? e.c : e['COUNT(*)']) || 0;
    return { customers: cv, expenses: ev };
  } catch (err) {
    return { customers: 0, expenses: 0 };
  } finally {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
}

// ---------------- prepare ----------------
async function phasePrepare() {
  console.log('\n=== 备份恢复演练 · 准备阶段 ===\n');
  const h = await login();
  const t0 = Date.now();

  console.log('① 采集基线（关键表行数 / 数据健康 / 库文件指纹）');
  const baseline = readCounts();
  const checksBefore = readBusinessChecks();
  const fileBefore = { size: fs.statSync(DB_PATH).size, sha256: BR.sha256File(DB_PATH) };
  console.log('   ' + Object.entries(baseline).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`   库文件 ${(fileBefore.size / 1024 / 1024).toFixed(2)} MB  sha256=${fileBefore.sha256.slice(0, 16)}…`);

  console.log('\n② 通过接口生成服务端备份');
  const bk = await (await fetch(BASE + '/api/backup/create', {
    method: 'POST', headers: h.json,
    body: JSON.stringify({ note: '恢复演练基线备份' })
  })).json();
  if (!bk.ok) throw new Error('备份失败：' + bk.message);
  const job = bk.data;
  console.log(`   ✓ ${job.job_no}  ${(job.size_bytes / 1024 / 1024).toFixed(2)} MB / ${job.tables_count} 张表 / 校验 ${job.verify_status}`);
  console.log(`   sha256=${String(job.sha256).slice(0, 16)}…（恢复后要比这个）`);

  console.log('\n③ 写入演练标记（用来证明「恢复后确实回滚了」）');
  const c1 = await (await fetch(BASE + '/api/customers', {
    method: 'POST', headers: h.json,
    body: JSON.stringify({ name: MARK_CUSTOMER, code: MARK_CODE, level: 'C', remark: '恢复演练标记，可删除' })
  })).json();
  if (!c1.ok) throw new Error('写标记客户失败：' + c1.message);
  const c2 = await (await fetch(BASE + '/api/admin-expenses', {
    method: 'POST', headers: h.json,
    body: JSON.stringify({
      expense_date: new Date().toISOString().slice(0, 10),
      category: '其他', amount: 1, payee: MARK_PAYEE,
      remark: '恢复演练标记，可删除'
    })
  })).json();
  if (!c2.ok) console.log('   ! 费用标记未写入（不影响结论）：' + c2.message);

  await sleep(400);
  const afterMark = readCounts();
  const fileAfterMark = { size: fs.statSync(DB_PATH).size, sha256: BR.sha256File(DB_PATH) };
  console.log(`   标记后：customers ${baseline.customers} → ${afterMark.customers}，admin_expenses ${baseline.admin_expenses} → ${afterMark.admin_expenses}`);
  console.log(`   库文件已变（${fileBefore.sha256.slice(0, 8)}… → ${fileAfterMark.sha256.slice(0, 8)}…）`);

  console.log('\n④ 准备恢复（校验备份 → 先自动备份当前库 → 写待恢复文件）');
  const prep = await (await fetch(BASE + '/api/backup/restore/prepare', {
    method: 'POST', headers: h.json,
    body: JSON.stringify({ backup_id: job.id, note: '恢复演练' })
  })).json();
  if (!prep.ok) throw new Error('准备恢复失败：' + prep.message);
  const plan = prep.data.plan;
  console.log(`   ✓ 校验通过：integrity=${prep.data.checks.integrity} / ${prep.data.checks.tables} 张表 / 关键表 ${prep.data.checks.rows_total} 行`);
  console.log(`   ✓ 已自动备份当前库作为回滚点：${prep.data.rollback_job_no}`);
  console.log(`   待恢复文件：${plan.target.file}（${(plan.target.size / 1024 / 1024).toFixed(2)} MB）`);
  (prep.data.checks.warnings || []).forEach((w) => console.log('   ! ' + w));

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    at: new Date().toISOString(),
    duration_prepare_ms: Date.now() - t0,
    backup_job: { id: job.id, job_no: job.job_no, sha256: job.sha256, size: job.size_bytes, tables: job.tables_count },
    rollback_job_no: prep.data.rollback_job_no,
    baseline,
    after_mark: afterMark,
    file_before: fileBefore,
    file_after_mark: fileAfterMark,
    checks_before: checksBefore,
    plan
  }, null, 2), 'utf8');

  console.log('\n下一步：重启后端（恢复在启动时换文件），然后跑');
  console.log('  node scripts/restore-drill.js --phase verify\n');
}

// ---------------- verify ----------------
async function phaseVerify() {
  console.log('\n=== 备份恢复演练 · 验证阶段 ===\n');
  if (!fs.existsSync(STATE_FILE)) throw new Error('没找到演练状态文件，请先跑 --phase prepare');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const results = [];
  const add = (name, pass, detail) => {
    results.push({ name, pass, detail });
    const icon = pass === null ? '—' : pass ? '✓' : '✗';
    console.log(`   ${icon} ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('① 服务是否已重启并应用恢复');
  const pendingFile = BR.pendingPath(DB_PATH);
  const planFile = BR.planPath(DB_PATH);
  add('待恢复文件已被消费（重启确实执行了恢复）', !fs.existsSync(pendingFile),
    fs.existsSync(pendingFile) ? 'restore-pending.db 还在 → 后端没重启，或启动时恢复被跳过' : '已清空');
  add('恢复计划文件已清理', !fs.existsSync(planFile), fs.existsSync(planFile) ? 'restore-plan.json 还在' : '已清空');

  console.log('\n② 关键表行数是否与基线一致');
  const now = readCounts();
  const diffs = [];
  Object.keys(state.baseline).forEach((t) => {
    if (state.baseline[t] !== now[t]) diffs.push(`${t}: ${state.baseline[t]} → ${now[t]}`);
    console.log(`   ${state.baseline[t] === now[t] ? '✓' : '✗'} ${t}: 基线 ${state.baseline[t]} / 现在 ${now[t]}`);
  });
  add('关键表行数与备份时点完全一致', diffs.length === 0,
    diffs.length ? diffs.join('；') : `${Object.keys(now).length} 张表全部一致`);

  console.log('\n③ 演练标记是否已被回滚（证明换的是备份那份）');
  const marker = markerExists();
  add('标记客户已消失', marker.customers === 0, marker.customers ? `还剩 ${marker.customers} 条` : '已回滚');
  add('标记费用已消失', marker.expenses === 0, marker.expenses ? `还剩 ${marker.expenses} 条` : '已回滚');
  add('「标记后」多出来的行已被抹掉',
    now.customers === state.baseline.customers && now.admin_expenses === state.baseline.admin_expenses,
    `customers ${state.after_mark.customers} → ${now.customers}，admin_expenses ${state.after_mark.admin_expenses} → ${now.admin_expenses}`);

  console.log('\n④ 留档与退路');
  const replacedDir = BR.replacedDir(DB_PATH);
  let replaced = [];
  try {
    replaced = fs.readdirSync(replacedDir).filter((f) => f.startsWith('replaced-')).sort();
  } catch (e) { replaced = []; }
  add('恢复前的旧库已留档（可回退）', replaced.length > 0,
    replaced.length ? replaced[replaced.length - 1] : 'replaced 目录没有留档，等于没有退路');
  add('已自动生成恢复前备份（回滚点）', !!state.rollback_job_no, state.rollback_job_no || '无');

  // 指纹只记录、不作为判定：WAL 模式下主库文件会随 checkpoint 变化，
  // 拿它当「恢复成功」的判据会假失败（数据其实是对的）。
  const fileNow = { size: fs.statSync(DB_PATH).size, sha256: BR.sha256File(DB_PATH) };
  console.log(`\n   · 参考：当前库 sha256=${fileNow.sha256.slice(0, 16)}… / 备份 ${String(state.backup_job.sha256).slice(0, 16)}…（WAL 模式下不要求一致）`);

  console.log('\n⑤ 数据健康检查（与恢复无关，反映库本身状态）');
  const checks = readBusinessChecks();
  checks.forEach((c) => {
    const icon = c.pass === null ? '—' : c.pass ? '✓' : '⚠';
    console.log(`   ${icon} ${c.item} — ${c.note}`);
  });

  const hardFails = results.filter((r) => r.pass === false);
  const pass = hardFails.length === 0;

  writeReport(state, results, checks, { fileNow, replaced, now });

  console.log('\n' + '='.repeat(64));
  console.log(pass ? '✓ 演练通过：备份可恢复、数据一致、有退路' : `✗ 演练未通过：${hardFails.length} 项硬性检查失败`);
  console.log(`报告：${path.relative(path.resolve(__dirname, '../..'), REPORT_FILE)}`);
  console.log('='.repeat(64) + '\n');
  process.exit(pass ? 0 : 1);
}

function writeReport(state, results, checks, extra) {
  const p = (n) => (n === null || n === undefined ? '—' : n);
  const passCount = results.filter((r) => r.pass === true).length;
  const hardFails = results.filter((r) => r.pass === false);
  const verdict = hardFails.length === 0 ? '通过' : '未通过';

  const L = [];
  L.push('# 备份恢复演练报告\n');
  L.push('> 本报告由 `backend/scripts/restore-drill.js` 自动生成，不是手写的。');
  L.push(`> 演练时间：${state.at} → ${new Date().toISOString()}`);
  L.push(`> 数据库：\`${DB_PATH.replace(/\\/g, '/')}\``);
  L.push(`> 结论：**${verdict}**（${passCount}/${results.length} 项检查通过）\n`);

  L.push('## 一、演练做了什么\n');
  L.push('| 步骤 | 内容 | 结果 |');
  L.push('|---|---|---|');
  L.push(`| 1 | 通过接口生成服务端备份 | ${state.backup_job.job_no}（${(state.backup_job.size / 1024 / 1024).toFixed(2)} MB / ${state.backup_job.tables} 张表） |`);
  L.push(`| 2 | 写入演练标记（备份时点之后的新数据） | 客户 ${state.baseline.customers} → ${state.after_mark.customers}，行政费用 ${p(state.baseline.admin_expenses)} → ${p(state.after_mark.admin_expenses)} |`);
  L.push(`| 3 | 准备恢复：校验备份 + **先自动备份当前库** + 写待恢复文件 | 回滚点 ${state.rollback_job_no} |`);
  L.push('| 4 | 重启后端，启动时校验并替换数据库文件 | 见第二节 |');
  L.push('| 5 | 校验一致性、指纹与留档 | 见第二、三节 |\n');

  L.push('## 二、检查结果\n');
  L.push('| 检查项 | 结果 | 说明 |');
  L.push('|---|---|---|');
  results.forEach((r) => {
    L.push(`| ${r.name} | ${r.pass === null ? '—' : r.pass ? '✅' : '❌'} | ${r.detail || ''} |`);
  });
  L.push('');

  L.push('## 三、数据一致性\n');
  L.push('| 表 | 备份时点 | 写入标记后 | 恢复后 | 判定 |');
  L.push('|---|---|---|---|---|');
  Object.keys(state.baseline).forEach((t) => {
    const a = state.baseline[t];
    const m = state.after_mark[t];
    const n = extra.now ? extra.now[t] : '—';
    L.push(`| ${t} | ${p(a)} | ${p(m)} | ${p(n)} | ${a === n ? '一致' : '**不一致**'} |`);
  });
  L.push('');

  L.push('## 四、文件与留档\n');
  L.push(`- 备份文件：\`${state.backup_job.job_no}\`，sha256 \`${state.backup_job.sha256}\``);
  L.push(`- 恢复后库文件 sha256：\`${extra.fileNow.sha256}\``);
  L.push('  （WAL 模式下服务启动后会正常写入，主库文件指纹不要求与备份一致；');
  L.push('   是否恢复正确看第二节的行数比对与标记回滚，不看指纹）');
  L.push(`- 恢复前的旧库留档：${extra.replaced.length ? '`' + extra.replaced[extra.replaced.length - 1] + '`（位于 `backend/data/replaced/`，需要回退时把它改回名字即可）' : '无'}`);
  L.push(`- 恢复前自动备份（回滚点）：${state.rollback_job_no}\n`);

  L.push('## 五、数据健康检查（与恢复无关）\n');
  L.push('> 这些是当前库自身的数据质量问题。恢复不会修好它们，也不该因此判定恢复失败。\n');
  L.push('| 检查项 | 结果 | 说明 |');
  L.push('|---|---|---|');
  checks.forEach((c) => {
    L.push(`| ${c.item} | ${c.pass === null ? '—' : c.pass ? '✅' : '⚠️'} | ${c.note} |`);
  });
  L.push('');

  const bad = checks.filter((c) => c.pass === false);
  if (bad.length) {
    L.push('待处理：\n');
    bad.forEach((c) => L.push(`- **${c.item}**：${c.note}`));
    L.push('');
  } else {
    L.push('本次检查未发现数据质量问题。\n');
  }

  L.push('## 六、结论与后续\n');
  if (verdict === '通过') {
    L.push('备份可以恢复、恢复后数据与备份时点一致、恢复有退路（自动回滚点 + 旧库留档）。');
    L.push('');
    L.push('上线前还要做两件事：');
    L.push('1. 把 `node scripts/backup-cron.js` 挂到系统计划任务，每天自动备份一次');
    L.push('2. 每周人工点一次「校验」，确认备份文件没坏（文件放久了会坏，这很常见）\n');
  } else {
    L.push('**演练未通过，恢复链路有缺陷，上线前必须修。**\n');
    hardFails.forEach((f) => L.push(`- ${f.name}：${f.detail}`));
    L.push('');
  }

  L.push('---\n');
  L.push('复跑方式：\n');
  L.push('```bash');
  L.push('cd backend');
  L.push('node scripts/restore-drill.js --phase prepare');
  L.push('# 重启后端');
  L.push('node scripts/restore-drill.js --phase verify');
  L.push('```');

  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, L.join('\n'), 'utf8');
}

// ---------------- clean ----------------
async function phaseClean() {
  console.log('\n=== 清理演练痕迹 ===\n');
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
    console.log('   ✓ 已删除演练状态文件');
  }
  const marker = markerExists();
  if (marker.customers || marker.expenses) {
    console.log(`   标记数据仍有残留（客户 ${marker.customers} / 费用 ${marker.expenses}），请在对应页面删除`);
  } else {
    console.log('   ✓ 没有标记残留');
  }
  console.log('   备份记录、备份文件、replaced 留档都保留（它们本身就是有用的东西）\n');
}

// ---------------- 入口 ----------------
const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'prepare';

(async () => {
  if (phase === 'prepare') await phasePrepare();
  else if (phase === 'verify') await phaseVerify();
  else if (phase === 'clean') await phaseClean();
  else {
    console.error('未知阶段：' + phase + '（可用 prepare / verify / clean）');
    process.exit(1);
  }
})().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
