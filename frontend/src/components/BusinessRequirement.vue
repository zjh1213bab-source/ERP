<template>
  <section class="business-note"><strong>业务要求</strong>
    <div v-if="!disabled" class="template-tools">
      <button type="button" @click="clearContent">一键清空</button>
      <button type="button" @click="saveTemplate">保存模板</button>
      <button type="button" @click="showTemplates=!showTemplates;readTemplates()">选择模板</button>
      <template v-if="showTemplates"><select aria-label="选择业务要求模板" @change="applyTemplate($event.target.value)"><option value="">请选择模板</option><option v-for="t in templates" :key="t.name" :value="t.name">{{t.name}}</option></select><small v-if="!templates.length">暂无模板</small></template>
    </div>
    <div v-if="!disabled" class="format-tools" aria-label="文字格式">
      <button v-for="[command,label] in formats" :key="command" type="button" @mousedown.prevent @click="format(command)">{{label}}</button>
    </div>
    <div ref="editor" role="textbox" aria-label="业务要求" aria-multiline="true" :contenteditable="!disabled" @input="change" @paste.prevent="paste" @drop.prevent></div>
  </section>
</template>
<script setup>
import {ref,watch,onMounted} from 'vue';
const props=defineProps({modelValue:String,disabled:Boolean}),emit=defineEmits(['update:modelValue']),editor=ref(null);
const formats=[['bold','加粗'],['italic','斜体'],['underline','下划线'],['insertUnorderedList','项目符号'],['insertOrderedList','编号'],['undo','撤销'],['redo','重做'],['removeFormat','清除格式']];
function clean(html){
  const doc=new DOMParser().parseFromString(html||'','text/html');
  for(const node of [...doc.body.querySelectorAll('*')].reverse()){
    if(!['B','STRONG','I','EM','U','P','DIV','BR','UL','OL','LI'].includes(node.tagName)){node.replaceWith(...node.childNodes);continue;}
    for(const attr of [...node.attributes])node.removeAttribute(attr.name);
  }
  return doc.body.textContent.trim()?doc.body.innerHTML:'';
}
const templates=ref([]),showTemplates=ref(false),storageKey='erp.business-requirement.templates.v1';
function readTemplates(){
 try{templates.value=JSON.parse(localStorage.getItem(storageKey)||'[]')}catch{templates.value=[]}
}
function replaceContent(html){editor.value.innerHTML=clean(html);change();}
function clearContent(){if(!editor.value.textContent.trim()||confirm('清空本款业务要求？'))replaceContent('');}
function saveTemplate(){
 const html=clean(editor.value.innerHTML);
 if(!html)return alert('请先填写业务要求');
 const name=prompt('输入模板名称')?.trim();
 if(!name)return;
 readTemplates();
 if(templates.value.some(t=>t.name===name)&&!confirm('覆盖已有同名模板？'))return;
 const next=[...templates.value.filter(t=>t.name!==name),{name,html}];
 try{localStorage.setItem(storageKey,JSON.stringify(next));templates.value=next}catch{alert('模板保存失败，请检查浏览器存储空间')}
}
function applyTemplate(name){
 const t=templates.value.find(t=>t.name===name);
 if(t&&(!editor.value.textContent.trim()||confirm('使用模板替换当前业务要求？')))replaceContent(t.html);
 showTemplates.value=false;
}
function sync(){const html=clean(props.modelValue);if(editor.value&&clean(editor.value.innerHTML)!==html)editor.value.innerHTML=html;}
function change(){emit('update:modelValue',clean(editor.value.innerHTML));}
function format(command){editor.value.focus();document.execCommand(command);change();}
function paste(event){document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));change();}
onMounted(sync);watch(()=>props.modelValue,sync);
</script>
<style scoped>
.business-note{margin:12px 0;background:white}.business-note strong{display:block;margin:6px 0}.template-tools{display:flex;align-items:center;gap:8px;padding:6px;border:1px solid #dce4ef;background:#f7f8fa}.template-tools button{padding:6px 14px;color:#1677cc;border:1px solid #b4d6ff;background:white;border-radius:3px;cursor:pointer}.template-tools button:first-child{color:#c43c40}.format-tools{display:flex;gap:5px;padding:6px;background:#f5f8fc;border:1px solid #dce4ef}.format-tools button{cursor:pointer;background:white;border:1px solid #dce4ef;padding:4px 9px}.business-note [role=textbox]{min-height:260px;border:1px solid #dce4ef;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
