/**
 * 组织编制演示数据（M02）
 * ------------------------------------------------------------
 * 要演的四件事：
 *   1) 编制 vs 在职：哪个岗缺人、哪个岗满编、哪个岗超编（超编必须特批）
 *   2) 任职关系：雇佣公司 ≠ 服务公司（技术部服务各公司）、换岗留历史、离职结束任职
 *   3) 交易路线：代销要服务协议、外协统一签约、缺条款不许确认
 *   4) 主体授权：独立批准、到期日、到期自动失效
 *
 * 用法：node scripts/seed-org-demo.js --reset
 */
const { db } = require('../src/db');
const O = require('../src/services/org');
const { localNow, localDate } = require('../src/services/sla');

const TAG = 'ORGDEMO';
const RESET = process.argv.includes('--reset');
const OP = '组织演示';

function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + Number(n || 0));
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

function reset() {
  const out = {};
  // 先删任职（引用岗位与员工），再删岗位、路线、授权、员工
  out.employments = db.prepare('DELETE FROM employments WHERE remark LIKE ?').run(`%${TAG}%`).changes;
  out.positions = db.prepare('DELETE FROM org_positions WHERE remark LIKE ?').run(`%${TAG}%`).changes;
  out.routes = db.prepare('DELETE FROM trade_routes WHERE demo_tag=?').run(TAG).changes;
  out.scopes = db.prepare('DELETE FROM subject_scopes WHERE remark LIKE ?').run(`%${TAG}%`).changes;
  // 员工删了，按 employee_id 落库的周报会变成「查不到人」的孤儿行，一起清掉
  const empIds = db.prepare("SELECT id FROM employees WHERE code LIKE 'ORGDEMO%'").all().map((r) => r.id);
  out.weekly = empIds.length
    ? db.prepare(`DELETE FROM ai_weekly WHERE subject_id IN (${empIds.map(() => '?').join(',')})`).run(...empIds).changes
    : 0;
  out.employees = db.prepare("DELETE FROM employees WHERE code LIKE 'ORGDEMO%'").run().changes;
  return out;
}

function main() {
  const t = localNow();
  const today = localDate();
  const lines = [];

  const mkEmp = (code, name, deptId, position) => {
    const old = db.prepare('SELECT id FROM employees WHERE code=?').get(code);
    if (old) return old.id;
    return db.prepare(
      `INSERT INTO employees (code,name,department_id,position,phone,hire_date,status,base_salary,employment_type,remark,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(code, name, deptId, position, '—', addDays(today, -400), 'active', 0, 'fulltime', TAG, t).lastInsertRowid;
  };

  // ---------- 人 ----------
  const eLin = mkEmp('ORGDEMO01', '林夏', 1, '销售专员');
  const eZhou = mkEmp('ORGDEMO02', '周舟', 1, '销售专员');
  const eXu = mkEmp('ORGDEMO03', '许工', 2, '版师');
  const eLan = mkEmp('ORGDEMO04', '阿岚', 2, '版师');
  const eKe = mkEmp('ORGDEMO05', '小柯', 2, '版师（待批）');
  const eLu = mkEmp('ORGDEMO06', '陆师傅', 4, '车工');
  const eHe = mkEmp('ORGDEMO07', '何工', 5, '供应链主管');

  // ---------- 岗位与编制 ----------
  const mkPos = (b) => O.createPosition({ ...b, remark: TAG }, OP);
  const pSalesMgr = mkPos({ title: '销售经理', company_id: 1, department_id: 1, sequence: 'manage', grade: 3, headcount: 1 });
  const pSales = mkPos({ title: '销售专员', company_id: 1, department_id: 1, sequence: 'sales', grade: 5, headcount: 4 });
  const pTechDir = mkPos({ title: '技术总监', company_id: 1, department_id: 2, sequence: 'tech', grade: 2, headcount: 1 });
  const pPattern = mkPos({ title: '版师', company_id: 1, department_id: 2, sequence: 'tech', grade: 4, headcount: 2, reports_to_id: pTechDir.id });
  const pSample = mkPos({ title: '样衣工', company_id: 1, department_id: 2, sequence: 'ops', grade: 5, headcount: 3, reports_to_id: pTechDir.id });
  const pProdMgr = mkPos({ title: '生产经理', company_id: 1, department_id: 4, sequence: 'manage', grade: 3, headcount: 1 });
  const pSewLead = mkPos({ title: '车缝组长', company_id: 1, department_id: 4, sequence: 'manage', grade: 4, headcount: 2, reports_to_id: pProdMgr.id });
  const pSewer = mkPos({ title: '车工', company_id: 1, department_id: 4, sequence: 'ops', grade: 6, headcount: 12, reports_to_id: pSewLead.id });
  const pCutter = mkPos({ title: '裁剪工', company_id: 1, department_id: 4, sequence: 'ops', grade: 6, headcount: 4, reports_to_id: pProdMgr.id });
  const pQc = mkPos({ title: '质检员', company_id: 1, department_id: 4, sequence: 'professional', grade: 5, headcount: 2, reports_to_id: pProdMgr.id });
  const pWh = mkPos({ title: '仓管', company_id: 1, department_id: 5, sequence: 'ops', grade: 5, headcount: 3 });
  const pAcc = mkPos({ title: '会计', company_id: 1, department_id: 3, sequence: 'professional', grade: 4, headcount: 2 });
  const pHr = mkPos({ title: '人事专员', company_id: 1, department_id: 6, sequence: 'professional', grade: 5, headcount: 2 });
  // 义乌分公司独立岗位（演示「岗位归属必须与雇佣公司一致」）
  const pYwMgr = mkPos({ title: '义乌生产主管', company_id: 2, department_id: 19, sequence: 'manage', grade: 3, headcount: 1 });

  lines.push(`岗位 ${13 + 1} 个，编制合计 ${[pSalesMgr, pSales, pTechDir, pPattern, pSample, pProdMgr, pSewLead, pSewer, pCutter, pQc, pWh, pAcc, pHr, pYwMgr]
    .reduce((s, p) => s + p.headcount, 0)} 人`);

  // ---------- 任职：直接建成生效（走一遍草稿→提交→批准，把流程也演出来） ----------
  const hire = (employeeId, positionId, opt = {}) => {
    const d = O.draftEmployment({
      employee_id: employeeId,
      employer_company_id: opt.employer || 1,
      service_company_id: opt.service || null,
      position_id: positionId,
      employment_type: opt.type || 'fulltime',
      start_date: opt.start || addDays(today, -200),
      reason: opt.reason || '新入职',
      remark: TAG
    }, OP);
    O.submitEmployment(d.id, OP);
    // approved_by 不能用 OP 自己，否则「不能自批」会拦住 —— 用财务负责人批
    return O.approveEmployment(d.id, opt.approve || {}, '财务-陈默');
  };

  // 先建一段「已结束」的历史任职，再建现在的 —— 顺序反了会被「已有生效任职」挡住（规则就是这么设计的）
  const oldLin = O.draftEmployment({
    employee_id: eLin, employer_company_id: 1, position_id: pSales.id,
    start_date: addDays(today, -360), reason: '历史任职（已结束）', remark: TAG
  }, OP);
  O.submitEmployment(oldLin.id, OP);
  db.prepare("UPDATE employments SET status='ended', end_date=?, approved_by=?, approved_at=? WHERE id=?")
    .run(addDays(today, -181), '财务-陈默', t, oldLin.id);

  hire(eLin, pSales.id, { start: addDays(today, -180) });
  hire(eZhou, pSales.id, { start: addDays(today, -120) });
  hire(eXu, pPattern.id, { start: addDays(today, -300), service: null });          // 技术部服务全部主体
  hire(eLan, pPattern.id, { start: addDays(today, -90) });                          // 版师满编（2/2）
  hire(eLu, pSewLead.id, { start: addDays(today, -60), reason: '晋升：车工→车缝组长' });
  hire(eHe, pWh.id, { start: addDays(today, -150), service: 2 });                   // 总部雇佣、服务义乌
  hire(2, pSewer.id, { start: addDays(today, -400), reason: '存量员工补登记' });
  hire(5, pSample.id, { start: addDays(today, -400), reason: '存量员工补登记' });
  hire(6, pSewer.id, { start: addDays(today, -400), reason: '存量员工补登记' });
  hire(7, pQc.id, { start: addDays(today, -400), reason: '存量员工补登记' });
  hire(8, pCutter.id, { start: addDays(today, -400), reason: '存量员工补登记' });

  // 待批：版师已满编，批准时要走超编特批
  const pendingKe = O.draftEmployment({
    employee_id: eKe, employer_company_id: 1, position_id: pPattern.id,
    start_date: addDays(today, 3), reason: '新入职', remark: TAG
  }, OP);
  O.submitEmployment(pendingKe.id, OP);
  lines.push('1 条待批任职（版师 2/2 已满编）：批准会被拦，需勾超编特批并写原因');

  // ---------- 交易路线 ----------
  const mkRoute = (b) => {
    const r = O.createRoute({ ...b, note: null }, OP);
    // note 会被「切状态」覆盖，所以演示标记单独一列
    db.prepare('UPDATE trade_routes SET demo_tag=? WHERE id=?').run(TAG, r.id);
    return r;
  };
  const r1 = mkRoute({
    name: '总部自营现货（天猫）', biz_type: 'spot',
    seller_company_id: 1, sign_company_id: 1, fulfill_company_id: 1, goods_owner_company_id: 1, pay_company_id: 1
  });
  O.confirmRoute(r1.id);

  const r2 = mkRoute({
    name: '义乌代总部销售（收服务费）', biz_type: 'spot',
    seller_company_id: 1, sign_company_id: 2, fulfill_company_id: 2,
    goods_owner_company_id: 1, pay_company_id: 2,
    service_agreement: 'FW-2026-001', service_fee_rate: 3.5
  });
  O.confirmRoute(r2.id);

  const r3 = mkRoute({
    name: '外协统一浙江跳色签约', biz_type: 'outsource',
    seller_company_id: 1, sign_company_id: 1, fulfill_company_id: 2, goods_owner_company_id: 1, pay_company_id: 1
  });
  O.setRouteStatus(r3.id, { status: 'pending_terms', note: '外协加工费口径待财务确认' });

  // 美国自营：平台抬头与收款账户还没落地，付款方留空 —— 确认时会被拦住
  const r4 = mkRoute({
    name: 'Etsy 美国自营（账户待开）', biz_type: 'spot',
    seller_company_id: 3, sign_company_id: 3, fulfill_company_id: 3, goods_owner_company_id: 3,
    pay_company_id: null
  });
  lines.push('交易路线 4 条：已确认 2 / 条款待配 1 / 草稿 1（美国自营缺平台抬头与账户）');

  // ---------- 主体授权 ----------
  const mkScope = (b, submit = true) => {
    const s = O.createScope({ ...b, remark: TAG }, OP);
    return submit ? O.submitScope(s.id) : s;
  };
  const approver = '财务-陈默';

  const sc1 = mkScope({
    user_id: 2, username: 'sales01', company_ids: '1,2', field_scope: 'full',
    aggregate_scope: 'company', expires_at: addDays(today, 180),
    reason: '销售需要看义乌仓的现货库存'
  });
  O.approveScope(sc1.id, {}, approver);

  const sc2 = mkScope({
    user_id: 7, username: 'fin01', company_ids: '1,2,3', field_scope: 'full',
    aggregate_scope: 'group', expires_at: addDays(today, 20),
    reason: '财务做集团合并与内部往来对账'
  });
  O.approveScope(sc2.id, {}, approver);

  // 待批：生产主管申请看成本字段
  const sc3 = mkScope({
    user_id: 5, username: 'prod01', company_ids: '1', field_scope: 'no_salary',
    aggregate_scope: 'company', expires_at: addDays(today, 90),
    reason: '需要看订单成本做产能排产'
  });
  lines.push('1 条待批授权（生产主管申请看成本）：需独立批准人');

  // 已到期但还没清扫：演示 sweep 把 effective 置 expired
  const sc4 = mkScope({
    user_id: 6, username: 'wh01', company_ids: '1,2', field_scope: 'no_cost',
    aggregate_scope: 'company', expires_at: addDays(today, 60),
    reason: '仓库看两地主体的库存'
  });
  O.approveScope(sc4.id, {}, approver);
  db.prepare("UPDATE subject_scopes SET expires_at=? WHERE id=?").run(addDays(today, -5), sc4.id);
  lines.push('1 条授权已过期仍标「有效」：点「到期清扫」才会落库失效');

  lines.push(`授权 4 条：有效 2（其中 1 条 20 天内到期）/ 待批 1 / 已过期未清扫 1`);
  return lines;
}

if (RESET) {
  const r = reset();
  console.log('[org-demo] reset', JSON.stringify(r));
}
const out = main();
console.log('[org-demo] 写入完成：');
out.forEach((l) => console.log('  - ' + l));
console.log(`[org-demo] 基准日 ${localDate()}`);
