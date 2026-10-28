import { syncPerms, permState } from './store/permissions';
import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './store/auth';

import Login from './views/Login.vue';
import ErpLayout from './layouts/ErpLayout.vue';
import Dashboard from './views/Dashboard.vue';
import Scan from './views/Scan.vue';
import Customers from './views/Customers.vue';
import Products from './views/Products.vue';
import Orders from './views/Orders.vue';
import Quotations from './views/Quotations.vue';
import Development from './views/Development.vue';
import Materials from './views/Materials.vue';
import MaterialEdit from './views/MaterialEdit.vue';
import Finance from './views/Finance.vue';
import Costing from './views/Costing.vue';
import Commitments from './views/Commitments.vue';
import Requirements from './views/Requirements.vue';
import Cuts from './views/Cuts.vue';
import FirstArticle from './views/FirstArticle.vue';
import Receipts from './views/Receipts.vue';
import Mail from './views/Mail.vue';
import SupplierEval from './views/SupplierEval.vue';
import PurchaseChanges from './views/PurchaseChanges.vue';
import ProductionClose from './views/ProductionClose.vue';
import Equipment from './views/Equipment.vue';
import Kpi from './views/Kpi.vue';
import AdminContracts from './views/AdminContracts.vue';
import Process from './views/Process.vue';
import DataQuality from './views/DataQuality.vue';
import OverseasWarehouse from './views/OverseasWarehouse.vue';
import FinanceBooks from './views/FinanceBooks.vue';
import SpotAnalysis from './views/SpotAnalysis.vue';
import AiCenter from './views/AiCenter.vue';
import Budget from './views/Budget.vue';
import Bank from './views/Bank.vue';
import GroupBooks from './views/GroupBooks.vue';
import Cockpit from './views/Cockpit.vue';
import Marketing from './views/Marketing.vue';
import Organization from './views/Organization.vue';
import Tax from './views/Tax.vue';
import Sales from './views/Sales.vue';
import Supply from './views/Supply.vue';
import Notify from './views/Notify.vue';
import WhPlan from './views/WhPlan.vue';
import Schedule from './views/Schedule.vue';
import SpotOps from './views/SpotOps.vue';
import Segments from './views/Segments.vue';
import MaterialFlow from './views/MaterialFlow.vue';
import Pricing from './views/Pricing.vue';
import Investment from './views/Investment.vue';
import CutDispatch from './views/CutDispatch.vue';
import DevMaster from './views/DevMaster.vue';
import SupReview from './views/SupReview.vue';
import ImportData from './views/ImportData.vue';
import AccessReview from './views/AccessReview.vue';
import Backup from './views/Backup.vue';
import Suppliers from './views/Suppliers.vue';
import CraftTypes from './views/CraftTypes.vue';
import PatternBoard from './views/PatternBoard.vue';
import SampleArchive from './views/SampleArchive.vue';
import Production from './views/Production.vue';
import Factories from './views/Factories.vue';
import OutsourceRecon from './views/OutsourceRecon.vue';
import Inventory from './views/Inventory.vue';
import Purchases from './views/Purchases.vue';
import UsShip from './views/UsShip.vue';
import Reports from './views/Reports.vue';
import Approvals from './views/Approvals.vue';
import Employees from './views/Employees.vue';
import Assistant from './views/Assistant.vue';
import Leaves from './views/Leaves.vue';
import Audit from './views/Audit.vue';
import ApprovalFlows from './views/ApprovalFlows.vue';
import Attendance from './views/Attendance.vue';
import Payrolls from './views/Payrolls.vue';
import Assets from './views/Assets.vue';
import AdminExpenses from './views/AdminExpenses.vue';
import Blueprint from './views/Blueprint.vue';
import Settings from './views/Settings.vue';
import Users from './views/Users.vue';
import Print from './views/Print.vue';
import Payslip from './views/Payslip.vue';
import Statement from './views/Statement.vue';
import PrintBatch from './views/PrintBatch.vue';
import ScanGo from './views/ScanGo.vue';
import MobileHome from './views/MobileHome.vue';
import MobileReport from './views/MobileReport.vue';
import MobilePhoto from './views/MobilePhoto.vue';
import Photos from './views/Photos.vue';
import InspectionReport from './views/InspectionReport.vue';
import BundleProgress from './views/BundleProgress.vue';
import PieceWage from './views/PieceWage.vue';
import QuotePrint from './views/QuotePrint.vue';
import MallAdmin from './views/MallAdmin.vue';
import Quality from './views/Quality.vue';
import Channel from './views/Channel.vue';
import ConfirmCenter from './views/ConfirmCenter.vue';
import Hr from './views/Hr.vue';
import Facility from './views/Facility.vue';
import Integration from './views/Integration.vue';
import MallLogin from './views/mall/MallLogin.vue';
import MallInvite from './views/mall/MallInvite.vue';
import Mall from './views/mall/Mall.vue';
import MallGuest from './views/mall/MallGuest.vue';
import LabelPrint from './views/LabelPrint.vue';

const routes = [
  { path: '/login', component: Login, meta: { public: true } },
  // 客户商城：客户账号独立登录，不受 ERP 登录态影响
  { path: '/mall/login', component: MallLogin, meta: { public: true, title: '客户登录' } },
  { path: '/mall/invite/:token', component: MallInvite, meta: { public: true, title: '客户注册' } },
  { path: '/mall/guest', component: MallGuest, meta: { public: true, title: '公开目录' } },
  { path: '/mall', component: Mall, meta: { public: true, title: '客户选品中心' } },
  {
    path: '/',
    component: ErpLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', component: Dashboard, meta: { title: '工作台' } },
      { path: 'scan', component: Scan, meta: { title: '扫码查询' } },
      { path: 'approvals', component: Approvals, meta: { title: '审批中心' } },
      { path: 'assistant', component: Assistant, meta: { title: '智能助手' } },
      { path: 'employees', component: Employees, meta: { title: '人事行政' } },
      { path: 'leaves', component: Leaves, meta: { title: '请假管理' } },
      { path: 'attendance', component: Attendance, meta: { title: '考勤打卡' } },
      { path: 'payrolls', component: Payrolls, meta: { title: '薪酬核算' } },
      { path: 'piece-wage', component: PieceWage, meta: { title: '计件工资' } },
      { path: 'hr', component: Hr, meta: { title: '招聘与合同' } },
      { path: 'facility', component: Facility, meta: { title: '后勤管理' } },
      { path: 'integration', component: Integration, meta: { title: '外部接口' } },
      { path: 'assets', component: Assets, meta: { title: '固定资产' } },
      { path: 'admin-expenses', component: AdminExpenses, meta: { title: '行政费用' } },
      { path: 'audit', component: Audit, meta: { title: '操作日志' } },
      { path: 'approval-flows', component: ApprovalFlows, meta: { title: '审批流配置' } },
      { path: 'customers', component: Customers, meta: { title: '客户管理' } },
      { path: 'products', component: Products, meta: { title: '产品管理' } },
      { path: 'orders', component: Orders, meta: { title: '销售订单' } },
      { path: 'quotations', component: Quotations, meta: { title: '报价单' } },
      { path: 'mall-admin', component: MallAdmin, meta: { title: '客户商城' } },
      { path: 'channel', component: Channel, meta: { title: '零售与渠道' } },
      { path: 'confirm-center', component: ConfirmCenter, meta: { title: '客户确认' } },
      { path: 'development', component: Development, meta: { title: '开发管理' } },
      { path: 'pattern-board', component: PatternBoard, meta: { title: '打版流程' } },
      { path: 'sample-archive', component: SampleArchive, meta: { title: '样衣管理' } },
      { path: 'finance', component: Finance, meta: { title: '往来账' } },
      { path: 'costing', component: Costing, meta: { title: '成本与毛利' } },
      { path: 'commitments', component: Commitments, meta: { title: '接单评审与交期' } },
      { path: 'requirements', component: Requirements, meta: { title: '齐套与缺料' } },
      { path: 'bundle-progress', component: BundleProgress, meta: { title: '扎级完工进度' } },
      { path: 'cuts', component: Cuts, meta: { title: '裁床与扎包' } },
      { path: 'first-article', component: FirstArticle, meta: { title: '首件确认' } },
      { path: 'receipts', component: Receipts, meta: { title: '原料收货检验' } },
      { path: 'supplier-eval', component: SupplierEval, meta: { title: '供应商评价' } },
      { path: 'purchase-changes', component: PurchaseChanges, meta: { title: '停单改量退料' } },
      { path: 'production-close', component: ProductionClose, meta: { title: '返工报废与结单' } },
      { path: 'equipment', component: Equipment, meta: { title: '设备与产能' } },
      { path: 'kpi', component: Kpi, meta: { title: '岗位绩效' } },
      { path: 'admin-contracts', component: AdminContracts, meta: { title: '行政合同与证照' } },
      { path: 'process', component: Process, meta: { title: '超时升级与SOP' } },
      { path: 'data-quality', component: DataQuality, meta: { title: '数据质量与勾稽' } },
      { path: 'overseas-warehouse', component: OverseasWarehouse, meta: { title: '海外仓作业' } },
      { path: 'finance-books', component: FinanceBooks, meta: { title: '财务报表与关账' } },
      { path: 'spot-analysis', component: SpotAnalysis, meta: { title: '现货库龄与退货' } },
      { path: 'ai-center', component: AiCenter, meta: { title: 'AI 能力中心' } },
      { path: 'budget', component: Budget, meta: { title: '预算管理' } },
      { path: 'bank', component: Bank, meta: { title: '税票银行与结算' } },
      { path: 'group-books', component: GroupBooks, meta: { title: '多主体与集团合并' } },
      { path: 'cockpit', component: Cockpit, meta: { title: '经营驾驶舱' } },
      { path: 'marketing', component: Marketing, meta: { title: '营销与素材' } },
      { path: 'organization', component: Organization, meta: { title: '组织编制与岗位' } },
      { path: 'tax', component: Tax, meta: { title: '税负测算' } },
      { path: 'sales', component: Sales, meta: { title: '销售与客户' } },
      { path: 'supply', component: Supply, meta: { title: '供给批次与预订' } },
      { path: 'notify', component: Notify, meta: { title: '客户营销与消息' } },
      { path: 'wh-plan', component: WhPlan, meta: { title: '美仓作业计划' } },
      { path: 'schedule', component: Schedule, meta: { title: '有限产能排程' } },
      { path: 'spot-ops', component: SpotOps, meta: { title: '现货经营与备货' } },
      { path: 'segments', component: Segments, meta: { title: '分公司经营对比' } },
      { path: 'material-flow', component: MaterialFlow, meta: { title: '备料领退与盘点' } },
      { path: 'pricing', component: Pricing, meta: { title: '价格快照与费用池' } },
      { path: 'investment', component: Investment, meta: { title: '长期投资抵消' } },
      { path: 'cut-dispatch', component: CutDispatch, meta: { title: '裁片外发' } },
      { path: 'dev-master', component: DevMaster, meta: { title: '研发立项与 SKU 配码' } },
      { path: 'sup-review', component: SupReview, meta: { title: '供方协同与技术复审' } },
      { path: 'import-data', component: ImportData, meta: { title: '真实数据导入' } },
      { path: 'access-review', component: AccessReview, meta: { title: '权限复核' } },
      { path: 'backup', component: Backup, meta: { title: '备份与恢复' } },
      { path: 'mail', component: Mail, meta: { title: '内部邮件' } },
      { path: 'materials', component: Materials, meta: { title: '面辅料档案' } },
      { path: 'materials/new', component: MaterialEdit, meta: { title: '新增物料档案' } },
      { path: 'materials/:id', component: MaterialEdit, meta: { title: '编辑物料档案' } },
      { path: 'suppliers', component: Suppliers, meta: { title: '供应商档案' } },
      { path: 'craft-types', component: CraftTypes, meta: { title: '工序类别' } },
      { path: 'production', component: Production, meta: { title: '生产管理' } },
      { path: 'quality', component: Quality, meta: { title: '质量与合规' } },
      { path: 'factories', component: Factories, meta: { title: '工厂管理' } },
      { path: 'outsource-recon', component: OutsourceRecon, meta: { title: '外协对账' } },
      { path: 'inventory', component: Inventory, meta: { title: '库存管理' } },
      { path: 'purchases', component: Purchases, meta: { title: '采购管理' } },
      { path: 'us-ship', component: UsShip, meta: { title: '美仓发货' } },
      { path: 'reports', component: Reports, meta: { title: '报表中心' } },
      { path: 'blueprint', component: Blueprint, meta: { title: '业务蓝图' } },
      { path: 'settings', component: Settings, meta: { title: '系统设置' } },
      { path: 'users', component: Users, meta: { title: '用户与角色' } }
    ]
  },
  { path: '/print/batch', component: PrintBatch, meta: { title: '批量打印' } },
  // 扫码直达：手机扫工单二维码 → 打开这个页面（独立布局，不套侧栏）
  { path: '/s/:code', component: ScanGo, meta: { title: '扫码结果' } },
  // 移动端工作台与扫码报工
  { path: '/m', component: MobileHome, meta: { title: '移动工作台' } },
  { path: '/m/report', component: MobileReport, meta: { title: '扫码报工' } },
  { path: '/m/photo', component: MobilePhoto, meta: { title: '拍照留证' } },
  // 桌面照片墙
  { path: '/photos', component: Photos, meta: { title: '现场照片' } },
  // 验货报告（独立 A4 排版，打印/另存 PDF）
  { path: '/inspection/:orderId', component: InspectionReport, meta: { title: '验货报告' } },
  { path: '/print/quote/:id', component: QuotePrint, meta: { title: '打印报价单' } },
  // 计件工资条 / 车间公示表（独立 A4 排版，打印后裁剪发放或贴墙）
  { path: '/payslip/:runId', component: Payslip, meta: { title: '计件工资条' } },
  // 客户对账单（对账函，A4 盖章用）
  { path: '/statement/:customerId', component: Statement, meta: { title: '客户对账单' } },
  { path: '/print/:type/:id', component: Print, meta: { title: '打印单据' } },
  { path: '/labels/:id', component: LabelPrint, meta: { title: '打印标签' } },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  // 带上 redirect：扫工单二维码时多半没登录，登录后要能回到那张单
  if (!auth.token) return { path: '/login', query: { redirect: to.fullPath } };
  // 首次进入同步一次生效权限（一人多岗 / 岗位复核收回都在服务端算）。
  // 失败不阻断导航 —— 退回 perm-table.js 兜底表，宁可多显示按钮也不要整页空白。
  if (!permState.loaded) {
    try {
      await syncPerms();
    } catch (e) { /* 兜底 */ }
  }
  return true;
});

export default router;
