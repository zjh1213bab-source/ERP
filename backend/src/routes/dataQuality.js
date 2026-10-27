/**
 * 数据质量与业务勾稽
 * 原型 TS-N16-02（数据质量与业务勾稽）
 *
 * 硬规则：
 * 1. **勾稽给判定不给感觉**：每条问题必须写明期望值 / 实际值 / 差额
 * 2. **自动修复只做重算**：余额、汇总、状态位这类能由明细推导的才允许一键修；
 *    数量认定、单据归属一律转人工（fixable=0）
 * 3. **修复必留痕**：修前修后落 dq_fixes，可追谁在何时把哪个数改成了什么
 * 4. **同问题不重复计数**：fingerprint 唯一，跨批次复用；消失转 fixed，再现记 recur
 * 5. **忽略要有理由和期限**：必须写原因，可设到期日，到期自动重新生效
 * 6. **勾稽不阻止业务**：本模块只出判定与修复建议，不阻断下单/发货/结单
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { RULES, FIXERS, byCode, orderQty, r2, num } = require('../services/dqRules');
const { localNow, localDate } = require('../services/sla');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'sales', 'finance'];
const ADMIN = ['admin'];

const SEV_W = { error: 3, warn: 1, info: 0.25 };
const SEV_CAP = { error: 35, warn: 22, info: 6 };

/** 规则入库同步（幂等）：把内置规则写进 dq_rules，保留人工改过的 enabled */
function syncRules() {
  const t = localNow();
  const ins = db.prepare(
    `INSERT INTO dq_rules (code,name,category,kind,severity,desc_text,suggest,fixable,fix_key,sort_no,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name=excluded.name, category=excluded.category, kind=excluded.kind,
       severity=excluded.severity, desc_text=excluded.desc_text, suggest=excluded.suggest,
       fixable=excluded.fixable, fix_key=excluded.fix_key, sort_no=excluded.sort_no,
       updated_at=excluded.updated_at`
  );
  RULES.forEach((r) => {
    ins.run(
      r.code, r.name, r.category, r.kind, r.severity, r.desc || '', r.suggest || '',
      r.fixable ? 1 : 0, r.fix_key || null, r.sort_no || 0, t, t
    );
  });
}
syncRules();

/**
 * 健康分：100 - 扣分，每档封顶（问题再多也不会把分数打到 0，避免「一片红」失去指示意义）
 * error 最重、warn 次之、info 只做提示；同一档超过上限不再累加。
 */
function healthOf(error, warn, info) {
  const p =
    Math.min(SEV_CAP.error, error * SEV_W.error) +
    Math.min(SEV_CAP.warn, warn * SEV_W.warn) +
    Math.min(SEV_CAP.info, info * SEV_W.info);
  return Math.round(Math.max(0, 100 - p) * 10) / 10;
}
function fpOf(code, it) {
  return `${code}|${it.entity_type || '-'}:${it.entity_id == null ? '-' : it.entity_id}|${it.field || '-'}`;
}

/** ==================== 规则列表 ==================== */
router.get('/rules', authRequired, requireRole(...READ), (req, res) => {
  const rows = db.prepare('SELECT * FROM dq_rules ORDER BY sort_no, code').all();
  ok(res, rows.map((r) => ({ ...r, desc: r.desc_text, fixable: !!r.fixable, enabled: !!r.enabled })));
});

router.put('/rules/:code', authRequired, requireRole(...ADMIN), (req, res) => {
  const r = db.prepare('SELECT * FROM dq_rules WHERE code=?').get(req.params.code);
  if (!r) return fail(res, 404, '规则不存在');
  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare('UPDATE dq_rules SET enabled=?, updated_at=? WHERE id=?').run(enabled, localNow(), r.id);
  ok(res, { code: r.code, enabled: !!enabled });
});

/** ==================== 执行勾稽 ==================== */
/**
 * POST /api/dq/run
 * body: { codes?: string[], scope?: 'all'|'balance'|'quality' }
 */
router.post(
  '/run',
  authRequired,
  requireRole(...WRITE),
  wrap(async (req, res) => {
    const { codes, scope = 'all' } = req.body || {};
    const t0 = Date.now();
    const t = localNow();

    const enabledMap = {};
    db.prepare('SELECT code, enabled FROM dq_rules').all().forEach((r) => {
      enabledMap[r.code] = !!r.enabled;
    });

    let picked = RULES.filter((r) => enabledMap[r.code] !== false);
    if (Array.isArray(codes) && codes.length) picked = picked.filter((r) => codes.includes(r.code));
    else if (scope === 'balance' || scope === 'quality') picked = picked.filter((r) => r.kind === scope);
    if (!picked.length) return fail(res, 400, '没有可执行的勾稽规则');

    const seq = db.prepare('SELECT COUNT(*) c FROM dq_runs').get().c + 1;
    const runNo = genNo('GJ', seq);
    const operator = req.user?.name || req.user?.username || 'system';

    const runId = db
      .prepare(
        `INSERT INTO dq_runs (run_no,scope,trigger_by,operator,rule_count,status,created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(runNo, Array.isArray(codes) && codes.length ? codes.join(',') : scope, 'manual', operator, picked.length, 'running', t).lastInsertRowid;

    // 上一批次的问题集合（用于 new / fixed / recur 判定）
    const prevRun = db.prepare("SELECT id FROM dq_runs WHERE id<>? AND status='done' ORDER BY id DESC LIMIT 1").get(runId);
    const prevFps = new Map();
    if (prevRun) {
      db.prepare('SELECT fingerprint, status, id FROM dq_issues WHERE run_id=?').all(prevRun.id).forEach((r) => {
        prevFps.set(r.fingerprint, r);
      });
    } else {
      db.prepare('SELECT fingerprint, status, id FROM dq_issues').all().forEach((r) => prevFps.set(r.fingerprint, r));
    }

    const found = [];
    const ruleErrors = [];
    picked.forEach((rule) => {
      let list = [];
      try {
        list = rule.run() || [];
      } catch (e) {
        ruleErrors.push(`${rule.code}: ${e.message}`);
        return;
      }
      // 同类问题过多时合并，避免刷屏（超出部分汇总成一条）
      if (rule.limit && list.length > rule.limit) {
        const total = list.length;
        const extra = total - rule.limit;
        list = list.slice(0, rule.limit);
        list.push({
          entity_type: 'rule',
          entity_id: null,
          entity_no: rule.code,
          field: 'overflow',
          expect: `共 ${total} 条`,
          actual: `仅列前 ${rule.limit} 条`,
          diff: extra,
          message: `另有 ${extra} 条同类问题未逐条列出（同类合并，可在问题明细按规则筛选后处理）`
        });
      }
      list.forEach((it) => {
        found.push({
          rule,
          it,
          fingerprint: fpOf(rule.code, it),
          severity: it.severity || rule.severity
        });
      });
    });

    // 有效忽略白名单
    const today = localDate();
    const ignores = new Map();
    db.prepare('SELECT * FROM dq_ignores').all().forEach((r) => {
      if (r.expire_at && String(r.expire_at).slice(0, 10) < today) return; // 到期失效
      ignores.set(r.fingerprint, r);
    });

    let error_cnt = 0;
    let warn_cnt = 0;
    let info_cnt = 0;
    let fixable_cnt = 0;
    let new_cnt = 0;
    let recur_cnt = 0;
    const seenFps = new Set();

    db.exec('BEGIN');
    try {
      const findOne = db.prepare('SELECT * FROM dq_issues WHERE fingerprint=?');
      const upd = db.prepare(
        `UPDATE dq_issues SET run_id=?, rule_name=?, category=?, kind=?, severity=?, entity_no=?,
           expect_val=?, actual_val=?, diff_val=?, message=?, fixable=?, fix_key=?, fix_action=?,
           status=?, last_seen_at=?, seen_cnt=seen_cnt+1, fixed_at=NULL, fixed_by=NULL, detail_json=?
         WHERE id=?`
      );
      const ins = db.prepare(
        `INSERT INTO dq_issues (run_id,rule_code,rule_name,category,kind,severity,entity_type,entity_id,
           entity_no,field,expect_val,actual_val,diff_val,message,fixable,fix_key,fix_action,status,
           fingerprint,first_seen_at,last_seen_at,seen_cnt,detail_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );

      found.forEach(({ rule, it, fingerprint, severity }) => {
        seenFps.add(fingerprint);
        const existing = findOne.get(fingerprint);
        const ign = ignores.get(fingerprint);
        let entryStatus = 'open';
        if (ign) entryStatus = 'ignored';

        let isNew = false;
        let isRecur = false;
        if (!existing) {
          isNew = true;
          ins.run(
            runId, rule.code, rule.name, rule.category, rule.kind, severity, it.entity_type || null,
            it.entity_id == null ? null : it.entity_id, it.entity_no || null, it.field || null,
            it.expect, it.actual, it.diff, it.message, rule.fixable ? 1 : 0, rule.fix_key || null,
            rule.fixable ? `按明细重算（${rule.fix_key}）` : '需人工核对', entryStatus,
            fingerprint, t, t, 1, it.detail ? JSON.stringify(it.detail) : null, t
          );
        } else {
          if (existing.status === 'fixed') isRecur = true;
          upd.run(
            runId, rule.name, rule.category, rule.kind, severity, it.entity_no || null,
            it.expect, it.actual, it.diff, it.message, rule.fixable ? 1 : 0, rule.fix_key || null,
            rule.fixable ? `按明细重算（${rule.fix_key}）` : '需人工核对',
            entryStatus, t, it.detail ? JSON.stringify(it.detail) : null, existing.id
          );
        }
        if (isNew) new_cnt += 1;
        if (isRecur) recur_cnt += 1;

        // 忽略的不计入健康统计
        if (entryStatus === 'open') {
          if (severity === 'error') error_cnt += 1;
          else if (severity === 'warn') warn_cnt += 1;
          else info_cnt += 1;
          if (rule.fixable) fixable_cnt += 1;
        }
      });

      // 上次有、本次消失 → 计为「已消除」；仍 open 的顺手转 fixed
      // 注意：只统计本次实际检查过的规则，否则「只跑账账对齐」会把没查的数据质量问题算成已消除
      const pickedCodes = new Set(picked.map((r) => r.code));
      let fixed_cnt = 0;
      prevFps.forEach((v, fp) => {
        if (seenFps.has(fp)) return;
        const cur = findOne.get(fp);
        if (!cur) return;
        if (!pickedCodes.has(cur.rule_code)) return;
        if (cur.status === 'open') {
          db.prepare("UPDATE dq_issues SET status='fixed', fixed_at=?, fixed_by='auto-detect' WHERE id=?").run(t, cur.id);
          fixed_cnt += 1;
        } else if (cur.status === 'fixed') {
          // 本批次执行前已被人修掉（fix-all / 单条修复），同样算已消除
          fixed_cnt += 1;
        }
      });

      const health = healthOf(error_cnt, warn_cnt, info_cnt);
      db.prepare(
        `UPDATE dq_runs SET issue_count=?, error_cnt=?, warn_cnt=?, info_cnt=?, fixable_cnt=?,
           new_cnt=?, fixed_cnt=?, recur_cnt=?, health=?, duration_ms=?, status='done', note=?
         WHERE id=?`
      ).run(
        error_cnt + warn_cnt + info_cnt, error_cnt, warn_cnt, info_cnt, fixable_cnt,
        new_cnt, fixed_cnt, recur_cnt, health, Date.now() - t0,
        ruleErrors.length ? `规则异常：${ruleErrors.join('; ')}` : null, runId
      );

      // 规则命中数回写
      const hit = {};
      found.forEach((f) => { hit[f.rule.code] = (hit[f.rule.code] || 0) + 1; });
      Object.keys(hit).forEach((c) => db.prepare('UPDATE dq_rules SET last_hit=? WHERE code=?').run(hit[c], c));

      db.exec('COMMIT');

      ok(res, {
        run_id: runId,
        run_no: runNo,
        rule_count: picked.length,
        issue_count: error_cnt + warn_cnt + info_cnt,
        error_cnt, warn_cnt, info_cnt, fixable_cnt,
        new_cnt, fixed_cnt, recur_cnt, health,
        duration_ms: Date.now() - t0,
        rule_errors: ruleErrors
      });
    } catch (e) {
      db.exec('ROLLBACK');
      db.prepare("UPDATE dq_runs SET status='failed', note=? WHERE id=?").run(String(e.message || e), runId);
      throw e;
    }
  })
);

/** ==================== 历史批次 ==================== */
router.get('/runs', authRequired, requireRole(...READ), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = db.prepare('SELECT * FROM dq_runs ORDER BY id DESC LIMIT ?').all(limit);
  ok(res, rows);
});

router.get('/runs/:id', authRequired, requireRole(...READ), (req, res) => {
  const run = db.prepare('SELECT * FROM dq_runs WHERE id=?').get(Number(req.params.id));
  if (!run) return fail(res, 404, '批次不存在');
  const issues = db
    .prepare('SELECT * FROM dq_issues WHERE run_id=? ORDER BY severity, rule_code, id')
    .all(run.id);
  const groups = {};
  issues.forEach((i) => {
    const k = i.rule_code;
    if (!groups[k]) {
      groups[k] = { rule_code: k, rule_name: i.rule_name, category: i.category, kind: i.kind, count: 0, issues: [] };
    }
    groups[k].count += 1;
    groups[k].issues.push(i);
  });
  ok(res, { run, groups: Object.values(groups) });
});

/** ==================== 问题列表 ==================== */
router.get('/issues', authRequired, requireRole(...READ), (req, res) => {
  const { status = 'open', severity, category, rule_code, keyword } = req.query;
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('status=?'); args.push(status); }
  if (severity && severity !== 'all') { where.push('severity=?'); args.push(severity); }
  if (category && category !== 'all') { where.push('category=?'); args.push(category); }
  if (rule_code) { where.push('rule_code=?'); args.push(rule_code); }
  if (keyword) { where.push('(entity_no LIKE ? OR message LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`); }
  const sql = `SELECT * FROM dq_issues ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen_at DESC, id DESC
               LIMIT 500`;
  const rows = db.prepare(sql).all(...args);
  const stat = db.prepare(
    `SELECT severity, COUNT(*) c FROM dq_issues WHERE status='open' GROUP BY severity`
  ).all();
  ok(res, { rows, stat });
});

/** ==================== 单条修复 ==================== */
router.post(
  '/issues/:id/fix',
  authRequired,
  requireRole(...WRITE),
  wrap(async (req, res) => {
    const issue = db.prepare('SELECT * FROM dq_issues WHERE id=?').get(Number(req.params.id));
    if (!issue) return fail(res, 404, '问题不存在');
    if (!issue.fixable) return fail(res, 400, '该问题需人工核对，不支持自动修复');
    const fixer = FIXERS[issue.fix_key];
    if (!fixer) return fail(res, 400, `未实现的修复器：${issue.fix_key}`);
    const operator = req.user?.name || req.user?.username || 'system';
    const t = localNow();

    let ret;
    try {
      db.exec('BEGIN');
      ret = fixer(issue);
      if (ret?.skip) {
        db.exec('ROLLBACK');
        db.prepare(
          `INSERT INTO dq_fixes (run_id,issue_id,fingerprint,fix_key,target,before_json,after_json,result,message,operator,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(issue.run_id, issue.id, issue.fingerprint, issue.fix_key, `${issue.entity_type}:${issue.entity_id}`,
          null, null, 'skip', ret.skip, operator, t);
        return fail(res, 409, ret.skip);
      }
      db.prepare("UPDATE dq_issues SET status='fixed', fixed_at=?, fixed_by=? WHERE id=?").run(t, operator, issue.id);
      db.prepare(
        `INSERT INTO dq_fixes (run_id,issue_id,fingerprint,fix_key,target,before_json,after_json,result,message,operator,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(issue.run_id, issue.id, issue.fingerprint, issue.fix_key, `${issue.entity_type}:${issue.entity_id}`,
        JSON.stringify(ret.before || null), JSON.stringify(ret.after || null), 'ok', ret.message || '', operator, t);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    ok(res, { id: issue.id, status: 'fixed', result: ret });
  })
);

/** ==================== 批量修复（本批次） ==================== */
router.post(
  '/runs/:id/fix-all',
  authRequired,
  requireRole(...WRITE),
  wrap(async (req, res) => {
    const runId = Number(req.params.id);
    const issues = db
      .prepare("SELECT * FROM dq_issues WHERE run_id=? AND status='open' AND fixable=1 ORDER BY id")
      .all(runId);
    if (!issues.length) return ok(res, { fixed: 0, skipped: 0, failed: 0, details: [] });

    const operator = req.user?.name || req.user?.username || 'system';
    const t = localNow();
    let fixed = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const issue of issues) {
      const fixer = FIXERS[issue.fix_key];
      if (!fixer) { skipped += 1; details.push({ id: issue.id, result: 'skip', message: '无修复器' }); continue; }
      try {
        db.exec('BEGIN');
        const ret = fixer(issue);
        if (ret?.skip) {
          db.exec('ROLLBACK');
          skipped += 1;
          details.push({ id: issue.id, result: 'skip', message: ret.skip });
          continue;
        }
        db.prepare("UPDATE dq_issues SET status='fixed', fixed_at=?, fixed_by=? WHERE id=?").run(t, operator, issue.id);
        db.prepare(
          `INSERT INTO dq_fixes (run_id,issue_id,fingerprint,fix_key,target,before_json,after_json,result,message,operator,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(runId, issue.id, issue.fingerprint, issue.fix_key, `${issue.entity_type}:${issue.entity_id}`,
          JSON.stringify(ret.before || null), JSON.stringify(ret.after || null), 'ok', ret.message || '', operator, t);
        db.exec('COMMIT');
        fixed += 1;
        details.push({ id: issue.id, result: 'ok', message: ret.message });
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        failed += 1;
        details.push({ id: issue.id, result: 'fail', message: String(e.message || e) });
      }
    }
    ok(res, { fixed, skipped, failed, details });
  })
);

/** ==================== 忽略 / 恢复 ==================== */
router.post('/issues/:id/ignore', authRequired, requireRole(...WRITE), (req, res) => {
  const issue = db.prepare('SELECT * FROM dq_issues WHERE id=?').get(Number(req.params.id));
  if (!issue) return fail(res, 404, '问题不存在');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '忽略必须填写至少 4 个字的理由');
  const days = Number(req.body?.days) || 0;
  const t = localNow();
  const expire = days > 0 ? localNow(new Date(Date.now() + days * 86400000)).slice(0, 10) : null;

  db.prepare(
    `INSERT INTO dq_ignores (fingerprint,rule_code,entity_no,reason,created_by,expire_at,created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(fingerprint) DO UPDATE SET reason=excluded.reason, created_by=excluded.created_by,
       expire_at=excluded.expire_at, created_at=excluded.created_at`
  ).run(issue.fingerprint, issue.rule_code, issue.entity_no, reason, req.user?.name || req.user?.username, expire, t);
  db.prepare("UPDATE dq_issues SET status='ignored', ignore_reason=? WHERE id=?").run(reason, issue.id);
  ok(res, { id: issue.id, status: 'ignored', expire_at: expire });
});

router.post('/issues/:id/reopen', authRequired, requireRole(...WRITE), (req, res) => {
  const issue = db.prepare('SELECT * FROM dq_issues WHERE id=?').get(Number(req.params.id));
  if (!issue) return fail(res, 404, '问题不存在');
  db.prepare('DELETE FROM dq_ignores WHERE fingerprint=?').run(issue.fingerprint);
  db.prepare("UPDATE dq_issues SET status='open', ignore_reason=NULL, fixed_at=NULL, fixed_by=NULL WHERE id=?").run(issue.id);
  ok(res, { id: issue.id, status: 'open' });
});

/** ==================== 修复记录 ==================== */
router.get('/fixes', authRequired, requireRole(...READ), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(
    `SELECT f.*, i.rule_name, i.entity_no FROM dq_fixes f
     LEFT JOIN dq_issues i ON i.id=f.issue_id ORDER BY f.id DESC LIMIT ?`
  ).all(limit);
  ok(res, rows);
});

/** ==================== 三账对齐 ==================== */
/**
 * 一张表看「订单账 - 库存账 - 财务账」是否对得上：
 * 接单件数 / 入库件数 / 出库件数 / 订单金额 / 已开票 / 已收款
 */
router.get('/reconcile', authRequired, requireRole(...READ), (req, res) => {
  const { keyword, only } = req.query;
  const args = [];
  let where = "WHERE o.status<>'draft'";
  if (keyword) { where += ' AND (o.order_no LIKE ? OR c.name LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }

  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.status, o.total_usd, o.total_amount, o.rate, o.delivery_date,
         c.name AS customer_name,
         COALESCE((SELECT SUM(s.qty) FROM order_item_sizes s JOIN order_items i ON i.id=s.item_id WHERE i.order_id=o.id),0) AS order_qty,
         COALESCE((SELECT SUM(l.qty) FROM stock_ledger l WHERE l.ref_type='order' AND l.type='in' AND l.ref_id=o.id),0) AS in_qty,
         COALESCE((SELECT SUM(ABS(l.qty)) FROM stock_ledger l WHERE l.ref_type='order' AND l.type='out' AND l.ref_id=o.id),0) AS out_qty,
         COALESCE((SELECT SUM(a.amount) FROM ar_invoices a WHERE a.order_id=o.id AND a.status<>'void'),0) AS ar_amount,
         COALESCE((SELECT SUM(a.paid_amount) FROM ar_invoices a WHERE a.order_id=o.id AND a.status<>'void'),0) AS ar_paid
       FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
       ${where}
       ORDER BY o.id DESC`
    )
    .all(...args);

  const list = rows.map((r) => {
    const qty = num(r.order_qty);
    const out = num(r.out_qty);
    const amt = num(r.total_amount);
    const ar = num(r.ar_amount);
    const paid = num(r.ar_paid);
    const qtyDiff = r2(qty - out);
    const amtDiff = r2(amt - ar);
    const paidDiff = r2(ar - paid);
    const flags = [];
    if (!r.customer_name) flags.push('缺客户');
    if (qty === 0) flags.push('无订购数量');
    if (out > qty + 0.011) flags.push('超发');
    if (['shipped', 'closed'].includes(r.status) && out === 0 && qty > 0) flags.push('未过账出库');
    if (ar > amt + 0.011) flags.push('超开票');
    if (r.status === 'closed' && ar === 0 && amt > 0) flags.push('结单未开票');
    if (paid > ar + 0.011) flags.push('收款超开票');
    const status = flags.some((f) => ['超发', '超开票', '收款超开票'].includes(f))
      ? 'error'
      : flags.length
        ? 'warn'
        : 'ok';
    return {
      id: r.id, order_no: r.order_no, status: r.status, customer_name: r.customer_name,
      delivery_date: r.delivery_date,
      order_qty: r2(qty), in_qty: r2(num(r.in_qty)), out_qty: r2(out), qty_diff: qtyDiff,
      total_amount: r2(amt), ar_amount: r2(ar), ar_paid: r2(paid),
      amt_diff: amtDiff, paid_diff: paidDiff,
      flag: status, flags
    };
  });

  const filtered = only === 'diff' ? list.filter((r) => r.flag !== 'ok') : list;
  const sum = filtered.reduce(
    (a, r) => ({
      order_qty: a.order_qty + r.order_qty,
      in_qty: a.in_qty + r.in_qty,
      out_qty: a.out_qty + r.out_qty,
      total_amount: a.total_amount + r.total_amount,
      ar_amount: a.ar_amount + r.ar_amount,
      ar_paid: a.ar_paid + r.ar_paid
    }),
    { order_qty: 0, in_qty: 0, out_qty: 0, total_amount: 0, ar_amount: 0, ar_paid: 0 }
  );
  Object.keys(sum).forEach((k) => { sum[k] = r2(sum[k]); });

  ok(res, {
    rows: filtered,
    total: { ...sum, diff_count: filtered.filter((r) => r.flag !== 'ok').length, count: filtered.length }
  });
});

/** ==================== 总览 ==================== */
router.get('/summary', authRequired, requireRole(...READ), (req, res) => {
  const lastRun = db.prepare("SELECT * FROM dq_runs WHERE status='done' ORDER BY id DESC LIMIT 1").get();
  const trend = db
    .prepare("SELECT id, run_no, health, error_cnt, warn_cnt, info_cnt, issue_count, created_at FROM dq_runs WHERE status='done' ORDER BY id DESC LIMIT 12")
    .all()
    .reverse();

  const byRule = db
    .prepare(
      `SELECT i.rule_code, i.rule_name, i.category, i.kind,
         SUM(CASE WHEN i.status='open' THEN 1 ELSE 0 END) AS open_cnt,
         SUM(CASE WHEN i.status='open' AND i.fixable=1 THEN 1 ELSE 0 END) AS fixable_cnt,
         SUM(CASE WHEN i.status='open' AND i.severity='error' THEN 1 ELSE 0 END) AS error_cnt,
         SUM(CASE WHEN i.status='open' AND i.severity='warn' THEN 1 ELSE 0 END) AS warn_cnt,
         MAX(i.last_seen_at) AS last_seen_at
       FROM dq_issues i GROUP BY i.rule_code ORDER BY i.category, error_cnt DESC, open_cnt DESC`
    )
    .all();

  const stat = db
    .prepare(
      `SELECT status, severity, COUNT(*) c FROM dq_issues GROUP BY status, severity`
    )
    .all();
  const cnt = { open: 0, fixed: 0, ignored: 0, error: 0, warn: 0, info: 0 };
  stat.forEach((r) => {
    if (cnt[r.status] !== undefined) cnt[r.status] += r.c;
    if (r.status === 'open' && cnt[r.severity] !== undefined) cnt[r.severity] += r.c;
  });

  const fixes = db.prepare('SELECT COUNT(*) c FROM dq_fixes WHERE result=\'ok\'').get().c;

  ok(res, {
    last_run: lastRun || null,
    health: lastRun ? lastRun.health : null,
    trend,
    by_rule: byRule,
    counters: cnt,
    fix_count: fixes,
    rule_total: db.prepare('SELECT COUNT(*) c FROM dq_rules WHERE enabled=1').get().c
  });
});

/** ==================== 导出 CSV ==================== */
router.get('/export', authRequired, requireRole(...READ), (req, res) => {
  const status = req.query.status || 'open';
  const rows = db
    .prepare(
      `SELECT rule_code, rule_name, category, severity, entity_type, entity_no, field,
         expect_val, actual_val, diff_val, message, status, fixable, first_seen_at, last_seen_at, seen_cnt
       FROM dq_issues ${status === 'all' ? '' : 'WHERE status=?'}
       ORDER BY severity, rule_code`
    )
    .all(...(status === 'all' ? [] : [status]));

  const head = ['规则编码', '规则名称', '类别', '级别', '对象类型', '对象', '字段', '期望值', '实际值', '差额', '说明', '状态', '可自动修', '首次发现', '最近发现', '出现次数'];
  const lines = [head.join(',')];
  rows.forEach((r) => {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    lines.push(
      [
        r.rule_code, r.rule_name, r.category === 'balance' ? '账账对齐' : '数据质量',
        r.severity, r.entity_type, r.entity_no, r.field, r.expect_val, r.actual_val,
        r.diff_val, r.message, r.status, r.fixable ? '是' : '否',
        r.first_seen_at, r.last_seen_at, r.seen_cnt
      ].map(esc).join(',')
    );
  });
  const csv = '\uFEFF' + lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dq-issues-${localDate()}.csv"`);
  res.send(csv);
});

module.exports = router;
