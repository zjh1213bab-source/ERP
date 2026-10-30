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
| `restart-erp.cmd` | **真正的重启（要管理员）**：停任务 → 杀掉占用端口的 node → 启任务 → 校验是否加载了最新代码 |
| `reload-erp.cmd` | **换代码（不要管理员）**：写重载标记，守护自己结束 node 再拉起 |
| `install-autostart.ps1` | 把自启项写进「启动文件夹」；`-Uninstall` 取消自启 |

## 改完代码怎么让它生效

后端改完**必须重启进程**才生效。这里的坑很具体：

> node 是守护用 `Start-Process` 起的**独立进程**，Windows 不会因为父进程（守护）退出就把它带走。
> 所以「停计划任务」只杀掉守护，node 继续活着占端口；紧接着「启动计划任务」，
> 新守护发现端口被占 → 立刻退出。**净效果：什么都没换，跑的还是旧代码**，而 `/api/health` 依旧 200。

正确做法：

```bat
:: 普通权限、守护在跑时（最常见）
deploy\win\reload-erp.cmd

:: 守护没在跑、或改了本目录的守护脚本本身（要管理员）
deploy\win\restart-erp.cmd
```

两个脚本最后都会打印 `/api/health` 里的 `pid` / `started_at` / `code_stamp`，并跟磁盘上源码的
最新修改时间比对，直接给出「✓ 已加载最新代码」或「✗ 仍是旧代码」。**不用再靠猜。**


## 两种部署方式

### 方式 A：计划任务（推荐，需要管理员）—— 真正的「开机即启」

不需要任何登录，机器一开机服务就跑；node 挂了由守护拉起，守护本身挂了由任务每分钟重试。

```powershell
# 管理员窗口（以管理员身份运行 PowerShell / 命令提示符）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\wk\2026-10-26-09-45-32\erp-mindmap\deploy\win\install-startup-task.ps1

# 卸载（只删任务，不动数据与代码）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\wk\2026-10-26-09-45-32\erp-mindmap\deploy\win\install-startup-task.ps1 -Uninstall
```

任务名 `ErpServer`，配置：触发=**系统启动**，身份=**SYSTEM**，动作=`powershell -File erp-server.ps1`，
失败每分钟重试（最多 99 次），不限运行时长，已在跑就不再起第二个。

**几个容易误判的点**：

- 安装后打印的「上次结果码 **267009**」= `0x41301` = **任务正在运行**，不是错误码；
- 在**普通（非管理员）窗口**里用 `Get-ScheduledTask -TaskName ErpServer` 会报"找不到" ——
  那是**权限不够看不到**，不是没装上（任务文件 ACL 只给管理员/SYSTEM）。要查请在管理员窗口查；
- 想确认"服务是不是任务起的"，看进程树：`node ← powershell ← svchost.exe(承载 Schedule 服务)`；
- 因为 node 由 **SYSTEM** 运行，`stop-erp.cmd` 需要**以管理员身份**运行才杀得掉；
- 任务只在启动时触发，手动停掉后**不会**被自动拉起（等下次开机）。要立刻再起：
  管理员窗口 `Start-ScheduledTask -TaskName ErpServer`。

### 方式 B：启动文件夹（无需管理员）—— 登录后才起

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\win\install-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\win\install-autostart.ps1 -Uninstall
```

写入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ERP-Server.cmd`。
**限制**：必须有人登录才会启动；如果已经装了方式 A，这一项是重复的（我们的守护有单实例保护，
第二个会自己退出，但日志会刷一行"端口已在监听"），建议只保留一种。

## 常用命令

```powershell
# 启动（前台可见）
deploy\win\start-erp.cmd

# 停止
deploy\win\stop-erp.cmd

# 换代码后重启（普通权限；守护在跑就行）
deploy\win\reload-erp.cmd

# 真正的重启 / 救活（要管理员；会杀掉占端口的 node 再启任务）
deploy\win\restart-erp.cmd

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
| `erp-server.reload` | 重载标记（`reload-erp.cmd` 写，守护读到就换掉 node；处理完自己删掉） |

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
4. **单实例保护分两种**：端口被**本项目** node 占用时，守护会**接管**（继续守着它，
   不再起第二个）——这修掉了「停任务只杀守护、node 被留下、再启一次直接退出，等于没重启」的问题；
   端口被**别的程序**占用时守护才退出（不误伤别人的服务）。
   所以「重启服务」不要用「停任务再启任务」，用 `restart-erp.cmd`。
5. 当前会话里如果用脚本去「隐藏启动」，在某些受限环境会被安全策略拦（不允许脚本派生
   powershell 子进程）—— 这跟登录/开机时由系统触发是两回事，系统触发不受影响。
6. **`param()` 默认值里不能写 `$PSScriptRoot`**：用 `powershell -File` 调用它时是空字符串，
   会抛「Join-Path : 无法将参数绑定到参数"Path"，因为该参数为空字符串」。本目录脚本统一改成
   进脚本第一行 `Split-Path -Parent $MyInvocation.MyCommand.Path`（两种调用方式都可靠）。
7. 启动文件夹里还留着一个更早的 `start-erp-auto.vbs`（调 `deploy\start-erp-auto.bat`）。
   它自己会检查端口：忙就跳过，所以和计划任务不冲突，可当兜底保留 ——
   但它**没有自动重启**能力，正式部署以方式 A 为准。
