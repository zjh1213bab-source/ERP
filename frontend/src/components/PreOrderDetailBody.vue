<template>
  <details v-for="group in groups" :key="group.key" open class="detail-group">
    <summary>{{group.label}} · {{group.items.length}} 款</summary>
    <nav v-if="group.items.length" class="style-tabs" :aria-label="group.label">
      <button v-for="(item,index) in group.items" :key="item.id ?? index" type="button"
        :aria-pressed="index===selected[group.key]" @click="selected[group.key]=index">
        <img v-if="item.effect_image_url" :src="item.effect_image_url" alt="" data-no-image-preview>
        {{item.style_no || item.product_name || '未命名款式'}}
      </button>
    </nav>
    <article v-if="group.active" :key="group.active.id" class="detail-style">
      <StyleImageFields readonly :effect-image-url="group.active.effect_image_url" :detail-images="group.active.detail_images || []" />
      <dl class="field-grid">
        <div><dt>款式来源</dt><dd>{{group.active.source_type==='archive'?'已完成打版商品':group.active.source_type==='legacy'?'原有款式资料':'上传图片新款'}}</dd></div>
        <div><dt>款式名称</dt><dd>{{group.active.product_name || '—'}}</dd></div>
        <div><dt>款号</dt><dd>{{group.active.style_no || '—'}}</dd></div>
        <div><dt>预估数量</dt><dd>{{group.active.expected_qty ?? '—'}}</dd></div>
        <div><dt>款式要求 / 备注</dt><dd>{{group.active.remark || '—'}}</dd></div>
      </dl>
      <PreOrderArchiveMatrix :item="group.active" disabled hide-product :show-remove="false"/>
      <p v-if="group.active.matrix_meta?.crafts?.length">历史工艺：{{group.active.matrix_meta.crafts.join('、')}}</p>
      <p v-if="group.active.matrix_meta?.craft_note">工艺要求：{{group.active.matrix_meta.craft_note}}</p>
      <router-link v-if="group.active.development?.flow_id" :to="{path:'/pattern-board',query:{techpack:group.active.development.id}}">查看打版流程</router-link>
    </article>
  </details>
  <section class="detail-group">
    <h3>基础信息</h3>
    <dl class="field-grid">
      <div v-for="[key,label] in fields" :key="key"><dt>{{label}}</dt><dd>{{row[key] ?? '—'}}</dd></div>
      <div><dt>约定付款金额（USD）</dt><dd>{{row.total_usd!=null && row.payment_ratio!=null ? (row.total_usd*row.payment_ratio/100).toFixed(2) : '—'}}</dd></div>
      <div class="wide"><dt>订单 / 客户要求</dt><dd>{{row.requirements || '—'}}</dd></div>
    </dl>
    <h4>付款凭证</h4><PreOrderPaymentProofs :model-value="row.payment_proofs || []" readonly/>
  </section>
</template>
<script setup>
import {computed,reactive} from 'vue';
import {omitEmptyOrderSizes} from '../utils/preOrderMatrixTransfer';
import StyleImageFields from './StyleImageFields.vue';
import PreOrderArchiveMatrix from './PreOrderArchiveMatrix.vue';
import PreOrderPaymentProofs from './PreOrderPaymentProofs.vue';
const props=defineProps({row:{type:Object,required:true}});
const selected=reactive({archive:0,new:0});
const items=computed(()=>JSON.parse(JSON.stringify(props.row.items || [])).map(omitEmptyOrderSizes));
const groups=computed(()=>[['archive','1　选择样衣'],['new','2　上传图片新款']].map(([key,label])=>{
  const list=items.value.filter(item=>(item.source_type==='archive')===(key==='archive'));
  return {key,label,items:list,active:list[selected[key]] || list[0]};
}));
const fields=[['order_no','订单号'],['pre_order_no','预下单编号'],['customer_name','客户名称'],['customer_id','客户档案编号'],['manager','业务员'],['recipient_name','联系人'],['recipient_phone','电话'],['shipping_address','收货地址'],['target_date','目标交期'],['designer','设计师'],['category','分类'],['series','系列'],['wave','波段'],['sample_source','样品来源'],['po_no','PO单号'],['total_usd','订单总金额（USD）'],['payment_ratio','付款比例（%）']];
</script>
<style scoped>
.detail-group{border:1px solid var(--line);border-radius:4px;margin-bottom:16px;padding:14px;min-width:0}
.detail-group summary,.detail-group h3{font-weight:600;background:var(--surface-2);padding:10px;margin:0}.detail-group summary{cursor:pointer}
.style-tabs{display:flex;gap:8px;overflow-x:auto;padding:12px 0}.style-tabs button{display:flex;align-items:center;gap:8px;flex:none;padding:6px 12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:4px}.style-tabs button[aria-pressed=true]{border-color:var(--brand);color:var(--brand)}.style-tabs img{width:32px;height:40px;object-fit:contain}
.field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:12px}.field-grid dt{color:var(--ink-mute);margin-bottom:4px}.field-grid dd{margin:0;padding:8px;border:1px solid var(--line);min-height:32px;white-space:pre-wrap;overflow-wrap:anywhere}.wide{grid-column:1/-1}
</style>
