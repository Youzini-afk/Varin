# 扩展归属与运行时组合

Varin 扩展通过 manifest、capability client、service 和 contribution 扩展 Application Host 与工作台。
Pi package 独立扩展 Pi Agent。可选 Rust Agent runtime 通过执行绑定消费选中的 Varin service，
不另建安装器，也不把历史权威交给扩展。相邻职责见[架构](architecture.md)、[运行时](runtime.md)和[工作台](workbench.md)。

本文解释当前机制与失败边界。精确作者 API、schema 字段和示例由[作者指南](ops/varin-extension-authoring.md)
及对应包维护，不在这里复制另一份接口目录。

## 包与进程边界

| 包 | 职责 |
| --- | --- |
| [extension-contract](../packages/extension-contract/README.md) | 浏览器安全的 manifest、service、contribution、routing、workbench 与 wire contract |
| [extension-host](../packages/extension-host/README.md) | Catalog、artifact、grant、storage、Host supervisor 与 service binding |
| [extension-surface](../packages/extension-surface/README.md) | 与框架无关的 contribution/service registry 和 owner transaction |
| [extension-loader](../packages/extension-loader/README.md) | 认证 asset、activation event、Surface realm 与状态协调 |
| [extension-sdk](../packages/extension-sdk/README.md) | 作者 context、capability client、provider helper 和 conformance fixture |
| [extension-react](../packages/extension-react/README.md) | Framework-neutral mount contract 的可选 React adapter |
| [extension-builtins](../packages/extension-builtins/README.md) | 发行声明与不可变内置 Host asset |
| [extension-cli](../packages/extension-cli/README.md) | 模板、manifest 检查、build mapping 与作者测试 |

受信任 Web server 是 Application Host，嵌入 Electron 时也不改变这一归属。远程 Web 和 mobile 使用
该 server 的扩展安装及兼容 Surface entrypoint；headless Host 无需窗口即可激活服务。
切换 Pi runtime 不移动 Application Host 的扩展目录、asset、grant 或 storage。

普通产品 Shell、editor/renderer、页面、命令和 provider 与外部扩展共用 registry。
Core 保留 bootstrap、认证、合同校验、生命周期和恢复基础。完整自定义 Shell 不必使用 React、
官方组件布局或每个官方 slot，但必须声明它实际承载的组合接口。

## 身份、数据与信任

扩展具有 manifest ID 和版本。安装来源、artifact integrity、selected version、candidate、
desired enablement、已审查 grant，以及每个 realm 的 actual generation 是独立事实。
Installed 不等于 enabled，enabled 不等于 active 或健康。公开目录不暴露安装路径或来源凭据。

Package manager 接受 npm、Git、本地目录和已注册 built-in source，不执行安装 lifecycle script。
运行使用核验后的不可变 artifact，不使用可变 checkout。浏览器 bundle 经认证读取并校验后加载，
可复用凭据不进入 module URL。包括 archive-backed 桌面发行在内，内置 package root 必须先解析为真实
unpacked directory，再准备 artifact。

Capability request 与实际 grant 分开，按 manifest version 和 realm 审查。同一 extension ID 升级
不会自动继承新增权限，调用核对真实 owner 与当前 Host grant。撤权在异步替换前更新 live/draining
callback 所用的 grant，候选失败保留旧实现也不能保留已撤销权限。声明 read-only、tool schema 或
发现元数据均不构成授权。

不同执行模式提供不同隔离保证：

- Declarative contribution 只有数据，不运行第三方 Surface 代码。
- Managed Surface module 的平台效果由 owner 跟踪，直接使用原生 API 的效果由作者负责清理。
- Isolated iframe/Worker 使用 message bridge，可以销毁 realm；Worker 只做后台工作，不能 mount 视觉贡献。
- Trusted-native Surface module 位于共享 realm，未跟踪效果可能需要 reload。
- Brokered Host module 运行在 supervisor-owned process，通过 capability 访问 Varin；仍具备其 OS
  账户权限，子进程不等于 OS security sandbox。
- Trusted-native Host module 在主机进程内执行，保留协作式清理与 restart 语义。

Extension storage 管理 namespace、revision 和原子持久化，扩展管理自身 schema。
`storage.open` 为各 scope/key 打开独立文档。Disable 保留数据与 layout reference。
Remove 和 delete-data 是两个选择；删除仅限该扩展 namespace，不包括项目文件、Pi package 或插件私有数据库。
读取失败、malformed、missing 与有效空数据始终分开。

## 激活、发布与退役

Manifest declaration 可在激活前发现。Lazy entrypoint 等待真实 command、contribution-visible、workspace
或 service demand；startup/background 和未声明延迟事件的入口按其生命周期启动。
Disable 清除事件 latch，重新启用 lazy entrypoint 后仍需新的真实触发。

准备阶段先解析依赖、grant 和 artifact identity，再暴露新 generation。Surface runtime 暂存 contribution、
service、context-key write 与已连接 consumer 的 mount；失败则回退暂存 owner，保留已提交前代。
Host 在启动 worker 前解析选中的依赖图。必需依赖环、缺失或歧义在激活前失败；optional absence 明确表达。

耗时加载、mount 准备和清理位于发布保留区之外。顺序只约束同一 owner、真实依赖及冲突的
contribution/service key；一个停滞扩展不会占住全部扩展的公共队列。
相同有效 Host graph 的并发准备共用工作，某调用方停止等待不取消其他调用方的准备。

Owner generation 按需捕获 Host、extension、entrypoint、realm、desired revision 和 implementation identity。
已被取代的激活不能向新 owner 注册。自定义 context key 带 extension namespace，在私有层暂存，
与 contribution transaction 一起发布；旧 writer 不能恢复已撤回的值。

普通替换关闭前代的新调用入口，已有 call 和冻结 exchange 继续使用原实现直到完成。
只保留实际被引用的 generation：A 的长调用不应让 B 在 B→C 替换后也无谓存活。
显式 disable、撤权、crash、shutdown 具有更强的取消语义；cancel request 或 kill signal
仍不能证明实际 callback 或外部效果已经停止。

可见 contribution 先撤回，再进行异步 cleanup；mount 退役先于 owner resource disposal。
Disposer 逆序执行，某项失败不阻止其余清理。Broker shutdown grace 只处理正常 pin drain 后仍挂起的
清理，不是模型/工具时限；强制退出报告 cleanup unconfirmed，不伪造成功撤销。
Trusted-native cleanup 不承诺回收任意同进程代码与效果。

<a id="candidate-updates-and-failure-ordering"></a>
### 候选更新与失败顺序

Stage update 不执行候选；capability review 和显式 apply intent 是独立 catalog 事实。
准备使用原 storage/catalog owner 与 expected revision。发布前失败保留 selected artifact 和活动组合；
持久发布后，响应丢失或清理失败不能把已提交选择改写成 rollback。

默认情况下 Host 与 Surface entrypoint 各自报告 actual state。Surface 激活失败可以保留自己的旧 owner，
但不撤销已经选中的 Host artifact。Module ready 也不证明界面已经 mount 或 paint。

`manifest.updateReadiness.surfaceEntrypoints` 将一个扩展的候选更新显式组成 Host/Surface group。
只有 enabled、reviewed 且有 apply intent 的 candidate 才进入该准备。
全部具名成员，包括 lazy/declarative entrypoint，在一个参与且兼容的 Surface 中准备；
未列出的 optional entrypoint、其他窗口和无关扩展不自动加入。

已连接 contribution consumer 先准备真实 mount 并验证 lease，再由受信任 Surface host 提交原始
Host preparation ID 与本地成员 generation。Catalog commit 重查 artifact、review、intent、revision
及 cancellation。没有已连接 mount 只能证明 module ready。首次启用和已选 artifact 的恢复不依赖窗口。

发布前关闭或失败的 mount 可以取消该请求并保留旧 owner；确认发布后，以 selected artifact 为准，
响应丢失要读取权威状态。一个 Surface 失败不能丢弃仍由待应用请求持有的有效共享 Host preparation。
这里没有持久全局窗口注册表，也不声称整个进程或多窗口的原子事务。

Trusted-native Host 前后代不能安全并行准备。Grouped hot update 返回
`trusted_native_group_update_requires_restart_handoff`。支持路径是 disable、在 disabled 状态下 apply
已审查候选、重启 Application Host、再 enable。未分组 native update 保留显式 apply/restart 路径。
单纯 staging 或 review 都不授权激活。

## Service routing 与精确绑定

Versioned service identity 与 package identity 分开。稳定 `providerKey` 选择实现，带 generation 的
`providerId` 指向实际实例。Revisioned ServiceRoutingStore 是唯一可变选择权威，scope 可包括 user/profile、
workspace、runtime/session、Agent/model 和 invocation。同优先级冲突规则返回 ambiguous；选中 provider
不可用时，只有规则显式允许才向下 fallback。

Requirement 声明 Host/Surface realm 及 single、selected、all binding，各 realm 只消费自己的依赖。
激活时固定实际 client，再次请求 service 不会暗中切到新 generation。Host instance identity 包含
artifact、reviewed grant 与精确 dependency generation，不包含无关 routing revision 或每个 consumer Thread ID。

有序组合必须声明 `composition: "ordered"`，`multiple` 本身不足以启用组合。
Routing 的 `providerKeys` 保留顺序，所选成员都必须可用；fallback 选择整条低优先级规则，不截短集合。
显式空集合表示无贡献，删除 scope rule 才恢复继承。

Managed/isolated Surface consumer 通过认证 `watchServiceLease` stream 保留精确 Host root，
调用沿用原 routing context。Stream 关闭释放这些 root，已受理 callback 则自行保留 pin 直到实际完成。
意外结束或撤权使原组合失效，旧 handle 不会重连后偷偷选另一 provider。
Surface-local service 同样保留已绑定的原 owner。

`prepareService` 返回必须释放的精确 generation handle。独立 `pin()` 保留已受理 exchange；
child 只能从仍被保留的原 binding 派生 pin。撤权沿实际依赖边传播，共享 activation context 不持有
某一个 Run 的调用权限。

## Rust Agent 组合与工具动作

Pi 仍是默认产品路径。Rust Agent 通过 [CompositionRegistry 及 resolver](../kernel/crates/varin-runtime/src/composition.rs)
发布已准备好的 scope-local binding，只解析选中 root 及其依赖。配置、安装、异步准备和资源准入仍属于
原 owner；registry 的短同步提交不做 network、activation 或 cleanup。

未改变的实现可复用。`ToolDirectory` 从同一组 declaration 得到 schema 和实际 executor，替换时核对
revision，并冻结一次已受理 model exchange 使用的精确 schema/implementation 集合。
普通替换允许 pin 完成，撤权使后续使用失效。Rust 进程内使用 typed call，不人为多走 JSON RPC。

Varin Host tool service 的同一 manifest `tool` descriptor 用于发现、激活、SDK inspect 和 Host schema
编译。[Extension tool owner](../packages/web/application-host/lib/kernel/extension-tool-owner.ts) 把精确实现
绑定到原 Run/Operation 的权限及资源事实。Host-only invocation scope 只以 opaque token 跨 broker；
扩展不能提交一个 scope object 给自己授予另一调用方的权限。

Result callback 返回 JSON，可追加有序 text/media part；null/empty 是合法数据。
非法 output 或 callback failure 保留已受理 part 和失败回执。长得像图片或 receipt 的 JSON 仍只是数据。
Job declaration 必须声明 thread/environment lifetime，并有可信 domain adapter 持久受理和管理；
扩展 JSON 不能创建执行 owner、宣称停止或改写已受理 receipt。

Dispatch 前因权限/身份拒绝是 `not_dispatched`。Dispatch 后 callback 或 output schema 失败，
除非原 domain 已提供真实 receipt，否则 outcome 为 indeterminate、effect 为 unknown，
不能描述为“没有副作用，可以安全重试”。

嵌套 `call.tools.invoke` 使用原 invocation 冻结的工具目录，每个内层调用仍独立执行权限和资源准入。
Stable call ID 对相同调用去重、拒绝变更后的参数。外层 callback 返回后关闭新嵌套调用，并等待已受理
调用完成；捕获内层错误不会抹掉其 Operation/receipt。独立受理 Job 保留原 lifetime。

Policy、context、retrieval 和 observer service 共用这些 selected owner。Policy 在已提交边界返回
允许的动作，不直接改 core history 或私下执行工具。纯 context/retrieval declaration 选择变换/阶段，
不因此取得文件或模型权限；模型决策由原 inference/Operation owner 执行。
Observer 消费已提交事实，不成为执行进度权威。具体合同与例子见 SDK 和[运行时](runtime.md)。

## 发现接口与 Agent 编写的扩展

Current-contract discovery 读取 installed declaration、routing 和真实 lifecycle，不激活冷 provider。
Accepted-Run tool discovery 读取该 Run 冻结的目录。两者来源不同：当前 catalog 可见不证明旧 Run 能调用。
未声明 method metadata 就是 undeclared，不能伪造空 schema。

显式 source read 指定 selected/candidate artifact integrity 及 package-relative path。
校验后的 UTF-8 分页来自该不可变 artifact，不来自可变 checkout 或任意 Host path，也不为读取而安装
尚未物化的包。Stale slot、unavailable artifact、missing file、invalid range/text 和 corruption 分开返回。
交给 Agent 的源码是普通工具数据，不作为指令执行。

`extension_package` 从原 SourceView 已 capture 的树 stage 包，保留 managed-Host provenance。
首次安装即使不请求 capability 也保持 disabled；后续编辑只 stage candidate，不授予权限或改变 enablement。
编译仅使用 capture 内的依赖/配置闭包，不安装依赖。Apply 指定精确已审查 candidate，
分别报告持久 apply intent、selected artifact 和 actual realm activation。

完整 Host 丢失后，catalog 可能恢复已提交选择，而 Operation 仍为 unknown。
恢复不会重放 Agent effect 或重新 capture 可变来源来制造一张确定回执。

## Pi 兼容与图形适配

Pi PackageManager 与 extension runner 拥有 Pi 安装、settings、resource、command 和 session execution。
Plugin Settings 通过[配置 owner](../packages/pi-host/src/config-text-authority-resolver.ts) 编辑 native revisioned
JSON/JSONC，保留未知字段。专用表单只编辑已理解字段，其余通过 native-document editor 暴露。
Varin UI 不读插件私有数据库，也不将插件状态复制为第二份 Varin store。

Adapter 观察公开注册 command、event 或 versioned contract。Command presence 只证明已加载，
不证明外部 binary/provider 健康。Configured、installed、loaded、unavailable、failed 与成功空结果分开。
Active MCP 的 transport/OAuth 属于 Pi 原生或选中 replacement owner，UI 不合并带凭据来源。
Varin workspace recovery 是独立 Host service，不使用可选 `pi-workspace-history` 的状态替代。

Bundled Pi version 只有 `packages/pi-host/package.json` 一处来源。维护的 adapter test 验证消费合同，
不是永久逐版本兼容认证。可选 `scripts/smoke-extension.mjs` 只证明 entrypoint loading 和公开注册，
不覆盖付费 provider、模型推理、恢复或完整 UI 旅程。

生命周期测试随 Host、loader 和 Surface owner 维护，native consumer test 验证其实际绑定边界。
局部 helper 测试不能代替扩展/provider/UI 的实际集成或平台/打包验收。
公共包发布与默认产品运行时切换仍是单独的发行决定。
