<template>
 <section id="wage-multipliers" class="panel-card wage-settings">
  <div class="wage-head"><div><h3>工价倍率</h3><p class="sub">按同一订单、同一款式、同一颜色的合计件数匹配；尺码合并计算，拆扎不改变档位。</p></div><label><input type="checkbox" v-model="enabled" :disabled="!editable" /> 启用倍率</label></div>
  <p v-if="error" class="form-msg err" role="alert">{{error}}</p><p v-if="message" class="form-msg ok" role="status">{{message}}</p>
  <fieldset class="process-scope"><legend>参与倍率的工序范围</legend>
   <div class="scope-mode"><label><input type="radio" v-model="processScope.mode" value="all" :disabled="!editable" /> 全部工序参与</label><label><input type="radio" v-model="processScope.mode" value="selected" :disabled="!editable" /> 仅勾选工序参与</label></div>
   <template v-if="processScope.mode==='selected'">
    <p class="sub">可按类别勾选全部工序，也可单独选择具体工序；未选中的按1倍基础价计件。全部不选表示没有工序参与。</p>
    <div class="scope-checks"><label v-for="c in processCatalog.categories" :key="c.code"><input type="checkbox" v-model="processScope.categories" :value="c.code" :disabled="!editable" />{{c.label}}类全部工序</label></div>
    <details open><summary>单独选择生产流程工序</summary><div class="scope-checks"><label v-for="n in processCatalog.nodes" :key="n.code"><input type="checkbox" v-model="processScope.node_codes" :value="n.code" :disabled="!editable" />{{n.name}}<small v-if="processScope.categories.includes(n.category)">（所属类别已参与）</small></label></div></details>
    <details open><summary>单独选择工序类别档案</summary><div class="scope-checks"><label v-for="c in processCatalog.craft_types" :key="c.id"><input type="checkbox" v-model="processScope.craft_type_ids" :value="c.id" :disabled="!editable||(c.status!=='active'&&!processScope.craft_type_ids.includes(c.id))" />{{c.name}} · {{categoryName(c.category)}}<small v-if="c.status!=='active'">（已停用）</small><small v-else-if="processScope.categories.includes(c.category)">（所属类别已参与）</small></label><span v-if="!processCatalog.craft_types.length" class="sub">暂无工序档案，可先在“工序类别”中新增。</span></div></details>
   </template>
   <p v-else class="sub">当前所有工序均按颜色件数使用倍率。切换为“仅勾选工序参与”后可限制范围。</p>
  </fieldset>
  <table class="data"><thead><tr><th>颜色件数起</th><th>颜色件数止</th><th>倍率</th><th v-if="editable">操作</th></tr></thead><tbody>
   <tr v-for="(tier,i) in tiers" :key="i"><td><input class="input" type="number" min="1" step="1" v-model.number="tier.min" :disabled="!editable" /></td><td><input class="input" type="number" min="1" step="1" v-model.number="tier.max" placeholder="不限（最后一档）" :disabled="!editable" /></td><td><input class="input" type="number" min="0.000001" max="100" step="0.01" v-model.number="tier.multiplier" :disabled="!editable" /></td><td v-if="editable"><button class="link-btn danger" :disabled="tiers.length===1||saving" @click="tiers.splice(i,1)">删除档位</button></td></tr>
  </tbody></table>
  <div class="wage-actions"><button v-if="editable" class="btn btn-ghost" @click="add">＋ 增加档位</button><button v-if="editable" v-action="['settings','piece-multipliers']" class="btn btn-primary" :disabled="saving||loading" @click="save">{{saving?'保存中…':'保存工价倍率'}}</button><button class="btn btn-ghost" :disabled="saving" @click="load">重新读取</button><span class="sub">版本 {{revision}} · 仅影响之后的新报工</span></div>
  <p class="sub">最终单价 = 基础工价 × 倍率。例如 0.4 × 1.2 = 0.48 元/件。基础工价从计件单价维护读取；未配单价显示“待维护”，不会按零算工钱。</p>
  <p class="sub">档位从1件起连续、不重叠，最后一档上限留空。关闭后新报工按1倍计价，历史报工和已确认工资保留原快照。</p>
 </section>
</template>
<script setup>
import {ref,onMounted} from 'vue';
import {api} from '../api';
import {hasRole} from '../store/auth';
const processScope=ref({mode:'all',categories:[],craft_type_ids:[],node_codes:[]}),processCatalog=ref({categories:[],nodes:[],craft_types:[]});
const categoryName=code=>processCatalog.value.categories.find(c=>c.code===code)?.label||code;
const editable=hasRole('admin'),tiers=ref([]),enabled=ref(true),revision=ref(0),loading=ref(true),saving=ref(false),error=ref(''),message=ref('');
function apply(d){processScope.value={...d.process_scope,categories:[...d.process_scope.categories],craft_type_ids:[...d.process_scope.craft_type_ids],node_codes:[...d.process_scope.node_codes]};processCatalog.value=d.process_catalog;tiers.value=d.tiers.map(t=>({...t,max:t.max??''}));enabled.value=d.enabled;revision.value=d.revision;}
async function load(){loading.value=true;error.value='';try{apply(await api.wageMultipliers());}catch(e){error.value=e.message;}finally{loading.value=false;}}
function add(){const last=tiers.value.at(-1);if(last?.max===''||last?.max===null){error.value='请先填写上一档的上限，再增加档位';return;}tiers.value.push({min:last?Number(last.max)+1:1,max:'',multiplier:1});}
async function save(){saving.value=true;error.value='';message.value='';try{apply(await api.saveWageMultipliers({revision:revision.value,enabled:enabled.value,process_scope:processScope.value,tiers:tiers.value.map(t=>({min:t.min,max:t.max===''?null:t.max,multiplier:t.multiplier}))}));message.value='工价倍率已保存，新报工按此规则计价';}catch(e){error.value=e.message;}finally{saving.value=false;}}
onMounted(load);
</script>
<style scoped>
.process-scope{border:1px solid var(--border);border-radius:10px;padding:16px;margin:16px 0}.scope-mode,.scope-checks{display:flex;flex-wrap:wrap;gap:12px 18px}.scope-checks{padding:12px 0}.scope-mode label,.scope-checks label{display:inline-flex;align-items:center;gap:7px;color:var(--text);font-size:13px}.scope-checks small{color:var(--text-muted)}.process-scope details{border-top:1px solid var(--border);padding-top:12px;margin-top:12px}.process-scope summary{cursor:pointer;color:var(--text)}.wage-settings{scroll-margin-top:24px}.wage-head,.wage-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.wage-actions{justify-content:flex-start;margin-top:16px}.wage-settings table{max-width:900px}.wage-settings input.input{width:100%;max-width:210px}.wage-head>label{white-space:nowrap;color:var(--text)}.wage-settings input[type=checkbox]{accent-color:var(--brand)}
</style>
