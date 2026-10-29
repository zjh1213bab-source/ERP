/**
 * 领料单明细挂到「款 × 颜色」
 *
 * ## 现在缺什么
 *
 * v1.54 把物料的**需求**分到了「款 × 颜色」（`order_materials.item_id` +
 * `order_material_colors`），但**发料**还停在原料总量：一张单 306.6 米布，
 * 车间拿到 306.6 米，谁也说不清印花001 用掉几米、印花002 用掉几米。
 *
 * 结果是三件事都做不了：
 *   1. 分色备料 —— 仓库只能整单整料给，不能按色配比切；
 *   2. 分色核销 —— 织厂/印厂按色对账时，系统里没有按色的发出量；
 *   3. 分色退料 —— 印花003 的余料只能退成「32支精梳棉」，退不回颜色。
 *
 * ## 改什么
 *
 *   material_issue_items.item_id   哪一款（0 = 整单/不分款，老数据）
 *   material_issue_items.colorway  哪个色（'' = 不分色，老数据）
 *   material_issue_items.color_no  色号快照（面料的色号是发料时最容易被搞错的信息）
 *
 * ## 为什么把 NULL 换成 0 / ''
 *
 * 唯一索引 `uq_issue_item` 原本是 `(issue_id, material_id, name)`，同一原料第二行
 * 直接撞约束 —— 分色发料必须放开。但 SQLite 的唯一索引里 **NULL 互不相等**：
 * 若新列允许 NULL，同一物料同一个色可以插两行，按色汇总时**翻倍**，
 * 而界面上看着完全正常。所以这两列用 `NOT NULL DEFAULT 0/''`，靠约束真挡。
 *
 * 注意 `material_id` 本身是可空的（没关联档案的行），那一列仍然是 NULL 互不相等，
 * 这一层靠 `createIssue()` 里的重名校验兜（新单据都有关联档案才能备料）。
 */
const { db } = require('../src/db');

const cols = db.prepare("PRAGMA table_info('material_issue_items')").all().map((c) => c.name);

if (!cols.includes('item_id')) {
  db.exec('ALTER TABLE material_issue_items ADD COLUMN item_id INTEGER NOT NULL DEFAULT 0');
  console.log('已加列 material_issue_items.item_id（哪一款，0=不分款）');
} else {
  console.log('material_issue_items.item_id 已存在');
}

if (!cols.includes('colorway')) {
  db.exec("ALTER TABLE material_issue_items ADD COLUMN colorway TEXT NOT NULL DEFAULT ''");
  console.log("已加列 material_issue_items.colorway（哪个色，''=不分色）");
} else {
  console.log('material_issue_items.colorway 已存在');
}

if (!cols.includes('color_no')) {
  db.exec('ALTER TABLE material_issue_items ADD COLUMN color_no TEXT');
  console.log('已加列 material_issue_items.color_no（色号快照）');
} else {
  console.log('material_issue_items.color_no 已存在');
}

/**
 * 唯一索引必须重建：旧索引 (issue_id, material_id, name) 会把
 * 「同一原料两个颜色」判成重复行，分色发料直接建不了单。
 */
const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_issue_item'").get();
const wantCols = ['item_id', 'colorway'];
const idxSql = (idx && idx.sql) || '';
if (!wantCols.every((c) => idxSql.includes(c))) {
  db.exec('DROP INDEX IF EXISTS uq_issue_item');
  db.exec(`CREATE UNIQUE INDEX uq_issue_item
             ON material_issue_items(issue_id, material_id, name, item_id, colorway)`);
  console.log('已重建唯一索引 uq_issue_item（含款与颜色）');
} else {
  console.log('唯一索引 uq_issue_item 已包含款与颜色');
}

/* ---------------- 存量体检 ---------------- */
const total = db.prepare('SELECT COUNT(*) c FROM material_issue_items').get().c;
const odd = db.prepare(`SELECT COUNT(*) c FROM material_issue_items WHERE item_id <> 0 OR colorway <> ''`).get().c;
const dup = db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT issue_id, material_id, name, item_id, colorway, COUNT(*) n
      FROM material_issue_items GROUP BY 1,2,3,4,5 HAVING n > 1
  )`).get().c;
const coloredOrders = db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT m.order_id FROM order_materials m
      JOIN order_material_colors c ON c.order_material_id = m.id
     GROUP BY m.order_id
  )`).get().c;

console.log(`\n存量领料明细 ${total} 条（其中已带款/色 ${odd} 条 —— 老单据都是 0/空，按总量核）`);
console.log(`按色配置过的订单：${coloredOrders} 张（这些单下次备料会自动按颜色出建议行）`);
if (dup) console.warn(`⚠ ${dup} 组明细重复（同单同料同款同色），需要人工合并`);
else console.log('✓ 没有重复明细');
