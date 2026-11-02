# 可替换执行循环：Run Driver 设计

状态：设计提案，尚未实现。日期：2026-11-02。源码基线：Varin `7b276502`；DeepSeek Harness 本体 `ce7073d51254c26cd63b22a60835b8f948deb447`。本文不以 `dsh-superagent-prototype` 为 Harness 架构依据。

**结论：执行循环可以成为可替换的 provider。现有 Rust 循环应是默认实现，而不是所有扩展必须遵循的算法。** 统一权限、资源与执行事实，不要求唯一的思考方式、上下文组织或模型/工具调度。

本文界定目标与首个验证切口，不宣称下面的 API 已经存在。当前行为仍见[运行时](../runtime.md)、[扩展](../extensions.md)、[外部 Agent](../external-agents.md)。它与本轮扩展作者链、代码信任和升级恢复修复独立，不以完成大内核重写作为那些修复的前提。

## 1. 用户获得的自由

- 在 Agent 配置中选择不同循环：普通对话、并行规划、搜索式探索、反思与验证、领域专用算法，或自己编写的循环。
- 循环可以直接决定何时发起多个模型请求、如何交错工具工作、构造多分支上下文、等待外部输入以及何时交付；不必把全部行为翻译成固定的 `PolicyAction` 序列。
- 用 Varin 的模型、工具、权限和资源设施编写循环，不必重新实现安装、账户、工作区或聊天界面。
- 也可以选择完全独立的外部 Harness。其循环和内部会话归它自己，Varin 不要求它伪装成默认循环。

这里的统一是**事实与能力入口可组合**，不是统一算法、强制阶段或工单流程。没有 Ticket/Mandate 流水线，没有必经的“规划→执行→验收”业务状态机，也不恢复已退役的 LSP 产品路径。

## 2. 实际源码给出的依据

### DSH 本体：可替换的结构已经成立，验证范围不能夸大

- [`AgentFactory` 与 `AgentRegistry.setFactory`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent/src/index.ts#L175) 把创建/恢复 Agent 的合同与具体循环分开；[`AgentLoop`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/index.ts#L291) 是注册到该入口的默认实现。
- [`ToolExecutor`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/executor.ts#L63) 将模型可见呈现与完整批次调度交给 provider。Native、PTC 是两个真实实现，说明可替换的不只是提示词。
- [`ToolsService`](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/index.ts#L325) 不把已经选中、后来失效的 executor 偷换成另一实现；合同要求已开始工作实际结束后才结算批次。
- 当前源码只发现一个生产 `AgentFactory` 实现，factory 注册也是单一槽位。不能据此声称任意 per-Run 循环混搭都已被产品验证。

借鉴的是“接口/实现/消费者与生命周期分离”，不是引入 Cordis 依赖或照搬其整棵插件树。其动态 Host VM 也[明确不提供安全隔离](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/extensions/cordis-host-runner/src/sandbox.ts#L1)；更大的算法自由度不能用来暗示更强的系统沙箱。

### Varin：已有很强的策略扩展，但还不是任意循环

- [`AgentPolicy`](../../kernel/crates/varin-runtime/src/execution.rs) 已有模型任务、工具图、结果读取、交付、暂停、等待等 11 类动作；[`policy_actions.rs`](../../kernel/crates/varin-runtime/src/policy_actions.rs) 的工具图已有真实并行。
- 但 `ExecutionEngine` 仍解释闭集动作，限制 pending model/tool exchange 与其他动作互斥，并决定整个调度顺序。扩大枚举或给 `policy@4` 改名，不能兑现任意循环。
- [`RunSupervisor`](../../kernel/crates/varin-runtime/src/supervisor.rs) 在受理后直接构造 `ExecutionEngine`，调用其恢复入口。这是最直接的 driver seam，而非另建第二套会话系统。
- 已有 `ModelProvider`、`ToolExecutor`、`Persistence` 及 Operation/inference/resource owners 可复用。不过 [`catalog_inference_generation.rs`](../../kernel/crates/varin-runtime/src/catalog_inference_generation.rs) 要求真实父 Operation 的 live inference context，[nested-tool owner](../../packages/web/application-host/lib/kernel/nested-tool-owner.ts) 也要求原 invocation authority。不能把私有 RPC 直接暴露给插件，或伪造一次工具调用来获取执行权限。

## 3. 三条路径并存，不用一种合同吞掉所有实现

| 路径 | 用户选择的内容 | 适用边界 |
| --- | --- | --- |
| 默认 driver + policy provider | 更换规划决策，沿用现有循环 | 保留 `policy@4` 及现有作者，不假称全部循环可改 |
| **Varin 能力上的 driver provider** | 自由编写算法、调度和上下文组织 | 本提案的核心；使用真实 Varin 执行原语与记录 |
| 外部 Harness provider | 整个独立运行时及其内部循环 | 沿现有会话桥接，按真实接口提供控制和观测 |

不采用“只增加更多 hooks”作为终点：它成本较低，但默认循环仍会规定哪些算法能表达。
也不把“只接外部 CLI”当作原生 driver 的替代：那会迫使作者放弃 Varin 的现有工具与资源能力。
暂不将全部 Catalog/权限/资源设施整体插件化；这不是禁止以后替换，而是它们不是这次开放循环所必需的改动。

## 4. 选定 driver 与执行上下文

### Provider、实例和 Run 分开

沿现有 extension manifest、versioned Host service、routing 和 composition 发现并准备 driver。Rust 内置实现直接实现同一语义的 trait，不为了形式统一而绕一圈 JSON；第三方 Host/进程实现可以使用版本化桥接。语言和算法不是准入条件。

`RunStart` 捕获选定 driver 的实现身份、配置身份与 composition，交给 Supervisor。普通配置修改影响下一次受理，不改写正在工作的 Run。每个 Run 可以有不同选择，不引入一个不可覆盖的全局 loop 单例。

Provider 负责准备实例；实例拥有自己的算法状态、任务和清理。Supervisor 继续拥有 Run/epoch 受理、停止意图、实际执行者寿命与退出汇合。provider 声明与实际激活/恢复成功仍是不同事实。

合同的语义大致如下；名称与 RPC 形状需在实现时根据真实消费者收敛，不先冻结一份空 SDK：

```text
Driver provider: prepare(selection, capabilities) -> prepared implementation
Driver instance: start(input, run context) -> running handle
                 resume(checkpoint, reconciled work, run context) -> running handle  [若支持]
Running handle:  completion / request stop / dispose
Run context:     model work, tool work, delivery, waiting, checkpoint + evidence references
```

`dispose` 与 `request stop` 不等于完成。运行 handle 的 completion 必须以实际 owner 汇合为依据，不能由任意插件 JSON 声明“所有执行者已停止”。

### Run context 是真实执行能力，不是万能数据库接口

由原 owner 按 **Run + epoch + driver 实例** 产生不可伪造的调用上下文。共享 worker 处理多个 Run 时，也不能靠一个可变 `currentRun` 全局变量识别权限。

| driver 决定 | 原执行 owner 决定 |
| --- | --- |
| 模型调用顺序、并行度与所需上下文 | 模型绑定、凭据、准入、原始请求、用量和真实结束 |
| 选择工具、依赖、分支与调度时机 | 输入与权限检查、来源/资源受理、dispatch、receipt 和效果状态 |
| 私有计划与恢复状态 | checkpoint 的持久提交与引用完整性 |
| 输出什么、等待什么、是否结束算法 | 用户可见交付事实、已受理工作的存活/结算与 Run 收尾 |

上下文不开放任意 SQL、原始 credentials 或“自行宣布效果为空”。这不会限制循环算法，只避免把执行事实的证明交给它自己。可信 Host 代码仍具有其运行环境的环境权限；这些 API 不是 OS containment。

## 5. 并发与多分支上下文

- 模型、工具等操作通过原 owner 受理，得到稳定操作引用。driver 可以同时保留多个句柄，等待任意一项、处理流式结果、增添分支或取消不再需要的工作。
- 不把“必须先关闭唯一 pending exchange 才能做其他事”提升成公共合同。该规则可以继续属于默认 driver。
- 请求模型的上下文可由 driver 自由构造，不要求都从唯一线性对话尾部推导。实际发送的请求、模型绑定、引用/来源和用量仍需可追溯；UI 可以展示多个并行分支，而非伪造一个不存在的串行历史。
- 不安全的资源并发由原资源 owner 处理，不由全局循环锁串行化所有工作。权限和资源冲突不会因为算法是插件而绕过，也不由第二套插件锁表重复决定。
- 重试必须指向原受理工作或产生明确的新操作。请求响应丢失时读原 receipt，不把同一次未知效果再次 dispatch。这里不承诺跨任意外部系统的“恰好一次”。

driver 可以自行实现树搜索、模型讨论或领域逻辑；这些是普通代码，不必成为产品中的固定 workflow 类型。

## 6. 恢复、版本与切换

恢复能力不是一个泛化的 `supportsResume: true`，至少需要区分以下实际行为，只有存在消费者时才进入正式 contract：

- **原进程继续**：连接恢复后仍连接同一个活执行者。
- **checkpoint 恢复**：新进程从已提交私有状态和原操作事实继续算法。
- **外部会话恢复**：后端协议可以 load/attach 原会话，覆盖范围由该后端决定。
- **不支持恢复**：中断后诚实结束该执行尝试；用户可新建续接工作，不重新发送原输入冒充恢复。

checkpoint 包含 driver 实现/配置身份、私有 schema 版本及引用的原 Operation/上下文位置。私有状态存入现有 Catalog/ContentStore 所属的 Run 数据，而不是共享 extension storage 中一个无身份的 `current` 文档，也不新增 TS 会话数据库。

恢复顺序是：先核实原 Run、driver 和当前授权，再读取持久 checkpoint，并由原执行 owner 对尚未结算的工作做 reconciliation，最后把真实可继续状态交给 driver。算法不能自行把 unknown 改成 success/none，不能通过恢复重启已撤销的权限。

版本升级可以声明并验证明确的 checkpoint 迁移。迁移产生新版本状态并保留原记录，不覆盖旧 checkpoint；不从 semver 或同名 provider 猜测兼容。当前扩展恢复仍会拒绝已变化的原 artifact/grant；若未来允许重建仍受信的历史 driver artifact，需要把其代码信任与撤权规则一起做成原 owner 合同，不能仅因缓存还在就执行。

已存在、没有 driver 字段的旧 Run，若实现本提案，应由明确的格式迁移映射到**历史默认 driver**，而不是当时最新的用户默认值。旧日志与效果记录保持不变。

### 用户何时能换循环

新 Run 自由选择。正在执行的 Run 可以在双方明确支持的 handoff/checkpoint 边界切换；需要转换的是私有算法状态，不是抹去既有执行事实。若双方不支持这种转换，仍可停止原工作并新建带上下文引用的续接 Run。这个选择应直接呈现，不声称已经在原地恢复，也不复制未知外部效果。

## 7. 停止、更新、卸载与数据归属

- 正常更新禁止新工作进入前代，但已受理的原 handle 保留其 driver 与依赖，直到实际汇合；不能把长调用移交给同名新 provider。
- disable/撤权立即关闭原调用授权，并向真实执行者发停止意图。合作式停止、可确认的进程终止、仅断开连接必须分别报告；插件不能靠一个 resolved Promise 证明外部进程已退出。
- 共享进程若只能整体终止，应明确它会影响哪些 Run；不宣称能隔离停止单个算法实例。新上下文、卸载和恢复也不能把一个 Run 的权限带到另一个 Run。
- Run checkpoint、原始模型/工具记录和交付归 Run 数据 owner；扩展安装配置与插件私有应用数据归 extension owner。卸载代码不删除运行证据；删除私有数据是独立明确动作，不能被“清理插件”隐含触发。
- 不支持某种恢复/停止能力不应被假装支持，也不必因此禁止该 driver 用于所有任务。界面和调用方按实际可用性作选择；不能因普通 provider 替换而悄悄降级已受理 Run 的保证。

## 8. 外部 Harness 的关系

现有 [`HarnessConnection`](../../packages/web/application-host/lib/external-agents/adapter.ts) 已承接独立后端；[`service.ts`](../../packages/web/application-host/lib/external-agents/service.ts) 目前仍显式连接 Codex、Pi、Claude 与 ACP，尚非普通扩展注册的连接器集合。

可以另将连接器提取成 provider registry，让新增外部 Harness 不必修改中心分支；这与原生 driver seam 相辅相成，不是同一个接口硬塞两种工作方式。ACP 的 resume/load 来自实际 handshake；停止请求和明确进程终止也已有区分，应沿用而非推翻。

外部后端只报告活动文本时，Varin 不据此生成伪原生 tool receipt。后端真正调用 Varin 工具入口时，该次工具工作才由原 Varin owner 受理。展示可以共用一套聊天与协作界面，证据等级和执行归属仍清楚。

## 9. 第一个实现与证明标准

推荐把第一批实现做成一条完整但有边界的产品能力，而非先发布空接口：

1. 从现有 `ExecutionEngine` 分离算法驱动与可复用执行原语；Supervisor 通过 driver 合同启动默认实现。默认行为、原 Run 恢复、权限与 receipts 保持兼容。
2. 在既有扩展 discovery/routing/composition 上接通一个真正不同的 driver。`policy@4` 留在默认 driver 内，不成为其它实现的强制父接口。
3. 第二实现用有实际用途的**并行规划与验证循环**证明自由度：两个模型请求同时推进，依据先到结果动态交错工具与补充上下文，再合并交付；不借伪工具调用进入私有接口，不编码成默认单动作循环。
4. 验证使用真实 Catalog、Run/Operation、资源准入、扩展激活与退出 owner；仅替代外部模型响应或不可控外部系统。展示 discovery→选择→实际运行→停止/恢复这一完整作者和用户链。

验收不能只检查注册成功，应证明：

- 第二循环没有再次调用默认循环作为隐藏执行器；并行请求和交错确实发生，而不是只在日志中声明。
- 无权限/错误资源在真实 dispatch 前拒绝；取消后仍运行的工作不会被标成已停。
- 进程在受理后、dispatch 后、checkpoint 前后中断时，重启读取原操作事实；不存在自动重复效果或 provider 偷换。
- 更新/卸载/撤权/共享 worker 下的多 Run 不串身份；旧 Run 恢复与当前默认选择分离。
- 不支持的后端能力在用户界面明确，既不伪造保证，也不把所有第三方循环一概禁用。

这次设计不同时建设新 marketplace、插件自升级政策、统一业务工作流 DSL、通用跨 driver 自动迁移或全部平台的恶意代码沙箱。后续实现需要通过上述第二实现来收敛 public contract，而不是用更多抽象替代真实自由度。
