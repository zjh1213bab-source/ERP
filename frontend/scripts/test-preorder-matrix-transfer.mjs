import assert from 'node:assert/strict';
import { preOrderMatrixForSales } from '../src/utils/preOrderMatrixTransfer.js';
const row = { color: '印花002', size: '3T', qty: 2, unit_price: 12.5, customer_size: '客户3' };
const image = '/uploads/0123456789abcdef0123.png';
const uniform = preOrderMatrixForSales({ size_prices: [row], matrix_meta: { split_price: false, color_images: { 印花002: image } } });
assert.equal(uniform.unit_price, 12.5);
assert.equal(uniform.split_price, false);
assert.equal(uniform.colors[0].sizes[0].usd_price, 12.5);
assert.equal(uniform.color_images.印花002, image);
assert.equal(uniform.customer_sizes['3T'], '客户3');
const split = preOrderMatrixForSales({ size_prices: [row, { ...row, size: '4T', unit_price: 15 }], matrix_meta: { split_price: true } });
assert.equal(split.split_price, true);
assert.equal(split.colors[0].sizes[1].usd_price, 15);
assert.equal(preOrderMatrixForSales({ size_prices: [row] }).split_price, true);
const unconfirmed = preOrderMatrixForSales({ size_prices: [{ ...row, color: '' }], matrix_meta: { color_images: { '': image } } });
assert.equal(unconfirmed.colors[0].color, '待确认');
assert.equal(unconfirmed.color_images['待确认'], image);
assert.deepEqual(preOrderMatrixForSales({}).colors, []);

const colorOnly = preOrderMatrixForSales({ size_prices: [], matrix_meta: {
  colors: ['印花010', '印花002'], sizes: [], color_images: { 印花002: image }, split_price: false
} });
assert.deepEqual(colorOnly.colors, [{ color: '印花002', sizes: [] }, { color: '印花010', sizes: [] }]);
assert.equal(colorOnly.color_images.印花002, image);
const sizeOnly = preOrderMatrixForSales({ matrix_meta: { colors: [], sizes: ['6-7T', 'NB', '3T'], color_images: {}, split_price: false } });
assert.deepEqual(sizeOnly.colors, [{ color: '待确认', sizes: [
  { size: 'NB', qty: 0, usd_price: 0 }, { size: '3T', qty: 0, usd_price: 0 }, { size: '6-7T', qty: 0, usd_price: 0 }
] }]);

const sparseRows = [
  { color: '印花010', size: '4T', qty: 3, unit_price: 15, customer_size: '客户4' },
  { color: '印花002', size: '3T', qty: 2, unit_price: 12.5, customer_size: '客户3' }
];
const sparseInput = { size_prices: sparseRows, matrix_meta: {
  colors: ['印花005'], sizes: ['NB'], color_images: { 印花005: image }, split_price: true
} };
const original = JSON.stringify(sparseInput), sparse = preOrderMatrixForSales(sparseInput);
assert.equal(JSON.stringify(sparseInput), original, 'conversion does not mutate source');
assert.deepEqual(sparse.colors.map(color => color.color), ['印花002', '印花005', '印花010']);
assert.ok(sparse.colors.every(color => JSON.stringify(color.sizes.map(size => size.size)) === JSON.stringify(['NB', '3T', '4T'])), 'all colors share sorted size columns');
assert.equal(sparse.colors[0].sizes[1].usd_price, 12.5);
assert.equal(sparse.colors[2].sizes[2].usd_price, 15);
assert.deepEqual(sparse.customer_sizes, { '4T': '客户4', '3T': '客户3' });
assert.equal(sparse.color_images.印花005, image);
assert.equal(sparse.colors.reduce((total, color) => total + color.sizes.reduce((sum, cell) => sum + cell.qty * cell.usd_price, 0), 0), 70, 'zero quantity completion preserves amount');
assert.equal(sparse.colors.reduce((total, color) => total + color.sizes.reduce((sum, cell) => sum + cell.qty, 0), 0), 5, 'zero quantity completion preserves quantity');
const sparseUniform = preOrderMatrixForSales({ size_prices: sparseRows.map(row => ({ ...row, unit_price: 12.5 })), matrix_meta: { split_price: false } });
assert.equal(sparseUniform.unit_price, 12.5, 'uniform price remains nonzero after sorting and filling');
assert.equal(sparseUniform.split_price, false);
assert.ok(sparseUniform.colors.every(color => color.sizes.every(cell => cell.usd_price === 12.5)), 'new uniform cells use the same price');

const otherImage = '/uploads/abcdef0123456789abcd.jpg';
const collision = preOrderMatrixForSales({ size_prices: [
  { ...row, color: '', unit_price: 12.5 }, { ...row, color: '待确认', unit_price: 15 }, { ...row, color: '待确认（2）', unit_price: 16 }
], matrix_meta: { color_images: { '': image, 待确认: otherImage }, split_price: true } });
assert.equal(new Set(collision.colors.map(color => color.color)).size, 3, 'pending color does not merge with real named colors');
assert.deepEqual(collision.colors.map(color => color.sizes.length), [1, 1, 1], 'each color has one cell per size');
assert.equal(collision.colors.find(color => color.color === '待确认（3）').sizes[0].usd_price, 12.5);
assert.equal(collision.colors.find(color => color.color === '待确认').sizes[0].usd_price, 15);
assert.equal(collision.color_images['待确认（3）'], image, 'blank-color image follows unique mapped name');
assert.equal(collision.color_images.待确认, otherImage, 'literal pending color retains its own image');
const materialMeta={material_details:[{material_id:42,one_use:0.65,loss:5,colors:[{colorway:'红',price:12}]}],material_groups:[{id:'body',name:'衣身',one_use:0.65}]};
const materialTransfer=preOrderMatrixForSales({size_prices:[],matrix_meta:materialMeta});
assert.deepEqual(materialTransfer.materials,materialMeta.material_details);
assert.deepEqual(materialTransfer.material_groups,materialMeta.material_groups);
materialTransfer.materials[0].colors[0].price=99;
assert.equal(materialMeta.material_details[0].colors[0].price,12,'formal order edits do not mutate source snapshot');
console.log('PASS 35 pre-order matrix transfer assertions');
