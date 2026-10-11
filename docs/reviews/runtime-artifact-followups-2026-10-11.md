# 原研究产物与收集事实续接

日期：2026-10-11（Asia/Singapore）。基线：`35b77bc2b9900f6517310c51b4c8a527338b4b9f`。
状态：同源码分层组件验证与独立审查通过；完整产品/平台证据边界如下保留。

## 使用与验收入口

普通 `follow_up` **版本 6**、`ThreadsAPI.followups.register` 和共享 Follow-ups 面板支持两个
明确条件。先通过原 `jobs`/`jobSources` 选择实际已接受的 research Job；owner 返回的
`observationKinds` 决定可用条件，UI 不维护第二份 domain/version 支持表。

- `artifact`：`operationId` 加可选 `artifactId` 或 `name`，两者互斥；不填则观察该原 attempt
  的所有产物。available、failed、expired 是不同事实，pending 不满足。零字节 available
  仍是成功产物。once 消费当前有序快照中第一个适用记录，不重建离线时的历史先后。
- `collection`：观察原收集器真正提交的 done、failed 或 not_started，包括确实为空的收集。
  Job 接受、执行停止、Run 结束及 Unknown 都不能替代收集完成。
- 要同时观察逐件产物和最终收集，明确使用 Any[artifact, collection]。已有适用产物时，
  artifact 条件不会因收集完成偷偷多触发一次。没有匹配记录只能从一致的真实完成快照
  得出 missing；收集失败只报告 absent，不能断言源文件不存在。
- `repeat: each` 对两个新条件均成立。按原每件产物修订和独立收集完成身份去重，显式重新
  collect 可以产生新事实，不重提实验。持续授权仍须 Pause/Cancel；each All 沿原 FIFO
  配对，once、有限叶、原发生项和 Goal/问题/来源守卫不变。

在用户验收环境，使用已有合法 research Job，分别登记 artifact、collection 或明确 Any，
观察一个产物已可用、另一个仍在读取时的行为。检查产物先触发、collection 真正完成后才
触发，并检查空收集、失败后明确重收集、暂停/恢复和取消。取消 follow-up 不取消原 Job
或收集器。实际 root/child 新输入仍从观察者的工作来源续接，不使用目标 Job 的历史 Run
冒充执行来源。

原 `occurrences` 提供短历史分页；新 `occurrence` 工具动作、
`followups.occurrence(identity, followupId, occurrenceId)` 和原 POST
`/api/threads/followup/occurrence` 按需展开确切旧发生项的 metadata。GUI 校验发生项和逐源
accepted cursor，以普通 JSON 展示，关闭、换 Host/branch/发生项后丢弃迟到回复。
旧 metadata 不被最新领域快照覆盖，但它不是新建的历史字节快照或权限。原 artifact
reader 仍读取当前领域记录；正文明确说明这个边界，不声称已固定任意远端文件内容。

## 执行、存储、取消与恢复

Catalog **39**、Storage **13** 直接拒旧内部格式，不迁移用户资产。原 ExperimentService 和
Storage domain_records 继续唯一拥有产物、字节和收集事实。原 attempt 最终 CAS 保存稳定
collectionCompletion 修订，无关 attempt 更新不重复触发。not_started 只在原 capture、
preparation、admission 真正排空后成立；失联/未知不能冒充完成。

逐件原 artifact 持久提交后发出既有通知，通知仅唤醒真实读取。原 Storage 按 attempt 的
索引和 keyset 分页读取，拒读显式失败，不退化为空。metadata reader 使用实际观察者的
family 读权限、原完整 Job binding 与 execution owner；目标 workspace 和观察者 execution
workspace 分开，不借 maintenance creator 的控制权限。一致的前后 collection/completion
边界防止旧完成标记与新 partial 收集合成假 missing。

原订阅先建立再重查，读中通知保留。执行 Job 离开 pending 对账集合之后，Catalog 仍能发现
该 follow-up 的原 source work。metadata 与原 Job 控制对账各有短暂 single flight；慢读取不
阻取消。收到变化提示后，未开始的旧页工作丢弃并重取，暂停后的旧页不能再启动新读。
已持读的原 owner 正常排空；这不等于 collector/executor 停止。没有额外轮询、调度器、结果
manifest 或第二份效果权威。

每件原 revision 的高水位来自已有 source_observed events。重复短身份在准备前检查，提交
时重新核对；正文在 worker 的 ContentStore/publication 下持久化，原事件只保存独立引用。
事件、叶消费与 occurrence 同事务提交。GC 覆盖未配对 All、待交付、失败、历史和已取消
发生项的真实事件引用。公开 event/occurrence 与实际 continuation 在锁外读当时 metadata，
不暴露私有 content_ref。O2 进展不替换 O1，真正 control/source/epoch 变化仍拒迟到提交。

已接受的 HostJob 在重开时保留原 call receipt、operation 和外部 owner，交原域对账；不能
因内核重启而虚构普通本地 Result 中断，也不重新派发实验。原未接受工作与效果 Unknown
仍保留自己的恢复语义。观察取消、Job 取消、原执行停止和 collection 完成分别结算。

## 真实反例与修复

- 原输出读取失败、失败产物记录又写失败时，异常被吞掉后曾将 collection 记 done。原失败
  探针复现后，移除吞写失败路径；原断言转绿，失败保为真实 collection failed。
- 新 metadata 飞行曾放在原 research 控制单飞内，持读时另一已接受 Job 的取消无法推进。
  分离两条短暂 flight 后，同一外置探针确认取消在 metadata 释放前推进。
- 无 external receipt 的已接受 User Job 为 Running/Confirmed，旧恢复分支错误要求普通中断
  result，reopen 直接失败。按真实 accepted binding 保留外部 owner 后，原 GC/All 重开用例
  转绿，并核对 ModelStep/PolicyAction 已接受 Operation 和 history 重开精确保留。最初失败
  日志被后续运行覆盖，保留的是明确标注的原工具输出摘录，不将其称完整原日志。
- 独审原探针确认 A 持读期间 B 已 Pause，旧页仍启动 B metadata 读取；只在最后拒 publish
  不能补救读取。最小丢弃未启动旧页修复后，独立同探针 B 新读为 0，A 仍真实排空。
- 原确切 attempt 分页的 foreign grant 拒绝曾静默过滤为空。沿原 grant 改成显式
  Authorization error，同真实 Storage 页和原拒读断言通过，没有增加权限层。
- 独审还复现 scan 已结束、原 Promise finally 尚未清理时到来的通知丢失，新登记叶必须等
  无关事件才读取。原 finally 清理后检查 dirty 并驱动同一个 flight，原十二种微任务次序
  探针全部通过；错误仍归原 onError，dispose 先 abort 再等真实工作。
- 宽 Kernel 套件发现新增 Storage 必需索引列表未保持已有字典序，五条原重开用例把健康
  数据库误判损坏。只修原常量排序，不放宽格式/结构校验，不改原用例。

## 分层验证

冻结 runtime 全套 **435 passed / 0 failed / 2 ignored**，35 个目标；Kernel lib
**135 passed / 0 failed / 11 ignored**。实际行为覆盖包括：

- 原 User accepted Job、ModelStep/PolicyAction 原接受在 Catalog 重开后精确保留原 Operation
  和 history；逐件 revision 去重、旧 O1 锁外准备与 O2、GC/公开 event、All FIFO 部分事实
  重开、暂停/取消迟到提交和 root 新 Run。
- 原 Kernel 两种工具调用来源分别登记 artifact/collection，实际原 Wait receipt/history
  与独立 continuation metadata input 均消费；原 child 测试分别沿 Job、artifact、collection
  进入 idle 新 DelegatedExecution/Run，再向 active child 交付后续发生项。
- 原 Storage 索引页在原记录更新后仍正确 keyset 翻页，排除日志内部块，真实拒读不变空；
  五项既有 Storage 关机/重开、文件观察、grant 和固定结果组合在排序修复后恢复通过。

最终原领域、research-runtime、metadata observer、公开 Host admission、原文件 owner 与
FileObservationService 六套组合 **57/57**。其中原 ExperimentService 覆盖逐件 A 可用/B
持读、零字节、写失败、明确重新 collect、真完成身份、旧完成/新 pending 交错和真正排空。
公开 HTTP/client/route 使用受控 RPC；领域 Storage/backend ports 亦在相应组件 fixture 中，
不将它们称完整 Host IPC 或实际远端实验。

冻结 UI ThreadConversation/ThreadFamily **57/57**，公开 Host consumer **12/12** 已包含于
上述组合。application-client/protocol build、client/UI types、Host 声明与测试 types、定向
lint、Rust 格式及协议生成检查通过。真实 Host bundle **536 reachable / 72 excluded**。

独立设计先验形成八条验收边界后才看实现；最终无确认阻断。两条独立原红探针的修复后
结果均通过，Pause 又在最终 observer 复验；lead 原控制隔离探针也原样转绿。最初 Pause
probe 的参数 fixture 未到实际持读窗口，只纠正透明接口参数，不将该次当产品失败。
最终 **5,216** 项源码/schema/配置/受控资产指纹独立核对一致；本片扩大了指纹范围，数量
变化不是能力或性能指标。宽验证引入已核准的 observer/test、索引排序和 Storage metadata
format 字符串同步修复；随后六套 Host、整个 Kernel lib 与 all-targets 按最终源码重跑，
runtime 源码始终相同。原 Storage metadata format 与 user_version 均为 13，未放宽拒旧。

最终全 workspace 两成员 all-targets 通过。同源 fresh Linux x64 `0.9.25` binary SHA-256：
`dc6f81a5b2f9e4dfc709b7b42aa3eeb9fc6401a003f2a3474bdf58710709fa00`。
以该准确 binary 运行原 guardian/树 Stop/fixed WorkingResult 组合 **1/1**，已按原构建脚本
stage。构建前后输入指纹一致。文档检查 **215 files / 1,702 links / 0 errors**。

依据[开发指南](../development.md)准备锁定工具链，在仓库根复跑：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --locked -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
bun x vitest run --maxWorkers=2 \
  packages/web/application-host/lib/harness/experiments.test.ts \
  packages/web/application-host/lib/kernel/research-runtime.test.ts \
  packages/web/application-host/lib/kernel/research-artifact-followups.test.ts \
  packages/web/application-host/lib/kernel/thread-followups.test.ts \
  packages/web/application-host/lib/kernel/file-observation.test.ts \
  packages/web/application-host/lib/kernel/file-observation-service.test.ts
(cd packages/ui && bun x vitest run \
  src/components/thread/ThreadConversation.behavior.test.tsx \
  src/components/thread/ThreadFamily.behavior.test.tsx)
```

完整 Host IPC、实际浏览器/桌面、多平台、真实远端/模型/实验/GPU 和负载另需证据。当前没有
用另一 transport 替代受限 IPC，也没有运行付费模型或实际科研作业。原生 Catalog/Storage、
领域 owner、受控 RPC 和公开 consumer 的证据分别成立，不能相加称完整产品端到端验收。

后续继续原日志、指标和其他领域来源，以及两设计尚余能力。用户先验收能力，再负责默认
runtime 切换、Pi 删除和资产全面迁移。
