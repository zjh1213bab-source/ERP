/** 物料主数据：颜色只属于订单，规格修改保留版本与修改原因。 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];
const FIELDS = ['unit_price','type','code','name','short_name','spec','supplier','supplier_info','supplier_id','image_url','width','weight','air_gap','composition','unit','stock_qty','stock_detail','remark','status'];
const SPEC_FIELDS = ['spec','width','weight','air_gap'];
const bad = (message, status=400) => { throw Object.assign(new Error(message), { status }); };
function input(body, previous={}) {
  const b = { ...previous, ...body }, v = {};
  for (const key of FIELDS) {
    if (['stock_qty','supplier_id','unit_price'].includes(key)) continue;
    if (b[key] != null && typeof b[key] !== 'string') bad('物料字段格式错误：'+key);
    v[key] = String(b[key] || '').trim();
    if (v[key].length > (['remark','supplier_info','stock_detail','spec'].includes(key) ? 2000 : 255)) bad('字段过长：'+key);
  }
  if (!['fabric','accessory'].includes(v.type)) bad('物料类型无效');
  if (!v.name) bad('物料名称必填');
  v.status ||= 'active';
  if (!['active','disabled'].includes(v.status)) bad('物料状态无效');
  v.unit_price = Number(b.unit_price ?? 0);
  if (!Number.isFinite(v.unit_price) || v.unit_price < 0 || v.unit_price > 1e7) bad('档案单价无效');
  v.stock_qty = Number(b.stock_qty || 0);
  if (!Number.isFinite(v.stock_qty) || v.stock_qty < 0) bad('库存数必须为非负数');
  const sid = Number(b.supplier_id || 0);
  if (!Number.isSafeInteger(sid) || sid < 0) bad('供应商编号无效');
  // 客户端只提交档案ID，名称/联系信息由后端取值，禁止随意填写供应商。
  const supplier = sid ? db.prepare('SELECT * FROM suppliers WHERE id=?').get(sid) : null;
  if (sid && (!supplier || supplier.status !== 'active')) bad('请选择启用的供应商档案');
  v.supplier_id = supplier?.id || null;
  v.supplier = supplier?.name || null;
  v.supplier_info = supplier ? [supplier.address,supplier.contact,supplier.phone].filter(Boolean).join(' / ') : null;
  return v;
}
function record(id, version, before, after, req) {
  db.prepare('INSERT INTO material_changes(material_id,version,before_json,after_json,reason,operator_id,operator_name,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,version,JSON.stringify(before),JSON.stringify(after),String(req.body?.change_reason || '').trim() || null,req.user.sub,req.user.name || req.user.username,now());
}
router.get('/', authRequired, wrap(async(req,res)=>{
  const {type='',status='',q=''}=req.query, where=[], args=[];
  if(type){where.push('type=?');args.push(type);} if(status){where.push('status=?');args.push(status);}
  if(q){where.push('(name LIKE ? OR code LIKE ? OR short_name LIKE ? OR supplier LIKE ?)');args.push(...Array(4).fill('%'+q+'%'));}
  return ok(res,db.prepare('SELECT * FROM materials '+(where.length?'WHERE '+where.join(' AND '):'')+' ORDER BY type,supplier,id').all(...args));
}));
router.get('/:id/history',authRequired,wrap(async(req,res)=>{
  if(!db.prepare('SELECT id FROM materials WHERE id=?').get(req.params.id))return fail(res,404,'物料不存在');
  return ok(res,db.prepare('SELECT * FROM material_changes WHERE material_id=? ORDER BY id DESC').all(req.params.id).map(r=>({...r,before:JSON.parse(r.before_json),after:JSON.parse(r.after_json)})));
}));
router.get('/:id',authRequired,wrap(async(req,res)=>{const row=db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);return row?ok(res,row):fail(res,404,'档案不存在');}));
function create(v,req) {
  const ts=now(), columns=[...FIELDS,'created_at','updated_at','version'];
  const info=db.prepare(`INSERT INTO materials(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...FIELDS.map(k=>v[k]),ts,ts,1);
  const row=db.prepare('SELECT * FROM materials WHERE id=?').get(Number(info.lastInsertRowid));record(row.id,1,{},row,req);return row;
}
router.post('/',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
  const v=input(req.body || {});let row;
  db.exec('BEGIN IMMEDIATE');try{row=create(v,req);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  return ok(res,row);
}));
router.put('/:id',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
  const row=db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);if(!row)return fail(res,404,'记录不存在');
  const b=req.body || {}, v=input(b,row);
  if(!Number.isSafeInteger(b.version) || b.version!==row.version)return fail(res,409,'档案已更新或缺少版本，请刷新后重试');
  if(SPEC_FIELDS.some(k=>String(row[k]||'')!==String(v[k]||'')) && !String(b.change_reason||'').trim())return fail(res,400,'修改规格请填写原因');
  if(String(b.change_reason||'').length>500)return fail(res,400,'修改原因最多500字');
  let updated;
  // 更新档案与版本记录必须同事务：日志写入失败时档案也回滚。
  db.exec('BEGIN IMMEDIATE');try{
    const info=db.prepare(`UPDATE materials SET ${FIELDS.map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`).run(...FIELDS.map(k=>v[k]),now(),row.id,b.version);
    if(!info.changes)bad('档案已被他人更新，请刷新后重试',409);
    updated=db.prepare('SELECT * FROM materials WHERE id=?').get(row.id);record(row.id,updated.version,row,updated,req);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return ok(res,updated);
}));
router.post('/:id/duplicate',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
 const row=db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);if(!row)return fail(res,404,'记录不存在');
 const v=input({...row,stock_qty:0,status:'active'});let created;db.exec('BEGIN IMMEDIATE');try{created=create(v,req);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return ok(res,created);
}));
router.delete('/:id',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
 const row=db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);if(!row)return fail(res,404,'记录不存在');
 db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE materials SET status='disabled',version=version+1,updated_at=? WHERE id=?").run(now(),row.id);record(row.id,row.version+1,row,{...row,status:'disabled'},req);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return ok(res,{id:row.id,status:'disabled'});
}));
module.exports=router;
