/**
 * 登录态（模块级 reactive，持久化到 localStorage）
 */
import { reactive } from 'vue';

const TOKEN_KEY = 'erp_token';
const USER_KEY = 'erp_user';

let savedUser = null;
try {
  savedUser = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
} catch (e) {
  savedUser = null;
}

export const auth = reactive({
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: savedUser
});

export function setAuth(token, user) {
  auth.token = token;
  auth.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user || null));
}

export function clearAuth() {
  auth.token = '';
  auth.user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isLoggedIn() {
  return !!auth.token;
}

/** admin 恒通过 */
export function hasRole(...roles) {
  if (!auth.user) return false;
  return auth.user.role === 'admin' || roles.includes(auth.user.role);
}

export const ROLE_LABELS = {
  admin: '系统管理员',
  sales: '销售',
  tech: '技术',
  finance: '财务',
  production: '生产',
  warehouse: '仓储',
  viewer: '只读'
};
