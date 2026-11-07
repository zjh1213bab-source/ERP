/**
 * 前端权限（按钮显隐）
 * 用法：v-if="can('order.create')"
 *
 * 三个来源，优先级从高到低：
 *   1. GET /api/access/me —— 生效权限（含一人多岗 + 用户级收回），登录后立即同步
 *   2. perm-table.js       —— 后端权限矩阵生成的兜底表（首屏几百毫秒 / 断网重连）
 *   3. 未定义               —— 一律拒绝（更安全）
 *
 * 为什么不能只看本地表：
 *   岗位复核会把某些权限从某人身上收掉（例如试用期销售不能导出客户名单）。
 *   如果前端仍按「sales 有 order.export」显示按钮，点下去会被后端 403 ——
 *   所以收回必须在按钮层就体现，否则用户只会觉得系统坏了。
 */
import { reactive } from 'vue';
import { auth } from './auth';
import { PERM_TABLE, ROLE_LABELS, ROLES } from './perm-table';
import { api } from '../api';

export const PERMS = PERM_TABLE;
export { ROLE_LABELS, ROLES };

/** 服务端同步来的生效权限；loaded=false 时用兜底表 */
export const permState = reactive({
  loaded: false,
  perms: [],
  positionName: '',
  positionDirect: false,
  positionPermissions: null,
  denied: [],
  roles: [],
  isAdmin: false,
  error: ''
});

/** 拉取当前账号的生效权限（登录后、切换账号后各调一次） */
export async function syncPerms() {
  if (!auth.token) {
    resetPerms();
    return;
  }
  try {
    // api 层已解包，r 就是接口的 data
    const d = (await api.accessMe()) || {};
    permState.loaded = true;
    permState.perms = d.perms || [];
    permState.positionPermissions = d.position_permissions ?? null;
    permState.positionDirect = !!d.position_direct;
    permState.positionName = d.position_name || '';
    permState.denied = d.denied || [];
    permState.roles = d.roles || [];
    permState.isAdmin = !!d.is_admin;
    permState.error = '';
  } catch (e) {
    // 同步失败不阻断业务，退回兜底表（宁可多显示按钮，也不要整页空白）
    permState.error = e.message || '权限同步失败';
  }
}

export function resetPerms() {
  permState.loaded = false;
  permState.perms = [];
  permState.positionPermissions = null;
  permState.positionDirect = false;
  permState.positionName = '';
  permState.denied = [];
  permState.roles = [];
  permState.isAdmin = false;
  permState.error = '';
}

/** 当前账号是否持有某权限点 */
export function can(perm) {
  if (!auth.user) return false;
  if (auth.user.role === 'admin') return true;
  if (permState.loaded) return permState.perms.includes(perm);
  const roles = PERMS[perm];
  if (!roles) return false;
  const mine = permState.roles.length ? permState.roles : [auth.user.role];
  return mine.some((r) => roles.includes(r));
}

/** 是否被岗位复核收回（用于页面上给一句解释，而不是让按钮静默消失） */
export function isRevoked(perm) {
  return permState.loaded && permState.denied.includes(perm);
}

/** 当前账号的岗位集合（主岗 + 附加岗） */
export function myRoles() {
  if (permState.roles.length) return permState.roles;
  return auth.user ? [auth.user.role] : [];
}

/** 普通岗位的按钮权限由 /access/me 同步。旧账号继续使用原角色规则。 */
export function canAction(module, action) {
 if (!auth.user) return false;
 if (auth.user.role === 'admin') return true;
 if (!permState.loaded) return false;
 if (permState.positionPermissions === null) return true;
 return permState.positionPermissions.includes('action.'+module+'.'+action);
}
