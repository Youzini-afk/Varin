# 原来源文件条件与真实观察生命周期

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`0a1ea4ec525462f6b3685df9ce894838abe68288`。
本切片接入一次文件 exists/changed/ready，与原 At/ProcessStopped 及 flat Any/All 共用发生项和续接链。本切片已完成源码整合、原生组件与独立反例验证；完整产品和跨平台验收边界另列。默认 runtime 与全面迁移仍交用户验收后负责。

## 原合同与实际 owner

普通 `follow_up` 版本 **3** 保留真实 ModelStep/PolicyAction 身份。User API 只能提交相对 path 与条件；私有 Host admission 按原 Run/Launch 来源发精确路径 `storage.read` grant，并在 finally 正常 retire。公共 HTTP/工具不能提交 grant、物理 root 或 actor。首次受理查有效读权限，重试沿原 Storage receipt/grant，不能借新 grant 续原权限；显式 revoke 在每次观察前仍拒绝，包括 paused 状态的短发现。

Catalog **35** 拒绝旧内部格式。原 definition 保存各文件叶的受理引用、baseline/current FileState、revision、durable watch position、gap/error/released；Storage 原 operations/operation_owners 保存来源与权限受理，ContentStore 仍独占指令正文。没有另建条件库、文件历史数据库或 scheduler。

fixed_branch 读取并 pin 精确不可变 revision，其 changed 合法但不受磁盘写入影响。materialized 只观察原 managed run root，不能换成 workspace 或后来 child WorkingResult。live_root 每次核原 Documents Host/root 和 Storage 路径授权。根不可用、权限拒绝、目标缺失分别保留。

watch 在基线之前 ready；每次 open 是独立 transient handle，同 root 复用原 watcher。并发同 key 的失败者只能关闭自己的 handle。读取正文/流式 hash 在原 Storage capture worker，Catalog 只短提交事实。消费 ACK 是已持久接受的位置，失败读取不能前移。取消先 fence 原身份，再等待真正 worker drain 和原 read lease/token/watch 释放。

- exists：实际 regular file、directory 或 symlink；missing/unsupported 不命中。
- changed：实际 FileState 差异，或从原持久位置以来连续的 exact-path 失效证据。重启/reset 明示 gap，不伪造离线 A→B→A。目录 entry 变化只唤醒子路径重读，不宣称所有子文件发生过变化。
- ready：regular file、原 Documents capture 稳定、真实受管 writer/Storage lease/process 已空闲；不宣称语义完成或全 OS 外部写者为空。没有 quiet-period timer。

原路径正忙或 capture 不稳定时可持久接受 `baseline_pending`，baseline/current 为 null，表示未知而非 missing。原 writer/lease release hint 唤醒同一定义；首次稳定读建立基线，不虚构 changed。快照稳定与 ready 的空闲条件分别核验：持续存在的 writer/maintenance 不单独抹掉稳定的 exists/changed 事实，真正 epoch/revision/watch 变化仍拒绝不稳定快照。两个只读观察不互相当写者，普通写入仍受实际 read lease 保护。

可选 tool Wait 与条件定义分开，取消观察不撤登记或杀进程。原 occurrence → typed input → Environment history → root/child activation 共用既有 owner；文件来源不会随交付目标换代。UI 只展示 Catalog 进度与错误，未知响应保原 key/Run/path/condition/instruction。

Storage 已接受、Catalog 尚未提交的 User 意图，通过原 Thread/branch 的 pending projection 可见。用户可用原 key/Run 明确取消未确定受理：只有真实原 acceptance 才能在 Catalog 原 commands 写取消 fence，prepare、accept 后和最终 admit 都核对；随后幂等释放原 observer/pin。未知 key 不能抢先取消未来意图。已存在 definition 只走原 control，不新增 precommit fence，已交付事实和同 key 重读保持。坏 receipt 显式报错，不当作没有待清理资源；损坏正文也不能阻碍已有定义的控制取消。该路径没有第二清理账本或按时间猜测弃置。

## 实际修正

组合验证发现并闭合了几条 owner 接缝：同 key watch 被失败者误关；两个 reader 相互阻塞且没有后续唤醒；暂停时跳过 revoke；busy 登记误拒绝常见“写完再继续”意图。真实工具装配还复现 Catalog MutexGuard 在返回表达式中活到 RegistrationGuard 析构，造成同锁重入；现在先完成短 admit scope 再析构，原两调用来源与 optional Wait 组合已复验。

固定来源显式撤权在原 Storage 权威提交后发送精确 receipt hint，即使没有物理 watcher 也能关闭原观察。损坏的无关 receipt 不能阻止撤权；提示不是授权成功或业务终态的第二权威。

Documents 原 watcher 增加 directory-entry invalidated，并同步接入 Document Registry 的 dirty/conflict、semantic inventory、LSP 已打开子文档和原 Pi writer tracker。该通知不携正文，不创建第二内容 owner。

恢复后 guardian 停止回执晚于首轮采样、且目标文件没有继续写入的窗口，沿原 ProcessManager/Storage 增加单个临时原 receipt 目录订阅。先订阅再重查，原子 rename 唤醒短 stop receipt 对账，不扫描 output spool。Linux 的原 identity/epoch/treeConfirmed 回执与既有 Windows 精确 named Job 消失证据保持区分，目录事件本身不是停止证据。逐条错误保留，独立健康 root 继续；原目标不再写、错误身份拒绝、正确旧 epoch 回执晚到与 watcher 释放的 Linux 用例已通过。

## 已执行证据与边界

Portable Host **7 files / 83 passed / 1 skipped**：Documents authority/watch、真实 fs.watch 文件 owner、取消桥接、服务 wake coalescing、User HTTP/client/grant、Pi writer tracker 和 LSP supervisor。UI **2 files / 75 passed**：ThreadConversation 原文件编辑/未知响应/进度，以及 Registry 目录失效与 dirty conflict。这里包含真实文件系统和明确的 RPC fixture，不拼接成完整 Host IPC 通过。

Host 完整测试类型、UI 类型、所有改动及新增 TS lint、生成协议检查与实际 Host bundle（531 reachable / 72 excluded）通过。新完整 Host materialized file 场景已补并类型检查：原基线、watch transient recovery、workspace decoy 与原物理源区分、原 input/Run 一次消费；本环境没有运行该 IPC 用例。

Runtime 最终完整套件 **405 passed / 0 failed / 2 ignored**（34 个 suite results）与 production rlib 构建通过。Kernel 最终完整 lib 套件 **109 passed / 0 failed / 11 ignored**、workspace all-targets 通过，14 条既有未改域 warnings 保留。准确 fresh executable 上显式执行原 ignored guardian/Storage **3/3**，覆盖 child 真停止/固定结果及原输出授权、stdin 原回执恢复，不把其余 ignored 算作通过。Windows/macOS OS 通知、完整产品安装和付费模型不在当前已执行证据中。

独审先按两设计形成合同，再核实际消费者；最终 **7 个 Catalog、5 组 Host、2 项 Linux receipt-wake** 外置探针通过。三项确认问题均独立闭合：active writer 误阻稳定 exists/changed、User orphan pin 无可管理弃置、fixed revoke 无物理 watcher 时缺唤醒。Catalog 弃置探针覆盖持久 fence/重开、跨 Thread/未知 key 不抢占、并发已有胜者只走原控制并可同 key 重读；Host 原失败探针保持原触发条件转绿。64 个冻结代码/测试/schema 文件及 production rlib 指纹在复核前后相同。本切片无剩余已确认行为阻断。

Linux x64 开发 executable identity `0.9.25`，target `x86_64-unknown-linux-gnu`，manifest/ELF staging SHA-256 **`aa56b2268e887bbdd067cf1f8963ec58df837fac88d823faca39e29421dff8ce`**。259 项构建输入在构建、stage、guardian 实测前后逐项相同。Linux 目录通知与真实进程已有上述分层证据；新 late-receipt 恢复用例使用原 ProcessManager 持久状态和实际原子回执文件，不冒称单独完成了旧 guardian 跨进程崩溃实验。macOS kqueue 与 Windows notification/event 后端目前仅锁定 API 静态核对，没有目标编译或实机执行。

## 可复跑入口

依[开发指南](../development.md)使用锁定工具链，在仓库根执行：

```bash
export RUSTUP_TOOLCHAIN=1.97.1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test followup_continuation -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib file_observation -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/documents/authority.test.ts \
  application-host/lib/documents/watch.test.ts application-host/lib/kernel/file-observation.test.ts \
  application-host/lib/kernel/file-observation-service.test.ts application-host/lib/kernel/thread-followups.test.ts \
  application-host/lib/recovery/pi-writer-tracker.test.ts application-host/lib/lsp/supervisor.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx \
  src/lib/documents/registry.test.ts)
```

准确同源码 executable 设置到 `VARIN_TEST_KERNEL_EXECUTABLE` 后，可显式执行原 ignored `actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results` 和 `followup_process_review` 两项。

具备原生 IPC 权限的环境可按 Web native test 入口执行 `process-wait-review.native.test.ts` 新文件条件场景，使用与源码一致的 `VARIN_TEST_KERNEL_PATH`。这里明确是后续验收入口，未被本地 fixture 或类型检查代替。
