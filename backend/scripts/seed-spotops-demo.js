/**
 * 现货经营总览 + 备货补货与停补提案 —— 演示数据（可重复重放）
 * ============================================================
 * 用法：
 *   node scripts/seed-spotops-demo.js           # 增量补齐
 *   node scripts/seed-spotops-demo.js --reset    # 先清掉本演示的数据再重建
 *
 * 演示覆盖的 6 种典型处境：
 *   SXO-01 高腰直筒牛仔裤   热销、可售见底、有一批在途 → **补货（来不及，P1）**
 *   SXO-02 基础针织开衫     卖得稳、覆盖 90 天  → **正常，不出建议**（避免噪音）
 *   SXO-03 复古印花衬衫     卖不动、库龄 130 天 → **停补（覆盖+库龄双超阈值）**
 *   SXO-04 修身连衣裙       S/M 卖光、L/XL 还有 → **断码补货**（不是整款停补）
 *   SXO-05 羊毛围巾         上架 12 天只 3 天出库 → **样本不足，只观察不给量**
 *   SXO-06 运动短裤         已卖完、无在途       → **已断货，P1 补货**
 *
 * 另外演示：
 *   - 全局策略 + 一条按款覆盖（SXO-05 目标 45 天 / 周期 30 天）
 *   - 一笔有效现货占用（SXO-01 M/KHAKI 30 件）→ 可售 < 实物
 *   - 一个「在产但没 ETA」的批次（SXO-02）→ 算不可承诺，覆盖天数不虚高
 *   - 已下发批次 A（含批准/驳回/暂缓三种决策）+ 草稿批次 B
 */
const { db, now } = require('../src/db');
const S = require('../src/services/spotops');

const TAG = 'spotops-demo';
const RESET = process.argv.includes('--reset');
const T = S.todayStr();
const D = (n) => S.addDays(T, n);

const ts = (date, hh = 10) => `${date} ${String(hh).padStart(2, '0')}:00:00`;

// 每个 SKU：当前实物、累计售出、首次到货距今天数、有出库的天数、出库铺开的天数
const STYLES = [
  {
    style: 'SXO-01', name: '高腰直筒牛仔裤', colors: ['KHAKI', 'BLACK'], sizes: ['S', 'M', 'L', 'XL'],
    per: { S: { stock: 20, sold: 260 }, M: { stock: 60, sold: 300 }, L: { stock: 55, sold: 280 }, XL: { stock: 22, sold: 240 } },
    inDaysAgo: 110, recentDays: 20, outDays: 55, spread: 60, hold: { color: 'KHAKI', size: 'M', qty: 30, customer: 'West Coast Apparel Inc.' },
    batches: [
      { color: 'KHAKI', size: 'M', qty: 200, stage: 'in_transit', eta: 12 },
      { color: 'BLACK', size: 'L', qty: 200, stage: 'ready_to_ship', eta: 9 }
    ]
  },
  {
    style: 'SXO-02', name: '基础针织开衫', colors: ['CREAM', 'NAVY'], sizes: ['S', 'M', 'L'],
    per: { S: { stock: 90, sold: 62 }, M: { stock: 95, sold: 70 }, L: { stock: 88, sold: 58 } },
    inDaysAgo: 100, recentDays: 25, outDays: 42, spread: 55,
    batches: [{ color: 'NAVY', size: 'M', qty: 300, stage: 'in_production', eta: null }]
  },
  {
    style: 'SXO-03', name: '复古印花衬衫', colors: ['RUST', 'OLIVE'], sizes: ['S', 'M', 'L'],
    per: { S: { stock: 48, sold: 18 }, M: { stock: 45, sold: 16 }, L: { stock: 42, sold: 14 } },
    inDaysAgo: 130, outDays: 20, spread: 50
  },
  {
    style: 'SXO-04', name: '修身针织连衣裙', colors: ['BLACK'], sizes: ['S', 'M', 'L', 'XL'],
    per: { S: { stock: 0, sold: 120 }, M: { stock: 0, sold: 110 }, L: { stock: 140, sold: 40 }, XL: { stock: 130, sold: 30 } },
    inDaysAgo: 70, recentDays: 30, outDays: 40, spread: 55
  },
  {
    style: 'SXO-05', name: '羊毛混纺围巾', colors: ['CAMEL'], sizes: ['均码'],
    per: { 均码: { stock: 40, sold: 9 } },
    inDaysAgo: 12, outDays: 3, spread: 10
  },
  {
    style: 'SXO-06', name: '速干运动短裤', colors: ['GREY'], sizes: ['S', 'M', 'L'],
    per: { S: { stock: 0, sold: 90 }, M: { stock: 0, sold: 110 }, L: { stock: 0, sold: 80 } },
    inDaysAgo: 90, outDays: 30, spread: 60
  }
];

function clear() {
  const runs = db.prepare('SELECT id FROM spot_proposal_runs WHERE demo_tag = ?').all(TAG).map((r) => r.id);
  if (runs.length) {
    const inSql = runs.map(() => '?').join(',');
    db.prepare(`DELETE FROM spot_proposal_decisions WHERE run_id IN (${inSql})`).run(...runs);
    db.prepare(`DELETE FROM spot_proposal_lines WHERE run_id IN (${inSql})`).run(...runs);
    db.prepare(`DELETE FROM spot_proposal_runs WHERE id IN (${inSql})`).run(...runs);
  }
  db.prepare('DELETE FROM spot_policies WHERE demo_tag = ?').run(TAG);

  const styles = STYLES.map((s) => s.style);
  const inSql = styles.map(() => '?').join(',');
  db.prepare(`DELETE FROM stock_ledger WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM stock_items WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM sellable_projection WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM supply_batches WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM stock_holds WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  console.log('[reset] 已清理本演示的策略 / 批次 / 提案 / 库存流水');
}

// ============ 1. 备货策略 ============
function seedPolicies() {
  const t = now();
  const stmt = db.prepare(
    `INSERT INTO spot_policies
      (company_id, warehouse, scope, style_no, category, target_cover_days, safety_days, lead_time_days,
       min_order_qty, lot_size, stop_cover_days, stop_age_days, dead_days, min_sample_days,
       status, note, updated_by, created_at, updated_at, demo_tag)
     VALUES (1,'us',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company_id, warehouse, scope, style_no, category) DO UPDATE SET
       target_cover_days=excluded.target_cover_days, safety_days=excluded.safety_days,
       lead_time_days=excluded.lead_time_days, min_order_qty=excluded.min_order_qty,
       lot_size=excluded.lot_size, stop_cover_days=excluded.stop_cover_days,
       stop_age_days=excluded.stop_age_days, dead_days=excluded.dead_days,
       min_sample_days=excluded.min_sample_days, note=excluded.note, updated_at=excluded.updated_at,
       demo_tag=excluded.demo_tag`
  );
  stmt.run('global', '', '', 60, 15, 45, 100, 50, 120, 90, 30, 5, 'active',
    '默认：目标覆盖 60 天 + 安全 15 天，生产周期 45 天（含海运），起订 100 件 / 批量 50 件', 'admin', t, t, TAG);
  stmt.run('category', '', 'outerwear_cat', 90, 20, 60, 200, 100, 150, 120, 30, 5, 'active',
    '外套类：单价高、备货保守，覆盖 90 天', 'admin', t, t, TAG);
  stmt.run('style', 'SXO-05', '', 45, 10, 30, 60, 20, 90, 60, 20, 5, 'active',
    '围巾试销款：周期短（空运），起订低', 'admin', t, t, TAG);
  console.log('[1] 备货策略 3 条（全局 + 类目 + 按款覆盖）');
}

// ============ 2. 库存 / 流水 / 在途 / 占用 ============
/** 把 sold 摊到 outDays 个有出库的日子上；每 5 天里有 1 天不卖（让「有出库天数」真实少于窗口） */
function spreadOuts(sold, outDays, spread) {
  const days = [];
  let left = sold;
  for (let i = 0; i < outDays; i += 1) {
    if (i % 5 === 4) continue;                       // 这天没卖
    const offset = 1 + Math.round((i * spread) / Math.max(1, outDays - 1));
    days.push(offset);
  }
  if (!days.length) days.push(1);
  const per = Math.max(1, Math.floor(sold / days.length));
  const rows = [];
  days.forEach((off, idx) => {
    const qty = idx === days.length - 1 ? left : Math.min(per, left);
    if (qty <= 0) return;
    rows.push({ offset: off, qty });
    left -= qty;
  });
  if (left > 0 && rows.length) rows[rows.length - 1].qty += left;
  return rows;
}

function seedStock() {
  const t = now();
  // 幂等：先清掉本演示这几个款在美仓的流水/在途/占用，否则不加 --reset 重跑会把销量翻倍
  const styles = STYLES.map((s) => s.style);
  const inSql = styles.map(() => '?').join(',');
  db.prepare(`DELETE FROM stock_ledger WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM stock_items WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM sellable_projection WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM supply_batches WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  db.prepare(`DELETE FROM stock_holds WHERE warehouse='us' AND style_no IN (${inSql})`).run(...styles);
  const insItem = db.prepare(
    `INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at)
     VALUES ('us',?,?,?,?,?,?)
     ON CONFLICT(warehouse, style_no, color, size) DO UPDATE SET qty=excluded.qty, product_name=excluded.product_name, updated_at=excluded.updated_at`
  );
  const insLedger = db.prepare(
    `INSERT INTO stock_ledger (warehouse, style_no, product_name, color, size, type, qty, ref_type, remark, operator, created_at)
     VALUES ('us',?,?,?,?,?,?,?,?,'demo',?)`
  );
  const insProj = db.prepare(
    `INSERT INTO sellable_projection (warehouse, style_no, color, size, sku, on_hand, held_spot, qty_picked, sellable, future_available, version, computed_at, stale, anomaly)
     VALUES ('us',?,?,?,?,?,?,0,?,0,1,?,0,NULL)
     ON CONFLICT DO NOTHING`
  );
  const insHold = db.prepare(
    `INSERT INTO stock_holds (hold_no, company_id, kind, warehouse, style_no, color, size, sku, qty, qty_picked,
       customer_name, status, temporary, expires_at, created_by, created_at, updated_at, demo_tag)
     VALUES (?,1,'spot','us',?,?,?,?,?,0,?,'active',1,?,'demo',?,?,?)`
  );
  const insBatch = db.prepare(
    `INSERT INTO supply_batches
       (batch_no, company_id, warehouse, style_no, product_name, color, size, sku,
        source_type, qc_grade, intended_use, stage,
        qty_planned, qty_produced, qty_ready, qty_in_transit,
        qty_received, qty_checked_ok, qty_on_shelf, qty_short, risk_buffer, frozen_qty,
        eta_date, eta_evidence, eta_covered, status, created_by, created_at, updated_at, demo_tag)
     VALUES (?,1,'us',?,?,?,?,?,'production','A','sellable',?,
             ?,?,?,?, 0,0,0,0,0,0, ?,?,?, 'active','demo',?,?,?)`
  );

  let skuCount = 0;
  let ledgerCount = 0;
  let batchSeq = 1;
  STYLES.forEach((st) => {
    st.colors.forEach((color) => {
      st.sizes.forEach((size) => {
        const cfg = st.per[size] || { stock: 0, sold: 0 };
        const sku = `${st.style}-${color}-${size}`;
        insItem.run(st.style, st.name, color, size, cfg.stock, t);
        skuCount += 1;

        // 首次到货：老货数量正好等于累计售出（FIFO 会把它吃干净）
        insLedger.run(st.style, st.name, color, size, 'in', cfg.sold, 'order', '首次到货', ts(D(-st.inDaysAgo), 9));
        ledgerCount += 1;
        // 最近一次补货：当前在库都是这一批（热销款库龄短才对，否则会被误判「库龄超龄停补」）
        if (cfg.stock > 0) {
          const recent = st.recentDays ? D(-st.recentDays) : D(-st.inDaysAgo);
          insLedger.run(st.style, st.name, color, size, 'in', cfg.stock, 'order', '补货到仓', ts(recent, 9));
          ledgerCount += 1;
        }

        // 出库
        spreadOuts(cfg.sold, st.outDays, st.spread).forEach((o) => {
          insLedger.run(st.style, st.name, color, size, 'out', -o.qty, 'order', '现货销售出库', ts(D(-o.offset), 15));
          ledgerCount += 1;
        });
      });
    });
  });

  // 有效现货占用（只给 SXO-01 KHAKI/M）
  STYLES.forEach((st) => {
    if (!st.hold) return;
    const h = st.hold;
    insHold.run(
      `HD${T.replace(/-/g, '')}9001`, st.style, h.color, h.size, `${st.style}-${h.color}-${h.size}`,
      h.qty, h.customer, D(2), t, t, TAG
    );
  });

  // 可买量投影（与占用一致；真实系统由 supply 服务维护）
  STYLES.forEach((st) => {
    st.colors.forEach((color) => {
      st.sizes.forEach((size) => {
        const cfg = st.per[size] || { stock: 0, sold: 0 };
        const held = st.hold && st.hold.color === color && st.hold.size === size ? st.hold.qty : 0;
        insProj.run(st.style, color, size, `${st.style}-${color}-${size}`, cfg.stock, held, Math.max(0, cfg.stock - held), t);
      });
    });
  });

  // 在途 / 在产批次
  STYLES.forEach((st) => {
    (st.batches || []).forEach((b) => {
      const qty = b.qty;
      const isProd = b.stage === 'in_production';
      insBatch.run(
        `SB${T.replace(/-/g, '')}9${String(batchSeq).padStart(3, '0')}`, st.style, st.name, b.color, b.size,
        `${st.style}-${b.color}-${b.size}`, b.stage,
        qty, isProd ? qty : 0, b.stage === 'ready_to_ship' ? qty : 0, b.stage === 'in_transit' ? qty : 0,
        b.eta ? D(b.eta) : null,
        b.eta ? (isProd ? `排产单 ${st.style} / 预计完工` : '船期 SZX-LAX') : null,
        b.eta ? 1 : 0,
        t, t, TAG
      );
      batchSeq += 1;
    });
  });

  console.log(`[2] 现货：${STYLES.length} 款 / ${skuCount} 个 SKU / ${ledgerCount} 条流水 / 1 笔现货占用 / 3 个在途在产批次`);
}

// ============ 3. 生成批次并做决策 ============
function buildRuns() {
  const a = S.generateRun({ warehouse: 'us', windowDays: 60, operator: 'admin', note: '本季度第一次补货评审' });
  db.prepare('UPDATE spot_proposal_runs SET demo_tag = ? WHERE id = ?').run(TAG, a.run_id);

  // 决策：批准 2 条、驳回 1 条、暂缓 1 条
  const lines = db.prepare('SELECT * FROM spot_proposal_lines WHERE run_id = ? ORDER BY id').all(a.run_id);
  const reple = lines.filter((l) => l.kind === 'replenish');
  const stops = lines.filter((l) => l.kind === 'stop');

  if (reple[0]) S.decideLine(reple[0].id, { action: 'approve', note: '这码确实要断，按建议量下单' }, 'admin');
  if (reple[1]) S.decideLine(reple[1].id, { action: 'approve', qty: Math.max(1, Math.round(Number(reple[1].suggest_qty) / 2)), note: '先补一半，看下周销速' }, 'admin');
  if (reple[2]) S.decideLine(reple[2].id, { action: 'defer', note: '等这周促销结束再定，避免压货' }, 'admin');
  if (stops[0]) S.decideLine(stops[0].id, { action: 'reject', note: '这款刚谈下一个批发客户，先不停止补货，改下月再看' }, 'admin');

  S.publishRun(a.run_id, 'admin', '第一次补货与停补提案已下发');

  const b = S.generateRun({ warehouse: 'us', windowDays: 60, operator: 'admin', note: '按新销速重算（草稿）' });
  db.prepare('UPDATE spot_proposal_runs SET demo_tag = ? WHERE id = ?').run(TAG, b.run_id);

  const after = db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(a.run_id);
  console.log(`[3] 批次 A：${a.run_no} 建议 ${a.line_count} 条（补货 ${a.replenish_count} / 停补 ${a.stop_count} / 来不及 ${a.urgent_count} / 样本不足 ${a.sample_short_count}）→ 已决策 4 条、已下发`);
  console.log(`[3] 批次 B：${b.run_no} 建议 ${b.line_count} 条（草稿，全部待决策）`);
  void after;
}

// ============ main ============
if (RESET) clear();
seedPolicies();
seedStock();
buildRuns();

console.log('\n=== 演示数据就绪 ===');
const ov = S.styleOverview({ warehouse: 'us', windowDays: 60 });
console.log(`现货总览：${ov.stat.style_count} 款 / ${ov.stat.sku_count} SKU｜在库 ${ov.stat.on_hand}｜可售 ${ov.stat.sellable}（占用 ${ov.stat.held}，${ov.stat.held_pct}%）｜日均销 ${ov.stat.daily_out}｜整体覆盖 ${ov.stat.cover_days} 天`);
console.log(`需要补货 ${ov.stat.replenish_style} 款 / 建议停补 ${ov.stat.stop_style} 款 / 断码 ${ov.stat.broken_style} 款 / 无 ETA 供给 ${ov.stat.no_eta_cnt} 处`);
console.log('\n按款：');
ov.styles.forEach((s) => {
  console.log(`  ${s.style_no} ${s.product_name}｜在库 ${s.on_hand}｜可售 ${s.sellable}｜在途 ${s.in_transit}｜在产 ${s.in_production}｜日均 ${s.daily_out}｜覆盖 ${s.cover_days === null ? '—' : s.cover_days + '天'}｜库龄 ${s.age_days}天｜${s.suggestion}${s.broken_sizes.length ? '（断码 ' + s.broken_sizes.join('/') + '）' : ''}`);
});
