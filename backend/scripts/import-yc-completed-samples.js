/** 从衣创样衣卡片的本地 JSON 导入；仅导入来源确认的完成事实，不生成业务订单或虚构工序历史。 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
 const file=process.argv[2];if(!file)throw Error('需要提供样衣卡片 JSON 文件');
 const rows=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')).map(({lines,img})=>{
  if(!Array.isArray(lines)||!lines.includes('打版完成'))throw Error('样衣未确认打版完成');
  const field=k=>lines.find(s=>s.startsWith(k+'：'))?.slice(k.length+1).trim()||'';
  const style=field('款号'),url=new URL(img);if(!style||url.protocol!=='https:'||url.hostname!=='yc198erp.oss-cn-shenzhen.aliyuncs.com')throw Error('款号或图片来源无效');
  return {style,url,colors:field('颜色'),sizes:field('尺码'),customer:field('客户'),date:field('创建时间'),note:field('备注')};
 });
 if(rows.length!==50||new Set(rows.map(r=>r.style)).size!==50)throw Error('需要 50 个不同款号');
 const cfg=require('../src/config'),DB=require('better-sqlite3'),ro=new DB(cfg.dbPath,{readonly:true,fileMustExist:true});
 const backup=cfg.dbPath+'.before-yc50-'+Date.now()+'.bak';await ro.backup(backup);ro.close();
 const {db,now}=require('../src/db'),patterns=require('../src/routes/patternFlows'),archives=require('../src/services/sampleArchive'),styles=require('../src/services/preOrderStyles');
 const admin=db.prepare("select id,role,username,company_id from users where username='admin' and active=1").get();
 if(!admin||!require('../src/access/companyScope').isSingle())throw Error('需要单公司测试库和有效管理员');
 const dir=path.join(path.dirname(cfg.dbPath),'uploads','yc-samples');fs.mkdirSync(dir,{recursive:true});
 let next=0;await Promise.all(Array.from({length:5},async()=>{while(next<rows.length){
  const r=rows[next++],resp=await fetch(r.url,{signal:AbortSignal.timeout(45000),redirect:'error'});if(!resp.ok)throw Error('款图下载失败 '+r.style);
  const mime=(resp.headers.get('content-type')||'').split(';')[0],ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mime];if(!ext)throw Error('非预期款图类型 '+mime);
  const buf=Buffer.from(await resp.arrayBuffer());if(!buf.length||buf.length>8e6)throw Error('图片大小异常');
  const name=crypto.createHash('sha256').update(buf).digest('hex')+'.'+ext;fs.writeFileSync(path.join(dir,name),buf);r.img='/uploads/yc-samples/'+name;
 }}));
 db.exec('BEGIN IMMEDIATE');try{for(const r of rows){
 const key='yc198:sample:'+r.style,existing=db.prepare('select remark from sample_archives where style_no=?').get(r.style);
 if(existing){if(!existing.remark?.startsWith(key+'\n'))throw Error('本地款号冲突 '+r.style);continue;}
 const stamp=now(),remark=key+'\n来源显示打版完成；未导入历史阶段记录。';
 const id=Number(db.prepare("insert into tech_packs(order_id,product_name,customer_style_no,pattern_no,version,stage,status,colors,size_range,image_url,remark,created_by,created_at,updated_at) values(0,?,?,?,'V1','confirmed','confirmed',?,?,?,?,?,?,?)").run(r.style,r.style,r.style,r.colors,r.sizes,r.img,remark,admin.id,stamp,stamp).lastInsertRowid);
 const flow=patterns.ensureFlow(id,admin.id);
 db.prepare("update pattern_flows set status='done',current_stage='done',finished_at=null where id=?").run(flow.id);
 const a=archives.archiveFromFlow({...flow,status:'done'},admin.username,{remark}),snap=JSON.parse(a.snapshot);
 snap.source={system:'衣创',url:'https://kr.yc198.com',source_key:key,imported_at:stamp,historical_details_imported:false,thumbnail_only:true,fields:{style:r.style,status:'打版完成',colors:r.colors,sizes:r.sizes,source_created:r.date,note:r.note}};
 db.prepare('update sample_archives set snapshot=?,customer=? where id=?').run(JSON.stringify(snap),r.customer,a.id);
 }
 const visible=new Set(styles.availableDistinct({...admin,sub:admin.id}).map(r=>r.style_no));if(!rows.every(r=>visible.has(r.style)))throw Error('预下单可选样衣核对失败');
 db.exec('COMMIT');console.log('50 款已提交；备份：'+backup);
 }catch(e){db.exec('ROLLBACK');throw e;}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
