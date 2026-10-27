/**
 * 现场照片留证 DDL
 *
 * 复用 attachments 表（它本来就能挂 order），补三个维度：
 *   cat     分类：defect 不良 / incoming 到货 / packing 装箱 / sample 样品 / other 其他
 *   note    一句话说明（谁在什么情况下拍的）
 *   node_id 关联工序（不良照片必须能说清是哪道工序出的问题）
 *   taken_at 拍摄时间（手机时间可能与上传时间不同，夜里补传很常见）
 *
 * 为什么不新建一张 photos 表：附件本来就是「文件挂在业务对象上」这件事，
 * 再开一张表会让「看一张单的所有附件」变成两处查询，迟早漏掉一侧。
 */
const { db } = require('../src/db');

function has(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (e) {
    return false;
  }
}

function add(table, col, ddl) {
  if (has(table, col)) {
    console.log(`  · ${table}.${col} 已存在`);
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`  ✓ ${table}.${col}`);
}

console.log('attachments 扩列：');
add('attachments', 'cat', "cat TEXT NOT NULL DEFAULT 'other'");
add('attachments', 'note', 'note TEXT');
add('attachments', 'node_id', 'node_id INTEGER');
add('attachments', 'taken_at', 'taken_at TEXT');
add('attachments', 'deleted_at', 'deleted_at TEXT');

// 照片墙要按订单 + 分类倒序扫，走索引
db.exec('CREATE INDEX IF NOT EXISTS idx_att_order_cat ON attachments(target_type, target_id, cat)');
db.exec('CREATE INDEX IF NOT EXISTS idx_att_cat_time ON attachments(cat, created_at)');
console.log('  ✓ 索引 idx_att_order_cat / idx_att_cat_time');

// 软删除：照片是证据，删掉就说不清了，保留行 + 标记，列表过滤
console.log('\n完成。');
