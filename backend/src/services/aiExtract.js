/**
 * 需求抽取与工艺辅助（M17 N17-03）
 *
 * 原则：AI 只产出「待人工核准草稿」，数值/尺寸/公差一律由技术确认。
 * 所以这里做的事是：
 *   1. 从外贸询价文本里抽结构化字段（款号/颜色/尺码数量/交期/面料/工艺/价格/条款）
 *   2. 每个字段都带 evidence（原文片段）和 confidence（把握度）
 *   3. 抽不到的必填项列进 missing，明确告诉业务「这几项要去问客户」
 *   4. 顺带给工艺建议（按面料+工艺推工序），但只是建议，不是下单依据
 *
 * 有模型时会让模型补充规则抽不到的语义信息（如「做旧感」这类描述），
 * 但**规则结果优先**：模型只填空缺，不改规则已确定的数值。
 */

const COLORS = [
  '黑色', '白色', '米白', '藏青', '宝蓝', '深蓝', '浅蓝', '天蓝', '灰色', '深灰', '浅灰',
  '红色', '酒红', '粉色', '卡其', '驼色', '棕色', '咖啡', '绿色', '军绿', '墨绿', '黄色', '紫色', '橙色',
  'black', 'white', 'navy', 'blue', 'grey', 'gray', 'red', 'pink', 'khaki', 'brown', 'green', 'beige'
];

const FABRICS = [
  ['针织棉', /针织棉|单面布|汗布/], ['卫衣布', /卫衣布|毛圈|fleece/i], ['华夫格', /华夫格|waffle/i],
  ['涤纶', /涤纶|聚酯|polyester/i], ['锦纶', /锦纶|尼龙|nylon/i], ['棉', /纯棉|全棉|^棉|100%\s*cotton|cotton/i],
  ['羊毛', /羊毛|wool/i], ['真丝', /真丝|桑蚕丝|silk/i], ['氨纶', /氨纶|弹力|spandex|elasthan/i],
  ['牛仔', /牛仔|denim/i], ['灯芯绒', /灯芯绒|corduroy/i], ['法兰绒', /法兰绒|flannel/i],
  ['摇粒绒', /摇粒绒|polar fleece/i], ['雪纺', /雪纺|chiffon/i], ['蕾丝', /蕾丝|lace/i]
];

const CRAFTS = [
  ['印花', /印花|print/i], ['绣花', /绣花|刺绣|embroidery/i], ['水洗', /水洗|洗水|wash/i],
  ['压皱', /压皱|褶皱|pleat/i], ['涂层', /涂层|coating/i], ['烫钻', /烫钻|烫图|rhinestone/i],
  ['撞色', /撞色|拼色|contrast/i], ['包边', /包边|binding/i], ['绗缝', /绗缝|quilt/i],
  ['激光切割', /激光|laser/i], ['做旧', /做旧|复古洗|vintage/i], ['免烫', /免烫|抗皱/i]
];

const TRADE_TERMS = ['FOB', 'CIF', 'CFR', 'EXW', 'DDP', 'DAP', 'FCA'];
const SIZE_TOKEN = /(?:^|[\s,，、/])((?:XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL|\d{2,3}(?:码)?))(?=\s*[/:：]?\s*\d)/gi;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function ev(text, index, len) {
  const s = Math.max(0, index - 12);
  return '…' + text.slice(s, Math.min(text.length, index + len + 16)).replace(/\s+/g, ' ').trim() + '…';
}

/** 从文本抽字段 */
function extractFields(text) {
  const raw = String(text || '');
  const t = raw.replace(/\r/g, '');
  const fields = [];
  const push = (key, label, value, confidence, evidence, extra) =>
    fields.push({ key, label, value, confidence, evidence, ...(extra || {}) });

  // 款号：STYLE NO / 款号 / 货号 后的编号，或明显带连字符的款号
  let m = t.match(/(?:款号|货号|style\s*no\.?|item\s*no\.?|art\.?\s*no\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,24})/i);
  if (!m) m = t.match(/\b([A-Z]{2,6}-[A-Z0-9]{2,8}(?:-[A-Z0-9]{1,6})?)\b/);
  if (m) push('style_no', '款号', m[1].toUpperCase(), 0.92, ev(t, m.index, m[0].length));

  // 品名
  m = t.match(/(?:品名|款式|产品名称|品項)\s*[:：]?\s*([^\n，,。;；]{2,30})/);
  if (!m) {
    const guess = t.match(/([^\s，,。;；]{0,8}(?:T恤|卫衣|衬衫|裤子|外套|连衣裙|背心|裙子|短裤|夹克|开衫|马甲|毛衣|大衣|polo))/i);
    if (guess) {
      // 抓到的常带口语句首（「我们要订一批卫衣」），剥掉客套与动词只留品名
      const name = stripLead(guess[1]);
      push('product_name', '品名', name, name.length <= 6 ? 0.72 : 0.6, ev(t, guess.index, guess[0].length));
    }
  } else {
    push('product_name', '品名', m[1].trim(), 0.88, ev(t, m.index, m[0].length));
  }

  // 颜色
  const colors = [];
  COLORS.forEach((c) => {
    const re = new RegExp(c, 'i');
    const hit = t.match(re);
    if (hit && !colors.some((x) => x.toLowerCase() === c.toLowerCase())) colors.push(c);
  });
  if (colors.length) push('colors', '颜色', colors, 0.85, '');

  // 尺码 + 数量（S/100 M/200 ...）
  const sizeMap = [];
  let sm;
  SIZE_TOKEN.lastIndex = 0;
  const re = /((?:XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL))(?=\s*[/:：]?\s*(\d{1,5}))\s*[/:：]?\s*(\d{1,5})/gi;
  while ((sm = re.exec(t)) !== null) {
    sizeMap.push({ size: sm[1].toUpperCase(), qty: Number(sm[3]) });
  }
  if (sizeMap.length) {
    push('size_breakdown', '尺码数量', sizeMap, 0.9, '', { sum: sizeMap.reduce((a, b) => a + b.qty, 0) });
  }

  // 总数量
  m = t.match(/(?:共|合计|总共|total)\s*[:：]?\s*(\d{2,7})\s*(?:件|个|pcs|PCS|片)?/);
  if (!m) m = t.match(/(\d{2,7})\s*(?:件|pcs|PCS)/);
  if (m) push('qty', '总数量', Number(m[1]), 0.85, ev(t, m.index, m[0].length));

  // 交期
  m = t.match(/(?:交期|交货|出货|ship(?:ping)?\s*date|delivery)\s*[:：]?\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/i);
  if (!m) m = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) {
    let y, mo, d;
    if (m.length >= 4) { y = m[1]; mo = m[2]; d = m[3]; }
    else {
      const p = m[1].split(/[-/年]/);
      y = p[0]; mo = p[1]; d = String(p[2] || '').replace(/[月日]/g, '');
    }
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!Number.isNaN(new Date(iso).getTime())) {
      push('delivery_date', '交期', iso, 0.85, ev(t, m.index, m[0].length));
    }
  }
  if (!fields.some((f) => f.key === 'delivery_date')) {
    m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (m) {
      const y = new Date().getFullYear();
      push('delivery_date', '交期', `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`,
        0.6, ev(t, m.index, m[0].length), { assume: '未写年份，按今年推断，请与客户确认' });
    }
  }

  // 面料
  const fabrics = [];
  FABRICS.forEach(([name, re]) => { if (re.test(t)) fabrics.push(name); });
  if (fabrics.length) push('fabrics', '面料', [...new Set(fabrics)], 0.8, '');
  m = t.match(/(\d{2,4})\s*(?:gsm|克重|g\/m2|克)/i);
  if (m) push('fabric_weight', '克重', Number(m[1]) + ' gsm', 0.8, ev(t, m.index, m[0].length));

  // 工艺
  const crafts = [];
  CRAFTS.forEach(([name, re]) => { if (re.test(t)) crafts.push(name); });
  if (crafts.length) push('crafts', '工艺要求', [...new Set(crafts)], 0.78, '');

  // 单价
  m = t.match(/(?:单价|价格|报价|price|unit\s*price)\s*[:：]?\s*(?:USD|US\$|\$|￥|RMB|CNY)?\s*([\d,]+(?:\.\d{1,2})?)/i)
    || t.match(/(?:USD|US\$|\$)\s*([\d,]+(?:\.\d{1,2})?)/);
  if (m) {
    const cur = /￥|RMB|CNY/.test(t.slice(Math.max(0, m.index - 6), m.index + m[0].length)) ? 'CNY' : 'USD';
    push('unit_price', '单价', r2(String(m[1]).replace(/,/g, '')), 0.85, ev(t, m.index, m[0].length), { currency: cur });
  }

  // 贸易条款
  const term = TRADE_TERMS.find((x) => new RegExp('\\b' + x + '\\b', 'i').test(t));
  if (term) push('trade_terms', '贸易条款', term, 0.9, '');

  // 付款方式
  m = t.match(/(T\/T[^，,。;；\n]{0,24}|L\/C[^，,。;；\n]{0,16}|30%\s*(?:定金|预付)[^，,。;；\n]{0,16})/i);
  if (m) push('payment', '付款方式', m[1].trim(), 0.8, ev(t, m.index, m[0].length));

  // 包装
  m = t.match(/((?:独立|单独|opp|OPP|纸箱|礼盒|挂装|平装)[^，,。;；\n]{0,18})/);
  if (m) push('packaging', '包装要求', m[1].trim(), 0.7, ev(t, m.index, m[0].length));

  return fields;
}


/** 剥掉品名前的口语成分：「我们要订一批卫衣」→「卫衣」 */
function stripLead(name) {
  let s = String(name || '');
  const pats = [/^我们/, /^我要/, /^我/, /^客户要/, /^要订/, /^要/, /^订/, /^做/, /^采购/, /^需要/, /^请/, /^一批/, /^这批/, /^两款/, /^新款/, /^的/, /^再/];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    for (const p of pats) {
      const next = s.replace(p, '');
      if (next !== s) { s = next; changed = true; }
    }
  }
  return s.trim() || String(name || '').trim();
}

/** 必填项（缺失就要去问客户，不能猜） */
const REQUIRED = [
  ['style_no', '款号'], ['product_name', '品名'], ['colors', '颜色'],
  ['size_breakdown', '尺码数量'], ['delivery_date', '交期']
];

/** 按面料 + 工艺给工序建议（只是建议） */
function craftSuggestion(fields) {
  const val = (k) => (fields.find((f) => f.key === k) || {}).value;
  const fabrics = val('fabrics') || [];
  const crafts = val('crafts') || [];
  const steps = ['备料', '排版算料', '裁剪', '车缝'];
  if (crafts.includes('绣花')) steps.push('绣花');
  if (crafts.includes('印花')) steps.push('印花');
  if (crafts.includes('水洗') || crafts.includes('做旧')) steps.push('水洗');
  steps.push('锁眼钉扣', '整烫', '检验', '包装');
  const notes = [];
  if (fabrics.includes('针织棉') || fabrics.includes('卫衣布') || fabrics.includes('华夫格')) {
    notes.push('针织类建议先做缩水测试，裁剪前排料留 3% 损耗。');
  }
  if (fabrics.includes('真丝') || fabrics.includes('雪纺')) {
    notes.push('薄料建议加密针距并做防脱散处理，车缝前先试缝。');
  }
  if (crafts.includes('印花') && crafts.includes('绣花')) {
    notes.push('印花与绣花同时存在时，先绣后印，避免印花面被绣花机压伤。');
  }
  if (crafts.includes('水洗') || crafts.includes('做旧')) {
    notes.push('水洗款要在裁剪时加大缩量，成品尺寸以洗后为准。');
  }
  if (!notes.length) notes.push('常规款式按标准工序执行；如需特殊工艺请在开发单中补充。');
  return { steps, notes };
}

/** 组装结果 */
function buildDraft(text) {
  const fields = extractFields(text);
  const has = new Set(fields.map((f) => f.key));
  const missing = REQUIRED.filter(([k]) => !has.has(k)).map(([k, label]) => ({ key: k, label }));

  const core = ['style_no', 'product_name', 'colors', 'size_breakdown', 'qty', 'delivery_date', 'fabrics', 'unit_price'];
  const got = core.filter((k) => has.has(k)).length;
  const confidence = Math.round((got / core.length) * 100) / 100;

  const craft = craftSuggestion(fields);
  return {
    fields,
    missing,
    confidence,
    craft,
    summary: `识别出 ${fields.length} 项信息，${missing.length ? '缺 ' + missing.map((m) => m.label).join('、') : '必填项齐全'}；把握度 ${Math.round(confidence * 100)}%`
  };
}

module.exports = { extractFields, buildDraft, craftSuggestion, REQUIRED, COLORS, FABRICS, CRAFTS };
