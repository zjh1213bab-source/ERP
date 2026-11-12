/** 全站节日外观：只保存本站图片与有限样式参数，绝不接收 CSS/HTML。 */
const fs=require('fs'),path=require('path');
const {db,now}=require('../db');
const DEFAULTS={enabled:false,image_url:null,workspace_transparency:65,opacity:0.18,blur:0,position:'center',label:'',revision:0,updated_at:null,updated_by:null};
function readAppearance(){const row=db.prepare("SELECT value FROM app_config WHERE key='ui_appearance'").get();if(!row)return {...DEFAULTS};try{return {...DEFAULTS,...JSON.parse(row.value)};}catch{return {...DEFAULTS};}}
function saveAppearance(body,user){
 const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
 if(!body || typeof body!=='object' || Array.isArray(body))bad('外观设置格式无效');
 const current=readAppearance();
 if(!Number.isInteger(body.revision) || body.revision!==current.revision)bad('外观已被其他管理员更新，请重新载入后再保存',409);
 if(typeof body.enabled!=='boolean')bad('请明确是否启用背景');
 const image=body.image_url || null;
 if(image && (typeof image!=='string' || !/^\/uploads\/[a-f0-9]{20}\.(png|jpg|jpeg|webp|gif)$/i.test(image)))bad('请使用系统上传的背景图片');
 if(image && !fs.existsSync(path.resolve(__dirname,'../../data',image.slice(1))))bad('背景图片不存在，请重新上传');
 if(body.enabled && !image)bad('启用前请先上传背景图片');
 const opacity=Number(body.opacity),blur=Number(body.blur),position=body.position || 'center',label=String(body.label || '').trim();
 if(body.opacity==null || !Number.isFinite(opacity) || opacity<0.05 || opacity>0.5)bad('背景显示强度应在5%至50%之间');
 if(body.blur==null || !Number.isFinite(blur) || blur<0 || blur>12)bad('背景虚化应在0至12之间');
 if(!['center','top','bottom'].includes(position) || label.length>40)bad('图片位置或节日名称无效');
 const transparency=body.workspace_transparency===undefined?current.workspace_transparency:body.workspace_transparency;
 if(!Number.isInteger(transparency)||transparency<0||transparency>100)bad('工作区透明度应在0%至100%之间');
 const next={workspace_transparency:transparency,enabled:body.enabled,image_url:image,opacity,blur,position,label,revision:current.revision+1,updated_at:now(),updated_by:user.username};
 db.exec('BEGIN IMMEDIATE');
 try{
  const locked=readAppearance();if(locked.revision!==current.revision)bad('外观设置已更新，请重新载入',409);
  db.prepare("INSERT INTO app_config(key,value,updated_at) VALUES('ui_appearance',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(next),next.updated_at);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 console.info('[appearance] published',{revision:next.revision,enabled:next.enabled,operator:user.username});
 return next;
}
module.exports={readAppearance,saveAppearance};
