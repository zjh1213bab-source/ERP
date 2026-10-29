/**
 * 工序流程可自定义 —— 建表与加列
 *
 * ## 为什么这件事比「加个配置页」难
 *
 * 现在 `order_nodes.name` 是自由文本，而系统里有 6 处靠**名字字符串**联动：
 *
 *   cuts.js          `name LIKE '%裁剪%'`       裁床单完成 → 标记裁剪节点完成
 *   firstArticles.js `name LIKE '%车缝%'`       首件确认 → 回写车缝节点
 *   process_standards.process_name               工序定额
 *   skill_requirements.process_name              技能要求
 *   schedule_tasks.process_name                  排产任务
 *   production_reports.node_name                 报工记录
 *
 * 只要业务把「裁剪」改成「裁床」，第一条就静默失效 —— 界面上看不出任何异常，
 * 只是裁床单做完了、节点还是「待开始」。
 *
 * 所以「可自定义」的前提不是配置界面，而是**先给节点一个不会变的身份**：
 * `code` 是身份（`cut` / `sew`），`name` 只是标签。改名随便改，`code` 永不变。
 * 这也是为什么本脚本要回填存量数据 —— 不回填的话，老订单没有 code，
 * 联动只能退回按名字猜，等于没改。
 *
 * ## 三张表 / 两处加列
 *
 *   node_templates       流程模板（梭织标准 / 现货快反 / 客户自定义…）
 *   node_template_items  模板里的节点（code、name、seq、必经与否、颜色）
 *   order_nodes          加 code / template_id / is_custom / skip_reason
 *   orders               加 node_template_id（下单时选流程；老单为空 = 用默认模板）
 *
 * ## 为什么模板要有「多个」而不是全局一套
 *
 * 定制单要走打样和工艺单，现货快反单直接从备料开始；外协单没有「尾部」。
 * 一套全局节点必然被做成「所有流程的并集」，于是每张单都挂着一堆用不到的空节点，
 * 看板上全是「待开始」，没人能看出这单到底卡在哪。
 */
const { db } = require('../src/db');

/* ---------------- 1. 模板表 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS node_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,        -- 1=新订单默认用它（全局只能有一个）
  status TEXT NOT NULL DEFAULT 'active',        -- active / archived（归档不给新单用，但在用的单还在用）
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_template_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  code TEXT NOT NULL,                           -- **稳定身份**，入库后不可改（改了历史记录就失联）
  name TEXT NOT NULL,                           -- 显示名，随便改
  seq INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1,          -- 1=必经（不能跳过）0=可选（用不上可标「不适用」）
  role TEXT,                                    -- 谁负责推进：production / warehouse / qc / outsource
  color TEXT,                                   -- 看板节点色（空=按状态自动上色）
  builtin INTEGER NOT NULL DEFAULT 0,           -- 1=系统内置（有联动逻辑挂在 code 上）
  status TEXT NOT NULL DEFAULT 'active',        -- active / off（停用：新单不再带，老单记录不删）
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nti_tpl ON node_template_items(template_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nti_code ON node_template_items(template_id, code);
`);

/* ---------------- 2. order_nodes 加列 ---------------- */
const nodeCols = db.prepare('PRAGMA table_info(order_nodes)').all().map((c) => c.name);
const addNodeCol = (name, ddl) => {
  if (nodeCols.includes(name)) return false;
  db.exec(`ALTER TABLE order_nodes ADD COLUMN ${ddl}`);
  return true;
};
const n1 = addNodeCol('code', 'code TEXT');
const n2 = addNodeCol('template_id', 'template_id INTEGER');
const n3 = addNodeCol('is_custom', 'is_custom INTEGER NOT NULL DEFAULT 0');
const n4 = addNodeCol('skip_reason', 'skip_reason TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_code ON order_nodes(order_id, code)');

/* ---------------- 3. orders 加列（下单选流程） ---------------- */
const ordCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
const n5 = ordCols.includes('node_template_id') ? false : (db.exec('ALTER TABLE orders ADD COLUMN node_template_id INTEGER'), true);

/* ---------------- 4. 内置 13 道工序的 code 映射 ---------------- */
/**
 * 内置节点：code 写死在这里，因为系统里有逻辑挂在它们身上
 * （裁床单完成→`cut`、首件确认→`sew`）。
 *
 * 顺序与 `services/production.js` 原来的 `DEFAULT_NODES` 一致，
 * 这样回填存量数据时 seq 不会跳。
 */
const BUILTIN = [
  ['prep', '备料'],
  ['layout', '排版算料'],
  ['cut', '裁剪'],
  ['sew', '车缝'],
  ['buttonhole', '锁眼钉扣'],
  ['iron', '整烫'],
  ['wash', '水洗'],
  ['print', '印花'],
  ['embroider', '绣花'],
  ['inspect', '检验'],
  ['pack', '包装'],
  ['instock', '成品入库'],
  ['ship', '出库发运']
];

const t = new Date().toISOString();

/* ---------------- 5. 建默认模板 ---------------- */
let tpl = db.prepare("SELECT id FROM node_templates WHERE is_default = 1 AND status = 'active' LIMIT 1").get();
if (!tpl) {
  const info = db.prepare(
    `INSERT INTO node_templates (name, is_default, status, note, created_by, created_at, updated_at)
     VALUES (?, 1, 'active', ?, 'system', ?, ?)`
  ).run('本厂标准工序', '系统内置的 13 道工序，与原流程一致。可按实际生产改名字、调顺序、停用用不到的节点。', t, t);
  tpl = { id: Number(info.lastInsertRowid) };
  console.log(`已建默认模板 #${tpl.id} 本厂标准工序`);
}

const itemCount = Number(db.prepare('SELECT COUNT(*) c FROM node_template_items WHERE template_id = ?').get(tpl.id).c);
if (itemCount === 0) {
  const ins = db.prepare(
    `INSERT INTO node_template_items
      (template_id, code, name, seq, required, role, builtin, status, created_at, updated_at)
     VALUES (?,?,?,?,1,?,1,'active',?,?)`
  );
  BUILTIN.forEach(([code, name], i) => ins.run(tpl.id, code, name, i + 1, 'production', t, t));
  console.log(`已写入默认模板的 ${BUILTIN.length} 个节点`);
} else {
  console.log(`默认模板已有 ${itemCount} 个节点，跳过写入`);
}

/* ---------------- 6. 回填存量 order_nodes.code ---------------- */
/**
 * 按名字精确匹配回填。**匹配不到的不留空**：
 * 空 code 会在后续联动里一直走「按名字猜」的退路，等于自定义永远修不好。
 * 所以给未识别的节点生成 `x_<id>` 这样的稳定 code —— 它没有联动逻辑，
 * 但至少是一个不会变的身份，改名之后还能认得出来是同一个节点。
 */
const nameToCode = new Map(BUILTIN.map(([code, name]) => [name, code]));
const orphans = db.prepare(
  "SELECT id, name FROM order_nodes WHERE code IS NULL OR code = ''"
).all();
let filled = 0;
let generated = 0;
const upd = db.prepare('UPDATE order_nodes SET code = ?, template_id = COALESCE(template_id, ?) WHERE id = ?');
orphans.forEach((r) => {
  const hit = nameToCode.get(String(r.name).trim());
  const code = hit || `x_${r.id}`;
  if (hit) filled += 1; else generated += 1;
  upd.run(code, tpl.id, r.id);
});
console.log(`回填 order_nodes.code：识别内置 ${filled} 条 / 生成自定义 ${generated} 条（共 ${orphans.length} 条待回填）`);

/* ---------------- 7. 存量订单挂到默认模板 ---------------- */
const noTpl = db.prepare('SELECT COUNT(*) c FROM orders WHERE node_template_id IS NULL').get().c;
if (Number(noTpl) > 0) {
  db.prepare('UPDATE orders SET node_template_id = ? WHERE node_template_id IS NULL').run(tpl.id);
}
console.log(`存量订单 ${noTpl} 张已挂到默认模板 #${tpl.id}`);

console.log('\n工序流程可自定义：2 张表 + 2 处加列已就绪');
console.log(`  node_templates       流程模板（默认 #${tpl.id} 本厂标准工序）`);
console.log('  node_template_items  模板节点（code 稳定身份 + name 可改）');
console.log(`  order_nodes          ${n1 ? '新增 code' : 'code 已存在'} / ${n2 ? '新增 template_id' : 'template_id 已存在'} / ${n3 ? '新增 is_custom' : 'is_custom 已存在'} / ${n4 ? '新增 skip_reason' : 'skip_reason 已存在'}`);
console.log(`  orders               ${n5 ? '新增 node_template_id' : 'node_template_id 已存在'}`);
