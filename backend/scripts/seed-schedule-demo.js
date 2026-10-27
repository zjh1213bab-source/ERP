/**
 * M06 有限产能排程 —— 演示数据（可重复重放）
 * ============================================================
 * 用法：
 *   node scripts/seed-schedule-demo.js           # 增量补齐
 *   node scripts/seed-schedule-demo.js --reset    # 先清掉本演示的数据再重建
 *
 * 演示覆盖的场景：
 *   1. 工序定额：9 道产能工序 → 工作中心（备料/排版算料/成品入库/出库发运不占产能）
 *   2. 班次日历：工作日 8 小时、周末 0（显式写入，缺行=不可用）
 *   3. 6 张演示订单：
 *        O1 正常按期（带绣花工艺 → 条件工序生效）
 *        O2 缺料但有到货日 → 开工日按到货日推后（软提示）
 *        O3 交期太紧 → 交期不可达（软提示，给出超期天数）
 *        O4 评审未通过 → 只能内部参考（软提示）
 *        O5 数量大 → 窗口内装不下（硬冲突，不排）
 *        O6 缺料且无到货日 → 硬冲突，不排
 *   4. 生成批次 A：处理掉硬冲突 → 发布为当前生效
 *   5. 生成批次 B：草稿版本，锁定一个任务 + 调整一个任务的时段（写原因，留痕）
 *
 * 注意：演示只排自己这 6 张单（按 order_ids 限定），
 * 因为库里其他演示脚本建的订单件数为 0，会刷出一堆「无明细件数」的噪音。
 */
const { db, now } = require('../src/db');
const S = require('../src/services/scheduling');

const TAG = 'sched-demo';
const RESET = process.argv.includes('--reset');
const T = S.todayStr();
const D = (n) => S.addDays(T, n);

function nextOrderNo() {
  const prefix = 'SCHDEMO';
  const rows = db.prepare('SELECT order_no FROM orders WHERE order_no LIKE ?').all(`${prefix}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.order_no).slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

const NODES = ['备料', '排版算料', '裁剪', '车缝', '锁眼钉扣', '整烫', '水洗', '印花', '绣花', '检验', '包装', '成品入库', '出库发运'];

// 工序定额：工序 → 工作中心 / 单件分钟 / 换款分钟 / 效率
const STDS = [
  { process_name: '裁剪', work_center: '裁剪组', std_minutes: 0.35, setup_minutes: 30, efficiency: 85, remark: '含验片、编号' },
  { process_name: '车缝', work_center: '一车间', std_minutes: 2.0, setup_minutes: 45, efficiency: 85, remark: '主缝制线' },
  { process_name: '锁眼钉扣', work_center: '二车间', std_minutes: 1.2, setup_minutes: 20, efficiency: 88, remark: '专用机' },
  { process_name: '整烫', work_center: '整烫组', std_minutes: 1.0, setup_minutes: 15, efficiency: 90 },
  { process_name: '水洗', work_center: '水洗车间', std_minutes: 0.15, setup_minutes: 30, efficiency: 95, remark: '批量缸洗' },
  { process_name: '印花', work_center: '印花车间', std_minutes: 0.4, setup_minutes: 60, efficiency: 80, remark: '含制版调试' },
  { process_name: '绣花', work_center: '绣花车间', std_minutes: 1.5, setup_minutes: 60, efficiency: 80 },
  { process_name: '检验', work_center: '后整区', std_minutes: 0.3, setup_minutes: 0, efficiency: 92 },
  { process_name: '包装', work_center: '后整区', std_minutes: 0.5, setup_minutes: 0, efficiency: 92 }
];

function clear() {
  const runs = db.prepare('SELECT id FROM schedule_runs WHERE demo_tag = ?').all(TAG).map((r) => r.id);
  if (runs.length) {
    const inSql = runs.map(() => '?').join(',');
    db.prepare(`DELETE FROM schedule_changes WHERE run_id IN (${inSql})`).run(...runs);
    db.prepare(`DELETE FROM schedule_conflicts WHERE run_id IN (${inSql})`).run(...runs);
    db.prepare(`DELETE FROM schedule_tasks WHERE run_id IN (${inSql})`).run(...runs);
    db.prepare(`DELETE FROM schedule_runs WHERE id IN (${inSql})`).run(...runs);
  }
  db.prepare('DELETE FROM wc_calendars WHERE demo_tag = ?').run(TAG);
  db.prepare('DELETE FROM process_standards WHERE demo_tag = ?').run(TAG);

  const orders = db.prepare("SELECT id FROM orders WHERE order_no LIKE 'SCHDEMO%'").all().map((o) => o.id);
  if (orders.length) {
    const inSql = orders.map(() => '?').join(',');
    db.prepare(`DELETE FROM material_requirements WHERE order_id IN (${inSql})`).run(...orders);
    db.prepare(`DELETE FROM commitments WHERE order_id IN (${inSql})`).run(...orders);
    db.prepare(`DELETE FROM order_nodes WHERE order_id IN (${inSql})`).run(...orders);
    db.prepare(`DELETE FROM order_crafts WHERE order_id IN (${inSql})`).run(...orders);
    db.prepare(`DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id IN (${inSql}))`).run(...orders);
    db.prepare(`DELETE FROM order_items WHERE order_id IN (${inSql})`).run(...orders);
    db.prepare(`DELETE FROM order_logs WHERE order_id IN (${inSql})`).run(...orders);
    db.prepare(`DELETE FROM orders WHERE id IN (${inSql})`).run(...orders);
  }
  db.prepare("DELETE FROM purchase_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE po_no LIKE 'SCHDEMO%')").run();
  db.prepare("DELETE FROM purchase_orders WHERE po_no LIKE 'SCHDEMO%'").run();
  console.log('[reset] 已清理本演示的排程批次 / 日历 / 定额 / 订单 / 采购');
}

// ============ 1. 工序定额 ============
function seedStandards() {
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO process_standards
      (process_name, work_center, std_minutes, setup_minutes, efficiency, batch_min_qty, active, remark, updated_by, created_at, updated_at, demo_tag)
     VALUES (?,?,?,?,?,?,1,?,?,?,?,?)`
  );
  STDS.forEach((s) => {
    const exist = db.prepare('SELECT id FROM process_standards WHERE process_name = ?').get(s.process_name);
    if (exist) {
      db.prepare(
        'UPDATE process_standards SET work_center=?, std_minutes=?, setup_minutes=?, efficiency=?, remark=?, updated_at=? WHERE id=?'
      ).run(s.work_center, s.std_minutes, s.setup_minutes, s.efficiency, s.remark || null, ts, exist.id);
    } else {
      stmt.run(s.process_name, s.work_center, s.std_minutes, s.setup_minutes, s.efficiency, 0, s.remark || null, 'admin', ts, ts, TAG);
    }
  });
  console.log(`[1] 工序定额 ${STDS.length} 条`);
}

// ============ 2. 班次日历 ============
// 班次基准工时：一车间赶货开两班（12 小时），其余单班 8 小时
const WC_HOURS = {
  一车间: 12,
  裁剪组: 8,
  二车间: 8,
  整烫组: 8,
  水洗车间: 8,
  印花车间: 8,
  绣花车间: 8,
  后整区: 8
};

function seedCalendar() {
  const from = D(-3);
  const to = D(45);
  const ts = now();
  const wcs = S.workCenters().map((x) => x.work_center);
  const stmt = db.prepare(
    `INSERT INTO wc_calendars (company_id, work_center, cal_date, base_hours, start_hour, is_workday, note, created_by, created_at, updated_at, demo_tag)
     VALUES (1,?,?,?,8,?,?,?,?,?,?)
     ON CONFLICT(work_center, cal_date) DO UPDATE SET
       base_hours = excluded.base_hours, is_workday = excluded.is_workday,
       note = excluded.note, updated_at = excluded.updated_at, demo_tag = excluded.demo_tag`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    wcs.forEach((wc) => {
      const dayHours = WC_HOURS[wc] === undefined ? 8 : WC_HOURS[wc];
      S.dateList(from, to).forEach((d) => {
        const dow = new Date(`${d}T00:00:00`).getDay();
        const rest = dow === 0 || dow === 6;
        stmt.run(wc, d, rest ? 0 : dayHours, rest ? 0 : 1, rest ? '周末休息' : (dayHours > 8 ? '赶货两班' : null), 'admin', ts, ts, TAG);
        n += 1;
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[2] 班次日历 ${n} 行（${wcs.length} 个工作中心 × ${from}~${to}，周末 0 小时，一车间 12 小时两班）`);
}

// ============ 3. 演示订单 ============
const ORDERS = [
  {
    key: 'A', style: '女式羊毛混纺大衣 SCH-A', product: '女式羊毛混纺大衣', qty: 400,
    due: 18, status: 'assigned', review: 'approved', crafts: ['绣花'], short: []
  },
  {
    key: 'B', style: '男士连帽加绒卫衣 SCH-B', product: '男士连帽加绒卫衣', qty: 800,
    due: 16, status: 'production', review: 'approved', crafts: [],
    short: [{ material_id: 9, name: '2099#极蓝棉220G', gap: 300, unit: 'kg', eta: 4 }]
  },
  {
    key: 'C', style: '儿童针织长裤 SCH-C', product: '儿童针织长裤', qty: 600,
    due: 4, status: 'assigned', review: 'approved', crafts: [], short: []
  },
  {
    key: 'D', style: '女士真丝衬衫 SCH-D', product: '女士真丝衬衫', qty: 200,
    due: 25, status: 'tech', review: 'pending', crafts: [], short: []
  },
  {
    key: 'E', style: '现货基础圆领T恤 SCH-E', product: '基础圆领T恤', qty: 5000,
    due: 32, status: 'assigned', review: 'approved', crafts: [], short: []
  },
  {
    key: 'F', style: '冬季轻薄羽绒服 SCH-F', product: '冬季轻薄羽绒服', qty: 600,
    due: 14, status: 'production', review: 'approved', crafts: [],
    short: [{ material_id: null, name: '进口20D尼龙面料（未下单）', gap: 900, unit: 'm', eta: null }]
  }
];

function seedOrders() {
  const ts = now();
  const created = [];
  const cust = db.prepare("SELECT id, name FROM customers WHERE name LIKE '%美国%' OR id = 1 LIMIT 1").get()
    || db.prepare('SELECT id, name FROM customers LIMIT 1').get();

  ORDERS.forEach((o) => {
    const orderNo = nextOrderNo();
    const info = db.prepare(
      `INSERT INTO orders
        (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, style_name,
         order_date, delivery_date, delivery_method, trade_terms, manager, remark, created_by, created_at, updated_at, company_id)
       VALUES (?,?,?,?,7.1,?,?,'USD',?,?,?,'海运','FOB','admin',?,1,?,?,1)`
    ).run(
      orderNo, o.key === 'E' ? 'stock' : 'custom', cust ? cust.id : null, o.status,
      o.qty * 12, o.qty * 12 * 7.1, o.style,
      D(-2), D(o.due), `排程演示订单 ${o.key}`, ts, ts
    );
    const orderId = Number(info.lastInsertRowid);

    // 款 + 颜色尺码
    const item = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, style_no, sku, color, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(orderId, null, o.product, `SCH-${o.key}`, `SCH-${o.key}-01`, '主色', o.qty, o.qty * 12, o.qty * 12 * 7.1);
    const itemId = Number(item.lastInsertRowid);
    const sizes = ['S', 'M', 'L', 'XL'];
    sizes.forEach((sz, i) => {
      const q = Math.round(o.qty / sizes.length) + (i === 1 ? o.qty % sizes.length : 0);
      db.prepare(
        'INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
      ).run(itemId, '主色', sz, q, 12, 12 * 7.1, q * 12, q * 12 * 7.1);
    });

    // 13 道工序节点
    NODES.forEach((name, i) => {
      db.prepare('INSERT INTO order_nodes (order_id, name, seq, status, created_at) VALUES (?,?,?,?,?)')
        .run(orderId, name, i + 1, 'pending', ts);
    });

    // 工艺（决定条件工序是否排）
    (o.crafts || []).forEach((c) => {
      db.prepare('INSERT INTO order_crafts (order_id, name, qty, price, rate, is_out, created_at) VALUES (?,?,?,?,?,0,?)')
        .run(orderId, c, o.qty, 8, 1, ts);
    });

    // 交期承诺
    db.prepare(
      `INSERT INTO commitments
        (order_id, order_no, customer_name, style_no, qty, route_type, t0_at, t0_source, promised_date, planned_date,
         review_status, front_ok, back_ok, material_ok, reviewed_by, reviewed_at, risk_level, created_at, updated_at)
       VALUES (?,?,?,?,?,'inhouse',?,'confirm',?,?,?,?,?,?,?,?,'none',?,?)`
    ).run(
      orderId, orderNo, cust ? cust.name : null, `SCH-${o.key}`, o.qty,
      D(-2), D(o.due), D(o.due),
      o.review, o.review === 'approved' ? 1 : 0, o.review === 'approved' ? 1 : 0, o.review === 'approved' ? 1 : 0,
      o.review === 'approved' ? 'admin' : null, o.review === 'approved' ? ts : null, ts, ts
    );

    // 缺料（material_requirements 是齐套算出来的，这里直接给演示值）
    (o.short || []).forEach((m) => {
      db.prepare(
        `INSERT INTO material_requirements
          (order_id, order_no, material_id, material_name, mat_type, unit, need_qty, alloc_stock, alloc_po, gap_qty, gap_amount,
           impact_node, status, action, calc_at, updated_at)
         VALUES (?,?,?,?,'fabric',?,?,?,0,?,?, 'P5 裁剪','short','pending',?,?)`
      ).run(
        orderId, orderNo, m.material_id, m.name, m.unit,
        m.gap + 100, 100, m.gap, m.gap * 30, ts, ts
      );
    });

    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(orderId, null, o.status, 'admin', `[排程演示] 建单 ${o.key}`, ts);

    created.push({ ...o, order_id: orderId, order_no: orderNo });
  });

  // 一条在途采购（给 O2 的缺料一个到货日）
  const poInfo = db.prepare(
    "INSERT INTO purchase_orders (po_no, supplier, status, order_date, expect_date, remark, total_amount, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)"
  ).run('SCHDEMO-PO1', '绍兴柯桥面料行', 'ordered', D(-1), D(4), '排程演示：缺口面料补单', 9000, ts, ts);
  db.prepare(
    'INSERT INTO purchase_items (po_id, material_id, name, spec, unit, qty, received_qty, price, amount) VALUES (?,?,?,?,?,?,0,?,?)'
  ).run(Number(poInfo.lastInsertRowid), 9, '2099#极蓝棉220G', '220G', 'kg', 500, 30, 15000);

  console.log(`[3] 演示订单 ${created.length} 张：`);
  created.forEach((c) => console.log(`    ${c.order_no}  ${c.style}  ${c.qty} 件  交期 T+${c.due}  ${c.status}  评审 ${c.review}${c.short.length ? '  [有缺料]' : ''}${(c.crafts || []).length ? '  [工艺 ' + c.crafts.join('/') + ']' : ''}`));
  return created;
}

// ============ 4. 生成并发布批次 A ============
function buildRunA(orderIds) {
  const res = S.createRun({
    from: T, to: D(30), algo: 'edd', orderIds,
    carryLocked: false, materialGate: true, companyId: 1,
    operator: 'admin', note: '排程演示：首批有限产能排程'
  });
  db.prepare('UPDATE schedule_runs SET demo_tag = ? WHERE id = ?').run(TAG, res.run_id);

  const blocks = db.prepare("SELECT * FROM schedule_conflicts WHERE run_id = ? AND level = 'block' AND resolved = 0").all(res.run_id);
  const notes = {
    material_short: '已在采购例会上定：改由替代料先做 300 件，剩余等 SCHDEMO-PO1 到货',
    horizon_short: '已决定把 1500 件拆到外协厂，剩余 1500 件留本厂排，交期跟客户确认顺延一周',
    no_standard: '已临时指定定额，下次维护进标准表',
    no_qty: '业务已确认作废该单',
    no_calendar: '已补班次日历'
  };
  blocks.forEach((c) => {
    db.prepare('UPDATE schedule_conflicts SET resolved = 1, resolved_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(notes[c.type] || '已确认处理', 'admin', now(), c.id);
  });
  S.publishRun(res.run_id, 'admin', '首批排程发布：生产按下发执行');
  console.log(`[4] 批次 A：${res.run_no} 任务 ${res.task_count} 条，冲突 ${res.conflict_count} 条（硬 ${res.block_count} 条已逐条处理）→ 已发布为当前生效`);
  return res.run_id;
}

// ============ 5. 生成草稿批次 B 并做人工调整 ============
function buildRunB(orderIds) {
  const res = S.createRun({
    from: T, to: D(30), algo: 'edd', orderIds,
    carryLocked: true, materialGate: true, companyId: 1,
    operator: 'admin', note: '排程演示：第二版草稿（含人工锁定与调整）'
  });
  db.prepare('UPDATE schedule_runs SET demo_tag = ? WHERE id = ?').run(TAG, res.run_id);

  const tasks = db.prepare('SELECT * FROM schedule_tasks WHERE run_id = ? ORDER BY work_center, start_at').all(res.run_id);
  if (!tasks.length) {
    console.log('[5] 批次 B：无任务，跳过人工调整');
    return res.run_id;
  }

  // 5.1 锁定一个车缝任务（不让重排动它）
  const lockTarget = tasks.find((t) => t.process_name === '车缝') || tasks[0];
  S.adjustTask(lockTarget.id, { locked: 1, reason: '客户指定这批先做，整条线锁定不动' }, 'admin');
  // 5.2 调整一个任务的开工时间（延后一天，写原因）
  const moveTarget = tasks.find((t) => t.process_name === '整烫' && t.order_id !== lockTarget.order_id)
    || tasks.find((t) => t.id !== lockTarget.id);
  if (moveTarget) {
    const newStart = `${S.addDays(String(moveTarget.start_at).slice(0, 10), 1)} ${String(moveTarget.start_at).slice(11, 16)}`;
    const newEnd = `${S.addDays(String(moveTarget.end_at).slice(0, 10), 1)} ${String(moveTarget.end_at).slice(11, 16)}`;
    S.adjustTask(moveTarget.id, { start_at: newStart, end_at: newEnd, reason: '等首件确认放行后再整烫，整体推后一天' }, 'admin');
  }

  const chg = db.prepare('SELECT COUNT(*) c FROM schedule_changes WHERE run_id = ?').get(res.run_id).c;
  console.log(`[5] 批次 B：${res.run_no} 任务 ${res.task_count} 条（草稿），锁定 1 条、调整 1 条，留痕 ${chg} 条`);
  return res.run_id;
}

// ============ main ============
if (RESET) clear();
seedStandards();
seedCalendar();
const created = seedOrders();
const ids = created.map((c) => c.order_id);
buildRunA(ids);
buildRunB(ids);

console.log('\n=== 演示数据就绪 ===');
const cur = db.prepare('SELECT * FROM schedule_runs WHERE is_current = 1').get();
console.log(`当前生效批次：${cur ? cur.run_no : '无'}（利用率 ${cur ? cur.util_rate : 0}%，超期 ${cur ? cur.late_count : 0} 单，满负荷 ${cur ? cur.full_days : 0} 天）`);
const cnt = db.prepare('SELECT type, level, COUNT(*) c FROM schedule_conflicts WHERE run_id = ? GROUP BY type, level').all(cur ? cur.id : 0);
console.log('冲突分布：', cnt.map((x) => `${x.type}(${x.level})×${x.c}`).join('  ') || '无');
