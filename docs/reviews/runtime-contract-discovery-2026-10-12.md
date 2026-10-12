# 同源运行时合同查询与调用级工具目录

基线：`3aff05de0ac5b24103f2dcb7500b0338a31559ba`。本片实现扩展设计 §8.1 的有限纵切；
Catalog **58** 保持，私有 kernel wire **18** 直接拒旧。独立设计/行为审查接受本片有限交付。两设计整体与外层产品验收仍未完成。

## 两种事实与原 owner

普通 `runtime_contract` 支持精确 service/method/event、UI slot/props 查询，以及自身
调用的 tool list/describe。短目录和单成员完整 schema 分开，不给每个请求注入完整说明。

- `current_catalog` 从原 manifest/catalog、ServiceRoutingStore、HostServiceRegistry、
  WorkbenchProfileStore 读取。共用原纯 resolver，不调用 provider 的 `inspect`、
  `prepareService` 或用户代码。返回原修订号、依赖声明、selected provider 及 actual codes。
  已声明冷服务、未声明 schema、缺失、歧义、禁用、失败、active/draining 不互相冒充。
- `accepted_run` 直接复用 SDK `call.tools.list/describe` 与原 `NestedTools::Scope.frozen`。
  查询携带原 parent Operation/executor，不能自选 Run、schema generation、source 或 grant。
  list 给短 name/version/description；describe 返回该目录原 ToolSchema，未选择则 null。
  读目录不启用工具，真正调用仍走原权限/资源准入。关闭/取消或错误 executor 拒绝读。
- Host/Kernel 间的大 schema 读在既有 content worker 运行，Scope 锁只取得 frozen Arc，
  不在 Catalog/control 锁里复制序列化正文。模型、Policy、nested/child 的结果仍由原
  ContentStore、历史/graph receipt 和 child report 持有，没有新目录账本或第二回执。

`ServiceProvision.contract` 是同一 descriptor 的可选 method/event schema、参与方式、
精简示例与包内 source path。manifest、激活一致性检查与 registry 保持一份定义；
声明方法必须在原 handler lookup 上可调用，合法 class prototype 方法仍可用。
Tool execute schema 从原 tool declaration 生成，context-fragments 用其原合同常量。
其余未补元数据的旧 service 诚实返回 `undeclared`，未宣称全部 RuntimeAPIs 自动反射。

六个 Workbench slot 的 props 类型与 JSON schema 从同一字段定义派生，原六处 mount
继续消费该类型。选中 shell 的 hosting 声明、dormant/unresolved 与实际 Surface mount
分开；Host 只知道 `live: unobserved`。未知 shell contract version 沿原兼容性 owner
给出 unresolved/code，不解释未知 data，也不禁止合法未来 manifest 安装。

## 实际消费者

- framework-neutral API → Web client → 原认证 Host route → 公共请求 decoder → 真实
  ApplicationExtensionRuntime 查询。公开调用只接目录/surface 上下文，不能传 routing
  authority 或 Run。目录复用原 Documents canonical/allowed/trust 校验与已有身份查询，
  未登记目录不注册新 workspace；保原 canonical-directory/project 路由。
- Rust 原 Run/ModelStep → 真实发行 builtin 与普通测试扩展 broker → SDK frozen list/
  describe → 原 nested tool 查询；独立 Policy ToolGraph → 实际 ReadResult 分块读取。
  原模型配对仅包含模型发出的外层调用，nested/Policy 不造伪模型历史。
- 原 ChildDispatch 冻结的双工具父目录显式缩减为一个 `runtime_contract`，原无来源 child
  准入与新 Run 真正执行普通 tool 目录查询；父工具不进入 child describe，Run 身份独立。
  子报告和原结果经 GC、关闭重开保持。测试的 parent model/dispatch 决策与 stdio 传输
  受控，目录/broker/SDK/Catalog/内容与恢复使用真实 owner；不声称完整 Host IPC 启动。
- 当前目录可列出未选中的冷安装工具，而 frozen tool 查询保持缺失。测试冷 provider 的
  activation 会写哨兵并失败，验收要求它从未执行、原 registry 也没有该实例。

## 本片发现与处理

1. 原 `ApplicationExtensionRuntime.state()` 会运行 Workbench profile/workspace 迁移。
   只读查询改用同 owner 的无迁移 snapshot；测试封锁 workspace resolver 与 storage.update。
2. 独审由真实 Router.handle → Documents 复现纯目录查询创建 workspace：注册 0→1、
   新写 workspaces.json、onWorkspaceResolved 调用一次。修为原 Documents 内部只读 lookup，
   同一探针修后注册 0→0、无新文件、callback 0；原显式 resolveWorkspace 语义保留。
3. 独审以合法未知版本 shell 复现 ui_slot list 整条解析失败。原 compatibility 检查前置，
   不把未来 data 强解成当前 schema，返回 unresolved 与实际不支持代码。
4. 原直接 prepareService 的 activation 失败只在部分外层调用记录 actual。
   同一原 owner 在真实准备失败时记 failed；旧 active 仍有效则保 active 和候选失败码，
   epoch/generation/cancel 栅栏阻止旧失败覆盖新事实。未新建状态表。
5. 同 semver 的真实 local candidate 发布存在持久 catalog 已更新、registry commit 尚未
   返回的窗口。旧 active 的 descriptor 不能与新 manifest schema 拼成同一个 ready 合同。
   当前 registered/selected provider 投影核对原 descriptor；不匹配时保真实旧 instance，
   当前声明为 declared，显式旧选择给 stale/selected_contract_changed。查询不换绑或释放旧调用。
6. 旧能力表曾提前写 SDK tools.list/describe 已完成；源码只有 invoke。本片才补上两入口，
   台账已纠正来源，不把历史阶段的测试数算作当前合同证据。

验收 fixture 也纠正两次错误预期：普通 Host read 回执按既有合同为 Confirmed，不能为了
测试要求 None 而改变真实效果；GC 在 fixture 仍持 ChildDispatch publication 时正确 deferred，
应释放原 reader 后再验收 collection。两者都不是生产行为缺陷。

## 当前同版本证据

- 实际普通 builtin/broker/SDK、ModelStep、nested、Policy 和缩减 child 的组合及两份
  Catalog GC/重开 **1 条整链通过**（3.09 秒）；不是按域 mock 的独立绿灯相加。
- 原 Rust nested scope **4/4**；精确 executor、冻结 schema、结束/取消及真正调用排空
  沿已有测试增强，没有新增持久能力 owner。
- 合同 schema、真实 broker/native 激活与 Host capability **13/13**；原 registry/
  并发生命周期/旧 pin/撤权四文件 **27/27**。schema 声明的 class prototype 方法可用，
  缺失声明方法由原激活失败路径拒绝。
- 真实 client/route/owner 与 Web adapter **10/10**；实际 EditorGroupTabs 挂载及原
  Workbench registry **10/10**。Documents 原命名空间/路径/信任定向 **2/2**。
- kernel wire 18 的 Linux x64 identity `0.9.25` 已新构建/stage，cloud 布局使用同一
  SHA-256 `14e0e5cd65f23e2f206a6dc4d3e93e5d876958ad99250648758304580d2c6699`。
  原 Host production build、cloud-runtime stage、布局 **12/12**、production boundary
  **7/7** 通过。它们不替代实际产品 IPC、全平台或交互式 Surface 启动。
- Host production/tests 类型、UI 类型、application-client 构建、生成协议、变更 lint
  和文档链接检查通过。新跨层测试已移回 Host integration tests，运行期加载实际 client
  并以公共 API 类型约束边界；直接调用 Express Router 修正其 `.handle` 未声明类型。
- 完整 Web `tsc --noEmit` **未通过**：仍有 113 条 Host 类型诊断。旧
  `test/integration-surface-vertical.native.test.ts` 静态导入 Host，使其进入 browser ES2022/
  DOM 类型环境。只读 HEAD 源码 overlay 的 113 条 Host 诊断与当前结果逐条匹配
  路径、行列、代码和首行消息；这不是独立干净基线 build（它仍用当前构建声明，另外
  两条新旧 protocol/API DTO 差异单列排除）。本片没有新增剩余 Web 诊断，也没有
  放宽 compiler 或改 Host 生产实现掩盖错误；原跨层测试类型归属仍需专门收口。

## 复跑与未验范围

需先按各 package 脚本构建 contract/SDK/builtins/extension-host；受限环境可使用既有
无监听的 Node TS loader，不运行 tsx CLI 或产品 socket helper。

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  runtime_contract_review -- --ignored --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime nested_tools::tests
node --import tsx --test packages/extension-host/test/runtime-contracts.test.ts
node --import tsx --test packages/extension-contract/test/runtime-contracts.test.ts
node node_modules/vitest/vitest.mjs run --config packages/web/vite.config.ts \
  packages/web/application-host/lib/extensions/contracts-consumers.test.ts
```

本片不是全部 legacy service 元数据补全、任意实现源码读取或全 Application API 反射。
六标准 slot/props 查询也不等于全部 replacement、快捷键及各类贡献的完整查询。
Agent 产包到实际工作台挂载/释放、完整组合复用/冲突、远端环境/Bot、其余设计能力与
外层产品/平台/负载验收仍分别推进。默认 runtime 切换、Pi 删除和全面资产迁移由用户负责。
