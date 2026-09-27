# Agent 运行时可靠性与多项目工作区实施计划

Status: accepted implementation plan; RR0–RR5 的代码路径与定向行为已复核，RR6 的真实安装包及外部代理平台纵切仍待验证。具体证据、委托边界与未测项见 docs/agent-harness-status.md。

Last updated: 2026-09-27

**设计替代说明（D-337，HR0–HR5 已实施）：** [面向任务与资源的 Harness](resource-oriented-harness-design.md) 已交付。
下文 RR2 的可变会话操作目录、目录镜像与恢复，以及 RR4 的持久 queryScope 和目录型 workspace 数据/索引归属，
已被移除并替换为单次执行参数、资源引用与持续索引（交付证据见 [agent-harness-status.md](agent-harness-status.md)）。
RR1 恢复/停止、RR3 执行与输出、RR5 联网及真实覆盖反馈继续有效；本文件保留为历史实施背景。

源码核查基线：`0135144f`，仓库版本 `0.9.19`。问题输入来自维护者提供的 Varin 内部 Agent 体检报告，以及维护者实际观察到的聊天中途停止刷新。报告中的耗时、复现结果和环境信息属于报告证据，不是本计划编写时重新实测的结果。

本计划细化 [Harness 总计划](agent-harness-plan.md) 的运行时可靠性专项，采用独立阶段前缀 **RR**，不与已完成的 Rust 阶段 R 混淆。交付事实统一记入 [能力状态矩阵](agent-harness-status.md)；重要实现取舍按现有格式追加到 [决策日志](agent-harness-decisions.md)。本文件负责目标、合同、任务和验收，不另建一份交付事实账本。

## 0. 执行授权与完成定义

维护者已经同意实施本轮讨论的完整方向。执行 Agent 应直接分阶段实现，不再提交一份替代计划等待逐项批准。仓库范围内的合理工程取舍自行决定并记录；目录导航、正常工具使用和每个小改动不需要维护者反复确认。

首先遵循 [AGENTS.md](../AGENTS.md)、[开发指南](development.md) 与 [架构](architecture.md)。本计划不授权发布版本、部署外部服务、修改真实系统代理/证书、改变凭据、关闭安全保护、force-push 或写其他真实项目。跨项目行为验证在临时夹具中进行，不把 `opencr` 下其他项目当试验田。

完成必须是 **实际消费者接线 + 与风险相称的行为验证 + 同步文档**。只有 helper、伪造终态、CSS/源码字符串断言、修改工具文案、让用户关闭代理或重启客户端，均不算修复。未测平台/真实 provider 需要明确记录，不冒充通过，也不成为无限期搁置其他可验证工作的理由。

### 0.1 本轮已确定的产品原则

1. **大工作区是一等场景。** 用户可以打开包含多个项目的目录；不要求先把工作区缩到单个 Git 仓库，也不把项目等同于 Git 根。
2. **用户决定授权，Agent 自主导航。** Agent 可在已有授权范围内发现、选择和切换操作目录、调整单次检索范围；这必须是真实工具能力，不能只提供手动下拉框。越过已授予的访问权限才走现有权限门，不因跨一个项目目录就增加确认。
3. **相对路径有唯一含义。** 文件工具、语言诊断和默认检索共享 Host 确认的操作上下文；不得失败后悄悄回退父目录或搜索另一个同名文件。
4. **状态恢复不是重新执行。** 连接断开后应主动恢复权威状态，不自动重发 prompt、工具调用、提交、合并或其他有副作用的动作。
5. **停止请求、停止已接受、实际停止分开。** 界面立即反馈请求，但不通过篡改消息或丢弃终态事件假装后台已经停下。
6. **联网兼容由产品承担。** 统一 Host 出站配置、实际连接与安全检查；不把 curl 替代 webfetch、关闭代理、关闭 TLS/SSRF 当正式修复。
7. **保持既有资源所有权。** Pi 管 Agent loop/provider/native session；Host 管产品合同与授权；Rust 管已迁移的文件、工作状态、进程和计算权威。不得新增平行 TS writer、第二套任务运行时或旧格式兼容层。
8. **事实状态不合并。** 空、未就绪、失败、取消、超时、权限拒绝、部分结果、已过期和结果未知必须可区分；未知用量和扫描数不能补成零。

## 1. 证据台账与需要纠正的推论

以下按本次基线核查。开始实现时重新确认受影响函数，若代码已变更，更新定位与证据，不机械套用旧行号。

| 编号 | 报告/观察 | 已有源码证据与判断 | 负责阶段 |
| --- | --- | --- | --- |
| E01 | 相对写入落在 `opencr` 而非 `Varin`，检索出现同级项目 | `path-authority.ts` 从 Documents 的 `workspace.root` 解析相对路径；shell 从注册时的 session cwd 初始化。存在多种基准。用户选大工作区时父根不必然错误；尚不能仅据仓库外落点断言突破授权边界。误写风险必须修复。 | RR2、RR4 |
| E02 | heredoc 结束符在最后一行时挂起 | `buildCommandWrapper()` 将用户 Bash 命令内插进 `{ ${command}; }` 的同一串语法。足以破坏末行 delimiter/注释等结构；需真实 shell 验证。 | RR3 |
| E03 | 语法错误后提示符已返回，却一直报 running | 结束依赖 sentinel；提示符、超时和缺 sentinel 均不能单独证明进程状态。具体失同步序列需复现。 | RR3 |
| E04 | 调用报 aborted，命令实际 exit 0，输出查询失败 | `read()` 已有 `acceptedExecutions` 的 tool-call-ID 恢复入口；报告提示的 `call_…` 与实际查询的 execution token 不同。不能直接认定所有输出永久丢失；必须用原样返回的引用验证。 | RR3 |
| E05 | grep 零命中显示 searched 0 files | `search-service.ts` 将命中文件分组数 `grouped.totalFiles` 填进 `searchedFiles`，两者语义不同。 | RR4 |
| E06 | webfetch 报 private-network，curl 可访问，出现 `198.18.0.137` | 当前 `ssrf-policy.ts` 把 DNS 异常折成 private-network，且没有显式匹配 `198.18.0.0/15`。当前检查与后续全局 `fetch()` 分离。fake-IP 命中拦截不是已证实的唯一原因；注释声称 IP pinning 也不是实际连接已固定的证明。 | RR5 |
| E07 | todo 从可用变为 No knowledge store for session | `index.ts` 的 `todoDepsProvider()` 经 session→workspace 绑定获取 KnowledgeStore。复用数据库不是错误本身；绑定丢失/覆盖/时序需核查，不能另建临时空库掩盖。 | RR4 |
| E08 | diagnostics 拒绝绝对路径；related 未采集但 explore 有片段 | 内部 Workspace API 要相对资源路径不等于 Agent 工具应暴露不同合同。文本、向量和关系图覆盖可以不同，但必须共享文件/版本身份并解释覆盖差异。 | RR2、RR4 |
| E09 | explore 降级，未返回候选列表占用大量上下文 | 模型选择拒绝、快速决策不可用和检索范围是不同问题；确认已有部分状态和详情存储入口，改默认投影而非隐藏缺陷。 | RR4 |
| E10 | waitMs 比实际调用耗时少约 2.5–5 秒 | 计时器在 shell 准备之后才启动，完整调用还经过 admission、输出整理等。报告耗时不是通用固定开销；需分段计时与可追踪回执。 | RR3 |
| E11 | 聊天半途不刷新，重启后发现后台已完成 | runtime-client 断连会清监听；UI 连接当前是按调用懒恢复，序号缺口回调未形成默认同步闭环。足以造成此类现象，但必须区分断连、Store 丢事件、render 停滞、正常无输出。 | RR1 |
| E12 | 上次暂停修复冻结本地输出并隐藏 abort 红条 | `3044800b` 增加 `manuallyAbortingSessionIds`、忽略 assistant 流事件、对停止 RPC 的 AbortError 返回 true；reset 未清集合。须纠正未知被当成功及终态收敛缺陷，不能照搬旧测试的错误契约。 | RR1 |

报告确认过的 Git Bash cwd 恢复属于非回归项：保留 `cb79c389` / `2c1aef20` 的有效行为，重新验证长命令后台化→kill→下一条命令。报告未复现的长行重复边界字符不列为已确认缺陷；只有新证据才升级。

## 2. 代码归属与导航

以链接中的实际实现及其同目录测试为准，不按本文名字创建平行服务。

| 范围 | 入口 |
| --- | --- |
| 路径、actor、注册 | [path-authority.ts](../packages/web/application-host/lib/harness/path-authority.ts)、[router.ts](../packages/web/application-host/lib/harness/router.ts)、[session-registration.ts](../packages/web/application-host/lib/harness/session-registration.ts)、[service-host.ts](../packages/web/application-host/lib/harness/service-host.ts) |
| Host 生产装配 | [index.ts](../packages/web/application-host/index.ts)、[Host Harness 文档](../packages/web/application-host/lib/harness/DOCUMENTATION.md) |
| Pi 工具和会话 | [工具文档](../packages/pi-host/src/harness/README.md)、[session-host.ts](../packages/pi-host/src/session-host.ts)、[protocol-projector.ts](../packages/pi-host/src/protocol-projector.ts)、[HostServicesBridge](../packages/pi-host/src/harness/host-services-bridge.ts) |
| 连接与事件 | [client.ts](../packages/runtime-client/src/client.ts)、[websocket.ts](../packages/runtime-client/src/websocket.ts)、[surface connection](../packages/runtime-broker/src/runtime-surface-connection.ts)、[gateway.ts](../packages/web/application-host/lib/pi-runtime/gateway.ts) |
| UI 同步 | [UI client.ts](../packages/ui/src/lib/pi-runtime/client.ts)、[usePiSessionStore.ts](../packages/ui/src/stores/usePiSessionStore.ts)、[Store 文档](../packages/ui/src/stores/DOCUMENTATION.md)、[PiChatView.tsx](../packages/ui/src/components/pi-session/PiChatView.tsx) |
| shell 与输出 | [shell-supervisor.ts](../packages/web/application-host/lib/harness/shell-supervisor.ts)、[harness-services.ts](../packages/web/application-host/lib/harness/harness-services.ts)、[output-store.ts](../packages/web/application-host/lib/harness/output-store.ts)、[terminal runtime](../packages/web/application-host/lib/terminal/runtime.ts) |
| 检索与计划 | [search-service.ts](../packages/web/application-host/lib/harness/search-service.ts)、[explore-service.ts](../packages/web/application-host/lib/harness/explore-service.ts)、[todo-tool.ts](../packages/web/application-host/lib/harness/todo-tool.ts)、[快速决策设计](fast-decision-model-design.md)、[Knowledge 文档](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md) |
| 网络 | [web-fetch.ts](../packages/web/application-host/lib/harness/web-fetch.ts)、[ssrf-policy.ts](../packages/web/application-host/lib/harness/ssrf-policy.ts)、[安全设计](security.md) |
| 协议与文件状态 | [protocol](../packages/protocol/package.json)、[application-client](../packages/application-client/README.md)、[Rust 设计](rust-kernel-design.md)、[工作区恢复](native-workspace-recovery-design.md) |

## 3. 执行顺序和边界

默认顺序：**RR0 → RR1 → RR2 → RR3 → RR4 → RR5 → RR6**。RR1 解决会话不可见和错误停止状态，RR2 解决误写基准；二者是最先闭环的高优先级工作。RR0 核实出真实越权写入时，先完成最小安全修复，不等其他阶段。RR3、RR5 的独立夹具/调查可并行，但协议和装配修改要有单一集成人，避免互相覆盖。

RR0 是短准备，不是先搭建通用评测平台的许可。为当前即将实施的阶段取得足够证据后立即实现；不等所有报告项全部复现。完成一个闭环就按仓库规范提交，继续下一阶段，不停在补文案/写 helper。

| 阶段 | 交付目标 | 主要依赖 |
| --- | --- | --- |
| RR0 | 基线、隔离夹具、根因定位与最小诊断 | 当前代码与包脚本 |
| RR1 | 聊天自动重连/追赶、权威状态收敛、可靠停止 | RR0 |
| RR2 | Agent 自主工作上下文、统一路径合同 | RR0；与 RR1 的代际合同对齐 |
| RR3 | shell 命令载荷、真实终态、输出引用、等待预算 | RR0；消费 RR2 上下文 |
| RR4 | 多项目检索、能力覆盖、todo 绑定与诚实反馈 | RR2；输出详情复用 RR3 |
| RR5 | Host 统一联网、代理兼容、安全检查与错误分型 | RR0；复用既有设置/权限 owner |
| RR6 | 跨层故障注入、真实平台 smoke、交付收口 | 已接线阶段 |

## 4. RR0：先确定故障在哪一层

### 工作项

- 在 `git status` 基础上记录 HEAD、实际 Host/Pi/kernel 版本、连接类型、会话/worker/Run 身份。报告 Node/Bun 版本与实际启动进程版本分开记录，不只看 shell 的 `node --version`。
- 建立临时多项目夹具：父工作区、两个包含同名 `package.json`/源码文件的子项目、一个非 Git 项目、一个忽略的构建目录；必要时增加 symlink/junction。所有写入落在夹具内。
- 利用现有真 Pi + faux provider、Host/transport 测试夹具，注入断线、丢失结束事件、延迟响应。不要先依赖真实付费模型。测试 Host 使用独立端口、dataDir 和 Pi agent 目录，不重启或终止维护者正在使用的会话；在 Varin 内执行本计划时也不要通过杀掉自身 Host 来验证恢复。
- 诊断只记录必要的身份、事件水位、错误码、字节数、耗时和已脱敏的连接方式。不得打印提示词、文件正文、token、代理密码、URL query 凭据或完整环境变量。
- 网络复现在实际 Host 路径执行；将 curl 成功视为对照，不当成 Node/Electron Host 已联网的证据。不得扫描内网或擅改系统代理。
- 更新 E01–E12 的结论：已复现、源码可确认、尚未复现、推论已纠正。验收数据存入聚焦测试或可重复脚本，不在文档堆积原始日志。

### 通过条件

执行者可以用可控输入区分错误路径与正确路径，指出负责的 owner，且没有污染其他项目。准备完成后进入实现；证据不足的个别项明确保留，不阻塞已确认的修复。

## 5. RR1：聊天恢复与停止语义

### 5.1 连接和同步是两种状态

显式区分 `connected/disconnected/reconnecting` 与 `synced/catching-up/stale`；成功握手不等于会话内容已经追平。

- 客户端暴露可订阅的连接生命周期与可诊断的协议异常。只有一个生命周期 owner 执行重连，避免每个 React 组件启动一套定时器。
- 异常断连自动退避重试并加入 jitter；主动关闭、退出会话/应用和 runtime 切换使旧重试失效。授权过期应走现有认证刷新，不无限复用旧凭据。
- `online`、页面恢复可见/恢复运行、确实的事件缺口和连接恢复触发合并的重新同步。静默长计算不是断连；不要用“几秒没 token”认定失败或停止任务。
- 按真实连接/运行世代隔离异步响应；不同 Host、worker、session、Run 的相同 ID 不相互覆盖。
- 调查浏览器已连但应用协议失活的情况，复用已有 heartbeat 或必要的只读健康探测。探测关注连接和事件水位，不对全历史开高频轮询；超时是未知而不是伪造 agent_settled。

### 5.2 权威追赶合同

实施前在当前协议上选择最小可行的“有水位快照 + 后续事件”，或“有限 replay + 快照回退”。不为了修刷新重造全产品事件数据库。

快照/追赶应覆盖：当前 worker/Run 世代、分支 leaf、已持久化历史尾部、未持久化的 live assistant、正在运行的工具与可取回的结果引用、队列、停止状态、busy/streaming、真实已知的 usage/耗时。正文仍只走原有已授权内容通道，不进入全局诊断广播。

必须解决：

1. 同步快照与事件水位属于同一个可解释的一致性切点。快照期间缓存或回放更新；不能“先 GET 再 subscribe”漏掉中间事件。
2. 同一消息从 live 变 persisted 时按真实消息身份合并，去重且不丢 usage/tool result。旧快照不能覆盖更新的 Store 内容。
3. 对先前事件的重复投递幂等；旧运行世代事件失效；不得用当前到达顺序替代因果身份。
4. worker 原始序号可能经过权限/角色/订阅过滤，不可把合法过滤直接当断线。明确检测连续性的是 surface 流还是每个 source 的原始流；没有跨 source 的全局序号时，不伪造全局比较。
5. replay 超出保留范围或 worker 已更换时，读取现有权威历史/状态并标明无法恢复的瞬态信息；不能把缺数据当空会话。
6. 重新同步只读，不为了看转录而 restore/启动已关闭会话、重复发 prompt 或重新执行工具。
7. 保留用户草稿、滚动锚点和手动阅读位置。重连不强制滚到底，也不重建整个聊天 UI 掩盖 Store 缺陷。
8. 前端异常可定位到接收水位、应用水位和渲染进度；某个监听者抛错不能无声吞掉后续必要事件。无需把 token 级日志持久化。

### 5.3 纠正停止修复的脆弱部分

专项审阅 `3044800b`。不要把“测试期望停止后丢事件”当必须保留的产品合同。

- 点击停止立即呈现 `stopping/requested`，防重复点击；Host 尽快发送取消信号，控制请求不得排在长 prompt/tool RPC 后面。分别测点击→发请求、Host 收到→信号、信号→实际 settle。
- `agent.abort` 快速确认只代表取消已接受，不代表已 idle。核实当前 Pi 的公共取消接口及各 controller，避免复制 SDK 内部逻辑后漏掉 retry/compaction/branch summary/工具取消。
- 正常继续消费权威的消息结束、entry_appended、tool result、snapshot 和 agent_settled。允许立即改变展示状态，但不得永久屏蔽事实流或改写 Pi 持久历史来固定文本。
- `AbortError` 出现在**停止 RPC 的传输层**，不证明 Host 接受了请求。超时/断线返回待确认或结果未知，通过恢复协议查询；不要用宽泛错误字符串匹配返回成功。
- 已被权威标记为取消的操作，用中性“已停止”状态替代错误红条；真正的 provider、网络、存储和工具错误照常展示。通过 `stopReason`/typed outcome/取消关联身份识别，而非全局隐藏包含 aborted 的消息。
- `stopping` 在相应 Run 的 settle、权威 idle snapshot、失败回滚、worker exit、session close、runtime reset 时正确收敛；旧停止响应不能取消新 Run。
- 新请求不与未清理的旧执行重叠；保留现有队列语义，但待确认停止不能自动触发 follow-up，造成“刚停又跑”。

### 验收

真实可控流在半句时断开 WebSocket，后台继续完成；恢复网络后**无需重启或再次发送消息**即可看到最终正文、工具结果、usage 和 idle，provider 调用次数不增加。再覆盖保持连接但遗漏结束事件、重复/迟到事件、快照与实时更新竞态、切换 session/runtime、隐藏窗口恢复。

停止在真实 in-flight provider/tool 场景测试：取消信号及时到达，不能再发起下一次模型轮次；丢失停止回执后恢复可查明真实结果；失败停止不伪装成功；取消不显示错误红条，但真实错误仍可见。只在 idle session 上 mock `waitForIdle` 不足以证明停止时延修复。

## 6. RR2：Agent 自主工作上下文与统一路径

### 6.1 明确不同概念

| 概念 | 例子 | 合同 |
| --- | --- | --- |
| 授权工作区 | `D:/project/opencr` | 用户打开的资源集合及当前权限；不是默认写入位置的唯一决定因素 |
| 会话操作目录 | `D:/project/opencr/Varin` | Agent 文件工具相对路径、默认诊断锚点、shell 的显式默认基准 |
| 单次检索范围 | `Varin` 或 `Varin + pi` | 在当前授权内决定候选集，不授予新的读写权限 |
| shell cwd | shell 内 `cd` 的结果 | 属于具体 shell，不自动修改其他工具的基准 |
| Host 进程 cwd | 安装/启动位置 | 进程环境，不作为会话路径的兜底 authority |

Agent 具备一个轻量工作上下文工具能力：查询当前状态、发现候选项目、选择操作目录、指定/重置检索范围。名字由执行者沿现有合同决定；不强制另建工具家族。不能只改 system prompt 或给 UI 加下拉框。

工具由 Host 确认结果并返回实际生效的操作目录、查询范围、上下文修订和必要的权限结果。Agent 可根据任务自主选择，不需要用户每次批准。UI 显示“当前项目/目录、由谁切换、必要的跨项目范围”，用户可以覆盖，但不承担日常导航。

### 6.2 切换和并发

- 上下文属于具体 runtime/authority、session、工作分支及相应执行身份，不是进程全局变量；禁止 `process.chdir()` 改共享 Host。
- 切换是验证后原子发布的新修订。失败保留旧上下文；并发切换按预期修订检查，返回冲突，不采用最后一个慢响应覆盖。
- 已受理操作使用自己的固定上下文；切换后新调用使用新修订。运行中的命令、后台 shell、子任务不被重新解释。
- 每个子 Agent 继承派发时的初始上下文，之后独立切换；父子及兄弟的 cwd 不互相修改。跨项目读取不要求切换会话写入基准。
- 保持已有 Run 的模型/工具/权限与输入冻结。操作上下文是显式、有修订的运行事实；在安全的工具边界供后续请求使用，不能据此偷换既有 WorkingState baseline。确需改变执行工作区/分支的切换，走已有新 Run/重新物化流程并保留成果。
- system prompt/动态上下文、文件工具及 UI 使用同一已确认事实；通过现有受支持的上下文更新入口传播，不篡改历史 system message，也不静默保留旧项目说明。
- 检查 Pi 工具工厂、项目指令/扩展资源、权限检查和检索是否缓存旧 cwd。凡语义依赖操作目录的消费者必须明确更新/重新装配时点；原信任范围不会因进入目录而自动放宽。

### 6.3 路径合同

Agent 工具统一接受“相对操作目录的路径”和“当前授权允许的绝对路径”，在 Host 边界转换为 canonical workspace/resource 身份。内部 Workspace API 继续使用相对资源路径；适配责任不转嫁给 Agent。

覆盖 `read/write/edit/apply_patch/find/ls/grep/document_read/diagnostics/definition/references/hover/related/explore` 的实际路径消费者；工具路径数组和目录型参数也要转换。已有 draft/branch view、权限门、锁和恢复链不可绕过。

必须验证 Windows 盘符/大小写、Git Bash mount path 的明确解释器映射、真正 POSIX 路径、UNC、symlink/junction 和不存在的新建目标。新文件以最近存在祖先验证边界；实际变更仍交给现有 canonical authority 防止校验与写入间的路径替换。不要把所有平台路径一律 lowercase 或对任意 `/x/...` 自动当 Windows 盘符。

目录不存在、上下文丢失或版本不一致时返回明确错误，不静默写到父目录/Host cwd。展示聚焦项目只是默认与防误写提示，不收缩或扩大用户授权；同一授权工作区内的合法跨项目操作不自动弹确认。跨授权边界按现有权限合同处理；任意 shell 仍不因 cwd 检查就成为 OS 沙箱。

### 6.4 持久 shell 与新默认的衔接

单次 `bash(cwd=...)` 与 shell 内 `cd` 只作用于该命令/shell。会话工作上下文切换必须同步后续默认 shell 执行基准：可以显式同步空闲 shell 的 cwd，或按已有生命周期准备新 shell，但要说明环境保留策略；不能每次丢弃 shell 环境来掩盖问题。

已有后台进程保留原目录与输出身份。正忙的前台 shell 不接收切换注入；后续命令待安全点后使用新基准。删除目录回退只可采用明确的会话合法候选，不能回退到共享 Host cwd。

### 验收

打开父工作区，让 Agent 自主发现并选择子项目，随后相对读写、诊断和搜索一致命中所选子项目；其他项目同名文件逐字不变。测试用户/Agent 切换冲突、旧调用延迟、两个并发子任务、shell `cd` 后文件工具基准不变、跨项目单次查询、重连后上下文恢复、非法路径与链接逃逸。

不得用“测试前由用户手动选 Varin”替代 Agent 自主切换的端到端验证。

## 7. RR3：命令边界、输出恢复与等待预算

### 7.1 分离用户载荷和监督器控制

在真实执行链中处理任意多行命令。用户命令必须作为完整的语法载荷传递，结束信息不能拼到用户最后一行。

执行者评估由受管命令文件/可靠的引用执行、专用通道或其他平台可用 framing 方案实现；选择依据是保持持久 shell 语义、stdin、取消、真实退出及跨平台能力，不是换个字符串看起来更干净。仅给当前插值补 `\n` 是可能的局部修复，不构成全部验收。

要求：

- heredoc（有/无末尾换行、quoted/unquoted、多段、`<<-`）、尾行注释、复杂引号、多行管道都能结束；不得通过追加 `:` 让 Agent 自救。
- 用户 stdin 与控制信息分离；用户命令可以消费 stdin，后续命令不能混入上一条尚未结束的载荷。
- 普通非零退出与语法错误如实返回；语法错误不破坏后续命令；`exit`、`exec`、进程树退出走真实进程生命周期，不强求一定收到 sentinel。
- sentinel/frame 解析处理分片、CRLF、无换行输出及恰好相似的文本；标记不是安全边界。缺结束标记不能永远报 running，也不能仅看到提示符就宣称成功。
- 避免固定 sleep 作为协议同步方式。失同步时保留输出，返回协议/执行状态，并通过确认旧 PTY 退出后重建恢复。
- 清理临时命令载荷应跟随进程/执行生命周期；载荷正文不进入日志，文件权限符合本地信任模型。
- 使用 Rust/terminal 现有进程与 writer 权威，保留 worktree 回收保护和已修复的 cwd 正规化/恢复。

### 7.2 统一执行/输出引用

为每条已受理命令建立可追踪关联：

```text
authority/session/Run + toolCallId
                → executionId
                → process/shell identity
                → retained output reference + terminal result
```

复用既有 execution、output/对象存储与受理记录，不建另一个临时 Map 当新的持久权威。工具呈现一个可以原样复制给 `get_output` 的引用，并明确支持哪些其他 ID；错误不能建议一个尚未注册或不可查询的 handle。

- 将“RPC/观察请求取消”“命令已受理”“进程被取消”“退出码已确认”分开。观察超时不能覆盖真实 exit 0。
- 对已受理但仍排队/运行的查询返回明确 pending/running，附状态和已得字节，不返回 not found。
- 大输出完整正文存入现有可分页存储；结果整理器仅影响展示，不覆盖原始输出。取消时保留可读正文。
- 按 session/执行身份验证查询权限；完成与取消后至少在声明的保留周期内可恢复。对 Host 重启后需要恢复的受理记录接入现有耐久执行/输出记录；如果该执行没有持久输出，返回明确 unavailable，不声称字节可恢复。
- 输出过期/回收明确返回 expired，并遵守引用保留；未知引用与无权访问不泄露其他会话信息。
- 同一 toolCallId 的不确定响应查询不重跑命令。执行去重依赖 owner 受理身份，不宣称跨所有崩溃窗口的绝对 exactly-once。

### 7.3 waitMs 的正式含义

面向 Agent 的合同定为：`waitMs` 是 Host 受理后的前台观察/等待响应预算，不是命令执行时限；整条调用仍可能包含请求到达前的调度和网络耗时。不得宣传为端到端硬 deadline。

一旦受理先有可查询 execution 身份；在准备或运行未结束、预算已用尽时，返回真实 pending/background 状态。排队/启动中不能伪装为已运行。输出组织超时应返回原始已得输出及引用，而非多等固定几秒。

分段记录 `received/accepted/spawned/firstOutput/exited/responded` 或等价时间，区分 preparation/foreground/formatting/transport。测 `waitMs=0`、冷启动、忙队列和输出整理慢的场景，选择有依据的测试容差；不把所有耗时隐藏进 waitedMs。

### 验收

用真实 Bash/Git Bash 执行无尾换行 heredoc；在临时 Git 仓库验证 `git commit -F -` 最终确实存在（不只看命令文本）。再执行语法错误、stdin 读取、`exit/exec`、取消竞态、后台→kill→下一条命令。

模拟命令 exit 0 但 RPC 回执丢失，按返回/已登记的原样 handle 读回完整输出及真实退出码；大输出分页字节一致，重复查询不执行第二遍。等待预算在慢启动/慢格式化下返回可追踪状态，进程按预期继续。

## 8. RR4：检索范围、索引覆盖、todo 和工具反馈

### 8.1 大工作区：共享基础、按任务召回

优先复用 workspace 内容/结构/向量/关系存储及稳定文件身份，项目是查询视图和调度单位，不为每次切换复制一套数据库。

- 项目发现是轻量目录/manifest/catalog 读取，覆盖嵌套 repo、monorepo 子包与非 Git 目录；Agent 可选择更细的子目录或多个项目。
- 默认检索当前操作目录；Agent 可对单次查询指定多个项目或整个授权工作区，无需用户先切工作区。
- 关键词、向量、结构与关系召回都在候选预算/top-k 之前应用有效范围。不能全工作区截断后再过滤而丢掉目标项目候选。
- 多项目查询保留项目来源并合理分配预算；具体数量沿现有可配置预算，用测量决定，不新增拍脑袋硬限制。
- 冷启动先提供项目地图与已可用文本检索；当前项目和打开/变动文件优先深索引，其他按需/低优先级。模型/向量不可用不阻止文件读写和普通检索。
- 默认忽略构建缓存、依赖及生成目录需与现有索引策略一致，允许授权内显式查询，不用永久禁用来掩盖性能问题。取消、切换、权限收缩后旧查询/索引结果不能错误注入新上下文。
- 缓存身份包含实际 authority、scope、工作分支/草稿视图、文件修订与相关模型/配置世代。不能仅用文件名或工作区显示名。

### 8.2 覆盖率与模型状态诚实呈现

`explore` 的文本片段可用，不等于 `related` 的图已构建。两者必须共享 canonical 文件/版本身份，分别报告 text/vector/relations 覆盖；关系按需采集或返回 not-indexed/stale，不能当成不存在。

将模型路由拒绝细分为未配置、显式关闭、无授权、provider 不可用、选择结果不合法或超时；沿既有 slot/配置和凭据权威修复，不偷偷借用主模型或更改用户模型。已有降级排序保留来源说明。

Agent 默认输出只给有效片段、真实范围、完整性和短降级原因。大量 omitted/unread 详情保存到有权限的 output reference，按需读取；具体缺哪些来源/范围仍可追溯。不要让“缩短输出”丢失 partial 状态，也不要列出未授权项目的路径。

### 8.3 grep 和 diagnostics

grep 将 matchedFiles、扫描覆盖、partial 分开。底层不知道实际扫描文件数时，移除伪 searchedFiles 数字/用可空值，更新所有协议消费者；完整零命中明确说明 No matches in the requested scope。不要为了一个统计额外扫全仓。

diagnostics/LSP 的路径在 RR2 统一后，将 not-ready、unsupported、no-diagnostics、failed 分开；返回实际文件修订、文本来源与覆盖信息。绝对路径转为内部相对资源 ID，而不是要求 Agent 记住工具特例。

### 8.4 todo 的稳定归属

plan 是会话/分支工作状态，不能因压缩、结束一个辅助 worker、切换项目、断线或检索索引未就绪而丢失。复用现有存储，但其可用性不依赖 embedding、快速决策或 knowledge suggestion 服务。

核查 `session.snapshot` 中 workspace 字段缺失/覆盖、thread owning/execution workspace 区别、bind/drop 竞态及辅助 actor 退出。通过持久/已验证绑定解析正确 owner，不任意 fallback 当前 UI 工作区，不新建空 plan 伪装恢复。

维护 plan service 的独立合同、分支修订和既有单 writer；知识存储损坏/不可用真实报错并保留已有数据。项目切换不把其他会话的 plan 绑定过来。

### 验收

多项目夹具默认只召回当前项目；显式跨项目可找到两个项目且不被大项目挤出。重复文件名、草稿/分支和索引版本变化不串结果。explore 命中文本但图未采集时返回准确关系状态。零命中不声称扫描 0；todo 在运行→压缩/settle→重连/切项目后仍属于同一会话。

## 9. RR5：统一出站网络、fake-IP 与安全策略

### 9.1 先澄清问题

fake-IP 是某些代理 DNS 模式使用的域名映射地址，不是 Varin 的必要依赖。IANA 将 `198.18.0.0/15` 登记为 Benchmarking、非全球可达；mihomo 文档示例在这一范围设置 fake-IP 池，但地址池可配置。检测到它只能说明“特殊用途地址，可能存在代理映射”，不能证明目标安全或具体代理存在。[外部参考](#external-references)

当前 Host 的 `lookup()` 前置检查与后面的全局 `fetch()` 是不同步骤；curl、独立 Node、Electron 内嵌 Host、Pi worker、远程 Host 和浏览器未必共享 DNS/代理。Node 官方代理能力还有版本和启动配置条件。执行者必须检查实际运行路径，不能只加环境变量就宣布全部联网修好。[外部参考](#external-references)

### 9.2 出站配置及接线

基于现有 Host 设置/权限/凭据 owner 提供统一的出站传输策略。至少明确 auto、direct、explicit proxy 的来源与优先级；具体字段以现有配置合同为准。

- auto 使用执行 Host 上可信且受支持的配置，明确记录实际选用来源；若支持系统代理/PAC，必须通过现有平台适配器验证，不能声称 Node fetch 自动等于 Electron/系统代理。
- 支持实际运行时所需的 HTTP(S) 代理、NO_PROXY 与认证处理；SOCKS/PAC 等仅在真实支持时声明。显式配置不支持的协议返回 unsupported，而不是绕过配置偷偷直连。
- 网页、Web/科研搜索、模型相关消费者通过各自 owner 的适配复用网络策略；不夺取 Pi 的模型/凭据权威。不为每个工具手写不同代理逻辑。
- UI 显示作用于哪个 Host，远程 Host 不借用客户端本机代理假定。内部 loopback/IPC 路径不能被全局代理改动误伤。
- 请求使用冻结的网络策略版本；配置更新正确管理连接池和旧请求，不用频繁修改全局 dispatcher 制造跨会话竞态。
- 失败不静默回退直连，不泄漏代理本应处理的目标/DNS。取消、超时、重试与响应大小沿现有合同，不另造无限重试。
- Agent 有只读网络诊断能力，能查询实际模式、解析阶段/错误码和目标检查结论，不读取凭据。不得自动关闭证书检查、安全规则或改系统设置。

### 9.3 安全检查与实际连接同路

直连：域名/IP/端口和实际要连接的地址走同一验证路径；正确处理 IPv4/IPv6、规范化表示、解析失败和地址变化。不能先 lookup 检查一次，再让连接独立解析到其他地址而仍声称完成 pinning。保持正常 Host/SNI/证书验证；连接尝试和重定向每一跳都重新执行所需策略。

可信显式代理：分别验证代理端点和最终目标。允许连接 `127.0.0.1` 的已配置代理，不等于允许把任意本地服务当目标。代理远程解析场景应明确最终目标限制由哪里强制：优先使用代理侧 egress 策略/可验证解析能力；只有部署所有者明确配置的可信出口委托才能成为策略依据，不能因存在 HTTPS_PROXY 就默认赋予安全信任。

透明代理/fake-IP：不把保留地址整段加入公共放行表，也不把所有映射一律误报私网。已验证的受支持路径正常工作；不能验证最终目标时给出准确不兼容/策略原因与可配置路径。该限制须诚实记录，不宣称所有透明代理天然兼容。现有用户已授权的本地开发服务按原权限策略访问，不新增全面内网禁令。

### 9.4 错误合同

分开表达 DNS failure、scheme/target denied、特殊用途地址/疑似映射、proxy unavailable/auth failure、TLS failure、HTTP error、timeout、cancelled。字段名可按现有类型设计，但 DNS 查询失败不能再显示 private-network。策略拒绝与基础设施故障的重试建议不同，真实错误码保留到可诊断层。

代理认证、查询 token、证书材料不出现在工具正文或常规日志；跨 origin 重定向不得泄漏目标认证和代理认证。安全依据见 [OWASP SSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。

### 验收

在受控 DNS/HTTP/代理夹具中验证：直连、显式代理、NO_PROXY、代理不可达/认证失败、DNS 失败、IPv4/IPv6、本地目标允许与拒绝、fake-IP 映射、重定向到受限目标、DNS rebinding 和 TLS 失败。实际 DNS 失败准确报错；已配置可信代理的公网 webfetch 能完成并取消；禁止规则仍有效。

补实际开发 Node 和 Electron 内嵌 Host 的联网 smoke；其他平台/透明代理未测试就明确登记，不关闭防护来取得绿灯。浏览器 curl 对照不能代替这些证据。

## 10. RR6：交付与联合验收

以下场景按已有测试/脚本复用，不要求逐条新建一个文件。测试必须观察真实行为，不只断言 mock 被调用或 CSS/字符串存在。

| 场景 | 必须观察到的事实 |
| --- | --- |
| 大工作区内自主选项目 | Agent 真正调用上下文能力；后续相对文件、LSP、检索均一致，邻项目未误写 |
| 工作上下文并发 | 迟到切换/请求不覆盖新修订；父子和后台执行保持各自上下文 |
| 流式输出断线后后台完成 | 前端自动追上历史、usage、tool result、idle，未重复执行任务 |
| 连接恢复但任务仍在输出 | 快照与后续事件无空洞、不重复，不因消息变 persisted 而闪回旧正文 |
| 停止与断线交错 | requested/accepted/settled/unknown 正确；无假成功、无永久截流、真实错误不被隐藏 |
| heredoc、注释和语法错误 | 真实 shell 正确终结或返回明确故障；下一条命令不受污染 |
| exit 0 但响应丢失 | 原样输出引用可查 exit 0 与完整输出，不执行第二次 |
| waitMs 和慢准备/整理 | 预算到期给可追踪状态；不把 pending 冒充 running，不无故杀命令 |
| 关系索引/模型降级 | 身份一致，覆盖和部分状态可见，默认正文不倾倒候选全集 |
| todo 的生命周期 | 正确会话/分支计划持续可用；存储失败不被空结果掩盖 |
| 代理与 SSRF | 受支持出口可用，拒绝/解析/代理/证书故障可区分，安全规则没有旁路 |
| 已交付 UI/恢复非回归 | 不破坏滚动锚点、全高 scrollbar、工作概览、Dirty buffer、WorkingState 和 shell cwd 恢复 |

性能只报告有复现步骤的结果。RR0 记录停止响应、断线检测/追平耗时、waitMs 各阶段和检索上下文大小；实现后用相同夹具对比。硬预算由具体瓶颈和目标平台确定，不能把某个 mock 测试总耗时当线上停止延迟，也不能宣称所有 provider 都在固定毫秒数内退出。

验证层级分开记录：源码/单测、真实 Host/Pi/WS 纵切、安装包 smoke、远端 CI、真实付费/代理环境。每个已完成阶段在 status 写入 commit、实际命令和结果、证据文件、未测项；本计划的任务勾选只表示相应工作已处理，是否 wired/proven/default-on 仍以 status 为准。

## 11. 执行约束与验证入口

### 11.1 保全现场与控制范围

- 核查时仍有 `packages/protocol/src/*.js`、`packages/protocol/test/*.js` 未跟踪文件。先记录现场，不删除、不提交，不把它们当源码 authority；必要时检查是否影响解析。仅在发现确实阻碍本任务且有明确处理依据时另行记录处理。
- 不扫描 `.git`、`node_modules`、`kernel/target`、打包目录做无界全仓 grep。优先精确文件、`git ls-files` 和限定目录查询；所需依赖源码按包精确读取。
- 不通过裸 `tsc` 输出到 src；按包脚本和正确构建依赖验证。已运行产品与新源码/构建产物须区分，不能测着旧二进制就宣布新功能通过。
- 内部格式可按仓库原则直接替换，不保留旧 reader/双写/fallback；这不是删除用户文件、Git、Pi 原生历史或尚在使用的结果正文的授权。
- 不给每项修改增加无关测试，不机械全仓循环。数据/并发/网络/进程风险要真实行为覆盖；纯展示和静态类型不需要复制实现常量的测试。
- 模型可见工具说明、结果与错误沿项目规范使用英文；UI 文案进入现有 i18n catalog 并补齐支持语言，不把内部错误码直接当产品提示。
- 按阶段可审阅提交并依仓库规则推送；保护分支拒绝时保留本地提交并如实报告或走已有分支/PR流程，不绕过检查、不 force-push。不得发布 tag/release 或部署外部环境。

### 11.2 按实际修改选择命令

当前脚本入口如下，执行前确认最近的 package.json；这不是每阶段必跑清单。

```text
bun run --cwd packages/ui test
bun run --cwd packages/ui type-check
bun run --cwd packages/ui lint
bun run --cwd packages/ui test:i18n
bun run --cwd packages/protocol test
bun run --cwd packages/runtime-client test
bun run --cwd packages/runtime-broker test
bun run --cwd packages/pi-host test
bun run --cwd packages/web test
bun run --cwd packages/web type-check:application-host
bun run test:kernel
bun run test:docs
git diff --check
```

UI 的现有测试通过 Vitest；runtime-client/broker/pi-host 依其 `tsx --test` 脚本。限定测试文件和命令参数以该包配置为准。kernel-backed suite 已隔离到 `packages/web/vitest.kernel.config.ts` 并由 `scripts/test-kernel-authority.mjs` 管理；不要误用普通 web 测试入口得到“未执行所以通过”。原生版本错配应构建/准备正确环境或明确标记未测，不能沿用报告里的旧环境失败豁免。

优先复用现有 `usePiSessionStore.test.ts`、`client.test.ts`、`websocket.test.ts`、`runtime-surface-connection.test.ts`、`gateway.test.ts`、`path-authority.test.ts`、`session-registration.test.ts`、`shell-supervisor.test.ts`、`shell-assembly.test.ts`、`output-store.test.ts`、`explore-service.test.ts`、`todo-tool.test.ts`、`web-fetch.test.ts` 等最近行为覆盖。缺失的真实消费者/故障组合再添加，不以本文件列表决定测试数量。

### 11.3 交接/结束报告

每阶段报告：修复的用户现象、根因证据、协议/行为变化、涉及 owner、实际测试与未测环境、commit，以及下一未完成步骤。阶段受真实环境阻塞时继续独立工作，并留下可运行复现，不只写 TODO。

最终检查 RR1–RR5 都有生产消费者；RR6 记录未完成项而不笼统“全绿”。安装包/开发运行方式需要怎样重启或构建才能使用新代码，应在交付时说明；重启可以应用更新，但不能是修复后每次恢复卡住会话的必要操作。

<a id="external-references"></a>

## 12. 外部参考

以下仅解释网络语义，具体 API 要匹配仓库实际运行时版本；不是要求更换 SDK 或复制一个新的网络栈。

- [IANA IPv4 Special-Purpose Address Space](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)：`198.18.0.0/15` 的用途和全球可达性。
- [mihomo DNS configuration](https://wiki.metacubex.one/en/config/dns/)：fake-IP 模式与可配置地址池；不能由 IP 段反推真实代理安全性。
- [Node.js Enterprise Network Configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration)：代理环境配置、启用方式、CA 与具体版本差异；HTTP agent 配置不自动等同于 fetch 配置。
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)：地址验证、DNS、重定向与网络层控制的边界。
