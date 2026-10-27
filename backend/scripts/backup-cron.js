/**
 * 定时备份（挂在系统计划任务里跑，不常驻）
 * ============================================================
 * 为什么走 HTTP 而不是直连数据库：
 *   备份的唯一写入者应该是服务进程。如果定时任务也直连库写，
 *   就和主服务抢锁、还要重复实现「VACUUM INTO + 记录 + 保留策略」。
 *   走接口就一句话：调 /api/backup/create。
 *
 * 用法（Windows 任务计划 / Linux crontab）：
 *   BASE=http://127.0.0.1:3000 ADMIN_USER=admin ADMIN_PASS=你的密码 \
 *     node scripts/backup-cron.js
 *
 * 建议每天 02:00 跑一次；保留策略在服务端（auto 类保留最近 15 份）。
 * 退出码：0 成功 / 1 失败（计划任务可据此告警）
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || '';

async function main() {
  if (!PASS) {
    console.error('[backup-cron] 缺少 ADMIN_PASS（不建议把密码写在脚本里，用环境变量传入）');
    process.exit(1);
  }
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })).json();
  if (!lg.ok) {
    console.error('[backup-cron] 登录失败：' + (lg.message || ''));
    process.exit(1);
  }
  const r = await (await fetch(BASE + '/api/backup/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lg.data.token },
    body: JSON.stringify({ note: '定时备份 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') })
  })).json();
  if (!r.ok) {
    console.error('[backup-cron] 备份失败：' + (r.message || ''));
    process.exit(1);
  }
  const j = r.data;
  console.log(`[backup-cron] ✓ ${j.job_no}  ${(j.size_bytes / 1024 / 1024).toFixed(2)} MB / ${j.tables_count} 张表 / ${j.verify_status} / ${j.duration_ms}ms`);
  if (j.verify_status !== 'ok') {
    console.error('[backup-cron] 备份生成后校验未通过，请检查：' + j.verify_note);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[backup-cron] 异常：' + e.message);
  process.exit(1);
});
