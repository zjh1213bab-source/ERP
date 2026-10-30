# 本机常驻服务（Windows）

让 `backend`（Express + SQLite）在这台机器上长期挂着：**登录后自动启动、进程挂了自动拉起**。
不需要管理员权限，不依赖 nssm / pm2 之类的外部程序。

## 文件

| 文件 | 作用 |
|---|---|
| `erp-server.ps1` | 守护进程：启动 node、写日志、退出后自动重启（3s 起，反复挂指数退避到 60s） |
| `erp-server.config.json` | 配置：应用目录、node 路径、端口、日志目录、停止标记路径 |
| `start-erp.cmd` | **手动启动**（前台可见，能看日志滚动；关窗口即停）——调试用 |
| `stop-erp.cmd` | **停止**：写停止标记 → 等守护收尾 → 兜底按命令行结束本项目 node，并确认端口释放 |
| `install-autostart.ps1` | 把自启项写进「启动文件夹」；`-Uninstall` 取消自启 |

## 常用命令

```powershell
# 启动（前台可见）
deploy\win\start-erp.cmd

# 停止
deploy\win\stop-erp.cmd

# 安装 / 取消「登录自动启动」
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\win\install-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\win\install-autostart.ps1 -Uninstall
```

访问：`http://127.0.0.1:3000`（局域网用 `http://<本机IP>:3000`，服务监听 `0.0.0.0`）。

## 日志在哪

`backend/data/logs/`

| 文件 | 内容 |
|---|---|
| `erp-server-YYYYMMDD.log` | 守护事件：启动 / node 退出码 / 等待多久重启 / 停止。**排查先看这个** |
| `run-<时间戳>.out.log` | 该次 node 的标准输出（启动横幅等） |
| `run-<时间戳>.err.log` | 该次 node 的错误输出 —— **起不来看这里** |
| `erp-server.stop` | 停止标记（`stop-erp.cmd` 写，守护读到就退出；下次启动自动清掉） |

单次 `run-*.log` 保留 3 天，主日志超过 10MB 自动转存一份 `erp-server-prev.log`。

## 为什么不用计划任务 / Windows 服务

- **Windows 服务**：安装要管理员权限。本机当前是普通会话，装不了。
- **计划任务（schtasks）**：本机安全策略把 `schtasks.exe` 列入程序黑名单，禁止调用。
- **VBS（wscript）**：同样被列为 LOLBin 禁止调用。

所以用「启动文件夹 + cmd」，链路上只有 `cmd → powershell → node`，全部可见可验证。

## 已知限制（重要）

1. **是「登录后自启」，不是「开机即启」**。机器重启后若无人登录，服务不会跑。
   要真正开机即启（无人登录也跑）必须装成 Windows 服务，需要管理员执行：
   ```powershell
   # 管理员 PowerShell 里（示例意图，未在本机验证）
   #   nssm install ErpServer "C:\...\node.exe" "src/server.js"
   #   nssm set ErpServer AppDirectory "D:\wk\2026-10-26-09-45-32\erp-mindmap\backend"
   #   nssm start ErpServer
   ```
2. **`ExecutionPolicy` 默认是 Restricted**（本机各 scope 都是 Undefined）。
   所有入口都显式带 `-ExecutionPolicy Bypass`，不需要改机器策略；直接双击 `.ps1` 会报
   「禁止运行脚本」，那是正常的，请走 `.cmd`。
3. **node 路径写死在 `erp-server.config.json`**。升级 node（或换机器）后要改这一项，
   否则守护会在日志里报「node 不存在」并退出。
4. **单实例保护**：端口已被占用时守护直接退出，不会起第二个实例抢同一份 SQLite。
   所以「重启服务」的正确姿势是先 `stop-erp.cmd` 再启动，不要直接再点一次启动。
5. 当前会话里如果用脚本去「隐藏启动」，在某些受限环境会被安全策略拦（不允许脚本派生
   powershell 子进程）—— 这跟登录时由系统触发是两回事，登录自启不受影响。
