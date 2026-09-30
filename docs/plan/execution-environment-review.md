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

### 第三批：服务访问与事件回源（EE3a/EE3b）

EE3a——跨环境"服务访问"落成正式能力，沿既有 Host↔Host 通道，没有新增生命周期概念：

- 协议：`environment.forward / forward.list / forward.close`（harness-forwards），
  返回 forwardId 与实际监听地址；协调端 `localhost:PORT` 即目标机服务，
  调用方拿到的永远是本机回环地址，远端 `localhost` 不再被误递给本地浏览器。
- 传输：协调端 `environment-forwards.ts` 开本地 TCP 监听，按连接经认证
  WebSocket 升级到目标 Host；目标侧 `environment-forward-server.ts` 校验
  Bearer（`ensureSessionToken`）、Origin 与升级回执中的 Host 身份
  （`X-Varin-Host`），把字节桥到目标机解析的地址。本地目标走同一入口的
  进程内直连（无环回 WS）。
- 语义：forward 与 Thread/调用方绑定并随 disarm/会话收尾关闭；升级回执
  Host 身份不符即拒绝桥接；`list`/`close` 如实反映协调端在管转发。
- Pi 工具：`computer` `action=forward|forwardList|forwardClose`，可选端口收窄；
  转发结果经 `unknown` 安全收窄进 detail。

EE3b——"事件回源"复用持久 follow-up 体系（拒绝另立事件台账）：

- 新 `desktop` 叶源（协议 + 内核 `source_kinds` + 组合子校验均扩展）：
  `condition: "status"` 观察桌面 catalog 状态（含远端镜像，随最后一次
  可达同步的真实新鲜度），`states` 必填；`condition: "artifact"` 观察受管
  桌面 home 文件——`path` 必填（拒绝绝对/逃逸/反斜杠），可绑 `sha256`
  基线，`exists`/`changed` 复用既有 file 语义（出现即触发；修订不同于
  基线即触发）。
- 观察走 ComputerService（`observeDesktop` → catalog `list()`，远端桌面即
  其镜像状态；`inspectDesktopArtifact` → EE2 的受管 artifact 读取），不越层
  直读驱动/文件系统；依赖缺失如实 `unavailable`。
- 轮询 2s 独立 timer map——不与 time/deadline 共用 `timers`（修掉
  `fallbackAt` 覆盖 poll tick 的死轮询缺陷）；基线（上次状态/sha）随
  `fire()` 的 `sourceStatePatch` 与 occurrence **同一事务**写入——修掉
  "先提 revision 再 fire 被守卫拒"与"fire 后补基线被 state 门挡、重启后
  同修订重复投递"两个缺陷。
- 事件固定回原 `workspace/session/thread`：触发即 `fire()` →
  `deliverRecordedOccurrence`，settled Thread 续行、活跃会话 inform、
  queued 排队，全部既有投递语义；`followup.check` 返回观察事实
  （status/baselineSha256/observedAt 或 `observed:"unavailable"`）。
- Pi `followup` 工具：desktop 源 schema、摘要渲染与说明同步更新；
  校验先行（空 desktopId / 缺 states / 逃逸 path / 非 sha256 一律拒绝，
  不武装死等）。

验证：followups 真核套件 49/51——5 个新 desktop 用例全过（状态迁移触发、
null 状态不臆造、artifact 到达即触发且 sha256 入事实、基线 sha 等修订、
非法源拒绝）；2 个失败为 `vi.advanceTimersByTimeAsync` 在 bun 下不存在的
既有环境失败（干净 HEAD 同现，非本次引入）。environment-forwards 3 项
（真实 TCP 字节贯通、Host 身份不符拒绝、目标端鉴权）+ environment-services
10 项 vitest 全过；内核 release 二进制已按新校验重建；
protocol/pi-host/application-host 类型与变更文件 ESLint 全绿。

未验证边界：端到端"桌面真实变化 → Bot Thread 续行"未在真机跑通
（poll 路径为聚焦测试）；forward 字节桥为单机真实 TCP 自环，跨机联调未测；
远端桌面状态的新鲜度受镜像同步节流约束（文档已声明），桌面原生推流
（替代轮询）留待后续。

### 第四批：默认组件配方与安装入口（EE4，§6.2/6.3）

- `linux/components.json`：声明式组件配方（desktop/dev/docs 三组），
  对应 §6.2 默认组合；图像视频与工程游戏软件按合同不在配方内，
  仍可经显式 `packages` 逐任务安装。
- `linux/install-components.py`：目标机本地安装器——manifest 组校验、
  包名注入校验、`sudo -n` apt 执行、逐组件真实结果（installed/failed+detail），
  结果原子落 `<data-dir>/software.status.json`；无 apt 环境如实报错。
- `linuxDesktop.install`：命令经注入 exec 通道执行，串行化单条 apt 流水线，
  参数白名单先行，脚本无结果如实 unavailable。
- `computer.installSoftware`：绑定解析同 observe/act（显式 > 绑定 > 默认）；
  远端目标经认证 HTTP 转发到拥有 Host 自身执行；本地仅 `linux-xvnc` 受管
  环境（其他桌面如实 unavailable，各管各的软件栈）。结果按组件并入桌面
  记录 `software` 字段——installed/failed 状态与 `status`/`capabilities`
  严格分开，catalog 重写时保留（与 usage/work 同一保护）。
- 路由 `POST …/desktops/:id/software`（Host↔Host 同端点）、Harness 方法
  `computer.installSoftware`（control.computer 权限）、Pi 工具 `action=install`。
- VM 通用模板：`guest-init.sh` 在桌面准备后预装 dev+docs（`|| true`——apt 级
  失败已记入 software.status.json，阻断云初始化不应因可选组失败而宣告
  整机失败）；运行时升级仍走既有 guest-upgrade.sh，机器删除/磁盘删除
  已由 `deleteVm(deleteDisks)` 分开。

验证：computer-service 54/54（新增 4：组安装并入记录、失败状态可见、
远端转发、非受管/空参拒绝）；computer-routes 22/22（新增 1）；
install-components.py 真机执行验证校验路径（未知组/注入包名拒绝、
无 apt 如实报错）；`py_compile`/`sh -n` 通过；类型/ESLint 全绿。

未验证边界：真实 Linux 环境的 apt 安装未跑（开发机无 apt）；包名清单
对 Debian 13 的解析正确性待首个真实 guest 验证；guest-init 的 dev/docs
预装路径同样未在真实 cloud-init 下执行；`software` 字段暂无 UI 消费面。

### 第五批：浏览器桥——同一真实现场（EE5a，§7.2，§13 收敛）

§13"默认浏览器和连接协议"收敛：**Chromium + CDP**。选型依据：CDP 附着是
唯一能把 Agent 操作绑定到人工可见的同一持久会话的协议路径；Playwright
的 `connectOverCDP` 复用同一协议但其 Python wheel 需联网获取且对纯 CDP
附着为过重依赖，故桥体以 Python 标准库直接实现 RFC6455/CDP 客户端，
零新增依赖；firefox-esr 保留为用户默认浏览器（Debian 基线），chromium
加入配方承担可控浏览器角色。

- `browser_bridge.py`：stdlib CDP 桥（_CdpSocket 手写握手/帧掩码/请求关联）。
  ops：`status`（/json/version 探活）、`launch`（chromium
  `--remote-debugging-port` + 托管 `--user-data-dir`——登录态/标签页随
  profile 持久，§6.3）、`tabs`、`snapshot`（Accessibility.getFullAXTree
  扁平化）、`act`（navigate/evaluate/click 视口坐标/type/screenshot）。
  所有异常收敛为 `{ok:false}`——驱动协议不允许裸异常。
- `runtime.py` `tool:"browser"` 分发到桥——**同一 lane**：串行化、取消
  检查点、agent-vs-human 控制门全部继承；写 op（launch/act）与 `open`/`act`
  同一 forbidden 门，读 op（status/tabs/snapshot）走 observe lane，
  人工持有期间仍可观（读≠输入）。
- `computer.browser`：显式 > 绑定 > 默认解析；远端经认证 HTTP 转发到
  拥有 Host 自身执行；传输丢失如实 `outcome:"unknown"`（op 可能已过线，
  绝不重放——先查页面状态再决定）。路由 `POST …/desktops/:id/browser`、
  Harness `computer.browser`（control.computer）、Pi `action=browser`
  （browserOp/browserAct）。

验证：computer-service 57/57（新增 3：driver 分发同 lane、人工控制写门/
读通行、远端转发+传输 unknown）；`test_browser_bridge.py` 对假 CDP 端点
全过——真实验证 HTTP/WS 握手、帧掩码、命令/响应关联、tabs/snapshot/
navigate/evaluate/click/缺参拒/未知 tab 拒；类型/ESLint/py_compile 全绿。

未验证边界：真实 Chromium 会话未跑过（假服务器验证协议层，不证明
Chromium 行为）；Page.navigate 返回即发不代表加载完成（事实边界，
等待语义由 followup/观察承担）；AX 树扁平化为行文本，元素↔视口坐标
映射尚未提供（click 仍需坐标来源）；Windows/macOS 桌面暂无桥
（managed linux only，与驱动同一边界）。

### 第五批补：LibreOffice 桥——同一实例与未保存状态（EE5b，§7.2，§13 收敛）

§13"LibreOffice/办公桥"收敛：**python3-uno + UNO socket attach**。
soffice 以 `--accept=socket,host=127.0.0.1,port=2002;urp;` 常驻单实例
（其 profile 单例语义使后续人工打开的文件仍进入同一进程与 accept
socket）；若用户已自行运行无 accept 的实例，桥如实不可连接，不另起
隐藏 profile 冒充同一现场。

- `office_bridge.py`：UNO 桥，ops `status`（连接探活+文档枚举）、
  `launch`（带 accept 启动+30s 等待）、`docs`（title/kind/url/
  **modified**——未保存状态是协议字段而非推断）、`open`
  （loadComponentFromURL 进同一实例，文件在人工视野内可见）、
  `act`：read/write（Sheet 单元格范围，write 强制 values 形状与
  range 完全匹配）、insert（Writer 文末插入）、save（无位置文档如实
  拒绝而非静默另存）。uno 缺失（python3-uno 未装）→诚实
  `{ok:false}`。python3-uno 已入 docs 配方组。
- `runtime.py` `tool:"office"` 分发到同一 lane；`computer.office`
  服务方法/status·docs 走 observe lane、launch·open·act 与人工控制门
  互斥；远端认证转发+传输丢失 `outcome:"unknown"`；路由
  `POST …/office`、Harness `computer.office`、Pi `action=office`。

验证：79/79 service+routes 测试全绿；`office_bridge` 无 uno 环境下
状态诚实（status→not running、其余→unavailable 而非异常）；
类型/ESLint/py_compile 全绿。

未验证边界：真实 LibreOffice 会话未跑过——UNO 服务名/接口语义来自
官方组件模型但未经原生实例验证（Calc/Writer/Presentation 分支、
modified 标志、shape 校验行为）；Windows/macOS 无桥。

## 待交付

按 §11 顺序：环境接入与联动剩余项（服务访问/事件回源）、默认模板与持久、
常用应用整合（浏览器桥、办公桥）、诊断与经验。§13 选择随实现逐项收敛。
