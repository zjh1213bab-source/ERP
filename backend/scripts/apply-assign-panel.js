/**
 * 把「待分配订单」节点的弹窗类型设成「生产分配」
 *
 * 用法：node scripts/apply-assign-panel.js [--dry]
 *
 * ## 为什么用脚本改数据，而不是按 code 写死
 *
 * 面板类型是**模板属性**（`node_template_items.panel`），业务在「节点流程」
 * 配置页里随时能改。如果代码里按 `code = 'c_new_1'` 判断"这是分配节点"，
 * 那么业务把节点删了重建（code 变成 c_new_9）、或者把「排版算料」改名成
 * 「待分配」，判断就静默失效 —— 而界面上只是"点了分配按钮没了"。
 *
 * 所以这里只做一次性数据订正：名字里带「待分配」的节点，panel 设成 assign。
 * 之后完全由配置页说了算。
 *
 * ## 已经手工配过的节点不动
 *
 * 只改 `panel = 'generic'` 的（默认值）。业务如果已经把它配成别的类型，
 * 说明他有自己的用法，覆盖掉就是把人家的配置吞了。
 */
const { db } = require('../src/db');

const DRY = process.argv.includes('--dry');

const rows = db.prepare(
  `SELECT i.id, i.template_id, i.code, i.name, i.panel, t.name AS tpl_name
     FROM node_template_items i JOIN node_templates t ON t.id = i.template_id
    WHERE TRIM(IFNULL(i.panel,'')) IN ('', 'generic')
      AND (i.name LIKE '%待分配%' OR i.name LIKE '%分配订单%')
    ORDER BY i.template_id, i.seq`
).all();

if (!rows.length) {
  console.log('没有需要改的节点（可能已经配过，或者流程里没有「待分配」这一步）');
} else {
  console.log(`命中 ${rows.length} 个节点：`);
  rows.forEach((r) => console.log(`  [流程 ${r.tpl_name}] ${r.name}（${r.code}）panel: ${r.panel || '空'} → assign`));
  if (!DRY) {
    const up = db.prepare("UPDATE node_template_items SET panel = 'assign', updated_at = ? WHERE id = ?");
    const t = new Date().toISOString();
    rows.forEach((r) => up.run(t, r.id));
    console.log('已更新。');
  } else {
    console.log('（--dry 只列不改）');
  }
}

/* ---------------- 体检：分配节点应该只有一个，且排在最前 ---------------- */
const all = db.prepare(
  `SELECT i.template_id, i.name, i.seq,
          (SELECT COUNT(*) FROM node_template_items x WHERE x.template_id = i.template_id AND x.panel = 'assign') AS cnt
     FROM node_template_items i WHERE i.panel = 'assign' ORDER BY i.template_id, i.seq`
).all();
const dup = new Map();
all.forEach((r) => dup.set(r.template_id, (dup.get(r.template_id) || 0) + 1));
dup.forEach((n, tpl) => {
  if (n > 1) console.warn(`⚠ 流程 #${tpl} 有 ${n} 个分配节点：一张单分两遍会超量，建议只留一个`);
});
console.log(`\n现有分配节点 ${all.length} 个：${all.map((r) => `${r.name}(seq ${r.seq})`).join('、') || '无'}`);
