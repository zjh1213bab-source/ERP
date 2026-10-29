/**
 * 物料挂到「款 × 颜色」
 *
 * ## 现在缺什么
 *
 * 订单已经支持多款（`order_items`）和多色（`order_item_sizes`），但物料是挂在
 * **订单**上的（`order_materials` 只有 `order_id` + 一个自由文本 `mat_color`）。
 * 于是「这个款的花色布用哪个色号」只能写在备注里，谁也查不出来。
 *
 * 真实业务是这样：一张单三个款，每个款九个印花色，同一块底布在不同印花色上
 * 色号不同（甚至料都不同）。物料行必须能指到「哪个款的哪个颜色」。
 *
 * ## 三处改动
 *
 *   order_materials.item_id     哪个款（NULL = 订单通用，老数据就是这样）
 *   order_materials.all_colors  1 = 该款所有颜色通用（不展开子表）
 *   order_material_colors       一行一色：款色、色号、该色单件用量
 *
 * ## 为什么不直接把颜色塞进 `mat_color` 文本
 *
 * 因为要按颜色发料：领料单要知道「印花003 的这件用 32 支还是 40 支」。
 * 文本只能看，不能查、不能汇总，也不能拦住「填了一个这个款根本没有的颜色」。
 *
 * ## UNIQUE(order_material_id, colorway) 是必须的
 *
 * 同一物料同一颜色如果允许两行，按色汇总用量时会**翻倍**，
 * 而界面上看着完全正常 —— 这种错只能靠约束挡。
 */
const { db } = require('../src/db');

const cols = db.prepare("PRAGMA table_info('order_materials')").all().map((c) => c.name);

if (!cols.includes('item_id')) {
  db.exec('ALTER TABLE order_materials ADD COLUMN item_id INTEGER');
  console.log('已加列 order_materials.item_id（哪个款）');
} else {
  console.log('order_materials.item_id 已存在');
}

if (!cols.includes('all_colors')) {
  db.exec('ALTER TABLE order_materials ADD COLUMN all_colors INTEGER NOT NULL DEFAULT 0');
  console.log('已加列 order_materials.all_colors（1=该款所有颜色通用）');
} else {
  console.log('order_materials.all_colors 已存在');
}

db.exec(`
CREATE TABLE IF NOT EXISTS order_material_colors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_material_id INTEGER NOT NULL,
  colorway TEXT NOT NULL,                     -- 款色（与 order_item_sizes.color 同名）
  color_no TEXT,                              -- 这个颜色用这个料的色号
  qty REAL,                                   -- 这个颜色的单件用量（空 = 沿用物料行）
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (order_material_id, colorway)
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_omc_mat ON order_material_colors(order_material_id)');
console.log('已建表 order_material_colors');

/* ---------------- 存量体检 ---------------- */
const total = db.prepare('SELECT COUNT(*) c FROM order_materials').get().c;
const orphan = db.prepare(`
  SELECT COUNT(*) c FROM order_materials m
   WHERE m.item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = m.item_id AND i.order_id = m.order_id)
`).get().c;

console.log(`\n存量物料行 ${total} 条（item_id 为空 = 订单通用，界面显示「未指定款」）`);
if (orphan) console.warn(`⚠ ${orphan} 条物料的 item_id 指向不属于该订单的款，需要人工清理`);
else console.log('✓ 没有跨订单挂错的物料');

const multi = db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT order_id FROM order_items GROUP BY order_id HAVING COUNT(*) > 1
  )`).get().c;
console.log(`多款订单：${multi} 张（这些单的物料必须指明是哪个款，否则算料会摊错）`);
