/** 交期按本地日历计算，历史日期编辑不因六个预设选项而改变。 */
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
(async () => {
  if (!process.argv.includes('--timezone')) {
    for (const timezone of ['Asia/Shanghai', 'America/New_York', 'Pacific/Auckland']) {
      const result = spawnSync(process.execPath, [__filename, '--timezone'], { env: { ...process.env, TZ: timezone }, windowsHide: true, encoding: 'utf8' });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      assert.equal(result.status, 0, timezone);
    }
    return;
  }
  const { preOrderDeliveryDays: days, preOrderTargetDate: target, preOrderDeliveryChoice: choice } = await import('../../frontend/src/utils/preOrderDelivery.js');
  assert.deepEqual(days, [10, 17, 20, 27, 30, 35]);
  assert.equal(target('2026-11-07', 10), '2026-11-17');
  assert.equal(target('2026-01-25', 10), '2026-02-04');
  assert.equal(target('2028-02-20', 10), '2028-03-01');
  assert.equal(target('2026-03-02', 17), '2026-03-19');
  assert.equal(target('2026-10-25', 17), '2026-11-11');
  assert.equal(target('2026-12-20', 17), '2027-01-06');
  for (const duration of days) assert.equal(choice('2026-11-07', target('2026-11-07', duration)), duration);
  assert.equal(choice('2026-11-07', ''), '');
  assert.equal(choice('2026-11-07', '2026-12-31'), 'existing');
  assert.equal(target('2026-02-30', 10), '');
  assert.equal(target('', 10), '');
  assert.equal(target('2026-11-07', ''), '');
  assert.equal(target('2026-11-07', 15), '');
  console.log('PASS 19 delivery assertions (' + process.env.TZ + ')');
})().catch(error => { console.error(error); process.exitCode = 1; });
