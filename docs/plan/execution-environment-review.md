# 可组合执行环境：实施与验收记录

Status: in progress — 按 [execution-environment-design.md](../design/execution-environment-design.md) §11 顺序逐段交付。
基线：设计提交 `7e3baa14` 之上的当前 main。BC0–BC9 既有覆盖与原生证据缺口仍以
[bot-computer-use-review.md](bot-computer-use-review.md) 为准，本文件只记录执行环境新增交付。

## 交付批次

### 第一批：目标与职责（环境绑定，EE1）

Thread 获得耐久 `environment` 绑定 `{workTarget?, desktopId?, updatedAt}`：

- 存放于 Thread catalog（`thread-registry.ts`），子 Thread 默认继承父绑定，`thread.dispatch` 可显式覆盖。
- `environment.get` / `environment.set` Harness 方法（`context.session` / `control.thread`）。
  `set` 在写入前验证目标真实存在（受管执行目标经 `managedRemoteTargets.targetFor`，桌面经 computer 目录），
  返回 `handoff` 说明真实效果：此后受理的操作使用新位置，已受理操作保留其固定目标，不发生资源迁移。
- 消费方每次受理时解析一次并固定：`shell.exec` 的 `target`（显式参数 > 绑定 > 本机），
  computer 服务的 observe/act/apps/control/cancel/release/artifact 的 `desktopId`
  （显式参数 > 绑定 > 已配置默认）。`computer` REPL 沿用既有每求值快照，自动吃到绑定默认。
- Agent 入口：`computer` 工具 `action=environment`（get/set/clear），`bash` 工具 `target` 说明更新，
  `thread.dispatch` 新增 `environment` 参数。
- 会话无 Thread 绑定时：`get` 如实返回空，`set` 拒绝（绑定属于工作 Thread）。

验证：`environment-services.test.ts` 7 项聚焦测试（持久化重启重读、handoff 文案、逐调用固定、
显式覆盖、非法目标拒绝、null 清除、无绑定会话、dispatch 携带与继承）；
computer/thread 回归 116 项通过；protocol/pi-host/Host 类型与变更文件 lint 通过。
pi-host `computer-tools` 有 3 项与本改动无关的既有环境失败（bun `REPLServer` 不可用），干净 HEAD 同现。

未验证边界：远端真实 `targetFor` 联调未测；无 UI 消费面（后续批次）。

## 待交付

按 §11 顺序：环境接入与联动（文件传递/服务访问/应用打开/事件回源）、默认模板与持久、
常用应用整合（浏览器桥、办公桥）、诊断与经验。§13 选择随实现逐项收敛。
