/**
 * 样衣归档服务：打版流程完成后，把开发单的当前内容快照成一条样衣档案并锁定。
 * 快照的好处：日后开发单/面辅料档案怎么改，历史样衣记录都不变，可追溯当时确认的是什么。
 */
const { db, now } = require('../db');

function genArchiveNo() {
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const prefix = 'YA' + ymd;
  const row = db.prepare("SELECT archive_no FROM sample_archives WHERE archive_no LIKE ? ORDER BY id DESC LIMIT 1").get(prefix + '%');
  let seq = 1;
  if (row) seq = Number(String(row.archive_no).slice(prefix.length)) + 1;
  return prefix + String(seq).padStart(3, '0');
}

/** 组装快照：面辅料 / 成衣尺寸 / 生产要求 / 客户要求 */
function buildSnapshot(techPackId) {
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(techPackId);
  if (!tp) return null;
  const materials = db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id').all(techPackId);
  const sizes = db.prepare('SELECT * FROM tech_pack_sizes WHERE tech_pack_id = ? ORDER BY sort, id').all(techPackId);
  const requirements = db.prepare('SELECT * FROM tech_pack_requirements WHERE tech_pack_id = ? ORDER BY sort, id').all(techPackId);
  const order = db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(tp.order_id);

  return {
    product_name: tp.product_name,
    version: tp.version,
    customer_style_no: tp.customer_style_no,
    colors: tp.colors,
    size_range: tp.size_range,
    designer: tp.designer,
    pattern_maker: tp.pattern_maker,
    craft_info: tp.craft_info,
    customer_req: tp.customer_req,
    size_spec: tp.size_spec,
    materials,
    sizes,
    requirements,
    order: order ? { order_no: order.order_no, customer_name: order.customer_name, delivery_date: order.delivery_date } : null
  };
}

/** 版本号递增：V1 → V2 */
function bumpVersion(v) {
  const m = /V(\d+)/i.exec(v || '');
  return m ? 'V' + (Number(m[1]) + 1) : 'V2';
}

/**
 * 从打版流程归档样衣
 * @param {object} flow pattern_flows 行
 * @param {string} operator 操作人
 * @param {object} [opt] { version, remark, sourceArchiveId } 变更通过时用
 */
function archiveFromFlow(flow, operator, opt = {}) {
  const snap = buildSnapshot(flow.tech_pack_id);
  if (!snap) return null;

  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(flow.tech_pack_id);
  // 同一开发单第二次归档（走完变更后重打版）自动升版本号
  const last = db.prepare('SELECT version FROM sample_archives WHERE tech_pack_id = ? ORDER BY id DESC LIMIT 1').get(flow.tech_pack_id);
  const version = opt.version || (last ? bumpVersion(last.version) : (snap.version || 'V1'));
  const auditStage = db.prepare("SELECT * FROM pattern_stages WHERE flow_id = ? AND stage = 'audit'").get(flow.id);
  const t = now();

  const info = db.prepare(
    `INSERT INTO sample_archives
     (archive_no, tech_pack_id, order_id, style_no, sample_name, version, pattern_size, customer,
      snapshot, image_url, status, locked_at, created_by, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'locked',?,?,?,?)`
  ).run(
    genArchiveNo(),
    flow.tech_pack_id,
    flow.order_id,
    tp ? (tp.customer_style_no || tp.product_name) : null,
    snap.product_name,
    version,
    (auditStage && auditStage.pattern_size) || snap.size_range || null,
    snap.order ? snap.order.customer_name : null,
    JSON.stringify(snap),
    tp ? tp.image_url : null,
    t,
    operator,
    opt.remark || null,
    t
  );
  return db.prepare('SELECT * FROM sample_archives WHERE id = ?').get(Number(info.lastInsertRowid));
}

module.exports = { archiveFromFlow, buildSnapshot, genArchiveNo };
