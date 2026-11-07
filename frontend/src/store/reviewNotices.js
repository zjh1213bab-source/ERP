import {reactive} from 'vue';import {api} from '../api';
export const reviewNotices=reactive({items:[],total:0,error:''});let seq=0;
export async function refreshReviewNotices(){const n=++seq;try{const data=await api.reviewNotices();if(n===seq)Object.assign(reviewNotices,data,{error:''});}catch(e){if(n===seq)Object.assign(reviewNotices,{items:[],total:0,error:e.message});}}
export function reviewCount(to){return reviewNotices.items.filter(i=>i.to===to).reduce((n,i)=>n+i.count,0);}
