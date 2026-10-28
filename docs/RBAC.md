# 权限矩阵（RBAC）

> 本文件由 `backend/scripts/rbac-audit.js` 生成，接口有变动请重跑脚本，不要手工改。

> 权限矩阵的单一来源是 `backend/src/access/permissions.js`；前端 `store/perm-table.js` 由脚本生成，仅作首屏兜底。

角色：**系统管理员**（admin） · **总经理**（boss） · **销售跟单**（sales） · **技术打版**（tech） · **生产车间**（production） · **仓库采购**（warehouse） · **财务会计**（finance） · **人事行政**（hr）

`admin` 对所有接口放行（后端 `requireRole` 内直接通过）。

## 一、写接口 × 角色

| 接口模块 | 方法 | 路径 | 系统管理员 | 总经理 | 销售跟单 | 技术打版 | 生产车间 | 仓库采购 | 财务会计 | 人事行政 |
|---|---|---|---|---|---|---|---|---|---|---|
| access | POST | `/exceptions` | ✅ | — | — | — | — | — | — | — |
| access | DELETE | `/exceptions/:id` | ✅ | — | — | — | — | — | — | — |
| access | GET | `/review` | ✅ | — | — | — | — | — | — | ✅ |
| access | GET | `/reviews` | ✅ | — | — | — | — | — | — | ✅ |
| access | POST | `/reviews` | ✅ | — | — | — | — | — | — | — |
| access | POST | `/roles` | ✅ | — | — | — | — | — | — | — |
| access | GET | `/sod` | ✅ | — | — | — | — | — | — | ✅ |
| admin | GET | `/backup` | ✅ | — | — | — | — | — | — | — |
| admin | POST | `/restore` | ✅ | — | — | — | — | — | — | — |
| adminContracts | GET | `/access-logs` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | GET | `/board` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | GET | `/calendar` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | GET | `/certificates` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | POST | `/certificates/:id/view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | GET | `/contracts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | POST | `/contracts` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | GET | `/contracts/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | PUT | `/contracts/:id` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/contracts/:id/archive` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/contracts/:id/milestones` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/contracts/:id/renew` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/contracts/:id/terminate` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/contracts/:id/versions` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/milestones/:id/done` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/milestones/:id/waive` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | GET | `/seal-grants` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | POST | `/seal-grants` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/seal-grants/:id/revoke` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | GET | `/seal-usages` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| adminContracts | POST | `/seal-usages` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/seal-usages/:id/approve` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/seal-usages/:id/borrow` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/seal-usages/:id/reject` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/seal-usages/:id/return` | ✅ | — | — | — | — | — | — | ✅ |
| adminContracts | POST | `/seal-usages/:id/use` | ✅ | — | — | — | — | — | — | ✅ |
| adminExpenses | POST | `/` | ✅ | — | — | — | — | — | ✅ | ✅ |
| adminExpenses | PUT | `/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| adminExpenses | DELETE | `/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| afterSales | GET | `/` | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | — |
| afterSales | POST | `/` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | GET | `/:id` | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | — |
| afterSales | POST | `/:id/accept` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | POST | `/:id/cancel` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | POST | `/:id/note` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | POST | `/:id/recovery` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | POST | `/:id/reject` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | POST | `/:id/settle` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| afterSales | GET | `/meta` | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | — |
| afterSales | POST | `/refund/:id` | ✅ | — | — | — | — | — | ✅ | — |
| afterSales | GET | `/stats` | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/drafts/:id/approve` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/drafts/:id/reject` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/evals/run` | ✅ | — | — | — | — | — | — | — |
| aiCenter | POST | `/extract` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/faq` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | PUT | `/faq/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/gateway` | ✅ | — | — | — | — | — | — | — |
| aiCenter | PUT | `/gateway/:id` | ✅ | — | — | — | — | — | — | — |
| aiCenter | POST | `/gateway/:id/test` | ✅ | — | — | — | — | — | — | — |
| aiCenter | POST | `/handovers` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/handovers/:id/close` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/handovers/:id/take` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/reply` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/risk/:id/ack` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/risk/run` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/weekly/:id/publish` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| aiCenter | POST | `/weekly/generate` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| approvalFlows | POST | `/` | ✅ | — | — | — | — | — | — | — |
| approvalFlows | PUT | `/:id` | ✅ | — | — | — | — | — | — | — |
| approvalFlows | DELETE | `/:id` | ✅ | — | — | — | — | — | — | — |
| assets | POST | `/` | ✅ | — | — | — | — | — | ✅ | ✅ |
| assets | PUT | `/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| assets | DELETE | `/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| assets | POST | `/:id/status` | ✅ | — | — | — | — | — | ✅ | ✅ |
| attendance | POST | `/clock` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| audit | GET | `/` | ✅ | ✅ | — | — | — | — | — | — |
| audit | POST | `/archive` | ✅ | — | — | — | — | — | — | — |
| audit | GET | `/archives` | ✅ | ✅ | — | — | — | — | — | — |
| audit | GET | `/export` | ✅ | ✅ | — | — | — | — | — | — |
| audit | GET | `/facets` | ✅ | ✅ | — | — | — | — | — | — |
| audit | GET | `/stats` | ✅ | ✅ | — | — | — | — | — | — |
| audit | GET | `/verify` | ✅ | ✅ | — | — | — | — | — | — |
| backup | DELETE | `/:id` | ✅ | — | — | — | — | — | — | — |
| backup | GET | `/:id/download` | ✅ | — | — | — | — | — | — | — |
| backup | POST | `/:id/verify` | ✅ | — | — | — | — | — | — | — |
| backup | GET | `/checks` | ✅ | — | — | — | — | — | — | — |
| backup | POST | `/create` | ✅ | — | — | — | — | — | — | — |
| backup | GET | `/list` | ✅ | — | — | — | — | — | — | — |
| backup | GET | `/overview` | ✅ | — | — | — | — | — | — | — |
| backup | GET | `/restore/pending` | ✅ | — | — | — | — | — | — | — |
| backup | POST | `/restore/prepare` | ✅ | — | — | — | — | — | — | — |
| backup | POST | `/restore/rollback` | ✅ | — | — | — | — | — | — | — |
| backup | POST | `/restore/upload` | ✅ | — | — | — | — | — | — | — |
| badDebt | GET | `/aging` | ✅ | ✅ | — | — | — | — | ✅ | — |
| badDebt | GET | `/history` | ✅ | ✅ | — | — | — | — | ✅ | — |
| badDebt | GET | `/policy` | ✅ | ✅ | — | — | — | — | ✅ | — |
| badDebt | PUT | `/policy` | ✅ | — | — | — | — | — | ✅ | — |
| badDebt | POST | `/post` | ✅ | — | — | — | — | — | ✅ | — |
| badDebt | GET | `/preview` | ✅ | ✅ | — | — | — | — | ✅ | — |
| bank | POST | `/accounts` | ✅ | — | — | — | — | — | — | — |
| bank | PUT | `/accounts/:id` | ✅ | — | — | — | — | — | — | — |
| bank | POST | `/auto-match` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/bills` | ✅ | — | — | — | — | — | ✅ | — |
| bank | PUT | `/bills/:id/status` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/import` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/lines/:id/ignore` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/lines/:id/match` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/lines/:id/unmatch` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/reconciliations` | ✅ | — | — | — | — | — | ✅ | — |
| bank | POST | `/reconciliations/:id/confirm` | ✅ | — | — | — | — | — | ✅ | — |
| budget | POST | `/` | ✅ | — | ✅ | — | — | — | ✅ | — |
| budget | PUT | `/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| budget | DELETE | `/:id` | ✅ | — | — | — | — | — | — | — |
| budget | POST | `/:id/activate` | ✅ | — | — | — | — | — | — | — |
| budget | POST | `/:id/close` | ✅ | — | — | — | — | — | — | — |
| budget | POST | `/adjustments` | ✅ | — | ✅ | — | — | — | ✅ | — |
| budget | POST | `/alerts/:id/ack` | ✅ | — | ✅ | — | — | — | ✅ | — |
| cashflow | GET | `/compare` | ✅ | ✅ | — | — | — | — | ✅ | — |
| cashflow | GET | `/plan` | ✅ | ✅ | — | — | — | — | ✅ | — |
| channel | POST | `/after-sales` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | PUT | `/after-sales/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/after-sales/:id/confirm-refund` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/after-sales/:id/receive-return` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/after-sales/:id/reject` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/quotas` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/quotas/:id/sync` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/retail-orders` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/retail-orders/:id/cancel` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/retail-orders/:id/check-pay` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/retail-orders/:id/reserve` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/retail-orders/:id/ship` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/retail-orders/import` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/settlements/:id/confirm` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/settlements/generate` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/shops` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | PUT | `/shops/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | DELETE | `/shops/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| channel | POST | `/shops/:id/verify` | ✅ | — | ✅ | — | — | — | ✅ | — |
| cockpit | GET | `/aging` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | GET | `/forecasts` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | POST | `/forecasts` | ✅ | — | — | — | — | — | ✅ | — |
| cockpit | GET | `/forecasts/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | GET | `/forecasts/:id/variance` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | GET | `/kpis` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | POST | `/kpis/snapshot` | ✅ | — | — | — | — | — | ✅ | — |
| cockpit | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cockpit | GET | `/trend` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| collections | GET | `/` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| collections | GET | `/:id` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| collections | POST | `/:id/assign` | ✅ | — | — | — | — | — | ✅ | — |
| collections | POST | `/:id/close` | ✅ | — | — | — | — | — | ✅ | — |
| collections | POST | `/:id/log` | ✅ | — | ✅ | — | — | — | ✅ | — |
| collections | POST | `/:id/reopen` | ✅ | — | — | — | — | — | ✅ | — |
| collections | GET | `/board` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| collections | GET | `/export` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| collections | POST | `/generate` | ✅ | — | — | — | — | — | ✅ | — |
| collections | GET | `/meta` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| collections | GET | `/stats` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| commitments | POST | `/:id/nodes/:nodeId` | ✅ | — | ✅ | — | ✅ | — | — | — |
| commitments | POST | `/:id/review` | ✅ | — | ✅ | — | ✅ | — | — | — |
| commitments | POST | `/capacity` | ✅ | — | — | — | — | — | — | — |
| commitments | POST | `/order/:orderId/ensure` | ✅ | — | ✅ | — | ✅ | — | — | — |
| confirm | POST | `/changes` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | PUT | `/changes/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/changes/:id/approve` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/changes/:id/reject` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/changes/:id/sign` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/deliveries` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/deliveries/:id/confirm` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/seals` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | DELETE | `/seals/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/seals/:id/reject` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/seals/:id/send` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/seals/:id/tech-approve` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/shipments` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | DELETE | `/shipments/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| confirm | POST | `/shipments/:id/verify` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| costObjects | POST | `/entries` | ✅ | — | — | — | — | — | ✅ | — |
| costObjects | DELETE | `/entries/:id` | ✅ | — | — | — | — | — | ✅ | — |
| costObjects | POST | `/orders/:orderId/collect` | ✅ | — | — | — | — | — | ✅ | — |
| costObjects | POST | `/orders/:orderId/snapshot` | ✅ | — | — | — | — | — | ✅ | — |
| costs | POST | `/:orderId` | ✅ | — | ✅ | — | — | — | ✅ | — |
| costs | POST | `/:orderId/review` | ✅ | — | — | — | — | — | ✅ | — |
| crafts | POST | `/` | ✅ | — | — | ✅ | — | — | — | — |
| crafts | PUT | `/:id` | ✅ | — | — | ✅ | — | — | — | — |
| crafts | DELETE | `/:id` | ✅ | — | — | ✅ | — | — | — | — |
| craftTypes | POST | `/` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| craftTypes | PUT | `/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| craftTypes | DELETE | `/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| credit | GET | `/:customerId` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| credit | PUT | `/:customerId` | ✅ | — | — | — | — | — | ✅ | — |
| credit | POST | `/:customerId/hold` | ✅ | — | — | — | — | — | ✅ | — |
| credit | GET | `/board` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| credit | GET | `/check/:orderId` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| credit | GET | `/config` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| credit | PUT | `/config` | ✅ | — | — | — | — | — | ✅ | — |
| credit | GET | `/export` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| credit | POST | `/overrides` | ✅ | — | — | — | — | — | ✅ | — |
| credit | GET | `/overrides` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| crm | GET | `/commission-rules` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/commission-rules` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/commission-rules/:id/approve` | ✅ | — | — | — | — | — | ✅ | — |
| crm | GET | `/commissions` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/commissions` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/commissions/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/commissions/:id/adjust` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/commissions/:id/link-payroll` | ✅ | — | — | — | — | — | ✅ | — |
| crm | POST | `/commissions/preview` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/cycles` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/cycles` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/cycles/accept-inference` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/cycles/alerts` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/cycles/infer` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/cycles/refresh` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/followups` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/followups` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/handovers` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/handovers` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/handovers/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/leads` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/leads` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/leads/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | PUT | `/leads/:id` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/:id/assign` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/:id/claim` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/:id/follow` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/:id/merge` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/:id/recycle` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/:id/stage` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/import` | ✅ | — | ✅ | — | — | — | — | — |
| crm | POST | `/leads/sweep-pool` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/ranking` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/reports/commission` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/reports/cycle` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | GET | `/targets` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/targets` | ✅ | — | ✅ | — | — | — | — | — |
| crm | GET | `/targets/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| crm | POST | `/targets/:id/approve` | ✅ | — | — | — | — | — | ✅ | — |
| customerProgress | GET | `/meta` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| customerProgress | GET | `/orders` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| customerProgress | GET | `/orders/:id/history` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| customerProgress | GET | `/orders/:id/internal` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| customerProgress | GET | `/orders/:id/preview` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| customerProgress | POST | `/orders/:id/publish` | ✅ | — | ✅ | — | — | — | — | — |
| customerProgress | PUT | `/orders/:id/route` | ✅ | — | ✅ | — | ✅ | — | — | — |
| customerProgress | POST | `/publications/:id/withdraw` | ✅ | — | ✅ | — | — | — | — | — |
| customers | POST | `/` | ✅ | — | ✅ | — | — | — | — | — |
| customers | PUT | `/:id` | ✅ | — | ✅ | — | — | — | — | — |
| customers | DELETE | `/:id` | ✅ | — | ✅ | — | — | — | — | — |
| cutdispatch | POST | `/` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cutdispatch | POST | `/:id/cancel` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cutdispatch | POST | `/:id/close` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cutdispatch | POST | `/:id/receive` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cutdispatch | POST | `/:id/send` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | POST | `/:id/bundles` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | DELETE | `/:id/bundles/:bundleId` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | POST | `/:id/bundles/generate` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | POST | `/:id/finish` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | POST | `/:id/handover` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | POST | `/:id/lots` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | DELETE | `/:id/lots/:lotId` | ✅ | — | — | — | ✅ | ✅ | — | — |
| cuts | POST | `/:id/start` | ✅ | — | — | — | ✅ | ✅ | — | — |
| dataQuality | GET | `/export` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | GET | `/fixes` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | GET | `/issues` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | POST | `/issues/:id/fix` | ✅ | — | ✅ | — | — | — | ✅ | — |
| dataQuality | POST | `/issues/:id/ignore` | ✅ | — | ✅ | — | — | — | ✅ | — |
| dataQuality | POST | `/issues/:id/reopen` | ✅ | — | ✅ | — | — | — | ✅ | — |
| dataQuality | GET | `/reconcile` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | GET | `/rules` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | PUT | `/rules/:code` | ✅ | — | — | — | — | — | — | — |
| dataQuality | POST | `/run` | ✅ | — | ✅ | — | — | — | ✅ | — |
| dataQuality | GET | `/runs` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | GET | `/runs/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| dataQuality | POST | `/runs/:id/fix-all` | ✅ | — | ✅ | — | — | — | ✅ | — |
| dataQuality | GET | `/summary` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| devmaster | POST | `/aliases/:id/disable` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/packs` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/packs/:id/activate` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/projects` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | PATCH | `/projects/:id` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/projects/:id/close` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/projects/:id/milestone` | ✅ | — | ✅ | ✅ | — | — | — | — |
| devmaster | POST | `/projects/:id/stage` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/projects/:id/tasks` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/skus` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | PATCH | `/skus/:id` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/skus/:id/alias` | ✅ | — | — | ✅ | — | — | — | — |
| devmaster | POST | `/tasks/:id/status` | ✅ | — | — | ✅ | — | — | — | — |
| dispatch | POST | `/` | ✅ | — | ✅ | — | ✅ | — | — | — |
| dispatch | DELETE | `/:id` | ✅ | — | ✅ | — | ✅ | — | — | — |
| dispatch | POST | `/:id/settle` | ✅ | — | — | — | — | — | ✅ | — |
| employees | POST | `/` | ✅ | — | — | — | — | — | — | ✅ |
| employees | PUT | `/:id` | ✅ | — | — | — | — | — | — | ✅ |
| employees | DELETE | `/:id` | ✅ | — | — | — | — | — | — | ✅ |
| equipment | POST | `/` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| equipment | PUT | `/:id` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| equipment | GET | `/board` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| equipment | GET | `/capacity` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| equipment | GET | `/capacity-board` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| equipment | GET | `/downtimes` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| equipment | POST | `/downtimes` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| equipment | POST | `/downtimes/:id/cancel` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| equipment | POST | `/downtimes/:id/finish-repair` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| equipment | POST | `/downtimes/:id/safety` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| equipment | POST | `/downtimes/:id/start-repair` | ✅ | — | — | ✅ | ✅ | ✅ | — | — |
| exceptions | GET | `/` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | GET | `/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/assign` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/claim` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/close` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/ignore` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/note` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/reopen` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | POST | `/:id/review` | ✅ | ✅ | — | — | — | — | — | — |
| exceptions | GET | `/daily` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | GET | `/meta` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | GET | `/report` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | GET | `/rules` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | PUT | `/rules/:code` | ✅ | — | — | — | — | — | — | — |
| exceptions | POST | `/scan` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| exceptions | GET | `/stats` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| facility | POST | `/certificates` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | PUT | `/certificates/:id` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/certificates/:id/void` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/dorm/beds/:id/status` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/dorm/checkin` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/dorm/checkout/:stayId` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/dorm/rooms` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | PUT | `/dorm/rooms/:id` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/dorm/transfer` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/meal/accounts` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/meal/accounts/:id/lost` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/meal/accounts/:id/reissue` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/meal/transactions` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/repairs` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/repairs/:id/status` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/safety-checks` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/seal-usages` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/seal-usages/:id/status` | ✅ | — | — | — | — | ✅ | — | ✅ |
| facility | POST | `/seals` | ✅ | — | — | — | — | ✅ | — | ✅ |
| factories | POST | `/` | ✅ | — | ✅ | — | ✅ | — | — | — |
| factories | PUT | `/:id` | ✅ | — | ✅ | — | ✅ | — | — | — |
| factories | DELETE | `/:id` | ✅ | — | ✅ | — | ✅ | — | — | — |
| finance | POST | `/ap` | ✅ | — | — | — | — | — | ✅ | — |
| finance | POST | `/ap/:id/void` | ✅ | — | — | — | — | — | ✅ | — |
| finance | POST | `/ar` | ✅ | — | — | — | — | — | ✅ | — |
| finance | POST | `/ar/:id/void` | ✅ | — | — | — | — | — | ✅ | — |
| finance | POST | `/payments` | ✅ | — | — | — | — | — | ✅ | — |
| finance | POST | `/payments/:id/reverse` | ✅ | — | — | — | — | — | ✅ | — |
| firstArticles | POST | `/` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | PUT | `/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/checks` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | DELETE | `/:id/checks/:cid` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/checks/generate` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/refresh-version` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/reject` | ✅ | — | — | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/release` | ✅ | — | — | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/reopen` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/:id/submit` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/workstations` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | DELETE | `/workstations/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| firstArticles | POST | `/workstations/generate` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| flowChanges | GET | `/audits` | ✅ | ✅ | — | — | — | — | — | — |
| flowChanges | GET | `/changes` | ✅ | ✅ | — | — | — | — | — | — |
| flowChanges | POST | `/changes` | ✅ | — | — | — | — | — | — | — |
| flowChanges | GET | `/changes/:id` | ✅ | ✅ | — | — | — | — | — | — |
| flowChanges | POST | `/changes/:id/publish` | ✅ | — | — | — | — | — | — | — |
| flowChanges | POST | `/changes/:id/reject` | ✅ | — | — | — | — | — | — | — |
| flowChanges | POST | `/changes/:id/rollback` | ✅ | — | — | — | — | — | — | — |
| flowChanges | POST | `/changes/:id/trial` | ✅ | — | — | — | — | — | — | — |
| flowChanges | GET | `/flows` | ✅ | ✅ | — | — | — | — | — | — |
| flowChanges | GET | `/flows/versions` | ✅ | ✅ | — | — | — | — | — | — |
| flowChanges | GET | `/meta` | ✅ | ✅ | — | — | — | — | — | — |
| glBooks | GET | `/accounts` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | GET | `/periods` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | POST | `/periods` | ✅ | — | — | — | — | — | ✅ | — |
| glBooks | POST | `/periods/:period/carry` | ✅ | — | — | — | — | — | ✅ | — |
| glBooks | GET | `/periods/:period/checks` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | POST | `/periods/:period/close` | ✅ | — | — | — | — | — | ✅ | — |
| glBooks | POST | `/periods/:period/generate` | ✅ | — | — | — | — | — | ✅ | — |
| glBooks | POST | `/periods/:period/reopen` | ✅ | — | — | — | — | — | — | — |
| glBooks | GET | `/reports/:type` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | GET | `/reports/:type/export` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | GET | `/vouchers` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | POST | `/vouchers` | ✅ | — | — | — | — | — | ✅ | — |
| glBooks | GET | `/vouchers/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| glBooks | POST | `/vouchers/:id/void` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/companies` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | POST | `/companies` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/companies/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | PUT | `/companies/:id` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/consolidations` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | POST | `/consolidations` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/consolidations/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | DELETE | `/consolidations/:id` | ✅ | — | — | — | — | — | — | — |
| group | POST | `/consolidations/:id/confirm` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/consolidations/:id/export` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | GET | `/intercompany` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | POST | `/intercompany/:id/ignore` | ✅ | — | — | — | — | — | ✅ | — |
| group | POST | `/intercompany/scan` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | GET | `/parties` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| group | POST | `/parties` | ✅ | — | — | — | — | — | ✅ | — |
| group | PUT | `/parties/:id` | ✅ | — | — | — | — | — | ✅ | — |
| group | GET | `/segments` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| hr | POST | `/adjustments` | ✅ | — | — | — | — | — | — | ✅ |
| hr | PUT | `/adjustments/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/adjustments/:id/apply` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/adjustments/:id/approve` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/adjustments/:id/cancel` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/candidates` | ✅ | — | — | — | — | — | — | ✅ |
| hr | PUT | `/candidates/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | DELETE | `/candidates/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/candidates/:id/hire` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/contracts` | ✅ | — | — | — | — | — | — | ✅ |
| hr | PUT | `/contracts/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | DELETE | `/contracts/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/contracts/:id/deliver` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/contracts/:id/renew` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/contracts/:id/terminate` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/movements` | ✅ | — | — | — | — | — | — | ✅ |
| hr | DELETE | `/movements/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/movements/:id/apply` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/movements/:id/cancel` | ✅ | — | — | — | — | — | — | ✅ |
| hr | POST | `/recruitments` | ✅ | — | — | — | — | — | — | ✅ |
| hr | PUT | `/recruitments/:id` | ✅ | — | — | — | — | — | — | ✅ |
| hr | DELETE | `/recruitments/:id` | ✅ | — | — | — | — | — | — | ✅ |
| importops | POST | `/commit` | ✅ | — | — | — | — | — | ✅ | — |
| importops | POST | `/preview` | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | — |
| imports | POST | `/customers` | ✅ | — | ✅ | ✅ | — | — | — | — |
| imports | POST | `/materials` | ✅ | — | ✅ | ✅ | — | — | — | — |
| imports | POST | `/products` | ✅ | — | ✅ | ✅ | — | — | — | — |
| inspection | POST | `/` | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | — |
| integration | POST | `/dispatch` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/endpoints` | ✅ | — | — | — | — | — | — | ✅ |
| integration | PUT | `/endpoints/:id` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/endpoints/:id/rotate-key` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/events/:id/drop` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/events/:id/retry` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/shipments/:id/correct` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/shipments/:id/correct/approve` | ✅ | — | — | — | — | — | — | ✅ |
| integration | POST | `/shipments/:id/correct/reject` | ✅ | — | — | — | — | — | — | ✅ |
| investment | POST | `/` | ✅ | — | — | — | — | — | ✅ | — |
| investment | POST | `/:id/changes` | ✅ | — | — | — | — | — | ✅ | — |
| investment | POST | `/:id/dispose` | ✅ | — | — | — | — | — | ✅ | — |
| investment | POST | `/:id/method` | ✅ | — | — | — | — | — | ✅ | — |
| kpi | POST | `/appeals/:id/accept` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| kpi | POST | `/appeals/:id/decide` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| kpi | POST | `/cycles` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | POST | `/cycles/:id/freeze` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| kpi | POST | `/generate` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | DELETE | `/items/:id` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | POST | `/items/:id/confirm` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| kpi | POST | `/scores/:id/confirm` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| kpi | POST | `/scores/:id/items` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | POST | `/templates` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | PUT | `/templates/:id` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | POST | `/templates/:id/approve` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| kpi | POST | `/templates/:id/new-version` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | POST | `/templates/:id/rules` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | PUT | `/templates/:id/rules/:rid` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | DELETE | `/templates/:id/rules/:rid` | ✅ | — | — | — | — | — | — | ✅ |
| kpi | POST | `/templates/:id/submit` | ✅ | — | — | — | — | — | — | ✅ |
| leaves | POST | `/` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| leaves | DELETE | `/:id` | ✅ | — | — | — | — | — | — | ✅ |
| leaves | POST | `/:id/review` | ✅ | — | ✅ | — | ✅ | — | — | ✅ |
| mail | POST | `/:id/ack` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/:id/answer` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/:id/correct` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/:id/flag` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/:id/question` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/:id/recall` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/:id/retry` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/delegates` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/delegates/:id/revoke` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/send` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mail | POST | `/tasks/:id/done` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mallAdmin | POST | `/accounts` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | PUT | `/accounts/:id` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/accounts/:id/approve` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/inquiries/:id/convert` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/inquiries/:id/quote` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/invites` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/invites/:id/revoke` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/notify` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/prices` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | DELETE | `/prices/:id` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/products` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | PUT | `/products/:id` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | DELETE | `/products/:id` | ✅ | — | ✅ | — | — | — | — | — |
| mallAdmin | POST | `/products/:id/status` | ✅ | — | ✅ | — | — | — | — | — |
| materials | POST | `/` | ✅ | — | ✅ | ✅ | — | — | — | — |
| materials | PUT | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| materials | DELETE | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| materials | POST | `/:id/duplicate` | ✅ | — | ✅ | ✅ | — | — | — | — |
| matflow | POST | `/issues` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/issues/:id/cancel` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/issues/:id/close` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/issues/:id/issue` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/issues/:id/prepare` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/returns` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/returns/:id/confirm` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/stocktakes` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/stocktakes/:id/adjust` | ✅ | — | — | — | — | ✅ | — | — |
| matflow | POST | `/stocktakes/:id/cancel` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/stocktakes/:id/count` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/stocktakes/:id/start` | ✅ | — | — | — | ✅ | ✅ | — | — |
| matflow | POST | `/stocktakes/:id/submit` | ✅ | — | — | — | ✅ | ✅ | — | — |
| mkt | GET | `/assets` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | POST | `/assets` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | GET | `/assets/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | PUT | `/assets/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | DELETE | `/assets/:id` | ✅ | — | — | — | — | — | — | — |
| mkt | POST | `/assets/:id/review` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/assets/:id/revoke` | ✅ | — | ✅ | ✅ | — | — | ✅ | — |
| mkt | POST | `/assets/:id/submit` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/assets/sweep-expired` | ✅ | — | — | — | — | — | ✅ | — |
| mkt | GET | `/calendar` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | GET | `/campaigns` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | POST | `/campaigns` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | GET | `/campaigns/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | PUT | `/campaigns/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/campaigns/:id/approve` | ✅ | — | — | — | — | — | ✅ | — |
| mkt | GET | `/campaigns/:id/attribution` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | POST | `/campaigns/:id/bills` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/campaigns/:id/status` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | GET | `/reports/campaign` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | GET | `/reports/launch` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | GET | `/reports/review` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | GET | `/reviews` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | POST | `/reviews` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | GET | `/reviews/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | POST | `/reviews/:id/actions` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/reviews/:id/actions/:aid` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/reviews/:id/status` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | GET | `/tasks` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | POST | `/tasks` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | GET | `/tasks/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| mkt | PUT | `/tasks/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | DELETE | `/tasks/:id` | ✅ | — | — | — | — | — | — | — |
| mkt | POST | `/tasks/:id/assets` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | DELETE | `/tasks/:id/assets/:aid` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/tasks/:id/status` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/tasks/:id/steps` | ✅ | — | ✅ | ✅ | — | — | — | — |
| mkt | POST | `/tasks/:id/steps/:sid` | ✅ | — | ✅ | ✅ | — | — | — | — |
| notify | GET | `/alerts` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/alerts` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/alerts/:id/cancel` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/alerts/sweep` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/attribution` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/attribution/refresh` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/channels` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/channels` | ✅ | — | — | — | — | — | ✅ | — |
| notify | POST | `/cycle-tasks` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | GET | `/events` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/events` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/frequency` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/frequency` | ✅ | — | — | — | — | — | ✅ | — |
| notify | GET | `/outbox` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | GET | `/outbox/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/outbox/:id/receipt` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/outbox/:id/retry` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/outbox/:id/send` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/outbox/:id/skip` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/outbox/dispatch` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | GET | `/subs` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/subs` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/subs/:customerId/confirm-email` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/subs/:customerId/unsubscribe-marketing` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/subs/:customerId/verify-email` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/templates` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/templates` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/templates/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | PUT | `/templates/:id` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/templates/:id/approve` | ✅ | — | — | — | — | — | ✅ | — |
| notify | POST | `/templates/:id/retire` | ✅ | — | — | — | — | — | ✅ | — |
| notify | POST | `/templates/:id/submit` | ✅ | — | ✅ | — | — | — | — | — |
| notify | GET | `/wechat` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| notify | POST | `/wechat` | ✅ | — | ✅ | — | — | — | — | — |
| notify | POST | `/wechat/sync` | ✅ | — | ✅ | — | — | — | — | — |
| officeSupply | GET | `/board` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/items` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | GET | `/ledger` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | GET | `/low-stock` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | GET | `/meta` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | GET | `/purchases` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/purchases` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | GET | `/purchases/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/purchases/:id/approve` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | POST | `/purchases/:id/cancel` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | POST | `/purchases/:id/order` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | PUT | `/purchases/:id/prices` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | POST | `/purchases/:id/receive` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | GET | `/requests` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/requests` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | GET | `/requests/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/requests/:id/approve` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | POST | `/requests/:id/issue` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/requests/:id/reject` | ✅ | — | — | — | — | — | ✅ | ✅ |
| officeSupply | POST | `/requests/:id/return` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| officeSupply | POST | `/requests/:id/submit` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| orderMaterials | POST | `/` | ✅ | — | — | ✅ | — | — | ✅ | — |
| orderMaterials | PUT | `/:id` | ✅ | — | — | ✅ | — | — | ✅ | — |
| orderMaterials | DELETE | `/:id` | ✅ | — | — | ✅ | — | — | ✅ | — |
| orderNodes | PATCH | `/:id` | ✅ | — | — | — | ✅ | — | — | — |
| orderNodes | DELETE | `/:id` | ✅ | — | — | — | ✅ | — | — | — |
| orderNodes | POST | `/init` | ✅ | — | — | — | ✅ | — | — | — |
| orders | POST | `/` | ✅ | — | ✅ | — | — | — | — | — |
| orders | POST | `/:id/image` | ✅ | — | ✅ | ✅ | — | — | — | — |
| orders | PUT | `/:id/items` | ✅ | — | ✅ | — | — | — | — | — |
| orders | POST | `/batch/transition` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| org | GET | `/dict` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | POST | `/employees/:id/transfer` | ✅ | — | — | — | — | — | — | ✅ |
| org | GET | `/employments` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | POST | `/employments` | ✅ | — | — | — | — | — | — | ✅ |
| org | GET | `/employments/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | POST | `/employments/:id/approve` | ✅ | — | — | — | — | — | ✅ | — |
| org | POST | `/employments/:id/reject` | ✅ | — | — | — | — | — | ✅ | — |
| org | POST | `/employments/:id/submit` | ✅ | — | — | — | — | — | — | ✅ |
| org | GET | `/overview` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | GET | `/positions` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | POST | `/positions` | ✅ | — | — | — | — | — | — | ✅ |
| org | GET | `/positions/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | PUT | `/positions/:id` | ✅ | — | — | — | — | — | — | ✅ |
| org | GET | `/positions/tree` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | GET | `/routes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | GET | `/routes/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | POST | `/routes/:id/confirm` | ✅ | — | — | — | — | — | ✅ | — |
| org | POST | `/routes/:id/status` | ✅ | — | — | — | — | — | ✅ | — |
| org | GET | `/scopes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | GET | `/scopes/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org | POST | `/scopes/:id/approve` | ✅ | — | — | — | — | — | ✅ | — |
| org | POST | `/scopes/:id/reject` | ✅ | — | — | — | — | — | ✅ | — |
| org | POST | `/scopes/sweep` | ✅ | — | — | — | — | — | ✅ | — |
| payable | GET | `/:supplierId` | ✅ | ✅ | — | — | — | — | ✅ | — |
| payable | PUT | `/:supplierId` | ✅ | — | — | — | — | — | ✅ | — |
| payable | GET | `/board` | ✅ | ✅ | — | — | — | — | ✅ | — |
| payable | GET | `/export` | ✅ | ✅ | — | — | — | — | ✅ | — |
| payable | GET | `/schedule` | ✅ | ✅ | — | — | — | — | ✅ | — |
| paymentRequests | GET | `/` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| paymentRequests | POST | `/` | ✅ | — | — | — | — | ✅ | ✅ | — |
| paymentRequests | GET | `/:id` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| paymentRequests | PUT | `/:id` | ✅ | — | — | — | — | ✅ | ✅ | — |
| paymentRequests | DELETE | `/:id` | ✅ | — | — | — | — | ✅ | ✅ | — |
| paymentRequests | POST | `/:id/cancel` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| paymentRequests | POST | `/:id/pay` | ✅ | — | — | — | — | ✅ | ✅ | — |
| paymentRequests | POST | `/:id/submit` | ✅ | — | — | — | — | ✅ | ✅ | — |
| paymentRequests | GET | `/candidates` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| paymentRequests | GET | `/export` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| paymentRequests | GET | `/meta` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| paymentRequests | GET | `/stats` | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| payrolls | GET | `/` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| payrolls | PUT | `/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| payrolls | DELETE | `/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| payrolls | POST | `/:id/confirm` | ✅ | — | — | — | — | — | ✅ | ✅ |
| payrolls | POST | `/:id/pay` | ✅ | — | — | — | — | — | ✅ | ✅ |
| payrolls | POST | `/batch` | ✅ | — | — | — | — | — | ✅ | ✅ |
| payrolls | GET | `/export` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| payrolls | POST | `/generate` | ✅ | — | — | — | — | — | ✅ | ✅ |
| payrolls | GET | `/periods` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| payrolls | GET | `/summary` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| photos | POST | `/` | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | — |
| photos | DELETE | `/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | — |
| photos | POST | `/batch` | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | — |
| pieceWage | GET | `/attendance-board` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/config` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | PUT | `/config` | ✅ | — | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/export` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/meta` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/preview` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/rates` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | POST | `/rates` | ✅ | — | — | — | — | — | ✅ | ✅ |
| pieceWage | PUT | `/rates/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/runs` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | POST | `/runs` | ✅ | — | — | — | — | — | ✅ | ✅ |
| pieceWage | GET | `/runs/:id` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | POST | `/runs/:id/confirm` | ✅ | — | — | — | — | — | ✅ | — |
| pieceWage | GET | `/runs/:id/payslips` | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| pieceWage | POST | `/runs/:id/void` | ✅ | — | — | — | — | — | ✅ | — |
| priceTiers | POST | `/` | ✅ | — | ✅ | ✅ | — | — | — | — |
| priceTiers | DELETE | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| pricing | POST | `/books` | ✅ | — | ✅ | — | — | — | ✅ | — |
| pricing | POST | `/books/:id/archive` | ✅ | — | ✅ | — | — | — | ✅ | — |
| pricing | POST | `/books/:id/items` | ✅ | — | ✅ | — | — | — | ✅ | — |
| pricing | POST | `/books/:id/publish` | ✅ | — | ✅ | — | — | — | ✅ | — |
| pricing | DELETE | `/expenses/:id` | ✅ | — | — | — | — | — | ✅ | — |
| pricing | DELETE | `/items/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| pricing | POST | `/pools` | ✅ | — | — | — | — | — | ✅ | — |
| pricing | POST | `/pools/:id/close` | ✅ | — | — | — | — | — | ✅ | — |
| pricing | POST | `/pools/:id/distribute` | ✅ | — | — | — | — | — | ✅ | — |
| pricing | POST | `/pools/:id/expenses` | ✅ | — | — | — | — | — | ✅ | — |
| pricing | POST | `/pools/:id/revert` | ✅ | — | — | — | — | — | ✅ | — |
| privacy | GET | `/logs` | ✅ | ✅ | — | — | — | — | — | — |
| privacy | GET | `/meta` | ✅ | ✅ | — | — | — | — | — | — |
| privacy | GET | `/rules` | ✅ | ✅ | — | — | — | — | — | — |
| privacy | PUT | `/rules/:id` | ✅ | — | — | — | — | — | — | — |
| privacy | GET | `/stats` | ✅ | ✅ | — | — | — | — | — | — |
| process | GET | `/board` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | GET | `/delegates` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | POST | `/delegates` | ✅ | — | — | — | — | — | — | ✅ |
| process | POST | `/delegates/:id/revoke` | ✅ | — | — | — | — | — | — | ✅ |
| process | POST | `/scan` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| process | GET | `/sla` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | PUT | `/sla/:flowId` | ✅ | — | — | — | — | — | — | — |
| process | GET | `/sop` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | POST | `/sop` | ✅ | — | — | — | — | — | — | ✅ |
| process | GET | `/sop/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | POST | `/sop/:id/ack` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | POST | `/sop/:id/publish` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| process | POST | `/sop/:id/retire` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| process | POST | `/sop/:id/versions` | ✅ | — | — | — | — | — | — | ✅ |
| process | GET | `/tasks` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | POST | `/tasks/:id/delegate` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| process | POST | `/tasks/:id/escalate` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| process | POST | `/tasks/:id/receive` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| process | POST | `/tasks/:id/remind` | ✅ | — | ✅ | — | ✅ | — | ✅ | ✅ |
| prodReport | GET | `/efficiency` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/export` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/lead-time` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/material` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/on-time` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/overview` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/plan-vs-actual` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/quality` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/segments` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| prodReport | GET | `/wip` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| products | POST | `/` | ✅ | — | ✅ | ✅ | — | — | — | — |
| products | PUT | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| products | DELETE | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| purchaseChanges | POST | `/` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/:id/effective` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/:id/submit` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/:id/supplier-confirm` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/:id/void` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | GET | `/board` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| purchaseChanges | GET | `/po/:poId` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| purchaseChanges | GET | `/returns` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| purchaseChanges | POST | `/returns` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/returns/:id/credit` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/returns/:id/physical` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchaseChanges | POST | `/returns/:id/void` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| purchases | POST | `/` | ✅ | — | — | — | — | ✅ | — | — |
| purchases | DELETE | `/:id` | ✅ | — | — | — | — | ✅ | — | — |
| purchases | POST | `/:id/order` | ✅ | — | — | — | — | ✅ | — | — |
| purchases | POST | `/:id/receive` | ✅ | — | — | — | — | ✅ | — | — |
| qc | POST | `/batches` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | PUT | `/batches/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/inspections` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | PUT | `/inspections/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | DELETE | `/inspections/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/inspections/:id/finish` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/issues` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | PUT | `/issues/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/issues/:id/close` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/recalls` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | PUT | `/recalls/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/recalls/:id/notify` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | POST | `/standards` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | PUT | `/standards/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| qc | DELETE | `/standards/:id` | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| quotations | POST | `/` | ✅ | — | ✅ | — | — | — | — | — |
| quotations | PUT | `/:id` | ✅ | — | ✅ | — | — | — | — | — |
| quotations | DELETE | `/:id` | ✅ | — | ✅ | — | — | — | — | — |
| quotations | POST | `/:id/convert` | ✅ | — | ✅ | — | — | — | — | — |
| quotations | POST | `/:id/reprice` | ✅ | — | ✅ | — | — | — | — | — |
| quotations | POST | `/:id/status` | ✅ | — | ✅ | — | — | — | — | — |
| receipts | POST | `/` | ✅ | — | — | — | ✅ | ✅ | — | — |
| receipts | POST | `/:id/cancel` | ✅ | — | — | — | ✅ | ✅ | — | — |
| receipts | POST | `/:id/inspect` | ✅ | — | — | — | ✅ | ✅ | — | — |
| receipts | PUT | `/:id/items/:itemId` | ✅ | — | — | — | ✅ | ✅ | — | — |
| receipts | POST | `/:id/items/:itemId/dispose` | ✅ | — | — | — | ✅ | ✅ | — | — |
| reports | POST | `/` | ✅ | — | — | — | ✅ | — | — | — |
| reports | DELETE | `/:id` | ✅ | — | — | — | ✅ | — | — | — |
| requirements | POST | `/:id/action` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| requirements | POST | `/calc` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| sampleArchives | POST | `/changes/:id/review` | ✅ | — | — | ✅ | — | — | — | — |
| samples | POST | `/` | ✅ | — | ✅ | ✅ | — | — | — | — |
| samples | POST | `/:id/status` | ✅ | — | ✅ | ✅ | — | — | — | — |
| schedule | GET | `/calendars` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | POST | `/calendars` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | POST | `/calendars/fill` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | GET | `/changes` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | GET | `/conflicts` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | POST | `/conflicts/:id/resolve` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | GET | `/load` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | GET | `/meta` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | GET | `/orders` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | GET | `/runs` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | POST | `/runs` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | GET | `/runs/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | POST | `/runs/:id/archive` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | POST | `/runs/:id/publish` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | POST | `/runs/preview` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | GET | `/standards` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| schedule | POST | `/standards` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | PUT | `/standards/:id` | ✅ | — | — | — | ✅ | — | — | — |
| schedule | PATCH | `/tasks/:id` | ✅ | — | — | — | ✅ | — | — | — |
| segments | GET | `/adjustments` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | POST | `/adjustments` | ✅ | — | — | — | — | — | ✅ | — |
| segments | DELETE | `/adjustments/:id` | ✅ | — | — | — | — | — | ✅ | — |
| segments | GET | `/board` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | GET | `/company/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | GET | `/dict` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | GET | `/export` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | GET | `/reports` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | POST | `/reports` | ✅ | — | — | — | — | — | ✅ | — |
| segments | GET | `/reports/:id` | ✅ | — | ✅ | — | — | — | ✅ | — |
| segments | POST | `/reports/:id/confirm` | ✅ | — | — | — | — | — | ✅ | — |
| self | GET | `/adjustments` | ✅ | — | — | — | — | — | ✅ | ✅ |
| self | GET | `/all-requests` | ✅ | — | — | — | — | — | ✅ | ✅ |
| self | POST | `/bind` | ✅ | — | — | — | — | — | — | ✅ |
| self | GET | `/bindings` | ✅ | — | — | — | — | — | — | ✅ |
| self | GET | `/employees-for-bind` | ✅ | — | — | — | — | — | — | ✅ |
| self | GET | `/meta` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | GET | `/overview` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | GET | `/payslips` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | GET | `/payslips/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | GET | `/requests` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | POST | `/requests` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | POST | `/requests/:id/withdraw` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | POST | `/review/:id` | ✅ | — | — | — | — | — | ✅ | ✅ |
| self | GET | `/team` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| self | POST | `/unbind/:userId` | ✅ | — | — | — | — | — | — | ✅ |
| settings | PUT | `/` | ✅ | — | — | — | — | — | — | — |
| sizeTemplates | POST | `/` | ✅ | — | ✅ | ✅ | — | — | — | — |
| sizeTemplates | DELETE | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| skills | POST | `/assess` | ✅ | — | — | — | ✅ | — | — | ✅ |
| skills | GET | `/certs` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | POST | `/certs` | ✅ | — | — | — | ✅ | — | — | ✅ |
| skills | POST | `/certs/:id/revoke` | ✅ | — | — | — | ✅ | — | — | ✅ |
| skills | GET | `/check` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | GET | `/coverage` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | GET | `/expiring` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | GET | `/matrix` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | GET | `/meta` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | POST | `/overrides` | ✅ | — | — | — | — | — | — | ✅ |
| skills | PUT | `/requirements` | ✅ | — | — | — | — | — | — | ✅ |
| skills | POST | `/revoke` | ✅ | — | — | — | ✅ | — | — | ✅ |
| skills | GET | `/stats` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | GET | `/trainings` | ✅ | ✅ | — | ✅ | ✅ | — | — | ✅ |
| skills | POST | `/trainings` | ✅ | — | — | — | ✅ | — | — | ✅ |
| skills | POST | `/trainings/:id/finish` | ✅ | — | — | — | ✅ | — | — | ✅ |
| spot | GET | `/aging` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spot | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spot | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spot | GET | `/returns` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spot | POST | `/returns` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spot | GET | `/returns/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spot | POST | `/returns/:id/cancel` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spot | POST | `/returns/:id/close` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spot | POST | `/returns/:id/inspect` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spot | POST | `/returns/:id/receive` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spot | GET | `/slow-moving` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spot | GET | `/turnover` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | GET | `/approved` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | POST | `/lines/:id/decide` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spotops | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | GET | `/policies` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | POST | `/policies` | ✅ | — | ✅ | — | — | — | — | — |
| spotops | DELETE | `/policies/:id` | ✅ | — | ✅ | — | — | — | — | — |
| spotops | GET | `/runs` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | POST | `/runs` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spotops | GET | `/runs/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | POST | `/runs/:id/archive` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spotops | GET | `/runs/:id/decisions` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| spotops | POST | `/runs/:id/publish` | ✅ | — | ✅ | — | — | ✅ | — | — |
| spotops | GET | `/skus` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| statementFiles | GET | `/` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| statementFiles | GET | `/:id` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| statementFiles | GET | `/:id/preview.csv` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| statementFiles | POST | `/:id/publish` | ✅ | — | — | — | — | — | ✅ | — |
| statementFiles | POST | `/:id/revoke` | ✅ | — | — | — | — | — | ✅ | — |
| statementFiles | POST | `/generate` | ✅ | — | — | — | — | — | ✅ | — |
| statementFiles | GET | `/meta` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| statements | GET | `/:customerId` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| statements | GET | `/customers` | ✅ | ✅ | ✅ | — | — | — | ✅ | — |
| stock | POST | `/adjust` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| stock | POST | `/auto-transfer` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| stock | POST | `/instock` | ✅ | — | — | — | ✅ | ✅ | — | — |
| stock | POST | `/ship` | ✅ | — | — | — | — | ✅ | ✅ | — |
| stock | POST | `/transfer` | ✅ | — | ✅ | — | ✅ | ✅ | — | — |
| supplierEvals | PUT | `/:id` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | POST | `/:id/decide` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | POST | `/:id/recollect` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | GET | `/backup-pick` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supplierEvals | GET | `/backups` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supplierEvals | POST | `/backups` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | POST | `/backups/:id/reject` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | POST | `/backups/:id/verify` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | GET | `/board` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supplierEvals | GET | `/board/:supplierId` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supplierEvals | POST | `/collect` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | GET | `/qualifications` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supplierEvals | GET | `/rectifications` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supplierEvals | POST | `/rectifications/:id/submit` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supplierEvals | POST | `/rectifications/:id/verify` | ✅ | — | ✅ | — | — | ✅ | — | — |
| suppliers | POST | `/` | ✅ | — | ✅ | ✅ | — | ✅ | — | — |
| suppliers | PUT | `/:id` | ✅ | — | ✅ | ✅ | — | ✅ | — | — |
| suppliers | DELETE | `/:id` | ✅ | — | ✅ | ✅ | — | ✅ | — | — |
| supply | GET | `/batches` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/batches` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | GET | `/batches/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/batches/:id/move` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | POST | `/batches/:id/short` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | POST | `/batches/:id/split` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | GET | `/holds` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | GET | `/holds/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/holds/:id/convert` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | POST | `/holds/:id/picked` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | POST | `/holds/:id/release` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | POST | `/holds/expire` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | GET | `/projection` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/projection/refresh` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | GET | `/report` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | GET | `/requests` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/requests` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | GET | `/requests/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/requests/:id/cancel` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | POST | `/requests/:id/confirm` | ✅ | — | ✅ | — | — | — | — | — |
| supply | POST | `/requests/:id/reject` | ✅ | — | ✅ | — | — | — | — | — |
| supply | POST | `/requests/expire` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supply | GET | `/shortages` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| supply | POST | `/shortages/:id/resolve` | ✅ | — | ✅ | — | — | ✅ | — | — |
| supreview | POST | `/confirms/:id/cancel` | ✅ | — | — | ✅ | — | — | — | — |
| supreview | POST | `/confirms/:id/confirm` | ✅ | — | — | ✅ | — | — | — | — |
| supreview | POST | `/packs/:techPackId/approve` | ✅ | — | — | ✅ | — | — | — | — |
| supreview | POST | `/packs/:techPackId/assignment` | ✅ | — | — | ✅ | — | — | — | — |
| supreview | POST | `/packs/:techPackId/assignment/confirm` | ✅ | — | — | ✅ | — | — | — | — |
| supreview | POST | `/packs/:techPackId/confirms` | ✅ | — | — | ✅ | — | — | — | — |
| supreview | POST | `/packs/:techPackId/reviews` | ✅ | — | — | ✅ | — | — | — | — |
| tax | GET | `/dict` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/overview` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/policies` | ✅ | — | — | — | — | — | ✅ | — |
| tax | POST | `/policies` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/preview` | ✅ | — | — | — | — | — | ✅ | — |
| tax | POST | `/runs` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/runs` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/runs/:id` | ✅ | — | — | — | — | — | ✅ | — |
| tax | POST | `/runs/:id/confirm` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/runs/:id/export` | ✅ | — | — | — | — | — | ✅ | — |
| tax | POST | `/runs/:id/void` | ✅ | — | — | — | — | — | ✅ | — |
| tax | GET | `/trend` | ✅ | — | — | — | — | — | ✅ | — |
| techpacks | POST | `/` | ✅ | — | ✅ | ✅ | — | — | — | — |
| techpacks | PUT | `/:id` | ✅ | — | ✅ | ✅ | — | — | — | — |
| techpacks | DELETE | `/:id` | ✅ | — | — | ✅ | — | — | — | — |
| techpacks | POST | `/:id/confirm` | ✅ | — | — | ✅ | — | — | — | — |
| techpacks | PUT | `/:id/detail` | ✅ | — | ✅ | ✅ | — | — | — | — |
| techpacks | POST | `/:id/new-version` | ✅ | — | ✅ | ✅ | — | — | — | — |
| techpacks | POST | `/:id/reject` | ✅ | — | — | ✅ | — | — | — | — |
| techpacks | POST | `/:id/sizes/from-order` | ✅ | — | ✅ | ✅ | — | — | — | — |
| techpacks | POST | `/:id/stage` | ✅ | — | ✅ | ✅ | — | — | — | — |
| users | GET | `/` | ✅ | — | — | — | — | — | — | — |
| users | POST | `/` | ✅ | — | — | — | — | — | — | — |
| users | PUT | `/:id` | ✅ | — | — | — | — | — | — | — |
| warehouse | GET | `/asns` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/asns` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/asns/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/asns/:id/arrive` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/asns/:id/cancel` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/asns/:id/receive` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/asns/:id/ship` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/board` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | GET | `/bundle-ops` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | GET | `/bundles` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/bundles` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | PUT | `/bundles/:id` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/bundles/:id/kit` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/bundles/:id/unbundle` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | GET | `/freight/bills` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/freight/bills` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/freight/bills/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/freight/bills/:id/match` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/freight/bills/:id/settle` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | POST | `/freight/items/:id/resolve` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/freight/rates` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/freight/rates` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/locations` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/locations` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | PUT | `/locations/:id` | ✅ | — | ✅ | — | — | ✅ | — | — |
| warehouse | GET | `/receipts` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | GET | `/receipts/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| warehouse | POST | `/receipts/:id/putaway` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | GET | `/asns` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | GET | `/asns/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | POST | `/asns/:id/boxes` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | POST | `/asns/:id/eta` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | POST | `/asns/:id/legs` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | GET | `/candidates` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | GET | `/capacity` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | GET | `/dict` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | POST | `/legs/:legId/arrive` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | GET | `/overview` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | GET | `/suggest` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | GET | `/waves` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | POST | `/waves` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | GET | `/waves/:id` | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| whplan | POST | `/waves/:id/cancel` | ✅ | — | — | — | — | ✅ | — | — |
| whplan | POST | `/waves/:id/items/:itemId/pick` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | POST | `/waves/:id/pack` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | POST | `/waves/:id/release` | ✅ | — | ✅ | — | — | ✅ | — | — |
| whplan | POST | `/waves/:id/ship` | ✅ | — | — | — | — | ✅ | — | — |

## 二、前端按钮权限表（permissions.js）

| 权限名 | 允许角色 |
|---|---|
| `order.create` | 销售跟单 |
| `order.export` | 销售跟单、财务会计 |
| `order.dispatch` | 销售跟单、生产车间 |
| `order.instock` | 仓库采购、生产车间 |
| `order.ship` | 仓库采购 |
| `qc.write` | 生产车间、技术打版 |
| `photo.write` | 生产车间、仓库采购、技术打版、销售跟单 |
| `inspection.write` | 销售跟单、生产车间、技术打版、财务会计 |
| `production.write` | 生产车间、技术打版 |
| `equipment.write` | 生产车间、仓库采购 |
| `confirm.write` | 销售跟单、技术打版、生产车间 |
| `channel.write` | 销售跟单、财务会计 |
| `mall.write` | 销售跟单 |
| `quote.write` | 销售跟单 |
| `quote.convert` | 销售跟单 |
| `development.write` | 技术打版、销售跟单 |
| `development.review` | 技术打版 |
| `cost.write` | 财务会计、销售跟单 |
| `cost.review` | 财务会计 |
| `craft.write` | 技术打版 |
| `material.write` | 技术打版、财务会计 |
| `node.write` | 生产车间 |
| `report.write` | 生产车间 |
| `fa.write` | 生产车间、技术打版 |
| `fa.release` | 生产车间、技术打版 |
| `fa.workstation` | 技术打版、生产车间 |
| `mail.write` | 销售跟单、技术打版、财务会计、生产车间、仓库采购、人事行政 |
| `customer.write` | 销售跟单 |
| `product.write` | 销售跟单、技术打版 |
| `factory.write` | 生产车间、销售跟单 |
| `stock.write` | 仓库采购、生产车间 |
| `purchase.write` | 仓库采购 |
| `supplier.write` | 仓库采购 |
| `receipt.write` | 仓库采购、生产车间 |
| `employee.write` | 人事行政 |
| `hr.write` | 人事行政 |
| `facility.write` | 人事行政、仓库采购 |
| `integration.write` | 人事行政 |
| `leave.write` | 销售跟单、技术打版、财务会计、生产车间、仓库采购、人事行政 |
| `leave.review` | 人事行政、生产车间、销售跟单 |
| `payroll.write` | 人事行政、财务会计 |
| `piecewage.write` | 人事行政、财务会计 |
| `piecewage.approve` | 财务会计 |
| `kpi.write` | 人事行政 |
| `kpi.review` | 人事行政、销售跟单、生产车间 |
| `admincontract.write` | 人事行政 |
| `asset.write` | 人事行政、财务会计 |
| `expense.write` | 人事行政、财务会计 |
| `dq.write` | 财务会计 |
| `wh.write` | 仓库采购、销售跟单 |
| `gl.write` | 财务会计 |
| `spot.write` | 仓库采购、销售跟单 |
| `ai.write` | 销售跟单、技术打版、财务会计、生产车间、仓库采购、人事行政 |
| `budget.write` | 财务会计、销售跟单 |
| `bank.write` | 财务会计 |
| `group.write` | 财务会计 |
| `cockpit.write` | 财务会计 |
| `mkt.write` | 销售跟单、技术打版 |
| `mkt.review` | 财务会计 |
| `org.write` | 人事行政 |
| `org.approve` | 财务会计 |
| `tax.write` | 财务会计 |
| `crm.write` | 销售跟单 |
| `crm.approve` | 财务会计 |
| `supply.write` | 销售跟单、仓库采购 |
| `supply.confirm` | 销售跟单 |
| `pattern.material` | 技术打版 |
| `pattern.pattern` | 技术打版 |
| `pattern.craft` | 技术打版 |
| `pattern.sample` | 技术打版、生产车间 |
| `pattern.biz` | 销售跟单 |
| `pattern.audit` | 财务会计、生产车间 |
| `pattern.review` | 技术打版 |
| `settings.write` | 系统管理员 |
| `user.manage` | 系统管理员 |
| `baddebt.read` | 系统管理员、总经理、财务会计 |
| `baddebt.write` | 系统管理员、财务会计 |
| `collection.read` | 系统管理员、总经理、财务会计、销售跟单 |
| `collection.write` | 系统管理员、财务会计、销售跟单 |
| `collection.close` | 系统管理员、财务会计 |
| `exception.read` | 系统管理员、总经理、销售跟单、技术打版、生产车间、仓库采购、财务会计、人事行政 |
| `exception.write` | 系统管理员、销售跟单、技术打版、生产车间、仓库采购、财务会计、人事行政 |
| `exception.review` | 系统管理员、总经理 |
| `exception.rule` | 系统管理员 |
| `prodreport.read` | 系统管理员、总经理、生产车间、财务会计、技术打版、销售跟单 |
| `flowchange.read` | 系统管理员、总经理 |
| `flowchange.write` | 系统管理员 |
| `skill.read` | 系统管理员、总经理、人事行政、生产车间、技术打版 |
| `skill.write` | 系统管理员、人事行政、生产车间 |
| `skill.rule` | 系统管理员、人事行政 |
| `self.read` | 系统管理员、总经理、销售跟单、技术打版、生产车间、仓库采购、财务会计、人事行政 |
| `self.submit` | 系统管理员、总经理、销售跟单、技术打版、生产车间、仓库采购、财务会计、人事行政 |
| `self.manage` | 系统管理员、人事行政、财务会计 |
| `self.bind` | 系统管理员、人事行政 |
| `custprogress.read` | 系统管理员、总经理、销售跟单、技术打版、生产车间 |
| `custprogress.publish` | 系统管理员、销售跟单 |
| `custprogress.route` | 系统管理员、销售跟单、生产车间 |
| `aftersale.read` | 系统管理员、总经理、销售跟单、quality、生产车间、仓库采购、财务会计 |
| `aftersale.write` | 系统管理员、销售跟单、quality、生产车间、仓库采购 |
| `aftersale.refund` | 系统管理员、财务会计 |
| `statementfile.read` | 系统管理员、总经理、财务会计、销售跟单 |
| `office.read` | 系统管理员、总经理、销售跟单、技术打版、生产车间、仓库采购、财务会计、人事行政 |
| `office.apply` | 系统管理员、销售跟单、技术打版、生产车间、仓库采购、财务会计、人事行政 |
| `office.manage` | 系统管理员、人事行政、财务会计 |
| `statementfile.publish` | 系统管理员、财务会计 |
| `hr.pii` | 人事行政 |
| `crm.pii` | 销售跟单、财务会计 |
| `supplier.pii` | 仓库采购、财务会计 |
| `payroll.sensitive` | 财务会计、人事行政 |
| `bankaccount.sensitive` | 财务会计 |
| `contract.sensitive` | 财务会计、总经理 |
| `privacy.read` | 系统管理员、总经理 |
| `privacy.admin` | 系统管理员 |
| `paymentreq.read` | 系统管理员、总经理、财务会计、仓库采购 |
| `paymentreq.write` | 系统管理员、财务会计、仓库采购 |
| `paymentreq.pay` | 系统管理员、财务会计、仓库采购 |
| `cashflow.read` | 系统管理员、总经理、财务会计 |
| `payable.read` | 系统管理员、总经理、财务会计 |
| `payable.write` | 系统管理员、财务会计 |
| `credit.read` | 系统管理员、总经理、财务会计、销售跟单 |
| `credit.write` | 系统管理员、财务会计 |
| `audit.read` | 系统管理员、总经理 |
| `audit.archive` | 系统管理员 |
| `approvalflow.manage` | 系统管理员 |
| `process.write` | 人事行政 |
| `process.review` | 人事行政、财务会计、生产车间 |
| `notify.write` | 销售跟单 |
| `notify.approve` | 财务会计 |
| `whplan.write` | 仓库采购、销售跟单 |
| `whplan.ship` | 仓库采购 |
| `schedule.write` | 生产车间 |
| `schedule.publish` | 生产车间 |
| `spotops.write` | 销售跟单、仓库采购 |
| `spotops.policy` | 销售跟单 |
| `segment.write` | 财务会计 |
| `matflow.write` | 仓库采购、生产车间 |
| `matflow.adjust` | 仓库采购 |
| `pricing.pool` | 财务会计 |
| `pricing.book` | 财务会计、销售跟单 |
| `investment.write` | 财务会计 |
| `cutdispatch.write` | 生产车间、仓库采购 |
| `devmaster.write` | 技术打版 |
| `devmaster.milestone` | 技术打版、销售跟单 |
| `supreview.write` | 技术打版 |
| `importops.commit` | 财务会计 |

## 三、一致性检查

✅ 前后端权限口径一致，未发现矛盾。
