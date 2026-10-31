/**
 * 钉钉打卡 → 本系统考勤（attendance）
 * ============================================================
 * 设计要点（每一条都对应一个真会踩的坑）：
 *
 * 1. **两次卡必须合成一行**。钉钉按「排班卡点」返回（上班卡 / 下班卡各一条），
 *    而 attendance 是「一人一天一行」且有 UNIQUE(employee_id,date)。
 *    直接逐条 insert 会撞唯一键；逐条 update 会让后一条盖掉前一条。
 *
 * 2. **先取数、再写库**。所有 HTTP 调用都在事务外完成，拿到完整结果后一个事务写下去。
 *    否则一次 7 天 × 多批的网络请求会把 SQLite 事务开很久，中间任何一次失败都要回滚重来。
 *
 * 3. **不覆盖人工数据**。带「补卡：SR…」这类 remark 的行是人事核对过的结论，
 *    机器打卡没资格盖掉它 —— 只统计 `skipped_manual`，让人能看见"有多少天没同步进去"。
 *
 * 4. **未映射不等于失败**。打卡里出现没绑钉钉 userid 的 userId 时计 `unmatched`，
 *    而不是猜一个人名写进去（写错人的考勤比缺考勤更难发现）。
 *
 * 5. **无效卡要计数**。`isLegal=false` 是迟到未确认/作弊待审的卡，钉钉照样返回；
 *    静默当成正常出勤等于替人做了判断，这里只标注在 remark 里并计数。
 */
const { db, now } = require('../db');
const DT = require('./dingtalk');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

/** 同步写入的行都带这个前缀；判断"是不是机器写的"只看前缀，不看别的字段 */
const SYNC_REMARK = '钉钉同步';

const STATUS_MAP = {
  Normal: 'normal',
  Late: 'late',
  SeriousLate: 'late',
  Absenteeism: 'absent',
  NotSigned: 'absent'
};

/**
 * 时区：钉钉返回的 `workDate` / `userCheckTime` 都是 epoch 毫秒，
 * 而 attendance 存的是**业务本地时间**（`date`=YYYY-MM-DD、`check_in`=HH:mm）。
 *
 * 这里不用 `new Date(ms).getHours()`（那是"服务器时区"）：这台机器/以后换的服务器
 * 时区一变，同样的打卡会算成不同日期，考勤和工资全跟着错。所以按固定偏移换算，
 * 结果与部署环境无关。厂区在 +8；真出现其他时区的人再用 DINGTALK_TZ_OFFSET 调。
 */
const TZ_OFFSET_H = Number(process.env.DINGTALK_TZ_OFFSET || 8);
const TZ_MS = TZ_OFFSET_H * 3600 * 1000;

const dayOf = (ms) => new Date(Number(ms) + TZ_MS).toISOString().slice(0, 10);
const clockOf = (ms) => new Date(Number(ms) + TZ_MS).toISOString().slice(11, 16);

/**
 * 把钉钉的卡点记录聚合成「一人一天一行」
 * 纯函数，不碰数据库 —— 便于用固定报文单独验证（接口对不对是另一件事，映射错了照样全错）
 *
 * @returns {{ rows: Array<{userId,date,check_in,check_out,status,illegal}>, illegal: number }}
 */
function aggregate(records = []) {
  const map = new Map();
  let illegal = 0;

  for (const r of records) {
    const userId = String(r.userId || '').trim();
    const workDate = Number(r.workDate || 0);
    if (!userId || !workDate) continue; // 缺主键的行直接跳过，不猜
    const date = dayOf(workDate);
    const key = `${userId}|${date}`;
    const row = map.get(key) || { userId, date, inMs: 0, outMs: 0, results: [], illegal: 0 };

    const isIllegal = r.isLegal === false || r.isLegal === 'false';
    if (isIllegal) { illegal += 1; row.illegal += 1; }

    const t = Number(r.userCheckTime || 0);
    const isOff = String(r.checkType || '').toLowerCase().includes('off');
    if (t) {
      if (isOff) { if (!row.outMs || t > row.outMs) row.outMs = t; }
      else if (!row.inMs || t < row.inMs) row.inMs = t;
    }

    const st = STATUS_MAP[r.timeResult];
    if (st) row.results.push(st);
    map.set(key, row);
  }

  const rows = [...map.values()].map((r) => {
    // 缺勤优先级最高：只要有一个卡点是缺勤，这天就不是正常出勤
    const status = r.results.includes('absent') ? 'absent'
      : r.results.includes('late') ? 'late' : 'normal';
    return {
      userId: r.userId,
      date: r.date,
      check_in: r.inMs ? clockOf(r.inMs) : null,
      check_out: r.outMs && r.outMs !== r.inMs ? clockOf(r.outMs) : null,
      status,
      illegal: r.illegal
    };
  });
  return { rows, illegal };
}

/**
 * 日期加减一律按 UTC 天数算（只借它做日历运算），结果仍是 YYYY-MM-DD。
 * 用本机 Date 做 `+86400000` 在有夏令时的机器上会少/多一天，而这种 bug
 * 一年只出现两次、每次都像"偶发漏数据"。
 */
const toUtcMs = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const fromUtcMs = (ms) => new Date(ms).toISOString().slice(0, 10);

/** [from, to] 按最多 7 天切片（钉钉硬限制），按自然日 */
function splitWindows(from, to, maxDays = 7) {
  const start = toUtcMs(from);
  const end = toUtcMs(to);
  if (Number.isNaN(start) || Number.isNaN(end)) throw bad('日期格式应为 YYYY-MM-DD');
  if (start > end) throw bad('起始日期不能晚于结束日期');
  const out = [];
  let cur = start;
  while (cur <= end) {
    const candidate = cur + (maxDays - 1) * 86400000;
    const realEnd = candidate > end ? end : candidate;
    out.push({ from: `${fromUtcMs(cur)} 00:00:00`, to: `${fromUtcMs(realEnd)} 23:59:59` });
    cur = realEnd + 86400000;
  }
  return out;
}

function defaultRange(days) {
  const n = Math.max(1, Math.min(7, Number(days) || 3));
  const toMs = toUtcMs(new Date(Date.now() + TZ_MS).toISOString().slice(0, 10));
  return { from: fromUtcMs(toMs - (n - 1) * 86400000), to: fromUtcMs(toMs) };
}

/** 已绑定钉钉 userid 的员工（唯一映射来源，不做姓名/手机号猜测） */
function mappedEmployees() {
  return db.prepare(
    "SELECT id, name, dingtalk_userid FROM employees WHERE IFNULL(TRIM(dingtalk_userid),'') <> '' ORDER BY id"
  ).all();
}

/**
 * 执行同步
 * @param {object} p
 * @param {string} [p.from] YYYY-MM-DD
 * @param {string} [p.to]
 * @param {number} [p.days] 不传 from/to 时回补几天（默认配置 3）
 * @param {boolean} [p.dryRun] 只算不写（用于"先看看会写多少行"）
 * @param {string} [p.operator]
 */
async function sync({ from, to, days, dryRun = false, operator = '' } = {}) {
  DT.assertReady();

  const range = (from && to) ? { from, to } : defaultRange(days || 3);
  const windows = splitWindows(range.from, range.to, 7);

  const emps = mappedEmployees();
  if (!emps.length) {
    throw bad('还没有员工绑定钉钉 userid：先在「员工档案」填钉钉 userid，否则拉到打卡也不知道是谁的', 400);
  }
  const byUserid = new Map(emps.map((e) => [String(e.dingtalk_userid).trim(), e]));
  const userIds = [...byUserid.keys()];

  let runId = null;
  if (!dryRun) {
    runId = db.prepare(
      'INSERT INTO dingtalk_sync_runs (from_date, to_date, ok, api_calls, started_at, operator) VALUES (?,?,0,0,?,?)'
    ).run(range.from, range.to, now(), operator || null).lastInsertRowid;
  }

  const stats = {
    from: range.from, to: range.to, windows: windows.length,
    employees: emps.length, api_calls: 0,
    inserted: 0, updated: 0, skipped_manual: 0, unmatched: 0, illegal: 0,
    unmatched_userids: [], dry_run: !!dryRun
  };

  try {
    /* ---------- 第一步：取数（所有网络请求都在事务外） ---------- */
    /**
     * 先把原始记录全部收集起来，**最后统一聚合一次**。
     *
     * 这里踩过：起初是"每页调一次 aggregate"，而钉钉是分页返回的 ——
     * 上班卡在第 1 页、下班卡在第 2 页时，聚合出两行同日期、各只有一半的数据，
     * 后写的那行把前一行的 check_in 覆盖成 null（表现是"有下班卡没上班卡"）。
     * 每页 50 条时，只有当某人某天记录跨页才复现，属于典型的"数据一多就坏"。
     */
    const raw = [];
    /**
     * 必须按 userid 分批（≤50/次）。2026-10-31 真凭据实测：不传 userIdList 时钉钉返回
     * 850001"单次数据量过大"——它会当成"要全公司所有人的数据"。
     * 代价是**看不到没绑定的人打了卡**，漏绑只能靠 status 里的未映射名单发现。
     */
    for (const w of windows) {
      for (let i = 0; i < userIds.length; i += 50) {
        const batch = userIds.slice(i, i + 50);
        let offset = 0;
        for (;;) {
          const { records, hasMore } = await DT.listResults({
            from: w.from, to: w.to, userIdList: batch, offset, limit: 50
          });
          stats.api_calls += 1;
          if (records.length) raw.push(...records);
          if (!hasMore || !records.length) break;
          offset += records.length;
        }
      }
    }

    const agg = aggregate(raw);
    stats.illegal = agg.illegal;
    const pending = [];
    for (const row of agg.rows) {
      const emp = byUserid.get(row.userId);
      if (!emp) {
        stats.unmatched += 1;
        if (!stats.unmatched_userids.includes(row.userId)) stats.unmatched_userids.push(row.userId);
        continue;
      }
      pending.push({ emp, row });
    }

    /* ---------- 第二步：写库（单事务，校验已完成） ---------- */
    const apply = () => {
      const findStmt = db.prepare('SELECT id, remark FROM attendance WHERE employee_id = ? AND date = ?');
      const insStmt = db.prepare(
        'INSERT INTO attendance (employee_id, employee_name, date, check_in, check_out, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?)'
      );
      const updStmt = db.prepare('UPDATE attendance SET check_in=?, check_out=?, status=?, remark=? WHERE id=?');
      for (const { emp, row } of pending) {
        const exist = findStmt.get(emp.id, row.date);
        const remark = row.illegal ? `${SYNC_REMARK}（含无效卡 ${row.illegal} 条）` : SYNC_REMARK;
        if (!exist) {
          insStmt.run(emp.id, emp.name, row.date, row.check_in, row.check_out, row.status, remark, now());
          stats.inserted += 1;
        } else if (!String(exist.remark || '').startsWith(SYNC_REMARK)) {
          // 人工录入 / 补卡：保留原样。这不是"同步失败"，是"人已经处理过了"
          stats.skipped_manual += 1;
        } else {
          updStmt.run(row.check_in, row.check_out, row.status, remark, exist.id);
          stats.updated += 1;
        }
      }
    };

    if (dryRun) {
      // 干跑：只统计"会写多少行 / 会跳过多少"，不落库
      const findStmt = db.prepare('SELECT id, remark FROM attendance WHERE employee_id = ? AND date = ?');
      for (const { emp, row } of pending) {
        const exist = findStmt.get(emp.id, row.date);
        if (!exist) stats.inserted += 1;
        else if (!String(exist.remark || '').startsWith(SYNC_REMARK)) stats.skipped_manual += 1;
        else stats.updated += 1;
      }
    } else {
      db.exec('BEGIN IMMEDIATE');
      try {
        apply();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    if (runId) {
      db.prepare(
        `UPDATE dingtalk_sync_runs SET ok=1, inserted=?, updated=?, skipped_manual=?, unmatched=?, illegal=?, api_calls=?, finished_at=? WHERE id=?`
      ).run(stats.inserted, stats.updated, stats.skipped_manual, stats.unmatched, stats.illegal, stats.api_calls, now(), runId);
    }
    stats.run_id = runId;
    return stats;
  } catch (e) {
    if (runId) {
      db.prepare('UPDATE dingtalk_sync_runs SET ok=0, error=?, api_calls=?, finished_at=? WHERE id=?')
        .run(String(e.message || e).slice(0, 300), stats.api_calls, now(), runId);
    }
    throw e;
  }
}

/** 自检用：取一个已映射的 userid（有就贴近真实调用，没有就用占位串验证权限） */
function probeUserIds() {
  const one = db.prepare(
    "SELECT dingtalk_userid FROM employees WHERE IFNULL(TRIM(dingtalk_userid),'') <> '' LIMIT 1"
  ).get();
  return one ? [String(one.dingtalk_userid).trim()] : [];
}

function recentRuns(limit = 20) {
  return db.prepare(
    `SELECT id, from_date, to_date, ok, inserted, updated, skipped_manual, unmatched, illegal, api_calls, error, started_at, finished_at, operator
       FROM dingtalk_sync_runs ORDER BY id DESC LIMIT ?`
  ).all(Math.max(1, Math.min(200, Number(limit) || 20)));
}

function status() {
  const maps = mappedEmployees();
  const total = db.prepare("SELECT COUNT(*) c FROM employees WHERE IFNULL(status,'active') <> 'left'").get().c;
  const last = recentRuns(1)[0] || null;
  return {
    configured: DT.ready(),
    base_url: DT.base(),
    employees_total: total,
    employees_mapped: maps.length,
    employees_unmapped: Math.max(0, total - maps.length),
    last_run: last,
    unmapped_sample: db.prepare(
      "SELECT id, code, name FROM employees WHERE IFNULL(status,'active') <> 'left' AND IFNULL(TRIM(dingtalk_userid),'') = '' ORDER BY id LIMIT 20"
    ).all()
  };
}

/** 绑定 / 解绑员工的钉钉 userid（手工映射，唯一入口） */
function mapEmployee({ employee_id, dingtalk_userid }) {
  const id = Number(employee_id);
  if (!id) throw bad('缺少员工');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!emp) throw bad('员工不存在', 404);
  const uid = String(dingtalk_userid || '').trim();
  if (uid) {
    // 一个 userid 只能属于一个员工，否则打卡会被写到两个人头上
    const taken = db.prepare('SELECT id, name FROM employees WHERE dingtalk_userid = ? AND id <> ?').get(uid, id);
    if (taken) throw bad(`该钉钉 userid 已绑定在「${taken.name}」上，请先解绑`, 409);
  }
  db.prepare('UPDATE employees SET dingtalk_userid = ? WHERE id = ?').run(uid || null, id);
  return { employee_id: id, name: emp.name, dingtalk_userid: uid || null };
}

module.exports = { aggregate, splitWindows, defaultRange, sync, status, recentRuns, mapEmployee, probeUserIds, SYNC_REMARK, STATUS_MAP };
