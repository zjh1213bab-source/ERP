/**
 * 权限矩阵 —— 单一来源
 *
 * 为什么放在后端：前端 `store/permissions.js` 只决定「按钮显不显示」，
 * 真正的门在后端 requireRole。两边各维护一份，迟早对不上（发生过：
 * 前端给了按钮、后端 403）。所以权限点表以本文件为准，前端通过
 * GET /api/access/permissions 拉取后覆盖本地兜底表。
 *
 * 三条约定：
 *   1. admin 恒通过（requireRole 内直接放行），不在表里出现
 *   2. 未定义的权限点一律拒绝（can() 返回 false）
 *   3. 岗位变化只改这里 + 对应路由的 requireRole 常量，不要两边各改一半
 *
 * 角色口径（2026-10-28 按真实岗位复核后）：
 *   admin      系统管理员（IT，兼最高权限）
 *   boss       总经理 / 老板：全业务只读 + 关键审批，不碰具体业务录入
 *   sales      销售 / 跟单：接单、报价、客户、开发单发起
 *   tech       技术 / 打版：开发单、工艺、面辅料、技术确认
 *   production 生产 / 车间：工序、报工、首件、设备、排程、裁片外发
 *   warehouse  仓库 / 采购：库存、收发、盘点、备料、美仓、采购与供方
 *   finance    财务：成本审核、往来、总账、税票、预算、合并、定价池
 *   hr         人事行政：员工档案、考勤、请假审批、薪酬、绩效、用印、后勤
 */

const ROLES = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];

const ROLE_LABELS = {
  admin: '系统管理员',
  boss: '总经理',
  sales: '销售跟单',
  tech: '技术打版',
  production: '生产车间',
  warehouse: '仓库采购',
  finance: '财务会计',
  hr: '人事行政'
};

/** 每个角色「本岗位该有」的权限点。boss 单独处理（只读，无写权限点） */
const PERMS = {
  // ===== 订单 =====
  'order.create': ['sales'],
  'order.export': ['sales', 'finance'],
  'order.dispatch': ['sales', 'production'],
  'order.instock': ['warehouse', 'production'],
  'order.ship': ['warehouse'],

  // ===== 质量与合规 =====
  // 复核收回 sales：销售不能自己判定「质量合格」，否则客诉前无法发现
  'qc.write': ['production', 'tech'],
  // 现场照片：谁在生产/收货/装箱现场谁拍，财务与人事不产生现场照片
  'photo.write': ['production', 'warehouse', 'tech', 'sales'],
  // 验货报告是对外文件（带客户信息与不良照片），人事/仓库不出这份东西
  'inspection.write': ['sales', 'production', 'tech', 'finance'],
  'production.write': ['production', 'tech'],        // 返工报废与生产结单
  'equipment.write': ['production', 'warehouse'],    // 设备停机与产能

  // ===== 客户订单与资料确认（样衣/变更/交期）=====
  'confirm.write': ['sales', 'tech', 'production'],

  // ===== 零售与渠道 =====
  'channel.write': ['sales', 'finance'],

  // ===== 客户商城 =====
  'mall.write': ['sales'],

  // ===== 报价单 =====
  'quote.write': ['sales'],
  'quote.convert': ['sales'],

  // ===== 开发单 =====
  'development.write': ['tech', 'sales'],
  'development.review': ['tech'],

  // ===== 财务 =====
  'cost.write': ['finance', 'sales'],
  'cost.review': ['finance'],

  // ===== 工艺 / 面辅料 / 工序 / 报工 =====
  // 复核收回 sales：工艺与报工是现场事实，销售改了就没人能核对
  'craft.write': ['tech'],
  'material.write': ['tech', 'finance'],
  'node.write': ['production'],
  'report.write': ['production'],

  // ===== 首件确认与工位工艺 =====
  // 复核收回 sales：首件是质量放行依据
  'fa.write': ['production', 'tech'],
  'fa.release': ['production', 'tech'],
  'fa.workstation': ['tech', 'production'],

  // ===== 内部邮件（所有在岗员工都能收发，不设审批）=====
  'mail.write': ['sales', 'tech', 'finance', 'production', 'warehouse', 'hr'],

  // ===== 主数据 =====
  'customer.write': ['sales'],
  'product.write': ['sales', 'tech'],
  'factory.write': ['production', 'sales'],

  // ===== 仓储 =====
  // 复核收回 sales：库存与采购是仓库/采购职责，销售只能查
  'stock.write': ['warehouse', 'production'],
  'purchase.write': ['warehouse'],
  'supplier.write': ['warehouse'],
  'receipt.write': ['warehouse', 'production'],

  // ===== 人事 / 行政 =====
  'employee.write': ['hr'],
  'hr.write': ['hr'],
  'facility.write': ['hr', 'warehouse'],
  'integration.write': ['hr'],
  // 自助提交（本人请假），所有在岗员工都有；审批另设 leave.review
  'leave.write': ['sales', 'tech', 'finance', 'production', 'warehouse', 'hr'],
  'leave.review': ['hr', 'production', 'sales'],     // 人事 + 部门负责人
  'payroll.write': ['hr', 'finance'],
  // 计件工资：制单（单价维护、生成核算草案）人事/财务；确认与作废只给财务 ——
  // 自己算的钱自己确认等于没审，工钱是最不该让同一个人闭环的地方
  'piecewage.write': ['hr', 'finance'],
  'piecewage.approve': ['finance'],
  'kpi.write': ['hr'],
  'kpi.review': ['hr', 'sales', 'production'],
  'admincontract.write': ['hr'],
  'asset.write': ['hr', 'finance'],
  'expense.write': ['hr', 'finance'],

  // ===== 数据质量与业务勾稽 =====
  'dq.write': ['finance'],

  // ===== 海外仓作业 =====
  'wh.write': ['warehouse', 'sales'],

  // ===== 总账与财务报表 =====
  'gl.write': ['finance'],

  // ===== 现货库龄与退货 =====
  'spot.write': ['warehouse', 'sales'],

  // ===== AI 能力中心 =====
  'ai.write': ['sales', 'tech', 'finance', 'production', 'warehouse', 'hr'],

  // ===== 预算管理 =====
  'budget.write': ['finance', 'sales'],

  // ===== 税票银行 =====
  'bank.write': ['finance'],

  // ===== 多主体与合并 =====
  'group.write': ['finance'],

  // ===== 经营驾驶舱 =====
  'cockpit.write': ['finance'],

  // ===== 营销与素材 =====
  'mkt.write': ['sales', 'tech'],
  'mkt.review': ['finance'],

  // ===== 组织编制与岗位 =====
  'org.write': ['hr'],
  'org.approve': ['finance'],

  // ===== 税负测算 =====
  'tax.write': ['finance'],

  // ===== 销售与客户 =====
  'crm.write': ['sales'],
  'crm.approve': ['finance'],

  // ===== 供给批次与预订 =====
  'supply.write': ['sales', 'warehouse'],
  'supply.confirm': ['sales'],

  // ===== 打版流程 =====
  'pattern.material': ['tech'],
  'pattern.pattern': ['tech'],
  'pattern.craft': ['tech'],
  'pattern.sample': ['tech', 'production'],
  'pattern.biz': ['sales'],
  'pattern.audit': ['finance', 'production'],
  'pattern.review': ['tech'],

  // ===== 管理 =====
  'settings.write': ['admin'],
  'user.manage': ['admin'],
  // 客户信用与账期：看的范围要跟业务一致（销售得知道自己客户的额度），
  // 但**改额度、冻结、放行只有财务和管理员** —— 授信是钱的事，销售不能自己批给自己
  // 应付：只给财务和老板看（欠谁钱、什么时候付，是敏感的资金信息）
  // 资金计划：期初现金、断点周、缺口 —— 只有财务和老板看
  // 付款申请：看单的人多一些（出纳要执行），但**批**走审批流的角色校验，
  // **付**只给能碰钱的手（admin/finance/warehouse 里的出纳岗）
  // 催收：销售要看自己名下的单（不然不知道催谁），财务/老板看全部；
  // 结案（尤其核销坏账）会影响应收质量口径，只给财务
  // 坏账准备影响利润表与资产总额，只给财务/老板看；改比例、过账只给财务
  // 【暂停】接口未挂载（server.js 已注释），权限点先留着，恢复时无需再改这里
  'baddebt.read': ['admin', 'boss', 'finance'],
  'baddebt.write': ['admin', 'finance'],
  'collection.read': ['admin', 'boss', 'finance', 'sales'],
  'collection.write': ['admin', 'finance', 'sales'],
  'collection.close': ['admin', 'finance'],

  // 异常协同与日清：异常是所有部门共用的账，所以**全员可读**（看不到就没人处理）；
  // 认领与关闭给实际干活的岗位（老板只读，老板不该去关异常单）；
  // 复核给主管与老板（复核人不能是处理人，服务层另有校验）；
  // 改规则阈值只给管理员 —— 改错了会让全公司少提醒或多提醒，属于治理动作。
  'exception.read': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'exception.write': ['admin', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'exception.review': ['admin', 'boss'],
  'exception.rule': ['admin'],

  // 生产交付效率与质量报表：只读、不改数据、不产生排名扣薪依据。
  // 给生产（自己看）、技术（看制版时长）、销售（看准交）、财务（成本会计看效率）、老板。
  // 仓库与人事不看：他们不背交付与质量指标。
  'prodreport.read': ['admin', 'boss', 'production', 'finance', 'tech', 'sales'],

  // 流程变更：改审批流等于改制度，只给管理员；老板只读（能看谁在什么时候改了哪条流程）
  'flowchange.read': ['admin', 'boss'],
  'flowchange.write': ['admin'],

  // ===== 技能矩阵与岗位资格（TS-N13-06）=====
  // read：人事/生产/技术要排产，老板要盘家底。销售、仓库、财务不需要知道谁能车缝。
  // write：评定与培训登记。生产主管能评自己线上的人 —— 车间里谁行谁不行，主管最清楚。
  // rule：改「受限工序」开关会直接决定车间能不能开工，只给人事与管理员。
  'skill.read': ['admin', 'boss', 'hr', 'production', 'tech'],
  'skill.write': ['admin', 'hr', 'production'],
  'skill.rule': ['admin', 'hr'],

  // ===== 员工自助（TS-N13-10）=====
  // 自助是「人人都有」的权限，但**范围由服务端的绑定关系卡死**：只能看自己。
  // 给所有角色 read/submit 不等于给了看别人的能力 —— 越权在服务层按 employee_id 拦。
  'self.read': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'self.submit': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  // 受理申请：人事（补卡/请假/资料）与财务（薪资申诉）都要能处理
  'self.manage': ['admin', 'hr', 'finance'],
  // 绑定账号 ↔ 员工：绑错了就是「看到别人的工资」，只给人事与管理员
  'self.bind': ['admin', 'hr'],

  // ===== 客户进度发布（TS-N22-02/03）=====
  // read：销售/技术/生产/老板都要能看「客户会看到什么」
  // publish：对外说话的是业务，只给销售与管理员
  // route：改路线会让客户看到的阶段变多或变少，跟单与生产最清楚
  'custprogress.read': ['admin', 'boss', 'sales', 'tech', 'production'],
  'custprogress.publish': ['admin', 'sales'],
  'custprogress.route': ['admin', 'sales', 'production'],

  // ===== 售后与对账资料（TS-N22-08）=====
  // 受理会生成退货单、会改客户可见状态；退款是真把钱退出去 —— 拆成两层。
  // 仓库要能看（要点收、要判定），但不需要能受理；财务要能退款，但不需要能改主责。
  'aftersale.read': ['admin', 'boss', 'sales', 'quality', 'production', 'warehouse', 'finance'],
  'aftersale.write': ['admin', 'sales', 'quality', 'production', 'warehouse'],
  'aftersale.refund': ['admin', 'finance'],
  // 对账文件：销售能看能生成，但**「发出去」是我们的账，只给财务与管理员**
  'statementfile.read': ['admin', 'boss', 'finance', 'sales'],

  // ===== 办公耗材与服务采购（TS-N14-07）=====
  // 看：申领是每个人的事，全角色可读
  // 申领与领用：老板只读（出库是操作动作，不该由老板点）
  // 采购与档案：会花钱、会改全厂口径，只给行政/财务/管理员
  'office.read': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'office.apply': ['admin', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'office.manage': ['admin', 'hr', 'finance'],
  'statementfile.publish': ['admin', 'finance'],

  // ===== 资产工衣与领归（TS-N14-03）=====
  // 看：每个人都要能看自己身上挂着什么（工衣、钥匙、工具），全角色可读。
  // 发放与回收：东西在行政仓，发料/收料是行政、人事与仓库的动作；老板只读。
  // 档案与处置：改档案会改全厂口径，处置等于东西消失 —— 只给行政与人事。
  // 定责：行政/人事先出结论，**财务确认金额单独一层**（`custody.finance`），
  //       否则人事自己就能把赔偿金额「确认」进系统，等于自己收钱自己签字。
  'custody.read': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'custody.issue': ['admin', 'hr', 'warehouse'],
  'custody.manage': ['admin', 'hr'],
  'custody.claim': ['admin', 'hr', 'finance'],
  'custody.finance': ['admin', 'finance'],

  // ===== 行政运营报表（TS-N14-09）=====
  // 看汇总：宿舍入住率、费用、饭卡余额这类合计，全员可见（本来就是行政月度通报的内容）。
  // 看明细：**「谁住哪张床、谁饭卡还剩多少」不是全员可见**，只给人事/财务/管理员。
  // 定版：定版后就是对外口径（含快照），与复核关闭同属人事/财务的活。
  'adminops.read': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'adminops.detail': ['admin', 'hr', 'finance'],
  'adminops.run': ['admin', 'hr', 'finance'],
  'adminops.review': ['admin', 'hr', 'finance'],

  // ===== 薪酬计件与工资核对（TS-N13-05）=====
  // 工资数据连「看」都限岗（与 /api/payrolls 同一口径）：老板可看，销售/生产/仓库不行。
  // 核对会重算个税社保、登记差异会生成下期调整单 —— 只给人事/财务/管理员。
  'paycheck.read': ['admin', 'boss', 'hr', 'finance'],
  'paycheck.run': ['admin', 'hr', 'finance'],
  'paycheck.fix': ['admin', 'hr', 'finance'],

  // ===== 数据导出与订阅（TS-N18-03 / TS-N18-09）=====
  // 导出是数据离开系统的最后一米：看清单全角色，真正导出执行要单独一点，
  // 建订阅（定期外发）与审计（看别人的导出记录、水印反查）再各自收窄。
  // 注意：数据集本身还有业务权限（工资要 paycheck.read），两层都要过。
  'export.read': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'export.run': ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'],
  'export.subscribe': ['admin', 'sales', 'finance', 'hr'],
  'export.audit': ['admin', 'hr', 'finance'],

  // ===== 上线检查清单（上线准备）=====
  // 看：上线清单里有财务口径、权限矩阵、备份路径这类信息，只给管理层与人事/财务。
  // 勾：推进上线的人（管理员/人事）负责验数据、跑体检、勾人工项。
  // 签：签署是「决定今天能不能上线」，只给老板与管理员 —— 勾和签分开，否则自己勾完自己签。
  'golive.read': ['admin', 'boss', 'hr', 'finance'],
  'golive.run': ['admin', 'hr'],
  'golive.sign': ['admin', 'boss'],

  // ===== 字段级明文权限（TS-N18-03）=====
  // 一条原则：**谁真的需要看，才给谁**。
  //   hr.pii 只给人事 —— 给销售一个通用 pii 权限，等于把员工身份证也给了销售。
  //   payroll.sensitive 只给财务与人事 —— **admin 不在里面**，这是原型的硬要求
  //   （「管理员技术权限不默认可读工资」）；脱敏层按「角色基础权限」判定，
  //   所以 admin 即便在 requireRole 里恒通过，也读不到工资明文，只能走一次性查看。
  'hr.pii': ['hr'],
  'crm.pii': ['sales', 'finance'],
  'supplier.pii': ['warehouse', 'finance'],
  'payroll.sensitive': ['finance', 'hr'],
  'bankaccount.sensitive': ['finance'],
  'contract.sensitive': ['finance', 'boss'],
  // 看脱敏规则与访问日志（日志是元数据，不是明文，所以 admin 可看）
  'privacy.read': ['admin', 'boss'],
  'privacy.admin': ['admin'],
  'paymentreq.read': ['admin', 'boss', 'finance', 'warehouse'],
  'paymentreq.write': ['admin', 'finance', 'warehouse'],
  'paymentreq.pay': ['admin', 'finance', 'warehouse'],
  'cashflow.read': ['admin', 'boss', 'finance'],
  'payable.read': ['admin', 'boss', 'finance'],
  'payable.write': ['admin', 'finance'],
  'credit.read': ['admin', 'boss', 'finance', 'sales'],
  'credit.write': ['admin', 'finance'],
  'audit.read': ['admin', 'boss'],   // 老板要看操作日志（只读，写操作仍只有 admin）
  'audit.archive': ['admin'],       // 归档会移出主表，是破坏性动作，只给管理员
  'approvalflow.manage': ['admin'],
  'process.write': ['hr'],
  'process.review': ['hr', 'finance', 'production'],

  // ===== 客户营销与消息 =====
  'notify.write': ['sales'],
  'notify.approve': ['finance'],

  // ===== 美仓作业 =====
  'whplan.write': ['warehouse', 'sales'],
  'whplan.ship': ['warehouse'],

  // ===== 有限产能排程 =====
  'schedule.write': ['production'],
  'schedule.publish': ['production'],

  // ===== 现货经营 =====
  'spotops.write': ['sales', 'warehouse'],
  'spotops.policy': ['sales'],

  // ===== 分公司经营对比 =====
  'segment.write': ['finance'],

  // ===== 备料领退 =====
  'matflow.write': ['warehouse', 'production'],
  'matflow.adjust': ['warehouse'],

  // ===== 价格快照与费用池 =====
  'pricing.pool': ['finance'],
  'pricing.book': ['finance', 'sales'],

  // ===== 长期投资 =====
  'investment.write': ['finance'],

  // ===== 裁片外发 =====
  'cutdispatch.write': ['production', 'warehouse'],

  // ===== 研发立项 =====
  'devmaster.write': ['tech'],
  'devmaster.milestone': ['tech', 'sales'],

  // ===== 供方协同与技术复审 =====
  'supreview.write': ['tech'],

  // ===== 真实数据导入 =====
  'importops.commit': ['finance']
};

/**
 * 高危权限点 → 后端路由映射
 *
 * 只登记「改钱、改库存、改人事、改权限」的动作。作用是让「用户级收回」
 * 在后端也真的生效（否则前端藏了按钮，直接调接口还能过）。
 *
 * 没登记的权限点，用户级收回只在前端生效 —— 这是有意的：
 * 全量映射一旦配错会误拦线上业务，风险比收益大。
 *
 * 字段：method（* 表全部）、prefix（命中即算）、perm
 */
const GUARDED = [
  { perm: 'payroll.write', method: '*', prefix: '/api/payrolls' },
  { perm: 'employee.write', method: '*', prefix: '/api/employees' },
  { perm: 'hr.write', method: '*', prefix: '/api/hr' },
  { perm: 'admincontract.write', method: '*', prefix: '/api/admin-contracts' },
  { perm: 'asset.write', method: '*', prefix: '/api/assets' },
  { perm: 'expense.write', method: '*', prefix: '/api/admin-expenses' },
  { perm: 'facility.write', method: '*', prefix: '/api/facility' },
  { perm: 'integration.write', method: '*', prefix: '/api/integration' },
  { perm: 'org.write', method: '*', prefix: '/api/org' },
  { perm: 'cost.review', method: '*', prefix: '/api/costs' },
  { perm: 'gl.write', method: '*', prefix: '/api/gl' },
  { perm: 'bank.write', method: '*', prefix: '/api/bank' },
  // 执行付款是真正把钱搬出去的动作，必须挂高危路由（前端按钮 + 后端 403 双保险）
  { perm: 'baddebt.write', method: 'POST', prefix: '/api/bad-debt' },
  { perm: 'baddebt.write', method: 'PUT', prefix: '/api/bad-debt' },
  { perm: 'collection.close', method: 'POST', prefix: '/api/collections' },
  { perm: 'collection.write', method: 'POST', prefix: '/api/collections' },
  // 复核结论会决定一条异常算不算真的解决，属于治理动作
  { perm: 'exception.review', method: 'POST', prefix: '/api/exceptions' },
  { perm: 'exception.rule', method: 'PUT', prefix: '/api/exceptions' },
  { perm: 'paymentreq.pay', method: 'POST', prefix: '/api/payment-requests' },
  { perm: 'paymentreq.write', method: 'POST', prefix: '/api/payment-requests' },
  { perm: 'paymentreq.write', method: 'PUT', prefix: '/api/payment-requests' },
  { perm: 'paymentreq.write', method: 'DELETE', prefix: '/api/payment-requests' },
  { perm: 'payable.write', method: 'PUT', prefix: '/api/payable' },
  // 技能：评级会决定谁能上机，改门槛会决定全厂能不能开工 —— 两层都拦
  { perm: 'skill.write', method: 'POST', prefix: '/api/skills' },
  { perm: 'skill.rule', method: 'PUT', prefix: '/api/skills' },
  // 自助：受理会让调整单进工资，绑定会把账号连到别人的档案上 —— 都属高危。
  // 注意受理路径单独用 /api/self/review：GUARDED 是前缀匹配，
  // 若沿用 /api/self/requests/:id/review，会把员工本人提交申请（POST /api/self/requests）一起拦掉。
  { perm: 'self.manage', method: 'POST', prefix: '/api/self/review' },
  { perm: 'self.bind', method: 'POST', prefix: '/api/self/bind' },
  { perm: 'self.bind', method: 'POST', prefix: '/api/self/unbind' },
  // 发布进度等于对外发声，撤回也要留痕 —— 都挂高危
  { perm: 'custprogress.publish', method: 'POST', prefix: '/api/customer-progress' },
  { perm: 'custprogress.route', method: 'PUT', prefix: '/api/customer-progress' },
  // 退款是真把钱退出去，单独一段路径以便精确挂锁（GUARDED 是前缀匹配，
  // 若写成 /api/after-sales 会把受理、结案一起锁成「只有财务能点」）
  { perm: 'aftersale.refund', method: 'POST', prefix: '/api/after-sales/refund' },
  // 对账文件一旦「授权发布」就等于我们对外承认这组数，不能销售自己拍板
  { perm: 'statementfile.publish', method: 'POST', prefix: '/api/statement-files' },
  // 办公采购会真的花钱（验收即生成费用并占预算），档案会决定全厂口径 —— 都挂高危
  { perm: 'office.manage', method: '*', prefix: '/api/office-supply/purchases' },
  { perm: 'office.manage', method: 'POST', prefix: '/api/office-supply/items' },
  // 实物档案会改全厂统计口径；处置等于东西消失；定责会被当成扣钱依据；财务确认是收钱的最后一道。
  // 四个动作各自独立成段：GUARDED 是前缀匹配，若写成 /api/custody 一整个前缀，
  // 连「看我身上有什么」都会被锁成只有行政能进。
  { perm: 'custody.manage', method: 'POST', prefix: '/api/custody/items' },
  { perm: 'custody.manage', method: 'POST', prefix: '/api/custody/scrap' },
  { perm: 'custody.manage', method: 'POST', prefix: '/api/custody/restore' },
  { perm: 'custody.claim', method: 'POST', prefix: '/api/custody/review' },
  { perm: 'custody.finance', method: 'POST', prefix: '/api/custody/finance' },
  // 报表定版会冻结口径，差异关闭会被当成「已处理」的依据 —— 都属高危
  { perm: 'adminops.run', method: 'POST', prefix: '/api/admin-ops/run' },
  { perm: 'adminops.review', method: 'POST', prefix: '/api/admin-ops/assign' },
  { perm: 'adminops.review', method: 'POST', prefix: '/api/admin-ops/review' },
  { perm: 'adminops.review', method: 'POST', prefix: '/api/admin-ops/close' },
  { perm: 'adminops.review', method: 'POST', prefix: '/api/admin-ops/ignore' },
  // 生成核对批次会冻结一版工资结论；登记差异会真的生成调整单（下期发钱）—— 都挂高危
  { perm: 'paycheck.run', method: 'POST', prefix: '/api/payroll-check/run' },
  { perm: 'paycheck.fix', method: 'POST', prefix: '/api/payroll-check/diff' },
  { perm: 'paycheck.fix', method: 'POST', prefix: '/api/payroll-check/annotate' },
  { perm: 'paycheck.fix', method: 'POST', prefix: '/api/payroll-check/review' },
  // 导出与订阅都是「数据外发」：导出留下带水印的文件、订阅会反复外发
  { perm: 'export.run', method: 'POST', prefix: '/api/exports/download' },
  { perm: 'export.subscribe', method: 'POST', prefix: '/api/exports/subs' },
  { perm: 'export.subscribe', method: 'POST', prefix: '/api/exports/run-due' },
  // 签署与撤回是高危：一个决定上线、一个推翻已签结论
  { perm: 'golive.sign', method: 'POST', prefix: '/api/go-live/sign' },
  { perm: 'golive.sign', method: 'POST', prefix: '/api/go-live/withdraw' },
  { perm: 'golive.run', method: 'POST', prefix: '/api/go-live/rounds' },
  { perm: 'golive.run', method: 'POST', prefix: '/api/go-live/refresh' },
  { perm: 'golive.run', method: 'POST', prefix: '/api/go-live/manual' },
  { perm: 'golive.run', method: 'POST', prefix: '/api/go-live/assign' },
  { perm: 'credit.write', method: 'PUT', prefix: '/api/credit' },
  { perm: 'credit.write', method: 'POST', prefix: '/api/credit' },
  { perm: 'budget.write', method: '*', prefix: '/api/budget' },
  { perm: 'group.write', method: '*', prefix: '/api/group' },
  { perm: 'tax.write', method: '*', prefix: '/api/tax' },
  { perm: 'investment.write', method: '*', prefix: '/api/investment' },
  { perm: 'cockpit.write', method: '*', prefix: '/api/cockpit' },
  { perm: 'segment.write', method: '*', prefix: '/api/segments' },
  { perm: 'pricing.pool', method: '*', prefix: '/api/pricing' },
  { perm: 'matflow.adjust', method: '*', prefix: '/api/matflow' },
  { perm: 'stock.write', method: '*', prefix: '/api/stock' },
  { perm: 'importops.commit', method: '*', prefix: '/api/importops' },
  { perm: 'dq.write', method: '*', prefix: '/api/dq' },
  { perm: 'user.manage', method: '*', prefix: '/api/users' },
  { perm: 'settings.write', method: '*', prefix: '/api/settings' },
  { perm: 'approvalflow.manage', method: '*', prefix: '/api/approval-flows' },
  { perm: 'audit.read', method: 'GET', prefix: '/api/audit' },
  { perm: 'audit.archive', method: 'POST', prefix: '/api/audit/archive' },
  { perm: 'schedule.publish', method: 'POST', prefix: '/api/schedule/publish' },
  // 对外数据外泄与主数据篡改，同样算高危
  { perm: 'order.export', method: 'GET', prefix: '/api/orders/export' },
  { perm: 'customer.write', method: '*', prefix: '/api/customers' },
  { perm: 'supplier.write', method: '*', prefix: '/api/supplier-evals' },
  { perm: 'qc.write', method: '*', prefix: '/api/qc' },
  // 照片是证据：只有写（拍照/删除）受管，读放给全体业务岗
  { perm: 'photo.write', method: 'POST', prefix: '/api/photos' },
  { perm: 'photo.write', method: 'DELETE', prefix: '/api/photos' },
  // 验货报告一旦发出去就是对客户的承诺，属于对外文件
  { perm: 'inspection.write', method: 'POST', prefix: '/api/inspection' },
  // 计件单价改动会重算所有人的工钱；确认/作废直接决定发多少钱
  { perm: 'piecewage.write', method: 'POST', prefix: '/api/piece-wage/rates' },
  { perm: 'piecewage.write', method: 'PUT', prefix: '/api/piece-wage/rates' },
  { perm: 'piecewage.approve', method: 'POST', prefix: '/api/piece-wage/runs/' }
];

/** 写方法（用于判断请求是否属于「写」） */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * 职责分离规则（SoD）
 *
 * 判据：同一个账号同时持有左右两个权限点 → 冲突。
 * 级别都是 warn：小企业常常一个人干两份，直接 block 会让系统不可用。
 * 正确做法是「识别 + 留痕 + 补偿性控制」（如由总经理每月抽查操作日志），
 * 报告里对每条冲突给出补偿建议。
 */
const SOD_RULES = [
  {
    code: 'SOD-01', level: 'warn',
    name: '下单与成本审核同一人',
    perm_a: 'order.create', perm_b: 'cost.review',
    note: '自己接单自己核成本，可能压低成本价冲业绩',
    compensate: '由财务主管每月抽查成本单与毛利异常订单'
  },
  {
    code: 'SOD-02', level: 'warn',
    name: '采购申请与收货点收同一人',
    perm_a: 'purchase.write', perm_b: 'receipt.write',
    note: '采购下单自己收，无法核实到货数量与质量',
    compensate: '由生产或财务对到货数量做二次抽盘'
  },
  {
    code: 'SOD-03', level: 'warn',
    name: '收货点收与质量判定同一人',
    perm_a: 'receipt.write', perm_b: 'qc.write',
    note: '自己点收自己判合格，来料不良会流入产线',
    compensate: '首件确认与巡检由技术或生产独立执行'
  },
  {
    code: 'SOD-04', level: 'warn',
    name: '发料与盘点落账同一人',
    perm_a: 'matflow.write', perm_b: 'matflow.adjust',
    note: '自己发料自己调账，可以把缺料做成「账上有」',
    compensate: '盘点表由第二人复核签字后再落账'
  },
  {
    code: 'SOD-05', level: 'warn',
    name: '定价发布与成本录入同一人',
    perm_a: 'pricing.book', perm_b: 'cost.write',
    note: '自己填成本自己发布价格，可人为做高/做低毛利',
    compensate: '价格发布走审批，成本单保留版本与修改人'
  },
  {
    code: 'SOD-06', level: 'warn',
    name: '银行结算与总账记账同一人',
    perm_a: 'bank.write', perm_b: 'gl.write',
    note: '既做付款又记账，可掩盖资金差异',
    compensate: '银行流水每月与总账做一次双向核对'
  },
  {
    code: 'SOD-07', level: 'warn',
    name: '排程生成与排程发布同一人',
    perm_a: 'schedule.write', perm_b: 'schedule.publish',
    note: '可绕过硬冲突确认直接把排程下发车间',
    compensate: '发布记录留痕，车间按发布版执行，改版必须重新发布'
  },
  {
    code: 'SOD-08', level: 'warn',
    name: '权限授予与日志审计同一人',
    perm_a: 'user.manage', perm_b: 'audit.read',
    note: '既能改权限又能改日志，事后无法追溯（admin 天然如此，需补偿）',
    compensate: '操作日志另存一份到外部存储，由总经理定期查阅'
  },
  {
    code: 'SOD-09', level: 'warn',
    name: '供方选择与供方评价同一人',
    perm_a: 'purchase.write', perm_b: 'supplier.write',
    note: '自己选供方自己打高分，评价失去约束力',
    compensate: '供方评价样本由系统按批次自动汇总，人工只做整改跟踪'
  },
  {
    code: 'SOD-10', level: 'warn',
    name: '薪酬核算与总账记账同一人',
    perm_a: 'payroll.write', perm_b: 'gl.write',
    note: '自己算工资自己入账，人工成本可被调整',
    compensate: '薪酬发放前由总经理确认总额，银行代发流水留档'
  }
];

/** 某个角色默认拥有的权限点 */
function permsOfRole(role) {
  if (role === 'boss') {
    // 总经理：全业务只读（写权限点一个都不给），关键审批走审批流而非按钮
    return [];
  }
  return Object.keys(PERMS).filter((p) => PERMS[p].includes(role));
}

/** 全部权限点名 */
function allPerms() {
  return Object.keys(PERMS);
}

module.exports = {
  ROLES, ROLE_LABELS, PERMS, GUARDED, SOD_RULES, WRITE_METHODS,
  permsOfRole, allPerms
};
