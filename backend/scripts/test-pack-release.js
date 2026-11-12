/**
 * pack-release.js 的 --with-shots 行为验证（CLI 黑盒，不依赖运行中的服务）
 * 用法：node --test scripts/test-pack-release.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = fs.readFileSync(path.join(__dirname, 'pack-release.js'), 'utf8');

// ROOT 由脚本所在目录反推，所以夹具必须长成 <tmp>/backend/scripts/ 结构。
function makeRepo(withShotsDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-pack-test-'));
  const scripts = path.join(root, 'backend', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'pack-release.js'), SOURCE);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## v1.0.0 测试夹具\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture');
  if (withShotsDir) {
    fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shots', 'demo.png'), 'fixture-png');
  }
  return root;
}

function pack(root, extraArgs) {
  const out = path.join(root, 'packages');
  const result = spawnSync(process.execPath,
    [path.join(root, 'backend', 'scripts', 'pack-release.js'), '--out', out, ...(extraArgs || [])],
    { encoding: 'utf8' });
  if (result.error) throw result.error;
  const zips = fs.existsSync(out)
    ? fs.readdirSync(out).filter((name) => name.endsWith('.zip'))
    : [];
  return {
    status: result.status,
    stderr: result.stderr,
    buf: zips.length === 1 ? fs.readFileSync(path.join(out, zips[0])) : null
  };
}

test('默认不打截图：shots/ 被排除', (t) => {
  const root = makeRepo(true);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = pack(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.buf, '应生成 zip');
  assert.equal(result.buf.includes(Buffer.from('erp-mindmap/shots/demo.png')), false);
});

test('--with-shots：shots/ 纳入交付包', (t) => {
  const root = makeRepo(true);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = pack(root, ['--with-shots']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.buf, '应生成 zip');
  assert.equal(result.buf.includes(Buffer.from('erp-mindmap/shots/demo.png')), true);
});

test('--with-shots 但目录缺失：明确失败且不产出包', (t) => {
  const root = makeRepo(false);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = pack(root, ['--with-shots']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shots\//);
  assert.equal(result.buf, null);
});
