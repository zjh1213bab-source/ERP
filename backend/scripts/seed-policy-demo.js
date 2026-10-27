/**
 * 制度问答演示数据（M17 N17-02）
 * ------------------------------------------------------------
 * 要演示的不是「AI 会答题」，而是**答错会被抓住**：
 *   1) 请假制度改过版（V1 已废止 → V2 现行）：回答必须引 V2 与 2026-03-01，不能引 V1
 *   2) 报销与付款制度里有具体金额门槛：这类问题模型最容易编，所以原文照贴
 *   3) 「样品借用制度」还是草稿：问到必须回「没有可引用的生效制度」，不能拿草稿当依据
 *   4) 「样品管理办法」已废止：同上，并说明废止
 *   5) 留一条历史引用指向请假 V1：用于演示「制度改版后能查出旧引用」
 *
 * 用法：node scripts/seed-policy-demo.js --reset
 */
const { db } = require('../src/db');
const { localNow, localDate } = require('../src/services/sla');

const TAG = 'POLICYDEMO';
const RESET = process.argv.includes('--reset');

function reset() {
  const ids = db.prepare('SELECT id FROM sop_documents WHERE remark LIKE ?').all(`%${TAG}%`).map((r) => r.id);
  ids.forEach((id) => {
    db.prepare('DELETE FROM ai_policy_hits WHERE doc_id=?').run(id);
    db.prepare('DELETE FROM sop_acks WHERE doc_id=?').run(id);
    db.prepare('DELETE FROM sop_versions WHERE doc_id=?').run(id);
    db.prepare('DELETE FROM sop_documents WHERE id=?').run(id);
  });
  // 演示脚本造的留痕（doc 已删，按 question 前缀兜底清理）
  db.prepare("DELETE FROM ai_policy_hits WHERE question LIKE '[演示]%'").run();
  return { docs: ids.length };
}

function main() {
  const t = localNow();
  const OP = '制度演示';

  const mkDoc = (b) => {
    const id = db.prepare(
      `INSERT INTO sop_documents (doc_no,title,category,company,position,owner,status,current_version,
         effective_date,approved_by,approved_at,retired_at,retire_reason,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      b.doc_no || null, b.title, b.category || 'policy', b.company || '跳色科技',
      b.position || null, b.owner || null, b.status || 'effective',
      b.current_version || 0, b.effective_date || null, b.approved_by || null, b.approved_at || t,
      b.retired_at || null, b.retire_reason || null, `${TAG} ${b.note || ''}`.trim(), OP, t, t
    ).lastInsertRowid;
    // 编号补齐（和线上走接口时的规则一致：DOC + 日期 + 序号）
    const no = b.doc_no || `DOC${localDate().replace(/-/g, '')}${String(id).padStart(4, '0')}`;
    db.prepare('UPDATE sop_documents SET doc_no=? WHERE id=?').run(no, id);
    return id;
  };

  const addVer = (docId, v) => {
    db.prepare(
      `INSERT INTO sop_versions (doc_id,version,doing,inputs,done_criteria,escalate_path,change_note,status,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(docId, v.version, v.doing, v.inputs || null, v.done_criteria || null, v.escalate_path || null,
      v.change_note || null, v.status || 'effective', OP, t);
  };

  // ---------- 1. 考勤与请假：改过版 ----------
  const leaveId = mkDoc({
    title: '考勤与请假管理制度', category: 'policy', owner: '人事-张敏',
    status: 'effective', current_version: 2, effective_date: '2026-03-01',
    approved_by: '总经理', note: 'V1 已废止，V2 现行'
  });
  addVer(leaveId, {
    version: 1, status: 'retired',
    doing: '请假 1 天以内由主管审批，1 天以上由部门负责人审批。年假须提前 2 个工作日在系统提交。',
    done_criteria: '审批链完整、人事备案',
    change_note: '初版'
  });
  addVer(leaveId, {
    version: 2, status: 'effective',
    doing: '请假 1 天以内由直属主管审批；1 天以上 3 天以内由主管审批后报人事备案；3 天以上须部门负责人与人事经理共同审批。'
      + '年假须提前 3 个工作日在系统提交；病假须在当天 10:00 前提交并附就诊记录。事假全年累计不得超过 15 天。'
      + '连续请假超过 5 个工作日须指定代班人并完成交接。',
    inputs: '请假单（起止日期、事由、代班人）；病假附就诊记录；年假需有可用余额',
    done_criteria: '审批链完整、人事备案、考勤状态同步为「请假」、代班人已确认',
    escalate_path: '超时 24 小时未审批升级至部门负责人；48 小时未审批升级至人事经理',
    change_note: 'V2：3 天以上改为部门负责人 + 人事经理共同审批；新增代班人要求'
  });

  // ---------- 2. 差旅与报销标准 ----------
  const tripId = mkDoc({
    title: '差旅与报销标准', category: 'policy', owner: '财务-陈默',
    status: 'effective', current_version: 1, effective_date: '2026-01-15',
    approved_by: '总经理', note: '含具体金额门槛'
  });
  addVer(tripId, {
    version: 1, status: 'effective',
    doing: '市内交通实报实销，须附行程单；住宿费一线城市 450 元/晚以内、其他城市 350 元/晚以内；餐补 80 元/天。'
      + '超标部分须事前书面批准，未批准的超出部分个人承担 50%。报销单据须在出差结束后 10 个工作日内提交，逾期需说明原因。',
    inputs: '出差申请单、发票、行程单、超标特批单（如适用）',
    done_criteria: '发票齐全、审批完成、金额在标准内或附特批说明',
    escalate_path: '单笔报销超过 5000 元由财务经理审批；超过 20000 元报总经理审批'
  });

  // ---------- 3. 大货付款审批权限 ----------
  const payId = mkDoc({
    title: '大货付款审批权限', category: 'rule', owner: '财务-陈默',
    status: 'effective', current_version: 1, effective_date: '2026-06-01',
    approved_by: '总经理', note: '按金额分级'
  });
  addVer(payId, {
    version: 1, status: 'effective',
    doing: '单笔付款 5 万元以内由财务经理审批；5 万元至 20 万元由财务总监审批；20 万元以上报总经理审批。'
      + '预付款比例原则上不超过合同金额的 30%，超过须总经理批准。付款前须核对合同、发票、验收单三单一致，'
      + '收款账户变更一律暂停付款并由财务经理书面复核。',
    inputs: '合同、发票、验收单、付款申请单',
    done_criteria: '三单一致、审批层级符合金额档位、收款账号与合同一致',
    escalate_path: '审批超 24 小时升级至上一级；超 48 小时升级至总经理'
  });

  // ---------- 4. 草稿：问到必须说"没有可引用的生效制度" ----------
  const draftId = mkDoc({
    title: '样品借用与归还制度（草稿）', category: 'policy', owner: '技术-许工',
    status: 'draft', current_version: 0, effective_date: null, note: '草稿，不可引用'
  });

  // ---------- 5. 已废止：问到必须说废止 ----------
  const oldId = mkDoc({
    title: '样品管理办法（2024 版，已废止）', category: 'policy', owner: '技术-许工',
    status: 'retired', current_version: 1, effective_date: '2025-03-01',
    retired_at: '2026-06-30', retire_reason: '由《样品借用与归还制度》替代（尚未发布）',
    note: '已废止'
  });
  addVer(oldId, {
    version: 1, status: 'retired',
    doing: '样品借出须填写纸质登记本，归还期限 30 天。',
    done_criteria: '登记本签字、样衣回库',
    change_note: '旧版'
  });

  // ---------- 6. 历史引用留痕：当时引的是已废止的 V1 ----------
  db.prepare(
    `INSERT INTO ai_policy_hits (question,doc_id,doc_no,title,version,effective_date,owner,coverage,rank,
       answer_generated_by,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('[演示] 请假 4 天要谁批？', leaveId,
    (db.prepare('SELECT doc_no FROM sop_documents WHERE id=?').get(leaveId) || {}).doc_no,
    '考勤与请假管理制度', 1, '2025-01-15', '人事-张敏', 78, 1, 'rule', 'admin', t);

  return {
    docs: 5,
    effective: 3,
    draft: 1,
    retired: 1,
    lines: [
      '《考勤与请假管理制度》V2 现行（V1 已废止）：3 天以上须部门负责人 + 人事经理共同审批',
      '《差旅与报销标准》V1：住宿一线 450 / 其他 350，餐补 80，超 5000 由财务经理批',
      '《大货付款审批权限》V1：5 万内财务经理 / 5-20 万财务总监 / 20 万以上总经理',
      '《样品借用与归还制度》草稿：问到只能回「没有可引用的生效制度」',
      '《样品管理办法》已废止：问到要说明废止原因',
      '留痕 1 条指向请假 V1：用于演示「旧引用被标 outdated」'
    ]
  };
}

if (RESET) {
  const r = reset();
  console.log('[policy-demo] reset', JSON.stringify(r));
}
const out = main();
console.log('[policy-demo] 写入完成：');
out.lines.forEach((l) => console.log('  - ' + l));
console.log(`[policy-demo] 基准日 ${localDate()}`);
