/**
 * 二维码工具
 * ============================================================
 * 为什么单据上要放二维码（而不是只有 Code128 条码）：
 *   条码是给扫码枪读的，手机读不了。车间工人手上只有手机，
 *   扫二维码 → 直接用浏览器打开单据 → 报工/入库，不用回办公室找电脑。
 *
 * 二维码内容是「扫码直达链接」，用系统相机或微信扫一扫就能打开。
 */
import QRCode from 'qrcode';

const cache = new Map();

/**
 * 生成二维码的 dataURL（带缓存，同一单号只算一次）
 * @param {string} text 二维码内容
 * @param {number} width 像素宽
 */
export async function qrDataUrl(text, width = 160) {
  if (!text) return '';
  const key = width + '|' + text;
  if (cache.has(key)) return cache.get(key);
  try {
    const url = await QRCode.toDataURL(String(text), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width,
      color: { dark: '#1f2937', light: '#ffffff' }
    });
    cache.set(key, url);
    return url;
  } catch (e) {
    return '';
  }
}

/**
 * 扫码直达链接。
 *
 * base 传局域网地址（http://192.168.x.x:3000）而不是 127.0.0.1：
 * 用 127.0.0.1 打开页面打印时，二维码里就会是 127.0.0.1，手机扫了指向手机自己，打不开。
 * 拿不到局域网 IP 时退回 location.origin（同机浏览或已用域名访问的情况）。
 */
export function scanUrl(code, base) {
  const origin = String(base || location.origin).replace(/\/+$/, '');
  return origin + '/s/' + encodeURIComponent(String(code || '').trim());
}

/** 优先返回局域网地址：同机（localhost）打开时才需要替换 */
export async function lanBase(api) {
  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  if (!isLocal) return location.origin;
  try {
    const info = await api.lanInfo();
    if (info && info.urls && info.urls.length) return info.urls[0];
  } catch (e) { /* 拿不到就用当前 origin */ }
  return location.origin;
}
