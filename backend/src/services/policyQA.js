/**
 * 制度问答（M17 N17-02 剩余项）
 * ============================================================
 * 核心要求只有一句：**答案要带制度原文的版本与生效日期**。
 *
 * 为什么不能交给模型：
 *   「报销能报多少」「请假几天要谁批」这类问题，模型最擅长的就是**编一个看起来很像的答案**。
 *   一旦员工按编的条款去报销、请假，错在系统不在人。所以这里的做法是：
 *     1) 检索**只取现行有效版本**（status='effective' 且 version = current_version）
 *     2) 摘录**只从原文里切句子**，不改写、不概括数字
 *     3) 引用行（文号 / 版本 / 生效日期 / 责任人）**由服务端拼**，不经过模型
 *     4) 没有生效制度就**明确说没有**，并把草稿/已废止的列出来并标明「不能作为依据」
 *
 * 模型只负责把原文句子串成通顺的话；串错了也不影响引用行与原文摘录——这两段是硬拼上去的。
 *
 * 验收口径：
 *   - 引用必须同时有 version 与 effective_date，缺一不返回
 *   - 草稿（draft/pending）与已废止（retired）**一律不作为依据**
 *   - 同一制度改版后，旧引用能被标成 outdated（`GET /api/ai/policy/hits`）
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');
const GW = require('./aiGateway');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 问句里的口水词：不参与匹配，否则「请问怎么」会命中所有制度 */
const NOISE = [
  '请问', '想问一下', '想问', '我想知道', '想知道', '帮我查', '查一下', '看一下',
  '怎么样', '怎么', '怎样', '如何', '什么', '哪些', '哪个', '多少', '几天', '多久',
  '我们', '公司', '现在', '可以', '能不能', '需不需要', '要不要', '是不是', '有没有',
  '应该', '一般', '具体', '吗', '呢', '的', '了'
];

/**
 * 纯虚词：一个 bigram 里两个字都是虚词就丢掉。
 * 「要谁」「么办」这种词在任何制度原文里都不会出现，留在分母里只会把覆盖率拖垮
 * （问「请假三天要谁批」时，覆盖率会被「要谁」这种词拉到 33%，明明该命中却判不中）。
 * 注意不能把「请」「假」「标」「准」这类业务字放进来 —— 那会把「请假」「标准」整个词废掉。
 */
const STOP_CHARS = new Set('要谁吗呢么怎办如何几多少可否能不该吗哎嗯哦'.split(''));

const CAT_LABEL = { sop: '岗位SOP', policy: '制度', rule: '规定' };
const STATUS_LABEL = {
  draft: '草稿', pending: '待批', effective: '现行有效', retired: '已废止'
};

/**
 * 归一化：去空白/标点，并把「三天」「十万」这类中文数字换成阿拉伯数字。
 * 不换的话「请假三天」永远匹配不上原文里的「3 天」，覆盖率直接掉一半。
 */
const CN_DIGIT = { 零: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
function norm(s) {
  return String(s || '')
    .replace(/[\s，。、；：？！,.;:?!（）()【】\[\]“”"'’‘\/\\]/g, '')
    .replace(/([零一二两三四五六七八九十])(天|个工作日|工作日|次|小时|万|元|件|人|%)/g, (m, c, u) => (CN_DIGIT[c] || c) + u);
}

/** 中文没有分词器，用 2-gram 做近似匹配：问句与原文的重合度足够高就算命中 */
function bigrams(s) {
  let t = norm(s);
  NOISE.forEach((w) => { t = t.split(w).join(''); });
  const out = [];
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    if (STOP_CHARS.has(bg[0]) && STOP_CHARS.has(bg[1])) continue;
    out.push(bg);
  }
  if (!t) return [];
  if (t.length === 1 && !STOP_CHARS.has(t)) out.push(t);
  return out;
}

/** 原文切句：引用要能一眼看到是哪一句，不是整段糊上去 */
function sentences(text) {
  return String(text || '')
    .split(/[。；;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function currentVersion(doc) {
  if (!doc || !doc.current_version) return null;
  return db.prepare('SELECT * FROM sop_versions WHERE doc_id=? AND version=?')
    .get(doc.id, doc.current_version) || null;
}

function shapeDoc(doc, ver) {
  const v = ver || currentVersion(doc);
  return {
    id: doc.id,
    doc_no: doc.doc_no,
    title: doc.title,
    category: doc.category,
    category_label: CAT_LABEL[doc.category] || doc.category,
    position: doc.position,
    owner: doc.owner,
    status: doc.status,
    status_label: STATUS_LABEL[doc.status] || doc.status,
    version: v ? v.version : null,
    current_version: doc.current_version,
    effective_date: doc.effective_date,
    approved_by: doc.approved_by,
    updated_at: doc.updated_at,
    doing: v ? v.doing : null,
    inputs: v ? v.inputs : null,
    done_criteria: v ? v.done_criteria : null,
    escalate_path: v ? v.escalate_path : null,
    change_note: v ? v.change_note : null
  };
}

/** ==================== 检索 ==================== */

/**
 * 打分：标题命中权重大（问「请假」应该先命中《考勤与请假制度》，而不是正文里顺带提了一句「请假」的报销制度）。
 * 返回 coverage = 问句 bigram 被覆盖的比例，用作「命中是否可信」的判断。
 */
function scoreDoc(qb, doc, ver) {
  const title = norm(`${doc.title} ${doc.position || ''} ${CAT_LABEL[doc.category] || ''}`);
  const body = norm([ver && ver.doing, ver && ver.inputs, ver && ver.done_criteria, ver && ver.escalate_path]
    .filter(Boolean).join('；'));
  let titleHit = 0, bodyHit = 0;
  const hits = [];
  qb.forEach((b) => {
    if (title.indexOf(b) >= 0) { titleHit++; hits.push(b); }
    else if (body.indexOf(b) >= 0) { bodyHit++; hits.push(b); }
  });
  const coverage = qb.length ? (titleHit + bodyHit) / qb.length : 0;
  return { score: titleHit * 3 + bodyHit, coverage: r2(coverage * 100), titleHit, bodyHit, hits };
}

/** 从原文里挑出**含命中词**的句子，作为直接引用（不改写） */
function excerptOf(ver, hits, q) {
  if (!ver) return [];
  // 问句里带数字也算「问数」（「付款 30 万要谁批」没有「多少/标准」字样，但显然在问档位）
  const wantNumber = /多少|几|标准|金额|上限|天数|小时|比例|%/.test(String(q || '')) || /\d/.test(String(q || ''));
  // 问句里的「数字+单位」：问 3 天就该先给 3 天那条；问 30 万不能被 30% 蹭上
  const wantNums = (String(q || '').match(/\d+(?:\.\d+)?\s*(?:万|元|天|个工作日|工作日|次|小时|%|件)?/g) || [])
    .map((x) => x.replace(/\s/g, ''))
    .filter((x) => x.length > 1);
  const fields = [
    ['做法', ver.doing], ['输入', ver.inputs], ['完成标准', ver.done_criteria], ['升级路径', ver.escalate_path]
  ];
  // 档位问题（金额/天数）：问 30 万时，真正管用的是「20 万元以上报总经理」这一档，
  // 而不是「5 万元以内」。所以算出「不超过问句数值的最大档」，给它加权。
  const NUM_RE = /(\d+(?:\.\d+)?)\s*(万|元|天|个工作日|工作日|%|次|小时|件)/g;
  const maxSameUnit = {};
  fields.forEach(([, text]) => {
    let m;
    const re = new RegExp(NUM_RE.source, 'g');
    while ((m = re.exec(String(text || ''))) !== null) {
      const u = m[2];
      maxSameUnit[u] = Math.max(maxSameUnit[u] || 0, Number(m[1]));
    }
  });
  // 单位可能不写（「报销 8000 谁批」），所以单位部分可选；没写单位时按全篇同数值比较
  const wantPair = (String(q || '').match(/(\d+(?:\.\d+)?)\s*(万|元|天|个工作日|工作日|%|次|小时|件)?/) || []);
  const wantVal = wantPair[1] ? Number(wantPair[1]) : null;
  const wantUnit = wantPair[2] || null;
  // 问句数值超过所有档位时（问 100 万），取最高档
  const tierOf = (txt) => {
    if (wantVal === null) return null;
    let best = null;
    let m;
    const re = new RegExp(NUM_RE.source, 'g');
    while ((m = re.exec(String(txt || ''))) !== null) {
      if (wantUnit && m[2] !== wantUnit) continue;
      const v = Number(m[1]);
      if (v > wantVal) continue;
      if (best === null || v > best) best = v;
    }
    if (best === null) {
      const re2 = new RegExp(NUM_RE.source, 'g');
      let min = null;
      while ((m = re2.exec(String(txt || ''))) !== null) {
        if (wantUnit && m[2] !== wantUnit) continue;
        const v = Number(m[1]);
        if (min === null || v < min) min = v;
      }
      best = min;
    }
    return best;
  };
  // 目标档位：全文里不超过问句数值的最大一档
  let tierOfGoal = null;
  if (wantVal !== null && (wantUnit ? maxSameUnit[wantUnit] !== undefined : Object.keys(maxSameUnit).length)) {
    let best = null;
    fields.forEach(([, text]) => {
      let m;
      const re = new RegExp(NUM_RE.source, 'g');
      while ((m = re.exec(String(text || ''))) !== null) {
        if (wantUnit && m[2] !== wantUnit) continue;
        const v = Number(m[1]);
        if (v > wantVal) continue;
        if (best === null || v > best) best = v;
      }
    });
    if (best !== null) tierOfGoal = best;
  }

  const picked = [];
  fields.forEach(([label, text], fi) => {
    sentences(text).forEach((s, si) => {
      const hit = hits.some((b) => s.indexOf(b) >= 0);
      const hasNum = /\d/.test(s);
      if (!hit && !(wantNumber && hasNum)) return;
      const sameNum = wantNums.some((n) => s.replace(/\s/g, '').indexOf(n) >= 0);
      const tierHit = tierOf(s) !== null && tierOfGoal !== null && tierOf(s) === tierOfGoal;
      picked.push({
        field: label, text: s, has_number: hasNum, matched: hit,
        w: (sameNum ? 4 : 0) + (tierHit ? 3 : 0) + (hit ? 2 : 0) + (hasNum ? 1 : 0),
        ord: fi * 100 + si
      });
    });
  });
  // 先按「问句数字对上」→「命中」→「带数字」，同分按原文顺序，最多 3 条
  picked.sort((a, b) => b.w - a.w || a.ord - b.ord);
  return picked.slice(0, 3).map(({ field, text, has_number, matched }) => ({ field, text, has_number, matched }));
}

/**
 * 检索制度。
 * @param {string} q 问题
 * @param {{include_invalid?:boolean, limit?:number, position?:string}} opt
 */
function search(q, opt = {}) {
  const qb = bigrams(q);
  if (!qb.length) return { question: q, hits: [], invalid: [], confidence: 0, reason: '问题太短，无法检索' };

  const docs = db.prepare(
    `SELECT * FROM sop_documents WHERE status ${opt.include_invalid ? 'IN' : '='} ${
      opt.include_invalid ? "('effective','pending','draft','retired')" : "'effective'"
    } ORDER BY id`
  ).all();

  const scored = [];
  docs.forEach((d) => {
    const ver = currentVersion(d);
    const s = scoreDoc(qb, d, ver);
    if (!s.score) return;
    scored.push({ doc: d, ver, ...s });
  });
  scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage);

  const valid = scored.filter((x) => x.doc.status === 'effective' && x.ver);
  // 可信门槛：标题得有命中，且问句覆盖度 ≥ 34%；否则宁可不答
  // 命中门槛：① 标题命中且覆盖 ≥34%；② 或正文命中 ≥2 处且覆盖 ≥40%
  // （「年假」只出现在正文没在标题里，按①会漏，按②能中）
  const hits = valid
    .filter((x) => (x.titleHit >= 1 && x.coverage >= 34) || (x.bodyHit >= 2 && x.coverage >= 40))
    .slice(0, opt.limit || 3);
  const weak = valid.filter((x) => !hits.includes(x)).slice(0, 2);
  const invalid = scored.filter((x) => x.doc.status !== 'effective').slice(0, 3);

  return {
    question: q,
    hits: hits.map((x) => ({
      ...shapeDoc(x.doc, x.ver),
      score: x.score,
      coverage: x.coverage,
      excerpt: excerptOf(x.ver, x.hits, q)
    })),
    weak: weak.map((x) => ({ doc_no: x.doc.doc_no, title: x.doc.title, coverage: x.coverage, version: x.ver.version })),
    invalid: invalid.filter((x, i, arr) => arr.findIndex((y) => y.doc.title === x.doc.title) === i).map((x) => ({
      doc_no: x.doc.doc_no, title: x.doc.title,
      status: x.doc.status, status_label: STATUS_LABEL[x.doc.status] || x.doc.status,
      version: x.doc.current_version, effective_date: x.doc.effective_date,
      retire_reason: x.doc.retire_reason
    })),
    confidence: hits.length ? (hits[0].coverage >= 60 ? 'high' : 'medium') : 0,
    reason: hits.length ? null : '没有找到现行有效的制度条款'
  };
}

/** ==================== 引用行 ==================== */

/**
 * 引用行由服务端拼死：文号 + 版本 + 生效日期 + 责任人 + 适用范围。
 * 这段**不交给模型写**——模型少写一个日期，答案就成了「无主条款」。
 */
function citeLine(d) {
  const parts = [`《${d.title}》V${d.version}`];
  parts.push(`（${d.doc_no}）`);
  parts.push(`${d.effective_date || '未填生效日'} 生效`);
  if (d.owner) parts.push(`责任人 ${d.owner}`);
  if (d.position) parts.push(`适用 ${d.position}`);
  return parts.join('，');
}

function versionNote(docId, currentVer, citedVer) {
  if (!currentVer || !citedVer || currentVer === citedVer) return null;
  const rows = db.prepare('SELECT version, status FROM sop_versions WHERE doc_id=? ORDER BY version').all(docId);
  return {
    current_version: currentVer,
    cited_version: citedVer,
    history: rows
  };
}

/** 有没有可用模型：没配密钥就直接走规则，不要为此写一条失败调用 */
function gwReady() {
  try { return !!GW.overview().has_any_key; } catch (e) { return false; }
}

/** ==================== 作答 ==================== */

/**
 * 制度问答。
 * 返回结构固定：answer（文字）+ citations（必须带版本与日期）+ basis（原文摘录）
 */
async function ask(q, user, opt = {}) {
  const found = search(q, { include_invalid: true });
  const today = localDate();

  // 没有生效制度：明确拒答，但把「为什么没有」说清楚
  if (!found.hits.length) {
    const lines = ['【查不到可引用的制度】这次没有找到与该问题匹配的「现行有效」制度，所以不能给出条款式答复。'];
    if (found.invalid.length) {
      lines.push('');
      lines.push('相关的制度目前状态如下（不能作为执行依据）：');
      found.invalid.forEach((x) => {
        lines.push(`· 《${x.title}》${x.status_label}${x.version ? ' V' + x.version : ''}${x.effective_date ? '，原生效日 ' + x.effective_date : ''}${x.retire_reason ? '，废止原因：' + x.retire_reason : ''}`);
      });
    }
    if (found.weak.length) {
      lines.push('');
      lines.push('另有沾边但不够具体的制度：' + found.weak.map((x) => `《${x.title}》V${x.version}`).join('、') + '，可点进去自己看原文。');
    }
    lines.push('');
    lines.push('建议：在「流程与制度」里确认对应制度是否已发布生效，或直接问制度责任人。');
    return {
      answer: lines.join('\n'),
      citations: [],
      basis: [],
      confidence: 'none',
      answerable: false,
      reason: found.reason,
      invalid: found.invalid,
      weak: found.weak,
      generated_by: 'rule'
    };
  }

  const top = found.hits[0];
  const citations = found.hits.map((d) => ({
    doc_no: d.doc_no,
    title: d.title,
    category: d.category,
    category_label: d.category_label,
    version: d.version,
    effective_date: d.effective_date,
    owner: d.owner,
    position: d.position,
    coverage: d.coverage,
    cite: citeLine(d),
    // 只要命中文件里有任何一个缺版本或生效日，就标 not_citable，前端会红着显示
    citable: !!(d.version && d.effective_date),
    updated_at: d.updated_at
  }));

  const basis = [];
  found.hits.forEach((d) => {
    d.excerpt.forEach((e) => basis.push({ doc_no: d.doc_no, title: d.title, version: d.version, field: e.field, text: e.text }));
  });

  const head = `【${top.title}】V${top.version}（${top.category_label}）`;
  let body;
  let generatedBy = 'rule';

  // 有模型就让模型把原文串通顺；串错了下面还会贴原文，不影响依据
  if (opt.use_model !== false && gwReady()) {
    const prompt = [
      `问题：${q}`,
      '下面是系统检索到的制度原文句子（唯一可用依据，不能补充任何未出现的数字或条件）：',
      ...basis.map((b, i) => `${i + 1}. 〔${b.title} V${b.version} · ${b.field}〕${b.text}`),
      '',
      '要求：用简体中文 2-4 句回答，只能使用上面原文里出现的条件、金额、天数、岗位；不要写「根据规定」这类空话，不要自己编条款；不要在末尾加引用（系统会自动加）。'
    ].join('\n');
    const ai = await GW.call({
      scene: 'ask', actor: (user && user.username) || 'system',
      system: '你是企业制度问答助手。只能依据给定的制度原文回答，原文没有的内容一律回答「制度未写明」。不得编造条款、金额或审批层级。',
      prompt, maxTokens: 320
    });
    if (ai.ok && ai.answer) {
      body = String(ai.answer).trim();
      generatedBy = ai.source || 'model';
    }
  }

  if (!body) {
    // 规则式兜底：直接把命中原文摆出来，不做概括（概括容易丢条件）
    body = basis.length
      ? basis.map((b, i) => `${i + 1}. ${b.text}`).join('\n')
      : '制度原文里没有可直接引用的句子，请点开原文核对。';
    generatedBy = 'rule';
  }

  const stale = versionNote(top.id, top.current_version, top.version);
  const lines = [head, body, '', '——引用：' + citations.map((c) => c.cite).join('；')];
  if (stale && stale.current_version !== stale.cited_version) {
    lines.push(`注意：该制度现行版本为 V${stale.current_version}，本次引用 V${stale.cited_version}，请以现行版本为准。`);
  }
  if (found.invalid.length) {
    lines.push(`另：${found.invalid.map((x) => `《${x.title}》${x.status_label}`).join('、')}，不作为依据。`);
  }

  return {
    answer: lines.join('\n'),
    citations,
    basis,
    confidence: found.confidence,
    answerable: true,
    as_of: today,
    generated_by: generatedBy,
    invalid: found.invalid,
    weak: found.weak
  };
}

/** 落引用留痕：以后制度改版了，能查出哪些回答引的是旧版 */
function logHits(question, result, actor) {
  if (!result || !result.citations || !result.citations.length) return { saved: 0 };
  const now = localNow();
  let n = 0;
  result.citations.forEach((c, i) => {
    const doc = db.prepare('SELECT id FROM sop_documents WHERE doc_no=?').get(c.doc_no);
    if (!doc) return;
    db.prepare(
      `INSERT INTO ai_policy_hits (question,doc_id,doc_no,title,version,effective_date,owner,coverage,rank,
         answer_generated_by,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(question, doc.id, c.doc_no, c.title, c.version, c.effective_date, c.owner, c.coverage, i + 1,
      result.generated_by || 'rule', actor || 'system', now);
    n++;
  });
  return { saved: n };
}

/** 引用留痕列表：标出「引用了旧版」的记录 */
function hits(q = {}) {
  const wh = [];
  const args = [];
  if (q.actor) { wh.push('h.actor=?'); args.push(q.actor); }
  if (q.doc_no) { wh.push('h.doc_no=?'); args.push(q.doc_no); }
  const limit = Math.min(200, Number(q.limit) || 50);
  const rows = db.prepare(
    `SELECT h.*, d.current_version, d.status AS doc_status, d.effective_date AS cur_effective_date
     FROM ai_policy_hits h LEFT JOIN sop_documents d ON d.id=h.doc_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY h.id DESC LIMIT ?`
  ).all(...args, limit);
  return rows.map((r) => ({
    ...r,
    outdated: !!(r.current_version && r.version < r.current_version),
    status_label: STATUS_LABEL[r.doc_status] || r.doc_status
  }));
}

/** 按文号取现行版本（含历史版本，方便对比改了哪几条） */
function docByNo(no) {
  const doc = db.prepare('SELECT * FROM sop_documents WHERE doc_no=?').get(String(no || '').trim());
  if (!doc) return null;
  const versions = db.prepare('SELECT * FROM sop_versions WHERE doc_id=? ORDER BY version DESC').all(doc.id);
  return {
    ...shapeDoc(doc),
    versions: versions.map((v) => ({ ...v })),
    current: versions.find((v) => v.version === doc.current_version) || null,
    acks: db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id=? AND version=?')
      .get(doc.id, doc.current_version).c
  };
}

/** 最近改过版的现行制度（问答页右侧「最近更新」） */
function recent(limit = 6) {
  return db.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM sop_versions v WHERE v.doc_id=d.id) AS version_cnt
     FROM sop_documents d WHERE d.status='effective'
     ORDER BY COALESCE(d.effective_date,'') DESC, d.id DESC LIMIT ?`
  ).all(Math.min(20, Number(limit) || 6)).map((d) => ({
    ...shapeDoc(d),
    version_cnt: d.version_cnt
  }));
}

module.exports = {
  search, ask, hits, logHits, docByNo, recent,
  bigrams, citeLine, CAT_LABEL, STATUS_LABEL
};
