/** 全量冒烟专用基础夹具。只允许在 runner 创建的空白临时库调用，禁止复用业务/演示数据。 */
module.exports = function seedSmokeFixtures() {
  const fs=require('fs'),path=require('path'),os=require('os');
  const target=path.resolve(process.env.DB_PATH||'');
  if(process.env.SMOKE_ISOLATED!=='1'||!target.startsWith(path.join(os.tmpdir(),'erp-full-smoke-'))||!fs.existsSync(path.join(path.dirname(target),'.smoke-owned')))throw Error('拒绝在非隔离库创建冒烟夹具');
  const {db,now}=require('../src/db'),{hashPassword}=require('../src/auth/password');
  function add(table,row){for(const col of db.prepare(`PRAGMA table_info(${table})`).all())if(col.notnull&&col.name.endsWith('_at')&&row[col.name]===undefined)row[col.name]=now();const keys=Object.keys(row);return Number(db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>row[k])).lastInsertRowid);}
  if(db.prepare('SELECT count(*) n FROM orders').get().n||db.prepare('SELECT count(*) n FROM suppliers').get().n)throw Error('冒烟夹具要求空白业务库');
  db.exec('BEGIN');try{
    add('companies',{code:'__SMOKE_COMPANY2',name:'__SMOKE第二主体',type:'subsidiary',parent_id:1});add('companies',{code:'__SMOKE_COMPANY3',name:'__SMOKE第三主体',type:'branch',parent_id:1,base_currency:'USD'});
    for(let i=1;i<=6;i++)add('departments',{id:i,company_id:1,name:'__SMOKE部门'+i});
    for(const [username,role]of [['sales01','sales'],['tech01','tech'],['finance01','finance'],['fin01','finance'],['sales02','sales'],['prod01','production'],['wh01','warehouse'],['qc01','qc'],['hr01','hr'],['boss','boss']]){
      const employee=add('employees',{name:'__SMOKE_'+username,phone:'1390000'+String(iFor(username)).padStart(4,'0'),department_id:1,position:role,company_id:1,remark:'__SMOKE全量冒烟基础夹具'});
      add('users',{username,name:'__SMOKE_'+username,password_hash:hashPassword(process.env.ADMIN_PASS),role,employee_id:null,department_id:1,company_id:1,active:1});
    }
    for(let i=1;i<=2;i++)add('customers',{id:i,code:i===1?'C001':'__SMOKE_CUSTOMER'+i,name:'__SMOKE客户'+i,contact:'__SMOKE联系人',phone:'13900009999',email:'smoke@example.test',status:'active'});
    add('customer_accounts',{customer_id:1,username:process.env.MALL_USER||'abc001',name:'__SMOKE商城客户',password_hash:hashPassword(process.env.MALL_PASS||'abc123456'),role:'owner',status:'active',remark:'__SMOKE全量冒烟基础夹具'});
    for(let i=1;i<=7;i++)add('suppliers',{id:i,code:'__SMOKE_SUP'+i,name:'__SMOKE供应商'+i,status:'active'});
    add('materials',{name:'__SMOKE基础面料',code:'__SMOKE_MAT1',type:'fabric',unit:'米',supplier_id:1,supplier:'__SMOKE供应商1',status:'active',stock_qty:1000,version:1});
    add('materials',{name:'__SMOKE基础辅料',code:'__SMOKE_MAT2',type:'accessory',unit:'个',supplier_id:1,supplier:'__SMOKE供应商1',status:'active',stock_qty:10,version:1});
    add('factories',{name:'__SMOKE工厂',code:'__SMOKE_FACTORY',type:'own',processing_mode:'processing',status:'active'});
    add('factories',{name:'__SMOKE外协厂',code:'__SMOKE_OUTSOURCE',type:'outsource',processing_mode:'processing',status:'active'});
    add('products',{sku:'__SMOKE_STYLE',name:'__SMOKE基础款',price:6.5,status:'active'});
    add('product_colors',{product_id:1,name:'红',sort:0});add('product_sizes',{product_id:1,size:'M',sort:0});
    for(const [i,status]of [[1,'draft'],[2,'production'],[3,'instock'],[5,'production'],[11,'production'],[12,'closed']]){
      add('orders',{id:i,order_no:'__SMOKE_ORDER'+i,type:'stock',customer_id:i===2||i===3?2:1,status,rate:6.5,total_usd:100,total_amount:650,currency:'USD',style_name:'__SMOKE基础款',company_id:1,created_by:1,remark:'__SMOKE全量冒烟基础夹具'});
      const item=add('order_items',{order_id:i,product_id:1,product_name:'__SMOKE基础款',style_no:i===1?'LEJE-AW-2601':'__SMOKE_STYLE',qty:100,amount_usd:100,amount_cny:650});
      add('order_item_sizes',{item_id:item,color:'红',size:'M',qty:100,usd_price:1,cny_price:6.5,amount_usd:100,amount_cny:650});
    }
    // 两张独立采购夹具分别覆盖未交减量和到货退料；历史样本只服务供应商评价。
    for(let i=1;i<=4;i++){
      const po=add('purchase_orders',{po_no:'__SMOKE_PO'+i,supplier_id:1,supplier:'__SMOKE供应商1',status:i===1?'ordered':'received',order_date:'2026-07-01',expect_date:'2026-07-10',total_amount:100,company_id:1,remark:'__SMOKE采购夹具',created_by:1});
      const line=add('purchase_items',{po_id:po,material_id:1,name:'__SMOKE基础面料',unit:'米',qty:100,received_qty:i===1?0:50,price:1,amount:100});
      if(i>1){const grn=add('goods_receipts',{grn_no:'__SMOKE_GRN'+i,po_id:po,po_no:'__SMOKE_PO'+i,supplier_id:1,supplier:'__SMOKE供应商1',receive_date:'2026-07-09',status:'passed',line_count:1,expect_qty:50,receive_qty:50,pass_qty:50,pending_qty:0,remark:'__SMOKE评价样本'});add('goods_receipt_items',{grn_id:grn,po_item_id:line,material_id:1,material_name:'__SMOKE基础面料',unit:'米',expect_qty:50,receive_qty:50,pass_qty:50,status:'passed'});}
    }
    for(let i=1;i<=3;i++)add('equipment',{id:i,eq_no:'__SMOKE_EQ'+i,name:'__SMOKE设备'+i,work_center:'__SMOKE车间',capacity_per_hour:50,status:'running',active:1,remark:'__SMOKE'});
    add('channel_shops',{id:1,code:'__SMOKE_SHOP',shop_name:'__SMOKE店铺',warehouse:'us',currency:'USD',status:'active'});
    add('integration_endpoints',{code:'amz-live',name:'__SMOKE鉴权接入点',auth_type:'api_key',api_key_hint:'__S****key',api_key_hash:require('crypto').createHash('sha256').update('__SMOKE-test-key').digest('hex'),status:'active',remark:'__SMOKE'});
    add('bank_accounts',{account_no:'__SMOKE_BANK',company_id:1,bank_name:'__SMOKE测试银行',currency:'CNY',open_balance:1000,status:'active',note:'__SMOKE'});
    require('./apply-gl-ddl').seedAccounts();
    add('stock_items',{warehouse:'us',style_no:'__SMOKE_STYLE',color:'红',size:'M',qty:100,product_name:'__SMOKE基础款'});
    const asn=add('wh_asns',{asn_no:'__SMOKE_ASN',warehouse:'us',from_warehouse:'cn',ship_date:'2026-09-01',eta_date:'2026-09-20',status:'in_transit',expect_qty:100,remark:'__SMOKE'});
    add('wh_asn_legs',{asn_id:asn,seq:1,mode:'sea',etd:'2026-09-01',eta:'2026-09-20',status:'in_transit',note:'__SMOKE'});
    add('wh_asn_boxes',{asn_id:asn,carton_no:'__SMOKE_BOX',style_no:'__SMOKE_STYLE',expect_qty:100,received_qty:0,short_qty:100,reason:'__SMOKE待收货'});
    add('msg_templates',{template_no:'__SMOKE_MSG',company_id:1,event_key:'order.shipped',channel:'site',lang:'zh-CN',version:1,subject:'__SMOKE通知',body:'订单 {{order_no}} 已发货',variables_json:'["order_no"]',status:'approved',approved_by:'__SMOKE',created_by:'__SMOKE',demo_tag:'__SMOKE'});
    add('commission_rules',{rule_no:'__SMOKE_COMM_RULE',company_id:1,name:'__SMOKE提成规则',base_type:'collection',tiers_json:'[{"from":0,"to":100000,"rate":1},{"from":100000,"to":null,"rate":2}]',effective_from:'2026-01-01',status:'approved',approved_by:'__SMOKE',note:'__SMOKE',demo_tag:'__SMOKE'});
    const target=add('sales_targets',{target_no:'__SMOKE_TARGET',company_id:1,team:'__SMOKE',period:'2026-09',version:1,status:'approved',currency:'CNY',note:'__SMOKE',demo_tag:'__SMOKE'});
    add('sales_target_items',{target_id:target,user_id:2,user_name:'__SMOKE_sales01',metric:'revenue',target_amount:1000,note:'__SMOKE'});
    for(const [co,region,type,rate]of [[1,'CN','vat',13],[1,'CN','surcharge',12],[1,'CN','cit',25],[1,'CN','export_rebate',13],[2,'CN','vat',13],[2,'CN','cit',25],[2,'CN','surcharge',12],[3,'US','cit',21]])add('tax_policies',{company_id:co,tax_region:region,tax_type:type,name:'__SMOKE税率'+type,rate,effective_from:'2020-01-01',status:'active',remark:'__SMOKE'});
    add('ar_invoices',{bill_no:'__SMOKE_AR1',order_id:12,customer_id:1,customer_name:'__SMOKE客户1',amount:650,amount_orig:100,currency:'USD',rate:6.5,status:'unpaid',due_date:'2026-09-30',source:'__SMOKE',remark:'__SMOKE',company_id:1});
    add('ap_invoices',{bill_no:'__SMOKE_AP1',purchase_id:2,supplier_id:1,supplier_name:'__SMOKE供应商1',amount:5000,amount_orig:5000,currency:'CNY',rate:1,status:'unpaid',due_date:'2026-09-30',source:'__SMOKE',remark:'__SMOKE',company_id:1});
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  function iFor(s){return [...s].reduce((n,c)=>n+c.charCodeAt(0),0);}
  require('./apply-privacy-ddl');require('./apply-exception-ddl');require('./apply-nodeflow-ddl');require('./seed-ref-nodeflow');require('./apply-nodepanel-ddl');require('./apply-assign-panel');
  db.prepare("UPDATE node_template_items SET visible=0 WHERE code IN ('inspect','pack')").run();
  for(const id of [2,5,11])require('../src/services/nodeFlow').ensureNodes(id);
  require('./smoke-domain-fixtures')(add,db,now);
  require('./apply-skill-ddl');
  require('../src/services/supply').refreshProjection('__SMOKE','us');
  const GL=require('../src/services/gl');
  GL.writeVoucher({company_id:1,period:'2026-09',biz_date:'2026-09-10',summary:'__SMOKE收入',source_type:'__SMOKE',source_id:1,operator:'__SMOKE',entries:[{code:'1002',debit:10000,credit:0,summary:'__SMOKE'},{code:'6001',debit:0,credit:10000,summary:'__SMOKE'}]});
  GL.carryProfit('2026-09','__SMOKE',1);
  for(const co of [1,2,3])GL.ensurePeriod('2026-10',co);
  const tax=require('../src/services/tax');const tr=tax.saveRun(1,'2026-09','CN',{note:'__SMOKE'},'__SMOKE编制');tax.confirmRun(tr.id,{note:'__SMOKE确认'},'__SMOKE审核');
  return {orders:3,suppliers:7,purchases:4};
};
