<template>
  <div class="style-entry">
    <div class="matrix-tools">
      <label>颜色</label><OrderAxisSelect :model-value="item.colors.map(c=>c.color)" :options="colorOptions" label="颜色" kind="colors" :max="60" @update:model-value="applyColors"/><button class="link" @click="configure('colors')">管理</button>
      <label>尺码</label><OrderAxisSelect :model-value="sizes" :options="sizeOptions" label="尺码" kind="sizes" :max="30" @update:model-value="applySizes"/><button class="link" @click="configure('sizes')">管理</button>
      <button class="link" @click="templateOpen=true">选择模板</button><button class="link" @click="saveTemplate()">保存模板</button>
      <label class="toggle">行复制 <input type="checkbox" v-model="rowCopy" @change="colCopy=false" /></label><label class="toggle">列复制 <input type="checkbox" v-model="colCopy" @change="rowCopy=false" /></label>
      <label class="toggle">分码分色分价 <input type="checkbox" v-model="item.split_price" /></label>
      <label>默认币种</label><select v-model="item.currency"><option value="USD">美元</option><option value="CNY">人民币</option></select>
    </div>
    <div class="color-pictures"><b>颜色图片</b><div class="picture-strip"><div v-for="c in item.colors" :key="c.color"><span>{{c.color}}</span><ImageUpload v-model="item.color_images[c.color]" /></div></div></div>
    <div class="matrix-main">
      <div class="style-identity"><ImageUpload v-model="item.effect_image_url" /><input v-model="item.style_no" placeholder="款号（版房填写）" /><input v-model="item.product_name" placeholder="款式名称" /><button class="link" @click="imagesOpen=true">款式 / 细节图</button></div>
      <div class="quantity-scroll"><table class="quantity-table"><thead><tr><th>颜色/尺码</th><th v-for="s in sizes" :key="s">{{s}}</th><th class="sum">合计</th></tr><tr><th>客户尺码</th><th v-for="s in sizes" :key="s"><input v-model="item.customer_sizes[s]" placeholder="客户尺码" /></th><th></th></tr></thead>
        <tbody><tr v-for="c in item.colors" :key="c.color"><th>{{c.color}}</th><td v-for="s in c.sizes" :key="s.size"><input type="number" min="0" step="1" v-model.number="s.qty" @change="copyQty(c,s)" :aria-label="c.color+' '+s.size+' 数量'"/><input v-if="item.split_price" class="cell-price" type="number" min="0" step="0.01" v-model.number="s.entry_price" :placeholder="'单价 '+item.currency" /></td><td class="sum">{{quantity(c.sizes)}}</td></tr></tbody>
        <tfoot><tr><th>合计</th><td v-for="s in sizes" :key="s" class="sum">{{item.colors.reduce((n,c)=>n+Number(c.sizes.find(x=>x.size===s)?.qty||0),0)}}</td><td class="sum">{{totalQty}}</td></tr></tfoot></table></div>
      <div v-if="item.stock_open" class="stock-reference"><div>库存参考 <b>{{stockError?'—':stockTotal}}</b><button class="link" @click="item.stock_open=false">‹ 收起</button></div><div class="stock-scroll"><table class="quantity-table"><thead><tr><th>颜色/尺码</th><th v-for="s in sizes" :key="s">{{s}}</th></tr></thead><tbody><tr v-for="c in item.colors" :key="c.color"><th>{{c.color}}</th><td v-for="s in sizes" :key="s">{{stockAt(c.color,s)}}</td></tr></tbody></table></div><small v-if="stockError">{{stockError}}</small></div>
      <button v-else class="link stock-expand" @click="item.stock_open=true">展开库存参考</button>
    </div>
    <div class="item-summary"><button class="link danger" @click="$emit('remove')">删除</button><label>销售单价 <input type="number" v-model.number="item.unit_price" min="0" step="0.01" /></label><label>币种 <select v-model="item.currency"><option value="USD">美元</option><option value="CNY">人民币</option></select></label><label>税率% <input type="number" v-model.number="item.tax_rate" min="0" max="100" /></label><span>下单数量 <strong>{{totalQty}}</strong></span><span>商品金额 USD <strong class="orange">{{amount.toFixed(2)}}</strong></span></div>
    <BusinessRequirement v-model="item.business_requirement"/>
    <SalesOrderMaterials :item="item" :index="index" />
    <div v-if="edit.open" class="entry-dialog-mask"><section class="entry-dialog"><h3>管理{{edit.kind==='colors'?'颜色':'尺码'}}</h3><p>每行一个；修改只影响本单。删除已有数量的颜色或尺码会要求确认。</p><textarea v-model="edit.text" rows="12"/><footer><button @click="edit.open=false">取消</button><button class="primary" @click="applyConfig()">确定</button></footer></section></div>
    <div v-if="templateOpen" class="entry-dialog-mask"><section class="entry-dialog"><h3>选择尺码模板</h3><button v-for="t in templates" :key="t.id" class="template-option" @click="applySizes(String(t.sizes).split(','))&&(templateOpen=false)">{{t.name}}</button><p v-if="!templates.length">暂无模板，可先管理尺码后保存模板。</p><footer><button @click="templateOpen=false">关闭</button></footer></section></div>
    <div v-if="imagesOpen" class="entry-dialog-mask"><section class="entry-dialog"><h3>款式图片</h3><StyleImageFields v-model:effect-image-url="item.effect_image_url" v-model:detail-images="item.detail_images"/><footer><button @click="imagesOpen=false">完成</button></footer></section></div>
  </div>
</template>
<script setup>
import BusinessRequirement from './BusinessRequirement.vue';
import {orderColorOptions} from '../utils/orderOptions';
import {computed,reactive,ref} from 'vue';
import {api} from '../api';
import ImageUpload from './ImageUpload.vue';
import StyleImageFields from './StyleImageFields.vue';
import SalesOrderMaterials from './SalesOrderMaterials.vue';
import OrderAxisSelect from './OrderAxisSelect.vue';
const props=defineProps({item:Object,index:Number,stock:Array,stockError:String,rate:Number,templates:Array});const emit=defineEmits(['remove','templates-changed']);
const rowCopy=ref(false),colCopy=ref(false),templateOpen=ref(false),imagesOpen=ref(false),edit=reactive({open:false,kind:'',text:''});
const colorOptions=orderColorOptions;
const sizeOptions=['XS','S','M','L','XL','2XL','3XL','4XL','5XL','NB','0-3M','3-6M','6-12M','12-18M','18-24M','2T','3T','4T','5-6T','6-7T','7-8T','8-9T','9-10T','10-12T','12-14T','14-16T','16T'];
const sizes=computed(()=>props.item.colors[0]?.sizes.map(s=>s.size)||[]);
const quantity=rows=>rows.reduce((n,s)=>n+Number(s.qty||0),0);
const totalQty=computed(()=>props.item.colors.reduce((n,c)=>n+quantity(c.sizes),0));
const amount=computed(()=>Math.round(props.item.colors.reduce((n,c)=>n+c.sizes.reduce((m,s)=>m+Math.round(Number(s.qty||0)*Number(props.item.split_price?(s.entry_price??props.item.unit_price):props.item.unit_price)/(props.item.currency==='CNY'?props.rate:1)*100)/100,0),0)*100)/100);
const stockRows=computed(()=>props.item.style_no?(props.stock||[]).filter(r=>r.style_no===props.item.style_no):[]);
const stockTotal=computed(()=>stockRows.value.reduce((n,s)=>n+Number(s.qty||0),0));
function stockAt(color,size){return props.stockError?'—':stockRows.value.filter(s=>s.color===color&&s.size===size).reduce((n,s)=>n+Number(s.qty||0),0);}
function configure(kind){Object.assign(edit,{open:true,kind,text:(kind==='colors'?props.item.colors.map(c=>c.color):sizes.value).join('\n')});}
function applySizes(names){const next=[...new Set(names.map(n=>n.trim()).filter(Boolean))];if(!next.length||next.length>30||next.some(n=>n.length>60)){alert('请保留1–30个尺码，名称最多60字');return false;}if(sizes.value.some(s=>!next.includes(s)&&(props.item.customer_sizes[s]||props.item.colors.some(c=>Number(c.sizes.find(x=>x.size===s)?.qty||0)>0)||props.item.materials.some(m=>(m.colors||[]).some(c=>(c.sizes||[]).some(x=>x.size===s)))))&&!confirm('移除尺码会删除对应数量、客户尺码及分码资料，确认继续？'))return false;props.item.colors.forEach(c=>{c.sizes=next.map(size=>c.sizes.find(s=>s.size===size)||{size,qty:0,entry_price:null});});cleanupAxes();return true;}
function applyColors(names){const next=[...new Set(names.map(n=>n.trim()).filter(Boolean))];if(!next.length||next.length>60||next.some(n=>n.length>60)){alert('请保留1–60种颜色，名称最多60字');return false;}if(props.item.colors.some(c=>!next.includes(c.color)&&(quantity(c.sizes)>0||props.item.color_images[c.color]||props.item.materials.some(m=>(m.colors||[]).some(x=>x.colorway===c.color&&(x.image_url||x.color_no||x.price!=null||x.qty!=null||(x.sizes||[]).length)))))&&!confirm('移除颜色会删除对应数量、图片及物料配色资料，确认继续？'))return false;const ss=[...sizes.value];props.item.colors=next.map(color=>props.item.colors.find(c=>c.color===color)||{color,sizes:ss.map(size=>({size,qty:0,entry_price:null}))});cleanupAxes();return true;}
function applyConfig(){const names=edit.text.split(/[\n,，]/);if((edit.kind==='sizes'?applySizes(names):applyColors(names)))edit.open=false;}
function cleanupAxes(){const colors=props.item.colors.map(c=>c.color),ss=sizes.value;for(const key of Object.keys(props.item.color_images))if(!colors.includes(key))delete props.item.color_images[key];for(const key of Object.keys(props.item.customer_sizes))if(!ss.includes(key))delete props.item.customer_sizes[key];for(const m of props.item.materials){m.colors=(m.colors||[]).filter(c=>colors.includes(c.colorway));for(const c of m.colors)c.sizes=(c.sizes||[]).filter(s=>ss.includes(s.size));}}
function copyQty(c,s){if(rowCopy.value)c.sizes.forEach(x=>x.qty=s.qty);if(colCopy.value)props.item.colors.forEach(x=>{const cell=x.sizes.find(y=>y.size===s.size);if(cell)cell.qty=s.qty;});}
async function saveTemplate(){const name=prompt('尺码模板名称');if(!name?.trim())return;try{await api.createSizeTemplate({name:name.trim(),sizes:sizes.value});emit('templates-changed');alert('模板已保存');}catch(e){alert(e.message);}}
</script>
