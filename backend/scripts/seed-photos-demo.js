/**
 * 现场照片演示数据（可重复执行）
 *
 * 照片不是拿几张真实图片塞进来 —— 那既不合法也不说明问题。
 * 这里用 canvas 现画「像照片的东西」：布面底色 + 缺陷标记 + 文字标注，
 * 尺寸与画质按真实手机照片的压缩结果给（长边 1600 / JPEG 0.82）。
 *
 * 走真实 HTTP 接口灌数据（而不是直接 INSERT），这样校验规则也被跑一遍：
 * 不良照片没写说明就会被拒。
 *
 * 用法：node scripts/seed-photos-demo.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../src/db');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const MARK = '演示·';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  });
  const j = await r.json();
  if (!j.ok) throw new Error('登录失败：' + j.message);
  return j.data.token;
}

/** 清掉上一轮演示照片（含磁盘文件），保证脚本可重复跑 */
function cleanup() {
  const rows = db.prepare("SELECT id, url FROM attachments WHERE note LIKE '演示·%'").all();
  rows.forEach((r) => {
    const f = path.resolve(__dirname, '../data', String(r.url || '').replace(/^\/uploads\//, 'uploads/'));
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
  });
  const n = db.prepare("DELETE FROM attachments WHERE note LIKE '演示·%'").run().changes;
  console.log(`清理上一轮演示照片 ${n} 条`);
}

/** 用 canvas 画一张「像现场照片」的图，返回 dataURL 列表 */
async function drawPhotos() {
  const port = 9796;
  const proc = spawn(
    CHROME,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=' + port, '--window-size=1000,800', 'about:blank'],
    { stdio: 'ignore' }
  );
  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');

  const script = `
  (() => {
    function tex(ctx, w, h, base, dark) {
      ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
      // 织纹：细密斜线，看起来像布面
      ctx.strokeStyle = dark; ctx.globalAlpha = 0.16; ctx.lineWidth = 1;
      for (let i = -h; i < w; i += 4) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
      }
      for (let i = 0; i < w + h; i += 6) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - h, h); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // 明暗：模拟侧光
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, 'rgba(255,255,255,0.16)');
      g.addColorStop(0.55, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    function make(opts) {
      const W = 1600, H = 1200;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      tex(x, W, H, opts.base, opts.dark);

      // 缺陷标记
      (opts.marks || []).forEach((m) => {
        x.strokeStyle = '#e11d48'; x.lineWidth = 7;
        x.beginPath(); x.arc(m.x, m.y, m.r, 0, Math.PI * 2); x.stroke();
        x.strokeStyle = 'rgba(225,29,72,0.5)'; x.lineWidth = 3;
        x.beginPath(); x.arc(m.x, m.y, m.r + 16, 0, Math.PI * 2); x.stroke();
      });

      // 角落标注（模拟手机水印/工位贴纸）
      x.fillStyle = 'rgba(0,0,0,0.55)';
      x.fillRect(0, H - 86, W, 86);
      x.fillStyle = '#fff';
      x.font = '600 30px "Microsoft YaHei", sans-serif';
      x.fillText(opts.label, 28, H - 34);

      x.fillStyle = 'rgba(255,255,255,0.86)';
      x.font = '600 26px "Microsoft YaHei", sans-serif';
      x.fillText(opts.tag, 28, 56);
      return c.toDataURL('image/jpeg', 0.82);
    }
    return [
      make({ base: '#2f3b46', dark: '#ffffff', tag: '车缝 · 左袖口', label: '左袖口跳线 3 处', marks: [{x:520,y:640,r:90},{x:760,y:700,r:70}] }),
      make({ base: '#c9b79c', dark: '#5b4632', tag: '整烫 · 前片', label: '前片沾污（烫台油渍）', marks: [{x:880,y:520,r:110}] }),
      make({ base: '#8c6b4f', dark: '#2b1d12', tag: '来料 · 面料仓', label: '到货外箱压损 · 3 箱', marks: [] }),
      make({ base: '#e8e2d6', dark: '#7a6a55', tag: '装箱 · 成品仓', label: '混装待复核 · 第 2 箱', marks: [] }),
      make({ base: '#3d4a5c', dark: '#c9d3e2', tag: '检验 · 台面', label: '车缝不良 · 针距不均', marks: [{x:430,y:700,r:80},{x:700,y:560,r:60}] }),
      make({ base: '#b9c7d6', dark: '#33445a', tag: '样衣 · 版房', label: '客户确认样 · 领口开深', marks: [{x:800,y:420,r:95}] })
    ];
  })()
  `;
  const r = await send('Runtime.evaluate', {
    expression: 'document.write("<html><body></body></html>"),' + script,
    returnByValue: true
  });
  proc.kill();
  if (!r.result || !Array.isArray(r.result.value)) throw new Error('画图失败：' + JSON.stringify(r).slice(0, 200));
  return r.result.value;
}

(async () => {
  cleanup();

  const token = await login();
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  // 挑几张生产中的单（要有工序才能挂工序）
  const orders = (await (await fetch(BASE + '/api/orders?limit=200', { headers: H })).json()).data || [];
  const live = [];
  for (const o of orders) {
    if (live.length >= 3) break;
    if (!['production', 'assigned', 'instock', 'shipped'].includes(o.status)) continue;
    const nd = (await (await fetch(`${BASE}/api/order-nodes?order_id=${o.id}`, { headers: H })).json()).data || [];
    if (nd.length) live.push({ order: o, nodes: nd });
  }
  if (!live.length) {
    console.log('没有带工序的订单，先跑生产演示数据再执行本脚本');
    process.exit(1);
  }

  const imgs = await drawPhotos();
  console.log(`画好 ${imgs.length} 张模拟照片`);

  const plan = [
    { cat: 'defect', note: '左袖口跳线 3 处，已停线待返工', node: 3, img: 0 },
    { cat: 'defect', note: '前片沾污（烫台油渍），不可修复', node: 5, img: 1 },
    { cat: 'incoming', note: '到货外箱压损 3 箱，面料未见损伤', node: null, img: 2 },
    { cat: 'packing', note: '混装待复核，第 2 箱', node: 11, img: 3 },
    { cat: 'defect', note: '针距不均，返工重做', node: 3, img: 4 },
    { cat: 'sample', note: '客户确认样，领口加深 1cm', node: null, img: 5 }
  ];

  let okCount = 0;
  let failed = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const target = live[i % live.length];
    const node = p.node ? target.nodes[p.node % target.nodes.length] : null;
    const res = await fetch(BASE + '/api/photos', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        order_id: target.order.id,
        dataUrl: imgs[p.img],
        cat: p.cat,
        note: MARK + p.note,
        node_id: node ? node.id : null,
        taken_at: (() => {
          const d = new Date();
          d.setDate(d.getDate() - (i % 4));
          const q = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())} ${q(8 + (i % 9))}:${q(10 + i * 3)}:00`;
        })()
      })
    });
    const j = await res.json();
    if (j.ok) {
      okCount++;
      console.log(`  ✓ ${target.order.order_no} ${p.cat} · ${p.note} (${Math.round(j.data.size / 1024)}KB)`);
    } else {
      failed++;
      console.log(`  ✗ ${target.order.order_no} ${p.cat}：${j.message}`);
    }
  }

  // 顺带验证一条硬规则：不良照片不写说明必须被拒
  const bad = await fetch(BASE + '/api/photos', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ order_id: live[0].order.id, dataUrl: imgs[0], cat: 'defect', note: '' })
  });
  const badJson = await bad.json();
  console.log(`\n规则校验：不良照片不写说明 → ${bad.ok ? '竟然通过了（有问题）' : '被拒（正确）'}：${badJson.message}`);

  console.log(`\n完成：成功 ${okCount} 张，失败 ${failed} 张`);
  process.exit(0);
})();
