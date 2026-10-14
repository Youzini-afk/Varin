# 能力补齐设计

本文记录已讨论确定、尚待实现的能力设计。当前实现与支持边界以[运行时](runtime.md)、
[工作台](workbench.md)、[扩展](extensions.md)和[资源](resources.md)为准。
完整环境验收留到后续，相关场景见[运行时验收](runtime-acceptance.md)。

## 1. Documents 批量修改

### 目标与归属

支持包含文本编辑、创建、重命名和删除的完整工作区修改，供 LSP 重构、工作台命令和扩展共同使用。
客户端 Document Registry 继续拥有缓冲；Host Documents 协调修改；Rust 文件服务与 Recovery 保存
磁盘操作及恢复事实。普通用户的重构操作直接属于 Documents，无需创建 Agent Run。

现有批量入口只支持文本修改。其 [LSP 转换器](../packages/ui/src/lib/language-services/workspace-edit.ts)
还会把文本与资源操作拆成两组。新计划必须保留原始顺序，例如：

```text
创建 a.ts → 编辑 a.ts → 重命名为 b.ts → 编辑 b.ts
```

[LSP WorkspaceEdit 规范](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/types/workspaceEdit.md)
要求按资源操作在 documentChanges 中的顺序执行。每个文本编辑集合按其对应文档版本解释，
后续步骤使用此前步骤产生的路径与文档状态。

### 准备、执行与撤销

准备阶段在内存中推演有序操作，解析路径变化、版本、覆盖选项和 change annotations，生成预览。
计划保留实际 Host、工作区、资源身份、磁盘 revision 和缓冲版本；准备不写文件，也不保存用户草稿。

| 操作 | 产品行为 |
| --- | --- |
| 文本编辑 | 修改对应缓冲，保持当前保存方式；关闭的文档也通过 Registry 承接修改 |
| 创建后编辑 | 创建文件，后续文本编辑进入对应缓冲，保持未保存状态 |
| 重命名 | 移动磁盘资源，同时迁移打开的文档、草稿、标签页及语言服务身份 |
| 删除含未保存修改的文件 | 预览明确展示受影响草稿，按现有审阅流程确认，并保留可恢复内容 |

执行前重新核对计划涉及的资源。纯文本批次继续一次提交全部缓冲；含文件操作的批次由 Documents
在原文件租约和缓冲协调机制下执行，只协调受影响资源。语言服务与编辑器订阅者收到与实际结果一致的通知。

Recovery 在首次修改前保存原始状态与计划，随后记录每一步的真实结果。中途失败时按已执行部分尝试恢复，
恢复前核对版本，避免覆盖用户随后产生的修改。无法恢复的部分进入现有恢复界面，并标明文件及状态。
同一批次保留一个撤销入口，撤销也使用这些原始记录。

LSP 的 failureHandling 声明与实际能力一致：纯缓冲提交保持原子性，含文件操作的失败采用尝试撤销的语义。
跨磁盘、编辑器和外部程序不能承诺绝对原子事务。响应丢失时查询原操作结果，不能重新执行整批修改。

主要入口：[Registry](../packages/ui/src/lib/documents/registry.ts)、
[Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)、
[Recovery](../packages/web/application-host/lib/recovery/journal-engine.ts)。

## 2. 图像生成与图像编辑工具

### 分别配置，分别加载

两个工具分别拥有自己的模型配置，可以选择同一个模型，也可以选择不同模型。

| 工具 | 模型配置 | 主要输入 |
| --- | --- | --- |
| 图像生成 | 生成模型 | 提示词及模型支持的生成参数 |
| 图像编辑 | 编辑模型 | 原图、修改要求、可选参考图和蒙版，以及模型支持的编辑参数 |

**某个工具未配置模型，该工具就不进入 Agent 工具集合，其 schema 和说明也不注入请求。**
配置生成模型不会自动启用编辑工具，反之亦然。两项配置不隐式继承对话模型或彼此的模型。

模型目录区分图像输出、参考图和蒙版编辑等能力；能理解图片不等于能生成或编辑图片。
设置面板按工具用途展示可选模型，并说明对应可用参数。配置错误、模型不可用与未配置分别处理，
界面展示实际配置状态，不把调用失败解释成用户没有配置模型。

工具配置由现有设置 owner 保存。模型与能力准备就绪后，通过原工具组合机制发布 schema 与实现。
修改或清空配置在下一次模型请求的受保护工具更新边界生效；已受理交换保留原工具绑定，
正在执行的调用保留原模型配置。失败候选沿用现有组合发布规则，不能报告切换成功。

### 调用、结果与资源

两个工具共用模型执行、认证、媒体资源、用量记录和取消机制。图像协议适配器进入现有模型执行层，
配置与凭据仍由原 Host 服务提供。Agent 调用的是普通工具；模型请求归属于该工具的原始 Operation，
不需要借用 Pi 会话，也不另建图像任务数据库。

工具说明介绍用途、输入与返回内容。参数按所选模型能力编译和校验；参考图与蒙版使用可读取的资源引用，
权限沿原调用与资源服务核验。

生成或编辑结果作为图片资源保存，工具返回有序媒体内容、资源引用及必要的结果信息：

- UI 显示图片预览；模型上下文通过现有媒体契约接收结果，不把 base64 写进文本说明。
- 后续编辑引用原图片，保留本次输出与输入的关联。
- 保存到项目经过原文件服务；生成成功但保存失败时，图片资源仍可继续使用。
- 提供方返回临时链接时，由原执行方取回并保存图片后再发布稳定资源引用。

每次请求记录实际模型、请求身份、返回、用量和提供方报告的费用。图像调用可能按张或其他方式计费；
缺少 token 或费用数据时保持未知，不能用零值代替，也不能把估算当作实际账单。

取消沿原执行传递，已经收到的图片和用量仍需保存。服务端是否完成尚不明确时保留原状态；
读取回执或恢复连接不会重新触发生成。生成与文件保存分别记录结果。

主要入口：[工具组合](../kernel/crates/varin-kernel/src/run_tools.rs)、
[模型目录与绑定](../packages/web/application-host/lib/kernel/model-authority.ts)、
[模型适配器](../kernel/crates/varin-runtime/src/providers/README.md)、
[工具执行与媒体契约](../kernel/crates/varin-runtime/src/execution.rs)。

## 3. 同进程扩展的更新交接

### 用户操作与持久意图

为受信任、在 Application Host 进程内执行的扩展提供“重启并应用”，替代手动 disable、apply、restart、enable。
普通独立进程扩展继续使用已有候选准备、发布与旧版本退役机制。

重启前核对候选包、已审查权限和依赖，并在现有扩展 Catalog 中保存原始更新意图。意图关联确切的
旧选中版本、候选 artifact、组合成员和本次执行结果。普通“应用更新”不自动重启 Host；用户选择重启时，
沿现有 Host 停止流程处理正在执行的任务。

### 在新进程中完成准备与发布

旧代码进入共享进程后，清理回调不能证明其所有影响都已消失。因此新版本在干净进程中准备：

1. 新 Host 读取原更新意图，为受影响扩展准备候选代码及其固定依赖，避免先装载同一扩展的旧代码。
2. 声明组合更新的候选等待具名 Surface 成员准备；无关扩展、其他窗口不自动加入。
3. 已连接的 contribution consumer 完成真实挂载准备，由原 Surface host 提交对应 preparation/generation 回执。
4. Catalog 再次核对原候选、权限、意图与准备结果，提交版本选择。

等待 Surface 的更新保留为待完成状态，不把整个 Host 启动挂在窗口等待上。未参与更新的服务继续工作，
用户仍能通过现有扩展管理入口处理候选。普通已选版本启动与恢复保持原生命周期。

提交前失败时保留旧选中版本。若候选代码已经进入进程，恢复旧版本需要再次启动干净进程。
本次失败写回原更新记录，下一次启动不会无限重试同一个失败候选；用户可以恢复旧版本或明确再次尝试更新。
提交后的响应丢失或旧资源清理失败则读取原提交事实，不能把已发布版本改写成未应用。

更新状态区分待重启、正在准备、等待具名界面、已应用和失败。模块 ready 与界面已挂载使用各自真实回执，
不建立持久的全局窗口注册表，也不扩大为所有窗口的原子更新。

主要入口：[ApplicationExtensionRuntime](../packages/extension-host/src/application-runtime.ts)、
[Host supervisor](../packages/extension-host/src/broker-supervisor.ts)、
[现有 Host/Surface 更新合同](extensions.md#candidate-updates-and-failure-ordering)。

## 4. macOS 与 Wayland Computer Use

### 共享控制与平台驱动

ComputerService 继续拥有桌面发现、assignment、输入协调、用户控制和远端路由；平台组件负责系统观察与输入。
同一物理桌面保持一个 controller、多个 observer，不把不同应用窗口视为独立输入设备。

新平台实现承接已确定的交互约定：

- 普通鼠标移动不改变控制者；用户明确点击“接管”才转移控制。
- 目标或焦点意外变化时，中止受影响动作的后续输入，保留 Agent 控制归属。
- 取消当前电脑作业停止该作业的后续输入、排空真实执行，并向 Agent 投递用户取消通知；不封禁本轮权限。
- 作业结束移除活动横幅；真正未确认的停止结果保留恢复状态。
- 用户交还控制后需要新的观察，旧坐标和排队输入不能直接继续执行。

结果区分执行状态、已知效果和后续是否可继续。原因使用稳定类别及必要上下文，例如用户取消、用户接管、
目标变化、授权会话关闭或驱动失联；工具结果只包含影响下一步操作的信息，详细诊断保留在原诊断渠道。
输入进度与鼠标、点击、键盘反馈沿现有事件通道呈现，事件不包含键入正文。

### macOS 常驻辅助程序

构建具有稳定应用身份、随发行版打包和签名的常驻辅助程序：Accessibility API 承担控件树与语义动作，
ScreenCaptureKit 承担截图与实时画面，系统输入 API 承担指针、键盘和拖拽。

观察与输入共用目标身份和坐标变换，长输入不会堵塞画面读取或取消。截图与实时画面复用捕获组件，
按需启动并保留会话，避免每个动作重新初始化；权限状态分别报告，预热不擅自观察、聚焦或输入。
稳定应用身份用于权限管理，系统是否要求重新授权仍由 macOS 决定。

画面绑定实际窗口或显示器、像素尺寸、缩放及捕获时间。单帧捕获可使用
[SCScreenshotManager](https://developer.apple.com/documentation/ScreenCaptureKit/SCScreenshotManager/captureImage%28contentFilter%3Aconfiguration%3AcompletionHandler%3A%29)，
实时画面使用 ScreenCaptureKit 流。发行支持的最低系统版本决定具体 API 选择。

### Wayland 授权会话

通过系统 RemoteDesktop / ScreenCast portal 建立正式授权会话，由用户选择共享画面和输入设备。
一个平台会话 owner 持有授权、PipeWire 连接及输入通道；画面订阅共享捕获，输入由现有控制者独占。
会话寿命与单次工具动作分开，避免每次观察重新弹出系统选择窗口。

输入按实际协商能力选择 EIS 或 D-Bus 通道。当前
[RemoteDesktop 文档](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
推荐 EIS；建立 EIS 后，该会话不能再混用 D-Bus Notify 输入。

坐标绑定原捕获流及其逻辑尺寸、缩放和目标。AT-SPI 树只有在目标对应关系明确时才与画面合并。
系统关闭授权、屏幕来源变化或流失效时，停止后续输入并报告原会话状态；重新获得会话后重新观察。
普通作业取消与撤销系统授权是不同操作，仍有观察者时可继续使用有效的画面会话。

主要入口：[ComputerService](../packages/web/application-host/lib/computer/DOCUMENTATION.md)、
[平台驱动](../packages/computer-driver/README.md)。

## 实施顺序

先完成 Documents 批量修改与两个图像工具，再实现扩展更新交接，最后分别补齐 macOS 与 Wayland 平台组件。
每条能力沿真实使用链完成：文档修改覆盖磁盘、草稿与编辑器身份；图片覆盖配置、工具可见性、执行、媒体和保存；
扩展更新覆盖跨重启交接；平台组件覆盖授权、观察、输入、取消和交还。当前运行时默认值与 Pi 迁移范围保持原决定。
