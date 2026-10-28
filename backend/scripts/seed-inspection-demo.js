/**
 * 验货报告演示数据（可重复执行）
 *
 * 给「有照片的订单」补一张完整的验货单：
 *   开单（从标准带出检验项）→ 填实测值 → 标一项 NG → 完成判定（让步接收）
 *
 * 走真实 HTTP 接口而不是直接 INSERT：开单带检验项、完成判定会自动开异常单，
 * 这些逻辑如果自己拼 SQL 就绕过了，演示数据也就假了。
 *
 * 已有「已完成」验货单的订单会跳过，所以重复执行不会堆一堆单。
 *
 * 用法：node scripts/seed-inspection-demo.js
 */
const { db } = require('../src/db');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';

async function login() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  });
  const j = await r.json();
  if (!j.ok) throw new Error('登录失败：' + j.message);
  return j.data.token;
}

(async () => {
  const token = await login();
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const json = async (p, opt = {}) => (await fetch(BASE + p, { headers: H, ...opt })).json();

  // 找有照片的订单（报告里照片是重点，没照片的订单演示价值低）
  const withPhotos = db
    .prepare(
      `SELECT target_id AS id, COUNT(*) AS photos
         FROM attachments
        WHERE target_type = 'order' AND deleted_at IS NULL
        GROUP BY target_id ORDER BY photos DESC, target_id DESC`
    )
    .all();
  if (!withPhotos.length) {
    console.log('没有照片，先跑 node scripts/seed-photos-demo.js');
    process.exit(1);
  }

  // 列表接口不带检验项，必须取详情，否则开出来的单没有检验项（这一点踩过）
  const stds = await json('/api/qc/standards');
  const brief = (stds.data || []).find((x) => x.item_count > 0) || (stds.data || [])[0];
  if (!brief) {
    console.log('没有检验标准，先在「质量与合规 → 检验标准」建一条');
    process.exit(1);
  }
  const stdDetail = await json('/api/qc/standards/' + brief.id);
  const std = stdDetail.data || brief;
  console.log('使用标准：', std.name, `（${(std.items || []).length} 项）`);
  if (!(std.items || []).length) {
    console.log('该标准没有检验项，报告里的「检验项明细」会是空的；建议先给标准补几项');
  }

  let done = 0;
  for (const row of withPhotos) {
    const exists = db
      .prepare("SELECT id, inspect_no FROM qc_inspections WHERE order_id = ? AND status = 'done' LIMIT 1")
      .get(row.id);
    if (exists) {
      console.log(`  · 订单 #${row.id} 已有验货单 ${exists.inspect_no}，跳过`);
      continue;
    }

    const order = db.prepare('SELECT order_no, style_name FROM orders WHERE id = ?').get(row.id);
    const create = await json('/api/qc/inspections', {
      method: 'POST',
      body: JSON.stringify({
        order_id: row.id,
        standard_id: std.id,
        type: 'final',
        sample_qty: 80,
        remark: '尾期抽检（演示）'
      })
    });
    if (!create.ok) { console.log(`  ✗ #${row.id} 开单失败：${create.message}`); continue; }
    const ins = create.data;

    // 填实测值；把「标识标签」类的问题标成 NG，模拟真实的不良
    const items = (ins.items || []).map((it, i) => ({
      id: it.id,
      actual: i === 0 ? '符合' : i === 1 ? '4.6' : '符合要求',
      result: i === 2 ? 'ng' : 'ok',
      remark: i === 2 ? '洗标位置偏移 5mm' : ''
    }));

    const upd = await json(`/api/qc/inspections/${ins.id}`, {
      method: 'PUT',
      body: JSON.stringify({ items, sample_qty: 80, fail_qty: 6 })
    });
    if (!upd.ok) { console.log(`  ✗ #${row.id} 填值失败：${upd.message}`); continue; }

    const fin = await json(`/api/qc/inspections/${ins.id}/finish`, {
      method: 'POST',
      body: JSON.stringify({
        sample_qty: 80,
        fail_qty: 6,
        aql_result: 'conditional',
        remark: '洗标位置偏移，不影响穿着与安全，经客户同意让步接收'
      })
    });
    if (!fin.ok) { console.log(`  ✗ #${row.id} 判定失败：${fin.message}`); continue; }

    console.log(`  ✓ ${order.order_no}（${order.style_name || '未填款名'}）→ ${ins.inspect_no} 让步接收，不良 6/80`);
    done++;
  }

  // 顺便出一份报告，页面打开就能看到「已生成」的样子
  const target = withPhotos[0];
  const rep = await json('/api/inspection', {
    method: 'POST',
    body: JSON.stringify({ order_id: target.id, note: '演示报告' })
  });
  if (rep.ok) {
    console.log(`\n生成演示报告：${rep.data.report_no}（v${rep.data.version}，照片 ${rep.data.photos_count} 张）`);
    console.log(`查看：${BASE}/inspection/${target.id}?report=${rep.data.id}`);
  } else {
    console.log('\n生成报告失败：', rep.message);
  }

  console.log(`\n完成：新建验货单 ${done} 张`);
  process.exit(0);
})();
