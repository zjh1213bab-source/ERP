/**
 * M05-06 供方信息协同与技术再次审核 —— 演示数据
 * ============================================================
 * 5 张技术包，覆盖 5 种真实处境：
 *   ① 走完全链 → 可核准 → 已核准（A1 自制 / A2 现有供方 / A3 通过）
 *   ② A3 失效：供方换了 → A2 出 V2 → 原 A3 自动失效，必须重审
 *   ③ 仅样料：找料样料与正式大货采购分开，必须有批准依据，且不能直接采购
 *   ④ 卡在 A1：分工还是草稿（技术部没派活）
 *   ⑤ 复用原版 + 有条件通过（带差异原因）
 */
const { db } = require('../src/db');
const S = require('../src/services/supreview');

const TAG = 'supreview_demo';
const op = 'demo';
const pad = (n) => String(n).padStart(2, '0');
function D(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clean() {
  const tps = db.prepare('SELECT id FROM tech_packs WHERE demo_tag = ?').all(TAG).map((r) => r.id);
  const all = db.prepare(
    'SELECT id FROM tech_packs WHERE demo_tag = ? OR remark LIKE ?'
  ).all(TAG, '%研发协同演示%').map((r) => r.id);
  const ids = Array.from(new Set(tps.concat(all)));
  if (ids.length) {
    const inSql = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM tech_reviews WHERE tech_pack_id IN (${inSql})`).run(...ids);
    db.prepare(`DELETE FROM supplier_confirms WHERE tech_pack_id IN (${inSql})`).run(...ids);
    db.prepare(`DELETE FROM tech_assignments WHERE tech_pack_id IN (${inSql})`).run(...ids);
    db.prepare(`DELETE FROM tech_packs WHERE id IN (${inSql})`).run(...ids);
  }
  // 冒烟测试留下的（挂在它自己建的技术包上）
  const smoke = db.prepare("SELECT id FROM tech_packs WHERE remark LIKE '%冒烟测试%'").all().map((r) => r.id);
  if (smoke.length) {
    const inSql = smoke.map(() => '?').join(',');
    db.prepare(`DELETE FROM tech_reviews WHERE tech_pack_id IN (${inSql})`).run(...smoke);
    db.prepare(`DELETE FROM supplier_confirms WHERE tech_pack_id IN (${inSql})`).run(...smoke);
    db.prepare(`DELETE FROM tech_assignments WHERE tech_pack_id IN (${inSql})`).run(...smoke);
    db.prepare(`DELETE FROM tech_packs WHERE id IN (${inSql})`).run(...smoke);
  }
}

/** 建一张演示技术包（不借用别人的：核准会改 status） */
function mkPack(name, orderId, extra) {
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO tech_packs (order_id, product_name, version, stage, status, pattern_no,
       remark, created_by, created_at, updated_at, demo_tag, category, customer_style_no)
     VALUES (?,?,?,'draft','draft',?,?, 'demo', ?, ?, ?, ?, ?)`
  ).run(
    orderId || null, name, 'V1', (extra && extra.pattern_no) || null,
    '研发协同演示', ts, ts, TAG,
    (extra && extra.category) || '上衣', (extra && extra.style_no) || null
  );
  return info.lastInsertRowid;
}

function run() {
  clean();

  // ---------- ① 走完全链：自制版 + 现有供方 + 复审通过 ----------
  const p1 = mkPack('女式针织开衫 A 款', 1, { pattern_no: 'PT-AW-2601', style_no: 'LEJE-AW-2601' });
  S.saveAssignment(p1, { tech_owner: '技术部·陈工', pattern_scope: 'self', due_date: D(-20), note: '自有版房出首版' }, op);
  S.confirmAssignment(p1, op);

  let d = S.createConfirm(p1, {
    requirement_no: 'MAT-T01', material_name: '精梳棉双面布 280G', spec: '160cm/米', composition: '100% 棉',
    supplier_id: 1, source_type: 'existing', unit_price: 26, lead_days: 12,
    sample_basis: '色卡 CC-2601-A', note: '成熟供方，核对适用性即可，不重新开发'
  }, op);
  const c1 = d.current_confirms[0];
  S.confirmSupplierConfirm(c1.id, op);

  d = S.createConfirm(p1, {
    requirement_no: 'MAT-T02', material_name: 'YKK 尼龙拉链 60cm', spec: '60cm/条', composition: '尼龙',
    supplier_id: 4, source_type: 'existing', unit_price: 3.2, lead_days: 7,
    sample_basis: '样品 ZP-60'
  }, op);
  const c2 = d.current_confirms.find((x) => x.material_name.includes('拉链'));
  S.confirmSupplierConfirm(c2.id, op);

  d = S.createReview(p1, {
    confirm_id: c1.id, conclusion: 'pass', approved_by: '技术总监·周', note: '面料与规格均符合客户要求'
  }, op);
  S.createReview(p1, { confirm_id: c2.id, conclusion: 'pass', approved_by: '技术总监·周' }, op);
  const before = S.packDetail(p1);
  if (before.can_approve) S.approvePack(p1, { approved_by: '技术总监·周' }, op);
  console.log(`[1] ${before.tech_pack.product_name}：A1 自制 → A2 两条供方确认 → A3 通过 → 已核准`);

  // ---------- ② A3 失效：换供方后原核准不能沿用 ----------
  const p2 = mkPack('男士休闲长裤 B 款', 1, { pattern_no: 'PT-PT-9002', style_no: 'KZ-9002-DEF' });
  S.saveAssignment(p2, { tech_owner: '技术部·李', pattern_scope: 'outsource', pattern_vendor_id: 6, pattern_price: 1800, due_date: D(-14) }, op);
  S.confirmAssignment(p2, op);

  d = S.createConfirm(p2, {
    requirement_no: 'MAT-T03', material_name: '全棉斜纹布', spec: '145cm/米', composition: '100% 棉',
    supplier_id: 2, source_type: 'existing', unit_price: 22, lead_days: 15,
    sample_basis: '色卡 CC-9002'
  }, op);
  let c3 = d.current_confirms.find((x) => x.material_name === '全棉斜纹布');
  S.confirmSupplierConfirm(c3.id, op);
  S.createReview(p2, { confirm_id: c3.id, conclusion: 'pass', approved_by: '技术总监·周', note: '正邦布业供货' }, op);
  console.log(`[2a] ${'男士休闲长裤 B 款'}：已核准（依据 正邦布业 V1）`);

  // 换供方 + 改规格 → A2 出 V2 → 原 A3 自动失效
  d = S.createConfirm(p2, {
    requirement_no: 'MAT-T03', material_name: '全棉斜纹布', spec: '150cm/米', composition: '98% 棉 2% 氨纶',
    supplier_id: 3, source_type: 'existing', unit_price: 24.5, lead_days: 18,
    sample_basis: '色卡 CC-9002-B',
    note: '正邦布业交期不稳，改蒙特布料，规格从 145cm 提到 150cm（门幅变了排版要重算）'
  }, op);
  // 采购把新供方的条件也确认掉了，A2 就齐了——但原 A3 的依据已经作废，必须重审
  const c6 = d.current_confirms.find((x) => x.material_name === '全棉斜纹布');
  S.confirmSupplierConfirm(c6.id, op);
  console.log('[2b] 换供方 + 改规格 → A2 出 V2（蒙特布料 150cm）并确认，原 A3 已失效需重审');

  // ---------- ③ 仅样料：找料与正式采购分开 ----------
  const p3 = mkPack('儿童卫衣 C 款 · 新花面料', 3, { pattern_no: 'PT-SW-C01', style_no: 'LEJE-WY-003', category: '上衣' });
  S.saveAssignment(p3, { tech_owner: '技术部·陈工', pattern_scope: 'self', due_date: D(-6) }, op);
  S.confirmAssignment(p3, op);
  d = S.createConfirm(p3, {
    requirement_no: 'MAT-T04', material_name: '32S 精梳棉卫衣布（新花）', spec: '180cm/米', composition: '100% 棉',
    supplier_id: 3, source_type: 'sample_only', unit_price: 31, lead_days: 25,
    sample_basis: '样布 YP-C01（5 米）',
    approval_ref: '销售总监 2026-10-20 批准找料，仅做样衣，不进大货',
    note: '客户要新花型，先找料做样；大货要另走正式确认'
  }, op);
  const c4 = d.current_confirms[0];
  S.confirmSupplierConfirm(c4.id, op);
  console.log(`[3] 儿童卫衣 C 款：仅样料（有批准依据），不能直接大货采购 → 卡在 A3 待审`);

  // ---------- ④ 卡在 A1 ----------
  const p4 = mkPack('男式工装长裤 · 待派活', 5, { style_no: 'LEJE-TZ-002', category: '裤子' });
  S.saveAssignment(p4, { tech_owner: '技术部·李', pattern_scope: 'self', note: '等版房排期' }, op);
  console.log(`[4] 男式工装长裤：A1 分工还是草稿（未确认）→ 卡在 A1`);

  // ---------- ⑤ 复用原版 + 有条件通过 ----------
  const p5 = mkPack('女式针织开衫 A 款（返单）', 1, { pattern_no: 'PT-AW-2601', style_no: 'LEJE-AW-2601' });
  S.saveAssignment(p5, { tech_owner: '技术部·陈工', pattern_scope: 'reuse', reuse_tech_pack_id: p1, note: '沿用原版，不重新制版' }, op);
  S.confirmAssignment(p5, op);
  d = S.createConfirm(p5, {
    requirement_no: 'MAT-T05', material_name: '精梳棉双面布 280G', spec: '160cm/米', composition: '100% 棉',
    supplier_id: 1, source_type: 'existing', unit_price: 27.5, lead_days: 12,
    sample_basis: '色卡 CC-2601-A'
  }, op);
  const c5 = d.current_confirms[0];
  S.confirmSupplierConfirm(c5.id, op);
  S.createReview(p5, {
    confirm_id: c5.id, conclusion: 'conditional', approved_by: '技术总监·周',
    diff_reason: '面料单价由 26 涨到 27.5，需业务确认能否消化，否则要调出厂价'
  }, op);
  console.log(`[5] 返单：复用原版（未重新制版），复审「有条件通过」并写差异原因`);

  // ---------- 自检 ----------
  const b = S.board({});
  console.log('');
  console.log('=== 协同看板自检 ===');
  console.log(`技术包 ${b.stat.packs} 张：A1 待分工 ${b.stat.a1_pending} / A2 待确认 ${b.stat.a2_pending} / A3 待审 ${b.stat.a3_pending} / A3 失效 ${b.stat.a3_stale} / 可核准 ${b.stat.ready}`);
  console.log(`仅样料物料 ${b.stat.sample_only_materials} 项（不能直接大货采购）`);
  console.log(`口径：${b.rule_note}`);
  const d2 = S.packDetail(p2);
  console.log(`失效示例：${d2.tech_pack.product_name} → ${d2.stage_label}`);
  d2.reviews.filter((r) => r.stale === 1).forEach((r) => console.log(`  · ${r.material_name} 的 ${r.review_no}：${r.stale_reason}`));
  console.log('');
  console.log('[seed-supreview-demo] 就绪');
}

if (process.argv.includes('--reset')) {
  clean();
  console.log('[reset] 已清理上轮演示数据');
}
run();
