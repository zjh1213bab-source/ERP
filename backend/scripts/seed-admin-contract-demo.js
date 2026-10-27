/**
 * 行政合同与印章授权演示数据（可重复执行）
 *
 * 覆盖：
 *  - 合同四态：履约中 / 即将到期（预警）/ 已过期未处理（风险）/ 已终止（有原因）
 *  - 里程碑：付款（含一条逾期）、验收、续约通知、押金返还
 *  - 印章：义乌公司章已授权给销售；美国公司章无授权（演示缺口告警）
 *  - 用印：已用印+已归还（带回执）/ 待批 / 因版本变化需重核
 *  - 借章：已借出且逾期未还
 *  - 证照：沿用现有 3 张（含 1 张已过期）
 *  - 敏感档案访问留痕
 *
 * 用法：node scripts/seed-admin-contract-demo.js [--reset]
 */
const { db, now } = require('../src/db');

const BASE = process.env.SEED_BASE || 'http://127.0.0.1:3000';
const PWD = 'admin123456';

async function req(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) return { s: r.status, j, error: j.message || 'HTTP ' + r.status };
  return { s: r.status, j };
}
const login = async (u, p) => (await req(null, 'POST', '/api/auth/login', { username: u, password: p })).j.data.token;

function localDate(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}
const D = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
};

const RESET = process.argv.includes('--reset');

if (RESET) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM admin_contract_milestones').run();
    db.prepare('DELETE FROM admin_contract_versions').run();
    db.prepare('DELETE FROM admin_contracts').run();
    db.prepare('DELETE FROM seal_grants').run();
    db.prepare('DELETE FROM seal_usages').run();
    db.prepare('DELETE FROM doc_access_logs').run();
    db.exec('COMMIT');
    console.log('已清空行政合同/印章/访问演示数据');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

(async () => {
  const A = await login('admin', PWD);
  const S = await login('sales01', PWD);

  const sealOffice = db.prepare("SELECT * FROM seals WHERE name = '公章'").get();
  const sealContract = db.prepare("SELECT * FROM seals WHERE name = '合同章'").get();
  const sealUs = db.prepare("SELECT * FROM seals WHERE company LIKE '美国%'").get();

  /* ---------- 1. 印章授权：义乌两家章给销售，美国公司章故意不授 ---------- */
  const hasGrant = db.prepare("SELECT 1 AS x FROM seal_grants WHERE seal_id = ? AND grantee = 'sales01'").get(sealContract.id);
  if (!hasGrant) {
    await req(A, 'POST', '/api/admin-contracts/seal-grants', {
      seal_id: sealContract.id, grantee: 'sales01', grantee_type: 'person', scope: 'all',
      valid_to: D(365), remark: '销售负责人：合同章可用于用印与外借'
    });
    await req(A, 'POST', '/api/admin-contracts/seal-grants', {
      seal_id: sealOffice.id, grantee: 'sales01', grantee_type: 'person', scope: 'use',
      valid_to: D(180), remark: '仅用印，不外借'
    });
    // 一条已过期的授权（演示「有记录但过期」不算有效）
    await req(A, 'POST', '/api/admin-contracts/seal-grants', {
      seal_id: sealOffice.id, grantee: 'tech01', grantee_type: 'person', scope: 'use',
      valid_from: D(-200), valid_to: D(-20), remark: '原技术负责人，已离任授权到期'
    });
    console.log('印章授权：义乌公章/合同章 → sales01；美国公司章故意不授（演示缺口）');
  }

  /* ---------- 2. 合同 ---------- */
  const plans = [
    {
      name: '城北仓库租赁合同', type: 'lease', company: '义乌市珂睿服饰',
      counterparty: '城北物流园管委会', owner: '孙人事',
      amount: 180000, deposit: 30000, deposit_return_date: D(340),
      sign_date: D(-40), start_date: D(-30), end_date: D(335), renewal_notice_days: 45,
      seal_id: sealContract.id, doc_name: '城北仓库租赁合同V1.pdf', doc_hash: 'DOC-HASH-WAREHOUSE-V1',
      remark: '620㎡，含装卸平台；租金按季支付',
      payments: [
        { due_date: D(-25), amount: 45000, title: '首期租金（已付）' },
        { due_date: D(-3), amount: 45000, title: '第二期租金（逾期未付）' },
        { due_date: D(85), amount: 45000, title: '第三期租金' }
      ],
      acceptances: [{ due_date: D(-28), title: '仓库交付验收（面积/消防/水电）' }],
      finish: { payments: ['首期租金（已付）'], acceptances: true, evidence: '银行流水 2026-09-30 ¥45000；面积实测 620㎡' }
    },
    {
      name: '厂区物业保洁服务合同', type: 'property', company: '义乌市珂睿服饰',
      counterparty: '洁净家园物业服务', owner: '孙人事',
      amount: 96000, sign_date: D(-345), start_date: D(-345), end_date: D(20), renewal_notice_days: 30,
      seal_id: sealContract.id, doc_name: '保洁服务合同2025.pdf', doc_hash: 'DOC-HASH-CLEAN-2025',
      remark: '每日两人驻场；月度验收后付款',
      payments: [{ due_date: D(-3), amount: 8000, title: '上月服务费' }],
      acceptances: [{ due_date: D(15), title: '本月服务验收（卫生抽查记录）' }]
    },
    {
      name: '雇主责任险保单', type: 'insurance', company: '义乌市珂睿服饰',
      counterparty: '中国人保义乌分公司', owner: '孙人事',
      amount: 42000, sign_date: D(-400), start_date: D(-400), end_date: D(-17), renewal_notice_days: 30,
      seal_id: sealOffice.id, doc_name: '雇主责任险2025-2026.pdf', doc_hash: 'DOC-HASH-INS-2025',
      remark: '覆盖 68 人；已过期，尚未续保（风险）',
      payments: [], acceptances: []
    },
    {
      name: '员工食堂承包合同', type: 'canteen', company: '义乌市珂睿服饰',
      counterparty: '味美餐饮管理', owner: '孙人事',
      amount: 240000, deposit: 20000, deposit_return_date: D(-5),
      sign_date: D(-500), start_date: D(-500), end_date: D(-60), renewal_notice_days: 30,
      seal_id: sealContract.id, doc_name: '食堂承包合同.pdf', doc_hash: 'DOC-HASH-CANTEEN',
      remark: '卫生不达标两次整改未过，已终止',
      payments: [], acceptances: [], terminate: { reason: '连续两次卫生检查不合格且整改未通过，依合同第 9 条终止' }
    }
  ];

  const exist = db.prepare('SELECT id FROM admin_contracts WHERE name = ?');
  const ids = {};
  for (const p of plans) {
    if (exist.get(p.name)) { ids[p.name] = exist.get(p.name).id; continue; }
    const body = { ...p };
    delete body.finish;
    delete body.terminate;
    const r = await req(A, 'POST', '/api/admin-contracts/contracts', body);
    if (!r.j.ok) { console.log('建合同失败', p.name, r.error); continue; }
    ids[p.name] = r.j.data.id;
    console.log(`  合同 ${r.j.data.contract_no} ${p.name}（任务 ${r.j.data.milestones.length} 条）`);
  }

  /* ---------- 3. 完成部分里程碑，制造真实进度 ---------- */
  const whId = ids['城北仓库租赁合同'];
  if (whId) {
    const detail = (await req(A, 'GET', '/api/admin-contracts/contracts/' + whId)).j.data;
    const paid = detail.milestones.find((m) => m.type === 'payment' && m.title.includes('首期'));
    if (paid && paid.status === 'pending') {
      await req(A, 'POST', `/api/admin-contracts/milestones/${paid.id}/done`, { evidence: '银行流水 2026-09-30 ¥45000，凭证 PAY-20260930-01' });
    }
    const acc = detail.milestones.find((m) => m.type === 'acceptance');
    if (acc && acc.status === 'pending') {
      await req(A, 'POST', `/api/admin-contracts/milestones/${acc.id}/done`, { evidence: '面积实测 620㎡，消防验收合格，水电表初始读数已拍照' });
    }
    // 一条待处理的付款已逾期（不动它，留给用户看逾期）
  }

  /* ---------- 4. 终止食堂合同 ---------- */
  const ctId = ids['员工食堂承包合同'];
  if (ctId) {
    const c = db.prepare('SELECT status FROM admin_contracts WHERE id = ?').get(ctId);
    if (c && c.status !== 'terminated') {
      const r = await req(A, 'POST', `/api/admin-contracts/contracts/${ctId}/terminate`, {
        reason: '连续两次卫生检查不合格且整改未通过，依合同第 9 条终止'
      });
      console.log('  食堂合同：', r.j.ok ? '已终止' : r.error);
    }
  }

  /* ---------- 5. 用印与借章 ---------- */
  const usageCount = db.prepare('SELECT COUNT(*) c FROM seal_usages').get().c;
  if (!usageCount) {
    // ① 已用印 + 已归还（带回执）
    let r = await req(S, 'POST', '/api/admin-contracts/seal-usages', {
      seal_id: sealContract.id, kind: 'use', purpose: '城北仓库租赁合同签署（三份）',
      doc_name: '城北仓库租赁合同V1.pdf', contract_id: whId
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(A, 'POST', `/api/admin-contracts/seal-usages/${id}/approve`, {});
      await req(A, 'POST', `/api/admin-contracts/seal-usages/${id}/use`, { receipt_no: 'YY-2026-0930-02' });
      await req(A, 'POST', `/api/admin-contracts/seal-usages/${id}/return`, { return_receipt: '行政部 张姐 收，章已归位保险柜' });
      console.log('  用印：已用印并归还（回执 YY-2026-0930-02）');
    }

    // ② 待批（等行政批）
    r = await req(S, 'POST', '/api/admin-contracts/seal-usages', {
      seal_id: sealOffice.id, kind: 'use', purpose: '供应商资质证明文件盖章（3 份）',
      doc_name: '供应商资质证明.pdf'
    });
    console.log('  用印：1 张待批（#%s）', r.j.ok ? r.j.data.id : r.error);

    // ③ 版本变化后需重核：先申请，再出 V2，申请书自动转待重核
    const cleanId = ids['厂区物业保洁服务合同'];
    if (cleanId) {
      r = await req(S, 'POST', '/api/admin-contracts/seal-usages', {
        seal_id: sealContract.id, kind: 'use', purpose: '保洁合同续签盖章',
        doc_name: '保洁服务合同2025.pdf', contract_id: cleanId
      });
      if (r.j.ok) {
        await req(S, 'POST', `/api/admin-contracts/contracts/${cleanId}/versions`, {
          change_note: '服务范围增加周末加班保洁，单价不变', doc_hash: 'DOC-HASH-CLEAN-2025-V2',
          doc_name: '保洁服务合同2025-V2.pdf'
        });
        console.log('  保洁合同：已出 V2，1 张用印申请转为「需重核」');
      }
    }

    // ④ 借章：先按正常日期借出，再回填成逾期（模拟「借出去忘了还」）
    r = await req(S, 'POST', '/api/admin-contracts/seal-usages', {
      seal_id: sealContract.id, kind: 'borrow', purpose: '银行开立一般户需带章现场用',
      expect_return_date: D(3)
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(A, 'POST', `/api/admin-contracts/seal-usages/${id}/approve`, {});
      await req(A, 'POST', `/api/admin-contracts/seal-usages/${id}/borrow`, {});
      db.prepare('UPDATE seal_usages SET expect_return_date = ? WHERE id = ?').run(D(-2), id);
      console.log('  借章：合同章借出未还（应还 %s，已逾期）', D(-2));
    } else {
      console.log('  借章失败：', r.error);
    }
  }

  /* ---------- 6. 敏感档案访问留痕 ---------- */
  if (!db.prepare('SELECT COUNT(*) c FROM doc_access_logs').get().c) {
    const certs = db.prepare("SELECT id, name FROM certificates WHERE status = 'valid'").all();
    for (const c of certs.slice(0, 2)) {
      await req(A, 'POST', `/api/admin-contracts/certificates/${c.id}/view`, {
        action: 'view', reason: c.name.includes('保险') ? '核对续保到期日' : '年检材料准备'
      });
    }
    console.log('  证照：2 条访问留痕');
  }

  /* ---------- 7. 汇总 ---------- */
  const bd = (await req(A, 'GET', '/api/admin-contracts/board')).j.data;
  console.log('\n=== 行政合同看板 ===');
  console.log('stat', JSON.stringify(bd.stat));
  console.log('预警：');
  bd.alerts.forEach((a) => console.log('  -', a.label));
  console.log('\n合同：');
  bd.contracts.forEach((c) => {
    console.log(`  ${c.contract_no} ${c.name} ${c.status_label} ${c.start_date}~${c.end_date}`
      + `${c.days_to_end !== null ? ` (剩 ${c.days_to_end} 天)` : ''}`
      + ` 未办任务 ${c.open_milestones} 押金 ${c.deposit || 0}`);
  });
  const cal = (await req(A, 'GET', '/api/admin-contracts/calendar?to=' + D(120))).j.data;
  console.log('\n日历（未来 120 天 + 逾期）', JSON.stringify(cal.stat));
  cal.items.slice(0, 8).forEach((x) => console.log(`  ${x.due_date} [${x.source}] ${x.title}${x.effective_status === 'overdue' ? ' · 逾期' : ''}`));
  const g = (await req(A, 'GET', '/api/admin-contracts/seal-grants')).j.data;
  console.log('\n印章授权覆盖：');
  g.coverage.forEach((c) => console.log(`  ${c.company} · ${c.name} 有效授权 ${c.grants}${c.warning ? ' ⚠ ' + c.warning : ''}`));
  console.log('\n完成。打开「人事行政 → 行政合同」查看。');
  process.exit(0);
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
