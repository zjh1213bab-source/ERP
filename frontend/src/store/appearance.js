import {reactive} from 'vue';
import {api} from '../api';
const KEY='erp_appearance_v1';
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
