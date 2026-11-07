/** 独立空库与临时端口：验证图片编辑、重算、转单不会丢失，禁止连接现场库。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-quote-'));
process.env.DB_PATH=path.join(directory,'__SMOKE-quote.db');process.env.PORT=String(34000+Math.floor(Math.random()*10000));process.env.ERP_SCHEDULER='0';
require('dotenv').config();const {db,now}=require('../src/db');let server,token,checks=0;
const check=(condition,message)=>{assert.ok(condition,message);checks++;};
async function request(route,body,status=200,method){
 const r=await fetch(`http://127.0.0.1:${process.env.PORT}`+route,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});
 const data=await r.json();assert.equal(r.status,status,route+': '+JSON.stringify(data));checks++;return data.data ?? data;
}
(async()=>{
 server=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{if((await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`)).ok){ready=true;break;}}catch{}}
 check(ready,'Isolated server starts');token=(await request('/api/auth/login',{username:'admin',password:process.env.ADMIN_PASSWORD || 'admin123456'})).token;
 const photo='/uploads/0123456789abcdef0123.png',photo2='/uploads/1123456789abcdef0123.jpg';
 const item={product_name:'__SMOKE 款式',qty:10,price_usd:2,color:'蓝',image_url:photo};
 const meta=await request('/api/quotations/meta');check(meta.approval.internal_required===false && meta.approval.description.includes('审批中心不处理'),'Existing approval policy is explicit');
 await request('/api/quotations',{items:[{...item,image_url:'https://invalid.example/file.html'}]},400);
 await request('/api/quotations',{items:[{...item,qty:'bad'}]},400);
 await request('/api/quotations',{items:[{...item,price_usd:-1}]},400);
 let quote=await request('/api/quotations',{items:[item]});check(quote.items[0].image_url===photo,'Photo persists on create');
 const reopened=await request('/api/quotations/'+quote.id);check(reopened.items[0].image_url===photo,'Photo round-trips in detail');
 quote=await request('/api/quotations/'+quote.id,{items:[{...item,image_url:photo2}],remark:'__SMOKE 编辑'},200,'PUT');check(quote.items[0].image_url===photo2,'Edited photo persists');
 quote=await request(`/api/quotations/${quote.id}/reprice`,{});check(quote.items[0].image_url===photo2 && quote.items[0].price_usd===2,'Reprice preserves manual line photo and price');
 await request(`/api/quotations/${quote.id}/status`,{status:'accepted'},400);
 await request(`/api/quotations/${quote.id}/status`,{status:'sent'});
 await request(`/api/quotations/${quote.id}/status`,{status:'accepted'});
 const converted=await request(`/api/quotations/${quote.id}/convert`,{order_no:'__SMOKE-QUOTE-ORDER'});
 const order=await request('/api/orders/'+converted.order_id);check(order.image_url===photo2 && order.items[0].effect_image_url===photo2,'Quote photo carried into order and style');
 await request(`/api/quotations/${quote.id}/convert`,{},400);
 // Product-based tier repricing also retains the independently uploaded quote photo.
 const t=now();const pid=Number(db.prepare("INSERT INTO products(name,price,status,created_at,updated_at) VALUES('__SMOKE 产品',3,'active',?,?)").run(t,t).lastInsertRowid);
 const productQuote=await request('/api/quotations',{items:[{product_id:pid,qty:5,image_url:photo}]});
 const repriced=await request(`/api/quotations/${productQuote.id}/reprice`,{});check(repriced.items[0].image_url===photo && repriced.items[0].price_usd===3,'Product reprice retains quote image');
 check(!db.prepare('SELECT image_url FROM products WHERE id=?').get(pid).image_url,'Quote upload does not alter product master');
 console.log(`PASS: ${checks} quotation image assertions, isolated database only.`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
 if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();fs.rmSync(directory,{recursive:true,force:true});
});
