# Rust kernel R0–R3 审查与返工记录

Status: historical D-278 audit; D-279 closed its R2/R3 gaps and D-282 later completed Stage R

Last updated: 2026-09-15

## 1. 结论与范围

审查基线是 `e465e2df`，即此前标记 R3 Complete 的提交。本轮从实际生产装配、权限和文件资源边界、durable operation、GC、物化与 Thread 生命周期往下追，再用真实 release kernel 反例验证，而不是从状态文档或测试总数推导完成度。

结论：**架构方向成立，但此前 R2/R3 的完成度高估；存在可以复现的数据安全、权限边界和生产装配缺陷，不只是代码风格问题。** 首批独立编写的十个反例在修改前的 release binary 上全部失败；随后又复现 GC 对象复活删除、未完成 operation 被释放、查询 pin 跨 epoch 泄漏和 Documents 嵌套 scope 绕过。本轮已修复这些问题，并补入正向消费者验证。当前里程碑以 [status.md](../status.md) 为准；下表保留 D-278/D-279 当时的判断，R0/R6 已在 D-282 后完成。

| 阶段 | 本轮判断 | 依据与边界 |
| --- | --- | --- |
| R0 | Partial，保持 | framed process、epoch/grant 和实际子进程证据存在；本轮补 CI 的真实 kernel 验收入口，不声称打包/任意 cwd/饱和队列取消均已验证 |
| R1 | 核心状态/存储接管 Complete，已完成本轮正确性返工 | Rust 仍是根、对象、引用、revision 和 recovery metadata 的生产权威；GC 和 epoch pin 的实质缺陷已修，未恢复 TS writer |
| R2 | **Complete（D-279）** | D-278 的物理互斥/coverage/owner/重试修复保留；`file.operation.list/reconcile` 现在把 pending operationId、路径、reason/disposition 暴露给 Host，并以真实 restart 反例证明证据不足的目录 rename 不会隐身或被猜成成功 |
| R3 | **Complete（D-279）** | 固定 root/revision/writeRevision、同一 kernel operationId、persistent handoff pin、Git executionBaseline receipt、Thread Registry 与 execution view 已形成可重入持久交接；setup timeout/abort 等待真实 child close |

不增加新的产品范围：本地 macOS/Linux 机器、购买签名证书、物理断电实验、真实付费 Pi 会话都不作为这次返工的硬门槛。native 平台验证交给已有 CI；普通 copy 是正式后端，未测文件系统不宣称已证明 CoW。R4–R6 当时不在本轮迁移，后来分别由 D-280–D-282 完成。

## 2. 已修复的问题

### 2.1 资源互斥与授权不是同一个关系

旧 `file_resources.rs` 用 rootId 划分冲突域，因此父目录注册为一个 root、子目录注册为另一个 root 时，同一物理文件可以有两个 writer。旧 `assert_file_lease` 又用对称 overlap 判断覆盖权限，使子树租约反向覆盖祖先，exact 租约覆盖同路径 subtree 请求。复用 leaseId 不检查资源集合，目录 junction/alias 还可形成另一条逃逸路径。

修复后的 `storage/file_resource_leases.rs` 单独表达两个关系：**overlap 对称，covers 有方向**。授权归属仍检查 grant/root/workspace；互斥按 canonical 物理路径跨 root 检查。路径前缀使用路径段，不把 `root-other` 当 `root` 子级；leaseId 重用要求逻辑资源和物理身份完全相同。

Host 的嵌套操作也不能自认已经获准。新增生成协议 `file.lease.check`，`KernelFileResourceBackend.gateFor` 和生产 Documents 嵌套路径都进入这个内核检查。禁止 TS 仅按相同路径键跳过 exact/subtree 差别。新模块仍共享唯一 `Storage`，没有引入第二个数据库、锁服务或事务框架。

对应真实测试：跨 workspace/root 注册互斥、祖先删除拒绝、exact→subtree 拒绝、leaseId 变更拒绝、junction 别名互斥、嵌套 Host gate、真实 Documents 嵌套 gate。

### 2.2 路径准入与对象归属不能被参数声明替代

旧注册 root 在后续访问前不重查其 canonical 身份；注册路径被 junction 替换后，可以把外部目录解释成原授权 root。旧 lexical scope 也没有约束链接解析后的实际路径。`file.apply` 存在用同 workspace 的另一个 grant 的临时 owner 写出正文的路径。

现在每次资源解析重核 registered root 和解析后 canonical scope，目录 inventory 遇到不可无损表达的名称明确失败。file apply 验证 owner 的 hash/workspace/grant；无 owner 的 regular-file 应用只允许明确的 Host maintenance authority。完整 root materialization 不允许以窄 scope grant 读取整个来源视图。

这属于私有 Host/kernel authority 边界修复，不是已经证明存在公开远程攻击入口。当前实现仍然使用路径解析后执行文件 I/O；它**不等于**句柄级防竞态 sandbox，也不是对任意外部进程的 OS 原子 CAS。后续若要求该威胁模型，须明确设计 handle-relative I/O，不能靠增加 `canonicalize` 次数冒充。

### 2.3 operation 重试不得重放不可逆副作用

旧 remove 在磁盘删除完成、terminal finish 失败后，会在同 operationId 重试时再次删除。反例在两次调用之间重建用户文件，第二次调用把新文件删掉。旧 rename 则把“source 不存在且 target 存在”当成功，甚至第一次调用也会如此；target 可能完全无关。

现在中断 remove 只对账，不破坏重现的路径。rename 在副作用前持久 source state；只有 source 已缺失且 saved regular-file/symlink state 与 target 完整匹配时才补成功，目录级证据不足则保持 pending/needs-attention，不猜成功。ephemeral leaseId 不再参与 durable operation 参数身份，重新授权的租约不改变同一次业务意图。root-registration reconciliation 也不能越过仍在使用的物理 lease。

`file-resource-backend.ts::applyState` 同时改为传播条件冲突，不能把 detailed conflict 丢弃成成功的 `Promise<void>`。该契约与 `KernelRecoveryContentStore` 保持一致。

### 2.4 GC 必须尊重重新安装和未完成操作

旧 `pending_gc_files` 删除意图在 blob 被重新安装、重新被分支引用后仍可生效；重启 drain 会删掉新引用需要的正文。旧 GC 还会移除非 committed operation 的归属记录，`operation.release` 也没有阻止释放 started file operation，破坏其启动对账。

`storage/gc.rs` 在物理清理前重查新 catalog 事实；重新建立 owner 时撤销陈旧 cleanup intent。操作归属由明确的终态/释放流程管理，GC 不把 started 当垃圾。`operation.release` 对 pending operation 返回 in-use。未完成 materialization 的 immutable source root 进入 GC 活根，即使调用方分支或 query pin 消失，也保留恢复所需对象。

对象 owner 的安装不再用 `INSERT OR REPLACE` 覆盖其他身份。已有 ownerId 的 hash/workspace/operation/grant 不一致时拒绝。

真实反例覆盖 cleanup failure→重新安装→branch 引用→restart、pending mkdir→release/GC→restart reconcile，以及 materialize backup 后故障→删除 source branch→GC→restart promotion。

### 2.5 瞬时 pin 与持久 pin 分开结束

旧 query pin 带 ephemeral 标记，但正常打开 catalog 时未清除上个 kernel epoch 的 ephemeral rows。即使分支已删除，孤立 query pin 仍永久保留对象。

`storage/core.rs` 在 schema 校验及独占 storage ownership 下清除旧 ephemeral pins。显式 revision pins 保留，pending materialization 依靠自身 durable source-root 引用保留恢复资料，不借用失效 query handle。测试同时证明“旧 query 对象可回收”和“独立 durable pin 正文仍可读”。

### 2.6 物化要保护未收集内容，并正确恢复权限

受管目录的位置不构成里面所有内容的删除许可。旧 materialize 可以替换非空 live，验证失败还直接删除 live 恢复 backup，可能抹掉外部后写。

现在 fresh materialization 只接受缺失/空目录或已与来源一致的视图，未知内容明确冲突；中断状态先对账，不原地重新构建。terminal receipt 重放不再顺手删除后来出现的 side paths。写后校验失败保留 live/backup，而不是猜测性补偿。

readonly file 安装先取得 flush handle，再恢复权限并 flush，不在文件只读后重新以 WRITE 打开。树物化先安装子项再恢复只读目录 mode，并逐目录同步自身 entries。Windows 的 mode 比较投影到可观察 readonly 位，不把 Unix executable 位误报为磁盘差异，也不把所有 mode 校验丢掉。

### 2.7 owning/execution workspace 与 managed-root admission

原 `withBranchStore` 用“actor 对象存在”判断是否为 session actor。仅包含 executionWorkspace 的合法 Host lifecycle hint 被移除了 maintenance capability，而生产 resolver 又要求准确 sessionId，导致实际基线链失败。

原 materializer 又把目标本身送入 Documents root resolver：一旦它得到实际 child execution workspace，原 owning-workspace grant 就不匹配；或者 target 成为 root 本身，没有合法的相对物化目标。此前使用临时目录和简化 resolver 的测试没有覆盖这一点。

现在维护操作以准确 sessionId 是否存在区分，不伪造 session。捕获/settle/reclaim 继续使用真实 execution workspace；materialization 独立经 `managed-root-admission.ts`，以 owning workspace 下保留的 Thread/worktree 记录和已有 ownership assertion 证明目标及 managed container。删除了按 application-data 目录前缀猜测并创建 root 的退路。

新纵切使用真实 DocumentAuthority、不同 owning/execution identity、同一个生产 admission helper 和 release kernel，完成 capture→branch→materialize→目录修改→publish→比较→原路径重建。未知 Thread 目标、其他 owning workspace 请求也明确被拒绝。

### 2.8 分页与测试不能伪造固定视图

旧 file.scan 每页都重新枚举 live 目录却只携带 offset。新增/删除排序靠前的条目会移动后续 offset，使调用方收集到重复或遗漏路径。现在第一页返回 fingerprint，后续页必须提供 expectedFingerprint；inventory 变化明确失败，不拼出伪完整清单。

这只修正确性，**没有声称解决性能**：当前仍每页重扫/排序，Host baseline 仍逐文件 RPC 收集 metadata。真正的批量 capture-to-root、稳定扫描游标和原生预算计算是后续明确的收敛方向，不能用“改用 Rust”代替复杂度分析或性能数据。

ThreadRuntime 曾用 `.catch(() => null)` 吞掉 branch metadata 读取错误以兼容不完整测试对象。本轮移除此生产错误吞咽，修正 fixture 为合法 branch shape，让发布失败保持失败。

## 3. D-278 时点未闭环、D-279 已关闭的具体事项

### R2：未决文件操作的产品处置

`file.root.register` 返回 pendingOperations；`KernelStorageAdapter.fileAuthorityContext` 当前只提取 rootId/canonicalRoot，没有把低层未决操作转成 Host 可列举、可解释、可重试/保留的处置状态。中断目录 rename 只有目录类型/mode，不足以证明整树是本次产物；本轮安全行为是继续 pending，而不是制造成功。

因此“生产单一 file authority 已接通”成立，“所有启动失败窗口都已形成可处置恢复闭环”尚不成立。下一步应让 low-level operationId、目标身份、当前可证明状态和上层 Recovery/Files 请求关联起来，并验证重启后不能隐身。不是重新做 R1 writer 迁移，也不是另建 TS 数据库。

### R3：kernel promote 与 Host/Git/Registry 交接

`thread-runtime.ts::materializeExecutionView` 的 native 路径使用随机 operationId 调用 materializePinManaged，随后 attachIsolatedGitContext，最后 persistWorktree 和 executionViews.bind。旧 TS 路径持久化 materializationSwitch journal，但 native 路径并没有一条贯穿 source root/writeRevision、kernel operationId、Git executionBaseline 和 Registry binding 的等价持久交接。

kernel 能恢复目录，不代表 Host 能证明“这是哪个固定输入、Git 上下文是否完成、该 Run 是否可以开始执行”。Git attach 失败、Host 在 promote 后退出、Registry 持久化失败等窗口不能靠再生成随机 operationId 或重读当前 branch 消除。本轮先阻止未知内容被替换；完整解决需要 Host 持久 switch intent 与 kernel receipt 的明确协议、同 operationId 重入和跨层故障纵切。

此外 `thread-worktree.ts::runSetup` 的 timeout/abort 在发出 kill 后立即 reject，未以真实 child close 决定准备已停止。它属于生命周期检查项：应在进入可回收阶段前确认实际退出，不能等同于“R4 尚未迁移，所以现在可以提前释放目录”。本轮未把通用 process/PTY backend 搬进 R3。

### D-279 关闭证据

R2：kernel 新增 typed `file.operation.list/reconcile`，Host `KernelFileAuthorityContext` 保留每个未决 operation 的 operationId、kind、paths、disposition 与 reason，并暴露显式 reconcile。真实 release-kernel audit 注入目录 rename 在 side effect 后丢失 terminal finish，重启后 operation 仍可列举；由于目录元数据不足以证明整树来源，显式 reconcile 继续保留 needs-attention，而不是重放 rename 或制造成功。

R3：Thread Registry 持久化 `materializationHandoff`，固定 source root/revision/writeRevision、operationId、pinId、stage 和 Git receipt；current-root handoff 使用 maintenance-scoped persistent pin 跨 kernel/Host restart 保活。native materialize 与 Git attach 均以同一 handoff 重入，Varin-owned Git baseline attach 幂等；进入 `git-attached` 后必须先成功释放 durable pin 才清 Registry intent，失败则保留 receipt 供下次恢复。setup timeout/abort 发送 kill 后等待 child `close` 再结束。

复核证据：统一 `bun run test:kernel` 57 passed：真实 release kernel child-process 25/25、file-resource audit 26/26、storage adapter 5/5、kernel-backed combined Recovery 1/1；IntegrationCoordinator 37/37（已移除对退役 SQLite 内部表的依赖，改用 current durable port），ThreadRuntime/ThreadWorktree 91 passed / 1 platform skip；Application Host type-check、protocol drift、release build 与 diff check 通过。由此 D-278 的 R2/R3 reopen gate 均关闭。

### R0 与工程质量后续

`runtime.rs` 的 stdin reader 兼读 request/cancel，但普通请求入有界 channel 时使用阻塞 send。满队列后取消帧的可达性仍需饱和队列下的实际 kernel 验证；这是源码审查风险项，不把本轮未复现的场景写成已证明缺陷。frame EOF/截断、grant revoke 和现有 cancellation 用例仅证明各自测试窗口。

现有 `thread-runtime.ts`、`storage-adapter.ts`、`file_resources.rs` 仍承载过多职责。建议按“持久 switch coordinator / Git execution adapter / resource operations / scoped object ownership”拆分，而不是泛化成 plugin framework 或多存储微服务。旧测试 seam 应结构性限制在测试装配，而不只靠注释声称不可达。文件 wire result 仍多处使用 `Record<string, unknown>` 与 stateJson，适合逐领域补生成结果 DTO；不要再手写另一套漂移合同。

## 4. 测试证据与 CI 修正

`file-resource-audit.test.ts` 将跨根互斥、租约覆盖、路径身份、owner、重试、GC、pins、物化冲突、分页及真实消费者放在实际 release kernel 上验证；没有把 mock 的返回值计为 Rust 行为。

`kernel-durable-engine.test.ts` 原先用了 fake Documents 与 no-op resource gate。本轮改为真实 DocumentAuthority、KernelRecoveryContentStore、KernelRecoveryStore 和生产形式的 resource gate，保留显式模拟的 Pi navigation adapter。它证明真实文件/元数据/Host gate 加 kernel restart/undo，不冒充真实 Pi 模型会话或完整浏览器 UI 测试。

新增 `bun run test:kernel`：先拒绝缺失的 release executable，再分别用 Node 跑 kernel-client.test.ts、用 Vitest 跑 audit/storage-adapter/combined recovery。`--build` 从现有 rust-toolchain.toml 读取钉住版本并构建。现有 Linux source-quality 与 Windows runtime CI job 均执行该入口，不新增本地跨平台门槛。普通 Vitest 排除 Node-only kernel suite；无 kernel 的通用单测可跳过 native suites，但专用验收绝不把 missing binary 解释为成功。

本轮本地验证结果以提交前实际命令为准；CI workflow 修改不等于远端 CI 已运行通过。`integration-coordinator.test.ts` 本轮复跑仍为 **17 failed / 20 passed**，还出现失败断言后的 SQLite fixture 清理 EBUSY。失败既有直接读取退役 SQLite 表的断言，也有 operationId 复用、父 turn binding 和 final-commit-failure 行为断言；在用真实 durable port 重建 fixture 并逐个复核前，不能把全部失败认定为测试过时。该套件本轮未通过，不计入通过数，也不以恢复 TS production writer 或删除断言来掩盖。

通用 Documents surface-CAS fixture 原先把注入的 backend gate 再回调到 Documents 自身；生产 nested shortcut 删除后暴露递归。该顺序执行的 unit fixture 改为明确独立的 backend seam，正文/修订/磁盘不变性断言保留；实际嵌套权限继续由真实 kernel audit 验证，不把 unit seam 算作生产 gate 证据。

### 本机验收记录

2026-09-14，在 Windows x64 上使用本次源码构建的 release kernel：

| 验证入口 | 结果 | 说明 |
| --- | --- | --- |
| `bun run test:kernel` | 56 passed | Node kernel-client 25；新增 authority audit 25；storage adapter 5；真实 Documents/gate combined recovery 1 |
| Documents / surface mutation / Files / Thread / nested / execution baseline / switch / space，9 个 focused suites | 184 passed / 1 platform skip | 保留既有产品和纯 unit seam 的回归检查；不与 native 证明混同 |
| `integration-coordinator.test.ts` | **17 failed / 20 passed** | 明确未收口；不计为通过，也不全部归咎于旧 SQLite 断言 |
| Rust unit tests / release build | 4 passed / build passed | 包含物理 lease overlap/coverage 的独立单测 |
| Application Host source/test TypeScript、targeted ESLint | passed | 包含新增 consumer、测试与专用 runner |
| protocol generation drift、`cargo fmt --check`、`git diff --check` | passed | 请求 DTO/运行时入口和格式保持一致 |
| engineering docs / docs validation / CI YAML wiring | 19 passed / validation passed / wiring valid | 378 pages、45 engineering docs、317 local links；远端 CI 尚未据此声称通过 |

## 5. 架构与可维护性评价

值得保留的是三条权威边界：Rust 的 immutable root/object/recovery writer，Registry 的未保存 buffer 与 grouped undo，Host/Pi 的产品调度和真实会话。这次问题并不说明需要推翻架构；它说明边界在关键失败和组合场景中没有被完整落实。

“优雅”应体现在状态数量少、归属清楚、失败能解释、错误不可被普通调用绕过，而不是 Rust 文件数量增加。本轮因此只提取物理租约模块和受管路径准入模块，把 overlap/coverage、owning/execution、ephemeral/durable、receipt/retry 分清，没有增加第二个 authority、兼容 reader 或 fallback backend。

不采用全仓重写、无证据评分、伪精确完成百分比。下一次收口应以明确消费者和故障窗口验收：先完成 R2 未决状态处置与 R3 持久 switch handshake，再继续 R4；保留本轮反例作为不可回退的验收边界。
