/**
 * AI 权限守卫（确定性规则，先于模型）
 *
 * 为什么要单独一层：靠提示词让模型「不要回答别人的工资」是不可靠的，
 * 模型只要有一次听话就泄漏了。所以越权判定必须在调用模型之前用代码做完，
 * 模型只能看到被允许的问题。
 *
 * 三条硬线：
 *   1. 敏感主题 × 岗位：不在授权范围内的直接拦（薪资、成本毛利、供应商报价、他人绩效）
 *   2. 高危动作：改价、付款、发薪、审批、调额、删单 —— 一律拒绝执行，只给「怎么做」的指引
 *   3. 跨主体：问别的客户/别的公司 —— 拒绝，提示走正式授权
 */

/** 敏感主题定义：命中关键词即视为该主题 */
const TOPICS = [
  {
    code: 'payroll',
    name: '薪资与个人收入',
    words: ['工资', '薪水', '薪资', '月薪', '年薪', '发多少', '绩效奖金', '个税', '社保', '公积金', 'net_pay', 'netpay'],
    roles: ['admin', 'finance']
  },
  {
    code: 'kpi_other',
    name: '他人绩效与扣分',
    words: ['绩效分', '扣了多少分', '扣分', '评分', '考核结果', '绩效排名'],
    roles: ['admin', 'finance'],
    // 只有问自己时放行（见 selfOnly）
    selfOnly: true
  },
  {
    code: 'cost',
    name: '成本与毛利',
    words: ['成本', '毛利', '利润率', '净利', '出厂价', '报价成本', '赚多少', '盈亏'],
    roles: ['admin', 'finance']
  },
  {
    code: 'quote',
    name: '供应商报价与采购价',
    words: ['供应商报价', '采购价', '面料单价', '供方价格', '议价底价'],
    roles: ['admin', 'finance']
  },
  {
    code: 'bank',
    name: '银行账号与证件',
    words: ['银行卡', '账号', '开户行', '身份证', '护照号', '税号'],
    roles: ['admin', 'finance']
  }
];

/** 高危动作：AI 只能给指引，不能执行 */
const HIGH_RISK = [
  { code: 'pay', words: ['付款', '打款', '转账给', '付掉', '汇出去'], tip: '付款需财务在「往来账」发起付款单，由审批流批准后执行。' },
  { code: 'salary', words: ['发工资', '调薪', '涨工资', '扣他工资'], tip: '薪资调整需人事在「人事行政 → 工资」提交，经总经理审批。' },
  { code: 'price', words: ['改价', '降价', '给他打折', '调低价格', '免单'], tip: '价格调整需销售发起报价变更，客户确认后生效；AI 不能改价。' },
  { code: 'approve', words: ['帮我批准', '直接通过', '替我审批', '同意掉'], tip: '审批必须由有权限的人本人在「审批中心」操作，AI 不能代批。' },
  { code: 'credit', words: ['提额', '调额度', '放宽信用', '赊账给他'], tip: '信用额度调整需财务与总经理两级审批。' },
  { code: 'delete', words: ['删掉订单', '删除单据', '作废掉', '清空'], tip: '单据删除/作废需有权限的人操作并留痕；走反审或作废流程。' },
  { code: 'quality', words: ['判定合格', '给他过检', '放行这批'], tip: '质检判定必须质检员本人现场确认，AI 不能代判。' }
];

const ROLE_LABEL = {
  admin: '系统管理员', sales: '销售', tech: '技术', finance: '财务',
  production: '生产', warehouse: '仓库', qc: '质检'
};

const norm = (s) => String(s || '').toLowerCase();

/** 判断问题是否命中某个主题 */
function hitTopic(q) {
  const text = norm(q);
  for (const t of TOPICS) {
    for (const w of t.words) {
      if (text.includes(norm(w))) return { topic: t, word: w };
    }
  }
  return null;
}

function hitRisk(q) {
  const text = norm(q);
  for (const r of HIGH_RISK) {
    for (const w of r.words) {
      if (text.includes(norm(w))) return { risk: r, word: w };
    }
  }
  return null;
}

/**
 * 守卫入口
 * @param {string} query 用户问题
 * @param {object} user  { role, username, employee_id, name }
 * @returns {{blocked:boolean, code?:string, reason?:string, topic?:string, sensitivity:string, tip?:string}}
 */
function guard(query, user = {}) {
  const role = user.role || 'sales';
  const text = norm(query);

  // 1. 高危动作优先（即使是 admin 也不让 AI 执行）
  const hr = hitRisk(query);
  if (hr) {
    return {
      blocked: true,
      code: 'high_risk_action',
      reason: `「${hr.word}」属于高风险动作，AI 不能代为执行，只能给操作路径。`,
      topic: '动作',
      tip: hr.risk.tip,
      sensitivity: 'internal'
    };
  }

  // 2. 敏感主题 × 岗位
  const ht = hitTopic(query);
  if (ht) {
    const t = ht.topic;
    if (role !== 'admin' && !t.roles.includes(role)) {
      return {
        blocked: true,
        code: 'no_permission',
        reason: `${ROLE_LABEL[role] || role}岗位无权查询「${t.name}」，该数据只对 ${t.roles.map((r) => ROLE_LABEL[r] || r).join(' / ')} 开放。`,
        topic: t.name,
        tip: '如确因工作需要，请让有权限的同事在系统内查询后同步给你，或申请权限变更。',
        sensitivity: t.code === 'payroll' || t.code === 'kpi_other' ? 'restricted' : 'internal'
      };
    }
    // 他人绩效：只有 admin 能问别人，其他人只能问自己
    if (t.selfOnly && role !== 'admin') {
      const ownName = norm(user.name || user.username || '');
      const looksSelf = ownName && text.includes(ownName);
      const looksOther = /他|她|别人|同事|某某/.test(text);
      if (!looksSelf || looksOther) {
        return {
          blocked: true,
          code: 'no_permission',
          reason: '只能查看本人绩效；同事的绩效由人事在正式流程中沟通。',
          topic: t.name,
          tip: '在「岗位绩效」页可以看自己的评分明细与申诉入口。',
          sensitivity: 'restricted'
        };
      }
    }
    return { blocked: false, topic: t.name, sensitivity: t.code === 'payroll' || t.code === 'kpi_other' ? 'restricted' : 'internal' };
  }

  // 3. 跨主体：其他客户的数据
  const cross = /(其他客户|别的客户|竞争对手|他们家的订单|那家客户的订单)/.test(text);
  if (cross) {
    return {
      blocked: true,
      code: 'cross_subject',
      reason: '不能查询其他客户的数据，客户之间按合同隔离。',
      topic: '客户隔离',
      tip: '客户只能看自己的订单与报价；内部人员查客户数据请在客户档案内查看。',
      sensitivity: 'internal'
    };
  }

  return { blocked: false, sensitivity: 'internal' };
}

/** 脱敏：把答案里出现的长数字（金额/账号）替换掉，用于兜底展示 */
function redact(text) {
  return String(text || '')
    .replace(/\b\d{15,19}\b/g, '****')
    .replace(/(\d{4})\d{6,}(\d{4})/g, '$1****$2');
}

module.exports = { guard, redact, TOPICS, HIGH_RISK, ROLE_LABEL };
