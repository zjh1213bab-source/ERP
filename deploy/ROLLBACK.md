# 回滚预案（上线前必须留底）

## 一、留底清单

| 物料 | 位置 | 说明 |
|---|---|---|
| 上一版发布包 | `packages/erp-mindmap-v1.68.7-20261030.zip` | 可整体回退到 1.68.7 |
| 当前发布包 | `packages/erp-mindmap-v1.68.16-20261031.zip` | 本次上线版本（2214 文件 / 36.4MB） |
| 上线前数据库备份 | 备份中心 `BK20261031-01.db`（`backend/data/backups/`） | 已做完整性校验与恢复演练，见下 |
| 重置前历史库 | `packages/backup-before-reset-20261031022645.db` | 演示库时期的数据，只作追溯 |
| 初始化导入前库 | `packages/backup-before-dt-import-20261031031349.db` | 导入 144 人之前的空库 |

包一律用 `backend/scripts/pack-release.js`（`npm run pack`）产出：
用 Compress-Archive / 系统 bsdtar 会把中文名按 GBK 写入且不置 UTF-8 标志位，Linux 解压会乱码。

## 二、代码回滚（服务异常时）

```bat
:: 1) 停服务（普通权限即可，写重载/停止标记让守护自己收尾）
deploy\win\stop-erp.cmd

:: 2) 解压上一版包到临时目录，用其中的 backend / frontend 覆盖当前目录
::    （保留 data/ 与 .env：数据与环境配置不在包里）

:: 3) 起服务并确认版本
deploy\win\start-erp.cmd
curl http://127.0.0.1:3000/api/health
```

`/api/health` 里的 `code_stamp.newest_at` 必须与磁盘源码最新修改时间一致，
否则说明加载的还是旧进程（node 是独立进程，停任务不等于停 node）。

## 三、数据回滚（改错数据 / 迁移失败时）

优先用备份中心：备份 → 选中 `BK20261031-01` → 恢复（下一进程生效）→ 回滚可用 `restore/rollback`。

手工兜底（服务必须先停，否则会覆盖正在写的库）：

```bat
deploy\win\stop-erp.cmd
copy /Y backend\data\backups\BK20261031-01.db backend\data\erp-mindmap.db
del /Q backend\data\erp-mindmap.db-wal backend\data\erp-mindmap.db-shm
deploy\win\start-erp.cmd
```

**注意**：WAL 模式下必须先删 `-wal` / `-shm`，否则 SQLite 会用旧 WAL 把复制的库"补"回去，
表现为"恢复了但数据没变"。

## 四、恢复演练记录（2026-10-31 实测）

| 项 | 结果 |
|---|---|
| 备份文件 | `BK20261031-01.db`（4.58MB，sha256 已由备份中心记录） |
| 独立打开 | `PRAGMA integrity_check` → **ok** |
| 结构 | 367 表 / 437 索引（与生产一致） |
| 行数比对 | employees 144 / departments 21 / attendance 373 / users 2 / dingtalk_sync_runs 3 —— **全部与生产一致** |

结论：这份备份**可以真的恢复出当前系统**，不是"一份希望"。

## 五、本次上线的已知风险（用户已确认接受）

1. **两个账号仍是弱密码**（admin/admin123456、朱佳豪 123456）—— 局域网内知道地址的人即可登录后台。
   改密后无需改代码，改完重跑上线检查即可消掉该阻塞项。
2. **客户 / 产品 / 物料档案为空** —— 开单时会「选不到」，需边用边录。
3. **财务期间 2026-09 未建、期初余额未录** —— 首月结账没有起点，由财务自行建期间。
4. `NODE_ENV` 仍是开发值：**故意不切 production**。因为生产模式下启动自检会直接拒绝启动
   （默认口令未改会被判 fatal），一旦切换，服务会在下次重启时起不来。
   → 正确顺序：先改密，再设 `NODE_ENV=production`。
