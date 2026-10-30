/**
 * 统一接口封装：自动带 Token、统一解包 data、401 自动跳登录
 */
import { auth, clearAuth } from '../store/auth';

const BASE = import.meta.env.VITE_API_BASE || '';

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (auth.token) h.Authorization = `Bearer ${auth.token}`;

  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let json = {};
  try {
    json = await res.json();
  } catch (e) {
    json = {};
  }

  if (res.status === 401) {
    clearAuth();
    if (location.pathname !== '/login') location.href = '/login';
  }
  if (!res.ok) {
    // 把 status / code / data 一起挂到 error 上：
    // 有些拒绝不是「出错了」，而是「业务上不许」（比如发货被信用闸门拦下 code=CREDIT_BLOCK），
    // 页面要拿到结构化原因才能引导用户去办放行单，光一句 message 弹出来等于死路
    const err = new Error(json.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = json.code;
    err.data = json.data;
    throw err;
  }
  return json.data !== undefined ? json.data : json;
}

function qs(params = {}) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== '' && v != null) p.append(k, v);
  });
  const s = p.toString();
  return s ? '?' + s : '';
}

/**
 * 下载一个**需要登录**的文件（私有附件）
 *
 * 为什么不能直接用 `<a href="/api/files/att/xxx">`：浏览器直接打开链接时不会带
 * `Authorization` 头，服务端只能看到"匿名请求" → 401。也不能把 token 拼进 URL
 * （token 会进浏览器历史、Referer、服务器访问日志）。
 *
 * 所以走这条路：带 token fetch → 拿 blob → 用临时 `<a download>` 触发保存。
 * 返回的 url 若是公开图片（`/uploads/...`），直接开新窗口即可，不必走这里。
 */
async function download(url, filename) {
  const h = {};
  if (auth.token) h.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(BASE + url, { headers: h });
  if (res.status === 401) {
    clearAuth();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) {
    let msg = `下载失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j && j.message) msg = j.message;
    } catch (e) { /* 非 JSON 响应，用默认提示 */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  // 服务端文件名是随机串，这里用调用方给的可读名（缺省也不影响下载）
  a.download = filename || url.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器上会让下载中断，给它一点时间
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export const api = {  // 登录
  login: (username, password) => req('/api/auth/login', { method: 'POST', body: { username, password } }),
  me: () => req('/api/auth/me'),

  // 客户
  customers: (params) => req('/api/customers' + qs(params)),
  createCustomer: (d) => req('/api/customers', { method: 'POST', body: d }),
  updateCustomer: (id, d) => req(`/api/customers/${id}`, { method: 'PUT', body: d }),
  deleteCustomer: (id) => req(`/api/customers/${id}`, { method: 'DELETE' }),

  // 产品
  products: (params) => req('/api/products' + qs(params)),
  createProduct: (d) => req('/api/products', { method: 'POST', body: d }),
  updateProduct: (id, d) => req(`/api/products/${id}`, { method: 'PUT', body: d }),
  deleteProduct: (id) => req(`/api/products/${id}`, { method: 'DELETE' }),

  // 订单
  orders: (params) => req('/api/orders' + qs(params)),
  order: (id) => req(`/api/orders/${id}`),
  /** 局域网地址：单据二维码要用它，否则用 127.0.0.1 打开时二维码手机扫了打不开 */
  lanInfo: () => req('/api/settings/lan'),

  /** 按标签码 / 订单号查单（扫码直达用；带 '-' 的标签码只取第一段） */
  findOrder: (no) => req('/api/orders/find?no=' + encodeURIComponent(no)),
  findOrder: (no) => req('/api/orders/find?no=' + encodeURIComponent(no)),
  orderMeta: () => req('/api/orders/meta'),
  orderStats: () => req('/api/orders/stats/summary'),
  createOrder: (d) => req('/api/orders', { method: 'POST', body: d }),
  updateOrderItems: (id, items) => req(`/api/orders/${id}/items`, { method: 'PUT', body: { items } }),
  // 订单号反查 / 改号（改号会级联同步下游，所以先预览再确认）
  /** 订单信息收集看板（下单信息 + 打版信息），屏幕与打印共用同一份 */
  orderSheet: (id) => req(`/api/orders/${id}/sheet`),
  orderSheetFields: () => req('/api/orders/sheet-fields'),
  orderNoTrace: (no) => req('/api/orders/order-no/trace' + qs({ no })),
  orderNoPreview: (id, no) => req(`/api/orders/order-no/${id}/preview` + qs({ no })),
  orderNoLogs: (id) => req(`/api/orders/order-no/${id}/logs`),
  renameOrderNo: (id, d) => req(`/api/orders/order-no/${id}`, { method: 'POST', body: d }),
  transitionOrder: (id, to, note) =>
    req(`/api/orders/${id}/transition`, { method: 'POST', body: { to, note } }),
  // 批量流转：dry_run=1 只预检（不写库）；all_or_nothing=1 整批一致；默认逐单尽力
  orderBatchTransition: (d) => req('/api/orders/batch/transition', { method: 'POST', body: d }),
  rollbackOrder: (id, to, reason) =>
    req(`/api/orders/${id}/rollback`, { method: 'POST', body: { to, reason } }),

  // 技术资料 / 开发单
  techpacks: (orderId) => req(`/api/techpacks?order_id=${orderId}`),
  techpacksAll: (params) => req('/api/techpacks/all' + qs(params)),
  createTechpack: (d) => req('/api/techpacks', { method: 'POST', body: d }),
  updateTechpack: (id, d) => req(`/api/techpacks/${id}`, { method: 'PUT', body: d }),
  deleteTechpack: (id) => req(`/api/techpacks/${id}`, { method: 'DELETE' }),
  confirmTechpack: (id) => req(`/api/techpacks/${id}/confirm`, { method: 'POST' }),
  /** 确认前检查：返回还差什么（与确认接口同一份判断，避免"检查说没问题、点了却被拒"） */
  techpackConfirmCheck: (id) => req(`/api/techpacks/${id}/confirm-check`),
  rejectTechpack: (id) => req(`/api/techpacks/${id}/reject`, { method: 'POST' }),
  techpackStage: (id, stage) => req(`/api/techpacks/${id}/stage`, { method: 'POST', body: { stage } }),
  techpackFull: (id) => req(`/api/techpacks/${id}/full`),
  /** 工序明细：与「订单工序」页（打版流程 craft 阶段）是同一份数据 */
  techpackCrafts: (id) => req(`/api/techpacks/${id}/crafts`),
  saveTechpackCrafts: (id, d) => req(`/api/techpacks/${id}/crafts`, { method: 'PUT', body: d }),
  techpackCurrent: (orderId) => req(`/api/techpacks/by-order/${orderId}/current`),
  saveTechpackDetail: (id, d) => req(`/api/techpacks/${id}/detail`, { method: 'PUT', body: d }),
  techpackSizesFromOrder: (id, d) => req(`/api/techpacks/${id}/sizes/from-order`, { method: 'POST', body: d || {} }),
  newTechpackVersion: (id) => req(`/api/techpacks/${id}/new-version`, { method: 'POST' }),

  // 尺码模板
  sizeTemplates: () => req('/api/size-templates'),
  createSizeTemplate: (d) => req('/api/size-templates', { method: 'POST', body: d }),
  deleteSizeTemplate: (id) => req(`/api/size-templates/${id}`, { method: 'DELETE' }),

  // 成本与财务
  cost: (orderId) => req(`/api/costs/${orderId}`),
  saveCost: (orderId, d) => req(`/api/costs/${orderId}`, { method: 'POST', body: d }),
  reviewCost: (orderId, approve, opinion) =>
    req(`/api/costs/${orderId}/review`, { method: 'POST', body: { approve, opinion } }),

  // 打样/制版
  samples: (orderId) => req(`/api/samples?order_id=${orderId}`),
  createSample: (d) => req('/api/samples', { method: 'POST', body: d }),
  setSampleStatus: (id, status) => req(`/api/samples/${id}/status`, { method: 'POST', body: { status } }),

  // 工艺明细
  crafts: (orderId) => req(`/api/crafts?order_id=${orderId}`),
  createCraft: (d) => req('/api/crafts', { method: 'POST', body: d }),
  deleteCraft: (id) => req(`/api/crafts/${id}`, { method: 'DELETE' }),

  // 面辅料用量
  orderMaterials: (orderId) => req(`/api/order-materials?order_id=${orderId}`),
  createOrderMaterial: (d) => req('/api/order-materials', { method: 'POST', body: d }),
  updateOrderMaterial: (id, d) => req(`/api/order-materials/${id}`, { method: 'PUT', body: d }),
  /** 某物料配了哪些颜色（含该款可选颜色） */
  orderMaterialColors: (id) => req(`/api/order-materials/${id}/colors`),
  /** 只改颜色：所有颜色通用 / 按色指定色号与单件用量 */
  setOrderMaterialColors: (id, d) => req(`/api/order-materials/${id}/colors`, { method: 'PUT', body: d }),
  deleteOrderMaterial: (id) => req(`/api/order-materials/${id}`, { method: 'DELETE' }),

  // 生产看板
  productionBoard: (params) => req('/api/production/board' + qs(params)),

  // 生产工序
  orderNodes: (orderId) => req(`/api/order-nodes?order_id=${orderId}`),
  initNodes: (orderId) => req('/api/order-nodes/init', { method: 'POST', body: { order_id: orderId } }),
  updateNode: (id, d) => req(`/api/order-nodes/${id}`, { method: 'PATCH', body: d }),
  /** 点开一个工序格子：内容按节点的 panel 类型分化（采购明细 / 备注+凭证+时间线） */
  nodePanel: (id) => req(`/api/order-nodes/${id}/panel`),
  /** 从看板直接分配：mode = own 本厂 / outsource 整单外发 / cut 裁片外发 */
  assignNode: (id, d) => req(`/api/order-nodes/${id}/assign`, { method: 'POST', body: d }),

  // 工序流程模板（节点可自定义）
  // 模板 = 新订单的「配方」；改模板不影响已下单，要让存量跟上得显式 apply
  nodeFlowTemplates: () => req('/api/node-flow/templates'),
  nodeFlowTemplate: (id) => req(`/api/node-flow/templates/${id}`),
  saveNodeFlowTemplate: (d) => (d.id
    ? req(`/api/node-flow/templates/${d.id}`, { method: 'PUT', body: d })
    : req('/api/node-flow/templates', { method: 'POST', body: d })),
  setDefaultNodeFlow: (id) => req(`/api/node-flow/templates/${id}/default`, { method: 'POST' }),
  addNodeFlowItem: (tplId, d) => req(`/api/node-flow/templates/${tplId}/items`, { method: 'POST', body: d }),
  updateNodeFlowItem: (id, d) => req(`/api/node-flow/items/${id}`, { method: 'PUT', body: d }),
  setNodeFlowItemStatus: (id, status) => req(`/api/node-flow/items/${id}/status`, { method: 'POST', body: { status } }),
  reorderNodeFlow: (tplId, ids) => req(`/api/node-flow/templates/${tplId}/reorder`, { method: 'POST', body: { ids } }),
  /** dry_run 默认 true：先看会往哪些单补哪些节点，再按确认 */
  applyNodeFlow: (tplId, d) => req(`/api/node-flow/templates/${tplId}/apply`, { method: 'POST', body: d }),
  nodeFlowBoard: (params) => req('/api/node-flow/board' + qs(params)),
  nodeFlowBuiltin: () => req('/api/node-flow/builtin'),

  // 库存
  stock: (params) => req('/api/stock' + qs(params)),
  stockSummary: () => req('/api/stock/summary'),
  stockLedger: (params) => req('/api/stock/ledger' + qs(params)),
  stockAdjust: (d) => req('/api/stock/adjust', { method: 'POST', body: d }),
  stockTransfer: (d) => req('/api/stock/transfer', { method: 'POST', body: d }),
  shipBoard: (params) => req('/api/stock/ship-board' + qs(params)),
  autoTransfer: (d) => req('/api/stock/auto-transfer', { method: 'POST', body: d }),
  orderInstock: (d) => req('/api/stock/instock', { method: 'POST', body: d }),
  orderShip: (d) => req('/api/stock/ship', { method: 'POST', body: d }),

  // 生产报工
  reports: (params) => req('/api/reports' + qs(params)),
  reportSummary: (orderId) => req('/api/reports/summary?order_id=' + orderId),
  createReport: (d) => req('/api/reports', { method: 'POST', body: d }),
  deleteReport: (id) => req(`/api/reports/${id}`, { method: 'DELETE' }),

  // 上传 / 款图
  upload: (dataUrl) => req('/api/upload', { method: 'POST', body: { dataUrl } }),
  /** 下载私有附件（带登录态，见上面 download 的说明） */
  download,
  /** 换一条带过期时间的签名链接（发给外部客户/供应商用） */
  signedFileUrl: (name, ttl) => req('/api/files/signed-url', { method: 'POST', body: { name, ttl } }),
  setOrderImage: (id, url) => req(`/api/orders/${id}/image`, { method: 'POST', body: { image_url: url } }),
  restoreDb: (base64) => req('/api/admin/restore', { method: 'POST', body: { base64 } }),

  // 工厂 / 分单
  factories: (params) => req('/api/factories' + qs(params)),
  createFactory: (d) => req('/api/factories', { method: 'POST', body: d }),
  updateFactory: (id, d) => req(`/api/factories/${id}`, { method: 'PUT', body: d }),
  deleteFactory: (id) => req(`/api/factories/${id}`, { method: 'DELETE' }),
  dispatches: (orderId) => req(`/api/dispatch?order_id=${orderId}`),
  dispatchList: (params) => req('/api/dispatch' + qs(params)),
  dispatchRecon: () => req('/api/dispatch/recon'),
  settleDispatch: (id, settled = true) => req(`/api/dispatch/${id}/settle`, { method: 'POST', body: { settled } }),
  createDispatch: (d) => req('/api/dispatch', { method: 'POST', body: d }),
  deleteDispatch: (id) => req(`/api/dispatch/${id}`, { method: 'DELETE' }),

  // 附件
  uploadFile: (dataUrl, filename) => req('/api/upload/file', { method: 'POST', body: { dataUrl, filename } }),
  attachments: (params) => req('/api/attachments' + qs(params)),
  createAttachment: (d) => req('/api/attachments', { method: 'POST', body: d }),
  deleteAttachment: (id) => req(`/api/attachments/${id}`, { method: 'DELETE' }),

  // 现场照片留证
  photoCats: () => req('/api/photos/cats'),
  photos: (params) => req('/api/photos' + qs(params)),
  photoStats: (params) => req('/api/photos/stats' + qs(params)),
  orderPhotos: (id) => req(`/api/photos/order/${id}`),
  createPhoto: (d) => req('/api/photos', { method: 'POST', body: d }),
  createPhotos: (d) => req('/api/photos/batch', { method: 'POST', body: d }),
  deletePhoto: (id) => req(`/api/photos/${id}`, { method: 'DELETE' }),

  // 计件工资（单价版本化 + 月度核算单）
  pieceMeta: () => req('/api/piece-wage/meta'),
  pieceConfig: () => req('/api/piece-wage/config'),
  pieceConfigSave: (d) => req('/api/piece-wage/config', { method: 'PUT', body: d }),
  pieceAttBoard: (period) => req('/api/piece-wage/attendance-board' + qs({ period })),
  pieceRates: (params) => req('/api/piece-wage/rates' + qs(params)),
  pieceRateSave: (d) => req('/api/piece-wage/rates', { method: 'POST', body: d }),
  pieceRateUpdate: (id, d) => req(`/api/piece-wage/rates/${id}`, { method: 'PUT', body: d }),
  piecePreview: (period) => req('/api/piece-wage/preview' + qs({ period })),
  pieceRuns: (params) => req('/api/piece-wage/runs' + qs(params)),
  pieceRun: (id) => req(`/api/piece-wage/runs/${id}`),
  pieceCreateRun: (d) => req('/api/piece-wage/runs', { method: 'POST', body: d }),
  pieceConfirm: (id, note) =>
    req(`/api/piece-wage/runs/${id}/confirm`, { method: 'POST', body: note ? { note } : {} }),
  pieceVoid: (id, reason) =>
    req(`/api/piece-wage/runs/${id}/void`, { method: 'POST', body: { reason } }),
  pieceExportPath: (runId) => '/api/piece-wage/export' + qs({ run_id: runId }),
  piecePayslips: (runId, mode) => req(`/api/piece-wage/runs/${runId}/payslips` + qs({ mode })),
  // 客户对账单（对账函）
  statementCustomers: () => req('/api/statements/customers'),
  statement: (customerId, params) => req(`/api/statements/${customerId}` + qs(params)),
  // 客户信用与账期
  creditBoard: (params) => req('/api/credit/board' + qs(params)),
  creditConfig: () => req('/api/credit/config'),
  creditSaveConfig: (d) => req('/api/credit/config', { method: 'PUT', body: d }),
  creditCheck: (orderId) => req(`/api/credit/check/${orderId}`),
  creditDetail: (customerId) => req(`/api/credit/${customerId}`),
  creditSetLimit: (customerId, d) => req(`/api/credit/${customerId}`, { method: 'PUT', body: d }),
  creditHold: (customerId, d) => req(`/api/credit/${customerId}/hold`, { method: 'POST', body: d }),
  creditOverride: (d) => req('/api/credit/overrides', { method: 'POST', body: d }),
  creditOverrides: (params) => req('/api/credit/overrides' + qs(params)),
  creditExportPath: (params) => '/api/credit/export' + qs(params),
  // 应付台账与付款计划
  payableBoard: (params) => req('/api/payable/board' + qs(params)),
  payableSchedule: (params) => req('/api/payable/schedule' + qs(params)),
  payableDetail: (id) => req(`/api/payable/${id}`),
  payableSetTerm: (id, d) => req(`/api/payable/${id}`, { method: 'PUT', body: d }),
  payableExportPath: (params) => '/api/payable/export' + qs(params),
  // 资金计划（13 周现金流）
  cashflowPlan: (params) => req('/api/cashflow/plan' + qs(params)),
  cashflowCompare: (params) => req('/api/cashflow/compare' + qs(params)),
  // 付款申请单（提交 → 审批 → 出纳执行付款）
  prMeta: () => req('/api/payment-requests/meta'),
  prCandidates: (params) => req('/api/payment-requests/candidates' + qs(params)),
  prList: (params) => req('/api/payment-requests' + qs(params)),
  prDetail: (id) => req(`/api/payment-requests/${id}`),
  prCreate: (d) => req('/api/payment-requests', { method: 'POST', body: d }),
  prUpdate: (id, d) => req(`/api/payment-requests/${id}`, { method: 'PUT', body: d }),
  prDelete: (id) => req(`/api/payment-requests/${id}`, { method: 'DELETE' }),
  prSubmit: (id) => req(`/api/payment-requests/${id}/submit`, { method: 'POST' }),
  prCancel: (id, reason) => req(`/api/payment-requests/${id}/cancel`, { method: 'POST', body: { reason } }),
  prPay: (id, d) => req(`/api/payment-requests/${id}/pay`, { method: 'POST', body: d }),
  prExportPath: (params) => '/api/payment-requests/export' + qs(params),
  // 应收催收
  colMeta: () => req('/api/collections/meta'),
  colBoard: () => req('/api/collections/board'),
  colGenerate: (d) => req('/api/collections/generate', { method: 'POST', body: d }),
  colList: (params) => req('/api/collections' + qs(params)),
  colDetail: (id) => req(`/api/collections/${id}`),
  colLog: (id, d) => req(`/api/collections/${id}/log`, { method: 'POST', body: d }),
  colAssign: (id, d) => req(`/api/collections/${id}/assign`, { method: 'POST', body: d }),
  colClose: (id, d) => req(`/api/collections/${id}/close`, { method: 'POST', body: d }),
  colReopen: (id, d) => req(`/api/collections/${id}/reopen`, { method: 'POST', body: d }),
  colExportPath: (params) => '/api/collections/export' + qs(params),

  // 异常协同与日清
  excMeta: (params) => req('/api/exceptions/meta' + qs(params)),
  excDaily: (params) => req('/api/exceptions/daily' + qs(params)),
  excReport: (params) => req('/api/exceptions/report' + qs(params)),
  excStats: (params) => req('/api/exceptions/stats' + qs(params)),
  excScan: (d) => req('/api/exceptions/scan', { method: 'POST', body: d || {} }),
  excRules: () => req('/api/exceptions/rules'),
  excSaveRule: (code, d) => req(`/api/exceptions/rules/${code}`, { method: 'PUT', body: d }),
  excList: (params) => req('/api/exceptions' + qs(params)),
  excDetail: (id) => req(`/api/exceptions/${id}`),
  excClaim: (id) => req(`/api/exceptions/${id}/claim`, { method: 'POST', body: {} }),
  excAssign: (id, d) => req(`/api/exceptions/${id}/assign`, { method: 'POST', body: d }),
  excClose: (id, d) => req(`/api/exceptions/${id}/close`, { method: 'POST', body: d }),
  excReview: (id, d) => req(`/api/exceptions/${id}/review`, { method: 'POST', body: d }),
  excNote: (id, d) => req(`/api/exceptions/${id}/note`, { method: 'POST', body: d }),
  excReopen: (id, d) => req(`/api/exceptions/${id}/reopen`, { method: 'POST', body: d }),
  excIgnore: (id, d) => req(`/api/exceptions/${id}/ignore`, { method: 'POST', body: d }),

  // 生产交付效率与质量报表
  prOverview: (params) => req('/api/prod-report/overview' + qs(params)),
  prOnTime: (params) => req('/api/prod-report/on-time' + qs(params)),
  prSegments: (params) => req('/api/prod-report/segments' + qs(params)),
  prEfficiency: (params) => req('/api/prod-report/efficiency' + qs(params)),
  prQuality: (params) => req('/api/prod-report/quality' + qs(params)),
  prWip: (params) => req('/api/prod-report/wip' + qs(params)),
  prPlan: (params) => req('/api/prod-report/plan-vs-actual' + qs(params)),
  prMaterial: (params) => req('/api/prod-report/material' + qs(params)),
  prLead: (params) => req('/api/prod-report/lead-time' + qs(params)),
  prExportPath: (params) => '/api/prod-report/export' + qs(params),

  // 流程变更发布与审计
  fcMeta: () => req('/api/flow-changes/meta'),
  fcFlows: () => req('/api/flow-changes/flows'),
  fcVersions: (flowKey) => req('/api/flow-changes/flows/versions?flow_key=' + encodeURIComponent(flowKey)),
  fcChanges: (params) => req('/api/flow-changes/changes' + qs(params)),
  fcDetail: (id) => req(`/api/flow-changes/changes/${id}`),
  fcCreate: (d) => req('/api/flow-changes/changes', { method: 'POST', body: d }),
  fcTrial: (id, d) => req(`/api/flow-changes/changes/${id}/trial`, { method: 'POST', body: d }),
  fcPublish: (id, d) => req(`/api/flow-changes/changes/${id}/publish`, { method: 'POST', body: d }),
  fcRollback: (id, d) => req(`/api/flow-changes/changes/${id}/rollback`, { method: 'POST', body: d }),
  fcReject: (id, d) => req(`/api/flow-changes/changes/${id}/reject`, { method: 'POST', body: d }),
  fcAudits: (params) => req('/api/flow-changes/audits' + qs(params)),

  // 技能矩阵与岗位资格
  skMeta: () => req('/api/skills/meta'),
  skMatrix: (params) => req('/api/skills/matrix' + qs(params)),
  skCoverage: () => req('/api/skills/coverage'),
  skExpiring: (params) => req('/api/skills/expiring' + qs(params)),
  skStats: () => req('/api/skills/stats'),
  skCheck: (params) => req('/api/skills/check' + qs(params)),
  skAssess: (d) => req('/api/skills/assess', { method: 'POST', body: d }),
  skRevoke: (d) => req('/api/skills/revoke', { method: 'POST', body: d }),
  skSaveReq: (d) => req('/api/skills/requirements', { method: 'PUT', body: d }),
  skCerts: (params) => req('/api/skills/certs' + qs(params)),
  skAddCert: (d) => req('/api/skills/certs', { method: 'POST', body: d }),
  skRevokeCert: (id, d) => req(`/api/skills/certs/${id}/revoke`, { method: 'POST', body: d }),
  skTrainings: (params) => req('/api/skills/trainings' + qs(params)),
  skAddTraining: (d) => req('/api/skills/trainings', { method: 'POST', body: d }),
  skFinishTraining: (id, d) => req(`/api/skills/trainings/${id}/finish`, { method: 'POST', body: d }),
  skOverride: (d) => req('/api/skills/overrides', { method: 'POST', body: d }),

  // 员工自助（只看自己；范围由服务端按账号绑定关系卡）
  selfMeta: () => req('/api/self/meta'),
  selfOverview: () => req('/api/self/overview'),
  selfPayslips: () => req('/api/self/payslips'),
  selfPayslip: (id) => req(`/api/self/payslips/${id}`),
  selfRequests: (params) => req('/api/self/requests' + qs(params)),
  selfSubmit: (d) => req('/api/self/requests', { method: 'POST', body: d }),
  selfWithdraw: (id) => req(`/api/self/requests/${id}/withdraw`, { method: 'POST' }),
  selfTeam: () => req('/api/self/team'),
  selfBindings: (params) => req('/api/self/bindings' + qs(params)),
  selfBindable: (params) => req('/api/self/employees-for-bind' + qs(params)),
  selfBind: (d) => req('/api/self/bind', { method: 'POST', body: d }),
  selfUnbind: (userId) => req(`/api/self/unbind/${userId}`, { method: 'POST' }),
  selfAllRequests: (params) => req('/api/self/all-requests' + qs(params)),
  selfReview: (id, d) => req(`/api/self/review/${id}`, { method: 'POST', body: d }),
  selfAdjustments: (params) => req('/api/self/adjustments' + qs(params)),

  // 客户进度发布（内部侧）
  cpMeta: () => req('/api/customer-progress/meta'),
  cpOrders: (params) => req('/api/customer-progress/orders' + qs(params)),
  cpInternal: (id) => req(`/api/customer-progress/orders/${id}/internal`),
  cpPreview: (id, params) => req(`/api/customer-progress/orders/${id}/preview` + qs(params)),
  cpHistory: (id) => req(`/api/customer-progress/orders/${id}/history`),
  cpPublish: (id, d) => req(`/api/customer-progress/orders/${id}/publish`, { method: 'POST', body: d }),
  cpWithdraw: (pubId, d) => req(`/api/customer-progress/publications/${pubId}/withdraw`, { method: 'POST', body: d }),
  cpSetRoute: (id, d) => req(`/api/customer-progress/orders/${id}/route`, { method: 'PUT', body: d }),

  // 售后与对账资料（内部侧）
  asMeta: () => req('/api/after-sales/meta'),
  asList: (params) => req('/api/after-sales' + qs(params)),
  asDetail: (id) => req(`/api/after-sales/${id}`),
  asAccept: (id, d) => req(`/api/after-sales/${id}/accept`, { method: 'POST', body: d }),
  asReject: (id, d) => req(`/api/after-sales/${id}/reject`, { method: 'POST', body: d }),
  // 退款走独立路径段：后端 GUARDED 是前缀挂锁，`/:id/refund` 那种写法锁不住单个动作
  asRefund: (id, d) => req(`/api/after-sales/refund/${id}`, { method: 'POST', body: d }),
  asRecovery: (id, d) => req(`/api/after-sales/${id}/recovery`, { method: 'POST', body: d }),
  asSettle: (id, d) => req(`/api/after-sales/${id}/settle`, { method: 'POST', body: d }),
  asNote: (id, d) => req(`/api/after-sales/${id}/note`, { method: 'POST', body: d }),

  sfMeta: () => req('/api/statement-files/meta'),
  sfList: (params) => req('/api/statement-files' + qs(params)),
  sfGenerate: (d) => req('/api/statement-files/generate', { method: 'POST', body: d }),
  sfPublish: (id, d) => req(`/api/statement-files/${id}/publish`, { method: 'POST', body: d || {} }),
  sfRevoke: (id, d) => req(`/api/statement-files/${id}/revoke`, { method: 'POST', body: d }),
  sfPreviewPath: (id) => `/api/statement-files/${id}/preview.csv`,

  // 办公耗材与服务采购
  offMeta: () => req('/api/office-supply/meta'),
  offBoard: (params) => req('/api/office-supply/board' + qs(params)),
  offLowStock: () => req('/api/office-supply/low-stock'),
  offLedger: (params) => req('/api/office-supply/ledger' + qs(params)),
  offSaveItem: (d) => req('/api/office-supply/items', { method: 'POST', body: d }),
  offRequests: (params) => req('/api/office-supply/requests' + qs(params)),
  offReqDetail: (id) => req(`/api/office-supply/requests/${id}`),
  offSaveReq: (d) => req('/api/office-supply/requests', { method: 'POST', body: d }),
  offReqSubmit: (id) => req(`/api/office-supply/requests/${id}/submit`, { method: 'POST', body: {} }),
  offReqApprove: (id, d) => req(`/api/office-supply/requests/${id}/approve`, { method: 'POST', body: d || {} }),
  offReqReject: (id, d) => req(`/api/office-supply/requests/${id}/reject`, { method: 'POST', body: d }),
  offReqIssue: (id) => req(`/api/office-supply/requests/${id}/issue`, { method: 'POST', body: {} }),
  offReqReturn: (id, d) => req(`/api/office-supply/requests/${id}/return`, { method: 'POST', body: d }),
  offPurchases: (params) => req('/api/office-supply/purchases' + qs(params)),
  offPoDetail: (id) => req(`/api/office-supply/purchases/${id}`),
  offCreatePo: (d) => req('/api/office-supply/purchases', { method: 'POST', body: d }),
  offPoPrices: (id, d) => req(`/api/office-supply/purchases/${id}/prices`, { method: 'PUT', body: d }),
  offPoApprove: (id) => req(`/api/office-supply/purchases/${id}/approve`, { method: 'POST', body: {} }),
  offPoOrder: (id, d) => req(`/api/office-supply/purchases/${id}/order`, { method: 'POST', body: d || {} }),
  offPoReceive: (id, d) => req(`/api/office-supply/purchases/${id}/receive`, { method: 'POST', body: d || {} }),
  offPoCancel: (id, d) => req(`/api/office-supply/purchases/${id}/cancel`, { method: 'POST', body: d }),

  // 资产工衣与领归
  cuMeta: () => req('/api/custody/meta'),
  cuBoard: () => req('/api/custody/board'),
  cuItems: (params) => req('/api/custody/items' + qs(params)),
  cuSaveItem: (d) => req('/api/custody/items', { method: 'POST', body: d }),
  cuScrap: (id, d) => req(`/api/custody/scrap/${id}`, { method: 'POST', body: d }),
  cuRestore: (id, d) => req(`/api/custody/restore/${id}`, { method: 'POST', body: d }),
  cuItemTimeline: (id) => req(`/api/custody/items/${id}/timeline`),
  cuRecords: (params) => req('/api/custody/records' + qs(params)),
  cuRecord: (id) => req(`/api/custody/records/${id}`),
  cuCreateRecord: (d) => req('/api/custody/records', { method: 'POST', body: d }),
  cuPublish: (id) => req(`/api/custody/records/${id}/publish`, { method: 'POST', body: {} }),
  cuReturn: (id, d) => req(`/api/custody/records/${id}/return`, { method: 'POST', body: d }),
  cuTransfer: (id, d) => req(`/api/custody/records/${id}/transfer`, { method: 'POST', body: d }),
  cuPerson: (id) => req(`/api/custody/person/${id}`),
  cuOverdue: () => req('/api/custody/overdue'),
  cuClearances: (params) => req('/api/custody/clearances' + qs(params)),
  cuBuildClearance: (d) => req('/api/custody/clearances', { method: 'POST', body: d }),
  cuCloseClearance: (id, d) => req(`/api/custody/clearances/${id}/close`, { method: 'POST', body: d || {} }),
  cuClaims: (params) => req('/api/custody/claims' + qs(params)),
  cuCreateClaim: (d) => req('/api/custody/claims', { method: 'POST', body: d }),
  cuReview: (id, d) => req(`/api/custody/review/${id}`, { method: 'POST', body: d }),
  cuFinance: (id, d) => req(`/api/custody/finance/${id}`, { method: 'POST', body: d }),

  // 行政运营报表
  aoMeta: () => req('/api/admin-ops/meta'),
  aoPreview: (params) => req('/api/admin-ops/preview' + qs(params)),
  aoRuns: (params) => req('/api/admin-ops/runs' + qs(params)),
  aoRunDetail: (id) => req(`/api/admin-ops/runs/${id}`),
  aoRun: (d) => req('/api/admin-ops/run', { method: 'POST', body: d }),
  aoFindings: (params) => req('/api/admin-ops/findings' + qs(params)),
  aoAssign: (id, d) => req(`/api/admin-ops/assign/${id}`, { method: 'POST', body: d }),
  aoReview: (id, d) => req(`/api/admin-ops/review/${id}`, { method: 'POST', body: d }),
  aoClose: (id, d) => req(`/api/admin-ops/close/${id}`, { method: 'POST', body: d }),
  aoIgnore: (id, d) => req(`/api/admin-ops/ignore/${id}`, { method: 'POST', body: d }),
  aoDrill: (params) => req('/api/admin-ops/drill' + qs(params)),

  // 薪酬计件与工资核对
  pcMeta: () => req('/api/payroll-check/meta'),
  pcPreview: (params) => req('/api/payroll-check/preview' + qs(params)),
  pcRun: (d) => req('/api/payroll-check/run', { method: 'POST', body: d }),
  pcRuns: (params) => req('/api/payroll-check/runs' + qs(params)),
  pcRunDetail: (id) => req(`/api/payroll-check/runs/${id}`),
  pcSources: (params) => req('/api/payroll-check/sources' + qs(params)),
  pcDiff: (itemId, d) => req(`/api/payroll-check/diff/${itemId}`, { method: 'POST', body: d }),
  pcAnnotate: (itemId, d) => req(`/api/payroll-check/annotate/${itemId}`, { method: 'POST', body: d }),
  pcReview: (id, d) => req(`/api/payroll-check/review/${id}`, { method: 'POST', body: d || {} }),

  // 数据导出与订阅
  exMeta: () => req('/api/exports/meta'),
  exPreview: (defKey, params) => req(`/api/exports/preview/${defKey}` + qs(params)),
  exJobs: (params) => req('/api/exports/jobs' + qs(params)),
  exJob: (id) => req(`/api/exports/jobs/${id}`),
  exTrace: (token) => req('/api/exports/trace' + qs({ token })),
  exStats: () => req('/api/exports/stats'),
  exSubs: (params) => req('/api/exports/subs' + qs(params)),
  exSubSave: (d) => req('/api/exports/subs', { method: 'POST', body: d }),
  exSubAction: (action, id) => req(`/api/exports/subs/${action}/${id}`, { method: 'POST', body: {} }),
  exRunDue: (d) => req('/api/exports/run-due', { method: 'POST', body: d || {} }),
  exDeliveries: (params) => req('/api/exports/deliveries' + qs(params)),

  // 上线检查清单
  glMeta: () => req('/api/go-live/meta'),
  glStats: () => req('/api/go-live/stats'),
  glRounds: (params) => req('/api/go-live/rounds' + qs(params)),
  glRound: (id) => req(`/api/go-live/rounds/${id}`),
  glCreate: (d) => req('/api/go-live/rounds', { method: 'POST', body: d }),
  glRefresh: (id) => req(`/api/go-live/refresh/${id}`, { method: 'POST', body: {} }),
  glManual: (id, d) => req(`/api/go-live/manual/${id}`, { method: 'POST', body: d }),
  glAssign: (id, d) => req(`/api/go-live/assign/${id}`, { method: 'POST', body: d }),
  glSign: (id, d) => req(`/api/go-live/sign/${id}`, { method: 'POST', body: d }),
  glWithdraw: (id, d) => req(`/api/go-live/withdraw/${id}`, { method: 'POST', body: d }),

  // 字段级脱敏与访问审计
  pvMeta: () => req('/api/privacy/meta'),
  pvRules: () => req('/api/privacy/rules'),
  pvSaveRule: (id, d) => req(`/api/privacy/rules/${id}`, { method: 'PUT', body: d }),
  pvReveal: (d) => req('/api/privacy/reveal', { method: 'POST', body: d }),
  pvLogs: (params) => req('/api/privacy/logs' + qs(params)),
  pvStats: () => req('/api/privacy/stats'),
  pvCheck: (table) => req('/api/privacy/check?table=' + encodeURIComponent(table)),
  // 扎标与扫码解析
  labelBundles: (orderId) => req(`/api/labels/bundles/${orderId}`),
  resolveScan: (code) => req('/api/labels/resolve?code=' + encodeURIComponent(code)),
  bundleProgressOrders: () => req('/api/labels/progress'),
  bundleProgress: (orderId) => req(`/api/labels/progress/${orderId}`),

  // 验货报告（对外文件，走快照）
  inspectionPreview: (orderId) => req(`/api/inspection/preview/${orderId}`),
  inspectionCreate: (d) => req('/api/inspection', { method: 'POST', body: d }),
  inspectionGet: (idOrNo) => req(`/api/inspection/${idOrNo}`),
  inspectionHistory: (orderId) => req('/api/inspection?order_id=' + orderId),
  inspectionRecent: (limit) => req('/api/inspection/recent' + (limit ? '?limit=' + limit : '')),

  // 审批 / 人事
  approvals: () => req('/api/approvals/pending'),
  myApprovalTasks: () => req('/api/approvals/my-tasks'),
  actApprovalTask: (id, approve, remark) => req(`/api/approvals/tasks/${id}/act`, { method: 'POST', body: { approve, remark } }),
  employees: (params) => req('/api/employees' + qs(params)),
  departments: () => req('/api/employees/departments'),
  createEmployee: (d) => req('/api/employees', { method: 'POST', body: d }),
  updateEmployee: (id, d) => req(`/api/employees/${id}`, { method: 'PUT', body: d }),
  deleteEmployee: (id) => req(`/api/employees/${id}`, { method: 'DELETE' }),

  // 请假 / 日志 / 助手
  leaves: (params) => req('/api/leaves' + qs(params)),
  createLeave: (d) => req('/api/leaves', { method: 'POST', body: d }),
  reviewLeave: (id, approve) => req(`/api/leaves/${id}/review`, { method: 'POST', body: { approve } }),
  deleteLeave: (id) => req(`/api/leaves/${id}`, { method: 'DELETE' }),
  auditLogs: (params) => req('/api/audit' + qs(params)),
  auditFacets: () => req('/api/audit/facets'),
  auditStats: (params) => req('/api/audit/stats' + qs(params)),
  auditVerify: (params) => req('/api/audit/verify' + qs(params)),
  auditExportPath: (params) => '/api/audit/export' + qs(params),
  auditArchive: (d) => req('/api/audit/archive', { method: 'POST', body: d }),
  auditArchives: () => req('/api/audit/archives'),
  insights: () => req('/api/assistant/insights'),
  assistantReport: (period) => req('/api/assistant/report?period=' + encodeURIComponent(period)),
  assistantQuery: (q) => req('/api/assistant/query', { method: 'POST', body: { q } }),
  aiChat: (message) => req('/api/ai/chat', { method: 'POST', body: { message } }),

  // 审批流配置 / 考勤
  approvalFlows: () => req('/api/approval-flows'),
  createApprovalFlow: (d) => req('/api/approval-flows', { method: 'POST', body: d }),
  updateApprovalFlow: (id, d) => req(`/api/approval-flows/${id}`, { method: 'PUT', body: d }),
  deleteApprovalFlow: (id) => req(`/api/approval-flows/${id}`, { method: 'DELETE' }),
  attendance: (params) => req('/api/attendance' + qs(params)),
  clockAttendance: (employee_id, type) => req('/api/attendance/clock', { method: 'POST', body: { employee_id, type } }),

  // 采购
  purchases: (params) => req('/api/purchases' + qs(params)),
  purchase: (id) => req(`/api/purchases/${id}`),
  createPurchase: (d) => req('/api/purchases', { method: 'POST', body: d }),
  orderPurchase: (id) => req(`/api/purchases/${id}/order`, { method: 'POST' }),
  receivePurchase: (id, items) => req(`/api/purchases/${id}/receive`, { method: 'POST', body: { items } }),
  deletePurchase: (id) => req(`/api/purchases/${id}`, { method: 'DELETE' }),

  // 生产原料收货与检验
  receiptBoard: (params) => req('/api/receipts/board' + qs(params)),
  receiptPending: () => req('/api/receipts/pending'),
  receiptPo: (poId) => req(`/api/receipts/po/${poId}`),
  receipt: (id) => req(`/api/receipts/${id}`),
  createReceipt: (d) => req('/api/receipts', { method: 'POST', body: d }),
  updateReceiptItem: (id, itemId, d) => req(`/api/receipts/${id}/items/${itemId}`, { method: 'PUT', body: d }),
  inspectReceipt: (id, items) => req(`/api/receipts/${id}/inspect`, { method: 'POST', body: { items } }),
  disposeReceiptItem: (id, itemId, d) => req(`/api/receipts/${id}/items/${itemId}/dispose`, { method: 'POST', body: d }),
  cancelReceipt: (id, reason) => req(`/api/receipts/${id}/cancel`, { method: 'POST', body: { reason } }),

  // 供应商评价与备用产能
  supplierEvalBoard: (params) => req('/api/supplier-evals/board' + qs(params)),
  supplierEvalDetail: (supplierId) => req(`/api/supplier-evals/board/${supplierId}`),
  collectSupplierEval: (d) => req('/api/supplier-evals/collect', { method: 'POST', body: d }),
  recollectSupplierEval: (id) => req(`/api/supplier-evals/${id}/recollect`, { method: 'POST' }),
  updateSupplierEval: (id, d) => req(`/api/supplier-evals/${id}`, { method: 'PUT', body: d }),
  decideSupplierEval: (id, d) => req(`/api/supplier-evals/${id}/decide`, { method: 'POST', body: d }),
  supplierQualifications: () => req('/api/supplier-evals/qualifications'),
  supplierRects: (params) => req('/api/supplier-evals/rectifications' + qs(params)),
  submitSupplierRect: (id, d) => req(`/api/supplier-evals/rectifications/${id}/submit`, { method: 'POST', body: d }),
  verifySupplierRect: (id, d) => req(`/api/supplier-evals/rectifications/${id}/verify`, { method: 'POST', body: d }),
  supplierBackups: (params) => req('/api/supplier-evals/backups' + qs(params)),
  saveSupplierBackup: (d) => req('/api/supplier-evals/backups', { method: 'POST', body: d }),
  verifySupplierBackup: (id, d) => req(`/api/supplier-evals/backups/${id}/verify`, { method: 'POST', body: d }),
  rejectSupplierBackup: (id, d) => req(`/api/supplier-evals/backups/${id}/reject`, { method: 'POST', body: d }),
  supplierBackupPick: (params) => req('/api/supplier-evals/backup-pick' + qs(params)),

  // 停单改量与供应商退料
  purchaseChangeBoard: (params) => req('/api/purchase-changes/board' + qs(params)),
  purchaseChangePo: (poId) => req(`/api/purchase-changes/po/${poId}`),
  createPurchaseChange: (d) => req('/api/purchase-changes', { method: 'POST', body: d }),
  submitPurchaseChange: (id) => req(`/api/purchase-changes/${id}/submit`, { method: 'POST' }),
  confirmPurchaseChange: (id, d) => req(`/api/purchase-changes/${id}/supplier-confirm`, { method: 'POST', body: d }),
  effectivePurchaseChange: (id) => req(`/api/purchase-changes/${id}/effective`, { method: 'POST' }),
  voidPurchaseChange: (id) => req(`/api/purchase-changes/${id}/void`, { method: 'POST' }),
  purchaseReturns: (params) => req('/api/purchase-changes/returns' + qs(params)),
  createPurchaseReturn: (d) => req('/api/purchase-changes/returns', { method: 'POST', body: d }),
  physicalReturn: (id, d) => req(`/api/purchase-changes/returns/${id}/physical`, { method: 'POST', body: d }),
  creditReturn: (id, d) => req(`/api/purchase-changes/returns/${id}/credit`, { method: 'POST', body: d }),
  voidReturn: (id) => req(`/api/purchase-changes/returns/${id}/void`, { method: 'POST' }),

  // 返工报废与生产结单
  reworkBoard: (params) => req('/api/reworks/board' + qs(params)),
  rework: (id) => req(`/api/reworks/${id}`),
  createRework: (d) => req('/api/reworks', { method: 'POST', body: d }),
  submitRework: (id) => req(`/api/reworks/${id}/submit`, { method: 'POST' }),
  approveRework: (id, d) => req(`/api/reworks/${id}/approve`, { method: 'POST', body: d }),
  startRework: (id) => req(`/api/reworks/${id}/start`, { method: 'POST' }),
  reinspectRework: (id, d) => req(`/api/reworks/${id}/reinspect`, { method: 'POST', body: d }),
  scrapRework: (id, d) => req(`/api/reworks/${id}/scrap`, { method: 'POST', body: d }),
  reworkNodes: (orderId) => req(`/api/reworks/nodes/${orderId}`),
  closeGate: (orderId) => req(`/api/production-close/gate/${orderId}`),
  closeBoard: (params) => req('/api/production-close/board' + qs(params)),
  closeOrder: (d) => req('/api/production-close', { method: 'POST', body: d }),
  closuresOfOrder: (orderId) => req(`/api/production-close/order/${orderId}`),

  // 设备停机与产能
  equipmentBoard: (params) => req('/api/equipment/board' + qs(params)),
  createEquipment: (d) => req('/api/equipment', { method: 'POST', body: d }),
  updateEquipment: (id, d) => req(`/api/equipment/${id}`, { method: 'PUT', body: d }),
  downtimes: (params) => req('/api/equipment/downtimes' + qs(params)),
  createDowntime: (d) => req('/api/equipment/downtimes', { method: 'POST', body: d }),
  startRepair: (id) => req(`/api/equipment/downtimes/${id}/start-repair`, { method: 'POST' }),
  finishRepair: (id, d) => req(`/api/equipment/downtimes/${id}/finish-repair`, { method: 'POST', body: d }),
  safetyRelease: (id, d) => req(`/api/equipment/downtimes/${id}/safety`, { method: 'POST', body: d }),
  cancelDowntime: (id, d) => req(`/api/equipment/downtimes/${id}/cancel`, { method: 'POST', body: d }),
  equipmentCapacity: (params) => req('/api/equipment/capacity' + qs(params)),
  equipmentCapacityBoard: (params) => req('/api/equipment/capacity-board' + qs(params)),

  // 岗位绩效与申诉
  kpiDict: () => req('/api/kpi/dict'),
  kpiSummary: () => req('/api/kpi/summary'),
  kpiBoard: (params) => req('/api/kpi/board' + qs(params)),
  kpiTemplates: (params) => req('/api/kpi/templates' + qs(params)),
  kpiTemplate: (id) => req(`/api/kpi/templates/${id}`),
  kpiCreateTemplate: (d) => req('/api/kpi/templates', { method: 'POST', body: d }),
  kpiUpdateTemplate: (id, d) => req(`/api/kpi/templates/${id}`, { method: 'PUT', body: d }),
  kpiAddRule: (id, d) => req(`/api/kpi/templates/${id}/rules`, { method: 'POST', body: d }),
  kpiUpdateRule: (id, rid, d) => req(`/api/kpi/templates/${id}/rules/${rid}`, { method: 'PUT', body: d }),
  kpiDeleteRule: (id, rid) => req(`/api/kpi/templates/${id}/rules/${rid}`, { method: 'DELETE' }),
  kpiSubmitTemplate: (id) => req(`/api/kpi/templates/${id}/submit`, { method: 'POST' }),
  kpiApproveTemplate: (id, d) => req(`/api/kpi/templates/${id}/approve`, { method: 'POST', body: d || {} }),
  kpiNewVersion: (id) => req(`/api/kpi/templates/${id}/new-version`, { method: 'POST' }),
  kpiSimulate: (id, d) => req(`/api/kpi/templates/${id}/simulate`, { method: 'POST', body: d || {} }),
  kpiCycles: () => req('/api/kpi/cycles'),
  kpiCreateCycle: (d) => req('/api/kpi/cycles', { method: 'POST', body: d || {} }),
  kpiFreezeCycle: (id) => req(`/api/kpi/cycles/${id}/freeze`, { method: 'POST' }),
  kpiScores: (params) => req('/api/kpi/scores' + qs(params)),
  kpiScore: (id) => req(`/api/kpi/scores/${id}`),
  kpiGenerate: (d) => req('/api/kpi/generate', { method: 'POST', body: d || {} }),
  kpiAddItem: (id, d) => req(`/api/kpi/scores/${id}/items`, { method: 'POST', body: d }),
  kpiConfirmScore: (id) => req(`/api/kpi/scores/${id}/confirm`, { method: 'POST' }),
  kpiConfirmItem: (id, d) => req(`/api/kpi/items/${id}/confirm`, { method: 'POST', body: d || {} }),
  kpiRejectItem: (id, d) => req(`/api/kpi/items/${id}/confirm`, { method: 'POST', body: { ...(d || {}), action: 'reject' } }),
  kpiDeleteItem: (id) => req(`/api/kpi/items/${id}`, { method: 'DELETE' }),
  kpiAppeals: (params) => req('/api/kpi/appeals' + qs(params)),
  kpiCreateAppeal: (d) => req('/api/kpi/appeals', { method: 'POST', body: d }),
  kpiAcceptAppeal: (id) => req(`/api/kpi/appeals/${id}/accept`, { method: 'POST' }),
  kpiDecideAppeal: (id, d) => req(`/api/kpi/appeals/${id}/decide`, { method: 'POST', body: d }),
  kpiWithdrawAppeal: (id, d) => req(`/api/kpi/appeals/${id}/withdraw`, { method: 'POST', body: d || {} }),

  // 行政合同与履约日历 / 印章授权
  adminContractDict: () => req('/api/admin-contracts/dict'),
  adminContractBoard: () => req('/api/admin-contracts/board'),
  adminContracts: (params) => req('/api/admin-contracts/contracts' + qs(params)),
  adminContract: (id) => req(`/api/admin-contracts/contracts/${id}`),
  createAdminContract: (d) => req('/api/admin-contracts/contracts', { method: 'POST', body: d }),
  updateAdminContract: (id, d) => req(`/api/admin-contracts/contracts/${id}`, { method: 'PUT', body: d }),
  addAdminContractVersion: (id, d) => req(`/api/admin-contracts/contracts/${id}/versions`, { method: 'POST', body: d }),
  renewAdminContract: (id, d) => req(`/api/admin-contracts/contracts/${id}/renew`, { method: 'POST', body: d }),
  terminateAdminContract: (id, d) => req(`/api/admin-contracts/contracts/${id}/terminate`, { method: 'POST', body: d }),
  archiveAdminContract: (id, d) => req(`/api/admin-contracts/contracts/${id}/archive`, { method: 'POST', body: d || {} }),
  addAdminMilestone: (id, d) => req(`/api/admin-contracts/contracts/${id}/milestones`, { method: 'POST', body: d }),
  doneAdminMilestone: (id, d) => req(`/api/admin-contracts/milestones/${id}/done`, { method: 'POST', body: d }),
  waiveAdminMilestone: (id, d) => req(`/api/admin-contracts/milestones/${id}/waive`, { method: 'POST', body: d }),
  adminCalendar: (params) => req('/api/admin-contracts/calendar' + qs(params)),
  sealGrants: (params) => req('/api/admin-contracts/seal-grants' + qs(params)),
  createSealGrant: (d) => req('/api/admin-contracts/seal-grants', { method: 'POST', body: d }),
  revokeSealGrant: (id, d) => req(`/api/admin-contracts/seal-grants/${id}/revoke`, { method: 'POST', body: d }),
  adminSealUsages: (params) => req('/api/admin-contracts/seal-usages' + qs(params)),
  createAdminSealUsage: (d) => req('/api/admin-contracts/seal-usages', { method: 'POST', body: d }),
  approveSealUsage: (id) => req(`/api/admin-contracts/seal-usages/${id}/approve`, { method: 'POST' }),
  useSeal: (id, d) => req(`/api/admin-contracts/seal-usages/${id}/use`, { method: 'POST', body: d || {} }),
  borrowSeal: (id) => req(`/api/admin-contracts/seal-usages/${id}/borrow`, { method: 'POST' }),
  returnSeal: (id, d) => req(`/api/admin-contracts/seal-usages/${id}/return`, { method: 'POST', body: d || {} }),
  rejectSealUsage: (id, d) => req(`/api/admin-contracts/seal-usages/${id}/reject`, { method: 'POST', body: d }),
  adminCertificates: () => req('/api/admin-contracts/certificates'),
  viewAdminCertificate: (id, d) => req(`/api/admin-contracts/certificates/${id}/view`, { method: 'POST', body: d || {} }),
  adminAccessLogs: (params) => req('/api/admin-contracts/access-logs' + qs(params)),

  // 流程超时升级与 SOP
  processDict: () => req('/api/process/dict'),
  processBoard: () => req('/api/process/board'),
  processTasks: (params) => req('/api/process/tasks' + qs(params)),
  processRemind: (id) => req(`/api/process/tasks/${id}/remind`, { method: 'POST' }),
  processEscalate: (id, d) => req(`/api/process/tasks/${id}/escalate`, { method: 'POST', body: d }),
  processReceive: (id) => req(`/api/process/tasks/${id}/receive`, { method: 'POST' }),
  processDelegateTask: (id, d) => req(`/api/process/tasks/${id}/delegate`, { method: 'POST', body: d }),
  processScan: () => req('/api/process/scan', { method: 'POST' }),
  processSla: () => req('/api/process/sla'),
  processUpdateSla: (flowId, d) => req(`/api/process/sla/${flowId}`, { method: 'PUT', body: d }),
  processDelegates: () => req('/api/process/delegates'),
  processCreateDelegate: (d) => req('/api/process/delegates', { method: 'POST', body: d }),
  processRevokeDelegate: (id, d) => req(`/api/process/delegates/${id}/revoke`, { method: 'POST', body: d }),
  sops: (params) => req('/api/process/sop' + qs(params)),
  sop: (id) => req(`/api/process/sop/${id}`),
  createSop: (d) => req('/api/process/sop', { method: 'POST', body: d }),
  addSopVersion: (id, d) => req(`/api/process/sop/${id}/versions`, { method: 'POST', body: d }),
  publishSop: (id, d) => req(`/api/process/sop/${id}/publish`, { method: 'POST', body: d || {} }),
  retireSop: (id, d) => req(`/api/process/sop/${id}/retire`, { method: 'POST', body: d }),
  ackSop: (id, d) => req(`/api/process/sop/${id}/ack`, { method: 'POST', body: d }),

  // 内部邮件
  mailContacts: (params) => req('/api/mail/contacts' + qs(params)),
  mailUnread: () => req('/api/mail/unread'),
  mailBox: (params) => req('/api/mail/box' + qs(params)),
  mailStats: () => req('/api/mail/stats'),
  mailThread: (id) => req(`/api/mail/thread/${id}`),
  mailMessage: (id) => req(`/api/mail/${id}`),
  sendMail: (d) => req('/api/mail/send', { method: 'POST', body: d }),
  ackMail: (id, d) => req(`/api/mail/${id}/ack`, { method: 'POST', body: d || {} }),
  questionMail: (id, d) => req(`/api/mail/${id}/question`, { method: 'POST', body: d }),
  answerMail: (id, d) => req(`/api/mail/${id}/answer`, { method: 'POST', body: d }),
  flagMail: (id, d) => req(`/api/mail/${id}/flag`, { method: 'POST', body: d }),
  recallMail: (id, reason) => req(`/api/mail/${id}/recall`, { method: 'POST', body: { reason } }),
  correctMail: (id, d) => req(`/api/mail/${id}/correct`, { method: 'POST', body: d }),
  retryMail: (id) => req(`/api/mail/${id}/retry`, { method: 'POST' }),
  mailTasksMine: (params) => req('/api/mail/tasks/mine' + qs(params)),
  doneMailTask: (id, d) => req(`/api/mail/tasks/${id}/done`, { method: 'POST', body: d || {} }),
  mailDelegates: () => req('/api/mail/delegates'),
  saveMailDelegate: (d) => req('/api/mail/delegates', { method: 'POST', body: d }),
  revokeMailDelegate: (id) => req(`/api/mail/delegates/${id}/revoke`, { method: 'POST' }),

  // 工作台
  dashboard: () => req('/api/dashboard'),

  // 外部接口与事件补偿
  integrationStats: () => req('/api/integration/stats'),
  integrationEndpoints: () => req('/api/integration/endpoints'),
  createIntegrationEndpoint: (d) => req('/api/integration/endpoints', { method: 'POST', body: d }),
  updateIntegrationEndpoint: (id, d) => req('/api/integration/endpoints/' + id, { method: 'PUT', body: d }),
  rotateIntegrationKey: (id) => req(`/api/integration/endpoints/${id}/rotate-key`, { method: 'POST' }),
  integrationEvents: (params) => req('/api/integration/events' + qs(params)),
  retryIntegrationEvent: (id) => req(`/api/integration/events/${id}/retry`, { method: 'POST' }),
  dropIntegrationEvent: (id, d) => req(`/api/integration/events/${id}/drop`, { method: 'POST', body: d || {} }),
  dispatchIntegration: (d) => req('/api/integration/dispatch', { method: 'POST', body: d || {} }),
  integrationCalls: (params) => req('/api/integration/calls' + qs(params)),
  integrationShipments: (params) => req('/api/integration/shipments' + qs(params)),
  correctShipment: (id, d) => req(`/api/integration/shipments/${id}/correct`, { method: 'POST', body: d }),
  approveShipmentCorrection: (id) => req(`/api/integration/shipments/${id}/correct/approve`, { method: 'POST' }),
  rejectShipmentCorrection: (id, d) => req(`/api/integration/shipments/${id}/correct/reject`, { method: 'POST', body: d || {} }),
  openapi: () => req('/api/integration/openapi.json'),
  signedFileUrl: (d) => req('/api/integration/files/signed-url', { method: 'POST', body: d }),

  // 行政后勤（宿舍 / 饭卡 / 证照印章 / 安全巡检）
  facilityStats: () => req('/api/facility/stats'),
  dormRooms: () => req('/api/facility/dorm/rooms'),
  createDormRoom: (d) => req('/api/facility/dorm/rooms', { method: 'POST', body: d }),
  updateDormRoom: (id, d) => req('/api/facility/dorm/rooms/' + id, { method: 'PUT', body: d }),
  setDormBedStatus: (id, d) => req(`/api/facility/dorm/beds/${id}/status`, { method: 'POST', body: d }),
  dormStays: (params) => req('/api/facility/dorm/stays' + qs(params)),
  dormCheckin: (d) => req('/api/facility/dorm/checkin', { method: 'POST', body: d }),
  dormCheckout: (id, d) => req(`/api/facility/dorm/checkout/${id}`, { method: 'POST', body: d || {} }),
  dormTransfer: (d) => req('/api/facility/dorm/transfer', { method: 'POST', body: d }),
  dormOccupancy: (month) => req('/api/facility/dorm/occupancy?month=' + (month || '')),
  mealAccounts: (params) => req('/api/facility/meal/accounts' + qs(params)),
  createMealAccount: (d) => req('/api/facility/meal/accounts', { method: 'POST', body: d }),
  mealTransactions: (params) => req('/api/facility/meal/transactions' + qs(params)),
  createMealTx: (d) => req('/api/facility/meal/transactions', { method: 'POST', body: d }),
  mealLost: (id, d) => req(`/api/facility/meal/accounts/${id}/lost`, { method: 'POST', body: d || {} }),
  mealReissue: (id, d) => req(`/api/facility/meal/accounts/${id}/reissue`, { method: 'POST', body: d }),
  mealRecon: (date) => req('/api/facility/meal/recon?date=' + (date || '')),
  certificates: (params) => req('/api/facility/certificates' + qs(params)),
  createCertificate: (d) => req('/api/facility/certificates', { method: 'POST', body: d }),
  updateCertificate: (id, d) => req('/api/facility/certificates/' + id, { method: 'PUT', body: d }),
  voidCertificate: (id, d) => req(`/api/facility/certificates/${id}/void`, { method: 'POST', body: d || {} }),
  seals: () => req('/api/facility/seals'),
  createSeal: (d) => req('/api/facility/seals', { method: 'POST', body: d }),
  sealUsages: (params) => req('/api/facility/seal-usages' + qs(params)),
  createSealUsage: (d) => req('/api/facility/seal-usages', { method: 'POST', body: d }),
  setSealUsageStatus: (id, d) => req(`/api/facility/seal-usages/${id}/status`, { method: 'POST', body: d }),
  safetyChecks: (params) => req('/api/facility/safety-checks' + qs(params)),
  createSafetyCheck: (d) => req('/api/facility/safety-checks', { method: 'POST', body: d }),
  repairs: (params) => req('/api/facility/repairs' + qs(params)),
  createRepair: (d) => req('/api/facility/repairs', { method: 'POST', body: d }),
  setRepairStatus: (id, d) => req(`/api/facility/repairs/${id}/status`, { method: 'POST', body: d }),

  // 人事办理（招聘 / 转调离 / 合同 / 调薪）
  hrStats: () => req('/api/hr/stats'),
  hrRecruitments: (params) => req('/api/hr/recruitments' + qs(params)),
  createHrRecruitment: (d) => req('/api/hr/recruitments', { method: 'POST', body: d }),
  updateHrRecruitment: (id, d) => req('/api/hr/recruitments/' + id, { method: 'PUT', body: d }),
  deleteHrRecruitment: (id) => req('/api/hr/recruitments/' + id, { method: 'DELETE' }),
  hrCandidates: (params) => req('/api/hr/candidates' + qs(params)),
  createHrCandidate: (d) => req('/api/hr/candidates', { method: 'POST', body: d }),
  updateHrCandidate: (id, d) => req('/api/hr/candidates/' + id, { method: 'PUT', body: d }),
  hireHrCandidate: (id, d) => req(`/api/hr/candidates/${id}/hire`, { method: 'POST', body: d || {} }),
  deleteHrCandidate: (id) => req('/api/hr/candidates/' + id, { method: 'DELETE' }),
  hrMovements: (params) => req('/api/hr/movements' + qs(params)),
  createHrMovement: (d) => req('/api/hr/movements', { method: 'POST', body: d }),
  applyHrMovement: (id, d) => req(`/api/hr/movements/${id}/apply`, { method: 'POST', body: d || {} }),
  cancelHrMovement: (id, d) => req(`/api/hr/movements/${id}/cancel`, { method: 'POST', body: d || {} }),
  deleteHrMovement: (id) => req('/api/hr/movements/' + id, { method: 'DELETE' }),
  hrContracts: (params) => req('/api/hr/contracts' + qs(params)),
  createHrContract: (d) => req('/api/hr/contracts', { method: 'POST', body: d }),
  updateHrContract: (id, d) => req('/api/hr/contracts/' + id, { method: 'PUT', body: d }),
  deliverHrContract: (id, d) => req(`/api/hr/contracts/${id}/deliver`, { method: 'POST', body: d || {} }),
  renewHrContract: (id, d) => req(`/api/hr/contracts/${id}/renew`, { method: 'POST', body: d || {} }),
  terminateHrContract: (id, d) => req(`/api/hr/contracts/${id}/terminate`, { method: 'POST', body: d || {} }),
  deleteHrContract: (id) => req('/api/hr/contracts/' + id, { method: 'DELETE' }),
  hrAdjustments: (params) => req('/api/hr/adjustments' + qs(params)),
  createHrAdjustment: (d) => req('/api/hr/adjustments', { method: 'POST', body: d }),
  approveHrAdjustment: (id) => req(`/api/hr/adjustments/${id}/approve`, { method: 'POST' }),
  applyHrAdjustment: (id, d) => req(`/api/hr/adjustments/${id}/apply`, { method: 'POST', body: d || {} }),
  cancelHrAdjustment: (id) => req(`/api/hr/adjustments/${id}/cancel`, { method: 'POST' }),

  // 客户订单与资料确认
  confirmStats: () => req('/api/confirm/stats'),
  seals: (params) => req('/api/confirm/seals' + qs(params)),
  sealGate: (orderId) => req('/api/confirm/seals/gate/' + orderId),
  createSeal: (d) => req('/api/confirm/seals', { method: 'POST', body: d }),
  techApproveSeal: (id) => req(`/api/confirm/seals/${id}/tech-approve`, { method: 'POST' }),
  sendSeal: (id) => req(`/api/confirm/seals/${id}/send`, { method: 'POST' }),
  rejectSeal: (id, d) => req(`/api/confirm/seals/${id}/reject`, { method: 'POST', body: d || {} }),
  deleteSeal: (id) => req('/api/confirm/seals/' + id, { method: 'DELETE' }),
  orderChanges: (params) => req('/api/confirm/changes' + qs(params)),
  createOrderChange: (d) => req('/api/confirm/changes', { method: 'POST', body: d }),
  updateOrderChange: (id, d) => req('/api/confirm/changes/' + id, { method: 'PUT', body: d }),
  approveOrderChange: (id) => req(`/api/confirm/changes/${id}/approve`, { method: 'POST' }),
  signOrderChange: (id) => req(`/api/confirm/changes/${id}/sign`, { method: 'POST' }),
  rejectOrderChange: (id, d) => req(`/api/confirm/changes/${id}/reject`, { method: 'POST', body: d || {} }),
  deliveries: (params) => req('/api/confirm/deliveries' + qs(params)),
  createDeliveryChange: (d) => req('/api/confirm/deliveries', { method: 'POST', body: d }),
  confirmDeliveryChange: (id, d) => req(`/api/confirm/deliveries/${id}/confirm`, { method: 'POST', body: d || {} }),
  shipments: (params) => req('/api/confirm/shipments' + qs(params)),
  createShipmentEvent: (d) => req('/api/confirm/shipments', { method: 'POST', body: d }),
  verifyShipmentEvent: (id) => req(`/api/confirm/shipments/${id}/verify`, { method: 'POST' }),
  deleteShipmentEvent: (id) => req('/api/confirm/shipments/' + id, { method: 'DELETE' }),

  // 零售与渠道
  channelMeta: () => req('/api/channel/meta'),
  channelStats: () => req('/api/channel/stats'),
  channelShops: (params) => req('/api/channel/shops' + qs(params)),
  createChannelShop: (d) => req('/api/channel/shops', { method: 'POST', body: d }),
  updateChannelShop: (id, d) => req('/api/channel/shops/' + id, { method: 'PUT', body: d }),
  verifyChannelShop: (id, d) => req(`/api/channel/shops/${id}/verify`, { method: 'POST', body: d }),
  deleteChannelShop: (id) => req('/api/channel/shops/' + id, { method: 'DELETE' }),
  retailOrders: (params) => req('/api/channel/retail-orders' + qs(params)),
  retailOrder: (id) => req('/api/channel/retail-orders/' + id),
  createRetailOrder: (d) => req('/api/channel/retail-orders', { method: 'POST', body: d }),
  importRetailOrders: (rows) => req('/api/channel/retail-orders/import', { method: 'POST', body: { rows } }),
  checkRetailPay: (id, d) => req(`/api/channel/retail-orders/${id}/check-pay`, { method: 'POST', body: d }),
  reserveRetail: (id) => req(`/api/channel/retail-orders/${id}/reserve`, { method: 'POST' }),
  shipRetail: (id, d) => req(`/api/channel/retail-orders/${id}/ship`, { method: 'POST', body: d || {} }),
  cancelRetail: (id, d) => req(`/api/channel/retail-orders/${id}/cancel`, { method: 'POST', body: d || {} }),
  afterSales: (params) => req('/api/channel/after-sales' + qs(params)),
  createAfterSale: (d) => req('/api/channel/after-sales', { method: 'POST', body: d }),
  confirmRefund: (id, d) => req(`/api/channel/after-sales/${id}/confirm-refund`, { method: 'POST', body: d || {} }),
  receiveReturn: (id, d) => req(`/api/channel/after-sales/${id}/receive-return`, { method: 'POST', body: d || {} }),
  rejectAfterSale: (id, d) => req(`/api/channel/after-sales/${id}/reject`, { method: 'POST', body: d || {} }),
  channelQuotas: (params) => req('/api/channel/quotas' + qs(params)),
  saveChannelQuota: (d) => req('/api/channel/quotas', { method: 'POST', body: d }),
  quotaUsage: (id) => req(`/api/channel/quotas/${id}/usage`),
  syncQuota: (id) => req(`/api/channel/quotas/${id}/sync`, { method: 'POST' }),
  channelSettlements: (params) => req('/api/channel/settlements' + qs(params)),
  channelSettlement: (id) => req('/api/channel/settlements/' + id),
  generateSettlement: (d) => req('/api/channel/settlements/generate', { method: 'POST', body: d }),
  confirmSettlement: (id, d) => req(`/api/channel/settlements/${id}/confirm`, { method: 'POST', body: d }),

  // 质量与合规
  qcStats: () => req('/api/qc/stats'),
  qcStandards: (params) => req('/api/qc/standards' + qs(params)),
  qcStandard: (id) => req('/api/qc/standards/' + id),
  createQcStandard: (d) => req('/api/qc/standards', { method: 'POST', body: d }),
  updateQcStandard: (id, d) => req('/api/qc/standards/' + id, { method: 'PUT', body: d }),
  deleteQcStandard: (id) => req('/api/qc/standards/' + id, { method: 'DELETE' }),
  qcInspections: (params) => req('/api/qc/inspections' + qs(params)),
  qcInspection: (id) => req('/api/qc/inspections/' + id),
  createQcInspection: (d) => req('/api/qc/inspections', { method: 'POST', body: d }),
  updateQcInspection: (id, d) => req('/api/qc/inspections/' + id, { method: 'PUT', body: d }),
  finishQcInspection: (id, d) => req(`/api/qc/inspections/${id}/finish`, { method: 'POST', body: d || {} }),
  deleteQcInspection: (id) => req('/api/qc/inspections/' + id, { method: 'DELETE' }),
  qcIssues: (params) => req('/api/qc/issues' + qs(params)),
  createQcIssue: (d) => req('/api/qc/issues', { method: 'POST', body: d }),
  updateQcIssue: (id, d) => req('/api/qc/issues/' + id, { method: 'PUT', body: d }),
  closeQcIssue: (id, d) => req(`/api/qc/issues/${id}/close`, { method: 'POST', body: d || {} }),
  qcBatches: (params) => req('/api/qc/batches' + qs(params)),
  createQcBatch: (d) => req('/api/qc/batches', { method: 'POST', body: d }),
  updateQcBatch: (id, d) => req('/api/qc/batches/' + id, { method: 'PUT', body: d }),
  qcTrace: (batchNo) => req('/api/qc/batches/' + encodeURIComponent(batchNo) + '/trace'),
  qcRecalls: (params) => req('/api/qc/recalls' + qs(params)),
  createQcRecall: (d) => req('/api/qc/recalls', { method: 'POST', body: d }),
  updateQcRecall: (id, d) => req('/api/qc/recalls/' + id, { method: 'PUT', body: d }),
  notifyQcRecall: (id) => req(`/api/qc/recalls/${id}/notify`, { method: 'POST' }),

  // 客户商城（ERP 后台）
  mallStats: () => req('/api/mall-admin/stats'),
  mallProducts: (params) => req('/api/mall-admin/products' + qs(params)),
  createMallProduct: (d) => req('/api/mall-admin/products', { method: 'POST', body: d }),
  updateMallProduct: (id, d) => req('/api/mall-admin/products/' + id, { method: 'PUT', body: d }),
  setMallProductStatus: (id, status) => req(`/api/mall-admin/products/${id}/status`, { method: 'POST', body: { status } }),
  deleteMallProduct: (id) => req('/api/mall-admin/products/' + id, { method: 'DELETE' }),
  mallPrices: (customerId) => req('/api/mall-admin/prices?customer_id=' + customerId),
  saveMallPrice: (d) => req('/api/mall-admin/prices', { method: 'POST', body: d }),
  deleteMallPrice: (id) => req('/api/mall-admin/prices/' + id, { method: 'DELETE' }),
  mallInquiries: (params) => req('/api/mall-admin/inquiries' + qs(params)),
  mallInquiry: (id) => req('/api/mall-admin/inquiries/' + id),
  quoteMallInquiry: (id, d) => req(`/api/mall-admin/inquiries/${id}/quote`, { method: 'POST', body: d }),
  convertMallInquiry: (id) => req(`/api/mall-admin/inquiries/${id}/convert`, { method: 'POST' }),
  mallAccounts: (customerId) => req('/api/mall-admin/accounts' + qs({ customer_id: customerId })),
  createMallAccount: (d) => req('/api/mall-admin/accounts', { method: 'POST', body: d }),
  updateMallAccount: (id, d) => req('/api/mall-admin/accounts/' + id, { method: 'PUT', body: d }),
  mallNotify: (d) => req('/api/mall-admin/notify', { method: 'POST', body: d }),
  approveMallAccount: (id, d) => req(`/api/mall-admin/accounts/${id}/approve`, { method: 'POST', body: d }),
  mallInvites: (customerId) => req('/api/mall-admin/invites' + qs({ customer_id: customerId })),
  createMallInvite: (d) => req('/api/mall-admin/invites', { method: 'POST', body: d }),
  revokeMallInvite: (id) => req(`/api/mall-admin/invites/${id}/revoke`, { method: 'POST' }),
  mallAccountAudits: (customerId) => req('/api/mall-admin/account-audits' + qs({ customer_id: customerId })),

  // 报表
  statsOrders: () => req('/api/stats/orders'),
  statsProduction: () => req('/api/stats/production'),
  statsStock: () => req('/api/stats/stock'),
  statsShortage: () => req('/api/stats/shortage'),
  statsProfit: (period) => req('/api/stats/profit' + (period ? '?period=' + encodeURIComponent(period) : '')),
  statsCustomers: (period) => req('/api/stats/customers' + (period ? '?period=' + encodeURIComponent(period) : '')),
  statsFactories: () => req('/api/stats/factories'),
  statsReceivables: () => req('/api/stats/receivables'),

  // 系统设置
  settings: () => req('/api/settings'),
  saveSettings: (d) => req('/api/settings', { method: 'PUT', body: d }),

  // 面辅料主数据
  materials: (params) => req('/api/materials' + qs(params)),
  material: (id) => req(`/api/materials/${id}`),
  createMaterial: (d) => req('/api/materials', { method: 'POST', body: d }),
  updateMaterial: (id, d) => req(`/api/materials/${id}`, { method: 'PUT', body: d }),
  duplicateMaterial: (id) => req(`/api/materials/${id}/duplicate`, { method: 'POST' }),
  deleteMaterial: (id) => req(`/api/materials/${id}`, { method: 'DELETE' }),

  // 供应商档案
  suppliers: (params) => req('/api/suppliers' + qs(params)),
  supplier: (id) => req(`/api/suppliers/${id}`),
  createSupplier: (d) => req('/api/suppliers', { method: 'POST', body: d }),
  updateSupplier: (id, d) => req(`/api/suppliers/${id}`, { method: 'PUT', body: d }),
  deleteSupplier: (id) => req(`/api/suppliers/${id}`, { method: 'DELETE' }),

  // 工序类别档案
  craftTypes: (params) => req('/api/craft-types' + qs(params)),
  craftType: (id) => req(`/api/craft-types/${id}`),
  createCraftType: (d) => req('/api/craft-types', { method: 'POST', body: d }),
  updateCraftType: (id, d) => req(`/api/craft-types/${id}`, { method: 'PUT', body: d }),
  deleteCraftType: (id) => req(`/api/craft-types/${id}`, { method: 'DELETE' }),

  // 往来账（应收 / 应付 / 收付款）
  financeSummary: () => req('/api/finance/summary'),
  financeInvoices: (kind, params) => req(`/api/finance/${kind}` + qs(params)),
  financeAging: (kind) => req('/api/finance/aging?kind=' + kind),
  financeOpenInvoices: (kind, partnerId) => req(`/api/finance/open-invoices?kind=${kind}&partner_id=${partnerId || ''}`),
  createInvoice: (kind, d) => req(`/api/finance/${kind}`, { method: 'POST', body: d }),
  voidInvoice: (kind, id, reason) => req(`/api/finance/${kind}/${id}/void`, { method: 'POST', body: { reason } }),
  financePayments: (params) => req('/api/finance/payments' + qs(params)),
  createPayment: (d) => req('/api/finance/payments', { method: 'POST', body: d }),
  reversePayment: (id, reason) => req(`/api/finance/payments/${id}/reverse`, { method: 'POST', body: { reason } }),

  // 成本与毛利（一单一成本对象）
  costingOverview: () => req('/api/costing/overview'),
  costingOrders: (params) => req('/api/costing/orders' + qs(params)),
  costingOrder: (orderId) => req(`/api/costing/orders/${orderId}`),
  collectCosting: (orderId) => req(`/api/costing/orders/${orderId}/collect`, { method: 'POST' }),
  snapshotCosting: (orderId) => req(`/api/costing/orders/${orderId}/snapshot`, { method: 'POST' }),
  addCostEntry: (d) => req('/api/costing/entries', { method: 'POST', body: d }),
  deleteCostEntry: (id) => req(`/api/costing/entries/${id}`, { method: 'DELETE' }),

  // 接单评审与交期承诺
  commitmentBoard: (params) => req('/api/commitments/board' + qs(params)),
  commitmentByOrder: (orderId) => req(`/api/commitments/order/${orderId}`),
  commitmentCapacity: (orderId) => req('/api/commitments/capacity' + (orderId ? '?order_id=' + orderId : '')),
  reviewCommitment: (id, d) => req(`/api/commitments/${id}/review`, { method: 'POST', body: d }),
  updateCommitmentNode: (id, nodeId, d) => req(`/api/commitments/${id}/nodes/${nodeId}`, { method: 'POST', body: d }),
  reforecastCommitment: (id) => req(`/api/commitments/${id}/reforecast`, { method: 'POST' }),
  commitmentNodeDefs: () => req('/api/commitments/node-defs'),

  // 齐套与缺料
  requirementBoard: (params) => req('/api/requirements/board' + qs(params)),
  requirementLines: (params) => req('/api/requirements/lines' + qs(params)),
  requirementOrder: (orderId) => req(`/api/requirements/order/${orderId}`),
  requirementShortage: () => req('/api/requirements/shortage'),
  calcRequirements: () => req('/api/requirements/calc', { method: 'POST' }),
  setRequirementAction: (id, d) => req(`/api/requirements/${id}/action`, { method: 'POST', body: d }),

  // 裁床与扎包
  cutBoard: (params) => req('/api/cuts/board' + qs(params)),
  cutByOrder: (orderId) => req(`/api/cuts/order/${orderId}`),
  startCut: (id) => req(`/api/cuts/${id}/start`, { method: 'POST', body: { fabric_ready: true } }),
  saveCutLot: (id, d) => req(`/api/cuts/${id}/lots`, { method: 'POST', body: d }),
  deleteCutLot: (id, lotId) => req(`/api/cuts/${id}/lots/${lotId}`, { method: 'DELETE' }),
  generateCutBundles: (id, d) => req(`/api/cuts/${id}/bundles/generate`, { method: 'POST', body: d }),
  saveCutBundle: (id, d) => req(`/api/cuts/${id}/bundles`, { method: 'POST', body: d }),
  deleteCutBundle: (id, bid) => req(`/api/cuts/${id}/bundles/${bid}`, { method: 'DELETE' }),
  finishCut: (id, d) => req(`/api/cuts/${id}/finish`, { method: 'POST', body: d }),
  handoverCut: (id) => req(`/api/cuts/${id}/handover`, { method: 'POST' }),

  // 首件确认与工位工艺
  faBoard: (params) => req('/api/first-articles/board' + qs(params)),
  faByOrder: (orderId) => req(`/api/first-articles/order/${orderId}`),
  faGate: (orderId) => req(`/api/first-articles/gate/${orderId}`),
  faDetail: (id) => req(`/api/first-articles/${id}`),
  createFa: (d) => req('/api/first-articles', { method: 'POST', body: d }),
  saveFa: (id, d) => req(`/api/first-articles/${id}`, { method: 'PUT', body: d }),
  generateFaChecks: (id, d) => req(`/api/first-articles/${id}/checks/generate`, { method: 'POST', body: d || {} }),
  saveFaCheck: (id, d) => req(`/api/first-articles/${id}/checks`, { method: 'POST', body: d }),
  deleteFaCheck: (id, cid) => req(`/api/first-articles/${id}/checks/${cid}`, { method: 'DELETE' }),
  submitFa: (id) => req(`/api/first-articles/${id}/submit`, { method: 'POST' }),
  releaseFa: (id, d) => req(`/api/first-articles/${id}/release`, { method: 'POST', body: d }),
  rejectFa: (id, d) => req(`/api/first-articles/${id}/reject`, { method: 'POST', body: d }),
  reopenFa: (id) => req(`/api/first-articles/${id}/reopen`, { method: 'POST' }),
  refreshFaVersion: (id) => req(`/api/first-articles/${id}/refresh-version`, { method: 'POST' }),
  faWorkstations: (orderId) => req('/api/first-articles/workstations?order_id=' + orderId),
  generateWorkstations: (orderId) => req('/api/first-articles/workstations/generate', { method: 'POST', body: { order_id: orderId } }),
  saveWorkstation: (d) => req('/api/first-articles/workstations', { method: 'POST', body: d }),
  deleteWorkstation: (id) => req(`/api/first-articles/workstations/${id}`, { method: 'DELETE' }),

  // 打版流程
  patternBoard: () => req('/api/pattern-flows/board'),
  patternByTechpack: (tpId) => req(`/api/pattern-flows/by-techpack/${tpId}`),
  ensurePatternFlow: (tech_pack_id) => req('/api/pattern-flows/ensure', { method: 'POST', body: { tech_pack_id } }),
  savePatternStage: (flowId, stage, d) => req(`/api/pattern-flows/${flowId}/stage/${stage}`, { method: 'PUT', body: d }),
  donePatternStage: (flowId, stage) => req(`/api/pattern-flows/${flowId}/stage/${stage}/done`, { method: 'POST' }),
  reopenPatternStage: (flowId, stage) => req(`/api/pattern-flows/${flowId}/stage/${stage}/reopen`, { method: 'POST' }),
  finishPatternFlow: (flowId) => req(`/api/pattern-flows/${flowId}/finish`, { method: 'POST' }),
  patternMaterials: (flowId) => req(`/api/pattern-flows/${flowId}/materials`),
  savePatternMaterials: (flowId, materials) => req(`/api/pattern-flows/${flowId}/materials`, { method: 'PUT', body: { materials } }),

  // 样衣档案
  sampleArchives: (params) => req('/api/sample-archives' + qs(params)),
  sampleArchive: (id) => req(`/api/sample-archives/${id}`),
  requestSampleChange: (id, d) => req(`/api/sample-archives/${id}/change-request`, { method: 'POST', body: d }),
  sampleChanges: (params) => req('/api/sample-archives/changes' + qs(params)),
  reviewSampleChange: (id, d) => req(`/api/sample-archives/changes/${id}/review`, { method: 'POST', body: d }),

  // 用户
  users: () => req('/api/users'),
  createUser: (d) => req('/api/users', { method: 'POST', body: d }),
  updateUser: (id, d) => req(`/api/users/${id}`, { method: 'PUT', body: d }),

  // 业务蓝图（原脑图）
  blueprint: () => req('/api/mindmap'),
  saveBlueprint: (data) => req('/api/mindmap', { method: 'PUT', body: { data } }),

  // CSV 批量导入（kind: customers | products | materials）
  importCsv: (kind, csv) => req('/api/import/' + kind, { method: 'POST', body: { csv } }),
  importTemplate: (kind) => blob('/api/import/template/' + kind),

  // 阶梯报价
  priceTiers: (productId) => req('/api/price-tiers?product_id=' + productId),
  priceTierLookup: (productId, qty) =>
    req(`/api/price-tiers/lookup?product_id=${productId}&qty=${qty}`),
  savePriceTiers: (productId, tiers) =>
    req('/api/price-tiers', { method: 'POST', body: { product_id: productId, tiers } }),

  // 报价单
  quotations: (params) => req('/api/quotations' + qs(params)),
  quotationMeta: () => req('/api/quotations/meta'),
  quotation: (id) => req('/api/quotations/' + id),
  createQuotation: (d) => req('/api/quotations', { method: 'POST', body: d }),
  updateQuotation: (id, d) => req('/api/quotations/' + id, { method: 'PUT', body: d }),
  setQuotationStatus: (id, status) =>
    req(`/api/quotations/${id}/status`, { method: 'POST', body: { status } }),
  repriceQuotation: (id) => req(`/api/quotations/${id}/reprice`, { method: 'POST' }),
  convertQuotation: (id, d) => req(`/api/quotations/${id}/convert`, { method: 'POST', body: d || {} }),
  deleteQuotation: (id) => req('/api/quotations/' + id, { method: 'DELETE' }),

  // 薪酬核算
  payrolls: (params) => req('/api/payrolls' + qs(params)),
  payrollPeriods: () => req('/api/payrolls/periods'),
  payrollSummary: (period) => req('/api/payrolls/summary?period=' + encodeURIComponent(period)),
  generatePayrolls: (period, overwrite = false) =>
    req('/api/payrolls/generate', { method: 'POST', body: { period, overwrite } }),
  updatePayroll: (id, d) => req('/api/payrolls/' + id, { method: 'PUT', body: d }),
  confirmPayroll: (id) => req(`/api/payrolls/${id}/confirm`, { method: 'POST' }),
  payPayroll: (id) => req(`/api/payrolls/${id}/pay`, { method: 'POST' }),
  batchPayroll: (action, ids) => req('/api/payrolls/batch', { method: 'POST', body: { action, ids } }),
  deletePayroll: (id) => req('/api/payrolls/' + id, { method: 'DELETE' }),

  // 固定资产
  assets: (params) => req('/api/assets' + qs(params)),
  assetSummary: () => req('/api/assets/summary'),
  createAsset: (d) => req('/api/assets', { method: 'POST', body: d }),
  updateAsset: (id, d) => req('/api/assets/' + id, { method: 'PUT', body: d }),
  setAssetStatus: (id, status) => req(`/api/assets/${id}/status`, { method: 'POST', body: { status } }),
  deleteAsset: (id) => req('/api/assets/' + id, { method: 'DELETE' }),

  // 行政费用
  adminExpenses: (params) => req('/api/admin-expenses' + qs(params)),
  adminExpenseMeta: () => req('/api/admin-expenses/meta'),
  adminExpenseSummary: (params) => req('/api/admin-expenses/summary' + qs(params)),
  createAdminExpense: (d) => req('/api/admin-expenses', { method: 'POST', body: d }),
  updateAdminExpense: (id, d) => req('/api/admin-expenses/' + id, { method: 'PUT', body: d }),
  deleteAdminExpense: (id) => req('/api/admin-expenses/' + id, { method: 'DELETE' }),

  // 数据质量与业务勾稽
  dqRules: () => req('/api/dq/rules'),
  dqToggleRule: (code, enabled) => req(`/api/dq/rules/${code}`, { method: 'PUT', body: { enabled } }),
  dqRun: (body) => req('/api/dq/run', { method: 'POST', body: body || {} }),
  dqSummary: () => req('/api/dq/summary'),
  dqIssues: (params) => req('/api/dq/issues' + qs(params)),
  dqRuns: (params) => req('/api/dq/runs' + qs(params)),
  dqRunDetail: (id) => req(`/api/dq/runs/${id}`),
  dqFixIssue: (id) => req(`/api/dq/issues/${id}/fix`, { method: 'POST' }),
  dqFixAll: (runId) => req(`/api/dq/runs/${runId}/fix-all`, { method: 'POST' }),
  dqIgnoreIssue: (id, d) => req(`/api/dq/issues/${id}/ignore`, { method: 'POST', body: d }),
  dqReopenIssue: (id) => req(`/api/dq/issues/${id}/reopen`, { method: 'POST' }),
  dqFixes: (params) => req('/api/dq/fixes' + qs(params)),
  dqReconcile: (params) => req('/api/dq/reconcile' + qs(params)),

  // 海外仓作业（到仓上架 / 套装拆组 / 运费核对）
  whDict: () => req('/api/wh/dict'),
  whBoard: (params) => req('/api/wh/board' + qs(params)),
  whLocations: (params) => req('/api/wh/locations' + qs(params)),
  whCreateLocation: (d) => req('/api/wh/locations', { method: 'POST', body: d }),
  whUpdateLocation: (id, d) => req(`/api/wh/locations/${id}`, { method: 'PUT', body: d }),
  whAsns: (params) => req('/api/wh/asns' + qs(params)),
  whAsn: (id) => req(`/api/wh/asns/${id}`),
  whCreateAsn: (d) => req('/api/wh/asns', { method: 'POST', body: d }),
  whShipAsn: (id, d) => req(`/api/wh/asns/${id}/ship`, { method: 'POST', body: d || {} }),
  whArriveAsn: (id, d) => req(`/api/wh/asns/${id}/arrive`, { method: 'POST', body: d || {} }),
  whCancelAsn: (id, d) => req(`/api/wh/asns/${id}/cancel`, { method: 'POST', body: d }),
  whReceiveAsn: (id, d) => req(`/api/wh/asns/${id}/receive`, { method: 'POST', body: d }),
  whReceipts: (params) => req('/api/wh/receipts' + qs(params)),
  whReceipt: (id) => req(`/api/wh/receipts/${id}`),
  whPutaway: (id, d) => req(`/api/wh/receipts/${id}/putaway`, { method: 'POST', body: d }),
  whBundles: (params) => req('/api/wh/bundles' + qs(params)),
  whCreateBundle: (d) => req('/api/wh/bundles', { method: 'POST', body: d }),
  whUpdateBundle: (id, d) => req(`/api/wh/bundles/${id}`, { method: 'PUT', body: d }),
  whKit: (id, d) => req(`/api/wh/bundles/${id}/kit`, { method: 'POST', body: d }),
  whUnbundle: (id, d) => req(`/api/wh/bundles/${id}/unbundle`, { method: 'POST', body: d }),
  whBundleOps: (params) => req('/api/wh/bundle-ops' + qs(params)),
  whRates: () => req('/api/wh/freight/rates'),
  whCreateRate: (d) => req('/api/wh/freight/rates', { method: 'POST', body: d }),
  whBills: (params) => req('/api/wh/freight/bills' + qs(params)),
  whBill: (id) => req(`/api/wh/freight/bills/${id}`),
  whCreateBill: (d) => req('/api/wh/freight/bills', { method: 'POST', body: d }),
  whMatchBill: (id, d) => req(`/api/wh/freight/bills/${id}/match`, { method: 'POST', body: d || {} }),
  whResolveFreight: (id, d) => req(`/api/wh/freight/items/${id}/resolve`, { method: 'POST', body: d }),
  whSettleBill: (id) => req(`/api/wh/freight/bills/${id}/settle`, { method: 'POST' }),

  // 总账与财务报表
  glPeriods: () => req('/api/gl/periods'),
  glCreatePeriod: (period) => req('/api/gl/periods', { method: 'POST', body: { period } }),
  glAccounts: () => req('/api/gl/accounts'),
  glVouchers: (params) => req('/api/gl/vouchers' + qs(params)),
  glVoucher: (id) => req(`/api/gl/vouchers/${id}`),
  glCreateVoucher: (d) => req('/api/gl/vouchers', { method: 'POST', body: d }),
  glVoidVoucher: (id, d) => req(`/api/gl/vouchers/${id}/void`, { method: 'POST', body: d }),
  glGenerate: (period, d) => req(`/api/gl/periods/${period}/generate`, { method: 'POST', body: d || {} }),
  glCarry: (period) => req(`/api/gl/periods/${period}/carry`, { method: 'POST', body: {} }),
  glChecks: (period) => req(`/api/gl/periods/${period}/checks`),
  glClose: (period) => req(`/api/gl/periods/${period}/close`, { method: 'POST', body: {} }),
  glReopen: (period, d) => req(`/api/gl/periods/${period}/reopen`, { method: 'POST', body: d }),
  glReport: (type, period) => req(`/api/gl/reports/${type}` + qs({ period })),
  glOverview: (period) => req('/api/gl/overview' + qs({ period })),

  // 现货库龄与退货
  spotDict: () => req('/api/spot/dict'),
  spotOverview: (params) => req('/api/spot/overview' + qs(params)),
  spotAging: (params) => req('/api/spot/aging' + qs(params)),
  spotTurnover: (params) => req('/api/spot/turnover' + qs(params)),
  spotSlowMoving: (params) => req('/api/spot/slow-moving' + qs(params)),
  spotReturns: (params) => req('/api/spot/returns' + qs(params)),
  spotReturn: (id) => req(`/api/spot/returns/${id}`),
  createSpotReturn: (d) => req('/api/spot/returns', { method: 'POST', body: d }),
  receiveSpotReturn: (id, d) => req(`/api/spot/returns/${id}/receive`, { method: 'POST', body: d }),
  inspectSpotReturn: (id, d) => req(`/api/spot/returns/${id}/inspect`, { method: 'POST', body: d }),
  closeSpotReturn: (id) => req(`/api/spot/returns/${id}/close`, { method: 'POST', body: {} }),
  cancelSpotReturn: (id, d) => req(`/api/spot/returns/${id}/cancel`, { method: 'POST', body: d }),

  // AI 能力中心
  aiOverview: () => req('/api/ai/overview'),
  aiGateway: () => req('/api/ai/gateway'),
  aiCreateProvider: (d) => req('/api/ai/gateway', { method: 'POST', body: d }),
  aiUpdateProvider: (id, d) => req(`/api/ai/gateway/${id}`, { method: 'PUT', body: d }),
  aiTestProvider: (id) => req(`/api/ai/gateway/${id}/test`, { method: 'POST', body: {} }),
  aiCalls: (params) => req('/api/ai/calls' + qs(params)),
  aiAsk: (message) => req('/api/ai/ask', { method: 'POST', body: { message } }),
  aiExtract: (d) => req('/api/ai/extract', { method: 'POST', body: d }),
  aiReply: (d) => req('/api/ai/reply', { method: 'POST', body: d }),
  aiDrafts: (params) => req('/api/ai/drafts' + qs(params)),
  aiDraft: (id) => req(`/api/ai/drafts/${id}`),
  aiApproveDraft: (id, d) => req(`/api/ai/drafts/${id}/approve`, { method: 'POST', body: d }),
  aiRejectDraft: (id, d) => req(`/api/ai/drafts/${id}/reject`, { method: 'POST', body: d }),
  aiAnomalies: (params) => req('/api/ai/anomalies' + qs(params)),
  aiExplain: (d) => req('/api/ai/explain', { method: 'POST', body: d }),
  aiRiskRun: () => req('/api/ai/risk/run', { method: 'POST', body: {} }),
  aiRisk: (params) => req('/api/ai/risk' + qs(params)),
  aiAckRisk: (id, d) => req(`/api/ai/risk/${id}/ack`, { method: 'POST', body: d || {} }),
  aiGenWeekly: (d) => req('/api/ai/weekly/generate', { method: 'POST', body: d }),
  aiWeekly: (params) => req('/api/ai/weekly' + qs(params)),
  aiWeeklyDetail: (id) => req(`/api/ai/weekly/${id}`),
  aiPublishWeekly: (id) => req(`/api/ai/weekly/${id}/publish`, { method: 'POST', body: {} }),
  aiFaq: (params) => req('/api/ai/faq' + qs(params)),
  aiCreateFaq: (d) => req('/api/ai/faq', { method: 'POST', body: d }),
  aiUpdateFaq: (id, d) => req(`/api/ai/faq/${id}`, { method: 'PUT', body: d }),
  aiHandovers: (params) => req('/api/ai/handovers' + qs(params)),
  aiCreateHandover: (d) => req('/api/ai/handovers', { method: 'POST', body: d }),
  aiTakeHandover: (id) => req(`/api/ai/handovers/${id}/take`, { method: 'POST', body: {} }),
  aiCloseHandover: (id, d) => req(`/api/ai/handovers/${id}/close`, { method: 'POST', body: d }),
  aiEvalCases: () => req('/api/ai/evals/cases'),
  aiEvalRun: (d) => req('/api/ai/evals/run', { method: 'POST', body: d || {} }),
  aiEvalRuns: (params) => req('/api/ai/evals/runs' + qs(params)),
  aiEvalRunDetail: (id) => req(`/api/ai/evals/runs/${id}`),

  // 预算管理
  budgetDict: () => req('/api/budget/dict'),
  budgetOverview: (params) => req('/api/budget/overview' + qs(params)),
  budgetList: (params) => req('/api/budget/list' + qs(params)),
  budgetDetail: (id) => req(`/api/budget/${id}`),
  createBudget: (d) => req('/api/budget', { method: 'POST', body: d }),
  updateBudget: (id, d) => req(`/api/budget/${id}`, { method: 'PUT', body: d }),
  approveBudget: (id) => req(`/api/budget/${id}/approve`, { method: 'POST', body: {} }),
  rejectBudget: (id, d) => req(`/api/budget/${id}/reject`, { method: 'POST', body: d }),
  activateBudget: (id) => req(`/api/budget/${id}/activate`, { method: 'POST', body: {} }),
  closeBudget: (id) => req(`/api/budget/${id}/close`, { method: 'POST', body: {} }),
  deleteBudget: (id) => req(`/api/budget/${id}`, { method: 'DELETE' }),
  budgetExecution: (params) => req('/api/budget/execution' + qs(params)),
  budgetAdjustments: (params) => req('/api/budget/adjustments/list' + qs(params)),
  createBudgetAdjustment: (d) => req('/api/budget/adjustments', { method: 'POST', body: d }),
  approveAdjustment: (id) => req(`/api/budget/adjustments/${id}/approve`, { method: 'POST', body: {} }),
  rejectAdjustment: (id, d) => req(`/api/budget/adjustments/${id}/reject`, { method: 'POST', body: d }),
  budgetCommitments: (params) => req('/api/budget/commitments' + qs(params)),
  budgetAlerts: (params) => req('/api/budget/alerts' + qs(params)),
  ackBudgetAlert: (id, d) => req(`/api/budget/alerts/${id}/ack`, { method: 'POST', body: d }),
  budgetCheck: (d) => req('/api/budget/check', { method: 'POST', body: d }),

  // 税票银行与结算
  bankDict: () => req('/api/bank/dict'),
  bankOverview: () => req('/api/bank/overview'),
  bankAccounts: () => req('/api/bank/accounts'),
  createBankAccount: (d) => req('/api/bank/accounts', { method: 'POST', body: d }),
  updateBankAccount: (id, d) => req(`/api/bank/accounts/${id}`, { method: 'PUT', body: d }),
  bankImports: () => req('/api/bank/imports'),
  bankImport: (d) => req('/api/bank/import', { method: 'POST', body: d }),
  bankLines: (params) => req('/api/bank/lines' + qs(params)),
  bankCandidates: (lineId, params) => req(`/api/bank/lines/${lineId}/candidates` + qs(params)),
  bankMatch: (lineId, d) => req(`/api/bank/lines/${lineId}/match`, { method: 'POST', body: d }),
  bankUnmatch: (lineId) => req(`/api/bank/lines/${lineId}/unmatch`, { method: 'POST', body: {} }),
  bankIgnoreLine: (lineId, d) => req(`/api/bank/lines/${lineId}/ignore`, { method: 'POST', body: d }),
  bankAutoMatch: (d) => req('/api/bank/auto-match', { method: 'POST', body: d }),
  bankPreview: (params) => req('/api/bank/reconcile/preview' + qs(params)),
  bankRecons: () => req('/api/bank/reconciliations'),
  bankRecon: (id) => req(`/api/bank/reconciliations/${id}`),
  createBankRecon: (d) => req('/api/bank/reconciliations', { method: 'POST', body: d }),
  confirmBankRecon: (id) => req(`/api/bank/reconciliations/${id}/confirm`, { method: 'POST', body: {} }),
  bankBills: (params) => req('/api/bank/bills' + qs(params)),
  createBankBill: (d) => req('/api/bank/bills', { method: 'POST', body: d }),
  setBankBillStatus: (id, d) => req(`/api/bank/bills/${id}/status`, { method: 'PUT', body: d }),

  // 多主体核算与集团合并
  groupDict: () => req('/api/group/dict'),
  groupOverview: () => req('/api/group/overview'),
  groupCompanies: (params) => req('/api/group/companies' + qs(params)),
  groupCompany: (id) => req(`/api/group/companies/${id}`),
  createGroupCompany: (d) => req('/api/group/companies', { method: 'POST', body: d }),
  updateGroupCompany: (id, d) => req(`/api/group/companies/${id}`, { method: 'PUT', body: d }),
  groupParties: (params) => req('/api/group/parties' + qs(params)),
  createGroupParty: (d) => req('/api/group/parties', { method: 'POST', body: d }),
  updateGroupParty: (id, d) => req(`/api/group/parties/${id}`, { method: 'PUT', body: d }),
  groupIntercompany: (params) => req('/api/group/intercompany' + qs(params)),
  groupScanIc: (d) => req('/api/group/intercompany/scan', { method: 'POST', body: d }),
  groupIgnoreIc: (id, d) => req(`/api/group/intercompany/${id}/ignore`, { method: 'POST', body: d }),
  groupConsolidations: (params) => req('/api/group/consolidations' + qs(params)),
  groupConsolidation: (id) => req(`/api/group/consolidations/${id}`),
  createGroupConsolidation: (d) => req('/api/group/consolidations', { method: 'POST', body: d }),
  confirmGroupConsolidation: (id) => req(`/api/group/consolidations/${id}/confirm`, { method: 'POST', body: {} }),
  deleteGroupConsolidation: (id) => req(`/api/group/consolidations/${id}`, { method: 'DELETE' }),
  groupSegments: (params) => req('/api/group/segments' + qs(params)),

  // 经营驾驶舱
  cockpitDict: () => req('/api/cockpit/dict'),
  cockpitOverview: (params) => req('/api/cockpit/overview' + qs(params)),
  cockpitAging: (params) => req('/api/cockpit/aging' + qs(params)),
  cockpitForecasts: (params) => req('/api/cockpit/forecasts' + qs(params)),
  cockpitForecast: (id) => req(`/api/cockpit/forecasts/${id}`),
  createForecast: (d) => req('/api/cockpit/forecasts', { method: 'POST', body: d }),
  forecastVariance: (id) => req(`/api/cockpit/forecasts/${id}/variance`),
  cockpitKpis: (params) => req('/api/cockpit/kpis' + qs(params)),
  snapshotKpis: (d) => req('/api/cockpit/kpis/snapshot', { method: 'POST', body: d }),
  cockpitTrend: (params) => req('/api/cockpit/trend' + qs(params)),

  // 营销与素材（M16）
  mktDict: () => req('/api/mkt/dict'),
  mktOverview: () => req('/api/mkt/overview'),
  mktTasks: (params) => req('/api/mkt/tasks' + qs(params)),
  mktCalendar: (month) => req('/api/mkt/calendar' + qs({ month })),
  mktTask: (id) => req(`/api/mkt/tasks/${id}`),
  createMktTask: (d) => req('/api/mkt/tasks', { method: 'POST', body: d }),
  updateMktTask: (id, d) => req(`/api/mkt/tasks/${id}`, { method: 'PUT', body: d }),
  mktTaskStatus: (id, d) => req(`/api/mkt/tasks/${id}/status`, { method: 'POST', body: d }),
  deleteMktTask: (id) => req(`/api/mkt/tasks/${id}`, { method: 'DELETE' }),
  addMktStep: (id, d) => req(`/api/mkt/tasks/${id}/steps`, { method: 'POST', body: d }),
  setMktStep: (id, sid, d) => req(`/api/mkt/tasks/${id}/steps/${sid}`, { method: 'POST', body: d }),
  bindMktAsset: (id, d) => req(`/api/mkt/tasks/${id}/assets`, { method: 'POST', body: d }),
  unbindMktAsset: (id, aid) => req(`/api/mkt/tasks/${id}/assets/${aid}`, { method: 'DELETE' }),
  mktAssets: (params) => req('/api/mkt/assets' + qs(params)),
  mktAsset: (id) => req(`/api/mkt/assets/${id}`),
  createMktAsset: (d) => req('/api/mkt/assets', { method: 'POST', body: d }),
  updateMktAsset: (id, d) => req(`/api/mkt/assets/${id}`, { method: 'PUT', body: d }),
  submitMktAsset: (id) => req(`/api/mkt/assets/${id}/submit`, { method: 'POST', body: {} }),
  reviewMktAsset: (id, d) => req(`/api/mkt/assets/${id}/review`, { method: 'POST', body: d }),
  revokeMktAsset: (id, d) => req(`/api/mkt/assets/${id}/revoke`, { method: 'POST', body: d }),
  sweepMktAssets: () => req('/api/mkt/assets/sweep-expired', { method: 'POST', body: {} }),
  mktCampaigns: (params) => req('/api/mkt/campaigns' + qs(params)),
  mktCampaign: (id) => req(`/api/mkt/campaigns/${id}`),
  createMktCampaign: (d) => req('/api/mkt/campaigns', { method: 'POST', body: d }),
  updateMktCampaign: (id, d) => req(`/api/mkt/campaigns/${id}`, { method: 'PUT', body: d }),
  approveMktCampaign: (id, d) => req(`/api/mkt/campaigns/${id}/approve`, { method: 'POST', body: d }),
  mktCampaignStatus: (id, d) => req(`/api/mkt/campaigns/${id}/status`, { method: 'POST', body: d }),
  addMktBill: (id, d) => req(`/api/mkt/campaigns/${id}/bills`, { method: 'POST', body: d }),
  mktAttribution: (id) => req(`/api/mkt/campaigns/${id}/attribution`),
  mktReviews: (params) => req('/api/mkt/reviews' + qs(params)),
  mktReview: (id) => req(`/api/mkt/reviews/${id}`),
  createMktReview: (d) => req('/api/mkt/reviews', { method: 'POST', body: d }),
  addMktAction: (id, d) => req(`/api/mkt/reviews/${id}/actions`, { method: 'POST', body: d }),
  setMktAction: (id, aid, d) => req(`/api/mkt/reviews/${id}/actions/${aid}`, { method: 'POST', body: d }),
  mktReviewStatus: (id, d) => req(`/api/mkt/reviews/${id}/status`, { method: 'POST', body: d }),
  mktReportLaunch: (params) => req('/api/mkt/reports/launch' + qs(params)),
  mktReportCampaign: () => req('/api/mkt/reports/campaign'),
  mktReportReview: () => req('/api/mkt/reports/review'),

  // 制度问答（M17 N17-02：答案带制度原文版本与日期）
  aiPolicyRecent: (params) => req('/api/ai/policy/recent' + qs(params)),
  aiPolicySearch: (q) => req('/api/ai/policy/search' + qs({ q })),
  aiPolicyAsk: (d) => req('/api/ai/policy/ask', { method: 'POST', body: d }),
  aiPolicyHits: (params) => req('/api/ai/policy/hits' + qs(params)),
  aiPolicyDoc: (docNo) => req('/api/ai/policy/doc/' + docNo),

  // 组织编制与岗位管理（M02）
  orgDict: () => req('/api/org/dict'),
  orgOverview: () => req('/api/org/overview'),
  orgMyScope: () => req('/api/org/my-scope'),
  orgPositions: (params) => req('/api/org/positions' + qs(params)),
  orgPositionTree: (params) => req('/api/org/positions/tree' + qs(params)),
  orgPosition: (id) => req(`/api/org/positions/${id}`),
  createOrgPosition: (d) => req('/api/org/positions', { method: 'POST', body: d }),
  updateOrgPosition: (id, d) => req(`/api/org/positions/${id}`, { method: 'PUT', body: d }),
  orgEmployments: (params) => req('/api/org/employments' + qs(params)),
  orgEmployment: (id) => req(`/api/org/employments/${id}`),
  createOrgEmployment: (d) => req('/api/org/employments', { method: 'POST', body: d }),
  orgTransfer: (employeeId, d) => req(`/api/org/employees/${employeeId}/transfer`, { method: 'POST', body: d }),
  submitOrgEmployment: (id) => req(`/api/org/employments/${id}/submit`, { method: 'POST', body: {} }),
  approveOrgEmployment: (id, d) => req(`/api/org/employments/${id}/approve`, { method: 'POST', body: d }),
  rejectOrgEmployment: (id, d) => req(`/api/org/employments/${id}/reject`, { method: 'POST', body: d }),
  endOrgEmployment: (id, d) => req(`/api/org/employments/${id}/end`, { method: 'POST', body: d }),
  orgRoutes: (params) => req('/api/org/routes' + qs(params)),
  orgRoute: (id) => req(`/api/org/routes/${id}`),
  createOrgRoute: (d) => req('/api/org/routes', { method: 'POST', body: d }),
  updateOrgRoute: (id, d) => req(`/api/org/routes/${id}`, { method: 'PUT', body: d }),
  confirmOrgRoute: (id, d) => req(`/api/org/routes/${id}/confirm`, { method: 'POST', body: d }),
  orgRouteStatus: (id, d) => req(`/api/org/routes/${id}/status`, { method: 'POST', body: d }),
  orgScopes: (params) => req('/api/org/scopes' + qs(params)),
  orgScope: (id) => req(`/api/org/scopes/${id}`),
  createOrgScope: (d) => req('/api/org/scopes', { method: 'POST', body: d }),
  submitOrgScope: (id) => req(`/api/org/scopes/${id}/submit`, { method: 'POST', body: {} }),
  approveOrgScope: (id, d) => req(`/api/org/scopes/${id}/approve`, { method: 'POST', body: d }),
  rejectOrgScope: (id, d) => req(`/api/org/scopes/${id}/reject`, { method: 'POST', body: d }),
  renewOrgScope: (id, d) => req(`/api/org/scopes/${id}/renew`, { method: 'POST', body: d }),
  sweepOrgScopes: () => req('/api/org/scopes/sweep', { method: 'POST', body: {} }),

  // 税负测算（M12）
  taxDict: () => req('/api/tax/dict'),
  taxOverview: () => req('/api/tax/overview'),
  taxPolicies: (params) => req('/api/tax/policies' + qs(params)),
  createTaxPolicy: (d) => req('/api/tax/policies', { method: 'POST', body: d }),
  taxPreview: (params) => req('/api/tax/preview' + qs(params)),
  taxRuns: (params) => req('/api/tax/runs' + qs(params)),
  taxRun: (id) => req(`/api/tax/runs/${id}`),
  saveTaxRun: (d) => req('/api/tax/runs', { method: 'POST', body: d }),
  confirmTaxRun: (id, d) => req(`/api/tax/runs/${id}/confirm`, { method: 'POST', body: d }),
  voidTaxRun: (id, d) => req(`/api/tax/runs/${id}/void`, { method: 'POST', body: d }),
  taxTrend: (params) => req('/api/tax/trend' + qs(params)),

  // 销售与客户（M03：线索商机/周期预警/价值排行/目标提成/客户交接）
  crmDict: () => req('/api/crm/dict'),
  crmOverview: () => req('/api/crm/overview'),
  crmLeads: (params) => req('/api/crm/leads' + qs(params)),
  crmLead: (id) => req(`/api/crm/leads/${id}`),
  createCrmLead: (d) => req('/api/crm/leads', { method: 'POST', body: d }),
  updateCrmLead: (id, d) => req(`/api/crm/leads/${id}`, { method: 'PUT', body: d }),
  assignCrmLead: (id, d) => req(`/api/crm/leads/${id}/assign`, { method: 'POST', body: d }),
  claimCrmLead: (id) => req(`/api/crm/leads/${id}/claim`, { method: 'POST', body: {} }),
  recycleCrmLead: (id, d) => req(`/api/crm/leads/${id}/recycle`, { method: 'POST', body: d }),
  sweepCrmPool: () => req('/api/crm/leads/sweep-pool', { method: 'POST', body: {} }),
  followCrmLead: (id, d) => req(`/api/crm/leads/${id}/follow`, { method: 'POST', body: d }),
  crmLeadStage: (id, d) => req(`/api/crm/leads/${id}/stage`, { method: 'POST', body: d }),
  mergeCrmLead: (id, d) => req(`/api/crm/leads/${id}/merge`, { method: 'POST', body: d }),
  importCrmLeads: (rows) => req('/api/crm/leads/import', { method: 'POST', body: { rows } }),
  deleteCrmLead: (id) => req(`/api/crm/leads/${id}`, { method: 'DELETE' }),

  crmCycles: (params) => req('/api/crm/cycles' + qs(params)),
  crmCycleAlerts: (params) => req('/api/crm/cycles/alerts' + qs(params)),
  crmCycleInfer: () => req('/api/crm/cycles/infer'),
  saveCrmCycle: (d) => req('/api/crm/cycles', { method: 'POST', body: d }),
  acceptCrmInference: (d) => req('/api/crm/cycles/accept-inference', { method: 'POST', body: d }),
  refreshCrmCycles: () => req('/api/crm/cycles/refresh', { method: 'POST', body: {} }),
  crmFollowups: (params) => req('/api/crm/followups' + qs(params)),
  addCrmFollowup: (d) => req('/api/crm/followups', { method: 'POST', body: d }),

  crmRanking: (params) => req('/api/crm/ranking' + qs(params)),

  crmHandovers: (params) => req('/api/crm/handovers' + qs(params)),
  crmHandover: (id) => req(`/api/crm/handovers/${id}`),
  createCrmHandover: (d) => req('/api/crm/handovers', { method: 'POST', body: d }),
  crmHandoverStatus: (id, d) => req(`/api/crm/handovers/${id}/status`, { method: 'POST', body: d }),
  deleteCrmHandover: (id) => req(`/api/crm/handovers/${id}`, { method: 'DELETE' }),

  crmTargets: (params) => req('/api/crm/targets' + qs(params)),
  crmTarget: (id) => req(`/api/crm/targets/${id}`),
  createCrmTarget: (d) => req('/api/crm/targets', { method: 'POST', body: d }),
  approveCrmTarget: (id) => req(`/api/crm/targets/${id}/approve`, { method: 'POST', body: {} }),

  crmRules: (params) => req('/api/crm/commission-rules' + qs(params)),
  createCrmRule: (d) => req('/api/crm/commission-rules', { method: 'POST', body: d }),
  approveCrmRule: (id) => req(`/api/crm/commission-rules/${id}/approve`, { method: 'POST', body: {} }),

  crmCommissions: (params) => req('/api/crm/commissions' + qs(params)),
  crmCommission: (id) => req(`/api/crm/commissions/${id}`),
  crmPreviewCommission: (d) => req('/api/crm/commissions/preview', { method: 'POST', body: d }),
  createCrmCommission: (d) => req('/api/crm/commissions', { method: 'POST', body: d }),
  adjustCrmCommission: (id, d) => req(`/api/crm/commissions/${id}/adjust`, { method: 'POST', body: d }),
  crmCommissionStatus: (id, d) => req(`/api/crm/commissions/${id}/status`, { method: 'POST', body: d }),
  linkCrmPayroll: (id, d) => req(`/api/crm/commissions/${id}/link-payroll`, { method: 'POST', body: d }),

  crmReportCycle: (params) => req('/api/crm/reports/cycle' + qs(params)),
  crmReportCommission: (params) => req('/api/crm/reports/commission' + qs(params)),

  // 供给批次与预订（M23：可售口径/批次迁移/预订占用/缺口）
  supplyDict: () => req('/api/supply/dict'),
  supplyOverview: () => req('/api/supply/overview'),
  supplyReport: (params) => req('/api/supply/report' + qs(params)),
  supplyProjection: (params) => req('/api/supply/projection' + qs(params)),
  refreshSupplyProjection: (d) => req('/api/supply/projection/refresh', { method: 'POST', body: d || {} }),

  supplyBatches: (params) => req('/api/supply/batches' + qs(params)),
  supplyBatch: (id) => req(`/api/supply/batches/${id}`),
  createSupplyBatch: (d) => req('/api/supply/batches', { method: 'POST', body: d }),
  moveSupplyBatch: (id, d) => req(`/api/supply/batches/${id}/move`, { method: 'POST', body: d }),
  splitSupplyBatch: (id, d) => req(`/api/supply/batches/${id}/split`, { method: 'POST', body: d }),
  shortSupplyBatch: (id, d) => req(`/api/supply/batches/${id}/short`, { method: 'POST', body: d }),
  inspectSupplyBatch: (id, d) => req(`/api/supply/batches/${id}/inspect`, { method: 'POST', body: d }),
  deleteSupplyBatch: (id) => req(`/api/supply/batches/${id}`, { method: 'DELETE' }),

  supplyRequests: (params) => req('/api/supply/requests' + qs(params)),
  supplyRequest: (id) => req(`/api/supply/requests/${id}`),
  createSupplyRequest: (d) => req('/api/supply/requests', { method: 'POST', body: d }),
  confirmSupplyRequest: (id, d) => req(`/api/supply/requests/${id}/confirm`, { method: 'POST', body: d }),
  rejectSupplyRequest: (id, d) => req(`/api/supply/requests/${id}/reject`, { method: 'POST', body: d }),
  cancelSupplyRequest: (id, d) => req(`/api/supply/requests/${id}/cancel`, { method: 'POST', body: d }),
  expireSupplyRequests: () => req('/api/supply/requests/expire', { method: 'POST', body: {} }),
  deleteSupplyRequest: (id) => req(`/api/supply/requests/${id}`, { method: 'DELETE' }),

  supplyHolds: (params) => req('/api/supply/holds' + qs(params)),
  supplyHold: (id) => req(`/api/supply/holds/${id}`),
  releaseSupplyHold: (id, d) => req(`/api/supply/holds/${id}/release`, { method: 'POST', body: d }),
  pickedSupplyHold: (id, d) => req(`/api/supply/holds/${id}/picked`, { method: 'POST', body: d }),
  convertSupplyHold: (id, d) => req(`/api/supply/holds/${id}/convert`, { method: 'POST', body: d }),
  expireSupplyHolds: () => req('/api/supply/holds/expire', { method: 'POST', body: {} }),

  supplyShortages: (params) => req('/api/supply/shortages' + qs(params)),
  resolveSupplyShortage: (id, d) => req(`/api/supply/shortages/${id}/resolve`, { method: 'POST', body: d }),

  // 客户营销与消息（M24：订阅/模板/渠道/频控/发送回执/到货提醒/归因）
  notifyDict: () => req('/api/notify/dict'),
  notifyOverview: () => req('/api/notify/overview'),
  notifyChannels: () => req('/api/notify/channels'),
  saveNotifyChannel: (d) => req('/api/notify/channels', { method: 'POST', body: d }),

  notifySubs: (params) => req('/api/notify/subs' + qs(params)),
  saveNotifySub: (d) => req('/api/notify/subs', { method: 'POST', body: d }),
  unsubNotifyMarketing: (customerId, d) => req(`/api/notify/subs/${customerId}/unsubscribe-marketing`, { method: 'POST', body: d }),
  requestNotifyEmailVerify: (customerId) => req(`/api/notify/subs/${customerId}/verify-email`, { method: 'POST', body: {} }),
  confirmNotifyEmailVerify: (customerId, d) => req(`/api/notify/subs/${customerId}/confirm-email`, { method: 'POST', body: d }),

  notifyTemplates: (params) => req('/api/notify/templates' + qs(params)),
  notifyTemplate: (id) => req(`/api/notify/templates/${id}`),
  createNotifyTemplate: (d) => req('/api/notify/templates', { method: 'POST', body: d }),
  updateNotifyTemplate: (id, d) => req(`/api/notify/templates/${id}`, { method: 'PUT', body: d }),
  submitNotifyTemplate: (id) => req(`/api/notify/templates/${id}/submit`, { method: 'POST', body: {} }),
  approveNotifyTemplate: (id, d) => req(`/api/notify/templates/${id}/approve`, { method: 'POST', body: d || {} }),
  retireNotifyTemplate: (id, d) => req(`/api/notify/templates/${id}/retire`, { method: 'POST', body: d }),
  deleteNotifyTemplate: (id) => req(`/api/notify/templates/${id}`, { method: 'DELETE' }),

  notifyWechat: (params) => req('/api/notify/wechat' + qs(params)),
  bindNotifyWechat: (d) => req('/api/notify/wechat', { method: 'POST', body: d }),
  syncNotifyWechat: () => req('/api/notify/wechat/sync', { method: 'POST', body: {} }),

  notifyFrequency: () => req('/api/notify/frequency'),
  saveNotifyFrequency: (d) => req('/api/notify/frequency', { method: 'POST', body: d }),

  notifyEvents: (params) => req('/api/notify/events' + qs(params)),
  emitNotifyEvent: (d) => req('/api/notify/events', { method: 'POST', body: d }),

  notifyOutbox: (params) => req('/api/notify/outbox' + qs(params)),
  notifyOutboxOne: (id) => req(`/api/notify/outbox/${id}`),
  dispatchNotify: (d) => req('/api/notify/outbox/dispatch', { method: 'POST', body: d || {} }),
  sendNotify: (id) => req(`/api/notify/outbox/${id}/send`, { method: 'POST', body: {} }),
  notifyReceipt: (id, d) => req(`/api/notify/outbox/${id}/receipt`, { method: 'POST', body: d }),
  retryNotify: (id) => req(`/api/notify/outbox/${id}/retry`, { method: 'POST', body: {} }),
  skipNotify: (id, d) => req(`/api/notify/outbox/${id}/skip`, { method: 'POST', body: d }),

  notifyAlerts: (params) => req('/api/notify/alerts' + qs(params)),
  createNotifyAlert: (d) => req('/api/notify/alerts', { method: 'POST', body: d }),
  sweepNotifyAlerts: () => req('/api/notify/alerts/sweep', { method: 'POST', body: {} }),
  cancelNotifyAlert: (id, d) => req(`/api/notify/alerts/${id}/cancel`, { method: 'POST', body: d }),

  notifyCycleTasks: (d) => req('/api/notify/cycle-tasks', { method: 'POST', body: d || {} }),

  notifyAttribution: (params) => req('/api/notify/attribution' + qs(params)),
  refreshNotifyAttribution: (d) => req('/api/notify/attribution/refresh', { method: 'POST', body: d || {} }),

  // 美仓作业计划（M19：拣货波次/跨境头程/库容规划）
  whplanDict: () => req('/api/whplan/dict'),
  whplanOverview: () => req('/api/whplan/overview'),
  whplanCandidates: (params) => req('/api/whplan/candidates' + qs(params)),
  whplanWaves: (params) => req('/api/whplan/waves' + qs(params)),
  whplanWave: (id) => req(`/api/whplan/waves/${id}`),
  createWhplanWave: (d) => req('/api/whplan/waves', { method: 'POST', body: d }),
  releaseWhplanWave: (id) => req(`/api/whplan/waves/${id}/release`, { method: 'POST', body: {} }),
  pickWhplanItem: (id, itemId, d) => req(`/api/whplan/waves/${id}/items/${itemId}/pick`, { method: 'POST', body: d }),
  packWhplanWave: (id, d) => req(`/api/whplan/waves/${id}/pack`, { method: 'POST', body: d }),
  shipWhplanWave: (id) => req(`/api/whplan/waves/${id}/ship`, { method: 'POST', body: {} }),
  cancelWhplanWave: (id, d) => req(`/api/whplan/waves/${id}/cancel`, { method: 'POST', body: d }),
  deleteWhplanWave: (id) => req(`/api/whplan/waves/${id}`, { method: 'DELETE' }),

  whplanAsns: (params) => req('/api/whplan/asns' + qs(params)),
  whplanAsn: (id) => req(`/api/whplan/asns/${id}`),
  addWhplanLeg: (id, d) => req(`/api/whplan/asns/${id}/legs`, { method: 'POST', body: d }),
  arriveWhplanLeg: (legId, d) => req(`/api/whplan/legs/${legId}/arrive`, { method: 'POST', body: d }),
  addWhplanBox: (id, d) => req(`/api/whplan/asns/${id}/boxes`, { method: 'POST', body: d }),
  changeWhplanEta: (id, d) => req(`/api/whplan/asns/${id}/eta`, { method: 'POST', body: d }),

  whplanCapacity: (params) => req('/api/whplan/capacity' + qs(params)),
  whplanSuggest: (params) => req('/api/whplan/suggest' + qs(params)),

  // 有限产能排程（M06：班次日历/工序定额/排程批次/冲突）
  scheduleMeta: () => req('/api/schedule/meta'),
  scheduleOrders: () => req('/api/schedule/orders'),
  scheduleCalendars: (params) => req('/api/schedule/calendars' + qs(params)),
  saveScheduleCalendar: (d) => req('/api/schedule/calendars', { method: 'POST', body: d }),
  fillScheduleCalendars: (d) => req('/api/schedule/calendars/fill', { method: 'POST', body: d }),
  scheduleStandards: () => req('/api/schedule/standards'),
  saveScheduleStandard: (d) => req('/api/schedule/standards', { method: 'POST', body: d }),
  updateScheduleStandard: (id, d) => req(`/api/schedule/standards/${id}`, { method: 'PUT', body: d }),
  scheduleRuns: () => req('/api/schedule/runs'),
  scheduleRun: (id) => req(`/api/schedule/runs/${id}`),
  previewScheduleRun: (d) => req('/api/schedule/runs/preview', { method: 'POST', body: d }),
  createScheduleRun: (d) => req('/api/schedule/runs', { method: 'POST', body: d }),
  publishScheduleRun: (id, d) => req(`/api/schedule/runs/${id}/publish`, { method: 'POST', body: d || {} }),
  archiveScheduleRun: (id) => req(`/api/schedule/runs/${id}/archive`, { method: 'POST', body: {} }),
  scheduleConflicts: (params) => req('/api/schedule/conflicts' + qs(params)),
  resolveScheduleConflict: (id, d) => req(`/api/schedule/conflicts/${id}/resolve`, { method: 'POST', body: d }),
  patchScheduleTask: (id, d) => req(`/api/schedule/tasks/${id}`, { method: 'PATCH', body: d }),
  scheduleChanges: (params) => req('/api/schedule/changes' + qs(params)),
  scheduleLoad: () => req('/api/schedule/load'),

  // 现货经营总览 + 备货补货与停补提案（M19）
  spotopsDict: () => req('/api/spotops/dict'),
  spotopsOverview: (params) => req('/api/spotops/overview' + qs(params)),
  spotopsSkus: (params) => req('/api/spotops/skus' + qs(params)),
  spotopsPolicies: (params) => req('/api/spotops/policies' + qs(params)),
  saveSpotopsPolicy: (d) => req('/api/spotops/policies', { method: 'POST', body: d }),
  deleteSpotopsPolicy: (id) => req(`/api/spotops/policies/${id}`, { method: 'DELETE' }),
  spotopsRuns: (params) => req('/api/spotops/runs' + qs(params)),
  spotopsRun: (id) => req(`/api/spotops/runs/${id}`),
  createSpotopsRun: (d) => req('/api/spotops/runs', { method: 'POST', body: d }),
  publishSpotopsRun: (id, d) => req(`/api/spotops/runs/${id}/publish`, { method: 'POST', body: d || {} }),
  archiveSpotopsRun: (id) => req(`/api/spotops/runs/${id}/archive`, { method: 'POST', body: {} }),
  decideSpotopsLine: (id, d) => req(`/api/spotops/lines/${id}/decide`, { method: 'POST', body: d }),
  spotopsApproved: (params) => req('/api/spotops/approved' + qs(params)),

  // 分公司经营对比（M12）
  segmentDict: () => req('/api/segments/dict'),
  segmentBoard: (params) => req('/api/segments/board' + qs(params)),
  segmentCompany: (id, params) => req(`/api/segments/company/${id}` + qs(params)),
  segmentAdjustments: (params) => req('/api/segments/adjustments' + qs(params)),
  saveSegmentAdjustment: (d) => req('/api/segments/adjustments', { method: 'POST', body: d }),
  deleteSegmentAdjustment: (id) => req(`/api/segments/adjustments/${id}`, { method: 'DELETE' }),
  segmentReports: (params) => req('/api/segments/reports' + qs(params)),
  createSegmentReport: (d) => req('/api/segments/reports', { method: 'POST', body: d }),
  segmentReport: (id) => req(`/api/segments/reports/${id}`),
  confirmSegmentReport: (id, d) => req(`/api/segments/reports/${id}/confirm`, { method: 'POST', body: d || {} }),

  // 备料领退与盘点差异（M10）
  matflowDict: () => req('/api/matflow/dict'),
  matflowBoard: (params) => req('/api/matflow/board' + qs(params)),
  matflowStock: (params) => req('/api/matflow/stock' + qs(params)),
  matflowLedger: (params) => req('/api/matflow/ledger' + qs(params)),
  matflowSuggest: (orderId) => req('/api/matflow/issues/suggest?order_id=' + orderId),
  matflowIssues: (params) => req('/api/matflow/issues' + qs(params)),
  matflowIssue: (id) => req(`/api/matflow/issues/${id}`),
  createMatflowIssue: (d) => req('/api/matflow/issues', { method: 'POST', body: d }),
  prepareMatflowIssue: (id) => req(`/api/matflow/issues/${id}/prepare`, { method: 'POST', body: {} }),
  outMatflowIssue: (id, d) => req(`/api/matflow/issues/${id}/issue`, { method: 'POST', body: d }),
  closeMatflowIssue: (id, d) => req(`/api/matflow/issues/${id}/close`, { method: 'POST', body: d || {} }),
  cancelMatflowIssue: (id, d) => req(`/api/matflow/issues/${id}/cancel`, { method: 'POST', body: d || {} }),
  matflowReturns: (params) => req('/api/matflow/returns' + qs(params)),
  matflowReturn: (id) => req(`/api/matflow/returns/${id}`),
  createMatflowReturn: (d) => req('/api/matflow/returns', { method: 'POST', body: d }),
  confirmMatflowReturn: (id) => req(`/api/matflow/returns/${id}/confirm`, { method: 'POST', body: {} }),
  matflowStocktakes: (params) => req('/api/matflow/stocktakes' + qs(params)),
  matflowStocktake: (id) => req(`/api/matflow/stocktakes/${id}`),
  createMatflowStocktake: (d) => req('/api/matflow/stocktakes', { method: 'POST', body: d }),
  startMatflowStocktake: (id) => req(`/api/matflow/stocktakes/${id}/start`, { method: 'POST', body: {} }),
  countMatflowStocktake: (id, d) => req(`/api/matflow/stocktakes/${id}/count`, { method: 'POST', body: d }),
  submitMatflowStocktake: (id, d) => req(`/api/matflow/stocktakes/${id}/submit`, { method: 'POST', body: d || {} }),
  adjustMatflowStocktake: (id) => req(`/api/matflow/stocktakes/${id}/adjust`, { method: 'POST', body: {} }),
  cancelMatflowStocktake: (id, d) => req(`/api/matflow/stocktakes/${id}/cancel`, { method: 'POST', body: d || {} }),
  matflowOrder: (id) => req(`/api/matflow/order/${id}`),

  // 价格快照 + 费用池（M11）
  pricingDict: () => req('/api/pricing/dict'),
  pricingBoard: (params) => req('/api/pricing/board' + qs(params)),
  pricingPools: (params) => req('/api/pricing/pools' + qs(params)),
  pricingPool: (id) => req(`/api/pricing/pools/${id}`),
  pricingPoolPreview: (id) => req(`/api/pricing/pools/${id}/preview`),
  createPricingPool: (d) => req('/api/pricing/pools', { method: 'POST', body: d }),
  addPoolExpense: (id, d) => req(`/api/pricing/pools/${id}/expenses`, { method: 'POST', body: d }),
  removePoolExpense: (id) => req(`/api/pricing/expenses/${id}`, { method: 'DELETE' }),
  distributePool: (id, d) => req(`/api/pricing/pools/${id}/distribute`, { method: 'POST', body: d || {} }),
  revertPool: (id, d) => req(`/api/pricing/pools/${id}/revert`, { method: 'POST', body: d || {} }),
  closePool: (id) => req(`/api/pricing/pools/${id}/close`, { method: 'POST', body: {} }),
  pricingBooks: (params) => req('/api/pricing/books' + qs(params)),
  pricingBook: (id) => req(`/api/pricing/books/${id}`),
  createPricingBook: (d) => req('/api/pricing/books', { method: 'POST', body: d }),
  upsertBookItem: (id, d) => req(`/api/pricing/books/${id}/items`, { method: 'POST', body: d }),
  removeBookItem: (id) => req(`/api/pricing/items/${id}`, { method: 'DELETE' }),
  publishBook: (id, d) => req(`/api/pricing/books/${id}/publish`, { method: 'POST', body: d || {} }),
  archiveBook: (id, d) => req(`/api/pricing/books/${id}/archive`, { method: 'POST', body: d || {} }),
  pricingQuote: (params) => req('/api/pricing/quote' + qs(params)),
  pricingCost: (styleNo) => req('/api/pricing/cost/' + encodeURIComponent(styleNo)),

  // 长期投资抵消（M12）
  investmentDict: () => req('/api/investment/dict'),
  investmentBoard: () => req('/api/investment/board'),
  investmentList: (params) => req('/api/investment/list' + qs(params)),
  investmentDetail: (id) => req(`/api/investment/${id}`),
  createInvestment: (d) => req('/api/investment', { method: 'POST', body: d }),
  addInvestmentChange: (id, d) => req(`/api/investment/${id}/changes`, { method: 'POST', body: d }),
  changeInvestmentMethod: (id, d) => req(`/api/investment/${id}/method`, { method: 'POST', body: d }),
  disposeInvestment: (id, d) => req(`/api/investment/${id}/dispose`, { method: 'POST', body: d }),
  investmentOffsets: (period) => req('/api/investment/offsets/' + period),
  investmentEquity: (period, companyId) => req(`/api/investment/equity/${period}/${companyId}`),

  // 裁片外发与外协验货交接（M07）
  cutDispatchDict: () => req('/api/cutdispatch/dict'),
  cutDispatchBoard: (params) => req('/api/cutdispatch/board' + qs(params)),
  cutDispatchSuggest: (cutOrderId) => req('/api/cutdispatch/suggest/' + cutOrderId),
  cutDispatchList: (params) => req('/api/cutdispatch/list' + qs(params)),
  cutDispatchDetail: (id) => req(`/api/cutdispatch/${id}`),
  createCutDispatch: (d) => req('/api/cutdispatch', { method: 'POST', body: d }),
  sendCutDispatch: (id) => req(`/api/cutdispatch/${id}/send`, { method: 'POST', body: {} }),
  receiveCutDispatch: (id, d) => req(`/api/cutdispatch/${id}/receive`, { method: 'POST', body: d }),
  closeCutDispatch: (id, d) => req(`/api/cutdispatch/${id}/close`, { method: 'POST', body: d || {} }),
  cancelCutDispatch: (id, d) => req(`/api/cutdispatch/${id}/cancel`, { method: 'POST', body: d || {} }),

  // 研发立项与款式生命周期 + SKU 配码主档（M05）
  devDict: () => req('/api/devmaster/dict'),
  devBoard: (params) => req('/api/devmaster/board' + qs(params)),
  devProjects: (params) => req('/api/devmaster/projects' + qs(params)),
  devProject: (id) => req(`/api/devmaster/projects/${id}`),
  createDevProject: (d) => req('/api/devmaster/projects', { method: 'POST', body: d }),
  updateDevProject: (id, d) => req(`/api/devmaster/projects/${id}`, { method: 'PATCH', body: d }),
  advanceDevStage: (id, d) => req(`/api/devmaster/projects/${id}/stage`, { method: 'POST', body: d }),
  addDevMilestone: (id, d) => req(`/api/devmaster/projects/${id}/milestone`, { method: 'POST', body: d }),
  addDevTask: (id, d) => req(`/api/devmaster/projects/${id}/tasks`, { method: 'POST', body: d }),
  setDevTaskStatus: (id, d) => req(`/api/devmaster/tasks/${id}/status`, { method: 'POST', body: d }),
  closeDevProject: (id, d) => req(`/api/devmaster/projects/${id}/close`, { method: 'POST', body: d || {} }),
  devSkus: (params) => req('/api/devmaster/skus' + qs(params)),
  devSku: (id) => req(`/api/devmaster/skus/${id}`),
  createDevSku: (d) => req('/api/devmaster/skus', { method: 'POST', body: d }),
  updateDevSku: (id, d) => req(`/api/devmaster/skus/${id}`, { method: 'PATCH', body: d }),
  addSkuAlias: (id, d) => req(`/api/devmaster/skus/${id}/alias`, { method: 'POST', body: d }),
  disableSkuAlias: (id, d) => req(`/api/devmaster/aliases/${id}/disable`, { method: 'POST', body: d }),
  explodeSku: (id, qty) => req(`/api/devmaster/skus/${id}/explode?qty=${qty || 1}`),
  devPack: (id) => req(`/api/devmaster/packs/${id}`),
  createDevPack: (d) => req('/api/devmaster/packs', { method: 'POST', body: d }),
  activateDevPack: (id) => req(`/api/devmaster/packs/${id}/activate`, { method: 'POST', body: {} }),

  // 供方信息协同与技术再次审核（M05-06）
  supDict: () => req('/api/supreview/dict'),
  supBoard: (params) => req('/api/supreview/board' + qs(params)),
  supOptions: () => req('/api/supreview/options'),
  supPack: (id) => req('/api/supreview/packs/' + id),
  saveSupAssignment: (id, d) => req(`/api/supreview/packs/${id}/assignment`, { method: 'POST', body: d }),
  confirmSupAssignment: (id) => req(`/api/supreview/packs/${id}/assignment/confirm`, { method: 'POST', body: {} }),
  createSupConfirm: (id, d) => req(`/api/supreview/packs/${id}/confirms`, { method: 'POST', body: d }),
  confirmSupConfirm: (id) => req(`/api/supreview/confirms/${id}/confirm`, { method: 'POST', body: {} }),
  createSupReview: (id, d) => req(`/api/supreview/packs/${id}/reviews`, { method: 'POST', body: d }),
  approveSupPack: (id, d) => req(`/api/supreview/packs/${id}/approve`, { method: 'POST', body: d || {} }),

  // 备份与恢复
  backupOverview: () => req('/api/backup/overview'),
  backupCreate: (d) => req('/api/backup/create', { method: 'POST', body: d }),
  backupList: (params) => req('/api/backup/list' + qs(params)),
  backupVerify: (id) => req(`/api/backup/${id}/verify`, { method: 'POST' }),
  backupDelete: (id) => req(`/api/backup/${id}`, { method: 'DELETE' }),
  backupPrepare: (d) => req('/api/backup/restore/prepare', { method: 'POST', body: d }),
  backupRollback: () => req('/api/backup/restore/rollback', { method: 'POST' }),
  backupPending: () => req('/api/backup/restore/pending'),
  backupChecks: () => req('/api/backup/checks'),

  // 岗位权限复核
  accessMe: () => req('/api/access/me'),
  accessPermissions: () => req('/api/access/permissions'),
  accessRoles: () => req('/api/access/roles'),
  accessReview: () => req('/api/access/review'),
  accessSod: () => req('/api/access/sod'),
  accessSetException: (d) => req('/api/access/exceptions', { method: 'POST', body: d }),
  accessDelException: (id) => req(`/api/access/exceptions/${id}`, { method: 'DELETE' }),
  accessSetRoles: (d) => req('/api/access/roles', { method: 'POST', body: d }),
  accessReviews: () => req('/api/access/reviews'),
  accessSignOff: (d) => req('/api/access/reviews', { method: 'POST', body: d }),

  // 上线准备：真实数据导入
  importTypes: () => req('/api/importops/types'),
  importPreview: (d) => req('/api/importops/preview', { method: 'POST', body: d }),
  importCommit: (d) => req('/api/importops/commit', { method: 'POST', body: d }),
  importBatches: (params) => req('/api/importops/batches' + qs(params)),
  importBatch: (id) => req(`/api/importops/batches/${id}`)
};

/** 带 Token 取二进制（blob） */
async function blob(path) {
  const headers = {};
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const res = await fetch(BASE + path, { headers });
  if (!res.ok) {
    let m = '下载失败';
    try { m = (await res.json()).message || m; } catch (e) { /* ignore */ }
    throw new Error(m);
  }
  return res.blob();
}

/** 下载订单 CSV（带 Token） */
export async function exportOrders(params) {
  const base = import.meta.env.VITE_API_BASE || '';
  const headers = {};
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const res = await fetch(base + '/api/orders/export' + qs(params), { headers });
  if (!res.ok) throw new Error('导出失败');
  return res.blob();
}

/**
 * 上传二进制文件（备份恢复用）
 * 不能走 req()：那个函数固定 Content-Type: application/json，还会把 body JSON 序列化。
 * 备份动辄几十上百 MB，base64 膨胀 33% 且要在内存里多留一份，所以直接发二进制。
 */
export async function uploadBinary(path, file, query = {}) {
  const base = import.meta.env.VITE_API_BASE || '';
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const res = await fetch(base + path + qs(query), { method: 'POST', headers, body: file });
  let json = {};
  try {
    json = await res.json();
  } catch (e) {
    json = {};
  }
  if (res.status === 401) {
    clearAuth();
    if (location.pathname !== '/login') location.href = '/login';
  }
  if (!res.ok) throw new Error(json.message || `上传失败（${res.status}）`);
  return json.data !== undefined ? json.data : json;
}

/** 通用带 Token 下载（返回 blob） */
/** POST 下载（导出要带筛选条件与理由，GET 拼 query 太容易丢字段） */
export async function downloadPost(path, body) {
  const base = import.meta.env.VITE_API_BASE || '';
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  if (!res.ok) {
    let msg = `导出失败（${res.status}）`;
    try { const j = await res.json(); if (j && j.message) msg = j.message; } catch (e) { /* 非 JSON */ }
    throw new Error(msg);
  }
  return {
    blob: await res.blob(),
    jobNo: res.headers.get('X-Export-Job') || '',
    watermark: res.headers.get('X-Export-Watermark') || '',
    rows: res.headers.get('X-Export-Rows') || '',
    maskedFields: decodeURIComponent(res.headers.get('X-Export-Masked-Fields') || ''),
    changed: res.headers.get('X-Export-Changed') === '1'
  };
}

export async function downloadFile(path) {
  const base = import.meta.env.VITE_API_BASE || '';
  const headers = {};
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const res = await fetch(base + path, { headers });
  if (!res.ok) throw new Error('下载失败');
  return res.blob();
}
