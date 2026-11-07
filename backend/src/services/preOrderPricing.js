/** 预单尺码报价：金额用分计算，忽略客户端金额，调用方须在事务前校验。 */
const bad=m=>{throw Object.assign(new Error(m),{status:400});};
function normalize(rows){
 if(rows==null)return [];if(!Array.isArray(rows))bad('尺码报价须为数组');const seen=new Set();
 return rows.map(r=>{if(!r||typeof r!=='object')bad('尺码报价格式错误');const size=typeof r.size==='string'?r.size.trim():'';const color=typeof r.color==='string'?r.color.trim():'';if(!size||size.length>50||color.length>100)bad('尺码必填且最多50字，颜色最多100字');if(r.customer_size!=null&&(typeof r.customer_size!=='string'||r.customer_size.length>50))bad('客户尺码最多50字');const key=color+'\0'+size;if(seen.has(key))bad('同款颜色尺码重复');seen.add(key);
 if(!['number','string'].includes(typeof r.qty)||!/^\d+$/.test(String(r.qty))||!Number.isSafeInteger(Number(r.qty))||Number(r.qty)>1000000)bad('尺码数量须为0至1000000整数');
 if(!['number','string'].includes(typeof r.unit_price)||!/^\d+(\.\d{1,2})?$/.test(String(r.unit_price))||Number(r.unit_price)>10000000)bad('尺码单价须为非负数，最多两位小数');
 const qty=Number(r.qty),unit_price=Number(r.unit_price),cents=qty*Math.round(unit_price*100);if(!Number.isSafeInteger(cents))bad('尺码金额超出范围');return {color,size,qty,unit_price,amount:cents/100,...(r.customer_size?{customer_size:r.customer_size.trim()}:{})};});
}
function read(value){try{return normalize(JSON.parse(value||'[]'));}catch{return [];}}
const amount=rows=>rows.reduce((n,r)=>n+Math.round(r.amount*100),0)/100;
module.exports={normalize,read,amount};
