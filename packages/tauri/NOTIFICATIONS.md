# 原生通知与 Windows 激活

桌面通知是原 Host / renderer 事件的系统呈现，不持有第二份会话或任务状态。共享观察器在 `application-host/lib/platform/notification-listener.ts`；Electron 入口和 Tauri Node 平台 owner 复用它。远端客户端不为监听通知而启动本地 Application Host、Catalog 或数据库。

## 数据与所有权

- `NativeNotifications` 对原始 Host 身份和原通知 tag/content 做 5 秒去重。`requireHidden` 检查实际应用窗口焦点，不把桌宠或普通浏览器网页当主应用。
- 点击目标由 native 捕获的窗口 bootstrap 决定。通知 payload 中的 `runtimeConfig`、`sourceUrl` 不能替换目标、指定 URL 或执行命令。
- Windows OS 只得到 `varin-toast:v1:<随机 UUIDv4>`。私有 pending 表把 token 映射到当时的 Host、窗口和会话；不向 toast XML、命令行、注册表或日志写入 bearer、请求头、工作目录或 thread ID。
- banner 点击和 COM 激活可能同时到达，但 pending token 只消费一次。未知、格式错误或上一进程遗留的 token 不导航。冷启动正常打开 Varin，不能恢复旧 JS / native 进程已丢失的会话点击对象；不为此持久化 Host 凭据。
- 远端 HTTP SSE 通过现有 native CEF 网络服务。相同 Host 的多个窗口共用观察连接；切换目标或凭据先等待 reader 和底层 transport 的真实取消回执。最后关闭远端窗口的保活由 desktop 原生内存 ledger 决定。
- 原 relay 通知仍由已存在的加密 renderer transport 交付；后台观察器接受 relay-only 空 HTTP origin 的身份，但不会把 relay bearer 发到猜测的 HTTP SSE 路径。这没有引入第二套 relay 协议实现。

## Windows 实现

`native_notifications_windows.rs` 使用 Windows Runtime toast 和真正的 `INotificationActivationCallback` / `IClassFactory`。只保留 toast 的 Activated 回调不足以覆盖 Action Center；COM 注册也是 Electron 45 原实现所做的事。

独立 MTA 线程持有 COM apartment、class registration、toast 和 callback。正常空闲时阻塞在命令通道，不用 timer 或轮询；OS 回调只排队到 owner。退出先移除 toast callbacks、释放 pending，再 revoke COM class、关闭 apartment 并 join 线程。

banner 超时不是通知生命周期结束。超时或用户滑走 banner 后仍保留点击能力。后续真实通知活动查询该 AUMID 的系统 history，以释放已经从 Action Center 移除的通知；正在显示且尚未进入 history 的新 toast 不提前回收。该查询不是空闲轮询，也没有人为最多保留 N 条的业务限制。

安装器沿用原 AUMID `dev.varin.desktop`。COM CLSID 为 `{34EDFA49-F833-482E-A268-C1D3610E6F17}`；开发版使用独立 AUMID / CLSID，不能覆盖正式版。注册合同为：

- `Software\Classes\AppUserModelId\dev.varin.desktop` 的 `CustomActivator` 指向上述 CLSID。
- `Software\Classes\CLSID\{CLSID}\LocalServer32` 是带引号的实际 CEF bootstrap EXE 路径，加 `--varin-notification-activation`，不是 Cargo build-only stub。
- NSIS 按用户选择的安装 scope 写入注册；每次 native 启动刷新实际登录用户的 HKCU 注册，覆盖 per-machine 安装场景。原 application PNG 为 `IconUri`，与 tray 共享同一编译资源。
- 卸载仅在 LocalServer32、owner EXE 和 CLSID 仍匹配本安装时清理自己的值，不能删除另一安装路径的新注册。普通机器卸载不能遍历其他用户的私有 registry hive。
- 不需要额外运行时下载、手工注册 COM 或让用户添加协议处理器。签名 / 安装产物仍按现有发布流程准备；OS 自身通知权限、Focus Assist 和企业策略不能由应用绕过。

通知冷启动标志不携带导航数据，也不绕过单实例机制。已运行进程注册的 COM factory 接收激活；没有窗口时点击由 native 根据捕获的 Host 重建窗口。进程完全退出后的历史通知启动正常单实例入口。

## 可复现检查

在已有 Rust 工具链上安装相应 MSVC target，然后运行：

```sh
rustup target add x86_64-pc-windows-msvc
node packages/tauri/scripts/check-windows-notifications.mjs --offline
```

没有依赖缓存时省略 `--offline`。`--target aarch64-pc-windows-msvc` 检查 ARM64；`--target-dir <独立目录>` 可复用小型 metadata 缓存。脚本使用项目实际的 Windows 依赖声明和实际源文件，不下载或编译 CEF，也不靠 mock Windows API。包含 token / XML / dismissal / installer identity 的原生纯测试。

2026-11-03 本次环境执行的检查：

- 上述脚本：x86_64 Windows MSVC native owner 类型检查和 4 个纯合同测试。
- `native_presentation.rs` 独立 Rust 测试：8 个通过，覆盖 locale、真实活动状态、审批/会话溢出、Host 去重，以及上述 Windows 合同。
- Web `desktop-notification-owner`、`native-network-owner`、`desktop-host-session`：21 个测试通过；包含 browser-only session 不启动本地 Host 的真实私有通知事件链路、跨 Host / 凭据切换等待取消、relay 不外泄。
- 原 Electron notification-listener：7 个测试通过；共享 native-i18n：4 个测试通过，验证 9 个翻译 locale 的新增提示与全部占位符完整性。Electron TypeScript 类型检查通过。
- Application Host tests 的 TypeScript 类型检查在通知链路落地时通过；最新并发代码复查发现 `desktop-deep-links.ts` 第 18 / 75 行的 `exactOptionalPropertyTypes` 错误，已交该模块 owner 处理。该最新状态不能记作整个 Application Host 类型检查通过。

实际工作区日志保存在 `/tmp/varin-windows-notification-check.log`、`/tmp/varin-host-notifications-tscheck.log` 和 `/tmp/varin-electron-notifications-tscheck.log`。这些是当次机器的检查输出，不是已提交的安装验收证据；可用上述脚本重跑并保存发布所需记录。

## 必须补充的真实平台验收

本次 Linux 无图形环境的编译 / 单元检查不等于安装后的 Windows、macOS 或 Linux 通知服务验收。发布记录需包含以下实际结果，不能用 “API 编译成功” 代替：

1. 正式签名 Windows 安装包的当前用户 / 所有用户安装；验证通知归属和原图标，而非开发版或 Terminal 身份。
2. 本地与远端 Host 同时打开，发送有相同 thread ID 的通知；banner 点击、banner 自动消失后 Action Center 点击、手动滑走 banner 后点击均回到发出通知的 Host / thread。
3. 关闭所有远端窗口后收到通知；点击重建相应远端窗口。随后完全退出进程，再从历史通知冷启动，只正常打开 Varin，不根据旧 token 猜测 Host。
4. 明确删除通知、清空 Action Center、Focus Assist / 禁用通知、快速连续点击、Host 切换、退出与点击竞态，检查资源回收与一次性导航。
5. Electron 升级到 Tauri、保留旧 Start Menu shortcut、更新后 EXE 路径变化、并存安装卸载，验证 AUMID / COM 注册没有指向旧 EXE 或误删新安装。
6. macOS 的原 bundle 身份、Glass 声音和点击；Linux D-Bus 的 tap / close、通知守护进程不在场、窗口关闭后唤起。以上都需实机记录。

参考：[Microsoft DesktopToasts 示例](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/DesktopToasts/CPP/DesktopToastsSample.cpp)、[Windows Community Toolkit 注册实现](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs)、[Electron 45 COM activator](https://github.com/electron/electron/blob/v45.2.1/shell/browser/notifications/win/windows_toast_activator.cc)、[Toast Dismissed 事件](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotification.dismissed)。
