#!/usr/bin/env node
/**
 * 钉钉考勤同步 —— 命令行入口（给计划任务 / 守护调用，不需要登录态）
 * ============================================================
 * 为什么不走 HTTP：定时任务里要调接口就得带 token（管理员口令或长期密钥），
 * 那串东西会落到计划任务的动作字符串、任务历史、以及任何能看任务定义的人手里。
 * 直接在数据库所在机器上跑进程，只依赖 .env 里的钉钉凭据，不引入第二个口令。
 *
 * 用法：
 *   node scripts/sync-attendance.js                # 回补最近 3 天（DINGTALK_SYNC_DAYS）
 *   node scripts/sync-attendance.js --days=7       # 回补 7 天
 *   node scripts/sync-attendance.js --from=2026-10-01 --to=2026-10-15
 *   node scripts/sync-attendance.js --dry-run      # 只算不写，看会写多少行
 *
 * 退出码：0 成功 / 1 出错 / 3 凭据未配置（计划任务里可据此不必报警）
 */
const attendanceSync = require('../src/services/attendanceSync');

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

(async () => {
  const days = arg('days');
  const dryRun = !!arg('dry-run');
  const from = arg('from');
  const to = arg('to');

  try {
    const r = await attendanceSync.sync({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      days: days ? Number(days) : undefined,
      dryRun,
      operator: 'cron'
    });
    // 结构化输出，方便计划任务把结果直接贴进日志
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
    process.exit(0);
  } catch (e) {
    const code = e.code === 'DINGTALK_NOT_CONFIGURED' ? 3 : 1;
    console.error(`[考勤同步失败] ${e.message || e}`);
    if (code === 3) {
      console.error('  处理：在 backend/.env 填 DINGTALK_APP_KEY / DINGTALK_APP_SECRET，重启服务后再试');
    } else {
      console.error('  排查：看 backend/data/logs 下服务日志；「/api/integration/dingtalk/runs」有每次失败原因');
    }
    process.exit(code);
  }
})();
