/**
 * 海外仓（美仓）作业：到仓上架 / 套装拆组 / 运费核对
 * 对应原型 TS-M19 美仓（16 节点，本版补齐收货上架、套装拆组、运费核对三块）
 *
 * 核心口径：
 * 1. **有预告才收货**：ASN 未到仓不能点收；点收必须有 ASN 明细做对照，
 *    不许「凭空多出一批货」（无预告到货要走临时 ASN，也要留单号）。
 * 2. **数量必须守恒**：预收 = 实收 + 破损 + 短少（超收单独记），差额必须写原因，
 *    不接受「就这么点」。
 * 3. **上架才可售**：只有上架到 sellable 库位、且点收已完成的量才进美仓可售库存；
 *    破损进 damaged 区、待检进 inspect 区，都不算可售。
 * 4. **库位是找货位置，不是实时库存**：库位记录上架到哪，不做逐单扣减
 *    （小仓没有 WMS 的拣货路径，做假精确反而误导）。实时可售量看库存页。
 * 5. **套装与单品库存分开**：套装库存存在 wh_bundle_stock，不混进 stock_items，
 *    否则单品可用量会被套装吃掉。组装/拆分都要扣/加组件库存并写流水。
 * 6. **运费核对要有基准**：系统金额按费率表（首重 + 续重 + 燃油）算，
 *    没有费率的承运商不出系统金额、只标「无基准」，不拿 0 元当基准去比。
 * 7. **对不上账的账单不能结算**：有未处理差异（金额差/重量差/无此单）时禁止结算。
 */
const { db } = require('../src/db');

const DDL = [
  // 1. 库位
  `CREATE TABLE IF NOT EXISTS wh_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL DEFAULT 'us',
    code TEXT NOT NULL,                          -- US-A-01-02
    zone TEXT NOT NULL DEFAULT 'sellable',       -- sellable 可售 / inspect 待检 / damaged 破损 / return 退货 / staging 暂存
    aisle TEXT,
    capacity INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',       -- active / locked
    remark TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (warehouse, code)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whloc_zone ON wh_locations(warehouse, zone)`,

  // 2. 集货发运单（到仓预告）
  `CREATE TABLE IF NOT EXISTS wh_asns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asn_no TEXT UNIQUE NOT NULL,                 -- ASN+日期+序号
    warehouse TEXT NOT NULL DEFAULT 'us',        -- 目的仓
    from_warehouse TEXT NOT NULL DEFAULT 'cn',   -- 发出仓
    carrier TEXT,
    container_no TEXT,
    ship_date TEXT,
    eta_date TEXT,
    arrive_date TEXT,
    carton_plan INTEGER NOT NULL DEFAULT 0,
    carton_actual INTEGER NOT NULL DEFAULT 0,
    expect_qty REAL NOT NULL DEFAULT 0,
    received_qty REAL NOT NULL DEFAULT 0,
    damaged_qty REAL NOT NULL DEFAULT 0,
    short_qty REAL NOT NULL DEFAULT 0,
    over_qty REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',        -- draft / in_transit / arrived / receiving / done / cancelled
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whasn_status ON wh_asns(warehouse, status)`,

  // 3. 预告明细
  `CREATE TABLE IF NOT EXISTS wh_asn_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asn_id INTEGER NOT NULL,
    style_no TEXT,
    product_name TEXT,
    color TEXT,
    size TEXT,
    expect_qty REAL NOT NULL DEFAULT 0,
    carton_no TEXT,
    remark TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whasni_asn ON wh_asn_items(asn_id)`,

  // 4. 到仓点收单
  `CREATE TABLE IF NOT EXISTS wh_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rcv_no TEXT UNIQUE NOT NULL,                 -- RCV+日期+序号
    asn_id INTEGER NOT NULL,
    arrive_date TEXT,
    carton_actual INTEGER NOT NULL DEFAULT 0,
    expect_qty REAL NOT NULL DEFAULT 0,
    received_qty REAL NOT NULL DEFAULT 0,
    damaged_qty REAL NOT NULL DEFAULT 0,
    short_qty REAL NOT NULL DEFAULT 0,
    over_qty REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'counting',     -- counting / done
    note TEXT,
    receive_by TEXT,
    received_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 5. 点收明细（含上架进度）
  `CREATE TABLE IF NOT EXISTS wh_receipt_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rcv_id INTEGER NOT NULL,
    asn_item_id INTEGER,
    style_no TEXT,
    product_name TEXT,
    color TEXT,
    size TEXT,
    expect_qty REAL NOT NULL DEFAULT 0,
    received_qty REAL NOT NULL DEFAULT 0,
    damaged_qty REAL NOT NULL DEFAULT 0,
    short_qty REAL NOT NULL DEFAULT 0,
    over_qty REAL NOT NULL DEFAULT 0,
    put_qty REAL NOT NULL DEFAULT 0,             -- 累计上架
    diff_reason TEXT,
    remark TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whrcvi_rcv ON wh_receipt_items(rcv_id)`,

  // 6. 上架记录（库位是找货位置，不做逐单扣减）
  `CREATE TABLE IF NOT EXISTS wh_putaways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    put_no TEXT NOT NULL,
    rcv_item_id INTEGER NOT NULL,
    location_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    operator TEXT,
    put_at TEXT NOT NULL,
    remark TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whput_item ON wh_putaways(rcv_item_id)`,

  // 7. 套装定义
  `CREATE TABLE IF NOT EXISTS wh_bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    warehouse TEXT NOT NULL DEFAULT 'us',
    sale_price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',       -- active / disabled
    remark TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 8. 套装组成
  `CREATE TABLE IF NOT EXISTS wh_bundle_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id INTEGER NOT NULL,
    style_no TEXT NOT NULL,
    product_name TEXT,
    color TEXT,
    size TEXT,
    qty_per REAL NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whbi_bundle ON wh_bundle_items(bundle_id)`,

  // 9. 套装库存（与单品库存分开，避免套装吃掉单品可用量）
  `CREATE TABLE IF NOT EXISTS wh_bundle_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id INTEGER NOT NULL,
    warehouse TEXT NOT NULL DEFAULT 'us',
    qty REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (bundle_id, warehouse)
  )`,

  // 10. 套装组装 / 拆分单据
  `CREATE TABLE IF NOT EXISTS wh_bundle_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op_no TEXT UNIQUE NOT NULL,                  -- KT+日期+序号 / UB+日期+序号
    bundle_id INTEGER NOT NULL,
    type TEXT NOT NULL,                          -- kit 组装 / unbundle 拆分
    warehouse TEXT NOT NULL DEFAULT 'us',
    qty REAL NOT NULL DEFAULT 0,
    before_qty REAL NOT NULL DEFAULT 0,
    after_qty REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'done',
    remark TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
  )`,

  // 11. 运费费率（系统金额的唯一基准）
  `CREATE TABLE IF NOT EXISTS wh_freight_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carrier TEXT NOT NULL,
    zone TEXT NOT NULL,                          -- US-W / US-E / US-C ...
    currency TEXT NOT NULL DEFAULT 'USD',
    first_weight REAL NOT NULL DEFAULT 1,        -- 首重 kg
    first_price REAL NOT NULL DEFAULT 0,
    add_weight REAL NOT NULL DEFAULT 0.5,        -- 续重步长 kg
    add_price REAL NOT NULL DEFAULT 0,
    fuel_pct REAL NOT NULL DEFAULT 0,            -- 燃油附加 %
    effective_from TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    UNIQUE (carrier, zone, effective_from)
  )`,

  // 12. 承运商账单
  `CREATE TABLE IF NOT EXISTS wh_freight_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_no TEXT UNIQUE NOT NULL,
    carrier TEXT NOT NULL,
    period_from TEXT,
    period_to TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    total_amount REAL NOT NULL DEFAULT 0,        -- 账单总额
    sys_amount REAL NOT NULL DEFAULT 0,          -- 按费率算出的系统金额（可核对部分）
    diff_amount REAL NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    diff_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,    -- 账单有、系统无
    extra_count INTEGER NOT NULL DEFAULT 0,      -- 系统有、账单无（漏计费）
    status TEXT NOT NULL DEFAULT 'pending',      -- pending 待核 / matched 已核平 / disputed 有争议 / settled 已结算
    supplier_id INTEGER,
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 13. 账单明细
  `CREATE TABLE IF NOT EXISTS wh_freight_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL,
    tracking_no TEXT,
    order_id INTEGER,
    ship_date TEXT,
    dest_zip TEXT,
    zone TEXT,
    weight REAL NOT NULL DEFAULT 0,              -- 账单计费重
    act_weight REAL NOT NULL DEFAULT 0,          -- 实际重（发货记录/人工）
    bill_amount REAL NOT NULL DEFAULT 0,
    sys_amount REAL NOT NULL DEFAULT 0,
    diff REAL NOT NULL DEFAULT 0,
    diff_type TEXT NOT NULL DEFAULT 'ok',        -- ok / amount 金额差 / weight 重量差 / missing 账单有系统无 / no_rate 无费率基准 / extra 系统有账单无
    status TEXT NOT NULL DEFAULT 'ok',           -- ok / diff / disputed / accepted
    note TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_whfi_bill ON wh_freight_items(bill_id)`
];

function run() {
  DDL.forEach((s) => db.exec(s));
  const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'wh_%'").get().c;
  console.log(`[warehouse] 已建 ${t} 张表`);
}

if (require.main === module) run();
module.exports = { DDL };
