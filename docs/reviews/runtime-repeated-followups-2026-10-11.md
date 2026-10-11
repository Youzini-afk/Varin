# 明确重复授权与原发生项

日期：2026-10-11（Asia/Singapore）。基线：`a0560b7d39e8807e760275c85891203c174a1f9c`。
状态：本片同源码分层组件验证与独立审查通过；完整产品/平台证据边界如下保留。

## 使用与验收入口

普通 `follow_up` 版本 5 的 `register`，或 `ThreadsAPI.followups.register`，明确传入
`repeat: 'each'` 才建立同一指令的持续授权。省略仍为 `once`。本片首先接原来源文件的
`changed`；每个实际观察到的变化都可续接，通知合并或离线变化不会凭空重建。

- 单条件 each 必须为 file changed。
- each Any 至少有一个可重复叶，每个已接受叶边缘形成一个发生项；At、停止、exists 和 ready
  是有限事实，各贡献一次，不在每轮重新触发。
- each All 的所有叶均可重复，以 FIFO 配对：A1、A2、B1 形成 (A1,B1)，A2 留给 B2。
- once 保留原快照语义；Job/进程接受、业务 Unknown 与真正停止仍有原来不同的含义。

在用户验收环境中，可在工作 Follow-ups 面板选择 Each observed change、文件相对路径和明确
指令，随后修改文件两次，并等待各次原观察确认。查看两条不同发生项和原输入交付；第一次
交付后卡片仍可 Pause/Resume/Cancel。再用两个文件验证 All 的先后配对，以及暂停、重开、
问题或 Goal 阻塞时保留的待交付项。固定 immutable 来源合法登记 changed，但不会因无关磁盘
写入而变化；接受的原物理来源不会被后来 Run/WorkingResult 替换。

原 occurrence 历史由 `occurrences` 工具动作或
`followups.occurrences(identity, followupId, after?)` 逐页读取，按 accepted_cursor 升序，返回
nextCursor。每页 64 条是响应边界，不是总数上限。GUI 明确历史页为读取时快照，支持刷新、
前后页、失败重试和原绑定 Run 的只读会话导航；它复用原 FamilyHistory 分页/原项展开器。
定义的 latest occurrence 不替代任何旧发生项，pending_occurrences 独立显示未交付数。

## 执行、取消及恢复合同

Catalog 38 直接拒旧，Storage 12 不变。沿用原 events、followup_occurrences、typed input、
activation 和 ContentStore，没有另建队列、调度器、数据库或隐式 timer。

每个来源事实的 accepted_cursor 与其原因果 trigger_cursor 分开。原短事件、叶 consumed_cursor
和完成的发生项在同一个 Catalog 事务提交；未配对 All 事实耐久保留。索引读取待准备发生项、
待交付输入和下一叶事实，普通投影不遍历全部已交付历史，也不解引用大正文。

准备、失败、Wait 结果、Goal 检查、输入绑定和交付都使用确切 occurrence ID。O1 锁外准备时
O2 到达不撤销 O1；实际控制、来源、Goal 与 epoch 变化仍拒陈旧候选。可选工具 Wait 只观察
原触发事件指向的第一个发生项；结束观察不撤销持续定义。实际正文仍在原 worker 准备、
由原 publication/GC 保护。

Pause 停止新文件正文读取及执行，保留已接受/排队事实；Resume 用原授权重新检查，并明确
重试失败的未交付项。active each 始终提供 Retry undelivered occurrences，因此旧 O1 失败
不会被最新 O2 成功遮住。Cancel 撤销未来授权和所有未交付发生项/输入，保留已交付历史、
Run 和成果，也不杀被观察的 Job。实际当前 branch Run 的明确 Stop 同事务撤销已有 each
定义；历史已结束 Run、非当前排队 Run 或单 Operation 不得到该 branch 范围。Tree Stop 仍按
原树。Stop 之后新的明确 User 意图独立，旧终态回执不能追溯撤销它。

文件通知只唤醒原 watcher/capture。真实 FileState 差异或严格推进的确切 watch 位置才形成
边缘；同 key/位置/快照重投不重复。不同接受的观察可能覆盖同一 OS 写入，一次通知也可能
合并多次写入，未承诺每次物理写入恰好一个发生项。reset/gap 本身不能虚构变化；gap 后确证
的快照差异可形成一次事实。实际 reader drain 后才释放原 receipt/lease。

当前 Goal、问题、手动 Pause、权限、来源/ContextScope、child 固定结果与单 branch writer
继续在实际交付边界生效。一次早期 At 不能给后来的纯文件发生项借用 Dependency 检查例外。

## 分层证据

冻结 runtime 全套 **430 passed / 0 failed / 2 ignored**；kernel lib **133 passed / 0 failed /
11 ignored**；全 workspace 两成员 all-targets、协议生成检查通过。新增真实矩阵包括：

- O1 准备中 O2 到达仍准确提交、失败只标记 O1、All FIFO/部分进度重开、暂停/gap/取消保留
  已交付历史、Any 有限事实不重放、确切发生项 Goal 门、当前 Run Stop 与后来 User 意图。
- 原 Catalog 写入 66 条发生项后跨真实两页读取，不只测试伪造响应。
- 原 Kernel User 路由/文件 adapter/Storage 实际两次读取文件字节，形成两次 active root 输入，
  原 watcher 在首次交付后保持；重投旧观察拒绝，Cancel 释放资源但两条已交付历史不变。
  Host owner 的 watch 回复在这个测试中受控，不把它称为真实 OS watcher 端到端。
- 真实两种工具 origin 的 Wait 在 O2 先到时仍交付 O1。child 的 repeated Any 依次消费原 Job
  与 At，沿实际 idle 新 DelegatedExecution/Run，再投递 active child 输入；这证明原 child
  多发生项消费，不声称固定 immutable 文件发生了变化。

Public client/Host admission **10/10**，包括 130 条响应经三页、不同 source/accepted cursor、
外 branch 拒绝、错误重试、不解引用指令及原不确定注册；UI ThreadConversation/ThreadFamily
**48/48**，原 SDK exports **2/2**。application-client build/types、UI types、Host 生产声明及
测试 types、修改 TS lint 通过。上述 consumer 使用受控 RPC 边界；不是完整 Host IPC。

同源 fresh Linux x64 `0.9.25` binary SHA-256：
`01bc94b0e8fad21896bb200e4315c2024d59074d6b033c95fe2199407fea4586`。
该准确 binary 的原 guardian/树 Stop/fixed WorkingResult 组合 **1/1**。Host 公开路由、原文件
owner、FileObservationService 和 research-runtime 四套组合 **19/19**；生产 Host bundle
**535 reachable / 72 excluded**。构建前后 **1,391** 项源码/schema/配置指纹一致。

独立真实通知探针 **1/1**：真实 Documents/watch 写入通知进入原 owner.changed、
FileObservationService 和 AgentRuntimeClient；延迟首响应时第二通知不丢，首次消费后继续
监听，无变化不自行轮询。Pause 不读、Resume 重读，真实 overflow 只给 gap 而非伪 targeted
change；精确 release 保留另一个独立 handle。末端 Kernel request 为透明 stub，仅证明此
Host 通知/路由接缝。最初外置 `.ts` 被 Node 当作 CJS 的 loader 失败不计通过，改为同一官方
TS loader 支持的 `.mts` 后执行成功，没有变更产品 transport。独立审查按设计形成八项验收边界后才读 diff；最终无确认阻断，
无需额外源码修复，独立复核全部 1,391 项输入一致。

依据[开发指南](../development.md)准备锁定工具链，在仓库根复跑：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --locked -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/thread-followups.test.ts \
  application-host/lib/kernel/file-observation.test.ts \
  application-host/lib/kernel/file-observation-service.test.ts \
  application-host/lib/kernel/research-runtime.test.ts)
(cd packages/ui && bun x vitest run \
  src/components/thread/ThreadConversation.behavior.test.tsx \
  src/components/thread/ThreadFamily.behavior.test.tsx)
```

## 边界与后续

完整 Host IPC、新 research-source adapter 到实际 Storage 字节、跨平台、真实远端/桌面与
大负载仍各自待验。本片没有实际付费模型、实验/GPU 作业或用户电脑操作。格式化、编译与
纯消费者结果不替代这些产品验收。

后续继续原领域的产物、日志、指标条件及完整两设计能力。默认 runtime 切换、Pi 删除和
用户资产全面迁移交用户先验收后负责。
