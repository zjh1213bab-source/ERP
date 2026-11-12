/**
 * 发布打包脚本（无第三方依赖）
 * ------------------------------------------------------------
 * 为什么不用 PowerShell 的 Compress-Archive / 系统 tar：
 *   两者在中文 Windows 上都按本地代码页（GBK）写文件名，且不设 UTF-8 标志位。
 *   结果：发给 Linux 服务器或英文系统解压时，docs/manual/ 下的中文名全变乱码。
 * 这里自己写 zip：文件名统一 UTF-8，通用标志位 bit 11 置 1，任何平台都不会乱。
 *
 * 用法：
 *   node scripts/pack-release.js                 # 默认版本号从 CHANGELOG 首行读
 *   node scripts/pack-release.js --out D:\pkg    # 指定输出目录
 *   node scripts/pack-release.js --with-shots    # 连开发期截图证据一起打
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '../..');
const PKG_ROOT_NAME = 'erp-mindmap';

// 截图已移出 Git 跟踪，干净 clone 里没有 shots/；带此参数却缺目录时必须报错，
// 否则会静默产出一个声称包含截图、实际没有的交付包。
const WITH_SHOTS = process.argv.includes('--with-shots');

// ---------- 排除规则（相对 ROOT 的 posix 路径） ----------
// 与 .gitignore 的取舍一致：依赖、运行时数据、构建缓存不入包；
// frontend/dist 例外——它是构建产物，但正是交付要用的东西，必须带上。
const EXCLUDE_DIRS = [
  'frontend/node_modules',   // 前端只带 dist；要改前端再 npm install
  'backend/data',
  'backend/logs',
  ...(WITH_SHOTS ? [] : ['shots']),
  'packages',
  '.git',
  '.npmcache'
];
// 后端依赖默认打包带上：工厂电脑 / 内网服务器常常没有外网，npm install 会卡住。
// 想瘦身用 --no-modules，目标机自己装（package.json 与 lock 都在包里）。
if (process.argv.includes('--no-modules')) EXCLUDE_DIRS.push('backend/node_modules');
const EXCLUDE_FILE_RE = [
  /\.log$/i,
  /\.db$/i,
  /\.db-wal$/i,
  /\.db-shm$/i,
  /^tmp-/,
  /^backend\/tmp-/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/
];

function excluded(rel) {
  for (const d of EXCLUDE_DIRS) {
    if (rel === d || rel.startsWith(d + '/')) return true;
  }
  return EXCLUDE_FILE_RE.some((re) => re.test(rel));
}

// ---------- 收集文件 ----------
function walk(relDir, out) {
  const abs = relDir ? path.join(ROOT, relDir) : ROOT;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (excluded(rel)) continue;
    if (ent.isDirectory()) walk(rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- DOS 时间 ----------
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 写一个 zip。文件名一律 UTF-8 + 通用标志位 bit11。
 * 单文件与总量都远小于 4GB，不实现 zip64。
 */
function writeZip(zipPath, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');       // 关键：UTF-8
    const raw = e.data;
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (raw.length > 64) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        method = 8;
        body = deflated;
      }
    }
    const { time, date } = dosTime(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra len

    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x031e, 4);        // made by: unix, 3.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);        // 同样置 UTF-8 位
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);            // extra
    cen.writeUInt16LE(0, 32);            // comment
    cen.writeUInt16LE(0, 34);            // disk
    cen.writeUInt16LE(0, 36);            // internal attr
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);  // 普通文件 rw-r--r--
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, eocd]));
  return fs.statSync(zipPath).size;
}

// ---------- 版本号 ----------
function currentVersion() {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const m = cl.match(/##\s*v(\d+\.\d+\.\d+)/);
  return m ? m[1] : '0.0.0';
}

function main() {
  const argv = process.argv.slice(2);
  if (WITH_SHOTS && !fs.existsSync(path.join(ROOT, 'shots'))) {
    console.error('错误：--with-shots 需要仓库根目录下存在 shots/ 目录。');
    console.error('截图已移出 Git 跟踪，请先从离线归档恢复 shots/，或去掉 --with-shots 重新打包。');
    process.exit(1);
  }
  const outArg = argv.indexOf('--out');
  const stamp = new Date();
  const ymd = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`;
  const ver = currentVersion();
  const outDir = outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.join(ROOT, 'packages');

  const files = [];
  walk('', files);
  // .gitignore 在 git 里是跟踪的，保留；packages 目录已在排除里
  files.sort();

  const entries = [];
  let bytes = 0;
  files.forEach((rel) => {
    const abs = path.join(ROOT, rel);
    const st = fs.statSync(abs);
    bytes += st.size;
    entries.push({
      name: `${PKG_ROOT_NAME}/${rel.split(path.sep).join('/')}`,
      data: fs.readFileSync(abs),
      mtime: st.mtime
    });
  });

  // 包内说明放在根目录，解压第一眼就能看到怎么跑、跑不了找谁
  const manifest = [
    '跳色科技「衣创 ERP」交付包',
    '================================================================',
    '',
    `版本        v${ver}`,
    `打包时间    ${stamp.toLocaleString('zh-CN', { hour12: false })}`,
    `包内文件    ${entries.length} 个（含前端已构建产物 frontend/dist）`,
    '',
    '一、包里有什么',
    '----------------------------------------------------------------',
    'backend/        后端（Express + SQLite）',
    '  src/            源码，schema.js 是表结构唯一来源',
    '  scripts/        建表 / 迁移 / 冒烟 / RBAC / 巡检 / 演示数据 / 本打包脚本',
    '  node_modules/   已带依赖（express / cors / dotenv / jsonwebtoken）',
    'frontend/       前端源码 + dist（已构建，后端直接托管）',
    'docs/           接口文档 / 数据库结构 / 原型节点 / 用户手册（含配图）',
    'deploy/         部署脚本与说明（DEPLOY.md / LAN-DEPLOY.md / nginx / pm2）',
    'README.md       功能总览',
    'CHANGELOG.md    版本变更记录（含每个功能的判断依据）',
    '',
    '二、包里没有的（有意排除）',
    '----------------------------------------------------------------',
    'backend/data/          数据库与上传件（运行时数据，另见演示库快照）',
    'frontend/node_modules/ 前端依赖（只在需要重新构建前端时装）',
    ...(WITH_SHOTS ? [] : ['shots/                 开发期截图证据（--with-shots 可带上）']),
    '.git/                  Git 历史',
    '',
    '三、怎么跑起来',
    '----------------------------------------------------------------',
    '1) 后端（自带静态托管，起来就能用；依赖已带，无需 npm install）',
    '   cd backend && node src/server.js',
    '   默认 http://127.0.0.1:3000 ，首次启动自动建库、建表、播种演示数据。',
    '   换端口：set PORT=3100 && node src/server.js（Linux: PORT=3100 node src/server.js）',
    '',
    '2) 前端（只有改了前端才需要）',
    '   cd frontend && npm install && npm run build',
    '   产物进 frontend/dist，后端自动托管；开发态用 npm run dev 起 5173。',
    '',
    '3) 依赖跑不起来时',
    '   better-sqlite3 是可选的原生模块，跨操作系统/Node 版本可能不匹配。',
    '   匹配不上会自动回退 Node 内置 node:sqlite（Node ≥ 22.5），功能不受影响。',
    '   要重装：cd backend && rm -rf node_modules && npm install',
    '',
    '4) 默认账号',
    '   admin / admin123456    上线前必须改密码（见 deploy/GO-LIVE-CHECKLIST.md）',
    '',
    '四、验证（交付前自己跑一遍）',
    '----------------------------------------------------------------',
    '   cd backend',
    '   npm run smoke                 冒烟：全部断言',
    '   npm run rbac                  权限审计',
    '   node scripts/sweep-pages.js   全站页面巡检',
    '   （三项都要求后端已在 3000 端口运行）',
    '',
    '五、上线前必做',
    '----------------------------------------------------------------',
    '见 deploy/GO-LIVE-CHECKLIST.md，最关键三条：',
    '  改掉默认管理员密码 · 关闭演示数据入口 · 配置数据库定时备份',
    ''
  ].join('\n');
  entries.unshift({ name: `${PKG_ROOT_NAME}/MANIFEST.txt`, data: Buffer.from(manifest, 'utf8'), mtime: stamp });

  const zipPath = path.join(outDir, `erp-mindmap-v${ver}-${ymd}.zip`);
  const size = writeZip(zipPath, entries);

  console.log(`版本      v${ver}`);
  console.log(`文件      ${entries.length} 个（未压缩 ${(bytes / 1048576).toFixed(1)} MB）`);
  console.log(`压缩后    ${(size / 1048576).toFixed(1)} MB`);
  console.log(`输出      ${zipPath}`);
}

main();
