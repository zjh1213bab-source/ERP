<template>
  <section class="business-note"><strong>业务要求</strong>
    <div v-if="!disabled" class="format-tools" aria-label="文字格式">
      <button v-for="[command,label] in formats" :key="command" type="button" @mousedown.prevent @click="format(command)">{{label}}</button>
    </div>
    <div ref="editor" role="textbox" aria-label="业务要求" aria-multiline="true" :contenteditable="!disabled" @input="change" @paste.prevent="paste" @drop.prevent></div>
  </section>
</template>
<script setup>
import {ref,watch,onMounted} from 'vue';
const props=defineProps({modelValue:String,disabled:Boolean}),emit=defineEmits(['update:modelValue']),editor=ref(null);
const formats=[['bold','加粗'],['italic','斜体'],['underline','下划线'],['removeFormat','清除格式']];
function clean(html){
  const doc=new DOMParser().parseFromString(html||'','text/html');
  for(const node of [...doc.body.querySelectorAll('*')].reverse()){
    if(!['B','STRONG','I','EM','U','P','DIV','BR'].includes(node.tagName)){node.replaceWith(...node.childNodes);continue;}
    for(const attr of [...node.attributes])node.removeAttribute(attr.name);
  }
  return doc.body.textContent.trim()?doc.body.innerHTML:'';
}
function sync(){const html=clean(props.modelValue);if(editor.value&&clean(editor.value.innerHTML)!==html)editor.value.innerHTML=html;}
function change(){emit('update:modelValue',clean(editor.value.innerHTML));}
function format(command){editor.value.focus();document.execCommand(command);change();}
function paste(event){document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));change();}
onMounted(sync);watch(()=>props.modelValue,sync);
</script>
<style scoped>
.business-note{margin:12px 0;background:white}.business-note strong{display:block;margin:6px 0}.format-tools{display:flex;gap:5px;padding:6px;background:#f5f8fc;border:1px solid #dce4ef}.format-tools button{cursor:pointer;background:white;border:1px solid #dce4ef;padding:4px 9px}.business-note [role=textbox]{min-height:72px;border:1px solid #dce4ef;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
