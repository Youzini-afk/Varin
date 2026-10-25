# Varin 开发

先读[架构](architecture.md)及最近的模块 README / DOCUMENTATION；[文档索引](README.md)负责领域导航。
代码、类型、schema、测试和 package.json 定义可执行行为，文档解释职责与非显然约束，Git 保存历史设计与交付过程。
当前对话执行只有原生 Rust Agent runtime。

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

共享 fixture 只负责准备输入、故障注入和资源回收。若测试结果完全由 fixture 自己算出，改为观察真实 owner，
或在已有 owner 回归足够时删除该重复证明；仍需保留 Host 对冲突、未知效果、权限及取消的独立处理。
CI 的 cloud 部署 smoke 直接消费本轮生成并校验锁文件/布局的 archive，不另造一份无人消费的 staging 输出。
`bun run test:cloud-deploy` 在 Linux/Bash 下复用这一验收：先准备正式 build，再验证临时目录与 loopback 上的
安装、重复投递、保密配置拒绝、部署锁、链接提交失败和启动失败回滚。退出时关闭该 Host 并清理本次临时目录。
PR 中的 Docker workflow 验证实际镜像的构建、启动、身份和 native handshake；cloud helper 单元测试由主 CI
的 `test:tooling` 统一拥有，不再为 PR 单独安装一次整个 workspace。能够发布候选镜像的非 PR 运行仍保留
直接 helper 门禁，不能将另一个 workflow 的成功当作它的发布依赖。

## 命令入口

最近的 package.json 是命令权威。以下是入口，不是每次改动必须全跑的清单。

| 用途 | 根命令 |
| --- | --- |
| 准备共享输出与 Host 声明 | `bun run build:type-dependencies` |
| 正式跨包类型检查 | `bun run type-check` |
| 已准备输出后的类型检查 | `bun run type-check:prepared` |
| 源码测试 / 已构建产物测试 | `bun run test:packages` / `bun run test:packages:dist` |
| Rust 编译检查 / release binary | `bun run kernel:check` / `bun run kernel:build` |
| Rust workspace 测试 | `bun run test:rust` |
| 已核验 release kernel 的 Host 验收 | `bun run test:kernel` |
| 工具、发布与平台配置行为 | `bun run test:tooling` |
| 仅 Host 生产边界及 cloud layout helper | `bun run test:cloud` |
| 文档链接 / public route 与工程文档 | `bun run docs:check` / `bun run docs:validate` |
| 文档检查器本身 | `bun run test:docs` |

定向例子：在 `packages/web` 或 `packages/ui` 中运行 `bun run test 路径`；Rust 使用
`cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib FILTER --locked`。
新环境资源不足时可加 `-j1`，不能把编译被终止记成测试通过。
Node 测试包可用 `node --import tsx --test packages/<包>/test/<文件>.test.ts` 定向运行。
原生 Host 定向验证用 `bun run test:kernel -- --vitest-file=application-host/lib/<文件>.native.test.ts`，
不会额外重跑 Node transport 全套。仅需要纯查询、排序或 mock owner 的验证应留在 portable suite；
需要真实 IPC、文件存储、进程树的验证才进入 native 入口。

`test:tooling` 是 CI 中轻量工具测试的统一入口；`test:cloud` 是其子集，无需顺序重复运行。
CI 的手动运行会对所选 ref 执行完整 code/Rust 检查，不依赖最近一次提交的差异；普通 push/PR
仍按改动范围选择检查。不依赖 native executable 的包测试和 tooling 在原生构建前执行一次；只有 Host 包的 Documents fixture
仍需原生目录观察器。各组按依赖安装/类型输出准备的真实结果启动，任一独立检查失败不会遮蔽其他组，
也不把失败改成成功。原生构建成功后，即使 Host 验收失败，也继续收集独立的 Rust 和 Host 包测试结果，
任何失败仍使 CI 失败。Rust 测试编译与执行分开，执行超过十分钟会明确失败，保留日志供排查。
Linux driver 的私有 D-Bus 协议测试使用
`dbus-run-session -- env VARIN_TEST_PRIVATE_BUS=1 /usr/bin/python3 -m unittest discover -s packages/computer-driver/linux -p 'test_*.py'`，
需要系统 `python3-gi` 与 `dbus`，不连接真实桌面或请求屏幕授权。
Windows 的无桌面 input targeting 回归由 `packages/computer-driver/windows/test-targeting.ps1` 执行。

## 输出和 native 边界

`build:runtime-dependencies` 按依赖图准备一次共享输出；`build:type-dependencies` 再生成 Host 声明。
根 build、Web build 和 type-check 复用这些有序输出。包级 `build` 保持独立可用；`build:raw` 仅供已经准备依赖的
有序聚合使用。`type-check:prepared` 不重新构建。发布前仍使用相应目标的正式命令。

Host 类型由独立 Node 工程检查，Web/CLI/跨层测试通过 `#application-host` 读取新生成声明；Vitest 使用真实 Host 源码。
不要用旧 server/ 或旧声明验证新源码。Electron 的类型准备不需要覆盖正在运行的 server generation。

私有 wire 改动后运行 `bun run kernel:protocol`，生成检查使用同一脚本的 `--check`。正常 kernel build 生成与当前
schema 匹配的 executable 和 manifest。手工改生成文件、运行旧 binary 或只通过 TypeScript 都不能证明 native 接线。

`*.native.test.ts` 由专用 kernel 入口运行，portable Web suite 不运行它们。`test:kernel` 消费已核验的 release binary；
需要重建时显式传 `--build`。`test:rust` 本身不构建这份 release binary；涉及 Host/guardian 的测试还需要 Node/tsx、
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
