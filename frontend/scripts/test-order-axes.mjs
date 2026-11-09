import assert from 'node:assert/strict';
import {sortColorNames,sortSizeNames,templateSizeNames,reconcileQuoteMatrix,removedQuoteCells,hasQuoteData,readQuoteMatrixMeta,applyQuoteQuantity,applyQuoteField,copyQuoteCell,quoteTotals} from '../src/utils/orderAxes.js';

let checks=0;
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const check=(value,message)=>{assert.ok(value,message);checks++;};
equal(sortColorNames(['款式10','印花010','款式2','纯色1','印花002','印花001','款式1']),
  ['纯色1','印花001','印花002','印花010','款式1','款式2','款式10'],'Colors sort numerically within their families');
equal(sortColorNames(['色10','色2','色1']),['色1','色2','色10'],'Custom colors use natural numeric order');
equal(sortSizeNames(['2XL','10-12T','S','NB','12-18M','3T','XS','0-3M','2T','M','XL','L','3XL','5-6T']),
  ['NB','0-3M','12-18M','2T','3T','5-6T','10-12T','XS','S','M','L','XL','2XL','3XL'],'Apparel sizes sort newborn, months, toddler, adult');
equal(sortSizeNames(['10','2','1','20']),['1','2','10','20'],'Numeric custom sizes are not lexicographic');
equal(sortSizeNames(['5XL','XXXS','XXL','XXS','XS','L','3XL','S','XL','M']),
  ['XXXS','XXS','XS','S','M','L','XL','XXL','3XL','5XL'],'Extended adult sizes retain size progression');
equal(sortSizeNames(['10/12(10-12T)','5/6(5-6T)','3T','6/7(6-7T)']),
  ['3T','5/6(5-6T)','6/7(6-7T)','10/12(10-12T)'],'Imported display names sort by actual toddler sizes');
equal(sortSizeNames(['M',' S ','M','']),['S','M'],'Template duplicates and whitespace normalize');
equal(templateSizeNames({sizes:'10-12T,2T，NB\n3T'}),['NB','2T','3T','10-12T'],'Text templates share ordering');
equal(templateSizeNames({sizes:[{name:'L'},{size:'XS'},'M']}),['XS','M','L'],'Object templates share ordering');

const first={color:'款式10',size:'10-12T',qty:7,unit_price:12.35,customer_size:'CUSTOM-10',extra:'retain'},
  second={color:'款式2',size:'2T',qty:3,unit_price:8.25,customer_size:'CUSTOM-2'};
const source=[first,second],snapshot=JSON.stringify(source);
const rebuilt=reconcileQuoteMatrix(source,['款式10','款式2'],['10-12T','2T'],{defaultPrice:9.5});
equal(rebuilt.map(row=>[row.color,row.size]),[['款式2','2T'],['款式2','10-12T'],['款式10','2T'],['款式10','10-12T']],
  'The stored matrix follows the same sorted row and column axes');
check(rebuilt[0]===second&&rebuilt[3]===first,'Reordering retains existing cell objects rather than copying or resetting them');
equal(JSON.stringify(source),snapshot,'Reordering and expansion leave old quantity, price, customer size and extra fields untouched');
equal(rebuilt[1],{color:'款式2',size:'10-12T',qty:0,unit_price:9.5,customer_size:'CUSTOM-10'},'Only new cells use the selected uniform default price');
equal(rebuilt[2].customer_size,'CUSTOM-2','Adding a color carries the matching customer size');
equal(reconcileQuoteMatrix([],['印花002'],[]),[],'Choosing colors first does not invent M');
equal(reconcileQuoteMatrix([],[],['2T']),[],'Choosing sizes first does not invent 印花001');
equal(reconcileQuoteMatrix([],['款式2'],['M'],{defaultPrice:19,splitPrice:true})[0].unit_price,0,'New split-price cells do not inherit a uniform price');
equal(removedQuoteCells(rebuilt,['款式2'],['2T','10-12T']),[rebuilt[2],first],'Removing a color targets only its actual cells');
equal(removedQuoteCells(rebuilt,['款式2','款式10'],['2T']),[rebuilt[1],first],'Removing a size targets only its actual cells');
equal(removedQuoteCells(rebuilt,[],['2T','10-12T']),rebuilt,'Clear removes every actual color cell');
check(hasQuoteData({qty:1,unit_price:0}),'Nonzero quantity requires explicit removal confirmation');
check(hasQuoteData({qty:0,unit_price:2.5}),'Price-only data requires explicit removal confirmation');
check(hasQuoteData({qty:0,unit_price:0,customer_size:'客户码'}),'Customer-size-only data requires explicit removal confirmation');
check(!hasQuoteData({qty:0,unit_price:0,customer_size:''}),'An untouched zero cell can be removed directly');
equal(reconcileQuoteMatrix(source,['款式2'],['2T']),[second],'Confirmed removal retains other cells unchanged');
equal(reconcileQuoteMatrix(source,[],[]),[],'Clearing both axes creates no implicit replacement cell');
equal(source,[first,second],'Removal preview is pure and cancellation leaves original matrix intact');
const meta=readQuoteMatrixMeta([],{colors:['款式10','款式2'],sizes:[],color_images:{'款式2':'/uploads/a.png','已移除色':'/uploads/old.png'},split_price:true});
equal(meta,{colors:['款式2','款式10'],sizes:[],color_images:{'款式2':'/uploads/a.png'},split_price:true},'Color-only choices, images and split-price preference survive reload without inventing size');
equal(readQuoteMatrixMeta([],{colors:[],sizes:['10-12T','2T'],color_images:{},split_price:false}).sizes,['2T','10-12T'],'Size-only metadata survives reload in natural order');
equal(readQuoteMatrixMeta(source).colors,['款式2','款式10'],'Old saved orders without metadata recover colors from quote cells');
check(readQuoteMatrixMeta(source,{colors:[],sizes:[],split_price:false}).split_price,'Different saved prices keep split mode even if old metadata disagrees');
equal(readQuoteMatrixMeta(source,{colors:['款式1'],sizes:['M']}).sizes,['2T','10-12T','M'],'Reload preserves both explicit axes and existing quote data');
const copied=reconcileQuoteMatrix(source.map(row=>({...row})),['款式2','款式10'],['2T','10-12T'],{defaultPrice:9.5});
const preserved=copied.map(row=>({price:row.unit_price,customer:row.customer_size}));
applyQuoteQuantity(copied,'款式2','2T','11','row');
equal(copied.map(row=>row.qty),[11,11,0,7],'Row copy affects all sizes of the selected color only');
applyQuoteQuantity(copied,'款式2','10-12T','6','column');
equal(copied.map(row=>row.qty),[11,6,0,6],'Column copy affects the selected size across colors only');
applyQuoteQuantity(copied,'款式10','2T','4');
equal(copied.map(row=>row.qty),[11,6,4,6],'Without a copy mode only the selected quantity changes');
equal(copied.map(row=>({price:row.unit_price,customer:row.customer_size})),preserved,'Row and column copy never change prices or customer sizes');
applyQuoteQuantity(copied,'款式10','2T','','row');
equal(copied.map(row=>row.qty),[11,6,0,0],'Clearing a quantity under row copy explicitly clears only that row');
const quantities=copied.map(row=>row.qty),customerSizes=copied.map(row=>row.customer_size);
applyQuoteField(copied,'款式2','2T','unit_price','1.23','row');
equal(copied.map(row=>row.unit_price),[1.23,1.23,9.5,12.35],'Editing price with row copy changes only prices in that color');
equal(copied.map(row=>row.qty),quantities,'Price row copy leaves quantities unchanged');
applyQuoteField(copied,'款式2','10-12T','unit_price','2.34','column');
equal(copied.map(row=>row.unit_price),[1.23,2.34,9.5,2.34],'Editing price with column copy changes only prices in that size');
equal(copied.map(row=>row.qty),quantities,'Price column copy leaves quantities unchanged');
applyQuoteField(copied,'款式10','2T','unit_price','3.45');
equal(copied.map(row=>row.unit_price),[1.23,2.34,3.45,2.34],'Without copy mode only the selected unit price changes');
equal(copied.map(row=>row.customer_size),customerSizes,'Price copy preserves customer sizes');
equal(quoteTotals(copied),{qty:17,cents:2757},'Mixed unit prices accumulate quantity and integer cents');
equal(quoteTotals(copied.filter(row=>row.color==='款式2')),{qty:17,cents:2757},'Row totals use each cell price');
equal(quoteTotals(copied.filter(row=>row.size==='10-12T')),{qty:6,cents:1404},'Column totals use each cell price');
equal(quoteTotals([{qty:3,unit_price:0.1},{qty:7,unit_price:0.2}]),{qty:10,cents:170},'Monetary sums avoid binary decimal drift');
equal(quoteTotals([]),{qty:0,cents:0},'Empty totals consistently display zero quantity and zero amount');
applyQuoteField(copied,'款式2','2T','unit_price','','column');
equal(copied.map(row=>row.unit_price),[0,2.34,0,2.34],'Clearing price with column copy clears only that price column');
equal(copied.map(row=>row.qty),quantities,'Clearing prices never clears quantities');
assert.throws(()=>applyQuoteField(copied,'款式2','2T','customer_size','bad','row'),/Unsupported quote field/);checks++;
const copyFixture=()=>[
  {color:'红',size:'S',qty:1,unit_price:1.1,customer_size:'客户S',note:'first'},
  {color:'蓝',size:'M',qty:8,unit_price:8.8,customer_size:'客户M',note:'second'},
  {color:'红',size:'L',qty:3,unit_price:3.3,customer_size:'客户L',note:'third'},
  {color:'蓝',size:'S',qty:4,unit_price:4.4,customer_size:'客户S',note:'fourth'},
  {color:'红',size:'M',qty:6,unit_price:2.75,customer_size:'客户M',note:'source'},
  {color:'绿',size:'M',qty:9,unit_price:9.9,customer_size:'客户M',note:'sixth'}
];
let explicit=copyFixture(),before=structuredClone(explicit);
equal(copyQuoteCell(explicit,'红','M','row',{splitPrice:true}),2,'Explicit row copy returns only other sizes in the same color');
equal(explicit.map(row=>row.qty),[6,8,6,4,6,9],'Explicit row copy overwrites existing quantities from a source not first in the array');
equal(explicit.map(row=>row.unit_price),[2.75,8.8,2.75,4.4,2.75,9.9],'Split-price row copy also overwrites target prices');
equal(explicit[4],before[4],'Explicit copy leaves the source cell unchanged');
equal([explicit[1],explicit[3],explicit[5]],[before[1],before[3],before[5]],'Explicit row copy leaves all other colors unchanged');
equal(explicit.map(row=>[row.customer_size,row.note]),before.map(row=>[row.customer_size,row.note]),'Explicit copy preserves customer sizes and other metadata');
explicit=copyFixture();before=structuredClone(explicit);
equal(copyQuoteCell(explicit,'红','M','column',{splitPrice:true}),2,'Explicit column copy returns only other colors in the same size');
equal(explicit.map(row=>row.qty),[1,6,3,4,6,6],'Explicit column copy overwrites only the matching size quantities');
equal(explicit.map(row=>row.unit_price),[1.1,2.75,3.3,4.4,2.75,2.75],'Split-price column copy also overwrites only matching size prices');
equal([explicit[0],explicit[2],explicit[3]],[before[0],before[2],before[3]],'Explicit column copy leaves all other sizes unchanged');
for(const mode of ['row','column']){
  explicit=copyFixture();before=structuredClone(explicit);
  equal(copyQuoteCell(explicit,'红','M',mode,{splitPrice:false}),2,'Uniform-price '+mode+' copy returns the same target count');
  equal(explicit.map(row=>row.unit_price),before.map(row=>row.unit_price),'Uniform-price '+mode+' copy never alters any price');
}
explicit=copyFixture();explicit[4].qty=0;explicit[4].unit_price=0;
equal(copyQuoteCell(explicit,'红','M','column',{splitPrice:true}),2,'Zero source values still copy to all targets');
equal(explicit.filter(row=>row.size==='M').map(row=>[row.qty,row.unit_price]),[[0,0],[0,0],[0,0]],'Explicit copy can clear existing quantities and split prices with zero');
explicit=copyFixture();before=structuredClone(explicit);
equal(copyQuoteCell(explicit,'不存在','M','row',{splitPrice:true}),0,'Missing source cell does not copy');
equal(explicit,before,'Missing source leaves every field unchanged');
for(const mode of ['',null,'diagonal']){
  equal(copyQuoteCell(explicit,'红','M',mode,{splitPrice:true}),0,'Invalid copy mode returns zero');
  equal(explicit,before,'Invalid mode leaves every field unchanged');
}
equal(copyQuoteCell([], '红','M','row',{splitPrice:true}),0,'An empty matrix has no targets');
const singleton=[{color:'红',size:'M',qty:5,unit_price:2}];
equal(copyQuoteCell(singleton,'红','M','row',{splitPrice:true}),0,'Single-cell matrix excludes the source from target count');
equal(singleton,[{color:'红',size:'M',qty:5,unit_price:2}],'Single-cell matrix stays unchanged');
// Snapshot the source before any target assignment; an observer may update the source during copying.
let watchedQty=1,watchedPrice=1;
const laterSource={color:'红',size:'M',qty:6,unit_price:2.75};
const watchedTarget={color:'红',size:'S',get qty(){return watchedQty;},set qty(value){watchedQty=value;laterSource.qty=99;},get unit_price(){return watchedPrice;},set unit_price(value){watchedPrice=value;laterSource.unit_price=88;}};
const lastTarget={color:'红',size:'L',qty:3,unit_price:3};
equal(copyQuoteCell([watchedTarget,laterSource,lastTarget],'红','M','row',{splitPrice:true}),2,'Explicit copy snapshots a later source before target writes');
equal([watchedQty,watchedPrice,lastTarget.qty,lastTarget.unit_price],[6,2.75,6,2.75],'Source observer changes during copying cannot drift later target values');
console.log('PASS '+checks+' order-axis and quote-matrix assertions');
