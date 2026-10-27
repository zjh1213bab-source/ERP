/**
 * CSV 解析工具（导入专用）
 * - 支持引号、逗号、换行
 * - **自动识别分隔符**：Excel 直接粘贴出来是制表符，另存 CSV 才是逗号。
 *   上线时客户经常是「从 Excel 里复制一列粘进来」，认错分隔符会整批失败。
 */

/** 数一数表头行里逗号多还是制表符多 */
function detectDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const comma = (firstLine.match(/,/g) || []).length;
  const tab = (firstLine.match(/\t/g) || []).length;
  const semi = (firstLine.match(/;/g) || []).length;
  if (tab > comma && tab >= semi) return '\t';
  if (semi > comma) return ';';
  return ',';
}

function parseCsv(text, delimiter) {
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');   // 去掉 BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else if (c === '\r') { /* ignore */ }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return { delimiter: d, rows: rows.filter((r) => r.some((x) => String(x).trim() !== '')) };
}

/** 按表头名取列（支持别名，去空格） */
function reader(header) {
  const idx = {};
  header.forEach((h, i) => { idx[String(h).trim().replace(/\s+/g, '')] = i; });
  return (row, ...names) => {
    for (const n of names) {
      const key = String(n).replace(/\s+/g, '');
      if (idx[key] !== undefined) {
        const v = row[idx[key]];
        return v === undefined || v === null ? '' : String(v).trim();
      }
    }
    return '';
  };
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { detectDelimiter, parseCsv, reader, csvCell, toCsv };
