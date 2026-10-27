<template>
  <div class="pr-wrap">
    <div class="pr-toolbar no-print">
      <button class="btn btn-primary btn-sm" @click="doPrint">打印</button>
      <button class="btn btn-ghost btn-sm" @click="back">返回</button>
      <span class="pr-tip">打印时选择「另存为 PDF」即可导出文件</span>
    </div>

    <div v-if="!ready" class="pr-loading">加载中…</div>

    <div v-else-if="!order" class="pr-loading">未找到单据数据</div>

    <div v-else class="pr-sheet">
      <div class="pr-head">
        <div class="pr-co">跳色科技有限公司</div>
        <h1>{{ title }}</h1>
        <div class="pr-meta">
          <span>单号：{{ order.order_no }}</span>
          <span v-if="tp">开发单：{{ tp.version }}</span>
          <span>打印日期：{{ today }}</span>
        </div>
        <!-- 条码：车间扫码报工 / 仓库扫码入库都用订单号 -->
        <svg v-if="!isTechpack" class="pr-barcode"></svg>
      </div>

      <!-- ========== 工艺单：开发单头部 ========== -->
      <template v-if="isTechpack">
        <table class="pr-info">
          <tbody>
            <tr>
              <th>款号</th><td>{{ tp.product_name || '-' }}</td>
              <th>客户款号</th><td>{{ tp.customer_style_no || '-' }}</td>
            </tr>
            <tr>
              <th>客户</th><td>{{ order.customer_name || '-' }}</td>
              <th>颜色</th><td>{{ tp.colors || '-' }}</td>
            </tr>
            <tr>
              <th>尺码</th><td>{{ tp.size_range || tp.size_spec || '-' }}</td>
              <th>分类</th><td>{{ tp.category || '-' }}</td>
            </tr>
            <tr>
              <th>设计师</th><td>{{ tp.designer || '-' }}</td>
              <th>车版师</th><td>{{ tp.pattern_maker || '-' }}</td>
            </tr>
            <tr>
              <th>纸样号</th><td>{{ tp.pattern_no || '-' }}</td>
              <th>品牌 / 系列</th><td>{{ [tp.brand, tp.series].filter(Boolean).join(' / ') || '-' }}</td>
            </tr>
            <tr>
              <th>波段 / 标签</th><td>{{ [tp.wave, tp.label_name].filter(Boolean).join(' / ') || '-' }}</td>
              <th>业务员</th><td>{{ tp.sales_owner || '-' }}</td>
            </tr>
            <tr>
              <th>PO 单号</th><td>{{ tp.po_no || '-' }}</td>
              <th>交货日期</th><td>{{ tp.delivery_date || order.delivery_date || '-' }}</td>
            </tr>
            <tr>
              <th>跟单员</th><td>{{ order.manager || '-' }}</td>
              <th>下单日期</th><td>{{ order.order_date || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- ========== 生产总单：订单头部 ========== -->
      <table v-else class="pr-info">
        <tbody>
          <tr>
            <th>客户</th><td>{{ order.customer_name || '-' }}</td>
            <th>款名</th><td>{{ order.style_name || '-' }}</td>
          </tr>
          <tr>
            <th>客户订单号</th><td>{{ order.cus_order_no || '-' }}</td>
            <th>跟单员</th><td>{{ order.manager || '-' }}</td>
          </tr>
          <tr>
            <th>下单日期</th><td>{{ order.order_date || '-' }}</td>
            <th>交期</th><td>{{ order.delivery_date || '-' }}</td>
          </tr>
          <tr>
            <th>交货方式</th><td>{{ order.delivery_method || '-' }}</td>
            <th>贸易条款</th><td>{{ order.trade_terms || '-' }}</td>
          </tr>
          <tr v-if="type !== 'production'">
            <th>店铺名称</th><td>{{ order.shop_name || '-' }}</td>
            <th>店铺订单号</th><td>{{ order.shop_order_no || '-' }}</td>
          </tr>
          <tr v-if="type === 'production' && tp">
            <th>开发单</th><td>{{ tp.version }}（{{ tp.status === 'confirmed' ? '已确认' : '未确认' }}）</td>
            <th>设计师 / 车版师</th><td>{{ [tp.designer, tp.pattern_maker].filter(Boolean).join(' / ') || '-' }}</td>
          </tr>
        </tbody>
      </table>

      <!-- ========== 装箱单：箱号与重量体积由装箱人现场填写 ========== -->
      <template v-if="type === 'packing'">
        <h2 class="pr-sec">装箱明细</h2>
        <table class="pr-table pr-tall">
          <thead>
            <tr>
              <th style="width: 54px">箱号</th>
              <th style="width: 90px">款号</th>
              <th>品名</th>
              <th style="width: 68px">颜色</th>
              <th style="width: 56px">尺码</th>
              <th style="width: 56px">数量</th>
              <th style="width: 62px">毛重 kg</th>
              <th style="width: 62px">净重 kg</th>
              <th style="width: 66px">体积 m³</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(l, i) in lines" :key="i">
              <td></td>
              <td>{{ l.style_no || '-' }}</td>
              <td>{{ l.product_name }}</td>
              <td>{{ l.color || '-' }}</td>
              <td>{{ l.size || '-' }}</td>
              <td class="num">{{ l.qty }}</td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
            <tr class="pr-total">
              <td colspan="5">合计</td>
              <td class="num">{{ totalQty }}</td>
              <td colspan="4"></td>
            </tr>
          </tbody>
        </table>
        <div class="pr-note">
          箱号 / 毛重 / 净重 / 体积由装箱人现场填写。一箱混装多个尺码时，同一箱号在多行重复填写。
        </div>
      </template>

      <!-- ========== 发货单：收货信息与回签 ========== -->
      <template v-if="type === 'shipping'">
        <h2 class="pr-sec">收货信息</h2>
        <table class="pr-info">
          <tbody>
            <tr>
              <th>收货人</th><td></td>
              <th>联系电话</th><td></td>
            </tr>
            <tr>
              <th>收货地址</th><td colspan="3"></td>
            </tr>
            <tr>
              <th>运单号</th><td></td>
              <th>箱数</th><td></td>
            </tr>
            <tr>
              <th>总毛重 kg</th><td></td>
              <th>总净重 kg</th><td></td>
            </tr>
            <tr>
              <th>交货方式</th><td>{{ order.delivery_method || '-' }}</td>
              <th>贸易条款</th><td>{{ order.trade_terms || '-' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="pr-note">收货信息、运单号、箱数由发货人现场填写。</div>
      </template>

      <!-- ========== 客户要求 ========== -->
      <template v-if="tp && tp.customer_req">
        <h2 class="pr-sec">客户要求</h2>
        <div class="pr-text">{{ tp.customer_req }}</div>
      </template>

      <!-- ========== 款式明细（工艺单放在尺寸表之前） ========== -->
      <h2 v-if="type !== 'packing'" class="pr-sec">款式 / 颜色 / 尺码明细</h2>
      <table v-if="type !== 'packing'" class="pr-table">
        <thead>
          <tr>
            <th style="width: 34px">序号</th>
            <th>款号</th>
            <th>产品名称</th>
            <th style="width: 70px">颜色</th>
            <th style="width: 60px">尺码</th>
            <th style="width: 60px">数量</th>
            <th v-if="type !== 'production'" style="width: 60px">箱数</th>
            <th v-if="type !== 'production'" style="width: 70px">备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in lines" :key="i">
            <td>{{ i + 1 }}</td>
            <td>{{ l.style_no || '-' }}</td>
            <td>{{ l.product_name }}</td>
            <td>{{ l.color || '-' }}</td>
            <td>{{ l.size || '-' }}</td>
            <td class="num">{{ l.qty }}</td>
            <td v-if="type !== 'production'"></td>
            <td v-if="type !== 'production'"></td>
          </tr>
          <tr class="pr-total">
            <td colspan="5">合计</td>
            <td class="num">{{ totalQty }}</td>
            <td v-if="type !== 'production'"></td>
            <td v-if="type !== 'production'"></td>
          </tr>
        </tbody>
      </table>

      <!-- ========== 面辅料明细（开发单结构化数据，优先） ========== -->
      <template v-if="tpMaterials.length">
        <h2 class="pr-sec">面辅料明细</h2>
        <table class="pr-table">
          <thead>
            <tr>
              <th style="width: 30px">#</th>
              <th style="width: 44px">类型</th>
              <th style="width: 64px">款色</th>
              <th>物料名称 / 规格</th>
              <th style="width: 70px">面料色号</th>
              <th>供应商</th>
              <th>规格信息</th>
              <th>成份</th>
              <th style="width: 44px">单位</th>
              <th style="width: 58px">单件用量</th>
              <th style="width: 46px">损耗%</th>
              <th style="width: 46px">空差%</th>
              <th style="width: 52px">单价</th>
              <th style="width: 56px">金额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(m, i) in tpMaterials" :key="m.id || i">
              <td>{{ i + 1 }}</td>
              <td>{{ m.mat_type === 'fabric' ? '面料' : '辅料' }}</td>
              <td>{{ m.colorway || '-' }}</td>
              <td>{{ m.material_name || '-' }}</td>
              <td>{{ m.color_no || '-' }}</td>
              <td>{{ m.supplier || '-' }}<br /><span class="pr-dim">{{ m.supplier_info || '' }}</span></td>
              <td>{{ m.spec_info || '-' }}</td>
              <td>{{ m.composition || '-' }}</td>
              <td>{{ m.unit || '-' }}</td>
              <td class="num">{{ m.one_use }}</td>
              <td class="num">{{ m.loss_rate }}</td>
              <td class="num">{{ m.air_gap }}</td>
              <td class="num">{{ num2(m.unit_price) }}</td>
              <td class="num">{{ num2(m.amount) }}</td>
            </tr>
            <tr class="pr-total">
              <td colspan="13">单件物料成本合计</td>
              <td class="num">{{ num2(matTotal) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="pr-note">金额口径：单件用量 × 单价（不含损耗与空差）。含损耗/空差的备料量请以生产工单为准。</div>
      </template>

      <!-- ========== 成衣尺寸 ========== -->
      <template v-if="sizeMatrix.cols.length">
        <h2 class="pr-sec">成衣尺寸（单位：cm）</h2>
        <table class="pr-table pr-size">
          <thead>
            <tr>
              <th style="width: 110px">部位 \ 尺码</th>
              <th v-for="c in sizeMatrix.cols" :key="c">{{ c }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sizeMatrix.rows" :key="r.part">
              <td>{{ r.part }}</td>
              <td v-for="c in sizeMatrix.cols" :key="c" class="num">{{ r.map[c] || '' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="tp && tp.size_spec" class="pr-note">尺码说明：{{ tp.size_spec }}</div>
      </template>

      <!-- ========== 生产要求 ========== -->
      <template v-if="reqGroups.length">
        <h2 class="pr-sec">生产要求</h2>
        <div v-for="g in reqGroups" :key="g.key" class="pr-req">
          <div class="pr-req-h">{{ g.label }}</div>
          <ol class="pr-req-list">
            <li v-for="(r, i) in g.items" :key="i">{{ r.content }}</li>
          </ol>
        </div>
      </template>

      <!-- ========== 生产总单专属：工艺明细 / 用量 / 工序 ========== -->
      <template v-if="type === 'production'">
        <h2 class="pr-sec">工艺明细</h2>
        <table class="pr-table">
          <thead><tr><th style="width: 34px">序号</th><th>工艺</th><th style="width: 60px">数量</th><th style="width: 70px">单价</th><th style="width: 60px">倍率</th><th style="width: 80px">外发/洗水/裁剪</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in crafts" :key="c.id">
              <td>{{ i + 1 }}</td>
              <td>{{ c.name }}</td>
              <td class="num">{{ c.qty }}</td>
              <td class="num">{{ c.price }}</td>
              <td class="num">{{ c.rate }}</td>
              <td>{{ [c.is_out ? '外发' : '', c.is_wash ? '洗水' : '', c.is_cut ? '裁剪' : ''].filter(Boolean).join('/') || '-' }}</td>
              <td>{{ c.instruction || '' }}</td>
            </tr>
            <tr v-if="!crafts.length"><td colspan="7" style="text-align: center; color: #888">无</td></tr>
          </tbody>
        </table>

        <template v-if="!tpMaterials.length">
          <h2 class="pr-sec">面辅料用量</h2>
          <table class="pr-table">
            <thead><tr><th style="width: 34px">序号</th><th style="width: 70px">类型</th><th>名称</th><th style="width: 60px">单位</th><th style="width: 80px">单件用量</th><th style="width: 60px">损耗%</th><th style="width: 80px">总用量</th><th>供应商</th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in materials" :key="m.id">
                <td>{{ i + 1 }}</td>
                <td>{{ m.type === 'fabric' ? '面料' : '辅料' }}</td>
                <td>{{ m.name }}</td>
                <td>{{ m.unit || '-' }}</td>
                <td class="num">{{ m.one_use }}</td>
                <td class="num">{{ m.loss }}</td>
                <td class="num">{{ m.total_use }}</td>
                <td>{{ m.supplier || '-' }}</td>
              </tr>
              <tr v-if="!materials.length"><td colspan="8" style="text-align: center; color: #888">无</td></tr>
            </tbody>
          </table>
        </template>

        <h2 class="pr-sec">生产工序</h2>
        <table class="pr-table">
          <thead><tr><th style="width: 34px">序号</th><th>工序</th><th style="width: 86px">计划完成</th><th style="width: 86px">实际完成</th><th style="width: 76px">责任人</th><th style="width: 70px">状态</th><th style="width: 96px">系统报工</th></tr></thead>
          <tbody>
            <tr v-for="(n, i) in nodes" :key="n.id">
              <td>{{ i + 1 }}</td>
              <td>{{ n.name }}</td>
              <td>{{ n.plan_date || '' }}</td>
              <td>{{ n.actual_date || '' }}</td>
              <td>{{ n.operator || '' }}</td>
              <td>{{ { pending: '待开始', doing: '进行中', done: '已完成' }[n.status] || n.status }}</td>
              <td class="num">{{ reportText(n.id) }}</td>
            </tr>
            <tr v-if="!nodes.length"><td colspan="7" style="text-align: center; color: #888">无</td></tr>
          </tbody>
        </table>

        <!-- ========== 裁床扎包（车间按扎作业，扎号是追溯单位） ========== -->
        <template v-if="bundles.length">
          <h2 class="pr-sec">裁床扎包（{{ bundles.length }} 扎 / {{ bundleQty }} 件）</h2>
          <table class="pr-table">
            <thead>
              <tr>
                <th style="width: 64px">扎号</th>
                <th style="width: 72px">颜色</th>
                <th style="width: 52px">尺码</th>
                <th style="width: 52px">件数</th>
                <th style="width: 84px">缸号 / 床次</th>
                <th style="width: 72px">状态</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in bundles" :key="b.id">
                <td>{{ b.bundle_no }}</td>
                <td>{{ b.color || '-' }}</td>
                <td>{{ b.size || '-' }}</td>
                <td class="num">{{ b.qty }}</td>
                <td>{{ [b.dye_lot, b.bed_no].filter(Boolean).join(' / ') || '-' }}</td>
                <td>{{ b.status === 'checked' ? '已复核' : '待复核' }}</td>
                <td>{{ b.note || '' }}</td>
              </tr>
              <tr class="pr-total">
                <td colspan="3">合计</td>
                <td class="num">{{ bundleQty }}</td>
                <td colspan="3"></td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- ========== 现场手写报工（系统报工在系统里录，这里只给车间现场用） ========== -->
        <h2 class="pr-sec">现场报工记录（车间填写）</h2>
        <table class="pr-table pr-tall">
          <thead>
            <tr>
              <th style="width: 76px">日期</th>
              <th>工序</th>
              <th style="width: 58px">合格</th>
              <th style="width: 58px">不良</th>
              <th style="width: 58px">工时</th>
              <th style="width: 76px">报工人</th>
              <th style="width: 88px">班组长</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in 8" :key="'w' + n">
              <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
            </tr>
          </tbody>
        </table>
        <div class="pr-note">
          此栏仅供车间现场手写核对；正式报工请在「生产 → 生产管理」录入，成本与进度以系统数据为准。
        </div>
      </template>

      <!-- 工艺工序文字说明（工艺单用） -->
      <template v-if="isTechpack && tp.craft_info">
        <h2 class="pr-sec">工艺 / 工序说明</h2>
        <div class="pr-text">{{ tp.craft_info }}</div>
      </template>

      <div v-if="tp && tp.remark" class="pr-note">备注：{{ tp.remark }}</div>

      <div class="pr-sign">
        <template v-if="type === 'production'">
          <div>制单：__________</div>
          <div>审核：__________</div>
          <div>车间接收：__________</div>
          <div>日期：__________</div>
        </template>
        <template v-else-if="type === 'packing'">
          <div>装箱人：__________</div>
          <div>复核人：__________</div>
          <div>日期：__________</div>
        </template>
        <template v-else-if="type === 'shipping'">
          <div>发货人：__________</div>
          <div>承运人：__________</div>
          <div>客户签收：__________</div>
          <div>日期：__________</div>
        </template>
        <template v-else>
          <div>制单：__________</div>
          <div>审核：__________</div>
          <div>日期：__________</div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import JsBarcode from 'jsbarcode';
import { api } from '../api';

const route = useRoute();
const router = useRouter();

const type = computed(() => route.params.type);
const id = computed(() => route.params.id);
const isTechpack = computed(() => type.value === 'techpack');

const TITLES = {
  production: '生产工单',
  packing: '装箱单',
  shipping: '发货单',
  techpack: '工 艺 单'
};
const title = computed(() => TITLES[type.value] || '单据');

const ready = ref(false);
const order = ref(null);
const tp = ref(null);
const crafts = ref([]);
const materials = ref([]);
const nodes = ref([]);
const bundles = ref([]);
const reportSum = ref([]);
const today = new Date().toLocaleDateString('zh-CN');

const REQ_CATS = [
  { key: 'craft', label: '缝制工艺要求' },
  { key: 'packing', label: '包装与标识要求' },
  { key: 'test', label: '测试与验货要求' },
  { key: 'note', label: '其他注意事项' }
];

const tpMaterials = computed(() => (tp.value && tp.value.materials) || []);

const matTotal = computed(() =>
  tpMaterials.value.reduce((s, m) => s + (Number(m.one_use) || 0) * (Number(m.unit_price) || 0), 0)
);

const lines = computed(() => {
  if (!order.value) return [];
  const out = [];
  order.value.items.forEach((it) => {
    (it.sizes || []).forEach((s) => {
      out.push({ style_no: it.style_no, product_name: it.product_name, color: s.color, size: s.size, qty: s.qty });
    });
  });
  return out;
});
const totalQty = computed(() => lines.value.reduce((s, l) => s + (Number(l.qty) || 0), 0));

const bundleQty = computed(() => bundles.value.reduce((s, b) => s + (Number(b.qty) || 0), 0));

/** 工序的系统报工累计（合格 / 不良），没有报工就留空让现场手写 */
const reportMap = computed(() => {
  const m = {};
  reportSum.value.forEach((r) => {
    if (r.node_id) m[r.node_id] = { ok: Number(r.ok) || 0, defect: Number(r.defect) || 0 };
  });
  return m;
});
function reportText(nodeId) {
  const r = reportMap.value[nodeId];
  if (!r) return '';
  return r.defect ? `${r.ok} / 不良 ${r.defect}` : String(r.ok);
}

/** 尺寸行 → 部位 × 尺码 矩阵 */
const sizeMatrix = computed(() => {
  const rows = tp.value && Array.isArray(tp.value.sizes) ? tp.value.sizes : [];
  const cols = [];
  const map = new Map();
  rows.forEach((r) => {
    if (!cols.includes(r.size)) cols.push(r.size);
    if (!map.has(r.part)) map.set(r.part, { part: r.part, map: {} });
    map.get(r.part).map[r.size] = r.value;
  });
  return { cols, rows: [...map.values()] };
});

const reqGroups = computed(() => {
  const rs = tp.value && Array.isArray(tp.value.requirements) ? tp.value.requirements : [];
  return REQ_CATS.map((c) => ({ ...c, items: rs.filter((r) => r.category === c.key) }))
    .filter((g) => g.items.length);
});

const num2 = (v) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);

function back() { router.back(); }
function doPrint() { window.print(); }

onMounted(async () => {
  try {
    if (isTechpack.value) {
      const full = await api.techpackFull(id.value);
      tp.value = full;
      order.value = full.order ? await api.order(full.order.id) : null;
      if (order.value && !tp.value.customer_req) tp.value.customer_req = order.value.remark || '';
    } else {
      order.value = await api.order(id.value);
      if (type.value === 'production') {
        const [cf, om, nd, cur, cuts, rep] = await Promise.all([
          api.crafts(id.value),
          api.orderMaterials(id.value),
          api.orderNodes(id.value),
          api.techpackCurrent(id.value).catch(() => null),
          api.cutByOrder(id.value).catch(() => null),
          api.reportSummary(id.value).catch(() => [])
        ]);
        crafts.value = cf || [];
        materials.value = om || [];
        nodes.value = nd || [];
        // 取该订单「当前生效」的开发单（已确认优先），把客户要求 / 面辅料 / 成衣尺寸 / 生产要求带上总单
        tp.value = cur || null;

        // 裁床扎包：扎是车间追溯的最小单位，纸质工单上必须有，否则裁完的扎对不上单
        const lots = (cuts && cuts.lots) || [];
        const lotMap = {};
        lots.forEach((l) => { lotMap[l.id] = l; });
        bundles.value = ((cuts && cuts.bundles) || []).map((b) => {
          const lot = b.lot_id ? lotMap[b.lot_id] : null;
          return { ...b, dye_lot: lot ? lot.dye_lot : '', bed_no: lot ? lot.bed_no : '' };
        });
        reportSum.value = Array.isArray(rep) ? rep : [];
      }
    }
    } catch (e) {
      alert(e.message);
    } finally {
      ready.value = true;
      await nextTick();
      renderBarcode();
    }
  });

/**
 * 单据条码：用订单号生成 Code128。
 * 车间扫码报工、仓库扫码入库都扫这个，比手输单号快且不会错。
 * 中文剔掉（条码只能是 ASCII），订单号本身是纯 ASCII，剔除只是兜底。
 */
function renderBarcode() {
  const el = document.querySelector('.pr-barcode');
  if (!el || !order.value) return;
  const code = String(order.value.order_no || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (!code) return;
  try {
    JsBarcode(el, code, {
      format: 'CODE128', height: 38, width: 1.15, fontSize: 12, margin: 0, displayValue: true
    });
  } catch (e) {
    /* 条码画不出来不影响单据本身 */
  }
}
</script>

<style>
/* 打印页样式（非 scoped，避免影响全局只作用于 .pr-*） */
.pr-wrap { max-width: 960px; margin: 0 auto; padding: 14px; background: #f2f5fa; min-height: 100vh; }
.pr-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
.pr-tip { font-size: 12px; color: #8a94a6; }

.pr-sheet {
  background: #fff; padding: 22px 26px; border-radius: 6px;
  box-shadow: 0 2px 12px rgba(16, 32, 64, 0.08); color: #1f2937;
  font-size: 12.5px; line-height: 1.5;
}
.pr-head { text-align: center; border-bottom: 2px solid #1f2937; padding-bottom: 10px; margin-bottom: 12px; }
.pr-co { font-size: 13px; letter-spacing: 2px; color: #33415a; }
.pr-head h1 { margin: 6px 0 6px; font-size: 22px; letter-spacing: 4px; }
.pr-meta { display: flex; justify-content: space-between; font-size: 12px; color: #5b6474; }

.pr-info { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
.pr-info th, .pr-info td { border: 1px solid #c9d2e0; padding: 6px 8px; font-size: 12px; }
.pr-info th { background: #f4f6fa; width: 92px; text-align: left; font-weight: 600; color: #33415a; }

.pr-sec { font-size: 13px; margin: 16px 0 6px; padding-left: 8px; border-left: 3px solid #2b6de5; }

.pr-table { width: 100%; border-collapse: collapse; }
.pr-table th, .pr-table td { border: 1px solid #c9d2e0; padding: 5px 7px; font-size: 12px; }
.pr-table th { background: #f4f6fa; font-weight: 600; color: #33415a; }
.pr-table .num { text-align: right; }
.pr-total td { font-weight: 700; background: #fafbfd; }

/* 尺寸矩阵：列宽均匀，避免 M 列窄 XL 列宽 */
.pr-size { table-layout: fixed; }
.pr-size th:first-child, .pr-size td:first-child { width: 120px; }
.pr-size th { text-align: center; }
.pr-size td.num { text-align: center; }

/* 客户要求 / 工艺说明 长文本 */
.pr-text {
  border: 1px solid #c9d2e0; border-radius: 3px; padding: 8px 10px;
  white-space: pre-wrap; line-height: 1.7; font-size: 12px; background: #fcfdff;
}
.pr-note { margin-top: 6px; font-size: 11px; color: #6b7788; }
.pr-dim { color: #7b8798; font-size: 10.5px; }

/* 生产要求分组 */
.pr-req { margin-bottom: 8px; }
.pr-req-h { font-weight: 700; font-size: 12px; color: #33415a; margin-bottom: 2px; }
.pr-req-list { margin: 0; padding-left: 20px; }
.pr-req-list li { font-size: 12px; line-height: 1.7; }

.pr-sign { display: flex; justify-content: space-between; gap: 10px; margin-top: 28px; padding-top: 10px; font-size: 12.5px; color: #33415a; flex-wrap: wrap; }

/* 单据条码（放在单据抬头下方，方便扫码） */
.pr-barcode { display: block; margin: 8px auto 0; max-width: 260px; }

/* 需要手写的表：行高留够，别挤成一条线 */
.pr-table.pr-tall td { height: 26px; }

.pr-loading { padding: 40px; text-align: center; color: #8a94a6; }

@media print {
  @page { size: A4; margin: 12mm; }
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .pr-wrap { background: #fff; padding: 0; max-width: none; min-height: auto; }
  .pr-sheet { box-shadow: none; border-radius: 0; padding: 0; }
  .pr-table, .pr-info { page-break-inside: auto; }
  .pr-table tr { page-break-inside: avoid; }
  .pr-sec { page-break-after: avoid; }
  /* 跨页时表头重复：多页工单散开后，第二页也能看出哪列是什么 */
  .pr-table thead, .pr-info thead { display: table-header-group; }
  .pr-sheet { font-size: 11.5px; }
  .pr-table.pr-tall td { height: 30px; }
  .pr-barcode { max-width: 220px; }
}
</style>
