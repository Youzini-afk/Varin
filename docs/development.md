# Varin 开发

先读[架构](architecture.md)及最近的模块 README / DOCUMENTATION；[文档索引](README.md)负责领域导航。
代码、类型、schema、测试和 package.json 定义可执行行为，文档解释职责与非显然约束，Git 保存历史设计与交付过程。
Varin 原生对话由 Rust Agent runtime 执行；已启用的外部 Harness 保留自己的执行循环，
其绑定、派发和观察由同一 Catalog 管理，不伪造原生 Run，见[外部 Agent](external-agents.md)。

## 启动

源码开发使用 [.nvmrc](../.nvmrc) 选择的 Node.js、[根 package.json](../package.json) 固定的 Bun，以及 [rust-toolchain.toml](../kernel/rust-toolchain.toml)
选择的 Rust 工具链。包自身的 engine 声明决定安装产物最低版本。Rust 的 tree-sitter/Wasmtime 原生依赖还需要 C/C++
工具链与 CMake；平台 shell 和打包要求见对应包文档。

```sh
bun install --frozen-lockfile
bun run dev
```

`dev` 启动 Web UI 和可信 API 服务，并输出本地 URL。Electron 使用 `bun run electron:dev`，
已打包 UI 路径使用 `bun run electron:dev:bundled`。平台细节见 [Web](../packages/web/README.md)、
[Electron](../packages/electron/README.md)、[Mobile](../packages/mobile/README.md)。

`dev` / `dev:web:hmr` 在启动 Vite 与 API 前先完成共享 runtime 包准备，复用现有构建缓存；
首次 checkout 或清理输出后无需另行手动 build。`dev:web:full` 使用相同准备，再等待前端首次成功构建后
启动 API。准备失败不会启动消费者；准备期间退出也会停止准备进程，不会随后自动启动服务。

### 开发模式反向代理

HMR 默认 UI 为 `127.0.0.1:5180`，API 为 `127.0.0.1:3902`，分别可由
`VARIN_HMR_HOST`、`VARIN_HMR_UI_PORT`、`VARIN_HMR_API_PORT` 调整。Nginx Proxy Manager
等代理应转发到 UI 端口并启用 WebSocket，而不是将浏览器实时观察请求单独指向另一来源。
使用自定义域名时，可通过 Vite 原生的 `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` 指定该域名；
远程访问继续使用 Host 原有认证配置，不需要关闭来源校验。

Vite 保留浏览器的 `Host` 和 `Origin`，同时透传上游的转发头。TLS 在反向代理终止时，代理须提供
原始主机（含非默认端口）和协议。例如 Nginx 面向浏览器的代理层：

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

保留原始 `Origin`，不要改成内部 HTTP 地址。多层代理应保留受信上游记录的外部来源，而非覆盖成最后
一跳的内部地址。Host 仍独立校验认证与来源；本地直连与 HTTPS 反代不需要不同的源码补丁。

## 修改与验证

先确定实际 owner、输入路径和消费者。Renderer 状态、Host 服务、Catalog、Storage、扩展配置及 Knowledge 各自有职责。
保留已有工作、有意义的失败状态和原始执行寿命，避免建立并行 writer。校验、鉴权、跨进程读取、观察与耐久性的实际成本
和边界见[性能](performance.md#成本与边界)。

| 改动 | 对应证据 |
| --- | --- |
| 文档和导航 | 本地链接与 public route 检查，并核对描述对应的代码 |
| 局部行为 | 相关行为测试；静态形状变化时补类型/lint 检查 |
| 共享协议、权限和持久化 | 真实消费者、实际读写、失败与幂等重放 |
| 进程、平台或打包 | 对应 native suite、目标产物和实机操作 |
| 性能与去冗余 | 同来源/构建的代表性 workload 前后对比、结果正确性、体验指标和测量条件 |

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

恢复的 first-before/last-after、外部修改缺口和 reopen 由 Rust [storage/recovery_journal.rs](../kernel/crates/varin-kernel/src/storage/recovery_journal.rs) 的真实写入测试负责；
Host→Rust 的恢复/undo 与响应丢失重启由 [recovery/kernel-durable-engine.native.test.ts](../packages/web/application-host/lib/recovery/kernel-durable-engine.native.test.ts) 负责。Host
[recovery/engine.test.ts](../packages/web/application-host/lib/recovery/engine.test.ts) 接收这些 owner 提供的变更事实，验证 dirty buffer、冲突确认、取消、原 Thread 身份
与未知导航结果的协调，不在 fixture 中再实现 checkpoint、覆盖率或 GC 算法。

解析语法在对外 tokenizer 边界验证；高亮和编辑器层只补文本完整性、交互与动态配置更新，不重复枚举全部语法。
加密互操作使用实际客户端和 Host 两端，不在测试中重写握手；拒绝错误身份、篡改和重放仍属于必要契约。
依赖回归覆盖真实消费者和本地安全补丁，不为产品未使用的上游 API 预建兼容性套件。

共享 fixture 只负责准备输入、故障注入和资源回收。若测试结果完全由 fixture 自己算出，改为观察真实 owner，
或在已有 owner 回归足够时删除该重复证明；仍需保留 Host 对冲突、未知效果、权限及取消的独立处理。
部署和镜像的资格、候选 digest、来源校验、缓存与回滚由
[部署说明](ops/cloud-deployment.md#container-images)及相邻构建/发布入口维护。
缓存命中只说明计算可以复用，不是测试通过、来源正确或安装产物可用的证据。

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
同一文件内定位失败可再加 `--vitest-test-name=<测试名称模式>`，仍执行原协议与二进制门禁；定向通过不等于整个文件或完整平台通过。
不会额外重跑 Node transport 全套。仅需要纯查询、排序或 mock owner 的验证应留在 portable suite；
需要真实 IPC、文件存储、进程树的验证才进入 native 入口。

`test:tooling` 是 CI 中轻量工具测试的统一入口，包含 Electron 打包与更新清单 helper；`test:cloud` 是其子集，无需顺序重复运行。
Electron 的运行时、更新策略与路径打开行为统一由包的 `test` 自动发现；Linux autostart 仅在 Linux 执行，
真实桌面发现仍使用 `test:linux-desktop`。不为同一种 runner 维护额外配置和手写测试文件清单。
### CI 责任与适用范围

[ci-scope.mjs](../scripts/ci-scope.mjs) 按产品与 owner 选择普通 push/PR 的检查；未知路径、公共入口或无法取得 diff
扩大到完整适用范围，混合改动合并各 owner 的要求。具体 job、依赖、缓存和平台矩阵由
[ci.yml](../.github/workflows/ci.yml)维护，不在这里复制。

- Renderer 证据不代替 Host/native；文件、凭据、锁、进程与 IPC 改动需要相应操作系统的真实 owner。
- Rust 状态机、升级、耐久、权限、取消和未知效果不重放由真实 Rust 测试证明。
- 手动/定期完整资格和发行候选不借局部检查绕过平台故障；汇总检查保留失败、取消、缺失与意外跳过。
- teardown 未完成仍是资源寿命失败。安装服务、磁盘等基础设施故障与产品断言失败分别报告，不能简单延长 timeout 掩盖。
- 同一候选可重跑失败 job；不同源码 SHA 不互借绿色结果，构建缓存也不代表测试结果。

容器专项入口见 [container-check.yml](../.github/workflows/container-check.yml)，正式与按提交发行分别见
[docker.yml](../.github/workflows/docker.yml) 和 [docker-commit.yml](../.github/workflows/docker-commit.yml)。
Windows/macOS/Android 的构建与验收由各自平台入口负责；实机授权、挂载、桌面操作及多 Host 行为仍按
[运行时验收](runtime-acceptance.md)单独记录。Computer helper 的本地测试入口见
[Computer drivers](../packages/computer-driver/README.md)、
[Windows helper](../kernel/crates/varin-computer-windows/README.md)和
[原生 helper 验收](design/native-computer-helper.md)。

## 输出和 native 边界

`build:runtime-dependencies` 按依赖图准备一次共享输出；`build:type-dependencies` 再生成 Host 声明。
根 build、Web build 和 type-check 复用这些有序输出。包级 `build` 保持独立可用；多数共享包的 `build:raw`
仅供已经准备依赖的有序聚合使用，但 Web 的 `build` 与 `build:raw` 都进入
`build-products.mjs web --publish`，会自行准备或核验依赖及产物，不能将名字当作跳过依赖的保证。
`type-check:prepared` 不重新构建。根 `build` 不再把 UI 的 `tsc --noEmit` 当作产物构建重复执行；
UI 类型由 source/type-check 门禁负责。发布前仍使用相应目标的正式命令。

生产构建由 [scripts/build-products.mjs](../scripts/build-products.mjs) 统一准备，产物与可丢弃的构建回执在 `artifacts/build`。
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

[bun.lock](../bun.lock) 管开发依赖图，[scripts/cloud-runtime.bun.lock](../scripts/cloud-runtime.bun.lock) 管 staged production 图。影响生产依赖时，在对应输出准备后
运行 `bun run update:cloud-runtime-lock` 并核对真实差异。具体维护见[依赖说明](ops/dependency-updates.md)。

修改前检查 Git 状态，保留无关用户改动。将有完整证据的阶段提交并在获准后推送，确认远端实际 SHA；没有运行的验证不作
成功声明。发行、部署和凭据变更继续遵守该操作的授权边界。

### 跨设备项目验证

修改项目接入时同时检查 Settings 归一化与准入、原 SourceDirectory、默认来源冻结、文件主界面和模型配置 owner。
使用相同路径的本机与两个远端项目验证完整来源身份，不以 Host 标签或 DTO 构造代替远端访问证据。
覆盖原资源断连、已登记元数据保存、注册成功但分类失败、移除登记后分类待完成及原受理键重试。
模型配置检查协调 Host 的稳定项目 ID namespace、全局继承和 revision 冲突；本地项目仍走原受信任配置文件。

组件测试可用原 managed resource API 的可控 owner 验证文件与 Documents 请求不回退本机，
但不能据此声称物理双 Host、远端挂载、连接凭据、跨平台路径及真实编辑交互已经验收。
workspace adoption、项目 action 和 worktree 的管理操作通过明确的来源 owner 路由；验证时同时检查目标
准入、原操作回执、实际执行与断连恢复，不以界面能提交请求或统一“不可用”代替这些证据。

远端外部 Harness 使用 [managed-transport.native.test.ts](../packages/web/application-host/lib/external-agents/managed-transport.native.test.ts) 的两个真实 kernel、回环 HTTP managed 路由和
目标专有 fixture 程序验证 cwd／程序归属、协议流、原生 session 续接、停止与删除；目标不生成第二份产品会话。
恢复测试另外覆盖 dispatch 回应丢失、not-started 原 receipt、跨进程身份拒绝和 transport CAS。
测试环境不能创建 Unix socket／回环监听时，应明确记录未能启动该原生测试，并在具备权限的 CI 执行，
不能以 mock 结果替代双 Host 运行结论。

远端项目管理另由 [managed-project-management.native.test.ts](../packages/web/application-host/lib/projects/managed-project-management.native.test.ts) 验证：目标真实 Documents 登记、Git worktree
创建／初始化／移除、配对目录准入和协调端目录不变。版本工作区重试核对原 Storage adoption operation，
不得生成新身份来绕过未知回执。若执行设备缺少挂载后端，记录目标返回的具体能力失败，仍完成 Git 与权限测试，
不能把未运行的挂载验证计为通过。GitHub 列表与上下文使用目标原 reader／凭据，测试不得借协调端登录状态补齐。
