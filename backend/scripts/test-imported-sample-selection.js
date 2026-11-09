/** 独立临时库回归：历史导入的完成事实、预单选择/保存及复用边界。 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config();
const multi = process.argv.includes('--multi');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-imported-sample-selection-'));
fs.writeFileSync(path.join(folder, '.smoke-owned'), '__SMOKE imported sample selection');
Object.assign(process.env, {
  DB_PATH: path.join(folder, '__SMOKE.db'), ERP_SCHEDULER: '0', NODE_ENV: 'development',
  SINGLE_COMPANY: multi ? '0' : '1', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '__SMOKE_only_password_123!', CORS_ORIGIN: '*'
});
for (const key of Object.keys(process.env)) if (/^(DINGTALK_|SMTP_|OPENAI_|AI_API_)/.test(key)) process.env[key] = '';

const { db, now } = require('../src/db');
const patterns = require('../src/routes/patternFlows');
const archives = require('../src/services/sampleArchive');
const styles = require('../src/services/preOrderStyles');
const config = require('../src/config');
const adminRow = db.prepare("SELECT * FROM users WHERE username='admin'").get();
const admin = { sub: adminRow.id, username: adminRow.username, role: 'admin', company_id: 1 };
const sign = user => require('jsonwebtoken').sign({ sub: user.sub, tv: 0 }, config.jwtSecret);
const importedImage = '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg';
let token = sign(admin), server, base, checks = 0, sequence = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equals = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
function insert(table, data) {
  const keys = Object.keys(data);
  return Number(db.prepare('INSERT INTO ' + table + '(' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')')
    .run(...keys.map(key => data[key])).lastInsertRowid);
}
function sample({ imported = true, localDone = false, companyId = 1, orphan = false } = {}) {
  const style = '__SMOKE-IMPORTED-' + (++sequence), stamp = now();
  const orderId = orphan ? 0 : insert('orders', { order_no: style + '-SOURCE', company_id: companyId, created_at: stamp, updated_at: stamp });
  const sourceKey = 'yc198:sample:' + style;
  const note = sourceKey + '\n__SMOKE 来源系统显示打版完成，历史阶段记录未导入。';
  const packId = insert('tech_packs', { order_id: orderId, product_name: style, customer_style_no: style,
    pattern_no: style, stage: 'confirmed', status: 'confirmed', image_url: importedImage, created_by: admin.sub,
    created_at: stamp, updated_at: stamp, remark: note });
  const flow = patterns.ensureFlow(packId, admin.sub);
  db.prepare("UPDATE pattern_flows SET status='done',current_stage='done',finished_at=NULL WHERE id=?").run(flow.id);
  db.prepare('UPDATE pattern_stages SET status=?,data=?,remark=?,operator=NULL,finished_at=NULL WHERE flow_id=?')
    .run(localDone ? 'done' : 'pending', JSON.stringify({ source_key: sourceKey, historical_details_imported: false }), note, flow.id);
  const archive = archives.archiveFromFlow(flow, '__SMOKE', { remark: note });
  const snapshot = JSON.parse(archive.snapshot);
  if (imported) snapshot.source = { system: '衣创', url: 'https://kr.yc198.com', source_key: sourceKey,
    imported_at: stamp, historical_details_imported: false, thumbnail_only: true,
    source_detail_access_denied: true, fields: { style, status: '打版完成' } };
  db.prepare('UPDATE sample_archives SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), archive.id);
  return { id: archive.id, packId, flowId: flow.id, style, sourceKey, snapshot };
}
function storedSource(sample) {
  return { pack: db.prepare('SELECT * FROM tech_packs WHERE id=?').get(sample.packId),
    flow: db.prepare('SELECT * FROM pattern_flows WHERE id=?').get(sample.flowId),
    stages: db.prepare('SELECT * FROM pattern_stages WHERE flow_id=? ORDER BY id').all(sample.flowId),
    archive: db.prepare('SELECT * FROM sample_archives WHERE id=?').get(sample.id) };
}
async function api(method, route, body, status = 200) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  equals(response.status, status, method + ' ' + route + ': ' + JSON.stringify(result));
  return result.data;
}
const preBody = (sample, extra = {}) => ({ order_no: '__SMOKE-PRE-' + (++sequence), customer_name: '__SMOKE客户',
  items: [{ source_type: 'archive', sample_archive_id: sample.id, expected_qty: 2, ...extra }] });
async function rejected(sample, message, status = 409, user = admin) {
  check(!styles.availableDistinct(user).some(row => row.id === sample.id), message + ': service catalog hides');
  assert.throws(() => styles.prepare(user, { source_type: 'archive', sample_archive_id: sample.id }), error => error.status === status,
    message + ': direct prepare refuses'); checks++;
  check(!(await api('GET', '/api/pre-orders/available-products')).some(row => row.id === sample.id), message + ': API catalog hides');
  const body = preBody(sample);
  await api('POST', '/api/pre-orders', body, status);
  check(!db.prepare('SELECT 1 FROM pre_orders WHERE order_no=?').get(body.order_no), message + ': no partial pre-order');
}

(async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  base = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(folder, 'server.log'), 'w');
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let health;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error('Isolated server stopped: ' + fs.readFileSync(path.join(folder, 'server.log'), 'utf8'));
    try { health = await (await fetch(base + '/api/health')).json(); if (health.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  equals(health?.pid, server.pid, 'Only exercise the server started by this test');

  const imported = sample(), original = storedSource(imported);
  check(styles.availableDistinct(admin).some(row => row.id === imported.id), 'Trusted historical import appears in shared catalog');
  const prepared = styles.prepare(admin, { source_type: 'archive', sample_archive_id: imported.id, product_name: 'FORGED', style_no: 'FORGED' });
  equals(prepared.style_no, imported.style, 'Prepare uses frozen source style');
  equals(JSON.parse(prepared.source_snapshot).snapshot.source, imported.snapshot.source, 'Prepare preserves historical evidence');
  check((await api('GET', '/api/pre-orders/available-products')).some(row => row.id === imported.id), 'Trusted import appears in pre-order picker');
  check((await api('GET', '/api/orders/entry/samples')).some(row => row.id === imported.id), 'Formal-order picker shares eligibility');
  const pre = await api('POST', '/api/pre-orders', preBody(imported, { product_name: 'FORGED', style_no: 'FORGED' }));
  equals(pre.items[0].sample_archive_id, imported.id, 'Selected historical sample persists');
  equals(pre.items[0].style_no, imported.style, 'Server rejects forged display style by authoritative mapping');
  equals(pre.items[0].effect_image_url, importedImage, 'Imported image survives pre-order save');
  equals(storedSource(imported), original, 'Selection and pre-order save leave source records unchanged');
  db.exec('BEGIN IMMEDIATE');
  let reused;
  try { reused = styles.ensureDevelopment(pre, pre.items[0], admin, true); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  equals(reused.source_archive_id, imported.id, 'Reuse links frozen source archive');
  const reuseFlow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id=?').get(reused.id);
  equals(reuseFlow.status, 'done', 'New workflow records completed reuse');
  const reuseStages = db.prepare('SELECT * FROM pattern_stages WHERE flow_id=?').all(reuseFlow.id);
  check(reuseStages.length === patterns.STAGE_KEYS.length && reuseStages.every(row => {
    const data = JSON.parse(row.data);
    return row.status === 'done' && data.historical_details_imported === false && data.source_key === imported.sourceKey &&
      data.completion_basis === 'imported_sample_reuse' && row.remark.includes('来源历史阶段记录未导入');
  }), 'Reuse records source historical uncertainty and reuse confirmation');
  equals(storedSource(imported), original, 'Reuse does not change original archive or unknown stages');
  check(original.stages.every(row => row.status === 'pending' && !row.operator && !row.finished_at), 'Original unknown stages remain pending with no fabricated reviewer or completion date');
  const completed = await api('POST', '/api/pre-orders/' + pre.id + '/complete', { version: pre.version });
  const draft = await api('GET', '/api/pre-orders/' + completed.id + '/order-draft');
  equals(draft.items[0].effect_image_url, importedImage, 'Imported image survives formal-order transfer draft');
  equals(JSON.parse(draft.items[0].source_snapshot).image_url, importedImage, 'Frozen source image survives formal-order transfer draft');
  equals(storedSource(imported), original, 'Completing and transferring leave source records unchanged');

  const completeNative = sample({ imported: false, localDone: true });
  check((await api('GET', '/api/pre-orders/available-products')).some(row => row.id === completeNative.id), 'Complete native sample remains selectable');
  const incompleteNative = sample({ imported: false });
  await rejected(incompleteNative, 'Native flow done without all stages done');
  const forged = preBody(incompleteNative, { source: imported.snapshot.source, source_snapshot: JSON.stringify(imported.snapshot), historical_details_imported: false });
  await api('POST', '/api/pre-orders', forged, 409);
  check(!db.prepare('SELECT 1 FROM pre_orders WHERE order_no=?').get(forged.order_no), 'Client-supplied completion evidence cannot promote an incomplete sample');

  const invalidEvidence = [
    ['missing evidence', snapshot => { delete snapshot.source; }],
    ['wrong system', snapshot => { snapshot.source.system = 'OTHER'; }],
    ['wrong URL', snapshot => { snapshot.source.url = 'https://example.invalid'; }],
    ['wrong source key', snapshot => { snapshot.source.source_key += '-other'; }],
    ['wrong source style', snapshot => { snapshot.source.fields.style += '-other'; }],
    ['unfinished source status', snapshot => { snapshot.source.fields.status = '制版中'; }],
    ['missing source fields', snapshot => { delete snapshot.source.fields; }],
    ['missing history uncertainty', snapshot => { delete snapshot.source.historical_details_imported; }],
    ['history claimed imported', snapshot => { snapshot.source.historical_details_imported = true; }],
    ['invalid import timestamp', snapshot => { snapshot.source.imported_at = 'not-a-date'; }],
    ['missing import timestamp', snapshot => { delete snapshot.source.imported_at; }]
  ];
  for (const [label, change] of invalidEvidence) {
    const bad = sample(); change(bad.snapshot);
    db.prepare('UPDATE sample_archives SET snapshot=? WHERE id=?').run(JSON.stringify(bad.snapshot), bad.id);
    await rejected(bad, label);
  }
  const unmarked = sample(); db.prepare("UPDATE sample_archives SET remark='__SMOKE no trusted source marker' WHERE id=?").run(unmarked.id);
  await rejected(unmarked, 'Missing trusted archive import marker');
  const malformed = sample(); db.prepare("UPDATE sample_archives SET snapshot='invalid JSON' WHERE id=?").run(malformed.id);
  await rejected(malformed, 'Invalid archive snapshot');
  for (const flowStatus of ['running', 'cancelled']) {
    const bad = sample(); db.prepare('UPDATE pattern_flows SET status=? WHERE id=?').run(flowStatus, bad.flowId);
    await rejected(bad, 'Current flow ' + flowStatus);
  }
  for (const status of ['changing', 'revised']) {
    const bad = sample(); db.prepare('UPDATE sample_archives SET status=? WHERE id=?').run(status, bad.id);
    await rejected(bad, 'Archive ' + status);
  }
  for (const status of ['pending', 'approved']) {
    const bad = sample(); insert('sample_change_requests', { archive_id: bad.id, reason: '__SMOKE变更', applicant: '__SMOKE', status, created_at: now() });
    await rejected(bad, 'Unresolved change ' + status);
  }
  const old = sample(); archives.archiveFromFlow(db.prepare('SELECT * FROM pattern_flows WHERE id=?').get(old.flowId), '__SMOKE');
  await rejected(old, 'Superseded archive');

  const orphan = sample({ orphan: true });
  if (multi) await rejected(orphan, 'Unowned import in multi-company mode', 404);
  else check((await api('GET', '/api/pre-orders/available-products')).some(row => row.id === orphan.id), 'Single-company imports without original order are selectable');
  if (multi) {
    const otherCompany = insert('companies', { code: '__SMOKE-OTHER', name: '__SMOKE另一主体', created_at: now() });
    const other = sample({ companyId: otherCompany });
    const salesperson = { sub: insert('users', { username: '__SMOKE-sample-sales', password_hash: 'unused', role: 'sales', company_id: 1, active: 1, created_at: now() }), username: '__SMOKE-sample-sales', role: 'sales', company_id: 1 };
    token = sign(salesperson);
    await rejected(other, 'Cross-company import', 404, salesperson);
    check((await api('GET', '/api/pre-orders/available-products')).some(row => row.id === completeNative.id), 'Company-scoped account can still view its own samples');
    token = sign(admin);
  }
  console.log('PASS ' + checks + ' imported-sample assertions (' + (multi ? 'multi-company' : 'single-company') + ')');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped;
  }
  db.close();
  const actual = fs.realpathSync(folder), tempRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(tempRoot, actual);
  if (relative.startsWith('erp-imported-sample-selection-') && !relative.includes(path.sep) && fs.existsSync(path.join(actual, '.smoke-owned'))) {
    fs.rmSync(actual, { recursive: true, force: true });
  } else throw new Error('Refusing to remove a directory outside this test-owned temporary directory');
});
