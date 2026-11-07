/** 安全检查入口：新建空库、专用端口，绝不把冒烟指向业务实例。 */
const fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
process.chdir(path.resolve(__dirname,'..'));
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-entry-checks-'));process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';process.env.PORT='39785';process.env.ADMIN_USERNAME='admin';process.env.ADMIN_PASSWORD='admin123456';process.env.ADMIN_USER='admin';process.env.ADMIN_PASS='admin123456';process.env.BASE='http://127.0.0.1:39785';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),logs=path.resolve('../logs');fs.mkdirSync(logs,{recursive:true});let server;
async function run(label,args){const fd=fs.openSync(path.join(logs,'sales-entry-'+label+'.log'),'w');const child=spawn(process.execPath,args,{env:process.env,windowsHide:true,stdio:['ignore',fd,fd]});const code=await new Promise(r=>child.on('exit',r));fs.closeSync(fd);console.log(label+': exit '+code);return code;}
(async()=>{
 server=spawn(process.execPath,['src/server.js'],{env:process.env,windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(process.env.BASE+'/api/health')).ok)break;}catch{}}
 const schema=await run('schema',['-e',`const M=require('module'),original=M._load;M._load=function(id,...a){if(id==='better-sqlite3')return class extends require('node:sqlite').DatabaseSync{constructor(f,o){super(f,{readOnly:!!o?.readonly})}};return original.call(this,id,...a)};process.argv.push('--db',process.env.DB_PATH);require('./scripts/check-schema-complete')`]);
 const data=await run('data',['scripts/audit-demo-data.js','--verify']);const pages=await run('pages',['scripts/sweep-pages.js','/orders,/orders?new=1,/materials']);
 const smoke=await run('smoke',['scripts/run-smoke-isolated.js']);console.log(JSON.stringify({folder,schema,data,pages,smoke}));if(schema||data||pages||smoke)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server?.kill());
