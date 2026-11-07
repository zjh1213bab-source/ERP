/** 使用真实 Vue 响应式验证异步会话隔离；接口仅在此测试内替身，不访问业务数据。 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
const fixture={auth:reactive({user:{id:1,role:'admin'},token:'first'}),perms:reactive({loaded:true,perms:[],positionPermissions:null}),requests:[]};
fixture.api={assistantQuery:(q,{signal})=>new Promise((resolve,reject)=>fixture.requests.push({q,signal,resolve,reject})),findOrder:()=>{throw Error('Unexpected order lookup');}};
globalThis.__assistantSessionFixture=fixture;
let source=fs.readFileSync(new URL('../src/store/assistantChat.js',import.meta.url),'utf8');
source=source.replace("from 'vue'","from '"+import.meta.resolve('vue')+"'")
 .replace("import { auth } from './auth';","const auth=globalThis.__assistantSessionFixture.auth;")
 .replace("import { api } from '../api';","const api=globalThis.__assistantSessionFixture.api;")
 .replace("import { canVisit } from './navigation';","const canVisit=()=>true;")
 .replace("import { permState } from './permissions';","const permState=globalThis.__assistantSessionFixture.perms;");
const {chat,sendQuestion,clearConversation}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
const first=sendQuestion('库存');check(chat.busy&&fixture.requests.length===1,'Query enters busy state');
check(await sendQuestion('报价单')===false&&fixture.requests.length===1,'Concurrent sends rejected');
chat.opened=true;fixture.auth.user={id:2,role:'employee'};fixture.auth.token='second';await nextTick();
check(fixture.requests[0].signal.aborted,'Changing account aborts prior request');
check(chat.messages.length===1&&!chat.busy&&!chat.opened,'Changing account clears local conversation and floating panel');
const second=sendQuestion('报价单');check(chat.busy&&fixture.requests.length===2,'New account can start its own request');
fixture.requests[0].resolve({intent:'stock',title:'OLD_PRIVATE_RESULT',rows:[{secret:'OLD_PRIVATE'}],columns:[]});await first;
check(!JSON.stringify(chat.messages).includes('OLD_PRIVATE'),'Late previous-account data discarded');
check(chat.busy,'Late previous request cannot clear new request busy state');
fixture.requests[1].resolve({intent:'quotations',title:'NEW_ACCOUNT_RESULT',summary:'New account',rows:[],columns:[],links:[]});await second;
check(!chat.busy&&chat.messages.some(m=>m.text==='NEW_ACCOUNT_RESULT'),'New response preserved');
fixture.perms.positionPermissions=['module.assistant.read'];await nextTick();check(chat.messages.length===1,'Changed permissions clear cached conversation');
const failed=sendQuestion('库存');fixture.requests[2].reject(Error('temporary failure'));await failed;
check(!chat.busy&&chat.messages.at(-1).retry==='库存','Failure becomes retryable message');
clearConversation();check(chat.messages.length===1,'Explicit reset retains only welcome');
for(let i=0;i<30;i++)await sendQuestion('你好');check(chat.messages.length<=40,'Conversation retention bounded');
console.log('ASSISTANT_SESSION_PASS '+checks);
delete globalThis.__assistantSessionFixture;
