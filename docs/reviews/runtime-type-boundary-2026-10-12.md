# Web 跨层测试的原类型边界

基线：`ed1dec5aac20931e02b237aa918066716a219757`。本片收口上一片记录的完整 Web
类型检查失败；运行时行为、Catalog **58** 与 kernel wire **18** 不变。

## 原因与最小修改

旧 `integration-surface-vertical.native.test.ts` 同时消费真实 DocumentRegistry、Web watch
parser、Documents authority、IntegrationCoordinator 和 Kernel test helper。其三个 Host
相对导入把 297 个 Host 源文件带进 browser 的 ES2022/DOM 编译环境，产生 113 条诊断：
ES2023 集合方法缺失、级联类型推断、Node/DOM RequestInit 不一致等。Host 在自己的
ES2023/Node 项目已能通过。此前 HEAD 源码 overlay 与当前 113 条 Host 诊断逐条一致，
但使用当前构建声明的 overlay 不作为独立干净基线 build。

修复只复用已经存在于 CLI/测试的 `#application-host` 边界：

1. 原 vertical test 的三个 Host import 改为该私有路径；完整业务测试体、文件名和
   native suite 发现入口不变，仍检查 disk 与 dirty editor 的 merge/undo 联动。
2. Web TypeScript 从原 `.application-host-types` 读取真实编译产生的声明。路径按 Web
   自己的 baseUrl 解析，未拷贝接口、扩大 lib、添加 any/ignore 或排除该测试。
3. 原 aggregate `type-check` 先准备并检查 Host、生成新声明和检查 Host tests，再检查
   browser 与 CLI。Host 实现仍在原 Node 环境被完整检查，consumer 参数/DTO 继续静态验证。

原 Vitest 和 native kernel config 的 alias 仍指向实际 Host source。声明不在运行时冒充
实现；没有新测试传输、source adapter 或执行 owner。另两个 UI 测试原本直接引用轻量
Host 模块，本片未泛化成“browser program 绝无 Host source”。

## 已验证结果

- 正式 `bun run --cwd packages/web type-check` 完整 **exit 0**：包括协议校验、
  依赖构建、Host 生产声明重新生成、Host tests、完整 Web 与旧跨层 consumer、CLI
  source/tests。此前 113 条诊断清零，未删除任何检查项。
- 独立静态图确认旧 vertical test 仍是 Web root，真实 Host producer 仍在 Host roots；
  三个编译期导入都解析到新生成的原声明，三个运行期导入仍指向原 Host `.ts`。
- 独立内存负向探针不执行模块：原 consumer **0 诊断**；分别错填 authority.hostId、
  mergeResult.resultRevision、DocumentsAPI adapter 的 ready.content，三例各产生
  预期 **TS2322**。原接口没有退化为 any，也没有把真实 DTO 契约变成测试自造定义。
- 测试主体与前一提交逐字一致；原 native/portable discovery 保持。定点 lint、diff
  与工程文档检查通过。无需重建未改的 Rust 内核或重跑不相关行为套件。

独立审查接受本片有限类型边界修复；未推断新的运行时行为通过。

## 验证边界

复跑使用原 package 命令，不额外准备一份手写声明：

```sh
bun run --cwd packages/web type-check
```

静态检查与实际业务执行分开。该旧 native fixture 会启动产品 IPC；本环境对此已有明确
拒绝，本片没有执行它或尝试其他权限/transport 路线。实际 disk/editor/Kernel 产品组合
仍由既有 native acceptance 入口在可用环境执行，不能用类型检查通过代替。
