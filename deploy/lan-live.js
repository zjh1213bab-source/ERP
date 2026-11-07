/**
 * 局域网实时开发服务（零停机镜像版）
 * ---------------------------------------------------------------
 * 背景：局域网 http://192.168.110.69:5173 由另一个提权会话的 Vite dev 提供服务，
 *       当前会话无权结束它；3100 后端同样无法重启。因此不碰这些进程。
 *
 * 做法（局域网地址与端口完全不变）：
 *   1) 新后端：用本工作区代码启动在 3200，业务库/图片通过 backend/data 目录联接共享，
 *      JWT 密钥与原实例一致（backend/.env 复制而来），已登录用户不掉线。
 *   2) 前端源码：把本工作区 frontend/src 同步到旧 Vite 的源码目录，Vite HMR 自动生效；
 *      之后持续监听，任何改动都实时镜像过去。
 *   3) API 选路：把旧 Vite 的 .env.local 代理目标改为 3200（供将来 Vite 重启时使用）。
 *      该 Vite 实例的配置监听不工作、且当前会话无权重启它，所以前端 API 层会
 *      自动直连 3200（后端 CORS 已放行），3200 不在时才回退同源 /api。
 *   4) 后端源码改动 -> 自动重启 3200；前端源码改动 -> 自动同步 + Vite 热更新。
 *
 * 不触碰：3000（10-31 遗留实例）、3100（旧后端，切代理后空闲）、5173 进程本身。
 *
 * 运行：node deploy/lan-live.js   （或双击 deploy/start-lan-live.bat）
 * 停止：Ctrl+C（结束 3200 后端与镜像监听；旧 Vite 继续运行）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');
const LEGACY = process.env.ERP_LEGACY_ROOT || 'D:/wj/ChatGPT/代码补齐';
const LEGACY_FRONTEND_SRC = path.join(LEGACY, 'frontend', 'src');
const LEGACY_ENV_LOCAL = path.join(LEGACY, 'frontend', '.env.local');
const LEGACY_VITE_CONFIG = path.join(LEGACY, 'frontend', 'vite.config.js');
const BACKUP = path.resolve(ROOT, '..', '_legacy-frontend-src-backup');
const API_PORT = 3200;
const VITE_PORT = 5173;
const LOG_DIR = path.join(BACKEND, 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'lan-live.log');
const PROXY_VALUE = `VITE_API_PROXY_TARGET=http://127.0.0.1:${API_PORT}\n`;

function log(tag, text) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${tag}] ${text}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* 日志不可写不影响服务 */ }
}

function pipeOutput(child, tag) {
  const handle = (buf) => {
    String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => log(tag, l));
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('exit', (code, signal) => log(tag, `进程退出 code=${code} signal=${signal || '-'}`));
}

function pidsOnPort(port) {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  } catch (_) { return []; }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (m && Number(m[1]) === port) pids.add(m[2]);
  }
  return [...pids];
}

function isNodeProcess(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /node\.exe/i.test(out);
  } catch (_) { return false; }
}

/** 只清理本启动器自己的 3200 端口（当前会话有权限） */
function freeOwnPort(port) {
  for (const pid of pidsOnPort(port)) {
    if (!isNodeProcess(pid)) continue;
    try {
      execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore', windowsHide: true });
      log('switch', `已结束本启动器上次的后端 PID=${pid}`);
    } catch (e) {
      throw new Error(`端口 ${port} 被 PID=${pid} 占用且无法结束：${e.message}`);
    }
  }
}

function preflight() {
  const checks = [
    [path.join(BACKEND, '.env'), '后端 .env（JWT 密钥）'],
    [path.join(BACKEND, 'data', 'lan-preview.db'), '业务库目录联接'],
    [LEGACY_FRONTEND_SRC, '旧 Vite 源码目录'],
    [LEGACY_ENV_LOCAL, '旧 Vite 的 .env.local'],
    [LEGACY_VITE_CONFIG, '旧 Vite 配置文件']
  ];
  const missing = checks.filter(([p]) => !fs.existsSync(p)).map(([, name]) => name);
  if (missing.length) throw new Error('启动前检查未通过，缺少：' + missing.join('、'));
  log('preflight', `新工作区 ${ROOT}`);
  log('preflight', `旧 Vite 目录 ${LEGACY}`);
}

/** 备份旧 Vite 的源码目录（仅首次，便于随时回退） */
function backupLegacySrc() {
  if (fs.existsSync(BACKUP) && fs.readdirSync(BACKUP).length) {
    log('backup', '旧前端源码备份已存在，跳过');
    return;
  }
  // 逐个文件复制：本机环境下 fs.cpSync 会静默中断，逐文件写入稳定
  const stats = { scanned: 0, written: 0, errors: [] };
  syncTree(LEGACY_FRONTEND_SRC, BACKUP, stats);
  log('backup', `旧前端源码已备份 ${stats.written} 个文件 → ${BACKUP}`);
}

/**
 * 行尾安全同步：两端 core.autocrlf=true，但历史文件的实际行尾风格不一致。
 * 直接 copyFileSync 会把目标翻成另一种行尾，令旧工作区 Git 冒出大量「假改动」。
 * 因此：内容（忽略行尾）相同就完全不写；确有改动时保留目标原有的行尾风格。
 */
const normalizeEol = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

function dominantEol(buf) {
  const s = buf.toString('utf8');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** 返回 true 表示确实写入了文件 */
function copyKeepingEol(src, dst) {
  const srcBuf = fs.readFileSync(src);
  // 图片/字体等二进制资源必须逐字节复制：若当成 UTF-8 文本做行尾归一化，
  // PNG/JPG 会被解码再编码破坏，局域网侧会变成破图。
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|woff2?|ttf|eot)$/i.test(src)) {
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(srcBuf)) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, srcBuf);
    return true;
  }
  let out = normalizeEol(srcBuf);
  if (fs.existsSync(dst)) {
    const dstBuf = fs.readFileSync(dst);
    if (normalizeEol(dstBuf) === out) return false;
    if (dominantEol(dstBuf) === '\r\n') out = out.replace(/\n/g, '\r\n');
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, out);
  return true;
}

/** 递归同步前端源码（只写真实变化的文件，不删除目标文件） */
function syncTree(srcDir, dstDir, stats) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) syncTree(s, d, stats);
    else if (entry.isFile()) {
      try {
        stats.scanned++;
        if (copyKeepingEol(s, d)) stats.written++;
      } catch (e) { stats.errors.push(`${entry.name}: ${e.message}`); }
    }
  }
}

function fullSync() {
  const stats = { scanned: 0, written: 0, errors: [] };
  syncTree(FRONTEND_SRC, LEGACY_FRONTEND_SRC, stats);
  // index.html 不在 src 下（品牌标题 / meta 在这里），单独同步一次
  try {
    if (copyKeepingEol(path.join(ROOT, 'frontend', 'index.html'), path.join(LEGACY, 'frontend', 'index.html'))) stats.written++;
  } catch (e) { stats.errors.push('index.html: ' + e.message); }
  log('mirror', `前端源码同步完成：扫描 ${stats.scanned}，写入 ${stats.written} 个真实变化的文件（保持目标行尾）`);
  if (stats.errors.length) stats.errors.slice(0, 3).forEach((e) => log('mirror', '  ' + e));
}

/** 持续镜像：本工作区前端任何改动都同步到旧 Vite */
function watchFrontend() {
  const pending = new Set();
  let timer = null;
  const flush = () => {
    const files = [...pending];
    pending.clear();
    let n = 0;
    for (const rel of files) {
      const s = path.join(FRONTEND_SRC, rel);
      const d = path.join(LEGACY_FRONTEND_SRC, rel);
      try {
        if (fs.existsSync(s) && copyKeepingEol(s, d)) n++;
      } catch (e) { log('mirror', `同步 ${rel} 失败：${e.message}`); }
    }
    if (n) log('mirror', `已同步 ${n} 个改动文件 → 旧 Vite（HMR 生效）`);
  };
  try {
    fs.watch(FRONTEND_SRC, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (!/\.(vue|js|ts|css|json|svg|png|jpg)$/i.test(rel)) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    });
    log('mirror', '前端源码监听已开启：改动自动同步到局域网');
  } catch (e) {
    log('mirror', `前端监听开启失败：${e.message}`);
  }
  // 单独监听 frontend/index.html（非递归，避免把 dist/node_modules 纳入监听）
  try {
    fs.watch(path.join(ROOT, 'frontend'), (_event, filename) => {
      if (String(filename || '').toLowerCase() !== 'index.html') return;
      try {
        if (copyKeepingEol(path.join(ROOT, 'frontend', 'index.html'), path.join(LEGACY, 'frontend', 'index.html'))) {
          log('mirror', '已同步 index.html（页面标题 / meta）');
        }
      } catch (e) { log('mirror', `同步 index.html 失败：${e.message}`); }
    });
  } catch (e) { log('mirror', `index.html 监听开启失败：${e.message}`); }
}

/** 让旧 Vite 把 /api 代理到新后端（写入会触发 Vite 进程内重启） */
function switchProxy() {
  const current = fs.existsSync(LEGACY_ENV_LOCAL) ? fs.readFileSync(LEGACY_ENV_LOCAL, 'utf8') : '';
  if (current.trim() === PROXY_VALUE.trim()) {
    log('proxy', '代理目标已是 3200，无需改动');
    return false;
  }
  fs.writeFileSync(LEGACY_ENV_LOCAL, PROXY_VALUE);
  log('proxy', `.env.local 已改为 3200（Vite 将自动重启一次）`);
  return true;
}

function touchViteConfig() {
  try {
    const now = new Date();
    fs.utimesSync(LEGACY_VITE_CONFIG, now, now);
    log('proxy', '已 touch vite.config.js 触发重启（内容未改动）');
  } catch (e) { log('proxy', `touch 失败：${e.message}`); }
}

async function proxyReady(backendPid, tries = 24) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${VITE_PORT}/api/health`);
      const j = await r.json();
      if (j && j.pid === backendPid) return true;
    } catch (_) { /* Vite 重启中 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let backendChild = null;
let lastBackendStart = Date.now();

function startBackend() {
  lastBackendStart = Date.now();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(API_PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  pipeOutput(child, 'backend');
  log('backend', `已启动 PID=${child.pid} PORT=${API_PORT}（业务库与图片共享）`);
  return child;
}

function watchBackend() {
  let timer = null;
  try {
    fs.watch(path.join(BACKEND, 'src'), { recursive: true }, (_event, filename) => {
      // 后端启动阶段会触碰 services 下的文件；忽略启动后 3 秒内的事件，避免连锁重启
      if (Date.now() - lastBackendStart < 3000) return;
      if (!filename || !/\.(js|json|sql)$/i.test(String(filename))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        log('watch', `检测到后端改动 ${filename}，自动重启后端…`);
        if (backendChild && !backendChild.killed) backendChild.kill();
        backendChild = startBackend();
      }, 700);
    });
    log('watch', '后端源码监听已开启：改动约 1 秒后自动生效');
  } catch (e) { log('watch', `后端监听开启失败：${e.message}`); }
}

async function main() {
  log('boot', 'ERP 局域网实时服务启动中（零停机镜像模式）');
  try { preflight(); } catch (e) { log('fatal', e.message); process.exit(1); }
  try { freeOwnPort(API_PORT); } catch (e) { log('fatal', e.message); process.exit(1); }

  backupLegacySrc();
  backendChild = startBackend();
  watchBackend();
  fullSync();
  watchFrontend();

  // 等新后端就绪
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health`);
      if (r.ok) { log('backend', '健康检查通过'); break; }
    } catch (_) { /* 启动中 */ }
    await new Promise((r) => setTimeout(r, 400));
  }

  // 旧 Vite 的配置监听不生效，且当前会话无权重启它：只做一次快速探测，
  // 不强求代理切换。前端 API 层已自动直连 3200，代理保持原样也不影响功能。
  switchProxy();
  const proxied = await proxyReady(backendChild.pid, 6);
  log('ready', proxied
    ? '5173 /api 代理已指向 3200'
    : '5173 /api 代理仍指向旧 3100（该实例无法重启）；前端 API 层自动直连 3200，功能不受影响');

  log('ready', `局域网入口 http://192.168.110.69:${VITE_PORT}  ·  新后端 http://127.0.0.1:${API_PORT}`);
  log('ready', '此后：改前端 → Vite 热更新；改后端 → 自动重启。无需任何手动部署。');

  const shutdown = () => {
    log('stop', '正在停止 3200 后端与镜像监听…');
    try { if (backendChild && !backendChild.killed) backendChild.kill(); } catch (_) { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { log('fatal', e.stack || String(e)); process.exit(1); });
