# Varin 架构

Varin 由共享工作台、可信 Application Host 和私有 Rust 内核组成。Web、Electron 和移动端使用同一套产品服务。
对话只通过原生 Agent runtime 执行；Thread、HistoryBranch、Run、请求和 Operation 由 Rust Catalog 持久化。
Workbench Profile 选择 Agent、IDE、Research 或 Bot 外壳，不改变执行身份、来源和权限。

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
  私有 Rust wire 由 `kernel/protocol/schema.json` 生成，不能作为 renderer 的任意方法透传口。
- `ui` 负责 React 呈现、Thread 投影、Document Registry 与编辑器分组，不拥有文件写入、凭据或耐久执行。
- `web` 是 Application Host。Electron 内嵌同一 Host 并提供窗口、preload、通知和更新；移动端连接 Host。
  客户端只观察或提交明确操作，不增加另一套后端或对话数据库。
- `varin-runtime` 负责执行状态机与 provider 协议；`varin-kernel` 将它连接到资源权威和特权 Host bridge。
- 扩展契约、作者 API、Host 生命周期和 Surface 生命周期分别由对应包拥有。相同扩展 ID 不等于相同权限。

总装配入口是 [application-host/index.ts](../packages/web/application-host/index.ts)。从它注入的 owner 跟踪调用链，
再读相邻模块说明；UI 路由、路径名称或类型标签本身不授予权限。

## 状态归属

| 状态 | 权威 owner |
| --- | --- |
| Thread、HistoryBranch、Run、请求、Operation、Wait、队列和 usage | Rust Catalog 与不可变 ContentStore |
| WorkingState、blob、文件租约、进程回执、Recovery/Integration | Rust Storage |
| 活跃缓冲和 dirty revision | 客户端 Document Registry；Host Documents 协调物理访问 |
| 目录登记、文件根准入、版本化文档协调 | Host Documents |
| 模型渠道、账号、用途设置、指令/skills 资源与 MCP | Host 对应领域服务；执行固定已准备的选择 |
| 普通 Agent 笔记与指令编辑 | Host personalization / Rust typed record |
| 计划、Bot 知识、观察、符号图 | KnowledgeStore 私有 writer |
| 语义向量与索引 | 独立派生存储进程 |
| 外壳、布局和视图状态 | UI kernel 与选中扩展 |

Catalog 与 Storage 是不同存储域。当前 Agent Catalog 的 `FORMAT` 为 77；Storage 的 format 为 22，
SQLite `user_version` 为 16。版本以各自源码为准，不按名称相似混用或自动迁移。

## 受理、执行与观察

Host 校验真实 Thread/branch 和输入，准备模型、凭据、Source、策略与扩展候选。Rust Catalog 耐久受理后固定本次
Run/request 的配置与正文，执行引擎记录原始模型和工具工作。设置变化不会重写已受理请求、队列输入或原回执。

UI 通过 `ThreadsAPI` 读快照与历史，`/api/threads/observe` 传输持久事件和临时进度。断线后按 durable cursor 追平；
视图关闭、Host 切换或观察流中断不代表执行取消。浏览器直连将固定白名单内的长观察请求复用到同 Host 的
`/api/varin/observations/ws`，避免 HTTP/1 同源连接被 SSE 与长轮询占满；已有 relay 仍使用原复用通道。
此适配器只转交原路由的响应与取消，保留身份、Origin、游标、revision 和租约，不受理任意 HTTP 请求或自动重放写入。
逐通道 pull 控制响应背压；连接断开关闭各原观察者，恢复由各业务消费者按原语义负责。
终端与语音的 WebSocket 仍有独立职责，旧运行时 socket 不再受理。

PDF 上传由 ThreadMaterials 校验实际 Thread/branch，通过原 documentReader 与 MaterialStore 保存原始字节。
输入只携带已核验的固定 snapshot 来源，`document_read` 再按原作用域读取。浏览器不创建另一套文档存储或解析权威。

## 权限、完成与失败

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

不支持或损坏的内部格式拒绝打开并保留资产，不自动升级、重建或改写用户库。工作区、Git、历史原生数据与外部配置
仍是用户资产；当前格式内的恢复和耐久性继续适用。

安装布局核验 Rust executable 的 build、wire 和 architecture；协议改动后由正常构建生成匹配二进制。
定向测试不代表全部安装包、模型账号、代理、物理远端 Host 或电脑驱动已验收，见[运行时验收](runtime-acceptance.md)。

来源及第三方义务由 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) 与 [LICENSE](../LICENSE) 保留；
历史设计与迁移过程留在 Git，不作为第二套当前运行说明。
