# Varin 开发

先读[架构](architecture.md)及最近的模块 README / DOCUMENTATION；[文档索引](README.md)负责领域导航。
代码、类型、schema、测试和 package.json 定义可执行行为，文档解释职责与非显然约束，Git 保存历史设计与交付过程。
Varin 原生对话由 Rust Agent runtime 执行；已启用的外部 Harness 保留自己的执行循环，
其绑定、派发和观察由同一 Catalog 管理，不伪造原生 Run，见[外部 Agent](external-agents.md)。

## 启动

源码开发使用 Node.js 24、根 package.json 固定的 Bun，以及 [rust-toolchain.toml](../kernel/rust-toolchain.toml)
选择的 Rust 工具链。包自身的 engine 声明决定安装产物最低版本。Rust 的 tree-sitter/Wasmtime 原生依赖还需要 C/C++
工具链与 CMake；平台 shell 和打包要求见对应包文档。

```sh
bun install --frozen-lockfile
bun run dev
```

`dev` 启动 Web UI 和可信 API 服务，并输出本地 URL。Electron 使用 `bun run electron:dev`，
已打包 UI 路径使用 `bun run electron:dev:bundled`。平台细节见 [Web](../packages/web/README.md)、
[Electron](../packages/electron/README.md)、[Mobile](../packages/mobile/README.md)。

## 修改与验证

先确定实际 owner、输入路径和消费者。Renderer 状态、Host 服务、Catalog、Storage、扩展配置及 Knowledge 各自有职责。
保留已有工作、有意义的失败状态和原始执行寿命，避免建立并行 writer。

| 改动 | 对应证据 |
| --- | --- |
| 文档和导航 | 本地链接与 public route 检查，并核对描述对应的代码 |
| 局部行为 | 相关行为测试；静态形状变化时补类型/lint 检查 |
| 共享协议、权限和持久化 | 真实消费者、实际读写、失败与幂等重放 |
| 进程、平台或打包 | 对应 native suite、目标产物和实机操作 |
| 性能 | 同来源/构建的代表性 workload、结果正确性和测量条件 |

围绕新增的失败类型扩展验证，不重复不能改变结论的大检查。测试应观察行为，不复制 DTO、枚举或源码字符串充当证明。
模拟 provider 只能证明请求接线；UI 测试、Host fixture、真实 Rust、安装包与物理多机分别证明不同层次。
通过、失败、跳过、未执行和环境阻塞应分别说明。真实环境场景见[运行时验收](runtime-acceptance.md)。

### 测试职责

先沿真实调用链确定契约，再选择一层证明；不要把同一断言复制到每个消费者。

| 契约 / 真实 owner | 主要证据与入口 | 不应由这一层代证 |
| --- | --- | --- |
| Thread 执行、Storage 耐久记录与权限 / Rust | `test:rust` 的状态机、真实存储、恢复及撤权测试 | TS 内存端口不证明 Rust 的落盘、GC 或恢复算法 |
| Host 受理、编排与 DTO / Application Host | `test:packages` 的路由与协调行为；端口替身只提供所需结果 | 重新实现已转交 Rust 的 writer 或状态机 |
| IPC、真实进程与 Host/native 接线 | `test:kernel`：Node transport + `*.native.test.ts`，Linux/Windows 各自验证 | portable mock 不证明实际停止、文件租约或跨进程持久化 |
| 客户端协议、授权与观察 / application-client | 包内真实请求/事件消费者测试；UI 只补用户操作与投影 | 测试自己构造的 DTO 或复制类型枚举 |
| 外壳、文档与渲染 / UI、extension-surface、Electron | 相应包的行为测试；平台专用生命周期走对应 desktop 入口 | CSS/源码字符串、退役渲染路径不能充当产品契约 |
| 已构建/安装产物 / 发布与平台 owner | `test:packages:dist`、Node smoke、cloud 原子部署及目标安装包 smoke | 源码测试不能替代真实导出、布局、启动与回滚 |

恢复的 first-before/last-after、外部修改缺口和 reopen 由 Rust `storage/recovery_journal.rs` 的真实写入测试负责；
Host→Rust 的恢复/undo 与响应丢失重启由 `recovery/kernel-durable-engine.native.test.ts` 负责。Host
`recovery/engine.test.ts` 接收这些 owner 提供的变更事实，验证 dirty buffer、冲突确认、取消、原 Thread 身份
与未知导航结果的协调，不在 fixture 中再实现 checkpoint、覆盖率或 GC 算法。

解析语法在对外 tokenizer 边界验证；高亮和编辑器层只补文本完整性、交互与动态配置更新，不重复枚举全部语法。
加密互操作使用实际客户端和 Host 两端，不在测试中重写握手；拒绝错误身份、篡改和重放仍属于必要契约。
依赖回归覆盖真实消费者和本地安全补丁，不为产品未使用的上游 API 预建兼容性套件。

共享 fixture 只负责准备输入、故障注入和资源回收。若测试结果完全由 fixture 自己算出，改为观察真实 owner，
或在已有 owner 回归足够时删除该重复证明；仍需保留 Host 对冲突、未知效果、权限及取消的独立处理。
CI 的 cloud 部署 smoke 通过 `--archive` 直接消费 VM guest 已生成并校验锁文件/布局的同一 archive；
故障注入只修改临时副本，不再重复 staging/解析锁。省略参数的本地入口仍会准备自己的 archive。
`bun run test:cloud-deploy` 在 Linux/Bash 下复用这一验收：先准备正式 build，再验证临时目录与 loopback 上的
安装、重复投递、保密配置拒绝、部署锁、链接提交失败和启动失败回滚。退出时关闭该 Host 并清理本次临时目录。
PR 与 main 的镜像验证由主 CI 按容器输入调用只读 reusable workflow；共享 builder 先验证 slim，
基础镜像/公共容器配置改动再验证 toolbelt。不会向 GHCR 发布，手动 `ci.yml` 也只是完整资格检查。
正式镜像发行由版本匹配的 release tag 进入 `Docker Images`；`Docker Commit Images` 则从 main 手动选择
精确 main 历史 SHA，独立发布 `commit-<完整 SHA>`，不占版本号、不触发 Desktop/npm/完整 Release。
两个通道在确切源码准入后，并行运行完整资格检查与候选镜像构建；只有完整资格与两种镜像 smoke 都成功，
才记录合格候选并推广同一 digest。发布工具与产品源码分开固定。构建用同一 BuildKit 分两阶段：先同时构建两种
基础镜像，再按实测 digest 同时组装 standard/toolbelt，共享 Rust/Web 编译，不把普通 CI 的宿主二进制借给容器。
发布的中间层缓存写入独立 `buildcache-v2` registry 引用，不占用 Actions 的 Rust/Bun 缓存空间；只读验证仅消费
这些公开缓存，不写入发布缓存。Cargo 依赖以普通镜像层保存，源码或版本身份变化仍会重新构建真实 kernel。
`container-check.yml` 提供独立手动入口，专项验证无需重复无关平台 CI；`ci.yml` 的 `container_benchmark` 仍可同时做完整资格检查。
基准会在临时 loopback registry 记录双架构冷构建、同 builder 热构建，
再删除 builder、建立全新 builder，并用一个只改 Rust 注释的本地 fixture commit 验证 registry 缓存恢复。
它要求依赖 cook 全部命中、最终内核重新编译、镜像报告新的 source identity；三组计时均留作 artifact，不发布产品镜像。
缓存命中只影响计算复用，不能代替资格、来源、产物身份或启动验证。
main push 与按提交发布均不更新 `latest`。新命名采用 `varin` 标准环境与 `varin-toolbelt` 工具链环境；
正式版本必须大于 0.9.38，独立 commit 标签允许源码版本仍为 0.9.38，旧精确版本/SHA 不重写。
推广前核验 companion base 与匿名访问；commit 通道额外执行新 runner 上的匿名 amd64 pull，并保存可核验
候选清单，失败时用原 digest 恢复而不重建覆盖。入口、版本隔离和恢复边界见[部署说明](ops/cloud-deployment.md#container-images)。

## 命令入口

最近的 package.json 是命令权威。以下是入口，不是每次改动必须全跑的清单。

| 用途 | 根命令 |
| --- | --- |
| 准备共享输出与 Host 声明 | `bun run build:type-dependencies` |
| 正式跨包类型检查 | `bun run type-check` |
| 已准备输出后的类型检查 | `bun run type-check:prepared` |
| 源码测试 / 已构建产物测试 | `bun run test:packages` / `bun run test:packages:dist` |
| 第二操作系统的文件/进程/外壳包（不含 native Host） | `bun run test:packages:platform` |
| Rust 编译检查 / release binary | `bun run kernel:check` / `bun run kernel:build` |
| Rust workspace 测试 | `bun run test:rust` |
| 已核验 release kernel 的 Host 验收 / 平台 owner 子集 | `bun run test:kernel` / `bun run test:kernel -- --platform` |
| Host 文件、凭据、锁与进程 owner | `bun run --cwd packages/web test:platform` |
| 工具、发布与平台配置行为 | `bun run test:tooling` |
| 共享浏览器产物 / 完整桌面包 | `bun run build:frontend` / `bun run electron:build` |
| 仅 Host 生产边界及 cloud layout helper | `bun run test:cloud` |
| 文档链接 / public route 与工程文档 | `bun run docs:check` / `bun run docs:validate` |
| 文档检查器本身 | `bun run test:docs` |

定向例子：在 `packages/web` 或 `packages/ui` 中运行 `bun run test 路径`；Rust 使用
`cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib FILTER --locked`。
新环境资源不足时可加 `-j1`，不能把编译被终止记成测试通过。
Node 测试包统一使用 `node --import tsx --test`，不额外启动 CLI 包装进程与 IPC listener；
可用 `node --import tsx --test packages/<包>/test/<文件>.test.ts` 定向运行。
原生 Host 定向验证用 `bun run test:kernel -- --vitest-file=application-host/lib/<文件>.native.test.ts`，
不会额外重跑 Node transport 全套。仅需要纯查询、排序或 mock owner 的验证应留在 portable suite；
需要真实 IPC、文件存储、进程树的验证才进入 native 入口。

`test:tooling` 是 CI 中轻量工具测试的统一入口，包含 Electron 打包与更新清单 helper；`test:cloud` 是其子集，无需顺序重复运行。
Electron 的运行时、更新策略与路径打开行为统一由包的 `test` 自动发现；Linux autostart 仅在 Linux 执行，
真实桌面发现仍使用 `test:linux-desktop`。不为同一种 runner 维护额外配置和手写测试文件清单。
### CI 责任与适用范围

普通 push/PR 由 `scripts/ci-scope.mjs` 按少数产品/owner 边界选择检查，不维护逐测试文件名单。
已知 renderer 改动运行一次 Linux types/lint/portable 行为与浏览器/外壳构建，不搭载整套 Rust、
Windows native 或双镜像。Host/共享协议/扩展改动保留 Linux 真 native；Catalog/Storage/schema
及 Rust 依赖改动继续在 PR 中阻断真实 Rust 升级、耐久、权限、取消和不重放契约。
公共文件、进程、IPC、凭据和原生依赖会触发相关平台，不只匹配带 win/mac 名称的文件。
Host `lib` 顶层公共 helper 同样属于平台接线，包括配置 watcher 的路径规范化、更新命令和退出协调。
根依赖/构建入口、未知路径或取不到 diff 都扩大到完整适用范围；重命名同时考虑旧、新 owner。

仅修改 Host/CLI portable `*.test.ts` 时保留类型、lint、portable 与所属平台验证，不重复构建生产产物或跑
kernel 验收；`*.native.test.ts`、`*.smoke.test.ts`、Node `kernel-client.test.ts` 及共享测试 helper/fixture
仍按原 owner 验证。`varin-runtime/tests` 顶层 `.rs` integration 测试保留 Linux native/Rust，不重复运行
未改变的生产装配、容器和平台 owner；嵌套 fixtures、其他 Rust 路径仍保守处理。混合改动累加各自要求。

Windows 用 `test:packages:platform`、Host `test:platform` 与 `test:kernel -- --platform`
验证文件/锁/CAS/路径/PTY/进程树/真实退出等 owner。Linux 的完整 native suite 保留所有业务接线；
Windows 的平台选择保留 live-shell destroy 等真实资源寿命回归，不按当前红绿挑测试。
macOS 验证文件/凭据/进程 owner 和真实 Swift Computer helper；涉及 Rust/workspace 时另做
FSKit 双架构编译、真实 storage 测试及 mount feature 编译。它不代证已安装系统组件的实际挂载或桌面授权。
Android native/toolchain 变更执行无签名 debug build，release 使用同一个 Android setup action。

手动 CI 和每日完整资格检查不依赖最近一次 diff，并保留完整 Windows portable 与 native 组合；
普通 PR 的 Windows/macOS 检查按文件、锁、凭据和进程等真实平台 owner 选择；Windows 完整资格检查继续兜底 owner 之间的覆盖空隙；
普通 push 不会取消这两种完整资格。发行调用固定候选 SHA，container caller 的实际镜像由它自己验证，
不递归调用 container check。定期红项有其 owner，未解决的真实平台故障不能用绿色局部检查代证。
真实设备、FSKit enablement、桌面权限与远端多机仍按[运行时验收](runtime-acceptance.md)单独说明。

`Source quality` 始终创建，严格汇总本轮适用的 source、preflight、native、平台、production、
container 和 Android 结果；失败、取消、缺失或意外 skip 都不能放行。轻量 production-lock
前置直接调用构建 owner 的 `--check-lock`，不再先重跑 layout fixture；失败阻止 production/image 重复构建，同时不遮蔽独立源码与 native owner 的结果。
Linux release kernel 一次构建，Host/native、Rust workspace 与 production 分别用现有回执核验输入/选项/摘要后消费；
Cargo release/debug 缓存分开；没有对应编译工作的任务不恢复 Rust 缓存。测试任务保留已成功编译的
缓存，Windows 在 native 验收前保存，避免真实断言/teardown 失败导致下一轮再次冷编译；缓存不是测试成功证据。
Host/native 接线与 Rust workspace 是独立并行作业，各自保留依赖准备、FUSE 和真实 kernel 前置，失败互不遮蔽。
同一 SHA 的重试可使用 GitHub 的失败作业重跑，保留已经通过的另一项；新提交仍按完整适用范围实际验证，
不复用其他 SHA 的测试结果。Rust 编译与执行分开，执行仍有原十分钟预算。
日常代码保留本地安全 patch 消费者回归；实时 Bun/Cargo advisory 查询由依赖改动、完整资格和发行承担。

失败归属跟随检查而不是另建重试流程：preflight 由生产依赖/锁文件 owner 修复；portable 由失败的
包/Host owner 修复；native 与平台 lane 由真实文件、进程或系统适配 owner 修复；production/container
由产物、启动或部署 owner 修复。测试正文完成而 destroy 未完成仍是资源寿命失败，不能按“业务已通过”忽略。
runner 磁盘/安装服务失败单独标记基础设施原因，先修复输入或缓存边界，不用整体延长 timeout 掩盖。
被新提交替代的普通 run 标为 cancelled，不冒充绿色证据；每日完整资格的红项也保留具体 owner 和 SHA。
发行必须通过自己的完整候选检查，不能借用另一个 SHA 的绿色结果或用局部 CI 覆盖已知平台故障。

Linux driver 的私有 D-Bus 协议测试使用
`dbus-run-session -- env VARIN_TEST_PRIVATE_BUS=1 /usr/bin/python3 -m unittest discover -s packages/computer-driver/linux -p 'test_*.py'`，
需要系统 `python3-gi` 与 `dbus`，不连接真实桌面或请求屏幕授权。
Windows Computer helper 的可移植目标匹配与回执测试使用
`cargo test --manifest-path kernel/Cargo.toml -p varin-computer-windows --locked`；Windows 同一入口额外运行
真实 helper/命名管道和内存 WIC 编解码测试，不操作私人应用或注入输入。
`bun run computer:build` 在 Windows 生成匹配架构的 EXE 和 manifest，Host 正式构建复用同一产物缓存。
实际桌面行为、阻塞 UIA、多屏 DPI、签名安装包与性能仍按[原生 helper 验收](design/native-computer-helper.md)分别记录。

## 输出和 native 边界

`build:runtime-dependencies` 按依赖图准备一次共享输出；`build:type-dependencies` 再生成 Host 声明。
根 build、Web build 和 type-check 复用这些有序输出。包级 `build` 保持独立可用；多数共享包的 `build:raw`
仅供已经准备依赖的有序聚合使用，但 Web 的 `build` 与 `build:raw` 都进入
`build-products.mjs web --publish`，会自行准备或核验依赖及产物，不能将名字当作跳过依赖的保证。
`type-check:prepared` 不重新构建。根 `build` 不再把 UI 的 `tsc --noEmit` 当作产物构建重复执行；
UI 类型由 source/type-check 门禁负责。发布前仍使用相应目标的正式命令。

生产构建由 `scripts/build-products.mjs` 统一准备，产物与可丢弃的构建回执在 `artifacts/build`。
复用同时核对源码、工具链/选项及现有产物的内容摘要，输出缺失、被改写或上次构建失败时重新生成。
Docker 等不含 Git 元数据的源码目录直接构建，返回真实产物摘要供后续阶段使用；缓存复用由外层构建负责。
跨工作区导出、导入构建回执仍使用 Git 工作区核对源码身份。
CLI 按所选 Host 产物的声明编译，清洁构建不依赖开发目录中的类型缓存。
浏览器产物与平台 Host、kernel、CLI 分开：移动端只消费浏览器；桌面消费浏览器、对应平台的 Host/kernel，
再收集独立的生产依赖目录；Web/cloud 将各部分组合。桌面构建不会覆盖正在运行的 Web server generation。
`bun run --cwd packages/web build` 仍将完成的 Web 产品发布到原有 `server`、`dist`、`kernel`、`bin` 路径。

发行流程先固定候选源码和 Android 构建号，共享浏览器和 Linux x64 kernel，再按真实依赖并行检查和打包。
只有 Linux x64 安装包等待其 VM guest；可选嵌入组件独立构建并按内容复用。最终汇总核验各产品的源码归属、
完整集合和文件摘要后才允许上传或发布；失败时重跑失败作业，保留已成功产品。
入口、产物布局和重试方式见 [Desktop 打包说明](../packages/electron/README.md#packaging)。

Host 类型由独立 Node 工程检查，Web/CLI/跨层测试通过 `#application-host` 读取新生成声明；Vitest 使用真实 Host 源码。
生产运行构建不把 `*.test-helper.ts` 与 `*.fixture.ts` 当成入口；独立声明缓存仍为跨层测试提供这些辅助模块的类型，测试工程检查其源码。声明生成前原地清理旧文件并保留目录，避免残留声明掩盖缺失模块，同时不重引 Windows watcher 的目录替换问题。
不要用旧 server/ 或旧声明验证新源码。Electron 的类型准备不需要覆盖正在运行的 server generation。

私有 wire 改动后运行 `bun run kernel:protocol`，生成检查使用同一脚本的 `--check`。正常 kernel build 生成与当前
schema 匹配的 executable 和 manifest。手工改生成文件、运行旧 binary 或只通过 TypeScript 都不能证明 native 接线。

`*.native.test.ts` 由专用 kernel 入口运行，portable Web suite 不运行它们。`test:kernel` 消费已核验的 release binary；
需要重建时显式传 `--build`。构建、binary 与协议前置检查失败时立即停止；前置检查通过后，
Node transport 与 Vitest native suite 各自报告结果，任一失败仍返回非零，不用前一组的断言失败遮蔽后一组。
`test:rust` 本身不构建这份 release binary；涉及 Host/guardian 的测试还需要 Node/tsx、
相应 Host/builtin 输出和指向匹配 executable 的 `VARIN_TEST_KERNEL_EXECUTABLE`。

`test:rust` 使用 Cargo 默认选择，不执行标记 `#[ignore]` 的场景；`test:kernel` 只运行 Node transport 和
Vitest native suites，不会补跑这些 Rust 场景。需要某项 ignored 回归时，先核对其当前 owner、fixture 与前置产物，
再用上述 Cargo 定向命令追加 `-- --ignored`。旧 fixture 指向已删除入口时属于未验证缺口，不应恢复退役 runtime
来让测试通过，也不能把默认 suite 成功当成该场景已验证。

`test:dist` 消费已构建产物，应先构建所属包。完整打包、签名、实际桌面/移动端操作和真实 provider 账号验证各有入口，
不从 helper 或源码测试推导已通过发行验收。

## 依赖与提交

`bun.lock` 管开发依赖图，`scripts/cloud-runtime.bun.lock` 管 staged production 图。影响生产依赖时，在对应输出准备后
运行 `bun run update:cloud-runtime-lock` 并核对真实差异。具体维护见[依赖说明](ops/dependency-updates.md)。

修改前检查 Git 状态，保留无关用户改动。将有完整证据的阶段提交并在获准后推送，确认远端实际 SHA；没有运行的验证不作
成功声明。发行、部署和凭据变更继续遵守该操作的授权边界。
