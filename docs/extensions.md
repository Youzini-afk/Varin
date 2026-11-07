# 扩展归属与运行时组合

Varin 扩展通过 manifest、capability client、service 和 contribution 扩展 Application Host 与工作台。
Rust Agent runtime 通过执行绑定消费选中的 Varin service，
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
客户端切换 Host 或工作台不搬迁已安装的扩展目录、asset、grant 或 storage。

普通产品 Shell、editor/renderer、页面、命令和 provider 与外部扩展共用 registry。
Core 保留 bootstrap、认证、合同校验、生命周期和恢复基础。完整自定义 Shell 不必使用 React、
官方组件布局或每个官方 slot，但必须声明它实际承载的组合接口。

## 身份、数据与信任

扩展具有 manifest ID 和版本。安装来源、artifact integrity、selected version、candidate、
desired enablement、已审查 grant，以及每个 realm 的 actual generation 是独立事实。
Installed 不等于 enabled，enabled 不等于 active 或健康。公开目录不暴露安装路径或来源凭据。

Package manager 接受 npm、Git、本地目录和已注册 built-in source，不执行安装 lifecycle script。
插件中心另提供 GitHub Releases、npm registry tarball 和本地发行包的预览交付入口，仍发布到同一 artifact 和 Catalog。
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
Remove 和 delete-data 是两个选择；删除仅限该扩展 namespace，不包括项目文件或其他服务的私有数据库。
读取失败、malformed、missing 与有效空数据始终分开。
`application/profile/workspace/surface/session` 目前是该扩展 namespace 内的分类标签，不会自动按当前项目、用户或
Thread 分区，也不是权限边界。需要区分多个实体时，作者应在 key 中显式使用稳定实体身份；Host 不猜测
一个共享 service 当前代表哪个 Run。

安装、启用或应用候选代码是**代码信任**，不等同于逐项批准 Varin capability。Broker 继承 Host 环境并以
Host OS 账户运行；未申请 capability 的代码仍可能直接访问进程、文件、网络与环境变量。Managed Surface
也在应用页面 realm 中执行。能力撤销约束 Varin API，不能撤回第三方代码已取得的系统访问或已经发生的效果。

## 插件中心与发行交付

设置中的“插件”分为“发现”和“已安装”。服务路由、工作台组合、目录来源与诊断保留在高级管理；
内置能力与外部安装分别展示。内置版本随 Varin 发行管理，不能单独卸载或从作者 Release 更新。
“配置”只打开该插件当前可用的 settings-page contribution，不推断账号业务状态，也不会为显示配置偷偷启用代码。

公开收录资料由 [Varin-plugins](https://github.com/Astrmira/Varin-plugins) 维护。默认目录为该仓库
main 的 `catalog/v1.json`，可在高级管理更换或添加 HTTPS 目录。Host 保存配置及最近有效目录，使用 ETag
重新验证；网络失败或无效替换保留原列表并显示失败原因。发现页只读取目录与同源图标，不批量查询作者发行。
同一目录的 ID 必须唯一；不同目录只在 ID 和规范化发行来源相同的情况下合并来源信息。
市场介绍只有在已安装身份及来源匹配时才可关联，目录修改不改变安装来源或代码。

公开目录和用户安装 Catalog 是两个不同 owner。市场离线、下架或修改作者仓库地址，不妨碍已安装插件运行，
也不会改写保存的更新来源。跨来源替换先显示来源变化，要求明确确认；普通更新仍沿原 candidate 审查、应用和退役流程。

发行交付由 `ExtensionReleaseManager` 解析作者元数据，复用 `ExtensionArtifactStore` 与
`ExtensionPackageManager`。GitHub 来源保存仓库、渠道和可选发行系列；npm 来源直接读取 registry 元数据和
带 integrity 的 tarball，不要求用户安装 npm CLI。归档为标准 gzip tar，使用 `package/` 根目录，拒绝链接和越界路径，
流式下载及摘要核验，不执行 lifecycle script 或插件模块。当前平台、架构和 Varin 兼容范围决定选择。
较新的不兼容、缺资产发行会有明确说明；结构错误的发行清单直接报错，已有安装保持不变。

预览准备不可变 artifact，返回实际 manifest、能力请求、内容摘要、Host 和当时 Catalog revision。
确认仅使用原 preview ID 和核验后的内容，不重新解析 latest；Host 或 Catalog 已变化则重新预览。
同版本不同内容显示警告并成为独立 candidate。首次安装保持禁用，启用仍走代码信任及能力审查，
不以“下载成功”冒充正在运行。更新检查只读元数据、合并并发请求，不下载所有归档或启动插件。
本地上传包只保留文件名来源，后续手动替换，不猜测远端仓库。

所有网络请求复用 Application Host 的 egress/proxy owner。发行包与目录服务不接管原生对话、工具权限、
已受理调用或凭据。桌面、Web 和移动 Surface 使用同一扩展 Host；这里的 Host 与对话执行位置选择不是同一个概念。
插件页面显示实际 Host 身份，预览和迟到响应绑定原目标。`varin://extensions/install` 及 Web 查询入口只传递
公开 npm/GitHub 来源与可选插件 ID，未安装时打开预览而不授权安装。已安装且来源匹配时定位管理，
即使目录已下架也由 Host 的安装记录识别；链接不能指定本地路径或携带访问凭据。

插件通过通用 Host capability 复用现有授权与凭据机制，调用主体从可信 Surface/Run 链路取得，
详见[插件凭据与授权](#插件凭据与授权)。具体业务由插件作者维护，现有模型和 MCP 凭据 owner 保持原语义。

## 模型接入贡献

`varin.models@1` 沿同一 Host service 与 composition 提供渠道类型、候选模型目录、认证方式和协议实现。
单个 provider 可直接解析；多个 provider 通过已有 ordered routing 明确选择。描述校验与准备失败保留上一有效目录，
贡献中的模型只是候选材料，不会自动保存渠道、恢复用户删除的模型或改写用途绑定。

自定义 SSE 协议通过类型化 `serialize` / `parse` 回调处理原始请求和协议帧；模型 HTTP、SSE framing、
凭据派发、Operation、usage 和恢复仍由 Rust 执行。`ModelAdapterRegistry` 固定实际 adapter binding，
不仅比较作者声明的版本；受理准备持有原 composition lease，普通替换不能把旧选择转给新实现。
耐久配置保存 artifact/composition 与 adapter 元数据的内容身份，进程内 pin UUID 不进入续接身份；
相同已核验内容在新进程重建可以重新绑定，不同内容仍不能冒充原选择。
取消只发停止意图，原 broker callback 回应或进程真正退出后才释放其执行寿命。内核断连先取消并等待真实 callback
结束，清除旧 epoch 的产品贡献；新内核 ready 后重新准备，不把旧 binding ID 交给新进程。

扩展 OAuth 需要已审查的 `varin.models.authentication` 权限。Host 只向该身份传递相关 token，
其 call-scoped HTTP client 只能 POST 到该 provider 声明的精确 HTTPS token endpoint，禁止重定向和自动重试。
登录沿用工作台交互，凭据保存、账号身份与合并刷新沿用同一 credential owner；取消等待不取消已发生的 token 轮换保存。
API key 必须有显式 header 映射，协议编解码器不接触秘密。当前跨进程 codec 的执行合同是 chat/SSE，
其它操作必须已有对应的原生协议实现，不能因声明一种能力就假定支持。

作者接口与可运行协议样例见 [SDK](../packages/extension-sdk/README.md) 和
[自定义文本/SSE 协议](../examples/extensions/model-protocol/README.md)。没有新增安装器、动态库加载、
模型请求数据库或自动跨渠道重试。

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

Host 候选迁移在 `storage-publications` 留下原数据/目标数据 journal，持有涉及地址的锁，随后在原 Catalog
选中候选时写入同一 publication ID。进程中断后，启动在激活任何代码前按该 receipt 完成或撤回数据写入；
不会重新执行迁移函数、activate 或工具效果。未知 Catalog 决定或不匹配数据保留证据并拒绝启动，不猜测成功。
显式 remove 在同一发布锁下先消费这些 receipt，再删除安装记录及用户选择的数据，不能在重启时复活数据。
这保证候选数据与 Catalog 的进程崩溃恢复，不宣称任意插件副作用或所有初次激活文件属于同一事务。

普通更新仍允许原 pin 完成，但旧 generation 不能 refresh/open 为另一 schema 的文档，也不能覆盖它。
若原 Run 确实依赖已迁移的 schema，调用会明确失败；不会为让旧代码继续运行而降级数据或改绑新实现。

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

Trusted-native Host 前后代不能安全并行准备。普通“应用更新”不重启 Host；enabled native 候选需要
管理页中明确选择“重启并应用”。Host 先核验不可变候选、已审查权限与固定依赖图，在原 Catalog
记录带稳定 ID 的更新意图和旧选择，再交给实际启动 owner 沿正常停止流程重启。未提供 restart owner
的启动方式明确返回不可用，不把 shutdown 当作重启。

新进程在普通激活前恢复交接，先准备候选，禁止把同一扩展的旧代码先载入。只重建 Runtime 对象不等于
干净进程。具名 Surface group 仍由现有本地 transaction 和已连接 contribution consumer 准备实际挂载；
原 Host preparation、成员 generation 及已验证 consumer lease 数随提交保存在原更新记录中。
lease 数为零只证明模块已准备，不证明界面挂载或 paint。等待 Surface 不阻塞 Host 启动，无关服务继续工作。

交接状态区分待重启、准备中、等待具名 Surface、已应用、失败及恢复旧版本的待重启/已恢复。
提交前失败保留旧 selected artifact，已进入进程的候选不通过 cleanup 假装消失。失败或被中断的交接
不会在下次启动自动重试；用户可明确新建重试，或重启恢复旧版本。每次更新保留原 ID 与结果，成功的
Catalog selection 和 applied 结果一起持久提交。响应丢失及随后清理失败读取原提交事实，不改写成未应用。
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

重启恢复读取原 Run 保存的精确 composition，不重新执行当前 routing。原包、entrypoint、grant 或依赖已变化时，
返回带原因的恢复错误并指出原扩展身份。磁盘上还留有旧 artifact 不代表仍获授权；不能自动重启已禁用扩展、
恢复已撤销 grant、切换当前 provider 或重放未知效果。相同内容及原授权仍可用时才重新准备原绑定。

`prepareService` 返回必须释放的精确 generation handle。独立 `pin()` 保留已受理 exchange；
child 只能从仍被保留的原 binding 派生 pin。撤权沿实际依赖边传播，共享 activation context 不持有
某一个 Run 的调用权限。

## Driver 与策略不是同一个扩展点

`varin.agent.driver@1` 注册真实执行算法，SDK 的 `provideAgentDriver` 给每次 callback 绑定原 Run 能力。
它可以并发模型、交错工具、构造上下文、消费原 Inbox 和等待原事件；不是给 `policy@4` 改名。
内置 Rust driver 仍消费已有 policy/context/tool service；第三方 driver 不被要求模仿默认循环的动作顺序。

选择沿现有 scoped routing，安装不会自动选择；原 Run 的实现、依赖、配置和恢复声明一起冻结。
`runtime.driver` grant 与运行 callback 的原 scope 缺一不可，并不代替每个工具的权限和资源准入。
`describe` 的恢复声明由真实已激活 provider 读取，不从 manifest 猜测能否恢复；`checkpoint` 必须有显式
`resume` 实现与完全相同的私有 schema。普通更换 provider 不会把旧 Run 移交给同名新代码。

作者入口、示例与停止/恢复语义见 [SDK](../packages/extension-sdk/README.md#replaceable-run-drivers)、
[parallel-driver](../examples/extensions/parallel-driver/README.md) 和[运行时](runtime.md#可替换的执行循环)。

## Rust Agent 组合与工具动作

Rust Agent 通过 [CompositionRegistry 及 resolver](../kernel/crates/varin-runtime/src/composition.rs)
发布已准备好的 scope-local binding，只解析选中 root 及其依赖。配置、安装、异步准备和资源准入仍属于
原 owner；registry 的短同步提交不做 network、activation 或 cleanup。

未改变的实现可复用。`ToolDirectory` 从同一组 declaration 得到 schema 和实际 executor，替换时核对
revision，并冻结一次已受理 model exchange 使用的精确 schema/implementation 集合。
普通替换允许 pin 完成，撤权使后续使用失效。Rust 进程内使用 typed call，不人为多走 JSON RPC。

Varin Host tool service 的同一 manifest `tool` descriptor 用于发现、激活、SDK inspect 和 Host schema
编译。[Extension tool owner](../packages/web/application-host/lib/kernel/extension-tool-owner.ts) 把精确实现
绑定到原 Run/Operation 的权限及资源事实。Host-only invocation scope 只以 opaque token 跨 broker；
扩展不能提交一个 scope object 给自己授予另一调用方的权限。

工具的 `requirements` 描述来源与进程依赖。`source` 接受已有来源，`physical` 不接受尚为 FixedBranch 的来源，
`live` 只接受 LiveRoot；没有来源的工具可以独立准备。普通发现将不满足条件的工具标为 unavailable，
显式恢复所需绑定则返回来源错误，不为了发现工具而准备目录。此检查只是可用性投影，不能代替实际调用的资源授权；
具体行为见 [来源准备消费者](../packages/web/application-host/lib/kernel/extension-tool-source.test.ts)。

同一 `tool` 声明可附带 `disclosure`：简短用途、搜索别名、导航分组，以及原参数 schema 中明确分支的阅读路径。
Host 随原 descriptor 固定这些说明和版本，不建立另一张注册表。操作视图保留原共同约束、引用与互斥关系，
不会替换实际执行 schema。未提供披露描述的扩展仍可按原名称、描述和完整契约被发现；导航分组不授予权限。

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

Policy、context 和 observer service 共用这些 selected owner。Policy 在已提交边界返回
允许的动作，不直接改 core history 或私下执行工具。纯 context declaration 选择变换，
不因此取得文件或模型权限；模型决策由原 inference/Operation owner 执行。
Observer 消费已提交事实，不成为执行进度权威。具体合同与例子见 SDK 和[运行时](runtime.md)。

`code_retrieval` 由原生检索 Agent 使用已冻结的模型、工具、来源和上下文执行。旧的 staged retrieval pipeline
已退役，`varin.retrieval.plan@1` 没有该 Agent consumer；SDK 仍保留 deprecated 导出供现有作者兼容，发行版
不再列出无作用的三种检索计划。已有 routing 数据保留为不可用选择，不偷偷删除或改成另一策略。

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

同一版本号的发行内容可能被作者替换。版本检查保持只读元数据，不下载所有包来比较；“当前发行”仍提供
“预览发行内容”入口，由显式预览固定新字节、核验摘要并报告同版本内容变化。GitHub 发行预览附带已解析
具体 tag 的发行说明链接，不将另一个最新版本的说明混入已固定预览。

## 插件凭据与授权

普通插件通过 Host capability `varin.credentials` 使用现有凭据和授权机制，不新增公共账号服务。
[共享凭据 owner](../packages/web/application-host/lib/credentials/service.ts) 从模型凭据实现提取存储、
API Key/OAuth 记录、并发刷新合并和替换保护；模型适配层仍负责模型请求头、端点、渠道与 Run 绑定。
现有模型、搜索、代理和 MCP 凭据文件不会因此迁移或合并。

凭据引用按真实用户、插件与连接隔离。Surface 配置调用从已认证的 service lease 取得用户，Agent 工具
从 Rust Catalog 保存的 Thread/Run 取得用户；调用参数、路由标签和 activation context 都不能指定用户。
密码、passkey 和配对设备沿原认证入口关联持久主体，session 或设备 token 轮换不会创建另一个凭据所有者。
当前 Host 仍使用原单一 owner 登录方式，本次不增加多用户注册或邀请界面。无认证身份的本机调用继续使用
既有非凭据功能，但不能取得插件秘密。不同可信主体的隔离由原调用链与凭据 owner 强制执行。

插件自行保存连接标签、邮箱、服务端点等非秘密配置，并提供自己的设置页面。SDK `credentialNamespace(call.capabilities)`
返回按真实用户和插件隔离的稳定 opaque key，供插件在既有 storage 内组织自己的配置；不暴露跨插件主体 ID。Host service 使用调用级 SDK
`credentials(call.capabilities, connectionId, expectedAccount?)`；`inspect` 返回非秘密绑定身份，`resolve`
只向可信 Host 适配器返回秘密。已选择连接应保存 `account` 并传回 `expectedAccount`，重连后旧选择将被拒绝，
不能把新账号无声用于旧操作。秘密不得返回 Surface、工具结果、模型上下文或日志。原生插件仍是受信代码，
这不是进程账户权限之外的 OS 沙箱。

OAuth 服务商逻辑由同一插件的 `authenticate` Host service 实现。Host 复用 `AuthorizationFlows` 展示授权
地址、设备码、接收回调输入与取消；授权尝试保留实际服务 generation，并绑定原用户、插件和连接。
初始配置请求返回后授权可继续，取消、撤权和 Host 停止会终止等待。凭据替换与刷新均核对原账号身份，
迟到的令牌不能覆盖重连或已删除连接。插件负责 OAuth 应用配置、服务商的 state/PKCE 校验、回调部署、
请求签名及远端撤销；平台不从市场资料推断这些业务。

普通卸载保留插件数据；明确选择删除数据后，原扩展退役流程删除该插件的凭据命名空间。
此操作不代表服务商已撤销 OAuth 授权，远端撤销仍需由插件实现并如实报告。

## 长期入站事件

原 service event 可通过 `durable` 声明可关注来源，普通界面通知仍是短时通知。来源保存稳定的
`sourceId`、连接发现与可取消接收方法、真实推送／长连接／增量拉取能力、恢复覆盖及筛选 schema。
平台沿同一 service 描述提供按需发现，不为每个服务商添加触发枚举。作者合同见
[SDK 长期事件](../packages/extension-sdk/README.md#durable-inbound-event-sources)。

Application Host 按用户、扩展、来源、连接和原凭据账号身份共享后台监听；Bot 休眠不结束账号同步。
连接发现不能修改或解析秘密，接收调用只能读取其明确选择的账号。账号替换、插件停用和撤权取消原监听，
保存原 Catalog 位置和未交付材料；恢复不会把旧关注改投新账号。普通 service generation 发布后，旧接收调用
实际退出并释放 pin，再以原位置启动新实现。关闭页面不影响这些后台引用。

插件提交原事件 ID、修订、发生时间、属性与正文／媒体字节。原文件单独提交
`files: [{ fileId, filename, mimeType, bytesBase64 }]`，支持 PDF、CSV、ZIP 及空文件，不能冒充媒体或引用既有附件。
Host 不接受调用方指定用户身份和任意存储引用。Catalog 用原 ContentStore 接收字节、生成稳定附件身份，
在原事件与游标事务内提交元数据；原 AttachmentDelivery 将文件交给实际目标 Thread，随后沿现有附件 Storage
读取或准备工作文件。文件内容依赖与已交付的持有边共同决定保留期，不随来源页面关闭而消失。
成功回执之后插件才能确认远端推送。响应丢失时从原 checkpoint 恢复，同一事件身份可重试，
不能以接收时间制造新事件，也不能在同一身份下改变原文件内容。`occurredAtMs` 必须是该事件／修订真实发生的
UTC 毫秒时间，补拉时保持原值；“丢弃积压并从现在继续”用它判断边界。来源无法提供真实时间时必须披露限制，
不能捏造同步时刻。监听故障与实际覆盖范围保存在原来源状态，
不把连接配置存在当成实时健康。

仅完整、可由后续快照覆盖的状态通知使用 `state: { key, sequence, value }`：key 区分同一来源对象的状态流，
sequence 是来源提供的递增非负安全整数，value 是可读的当前状态。补拉保留原序号；该声明参与事件身份的重复内容校验，
不能重试时再改。平台在尚未消费的批次中展示最新正文和状态变化过程，仍保存原事件和附件。
一条通知中的独立评论、请求或必须逐项处理的事实，应作为普通事件提交，不能宣称整个正文可被覆盖。
多个关注命中相同事件时共享正文，处理意图、筛选范围、目标和回执保持各自归属；插件无需自行复制材料。

跨 Host 关注使用已有受管连接及其实际 Host 身份。`source.connectionId` 是来源 Host 的插件账号连接，
`source.host.connectionId` 是接收 Host 保存的受管连接；用户身份由来源 Host 的认证客户端决定，不能通过 JSON
选取别人的账号。来源 Catalog 为每个认证消费者保留原账本水位和未确认材料，接收 Host 先提交自身 Catalog，
再确认来源页；断线、重启和确认响应丢失沿原消费者与稳定事件身份恢复。暂停保留水位，取消最后关注后释放
远端消费者；消费者代次阻止旧确认或释放影响新订阅。后台共享监听按实际用户与账号隔离，不与 Bot 运行寿命绑定。

传输只使用已配置的受管 HTTP／SSH 连接，不开放匿名事件转发，也不自动部署公网中转。首次远端绑定只覆盖
实际建立消费者之后的窗口，界面显示该起点，不能把新绑定前的离线区间宣称为完整覆盖。
原文件经原账本页还原字节，接收端重新准入自己的附件身份，不跨 Host 信任附件地址。
回显关联保留原执行 Host 身份；只有接收 Host 自己的关联才由原 occurrence、成功操作回执及来源对象再次核验，
另一个 Host 的同名 operation 不构成本地抑制证据。

服务商回调认证、远端订阅与注销由适配器完成；声明 push 不创建公网入口或自动部署中转。
无需公网入口的来源可使用其真实 poll／stream 能力。本合同不包含具体邮件或 GitHub 接收适配器，
也不把插件缓存当作事件已完成的权威。

## 验证边界

生命周期测试随 Host、loader 和 Surface owner 维护，native consumer test 验证实际绑定边界。
局部 helper 测试不能代替扩展、provider、UI 的实际集成或平台、打包验收。公共包发布仍是独立发行操作。
