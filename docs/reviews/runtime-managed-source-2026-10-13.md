# 同源 managed Host 执行

基线：`b5265a757bd96ec561ed748f39fce8fb8b4799bf`。依据[运行时设计 §22](../design/agent-runtime-design.md#22-多环境远端与平台)和[能力设计 §5.3](../design/runtime-extensibility-design.md#53-环境是一组相互一致的能力)：操作固定环境，文件、Shell 和语言查询不得错读协调机同名路径。默认仍为 Pi；本片不重新实现已有整 Host 远端连接、VM 或远程桌面。

本轮同源文件、进程、上下文、child 与原回执主链已实现并通过下列组合核验。完整 managed 环境仍有后文列出的消费者缺口。本页按实际 owner 区分能力和证据，不以类型通过代替远端执行。

## 共同合同与实际消费者

- `SourceResourceOwner` 是必填的 local / managed_host 标记。后者固定 Host、原连接和不含凭据的 endpoint identity；启动、来源继承、子任务、工具、历史恢复与查询共同保存这一身份。切换侧栏或配置不能重定向已受理工作。
- 协调端 A 的 Catalog 独占 Agent 意图、模型、取消、关联与交付；资源端 B 的原 Storage source authority、KernelToolExecutor、文件 journal 和进程 guardian 保执行事实。B 不建立虚假 Run，也不把 B 对象 hash 直接写作 A ContentStore 引用。确实消费的正文经原通道传回，由 A 原内容 owner 保存。
- Source picker → application client → 认证 Router → B Documents 只解析一次目录，后续 prepare 使用冻结 workspace ID。fixed、materialized、live 都沿原 source 能力目录，不增加一份 TS 工具名单或绕开原真实调用授权。
- 文件与进程走原工具 Operation；结构、语言、PDF、指令/skills 等走封闭的 source service。B 的原 grant/path scope、语言准备和取消仍有效；A 的模型凭据、Bot 身份、记忆和全局配置保原归属。派生语义缓存包含完整 owner 身份，B 的结构 recipe 也在 B 计算。
- 新 epoch 只阻止旧 authority 的新派发。已接受进程继续按原 principal/coordinator/authority/epoch/operation 读取、停止和对账；失联不伪装为退出。控制请求独立发送，恢复只观察原 operation，不重发效果。原 guardian 的真实 tree-stop 是进程终止证据。
- 取消与执行请求可能乱序抵达。原 Catalog 的取消意图持续作用于同一进程地址；取消先到、随后才受理的进程仍会被原 watcher 停止。一次 missing/网络失败不是停止证明，也不会触发重新 execute。
- 子任务沿 B 原 handoff 或确切 predecessor result 准备私有来源；durable pin、candidate、publication 和 Integration journal 留在 B。续接不借用随机父源 pin，已准备结果的恢复不要求旧 working directory 再出现。未知 Integration 由原 B journal 回答，无第二回执表。
- 同名 Thread/Run 或声明的 lineage 不构成资源授权。进程及 child result 的创建 grant 固定原 principal/coordinator/source；续接只能沿原已提交 handoff 与 branch 来源核对，不能借另一个连接重用裸 ID。
- 远端上下文读取、语言引用、Host service 和资源 grant 各沿实际 owner 排空。普通 Run 退休不撤销仍由原 Operation 持有的 caller authority；明确 revoke 的范围更广。传输请求去重只保活跃工作与短结算事实，不永久缓存文件/PDF正文。
- managed 工具的原只读回执也需处理丢回包：仅在该跨 Host 执行边界使用 B 原 operations 与 blob/object owner 保完整结果，正文准备及解引用在 worker。grant 退休、撤权或换 epoch 不表示 A 已收到结果，因此不能删除唯一原回执。A 原 InvocationRunner 持久结算后经冻结 ToolDirectory 转发清理，B 原 operation 只去正文引用、保短 released 身份，迟到重投不能重读变化后的文件。正常/恢复/启动清理均沿原 Operation；失败不反改已确认结果。普通本地只读快路径不增加持久受理事务。
- Bot 删除原 scope 前，在 worker 等已交付 managed read 的确切清理 ACK，再回 Catalog 原 gate 删除；网络失败保原 Run/地址供重试，不持 Catalog 锁等网络。明确没有 B 读记录的取消也沿原身份留下短释放记录，started/Unknown 仍不能提前销毁。

## 明确剩余实现

以下当前会返回具体不可用原因，不尝试协调机同名路径：

- 跨 Host 组合文件恢复。需将原 journal 与对象传输按 owner 接通；历史读取和仅对话导航已有路径。
- B 文件 followup 的事件回传、交互 PTY 的目标终端接入、managed persistent script 环境。
- 项目绑定 MCP / scheduled task 的目标配置消费者。

来源扩展包 staging 和 Experiment 输入已经接入，分别见[包捕获](runtime-managed-package-2026-10-13.md)
和[实验输入](runtime-managed-experiment-input-2026-10-13.md)。来源身份与实验执行机器独立，原有远端
Experiment backend 继续消费协调端已固定的输入。

这些是本设计的真实后续接入工作。Computer 的分配目标仍独立于文件 Source，应用工具接入另沿原 Computer owner 推进。真实双机认证/网络故障、部署安装、平台行为、实际模型与长期负载仍需要相应外层环境验收。

## 当前有限证据

- 协议/application-client 构建与完整 Host production/tests `tsc --noEmit` 已通过；原 mandatory owner fixtures 已迁移。varin-runtime 所有 Rust 测试目标 `--no-run` 编译通过，未执行全套；生成合同检查通过。该结果不包含完整 Web browser/CLI 构建，也不是跨 Host 行为证据。
- 原本地 continuation helper 提取后，只选其 4 类 startup 与 language-drain 取消共 5 个用例通过，7 个同文件其他用例未执行。使用原 Host/store adapter 的受控 Storage 端口，无产品 listener。
- 独立生产 `ManagedSourceBridge` 的 9 个内存端口用例及 1 个乱序反例通过，检查原地址、预派发取消、首次双断线后的观察恢复，以及 cancel 先到、execute 晚受理后只重驱原 stop。它不证明 B 实际文件或进程效果。
- 最终 5 个 Rust 组合用例全部通过：A 真 Catalog/KernelToolExecutor 经原私有 Host bridge 调用 B 文件读取，丢成功交付后从 Unknown 按 B 原回执恢复；B 超过 256 KiB 的完整读取在文件改变、撤权、GC 和 Storage 重开后仍返回原正文；真实进程交互及重开回执、跨 principal/coordinator 拒绝；child fixed → handoff → 私有物化/写入 → candidate → 工作目录移走后的 result-only 读取/发布 → continuation，包含原进程跨续接输出与三枚真实 handoff pins/不用分支的清理。
- 原 ExecutionEngine 恢复模型工具配对后，policy read 实际经过冻结 ToolDirectory/SelectedCall 与持久结算 hook。首次清理传输失败后按原 Catalog 重试，B 的 GC 确实回收已释放正文，A Catalog 重开仍读原结果；Bot 删除首次清理失败保留 Run，原地址重试成功后才实际删除。日志中的清理失败是这个明确注入点，没有被当作成功或略过。
- 上述 Rust 用例执行当前编译的 kernel lib、真实 SourceDispatch/Storage 与未改源码的原 process worker，Host helper 使用 stdio/direct Router。组合不是部署了两台真实机器，也没有启动产品 listener 或调用模型。
- child 的 Catalog dispatch/continuation envelope 在该组合中受控；B 的 handoff、物化、process、candidate、publication 和释放原语实际执行。A 的普通读取、policy、丢交付恢复与删除清理使用真实 Catalog/执行器，不能把这些证据泛称所有 child 产品路径均已完整部署验收。
- Source picker、direct Router、PDF 分页、语义来源、原 schedule 错误投影与本地隔离已有聚焦 consumer 证据；受控 kernel/provider 的范围不升级为真实模型或产品网络通过。

组合入口为 `kernel/crates/varin-kernel/src/managed_source_review.rs` 和原 stdio helper
`packages/web/application-host/lib/harness/managed-source-host.test-helper.ts`。执行前独立检查 imports、hooks、constructor/default transport；不得以文件名推断无需监听，也不运行旧默认 KernelClient/HTTP listener 测试替代当前允许的 stdio / direct Router 入口。
