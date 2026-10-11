# 原生研究作业与真实领域消费者

日期：2026-10-11（Asia/Singapore）。基线：`a68e355a8f589e8b649695f4f9d8eb3cba04d08d`。
状态：本片源码整合、分层组件验证与独立反例复验已通过；新 source adapter 到实际 Storage 字节及完整 Host IPC 尚未实跑。

## 交付范围与唯一 owner

本切片把原 ExperimentService 接到真实 Agent Thread/Run、ModelStep 或 PolicyAction、独立 User 命令及共享研究面板。前一[实验受理基础片](runtime-experiment-admission-2026-10-11.md)继续拥有短持久受理、独立准备、取消排空、资源和后端恢复。本片没有另建实验数据库、scheduler、资源账本或 Pi session。

- Catalog 拥有真实调用、User 命令、原域 subject 关联、不可变调用接受回执、后续执行回执及 Wait。`Operation.host_job` 的 `acceptanceRef=null` 只是精确派发计划；真实域接受后才原子发布引用和 JobAccepted。
- 原 Storage experiment/spec/job/artifact、SourceService、ResourceService 和 backend 继续各自拥有实验状态、原输入、输出、资源与物理停止事实。Host 只重读精确原 subject，不扫描全部历史来重建另一份状态，也不把缺失当作可重新提交。
- 普通已安装 [research-tools](../../examples/extensions/research-tools/README.md) 声明 Result 或 Job 与真实 lifetime。submit/wait 是 Thread Job，其余读/控制分别声明权限。模型与策略共用原 ToolDirectory、schema、invocation 和原始参数；只有模型产生 provider 工具配对。Extension JSON 不能提供停止证明或自行认领域作业。

User submit/rerun 先在 Catalog 同事务保存真实 User Operation、原 request 引用及精确 subject 计划。其 sourceRun 只是来源与归因，不重开旧 Run，也不阻挡活动模型自然结束。固定停止集合按原 Catalog 受理顺序选择；停止之后新的明确命令可独立受理，不给历史 sourceRun 加永久禁令。同一 User key 与相同意图复用原命令，不同意图冲突；同 subject 不允许第二个执行 owner。

## 接受、执行、观察与取消

原域接受回执进入 ContentStore，Catalog 只保存短引用。JobAccepted 与后来的成功/失败/取消、executor-stopped 回执分开。接受发生在回调取消之前时，原 Persistence 同锁选择已经提交的 canonical completion，真实 model batch 和 policy node 都消费同一接受；若 Unknown 已先交付，它继续作为历史事实，晚到域接受和终态不重写或追加第二个工具结果。

独立实验不依赖提交 Run、旧扩展 callback 或 UI 的存活。普通 Run 结束与扩展退役不停止已接受作业。任务树停止和原 domain cancel 互相投影原操作的真实取消请求；它们都不是 backend 停止证明。终态还要求原准备/派发/进程 writer 与输出 drain，collection 仍是独立领域状态。

`research_wait` 持久登记原 job Operation 的真实 executor-stopped 条件，复用原观察停车、内容交付和恢复 owner。历史 Unknown 的 `operation.settled` 不能抢占这个条件。登记前已停止可立即消费；取消只结束本观察，不杀目标实验。Goal 手动暂停和其他仍待交付观察继续守卫原 Run。

## 来源、权限与 grant 寿命

Caller 记录真实 runtime/actor/Thread/Run/Operation/source，模型/策略/用户不互相伪装。读权限来自实际 family，控制只含当前 Thread 及其后代；maintenance 是明确 Host 内部身份，不能由省略权限数组获得。普通源对象 locator 不等于已经取得内容。

live_root 使用原注册根，materialized 使用原环境，fixed_branch 使用确切 revision/root 和持久 pin。无默认 cwd 或可变父源兜底。语法非法/越界 cwd 在 pin 前拒绝，目录实际存在性等准备检查仍在独立 worker；准备失败沿原 pin/candidate/receipt 清理，不把短受理说成准备必成功。

Operation-owned source/transfer/backend grants 保留实际 sourceRun 归因，普通 Run retirement 不能提前切断它们。纯 helper 归还自己的 grant；成功 materialization 将执行 grant 交原 backend，transfer 将 reader 生命周期交原 transfer owner。取消或未知回应不等于 reader/writer 已结束。最终按原 Operation 归还重开遗留 grants 时，必须先有整个原工作已排空的真实证据。原 Storage 的精确 Operation retirement/reopen 和实际 reader 排空验证通过；未知 writer 仍保留原授权。

## 实际 User 与 UI 消费

`ThreadsAPI.research`、认证 `/api/threads/research/*` 与 ThreadConversation 挂载共享 ResearchFactsView。Renderer 只提供真实 Thread/branch 与明确 sourceRunId，不能指定 workspace、family、actor 或 grant。旧来源和旧分支作业继续可见，`canSubmit` 与历史读取/控制分开。

Native attempt 带当前控制权限；UI 不把缺权限当允许。详情、分页日志和二进制产物来自原 owner。未知 rerun 回应保留原 key/spec/machine/retryOf，不造第二次工作。换 Host/Thread/source 丢弃晚响应。观察按钮明确标为取消观察，和原独立作业控制不同。

## 独立审查与待补边界

独审先按两设计形成十条合同，再读冻结实现。真实 Catalog 外置探针验证终态先于 Wait、已接受后的旧 transport Unknown、普通 Run 取消保独立作业。整合验证真实 ExecutionEngine 的 model/policy canonical 接受，以及实际安装 SDK→ToolBridge→原 ExperimentService 的两 origin、丢接受 ACK 与原控制端口。后者的 Catalog/Storage/backend 是受控 fixture；这两层不能拼成完整 Host IPC 验收。

独审实际复现两条同源缺陷：已停止且日志排空的实验，仍等慢 artifact collection 才写 attempt 终态、释放计算承诺，导致 native Wait 被阻；产物收集失败还把已排空 stdout/stderr 标成永远非 EOF。修复沿原 owner 先短提交 terminal/collection:pending、释放计算承诺，再锁外收集。原 RunningJob 在终态通知前持有唯一 collection Promise，自动、手动与重建后的消费者共用实际 reader；真实收集排空后才释放 backend/grant。日志 EOF 直接使用原 outputDrained 事实。

这两条原失败探针未改条件，最终均转绿。第三条独立探针在持读时 detach、重建并手动 collect，验证只读一次、持读中零 backend/grant 释放、排空后一次 backend release。原领域用例另覆盖通知同步重入、收集失败、client 重开后原 pending 恢复。独审接受当前冻结源码及已执行组件层，无剩余已确认行为阻断；这不是完整研究端到端验收。

新 research-source 测试核对了确切 root/revision/pin、原 live/materialized 路径和 grant 寿命；新 adapter 到实际 Storage 区分字节的三来源集成尚未实跑。完整 Host Unix IPC、真实远端/Slurm/账号、科研质量和跨平台证据不计通过。原同步 `file.scan` 元数据 inventory 仍是后续已知控制边界；本片不声称超大目录扫描已离开 Storage actor。

本切片也不等于任意第三方扩展已具备持久 Job domain adapter，更不等于两设计完成。其余领域、事件源、组合/上下文/provider 余项继续；默认 runtime 切换、Pi 删除和用户资产全面迁移交用户验收后负责。

## 冻结构建与复跑入口

原生部分最终冻结测试：runtime all-targets **415 passed / 0 failed / 2 ignored**，kernel lib
**110 passed / 0 failed / 11 ignored**，workspace all-targets check 通过。另用同源码新构建的
Linux x64 `0.9.25` executable 运行原 guardian/Storage 三项 **3/3**；它们覆盖原物理进程、
固定结果和进程来源，不能替代新 research-source adapter 到真实 Storage 字节的完整纵切。
构建前后 254 个 kernel 输入指纹一致。staged manifest 与实际 binary 的 SHA-256 均为
`4dbde1d092c8ff1768b11cd3a93de8b4bcdaa130dbfff153e5d9648cb10619f1`。

extension-contract **103/103**；真实 ToolInvocation **4/4**；公开 client、认证 route handler
和原请求信用/取消消费者 **11/11**；现有 Pi 研究工具 **16/16**。Node-test 文件通过官方
Node 的受支持 TS loader 执行。一次误将 node:test 文件交给 Vitest，后者报告无 Vitest suite；
随后按文件的真实 runner 单独执行通过，没有更改用例或产品传输。

共享 ThreadConversation/ResearchFactsPanel **53/53**，包含观察取消标签原失败修复、旧来源保留、
丢回应 rerun 保键和只读权限。Application-client 构建、完整 Host 生产声明/测试类型、UI 类型通过。
最终领域组合七个文件 **46/46**，其中原 ExperimentService **27/27**，包括真实已安装 SDK/ToolBridge、来源/权限、原 input/backend/transfer 与 grant 消费者。最终 Host bundle 为 **535 reachable / 72 excluded**。全部改动与新增 TS/TSX lint、生成协议核对通过；最终 5,191 个源码/配置/测试输入在构建与独审后逐项指纹保持一致。

依据[开发指南](../development.md)准备锁定工具链，在仓库根执行：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --all-targets --locked -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
(cd packages/extension-contract && node --import tsx --test 'test/**/*.test.ts')
(cd packages/web && node --import tsx --test application-host/lib/kernel/tool-invocation.test.ts)
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/research-runtime.test.ts \
  application-host/lib/kernel/research-source.test.ts \
  application-host/lib/kernel/thread-research.test.ts \
  application-host/lib/harness/experiments.test.ts \
  application-host/lib/harness/experiment-workspace.test.ts \
  application-host/lib/harness/research-access.test.ts \
  application-host/lib/harness/managed-remote-client.test.ts \
  application-host/lib/kernel/admitted-storage-context.test.ts)
(cd packages/ui && bun x vitest run \
  src/components/thread/ThreadConversation.behavior.test.tsx \
  src/workbenches/research/ResearchFactsPanel.behavior.test.tsx)
(cd packages/pi-host && node --import tsx --test test/harness/experiment-tools.test.ts)
```

显式安装并选择 [research-tools](../../examples/extensions/research-tools/README.md) 后，真实 native Thread
可通过普通模型或策略工具调用受理/观察实验；Thread 页面 Research 面板读取同一来源、作业和输出，
有实际控制权限时可取消或按原 spec rerun。没有自动启用扩展或调用模型。支持原 Host IPC 的环境中，
使用同源码 manifest-matched kernel，沿既有 native test 入口复跑 experiments.native.test.ts、
experiment-workspace.native.test.ts 与 sources.native.test.ts；本环境只做了其类型适配。
