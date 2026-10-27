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

  // 改密码
  changePwd: (d) => req('/api/mall/auth/change-pwd', { method: 'POST', body: d }),

  // 邀请注册（无需登录）
  inviteInfo: (token) => req('/api/mall/auth/invite/' + token),
  acceptInvite: (token, d) => req(`/api/mall/auth/invite/${token}/accept`, { method: 'POST', body: d })
};
