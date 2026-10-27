/**
 * M05 研发立项 + SKU 配码主档 —— 演示数据
 * ============================================================
 * 覆盖 6 种真实处境：
 *   ① 全新开发跑完全链路（技术核准 → 销售接收 → 下单 → 投产 → 首次上架）
 *   ② 返单复用（用 ① 已验证的版型，不重新制版）
 *   ③ 同款新增花型（需要批准分类，否则不算新开发）
 *   ④ 打样中（版型已出、样衣未出 → 技术核准要被拦）
 *   ⑤ 立项草稿（还没指派负责人）
 *   ⑥ 逾期未上市（计划上市日已过、还没上架）
 * SKU 侧：单件 SKU（两个花型两个尺码）、套装 SKU（上衣+裤子）、箱规、配码版本切换、供应商标名（含 1 个停用）
 */
const { db } = require('../src/db');
const S = require('../src/services/devmaster');

const TAG = 'devmaster_demo';
const op = 'demo';
const pad = (n) => String(n).padStart(2, '0');
function D(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clean() {
  const ids = db.prepare('SELECT id FROM dev_projects WHERE demo_tag = ?').all(TAG).map((r) => r.id);
  const skus = db.prepare('SELECT id FROM sku_masters WHERE demo_tag = ?').all(TAG).map((r) => r.id);
  if (ids.length) {
    const inSql = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM dev_milestones WHERE project_id IN (${inSql})`).run(...ids);
    db.prepare(`DELETE FROM dev_tasks WHERE project_id IN (${inSql})`).run(...ids);
    db.prepare(`DELETE FROM dev_projects WHERE id IN (${inSql})`).run(...ids);
  }
  if (skus.length) {
    const inSql = skus.map(() => '?').join(',');
    // 先解掉主档对配码版本的引用，避免删除顺序问题
    db.prepare(`UPDATE sku_masters SET pack_spec_id = NULL WHERE id IN (${inSql})`).run(...skus);
    const specs = db.prepare(`SELECT id FROM pack_specs WHERE sku_id IN (${inSql}) OR demo_tag = ?`).all(...skus, TAG)
      .map((r) => r.id);
    if (specs.length) {
      const sIn = specs.map(() => '?').join(',');
      db.prepare(`DELETE FROM pack_spec_items WHERE spec_id IN (${sIn})`).run(...specs);
      db.prepare(`DELETE FROM pack_specs WHERE id IN (${sIn})`).run(...specs);
    }
    db.prepare(`DELETE FROM sku_aliases WHERE sku_id IN (${inSql})`).run(...skus);
    db.prepare(`DELETE FROM sku_masters WHERE id IN (${inSql})`).run(...skus);
  }
  // 冒烟测试留下的（按 note / remark 前缀识别）
  db.prepare("DELETE FROM dev_milestones WHERE project_id IN (SELECT id FROM dev_projects WHERE note LIKE '%冒烟测试%')").run();
  db.prepare("DELETE FROM dev_tasks WHERE project_id IN (SELECT id FROM dev_projects WHERE note LIKE '%冒烟测试%')").run();
  db.prepare("DELETE FROM dev_projects WHERE note LIKE '%冒烟测试%'").run();
  // SKU / 配码 / 别名同理（冒烟测试会建一批，不带 demo_tag）
  db.prepare("DELETE FROM sku_aliases WHERE sku_id IN (SELECT id FROM sku_masters WHERE remark LIKE '%冒烟测试%')").run();
  db.prepare("DELETE FROM pack_spec_items WHERE spec_id IN (SELECT id FROM pack_specs WHERE note LIKE '%冒烟测试%')").run();
  db.prepare("DELETE FROM pack_specs WHERE note LIKE '%冒烟测试%'").run();
  db.prepare("DELETE FROM sku_masters WHERE remark LIKE '%冒烟测试%'").run();
}

/** 建项目并按顺序打完里程碑 */
function mintProject(body, steps) {
  const created = S.createProject({ ...body, note: body.note }, op);
  db.prepare('UPDATE dev_projects SET demo_tag = ? WHERE id = ?').run(TAG, created.id);
  const p = { id: created.id };
  if (body.owner && ['tech', 'sample'].includes(steps.stopAfter)) S.advanceStage(p.id, { stage: 'tech' });
  // 制版任务（可选）
  if (steps.pattern) {
    const t = S.addTask(p.id, { kind: 'pattern', title: '首版制版', owner: body.pattern_maker, due_date: D(-20) }, op);
    S.setTaskStatus(t.id, { status: 'done', output: steps.pattern });
    if (steps.stopAfter === 'sample') S.advanceStage(p.id, { stage: 'sample' });
  }
  if (steps.sampleNo) S.updateProject(p.id, { sample_no: steps.sampleNo });
  if (steps.ms) {
    steps.ms.forEach((m) => S.addMilestone(p.id, m, op));
  }
  return db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(p.id);
}

function run() {
  clean();

  // ---------- ① 全新开发：跑完整链路（现货，自主开发）----------
  const a = mintProject({
    style_no: 'DV-K101', style_name: '儿童摇粒绒外套 A 版', category: '外套', season: '26AW',
    biz_type: 'spot', source: 'new', dev_type: 'self',
    owner: '技术部·陈工', sales_owner: '销售部·林', pattern_maker: '版房·王',
    target_qty: 1200, target_price: 78, plan_launch_date: D(-6), note: '秋季主推款'
  }, {
    pattern: 'PT-DV-K101-V1',
    sampleNo: 'SY-DV-K101-01',
    ms: [
      { kind: 'tech_approved', occurred_on: D(-26), note: '样衣 01 版核准' },
      { kind: 'sales_accepted', occurred_on: D(-24), note: '销售接收并录入客户意向' },
      { kind: 'order_placed', occurred_on: D(-18), qty: 1200, ref_no: 'ORD-DV-001', note: '首单 1200 件' },
      { kind: 'in_production', occurred_on: D(-12), qty: 1200, ref_no: 'WO-DV-001' },
      { kind: 'us_launched', occurred_on: D(-2), qty: 1180, ref_no: 'US-IN-001', note: '首次美仓上架 1180 件（短 20 件在途）' }
    ]
  });
  console.log(`[1] 全新开发 ${a.project_no}（${a.style_no}）→ 已首次上架，版型可复用`);

  // ---------- ② 返单复用：用 ① 的版型，不重新制版 ----------
  // 注意：返单**仍要技术核准**——核准的内容不是「重新制版」，而是「原版仍适用」；
  // 也**仍要销售接收**——本单的款/花码/数量/版本/交付条件要销售确认。少一步就不许下单。
  const b = mintProject({
    style_no: 'DV-K101', style_name: '儿童摇粒绒外套 A 版（返单）', category: '外套', season: '26AW',
    biz_type: 'spot', source: 'repeat', reuse_project_id: a.id,
    owner: '技术部·陈工', sales_owner: '销售部·林',
    target_qty: 2000, target_price: 78, plan_launch_date: D(20), note: '客户追单'
  }, {
    sampleNo: 'SY-DV-K101-01',
    ms: [
      { kind: 'tech_approved', occurred_on: D(-5), note: '原版适用性核对通过，沿用 PT-DV-K101-V1，不重新制版' },
      { kind: 'sales_accepted', occurred_on: D(-3), note: '销售确认本次花码/数量/交付条件' },
      { kind: 'order_placed', occurred_on: D(-1), qty: 2000, ref_no: 'ORD-DV-002', note: '返单 2000 件' }
    ]
  });
  console.log(`[2] 返单复用 ${b.project_no} → 沿用原版型，技术核对 + 销售确认后下单 2000 件`);

  // ---------- ③ 同款新增花型（有批准分类）----------
  const c = mintProject({
    style_no: 'DV-K101', style_name: '儿童摇粒绒外套 · 星星印花', category: '外套', season: '26AW',
    biz_type: 'spot', source: 'new_pattern', classify_approved_by: '技术总监·周',
    owner: '技术部·陈工', sales_owner: '销售部·林', pattern_maker: '版房·王',
    target_qty: 600, target_price: 82, plan_launch_date: D(28), note: '同款换花型，版型沿用、印花新开'
  }, {
    pattern: 'PT-DV-K101-V2',
    sampleNo: 'SY-DV-K101-02',
    ms: [{ kind: 'tech_approved', occurred_on: D(-4), note: '印花打样核准' }]
  });
  console.log(`[3] 同款新增花型 ${c.project_no} → 已技术核准（算新开发，有批准人）`);

  // ---------- ④ 打样中：版型已出、样衣未出 ----------
  const d = mintProject({
    style_no: 'DV-P201', style_name: '女式针织开衫 C 版', category: '上衣', season: '26AW',
    biz_type: 'custom', customer_id: 1, source: 'new', dev_type: 'customer_sample',
    owner: '技术部·李', sales_owner: '销售部·吴', pattern_maker: '版房·赵',
    target_qty: 800, target_price: 96, plan_launch_date: D(35), note: '客户来样开发'
  }, { pattern: 'PT-DV-P201-V1', stopAfter: 'sample' });
  // 样衣任务被面料卡住
  const dt = S.addTask(d.id, { kind: 'sample', title: '头样车缝', owner: '样衣组·孙', due_date: D(5) }, op);
  S.setTaskStatus(dt.id, { status: 'blocked', blocked_reason: '32S 精梳棉纱未到货，样布只够做半件' });
  console.log(`[4] 打样中 ${d.project_no} → 版型已出，样衣任务阻塞（面料未到）`);

  // ---------- ⑤ 立项草稿：还没指派负责人 ----------
  const e0 = S.createProject({
    style_no: 'DV-S301', style_name: '亲子装卫衣（待评估）', category: '上衣', season: '27SS',
    biz_type: 'spot', source: 'new', target_qty: 0, note: '立项草稿，等季度评审会'
  }, op);
  db.prepare('UPDATE dev_projects SET demo_tag = ? WHERE id = ?').run(TAG, e0.id);
  const e = e0;
  console.log(`[5] 立项草稿 ${e.project_no} → 无负责人、无计划量`);

  // ---------- ⑥ 逾期未上市 ----------
  const f = mintProject({
    style_no: 'DV-T401', style_name: '男式工装长裤', category: '裤子', season: '26AW',
    biz_type: 'spot', source: 'new', owner: '技术部·李', pattern_maker: '版房·赵',
    target_qty: 900, target_price: 88, plan_launch_date: D(-15), note: '计划上市日已过，卡在核价'
  }, {
    pattern: 'PT-DV-T401-V1',
    sampleNo: 'SY-DV-T401-01',
    ms: [
      { kind: 'tech_approved', occurred_on: D(-30), note: '样衣核准' },
      { kind: 'sales_accepted', occurred_on: D(-28), note: '销售接收' }
    ]
  });
  const ft = S.addTask(f.id, { kind: 'costing', title: '工价核价', owner: '技术部·李', due_date: D(-10) }, op);
  S.setTaskStatus(ft.id, { status: 'blocked', blocked_reason: '外协工价未回，核价单缺一道车缝报价' });
  console.log(`[6] 逾期未上市 ${f.project_no} → 计划上市日 ${f.plan_launch_date} 已过，核价阻塞`);

  // ================= SKU 主档 =================
  // 单件：两个花型 × 两个尺码
  const singles = [];
  [['花A', 'A'], ['花B', 'B']].forEach(([pt, code]) => {
    ['3T', '4T'].forEach((sz) => {
      const r = S.createSku({
        sku: `DV-K101-${code}-${sz}`, style_no: 'DV-K101', style_name: '儿童摇粒绒外套',
        pattern: pt, color: '藏青', size: sz, kind: 'single', unit: '件',
        barcode: `6901234${code === 'A' ? '1' : '2'}${sz === '3T' ? '1' : '2'}000`,
        remark: TAG
      }, op);
      db.prepare('UPDATE sku_masters SET demo_tag = ? WHERE id = ?').run(TAG, r.id);
      singles.push(r);
    });
  });
  console.log(`[7] 单件 SKU ${singles.length} 个（2 花型 × 2 尺码，单花单码唯一）`);

  // 套装：上衣 + 裤子
  const pants = S.createSku({
    sku: 'DV-P301-PANTS-3T', style_no: 'DV-P301', style_name: '套装下装',
    pattern: '花A', color: '藏青', size: '3T', kind: 'single', unit: '件', remark: TAG
  }, op);
  db.prepare('UPDATE sku_masters SET demo_tag = ? WHERE id = ?').run(TAG, pants.id);
  const setSku = S.createSku({
    sku: 'DV-SET001', style_no: 'DV-SET001', style_name: '亲子套装（上衣+裤子）',
    pattern: '花A', color: '藏青', size: '3T', kind: 'set', unit: '套', remark: TAG
  }, op);
  db.prepare('UPDATE sku_masters SET demo_tag = ? WHERE id = ?').run(TAG, setSku.id);

  // 套装配码 V1（草稿）→ V2（生效）
  const setV1 = S.createPackSpec({
    sku_id: setSku.id, kind: 'set', pack_no: 'SET-DV-SET001-V1',
    items: [
      { component_sku_id: singles[0].id, qty: 1 },
      { component_sku_id: pants.id, qty: 1 }
    ], note: '初版：上衣 1 + 裤 1'
  }, op);
  // V1 会被标为 demo，需要单独回填
  db.prepare('UPDATE pack_specs SET demo_tag = ? WHERE id = ?').run(TAG, setV1.id);
  S.activatePackSpec(setV1.id, {});
  const setV2 = S.createPackSpec({
    sku_id: setSku.id, kind: 'set', pack_no: 'SET-DV-SET001-V2',
    items: [
      { component_sku_id: singles[0].id, qty: 1 },
      { component_sku_id: pants.id, qty: 1 },
      { component_sku_id: singles[1].id, qty: 1 }
    ], note: '新版：加一件 4T 上衣（客户要求一大一小）'
  }, op);
  db.prepare('UPDATE pack_specs SET demo_tag = ? WHERE id = ?').run(TAG, setV2.id);
  S.activatePackSpec(setV2.id, {});
  console.log(`[8] 套装 ${setSku.sku} 配码 V1(2 件) → V2(3 件)，V1 已 superseded`);

  // 箱规：单件 SKU 一箱 20 件（3T×8 + 4T×12）
  const carton = S.createPackSpec({
    sku_id: singles[0].id, kind: 'carton', pack_no: 'PK-DV-K101-A-V1',
    items: [{ size: '3T', qty: 8 }, { size: '4T', qty: 12 }], note: '标准外箱 20 件'
  }, op);
  db.prepare('UPDATE pack_specs SET demo_tag = ? WHERE id = ?').run(TAG, carton.id);
  S.activatePackSpec(carton.id, {});
  console.log(`[9] 箱规 ${carton.pack_no}：3T×8 + 4T×12 = 20 件`);

  // 别名：供应商叫法（1 个停用）
  S.addAlias(singles[0].id, { alias: 'K101-A-3T', source: 'supplier', note: '供应商简称' }, op);
  const oldAlias = S.addAlias(singles[0].id, { alias: 'K101/A/90', source: 'system', note: '旧系统编码' }, op);
  const oldOne = oldAlias.aliases.find((x) => x.alias === 'K101/A/90');
  if (oldOne) S.disableAlias(oldOne.id, { note: '新旧系统切换，改用新编码' });
  S.addAlias(pants.id, { alias: 'P301-PT-3T', source: 'supplier' }, op);
  // 套装也要有别名：客户下单时用的是套装货号，不是内部组件编码
  S.addAlias(setSku.id, { alias: 'SET-K101-3T', source: 'customer', note: '客户下单用套装货号' }, op);
  console.log('[10] 别名 4 条（其中 1 条已停用，历史单据仍可反查）');

  // ================= 自检 =================
  const bd = S.board({});
  console.log('');
  console.log('=== 研发总览自检 ===');
  console.log(`本月新立项 ${bd.stat.month_new}，在研 ${bd.stat.active}，开发完成（技术核准）${bd.stat.dev_completed} 款`);
  console.log(`销售接收 ${bd.stat.sales_accepted} / 已下单 ${bd.stat.ordered_projects} 款共 ${bd.stat.ordered_qty} 件 / 首次上架 ${bd.stat.launched_projects} 款共 ${bd.stat.launched_qty} 件`);
  console.log(`逾期未上市 ${bd.stat.overdue_launch} 款；SKU ${bd.stat.sku_total} 个`);
  console.log(`口径：${bd.counting_note}`);
  console.log(`计划：${bd.plan_note}`);
  const ex = S.explode(setSku.id, 10);
  console.log(`套装换算：10 套 = ${ex.pieces} 件（1 套 ${ex.pieces_per_set} 件）`);
  console.log('');
  console.log('[seed-devmaster-demo] 就绪');
}

if (process.argv.includes('--reset')) {
  clean();
  console.log('[reset] 已清理上轮演示数据');
}
run();
