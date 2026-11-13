<template>
  <div>
    <div class="page-head">
      <div>
        <h2>{{techOnly?'生产审核':'审批中心'}}</h2>
        <div class="sub">{{techOnly?'按开发单核对技术资料，确认后流转到下一环节':'待技术确认 / 待财务审核 / 待分单 集中处理'}}</div>
      </div>
      <button class="btn btn-ghost" @click="load">刷新</button>
    </div>

    <!-- 通用模块统计概览条：生产审核视图只显示技术确认，数据来自 api.approvals() -->
    <ModuleStats :items="[
      { label: '待技术确认', value: d.techpacks.length, hint: '开发单技术资料' },
      ...(!techOnly ? [
        { label: '待财务审核', value: d.costs.length, hint: '成本单待审' },
        { label: '待分单', value: d.orders.length, hint: '待供应链分配', tone: 'danger' }
      ] : [])
    ]" />

    <!-- 待我审批（多级） -->
    <div v-if="!techOnly" class="panel-card">
      <h3>待我审批（多级流程）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>当前节点</th><th>总成本</th><th>出厂价</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td>{{ t.order_no || t.req_no || '-' }}<div v-if="t.change_no" class="muted">{{ t.change_no }} · {{ t.change_title }}</div></td>
            <td>{{ t.customer_name || '-' }}</td>
            <td>{{ t.style_name || '-' }}</td>
            <td><span class="tag blue">{{ t.step_name }}</span></td>
            <td>{{ t.target_type === 'order_change' ? '变更影响复核' : '¥'+money(t.total_cost) }}</td>
            <td>¥{{ money(t.factory_price) }}</td>
            <td>
              <button class="link-btn" @click="act(t, true)">通过</button>
              <button  class="link-btn danger" @click="act(t, false)">驳回</button>
            </td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="7" class="empty-cell">暂无待我审批</td></tr>
        </tbody>
      </table>
      <p style="font-size: 12px; color: var(--ink-mute); margin-top: 8px">成本单默认两级审批：财务审核 → 总经理审批；逐级通过后才算财务通过，可分单。</p>
    </div>

    <!-- 技术开发 · 生产审核：正式订单财务确认后、供应链分配前的独立核对环节 -->
    <div class="panel-card">
      <h3>生产审核（正式订单）<span class="tag blue" style="margin-left:8px">{{ audits.length }}</span></h3>
      <p style="font-size:12px;color:var(--ink-mute);margin:6px 0 10px">财务确认后流转到本环节；逐项核对信息无误后放行，订单进入供应链部「分配订单」（本厂生产 / 整单外发 / 裁片外发）。</p>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>件数 / 款数</th><th>交期</th><th>审核</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="o in audits" :key="o.id">
            <td>{{ o.order_no }}</td>
            <td>{{ o.customer_name || o.customer_name_snapshot || '-' }}</td>
            <td>{{ o.style_name || '-' }}</td>
            <td>{{ o.order_qty }} 件 / {{ o.style_count }} 款</td>
            <td>{{ o.delivery_date || o.latest_delivery_date || '-' }}</td>
            <td><span class="tag orange">{{ o.last_audit === 'reject' ? '退回重核' : '待核对' }}</span></td>
            <td><button v-if="canTech" class="link-btn" @click="openAudit(o)">逐项核对</button><button class="link-btn" @click="openOrder(o.id)">订单</button></td>
          </tr>
          <tr v-if="!audits.length"><td colspan="7" class="empty-cell">暂无待生产审核订单</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 待技术确认 -->
    <div class="panel-card">
      <h3>① 待技术确认（开发单）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>产品</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in d.techpacks" :key="t.id">
            <td>{{ t.order_no || t.req_no || '-' }}<div v-if="t.change_no" class="muted">{{ t.change_no }} · {{ t.change_title }}</div></td>
            <td>{{ t.customer_name || '-' }}</td>
            <td>{{ t.style_name || '-' }}</td>
            <td>{{ t.product_name }}</td>
            <td><span class="tag gray">待确认</span></td>
            <td>
              <button v-if="canTech" class="link-btn" @click="confirmTp(t)">确认</button>
              <button  v-if="canTech" class="link-btn danger" @click="rejectTp(t)">驳回</button>
              <button class="link-btn" @click="openOrder(t.order_id)">订单</button>
            </td>
          </tr>
          <tr v-if="!d.techpacks.length"><td colspan="6" class="empty-cell">无</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 待财务审核 -->
    <div v-if="!techOnly" class="panel-card">
      <h3>② 待财务审核（成本单）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>总成本</th><th>出厂价</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in d.costs" :key="c.order_id">
            <td>{{ c.order_no || '-' }}</td>
            <td>{{ c.customer_name || '-' }}</td>
            <td>{{ c.style_name || '-' }}</td>
            <td>¥{{ money(c.total_cost) }}</td>
            <td>¥{{ money(c.factory_price) }}</td>
            <td>
              <button v-if="canFinance" class="link-btn" @click="review(c, true)">通过</button>
              <button  v-if="canFinance" class="link-btn danger" @click="review(c, false)">驳回</button>
              <button class="link-btn" @click="openOrder(c.order_id)">订单</button>
            </td>
          </tr>
          <tr v-if="!d.costs.length"><td colspan="6" class="empty-cell">无</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 待分单 -->
    <div v-if="!techOnly" class="panel-card">
      <h3>③ 待分单（财务已通过）</h3>
      <table class="data">
        <thead><tr><th>订单号</th><th>客户</th><th>款名</th><th>交期</th><th>金额</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="o in d.orders" :key="o.id">
            <td>{{ o.order_no }}</td>
            <td>{{ o.customer_name || '-' }}</td>
            <td>{{ o.style_name || '-' }}</td>
            <td>{{ o.delivery_date || '-' }}</td>
            <td>¥{{ money(o.total_amount) }}</td>
            <td><button class="link-btn" @click="openOrder(o.id)">去分单</button></td>
          </tr>
          <tr v-if="!d.orders.length"><td colspan="6" class="empty-cell">无</td></tr>
        </tbody>
      </table>
      <p style="font-size: 12px; color: var(--ink-mute); margin-top: 8px">分单在订单详情「分单（本厂/外协）」区块完成。</p>
    </div>

    <!-- 生产审核核对弹窗：勾选结果会随审核记录落库，不是空按钮 -->
    <div v-if="auditRow" class="modal-mask">
      <div class="modal" style="max-width:560px">
        <div class="modal-head"><h3>生产审核 · {{ auditRow.order_no }}</h3><button class="x" @click="auditRow=null">×</button></div>
        <div class="modal-body">
          <p style="font-size:12.5px;color:var(--ink-mute);margin:0 0 10px">客户：{{ auditRow.customer_name || auditRow.customer_name_snapshot || '-' }} ｜ 款名：{{ auditRow.style_name || '-' }} ｜ {{ auditRow.order_qty }} 件 / {{ auditRow.style_count }} 款 / {{ auditRow.size_rows }} 条颜色尺码行</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-bottom:12px">
            <label v-for="c in auditChecks" :key="c" style="display:flex;align-items:center;gap:6px;font-size:12.5px"><input type="checkbox" :value="c" v-model="checkedItems" />{{ c }}</label>
          </div>
          <label style="font-size:12.5px">备注 / 退回原因<textarea class="input" v-model="auditNote" rows="2" placeholder="退回必填；通过可留空" style="width:100%;margin-top:4px"></textarea></label>
          <p style="font-size:12px;color:var(--ink-mute);margin:10px 0 0">核对通过后订单停留在「生产审核」，供应链部即可在「分配订单」中选择分配模式；分配覆盖整单后自动置为「已分单」。</p>
        </div>
        <div class="modal-foot"><button class="link-btn danger" :disabled="auditBusy" @click="submitAudit('reject')">退回重核</button><button class="btn btn-primary" :disabled="checkedItems.length<3||auditBusy" @click="submitAudit('approve')">{{ auditBusy?'提交中…':'核对无误，放行分配' }}</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter,useRoute } from 'vue-router';
import { api } from '../api';
import { can } from '../store/permissions';

const router = useRouter(),route=useRoute(),techOnly=computed(()=>route.query.scope==='tech');
const d = reactive({ techpacks: [], costs: [], orders: [] });
const tasks = ref([]);
// 技术开发 · 生产审核待办与核对弹窗
const audits = ref([]);
const auditRow = ref(null);
const auditBusy = ref(false);
const checkedItems = ref([]);
const auditNote = ref('');
const auditChecks = ['客户与订单号', '款号 / 款名', '颜色尺码与数量', '交期与交付要求', '工艺与物料资料', '图片 / 附件'];

const canTech = computed(() => can('development.review'));
const canFinance = computed(() => can('cost.review'));
const money = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

async function load() {
  try {
    const [r, mt, pa] = await Promise.all([
      api.approvals(), api.myApprovalTasks(), api.productionAudits().catch(() => [])
    ]);
    d.techpacks = r.techpacks || [];
    d.costs = r.costs || [];
    d.orders = r.orders || [];
    tasks.value = mt || [];
    audits.value = pa || [];
  } catch (e) { alert(e.message); }
}
async function act(t, approve) {
  const remark = approve ? prompt('审批意见（可空）') : prompt('驳回原因（可空）');
  try { await api.actApprovalTask(t.id, approve, remark || ''); await load(); }
  catch (e) { alert(e.message); }
}
function openOrder(id) { if (id) router.push('/orders?order=' + id); }

async function confirmTp(t) {
  try {
    // 与「订单页」同一条路：先取确认前检查，有缺口就把清单列出来（后端同一份判断）
    const chk = await api.techpackConfirmCheck(t.id);
    if (chk && !chk.ok) return alert(chk.message);
    await api.confirmTechpack(t.id);
    await load();
  } catch (e) { alert(e.message); }
}
async function rejectTp(t) {
  if (!confirm(`驳回开发单「${t.product_name}」？`)) return;
  try { await api.rejectTechpack(t.id); await load(); } catch (e) { alert(e.message); }
}
async function review(c, approve) {
  try { await api.reviewCost(c.order_id, approve, approve ? '同意' : '不通过'); await load(); }
  catch (e) { alert(e.message); }
}

function openAudit(o) { auditRow.value = o; checkedItems.value = []; auditNote.value = ''; }
async function submitAudit(decision) {
  if (!auditRow.value || auditBusy.value) return;
  if (decision === 'reject' && !String(auditNote.value).trim()) return alert('退回需填写原因');
  auditBusy.value = true;
  try {
    await api.auditProductionOrder(auditRow.value.id, {
      decision, checks: checkedItems.value, note: String(auditNote.value).trim()
    });
    auditRow.value = null;
    await load();
  } catch (e) { alert(e.message); } finally { auditBusy.value = false; }
}

onMounted(load);
</script>
