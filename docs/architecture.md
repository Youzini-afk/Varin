# Varin 架构

Varin 由共享工作台、可信 Application Host 和私有 Rust 内核组成。Web、Electron 和移动端使用同一套产品服务。
Varin 原生对话通过 Agent runtime 执行；Thread、HistoryBranch、Run、请求和 Operation 由 Rust Catalog 持久化。
外部 Harness 继续执行自己的会话循环，产品绑定、投递与观察记录也由 Catalog 保存，见[外部 Agent](external-agents.md)。
Workbench Profile 选择 Varin、工作台或 IDE 外壳，不改变执行身份、来源和权限。

运行机制见[运行时](runtime.md)，文件、进程与恢复见[资源](resources.md)，材料与知识见[检索](retrieval.md)，
界面见[工作台](workbench.md)，能力组合见[扩展](extensions.md)，开发入口见[开发指南](development.md)。

## 进程与包边界

```text
Web / Electron / mobile renderer
  application-client RuntimeAPIs + authenticated HTTP / multiplexed observations
    Application Host (packages/web/application-host)
      admission, model accounts, resources, MCP, Documents, research, ComputerService
      Varin extension Host and brokered extension children
      private Rust kernel
        varin-runtime: Catalog, history, requests, execution, durable operations
        varin-kernel: Storage, files, processes, compute, Host bridges
      private Knowledge owner + separate derived-semantic owner
```

- `application-client` 定义无框架依赖的产品 API、DTO 和类型化失败；`protocol` 提供共享领域和 Surface 类型。
  私有 Rust wire 由 [kernel/protocol/schema.json](../kernel/protocol/schema.json) 生成，不能作为 renderer 的任意方法透传口。
- `ui` 负责 React 呈现、Thread 投影、Document Registry 与编辑器分组，不拥有文件写入、凭据或耐久执行。
- `web` 是 Application Host。Electron 内嵌同一 Host 并提供窗口、preload、通知和更新；移动端连接 Host。
  客户端只观察或提交明确操作，不增加另一套后端或对话数据库。
- 内置 Browser Use 由 Electron 的原 Chromium 会话和 `WebContentsView` 承载，Host 注入受信的 BrowserOwner。
  UI 只挂载同一页面的视图；页面操作、下载与关闭由该 owner 管理。无此 owner 的远端 Host 不会借用本机登录态。
- Office 格式引擎在 Host 中读取和转换 DOCX/XLSX/PPTX，输出交给原生文件事务；材料、文件、运行和恢复仍由上述原 owner 管理。
- `varin-runtime` 负责执行状态机与 provider 协议；`varin-kernel` 将它连接到资源权威和特权 Host bridge。
- 扩展契约、作者 API、Host 生命周期和 Surface 生命周期分别由对应包拥有。相同扩展 ID 不等于相同权限。

总装配入口是 [application-host/index.ts](../packages/web/application-host/index.ts)。从它注入的 owner 跟踪调用链，
再读相邻模块说明；UI 路由、路径名称或类型标签本身不授予权限。

## 状态归属

| 状态 | 权威 owner |
| --- | --- |
| Thread、HistoryBranch、Run、请求、Operation、Wait、队列和 usage | Rust Catalog 与不可变 ContentStore |
| 外部会话绑定、输入、观察记录和交办回执 | Rust Catalog / ContentStore；外部原生历史由相应 Harness 拥有 |
| WorkingState、blob、文件租约、进程回执、Recovery/Integration | Rust Storage |
| 活跃缓冲和 dirty revision | 客户端 Document Registry；Host Documents 协调物理访问 |
| 目录登记、文件根准入、版本化文档协调 | Host Documents |
| 模型渠道、账号、用途设置、指令/skills 资源与 MCP | Host 对应领域服务；执行固定已准备的选择 |
| 普通 Agent 笔记与指令编辑 | Host personalization / Rust typed record |
| 环境捕获原文、冻结的模型表示、输入游标及投递回执 | Rust Catalog / ContentStore；Host 只协调轻量生产者与有界待提交队列 |
| 计划、Bot 知识、符号图 | KnowledgeStore 私有 writer |
| 语义向量与索引 | 独立派生存储进程 |
| 外壳、布局和视图状态 | UI kernel 与选中扩展 |

Catalog 与 Storage 是不同存储域，格式、结构检查和升级能力分别由
[Catalog](../kernel/crates/varin-runtime/src/catalog.rs) 与
[Storage 打开入口](../kernel/crates/varin-kernel/src/storage/core.rs)定义。
Storage 只接受自己的现行格式及 schema fingerprint；Catalog 的升级链不能套用于它。

项目登记仍由当前 Application Host 的 Settings 保存，同一 Host 的客户端共享这份配置；
Catalog 中按可信 principal 隔离的会话分类只引用项目 ID，不把项目设置变成用户私有副本。
`ProjectEntry.source` 引用原 `SourceResourceOwner` 与目标 Documents 的 workspace ID，缺省仍表示本机。
来源绑定保留 Host、连接与 endpoint 身份；相同名称、目录字符串或 workspace ID 不跨 Host 合并。
远端项目的文件、准备和执行回执沿原 managed-host 资源 owner，导航不持有凭据或文件副本。
远端项目的模型默认值由协调 Host 的原 AgentSettingsService 按登记项目 ID 管理，不读取同名本机目录；
这与目标设备自己的项目文件配置分别归属，见[项目与来源](workbench.md#项目登记与跨设备来源)。

## 受理、执行与观察

Host 校验真实 Thread/branch 和输入，准备模型、凭据、Source、策略与扩展候选。Rust Catalog 耐久受理后固定本次
Run/request 的配置与正文，Supervisor 调用冻结的 RunDriver，原执行 owner 记录真实模型和工具工作。内置 Rust 循环是默认 driver，可信扩展可以选择独立算法；权限、资源与记录并不因此变成另一个数据库。设置变化不会重写已受理请求、队列输入或原回执。

UI 通过 `ThreadsAPI` 读取组合快照与分页历史。Catalog 的独立只读连接在一致快照内收集视图元数据，
正文在 writer 锁外读取并保留原内容租约；一个视图不再由 Host 逐项拼接跨进程查询。
Host 的共享事件 reader 读取持久事件，各 HTTP 观察者仍有自己的 cursor、主体权限和进度兴趣。
客户端同一 Host 复用一个观察总线，按 Thread、branch 和事件种类分发；订阅就绪、重连或缺口触发权威重读。
普通变化只刷新受影响的视图和列表条目，不把每次进度变成全目录读取。

临时文字、公开思考和工具参数按 request 保存在独立流式状态中，持久历史只替换对应 request 的临时内容。
传输等待不阻塞模型执行；视图关闭、Host 切换或断线不代表执行取消。
原生事件作用域、追平和投影合同见[运行时观察](runtime.md#读取与观察)，具体入口见
[Host adapters](../packages/web/application-host/lib/kernel/DOCUMENTATION.md#native-thread-admission-and-product-views)。

浏览器直连将白名单内的长观察请求复用到同 Host 的 `/api/varin/observations/ws`，避免同源连接被 SSE 与长轮询占满；
relay 使用原复用通道。适配器保留原路由的身份、Origin、cursor、revision、租约与逐通道背压，
不受理任意 HTTP 请求、不自动重放写入。终端与语音 WebSocket 保留各自职责。

PDF 上传由 ThreadMaterials 校验实际 Thread/branch，通过原 documentReader 与 MaterialStore 保存原始字节。
输入只携带已核验的固定 snapshot 来源，`document_read` 再按原作用域读取。浏览器不创建另一套文档存储或解析权威。

## 权限、完成与失败

HTTP 认证在同一请求内复用；主体与凭据由原 owner 常驻维护，持久变更成功后才发布新认证状态。
路由按实际输入字段批量核验 Thread、Run、Operation 和 Input 的不可变归属，不扫描不透明正文猜测权限。
私有工作不能跨主体访问，已认证的非 Host owner 对公开工作只有读取权。见
[认证边界](../packages/web/application-host/lib/ui-auth/DOCUMENTATION.md)与
[归属解析](../packages/web/application-host/lib/kernel/ownership-resolver.ts)。

工具可见只表示可以选择。项目信任、客户端身份、工具策略、原 invocation 与实际资源 owner 分别核验权限。
能力标签和逻辑资源排程不等于 OS sandbox；Thread ID、内容 hash 或另一个 Host 上的同名路径也不是授权。

新 grant 的旧 session/worker 身份字段为空；历史非空身份、旧 session-owned record 和 candidate 不能重新获得权限，
也不能借已完成操作的幂等回执绕过检查。为读取既有字节而保留的字段不构成活动兼容路径。

HTTP abort、取消意图和真实 executor stop 是不同事实。原 owner 持有已受理工作、租约及清理责任，直到获得真实回执。
未知副作用不能自动重放，撤权不能把已经发生的效果说成成功回滚。多 Run 准备部分失败或受理未知时，已经创建的
Thread/worktree 保留，供核对和后续处理。

大正文和长读取、计算、物化在短控制/提交段之外执行，并保留原始资源寿命。失败或过期候选不能覆盖前一有效状态。
缺失、空、损坏、不可用、过期、冲突与未知应保持可区分。

## 数据与交付

内部结构由原存储 owner 在打开时处理。Catalog 支持范围与转换步骤以
[升级实现](../kernel/crates/varin-runtime/src/catalog_upgrade.rs)为准；文档不重复版本链。
转换、格式标记和升级事件在同一事务提交，然后才推进 epoch 和恢复执行。失败或中断回滚未提交转换，
错误保留源版本、目标版本及原因；未知、更新或结构损坏的格式只读拒绝，保留原资产。

升级保留正文对象、会话与主体身份、分支、稳定引用、队列和原回执，不复制整库、不重放模型或外部效果。
无法从原证据恢复的身份与用量保持未知，不从名称、当前配置或 ID 前缀补造。
初始项目来自成功读取的 Settings 文档，损坏或不可读不等于空列表；后续启用认证不自动认领旧公开工作。
工作区、Git、历史原生数据及外部配置仍由各自 owner 管理。

安装布局核验 Rust executable 的 build、wire 和 architecture；协议改动后由正常构建生成匹配二进制。
定向测试不代表全部安装包、模型账号、代理、物理远端 Host 或电脑驱动已验收，见[运行时验收](runtime-acceptance.md)。

来源及第三方义务由 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) 与 [LICENSE](../LICENSE) 保留；
历史设计与迁移过程留在 Git，不作为第二套当前运行说明。
