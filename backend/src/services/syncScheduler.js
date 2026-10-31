/**
 * 钉钉考勤「定时同步」调度器（进程内）
 *
 * 为什么要进程内定时器：
 *   本机 `schtasks.exe` 被安全策略禁用，新建 Windows 计划任务又要管理员权限；
 *   而服务本身是常驻的（守护进程 + 开机任务），所以在服务进程里定时是唯一可持续的做法。
 *   代价是"服务没跑时不会同步"—— 但这正是要的：服务停着的时候也拉不到数据。
 *
 * 三个必须做对的点（都踩过或必然会踩）：
 *
 * 1. **时段幂等**：一个时段只能跑一次。
 *    用 `app_config` 的主键做原子占位（`INSERT OR IGNORE`）——
 *    两个实例同时到点、或重启后又走一遍，只有第一个能插入成功。
 *    只靠"上次跑完的时间"判断是不够的：两个进程会同时读到同一个旧值，然后都去跑。
 *
 * 2. **补跑要有窗口**：服务在 12:00 前后重启会漏掉那一次。
 *    窗口内（默认 6 小时）补一次；超出窗口就不补 ——
 *    半夜重启把中午的账补到晚上，数据看着对、时间不对，比不补更难发现。
 *
 * 3. **不阻塞、不抛异常**：定时任务失败不能影响主进程。
 *    单次失败只记日志，下一时段照常；连续失败也不重启服务（那是守护进程的事）。
 */
const { db, now } = require('../db');
const config = require('../config');
const attendanceSync = require('./attendanceSync');

const KEY_PREFIX = 'cron:dt-sync:';
const TICK_MS = 60 * 1000;
const KEEP_DAYS = 30;

let timer = null;
let startedAt = null;
let lastResult = null;   // { at, slot, ok, error, stats }
let running = false;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/** '12:00,00:00' → [{hh:12,mm:0,label:'12:00'}, ...]，非法项丢掉并去重排序 */
function parseSlots(text) {
  const out = [];
  String(text || '').split(',').forEach((raw) => {
    const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return;
    const label = `${pad(hh)}:${pad(mm)}`;
    if (!out.some((x) => x.label === label)) out.push({ hh, mm, label });
  });
  return out.sort((a, b) => (a.hh * 60 + a.mm) - (b.hh * 60 + b.mm));
}

/**
 * 某个时段最近一次「已到点」的时刻（含当天）。
 * 今天还没到 → 取昨天那次。
 */
function lastOccurrence(slot, at) {
  const d = new Date(at.getTime());
  d.setHours(slot.hh, slot.mm, 0, 0);
  if (d.getTime() > at.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * 现在该跑哪个时段？纯函数，可单测。
 * 返回 { slot, at } 或 null：
 *   - 在补跑窗口内才有值（窗口外一律跳过）
 *   - 多个时段都过期时只取**最近的那一个**，不把几天的账一次性补跑
 */
function dueSlot(at = new Date(), slots = parseSlots(config.dingtalk.syncSchedule),
  catchupHours = config.dingtalk.syncCatchupHours) {
  if (!slots.length) return null;
  let best = null;
  for (const s of slots) {
    const occ = lastOccurrence(s, at);
    if (!best || occ.getTime() > best.at.getTime()) best = { slot: s, at: occ };
  }
  if (!best) return null;
  const ageMs = at.getTime() - best.at.getTime();
  if (ageMs < 0) return null;
  if (ageMs > catchupHours * 3600 * 1000) return null;
  return best;
}

/** 时段键：本地时间，20261031-1200 */
function slotKey(at) {
  return KEY_PREFIX + dayKey(at) + '-' + pad(at.getHours()) + pad(at.getMinutes());
}

/**
 * 原子占位。返回 true = 这个时段归我跑。
 * `app_config.key` 是主键，所以这个是跨进程安全的。
 */
function claim(at) {
  const key = slotKey(at);
  const info = db.prepare(
    'INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?,?,?)'
  ).run(key, new Date().toISOString(), now());
  return info.changes === 1;
}

/** 放宽/放弃占位：本次跑失败时把键删掉，让下个 tick 还能补（否则这个时段永久废掉） */
function release(at) {
  try {
    db.prepare('DELETE FROM app_config WHERE key = ?').run(slotKey(at));
  } catch (e) { /* 释放失败不该盖住原始错误 */ }
}

function pruneOld() {
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000);
    const cutoffKey = KEY_PREFIX + dayKey(cutoff);
    db.prepare('DELETE FROM app_config WHERE key LIKE ? AND key < ?').run(KEY_PREFIX + '%', cutoffKey);
  } catch (e) { /* 清理失败不影响同步 */ }
}

/** 跑一次（内部用；不抛异常，结果记在 lastResult） */
async function runSlot(due) {
  const label = `${due.at.getFullYear()}-${pad(due.at.getMonth() + 1)}-${pad(due.at.getDate())} ${due.slot.label}`;
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const stats = await attendanceSync.sync({
      days: config.dingtalk.syncDays,
      operator: `cron ${due.slot.label}`
    });
    lastResult = { at: new Date().toISOString(), slot: label, ok: true, stats };
    console.log(`[sync] 定时同步完成 ${label}：新增 ${stats.inserted} / 更新 ${stats.updated}`
      + ` / 跳过人工 ${stats.skipped_manual} / 未匹配 ${stats.unmatched}`);
    return { ok: true, stats };
  } catch (e) {
    lastResult = { at: new Date().toISOString(), slot: label, ok: false, error: String(e.message || e) };
    console.error(`[sync] 定时同步失败 ${label}：${e.message || e}`);
    release(due.at);   // 让后续 tick 还能补这一次
    return { ok: false, error: String(e.message || e) };
  } finally {
    running = false;
  }
}

/** 每分钟看一眼；到点且未被占用就跑一次 */
async function tick(at = new Date()) {
  const due = dueSlot(at);
  if (!due) return { skipped: 'not-due' };
  if (!claim(due.at)) return { skipped: 'already-claimed' };
  // 凭据没配就当没这回事：接口自身会 409，但定时器每天叫两次没人看就没意义
  try {
    if (!require('./dingtalk').ready()) {
      release(due.at);
      return { skipped: 'not-configured' };
    }
  } catch (e) {
    release(due.at);
    return { skipped: 'not-configured' };
  }
  return runSlot(due);
}

function start() {
  if (!config.dingtalk.scheduleEnabled) {
    console.log('[sync] 定时同步已关闭（ERP_SCHEDULER=0）');
    return false;
  }
  const slots = parseSlots(config.dingtalk.syncSchedule);
  if (!slots.length) {
    console.log('[sync] 定时同步未启动：DINGTALK_SYNC_SCHEDULE 里没有合法时段');
    return false;
  }
  if (timer) return true;
  startedAt = new Date();
  pruneOld();
  console.log(`[sync] 定时同步已启动：每天 ${slots.map((s) => s.label).join(' / ')}`
    + `（补跑窗口 ${config.dingtalk.syncCatchupHours}h，回补 ${config.dingtalk.syncDays} 天）`);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  // 启动后 10 秒先看一眼：多半是"刚好错过了时段"，这一步把补跑做掉
  const boot = setTimeout(() => { tick().catch(() => {}); }, 10 * 1000);
  if (boot.unref) boot.unref();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  return {
    enabled: !!timer,
    started_at: startedAt ? startedAt.toISOString() : null,
    schedule: parseSlots(config.dingtalk.syncSchedule).map((s) => s.label),
    catchup_hours: config.dingtalk.syncCatchupHours,
    sync_days: config.dingtalk.syncDays,
    last: lastResult
  };
}

module.exports = { parseSlots, lastOccurrence, dueSlot, slotKey, claim, release, tick, start, stop, status };
