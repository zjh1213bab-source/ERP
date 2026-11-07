<template>
  <section class="assistant-chat" aria-label="智能助手对话">
    <header class="chat-header">
      <span class="chat-avatar"><UiIcon name="assist" /></span>
      <div class="chat-identity"><strong>跳色 ERP 智能助手</strong><span><i></i>业务查询与工作指引</span></div>
      <button class="chat-icon-button" type="button" title="开始新对话" aria-label="开始新对话" :disabled="chat.busy" @click="clearConversation()">↻</button>
      <button v-if="closable" class="chat-icon-button" type="button" aria-label="收起智能助手" @click="$emit('close')">×</button>
    </header>
    <div ref="messagesEl" class="chat-messages" role="log" aria-live="polite" aria-relevant="additions" @scroll="trackScroll()">
      <div class="conversation-date">{{ dateLabel }}</div>
      <article v-for="message in chat.messages" :key="message.id" class="chat-message" :class="message.role">
        <span v-if="message.role==='assistant'" class="message-avatar"><UiIcon name="assist" /></span>
        <div class="message-content">
          <div class="message-bubble" :class="{error:message.error}">
            <p class="message-text">{{ message.text }}</p>
            <template v-if="message.result">
              <p class="result-summary">{{ message.result.summary }}</p>
              <div v-if="message.result.rows?.length" class="chat-result-scroll" tabindex="0" aria-label="查询结果，可左右滚动">
                <table class="chat-result"><thead><tr><th v-for="column in message.result.columns" :key="column.key">{{ column.label }}</th></tr></thead>
                  <tbody><tr v-for="(row,index) in shownRows(message)" :key="index"><td v-for="column in message.result.columns" :key="column.key" :class="{numeric:column.align==='right'}">{{ row[column.key] ?? '—' }}</td></tr></tbody>
                </table>
              </div>
              <button v-if="message.result.rows?.length>8" class="chat-text-button" @click="expanded[message.id]=!expanded[message.id]">{{ expanded[message.id]?'收起结果':'查看全部 '+message.result.rows.length+' 条' }}</button>
            </template>
            <div v-if="message.choices?.length" class="chat-choices">
              <button v-for="choice in message.choices.filter(choiceAllowed)" :key="choice.label" type="button" :disabled="chat.busy" @click="choose(choice)">{{ choice.label }}</button>
            </div>
            <div v-if="linksFor(message).length" class="chat-links">
              <router-link v-for="link in linksFor(message)" :key="link.to" :to="link.to">{{ link.text }} <span aria-hidden="true">↗</span></router-link>
            </div>
            <button v-if="message.retry" class="chat-text-button" type="button" :disabled="chat.busy" @click="sendQuestion(message.retry)">重新查询</button>
          </div>
          <span v-if="message.role==='user'" class="message-status">已发送</span>
        </div>
      </article>
      <div v-if="chat.busy" class="chat-message assistant"><span class="message-avatar"><UiIcon name="assist" /></span><div class="message-bubble typing" role="status"><span>正在查询系统数据</span><i></i><i></i><i></i></div></div>
    </div>
    <footer class="chat-footer">
      <div class="composer"><textarea ref="inputEl" v-model="draft" aria-label="输入您的问题" placeholder="输入问题或订单号…" rows="2" maxlength="500" @keydown="onKeydown($event)"></textarea>
        <button type="button" :disabled="chat.busy || !draft.trim()" @click="submit()">发送 <span aria-hidden="true">↑</span></button>
      </div>
      <div class="composer-caption"><span>Enter 发送 · Shift + Enter 换行</span><span>{{ draft.length }}/500</span></div>
      <p class="chat-disclaimer">查询不修改业务数据，审批与提交请前往对应页面。</p>
    </footer>
  </section>
</template>
<script setup>
import { ref, reactive, watch, nextTick, onMounted } from 'vue';
import UiIcon from './UiIcon.vue';
import { chat, sendQuestion, clearConversation } from '../store/assistantChat';
import { canVisit } from '../store/navigation';
defineProps({closable:Boolean});defineEmits(['close']);
const draft=ref(''),messagesEl=ref(),inputEl=ref(),expanded=reactive({});let nearBottom=true;
const dateLabel=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric'});
const shownRows=message=>expanded[message.id]?message.result.rows:message.result.rows.slice(0,8);
const linksFor=message=>(message.links||message.result?.links||[]).filter(l=>typeof l.to==='string'&&/^\/(?!\/)/.test(l.to)&&canVisit(l.to));
function choiceAllowed(choice){if(!choice.query)return true;return canVisit(/库存|缺货/.test(choice.query)?'/inventory':/报价/.test(choice.query)?'/quotations':'/orders');}
function trackScroll(){const el=messagesEl.value;if(el)nearBottom=el.scrollHeight-el.clientHeight-el.scrollTop<80;}
async function scrollEnd(){await nextTick();const el=messagesEl.value;if(el)el.scrollTop=el.scrollHeight;}
function choose(choice){nearBottom=true;sendQuestion(choice.query||choice.label,{topic:choice.topic});scrollEnd();}
function submit(){if(chat.busy||!draft.value.trim())return;const text=draft.value;draft.value='';nearBottom=true;sendQuestion(text);scrollEnd();}
function onKeydown(event){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submit();}}
watch(()=>[chat.messages.length,chat.busy],()=>{if(nearBottom)scrollEnd();});
onMounted(scrollEnd);
</script>
<style scoped>
.assistant-chat{display:flex;flex-direction:column;min-width:0;height:100%;border:1px solid var(--line);border-radius:20px;background:var(--surface);overflow:hidden;box-shadow:var(--shadow-sm);color:var(--ink)}
.chat-header{display:flex;align-items:center;gap:12px;padding:20px;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--surface)}
.chat-avatar,.message-avatar{display:grid;place-items:center;flex-shrink:0;background:var(--brand-soft);color:var(--brand);border:1px solid var(--line)}.chat-avatar{width:44px;height:44px;border-radius:15px}.chat-avatar svg{width:25px;height:25px}
.chat-identity{flex:1;min-width:0}.chat-identity strong{display:block;font-size:14px;font-weight:650;line-height:1.5}.chat-identity>span{display:flex;align-items:center;gap:6px;color:var(--ink-mute);font-size:11px;margin-top:3px}.chat-identity i{width:6px;height:6px;border-radius:50%;background:var(--success)}
.chat-icon-button{display:grid;place-items:center;width:28px;height:28px;border:0;background:transparent;color:var(--ink-mute);cursor:pointer;font-size:21px;border-radius:6px}.chat-icon-button:hover{background:var(--surface-2);color:var(--ink)}
.chat-messages{flex:1;overflow:auto;overscroll-behavior:contain;padding:18px 16px 24px;min-height:0;scrollbar-width:thin}.conversation-date{text-align:center;color:var(--ink-mute);font-size:10px;letter-spacing:.4px;margin:0 0 22px}
.chat-message{display:flex;gap:9px;align-items:flex-start;margin-bottom:22px}.message-avatar{width:28px;height:28px;border-radius:9px;margin-top:3px}.message-avatar svg{width:17px;height:17px}.message-content{max-width:calc(100% - 37px);min-width:0}
.message-bubble{background:var(--surface-2);padding:14px 15px;border-radius:4px 16px 16px 16px;font-size:13px;line-height:1.85;overflow-wrap:anywhere}.message-bubble.error{border:1px solid var(--danger);color:var(--danger)}.message-text{margin:0;white-space:pre-wrap}.chat-message.user{justify-content:flex-end}.user .message-content{max-width:86%}.user .message-bubble{background:var(--brand-soft);color:var(--ink);border-radius:16px 4px 16px 16px}.message-status{display:block;text-align:right;font-size:10px;color:var(--ink-mute);margin-top:4px}
.chat-choices,.chat-links{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.chat-choices button,.chat-links a{border:1px solid var(--line);background:var(--surface);color:var(--brand);padding:6px 10px;border-radius:9px;text-decoration:none;font:inherit;font-size:12px;cursor:pointer}.chat-choices button:hover,.chat-links a:hover{border-color:var(--brand)}.chat-text-button{border:0;background:none;padding:8px 0 0;font:inherit;font-size:12px;color:var(--brand);cursor:pointer}
.result-summary{margin:6px 0;color:var(--ink-soft);font-size:12px}.chat-result-scroll{overflow:auto;margin-top:10px;border:1px solid var(--line);border-radius:8px;max-width:100%}.chat-result{border-collapse:collapse;white-space:nowrap;font-size:11px;width:100%}.chat-result th,.chat-result td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);background:var(--surface)}.chat-result th{background:var(--surface-3);font-weight:600}.chat-result .numeric{text-align:right;font-variant-numeric:tabular-nums}
.typing{display:flex;gap:5px;align-items:center;color:var(--ink-mute);font-size:12px}.typing span{margin-right:4px}.typing i{width:4px;height:4px;border-radius:50%;background:var(--ink-mute)}
.chat-footer{flex-shrink:0;border-top:1px solid var(--line);padding:15px 16px 12px;background:var(--surface)}.composer{display:flex;gap:10px;align-items:flex-end;border:1px solid var(--line);border-radius:12px;padding:9px;background:var(--surface)}.composer:focus-within{border-color:var(--brand)}.composer textarea{flex:1;min-width:0;background:transparent;border:0;outline:none;resize:none;font:inherit;font-size:13px;line-height:1.6;color:var(--ink);padding:3px 4px;max-height:110px}.composer textarea::placeholder{color:var(--ink-mute)}.composer button{flex-shrink:0;border:0;border-radius:9px;background:var(--brand);color:var(--on-brand);padding:10px 12px;cursor:pointer;font-size:12px;font-weight:600}.composer button:disabled{opacity:.4;cursor:default}.composer-caption{display:flex;justify-content:space-between;font-size:10px;color:var(--ink-mute);margin-top:7px}.chat-disclaimer{text-align:center;font-size:10px;color:var(--ink-mute);margin:8px 0 0}
button:focus-visible,a:focus-visible{outline:2px solid var(--brand);outline-offset:3px}@media(max-width:480px){.chat-header{padding:14px}.chat-footer{padding:12px}.chat-messages{padding:16px 12px}.message-bubble{padding:12px}.chat-identity strong{font-size:13px}}@media print{.assistant-chat{box-shadow:none}.chat-footer{display:none}}
</style>
