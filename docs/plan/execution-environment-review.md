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

### 第二批：跨环境联动（open + 文件写入，EE2）

跨环境"应用打开"与"一次性文件传递"成为正式能力，全部沿既有桌面所有权：

- 驱动词汇新增 `open` op：Linux `xdg-open`/`Popen`（detached）、Windows `Start-Process -PassThru`、
  macOS `NSTask`/`/usr/bin/open`（均不等待被启动应用退出；返回 `pid`）。
- `computer.open` 服务：恰好一个 url/path/command 目标；`javascript:`/`data:`/`vbscript:` 等
  执行型 scheme 拒绝；人工控制中拒绝（与 `act` 同一归属门）；远端转发把 URL/路径原样送达
  目标 Host —— `localhost` 与文件路径在**目标机**解析，绝不改写到协调端。传输丢失返回
  `outcome: unknown`（open 可能已过线，绝不重放）；代际/归属门槛与 act 一致。
- `computer.fileWrite`：一次性写文件到受管桌面用户 home，原子 temp+rename，
  返回存储修订 `{sha256, byteLength, modifiedAt}`；远端经认证 HTTP 转发；
  本地仅 `linux-xvnc` 受管桌面（非受管如实 unavailable）；符号链接逃逸经
  "最深存在祖先解析"封堵；`..`/绝对路径/反斜杠拒绝。单次复制 ≠ 持续同步。
- 路由：`POST …/desktops/:id/open`、`POST …/desktops/:id/artifacts/write`
  （Host↔Host 同一组端点）；Harness 方法 `computer.open`/`computer.fileWrite`
  走绑定解析（显式 > 绑定 > 默认）；
  `computer` 工具 `action=open`/`action=put` + REPL `open()`。

验证：computer-service 50 项（新增 7：pid 回传、目标互斥、scheme 拒绝、人工控制拒绝、
远端原样转发 localhost、传输 unknown、远端/本地写入路径）、computer-routes 21 项
（新增 3：open 转发/错误映射、write 转发）；
artifact.py 本机真实往返：write→info→read 字节与 sha256 一致，`..`/绝对路径拒绝；
Windows/macOS 驱动语法零错误，Linux runtime/artifact `py_compile` 通过；
protocol/pi-host/web 类型与变更文件 ESLint 全绿。

未验证边界：Linux/macOS `open` op 仅语法级（无对应桌面真机）；
Host↔Host open/write 为假 fetch 聚焦测试，非真实双机联调；
`mklink` 符号链接逃逸用例在 Windows 开发机无特权构造，路径封堵靠代码审查
（Linux 目标平台上 `resolve()` 语义成立）；文件写入尚无版本前置条件
（`--sha256` 仅 read 支持），并发覆盖靠原子 rename 保证最后写入者可见。

## 待交付

按 §11 顺序：环境接入与联动剩余项（服务访问/事件回源）、默认模板与持久、
常用应用整合（浏览器桥、办公桥）、诊断与经验。§13 选择随实现逐项收敛。
