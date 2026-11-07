/** npm run smoke 的安全入口：独占临时目录 + 独占随机端口 + 被测进程 PID 校验。 */
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),{spawn}=require('child_process');
process.chdir(path.resolve(__dirname,'..'));
require('dotenv').config();
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-full-smoke-'));fs.writeFileSync(path.join(folder,'.smoke-owned'),'Created by run-smoke-isolated.js');
Object.assign(process.env,{DB_PATH:path.join(folder,'__SMOKE.db'),ERP_SCHEDULER:'0',SMOKE_ISOLATED:'1',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'admin123456',ADMIN_USER:'admin',ADMIN_PASS:'admin123456',MALL_USER:'abc001',MALL_PASS:'abc123456',NODE_ENV:'development',JWT_SECRET:'__SMOKE_ISOLATED_KEY_NOT_FOR_PRODUCTION',CORS_ORIGIN:'*',SINGLE_COMPANY:process.argv.includes('--multi')?'0':'1'});
// 外部服务全部关闭，冒烟不应请求真实钉钉、模型或邮件网关。
for(const k of Object.keys(process.env))if(/^(DINGTALK_|SMTP_|OPENAI_|AI_API_)/.test(k))process.env[k]='';
let server,test;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const [signal,code]of [['SIGINT',130],['SIGTERM',143]])process.on(signal,()=>{test?.kill();server?.kill();process.exit(code);});
(async()=>{
 const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));});});
 process.env.PORT=String(port);process.env.BASE='http://127.0.0.1:'+port;
 require('./smoke-fixtures')();
 const log=fs.openSync(path.join(folder,'server.log'),'w');server=spawn(process.execPath,['src/server.js'],{env:process.env,windowsHide:true,stdio:['ignore',log,log]});
 let health;for(let i=0;i<150;i++){await sleep(100);if(server.exitCode!==null)throw Error('临时服务启动失败，见 '+folder);try{health=await(await fetch(process.env.BASE+'/api/health')).json();if(health.ok)break;}catch{}}
 if(health?.pid!==server.pid)throw Error('被测端口不属于当前临时服务');process.env.SMOKE_EXPECTED_PID=String(server.pid);
 console.log(JSON.stringify({folder,base:process.env.BASE,single_company:process.env.SINGLE_COMPANY,pid:server.pid}));
 test=spawn(process.execPath,['scripts/smoke-test.js'],{env:process.env,windowsHide:true,stdio:'inherit'});const code=await new Promise((resolve,reject)=>{test.on('error',reject);test.on('exit',code=>resolve(code===null?1:code));});process.exitCode=code;
 fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify({exit_code:code,pid:server.pid,mode:process.env.SINGLE_COMPANY},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{server?.kill();});
