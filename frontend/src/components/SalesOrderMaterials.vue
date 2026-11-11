<template>
  <fieldset class="materials-area" :disabled="readonly" style="border:0;padding:0;margin:0;min-width:0">
    <section v-for="kind in kinds" :key="kind.type" class="material-section">
      <h3>{{kind.title}} <small>平均单件成本：<em>{{average(kind.type).toFixed(2)}} 元</em></small></h3>
      <div class="material-toolbar"><button type="button" class="primary" @click="choose(kind.type)">选择{{kind.label}}</button><button type="button" class="warning" @click="newArchive(kind.type)">新增{{kind.type==='fabric'?'主料':'辅料'}}</button><template v-if="kind.type==='accessory'"><button type="button" class="primary" @click="saveTemplate()">保存模板</button><button type="button" class="primary" @click="chooseTemplate()">选择模板</button></template><button type="button" class="primary" @click="addGroup(kind.type)">＋增加使用部位</button><span>物料来自档案，规格与供应商只读</span></div>
      <section v-for="group in groups(kind.type)" :key="group.id" class="material-part-group"><header class="part-group-head"><label>使用部位 <input v-model="group.name" maxlength="500" placeholder="自行命名，如衣身、袖子" @input="syncGroup(group)"/></label><label>本部位统一单件用量 <input type="number" min="0" max="1000000" step="0.001" v-model.number="group.one_use" @input="syncGroup(group)"/> {{group.unit||'按物料单位'}}</label><button type="button" @click="choose(kind.type,group.id)">＋添加{{kind.label}}</button><button type="button" class="link danger" @click="removeGroup(group)">删除使用部位</button></header><small class="part-group-note">同组所有物料共用此单件用量，可继续增加其他使用部位。规格与空差读取物料档案。</small><div class="material-scroll"><table class="material-table" :class="kind.type"><thead><tr><th>操作</th><th>序号</th><th v-if="kind.type==='fabric'">类型</th><th v-if="kind.type==='fabric'">物料备注</th><th>{{kind.label}}名称</th><th class="color-description">款色 · <i>颜色/色号</i> · <em>单价</em> · <strong>单件含损耗金额</strong></th><th v-if="kind.type==='accessory'">单位</th><th>成分</th><th v-if="kind.type==='fabric'">规格</th><template v-if="kind.type==='accessory'"><th>使用部位</th><th>克重(g)</th></template><th>单件用量 / 损耗</th><th>供应商名称</th><th v-if="kind.type==='accessory'">物料备注</th></tr></thead>
        <tbody><tr v-for="(m,n) in groupRows(group)" :key="m.key"><td class="material-actions"><button type="button" class="link danger" @click="remove(m)">移除</button><button type="button" class="link" @click="move(m,-1)">上移</button><button type="button" class="link" @click="move(m,1)">下移</button><button type="button" class="link" @click="replace(m)">替换物料</button><button type="button" class="link" @click="copy(m)">复制物料</button></td><td>{{n+1}}</td><td v-if="kind.type==='fabric'">{{m.role}}</td><td v-if="kind.type==='fabric'"><textarea v-model="m.remark" rows="4" placeholder="请输入备注"/></td><td class="material-name"><input :value="m.name" readonly title="物料名称来自档案，只读"/><small>本单物料照片</small><ImageUpload :disabled="readonly" @uploading="trackFileUpload" v-model="m.order_image_url" size="sm" :title="m.name+' · 本单物料照片'"/><small>支持粘贴，仅保存到本单</small><small>{{m.code}}</small></td>
          <td class="color-description"><div class="material-color-lines"><div v-for="c in visibleColors(m)" :key="c.color"><button type="button" class="material-color-text link" @click="editColors(m,c.color)" :title="'编辑'+c.color+'的配色与照片'"><span>{{c.color}}</span> - <i>{{config(m,c.color).color_no||'未填写 / 未填写'}}</i> - <em>{{Number(config(m,c.color).price??m.price).toFixed(2)}}元</em> - <strong>{{unitCost(m,c.color).toFixed(2)}}元</strong></button><button type="button" v-if="config(m,c.color).image_url" class="material-color-preview" @click.stop="openImage(config(m,c.color).image_url,m.name+' · '+c.color)" :aria-label="'放大查看'+c.color+'物料照片'" title="点击放大查看"><img :src="config(m,c.color).image_url" :alt="c.color+'物料照片'"/></button></div></div><button type="button" class="edit-color" @click="editColors(m)" title="编辑颜色、色号、单价及照片">✎</button></td>
          <td v-if="kind.type==='accessory'"><input :value="m.unit" readonly style="width:70px"/></td><td><textarea v-model="m.ingredient" rows="5" placeholder="本单成分" /></td><td v-if="kind.type==='fabric'" class="material-spec"><label>单位：<input :value="m.unit" readonly/></label><label v-if="kind.type==='fabric'">幅宽：<input :value="m.width" readonly/> cm</label><label>克重：<input :value="m.weight" readonly/> g</label><small>{{m.spec||'未填写其他规格'}}</small></td>
          <template v-if="kind.type==='accessory'"><td>{{m.usage_part||'未命名部位'}}</td><td><input :value="m.weight" readonly style="width:65px"/></td></template><td class="material-spec"><label>单件用量：{{m.one_use}} {{m.unit}}</label><label>损耗 %：<input type="number" min="0" max="1000" step="0.01" v-model.number="m.loss" /></label><label>空差 %：{{m.air_gap||100}}</label><small>含损耗用量：{{(Number(m.one_use||0)*(1+Number(m.loss||0)/100)*100/Number(m.air_gap||100)).toFixed(3)}} {{m.unit}}</small></td><td>{{m.supplier||'档案未设置'}}</td><td v-if="kind.type==='accessory'"><textarea v-model="m.remark" rows="3" placeholder="物料备注"/></td></tr>
          <tr v-if="!groupRows(group).length"><td :colspan="kind.type==='fabric'?10:11" class="empty-material">暂未选择{{kind.label}}，点击上方“选择{{kind.label}}”从物料档案添加</td></tr></tbody></table></div></section>
    </section>
    <details v-if="!hideCrafts" class="craft-requirements"><summary>外发工艺 <small>工艺要求；本厂 / 外发由生产分单确定</small></summary><p><select v-model="selectedCraft"><option value="">选择工序类别</option><option v-for="c in craftTypes" :key="c.id" :value="c.id">{{c.name}}</option></select> <button type="button" @click="addCraft()">添加工序</button></p><div v-for="(c,i) in item.crafts" :key="i" class="craft-row"><b>{{c.name}}</b><input v-model="c.instruction" placeholder="工艺要求"/><button type="button" class="link danger" @click="item.crafts.splice(i,1)">移除</button></div></details>
    <MaterialPicker :open="picker.open" :type="picker.type" :selected="[]" @close="picker.open=false" @picked="picked" />
    <div v-if="editing" class="entry-dialog-mask match-mask">
      <section ref="colorDialog" role="dialog" aria-modal="true" :aria-label="editing.name+' · 配色编辑'" tabindex="-1" @keydown.esc="onEditorEscape" class="match-dialog" :class="{expanded:expandedColors}">
        <header><span>{{editing.name}}</span><div><button type="button" :aria-label="expandedColors?'退出全屏':'全屏'" @click="expandedColors=!expandedColors">⛶</button><button type="button" aria-label="关闭" :disabled="uploadingColors.size>0" @click="closeColors">×</button></div></header>
        <main>
          <div class="match-select"><b>颜色</b><div class="match-picker">
            <button type="button" class="picker-trigger" :aria-expanded="pickerOpen" :disabled="editing.shared_color || uploadingColors.size>0" @click="pickerOpen=!pickerOpen"><span v-for="c in displayColors" :key="c.colorway">{{c.colorway}}</span><i>⌄</i></button>
            <div v-if="pickerOpen && !editing.shared_color" class="picker-menu"><label v-for="c in item.colors" :key="c.color"><input type="checkbox" :checked="editing.colors.some(row=>row.colorway===c.color)" @change="toggleColor(c.color)">{{c.color}}</label><button type="button" @click="pickerOpen=false">完成</button></div>
          </div></div>
          <div class="match-switches">
            <label>所有颜色通配<input type="checkbox" role="switch" :checked="editing.shared_color" :disabled="uploadingColors.size>0" @change="switchShared($event.target.checked)"/></label>
            <label>单价列复制<input type="checkbox" role="switch" v-model="copyPrice" :disabled="editing.shared_color" @change="copyPrice && applyColumn(displayColors[0],'price',displayColors[0]?.price)"/></label>
            <label>图片列复制<input type="checkbox" role="switch" v-model="copyPhoto" :disabled="editing.shared_color || uploadingColors.size>0" @change="copyPhoto && applyColumn(displayColors[0],'image_url',displayColors[0]?.image_url)"/></label>
          </div>
          <div class="match-scroll"><table><thead><tr><th>款图</th><th>款色</th><th>{{editing.type==='fabric'?'面料色':'辅料色'}}</th><th>色号</th><th>单价</th><th>图片</th></tr></thead><tbody>
            <tr v-for="c in displayColors" :key="c.colorway" :data-colorway="c.colorway"><td><button v-if="item.color_images?.[c.colorway]" type="button" @click="openImage(item.color_images[c.colorway],c.colorway)"><img :src="item.color_images[c.colorway]" alt="款图"></button><small v-else>暂无上传</small></td><td>{{c.colorway}}</td>
              <td><input aria-label="物料颜色" v-model="c.color_name" placeholder="输入颜色"></td><td><input aria-label="色号" v-model="c.color_no" placeholder="输入色号"></td>
              <td><div class="price-step"><button type="button" aria-label="降低单价" @click="stepPrice(c,-1)">−</button><input aria-label="单价" type="number" min="0" step="0.01" :value="c.price ?? editing.price" @input="applyColumn(c,'price',$event.target.value===''?null:Math.max(0,Number($event.target.value)))"><button type="button" aria-label="增加单价" @click="stepPrice(c,1)">＋</button></div></td>
              <td><ImageUpload :disabled="readonly" :model-value="c.image_url" size="lg" @update:model-value="applyColumn(c,'image_url',$event)" @uploading="uploadState(c.colorway,$event)"/></td></tr>
          </tbody></table></div>
        </main>
        <footer><template v-if="closingColors"><span>保存配色更改？</span><button type="button" @click="closingColors=false">继续编辑</button><button type="button" @click="discardColors">放弃更改</button></template><button v-else type="button" :disabled="uploadingColors.size>0" @click="closeColors">关闭</button><button type="button" class="confirm-match" :disabled="uploadingColors.size>0" @click="saveColors">确定</button></footer>
      </section>
    </div>

  </fieldset>
</template>
<script setup>
import {ref,reactive,computed,onMounted,watch,nextTick} from 'vue';
import {api} from '../api';
import {entryId} from '../utils/orderEntry';
import MaterialPicker from './MaterialPicker.vue';
import ImageUpload from './ImageUpload.vue';
import {openImage,viewer} from '../store/viewer';
const props=defineProps({item:Object,index:Number,readonly:Boolean,hideCrafts:Boolean});
const emit=defineEmits(['uploading']);
const fileUploads=ref(0);function trackFileUpload(active){emit('uploading',active);fileUploads.value=Math.max(0,fileUploads.value+(active?1:-1));}
defineExpose({busy:()=>fileUploads.value>0||!!editing.value});
const kinds=[{type:'fabric',title:'面料',label:'面料'},{type:'accessory',title:'辅料（拉链、扣子等）',label:'辅料'}];
const picker=reactive({open:false,type:'fabric',replaceKey:null}),editing=ref(null),craftTypes=ref([]),selectedCraft=ref('');
const addColorway=ref(''),colorDialog=ref(null),closingColors=ref(false),uploadingColors=ref(new Set());let originalColors='';
function uploadState(key,busy){emit('uploading',busy);const next=new Set(uploadingColors.value);if(busy)next.add(key);else next.delete(key);uploadingColors.value=next;}
function discardColors(){if(uploadingColors.value.size)return;editing.value=null;closingColors.value=false;}
function closeColors(){if(uploadingColors.value.size)return;if(JSON.stringify(editing.value)!==originalColors){closingColors.value=true;return;}discardColors();}
function onEditorEscape(e){if(viewer.open)return;e.preventDefault();e.stopPropagation();closeColors();}

props.item.material_groups ||= [];
const groups=type=>props.item.material_groups.filter(g=>g.type===type);
const groupRows=g=>props.item.materials.filter(m=>m.usage_group_id===g.id);
function addGroup(type){const g={id:entryId(),type,name:'',one_use:0,unit:''};props.item.material_groups.push(g);return g;}
function syncGroup(g){for(const m of groupRows(g)){m.usage_part=g.name;m.one_use=g.one_use;m.split_use=false;for(const c of m.colors||[]){c.qty=null;c.sizes=[];}}}
function removeGroup(g){if(!confirm('确认删除整个使用部位及组内物料、照片、配色资料？'))return;props.item.materials=props.item.materials.filter(m=>m.usage_group_id!==g.id);props.item.material_groups=props.item.material_groups.filter(x=>x.id!==g.id);}
watch(()=>props.item.materials,()=>{for(const m of props.item.materials){if(props.item.material_groups.some(g=>g.id===m.usage_group_id))continue;let g=groups(m.type).find(g=>g.name===(m.usage_part||'')&&Number(g.one_use)===Number(m.one_use||0)&&(!g.unit||g.unit===m.unit));if(!g)g=addGroup(m.type);g.name=m.usage_part||g.name;g.one_use=Number(m.one_use||0);g.unit=m.unit||'';m.usage_group_id=g.id;}},{deep:true,immediate:true});

const sizeNames=computed(()=>props.item.colors[0]?.sizes.map(s=>s.size)||[]);
const rows=type=>props.item.materials.filter(m=>m.type===type);
const visibleColors=m=>props.item.colors.filter(c=>!m.colors_configured||(m.colors||[]).some(x=>x.colorway===c.color));
const config=(m,color)=>m.colors.find(c=>c.colorway===color)||(m.shared_color && m.shared_config)||{};
function unitCost(m,color){const c=config(m,color);return Number(c.qty??m.one_use??0)*(1+Number(m.loss||0)/100)*100/Number(m.air_gap||100)*Number(c.price??m.price??0);}
function average(type){const qty=props.item.colors.reduce((n,c)=>n+c.sizes.reduce((a,s)=>a+Number(s.qty||0),0),0);if(!qty)return 0;return rows(type).reduce((n,m)=>n+visibleColors(m).reduce((a,c)=>a+c.sizes.reduce((b,s)=>{const cfg=config(m,c.color),special=cfg.sizes?.find(x=>x.size===s.size);return b+Number(s.qty||0)*Number(special?.one_use??cfg.qty??m.one_use??0)*(1+Number(m.loss||0)/100)*100/Number(m.air_gap||100)*Number(cfg.price??m.price??0);},0),0),0)/qty;}
function choose(type,groupId){const g=groupId?props.item.material_groups.find(g=>g.id===groupId):(groups(type)[0]||addGroup(type));Object.assign(picker,{open:true,type,replaceKey:null,groupId:g.id});}
function newArchive(type){window.open('/materials/new?type='+type,'_blank','noopener');}
function replace(m){Object.assign(picker,{open:true,type:m.type,replaceKey:m.key,groupId:m.usage_group_id});}
function fromArchive(a){return {key:entryId(),shared_color:a.type==='accessory',material_id:a.id,archive_version:a.version,type:a.type,role:a.type==='fabric'?'主料':'辅料',name:a.name,order_name:a.name,code:a.code,order_image_url:'',unit:a.unit||'',width:a.width||'',weight:a.weight||'',spec:a.spec||'',supplier:a.supplier||'',ingredient:a.composition||'',one_use:0,loss:0,price:0,air_gap:Number(String(a.air_gap||100).replace('%','')),usage_part:'',remark:'',colors:[],split_use:false};}
function picked(archives){if(picker.replaceKey&&archives.length!==1)return alert('替换时请选择一条物料');const g=props.item.material_groups.find(g=>g.id===picker.groupId);if(g&&archives.some(a=>g.unit&&g.unit!==a.unit)||new Set(archives.map(a=>a.unit)).size>1)return alert('同一使用部位的物料单位须一致，请分组添加');const fresh=archives.map(a=>({...fromArchive(a),usage_group_id:g.id,usage_part:g.name,one_use:g.one_use}));if(fresh.length)g.unit=fresh[0].unit;if(picker.replaceKey){const i=props.item.materials.findIndex(m=>m.key===picker.replaceKey);props.item.materials.splice(i,1,...fresh);}else props.item.materials.push(...fresh);picker.open=false;}
function remove(m){props.item.materials.splice(props.item.materials.indexOf(m),1);}
function copy(m){const c=JSON.parse(JSON.stringify(m));c.key=entryId();props.item.materials.splice(props.item.materials.indexOf(m)+1,0,c);}
function move(m,delta){const i=props.item.materials.indexOf(m),target=props.item.materials.map((x,n)=>({x,n})).filter(y=>y.x.type===m.type),j=target.findIndex(y=>y.n===i)+delta;if(j<0||j>=target.length)return;const k=target[j].n;[props.item.materials[i],props.item.materials[k]]=[props.item.materials[k],props.item.materials[i]];}
function editColors(m,color){expandedColors.value=false;pickerOpen.value=false;copyPrice.value=false;copyPhoto.value=false;closingColors.value=false;uploadingColors.value=new Set();addColorway.value='';editing.value=JSON.parse(JSON.stringify(m));editing.value.colors=props.item.colors.filter(c=>!m.colors_configured||m.colors.some(x=>x.colorway===c.color)).map(c=>{const cfg=config(m,c.color);return {...cfg,colorway:c.color,color_name:(cfg.color_no||'').includes(' / ')?cfg.color_no.split(' / ')[0]:'',color_no:(cfg.color_no||'').includes(' / ')?cfg.color_no.split(' / ').slice(1).join(' / '):(cfg.color_no||''),price:cfg.price??null,qty:cfg.qty??null,image_url:cfg.image_url||'',size_values:Object.fromEntries((cfg.sizes||[]).map(s=>[s.size,s.one_use]))};});const draft=editing.value;
  draft.shared_color=m.shared_color ?? (m.type==='accessory' && !m.colors_configured && !m.colors.length);
  draft.sharedDraft={...(draft.colors.find(c=>c.colorway===color)||draft.colors[0]||{}),colorway:'通配'};
  originalColors=JSON.stringify(draft);nextTick(()=>{colorDialog.value?.focus();if(color){const row=Array.from(colorDialog.value?.querySelectorAll('[data-colorway]')||[]).find(r=>r.dataset.colorway===color);row?.scrollIntoView({block:'nearest'});row?.querySelector('input')?.focus({preventScroll:true});}});}
watch(()=>props.item.colors.map(c=>c.color), colors=>{
  for(const material of props.item.materials){
    if(material.shared_color && material.shared_config){
      material.colors=colors.map(colorway=>({...material.shared_config,colorway}));
    }
  }
});
const expandedColors=ref(false), pickerOpen=ref(false), copyPrice=ref(false), copyPhoto=ref(false);
const displayColors=computed(()=>editing.value?.shared_color?[editing.value.sharedDraft]:editing.value?.colors||[]);
function applyColumn(row,field,value){
  if(!row)return;
  const copy=field==='price'?copyPrice.value:copyPhoto.value;
  for(const target of copy?displayColors.value:[row]) target[field]=value;
}
function stepPrice(row,step){
  applyColumn(row,'price',Math.max(0,Math.round((Number(row.price??editing.value.price??0)+step)*100)/100));
}
function toggleColor(colorway){
  const rows=editing.value.colors, index=rows.findIndex(c=>c.colorway===colorway);
  if(index>=0){rows.splice(index,1);return;}
  rows.push({colorway,color_name:'',color_no:'',price:copyPrice.value?rows[0]?.price:null,image_url:copyPhoto.value?rows[0]?.image_url:'',sizes:[]});
}
function switchShared(enabled){
  const draft=editing.value;
  if(enabled)draft.sharedDraft={...(draft.colors[0]||draft.sharedDraft),colorway:'通配'};
  else draft.colors=props.item.colors.map(c=>({...draft.sharedDraft,colorway:c.color}));
  draft.shared_color=enabled;pickerOpen.value=false;
}function saveColors(){if(uploadingColors.value.size)return;const draft=editing.value;if(draft.shared_color){
  draft.colors=props.item.colors.map(row=>({...draft.sharedDraft,colorway:row.color}));
}
for(const c of draft.colors){c.qty=null;c.sizes=[];c.color_no=[c.color_name?.trim(),c.color_no?.trim()].filter(Boolean).join(' / ');delete c.color_name;delete c.size_values;if(c.price==='')c.price=null;if(c.qty==='')c.qty=null;}const m=props.item.materials.find(x=>x.key===draft.key);m.shared_color=draft.shared_color;
m.colors=draft.colors;
m.shared_config=m.shared_color ? {...(draft.colors[0]||draft.sharedDraft)} : null;
m.colors_configured=!m.shared_color;editing.value=null;}
async function saveTemplate(){const name=prompt('辅料模板名称');if(!name?.trim())return;try{await api.saveOrderMaterialTemplate({name:name.trim(),materials:rows('accessory').map(m=>({material_id:m.material_id,one_use:m.one_use,loss:m.loss,price:m.price,usage_part:m.usage_part}))});alert('辅料模板已保存');}catch(e){alert(e.message);}}
async function chooseTemplate(){try{const ts=await api.orderMaterialTemplates();if(!ts.length)return alert('暂无辅料模板');const name=prompt('填写模板名称：\n'+ts.map(t=>t.name).join('\n'));const t=ts.find(t=>t.name===name);if(!t)return;const archives=await api.materials({type:'accessory'});for(const saved of t.materials){const a=archives.find(a=>a.id===saved.material_id&&a.status==='active');if(!a)throw new Error('模板中物料已停用或删除，请重新配置');}props.item.materials.push(...t.materials.map(s=>({...fromArchive(archives.find(a=>a.id===s.material_id)),...s})));}catch(e){alert(e.message);}}
function addCraft(){const c=craftTypes.value.find(x=>x.id===selectedCraft.value);if(c)props.item.crafts.push({craft_type_id:c.id,name:c.name,instruction:''});}
onMounted(async()=>{try{craftTypes.value=await api.craftTypes({status:'active'});}catch{}});
</script>

<style scoped>
.match-mask{position:fixed;inset:0;z-index:2000;background:#0004;display:flex;align-items:flex-start;justify-content:center;padding:8px 1vw;box-sizing:border-box}
.match-dialog{background:white;color:#606266;width:100%;max-height:96vh;overflow:auto;border:1px solid #aaa;border-radius:4px;box-shadow:0 1px 4px #0003;font:14px/1.5 Arial,sans-serif}
.match-dialog.expanded{position:fixed;inset:0;max-height:100vh;display:flex;flex-direction:column}.expanded main{flex:1}
.match-dialog header,.match-dialog footer{display:flex;align-items:center;padding:10px;gap:8px}.match-dialog header{justify-content:space-between;background:#f3f3f3;border-bottom:1px solid #ccc;height:48px;box-sizing:border-box}.match-dialog header button,.match-dialog td button{border:0;background:transparent;cursor:pointer}.match-dialog header button{font-size:20px;color:#72767b}
.match-dialog main{padding:20px 24px}.match-select,.match-switches,.match-switches label{display:flex;align-items:center;gap:12px}.match-select>b{width:82px}.match-picker{flex:1;position:relative}.picker-trigger{display:flex;align-items:center;gap:4px;flex-wrap:wrap;width:100%;padding:4px 8px;border:1px solid #dcdfe6;background:white;min-height:32px}.picker-trigger i{margin-left:auto}.picker-trigger span{background:#f2f3f5;padding:1px 6px}.picker-menu{position:absolute;background:white;z-index:1;max-height:200px;overflow:auto;padding:8px;box-shadow:0 2px 10px #0003}.picker-menu label{display:block}
.match-switches{justify-content:space-between;margin:24px 0;font-weight:600}.match-switches input{appearance:none;width:40px;height:20px;border-radius:12px;background:#dcdfe6;cursor:pointer;border:0}.match-switches input:before{content:'';display:block;width:16px;height:16px;margin:2px;border-radius:50%;background:white}.match-switches input:checked{background:#1989fa}.match-switches input:checked:before{transform:translateX(20px)}
.match-scroll{overflow:auto}.match-scroll table{width:100%;min-width:720px;border-collapse:collapse;text-align:center;table-layout:fixed}.match-scroll th,.match-scroll td{border:1px solid #dfe6ef;padding:8px;text-align:center}.match-scroll th{height:40px;background:#f8f8f8}.match-scroll th:first-child{width:7.5%}.match-scroll th:nth-child(2){width:10%}.match-scroll td{background:#f5f8fb;height:106px}.match-scroll td>input,.price-step input{width:100%;min-width:0;height:35px;border:1px solid #dcdfe6;border-radius:3px;padding:0 8px;box-sizing:border-box}.match-scroll img{max-width:80px;max-height:80px}.price-step{display:flex;align-items:center}.price-step input{text-align:center;appearance:textfield}.price-step input::-webkit-inner-spin-button{appearance:none}.price-step button{height:32px;min-width:30px;border:1px solid #dcdfe6!important}.match-scroll td:last-child>:first-child{margin:auto}
.match-dialog footer{justify-content:flex-end;border-top:1px solid #ccc;padding:10px 16px}.match-dialog footer button{height:32px;border:1px solid #dcdfe6;background:white;border-radius:3px;padding:0 15px;cursor:pointer}.match-dialog footer .confirm-match{color:white;background:#1989fa;border-color:#1989fa}
</style>