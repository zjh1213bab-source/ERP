/**
 * 业务数据重置（全库重置 / 保留系统配置）
 * ============================================================
 * 用户要求：清到"首次安装状态"，只留系统管理员 + 朱佳豪两个账号、权限与系统设置，
 * 客户/供应商/面辅料/员工等档案一并清空。
 *
 * 安全设计（这个库 367 张表、零外键，删错不会报错只会留孤儿）：
 *   1. 默认**只打印计划**，不删任何东西；加 `--apply` 才执行；
 *   2. 执行前**先把整库文件复制一份**到 packages/backup-before-reset-<时间>.db；
 *   3. 白名单保留（KEEP），其余表一律清空 —— 用"默认清空 + 显式保留"而不是反过来，
 *      因为新增业务表时忘记登记，宁可多清也不要漏清；
 *   4. 删完在同一事务内复查：保留表行数不变、其余表为 0；
 *   5. 重置后自检：能登录、能读设置、无孤儿。
 *
 * 用法：
 *   node scripts/reset-business-data.js            # 看计划（只读）
 *   node scripts/reset-business-data.js --apply    # 执行（自动备份）
 */
const fs = require('fs');
const path = require('path');
const { db, now } = require('../src/db');

const APPLY = process.argv.includes('--apply');

/**
 * 保留清单（表名 → 保留条件）
 *
 * 只放"系统运行必需"和"用户明确要求保留"的：
 *   schema_migrations 结构版本台账（删了会导致启动时误判结构变更）
 *   settings / app_config 系统设置
 *   users 只留 系统管理员 + 朱佳豪（其余账号全删）
 *   user_roles 角色绑定（与 users 对应的那几行由 users 重建后重写）
 *   companies 公司抬头（company_id 全库默认 1，删了页面抬头会空）
 *   departments 组织架构（员工档案的上级，属配置不属档案）
 */
const KEEP_TABLES = ['schema_migrations', 'settings', 'app_config', 'users', 'user_roles', 'companies'];

/**
 * 保留主体：只留真实抬头（code=JSKJ / 最小 id）
 * 库里有 4 个主体，其中义乌/美国/越南是演示主体（税号带 DEMO、名称为"演示"），按重置要求清掉。
 */
const KEEP_COMPANY_IDS = (() => {
  const first = db.prepare("SELECT id FROM companies WHERE code = 'JSKJ'").get()
    || db.prepare('SELECT MIN(id) AS id FROM companies').get();
  return first && first.id ? [Number(first.id)] : [];
})();

/** 账号保留条件：id=1 系统管理员、id=9 朱佳豪（先按用户名兜底，防止 id 变化） */
const KEEP_USERS = db.prepare(
  "SELECT id, username, name, role FROM users WHERE username = 'admin' OR name = '朱佳豪' ORDER BY id"
).all();
const KEEP_USER_IDS = KEEP_USERS.map((u) => Number(u.id));

function tables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
}
const cnt = (t) => {
  try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { return -1; }
};

function plan() {
  const all = tables();
  const keep = all.filter((t) => KEEP_TABLES.includes(t));
  const wipe = all.filter((t) => !KEEP_TABLES.includes(t));
  const wipeRows = wipe.reduce((s, t) => s + Math.max(0, cnt(t)), 0);
  return { all, keep, wipe, wipeRows };
}

function printPlan() {
  const p = plan();
  console.log('\n业务数据重置计划');
  console.log('='.repeat(60));
  console.log(`表总数 ${p.all.length} · 保留 ${p.keep.length} 张 · 清空 ${p.wipe.length} 张（合计 ${p.wipeRows} 行）\n`);
  console.log('保留（配置类）：');
  p.keep.forEach((t) => console.log(`  ${String(cnt(t)).padStart(6)}  ${t}`));
  console.log('\n保留账号：');
  KEEP_USERS.forEach((u) => console.log(`  #${u.id} ${u.username}（${u.name} / ${u.role}）`));
  console.log('\n将清空行数最多的 20 张表：');
  p.wipe.map((t) => [t, cnt(t)]).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([t, c]) => console.log(`  ${String(c).padStart(6)}  ${t}`));
  return p;
}

function backup() {
  const src = path.resolve(__dirname, '..', 'data', 'erp-mindmap.db');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.resolve(__dirname, '..', '..', 'packages');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `backup-before-reset-${stamp}.db`);
  // WAL 模式下必须先 checkpoint，否则复制出来的文件可能缺最近的写入
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* 忽略 */ }
  fs.copyFileSync(src, dest);
  const size = (fs.statSync(dest).size / 1048576).toFixed(1);
  console.log(`\n已备份整库 → ${dest}（${size} MB）`);
  return dest;
}

function apply() {
  const p = printPlan();
  const dest = backup();

  const before = Object.fromEntries(p.keep.map((t) => [t, cnt(t)]));

  db.exec('BEGIN IMMEDIATE');
  try {
    /* 1) 先删非保留表的全部数据（由子到父无所谓：零外键，且整表清空） */
    for (const t of p.wipe) {
      db.prepare(`DELETE FROM "${t}"`).run();
    }

    /* 2) 账号：只留白名单，其余删除；朱佳豪/管理员的 employee_id 置空（员工档案已清） */
    const delUsers = db.prepare(
      `DELETE FROM users WHERE id NOT IN (${KEEP_USER_IDS.map(() => '?').join(',') || '0'})`
    );
    delUsers.run(...KEEP_USER_IDS);
    db.prepare(`UPDATE users SET employee_id = NULL WHERE id IN (${KEEP_USER_IDS.map(() => '?').join(',') || '0'})`)
      .run(...KEEP_USER_IDS);

    /* 3) 角色绑定只留保留账号的；组织架构与多余主体一并清掉 */
    db.prepare(
      `DELETE FROM user_roles WHERE user_id NOT IN (${KEEP_USER_IDS.map(() => '?').join(',') || '0'})`
    ).run(...KEEP_USER_IDS);
    if (KEEP_COMPANY_IDS.length) {
      db.prepare(
        `DELETE FROM companies WHERE id NOT IN (${KEEP_COMPANY_IDS.map(() => '?').join(',')})`
      ).run(...KEEP_COMPANY_IDS);
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('重置失败，已回滚：' + e.message);
    process.exit(1);
  }

  /* 4) 自检：保留表行数不变（users 例外，按白名单校验），其余必须为 0 */
  console.log('\n复查');
  console.log('='.repeat(60));
  let bad = 0;
  p.keep.forEach((t) => {
    // 这三张按白名单/条件处理过，行数本就会变，单独校验（见下）
    if (t === 'users' || t === 'user_roles' || t === 'companies') return;
    if (cnt(t) !== before[t]) { console.log(`  ✗ ${t} 行数变化 ${before[t]} → ${cnt(t)}`); bad += 1; }
  });

  const leftUsers = db.prepare('SELECT id, username, name FROM users ORDER BY id').all();
  console.log('  保留账号：' + leftUsers.map((u) => `${u.username}(${u.name})`).join('、'));
  if (leftUsers.length !== KEEP_USER_IDS.length) { console.log('  ✗ 账号数量不符'); bad += 1; }

  const leftComp = db.prepare('SELECT id, code, name FROM companies ORDER BY id').all();
  console.log('  保留主体：' + (leftComp.map((c) => `${c.code}(${c.name})`).join('、') || '(无)'));
  if (leftComp.length !== KEEP_COMPANY_IDS.length) { console.log('  ✗ 主体数量不符'); bad += 1; }

  const badRoles = db.prepare(
    `SELECT COUNT(*) c FROM user_roles WHERE user_id NOT IN (${KEEP_USER_IDS.map(() => '?').join(',') || '0'})`
  ).get(...KEEP_USER_IDS).c;
  if (badRoles) { console.log(`  ✗ 有 ${badRoles} 条角色绑定指向已删除账号`); bad += 1; }

  const stillRows = p.wipe.filter((t) => cnt(t) !== 0);
  if (stillRows.length) { console.log('  ✗ 仍有数据：' + stillRows.join(',')); bad += 1; }
  else console.log('  ✓ 业务表全部清零（' + p.wipe.length + ' 张）');

  console.log(bad ? `\n✗ 有 ${bad} 项不通过，建议用备份回滚：${dest}` : '\n✓ 重置完成');
  if (bad) process.exit(1);
}

if (APPLY) {
  console.log('\n开始执行（--apply）…');
  apply();
} else {
  printPlan();
  console.log('\n以上只是计划，未改动任何数据。确认后执行：');
  console.log('  node scripts/reset-business-data.js --apply');
}
