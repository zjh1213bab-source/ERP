/** 独立临时库：预下单颜色图片/选择轴元数据与旧客户端兼容。 */
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');
process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config();
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-preorder-matrix-'));
fs.writeFileSync(path.join(folder, '.smoke-owned'), '__SMOKE matrix metadata');
Object.assign(process.env, { DB_PATH: path.join(folder, '__SMOKE.db'), ERP_SCHEDULER: '0', SINGLE_COMPANY: '1',
  NODE_ENV: 'development', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '__SMOKE_password_123!', CORS_ORIGIN: '*' });
for (const key of Object.keys(process.env)) if (/^(DINGTALK_|SMTP_|OPENAI_|AI_API_)/.test(key)) process.env[key] = '';
const { db, now } = require('../src/db');
const normalizer = require('../src/services/preOrderMatrix');
let server, base, token, checks = 0, sequence = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const validImage = '/uploads/0123456789abcdef0123.png';
const rows = [{ color: '印花002', size: '3T', qty: 2, unit_price: 12.5, customer_size: '客户3' }, { color: '印花010', size: '3T', qty: 0, unit_price: 12.5 }];
const meta = { colors: ['印花002', '印花010'], sizes: ['3T'], color_images: { '印花002': validImage }, split_price: false };
function body(extra = {}) { return { order_no: '__SMOKE-MATRIX-' + (++sequence), customer_name: '__SMOKE客户', items: [{ source_type: 'new', product_name: '__SMOKE矩阵款', size_prices: rows, ...extra }] }; }
async function api(method, route, value, expectedStatus = 200) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json(); equal(response.status, expectedStatus, method + ' ' + route + ': ' + JSON.stringify(result)); return result.data;
}
function updateBody(pre, patch = {}) {
  const item = { ...pre.items[0], ...patch }; delete item.matrix_meta;
  return { ...pre, items: [item] };
}
(async () => {
  equal(db.prepare('PRAGMA table_info(pre_order_items)').all().some(column => column.name === 'matrix_json'), true, 'new schema has matrix column');
  equal(normalizer.prepare(undefined, rows, null), { colors: ['印花002', '印花010'], sizes: ['3T'], color_images: {}, split_price: false }, 'old payload axes derived');
  equal(normalizer.read('{}', [{ color: '', size: 'S', qty: 1, unit_price: 3 }]).colors, [''], 'legacy pending color remains available');
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  base = 'http://127.0.0.1:' + port;
  const log = fs.openSync(path.join(folder, 'server.log'), 'w');
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log);
  let health;
  for (let attempt = 0; attempt < 150; attempt++) { if (server.exitCode !== null) throw Error('isolated server stopped'); try { health = await (await fetch(base + '/api/health')).json(); if (health.ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  equal(health?.pid, server.pid, 'test server owns port');
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get(); token = require('jsonwebtoken').sign({ sub: admin.id, tv: 0 }, require('../src/config').jwtSecret);

  const old = await api('POST', '/api/pre-orders', body());
  equal(old.items[0].matrix_meta.colors, ['印花002', '印花010']); equal(old.total_usd, 25);
  let pre = await api('POST', '/api/pre-orders', body({ matrix_meta: meta }));
  equal(pre.items[0].matrix_meta, meta, 'explicit metadata round trip'); equal(pre.total_usd, 25, 'metadata does not alter price');
  equal((await api('GET', '/api/pre-orders/' + pre.id)).items[0].matrix_meta, meta);
  equal((await api('GET', '/api/pre-orders')).find(row => row.id === pre.id).items[0].matrix_meta, meta);
  pre = await api('PUT', '/api/pre-orders/' + pre.id, updateBody(pre, { remark: '__SMOKE legacy editor' }));
  equal(pre.items[0].matrix_meta.color_images, meta.color_images, 'old client retains images');
  pre = await api('PUT', '/api/pre-orders/' + pre.id, updateBody(pre, { size_prices: [rows[1]] }));
  equal(pre.items[0].matrix_meta.colors, ['印花010']); equal(pre.items[0].matrix_meta.color_images, {}, 'removed color image pruned');
  equal(pre.items[0].matrix_meta.sizes, ['3T']); equal(pre.total_usd, 0);

  let axesOnly = await api('POST', '/api/pre-orders', body({ size_prices: [], matrix_meta: { colors: ['印花002'], sizes: [], color_images: { '印花002': validImage }, split_price: true } }));
  equal(axesOnly.items[0].matrix_meta, { colors: ['印花002'], sizes: [], color_images: { '印花002': validImage }, split_price: true }, 'one selected axis and image persist');
  axesOnly = await api('PUT', '/api/pre-orders/' + axesOnly.id, updateBody(axesOnly, { remark: '__SMOKE old no rows' }));
  equal(axesOnly.items[0].matrix_meta.color_images, { '印花002': validImage }); equal(axesOnly.items[0].matrix_meta.colors, ['印花002']);
  const mixedPrices = [{ ...rows[0], unit_price: 1 }, { ...rows[1], unit_price: 2 }];
  await api('POST', '/api/pre-orders', body({ size_prices: mixedPrices, matrix_meta: meta }), 400);
  const mixed = await api('POST', '/api/pre-orders', body({ size_prices: mixedPrices }));
  equal(mixed.items[0].matrix_meta.split_price, true, 'different prices remain visible');
  const legacyChanged = await api('PUT', '/api/pre-orders/' + old.id, updateBody(old, { size_prices: mixedPrices }));
  equal(legacyChanged.items[0].matrix_meta.split_price, true, 'old-client price changes enable split mode without changing amounts');
  equal(legacyChanged.total_usd, 2);

  const invalid = [null, [], {}, { ...meta, colors: ['印花002', '印花002'] }, { ...meta, colors: ['印花002', 1] },
    { ...meta, colors: Array.from({ length: 61 }, (_, i) => '色' + i) }, { ...meta, colors: ['x'.repeat(101)] },
    { ...meta, sizes: ['3T', '3T'] }, { ...meta, sizes: Array.from({ length: 31 }, (_, i) => String(i)) },
    { ...meta, sizes: ['x'.repeat(51)] }, { ...meta, split_price: 'false' }, { ...meta, color_images: [] },
    { ...meta, color_images: { 红: validImage } }, { ...meta, color_images: { '印花002': 'https://example.com/a.png' } },
    { ...meta, color_images: { '印花002': '/uploads/../secret.png' } }, { ...meta, colors: [] }, { ...meta, sizes: [] }];
  for (const value of invalid) {
    const before = db.prepare('SELECT COUNT(*) n FROM pre_orders').get().n;
    await api('POST', '/api/pre-orders', body({ matrix_meta: value }), 400);
    equal(db.prepare('SELECT COUNT(*) n FROM pre_orders').get().n, before, 'invalid metadata leaves no pre-order');
  }
  await api('POST', '/api/pre-orders', body({ size_prices: Array.from({ length: 61 }, (_, index) => ({ color: '色' + index, size: 'S', qty: 0, unit_price: 0 })) }), 400);
  const beforeUpdate = db.prepare('SELECT * FROM pre_order_items WHERE id=?').get(pre.items[0].id);
  await api('PUT', '/api/pre-orders/' + pre.id, { ...pre, items: [{ ...pre.items[0], matrix_meta: { ...meta, sizes: [] } }] }, 400);
  equal(db.prepare('SELECT * FROM pre_order_items WHERE id=?').get(pre.items[0].id), beforeUpdate, 'failed edit leaves original matrix intact');

  // 完成样衣来源通过既有转单闸门，order-draft 同样返回完整元数据。
  const archiveId = require('./sales-entry-sample-fixture')(db, now());
  const archived = await api('POST', '/api/pre-orders', body({ source_type: 'archive', sample_archive_id: archiveId, matrix_meta: meta }));
  const complete = await api('POST', '/api/pre-orders/' + archived.id + '/complete', { version: archived.version });
  const draft = await api('GET', '/api/pre-orders/' + complete.id + '/order-draft'); equal(draft.items[0].matrix_meta, meta, 'transfer draft keeps color images');

  const material=await api('POST','/api/materials',{type:'fabric',name:'__SMOKE预单面料',unit:'米',width:'160',weight:'230',air_gap:'100',status:'active'});
  const materialMeta={...meta,material_details:[{key:'smoke-material',material_id:material.id,archive_version:material.version,type:'fabric',name:'伪造名称',unit:'米',one_use:0.65,loss:5,price:30,usage_part:'衣身',colors:[{colorway:'印花002',color_no:'蓝/01',price:32}],air_gap:100}],material_groups:[]};
  let withMaterials=await api('POST','/api/pre-orders',body({matrix_meta:materialMeta}));
  equal(withMaterials.items[0].matrix_meta.material_details[0].name,'__SMOKE预单面料','canonical material name');
  const tp=withMaterials.items[0].development.id;
  equal(db.prepare('SELECT one_use FROM tech_pack_materials WHERE tech_pack_id=?').get(tp).one_use,0.65,'development receives usage');
  const updatedMeta={...withMaterials.items[0].matrix_meta,material_details:withMaterials.items[0].matrix_meta.material_details.map(m=>({...m,one_use:0.8}))};
  withMaterials=await api('PUT','/api/pre-orders/'+withMaterials.id,{...withMaterials,items:[{...withMaterials.items[0],matrix_meta:updatedMeta}]});
  equal(db.prepare('SELECT one_use FROM tech_pack_materials WHERE tech_pack_id=?').get(tp).one_use,0.8,'unmodified development syncs pre-order edits');
  db.prepare('UPDATE tech_pack_materials SET one_use=0.9 WHERE tech_pack_id=?').run(tp);
  withMaterials=await api('PUT','/api/pre-orders/'+withMaterials.id,{...withMaterials,items:[{...withMaterials.items[0],matrix_meta:{...updatedMeta,material_details:updatedMeta.material_details.map(m=>({...m,one_use:1}))}}]});
  equal(db.prepare('SELECT one_use FROM tech_pack_materials WHERE tech_pack_id=?').get(tp).one_use,0.9,'technician edits preserved');
  await api('POST','/api/pre-orders',body({matrix_meta:{...materialMeta,material_details:[{...materialMeta.material_details[0],one_use:-1}]}}),400);
  const reuse=await api('POST','/api/pre-orders',body({source_type:'archive',sample_archive_id:archiveId,matrix_meta:materialMeta}));
  const ready=await api('POST','/api/pre-orders/'+reuse.id+'/complete',{version:reuse.version});
  const transfer=await api('GET','/api/pre-orders/'+ready.id+'/order-draft');
  const transferMeta=transfer.items[0].matrix_meta;
  equal(transferMeta.material_details[0].one_use,0.65,'order draft keeps material detail');
  const cust=Number(db.prepare("INSERT INTO customers(name,status,created_at,updated_at) VALUES('__SMOKE物料流转客户','active',?,?)").run(now(),now()).lastInsertRowid);
  const order=await api('POST','/api/orders',{entry_version:1,request_no:'__SMOKE-pre-material-flow-00001',scope_key:'pre:'+ready.id,draft_version:0,source_pre_order_id:ready.id,source_pre_order_version:ready.version,order_no:'__SMOKE-MATERIAL-TRANSFER',type:'custom',customer_id:cust,shop_name:'__SMOKE店铺',shop_order_no:'__SMOKE物料流转',tags:['__SMOKE'],delivery_days:10,items:[{sample_archive_id:archiveId,source_pre_order_item_id:transfer.items[0].id,product_name:'__SMOKE款',colors:[{color:'印花002',sizes:[{size:'3T',qty:2,usd_price:12.5}]}],materials:transferMeta.material_details,material_groups:transferMeta.material_groups}]});
  const orderMat=db.prepare('SELECT * FROM order_materials WHERE order_id=?').get(order.id);
  equal(orderMat.material_id,material.id,'formal order has real material link');equal(orderMat.one_use,0.65,'formal order usage retained');equal(orderMat.loss,5,'formal order loss retained');equal(orderMat.total_use,1.37,'formal order total use rounded to two decimals');
  console.log('PASS ' + checks + ' pre-order matrix assertions');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  db.close();
  const actual = fs.realpathSync(folder), root = fs.realpathSync(os.tmpdir()), relative = path.relative(root, actual);
  if (relative.startsWith('erp-preorder-matrix-') && !relative.includes(path.sep) && fs.existsSync(path.join(actual, '.smoke-owned'))) fs.rmSync(actual, { recursive: true, force: true });
  else throw Error('Refusing to remove directory outside test-owned temporary folder');
});
