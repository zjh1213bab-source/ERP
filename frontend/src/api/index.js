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
  if (!res.ok) throw new Error(json.message || `请求失败（${res.status}）`);
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

export const api = {
  // 登录
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
  orderMeta: () => req('/api/orders/meta'),
  orderStats: () => req('/api/orders/stats/summary'),
  createOrder: (d) => req('/api/orders', { method: 'POST', body: d }),
  transitionOrder: (id, to, note) =>
    req(`/api/orders/${id}/transition`, { method: 'POST', body: { to, note } }),

  // 技术资料 / 开发单
  techpacks: (orderId) => req(`/api/techpacks?order_id=${orderId}`),
  techpacksAll: (params) => req('/api/techpacks/all' + qs(params)),
  createTechpack: (d) => req('/api/techpacks', { method: 'POST', body: d }),
  updateTechpack: (id, d) => req(`/api/techpacks/${id}`, { method: 'PUT', body: d }),
  deleteTechpack: (id) => req(`/api/techpacks/${id}`, { method: 'DELETE' }),
  confirmTechpack: (id) => req(`/api/techpacks/${id}/confirm`, { method: 'POST' }),
  rejectTechpack: (id) => req(`/api/techpacks/${id}/reject`, { method: 'POST' }),
  techpackStage: (id, stage) => req(`/api/techpacks/${id}/stage`, { method: 'POST', body: { stage } }),

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
  deleteOrderMaterial: (id) => req(`/api/order-materials/${id}`, { method: 'DELETE' }),

  // 生产工序
  orderNodes: (orderId) => req(`/api/order-nodes?order_id=${orderId}`),
  initNodes: (orderId) => req('/api/order-nodes/init', { method: 'POST', body: { order_id: orderId } }),
  updateNode: (id, d) => req(`/api/order-nodes/${id}`, { method: 'PATCH', body: d }),

  // 系统设置
  settings: () => req('/api/settings'),
  saveSettings: (d) => req('/api/settings', { method: 'PUT', body: d }),

  // 面辅料主数据
  materials: (params) => req('/api/materials' + qs(params)),
  createMaterial: (d) => req('/api/materials', { method: 'POST', body: d }),
  deleteMaterial: (id) => req(`/api/materials/${id}`, { method: 'DELETE' }),

  // 用户
  users: () => req('/api/users'),

  // 业务蓝图（原脑图）
  blueprint: () => req('/api/mindmap'),
  saveBlueprint: (data) => req('/api/mindmap', { method: 'PUT', body: { data } })
};
