/**
 * 生产工序服务
 *
 * 原先是「默认 13 道工序硬编码在这个文件里」。节点改成可自定义之后，
 * 节点的来源是**流程模板**（`node_templates` / `node_template_items`），
 * 所以这里的 `ensureNodes` 只是一个转发 —— 逻辑只有一份，在 `services/nodeFlow.js`。
 *
 * 保留这个文件是因为 `routes/orderNodes.js` 和 `services/orderFlow.js` 都从这里取，
 * 而且 `DEFAULT_NODES` 这个常量在老脚本里被引用过。改成 re-export 而不是删掉，
 * 是为了让调用方一行都不用改，同时避免出现两套「默认节点」定义
 * （两套定义的下场是：改了一处，另一处还在用旧的那份，且没人会发现）。
 */
const { ensureNodes, BUILTIN_CODES } = require('./nodeFlow');

/** 老调用方还在用这个名字：数组形式的内置工序名 */
const DEFAULT_NODES = Object.values(BUILTIN_CODES);

module.exports = { DEFAULT_NODES, ensureNodes };
