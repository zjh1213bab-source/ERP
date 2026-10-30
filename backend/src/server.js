/**
 * 跳色科技公司 ERP 系统 —— 后端入口
 * Express + SQLite(better-sqlite3 / node:sqlite) + JWT
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const { db } = require('./db'); // 初始化数据库 + 建表 + 播种
const auditLog = require('./services/auditLog'); // 操作日志（哈希链 + 业务语义）

/**
 * 启动前的配置自检
 *
 * 生产环境（NODE_ENV=production）只要还有示例密钥 / 默认口令 / 通配 CORS，
 * 就直接拒绝启动 —— 这三样凑齐等于"后台对外开放，且谁都能自签管理员 token"。
 *
 * 开发环境不拦，但把清单打出来：让人在第一次 `npm start` 就看到自己正跑在默认值上，
 * 而不是等上线那天由别人发现。
 */
{
  const issues = config.securityAudit();
  const fatal = issues.filter((i) => i.level === 'fatal');
  if (fatal.length && config.isProd) {
    console.error('\n[启动中止] 生产环境配置不合规（拒绝在默认密钥/口令/CORS 下运行）：');
    fatal.forEach((i) => console.error(`  · ${i.msg}`));
    console.error('\n  改 backend/.env 后重启：');
    console.error('    JWT_SECRET=$(openssl rand -hex 32)');
    console.error('    ADMIN_PASSWORD=<新口令>');
    console.error('    CORS_ORIGIN=https://erp.example.com');
    console.error('    NODE_ENV=production\n');
    process.exit(1);
  }
  if (issues.length) {
    console.warn('\n[安全提示] 当前配置可直接开发，但**不要这样上线**：');
    issues.forEach((i) => console.warn(`  · ${i.msg}`));
    console.warn('');
  }
}

const authRoutes = require('./routes/auth');
const mindmapRoutes = require('./routes/mindmap'); // 业务蓝图（原脑图）
const customerRoutes = require('./routes/customers');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const techpackRoutes = require('./routes/techpacks');
const costRoutes = require('./routes/costs');
const sampleRoutes = require('./routes/samples');
const settingsRoutes = require('./routes/settings');
const materialRoutes = require('./routes/materials');
const supplierRoutes = require('./routes/suppliers');
const craftTypeRoutes = require('./routes/craftTypes');
const patternFlowRoutes = require('./routes/patternFlows');
const sampleArchiveRoutes = require('./routes/sampleArchives');
const craftRoutes = require('./routes/crafts');
const orderMaterialRoutes = require('./routes/orderMaterials');
const materialDevelopmentRoutes = require('./routes/materialDevelopment');
const preOrderRoutes = require('./routes/preOrders');
const sizeTemplateRoutes = require('./routes/sizeTemplates');
const orderNodeRoutes = require('./routes/orderNodes');
const nodeFlowRoutes = require('./routes/nodeFlow');
const productionBoardRoutes = require('./routes/productionBoard');
const stockRoutes = require('./routes/stock');
const statsRoutes = require('./routes/stats');
const adminRoutes = require('./routes/admin');
const factoryRoutes = require('./routes/factories');
const dispatchRoutes = require('./routes/dispatch');
const attachmentRoutes = require('./routes/attachments');
const approvalRoutes = require('./routes/approvals');
const employeeRoutes = require('./routes/employees');
const leaveRoutes = require('./routes/leaves');
const auditRoutes = require('./routes/audit');
const assistantRoutes = require('./routes/assistant');
const approvalFlowRoutes = require('./routes/approvalFlows');
const attendanceRoutes = require('./routes/attendance');
const aiRoutes = require('./routes/ai');
const purchaseRoutes = require('./routes/purchases');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/reports');
const uploadRoutes = require('./routes/upload');
const fileRoutes = require('./routes/files');   // 私有附件下载（鉴权 / 短期签名）
const importRoutes = require('./routes/imports');
const priceTierRoutes = require('./routes/priceTiers');
const quotationRoutes = require('./routes/quotations');
const pieceWageRoutes = require('./routes/pieceWage');   // 计件工资（扎级合格数 × 工序单价）
const statementRoutes = require('./routes/statements');   // 客户对账单（对账函）
const creditRoutes = require('./routes/credit');         // 客户信用与账期管控
const payableRoutes = require('./routes/payable');       // 应付台账与付款计划
const cashflowRoutes = require('./routes/cashflow');     // 资金计划（13 周现金流）
const paymentRequestRoutes = require('./routes/paymentRequests'); // 付款申请单（审批后出纳执行）
const collectionRoutes = require('./routes/collections');     // 应收催收任务
const exceptionRoutes = require('./routes/exceptions');      // 异常协同与日清（扫描各模块异常 → 今日必办）
const prodReportRoutes = require('./routes/prodReport');     // 生产交付效率与质量报表（八项指标 + 覆盖率）
const flowChangeRoutes = require('./routes/flowChanges');    // 流程变更发布与审计（版本化 + 试运行 + 回滚）
const privacyRoutes = require('./routes/privacy');           // 字段级脱敏与访问审计
const skillRoutes = require('./routes/skills');              // 技能矩阵与岗位资格（人×工序 + 受限工序门禁）
const selfRoutes = require('./routes/self');                 // 员工自助与薪资申诉（我的考勤/工资条/申请）
const custProgressRoutes = require('./routes/customerProgress'); // 客户进度发布（内部发布 → 客户只读快照）
const afterSaleRoutes = require('./routes/afterSales');       // 售后单（客户提 → 四条轨道 → 追偿 → 结案）
const statementFileRoutes = require('./routes/statementFiles');// 对账资料（快照 → 授权发布 → 客户下载）
const officeSupplyRoutes = require('./routes/officeSupply');    // 办公耗材与服务采购（独立办公仓 + 验收三合一）
const custodyRoutes = require('./routes/custody');              // 资产工衣与领归（东西在谁身上）
const adminOpsRoutes = require('./routes/adminOps');            // 行政运营报表（八项指标 + 差异复核）
const payrollCheckRoutes = require('./routes/payrollCheck');    // 薪酬计件与工资核对（计件来源 / 勾稽 / 差异调整）
const exportRoutes = require('./routes/exports');               // 数据导出与订阅（统一出口 / 水印 / 订阅投递）
const goLiveRoutes = require('./routes/goLive');               // 上线检查清单（自动体检 + 人工签认 + 签署冻结）
// 【暂停】坏账准备计提：后端已实现（services/badDebt.js + routes/badDebt.js），
// 财务模块暂缓上线，接口先不挂载（返回 404），代码与表结构、已生成的凭证全部保留。
// 恢复：解开下面一行 + 解开 services/gl.js 里 bad_debt 关账检查项。
// const badDebtRoutes = require('./routes/badDebt');           // 坏账准备计提（账龄法，过账到总账）
const payrollRoutes = require('./routes/payrolls');
const assetRoutes = require('./routes/assets');
const adminExpenseRoutes = require('./routes/adminExpenses');
const mallRoutes = require('./routes/mall'); // 客户商城（客户账号）
const mallAdminRoutes = require('./routes/mallAdmin'); // 客户商城后台
const qcRoutes = require('./routes/qc'); // 质量与合规
const channelRoutes = require('./routes/channel'); // 零售与渠道
const confirmRoutes = require('./routes/confirm'); // 客户订单与资料确认
const hrRoutes = require('./routes/hr'); // 人事办理（招聘/异动/合同/调薪）
const facilityRoutes = require('./routes/facility'); // 行政后勤（宿舍/饭卡/证照印章/巡检）
const integrationRoutes = require('./routes/integration');
const financeRoutes = require('./routes/finance');   // 往来账与资金核销
const costObjectRoutes = require('./routes/costObjects');   // 成本对象与已售毛利
const commitmentRoutes = require('./routes/commitments');   // 接单评审与交期承诺
const requirementRoutes = require('./routes/requirements');   // 齐套与缺料看板
const cutRoutes = require('./routes/cuts');   // 裁床排料与扎包
const firstArticleRoutes = require('./routes/firstArticles');   // 首件确认与工位工艺
const receiptRoutes = require('./routes/receipts');   // 生产原料收货与检验
const mailRoutes = require('./routes/mail');   // 内部邮件（站内）
const supplierEvalRoutes = require('./routes/supplierEvals');   // 供应商评价与备用产能
const purchaseChangeRoutes = require('./routes/purchaseChanges');   // 停单改量与供应商退料
const reworkCloseRoutes = require('./routes/reworkClose');   // 返工报废与生产结单
const equipmentRoutes = require('./routes/equipment');   // 设备停机与产能
const kpiRoutes = require('./routes/kpi');   // 岗位绩效与申诉
const adminContractRoutes = require('./routes/adminContracts');   // 行政合同与履约日历
const processRoutes = require('./routes/process');   // 流程超时升级与SOP
const dataQualityRoutes = require('./routes/dataQuality');   // 数据质量与业务勾稽
const warehouseRoutes = require('./routes/warehouse');   // 海外仓作业（到仓上架/套装/运费核对）
const glRoutes = require('./routes/glBooks');   // 总账与财务报表
const spotRoutes = require('./routes/spot');   // 现货库龄与退货
const aiCenterRoutes = require('./routes/aiCenter');   // AI 能力中心（网关/抽取/解释/风险/周报/评测）
const budgetRoutes = require('./routes/budget');   // 预算管理
const bankRoutes = require('./routes/bank');   // 税票银行与结算
const groupRoutes = require('./routes/group');   // 多主体核算与集团合并
const cockpitRoutes = require('./routes/cockpit');   // 经营驾驶舱（账龄/现金预测/指标）
const mktRoutes = require('./routes/mkt');   // 营销与素材（上新日历/素材授权/活动投放/复盘）
const orgRoutes = require('./routes/org');   // 组织编制与岗位管理（岗位编制/任职/交易路线/主体授权）
const taxRoutes = require('./routes/tax');   // 税负测算（税政配置/测算批次/申报底稿）
const crmRoutes = require('./routes/crm');   // 销售与客户（线索商机/周期预警/价值排行/目标提成/交接）
const supplyRoutes = require('./routes/supply');   // 供给批次与预订（可售口径/批次迁移/预订占用/缺口）
const notifyRoutes = require('./routes/notify');   // 客户营销与消息（上新提醒/订阅/发送回执/归因）
const whplanRoutes = require('./routes/whplan');   // 美仓作业计划（拣货波次/跨境头程/库容规划）
const scheduleRoutes = require('./routes/schedule');   // 有限产能排程（班次日历/工序定额/排程批次/冲突）
const spotopsRoutes = require('./routes/spotops');   // 现货经营总览 + 备货补货与停补提案
const segmentRoutes = require('./routes/segments');
const matflowRoutes = require('./routes/matflow');
const pricingRoutes = require('./routes/pricing');
const investmentRoutes = require('./routes/investment');
const cutdispatchRoutes = require('./routes/cutdispatch');
const devmasterRoutes = require('./routes/devmaster');
const supreviewRoutes = require('./routes/supreview');
const labelRoutes = require('./routes/labels');   // 扎标与扫码解析
const inspectionRoutes = require('./routes/inspection');   // 验货报告（对外文件，快照）
const photoRoutes = require('./routes/photos');   // 现场照片留证（手机拍照挂订单/工序）
const backupRoutes = require('./routes/backup');   // 备份中心（服务端备份/校验/恢复计划/回滚）
const accessRoutes = require('./routes/access');   // 岗位权限复核（权限矩阵/例外/职责分离/签字留痕）
const importOpsRoutes = require('./routes/importops');   // 上线准备：真实数据导入（预览/提交/批次留痕）   // 供方信息协同与技术再次审核（A1 分工 / A2 供方确认 / A3 复审）   // 研发立项与款式生命周期 + SKU 配码主档   // 裁片外发与外协验货交接（按扎追溯）   // 长期投资抵消（长投↔子公司权益/商誉/少数股东权益）   // 价格快照（价格本）+ 费用池分摊   // 备料领退与盘点差异（原料流水/领料/退料/盘点）   // 分公司经营对比（对外口径/环比/可比调整/报告快照）

const app = express();
app.disable('x-powered-by');
/**
 * 反向代理信任级别
 *
 * 不配这个，Nginx 反代后 `req.ip` 恒为 127.0.0.1 —— 登录限流会把全公司
 * 当成同一个人，额度一满所有人一起被锁（详见 config.trustProxy 的注释）。
 */
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '8mb' }));

// ---------- CORS ----------
const corsOrigin =
  config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim());
app.use(cors({ origin: corsOrigin, credentials: false }));

// ---------- 操作日志（写操作留痕） ----------
// 统一走 services/auditLog.append：算哈希链 + 翻译成业务语义（模块/动作/对象）。
// 记的是「谁在什么时候动了什么」，**不记 body** —— 里面有密码和金额，日志不该成为泄密源。
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    try {
      auditLog.append({
        username: req.auditUser || (req.user && req.user.username) || 'anonymous',
        role: req.auditRole || (req.user && req.user.role),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ip: req.ip || '',
        duration: Date.now() - startedAt
      });
    } catch (e) { /* 日志失败不能影响业务响应，但链会留下痕迹（水位与日志不一致） */ }
  });
  next();
});

// ---------- 访问日志 ----------
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()}  ${req.method} ${req.originalUrl}  ${res.statusCode}  ${Date.now() - start}ms`
    );
  });
  next();
});

// ---------- 基础 ----------
app.get('/api/health', (req, res) => {
  /**
   * 健康检查要能回答三件事：还活着 / 跑的哪套结构 / 配置能不能上线
   *
   * 只回 `ok: true` 的检查等于没检查 —— 结构残缺、密钥还是示例值时它也返回 200。
   * 这里把结构版本与规模一并带出，排障第一句"你那边多少张表"就有据可查。
   */
  let schema = null;
  let driver = null;
  try {
    const mod = require('./db');
    schema = mod.schemaInfo();
    driver = mod.driver;
  } catch (e) { /* 结构自检失败不影响存活探针，schema 留空 */ }
  res.json({
    ok: true,
    service: 'erp-system',
    uptime: process.uptime(),
    driver,
    schema,
    /** 生产配置是否已换成真密钥/真口令/指定 CORS（false 时不要对外发布） */
    config_ok: config.fatalIssues().length === 0
  });
});

// ---------- 业务路由 ----------
app.use('/api/auth', authRoutes);
app.use('/api/mindmap', mindmapRoutes); // 业务蓝图
app.use('/api/blueprint', mindmapRoutes); // 别名
app.use('/api/customers', customerRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/techpacks', techpackRoutes);
app.use('/api/costs', costRoutes);
app.use('/api/samples', sampleRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/craft-types', craftTypeRoutes);
app.use('/api/pattern-flows', patternFlowRoutes);
app.use('/api/sample-archives', sampleArchiveRoutes);
app.use('/api/crafts', craftRoutes);
app.use('/api/order-materials', orderMaterialRoutes);
app.use('/api/material-development', materialDevelopmentRoutes);
app.use('/api/pre-orders', preOrderRoutes);
app.use('/api/size-templates', sizeTemplateRoutes);
app.use('/api/order-nodes', orderNodeRoutes);
app.use('/api/node-flow', nodeFlowRoutes);   // 工序流程模板：节点可自定义
app.use('/api/production', productionBoardRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/factories', factoryRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/approval-flows', approvalFlowRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/files', fileRoutes);   // 私有附件下载：登录态或带过期签名
app.use('/api/import', importRoutes); // CSV 批量导入
app.use('/api/price-tiers', priceTierRoutes); // 阶梯报价
app.use('/api/quotations', quotationRoutes); // 报价单
app.use('/api/piece-wage', pieceWageRoutes); // 计件工资
app.use('/api/statements', statementRoutes); // 客户对账单（对账函）
app.use('/api/credit', creditRoutes); // 客户信用与账期管控（发货闸门）
app.use('/api/payable', payableRoutes); // 应付台账与付款计划
app.use('/api/cashflow', cashflowRoutes); // 资金计划（13 周现金流）
app.use('/api/payment-requests', paymentRequestRoutes); // 付款申请单（审批 → 出纳执行付款）
app.use('/api/collections', collectionRoutes); // 应收催收任务（逾期 → 派单 → 跟进 → 承诺 → 回款自动结案）
app.use('/api/exceptions', exceptionRoutes); // 异常协同与日清（六类归口 → 今日必办 → 认领/关闭/复核）
app.use('/api/prod-report', prodReportRoutes); // 生产交付效率与质量报表（准交/效率/质量/在制龄/计划偏差）
app.use('/api/flow-changes', flowChangeRoutes); // 流程变更发布与审计（草稿→试运行→发布→回滚）
app.use('/api/privacy', privacyRoutes); // 字段级脱敏与访问审计（服务端掩码 + 一次性查看 + 留痕）
app.use('/api/skills', skillRoutes); // 技能矩阵与岗位资格（评定→矩阵→受限工序门禁→到期提醒）
app.use('/api/self', selfRoutes); // 员工自助（账号绑定→我的考勤/工资条→申请→薪资申诉→调整单）
app.use('/api/customer-progress', custProgressRoutes); // 客户进度发布（三条路线 → 发布快照 → 撤回留版本）
app.use('/api/after-sales', afterSaleRoutes); // 售后单（退款/实收/检验/再上架/追偿 五轨独立）
app.use('/api/statement-files', statementFileRoutes); // 对账资料（定版快照 → 授权 → 下载留痕）
app.use('/api/office-supply', officeSupplyRoutes); // 办公耗材与服务采购（申领→采购→验收→入库/转资产/入费用）
app.use('/api/custody', custodyRoutes);            // 资产工衣与领归（实物档案/领用/归还/清退/损坏复核）
app.use('/api/admin-ops', adminOpsRoutes);         // 行政运营报表（宿舍/费用/饭卡/资产/耗材/预算/工单）
app.use('/api/payroll-check', payrollCheckRoutes); // 薪酬计件与工资核对（重算勾稽 + 差异登记调整单）
app.use('/api/exports', exportRoutes);             // 数据导出与订阅（白名单数据集 / 水印 / 周期订阅）
app.use('/api/go-live', goLiveRoutes);             // 上线检查清单（数据/权限/备份/财务/运行/组织 六大块）
// 【暂停】app.use('/api/bad-debt', badDebtRoutes); // 坏账准备计提（按账龄差额补提/冲回，生成 6702/1231 凭证）
app.use('/api/payrolls', payrollRoutes); // 薪酬核算
app.use('/api/assets', assetRoutes); // 固定资产
app.use('/api/admin-expenses', adminExpenseRoutes); // 行政费用
app.use('/api/mall', mallRoutes); // 客户商城前台
app.use('/api/mall-admin', mallAdminRoutes); // 客户商城后台
app.use('/api/qc', qcRoutes); // 质量与合规
app.use('/api/channel', channelRoutes); // 零售与渠道
app.use('/api/confirm', confirmRoutes); // 客户订单与资料确认
app.use('/api/hr', hrRoutes); // 人事办理
app.use('/api/facility', facilityRoutes); // 行政后勤
app.use('/api/integration', integrationRoutes);
app.use('/api/finance', financeRoutes);   // 往来账与资金核销
app.use('/api/costing', costObjectRoutes);   // 成本对象与已售毛利
app.use('/api/commitments', commitmentRoutes);   // 接单评审与交期承诺
app.use('/api/requirements', requirementRoutes);   // 齐套与缺料看板
app.use('/api/cuts', cutRoutes);   // 裁床排料与扎包
app.use('/api/first-articles', firstArticleRoutes);   // 首件确认与工位工艺
app.use('/api/receipts', receiptRoutes);   // 生产原料收货与检验
app.use('/api/mail', mailRoutes);   // 内部邮件（站内）
app.use('/api/supplier-evals', supplierEvalRoutes);   // 供应商评价与备用产能
app.use('/api/purchase-changes', purchaseChangeRoutes);   // 停单改量与供应商退料
app.use('/api/reworks', reworkCloseRoutes.reworks);   // 返工报废
app.use('/api/production-close', reworkCloseRoutes.close);   // 生产结单
app.use('/api/equipment', equipmentRoutes);   // 设备停机与产能
app.use('/api/kpi', kpiRoutes);   // 岗位绩效与申诉
app.use('/api/admin-contracts', adminContractRoutes);   // 行政合同与履约日历
app.use('/api/process', processRoutes);   // 流程超时升级与SOP
app.use('/api/dq', dataQualityRoutes);   // 数据质量与业务勾稽
app.use('/api/wh', warehouseRoutes);   // 海外仓作业
app.use('/api/gl', glRoutes);   // 总账与财务报表
app.use('/api/spot', spotRoutes);   // 现货库龄与退货
app.use('/api/ai', aiCenterRoutes);   // AI 能力中心
app.use('/api/budget', budgetRoutes);   // 预算管理
app.use('/api/bank', bankRoutes);   // 税票银行与结算
app.use('/api/group', groupRoutes);   // 多主体核算与集团合并
app.use('/api/cockpit', cockpitRoutes);   // 经营驾驶舱
app.use('/api/mkt', mktRoutes);   // 营销与素材
app.use('/api/org', orgRoutes);   // 组织编制与岗位管理
app.use('/api/tax', taxRoutes);   // 税负测算
app.use('/api/crm', crmRoutes);   // 销售与客户
app.use('/api/supply', supplyRoutes);   // 供给批次与预订
app.use('/api/notify', notifyRoutes);   // 客户营销与消息
app.use('/api/whplan', whplanRoutes);   // 美仓作业计划
app.use('/api/schedule', scheduleRoutes);   // 有限产能排程
app.use('/api/spotops', spotopsRoutes);   // 现货经营总览 + 备货补货停补提案
app.use('/api/segments', segmentRoutes);
app.use('/api/matflow', matflowRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/investment', investmentRoutes);
app.use('/api/cutdispatch', cutdispatchRoutes);
app.use('/api/devmaster', devmasterRoutes);
app.use('/api/supreview', supreviewRoutes);
app.use('/api/labels', labelRoutes);   // 扎标
app.use('/api/inspection', inspectionRoutes);   // 验货报告
app.use('/api/photos', photoRoutes);   // 现场照片
app.use('/api/backup', backupRoutes);   // 备份与恢复
app.use('/api/access', accessRoutes);   // 岗位权限复核
app.use('/api/importops', importOpsRoutes);   // 真实数据导入   // 供方信息协同与技术再次审核   // 研发立项 + SKU 配码主档   // 裁片外发与外协验货交接   // 长期投资抵消   // 价格快照 + 费用池分摊   // 备料领退与盘点差异   // 分公司经营对比

/**
 * 上传文件静态访问（v1.68 再收紧：公开区只放图片）
 *
 * 原来这里就是一行 `app.use('/uploads', express.static(UPLOAD_DIR))`：**整个目录公开、
 * 无需登录、不限制类型**。配合"上传时允许未知类型并按文件名猜扩展名"，
 * 就等于给了一个**同源任意 HTML 托管**：传一个 `evil.html`，
 * 在 ERP 主域下打开就能读 localStorage 里的 token、以当前用户身份调接口。
 *
 * 现在四道：
 *   1. **`private/` 一律 404** —— 私有附件（PDF / Office / zip / txt）就存在这里，
 *      唯一入口是 `/api/files/att/:name`（登录 + 归属校验，或短期签名）。
 *      不挡这一条的话，"签名下载"只是个装饰：文件仍在公网上；
 *   2. **扩展名白名单（只剩图片）** —— 公开区就是放图片的（款图 / 色卡 / 现场照片），
 *      其余类型连 404 都拿不到；
 *   3. **`X-Content-Type-Options: nosniff`** —— 浏览器不许"猜"类型；
 *   4. **`Content-Security-Policy: default-src 'none'; sandbox`** —— 就算真有文件
 *      被当成文档打开，脚本、外链、表单全部禁掉。
 *
 * 为什么不把图片也改成鉴权下载：款图、色卡在 `<img>` 里直接用 URL 引用（全站上百处），
 * 改成带 token 的链接要么全站改造、要么把 token 放进 URL（更糟）。
 * 图片不执行脚本，加 nosniff + CSP 之后风险边界是清楚的；**敏感的是附件，附件已经不在这里了**。
 */
const UPLOAD_SAFE = uploadRoutes.SAFE_EXTS;
const UPLOAD_INLINE = uploadRoutes.INLINE_EXTS;
app.use('/uploads', (req, res, next) => {
  const rel = String(req.path || '').replace(/^\/+/, '');
  if (rel.toLowerCase().startsWith('private/')) return res.status(404).end();
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (!UPLOAD_SAFE.has(ext)) return res.status(404).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (!UPLOAD_INLINE.has(ext)) res.setHeader('Content-Disposition', 'attachment');
  next();
}, express.static(uploadRoutes.UPLOAD_DIR, { index: false, dotfiles: 'deny', fallthrough: true }));

// ---------- 前端 dist 托管（单机部署 / 局域网预览） ----------
const distDir = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log('[erp] 检测到前端 dist，已启用静态托管');
}

// ---------- 接口 404 ----------
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, message: '接口不存在' });
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  // 4xx 是「用户填错了」，不是服务器故障，不往日志里刷栈
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ ok: false, message: err.message || '服务器内部错误' });
});

app.listen(config.port, () => {
  console.log('\n========================================');
  console.log('  跳色科技 ERP 系统 后端已启动');
  console.log(`  地址:     http://127.0.0.1:${config.port}`);
  console.log(`  健康检查: http://127.0.0.1:${config.port}/api/health`);
  console.log(`  管理员:   ${config.adminUsername}`);
  console.log('========================================\n');
});
