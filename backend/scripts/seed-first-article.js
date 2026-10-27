/**
 * 首件确认演示数据（P0-6 / 原型 TS-N08-03）
 *   node scripts/seed-first-article.js
 *
 * 做的事：
 *   1) 给订单 5 的已确认技术版（TP#9）补成衣尺寸表 + 缝制工艺要求（原本是空的技术版，首件无尺寸可测）
 *   2) 按 13 道工序生成工位工艺卡（含关键工序标记）
 *   3) 建一张首件单 FA-xxx，按 S 码生成检查项并填好实测，状态停在「待复核」
 *
 * 停在「待复核」是故意的：让用户在界面上亲手点「复核放行」，才能看到
 * 缝制工序报工从「被拦截」变成「可报工」。
 * 幂等：已有首件单就不再建。
 */
const { db, now } = require('../src/db');

const ORDER_ID = 5;
const GRADE = 'admin';

const SIZES = [
  { part: '衣长', S: '58', M: '60', tol: '±1.0' },
  { part: '胸围', S: '96', M: '100', tol: '±1.5' },
  { part: '肩宽', S: '38', M: '39.5', tol: '±0.8' },
  { part: '袖长', S: '57', M: '58', tol: '±1.0' }
];
const MEASURED = {
  衣长: { S: '58.3' },
  胸围: { S: '96.6' },
  肩宽: { S: '38.2' },
  袖长: { S: '56.8' }
};

const CRAFTS = [
  '领口罗纹 2×2，拉伸回复率不低于 90%',
  '门襟 5 粒树脂四眼扣，扣距 9cm，锁眼平整无毛边',
  '下摆双层收口，车线密度 12 针/3cm，不得跳针'
];

const WS_DEFAULT = {
  备料: 'W-01 备料区',
  排版算料: 'W-02 排版房',
  裁剪: 'W-03 裁床',
  车缝: 'W-04 车缝一组',
  锁眼钉扣: 'W-05 锁眼钉扣位',
  整烫: 'W-06 整烫台',
  水洗: 'W-07 水洗间',
  印花: 'W-08 印花位',
  绣花: 'W-09 绣花位',
  检验: 'W-10 检验台',
  包装: 'W-11 包装位',
  成品入库: 'W-12 成品仓',
  出库发运: 'W-13 发运区'
};
const CRITICAL = ['车缝', '锁眼钉扣', '印花', '绣花', '水洗', '整烫'];

const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ORDER_ID);
if (!order) {
  console.log(`订单 ${ORDER_ID} 不存在，跳过`);
  process.exit(0);
}
const tp = db.prepare("SELECT * FROM tech_packs WHERE order_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1").get(ORDER_ID);
if (!tp) {
  console.log(`订单 ${ORDER_ID} 没有已确认的技术版，跳过`);
  process.exit(0);
}
console.log(`订单 ${order.order_no} / 冻结版 ${tp.version}（TP#${tp.id}）`);

const t = now();

/* 1) 尺寸表 */
const hasSize = db.prepare('SELECT COUNT(*) AS c FROM tech_pack_sizes WHERE tech_pack_id = ?').get(tp.id).c;
if (!hasSize) {
  const ins = db.prepare('INSERT INTO tech_pack_sizes (tech_pack_id, part, size, value, tolerance, sort, created_at) VALUES (?,?,?,?,?,?,?)');
  let sort = 0;
  SIZES.forEach((s) => {
    ['S', 'M'].forEach((size) => {
      ins.run(tp.id, s.part, size, s[size], s.tol, sort++, t);
    });
  });
  console.log(`  补尺寸表 ${sort} 行`);
} else {
  console.log(`  尺寸表已有 ${hasSize} 行，跳过`);
}

/* 2) 缝制工艺要求 */
const hasCraft = db.prepare("SELECT COUNT(*) AS c FROM tech_pack_requirements WHERE tech_pack_id = ? AND category = 'craft'").get(tp.id).c;
if (!hasCraft) {
  const ins = db.prepare('INSERT INTO tech_pack_requirements (tech_pack_id, category, content, sort, created_at) VALUES (?, ?, ?, ?, ?)');
  CRAFTS.forEach((c, i) => ins.run(tp.id, 'craft', c, i, t));
  console.log(`  补缝制工艺要求 ${CRAFTS.length} 条`);
} else {
  console.log(`  工艺要求已有 ${hasCraft} 条，跳过`);
}

/* 3) 工位工艺卡 */
const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(ORDER_ID);
const hasWs = db.prepare('SELECT COUNT(*) AS c FROM workstation_crafts WHERE order_id = ?').get(ORDER_ID).c;
if (!hasWs && nodes.length) {
  const ins = db.prepare(
    `INSERT INTO workstation_crafts (order_id, node_id, node_name, seq, workstation, craft_name, requirement,
      machine, key_point, std_time, critical, operator, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)`
  );
  let seq = 0;
  nodes.forEach((n) => {
    seq++;
    const reqs = [];
    if (n.name === '车缝') reqs.push(...CRAFTS);
    const keyPoint = n.name === '车缝'
      ? '开筒顺直、缝份均匀、无跳针断线；首件必须核车线密度与针距'
      : n.name === '锁眼钉扣'
        ? '扣位与门襟对位、扣距一致、锁眼无毛边'
        : n.name === '裁剪'
          ? '同床缸号一致、裁片对条对格、扎号与扎包一致'
          : null;
    ins.run(
      ORDER_ID, n.id, n.name, seq, WS_DEFAULT[n.name] || `W-${String(seq).padStart(2, '0')}`,
      n.name, reqs.length ? reqs.join('；') : null,
      n.name === '车缝' ? '平车 / 包缝机 / 绷缝机' : n.name === '锁眼钉扣' ? '锁眼机 / 钉扣机' : null,
      keyPoint, n.name === '车缝' ? 12 : n.name === '锁眼钉扣' ? 4 : 0,
      CRITICAL.includes(n.name) ? 1 : 0, null, t, t
    );
  });
  console.log(`  生成工位工艺 ${seq} 道（关键 ${CRITICAL.length} 道）`);
} else {
  console.log(`  工位工艺已有 ${hasWs} 道，跳过`);
}

/* 4) 首件单 */
const exist = db.prepare('SELECT * FROM first_articles WHERE order_id = ?').get(ORDER_ID);
if (exist) {
  console.log(`  首件单已存在：${exist.fa_no}（${exist.status}），跳过`);
  process.exit(0);
}

const ymd = t.slice(0, 10).replace(/-/g, '');
const seq = Number(db.prepare("SELECT COUNT(*) AS c FROM first_articles WHERE fa_no LIKE ?").get(`FA${ymd}%`).c) + 1;
const faNo = `FA${ymd}${String(seq).padStart(4, '0')}`;
const batch = db.prepare(
  'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
).get(ORDER_ID).q;
const cut = db.prepare('SELECT * FROM cut_orders WHERE order_id = ?').get(ORDER_ID);
const bundle = db.prepare('SELECT * FROM cut_bundles WHERE cut_order_id = ? ORDER BY id LIMIT 1').get(cut ? cut.id : 0);

const faId = Number(db.prepare(
  `INSERT INTO first_articles (fa_no, order_id, order_no, style_no, cut_order_id, tech_pack_id, tech_pack_version,
    fa_type, batch_qty, sample_bundle_no, sample_size, scope, status, conclusion, release_qty,
    inspector, inspected_at, remark, created_by, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?, 'full', ?,?,?,?, 'submitted', NULL, 0, ?, ?, ?, ?, ?, ?)`
).run(
  faNo, ORDER_ID, order.order_no, order.style_name, cut ? cut.id : null, tp.id, tp.version,
  Number(batch) || 600, bundle ? bundle.bundle_no : null, 'S',
  '领口 / 成衣尺寸 / 缝线 / 扣位 / 外观标识',
  GRADE, t,
  '大货前按冻结版做首件，S 码取 B001 扎裁片；尺寸与关键工艺实测合格，提请质量复核',
  GRADE, t, t
).lastInsertRowid);

/* 检查项 */
let cs = 0;
const insCk = db.prepare(
  `INSERT INTO first_article_checks (fa_id, seq, kind, workstation, part, spec, tolerance, measured, result, critical, remark, checked_by, checked_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const sizeRows = db.prepare("SELECT * FROM tech_pack_sizes WHERE tech_pack_id = ? AND size = 'S' ORDER BY sort, id").all(tp.id);
sizeRows.forEach((s) => {
  const m = (MEASURED[s.part] && MEASURED[s.part].S) || s.value;
  insCk.run(faId, ++cs, 'size', null, s.part, s.value, s.tolerance || null, m, 'ok', 1, null, GRADE, t);
});
const wsRows = db.prepare('SELECT * FROM workstation_crafts WHERE order_id = ? AND critical = 1 ORDER BY seq, id').all(ORDER_ID);
wsRows.forEach((w) => {
  insCk.run(faId, ++cs, 'craft', w.workstation, w.craft_name, w.requirement || w.key_point || '按工艺要求执行',
    null, '符合要求', 'ok', 1, null, GRADE, t);
});
insCk.run(faId, ++cs, 'look', null, '外观与标识', '无色差、无线头、洗水标/烫画标内容与客户指定一致',
  null, '无色差，线头处理干净', 'ok', 0, null, GRADE, t);

console.log(`  建首件单 ${faNo}：本批 ${batch} 件，检查项 ${cs} 项（尺寸 ${sizeRows.length} / 工艺 ${wsRows.length} / 外观 1），状态=待复核`);
console.log('\n完成。打开「生产 → 首件确认」审核放行。');
