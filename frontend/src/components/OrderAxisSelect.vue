<template>
  <div class="order-axis-select" ref="root" @keydown.esc.stop.prevent="opened=false">
    <div class="axis-trigger" :class="['chips',{sizes:kind==='sizes'}]" tabindex="0" role="button" :aria-label="label+'选择'" :aria-expanded="opened" @click="toggle()" @keydown.enter.prevent="toggle()" @keydown.space.prevent="toggle()">
      <span v-for="name in modelValue" :key="name">{{name}} <button type="button" :aria-label="'移除'+name" @click.stop="$emit('update:modelValue',modelValue.filter(x=>x!==name))">×</button></span>
      <small v-if="!modelValue.length">请选择{{label}}</small><b class="axis-arrow">⌄</b>
    </div>
    <section v-if="opened" class="axis-popover" :aria-label="label+'选项'">
      <input ref="searchInput" v-model="search" :placeholder="'搜索'+label" :aria-label="'搜索'+label"/>
      <div class="axis-shortcuts"><span>已选 {{modelValue.length}} / {{max}}</span><button type="button" @click="selectVisible()">选中搜索结果</button><button type="button" @click="$emit('update:modelValue',[])">清空</button></div>
      <div class="axis-option-grid" role="listbox" aria-multiselectable="true" :aria-label="label">
        <button v-for="name in filtered" :key="name" type="button" role="option" :aria-selected="modelValue.includes(name)" :class="{selected:modelValue.includes(name)}" @click="pick(name)">{{name}}<span v-if="modelValue.includes(name)"> ✓</span></button>
        <p v-if="!filtered.length">没有匹配项，可在下方新增。</p>
      </div>
      <div class="axis-add"><input v-model="newName" :placeholder="kind==='colors'?'新增颜色':'新增尺码'" maxlength="60" @keyup.enter="add()"/><button type="button" @click="add()">添加</button></div>
      <p v-if="message" class="axis-message" role="status">{{message}}</p>
      <footer><small>点选即同步下方颜色、尺码及图片</small><button type="button" @click="opened=false">关闭</button></footer>
    </section>
  </div>
</template>
<script setup>
import {ref,computed,watch,onMounted,onBeforeUnmount,nextTick} from 'vue';
const props=defineProps({modelValue:Array,options:Array,label:String,kind:String,max:Number});
const emit=defineEmits(['update:modelValue']);
const root=ref(null),searchInput=ref(null),opened=ref(false),search=ref(''),newName=ref(''),known=ref([]),message=ref('');
watch(()=>[props.options,props.modelValue],()=>{known.value=[...new Set([...known.value,...props.options,...props.modelValue])];},{immediate:true,deep:true});
const filtered=computed(()=>known.value.filter(n=>n.toLowerCase().includes(search.value.trim().toLowerCase())));
function toggle(){opened.value=!opened.value;if(opened.value){search.value='';message.value='';nextTick(()=>searchInput.value?.focus());}}
function pick(name){message.value='';if(props.modelValue.includes(name))emit('update:modelValue',props.modelValue.filter(n=>n!==name));else if(props.modelValue.length<props.max)emit('update:modelValue',[...props.modelValue,name]);else message.value=`最多选择${props.max}项`;}
function selectVisible(){const next=[...new Set([...props.modelValue,...filtered.value])];if(next.length>props.max){message.value=`最多选择${props.max}项，请缩小搜索范围`;return;}emit('update:modelValue',next);}
function add(){const name=newName.value.trim();if(!name){message.value='请输入名称';return;}if(known.value.includes(name)){message.value='名称已存在，可从上方选中';return;}if(props.modelValue.length>=props.max){message.value=`最多选择${props.max}项`;return;}known.value.push(name);emit('update:modelValue',[...props.modelValue,name]);newName.value='';search.value='';message.value='';}
function outside(e){if(root.value&&!root.value.contains(e.target))opened.value=false;}
onMounted(()=>document.addEventListener('pointerdown',outside));
onBeforeUnmount(()=>document.removeEventListener('pointerdown',outside));
</script>
<style scoped>
.order-axis-select{position:relative;width:360px;max-width:100%;flex:none}.axis-trigger.chips{width:100%;box-sizing:border-box;min-width:0;max-width:none;cursor:pointer;position:relative;padding-right:25px;min-height:38px}.axis-trigger:focus{outline:2px solid var(--entry-blue);outline-offset:1px}.axis-arrow{position:absolute;right:8px;top:9px;color:var(--ink-mute)}.axis-popover{position:absolute;top:calc(100% + 8px);left:0;z-index:40;width:360px;max-width:calc(100vw - 48px);box-sizing:border-box;background:var(--surface);border:1px solid var(--entry-line);border-radius:7px;box-shadow:0 8px 28px #0002;padding:12px}.axis-popover>input{width:100%;box-sizing:border-box}.axis-shortcuts{display:flex;gap:8px;align-items:center;margin:10px 0;font-size:11px;color:var(--ink-mute)}.axis-shortcuts button{padding:3px 5px}.axis-option-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;max-height:220px;overflow:auto}.axis-option-grid button{white-space:normal;overflow-wrap:anywhere;min-height:32px;padding:5px}.axis-option-grid button.selected{border-color:var(--entry-blue);color:var(--entry-blue);background:color-mix(in srgb,var(--entry-blue) 8%,var(--surface))}.axis-option-grid p{grid-column:1/-1;color:var(--ink-mute)}.axis-add{display:flex;gap:6px;margin-top:10px}.axis-add input{min-width:0;flex:1}.axis-message{color:var(--ink-soft);margin:8px 0;font-size:12px}.axis-popover footer{display:flex;gap:7px;align-items:center;margin-top:10px}.axis-popover footer small{margin-right:auto;color:var(--ink-mute)}@media(max-width:700px){.order-axis-select{width:calc(100% - 46px)}.axis-popover{width:100%;min-width:250px}}
</style>
