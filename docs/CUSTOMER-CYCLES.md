# 客户下单周期与预警

客户管理可绑定有效 ERP 业务员账号；设置周期 1–3650 天，0 关闭预警。无正式订单时从启用周期时刻计时；有订单时采用最近正式订单日期。超过周期才预警（等于周期当天不发送）。

近1年/2年为滚动12/24个月正式订单，排除草稿及作废状态，采用订单保存的人民币金额快照。统计不代表收款金额。预警投递至业务员的 ERP 内部邮件，未接入外部 SMTP。默认每15分钟检查，停用客户/账号不发送。最近订单、业务员、周期设置共同去重；普通资料编辑不重复发信。邮件投递、事件及去重标记在同一数据库事务中提交，失败回滚。

字段：customers.owner_user_id（复用）、order_cycle_days、cycle_started_at、cycle_version。更新以 cycle_version 乐观锁防止覆盖。接口 GET /api/customers/salespeople 提供同主体有效账号；客户列表返回 owner_name、last_order_date、days_since_order、cycle_overdue、orders_1y/2y、amount_1y/2y。

部署：schema.js 新装结构与 db.js 补列同步维护；前端 build；后端重新加载并验证 code_stamp。局域网任务独立设置 CUSTOMER_CYCLE_SCHEDULER=1，其他任务仍按 ERP_SCHEDULER 原配置。停机时不会发信，启动后补查。现有客户默认未绑定且周期0，不会擅自发信。

验证：定向服务测试13项；真实浏览器页面5项；单公司冒烟2209项、多主体2320项均通过；RBAC1146接口/167权限/0问题；结构373表/445索引一致；冒烟库数据体检无残留、无孤儿。局域网客户统计及业务员接口只读验证通过。
