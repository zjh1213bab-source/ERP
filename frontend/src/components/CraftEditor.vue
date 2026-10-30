<template>
  <div class="ce" :class="{ ro: disabled }">
    <div v-for="grp in GROUPS" :key="grp.key" class="ce-grp">
      <div class="ce-head">
        <strong>{{ grp.label }}</strong>
        <span class="ce-quick">
          常用工序：
          <button
            v-for="t in craftTypes" :key="t.id" type="button" class="ce-tag"
            :disabled="disabled" @click="addRow(grp.key, t)"
          >{{ t.name }}</button>
          <span v-if="!craftTypes.length" class="ce-none">
            工序档案为空，可先到「档案 → 工序类别」建立，或直接点「＋ 添加一行」手填
          </span>
        </span>
        <span class="ce-ratio">
          工价倍数
          <input class="input ce-ratio-in" type="number" step="0.1" :value="groupRatio(grp.key)"
                 :disabled="disabled" @input="setGroupRatio(grp.key, $event.target.value)" />
          <span class="ce-hint">改这里同步到本组所有行</span>
        </span>
      </div>

      <div class="ce-scroll">
        <table class="data ce-tbl">
          <thead>
            <tr>
              <th style="width: 34px">#</th>
              <th style="width: 92px">类别</th>
              <th style="min-width: 150px">工序名称</th>
              <th style="width: 84px">单价</th>
              <th style="width: 74px">倍率</th>
              <th style="width: 84px">倍率单价</th>
              <th style="width: 84px">负责人</th>
              <th style="min-width: 120px">备注</th>
              <th style="width: 46px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in rowsOf(grp.key)" :key="i">
              <td class="center">{{ i + 1 }}</td>
              <td><input class="input mini" v-model="row.category" :disabled="disabled" /></td>
              <td><input class="input mini" v-model="row.name" :disabled="disabled" placeholder="工序名称" /></td>
              <td><input class="input mini" type="number" step="0.01" v-model.number="row.price" :disabled="disabled" /></td>
              <td><input class="input mini" type="number" step="0.1" v-model.number="row.ratio" :disabled="disabled" /></td>
              <td class="num">{{ money(row.price * row.ratio) }}</td>
              <td><input class="input mini" v-model="row.owner" :disabled="disabled" /></td>
              <td><input class="input mini" v-model="row.remark" :disabled="disabled" /></td>
              <td class="center">
                <button v-if="!disabled" type="button" class="link-btn danger" @click="delRow(grp.key, i)">删</button>
              </td>
            </tr>
            <tr v-if="!rowsOf(grp.key).length">
              <td colspan="9" class="empty-cell">
                暂无工序 —— 点上面的常用工序，或「＋ 添加一行」手填
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="ce-foot">
        <button v-if="!disabled" type="button" class="btn btn-ghost btn-sm" @click="addRow(grp.key)">＋ 添加一行</button>
        <span class="ce-sum">
          {{ rowsOf(grp.key).length }} 道工序 · 倍率单价合计 <strong>¥{{ money(totalOf(grp.key)) }}</strong>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 工序明细编辑器（开发单里「工艺工序」的展开填写）
 * ============================================================
 * 结构与「订单工序」页（打版流程 craft 阶段）**完全一致**：
 * 两组（车缝 / 后整），行字段 category / name / price / ratio / owner / remark / open_price。
 *
 * ## 为什么不在这里各存一份数据
 *
 * 父组件把这个对象直接交给开发单接口，接口写的是**打版流程 craft 阶段的 data** ——
 * 也就是说：这里填的工序，去打版页「工艺/工序明细」能看到同一份；
 * 打版页改了，这里再打开也是改后的。避免"开发单一套、订单工序另一套"。
 *
 * ## 为什么直接改 props 里的数组
 *
 * `modelValue` 是父组件持有的响应式对象，行内输入框 v-model 直接改数组元素，
 * 保存时父组件取同一份对象即可。这在本仓库是既有写法（PatternBoard 的工序表同样处理），
 * 换成逐行 emit 只会让"输入一个字触发一次父级更新"，对这类中小规模表格没有收益。
 */
import { ref, onMounted } from 'vue';
import { api } from '../api';

const props = defineProps({
  modelValue: { type: Object, default: () => ({ sewing: [], finish: [] }) },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['change']);

const GROUPS = [
  { key: 'sewing', label: '车缝工序', cat: '车缝' },
  { key: 'finish', label: '后整工序', cat: '后整' }
];
const CAT_LABEL = {
  sewing: '车缝', print: '印花', embroidery: '绣花', wash: '洗水',
  finish: '后整', pack: '包装', other: '其他'
};

const craftTypes = ref([]);
const money = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);

function rowsOf(k) {
  if (!Array.isArray(props.modelValue[k])) props.modelValue[k] = [];
  return props.modelValue[k];
}

function groupRatio(k) {
  const list = rowsOf(k);
  const withRatio = list.find((r) => Number(r.ratio) > 0);
  return withRatio ? withRatio.ratio : 1;
}

function setGroupRatio(k, v) {
  const n = Number(v) || 0;
  rowsOf(k).forEach((r) => { r.ratio = n; });
  emit('change');
}

function addRow(k, tpl) {
  const grp = GROUPS.find((g) => g.key === k);
  rowsOf(k).push({
    category: tpl ? (CAT_LABEL[tpl.category] || tpl.category || grp.cat) : grp.cat,
    name: tpl ? tpl.name : '',
    price: tpl ? Number(tpl.default_price) || 0 : 0,
    ratio: groupRatio(k),
    owner: '',
    remark: '',
    open_price: 0
  });
  emit('change');
}

function delRow(k, i) {
  rowsOf(k).splice(i, 1);
  emit('change');
}

function totalOf(k) {
  return rowsOf(k).reduce((s, r) => s + (Number(r.price) || 0) * (Number(r.ratio) || 0), 0);
}

onMounted(async () => {
  try { craftTypes.value = (await api.craftTypes({ status: 'active' })) || []; }
  catch (e) { craftTypes.value = []; }
});
</script>

<style scoped>
.ce-grp { border: 1px solid #eef2f7; border-radius: 10px; padding: 10px; margin-bottom: 10px; background: #fcfdff; }
.ce-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ce-head strong { font-size: 13px; }
.ce-quick { font-size: 12px; color: #5b6474; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ce-tag {
  border: 1px solid #d9e2ef; background: #fff; border-radius: 10px;
  padding: 1px 8px; font-size: 11.5px; color: #33415a; cursor: pointer;
}
.ce-tag:hover:not(:disabled) { border-color: #6f9bff; color: #1d39c4; }
.ce-none { color: #8a94a6; font-size: 11.5px; }
.ce-ratio { margin-left: auto; font-size: 12px; color: #5b6474; display: flex; align-items: center; gap: 6px; }
.ce-ratio-in { width: 64px; }
.ce-hint { color: #a0a8b8; font-size: 11px; }
.ce-scroll { overflow: auto; max-height: 30vh; border: 1px solid #eef2f7; border-radius: 8px; background: #fff; }
.ce-tbl { border: none; }
.ce-tbl th, .ce-tbl td { padding: 4px 6px; font-size: 12px; white-space: nowrap; }
.ce-tbl .mini { padding: 2px 4px; height: 26px; font-size: 12px; }
.ce-foot { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.ce-sum { font-size: 12px; color: #8a94a6; margin-left: auto; }
.ce.ro .ce-tbl { opacity: 0.85; }
</style>
