# 运行时控制路径隔离增量

日期：2026-10-09（Asia/Singapore）。起点：`c064883d`，分支 `implementation/native-agent-runtime`。
对照：[总设计](../design/agent-runtime-design.md)、[能力组合设计](../design/runtime-extensibility-design.md)、[前次审阅](runtime-2026-10-09.md)。

本阶段优先处理前次审阅确认的公共阻塞点。范围是 Run 启动恢复、物化执行、工具资源准备及策略正文；没有切换默认产品运行时。

三个实现 worker 在独立工作树施工，三个 hack 分别验证内容/恢复、资源调度和实际物化。主代理核对关键逻辑、处理接口及合并，并复验合并后的共同路径。普通工具结果与默认 UI 没有增加阶段诊断文案。

## 结构与验收边界

| 路径 | 所需合同 | 需要验证的交错 |
| --- | --- | --- |
| Run 启动及恢复 | 先返回已受理 Run 的控制句柄，独立 worker 读取固定历史与正文；短事务核对 epoch、分支、head 和相关事实后发布 | 慢正文与无关控制并发；准备期间取消；排队晋升；恢复不重发旧模型或副作用；内容回收 |
| 文件物化 | Storage 保留授权、物理租约和 journal；目录构建、内容校验和恢复观察在独立 worker；短控制边界许可提升和提交回执 | 大目录与进程/文件请求并发；目标外部改变；撤权/取消；备份与提升中断；恢复和关闭 |
| 工具资源准备 | 无 I/O 的预规划声明已知资源或待解析范围；每项独立解析、准入和结算，可能冲突的早到调用保留顺序 | 慢规划与无关调用；别名同文件；跨 Run 冲突；完整多资源准入；取消和容量公平 |
| 策略正文 | 请求、读取图结果、规划输出/证据和拒绝输出在 Catalog 锁外存取；内容寿命引用跨越写正文到发布引用 | GC 与未发布正文；新的输入、取消和旧 epoch；幂等节点回执；usage/原始输出/证据不丢失 |

## 内容所有权

策略模型的读取先在 Catalog 内选定 Operation、请求/输出引用和决策元数据，随后在执行 worker 读取不可变正文。派发和结算重新核对原 Run、epoch、Operation 与请求引用。

新正文沿现有 `ContentStore` 保存。正文存取期间持有从 Catalog 取得的 `ContentPublication`，直到引用提交完成；GC 本次跳过在途发布，不在 Catalog 锁内等待发布者。没有第二个内容 owner 或旧格式读取路径。

拒绝模型输出同样先在锁外保留原始项和输出，再在元数据事务中核对原请求的所属和阶段。拒绝不会触发重新请求模型。

## 独立验证发现与修复

| 已确认问题 | 修复及验证依据 |
| --- | --- |
| 辅助模型受理后 history head 已推进，旧请求仍可写 Dispatched | 派发事务重核实际分支 owner 和冻结 head；新派发被拒，已经派发后的输出、opaque、用量和证据仍可保存 |
| 最终授权同步取消调用后返回成功，引擎继续派发 | 持久派发前及调用执行器前核对实际取消 token；真实 Catalog 验证持久标记后取消也不执行，占用结算后重开不会残留 |
| 批次在 Persistence 没提供协调器时临时创建每批自己的 ResourceAdmission | 改为 Persistence 必需、复用的依赖；批次与策略经过同一个权威，没有可选绕过和临时 fallback |
| 记忆交付在事务中重新解析整段 quoted policy history | 在 worker 提取候选，仅在事务核对 Run/请求/分支与真实 memory Operation 回执；普通和 quoted 策略请求均保留 Selected/Sent/Committed 三阶段 |
| 崩溃后同名 backup/staging 被替换，恢复仍可能移动后来创建的目录 | 实际 rename 前核对 journal 保存的稳定目录身份；无法证明归属的目录及后来新增内容保留，返回冲突 |
| 成功物化后源 branch 删除并 GC，同键重试因源不再存活而被拒 | 先核对当前授权、workspace 与原意图并读取已提交回执，再为真正的新工作检查源和租约；同键改输入仍冲突，不重放效果 |

合并复验还发现旧容量夹具把 `queued` 当成撤权监听已经安装。新结构先登记资源顺序预约，这两个事实已分开；夹具改为等待实际监听安装，原有撤权、无执行及清理断言全部保留。

### 本机锁争用诊断

同一 Windows debug 场景，辅助模型请求含 engine 实际格式的 quoted history；另一线程持续查询 Catalog：

| quoted history | 修复前独立查询最长等待 | 修复后独立查询最长等待 |
| --- | --- | --- |
| 1 MiB | 7.17 ms | 2.44 ms |
| 32 MiB | 210.6 ms | 13.16 ms |
| 64 MiB | 290.3 ms | 13.55 ms |

这是本机单次诊断，未设性能门槛。正文处理总成本仍存在：64 MiB dispatch 总时间约 3.57 s → 3.73 s；改进的是无关 Catalog 工作不再等待整段历史解析。手动诊断默认 ignored，不进入日常验证负载。

## 尚未完成的总设计范围

这批改动不会建立独立的大内容传输连接。共享 framed JSON writer 仍是实际边界，不能声称截图/大输出回压下控制传输已经完全隔离。

`Catalog::open → recover` 的冷打开仍有恢复正文读取；启动前这段成本没有在本轮实测。策略读取图仍先验证完整定义再整体受理，普通文件域的其他同步正文路径也没有由本次物化迁移自动消失。

完整能力 registry、可替换模型适配注册、所有领域迁移、默认产品切换、Pi 资产导入和平台发行仍按实施文档推进。普通模型输出、策略输出、执行资源和用户资产继续由原 owner 持有；本阶段不以局部并发通过替代完整设计验收。

## 验证

合并后的运行时聚焦复验通过 79 项：批次准备 7、容量公平 10、记忆交付 4、辅助模型 16、策略读取图 17、资源准入 9、执行 12、恢复 4。默认忽略的 quoted-history 手动诊断由 hack 单独执行通过，不计入这 79 项。

真实 Windows debug 内核的 framed-protocol 场景 12/12 通过：物化尚未结束时独立文件、进程和 ping 返回；取消/撤权、正常排空、源 branch 删除/GC 后在途物化、备份故障后重启、显式 reconcile、替换目录/后来资产保留及已提交回执重取均有实际文件证据。源回收场景确认 `deletedBlobs=1, deletedNodes=4, retainedNodes=0`，随后同键原回执和改输入冲突仍通过。

物化验证代码冻结于 `977e8a53`（包含物化主提交及身份、幂等修复；不是完整产品发布），二进制嵌入身份 `0.9.25`，SHA-256 为 `ae9ab8273e7c6cfa37d9541cf18d446936a2685a47f278e562cb0908256237f5`。主工作树随后用这个二进制通过实际 Host `KernelClient` 的 3 个长期回归；同文件其余 26 项按范围跳过，没有记为通过。

合并后的 `cargo check --workspace --all-targets --locked`、Host 含测试源的类型检查、变更 TypeScript 的 ESLint、生成协议一致性和空白检查通过。既有未使用字段/方法 warning 保留。协议与状态枚举没有新增兼容分支。

可重复的聚焦入口：

```text
cargo test -p varin-runtime --locked --test batch_preparation_review --test resource_admission_review --test family_capacity_review --test memory_delivery_review --test policy_model_jobs_review --test policy_read_graph_review
cargo test -p varin-runtime --locked --lib execution::tests
cargo test -p varin-runtime --locked --lib recovery
```

Windows Cargo 命令先加载 VS DevCmd x64。Host 物化回归先将 `VARIN_TEST_KERNEL_PATH` 指向对应已构建内核，再执行：

```text
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.kernel.config.ts packages/web/application-host/lib/kernel/file-resource-audit.native.test.ts --testNamePattern "committed materialization retries|replacement backup|replacement stage" --no-file-parallelism
```

没有调用付费模型、操作真实桌面、启动应用或进行全仓测试。上述结果不能代替完整产品、远端、所有平台和总设计性能验收。

### 临时夹具清理

自动执行审查拒绝删除以下两个本轮自建 TEMP 夹具，返回 `blocked by policy`，没有更具体原因；已停止重试。它们不是用户工作区或产品数据：

- `C:/Users/Youzi/AppData/Local/Temp/varin-materialization-hack-eh235ymd`
- `C:/Users/Youzi/AppData/Local/Temp/varin-materialization-hack-qd8j0ya4`
