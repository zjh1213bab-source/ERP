import { localDate } from './time.js';

export const preOrderDeliveryDays = [10, 17, 20, 27, 30, 35];

/** 按本地日历加天数，避免 UTC 截断及夏令时造成交期偏移。 */
export function preOrderTargetDate(base, days) {
  if (!preOrderDeliveryDays.includes(Number(days))) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(base || '');
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (localDate(date) !== base) return '';
  date.setDate(date.getDate() + Number(days));
  return localDate(date);
}

export function preOrderDeliveryChoice(base, target) {
  if (!target) return '';
  return preOrderDeliveryDays.find(days => preOrderTargetDate(base, days) === target) ?? 'existing';
}
