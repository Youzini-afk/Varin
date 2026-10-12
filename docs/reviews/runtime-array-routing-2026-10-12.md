# 唯一数组 routing 与真实消费者

日期：2026-10-12。基线：`2cb8967d390f3766197c7f3a46f10430ba65a4d2`。

## 当前合同与有限范围

依据能力组合设计 §4 同源合同、§5 作用域/组合与用户无历史兼容要求，本片消除 rule 和
selection 的 scalar/array 两种解释。所有当前 producer/consumer 使用 `providerKeys`；
已就绪结果使用对应 `providerIds`。原 provider 自身 identity 仍为单数，不机械改名。

- 普通 single 调用需要恰好一项，`[]`/多项不取第一项蒙混执行。
- ordered 调用保完整顺序、每成员声明及全体就绪；显式空集合成功且不选默认。
  无规则时的唯一候选/default 及显式 handle 也要满足 ordered 声明。
- `allowFallback` 只沿原较低优先级整条规则选择，不在当前集合里丢掉缺失成员。
  同级冲突、无效基数和不支持的合同继续明确诊断。
- 原 Settings、store、公开 client、认证 Router、文件 CAS/reopen、合同查询和 Host 准备
  同步迁移。存储 envelope 的实际 schemaVersion 必须有效；旧 scalar 直接拒绝，无导入器。
  已有 last-valid 只保留为 non-authoritative 诊断，不重写坏字节。
  共享 parser 使用原合同错误类型，原 Router 对非法形状返回 `400 invalid_request` 与
  具体字段原因；没有复制 route 校验。CAS 冲突仍为 409，真实存储错误仍为 500。
- Budget/Policy/tool/observer single 消费与 Context Transform collection 分清，真实 main/
  child 的原 scope、provider pin、已接受配方、取消和恢复不因字段统一而改 owner。

本片仍保留原 registry/Surface 全局 selection 路径，其删除另需实现冻结依赖与实例共享的
完整寿命。当前 supervisor 按 extensionId 管活动实例，selected 冷依赖没有贯穿 scoped
准备；不同项目 A 在 activation 捕获 B/C 后不能被无条件共享。后续须接精确 binding 与
组合引用排空，不能只删 map 或在每次 nested 调用重选。trusted-native `services.use`
options 的已知差异也留该生命周期片。本片不宣称选择权威已唯一化。

## 已执行证据

- 原 Settings ordered 控件的真实按钮、原 store→client→带认证 direct Express Router→
  实际 routing 文件验证顺序、删除/继承、显式空、stale CAS 和重开。single/Budget 选择
  有 store/API 保存与控件回显证据；当前 Linkedom 的标准事件不能打开 Select popup，
  因而没有将该部分声称为真实 dropdown 点击验收，也未改产品组件迁就 fixture。
- 原 Host 的 single/collection/metadata、真正 broker nested `services.use` 带 scope 调用、
  原 policy 和 SDK/domain 消费通过聚焦复验。公共 method 查询恰一项能找到原 descriptor，
  多项未指定 extension 时保持 unresolved，不借第一成员 schema 冒充整个集合。
- 原 native 有序 Transform 1/1，Budget 主/child 两用例 2/2：实际原 Host、broker、Rust
  Catalog/Context、请求 serializer、原摘要收费回执、固定配方、取消/变更及重开。
  模型输出受控，没有真实账户外发。
- 独立五组 probe 验证数组/旧 scalar 拒绝、single 基数、ordered 显式与默认、整规则
  fallback/同级冲突，以及真实文件 CAS/reopen/schema999 拒绝、原 bytes 保留与移除。
- 第六组独立 direct Router probe 经过原认证中间件、ApplicationExtensionRuntime 与文件
  owner，验证未认证拒绝、旧形状不写入、有效数组保存、stale CAS 与重开，未激活扩展。
- 原公开 client→Router 入口补验 scalar/双形状的 400 及可操作 details，失败前后原文件
  bytes/revision 不变；同入口一次精确 storage 写失败仍投影 500，没有当成用户输入错误。

原 tool-owner A→B case 首先未通过 1 秒 `expect.poll`。针对改动模块的只读基线源码
overlay 复现同一 `2cb8967` 失败；这只是该 case 的基线对照，不是完整旧版本构建。
将观察改为原真实 `publish(B)`、恢复后的 B 及原条件恢复 A 事件，按目标 service 筛选，
保留原 20 秒总期限和完整后续断言。基线 case 及当前代码原整文件 2/2 均通过，独审已核
最小 fixture diff。没有为此增加生产重试、修改取消或延长测试期限。

原完整 Web aggregate type-check 通过，包含协议生成核对、Host 源码及跨层测试声明、
browser 与 CLI 类型边界。类型通过不等同执行其中 listener 型用例。
最后错误类型收口另经 contract/Host 构建、Web consumer 类型与原公开入口复验；独审
在最终产物上重跑全部六组 probe，通过且无本片阻断。Host、CLI、Web/PWA 与 cloud
runtime 产包通过，工程文档 263 文件/1856 链接无错误。Rust 未改，复用 SHA-256
`c18fd3564023dd1102044a682c3120ee9a2862a6cc49d89042ba4e5e9a9f888d`
的匹配二进制，Web 与 cloud staged 副本及 manifest 一致。

observer 本片的一处 single 数组读经源码和类型检查。其原 native test 预检确认会监听
产品 control/data socket，本次没有执行；没有另造事实 mock 填充“原生持久化通过”。
旧 listener 型 Context composition fixture 仅同步 descriptor 并检查类型，未运行该入口。

## 复跑与交付边界

先构建当前 extension-contract、SDK、builtins、Host；仓库脚本见[开发指南](../development.md)。

```sh
bun run --cwd packages/web test -- src/api/extensions-routing-consumer.test.ts
bun run --cwd packages/web test -- application-host/lib/kernel/extension-tool-owner.test.ts
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::context_transform_review::ordered_context_reaches_original_requests_refresh_and_recovery \
  -- --ignored --exact --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::context_budget_review:: -- --ignored --nocapture
```

Rust↔Host 使用原测试 stdio，Host↔broker 使用原 Node fork 父子 IPC，direct Router 不监听。
实际浏览器/桌面、完整产品 IPC、平台安装及性能负载仍在外层验收范围。Catalog 60 / wire 20
未变；默认运行时切换、Pi 删除与用户资产迁移仍由用户验收后处理。
