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
const cycles = require('../services/customerCycles');
router.get('/salespeople', authRequired, requireRole(WRITE), wrap(async(req,res)=> {
 const c=scope.clause(req.user);
 return ok(res,db.prepare('SELECT id,name,username FROM users WHERE active=1'+c.sql+' ORDER BY name,id').all(...c.params));
}));

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
    const rows = db.prepare(sql).all(...params).map(c => ({...c,...cycles.summary(c,req.user)}));
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

// 所有档案写入共用字段校验，SQL 列名仅来自服务端白名单。
const CYCLE_FIELDS=['owner_user_id','order_cycle_days','cycle_started_at','cycle_version'];
const CUSTOMER_FIELDS = ['code','name','contact','phone','email','level','credit_limit','status','remark','image_url','country','customer_type','contact_title','registered_address','billing_address','shipping_address','tax_id','currency','payment_terms','incoterms'];
function customerInput(body, previous = {}) {
  const b = { ...previous, ...body };
  const values = {};
  for (const key of CUSTOMER_FIELDS) {
    if (key === 'credit_limit') continue;
    if (b[key] != null && typeof b[key] !== 'string') throw Object.assign(new Error('客户字段格式错误：' + key), { status: 400 });
    values[key] = String(b[key] || '').trim();
    if (values[key].length > (key.includes('address') || key === 'remark' ? 2000 : 255)) throw Object.assign(new Error('字段过长：' + key), { status: 400 });
  }
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!values.name) bad('客户名称必填');
  values.level = ({ A: 'L1', B: 'L2', C: 'L3' })[values.level] || values.level || 'L2';
  if (!/^L[0-4]$/.test(values.level)) bad('客户等级必须为 L0–L4');
  values.status ||= 'active';
  if (!['active','disabled'].includes(values.status)) bad('客户状态无效');
  values.customer_type ||= 'company';
  if (!['company','individual'].includes(values.customer_type)) bad('客户类型无效');
  values.currency ||= 'USD';
  if (!/^[A-Z]{3}$/.test(values.currency)) bad('币种请填写三位大写代码');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) bad('邮箱格式无效');
  values.credit_limit = Number(b.credit_limit || 0);
  if (!Number.isFinite(values.credit_limit) || values.credit_limit < 0) bad('信用额度必须为非负数');
  return values;
}
router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = customerInput(req.body || {}), t = now();
  const cycle=cycles.input(req.body||{}, {}, req.user); Object.assign(b,cycle);
  const columns = [...CUSTOMER_FIELDS,...CYCLE_FIELDS, 'created_at','updated_at','company_id'];
  const info = db.prepare(`INSERT INTO customers (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...[...CUSTOMER_FIELDS,...CYCLE_FIELDS].map(k => b[k]), t, t, scope.writeCompanyOf(req.user, req.body?.company_id));
  return ok(res, db.prepare('SELECT * FROM customers WHERE id=?').get(Number(info.lastInsertRowid)));
}));
router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const previous = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!previous) return fail(res, 404, '客户不存在');
  const b = customerInput(req.body || {}, previous);
  const cycle=cycles.input(req.body||{},previous,req.user); Object.assign(b,cycle);
  const changed=db.prepare(`UPDATE customers SET ${[...CUSTOMER_FIELDS,...CYCLE_FIELDS].map(k => k + '=?').join(',')},updated_at=? WHERE id=? AND cycle_version=?`)
    .run(...[...CUSTOMER_FIELDS,...CYCLE_FIELDS].map(k => b[k]), now(), previous.id,previous.cycle_version);
  if(!changed.changes) return fail(res,409,'客户已被修改，请刷新后重试');
  return ok(res, db.prepare('SELECT * FROM customers WHERE id=?').get(previous.id));
}));

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
