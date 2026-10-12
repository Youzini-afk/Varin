# Agent 产包与原扩展生命周期

基线：`f927e0f538af301a44b0143764ce85540c713fb4`。本片把 Agent 的实际文件结果接到
原扩展安装、授权、候选、Host 和 Surface 消费者。Catalog **58**、私有 wire **18** 保持。
独立设计/行为审查接受本片，六条已证实反例修后闭合；这是两设计的一条有限纵切，
整体交付仍未完成。

## 单一合同和效果归属

- 普通 `extension_package` 提供 `stage` 和 `apply`，同一声明由现有
  `varin.builtin.runtime-contracts` 分发。权限仍检查原工具、参数、Run/Operation 和
  retained executor；没有新增工具白名单、安装 grant 或独立效果账。
- stage 的 Source/路径权限来自原准入。fixed 分支按精确 revision/pin 读取；物化和
  live 来源通过原原生捕获器读取真实 working copy，二次核完整 inventory。它不把
  旧分支内容冒充当前文件，也不声称两次扫描等于操作系统原子快照。临时编译输入由
  原 blob reader/pin 保活，结果来源保存原 Run、Operation、Source 与捕获 hash。
- 原 ArtifactStore 编译、校验及持久化字节，长工作不进入控制事务。首次安装为
  disabled 且没有 capability grants；更新保留原 desired/grants 并进入原 candidate。
  新 capability 仍需原用户 review，普通 apply 不能偷偷启用扩展或批准它。
- 已启用、能力已审查的精确候选，经过原效果工具授权即可记录 `applyRequested`。
  不要求额外重复 UI Apply。`application_requested`、`selected` 与实际 active 分开。
  后台与 Surface 独立：可用后台可以提交；可选界面失败保留自己的旧资源与诊断。
- 源码、编译包及版本身份都由原 artifact owner 提供。相同 semver/schema 的实现更新
  仍使用不同内容地址。捕获编译配置只使用包内 JSONC/extends 闭包，不借 ambient
  tsconfig、安装依赖或读取捕获目录外的实现。
- 原 ToolBridge 保留实际回调和原回执，Kernel 重启不重跑效果。若整个 Host 丢失且
  原回执未持久化，Operation 仍为 Unknown；不能从现有包 hash 猜原调用成功。
  原目录可独立恢复其已持久化的候选申请。清理/观察者失败不覆盖已取得的效果事实。

## 真正消费链

新增 `examples/extensions/agent-authored-panel` 是可实际打包的有限示例：普通只读计数
service/tool、managed Surface、Workbench slot、样式和图片资源；无额外 capability。

受控模型通过真实 FileRead/FileWrite 把包写入已准入的物化来源。冷启动发行目录自行
发现 `extension_package`；它没有被注入初始工具数组。原 permission open/decide/consume、
Storage capture/getBlob、ArtifactStore 与 Catalog 完成禁用安装。原认证 Express Router
执行明确启用动作，然后普通动态工具进入模型的合法下一请求。

同一条 stdio 链继续两次同版本更新：第一次由模型 apply，后台更新成功但真实 Surface
mount 抛错；原 watch 消费已选 artifact，保留原 DOM、样式和资源。第二次由 Policy
ToolGraph apply，ReadResult 读取原结果；真实 watch 安装新界面并执行旧 disposer。
整个过程保留 A 的原 service pin，A 仍返回原结果；新请求在原 `tools.ready` 的精确
artifact ACK 及一次正常 exchange 边界后调用新实现。最终释放 A 后观察其真实退出。
关闭 Surface 清空 DOM/样式，独立后台仍 active。原模型历史和 Policy 引用经过 GC、
关闭和重开保持，Policy apply 没有伪造模型 ToolResult 配对。

这里受控的是模型选择、用户 allow-once 决定、stdio 交付和最小 DOM；原业务 owner、
实际文件、编译器、普通 broker、动态目录、watch、mount/dispose 均真实执行。没有启动
产品监听，也没有把此 fixture 称为完整浏览器或生产 RunAssembly/context 验收。

## 真实失败及原 owner 修复

独立审查从设计合同建立反例，随后用原探针复验：

1. 候选 context/when 先按旧上下文判断，提交后才发现新 mount 失败，会丢旧界面。
   原 context owner 增加不发布状态的候选 preview；真实可见 mount 在提交前准备，
   失败保持旧 generation/DOM/资源。跨 owner 可见性也沿原 winner 规则计算。
2. esbuild 可从 ambient/extends 读取捕获外配置。原 artifact 编译输入显式限定完整
   package-owned JSONC 配置闭包；合法包内继承、alias 和原源码仍保留。
3. 同步观察者抛错覆盖已完成目录提交。原 runtime 通知边界记录观察者错误并继续
   其他观察者，调用方收到实际安装/申请结果。
4. 候选已选中却等待旧 Run pin 释放才返回 apply，旧 pin 又要等 apply ToolResult
   完成 exchange，形成环。原 supervisor 在发布后独占跟踪 exact-generation
   retirement，正常替换先返回真实结果；旧调用继续，显式 disable/shutdown 仍等待
   实际撤销、排空和清理，不伪称释放。
5. A pin 跨 A→B→C 时，无 pin/callback 的 B 被已 draining A 连带保活。原 registry
   每次 replacement 只接手 active 前任；A 仍归自己的 retirement，B 独立释放。
6. 显式 UI Apply 的失败清理，以及另一个选择调用者的取消，都会撤销正在提交的
   共享 Host 候选。原 supervisor 分清消费者 cleanup、等待取消和权威撤销：每次
   选择的临时精确条目保准备到提交的空隙；cleanup 不抢先杀别人使用的准备。
   单个 signal 在共享准备实际结束及本人提交入口检查，已经开始的提交按真实结果
   完成。明确用户丢弃先赢原 Catalog CAS 再 reconcile；disable/shutdown 仍撤销
   实际 owner。没有新增目录、授权或效果账。这条定序探针的 Catalog 持久写边界和
   transport 受控，Loader/Surface/Workbench/Supervisor/Registry 为原实现。修后的两个
   原触发序列均为 Host 成功/new hash/gen2 active，UI 原错误和旧界面保留。

另一个测试修正单列：Policy 更新后已经冻结的模型请求合理保留上一工具实现。
fixture 原来立即期望新结果，修为观察实际 ready ACK 后经过正常 FileRead 边界；
没有改产品冻结合同或提前释放旧 pin。普通 watcher 只读取 selected，未请求的
candidate 不因界面存在而自动应用。另修复原公开 UI 对 disabled brokered 候选选择
误启动 Host 的旧分支：仍过能力审查和精确 CAS，只选择内容，增强原首装用例确认
后续 disabled 更新被选中且 Host activation 为零。

## 验收入口和范围

- opt-in 原生整链：
  `agent_runtime::authored_extension_review::model_authored_files_stage_disabled_then_original_enable_reaches_dynamic_model`。
  `cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib <完整名称> -- --ignored --exact`。
  需先构建原扩展包；Node 使用 `--import tsx`，不使用 tsx CLI。最终增强链 **1/1**，
  19.63 秒（最终冻结依赖重建后），包含上述两次更新、watch、Policy、原结果 GC/重开。
- 原 owner 行为入口：`packages/extension-host/test/package-authoring.test.ts`、
  `lifecycle-parallel.test.ts`、`service-registry.test.ts`；包括原取消后实际准备排空、
  capability review、冷重启已申请候选、失败保旧和 pin 退役。受控 transport 的取消/
  恢复证据与整链真实 broker 证据分列，不冒充整进程崩溃验收。最后修复相关两文件
  **17/17**，disabled 首装增强后所属文件 **6/6**。
- Surface/Loader 的原 runtime 与 managed loader tests、UI 的
  `workbench-composition-host.test.ts`、`context-keys.owner.test.ts` 覆盖实际提交前
  挂载、context preview、watch 通知和停止。独立原失败探针与精确并发取消复核分别留证。
  独审另跑原 lifecycle **11/11** 与 authoring 三个定向例 **3/3**，确认第六项修复
  保留原 disable/shutdown、pin/callback/disposer 排空与明确候选拒绝语义。
- Host 生产/测试、browser、CLI、Surface/Loader/UI 类型和本片 lint 分别检查。
  本轮按相同组成命令执行，未声称再次运行 Web 顶层 aggregate。Host、Web bundle 和
  cloud runtime 使用本片构建产物；布局 **12/12**、生产边界 **7/7**。最后重新 stage
  并核 supervisor/registry/runtime 的 dist 与安装树 hash 一致。Web 沿已有 low-memory
  配置。Rust 生产未变，
  保留已验证的 wire 18 Linux x64 / `0.9.25` 二进制，只重新编译新增验收 fixture。
  既有 Rust warnings、bundle CSS/配置提示未被称为零。

本片未实际执行 package mutation 的 source-free child、完整 nested authoring 组合、
完整 RunAssembly/context、整个 Host 丢失时的外层重连、真实浏览器/设备/账号或产品
IPC。fixed/live 捕获分支的实现与当前 materialized 整链证据也不混为全来源已实跑。
显式 required Host+Surface readiness group 仍须作为后续合同实现，不能由“包带 UI”
推导出来；更广 Provider/Transform/共享 key/UI slot 组合与其余设计能力继续推进。
最终默认切换、Pi 删除和全面用户资产迁移仍交用户验收后负责。
