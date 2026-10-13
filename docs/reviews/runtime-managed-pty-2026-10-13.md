# Managed PTY：原进程视图与恢复

基线 `41fe332f0ac7cf9eef6b4e044a03980235620bc2`。依据运行时设计 §9、§14、§22 和能力组合设计
§5.3、§9；本片接现有原进程消费者，不新增执行账本、B Run 或 shell supervisor。

## 所有权与调用链

- `ThreadProcesses.openTerminal` 从原 Catalog Run/Operation 和 launch source 验证身份。A 对 B
  仅准入 caller-retained `process_view`，冻结原 processId；B 的 Storage 再核验 principal、
  coordinator、来源、Run 与实际原进程。该 view 不能执行普通工具或 generic native service。
- `runtime.process.access` 的 managed 路径经原 private source bridge 到 B 的
  `source.process.access`；本地路径保持原 process interaction owner。Transport 使用现有
  managed Host 认证与 endpoint identity，不让 UI 传入的本地路径改写远端来源。
- NDJSON 仅转发原 native process stream；data/control credit 各自确认，读取 HTTP body
  不等于消费输出。输入和 resize 使用独立原 Operation 回执，未知结果不自动重发。
- 原 TerminalRuntime 的 A 侧 session 仍可保留投影供 UI 重新附着；UI 关闭只 detach。
  远端订阅关闭、A Host 退出或投影失效时，关闭订阅并释放确切 view authority，不停止原 job
  或删除 spool。显式终止仍走 A 原 Operation 的取消路径。自然退出保留原终态与输出完成语义。
- 原生订阅冻结 `replayCursor`。原 Terminal projection 区分历史和新字节；重放历史不向
  原进程重复发送 theme 查询回答，renderer 也不收到可触发重复自动输入的历史查询。
- UI tab 保存真实 resource owner、B cwd 与原 Thread/branch/operation/process identity；B
  localhost 不用 A 的 preview 探测。远端 source 不自动成为 A 的本地目录。
- 独立审查发现并修正两个正常恢复缺口：重试必须先重新准入原 job view，不能只重连已经
  失败的 A terminal session；B 重开后 view 使用当前 kernel epoch，但历史 process snapshot
  保留创建 epoch，旧输出可观察，Storage 仍拒绝旧 epoch 控制。

## 本轮实际证据

- `managed-process-stream.test.ts`：3 项通过，真实 consumer/helper 覆盖独立 credit、B
  地址输入、view close、错误身份断流、未知输入不重放；native port/网络 delivery 受控。
- `TerminalView.behavior.test.tsx` 与 `useTerminalStore.test.ts`：合计 25 项通过。包含原身份
  `openTerminal` 完成前不 attach、失败可重试、endpoint/tab/可见性变化的迟到隔离及 owned
  tab 恢复规则。另以无 A 目录的 remote-only 场景验证原 session 打开、重试、modal
  关闭/重开和关闭 tab，全程不新建本地 shell；沿既有 WorkspaceTerminalDialog 展示。React DOM 与 store 为真实实现；terminal API 和无关表现依赖受控。
- kernel `cargo check` 通过（保留既有 warnings）；同一源码工具链的 lib test 构建成功。
  协议生成检查通过：wire **29**。
- 三包 protocol → extension-contract → application-client 按各自原编译配置生成声明成功；
  TerminalStore 的 DOM 边界定点语义类型检查通过。Host 声明边界诊断发现并修正本片
  RequestInit 可选 signal 的类型问题。remote-only UI 的 nullable workspacePath 定点诊断也未发现
  参数传递错误；其完整类型图仍缺既有 UI 依赖。两者均不能称完整 Host/UI type-check 通过。
- `thread-processes.test.ts`、完整 source-service 恢复 fixture 尚未执行：真实依赖
  `ignore@7.0.12` 下载被拒，测试在收集前停止；没有换源、替代或以空测试计通过。
  已新增的历史查询重放和较广 UI helper/ThreadConversation 用例未计入上述通过数。

未运行全仓构建或全量测试。没有运行产品 HTTP listener、实际 A/B 网络、安装产品或物理
平台验证；按用户本轮调整，不继续安排实机验收。源码/受控端口证据不外推到这些边界。

## 相邻生命周期修复

独立审查发现的 managed package 首次释放失败与 B 重开持久 revision pin 遗留，沿原
Operation / Storage capture record 修复，见[独立报告](runtime-managed-package-lifecycle-audit-2026-10-13.md)。
这条恢复只清理原捕获，不重做编译或 stage。其测试与 PTY 证据分别记录。
