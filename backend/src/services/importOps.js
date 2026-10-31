/**
 * 上线准备：真实数据导入 —— 服务层
 * ============================================================
 * 上线期初导入是一次性、不可重来的操作，所以规则比功能重要：
 *   ① **先预览再提交**：预览只算不写，逐行给「新增 / 覆盖 / 错误 + 原因」
 *   ② **默认整批事务**：有一行错就整批不写（否则导一半的数据最难收拾）
 *   ③ **期初库存只能导一次**：同 仓+款+色+码 已有期初流水就拒（重复导入会把库存翻倍）
 *   ④ **不覆盖真实业务产生的库存**：已有库存数量不为 0 时拒绝，提示改用盘点
 *   ⑤ **只覆盖导入文件里给出的字段**：没给的列不动（避免导一半把别的字段清空）
 *   ⑥ **每批留痕**：谁、什么时候、哪个文件、多少行、失败哪些行
 */
const { db } = require('../db');
const C = require('../utils/csv');

const pad = (n) => String(n).padStart(2, '0');
const now = () => new Date().toISOString();
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const r2 = (v) => Math.round(num(v) * 100) / 100;
const trim = (v) => String(v === undefined || v === null ? '' : v).trim();

function nextBatchNo() {
  const d = new Date();
  const p = `IMP${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rows = db.prepare("SELECT batch_no AS no FROM import_batches WHERE batch_no LIKE ?").all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  return `${p}${String(max + 1).padStart(4, '0')}`;
}

// ---------------- 值域 ----------------
const STATUS_CN = { 启用: 'active', 停用: 'inactive', active: 'active', inactive: 'inactive' };
const MAT_TYPE = { 面料: 'fabric', 辅料: 'accessory', fabric: 'fabric', accessory: 'accessory' };
const SUP_CAT = {
  面料商: 'material', 材料商: 'material', 辅料商: 'material', 材料: 'material', material: 'material',
  加工厂: 'process', 外协厂: 'process', 工艺: 'process', process: 'process',
  服务商: 'service', 服务: 'service', service: 'service'
};
const SKU_KIND = { 单件: 'single', 套装: 'set', single: 'single', set: 'set' };
const WH = { 生产仓: 'cn', 美仓: 'us', cn: 'cn', us: 'us', 国内仓: 'cn', 美国仓: 'us' };
/** 员工状态：库里只有 active / left 两种 */
const EMP_STATUS = { 在职: 'active', 在岗: 'active', 离职: 'left', active: 'active', left: 'left' };

function pickEnum(map, v, fallback, errs, label) {
  const s = trim(v);
  if (!s) return fallback;
  const k = map[s];
  if (!k) {
    errs.push(`${label || '取值'}「${s}」不认识（可用：${Object.keys(map).slice(0, 4).join(' / ')}）`);
    return fallback;
  }
  return k;
}

// ---------------- 各类型定义 ----------------
/**
 * 每个类型提供：
 *   fields   —— 模板表头 + 字段说明
 *   parse()  —— 把一行变成 { values, errors }
 *   find()   —— 按业务唯一键找已有记录
 *   insert() / update() —— 写库
 *   precheck() —— 类型专属校验（如期初库存不许重复导）
 */
const TYPES = {
  // ============ 客户 ============
  customers: {
    label: '客户档案',
    group: '主数据',
    unique: '按「客户编号」匹配；没有编号时按「客户名称」匹配',
    note: '不填客户编号也能导，系统按名称判重；编号重复会覆盖（只覆盖文件里给出的列）',
    fields: [
      { k: 'code', label: '客户编号', aliases: ['编号', '客户编号'] },
      { k: 'name', label: '客户名称', aliases: ['名称', '客户名称'], required: true },
      { k: 'contact', label: '联系人', aliases: ['联系人'] },
      { k: 'phone', label: '电话', aliases: ['电话', '手机'] },
      { k: 'email', label: '邮箱', aliases: ['邮箱', '邮件'] },
      { k: 'level', label: '等级', aliases: ['等级', '客户等级'], hint: 'A / B / C' },
      { k: 'credit_limit', label: '信用额度', aliases: ['信用额度', '额度'], hint: '数字' },
      { k: 'status', label: '状态', aliases: ['状态'], hint: '启用 / 停用' },
      { k: 'remark', label: '备注', aliases: ['备注'] }
    ],
    sample: ['C-1001', '示例客户公司', '张三', '13800000000', 'demo@example.com', 'A', '50000', '启用', '按编号覆盖，无编号按名称匹配'],
    parse(get) {
      const errs = [];
      const name = trim(get('客户名称', '名称'));
      if (!name) errs.push('客户名称必填');
      const credit = trim(get('信用额度', '额度'));
      if (credit && !Number.isFinite(Number(credit.replace(/,/g, '')))) errs.push('信用额度应为数字');
      return {
        values: {
          code: trim(get('客户编号', '编号')) || null,
          name,
          contact: trim(get('联系人')) || null,
          phone: trim(get('电话', '手机')) || null,
          email: trim(get('邮箱', '邮件')) || null,
          level: trim(get('等级', '客户等级')) || null,
          credit_limit: credit ? r2(credit.replace(/,/g, '')) : null,
          status: pickEnum(STATUS_CN, get('状态'), 'active', errs, '状态'),
          remark: trim(get('备注')) || null
        },
        errors: errs
      };
    },
    find(v) {
      // 给了编码就只认编码：编码查不到就是新客户。
      // **不能退化成按名称匹配**——那会把一个同名但不同编码的老客户覆盖掉（踩过）。
      if (v.code) return db.prepare('SELECT * FROM customers WHERE code = ?').get(v.code) || null;
      return db.prepare('SELECT * FROM customers WHERE name = ?').get(v.name) || null;
    },
    insert(v, ts) {
      return db.prepare(
        `INSERT INTO customers (code, name, contact, phone, email, level, credit_limit, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(v.code, v.name, v.contact, v.phone, v.email, v.level, v.credit_limit, v.status, v.remark, ts, ts).lastInsertRowid;
    },
    update(ex, v, ts) {
      const sets = [];
      const args = [];
      Object.keys(v).forEach((k) => {
        if (k === 'code' && !v.code) return;
        if (v[k] === null || v[k] === undefined || v[k] === '') return;   // 没给的列不动
        sets.push(`${k} = ?`);
        args.push(v[k]);
      });
      if (!sets.length) return;
      sets.push('updated_at = ?');
      args.push(ts, ex.id);
      db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
  },

  // ============ 供应商 ============
  suppliers: {
    label: '供应商档案',
    group: '主数据',
    unique: '按「供应商编码」匹配；没有编码时按「供应商名称」匹配',
    note: '类别写「材料 / 加工 / 服务」，不填按材料处理',
    fields: [
      { k: 'code', label: '供应商编码', aliases: ['编码', '供应商编码'] },
      { k: 'name', label: '供应商名称', aliases: ['名称', '供应商名称'], required: true },
      { k: 'short_name', label: '简称', aliases: ['简称'] },
      { k: 'category', label: '类别', aliases: ['类别', '类型'], hint: '材料 / 加工 / 服务' },
      { k: 'contact', label: '联系人', aliases: ['联系人'] },
      { k: 'phone', label: '电话', aliases: ['电话', '手机'] },
      { k: 'payment_terms', label: '账期', aliases: ['账期', '付款条件'] },
      { k: 'lead_days', label: '交期天数', aliases: ['交期天数', '交期'], hint: '整数天' },
      { k: 'status', label: '状态', aliases: ['状态'], hint: '启用 / 停用' },
      { k: 'remark', label: '备注', aliases: ['备注'] }
    ],
    sample: ['S-1001', '示例纺织有限公司', '示例纺织', '材料', '李四', '13900000000', '月结 30 天', '15', '启用', ''],
    parse(get) {
      const errs = [];
      const name = trim(get('供应商名称', '名称'));
      if (!name) errs.push('供应商名称必填');
      const lead = trim(get('交期天数', '交期'));
      if (lead && !Number.isFinite(Number(lead))) errs.push('交期天数应为整数');
      return {
        values: {
          code: trim(get('供应商编码', '编码')) || null,
          name,
          short_name: trim(get('简称')) || null,
          category: pickEnum(SUP_CAT, get('类别', '类型'), 'material', errs, '类别'),
          contact: trim(get('联系人')) || null,
          phone: trim(get('电话', '手机')) || null,
          payment_terms: trim(get('账期', '付款条件')) || null,
          lead_days: lead ? Math.round(Number(lead)) : null,
          status: pickEnum(STATUS_CN, get('状态'), 'active', errs, '状态'),
          remark: trim(get('备注')) || null
        },
        errors: errs
      };
    },
    find(v) {
      // 同客户：给了编码就只认编码
      if (v.code) return db.prepare('SELECT * FROM suppliers WHERE code = ?').get(v.code) || null;
      return db.prepare('SELECT * FROM suppliers WHERE name = ?').get(v.name) || null;
    },
    insert(v, ts) {
      return db.prepare(
        `INSERT INTO suppliers (code, name, short_name, category, contact, phone, payment_terms, lead_days, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(v.code, v.name, v.short_name, v.category, v.contact, v.phone, v.payment_terms, v.lead_days, v.status, v.remark, ts, ts).lastInsertRowid;
    },
    update(ex, v, ts) {
      const sets = [];
      const args = [];
      Object.keys(v).forEach((k) => {
        if (k === 'code' && !v.code) return;
        if (v[k] === null || v[k] === undefined || v[k] === '') return;
        sets.push(`${k} = ?`);
        args.push(v[k]);
      });
      if (!sets.length) return;
      sets.push('updated_at = ?');
      args.push(ts, ex.id);
      db.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
  },

  // ============ 物料（面料/辅料） ============
  materials: {
    label: '面辅料档案',
    group: '主数据',
    unique: '按「材质编码」匹配',
    note: '类型写「面料 / 辅料」；编码为空时只新增不判重，**建议都填编码**',
    fields: [
      { k: 'type', label: '类型', aliases: ['类型', '物料类型'], required: true, hint: '面料 / 辅料' },
      { k: 'code', label: '材质编码', aliases: ['编码', '材质编码'], hint: '建议必填，用于判重' },
      { k: 'name', label: '名称', aliases: ['名称', '物料名称'], required: true },
      { k: 'spec', label: '规格', aliases: ['规格'] },
      { k: 'composition', label: '成分', aliases: ['成分'] },
      { k: 'unit', label: '单位', aliases: ['单位'], hint: '米 / 公斤 / 条 / 粒' },
      { k: 'supplier', label: '供应商', aliases: ['供应商', '供方'] },
      { k: 'color', label: '颜色', aliases: ['颜色'] },
      { k: 'status', label: '状态', aliases: ['状态'], hint: '启用 / 停用' },
      { k: 'remark', label: '备注', aliases: ['备注'] }
    ],
    sample: ['面料', 'F-1001', '32S 精梳棉', '185g/㎡ 幅宽150cm', '100% 棉', '米', '绍兴示例纺织', '本白', '启用', ''],
    parse(get) {
      const errs = [];
      const name = trim(get('名称', '物料名称'));
      if (!name) errs.push('名称必填');
      const rawType = trim(get('类型', '物料类型'));
      if (!rawType) errs.push('类型必填（面料 / 辅料）');
      const type = pickEnum(MAT_TYPE, rawType, 'fabric', errs, '类型');
      return {
        values: {
          type,
          code: trim(get('编码', '材质编码')) || null,
          name,
          spec: trim(get('规格')) || null,
          composition: trim(get('成分')) || null,
          unit: trim(get('单位')) || null,
          supplier: trim(get('供应商', '供方')) || null,
          color: trim(get('颜色')) || null,
          status: pickEnum(STATUS_CN, get('状态'), 'active', errs, '状态'),
          remark: trim(get('备注')) || null
        },
        errors: errs
      };
    },
    find(v) {
      if (!v.code) return null;
      return db.prepare('SELECT * FROM materials WHERE code = ?').get(v.code) || null;
    },
    insert(v, ts) {
      return db.prepare(
        `INSERT INTO materials (type, code, name, spec, composition, unit, supplier, color, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(v.type, v.code, v.name, v.spec, v.composition, v.unit, v.supplier, v.color, v.status, v.remark, ts, ts).lastInsertRowid;
    },
    update(ex, v, ts) {
      const sets = [];
      const args = [];
      Object.keys(v).forEach((k) => {
        if (k === 'code' && !v.code) return;
        if (v[k] === null || v[k] === undefined || v[k] === '') return;
        sets.push(`${k} = ?`);
        args.push(v[k]);
      });
      if (!sets.length) return;
      sets.push('updated_at = ?');
      args.push(ts, ex.id);
      db.prepare(`UPDATE materials SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
  },

  // ============ 产品/款 ============
  products: {
    label: '产品（款）档案',
    group: '主数据',
    unique: '按「款号」匹配',
    note: '款号是订单与库存的关联键，改名但别改款号',
    fields: [
      { k: 'sku', label: '款号', aliases: ['款号', 'SKU', '编码'], required: true },
      { k: 'name', label: '款名', aliases: ['款名', '名称'], required: true },
      { k: 'category', label: '品类', aliases: ['品类', '类别'] },
      { k: 'unit', label: '单位', aliases: ['单位'] },
      { k: 'price', label: '参考单价', aliases: ['参考单价', '单价'], hint: '数字' },
      { k: 'status', label: '状态', aliases: ['状态'], hint: '启用 / 停用' },
      { k: 'remark', label: '备注', aliases: ['备注'] }
    ],
    sample: ['LEJE-1001', '示例款-女式针织开衫', '上衣', '件', '78', '启用', ''],
    parse(get) {
      const errs = [];
      const sku = trim(get('款号', 'SKU', '编码'));
      const name = trim(get('款名', '名称'));
      if (!sku) errs.push('款号必填');
      if (!name) errs.push('款名必填');
      const price = trim(get('参考单价', '单价'));
      if (price && !Number.isFinite(Number(price.replace(/,/g, '')))) errs.push('参考单价应为数字');
      return {
        values: {
          sku,
          name,
          category: trim(get('品类', '类别')) || null,
          unit: trim(get('单位')) || '件',
          price: price ? r2(price.replace(/,/g, '')) : null,
          status: pickEnum(STATUS_CN, get('状态'), 'active', errs, '状态'),
          remark: trim(get('备注')) || null
        },
        errors: errs
      };
    },
    find(v) {
      return db.prepare('SELECT * FROM products WHERE sku = ?').get(v.sku) || null;
    },
    insert(v, ts) {
      return db.prepare(
        `INSERT INTO products (sku, name, category, unit, price, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(v.sku, v.name, v.category, v.unit, v.price, v.status, v.remark, ts, ts).lastInsertRowid;
    },
    update(ex, v, ts) {
      db.prepare(
        `UPDATE products SET name=?, category=COALESCE(?,category), unit=COALESCE(?,unit),
           price=COALESCE(?,price), status=?, remark=COALESCE(?,remark), updated_at=? WHERE id=?`
      ).run(v.name, v.category, v.unit, v.price, v.status, v.remark, ts, ex.id);
    }
  },

  // ============ SKU 主档 ============
  skus: {
    label: 'SKU 主档',
    group: '主数据',
    unique: '按「SKU 编码」匹配',
    note: '单件单位写「件」，套装写「套」；套装建完要去页面上配组件',
    fields: [
      { k: 'sku', label: 'SKU 编码', aliases: ['SKU', '编码', 'SKU编码'], required: true },
      { k: 'style_no', label: '款号', aliases: ['款号'], required: true },
      { k: 'style_name', label: '款名', aliases: ['款名'] },
      { k: 'pattern', label: '花型', aliases: ['花型', '花型名'] },
      { k: 'color', label: '颜色', aliases: ['颜色'] },
      { k: 'size', label: '尺码', aliases: ['尺码', '规格'] },
      { k: 'kind', label: '类型', aliases: ['类型'], hint: '单件 / 套装' },
      { k: 'unit', label: '基本单位', aliases: ['单位', '基本单位'], hint: '件 / 套' },
      { k: 'barcode', label: '条码', aliases: ['条码', '条形码'] },
      { k: 'remark', label: '备注', aliases: ['备注'] }
    ],
    sample: ['LEJE-1001-A-3T', 'LEJE-1001', '示例款-女式针织开衫', '花A', '藏青', '3T', '单件', '件', '6901234567890', ''],
    parse(get) {
      const errs = [];
      const sku = trim(get('SKU', '编码', 'SKU编码'));
      const styleNo = trim(get('款号'));
      if (!sku) errs.push('SKU 编码必填');
      if (!styleNo) errs.push('款号必填');
      const kind = pickEnum(SKU_KIND, get('类型'), 'single', errs, '类型');
      const unitRaw = trim(get('单位', '基本单位'));
      const unit = unitRaw || (kind === 'set' ? '套' : '件');
      if (kind === 'set' && unit !== '套') errs.push('套装的基本单位必须是「套」');
      if (kind === 'single' && unit !== '件') errs.push('单件的基本单位必须是「件」');
      return {
        values: {
          sku, style_no: styleNo,
          style_name: trim(get('款名')) || null,
          pattern: trim(get('花型', '花型名')) || null,
          color: trim(get('颜色')) || null,
          size: trim(get('尺码', '规格')) || null,
          kind, unit,
          barcode: trim(get('条码', '条形码')) || null,
          remark: trim(get('备注')) || null
        },
        errors: errs
      };
    },
    find(v) {
      return db.prepare('SELECT * FROM sku_masters WHERE sku = ?').get(v.sku) || null;
    },
    precheck(v) {
      const errs = [];
      // 单花单码唯一：撞了别的 SKU 要拦住，否则导完主数据就自相矛盾
      if (v.kind === 'single') {
        const dup = db.prepare(
          `SELECT sku FROM sku_masters WHERE kind='single' AND style_no=?
             AND IFNULL(pattern,'')=? AND IFNULL(color,'')=? AND IFNULL(size,'')=? AND IFNULL(customer_id,0)=0`
        ).get(v.style_no, v.pattern, v.color, v.size);
        if (dup && dup.sku !== v.sku) {
          errs.push(`同款同花型同色同码已有 SKU「${dup.sku}」，单花单码只能有一个`);
        }
      }
      if (v.barcode) {
        const b = db.prepare('SELECT sku FROM sku_masters WHERE barcode = ? AND sku <> ?').get(v.barcode, v.sku);
        if (b) errs.push(`条码 ${v.barcode} 已被 SKU「${b.sku}」占用`);
      }
      return errs;
    },
    insert(v, ts) {
      return db.prepare(
        `INSERT INTO sku_masters (sku, style_no, style_name, pattern, color, size, kind, unit, barcode, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?)`
      ).run(v.sku, v.style_no, v.style_name, v.pattern, v.color, v.size, v.kind, v.unit, v.barcode, v.remark, ts, ts).lastInsertRowid;
    },
    update(ex, v, ts) {
      db.prepare(
        `UPDATE sku_masters SET style_name=COALESCE(?,style_name), pattern=COALESCE(?,pattern),
           color=COALESCE(?,color), size=COALESCE(?,size), barcode=COALESCE(?,barcode),
           remark=COALESCE(?,remark), updated_at=? WHERE id=?`
      ).run(v.style_name, v.pattern, v.color, v.size, v.barcode, v.remark, ts, ex.id);
    }
  },

  // ============ 期初库存 ============
  stock_opening: {
    label: '期初库存',
    group: '期初',
    unique: '按「仓库 + 款号 + 颜色 + 尺码」唯一',
    note: '**只能导一次**：同一 仓+款+色+码 已有期初流水就拒绝；已有真实库存（数量不为 0）也拒绝，那种情况请走盘点',
    fields: [
      { k: 'warehouse', label: '仓库', aliases: ['仓库'], required: true, hint: '生产仓 / 美仓' },
      { k: 'style_no', label: '款号', aliases: ['款号'], required: true },
      { k: 'product_name', label: '款名', aliases: ['款名', '名称'] },
      { k: 'color', label: '颜色', aliases: ['颜色'] },
      { k: 'size', label: '尺码', aliases: ['尺码', '规格'] },
      { k: 'qty', label: '数量', aliases: ['数量', '件数'], required: true },
      { k: 'remark', label: '备注', aliases: ['备注'] }
    ],
    sample: ['生产仓', 'LEJE-1001', '示例款-女式针织开衫', '藏青', '3T', '120', '2026-10-31 期初盘点数'],
    parse(get) {
      const errs = [];
      const whRaw = trim(get('仓库'));
      if (!whRaw) errs.push('仓库必填（生产仓 / 美仓）');
      const warehouse = pickEnum(WH, whRaw, 'cn', errs, '仓库');
      const styleNo = trim(get('款号'));
      if (!styleNo) errs.push('款号必填');
      const qtyRaw = trim(get('数量', '件数')).replace(/,/g, '');
      let qty = 0;
      if (!qtyRaw) errs.push('数量必填');
      else if (!Number.isFinite(Number(qtyRaw))) errs.push('数量应为数字');
      else {
        qty = r2(qtyRaw);
        if (qty < 0) errs.push('数量不能为负（盘亏请走盘点，期初只记实数）');
        if (qty === 0) errs.push('数量为 0 的行没有意义，请删掉这一行');
      }
      return {
        values: {
          warehouse, style_no: styleNo,
          product_name: trim(get('款名', '名称')) || null,
          color: trim(get('颜色')),
          size: trim(get('尺码', '规格')),
          qty,
          remark: trim(get('备注')) || null
        },
        errors: errs
      };
    },
    find(v) {
      return db.prepare(
        'SELECT * FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?'
      ).get(v.warehouse, v.style_no, v.color, v.size) || null;
    },
    /**
     * 期初库存的三条硬门：只导一次、不覆盖真实库存、必须标明是期初
     */
    precheck(v) {
      const errs = [];
      const opened = db.prepare(
        `SELECT id FROM stock_ledger WHERE warehouse=? AND style_no=? AND color=? AND size=? AND type='opening' LIMIT 1`
      ).get(v.warehouse, v.style_no, v.color, v.size);
      if (opened) {
        errs.push('这个 仓+款+色+码 已经有期初流水了：期初只能导一次，重复导入会把库存翻倍');
      }
      const cur = db.prepare(
        'SELECT qty FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?'
      ).get(v.warehouse, v.style_no, v.color, v.size);
      if (cur && num(cur.qty) > 0.001) {
        errs.push(`这个 仓+款+色+码 已有库存 ${r2(cur.qty)} 件（业务产生）：期初导入不覆盖真实库存，请走盘点`);
      }
      return errs;
    },
    /** 期初永远只新增，不更新（find 存在即报错，走不到 update） */
    insert(v, ts) {
      const id = db.prepare(
        `INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(v.warehouse, v.style_no, v.product_name, v.color, v.size, v.qty, ts).lastInsertRowid;
      db.prepare(
        `INSERT INTO stock_ledger (warehouse, style_no, product_name, color, size, type, qty, ref_type, ref_id, remark, operator, created_at)
         VALUES (?,?,?,?,?,'opening',?,?,?,?,?,?)`
      ).run(
        v.warehouse, v.style_no, v.product_name, v.color, v.size, v.qty,
        'import', id, v.remark || '上线期初库存导入', 'import', ts
      );
      return id;
    },
    update() { /* 期初不更新 */ }
  },

  // ============ 员工档案 ============
  /**
   * 空库上线第一件事就是录员工，一个个敲 25 个人不现实。
   *
   * 三条刻意的规则：
   *   1. **部门必须已存在**：不自动建，否则「生产部 / 生产一部 / 生产 部」会各建一个；
   *   2. 匹配顺序 工号 → 姓名+手机 → 新建。**只有姓名就当新人**，不按姓名合并
   *      （同名不同人很常见，合并会把两个人的考勤和工资搅在一起）；
   *   3. 钉钉 userid 不能撞人：一个 userid 只能属于一个员工，否则打卡会写到两个人头上。
   */
  employees: {
    label: '员工档案',
    group: '主数据',
    unique: '按「工号」匹配；没有工号时按「姓名 + 手机」匹配，都没有就新建',
    note: '部门要先在「组织编制与岗位」建好（不自动创建，避免错别字造部门）；填了钉钉 userid 才能同步考勤',
    fields: [
      { k: 'code', label: '工号', aliases: ['工号', '员工编号'] },
      { k: 'name', label: '姓名', aliases: ['姓名', '员工姓名'], required: true },
      { k: 'department_name', label: '部门', aliases: ['部门', '所属部门'], hint: '须已存在' },
      { k: 'position', label: '岗位', aliases: ['岗位', '职位'] },
      { k: 'phone', label: '手机', aliases: ['手机', '电话', '手机号'] },
      { k: 'hire_date', label: '入职日期', aliases: ['入职日期', '入职时间'], hint: 'YYYY-MM-DD' },
      { k: 'status', label: '状态', aliases: ['状态'], hint: '在职 / 离职' },
      { k: 'dingtalk_userid', label: '钉钉userid', aliases: ['钉钉userid', '钉钉ID', 'dingtalk_userid'] }
    ],
    sample: ['E001', '张三', '生产部', '车缝工', '13800000000', '2026-11-01', '在职', '2300000000000001'],
    parse(get) {
      const errs = [];
      const name = trim(get('姓名', '员工姓名'));
      if (!name) errs.push('姓名必填');

      const deptName = trim(get('部门', '所属部门'));
      let department_id = null;
      if (deptName) {
        const d = db.prepare('SELECT id FROM departments WHERE name = ?').get(deptName);
        if (!d) errs.push(`部门「${deptName}」不存在：先到「组织编制与岗位」建好（这里不自动建，避免错别字造出部门）`);
        else department_id = d.id;
      }

      const phone = trim(get('手机', '电话', '手机号')) || null;
      if (phone && !/^1\d{10}$/.test(String(phone).replace(/[-\s]/g, ''))) {
        errs.push(`手机号格式不对：${phone}`);
      }

      const hire = trim(get('入职日期', '入职时间')) || null;
      if (hire && !/^\d{4}-\d{2}-\d{2}$/.test(hire)) errs.push(`入职日期应为 YYYY-MM-DD：${hire}`);

      return {
        values: {
          code: trim(get('工号', '员工编号')) || null,
          name,
          department_id,
          position: trim(get('岗位', '职位')) || null,
          phone: phone ? String(phone).replace(/[-\s]/g, '') : null,
          hire_date: hire,
          status: pickEnum(EMP_STATUS, get('状态'), 'active', errs, '状态'),
          dingtalk_userid: trim(get('钉钉userid', '钉钉ID', 'dingtalk_userid')) || null
        },
        errors: errs
      };
    },
    find(v) {
      // 有工号就只认工号（工号查不到＝新人，不能退化成按姓名匹配）
      if (v.code) return db.prepare('SELECT * FROM employees WHERE code = ?').get(v.code) || null;
      if (v.phone) return db.prepare('SELECT * FROM employees WHERE name = ? AND phone = ?').get(v.name, v.phone) || null;
      return null;
    },
    batchUnique(v) {
      // 一个钉钉 userid 只能属于一个员工，否则打卡会落到两个人头上
      return v.dingtalk_userid
        ? [{ key: 'dt:' + v.dingtalk_userid, label: `钉钉 userid「${v.dingtalk_userid}」` }]
        : [];
    },
    precheck(v, existing) {
      const errs = [];
      if (v.dingtalk_userid) {
        const owner = db.prepare('SELECT id, name FROM employees WHERE dingtalk_userid = ?').get(v.dingtalk_userid);
        if (owner && (!existing || Number(owner.id) !== Number(existing.id))) {
          errs.push(`钉钉 userid「${v.dingtalk_userid}」已被「${owner.name}」占用（一个 userid 只能绑一个员工）`);
        }
      }
      return errs;
    },
    insert(v, ts, ctx) {
      return db.prepare(
        `INSERT INTO employees (code, name, department_id, position, phone, hire_date, status, dingtalk_userid, base_salary, remark, created_at, company_id)
         VALUES (?,?,?,?,?,?,?,?,0,NULL,?,?)`
      ).run(v.code, v.name, v.department_id, v.position, v.phone, v.hire_date, v.status, v.dingtalk_userid, ts, (ctx && ctx.company_id) || 1).lastInsertRowid;
    },
    update(ex, v, ts) {
      // employees 没有 updated_at 列（不硬套别的类型的写法）
      const sets = [];
      const args = [];
      Object.keys(v).forEach((k) => {
        if (k === 'code' && !v.code) return;
        if (k === 'department_id') { if (v[k]) { sets.push('department_id = ?'); args.push(v[k]); } return; }
        if (v[k] === null || v[k] === undefined || v[k] === '') return;  // 没给的列不动
        sets.push(`${k} = ?`);
        args.push(v[k]);
      });
      if (!sets.length) return;
      args.push(ex.id);
      db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
  }
};

// ---------------- 引擎 ----------------
function typeList() {
  return Object.entries(TYPES).map(([k, t]) => ({
    type: k,
    label: t.label,
    group: t.group,
    unique: t.unique,
    note: t.note,
    fields: t.fields.map((f) => ({
      k: f.k, label: f.label, required: !!f.required, hint: f.hint || null,
      aliases: f.aliases || []
    })),
    header: t.fields.map((f) => f.label)
  }));
}

function template(type) {
  const t = TYPES[type];
  if (!t) throw new Error('不支持的导入类型');
  return C.toCsv([t.fields.map((f) => f.label), t.sample]);
}

/**
 * 逐行分析（不写库）。返回每行的动作与错误，供预览与提交共用，
 * 保证「预览看到什么，提交就写什么」。
 */
function analyze(type, csv) {
  const t = TYPES[type];
  if (!t) throw new Error(`不支持的导入类型：${type}`);
  const parsed = C.parseCsv(csv, null);
  if (!parsed.rows.length) throw new Error('CSV 内容为空');
  if (parsed.rows.length < 2) throw new Error('只有表头，没有数据行');
  const header = parsed.rows[0];
  const readRow = C.reader(header);
  // 每行绑一个取值函数：C.reader 的签名是 (row, ...names)，容易漏传 row 导致整行读空（踩过）
  const getFor = (row) => (...names) => readRow(row, ...names);

  // 表头体检：必填字段的列必须存在
  const missing = t.fields.filter((f) => f.required).filter((f) => {
    const has = (f.aliases || []).concat([f.label]).some((n) => {
      const key = String(n).replace(/\s+/g, '');
      return header.some((h) => String(h).trim().replace(/\s+/g, '') === key);
    });
    return !has;
  }).map((f) => f.label);
  if (missing.length) {
    throw new Error(`表头缺少必填列：${missing.join('、')}（可下载模板对照）`);
  }

  const seen = new Map();      // 同批次内重复检测（主键：工号/编码/姓名）
  const seenExtra = new Map(); // 批内附加唯一键（如员工钉钉 userid）
  const rows = [];
  parsed.rows.slice(1).forEach((raw, i) => {
    const line = i + 2;        // 表头占第 1 行
    let out;
    try {
      out = t.parse(getFor(raw));
    } catch (e) {
      rows.push({ line, action: 'error', key: null, errors: [e.message], preview: raw.slice(0, 6).join(' | ') });
      return;
    }
    const errors = out.errors.slice();
    const v = out.values;
    const key = type === 'stock_opening'
      ? `${v.warehouse}|${v.style_no}|${v.color}|${v.size}`
      : (v.sku || v.code || v.name);

    if (key && seen.has(key)) {
      errors.push(`与第 ${seen.get(key)} 行重复（同一批里不能出现两次）`);
    } else if (key) {
      seen.set(key, line);
    }

    /**
     * 批内附加唯一键（例如员工的钉钉 userid）
     *
     * 为什么单独做：这类冲突**在预览阶段库里还查不到彼此**（两行都还没入库），
     * 只靠 precheck 查表是查不出来的 —— 导进去就会出现"一个 userid 属于两个人"，
     * 之后打卡会随机落到其中一个人头上。
     */
    if (typeof t.batchUnique === 'function') {
      (t.batchUnique(v) || []).filter(Boolean).forEach((u) => {
        if (seenExtra.has(u.key)) errors.push(`${u.label} 与第 ${seenExtra.get(u.key)} 行重复（同一批里不能出现两次）`);
        else seenExtra.set(u.key, line);
      });
    }

    let existing = null;
    if (!errors.length) {
      existing = t.find(v);
      if (existing && !t.update) {
        errors.push('这条已存在，且该类型不支持覆盖');
      }
      if (t.precheck) errors.push(...t.precheck(v, existing));
    }

    rows.push({
      line,
      action: errors.length ? 'error' : (existing ? 'update' : 'new'),
      key,
      existing_id: existing ? existing.id : null,
      values: v,
      errors,
      preview: previewOf(type, v)
    });
  });

  const stat = {
    total: rows.length,
    new: rows.filter((r) => r.action === 'new').length,
    update: rows.filter((r) => r.action === 'update').length,
    error: rows.filter((r) => r.action === 'error').length
  };
  return { type, label: t.label, delimiter: parsed.delimiter, header, stat, rows };
}

function previewOf(type, v) {
  if (type === 'stock_opening') {
    const wh = v.warehouse === 'us' ? '美仓' : '生产仓';
    return `${wh} · ${v.style_no} ${v.color || '-'} ${v.size || '-'} · ${v.qty}`;
  }
  if (type === 'skus') return `${v.sku} · ${v.style_no} ${v.pattern || '-'} ${v.color || '-'} ${v.size || '-'}`;
  if (type === 'materials') return `${v.type === 'fabric' ? '面料' : '辅料'} · ${v.code || '(无编码)'} ${v.name}`;
  if (type === 'customers') return `${v.code || '(无编号)'} ${v.name}`;
  if (type === 'suppliers') return `${v.code || '(无编码)'} ${v.name}`;
  if (type === 'employees') return `${v.code || '(无工号)'} ${v.name}${v.position ? ' · ' + v.position : ''}`;
  return `${v.sku} ${v.name}`;
}

function preview(type, csv) {
  const a = analyze(type, csv);
  // 预览最多回 500 行，避免大文件把响应撑爆
  return {
    type: a.type, label: a.label, delimiter: a.delimiter, stat: a.stat,
    rows: a.rows.slice(0, 500),
    truncated: a.rows.length > 500,
    can_commit: a.stat.error === 0,
    hint: a.stat.error
      ? `有 ${a.stat.error} 行有问题。默认整批不写：要么改好文件重新导，要么勾「跳过错误行」`
      : `将新增 ${a.stat.new} 条、覆盖 ${a.stat.update} 条`
  };
}

/**
 * 提交。默认整批事务：有一行错就整批不写。
 * skip_errors=1 时只跳过错误行（记进批次留痕）。
 */
function commit(type, csv, opts, operator) {
  const t = TYPES[type];
  const a = analyze(type, csv);
  const skipErrors = opts && (opts.skip_errors === 1 || opts.skip_errors === true);
  const bad = a.rows.filter((r) => r.action === 'error');
  if (bad.length && !skipErrors) {
    const err = new Error(`有 ${bad.length} 行有问题，整批未写入（改好再导，或勾「跳过错误行」）`);
    err.code = 422;
    err.payload = {
      stat: a.stat,
      rows: bad.slice(0, 200).map((r) => ({ line: r.line, errors: r.errors, preview: r.preview }))
    };
    throw err;
  }

  const todo = a.rows.filter((r) => r.action !== 'error');
  const ts = now();
  // 主体：带 company_id 的表由插入实现显式写入（绝不取请求体）
  const ctx = { company_id: opts && opts.company_id };
  const batchNo = nextBatchNo();
  let batchId = null;
  let created = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    a.header.forEach(() => {});
    todo.forEach((r) => {
      if (r.action === 'new') {
        t.insert(r.values, ts, ctx);
        created += 1;
      } else if (r.action === 'update') {
        const ex = t.find(r.values);
        t.update(ex, r.values, ts, ctx);
        updated += 1;
      }
    });
    const info = db.prepare(
      `INSERT INTO import_batches
        (batch_no, type, type_label, file_name, delimiter, total_rows, ok_rows, new_rows, update_rows,
         error_rows, skipped_rows, status, skip_errors, errors, note, operator, created_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'committed',?,?,?,?,?,?)`
    ).run(
      batchNo, type, t.label, (opts && opts.file_name) || null, a.delimiter,
      a.stat.total, created + updated, created, updated,
      a.stat.error, skipErrors ? bad.length : 0,
      skipErrors ? 1 : 0, bad.length ? JSON.stringify(bad.slice(0, 200).map((r) => ({ line: r.line, key: r.key, errors: r.errors }))) : null,
      (opts && opts.note) || null, operator || null, ts, ts
    );
    batchId = info.lastInsertRowid;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    // 失败也留一条批次，方便事后查是哪批出的问题
    try {
      db.prepare(
        `INSERT INTO import_batches
          (batch_no, type, type_label, file_name, delimiter, total_rows, ok_rows, new_rows, update_rows,
           error_rows, status, skip_errors, errors, note, operator, created_at, finished_at)
         VALUES (?,?,?,?,?,?,0,0,0,?,'failed',0,?,?,?,?,?)`
      ).run(
        batchNo, type, t.label, (opts && opts.file_name) || null, a.delimiter,
        a.stat.total, a.stat.error, JSON.stringify([{ line: 0, errors: [e.message] }]),
        (opts && opts.note) || null, operator || null, ts, ts
      );
    } catch (e2) { /* 留痕失败不影响主错误 */ }
    throw new Error(`导入失败，整批已回滚：${e.message}`);
  }

  return {
    batch_no: batchNo, batch_id: batchId, type,
    label: t.label,
    new: created, update: updated, skipped: skipErrors ? bad.length : 0,
    total: a.stat.total
  };
}

function batches(q) {
  const where = [];
  const args = [];
  if (q && q.type) { where.push('type = ?'); args.push(q.type); }
  const rows = db.prepare(
    `SELECT * FROM import_batches ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT 100`
  ).all(...args);
  return rows.map((r) => ({ ...r, errors: undefined, error_count: r.error_rows }));
}

function batchDetail(id) {
  const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
  if (!b) throw new Error('导入批次不存在');
  let errors = [];
  try { errors = b.errors ? JSON.parse(b.errors) : []; } catch (e) { errors = []; }
  return { ...b, errors_json: undefined, error_list: errors };
}

module.exports = { typeList, template, preview, commit, batches, batchDetail, analyze, TYPES };
