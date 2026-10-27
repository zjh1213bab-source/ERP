/**
 * 备份 / 恢复演练（两阶段，验证恢复真的生效且不丢数据）
 *
 *   node scripts/restore-drill.js --phase backup
 *     ① 下载当前库快照 ② 记录各表基线行数 ③ 写入一条 DRILL 标记客户
 *     ④ 上传快照准备恢复（重启后生效）
 *
 *   （重启后端）
 *
 *   node scripts/restore-drill.js --phase verify
 *     ⑤ 对比基线行数是否一致 ⑥ 确认 DRILL 标记已被回滚掉
 *
 * 只增删自己那条标记数据，其余数据靠「快照回滚」自然复原，不会破坏业务数据。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123456';
const DATA_DIR = path.resolve(__dirname, '../data');
const BACKUP_FILE = path.join(DATA_DIR, '_drill-backup.db');
const STATE_FILE = path.join(DATA_DIR, '_drill-state.json');
const MARKER = 'DRILL-恢复演练-可删除';

const TABLES = [
  'orders', 'customers', 'products', 'materials', 'users', 'stock_items',
  'quotations', 'payrolls', 'assets', 'admin_expenses', 'tech_packs', 'employees'
];

async function login() {
  const r = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })).json();
  if (!r.ok) throw new Error('登录失败：' + (r.message || ''));
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.data.token };
}

const get = (h, p) => fetch(BASE + p, { headers: h }).then((r) => r.json());
const post = (h, p, b) =>
  fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b || {}) }).then((r) => r.json());

async function counts(h) {
  const out = {};
  for (const t of TABLES) {
    // 用各模块列表接口的条数代替直接读库，确保走的是对外 API
    let n = null;
    if (t === 'orders') n = (await get(h, '/api/orders')).data.length;
    else if (t === 'customers') n = (await get(h, '/api/customers')).data.length;
    else if (t === 'products') n = (await get(h, '/api/products')).data.length;
    else if (t === 'materials') n = (await get(h, '/api/materials')).data.length;
    else if (t === 'users') n = (await get(h, '/api/users')).data.length;
    else if (t === 'stock_items') n = (await get(h, '/api/stock')).data.length;
    else if (t === 'quotations') n = (await get(h, '/api/quotations')).data.length;
    else if (t === 'payrolls') n = (await get(h, '/api/payrolls')).data.length;
    else if (t === 'assets') n = (await get(h, '/api/assets')).data.length;
    else if (t === 'admin_expenses') n = (await get(h, '/api/admin-expenses')).data.length;
    else if (t === 'tech_packs') n = (await get(h, '/api/techpacks/all')).data.length;
    else if (t === 'employees') n = (await get(h, '/api/employees')).data.length;
    out[t] = n;
  }
  return out;
}

async function phaseBackup() {
  const h = await login();
  console.log('\n① 下载数据库快照…');
  const res = await fetch(BASE + '/api/admin/backup', { headers: h });
  if (!res.ok) throw new Error('备份下载失败：HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    throw new Error('下载到的不是 SQLite 文件');
  }
  fs.writeFileSync(BACKUP_FILE, buf);
  console.log(`   ✓ 快照 ${(buf.length / 1024).toFixed(1)} KB → ${path.basename(BACKUP_FILE)}`);

  console.log('② 记录各表基线行数…');
  const base = await counts(h);
  console.log('   ' + JSON.stringify(base));

  console.log('③ 写入 DRILL 标记数据…');
  const marker = await post(h, '/api/customers', { name: MARKER, code: 'DRILL-TMP', level: 'C' });
  if (!marker.ok) throw new Error('写入标记失败：' + marker.message);
  await post(h, '/api/admin-expenses', {
    expense_date: new Date().toISOString().slice(0, 10), category: '其他', amount: 1,
    payee: MARKER, remark: '恢复演练标记，可删除'
  });
  const after = await counts(h);
  console.log('   标记后行数：' + JSON.stringify(after));

  console.log('④ 上传快照准备恢复…');
  const r = await post(h, '/api/admin/restore', { base64: buf.toString('base64') });
  if (!r.ok) throw new Error('恢复上传失败：' + r.message);
  console.log('   ✓ ' + r.data.message);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ base, after, marker: MARKER, at: new Date().toISOString() }, null, 2));
  console.log('\n下一步：重启后端服务，然后运行');
  console.log('  node scripts/restore-drill.js --phase verify\n');
}

async function phaseVerify() {
  if (!fs.existsSync(STATE_FILE)) throw new Error('没找到 ' + path.basename(STATE_FILE) + '，请先跑 --phase backup');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const h = await login();

  console.log('\n⑤ 对比基线行数…');
  const now = await counts(h);
  let diff = 0;
  Object.keys(state.base).forEach((t) => {
    const a = state.base[t];
    const b = now[t];
    const ok = a === b;
    if (!ok) diff++;
    console.log(`   ${ok ? '✓' : '✗'} ${t}: 基线 ${a} → 现在 ${b}`);
  });

  console.log('\n⑥ 检查 DRILL 标记是否已被回滚…');
  const customers = (await get(h, '/api/customers')).data;
  const stillThere = customers.filter((c) => c.name === MARKER || c.code === 'DRILL-TMP');
  const expenses = (await get(h, '/api/admin-expenses')).data;
  const expStill = expenses.filter((e) => e.payee === MARKER);
  console.log(`   客户标记：${stillThere.length ? '✗ 仍存在（恢复未生效）' : '✓ 已回滚'}`);
  console.log(`   费用标记：${expStill.length ? '✗ 仍存在' : '✓ 已回滚'}`);

  const pass = diff === 0 && !stillThere.length && !expStill.length;
  console.log('\n' + (pass ? '✓ 恢复演练通过：数据完整、标记已回滚' : '✗ 恢复演练未通过，请检查'));
  if (pass) {
    try { fs.unlinkSync(STATE_FILE); fs.unlinkSync(BACKUP_FILE); } catch (e) { /* ignore */ }
    console.log('（演练临时文件已清理）');
  }
  process.exit(pass ? 0 : 1);
}

const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'backup';

(phase === 'verify' ? phaseVerify() : phaseBackup()).catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
