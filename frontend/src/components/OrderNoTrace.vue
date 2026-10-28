<template>
  <div v-if="modelValue" class="modal-mask" @click.self="close">
    <div class="modal trc-modal">
      <div class="modal-head">
        <h3>订单号反查</h3>
        <button class="x" @click="close">×</button>
      </div>

      <div class="modal-body">
        <div class="trc-bar">
          <input ref="inp" class="input mono" v-model="no" :placeholder="'输入完整订单号，如 ' + (hint || 'CUST-PO-2026001')"
            @keyup.enter="run" />
          <button class="btn btn-primary" :disabled="busy || no.trim().length < 2" @click="run">
            {{ busy ? '查询中…' : '反查' }}
          </button>
        </div>

        <div class="trc-intro">
          订单号是业务手填的，<b>敲错一位就会挂到别人的单上</b>。这里查的是全流程：
          采购、排产、裁床、领料、计件、售后 —— 只要挂着这个号，都会列出来。
        </div>

        <!-- ① 这个号存在 -->
        <template v-if="res && res.found">
          <div class="trc-flag ok">
            <span class="trc-dot"></span>
            <b>这个号在系统里</b>
            <span class="mono trc-no">{{ res.order.order_no }}</span>
            <span class="tag" :class="tagOf(res.order.status)">{{ statusLabel(res.order.status) }}</span>
          </div>

          <div class="trc-grid">
            <div><label>客户</label><span>{{ res.order.customer_name || '—' }}</span></div>
            <div><label>款名</label><span>{{ res.order.style_name || '—' }}</span></div>
            <div><label>下单日期</label><span>{{ fmtDate(res.order.order_date) }}</span></div>
            <div><label>挂着单据</label><span><b>{{ res.total }}</b> 条</span></div>
          </div>

          <div v-if="!res.chains.length" class="trc-mut">
            这张单目前没有任何下游单据 —— 还没排产、没领料、没采购。改号只影响订单本身。
          </div>
          <table v-else class="data trc-tbl">
            <thead>
              <tr><th style="width:110px">环节</th><th style="width:70px">条数</th><th>样例单号</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in res.chains" :key="c.table">
                <td>{{ c.label }}</td>
                <td><b>{{ c.rows }}</b></td>
                <td class="mono trc-samples">{{ c.samples.length ? c.samples.join('、') : '该环节本身不发单号' }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ② 下游挂着单、订单主表却没有 —— 数据不一致，不能说成「查无此单」 -->
        <template v-else-if="res && res.orphan">
          <div class="trc-flag warn">
            <b>这个号「有单没主」</b>
          </div>
          <div class="trc-box warn">
            下游挂着 <b>{{ res.total }}</b> 条记录，但<b>订单主表里查不到这个号</b>。
            这不是「查无此单」，是数据不一致 —— 常见于改号中途失败、历史导入残缺、
            或有人绕过系统直接改库。
            <div class="trc-sub">请交给管理员核对。不要自己新建一张同号订单来「补上」，那会把下游单据指到另一张单上。</div>
          </div>
          <table class="data trc-tbl">
            <thead>
              <tr><th style="width:110px">环节</th><th style="width:70px">条数</th><th>样例单号</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in res.chains" :key="c.table">
                <td>{{ c.label }}</td>
                <td><b>{{ c.rows }}</b></td>
                <td class="mono trc-samples">{{ c.samples.length ? c.samples.join('、') : '该环节本身不发单号' }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ③ 查不到：给相近号 -->
        <template v-else-if="res">
          <div class="trc-flag miss">
            <b>系统里没有这个号</b>
            <span class="mono trc-no">{{ res.input }}</span>
          </div>

          <template v-if="res.similar.length">
            <div class="trc-sub2">是敲错了吗？下面这几个号只差 1~2 个字符：</div>
            <div class="trc-sim">
              <a v-for="s in res.similar" :key="s.id" class="trc-sim-item" @click="pick(s.order_no)">
                <b class="mono">{{ s.order_no }}</b>
                <span class="trc-sim-meta">{{ s.customer_name || '无客户' }} · {{ statusLabel(s.status) }} · 差 {{ s.diff }} 位</span>
              </a>
            </div>
            <div class="trc-sub">点一下换成那个号重新查 —— 只换输入框，不会替你改任何数据。</div>
          </template>
          <div v-else class="trc-mut">
            也没有相近的号。可能是这单还没录进系统，或者客户号还没转成系统订单。
          </div>
        </template>

        <!-- ④ 还没查 -->
        <div v-else class="trc-mut" style="padding:18px 0">输入订单号后按回车，或等输入停下自动查。</div>
      </div>

      <!-- 按钮固定在弹窗底部，不跟着内容滚：
           放在 body 里时，矮屏（820 高）上 body 内容比可视区高，按钮被挤到滚动区外面，
           用户查完却找不到「打开这张订单」—— 而这一步才是查完之后真正要做的事 -->
      <div class="modal-foot">
        <button class="btn btn-ghost" @click="close">关闭</button>
        <button v-if="res && res.found" class="btn btn-primary" @click="openOrder">打开这张订单</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { api } from '../api';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 打开时预填的号（一般是列表搜索框里已经敲的内容） */
  initialNo: { type: String, default: '' },
  /** 预填为空时的示例号，用来提示本厂单号长什么样 */
  hint: { type: String, default: '' }
});
const emit = defineEmits(['update:modelValue', 'open-order']);

const no = ref('');
const res = ref(null);
const busy = ref(false);
const inp = ref(null);

/**
 * 查询序号：只认最后一次
 *
 * 输入停下来才查（防抖），但「停下来」和「响应回来」是两个时间点 ——
 * 连续敲几个号时，先发的请求可能后回来，把结果盖成上一个号的数据。
 * 界面上就会出现「输入框写着 A、下面列的是 B 的单据」，而这种错没人会怀疑。
 */
let seq = 0;
let timer = null;

function statusLabel(k) {
  return {
    draft: '草稿', tech: '技术', finance: '财务', assigned: '已分单', production: '生产中',
    instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
  }[k] || k || '—';
}
function tagOf(s) {
  return {
    draft: 'gray', tech: 'blue', finance: 'orange', assigned: 'purple', production: 'blue',
    instock: 'green', shipped: 'green', closed: 'gray', cancelled: 'red'
  }[s] || 'gray';
}
/** 只显示日期部分：库里存的是 UTC ISO，这里只取业务看到的「哪一天」 */
function fmtDate(v) {
  if (!v) return '—';
  return String(v).slice(0, 10);
}

async function run() {
  const v = no.value.trim();
  if (v.length < 2) return;
  clearTimeout(timer);
  const my = ++seq;
  busy.value = true;
  try {
    const r = await api.orderNoTrace(v);
    if (my !== seq) return; // 已经有更新的查询了，丢弃这次结果
    res.value = r;
  } catch (e) {
    if (my !== seq) return;
    res.value = { input: v, found: false, orphan: false, chains: [], total: 0, similar: [] };
    alert(e.message || '反查失败');
  } finally {
    if (my === seq) busy.value = false;
  }
}

/** 输入停下自动查：业务敲错一位时不用再点一次按钮才发现 */
function schedule() {
  clearTimeout(timer);
  res.value = null;
  if (no.value.trim().length < 2) return;
  timer = setTimeout(run, 600);
}

function pick(v) {
  no.value = v;
  run();
}

function close() {
  clearTimeout(timer);
  seq += 1; // 关掉之后回来的响应不许再改界面
  emit('update:modelValue', false);
}

function openOrder() {
  if (!res.value || !res.value.order) return;
  emit('open-order', res.value.order.id);
  close();
}

watch(no, schedule);

watch(() => props.modelValue, async (open) => {
  if (!open) {
    clearTimeout(timer);
    return;
  }
  const v = (props.initialNo || '').trim();
  no.value = v;
  res.value = null;
  await nextTick();
  if (inp.value) inp.value.focus();
  // 带着号打开就直接查一次，省掉「再点一下」
  if (v.length >= 2) run();
});

onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
/* 组件被订单页、采购页共用，两个页面的样式都是 scoped ——
   所以这里不依赖任何页面级工具类，样式自带，放哪都长一样。 */
.trc-modal { width: 700px; max-width: 94vw; }

/* .mono 在项目里只存在于各页的 scoped 样式，全局并没有 ——
   组件里必须自带一份，否则单号不是等宽字体，「敲错一位」肉眼更难比对 */
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }

.trc-bar { display: flex; gap: 8px; margin-bottom: 10px; }
.trc-bar .input { flex: 1; }

.trc-intro {
  font-size: 12px; line-height: 1.75; color: #4a5a72;
  background: #f7f9fd; border: 1px solid #e6ecf5; border-radius: 8px;
  padding: 9px 12px; margin-bottom: 14px;
}

.trc-flag {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 13px; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;
}
.trc-flag.ok { background: #eaf8f0; border: 1px solid #bfe8d2; color: #15803d; }
.trc-flag.warn { background: #fff6e6; border: 1px solid #fadfae; color: #b45309; }
.trc-flag.miss { background: #f4f6fa; border: 1px solid #e3e8f0; color: #475569; }
.trc-dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; display: inline-block; }
.trc-no { font-size: 13.5px; font-weight: 700; }

.trc-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 18px;
  font-size: 12.5px; padding: 12px 14px; background: #fbfcfe;
  border: 1px solid #eef2f7; border-radius: 8px; margin-bottom: 12px;
}
.trc-grid > div { display: flex; gap: 8px; align-items: baseline; }
.trc-grid label { color: #8a94a6; min-width: 56px; }
.trc-grid span { color: #16233b; }

.trc-tbl { width: 100%; margin-bottom: 4px; }
.trc-tbl td { font-size: 12.5px; }
.trc-samples { color: #4a5a72; font-size: 11.5px; }

.trc-box { font-size: 12.5px; line-height: 1.8; padding: 11px 13px; border-radius: 8px; }
.trc-box.warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; margin-bottom: 12px; }

.trc-mut { font-size: 12.5px; color: #7b8698; line-height: 1.8; padding: 6px 0; }
.trc-sub { font-size: 11.5px; color: #8a94a6; margin-top: 6px; line-height: 1.7; }
.trc-sub2 { font-size: 12.5px; color: #33425c; margin: 10px 0 8px; }

.trc-sim { display: flex; flex-direction: column; gap: 6px; }
.trc-sim-item {
  display: flex; align-items: baseline; gap: 10px;
  padding: 9px 12px; border: 1px solid #e6ecf5; border-radius: 8px;
  background: #fbfcfe; cursor: pointer; text-decoration: none;
}
.trc-sim-item:hover { border-color: #b9cdf5; background: #f4f8ff; }
.trc-sim-item b { color: #2563eb; font-size: 13px; }
.trc-sim-meta { font-size: 11.5px; color: #8a94a6; }

</style>
