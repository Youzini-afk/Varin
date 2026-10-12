# 固定工程语言视图与真实子任务消费

基线：`aef21780c2ef9cc3bb3c7952fab7f72b64f7dc7b`。实现已冻结，真实组合复验和
独立审查通过，本片无剩余已知行为阻断。Catalog **58** 不变，私有 kernel wire **16**。
本片完成对应固定来源的工程视图，不表示两份设计、所有 provider 或产品平台验收完成。

## 权威与生命周期

- 原 `LaunchSource` 始终是 `fixed_branch`，`physicalRoot` 仍为 null。原 branch/revision
  是输入、逐目标正文与历史的唯一来源；语言服务只获得从该树派生的物理工程。
- 原 Storage 的 `file.materializedView.prepare/check/release` 复用物化 worker、journal、
  目录身份、文件 lease 和进程 writer barrier。Storage 只保存物理资源，不复制 Run 引用。
  树复制和递归删除都在 worker 中，控制 owner 只准备和提交短事实。
- 原 supervisor 独占共享准备与 Run/grant 引用。相同工程/来源/配置共用服务，不同固定
  revision 分开。单次查询取消不撤 Run 引用；最后引用退出先等实际进程停止，再释放
  该派生工程的 process context 和目录。未知 writer 保留资源与可重试的失败事实。
- Host 私有 service context 只供派生资源准备/清理，不交给 Run。原 Run 的来源、注册、
  当前 grant 与完整工程读取范围仍须准入；只准某文件的 grant 不隐式获得依赖树。
  普通单文件读取保留原有限路径合同。语言后端本身不要求给 Run 增加 process 工具。
- `source.derivedView` 单独记录物理视图的身份、固定 root 和世代，不冒充新的 source。
  `dependencies` 分为 `source: fixed_branch | live` 与 `external: provider_environment`。
  捕获树内的 imports、相对配置和路径映射取固定来源；目录外 SDK、compiler libraries、
  显式外部配置和 symlink 不因此成为完整 OS 快照，也不新增任意外部依赖禁令。
- 派生目录失效后本次查询报 stale/unavailable，原 owner 排空旧服务；下一次实际查询
  才准备新世代，不回退 live，不在后台偷偷重建，也不逐查询扫描/hash 整棵树。

## 当前实际组合证据

主测试用原 Rust Catalog、Storage、RunSupervisor、工具执行和 LanguageBridge，经原 Host
SourceQueryOwner、supervisor 与 KernelProcessService，实际启动已捆绑 TypeScript。
测试传输采用 stdin/stdout rendezvous，模型选择受控；文件、语言结果、原进程管道、
回执、历史和存储重开均使用实际 owner。

| 场景 | 实际检查 |
| --- | --- |
| 固定 revision 0 与不同 live 工程 | 第一次查询前 live 的 import、tsconfig extends/paths 已不同；查询间再改 live。真实跨文件 definition/reference 和诊断仍来自固定工程 |
| 共享与隔离 | 两个保留引用的 Run 共用 revision 0 的真实 view/process；原 branch writer 提交 revision 1 后另起视图，旧 revision 的文件不被覆盖 |
| 回收与重开 | 原 grant 撤回、精确 source drain 后各自目录消失；另一 revision 不受影响。GC、关闭 Catalog/Storage/Node Host 后重新查询 revision 0，原历史与语义保留 |
| 实际只读 child | 原默认 Retrieval 目录/dispatch/handoff，独立 source branch、Run/grant，实际 TypeScript 五次工具调用，原子任务报告与历史、停止和 GC 后重开 |
| 实际 Worker child | 原默认 Worker 的物化来源、真实语言调用、报告和退出 writer barrier。未执行整段 Host code-result settlement，仍保留其实际 pending/settling 状态，未伪造 Published |
| 原物化主链 | working-copy imports/config、实际修改依赖、watch 失效与引用退出保持；撤权 ACK 的 writerStopped=false，精确 drain 后 true |

最终 wire 16 二进制下，上述三条真实链串行通过，合计 25.21 秒。这是单次场景的
执行记录，不是性能 SLO。另一个真实 Rust Storage 场景确认：同一窄路径 grant 的
固定文件读取成功，而语言查询在派发前以 Authorization 拒绝，且没有派生目录记录。

独立审查先按设计形成验收合同，再核对实现与实际消费者；额外原 supervisor 探针确认
A 在共享准备期间撤权后 B 仍完成同一次准备，最后一次引用精确释放一次。
人为以同一 OS 权限篡改私有目录不纳入产品缺陷或额外沙箱要求。

其他本片证据：Storage 派生视图三场景、原 child 目录六场景、语言 bridge 四场景通过；
Host owner/bridge/supervisor/continuation 四文件 53 项，原来源与检索共享消费者三文件
9 项通过。Host 类型与构建、CLI source/tests 类型检查、wire 生成核验通过；cloud runtime
同源打包通过，所含 kernel SHA-256 为
`d83e66cfa8cd9244771a2ca5d20a950d71ebc86ea31aa4a5a435e22d47ecba4e`。
cloud layout 的原 Vitest 入口 12 项及生产边界 Node 入口 7 项通过。首次误用 Node test
启动 cloud layout 时未进入其 Vitest suite，随后按原 package.json 入口复跑，不算产品失败。

冷 TypeScript definition 可以真实返回本文件的 import alias，保留其原历史；后续跨文件
检查按实际发布完成后进行。diagnostics 的测试 gate 等该 view 的真实 publication，
不证明普通冷调用自动等待或时延。捆绑 TS 的 unversioned push 仍为 pending，
真实 items 可见但不能升级成 verified clean。主共享场景刻意保留首批 Run 引用，
不保证普通已完成顺序 Run 必然保持同一进程。

重开测试的传输 epoch 字符串恒定，证明实际关闭重开及新查询；旧 epoch 回收由独立
Storage 场景证明。后者注入原 process 记录和确切 stop 事实，不能冒称新的 OS guardian
恢复试验。真实进程证据来自上述主/child 组合链。

## 四个旧 continuation fixture 的归因

`a000fa18` 把恢复来源迁到原 branch-grant adapter/store，同时删除测试旧
`workingStates.withBranchStore` 注入，却没补新 Documents/Storage 端口。
user_continuation、message_request、followup、calendar 四种 startup 的首错都是
缺少 `documents.admitWorkspaceRegistration`；fake `failChild` 又抛另一错误掩盖它。
错误发生在 prepareChild 前，与上一片新增语言 settlement 等待无关。

本片只修测试接线，复用真实 KernelStorageAdapter 与 KernelWorkingStateRootStore，
控制底层 kernel 端口。单文件 11 项通过；确认旧固定 revision 7 不变成当前 head 8、
来源/provenance、两次注册准入、storage-only grant、query pin 的释放、calendar hold/retry
及显式 User skill 权限。source-free 不签来源 grant，原 settlement 取消用例保留。
没有恢复已删除生产 owner，未发现上一语言片引入生产 startup 回归。

## 复跑入口与剩余边界

先按[开发说明](../development.md)构建 wire 16 kernel，
`VARIN_TEST_KERNEL_EXECUTABLE` 指向该二进制，然后：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  language_source_review -- --ignored --nocapture --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  storage::materialized_views::tests
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  narrow_source_grant_reads_fixed_input_but_rejects_language_before_host_preparation
```

Host 原 portable 入口包括 language-owner、language-bridge、lsp/supervisor 与
child-continuation-host；命令以对应 package.json 为准。产品 socket/UnixIPC 本轮未跑。

远端一致 SourceView、所有语言 provider/平台、真实大型项目性能、完整产品 IPC，以及
其余 runtime/extension 设计能力仍分别保留。默认切换、Pi 删除和全面迁移由用户验收后负责。
