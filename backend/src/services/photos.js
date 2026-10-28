/**
 * 现场照片留证
 * ============================================================
 * 为什么要有这个模块：
 *   车间与仓库的问题都是「当场看得见、事后说不清」。不良品、到货破损、装箱差错，
 *   电话里描述三遍不如一张照片。系统里原本只有「附件」——要点开订单详情、
 *   找上传按钮、选文件，手机上根本走不通。结果是没人拍。
 *
 * 这个模块要解决三件事：
 *   1. 手机上能拍（相机直接调起，不经过文件管理器）
 *   2. 拍完自动挂到订单与工序上（不用选目录、不用起文件名）
 *   3. 事后查得到（按订单 / 分类 / 日期 / 工序筛）
 *
 * 三条硬规则（都是「不这么做就会退化成垃圾堆」的地方）：
 *   a. **不良照片必须写说明**（≥2 字）。一堆没有说明的不良照片，三个月后没人看得懂。
 *   b. **删除是软删除**。照片是证据，物理删掉之后「当时到底什么样」就永远说不清了。
 *   c. **看不到的单不能挂照片**。挂之前校验订单存在，避免出现孤儿附件（历史上有过）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, now } = require('../db');
const { stripDemo } = require('../utils/demo');

const UPLOAD_ROOT = path.resolve(__dirname, '../../data/uploads');
const PHOTO_DIR = path.join(UPLOAD_ROOT, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

/** 分类口径：写在服务端，前后端共用一份，避免中文自由输入导致筛选失效 */
const CATS = [
  { code: 'defect', label: '不良', hint: '做坏了、有瑕疵、需要返工' },
  { code: 'incoming', label: '到货', hint: '来料破损、数量不符、包装异常' },
  { code: 'packing', label: '装箱', hint: '装箱现场、混装、箱唛' },
  { code: 'sample', label: '样品', hint: '样衣细节、客户确认的实物' },
  { code: 'other', label: '其他', hint: '现场情况留证' }
];
const CAT_CODES = CATS.map((c) => c.code);

/** 校验类错误带 400：错误中间件按 err.status 出状态码，用户看到的是「你填错了」而不是「服务器崩了」 */
function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const MAX_BYTES = 4 * 1024 * 1024; // 4MB（前端已压到 ~300KB，这里是兜底）
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp'
};

function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 按月分目录：单目录堆几万个文件，远程备份和 ls 都会很难受 */
function monthDir() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dir = path.join(PHOTO_DIR, `${d.getFullYear()}-${p(d.getMonth() + 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 保存一张照片并挂到订单上
 * @param {object} p
 * @param {number} p.order_id
 * @param {string} p.dataUrl  data:image/jpeg;base64,...
 * @param {string} [p.cat]
 * @param {string} [p.note]
 * @param {number} [p.node_id]
 * @param {string} [p.taken_at] 手机拍摄时间（可空）
 * @param {string} p.uploader
 */
function save({ order_id, dataUrl, cat, note, node_id, taken_at, uploader }) {
  const orderId = Number(order_id);
  if (!orderId) throw bad('缺少订单');

  const order = db.prepare('SELECT id, order_no, style_name FROM orders WHERE id = ?').get(orderId);
  // 规则 c：订单不存在就不许挂，避免孤儿附件
  if (!order) throw bad('订单不存在（可能已被删除），照片未保存');

  const code = String(cat || 'other').trim();
  if (!CAT_CODES.includes(code)) throw bad('照片分类不正确：' + code);

  const text = String(note || '').trim();
  // 规则 a：不良照片必须写清楚是什么问题
  if (code === 'defect' && text.length < 2) {
    throw bad('不良照片必须写一句说明（比如「左袖口跳线」），否则事后没人看得懂');
  }

  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw bad('照片格式不正确（只接收图片）');
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw bad('只支持 jpg / png / webp');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw bad('照片内容为空');
  if (buf.length > MAX_BYTES) {
    throw bad(`照片压缩后仍有 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 4MB，请重拍或调低画质`);
  }

  const nodeId = node_id ? Number(node_id) : null;
  let nodeName = null;
  if (nodeId) {
    const n = db.prepare('SELECT name FROM order_nodes WHERE id = ? AND order_id = ?').get(nodeId, orderId);
    // 工序必须属于这张单，否则照片会挂到别的单的工序上
    if (!n) throw bad('工序不属于该订单，照片未保存');
    nodeName = n.name;
  }

  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  const file = path.join(monthDir(), name);
  fs.writeFileSync(file, buf);

  // 对外的 URL 要带 photos 前缀，静态目录挂在 /uploads
  const url = '/uploads/photos/' + path.basename(path.dirname(file)) + '/' + name;

  const label = [order.order_no, CATS.find((c) => c.code === code).label, nodeName, text]
    .filter(Boolean)
    .join(' · ');

  try {
    const info = db
      .prepare(
        `INSERT INTO attachments (target_type, target_id, filename, url, size, mime, uploader, created_at, cat, note, node_id, taken_at)
         VALUES ('order', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(orderId, label, url, buf.length, mime, uploader, now(), code, text || null, nodeId, taken_at || null);
    return getById(Number(info.lastInsertRowid));
  } catch (e) {
    // 记录写不进去就把文件删掉，别留一堆没人认领的图
    try { fs.unlinkSync(file); } catch (e2) { /* ignore */ }
    throw new Error('照片记录写入失败：' + e.message);
  }
}

function getById(id) {
  const row = db
    .prepare(
      `SELECT a.*, o.order_no, o.style_name, n.name AS node_name
         FROM attachments a
         LEFT JOIN orders o ON o.id = a.target_id AND a.target_type = 'order'
         LEFT JOIN order_nodes n ON n.id = a.node_id
        WHERE a.id = ?`
    )
    .get(id);
  return row || null;
}

/**
 * 照片墙列表
 * @param {object} q { order_id, cat, node_id, from, to, keyword, limit, offset }
 */
function list(q = {}) {
  const where = ["a.target_type = 'order'", 'a.deleted_at IS NULL'];
  const args = [];

  if (q.order_id) { where.push('a.target_id = ?'); args.push(Number(q.order_id)); }
  if (q.cat) { where.push('a.cat = ?'); args.push(String(q.cat)); }
  if (q.node_id) { where.push('a.node_id = ?'); args.push(Number(q.node_id)); }
  // 日期按「拍摄时间优先，没拍时间用上传时间」
  if (q.from) { where.push("IFNULL(a.taken_at, a.created_at) >= ?"); args.push(String(q.from)); }
  if (q.to) { where.push("IFNULL(a.taken_at, a.created_at) <= ?"); args.push(String(q.to) + ' 23:59:59'); }
  if (q.keyword) {
    where.push('(o.order_no LIKE ? OR o.style_name LIKE ? OR a.note LIKE ?)');
    const k = '%' + String(q.keyword).trim() + '%';
    args.push(k, k, k);
  }

  const limit = Math.min(Number(q.limit) || 60, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const rows = db
    .prepare(
      `SELECT a.*, o.order_no, o.style_name, o.status AS order_status, n.name AS node_name
         FROM attachments a
         LEFT JOIN orders o ON o.id = a.target_id AND a.target_type = 'order'
         LEFT JOIN order_nodes n ON n.id = a.node_id
        WHERE ${where.join(' AND ')}
        ORDER BY IFNULL(a.taken_at, a.created_at) DESC, a.id DESC
        LIMIT ${limit} OFFSET ${offset}`
    )
    .all(...args);

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM attachments a
         LEFT JOIN orders o ON o.id = a.target_id AND a.target_type = 'order'
        WHERE ${where.join(' AND ')}`
    )
    .get(...args).c;

  return { rows: rows.map(decorate), total, limit, offset, has_more: offset + rows.length < total };
}

function decorate(r) {
  const cat = CATS.find((c) => c.code === r.cat) || CATS[CATS.length - 1];
  return {
    ...r,
    // 演示数据用「演示·」前缀标记以便重复灌数据时清理，这层标记不该出现在页面上
    note: stripDemo(r.note),
    cat_label: cat.label,
    size_kb: Math.round((Number(r.size) || 0) / 1024),
    shot_at: r.taken_at || r.created_at
  };
}

/** 汇总：给照片墙顶部指标卡用 */
function stats(q = {}) {
  const base = ["target_type = 'order'", 'deleted_at IS NULL'];
  const args = [];
  if (q.from) { base.push('IFNULL(taken_at, created_at) >= ?'); args.push(String(q.from)); }
  if (q.to) { base.push('IFNULL(taken_at, created_at) <= ?'); args.push(String(q.to) + ' 23:59:59'); }
  if (q.order_id) { base.push('target_id = ?'); args.push(Number(q.order_id)); }
  const W = base.join(' AND ');

  const byCat = db
    .prepare(`SELECT cat, COUNT(*) AS n FROM attachments WHERE ${W} GROUP BY cat`)
    .all(...args);
  const catMap = {};
  byCat.forEach((r) => { catMap[r.cat] = r.n; });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE ${W}`).get(...args).n;
  const orders = db.prepare(`SELECT COUNT(DISTINCT target_id) AS n FROM attachments WHERE ${W}`).get(...args).n;
  const bytes = db.prepare(`SELECT IFNULL(SUM(size), 0) AS n FROM attachments WHERE ${W}`).get(...args).n;

  // 近 14 天每天多少张，给一个小趋势
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const p = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE ${W} AND substr(IFNULL(taken_at, created_at), 1, 10) = ?`)
      .get(...args, key).n;
    days.push({ date: key, count: n });
  }

  return {
    total,
    orders,
    size_mb: Math.round((bytes / 1024 / 1024) * 10) / 10,
    cats: CATS.map((c) => ({ ...c, count: catMap[c.code] || 0 })),
    days,
    today: localDate()
  };
}

/**
 * 删除（软删除）
 * 只有上传人自己和 admin 能删：谁拍的谁最清楚是不是拍错了。
 */
function remove(id, user) {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
  if (!row || row.deleted_at) throw bad('照片不存在或已删除');
  const isAdmin = (user.roles || [user.role]).includes('admin');
  if (!isAdmin && row.uploader !== user.username) {
    throw bad('只能删除自己上传的照片');
  }
  db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ?').run(now(), Number(id));
  return { id: Number(id) };
}

/** 容量统计（系统设置/照片墙底部提示用） */
function diskUsage() {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else { files++; bytes += fs.statSync(p).size; }
    });
  };
  walk(PHOTO_DIR);
  return { files, size_mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}

module.exports = { CATS, CAT_CODES, save, list, stats, remove, getById, diskUsage, PHOTO_DIR };
