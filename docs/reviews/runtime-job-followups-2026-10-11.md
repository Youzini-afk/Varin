# 原 accepted Job 事件与工作续接

日期：2026-10-11（Asia/Singapore）。基线：`978e6fdf4a75b40f7f8ae5cfc2f1990f4f84ee67`。
状态：本片同源码分层组件验证与独立审查通过；完整产品/平台证据边界如下保留。

## 用户和普通工具入口

普通 `follow_up` 版本 4 与 `ThreadsAPI.followups` 支持单独 `job_stopped` 和 flat Any/All。
`jobs` / `jobSources(identity, runId)` 从 Catalog 原受理 Operation 发现实际任务家系内的
已接受领域 Job，包括不在当前 active operations/历史页中的独立 User、旧 Run 和 child/sibling
工作。返回短 binding、origin 和生命周期事实，不读取原请求、输出或日志；家系查询沿原
child_tasks parent 索引。非受理意图、普通 Result、Kernel process 和无关任务不成为 Job 来源。

GUI 的 Follow-ups 编辑器可选择 accepted Job；普通 Agent 同一已选工具调用可先 `jobs` 再登记。
登记使用当前实际调用/所选 Run；目标 Job 的历史 sourceRunId 只是归因，不能复活旧工作或借用
其来源权限。登记回应不确定时保留原 key、Run、trigger 与指令；所有叶子在 Any 命中前均核授权。

可在用户验收环境中依次检查：

1. 在原研究面板受理一个实际实验，再结束或切换提交它的 Run。
2. 当前工作打开 Follow-ups，选择该 accepted Job 并输入明确续接指令；也可放入 Any/All。
3. 在原 Job 停止前，验证受理、Unknown 或取消观察均不提前续接。
4. 原执行者确认停止后，活动工作在合法输入边界收到一次原事实；空闲 root/child 创建自己的新
   Run/DelegatedExecution。原提交 Run、独立产物收集和目标 Job 取消权限仍分别属于原 owner。
5. 暂停、问题、Goal 控制或来源变化时查看实际 hold；关闭重开后复验去重，再检查登记、证据与历史。

## 唯一事实、正文及恢复

原 HostJobBinding 固定 operation/external owner epoch/domain/version/workspace/subject。
Job 接受、提交 Run 完成、取消请求、无 occupancy 和业务 Unknown 均不替代 executor_stopped。
实际停止但业务结果 Unknown 的 Job 可以作为停止事实，未知效果仍保持原标签；artifact collection
有自己的完成状态。

原 `operation.executor_stopped` 事件保存当时的短 ExternalReceiptMetadata。即使同一合法
identity/epoch 的 Unknown 后来细化成已知结果，较早的 All 叶或暂停发生项仍按其原 stop cursor
加载原正文。公共 event read 和续接材料都在 worker 解引用；GC 追踪这个事件引用及原 accepted
body。没有新增结果库、效果 owner 或回放层。

Catalog 37（直接拒旧）复用原 definition、叶游标、occurrence、typed Followup input 和 activation。
观察、输入绑定和实际交付分开；指令和原接受/停止材料作为 EnvironmentFact 进入历史，不伪装
User 或 system 输入，也不制造 process_read。原 Goal、问题、手动 Pause、child fixed result/source
与单 branch writer 仍核当前事实。取消观察不取消条件或 Job；取消条件不杀共享 Run；树停止围住
此前受理的未消费意图，后来的明确 User 意图独立。

原 research runtime 的 onReady/onEvent 与 ExperimentService 的 attempt 通知继续驱动原 subject
受理/停止对账与 observations reconcile；没有新增 Host timer/poller、实验镜像或替代提交。

## 实测证据

最终 runtime 全套 **423 passed / 0 failed / 2 ignored**，kernel lib **131 passed / 0 failed /
11 ignored**，workspace all-targets 通过。包含原 Catalog/ContentStore 的 Job 受理、双调用来源、
组合、真实输入交付、当前与历史来源区分、停止前后登记、取消、Goal/Pause/question、重启和 GC；
冷 child 测试沿原 source/context 准备生成真实新 DelegatedExecution/Run，并消费原历史。

Host public client/route、research-runtime 与原 ExperimentService **39/39**；installed SDK/domain
fixture 从原 start 订阅等到终态，不靠手动终态 reconcile 推动。共享 ThreadConversation **40/40**，
包括历史家系 Job 候选、当前 Run 归因、Any/All、回应不确定时原键重试、迟到候选丢弃及显式查询失败。
Application-client、UI、Host 测试类型和生产声明、修改 TS lint、生成协议检查通过。

同源码 fresh Linux x64 `0.9.25` binary SHA-256：
`3e1432a6d200eabd868fae41f1a49dba5be7842ad1e6d67c2bfd0f5df6e1c722`。
该准确 binary 的原 child guardian/树停止/固定来源结果组合 **1/1**。构建后 **1,390** 项
源码/schema/配置指纹一致；生产 Host bundle **535 reachable / 72 excluded**；文档检查
**213 files / 1,696 local links / 0 errors**。

独立审查先按设计形成合同，再追源码/真实消费者。新增独立通知 probe **1/1**：没有一次显式
reconcile 调用，原 start 的三种通知在一次旧快照读取期间交错，真正停止自动提交原 binding
并唤醒观察；业务完成/collection 完成不冒充 stop。dispose 清理监听，离线停止在重建时自动
对账原 Job，不重新提交工作。该探针用真实通知代码及明确受控管理/domain 端口，单独只证明
通知桥。最终独审无确认阻断，29 项修改文件与 1,390 项广输入指纹吻合。

编写测试时，错误的 child fixture pin/context/schema 排序和最初空 Run UI 条件已在原合同下
纠正并复验；它们没有被跳过或算作通过。独立外置 probe 的第一次 TS module loader 失败也
不计行为验证，改为同一 Node TS loader 支持的 ESM 测试文件后执行成功，未改变产品 transport。

依据[开发指南](../development.md)准备锁定工具链，在仓库根复跑：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --locked -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/thread-followups.test.ts \
  application-host/lib/kernel/research-runtime.test.ts \
  application-host/lib/harness/experiments.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx)
```


## 证据边界与后续

这些源码/原生/纯 consumer 检查分别验证原 owner 和真实调用方，不组合冒称完整 Host IPC。
完整 Host IPC、实际新 research-source adapter 到 Storage 字节、真实远端/GPU、跨平台和大负载
仍按各自边界待验。本片没有调用真实付费模型或提交实际科学作业。

本片是一次 accepted-Job 停止事件。日志/指标/产物条件、明确重复语义、其他领域与两设计能力
余项继续实现。默认 runtime 切换、Pi 删除与用户资产全面迁移仍交用户验收后负责。
