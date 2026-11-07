import {reactive,ref,watch} from 'vue';
import {api} from '../api';
const KEY='erp_appearance_v1';
// 品牌图标偏好：'auto' 按侧栏明暗自动用黑/白 Logo，'festive' 用彩色 Logo。
// 与导航配色一样属于「自定义皮肤」的本机偏好，跨组件、跨标签页同步。
const LOGO_KEY='erp_brand_logo';
const readLogoMode=()=>{try{return localStorage.getItem(LOGO_KEY)==='festive'?'festive':'auto';}catch{return 'auto';}};
export const brandLogoMode=ref(readLogoMode());
watch(brandLogoMode,(v)=>{try{localStorage.setItem(LOGO_KEY,v);}catch{}});
window.addEventListener('storage',(event)=>{if(event.key===LOGO_KEY||event.key===null)brandLogoMode.value=readLogoMode();});
export function setBrandLogoMode(mode){brandLogoMode.value=mode==='festive'?'festive':'auto';}
export const defaultAppearance=()=>({enabled:false,image_url:null,opacity:0.18,blur:0,position:'center',label:'',revision:0});
let cached={};try{cached=JSON.parse(localStorage.getItem(KEY)||'{}');}catch{}
export const appearance=reactive({...defaultAppearance(),...cached});
export function applyAppearance(config){
 Object.assign(appearance,defaultAppearance(),{...config});
 const root=document.documentElement;
 const valid=/^\/uploads\/[a-f0-9]{20}\.(png|jpg|jpeg|webp|gif)$/i.test(appearance.image_url || '');
 root.dataset.wallpaper=appearance.enabled && valid?'on':'off';
 root.style.setProperty('--holiday-image',valid?`url("${appearance.image_url}")`:'none');
 root.style.setProperty('--holiday-opacity',String(Math.min(.5,Math.max(.05,Number(appearance.opacity)||.18))));
 root.style.setProperty('--holiday-blur',`${Math.min(12,Math.max(0,Number(appearance.blur)||0))}px`);
 root.style.setProperty('--holiday-position',['center','top','bottom'].includes(appearance.position)?appearance.position:'center');
 try{localStorage.setItem(KEY,JSON.stringify(appearance));}catch{}
}
export async function loadAppearance(){const data=await api.appearance();applyAppearance(data);return data;}
applyAppearance(appearance);
