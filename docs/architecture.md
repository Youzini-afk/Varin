# Varin 架构

Varin 由共享工作台、可信 Application Host 和私有 Rust 内核组成。Web、Electron、移动端访问同一套产品服务。
Workbench Profile 选择 Agent、IDE、Research 或 Bot 外壳，不决定对话运行时，也不会搬迁已经受理的执行。

**当前默认对话运行时仍是 Pi。** 本分支另有显式选择的 Rust Agent runtime。两者拥有不同的会话身份与历史，
共用 Documents、恢复、科研、Computer Use 等 Host 服务。新运行时不会自动导入 Pi 数据、切换默认或删除 Pi；
已接线也不意味着全部安装包和真实环境操作链已经验收。

理解执行机制读[运行时](runtime.md)，文件/进程/恢复读[资源](resources.md)，输入与知识读[检索与上下文](retrieval.md)，
界面读[工作台](workbench.md)，能力组合读[扩展](extensions.md)。修改代码与选择验证入口见[开发指南](development.md)。

## 进程与包边界

```text
Web / Electron / mobile renderer
  application-client RuntimeAPIs + authenticated surface transports
    Application Host (packages/web/application-host)
      product admission, Documents, recovery, research, ComputerService, settings
      Varin extension Host and brokered extension children
      Pi runtime broker -> catalog/session/compaction workers
      private Rust kernel
        varin-runtime: Catalog, history, requests, execution, durable operations
        varin-kernel: Storage, files, processes, compute, Host bridges
      private Knowledge owner + separate derived-semantic owner
```

- `packages/application-client` 定义无框架依赖的 API、DTO 和类型化失败；`packages/protocol` 维护 Pi/公开 Surface
  协议及共享领域类型。私有 Rust wire 源是 `kernel/protocol/schema.json`，生成的 Host DTO 不是 renderer API。
- `packages/ui` 负责 React 呈现、会话投影、Document Registry 和编辑器分组，不拥有文件写入、凭据、耐久执行或原生进程。
- `packages/web` 负责可信 Application Host 及 Web/remote 入口。`packages/electron` 内嵌同一 Host，补充窗口、原生对话框、
  通知、更新和 preload；不维护第二套后端。`packages/mobile` 是连接 Host 的 Capacitor 客户端。
- `runtime-broker`、`runtime-client`、`pi-host` 构成 Pi worker/传输边界。Pi SDK 与扩展原生配置继续由 Pi 所属服务管理。
- `kernel/crates/varin-runtime` 负责 Agent 状态机与 provider 执行契约；`varin-kernel` 将它装配到现有资源内核并分发
  特权 Host bridge。它们是同一 Host 的私有组件，不是另一台公开服务。
- 扩展包将契约、作者 API、Host 生命周期与 Surface 生命周期分开。同一个 extension ID 不意味着所有代码拥有相同权限。

总装配入口是 [application-host/index.ts](../packages/web/application-host/index.ts)。先沿它注入的 owner 找调用链，
再读模块文档；不能根据 UI 路由或类型名称猜测谁持有权威状态。

## 状态归属

| 状态 | 权威 owner | 保留这个边界的原因 |
| --- | --- | --- |
| Pi 会话分支与记录 | worker 内的 Pi AgentSession / SessionManager | 保留原生树，不另建投影会话库 |
| Agent Thread、HistoryBranch、Run、请求、Operation、Wait | Rust Catalog 与不可变 ContentStore | 受理、副作用和恢复使用同一原始身份 |
| WorkingState、blob、文件租约、进程回执、Recovery/Integration | Rust Storage | 文件正文与耐久引用在同一资源域提交 |
| 活跃缓冲、dirty revision | 客户端 Document Registry，Host Documents 协调 | 编辑器草稿和磁盘是不同来源 |
| 工作目录登记、根准入、文档协调 | Host Documents | 路径/ID 只是命名，物理操作仍查根身份与信任 |
| 普通 Agent 笔记与指令编辑 | Host personalization / Rust typed record | 显式笔记不依赖语义召回或后台提炼 |
| 计划、Bot 知识、观察、符号图 | 现有 KnowledgeStore 私有 writer | CAS 和来源与真正提交修改的 owner 同在 |
| 语义向量与索引 | 独立派生存储进程 | 长索引任务不能占满计划/记忆写入队列 |
| 模型凭据、包配置 | 现有 Host/Pi/provider owner | renderer 和耐久 prompt 不持有密钥 |
| 外壳、布局、视图状态 | UI kernel 与选中扩展 | 呈现切换不能重建文档、终端或会话 |

Host 的 Pi Thread/Run registry 协调 Pi 工作，不是 Rust Agent Catalog。共享恢复、排程、Bot 和 Computer 边界通过
带判别字段的身份选择 owner；不能为 Agent 工作虚构 Pi session，也不能用相同路径推断同一资源。

## 请求如何跨越边界

### Pi 会话

鉴权 Surface client 经 broker 进入 Pi worker；broker 固定会话身份并管理 worker 寿命。worker 加载所选 SDK 和资源，
构造原生模型输入、运行 Pi loop。Host 工具跨 Harness bridge，经工具策略和资源准入交给实际 owner 执行，历史仍写 Pi。

环境观察、普通笔记、队友上下文和固定范围压缩通过 [Pi harness](../packages/pi-host/src/harness/README.md) 接入原 loop。
工具续接准备下一次真实请求；工作台外壳不创建另一个 Agent loop。Pi 扩展在 worker 执行，UI 经支持的 bridge/adapter 投影。

### Agent Thread

Host 准入真实 Thread/branch、显式输入和可选来源，并通过现有 owner 准备模型、凭据、资源、策略和扩展候选。
Rust Catalog 耐久受理输入，冻结本次 Run/request 配置。执行引擎在原始身份下记录模型和工具工作；provider transport
与 Host bridge 将执行事实送回原记录。UI 事件只是可重读的投影，不是执行权威。

已受理请求的字节、工具 schema 和上下文不会因设置或扩展代次随后变化而被改写。后台 Job 与 Wait 可以长于模型 exchange；
其回执、停止和续接规则见[运行时](runtime.md)。

## 准入、权限和完成是不同事实

工具可见只表示可以选择，不会自动授予文件根、电脑控制、凭据或写权限。项目信任、配对客户端权限、工具策略、
原始 invocation 与实际资源 owner 分别在自己的边界核验。能力标签或逻辑资源排程不是 OS sandbox。

HTTP abort、关闭观察、取消 Run 或断线也不是真实停止回执。原 owner 保留已受理工作、租约和清理责任，直到知道执行结果。
未知副作用不能为了获得干净状态而重放。撤权阻止新访问，不会把已经开始的外部作用说成回滚成功。

私有内核将大正文传输与控制取消/元数据分开。Storage/Catalog 的 owner 段执行短准入与提交；哈希、文件读取、模型调用、
物化等长工作在外执行，但保留原始资源和取消寿命。详见[内核](../kernel/README.md)与
[Host adapter](../packages/web/application-host/lib/kernel/DOCUMENTATION.md)。

## 失败与替换

missing、empty、invalid、unavailable、stale、conflict 和 unknown 含义不同。故障不能变成空目录或启动备用 writer。
候选满足自己的准备条件后才发布；失败和过期结果保留上一有效状态。扩展更新只按实际参与的 Host/Surface update group
协调，不能假定所有 Surface 与 Host 存在统一原子事务。

内部格式不承担自动升级/导入兼容：不支持或损坏的存储应拒绝打开并保留资产。工作区文件、Git、Pi 原生数据和外部配置
仍是用户资产；当前格式内的耐久性与恢复仍须正确。

远端改变资源所在的 Host，不改变规则。Managed Source 调用保留已鉴权目标 Host、固定来源和原操作回执；相同本地路径
永远不是远端资源不可用时的替代品。

## 运行与交付边界

即使 Pi 运行 Agent loop，Rust kernel 仍是必需组件。安装布局核验 staged binary 的 build、protocol、architecture；
开发态可使用支持的 Cargo runner。Storage 只有一个持锁 owner；Knowledge 和派生语义库各自有私有进程。

电脑驱动、模型账号、代理、远端 Host 和 VM 有各自的平台/部署条件，见[资源支持边界](resources.md)与
[provider 说明](../kernel/crates/varin-runtime/src/providers/README.md)。仍需真实环境证据的部分见
[运行时验收](runtime-acceptance.md)，定向测试不是全平台发行认证。

OpenCode 与旧 VS Code companion 已退役。OpenChamber 来源及第三方义务由
[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) 和 [LICENSE](../LICENSE) 保留。
