/** 独立库内的模块前置场景；每个场景由本次测试构建，不读取演示或业务库。 */
module.exports=function(add,db,now){
  const tag='__SMOKE',date='2026-10-01',future='2099-12-31T23:59:59Z';
  const budget=add('budgets',{budget_no:'__SMOKE_BUDGET',fiscal_year:2026,company_id:1,name:'__SMOKE预算',status:'active',is_current:1,total_amount:1000,item_count:1,note:tag});
  add('budget_items',{budget_id:budget,department_id:4,account_code:'6602',period:'2026-10',amount:1000,note:tag});
  const position=add('org_positions',{code:'__SMOKE_POS1',title:'__SMOKE满编岗位',company_id:1,department_id:1,headcount:2,status:'active',remark:tag});
  add('org_positions',{code:'__SMOKE_POS2',title:'__SMOKE空缺岗位',company_id:1,department_id:1,headcount:2,status:'active',remark:tag});
  add('org_positions',{code:'__SMOKE_POS3',title:'__SMOKE跨主体岗位',company_id:2,department_id:null,headcount:2,status:'active',remark:tag});
  add('employments',{employment_no:'__SMOKE_EMP',employee_id:1,employer_company_id:1,service_company_id:1,position_id:position,department_id:1,start_date:'2026-01-01',status:'effective',remark:tag});
  add('employments',{employment_no:'__SMOKE_EMP2',employee_id:2,employer_company_id:1,service_company_id:1,position_id:position,department_id:1,start_date:'2026-01-01',status:'effective',remark:tag});
  add('trade_routes',{route_no:'__SMOKE_ROUTE',name:'__SMOKE内部路线',biz_type:'stock',seller_company_id:1,buyer_company_id:2,fulfill_company_id:1,goods_owner_company_id:1,sign_company_id:1,pay_company_id:1,service_agreement:tag,status:'confirmed',note:tag,demo_tag:tag});
  for(const [no,title,status,doing]of [['LEAVE','__SMOKE请假审批制度','effective','请假 3 天、三天以内由部门主管审批；超过三天由总经理审批。'],['SAMPLE','__SMOKE样品借用制度','draft','样品能借多久？需登记借样并在七天内归还。']]){
    const id=add('sop_documents',{doc_no:'__SMOKE_'+no,title,category:'人事行政',owner:tag,status,current_version:1,effective_date:'2026-01-01',remark:tag});
    add('sop_versions',{doc_id:id,version:1,doing,inputs:tag,done_criteria:tag,escalate_path:tag,status,change_note:tag});
  }
  const campaign=add('mkt_campaigns',{campaign_no:'__SMOKE_CAMP',company_id:1,name:'__SMOKE活动',currency:'USD',budget_amount:100,start_date:'2026-09-01',end_date:'2026-09-30',status:'active',owner:tag,note:tag});
  add('mkt_reviews',{review_no:'__SMOKE_REVIEW',company_id:1,period:'2026-09',topic:'__SMOKE复盘',source_type:'campaign',source_id:campaign,status:'open',owner:tag,demo_tag:tag});
  const schedule=add('schedule_runs',{run_no:'__SMOKE_SCHEDULE',company_id:1,horizon_from:'2026-11-01',horizon_to:'2026-11-30',status:'draft',is_current:1,order_count:1,task_count:1,conflict_count:1,note:tag,demo_tag:tag});
  const task=add('schedule_tasks',{run_id:schedule,order_id:5,order_no:'__SMOKE_ORDER5',style_no:'__SMOKE_STYLE',process_name:'车缝',work_center:'__SMOKE车间',qty:100,est_hours:2,start_at:'2026-11-05 08:00',end_at:'2026-11-05 10:00',status:'planned',demo_tag:tag});
  add('schedule_conflicts',{run_id:schedule,order_id:5,task_id:task,type:'capacity',level:'hard',work_center:'__SMOKE车间',detail:'__SMOKE产能冲突',demo_tag:tag});
  const proposal=add('spot_proposal_runs',{run_no:'__SMOKE_SPOT_RUN',company_id:1,warehouse:'us',as_of_date:date,window_days:60,line_count:2,status:'draft',is_current:1,note:tag,demo_tag:tag});
  for(const kind of ['replenish','stop'])add('spot_proposal_lines',{run_id:proposal,kind,reason_code:'__SMOKE',style_no:'__SMOKE_STYLE',color:'红',size:'M',suggest_qty:kind==='stop'?0:10,reason:'__SMOKE经营提案',status:'pending',demo_tag:tag});
  const co=add('cost_objects',{cost_no:'__SMOKE_COST',order_id:1,order_no:'__SMOKE_ORDER1',customer_name:'__SMOKE客户1',style_no:'LEJE-AW-2601',qty:100,rate:6.5,revenue_cny:650,actual_cost:3000,budget_cost:3000,status:'open',remark:tag});
  add('cost_entries',{cost_object_id:co,layer:'material',amount:3000,source:'manual',occurred_at:'2026-10-01',remark:tag});
  add('production_reports',{order_id:1,qty_ok:100,qty_defect:0,hours:10,report_date:'2026-10-01',operator:tag,remark:tag});
  const batch=add('supply_batches',{batch_no:'__SMOKE_SUPPLY',company_id:1,warehouse:'us',style_no:'__SMOKE_STYLE',product_name:'__SMOKE基础款',color:'红',size:'M',sku:'__SMOKE_STYLE|红|M',stage:'in_production',qty_planned:200,qty_produced:100,eta_date:'2026-12-20',eta_evidence:tag,eta_covered:1,qc_grade:'A',intended_use:'sellable',status:'active',note:tag,demo_tag:tag});
  add('booking_requests',{request_no:'__SMOKE_BOOKING',company_id:1,customer_id:1,customer_name:'__SMOKE客户1',style_no:'__SMOKE_STYLE',color:'红',size:'M',sku:'__SMOKE_STYLE|红|M',qty:10,kind:'future',batch_id:batch,status:'submitted',valid_until:future,note:tag,demo_tag:tag});
  add('stock_items',{warehouse:'cn',style_no:'LEJE-TZ-002',product_name:tag,color:'黑色',size:'M',qty:100});
  add('stock_items',{warehouse:'cn',style_no:'LEJE-AW-2601',product_name:tag,color:'奶油白',size:'3T',qty:100});
  add('crm_customer_cycles',{customer_id:1,company_id:1,status:'known',cycle_days:30,basis:tag,last_purchase_date:'2026-09-01',next_due_date:'2026-10-01',owner_user_id:2,owner_name:tag,demo_tag:tag});
  add('equity_investments',{inv_no:'__SMOKE_INV',company_id:1,investee_id:2,investee_code:'__SMOKE_COMPANY2',investee_name:'__SMOKE第二主体',method:'cost',acquire_date:'2026-08-01',acquire_cost:1000,share_pct:100,book_value:1000,status:'active',note:tag,demo_tag:tag});
  add('dorm_rooms',{building:'__SMOKE楼',room_no:'__SMOKE_ROOM',capacity:4,status:'normal',remark:tag});
  add('payrolls',{period:'2026-10',employee_id:1,employee_name:'__SMOKE员工',department:'__SMOKE部门',base_salary:5000,gross_pay:5000,net_pay:5000,status:'confirmed',remark:tag,company_id:1});
  for(const process_name of ['裁剪','车缝','整烫','检验','包装'])add('process_standards',{process_name,work_center:'__SMOKE车间',std_minutes:1,active:1,remark:tag,demo_tag:tag});
  const current=new Date(),period=`${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}`;
  for(const [node_name,qty_ok,hours]of [['车缝',60,2],['__SMOKE无标准工序',60,0]])add('production_reports',{order_id:5,node_name,qty_ok,qty_defect:0,hours,report_date:period+'-01',operator:tag,remark:tag});
  for(let i=0;i<6;i++){
    const id=add('orders',{order_no:'__SMOKE_REPORT'+i,type:'stock',customer_id:1,status:'shipped',total_usd:20,total_amount:130,rate:6.5,remark:tag,company_id:1});
    add('order_items',{order_id:id,product_name:tag,qty:10,amount_usd:20,amount_cny:130});
    const c=add('commitments',{order_id:id,order_no:'__SMOKE_REPORT'+i,customer_name:tag,qty:10,t0_at:period+'-01T08:00:00',promised_date:period+'-02',actual_ship_date:period+(i===0?'-03':'-02'),review_status:'approved'});
    add('commitment_nodes',{commitment_id:c,code:'P1',name:'__SMOKE裁床',seq:1,plan_days:2,actual_start:period+'-01',actual_end:period+'-01',status:'done'});
    add('commitment_nodes',{commitment_id:c,code:'E1',name:'__SMOKE发运',seq:2,plan_days:2,actual_start:period+'-02',actual_end:period+'-02',status:'done'});
  }
  add('material_requirements',{order_id:11,order_no:'__SMOKE_ORDER11',material_id:1,material_name:'__SMOKE缺料',mat_type:'fabric',unit:'米',need_qty:20,gap_qty:20,gap_amount:20,status:'short',note:tag});

  add('approval_flows',{name:'__SMOKE付款两级审批',target_type:'payment',min_amount:0,max_amount:999999999,steps:JSON.stringify([{role:'finance',name:'财务审核'},{role:'admin',name:'总经理审批'}]),active:1});
  const book=add('price_books',{book_no:'__SMOKE_PRICE',company_id:1,version:1,scope:'factory',currency:'CNY',rate:1,effective_from:'2020-01-01',status:'published',item_count:1,published_by:tag,note:tag,demo_tag:tag});
  add('price_book_items',{book_id:book,style_no:'LEJE-AW-2601',style_name:tag,min_qty:200,max_qty:null,price:60,cost_unit:30,cost_source:'cost_object',gross_margin:50});

  // 聚合抑制与导出行数上限需要真实存在的多个组 / 多张票，不能对空表断言。
  add('employees',{name:'__SMOKE少数组员工',department_id:2,company_id:1,status:'active',remark:tag});
  for(let i=0;i<4;i++)add('ar_invoices',{bill_no:'__SMOKE_AR_EXTRA'+i,customer_id:1,customer_name:'__SMOKE客户1',amount:100,paid_amount:0,currency:'CNY',amount_orig:100,rate:1,status:'unpaid',due_date:'2026-09-30',remark:tag,company_id:1});

};
