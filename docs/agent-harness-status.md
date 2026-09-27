# Agent harness 能力状态矩阵

Status: living document maintained by the executing agent; the only authority on what is delivered

Last updated: 2026-09-27

这是 [agent-harness.md](agent-harness.md) 所述能力的**交付状态**，四级定义见
[agent-harness-plan.md](agent-harness-plan.md) 0.1（D-038，经 D-078 修订）：

| 级别 | 含义 |
| --- | --- |
| `implemented` | 模块存在且单测通过；没有进入任何真实调用链（休眠） |
| `wired` | 进入真实生产调用链（host 或 pi-host 在真实会话里会走到它） |
| `proven` | 有 E2E、崩溃 / 故障注入或真实平台 smoke 的证据；证据必须链接到具体文件 |
| `default-on` | 代码对普通用户默认启用；正式能力完成生产接线与相关正确性验证后在同一交付中启用，不再要求独立回放或测试者批准（D-078） |

规则：proven 才算已验证的可用路径，证据列给具体文件；Blocker 写实际未完成行为/特定环境问题，不把优化或缺独立评测当通用阻塞。
Default-on 列只记当前代码，尚未完成的正式目标单独列为待实施。
[roadmap.md](roadmap.md) 只引用本文件，不再自述测试数。

**D-337 / 阶段 HR：面向任务与资源的 Harness（2026-09-27，方向确认 / 设计文档完成 / 全部尚未实施）。**

[工作区解耦与持续检索设计](resource-oriented-harness-design.md) 定义 HR0–HR5：资源与数据归属、会话与操作、直接检索、
持续索引、产品与旧机制收口、真实使用验收。工作区回到会话/项目组织职责，执行与查询使用明确的本次目标；
索引按资源及内容版本复用，冷目录可直接搜索。当前代码仍使用 RR2 工作上下文与 workspace 索引，不把设计标为 wired。
下文 RR2/RR4 的目录模型记录保留为历史实现事实，其后续目标由 D-337 替代；恢复、输出和其他既有正确性成果继续保留。

**运行时可靠性专项 RR（2026-09-26：RR0–RR5 的代码路径与定向行为已复核；RR6 的真实安装包/外部代理平台纵切仍待验证）。**

实施合同和 E01–E12 证据台账见 [Agent 运行时可靠性与多项目工作区计划](agent-runtime-reliability-plan.md)。
RR0 完成源码级故障分层（E01 路径权限、E11 断连丢事件、E12 `3044800b` 停止语义），建立版本基线（host 0.9.19 / Node 24.18 / Varin 1.3.14）。
执行者在下表记录生产接线、行为证据、提交及明确未测项；不通过增加单测数量自动提升状态。

| 阶段 | 待交付内容 | 当前事实 / 验证 |
| --- | --- | --- |
| RR0 | 隔离夹具、故障分层及必要诊断 | 完成：E01/E11/E12 根因定位到源码；确认 `HostController.#sequence` 与 `session.agent.state` 可提供一致性切点（`eventWatermark`+`liveAssistant`+`pendingToolCallIds`）；多项目临时夹具随 RR2 测试就地创建 |
| RR1 | 聊天自动追赶、可靠停止与权威状态收敛 | 已实施并接线（wired）：传输丢失后 `getPiRuntimeConnection` 按退避自动重建连接并触发只读权威重同步（catalog + `session.snapshot` + 已加载 `session.entries` + `session.stats`）；`session.snapshot` 响应携带 `eventWatermark`/`liveAssistant`/`pendingToolCallIds`，重同步期间会话事件缓冲、回放时丢弃水位内旧事件；序号缺口同样进入重同步。停止语义重写：本地立即可视冻结（`stoppedAssistant`），`stopState` 区分 `requested`/`accepted`/`unknown`；AbortError/`PiRuntimeAmbiguousRequestError`/`PiRuntimeRequestTimeoutError` 不再冒充成功取消，转而触发权威重同步；`agent_start`/`agent_settled`/空闲快照/`session.closed`/`worker.exited`/`reset` 均清算停止态，下一 Run 不受影响。验证：`usePiSessionStore.test.ts` 54/54（含水位丢弃、重连补齐、lost-reply unknown→settle、跨 Run 不泄漏）；runtime-client 9/9（新增 onConnectionLost 与 typed timeout）；pi-host typecheck + 聚焦测试 11/11；runtime-broker 86/86 真 worker 纵切；ui typecheck + eslint。未测：真实桌面安装包断网纵切、长流式中的实际恢复延迟——列入 RR6 |
| RR2 | Agent 自主操作上下文、统一路径及并发修订 | 已实施并接线（wired）：Host 端每会话 `HarnessWorkContextState`（operationDir 相对授权根 + queryScope + CAS revision），`context.get/select/scope/reset/discover` 五个服务经既有授权链校验；`work_context` Agent 工具直达该状态，select/reset 同步刷新 shell 锚点。路径合同分层：Host 桥接参数保持工作区相对形式（path-authority 以 `actor.operationDir` 为基准解析并做 workspaceScope 检查）；Pi 本地落盘边界（native find/ls/read 回退、write/edit 日志、apply_patch 磁盘写入）经 `WorkContextMirror` 锚定绝对路径；`harness.respond` piggyback `workContextRevision`，失配时恰好一次权威 `context.get` 收敛，不循环。会话快照携带 workContext，UI 显示当前操作目录。验证：pi-host 492/493（1 skip，kernel 版本环境问题无关）；app-host harness 套件 1161/1162（1 skip）；work-context 双侧新测试 12/12；path-authority/shell-supervisor 回归绿；protocol 69/69；ui 218/218 + typecheck + i18n parity。未测：真实打包桌面端跨项目选择纵切——列入 RR6 |
| RR3 | shell 命令边界、输出恢复、waitMs 预算 | 已实施并接线（wired）：POSIX 命令改为 `eval $'…'` ANSI-C 载荷（PowerShell 为 base64 `Invoke-Expression`），控制帧与载荷分离——无尾换行 heredoc、尾行注释、复杂引号与语法错误不再污染 epilogue；请求 cwd 折叠进同一帧并以 `cd … && { }` 门控，cd 失败不在旧目录执行载荷且回报 cd 自身退出码。`acceptedExecutions` 以 toolCallId 记账：同一 toolCallId 重入返回同一承诺；`shell.read` 对 accepted-but-pending 返回实时缓冲（running）、spawn-failed 返回 `spawnFailed` 原因、`executionId`（生命周期事件里的执行身份）也可读回真实输出；`get_output` 呈现 spawn-failed 与 recovered `sh_N`。分段计时 `acceptedAt`/`sentAt`/`firstOutputAt`/`endedAt` 记入 `ShellExecResult` 与 completed 生命周期事件；`waitMs` 经 `shellChangeWaiters` 按字节预算等待，缺 id 与在跑背景不再混淆。验证：shell-supervisor 45/45（新增 RR3 帧格式/恢复/计时用例）；harness-e2e 7/7 真 shell——无尾换行 heredoc 终止、语法错误后下条命令正常、尾注释隔离、toolCallId 重读真实输出与退出码、`read` 阻塞后经 write_to_process 送 stdin 得真实回显；web harness 109 文件 1165/1166；pi-host/app-host/protocol typecheck + eslint。未测：真实桌面打包会话的 kill/恢复纵切、PowerShell 5.1 实机 base64 路径——列入 RR6 |
| RR4 | 多项目检索范围、索引覆盖、todo 与工具反馈 | 已实施并接线（wired）：检索范围三段式——显式 `path`/`paths[]`（router 逐条授权，authorizedPaths 的 workspace-relative resourceId 为准）→ 会话 `queryScope` → `operationDir` 默认锚，最后与 `workspaceScope` 相交；`search.content` 新增多根 `paths[]`，explore/related 默认范围同样收敛到 queryScope/opDir。范围在候选预算与 top-k 之前应用（前缀 intersect 先于 backendLimit/candidateBudget）。E05 修正：`searchedFiles` 改可选并贯通 kernel `KernelComputeResult.scannedFiles` 真实计数（内容搜索与工作分支快照两条路径），未知时字段缺席不再伪造 0；grep 零命中文案改为 `0 hits — no matches in the requested scope`。E08 修正：`lsp.diagnostics`/`diagnosticsSnapshot` 的 provider 调用统一用授权的 `resourceId`（绝对路径与 opDir 相对路径都归一）。E07 修正：新增 `threadRegistry.resolveSessionOwner`——活跃绑定优先，Run settle/Host 重启后仍从 catalog Run 记录解析 owning workspace（不再只剩内存 sessionSnapshots 兜底），todo/knowledge owner 解析改用之。验证：web harness+search+kernel 112 文件 1185/1186；search-service 33/33（新增 5 个 RR4 scope/覆盖用例：默认 opDir、queryScope、多 paths 联合、workspaceScope 相交、真实扫描数透传与缺席）；thread-registry 45/45（settle+重启后 owner 仍可解析）；pi-host 493/494（1 skip）；e2e 7/7 真 shell；protocol/app-host/pi-host typecheck+eslint。未测：真实打包环境大工作区检索规模、向量/关系覆盖度的实测差异呈现——列入 RR6 |
| RR5 | Host 出站配置、代理兼容与 SSRF 错误分型 | 已实施并接线（wired）：新增 `lib/harness/egress.ts` 统一出站权威——策略 `auto`(HTTP(S)_PROXY/ALL_PROXY/NO_PROXY，含小写）/`direct`/显式 proxy，每请求冻结独立 `version`；非法代理配置记入 `invalid` 并以 `proxy-config-invalid` 拒绝而非静默直连；`NO_PROXY` 支持 `*`/后缀/`host:port`。SSRF 从"先查后连"改为连接路径强制：`secureLookup` 在 undici connect.lookup 内对实际将拨号的地址分级，私网与特殊用途(198.18.0.0/15 fake-IP、240/4、ff00::/8、IPv4-mapped/NAT64/6to4 内嵌 v4 递归分级）一律拒绝；IPv6 括号/zone-id 归一修复 `[::1]` 旁路；DNS 失败分型 `dns` 不再冒充 private-network。代理模式走 `ProxyAgent` CONNECT（真实 stub 验证 `CONNECT target:443`），端点凭据做 Basic token 且永不进错误/日志；CONNECT 407→`proxy-auth`、拨号失败→`proxy-unavailable`、TLS 证书码→`tls`、20s 哨兵→`timeout` 与取消区分；HTTP 层错误带 `errorClass:"http"`(407→`proxy-auth`)。`web.fetch`/`web.search`(全部 provider 注入式 fetch)/`research.search` 共用该 runtime；缓存键含 `mode|proxyOrigin` 指纹防串路复用。新增 `network.diagnose` 服务（read.web 能力、无需路径授权）与 Pi `network_diag` 只读工具：报告策略、代理是否生效、目标在本地还是 proxy-side 解析及地址分级，不发请求、不改系统设置。验证：egress.test.ts 20/20（真 CONNECT stub、假 DNS 注入分类、env 矩阵、407/unreachable/bypass）；web-fetch 28/28；harness+search 112 文件 1202/1203；pi-host 493/494；三端 typecheck + eslint。未测：真实 Clash/v2ray fake-IP 环境的端到端放行、Electron 打包内 env 可见性、TLS 实链失败分型（仅错误码映射）——列入 RR6 |
| RR6 | 跨层故障注入、真实平台 smoke 与收口 | 部分闭环：跨层故障注入在真实 socket 上通过——`gateway.test.ts` 新用例以真 `ws` 服务器 + 真 `WebSocketRuntimeTransport`/`PiRuntimeClient` 跑 handshake 与 `session.list`，在请求在飞时 `socket.terminate()` 杀线：pending 请求以 `PiRuntimeAmbiguousRequestError` 拒绝（不冒充成功/干净失败）、`onConnectionLost` 触发、死 client 拒绝后续请求、同网关新 client 立即恢复应答（即 UI 监督器驱动的重连路径在真实线缆上可用）。配合既有层级：RR1 在 FakeRuntime 上覆盖断线补齐/水位丢弃/停止交错；RR3 在真 shell 覆盖 heredoc/语法错误/输出恢复；RR5 在真 TCP CONNECT stub 覆盖代理路径与错误分型；RR4 在真 kernel 搜索路径覆盖范围与扫描计数。验收表复核：自主选项目后各工具路径一致（RR2 work-context+e2e）、停止回执丢失不误判（RR1 store+RR3 e2e）、断线后台完成自动补齐（RR1 store + 本纵切）、exit0 输出可原样引用（RR3 e2e toolCallId 恢复）、覆盖/降级/未配置分态呈现（RR4）、代理/DNS/TLS/策略拒绝可区分（RR5）。仍**未验证**的平台边界：真实桌面安装包断网纵切（无打包环境）、Electron 进程内 env 代理可见性、真实 fake-IP 代理端到端放行、远端 CI/付费代理环境、长流式恢复的实际延迟数字（性能数据在 RR3 `sentAt/firstOutputAt/durationMs` 埋点可用，但没有可复现基线前不报数）。新代码运行方式：`bun run --cwd packages/protocol build`（pi-host 与 web 经 dist 消费新协议类型），其余包按各自 `package.json` 脚本；开发实例需重启 Host 进程加载 egress/服务改动 |

**2026-09-26 验收复核更正：**上表 RR1–RR6 的“wired”和测试数量是执行时的记录，不能推出计划全部完成。本次复核已复现并在工作树修补旧停止回执污染新 Run、重同步的跨代竞态与分离读取、工作上下文重开丢失、shell 准备期超出 `waitMs`、检索范围/来源摘要、IPv6 地址分类及代理重定向等缺陷；首批修补已于 `ed869865` 提交并推送。新增的真实 socket + 生产连接监督器 + UI Store 测试能证明断线自动追赶，但不代替安装包实测。该次复核时尚未闭环的计划合同包括子 Agent 派发时继承操作上下文、截断项目发现的续查、Pi 本地磁盘路径的链接替换边界，以及代理侧最终目标约束和用户可配置的可信出口；真实 Electron 代理环境、fake-IP 代理与跨平台安装包仍未测。验收状态以这些具体行为及后续验证为准，不以原表的“wired”字样推定完成。

**后续四项收口：**子 Agent 的 `thread.dispatch` 在首个异步步骤前冻结父分支操作目录与 `queryScope`，写进 Thread manifest；子 Pi 会话在首次模型/工具请求前建立独立 journal。隔离子工作区只在来源和目录可证明映射时继承，受限 scope 不兼容时明确失败。项目发现支持已授权显式起点、签名续页游标和不受默认深度 3/候选 200 限制的逐页扫描；每页重检授权，读失败目录以 `unreadablePaths` 明示。出站网络设置落在执行 Host：环境代理不自动成为可信代理，显式代理可由部署者委托代理侧最终地址策略；凭据在 Host 的 Pi auth owner 中单独保存、绑定代理端点，配置/认证失败和诊断不静默直连或泄露秘密。`document.readSource` 的 disk 分支现在由 Host 对授权 canonical target 打开句柄并返回实际 bytes；Pi `read`/`apply_patch` 不再按原路径二次读取。验证包括真 Pi 子线程首轮纵切、五层项目分页、受控 HTTP/HTTPS 代理与认证交错、Windows junction 换链后读取外部 fd 再拒绝返回的测试。

**打包桌面端验收更正（2026-09-26）：**真实桌面会话出现 `work_context` 缺席、`read/write` 以 Pi 原生工具越过工作区根。根因是 Electron 独立创建 `PiRuntimeBroker` 时未传 Application Host 的握手能力，故 RR2/RR4 的 Host 路径与检索接线没有进入桌面 Pi worker；此前 Web/进程内测试不能证明桌面已接线。Electron 与 Web 现共用能力声明，桌面构造器也传递执行准入、运行世代及工作焦点解析。真 Pi worker 测试确认桌面会话注册 `work_context`、`document_read`、设置工具；真 Agent loop + Host router 夹具确认工作区内 `write` 成功、越界 `read/write` 被拒且不落盘/泄露正文；路径权威测试覆盖相对 `..` 越界拒绝与工作区内合法上行；新 Windows x64 包构建和已打包应用启动 smoke 通过。**尚未用新安装包的真实模型工具调用复测越界写入**，因此不把 RR2 桌面纵切标为 Proven。任意 shell 本身不是文件工具的工作区沙箱，严格隔离仍须独立处理。

**边界：**可信代理委托的依据是部署者确认代理侧会限制最终目标；Host 无法独立观察其远端 DNS 结果。Node 当前路径读取没有跨平台的目录句柄相对打开，已验证的原路径/父 junction 交换可被拒绝，但不能宣称抵御攻击者精确操纵的所有父目录 ABA 交错。真实 Electron 安装包断网恢复、远程 Host、真实代理策略与 fake-IP、跨平台行为仍未实测；RR6 不因此标为 proven。

下文既有阶段的历史交付记录保留；它们不覆盖上表新发现的缺陷与修复目标。

**D-315 / 阶段 L：Web 与科研检索（2026-09-23），L0–L6 均已接线。**
设计见 [web-research-search-design.md](web-research-search-design.md)，计划为 L0–L6。
通用 `retrieval` 现在允许自然语言报告作为正常结果，`submit_facts` 只在需要结构化、Host 核验的事实时使用；
没有结构化事实时不会覆盖有效 prose，也不会把 prose 标成 source-checked。科研 `investigation` 与普通派发仍复用同一套线程运行时。
L1 已接线（wired）：`web.search` 接受 `query`/`objective`/`queries[]`/`urls[]`/`cursor` 批量条目，每项独立返回
`ok`/`empty`/`unavailable`/`failed`/`cancelled`/`partial`/`denied`/`unsupported`；分页 cursor 由 provider 实际能力铸造
（Brave offset、SearXNG pageno，其余 provider 不铸 cursor），游标绑定 provider 身份与原始筛选。`web.fetch` 支持
`snapshotId` 回读与 `refresh`；成功正文固定为 `web.snapshot` 内核记录（内容 hash 去重、解析方式、获取时间、最终 URL），
行区间/find 位置绑定该快照内容。线程所属快照跨 Run 结算和工作区对账保留，在 Thread 删除时回收；无 Thread 的会话快照随会话 drop 回收，
被其他存活记录引用（晋升 evidence、receipt、来源登记）时继续保留。快照读取按当前 session/thread scope 校验，同一 Thread 的后续 Run 可以重读，
跨 Thread 的显式材料授权留给 L4；foreign receiptId 不授予读取权。同一 URL 的在飞读取按（url/render/策略）合并共享，单个等待者取消不影响其他等待者，
最后退出者中止底层请求。UI 来源列表展示 snapshotId/内容 hash。
新增 `research_search` 工具和 Host `research.search` 服务，默认可查询 OpenAlex，也可选择 Semantic Scholar，支持论文元数据、
摘要/作者/DOI/引用数、开放获取入口、详情查询与分页游标。返回明确区分 `metadata-only`、`open-location`、`empty`、`failed` 和
`unavailable`。
L2 关系展开已接线（wired）：`research_search action=relations` 支持 `references`/`citations`/`related` 按需分页展开
（OpenAlex referenced_works/cited_by 过滤端点，Semantic Scholar /references|/citations 端点），每条结果保留 provider
record id、canonical 身份、版本、来源记录、可见/缺失字段与续页游标；DOI/arXiv/provider id 分立，标题或语义相似不产生身份合并。
关系命中的开放入口经 `webfetch` 进入 L1 快照链，入口存在不表示正文已读。
L3 基础已接线（wired）：`materials.collections` Host 服务（`read.web` 能力）+ Pi `materials` 工具实现 create/add/remove/list/search；
集合为 `material.collection` 内核记录，成员是快照/URL/论文身份的引用而非副本，URL 成员经完整 `web.fetch` 授权路径固定为快照；
集合内关键词检索先应用集合范围再扫描成员正文（各自按调用者权限回读），不可读成员单列 `unreadable`；`persisted` 集合
跨线程生命周期保留并对工作区可读，临时集合随线程删除/会话 drop/工作区对账回收。`webfetch` 新增结构化位置读取：
`page`/`section`/`element`(table|figure|formula)/`appendix` 选择器与 `lines` 区间，快照 `structure` 记录 headings/tables/figures/pages
（PDF 页码经 pdf-text 页边界映射），`structure-unsupported`/`position-not-found` 与 `failed`/`snapshot-missing` 分态表达；
retrieval preset 允许表加入 `materials`。`harnessMaterials` 客户端能力贯通 broker→host-controller→session-host→select-tools。
L3-P0–P2 经 D-326 整理为独立文档阅读链：`document_read` → `materials.read` 与 UI 使用同一原件/派生快照服务；
本地路径先经会话执行工作区及 WorkingState 授权，实验 PDF 沿既有 artifact 授权取得，网络原件由 `webfetch` 固化后复用。
原 PDF 先保存，overview、文字、页面/区域图、结构解析分别请求；默认 PDF.js + 包内 Canvas 渲染，无外部 Poppler 安装前提。
原页引用绑定原件 hash、页码及旋转后左上原点的规范化区域；派生文本/表格等另绑真实解析器版本、配置、页范围与 analysis ID。
按需 Tesseract OCR 保留文字坐标并允许补读已有部分文本的页面；Docling 适配器读取真实正文顺序、章节、图注、表格单元格/跨行跨列/表头及页区域。
可选组件的命令与语言归 `harness.documentReading` 用户级设置，进程沿 Rust 受管启动器运行，取消后确认退出再清理临时材料。
解析版本和共享计算复用原有对象存储/授权；一个等待者取消不取消其他等待者。无法解析仍能回看原件，模型解释不覆盖正文。
统一阅读器提供跳页/缩放、当前页文字、全文搜索定位、页或全文结构请求、区域图片入草稿及 `varin-material://` 引用回跳。
L4 已接线（wired）：retrieval preset 允许表补入 `send`/`read_thread`/`wait`/`follow_up`，通信仍走 `thread.send`/`thread.read`
的同根关系与冻结权限校验。`materials.collections` 新增 `share` 动作产生 `material.grant` 内核记录（发送方线程 → 目标线程，
覆盖 collectionId 或 snapshotId 集合），要求发送方自身可读目标材料且两线程满足 thread.send 的同根关系（父子/兄弟）；
接收方经 `web-materials.read` 的 grant 回退以自身 scope 回读，foreign receiptId 与无授权 snapshotId 仍不授权；
share 幂等（同内容活 grant 复用），grant 随发送方线程删除/对账回收；持久化集合继续对工作区可读但不放开写权限。
L5 已接线（wired）：`research.decide` Host 服务（`read.web` 能力）+ Pi `research_decide` 工具经 `harness.fastDecision`
对真实候选做批量判断；新增 `web`/`scholarly` 两个 purpose 绑定槽（默认 binding → purpose 覆盖 → off，configurationId
随调用冻结）。候选限定为已取得的 URL/snapshot/论文身份/快照区间/新查询文本；snapshot 与 section 候选先在调用者
权限下回读并截取真实正文片段，不可读/畸形候选列入 `rejected` 而不送模型。`relevance`/`reading-value`/`complementary`/
`duplicate`/`continuation` 映射为逐候选 score 问题，`next` 映射为允许“无合适项”的 choose；missing 单列不计零分，
低分只影响排序不裁剪方向。purpose 未配置/关闭/不可用、provider 失败或取消时 `ranked` 保持调用方顺序并给出
`fallback:"order"`，直接检索与 Agent 判断继续工作；结果保留 providerId/modelId/servedModelId/configurationId/usage。
retrieval preset 允许表加入 `research_decide`；`research_decide` 的 details 进入既有来源投影（含 decide 分数标记）。
L6 已接线（wired）：设置页 Fast Decision 区块按 `explore`/`web`/`scholarly` 三用途逐行暴露 default/off/自定义覆盖；
工具设置页新增 `websearch`/`webfetch`/`research_search`/`materials`/`research_decide` 五个开关（写 `harness.tools.*`，
与 select-tools 装配一致）；来源卡为 `materials`/`research_decide` 分配独立图标；settings catalog 的
`harness.fastDecision` 说明更新到三用途；10 个 locale 的 settings 文案同步补齐（i18nParity 通过）。
模块文档（application-host DOCUMENTATION、pi-host harness README、architecture）同步到 L0–L5 现状。
目标是连续搜索/原文阅读与复用、学术身份/关系/段落/图表、线程协作及 Web/学术快速决策消费者。
来源核对不证明 claim 为真，跨线程共享正文不等于共享 Run 回执。未做真实渠道质量/延迟对比，不宣称相关收益。
未实测/未覆盖：真实付费 web provider 与 TypeSafe Jev 实机响应、完整桌面启动纵切、跨平台抓取、快照规模表现、
真实论文总体解析准确率、OCR 多语言质量与候选排序收益仍无系统对比，不宣称普遍收益。已用实际论文验证 Docling 正文顺序、表格结构和原页渲染；
OCR 需要可选 Tesseract，复杂结构需要可选 Docling。Windows x64 已检查打包渲染依赖；其余平台整包与完整桌面阅读交互仍需实际发行验证。

D-321 验收修正：新服务已补入 `HarnessServiceHost` 的生产装配；`research_decide` 不再错误依赖学术搜索开关，
并与 `materials` 一起进入只读并行工具的元数据与资源计划。持久集合成员可在集合保留期间按工作区材料 authority 读取，
共享集合 grant 按当前成员解析，集合检索仅接受调用方显式 `limit`，不再使用未声明的固定命中上限。L6 当前完成的是设置、工具开关和来源投影；
固定 snapshot 阅读器现由页面图路由和来源卡入口提供；更完整的并排材料阅读器、表格单元格编辑和解析任务进度仍可继续打磨。

**D-314 / 阶段 C：后台压缩 Agent 与语义续接（2026-09-22），C0–C4 已交付并进入生产调用链（wired）。**
设计见 [context-compaction-agent-design.md](context-compaction-agent-design.md)。

已接线：

- 专用压缩 worker：broker 经 `#spawnAuxiliaryWorker("compaction", cwd)` 派生 pi-host 子进程（新 `RuntimeWorkerRole`
  `"compaction"`），`pinSession` 到父会话承载事件身份；不注册为会话 worker、不进父会话请求队列，父退出即回收，
  其 `worker.exit` 不被解释为会话退出（`role === "session"` 判定）。启动/注册之后复核父进程仍存活；取消经队列外
  shutdown 中止 Agent/查询并等待清理；Host 在 actor 撤销或进程退出时中止在途查询。迟到结果由父侧身份/世代复核丢弃。
- 固定材料契约：父会话 `context-preparation.ts` 在准备时冻结 `CompactionTaskSpec`（S0 旧摘要、A 被替换区间、
  B 保留原文、边界/分支叶/世代与序列化模型+执行选项）。S0/A 完整下发；B 空间不足时使用带 entryId/原角色的
  参考摘录与明确未读范围。A 过大则向前移动合法切点，其余原文保留，不使用移出 A 再超窗回读的路径。
  模型配置漂移、分支切换、fresh/再次压缩、手动重点变化均按真实来源复核使候选失效。
- worker 内真实 `Agent` loop（`compaction-worker.ts`）：`ModelRuntime.create` 复用同一 agentDir 的
  auth.json/models.json 凭据，经 `createAgentSessionServices` 注册 Pi 静态扩展 provider 后应用
  `ProviderConfigurationManager`；project trust 取父会话已解析的快照，包含未持久化的单次授权。冻结模型与
  reasoning/maxTokens/transport/thinkingBudgets；三件套只读查询工具（history/output/records）经
  `harness.request` 走真实 broker→Host 通路。Pi 消息转换确保 S0/custom 消息实际送达；每次请求检查新增查询后的容量，
  成功任务累计所有模型轮次用量。`streamSimple` 保留 provider 的推理选项转换；模型执行配置漂移在请求前拒绝。
  空摘要、error/aborted/length 及未完成工具调用均拒绝。
- Host 侧辅助 actor：`registerAuxiliaryActor`/`dropAuxiliaryActor` 以 workerId 键控，
  `resolveActor` 只授予 `COMPACTION_QUERY_METHODS` + `COMPACTION_QUERY_CAPABILITIES`；
  `compaction.history` 经 `previewSessionEntries`（catalog worker 直读会话文件，不排队父 worker）并按冻结叶
  截断；找不到冻结叶时返回 unavailable。线程列表不推进父观察游标，records 支持报告/转录与运行修订，实时结果带
  observedAt。`harness.respond` 按 `identity.workerId` 路由回具体 worker。
- 等待与提交：请求前容量核算不变；容量不足且在飞时等待同一候选不另起，`compaction.run` 以 `timeoutMs: 0`
  免除桥/路由默认时限；提交仍走 Pi 原生 `appendCompaction`，原历史保留、半成品不提交。手动压缩与自动共用同一
  worker 机制（`session_before_compact` manual 分支同步执行同一 spec），旧单次摘要调用与弱化更新提示已删除
  （`completeSummary` seam 移除）。

验证：protocol build/typecheck、pi-host、runtime-broker build 与 application-host 类型检查通过；pi-host
套件 460/461（phase3-e2e 一项为负载下已知时序波动，单跑通过）；`session-e2e` 压缩链 3 结局（commit/cancel/
invalid-summary）与 D-284 admission 经真实 in-process worker Agent 验证：B 材料在 marker 下方逐字到达、容量等待
同一在飞任务、取消/错误结果不提交、write 工具调用不执行；broker 套件 85、web harness 聚焦 33 项通过。

独立验收修复：上述旧摘要过滤、手动旁路、A 分页与 worker 容量、查询游标副作用、来源/进程竞态均已修正。
新增本机真实 broker→pi-host 子进程→可控 HTTP 模型→Host 查询响应的往返验证
（`packages/runtime-broker/test/compaction-process.test.ts`），覆盖实际进程取消与父 owner 消失后的回收；
相关材料、worker、查询与 router 行为检查见同模块测试。

配置边界：内置 provider、models 配置与 Pi 扩展初始化时注册的 provider 已接通；父业务会话生命周期事件之后
才建立的私有状态、动态 provider/hook 闭包不会跨进程迁移。依赖这类状态的扩展仍需可独立加载的 provider 注册；
不可用时明确失败并保留主历史，不能将该边界描述成只是尚未实测。

未实测：真实付费模型驱动下的摘要质量/延迟、实际桌面发行包纵切与跨平台；本机源码子进程已验证，
不再以进程内替代测试代表该证据。不声称语义质量或缓存/速度收益。

**D-313 / 阶段 B：Varin 全面更名（2026-09-21），产品源码与仓库切换完成；首次新品牌发行待发布。**
设计见 [varin-rebrand-design.md](varin-rebrand-design.md)，B0–B4 的内部切换已落地，下一实施阶段为 F。
包命名空间、CLI、协议/事件、配置目录与 key、原生 appId、kernel、工作台 ID、当前文档和发布脚本统一为 Varin，
没有旧名别名、回退、双写或迁移层。真实 Pi 包、`PI_CODING_AGENT_DIR`、`.pi`、AuthStorage 与原生会话仍归 Pi。
名称切换时保留过原方块 π 图标；后续用户已定稿“回折”标志（横边向外延伸、两半小幅斜向错开）。
日常 Logo、桌面/托盘、Web/PWA、移动与 Widget 采用平面标志；Splash 保留正方体与原相机/动效，
顶面使用同一份折带几何。新图形随后续构建分发，未重新发布已有安装包。

- GitHub 原仓库已改为 `Youzini-afk/Varin`，仓库身份、提交、tag 和历史 release 保留；本地 origin 已切换。
- Bun、Cargo、cloud runtime 锁文件已更新；保留第三方依赖版本。全包 type-check、lint、cloud layout 9 项、
  编译后的 host/broker/client smoke 6 项与 Logo/Splash 40 项通过。
- Host、kernel、CLI、Electron main/preload、Web/PWA 和移动资源完成构建。首次 CLI 构建命中了旧的本地
  `.application-host-types`，重建类型产物后通过；没有为旧符号增加兼容导出。
- [kernel release smoke](../scripts/smoke-kernel-release.mjs) 验证新二进制的文件写入、检索、结构解析与 shell。
  一次性完整 Host 启动检查使用新建的 Varin 数据目录与独立 Pi agent 目录：内置 Pi 就绪，Web 入口、
  `/health` 和 `/api/version` 正常，随后正常停止并清理测试目录；没有触碰开发者已有数据。
- **发行边界**：当前版本号已更新为 0.9.13；未移动 tag、覆盖旧安装包或发布新 npm 包。npm 本地登录返回 E401，
  `@varin/*` 首次公开发布仍需有效发布身份及 scope 权限；新安装包、可选语义组件和 GHCR 镜像需由新坐标的
  发行工作流生成。未声称已有新品牌下载产物，也未进行真实浏览器、macOS/iOS 或 Android 原生构建验收。

**D-312 / 阶段 F：快速决策模型与渐进检索（2026-09-21），F0–F4 已交付并进入生产调用链（wired）。**
设计见 [fast-decision-model-design.md](fast-decision-model-design.md)。

已接线：

- `harness.fastDecision` 独立配置种类（默认绑定 + `purposes.explore` 覆盖或 `"off"`）进入设置目录、检索设置页与
  全部 locale；user 级所有，project 级被剥离。`parseHarnessFastDecisionSettings` 拒绝非法 protocol、空 id、
  绝对/反斜杠 endpoint 与未注册 purpose。未配置时原检索路径不变。
- `harness.fastDecision` RPC：Host → `workspace-inference` → Pi session-host/host-controller →
  `background-inference.ts` → `typesafe-systemone.ts`（TypeSafe System One 原生 `noul`/`choice`/`score`
  questions 协议）。凭据留在 Pi provider/auth；`harness.inference.describe` 返回无凭据 `configurationId` 绑定；
  请求与冻结绑定不符（protocol/provider/model/endpoint/configurationId）在 HTTP 前拒绝；missing answers 不解释为
  false/0；取消沿用既有 inference cancel。
- `explore.query.start` 冻结 Pi describe 的 purpose 状态并回报；`explore-fast-decision.ts` 在同一 query 内渐进运行：
  `m:` 判定材料是否进入答案、`a:` 判定动作是否值得执行，执行走 `followup({actions})` 与既有
  search/graph/readFile authority。动作候选从已读材料的真实关系生成（read/path/symbol/connect/importers/callers/
  references/calls），确定性 id 去重，未知/过期 id 拒绝，目标与行界经确定性校验。
- 绑定 ready 时 `explore` 跳过同目的 LLM 选材与 HTTP rerank（设计 §4.4）；关闭/失败/取消时保留算法检索与来源排序。
  `details.fastDecision` 记录 status/batches/rounds/viewsJudged/actionsOffered/actionsExecuted/missing/
  unevaluated/usage，`model.fastDecision` 如实呈现 used/failed/cancelled。

验证：protocol/pi-host/web/ui/application-client tsc 全绿；`typesafe-systemone.test.ts` 适配器契约、
`background-inference.test.ts` 绑定/冻结/disabled/invalid、`explore-fast-decision.test.ts` 循环执行与 stale id
拒绝、`explore-query-services.test.ts` 集成与未配置兜底通过；既有 explore 套件 142 项与 i18n parity 通过。

未实测：真实 TypeSafe/Jev 付费往返、跨平台、完整桌面 E2E；检索质量与延迟收益无证据。Computer Use、
工具路由等其他消费者未注册为可用能力。

**D-306 / 阶段 S：对话式设置与 Agent 管理（2026-09-20），经 D-308/D-310/D-311 收口，当前产品范围已完成并进入生产调用链。**
设计见 [agent-settings-design.md](agent-settings-design.md)，实施顺序见
[plan S0–S4](agent-harness-plan.md#阶段-s对话式设置与-agent-管理d-306)。

已接线：

- 共用目录 `application-client/src/settings-catalog.ts` 被 UI 搜索和 Agent `settings_search/read/update` 共用；app 字段走
  `persistSettingsCas`，Pi 字段走 native `settings.get/update`，保留原 owner、scope、trust 与 revision。
- secret 只返回 isSet，set/reset 均不能绕过凭据 owner。app owner 拒绝 global/project scope；未信任 project 不进入
  effective。app removal 与 set 一样执行 tunnel 等领域副作用。
- Pi settings 候选在写前经过新 Run 使用的 Harness/permission/inference validator。写入中的 custom tool 不同步 reload
  自身 runner，配置在 `agent_settled` 或下一 prompt 边界应用；延期 reload 的候选值在提交时被快照，写后立即可读（b97ad78f）。
- 设置工具进入原生权限 source/action 分类；read/search 为 read，update 为 guarded control。app 变更使带 epoch 的缓存失效，
  Pi settings 变更刷新已打开的 Harness controller，在途保存期间到达的刷新不会丢失。
- 目录修正已确认的量纲/default/缺项，模型选项读取实际 `model.list`；此前 sanitizer 丢失的 DesktopSettings 字段保留修复。
- `settings.action` 经 `lib/harness/settings-actions.ts` 的注册表调用 provider、MCP、Pi 资源/包、扩展、语言支持、
  远程、Git identity、magic-prompt、知识库、runtime 与 tunnel 等既有 owner。adapter 的实时 verb 与 catalog 取交集；
  无 owner API 的条目不再广告可执行 verb。provider/MCP/plugin 配置返回领域白名单投影，原文凭据、header/env 与 URL
  userinfo 不进入模型；owner 没有可查询操作身份时只返回 pending 与实际复查入口，不构造假 operation handle。
- client owner 经 `lib/harness/client-surfaces.ts` 的桥接线：UI 先以认证主体登记 live broker session 与窗口 Surface，
  Host 发出的单次 permit 再由该 Surface 的 SSE 连接消费；request/ack 绑定认证主体、session、Surface id 和 connection nonce。
  UI 只有完成真实 store/IPC 操作后才回执。Agent 不能传任意 Surface id；恰有一个该 session 的认证 Surface 时可操作，
  离线为 unavailable，多个为 ambiguous。重连与 session 删除会撤销旧绑定。set/reset 按 catalog 校验，已知默认值由
  Surface 恢复，失败不广播 applied。
- `settings_update` 支持 `items[]`：app 文档及 Pi global/project 各用自己的 item revision/CAS，冲突重复路径在写前拒绝，
  字段失败进入 item 的 partial/failed 结果并对模型可见。app 与同一 Pi scope 分别单次原子提交；client 与跨 owner 操作
  返回逐项事实，不承诺不存在的全局事务或 Surface 批量原子性。
- `settings_search` 结果携带当前值摘要/类型/scope/可用性等渐进披露信息（8b29c18e）。
- 产品 Skills 经 `lib/pi-runtime/product-skills.ts` 按发现体系按需种子到 agentDir：引用稳定设置 ID 与 action 入口，
  当前值/参数/安装状态由工具实时查询，不复制第二份静态 authority（8b29c18e）。
- 真实异步 action 只有在 owner 提供稳定 status（及实际 cancel）能力时才进入 typed `settings.operation`；身份绑定
  session + entry + operationId，Rust 核验 envelope/payload/CAS。现有安装、登录、准备和连接 adapter 会等待 owner 的
  实际返回并直接报告 applied/unavailable，不把已完成调用伪造成长期 pending。

定向证据：设置服务、session→Surface 认证绑定、action 脱敏与 operation identity、组合 CAS、并发 reload、产品 Skill
与工具输出的相关行为检查通过；protocol、Pi Host、UI 与 Application Host 类型检查通过。

边界：个别没有 owner API 的目录项保持 unavailable；同一 session 在多个窗口打开时不猜选 Surface。运行中 harness
配置按 `next-run` 生效；远程 Host 的 app 设置作用于该 Host 文档。真实外部登录/付费安装往返和跨平台 Surface 未实测，
按本阶段交付选择不再作为完成门槛，也不据此宣称这些外部环境已经 proven。

**D-307 / 阶段 W：会话等待、触发与续接（2026-09-20），经 D-308/D-310/D-311 收口，W0–W4 当前产品范围已完成并进入生产调用链。**
设计见 [agent-follow-up-design.md](agent-follow-up-design.md)，任务见
[plan W0–W4](agent-harness-plan.md#阶段-w会话等待触发与续接d-307)。

已接线：

- `follow_up`、UI 会话条目和 Rust `followup.definition/occurrence` 记录接到同一 Host 服务；时间、实验终态/后备和 manual
  来源可登记、查询、更新、取消、检查和主动触发。
- definition 操作绑定原 session/Thread，experiment 读取保留真实 `allowedThreadIds`。先持久化 observer/pause intent 再读
  snapshot；旧 revision callback 不能触发更新后的来源，长于 Node 单次 timer 上限的绝对时间只分段重挂。
- active→settled 竞争重新走同 occurrence admission；occurrence/definition 以 CAS 收口，暂态失败保留 pending，永久目标
  丢失转 unavailable。reconcile 读取失败可重试，并对账 Goal/attention。
- 同一 Goal 的多个等待共享 pause 身份，最后一个结束才恢复。启动恢复枚举 Thread workspace 与配置项目，UI/list 对临时
  workspace 再补按需 reconcile；Host stop 关闭 scheduler/follow-up producers。
- artifact/file/metric/log/external 来源接入同一 definition/occurrence admission：artifact 绑定 attempt/artifact identity；
  file 注册受 caller path scope 限制，watch ready 后才 snapshot，并以 exists/size/mtime/generation/sequence baseline 处理
  changed/ready/reset；metric 消费结构化 resource sample 的阈值跨越；literal log 游标保留跨追加/分页 overlap 且不再以
  固定页数截断；external 仅接受注册 adapter（当前 `github-pr`），轮询与 `fallbackAt` 使用独立 timer。delivery 窗口内
  file/metric 事件在进程内合并，回 waiting 后重新 prime；artifact/log 从耐久 owner 补读。
- 远程/生命周期收口：受管远程在首次离线探测前记录 machine→workspace，恢复后只 `inspect`/reconcile 既有 job identity，
  不重提交。Thread archive/delete 与 session 删除主动 settle；失败会阻止 session 删除或在后续 reconcile 按 durable Thread
  lifecycle 重试。当前没有实验 attempt 删除入口，因此没有虚构 attempt-delete hook；来源真的消失时由实验 owner 读取转
  unavailable。kernel `storage.record.workspaces` 枚举 owning workspace，definition 内容仍按 workspace-scoped grant 读取。
- calendar 任务的 Agent 管理：`schedule.*` 按 caller workspace→project 路由；JSON task 支持真实 partial patch，Markdown
  update/enable/delete 在进程内串行 revision 临界区执行。run-now 经过全局/项目 admission，可显式运行 disabled task；
  `schedule.status` 只返回调用方项目，桌面 quit-risk 继续使用独立 global status。slash command 的 Goal 与普通 prompt 一样
  等待真实 Goal 终态。
- scheduler 恢复：once 按任务 timezone 判断到期；persisted running 在本进程无在途身份时转 interrupted；启动失败可重试，
  stop generation 阻止旧运行重新挂 timer。周期 timer 只有在已经越过该 slot 的下一合法 occurrence 时才合并跳过，普通
  event-loop 迟到仍执行；不使用任意墙钟 watchdog 释放真实会话。
- 原 scheduler 普通任务等待实际 settle；多轮 Goal 持有调度身份直到真实终态。会让仍运行会话释放不重叠锁的 30 分钟
  watchdog 已删除；首次创建 `.agents/loops` 可由已存在祖先 watcher 捕获。

Stage W 后续来源已接线：`any`/`all` 使用隐藏 leaf definition 与 parent latch，并保留 repeatable edge；file/metric 边沿先写
`followup.observation` typed record，再按各 definition cursor 消费；file watcher、metric/attempt subscription 与 external query group
按相容身份共享并在最后订阅者退出时释放。Thread occurrence 经同一 `thread.send(kind=request, context=continue)` 核心、message ledger
和 requestId 处理 active/held/settled/queued，暂时投递失败由同一 durable occurrence 重试；root session 仍依赖 Pi 原生 receipt。
普通 shell 的 start/completion 写 Knowledge owner，登记时先从 supervisor 按字节游标补读已有输出，再订阅新 chunk；follow-up
只保留匹配事实与 definition cursor，不复制整段日志。Host 重启后不能重附着的本地 shell 转 unavailable。

边界：file/metric 在 Host 收到来源边沿后先耐久化，来源 owner 尚未送达的瞬时事件不承诺跨进程 exactly-once；本地进程
不因登记等待而升级为远端耐久作业。真实 GitHub 登录、完整桌面重启/跨平台、外部编辑器参与 Markdown CAS 和真实模型链
未实测，按本阶段交付选择不再作为完成门槛。

**D-292/D-295 阶段 Q：测试与 CI 体系重整（2026-09-19），实施完成、本地验证通过，已由主代理验收收口。** 现状审计与处置见
[testing-ci-audit.md](testing-ci-audit.md)，设计见 [testing-ci-design.md](testing-ci-design.md)。

已交付：kernel/native 验收集由 `packages/web/vitest.kernel.config.ts` 唯一归属（主 Web 套件 271 文件/2334 用例全绿且不再依赖
Rust 产物；`test:kernel` 26 node 用例 + 17 文件/120 用例全绿）；恢复测试已重定向到生产 journal 引擎与忠实内存 durable
端口，退役 local-sqlite 引擎与 3585 行 helper 删除；`tsx --test` 递归 glob 全仓加引号统一发现；Electron vitest 拆分主套件与 updater/linux-desktop 专属入口；i18n 专项 CI 步骤并入
UI 套件删除；docs 日期门禁移除；`test:node-smoke` 改为消费 production-build 产物；docs-only 变更经 changes job 门控
不再触发原生/容器构建。云部署 smoke 失败根因确认为产品缺陷（`@varin/extension-builtins` 误置 devDependencies，
`server/index.js` 运行时 import 缺失致 daemon 启动即退），已移入 dependencies、重生成云锁文件并在部署/构建校验与
layout 测试中断言；deploy rollback 现输出 daemon 日志尾部。`thread-wait-admission` 的挂钟断言改为可观察 held 状态 +
结果断言。

**D-294/D-295 的历史边界已由 D-296 收束。** 旧 VS Code 适配层曾被移出正式产品证据与
required CI，D-296 已删除其包、开发/构建/打包入口、共享表面契约、专属文档与发布链，不保留兼容
副本。文档、根构建与 built-server knowledge smoke 已在本地完成验证；未把 packaged、跨平台或远端
CI 结果外推为本地证据。AI4S 现可进入下一阶段。

**D-290 编程语言支持开箱即用（2026-09-18）。** 在 TS/JS/JSON 之外，内置 Python、Go、Rust、Java、C/C++、C#、Kotlin、Ruby、PHP、Bash、CSS、HTML、YAML、TOML 的结构包和提取查询。发行构建校验 15 份新增 wasm 的大小/SHA-256 并实际编译查询，运行时仍由 Rust kernel 提取；查询缺失报告 unavailable。不可变语法摘要和 kernel recipe 按身份复用，避免每个源文件重复读取、散列和注册同一个 wasm。

语言服务器方面，新增 Python（Pyright）、HTML、CSS/SCSS/LESS、JSON/JSONC、YAML、Bash 的自包含内置扩展；Rust Analyzer、gopls、clangd、Marksman 在首次实际请求时准备到私有目录。状态查询不启动进程或下载。用户也可单独准备/取消，准备不会创建无文档的常驻 LSP 进程。原生工具优先验证本机可执行程序；没有可用程序时使用固定官方版本，远端资产校验 SHA-256；gopls 需要已有 Go 工具链。安装程序只获 Host 私有工具目录的进程授权，LSP 会话继续使用实际工作区的授权。设置页将安装可用性与运行状态分开，包名/ABI/导入放在技术详情，十种语言文案同步。

证据：`structure/tree-sitter-provider.test.ts` 23 项包括新增语言的真实原生提取和缺查询；`extension-builtins/test/packaging-smoke.test.mjs` 加载独立临时目录里的真实 `host.cjs` 并激活，从其注册 descriptor 启动六个 provider，各返回实际符号或 hover；`lsp/bundled-language.test.ts` 经真实 Host → Rust 进程链返回 Python 符号与类型诊断。`managed-servers.test.ts` 覆盖共享准备、取消、重试、缺工具链和本机程序探测；另在 Windows 实际下载官方 Rust Analyzer/Marksman，经 KernelProcessService initialize，Marksman 返回 Heading/Child 标题树。`jsonrpc.test.ts` / `preparation.test.ts` 覆盖双向请求 ID、按需启动和关闭期间取消。Host 构建的独立输出包含 20 个语言/变体的可读结构查询。

边界：新增 tags 语言提供 outline/classifyHits，不冒充尚未实现的 imports/literalCalls 或完整调用图；C# 当前覆盖 class/interface/method/namespace。Java/C#/Ruby 等服务器尚未接入，结构能力仍可用。clangd 没有此清单中的原生 ARM 下载产物时仍可复用本机程序。macOS/Linux 真机、真实 Go 编译安装、完整 Electron 安装包与浏览器点击链未在本轮实测；未把组件安装当作项目 SDK/依赖已经齐备。

**D-289 默认网页搜索与原文续读已接入（2026-09-18）。** 无搜索配置的新会话默认具有 `websearch`，Host 使用 Exa 免密钥 MCP，明确失败时才尝试 Parallel并显示原因；自配服务不偷偷改绑，完全不探测或复用模型账户。空结果、限流、协议错误和取消分开处理。Settings 提供默认服务说明、自配入口与显式关闭，十种语言同步。`webfetch` 的 `find` / `start_line` / `end_line` 复用原页面抓取和缓存，保留 URL/来源收据。

证据：`session-e2e.test.ts` 的 default web search 纵切使用真实 Pi SessionHost/模型工具循环、Host 服务与默认 MCP HTTP adapter（HTTP fixture），覆盖零搜索配置 → 搜索 → URL 读取与正文定位；工具与 Host 定向测试覆盖取消、换源、空结果、域名约束、自配失败、错误配置和原文范围。另用公开工具 → bridge/router → 真实 Exa HTTP，无搜索凭据，约 1.7 秒返回 FastAPI 官方文档；再以本地注入 Exa 429、真实 Parallel HTTP 验证顺序换源，约 1.0 秒返回两条域内来源并保留限流说明。这些均为单次现场值，不是延迟 SLO。随后本机直接抓取被既有 SSRF 策略拦下：系统 DNS 返回 `198.18.0.x` 与 `fdfe:dcba:9876::/48` 代理地址，后者属于私网，故不把此现场记成真实外网页面续读成功；原文续读已通过上述 fixture 纵切。未测免费额度长期表现、全平台外网可达性与完整桌面点击链。

**D-288 本地语义检索已改为用户按需安装的独立组件（2026-09-18）。** 基础 Desktop/Web 构建不再下载或复制
MiniLM 模型，生产依赖不再包含 Transformers / Node ONNX / Web ONNX。Settings → Agent Harness → 检索提供
显式下载、离线导入、进度、取消与重试；Host 校验归档路径、目标平台、完整文件清单和 SHA-256，并在独立子进程中
完成真实推理后原子切换组件。安装完成即刷新本地语义后端；在途查询仍持有启动时的模型身份，远程 embedding 配置不受影响。
未安装时词法/结构检索正常工作，不自动安装模型；远程语义仍通过用户配置启用。

Windows x64 实际产物：安装包 **262,211,818 → 172,679,437 字节**（约 250 → 165 MiB），展开后约 **875 → 580 MiB**，
文件 **20,840 → 17,734**；独立组件归档 **52,369,311 字节**（约 50 MiB）。删除重复 Host 源码/模型与重复 kernel 副本，
保留内置 Pi、Rust kernel、知识库和语音功能必需依赖。以上是产物大小证据，未测量安装器全程墙钟。
`smoke-windows-unpacked.mjs` 已在新安装包的 unpacked 产物上验证干净 profile 启动、内置 Pi 0.85.1、语言/恢复/终端服务，
以及组件未安装 → HTTP 离线导入 → 真实 384 维推理校验 → ready；`local-component.test.ts`、`minilm.test.ts`、
`harness-316.test.ts` 覆盖失败保留、损坏组件、固定查询模型身份与远程绑定。构建、定向 lint/类型检查、i18n 与文档校验通过。
Release workflow 已接入各平台独立组件构建和发布资产；本轮未发布新 GitHub release，当前本地安装包可使用离线组件，
在线安装需对应版本组件资产发布后才可用。macOS/Linux 原生组件与安装器墙钟未在本机验证。

**D-298 / AI4S 7A（2026-09-19）：工作台入口、独立工作侧重与科研根主线已实现并接线。AI4S 整体仍为 Partial。**
顶部使用独立的「Agent / IDE」切换与「通用 / 科研」工作台菜单，实际 Shell 切换复用事务与动画；
IDE 保留按 Host 记忆的工作台返回目标，对话工作侧重另设，项目/会话导航保持用户所选 Shell。
Research Shell 共用窗口、导航、资源面板和权限交互，以真实 root Thread/Run、最近结果和可展开的分支/材料组织当前会话。

项目默认侧重通过现有设置保存，新会话按显式选择 → 项目默认 → 通用解析并捕获来源；已有会话独立保存
selected/active/generation/pending/failed。新 Run 启动前应用，进行中的 Run 及其追问队列保留原配置。
科研提示使用当前用户 Pi 会话与模型；真实 agent_start/settle 对应 Registry 根 Thread 和 Run，没有隐藏主会话或第二套研究数据库。
attached-root 与 spawned-child 区分生命周期；主线结束后分支、原始会话和结果保留。视图挂载不调用模型。

D-299 当时只证明入口与执行身份纵切；动态升级、同 Thread 换模型、通用协作与本机实验的后续交付见 D-300/D-303。
7B–7F 整体仍为 Partial：受管远程与原生集群执行、综合/写作闭环及完整科研质量评估尚未完成，
不宣称异构科研集群、真实付费模型质量或完整桌面跨平台验收完成。

**D-300（2026-09-19）：实验执行与通用多 Agent 协作设计；分段实施及验收见下。**
[设计第 6–7 节](research-cluster-design.md) 与 plan 7C–7E 取代强制 ResearchUpdate/研究板和机械事件综合：
原 7D 范围包含本机/受管远程/首个原生集群后端（后由 D-304 延期原生集群）、资源观测与确认分配、真实取消/重连及产物保留；7E 使用自然语言消息与可选等待，
从最后一段已有可见输出生成约 20 字现状预览，持续经 Zone 2 增量提供并可展开原文，不增加汇报或总结模型。

设计提出时的能力缺口已由下面的分段提交与验收返工逐项处理，不能继续将“当时尚未实施”当作当前状态。
该条记录 D-303 当时边界；受管远程实验与跨机器调度/恢复随后由 D-305 / 7I 交付。原生集群不在当前范围。

**D-300 实施进展（2026-09-19，按序提交）：**
- 7B 余项：冻结模型传入会话创建并持久化 model_change；同 Thread 新 Run 可经 `thread.send` 升级 capability/资源/模型（settled/lost 后）；dispatch 明示 `model:"inherit"`（`7a31f551`）。
- 7E-1：`send(to, message, wait)` 按 requestId 关联等待答复，同 requestId 续等不重发；等待让出模型执行名额但不释放实验资源（`337a0c3d`）。
- 7E-2/3：每请求团队现状尾注（zone2.status/statusDelivered + 观察游标 + `varin-context` 持久收据），`read_thread` 增加 `what:"transcript"` 原文展开（`fe54ea56`）。
- 7C/7D-1：kernel typed records（research.source/experiment.*/resource.*）+ Host experiment/resource/source 服务 + 本机后端；attempt 幂等提交、准入、排队、真实进程、退出事实、取消、游标日志、产物收集与重启重附着；`experiment`/`resources`/`research_source` 工具经 `harnessExperiments` 能力门控（`56de0424`）。
- 7D-2：资源概览分列容量/确认承诺/观测用量/来源/时间戳/连接状态与按机器的排队 attempt（`f661b96e`）。
- 7D-3：实验后端接缝（`experiment-backend.ts`）+ 非本机机器登记；登记的集群机器经自定义后端跑通完整生命周期，无后端机器如实拒绝提交。受管远程与 Slurm 适配器仍未交付，不声称远程执行（`3044887c`）。
- 7F：会话域 HTTP 路由（experiments list/get/logs/cancel/collect、resources、sources，rootScopeForSession 解析归属工作区、requireAuth 生效、忽略请求侧 scope 字段）；`varin:harness-experiment-changed` SSE 事件；Research Workbench 概览内新增事实面板（attempts/machines/sources、取消与收集入口）。

原交付报告证据（验收前）：`experiments.test.ts` 7/7；路由 8/8；面板 4/4；web harness 套件 979 通过。主代理随后发现这些证据未覆盖规格/资源/恢复/跨会话 UI 等缺陷，不能据此宣布完整 7F 全部通过。
未实现：受管远程与 Slurm 后端（Slurm 后由 D-304 移出当前范围）。未实测：完整桌面 Host 重启、真实付费模型驱动下的端到端实验链。

**D-303 / 7B–7F 验收返工（2026-09-20）：本机生产链与通用协作修复，整阶段仍为 Partial。**

- 执行规格保留命令参数顺序、稳定请求身份与原始 actor；规格资源用于实际准入。输入经 Rust 固定到 immutable root，attempt 在独立目录执行，后续修改源目录不能污染排队输入或另一 attempt 的同名输出。
- 机器与承诺统一到 Host 级 Rust catalog 域，跨工作区准入共享事实并幂等释放；这是 Varin 预留，不是对其他用户进程的 OS 隔离。CPU 来自真实计时采样，未观测 CPU/GPU 不显示成零。
- 实验身份、来源对象与产物按实际会话/Thread 关系授权；只读资源工具不授予启动/取消能力。来源 objectHash 进入真实 GC 引用；文件/URI locator 本身不冒充已下载内容。
- 完成、观察不可用、取消确认、收集与释放分别处理。真实进程未确认停止时不释放承诺；显式 Thread kill/delete 联动实验，正常 Run settlement/archive 保持独立生命周期。
- 7F 更新走正确的 `/api/varin/events` 客户端。面板按需展开详情、日志与可下载产物，跨会话/乱序请求不覆盖当前事实；模型通过 `experiment(action:"artifact")` 分页读取收集文本，二进制不作为 base64 塞进模型。
- capability 切换需要新执行现场时，Run 经正常 fresh/spawn 路径准备；原始 continuation 意愿与实际执行 mode 分开。消息重试核对稳定冻结配置；显式 Run 原文按真实范围读取，边界缺失不返回整个 session，旧输出不冒充新 Run。
- 现状范围覆盖实际可交流的父/兄弟/子关系；删除无依据的 30 行截断，不把没展示的行确认成已送达。该条记录 D-303 当时边界；每请求完整临时表随后由 D-305 / 7G 接通。

验收后的定向证据：
- 真实 release kernel：`experiments.test.ts` + `experiment-workspace.test.ts` 21 项、`resources.test.ts` 4 项、`sources.test.ts` 1 项通过。覆盖独立输入/输出、源目录回收后的续接与取消、超过 8 MiB 的日志完整读取、跨工作区准入、来源 GC 保留、启动响应丢失、未知状态恢复观察，以及 backend 已释放后仍能重试 commitment 清理。
- 公开消费者：路由/关系授权/服务 capability 17 项，Pi 实验工具与权限 23 项，面板行为 10 项通过；8 语言文案 parity 通过。HTTP 下载验证连续输出多个内容块，模型文本阅读与二进制结果区分。
- 通用协作：thread status 13、runtime 83、registry 44、services 49 项分别通过，包含显式 continue 被提升为 fresh 后的同 requestId 重试和缺失原文边界。
- protocol build、Application Host tests / Pi Host / UI 类型检查、改动范围 lint、工程文档 16 项、文档链接校验与 `git diff --check` 通过。没有重跑全仓套件，也没有把 service 重建当作完整桌面 Host 重启证据。

本机输入捕获会读取声明范围内的依赖/数据树，具有实际时间与存储成本；本轮不宣称受控性能改善。
D-304 将受管远程、多机器执行、轻量批量操作与材料复用排入 7I；实验关系自然生长，不再把独立“矩阵产品”列为缺项，Slurm 暂缓。
完整研究质量及串行/并行对比尚未实测。本机功能阶段按代码逻辑、生产通路和实际消费者收口；
未开展的真机、真实模型和对比实测保留为证据范围说明，不因测试清单未补齐阻断交付。7G/7H/7I 已由 D-305 分阶段收口。

**D-301 / 7G（2026-09-20，D-305 已实施）：请求前环境增量与完整团队现状表。**

目标：传统环境观察在每次实际模型请求前检查，新事实送达后留在历史；每个授权 Agent 同时获得当前关系范围内的完整短表，
作为临时尾部附页，不只推变化行、不只给主 Agent、不把历次表写入历史。固定协作说明放稳定系统提示，动态材料默认为标明来源的
`user` 内容；内部消息类型/权限保持区分。历史前缀不重排，快照成本计入实际请求容量；普通状态与消息/结果正文不混淆交付。
详细实施和定向验收见 [plan 7.11 的 7G](agent-harness-plan.md#711-分阶段交付) 与 [Harness 8.1.1](agent-harness.md#811-d-301环境增量留史团队现状作为请求尾部快照后续-7g)。
生产 `ContextRequestBoundary` 在每次 Agent provider 请求前准备两类材料，先计入容量；环境材料在 provider 真正开始后写入 Pi 原生历史并确认收据，
团队表每次完整重建但不留史。压缩后重新准备；请求未开始、Host 不可用和空团队分别表达。团队进展取真实最后可见段落及 Run/entry 来源，无状态总结模型。

**D-302 / 7H（2026-09-20，D-305 已实施）：工具资源调度与后台长任务。**
Pi 的真实执行入口现在消费工具在权限确认后给出的资源计划：独立调用重叠，同路径读写、多路径 patch、共享 shell 和未知副作用保持顺序；
前序工具失败只结束自身，不取消后续已排序调用。依赖修改由 Bun tracked patch 固定，没有运行时安装目录修改或第二套 Agent loop。

`bash` 默认短等待并支持 `waitMs:0`，RPC 期限覆盖观察窗口但不是进程期限；`get_output` 可事件等待，输入/终止控制不被等待占住。
真实完成、失败和取消按 executionId 去重后进入 7G，已由工具结果保留的终态不会重复。普通本地 shell 仍不冒充跨 Host 重启耐久实验。
详见 [Harness 5.9](agent-harness.md#59-并发) 和 [plan 7.11 的 7H](agent-harness-plan.md#711-分阶段交付)。
原交付验收与 D-305 的 7G/7H 实施分别记录。

**D-304 / 7I（2026-09-20，D-305 已实施）：受管远程、多机器执行与按需运维线程。**
远端执行服务复用 Rust/已有 Host，持有真实作业、输出和资源确认；目标身份、协调者位置、断线续接与远端直接操作明确。
管理 Agent 定位为运维：小规模由当前线程处理，规模扩大可按机器组/环境/数据分管多个普通 Thread，再按需要协调。
程序负责常规资源分配，运维线程使用已有工具、消息、现状及明确等待处理现场，不固定层级、不逐事件调用模型。
研究与实验随讨论自然生长；只补多项提交/等待/取消/补跑及代码/数据/环境复用，不建设矩阵编辑器、必填维度表或参数搜索平台。
Slurm 等原生集群留待明确需求，不在 7I 范围，也不作为当前阶段未完成的理由。
现有桌面/SSH 可信连接发现目标 Host 的稳定身份和能力；目标以真实 client principal 隔离作业、进程、分配和产物。
固定材料按内容对象缺失增量上传，每个 attempt 独立物化；目标 kernel 持久监督提交、日志、取消、收集与重连。资源确认覆盖多工作区，
GPU 以 UUID 和可用显存分配并强制写入 `CUDA_VISIBLE_DEVICES`。批量提交/取消和单项补跑已接公开 HTTP/Pi/UI 消费者；远端普通 shell 共用目标与权限链。
尚未实测真实外部 SSH 主机、跨平台远端和桌面关闭后的长时运行；Slurm、矩阵 DSL 和专用运维 runtime 按设计不在范围。

D-292 将阶段 Q 排在 AI4S 功能实施之前；科研产品设计保持，现有版本发行按自身适用证据推进。

**D-284 上下文无感续接已实施（2026-09-16）。** 真实请求前预算（`context` hook 覆盖回合内继续）→ 水位触发固定范围后台摘要 →
前台继续追加 → `session_before_compact` 提交候选或等待/同步 fallback → Pi 持久压缩 → `compaction.after` 重置观察基线 →
`history` 工具回读被摘要原文，整条链已在真 Pi + faux provider 纵切验证。持续 keeper、coverage 接管、memory_edit、
memory-mode UI 与旧协议字段已删除；`harness.context` 设置取代 `harness.memory`，旧 `memory.mode:"off"` 作为迁移读仍关闭
后台准备。摘要质量与真实缓存收益在使用中观察，faux 只证明接线。

**D-285/D-286 已实施，并由 D-287 完成独立验收收口。** D-286 的上下文侧随 D-284 落地；`fresh-input` 构造由
settled 线程的新 Run 消费，同一 Thread 的旧 Run 原文通过授权 `history({run})` 回读。D-285 的 3.18A–E 已落地：
dispatch改为任务中心（`task`必填、`preset`可选、`input`可选`task|inherit`），普通派发继承发起者当前模型与活动工具，
`shared`只作显式选择，Run启动时冻结模型/工具/权限/scope/worktree/prompt片段/inputOrigin（`task|inherit|continue|fresh`），
Thread持久化与UI投影改用`preset`（旧`role`记录仅在历史导入边界读取），嵌套preset-less派发的工具声明不得超出父Run
冻结allowlist，自动review默认关闭。`input:"inherit"`在派发时经Host接缝捕获父会话已提交输入（已提交摘要+边界后
保留原文，有界渲染），固化进manifest并随dequeue/spawn进入子会话提示；`send`的`kind:"request"`对settled实现线程
新建Run——`continue`重开保留会话原样续跑，`fresh`用协议`assembleFreshInput`重建输入开新会话，旧转录经
`previewSessionEntries`读取、工作现场与结果保留。3.18C已落地：`send`支持`inform`/`request`/`replyTo`定向消息，
目标范围从实际根任务关系解析（父/子/同根兄弟，`to:"parent"`解析父Thread或父会话），跨根与无关目标拒绝；消息作为
耐久`in`/`out`记录持久化在Thread上，`requestId`幂等重试观察已记录结局而不重复投递/执行，`replyTo`解析实际请求并
解除`waitingFor:"thread"`等待；`inform`对运行中目标经runtime投递、对settled/排队目标按held停放、不新建Run，
`request`对settled线程经`threadContinueRun`准入续做、名额满时把`pendingContinuation`停在Thread上由dequeue提升；
执行准入按同根统计并与 Run 发布在同一 catalog mutation 内完成；真实 dependency wait 让出名额，返回模型前原子重取；
`setAttention`/`endRun`触发
`tryDequeue`提升排队线程或停放的续做，`onAdmissionFreed`回调驱动lost恢复复查；wait服务对Thread调用方标记依赖
等待（先标记后订阅，自身标记不唤醒自己）、返回时按同一边界flush held消息并重新准入。3.18D已实施：结果修订按
发布时基线冻结溯源（kernel `working.result` 校验 `baseRoot`/`baseStates`/`pathStates` 必须镜像发布基线/结果根），
`branch.write` 支持 `baseRef`/`parentRef` 在 CAS 下原子切换基线并应用完整 delta；`thread.update`（Pi Host 工具→
公开协议→runtime `updateBaseline`）把工作分支重订到选定父结果修订，三方规划保留子delta、采纳父方变更、干净
文本合并、分歧路径报告冲突，物化 worktree 随之刷新。3.18E已收口：自动review默认关闭且父线程无会话
时也按关闭处理（settings权威默认`enabled:false`）；UI线程面板提供Ask（request+continue）/Fresh（request+fresh）/
Note（inform）定向消息控件与最近消息来源/held状态显示；公开`POST /api/harness/sessions/:sessionId/threads/:threadId/send`
路由经与Pi Host工具相同的`thread.send`服务投递，`sendError`把`HarnessServiceError`映射为400/403/404/503；role-required、
单向send、永久执行manifest与per-parent准入等旧路径已移除，无重复兼容实现。

**D-282 已完成 R0/R6，并据此完成阶段 R。** R0–R6 的生产责任均已按各自可执行契约接管：Rust kernel 统一拥有工作状态/恢复元数据、文件资源与物化、受管进程/PTY、固定视图文件与结构计算；TypeScript Application Host 保留产品策略、公开 API、Documents/Registry 协调、知识与模型编排，Pi worker 保留 Agent loop、provider、会话和扩展。R0 的 request-credit、取消/断线和发行身份，以及当时 Desktop/Web/云/VS Code 发行布局的历史证据，均已在该阶段收口；VS Code companion 的当前支持面随后由 D-296 退役。阶段 R 不再是当前实施主线。

完整边界见 [rust-kernel-design.md](rust-kernel-design.md)。本机真实证据为 Windows x64；Windows ARM64、Linux x64/ARM64、macOS x64/ARM64 的相同 native build/verify/package/smoke 已固化在 release workflow，当前提交尚未观察这些远端 runner 的实际结果，因此不把本机结果外推成其他平台实测。代码签名仍按产品合同可选，真实 ReFS/APFS extent sharing、物理断电和付费模型质量不是阶段 R 的实现完成条件。
D-253 明确当前无用户兼容需求：取消默认旧内部库转换要求，直接替换内部格式并删除旧路径；正常新格式的数据完整性契约保留。

**P0 integrity、T1 线程核心与 T2 权限纵切（2026-09-04）已完成**：broker Actor、Host 静态授权、versioned
Thread/ThreadRun catalog 与启动对账、事件驱动 wait、OutputRef/TranscriptRef、UTF-8 字节分页、workspace canonical lease，
以及异步 dispatch → 真实 Pi child session → 冻结角色模型/工具 → worktree → report/transcript → merge 均已进入 Web/Application
Host 生产链。Host 通过握手声明真实线程能力，pi-host 才注册七个工具；无能力的 Host 不暴露休眠工具。

**T3 上下文 shadow 第一条纵切（2026-09-04）已交付**：Documents 提交与现有 Git 状态刷新 → 会话事件库 → 增量游标 → Zone 2 → 真实 Pi
provider 请求；用户改动后的 LSP 诊断、当前 blocks、context usage 与相关 accepted knowledge 进入同一路径。memory keeper
由用户显式开启，复用活动会话模型在后台写块，默认关闭且不接管 Pi compaction。

**历史文档修订（D-071–D-073）未改变当时代码。** shadowMode:true 实际是 assist；当时登记的版本/分支/覆盖缺口随后由 D-076
修复。record-only、窗口草稿读取仍未交付；TriviumDB 优先保留、Windows 沙箱排除、不自行发起付费记忆实验的边界保持。

**随后 D-076 已完成第一组本地正确性纵切**：branch copy-on-write/tombstone、原子 CAS、实际 context entry coverage，以及
worker 响应送达后推进 observation/thread cursors 已接生产路径。它不改变 assist/default-off，也不把本地 faux-provider 证据当作
外部语义验证；具体边界见下表。

**D-078 的正式实施与默认交付政策保持。D-079 修复实际数据链路。** 磁盘 explore 默认接入真实 Documents 正文，原生结果与集成
使用实际 recovery storage。旧实现曾把 helper、构造器和测试总数当作完整交付，本表已按真实消费者重新校准；其后 D-082–D-086
已补窗口草稿的 explore/grep/read/find/ls、线程基线消费者和 copyIgnored 结果范围，双修订预览（D-201）与归档/空间治理（D-202）已接线。

**D-203–D-205 已完成本轮验收返工。** 旧预览覆盖新编辑、surface 提前 complete、预览请求自循环、退出前释放写者、准备失败无法重试及并发回收/预算问题均已按具体反例修复。真实 Documents/Registry 混合集成与撤销、Windows Git Bash/PowerShell、Git/native 归档恢复再发布及普通线程打开前恢复已有证据；证据范围与尚未验证的平台见下表。

**D-206/D-209 已接通后台 shell 与 terminal runtime，并补正身份和退出契约。** 公开 `bash` 后台命令与用户终端 tab 共用同一进程；`sh_N` 由全局 runtime 分配，HTTP 不能接管；后台自然退出不依赖 `get_output`，终止和 writer 释放失败不会伪报完成或提前放开目录。bundled Pi 在无显式选择时优先于 PATH/system；todo/plan 的 confidence 只作信息，已删除写入后的假确认字段。证据与未测平台见 1.3 / 2.5。

**D-207/D-210 已接通固定结果的验证记录，并去掉时间邻近式绑定。** 子检查要求 actor/worker generation/Run/binding generation 和命令 start/end/publish 输入身份一致；父检查绑定完整 Integration 的 result/operation/parent session 持久窗口。非 Git 无便宜身份时如实标 uncertain，不做每命令全仓扫描。review 绑定结果、review 线程和 Run，失败/取消与迟到旧结果均有明确归属；D-285 已把自动 review 默认改为关闭。证据与未测范围见 3.4 / 3.5 / 3.7。

**D-208/D-211 已接通 Settings 知识目录与 knowledgeSuggestions 槽位的用户消息提议，并补正并发和写入身份。** Settings 对 workspace/user `.tdb` 做列表/查看/编辑/停用与取代链，所有变更核对打开时完整修订；作用域切换淘汰旧请求。`knowledge.suggest` 固定写 actor workspace/user-message 来源，相同正文的历史查重与插入原子完成。公开 recall 与 Zone 2 仍只看当前有效 accepted；未配置不借用主模型。证据与未测范围见 2.7 / 2.10。

**D-212 已接通隔离 Thread Run 的 WorkingState 只读视图。** 同名 `read` / `grep` / `find` / `ls` / `explore` 走 Host `document.readSource` / `document.pathOverlay` / `search.content` / explore reader，读取固定 base 加 delta/tombstone；父目录与物化/scratch 磁盘不能补读。没有路径绑定工具的隔离 Run 只建 scratch cwd。

**D-213 已接通虚拟文本写入与原子物化切换。** 同名 `edit` / `write` / `apply_patch` 经 Host `document.branchWrite` 提交 WorkingState delta，父磁盘不变；`writeRevision` CAS 拒绝迟到覆盖。首次 `bash` 或 LSP 导航由 Host 冻结修订、等待在飞虚拟写、staging 物化并原子切换整个 Run；失败保持原虚拟分支。结算发布 `publishHeadResult` 或收回目录变化。证据见 3.4 / 3.4a。

**D-214 已接通隔离 dispatch 的磁盘基线固定。** 创建 Thread 之后、返回之前（含 queued）捕获 Git/非 Git 工作目录字节并建立 WorkingBranch；父之后的漂移不能进入子基线。捕获失败或取消删除 Thread。证据见 3.4 / 3.4a。

**D-215 嵌套线程接线的所列生产反例已由 D-216–D-224 关闭。** 角色目录与 `parent.kind: "thread"` 数据模型保留。D-216 已拆开 owning/execution 身份；D-217 已让改父虚拟分支走同一写 gate；D-218 已补 dispatch 基线诚实；D-219 已补冻结权限、耐久嵌套集成、级联终止与 captureScopes 继承；D-220 已补执行 Git baseline、查询级固定视图与 dispatch 内容身份；D-221 已补 branch Integration 锁顺序与 WAL；D-222 已补恢复时 execution gate、dequeue 冻结权限、session-bindings 对账与知识 owning 解析；D-223 已补后代自己的 lifecycle serialization 与 scope 只拒绝完整 `..` 段。3.4 / 3.4a / 3.6 保持 Partial：D-231 已补受管 retrieval 输入；旧记录缺 managedRoot 会拒绝自动动作，真实付费嵌套 Pi 与完整桌面重启未测。

**D-216 已拆开 owning workspace 与 execution workspace，并给 Git 物化独立上下文。** Thread catalog / WorkingState / 父子关系使用 owning workspace；Documents / LSP / 路径 / shell 使用 execution workspace。子会话注册不再靠扫描 catalog 或路径猜测。Git 物化使用 `worktree add --detach`（会写 `.git/worktrees`）或独立 `git init`。证据见 3.4 / 3.4a / 3.6。

**D-217 已补正虚拟写入、修订标签、物化切换恢复与树不变量。** 物化 `switching` 后重读 execution view；失败或取消仍写 WorkingState，scratch 不是权威。切换 journal 可从 staging/backup/promote 恢复到一个权威视图。嵌套改父虚拟分支走同一写 gate 并更新父 `writeRevision`。read/grep/explore/semantic 标签等于实际读取的 `writeRevision`。symlink/环/非法 UTF-8/非法祖先拒绝且不写 delta。

**D-218 已补正 dispatch 基线诚实、mode 全字段比较与失败清理。** Git 错误不再吞成空清单或普通目录；捕获窗口变化和活跃 Documents writer 以可重试 `baseline-changed` 失败；gitlink/unsupported 不得静默当空目录或跳过物化；新虚拟文件在形成结果前写入真实默认 mode；apply/补偿按 `sameState`。D-220 已把 fingerprint 扩到内容身份，并去掉用户树上的 mode 探测。

**D-219 已接通嵌套权限冻结、耐久集成与级联生命周期。** `session.create/open` 携带冻结 overlay；live 放宽不能放宽孙。物化父集成对象库仍在 engine dataDir。branch 父集成写入 operations 并可对账/撤销。kill/archive 先停子孙。嵌套 captureScopes 继承父冻结范围。3.4 / 3.4a / 3.6 保持 Partial。

**D-220 已拆开执行 Git baseline 与逻辑 base，并钉住查询级视图。** 独立 init / detach / 崩溃恢复 / rematerialize 持久化执行仓库可解析的 `executionBaseline`；inspect/settle 不再用父 HEAD 去子仓库 `rev-parse`。WorkingBranch 读取在 store lease 后重取当前 view；explore 查询在同一 lease 内复制 immutable snapshot。默认新文件 mode 按 umask 计算。dirty 内容替换与路径集合不变时拒绝混合基线。

**D-221 已规定 branch Integration 锁顺序并补上写前日志。** 先取得父分支写入/切换权威，再决定 branch 或 directory，再打开 store/目录；不得持有 exclusive lease 后等待 `VirtualWriteGate`。`runWhenVirtual` 按 gate/切换/取消等待或改走 disk。branch 操作先写 applying intent，再 CAS，再 complete；启动对账按 before/after 补 aborted、complete 或 needs-attention。

**D-222 已补恢复时 execution identity、dequeue 冻结权限与知识所有权。** directory reconcile 走 execution Documents gate，对象库仍在 owning root；无法解析则 needs-attention。生产 dequeue 把 manifest permissions 送进 `session.create`。`session-bindings.json` 由 catalog/run 重建并对账。Thread knowledge/recall/suggestions/Zone 2 解析 owning workspace。

**D-223 已补级联生命周期 serialization 与 scope segment。** 父 kill/archive 按稳定后序进入每个后代自己的 lifecycle serialization；与 restore/reclaim/merge 并发时不能留下活跃 Run、半归档或在已归档祖先下复活。scope 只拒绝完整 `..` 段、绝对路径和盘符路径。3.4 / 3.4a / 3.6 保持 Partial：D-231 已补受管 retrieval 输入；旧记录缺 managedRoot 会拒绝自动动作，真实付费嵌套 Pi 与完整桌面重启未测。

**D-232 已在 D-228 之上补齐 `agent-mutation` 的写前检查、阶段与恢复可见性。** 根会话仍经 `document.surfaceWrite` 写回同一 Registry 缓冲，不隐式保存。混合 batch 在同一 Documents gate 内先核对全部磁盘字节身份，再允许 surface dispatch；明确失败与无回执分别处理。WAL 记录外部 dispatch/补偿 intent/观察结果与 target-after，条件补偿继续处理其他安全路径，needs-attention 进入恢复状态与 UI。非权威的 32 项内存缓存已删除。磁盘写成功到 target-after 捕获之间崩溃仍会留下可见 needs-attention；完整桌面 Registry 与 Host 进程重启未实测，因此不得标 Proven。证据见 3.2 与 D-228/D-232。

**D-233 已在 D-229 之上纠正多会话投影和退出事实。** 一条用户终端命令按目标 Pi session 分别持久化，幂等键为 `targetPiSessionId + commandId`；生产 adapter 不再丢目标身份，只有该目标首次插入才 nudge。PowerShell 用命令开始时的 `$LASTEXITCODE` 基线区分本命令产生的 native 状态与旧值；无法证明时记录 1，连续相同 native 非零码不冒充精确值。zsh source 用户文件时恢复原 `ZDOTDIR` 语义。产品链无 PTY 重播，不声称 Host 重启重放；本机无 zsh，相关 live 用例跳过，macOS/Linux 真机仍未实测。证据见 2.2 / 2.3 / 2.4 与 D-229/D-233。

**D-231/D-234 已在 D-230 之上收紧 retrieval 的目录与证据权威。** 嵌套 retrieval 在 dispatch 时沿正常 isolated 分支固定父状态，虚拟 scratch 位于 Application Host 受管根；持久 `managedRoot` 必须经 canonical containment 与 Host/backend 再授权，retrieval settle 只封印 evidence，不发布目录变化。receipt 仅 active retrieval Run 可铸造并绑定 owning/session/thread/run、exact URL 与耐久正文；artifact 从创建起有临时引用，promotion/删除/启动对账负责转移或释放。公开 `read_thread` 按 UTF-8 字节分页，不先整体载入大正文。旧 worktree 记录缺 `managedRoot` 时拒绝自动操作；真实付费 retrieval、完整桌面重启与授权 web 抓取仍未实测，3.4/3.4a/3.6 保持 Partial。

**D-080 简化辅助统计。** 已移除“模型槽位用量”区块及其专用聚合/传输，后续不新增同类辅助费用或 Token 看板。
右上角原有普通会话费用、输入/输出/缓存 Token 和上下文容量展示保留；模型槽位的配置与功能不变。
验证：`harnessCounterPresentation.test.ts`、`sessionStats.test.ts`、`usagePresentation.test.ts` 与 i18n 两组测试共 17 项；
pi-host 计数器及 reader、Smart judge、正常 Harness counters 的定向测试共 11 项通过。UI/pi-host 类型检查、protocol 构建、
修改文件 lint 与文档链接检查通过；没有改动 SDK 用量或历史数据。

**D-081 是已退役的历史实现。** takeover/off/assist、keeper、coverage 接管、memory_edit、nudge 与专属 UI 已由 D-284
生产替换并删除；当前运行事实只见 2.4A/B 与 2.6A/B。计划、用户笔记、accepted knowledge 和真实事件保留，但不再承担
持续模型维护或 coverage compaction。

**D-082/D-085/D-086 已交付发起窗口草稿读取。** UI 输入自动把本窗口 dirty buffers 固化到 Application Host，不要求附件或绑定操作；runtime
只传不透明引用。`explore`、`grep` 和 Host-capability 门控的同名 `read`/`find`/`ls` 在这些路径上读取同一固定草稿，后续编辑不污染结果，捕获失败
也不会静默读取旧磁盘内容。read 保留 Pi 原生分页/截断和磁盘图片路径；find/ls 合并 Host 固定路径与原生结果并在合并后限流，相关快照过期返回 unavailable。

**D-083 已交付 dispatch 持久草稿基线。** `thread.dispatch` 在请求内把固定草稿的保存字节与来源修订复制进 WorkingState，
Thread manifest 只保存不可变 baseline id；queued/lost 恢复不依赖临时 surface ref。草稿是 branch revision 0 的父输入，dirty 角色
统一隔离，未修改草稿不进入子结果，ignored 草稿仍被结果采集。Integration 对尚需回到编辑器协调的路径明确返回 surface target，
该路径不写磁盘或冲突标记。surface buffer 写回与整组撤销现见 D-203 / 3.5a；非草稿文件现见 D-214，在 dispatch 创建分支时固定。

## 矩阵

Owner：`host` = `packages/web/application-host/lib/harness`（或 `lib/knowledge`），`pi-host` = `packages/pi-host/src/harness`，`protocol` = `packages/protocol/src`，`ui` = `packages/ui`。

| 能力 | Owner | Implemented | Wired | Proven evidence | Default-on | Fallback | Blocker |
| --- | --- | :-: | :-: | --- | :-: | --- | --- |
| **0.2** 恢复 coverage 路径级（R1） | host recovery | ✓ | ✓ | `lib/recovery/engine.test.ts`（partial / none / ready 三态）；`piRecoveryPolicy.test.ts` | ✓ | — | —（设计文档状态头已记录 R1 implemented） |
| **0.3** `HARNESS_TOOL_META` 与 unjournalled 判定 | protocol / host | ✓ | ✓ | `protocol/test/harness-tools.test.ts`；`turn-coordinator.test.ts` | ✓ | — | — |
| **1.1** worker→host 请求通道（bridge / router） | protocol / pi-host / host | ✓ | ✓ | `pi-host/test/harness/host-services-bridge.test.ts`、`router-bridge-contract.test.ts`、`harness-e2e.test.ts`；`runtime-broker/test/worker-event-identity.test.ts`；`host/router.test.ts`、`service-host.test.ts` | ✓ | — | broker 在 create/open/fork 方法响应后 pin session；请求 payload 无 sessionId；Router 只使用 broker Actor，并由 Host 注册表补齐 workspace 与静态能力（D-035） |
| **1.2** Zone 0 字节稳定 | pi-host | ✓ | ✓ | `pi-host/test/zone0-stability.test.ts`、`pi-hooks-contract.test.ts` | ✓ | — | — |
| **1.3** `bash` / shell 监督器（D-200 / D-205 / D-206 / D-209） | host / pi-host / ui | ✓ | ✓ | `terminal/runtime.test.ts`（程序化 create/attach、全局 Harness id、完整创建身份、HTTP 冲突、真实 force-kill/exit）；`terminal-harness-bridge.test.ts`（同一 handle 上用户附着与 agent 读写）；`shell-assembly.test.ts`（本机真实 Git Bash 后台附着与输入回显、PowerShell 连续调用与非零退出、跨 supervisor id）；`shell-supervisor.test.ts`（转后台继续采集、自然退出不靠 read、kill 失败、真实退出、迟到/释放失败 writer 保留与重试）；`openHarnessTerminal.test.ts` / `useTerminalStore.test.ts`（detach tab、不重开）；`runtime-broker/test/runtime-manager.test.ts`（无选择时用 bundled，显式 system 保持优先） | ✓ | Host 不提供能力时保留 Pi 内置；已配置解释器/设置失败明确 unavailable | macOS / Linux 真机 smoke 未做；浏览器完整点击链未跑。bundled Pi 是 runtime 选择，不是 `harness.shell` |
| **1.4** `OutputRef` 与 `tool_result` 截断 | host / pi-host / protocol | ✓ | ✓ | `host/output-store.test.ts`（epoch、HMAC、水位、Unicode）；`protocol/test/utf8.test.ts`；`tool-result-truncation.test.ts`；`harness-e2e.test.ts` #5；`session-e2e.test.ts`（真实 Pi agent loop：read 大文件只见预览/句柄，再用 get_output UTF-8 分页） | ✓ | Pi 默认（结果原样进上下文） | — |
| **1.5** `grep` 覆盖 | host / pi-host | ✓ | ✓ | `host/search-service.test.ts`；`harness-e2e.test.ts` #4、#6 | ✓ | Pi 内置 grep | — |
| **1.6a** `edit` / `write` 编辑后诊断、`diagnostics` 工具 | host / pi-host | ✓ | ✓ | `diagnostics-adapter.test.ts`（真实 fixture LSP 进程、版本化 error→clean、pending/unavailable）；`session-e2e.test.ts`（真实 Pi agent loop → Host bridge → fixture LSP）；`output-tools.test.ts` | ✓ | 无诊断附注 | — |
| **1.6b** `apply_patch`（Codex 语法，OpenAI 家族） | pi-host | ✓ | ✓ | `pi-host/test/harness/apply-patch-tool.test.ts`（12 解析用例） | ✓（仅 OpenAI） | 不注册 | 多文件回滚未在真会话验证 |
| **1.7** workspace 规范路径租约 | host / pi-host / protocol | ✓ | ✓ | `host/path-authority.test.ts`（Documents identity / Windows）；`path-lock.test.ts`（跨会话、lease ownership、超时）；`apply-patch-tool.test.ts`（多文件单批） | ✓ | — | 保证仅覆盖同一 Application Host 内由 Harness 管理的写入，不覆盖终端、Git、外部进程或另一 Host（D-036/D-041） |
| **1.8** 计数器（toolErrors / toolRetries / outputBytes / observationCalls / cacheHitRatio） | pi-host / ui | ✓ | ✓ | `counter-tracker.test.ts`；`session-e2e.test.ts`（真 Pi 工具失败/重复调用 → SessionStats）；`harnessCounterPresentation.test.ts`（缺字段不造 0、字节/观察/命中率投影）；Context sidebar 生产引用 | ✓ | 非 Pi/Harness runtime 不发布字段则整段不显示 | — |
| **1.9** `HarnessSettings` + 设置页 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-settings.test.ts`（模型槽位、context/review 设置与用户/workspace 所有权）；`pi-host/test/harness/session-e2e.test.ts`；Settings 生产入口 | ✓ | — | review 用户所有且默认 `enabled:false, gate:false`；workspace 值不能放宽用户权限或改绑用户模型/provider |
| **1.10** 静态提示片段 | pi-host | ✓ | ✓ | `zone0-stability.test.ts`（注册全部工具后 system 不变） | ✓ | — | — |
| **1.11** 工具卡片紧凑渲染 | ui | ✓ | ✓ | `toolSummary.test.ts`（摘要、已知只读分组、未知工具不猜只读）；`PiTimelineEntries.renderMode.test.tsx`（真实 SSR：grep+read 折叠、write 独立） | ✓（live 模式） | 每组/每卡仍可展开完整 arguments/result/details | sorted 模式已有整段 activity 容器，不做第二层默认折叠（D-048） |
| **1b.1** 抓取服务（SSRF、重定向、提取、PDF、缓存） | host | ✓ | ✓ | `host/web-fetch.test.ts` | ✓ | — | — |
| **1b.2** `webfetch` 工具 / session-local reader | pi-host / host | ✓ | ✓ | `webfetch-tool.test.ts`（单次 fetch + reader/fallback）；`session-e2e.test.ts`（真实 Pi：Host SSRF fetch 一次 → 配置 reader slot → 主回合收到答案）；`thread-runtime-capability.test.ts`（Host 能力门） | ✓（fetch；reader 在用户配置槽位后） | reader 未配/失败时返回已提取正文，不重复 fetch | reader 使用 pi-host 的 session model/credential authority；已删除无调用方的 Host `web.read` 模型栈（D-066） |
| **1b.3** 默认网页搜索 / 自配 provider / 原文续读（D-289） | host / pi-host / ui | ✓ | ✓ | `web-search.test.ts`（免密钥 Exa/Parallel、SSE/结果解析、取消、限流换源、自配不降级、域名策略）；`session-registration.test.ts`（固定绑定及坏配置）；`web-search-routes.test.ts`（独立凭据）；`websearch-tool.test.ts` / `webfetch-tool.test.ts`（空结果、取消与原文查找/行范围）；`session-e2e.test.ts` default web search（真实 Pi 工具循环、HTTP fixture）；真实 Exa 查询见上文 | ✓（无搜索配置即默认可用；可显式关闭） | 默认路线明确失败时顺序尝试 Parallel并说明原因；空结果不换源；自配服务失败/撤销明确 unavailable 或 error，不静默替换 | 不使用模型账户；免费额度与网络可达性由供应商/环境决定。设置按 worker generation 冻结。现场外网页面抓取受本机代理 DNS/既有 SSRF 策略阻挡，未宣称全平台页面访问已实测 |
| **1b.4** Electron 离屏渲染 | electron / host | ✓ | ✓（桌面） | `session-registration.test.ts`（`web.render=false` 时请求不进入 fetch/renderer；开启时携带冻结策略）；Electron + Web type-check；既有 `desktop_web_render` 与 Application Host 共用 `renderDesktopWebPage` | ✓（桌面，用户开启 `web.render` 后按请求使用） | `renderer-unavailable`；Web/云 Host 无 renderer 时不伪装成功 | 本轮未跑完整 Electron packaged smoke；实现复用同一离屏 BrowserWindow helper，不新增第二 renderer |
| **1b.5** 来源面板 | ui / pi-host | ✓ | ✓ | `harnessWebSources.test.ts`（只接收持久、安全 URL）；`useWebSourcesStore.test.ts`（稳定去重、pin/remove tombstone）；webfetch/websearch details → PiChatView transcript projection → session state panel 生产链；i18n parity | ✓（有来源时） | 无持久 web 工具结果时不显示 | pin/remove 是本地展示状态；来源权威仍是 Pi transcript，重新打开可重建（D-067） |
| **1b.6** 第三方 Web 替换语义 | pi-host | ✓ | ✓ | `pi-host/test/harness/select-tools-web.test.ts`（安装/存在 `pi-web-access` 不改变原生工具；显式 `tools.webfetch/websearch=false` 才关闭） | ✓（原生工具按 Harness 设置） | 用户显式关闭原生同名工具后，普通 Pi package 工具可接管其名称 | 已删除按 `pi-web-access` 包名/启用状态自动让位分支；包存在本身不再改变运行行为（D-283） |
| **1b.7** Web 配置代际与统一域名策略 | protocol / host / pi-host / ui / electron | ✓ | ✓ | `harness-settings.test.ts`（user-owned provider/render、workspace domain 只收紧、显式空 allow=deny-all）；`session-registration.test.ts`（新旧 generation 绑定、renderer gate）；`web-search.test.ts`（工具过滤只能继续收紧）；`web-fetch.test.ts`（初始 URL/重定向前 domain+SSRF、显式空 allow）；UI type-check + i18n parity | ✓ | Host/web renderer/provider 缺失分别表达 unavailable；不把空/失败塌成成功 | fetch/search 共用冻结的 user/workspace domain ceiling；删除无生产消费者的 `maxFetchesPerTurn`；来源面板只接已通过 Host 策略的实际结果（D-283） |
| **2.1** 知识库 v1（TriviumDB） | host knowledge | ✓ | ✓（按工作区懒加载） | `knowledge/store.test.ts`（34，含大小写不敏感子串、短词只精确、重开后不重建内存、写入后计数与形状跟随）；`store.smoke.test.ts`（Node 加载构建产物，CI `test:node-smoke`） | ✓（仅被 todo / recall 使用） | — | 钉住 **0.8.6**，`payloadCacheMb: 0`——其解析 payload 缓存把 `getPayload` 变成 O(库大小)，已向作者报告（D-141）。D-019/D-020 在 0.8.6 上核实已修，块/知识/事件的 JS 过滤与 `recall` 的 JS 扫描保留为「可换」。`flush()` 仍随库线性增长（两版一致），D-140 去抖保留。Electron asar 打包 smoke 未做；v9 格式与 `.pld` sidecar 只在测试临时库上验证 |
| **2.2** Zone 2 组装 | host / pi-host | ✓ | ✓ | `host/zone2.test.ts`（含 `</user-terminal>` 不能拆段）；`knowledge/context-runtime.test.ts`（用户命令进 Zone 2、harness 过滤、两个目标 Pi session 各自入库、per-target 去重、游标不倒退）；`pi-host/test/harness/session-e2e.test.ts`（Documents 用户写入与用户终端命令在下一真实 Pi turn 出现、event cursor 不重复、system 不变） | ✓ | 无材料时不追加消息 | Git 与 prompt-relevant accepted knowledge 已接。无 shell integration 时不造 `<user-terminal>` 伪命令。D-233 纠正结构编码、per-target 持久幂等与退出事实；不得标 Proven |
| **2.3** host 观察者 | host knowledge | ✓ | ✓（Documents + user-change LSP + Git status + user-terminal 带代际 OSC） | `documents/authority.test.ts`（提交后通知且观察失败不反噬写入）；`knowledge/context-runtime.test.ts`（多会话 fan-out、agent 过滤、诊断因果、raw Git status → workspace → event → Zone 2 与去重、用户终端按目标 Pi session 持久化且重复 delivery 最多 nudge 一次）；`terminal-projection.test.ts`（user/harness 分流、nudge 失败不反噬、重复 commandId 不 nudge）；`store.test.ts`（`putEvent` 按 target Pi session + commandId 的持久索引在单写队列内幂等并回填旧行）；`git-status.test.ts` / `git-status-runtime.test.ts`；`git/routes.test.ts` / `workspace-routes.test.ts`；`session-e2e.test.ts`（Documents 与 user-terminal 纵切）；`terminal/shell-integration.test.ts`（只接受本代际标识帧）；`shell-integration-scripts.test.ts`（`sh` 不注入、Bash/zsh/PowerShell 保留用户 hook、Windows PowerShell native/cmdlet/重复同码归属）；`runtime.test.ts`（只注入 user、untagged OSC 不生成命令、`/bin/sh` 无 `--init-file`、restart 后新 zsh D 不结算旧命令且下一 commandId 属新 generation） | ✓ | 观察失败只降级本轮上下文并记录 Host 错误；不新增 Git 轮询；无 integration 为 not-observed | Git 外部变化在现有 status 下一次刷新时可见，不声称后台实时；Harness shell / agent 自身事件不重复进 Zone 2（D-054）。D-233 纠正命令事实后不得标 Proven。zsh / macOS / Linux 用户终端与完整桌面 Host 重启仅未实测；不声称 Host 重启去重 |
| **2.4** 记忆 keeper（off / assist / takeover） | — | 已删除（D-284） | — | 生产路径已移除：keeper 扩展、coverage 接管、memory_edit、nudge 链、memory-mode UI 与 `memory.blocks.*`/`compaction.before` 服务；既有测试证据只属历史 | — | — | 由 2.4A/B 与 2.6A/B 行取代；plans/todos/用户笔记/accepted knowledge 保留 |
| **2.5** `todo` / `plan` 块 | host / pi-host / ui | ✓ | ✓ | `host/todo-tool.test.ts`（confidence 不改变写入）；`pi-host/test/harness/todo-tool.test.ts`（工具不弹写后确认、不发送确认字段）；`phase2-e2e.test.ts`；session state 侧栏可见可编辑（D-046） | ✓ | 不注册 | confidence 只作信息。需要批准时由既有 pre-tool plan/permission 流程处理；`todo.upsert` 没有第二确认协议（D-206/D-209） |
| **2.6** 接管压缩 | — | 已删除（D-284） | — | coverage 接管扩展与 Host compaction.before 服务已移除；压缩由 Pi 触发、context-preparation 候选提交 | — | — | 由 2.4A/B 与 2.6A/B 行取代 |
| **2.7** 知识建议 / 审阅托盘 / 取代链 | host / ui / pi-host | ✓ | ✓（user-mark + Settings catalog + knowledgeSuggestions 槽位用户消息） | `knowledge-suggestions.test.ts`（同 scope 取代、并发相同 user-message 原子去重、dismissed/retired 不复活、trusted settings 合并）；`context-routes.test.ts`（审阅托盘完整 opened-revision CAS、auth/409/取代、显式建议消费 auto-accept）；`knowledge-catalog-routes.test.ts`（Documents workspace 身份、完整 opened-revision CAS、已停用/并发编辑冲突、跨 scope 不串）；`store.test.ts`（accepted 编辑、单 id 停用、reopen 后 recall 不含旧正文、user store 拒非 user 写）；`knowledge-services.test.ts`（`knowledge.suggest` 固定 actor workspace/user-message、协议不能伪造 scope/kind、消费 workspace auto-accept）；pi-host `knowledge-suggestion-extension.test.ts`；UI `KnowledgeSettings.behavior.test.tsx`（scope/workspace 切换、迟到响应与旧 selection）、`knowledgeCatalogRequest.test.ts`；既有审阅托盘与标记测试 | ✓（用户显式动作；配置 knowledgeSuggestions 后的用户消息） | 未配置 knowledgeSuggestions 槽位时不调模型、不借用主模型；设置不可读时保留 suggested；suggested/dismissed/superseded 不参与 recall | 真实付费 suggestions 模型质量未观察；Settings 完整浏览器点击链未跑。删除是 `invalidAt` 停用，不是物理删节点（D-208/D-211）。keeper decisions 建议来源已随 D-284 删除 |
| **2.8** 知识库语义召回（D-196 / D-198） | host knowledge | ✓ | ✓ | `knowledge-recall.test.ts`（向量命中、范围/状态/修订、完整长条目分块、换空间）；`vectors/acceptance.test.ts`（自动维度、绑定异常保留文本、不自循环重试、并发 bootstrap 不串 query、resolver 取消/关闭）；`knowledge-services.test.ts`（actor 工作区传递、公开 recall / Zone 2 取消）；知识库 134 项及新增边界/公开接线 9 项通过 | ✓（未配远程保持文本；有效配置启用派生向量） | failed/unavailable/partial/empty 分列，绑定解析异常也保留文本 | 复用共享代际库、chunker、缓存与调度；受影响 id 即时失效，配置刷新与关闭已接。证据来自真实模块和 faux provider，不证明完整桌面 IPC 或真实外部质量；权威 `.tdb` 不变，不回退 MiniLM |
| **2.9** 普通模型槽位 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-model-slots.test.ts`、`roles.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（reader / permissionJudge 实际功能调用）；Harness Settings 生产入口 | ✓（依赖能力各自按配置启用） | 未配置辅助槽位不注册或走无 LLM 路径；仅 hardImplement / review 明示回退主模型 | 当前普通槽位不含 embedding/rerank；后者是独立配置种类（3.16B/E）。聊天模型列表仍依赖 Pi session。三套预设只填空槽位；D-080 的普通会话统计与 ThreadRun 记录保持 |
| **2.10** `recall` | host / pi-host | ✓ | ✓ | `host/recall-tool.test.ts`（workspace + user 合并）；`store.test.ts`（停用后 reopen 不再召回旧正文）；`phase2-e2e.test.ts` | ✓ | 不注册 | Application Host 已懒加载 `user.tdb`；Settings 目录与公开 recall 共用同一权威。suggested/dismissed/retired 不进入有效召回 |
| **2.11** 会话下一步选择（D-325） | protocol / application-host / pi-host / ui | ✓ | ✓ | `runtime.test.ts`（默认关闭、单次调用、多候选、空结果与重复去重）；`protocol/test/session-features.test.ts`、`pi-host/test/session-features.test.ts`（候选数组与持久空结果标记）；`harness-settings.test.ts`（用户级启用、workspace 不能打开）；Harness Settings 与 PiAssistBar 生产入口；protocol/web/pi-host type-check | —（用户显式启用且绑定 `models.nextStep` 后） | 未启用、未绑定或模型失败不调用/不影响主会话；零候选持久标记；迟到结果丢弃；点击只填草稿 | 真实模型质量、延迟和完整桌面纵切未测；不把 faux 文本当质量证明 |
| **2.4A/B（D-284）** 请求预算与后台摘要准备 | pi-host / protocol | ✓ | ✓ | `context-preparation.test.ts`（12：水位下不准备、固定范围/分支/模型绑定、候选失效条件、在飞复用、split-turn 前缀、失败后不卡死）；`session-e2e.test.ts` context preparation 链（真 Pi+faux：后台摘要挂起时前台回合完成、压缩复用候选不二次摘要、schema-only 工具+toolChoice none+无执行器、同 system prompt） | ✓（`harness.context.preparation.enabled` 默认开，可独立关闭） | 候选缺失/失效时同步准备；摘要失败不截断历史、不带病提交 | 软水位 75%/规划目标 60% 为可配置默认非实测最优；faux 不证明真实模型质量或缓存收益；第二次准备由压缩后仍超水位触发属合法行为 |
| **2.6A/B（D-284）** 按需切换、history 与旧消费者收口 | pi-host / host / ui | ✓ | ✓ | 同上 e2e（压缩提交→`compaction.after`→history 读回被摘要原文→后续真实回合用回读材料）；`history-fresh.test.ts`（10：分支总览、原文回读、query+path 过滤、未知 entry、上限提示）；keeper/coverage/memory_edit/memory-mode UI/旧协议字段与 `memory.blocks.*`/`compaction.before` 服务已删除 | ✓ | 容量不足候选未完则等待同次调用，不先截断；摘要请求自身超窗沿同一机制收束 | Zone 2/知识/线程观察基线只在真实 `session_compact` 后重置，候选 ready 不动游标；retired `memory.mode:"off"` 作为迁移读关闭后台准备 |
| **上下文完整取舍/fresh（D-286 / D-287）** | pi-host / host / ui | ✓ | ✓ | `inherited-input.acceptance.test.ts`（真 Pi active context、工具正文/图片/输出复制与派发时冻结）；`fresh-history.acceptance.test.ts`（新 Run → 同 Thread 旧 Run 授权 history 回读）；`history-fresh.test.ts`（结构化输入与分页） | ✓ | — | 不依赖新评分/清洗模型；真实 provider 的摘要质量和缓存收益仍是使用观察，不是调用链接线证据 |
| **3.18A–E（D-285 / D-287）** 可续做任务线程与定向协作 | protocol / pi-host / host / ui | ✓ | ✓ | 既有 protocol/service/runtime/registry/dequeue/route 证据；新增 `thread-admission.acceptance.test.ts`、`thread-wait-admission.acceptance.test.ts`、`thread-message-identity.acceptance.test.ts`、`thread-delivery.acceptance.test.ts`、`thread-runtime-session.e2e.test.ts`（同根原子准入、非唤醒 inform、native request receipt、消息幂等/回复身份、旧结果跨 Run 可读与公开连续交付）；物化更新见 `materialized-baseline-update.acceptance.test.ts` | ✓ | — | Run 配置由每次 Run 冻结并被 spawn/dequeue/resume/restore/continue/fresh 消费；旧 role/send/per-parent 路径已删除 |
| **3.1** 符号图采集器与查询 | host knowledge | ✓ | ✓（defines + imports/connects/associates + 解析出的 references/calls；explore 路径候选 + 摘录注解 + `related`） | `knowledge/store.test.ts`（节点/边、代际、match、反向 import、紧凑候选 close/reopen 后补关系；resolved relation 行的固定/未固定、重解析替换、目标删除级联、staleTarget、generation 消亡；D-246 anchor 批次重解析两缩一缩空、不同 anchor 隔离）；`knowledge/relations.test.ts`（真 supervisor+fixture 的 collect→持久化、piggyback record、无库降级）；`import-resolve.test.ts`；`symbol-runtime.test.ts`；`catalog-scan.test.ts`（并发扫描合并、无事件正文修改后重扫、连接移除/恢复、不重采集消费文件）；`typescript-service.test.ts`（D-246：显式根、嵌套首文件 cross-file caller、无根回退 cwd 不猜、setWorkspaceRoot 生命周期）；`related-scope.test.ts`（D-246：scope 过滤定义/引用/importers/connections、anchor 外拒绝、partial 组合状态、pathInRoots 一致性） | ✓（随 Documents mutation + 打开后火忘冷扫描；resolved 行由查询期 collector 与 lsp 导航回写） | 未知语言只 touch file；结构 unavailable 保留最后图；范围绑定磁盘 revision，脏缓冲不入图——resolved 行同样只持久化磁盘绑定答案，跨文件站点一律 unpinned、目标 revision 移动报 staleTarget（D-240）。未确认关联仅存在 file metadata，不建 link 节点 | D-236 已移除同名闸门再访的重读/重解析；extractor 3 使旧目录下次重采集。当前 2520 文件冷建 185767.1 ms、显式未变重扫 10314.095 ms，详见下方观察；没有同语料改前对照。D-140/D-141 的 18.4/4.8 分钟保留为历史。仍不冷启 LSP——resolved 行只在真实查询驱动下由已运行的语言视图产生；目录限 TS/TSX/JS/JSX。D-237 已补完整重扫的外部删除对账：missing 确认、代际条件删除与排队取消；失败/截断/未知 inventory 保留旧图。D-240 已接 references/calls 边与 relation collector；D-246 返工修正 LSP 根推断（来自 initialize 而非首个文件父目录）、related/explore actor scope 贯穿、权威 anchor 批次重解析（清掉消失 site）、partial 组合状态、explore 公开链暴露 findReferences/findCallers/findCalls；PageRank/多跳仍未做。完整桌面冷建未实测 |
| **3.15** 快速 explore：查询上下文、分组计划、成组选段与局部补查（D-175–D-189） | protocol / host / pi-host | ✓ | ✓ | `explore-query-run.test.ts`（start 到达即读、原问题词法与慢语义并行、同文件晚到语义重建、稳定 viewId、required 组、单元来源排名、来源终态与冻结）；`explore-query-services.test.ts`（固定来源、完整 actor、受限 scope、取消与响应未送达、fixed roots 传递）；`router.test.ts` / `service-host.test.ts`（授权 cancel、request actor key、session 换代清理）；`semantic/runtime.test.ts`（查询取消停止等待）；`explore-model.test.ts` / `explore-tool.test.ts` / `host-services-bridge.test.ts`（模型输入、Host accepted、补查失败保留首选、timeout/dispose 实传 cancel）；`session-e2e.test.ts`「runs plan expressions through ModelRuntime…」（公开 `explore` → `completeSimple` → 新表达搜索 → 最终原文）；`knowledge/store.test.ts` / `knowledge/semantic/store.test.ts`（scope 内 Top-K、`.` 快路径、文档更新删除） | ✓（公开 `explore` 默认；配置 `models.explore` 后同一路径启用模型，未配置保留算法/向量） | 未配置或调用失败保留已取得材料，不回退主模型；取消/失败/不可用/无命中/截止未完成分列 | 真实 `models.explore` 质量与墙钟未观察，不作为启用门。120s/8s 是尚未按真实 provider 定标的工作预算，不是 SLO。D-189 已让受限 scope 的图/向量后端在有效 roots 内计算 Top-K，reverse importer 在截断前过滤；`.` / 空 roots 保留未受限语义快路径。native ONNX 当前批不能被 JS signal 硬抢占，取消会停止等待并丢弃迟到结果。远程嵌入、向量复用、语义草稿覆盖与专用 reranker 见 3.16B–E；router 取消与超时目前同为 `timeout` 码；`harness-e2e` #3 是既有 D-103 |
| **3.16B** 远程 embedding 配置、后台绑定与 OpenAI 兼容调用（D-190） | protocol / pi-host / host / ui | ✓ | ✓ | `protocol/test/harness-settings.test.ts`（workspace 不能留下 embedding/rerank）；`pi-host/test/harness/openai-embeddings.test.ts`（乱序/缺项/维度/NaN/取消）；`pi-host/test/harness/background-inference.test.ts`（user/operator-only resolver、项目 provider 重定向隔离、binding 竞态、cancel→fetch、endpoint/credential space）；`semantic/harness-316.test.ts`；`session-e2e.test.ts`（旧手工 consumer 链）；`semantic-workspace.e2e.test.ts`（D-235：共用生产装配、真实 SessionHost/HTTP adapter、双执行目录路由、无效配置/失败状态）；`workspace-runtime.test.ts`（配置与取消生命周期） | ✓（配置有效即走远程同一 space；未配置时仅在用户已安装本地组件后使用 MiniLM，D-288） | 远程失败/未绑定 Pi：语义 `failed`/`unavailable`，词法与图继续；同一查询不静默切回本地 MiniLM | 真实远程 provider 延迟、质量、成本未观察，不作为启用门。知识库语义召回已按 2.8 / D-196 单独接线，不回退 MiniLM。Host 从不接收或持久化 provider secret |
| **3.16C** 向量复用、完整编码与前台优先（D-191） | host | ✓ | ✓ | `semantic/harness-316.test.ts`（embedText 复用、单块重嵌、并发扫描合并、前台插队、partial 首发、迟到 revision、scoped 缓存仍做授权 Top-K）；`semantic/chunker.test.ts`（超长单行续切、多块覆盖无缺口）；`semantic/minilm.test.ts`（Node ORT session 线程） | ✓（随语义索引） | 缓存满按字节软预算淘汰，不拒绝查询；后台当前批完成后前台优先 | 完整冷扫墙钟仍未量得（沿用 3.16A）。远程 Host 侧按字符长度续切，不是远程 tokenizer 精确计数 |
| **3.16D** 固定草稿与线程分支语义覆盖（D-192） | host | ✓ | ✓ | `semantic/harness-316.test.ts`（立即遮蔽、dirty-only、删除、supersede、捕获后继续编辑、兄弟线程隔离、缺向量≠缺正文） | ✓（公开 explore 的 `semanticRecall`） | 草稿/线程向量未完成：语义 gap/partial，词法与读取继续用已固定原文 | 物化 child 使用自身 Documents workspace，virtual 使用固定 WorkingBranch；copyIgnored 不自动扩大范围。D-235 公开 SessionHost 纵切已覆盖原生写入通知、后台发布后同回合 explore；完整 nested dispatch/桌面启动未测 |
| **3.16E** 专用 HTTP reranker（D-193） | protocol / pi-host / host / ui | ✓ | ✓ | `pi-host/test/harness/http-rerank.test.ts`（非法/缺失 ID、部分响应）；`explore-rerank.test.ts`；`explore-query-services.test.ts`（select=used 不调用、select=unconfigured 调用）；`session-e2e.test.ts`（旧手工 consumer 链）；`semantic-workspace.e2e.test.ts`（D-235 共用生产装配 → 真实 Pi `/rerank` adapter，结构化状态为 used） | ✓（`harness.rerank` 有效且本轮未用 LLM 选择时） | 失败保留来源排名与可读材料，details 标明未参与/失败；explore 整体不失败 | 真实 rerank provider 质量与费用未观察。当前 registry 无标准 rerank 方法，使用可配置 HTTP `/rerank` 契约，不把 chat/embeddings 改名为 rerank |
| **3.17** 按命令整理 bash / get_output（D-197 / D-199 / D-241 / D-247） | host / pi-host / protocol | ✓ | ✓ | `output-organize/organize.test.ts`（pretty 诊断、未知正文、混合命令、失败位置/watch 提示、UTF-8 首尾、超预算大块/提示、分片；包管理器通配：脚本回显识别内层工具、exec/dlx/x 直接定二进制、install/audit 摘要与错误块必需、warn/进度噪声折叠、生产 `shell.exec` 链；D-247 返工：未知 `pnpm dlx custom-tool` 走 generic、唯一 warning 保留与重复折叠、checksum failure 进度行保留、EBADENGINE 唯一 warning 在非零退出进 required、watch/interactive prompt 保留、分片输出首尾保留）；与 `observation-services.test.ts` 25 项通过；Pi 公开工具相关测试 24 项，最后截断复验 10 项通过 | ✓ | 未识别或不可归属的混合输出走通用展示；显式分页与 `out_` 读原文；旧 Host 未整理结果保留通用截断 | 只对实际 Host 整理结果免二次裁切。原文、字节游标与退出码保持；增量末片也标当前观察。包管理器通配已接（D-241）：`npm`/`pnpm`/`yarn`/`bun` 头先归管理器层，回显/嗅探识别内层工具则交给其解析器并保留包裹行，否则折叠 PM 噪声、保错误与摘要。D-247 返工修正：exec/dlx/x 后未知二进制走 generic 不走 PM 折叠；唯一 warning 保留、仅重复相同 warning 折叠；含 failed/error/checksum/permission 的进度行不折叠；非零退出时 failure-relevant 噪声与唯一 warning 进 required。不接声明式规则、TOML、jest 专名或模型总结；不是完整 shell 解释器 |
| **3.2** `explore` + `grep` + `read` + `find`/`ls` 的磁盘/发起窗口草稿纵切；根会话 `edit`/`write`/`apply_patch` 写回同一缓冲（D-225 / D-228 / D-232 纠正身份、WAL 与补偿） | pi-host tool / host Engine / Documents / ui | ✓ | ✓ | `explore.test.ts`；`explore-service.test.ts`；`search-service.test.ts` / `search/content.test.ts`（dirty 排除先于有界 cap、regex/fixed/case/glob/context、写入后该路径改按磁盘搜索）；`document-read-source.test.ts`（固定字节、BOM、dirty-only、过期、写后读回自己的写；经 router 写缓冲后同一回合 read 见新正文）/ `pi-host/test/harness/read-tool.test.ts`（原生分页与图片）；`documents/authority.test.ts`（写入失效：原生写、Documents 写、根外路径不失效、过期仍不回退磁盘、overlay 与 clone 同步；缓冲写、二次 edit、用户续编 conflict）；`documents/authority-surface-identity.test.ts`（CRLF 二次 edit + apply_patch 不改盘、两 surface 路径一次 Registry undo、UTF-16/BOM 字节恢复、重开 catalog 为 compensated/needs-attention、owner 不可用不对账猜成功）；`documents/surface-mutation.test.ts`（共享计划、同一 operationId 整组 undo、前向 abort 后补偿用新 signal、delete/NUL unavailable）；`recovery/turn-coordinator.test.ts`（确认工具前 await，before/失败不失效）；`document-path-overlay.test.ts`；`find-ls-tool.test.ts`；`workspace-mutation-journal.test.ts`（surface 不 journal、普通路径仍 journal）；`apply-patch-tool.test.ts`（surface 匹配不写盘且携带 revision/hash、readSource unavailable 即使磁盘可匹配也不写、混合失败诚实状态）；`session-e2e.test.ts` 固定 surface find/ls 与「fixed surface edit」公开 Pi edit → Host → Registry | ✓ | 已知 dirty capture 不可用时相关 read/search/find/ls/LSP 导航都不读磁盘；其余路径继续 disk；Host 未声明对应 capability 时保留 Pi built-in。D-225/D-228/D-232：snapshot 拥有的路径写 Registry 缓冲，不隐式保存；用户续编 conflict 保留其正文；混合写入先预检全部磁盘成员并持久记录外部阶段。磁盘写到 target-after 捕获之间崩溃仍明确 needs-attention，不冒充自动恢复 | D-090 第一组已验证：`limit` 只管输出条数（`explore.test.ts` T1）；search-service 收 actor/inputContext，explore 不再自带草稿匹配（`explore-service.test.ts` T2）；词项分组与 anchors 字面优先、非硬过滤（T3/T4）；测试路径不默认降权（T5）；按需物化记 `not-requested`（T6）；互补打包（T7）；自身字节预算与句柄（T8）；工具接受并转发 `anchors`（`explore-tool.test.ts` / `session-e2e.test.ts` T9）。D-092 已验证：候选模式 30 个匹配文件×每文件 12 命中、预算 200 时 30 个文件都进候选且总命中 ≤ 200，路径序最后的文件仍在（`search-service.test.ts` breadth-first）；文件数超过预算时报 `filesDropped` 且与命中裁剪分列；grep 同输入仍是默认 limit 100 的深度优先截断。六个小项已收：`showHandle` 为真时 `result.text` ≤ `byteBudget`（`explore.test.ts` / `explore-service.test.ts` T8）；返回对象不含 `searchIncomplete`；空白 anchor 过滤后 `supplied` 保留原样（`explore-service.test.ts`）；每路 `rgSearch` 用局部 partial；`fileScore` 每文件一次；一个 anchor 文件排在只匹配 3 个拆词组的文件之前。验收复验补的两项已修并有断言：`filesDropped` 取单次查询最大值作下界（`explore.test.ts` 跨词项不求和、`explore-service.test.ts` 250 文件 × 两个重叠根仍报 50 而非 100，正文"at least"）；工具 schema 接受空白 anchor 交由 Host 过滤（`explore-tool.test.ts` 对 `tool.parameters` 直接 `Value.Check`，非字符串仍拒）。D-232 的生产链与定向反例已接，但磁盘写成功到 target-after 捕获之间仍以 needs-attention 收口；完整桌面 Registry、生产 Host 进程重启对账与 macOS/Linux 会话未实测，3.2 写入纵切不得标 Proven。证据见 D-228/D-232 记录。之后：结构切片消费 6.4 带修订范围、上下文覆盖、模型增强 |
| **3.3** `related` | host / pi-host / protocol | ✓ | ✓ | `related-tool.test.ts`（Host：没有 vs 不完整、反向 import、空目录 vs 未收录、未解析 specifier；resolved references/callers/callees 段与状态）；`pi-host/test/harness/related-tool.test.ts`（默认注册、`tools.related: false` 省略）；`session-e2e.test.ts`「session e2e — related」（真 Pi：`activeTools` 含 `related`，已打开 store 返回定义/Imported by，正文含 `lsp.references` 分工、不含 rank） | ✓ | store 未打开 → `unavailable`（不开库）；空目录 / 未收录路径 / 名字未命中 → `empty`；查询抛错 → `failed`；relation 段按 per-source 状态区分 ready/empty/unavailable/unsupported/partial/failed | 名字锚点现在对每个定义做一次有界 references+definition+callHierarchy 解析并把结果写回图（D-240）；路径锚点回答本文件已存站点与指向本文件的 call 边。不做 PageRank / 多跳。目录未扫到的语言是不完整或 empty，不是失败 |
| **3.4 / 3.5** 原生线程运行时与 7 个工具 | protocol / broker / host / pi-host | ✓ | Partial | `workspace-identity.test.ts`（Documents 给原目录与 scratch 不同 workspaceId；session.create + Harness router + 公开 dispatch 建孙线程；孙写入 owning catalog 且 `parent.kind` 为父 Thread；threads/wait/Zone 2/lost resume 看直接子层）；`thread-registry.test.ts`（session binding 重启后仍指向 owning workspace；catalog 无 binding 可重建；stale binding 拒绝）；`thread-services.test.ts` / `zone2-threads.test.ts`（execution workspaceId 不能冒充 owning catalog；binding 无 owner 拒绝 thread tool；生产 `thread.kill` → runtime cascade 含 queued 子孙；`src/foo..bar` / `version...txt` 经 dispatch 接受；非法 scope 带草稿 cleanup）；`dequeue-permissions.test.ts`（生产 `onThreadDequeued` → `session.create` 带 accept-edits，live bypass 不能放宽）；`knowledge-owning.test.ts`（owning≠execution 时 recall/suggest/Zone 2 打 owning store）；`thread-worktree.test.ts`（父 worktree 内独立 `git init` 持久化 `executionBaseline`，inspect 不对该执行 SHA 报 bad object）；`working-state/execution-baseline.test.ts`（Git 父仓库 isolated dispatch → `document.branchWrite` → `workingBranch.ensureMaterialized` → shell 写 → settle/drain → native result → merge 根目录；reclaim/rematerialize 不引用已删子仓库对象；staging-promoted 恢复写出可解析 execution baseline）；`working-branch-view.test.ts`（lease 后重读正文与 `@revision`；`explore.query.start` pin 后词法/原文/语义仍用快照）；`thread-runtime.test.ts`（create 传入冻结 permissions；dirty 文件内容中途替换且路径集合不变时 `baseline-changed` 且不留 branch；kill 取消在飞 preparation；archive 先归档子孙；父 archive/kill 与子 restore/merge 并发不复活、不留活跃 Run） | — | Host 未声明 harnessThreads 时不注册 | D-216–D-224 已接线 owning/execution、执行 Git baseline、查询级固定视图、dispatch 内容身份、branch Integration WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle serialization 与 scope 完整 `..` 段。D-231 已补 retrieval 受管 scratch、持久 managedRoot 与 Host/backend 再授权；旧记录缺根时拒绝自动动作。真实付费嵌套 Pi 与完整桌面重启未测。`nested-threads.test.ts` 中部分 fixture 把 `resolveRuntimeWorkspaceId` 钉成同一个 `"ws"`，这部分不能作为 owning/execution 身份证据 |
| **3.6** 执行预设目录 / 团队提示 | protocol / pi-host / host | ✓ | Partial | `host/presets.test.ts`（hard-implement/frontend 含 nest 工具，review/retrieval 不含 dispatch；retrieval 含 submit_facts / explore，不含 bash/edit/write）；`thread-services.test.ts`（未授权 dispatch 拒绝、binding 无 owner 拒绝、生产 kill cascade、dotted relative scope 接受、retrieval 无 model 拒绝、`carryBlocks: false`）；`workspace-identity.test.ts`（execution workspaceId 下公开 dispatch 仍写入 owning catalog）；`dequeue-permissions.test.ts`（queued dequeue 把 accept-edits 送进 session.create）；`nested-threads.test.ts`（captureScopes 继承父冻结范围）；`protocol/test/permission-gate.test.ts`（缺省 overlay 冻结为 normal；accept-edits 不被 live bypass 放宽） | — | 未配置槽位的预设不出现；无 nest 工具的预设不能嵌套 | D-285 已把必填 role 改为可选 preset 并去掉便宜/强标签，预设 allowlist 保留。D-219 / D-222 / D-223 已接线冻结 overlay、dequeue 生产回调、级联 lifecycle serialization 与 scope 完整 `..` 段。D-227 已把 retrieval 做成事实 Thread；D-231/D-234 补受管输入与耐久证据，见下一行。真实付费嵌套 Pi 会话未测 |
| **3.6 retrieval** 长任务事实检索（D-227 / D-230 / D-231 / D-234） | protocol / host / pi-host | ✓ | Partial（faux 公开纵切与定向反例已接线；真实付费 retrieval 与完整桌面重启未测） | `protocol/test/harness-threads.test.ts`（`thread.facts.set` 方法表、seal 不发明 source-checked、question 用 brief、completion 为 delivered）；`retrieval-evidence.test.ts`（无关 claim 只 source-checked、顺序无关聚合、短 URL receipt、换绑 URL 拒绝、耐久 excerpt、output handle 复制后 dropSession 仍可读、后续磁盘变化不丢当时身份）；`thread-facts.test.ts`（child 校验、settle 去掉建议字段、cancel 保留 facts、lost 保留 pending 且新 Run 清空、deferred-reader settle 与 lost→resume 拒绝旧 submit）；`retrieval-artifacts.test.ts`（重开 catalog 仍可读 excerpt）；`nested-threads.test.ts`（retrieval dispatch 在返回/排队前沿正常 isolated 分支固定父虚拟或物化状态，不回根 live）；`thread-worktree.test.ts` / `materialization-switch.test.ts`（持久 managedRoot、归属拒绝、只读输入物化/回收）；`web-fetch.test.ts`（仅 active retrieval 请求可得耐久 receipt；普通 fetch 不铸 receipt；取消不缓存）；`thread-services.test.ts`（无 model 拒绝）；`select-tools-web.test.ts`（根会话不注册 submit_facts）；`retrieval-session.e2e.test.ts`（父公开 dispatch → 真 child SessionHost → explore/read/related/submit_facts → settle → Zone 2 / wait / read_thread；outside 不进 facts；invented range 不 source-checked；不写盘；不复制父对话） | ✓（配置 `models.retrievalAgent` 后同一 dispatch 路径启用；未配置不注册） | 未配置槽位：角色不出现且 Host 拒绝无 model 的 retrieval dispatch，不借主模型。scope 外/不存在/越界不得标 source-checked。无 bash，故默认不能改工作区 | D-231/D-234 的生产链与定向反例已接，但不得标 Proven。旧 worktree 记录缺 managedRoot 时拒绝自动动作；不把 faux provider 写成真实模型质量。webfetch/websearch 仅 Host 已装配时可用。取消/失联复用既有 Thread 生命周期。不预加载整仓，不新建向量库或 daemon。真实付费 retrieval、完整桌面 Host 重启、授权 web 抓取仅未实测 |
| **3.7** review 传感器 | host / protocol / ui | ✓ | ✓ | `host/review-sensor.test.ts`（关闭/无槽位跳过、hidden + startRun、结果/Run 绑定与去重）；`thread-runtime.test.ts`（显式启用后的 create/start/spawn、迟到旧 Run 丢弃、gate 解除）；`zone2.test.ts`；`harness-settings.test.ts`（默认关闭） | ✓（用户显式启用后） | 未启用不派发；未配置 review 槽且无可用模型时如实跳过 | 触发仍绑定固定发布结果；faux 只证明调用链，不证明审阅质量 |
| **3.8** LSP 导航工具与按来源隔离的语言视图 | protocol / host / pi-host / ui | ✓ | ✓ | `host/lsp/supervisor.test.ts`（视图隔离、Host 单调版本、同修订不重发、`expectedRevision` stale、关标签页不动 agent 视图、LRU 上限与空闲释放；callHierarchy 三方法与按会话 item token、能力缺失报 unsupported）；`host/lsp-nav.test.ts`（真实 fixture 进程下 `surface` 保持 absent、固定草稿、草稿不可用不回退磁盘、`unpinned`、stale 重试一次、一基位置/三态；磁盘绑定结果写回图谱、草稿绑定不写回）；`host/lsp/typescript-smoke.test.ts`（真 TypeScript server：跨文件 references 与双向 callHierarchy）；`diagnostics-adapter.test.ts`（磁盘修订随写入变化、后缀同名不串台、pending）；`knowledge/symbol-runtime.test.ts` / `store.test.ts`（符号行携带 revision、空修订被拒）；`ui/language-id.test.ts`（单一身份表）；`lsp-tools.test.ts`；`thread-runtime-capability.test.ts`（握手能力门） | ✓（Web/Application Host） | Host 不声明 `harnessLspNavigation` 时四个工具不注册；agent 视图惰性起进程、空闲释放，占用可由 `inspectViews()` 查询 | `symbols` 需一个代表文件路径来选择语言 provider；未知后缀明确 unavailable（D-051）。跨文件位置只能标 `unpinned`：LSP 不报告它自读文件的版本，且可用的 Documents mutation 观察不覆盖 Pi 原生写入，因此不做 stale 判定。`explore` 结构展开尚未消费带修订的符号范围；Host 视图占用尚无 UI 呈现。隔离线程因自身 workspaceId 各有一个语言服务器进程，进程复用不在 D-087 范围内。D-240：磁盘绑定的 lsp.references/lsp.definition 结果经 `recordRelations` 写回符号图（D-240），callHierarchy 能力已声明并映射 |
| **3.9** 观察类工具增量视图（`get_output` / `diagnostics`） | protocol / host / pi-host / ui | ✓ | ✓ | `observation-cursors.test.ts`（观察者/类型隔离与清理）；`observation-services.test.ts`（Unicode 字节游标、显式分页不推进、压缩重置、诊断新增/消失）；`shell-supervisor.test.ts`（转后台后继续采集并解析退出）；`harness-e2e.test.ts` #3/#7（完整 bridge 链）；`output-tools.test.ts`；`counter-tracker.test.ts` | ✓ | 显式 offset/length 与 `full: true` 保留全量/随机访问；Host 重启回到全量基线 | 当前游标覆盖 Pi 会话观察者；未来用户面板若直接观察 shell/diagnostics，应使用独立 observer id（D-052） |
| **3.10** session state rail / overlay / discussion threads | ui / host | ✓ | ✓ | `thread-routes.test.ts`（session 权威、鉴权、integration、archive/restore/reclaim/space、整线程 DELETE）；`thread-runtime.test.ts`（同 session 转换、归档及普通 settled 恢复、删除级联；D-248 返工：exclusive lease、阶段化结构化结果、幂等重试、deleteKnowledgeSession、UI 确认文案）；Pi `thread-runtime-session.e2e.test.ts`；`HarnessThreadsPanel.test.ts`（事件与占用投影）；`HarnessThreadsPanel.behavior.test.tsx`（真实 React：等待恢复后用新 Run/cwd 打开、占用失败不打开并显示原因）；`HarnessThreadIntegrationPanel.behavior.test.tsx`；`PiTimelineEntries.renderMode.test.tsx`；`HarnessSessionStateTrigger.test.tsx`；`varinEvents.test.ts` | ✓（工作区持久消息与 session state 有内容时） | Host 无线程运行时时不显示入口；原线程工具仍可操作 | 浏览器完整归档→回收→恢复点击链未跑。rail、overlay 与时间线标记共用一个 session-scoped feed（D-062–D-064）。合并预览见 D-203；归档/占用见 D-204；删除返工见 D-248 |
| **3.11** Harness Fleet provider | pi-host / host | ✓ | ✓ | `varin-harness-adapter.test.ts`；复用 `phase3-e2e.test.ts` 的 Host thread service 链 | ✓（普通会话） | 专用 `threads` / `wait` 工具 | 子会话按冻结的角色工具 allowlist 不注册该 provider；父会话 Zone 2 已走同一 registry 投影 |
| **3b.1** 原生 `tool_call` 唯一权限门 | protocol / pi-host / host | ✓ | ✓ | `permission-gate-extension.test.ts`（Pi builtin、MCP 同名 read、未知 package、规范资源范围 grant、inspect 失败不可记忆、取消即拒绝）；`phase3b-e2e.test.ts`（未知工具不 passthrough）；`host/permission-gate.test.ts`（规则/高风险/merge）；`router.ts` + Host `permission.inspect` 复用 actor/capability/path authority；跨包 type-check/lint | ✓ | unknown / evidence incomplete → ask；Host inspect/path authorization 失败不产生 session grant | 实际来源来自 `getAllTools().sourceInfo`，第三方 annotation/名称不自行授予权限；会话 grant 绑定来源、动作、owning/execution workspace、cwd、规范资源/网络/thread scope；`/varin-permissions` 可撤销；`permission.audit` 只投影无正文/凭据目标（D-283） |
| **3b.2** Smart 权限判断 | pi-host | ✓ | ✓ | `session-e2e.test.ts`（配置槽位后真实模型调用）；`permission-gate-extension.test.ts`（普通完整 ask 可放行；unknown/high-risk/incomplete 不调用 judge；judge 失败回 ask） | 用户选择 Smart 且配置 `permissionJudge` 后 | 无槽位时不可选；模型失败/非 allow 回 ask；高影响和证据不完整走确定性 ask | 不借主模型；Smart 只是在唯一原生 gate 内解析普通 ask，不是第二权限引擎（D-283） |
| **3b.3** 旧 foundational 权限双轨清理 | protocol / pi-host / ui | ✓ | ✓ | `foundational-pi-packages.test.ts`（manifest revision 3 仅 MCP）；source audit：permission-system state bridge、service yield、Plugin Settings/Composer/quick mode/config model/专属 i18n 与共存测试均删除；protocol/pi-host/ui type-check + lint | — | 无旧插件 fallback/双重提示兼容层 | `@gotgenes/pi-permission-system` 不再 foundational，也无 Varin 一等 adapter；用户仍可像普通 Pi package 一样自行安装第三方扩展，但它不能替换/绕过 Varin 原生确认门（D-283；D-044 仅保留为历史） |
| **T4** 可选配对回放记录器 | evaluation / scripts | ✓ | ✗（尚无真实模型配对结果） | `evaluation/harness/cases.json`（6 个历史任务）；`scripts/harness-replay.test.mjs`（commit/ancestor、记录、配对与失败分类） | — | 不运行不产生模型请求/设置变化 | 自动执行尚缺单会话配置；只有实际安排配对时才需要，不再阻塞其他功能或默认启用（D-078） |
| **3.4a** 内容寻址工作分支、草稿基线与结果物化 | host / protocol / pi-host | ✓ | Partial（D-216–D-224 已接线 owning/execution、执行 Git baseline、查询级固定视图、dispatch 内容身份、branch Integration 锁顺序/WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle serialization 与 scope 完整 `..` 段；D-231 又补受管 retrieval scratch、managedRoot 与只读 settle。旧记录缺 managedRoot 时拒绝自动动作，真实付费嵌套 Pi / 完整桌面重启未测） | `working-state/working-state-store.test.ts`（schema 4 trie-only、拒绝旧 schema/平表、draft objects/ref、固定多修订、窄路径与 captureScopes、effectiveState/origin、writeRevision CAS、新文件 mode 不写 `.varin-mode-probe-*`）；`working-state/draft-baseline.test.ts`；`working-state/materializer.test.ts`；`working-state/branch-view.test.ts`；`working-state/working-branch-view.test.ts`（Host router 上的 read/grep/find/ls，lease 后正文与 provenance 一致，explore start pin 后词法/原文/语义不读后写）；`working-state/working-branch-writes.test.ts`（虚拟 write 不碰父盘、兄弟隔离、迟到修订冲突、物化后 publishDirectoryResult）；`working-state/execution-baseline.test.ts`（isolated init 虚拟写+shell 写 settle/merge，无 bad object；reclaim/rematerialize；crash recovery baseline）；`working-state/virtual-write-invariants.test.ts` / `virtual-write-tree.test.ts` / `materialization-switch.test.ts`（失败物化并发写、孙 merge 后再写再物化、writeRevision 标签、树拒绝、semantic pin、abort/crash 恢复）；`working-state/workspace-baseline.test.ts`（Git 变化集与 ignored/captureScopes、unborn/非 Git、字节诚实、取消不建分支、listing 失败不发明完整 inventory、gitlink 列出）；`thread-runtime.test.ts`（surface 释放后的 queued spawn、revision 0、copyIgnored scope、虚拟 spawn 绑定、scratch 回收、bash 预算预占、prepare 后父漂移隔离、Git 失败/捕获窗口变化/writer/gitlink/dirty 内容替换不建完整分支、setWorkingState 失败清理未绑定 branch）；`thread-services.test.ts`（dispatch 必准备、失败删除、baseline-changed 可重试）；`nested-threads.test.ts`（父虚拟分支作孙基线、嵌套 merge 不写根盘、父结果再入工作区、captureScopes 继承父冻结范围）；`working-state/integration-coordinator.test.ts`（虚拟新文件省略 mode 仍可应用到工作区；物化父 directory 不把 recovery objects 写入父目录且 live/reconcile 走 execution Documents gate；无法解析 execution directory 则 needs-attention；branch 集成对账/撤销）；`dequeue-permissions.test.ts`；`knowledge-owning.test.ts`；`thread-registry.test.ts`（binding 重建与 stale 拒绝）；`thread-worktree.test.ts`（fixed/live、virtual scratch、detached Git 上下文、`executionBaseline`）；`workspace-identity.test.ts`；`working-state/path-requirement.test.ts`；pi-host `read-tool.test.ts` / `find-ls-tool.test.ts`（working-branch provenance）；`workspace-mutation-journal.test.ts` / `apply-patch-tool.test.ts`（`document.branchWrite` 优先；Varin Host 的 disk/surface target 都经 `document.surfaceWrite`，pi-host 不保留本地磁盘 fallback） | — | 旧 Git base/resultCommit 是导入来源；带草稿的 Thread 缺原生结果时不走旧合并旁路；shared/none 仍读 live 父目录 | D-239 已接旧结果引用释放 UI、Host 依赖重查与中断对账；当前分支/结果和仍在使用的版本保持保护。D-277 已把生产 baseline/materialization/copy-or-clone/reclaim 后端迁入 kernel；未测文件系统不宣称 CoW 已证明。整个 Thread/当前分支删除 UI 仍按其产品面单独验收。D-220–D-223 已关执行 baseline / 固定视图 / dispatch 内容身份、branch Integration WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle 与 scope segment 反例；D-231 补受管 retrieval 目录和只读 settle。旧记录缺 managedRoot 会拒绝自动动作；真实付费嵌套 Pi 与完整桌面重启未测。物化预算与占用治理见 D-204；显式 copyIgnored 已随 branch 冻结并捕获后续新增/修改/删除；基线读工作目录字节，不把 Git blob 冒充转换后正文 |
| **3.5a** 固定修订 Integration、草稿写回与绑定预览（D-203） | host / protocol / ui | ✓ | ✓ | `integration-coordinator.test.ts`（旧预览拒绝、持久 intent/回执、故障与条件补偿）；`integration-surface-vertical.test.js`（真实 Documents barrier + Registry + Coordinator，磁盘/草稿同一操作合并及撤销，草稿变 clean）；`documents/authority.test.ts`（定向注册、取消与固定来源更新）；UI `documents/registry.test.ts`（实例替换、观察者异常、重试/撤销）；`HarnessThreadIntegrationPanel.behavior.test.tsx`（真实 React 挂载、无请求循环、迟到丢弃、提交审阅绑定）；`thread-routes.test.ts`、Pi `phase3-e2e.test.ts` | ✓（UI 与 agent 共用 Host 定向执行；缓冲不保存） | 不明执行状态保留 needs-attention；不可用缓冲不写盘；失败不等于未写入；旧输入来源不冒充新正文 | 草稿目标支持文本；缓冲无法表达的类型/权限位变化明确 unavailable。完整浏览器点击链未跑；可应用性不代表测试或行为兼容 |

## 阶段 R：Rust 系统内核（D-252，D-282 完成）

R0–R3 的 kernel vertical 已进入真实 Host→Rust 子进程调用链。R1 的生产 WorkingState consumer 已统一使用 immutable root/path 接口，combined Recovery/Integration/agent-mutation 元数据也统一由 Rust typed recovery writer 持久化；D-275 已收口内置 Recovery 的 storage-location 与耐久验收边界。D-276 进一步把 canonical file root、重叠路径 lease、真实文件 capture/apply/rename/remove/mkdir 与 restart reconciliation 接到 Rust file-resource authority；Documents/Files/Recovery/Integration 和 Varin 原生 mutation 走同一后端，Registry 继续拥有未保存 buffer。
D-277 接入了 R3 filesystem capture、immutable-root materialization、目录回收和测量原语。D-278 修复跨 root 租约、重试、GC、路径和实际 owning/execution 装配，并重新打开 R2/R3 验收；D-279 进一步关闭当时留下的两个具体缺口：低层未决文件操作现在由 Host 暴露 identity/disposition/reconcile，native materialization 则用固定 root/writeRevision、同一 operationId、durable handoff pin、Git receipt 与 Registry state 跨重启对账。旧 TS seam 仍只作为测试夹具，不计作 native 证明。

| 里程碑 | 当前交付事实 | 剩余工作与证据要求 |
| --- | --- | --- |
| R0 协议与进程 | **Complete**（production protocol / bounded transport / release identity） | 同源 TS/Rust DTO、framed 私有子进程、epoch/grant、16 MiB 控制帧和握手协商的 2-credit request window 已进入真实 Host。blob chunk 同样逐请求确认；cancel 控制帧不被数据队列阻塞。饱和、queued cancel、截断输入、旧 epoch 排空、干净重启、manifest/build/target/hash、任意 cwd 与 relocated same-format reopen 均有真实 release-kernel 证据。Windows x64 本机实测；其他支持 target 由 release workflow 的 native runner gate 执行 |
| R1 状态与存储 | **Complete**（production authority / consumer cutover / durability semantics） | 当前唯一 catalog 格式为 v10（D-280 新增 process records），握手报告同一版本。Rust 拥有 blob、AVL/Merkle root、branch metadata/revision/pin、result/draft/verification/review、retrieval records、typed recovery operation/file、reference 与 GC；生产 ThreadRuntime/Integration/verification/review/history/materialize/delete 使用 root/path/domain API，combined Recovery/Integration/agent-mutation 以 Rust 为唯一耐久元数据 writer。旧 WorkingState 与 SQLite recovery engine 仅是测试 helper，生产 import graph 不可达。内置 Recovery 与 WorkingState 共用 `<VARIN_DATA_DIR>/kernel/<hostId>`，固定报告 `application-data` / `storageManagement:false`，不独立迁移；replacement provider 仍可实现公开 v5 的可选位置管理。跨平台 packaged smoke 属于 R0/发行 CI，代码签名按现有产品合同可选；物理断电 campaign 不作为 R1 实现完成门槛。D-278 已修复 GC 陈旧清理意图、pending operation/source-root 保留及 ephemeral query pin 跨 epoch 泄漏；核心单 writer 接管保持成立 |
| R2 文件与恢复 | **Complete**（production authority / pending-operation disposition / restart reconciliation） | Documents/Files/Recovery/Integration 与 fs.lock 共用 Rust file authority；D-278 的物理互斥、coverage、owner、重试和真实 Documents 装配修复保持。D-279 新增 `file.operation.list/reconcile`：Host 注册 root 后保留 operationId/kind/path/disposition/reason，可显式重试可证明的安全对账；证据不足的目录 rename 保持 `needs-attention`/retained，不强制重放或猜成功。Registry 仍是 buffer 权威 |
| R3 基线与物化 | **Complete**（fixed baseline / durable materialization handoff / managed lifecycle） | Rust scan/capture/materialize/measure/remove、Git execution metadata 与 writeback 已接入；D-278 的真实 owning/execution、managed-root admission、分页、未收集内容和 readonly 修复保持。D-279 将固定 source root/revision/writeRevision、kernel operationId、persistent handoff pin、Git executionBaseline receipt、Thread Registry 与 execution view 串成可重入 handoff；pin release 成功后才清 intent，失败保留 receipt 供重启重试。setup timeout/abort 只有收到 child `close` 才结束。Windows 只证明实际 copy；未测平台不虚报 CoW |
| R4 进程与终端 | **Complete**（native process authority / production consumers / failure evidence，D-280） | format v10 增加同一 Storage 下的 process records；真实 PTY/pipe、原字节 cursor、stdin sequence/ack、process tree 与 writer 归 Rust。用户 terminal、Harness shell、Thread setup、LSP/DAP、任务、内置 Node 测试与测试 provider 均接同一后端；Host/kernel loss、kill refusal、权限撤销与未确认退出保留 handle/writer，不猜 code 0 或盲重放。Host 产品 startup owner 等异步 spawn/close，不是另一套 PID authority。现有 native CI 执行真实测试；本地只声明 Windows 验证，完整发行/旧分发依赖清理和性能对照仍归 R0/R6 |
| R5 文件与结构计算 | **Complete**（native compute / production consumers / index inputs，D-281） | WorkingState 查询持有 immutable pin，read/search/list/structure/chunks 直接在该 root 上执行；live workspace search/inventory 使用 Host-admitted canonical root，并给每条正文/结构结果绑定 native revision，漂移只返回 partial/failed，不伪造 fixed snapshot。`search.content`、file find、Harness grep/explore、目录/语言目录、symbol graph 与 semantic disk scan 均复用唯一 native compute/file inventory；virtual Thread semantic 只列 pin 内文件并让 native `unitsFixed` 直接切块，不再把整分支正文搬进 TS。2 个 foreground worker + 独立 background lane、bounded record cursor/backpressure、实际 cancel→terminal→release 已验证。surface draft 仍由 Registry 捕获为固定 object overlay；TriviumDB/vector store/embedder/Pi/LSP 产品协议保持原权威。Host `web-tree-sitter` 只保留 grammar 安装 ABI admission，不解析 workspace source；旧 TS ripgrep/recursive scan、branch corpus/body mirror、Host AST/chunker discovery 已从生产链删除 |
| R6 完整收口 | **Complete**（production cleanup / measured structure / release surfaces） | 真实 Web staged release、Windows unpacked Electron、云运行时与其他当时发行布局均携带并校验 kernel；VS Code 条目属于 D-282 历史交付证据，当前 companion 由 D-296 退役。生产包不再携带 `node-pty`、`bun-pty`、`better-sqlite3` authority 或 rebuild probe。emitted Host import graph 会删除不可达旧实现/测试产物并拒绝可达依赖。受控 TS baseline/Rust 测量记录语料、冷/热、事件循环、Host+kernel RSS、节点/写入和取消；没有虚构统一提速倍数。当前态设计、计划、状态、roadmap 与模块文档已统一 |

**D-281 R5 收口证据（2026-09-15，历史交付点）**：Windows release kernel 的 `kernel-compute.test.ts` **10/10** 通过，覆盖 immutable pin 对父 live 漂移、draft/tombstone、scope、UTF-16 column、reader+GC、前台/后台隔离与真实取消、Git ignore + force-tracked、native tree-sitter fixed text / live disk / fixed pin chunks，以及 root replacement 失败；R5 focused consumer 回归 **13 files / 118 tests** 全绿，覆盖 search/routes、Harness grep/explore、WorkingBranch、catalog、symbol graph、semantic disk/thread view。当时完整 `bun run test:kernel` 为 **90/90**，R0/R6 尚未收口；当前结论由 D-282 取代。

**D-282 R0/R6 与阶段 R 收口证据（2026-09-15）**：当前 `bun run test:kernel` 为 **95/95**（Node release child-process 25 + native Vitest 70），新增真实饱和 request window、并行流式上传、取消后 credit 只在 native 回执时释放、截断帧结束旧 epoch 并重开同一 catalog。`smoke-kernel-release.mjs` 从与安装目录无关的 cwd 使用 manifest-verified release binary，覆盖固定 root 搜索/structure、条件文件 apply、真实 exit 7 shell、Host+kernel 重启、新 epoch、复制到新安装目录后重开同一数据、坏 manifest 拒绝和目录句柄释放。VS Code packaged native search **2/2**、真实 Rust/Registry disk+surface Integration **1/1**、Document Registry dispose/journal **29/29**、emitted production graph audit **7/7** 通过。Windows unpacked Electron smoke 从实际 `resources/kernel` 启动，返回 Host health、builtin recovery、native semantic/structure 与 terminal create/close；stderr 为 0，日志未出现 authority fallback。发行边界扫描记录 **385** 个可达 runtime module、移除 **52** 个旧/test artifact、禁止引用 **0**。

`scripts/measure-kernel.mjs` 在相同机器、相同 128/1024/4096 文件与字节哈希上，对 D-280 后/R5 前的 TS 产品路径和当前 Rust 产品路径各做 1 次首调、2 次 warmup、8 次热样本。Rust warm p50：inventory **9.073/20.914/77.911 ms**，content search **45.696/278.325/1166.156 ms**，单文件 structure **35.939/37.346/51.432 ms**；TS baseline 分别为 **1.318/7.210/23.862 ms**、**192.042/435.825/1229.434 ms**、**20.887/22.502/22.304 ms**。结论是三档语料的搜索均改善（4096 文件差距较小），枚举与逐文件结构解析有明确额外成本但没有随语料失控。Rust startup 为 **135–138 ms**；固定 root 单路径写 p50 **4.005/4.484/4.540 ms**，只新增 **12/15/17** 个 trie 节点；后台结果队列被背压时前台固定读取 p50 约 **11 ms**，取消至 terminal+release 为 **13.919/18.321/22.373 ms**。Rust 路径事件循环 p95 约 **11–12 ms**。Host+kernel 分阶段 RSS 与 baseline Host RSS 均被记录，但 baseline 的短命 rg 子进程未计入、采样不是峰值，所以不据此宣称内存胜负或统一倍数。

**R0/R1 返工证据（2026-09-13，D-256）**：`packages/web/application-host/lib/kernel/kernel-client.test.ts` 通过真实
release `varin-kernel` 子进程覆盖固定 revision 不漂移、pin 保留到显式 unpin、GC、finish 失败回滚/同 operationId 重试、
typed path/tree 不变量、grant workspace/path scope 与 revoke、8,000-entry 构建取消、200,000-byte 分块上传、deep health、
关闭重开与字节/hash 保持；GC 的逻辑释放、实际文件删除和注入的清理失败分别可观察，失败在重启时重试。`cargo check --manifest-path kernel/Cargo.toml` 与 Windows release build 通过（本机通过
Visual Studio Build Tools 环境注入 Windows SDK；普通 shell 若未加载 SDK 会报告环境缺失）。

**D-259/D-260/D-262/D-263 历史 consumer 证据（2026-09-13；当前边界由 D-265 取代）**：当时的 release child-process 测试为 **14/14 通过**，新增
typed `storage.record.*`、record-bound blob read、空根分页边界和 owner/reference release；独立 Host adapter 纵切经
`KernelStorageAdapter` 完成 capture → branch create → virtual CAS write → publish result → kernel object read，重建/释放
使用当时的 v6 catalog。生产装配切换位置是 `application-host/index.ts` 的 `createKernelWorkspaceWorkingStateAccess`；Recovery
checkpoint/turn/mutation 通过 direct kernel record path 持久化；workspace composite record identity 和错误 actor 拒绝已由 release child-process test 覆盖。当时 combined operation/operation-file 尚未 direct typed cutover，因此该历史切片仍记 Partial；后续 D-274/D-275 已取代这一验收状态。
Kernel protocol 使用 `kernel/protocol/schema.json` → generated TS DTO，Host 在 `application-host/index.ts` 启动/停止同一 client；
Electron package 将可执行文件和 SHA-256 manifest 放在 `resources/kernel`（asar 外），after-pack 会核对 manifest；Web package 将其放在 `kernel/`。这些是本机/构建链证据，不是
macOS/Linux 真机运行或完整跨平台签名证据。

另有一次临时 `startWebUiServer({ port: 0, requirePiRuntime: false, apiOnly: true })` smoke：真实 Web/Application Host
打印监听端口、完成 kernel 子进程启动后按 `stop()` 正常关闭；该 smoke 的 `ready:false` 只表示刻意关闭 Pi warmup，不表示 kernel 未就绪。

早期 release kernel 取样记录过 128/1024/4096 条目下的 AVL 节点数、调用墙钟和单次进程内存快照；这些只证明当时的
单路径更新没有复制完整兄弟集合。D-258 已确认其中 `length(TEXT)` 不是持久写入字节，原 payload 数字撤回；启动/缓存未控制的
墙钟与 RSS 也不作为性能结论。受控端到端对照仍按 R6 执行。

**R1 当前责任边界（D-274 实现边界；D-275 验收收口）**：Rust kernel storage root 是 WorkingState 与 recovery 元数据的唯一生产 writer。生产 branch read/write、explore pin、result/draft、verification/review、retrieval、history、materialize/delete、Integration 与 agent mutation 全部通过异步 root/path/domain/recovery API；不再展开持久全树，也不再打开 TS recovery SQLite。`working-state-store.ts` 和 local SQLite recovery engine 只服务测试夹具，不能被生产装配导入。

固定 draft 是独立 branch/revision/root；result、verification 与 review 绑定明确 branch/revision/root。scope 在 Rust 遍历前生效，pin/diff/blob read 核对来源；result release 原子释放相关记录与 revision，独立 pin 继续保留 root。branch metadata 随 branch create 同事务发布，重复相同 blob 不覆盖已有 transient owner。combined 文件操作在 Rust phase/terminal CAS 完成后才执行或返回；导航回执丢失时重启复用同 operationId，而不是补偿文件后留下会话/磁盘分裂。

**D-274 定向证据（2026-09-14）**：真实 Windows release kernel tests 覆盖 fixed revision/pin/scope、typed record 拒绝、result release/GC、branch metadata 幂等与重复对象 owner；`storage-adapter.test.ts` 覆盖真实 branch/root 与 durable operation，`kernel-durable-engine.test.ts` 覆盖 combined recovery 重启、导航回执丢失、undo 且不创建 legacy catalog；surface/authority 定向测试覆盖 Rust durable CAS 先于 Documents 副作用。

**D-275 R1 收口证据（2026-09-14）**：内置 recovery 明确使用 Application Host kernel storage root，真实 kernel-backed facade 报告 `application-data` / `storageManagement:false`，独立 location mutation 返回 `unavailable`；Recovery UI 只在 provider 声明 `storageManagement:true` 时显示 location/migration 控件。Rust 对象安装先 flush staging，再 durable rename、目标文件 flush、目录同步后发布 SQLite 引用；已有 operation finish rollback/retry、typed recovery transaction fault injection、GC cleanup failure 跨重启重试和 terminal response 丢失后按 operation identity 对账。由此 R1 按可执行的 state/storage/durability 契约标为 Complete；R0 平台发行证据及 R2–R6 不随之提前完成。

**D-276 R2 收口证据（2026-09-14）**：真实 Windows release kernel child-process suite **23/23** 通过，其中新增 file root/lease、scope/路径逃逸、conditional apply、stale CAS、`operation_finish` 失败后重启对账和生产 `fs.lock`→Rust lease 竞争；真实 `kernel-durable-engine.test.ts` 覆盖 combined Recovery 文件恢复、导航响应丢失、kernel restart 与 undo。Documents/surface/Files/Workspace/external focused suite **106/106** 通过；pi-host `workspace-mutation-journal` + `apply-patch` **18/18** 证明 Varin 模式不再退回 worker 本地磁盘 writer。Application Host type-check 与 pi-host source build 通过。`integration-coordinator.test.ts` 仍有 17 个直接依赖旧 SQLite test-helper 的失败，但在未含 R2 改动的 `ad71ea78` 独立 worktree 上同样是 **17 fail / 20 pass**，因此不作为 R2 新回归证据，也不据此恢复生产 TS writer。

**D-279 R2/R3 复核收口证据（2026-09-14）**：统一 `bun run test:kernel` **57 passed**：真实 release kernel child-process **25/25**（其中 persistent current-root handoff pin 跨 Host restart 仍可读且由 maintenance 显式释放）、`file-resource-audit.test.ts` **26/26**（覆盖未决目录 rename 在重启后以 operationId/path/reason/disposition 可见、显式 reconcile 仍不猜成功）、`storage-adapter.test.ts` **5/5**、`kernel-durable-engine.test.ts` **1/1**。IntegrationCoordinator 已从 D-278 时点的 17 fail 迁到 production `journal-engine` + durable port 语义，完整 **37/37** 通过，覆盖 terminal CAS 失败补偿、operationId 复用、active parent-turn `thread.merge` checkpoint binding 和 materialized branch undo/restart。ThreadRuntime/ThreadWorktree **91 passed / 1 platform skip**，新增 git-attached handoff pin release 失败保留 Registry receipt、重试完成，以及 Git baseline attach 幂等和 setup 等真实 child close。Application Host source/test type-check、kernel protocol drift、release build 与 `git diff --check` 通过。由此 D-278 重新打开的 R2/R3 两项具体 gate 均关闭；R0 与 R4–R6 不随之完成。

**D-266 源码责任边界（2026-09-13）**：原 6483 行 `varin-kernel/src/main.rs` 已缩为启动入口；crate 装配进入
`lib.rs`，transport/admission 留在 `runtime.rs`，唯一 `Storage` 的 core/operation/authority/object/tree/branch/recovery/record/
GC/health/dispatch 实现拆入 `storage/`。Windows release build、Rust workspace tests 与既有真实 child-process 反例用于证明此次
移动没有改变协议或持久行为。本条是当时的可维护性收口，不改变该时点 R0/R1 Partial 和 R2–R6 未完成状态；当前 R1 状态由 D-275 取代。

**R0/R1 历史验收边界（D-258，2026-09-13；当前由 D-265 取代）**：D-257 的 64-envelope queue、hash-only blob read、可选 publish CAS、
format v5 与 object attachment 表述已由本条取代。

- request/response 各只有一个待交接 envelope；blob、branch create 和 branch write 的总输入都不塞进单个控制帧。Host 在 stdin drain
  期间取消也不会产生未处理 Promise rejection；begin 使用 Host 已知的 stream/builder ID，取消或响应丢失仍能定向 abort。正常 shutdown
  会释放最后一个 response sender 并等待真实子进程退出，不再固定等五秒强杀。
- `storage.getBlob` 只接受 branch+path(+revision)、pin+path 或当前 grant 的临时 owner 来源；Rust 同时核对来源 root 上该路径确实指向
  请求 hash。临时 owner 按 upload operation 一对一返回，entry/change 只消费明确携带的 owner；相同 blob 的另一 owner 不受影响。
  branch entry/change 复用已有正文时还须绑定同路径或授权的 `sourcePath`，不能用 workspace 内任意 hash 搬运 scope 外正文。
  completed operation 提供显式 release，不能用 GC 猜测产品仍需多久保留幂等记录。
- publish 的 expected writeRevision/root 都是协议必填；dirty head 与最后发布 revision 是两个合法身份，deep health 不再要求二者相等。
  recovery root 引用只保留 initial/current 两端或显式 release，不累积每个中间状态。
- D-258 当时的唯一新格式是 v6；D-265 已直接替换为 v8。打开已有库时核对 user version、schema fingerprint、表、索引和每列；缺失 authority 表的同版本库会失败且保持
  缺失，旧 v5/future 格式同样拒绝，不存在补表、迁移、dual-read 或 fallback。
- `kernel/protocol/schema.json` 同时生成 TS 和 Rust DTO，`--check` 校验两端；malformed revoke 在 admission 产生取消副作用前必须通过完整
  envelope/params/epoch 校验。Application Host build identity 必须等于编译期 kernel identity。构建从 PE/ELF/Mach-O 正文读取真实架构，
  Electron after-pack 再核对 binary、manifest 和目标，不接受仅改标签的 cross-arch 产物。
- 对象使用流式 SHA-256，范围读取不把整文件载入内存；对象安装先 flush 内容，Windows 用 write-through rename，Unix 另同步 staging、
  shard 与新 shard 的父目录项，再由 SQLite FULL 事务发布引用。硬断电仍未注入，不能据此写成跨平台 proven。

D-258 时点的生产接线仍是 Application Host 启动并管理 kernel；`Thread/Run` catalog 仍由 TS、未保存缓冲仍由 Document Registry、Pi session/model/credential 仍由 Pi、知识/向量仍由 TriviumDB/adapter。该时点 WorkingState root/path 与 retrieval/turn/checkpoint/mutation 已走 kernel，但 combined Recovery/operation-file、Integration durable journal 和 agent-mutation 仍写 TS recovery SQLite；后续 D-274/D-275 已完成该 R1 cutover，D-276 又完成 R2 file-resource authority。本段仅保留 D-258 历史边界，不描述当前实现。

D-257 的 `nodePayloadBytes` 使用 SQLite `length(TEXT)`，不是实际持久写放大，该字节结论撤回。当前 health 分列 node JSON 的 UTF-8
bytes、catalog 文件和 WAL 文件大小，并暴露 operation/temporary owner 数；尚未据此重做受控性能对照。128/1024/4096 条目下的
节点数与单路径墙钟只保留为结构线索，不外推为磁盘字节、提速倍数、硬配额或跨平台结论。

同一路径的 4096-entry 空 `baseRef` fork 返回相同 root，节点数 4101→4101；这是 root identity/SQLite 计数证据，不是把整树展开后再比较的 helper 统计。

**D-280 R4 本机验收（2026-09-14）**：正确 app build identity 的 Windows release kernel 下，统一 `bun run test:kernel` **80 passed**：Node kernel-client 25、file audit 26、storage adapter 5、combined recovery 1、native process 16、真实消费者/身份 7。原生用例覆盖 binary pipes/stdout+stderr、输入去重、3 MiB 输出在 1 MiB 背压边界下完整读取、12 次连续 PTY/resize/final-output/exit、cwd/actor/lease/revoke、自然退出清子孙、kill refusal、kernel restart 不重放、真实 Host 进程退出和 terminal/shell loss 无假成功。消费者使用实际 LSP/DAP/Node-test/task 进程；Thread 目录在 Documents enrollment 前后分别保持合法 owning/execution 身份且拒绝未保留 sibling。Shell/Terminal/LSP/Run/Thread/verification/output focused **233 passed / 1 Windows symlink skip**；这些包含明确 unit seams，不冒充全部是 native 证明。

另一次临时真实 `startWebUiServer` smoke 在显式授权的独立工作区，通过 HTTP terminal create → native process inspection → DELETE/confirmed close → awaited Host stop/fixture cleanup；关闭 Pi warmup，无付费模型、无完整 Electron/browser 或 remote release CI 声明。fixture 完成后显式退出 Node，不以该 smoke 证明所有 incidental timer 均自动清空。过程中的未授权目录请求正确返回 400，没有通过放宽权限修复夹具。

## 当前缺口与后续顺序

**D-284上下文阶段已完成（keeper/takeover 已删除，见矩阵 2.4A/B、2.6A/B）。当前主线是D-285任务线程与D-286的
线程侧消费（3.18A–D已落地，E收口待实施），随后推进外部runtime / research profile。** 顺序见plan3.18A–E。
本轮核对的决定性入口：

- `context` hook 已在每次真实请求前（含回合内继续）做预算检查；摘要请求沿同一 ModelRuntime 派生，保留真实
  system prompt 与 schema-only 工具，`toolChoice:none`、无执行器；候选固定 entry/分支/模型/边界与 firstKeptEntryId。
- Zone 2 已是尾部追加；`compaction.after` 只在真实 `session_compact` 后清观察游标，候选准备/ready 不重置。
  计划/用户笔记/accepted knowledge 保留在 Host block store，不再按 memory 名称隐藏。
- 未取得新方案的真实摘要耗时、缓存命中或首次续接延迟；75% 准备水位与 60% 压缩后目标是已明确的首版工程默认，不是测量结论。

D-285现状对照（3.18E收口后）：`harness-presets.ts`绑定模型/工具/worktree，`thread-tools.ts`的dispatch只须`task`、
`preset`/`input`可选，`send`带`kind`/`context`/`requestId`/`replyTo`/`to`；Run已写入frozen配置（含全部四类inputOrigin）；`harness-settings.ts`
默认自动review关闭。`thread-runtime.ts`的`captureInputContext`把父会话已提交摘要+边界后原文渲染为有界继承上下文，
`continueRun`对settled线程按`continue`/`fresh`分路（重开保留会话 vs 新会话+`assembleFreshInput`输入），名额满时把
`pendingContinuation`停在Thread上由dequeue提升、held消息折进新Run输入；`thread-services.ts`的send服务按关系授权
（子/父/同根兄弟），`inform`对运行中目标投递、对settled/排队目标held停放，`request`唤醒等待或对settled续做，
`replyTo`解析双账本并解除`waitingFor:"thread"`。`thread-registry.ts`执行准入按`countActiveInRoot`同根统计，
`waitingFor:"thread"`让出名额，`setAttention`/`endRun`触发`tryDequeue`（按`pendingContinuation.at`/`createdAt` FIFO），
`onAdmissionFreed`驱动lost恢复复查；wait服务对Thread调用方先标记依赖等待后订阅、返回时按边界flush并重新准入。
startRun自身仍不做准入判断——准入统一在dispatch/dequeue/continueRun/resumeLost层，与3.18C设计一致。

**3.15 A–D 已接入生产调用链（D-176–D-189）。** 公开入口仍是 pi-host `explore`。Host 持有短生命周期查询：开始时固定问题、
范围与 `inputContext`，原问题词法/图/语义与计划模型并行；新表达真正执行搜索；候选模型看到最终挑选前的当前单元；Host
校验后提取原文。未配置或模型失败保留算法/向量材料并标明未参与，不回退主模型。retrieval 与扩散模型仍按后续项，不是本行前置。

**D-236 目录观察（2026-09-12）。** `bun run --cwd packages/web symbol-graph-query` 在本机对测量时的 2520 个 tracked
TS/TSX/JS/JSX 文件调用生产 `scanWorkspace`、tree-sitter 和 TriviumDB；枚举为 `git ls-files`，Documents 端口用磁盘读取/正文哈希适配，
没有启动完整桌面。冷建 **185767.1 ms**，显式未变重扫 **10314.095 ms**。两次扫描共读 **7560** 次，outline/imports/literalCalls
各 **2520** 个请求，第二次没有结构采集；不是实际 parser 缓存命中的埋点。产物 **2520 files / 26295 symbols / 14681 active links**，
合计 **43496 nodes**，readFailed/runtimeErrors 均为 0。热查询单次 searchSymbols/findLinks/findImporters 为 8.242/0.653/166.327 ms。
未做同语料的改前受控测量，不把 D-140/D-141 的历史仓库耗时用于提速百分比，也不把符号目录数字用于嵌入索引。
`catalog-scan.test.ts` / `symbol-runtime.test.ts` 8 项与 `store.test.ts` 44 项通过；包含取消保留旧图、候选重开后补关系、连接正文移除/恢复，
该轮不包含无事件外部删除旧路径的对账；后续 D-237 已补，fs/search、catalog-scan、store、symbol-runtime 共 67 项定向通过。脚本已去掉固定 `revisitCount: 0` 和把 outline 请求数叫作 `parsedFileCount` 的字段。

**3.16B–E 的身份/配置/取消与异步发布边界已按 D-194–D-195 / D-235 纠正，共用生产装配与原生写入通知已有公开工具证据。** Settings
`harness.embedding` / `harness.rerank` 仍是用户所有配置种类；Pi 后台 provider 定义只取 user/operator 层，项目 provider 继续只影响
普通聊天。Application Host 按 workspace 保存 cwd/settings/backend/runtime，共享的只有本地 MiniLM、调度器和完整 space 身份下的
数值缓存。远程方法与 cancel 只在内部 HostMethod；公开 Runtime surface 不能调用。空间身份使用去凭据的实际 endpoint/API、最终维度
及 embedding 参数，配置变化启动该 workspace 新扫描。活跃 isolated child 改查自己的 Documents workspace，不再把父 WorkingState
整表当语义语料；仍为 virtual 时必须取得固定 WorkingBranch 视图。增量写入在读取正文前沿冷扫的文件筛选，`copyIgnored` 不自动扩大语义语料。原生 Pi journal after 在工具答复前通知同一索引，不等待 settle。rerank 使用同身份原文视图，重复及并发 finish 共用一次判断，取消可到 Pi fetch。

**本轮接线证据与未验证项。**

- 定向证据：protocol 覆盖 missing/invalid 与 public method 排除；pi-host `background-inference.test.ts` 覆盖项目 provider
  重定向不能取得用户 key、完整 binding 竞态、endpoint/credential space 与 cancel 到 faux fetch；Host
  `workspace-inference.test.ts` 覆盖双 workspace 交错、取消丢弃迟到结果及 missing/invalid/unavailable；`semantic/runtime.test.ts` 覆盖旧发布不解除新编辑遮蔽、读失败/恢复、旧目录清单不删新变更、空目录重启清旧向量、查询固定 backend、范围内草稿和后台建设；
  `fs/search.test.ts` 用真实 Git 覆盖 ignored 与强制 tracked 文件的增量筛选；`host-controller.test.ts` 用真实 controller/transport 覆盖排队取消、重复批次与畸形请求清理；finish 测试覆盖异步 Settings 判断预留、并发及重复终态、partial score 和 malformed 降级；UI 测试覆盖隐藏字段 round-trip。
- D-235 新增 `semantic-workspace.e2e.test.ts`：公开 `explore` → Host Router/Services → `index.ts` 同一 `WorkspaceSemanticRuntime`
  → 真实 SessionHost 的 Settings/BackgroundInferenceRuntime → faux HTTP embedding/rerank → 真实 Documents 与代际向量库。
  两个执行目录分别路由到对应 SessionHost，源码/查询请求与各自凭据相符；纯语义夹具没有词法命中。真实 Pi `write` 的 after
  经 recovery coordinator 先通知、后答复；后台发布后，同一次 Pi prompt 的下一次 `explore` 返回新正文/修订，早于 recovery turn settled。
  未配置、无效绑定、远程失败分别核对绑定状态、来源状态与实际远程请求，不能只比较带随机 ID 的文本。3 项通过。
- `workspace-runtime.test.ts` 的 6 项覆盖 virtual pin 不可用、退休 worker 的迟到绑定、配置刷新、订阅恢复、Settings 等待取消与
  关闭后的迟到 watch 清理。相关 runtime / workspace-inference 合计 20 项通过。
- 上述夹具复用生产装配模块，但 workspace broker 的转发与配置 watch 是本地适配；不等于完整桌面启动、实际 broker 进程重启，
  也没有跑 nested dispatch → 物化 → child SessionHost 的整条链。真实 embedding/rerank provider 的延迟、质量与完整向量冷扫仍未观察。
  旧 `session-e2e.test.ts` 的手工 remote consumer 证据范围保持原标注。
- 3.16A 已在此前提交：`37b12e8e`（本地 embedder 运行时）、`8752e039`（语义索引/打包）。D-175 设计正文提交为 `88ca06e5`，
  当时尚未改变运行行为。

**已交付的基础。** D-082–D-089 的窗口来源、草稿失效/写入边界和语言视图，3.11 的结构来源，3.12 的图读者，以及 3.13/3.14
的查询与呈现修复保持。旧 3.15①②④ 的到达理由、文件角色和 focusRanges/三字段接口已由 D-163–D-165 接线；D-166–D-172
已接本地 MiniLM、独立语义代际库、部分可查与 explore 消费者，并首次验证真实模型的局部词汇缺口。十问的旧观察保留在下表，
不是全仓语义质量证据；D-171 起位次来自渲染正文，不能与更早的 snippets 数组下标直接比较。

**3.16A 已提交的性能/发行证据（`37b12e8e` + `8752e039`，不是本轮）。**

- 真实数组批推理；切块尺寸查找避免逐行/逐字符重复缩短；语义存储使用增量计数、批量发布与合并检查点，恢复中断留下的 WAL。
  这些改动在 `semantic/{minilm,chunker,runtime,store}.ts`。按实际编码文本复用与前台优先已由 3.16C 接线。
- 当时模型 recipe 固定上游修订，构建自动准备发行包，after-pack 校验模型/运行时文件；Windows unpacked smoke 从实际
  `app.asar.unpacked` 模块加载 Host、MiniLM、ONNX，零词汇重合夹具命中排名 1，status/coverage/lifecycle 为 ready/complete/ready。
  这是历史夹具与打包链的证据，不是全仓召回结果。D-288 已改为独立可选组件，当前基础包 smoke 验证未安装时正常启动，显式导入组件后再验证可用状态。
- [存储探针](../packages/web/scripts/semantic-store-perf.ts)：3000 文档、真实 TriviumDB、假 embedder，旧实现总计 11.26 s，
  改后逐文档 6.56 s、8 文档一批 1.15 s。仅说明存储路径，不包含真实推理速度。
  [局部扫描探针](../packages/web/scripts/semantic-scan-perf.ts)：40 个 knowledge 文件、真实 MiniLM、621 块，首批发布 6.06 s，
  扫描 34.77 s；首批发布不是首个有用查询结果。旧全仓扫描人工中断，恢复后有 439 文档/8191 块，完整冷扫时间未量得。

**已核对的当前缺口。**

| 范围 | 当前代码事实 | 对应实施 |
| --- | --- | --- |
| LLM 局部语义决策 | 公开 `explore` 经 `models.explore` 调用计划/选段/可选补查；描述已写概念与标识映射 | 3.15D 已接线；真实模型效果未观察 |
| 多阶段查询 | Host 查询上下文 + `explore.query.*`；后续阶段沿用 start 来源；`harness.cancel` 传到查询与模型 | 3.15 共同上下文已接线 |
| 开放候选排序 | 已取消 `candidateTier`；开放候选按真实来源名次 RRF | 3.15A 已接线 |
| 当前单元与呈现 | 模型看挑选前视图；已删 `windowScore`；必需范围原子保留 | 3.15B 已接线 |
| 查询调度 | 到达即读；在飞主任务保留首批机会；共享截止可提前冻结 | 3.15C 已接线 |
| embedding/rerank 配置 | Settings 独立 Embedding / Rerank 段；workspace 不能改绑；不从 chat model id 推断能力 | 3.16B/E 与知识库 2.8 已接线，知识建设生命周期见 D-198 |
| 后台远程调用 | 隔离的 user/operator-only provider runtime + 用户 AuthStorage；Host 只提交已授权正文与冻结绑定 | D-194 已接线；真实 provider 未观察 |
| 复用、切块与推理调度 | space+purpose+embedText 复用；续切；前台优先；Node ORT session 线程；软预算缓存 | 3.16C 已接线；完整冷扫未量得 |
| 语义草稿/线程视图 | 查询开始 pin；草稿立即遮蔽并异步向量；物化 child 查自身 Documents workspace | D-235 已测独立执行工作区 SessionHost 的公开工具和同回合写后查询；完整 dispatch/桌面链未测 |
| 专用 rerank | HTTP `/rerank`；与 LLM select 互斥；失败保留来源排名 | 3.16E 已接线；真实 rerank 质量未观察 |

按 plan 0.7：3.15 A–D、3.16B–E、2.8、3.17 与 D-227 retrieval Thread 已接线。D-252 将当前返工验收后的
主线确定为阶段 R；真实 provider 观察保留为独立未测项，扩散/后训练不是下一步实现任务。
既有工作区范围和正文覆盖目标保留，活动工作集只改变建设优先级；没有采纳 sketch 替代全文或只索引热点的设计。

以下保留其他能力及历史检索阶段的验证记录；当前检索取舍以上述 2.8 / 3.15 / 3.16 行与 D-173–D-198 为准。

| 范围 | 已确认现状 / 待做 | 验证与外部边界 |
| --- | --- | --- |
| 2.4 记忆写入与模式（历史，D-284 已删除） | keeper 生产路径已移除。block store 本身保留：source leaf 修订、活动祖先路径按 label 解析最近值、后代 copy-on-write、删除写 tombstone、create/update/delete 原子 CAS 仍是 plans/todos/用户笔记/accepted knowledge 的存储语义 | 历史证据：`memory-agent.test.ts` 分支/CAS、`memory-agent-extension.test.ts` 与 `phase2-e2e.test.ts` 曾覆盖动态模式与注入边界，文件已随路径删除 |
| 2.6 覆盖与证据（历史，D-284 已删除） | coverage 接管已移除。现行语义：候选绑定 epoch/分支/模型/压缩边界/firstKeptEntryId，失效丢弃；压缩由 Pi 触发，`compaction.after` 在真实 `session_compact` 后重置观察基线 | 历史证据：`compaction-extension.test.ts`、`compaction.test.ts` 曾覆盖缺口/错分支/修订漂移/重启；现行证据见矩阵 2.4A/B、2.6A/B |
| 3.9 / 线程观察 | 已实现并接线到 worker 送达边界：observation 使用单调 revision CAS；pending 跨 clear 失效；Router success commit / failure abort；shell、diagnostics、Zone 2 threads、thread list/wait 延迟推进，线程游标按 eventSeq 防倒退 | cursor/router/phase3 focused tests 已覆盖并发、固定时钟、clear、响应失败与增量行为。确认只到 pi-host 响应，不宣称 tool result 已耐久落盘；更强 acknowledgement 仍待独立纵切 |
| 窗口读取 / 3.2 | UI 输入自动捕获该 surface 全部 dirty records；正文只经 Documents 鉴权通道进入 Host 内容寻址内存 snapshot，runtime/Harness 传 ref。输入接受后 active、失败 release、下一成功来源替换、session drop 清理。explore/grep/read 直接读取固定草稿；find/ls 取得相对请求根的固定文件与虚拟祖先，并经 Pi 原生定义合并磁盘枚举；thread.dispatch 在请求内把保存字节和来源修订复制进持久 WorkingState。无 dirty 或不相关 root 走 disk，相关 capture unavailable 禁止磁盘回退 | `authority.test.ts`、`authority-surface-identity.test.ts`、`surface-mutation.test.ts`、`routes.test.ts`、`explore-service.test.ts`、`search-service.test.ts`、`document-read-source.test.ts`、`document-path-overlay.test.ts`、pi-host `read-tool.test.ts` / `find-ls-tool.test.ts` / `workspace-mutation-journal.test.ts` / `apply-patch-tool.test.ts`、`usePiSessionStore.test.ts`、`thread-services.test.ts`、`thread-runtime.test.ts`、`session-e2e.test.ts`。Host 重启后未消费 ref 过期，已创建 Thread 不受影响；agent 的 `lsp.*` 已按同一固定来源绑定并回报 revision/source，符号图只绑磁盘 revision（D-087）。观察到磁盘写入后该路径草稿失效、read/grep/explore/find/ls/LSP/dispatch 一起回到磁盘，journal 那条在确认工具前 await；`index.ts` 把 `observeToolWrite` 接到 `observeAgentWrite` 的那一行只有类型检查，没有跨 broker 的 e2e；shell 与外部进程写入未观察（与恢复日志同一边界）。根会话 `edit` / `write` / `apply_patch` 对仍由本轮 snapshot 拥有的路径经 `document.surfaceWrite` 写回同一 Registry 缓冲（D-225 / D-228），匹配用固定正文，`bufferHash` 只对规范化编辑器身份；成功后同一回合 read/edit 看到新缓冲；用户继续编辑为 conflict，不写盘、不隐式保存。普通磁盘路径仍走 mutation journal。混合 surface/disk 写入在第一笔写前记 `agent-mutation`，返回 per-path applied/conflict/compensated/needs-attention。`apply_patch` 在 `readSource` 非 disk 时停止。真 Pi faux-provider 纵切证明公开 `edit` → Host → Documents `requestSurfaceOperation` → Registry 完成回执，不是只调 helper。未测完整桌面 Registry 手工编辑、Host 进程重启对账与真实付费模型 |
| 查询内区分度 / 3.14 检查点三 | 同一张查询内权重表进入局部选择与打包（D-155）。`full-object` 只给对象/锚点；内容词原词命中是 `lexical`。已读正文按原词补种窗口，同组远距命中各算一簇。打包看自身加权覆盖、相对已选（含同文件）新增词组价值、正文成本；换文件不再是奖励。入口窗口已占住的词组，同文件尚未选中的函数/方法仍算本地互补。定位题已有直接答案时 `offTopic` 不展开、不进包（D-156）。设计 6.1 改为：无法判定无关 ≠ 已经证明有关。十问对照（`--skip-scan`）：1 满足（`harness-services.ts` register 可见 #3）；9 满足（request #1、register #3）；V1–V5 满足。6：`parseDocument` 可见 #2。4：`capabilitiesFromSpec` 可见 #16。5：classify 可见 #15；write 已读，匹配窗口从未生成；`self:` 占 3 个可见槽（rg 排除后仍被反向 import 拉回）。7：`document.writeGuard` 窗口已生成 501-522，未选中；inspect 仍读预算。3：supersede 可见 #1；8：reclaim 可见 #2。2 仍读预算（未核验 connects 占 tier 1）。10 仍 `not acquired`。**验收修正**（D-157）：问题 1 首条曾是测试夹具、生产注册退到 #3，`relationRoleRank` 接线后恢复为请求端 / 生产注册 / 夹具，register 回到 #2；问题 5 的 write 实为「`unit loadGraphFacts 147-238` 已选中，`links.push` 在第 220 行落进 `unit.omitted` 的 220-238」，不是窗口未生成；问题 4/6 的翻转已用服务返回的 `text` 复核，不只是数组位次。大单元正文组装是命中驱动的，没有查询词匹配的行进不了正文——加权修不了，留下一轮。不声称质量或速度提升。 | `explore.test.ts` 检查点三组（内容词窗口不得是 full-object——无修复时为 full-object；同文件两段互补块、同文件实现函数压过只重复已覆盖词的第二文件——均先红后绿，真解析器；已读正文补种被 rg 丢掉的内容词；定位题有答案后 offTopic 不再进池）。D-152 已读证据重算与 3.13 入口守卫仍绿。十问观察是观察不是评测。 |
| 查询内区分度 / 3.14 检查点二 | 同 tier 主比较改为加权覆盖 \(L(f)\)（D-154）：`tier → L(f) → roleFit → 路径`。`roleFit` 数值表仍在，只作有界偏好。how 问句不再因摘录包已满停读；`maxMaterializeReads` 数值未改。十问对照（`--skip-scan`，脚本已自排除，与检查点一同一测量污染说明）：1 满足（register 可见 #2）；9 满足（request #1、register #3）；V1–V5 满足。3：`surface-snapshot-store` 的 supersede 可见 #15，`authority` 的 observeWrite 仍读预算。5：`connections.ts` 的 classify 可见 #6；`symbol-runtime.ts` 已读，匹配窗口从未生成。7：`register("document.writeGuard")` 可见 #7，inspect 仍读预算。8：`thread-worktree.ts` reclaim 可见 #3。2：`explore.ts` 已进池，仍 `not-requested: read budget`——17 条未核验 `connects` 占 tier 1，吃掉未改的读预算。10：目标仍 `not acquired`（截断词法池里没有 `explore.ts`）。4：可见 #6，匹配窗口从未生成。6：匹配窗口已生成 291-412，未选中。不声称质量或速度提升。 | `explore.test.ts`：两稀有内容词压过堆泛词；弱源码不再凭 roleFit 墙压过更强清单；摘录包已满仍读同权第四个文件（先把停止条件退回检查点一形状证明会红，再接线）。3.13 入口守卫仍绿。十问观察是观察不是评测。 |
| 查询内区分度 / 3.14 检查点一 | 每次调用建查询内词组权重表（D-153）：\(N\) 与 \(df\) 都是本池去重文件数，不是命中行数，也不是全仓库 IDF。覆盖三态 `complete` / `lower-bound` / `unknown` 跟着权重走；完整且稀有才加 \(\ln\frac{N+1}{df+1}\)，截断或不完整覆盖只保留普通匹配贡献 1。`search.content` 在 explore 候选模式另报 `fileCoverage`，per-file 命中帽不把去重文件覆盖标成不完整。`details.distinctiveness` 与 `details.windows`（path / why / packed / 命中行）对观察可见。`rankCandidates` 比较顺序未改——权重还不是主排序键，这是有意的。观察脚本排除自身路径（相对 `6f92b49c` 基线，问题 4/6 各少一个被问题原文占用的可见槽；`wants` 不变），阶段诊断分开「匹配窗口从未生成」与「生成了但没被选中」。十问对照（`--skip-scan`，脚本已自排除）：1 满足（register 可见 #2）；9 满足（request #1、register #3）；V1–V5 满足。2/3/5/7/8 仍读预算；10 仍 `not acquired`。4 可见 #6，诊断为「匹配窗口从未生成」。6 可见仍是 `ensureRuntime`，诊断为「匹配窗口已生成 291-412，未选中」。权重表每题可读。不声称质量或速度提升。 | `explore-distinctiveness.test.ts`（公式与三态；先红后绿）；`explore.test.ts` 查询内区分度组（截断不得冒充精确 df、per-file 帽仍为 complete、生成窗口可区分 packed/未选中——窗口项跑真解析器）；`search-service.test.ts`（per-file 帽 → `fileCoverage=complete`，丢文件 → `lower-bound`）。十问观察是观察不是评测。 |
| 精确线索验证 / 3.13 | 查询先提取对象再处理问句（D-144）。排名按任务匹配分层，路径只作 tie-break，原始组分不再与 RRF 混加（D-145）。问题里的连接值/符号/路径在第一次打包前就查；补充物化看是否已读而不是是否见过路径（D-146，修订 D-137）。图理由绑定核验成立的窗口；`connects` 与 `associates` 分等；打包覆盖所需证据；定位题可早停；跳过的泛词与读预算 `not-requested` 分开（D-147）。文件角色按问题决定；测试路径条件式优先；`definitionDropped` 去重（D-148）。观察脚本收紧十问最小证据、阶段诊断、五个入口变体（D-149）。十问观察（D-150）：问题 1/9 与五个入口变体能看见当前 `register`/`request` 端；无对象的 2/3/5/7/8/10 仍断在读预算。阶段诊断的所需证据由可选改为必填，未命中时报「窗口不含所需证据」而不是 `verified`；按读发现的连线字面量若与问句对象无关则降到 `support` 档（D-151，订正 D-149/D-150）。降等后问题 1 的三个无关另一端从可见 #4–#6 退到 #11–#13，不再挤占在题证据，但 `limit` 未被更好证据填满时仍占尾部槽位。**已读证据重算**（D-152）：对象词一趟冻结的窗口不再挡住内容词一趟的命中，连线展开落到已读文件的图线索也会被定位；复用快照与按内容哈希的解析缓存，不消耗新文件读取预算。复跑十问：1/9 与五个变体不变，问题 4 从可见 #19 升到 #6、问题 6 从 #2 到 #3，都仍未命中所需证据——问题 6 断得更早，`parse`/`budget` 对该文件的命中撞候选预算没回来。观察脚本自身存着问题原文，实测每题都进候选、并在问题 4 和 6 各占一个可见槽位，已在诊断里如实上报（D-152）；3.14 检查点一把该脚本排除出检索（D-153）。不引入 embedding/BM25/词法索引/NLU，不声称质量或速度提升。 | `explore-query.test.ts`；`explore.test.ts` 3.13 组（路径序不再赢、rg 池内图命中仍读、图陈旧/不可用、测试与生产同名注册、结构 unsupported 不宣称 verified、定义理由绑窗口、`direct-verified` 跳过泛词、注册表容器窗口里的无关另一端不压过本对象证据——该项跑真解析器切片，并已验证无修复时会红）；`explore-graph.test.ts`；`explore-service.test.ts`；`search-service.test.ts`；真 Pi `session-e2e.test.ts` explore 5 项。十问观察是观察不是评测。 |
| 符号图读者 / 3.12 | explore 第二候选来源：定义优先（distinctive 词命中目录名字，精确档压过只是提到该词的文件）、连线补全（已选摘录里确认的连接字面量 → `findLinks` 其他端点）、反向 import（已选路径，每种子最多 6、总共 12，同目录优先）、已解析 references/calls 边（`findReferences`/`findCallers`/`findCalls`，relation 预算 8，权重介于 import 与 connection 之间，D-240）。图只选路径；`hits` 在当前正文里定位后才写，定位失败丢掉窗口不退化成第 1 行。`details.graph` 自带 `not-requested / ready / empty / unavailable / failed / stale`（`stale` 预留，本刀不加第二套过期检测）。独立预算 40/16/12，`filesDropped` 与 rg 取 max。图那一趟的物化复用主循环的读预算与并行度（`maxMaterializeReads` + 3 路分批），超预算的新候选仍是候选、报 `not-requested`；打包 boost 按结构化来源查表（D-139）。`related` 回答文件级拓扑与已解析的 references/calls 边（D-240），正文写明与 `lsp.references` 的分工，无 rank；正文每段最多 40 条、名字锚点最多走 8 个路径并写明还剩多少，`details` 完整（D-139）。对照查询（加内存行缓存之前）：`bun run --cwd packages/web symbol-graph-query`。一次结果：`catalogBuildMs=1102591.4`，`searchSymbolsMs=185.999`，`findLinksMs=73.232`，`findImportersMs=42.379`，`symbolCount=24232`，`fileCount=2349`，`linkCount=13969`，`languages=javascript/typescript/typescriptreact`，`searchHitCount=20`（exact 1 / name-contains 19），`linkHitCount=4`，`importerCount=2`。方法：`git ls-files` ∩ `CATALOG_SCAN_LANGUAGES`（2349），tree-sitter outline/imports/literalCalls + `replaceFileSymbols`（同名闸门 + 1777 文件再访），然后各一次 `searchSymbols("explore", 20)` / `findLinks("explore.search")` / `findImporters` of `packages/web/application-host/lib/harness/explore.ts`。时钟为进程内 `performance.now()`。机器：win32 x64，AMD Ryzen 5 5600GT，12 逻辑 CPU，32049 MiB，Node v24.18.0。未走 `scanWorkspace`/`searchFilesystemFiles`：该路径每个目录 spawn `git check-ignore`，在本机挂了 11+ 分钟且 CPU≈0。这是对照数字，不是省时声称。量完后加了 `symbolQueryByPath` / `linksByValue`（D-134）。**验收又重量了建目录本身，并把它当前置条件修掉**（D-140）：枚举与写入原先都是产品跑不动的形状。枚举 `respectGitignore: true` 从「4363 次 `git check-ignore` spawn、投影 74 s、曾观测挂 11+ 分钟」变成一次 `git ls-files -z --cached --others --exclude-standard` 的 **199 ms**；`replaceFileSymbols` 从每文件 flush 整库（隔离测量：400 文件的库上 `touchFile` 单次 66.8 ms，同样 20 次成批共 91 ms）改为派生写入按安静 250 ms / 最长 30 s 去抖，全库 `catalogBuildMs` **1104500 → 290502**（18.4 → 4.8 分钟），同轮 `searchSymbolsMs=17.051`、`findImportersMs=41.422`、`parsedFileCount=4143`。测量脚本本身也改成按 `CATALOG_SCAN_BATCH` 成批并发——逐个 await 量的是产品不会跑的形状。去抖第一版按写队列占用写，全库只从 18.4 降到 17.6 分钟（解析夹在写入之间，队列几乎总是只剩一个），已改为安静期。当时剩余三成是再访重新解析 1785 个文件（解析缓存 32 条）；该重复采集已由 D-236 移除，旧数字不是本轮受控对照。**D-141 之后**（TriviumDB 0.8.6 + 原生索引 + `payloadCacheMb: 0`）同一脚本：`catalogBuildMs=256693`，`searchSymbolsMs=11.526`，`findLinksMs=0.966`，`findImportersMs=147.04`（首次含形状重建），2359 文件 / 4145 次解析 / 24301 符号 / 14024 边。**验收复验按调用次数重量了一次**（D-139）：一次 explore 调用做 `catalogStats` × 1 + `searchSymbols` × 每个 distinctive 词 + `getFileRelations` × 已选窗口 + `findImporters` × 每个种子（最多 20），同量级目录（2270 文件 / 23321 符号 / 12370 边）实测**892.2 ms**，主项是 `findImporters` 58.15 ms × 20。改成解析后的反向索引 + `catalogStats` 不逐文件读 payload 之后：`catalogStats` 14.19 → 1.13 ms，`findImporters` 首次 124.89 ms 建索引、之后 0.164 ms，**一次调用 892.2 → 51.7 ms**。同样是对照数字。 | `explore.test.ts`「explore graph path recall」（定义压过提及、连线另一端不在 rg 候选里仍出现、反向 import why、定位失败不输出、store 未开 `unavailable`、查询抛错 `failed`、空目录 `empty`、`filesDropped` 取 max）；`explore-graph.test.ts`；`related-tool.test.ts`（Host：没有 vs 不完整、反向 import、空目录 vs 未收录、未解析 specifier、每段上限与「还有 N 条」、名字撞多路径只走 8 个 + pi-host）；`store.test.ts`（路径集合变化后反向 import 重新解析）；真 Pi `session-e2e.test.ts` related。未测 Electron asar；未在多工作区桌面量冷扫描墙钟；未声称检索质量或速度提升 |
| 结构来源 / 3.11 | 第 1–3 步已接。第 1 步：`lib/structure` provider 接口 + LSP `documentSymbol` outline + explore 按 D-090/D-093/D-098/D-102 切片（容器单位：小函数全文，大函数签名 + 命中块 + 省略标记 + 完整读取入口；普通值绑定/成员签名不是单元，命中落在其上时切所属函数/类，至少不差于 ±3；`const foo = () => {}` 仍是自己的单元；签名即全体的单元——如 `documentSymbol` 把接口调用签名报成 `method`——按命中 ±3 取并补齐，D-102 起由 `sliceSymbol` 执行而不只是意图）；缺结构或 `stale` 退行 ±3 窗口并在 snippet/`details.structure` 标明状态（D-094）。第 2 步冷启动对照已量：`bun run --cwd packages/web structure:cold-start`。一次结果：`coldStartToDocumentSymbolMs=833`（`bindMs=240`，`documentSymbolMs=593`），`symbolCount=50`，`status=ready`。方法：agent 视图冷进程，对一份 `explore.ts` 副本（27355 字节）做首次 bind（input-context/disk）+ 首次 `documentSymbols`；工作区是带最小 tsconfig 的单文件临时目录，不是整仓索引；时钟为进程内 `performance.now()`。机器：win32 10.0.26200 x64，AMD Ryzen 5 5600GT，12 逻辑 CPU，32049 MiB，Node v24.18.0（tsx 跑脚本，`bun` 字段为 null）。这是对照数字，不是省时声称。第 3 步：web-tree-sitter 0.27 + `tree-sitter-typescript` 0.23.2 发布 wasm（TS/TSX），生产顺序 tree-sitter → LSP（D-097）；`empty` 或未覆盖命中的 `ready` 可问后续 provider，但 `warmOnly` 不冷启动 LSP（D-099）；命中分类只打已物化窗口分（D-095）；wasm 经 ASAR 重映射读取（D-096），约 3 MB 二进制以 git 为事实来源（D-101），加载失败报 `unavailable`。第 4 步：`StructureSource` 长出 `literalCalls`/`imports`（缺能力报 `unsupported` 不是失败，D-106）；确认连接（`request`/`register`/`on`/`once`/`emit`/`subscribe`/`addEventListener`）与关联候选分列，**候选须真是同名**——该字面量已是某处的确认连接值才写入，闸门看 store 的 connects 值索引加本批，冷扫描末尾补一遍（D-109，实测 `application-host/lib` 499 文件从 10,711 条降到 153 条，link 节点 13,220 → 2,662）；`imports`/`connects`/`associates` 与 defines 共用 generation，重收集后无悬挂边（D-105）；outline 单独决定能否写这一代，边查询被阻塞记 `linksIncomplete` 而不冻结符号（D-111）；轮廓行区间转字符范围时末列取真实行长（D-110）；outline 收模块级/类级值绑定作目录名、切片仍按容器过滤（D-113）；冷扫描复用 `searchFilesystemFiles` + Documents 磁盘读，不读脏缓冲、不扫 LSP、不阻塞启动/首 turn，覆盖带 `importQuery` 的语言（TS/TSX/JS/JSX，D-115 取代 D-104）；JSON 进切片不进目录（D-114）。`explore.search` 仍读摘录路径出边作注解（D-108/D-112：库不可用或查询失败按 `status` 降级而不失败检索、读路径只用已打开的 store、修订不同则去掉行号并标 `stale`、可见预算排在 issue 之后且每文件 12 条上限）。3.12 取代 D-108 的「不扩候选池」：定义 / 连线另一端 / 反向 import 成为独立预算的路径候选，物化后在当前正文里定位名字才写 `hits`（D-136/D-137）。第 5 步现按 D-290 提供开箱即用支持：原 TS/JS/JSON 之外，新增 Python/Go/Rust/Java/C/C++/C#/Kotlin/Ruby/PHP/Bash/CSS/HTML/YAML/TOML 的内置 wasm + tags 查询，构建校验摘要并实际编译查询，Rust kernel 提取 outline/classifyHits；未实现的 imports/literalCalls 不标可用。缺失查询报告 unavailable。Node 型 Python/HTML/CSS/JSON/YAML/Bash 语言服务随扩展提供，Rust/Go/C/C++/Markdown 服务按实际请求自动准备；设置查询本身不下载或启动进程。设置区分代码分析的安装状态与实际运行状态，技术细节折叠，提供准备、取消、重试。自带 wasm 的 ABI/来源和索引失败语义保持 | 第 1 步：`structure/*.test.ts`、`explore.test.ts`、`explore-service.test.ts`、`session-e2e.test.ts` 结构切片真 Pi 断言。第 3 步：`tree-sitter-provider.test.ts`（真实 wasm 解析、取消、预算耗尽、缺 wasm → unavailable、定义绑定与 var/declare/namespace 覆盖）、`explore.test.ts`（同一大函数三种命中、冷 LSP 下 tree-sitter 切片、名字先于注释、不分类未读候选、缺 wasm 退行窗口）、`source.test.ts` / `lsp-provider.test.ts`（empty/缺口 `warmOnly`）、`slice.test.ts`（签名即全体的一行 `method` 补齐到 ±3、有函数体的单元仍精确，D-102）。第 4 步：`connections.test.ts`、`source.test.ts` 门面 fan-out/`unsupported`、`store.test.ts` 确认 vs 候选与悬挂边、`store.smoke.test.ts` 编译产物、`symbol-runtime.test.ts` 结构写入与 unavailable 保留 + 同名闸门（含同文件 register/log）+ 边阻塞仍更新符号并记 `linksIncomplete`、`catalog-scan.test.ts` 未改动文件 + 不读脏缓冲 + JS 进目录/JSON 不进、`tree-sitter-provider.test.ts` 模块级绑定入目录/局部绑定不入 + JS/JSX/JSON 轮廓、`explore.test.ts` / `explore-service.test.ts` 真实入口读边 + 图不可用仍返回摘录 + 草稿摘录关系标 stale 去行号 + 关系不挤掉 issue + JSON 大切片。第 5 步：`language-support/runtime.test.ts`（上限/`partial`/wanted + 装了带查询的语法真出能力、没查询的报 installed 但能力全关、索引不可读报 `unknown`）、`grammar-installer.test.ts`（wasm 与 tags 摘要不匹配都拒绝并清理、下载可取消、重复安装并流只下一次、ABI 越界报 `abi`、用户导入、不回传文件系统错误原文、后缀/体积拒绝）、`grammar-store.test.ts`（查询随语法存取与删除、索引损坏抛错且不覆盖、缺文件才算空）、`grammar-manifest.test.ts`（9 种带已验证查询、ABI 超窗移入 skipped、摘要格式不对的查询字段丢弃）、`tree-sitter-provider.test.ts`（用真实 wasm 走一遍 tags 适配器出 `function`/`class` 单元与 `variable` 目录名、命中分类、无查询报 `unsupported`；`tagsDefinitionKind` 映射）、`runtime-path.test.ts`（捆绑优先于下载目录）、`language-id.test.ts`、设置页 presentation/i18n（已装但无轮廓不显示成功、`unknown` 无动作、体积文案）。断言真实解析的测试自带解析预算，不继承生产值（D-102）。脚本不进默认测试套件。未测 Electron asar 真机打包；未在本步重跑冷启动脚本；冷扫描未在真实多工作区桌面启动路径上量墙钟；tags 适配器用捆绑 JS 语法验证，9 种按需语言的查询只在发布期脚本里编译过、未在本机装后逐语言走查；真实 npm 下载未走（单测注入 download/extract） |
| T4 / 执行配置 | `harness.context` 单会话覆盖与实际后台准备开关已接；完整跨 runtime RunManifest 未收敛，record-only 未实现；Workbench/Agent Profile 职责分开 | record-only/T4 非前置；其余单会话配置随实际消费者完成，不要求统一 RunManifest 先行 |
| 结果与集成 | 基线与结果来自原生对象，merge 消费 fixed resultRevision 与被审阅的父绑定。磁盘写入与 surface intent/回执共用持久操作，确认前不完成，条件补偿和 Host 撤销保留后续编辑。父已含子结果为 no-op；buffer 不隐式保存，默认不改 Git index。磁盘变更仍与父回合 checkpoint 同事务绑定。D-207：同 Run 命令记录绑定到 published revision；子检查 / 合并可应用性 / 父检查分列；草稿合并不能验证未保存缓冲 | 真实文件/故障注入、Documents→Registry 混合纵切、真实 Pi 会话（faux provider）与 React 挂载通过。验证记录定向组见 3.4 / 3.7。完整桌面未跑；Host 资源协调不等于对外部进程的 OS 级原子比较交换。正文、类型与未验证范围见 3.5a |
| 物化生命周期 | Git/非 Git 结果独立发布；copy snapshot 按修订保留。归档先取消并等待实际准备和会话退出，再保存结果；关闭后的采集失败可重试。准备阶段和部分目录 fingerprint 持久化，恢复失败不删除后续新内容。原 session 重绑新 Run；普通已结束线程打开也先恢复。用户与自动回收共用线程生命周期协调，guard 内核对结果并持有到删除结束。占用覆盖整个 workspace，用户预算以短临界区预留并发已知需求；未知不记零 | `thread-lifecycle.acceptance.test.ts`、`thread-worktree.test.ts`、`thread-runtime.test.ts`、`thread-space.test.ts`、`thread-routes.test.ts`、`worktree-reclaim-guard.test.ts`、`thread-worktree-settings.test.ts`、`working-state/working-state-store.test.ts`；Git filters/LFS 已实施（D-243/D-249），CoW/reflink 已实施（D-244）。真实 ENOSPC / 浏览器完整归档链 / macOS、Linux 未测 |
| `check` | 现有角色含 bash 且 shared，具备命令执行能力 | 不称只读 agent，不阻止测试/构建正常生成文件；不新增统一副本要求 |

**D-284 本地实施证据（2026-09-16）**：pi-host 全组 358 项（357 通过、1 skip），含 `context-preparation.test.ts` 12 项、
`history-fresh.test.ts` 10 项与真 Pi+faux `session-e2e.test.ts` context preparation 链（后台挂起时前台完成、压缩复用候选、
history 回读后真实回合消费）；Application Host 全组 109 文件 1061 项通过；UI 类型检查与 i18n parity 通过。真 Pi 测试使用
本地 faux provider，证明 hook 边界、候选提交与回读接线，不宣称外部模型摘要质量或缓存收益。

**D-081 本地实施证据（历史，路径已删除）**：protocol 全组 74 项；pi-host memory/compaction/Phase 2/真 Pi session/feature 定向组 42 项；
Application Host memory/compaction/service/Zone 2 定向组 84 项；UI 模式投影/session store/i18n 54 项，均通过。真 Pi 测试使用本地
faux provider，证明实际 hook、Host bridge、零接管模型调用与 Pi fallback，不宣称外部模型的长期语义质量。protocol、pi-host、
Application Host test 与 UI 类型检查及四包 lint 通过；文档检查见本次提交。未运行付费模型或完整桌面 smoke。

**D-082 本地实施证据**：protocol 全组 75 项；Documents Authority/routes、真实 rg/explore 与 query 定向组 53 项；UI session store
45 项；SessionHost prompt 与真 Pi session 定向组 25 项通过。protocol、application-client、runtime-broker、pi-host、UI 与 Application Host
测试类型检查和六包 lint 通过；工程文档 19 项及链接校验通过。测试覆盖 snapshot 后继续编辑、旧磁盘命中删除、dirty-only 新词、
错误 session/workspace/scope、来源不可用、发送/commit 失败，以及 runtime payload 不含正文；使用本地 faux provider，未运行完整桌面
或多窗口手工 smoke。

**D-083 本地实施证据**：Application Host 的 Documents、Thread registry/services/runtime/worktree、WorkingState 与 Integration 9 文件组
138 项通过，1 项 Windows symlink 权限跳过；主代理修正字节格式、结构闭包、窄路径、live/fixed 与 surface 冲突后，受影响 6 文件 88 项
再次通过；最终小改另有 runtime/service/store 37 项、worktree 15 项（同一 symlink 跳过）及 WorkingState 17 项复验通过。UI Document Registry 24 项、线程投影 7 项；protocol 全组 75 项；Node/tsx 下真 Pi Thread capability、讨论转换与父回合集成/
撤销 5 项通过。protocol、application-client、pi-host、UI 与 Application Host 类型检查及五包 lint 通过；application-client/protocol
构建通过。测试覆盖 CRLF+BOM、surface 释放后的 queued 启动、schema 迁移、lost 恢复、ignored draft、文件/目录互换、固定结果后的 live
续写、草稿路径零写入与父已含子结果 no-op。工程文档检查见本次提交；未运行完整桌面或外部 provider smoke。

**D-084/D-085 本地实施证据**：WorkingState store/runtime 定向组 31 项通过，覆盖 schema 1/2→3、文件/目录 capture scope 的新增、
修改、删除、持久重开与结果物化；search/explore 三文件组 40 项通过，覆盖 fixed/regex/case/glob/context、dirty path 在 rg cap 前排除、
空模式、scope、并发草稿读取与磁盘 revision 漂移。Documents read source/router/authority 四文件组 51 项，pi-host 原生 read/grep、
能力门、磁盘图片与 Harness E2E 组 28 项、真 Pi fixed-surface read 纵切 1 项通过。protocol、pi-host 与 Application Host 测试类型检查通过。
pi-host 与 Application Host 构建、改动 TypeScript ESLint、工程文档 19 项及 378 页/288 本地链接校验通过。未运行完整桌面、
多窗口 UI 或外部 provider smoke。

**D-086 本地实施证据**：`document-path-overlay.test.ts`、Router path authorization、pi-host `find-ls-tool.test.ts` 与
`select-tools-web.test.ts` 定向组通过；`session-e2e.test.ts` 的真实 Pi faux-provider 回合证明 Host capability 下同名
`find`/`ls` 覆盖实际进入模型结果，dirty-only nested path 可见且不相关磁盘目录仍走 Pi 原生实现。Host overlay 返回相对请求根的
fixed files、revisions 和虚拟目录，find 在合并后交回 Pi definition 处理目录后缀、limit 与 50KB truncation，ls 对覆盖节点采用固定
snapshot 类型。protocol、pi-host 与 Application Host type-check 通过；未运行完整桌面、多窗口 UI 或外部 provider smoke。

**D-079 本地实施证据**：最终 Host 定向组覆盖 working-state、线程、explore、Documents 与 recovery，共 21 个文件，228 项通过，
1 项 Windows 符号链接权限跳过。Protocol 71 项；Pi 线程 service/bridge 8 项、能力门 3 项；真实 Pi 原生线程测试文件 2 项、explore
纵切 3 项通过。测试使用本地 faux provider，没有执行真实付费模型或完整桌面 smoke；不以旧报告的全仓数字代替当前证据。
Protocol、pi-host 与 Application Host 类型检查通过，Host 构建与本轮修改文件 ESLint 通过；工程文档测试 19 项、文档链接校验
和 git diff --check 通过。未重复运行无关平台或全仓测试。

**D-076 本地证据**：protocol 70/70；关键 Host focused（分支/CAS/coverage/cursor/router/route/thread）全通过；pi-host 关键纵切 38/38；UI block projection 2/2；protocol/pi-host/UI/
Application Host type-check 与四包 lint、文档 19/19、链接校验、`git diff --check` 通过。扩大并行运行时 Host 另有 3 个计时用例、
pi-host 有 1 个后台 shell 计时用例失败，全部单独复跑通过；不把并行负载下的偶发超时记成本纵切失败，也不伪报全量零失败。

**D-206/D-209 本地实施证据**：Host terminal runtime、Harness bridge、shell assembly/supervisor 与 todo 定向测试覆盖全局 id、
HTTP/程序化身份冲突、后台自然退出、真实 kill、迟到 exit、writer 释放失败重试和无写后确认；pi-host todo/output/phase2 定向组覆盖
公开工具协议。Runtime Manager 的 bundled/显式选择证据保留。未跑完整浏览器终端点击链和 macOS/Linux 真机。

**D-207/D-210 本地实施证据**：protocol `harness-settings.test.ts`；Host `verification-records.test.ts`、
`verification-coordinator.test.ts`、`working-state-store.test.ts`、`review-sensor.test.ts`、`service-host.test.ts`、`zone2.test.ts`、
`thread-runtime.test.ts` / `thread-worktree.test.ts` 定向组覆盖 actor/Run/代际、变化范围身份、一次性绑定、父窗口重载、已应用但未保存的
surface 仍不可冒充磁盘验证，以及 review gate。
不把 faux provider 写成真实审阅质量；非 Git 精确输入仍明确 uncertain。未跑完整浏览器 Settings/线程面板点击链，也未发起付费模型实验。

**D-208/D-211 本地实施证据**：protocol `harness.test.ts`；Host `store.test.ts`、`knowledge-suggestions.test.ts`、
`knowledge-catalog-routes.test.ts`、`knowledge-services.test.ts`、`context-routes.test.ts`；pi-host
`knowledge-suggestion-extension.test.ts`；UI `KnowledgeSettings.behavior.test.tsx`、
`knowledgeCatalogRequest.test.ts`、i18n 与事件投影定向组覆盖完整 CAS、并发去重、固定 actor scope/source、有效 auto-accept 设置、
切换与迟到响应。
未跑完整浏览器 Settings 点击链，也未发起付费 suggestions 模型实验。
2026-09-18 设置入口合并为 Agent Harness →「上下文与知识」，页内分别显示上下文设置与知识目录；搜索定位会选择对应标签和 user/workspace 范围，切换标签保留知识编辑。此调整不改变上下文压缩或知识存储的权威。

**D-213 本地实施证据**：protocol `harness.test.ts` 识别 `document.branchWrite` / `workingBranch.ensureMaterialized`；Host
`working-state-store.test.ts`、`working-branch-writes.test.ts`、`working-branch-view.test.ts`、`path-requirement.test.ts`、
`thread-space.test.ts`、`thread-runtime.test.ts` 定向组覆盖 writeRevision CAS、父磁盘不变、兄弟隔离、scope 拒绝、首次 bash/LSP
物化切换、虚拟 scratch 回收与 bash 预算预占；pi-host `workspace-mutation-journal.test.ts`、`apply-patch-tool.test.ts` 覆盖公开
edit/write/apply_patch 先走 branchWrite、disk 才落盘。未跑完整桌面 bash 物化或非 Git 大目录墙钟；Git filter/LFS/换行/执行位
适配已由 D-243 实现并有真实 Git 测试。

**D-214 本地实施证据**：Host `workspace-baseline.test.ts`、`thread-runtime.test.ts`、`thread-services.test.ts`、
`thread-space.test.ts` 定向组覆盖 Git 变化集与 ignored/captureScopes、unborn/非 Git、BOM/CRLF/二进制、捕获取消不建分支、
dispatch 必准备且失败删除 Thread、prepare 后 spawn 不重扫、父漂移隔离。D-243 补真实 Git filter/LFS/执行位适配证据；
未测 Windows 符号链接创建（需要提权）与非 Git 大目录捕获墙钟。

**D-215 本地实施证据**：角色目录与嵌套 parent 数据模型仍在；`nested-threads.test.ts` 把 `resolveRuntimeWorkspaceId` 钉成同一个 `"ws"`，不能证明 owning/execution 拆分。身份查找已由 D-216 改走 Host session binding。

**D-216 本地实施证据**：Host `workspace-identity.test.ts`（Documents 不同 workspaceId、session.create、Harness router、公开 dispatch、threads/wait/Zone 2/lost resume、物化后子 Git 不改父状态）；`thread-registry.test.ts`（session binding 持久化与重启）；`thread-services.test.ts` / `zone2-threads.test.ts`（execution workspaceId 下仍写 owning catalog）；`thread-worktree.test.ts`（父仓库内 `git init`、外部路径 `--detach` 写 `.git/worktrees`，都不污染父分支列表）。未跑真实付费嵌套 Pi 会话或完整桌面 Host 重启。

**D-217 本地实施证据**：Host `virtual-write-invariants.test.ts`（失败物化并发写仍进分支且 scratch 非权威、孙 merge 后再写再物化两者都在、symlink/环/非法 UTF-8/文件祖先拒绝、read/explore revision=writeRevision、semantic pin 排除父盘漂移、abort 不完成后台切换、staging-promoted 崩溃完成物化 / live-backed-up abort 回虚拟）；`virtual-write-tree.test.ts`；`materialization-switch.test.ts`；`branch-view.test.ts`（unpublished writeRevision 标签）；`working-branch-writes.test.ts` 原生产链仍通过。未跑完整桌面 bash 物化或真实付费 explore semantic。

**D-218 本地实施证据**：Host `workspace-baseline.test.ts`（listing 失败抛错、unborn 不跑 `diff HEAD`、gitlink 列出）；`thread-runtime.test.ts`（Git 失败/捕获窗口变化/活跃 writer/gitlink 不生成完整 branch，`setWorkingState` 失败删除未绑定 branch 与 scratch）；`thread-services.test.ts`（`baseline-changed` 可重试并删除 Thread）；`working-state-store.test.ts`（新虚拟文件写入真实默认 mode）；`materializer.test.ts`（unsupported 拒绝）；`integration-coordinator.test.ts`（省略 mode 的新文件仍可 apply；apply 后 chmod 则补偿 needs-attention，Windows 上 chmod 无效果则跳过该断言）。未测真实 Git filter/LFS、已 checkout 的 submodule 闭包或完整桌面 Host 重启。内容身份与无探测 mode 见 D-220。

**D-220 本地实施证据**：Host `execution-baseline.test.ts`（生产 router `document.branchWrite` / `workingBranch.ensureMaterialized` + `processEvent` settle/drain + `runtime.merge`：虚拟写与 shell 写同时进入 native result 并落到根目录，无 bad object；reclaim 后 rematerialize 使用父仓库可解析 ref；staging-promoted 恢复持久化 execution HEAD）；`thread-worktree.test.ts`（父仓库内 init 的 `executionBaseline` ≠ 父 HEAD，inspect 不 bad object）；`working-branch-view.test.ts`（shared lease 等待期间提交后读到新正文与 `@1`；`createExploreQueryStartService` pin 后 rg/read/semantic 仍见 pin 正文）；`thread-runtime.test.ts`（两个 dirty 文件扫描中途改内容、Git 路径集合不变 → retryable `baseline-changed` 且不留 branch）；`working-state-store.test.ts`（新文件 mode 不创建 `.varin-mode-probe-*`）。未跑真实付费 Pi 会话、完整桌面 Host 重启或 Git filter/LFS。

**D-221 本地实施证据**：Host `integration-coordinator.test.ts`（生产 `mergeResult` + `commitParentVirtualWrites` 在 CAS 成功后注入崩溃，重启 `fenceUnfinishedOperations` 把 applying 对账为 complete，`operationId` 幂等复用）；`working-state/branch-integration-lock.test.ts`（真实 recovery engine store 队列上 `materializeExecutionView` 已 `beginSwitch` 并等待 store 时，`runtime.merge` 经生产 coordinator 返回确定结果且不挂起）；`working-branch-writes.test.ts`（切换中写入等真实 cancel，不因两次重试失败）。未跑真实付费嵌套 Pi 会话或完整桌面 Host 重启。

**D-222 本地实施证据**：Host `dequeue-permissions.test.ts`（生产 `createOnThreadDequeued` → `runtime.spawn` → `sessions.create` 带 `accept-edits`，`mergePolicies` 后 live bypass 仍是 accept-edits）；`integration-coordinator.test.ts`（directory apply/reconcile 经 `fenceUnfinishedOperations` 调用 execution `runResourceOperation`，对象库不进父目录；无法解析则 needs-attention 且不走 owning gate）；`thread-registry.test.ts`（catalog 无 binding 经 `reconcileAfterHostRestart` 重建；stale binding 拒绝）；`thread-services.test.ts`（binding 无 catalog owner 拒绝 dispatch）；`knowledge-owning.test.ts`（snapshot 先绑 execution，`markRunRunning` 后 recall/suggest/Zone 2 打 owning store）。未跑真实付费嵌套 Pi 会话或完整桌面 Host 重启。

TriviumDB 的数据库问题按版本和通用语义向用户说明，不转嫁 Varin 领域职责；迁移未立项。Windows 沙箱是用户排除项，
不是缺平台测试而暂时 blocked。macOS/Linux smoke、Electron 打包、真实 provider 分别记录未验证环境；测试者结果是后续质量反馈，
不作为默认交付阻塞。

**D-239 旧结果释放已接线、默认可用（2026-09-12）。** 线程卡片按需读取历史、展示保留原因并确认选定 branch/revisions；鉴权
Host 路由重查当前结果、Run 输入、review 与未结束 Integration。先移除版本元数据，再释放引用并回收无主对象；当前分支、报告、
转录及其他线程的共享内容保留。清理失败可用原请求重试，返回实际清理结果。整个 Thread 的删除由 D-242 提供（线程卡片 → 鉴权
`DELETE` 路由 → 生命周期级联），当前分支的删除也随该级联发生。

**D-240 / D-246 图关系验收收口（D-254，2026-09-12）。** LSP workspace root、公开 phased explore 的
references/calls、anchor 批次替换与 partial 组合保持；图库现在由 session binding 解析到 owning workspace，execution workspace
只承担 Documents/LSP/路径。`related` 不再把 owning 图的行号直接用于隔离分支或脏缓冲；公开 LSP 的文本、raw value、targetPath
与写后行统一按 actor scope 过滤。navigation 空结果会按 anchor + relation kind 删除旧 references，不误删同 anchor 的 calls。
`lsp-nav.test.ts`、`related-scope.test.ts`、`relations.test.ts` 与 explore query 定向组覆盖越权位置、隔离视图和空结果清理。

**D-241 / D-247 复验结论。** 未知 exec/dlx/x、唯一 warning、failure-relevant 进度与非零退出 required 行均符合当前决定；
本轮没有发现新的阻塞错误，代码不变。

**D-242 整个 Thread 删除已接线（2026-09-12）。** 线程卡片的两步确认按钮走鉴权 `DELETE /api/harness/sessions/:sessionId/threads/:threadId`；
Host 按归档同一级联形状后序处理子线程：每个节点先停活 Run（abort+close 绑定会话、`endRun(cancelled)`，但不铸 partial
result——删除正要释放它），再经 `piRuntimeBroker.deleteSession` 删除该线程全部 Pi 会话（worker、转录文件、metadata），
随后在 WorkingState 租约内释放全部结果修订、删除工作分支与草稿基线并回收无主对象，最后删除受管目录（跳过结果快照 diff，
仍过 ownership 断言与 writer guard，keep_worktree 不生效——记录已删，留下的目录会变成无记录占用）并原子移除 Thread+Run
行与 session binding。目录删除失败保留记录供重试；无 `deleteSession` 接线且线程有会话时拒绝而不是留下孤儿转录。

**D-248 / D-254 删除收口（2026-09-12）。** WorkingState 修改与 GC 使用 exclusive lease；Thread catalog
现在持久化 `deletion.{operationId,rootThreadId,phase,requestedAt,updatedAt,error}`，其中 phase 表示下一步。整棵待删树先写
intent，再后序执行 sessions → store → directory → registry；每步完成后才推进 phase，Host 启动会续跑未完成根。后代任何一步
失败时父不进入提交点，返回的 `deletedThreadIds` 只含真实删除项。knowledge 在 broker 移除 session binding 前清理；retrieval
evidence/receipt/artifact 引用在 store 阶段同步释放，失败保留 Thread 行，不再由吞错的 `onThreadRemoved` observer 处理。UI 显示
pending phase 并禁用 restore/merge/reclaim 等冲突动作，删除按钮仍可显式重试。

证据：`thread-runtime.test.ts` 覆盖 session/store/directory/evidence 失败、exclusive lease、子失败不删父、实际 deleted ids、catalog
重开后 `resumePendingDeletions` 续跑；原有 UI 确认仍明确包含子孙线程、Pi 对话、结果历史与受管目录。

证据：`thread-history.test.ts` 6 项经真实 Registry/WorkingState/SQLite/Recovery engine 和公开路由覆盖鉴权、整批冲突、活动/未启动
review、active/lost Run 输入、共享对象、释放源版本后 undo、引用清理失败重试及 Registry 并发；与 registry、Integration、锁顺序和
recovery engine 5 文件共 116 项通过。`working-state-retention.test.ts` + store 共 19 项覆盖 JSON/rename 与 SQLite 中断及目录缺失；
`HarnessThreadResultHistory.behavior.test.tsx` 5 项覆盖确认、关闭重开后的重试、409 与迟到响应，邻近面板 9 项和 i18n parity 4 项通过。
Host/UI 类型与相关 lint 通过。完整 Electron 点击、真实卷耗尽和进程级断电未实测；3.4/3.4a 其他 Partial 原因仍保留。

**D-243 / D-249 已由 D-254 替换（2026-09-12）。** 验收确认原 filter/LFS 适配只服务旧 worktree 的
`importFixedResult` 兼容入口，而且 `cat-file --filters` 仍可能执行自定义 filter 或触发 LFS 网络，不能支持“固定修订且不触网”的
声明。当前没有旧内部格式用户，因此已删除 `importFixedResult`、`git-migration.ts` 与 commit-blob smudge/LFS 重建链。

当前生产路径在 dispatch 时把工具实际看到的工作区字节捕获为 WorkingBranch base；物化线程 settle 时先建立固定 snapshot，再按
fixed diff 从 snapshot 的真实文件字节发布结果，并在 catalog 提交前复核 snapshot 身份。CRLF、BOM、LFS pointer/本地内容、
working-tree-encoding 与自定义 filter 的结果均以已经物化给工具的字节为准，发布过程不执行 filter、不访问网络。Windows 仍从
Git index 恢复 100644/100755；`gitBaselineFingerprint` 也包含完整 index mode，单独的执行位变化会使捕获窗口失败重试。

**D-244 CoW/reflink 材料化后端已实现（2026-09-12）。** `workspace/reflink.ts` 的 `copyFilePreferReflink` 先尝试
`COPYFILE_FICLONE_FORCE`（真实共享 extent 或真实失败），不支持时退化普通 `copyFile` 并返回实际 backend——Node 的非 FORCE
FICLONE 会静默降级，调用方无法分辨，故用 FORCE 保持诚实。生产接线：非 Git/zero-commit worktree 准备、`.baseline` 快照、
untracked/merge/rematerialize 复制（`thread-worktree.ts`）、WorkingState 材料化的对象库→目标写入
（`materializer.ts` 新 `objectPathFor` + `cow.{reflink,copy}` 计数）与 recovery `replaceFile` 的对象→临时文件复制。
目录型 `harness.worktree.copyIgnored` 也由 D-254 改为逐文件走同一复制原语，不再通过 `fs.cp` 绕开 backend 选择。
真实 reflink 只在 ReFS/APFS/Btrfs 卷上生效；NTFS/ext4 上如实走 copy 且 backend 报告 "copy"。

证据：`reflink.test.ts` 6 项——真实 fs 复制与 backend 报告、注入 EOPNOTSUPP 验证退化路径与原样内容、ENOENT/普通错误
不重试、材料化经 `objectPathFor` 命中对象文件且 readContent 不被调用、对象缺失时 readContent 兜底、cow 计数。
未实测真实 ReFS/APFS 卷上的 extent 共享（本机与 CI 均为 NTFS）；回退路径与结果正确性已覆盖。

**D-250 返工（2026-09-12）。** 对象完整性验证：materializer 从 object path
reflink/copy 前验证 byteLength + SHA-256（`verifyObjectIntegrity`，归一化
`sha256-` 前缀），损坏对象抛出而非进入执行目录。EACCES/EPERM 从
`REFLINK_UNSUPPORTED_CODES` 移除——权限/策略错误直接传播，只有平台级"不支持
clone"/"跨卷"错误退化普通 copy。CoW 统计到达现有消费者：store 的
`materializeResult`/`materializeStates` 返回 `MaterializeResult`；runtime 的
restore 和 materialization switch 路径捕获 cow 统计存入 `cowByThread`；
`inspectSpace`/`ThreadOccupancy.cow` 字段暴露给现有空间消费者（非新增看板）。
证据：`reflink.test.ts` 12 项（损坏对象拒绝、EACCES/EPERM 传播、EXDEV 退化、
backend 汇总、verifyObjectIntegrity）；既有 materializer、working-state-store、
state-trie、thread-runtime 套件回归通过。

**D-245 / D-251 持久 trie 的当前真实范围（D-254，2026-09-12）。** schema 4 在磁盘上把路径映射写成 `{trie: root}`
和共享 `stateNodes`，tree identity 使用含完整 mode 的 Merkle root。校验现在用 recursion stack + verified set，允许内容寻址 DAG
合法复用同一子树，同时拒绝真实循环、缺节点、节点哈希不符和伪造 empty root。prototype-chain 更新在持久化时按 root 遍历所有可达
节点，不能因 own-property 枚举漏掉未改子树；引用对账也走同一个 serializer。schema 1–3 和 schema 4 平表均拒绝，不保留旧 reader。

当前 TS 内存中的 `WorkingBranch.baseState/deltas` 与 `WorkingResult.*States` 仍是平表，更新仍会复制相关平表，catalog 也仍整体写入；
因此这里是正确的持久去重与 identity，不是生产 root authority、增量节点事务或端到端 O(1) fork。后三项由已规划的 Rust R1 一次接管，
不在 TS 中再建一套过渡内核。反例覆盖相同叶子 DAG、empty-root 篡改、prototype overlay 持久化、flat-schema 拒绝与引用对账的唯一形状。

## 未完成项（来自 D-027，按来源）

| 来源 | 未完成 |
| --- | --- |
| D-023 | user terminal 事件已由 D-226 接通，命令事实由 D-229/D-233 纠正。knowledgeSuggestions 槽位用户消息提议与 Settings 知识目录已由 D-208/D-211 接通并补正并发/身份。D-238 的 keeper 加速链已随 D-284 整体删除；zsh/macOS/Linux 用户终端仍未实测 |
| D-024 / D-026 | merge/归档后的 worktree 与分支回收已由 D-077/D-202 接线；归档/恢复 UI 见 D-202 |
| D-013 | 已由 D-206/D-209 接通 terminal runtime 并补正身份/退出；见矩阵 1.3 |

## 历史快照：阶段 1 小结（2026-09-03，自决策日志迁入）

以下内容原位于 `agent-harness-decisions.md`，按 D-030 迁到此处；只是当时的快照，现行状态以上表为准。

### 模块已写并有单测

| 工作项 | 模块 | 单测数 |
| --- | --- | --- |
| 1.1 | HarnessServiceMap, HostServicesBridge, HarnessRouter | 17 |
| 1.2 | Zone 0 violation fix + stability contract | 5 |
| 1.3 | ShellSupervisor (PTY), bash tool | 21 |
| 1.4 | OutputStore, tool-result-truncation | 12 |
| 1.5 | HarnessSearchService, grep tool | 6 |
| 1.6 | LspDiagnosticsService, apply_patch (Codex) | 6 |
| 1.7 | PathLockService, withPathLock | 13 |
| 1.8 | CounterTracker | 7 |
| 1.9 | HarnessSettings schema + Settings page | 6 |
| 1.10 | promptSnippet / promptGuidelines | — |
| 补齐 | get_output, write_to_process, kill_shell, diagnostics | 15 |

### 已接进运行系统（当时）

`index.ts`：HarnessServiceHost（传入 `discoverShells()`）、HarnessRouter、broker 事件消费、会话注册时按工作区 `settings.get` 解析 `harness.shell`、registerWriter、诊断 provider、`harness.respond` ok 字段；`session-host.ts`：selectHarnessTools → customTools、截断扩展、apply_patch OpenAI-only、Settings 门控；`service-host.ts`：bash 初始 cwd、省略 discovery 时本机发现；`workspace-mutation-journal.ts`：诊断经 hostServicesBridge；`HarnessSettingsPage.tsx`：工具开关 + shell + output + bash。

### E2E（`packages/pi-host/test/harness/harness-e2e.test.ts`，6/6）

1. bash pwd 输出包含工作区目录名；2. 两次独立调用 `cd packages` → `pwd` 以 "packages" 结尾；3. 超过 waitMs 的命令返回 `sh_` id，`get_output` 取到非空输出；4. grep 命中含 "hello"，miss 返回 "0 hits (searched"；5. `cat big.txt`（5000 行）返回 `out_` 句柄，page1 含 "line 1"，page2 非空；6. `selectHarnessTools`：grep=false 时无 grep，默认有 grep。

### Contract（`packages/pi-host/test/harness/router-bridge-contract.test.ts`，3/3）

`buildHarnessRespondParams` → host-controller `harness.respond` → `respondHarness` → bridge：ok 结果 resolves；error 结果 rejection；timeout 为 retryable rejection。

当时的已知缺口：`read` 的 `tool_result` 截断未在真会话验证；诊断 provider 已接线但未用真实 LSP 验证；D-013 的 terminal runtime 集成待完成。前两条已于 2026-09-05 由 D-065 补齐；terminal runtime 集成已由 D-206 收口，见矩阵 1.3。

**D-224 本地实施证据**：`working-state/integration-coordinator.test.ts` 覆盖 child merge → parent materialize → execution Documents gate undo、父后续编辑 needs-attention、undo apply 后崩溃重启并同时对账磁盘/branch cache；`thread-runtime.test.ts` 覆盖 native publish 失败以及 inspect + Git snapshot 同时失败时清除默认 resultRevision；`thread-registry.test.ts` 覆盖新 Run 撤下旧默认结果、active Run owner 重建、superseded session 拒绝、registry cascade fence 与 cascade 接管后的失败 dispatch 不互删；`nested-threads.test.ts` 覆盖父目录回收后孙线程仍从父 WorkingBranch 固定基线；`explore-query-services.test.ts` 与 `working-branch-view.test.ts` 覆盖 scoped pin 且不克隆整分支。9 个受影响测试文件 174 项通过，Application Host tests type-check、改动 TypeScript lint、文档 19 项测试、378 页文档校验与 `git diff --check` 通过。完整桌面重启、真实付费嵌套 Pi、Git filter/LFS、外部 provider 未测；scoped pin 在 Merkle/路径索引前仍遍历平面元数据，但不克隆或读取范围外正文。3.4 / 3.4a / 3.6 继续 Partial。

**D-225 本地实施证据**：见当时提交记录。正文身份、整组 undo、耐久补偿与 `apply_patch` 读源以 D-228 为准，不得再把 D-225 写成已 Proven。

**D-228 本地实施证据**：定向反例入口为 `documents/authority-surface-identity.test.ts`（CRLF dirty B / disk A 后 edit→C、二次 edit 读 C、apply_patch 写 P 且磁盘仍 A；两 surface 路径整组应用后 disk 失败，真实 Registry 一次 undo 恢复两者且同一 `operationId` 不能再撤；UTF-16LE+BOM 补偿后字节一致；surface apply 后 I/O throw，重开 catalog 为 compensated 或 needs-attention；owner 不可用时启动对账 needs-attention）、`documents/surface-mutation.test.ts`（CRLF `bufferHash` 与序列化正文分离、同一 `operationId` 整组 undo、前向 abort 后补偿 signal 未 aborted）、`pi-host/test/harness/apply-patch-tool.test.ts`（readSource unavailable 时磁盘可匹配也不写 surface/disk；surface 整文件替换携带 revision/hash）。完整桌面 Registry、生产 Host 进程重启、macOS/Linux 会话仅未实测。不把 faux provider 写成真实模型质量。

**D-229 本地实施证据**：定向反例入口为 `terminal/shell-integration-scripts.test.ts`（Windows PowerShell 失败 cmdlet / `exit 7` / 成功分别为 1/7/0；`/bin/sh` 不注入；Bash PROMPT_COMMAND 数组与 DEBUG trap、zsh profile 文件、PowerShell 不替换 Enter）、`terminal/runtime.test.ts`（parser 已有旧 E/C 后 restart，新 zsh 初始 D 不产生旧命令，下一 commandId 属新 generation；`/bin/sh` 无 `--init-file`；无本次 integration 标识的 OSC 不生成命令）、`terminal/shell-integration.test.ts`（untagged / 错代际 OSC 不 ready）、`host/zone2.test.ts`（命令含 `</user-terminal>` 时结构仍完整）、`knowledge/context-runtime.test.ts` 与 `store.test.ts`（重建 context runtime 后重复 commandId 一条 event，projector 最多 nudge 一次）、`memory-agent-extension.test.ts`（同一 commandId 不重复进 keeper material；该文件与 nudge 链已随 D-284 删除）。zsh/macOS/Linux 真机用户终端与完整桌面 Host 重启仅未实测。不声称 Host 重启去重。

**D-227 本地实施证据**：见当时提交记录。事实名称、delivery、run 绑定、耐久证据、URL receipt 与嵌套基线以 D-230 为准，不得再把 D-227 写成已 Proven。

**D-230 本地实施证据**：定向反例入口为 `retrieval-evidence.test.ts`（任意有效行范围配无关 claim 只标 source-checked；一条来源有效、一条失效顺序互换状态一致；短 URL 有合法 receipt，换绑另一 URL 被拒绝；子会话 output handle 复制为耐久 artifact，dropSession 后仍可读；本地摘录在磁盘变化后仍指向当时身份）、`thread-facts.test.ts`（旧 Run submit 等待 Documents 期间 settle 或 lost→resume，旧提交不能写入新 Run）、`retrieval-artifacts.test.ts`（重开 object catalog 仍可读同一 excerpt）、`nested-threads.test.ts` 与 `retrieval-session.e2e.test.ts`（嵌套 retrieval 在 dispatch 时建立 isolated 冻结分支，真 child SessionHost 可读父虚拟新文件且不见后续 root live 漂移）、`web-fetch.test.ts` / `webfetch-tool.test.ts`（active retrieval 短 fetch 铸耐久 receipt，普通 fetch 不铸，取消贯通）。真实付费 retrieval、完整桌面 Host 重启与授权 web 抓取仅未实测。不把 faux provider 写成真实模型质量。

**D-231 本地实施证据**：`retrieval-session.e2e.test.ts` 经公开父 dispatch 启动真 child SessionHost，并覆盖 retrieval 的 isolated manifest、父虚拟新文件读取、LSP 首次物化到受管 scratch、settle 不发布目录结果；`nested-threads.test.ts` 覆盖 queued/直接 dispatch 固定父状态；`thread-worktree.test.ts` 覆盖 managedRoot 缺失/越界拒绝、独立 Git 与 inspect 归属；`materialization-switch.test.ts` 覆盖 staging/backup 也必须位于受管根。Application Host 生产 backend 同时授权 `{VARIN_DATA_DIR}/worktrees/<id>`、`thread-scratch/<workspace-hash>` 与已注册工作区 `.varin/worktrees`，持久记录本身不能授权。完整桌面重启和旧记录人工恢复未实测，3.4/3.4a/3.6 保持 Partial。

**D-232 本地实施证据**：`authority-surface-identity.test.ts` / `surface-mutation.test.ts` 覆盖磁盘漂移在 surface dispatch 前拒绝、CRLF 原始字节身份、明确 failed receipt 安全终止、无回执 needs-attention、逐路径补偿保留用户后写、WAL 重开对账；`recovery/engine.test.ts` 与 `PiRecoveryPanel` 接线让 durable needs-attention 可观察。Documents 的非权威 operation cache 已删除。当前文件存储无法在实际磁盘写之前持久化 intended target bytes，所以写成功到 target-after 捕获之间的崩溃仍诚实进入 needs-attention；完整桌面重启未实测。

**D-233 本地实施证据**：`terminal-projection.test.ts` / `context-runtime.test.ts` / `store.test.ts` 覆盖两个 Pi session 各有一条 event、per-target duplicate 不重入/不 nudge、持久 dedupe index 与旧行回填、写失败不推进 RAM seen；Application Host 使用保留 `targetSessionId` 的 adapter。`shell-integration-scripts.test.ts` 覆盖 PowerShell native 7、cmdlet 1、连续相同 native 码降为 1，以及 zsh 原 `ZDOTDIR` 语义；本机无 zsh，live case 跳过。产品没有 PTY restart replay，不声称 Host 重启重放。

**D-234 本地实施证据**：`web-fetch.test.ts` / `webfetch-tool.test.ts` 覆盖普通 fetch 不铸 receipt、active retrieval authority 才铸耐久 receipt、取消贯穿 body/renderer 并不缓存；`retrieval-evidence.test.ts` 覆盖完整 authority 与 exact URL/hash；`retrieval-artifacts.test.ts` 覆盖临时引用、promotion、store 重开保留同一 active Run receipt/artifact、Run 结束清理与 Thread 删除同时释放 sealed/temporary/receipt；`thread-facts.test.ts` 覆盖 catalog 提交竞态；`phase3-e2e.test.ts` 与 `retrieval-session.e2e.test.ts` 覆盖公开 `read_thread(offset,length)` 的 UTF-8 字节切片和真 child 流程。真实外部 web、完整桌面 Host 重启与付费模型质量未观察。
