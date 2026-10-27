/**
 * M10 备料领退与盘点差异 —— 演示数据（幂等）
 * ============================================================
 * 用法：node scripts/seed-matflow-demo.js [--reset]
 *
 * 演示 6 种真实处境：
 *   ① 已备料未发料（占用库存，别的单领不走）
 *   ② 已发料但欠发（车间领少了，单据停在「部分发出」，欠料看得见）
 *   ③ 余料退回（退料入库，可退量随之减少）
 *   ④ 盘点：盘亏（裁床边角料没登记）+ 盘盈（拆箱余数没入账）+ 一条**没有采购价、算不出金额**的差异
 *   ⑤ 未开始的盘点单（草稿，不冻结库存）
 *   ⑥ 原料台账：账面 / 占用 / 可用三列对得上，且每条增减都有流水
 *
 * 全部走 services/matflow 的真实逻辑（备料占用、发料扣减、退料校验、盘点调账），
 * 演示数据本身就是这层的回归测试。
 */
const { db } = require('../src/db');
const M = require('../src/services/matflow');

const TAG = 'mf_demo';
const reset = process.argv.includes('--reset');
const pad = (n) => String(n).padStart(2, '0');
function D(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const ts = (dateStr, hh) => `${dateStr} ${pad(hh)}:${pad(10)}:00`;

// ---------- 演示原料（code 前缀 MF-DEMO，便于精确清理） ----------
const MATS = [
  { code: 'MF-DEMO-01', type: 'fabric', name: '涤纶四面弹 240G', spec: '150cm', unit: '米', stock: 1200, price: 26 },
  { code: 'MF-DEMO-02', type: 'fabric', name: '精梳棉双面布 280G', spec: '160cm', unit: '米', stock: 1500, price: 26 },
  { code: 'MF-DEMO-03', type: 'fabric', name: '全棉斜纹布', spec: '145cm', unit: '米', stock: 1200, price: 22 },
  { code: 'MF-DEMO-04', type: 'fabric', name: '190T 涤塔夫里布', spec: '150cm', unit: '米', stock: 600, price: 5.6 },
  { code: 'MF-DEMO-05', type: 'accessory', name: '织唛主标', spec: '30×30mm', unit: '个', stock: 2000, price: 0.6 },
  { code: 'MF-DEMO-06', type: 'accessory', name: '树脂纽扣 4 孔 18L', spec: '18L', unit: '个', stock: 5000, price: 0.12 },
  { code: 'MF-DEMO-07', type: 'accessory', name: 'YKK 尼龙拉链 60cm', spec: '60cm', unit: '条', stock: 900, price: 3.2 },
  // 故意不给采购价：盘点差异算不出金额，必须显示「未计价」而不是 0
  { code: 'MF-DEMO-08', type: 'accessory', name: '包边条（客户供）', spec: '20mm', unit: '米', stock: 50, price: null }
];

function clean() {
  const mats = db.prepare("SELECT id FROM materials WHERE code LIKE 'MF-DEMO-%'").all().map((r) => r.id);
  // 演示单 + 冒烟测试留下的单一起清（冒烟的 note / reason 都以「冒烟测试」开头）
  const pickIssue = db.prepare("SELECT id FROM material_issues WHERE demo_tag = ? OR note LIKE '%冒烟测试%'");
  const pickTake = db.prepare("SELECT id FROM stocktakes WHERE demo_tag = ? OR note LIKE '%冒烟测试%' OR note LIKE '%重放清理%'");
  const pickRet = db.prepare("SELECT id FROM material_returns WHERE demo_tag = ? OR reason LIKE '%冒烟测试%'");
  const issueIds = pickIssue.all(TAG).map((r) => r.id);
  const takeIds = pickTake.all(TAG).map((r) => r.id);
  const retIds = pickRet.all(TAG).map((r) => r.id);
  const inSql = (arr) => (arr.length ? arr.map(() => '?').join(',') : null);

  db.exec('BEGIN');
  try {
    if (retIds.length) {
      db.prepare(`DELETE FROM material_ledger WHERE ref_type='material_return' AND ref_id IN (${inSql(retIds)})`).run(...retIds);
      db.prepare(`DELETE FROM material_return_items WHERE return_id IN (${inSql(retIds)})`).run(...retIds);
      db.prepare(`DELETE FROM material_returns WHERE id IN (${inSql(retIds)})`).run(...retIds);
    }
    if (issueIds.length) {
      db.prepare(`DELETE FROM material_ledger WHERE ref_type='material_issue' AND ref_id IN (${inSql(issueIds)})`).run(...issueIds);
      db.prepare(`DELETE FROM material_issue_items WHERE issue_id IN (${inSql(issueIds)})`).run(...issueIds);
      db.prepare(`DELETE FROM material_issues WHERE id IN (${inSql(issueIds)})`).run(...issueIds);
    }
    if (takeIds.length) {
      db.prepare(`DELETE FROM material_ledger WHERE ref_type='stocktake' AND ref_id IN (${inSql(takeIds)})`).run(...takeIds);
      db.prepare(`DELETE FROM stocktake_items WHERE take_id IN (${inSql(takeIds)})`).run(...takeIds);
      db.prepare(`DELETE FROM stocktakes WHERE id IN (${inSql(takeIds)})`).run(...takeIds);
    }
    // 期初流水
    db.prepare("DELETE FROM material_ledger WHERE ref_type='seed' AND ref_no='MF-DEMO-OPEN'").run();
    // 演示订单用料
    db.prepare("DELETE FROM order_materials WHERE remark = ?").run('MF-DEMO');
    // 演示采购价（给 lastPrice 用）
    const poIds = db.prepare("SELECT id FROM purchase_orders WHERE po_no LIKE 'MFPODEMO%'").all().map((r) => r.id);
    if (poIds.length) {
      db.prepare(`DELETE FROM purchase_items WHERE po_id IN (${inSql(poIds)})`).run(...poIds);
      db.prepare(`DELETE FROM purchase_orders WHERE id IN (${inSql(poIds)})`).run(...poIds);
    }
    if (mats.length) db.prepare(`DELETE FROM materials WHERE id IN (${inSql(mats)})`).run(...mats);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seedMaterials() {
  const t = ts(D(-30), 9);
  const ins = db.prepare(
    `INSERT INTO materials (type, code, name, spec, unit, status, created_at, stock_qty, updated_at)
     VALUES (?,?,?,?,?, 'active', ?, 0, ?)`
  );
  const ids = {};
  db.exec('BEGIN');
  try {
    MATS.forEach((m) => {
      const info = ins.run(m.type, m.code, m.name, m.spec, m.unit, t, t);
      ids[m.code] = Number(info.lastInsertRowid);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 采购价：写一张草稿采购单承载价格（lastPrice 从 purchase_items 取）
  const poNo = `MFPODEMO${Date.now().toString().slice(-6)}`;
  const t2 = ts(D(-32), 10);
  db.exec('BEGIN');
  try {
    const po = db.prepare(
      `INSERT INTO purchase_orders (po_no, supplier, status, order_date, expect_date, remark, total_amount, created_by, created_at, updated_at)
       VALUES (?,?, 'draft', ?,?, 'MF-DEMO 演示采购价（供盘点计价用）', 0, 1, ?, ?)`
    ).run(poNo, '演示供应商', D(-32), D(-25), t2, t2);
    // 数量写 0：这张单只是「价格存档」，不能带未交量/可退量，否则会被采购变更、采购退料等
    // 用例当成真单挑中（踩过：减量用例挑到它，报「草稿不用走变更」）
    const stmt = db.prepare(
      `INSERT INTO purchase_items (po_id, material_id, name, spec, unit, qty, received_qty, price, amount)
       VALUES (?,?,?,?,?,0,0,?,0)`
    );
    MATS.filter((m) => m.price !== null).forEach((m) => {
      stmt.run(po.lastInsertRowid, ids[m.code], m.name, m.spec, m.unit, m.price);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 期初库存：走 applyStock 写流水（账面与流水必须一致）
  db.exec('BEGIN');
  try {
    MATS.forEach((m) => {
      M.applyStock({
        materialId: ids[m.code], type: 'receipt', qty: m.stock, unit: m.unit,
        refType: 'seed', refNo: 'MF-DEMO-OPEN',
        remark: `期初库存（${m.code}）`, operator: 'demo'
      }, t);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[1] 原料 ${MATS.length} 种，期初库存与流水已对齐（其中 1 种故意没有采购价）`);
  return ids;
}

/** 给两张现成订单挂用料（remark 标记，便于清理） */
function seedOrderMaterials(ids) {
  const orders = db.prepare(
    "SELECT id, order_no FROM orders WHERE status IN ('assigned','production') AND order_no LIKE 'SCHDEMO%' ORDER BY id LIMIT 3"
  ).all();
  if (orders.length < 2) throw new Error('找不到两张 SCHDEMO 订单，请先跑 seed-schedule-demo.js');
  const t = ts(D(-6), 9);
  const rows = [
    // 订单 1：备料单 LL-1（只备不发）
    { order: orders[0], items: [
      { code: 'MF-DEMO-01', one: 1.35, loss: 8, qty: 600 },
      { code: 'MF-DEMO-04', one: 0.9, loss: 5, qty: 600 },
      { code: 'MF-DEMO-05', one: 1, loss: 2, qty: 600 },
      { code: 'MF-DEMO-07', one: 1, loss: 1, qty: 600 }
    ] },
    // 订单 2：备料单 LL-2（发了大部分，包边条欠发）
    { order: orders[2] || orders[1], items: [
      { code: 'MF-DEMO-04', one: 0.75, loss: 6, qty: 1200 }
    ] },
    { order: orders[1], items: [
      { code: 'MF-DEMO-02', one: 1.2, loss: 10, qty: 900 },
      { code: 'MF-DEMO-03', one: 0.85, loss: 6, qty: 900 },
      { code: 'MF-DEMO-06', one: 4, loss: 3, qty: 900 },
      { code: 'MF-DEMO-08', one: 0.05, loss: 5, qty: 900 }
    ] }
  ];
  const stmt = db.prepare(
    `INSERT INTO order_materials (order_id, material_id, type, name, unit, one_use, loss, total_use, price, amount, spec, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'MF-DEMO', ?)`
  );
  db.exec('BEGIN');
  try {
    rows.forEach((r) => {
      r.items.forEach((x) => {
        const m = MATS.find((y) => y.code === x.code);
        const total = Math.round(x.one * x.qty * (1 + x.loss / 100) * 100) / 100;
        const price = m.price === null ? 0 : m.price;
        stmt.run(r.order.id, ids[x.code], m.type, m.name, m.unit, x.one, x.loss, total,
          price, Math.round(total * price * 100) / 100, m.spec, t);
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[2] 订单用料挂到 ${orders.map((o) => o.order_no).join(' / ')}`);
  return orders;
}

function seedDocs(ids, orders) {
  const op = 'demo';

  // ---- ① 已备料未发料（占用）----
  const sug1 = M.suggestFromOrder(orders[0].id);
  const ll1 = M.createIssue({
    order_id: orders[0].id, kind: 'order', req_date: D(2),
    note: '大货备料（未发料，占用中）', demo_tag: TAG,
    items: sug1.items.map((x) => ({ material_id: x.material_id, name: x.name, spec: x.spec, unit: x.unit, req_qty: x.req_qty }))
  }, op);
  M.prepareIssue(ll1.id, op);

  // ---- ② 已发料但欠发 ----
  const sug2 = M.suggestFromOrder(orders[1].id);
  const ll2 = M.createIssue({
    order_id: orders[1].id, kind: 'order', req_date: D(0),
    note: '大货领料（包边条客户供料未到齐，先发其余）', demo_tag: TAG,
    items: sug2.items.map((x) => ({ material_id: x.material_id, name: x.name, spec: x.spec, unit: x.unit, req_qty: x.req_qty }))
  }, op);
  M.prepareIssue(ll2.id, op);
  const d2 = M.issueDetail(ll2.id);
  // 包边条只发一半 → 转 partial，欠发挂账
  const partialItems = d2.items.map((it) => ({
    id: it.id,
    issued_qty: it.name.includes('包边条') ? Math.floor(it.req_qty / 2) : it.req_qty
  }));
  M.issueOut(ll2.id, { items: partialItems }, op);

  // ---- ③ 余料退回（部分退回，已入库）----
  const back = M.issueDetail(ll2.id);
  const retItem = back.items.find((x) => x.name.includes('精梳棉双面'));
  const tl = M.createReturn({
    issue_id: ll2.id, type: 'leftover',
    reason: '裁床排版优化，余料 36 米退回仓库（缸号一致，可直接给下一单用）',
    items: [{ issue_item_id: retItem.id, qty: 36 }],
    demo_tag: TAG
  }, op);
  M.confirmReturn(tl.id, op);

  console.log(`[3] 领料单：${ll1.issue_no}（已备料占用）/ ${ll2.issue_no}（部分发出，欠发看得见）`);
  console.log(`[4] 退料单：${tl.return_no} 已入库 36 米`);

  // ---- 补料草稿（车间临时补料，必须写原因）----
  const extra = M.createIssue({
    order_id: orders[1].id, kind: 'extra', req_date: D(1),
    note: '首批裁片有 12 件污损需重裁，补领面料应急',
    demo_tag: TAG,
    items: [{ material_id: ids['MF-DEMO-02'], name: MATS.find((m) => m.code === 'MF-DEMO-02').name, unit: '米', req_qty: 18 }]
  }, op);
  console.log(`[4b] 补料单：${extra.issue_no}（草稿，待备料）`);

  return { ll1, ll2, tl, extra };
}

function seedStocktakes(ids) {
  const op = 'demo';
  // 清场：残留的未完成盘点单会让 createStocktake 直接报错（约束本身是对的，重放要先收尾）
  const leftovers = db.prepare("SELECT id, take_no FROM stocktakes WHERE status IN ('draft','counting','submitted')").all();
  leftovers.forEach((t) => {
    db.prepare("UPDATE stocktakes SET status='cancelled', note = COALESCE(note,'')||?, updated_at=? WHERE id=?")
      .run(` [重放清理] 取消残留盘点 ${t.take_no}`, ts(D(0), 8), t.id);
  });
  if (leftovers.length) console.log(`    （清场：取消残留盘点 ${leftovers.length} 张）`);
  const matIds = Object.values(ids);

  // ---- ④ 已调账的盘点：盘亏 + 盘盈 + 1 条未计价 ----
  const pd1 = M.createStocktake({ take_date: D(-3), material_ids: matIds, counter: '李仓管', note: '月度原料盘点（演示）', demo_tag: TAG }, op);
  M.startCount(pd1.id, op);
  const detail = M.stocktakeDetail(pd1.id);
  const plan = detail.items.map((it) => {
    let count = it.book_qty;
    let reason = null;
    if (it.name.includes('涤纶四面弹')) { count = it.book_qty - 18; reason = '裁床边角料未登记，实际损耗超定额'; }
    if (it.name.includes('树脂纽扣')) { count = it.book_qty + 200; reason = '上次到货拆箱余数未入账，本次盘盈'; }
    if (it.name.includes('包边条')) { count = it.book_qty - 5; reason = '车间零领未开单，实物少了 5 米'; }
    return { id: it.id, count_qty: count, reason };
  });
  M.saveCount(pd1.id, { items: plan });
  M.submitStocktake(pd1.id, { items: plan }, op);
  M.adjustStocktake(pd1.id, op);
  const done1 = M.stocktakeDetail(pd1.id);

  // ---- ⑤ 未开始的盘点单（草稿，不冻结）----
  const pd2 = M.createStocktake({ take_date: D(1), material_ids: matIds, counter: '李仓管', note: '月末复盘（演示：还没开始盘）', demo_tag: TAG }, op);

  console.log(`[5] 盘点单：${done1.take_no} 已调账（差异 ${done1.diff_count} 条、未计价 ${done1.uncosted_count} 条）；${pd2.take_no} 草稿未盘`);
  return { pd1: done1, pd2 };
}

(function main() {
  if (reset) { clean(); console.log('[0] 已清理旧演示数据'); }
  else {
    const exists = db.prepare("SELECT COUNT(*) c FROM materials WHERE code LIKE 'MF-DEMO-%'").get().c;
    if (exists) {
      console.log('演示数据已存在；要重放请加 --reset');
      return;
    }
  }
  const ids = seedMaterials();
  const orders = seedOrderMaterials(ids);
  const docs = seedDocs(ids, orders);
  seedStocktakes(ids);

  const stock = M.stockList({});
  const demoRows = stock.filter((r) => Object.values(ids).includes(r.id));
  console.log('\n--- 演示原料台账 ---');
  demoRows.forEach((r) => {
    console.log(
      `  ${r.name.padEnd(18)} 账面 ${String(r.stock_qty).padStart(8)}  占用 ${String(r.reserved).padStart(7)}  可用 ${String(r.available).padStart(8)} ${r.unit}` +
      `${r.price === null ? '  (无采购价)' : ''}`
    );
  });
  const b = M.board({});
  console.log(`\n本期：备料单 ${b.stat.draft} 草稿 / ${b.stat.prepared} 已备料 / ${b.stat.partial} 部分发出 / ${b.stat.issued} 已发料；欠发 ${b.open_short_count} 张`);
  console.log('演示数据就绪。');
})();
