/** 客户确认唯一业务实现：HTTP、审批回写、订单门槛共用，禁止只改生效状态。 */
const { db, now } = require('../db');
const crypto = require('crypto');
const bad = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const parse = (s, fallback = {}) => { try { return JSON.parse(s) || fallback; } catch { return fallback; } };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function sourceSnapshot(orderId, itemId, archiveId) {
  const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId, orderId);
  if (!item) bad('请选择本订单的具体款式');
  const available=db.prepare('SELECT a.id FROM sample_archives a JOIN tech_packs tp ON tp.id=a.tech_pack_id WHERE tp.order_item_id=? ORDER BY a.id DESC LIMIT 1').get(itemId);
  if(available && !archiveId)bad('本款已有样衣档案，请选择样衣库版本进行封样');
  const archive = archiveId ? db.prepare('SELECT * FROM sample_archives WHERE id=? AND order_id=?').get(archiveId, orderId) : null;
  if (archiveId && !archive) bad('样衣档案不属于当前订单');
  if (archive) {
    const tp = db.prepare('SELECT * FROM tech_packs WHERE id=?').get(archive.tech_pack_id);
    if (!tp || Number(tp.order_item_id) !== Number(itemId)) bad('样衣档案尚未关联到该款，请先核对开发来源');
    if(available?.id!==archive.id)bad('本款已有更新的样衣版本，请按最新样衣重新封样',409);
  }
  // 只绑定影响实物的内容；金额/数量的重新核算不应凭空改变样衣外观确认。
  const materials=db.prepare('SELECT id,material_id,name,spec,ingredient,mat_color,unit,supplier,remark FROM order_materials WHERE order_id=? AND (item_id=? OR item_id IS NULL) ORDER BY id').all(orderId,itemId);
  const crafts=db.prepare('SELECT id,name,instruction,remark FROM order_crafts WHERE order_id=? ORDER BY id').all(orderId);
  return { item: { id:item.id, product_name:item.product_name, style_no:item.style_no, effect_image_url:item.effect_image_url,
    detail_images:item.detail_images, remark:item.remark }, materials,crafts,
    archive: archive ? {id:archive.id, version:archive.version, snapshot:archive.snapshot, image_url:archive.image_url} : null };
}

function latestSeals(orderId) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(orderId);
  const rows = db.prepare("SELECT * FROM sample_seals WHERE order_id=? AND status<>'superseded' ORDER BY id DESC").all(orderId);
  return items.map(item => {
    // 老数据只在款号/款名唯一匹配，或单款订单时兼容；绝不以一款确认放行整单。
    const row = rows.find(r => Number(r.order_item_id) === item.id || (!r.order_item_id &&
      (items.length === 1 || ([item.style_no,item.product_name].filter(Boolean).includes(r.style_no) &&
        items.filter(i => [i.style_no,i.product_name].filter(Boolean).includes(r.style_no)).length === 1))));
    let stale = false;
    if (row?.snapshot_json) {
      try { stale = JSON.stringify(sourceSnapshot(orderId,item.id,row.archive_id)) !== row.snapshot_json; } catch { stale=true; }
    }
    return {item_id:item.id, name:item.product_name, seal:row || null, stale,
      ok:!!row && row.status==='confirmed' && !!row.tech_approved && !stale};
  });
}
function sealGate(orderId) {
  const order=db.prepare('SELECT type FROM orders WHERE id=?').get(orderId);
  const existing=db.prepare('SELECT id FROM sample_seals WHERE order_id=? LIMIT 1').get(orderId);
  if(order?.type!=='custom' && !existing) return {ok:true,items:[]};
  const items=latestSeals(orderId), failed=items.filter(i=>!i.ok);
  return {ok:items.length>0 && !failed.length,items,message:failed.length ? '封样未完成：'+failed.map(i=>i.name+(i.stale?'（资料已变更，需新版本）':!i.seal?'（未建封样）':'（缺客户确认或技术批准）')).join('、') : items.length?null:'订单没有款式'};
}
function checkSealContent(row) {
  if(row.snapshot_json && JSON.stringify(sourceSnapshot(row.order_id,row.order_item_id,row.archive_id))!==row.snapshot_json)
    bad('封样来源资料已变化，请创建新版本重新批准与确认',409);
}

/** 预下单开发成果在正式下单后续接；旧多款资料无法唯一匹配时由业务明确选款。 */
function linkDevelopment(orderId,itemId,tpId) {
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const item=db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId,orderId);
  const tp=db.prepare('SELECT * FROM tech_packs WHERE id=?').get(tpId);
  if(!order || !item || !tp || !(tp.order_id===order.id || (order.source_pre_order_id && tp.pre_order_id===order.source_pre_order_id)))bad('开发单与当前订单没有共同来源');
  if(tp.order_item_id && tp.order_item_id!==item.id)bad('该开发单已关联其他款式，不可重复使用');
  if(tp.pre_order_item_id && tp.pre_order_item_id!==item.source_pre_order_item_id)bad('开发单来源款式不一致');
  db.prepare('UPDATE tech_packs SET order_id=?,order_item_id=?,updated_at=? WHERE id=?').run(order.id,item.id,now(),tp.id);
  db.prepare('UPDATE pattern_flows SET order_id=? WHERE tech_pack_id=?').run(order.id,tp.id);
  db.prepare('UPDATE sample_archives SET order_id=? WHERE tech_pack_id=?').run(order.id,tp.id);
  db.prepare('UPDATE material_dev_requests SET order_id=?,order_no=? WHERE tech_pack_id=?').run(order.id,order.order_no,tp.id);
}
function linkPreOrder(orderId,preOrderId) {
  const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  for(const tp of db.prepare('SELECT * FROM tech_packs WHERE pre_order_id=? AND (order_id IS NULL OR order_id=0)').all(preOrderId)) {
    const candidates=items.filter(i=>tp.pre_order_item_id ? tp.pre_order_item_id===i.source_pre_order_item_id :
      items.length===1 || [i.style_no,i.product_name].filter(Boolean).includes(tp.customer_style_no || tp.product_name));
    if(candidates.length===1)linkDevelopment(orderId,candidates[0].id,tp.id);
  }
}

/** patch 仅接受明确目标字段，不执行任意 SQL/JSON，不覆盖主档或历史样衣。 */
function preparePatch(orderId,type,patch) {
  if (!patch || typeof patch!=='object' || Array.isArray(patch)) bad('请填写实际变更目标及变更值');
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!order || ['closed','cancelled'].includes(order.status)) bad('订单不存在或已结束，不能变更');
  let target, next={};
  if(type==='delivery') {
    const date=String(patch.new_date || '');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) bad('最新预计交期无效');
    target={latest_delivery_date:order.latest_delivery_date,delivery_date:order.delivery_date};next={new_date:date};
  } else {
    // 已发货部分有既定价格/数量/工艺快照；剩余部分需拆单后再变更，禁止整单覆盖历史。
    const shipped=db.prepare("SELECT 1 FROM stock_ledger WHERE ref_type='order' AND ref_id=? AND type='out' LIMIT 1").get(orderId);
    if(shipped || ['shipped','closed'].includes(order.status)) bad('订单已有交付记录，请拆分剩余订单后申请变更，历史已交付部分不可覆盖');
    if(['qty','price'].includes(type)) {
      if(!['draft','tech','finance'].includes(order.status) || db.prepare("SELECT 1 FROM dispatch_orders WHERE order_id=? AND status<>'cancelled' LIMIT 1").get(orderId))
        bad('数量/价格变更须在分单生产前完成；已分单请先按原流程撤回并重新评估');
      target=db.prepare('SELECT s.* FROM order_item_sizes s JOIN order_items i ON i.id=s.item_id WHERE s.id=? AND i.order_id=?').get(patch.row_id,orderId);
      if(!target) bad('颜色尺码明细不属于当前订单');
      const field=type==='qty'?'qty':'usd_price',value=Number(patch[field]);
      if(patch[field]==null || patch[field]==='' || !Number.isFinite(value) || value<0 || (field==='qty' && value<=0)) bad('变更数量必须大于0，单价必须为非负数');
      next={row_id:target.id,[field]:value};
    } else if(['craft','material'].includes(type)) {
      const table=type==='craft'?'order_crafts':'order_materials';
      target=db.prepare(`SELECT * FROM ${table} WHERE id=? AND order_id=?`).get(patch.row_id,orderId);
      if(!target) bad('工艺或物料明细不属于当前订单');
      next={row_id:target.id};
      if(type==='material' && patch.material_id) {
        const master=db.prepare("SELECT * FROM materials WHERE id=? AND status='active'").get(patch.material_id);
        if(!master || master.type!==target.type)bad('替换物料必须来自同类型的启用物料档案');
        Object.assign(next,{material_id:master.id,name:master.name,unit:master.unit || '',spec:master.spec || '',supplier:master.supplier || '',ingredient:master.ingredient || ''});
      }
      const fields=type==='craft'?['instruction','remark']:['ingredient','mat_color','remark'];
      for(const key of fields) if(patch[key]!==undefined){if(typeof patch[key]!=='string'||patch[key].length>4000)bad('变更文本格式无效或过长');next[key]=patch[key].trim();}
      if(Object.keys(next).length===1)bad('至少填写一项可应用的变更字段');
    } else bad('不支持的变更类型');
  }
  const changed=type==='delivery' ? next.new_date!==(target.latest_delivery_date || target.delivery_date) : Object.entries(next).some(([k,v])=>k!=='row_id' && (target[k]??'')!==v);
  if(!changed)bad('变更后内容与当前数据一致，无需发起变更');
  return {target,next,hash:digest(target)};
}

/** 独立交期确认与商城共用同一回写，拒绝重复确认和关联变更绕过签收。 */
function confirmDelivery(id,accepted,operator,comment) {
  const row=db.prepare('SELECT * FROM delivery_changes WHERE id=?').get(id);
  if(!row || row.status!=='pending')bad('交期记录不存在或已处理',409);
  if(row.source_change_id)bad('请从关联订单变更完成确认及工位签收',409);
  preparePatch(row.order_id,'delivery',{new_date:row.new_date});
  db.exec('SAVEPOINT delivery_confirmation');
  try {
    const t=now();
    const changed=db.prepare("UPDATE delivery_changes SET status=?,customer_confirmed_by=?,customer_confirmed_at=?,customer_comment=?,updated_at=? WHERE id=? AND status='pending'")
      .run(accepted?'confirmed':'rejected',operator,t,comment || null,t,id);
    if(!changed.changes)bad('交期记录已更新',409);
    if(accepted && row.kind==='etd')db.prepare('UPDATE orders SET latest_delivery_date=?,updated_at=? WHERE id=?').run(row.new_date,t,row.order_id);
    db.exec('RELEASE delivery_confirmation');
  }catch(e){db.exec('ROLLBACK TO delivery_confirmation');db.exec('RELEASE delivery_confirmation');throw e;}
}
function applyChange(row,user) {
  const saved=parse(row.patch_json), current=preparePatch(row.order_id,row.type,saved.next);
  if(saved.hash!==current.hash || digest(saved.next)!==digest(current.next))bad('变更目标或引用档案已经更新，需重新评估审批，未应用任何修改',409);
  const p=current.next,t=now(),o=db.prepare('SELECT * FROM orders WHERE id=?').get(row.order_id);
  if(row.type==='delivery') {
    db.prepare('UPDATE orders SET latest_delivery_date=?,updated_at=? WHERE id=?').run(p.new_date,t,o.id);
    db.prepare("UPDATE delivery_changes SET status='confirmed',customer_confirmed_by=?,customer_confirmed_at=?,updated_at=? WHERE source_change_id=?")
      .run(row.customer_confirmed_by,row.customer_confirmed_at,t,row.id);
  } else if(['qty','price'].includes(row.type)) {
    const qty=p.qty??current.target.qty,usd=p.usd_price??current.target.usd_price,round=v=>Math.round(v*100)/100;
    db.prepare('UPDATE order_item_sizes SET qty=?,usd_price=?,cny_price=?,amount_usd=?,amount_cny=? WHERE id=?')
      .run(qty,usd,round(usd*o.rate),round(qty*usd),round(round(qty*usd)*o.rate),p.row_id);
    const a=db.prepare('SELECT SUM(qty) q,SUM(amount_usd) usd,SUM(amount_cny) cny FROM order_item_sizes WHERE item_id=?').get(current.target.item_id);
    db.prepare('UPDATE order_items SET qty=?,amount_usd=?,amount_cny=? WHERE id=?').run(a.q,a.usd,a.cny,current.target.item_id);
    const total=db.prepare('SELECT SUM(amount_usd) usd,SUM(amount_cny) cny FROM order_items WHERE order_id=?').get(o.id);
    db.prepare('UPDATE orders SET total_usd=?,total_amount=?,updated_at=? WHERE id=?').run(round(total.usd),round(total.cny),t,o.id);
    // 旧成本审核基于旧数量/价格，必须重新测算审核，不能沿用通过结果。
    db.prepare("UPDATE cost_sheets SET status='draft',updated_at=? WHERE order_id=?").run(t,o.id);
    db.prepare("UPDATE approval_tasks SET status='cancelled' WHERE instance_id IN (SELECT id FROM approval_instances WHERE target_type='cost' AND target_id=?) AND status='pending'").run(o.id);
    db.prepare("UPDATE approval_instances SET status='cancelled' WHERE target_type='cost' AND target_id=? AND status IN ('pending','approved')").run(o.id);
    for(const material of db.prepare('SELECT id FROM order_materials WHERE order_id=?').all(o.id))require('./orderMaterialColors').recalc(material.id);
  } else {
    const table=row.type==='craft'?'order_crafts':'order_materials',keys=Object.keys(p).filter(k=>k!=='row_id');
    db.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')} WHERE id=? AND order_id=?`).run(...keys.map(k=>p[k]),p.row_id,o.id);
    db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(t,o.id);
  }
  db.prepare('INSERT INTO order_logs(order_id,from_status,to_status,operator,note,created_at) VALUES(?,?,?,?,?,?)')
    .run(o.id,o.status,o.status,user.username,`客户变更 ${row.change_no} 已应用：${JSON.stringify(p)}`,t);
  return JSON.stringify({before:current.target,after:p,operator:user.username,applied_at:t});
}

/** 统一审批最后一级通过才推送客户；此处不应用订单变更。 */
function approveChange(id,user,t) {
  const row=db.prepare('SELECT * FROM order_changes WHERE id=?').get(id);
  if(!row || row.status!=='assessing')bad('变更单状态已改变',409);
  const saved=parse(row.patch_json);const current=preparePatch(row.order_id,row.type,saved.next);
  if(saved.hash!==current.hash || digest(saved.next)!==digest(current.next))bad('目标或引用档案已变化，请驳回后重新评估',409);
  db.prepare("UPDATE order_changes SET status='pending_customer',internal_approved_by=?,internal_approved_at=?,row_version=row_version+1,updated_at=? WHERE id=?")
    .run(user.username,t,t,id);
  if(row.type==='delivery' && !db.prepare('SELECT id FROM delivery_changes WHERE source_change_id=?').get(id)) {
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(row.order_id);
    db.prepare("INSERT INTO delivery_changes(order_id,promised_date,new_date,kind,reason,source,status,created_by,created_at,updated_at,source_change_id) VALUES(?,?,?,'etd',?,'manual','pending',?,?,?,?)")
      .run(order.id,order.delivery_date,current.next.new_date,row.title,user.username,t,t,id);
  }
  const order=db.prepare('SELECT customer_id,order_no FROM orders WHERE id=?').get(row.order_id);
  if(order.customer_id)require('./mall').pushMessage({customerId:order.customer_id,type:'order',title:'订单变更待确认：'+row.change_no,body:`订单 ${order.order_no}：${row.title}，请查看变更明细后确认。`,refType:'order_change',refId:row.id});
}
module.exports={sourceSnapshot,latestSeals,sealGate,checkSealContent,preparePatch,applyChange,approveChange,digest,linkDevelopment,linkPreOrder,confirmDelivery};
