# 显式 Host 与 Surface 更新组

基线：`04f0d665a20f8b7d2d3c2ce859603ada0dee6b0d`。本片实现能力组合设计 §9.2
中明确声明的更新就绪组。Catalog **58**、私有 wire **18** 保持；没有新增安装、授权、
效果或窗口存活权威。独立设计/行为审查已接受本片有限合同；整体验收仍按两份设计
的剩余能力和实际平台证据推进。

## 共同合同

- manifest 的 `updateReadiness.surfaceEntrypoints` 明确列出与本包唯一 Host 成组更新的
  Surface entrypoint。成员必须存在、唯一且支持一个共同 Surface。未声明的包保持
  原 headless 更新；已选版本的首次启用和冷恢复也不要求永久存在窗口。
- 普通 Agent apply 记录原 `applyRequested`。缺少组成员就绪时返回真实
  `application_requested` 并投影可操作的等待诊断，旧 selected/active 仍可用。
  Agent 工具不能填入 Surface 就绪证明，也没有第二次安装 grant。
- 原 Host instance 提供短暂 preparation identity。真实 Loader 准备指定成员，含
  lazy 和 declarative 的实际 owner generation；已经连接的 Workbench consumer
  必须完成真实候选 mount/context/资源准备。未列入的可选成员独立收敛。
- 原 Surface scope 和实际 mount lease 的信号贯穿 Loader、UI、Web API、认证 route、
  Host 队列直至原 Catalog 文件锁。锁内只运行同步短校验，确认精确实例、候选、
  desired、成员和取消事实，随后完成原原子写；不在控制锁内启动插件或等待 UI。
- 提交前失效保旧。提交后的断连不能推翻已选事实；消费者可读取同 Host/desired/hash
  的原选择来收敛本地状态。读取失败保留未知诊断，这不重建原 Tool receipt。
  一个 Surface 的失败清理不能杀掉仍由原申请保有的共享 Host 准备；替换候选或明确
  撤销由原生命周期 owner 清理。
- 原 Run/ModelStep 的旧 pin 保留原实现；新合法请求取得新目录。正常更新不等待旧
  exchange 释放才能返回，明确 disable/review/shutdown 仍按实际撤销和排空处理。

## 真正贯穿消费

新增 opt-in 原生入口
`agent_runtime::authored_extension_review::grouped_updates_wait_for_actual_surface_members_then_recover_original_results`
复用上一片的冷产包链。受控模型用真实 FileRead/FileWrite 写入显式组 manifest，原
Source 捕获、权限、ArtifactStore 编译、禁用安装和认证启用均保留。实际普通 broker
先证明已选后台无窗口可用，再连接真实 Loader/Surface/Workbench mount。

同版本坏候选经模型申请，指定成员的真实 mount 失败，Catalog/Host/DOM/样式均保旧；
随后 Policy ToolGraph 申请好候选，watch 完成组准备并提交，旧 disposer 实际执行。
旧 pin 返回旧结果，新请求经过原目录 ACK 和正常 exchange 边界取得新结果。Policy
ReadResult、模型历史与内容引用经过 GC、关闭和重开保持，未伪造模型配对。

另一个入口 `packages/web/application-host/lib/extensions/readiness-consumers.test.ts`
实际执行 Web client → 原认证 Router → runtime/supervisor → Catalog。它在真实
Catalog 文件锁被占用时关闭请求，等待原 runtime 操作真正排空后确认仍选旧版本，
再用同一有效准备成功选择。无准备和错误实例身份由原接口拒绝。这里只控制 broker
transport 和 readiness DTO，真实 mount 证据来自上述贯穿链及所属消费者测试。

## 实际失败与修复

1. 已完成准备的 broker 后来退出，原 staged instance 未失效，仍能被选中。死亡事件
   现在仅取消该 instance 的准备；旧 active 不被新候选的失败连带撤销。
2. 原 Catalog 已选中新 artifact 后强停，错误收尾会回滚已提交的 storage migration。
   原提交事实现在先结束 migration 的回滚资格；不能发布的死亡 generation 关闭新
   准入，旧 pin 仍由原 retirement 保留。真实磁盘 schema/data 和重启恢复分别验证。
3. 同一 slot 中无依赖 A/B 的并行准备，A 发布错误地取消 B。原 Workbench lease 现在
   按更新后的实际 binding 校验其他准备，仅真正冲突才失效。独立原反例修后确认
   B2 信号未取消，两个真实挂载均切到新版本，错误列表为空。

前两条均先在原 Artifact/Catalog/Storage 上复现失败，再由独审重跑同一序列；受控的
是 transport 死亡/停止时点，不是持久结果。第三条使用真实 SurfaceRuntime 和
Workbench mount，避免把同 slot 自动当作更新依赖。

## 复跑与证据边界

- 先构建 `extension-contract`、`application-client`、`extension-host`、
  `extension-surface`、`extension-loader` 等原依赖，再执行上述完整 Rust 名称：
  `cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib <名称> -- --ignored --exact`。
  最终冻结代码的 grouped 链 **1/1，16.93 秒**；原 optional 链 **1/1，23.48 秒**。
- Host 原 `package-authoring.test.ts` 与 `lifecycle-parallel.test.ts` **24/24**，
  contract validation/schema **21/21**。独审精确复跑 crash、已提交 migration 和
  post-CAS 断连/旧 pin 三条 **3/3**。同进程 trusted-native 用例单独选择 **1/1**。
- Loader/Surface 所属纯 Node 行为 **57/57**，覆盖全部成员、可选独立、真实 mount
  close/render failure、提交后丢响应与 queued disable。最后并行 slot 修复后原 Loader
  所属文件 **32/32**，独立原失败脚本再次通过；此前总数不充当该修复的证据。
- 新 direct Router 入口 **1/1**；Node 使用 `--import tsx`，未启动产品 listener。
  模型选择、最小 DOM、显式用户决定和 stdio 交付受控；原业务 owner、真实文件、
  编译器、broker、目录、watch/mount/dispose 和持久结果真实执行。
- Host 生产/测试、browser、CLI 与 Surface/Loader/UI 类型和改动源文件 lint 分别通过，
  未宣称再次运行 Web 顶层 aggregate。Host 构建及 low-memory Web bundle 通过，
  原 cloud runtime 重新 stage 并验证 production lock；supervisor/runtime/route 的
  构建与安装树 hash 一致。布局 **12/12**、生产边界 **7/7**，新 direct Router helper
  由既有 test-helper 规则排除发行。文档检查 **258 文件/1845 链接/0 错误**。
  Rust 生产未变化，仅编译验收 fixture；既有 warnings 和 bundle 提示照实保留。

trusted-native 实现不能同时存在两个 loaded 实例时，本片仍不提供热组接管；诊断
指向明确禁用、应用已审查候选、重启 Host 后启用/恢复的现有路径。不得把 native 冷
启动捷径当成组就绪。更广 Provider/Transform/共享 key 与组合计划继续推进。

完整浏览器/设备、整个 Host 丢失的产品外层重连、跨机/平台安装升级、产品 IPC 和
综合负载性能未由这些证据成立。默认切换、Pi 删除和用户资产全面迁移仍由用户验收后
负责。
