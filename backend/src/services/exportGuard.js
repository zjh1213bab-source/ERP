/**
 * 数据导出与订阅（TS-N18-03 / TS-N18-09 的「导出」部分）
 * ========================================================================
 * 这个模块只干一件事：**让每一次数据离开系统都有据可查，并且带得走的东西是脱敏后的**。
 *
 * 为什么不能各页面自己拼 CSV：
 *   - 21 个导出端点里 20 个是 `res.send(csv)` 直接出门，没有记录、没有水印；
 *   - 客户电话、员工身份证在页面上被掩成 `138****8888`，导出来却是全的 ——
 *     因为脱敏写在「查询接口」里，导出走了另一条路；
 *   - 事后有人拿着一个 Excel 问「这是谁导的」，谁都答不上来。
 *
 * 三个不做：
 *   1. **不做自定义 SQL / 自选表**。白名单在代码里（`DEFS`），页面只能选，不能填。
 *   2. **不做异步大文件**（没有队列与对象存储）。超过行数上限就让人缩小范围 ——
 *      截断的报表比导不出来更危险，会被人当成全量用。
 *   3. **不假装发邮件**。本部署没有 SMTP，`channel='email'` 的投递直接标 `blocked`，
 *      产出落站内可取。假装成功会让收件人以为没收到，数据却在库里等人点。
 */

const crypto = require('crypto');
const { db, now } = require('../db');
const privacy = require('./privacy');
const accessSvc = require('./access');
const { nextNo } = require('../utils/docNo');
const { toCsv } = require('../utils/csv');
const { localDate } = require('../utils/time');
const { reqCtx } = require('../utils/reqCtx');

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 是否持有某权限点（admin 恒通过；判定走 services/access，不自己拼角色表） */
function canDo(user, perm) {
  if (!perm) return true;
  if (!user || !user.role) return false;
  return accessSvc.hasPerm(user.sub || user.id, user.role, perm);
}

/** 本地今天 `YYYY-MM-DD`（不能用 toISOString，东八区会少一天） */
const today = () => localDate(now());

/** 本地此刻 `YYYY-MM-DD HH:mm`（写进 CSV 说明行给人看） */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SENS_LABEL = { normal: '一般', sensitive: '敏感', restricted: '受限' };
const DEF_STATUS = { active: '生效中', paused: '已暂停', expired: '已到期' };
const FREQ_LABEL = { weekly: '每周', monthly: '每月' };
const CHANNEL_LABEL = { inbox: '站内可取', email: '邮件' };
const DELIVERY_LABEL = {
  pending: '待领取', taken: '已领取', blocked: '通道未配置', failed: '失败'
};

// ============================================================
// 数据集白名单
// ============================================================
/**
 * 每个数据集必须写清四件事：**谁有权导（perm）、导出去的是什么（columns）、
 * 要不要按脱敏规则再掩一道（table）、超多少行必须停下来（row_cap）**。
 *
 * `params` 是允许的查询条件白名单 —— 只接受这里列出的键，其余一律忽略。
 * 这一条是为了防「URL 里塞个未知参数绕过过滤」（如 `?status=all` 把作废单据也导出来）。
 */
const DEFS = [
  {
    key: 'ar_aging',
    name: '应收发票与账龄',
    module: '财务 · 应收',
    table: 'ar_invoices',
    perm: 'collection.read',
    sensitivity: 'sensitive',
    params: ['as_of', 'status'],
    columns: [
      { key: 'bill_no', label: '发票号' },
      { key: 'customer_name', label: '客户' },
      { key: 'currency', label: '币种' },
      { key: 'amount_orig', label: '原币金额' },
      { key: 'amount', label: '本币金额' },
      { key: 'paid_amount', label: '已收金额' },
      { key: 'open_amount', label: '未收金额' },
      { key: 'due_date', label: '到期日' },
      { key: 'overdue_days', label: '逾期天数' },
      { key: 'status', label: '状态' },
      { key: 'company_id', label: '主体' }
    ],
    loader(p) {
      const asOf = str(p.as_of) || today();
      const rows = db.prepare(`SELECT * FROM ar_invoices
        WHERE status <> 'void' AND (${p.status ? 'status = ?' : '1=1'})`).all(...(p.status ? [p.status] : []));
      return rows.map((r) => {
        const open = round2(Number(r.amount) - Number(r.paid_amount));
        const days = r.due_date && r.due_date < asOf
          ? Math.floor((new Date(asOf) - new Date(r.due_date)) / 86400000) : 0;
        return { ...r, open_amount: open, overdue_days: days };
      }).filter((r) => r.open_amount > 0.005);
    }
  },
  {
    key: 'ap_ledger',
    name: '应付发票台账',
    module: '财务 · 应付',
    table: 'ap_invoices',
    perm: 'payable.read',
    sensitivity: 'sensitive',
    params: ['as_of', 'status'],
    columns: [
      { key: 'bill_no', label: '发票号' },
      { key: 'supplier_name', label: '供应商' },
      { key: 'currency', label: '币种' },
      { key: 'amount_orig', label: '原币金额' },
      { key: 'amount', label: '本币金额' },
      { key: 'paid_amount', label: '已付金额' },
      { key: 'open_amount', label: '未付金额' },
      { key: 'due_date', label: '到期日' },
      { key: 'status', label: '状态' },
      { key: 'company_id', label: '主体' }
    ],
    loader(p) {
      const rows = db.prepare(`SELECT * FROM ap_invoices
        WHERE status <> 'void' AND (${p.status ? 'status = ?' : '1=1'})`).all(...(p.status ? [p.status] : []));
      return rows.map((r) => ({ ...r, open_amount: round2(Number(r.amount) - Number(r.paid_amount)) }))
        .filter((r) => r.open_amount > 0.005);
    }
  },
  {
    key: 'customer_list',
    name: '客户档案（含联系方式）',
    module: '销售 · 客户',
    table: 'customers',
    perm: null,
    sensitivity: 'sensitive',
    params: ['status', 'level'],
    columns: [
      { key: 'code', label: '编码' },
      { key: 'name', label: '客户名称' },
      { key: 'contact', label: '联系人' },
      { key: 'phone', label: '电话' },
      { key: 'email', label: '邮箱' },
      { key: 'level', label: '等级' },
      { key: 'credit_limit', label: '信用额度' },
      { key: 'credit_days', label: '账期(天)' },
      { key: 'owner_name', label: '业务员' },
      { key: 'status', label: '状态' }
    ],
    note: '电话与邮箱按「客户联系方式」脱敏规则掩码，与页面看到的一致',
    loader(p) {
      const cond = [];
      const args = [];
      if (p.status) { cond.push('status = ?'); args.push(p.status); }
      if (p.level) { cond.push('level = ?'); args.push(p.level); }
      return db.prepare(`SELECT * FROM customers ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER BY id`).all(...args);
    }
  },
  {
    key: 'payroll_summary',
    name: '工资汇总（按人）',
    module: '人事 · 薪酬',
    table: 'payrolls',
    perm: 'paycheck.read',
    sensitivity: 'restricted',
    params: ['period'],
    columns: [
      { key: 'period', label: '月份' },
      { key: 'department', label: '部门' },
      { key: 'employee_name', label: '姓名' },
      { key: 'base_salary', label: '基本工资' },
      { key: 'piece_wage', label: '计件' },
      { key: 'overtime_pay', label: '加班费' },
      { key: 'bonus', label: '奖金' },
      { key: 'allowance', label: '补贴' },
      { key: 'deduction', label: '扣款' },
      { key: 'social_insurance', label: '社保' },
      { key: 'tax', label: '个税' },
      { key: 'gross_pay', label: '应发' },
      { key: 'net_pay', label: '实发' },
      { key: 'status', label: '状态' }
    ],
    note: '工资字段一律按「工资类」规则完全隐藏 —— 没有 payroll.sensitive 权限导出来只有姓名与空金额',
    loader(p) {
      const period = str(p.period) || today().slice(0, 7);
      return db.prepare('SELECT * FROM payrolls WHERE period = ? ORDER BY department, employee_id').all(period);
    }
  },
  {
    key: 'employee_roster',
    name: '员工花名册（含证件）',
    module: '人事 · 档案',
    table: 'employees',
    perm: null,
    sensitivity: 'restricted',
    params: ['status', 'department_id'],
    columns: [
      { key: 'code', label: '工号' },
      { key: 'name', label: '姓名' },
      { key: 'dept_name', label: '部门' },
      { key: 'position', label: '岗位' },
      { key: 'phone', label: '手机号' },
      { key: 'id_card', label: '身份证号' },
      { key: 'emergency_contact', label: '紧急联系人' },
      { key: 'hire_date', label: '入职日' },
      { key: 'status', label: '状态' }
    ],
    note: '身份证 / 手机 / 紧急联系人按脱敏规则掩码；导出记录会点名哪几个字段被掩了',
    loader(p) {
      const cond = [];
      const args = [];
      if (p.status) { cond.push('e.status = ?'); args.push(p.status); }
      if (p.department_id) { cond.push('e.department_id = ?'); args.push(Number(p.department_id)); }
      return db.prepare(`SELECT e.*, d.name AS dept_name FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY e.id`).all(...args);
    }
  },
  {
    key: 'stock_balance',
    name: '成品库存结存',
    module: '仓库 · 库存',
    table: 'stock_items',
    perm: null,
    sensitivity: 'normal',
    params: ['warehouse'],
    columns: [
      { key: 'warehouse', label: '仓库' },
      { key: 'style_no', label: '款号' },
      { key: 'product_name', label: '品名' },
      { key: 'color', label: '颜色' },
      { key: 'size', label: '尺码' },
      { key: 'qty', label: '数量' },
      { key: 'updated_at', label: '更新时间' }
    ],
    loader(p) {
      return db.prepare(`SELECT * FROM stock_items ${p.warehouse ? 'WHERE warehouse = ?' : ''}
        ORDER BY warehouse, style_no`).all(...(p.warehouse ? [p.warehouse] : []));
    }
  },
  {
    key: 'order_list',
    name: '销售订单清单',
    module: '销售 · 订单',
    table: 'orders',
    perm: null,
    sensitivity: 'normal',
    params: ['from', 'to', 'status'],
    columns: [
      { key: 'order_no', label: '订单号' },
      { key: 'cus_order_no', label: '客户单号' },
      { key: 'style_name', label: '款式' },
      { key: 'type', label: '类型' },
      { key: 'status', label: '状态' },
      { key: 'total_amount', label: '金额' },
      { key: 'currency', label: '币种' },
      { key: 'order_date', label: '下单日' },
      { key: 'delivery_date', label: '交期' },
      { key: 'manager', label: '业务员' }
    ],
    loader(p) {
      const cond = [];
      const args = [];
      if (p.from) { cond.push('order_date >= ?'); args.push(p.from); }
      if (p.to) { cond.push('order_date <= ?'); args.push(p.to); }
      if (p.status) { cond.push('status = ?'); args.push(p.status); }
      return db.prepare(`SELECT * FROM orders ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER BY order_date DESC, id DESC`).all(...args);
    }
  },
  {
    key: 'custody_onhand',
    name: '实物在手清单',
    module: '行政 · 领归',
    table: 'custody_items',
    perm: 'custody.read',
    sensitivity: 'normal',
    params: ['kind'],
    columns: [
      { key: 'item_no', label: '编号' },
      { key: 'name', label: '实物' },
      { key: 'spec', label: '规格' },
      { key: 'size', label: '尺码' },
      { key: 'holder', label: '在谁手上' },
      { key: 'issued_at', label: '领用时间' },
      { key: 'expected_return_at', label: '应还日' },
      { key: 'status_label', label: '状态' }
    ],
    loader(p) {
      const cond = [];
      const args = [];
      if (p.kind) { cond.push('i.kind = ?'); args.push(p.kind); }
      const rows = db.prepare(`SELECT i.*, r.employee_name AS holder, r.issued_at, r.expected_return_at
        FROM custody_items i
        LEFT JOIN custody_records r ON r.item_id = i.id AND r.status IN ('issued','awaiting')
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY i.id`).all(...args);
      const st = { active: '在册', hold: '待处理', scrapped: '已处置' };
      return rows.map((r) => ({ ...r, status_label: st[r.status] || r.status }));
    }
  },
  {
    key: 'headcount_by_dept',
    name: '部门人数分布（聚合）',
    module: '人事 · 编制',
    table: null,
    perm: null,
    sensitivity: 'sensitive',
    params: ['status'],
    small_sample: 1,
    small_sample_min: 5,
    sample_col: 'headcount',
    value_cols: ['headcount', 'avg_tenure_months'],
    columns: [
      { key: 'dept_name', label: '部门' },
      { key: 'headcount', label: '在职人数' },
      { key: 'manager_count', label: '管理岗' },
      { key: 'avg_tenure_months', label: '平均司龄(月)' },
      { key: 'suppressed', label: '小样本抑制' }
    ],
    note: '人数少于阈值的部门数值会被抑制；若只剩一个被抑制的组，会连带抑制第二小的组（否则用合计减其他组就能反推）',
    loader(p) {
      const status = str(p.status) || 'active';
      const rows = db.prepare(`SELECT d.name AS dept_name, COUNT(e.id) AS headcount,
          SUM(CASE WHEN e.position LIKE '%主管%' OR e.position LIKE '%经理%' THEN 1 ELSE 0 END) AS manager_count,
          AVG(julianday('now') - julianday(e.hire_date)) / 30.44 AS avg_tenure_months
        FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status = ?
        GROUP BY d.id ORDER BY headcount DESC, d.id`).all(status);
      return rows.map((r) => ({
        dept_name: r.dept_name,
        headcount: Number(r.headcount) || 0,
        manager_count: Number(r.manager_count) || 0,
        avg_tenure_months: r.avg_tenure_months == null ? null : Math.round(r.avg_tenure_months * 10) / 10,
        suppressed: ''
      }));
    }
  }
];

const DEF_MAP = new Map(DEFS.map((d) => [d.key, d]));

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 代码是白名单唯一来源：启动/首次访问时把 DEFS 写进 export_defs（以代码为准覆盖） */
function syncDefs() {
  const t = now();
  DEFS.forEach((d) => {
    const cols = JSON.stringify(d.columns || []);
    const exists = db.prepare('SELECT def_key FROM export_defs WHERE def_key = ?').get(d.key);
    if (exists) {
      // row_cap 更新时保留表里已有的值：这是安全阀，运维要能在不重启的情况下调小
      db.prepare(`UPDATE export_defs SET name=?, module=?, table_name=?, perm=?, sensitivity=?, columns=?,
          small_sample=?, small_sample_min=?, row_cap=COALESCE((SELECT row_cap FROM export_defs WHERE def_key=?), ?),
          note=?, enabled=1, updated_at=? WHERE def_key=?`).run(
        d.name, d.module || null, d.table || null, d.perm || null, d.sensitivity || 'normal', cols,
        d.small_sample ? 1 : 0, d.small_sample_min || 5, d.key, d.row_cap || 5000, d.note || null, t, d.key
      );
    } else {
      db.prepare(`INSERT INTO export_defs (def_key, name, module, table_name, perm, sensitivity, columns,
          small_sample, small_sample_min, row_cap, note, enabled, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(
        d.key, d.name, d.module || null, d.table || null, d.perm || null, d.sensitivity || 'normal', cols,
        d.small_sample ? 1 : 0, d.small_sample_min || 5, d.row_cap || 5000, d.note || null, t
      );
    }
  });
  // 代码里删掉的数据集：停用而不是删除（历史导出记录还要能对回定义）
  const keys = DEFS.map((d) => d.key);
  if (keys.length) {
    db.prepare(`UPDATE export_defs SET enabled = 0 WHERE def_key NOT IN (${keys.map(() => '?').join(',')})`).run(...keys);
  }
  return DEFS.length;
}

function defRow(key) {
  syncDefs();
  const row = db.prepare('SELECT * FROM export_defs WHERE def_key = ? AND enabled = 1').get(key);
  if (!row) throw bad('没有这个可导出数据集（只能从白名单里选）', 404);
  const def = DEF_MAP.get(key);
  return { ...row, def };
}

/** 该用户能看/能导的数据集（权限与数据集自身的 perm 双闸） */
function listDefs(user) {
  syncDefs();
  const rows = db.prepare('SELECT * FROM export_defs WHERE enabled = 1 ORDER BY module, def_key').all();
  return rows.map((r) => {
    const allowed = canDo(user, r.perm);
    return {
      def_key: r.def_key,
      name: r.name,
      module: r.module,
      sensitivity: r.sensitivity,
      sensitivity_label: SENS_LABEL[r.sensitivity] || r.sensitivity,
      columns: JSON.parse(r.columns || '[]'),
      col_count: JSON.parse(r.columns || '[]').length,
      params: (DEF_MAP.get(r.def_key) || {}).params || [],
      perm: r.perm,
      allowed: !!allowed,
      small_sample: !!r.small_sample,
      small_sample_min: r.small_sample_min,
      row_cap: r.row_cap,
      note: r.note
    };
  });
}

// ============================================================
// 小样本抑制
// ============================================================
/**
 * 抑制低于阈值的分组，并做**互补抑制**。
 *
 * 为什么需要互补：一个 12 个部门的表里只有「设计部 2 人」被抑制，
 * 拿合计 100 减掉其余 11 个，立刻得到 2 —— 抑制等于没做。
 * 所以当「只有一个组被抑制」且总组数 ≥ 3 时，连带把第二小的组一起抑制。
 */
function suppressSmallSample(def, rows) {
  const min = Number(def.small_sample_min) || 5;
  const sampleCol = def.sample_col || 'headcount';
  const valueCols = def.value_cols || [sampleCol];
  const out = rows.map((r) => ({ ...r }));
  const hit = [];
  out.forEach((r, i) => {
    if (Number(r[sampleCol]) > 0 && Number(r[sampleCol]) < min) hit.push(i);
  });
  if (hit.length === 1 && out.length >= 3) {
    // 找第二小的（排除已抑制的与 0 人的空部门）
    const rest = out.map((r, i) => ({ i, n: Number(r[sampleCol]) || 0 }))
      .filter((x) => x.n > 0 && x.i !== hit[0]).sort((a, b) => a.n - b.n);
    if (rest.length) hit.push(rest[0].i);
  }
  hit.forEach((i) => {
    valueCols.forEach((c) => { out[i][c] = `<${min}`; });
    out[i].suppressed = '是';
  });
  out.forEach((r) => { if (!r.suppressed) r.suppressed = ''; });
  return { rows: out, suppressed: hit.length };
}

// ============================================================
// 取数 + 脱敏 + 拼 CSV
// ============================================================
/**
 * 取数：参数白名单过滤 → loader → 行数上限校验。
 *
 * **不做原始 SQL 透传**，也不允许 `params` 里出现未声明的键 ——
 * 否则 `?status=void` 这类参数能把作废单也导出去，而页面上根本看不到它们。
 */
function fetchRows(defKey, params = {}) {
  const dr = defRow(defKey);
  const allow = dr.def.params || [];
  const clean = {};
  allow.forEach((k) => {
    const v = params[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') clean[k] = String(v).trim();
  });
  const rows = dr.def.loader(clean) || [];
  const cap = Number(dr.row_cap) || 5000;
  if (rows.length > cap) {
    throw bad(`这次导出命中 ${rows.length} 行，超过单次上限 ${cap} 行。请缩小范围（加日期或状态条件），不提供「截断导出」——截断的报表会被当成全量用`);
  }
  return { dr, params: clean, rows };
}

/** 找出这次实际被掩码的字段（比较原行与掩码行，不猜规则） */
function diffMasked(rawRows, maskedRows) {
  const fields = new Set();
  let rowsHit = 0;
  rawRows.forEach((raw, i) => {
    const m = maskedRows[i];
    if (!m) return;
    let hit = false;
    Object.keys(raw).forEach((k) => {
      if (m[k] !== raw[k] && m[k] !== undefined) { fields.add(k); hit = true; }
    });
    if (hit) rowsHit += 1;
  });
  return { fields: Array.from(fields), rows: rowsHit };
}

/**
 * 生成导出内容（不落库）
 *
 * 返回 { csv, rowsCount, colCount, maskedFields, maskedRows, suppressedRows, columns }
 * 水印由调用方（runExport / logExternal）生成后传进来 —— 因为水印要带单号，
 * 而单号是「决定落库」那一刻才分配的。
 */
function buildContent(defKey, params, user, opts = {}) {
  const { dr, params: clean, rows } = fetchRows(defKey, params);
  const def = dr.def;

  // 1. 脱敏（与页面同一套规则）
  const ctx = opts.ctx || {};
  let masked = rows;
  if (dr.table_name) {
    masked = privacy.maskRows(dr.table_name, rows, ctx);
  }

  // 掩码统计必须在小样本抑制**之前**算：抑制是把数值换成 `<5`，
  // 那不是「字段被掩码」。混在一起，「这次导出去了 3 个被掩码的字段」就不可信了。
  const { fields, rows: maskedRows } = diffMasked(rows, masked);

  // 2. 小样本抑制
  let suppressedRows = 0;
  if (dr.small_sample) {
    const s = suppressSmallSample(def, masked);
    masked = s.rows;
    suppressedRows = s.suppressed;
  }

  // 3. 拼 CSV：说明行 + 表头 + 数据（+ 水印列）
  const cols = JSON.parse(dr.columns || '[]');
  const withWatermark = ['sensitive', 'restricted'].includes(dr.sensitivity);
  const header = cols.map((c) => c.label);
  if (withWatermark) header.push('水印');

  const head = [
    ['导出数据集', dr.name, ''],
    ['导出人', `${opts.requester_name || (user && user.name) || ''}${opts.requester ? '（' + opts.requester + '）' : ''}`, ''],
    ['导出时间', stamp(), ''],
    ['数据行数', String(masked.length), maskedRows ? `其中 ${maskedRows} 行含掩码字段` : ''],
    ['导出理由', str(opts.reason) || '（订阅自动执行）', ''],
    ['水印', opts.watermark || '', ''],
    ['提示', '本文件限内部使用。水印可反查导出人与时间；敏感字段按权限掩码，未授权字段显示为 ****', ''],
    ['', '', '']
  ];

  const body = masked.map((r) => {
    const line = cols.map((c) => {
      const v = r[c.key];
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') return v;
      return String(v);
    });
    if (withWatermark) line.push(opts.watermark || '');
    return line;
  });

  const csv = toCsv([...head, header, ...body]);
  return {
    csv,
    rowsCount: masked.length,
    colCount: cols.length,
    maskedFields: fields,
    maskedRows,
    suppressedRows,
    columns: cols,
    withWatermark,
    defRow: dr
  };
}

/**
 * 预览：和导出**走同一条管道**（同样的脱敏、同样的小样本抑制），只截前 N 行。
 *
 * 为什么不能「预览看原值、导出看掩码」：两种可能都是一场事故 ——
 * 预览显全量会让人以为导出来是全的；预览不抑制会让人以为「3 人就是 3 人」，
 * 导出却变成 `<5`，然后来问「系统是不是坏了」。
 */
function previewSample(defKey, params, user, ctx, limit = 5) {
  const { dr, params: clean, rows } = fetchRows(defKey, params);
  let masked = dr.table_name ? privacy.maskRows(dr.table_name, rows, ctx || {}) : rows;
  let suppressedRows = 0;
  if (dr.small_sample) {
    const s = suppressSmallSample(dr.def, masked);
    masked = s.rows;
    suppressedRows = s.suppressed;
  }
  const cols = JSON.parse(dr.columns || '[]');
  const maskedInfo = diffMasked(rows, dr.table_name ? privacy.maskRows(dr.table_name, rows, ctx || {}) : rows);
  return {
    def_key: dr.def_key,
    name: dr.name,
    sensitivity: dr.sensitivity,
    total_rows: rows.length,
    row_cap: dr.row_cap,
    params: clean,
    columns: cols,
    masked_fields: maskedInfo.fields,
    masked_rows: maskedInfo.rows,
    suppressed_rows: suppressedRows,
    sample: masked.slice(0, limit).map((row) => {
      const o = {};
      cols.forEach((c) => { o[c.label] = row[c.key] === undefined || row[c.key] === null ? '' : row[c.key]; });
      return o;
    })
  };
}

// ============================================================
// 水印与导出记录
// ============================================================
function makeWatermark(jobNo) {
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `EXP-${jobNo}-${today().replace(/-/g, '')}-${rand}`;
}

function fileSafe(s) {
  return String(s || 'export').replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 导出主流程：校验 → 取数 → 脱敏 → 抑制 → 水印 → 落 export_jobs → 返回 csv
 *
 * @param {object} opts { def_key, params, reason, trigger, user, ctx, subscription_id, delivery_id }
 */
function runExport(opts = {}) {
  const { def_key, params = {}, user = {}, ctx = {}, trigger = 'manual' } = opts;
  if (!def_key) throw bad('必须指定数据集');
  const dr = defRow(def_key);

  // 手工导出必须写理由；订阅由创建时的用途说明继承
  const reason = str(opts.reason);
  if (trigger === 'manual' && reason.length < 4) {
    throw bad('导出必须写理由（至少 4 个字）。没有理由的导出记录，三个月后没人知道那次导出是干什么的');
  }

  // 数据集自身的权限（双闸：路由层的 export.run + 数据集要求的业务权限）
  if (!canDo(user, dr.perm)) {
    throw bad(`没有「${dr.name}」的查看权限，不能导出`, 403);
  }

  const jobNo = nextNo('CK', 'export_jobs', 'job_no');
  const watermark = makeWatermark(jobNo);
  const built = buildContent(def_key, params, user, {
    ...opts, ctx, reason, watermark,
    requester: user.username, requester_name: user.name
  });

  const hash = crypto.createHash('sha256').update(built.csv).digest('hex');
  const fileName = `${fileSafe(dr.name)}-${jobNo}-${today()}.csv`;
  const t = now();

  db.prepare(`INSERT INTO export_jobs (job_no, def_key, def_name, sensitivity, params, trigger_by,
      row_count, col_count, masked_fields, masked_rows, suppressed_rows, watermark, file_name,
      content_hash, reason, requester, requester_name, requester_role, ip, ua, subscription_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    jobNo, def_key, dr.name, dr.sensitivity, JSON.stringify(built.defRow ? params : params), trigger,
    built.rowsCount, built.colCount, built.maskedFields.join(','), built.maskedRows, built.suppressedRows,
    watermark, fileName, hash, reason || null,
    user.username || null, user.name || null, user.role || null,
    ctx.ip || null, ctx.ua || null, opts.subscription_id || null, t
  );

  const job = db.prepare('SELECT * FROM export_jobs WHERE job_no = ?').get(jobNo);
  return { job, csv: built.csv, fileName, ...built };
}

/** 只登记不产出（给已有导出端点用：它们自己拼 CSV，这里补一条记录 + 水印头） */
function logExternal(opts = {}) {
  const { def_key, params = {}, user = {}, ctx = {}, reason = '', row_count = 0, note = '' } = opts;
  const dr = def_key ? defRow(def_key) : null;
  const jobNo = nextNo('CK', 'export_jobs', 'job_no');
  const watermark = makeWatermark(jobNo);
  const t = now();
  db.prepare(`INSERT INTO export_jobs (job_no, def_key, def_name, sensitivity, params, trigger_by,
      row_count, col_count, masked_fields, masked_rows, suppressed_rows, watermark, file_name,
      content_hash, reason, requester, requester_name, requester_role, ip, ua, subscription_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    jobNo, def_key || 'legacy', dr ? dr.name : (note || '既有端点导出'), dr ? dr.sensitivity : 'sensitive',
    JSON.stringify(params), 'manual', Number(row_count) || 0, 0, '', 0, 0,
    watermark, null, null, reason || `既有端点导出${note ? '：' + note : ''}`,
    user.username || null, user.name || null, user.role || null,
    ctx.ip || null, ctx.ua || null, null, t
  );
  return { job_no: jobNo, watermark, watermark_line: `# 导出单号 ${jobNo} · 水印 ${watermark} · 仅限内部使用` };
}

function listJobs(q = {}) {
  const cond = [];
  const args = [];
  if (q.def_key) { cond.push('j.def_key = ?'); args.push(q.def_key); }
  if (q.trigger) { cond.push('j.trigger_by = ?'); args.push(q.trigger); }
  if (q.requester) { cond.push('j.requester = ?'); args.push(q.requester); }
  if (q.from) { cond.push('date(j.created_at) >= ?'); args.push(q.from); }
  if (q.to) { cond.push('date(j.created_at) <= ?'); args.push(q.to); }
  if (q.q) {
    cond.push('(j.job_no LIKE ? OR j.def_name LIKE ? OR j.requester_name LIKE ? OR j.watermark LIKE ?)');
    const like = `%${String(q.q).trim()}%`;
    args.push(like, like, like, like);
  }
  const limit = Math.min(Number(q.limit) || 200, 500);
  const rows = db.prepare(`SELECT j.*, s.sub_no FROM export_jobs j
    LEFT JOIN export_subscriptions s ON s.id = j.subscription_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY j.id DESC LIMIT ${limit}`).all(...args);
  return rows.map(decorJob);
}

function decorJob(r) {
  return {
    ...r,
    sensitivity_label: SENS_LABEL[r.sensitivity] || r.sensitivity,
    trigger_label: r.trigger_by === 'subscription' ? '订阅执行' : '手工导出',
    params: safeJson(r.params),
    created_local: require('../utils/time').localTime(r.created_at),
    masked_field_list: r.masked_fields ? r.masked_fields.split(',').filter(Boolean) : []
  };
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

function jobById(id) {
  const r = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id);
  if (!r) return null;
  const deliveries = db.prepare('SELECT * FROM export_deliveries WHERE job_id = ? ORDER BY id').all(id)
    .map((d) => ({ ...d, status_label: DELIVERY_LABEL[d.status] || d.status }));
  return { ...decorJob(r), deliveries };
}

/** 水印反查：拿一段水印串，说清「谁、什么时候、导了什么、为什么」 */
function traceWatermark(token) {
  const t = str(token);
  if (!t) throw bad('请把文件里的水印串贴进来（形如 EXP-CK202610280001-20261028-A7F3）');
  const row = db.prepare('SELECT * FROM export_jobs WHERE watermark = ?').get(t);
  if (!row) {
    // 允许只贴单号
    const byNo = db.prepare('SELECT * FROM export_jobs WHERE job_no = ?').get(t);
    if (!byNo) throw bad('没有这个水印对应的导出记录。可能是水印被截断，或这份文件不是从本系统导出的', 404);
    return { ...decorJob(byNo), matched_by: 'job_no' };
  }
  return { ...decorJob(row), matched_by: 'watermark' };
}

function stats() {
  syncDefs();
  const total = db.prepare('SELECT COUNT(*) c FROM export_jobs').get().c;
  const month = today().slice(0, 7);
  const thisMonth = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(row_count),0) rows FROM export_jobs WHERE substr(created_at,1,7) = ?").get(month);
  const byDef = db.prepare(`SELECT def_key, def_name, COUNT(*) c, COALESCE(SUM(row_count),0) rows
    FROM export_jobs GROUP BY def_key ORDER BY c DESC LIMIT 8`).all();
  const sensitive = db.prepare("SELECT COUNT(*) c FROM export_jobs WHERE sensitivity IN ('sensitive','restricted')").get().c;
  const masked = db.prepare('SELECT COALESCE(SUM(masked_rows),0) v, COALESCE(SUM(suppressed_rows),0) s FROM export_jobs').get();
  const subs = db.prepare("SELECT status, COUNT(*) c FROM export_subscriptions GROUP BY status").all();
  const due = db.prepare("SELECT COUNT(*) c FROM export_subscriptions WHERE status='active' AND next_run_at <= ?").get(today()).c;
  const pendingDeliv = db.prepare("SELECT COUNT(*) c FROM export_deliveries WHERE status='pending'").get().c;
  return {
    total,
    month_count: thisMonth.c,
    month_rows: thisMonth.rows,
    sensitive_count: sensitive,
    masked_rows: masked.v,
    suppressed_rows: masked.s,
    by_def: byDef,
    subs: subs.reduce((o, r) => { o[r.status] = r.c; return o; }, {}),
    due_subs: due,
    pending_deliveries: pendingDeliv,
    month
  };
}

// ============================================================
// 订阅
// ============================================================
/**
 * 下一期执行日（本地日期，`YYYY-MM-DD`）
 *
 * 月订阅：day_of_month 取 1–28（不给 29–31：2 月会漂到 3 月，人对不上账）
 * 周订阅：day_of_week 取 1–7（1=周一）
 * `from` 之后**严格大于**，避免「今天已跑还算出今天」把同一期跑两遍。
 */
function nextRunFor(freq, dayOfMonth, dayOfWeek, fromDate) {
  const p = (n) => String(n).padStart(2, '0');
  const base = fromDate ? new Date(`${fromDate}T00:00:00`) : new Date();
  base.setHours(0, 0, 0, 0);
  if (freq === 'weekly') {
    const want = Math.min(Math.max(Number(dayOfWeek) || 1, 1), 7);
    const cur = base.getDay() === 0 ? 7 : base.getDay();   // JS 0=周日 → 我们要 7
    let add = want - cur;
    if (add <= 0) add += 7;
    const d = new Date(base.getTime() + add * 86400000);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // monthly
  const want = Math.min(Math.max(Number(dayOfMonth) || 1, 1), 28);
  const thisMonth = new Date(base.getFullYear(), base.getMonth(), want);
  if (thisMonth.getTime() > base.getTime()) {
    return `${thisMonth.getFullYear()}-${p(thisMonth.getMonth() + 1)}-${p(thisMonth.getDate())}`;
  }
  const next = new Date(base.getFullYear(), base.getMonth() + 1, want);
  return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
}

function addMonths(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  const p = (x) => String(x).padStart(2, '0');
  const nd = new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28));
  return `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())}`;
}

function decorSub(r) {
  const recips = safeJson(r.recipients);
  return {
    ...r,
    params: safeJson(r.params),
    recipients: Array.isArray(recips) ? recips : Object.values(recips || {}),
    status_label: DEF_STATUS[r.status] || r.status,
    freq_label: FREQ_LABEL[r.freq] || r.freq,
    channel_label: CHANNEL_LABEL[r.channel] || r.channel,
    schedule_text: r.freq === 'weekly'
      ? `每周${'一二三四五六日'[Math.max(0, (Number(r.day_of_week) || 1) - 1)]}`
      : `每月 ${r.day_of_month} 日`,
    overdue: r.status === 'active' && r.next_run_at && r.next_run_at <= today()
  };
}

function listSubscriptions(q = {}) {
  const cond = [];
  const args = [];
  if (q.status) { cond.push('status = ?'); args.push(q.status); }
  if (q.mine && q.user) { cond.push('owner = ?'); args.push(q.user); }
  const rows = db.prepare(`SELECT * FROM export_subscriptions
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`).all(...args);
  return rows.map(decorSub);
}

function saveSubscription(b = {}, user = {}) {
  syncDefs();
  const name = str(b.name);
  if (name.length < 2) throw bad('订阅要有名字（例如「每月 5 日应收账龄给财务」）');
  const defKey = str(b.def_key);
  const dr = defRow(defKey);

  const freq = b.freq === 'weekly' ? 'weekly' : 'monthly';
  const dayOfMonth = freq === 'monthly' ? Math.min(Math.max(Number(b.day_of_month) || 1, 1), 28) : null;
  const dayOfWeek = freq === 'weekly' ? Math.min(Math.max(Number(b.day_of_week) || 1, 1), 7) : null;

  const recipients = Array.isArray(b.recipients)
    ? b.recipients.map((x) => str(x)).filter(Boolean)
    : String(b.recipients || '').split(/[,，\s]+/).map((x) => str(x)).filter(Boolean);
  if (!recipients.length) throw bad('订阅要指定收件人（至少一个账号）');
  // 收件人必须是真实账号：写错一个人的用户名，产出没人领，而系统以为发出去了
  const found = db.prepare(`SELECT username FROM users WHERE active = 1 AND username IN (${recipients.map(() => '?').join(',')})`)
    .all(...recipients).map((r) => r.username);
  const missing = recipients.filter((r) => !found.includes(r));
  if (missing.length) throw bad(`这些账号不存在或已停用：${missing.join('、')}`);

  const channel = b.channel === 'email' ? 'email' : 'inbox';

  const validFrom = str(b.valid_from) || today();
  const validUntil = str(b.valid_until);
  if (!validUntil) throw bad('必须设到期日。没有到期日的订阅会一直跑下去，换岗离职也没人停');
  if (validUntil <= validFrom) throw bad('到期日必须晚于生效日');
  const maxUntil = addMonths(validFrom, 24);
  if (validUntil > maxUntil) throw bad(`到期日不能超过 ${maxUntil}（最多两年，到期再续）`);

  const reason = str(b.note);
  if (reason.length < 4) throw bad('订阅要写用途（至少 4 个字）：这份数据定期发给谁、用来做什么');

  // 数据集权限：订阅人必须自己能导，否则等于借订阅绕过权限
  if (!canDo(user, dr.perm)) {
    throw bad(`没有「${dr.name}」的查看权限，不能订阅`, 403);
  }

  const t = now();
  const subNo = nextNo('DY', 'export_subscriptions', 'sub_no');
  // 第一期从**生效日**起算，不是从今天起算。
  // 生效日填上个月（补录历史订阅）时，第一期就是上个月那个周期日 —— 于是它立刻到期、该补跑一次；
  // 从今天起算会让这条订阅安静地等到下个周期，中间那期永远缺一份。
  const firstNext = (() => {
    const n = nextRunFor(freq, dayOfMonth, dayOfWeek, validFrom);
    return n > validUntil ? null : n;
  })();

  const info = db.prepare(`INSERT INTO export_subscriptions (sub_no, name, def_key, def_name, params, freq,
      day_of_month, day_of_week, channel, recipients, valid_from, valid_until, next_run_at, status,
      owner, owner_name, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    subNo, name, defKey, dr.name, JSON.stringify(safeJson(b.params || '{}')), freq,
    dayOfMonth, dayOfWeek, channel, JSON.stringify(recipients), validFrom, validUntil, firstNext,
    firstNext ? 'active' : 'expired', user.username || null, user.name || null, reason, t, t
  );
  return decorSub(db.prepare('SELECT * FROM export_subscriptions WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function setSubStatus(id, action) {
  const row = db.prepare('SELECT * FROM export_subscriptions WHERE id = ?').get(id);
  if (!row) throw bad('订阅不存在', 404);
  const t = now();
  if (action === 'pause') {
    if (row.status !== 'active') throw bad('只有生效中的订阅能暂停');
    db.prepare("UPDATE export_subscriptions SET status='paused', updated_at=? WHERE id=?").run(t, id);
  } else if (action === 'resume') {
    if (row.status === 'expired') throw bad('已过到期日的订阅不能恢复，请新建一条');
    const next = nextRunFor(row.freq, row.day_of_month, row.day_of_week, today());
    db.prepare("UPDATE export_subscriptions SET status='active', next_run_at=?, updated_at=? WHERE id=?")
      .run(next > row.valid_until ? null : next, t, id);
  } else if (action === 'cancel') {
    db.prepare("UPDATE export_subscriptions SET status='expired', next_run_at=NULL, updated_at=? WHERE id=?").run(t, id);
  } else {
    throw bad('未知操作');
  }
  return decorSub(db.prepare('SELECT * FROM export_subscriptions WHERE id = ?').get(id));
}

/** 到期订阅（供 run-due 与页面提示） */
function dueSubscriptions(asOf) {
  const d = asOf || today();
  return db.prepare(`SELECT * FROM export_subscriptions
    WHERE status='active' AND valid_from <= ? AND (next_run_at IS NOT NULL AND next_run_at <= ?)
    ORDER BY next_run_at, id`).all(d, d);
}

/**
 * 执行一条到期订阅：生成导出 + 投递记录 + 推进 next_run_at
 *
 * 幂等：跑完之后 next_run_at 一定严格大于本次执行日，重复调用 run-due 不会重复产出。
 */
function runSubscription(id, asOf) {
  const d = asOf || today();
  const sub = db.prepare('SELECT * FROM export_subscriptions WHERE id = ?').get(id);
  if (!sub) throw bad('订阅不存在', 404);
  if (sub.status !== 'active') throw bad(`订阅当前是「${DEF_STATUS[sub.status] || sub.status}」，不执行`);
  if (sub.valid_from > d) throw bad(`订阅从 ${sub.valid_from} 才生效`);
  if (sub.valid_until < d) {
    db.prepare("UPDATE export_subscriptions SET status='expired', next_run_at=NULL, updated_at=? WHERE id=?").run(now(), id);
    throw bad(`订阅已于 ${sub.valid_until} 到期，不再执行`);
  }

  const dr = defRow(sub.def_key);
  // 订阅执行时用「订阅人」的身份取数：他自己没权限的数据集不会被订阅绕过。
  // 所以要按订阅人当前岗位重新判一次权限（换岗后订阅该停就得停）。
  const owner = db.prepare('SELECT * FROM users WHERE username = ?').get(sub.owner) || {};
  const ownerUser = { sub: owner.id, username: owner.username, name: owner.name, role: owner.role };
  if (!canDo(ownerUser, dr.perm)) {
    throw bad(`订阅人「${sub.owner_name || sub.owner}」已没有「${dr.name}」的查看权限，订阅不再产出（请换人或停掉）`, 403);
  }

  const res = runExport({
    def_key: sub.def_key,
    params: safeJson(sub.params),
    reason: `订阅自动执行：${sub.name}`,
    trigger: 'subscription',
    user: ownerUser,
    ctx: { ip: null, ua: 'subscription-runner' },
    subscription_id: sub.id
  });

  const recips = safeJson(sub.recipients);
  const list = Array.isArray(recips) ? recips : Object.values(recips || {});
  const t = now();
  const deliveryIds = [];
  list.forEach((u) => {
    const blocked = sub.channel === 'email';
    const info = db.prepare(`INSERT INTO export_deliveries (job_id, subscription_id, recipient, channel,
        status, notify_note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      res.job.id, sub.id, u, sub.channel, blocked ? 'blocked' : 'pending',
      blocked ? '无邮件通道（未配 SMTP），到「我的订阅产出」领取后自行转发'
        : '在「我的订阅产出」可领取',
      t, t
    );
    deliveryIds.push(Number(info.lastInsertRowid));
  });

  const next = nextRunFor(sub.freq, sub.day_of_month, sub.day_of_week, d);
  const nextOk = next > sub.valid_until ? null : next;
  db.prepare(`UPDATE export_subscriptions SET next_run_at=?, last_run_at=?, last_job_id=?,
      run_count=run_count+1, status=?, updated_at=? WHERE id=?`).run(
    nextOk, d, res.job.id, nextOk ? 'active' : 'expired', t, sub.id
  );

  return {
    subscription: decorSub(db.prepare('SELECT * FROM export_subscriptions WHERE id = ?').get(sub.id)),
    job: res.job,
    row_count: res.rowsCount,
    delivery_ids: deliveryIds,
    channel: sub.channel,
    channel_note: sub.channel === 'email'
      ? '邮件通道未配置：投递状态标为「通道未配置」，文件在站内可取' : null
  };
}

/** 执行所有到期订阅（无后台调度器时由页面按钮或运维 cron 调这个接口） */
function runDue(asOf) {
  const d = asOf || today();
  const due = dueSubscriptions(d);
  const ok = [];
  const fail = [];
  due.forEach((s) => {
    try {
      const r = runSubscription(s.id, d);
      ok.push({ sub_no: s.sub_no, name: s.name, job_no: r.job.job_no, rows: r.row_count, next_run_at: r.subscription.next_run_at });
    } catch (e) {
      fail.push({ sub_no: s.sub_no, name: s.name, error: e.message });
      // 失败的订阅不要卡住队列：把 next_run_at 推到下一个周期，并在 note 里留痕
      const next = nextRunFor(s.freq, s.day_of_month, s.day_of_week, d);
      db.prepare('UPDATE export_subscriptions SET next_run_at=?, updated_at=? WHERE id=?')
        .run(next > s.valid_until ? null : next, now(), s.id);
    }
  });
  return { as_of: d, due_count: due.length, ok, failed: fail };
}

function listDeliveries(q = {}) {
  const cond = [];
  const args = [];
  if (q.mine && q.user) { cond.push('d.recipient = ?'); args.push(q.user); }
  if (q.status) { cond.push('d.status = ?'); args.push(q.status); }
  if (q.subscription_id) { cond.push('d.subscription_id = ?'); args.push(Number(q.subscription_id)); }
  const rows = db.prepare(`SELECT d.*, j.job_no, j.def_name, j.def_key, j.row_count, j.watermark, j.sensitivity,
      s.name AS sub_name, s.sub_no
    FROM export_deliveries d
    JOIN export_jobs j ON j.id = d.job_id
    LEFT JOIN export_subscriptions s ON s.id = d.subscription_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY d.id DESC LIMIT 200`).all(...args);
  return rows.map((r) => ({ ...r, status_label: DELIVERY_LABEL[r.status] || r.status, channel_label: CHANNEL_LABEL[r.channel] || r.channel }));
}

/** 领取（下载）订阅产出：只有收件人或有 export.audit 的人能下 */
function takeDelivery(id, user = {}) {
  const d = db.prepare('SELECT * FROM export_deliveries WHERE id = ?').get(id);
  if (!d) throw bad('投递记录不存在', 404);
  const isOwner = d.recipient === user.username;
  const isAuditor = canDo(user, 'export.audit');
  if (!isOwner && !isAuditor) throw bad('这条产出不是发给你的', 403);
  if (d.status === 'blocked') {
    // 通道没配不是错，但要说清楚：产出在这里，能下
    db.prepare("UPDATE export_deliveries SET status='pending', notify_note=? WHERE id=?")
      .run('邮件通道未配置，改为站内领取', id);
  }
  const t = now();
  db.prepare(`UPDATE export_deliveries SET download_count = download_count + 1,
      first_download_at = COALESCE(first_download_at, ?), last_download_at = ?, status='taken', updated_at=? WHERE id=?`)
    .run(t, t, t, id);

  // 内容实时重生成（不落文件）：源数据若已变化，哈希会不同，要在返回里说清
  const job = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(d.job_id);
  const defKey = job.def_key === 'legacy' ? null : job.def_key;
  let csv = null;
  let changed = null;
  if (defKey) {
    const built = buildContent(defKey, safeJson(job.params), user, {
      ctx: { user }, reason: job.reason, watermark: job.watermark,
      requester: job.requester, requester_name: job.requester_name
    });
    csv = built.csv;
    const hash = crypto.createHash('sha256').update(csv).digest('hex');
    changed = job.content_hash && hash !== job.content_hash;
  }
  return {
    delivery: { ...d, status: 'taken', status_label: DELIVERY_LABEL.taken },
    job,
    csv,
    fileName: job.file_name || `${job.job_no}.csv`,
    content_changed: changed,
    note: csv ? (changed
      ? '源数据在生成后发生了变化，这份内容是**重新取数**的结果，行数可能与记录里的不同 —— 记录里存的是当时那一刻'
      : '与生成时一致（内容哈希相同）') : '这条记录对应的数据集已下线，无法重新生成内容'
  };
}

function dict() {
  syncDefs();
  return {
    sensitivities: Object.entries(SENS_LABEL).map(([code, label]) => ({ code, label })),
    freqs: Object.entries(FREQ_LABEL).map(([code, label]) => ({ code, label })),
    channels: Object.entries(CHANNEL_LABEL).map(([code, label]) => ({ code, label })),
    sub_statuses: Object.entries(DEF_STATUS).map(([code, label]) => ({ code, label })),
    delivery_statuses: Object.entries(DELIVERY_LABEL).map(([code, label]) => ({ code, label })),
    users: db.prepare('SELECT username, name, role FROM users WHERE active = 1 ORDER BY id').all(),
    stats: stats()
  };
}

module.exports = {
  DEFS,
  syncDefs,
  listDefs,
  fetchRows,
  previewSample,
  buildContent,
  runExport,
  logExternal,
  listJobs,
  jobById,
  traceWatermark,
  stats,
  dict,
  saveSubscription,
  listSubscriptions,
  setSubStatus,
  dueSubscriptions,
  runSubscription,
  runDue,
  nextRunFor,
  suppressSmallSample,
  listDeliveries,
  takeDelivery,
  SENS_LABEL,
  DEF_STATUS,
  CHANNEL_LABEL
};
