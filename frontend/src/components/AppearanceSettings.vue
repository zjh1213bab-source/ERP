<template>
 <Teleport to="body"><div v-if="modelValue" class="appearance-mask" role="presentation">
  <section class="appearance-panel" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
   <header class="appearance-head"><div><span class="eyebrow">个性化工作空间</span><h2 id="appearance-title">外观设置</h2></div><button ref="closeButton" type="button" class="appearance-close" aria-label="关闭外观设置" @click="close">×</button></header>
   <nav class="appearance-tabs" aria-label="外观设置分类"><button type="button" :class="{on:activeTab==='theme'}" @click="activeTab='theme'">显示与配色</button><button type="button" :class="{on:activeTab==='background'}" @click="activeTab='background'">节假日背景</button></nav>
   <div class="appearance-body"><div v-show="activeTab==='theme'">
    <section class="appearance-section"><h3>显示模式</h3><p>个人偏好，自动记住本机选择。</p><div class="theme-options"><button type="button" :class="{selected:theme.mode==='light'}" @click="applyTheme('light')"><span class="theme-sample light"><i></i><b></b></span>浅色 · 清晰明亮</button><button type="button" :class="{selected:theme.mode==='dark'}" @click="applyTheme('dark')"><span class="theme-sample dark"><i></i><b></b></span>深色 · 专注舒适</button></div></section>
    <section class="appearance-section"><h3>导航配色</h3><p>选择预设，或使用你的品牌颜色；「跳色彩色」为自定义 / 节日皮肤配色。</p><slot name="navigation" /></section>
    <section class="appearance-section"><h3>品牌图标</h3><p>标准图标按侧栏明暗自动切换黑 / 白；彩色图标用于自定义皮肤与节日氛围。</p><div class="brand-logo-options"><button type="button" :class="{selected:brandLogoMode==='auto'}" @click="setBrandLogoMode('auto')">标准（黑 / 白）</button><button type="button" :class="{selected:brandLogoMode==='festive'}" @click="setBrandLogoMode('festive')"><img :src="logoFestive" alt="" data-no-image-preview />彩色 · 节日</button></div></section>
    </div><section v-show="activeTab==='background'" class="appearance-section"><div class="appearance-section-title"><h3>节假日背景</h3><span class="tag">全站共享</span></div><p>{{isAdmin?'上传节日氛围图并发布，局域网内其他电脑会自动同步。':'背景由系统管理员统一发布；显示模式与导航配色仍由你自由选择。'}}</p>
     <div class="wallpaper-preview" :class="{empty:!draft.image_url}"><img v-if="draft.image_url" :src="draft.image_url" alt="节日背景预览" data-no-image-preview :style="{opacity:draft.enabled?draft.opacity:0,filter:`blur(${draft.blur}px)`,objectPosition:draft.position}"/><div class="wallpaper-preview-ui" :style="{'--workspace-fill':(draft.enabled?100-draft.workspace_transparency:100)+'%'}"><span></span><div><b>工作空间</b><i></i><i></i></div></div></div>
     <p v-if="loadError" class="form-msg err">{{loadError}}</p>
     <fieldset :disabled="!isAdmin || saving || uploading || loading || !!loadError">
      <label class="appearance-switch"><span>启用节日背景</span><input type="checkbox" v-model="draft.enabled" /></label>
      <div v-if="isAdmin" class="appearance-upload"><label class="btn btn-ghost" :class="{disabled:uploading}" for="holiday-file">{{uploading?'正在上传…':'上传背景图片'}}</label><button type="button" class="btn btn-ghost" :disabled="uploading||saving||loading||!!loadError" @click="useBuiltinFestive">{{uploading?'正在准备…':'使用内置彩色素材'}}</button><input id="holiday-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" @change="upload"/><button v-if="draft.image_url" type="button" class="link-btn danger" @click="draft.image_url=null;draft.enabled=false">移除图片</button></div>
      <label class="appearance-field">节日名称<input class="input" v-model="draft.label" maxlength="40" placeholder="例如：春节、国庆、中秋" /></label>
      <label class="appearance-field">背景显示强度 <span>{{Math.round(draft.opacity*100)}}%</span><input type="range" min="0.05" max="0.5" step="0.01" v-model.number="draft.opacity" /></label>
      <label v-if="draft.image_url" class="appearance-field">工作区透明度 <span>{{draft.workspace_transparency}}%</span><input type="range" min="0" max="100" step="1" v-model.number="draft.workspace_transparency" /></label>
      <label class="appearance-field">背景虚化 <span>{{draft.blur}} px</span><input type="range" min="0" max="12" step="1" v-model.number="draft.blur" /></label>
      <label class="appearance-field">图片位置<select class="select" v-model="draft.position"><option value="center">居中</option><option value="top">顶部</option><option value="bottom">底部</option></select></label>
     </fieldset>
     <p class="appearance-hint">工作区透明度越高，背景图片越清晰。</p>
     <p v-if="message" class="form-msg" :class="{err:failed}" role="status">{{message}}</p>
    </section>
   </div>
   <footer class="appearance-foot"><button v-if="isAdmin && activeTab==='background'" type="button" class="btn btn-ghost" :disabled="saving || uploading || loading || !!loadError" @click="reset">恢复默认背景</button><button v-if="isAdmin && activeTab==='background'" type="button" class="btn btn-primary" :disabled="saving || uploading || loading || !!loadError" @click="publish">{{saving?'发布中…':'发布全站背景'}}</button><button v-else type="button" class="btn btn-primary" @click="close">完成</button></footer>
  </section>
 </div></Teleport>
</template>
<script setup>
import {ref,reactive,computed,watch,nextTick,onBeforeUnmount} from 'vue';
import {auth} from '../store/auth';
import {theme,applyTheme} from '../store/theme';
import {appearance,defaultAppearance,applyAppearance,loadAppearance,brandLogoMode,setBrandLogoMode} from '../store/appearance';
import {api} from '../api';
import logoFestive from '../assets/brand/jump-color-festive.png';
import festiveBg from '../assets/brand/jump-color-festive-bg.jpg';
const props=defineProps({modelValue:Boolean});const emit=defineEmits(['update:modelValue']);
const activeTab=ref('theme');
const draft=reactive({...appearance}),loading=ref(false),saving=ref(false),uploading=ref(false),loadError=ref(''),message=ref(''),failed=ref(false),closeButton=ref(null);
const isAdmin=computed(()=>auth.user?.role==='admin');let previousFocus;
function close(){if(saving.value || uploading.value)return;emit('update:modelValue',false);}
function trap(event){if(!props.modelValue || event.key!=='Tab')return;const nodes=[...document.querySelectorAll('.appearance-panel button:not(:disabled),.appearance-panel input:not(:disabled),.appearance-panel select:not(:disabled)')].filter(n=>n.offsetParent!==null);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}}
watch(()=>props.modelValue,async open=>{if(!open){document.removeEventListener('keydown',trap);previousFocus?.focus();return;}previousFocus=document.activeElement;activeTab.value='theme';loading.value=true;message.value='';loadError.value='';Object.assign(draft,appearance);await nextTick();closeButton.value?.focus();document.addEventListener('keydown',trap);try{Object.assign(draft,await loadAppearance());}catch(e){loadError.value=e.message;}finally{loading.value=false;} });
onBeforeUnmount(()=>document.removeEventListener('keydown',trap));
async function upload(event){const file=event.target.files?.[0];event.target.value='';if(!file || uploading.value)return;message.value='';failed.value=false;if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size>3*1024*1024){message.value='请上传3MB以内的 PNG、JPG、WebP 或 GIF 图片';failed.value=true;return;}uploading.value=true;try{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('图片读取失败'));r.readAsDataURL(file);});const result=await api.upload(data);draft.image_url=result.url;draft.enabled=true;message.value='上传成功，发布后应用到全站。';}catch(e){failed.value=true;message.value=e.message;}finally{uploading.value=false;}}
/** 内置彩色节日素材：复用现有上传接口得到合法 /uploads 路径，
 *  管理员随后点「发布全站背景」即可生效；不改后端校验白名单，也不依赖手工选图。 */
async function useBuiltinFestive(){
 if(uploading.value||saving.value)return;
 uploading.value=true;message.value='';failed.value=false;
 try{
  const blob=await (await fetch(festiveBg)).blob();
  const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('读取内置素材失败'));r.readAsDataURL(blob);});
  const result=await api.upload(dataUrl);
  draft.image_url=result.url;draft.enabled=true;
  if(!draft.label)draft.label='跳色彩色';
  message.value='已选用内置彩色素材，点「发布全站背景」即可生效。';
 }catch(e){failed.value=true;message.value=e.message;}
 finally{uploading.value=false;}
}
async function publish(){saving.value=true;message.value='';failed.value=false;try{const config=await api.saveAppearance({...draft});if(config.workspace_transparency===undefined && draft.enabled){applyAppearance(config);draft.revision=config.revision;throw new Error('背景图片已发布，工作区透明度需要服务器更新后再次发布。');}applyAppearance(config);Object.assign(draft,config);message.value='已发布，其他电脑会在一分钟内自动同步。';}catch(e){failed.value=true;message.value=e.message;}finally{saving.value=false;}}
async function reset(){Object.assign(draft,defaultAppearance(),{revision:draft.revision});await publish();}
</script>
