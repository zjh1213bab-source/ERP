/**
 * 截图脚本输出目录必须相对仓库，不能写死开发机绝对路径。
 * 用法：node --test scripts/test-shot-scripts-paths.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = __dirname;
const ABS_OUT_RE = /['"][A-Za-z]:[\\/]/;

function shotScripts() {
  return fs.readdirSync(SCRIPTS).filter((name) => /^shot-.*\.js$/.test(name)).sort();
}

function outLineOf(text) {
  return text.split('\n').find((line) => /^\s*(?:const|let|var)\s+OUT\s*=/.test(line)) || '';
}

test('检测规则能抓到绝对路径，也能放过相对写法（边界）', () => {
  assert.equal(ABS_OUT_RE.test("const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/access';"), true);
  assert.equal(ABS_OUT_RE.test("const OUT = pathMod.resolve(__dirname, '../../shots/access');"), false);
});

test('全部 shot-*.js 的 OUT 都基于 __dirname 指向仓库内 shots/', () => {
  const files = shotScripts();
  assert.ok(files.length >= 90, `应覆盖全部截图脚本，实际 ${files.length}`);
  const bad = [];
  for (const name of files) {
    const line = outLineOf(fs.readFileSync(path.join(SCRIPTS, name), 'utf8'));
    if (ABS_OUT_RE.test(line)) bad.push(`${name}: 写死绝对路径 ${line.trim()}`);
    else if (!/__dirname/.test(line) || !/shots\//.test(line)) {
      bad.push(`${name}: OUT 未基于 __dirname 指向 shots/ → ${line.trim()}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('全部 shot-*.js 通过 node --check', () => {
  const failed = [];
  for (const name of shotScripts()) {
    const result = spawnSync(process.execPath, ['--check', path.join(SCRIPTS, name)], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) failed.push(`${name}: ${result.stderr.trim()}`);
  }
  assert.deepEqual(failed, [], failed.join('\n'));
});
