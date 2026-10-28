import { syncPerms, permState } from './store/permissions';
import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './store/auth';

const Login = () => import('./views/Login.vue');
import ErpLayout from './layouts/ErpLayout.vue';
const Dashboard = () => import('./views/Dashboard.vue');
const Scan = () => import('./views/Scan.vue');
const Customers = () => import('./views/Customers.vue');
const Products = () => import('./views/Products.vue');
const Orders = () => import('./views/Orders.vue');
const Quotations = () => import('./views/Quotations.vue');
const Development = () => import('./views/Development.vue');
const Materials = () => import('./views/Materials.vue');
const MaterialEdit = () => import('./views/MaterialEdit.vue');
const Finance = () => import('./views/Finance.vue');
const Costing = () => import('./views/Costing.vue');
const Commitments = () => import('./views/Commitments.vue');
const Requirements = () => import('./views/Requirements.vue');
const Cuts = () => import('./views/Cuts.vue');
const FirstArticle = () => import('./views/FirstArticle.vue');
const Receipts = () => import('./views/Receipts.vue');
const Mail = () => import('./views/Mail.vue');
const SupplierEval = () => import('./views/SupplierEval.vue');
const PurchaseChanges = () => import('./views/PurchaseChanges.vue');
const ProductionClose = () => import('./views/ProductionClose.vue');
const Equipment = () => import('./views/Equipment.vue');
const Kpi = () => import('./views/Kpi.vue');
const AdminContracts = () => import('./views/AdminContracts.vue');
const Process = () => import('./views/Process.vue');
const DataQuality = () => import('./views/DataQuality.vue');
const OverseasWarehouse = () => import('./views/OverseasWarehouse.vue');
const FinanceBooks = () => import('./views/FinanceBooks.vue');
const SpotAnalysis = () => import('./views/SpotAnalysis.vue');
const AiCenter = () => import('./views/AiCenter.vue');
const Budget = () => import('./views/Budget.vue');
const Bank = () => import('./views/Bank.vue');
const GroupBooks = () => import('./views/GroupBooks.vue');
const Cockpit = () => import('./views/Cockpit.vue');
const Marketing = () => import('./views/Marketing.vue');
const Organization = () => import('./views/Organization.vue');
const Tax = () => import('./views/Tax.vue');
const Sales = () => import('./views/Sales.vue');
const Supply = () => import('./views/Supply.vue');
const Notify = () => import('./views/Notify.vue');
const WhPlan = () => import('./views/WhPlan.vue');
const Schedule = () => import('./views/Schedule.vue');
const SpotOps = () => import('./views/SpotOps.vue');
const Segments = () => import('./views/Segments.vue');
const MaterialFlow = () => import('./views/MaterialFlow.vue');
const Pricing = () => import('./views/Pricing.vue');
const Investment = () => import('./views/Investment.vue');
const CutDispatch = () => import('./views/CutDispatch.vue');
const DevMaster = () => import('./views/DevMaster.vue');
const SupReview = () => import('./views/SupReview.vue');
const ImportData = () => import('./views/ImportData.vue');
const AccessReview = () => import('./views/AccessReview.vue');
const Backup = () => import('./views/Backup.vue');
const Suppliers = () => import('./views/Suppliers.vue');
const CraftTypes = () => import('./views/CraftTypes.vue');
const PatternBoard = () => import('./views/PatternBoard.vue');
const SampleArchive = () => import('./views/SampleArchive.vue');
const Production = () => import('./views/Production.vue');
const Factories = () => import('./views/Factories.vue');
const OutsourceRecon = () => import('./views/OutsourceRecon.vue');
const Inventory = () => import('./views/Inventory.vue');
const Purchases = () => import('./views/Purchases.vue');
const UsShip = () => import('./views/UsShip.vue');
const Reports = () => import('./views/Reports.vue');
const Approvals = () => import('./views/Approvals.vue');
const Employees = () => import('./views/Employees.vue');
const Assistant = () => import('./views/Assistant.vue');
const Leaves = () => import('./views/Leaves.vue');
const Audit = () => import('./views/Audit.vue');
const ApprovalFlows = () => import('./views/ApprovalFlows.vue');
const Attendance = () => import('./views/Attendance.vue');
const Payrolls = () => import('./views/Payrolls.vue');
const Assets = () => import('./views/Assets.vue');
const AdminExpenses = () => import('./views/AdminExpenses.vue');
const Blueprint = () => import('./views/Blueprint.vue');
const Settings = () => import('./views/Settings.vue');
const Users = () => import('./views/Users.vue');
const Print = () => import('./views/Print.vue');
const Payslip = () => import('./views/Payslip.vue');
const Statement = () => import('./views/Statement.vue');
const Credit = () => import('./views/Credit.vue');
const Payable = () => import('./views/Payable.vue');
const Cashflow = () => import('./views/Cashflow.vue');
const PaymentRequests = () => import('./views/PaymentRequests.vue');
const Collections = () => import('./views/Collections.vue');
const Exceptions = () => import('./views/Exceptions.vue');
const ProdReport = () => import('./views/ProdReport.vue');
const FlowChanges = () => import('./views/FlowChanges.vue');
const Privacy = () => import('./views/Privacy.vue');
const Skills = () => import('./views/Skills.vue');
const SelfService = () => import('./views/SelfService.vue');
const CustomerProgress = () => import('./views/CustomerProgress.vue');
const AfterSales = () => import('./views/AfterSales.vue');
const OfficeSupply = () => import('./views/OfficeSupply.vue');
const Custody = () => import('./views/Custody.vue');
const AdminOps = () => import('./views/AdminOps.vue');
const PayrollCheck = () => import('./views/PayrollCheck.vue');
const PrintBatch = () => import('./views/PrintBatch.vue');
const ScanGo = () => import('./views/ScanGo.vue');
const MobileHome = () => import('./views/MobileHome.vue');
const MobileReport = () => import('./views/MobileReport.vue');
const MobilePhoto = () => import('./views/MobilePhoto.vue');
const Photos = () => import('./views/Photos.vue');
const InspectionReport = () => import('./views/InspectionReport.vue');
const BundleProgress = () => import('./views/BundleProgress.vue');
const PieceWage = () => import('./views/PieceWage.vue');
const QuotePrint = () => import('./views/QuotePrint.vue');
const MallAdmin = () => import('./views/MallAdmin.vue');
const Quality = () => import('./views/Quality.vue');
const Channel = () => import('./views/Channel.vue');
const ConfirmCenter = () => import('./views/ConfirmCenter.vue');
const Hr = () => import('./views/Hr.vue');
const Facility = () => import('./views/Facility.vue');
const Integration = () => import('./views/Integration.vue');
const MallLogin = () => import('./views/mall/MallLogin.vue');
const MallInvite = () => import('./views/mall/MallInvite.vue');
const Mall = () => import('./views/mall/Mall.vue');
const MallGuest = () => import('./views/mall/MallGuest.vue');
const LabelPrint = () => import('./views/LabelPrint.vue');

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
      { path: 'exceptions', component: Exceptions, meta: { title: '异常日清' } },
      { path: 'prod-report', component: ProdReport, meta: { title: '生产交付与质量' } },
      { path: 'flow-changes', component: FlowChanges, meta: { title: '流程变更与发布' } },
      { path: 'privacy', component: Privacy, meta: { title: '数据隐私与审计' } },
      { path: 'skills', component: Skills, meta: { title: '技能矩阵' } },
      { path: 'self', component: SelfService, meta: { title: '我的自助' } },
      { path: 'customer-progress', component: CustomerProgress, meta: { title: '客户进度发布' } },
      { path: 'after-sales', component: AfterSales, meta: { title: '售后与对账资料' } },
      { path: 'office-supply', component: OfficeSupply, meta: { title: '办公耗材与服务采购' } },
      { path: 'custody', component: Custody, meta: { title: '资产工衣与领归' } },
      { path: 'admin-ops', component: AdminOps, meta: { title: '行政运营报表' } },
      { path: 'payroll-check', component: PayrollCheck, meta: { title: '薪酬计件与工资核对' } },
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
      { path: 'credit', component: Credit, meta: { title: '客户信用与账期' } },
      { path: 'payable', component: Payable, meta: { title: '应付与付款计划' } },
      { path: 'cashflow', component: Cashflow, meta: { title: '资金计划' } },
      { path: 'payment-requests', component: PaymentRequests, meta: { title: '付款申请' } },
      { path: 'collections', component: Collections, meta: { title: '应收催收' } },
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
