/**
 * 岗位权限复核 —— 演示数据（幂等，可重复跑）
 * ============================================================
 * 这个脚本不是「造数据」，是把真实企业的岗位现状摆进系统，让复核页有东西可看：
 *
 *   1. 孙人事（hr01）原来挂的是 sales —— 因为她进系统时还没有 hr 岗位。
 *      这是最容易出事的隐性越权：一个只管考勤的人，手上握着下单、成本、导出客户名单。
 *   2. 总经理（boss01）需要一个只读账号：能看全部经营数据，但一个录入按钮都不该点。
 *   3. 出纳（fin02）和会计（fin01）都是 finance，但出纳不该做总账记账 —— 靠例外收掉。
 *   4. 生产主管（prod01）兼管仓库：用附加岗实现，但采购供方开发不给他。
 *
 * 用法：node scripts/seed-access-demo.js [--reset]
 *   --reset 只清本脚本建的东西（账号 + 例外 + 附加岗 + 复核记录），不动业务数据。
 */
const { db, now } = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const A = require('../src/services/access');

const RESET = process.argv.includes('--reset');
const PWD = 'admin123456';   // 与 admin 默认密码一致，避免演示时记不住

function ensureUser({ username, name, role, department_id }) {
  const hit = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (hit) {
    db.prepare('UPDATE users SET name=?, role=?, department_id=?, active=1, password_hash=? WHERE id=?')
      .run(name, role, department_id, hashPassword(PWD), hit.id);
    return { id: hit.id, created: false };
  }
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, name, role, department_id, active, created_at) VALUES (?,?,?,?,?,1,?)'
  ).run(username, hashPassword(PWD), name, role, department_id, now());
  return { id: Number(info.lastInsertRowid), created: true };
}

function run() {
  if (RESET) {
    db.prepare("DELETE FROM users WHERE username IN ('boss01','fin02')").run();
    db.prepare("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username IN ('bd01','prod01'))").run();
    db.prepare("DELETE FROM access_exceptions WHERE reason LIKE '[演示]%'").run();
    db.prepare("DELETE FROM access_reviews WHERE note LIKE '%[演示]%'").run();
    A.clearCache();
    console.log('[seed-access] 已清理演示数据');
  }

  // 1) 孙人事：从 sales 纠正为 hr
  const hr = ensureUser({ username: 'hr01', name: '孙人事', role: 'hr', department_id: 6 });

  // 2) 总经理：只读
  const boss = ensureUser({ username: 'boss01', name: '陈总', role: 'boss', department_id: 6 });

  // 3) 出纳：finance，但记账靠例外收掉
  const cashier = ensureUser({ username: 'fin02', name: '吴出纳', role: 'finance', department_id: 3 });

  // 4) 生产主管兼管仓库（一人多岗）
  const prod = db.prepare("SELECT id FROM users WHERE username = 'prod01'").get();
  if (prod) {
    A.setExtraRoles({ userId: prod.id, roles: ['warehouse'], operator: 'seed' });
  }

  // 5) 例外：真实复核里最常见的三种「这个人跟同岗位不一样」
  const sales = db.prepare("SELECT id FROM users WHERE username = 'sales01'").get();
  const list = [];
  if (sales) {
    list.push(A.setException({
      userId: sales.id, perm: 'order.export', effect: 'deny',
      reason: '[演示] 试用期未满，导出客户与订单数据需主管审批', operator: 'admin'
    }));
  }
  if (prod) {
    list.push(A.setException({
      userId: prod.id, perm: 'supplier.write', effect: 'deny',
      reason: '[演示] 兼任仓管只做收发，供方开发仍归采购专员', operator: 'admin'
    }));
  }
  list.push(A.setException({
    userId: cashier.id, perm: 'gl.write', effect: 'deny',
    reason: '[演示] 出纳不做总账记账，凭证由会计录入', operator: 'admin'
  }));

  // 6) 复核签字留痕
  const has = db.prepare("SELECT id FROM access_reviews WHERE note LIKE '%[演示]%'").get();
  if (!has) {
    A.signOff({
      period: '上线前复核',
      scope: '全部在册账号（含多岗与例外）',
      signedOffBy: '陈总',
      note: '[演示] 上线前按真实岗位过一遍：人事从销售岗剥离、总经理只读、出纳不做记账',
      operator: 'admin'
    });
  }

  A.clearCache();
  const m = A.reviewMatrix();
  console.log('[seed-access] 账号：hr01 / boss01 / fin02（密码 ' + PWD + '）');
  console.log('[seed-access] 复核结果：', JSON.stringify(m.summary));
  console.log('[seed-access] 多岗：prod01 =', A.effective(prod && prod.id, 'production').roles.join('+'));
  console.log('[seed-access] 例外：', list.map((x) => `#${x.id} ${x.perm}=${x.effect}`).join(' '));
}

run();
