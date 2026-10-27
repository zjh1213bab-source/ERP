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
  // 登录后立刻拉一次生效权限（一人多岗 / 岗位复核收回都在服务端算）
  import('./permissions').then((m) => m.syncPerms()).catch(() => {});
}

export function clearAuth() {
  auth.token = '';
  auth.user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  import('./permissions').then((m) => m.resetPerms()).catch(() => {});
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
  boss: '总经理',
  sales: '销售跟单',
  tech: '技术打版',
  finance: '财务会计',
  production: '生产车间',
  warehouse: '仓库采购',
  hr: '人事行政',
  viewer: '只读'
};
