/**
 * 从后端权限矩阵生成前端兜底表
 * ============================================================
 * 为什么要生成而不是手写：
 *   前端这份表只用于「还没拿到 /api/access/me」的那几百毫秒（首屏、断网重连）。
 *   手抄两份一定会漂移 —— 之前就出现过前端有按钮、后端 403。
 *   所以让脚本从 backend/src/access/permissions.js 直接生成，
 *   并在冒烟测试里比对两边是否完全一致。
 *
 * 用法：node scripts/sync-frontend-perms.js
 */
const fs = require('fs');
const path = require('path');
const { PERMS, ROLE_LABELS, ROLES } = require('../src/access/permissions');

const OUT = path.resolve(__dirname, '../../frontend/src/store/perm-table.js');

const lines = [];
lines.push('/**');
lines.push(' * 权限兜底表（自动生成，勿手改）');
lines.push(' * 由 backend/scripts/sync-frontend-perms.js 从后端权限矩阵生成。');
lines.push(' * 真正生效的权限以 GET /api/access/me 为准（含一人多岗与用户级收回）。');
lines.push(' */');
lines.push('');
lines.push('export const ROLES = ' + JSON.stringify(ROLES) + ';');
lines.push('');
lines.push('export const ROLE_LABELS = ' + JSON.stringify(ROLE_LABELS, null, 2).replace(/\n/g, '\n') + ';');
lines.push('');
lines.push('export const PERM_TABLE = {');
Object.entries(PERMS).forEach(([k, v]) => {
  lines.push(`  '${k}': ${JSON.stringify(v)},`);
});
lines.push('};');
lines.push('');

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已生成', OUT, '权限点', Object.keys(PERMS).length, '个，角色', ROLES.length, '个');
