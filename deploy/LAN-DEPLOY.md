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

Windows 当前网络被判为「公用(Public)」，默认拦截入站。**以管理员身份**运行：

```
deploy\open-lan-port.ps1
```

右键 →「使用 PowerShell 运行」；或管理员 PowerShell 执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\open-lan-port.ps1
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
