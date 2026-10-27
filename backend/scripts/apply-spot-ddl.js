/**
 * 退货入库与库龄 / 现货动销分析
 * 对应原型 M19「美仓退货库龄 + 现货经营分析」
 *
 * 核心口径：
 * 1. **库龄用流水反算，不加批次表**：按「先进先出」把出库逐笔冲最早的入库，
 *    剩下的入库就是当前在库，其入库日期就是库龄起点。好处是不动现有库存写入逻辑。
 * 2. **退货必须逐件判定**：实收数量必须等于良品 + 次品 + 报废，不许「先收着以后判」。
 * 3. **只有良品回可售库存**：次品进破损区、报废不入库，都不进可售量。
 * 4. **关单后不可改**：判定与入库都定了才允许关单。
 * 5. **滞销不等于该清货**：只给库龄与动销数据 + 预警，不自动打折或下架。
 */
const { db } = require('../src/db');

const DDL = [
  // 退货单（客退 / 零售退 / 质量退 / 美仓退回）
  `CREATE TABLE IF NOT EXISTS stock_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_no TEXT UNIQUE NOT NULL,              -- RT+日期+序号
    type TEXT NOT NULL DEFAULT 'customer',       -- customer 客退 / retail 零售退 / quality 质量退 / transfer_back 调回
    warehouse TEXT NOT NULL DEFAULT 'us',
    order_id INTEGER,
    order_no TEXT,
    partner_name TEXT,                           -- 客户 / 店铺
    source_no TEXT,                              -- 原发货单号 / 运单号
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'draft',        -- draft / received / inspected / closed / cancelled
    qty_apply REAL NOT NULL DEFAULT 0,
    qty_received REAL NOT NULL DEFAULT 0,
    qty_good REAL NOT NULL DEFAULT 0,
    qty_defect REAL NOT NULL DEFAULT 0,
    qty_scrap REAL NOT NULL DEFAULT 0,
    return_date TEXT,
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_srt_status ON stock_returns(warehouse, status)`,

  // 退货明细
  `CREATE TABLE IF NOT EXISTS stock_return_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL,
    style_no TEXT,
    product_name TEXT,
    color TEXT,
    size TEXT,
    qty_apply REAL NOT NULL DEFAULT 0,
    qty_received REAL NOT NULL DEFAULT 0,
    qty_good REAL NOT NULL DEFAULT 0,
    qty_defect REAL NOT NULL DEFAULT 0,
    qty_scrap REAL NOT NULL DEFAULT 0,
    location_code TEXT,
    note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_srti_return ON stock_return_items(return_id)`
];

function run() {
  DDL.forEach((s) => db.exec(s));
  const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'stock_return%'").get().c;
  console.log(`[spot] 已建 ${t} 张表`);
}

if (require.main === module) run();
module.exports = { DDL };
