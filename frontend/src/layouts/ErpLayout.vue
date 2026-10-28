<template>
  <div class="erp-shell">
    <!-- 侧边栏 -->
    <aside class="erp-sidebar" :class="{ open: navOpen }">
      <div class="brand">
        <span class="dot"></span>
        跳色科技 ERP
      </div>
      <nav class="erp-nav">
        <template v-for="item in visibleModel" :key="item.key">
          <router-link v-if="item.to" :to="item.to" class="nav-item">
            <span class="nav-ico">{{ item.icon }}</span>{{ item.label }}
          </router-link>

          <div v-else class="nav-group">
            <button class="group-head" :class="{ open: openMap[item.key] }" @click="toggle(item.key)">
              <span class="nav-ico">{{ item.icon }}</span>
              <span class="g-label">{{ item.label }}</span>
              <span class="g-arrow">{{ openMap[item.key] ? '▾' : '▸' }}</span>
            </button>
            <div v-show="openMap[item.key]" class="group-body">
              <router-link v-for="c in visibleChildren(item)" :key="c.to" :to="c.to" class="sub">
                {{ c.label }}
              </router-link>
            </div>
          </div>
        </template>
      </nav>
      <div class="side-foot">100-500人企业版 · v1.0</div>
    </aside>

    <!-- 主区 -->
    <div class="erp-main">
      <!-- 移动端抽屉遮罩 -->
      <div v-if="navOpen" class="nav-mask" @click="navOpen = false"></div>

      <header class="erp-topbar">
        <button class="nav-toggle" @click="navOpen = true" aria-label="打开菜单">☰</button>
        <div class="crumb">{{ pageTitle }}</div>
        <router-link to="/mail" class="mail-bell" :title="mailTitle">
          📧
          <span v-if="mailUnread > 0" class="mb-badge">{{ mailUnread > 99 ? '99+' : mailUnread }}</span>
        </router-link>
        <div class="userbox">
          <span class="tag blue">{{ roleLabel }}</span>
          <span>{{ auth.user?.name || auth.user?.username }}</span>
          <div class="avatar">{{ initial }}</div>
          <button class="link-btn" @click="logout">退出</button>
        </div>
      </header>

      <section class="erp-content">
        <router-view />
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { auth, clearAuth, ROLE_LABELS } from '../store/auth';
import { api } from '../api';
import { myRoles } from '../store/permissions';


const route = useRoute();
const router = useRouter();

// 顶部邮件图标：未读 + 待确认 + 待办任务（EM02 / EM15）
const mailUnread = ref(0);
const mailTitle = computed(() => `内部邮件：未读 ${mailUnread.value} 封`);
async function loadMailUnread() {
  try {
    const d = await api.mailUnread();
    mailUnread.value = Number(d.inbox || 0) + Number(d.need_ack || 0);
  } catch (e) { mailUnread.value = 0; }
}
onMounted(loadMailUnread);
watch(() => route.path, () => { loadMailUnread(); });

// 一级=独立页；一级=分组（children 为二级菜单）
const navModel = [
  { key: 'dash', label: '工作台', icon: '📊', to: '/dashboard' },
  // 日清放在工作台紧后面：它是全员每天第一件事，不该藏在某个模块里
  { key: 'self', label: '我的自助', icon: '🙋', to: '/self' },
  { key: 'exceptions', label: '异常日清', icon: '🚨', to: '/exceptions' },
  { key: 'scan', label: '扫码查询', icon: '📷', to: '/scan' },
  { key: 'assist', label: '智能助手', icon: '🤖', to: '/assistant' },
  { key: 'mail', label: '内部邮件', icon: '📧', to: '/mail' },
  {
    key: 'archive', label: '档案', icon: '🗂️',
    children: [
      { label: '客户档案', to: '/customers' },
      { label: '供应商档案', to: '/suppliers' },
      { label: '面辅料档案', to: '/materials' },
      { label: '工厂档案', to: '/factories' },
      { label: '工序类别', to: '/craft-types' },
      { label: '员工档案', to: '/employees' }
    ]
  },
  {
    key: 'sales', label: '销售', icon: '🛒',
    children: [
      { label: '产品管理', to: '/products' },
      { label: '报价单', to: '/quotations' },
      { label: '客户确认', to: '/confirm-center' },
      { label: '客户商城', to: '/mall-admin' },
      { label: '零售与渠道', to: '/channel' },
      { label: '营销与素材', to: '/marketing' },
      { label: '客户营销与消息', to: '/notify' },
      { label: '销售与客户', to: '/sales' },
      { label: '客户进度发布', to: '/customer-progress' },
      { label: '售后与对账资料', to: '/after-sales' },
      { label: '销售订单', to: '/orders' }
    ]
  },
  {
    key: 'tech', label: '技术开发', icon: '🧵',
    children: [
      { label: '开发管理', to: '/development' },
      { label: '研发立项与 SKU 配码', to: '/dev-master' },
      { label: '供方协同与技术复审', to: '/sup-review' },
      { label: '打版流程', to: '/pattern-board' },
      { label: '样衣管理', to: '/sample-archive' }
    ]
  },
  {
    key: 'prod', label: '生产', icon: '🏭',
    children: [
      { label: '接单评审与交期', to: '/commitments' },
      { label: '齐套与缺料', to: '/requirements' },
      { label: '有限产能排程', to: '/schedule' },
      { label: '裁床与扎包', to: '/cuts' },
      { label: '扎级完工进度', to: '/bundle-progress' },
      { label: '裁片外发与外协验货', to: '/cut-dispatch' },
      { label: '首件确认', to: '/first-article' },
      { label: '生产管理', to: '/production' },
      { label: '质量与合规', to: '/quality' },
      { label: '现场照片', to: '/photos' },
      { label: '返工报废与结单', to: '/production-close' },
      { label: '设备与产能', to: '/equipment' },
      { label: '生产交付与质量', to: '/prod-report' },
      { label: '外协对账', to: '/outsource-recon' }
    ]
  },
  {
    key: 'stock', label: '仓储', icon: '📦',
    children: [
      { label: '库存管理', to: '/inventory' },
      { label: '采购管理', to: '/purchases' },
      { label: '供应商评价', to: '/supplier-eval' },
      { label: '停单改量退料', to: '/purchase-changes' },
      { label: '原料收货检验', to: '/receipts' },
      { label: '备料领退与盘点', to: '/material-flow' },
      { label: '美仓发货', to: '/us-ship' },
      { label: '供给批次与预订', to: '/supply' },
      { label: '美仓作业计划', to: '/wh-plan' },
      { label: '海外仓作业', to: '/overseas-warehouse' },
      { label: '现货经营与备货', to: '/spot-ops' },
      { label: '现货库龄与退货', to: '/spot-analysis' }
    ]
  },
  {
    key: 'approve', label: '审批', icon: '✅',
    children: [
      { label: '审批中心', to: '/approvals' },
      { label: '超时升级与SOP', to: '/process' },
      { label: '审批流配置', to: '/approval-flows', adminOnly: true },
      { label: '流程变更与发布', to: '/flow-changes', adminOnly: true },
      { label: '数据隐私与审计', to: '/privacy', adminOnly: true }
    ]
  },
  {
    key: 'finance', label: '财务', icon: '💰',
    children: [
      { label: '往来账', to: '/finance' },
      { label: '应收催收', to: '/collections' },
      { label: '客户信用与账期', to: '/credit' },
      { label: '应付与付款计划', to: '/payable' },
      { label: '资金计划（13 周）', to: '/cashflow' },
      { label: '付款申请', to: '/payment-requests' },
      { label: '成本与毛利', to: '/costing' },
      { label: '价格快照与费用池', to: '/pricing' },
      { label: '财务报表与关账', to: '/finance-books' },
      { label: '预算管理', to: '/budget' },
      { label: '税票银行与结算', to: '/bank' },
      { label: '税负测算', to: '/tax' },
      { label: '多主体与集团合并', to: '/group-books' },
      { label: '长期投资抵消', to: '/investment' },
      { label: '分公司经营对比', to: '/segments' },
      { label: '经营驾驶舱', to: '/cockpit' }
    ]
  },
  {
    key: 'hr', label: '人事行政', icon: '🧑‍💼',
    children: [
      { label: '组织编制与岗位', to: '/organization' },
      { label: '考勤打卡', to: '/attendance' },
      { label: '请假管理', to: '/leaves' },
      { label: '招聘与合同', to: '/hr' },
      { label: '薪酬核算', to: '/payrolls' },
      { label: '计件工资', to: '/piece-wage' },
      { label: '技能矩阵与资格', to: '/skills' },
      { label: '岗位绩效', to: '/kpi' },
      { label: '行政合同与证照', to: '/admin-contracts' },
      { label: '后勤管理', to: '/facility' },
      { label: '固定资产', to: '/assets' },
      { label: '行政费用', to: '/admin-expenses' }
    ]
  },
  {
    key: 'sys', label: '分析与系统', icon: '⚙️',
    children: [
      { label: '报表中心', to: '/reports' },
      { label: '数据质量与勾稽', to: '/data-quality' },
      { label: 'AI 能力中心', to: '/ai-center' },
      { label: '业务蓝图', to: '/blueprint' },
      { label: '真实数据导入', to: '/import-data' },
      { label: '系统设置', to: '/settings' },
      { label: '外部接口', to: '/integration' },
      { label: '权限复核', to: '/access-review', roles: ['admin', 'hr'] },
      { label: '备份与恢复', to: '/backup', adminOnly: true },
      { label: '移动工作台', to: '/m' },
      { label: '用户与角色', to: '/users', adminOnly: true },
      { label: '操作日志', to: '/audit', roles: ['admin', 'boss'] }
    ]
  }
];

const isAdmin = computed(() => auth.user?.role === 'admin');
function visibleChildren(item) {
  return (item.children || []).filter((c) => !c.adminOnly || isAdmin.value);
}
const visibleModel = computed(() =>
  navModel.filter((item) => item.to || visibleChildren(item).length > 0)
);

const navOpen = ref(false); // 移动端抽屉开关
const openMap = reactive({});
function openGroupForPath(path) {
  navModel.forEach((item) => {
    if (item.children && item.children.some((c) => path.startsWith(c.to))) openMap[item.key] = true;
  });
}
openGroupForPath(route.path);
watch(() => route.path, (p) => { openGroupForPath(p); navOpen.value = false; });

function toggle(key) { openMap[key] = !openMap[key]; }

const pageTitle = computed(() => route.meta.title || '工作台');
const roleLabel = computed(() => ROLE_LABELS[auth.user?.role] || auth.user?.role || '');
const initial = computed(() => {
  const n = auth.user?.name || auth.user?.username || '?';
  return n.slice(0, 1);
});

function logout() {
  clearAuth();
  router.push('/login');
}
</script>
