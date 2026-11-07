<template>
    <div class="erp-shell" :style="navPaletteStyle">
    <!-- 侧边栏 -->
    <aside class="erp-sidebar" :class="{ open: navOpen }">
      <div class="brand">
        <img class="brand-logo" :src="brandLogo" alt="跳色科技" data-no-image-preview />
        <span class="brand-copy"><strong>跳色科技</strong><small>协同 ERP</small></span>
      </div>
      <nav class="erp-nav">
        <template v-for="item in visibleModel" :key="item.key">
          <router-link v-if="item.to" :to="item.to" class="nav-item">
            <UiIcon class="nav-ico" :name="item.key" />{{ item.label }}
          </router-link>

          <div v-else class="nav-group">
            <button class="group-head" :class="{ open: openMap[item.key] }" @click="toggle(item.key)">
              <UiIcon class="nav-ico" :name="item.key" />
              <span class="g-label">{{ item.label }}</span><span v-if="(item.children||[]).reduce((n,c)=>n+reviewCount(c.to),0)" class="review-nav-badge">{{(item.children||[]).reduce((n,c)=>n+reviewCount(c.to),0)}}</span>
              <span class="g-arrow">{{ openMap[item.key] ? '▾' : '▸' }}</span>
            </button>
            <div v-show="openMap[item.key]" class="group-body">
              <router-link v-for="c in visibleChildren(item)" :key="c.to" :to="c.to" class="sub">
                {{ c.label }} <span v-if="reviewCount(c.to)" class="review-nav-badge">{{reviewCount(c.to)}}</span>
              </router-link>
            </div>
          </div>
        </template>
      </nav>
      <div class="side-foot"><span>企业协同工作空间</span><button class="appearance-trigger" type="button" aria-label="打开外观设置" @click="appearanceOpen=true"><UiIcon name="palette" /></button></div>
    </aside>

    <!-- 主区 -->
    <div class="erp-main">
      <!-- 移动端抽屉遮罩 -->
      <div v-if="navOpen" class="nav-mask" @click="navOpen = false"></div>

      <header class="erp-topbar">
        <button class="nav-toggle" @click="navOpen = true" aria-label="打开菜单">☰</button>
        <div class="crumb">
          <span class="crumb-home">首页</span><span class="crumb-separator">/</span>
          <span>{{ sectionTitle }}</span><span class="crumb-separator">/</span>
          <strong>{{ pageTitle }}</strong>
        </div>
        <router-link to="/assistant" class="yc-help">帮助中心</router-link>
        <button class="yc-icon-btn" type="button" title="全屏" aria-label="全屏" @click="toggleFullscreen">⛶</button>
        <router-link to="/mail" class="mail-bell" :title="mailTitle">
          <UiIcon name="mail" />
          <span v-if="mailUnread > 0" class="mb-badge">{{ mailUnread > 99 ? '99+' : mailUnread }}</span>
        </router-link>
        <button class="theme-toggle" type="button" @click="toggleTheme" :aria-label="theme.mode === 'dark' ? '切换浅色模式' : '切换深色模式'" :title="theme.mode === 'dark' ? '切换浅色模式' : '切换深色模式'">
          <span class="theme-toggle-icon">{{ theme.mode === 'dark' ? '☀' : '☾' }}</span>
          <span class="theme-toggle-label">{{ theme.mode === 'dark' ? '浅色' : '深色' }}</span>
        </button>
        <button class="appearance-top-trigger" type="button" @click="appearanceOpen=true"><UiIcon name="palette" /><span>外观</span></button>
        <div class="userbox">
          <div class="yc-user">
            <div class="avatar">{{ initial }}</div>
            <div class="yc-user-txt">
              <b>{{ auth.user?.name || auth.user?.username }}</b>
              <small>{{ roleLabel }}</small>
            </div>
          </div>
          <button class="link-btn" @click="logout">退出</button>
        </div>
      </header>

      <!-- 二级页签：文字对齐参考系统，跳转与下拉子项全部取自本地真实路由 -->
      <div class="yc-tabs">
        <div v-for="t in quickTabs" :key="t.label" class="yc-tab-wrap">
          <router-link :to="t.to" class="yc-tab" :class="{ on: isTabOn(t) }" @click="openTab = ''">
            <span v-if="t.dot" class="yc-dot"></span>{{ t.label }}
            <span v-if="tabBadge(t)" class="yc-badge">{{ tabBadge(t) }}</span>
          </router-link>
          <button class="yc-tab-caret" type="button" :aria-label="`${t.label} 子菜单`" @click.stop="toggleTab(t.label)">▾</button>
          <div v-if="openTab === t.label" class="yc-tab-menu">
            <router-link v-for="c in tabChildren(t)" :key="c.to" :to="c.to" @click="openTab = ''">{{ c.label }}</router-link>
            <span v-if="!tabChildren(t).length" class="yc-tab-empty">该模块暂无授权子页面</span>
          </div>
        </div>
      </div>

      <section class="erp-content">
        <router-view />
      </section>
    </div>
    <AssistantWidget />
    <AppearanceSettings v-model="appearanceOpen"><template #navigation>
          <div class="nav-palette-options">
            <button v-for="preset in navPalettePresets" :key="preset.id" type="button" class="nav-palette-option" :class="{ selected: navPaletteId === preset.id }" :aria-label="`${preset.label}导航配色`" :title="preset.label" @click="selectNavPalette(preset.id)">
              <span class="nav-swatch" :style="{ '--swatch': preset.bg, '--swatch-accent': preset.accent }"><i></i></span>
              <span>{{ preset.label }}</span>
            </button>
          </div>
          <label class="nav-custom-option" :class="{ selected: navPaletteId === 'custom' }">
            <span class="nav-swatch custom" :style="{ '--swatch': customNavColor, '--swatch-accent': '#315ee8' }"><i></i></span>
            <span>自定义颜色</span>
            <input type="color" :value="customNavColor" aria-label="选择自定义导航背景色" @input="updateCustomNavColor">
          </label>

      <label class="appearance-field">所有列表每页条数<select class="select" v-model.number="globalPageSize"><option v-for="size in PAGE_SIZES" :key="size" :value="size">{{size}} 条</option></select></label>
    </template></AppearanceSettings>
  </div>
</template>

<script setup>
import {reviewCount,refreshReviewNotices} from '../store/reviewNotices';
import UiIcon from '../components/UiIcon.vue';
import AppearanceSettings from '../components/AppearanceSettings.vue';
import { globalPageSize, PAGE_SIZES } from '../composables/useListPagination';
import { computed, onMounted, reactive, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { auth, clearAuth, ROLE_LABELS } from '../store/auth';
import { api } from '../api';
import { myRoles, permState } from '../store/permissions';
import { theme, toggleTheme } from '../store/theme';
import { brandLogoMode } from '../store/appearance';
import AssistantWidget from '../components/AssistantWidget.vue';
import { canVisit } from '../store/navigation';
// 品牌素材（Vite 打包后自动带 hash；放在 src 下才能被实时镜像同步到局域网 Vite）
import logoDark from '../assets/brand/jump-color-dark.png';
import logoLight from '../assets/brand/jump-color-light.png';
import logoFestive from '../assets/brand/jump-color-festive.png';


const route = useRoute();
const router = useRouter();

// 顶部邮件图标：未读 + 待确认 + 待办任务（EM02 / EM15）
/**
 * 单公司模式（默认 true，先按单公司渲染，避免首屏闪出多主体入口）
 *
 * 后端 /api/settings 返回的 single_company 是唯一判据：前端不猜、不自己配。
 * 为 true 时隐藏「多主体与集团合并」「长期投资抵消」「分公司经营对比」三个入口 ——
 * 它们只在一家公司的库上没有意义（进去全是空的分部对比）。
 * 接口本身保留（集团模块不删），只是不给人看到入口。
 */
const singleCompany = ref(true);

const mailUnread = ref(0);
const mailTitle = computed(() => `内部邮件：未读 ${mailUnread.value} 封`);
async function loadMailUnread() {
  try {
    const d = await api.mailUnread();
    mailUnread.value = Number(d.inbox || 0) + Number(d.need_ack || 0);
  } catch (e) { mailUnread.value = 0; }
}
onMounted(loadMailUnread);
let reviewTimer;onMounted(()=>{refreshReviewNotices();reviewTimer=setInterval(refreshReviewNotices,45000);window.addEventListener('focus',refreshReviewNotices);});onBeforeUnmount(()=>{clearInterval(reviewTimer);window.removeEventListener('focus',refreshReviewNotices);});watch(()=>route.fullPath,refreshReviewNotices);watch(()=>auth.token,refreshReviewNotices);
onMounted(async () => {
  try {
    const s = await api.settings();
    singleCompany.value = s.single_company !== false;
  } catch (e) {
    // 读不到就按单公司处理：多露一个入口比"整站菜单消失"轻得多
    singleCompany.value = true;
  }
});
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
      { label: '报价单', to: '/quotations' },
      { label: '客户确认', to: '/confirm-center' },
      { label: '客户营销与消息', to: '/notify' },
      { label: '销售与客户', to: '/sales' },
      { label: '客户进度发布', to: '/customer-progress' },
      { label: '预下单', to: '/pre-orders' },
      { label: '销售订单', to: '/orders' }
    ]
  },
  /**
   * 零售与营销：从「销售」里拆出来的低频模块
   *
   * 拆的原因：销售原来挂了 12 项，日常在用的其实只有报价 → 确认 → 下单这条线，
   * 产品档案、商城、渠道、素材、售后资料都属于"偶尔才进一次"，混在一起让常用项
   * 被稀释、每次找单都得扫一遍全表。拆成独立模块后，销售只留主链路。
   * 路由与接口一律没动（只动菜单归组），所以权限、收藏、外部链接、页面内跳转都不受影响。
   */
  {
    key: 'retail', label: '零售与营销', icon: '🏷️',
    children: [
      { label: '产品管理', to: '/products' },
      { label: '客户商城', to: '/mall-admin' },
      { label: '零售与渠道', to: '/channel' },
      { label: '营销与素材', to: '/marketing' },
      { label: '售后与对账资料', to: '/after-sales' }
    ]
  },
  {
    key: 'tech', label: '技术开发', icon: '🧵',
    children: [
      { label: '开发管理', to: '/development' },
      { label: '面辅料新品开发', to: '/material-development' },
      { label: '研发立项与 SKU 配码', to: '/dev-master' },
      { label: '供方协同与技术复审', to: '/sup-review' },
      { label: '打版流程', to: '/pattern-board' },
      {label:'打样室',to:'/pattern-board?workbench=sample'},
      { label: '样衣管理', to: '/sample-archive' }
    ]
  },
  {
    key: 'purchase', label: '供应链部', icon: '🛍',
    children: [
      { label: '采购列表', to: '/purchases' },
      { label: '分配订单', to: '/order-allocation' }
    ]
  },
  {key:'front',label:'生产前端',icon:'✂',children:[{label:'订单',to:'/order-tracking'},{label:'裁床',to:'/production?station=cut'},{label:'仓库',to:'/production?station=warehouse'}]},
  {key:'back',label:'生产后端',icon:'🏭',children:[{label:'车间',to:'/production?station=workshop'},{label:'后整',to:'/production?station=finish'}]},
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
      { label: '订单跟踪', to: '/order-tracking' },
      { label: '生产管理', to: '/production' },
      { label: '质量与合规', to: '/quality' },
      { label: '现场照片', to: '/photos' },
      { label: '返工报废与结单', to: '/production-close' },
      { label: '设备与产能', to: '/equipment' },
      { label: '生产交付与质量', to: '/prod-report' },
      { label: '外协对账', to: '/outsource-recon' },
      { label: '工序流程配置', to: '/node-flow' }
    ]
  },
  {
    key: 'stock', label: '仓储', icon: '📦',
    children: [
      { label: '库存管理', to: '/inventory' },
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
    key: 'finance', label: '财务管理', icon: '💰',
    children: [
      { label: '财务数据', to: '/finance' },
      { label: '应收催收', to: '/collections' },
      { label: '客户信用与账期', to: '/credit' },
      { label: '应付与付款计划', to: '/payable' },
      { label: '资金计划（13 周）', to: '/cashflow' },
      { label: '付款申请', to: '/payment-requests' },
      { label: '成本核算', to: '/costing' },
      { label: '价格快照与费用池', to: '/pricing' },
      { label: '财务报表与关账', to: '/finance-books' },
      { label: '预算管理', to: '/budget' },
      { label: '税票银行与结算', to: '/bank' },
      { label: '税负测算', to: '/tax' },
      { label: '多主体与集团合并', to: '/group-books', groupOnly: true },
      { label: '长期投资抵消', to: '/investment', groupOnly: true },
      { label: '分公司经营对比', to: '/segments', groupOnly: true },
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
      { label: '薪酬计件与工资核对', to: '/payroll-check' },
      { label: '计件工资', to: '/piece-wage' },
      { label: '技能矩阵与资格', to: '/skills' },
      { label: '岗位绩效', to: '/kpi' },
      { label: '行政合同与证照', to: '/admin-contracts' },
      { label: '后勤管理', to: '/facility' },
      { label: '办公耗材与服务采购', to: '/office-supply' },
      { label: '资产工衣与领归', to: '/custody' },
      { label: '固定资产', to: '/assets' },
      { label: '行政费用', to: '/admin-expenses' },
      { label: '行政运营报表', to: '/admin-ops' }
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
      { label: '权限管理', to: '/permission-management', adminOnly: true },
      { label: '上线检查清单', to: '/go-live' },
      { label: '数据导出与订阅', to: '/export-center' },
      { label: '备份与恢复', to: '/backup', adminOnly: true },
      { label: '移动工作台', to: '/m' },
      { label: '用户与角色', to: '/users', adminOnly: true },
      { label: '操作日志', to: '/audit', roles: ['admin', 'boss'] }
    ]
  }
];

const isAdmin = computed(() => auth.user?.role === 'admin');
/** 菜单显示与模块授权同步，旧账号仍沿用既有导航。 */
function canNavigate(to){
 return canVisit(to);
}
function visibleChildren(item) {
  return (item.children || []).filter((c) =>
    (!c.adminOnly || isAdmin.value) && canNavigate(c.to)
    /**
     * groupOnly = 只对多主体有意义的入口（集团合并 / 内部投资抵消 / 分部对比）。
     * 单公司模式下隐藏；切回多主体（SINGLE_COMPANY=0）会自动重新出现。
     */
    && (!c.groupOnly || !singleCompany.value)
  );
}
const visibleModel = computed(() =>
  navModel.filter((item) => {
    if(!permState.positionDirect&&myRoles().length&&myRoles().every(r=>r==='employee'))return ['/self','/exceptions','/scan','/assistant','/mail'].includes(item.to);
    return item.to ? canNavigate(item.to) : visibleChildren(item).length > 0;
  })
);

const navOpen = ref(false); // 移动端抽屉开关
const openMap = reactive({});
const appearanceOpen=ref(false);
const navPalettePresets = [
  // 「跳色蓝」是参考截图的亮蓝侧栏，作为默认项；深色显示模式下自动切深蓝。
  // 侧栏皮肤只读这里的 --nav-* 变量，不再写死颜色，外观设置每个预设都能即时生效。
  // id 沿用 yichuang 只是内部标识，避免已保存过该设置的浏览器丢失选择。
  { id: 'yichuang', label: '跳色蓝', bg: '#1668f0', accent: '#0f57d8' },
  // 「跳色彩色」为节日/自定义皮肤配色，搭配「彩色·节日」品牌图标使用。
  { id: 'festive', label: '跳色彩色', bg: '#233a6b', accent: '#ff4d8d' },
  {id:'pearl',label:'雾白',bg:'#f9fbfb',accent:'#1d7066'},
  { id: 'navy', label: '海军蓝', bg: '#10203f', accent: '#2b6de5' },
  { id: 'graphite', label: '石墨灰', bg: '#272d38', accent: '#5388f4' },
  { id: 'forest', label: '森林绿', bg: '#173b35', accent: '#27a47e' },
  { id: 'violet', label: '暮紫', bg: '#302341', accent: '#8a67e8' },
  { id: 'ocean', label: '深海蓝', bg: '#17364b', accent: '#28a3c7' }
];
const savedNavPalette = localStorage.getItem('erp_nav_palette') || 'yichuang';
const navPaletteId = ref(navPalettePresets.some((preset) => preset.id === savedNavPalette) || savedNavPalette === 'custom' ? savedNavPalette : 'yichuang');
const customNavColor = ref(localStorage.getItem('erp_nav_custom_color') || '#26394b');

/** 背景亮度（0-255），用于判断侧栏该用黑色还是白色 Logo */
function lightness(bg) {
  const rgb = String(bg).match(/[\da-f]{2}/gi)?.slice(0, 3).map((part) => parseInt(part, 16)) || [16, 32, 63];
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
}

const navPaletteStyle = computed(() => {
  const preset = navPalettePresets.find((item) => item.id === navPaletteId.value);
  let bg;
  if (navPaletteId.value === 'custom') bg = customNavColor.value;
  else if (navPaletteId.value === 'pearl') bg = theme.mode === 'dark' ? '#151e26' : '#f9fbfb';
  else if (navPaletteId.value === 'yichuang') bg = theme.mode === 'dark' ? '#16386b' : '#1668f0';
  else bg = preset?.bg || '#f9fbfb';
  const light = lightness(bg) > 155;
  const accent = navPaletteId.value === 'yichuang' && theme.mode === 'dark'
    ? '#2f6fd0'
    : (preset?.accent || '#315ee8');
  return {
    '--nav-bg': bg,
    '--nav-ink': light ? '#182230' : '#f8fbff',
    '--nav-text': light ? '#40516a' : '#c9d6ee',
    '--nav-muted': light ? '#65758c' : '#9aacc8',
    '--nav-accent': accent,
    '--nav-accent-ink': '#ffffff',
    '--nav-hover': light ? 'rgba(20, 35, 61, .08)' : 'rgba(255, 255, 255, .10)'
  };
});
// 浅色侧栏用黑色 Logo，深色侧栏用白色 Logo；「彩色·节日」优先。
const navIsLight = computed(() => lightness(navPaletteStyle.value['--nav-bg']) > 155);
const brandLogo = computed(() => {
  if (brandLogoMode.value === 'festive') return logoFestive;
  return navIsLight.value ? logoDark : logoLight;
});
function selectNavPalette(id) {
  navPaletteId.value = id;
  localStorage.setItem('erp_nav_palette', id);
}
function updateCustomNavColor(event) {
  customNavColor.value = event.target.value;
  localStorage.setItem('erp_nav_custom_color', customNavColor.value);
  selectNavPalette('custom');
}
function openGroupForPath(path) {
  navModel.forEach((item) => {
    if (item.children && item.children.some((c) => path.startsWith(c.to))) openMap[item.key] = true;
  });
}
openGroupForPath(route.path);
watch(() => route.path, (p) => { openGroupForPath(p); navOpen.value = false; });

function toggle(key) { openMap[key] = !openMap[key]; }

/**
 * 参考系统的二级页签。
 * 文案与顺序对齐截图，但 to 一律指向本地真实路由；下拉子项直接复用
 * navModel 的分组（经 visibleChildren 做权限过滤），不新增死链、不丢入口。
 * 多个页签指向同一路由时只高亮第一个，避免整排同时亮起。
 */
const quickTabs = [
  { label: '首页', to: '/dashboard' },
  { label: '生产订单', to: '/orders', group: 'prod' },
  { label: '采购列表', to: '/purchases', group: 'purchase' },
  { label: '打版流程', to: '/pattern-board', group: 'tech' },
  { label: '现货开单', to: '/spot-ops', group: 'stock' },
  { label: '开销售单', to: '/orders', group: 'sales' },
  { label: '开发管理', to: '/development', group: 'tech' },
  { label: '样衣管理', to: '/sample-archive', group: 'tech', dot: true, badgeFrom: '/sample-archive' },
  { label: '业务订单', to: '/orders', group: 'sales' }
];
const openTab = ref('');
function toggleTab(label) { openTab.value = openTab.value === label ? '' : label; }
function tabChildren(t) {
  const group = navModel.find((i) => i.key === t.group);
  return group ? visibleChildren(group) : [];
}
function tabBadge(t) { return t.badgeFrom ? (reviewCount(t.badgeFrom) || 0) : 0; }
function isTabOn(t) {
  const p = route.path;
  if (p !== t.to && !p.startsWith(t.to + '/')) return false;
  return quickTabs.find((x) => x.to === t.to) === t;
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.();
}

/** 面包屑中间级：按当前路径归属的菜单分组显示，不写死「样衣」。 */
const sectionTitle = computed(() => {
  const hit = navModel.find((i) => i.children && i.children.some((c) => route.path.startsWith(String(c.to).split('?')[0])));
  return hit?.label || '工作空间';
});
const pageTitle = computed(() => route.meta.title || '工作台');
const roleLabel = computed(() => permState.positionName || ROLE_LABELS[auth.user?.role] || auth.user?.role || '');
const initial = computed(() => {
  const n = auth.user?.name || auth.user?.username || '?';
  return n.slice(0, 1);
});

function logout() {
  clearAuth();
  router.push('/login');
}
</script>

<style scoped>
.global-page-size { display: flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.global-page-size .select { width: 88px; padding: 5px 8px; }
@media(max-width: 760px) { .global-page-size > span { display: none; } }
.review-nav-badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:10px;background:#e94f61;color:#fff;font-size:10px;margin-left:6px}
</style>
