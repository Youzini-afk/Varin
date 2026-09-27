# 决策分卷：权限

范围：3b.x 权限三层、交互确认门、插件共存与范围边界。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-021 · 2026-09-03 · 3b.3
类型：偏离（已回退）
决定：~~从 `FOUNDATIONAL_PI_PACKAGE_MANIFEST` 移除 `@gotgenes/pi-permission-system`（revision 2→3）。~~
原因：~~计划要求"已安装实例不删不迁"。保留类型字面量让 protocol 消费方仍能处理旧快照中的 permission-system 条目，但不再自动 provision。~~
状态：已回退。原生 tool_call 门控尚未接进 Pi 会话生命周期，移除既有权限边界留下未覆盖的安全缺口。在 3b.1/3b.2 e2e 通过之前保持 revision 2 不变。

### D-025 · 2026-09-03 · 3b.1
类型：偏离
决定：权限门控的纯类型和评估函数（`evaluateGate`、`defaultRules`、`isHighRisk`、`mergePolicies`）从 web application-host 移到 `@piarium/protocol/permission-gate.ts`，使 pi-host 和 web host 都能 import 而不产生跨包依赖。web 的 `permission-gate.ts` 改为 re-export（保留本地 `isHighRisk` 扩展版，覆盖 write/edit 工具和 path 参数）。pi-host 新增 `permission-gate-extension.ts`，在 `tool_call` 钩子里调用 `evaluateGate`，返回 `{ block: true, reason }` 阻止 ask/deny 决策。
原因：(1) 权限评估是纯函数，不需要 host 上下文，放在 protocol 层让两包共享。(2) pi-host 的 `tool_call` 钩子是 Pi 的原生扩展点，在工具执行前拦截，不需要 bridge round-trip。(3) policy 在 session 创建时从 `harnessSettings` 解析并冻结，避免每回合解析。(4) mode 当前硬编码为 "normal"——TODO 从 settings 解析实际 mode。
考虑过的替代：(1) 通过 bridge.request("permission.gate", ...) 让 host 评估——增加每工具调用的 round-trip 延迟。(2) 在 host 侧用 Pi 的 permission_system 包——已移除（3b.3），用原生实现。(3) 在 protocol 里只放类型，评估函数留在 web——pi-host 需要复制评估逻辑。
影响：`packages/protocol/src/permission-gate.ts`（新文件，类型 + evaluateGate + defaultRules + isHighRisk + mergePolicies）；`packages/web/application-host/lib/harness/permission-gate.ts`（改为 re-export + 本地 isHighRisk）；`packages/pi-host/src/harness/permission-gate-extension.ts`（新文件，tool_call 钩子）；`packages/pi-host/src/session-host.ts`（注册权限门控扩展，提前解析 harnessSettings）；`packages/pi-host/test/harness/phase3b-e2e.test.ts`（新文件，12 测试）。
状态：已实施（smart mode 未接线 permissionJudge model slot；mode 硬编码为 normal；accept-edits/bypass 模式未从 settings 解析。这些在后续阶段填充。）

### D-035 · 2026-09-04 · 3b.1 / 1.1（权限三层与 Host 静态授权）
类型：偏离
决定：权限不再寻找"唯一安全边界"，明确为三层，各有能管与不能管的范围：

1. **pi-host `tool_call` gate**：唯一做 allow / ask / deny 与 UI 交互的层；也是 `edit` / `write` / `apply_patch` 这类在 worker 进程内直接写文件的工具**目前唯一可阻断的门**。
2. **Host service authorization**：不弹窗、不重算用户策略，只验证 `ActorContext`、RunManifest 里的静态 capability、workspace / path 包含。覆盖 `shell.* / output.* / search.* / thread.* / fs.lock / lsp.*` 等经 host 中介的能力。用户关掉 `bash` 后本次 Run 的 capability 不含 `process.shell`，直接到达的 `shell.exec` 必须被拒——这不是第二套策略，是防绕过工具入口。
3. **OS containment**：将来限制 worker 绕过工具直接访问文件与网络（设计 9.1.1）；当前不具备，设计文档必须明说：**host 对 worker 本地文件写入只能观察，不能阻止**。

威胁模型写明：worker 是 host 自己 spawn 的同 OS 用户子进程，本来就有整个文件系统；Host 授权防的是**跨会话串线、陈旧 worker 污染、第三方 Pi 扩展借 host 能力越权**，不是防同权限下完全恶意的 worker。

`ActorContext { authorityInstanceId; sessionId; runId; workerId; workerGeneration; workspaceId; grantedCapabilities }` 只能由 broker 信封与 host 注册表生成。broker 规则：`session.open` / `session.create` 的**方法响应**成功后写入 `{ sessionId, workerGeneration }` 作为 pin；`session.snapshot` 只能验证与更新状态，不能重绑身份，不一致视为协议违规（诊断 + 忽略）；`session.closed` 不能仅凭 worker 自报清空 pin，关闭必须是 broker 发起成功或连接确认终止；未 pin 的 worker 发出的 harness 请求一律拒绝（catalog worker 没有会话，本就不该发）。Router 从信封取 ActorContext，`HarnessRequestData` 删除 `sessionId`。Host 授权按风险类别：`read`（search / output / lsp）、`process`（shell）、`control`（thread send / kill / merge）、`write`（未来经 host 中介的文档写入）。

过渡：RunManifest 落地前，host 从 broker 验证后的首次 `session.snapshot.activeTools` 与 Host 实际服务可用性推导 capability 并随会话注册冻结；不二次读取可能已变化的设置。RunManifest 下发后收敛为显式单一来源。

真值表（pi-host gate，进设计 9.1.2）：

| 规则匹配 | 高风险 | 本会话已授权 | 结果 |
| --- | --- | --- | --- |
| deny | — | — | 阻断 |
| allow（含 bypass、用户显式 allow 规则） | — | — | 放行 |
| ask | 否 | 是 | 放行 |
| ask | 否 | 否 | 弹窗；"Allow for this session" 记入授权 |
| ask | 是 | 任意 | 弹窗；"Allow for this session" **不**记入授权 |

工作区提供的 regex 规则须做 ReDoS 防护（长度上限 + 简单模式检查或线性时间引擎）。
原因：router 从 `envelope.data.sessionId`（worker 自报）取身份；broker 信封的 `sessionId` 又来自 worker 自己发出的 `session.snapshot`（`host-client.ts:340`），两层都不可信——worker 发一条伪造 snapshot 就能把自己重绑到别的会话，在别人的 shell 里执行命令。上一轮把 `parentSessionId` 从 params 挪到 `ctx.sessionId` 只是把信任下移了一层。
考虑过的替代：(a) 只改 router 用信封字段——信封本身不可信，改了没用。(b) Host 也做 allow / ask / deny——与 pi-host gate 双重门控，两次弹窗或两处不一致，正是插件共存时出过的问题。
影响：`packages/runtime-broker/src/{host-client,runtime-broker}.ts`（pin）；`packages/protocol/src/harness.ts`（删 `sessionId`，加 `ActorContext`）；`packages/web/application-host/lib/harness/{router,harness-services}.ts`；设计 9.1.2、architecture §5.1 回写。D-025 在索引中标 superseded。
状态：已实施（P0 第 1、2 项）

### D-044 · 2026-09-04 · T2（权限插件共存与 scope 的真实边界）

类型：设计修正

决定：(1) `@gotgenes/pi-permission-system` 继续作为 foundational Pi package provision，不再把 T2 之后移除插件当作默认路线。
在会话发布了与本 sessionId 对应的 permission service 时，Piarium 原生 `tool_call` 门完全让位，由插件单独提示；service 缺席或
热卸载后原生门恢复，作为 **Harness 工具范围内**的 fallback。检测每次按 session-keyed service 重新确认，不因其他会话事件串线，
也不缓存已经失效的服务。(2) 原生 Smart 只属于 fallback；插件活跃时若需要模型判断，走插件的 `registerAuthorizer` seam，且仍需
用户在 `authorizerChain` 中显式列名，Piarium 不暗改插件配置。(3) 删除 Web/Application Host 中未接生产链的 `smart-mode.ts`
原型，实际实现只有 pi-host 会话内的一份。(4) child Run 的工作目录先注册为独立 Documents workspace，再绑定 Pi session；
`scope` 随 broker Actor 传播并约束 Host 可解析路径的服务与搜索结果。它不是 OS containment，不声称约束 shell 命令文本或 worker
内直接运行的 Pi 工具。

原因：对本机实际 provision 的 `pi-permission-system` v27.0.1 公共声明与文档核对后，它已覆盖 Bash AST 拆分、规范/符号链接路径、
外部目录、MCP、skills、子会话转发、会话授权、审计以及跨扩展 formatter/extractor/authorizer API；原生门只认识
`HARNESS_TOOL_META`。按旧计划移除会真实缩小保护面。简单地同时运行两个门又会连续弹两次确认。另一个实锤问题是 isolated
child 曾绑定父 Documents workspace，使 Host 搜索和路径 authority 指向父树而不是 worktree；单独 runtime workspace 修复该身份错误。

考虑过的替代：(a) 原生门优先、插件随后再判——无法保证一次提示，且两套路径/命令语义会漂移。(b) T2 结束立即移除插件——
没有能力等价证据。(c) 自动把 Piarium Smart link 写进插件 `authorizerChain`——注册 link 本身不应取得用户授权，违反插件公开契约。

影响：`permission-gate-extension.ts` / SessionHost；Thread runtime、broker actor scope、Host path/search authority；设计 9.1.2、
plan 3b、状态矩阵。

状态：已实施
