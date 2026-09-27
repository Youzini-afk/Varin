# 决策分卷：运行时可靠性与多项目工作区

范围：RR 专项（聊天断连追赶、可靠停止、Agent 工作上下文、shell 边界、多项目检索、出站联网、跨层故障注入）的决策。

本卷是 [agent-harness-decisions.md](../agent-harness-decisions.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-328 · 2026-09-26 · RR1
类型：问题与解法
决定：断连恢复改为"传输层自动重连 + 只读权威重同步"。`PiRuntimeClient` 上报 `onConnectionLost`；UI 连接监督器按退避（500ms 起、15s 封顶、jitter）重建连接，成功后广播 reconnected；store 对每个已打开会话执行 `session.snapshot` + 已加载 scope 的 `session.entries` + `session.stats` 重读。`session.snapshot` 响应携带 `eventWatermark`（HostController 序列在读取时刻的值）、`liveAssistant`（`agent.state.streamingMessage` 投影）和 `pendingToolCallIds`。重同步期间会话事件缓冲，回放时丢弃水位内同 worker 旧事件，水位外与新 worker 事件正常应用。序号缺口触发同一重同步。
原因：`PiRuntimeClient` 是单次连接——关闭后清 listeners/序列状态、下次请求才懒重连，断线期间事件全部丢失。只重连不补读会造成 UI 永远停在断开时刻（E11）。快照水位是 HostController 与 SessionHost 同线程这一事实提供的免费一致性切点：不需要锁、不需要事件回放日志。
考虑过的替代：事件持久化回放（需要 Host 侧事件日志与游标协议，成本高且引入新的持久化面）；全量 session.entries 无水位重读再逐条 reconcile（能工作但无法判断在飞 liveAssistant/tool 状态，仍可能把旧 UI 态当新事实）；沿用 seq 比对但要求 Host 单调重发（重复 entry 会引发 UI 重复项，而去重键本身依赖 entry id，成本接近水位）。
影响：`protocol` 的 `SessionSnapshot` 增 `eventWatermark`/`liveAssistant`/`pendingToolCallIds`（均为可选，旧 host 省略则客户端按无水位回放）；`runtime-client` 增 `onConnectionLost`/`PiRuntimeRequestTimeoutError`/`RuntimeSequenceGap` 导出；`pi-host` `session.snapshot` 铸水位并投影在飞消息/工具调用；`ui` 连接监督器与 store 缓冲/水位逻辑。RR6 需补真实桌面断网纵切。
状态：已实施

### D-329 · 2026-09-26 · RR1
类型：问题与解法
决定：重写 `3044800b` 的停止语义。停止请求生命周期显式为 `requested`（本地已冻结渲染并发出 RPC）→ `accepted`（host 返回 `aborted:true`）→ settled（`agent_settled`/空闲快照/`session.closed`/`worker.exited`/`reset` 任一权威终态清除标记）。`agent.abort` 的 AbortError/`PiRuntimeAmbiguousRequestError`/`PiRuntimeRequestTimeoutError` 归为 `unknown`——只证明应答没到，不证明远端拒绝了停止——此时触发权威重同步并返回 `false`，不展示为成功取消。视觉冻结用 `stoppedAssistant` 快照实现：渲染层读取冻结副本，底层 `liveAssistant` 仍按真实事件更新，迟到的 provider chunk 保留在状态中而不在视图中续流；终态到达后视图回切到权威内容。非传输类错误照常上报 `commitError`。
原因：`3044800b` 把 `manuallyAbortingSessionIds` 当永久过滤器，既把 abort 应答的 AbortError 当成功，又让集合在 `reset()` 后存活到下一 Run（E12）。这掩盖了真实错误（远端拒绝停止/传输失败），且丢失的 stop 回执被计为成功。
考虑过的替代：保留事件屏蔽但改在 settle 后清理（仍丢真实 chunk，且 settled 未到就永远不一致）；乐观地把 AbortError 当成功（计划明确禁止）；冻结渲染但不记 `stopState`（无法区分"正在停"与"停成功/未知"）。
影响：`usePiSessionStore` 停止请求 Map/冻结视图/清算路径；`PiChatView` 以 `stoppedAssistant ?? liveAssistant` 渲染；`agent.abort` 加 10s 超时以产出 typed timeout；reset/closed/exited/agent_start 均清算。真实远端拒绝（`aborted:false`）立即解除冻结。
状态：已实施

### D-330 · 2026-09-26 · RR2
类型：问题与解法
决定：会话工作上下文由 Host 独占持有——`HarnessWorkContextState { operationDir, queryScope, revision }` 挂在注册会话条目上，经 `context.get/select/scope/reset/discover` 服务暴露给 `work_context` Agent 工具；所有变更先过 `path-authority`（含 `workspaceScope` 检查）再落 CAS 递增。路径合同分层而不是全局统一：Host 桥接参数保持工作区相对形式（path-authority 以 `actor.operationDir` 为解析基准），Pi 本地磁盘边界（native find/ls/read 回退、write/edit 日志、apply_patch 落盘）经 `WorkContextMirror.operationDirAbs` 锚定绝对路径；资源调度计划同样以镜像锚定。上下文同步走 piggyback：每个 `harness.respond` 附带 `workContextRevision`，失配时 `WorkContextSync` 恰好发一次 `context.get`（`#hostRevision` 去重，显式读用 `force`），不进入刷新循环。shell 监督器新增声明式 `anchorCwd`，select/reset 即更新 spawn 锚点，运行中的 shell cwd 不被回改。
原因：RR2 需要 Agent 在授权大工作区内自主发现/切换子项目且所有工具路径一致。初版实现把工具参数统一改绝对路径，破坏了 Host 服务契约（`document.*`、diagnostics、surface 读都以工作区相对路径为入参）——绝对路径会被二次拼接。正确边界是"同一授权链、两种表示"：Host 侧相对解析（含 scope 授权），本地侧绝对锚定，调度身份取规范化绝对形式。
考虑过的替代：全局绝对化（已实证破坏 Host 契约并造成双重前缀）；把 opDir 换算下放给每个工具（重复且易漏，`bash` 的 cwd 之类容易被绕开）；Host 主动推送 context（现有通道是 request/respond，piggyback 已够用且不新增往返）。
影响：`protocol` 增 `HarnessWorkContextState`、context.* 服务、`HarnessActorContext.operationDir/contextRevision`、`SessionSnapshot.workContext`、`respond` piggyback；`app-host` 新增 work-context 模块并把 opDir 接进 path-authority 解析基准与 shell.exec 授权 cwd；`pi-host` 新增镜像/同步/work_context 工具，本地边界统一锚定；UI 会话头部显示当前操作目录。限制：RR4 才消费 queryScope 做检索裁剪；当前 select 不级联删除进行中的 shell 会话 cwd（仅影响新 spawn）。
状态：已实施

### D-331 · 2026-09-26 · RR3
类型：问题与解法
决定：用户命令与监督控制帧彻底分离。POSIX 包装改为 `echo B; eval $<ANSI-C 引用载荷>; __ec=$?; echo C:$PWD; echo E:$__ec`——命令文本以 `$'…'` 转义为单个词元经 `eval` 求值（载荷自带结尾换行，无尾换行 heredoc/尾注释/未闭合结构只影响载荷内部）；PowerShell 改为 base64 载荷 + `Invoke-Expression`。请求 cwd 折叠进同一帧：`cd -- <dir> && { echo B; eval …; }; __ec=$?; echo C/E`，cd 失败不在旧目录执行且 epilogue 报 cd 退出码。受理记账：以 toolCallId 为键的 `acceptedExecutions` 记录承诺与结果——同 id 重入返回同一承诺；`shell.read` 对未结算 id 返回实时缓冲（running 而非 not found），spawn-failed 返回 `spawnFailed` 原因，`executionId`（生命周期事件/工具 details 携带的执行身份）同样可读回真实输出。分段计时 `acceptedAt/sentAt/firstOutputAt/endedAt` 贯穿 pending→background→completed 并进生命周期事件。`waitMs` 用 `shellChangeWaiters` 按字节变化预算等待。
原因：旧 `{ <cmd>; }` 内插把任意命令文本放进控制语法——无尾换行 heredoc 会把 epilogue sentinel 吸进载荷、尾注释吃掉同一段落、语法错误留下未决 `{`；kill 后 cwd 污染（已修）之外还有"accepted 但未完成"的黑洞：`shell.read(toolCallId)` 报 not found，输出引用无法按原样取回（E02/E04）。
考虑过的替代：给包装加 delimiter/转义修补（仍把任意文本混入控制语法，解析边界永远证明不完）；heredoc 传输载荷（stdin 通道与命令 stdin 竞争，且 powershell 无对应机制）；用 pty 的 process exit 做完成检测（前台共享 shell 的 exit 会杀掉整个会话，背景化依赖 sentinel 才能完成——现状的 E sentinel 契约保留）。
影响：`shell-supervisor.ts` 包装/记账/计时/read 路径；`harness.ts` 增 `ShellExecTiming` 与 `ShellReadResult.spawnFailed`；`output-tools.ts` 呈现 spawn-failed/recovered id。语法错误命令的退出码现在反映载荷真实退出（eval 语义），不再被外层 `;` 吞掉。限制：`exit`/`exec` 仍经 pty exit 事件路径回收（行为未变）；PowerShell 路径只在单测构造验证，未实机跑——RR6。
状态：已实施

### D-332 · 2026-09-26 · RR4
类型：问题与解法
决定：检索范围沿授权链三段收敛——显式 `path`/`paths[]` 先经 router 授权并以其 workspace-relative `resourceId` 为准（顺带修正了 opDir 下相对 path 被当工作区根相对前缀的失配），无显式路径时用会话 `queryScope`，再退化到 `operationDir` 默认锚，最终与 `workspaceScope` 相交；前缀相交发生在 backendLimit/candidateBudget/top-k 之前，多项目查询不会先全工作区截断再过滤。`search.content` 接受 `paths[]` 表达单次多项目召回。E05：`searchedFiles` 改为可选并把 kernel `KernelComputeResult.scannedFiles` 贯通到结果（内容搜索与 fixed-branch 快照两条路径），未知即缺席；grep 零命中改为 "no matches in the requested scope"。E08：`lsp.diagnostics`/`diagnosticsSnapshot` 的 provider 调用改用授权的 `resourceId`，绝对路径与 opDir 相对路径归一为内部资源 id。E07：新增 `threadRegistry.resolveSessionOwner`——活跃绑定优先，Run settle/Host 重启后回退到 catalog Run 记录（sessionId 持久留在目录里），todo/knowledge 的 owning workspace 不再依赖内存 sessionSnapshots 兜底。
原因：大工作区下默认全根检索会淹没目标项目候选（E01/E09 的检索面）；grep 把命中文件数冒充扫描文件数（E05）；diagnostics provider 以 workspace-relative resourceId 键控，绝对路径造成错位（E08）；`getSessionBinding` 只回答活跃 Run，settle 即抛 stale-binding，无快照的子会话/重启后的 todo 退化为 "No knowledge store"（E07）。
考虑过的替代：为检索另起项目子索引（违反"共享存储、项目是查询视图"的方向）；给 grep 结果估算扫描数（伪数字是 E05 根因本身）；todo owner 任意 fallback 到当前 UI 工作区（计划明确禁止）或新建空 plan（伪装恢复）。
影响：`protocol` 增 `HarnessActorContext.queryScope`、`SearchContentParams.paths`、`searchedFiles` 可选化；`router` 授权 `paths[]`；`search-service`/`content`/`working-branch-query` 贯通真实 scannedFiles 并收敛 scope；`explore`/`related` 默认范围收敛；`diagnostics-service` 归一 resourceId；`thread-registry` 增 `resolveSessionOwner`；`index.ts` owner 解析换用；`grep-tool` 支持 `paths` 并改零命中文案。边界：向量/关系索引的覆盖状态沿用 related 既有分态（unavailable/failed/stale），更深覆盖度量未新增。
状态：已实施

### D-333 · 2026-09-26 · RR5
类型：问题与解法
决定：出站网络收敛到单个 Host 权威 `lib/harness/egress.ts`。策略分 `auto`（默认，读 HTTP(S)_PROXY/ALL_PROXY/NO_PROXY 及小写）、`direct`、显式 proxy 三档；每次请求独立 `resolvePolicy` 冻结 version，env 变更只影响下一请求。非法代理（坏 URL、非 http/https 方案如 socks5）记入 `policy.invalid`，请求以 `proxy-config-invalid` 失败，绝不静默降级直连。NO_PROXY 实现 `*`、域名后缀、`host:port`、IPv6 括号形式。SSRF 从 `checkSsrf` 的先查后连改为连接路径强制：直连走 `Agent` + `secureLookup`（undici connect.lookup），对实际将拨号的地址分级——private（含 IPv4-mapped/NAT64 `64:ff9b::/96`/6to4 `2002::/16` 的内嵌 v4 递归分级、IPv6 括号与 zone-id 归一）与 special-purpose（198.18.0.0/15 fake-IP、240/4、ff00::/8）一律拒绝；hostname 静态层仍预检字面值与 localhost/.local。代理模式走 undici `ProxyAgent` CONNECT，端点允许 loopback/LAN（本地代理正是用例），目标 DNS 在代理侧完成——诊断如实标 `proxy-side` 而非假装本地解析证明可达。错误契约：`dns`/`scheme-denied`/`private-network`/`special-purpose`/`proxy-unavailable`/`proxy-auth`/`proxy-config-invalid`/`tls`/`connect`/`http`/`timeout`/`cancelled`/`unknown`，`FetchResult.failed` 增 `errorClass`，`blocked.reason` 增 `special-purpose`；webfetch 工具输出分型与提示。`web.fetch`、`web.search` 全部 provider（注入式 fetch 原接口不变）、`research.search` 共用 runtime；fetch 缓存键并入 `mode|proxyOrigin` 指纹。新增 `network.diagnose` 服务（read.web 能力）与 Pi `network_diag` 工具——只读报告策略/决策/解析归属，不执行请求、不改系统设置。
原因：体检报告的 fake-IP 根因链——Node 裸 `fetch` 不走代理，fake-ip 域名的 198.18.x.x 本地直连必超时；原 `checkSsrf` 先查后连存在 TOCTOU，且 DNS 失败被标成 private-network 误导排查；各出站消费方（web.fetch/web.search/research.search）各自为政。
考虑过的替代：整段放行保留地址（明确禁止，安全旁路）；让用户关代理（非产品行为）；在 `checkSsrf` 保留 DNS 预检（查的与连的不是同一地址，DNS rebinding 可绕）；要求 Electron 系统代理接管（Node 进程内 fetch 不可见系统代理）。
影响：`packages/web` 增 `undici@7.29.1` 依赖；`egress.ts`/`ssrf-policy.ts`/`web-fetch.ts`/`index.ts`；protocol 增 `FetchErrorClass`、`NetworkDiagnoseParams/Result`、`network.diagnose` 方法；pi-host 增 `network_diag` 工具并渲染 `errorClass`。边界：SOCKS 代理明确拒绝为 unsupported scheme（如实报告而非悄悄直连）；Electron 渲染层/系统代理不在此范围；真实 fake-IP 环境纵切留给 RR6。
状态：已实施

### D-334 · 2026-09-26 · RR6
类型：验证与收口
决定：跨层故障注入按"能真则真"补齐——`gateway.test.ts` 新增用例用真 `ws` 服务器、`WebSocketRuntimeTransport` 与 `PiRuntimeClient` 建立真实握手，在 `session.list` 在飞时 `socket.terminate()` 拔掉线缆：pending 请求必须落到 `PiRuntimeAmbiguousRequestError`（响应可能丢失，不冒充成功也非干净失败）、`onConnectionLost` 必须触发、死 client 拒绝后续请求、同一网关上的新 client 立即恢复——这正是 UI 监督器驱动的重连+权威重同步路径在真实传输层的可行性证据。打包安装、Electron env 代理、真实 fake-IP 链路、远端 CI 与付费环境在当前机器无验证手段，status 中逐项标为未测而非笼统全绿。
原因：RR1–RR5 各层已分别有 FakeRuntime/真 shell/真 CONNECT stub/真 kernel 的层级证据，但"传输断→client 感知→重连可用"缺一个真实线缆上的联合验收用例；同时计划要求未测边界明确记录。
考虑过的替代：搭全 Host+Pi+UI 的端到端断线编排（投入远超剩余预算且与既有层级证据重复大半）；把 MemoryTransport 断开用例当跨层证据（不含真实 socket 语义）。
影响：`packages/web` devDep 增 `@varin/runtime-client`（workspace）；`gateway.test.ts` 增 1 个真 socket 用例（7/7 绿）；status RR6 行与 plan Status 头更新为已实施+未测边界。
状态：已实施

### D-335 · 2026-09-26 · RR1–RR6 验收复核
类型：验收纠正与解法
决定：先前的“wired”记录只证明各层曾接线，不能作为 RR 合同全部完成的证据。断线追赶改由 Pi worker 在单次 `session.reconcile` 中读取快照、所需 entries 和 stats，携带实际 worker 身份与水位；UI 的同步任务按操作身份和 Store 代际提交。停止请求绑定具体 Run/活动身份，迟到回执不能修改下一轮。工作上下文的持久来源改为 Pi 当前分支的 custom entry，Host 只缓存经授权重新验证的投影；变更按 leaf 与 revision 提交，重开和分支导航重新读取。Shell 在受理时固定默认目录和可查询执行身份，准备期计入 `waitMs`；检索默认范围、来源详情和网络目标检查依实际消费者复核。未闭环合同继续记在 status，不把未验证的平台纵切或代理侧最终地址检查写成已通过。
原因：复核直接复现了旧停止回执污染新 Run、分离读取的追赶竞态、Host 内存上下文在重开后丢失、已受理 shell 使用新目录、IPv6 等价地址漏拦和代理重定向绕过。原 D-328–D-334 的实施描述仍是历史事实，其中关于一致性切点、Host 独占上下文和 RR6 纵切充分性的推断已被本次证据修正。
影响：`session.reconcile`、StopRequest/活动 ID、Pi 分支工作上下文 journal、shell `preparing`/默认 anchor、检索范围与摘要、egress 地址和重定向检查均有定向回归；最终验收仍取决于 [status RR 复核记录](../agent-harness-status.md) 所列子 Agent 继承、项目发现续查、链接替换边界、可信代理出口与平台 smoke。
状态：已修补并完成定向验证；RR 整体尚未验收完成，修补仍在工作树。

### D-336 · 2026-09-26 · RR2/RR5 后续四项收口
类型：问题与解法
决定：子 Agent 在 `thread.dispatch` 受理时冻结父分支的操作目录、检索范围和授权根，随 Thread manifest 持久化；创建子会话前按实际物化来源与子授权范围映射，成功后写入子 Pi journal，父子随后独立切换。项目发现改为授权起点与签名续页游标，每页重检授权，预算到期返回可继续状态，读失败目录单列而不冒充扫描完成。出站网络的 `auto` 环境代理不获得代理侧最终目标的默认信任；执行 Host 的显式代理设置可由部署者明确委托代理侧最终地址策略，认证秘密绑定代理端点身份并独立存储，诊断区分本地检查与代理侧未验证。`document.readSource` 的磁盘结果改为 Host 从授权 canonical target 打开的句柄读取的字节；Pi `read` 与 `apply_patch` 复用该字节，不再按原请求路径二次读取。
原因：原实现分别缺少子任务派发时的上下文冻结、项目发现的截断续查、代理远端 DNS 的可信策略配置，以及路径授权到 Pi 本地打开之间的身份连续性。这些缺口不能由已有单层 helper 或原 RR6 socket 测试证明完成。
影响：协议增加发现续页/不可读目录、磁盘字节结果和代理策略分型；Host/Pi/Thread/设置页及直接消费者接线并补行为测试。隔离子目录映射不成立时明确失败；代理侧最终地址由明确配置的可信出口承担，Host 不声称本地已验证；Node 目录句柄能力的对抗性 ABA 边界与真实安装包/外部代理验证留在 status。
状态：代码接线与定向行为已验证；平台纵切仍待验证。

### D-337 · 2026-09-27 · HR：任务、资源与持续检索
类型：设计调整
决定：工作区回到会话分类与项目资源组织；Session/Thread/Run 数据归属独立于物理目录。文件工具按本次目标解析资源，命令按明确 cwd 执行，移除可变会话操作目录及持久 queryScope 的同步机制。检索直接接受多位置资源，索引按资源、内容版本和实际解析/模型配置复用，冷目录可直接查询。完整合同及 HR0–HR5 见 [面向任务与资源的 Harness](../resource-oriented-harness-design.md)。
原因：继续修补目录同步会把聊天激活、文件身份、存储归属、shell 和检索初始化绑在一起；跨项目、下载文件、办公材料等日常使用需要直接操作明确资源。索引依赖 workspace 是当前装配方式，并非检索所需的条件。
考虑过的替代：继续加固 WorkContextMirror 与目录恢复（保留根本耦合）；接受绝对路径后自动创建临时 workspace（把旧前置隐藏起来）；默认全盘建库（增加冷启动和后台成本，不能解决实际任务范围）；所有查询都走直接扫描（丢失已有索引和结构/语义能力的复用价值）。
影响：替代 D-330 及 D-332 的目录上下文和归属目标，并调整 D-335/D-336 的相关延伸机制；保留恢复、取消、执行输出、文件修订、来源视图和已有检索算法。涉及现有 Pi/Host/Rust、Documents、任务与材料存储、索引及 UI 消费者，不另建权限产品或平行 runtime。索引可重建，原始内容和未交付成果必须保全。
状态：方向确认，设计文档完成；HR0–HR5 全部尚未实施。
