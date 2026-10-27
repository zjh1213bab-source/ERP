/**
 * AI 能力中心演示数据（幂等重放）
 *   node scripts/seed-ai-demo.js --reset
 *
 * 造的内容：
 *   - 3 个模型供应商（规划中 / 待评审 / 已停用，都不带密钥 —— 演示「规则模式」下的真实表现）
 *   - 2 张需求抽取草稿 + 1 张客服答复草稿（1 张已核准，1 张待核准，1 张被驳回）
 *   - 3 条 FAQ（2 条已批准可被引用 / 1 条待批准）
 *   - 2 个接管会话（1 个 AI 处理中、1 个已被人工接管）
 *   - 跑一次风险扫描 + 一次全公司周报 + 一次评测（真实结果，不是编的）
 */
const { db } = require('../src/db');
const { localNow } = require('../src/services/sla');
const GW = require('../src/services/aiGateway');
const EXT = require('../src/services/aiExtract');
const RISK = require('../src/services/aiRisk');
const WEEK = require('../src/services/aiWeekly');
const EVAL = require('../src/services/aiEval');

const TAG = 'AI-DEMO';

const TEXTS = [
  `张先生你好，春季新款想订一批卫衣。款号 HS-2026-08，320gsm 棉质毛圈，
黑色和藏青两个色，S/100 M/200 L/200 XL/100 共 600 件，
要求做旧水洗 + 胸前绣花，单价 7.8 美金 FOB 宁波，
交期 2026-12-15，T/T 30% 定金，独立 OPP 包装。`,

  `Dear Lily，关于女式针织开衫：款号 LEJE-SY-001，260gsm 精梳棉，
米白和卡其两色，M/120 L/180 共 300 件，单面平纹不加印花，
单价 6.2 美金 CIF 洛杉矶，10 月底前出货。
（客户未提包装与付款方式，需追问）`
];

function reset() {
  db.prepare('DELETE FROM ai_drafts').run();
  db.prepare('DELETE FROM ai_faq').run();
  db.prepare('DELETE FROM ai_handovers').run();
  db.prepare('DELETE FROM ai_risks').run();
  db.prepare('DELETE FROM ai_weekly').run();
  db.prepare('DELETE FROM ai_eval_results').run();
  db.prepare('DELETE FROM ai_eval_runs').run();
  db.prepare('DELETE FROM ai_calls').run();
  db.prepare('UPDATE ai_providers SET used_amount=0').run();
}

function seqDraft(n) {
  const d = localNow().slice(0, 10).replace(/-/g, '');
  return `AID${d}${String(n).padStart(4, '0')}`;
}

function seedStatic() {
  const t = localNow();
  const out = [];

  // ---------- 需求草稿 ----------
  const insDraft = db.prepare(
    `INSERT INTO ai_drafts (draft_no,scene,source_type,source_id,source_label,payload,confidence,missing,
       status,reviewed_by,reviewed_at,review_note,applied_to,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  const b1 = EXT.buildDraft(TEXTS[0]);
  insDraft.run(seqDraft(1), 'requirement', 'mail', null, '客户邮件 · 张先生（卫衣询价）',
    JSON.stringify({ fields: b1.fields, missing: b1.missing, craft: b1.craft, summary: b1.summary, text_excerpt: TEXTS[0].slice(0, 300) }),
    b1.confidence, JSON.stringify(b1.missing), 'draft', null, null, null, null, 'seed', t, t);

  const b2 = EXT.buildDraft(TEXTS[1]);
  insDraft.run(seqDraft(2), 'requirement', 'mail', null, '客户邮件 · Lily（开衫询价）',
    JSON.stringify({ fields: b2.fields, missing: b2.missing, craft: b2.craft, summary: b2.summary, text_excerpt: TEXTS[1].slice(0, 300) }),
    b2.confidence, JSON.stringify(b2.missing), 'approved', 'admin', t,
    '已与技术确认，米白/卡其各 150 件', '已建开发单 KP202610270001', 'seed', t, t);
  out.push(`需求草稿 2 张（卫衣 把握度 ${Math.round(b1.confidence * 100)}% 待核准 / 开衫 ${Math.round(b2.confidence * 100)}% 已核准并带入开发单）`);

  // ---------- 客服答复草稿 ----------
  insDraft.run(seqDraft(3), 'reply', 'customer_question', null, '客户咨询 · 发货时间',
    JSON.stringify({
      question: '我这单什么时候能发货？',
      suggestion: '您好，您的订单已入库，我们会在 3 个工作日内安排出运，美国仓到仓约 25-35 天。具体船期确认后我们会把订舱信息发您。',
      faq_id: 1, faq_hit: true, order: null
    }), 0.9, '[]', 'rejected', 'sales01', t,
    '客户问的是具体船名航次，标准答复没覆盖，改成人工回复了', null, 'seed', t, t);
  out.push('客服答复草稿 1 张（已驳回：标准答复没覆盖具体船期）');

  // ---------- FAQ ----------
  const insFaq = db.prepare(
    `INSERT INTO ai_faq (question,answer,category,keywords,version,status,approved_by,approved_at,hit_count,created_by,created_at,updated_at)
     VALUES (?,?,?,?,1,?,?,?,?,?,?,?)`
  );
  insFaq.run('什么时候能发货？',
    '订单生产完成入库后 3 个工作日内安排出运；美国仓海运约 25-35 天，空运约 7-10 天。具体船期以订舱确认为准。',
    '物流', JSON.stringify(['发货', '出运', '什么时候到', '船期']), 'approved', 'admin', t, 3, 'sales01', t, t);
  insFaq.run('能不能便宜一点？',
    '价格按数量阶梯核算，500 件以上可申请 3%-5% 的让利，需要销售提交报价变更单并由财务复核，AI 与客服都不能直接改价。',
    '价格', JSON.stringify(['便宜', '折扣', '降价', '优惠']), 'approved', 'admin', t, 1, 'sales01', t, t);
  insFaq.run('可以改尺码比例吗？',
    '生产前可以调整，需在技术确认前提出；已开裁后不可更改。',
    '订单', JSON.stringify(['改尺码', '尺码比例', '加单']), 'draft', null, null, 0, 'sales01', t, t);
  out.push('FAQ 3 条（2 条已批准可引用 / 1 条待批准，自己写的不能自己批）');

  // ---------- 接管会话 ----------
  const insHo = db.prepare(
    `INSERT INTO ai_handovers (session_no,customer,channel,status,trigger_reason,question,taken_by,taken_at,closed_at,summary,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const d = localNow().slice(0, 10).replace(/-/g, '');
  insHo.run(`CS${d}0001`, '示范客户·美国 ABC', 'mall', 'human',
    '客户要求特殊工艺报价，AI 无法确认成本', '这款能不能做防水涂层？加多少钱？',
    'sales01', t, null, null, t);
  insHo.run(`CS${d}0002`, '示范客户·欧洲 DEF', 'mail', 'ai',
    '客户投诉上批货有色差', '上批到货颜色和样品差很多，怎么处理？', null, null, null, null, t);
  out.push('接管会话 2 个（1 个已接管 / 1 个 AI 处理中）');

  // ---------- 调用审计（演示：模型未接入时的真实状态就是「降级」与「拦截」） ----------
  const insCall = db.prepare(
    `INSERT INTO ai_calls (scene,sensitivity,provider_code,model,actor,prompt_digest,prompt_len,
       tokens_in,tokens_out,cost,latency_ms,status,reason,http_code,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const calls = [
    ['ask', 'internal', 'LLM-CN01', 'deepseek-chat', 'admin', 'a1b2c3d4e5f60718', 18, 0, 0, 0, 2, 'fallback',
      '无可用模型：供应商状态为「规划中」', null, 26],
    ['extract', 'internal', 'LLM-CN01', 'deepseek-chat', 'sales01', 'b2c3d4e5f6071829', 412, 0, 0, 0, 3, 'fallback',
      '无可用模型：供应商状态为「规划中」', null, 51],
    ['reply', 'internal', 'LLM-CN02', 'qwen-plus', 'sales01', 'c3d4e5f60718293a', 96, 0, 0, 0, 2, 'fallback',
      '未配置密钥（环境变量 AI_API_KEY_QWEN）', null, 74],
    ['ask', 'restricted', null, null, 'sales01', 'd4e5f60718293a4b', 12, 0, 0, 0, 1, 'blocked',
      '销售岗位无权查询「薪资与个人收入」，该数据只对 系统管理员 / 财务 开放。', null, 96],
    ['ask', 'internal', null, null, 'warehouse', 'e5f60718293a4b5c', 14, 0, 0, 0, 1, 'blocked',
      '「判定合格」属于高风险动作，AI 不能代为执行，只能给操作路径。', null, 118],
    ['weekly', 'restricted', 'LLM-CN01', 'deepseek-chat', 'admin', 'f60718293a4b5c6d', 1680, 0, 0, 0, 4, 'fallback',
      '数据级别够但未配置密钥（环境变量 AI_API_KEY）', null, 143]
  ];
  calls.forEach((c) => {
    insCall.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12], c[13],
      isoMinus(c[14]));
  });
  out.push('调用审计 6 条（4 条规则降级 + 2 条权限拦截，模型未接入时的真实状态）');

  return out;
}

/** 当前时间往前 n 分钟 */
function isoMinus(min) {
  const t = new Date(Date.now() - min * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

(async () => {
  const reset0 = process.argv.includes('--reset');
  if (reset0) { reset(); console.log('[reset] AI 演示数据已清空'); }

  GW.ensureDefaults();
  const lines = seedStatic();

  const risk = RISK.run('seed');
  lines.push(`风险扫描 ${risk.run_id}：共 ${risk.total} 条（高 ${risk.high} / 中 ${risk.mid} / 低 ${risk.low}），无人认领 ${risk.unowned} 条`);

  const wk = WEEK.generate({ scope: 'company', operator: 'seed' });
  lines.push(`周报 ${wk.week_no}：${wk.count} 人（${wk.from} ~ ${wk.to}）`);

  const ev = await EVAL.run({ operator: 'seed', mode: 'rule' });
  lines.push(`评测 ${ev.run_no}：通过 ${ev.passed}/${ev.total}，越权泄漏 ${ev.leak_cnt}，过拦 ${ev.over_block} → ${ev.gate_label}`);

  console.log('\n=== AI 能力中心演示数据 ===');
  lines.forEach((l) => console.log('·', l));
  console.log('\n供应商：');
  db.prepare('SELECT code,name,status,data_scope,key_env FROM ai_providers ORDER BY priority').all()
    .forEach((p) => console.log(`  ${p.code} ${p.name} [${p.status}] 数据级别=${p.data_scope} 密钥=${process.env[p.key_env] ? '已配' : '未配'}`));
  console.log('\n提示：没有配置模型密钥时全部按确定性规则运行，页面顶部会显示「规则模式」。');
})();
