/**
 * 上线检查清单（Go-live Checklist）—— 建表
 *
 * ## 这一版做的三件事
 *
 * 1. `golive_rounds`  **一次上线评估**（不是一张永久的清单）。
 *    每次要上线就跑一轮，冻结当时的全部检查结果；换一天再跑是另一轮。
 *    这样「上线那天到底验了什么」是能回看的，而不是一份被反复勾选的静态文档。
 *
 * 2. `golive_items`  **逐项落库**。每一项记录：自动检查的结果文字、人工项的勾选人、
 *    证据（单号/路径/截图/签字单号）、不适用理由。挂在内存或 JSON 里就没法回答
 *    「这条是谁在什么时候判它通过的、凭据是什么」。
 *
 * 3. **能自动验的自动验**。冒烟残留、孤儿行、默认密码、备份文件是否真的在盘上、
 *    借贷是否平衡……这些每轮都要看、而且人看容易走神的东西交给代码。
 *    人只负责「培训签收」「并行运行计划」这类真的需要判断的事项。
 *
 * ## 为什么不复用 deploy/GO-LIVE-CHECKLIST.md
 *
 * 那份是**运维部署**视角（装 Node / 配 Nginx / 开端口），是给装机的人看的操作手册。
 * 这一张是**上线决策**视角（数据干不干净、权限收没收回、备份能不能恢复、财务口径对不对），
 * 是给签字的人看的。两者不重叠：装好了不等于能上线，能上线也不代表装对了。
 */
const { db } = require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS golive_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_no TEXT NOT NULL UNIQUE,                  -- GL+ymmdd+3
  scope TEXT NOT NULL DEFAULT 'production',       -- production 正式库 / demo 演示库（口径不同：正式库要求无演示数据）
  env_label TEXT,                                 -- 环境标签（生产 / 预发 / 客户现场），人填
  plan_date TEXT,                                 -- 计划上线日
  app_version TEXT,
  status TEXT NOT NULL DEFAULT 'draft',           -- draft 评估中 / ready 可签署 / blocked 有阻塞 / signed 已签署 / withdrawn 已撤回
  auto_total INTEGER NOT NULL DEFAULT 0,
  auto_pass INTEGER NOT NULL DEFAULT 0,
  auto_fail INTEGER NOT NULL DEFAULT 0,
  auto_warn INTEGER NOT NULL DEFAULT 0,
  manual_total INTEGER NOT NULL DEFAULT 0,
  manual_done INTEGER NOT NULL DEFAULT 0,
  na_total INTEGER NOT NULL DEFAULT 0,
  blocker_open INTEGER NOT NULL DEFAULT 0,        -- 未解除的阻塞项数（>0 不许签「准予上线」）
  snapshot TEXT,                                  -- 生成时的全部检查结果（JSON），冻结用
  conclusion TEXT,                                -- 签署结论：go / conditional / no_go
  sign_note TEXT,
  signed_by TEXT,
  signed_at TEXT,
  withdrawn_reason TEXT,
  created_by TEXT,
  demo_tag TEXT,                                  -- 演示数据标记（清理按它删，不靠轮次号或备注猜）
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_refresh_at TEXT                            -- 最近一次重跑自动项的时间
);

CREATE TABLE IF NOT EXISTS golive_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  section TEXT NOT NULL,                          -- data / access / backup / finance / runtime / org
  item_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,                                    -- 这一项为什么重要（写给签字的人看）
  how TEXT,                                       -- 怎么验（自动项写检查器口径，人工项写动作）
  kind TEXT NOT NULL DEFAULT 'manual',            -- auto / manual
  auto_check TEXT,                                -- 检查器键（kind=auto 时必填）
  severity TEXT NOT NULL DEFAULT 'required',      -- blocker 阻塞 / required 必需 / nice 建议
  status TEXT NOT NULL DEFAULT 'pending',         -- pass / fail / warn / na / pending
  result TEXT,                                    -- 自动检查的结论（含数字），或人工填的结论
  evidence TEXT,                                  -- 证据：文件路径 / 单号 / 截图说明
  owner TEXT,                                     -- 责任人
  done_by TEXT,
  done_at TEXT,
  na_reason TEXT,                                 -- 判「不适用」必须写理由
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_glr_status ON golive_rounds(status);
CREATE INDEX IF NOT EXISTS idx_glr_no ON golive_rounds(round_no);
CREATE INDEX IF NOT EXISTS idx_gli_round ON golive_items(round_id, section, sort);
CREATE INDEX IF NOT EXISTS idx_gli_status ON golive_items(round_id, status);
CREATE INDEX IF NOT EXISTS idx_gli_key ON golive_items(round_id, item_key);
`);

console.log('上线检查清单：2 张表 + 5 个索引已就绪');
console.log('  golive_rounds  一次上线评估（冻结检查结果与签署）');
console.log('  golive_items   逐项记录（自动结论 / 人工勾选 / 证据 / 不适用理由）');
