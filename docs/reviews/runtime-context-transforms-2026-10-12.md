# 有序 Context Transform 与真实消费者

日期：2026-10-12。基线：`7a1c86bcdfb9cbbc6fa8ff35c19857275f72a2ae`。

## 本片合同

原 service routing 记录选择 `providerKey` 或明确有序的 `providerKeys`；旧用户单值资产保持。
`[]` 是明确无贡献，automatic 则删除当前作用域规则。每个 collection 成员须声明
`contract.composition: ordered`，`multiple` 不代表可组合；普通单值调用不能偷偷选 collection
的第一项。保留原 scope precedence、CAS 和显式 `allowFallback` 偏好；fallback 重新解析完整选择，
不会把失败的 `[A,B]` 当作成功的 `[A]`。

Context 使用同一原 Host resolver/supervisor/registry，按实际世代准备选中实现。没有未完成
生命周期变更、且原发布/路由 revision 未变时，复用准备而不重新扫描整个 Catalog；换 B 保留
未变 A。取消等待不宣称共享准备或实际 callback 已停止，原 pin/registry 保留其真实寿命。

Rust `ContextComposition` 保存 scope、selection revision 与有序 transforms。每个 transform
保存 provider/content 身份和不可变 sections；item/provenance 采用完整 JSON tuple，跨 provider
同名 section 不冲突，Instruction 与 ExternalData 不混同。纯变换在原读 worker 执行，
不调用扩展、模型或检索。已接受 checkpoint/request 是持久事实；禁用 provider 阻止新准备，
不擦除既有历史或撤回已发送请求。Catalog **59**、私有协议 **19**直接拒绝旧内部格式。

设置页由合同元数据决定是否显示有序操作，保留缺失成员及诊断。原 ThreadContext 同时使用
default user、原 session/project 和已准入 resource snapshot 的 `projectRoot` 工作区配置身份；
该字段不替代执行 cwd，也不授予文件权限。主任务、无文件源 child、资源/记忆/日历刷新沿原 owner。

## 实际组合证据

1. 仓库 `context_transform_review.rs` 与 `context-transform-host.test-helper.ts`：真实逆序安装
   C/B/A，只选择 A/B；原 Host 个人配置 grant/Storage、资源 Context 和 Rust input 准入后，
   两次真实 Responses serializer 保留用户配置、A 的 system 角色和 B 的 data/user 角色。
   第一请求冻结时替换 B，原请求仍为 B1，新请求使用 B2；A 实际 describe 仅一次，未选 C 不激活。
   真正已提交 ModelStep dispatch origin 的无文件源 child，经原 child admission、Host profile/资源
   准备与 `runtime.child.prepare`，实际 ContextRead 使用它自己的 `[B2,A]`；资源刷新保原 scope。
   禁用 B 的新准备失败不改变旧 checkpoint；明确空集合、GC、关闭重开后原请求字节完整恢复。
   精确用例 **1/1** 通过。模型回答受控，未外发付费推理；child 本例验证实际准入/ContextRead，
   没有把它写成一次真实 child 模型生成。
2. 实际设置控件→原 catalog-store→Web ExtensionsAPI→原带认证门的 direct Express Router→实际
   ApplicationExtensionRuntime/routing 文件：调序、重建后保序、未选 C、缺失成员、stale CAS
   409 不重试覆盖、末项删除写 `[]`、automatic 删除规则、旧 single 及 workspace 保存均验证。
   仓库入口为 `packages/web/src/api/extensions-routing-consumer.test.ts`，**1/1** 通过，共 11 次写请求。
   认证回调由 fixture 提供，不等于真实登录流程验收。
3. 独立设计审查用真实 broker 完成六条风险样本：成员失败不缓存半份；共享冷准备只取消一方；
   describe 中取消后实际 callback 完成且重试重新描述；准备中 routing 改变拒绝旧候选；
   新鲜及缓存成员撤权均阻止新准备；`[]` 不 fallback。源码与主组合复核后接受本片。

首次主组合未通过：测试用裸 model-session start 丢掉 input 已准入的工具目录，Catalog 正确拒绝
`request differs from the activated tool composition`。修正测试绑定原目录及原 Question/Observation
策略后通过，没有放宽产品校验，也不把这次测试设置纠正列成生产修复。

发布前增加实际 root/child 交替刷新，复现不变 scope 互相失效：准备次数从 4 多增至 6。
原因是每次纯绑定结束都无条件发布全局 revision。最小修复删除该冗余发布，真正注册、激活、
撤权、选择及 Catalog 变更仍由原 owner 发布；相同失败链修后通过，未创建第二缓存/世代 owner。
这证明消除了该重复准备路径，不代表已经达到全局延迟或吞吐目标。

有限消费者核对还发现自动压缩准备漏传其原 job controller 的 signal。单行补齐后，真实
ContextService 用例验证单个 query 取消只结束观察，原 job 准备仍继续；owner close 才取消
该准备，迟到纯结果不会准入 summary Job。没有把 query 与共享工作的取消寿命合并。

Rust↔Host 使用既有测试 stdin/stdout rendezvous；Host↔扩展使用原 Node fork 父子 IPC。
没有启动产品监听、Unix/HTTP socket 或替换 broker transport。直接 Router 用例也未监听端口。

## 复跑与范围

先按[开发指南](../development.md)准备锁定依赖并构建 extension-contract、SDK、builtins、Host、protocol。
主组合命令：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::context_transform_review::ordered_context_reaches_original_requests_refresh_and_recovery \
  -- --ignored --exact --nocapture
bun run --cwd packages/web test -- src/api/extensions-routing-consumer.test.ts
bun run --cwd packages/web test -- application-host/lib/kernel/context-service.test.ts
```

本片额外核对原 routing/contracts/store、有序 pin、UI 控件与 CAS/翻译一致性，以及 Host/shared/UI
类型、完整 Web aggregate 类型命令、协议生成和改动 lint。原 Host 构建与低内存 Web/PWA bundle
通过；Linux development Kernel 按 0.9.25 / protocol 19 构建并核对 staged ELF/manifest。
cloud runtime 以 frozen production lock 验证及原 layout/identity 检查收口，无依赖变更。
这些证据支持各自边界，不按测试数量折算整体完成度。

实际产品 Host IPC、真实浏览器/桌面、全平台安装及组合负载/延迟目标仍需外部验收。
本片只闭合有序纯 Context Transform；更广能力组合计划/共享实例合同、Bot 与长期任务、
远端一致环境、完整编辑/交付产品链等剩余设计继续实施。默认 runtime 切换、Pi 删除和全面资产
迁移仍由用户验收后负责。
