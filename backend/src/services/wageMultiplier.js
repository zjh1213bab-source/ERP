/** 颜色批量工价：设置、扫码报价、报工快照与月度计件共用唯一计算入口。 */
const {db,now}=require('../db');
const KEY='piece_wage_multipliers_v1';
const PROCESS_CATEGORIES={sewing:'车缝',print:'印花',embroidery:'绣花',wash:'洗水',finish:'后整',pack:'包装',other:'其他'};
// 内置生产节点按稳定 code 归类，改名不改变倍率参与范围。
const NODE_CATEGORIES={sew:'sewing',buttonhole:'sewing',print:'print',embroider:'embroidery',wash:'wash',iron:'finish',inspect:'finish',pack:'pack',prep:'other',layout:'other',cut:'other',instock:'other',ship:'other'};
const allScope=()=>({mode:'all',categories:[],craft_type_ids:[],node_codes:[]});
const DEFAULT_TIERS=[{min:1,max:1,multiplier:3},{min:2,max:5,multiplier:2.16},{min:6,max:10,multiplier:1.8},{min:11,max:19,multiplier:1.44},{min:20,max:null,multiplier:1.2}];
const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const roundUnit=value=>Math.round((Number(value)+Number.EPSILON)*1e6)/1e6;
function read(){
 const row=db.prepare('SELECT value FROM app_config WHERE key=?').get(KEY);
 const config=row?JSON.parse(row.value):{revision:0,enabled:true,tiers:DEFAULT_TIERS.map(t=>({...t})),history:[]};
 // 兼容已上线设置，升级时不擅自减少员工工价；管理员保存选择范围后生效。
 return {...config,process_scope:config.process_scope||allScope()};
}
function processCatalog(){
 const {BUILTIN_CODES}=require('./nodeFlow');
 return {categories:Object.entries(PROCESS_CATEGORIES).map(([code,label])=>({code,label})),nodes:Object.entries(BUILTIN_CODES).map(([code,name])=>({code,name,category:NODE_CATEGORIES[code]})),craft_types:db.prepare('SELECT id,name,category,status FROM craft_types ORDER BY category,name,id').all()};
}
function validateScope(input,current){
 if(input===undefined)return current.process_scope;
 if(!input||!['all','selected'].includes(input.mode))bad('请选择全部参与或仅选中工序参与');
 for(const key of ['categories','craft_type_ids','node_codes'])if(!Array.isArray(input[key]))bad('工序参与范围格式无效');
 if(input.categories.length>7||input.node_codes.length>13||input.craft_type_ids.length>3000)bad('工序参与范围超出限制');
 if(input.categories.some(c=>!Object.hasOwn(PROCESS_CATEGORIES,c))||input.node_codes.some(c=>!Object.hasOwn(NODE_CATEGORIES,c)))bad('包含未知工序类别或生产工序');
 for(const id of input.craft_type_ids){
  if(!Number.isSafeInteger(id)||id<=0)bad('工序档案编号无效');
  const row=db.prepare('SELECT status FROM craft_types WHERE id=?').get(id);if(!row)bad('选择的工序档案不存在，请刷新后选择');
  if(row.status!=='active'&&!current.process_scope.craft_type_ids.includes(id))bad('不能新增选择已停用工序');
 }
 return {mode:input.mode,categories:[...new Set(input.categories)],craft_type_ids:[...new Set(input.craft_type_ids)],node_codes:[...new Set(input.node_codes)]};
}
/** 唯一参与判定；客户端的类别/勾选状态不作为计价依据。 */
function participation(node,config){
 const matches=db.prepare('SELECT id,category FROM craft_types WHERE TRIM(name)=? COLLATE NOCASE').all(String(node.name||'').trim());
 const unique=matches.length===1&&(!NODE_CATEGORIES[node.code]||matches[0].category===NODE_CATEGORIES[node.code])?matches[0]:null;
 const category=NODE_CATEGORIES[node.code]||unique?.category||null;
 const scope=config.process_scope;
 const selected=scope.mode==='all'||scope.node_codes.includes(node.code)||!!category&&scope.categories.includes(category)||!!unique&&scope.craft_type_ids.includes(unique.id);
 const participates=config.enabled&&selected;
 return {participates,scope_mode:scope.mode,process_category:category,process_category_label:PROCESS_CATEGORIES[category]||'未归类',matched_craft_type_id:unique?.id||null,
 participation_reason:!config.enabled?'倍率已关闭，按基础工价':selected?'已参与工价倍率':!category&&!unique?'工序未明确归类，按基础工价':'此工序未勾选参与，按基础工价'};
}
function view(){const {history,...config}=read();return {...config,process_catalog:processCatalog(),history:(history||[]).slice(-30).reverse().map(h=>({revision:h.revision,operator:h.operator,time:h.time}))};}
function save(body,user){
 if(!body||!Number.isSafeInteger(body.revision)||typeof body.enabled!=='boolean')bad('缺少有效版本或启用状态');
 if(!Array.isArray(body.tiers)||body.tiers.length<1||body.tiers.length>50)bad('倍率档位必须为1至50档');
 let nextMin=1;const tiers=body.tiers.map((t,i)=>{
  if(!t||!Number.isSafeInteger(t.min)||t.min!==nextMin||t.min<1)bad('档位必须从1件开始连续排列，不能重叠或遗漏');
  if(i===body.tiers.length-1){if(t.max!==null)bad('最后一档上限必须为空，表示以上');}
  else if(!Number.isSafeInteger(t.max)||t.max<t.min||t.max>1e9)bad('档位上限必须为不小于下限的整数');
  if(typeof t.multiplier!=='number'||!Number.isFinite(t.multiplier)||t.multiplier<=0||t.multiplier>100||roundUnit(t.multiplier)!==t.multiplier)bad('倍率需为大于0且不超过100的数字，最多6位小数');
  nextMin=t.max===null?null:t.max+1;return {min:t.min,max:t.max,multiplier:t.multiplier};
 });
 const current=read(),process_scope=validateScope(body.process_scope,current);if(body.revision!==current.revision)bad('工价倍率已更新，请刷新后重试',409);
 const time=now(),revision=current.revision+1;
 const next={revision,enabled:body.enabled,tiers,process_scope,updated_at:time,updated_by:user.username,history:[...(current.history||[]),{revision,operator:user.username,time,before:{enabled:current.enabled,tiers:current.tiers,process_scope:current.process_scope},after:{enabled:body.enabled,tiers,process_scope}}]};
 db.exec('BEGIN IMMEDIATE');try{if(read().revision!==current.revision)bad('工价倍率已更新，请刷新后重试',409);db.prepare('INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(KEY,JSON.stringify(next),time);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 console.info('[wage-multiplier]',{revision,operator:user.username,enabled:next.enabled});return view();
}
/** 同款同色跨尺码、跨明细合计；缺款号时只归到当前款式行，绝不猜两行是同一款。 */
function variants(orderId){
 const rows=db.prepare(`SELECT i.id AS item_id,i.style_no,i.sku,i.product_name,TRIM(COALESCE(s.color,i.color,'')) AS color,
 SUM(CASE WHEN s.id IS NULL THEN i.qty ELSE s.qty END) AS color_qty
 FROM order_items i LEFT JOIN order_item_sizes s ON s.item_id=i.id WHERE i.order_id=?
 GROUP BY i.id,TRIM(COALESCE(s.color,i.color,'')) ORDER BY i.id,color`).all(orderId);
 const grouped=new Map();
 for(const r of rows){if(!(Number(r.color_qty)>0))continue;const style=String(r.style_no||r.sku||'').trim(),styleKey=style||'item:'+r.item_id,key=JSON.stringify([styleKey,r.color]);const old=grouped.get(key);if(old){old.color_qty+=Number(r.color_qty);old.item_ids.push(r.item_id);}else grouped.set(key,{item_id:r.item_id,item_ids:[r.item_id],style_no:style,style_key:styleKey,product_name:r.product_name,color:r.color,color_qty:Number(r.color_qty)});}
 return [...grouped.values()];
}
function quote(orderId,node,input={}){
 const config=read(),choices=variants(orderId);let candidates=choices;
 const itemId=input.item_id===undefined||input.item_id===null||input.item_id===''?null:Number(input.item_id);
 if(itemId!==null&&(!Number.isSafeInteger(itemId)||itemId<=0))bad('款式参数无效');
 if(input.color!==undefined&&(typeof input.color!=='string'||input.color.length>255))bad('颜色参数无效');
 if(itemId!==null)candidates=candidates.filter(r=>r.item_ids.includes(itemId));
 if(input.color!==undefined)candidates=candidates.filter(r=>r.color===input.color.trim());
 if(input.bundle_no){
  const bundle=db.prepare('SELECT b.color,c.style_no FROM cut_bundles b JOIN cut_orders c ON c.id=b.cut_order_id WHERE c.order_id=? AND b.bundle_no=?').get(orderId,String(input.bundle_no));
  if(!bundle)bad('扎号不属于该订单');
  candidates=candidates.filter(r=>r.color===String(bundle.color||'').trim()&&(!bundle.style_no||r.style_no===String(bundle.style_no).trim()));
 }
 if(!candidates.length&&choices.length)bad('所选款式、颜色或扎号与订单不一致');
 if(candidates.length!==1)return {requires_selection:true,variants:choices,config_revision:config.revision,enabled:config.enabled,reason:choices.length?'请选择具体款式和颜色':'订单缺少有效的款色数量'};
 const context=candidates[0],qty=context.color_qty;
 if(!Number.isSafeInteger(qty)||qty<=0)bad('该颜色件数必须为正整数，请核对订单');
 const tier=config.tiers.find(t=>qty>=t.min&&(t.max===null||qty<=t.max));if(!tier)bad('件数未匹配到倍率档位，请检查系统设置');
 const processParticipation=participation(node,config);
 const multiplier=processParticipation.participates?tier.multiplier:1;
 const date=input.report_date||require('../utils/time').localDate(now());if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)bad('报工日期格式无效');
 const {rate,source}=require('./pieceWage').rateOf(context.style_no,node.name,date);
 if(rate&&(!Number.isFinite(Number(rate.unit_price))||Number(rate.unit_price)<0))bad('基础工价无效，请维护计件单价');
 return {requires_selection:false,variants:choices,...context,...processParticipation,config_revision:config.revision,enabled:config.enabled,tier:{...tier},multiplier,
 base_unit_price:rate?Number(rate.unit_price):null,unit_price:rate?roundUnit(Number(rate.unit_price)*multiplier):null,rate_id:rate?.id||null,rate_source:source,process_name:node.name,report_date:date};
}
function snapshot(orderId,node,input){
 const q=quote(orderId,node,input);
 if(input.wage_config_revision!==undefined&&input.wage_config_revision!==q.config_revision)bad('工价倍率已调整，请重新确认扫码工价',409);
 if(q.requires_selection){if(read().enabled)bad(q.reason+'，无法确定计件倍率');return null;}
 const {variants,requires_selection,...saved}=q;return {...saved,quoted_at:now()};
}
/** 历史无快照沿用旧计价；新报工锁定倍率，有基础价的报工同时锁定基础价。 */
function reportPrice(report,fallback){
 if(!report.wage_snapshot)return fallback;
 let saved;try{saved=JSON.parse(report.wage_snapshot);}catch{bad('报工工价快照损坏，请核对报工记录');}
 const base=saved.base_unit_price===null?fallback.rate?.unit_price:saved.base_unit_price;
 if(base===undefined||base===null)return fallback;
 return {rate:{...(fallback.rate||{}),id:saved.rate_id||fallback.rate?.id||null,unit_price:roundUnit(Number(base)*saved.multiplier)},source:saved.rate_source||fallback.source,wage_snapshot:{...saved,base_unit_price:Number(base),unit_price:roundUnit(Number(base)*saved.multiplier)}};
}
module.exports={read,view,save,variants,quote,snapshot,reportPrice,roundUnit,participation};
