/** 隔离临时库/API：付款凭证私有存储、边界、主体权限及预单回读；不记收款。 */
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');
process.chdir(path.resolve(__dirname, '..')); require('dotenv').config();
const multi = process.argv.includes('--multi');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-preorder-payments-'));
fs.writeFileSync(path.join(folder, '.smoke-owned'), '__SMOKE private payment proofs');
Object.assign(process.env, { DB_PATH: path.join(folder, '__SMOKE.db'), ERP_SCHEDULER: '0', SINGLE_COMPANY: multi ? '0' : '1', NODE_ENV: 'development',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '__SMOKE_password_123!', CORS_ORIGIN: '*' });
for (const key of Object.keys(process.env)) if (/^(DINGTALK_|SMTP_|OPENAI_|AI_API_)/.test(key)) process.env[key] = '';
const { db, now } = require('../src/db');
const proofs = require('../src/services/preOrderPaymentProofs');
let server, base, token, checks = 0, sequence = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const sign = id => require('jsonwebtoken').sign({ sub: id, tv: 0 }, require('../src/config').jwtSecret);
function insert(table, values) { const keys = Object.keys(values); return Number(db.prepare('INSERT INTO ' + table + '(' + keys.join(',') + ') VALUES(' + keys.map(() => '?').join(',') + ')').run(...keys.map(key => values[key])).lastInsertRowid); }
async function request(method, route, value, status = 200, auth = token) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json(); equal(response.status, status, method + ' ' + route + ': ' + JSON.stringify(result)); return result.data;
}
async function download(url, status = 200, auth = token) {
  const response = await fetch(base + url, { headers: auth ? { Authorization: 'Bearer ' + auth } : {} });
  equal(response.status, status, 'download ' + url); return response;
}
const content = {
  'image/png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hGsAAAAASUVORK5CYII=', 'base64'),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]),
  'image/gif': Buffer.from('GIF89a\0\0\0\0'),
  'image/webp': Buffer.from('RIFF0000WEBPVP8 '),
  'application/pdf': Buffer.from('%PDF-1.4\n__SMOKE payment proof\n%%EOF\n')
};
const dataUrl = (mime, buf = content[mime]) => 'data:' + mime + ';base64,' + buf.toString('base64');
const count = () => db.prepare('SELECT COUNT(*) n FROM pre_order_payment_files').get().n;
let archiveId;
function body(payment_proofs) { return { order_no: '__SMOKE-PAYMENT-' + (++sequence), customer_name: '__SMOKE客户', payment_ratio: 30, payment_proofs,
  items: [{ source_type: 'archive', sample_archive_id: archiveId, size_prices: [{ color: '红', size: 'S', qty: 2, unit_price: 12.5 }] }] }; }
(async () => {
  equal(db.prepare('PRAGMA table_info(pre_orders)').all().some(column => column.name === 'payment_proofs_json'), true);
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  base = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(folder, 'server.log'), 'w');
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log);
  let health;
  for (let attempt = 0; attempt < 150; attempt++) { if (server.exitCode !== null) throw Error('isolated server stopped: ' + fs.readFileSync(path.join(folder, 'server.log'), 'utf8')); try { health = await (await fetch(base + '/api/health')).json(); if (health.ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  equal(health?.pid, server.pid, 'test server owns port');
  token = sign(db.prepare("SELECT id FROM users WHERE username='admin'").get().id);
  const company2 = insert('companies', { code: '__SMOKE-PAY-OTHER', name: '__SMOKE另一主体', created_at: now() });
  const user = (role, company = 1) => sign(insert('users', { username: '__SMOKE-pay-' + role + '-' + company, role, company_id: company, active: 1, password_hash: 'unused', created_at: now() }));
  const sales = user('sales'), other = user('sales', company2), tech = user('tech'), finance = user('finance');
  const stamp = now(), sourceOrder = insert('orders', { order_no: '__SMOKE-PAY-SOURCE', company_id: 1, created_at: stamp, updated_at: stamp });
  archiveId = require('./sales-entry-sample-fixture')(db, stamp);
  db.prepare('UPDATE tech_packs SET order_id=? WHERE id=(SELECT tech_pack_id FROM sample_archives WHERE id=?)').run(sourceOrder, archiveId);

  const uploaded = [];
  for (const [mime, buf] of Object.entries(content)) {
    const proof = await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl(mime), filename: '__SMOKE-付款凭证.' + mime.split('/')[1] }, 200, sales);
    uploaded.push(proof); equal(proof.mime, mime); equal(proof.size, buf.length);
    equal(/^\/api\/pre-orders\/payment-proofs\/[a-f0-9]{20}\.(png|jpg|webp|gif|pdf)$/.test(proof.url), true);
    const response = await download(proof.url, 200, sales);
    equal(Buffer.from(await response.arrayBuffer()), buf);
    equal(response.headers.get('content-type'), mime);
    equal(response.headers.get('x-content-type-options'), 'nosniff');
    equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const beforeInvalid = count();
  for (const value of ['data:text/plain;base64,eA==', 'data:image/svg+xml;base64,PHN2Zz4=', dataUrl('image/png', content['application/pdf']), 'data:image/png;base64,not!base64', 'data:image/png;base64,', dataUrl('image/png') + '\n'])
    await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: value, filename: '__SMOKE-bad.png' }, 400);
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('image/png'), filename: '../__SMOKE.png' }, 400);
  equal(count(), beforeInvalid, 'invalid uploads create no registry entry');
  const boundary = Buffer.alloc(10 * 1024 * 1024, 32); content['application/pdf'].copy(boundary);
  const large = await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('application/pdf', boundary), filename: '__SMOKE-10MB.pdf' });
  equal(large.size, boundary.length, '10MB binary fits scoped JSON parser');
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('application/pdf', Buffer.concat([boundary, Buffer.from('x')])), filename: '__SMOKE-over.pdf' }, 400);
  equal(count(), beforeInvalid + 1, 'oversize creates no registry entry');
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('image/png') }, 401, null);
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('image/png') }, 403, tech);
  const proof = uploaded[0], name = proof.url.split('/').at(-1);
  await download(proof.url, 401, null); await download(proof.url, 403, finance); await download(proof.url, 200, tech);
  await download(proof.url, multi ? 404 : 200, other);
  await download('/uploads/private/pre-order-payments/' + name, 404, null);
  for (const prefix of ['/uploads/%70rivate/pre-order-payments/', '/uploads/private%2fpre-order-payments%2f', '/uploads/PRIVATE/pre-order-payments/', '/uploads/private%5cpre-order-payments%5c', '/uploads/private.%2fpre-order-payments/', '/uploads/photos/..%5cprivate/pre-order-payments/']) await download(prefix + name, 404, null);
  const missingPublic = await fetch(base + '/uploads/' + name);
  equal(String(missingPublic.headers.get('content-type')).startsWith('image/'), false, 'no public image exists (SPA may answer missing image with HTML)');
  assert.notDeepEqual(Buffer.from(await missingPublic.arrayBuffer()), content['image/png']); checks++;
  await download('/api/files/att/' + name, 404);
  await download('/api/files/att/pre-order-payments/' + name, 404);
  await request('POST', '/api/files/signed-url', { name }, 404);
  await download('/api/pre-orders/payment-proofs/%2e%2e%2F' + name, 404);
  await download(proof.url + '?expires=9999999999999&sig=forged', 401, null);
  const positionId = insert('users', { username: '__SMOKE-pay-position', role: 'sales', company_id: 1, active: 1, password_hash: 'unused', created_at: now() });
  const positionConfig = perms => ({ revision: 1, positions: [{ id: '__SMOKE-pay-position', direct: true, roles: ['sales'], selected_perms: perms }], bindings: { [positionId]: '__SMOKE-pay-position' }, history: [] });
  const setPosition = perms => db.prepare('INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('access_positions_v1', JSON.stringify(positionConfig(perms)), now());
  setPosition(['action.pre-orders.create']);
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('image/png'), filename: '__SMOKE-position.png' }, 200, sign(positionId));
  setPosition(['action.pre-orders.edit']);
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('image/png'), filename: '__SMOKE-position-edit.png' }, 200, sign(positionId));
  setPosition(['module.pre-orders.read']);
  await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('image/png') }, 403, sign(positionId));
  await download(proof.url, 200, sign(positionId));

  let pre = await request('POST', '/api/pre-orders', body([{ ...proof, filename: 'FORGED', size: 0, mime: 'text/html' }]));
  equal(pre.payment_proofs, [proof], 'canonical metadata comes from registry'); equal(pre.total_usd, 25); equal(pre.payment_ratio, 30); equal(pre.status, 'open');
  equal((await request('GET', '/api/pre-orders/' + pre.id)).payment_proofs, [proof]);
  equal((await request('GET', '/api/pre-orders')).find(row => row.id === pre.id).payment_proofs, [proof]);
  const legacy = { ...pre, payment_proofs_json: '[]', requirements: '__SMOKE old client' }; delete legacy.payment_proofs;
  pre = await request('PUT', '/api/pre-orders/' + pre.id, legacy);
  equal(pre.payment_proofs, [proof], 'old clients preserve stored proof references');
  pre = await request('PUT', '/api/pre-orders/' + pre.id, { ...pre, payment_proofs: [] }); equal(pre.payment_proofs, []);
  pre = await request('PUT', '/api/pre-orders/' + pre.id, { ...pre, payment_proofs: uploaded }); equal(pre.payment_proofs, uploaded);
  const saved = db.prepare('SELECT * FROM pre_orders WHERE id=?').get(pre.id);
  for (const payment_proofs of [null, {}, Array(11).fill(proof), [proof, proof], [{ url: '/uploads/' + name }], [{ url: 'https://example.com' + proof.url }], [{ url: proof.url + '?x=1' }]]) {
    await request('PUT', '/api/pre-orders/' + pre.id, { ...pre, payment_proofs }, 400);
    equal(db.prepare('SELECT * FROM pre_orders WHERE id=?').get(pre.id), saved, 'bad references do not partially save');
  }
  const foreign = await request('POST', '/api/pre-orders/payment-proofs/upload', { dataUrl: dataUrl('application/pdf'), filename: '__SMOKE-other.pdf' }, 200, other);
  await request('PUT', '/api/pre-orders/' + pre.id, { ...pre, payment_proofs: [foreign] }, multi ? 404 : 200, sales);
  if (multi) await request('POST', '/api/pre-orders', body([foreign]), 400);
  // Single-company update above increments version; always reload before completing.
  pre = await request('GET', '/api/pre-orders/' + pre.id);
  pre = await request('PUT', '/api/pre-orders/' + pre.id, { ...pre, payment_proofs: uploaded });
  const completed = await request('POST', '/api/pre-orders/' + pre.id + '/complete', { version: pre.version });
  equal(completed.payment_proofs, uploaded); equal(completed.total_usd, 25); equal(completed.payment_ratio, 30);
  equal((await request('GET', '/api/pre-orders/' + pre.id + '/order-draft')).payment_proofs, uploaded);
  equal(db.prepare('SELECT COUNT(*) n FROM pre_order_payment_files WHERE uploaded_by IS NULL OR company_id IS NULL').get().n, 0);
  console.log('PASS ' + checks + ' pre-order payment-proof assertions (' + (multi ? 'multi-company' : 'single-company') + ')');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  // 仅清除此隔离库登记过的随机文件，不按共享目录或真实记录批量删除。
  for (const row of db.prepare('SELECT name FROM pre_order_payment_files').all()) {
    if (!/^[a-f0-9]{20}\.(png|jpg|webp|gif|pdf)$/.test(row.name)) throw Error('Unsafe test file name');
    const target = path.resolve(proofs.DIRECTORY, row.name);
    if (path.dirname(target) !== proofs.DIRECTORY) throw Error('Unsafe test cleanup path');
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  db.close();
  const actual = fs.realpathSync(folder), root = fs.realpathSync(os.tmpdir()), relative = path.relative(root, actual);
  if (relative.startsWith('erp-preorder-payments-') && !relative.includes(path.sep) && fs.existsSync(path.join(actual, '.smoke-owned'))) fs.rmSync(actual, { recursive: true, force: true });
  else throw Error('Refusing cleanup outside test-owned temporary directory');
});
