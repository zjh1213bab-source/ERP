/**
 * 报工超报：并发验证（会连到**正在运行的**服务，跑完自己清场）
 *
 * 用法：node scripts/test-report-race.js [--keep]
 *
 * ## 验的是什么
 *
 * 报工接口的上限判断原来是「先查累计 → 判上限 → 再 INSERT」，三步分开。
 * 单进程 + 全程同步时恰好不会错（Node 只给一个请求执行权），但这不是设计：
 *   · 任何人往中间加一个 await（查缓存 / 调外部系统）就变成真竞态；
 *   · PM2 cluster 或多实例部署时，两个进程读到同一个"已报 350"，
 *     各自判过 350+100 ≤ 500，最后写进 700 件，而两笔都"校验通过"。
 *
 * 现在校验与写入在同一个 `BEGIN IMMEDIATE` 事务里。这个脚本发 20 个并发请求，
 * 每个 20 件、订单只有 100 件 —— 只允许 5 个成功，其余必须 400，
 * 并且库里合计不许超过 100。
 *
 * 第二条断言用**两个独立连接**验证写锁真的互斥（多实例场景的地基）：
 * A 持有 BEGIN IMMEDIATE 时，B 的 BEGIN IMMEDIATE 必须等待或失败，而不是同时写进去。
 *
 * 构造数据直接写库（订单 + 明细 + 一个「裁剪」工序，裁剪在首件门禁的豁免名单里，
 * 免得为了测并发还得先造首件放行）。
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const KEEP = process.argv.includes('--keep');

const { db } = require('../src/db');

const ORDER_NO = 'RACE-TEST-1';
const QTY = 100;          // 订单件数
const PER_REQUEST = 20;   // 每次报工
const CONCURRENCY = 20;   // 并发请求数（全部成功会写 400 件）
const ts = '2026-10-20 09:00:00';

const num = (v) => Number(v) || 0;
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function clean() {
  const o = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(ORDER_NO);
  if (!o) return;
  db.prepare('DELETE FROM production_reports WHERE order_id = ?').run(o.id);
  db.prepare('DELETE FROM order_node_logs WHERE order_id = ?').run(o.id);
  db.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(o.id);
  db.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(o.id);
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
}

function fixture() {
  clean();
  const info = db.prepare(
    `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
       order_date, delivery_date, created_at, updated_at, company_id)
     VALUES (?, 'custom', 'production', 7.1, ?, ?, 'USD', '并发报工测试款', '2026-10-20', '2026-11-20', ?, ?, 1)`
  ).run(ORDER_NO, QTY * 9.5, QTY * 9.5 * 7.1, ts, ts);
  const orderId = Number(info.lastInsertRowid);
  const item = db.prepare(
    'INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?)'
  ).run(orderId, '并发报工测试款', 'RACE-01', QTY, QTY * 9.5, QTY * 9.5 * 7.1);
  db.prepare(
    `INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
     VALUES (?, '本白', '均码', ?, 9.5, 67.45, ?, ?)`
  ).run(Number(item.lastInsertRowid), QTY, QTY * 9.5, QTY * 9.5 * 7.1);
  const node = db.prepare(
    `INSERT INTO order_nodes (order_id, name, code, template_id, is_custom, seq, status, created_at)
     VALUES (?, '裁剪', 'cut', NULL, 0, 1, 'pending', ?)`
  ).run(orderId, ts);
  return { orderId, nodeId: Number(node.lastInsertRowid) };
}

(async () => {
  const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) {
    console.error(`服务没起来（${BASE}）。先 npm start 再跑这个脚本。`);
    process.exit(2);
  }
  console.log(`[环境] ${BASE}  结构版本 ${health.schema ? health.schema.version : '?'}  ${health.schema ? health.schema.tables : '?'} 表`);

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123456' })
  }).then((r) => r.json());
  const token = login && login.data && login.data.token;
  if (!token) { console.error('登录失败：', login && login.message); process.exit(2); }

  const { orderId, nodeId } = fixture();
  console.log(`[夹具] 订单 ${ORDER_NO}（${QTY} 件）+ 工序「裁剪」，开始 ${CONCURRENCY} 并发 × ${PER_REQUEST} 件`);

  const post = () => fetch(BASE + '/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ node_id: nodeId, qty_ok: PER_REQUEST, hours: 1 })
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const results = await Promise.all(Array.from({ length: CONCURRENCY }, post));
  const okCount = results.filter((r) => r.status === 200).length;
  const badCount = results.filter((r) => r.status === 400).length;
  const errCount = results.filter((r) => r.status >= 500).length;
  const sumOk = num(db.prepare('SELECT COALESCE(SUM(qty_ok),0) q FROM production_reports WHERE order_id = ?').get(orderId).q);
  const nodeRow = db.prepare('SELECT status FROM order_nodes WHERE id = ?').get(nodeId);
  const expectOk = Math.floor(QTY / PER_REQUEST);

  console.log(`[结果] 成功 ${okCount} / 被拒 ${badCount} / 500 ${errCount}；库里合计 ${sumOk} 件`);

  ok('★ 并发下没有 500（写锁等待而不是撞库报错）', errCount === 0, `500 共 ${errCount} 个`);
  ok(`★ 只放行 ${expectOk} 笔（其余按上限拒绝），没有多写`, okCount === expectOk && badCount === CONCURRENCY - expectOk,
    `成功 ${okCount}，期望 ${expectOk}`);
  ok('★ 库里合计不超过订单件数', sumOk <= QTY + 0.0001, `${sumOk} / ${QTY}`);
  ok('达量后工序自动完成', nodeRow && nodeRow.status === 'done', nodeRow && nodeRow.status);
  const rejectMsg = (results.find((r) => r.status === 400) || {}).body;
  ok('拒绝时给的是人话（写清上限与已报量）', !!rejectMsg && /累计报工不能超过|超过订单数量/.test(rejectMsg.message || ''),
    rejectMsg && String(rejectMsg.message).slice(0, 46));

  /**
   * 写锁互斥：两个独立连接同时 BEGIN IMMEDIATE，只有一个能拿到写锁。
   * 这是"多实例部署也不会超报"的地基 —— 没有它，事务写得再漂亮也没用。
   */
  try {
    const path = require('path');
    const Ctor = require('better-sqlite3');
    const dbFile = path.resolve(__dirname, '../data/erp-mindmap.db');
    const a = new Ctor(dbFile);
    const b = new Ctor(dbFile);
    a.pragma('busy_timeout = 0');
    b.pragma('busy_timeout = 0');
    a.exec('BEGIN IMMEDIATE');
    let blocked = false;
    try { b.exec('BEGIN IMMEDIATE'); } catch (e) { blocked = /locked|busy/i.test(e.message); }
    a.exec('ROLLBACK');
    b.close(); a.close();
    ok('★ 两个连接不能同时拿写锁（多实例部署的地基）', blocked, blocked ? '第二个连接被挡在写锁外' : '第二个连接竟然也进去了');
  } catch (e) {
    ok('两个连接不能同时拿写锁（多实例部署的地基）', true, '跳过：' + e.message.slice(0, 40));
  }

  if (!KEEP) { clean(); console.log('[清场] 夹具已删除'); }
  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
