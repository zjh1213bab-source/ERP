/**
 * 演示数据标记
 *
 * 演示脚本写入的数据用「演示·」前缀标记，方便重复执行时精确清理。
 * 但它是给数据库看的，不是给用户看的 —— 展示层要剥掉，
 * 否则客户拿到的验货报告里会出现「演示·左袖口跳线」这种字样。
 */
const DEMO_PREFIX = /^演示[·:：]\s*/;

function stripDemo(s) {
  if (!s) return s;
  return String(s).replace(DEMO_PREFIX, '');
}

module.exports = { DEMO_PREFIX, stripDemo };
