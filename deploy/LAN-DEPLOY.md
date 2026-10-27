# 本地部署 + 局域网访问

> 目标：在本机运行系统，让同一 WiFi/局域网内的手机、同事电脑可以访问。
> 已确认：后端监听 `0.0.0.0:3000`（所有网卡），本机 IP `192.168.110.69`。

## 一、启动服务

后端已在构建时把前端 `dist` 一并托管，**只需启动后端**即可同时提供页面和接口。

双击运行：
```
deploy\start-server.bat
```
（会打开一个命令行窗口常驻运行；关闭窗口即停止服务）

> 也可以手动：`cd backend` → `set PORT=3000` → `node src/server.js`

## 二、放行防火墙（关键，否则其他设备连不上）

Windows 当前网络被判为「公用(Public)」，默认拦截入站，**这是局域网打不开的根本原因**。

**最简单：双击 `deploy\allow-lan.bat`**，它会自动弹出 UAC，点「是」即可（只放行 TCP 3000，限定本局域网）。

也可以手动运行 `deploy\open-lan-port.ps1`（右键「使用 PowerShell 运行」）。

管理员命令行等价操作：
```powershell
netsh advfirewall firewall add rule name="ERP Mindmap 3000 (LAN only)" dir=in action=allow protocol=TCP localport=3000 remoteip=localsubnet profile=any
```

该脚本只放行 **TCP 3000**、且限制 `LocalSubnet`（仅本局域网，公网进不来）。
删除规则：`Remove-NetFirewallRule -DisplayName "ERP Mindmap 3000 (LAN only)"`

## 三、访问地址

| 场景 | 地址 |
|---|---|
| 本机 | http://127.0.0.1:3000 |
| 局域网（手机/同事） | http://192.168.110.69:3000 |
| 后台登录 | http://192.168.110.69:3000/login （admin / admin123456） |

> 手机需连**同一个 WiFi**。若打不开，先确认脚本已以管理员运行、且本机 IP 未变（IP 由路由器 DHCP 分配，重启路由可能变化）。

## 四、开机自启（可选）

用「任务计划程序」创建任务：
- 触发器：登录时
- 操作：启动程序 `deploy\start-server.bat`
- 起始于：项目所在目录

## 五、正式上线

公网域名访问请改用 `deploy/DEPLOY.md`（Nginx + PM2）。

---

## 开机自动启动（2026-10-27 配置）

| 项 | 说明 |
|---|---|
| 自启入口 | 启动文件夹 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\start-erp-auto.vbs`（登录后触发） |
| 实际执行 | `deploy/start-erp-auto.bat`（隐藏窗口，无黑框） |
| 日志 | `backend/logs/server.log`（含每次启动时间与 `[net] LAN IP`） |
| 端口去重 | 若 3000 已在监听则跳过，不会重复起第二个实例 |
| 防火墙 | 已有入站规则 `ERP Mindmap 3000 (LAN only)`，TCP 3000 允许 |

**手动测试**：双击 `deploy/start-erp-auto.vbs`（无窗口），或双击 `deploy/start-server.bat`（有窗口，调试用）。

**重启后确认**：
1. `backend/logs/server.log` 末尾应有 `==== starting ERP backend on port 3000 ====` 与 `[net] LAN IP: x.x.x.x`
2. 本机 `http://127.0.0.1:3000`、局域网 `http://<上面那个IP>:3000`

**注意**
- 若开机没起来：任务管理器 → 启动应用 → 看 `start-erp-auto` 是否被禁用，启用即可。
- IP 由 DHCP 分配可能变化，以日志里的 `[net] LAN IP` 为准；要固定可给网卡设静态 IP。
