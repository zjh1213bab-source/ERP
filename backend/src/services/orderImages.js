/** 款式图片共用校验：仅接受本站上传的图片，防止不可信URL进入订单。 */
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
function imageUrl(value) {
 if(value==null || value==='')return null;
 if(typeof value!=='string'||value!==value.trim()||!/^\/uploads\/(?:[a-f0-9]{20}|yc198-[a-f0-9]{12}-[a-f0-9]{16})\.(png|jpg|jpeg|webp|gif)$/i.test(value))bad('图片地址无效，请重新上传');
 return value;
}
function styleImages(body) {
 if(!body || typeof body!=='object' || Array.isArray(body))bad('款式明细格式无效');
 let detail=body.detail_images ?? [];
 if(!Array.isArray(detail)||detail.length>12)bad('每款最多上传12张细节图');
 return {effect_image_url:imageUrl(body.effect_image_url),detail_images:detail.filter(Boolean).map(imageUrl)};
}
function readImages(value){try{const v=JSON.parse(value||'[]');return Array.isArray(v)?v:[];}catch{return [];}}
module.exports={imageUrl,styleImages,readImages};
