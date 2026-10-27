/**
 * 批量导入（CSV）
 * POST /api/import/customers { csv }
 * POST /api/import/products  { csv }
 * POST /api/import/materials { csv }
 * 说明：CSV 需 UTF-8 编码（Excel 另存为「CSV UTF-8」）；首行为表头。
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'sales', 'tech'];

/** 解析 CSV（支持引号、逗号、换行） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else if (c === '\r') { /* ignore */ }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/** 按表头名取列值（支持别名） */
function reader(header) {
  const idx = {};
  header.forEach((h, i) => { idx[String(h).trim()] = i; });
  return (row, ...names) => {
    for (const n of names) {
      if (idx[n] !== undefined) {
        const v = row[idx[n]];
        return v === undefined || v === null ? '' : String(v).trim();
      }
    }
    return '';
  };
}

function prep(csv) {
  const rows = parseCsv(String(csv || ''));
  if (rows.length < 2) throw new Error('CSV 内容为空或缺少数据行');
  const header = rows[0];
  return { header, get: reader(header), data: rows.slice(1) };
}

// ---------- 模板下载 ----------
const TEMPLATES = {
  customers: [
    ['编号', '名称', '联系人', '电话', '邮箱', '等级', '信用额度', '状态', '备注'],
    ['C-1001', '示例客户公司', '张三', '13800000000', 'demo@example.com', 'A', '50000', '启用', '按编号覆盖，无编号则新增'],
  ],
  products: [
    ['款号', '名称', '品类', '单位', '单价', '状态', '备注'],
    ['SKU-1001', '示例款-女装连衣裙', '连衣裙', '件', '12.5', '启用', '按款号覆盖'],
  ],
  materials: [
    ['类型', '编码', '名称', '规格', '供应商', '状态'],
    ['面料', 'F-001', '32S 精梳棉', '185g/㎡ 幅宽150cm', '绍兴纺织', '启用'],
    ['辅料', 'A-001', '树脂纽扣', '18L 米白', '义乌辅料城', '启用'],
  ],
};

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/template/:kind', authRequired, (req, res) => {
  const rows = TEMPLATES[req.params.kind];
  if (!rows) return fail(res, 404, '模板不存在');
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.kind}.csv"`);
  return res.send('\uFEFF' + body);
});

// ---------- 客户 ----------
router.post('/customers', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  let p;
  try { p = prep(req.body && req.body.csv); } catch (e) { return fail(res, 400, e.message); }
  const { get, data } = p;
  let inserted = 0, updated = 0;
  const errors = [];
  const t = now();
  data.forEach((r, i) => {
    try {
      const name = get(r, '名称', '客户名称', 'name');
      if (!name) throw new Error('缺少客户名称');
      const code = get(r, '编号', '客户编号', 'code') || null;
      const contact = get(r, '联系人', 'contact') || null;
      const phone = get(r, '电话', 'phone') || null;
      const email = get(r, '邮箱', 'email') || null;
      const level = get(r, '等级', 'level') || 'B';
      const credit = Number(get(r, '信用额度', 'credit_limit')) || 0;
      const status = (get(r, '状态', 'status') || 'active') === '停用' ? 'disabled' : 'active';
      const remark = get(r, '备注', 'remark') || null;
      const exist = code ? db.prepare('SELECT id FROM customers WHERE code = ?').get(code) : null;
      if (exist) {
        db.prepare('UPDATE customers SET name=?, contact=?, phone=?, email=?, level=?, credit_limit=?, status=?, remark=?, updated_at=? WHERE id=?')
          .run(name, contact, phone, email, level, credit, status, remark, t, exist.id);
        updated++;
      } else {
        db.prepare('INSERT INTO customers (code,name,contact,phone,email,level,credit_limit,status,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(code, name, contact, phone, email, level, credit, status, remark, t, t);
        inserted++;
      }
    } catch (e) { errors.push(`第 ${i + 2} 行：${e.message}`); }
  });
  return ok(res, { inserted, updated, errors });
}));

// ---------- 产品 ----------
router.post('/products', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  let p;
  try { p = prep(req.body && req.body.csv); } catch (e) { return fail(res, 400, e.message); }
  const { get, data } = p;
  let inserted = 0, updated = 0;
  const errors = [];
  const t = now();
  data.forEach((r, i) => {
    try {
      const name = get(r, '名称', '产品名称', 'name');
      if (!name) throw new Error('缺少产品名称');
      const sku = get(r, '款号', 'SKU', 'sku') || null;
      const category = get(r, '品类', 'category') || null;
      const unit = get(r, '单位', 'unit') || '件';
      const price = Number(get(r, '单价', 'price')) || 0;
      const status = (get(r, '状态', 'status') || 'active') === '停用' ? 'disabled' : 'active';
      const remark = get(r, '备注', 'remark') || null;
      const exist = sku ? db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) : null;
      if (exist) {
        db.prepare('UPDATE products SET name=?, category=?, unit=?, price=?, status=?, remark=?, updated_at=? WHERE id=?')
          .run(name, category, unit, price, status, remark, t, exist.id);
        updated++;
      } else {
        db.prepare('INSERT INTO products (sku,name,category,unit,price,status,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(sku, name, category, unit, price, status, remark, t, t);
        inserted++;
      }
    } catch (e) { errors.push(`第 ${i + 2} 行：${e.message}`); }
  });
  return ok(res, { inserted, updated, errors });
}));

// ---------- 面辅料 ----------
router.post('/materials', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  let p;
  try { p = prep(req.body && req.body.csv); } catch (e) { return fail(res, 400, e.message); }
  const { get, data } = p;
  let inserted = 0, updated = 0;
  const errors = [];
  const t = now();
  data.forEach((r, i) => {
    try {
      const name = get(r, '名称', '物料名称', 'name');
      if (!name) throw new Error('缺少物料名称');
      const rawType = get(r, '类型', 'type');
      const type = rawType === '辅料' || rawType === 'accessory' ? 'accessory' : 'fabric';
      const code = get(r, '编码', '编号', 'code') || null;
      const spec = get(r, '规格', 'spec') || null;
      const supplier = get(r, '供应商', 'supplier') || null;
      const exist = db.prepare('SELECT id FROM materials WHERE type = ? AND name = ?').get(type, name);
      if (exist) {
        db.prepare('UPDATE materials SET code=?, spec=?, supplier=? WHERE id=?').run(code, spec, supplier, exist.id);
        updated++;
      } else {
        db.prepare('INSERT INTO materials (type, code, name, spec, supplier, status, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(type, code, name, spec, supplier, 'active', t);
        inserted++;
      }
    } catch (e) { errors.push(`第 ${i + 2} 行：${e.message}`); }
  });
  return ok(res, { inserted, updated, errors });
}));

module.exports = router;
