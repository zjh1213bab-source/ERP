/**
 * 节点弹窗类型（panel）+ 节点操作记录表
 *
 * ## 为什么「点开显示什么」要存在节点上，而不是按 code 判断
 *
 * 参考系统里点「面辅料采购」弹的是采购明细表，点「排版算料」只有备注和凭证。
 * 这差别不是按节点身份写死的（code 只能说明它是哪个节点），而是**这类节点的
 * 业务语义不同**：采购类节点背后有一张物料需求表可以摊开，其他节点没有。
 *
 * 而且「面料采购」「辅料采购」在本系统里是业务后来加的**自定义节点**（code 是 `c_7`
 * 这种自动编号，不代表业务含义）。所以必须把「弹窗类型」做成节点自己的属性：
 * 业务新增一个「里布采购」节点时，可以在配置页把它也选成采购面板。
 *
 * ## 为什么操作记录要单独建表
 *
 * 参考系统的节点弹窗底下有时间线：谁、什么时候、把状态从什么改成了什么、备注写了什么。
 * 本系统的 `order_nodes` 只有最终值，没有变更过程 —— 看板上「已完成」是谁点的、
 * 什么时候点的、有没有写过说明，都查不到。
 *
 * 现有能当记录用的只有：报工记录（production_reports.node_id）、
 * 现场照片（attachments.node_id）。节点本身的变更没人记，所以补这张表。
 */
const { db } = require('../src/db');

/* ---------------- 1. 节点加 panel ---------------- */
const cols = db.prepare("PRAGMA table_info('node_template_items')").all().map((c) => c.name);
if (cols.includes('panel')) {
  console.log('node_template_items.panel 已存在，跳过加列');
} else {
  db.exec("ALTER TABLE node_template_items ADD COLUMN panel TEXT NOT NULL DEFAULT 'generic'");
  console.log('已加列 node_template_items.panel（默认 generic）');
}

/* ---------------- 2. 节点操作记录 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS order_node_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  action TEXT NOT NULL,                       -- status / plan / operator / remark / skip / photo / bind
  detail TEXT,                                -- 人话描述：完成了什么、从什么改到什么
  operator TEXT,
  created_at TEXT NOT NULL
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_onl_node ON order_node_logs(node_id, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_onl_order ON order_node_logs(order_id, id)');
console.log('已建表 order_node_logs');

/* ---------------- 3. 把「面辅料采购」设成采购面板 ---------------- */
/**
 * 只在这一步按名字认一次：存量数据里这两个节点是业务加的自定义节点（code 是 c_N），
 * 没有稳定的 code 可用。认完之后类型存在 `panel` 里，以后改名、重排序都不会再影响。
 */
const PANEL_BY_NAME = [
  ['面料采购', 'purchase_fabric'],
  ['辅料采购', 'purchase_accessory']
];
const t = new Date().toISOString();
PANEL_BY_NAME.forEach(([name, panel]) => {
  const r = db.prepare('UPDATE node_template_items SET panel = ?, updated_at = ? WHERE name = ? AND panel <> ?')
    .run(panel, t, name, panel);
  console.log(`  ${name} → ${panel}${r.changes ? `（${r.changes} 行）` : '（无变化）'}`);
});

/* ---------------- 核对 ---------------- */
const rows = db.prepare(
  "SELECT code, name, panel, visible, status FROM node_template_items WHERE status = 'active' ORDER BY seq, id"
).all();
console.log('\n当前节点面板：');
rows.forEach((r) => console.log(`  ${String(r.name).padEnd(10)} ${r.code.padEnd(8)} panel=${r.panel}${Number(r.visible) === 0 ? ' [仅扫码]' : ''}`));

const purchase = rows.filter((r) => r.panel.startsWith('purchase_'));
console.log(`\n采购类节点 ${purchase.length} 个：${purchase.map((x) => x.name).join('、') || '无'}`);
if (!purchase.length) {
  console.warn('⚠ 没找到采购类节点 —— 业务可能把「面料采购」改名了，请到「工序流程配置」里手动把它的弹窗类型设为「面料采购明细」');
}
