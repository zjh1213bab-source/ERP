/**
 * 工序类别档案
 * GET    /api/craft-types?q=&category=&status=
 * GET    /api/craft-types/:id
 * POST   /api/craft-types
 * PUT    /api/craft-types/:id
 * DELETE /api/craft-types/:id   停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'production', 'sales'];
const CATS = ['sewing', 'print', 'embroidery', 'wash', 'finish', 'pack', 'other'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', category = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) {
    where.push('name LIKE ?');
    const kw = `%${q}%`;
    params.push(kw);
  }
  const sql = 'SELECT * FROM craft_types ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY category, name, id';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM craft_types WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序类别不存在');
  return ok(res, row);
}));

function validated(body, previous={}) {
  const b={...previous,...body};
  const bad=message=>{throw Object.assign(new Error(message),{status:400});};
  const name=String(b.name||'').trim();
  if(!name || name.length>60)bad('工序名称必填且最多60字');
  const category=b.category || 'sewing';if(!CATS.includes(category))bad('工序类别无效');
  const price=Number(b.default_price||0);if(!Number.isFinite(price)||price<0)bad('默认单价必须为非负数');
  const status=b.status||'active';if(!['active','disabled'].includes(status))bad('状态无效');
  if(String(b.unit||'件').length>16||String(b.remark||'').length>1000)bad('单位或说明超出长度限制');
  return {name,category,unit:String(b.unit||'件'),default_price:price,is_out:Number(previous.is_out)||0,image_url:previous.image_url||null,remark:b.remark||null,status};
}
router.post('/',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
  const b=validated(req.body||{}),ts=now();
  // 条件插入为一个原子语句：并发同名提交不会重复建档，不接受全局编号或排序。
  const info=db.prepare(`INSERT INTO craft_types(name,category,unit,default_price,is_out,image_url,remark,status,sort,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,0,?,? WHERE NOT EXISTS(SELECT 1 FROM craft_types WHERE TRIM(name)=? COLLATE NOCASE AND category=?)`)
    .run(b.name,b.category,b.unit,b.default_price,b.is_out,b.image_url,b.remark,b.status,ts,ts,b.name,b.category);
  if(!info.changes)return fail(res,409,'同类别已有同名工序，请刷新选择；已停用的工序请先启用');
  return ok(res,db.prepare('SELECT * FROM craft_types WHERE id=?').get(Number(info.lastInsertRowid)));
}));
router.put('/:id',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
  const row=db.prepare('SELECT * FROM craft_types WHERE id=?').get(req.params.id);if(!row)return fail(res,404,'工序类别不存在');
  const b=validated(req.body||{},row);
  const info=db.prepare(`UPDATE craft_types SET name=?,category=?,unit=?,default_price=?,is_out=?,image_url=?,remark=?,status=?,updated_at=?
    WHERE id=? AND NOT EXISTS(SELECT 1 FROM craft_types WHERE TRIM(name)=? COLLATE NOCASE AND category=? AND id<>?)`)
    .run(b.name,b.category,b.unit,b.default_price,b.is_out,b.image_url,b.remark,b.status,now(),row.id,b.name,b.category,row.id);
  if(!info.changes)return fail(res,409,'同类别已有同名工序');
  return ok(res,db.prepare('SELECT * FROM craft_types WHERE id=?').get(row.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM craft_types WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序类别不存在');
  db.prepare("UPDATE craft_types SET status='disabled', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'disabled' });
}));

module.exports = router;
