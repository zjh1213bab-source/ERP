/**
 * 工序节点「点开后弹什么」的类型清单（**唯一来源**）
 * ============================================================
 * 三处必须认同同一份：
 *   1. `services/nodeFlow.saveItem()` 保存配置时校验 panel；
 *   2. `services/nodePanel.panel()` 决定弹窗渲染哪一块；
 *   3. 配置页 `NodeFlow.vue` 的下拉选项。
 *
 * 之前 1 和 2 各有一份写死的清单。加「生产分配」时改了一份漏了另一份，
 * 表现是配置页能选中、一保存就报「弹窗类型只能是：通用 / 面料采购明细…」——
 * 而那条报错里根本没提新类型，等于让人对着错提示猜。
 *
 * 为什么单独一个文件：`nodeFlow ← orderAssign ← nodePanel` 已是一条链，
 * nodePanel 反向引 nodeFlow 会成环。放这里谁都能引，且无依赖。
 */
const PANEL_LABEL = {
  generic: '节点信息',
  assign: '生产分配',
  purchase_fabric: '面料采购明细',
  purchase_accessory: '辅料采购明细',
  purchase_all: '面辅料采购明细'
};

/** 只允许这几种：面板类型是配置项，不能由前端传什么就渲染什么 */
const PANELS = Object.keys(PANEL_LABEL);

module.exports = { PANEL_LABEL, PANELS };
