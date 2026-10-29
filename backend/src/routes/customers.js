/**
 * 客户管理
 * GET    /api/customers?q=&status=   列表（登录可读）
 * GET    /api/customers/:id          详情
 * POST   /api/customers              新增（admin/sales）
 * PUT    /api/customers/:id          修改（admin/sales）
 * DELETE /api/customers/:id          停用（admin/sales）
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const privacy = require('../services/privacy');
const { reqCtx } = require('../utils/reqCtx');
const scope = require('../access/companyScope');

const router = express.Router();
const WRITE = ['admin', 'sales'];

router.get(
  '/',
  authRequired,
  wrap(async (req, res) => {
    const { q = '', status = '' } = req.query;
    const where = [];
    const params = [];
    if (q) {
      where.push('(name LIKE ? OR code LIKE ? OR contact LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const sql =
      'SELECT * FROM customers ' +
      (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      'ORDER BY id DESC';
    const rows = db.prepare(sql).all(...params);
    // 客户手机与邮箱按 crm.pii 脱敏（销售/财务可看明文，其余人看到掩码）
    return ok(res, privacy.maskRows('customers', rows, reqCtx(req, { action: 'list' })));
  })
);

router.get(
  '/:id',
  authRequired,
  wrap(async (req, res) => {
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, '客户不存在');
    return ok(res, row);
  })
);

router.post(
  '/',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, '客户名称必填');
    const t = now();
    const info = db
      .prepare(
        `INSERT INTO customers (code, name, contact, phone, email, level, credit_limit, status, remark, image_url, created_at, updated_at, company_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        b.code || null,
        b.name,
        b.contact || null,
        b.phone || null,
        b.email || null,
        b.level || 'B',
        Number(b.credit_limit) || 0,
        b.status || 'active',
        b.remark || null,
        b.image_url || null,
        t,
        t,
        /**
         * 客户档案也要落抬头。
         *
         * 这一列一直存在（可空、无默认），但以前**从来没写过** —— 多主体时代是漏的，
         * 单公司时代则是"新客户没有公司归属"。走 writeCompanyOf：单公司模式恒落唯一抬头，
         * 多主体模式下按操作人主体（集团角色可显式指定）。
         */
        scope.writeCompanyOf(req.user, b.company_id)
      );
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid));
    return ok(res, row);
  })
);

router.put(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const id = req.params.id;
    const exists = db.prepare('SELECT 1 AS x FROM customers WHERE id = ?').get(id);
    if (!exists) return fail(res, 404, '客户不存在');
    const b = req.body || {};
    if (!b.name) return fail(res, 400, '客户名称必填');
    db.prepare(
      `UPDATE customers SET code=?, name=?, contact=?, phone=?, email=?, level=?, credit_limit=?, status=?, remark=?, image_url=?, updated_at=?
       WHERE id=?`
    ).run(
      b.code || null,
      b.name,
      b.contact || null,
      b.phone || null,
      b.email || null,
      b.level || 'B',
      Number(b.credit_limit) || 0,
      b.status || 'active',
      b.remark || null,
      b.image_url ?? null,
      now(),
      id
    );
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    return ok(res, row);
  })
);

router.delete(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const exists = db.prepare('SELECT 1 AS x FROM customers WHERE id = ?').get(req.params.id);
    if (!exists) return fail(res, 404, '客户不存在');
    // 软删除：置为停用，保留历史订单引用
    db.prepare("UPDATE customers SET status='disabled', updated_at=? WHERE id=?").run(
      now(),
      req.params.id
    );
    return ok(res, { id: Number(req.params.id), status: 'disabled' });
  })
);

module.exports = router;
