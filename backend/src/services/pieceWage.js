/**
 * 计件工资核算
 * ============================================================
 * 一句话：**按「人 × 工序 × 扎」的合格件数 × 工序单价算工钱**，一个月出一张核算单。
 *
 * 六个口径（都在这里定死，路由与页面只展示）
 *
 * 1. **只算合格数**（`qty_ok`）。不良不付钱 —— 这不是苛刻，是计件的定义。
 *
 * 2. **超报按扎件数封顶**。同一张单同一扎同一道工序，累计合格数不可能超过这扎的件数；
 *    超出来的部分是报工错了（写错扎号/重复报）。**先报先算、超出部分不计**，
 *    并把每一笔超出单独列出来给人核对 —— 既不让人多拿，也不静默吞掉。
 *
 * 3. **缺单价绝不按 0 算**。按 0 算等于白干，页面还显示算完了。
 *    缺单价的报工单独列出（工序/款/件数），草案可以存，**但确认时直接拒**。
 *
 * 4. **归人有三级，认不出就不猜**：`employee_id` > 姓名唯一匹配 > 无法归属。
 *    姓名重名、姓名对不上员工档案（比如「临时工张三」）一律进「无法归属」清单，
 *    并写明原因。宁可少算一笔让人补档案，也不能把钱算到别人头上。
 *
 * 5. **一份月份只能有一份已确认的核算单**（部分唯一索引兜底）。要改只能作废重开，
 *    作废必须写理由 —— 工钱一旦发出去，改的是别人的人生。
 *
 * 6. **单价按生效日版本化，改价不改历史**。查找取「生效日 ≤ 报工日期」里最新的一条，
 *    款专属价优先于通用价。这样上个月算过的钱不会因为今天调价而变。
 *
 * 计件金额**不直接发钱**：确认后由 `payrolls/generate` 带进工资单的 `piece_wage` 列，
 * 与基本工资、社保、个税一起走正常的工资流程。
 */
const { db, now } = require('../db');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) throw bad('月份格式应为 YYYY-MM');
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

// ---------------- 单价 ----------------

/**
 * 取某款某工序在某天的有效单价
 * 先找款专属价，再退通用价；各自取「生效日 ≤ 当天」里最新的一条
 * @returns {{rate:object|null, source:'style'|'generic'|null}}
 */
function rateOf(styleNo, processName, date) {
  const sqlOne = (withStyle) =>
    db
      .prepare(
        `SELECT * FROM piece_rates
          WHERE status = 'active'
            AND IFNULL(style_no, '') = ?
            AND process_name = ?
            AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to = '' OR effective_to >= ?)
          ORDER BY effective_from DESC, id DESC LIMIT 1`
      )
      .get(withStyle ? String(styleNo) : '', processName, date, date);

  if (styleNo) {
    const hit = sqlOne(true);
    if (hit) return { rate: hit, source: 'style' };
  }
  const generic = sqlOne(false);
  if (generic) return { rate: generic, source: 'generic' };
  return { rate: null, source: null };
}

function listRates({ style_no, process_name, status } = {}) {
  const where = [];
  const params = [];
  if (style_no) {
    where.push("IFNULL(style_no,'') = ?");
    params.push(style_no);
  }
  if (process_name) {
    where.push('process_name = ?');
    params.push(process_name);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT * FROM piece_rates ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY process_name, IFNULL(style_no,''), effective_from DESC`
    )
    .all(...params);
  return rows.map((r) => ({
    ...r,
    scope_label: r.style_no ? r.style_no : '通用（所有款）',
    unit_price: round2(r.unit_price)
  }));
}

/**
 * 新增单价（不覆盖历史：新价是新记录，按生效日接管）
 * 同款同工序同生效日已存在 → 拒绝（否则取价会摇摆）
 */
function saveRate(b = {}, operator) {
  const processName = String(b.process_name || '').trim();
  if (!processName) throw bad('要填工序名称');
  const price = Number(b.unit_price);
  if (!(price >= 0)) throw bad('单价要填数字（可以是 0，但不能空）');
  const from = String(b.effective_from || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw bad('生效日格式应为 YYYY-MM-DD');
  const to = b.effective_to ? String(b.effective_to).slice(0, 10) : null;
  if (to && to < from) throw bad('失效日不能早于生效日');
  const styleNo = b.style_no ? String(b.style_no).trim() : null;

  const dup = db
    .prepare(
      `SELECT id FROM piece_rates
        WHERE IFNULL(style_no,'') = ? AND process_name = ? AND effective_from = ?`
    )
    .get(styleNo || '', processName, from);
  if (dup) throw bad(`${styleNo || '通用'} / ${processName} 在 ${from} 已有一条单价，请改生效日或直接编辑那条`);

  const t = now();
  const id = db
    .prepare(
      `INSERT INTO piece_rates
         (style_no, process_name, unit_price, currency, effective_from, effective_to, status, note, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'active', ?,?,?,?)`
    )
    .run(styleNo, processName, round2(price), b.currency || 'CNY', from, to, b.note || null, operator, t, t)
    .lastInsertRowid;

  return db.prepare('SELECT * FROM piece_rates WHERE id = ?').get(id);
}

function updateRate(id, b = {}, operator) {
  const row = db.prepare('SELECT * FROM piece_rates WHERE id = ?').get(id);
  if (!row) throw bad('单价记录不存在', 404);
  const price = b.unit_price === undefined ? row.unit_price : Number(b.unit_price);
  if (!(price >= 0)) throw bad('单价要填数字');
  // 只允许改「还没被核算用过」的单价：已经算进工钱的单价改了会对不上账
  const used = db.prepare('SELECT COUNT(*) c FROM piece_wage_items WHERE rate_id = ?').get(id).c;
  if (used > 0 && round2(price) !== round2(row.unit_price)) {
    throw bad(`这条单价已被 ${used} 条计件明细使用，不能改金额。请新增一条生效日更晚的单价`);
  }
  db.prepare(
    `UPDATE piece_rates SET unit_price=?, status=?, note=?, updated_at=? WHERE id=?`
  ).run(round2(price), b.status || row.status, b.note === undefined ? row.note : b.note, now(), id);
  return db.prepare('SELECT * FROM piece_rates WHERE id = ?').get(id);
}

// ---------------- 归人 ----------------

/** 姓名缓存：避免每条报工都查库 */
function makeResolver() {
  const cache = new Map();
  const empById = (id) => {
    if (cache.has('id' + id)) return cache.get('id' + id);
    const e = db
      .prepare(
        `SELECT e.id, e.code, e.name, e.status, d.name AS dept_name
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
      )
      .get(id);
    cache.set('id' + id, e || null);
    return e || null;
  };
  const empByName = (name) => {
    if (cache.has('n' + name)) return cache.get('n' + name);
    const rows = db
      .prepare(
        `SELECT e.id, e.code, e.name, e.status, d.name AS dept_name
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.name = ?`
      )
      .all(name);
    cache.set('n' + name, rows);
    return rows;
  };
  return { empById, empByName };
}

/**
 * 把一条报工归到人
 * @returns {{employee:object|null, matched_by:string, reason:string}}
 */
function resolveEmployee(report, R) {
  if (report.employee_id) {
    const e = R.empById(report.employee_id);
    if (e) return { employee: e, matched_by: 'id', reason: '' };
    return { employee: null, matched_by: '', reason: `员工 #${report.employee_id} 已不在档案` };
  }
  const name = String(report.operator || '').trim();
  if (!name) return { employee: null, matched_by: '', reason: '报工没记人（无员工、无姓名）' };
  const hits = R.empByName(name);
  if (hits.length === 1) return { employee: hits[0], matched_by: 'name', reason: '' };
  if (hits.length > 1) return { employee: null, matched_by: '', reason: `「${name}」重名（${hits.length} 人），不敢猜` };
  return { employee: null, matched_by: '', reason: `「${name}」不在员工档案` };
}

/** 订单的款号：只有一个款才拿来匹配专属单价，多款就只用通用价（不猜） */
function styleResolver() {
  const cache = new Map();
  return (orderId) => {
    if (cache.has(orderId)) return cache.get(orderId);
    const rows = db
      .prepare(
        `SELECT DISTINCT TRIM(style_no) AS s FROM order_items
          WHERE order_id = ? AND style_no IS NOT NULL AND TRIM(style_no) <> ''`
      )
      .all(orderId)
      .map((r) => r.s)
      .filter(Boolean);
    const out = rows.length === 1 ? { style_no: rows[0], multi: false } : { style_no: null, multi: rows.length > 1 };
    cache.set(orderId, out);
    return out;
  };
}

/** 扎件数：(order_id, bundle_no) → qty */
function bundleQtyMap() {
  const m = new Map();
  db.prepare(
    `SELECT co.order_id AS order_id, b.bundle_no AS bundle_no, b.qty AS qty
       FROM cut_bundles b JOIN cut_orders co ON co.id = b.cut_order_id`
  )
    .all()
    .forEach((r) => m.set(`${r.order_id}|${r.bundle_no}`, Number(r.qty) || 0));
  return m;
}

// ---------------- 核算 ----------------

/**
 * 试算某个月（不落库）
 * @returns {{ period, from, to, items, by_employee, diagnostics, summary }}
 */
function preview(period) {
  const { from, to } = periodRange(period);
  const reports = db
    .prepare(
      `SELECT r.id, r.order_id, r.node_name, r.bundle_no, r.qty_ok, r.qty_defect,
              r.employee_id, r.operator, r.report_date, o.order_no
         FROM production_reports r
         LEFT JOIN orders o ON o.id = r.order_id
        WHERE r.report_date >= ? AND r.report_date <= ? AND IFNULL(r.qty_ok, 0) > 0
        ORDER BY r.report_date, r.id`
    )
    .all(from, to);

  const R = makeResolver();
  const styleOf = styleResolver();
  const bundleQty = bundleQtyMap();

  const items = [];
  const missing = [];   // 缺单价
  const unassigned = []; // 无法归属
  const capped = [];    // 超报被拦
  const noBundle = [];  // 没记扎号（不封顶）
  const multiStyle = []; // 多款订单按通用价
  const used = new Map(); // order|bundle|process → 已计入数量

  reports.forEach((r) => {
    const processName = String(r.node_name || '').trim() || '（未记工序）';
    const st = styleOf(r.order_id);
    const { rate, source } = rateOf(st.style_no, processName, r.report_date);

    // 1) 归人
    const who = resolveEmployee(r, R);
    if (!who.employee) {
      unassigned.push({
        report_id: r.id, order_no: r.order_no, bundle_no: r.bundle_no,
        process_name: processName, qty: Number(r.qty_ok) || 0,
        operator: r.operator, report_date: r.report_date, reason: who.reason
      });
      return;
    }
    if (st.multi) {
      multiStyle.push({ order_no: r.order_no, report_id: r.id, process_name: processName });
    }

    // 2) 超报封顶（同单同扎同工序累计不超过扎件数）
    let qty = Number(r.qty_ok) || 0;
    const rawQty = qty;
    let isCapped = 0;
    if (r.bundle_no) {
      const capKey = `${r.order_id}|${r.bundle_no}|${processName}`;
      const cap = bundleQty.get(`${r.order_id}|${r.bundle_no}`);
      if (cap !== undefined && cap > 0) {
        const already = used.get(capKey) || 0;
        const remain = Math.max(0, cap - already);
        if (qty > remain) {
          capped.push({
            report_id: r.id, order_no: r.order_no, bundle_no: r.bundle_no,
            process_name: processName, employee_name: who.employee.name,
            raw_qty: rawQty, counted: remain, over: round2(qty - remain),
            bundle_qty: cap, reason: '累计合格数超过这扎的件数'
          });
          qty = remain;
          isCapped = 1;
        }
        used.set(capKey, already + qty);
      }
    } else {
      noBundle.push({
        report_id: r.id, order_no: r.order_no, process_name: processName,
        employee_name: who.employee.name, qty
      });
    }

    // 3) 单价
    if (!rate) {
      missing.push({
        order_no: r.order_no, style_no: st.style_no, process_name: processName,
        qty, employee_name: who.employee.name, report_date: r.report_date,
        note: st.multi ? '该单有多个款号，只能按通用价匹配，但没有通用价' : '没有匹配到单价'
      });
      return;
    }

    if (qty <= 0) return;

    items.push({
      employee_id: who.employee.id,
      employee_code: who.employee.code,
      employee_name: who.employee.name,
      department: who.employee.dept_name || '',
      style_no: st.style_no || null,
      process_name: processName,
      order_id: r.order_id,
      order_no: r.order_no,
      bundle_no: r.bundle_no || null,
      raw_qty: rawQty,
      qty,
      capped: isCapped,
      unit_price: round2(rate.unit_price),
      amount: round2(qty * rate.unit_price),
      rate_id: rate.id,
      rate_source: source,
      matched_by: who.matched_by
    });
  });

  // 同一人同工序同单同扎合并（多条报工合成一行，便于核对）
  const merged = new Map();
  items.forEach((it) => {
    const k = [it.employee_id, it.process_name, it.order_id, it.bundle_no || '', it.unit_price].join('|');
    const hit = merged.get(k);
    if (hit) {
      hit.qty = round2(hit.qty + it.qty);
      hit.raw_qty = round2(hit.raw_qty + it.raw_qty);
      hit.amount = round2(hit.amount + it.amount);
      hit.capped = hit.capped || it.capped ? 1 : 0;
    } else {
      merged.set(k, { ...it });
    }
  });
  const finalItems = [...merged.values()].sort(
    (a, b) =>
      String(a.department).localeCompare(String(b.department)) ||
      String(a.employee_name).localeCompare(String(b.employee_name)) ||
      String(a.order_no).localeCompare(String(b.order_no)) ||
      String(a.bundle_no || '').localeCompare(String(b.bundle_no || '')) ||
      String(a.process_name).localeCompare(String(b.process_name))
  );

  const byEmployee = {};
  finalItems.forEach((it) => {
    const k = it.employee_id;
    if (!byEmployee[k]) {
      byEmployee[k] = {
        employee_id: k, employee_code: it.employee_code, employee_name: it.employee_name,
        department: it.department, qty: 0, amount: 0, items: 0
      };
    }
    byEmployee[k].qty = round2(byEmployee[k].qty + it.qty);
    byEmployee[k].amount = round2(byEmployee[k].amount + it.amount);
    byEmployee[k].items++;
  });

  const summary = {
    period,
    from,
    to,
    reports: reports.length,
    items_count: finalItems.length,
    employees_count: Object.keys(byEmployee).length,
    total_qty: round2(finalItems.reduce((s, x) => s + x.qty, 0)),
    total_amount: round2(finalItems.reduce((s, x) => s + x.amount, 0)),
    missing_rate_count: missing.length,
    unassigned_count: unassigned.length,
    capped_count: capped.length,
    no_bundle_count: noBundle.length,
    multi_style_count: multiStyle.length
  };

  return {
    period,
    from,
    to,
    summary,
    items: finalItems,
    by_employee: Object.values(byEmployee).sort((a, b) => b.amount - a.amount),
    diagnostics: {
      missing_rate: missing,
      unassigned,
      capped,
      no_bundle: noBundle,
      multi_style: multiStyle
    }
  };
}

/** 生成（或覆盖）某月草案 */
function createRun(period, operator, note) {
  const p = preview(period);
  const existConfirmed = db
    .prepare("SELECT * FROM piece_wage_runs WHERE period = ? AND status = 'confirmed'")
    .get(period);
  if (existConfirmed) {
    throw bad(`该月已有确认过的核算单 ${existConfirmed.run_no}，要重算请先作废（作废要写理由）`);
  }
  if (!p.items.length) {
    throw bad(
      `该月没有可计件的报工（${p.summary.unassigned_count} 条无法归属、${p.summary.missing_rate_count} 条缺单价）` +
        '，检查一下范围再生成'
    );
  }

  const t = now();
  db.exec('BEGIN');
  try {
    // 草案可覆盖：删旧的草案（明细级联删），并**复用它的编号** ——
    // 同一期间的草案只是「当前试算」，编号每次重算都涨会让对账时对不上号
    const olds = db
      .prepare("SELECT id, run_no FROM piece_wage_runs WHERE period = ? AND status = 'draft'")
      .all(period);
    const reuseNo = olds.length ? olds[0].run_no : null;
    olds.forEach((o) => {
      db.prepare('DELETE FROM piece_wage_items WHERE run_id = ?').run(o.id);
      db.prepare('DELETE FROM piece_wage_runs WHERE id = ?').run(o.id);
    });

    const prefix = 'PW' + period.replace('-', '');
    let runNo = reuseNo;
    if (!runNo) {
      const maxRow = db
        .prepare('SELECT run_no FROM piece_wage_runs WHERE run_no LIKE ? ORDER BY run_no DESC LIMIT 1')
        .get(prefix + '%');
      let seq = 1;
      if (maxRow) {
        const n = parseInt(String(maxRow.run_no).slice(prefix.length + 1), 10);
        if (!isNaN(n)) seq = n + 1;
      }
      runNo = prefix + '-' + String(seq).padStart(2, '0');
    }

    const s = p.summary;
    const runId = db
      .prepare(
        `INSERT INTO piece_wage_runs
           (run_no, period, status, items_count, employees_count, total_qty, total_amount,
            missing_rate_count, unassigned_count, capped_count, payload, note, created_by, created_at)
         VALUES (?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        runNo, period, s.items_count, s.employees_count, s.total_qty, s.total_amount,
        s.missing_rate_count, s.unassigned_count, s.capped_count,
        JSON.stringify(p.diagnostics), note || null, operator, t
      ).lastInsertRowid;

    const ins = db.prepare(
      `INSERT INTO piece_wage_items
         (run_id, employee_id, employee_code, employee_name, department, style_no, process_name,
          order_id, order_no, bundle_no, raw_qty, qty, capped, unit_price, amount, rate_id, rate_source, matched_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    p.items.forEach((it) => {
      ins.run(
        runId, it.employee_id, it.employee_code, it.employee_name, it.department, it.style_no,
        it.process_name, it.order_id, it.order_no, it.bundle_no, it.raw_qty, it.qty, it.capped,
        it.unit_price, it.amount, it.rate_id, it.rate_source, it.matched_by, t
      );
    });

    db.exec('COMMIT');
    return getRun(runId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function listRuns({ period, status } = {}) {
  const where = [];
  const params = [];
  if (period) {
    where.push('period = ?');
    params.push(period);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  return db
    .prepare(
      `SELECT * FROM piece_wage_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY period DESC, id DESC LIMIT 60`
    )
    .all(...params)
    .map((r) => ({
      ...r,
      total_amount: round2(r.total_amount),
      total_qty: round2(r.total_qty),
      status_label: { draft: '草案', confirmed: '已确认', void: '已作废' }[r.status] || r.status
    }));
}

function getRun(id) {
  const run = db.prepare('SELECT * FROM piece_wage_runs WHERE id = ?').get(id);
  if (!run) throw bad('核算单不存在', 404);
  const items = db
    .prepare(
      `SELECT * FROM piece_wage_items WHERE run_id = ?
        ORDER BY department, employee_name, order_no, bundle_no, process_name`
    )
    .all(id);
  const byEmployee = {};
  items.forEach((it) => {
    const k = it.employee_id;
    if (!byEmployee[k]) {
      byEmployee[k] = {
        employee_id: k, employee_code: it.employee_code, employee_name: it.employee_name,
        department: it.department, qty: 0, amount: 0, items: 0
      };
    }
    byEmployee[k].qty = round2(byEmployee[k].qty + it.qty);
    byEmployee[k].amount = round2(byEmployee[k].amount + it.amount);
    byEmployee[k].items++;
  });
  return {
    ...run,
    total_amount: round2(run.total_amount),
    total_qty: round2(run.total_qty),
    status_label: { draft: '草案', confirmed: '已确认', void: '已作废' }[run.status] || run.status,
    diagnostics: (() => {
      try {
        return JSON.parse(run.payload || '{}');
      } catch (e) {
        return {};
      }
    })(),
    items,
    by_employee: Object.values(byEmployee).sort((a, b) => b.amount - a.amount)
  };
}

/** 确认：缺单价一条都不许过 */
function confirmRun(id, operator, extraNote) {
  const run = db.prepare('SELECT * FROM piece_wage_runs WHERE id = ?').get(id);
  if (!run) throw bad('核算单不存在', 404);
  // 确认时允许补写处理说明（比如「临时工张三另行结算」）：
  // 无法归属的报工不阻塞确认，但必须留下一句话说明怎么处理
  const note = extraNote !== undefined && String(extraNote).trim() ? String(extraNote).trim() : run.note;
  if (run.status === 'confirmed') throw bad('已经确认过了');
  if (run.status === 'void') throw bad('作废的单不能确认');
  if (!run.items_count) throw bad('没有明细，不能确认');

  const p = preview(run.period);
  if (p.summary.missing_rate_count > 0) {
    const names = [...new Set(p.diagnostics.missing_rate.map((m) => m.process_name))].slice(0, 5);
    throw bad(
      `还有 ${p.summary.missing_rate_count} 条报工缺单价（${names.join('、')}${names.length >= 5 ? ' 等' : ''}），` +
        '先把「单价维护」补齐再确认 —— 缺价按 0 算等于白干'
    );
  }
  if (p.summary.unassigned_count > 0) {
    // 无法归属不阻塞（可能是临时工），但必须在确认前让人看见
    if (!note || String(note).trim().length < 4) {
      throw bad(
        `还有 ${p.summary.unassigned_count} 条报工无法归属到人（临时工/姓名对不上档案）。` +
          '可以确认，但请在备注里写一句怎么处理（例如「临时工张三另行结算」）'
      );
    }
  }

  db.prepare(
    "UPDATE piece_wage_runs SET status='confirmed', confirmed_by=?, confirmed_at=?, note=? WHERE id=?"
  ).run(operator, now(), note || null, id);
  return getRun(id);
}

/** 作废（必须写理由） */
function voidRun(id, reason, operator) {
  const run = db.prepare('SELECT * FROM piece_wage_runs WHERE id = ?').get(id);
  if (!run) throw bad('核算单不存在', 404);
  if (run.status === 'void') throw bad('已经作废了');
  const why = String(reason || '').trim();
  if (why.length < 4) throw bad('作废要写理由（至少 4 个字），工钱的事以后要能解释');
  db.prepare(
    "UPDATE piece_wage_runs SET status='void', void_reason=?, confirmed_by=COALESCE(confirmed_by,?), confirmed_at=COALESCE(confirmed_at,?) WHERE id=?"
  ).run(why, operator, now(), id);
  return getRun(id);
}

/**
 * 给工资单用：某月已确认的计件金额，按员工汇总
 * 没有已确认核算单时返回空 Map（工资单计件列就是 0，不是「未算」）
 */
function confirmedByEmployee(period) {
  const run = db
    .prepare("SELECT * FROM piece_wage_runs WHERE period = ? AND status = 'confirmed'")
    .get(period);
  if (!run) return { run: null, map: new Map() };
  const rows = db
    .prepare(
      `SELECT employee_id, SUM(amount) AS amount, SUM(qty) AS qty
         FROM piece_wage_items WHERE run_id = ? GROUP BY employee_id`
    )
    .all(run.id);
  const map = new Map();
  rows.forEach((r) => {
    if (r.employee_id) map.set(Number(r.employee_id), { amount: round2(r.amount), qty: round2(r.qty) });
  });
  return { run, map };
}

module.exports = {
  periodRange,
  rateOf,
  listRates,
  saveRate,
  updateRate,
  preview,
  createRun,
  listRuns,
  getRun,
  confirmRun,
  voidRun,
  confirmedByEmployee,
  round2
};
