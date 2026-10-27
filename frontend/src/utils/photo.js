/**
 * 手机拍照与压缩
 * ============================================================
 * 为什么必须压缩：
 *   手机直出照片 3–8 MB，而后端单张上限是 4MB、`express.json` 上限 8MB。
 *   不压缩的话，车间在信号弱的角落拍三张就必然失败 —— 而且失败在「上传」这一步，
 *   工人会以为「系统坏了」，不会想到是照片太大。
 *
 *   压到长边 1600px / JPEG 0.82 后，一张约 200–400KB：
 *   看不良瑕疵够清楚（1600px 足够看清跳线、污渍），传得动，服务器也放得下。
 *
 * EXIF 方向：
 *   手机竖拍的照片，像素其实是横的 + 一个「旋转 90°」的 EXIF 标记。
 *   用 canvas 直接画会变成躺倒的图。createImageBitmap 传 imageOrientation:'from-image'
 *   让浏览器先摆正再画；老浏览器走 <img> 路径（现在默认也会按 EXIF 摆正）。
 */

const MAX_SIDE = 1600;
const QUALITY = 0.82;
/** 压缩后仍然超过这个尺寸就继续降（后端上限 4MB，这里留余量） */
const SAFE_BYTES = 1.6 * 1024 * 1024;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('读取照片失败'));
    fr.readAsDataURL(file);
  });
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image：按 EXIF 摆正，否则竖拍的照片会躺倒
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      /* 部分浏览器不支持该选项，退回下面的 img 路径 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('这张照片读不出来（可能不是图片）'));
      img.src = url;
    });
  } finally {
    // 图已解码进内存，可以释放 objectURL 了
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function draw(source, maxSide, quality) {
  const w0 = source.width || source.naturalWidth;
  const h0 = source.height || source.naturalHeight;
  if (!w0 || !h0) throw new Error('照片尺寸异常');

  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // 白底：PNG 透明区域转 JPEG 会变黑，先铺白
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 压缩一张照片
 * @returns {{dataUrl:string, width:number, height:number, kb:number, original_kb:number}}
 */
export async function compressImage(file, opts = {}) {
  const originalKb = Math.round((file.size || 0) / 1024);
  const img = await decode(file);
  // 尺寸要在 close() 之前取：ImageBitmap 关掉后 width/height 不一定还读得到
  const w0 = img.width || img.naturalWidth || 0;
  const h0 = img.height || img.naturalHeight || 0;

  let maxSide = opts.maxSide || MAX_SIDE;
  let quality = opts.quality || QUALITY;
  let dataUrl = draw(img, maxSide, quality);
  let kb = Math.round((dataUrl.length * 3) / 4 / 1024);

  // 还是太大（细节极多的照片），逐步降尺寸重画，最多三次
  let guard = 0;
  while (kb * 1024 > SAFE_BYTES && guard < 3) {
    maxSide = Math.round(maxSide * 0.78);
    quality = Math.max(0.6, quality - 0.08);
    dataUrl = draw(img, maxSide, quality);
    kb = Math.round((dataUrl.length * 3) / 4 / 1024);
    guard++;
  }

  try {
    if (img.close) img.close();
  } catch (e) { /* ignore */ }

  const scale = Math.min(1, maxSide / Math.max(w0, h0, 1));
  return {
    dataUrl,
    width: Math.round(w0 * scale),
    height: Math.round(h0 * scale),
    kb,
    original_kb: originalKb
  };
}

/** 本地时间（toISOString 是 UTC，晚上 8 点后会变成昨天） */
export function localDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
