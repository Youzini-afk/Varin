# Varin 原生桌面

`packages/tauri` 是共享 Varin 工作台的 Tauri 3 / CEF 桌面适配器。它包含真实 Browser Use 原生页面、透明 OSR 合成、桌宠、Computer Use 呈现、平台菜单与通知、受管 Node Host、原桌面数据和安装升级交接，不是另一套产品后端。

## 运行边界

- 本地模式启动随包 Node 的原 Application Host；远端模式不启动 Catalog、Knowledge 或本地工作区。需要本机 Browser、桌宠或后台连接时，才启动轻量原 owner 协调入口。
- UI 继续使用 `application-client` 的 HTTP、观察与 desktop 合同。只有 `src/native.ts` 导入 Tauri renderer API。每个工作台、Mini Chat 保留自己的 Host 与凭据。
- 主界面、Browser Use、匿名网页渲染使用不同 CEF context。任意网站不接收 Tauri IPC、Host token 或桌面命令；桌宠装饰层也没有业务桥。
- Browser Use 的自动化与用户介入是同一个原生页面，不通过截图或 iframe 冒充嵌入。页面关闭、下载取消、网络取消、更新退出都等待原操作或进程的真实回执。
- 统一 CEF 为 `156.0.15` / Chromium `156.0.8078.80`，Rust binding `156.3.0+156.0.15`；Tauri `3.0.0-alpha.5`、CEF runtime `3.0.0-alpha.6`。补丁来源和范围在 `src-tauri/vendor/tauri-runtime-cef/VARIN-PATCH.md`。固定 SDK 摘要在 `scripts/cef-runtime.lock.json`。
- 沙箱必须开启，远程调试端口关闭，系统 secret storage 不降级。Windows 使用官方 CEF sandbox bootstrap 与真实 broker；Linux 不添加 `--no-sandbox`，不全局改变 user namespace 或 AppArmor 策略。

## 开发与验证

```sh
bun install --frozen-lockfile
bun run --cwd packages/tauri test
bun run --cwd packages/tauri type-check
bun run --cwd packages/tauri test:tooling
bun run --cwd packages/tauri test:native
node packages/tauri/scripts/stage-desktop.mjs
bun run --cwd packages/tauri dev
```

原生构建还需固定 CEF SDK、Rust 工具链和当前平台系统依赖。完整命令与产物说明见 [打包和 CI](scripts/README.md)。不要用系统 Node、旧 Electron 可执行文件或随意下载的浏览器填补正式 runtime manifest。开发 receipt 与生产 qualification 是不同边界。

Linux 文件选择使用 XDG portal，普通确认直接用 GTK4，避免 GTK3/GTK4 混用和依赖外部 zenity。系统托盘或通知不可用时基础工作台仍可启动；相关能力报告实际不可用，窗口不会仅隐藏到不存在的托盘。

Linux 显示协议边界（x64、arm64 相同）：

- X11：当前原生 Browser 子窗口嵌入路径。
- Wayland 会话 + XWayland：通过 XWayland 运行同一 X11 路径；发行包必须声明 XWayland 会话依赖，不能把 X11 CI 当成完整 Wayland 会话验收。
- 纯 Wayland、没有 XWayland：当前不支持原生 Browser 子窗口嵌入。CEF [嵌入 Ozone/Wayland 的上游问题](https://github.com/chromiumembedded/cef/issues/2804) 仍需架构实现。仅更改 Chromium 开关不能替代外部窗口嵌入；完整路线需要同一页的多图层 OSR 合成、输入/IME、拖放与原生弹窗父窗口接线，不得另建页面或用轮询截图降级。

原生 smoke 使用显式临时数据目录与固定请求标识。它通过产品真实 Node BrowserOwner/Puppeteer/CEF 管道、认证 Host 二进制帧流和操作系统进程状态验证 11 条路径，并等待真实 native drain。它不开放任意远程 JS/CDP 端口，也不让超时变成操作完成。GUI smoke 不等于安装、跨屏、输入法、系统授权或性能验收。

## 数据、平台与发布

- [适配、深链接和旧数据迁移](DOCUMENTATION.md)
- [通知身份、Action Center 和实际验证边界](NOTIFICATIONS.md)
- [构建、签名、旧更新器和新更新器交接](scripts/README.md)
- [完整产品性能采集与待验收边界](scripts/benchmark.md)
- [原始完整迁移设计](../../docs/design/tauri-desktop-migration.md)

当前分支仍按真实证据控制替换：没有对应平台安装/沙箱/数据恢复验收与签名资格的候选不能成为 production release。保留旧 Electron 的 exporter 与转换安装格式不等于把 Electron 再作为新工作台运行时。原旧 profile 不删除，不能把已知 cookie/localStorage 迁移声称为所有网站会话迁移。

没有以编译结果替代 GUI 证据，也没有填写未经同版本、同配置、全进程树测量的内存或性能改善数字。
