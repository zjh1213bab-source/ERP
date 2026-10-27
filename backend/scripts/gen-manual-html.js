/**
 * 培训手册 → 单文件 HTML 合订本
 * ============================================================
 * 为什么还要生成 HTML：
 *   Markdown 适合放在仓库里给懂的人看；发给车间主任、仓管、人事，
 *   他们双击一个 .html 就能看、能搜、能打印，不用装 Markdown 阅读器。
 *
 * 特点：
 *   - 图片全部 base64 内嵌 → 单文件，拷到 U 盘、发微信都能直接用
 *   - 左侧目录 + 顶部册切换 + 打印按钮
 *   - 打印时每册自动分页、隐藏导航
 *
 * 用法：node scripts/gen-manual-html.js
 * 输出：docs/manual/ERP-培训手册.html
 */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '../../docs/manual');
const OUT = path.join(DIR, 'ERP-培训手册.html');

const BOOKS = [
  { file: 'README.md', id: 'intro', title: '上岗前必读' },
  { file: '00-演练清单.md', id: 'drill', title: '新人上手演练清单' },
  { file: '01-sales.md', id: 'sales', title: '01 销售跟单' },
  { file: '02-tech.md', id: 'tech', title: '02 技术打版' },
  { file: '03-production.md', id: 'production', title: '03 生产车间' },
  { file: '04-warehouse.md', id: 'warehouse', title: '04 仓库采购' },
  { file: '05-finance.md', id: 'finance', title: '05 财务会计' },
  { file: '06-hr.md', id: 'hr', title: '06 人事行政' },
  { file: '07-admin.md', id: 'admin', title: '07 系统管理员' }
];

// ---------------- 工具 ----------------
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** 图片转 base64（找不到就留占位，不要让整个构建失败） */
const imgCache = new Map();
function inlineImage(rel, baseDir) {
  if (imgCache.has(rel)) return imgCache.get(rel);
  const p = path.resolve(baseDir, rel);
  let url = '';
  try {
    const ext = path.extname(p).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    url = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (e) {
    console.log('  ! 缺图：' + rel);
    url = '';
  }
  imgCache.set(rel, url);
  return url;
}

/** 行内：`code`、**bold**、[链接](url) */
function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, href) => {
    const out = href.endsWith('.md') ? '#' + href.replace(/\.md$/, '') : href;
    return `<a href="${out}">${t}</a>`;
  });
  return s;
}

/**
 * 极简 Markdown → HTML
 * 只支持手册里实际用到的语法：标题 / 表格 / 列表 / 代码块 / 引用 / 图片 / 分隔线 / 段落
 * 不追求通用，追求「改手册不用改生成器」
 */
function md2html(md, baseDir) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push('<p>' + inline(buf.join(' ')) + '</p>');
    buf.length = 0;
  };
  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      flushParagraph(para);
      i++;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      continue;
    }

    // 图片独占一行
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      flushParagraph(para);
      const src = inlineImage(img[2], baseDir);
      out.push(
        '<figure>' + (src ? `<img src="${src}" alt="${esc(img[1])}" />` : `<div class="ph">缺图：${esc(img[2])}</div>`) +
          (img[1] ? `<figcaption>${inline(img[1])}</figcaption>` : '') +
          '</figure>'
      );
      i++;
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      flushParagraph(para);
      const head = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      out.push('<div class="tw"><table>');
      out.push('<thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead>');
      out.push('<tbody>');
      rows.forEach((r) => out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'));
      out.push('</tbody></table></div>');
      continue;
    }

    // 标题（自动加锚点）
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushParagraph(para);
      const lv = h[1].length;
      const text = h[2];
      const aid = 'h-' + text.replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 40);
      out.push(`<h${lv} id="${aid}">${inline(text)}</h${lv}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^---+$/.test(line.trim())) {
      flushParagraph(para);
      out.push('<hr />');
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    // 列表（有序 / 无序）
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flushParagraph(para);
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        '<' + tag + '>' +
          items.map((t) => {
            // - [ ] / - [x] → 可勾选的清单项（演练清单用）
            const m2 = t.match(/^\[([ xX])\]\s+(.*)$/);
            if (m2) {
              const done = m2[1].toLowerCase() === 'x';
              return `<li class="task${done ? ' done' : ''}"><span class="box">${done ? '✓' : ''}</span><span>${inline(m2[2])}</span></li>`;
            }
            return `<li>${inline(t)}</li>`;
          }).join('') +
          '</' + tag + '>'
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushParagraph(para);
      i++;
      continue;
    }

    // 普通段落
    para.push(line.trim());
    i++;
  }
  flushParagraph(para);
  return out.join('\n');
}

// ---------------- 组装 ----------------
console.log('生成培训手册 HTML…');
const sections = [];
const toc = [];

for (const b of BOOKS) {
  const p = path.join(DIR, b.file);
  if (!fs.existsSync(p)) {
    console.log('  ! 缺文件：' + b.file);
    continue;
  }
  const md = fs.readFileSync(p, 'utf8');
  const body = md2html(md, DIR);
  sections.push(`<section class="book" id="${b.id}">\n${body}\n</section>`);

  // 从正文里抽 h2 做二级目录（索引页本身不抽，否则目录里全是"一、二、三"）
  const subs = b.id === 'intro' ? [] : [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  toc.push({
    id: b.id,
    title: b.title,
    subs: subs.map((s) => ({ text: s, anchor: 'h-' + s.replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 40) }))
  });
  console.log(`  ✓ ${b.file} → ${b.title}（${subs.length} 节）`);
}

const nav = toc
  .map(
    (t) =>
      `<div class="nav-book"><a href="#${t.id}" class="nav-title">${esc(t.title)}</a><div class="nav-subs">` +
      t.subs.map((s) => `<a href="#${s.anchor}">${esc(s.text)}</a>`).join('') +
      '</div></div>'
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>跳色科技 ERP · 岗位培训手册 v1.9.0</title>
<style>
  :root {
    --ink: #1f2a3d; --ink2: #4a5568; --muted: #8a94a6;
    --line: #e6ebf3; --bg: #f5f7fb; --card: #fff; --brand: #2563eb;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.85 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  }
  /* 顶部工具条 */
  .bar {
    position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 14px;
    padding: 12px 22px; background: #fff; border-bottom: 1px solid var(--line);
  }
  .bar b { font-size: 15px; }
  .bar .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 20px; padding: 1px 9px; }
  .bar .sp { flex: 1; }
  .bar button {
    border: 1px solid #dbe3ef; background: #fff; color: var(--ink2);
    border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  }
  .bar button:hover { background: #f2f6fd; border-color: #c8d8f5; color: var(--brand); }
  .bar select { border: 1px solid #dbe3ef; border-radius: 8px; padding: 6px 10px; font-size: 13px; color: var(--ink2); }

  /* 布局 */
  .wrap { display: grid; grid-template-columns: 268px 1fr; gap: 26px; max-width: 1320px; margin: 0 auto; padding: 22px; }
  .side {
    position: sticky; top: 66px; align-self: start; max-height: calc(100vh - 90px); overflow: auto;
    background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 14px 10px 18px;
  }
  .nav-book { margin-bottom: 10px; }
  .nav-title { display: block; padding: 6px 10px; border-radius: 8px; font-weight: 700; font-size: 13.5px; color: var(--ink); text-decoration: none; }
  .nav-title:hover { background: #eef4ff; color: var(--brand); }
  .nav-subs { display: flex; flex-direction: column; }
  .nav-subs a {
    padding: 3px 10px 3px 22px; font-size: 12.5px; color: var(--ink2);
    text-decoration: none; border-left: 2px solid transparent; line-height: 1.6;
  }
  .nav-subs a:hover { color: var(--brand); border-left-color: #cfe0ff; background: #f8fbff; }

  main { min-width: 0; }
  .book {
    background: var(--card); border: 1px solid var(--line); border-radius: 16px;
    padding: 30px 38px 40px; margin-bottom: 24px;
  }
  /* 锚点跳转时给吸顶工具条留位置，否则标题被遮一半 */
  .book, .book h2, .book h3 { scroll-margin-top: 76px; }
  .book h1 { font-size: 25px; margin: 0 0 18px; padding-bottom: 12px; border-bottom: 2px solid #eef2f8; }
  .book h2 { font-size: 19px; margin: 30px 0 12px; padding-left: 11px; border-left: 4px solid var(--brand); }
  .book h3 { font-size: 16px; margin: 22px 0 8px; color: #16305f; }
  .book h4 { font-size: 14.5px; margin: 18px 0 6px; color: var(--ink2); }
  .book p { margin: 10px 0; color: var(--ink2); }
  .book strong { color: var(--ink); }
  .book a { color: var(--brand); }

  .tw { overflow-x: auto; margin: 14px 0; border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 13px; border-bottom: 1px solid #eef2f8; vertical-align: top; }
  thead th { background: #f7f9fd; font-size: 12.5px; color: #5b6474; font-weight: 700; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #fafcff; }

  ul, ol { margin: 10px 0; padding-left: 24px; color: var(--ink2); }
  li { margin: 4px 0; }
  li.task { list-style: none; margin-left: -20px; display: flex; gap: 9px; align-items: flex-start; margin-bottom: 7px; }
  li.task .box {
    width: 15px; height: 15px; flex: none; margin-top: 4px; border: 1.5px solid #b9c4d6;
    border-radius: 3px; display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; color: #2563eb; line-height: 1;
  }
  li.task.done .box { background: #e8f0ff; border-color: #2563eb; }
  li.task.done span:last-child { color: var(--muted); text-decoration: line-through; }

  code { background: #f2f5fa; padding: 1px 6px; border-radius: 5px; font-size: 12.5px; color: #34425c; }
  pre { background: #f7f9fd; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.7; }

  blockquote {
    margin: 14px 0; padding: 10px 16px; background: #f4f8ff;
    border-left: 3px solid #b9ceff; border-radius: 0 8px 8px 0; color: #3c5378; font-size: 13.5px;
  }
  hr { border: none; border-top: 1px dashed var(--line); margin: 26px 0; }

  figure { margin: 18px 0; }
  figure img { width: 100%; border: 1px solid var(--line); border-radius: 10px; display: block; }
  figcaption { font-size: 12px; color: var(--muted); text-align: center; margin-top: 7px; }
  .ph { padding: 30px; text-align: center; color: #c0392b; background: #fdf3f4; border-radius: 10px; font-size: 12px; }

  /* 打印：每册分页，隐藏导航 */
  @media print {
    body { background: #fff; font-size: 11.5pt; }
    .bar, .side { display: none !important; }
    .wrap { display: block; padding: 0; max-width: none; }
    .book { border: none; border-radius: 0; padding: 0 0 10mm; margin: 0; page-break-after: always; }
    .book:last-child { page-break-after: auto; }
    .book h2 { page-break-after: avoid; }
    figure, table, pre, blockquote { page-break-inside: avoid; }
    figure img { border: 1px solid #ccc; }
    a { color: #000; text-decoration: none; }
  }
  @media (max-width: 1000px) {
    .wrap { grid-template-columns: 1fr; }
    .side { display: none; }
    .book { padding: 20px 18px 26px; }
  }
</style>
</head>
<body>
<div class="bar">
  <b>跳色科技 ERP · 岗位培训手册</b>
  <span class="tag">v1.9.0</span>
  <span class="tag">2026-10-28</span>
  <span class="sp"></span>
  <select onchange="if(this.value)document.getElementById(this.value).scrollIntoView({behavior:'smooth'})">
    <option value="">跳到分册…</option>
    ${toc.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}
  </select>
  <button onclick="window.print()">打印 / 存 PDF</button>
</div>
<div class="wrap">
  <aside class="side">${nav}</aside>
  <main>${sections.join('\n')}</main>
</div>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
const kb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
console.log(`\n✓ ${OUT}\n  ${kb} MB（图片已内嵌，单文件可直接分发）`);
