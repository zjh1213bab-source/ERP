/** 样衣 AI 图搜。派生特征按“模型版本 + 图片内容哈希”缓存，不改样衣快照和业务库。 */
const fs = require('fs/promises'), path = require('path'), crypto = require('crypto');
const { fork } = require('child_process');
const { db } = require('../db');
const scope = require('../access/companyScope');
const ROOT = path.resolve(__dirname, '../../data/uploads');
const CACHE = path.resolve(__dirname, '../../data/image-vectors');
const MODEL_VERSION = 'clip-vit-b32-q8-6b7c523-v1';
const jobs = new Map();
let child, nextId = 0, processing = false;
const pending = new Map();
const bad = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
function validImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 3 * 1024 * 1024) bad('图片不能为空且不能超过3MB');
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpg && !webp) bad('请上传有效的 JPG、PNG 或 WebP 图片');
  return bytes;
}
function decode(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 4200000) bad('图片不能为空且不能超过3MB');
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) bad('图片格式无效');
  return validImage(Buffer.from(match[1], 'base64'));
}
async function localImage(url) {
  // 仅允许上传区普通图片。拒绝任意 URL、私有附件、目录穿越及符号链接逃逸。
  if (typeof url !== 'string' || !/^\/uploads\/[a-zA-Z0-9_/-]+\.(png|jpe?g|webp)$/i.test(url)) bad('样衣图片不是支持的本地图片');
  const filename = await fs.realpath(path.join(ROOT, url.slice('/uploads/'.length)));
  const root = await fs.realpath(ROOT);
  if (!filename.startsWith(root + path.sep)) bad('样衣图片路径无效');
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > 3 * 1024 * 1024) bad('样衣图片过大或无效');
  return validImage(await fs.readFile(filename));
}
function startWorker() {
  if (child) return;
  child = fork(path.join(__dirname, 'sampleImageWorker.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', b => console.error('[image-search]', String(b).trim()));
  child.on('message', m => {
    const item = pending.get(m.id); if (!item) return;
    pending.delete(m.id); clearTimeout(item.timer);
    m.error ? item.reject(Object.assign(Error(m.error), { code: m.code })) : item.resolve(m.vector);
  });
  child.on('error', e => console.error('[image-search-worker]', e.stack));
  child.on('exit', () => {
    child = null;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('图搜工作进程已停止，请重试')); }
    pending.clear();
  });
}
function infer(bytes) {
  startWorker(); const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child?.kill(); }, 90000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, base64: bytes.toString('base64') });
  });
}
function vectorValid(v) { return Array.isArray(v) && v.length === 512 && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < 0.001; }
async function archiveVector(bytes) {
  const key = crypto.createHash('sha256').update(MODEL_VERSION).update(bytes).digest('hex');
  const file = path.join(CACHE, key + '.json');
  try { const v = JSON.parse(await fs.readFile(file, 'utf8')); if (vectorValid(v)) return v; } catch (e) { if (e.code !== 'ENOENT') console.warn('[image-search-cache]', e.message); }
  const vector = await infer(bytes);
  if (!vectorValid(vector)) throw Error('图像特征校验失败');
  await fs.mkdir(CACHE, { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(tmp, JSON.stringify(vector)); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
  return vector;
}
function candidates(user, q, status) {
  const s = scope.of(user), params = [], where = ["a.image_url IS NOT NULL AND a.image_url<>''"];
  if (!s.cross) { where.push('COALESCE(o.company_id,p.company_id)=?'); params.push(s.companyId || -1); }
  if (q) { where.push('(a.archive_no LIKE ? OR a.style_no LIKE ? OR a.sample_name LIKE ? OR a.customer LIKE ?)'); params.push(...Array(4).fill('%' + q + '%')); }
  if (status) { where.push('a.status=?'); params.push(status); }
  return db.prepare(`SELECT a.id,a.image_url FROM sample_archives a LEFT JOIN tech_packs tp ON tp.id=a.tech_pack_id
    LEFT JOIN orders o ON o.id=COALESCE(NULLIF(a.order_id,0),NULLIF(tp.order_id,0))
    LEFT JOIN pre_orders p ON p.id=COALESCE(a.pre_order_id,tp.pre_order_id) WHERE ${where.join(' AND ')} ORDER BY a.id DESC`).all(...params);
}
function clean() { for (const [id, j] of jobs) if (Date.now() - j.created > 15 * 60000 && !['queued', 'running'].includes(j.state)) jobs.delete(id); }
function create(user, body) {
  clean();
  if (jobs.size >= 100) { const oldest = [...jobs.values()].find(j => !['queued','running'].includes(j.state)); if (oldest) jobs.delete(oldest.id); }
  const q = String(body.q || '').trim(), status = String(body.status || '');
  if (q.length > 100 || !['', 'locked', 'changing', 'revised'].includes(status)) bad('筛选条件无效');
  if ([...jobs.values()].some(j => j.owner === String(user.sub) && ['queued', 'running'].includes(j.state))) bad('已有图搜任务正在进行，请等待完成', 409);
  if ([...jobs.values()].filter(j => ['queued', 'running'].includes(j.state)).length >= 4) bad('图搜繁忙，请稍后重试', 429);
  const bytes = decode(body.dataUrl), rows = candidates(user, q, status);
  const j = { id: crypto.randomUUID(), owner: String(user.sub), created: Date.now(), state: 'queued', done: 0, total: rows.length, skipped: 0, matches: [], user: { ...user }, q, status, bytes, rows };
  jobs.set(j.id, j); console.info('[sample-image-search]', { operator: user.username, job: j.id, candidates: rows.length });
  setImmediate(runQueue); return publicJob(j, user);
}
async function runQueue() {
  if (processing) return; processing = true;
  try {
    for (const j of jobs.values()) {
      if (j.state !== 'queued') continue;
      j.state = 'running';
      try {
        if (j.rows.length) {
          const query = await infer(j.bytes);
          for (const row of j.rows) {
            let bytes;
            try { bytes = await localImage(row.image_url); } catch { j.skipped++; j.done++; continue; }
            let vector;
            try { vector = await archiveVector(bytes); }
            catch (e) { if (e.code === 'INVALID_IMAGE') { j.skipped++; j.done++; continue; } throw e; }
            const score = query.reduce((sum, v, i) => sum + v * vector[i], 0);
            j.matches.push({ id: row.id, image_url: row.image_url, similarity: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 10 });
            j.done++;
          }
        }
        j.matches.sort((a,b) => b.similarity - a.similarity || b.id-a.id); j.state = 'done';
      } catch (e) { j.state = 'error'; j.message = '图搜失败：' + e.message; console.error('[sample-image-search]', j.id, e.stack); }
      finally { delete j.bytes; delete j.rows; delete j.user; }
    }
  } finally { processing = false; }
}
function publicJob(j, user) {
  // 读取结果时再次验证公司范围及图片版本，防止检索期间改权限/换图造成旧结果泄露。
  const allowed = new Map(candidates(user, j.q, j.status).map(r => [r.id, r.image_url]));
  const matches = j.state === 'done' ? j.matches.filter(m => allowed.get(m.id) === m.image_url).slice(0, 50).map(m => {
    const r = db.prepare('SELECT id,archive_no,style_no,sample_name,version,pattern_size,customer,locked_at,created_at,status,image_url FROM sample_archives WHERE id=?').get(m.id);
    return { ...r, similarity: m.similarity };
  }) : [];
  return { id: j.id, state: j.state, done: j.done, total: j.total, skipped: j.skipped, message: j.message, matches, model: MODEL_VERSION };
}
function result(user, id) { clean(); const j = jobs.get(id); if (!j || j.owner !== String(user.sub)) bad('图搜任务不存在或已过期，请重新上传', 404); return publicJob(j, user); }
module.exports = { create, result, decode, localImage, candidates, vectorValid, archiveVector, infer, shutdown: () => child?.kill() };
