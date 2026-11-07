<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>现货库龄与退货</h2>
        <p class="sub">
          库龄用<b>出入库流水按先进先出反算</b>，不加批次表 —— 出库逐笔冲最早的入库，剩下的就是现在在库的那几批及其入库日期。
          退货必须<b>逐件判定</b>：实收 = 良品 + 次品 + 报废，<b>只有良品回可售库存</b>。
          滞销只给数据和预警，<b>不自动打折或下架</b>。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn btn-ghost" @click="reloadAll">刷新</button>
        <button v-if="canWrite && tab === 'return'" class="btn btn-primary" @click="openReturnForm">＋ 新建退货单</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat"><span>美仓可售库存</span><strong>{{ ov.stock_qty || 0 }}</strong><small>件（按 SKU 合计）</small></div>
      <div class="stat" :class="(ov.avg_age || 0) > 90 ? 'st-bad' : (ov.avg_age || 0) > 60 ? 'st-warn' : 'st-good'">
        <span>平均库龄</span><strong>{{ ov.avg_age || 0 }}</strong><small>天</small>
      </div>
      <div class="stat" :class="(ov.d90p_qty || 0) > 0 ? 'st-bad' : ''">
        <span>90 天以上</span><strong>{{ ov.d90p_qty || 0 }}</strong><small>占 {{ ov.d90p_pct || 0 }}%</small>
      </div>
      <div class="stat"><span>近 90 天出库</span><strong>{{ ov.out_90d || 0 }}</strong><small>件</small></div>
      <div class="stat">
        <span>整体周转</span>
        <strong>{{ ov.turnover_days === null || ov.turnover_days === undefined ? '—' : ov.turnover_days }}</strong>
        <small>天（库存 ÷ 日均出库）</small>
      </div>
      <div class="stat" :class="(ov.returns && ov.returns.pending) ? 'st-warn' : ''">
        <span>待处理退货</span><strong>{{ (ov.returns && ov.returns.pending) || 0 }}</strong>
        <small>待点收 {{ (ov.returns && ov.returns.draft) || 0 }} · 待判定 {{ (ov.returns && ov.returns.received) || 0 }}</small>
      </div>
    </div>

    <div class="toolbar" style="margin-bottom: 12px">
      <div class="tabs" style="margin-left: 0">
        <button :class="{ on: tab === 'aging' }" @click="go('aging')">库龄分布</button>
        <button :class="{ on: tab === 'turnover' }" @click="go('turnover')">动销与周转</button>
        <button :class="{ on: tab === 'slow' }" @click="go('slow')">滞销清单</button>
        <button :class="{ on: tab === 'return' }" @click="go('return')">
          退货处理<span v-if="ov.returns && ov.returns.pending" class="tab-dot">{{ ov.returns.pending }}</span>
        </button>
      </div>
      <template v-if="tab === 'turnover'">
        <select class="select" v-model.number="days" style="width: 120px" @change="loadTurnover">
          <option :value="30">近 30 天</option>
          <option :value="60">近 60 天</option>
          <option :value="90">近 90 天</option>
          <option :value="180">近 180 天</option>
        </select>
      </template>
      <template v-if="tab === 'slow'">
        <select class="select" v-model.number="minAge" style="width: 140px" @change="loadSlow">
          <option :value="60">库龄 ≥ 60 天</option>
          <option :value="90">库龄 ≥ 90 天</option>
          <option :value="120">库龄 ≥ 120 天</option>
        </select>
      </template>
      <template v-if="tab === 'return'">
        <select class="select" v-model="rtStatus" style="width: 130px" @change="loadReturns">
          <option value="all">全部状态</option>
          <option v-for="s in dict.return_status" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </template>
    </div>

    <!-- ==================== 一、库龄分布 ==================== -->
    <div v-if="tab === 'aging'">
      <div class="age-bar">
        <div v-for="(b, i) in aging.buckets" :key="b.key" class="age-seg" :class="'seg-' + i" :style="{ flex: Math.max(b.qty, 0.01) }">
          <span v-if="b.pct >= 8">{{ b.label }} {{ b.qty }} 件（{{ b.pct }}%）</span>
        </div>
      </div>
      <div v-if="!aging.total_qty" class="empty-cell">美仓还没有可售库存。</div>
      <div v-else class="block">
        <h4>按款汇总<small>点开看每批入库的日期与剩余量</small></h4>
        <div class="table-wrap">
          <table class="age-tbl">
            <thead>
              <tr>
                <th style="width: 110px">款号</th><th>品名</th>
                <th style="width: 90px" class="num">库存</th>
                <th style="width: 84px" class="num">0-30 天</th>
                <th style="width: 84px" class="num">31-60 天</th>
                <th style="width: 84px" class="num">61-90 天</th>
                <th style="width: 90px" class="num">90 天以上</th>
                <th style="width: 84px" class="num">平均库龄</th>
                <th style="width: 84px" class="num">最老</th>
                <th style="width: 90px">状态</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="s in aging.styles" :key="s.style_no">
                <tr :class="{ 'row-bad': s.max_age > 90, 'row-warn': s.max_age > 60 && s.max_age <= 90 }">
                  <td class="mono">{{ s.style_no }}</td>
                  <td class="wrap">{{ s.product_name || '—' }}</td>
                  <td class="num"><b>{{ s.qty }}</b></td>
                  <td class="num">{{ s.d0_30 || '—' }}</td>
                  <td class="num">{{ s.d31_60 || '—' }}</td>
                  <td class="num">{{ s.d61_90 || '—' }}</td>
                  <td class="num" :class="s.d90p ? 'amt-red' : ''">{{ s.d90p || '—' }}</td>
                  <td class="num">{{ s.avg_age }} 天</td>
                  <td class="num">{{ s.max_age }} 天</td>
                  <td class="ops">
                    <span class="pill" :class="s.max_age > 90 ? 'p-bad' : s.max_age > 60 ? 'p-warn' : 'p-ok'">
                      {{ s.max_age > 90 ? '老货' : s.max_age > 60 ? '偏慢' : '正常' }}
                    </span>
                    <button class="btn btn-ghost btn-sm" @click="toggleStyle(s.style_no)">
                      {{ expanded[s.style_no] ? '收起' : '明细' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="expanded[s.style_no]" class="detail-row">
                  <td colspan="10">
                    <div class="lot-list">
                      <div v-for="r in skuOfStyle(s.style_no)" :key="r.color + '|' + r.size" class="lot-group">
                        <span class="lot-key">{{ r.color || '—' }}/{{ r.size || '—' }}</span>
                        <span v-for="(lot, li) in r.lots" :key="li" class="lot-chip"
                          :class="lot.age > 90 ? 'chip-bad' : lot.age > 60 ? 'chip-warn' : ''">
                          {{ lot.in_date }} · {{ lot.qty }} 件 · {{ lot.age }} 天
                        </span>
                        <span v-if="!r.lots.length" class="muted tiny">无在库批次</span>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-if="aging.overflow" class="hint-warn">
          有 {{ aging.overflow }} 件「出库多于入库」的缺口：这些 SKU 早期入库没有留下流水（历史数据），库龄只能按有凭证的批次推算，可能偏高。补录入库单后重新查看更准。
        </p>
      </div>
    </div>

    <!-- ==================== 二、动销与周转 ==================== -->
    <div v-else-if="tab === 'turnover'">
      <div class="turn-stat">
        <div><span>SKU 数</span><b>{{ turnover.stat.sku_count || 0 }}</b></div>
        <div><span>库存</span><b>{{ turnover.stat.stock_qty || 0 }}</b></div>
        <div><span>近 {{ days }} 天出库</span><b>{{ turnover.stat.out_qty || 0 }}</b></div>
        <div><span>日均出库</span><b>{{ turnover.stat.daily_out || 0 }}</b></div>
        <div><span>平均周转</span><b>{{ turnover.stat.avg_turnover_days ?? '—' }} 天</b></div>
        <div><span>零出库 SKU</span><b :class="turnover.stat.dead_sku ? 'amt-red' : ''">{{ turnover.stat.dead_sku || 0 }}</b></div>
        <div><span>已售罄 SKU</span><b>{{ turnover.stat.sold_out_sku || 0 }}</b></div>
      </div>
      <div v-if="!turnover.rows || !turnover.rows.length" class="empty-cell">没有数据。</div>
      <div v-else class="table-wrap">
        <table class="turn-tbl">
          <thead>
            <tr>
              <th style="width: 110px">款号</th><th>品名</th><th style="width: 90px">颜色/尺码</th>
              <th style="width: 84px" class="num">库存</th>
              <th style="width: 84px" class="num">累计入库</th>
              <th style="width: 84px" class="num">累计出库</th>
              <th style="width: 96px" class="num">近{{ days }}天出库</th>
              <th style="width: 90px" class="num">售罄率</th>
              <th style="width: 96px" class="num">周转天数</th>
              <th style="width: 84px" class="num">平均库龄</th>
              <th style="width: 140px">动销</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in turnover.rows" :key="r.key" :class="{ 'row-bad': r.level === 'dead', 'row-warn': r.level === 'slow' || r.level === 'watch' }">
              <td class="mono">{{ r.style_no }}</td>
              <td class="wrap">{{ r.product_name || '—' }}</td>
              <td class="tiny">{{ r.color || '—' }}/{{ r.size || '—' }}</td>
              <td class="num"><b>{{ r.stock }}</b></td>
              <td class="num muted">{{ r.total_in }}</td>
              <td class="num muted">{{ r.sold }}</td>
              <td class="num">{{ r.out_qty }}</td>
              <td class="num">{{ r.sell_through }}%</td>
              <td class="num" :class="r.turnover_days === null ? 'muted' : r.turnover_days > 180 ? 'amt-red' : r.turnover_days > 90 ? 'amt-orange' : ''">
                {{ r.turnover_days === null ? '—' : r.turnover_days }}
              </td>
              <td class="num">{{ r.avg_age }} 天</td>
              <td>
                <span class="pill" :class="'lv-' + r.level">{{ r.level_label }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="tiny muted" style="margin-top: 8px">
        周转天数 = 当前库存 ÷（近 {{ days }} 天出库 ÷ {{ days }}）。天数越大说明这批货压得越久；「—」表示近 {{ days }} 天一件没出。
      </p>
    </div>

    <!-- ==================== 三、滞销清单 ==================== -->
    <div v-else-if="tab === 'slow'">
      <p class="hint-bar">
        按「最老批次库龄 ≥ {{ minAge }} 天且还有库存」筛。建议只是提示，<b>实际要不要清货看毛利和客户需求</b>，系统不替你做决定。
      </p>
      <div v-if="!slow.rows || !slow.rows.length" class="empty-cell">
        没有库龄 ≥ {{ minAge }} 天的库存，挺好的。
      </div>
      <div v-else>
        <div class="issue-bar">
          <span>共 <b>{{ slow.rows.length }}</b> 个 SKU，合计 <b>{{ slow.total_qty }}</b> 件老货</span>
        </div>
        <div class="table-wrap">
          <table class="slow-tbl">
            <thead>
              <tr>
                <th style="width: 110px">款号</th><th>品名</th><th style="width: 90px">颜色/尺码</th>
                <th style="width: 84px" class="num">库存</th>
                <th style="width: 100px" class="num">最老库龄</th>
                <th style="width: 110px" class="num">≥{{ minAge }}天数量</th>
                <th style="width: 96px" class="num">近90天出库</th>
                <th>建议</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in slow.rows" :key="i" :class="{ 'row-bad': r.out_90d <= 0 }">
                <td class="mono">{{ r.style_no }}</td>
                <td class="wrap">{{ r.product_name || '—' }}</td>
                <td class="tiny">{{ r.color || '—' }}/{{ r.size || '—' }}</td>
                <td class="num">{{ r.stock }}</td>
                <td class="num amt-red">{{ r.oldest_age }} 天</td>
                <td class="num">{{ r.old_qty }}</td>
                <td class="num" :class="r.out_90d <= 0 ? 'amt-red' : ''">{{ r.out_90d }}</td>
                <td class="wrap tiny">{{ r.suggest }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== 四、退货处理 ==================== -->
    <div v-else-if="tab === 'return'">
      <div v-if="!returns.length" class="empty-cell">没有退货单。客户退回的货先建单，再点收、判定、关单。</div>
      <div v-else class="table-wrap">
        <table class="rt-tbl">
          <thead>
            <tr>
              <th style="width: 140px">退货单号</th>
              <th style="width: 96px">类型</th>
              <th style="width: 210px">客户/来源</th>
              <th style="width: 96px">退货日期</th>
              <th style="width: 80px" class="num">申请</th>
              <th style="width: 80px" class="num">实收</th>
              <th style="width: 80px" class="num">良品</th>
              <th style="width: 80px" class="num">次品</th>
              <th style="width: 80px" class="num">报废</th>
              <th style="width: 110px">状态</th>
              <th style="width: 252px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in returns" :key="r.id" :class="{ 'row-warn': r.status === 'received' || r.status === 'inspected' }">
              <td class="mono">{{ r.return_no }}</td>
              <td class="tiny">{{ r.type_label }}</td>
              <td class="tiny">
                <div>{{ r.partner_name || '—' }}</div>
                <div v-if="r.source_no" class="muted src-no">{{ r.source_no }}</div>
              </td>
              <td class="tiny">{{ r.return_date || '—' }}</td>
              <td class="num">{{ r.qty_apply }}</td>
              <td class="num">{{ r.qty_received || '—' }}</td>
              <td class="num" :class="r.qty_good ? 'amt-green' : ''">{{ r.qty_good || '—' }}</td>
              <td class="num" :class="r.qty_defect ? 'amt-orange' : ''">{{ r.qty_defect || '—' }}</td>
              <td class="num" :class="r.qty_scrap ? 'amt-red' : ''">{{ r.qty_scrap || '—' }}</td>
              <td><span class="pill" :class="'rs-' + r.status">{{ r.status_label }}</span></td>
              <td class="ops">
                <button v-if="canWrite && r.status === 'draft'" class="btn btn-primary btn-sm" @click="openReceive(r)">点收</button>
                <button v-if="canWrite && r.status === 'received'" class="btn btn-primary btn-sm" @click="openInspect(r)">判定</button>
                <button v-if="canWrite && r.status === 'inspected'" class="btn btn-primary btn-sm" @click="doClose(r)">关单</button>
                <button class="btn btn-ghost btn-sm" @click="viewReturn(r)">明细</button>
                <button v-if="canWrite && ['draft','received'].includes(r.status)" class="btn btn-ghost btn-sm" @click="doCancel(r)">取消</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 点收弹窗 -->
    <div v-if="rcvModal" class="modal-mask">
      <div class="modal wide">
        <h3>点收 · {{ rcvModal.ret.return_no }}</h3>
        <p class="tiny muted" style="margin-bottom: 10px">
          申请退 {{ rcvModal.ret.qty_apply }} 件。实收不能超过申请数量；实收为 0 请直接取消这张单。
        </p>
        <table class="line-tbl">
          <thead><tr><th>款号 / 色码</th><th style="width: 90px" class="num">申请</th><th style="width: 110px">实收</th></tr></thead>
          <tbody>
            <tr v-for="l in rcvModal.lines" :key="l.id">
              <td class="tiny"><span class="mono">{{ l.style_no }}</span><span class="variant"> · {{ l.color || '-' }}/{{ l.size || '-' }}</span></td>
              <td class="num">{{ l.qty_apply }}</td>
              <td><input v-model.number="l.qty_received" class="cell-in num" type="number" min="0" :max="l.qty_apply" /></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="rcvModal = null">取消</button>
          <button class="btn btn-primary" @click="submitReceive">确认点收</button>
        </div>
      </div>
    </div>

    <!-- 判定弹窗 -->
    <div v-if="inspModal" class="modal-mask">
      <div class="modal wide">
        <h3>判定 · {{ inspModal.ret.return_no }}</h3>
        <p class="tiny muted" style="margin-bottom: 10px">
          良品 + 次品 + 报废 必须等于实收（要逐件判完）。<b>只有良品回可售库存</b>，次品与报废不进可售。
        </p>
        <table class="line-tbl">
          <thead>
            <tr>
              <th>款号 / 色码</th><th style="width: 74px" class="num">实收</th>
              <th style="width: 84px">良品</th><th style="width: 84px">次品</th><th style="width: 84px">报废</th>
              <th style="width: 60px" class="num">差</th>
              <th style="width: 140px">良品库位</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in inspModal.lines" :key="l.id">
              <td class="tiny"><span class="mono">{{ l.style_no }}</span><span class="variant"> · {{ l.color || '-' }}/{{ l.size || '-' }}</span></td>
              <td class="num">{{ l.qty_received }}</td>
              <td><input v-model.number="l.qty_good" class="cell-in num" type="number" min="0" /></td>
              <td><input v-model.number="l.qty_defect" class="cell-in num" type="number" min="0" /></td>
              <td><input v-model.number="l.qty_scrap" class="cell-in num" type="number" min="0" /></td>
              <td class="num" :class="lineDiff(l) ? 'amt-red' : 'amt-green'">{{ lineDiff(l) }}</td>
              <td>
                <select v-model="l.good_location" class="cell-in">
                  <option value="">—</option>
                  <option v-for="o in inspModal.locations.filter((x) => x.zone === 'sellable')" :key="o.id" :value="o.code">
                    {{ o.code }}
                  </option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="inspModal = null">取消</button>
          <button class="btn btn-primary" @click="submitInspect">确认判定并入库</button>
        </div>
      </div>
    </div>

    <!-- 新建退货单 -->
    <div v-if="rtForm" class="modal-mask">
      <div class="modal wide">
        <h3>新建退货单</h3>
        <div class="form-grid">
          <label class="fld">
            <span>退货类型</span>
            <select v-model="rtForm.type">
              <option v-for="t in dict.return_types" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </label>
          <label class="fld"><span>客户 / 店铺</span><input v-model="rtForm.partner_name" placeholder="洛杉矶批发商 Westline" /></label>
          <label class="fld"><span>原发货单号 / 运单号</span><input v-model="rtForm.source_no" placeholder="MATU8812034" /></label>
          <label class="fld"><span>退货日期</span><input v-model="rtForm.return_date" type="date" /></label>
          <label class="fld"><span>退货原因</span><input v-model="rtForm.reason" placeholder="尺码偏小 / 吊牌破损" /></label>
        </div>
        <div class="line-head">
          <b>退货明细</b>
          <button class="btn btn-ghost btn-sm" @click="rtForm.items.push({ style_no: '', product_name: '', color: '', size: '', qty_apply: 1 })">＋ 加一行</button>
        </div>
        <table class="line-tbl">
          <thead><tr><th>款号</th><th>品名</th><th style="width: 86px">颜色</th><th style="width: 76px">尺码</th><th style="width: 100px">数量</th><th style="width: 44px"></th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in rtForm.items" :key="i">
              <td><input v-model="l.style_no" class="cell-in" placeholder="SPOT-A" /></td>
              <td><input v-model="l.product_name" class="cell-in" /></td>
              <td><input v-model="l.color" class="cell-in" /></td>
              <td><input v-model="l.size" class="cell-in" /></td>
              <td><input v-model.number="l.qty_apply" class="cell-in num" type="number" min="1" /></td>
              <td><button class="btn btn-ghost btn-sm" @click="rtForm.items.splice(i, 1)">×</button></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="rtForm = null">取消</button>
          <button class="btn btn-primary" @click="submitReturn">创建</button>
        </div>
      </div>
    </div>

    <!-- 明细弹窗 -->
    <div v-if="detailModal" class="modal-mask">
      <div class="modal wide">
        <div class="rt-head">
          <div>
            <h3 style="margin: 0">{{ detailModal.return_no }} · {{ detailModal.type_label }}</h3>
            <p class="tiny muted" style="margin: 4px 0 0">
              {{ detailModal.partner_name || '—' }} · {{ detailModal.return_date }} · {{ detailModal.reason || '未填原因' }}
            </p>
          </div>
          <span class="pill" :class="'rs-' + detailModal.status">{{ detailModal.status_label }}</span>
        </div>
        <table class="line-tbl">
          <thead>
            <tr><th>款号 / 色码</th><th style="width: 74px" class="num">申请</th><th style="width: 74px" class="num">实收</th>
              <th style="width: 74px" class="num">良品</th><th style="width: 74px" class="num">次品</th><th style="width: 74px" class="num">报废</th>
              <th style="width: 110px">库位</th><th>备注</th></tr>
          </thead>
          <tbody>
            <tr v-for="i in detailModal.items" :key="i.id">
              <td class="tiny"><span class="mono">{{ i.style_no }}</span><span class="variant"> · {{ i.color || '-' }}/{{ i.size || '-' }}</span></td>
              <td class="num">{{ i.qty_apply }}</td>
              <td class="num">{{ i.qty_received || '—' }}</td>
              <td class="num">{{ i.qty_good || '—' }}</td>
              <td class="num">{{ i.qty_defect || '—' }}</td>
              <td class="num">{{ i.qty_scrap || '—' }}</td>
              <td class="mono tiny">{{ i.location_code || '—' }}</td>
              <td class="wrap tiny">{{ i.note || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-ops">
          <button class="btn btn-ghost" @click="detailModal = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';
import { can } from '../store/permissions';

const canWrite = computed(() => can('spot.write'));

const tab = ref('aging');
const dict = ref({ return_types: [], return_status: [] });
const ov = ref({ returns: {} });
const aging = ref({ buckets: [], styles: [], rows: [] });
const turnover = ref({ stat: {}, rows: [] });
const slow = ref({ rows: [] });
const returns = ref([]);
const days = ref(90);
const minAge = ref(60);
const rtStatus = ref('all');
const expanded = reactive({});

const rcvModal = ref(null);
const inspModal = ref(null);
const rtForm = ref(null);
const detailModal = ref(null);

const fmt = (v) => (Number(v) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

async function loadDict() {
  dict.value = await api.spotDict();
}
async function loadOverview() {
  ov.value = await api.spotOverview({});
}
async function loadAging() {
  aging.value = await api.spotAging({});
}
async function loadTurnover() {
  turnover.value = await api.spotTurnover({ days: days.value });
}
async function loadSlow() {
  slow.value = await api.spotSlowMoving({ min_age: minAge.value });
}
async function loadReturns() {
  returns.value = await api.spotReturns({ status: rtStatus.value });
}

async function reloadAll() {
  await Promise.all([loadOverview(), loadDict()]);
  if (tab.value === 'aging') await loadAging();
  if (tab.value === 'turnover') await loadTurnover();
  if (tab.value === 'slow') await loadSlow();
  if (tab.value === 'return') await loadReturns();
}

function go(t) {
  tab.value = t;
  if (t === 'aging') loadAging();
  if (t === 'turnover') loadTurnover();
  if (t === 'slow') loadSlow();
  if (t === 'return') loadReturns();
}

function toggleStyle(k) {
  expanded[k] = !expanded[k];
}
/** 某款下所有 SKU（含批次明细），供展开行用 */
function skuOfStyle(styleNo) {
  return (aging.value.rows || []).filter((x) => x.style_no === styleNo);
}

/* ---------------- 退货 ---------------- */
function openReturnForm() {
  rtForm.value = {
    type: 'customer', partner_name: '', source_no: '', reason: '',
    return_date: new Date().toISOString().slice(0, 10),
    items: [{ style_no: '', product_name: '', color: '', size: '', qty_apply: 1 }]
  };
}
async function submitReturn() {
  try {
    const r = await api.createSpotReturn(rtForm.value);
    rtForm.value = null;
    await reloadAll();
    alert(`已创建 ${r.return_no}，申请退 ${r.qty_apply} 件。下一步点「点收」。`);
  } catch (e) { alert('创建失败：' + e.message); }
}

async function openReceive(r) {
  const d = await api.spotReturn(r.id);
  rcvModal.value = {
    ret: d,
    lines: d.items.map((i) => ({ id: i.id, style_no: i.style_no, color: i.color, size: i.size, qty_apply: i.qty_apply, qty_received: i.qty_apply }))
  };
}
async function submitReceive() {
  try {
    const r = await api.receiveSpotReturn(rcvModal.value.ret.id, {
      items: rcvModal.value.lines.map((l) => ({ item_id: l.id, qty_received: Number(l.qty_received) }))
    });
    rcvModal.value = null;
    await reloadAll();
    alert(`点收完成：实收 ${r.qty_received} 件。下一步「判定」——良品回可售、次品与报废不进库存。`);
  } catch (e) { alert('点收失败：' + e.message); }
}

function lineDiff(l) {
  const s = Number(l.qty_good || 0) + Number(l.qty_defect || 0) + Number(l.qty_scrap || 0);
  return Math.round((Number(l.qty_received || 0) - s) * 100) / 100;
}

async function openInspect(r) {
  const d = await api.spotReturn(r.id);
  const sellable = (d.locations || []).find((x) => x.zone === 'sellable');
  inspModal.value = {
    ret: d,
    locations: d.locations || [],
    lines: d.items.map((i) => ({
      id: i.id, style_no: i.style_no, color: i.color, size: i.size,
      qty_received: i.qty_received,
      qty_good: i.qty_received, qty_defect: 0, qty_scrap: 0,
      good_location: sellable ? sellable.code : ''
    }))
  };
}
async function submitInspect() {
  const bad = inspModal.value.lines.find((l) => lineDiff(l) !== 0);
  if (bad) { alert(`款 ${bad.style_no} 良品+次品+报废 与实收差 ${lineDiff(bad)} 件，要判完才能提交`); return; }
  try {
    const r = await api.inspectSpotReturn(inspModal.value.ret.id, {
      items: inspModal.value.lines.map((l) => ({
        item_id: l.id,
        qty_good: Number(l.qty_good),
        qty_defect: Number(l.qty_defect),
        qty_scrap: Number(l.qty_scrap),
        good_location: l.good_location
      }))
    });
    inspModal.value = null;
    await reloadAll();
    alert(`判定完成：良品 ${r.qty_good}（已进可售库存）、次品 ${r.qty_defect}、报废 ${r.qty_scrap}。下一步「关单」。`);
  } catch (e) { alert('判定失败：' + e.message); }
}

async function doClose(r) {
  if (!confirm(`关单 ${r.return_no}？关单后不能再改判定。`)) return;
  try {
    await api.closeSpotReturn(r.id);
    await reloadAll();
  } catch (e) { alert('关单失败：' + e.message); }
}

async function doCancel(r) {
  const reason = prompt(`取消 ${r.return_no} 的原因（至少 4 个字）：`);
  if (reason === null) return;
  try {
    await api.cancelSpotReturn(r.id, { reason });
    await reloadAll();
  } catch (e) { alert('取消失败：' + e.message); }
}

async function viewReturn(r) {
  detailModal.value = await api.spotReturn(r.id);
}

onMounted(async () => {
  await Promise.all([loadOverview(), loadDict()]);
  await loadAging();
});
</script>

<style scoped>
.stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 14px; }
.stat { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 12px; padding: 11px 13px; }
.stat span { font-size: 12px; color: var(--ink-mute); }
.stat strong { display: block; margin: 4px 0 2px; font-size: 20px; color: var(--ink); }
.stat small { font-size: 12px; color: var(--ink-mute); }
.stat.st-good { background: #f2fbf5; border-color: #cfe9d8; }
.stat.st-good strong { color: #16a34a; }
.stat.st-warn { background: #fffaf2; border-color: #f3e0c2; }
.stat.st-warn strong { color: #d97706; }
.stat.st-bad { background: #fff5f6; border-color: #f6d4d9; }
.stat.st-bad strong { color: #d92d45; }
.amt-green { color: #16a34a; }
.amt-red { color: #d92d45; }
.amt-orange { color: #d97706; }
.muted { color: #9aa4b5; }
.tiny { font-size: 12px; }
.wrap { white-space: normal; line-height: 1.55; min-width: 110px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.variant { color: var(--ink-mute); margin-left: 2px; }
.num { text-align: right; }
.ops { white-space: nowrap; }
.row-warn { background: #fffdf7; }
.row-bad { background: #fff7f8; }
.tab-dot { display: inline-block; margin-left: 5px; background: #d92d45; color: #fff; font-size: 12px; border-radius: 8px; padding: 0 5px; vertical-align: middle; }
.hint-bar { background: #f6f9ff; border: 1px solid #dbe4f5; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #3d4a63; line-height: 1.7; margin: 0 0 12px; }
.hint-warn { background: #fffaf2; border: 1px solid #f3e0c2; border-radius: 9px; padding: 9px 12px; font-size: 12.5px; color: #b46207; margin: 10px 0 0; }
.block { margin-top: 16px; }
.block h4 { margin: 0 0 8px; font-size: 13px; color: var(--ink); }
.block h4 small { margin-left: 8px; font-weight: 400; font-size: 12px; color: #9aa4b5; }
.issue-bar { display: flex; justify-content: space-between; font-size: 12.5px; color: #4a566e; margin-bottom: 10px; }

/* 库龄色条 */
.age-bar { display: flex; height: 34px; border-radius: 9px; overflow: hidden; margin-bottom: 16px; background: #f3f6fb; }
.age-seg { display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff; min-width: 2px; transition: flex 0.3s; }
.seg-0 { background: #16a34a; }
.seg-1 { background: #65a30d; }
.seg-2 { background: #d97706; }
.seg-3 { background: #d92d45; }

.age-tbl { min-width: 1140px; width: 100%; }
.detail-row td { background: #fafcff; padding: 8px 10px !important; }
.lot-list { display: grid; gap: 5px; }
.lot-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lot-key { font-size: 12px; color: #4a566e; min-width: 92px; font-weight: 600; }
.lot-chip { font-size: 12px; background: #eef2f8; color: #4a566e; border-radius: 6px; padding: 2px 7px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.lot-chip.chip-warn { background: #fdf3e3; color: #b46207; }
.lot-chip.chip-bad { background: #fdecef; color: #c0243c; }

.turn-stat { display: grid; grid-template-columns: repeat(7, 1fr); gap: 9px; margin-bottom: 12px; }
.turn-stat > div { background: var(--surface); border: 1px solid #e6ebf3; border-radius: 10px; padding: 9px 11px; }
.turn-stat span { display: block; font-size: 12px; color: var(--ink-mute); }
.turn-stat b { font-size: 16px; color: var(--ink); }
.turn-tbl { min-width: 1240px; width: 100%; }
.slow-tbl { min-width: 1000px; width: 100%; }
.rt-tbl { min-width: 1360px; width: 100%; }
.src-no { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.line-tbl { min-width: 100%; width: 100%; }
.line-tbl th, .line-tbl td { padding: 5px 6px; }

.pill { display: inline-block; font-size: 12px; border-radius: 5px; padding: 1px 6px; white-space: nowrap; }
.p-ok { background: #eefaf2; color: #15803d; }
.p-warn { background: #fdf3e3; color: #b46207; }
.p-bad { background: #fdecef; color: #c0243c; }
.lv-good { background: #eefaf2; color: #15803d; }
.lv-watch { background: #fdf3e3; color: #b46207; }
.lv-slow { background: #fdecef; color: #c0243c; }
.lv-dead { background: #f3e8ff; color: #7c3aed; }
.lv-out { background: #eef2f8; color: var(--ink-soft); }
.rs-draft { background: #eef4ff; color: var(--brand); }
.rs-received { background: #fff6e8; color: #b46207; }
.rs-inspected { background: #fdf0e6; color: #c2410c; }
.rs-closed { background: #eefaf2; color: #15803d; }
.rs-cancelled { background: #f3f4f6; color: #9aa4b5; }

.form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
.fld { display: block; }
.fld span { display: block; font-size: 12px; color: #6b7791; margin-bottom: 4px; }
.fld input, .fld select { width: 100%; border: 1px solid #dbe3ef; border-radius: 8px; padding: 6px 9px; font-size: 13px; font-family: inherit; }
.line-head { display: flex; justify-content: space-between; align-items: center; margin: 10px 0 6px; font-size: 13px; color: var(--ink); }
.cell-in { width: 100%; border: 1px solid #e2e8f2; border-radius: 6px; padding: 4px 6px; font-size: 12.5px; font-family: inherit; }
.cell-in.num { text-align: right; }
.rt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }

.modal-mask { position: fixed; inset: 0; background: rgba(20, 30, 48, 0.42); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: var(--surface); border-radius: 14px; padding: 18px 20px; width: 560px; max-width: 94vw; max-height: 92vh; overflow: auto; box-shadow: 0 18px 50px rgba(16, 30, 55, 0.22); }
.modal.wide { width: 900px; }
.modal h3 { margin: 0 0 8px; font-size: 15px; color: var(--ink); }
.modal-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

@media (max-width: 900px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .turn-stat { grid-template-columns: repeat(2, 1fr); }
  .form-grid { grid-template-columns: 1fr; }
  .modal, .modal.wide { width: 94vw; }
}
</style>
