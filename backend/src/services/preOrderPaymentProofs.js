/** 预单付款凭证：独立私有目录，注册主体后才可引用/下载，不产生收款或记账。 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { db, now } = require('../db');
const scope = require('../access/companyScope');
const { decodeFile } = require('./uploadContent');
const DIRECTORY = path.resolve(__dirname, '../../data/uploads/private/pre-order-payments');
const PREFIX = '/api/pre-orders/payment-proofs/';
const NAME = /^[a-f0-9]{20}\.(png|jpg|webp|gif|pdf)$/;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
const bad = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function metadata(row) { return { url: PREFIX + row.name, filename: row.filename, size: row.size, mime: row.mime }; }
function read(value) { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function validName(name) { return typeof name === 'string' && name === name.trim() && NAME.test(name); }
function getFile(user, name) {
  if (!validName(name)) bad('付款凭证不存在', 404);
  const row = db.prepare('SELECT * FROM pre_order_payment_files WHERE name=?').get(name);
  if (!row || !scope.canSee(user, row)) bad('付款凭证不存在', 404);
  const file = path.join(DIRECTORY, name);
  if (!fs.existsSync(file)) bad('付款凭证文件不存在，请重新上传', 404);
  return { row, file };
}
function upload(user, body) {
  const { buf, mime, ext } = decodeFile(body?.dataUrl, { allowedMimes: ALLOWED });
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  const filename = body?.filename == null ? name : body.filename;
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(filename)) bad('凭证文件名无效，最多255字且不能包含路径或控制字符');
  const row = { name, filename: filename.trim(), size: buf.length, mime, company_id: scope.writeCompanyOf(user), uploaded_by: user.sub, created_at: now() };
  fs.mkdirSync(DIRECTORY, { recursive: true });
  const file = path.join(DIRECTORY, name);
  fs.writeFileSync(file, buf, { flag: 'wx' });
  try { db.prepare('INSERT INTO pre_order_payment_files(name,filename,size,mime,company_id,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').run(row.name, row.filename, row.size, row.mime, row.company_id, row.uploaded_by, row.created_at); }
  catch (error) { fs.unlinkSync(file); throw error; }
  return metadata(row);
}
/** 保存前校验；不信客户端的大小/MIME/文件名，统一从上传登记取回。 */
function prepare(user, value, previous, companyId) {
  const proofs = value === undefined ? read(previous?.payment_proofs_json) : value;
  if (!Array.isArray(proofs) || proofs.length > 10) bad('付款凭证最多上传10个');
  const seen = new Set();
  return proofs.map(proof => {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof proof.url !== 'string' || !proof.url.startsWith(PREFIX)) bad('付款凭证地址无效，请重新上传');
    const name = proof.url.slice(PREFIX.length);
    if (!validName(name) || seen.has(name)) bad('付款凭证地址无效或重复');
    seen.add(name);
    const { row } = getFile(user, name);
    if (!scope.isSingle() && Number(row.company_id) !== Number(companyId)) bad('付款凭证与预下单主体不一致');
    return metadata(row);
  });
}
module.exports = { upload, prepare, read, getFile, DIRECTORY };
