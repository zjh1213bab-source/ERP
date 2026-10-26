/**
 * 生产工序服务：默认 13 道工序 + 初始化
 */
const { db, now } = require('../db');

const DEFAULT_NODES = [
  '备料',
  '排版算料',
  '裁剪',
  '车缝',
  '锁眼钉扣',
  '整烫',
  '水洗',
  '印花',
  '绣花',
  '检验',
  '包装',
  '成品入库',
  '出库发运'
];

/** 若订单还没有工序，则按默认工序初始化；返回是否新建 */
function ensureNodes(orderId) {
  const c = Number(db.prepare('SELECT COUNT(*) AS c FROM order_nodes WHERE order_id = ?').get(orderId).c);
  if (c > 0) return false;
  const t = now();
  const ins = db.prepare(
    'INSERT INTO order_nodes (order_id, name, seq, status, created_at) VALUES (?,?,?,?,?)'
  );
  DEFAULT_NODES.forEach((name, i) => ins.run(orderId, name, i + 1, 'pending', t));
  return true;
}

module.exports = { DEFAULT_NODES, ensureNodes };
