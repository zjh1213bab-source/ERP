/** 独立进程运行 CLIP；仅接收已校验的图片字节，禁止访问用户提供的 URL。 */
const path = require('path');
const MODEL = 'Xenova/clip-vit-base-patch32';
const REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523';
let engine;
async function load(download = false) {
  if (!engine) engine = (async () => {
    const { AutoProcessor, CLIPVisionModelWithProjection, env, RawImage } = await import('@huggingface/transformers');
    env.cacheDir = path.resolve(__dirname, '../../data/ai-models');
    // 正式检索仅使用安装阶段下载的本地模型，不向外网发送样衣或查询图。
    env.allowRemoteModels = download;
    if (process.env.AI_MODEL_DOWNLOAD_HOST) env.remoteHost = process.env.AI_MODEL_DOWNLOAD_HOST;
    const extractor = await CLIPVisionModelWithProjection.from_pretrained(MODEL, {
      revision: REVISION, dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
    });
    const processor = await AutoProcessor.from_pretrained(MODEL, { revision: REVISION });
    return { extractor, processor, RawImage };
  })().catch(e => { engine = null; throw e; });
  return engine;
}
async function embed(base64) {
  const { extractor, processor, RawImage } = await load();
  const sharp = (await import('sharp')).default;
  // 防止超大像素图片解码占满内存，统一方向并缩图后再进入模型。
  let image;
  try {
    image = await sharp(Buffer.from(base64, 'base64'), { limitInputPixels: 24000000, animated: false })
      .rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  } catch (e) { throw Object.assign(Error('图片损坏或像素超过2400万'), { code: 'INVALID_IMAGE' }); }
  const raw = new RawImage(new Uint8ClampedArray(image.data), image.info.width, image.info.height, image.info.channels);
  const features = (await extractor(await processor(raw))).image_embeds;
  const vector = Array.from(features.data);
  const norm = Math.hypot(...vector);
  if (vector.length !== 512 || !Number.isFinite(norm) || norm <= 0) throw Error('图像特征无效');
  return vector.map(v => v / norm);
}
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
  try { process.send?.({ id: message.id, vector: await embed(message.base64) }); }
  catch (e) { console.error('[sample-image-worker]', e.stack); process.send?.({ id: message.id, code: e.code, error: e.code === 'INVALID_IMAGE' ? e.message : '本地图搜模型未就绪，请检查安装日志' }); }
});
if (process.argv.includes('--install')) load(true).then(async ({ extractor }) => {
  console.log('CLIP_IMAGE_SEARCH_MODEL_READY'); await extractor.dispose();
}).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { MODEL, REVISION };
