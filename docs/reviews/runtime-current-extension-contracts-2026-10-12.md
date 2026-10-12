# 当前扩展声明与严格 Catalog

日期：2026-10-12。基线：`f202330187501048325e5177783b38ca69ee7dea`。

## 有限范围

按用户明确的无历史兼容要求、AGENTS 和能力组合设计 §4 的同源声明、§9 的原生命周期，
本片删除三种旧轨，不迁移历史内部数据，不删除包、配置或工作区资产。

1. `provideContextFragments(context, fragments)` 一律注册 `VARIN_CONTEXT_FRAGMENTS_SERVICE`。
   删除第三参 opt-in，发行内置和 `examples/extensions/project-context` 使用同一合同。
   其他服务的可选 metadata 仍可缺失；它们不是旧 ContextFragments 格式。
2. tool、method/event 的 source 共用 `runtime-source.ts` 包内相对路径和正安全整数行号解析，
   JSON schema 共用 `contractSource`。metadata 不再吞掉错误；未声明 source 仍合法。
   source 元数据不授予文件权限，实际读取仍核对原不可变 artifact/slot/integrity。
3. builtin reconcile 不再修补 raw record 后解析，也不为修补增加写回。
   当前合法记录仍按发行定义更新内置合同/grants，并保留用户 enablement；外部扩展的
   candidate、grants 与文件仍属原 owner。坏 Catalog 显式失败，原字节保留；已有 last-valid
   快照只作为 `authoritative:false` 诊断，不能充当成功回退。

当前 routing 的 scalar/array 双形状、registry/Surface 第二选择表及 selected 依赖的 scoped
准备尚未在本片删除。它们须一起贯穿实际消费者，不能只删字段后令冷依赖永远未就绪。

## 实际验证

- 原 contract/schema 用例 8/8：工具和方法同拒绝 absolute/traversal/URL/backslash/NUL 等
  非包内路径，合法 Unicode/空格路径、合法行号与缺 source 保持明确语义。
- 原 Host 四文件 31/31：发行内置和真正打包的作者示例经 Node broker 准备、inspect/describe；
  冷 metadata 的 tool `execute` source 沿同 slot/integrity 读回原不可变字节；正常 Catalog
  更新、用户停用、严格拒绝坏 bytes，以及原候选/CAS/生命周期覆盖。
- 原 native 有序 Transform 组合 1/1：真正 Host、原 Rust Catalog/Context、模型请求序列化、
  child 准入/ContextRead、refresh、GC 和关闭重开。模型回答受控，不外发付费推理。

第一次 Host 聚焦运行暴露旧 storage-sync 测试的错误故障门控：它先令 staged broker crash，
等待 200ms，再期望普通 select 拒绝。现有 select 合法地重新准备仍有效的同 artifact，
所以该测试并未命中所声称的发布期 storage-sync 失败。独立源码核对确认生产语义未回归。
最小纠正只在该测试包装原 `ChildBrokeredHostTransport.request`，精确让 v2 三个已提交
存储文档的 `storage.sync` 一次失败，其余请求仍走真实原 transport。断言故障确实触发，
三文档回滚、旧 provider/Catalog/candidate 保留，然后重新准备成功；未增加生产限制或重试。
初次 malformed Catalog 新测试也纠正了 fixture 预期：没有 last-valid 的首次坏读必须抛错，
不能要求返回 stale。最终原组合已复跑，不将首跑失败记作通过。

独立审查从设计先建立合同，随后核源码并运行三项独立探针：helper 输入/返回隔离；
Unicode source 的声明/schema/metadata/原字节；正常内置更新和坏 Catalog 对外部 candidate、
拒绝 grant、用户停用状态与资产的保留，全部通过。另独立复跑真实打包 SDK→broker 用例通过。
结论是本有限片无剩余确认阻断，没有把下一片 routing/实例共享记作完成。

extension-contract/SDK/builtins/Host 四包构建、各自类型检查及改动 source lint 通过；
原 Web aggregate `type-check` 全量通过，包括 Host declarations、Host tests、Web 与 CLI。
原 Host build 的 572 个可达生产模块、Web/PWA、CLI 和 cloud runtime staged layout 均成功；
cloud 生产锁图为原 386 packages，无源码依赖或锁文件变更。Rust 源码未改，复用已有匹配
0.9.25 / wire 20 的 Linux debug binary，不将复用说成另一次完整 Rust 编译。
文档检查和 `git diff --check` 通过。

## 复跑入口与边界

先按[开发指南](../development.md)构建 extension-contract、SDK、builtins 与 Host。

```sh
node --import tsx --test packages/extension-contract/test/runtime-contracts.test.ts \
  packages/extension-contract/test/schema-runtime-consistency.test.ts
node --import tsx --test packages/extension-host/test/application-runtime.test.ts \
  packages/extension-host/test/catalog-store.test.ts \
  packages/extension-host/test/runtime-contracts.test.ts \
  packages/extension-host/test/runtime-source.test.ts
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::context_transform_review::ordered_context_reaches_original_requests_refresh_and_recovery \
  -- --ignored --exact --nocapture
```

Rust↔Host 为原测试 stdin/stdout rendezvous，Host↔broker 为原 Node fork 父子 IPC；没有产品
监听或真实浏览器/桌面验收。本片没有修改 Rust、Catalog 60 或 wire 20；不重新声称全平台、
模型质量、安装和性能目标通过。默认 runtime、Pi 删除及资产全面迁移仍交用户验收后处理。
