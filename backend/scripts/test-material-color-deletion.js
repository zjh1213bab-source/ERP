/** 删除最后一项配色必须变为零用量，不能回退为全部颜色。仅使用临时库。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
process.env.DB_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'erp-color-delete-')),'__SMOKE.db');process.env.ERP_SCHEDULER='0';
const {db,now}=require('../src/db'),{recalc}=require('../src/services/orderMaterialColors');
const t=now();let checks=0;const check=v=>{assert.ok(v);checks++;};
try{
 const order=Number(db.prepare("INSERT INTO orders(order_no,status,created_at,updated_at) VALUES('__SMOKE-color-delete','draft',?,?)").run(t,t).lastInsertRowid);
 const columns=db.prepare('PRAGMA table_info(order_items)').all();
 const data={order_id:order,product_name:'__SMOKE款',qty:4};
 for(const c of columns)if(c.notnull&&c.dflt_value==null&&!['id'].includes(c.name)&&data[c.name]===undefined)data[c.name]=c.type==='TEXT'?'__SMOKE':0;
 const keys=Object.keys(data),item=Number(db.prepare('INSERT INTO order_items('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>data[k])).lastInsertRowid);
 for(const color of ['红','蓝'])db.prepare('INSERT INTO order_item_sizes(item_id,color,size,qty) VALUES(?,?,?,2)').run(item,color,'S');
 const mid=Number(db.prepare("INSERT INTO order_materials(order_id,item_id,name,one_use,price,all_colors,entry_json,created_at) VALUES(?,?,'__SMOKE物料',0.4,3,0,?,?)").run(order,item,JSON.stringify({version:1,colors_configured:true,colors:[],air_gap:100}),t).lastInsertRowid);
 check(recalc(mid).total_use===0);check(recalc(mid).amount===0);
 db.prepare('UPDATE order_materials SET entry_json=? WHERE id=?').run(JSON.stringify({version:1,colors_configured:false,colors:[],air_gap:100}),mid);check(recalc(mid).amount===4.8);
 db.prepare('INSERT INTO order_material_colors(order_material_id,colorway,created_at) VALUES(?,?,?)').run(mid,'红',t);
 db.prepare('UPDATE order_materials SET entry_json=? WHERE id=?').run(JSON.stringify({version:1,colors_configured:true,colors:[{colorway:'红',price:3}],air_gap:100}),mid);check(recalc(mid).amount===2.4);
 db.prepare('DELETE FROM order_material_colors WHERE order_material_id=?').run(mid);db.prepare('UPDATE order_materials SET entry_json=? WHERE id=?').run(JSON.stringify({version:1,colors_configured:true,colors:[],air_gap:100}),mid);check(recalc(mid).amount===0);
 check(db.prepare('SELECT SUM(qty) n FROM order_item_sizes WHERE item_id=?').get(item).n===4);
 console.log(JSON.stringify({checks,failed:0}));
}finally{db.close();}
