/**
 * 产品（款号）管理
 * GET    /api/products?q=&status=        列表（带颜色、尺码、主图）
 * GET    /api/products/:id               单个（带颜色、尺码）
 * POST   /api/products                   新增（admin/sales/tech）
 * PUT    /api/products/:id               修改（含整组替换颜色/尺码）
 * DELETE /api/products/:id               停用
 *
 * 颜色与尺码的规则（每一条都对应一次真实的错法）：
 *   - **同一产品内颜色名不能重复**（TRIM + 不分大小写）。重名意味着两行不同的图会争同一个名字，
 *     下单时选「印花001」根本分不出是哪一张 —— 所以直接拒绝并说清撞了哪个。
 *   - **尺码重复自动去重**：手输 `S,M,L,S` 很常见，去重是体贴不是放水；但颜色不做静默去重。
 *   - **字段不传 = 不接管**（保留原值），传空数组 = 清空。老调用方只改名称时不会把颜色清掉。
 *   - 图片地址只接受 `/uploads/...` 相对路径或 http(s) 链接：`data:` 会把 base64 撑进库，
 *     `javascript:` 之类更是注入面。
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'sales', 'tech'];
/**
 * 颜色 / 花型的维护权（= 权限点 `product.color.write`）
 *
 * 比 product.write 窄：销售可以改产品名称/单价、可以在下单时**选**颜色，
 * 但不能新增或改颜色 —— 颜色是全公司口径（订单行、库存对账都按它归集），
 * 随手多加一个「印花1」会和「印花001」并存，事后只能人工合并。
 */
const COLOR_WRITE = ['admin', 'tech'];
const canColorWrite = (user) => COLOR_WRITE.includes(user && user.role);

const MAX_COLORS = 60;
const MAX_SIZES = 30;

/** 图片地址白名单：相对路径（/uploads/...）或 http(s) */
function safeImage(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^\/uploads\//.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return null; // 非法 → 由调用方报错
}

/**
 * 解析并校验颜色/尺码。
 * 返回 { colors, sizes, touchColors, touchSizes }；colors/sizes 为 null 表示"这次不接管"。
 * 抛出的错误由调用方转成 400 —— 全在事务之前完成。
 */
function parseVariants(b) {
  const out = { colors: null, sizes: null };

  if (b.colors !== undefined) {
    if (!Array.isArray(b.colors)) throw new Error('colors 必须是数组');
    if (b.colors.length > MAX_COLORS) throw new Error(`颜色最多 ${MAX_COLORS} 个`);
    const seen = new Map();
    out.colors = b.colors.map((c, i) => {
      const name = String((c && c.name) || '').trim();
      if (!name) throw new Error(`第 ${i + 1} 个颜色没填名称`);
      if (name.length > 40) throw new Error(`颜色名「${name}」超过 40 字`);
      const key = name.toUpperCase();
      if (seen.has(key)) throw new Error(`颜色「${name}」重复（第 ${seen.get(key) + 1} 个与第 ${i + 1} 个同名）`);
      seen.set(key, i);
      const img = safeImage(c && c.image_url);
      if (img === null) throw new Error(`颜色「${name}」的图片地址不合法（只支持上传图或 http(s) 链接）`);
      return { name, image_url: img || null, sort: i };
    });
  }

  if (b.sizes !== undefined) {
    if (!Array.isArray(b.sizes)) throw new Error('sizes 必须是数组');
    const seen = new Set();
    const list = [];
    for (const raw of b.sizes) {
      const size = String(raw && raw.size !== undefined ? raw.size : raw).trim();
      if (!size) continue;                       // 空项直接跳过，不报错（逗号粘连常见）
      if (size.length > 20) throw new Error(`尺码「${size}」超过 20 字`);
      const key = size.toUpperCase();
      if (seen.has(key)) continue;               // 尺码重复 = 去重
      seen.add(key);
      list.push({ size, sort: list.length });
    }
    if (list.length > MAX_SIZES) throw new Error(`尺码最多 ${MAX_SIZES} 个`);
    out.sizes = list;
  }

  return out;
}

function imageOf(b) {
  const img = safeImage(b.image_url);
  if (img === null) throw new Error('图片地址不合法（只支持上传图或 http(s) 链接）');
  return img || null;
}

/** 把颜色/尺码挂到产品行上（两次 IN 查询，避免逐行 N+1） */
function attachVariants(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return rows;
  const ids = list.filter(Boolean).map((r) => r.id);
  if (!ids.length) return rows;
  const marks = ids.map(() => '?').join(',');
  const colors = db.prepare(
    `SELECT product_id, id, name, image_url, sort FROM product_colors WHERE product_id IN (${marks}) ORDER BY sort, id`
  ).all(...ids);
  const sizes = db.prepare(
    `SELECT product_id, id, size, sort FROM product_sizes WHERE product_id IN (${marks}) ORDER BY sort, id`
  ).all(...ids);
  const byColor = new Map();
  colors.forEach((c) => {
    if (!byColor.has(c.product_id)) byColor.set(c.product_id, []);
    byColor.get(c.product_id).push(c);
  });
  const bySize = new Map();
  sizes.forEach((s) => {
    if (!bySize.has(s.product_id)) bySize.set(s.product_id, []);
    bySize.get(s.product_id).push(s);
  });
  list.forEach((r) => {
    if (!r) return;
    r.colors = byColor.get(r.id) || [];
    r.sizes = bySize.get(r.id) || [];
  });
  return rows;
}

function replaceVariants(productId, v, t) {
  if (v.colors) {
    db.prepare('DELETE FROM product_colors WHERE product_id = ?').run(productId);
    const ins = db.prepare(
      'INSERT INTO product_colors (product_id, name, image_url, sort, created_at) VALUES (?,?,?,?,?)'
    );
    v.colors.forEach((c) => ins.run(productId, c.name, c.image_url, c.sort, t));
  }
  if (v.sizes) {
    db.prepare('DELETE FROM product_sizes WHERE product_id = ?').run(productId);
    const ins = db.prepare(
      'INSERT INTO product_sizes (product_id, size, sort, created_at) VALUES (?,?,?,?)'
    );
    v.sizes.forEach((s) => ins.run(productId, s.size, s.sort, t));
  }
}

router.get(
  '/',
  authRequired,
  wrap(async (req, res) => {
    const { q = '', status = '' } = req.query;
    const where = [];
    const params = [];
    if (q) {
      /*
       * 颜色名也要能搜到：客服常按「印花001」找款，而它不在 products 表里。
       * 用 EXISTS 子查询而不是 JOIN —— JOIN 会让一个 3 色款在列表里出现 3 行。
       */
      where.push('(name LIKE ? OR sku LIKE ? OR category LIKE ? OR EXISTS (SELECT 1 FROM product_colors pc WHERE pc.product_id = products.id AND pc.name LIKE ?))');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const sql =
      'SELECT * FROM products ' +
      (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      'ORDER BY id DESC';
    return ok(res, attachVariants(db.prepare(sql).all(...params)));
  })
);

router.get(
  '/:id',
  authRequired,
  wrap(async (req, res) => {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, '产品不存在');
    return ok(res, attachVariants(row));
  })
);

router.post(
  '/',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, '产品名称必填');

    // 校验全部放在 BEGIN 之前：事务里 return fail() 不会回滚（本项目的硬约定）
    let v;
    let img;
    try {
      v = parseVariants(b);
      img = imageOf(b);
    } catch (e) {
      return fail(res, 400, e.message);
    }
    if (b.colors !== undefined && !canColorWrite(req.user)) {
      return fail(res, 403, '颜色/花型属于产品主数据，只有技术或管理员可以新增或修改（你可以先建产品，再让技术补颜色）');
    }
    if (b.sku) {
      const dup = db.prepare('SELECT 1 AS x FROM products WHERE sku = ?').get(b.sku);
      if (dup) return fail(res, 400, '款号(SKU)已存在');
    }

    const t = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const info = db
        .prepare(
          `INSERT INTO products (sku, name, category, unit, price, status, remark, image_url, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          b.sku || null,
          b.name,
          b.category || null,
          b.unit || '件',
          Number(b.price) || 0,
          b.status || 'active',
          b.remark || null,
          img,
          t,
          t
        );
      const id = Number(info.lastInsertRowid);
      replaceVariants(id, v, t);
      db.exec('COMMIT');
      return ok(res, attachVariants(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  })
);

router.put(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const id = req.params.id;
    // 取整行：下面"不传 image_url 则保留原图"要用到旧值
    const exists = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!exists) return fail(res, 404, '产品不存在');
    const b = req.body || {};
    if (!b.name) return fail(res, 400, '产品名称必填');

    let v;
    let img;
    try {
      v = parseVariants(b);
      img = imageOf(b);
    } catch (e) {
      return fail(res, 400, e.message);
    }
    if (b.colors !== undefined && !canColorWrite(req.user)) {
      return fail(res, 403, '颜色/花型属于产品主数据，只有技术或管理员可以新增或修改');
    }
    if (b.sku) {
      const dup = db.prepare('SELECT 1 AS x FROM products WHERE sku = ? AND id <> ?').get(b.sku, id);
      if (dup) return fail(res, 400, '款号(SKU)已被其它产品占用');
    }

    const t = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE products SET sku=?, name=?, category=?, unit=?, price=?, status=?, remark=?, image_url=?, updated_at=? WHERE id=?`
      ).run(
        b.sku || null,
        b.name,
        b.category || null,
        b.unit || '件',
        Number(b.price) || 0,
        b.status || 'active',
        b.remark || null,
        // 不传 image_url 时保留原图（老页面只改名字不该把图清掉）
        b.image_url === undefined ? exists.image_url : img,
        t,
        id
      );
      replaceVariants(id, v, t);
      db.exec('COMMIT');
      return ok(res, attachVariants(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  })
);

/**
 * 追加一个颜色 / 花型（下单页里的「＋ 新增颜色」走这里）
 *
 * 为什么不复用 PUT 的整组替换：两个人在同一款上同时加颜色时，整组替换会用"我看到的旧列表"
 * 覆盖掉对方刚加的那个。追加是幂等的最小动作，冲突只在同名时发生（409 说清已存在）。
 */
router.post(
  '/:id/colors',
  authRequired,
  requireRole(COLOR_WRITE),
  wrap(async (req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!p) return fail(res, 404, '产品不存在');
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return fail(res, 400, '颜色名称必填');
    if (name.length > 40) return fail(res, 400, '颜色名超过 40 字');
    const img = safeImage(b.image_url);
    if (img === null) return fail(res, 400, '图片地址不合法（只支持上传图或 http(s) 链接）');

    const dup = db.prepare(
      'SELECT id, name FROM product_colors WHERE product_id = ? AND UPPER(TRIM(name)) = ?'
    ).get(p.id, name.toUpperCase());
    if (dup) return fail(res, 409, `该款已有颜色「${dup.name}」，换个名字（同一款里颜色名不能重复）`);

    const t = now();
    const maxSort = db.prepare('SELECT IFNULL(MAX(sort), -1) AS m FROM product_colors WHERE product_id = ?').get(p.id).m;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT INTO product_colors (product_id, name, image_url, sort, created_at) VALUES (?,?,?,?,?)'
      ).run(p.id, name, img || null, Number(maxSort) + 1, t);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return ok(res, attachVariants(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)));
  })
);

/** 删除单个颜色（产品页/下单页误加时用）。历史订单里存的是颜色文本，不受影响 */
router.delete(
  '/:id/colors/:colorId',
  authRequired,
  requireRole(COLOR_WRITE),
  wrap(async (req, res) => {
    const row = db.prepare('SELECT * FROM product_colors WHERE id = ? AND product_id = ?')
      .get(req.params.colorId, req.params.id);
    if (!row) return fail(res, 404, '颜色不存在或不属于该产品');
    db.prepare('DELETE FROM product_colors WHERE id = ?').run(row.id);
    return ok(res, { id: row.id, name: row.name, deleted: true });
  })
);

router.delete(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const exists = db.prepare('SELECT 1 AS x FROM products WHERE id = ?').get(req.params.id);
    if (!exists) return fail(res, 404, '产品不存在');
    // 只停用、不删行：历史订单行与颜色引用都还指着这个 id，删了会留下悬空引用
    db.prepare("UPDATE products SET status='disabled', updated_at=? WHERE id=?").run(
      now(),
      req.params.id
    );
    return ok(res, { id: Number(req.params.id), status: 'disabled' });
  })
);

module.exports = router;
