const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-security-'));
process.env.DB_PATH = path.join(dir, '__SMOKE.db');
process.env.ERP_SCHEDULER = '0';
process.env.SINGLE_COMPANY = '0';
process.env.JWT_SECRET = 'security-regression-test-secret-only';

// 避免为测试加载上传模块时迁移或写入真实附件目录。
const uploadPath = require.resolve('../src/routes/upload');
require.cache[uploadPath] = { id: uploadPath, filename: uploadPath, loaded: true, exports: { PRIVATE_DIR: dir } };

const { db, now } = require('../src/db');
const files = require('../src/routes/files');
const limit = require('../src/middleware/loginLimit');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
    download(file) { this.downloaded = file; return this; }
  };
}

try {
  const time = now();
  const order = db.prepare("INSERT INTO orders(order_no,company_id,created_at,updated_at) VALUES('__SMOKE-security',1,?,?)").run(time, time).lastInsertRowid;
  const name = 'abcdef0123456789abcd.pdf';
  const url = '/api/files/att/' + name;
  fs.writeFileSync(path.join(dir, name), '%PDF-test');
  db.prepare("INSERT INTO attachments(target_type,target_id,filename,url,created_at) VALUES('order',?,?,?,?)").run(order, name, url, time);

  function tokenFor(username, companyId, role = 'sales') {
    const id = db.prepare('INSERT INTO users(username,password_hash,role,active,company_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(username, 'unused', role, 1, companyId, time).lastInsertRowid;
    return jwt.sign({ sub: Number(id), tv: 0 }, process.env.JWT_SECRET);
  }
  const ownerToken = tokenFor('__SMOKE-owner', 1);
  const otherToken = tokenFor('__SMOKE-other', 2);
  const adminToken = tokenFor('__SMOKE-admin-security', 1, 'admin');
  function signed(token) {
    const res = response();
    files.signedUrlHandler({ body: { name }, headers: { authorization: 'Bearer ' + token } }, res);
    return res;
  }
  assert.equal(signed(otherToken).statusCode, 404);
  assert.equal(signed(ownerToken).statusCode, 200);
  assert.equal(signed(adminToken).statusCode, 200);
  const signedUrl = new URL(signed(ownerToken).body.data.url, 'http://localhost');
  const download = response();
  files.downloadHandler({ params: { name }, query: Object.fromEntries(signedUrl.searchParams), headers: {} }, download);
  assert.equal(download.downloaded, path.join(dir, name));
  const unauthorized = response();
  files.downloadHandler({ params: { name }, query: {}, headers: { authorization: 'Bearer ' + otherToken } }, unauthorized);
  assert.equal(unauthorized.statusCode, 404);

  const realNow = Date.now;
  let clock = 2000000000000;
  Date.now = () => clock;
  try {
    const limiter = limit.create({ failMax: 2, lockMs: 1000, lockMaxMs: 2000, windowMs: 100 });
    const req = { ip: '127.0.0.1', body: { username: '__SMOKE-old' } };
    limiter.recordFail(req, req.body.username);
    clock += 24 * 60 * 60 * 1000;
    limiter.recordFail(req, req.body.username);
    let passed = false;
    limiter.middleware(req, response(), () => { passed = true; });
    assert.equal(passed, true, '过期失败记录不应让账号提前锁定');
    limiter.recordFail(req, req.body.username);
    const locked = response();
    limiter.middleware(req, locked, () => {});
    assert.equal(locked.statusCode, 429, '连续失败仍应锁定');
    clock += 1000;
    limiter.recordFail(req, req.body.username);
    const relocked = response();
    limiter.middleware(req, relocked, () => {});
    assert.equal(relocked.statusCode, 429, '锁定到期后的下一次失败仍应退避');

    const NativeMap = global.Map;
    const maps = [];
    global.Map = class extends NativeMap {
      constructor(...args) { super(...args); maps.push(this); }
    };
    let pruningLimiter;
    try {
      pruningLimiter = limit.create({ failMax: 2, lockMs: 1000, lockMaxMs: 2000, windowMs: 100 });
    } finally {
      global.Map = NativeMap;
    }
    for (let i = 0; i < 5000; i++) pruningLimiter.recordFail(req, '__SMOKE-' + i);
    clock += 24 * 60 * 60 * 1000;
    pruningLimiter.recordFail(req, '__SMOKE-active');
    pruningLimiter.recordFail(req, '__SMOKE-active');
    pruningLimiter.middleware({ ...req, body: { username: '__SMOKE-active' } }, response(), () => {});
    assert.equal(maps[1].size, 1, '批量清理只保留仍在锁定期内的账号');
  } finally {
    Date.now = realNow;
  }
  console.log('PASS security regression tests');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
