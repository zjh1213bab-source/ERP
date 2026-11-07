/** 导航与助手快捷入口共用模块判断；实际数据权限由后端执行。 */
import { auth } from './auth';
import { myRoles, permState } from './permissions';
const portals=new Set(['/self','/exceptions','/scan','/assistant','/mail']);
const aliases={'order-allocation':'dispatch','order-tracking':'node-flow',scan:'orders',assistant:'assistant',development:'techpacks','material-edit':'materials','sample-archive':'sample-archives','pattern-board':'pattern-flows',production:'dispatch',inventory:'stock',quality:'qc','finance-books':'gl','data-quality':'dq','overseas-warehouse':'wh','spot-analysis':'spot','ai-center':'ai',marketing:'mkt',organization:'org','first-article':'first-articles','piece-wage':'piece-wage','import-data':'importops',leads:'crm','export-center':'exports','payment-requests':'payment-requests','access-review':'access','permission-management':'access'};
export function canVisit(to){
 if(!auth.user)return false;
 if(auth.user.role==='admin'||permState.isAdmin)return true;
 const path=String(to||'').split('?')[0];
 if(!permState.loaded)return false;
 if(!permState.positionDirect&&myRoles().every(r=>r==='employee'))return portals.has(path);
 if(!permState.positionDirect)return true;
 if(path==='/self')return true;
 return !!permState.positionPermissions?.includes('module.'+(aliases[path.split('/')[1]]||path.split('/')[1])+'.read');
}
