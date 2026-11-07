/** 样衣成本只读证据。复用工资试算的封顶、归人、倍率及考勤规则，绝不另写计价。 */
const { db } = require('../db');
const wages = require('./pieceWage');
function read(id) {
  const t = db.prepare('SELECT * FROM tech_packs WHERE id=?').get(id);
  if (!t) return null;
  const mats = db.prepare('SELECT amount FROM tech_pack_materials WHERE tech_pack_id=?').all(id);
  const order = t.order_id ? db.prepare('SELECT order_no FROM orders WHERE id=?').get(t.order_id) : null;
  const months = order ? db.prepare("SELECT DISTINCT substr(report_date,1,7) period FROM production_reports WHERE order_id=?").all(t.order_id) : [];
  const code = String(t.customer_style_no || '').trim();
  let known = 0, matched = 0, missing = 0, unallocated = 0, capped = 0;
  for (const {period} of months) {
    if (!/^\d{4}-\d{2}$/.test(period)) { unallocated++; continue; }
    // 必须计算全月再过滤本款，否则跨订单日/月封顶会失效。
    const result = wages.preview(period);
    for (const row of result.items.filter(r => r.order_id === t.order_id)) {
      if (!code || row.style_no !== code) { if (!row.style_no || !code) unallocated++; continue; }
      known += row.amount; matched++; if (row.capped) capped++;
    }
    missing += result.diagnostics.missing_rate.filter(r => r.order_no === order.order_no && (!code || !r.style_no || r.style_no === code)).length;
    unallocated += result.diagnostics.unassigned.filter(r => r.order_no === order.order_no).length;
  }
  return {
    tech_pack_id:t.id, version:t.version,
    material_unit_cost:mats.length ? wages.round2(mats.reduce((n,r)=>n+Number(r.amount||0),0)) : null,
    material_rows:mats.length, scan_known_amount:matched ? wages.round2(known) : null,
    scan_rows:matched, missing_price_rows:missing, unallocated_rows:unallocated, capped_rows:capped,
    scan_complete:matched>0 && !missing && !unallocated, combined_total:null,
    limitation:'面辅料为单件金额，扫码为当前计件规则试算金额（含倍率、超报及考勤封顶），并非已发工资。核算数量未定版前不合并；缺单价或无法归人归款的记录不计入已知金额。'
  };
}
module.exports={read};
