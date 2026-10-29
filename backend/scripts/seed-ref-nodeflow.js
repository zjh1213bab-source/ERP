/**
 * 把默认流程调成参考系统（衣创生产订单）那套节点
 *
 * 用法：node scripts/seed-ref-nodeflow.js [--dry]
 *
 * ## 为什么不是「照抄 13 个节点」
 *
 * 参考页的 13 个节点里**没有「检验」「包装」**，而本系统的成品入库有两道闸门
 * （`orderFlow.checkProductionReadyForStock` 要按 code 找 `inspect` / `pack`）。
 * 照抄就会：节点列好看了，但任何单都入不了库 —— 提示「生产检验工序尚未完成」，
 * 而界面上根本找不到那个节点。
 *
 * 所以这里保留「检验」「包装」，排在「尾部」之后、「入库」之前 ——
 * 业务上也正是这个顺序（尾部 → 检验 → 包装 → 入库）。
 * 最终 15 个节点，比参考多 2 个，这 2 个是入库校验的硬依赖。
 *
 * ## 参考页没有的工序怎么办
 *
 * 备料 / 锁眼钉扣 / 整烫 / 水洗 / 印花 / 绣花 —— 停用，不删除。
 * 停用只影响新订单，老订单里那些记录原样留着（订单详情还能查到「这单走过水洗」）。
 */
const { db } = require('../src/db');
const svc = require('../src/services/nodeFlow');

const DRY = process.argv.includes('--dry');

/** 参考页的节点顺序 + 本系统必须保留的两道闸门 */
const TARGET = [
  ['待分配订单', 'c_new_1', 'production'],
  ['排版算料', 'layout', 'production'],
  ['面料采购', 'c_new_2', 'warehouse'],
  ['辅料采购', 'c_new_3', 'warehouse'],
  ['票菲工艺单打印', 'c_new_4', 'production'],
  ['领料', 'c_new_5', 'warehouse'],
  ['裁床', 'cut', 'production'],          // 原「裁剪」改名
  ['辅料配送', 'c_new_6', 'warehouse'],
  ['车缝', 'sew', 'production'],
  ['尾部', 'c_new_7', 'production'],
  ['检验', 'inspect', 'qc'],              // 入库闸门，必须留
  ['包装', 'pack', 'production'],         // 入库闸门，必须留
  ['入库', 'instock', 'warehouse'],       // 原「成品入库」改名
  ['发货', 'ship', 'warehouse'],          // 原「出库发运」改名
  ['已完成', 'c_new_8', 'production']
];

/** 参考页没有的工序：停用（老订单记录不动） */
const TURN_OFF = ['prep', 'buttonhole', 'iron', 'wash', 'print', 'embroider'];

/** 内置节点改名（code 不变，所以裁床单/首件确认/入库校验照旧生效） */
const RENAME = { cut: '裁床', instock: '入库', ship: '发货' };

function main() {
  const tpl = svc.defaultTemplate();
  console.log(`默认流程：#${tpl.id} ${tpl.name}`);

  const items = db.prepare('SELECT * FROM node_template_items WHERE template_id = ? ORDER BY seq, id').all(tpl.id);
  const byCode = new Map(items.map((x) => [x.code, x]));
  console.log(`现有节点 ${items.length} 个`);

  const t = new Date().toISOString();
  let added = 0; let renamed = 0; let turnedOff = 0; let reordered = 0;

  db.exec('BEGIN');
  try {
    /* ---- 1. 补齐参考页有、模板里没有的节点 ---- */
    const ins = db.prepare(
      `INSERT INTO node_template_items
        (template_id, code, name, seq, required, role, builtin, status, created_at, updated_at)
       VALUES (?,?,?,?,1,?,0,'active',?,?)`
    );
    TARGET.forEach(([name, code, role]) => {
      if (byCode.has(code)) return;
      ins.run(tpl.id, code, name, 999, role, t, t);
      added += 1;
      console.log(`  + 新增节点 ${name}（${code}）`);
    });

    /* ---- 2. 改名（code 不动，联动照旧） ---- */
    const updName = db.prepare('UPDATE node_template_items SET name = ?, updated_at = ? WHERE id = ?');
    Object.entries(RENAME).forEach(([code, name]) => {
      const row = byCode.get(code);
      if (!row || row.name === name) return;
      updName.run(name, t, row.id);
      renamed += 1;
      console.log(`  ~ 改名 ${row.name} → ${name}（code 仍是 ${code}）`);
    });

    /* ---- 3. 停用参考页没有的工序 ---- */
    const off = db.prepare("UPDATE node_template_items SET status = 'off', updated_at = ? WHERE id = ?");
    TURN_OFF.forEach((code) => {
      const row = byCode.get(code);
      if (!row || row.status === 'off') return;
      if (['cut', 'sew', 'inspect', 'pack'].includes(code)) {
        console.log(`  ! ${row.name} 有联动逻辑，跳过停用`);
        return;
      }
      off.run(t, row.id);
      turnedOff += 1;
      console.log(`  - 停用 ${row.name}（老订单记录保留）`);
    });

    /* ---- 4. 按参考页顺序重排 ---- */
    const updSeq = db.prepare('UPDATE node_template_items SET seq = ?, updated_at = ? WHERE id = ?');
    TARGET.forEach(([, code], i) => {
      const row = db.prepare('SELECT id FROM node_template_items WHERE template_id = ? AND code = ?').get(tpl.id, code);
      if (row) { updSeq.run(i + 1, t, row.id); reordered += 1; }
    });
    // 停用的节点排到最后，避免影响显示顺序
    items.forEach((x) => {
      if (TURN_OFF.includes(x.code)) updSeq.run(900 + Number(x.seq || 0), t, x.id);
    });

    if (DRY) {
      db.exec('ROLLBACK');
      console.log('\n--dry：已回滚，未写入');
      return;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  console.log(`\n节点模型已调整：新增 ${added} / 改名 ${renamed} / 停用 ${turnedOff} / 重排 ${reordered}`);

  /* ---- 5. 把新节点补到在产订单上 ---- */
  const apply = svc.applyToOrders(tpl.id, { dryRun: true });
  console.log(`在产订单里需要补节点的：${apply.total_orders} 张 / ${apply.total_rows} 个节点`);
  if (apply.total_rows > 0) {
    const done = svc.applyToOrders(tpl.id, { dryRun: false });
    console.log(`已补：${done.total_orders} 张订单，${done.total_rows} 个节点`);
  }

  const after = svc.getTemplate(tpl.id);
  const active = after.items.filter((x) => x.status === 'active');
  console.log('\n调整后的看板节点（从左到右）：');
  console.log('  ' + active.map((x, i) => `${i + 1}.${x.name}`).join('  '));
  console.log(`共 ${active.length} 个启用节点（停用 ${after.items.length - active.length} 个）`);
}

main();
