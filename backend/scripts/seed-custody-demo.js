/**
 * 资产工衣与领归 演示数据
 * ----------------------------------------------------------------------
 * 造一个真实的行政现场（不是一堆空表）：
 *   - 3 件工衣（XL/L/S）、1 件已处置旧工衣
 *   - 4 把钥匙/门禁卡、2 台对讲机、1 把电动螺丝刀（挂固定资产卡）、1 批劳保手套（按量）
 *   - 8 条领用记录：在用 / 已还 / 逾期 / 遗失 / 已核销
 *   - 1 张离职清退单（门禁卡必须归还且已逾期，工衣不强制、未退回）
 *   - 2 张损坏复核：一张待财务确认（60% 责任），一张已财务确认（全责 520 元）
 *
 * 全部数据都带 `demo_tag='DEMO'`，`--clean` 一次清干净。
 * 单号由服务层生成（不手写），保证与真实单据同格式。
 *
 * 用法：
 *   node scripts/seed-custody-demo.js           生成
 *   node scripts/seed-custody-demo.js --clean    清干净
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');
const S = require('../src/services/custody');

const MARK = 'DEMO';
const t = now();
const day = (n) => localDate(new Date(Date.now() + n * 86400000).toISOString());
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString();

function clean() {
  const recs = db.prepare('SELECT id FROM custody_records WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  recs.forEach((id) => db.prepare("DELETE FROM custody_actions WHERE target_type='record' AND target_id=?").run(id));
  const claims = db.prepare('SELECT id FROM custody_claims WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  claims.forEach((id) => db.prepare("DELETE FROM custody_actions WHERE target_type='claim' AND target_id=?").run(id));
  const clrs = db.prepare('SELECT id FROM custody_clearances WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  clrs.forEach((id) => db.prepare("DELETE FROM custody_actions WHERE target_type='clearance' AND target_id=?").run(id));
  const items = db.prepare('SELECT id FROM custody_items WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  items.forEach((id) => db.prepare("DELETE FROM custody_actions WHERE target_type='item' AND target_id=?").run(id));

  db.prepare('DELETE FROM custody_claims WHERE demo_tag = ?').run(MARK);
  db.prepare('DELETE FROM custody_records WHERE demo_tag = ?').run(MARK);
  db.prepare('DELETE FROM custody_clearances WHERE demo_tag = ?').run(MARK);
  db.prepare('DELETE FROM custody_items WHERE demo_tag = ?').run(MARK);
  db.prepare("DELETE FROM custody_actions WHERE demo_tag = ?").run(MARK);
  // 演示用的资产卡（与电动螺丝刀一物一码对应）
  db.prepare("DELETE FROM assets WHERE name LIKE '演示-%'").run();

  console.log(`清掉演示：实物 ${items.length} · 领用 ${recs.length} · 清退 ${clrs.length} · 复核 ${claims.length}`);
}

if (process.argv.includes('--clean')) { clean(); process.exit(0); }
clean();

/* ---------------- 员工与资产 ---------------- */
const emps = db.prepare("SELECT id, name, department_id FROM employees WHERE status = 'active' ORDER BY id LIMIT 4").all();
if (emps.length < 3) {
  console.error('演示数据需要至少 3 名在职员工，请先执行 seed 基础数据');
  process.exit(1);
}
const [E1, E2, E3, E4 = E3] = emps;
// 造一条与实物对得上号的资产卡（电动螺丝刀原值 480、3 年折旧），
// 用来演示「行政页的净值直接读资产台账，不重复计提」
const demoAsset = (() => {
  const info = db.prepare(`INSERT INTO assets (code, name, category, dept, keeper, purchase_date,
      original_value, salvage_rate, useful_years, status, remark, created_at, updated_at, company_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'DEMO-ASSET-01', '演示-电动螺丝刀', '机器设备', '人事行政部', null, '2025-03-15',
    480, 0.05, 3, 'in_use', '工衣领归演示：与实物一物一码对应，清理时按名字前缀删除', t, t, 1
  );
  return { id: Number(info.lastInsertRowid), name: '演示-电动螺丝刀' };
})();

/* ---------------- 实物档案 ---------------- */
const mkItem = (b) => {
  const it = S.saveItem(b, 'seed');
  db.prepare('UPDATE custody_items SET demo_tag = ?, created_at = ?, updated_at = ? WHERE id = ?').run(MARK, t, t, it.id);
  // 建档动作也打标记，方便一起清
  db.prepare("UPDATE custody_actions SET demo_tag = ? WHERE target_type='item' AND target_id = ?").run(MARK, it.id);
  return it;
};

const uXL = mkItem({ name: '夏季工衣', kind: 'uniform', durable: 1, require_return: 0, spec: '棉 65% / 涤 35%', size: 'XL', color: '藏青', qty_total: 1, unit: '件', max_per_person: 2, location: '行政仓 A-1', note: '按政策不强制退回' });
const uL = mkItem({ name: '夏季工衣', kind: 'uniform', durable: 1, require_return: 0, spec: '棉 65% / 涤 35%', size: 'L', color: '藏青', qty_total: 1, unit: '件', max_per_person: 2, location: '行政仓 A-1' });
const uOld = mkItem({ name: '旧款工衣', kind: 'uniform', durable: 1, require_return: 0, size: 'S', color: '灰', qty_total: 1, unit: '件', location: '行政仓 A-2', note: '换版淘汰' });
const keyFront = mkItem({ name: '前台钥匙', kind: 'key', durable: 1, require_return: 1, item_code: 'A-03', qty_total: 1, unit: '把', location: '钥匙柜 A-03' });
const keyWh = mkItem({ name: '仓库钥匙', kind: 'key', durable: 1, require_return: 1, item_code: 'B-01', qty_total: 1, unit: '把', location: '钥匙柜 B-01' });
const card1 = mkItem({ name: '门禁卡', kind: 'card', durable: 1, require_return: 1, item_code: 'CARD-01', qty_total: 1, unit: '张' });
const talk1 = mkItem({ name: '对讲机', kind: 'tool', durable: 1, require_return: 1, spec: '摩托罗拉 T82', qty_total: 1, unit: '台', location: '行政仓 B-2' });
const talk2 = mkItem({ name: '对讲机', kind: 'tool', durable: 1, require_return: 1, spec: '摩托罗拉 T82', qty_total: 1, unit: '台', location: '行政仓 B-2' });
const tablet = mkItem({ name: '盘点平板', kind: 'tool', durable: 1, require_return: 1, spec: '红米 Pad SE', qty_total: 1, unit: '台', location: '行政仓 B-3' });
const drill = mkItem({
  name: '电动螺丝刀', kind: 'tool', durable: 1, require_return: 1, spec: '博世 GO 3', qty_total: 1, unit: '把',
  location: '工位柜 C-1', asset_id: demoAsset.id
});
const gloves = mkItem({ name: '劳保手套', kind: 'ppe', durable: 0, require_return: 0, spec: '加厚防滑', qty_total: 200, unit: '双', note: '按量核销，领出即消耗' });

/* ---------------- 领用 ---------------- */
const mkRec = (b, patch = {}) => {
  const r = S.createRecord(b, 'seed');
  db.prepare('UPDATE custody_records SET demo_tag = ? WHERE id = ?').run(MARK, r.id);
  const sets = Object.keys(patch);
  if (sets.length) {
    db.prepare(`UPDATE custody_records SET ${sets.map((k) => k + ' = ?').join(', ')} WHERE id = ?`)
      .run(...sets.map((k) => patch[k]), r.id);
  }
  db.prepare("UPDATE custody_actions SET demo_tag = ? WHERE target_type='record' AND target_id = ?").run(MARK, r.id);
  return r;
};

// 工衣：不设期限、不进超期清单（一条已领一年，页面只提示「可换新」）
const rUniform1 = mkRec({ item_id: uXL.id, employee_id: E1.id, note: '入职发放' }, { issued_at: iso(-360) });
const rUniform2 = mkRec({ item_id: uL.id, employee_id: E3.id, note: '换季发放' }, { issued_at: iso(-62) });

// 钥匙：一条正常在借（7 天后到期），一条已还
const rKeyWh = mkRec({ item_id: keyWh.id, employee_id: E2.id, expected_return_at: day(7), note: '仓库盘点用' }, { issued_at: iso(-3) });
const rKeyFront = mkRec({ item_id: keyFront.id, employee_id: E2.id }, { issued_at: iso(-40) });
S.returnRecord(rKeyFront.id, { condition: 'good', note: '前台换班交回' }, 'seed');

// 工具：超期 5 天
const rDrill = mkRec({ item_id: drill.id, employee_id: E1.id, expected_return_at: day(2), note: '工位维修借用' }, { issued_at: iso(-20), expected_return_at: day(-5) });

// 劳保：按量领用，不进归还清单
const rGloves = mkRec({ item_id: gloves.id, employee_id: E2.id, qty: 30, note: '车间月度发放' }, { issued_at: iso(-10) });

// 对讲机 1：损坏归还 → 待复核 → 部分责任 60%（还没财务确认）
const rTalk1 = mkRec({ item_id: talk1.id, employee_id: E4.id, expected_return_at: day(5), note: '活动保障' }, { issued_at: iso(-15) });
S.returnRecord(rTalk1.id, { condition: 'damaged', claim_amount: 800, note: '摔落，屏幕碎裂，外壳变形' }, 'seed');

// 对讲机 2：遗失 → 全责 → 财务已确认
const rTalk2 = mkRec({ item_id: talk2.id, employee_id: E2.id, expected_return_at: day(3), note: '夜班巡检' }, { issued_at: iso(-30) });
S.returnRecord(rTalk2.id, { condition: 'lost', claim_amount: 520, note: '巡检途中遗失，已报行政备案' }, 'seed');

// 盘点平板：损坏归还 → 还没人复核（演示「待复核」这一步）
const rTablet = mkRec({ item_id: tablet.id, employee_id: E1.id, expected_return_at: day(4), note: '年中盘点' }, { issued_at: iso(-25) });
S.returnRecord(rTablet.id, { condition: 'damaged', claim_amount: 1200, note: '屏幕漏液，无法开机' }, 'seed');

// 把三张复核单打上演示标记
db.prepare("UPDATE custody_claims SET demo_tag = ?, created_at = ? WHERE record_id IN (?, ?, ?)").run(MARK, t, rTalk1.id, rTalk2.id, rTablet.id);
db.prepare("UPDATE custody_actions SET demo_tag = ? WHERE target_type='claim' AND target_id IN (SELECT id FROM custody_claims WHERE demo_tag = ?)").run(MARK, MARK);

const claimDamaged = db.prepare('SELECT * FROM custody_claims WHERE record_id = ?').get(rTalk1.id);
const claimLost = db.prepare('SELECT * FROM custody_claims WHERE record_id = ?').get(rTalk2.id);

S.reviewClaim(claimDamaged.id, { decision: 'partial', liable_pct: 60, reviewer_note: '正常使用中摔落，非故意；本人承担 60% 重置成本' }, '行政主管');
S.reviewClaim(claimLost.id, { decision: 'liable', reviewer_note: '巡检途中遗失且未及时上报，全责' }, '行政主管');
S.confirmFinance(claimLost.id, { finance_confirm_no: 'SK-20261028-018', finance_note: '已在 10 月工资扣除' }, '财务主管', ['finance']);

/* ---------------- 离职清退：门禁卡必须还（已逾期 3 天）、工衣不强制 ---------------- */
const rCard = mkRec({ item_id: card1.id, employee_id: E3.id, note: '入职发放' }, { issued_at: iso(-120) });
const clr = S.buildClearance({ employee_id: E3.id, leave_date: day(-3), reason: '调岗至义乌仓' }, '行政主管');
db.prepare('UPDATE custody_clearances SET demo_tag = ? WHERE id = ?').run(MARK, clr.id);
db.prepare("UPDATE custody_records SET demo_tag = ? WHERE clearance_id = ?").run(MARK, clr.id);
db.prepare("UPDATE custody_actions SET demo_tag = ? WHERE target_type='clearance' AND target_id = ?").run(MARK, clr.id);

/* ---------------- 处置一件旧工衣 ---------------- */
S.scrapItem(uOld.id, { scrap_mode: 'write_off', scrap_no: 'CZ-20261020-002', note: '换版淘汰，盘点已核销' }, '行政主管');
db.prepare("UPDATE custody_actions SET demo_tag = ? WHERE target_type='item' AND target_id = ?").run(MARK, uOld.id);

/* ---------------- 结果 ---------------- */
const s = S.stats();
console.log('演示数据已生成：');
console.log(`  实物档案 ${db.prepare('SELECT COUNT(*) c FROM custody_items WHERE demo_tag = ?').get(MARK).c} 种`);
console.log(`  领用记录 ${db.prepare('SELECT COUNT(*) c FROM custody_records WHERE demo_tag = ?').get(MARK).c} 条`);
console.log(`  离职清退 ${db.prepare('SELECT COUNT(*) c FROM custody_clearances WHERE demo_tag = ?').get(MARK).c} 张`);
console.log(`  损坏复核 ${db.prepare('SELECT COUNT(*) c FROM custody_claims WHERE demo_tag = ?').get(MARK).c} 张`);
console.log(`  看板：在手上 ${s.open_cnt} · 逾期 ${s.overdue_cnt} · 不催退回 ${s.optional_out_cnt} · 待复核 ${s.claim_pending} · 待财务确认 ¥${s.claim_unconfirmed_amount}`);
