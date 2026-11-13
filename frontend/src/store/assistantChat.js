/** 当前登录会话内共享对话，不把订单/工资等查询内容写入浏览器持久存储。 */
import { reactive, computed, watch } from 'vue';
import { auth } from './auth';
import { api } from '../api';
import { canVisit } from './navigation';
import { permState } from './permissions';
export const chat=reactive({messages:[],busy:false,opened:false});
let sequence=0,generation=0,controller;
const action=(label,topic)=>({label,topic});
const link=(text,to)=>({text,to});
export const services=computed(()=>[
 {id:'orders',title:'订单与报价',description:'查询订单进度，找到下单与报价入口',icon:'sales',to:'/orders'},
 {id:'development',title:'新品与打版',description:'寻样、打版、样衣归档与以图搜款',icon:'tech',to:'/pattern-board'},
 {id:'production',title:'生产与质量',description:'查看在产订单，办理逐款首件确认',icon:'prod',to:'/production'},
 {id:'inventory',title:'库存查询',description:'查询库存，进入入库与发货页面',icon:'stock',to:'/inventory'},
 {id:'self',title:'我的自助',description:'考勤、请假、工资条与个人申请',icon:'self',to:'/self'},
 {id:'collaboration',title:'日常协作',description:'异常日清、扫码查询与内部邮件',icon:'mail',to:'/mail'}
].filter(s=>canVisit(s.to)));
function append(message){const m={id:++sequence,time:Date.now(),...message};chat.messages.push(m);if(chat.messages.length>40)chat.messages.splice(0,chat.messages.length-40);return m;}
function welcome(){append({role:'assistant',text:'你好，我是跳色工作助手。\n可以帮你查询业务数据，或找到流程办理入口。你想先了解哪一项？',choices:services.value.map(s=>action(s.title,s.id))});}
export function clearConversation(){generation++;controller?.abort();controller=null;chat.busy=false;chat.messages=[];welcome();}
watch(()=>[auth.user?.id,auth.token,permState.loaded,permState.perms.join('|'),permState.positionPermissions?.join('|')],()=>{chat.opened=false;clearConversation();},{immediate:true});
const guides={
 orders:{text:'需要查询现有订单，还是了解下单流程？\n查订单时可以直接输入完整订单号。',choices:[action('怎样下单','new-order'),{label:'查询在产订单',query:'在产订单'},{label:'查询报价单',query:'报价单'}],links:[link('销售订单','/orders'),link('预下单','/pre-orders')]},
 'new-order':{text:'先在预下单录入客户与款式。\n新款上传效果图后进入开发打版；已有锁定样衣可以直接选择复用。预下单完成后带入业务下单，再补齐颜色、尺码和价格。',choices:[action('新款还没打版','new-style'),action('已有打版样衣','archive')],links:[link('打开预下单','/pre-orders')]},
 development:{text:'新品开发可以按需求走寻样、制版与样衣归档。请选一个需要办理的环节。',choices:[action('面辅料寻样','material'),action('新款开发打版','new-style'),action('样衣以图搜款','archive')],links:[link('打版流程','/pattern-board')]},
 material:{text:'在面辅料新品开发中关联预下单款式，并上传客户参考图。采购回传候选后由业务确认；不符合要求可填写原因驳回重找，通过后还需完成打版准入审核。',links:[link('面辅料新品开发','/material-development')]},
 'new-style':{text:'上传图片的新款可暂不填写款式名称，款号由版房在制版时填写。\n打版依次完成面辅料、制版、工艺、样衣、业务确认与核价；中途业务信息修改需申请审核并通过修改后复核。',links:[link('预下单','/pre-orders'),link('打版流程','/pattern-board')]},
 archive:{text:'在样衣管理中可上传照片查找相近款式，检索结果按相似度排序。\n已完成打版并锁定的样衣可在预下单选择复用；归档样衣需要修改时，先提交变更申请。',links:[link('样衣管理 / 以图搜款','/sample-archive'),link('预下单选款','/pre-orders')]},
 production:{text:'你想查询在产订单，还是办理生产确认？\n多款订单需分别完成技术资料和首件检验，不能用一款的确认代替整单。',choices:[{label:'查询在产订单',query:'在产订单'},action('怎样做首件确认','first-article')],links:[link('生产管理','/production'),link('首件确认','/first-article')]},
 'first-article':{text:'打开首件确认，选择订单和具体款式，按当前冻结技术版登记首件，填写检查项、实测和结论，再提交复核放行。\n多款需逐款放行；改版后对应款式需重新核验。',links:[link('首件确认','/first-article')]},
 inventory:{text:'可以查询库存概况，或进入库存页面办理业务。\n入库、发货会产生库存流水，请在业务页面核对后提交；聊天不会代你修改库存。',choices:[{label:'查询库存概况',query:'库存'},{label:'查询美仓缺货',query:'美仓缺货'}],links:[link('库存管理','/inventory')]},
 self:{text:'个人考勤、请假、工资条与相关申请都在“我的自助”中。\n这里显示的是账号绑定员工本人的信息；如果信息为空，请联系管理员检查员工档案关联。',choices:[action('工资条在哪里','payslip'),action('请假怎样申请','leave')],links:[link('打开我的自助','/self')]},
 payslip:{text:'进入“我的自助”，切换到“我的工资条”。未生成或尚未确认的工资条不会显示为已发放；需要核对时可联系薪酬负责人。',links:[link('查看我的工资条','/self')]},
 leave:{text:'进入“我的自助”查看个人申请入口，填写请假日期、类型和原因后提交，按系统审批结果办理。',links:[link('我的自助 / 个人申请','/self')]},
 collaboration:{text:'异常日清用于跟进异常任务，扫码查询用于识别业务标签，内部邮件用于同事协作。请选择办理入口。',links:[link('异常日清','/exceptions'),link('扫码查询','/scan'),link('内部邮件','/mail')]}
};
function guide(topic){const g=guides[topic];if(!g)return false;append({role:'assistant',...g});return true;}
export async function sendQuestion(text,{topic}={}){
 const question=String(text||'').trim();if(!question||question.length>500||chat.busy)return false;
 append({role:'user',text:question});
 if(topic&&guide(topic))return true;
 const exact=Object.entries(guides).find(([,g])=>g.links?.some(l=>l.text===question));
 const local=/工资条/.test(question)?'payslip':/请假|考勤/.test(question)?'self':/以图搜款|样衣库/.test(question)?'archive':/怎么下单|如何下单/.test(question)?'new-order':/^(你好|您好|嗨|hello)[！!。\s]*$/i.test(question)?'greeting':exact?.[0];
 if(local==='greeting'){welcome();return true;}if(local&&guide(local))return true;
 const current=generation;controller=new AbortController();const request=controller;chat.busy=true;
 const timer=setTimeout(()=>request.abort(),30000);
 try{
  // 手填订单号复用现有扫码精确匹配接口，支持含横线编号并沿用公司/员工数据范围。
  const orderCode=question.replace(/^(?:请|麻烦)?(?:帮我)?(?:查询|查看|查一下|查)?\s*(?:订单号|订单)?[：:\s]*/,'').replace(/(?:的)?(?:进度|状态|详情|到哪了)[？?。！!]*$/,'').trim();
  let result;
  if(/^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$/.test(orderCode)&&(canVisit('/orders')||canVisit('/scan'))){
   const order=await api.findOrder(orderCode,{signal:request.signal});
   const labels={draft:'草稿',tech:'技术确认',finance:'财务审核',production_audit:'生产审核',assigned:'已分单',production:'生产中',instock:'已入库',shipped:'已发货',closed:'已结案',cancelled:'已取消'};
   result={intent:'order-detail',title:'订单 '+order.order_no,summary:'已匹配系统订单，可到原单据核对完整信息。',columns:[{key:'order_no',label:'订单号'},{key:'style_name',label:'款式'},{key:'status_label',label:'状态'}],rows:[{...order,status_label:labels[order.status]||order.status}],links:order.scope==='basic'?[link('扫码查询','/scan')]:[link('查看订单详情','/orders?order='+order.id)]};
  }else result=await api.assistantQuery(question,{signal:request.signal});
  if(current!==generation)return false;
  append(result.intent==='overview'?{role:'assistant',text:'我暂时没有识别出具体业务问题。可以输入完整订单号，或从下面选择要办理的事项。',choices:services.value.map(s=>action(s.title,s.id))}:{role:'assistant',text:result.title,result});
 }catch(e){if(current===generation)append({role:'assistant',error:true,text:e.name==='AbortError'?'查询等待超过30秒，请稍后重试。':e.message,retry:question});}
 finally{clearTimeout(timer);if(current===generation){chat.busy=false;controller=null;}}
 return true;
}
