# Managed package / Experiment 输入生命周期独审

审查基线：`41fe332f0ac7cf9eef6b4e044a03980235620bc2`。本轮沿来源 Host 的捕获、协调端消费、
Operation 结算、普通 Run retirement 和 Host 重开检查实际消费者，不只复核实现清单。
依据 [Agent 运行时设计](../design/agent-runtime-design.md) §7、§14.3、§22、§25 和
[能力组合设计](../design/runtime-extensibility-design.md) §5.3、§9.4。

结论：确认两个 package capture 清理恢复缺口，均有明确源码路径和触发条件；尚未运行故障复现。
本轮未发现 managed Experiment 输入所有权或 A/B 内容安装主链的新阻断问题。这不代表完整产品、
网络或平台验收通过。主开发可继续独立功能实现，下面的清理修复可作为单独写集完成。

## 1. 首次远端释放失败后，没有 package 来源清理的重试消费者

优先级：P2。结论依据静态调用链，不是实际 HTTP 故障测试。

触发条件：

1. A 从 B 捕获并完成 `extension_package stage`。
2. A 清理时，B 的 `sources/release` 请求因短暂断线未抵达 B。
3. B 随后恢复可达，原 Run 正常结束；不额外执行显式整 scope revoke。

源码证据：

- `packages/web/application-host/lib/kernel/extension-package-owner.ts:49–50` 以
  `retention: 'caller'` 和原 `operationId` 准入来源。
- 同文件 `101–114` 只执行一轮清理；失败报告给 `onCleanupError`。已经得到 stage 结果时，
  `142–144` 仍正确保留原成功回执，但清理工作没有保存为会再次推进的工作。
- `packages/web/application-host/index.ts:4551–4553` 的实际 `onCleanupError` 仅写日志。
- `packages/web/application-host/lib/harness/managed-source-service.ts:422–424` 和
  `kernel/crates/varin-kernel/src/storage/source_authorities.rs:492–494` 均明确让普通
  Run retirement 跳过带 `operationId` 的 caller-owned authority。
- `kernel/crates/varin-kernel/src/tools.rs:1177–1235` 的既有已交付回执清理/启动重放限定于
  `is_managed_read`，不包括 effect 型 `extension_package`。
- `packages/web/application-host/index.ts:1584–1588` 的重连回调只唤醒 Experiment 对账。
  `ToolBridge` 保留的是原 callback 和未 ACK 的工具回执，没有 package source 清理消费者。

结果：已完成包的 B capture、对象 owner / pin 和 source authority 可以继续留存。
普通 Run retirement 不会补做这次清理。不能以保留正确的 stage 成功结果代替资源释放。

最小修复方向：

- 保留 stage 原回执，不重做编译或安装。
- 复用原 Catalog Operation 和已持久化的实际 executor-stopped 事实，增加该 consumer 的
  来源清理推进。现有 `external_delivery_persisted` / `delivered_external_operations`
  提供可参考的原恢复入口，无需另建一份包安装结果权威。
- 在正常结算、启动恢复和相关恢复唤醒中，锁外按原 Run launch 与 B `inspectScope` 查回
  同 `operationId`、purpose 和完整 source 身份，退休确切 authority；失败继续保留原清理身份。
- 不把所有 caller-owned authority 当作可清理对象，也不让清理网络等待占住 Catalog 锁。

定点验收应注入一次未抵达 B 的 release 失败，再让连接恢复，验证原 stage 不重放、B capture
最终释放；另覆盖 A 重开后从原 Operation 恢复清理。

## 2. B Host 重开后，固定来源包的持久 pin 没有可恢复清理身份

优先级：P2。独立于第 1 项：即使 A 后来成功重试 `release`，这个 pin 仍可能遗留。

触发条件：B 完成 fixed-branch package capture 后，在 pin 释放前完整重开 Host/Storage；
A 再沿原 authority 请求释放。无需损坏文件或构造异常协议消息。

源码证据：

- `packages/web/application-host/lib/kernel/extension-source.ts:105–106` 调用
  `store.pinBranch(source.branch_id, { revision })`。pin 仅由返回 capture 的闭包持有。
- `packages/web/application-host/lib/kernel/storage-adapter.ts:791–798` 使用随机 query pin
  操作身份，`833–840` 的 unpin 依赖原返回对象。
- `kernel/crates/varin-kernel/src/storage/branches.rs:1258–1266,1318` 将 revision pin 的
  `write_revision` 设为 `-1`，因而 `ephemeral = false`。
- `kernel/crates/varin-kernel/src/storage/core.rs:187–189` 重开时只清理 ephemeral pins。
- `packages/web/application-host/lib/kernel/source-query-service.ts:40–45,99–100` 的
  package capture 目录是 Host 内存 map；重开后不存在原 capture 闭包。
- `packages/web/application-host/lib/harness/managed-source-service.ts:120–128` 对旧 Host
  lifetime 没有可用本地 service scope 时跳过本地句柄释放。
- `packages/web/application-host/lib/kernel/source-query-service.ts:307` 的持久 cleanup
  目前只接 `research.release`，没有 package pin 对账。
- `kernel/crates/varin-kernel/src/storage/source_authorities.rs:421–427` 最终退休原 grant，
  而 `storage/authority_store.rs:332` 仍只删除该 grant 的 ephemeral pins。

结果：原 authority 可以返回 retired，但 package 的 revision pin 继续引用固定 root；
后续正常 GC 不能回收被它持有的内容。只为 A 添加内存重试不能修好此路径。

最小修复方向：在原 source/package owner 明确保存可恢复的 capture/pin 身份和释放状态，
或让这种仅服务于存活 capture 的 query pin 使用明确的临时寿命。需要保留 durable handoff、
Experiment 输入等真正跨重启 pin 的既有语义，不宜把所有 revision pin 或整 Run 的 pin 一并删除。
恢复清理只释放原 authority/Operation 创建的实际 pin，且不依赖旧工作目录或重新取得项目读取权限。

定点验收应在 fixed package 捕获完成后重开真实 B Storage/Host owner，再按原地址释放，
验证 pin 消失及不再有引用的对象可被 GC；同时保留另一个 consumer 的 durable pin。

## 非阻断收敛项

`packages/web/application-host/lib/harness/experiment-workspace.ts:376–383` 的物理 Experiment
捕获仍使用 `fileLeaseAcquire` 加 250 ms 轮询。现有 `fileLeaseWait` 使用同一 lease authority，
具有取消实际回执等待（`kernel-client.ts:1243–1244`）和队列重新授权/资源身份核对
（`storage/file_resource_leases.rs:77–149`）。可直接接回这个已有消费者合同，保留取得租约后的
finally 释放。当前路径会尊重排队等待者，但自身不进入等待队列，会增加空请求及唤醒延迟；
本轮未测得性能退化，也不把这一点列为阻断缺陷。

## 证据与限制

- 本轮只做静态审查，未执行 build、全量测试、模型请求或 listener；未改实现文件。
- 复用仓库已有 [managed package 验收](runtime-managed-package-2026-10-13.md) 与
  [managed Experiment 输入验收](runtime-managed-experiment-input-2026-10-13.md) 的有限证据。
  其中 direct Router/stdio、真实双 Rust owner 或受控准入，均不升级描述为 HTTP 或两台物理机器。
- Experiment 的 B 创建与 A 安装、字节 hash/root 核验、原清理 checkpoint 及独立执行机器的
  结构在所读代码中一致；本轮没有从“未运行某场景”推断其存在缺陷。
- 新功能实施、默认运行路径切换、Pi 移除、部署和图像生成不在本轮缺陷判断范围。

## 修复实施与新增证据

本节记录在上述基线审查之后的修复，前文仍描述原基线的问题。

- A 清理接回原 Catalog 已交付外部 Operation 和实际 executor-stopped 证据。普通 Host
  工具的原 receipt callback 只调度该 `extension_package`；启动和来源重连沿专用
  `runtime.source.cleanup` 入口检查原交付清理，不扫描每条普通 durable 事件。
  `package_cleanup` 私有请求在 Catalog 锁外读取原 launch、到 B inspectScope，按
  operationId、source purpose、Run/Thread 和完整 Source identity 释放确切 authority。
  没有重编译、重新 stage 或第二份安装结果账本。首次释放失败不改变成功 stage 回执。
- B 在任何固定 pin 准入之前保存 `extension.package-capture` Storage 清理身份；
  pin ID 从原完整 authority 和 capture ID 派生。失去 Host 内存 capture map 后仍可由
  maintenance 释放原 pin；原 authority 随后退休同一 grant，释放其捕获 object owners。
  不重开 cwd、不重新请求项目读取准入，也不删除其他 consumer 的 durable pin。
- `managed-package-source.test.ts` 的 4 项定点消费者测试已通过：首次 release 未抵达 B 后
  原身份重试、Host capture owner 替换、丢失 pin 回复的清理身份、保留无关 pin、source
  漂移及未确认退休拒绝。运行使用独立 Vitest 5.0.3，先核验真实 package-authoring
  解析器源入口，再通过真实完整 `extension-contract/src/index.ts` 源入口别名重跑通过；
  不是完整已构建包消费验收。新消费者、capture/cleanup 接线及测试还做了真实依赖类型图
  诊断，修正了测试 grant 形状；这些改动文件无直接诊断，但整个类型图仍被缺失第三方
  依赖及其他间接类型错误阻断，不能记为 aggregate type-check 通过。
- 新 Rust 定点用例在 `managed_source_review.rs`：
  `managed_package_delivery_cleanup_recovers_original_catalog_without_replaying_stage` 和
  `package_capture_storage_reopen_releases_exact_pin_and_original_temporary_owners`。
  两条均已分别实际执行 1/1 通过：前者覆盖真实 Catalog 重开及锁外原清理请求；
  后者覆盖真实 Storage 重开、pin 与 grant owner 清理及 GC，并保留另一个 consumer 的
  durable pin。后者先因 fixture 参数不符失败，按真实协议修正后重跑通过；没有修改
  产品协议来迁就测试。

本轮仍不把 source-alias 的模拟 Storage consumer 测试或 Catalog/Storage 定点测试称为
产品 HTTP、完整双 Host 集成、安装包或两台物理机器验收。冻结依赖安装曾在官方
`cross-env@10.1.0` 下载返回 403 后停止；未通过换镜像或变更锁定版本规避。
