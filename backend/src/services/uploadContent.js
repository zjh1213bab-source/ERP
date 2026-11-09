/** 上传内容的唯一解码/文件头校验；文件扩展名由已验证 MIME 决定。 */
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const EXT_MAP = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip', 'text/plain': 'txt'
};
const startsWith = (buf, bytes) => buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(Buffer.from(bytes));
const SIG = {
  'application/pdf': b => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  'image/png': b => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': b => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  zip: b => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && [0x03, 0x05, 0x07].includes(b[2]),
  ole: b => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
};
const FAMILY = {
  'application/pdf': 'application/pdf', 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/gif': 'image/gif', 'image/webp': 'image/webp',
  'application/zip': 'zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip', 'application/msword': 'ole', 'application/vnd.ms-excel': 'ole'
};
function looksLikeText(buf) {
  const n = Math.min(buf.length, 4096); let invalid = 0;
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return false; if (c < 0x09 || (c > 0x0d && c < 0x20)) invalid++; }
  return invalid / Math.max(n, 1) < 0.02;
}
function validateContent(buf, mime) {
  if (mime === 'text/plain') { if (!looksLikeText(buf)) bad('文件内容不是纯文本'); }
  else if (!SIG[FAMILY[mime]]?.(buf)) bad('文件内容与声明的类型不符（扩展名与实际格式不一致）');
}
function decodeFile(dataUrl, { maxBytes = 10 * 1024 * 1024, allowedMimes = Object.keys(EXT_MAP) } = {}) {
  if (typeof dataUrl !== 'string') bad('文件格式不正确');
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
  if (!match) bad('文件格式不正确');
  const mime = match[1].toLowerCase(), ext = EXT_MAP[mime];
  if (!ext || !allowedMimes.includes(mime)) bad('不支持的文件类型');
  if (match[2].length > Math.ceil(maxBytes / 3) * 4) bad('文件不能超过 ' + maxBytes / 1024 / 1024 + 'MB');
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) bad('文件为空');
  if (buf.length > maxBytes) bad('文件不能超过 ' + maxBytes / 1024 / 1024 + 'MB');
  if (buf.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) bad('文件编码无效');
  validateContent(buf, mime);
  return { buf, mime, ext };
}
module.exports = { EXT_MAP, validateContent, decodeFile };
