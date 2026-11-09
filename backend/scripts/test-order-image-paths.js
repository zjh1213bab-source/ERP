/** 本地上传/衣创已导入文件名白名单；预单和正式单共用同一图片校验。 */
const assert = require('assert/strict');
const { imageUrl, styleImages } = require('../src/services/orderImages');
let checks = 0;
for (const suffix of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
  for (const name of ['0123456789abcdef0123', 'yc198-80e31bac75bc-3bdbc9c7aae1321c']) {
    const url = '/uploads/' + name + '.' + suffix;
    assert.equal(imageUrl(url), url); checks++;
    assert.deepEqual(styleImages({ effect_image_url: url, detail_images: [url] }),
      { effect_image_url: url, detail_images: [url] }); checks++;
  }
}
for (const url of [
  'https://kr.yc198.com/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg',
  '//example.com/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg',
  '/uploads/../yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg',
  '/uploads/%2e%2e/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg',
  '/uploads/sub/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg',
  '/uploads/yc198-80e31bac75b-3bdbc9c7aae1321c.jpg',
  '/uploads/yc198-80e31bac75bcc-3bdbc9c7aae1321c.jpg',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321.jpg',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321cc.jpg',
  '/uploads/yc198-80e31bac75bg-3bdbc9c7aae1321c.jpg',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.svg',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg?x=1',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg#x',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg\n',
  ' /uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg',
  '/uploads/yc198-80e31bac75bc-3bdbc9c7aae1321c.jpg ',
  '/uploads/photo.jpg', '/uploads/yc198.jpg', 1, {}, []
]) {
  assert.throws(() => imageUrl(url), error => error.status === 400); checks++;
  assert.throws(() => styleImages({ detail_images: [url] }), error => error.status === 400); checks++;
}
assert.equal(imageUrl(null), null); checks++;
assert.equal(imageUrl(''), null); checks++;
console.log('PASS ' + checks + ' order-image path assertions');
