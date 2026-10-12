# 可替换上下文预算与原摘要生命周期

日期：2026-10-12。基线：`e91d9cad949eecf694a0207ced8755366bc49a29`。

## 范围与共同合同

依据能力组合设计 §6 的命名 Decision、§11 的压缩策略替换，以及运行时设计 §13.2 的
固定祖先摘要与记忆快照合同。本片实现可选择的 `varin.context.budget@1`，不是新增默认
模型调用链；provider 容量错误反馈、完整自动记忆及 Bot 生命周期仍另行交付。

原用户/可信工程配置拥有 enabled、reserve/keepRecent、后台准备与水位。原 routing 拥有
显式策略选择；原 Host supervisor/registry 拥有 provider 世代和实际回调寿命。原 Run /
ContextJob / ContentStore 拥有实际摘要、原始用量和结果。没有第二份策略库、工具名单、
摘要状态机或执行回执。

- 默认仅一次短 Host 设置/选择查询，不激活已安装但未选中的扩展，不发送历史候选列表。
  只有明确选择外部策略才发送请求估量、容量、设置和原生计算的合法祖先候选。
- 普通 Decision 不收到历史正文、模型账户、工具权限或任意执行回调。Core 验证其边界来自
  当前固定请求且保持工具配对，用户关闭后台准备时不能受理新 background 决策。
- describe/decide 在同一次真实 pin 生命周期内完成。普通更新允许已开始的旧回调完成；
  显式撤权拒绝未完成结果。等待方取消不证明回调结束，真实 callback 结束前原 owner 仍保留。
  成功返回的决定是不可变候选数据；其后还须经过原 Run/祖先/修订准入，不是持续执行权限。
- 当前 ContextJob 必须保存 `summary_recipe`：builtin/extension 身份、包 artifact、声明配置、
  设置配置身份、模式和可选摘要指导。手动入口明确生成 manual 配方；无旧字段默认或旧格式
  reader。Catalog **60**、private wire **20**直接拒旧，不删除外部配置或用户资产。
- 同一 owner/checkpoint/model/credential 的并发准备只受理一份原任务。遇同一任务已受理的
  特定错误才读取它；不把其他失败吞成成功，不靠新 key 重试未知或失败的收费工作。
- 摘要仍由原 tool-free SummaryPolicy/ModelStep 执行。固定系统限制不被额外指导覆盖，指导
  计入实际分段预算；原始生成/usage 归属不变。发布原子保留 `摘要(A)+B+N`、系统提示、
  memory 和 resources；路由或设置改变不改写已受理 recipe，也不重新执行已完成摘要。

## 实际证据

1. `context_budget_review.rs` 与 `context-budget-host.test-helper.ts` 两项 **2/2**：
   - 主链使用真正 RunAssembly、Responses serializer、Storage/personalization、普通扩展
     broker、ContextService 和 ContextJob。首次仅安装不选择保持冷态；实际错误策略返回
     background 时保用户禁用选择，零摘要准入、零模型生成、checkpoint 不变。
   - 正常示例选中后生成冻结配方；摘要进行中追加 N，并改变策略选择与下一请求预算。
     原摘要完成而发布尚未发生时关闭/reopen，真实恢复 owner 发布原结果，等待的主 Run
     继续消费摘要+B+N及原用户提示。原模型用量 `actual`、10/3 与 raw 回执重开后保留，
     未再次调用 Decision 或生成同一摘要。模型输出由受控 provider 给出，没有外发付费服务。
   - 真正已提交 dispatch origin 的无文件源 child，经原 child admission、ContextPreparer、
     `runtime.child.prepare` 和 ContextService，使用其自身 session 路由；parent 不随之选中，
     原 worker 角色保持。此项是 child 准入/选择证据，不是一次 child 模型生成。
2. 原 `context_job_review` **6/6**，包含不同边界的并发候选只受理一份、原配方/GC/重开。
   Rust 单独禁后台决策回归 **1/1**；原 owner channel 的下一帧不能是 compact，原 checkpoint 保留。
3. contract/SDK 纯 Node **3/3**，原 broker smoke **3/3**，新可安装示例 **4/4**。
   smoke 验证未选冷态、不同 scope 缓存、真实包更新保旧 pin/新调用使用新配方、显式撤权。
4. `extensions-routing-consumer.test.ts` **1/1**：原有有序控制继续验证；额外真实安装预算
   示例后，同一 Settings store→public client→认证 direct Router→文件 CAS 完成单策略选择，
   实际 ServiceRoutingControl 回显与合同查询一致，不激活 broker。新增单策略写入由 store
   调用触发，未把它宣称为一次真实点击 dropdown 的端到端事件测试。
5. 独立设计审查使用另一真实 broker 门控探针验证六类生命周期，并核对用户/可信工程设置、
   原祖先/tool-pair 门、锁外正文、严格当前格式和原恢复路径。确认的问题及修复见下节。

### 独审发现并关闭的缺口

用户关闭 `backgroundPreparation`，错误的普通扩展仍返回 background。旧新接入代码只检查
了 enabled，Host 上游可构成配方，Rust 会继续发 compact，违背用户禁止后台模型工作的选择。
修复只落在 Rust 原新 Decision 边界，返回 `context_background_disabled`，不暗改成 blocking，
不为 Host 再维护同一合法性规则。已有已受理任务不被设置变化追溯改写。独立上游反例、窄 Rust
回归与上述真实 broker→Host→RunAssembly 的零任务/零模型断言共同验证，审查接受本有限片。

整合期间另修了新 fixture 的路由遗漏、模型完成 cursor 转发和 child metadata/public DTO
区分，未把这些测试接线错误称为产品回归。初轮把低预算下新的合法压缩误当重复原摘要；
最终用例明确放宽下一请求预算，只验证旧已受理任务的恢复，不否认新 checkpoint 上的合法新工作。

## 复跑入口

先准备仓库规定的 Rust/Node/Bun 与普通类型依赖，构建示例：

```sh
node examples/extensions/context-budget/build.mjs
node --test examples/extensions/context-budget/host.test.mjs
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test context_job_review
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib context_budget_review -- --ignored --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib external_background_decision_cannot_override_disabled_user_preparation
node --import tsx --test packages/web/application-host/lib/kernel/context-budget.smoke.test.ts
cd packages/web
node ../../node_modules/vitest/vitest.mjs run src/api/extensions-routing-consumer.test.ts
```

这些入口逐项检查后使用：Rust↔Host 是现有测试 stdin/stdout rendezvous，Host↔broker 是原
Node fork/process.send；direct Router 不监听网络。它们不替代产品监听 transport、真实登录、
provider 账户、真实桌面、跨平台安装、负载/延迟或摘要质量验收。旧含 HTTP listener 的自动
Context native fixture仅同步当前 DTO/类型，未运行、未计成功。

完整 Web aggregate 类型检查最终 exit 0。首轮发现原手动压缩 UI fixture 仍构造旧缺字段 DTO，
已同步显式 manual recipe；其原重试/发布/历史保留用例精确运行 **1/1**，其余 81 项未运行。
Host、Web、CLI 构建与 cloud staging/386 包冻结锁验证均通过；Host production graph 为 572 个
可达模块，排除 180 个测试/旧 artifact。最终 Linux debug kernel、Web staged 和 cloud staged
字节一致，build identity `0.9.25`、wire `20`、ELF x64：

`c18fd3564023dd1102044a682c3120ee9a2862a6cc49d89042ba4e5e9a9f888d`

协议生成一致性、diff whitespace 与工程文档链接检查通过。构建不是上述未验平台的替代。
后续仍按两设计及用户明确范围推进，不自动切换默认 runtime 或删除 Pi。
