# Computer Use 原生辅助程序与构建交付

状态：Windows 原生实现与 Host/交付接线已落地，平台实机验收仍待完成。2026-11-05。

## 当前实现

Windows 的生产入口是构建阶段生成的 `VarinComputer.exe`，Application Host 直接启动随本代产物发布的
程序。旧 PowerShell/C# 桌面驱动与动态编译入口已移除。Linux 仍使用 Python；macOS 保持现有 Swift helper。

原设计的执行责任不变：ComputerService、Agent 身份、控制权、输入排序、观察记录、工具回执和远端路由仍由
现有 owner 管理。辅助程序只持有本次进程的 Windows API/COM、截图资源和合成输入状态，不创建另一套 runtime、
权限服务、会话数据库、自更新服务或监听端口。

| 责任 | 当前入口 |
| --- | --- |
| 独立原生 crate、协议和可移植目标规则 | [varin-computer-windows](../../kernel/crates/varin-computer-windows) |
| HWND/进程与多窗口选择 | [window.rs](../../kernel/crates/varin-computer-windows/src/windows/window.rs) |
| MTA UIA、属性缓存、树、重定位与焦点 | [uia.rs](../../kernel/crates/varin-computer-windows/src/windows/uia.rs) |
| 合成输入、状态与释放 | [input.rs](../../kernel/crates/varin-computer-windows/src/windows/input.rs) |
| 同用户本机控制管道 | [control.rs](../../kernel/crates/varin-computer-windows/src/windows/control.rs) |
| PrintWindow/屏幕复制与 WIC PNG/JPEG | [capture.rs](../../kernel/crates/varin-computer-windows/src/windows/capture.rs) |
| 工具操作与回执协调 | [operations.rs](../../kernel/crates/varin-computer-windows/src/windows/operations.rs) |
| Host 启动、关联、取消和真实退出 | [driver-host.ts](../../packages/web/application-host/lib/computer/driver-host.ts) |
| 构建、缓存和产物核验 | [build-helper.mjs](../../packages/computer-driver/windows/build-helper.mjs) |

## 不变合同与边界

- 保留原工具名、参数、NDJSON 请求 ID、gesture 进度与输入回执，不增加模型可见的原生后端选择。
- UIA 对象只在专用 MTA 工作线程创建和使用；缓存请求批量取当前查询所需属性。跨线程只传请求和序列化结果。
- 独立 stdin 监视处理 Host EOF；控制管道不排在普通请求或 UIA 后。管道仅本机、当前用户 SID、单实例单连接。
- 取消先标记原请求，再与实际 SendInput/PostMessage 共用短临界区释放已跟踪按键/按钮。UIA、同步窗口消息、截图不持有输入锁。
- 普通取消不永久退役健康进程；撤权/关闭先 fence 再取得释放确认，Host 等原进程真正退出。未知动作与 writer 已停止是不同事实。
- Windows 查看器使用单独 capture 角色，不初始化 UIA，不接受输入；并发观看者复用现有帧读取与持有关系。
- 元素按 RuntimeId、唯一 AutomationId/类型、唯一名称/类型重新定位，歧义拒绝。焦点和控件归属绑定所选窗口而不只绑定 PID。
- 输入前核对窗口身份、几何、DPI、焦点及指针归属。截图来源、物理尺寸、多屏负原点和缩放信息保留。
- 默认真实输入保留 Unicode/UTF-16 代理对、组合键、点击、拖动与滚动；显式 accessibility 和兼容原生控件 app_post 路径保留。
- SendInput 接受不等于应用业务完成。set_value 只有可读反馈一致才为 verified；取消保留部分效果，响应丢失保持 unknown，不自动重发。
- 动作成功而补充观察失败保留动作回执。新实例不能发送“抬起所有键”假装清理旧实例，否则会影响用户实际按住的键。
- stdout 只有协议；诊断不输出键入正文、截图、剪贴板或 provider 返回的潜在私密描述。来源 MIT 声明继续保留。
- asInvoker 与 per-monitor DPI manifest 不请求提升。UIPI 等系统拒绝保留原始 API 结果，不伪造确定原因或自动抬升整个应用。

## 交付

`bun run computer:build` 在 Windows 使用固定 Rust 工具链、Visual Studio C++ 工具与 Windows SDK，支持
x64/ARM64。crate 不链接 varin-runtime、Storage、TDB 或 Wasmtime。仅 Windows 目标链接系统 GUI/COM 库。

开发产物位于 `packages/computer-driver/windows/build`；正式 Host candidate 仅携带
`computer-driver/windows/{VarinComputer.exe,manifest.json}`。缓存依据源码、Cargo.lock、目标架构、工具链、
SDK/资源编译器、构建参数、版本、清单和图标。失败不发布不配套的新 Host，也不覆盖上一有效代。

启动以 ping/capabilities 核对协议版本和构建身份，不截图、抢焦点或发送/释放输入。运行时缺件提示显式构建或重新安装，
不启动编译器。Electron 使用真实 app.asar.unpacked 路径，独立 Host 和远端 Host 消费自己的目标平台产物；
移动端和纯浏览器资源不携带 helper。

PE 核验包括架构和 DLL 导入，构建使用静态 CRT。开发产物明确标识 unsigned；独立 Host 可配置证书指纹与时间戳签名，
Electron 沿用其发行配置覆盖 helper 本身，摘要在最终签名字节确定后更新。构建阶段可用 Windows PowerShell 检查
Authenticode，这不重新引入运行时桌面脚本。签名身份与某款安全软件是否误报仍是不同证据。

## 验证与剩余验收

可移植测试覆盖实际协议、回执状态、Unicode 边界、歧义重定位和窗口选择函数。Windows 原生测试额外覆盖真实
EXE/控制管道的握手、提前取消、健康重用、永久退役、EOF 退出，以及不读取屏幕的 WIC PNG/JPEG 内存编码/解码。
Host 测试覆盖版本不符、消息关联、响应丢失和独立释放。构建测试覆盖 PE、签名字节摘要、缓存和失败保留旧代。

这些测试不替代以下目标平台证据，不能将跨目标 cargo check 描述为实际运行通过：

1. 从最终 Windows x64/ARM64 安装路径启动，无旧脚本/C# 源码或编译器，完成观察、输入、取消、释放、关闭。
2. 使用临时可控窗口验证 UIA 多窗口/歧义、输入后的焦点变化、中文与补充平面字符、不同 DPI/多屏坐标。
3. 真正阻塞的 UIA provider 下仍取得释放结果，释放后旧请求不再注入，旧进程确实退出。
4. 发送前拒绝、部分输入、响应丢失和动作成功后的截图失败各保留其真实结果。
5. 用户接管、远端分配、查看器持有关系、关闭窗口与应用退出仍由原 owner 完成。
6. 正式证书签名、完整安装/升级产物、首次可用时间、复用延迟、闲置内存和查看器资源变化。

实机验收只操作临时目录和可控测试窗口，不使用用户私人应用或内容。源码实施、编译检查、平台测试、签名和安装包
观察分别记录；没有取得的证据保持待验收，不用替身或未执行的命令补成通过。

完整平台合同见 [Computer Driver README](../../packages/computer-driver/README.md)、
[Host Computer 文档](../../packages/web/application-host/lib/computer/DOCUMENTATION.md) 和[资源](../resources.md)。
