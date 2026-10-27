/**
 * 退货与库龄 / 现货动销 · 演示数据
 *   node scripts/seed-spot-demo.js           幂等补充
 *   node scripts/seed-spot-demo.js --reset   先清干净
 *
 * 造的是「一个卖了一年还没卖完的现货盘」：
 *   4 个款分四档库龄（170 天 / 87 天 / 37 天 / 7 天），
 *   每款都有历史出库，能算动销率与周转天数；
 *   退货单三张：待点收 / 待判定 / 已关单（良品回架 + 次品 + 报废）
 */
const { db } = require('../src/db');
const { applyStock, addLedger, round2 } = require('../src/services/stockOps');

const TAG = 'SPOT-DEMO';
const today = () => new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
};
const at = (date, hh = '10:00:00') => `${date} ${hh}`;

const STYLES = [
  { style: 'SPOT-A', name: '基础圆领 T 恤', color: '白色', size: 'M', in: 200, out: 120, inDate: daysAgo(170), outDate: daysAgo(140), in2: 0 },
  { style: 'SPOT-B', name: '加厚抓绒卫衣', color: '浅灰', size: 'L', in: 300, out: 100, inDate: daysAgo(87), outDate: daysAgo(40), in2: 0 },
  { style: 'SPOT-C', name: '休闲直筒短裤', color: '藏青', size: 'M', in: 400, out: 150, inDate: daysAgo(37), outDate: daysAgo(12), in2: 0 },
  { style: 'SPOT-D', name: '春季薄款外套', color: '黑色', size: 'L', in: 150, out: 0, inDate: daysAgo(7), outDate: null, in2: 0 }
];

function reset() {
  // 顺序很重要：先拿到退货单 id，把「退货良品入库」的流水一起清掉，
  // 否则流水留着、库存行删了 → stock_items 与 ledger 净额对不上（BAL-STOCK 会报）。
  const rtIds = db.prepare('SELECT id FROM stock_returns WHERE remark LIKE ?').all(`%${TAG}%`).map((x) => x.id);
  if (rtIds.length) {
    db.prepare(
      `DELETE FROM stock_ledger WHERE ref_type='stock_return' AND ref_id IN (${rtIds.map(() => '?').join(',')})`
    ).run(...rtIds);
  }
  db.prepare("DELETE FROM stock_ledger WHERE remark LIKE ?").run(`%${TAG}%`);

  STYLES.forEach((s) => {
    db.prepare('DELETE FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?')
      .run('us', s.style, s.color, s.size);
    // 防御：万一还有本款残留流水，也一起清（避免账实不符）
    db.prepare('DELETE FROM stock_ledger WHERE warehouse=? AND style_no=?').run('us', s.style);
  });

  db.prepare("DELETE FROM stock_return_items WHERE return_id IN (SELECT id FROM stock_returns WHERE remark LIKE ?)").run(`%${TAG}%`);
  db.prepare("DELETE FROM stock_returns WHERE remark LIKE ?").run(`%${TAG}%`);
}

function seed() {
  const out = [];

  // ---------- 1. 历史批次流水（直接写流水 + 库存，日期落在过去） ----------
  STYLES.forEach((s) => {
    const exist = db.prepare('SELECT id FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?')
      .get('us', s.style, s.color, s.size);
    if (exist) return;   // 幂等

    applyStock({
      warehouse: 'us', style_no: s.style, product_name: s.name,
      color: s.color, size: s.size, delta: s.in
    });
    addLedger({
      warehouse: 'us', style_no: s.style, product_name: s.name,
      color: s.color, size: s.size, type: 'in', qty: s.in,
      ref_type: 'manual', ref_id: null,
      remark: `首批备货入库（${TAG}）`, operator: 'seed'
    });
    // 把入库流水的日期改到过去，制造库龄
    db.prepare(
      `UPDATE stock_ledger SET created_at=? WHERE id=(
         SELECT MAX(id) FROM stock_ledger WHERE warehouse=? AND style_no=? AND color=? AND size=? AND remark LIKE ?)`
    ).run(at(s.inDate), 'us', s.style, s.color, s.size, `%${TAG}%`);

    if (s.out > 0) {
      applyStock({
        warehouse: 'us', style_no: s.style, product_name: s.name,
        color: s.color, size: s.size, delta: -s.out
      });
      addLedger({
        warehouse: 'us', style_no: s.style, product_name: s.name,
        color: s.color, size: s.size, type: 'out', qty: -s.out,
        ref_type: 'retail', ref_id: null,
        remark: `零售出库（${TAG}）`, operator: 'seed'
      });
      db.prepare(
        `UPDATE stock_ledger SET created_at=? WHERE id=(
           SELECT MAX(id) FROM stock_ledger WHERE warehouse=? AND style_no=? AND color=? AND size=? AND qty<0 AND remark LIKE ?)`
      ).run(at(s.outDate), 'us', s.style, s.color, s.size, `%${TAG}%`);
    }
  });
  out.push(`4 个款的历史批次：${STYLES.map((s) => `${s.style} 入${s.in}/出${s.out}（${s.inDate}）`).join('，')}`);

  // ---------- 2. 退货单 ----------
  const loc = db.prepare("SELECT * FROM wh_locations WHERE warehouse='us' AND zone='sellable' ORDER BY code LIMIT 1").get();
  const locCode = loc ? loc.code : null;
  const t = new Date().toISOString();

  const mkReturn = (no, o) => {
    const r = db.prepare(
      `INSERT INTO stock_returns (return_no,type,warehouse,order_id,order_no,partner_name,source_no,reason,status,
         qty_apply,qty_received,qty_good,qty_defect,qty_scrap,return_date,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, o.type || 'customer', 'us', null, null, o.partner, o.source, o.reason, o.status,
      o.apply, o.recv || 0, o.good || 0, o.defect || 0, o.scrap || 0, o.date, `${TAG} ${o.remark || ''}`,
      'seed', t, t).lastInsertRowid;
    (o.items || []).forEach((it) => {
      db.prepare(
        `INSERT INTO stock_return_items (return_id,style_no,product_name,color,size,qty_apply,qty_received,qty_good,qty_defect,qty_scrap,location_code,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(r, it.style, it.name, it.color, it.size, it.apply, it.recv || 0, it.good || 0,
        it.defect || 0, it.scrap || 0, it.location || null, it.note || null);
    });
    return r;
  };

  if (db.prepare("SELECT id FROM stock_returns WHERE return_no='RT-DEMO-001'").get()) {
    out.push('退货单已存在，跳过');
  } else {
    // ① 待点收：客户退 60 件
    mkReturn('RT-DEMO-001', {
      partner: '洛杉矶批发商 Westline', source: 'MATU8812034', reason: '客户反馈尺码偏小，整批退回',
      status: 'draft', apply: 60, date: daysAgo(2),
      items: [
        { style: 'SPOT-A', name: '基础圆领 T 恤', color: '白色', size: 'M', apply: 60 }
      ]
    });

    // ② 待判定：已点收 40 件，还没判
    mkReturn('RT-DEMO-002', {
      partner: '纽约零售店 NY Style', source: 'TRK-DEMO-1002', reason: '顾客不满意，门店退回',
      status: 'received', apply: 45, recv: 40, date: daysAgo(5),
      items: [
        { style: 'SPOT-B', name: '加厚抓绒卫衣', color: '浅灰', size: 'L', apply: 30, recv: 26 },
        { style: 'SPOT-C', name: '休闲直筒短裤', color: '藏青', size: 'M', apply: 15, recv: 14 }
      ]
    });

    // ③ 已关单：良品 30 回架 + 次品 5 + 报废 3
    const r3 = mkReturn('RT-DEMO-003', {
      partner: '洛杉矶批发商 Westline', source: 'MATU7701234', reason: '部分货品吊牌破损、有污渍',
      status: 'inspected', apply: 40, recv: 38, good: 30, defect: 5, scrap: 3, date: daysAgo(12),
      items: [
        {
          style: 'SPOT-C', name: '休闲直筒短裤', color: '藏青', size: 'M',
          apply: 40, recv: 38, good: 30, defect: 5, scrap: 3,
          location: locCode, note: '判定：次品 5 / 报废 3（不进可售）'
        }
      ]
    });

    // 良品回架：库存 +30 并写流水（日期落在 12 天前）
    if (locCode) {
      applyStock({
        warehouse: 'us', style_no: 'SPOT-C', product_name: '休闲直筒短裤',
        color: '藏青', size: 'M', delta: 30
      });
      addLedger({
        warehouse: 'us', style_no: 'SPOT-C', product_name: '休闲直筒短裤',
        color: '藏青', size: 'M', type: 'in', qty: 30,
        ref_type: 'stock_return', ref_id: r3,
        remark: `退货良品入库 RT-DEMO-003 · ${locCode}`, operator: 'seed'
      });
      db.prepare(
        "UPDATE stock_ledger SET created_at=? WHERE ref_type='stock_return' AND ref_id=? AND remark LIKE ?"
      ).run(at(daysAgo(12)), r3, `%${TAG}%`);
    }
    db.prepare("UPDATE stock_returns SET status='closed' WHERE return_no='RT-DEMO-003'").run();

    out.push('退货单 3 张：RT-001 待点收 60 件 / RT-002 待判定（已收 40）/ RT-003 已关单（良品 30 回架、次品 5、报废 3）');
  }

  console.log('[spot-demo] 已生成演示数据：');
  out.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`\n今天 ${today()}；库龄按流水先进先出反算，想看「90 天以上」看 SPOT-A。`);
}

const argv = process.argv.slice(2);
if (argv.includes('--reset')) reset();
seed();
