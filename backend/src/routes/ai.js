/**
 * AI 问答（OpenAI 兼容接口）
 * POST /api/ai/chat { message }
 * 环境变量：
 *   AI_API_KEY   必填，没有则回退「规则式查数」回答（真实查库，不是套话）
 *   AI_BASE_URL  默认 https://api.openai.com/v1
 *   AI_MODEL     默认 gpt-4o-mini
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');
const { answerQuery } = require('./assistant');

const router = express.Router();

function buildContext() {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const orders = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total_amount),0) amt FROM orders').get();
  const monthAgg = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(total_amount),0) amt FROM orders WHERE substr(created_at,1,7)=?'
  ).get(month);
  const overdue = db.prepare(
    "SELECT COUNT(*) c FROM orders WHERE delivery_date IS NOT NULL AND delivery_date<? AND status NOT IN ('shipped','closed','cancelled')"
  ).get(today).c;
  const techPending = db.prepare("SELECT COUNT(*) c FROM tech_packs WHERE status='draft'").get().c;
  const costPending = db.prepare("SELECT COUNT(*) c FROM cost_sheets WHERE status='pending'").get().c;
  const inProd = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('assigned','production')").get().c;
  const stockCn = db.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE warehouse='cn'").get().q;
  const stockUs = db.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE warehouse='us'").get().q;
  const monthExpense = db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM admin_expenses WHERE substr(expense_date,1,7)=?'
  ).get(month).s;
  const monthPayroll = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(net_pay),0) s FROM payrolls WHERE period=?'
  ).get(month);

  return {
    today, month,
    orders: Number(orders.c), orderAmount: Number(orders.amt),
    monthOrders: Number(monthAgg.c), monthAmount: Number(monthAgg.amt),
    overdue: Number(overdue), techPending: Number(techPending), costPending: Number(costPending),
    inProd: Number(inProd), stockCn: Number(stockCn), stockUs: Number(stockUs),
    monthExpense: Number(monthExpense),
    monthPayrollCount: Number(monthPayroll.c), monthPayrollNet: Number(monthPayroll.s)
  };
}

/** 把结构化查询结果转成纯文本（供无大模型时使用） */
function renderQueryText(r) {
  const lines = [`【${r.title}】`, r.summary];
  if (r.rows && r.rows.length) {
    const cols = r.columns || [];
    const head = cols.map((c) => c.label).join(' | ');
    lines.push('', head);
    r.rows.slice(0, 8).forEach((row) => {
      lines.push(cols.map((c) => (row[c.key] === undefined || row[c.key] === null ? '-' : row[c.key])).join(' | '));
    });
    if (r.rows.length > 8) lines.push(`… 共 ${r.rows.length} 条，展开看下方表格`);
  }
  if (r.links && r.links.length) lines.push('', '入口：' + r.links.map((l) => l.text + '（' + l.to + '）').join('　'));
  return lines.join('\n');
}

router.post('/chat', authRequired, wrap(async (req, res) => {
  const { message } = req.body || {};
  if (!message) return fail(res, 400, '请输入问题');

  // 先跑规则引擎：既能单独作答，也能给大模型做「事实底稿」
  let grounded = null;
  try { grounded = answerQuery(message); } catch (e) { grounded = null; }

  const key = process.env.AI_API_KEY;
  const ctx = buildContext();

  if (!key) {
    const text = grounded ? renderQueryText(grounded) : '没听懂这个问题。可以问：SO202610260001、逾期订单、美仓缺货、库存、本月工资、行政费用、报价单、在产订单、固定资产。';
    return ok(res, { answer: text, source: 'rule', data: grounded });
  }

  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const groundedText = grounded
    ? `\n\n以下是系统按该问题实时查库得到的结构化结果（以此为准，不要改动数字）：\n${JSON.stringify({ title: grounded.title, summary: grounded.summary, columns: grounded.columns, rows: grounded.rows.slice(0, 20) })}`
    : '';
  const system = `你是跳色科技 ERP 的助手。用简体中文、简洁回答，最多 6 行。系统实时概况：${JSON.stringify(ctx)}。${groundedText}\n涉及具体操作时给出页面路径（如 /orders、/production、/inventory）。数字只能引用上面给的数据，不要编造。`;

  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: String(message) }
        ],
        temperature: 0.2
      })
    });
    const j = await r.json();
    const answer = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!answer) {
      return ok(res, { answer: renderQueryText(grounded || { title: '系统概况', summary: '无结果' }), source: 'rule', data: grounded });
    }
    return ok(res, { answer, source: 'ai', data: grounded });
  } catch (e) {
    const fallback = grounded ? renderQueryText(grounded) : 'AI 调用失败，且未匹配到可查询的主题。';
    return ok(res, { answer: fallback + '\n（AI 调用失败：' + e.message + '）', source: 'rule', data: grounded });
  }
}));

module.exports = router;
