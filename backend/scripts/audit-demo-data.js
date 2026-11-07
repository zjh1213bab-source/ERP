/**
 * 演示/烟测数据体检与清库
 * ========================================================================
 * 为什么要单独做这件事：这几轮为了验证功能，往库里写了几千条带「烟测 / SMOKE」标记的数据。
 * 它们不会自己消失，而且会以三种方式伤人：
 *
 *   1. **污染统计** —— 研发立项 236 条里 230 条是冒烟残留，页面上几乎全是 `SMOKE-744441`
 *   2. **污染交付** —— 客户拿到演示库，打开「研发立项」「SKU 档案」看到的是烟测数据
 *   3. **污染判断** —— 以后做数据质量、对账、成本分析，这些数据会被算进去，异常永远清不掉
 *
 * 但**清理比造数据危险得多**：这个库 352 张表一个外键约束都没有（全用逻辑外键），
 * 删错一条不会报错，只会留下一堆孤儿行，等到某天对账对不上才被发现。
 * 所以三档分类 + 先备份 + 拓扑删除 + 删后孤儿检查，一步都不能省。
 *
 * ## 三档分类（判定只看「标识列」，不看备注）
 *
 * | 档 | 判定 | 处理 |
 * |---|---|---|
 * | **L1 烟测夹具** | 标识列（单号/编码/款号/名称/用户名）**以** `SMOKE`/`__smoke`/`烟测` **开头** | 默认清理 |
 * | **L2 演示数据** | `demo_tag` 有值且不属于 L1 | 只在 `--with-demo` 时清（演示库要留着给人看） |
 * | **L3 疑似** | 任意文本列**包含**「烟测/SMOKE」，但标识列不以它开头 | **只报告，不动** |
 *
 * 为什么 L3 只报告：一条真实的采购单，备注里可能写着「参考烟测数据补录」——
 * 按备注 LIKE 删就会把真单据删掉。**判定必须落在标识列上**。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/audit-demo-data.js                 # 出体检报告（不改任何数据）
 * node scripts/audit-demo-data.js --clean         # 清 L1（自动先备份）
 * node scripts/audit-demo-data.js --clean --with-demo   # L1 + L2 全清（交付前用）
 * node scripts/audit-demo-data.js --verify        # 清理后校验：残留归零 + 孤儿 + 关键指标
 * node scripts/audit-demo-data.js --json          # 机器可读（给 CI/巡检用）
 * ```
 */

const fs = require('fs');
const path = require('path');
const { db, now } = require('../src/db');

/* ============================================================
 * 基础探测
 * ============================================================ */
const TABLES = () => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);

const colCache = new Map();
function cols(t) {
  if (!colCache.has(t)) colCache.set(t, db.prepare(`PRAGMA table_info(${t})`).all());
  return colCache.get(t);
}
const textCols = (t) => cols(t).filter((c) => /TEXT|CHAR|CLOB/i.test(c.type || '')).map((c) => c.name);

/**
 * 判定列：只认「单据号 / 编码 / 名称」这类能代表整行身份的列。
 *
 * 踩过的坑：一开始把 `batch_no` 当判定列，于是「真实领料单 LL202610270004 里
 * 一个批次号为 SMOKE-B1 的明细」被判成烟测夹具 —— 删了明细，真实领料单就成了空壳。
 * 批次号、周期号、银行账号都不是「这一行是什么」，一律排除。
 */
const JUDGE_COL_RE = /(^|_)(no|code|name|username|user_name|style_no|sku|title|subject)$/i;
const JUDGE_EXCLUDE = new Set(['batch_no', 'week_no', 'account_no', 'card_no', 'phone_no', 'voucher_no']);

/** 明细表不单独判定：它们跟着父表走（父表是烟测的，明细一起删；父表是真实的，明细一条不动） */
const isDetailTable = (t) => /_items$|_items_|_lines$|_details$|_entries$/.test(t);

function idCols(t) {
  const names = cols(t).map((c) => c.name);
  return names.filter((c) => JUDGE_COL_RE.test(c) && !JUDGE_EXCLUDE.has(c.toLowerCase()));
}

/**
 * 烟测夹具：标识列**以** SMOKE / __smoke / 烟测 开头
 *
 * 为什么用「开头」而不是「包含」：包含会把「客户 A 备注：参考烟测」也算进来。
 * 冒烟脚本生成的标识天然是 `SMOKE-744441` / `烟测员工A__SMOKE` / `__smoke_self__` 这种前缀形态。
 */
function smokeWhere(t) {
  if (isDetailTable(t)) return null;          // 明细表只靠级联，不自己判
  if (EXCLUDE_TABLES.has(t)) return null;     // 审计日志不参与清理（只增不删）
  const ids = idCols(t);
  if (!ids.length) return null;
  // 前缀集合：SMOKE / smoke / SMK- / __smoke / 烟测 / 冒烟
  // `SMK-` 是冒烟脚本给 SKU 用的前缀（SMK-744441-A-3T），一开始漏了它，
  // 结果清完还有 118 个「烟测 SKU」躺在档案里 —— 判定前缀必须和夹具的实际命名对齐。
  const parts = ids.map((c) =>
    `(${c} LIKE 'SMOKE%' OR ${c} LIKE 'smoke%' OR ${c} LIKE 'SMK-%' OR ${c} LIKE '__smoke%' OR ${c} LIKE '__SMOKE%' OR ${c} LIKE '烟测%' OR ${c} LIKE '冒烟%')`
  );
  let sql = parts.join(' OR ');
  // 显式标了 demo_tag 的行算「演示数据」而不是「烟测夹具」：
  // 演示脚本有时候会给款号起名叫 SMK-xxx-SET，光看名字分不清，
  // 但脚本自己写了 demo_tag —— 显式标记优先于命名推断。
  if (cols(t).some((c) => c.name === 'demo_tag')) {
    sql = `(${sql}) AND (demo_tag IS NULL OR demo_tag = '')`;
  }
  return { sql, cols: ids };
}

function countWhere(t, where) {
  try {
    return db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${where}`).get().c;
  } catch (e) {
    return 0;
  }
}

/** 引用探测：谁在引用这张表（逻辑外键，靠列名猜） */
const refCache = new Map();
function refsOf(t) {
  // 缓存关系定义，不缓存当时行数；测试中途还会新增子行。
  if(!refCache.has(t)){
    const sing=t.replace(/ies$/, 'y').replace(/s$/, ''),patterns=[`${t}_id`,`${sing}_id`],out=[];
    TABLES().forEach(child=>{if(child===t)return;for(const c of cols(child).map(c=>c.name))if(patterns.includes(c))out.push({child,col:c});});
    // item_id / flow_id 这类通用列名不能猜，使用与孤儿审计相同的显式关系。
    for(const [child,col,parent]of PARENT_PAIRS)if(parent===t&&cols(child).some(c=>c.name===col)&&!out.some(r=>r.child===child&&r.col===col))out.push({child,col});
    refCache.set(t,out);
  }
  return refCache.get(t).map(r=>({...r,rows:countWhere(r.child,`${r.col} IS NOT NULL`)}));
}

/* ============================================================
 * 扫描
 * ============================================================ */
/**
 * 财务类表：删除会直接改变账面数字（应收/应付/凭证/工资），**默认跳过**。
 * 这不是「不敢删」，而是这类数据本应走冲销/作废 —— 直接 DELETE 会让
 * 「总账与业务账对不上」这件事失去最后一点线索。要用 --include-finance 显式确认。
 */
const FINANCE_TABLES = new Set([
  'ar_invoices', 'ap_invoices', 'gl_vouchers', 'gl_entries', 'payments', 'receipts',
  'payrolls', 'cost_entries', 'cost_objects', 'bank_statement_lines'
]);
const AMOUNT_COL = {
  ar_invoices: 'amount', ap_invoices: 'amount', gl_entries: 'debit',
  payments: 'amount', receipts: 'amount', payrolls: 'net_pay', cost_entries: 'amount'
};

/** 审计日志：按设计「只增不删」，冒烟产生的登录/访问记录属于正常审计痕迹，不参与清理 */
const EXCLUDE_TABLES = new Set(['audit_logs', 'sensitive_access_logs', 'field_access_logs']);

const DESC = {
  L1: '烟测夹具（标识列以 SMOKE/烟测 开头）',
  L2: '演示数据（demo_tag 有值）',
  L3: '疑似（备注等非标识列提到烟测）'
};

function scan() {
  const l1 = [];
  const l2 = [];
  const l3 = [];

  TABLES().forEach((t) => {
    const all = countWhere(t, '1=1');
    if (!all) return;
    const names = cols(t).map((c) => c.name);

    // L1
    const sw = smokeWhere(t);
    if (sw) {
      const n = countWhere(t, sw.sql);
      if (n) {
        const sample = db.prepare(`SELECT rowid AS __rid, * FROM ${t} WHERE ${sw.sql} LIMIT 3`).all();
        const amtCol = AMOUNT_COL[t];
        let amount = null;
        if (amtCol) {
          try {
            const v = Number(db.prepare('SELECT SUM(' + amtCol + ') v FROM ' + t + ' WHERE ' + sw.sql).get().v) || 0;
            amount = Math.round(v * 100) / 100;
          } catch (e) { amount = null; }
        }
        l1.push({
          table: t,
          rows: n,
          total: all,
          finance: FINANCE_TABLES.has(t),
          amount,
          judged_by: sw.cols,
          refs: refsOf(t),
          sample: sample.map((r) => {
            const o = {};
            sw.cols.forEach((c) => { o[c] = r[c]; });
            return o;
          })
        });
      }
    }

    // L2
    if (names.includes('demo_tag')) {
      const n = countWhere(t, "demo_tag IS NOT NULL AND demo_tag <> ''");
      if (n) {
        const tags = db.prepare(`SELECT demo_tag, COUNT(*) c FROM ${t} WHERE demo_tag IS NOT NULL AND demo_tag <> '' GROUP BY demo_tag ORDER BY c DESC`).all();
        l2.push({ table: t, rows: n, total: all, tags });
      }
    }

    // L3：只看「非判定列」——判定列上命中的已经算进 L1 了，重复统计会让报告虚高
    const judged = new Set(idCols(t));
    const tc = textCols(t).filter((c) => !judged.has(c));
    let l3n = 0;
    const l3cols = [];
    tc.forEach((c) => {
      const n = countWhere(t, `(${c} LIKE '%SMOKE%' OR ${c} LIKE '%烟测%')`);
      if (n) { l3n += n; l3cols.push(`${c}(${n})`); }
    });
    if (l3n) l3.push({ table: t, hits: l3n, cols: l3cols });
  });

  return { l1, l2, l3 };
}

/** 关键指标：清理前后必须一致（或按预期变化），防止误删伤到真实业务 */
function metrics() {
  const one = (sql, dflt = 0) => {
    try { const r = db.prepare(sql).get(); return r ? (r.v === null ? dflt : r.v) : dflt; } catch (e) { return dflt; }
  };
  return {
    orders: one('SELECT COUNT(*) v FROM orders'),
    order_amount: Math.round(one('SELECT SUM(total_usd) v FROM orders') * 100) / 100,
    stock_qty: one('SELECT SUM(qty) v FROM stock_items'),
    gl_entries: one('SELECT COUNT(*) v FROM gl_entries'),
    gl_debit: Math.round(one("SELECT SUM(debit) v FROM gl_entries") * 100) / 100,
    employees: one('SELECT COUNT(*) v FROM employees'),
    customers: one('SELECT COUNT(*) v FROM customers'),
    sku: one('SELECT COUNT(*) v FROM sku_masters'),
    dev_projects: one('SELECT COUNT(*) v FROM dev_projects')
  };
}

/* ============================================================
 * 报告
 * ============================================================ */
function pad(s, n) {
  s = String(s);
  // 中文按 2 宽度算，否则表格会歪
  const w = [...s].reduce((a, ch) => a + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
}

function report(asJson) {
  const t0 = Date.now();
  const s = scan();
  const m = metrics();
  const sumL1 = s.l1.reduce((a, x) => a + x.rows, 0);
  const sumL2 = s.l2.reduce((a, x) => a + x.rows, 0);
  const sumL3 = s.l3.reduce((a, x) => a + x.hits, 0);

  const out = {
    at: now(),
    tables: TABLES().length,
    l1: { tables: s.l1.length, rows: sumL1, detail: s.l1 },
    l2: { tables: s.l2.length, rows: sumL2, detail: s.l2 },
    l3: { tables: s.l3.length, hits: sumL3, detail: s.l3 },
    metrics: m,
    ms: Date.now() - t0
  };

  if (asJson) return out;

  const L = [];
  L.push('');
  L.push('演示/烟测数据体检');
  L.push('='.repeat(72));
  L.push(`库表 ${out.tables} 张 · 扫描耗时 ${out.ms}ms · ${out.at.slice(0, 19).replace('T', ' ')}`);
  L.push('');
  L.push(`L1 ${DESC.L1}：${s.l1.length} 张表 / ${sumL1} 行   ← 默认清理`);
  L.push(`L2 ${DESC.L2}：${s.l2.length} 张表 / ${sumL2} 行   ← 演示库保留；交付清库用 --with-demo`);
  L.push(`L3 ${DESC.L3}：${s.l3.length} 张表 / ${sumL3} 处   ← 只报告，不动（可能是真实数据）`);
  L.push('');

  if (s.l1.length) {
    L.push('-'.repeat(72));
    L.push('L1 明细（按行数排；「引用」= 有多少子表行指向它，删之前必须一起处理）');
    L.push('-'.repeat(72));
    L.push(`${pad('表', 28)}${pad('行/总', 11)}${pad('金额', 13)}${pad('类型', 8)}判定列`);
    s.l1.sort((a, b) => b.rows - a.rows).forEach((x) => {
      const amt = x.amount === null || x.amount === undefined ? '—' : '¥' + x.amount.toLocaleString('zh-CN');
      L.push(`${pad(x.table, 28)}${pad(`${x.rows}/${x.total}`, 11)}${pad(amt, 13)}${pad(x.finance ? '财务' : '业务', 8)}${x.judged_by.slice(0, 2).join(',')}`);
    });
    const finAmt = s.l1.filter((x) => x.finance && x.amount).reduce((a, x) => a + x.amount, 0);
    if (finAmt) {
      L.push('');
      L.push(`⚠ 其中财务类合计 ¥${finAmt.toLocaleString('zh-CN')} —— 默认不删，需要 --include-finance 显式确认`);
    }
    L.push('');
    L.push('样例（前 5 张表）：');
    s.l1.slice(0, 5).forEach((x) => {
      L.push(`  ${x.table}: ${JSON.stringify(x.sample)}`);
    });
  }

  if (s.l2.length) {
    L.push('');
    L.push('-'.repeat(72));
    L.push('L2 明细（演示数据，按 demo_tag 值归类）');
    L.push('-'.repeat(72));
    const tagAgg = {};
    s.l2.forEach((x) => x.tags.forEach((tg) => {
      tagAgg[tg.demo_tag] = (tagAgg[tg.demo_tag] || 0) + tg.c;
    }));
    Object.entries(tagAgg).sort((a, b) => b[1] - a[1]).forEach(([tag, n]) => {
      L.push(`  ${pad(tag, 20)}${n} 行`);
    });
  }

  if (s.l3.length) {
    L.push('');
    L.push('-'.repeat(72));
    L.push('L3 疑似（只报告）：这些是「备注/说明里提到烟测」的记录，可能是真实数据');
    L.push('-'.repeat(72));
    s.l3.sort((a, b) => b.hits - a.hits).slice(0, 12).forEach((x) => {
      L.push(`  ${pad(x.table, 28)}${pad(x.hits + ' 处', 10)}${x.cols.slice(0, 3).join(' ')}`);
    });
    if (s.l3.length > 12) L.push(`  …… 另有 ${s.l3.length - 12} 张表`);
  }

  L.push('');
  L.push('-'.repeat(72));
  L.push('关键指标（清理前后对比用；不该因为清烟测而变化的就是不能变的值）');
  L.push('-'.repeat(72));
  Object.entries(m).forEach(([k, v]) => L.push(`  ${pad(k, 18)}${v}`));
  L.push('');
  return L.join('\n');
}

/* ============================================================
 * 清理
 * ============================================================ */
function backup() {
  const dir = path.resolve(__dirname, '../../packages');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `clean-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${f.replace(/\\/g, '/')}'`);
  return f;
}

/**
 * 待删表的拓扑顺序：被引用的表排在后面（先删子、再删父）
 *
 * 这个库没有外键约束，顺序错了不会报错，只会留孤儿。
 * 所以先按引用关系做一次拓扑排序；有环时退回「按引用数降序」（引用越多越可能是子表）。
 */
function topoOrder(names) {
  const set = new Set(names);
  const parents = new Map();   // 表 -> 引用它的待删子表集合
  names.forEach((t) => parents.set(t, new Set()));
  names.forEach((child) => {
    refsOf(child).forEach((r) => {
      if (set.has(r.child) && r.child !== child) {
        // child 是 r.child 的子表 → 删 child 前不用管父表；父表要等 child 删完
        parents.get(r.child).add(r.child);
      }
    });
  });
  // 简单分层：没有任何待删子表引用它 → 先删它（它是叶子）
  const hasChild = new Map();
  names.forEach((t) => hasChild.set(t, 0));
  names.forEach((t) => {
    refsOf(t).forEach((r) => {
      const p = r.child;   // 指向 t 的子表
      if (set.has(p)) hasChild.set(t, (hasChild.get(t) || 0) + 1);
    });
  });
  const order = [];
  const done = new Set();
  let guard = 0;
  while (order.length < names.length && guard++ < names.length * 3) {
    names.forEach((t) => {
      if (done.has(t)) return;
      // 所有指向它的待删子表都已删 → 现在可以删它
      const children = refsOf(t).map((r) => r.child).filter((c) => set.has(c) && c !== t && !done.has(c));
      if (!children.length) { order.push(t); done.add(t); }
    });
  }
  // 环：剩下的按引用数降序
  names.filter((t) => !done.has(t)).sort((a, b) => refsOf(b).length - refsOf(a).length).forEach((t) => order.push(t));
  return order;
}

function clean(opts = {}) {
  const withDemo = !!opts.withDemo;
  const withFinance = !!opts.includeFinance;
  const dry = !!opts.dry;
  const s = scan();

  const skippedFinance = [];
  const roots = [];
  s.l1.forEach((x) => {
    if (x.finance && !withFinance) { skippedFinance.push(x); return; }
    roots.push({ table: x.table, where: smokeWhere(x.table).sql, kind: 'L1', amount: x.amount });
  });
  if (withDemo) {
    s.l2.forEach((x) => {
      if (roots.find((y) => y.table === x.table)) return;
      if (FINANCE_TABLES.has(x.table) && !withFinance) { skippedFinance.push({ table: x.table, rows: x.rows, amount: null }); return; }
      roots.push({ table: x.table, where: "demo_tag IS NOT NULL AND demo_tag <> ''", kind: 'L2', amount: null });
    });
  }
  if (!roots.length) {
    return { at: now(), deleted: 0, details: [], skipped_finance: skippedFinance, note: '没有需要清理的数据' };
  }

  const before = metrics();

  // 1) 取根 id
  const del = new Map();
  const rootInfo = new Map();
  roots.forEach((r) => {
    const rows = db.prepare(`SELECT id FROM ${r.table} WHERE ${r.where}`).all();
    const set = del.get(r.table) || new Set();
    rows.forEach((x) => set.add(x.id));
    del.set(r.table, set);
    rootInfo.set(r.table, { kind: r.kind, amount: r.amount });
  });

  // 2) 沿引用关系把子表 id 传播进来（父表是烟测的，子表一起删）
  //
  // 这一步是这个脚本的核心：没有它，「删了 230 个研发项目」会留下 115 条挂在
  // 已删项目下的任务（dev_tasks.project_id 指向不存在的行）—— 而这个库一个外键都没有，
  // 数据库不会拦你，只有下次有人查「任务数」时才发现多出 115 条孤儿。
  const origin = new Map();
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const [t, ids] of [...del]) {
      if (!ids.size) continue;
      refsOf(t).forEach((ref) => {
        if (!ref.rows) return;
        const arr = [...ids];
        for (let i = 0; i < arr.length; i += 400) {
          const chunk = arr.slice(i, i + 400);
          let rows = [];
          try {
            rows = db.prepare(`SELECT id FROM ${ref.child} WHERE ${ref.col} IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
          } catch (e) { return; }
          if (!rows.length) return;
          if (!del.has(ref.child)) { del.set(ref.child, new Set()); origin.set(ref.child, t); changed = true; }
          const set = del.get(ref.child);
          rows.forEach((r) => { if (!set.has(r.id)) { set.add(r.id); changed = true; } });
        }
      });
    }
    if (!changed) break;
  }

  // 3) 拓扑顺序：先删「没有待删子表」的表
  const names = [...del.keys()].filter((t) => del.get(t).size);
  const order = [];
  const done = new Set();
  let guard = 0;
  while (order.length < names.length && guard++ < names.length * 3) {
    names.forEach((t) => {
      if (done.has(t)) return;
      const children = refsOf(t).map((r) => r.child)
        .filter((c) => c !== t && del.has(c) && del.get(c).size && !done.has(c));
      if (!children.length) { order.push(t); done.add(t); }
    });
  }
  names.filter((t) => !done.has(t)).forEach((t) => order.push(t));

  let backupFile = null;
  if (!dry && !opts.skipBackup) backupFile = backup();

  const details = [];
  let total = 0;
  db.exec('BEGIN');
  try {
    order.forEach((t) => {
      const ids = [...del.get(t)];
      if (!ids.length) return;
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        if (!dry) db.prepare(`DELETE FROM ${t} WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
      }
      const info = rootInfo.get(t);
      details.push({ table: t, kind: info ? info.kind : '级联', from: origin.get(t) || null, rows: ids.length, amount: info ? info.amount : null });
      total += ids.length;
    });
    if (dry) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    at: now(), dry, with_demo: withDemo, with_finance: withFinance, backup: backupFile,
    deleted: total,
    tables: details.filter((d) => d.rows > 0).length,
    details: details.filter((d) => d.rows > 0).sort((a, b) => b.rows - a.rows),
    skipped_finance: skippedFinance,
    metrics_before: before,
    metrics_after: dry ? before : metrics()
  };
}

/* ============================================================
 * 清理后校验
 * ============================================================ */
/**
 * 三件事必须查：
 *   1. 残留归零（L1 应为 0；L2 视是否 --with-demo）
 *   2. **孤儿扫描**：子表的 `xxx_id` 指向了不存在的父行（没有外键约束，只能自己查）
 *   3. 关键指标没被误伤（对比清理前快照）
 */
/**
 * 已知的父子对（这个库没有外键约束，只能手工登记）
 *
 * 为什么必须登记而不是全靠列名猜：`order_item_sizes.item_id` 里的 `item_id` 太通用了，
 * 猜错了会删掉别人的明细。宁可少覆盖，不要错删。
 */
const PARENT_PAIRS = [
  ['order_entry_drafts','user_id','users'],
  ['order_entry_drafts','company_id','companies'],
  ['order_entry_drafts','order_id','orders'],
  ['pre_order_items','sample_archive_id','sample_archives'],
  ['tech_packs','source_archive_id','sample_archives'],
  ['sample_seals','order_item_id','order_items'],
  ['sample_seals','archive_id','sample_archives'],
  ['delivery_changes','source_change_id','order_changes'],
  ['tech_packs','order_item_id','order_items'],
  ['tech_packs','pre_order_item_id','pre_order_items'],
  ['material_dev_requests','pre_order_item_id','pre_order_items'],
  ['orders', 'source_pre_order_id', 'pre_orders'],
  ['order_items', 'source_pre_order_item_id', 'pre_order_items'],
  ['pre_order_items', 'pre_order_id', 'pre_orders'],
  ['pre_order_events', 'pre_order_id', 'pre_orders'],
  ['material_changes', 'material_id', 'materials'],
  ['order_items', 'order_id', 'orders'],
  ['order_item_sizes', 'item_id', 'order_items'],
  ['mall_inquiry_items', 'inquiry_id', 'mall_inquiries'],
  ['tech_pack_materials', 'tech_pack_id', 'tech_packs'],
  // 开发单的完整子树：v1.68.5 之前 `DELETE /api/techpacks/:id` 只删了上面三张明细表，
  // 打版流程与供方协同四张表没删 —— 库里积了 130 条孤儿流程 / 36 条孤儿阶段，
  // 而且这个扫描清单里没有它们，所以"无孤儿"一直是假绿。缺一条就漏一类，全部登记。
  ['pattern_flows', 'tech_pack_id', 'tech_packs'],
  ['pattern_stages', 'flow_id', 'pattern_flows'],
  ['tech_assignments', 'tech_pack_id', 'tech_packs'],
  ['supplier_confirms', 'tech_pack_id', 'tech_packs'],
  ['tech_reviews', 'tech_pack_id', 'tech_packs'],
  ['dev_tasks', 'project_id', 'dev_projects'],
  ['dev_milestones', 'project_id', 'dev_projects'],
  ['gl_entries', 'voucher_id', 'gl_vouchers'],
  ['budget_items', 'budget_id', 'budgets'],
  ['custody_records', 'item_id', 'custody_items'],
  ['office_ledger', 'item_id', 'office_items'],
  ['export_deliveries', 'job_id', 'export_jobs'],
  ['payroll_check_items', 'run_id', 'payroll_check_runs'],
  ['commitment_nodes', 'commitment_id', 'commitments'],
  ['cost_entries', 'cost_object_id', 'cost_objects'],
  ['cost_snapshots', 'cost_object_id', 'cost_objects'],
  // 产品颜色/尺码（v1.68.17）：产品的子表。删产品目前只停用不删行，但导数据/清库会按父行清，
  // 照样得登记 —— 清单缺一条，"无孤儿"就又是假绿。
  ['product_colors', 'product_id', 'products'],
  ['product_sizes', 'product_id', 'products']
];

/** 扫孤儿：子表的 xxx_id 指向了不存在的父行 */
function findOrphans() {
  const out = [];
  PARENT_PAIRS.forEach(([child, col, parent]) => {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${child} c WHERE c.${col} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = c.${col})`).get().c;
      if (n) out.push({ child, col, parent, rows: n });
    } catch (e) { /* 表/列不存在则跳过 */ }
  });
  return out;
}

/**
 * 修孤儿：删掉指向不存在父行的子表行
 *
 * 与「清烟测」分开做，因为性质不同：烟测是我造的，孤儿是历史遗留。
 * 混在一次操作里，出事时说不清是哪个动作导致的。
 */
function fixOrphans(dry) {
  const pairs = findOrphans();
  if (!pairs.length) return { at: now(), fixed: 0, details: [], dry: !!dry };
  let backupFile = null;
  if (!dry) backupFile = backup();
  const details = [];
  let total = 0;
  db.exec('BEGIN');
  try {
    pairs.forEach((x) => {
      try {
        const ids = db.prepare(`SELECT c.id FROM ${x.child} c WHERE c.${x.col} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${x.parent} p WHERE p.id = c.${x.col})`).all().map((r) => r.id);
        ids.forEach((id) => { if (!dry) db.prepare(`DELETE FROM ${x.child} WHERE id = ?`).run(id); });
        details.push({ ...x, deleted: ids.length });
        total += ids.length;
      } catch (e) { /* 跳过 */ }
    });
    if (dry) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { at: now(), fixed: total, details, dry: !!dry, backup: backupFile };
}

function verify() {
  const s = scan();
  const orphan = findOrphans();
  const l1 = s.l1.reduce((a, x) => a + x.rows, 0);
  const l2 = s.l2.reduce((a, x) => a + x.rows, 0);
  return {
    at: now(),
    l1_rows: l1,
    l2_rows: l2,
    l3_hits: s.l3.reduce((a, x) => a + x.hits, 0),
    orphan,
    metrics: metrics(),
    ok: l1 === 0 && orphan.length === 0
  };
}

/* ============================================================
 * CLI
 * ============================================================ */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);

  if (has('--verify')) {
    const r = verify();
    console.log('');
    console.log('清理后校验');
    console.log('='.repeat(60));
    console.log(`L1 烟测残留：${r.l1_rows} 行 ${r.l1_rows === 0 ? '✓' : '✗'}`);
    console.log(`L2 演示数据：${r.l2_rows} 行`);
    console.log(`L3 疑似（不动）：${r.l3_hits} 处`);
    console.log(`孤儿检查：${r.orphan.length ? '✗ ' + r.orphan.map((o) => `${o.child}.${o.col}→${o.parent} ${o.rows} 行`).join('；') : '✓ 无孤儿'}`);
    console.log(`结论：${r.ok ? '干净' : '仍有问题'}`);
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  if (has('--clean')) {
    const dry = has('--dry');
    const r = clean({ withDemo: has('--with-demo'), dry, includeFinance: has('--include-finance') });
    console.log('');
    console.log(dry ? '清理预演（不写库）' : '清理完成');
    console.log('='.repeat(60));
    if (r.backup) console.log(`备份：${r.backup}`);
    console.log(`删除 ${r.deleted} 行，涉及 ${r.tables} 张表${r.with_demo ? '（含演示数据）' : '（仅烟测夹具）'}${r.with_finance ? ' + 财务' : ''}`);
    if (r.details.length) {
      console.log('');
      r.details.forEach((d) => console.log(`  ${pad(d.table, 28)}${pad(d.kind, 8)}${pad(d.rows, 8)}${d.from ? ' ← ' + d.from : ''}${d.amount ? '  ¥' + d.amount.toLocaleString('zh-CN') : ''}`));
    }
    if (r.skipped_finance && r.skipped_finance.length) {
      console.log('');
      console.log('跳过（财务类，要 --include-finance 才删）：');
      r.skipped_finance.forEach((w) => console.log(`  · ${w.table} ${w.rows} 行${w.amount ? ' ¥' + w.amount.toLocaleString('zh-CN') : ''}`));
    }
    console.log('');
    if (dry) {
      // 预演模式没写库，前后必然一样 —— 打印对比会让人误以为「删了这么多却什么都没变」
      console.log('关键指标（预演模式，未写库，因此不会变化）：');
      Object.keys(r.metrics_before).forEach((k) => console.log(`  ${pad(k, 18)}${r.metrics_before[k]}`));
    } else {
      console.log('关键指标（前 → 后；清烟测不该动到真实业务口径）：');
      Object.keys(r.metrics_before).forEach((k) => {
        const a = r.metrics_before[k];
        const b = r.metrics_after[k];
        console.log(`  ${pad(k, 18)}${pad(a, 14)}${a === b ? '不变' : '→ ' + b}`);
      });
    }
    console.log('');
    process.exit(0);
  }

  if (has('--fix-orphans')) {
    const dry = has('--dry');
    const r = fixOrphans(dry);
    console.log('');
    console.log(dry ? '孤儿修复预演（不写库）' : '孤儿修复完成');
    console.log('='.repeat(60));
    if (r.backup) console.log(`备份：${r.backup}`);
    if (!r.details.length) console.log('没有孤儿 ✓');
    else {
      console.log(`修复 ${r.fixed} 行：`);
      r.details.forEach((d) => console.log(`  ${pad(d.child + '.' + d.col, 34)}→ ${d.parent}  删除 ${d.deleted} 行`));
      console.log('');
      console.log('这些行指向了不存在的父行（父行早已删除），留着只会污染按子表聚合的统计。');
    }
    console.log('');
    process.exit(0);
  }

  if (has('--json')) {
    console.log(JSON.stringify(report(true), null, 2));
    process.exit(0);
  }

  console.log(report(false));
}

module.exports = { scan, metrics, report, clean, verify, refsOf, smokeWhere, topoOrder, findOrphans, fixOrphans };
