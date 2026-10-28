/**
 * 验货报告 DDL
 *
 * 报告是「发给客户的一份文件」，不是「一个实时页面」——
 * 所以必须存快照：生成那一刻的数据序列化进 snapshot，
 * 之后内部又报了工、又补了照片，客户手里那份不会跟着变。
 * 做不到这一点，一出纠纷就说不清「你给我的报告和你系统里的不一样」。
 */
const { db } = require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS inspection_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_no TEXT UNIQUE NOT NULL,              -- JH+日期+序号，对外引用用这个
  order_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,          -- 同一订单可多次生成，旧版不覆盖
  qc_result TEXT,                              -- pass / fail / conditional / none（未验货）
  qc_inspection_no TEXT,                       -- 结论来自哪张验货单
  photos_count INTEGER NOT NULL DEFAULT 0,
  issues_open INTEGER NOT NULL DEFAULT 0,      -- 生成时仍未关闭的质量异常数
  snapshot TEXT NOT NULL,                      -- JSON：订单/明细/验货/异常/首件/报工/照片
  generated_by TEXT,
  generated_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ireport_order ON inspection_reports(order_id, version);
`);

console.log('✓ inspection_reports');
