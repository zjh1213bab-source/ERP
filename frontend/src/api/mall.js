/**
 * 客户商城接口（客户账号 token，与 ERP 员工 token 完全分离）
 */
const BASE = import.meta.env.VITE_API_BASE || '';
const TOKEN_KEY = 'mall_token';
const USER_KEY = 'mall_user';

export function getMallToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setMallAuth(token, payload) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(payload || null));
}
export function clearMallAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
export function getMallUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
}

async function req(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getMallToken();
  if (t) headers.Authorization = 'Bearer ' + t;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = {};
  try { json = await res.json(); } catch (e) { json = {}; }

  if (res.status === 401) {
    clearMallAuth();
    if (!location.pathname.startsWith('/mall/login')) location.href = '/mall/login';
  }
  if (!res.ok) throw new Error(json.message || `请求失败（${res.status}）`);
  return json.data !== undefined ? json.data : json;
}

function qs(params = {}) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) p.append(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
}

export const mallApi = {
  login: (username, password) => req('/api/mall/auth/login', { method: 'POST', body: { username, password } }),
  me: () => req('/api/mall/auth/me'),

  publicProducts: (q) => req('/api/mall/public/products' + qs({ q })),
  categories: () => req('/api/mall/categories'),
  products: (params) => req('/api/mall/products' + qs(params)),
  product: (id) => req('/api/mall/products/' + id),

  favorites: () => req('/api/mall/favorites'),
  toggleFavorite: (id) => req(`/api/mall/favorites/${id}`, { method: 'POST' }),

  createInquiry: (d) => req('/api/mall/inquiries', { method: 'POST', body: d }),
  inquiries: () => req('/api/mall/inquiries'),
  inquiry: (id) => req('/api/mall/inquiries/' + id),
  confirmInquiry: (id) => req(`/api/mall/inquiries/${id}/confirm`, { method: 'POST' }),
  cancelInquiry: (id) => req(`/api/mall/inquiries/${id}/cancel`, { method: 'POST' }),

  orders: () => req('/api/mall/orders'),
  order: (id) => req('/api/mall/orders/' + id),
  // 订单进度：只返回业务已发布的快照（没发布的订单不会出现）
  progress: () => req('/api/mall/progress'),
  orderProgress: (id) => req('/api/mall/orders/' + id + '/progress'),

  confirmations: () => req('/api/mall/confirmations'),
  confirmSeal: (id, d) => req(`/api/mall/seals/${id}/confirm`, { method: 'POST', body: d || {} }),
  confirmChange: (id, d) => req(`/api/mall/changes/${id}/confirm`, { method: 'POST', body: d || {} }),
  confirmDelivery: (id, d) => req(`/api/mall/deliveries/${id}/confirm`, { method: 'POST', body: d || {} }),
  orderDelivery: (id) => req('/api/mall/orders/' + id + '/delivery'),

  messages: () => req('/api/mall/messages'),
  readMessage: (id) => req(`/api/mall/messages/${id}/read`, { method: 'POST' }),
  readAll: () => req('/api/mall/messages/read-all', { method: 'POST' }),

  summary: () => req('/api/mall/summary'),

  // 成员与授权（主账号 / 有 member.manage 的子账号）
  members: () => req('/api/mall/members'),
  createMember: (d) => req('/api/mall/members', { method: 'POST', body: d }),
  updateMember: (id, d) => req('/api/mall/members/' + id, { method: 'PUT', body: d }),
  resetMemberPwd: (id, d) => req(`/api/mall/members/${id}/reset-pwd`, { method: 'POST', body: d || {} }),
  audits: () => req('/api/mall/audits'),

  // 对账（财务子账号）
  finance: () => req('/api/mall/finance'),

  // 对账资料下载（只含公司已授权的文件）
  statements: () => req('/api/mall/statements'),

  // 售后（挂在订单权限下）
  afterSales: () => req('/api/mall/after-sales'),
  afterSaleOptions: () => req('/api/mall/after-sales/options'),
  afterSaleDetail: (id) => req('/api/mall/after-sales/' + id),
  submitAfterSale: (d) => req('/api/mall/after-sales', { method: 'POST', body: d }),
  cancelAfterSale: (id) => req('/api/mall/after-sales/' + id + '/cancel', { method: 'POST', body: {} }),

  // 改密码
  changePwd: (d) => req('/api/mall/auth/change-pwd', { method: 'POST', body: d }),

  // 邀请注册（无需登录）
  inviteInfo: (token) => req('/api/mall/auth/invite/' + token),
  acceptInvite: (token, d) => req(`/api/mall/auth/invite/${token}/accept`, { method: 'POST', body: d })
};

/** 下载对账文件（要带客户 token，不能直接用 <a href> 裸链） */
export async function downloadStatement(id) {
  const res = await fetch(BASE + '/api/mall/statements/' + id + '/download', {
    headers: { Authorization: 'Bearer ' + getMallToken() }
  });
  if (!res.ok) {
    let msg = `下载失败（${res.status}）`;
    try { const j = await res.json(); msg = j.message || msg; } catch (e) { /* 非 JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const name = m ? decodeURIComponent(m[1]) : `statement-${id}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
