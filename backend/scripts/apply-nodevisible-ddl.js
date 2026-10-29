/**
 * 节点加「看板可见性」—— 检验 / 包装这类只在扫码里走的工序，不占看板列
 *
 * ## 为什么需要这个开关
 *
 * 订单跟踪看板一列一个工序。参考系统（衣创生产订单）是 13 列，而本系统实际有 15 个
 * 节点 —— 多出来的是「检验」「包装」。这两步不能删：
 *
 *   orderFlow.checkProductionReadyForStock  按 code 找 inspect / pack
 *                                            成品入库的两道闸门
 *
 * 删掉它们，任何单都入不了库，而且报错说「生产检验工序尚未完成」时，
 * 界面上根本找不到那个节点 —— 谁也查不出问题在哪。
 *
 * 但这两步的实际发生方式是**车间扫码**，不是跟单在电脑上点。所以：
 * 列不显示，节点照常生成（扫码、报工、入库闸门全靠 order_nodes 里那条记录）。
 *
 * ## 已经踩过的坑：进度不能只算可见列
 *
 * 如果把隐藏节点排除在进度外，13 列全 ✓ 时看板显示 100%，
 * 而入库仍被闸门拦住 —— 数字在撒谎，人只会认为系统坏了。
 *
 * 所以：**列只显示可见的，进度按全部节点算**，并单独返回「还有哪几步要扫码完成」。
 */
const { db } = require('../src/db');

const COLS = db.prepare("PRAGMA table_info('node_template_items')").all().map((c) => c.name);
if (COLS.includes('visible')) {
  console.log('node_template_items.visible 已存在，跳过加列');
} else {
  db.exec("ALTER TABLE node_template_items ADD COLUMN visible INTEGER NOT NULL DEFAULT 1");
  console.log('已加列 node_template_items.visible（1=看板显示，0=仅扫码）');
}

/* 存量默认全部可见 —— 不猜业务想藏哪一步 */
const n = db.prepare(
  "UPDATE node_template_items SET visible = 1 WHERE visible IS NULL OR visible NOT IN (0, 1)"
).run();
if (n.changes) console.log(`修正非法值 ${n.changes} 行`);

/**
 * 检验 / 包装改为「仅扫码」
 *
 * 只改这两个 code，不改名字匹配：业务把它们改名成「质检」「装箱」也照样生效，
 * 因为它们靠 code 认，不靠 name。这正是上一版加 code 的意义。
 */
const want = ['inspect', 'pack'];
const stmt = db.prepare('UPDATE node_template_items SET visible = 0, updated_at = ? WHERE code = ? AND visible <> 0');
const t = new Date().toISOString();
let changed = 0;
want.forEach((code) => {
  const r = stmt.run(t, code);
  changed += r.changes;
  const row = db.prepare('SELECT name, code, visible FROM node_template_items WHERE code = ?').get(code);
  console.log(`  ${code}: ${row ? `${row.name} → visible=${row.visible}` : '该流程里没有这个节点'}`);
});

/* ---------------- 核对 ---------------- */
const all = db.prepare('SELECT code, name, visible, status FROM node_template_items ORDER BY seq, id').all();
const visible = all.filter((x) => Number(x.visible) === 1 && x.status === 'active');
const hidden = all.filter((x) => Number(x.visible) === 0);
console.log(`\n本次改动 ${changed} 行`);
console.log(`看板可见 ${visible.length} 列：${visible.map((x) => x.name).join(' → ')}`);
console.log(`仅在扫码 ${hidden.length} 个：${hidden.map((x) => `${x.name}(${x.code})`).join('、') || '无'}`);

/**
 * 隐藏节点必须在 order_nodes 里真实存在 —— 否则扫码扫不到、入库闸门永远拦。
 * 这里做一次体检，不自动补（补数据是 applyToOrders 的事，要先看影响面）。
 */
const missing = db.prepare(`
  SELECT o.order_no, i.name
    FROM orders o
    JOIN node_template_items i ON i.template_id = o.node_template_id AND i.visible = 0 AND i.status = 'active'
   WHERE o.status IN ('assigned', 'production', 'instock')
     AND NOT EXISTS (SELECT 1 FROM order_nodes n WHERE n.order_id = o.id AND n.code = i.code)
`).all();
if (missing.length) {
  console.warn(`\n⚠ ${missing.length} 处在产订单缺隐藏节点（入库闸门会拦），去「工序流程配置 → 应用到已有订单」补：`);
  missing.slice(0, 10).forEach((m) => console.warn(`   ${m.order_no} 缺「${m.name}」`));
} else {
  console.log('\n✓ 在产订单都已带隐藏节点（扫码与入库闸门能正常找到）');
}
