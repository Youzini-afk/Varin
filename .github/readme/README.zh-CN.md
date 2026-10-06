[English](../../README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [日本語](README.ja.md)

# Varin

<p align="center">
  <img src="../../packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](../../LICENSE)

**独立的 Agent 工作台与完整 Harness，面向编程、科研和其他项目工作：以本地和桌面体验为中心，
同时覆盖 Web、编辑器与移动端。**

它内置 [Pi](https://github.com/earendil-works/pi) 运行时；模型与提供商栈、会话树、包管理器和扩展模型仍由
Pi 提供，而 Varin 负责周围的工具环境、工作状态、恢复、检索、上下文策略、任务治理和工作台界面。
它直接使用 Pi 的公开 SDK，而不是抓取终端输出。

Workbench Profile 可选择四套内置外壳：**Agent Workspace**、**IDE Workbench**、
**Research Workbench** 和 **Varin Bot**。它们都是普通的 Varin 扩展，可以整体替换，也可以
只替换其中的部分。Agent Workspace 以会话和任务为中心；IDE Workbench 将编辑器、搜索、Git、
诊断和调试与可停靠的智能体面板结合。

Agent Workspace、Research Workbench 和 Varin Bot 支持桌面、Web 与移动端；IDE Workbench
支持桌面与 Web。工作侧重与所选外壳相互独立。

> [!IMPORTANT]
> Varin 目前仍处于 1.0 之前的活跃开发阶段。各产品端和私有运行时协议会同步演进，较旧构建
> 不保证与较新构建互通。请备份重要工作区；长期部署时，请固定到已经验证的镜像摘要。

## 产品界面

以下截图使用隔离的 `demo-workspace` 和匿名示例文件生成。

### Agent Workspace

项目和会话始终可见，主区域将当前智能体、上下文工具与输入框集中在同一个工作空间中。

![Varin Agent Workspace](assets/agent-workspace.png)

### IDE Workbench

IDE Profile 将工作区导航和编辑器基础设施与完整的 Pi 智能体并排组合，而不是把聊天拆成另一个应用。

![Varin IDE Workbench](assets/ide-workbench.png)

### 移动端工作空间

响应式界面在手机屏幕上保留同一套项目、智能体控制、上下文界面和输入框。

<p align="center">
  <img src="assets/mobile-workspace.png" alt="Varin 移动端工作空间" width="390" />
</p>

## Varin 提供什么

### 受治理的 Agent Harness

- **Thread、Run 与不可变工作状态：** 工作被组织为 Thread 与 Run，其文件变更以不可变 root 发布。
  智能体在隔离的虚拟或物化工作区中起草，再把经过审阅的结果合并回来，而不是对你的检出目录
  随手修改。
- **唯一的权限门：** 单个 `tool_call` 确认覆盖 harness 工具、Pi 内置工具、MCP 工具、包工具和
  嵌套线程工具。会话授权始终绑定在获批的工具、动作、工作区、路径和网络目标上。
- **跟随智能体的恢复：** Host 拥有的恢复服务把智能体的变更与你自己的编辑记入同一组检查点，
  受影响文件回退、撤销/重做和崩溃恢复可以跨越多次工具调用工作，无需扫描整个工作区。
- **原生的工具环境：** shell 监督器运行真实 PTY，支持自动转后台、`get_output`、
  `write_to_process` 和 `kill_shell`；`edit`/`write`/`apply_patch` 附带编辑后诊断与按路径租约；
  超长结果变成可分页的 `OutputRef`；包管理器输出按命令整理而不是原样倾倒。

### 上下文、检索与知识

- **结构化上下文组装：** Zone 2 层把观察到的工作区事实——你的编辑、终端命令、诊断、Git 状态——
  注入上下文，而不改动系统提示词。memory keeper 以 off/assist/takeover 三种模式维护持久记忆，
  Host 侧压缩可以接管摘要工作且不产生额外模型调用。
- **分层检索：** 精确匹配用 `grep`；分组发现用 `explore`/`related`，由符号图和 tree-sitter
  结构支撑；持久记忆用 `recall` 查询每个工作区的知识库，可选 embedding 与重排。每一层都可以
  直接使用，不要求上一层先失败。
- **原生 Web 工具：** `webfetch` 带 SSRF 与域名策略、正文提取、PDF 和缓存；`websearch` 走用户
  配置的提供商；来源面板；桌面端离屏页面渲染。

### 真正的编程工作空间

- **Pi 原生会话：** 支持流式响应、分支、会话树导航、压缩、引导和后续消息队列、模型与思考
  级别选择，以及会话重命名、归档、恢复和删除。
- **工作区工具：** 文件、Diff、Git、工作树、终端、SSH 主机、远程实例、代码评论和编辑器上下文，
  共享当前 Pi 会话及其工作目录。
- **编辑器级基础设施：** 一套带版本的文档权威和真实的冲突处理；桌面/Web 的 Agent 与 IDE 共用
  Monaco model、编辑器组、工作区搜索、宿主侧语言服务器和标准调试适配器，移动/嵌入式编辑器通过
  轻量 CodeMirror adapter 接入同一文档权威。智能体的修改会与你未保存的缓冲区协调，而不是直接覆盖。
- **自定义提供商：** 配置 Pi 原生的提供商分层、认证、模型发现和自定义端点，不把凭据复制到
  渲染进程存储中。

### 可重组，覆盖多端

- **不另造一套插件系统：** 可以安装、更新、移除和检查 Pi `PackageManager` 接受的任意包。
  尚未专门适配的扩展仍可使用通用的命令、工具、条目、通知和 UI 桥接。
- **常用插件的专用配置界面：** 已维护的插件拥有针对性的 GUI，同时继续以插件自己的原生
  JSON/JSONC 文件、命令、数据库和迁移逻辑为权威。
- **可重组的工作台：** 选择 Agent、IDE、Research 或 Bot Profile，也可以自建。既能替换整个外壳，也能只替换导航、
  编辑器、面板、Composer、Timeline 或状态栏，并混用官方与社区贡献。切换是实时的，不刷新文档、
  不重启 Pi 运行时、不丢失共享的工作区状态。
- **多个产品端：** Electron、Web 和 Capacitor 移动端外壳共享一套 React UI，并通过明确的运行时
  能力与宿主通信。
- **云端与远程运行：** 支持带认证的 WebSocket、Relay/隧道、多架构容器，以及经过健康检查和
  可回滚的原子 SSH 部署。

## 已维护的扩展集成

Varin 不会 fork 这些扩展，也不会复制它们的私有状态。已维护的适配器只消费各扩展公开的命令、
事件、设置文件和能力协议——包括子智能体集群、上下文管理、工作区历史、MCP 服务、Web 访问、
记忆系统、后台任务和 LSP/工具链配置——因此插件可以继续独立更新。

每个扩展的集成面——Varin 读取或调用哪些命令、事件和原生配置，以及哪些文件仍归插件所有——记录在
[扩展集成契约](../../docs/design/extension-compatibility.md)。Varin 不逐版本认证插件与 Pi 的搭配。

## 开发 Varin 扩展

Varin 应用扩展与 Pi 插件是两个独立的产品对象：前者扩展 Varin 的工作台、页面和可信宿主，
后者运行在 Pi 智能体中。规划中的 npm 工具链不要求检出 Varin 源码，也不要求扩展导入产品私有 UI；
`@varin/*` 包尚未发布：

- `@varin/extension-contract`：清单、贡献、服务、路由和发现协议及 JSON Schema；
- `@varin/extension-sdk`：与 UI 框架无关的 Surface、隔离运行域和 Host 开发 API；
- `@varin/extension-react`：可选的 React 19 适配器；
- `@varin/extension-surface`：供高级测试和替代宿主使用的底层生命周期与注册表；
- `@varin/extension-cli`：项目初始化、检查、构建和一致性测试。

这些包发布后，可以用以下命令创建完整的扩展项目：

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

完整的清单格式、能力、生命周期、存储、发布和测试说明见
[Varin 扩展开发指南](../../docs/ops/varin-extension-authoring.md)。

## 下载桌面版

当前 Varin 桌面包尚未发布。[GitHub Releases](https://github.com/Youzini-afk/Varin/releases) 页面保留历史
资产；在 Varin 包发布前，请使用下方的源码或 Docker 方式。

## 从源码开始

### 环境要求

- Node.js 22.19 或更高版本；Node.js 24 是当前支持的源码开发基线
- Bun 1.3.14
- 与 `kernel/rust-toolchain.toml` 匹配的 Rust 工具链（rustup 会自动选择）
- Git
- 在 Windows 上运行 Pi shell 工具时，需要 Git for Windows 和 Git Bash

Rust 系统内核是必需的运行时组件，不是可选加速器。源码开发模式下，若没有已暂存的二进制，Host
会通过 Cargo 直接运行它；`bun run kernel:build` 产出打包布局要求的、带 manifest 校验的发行
可执行文件。

Varin 自带捆绑的 Pi 运行时，并通过 Runtime Manager 发现用户级 Pi 安装，由它选择、安装或仅向上
升级 Pi；完成真实 Host 握手后即可使用，无需重启 Varin。Electron 自带运行应用所需的 Node 环境，
但 Pi 本身仍作为独立的用户级工具存在。Windows、Linux 和 macOS 的 x64/ARM64 原生桌面包均在对应
架构的 runner 上验证应用启动、Runtime Manager、健康检查和终端生命周期；可选离线包仍待后续提供。
容器固定自带经过验证的 Pi 运行时，以保证无人值守部署可复现。

### 运行 Web 开发环境

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

打开终端输出的 Vite 地址。Varin 会选择可用的开发端口，并同时启动 UI 与可信 API/运行时服务。

### 运行桌面应用

```bash
bun run electron:dev
```

需要测试更接近安装包的内置资源模式时，运行：

```bash
bun run electron:dev:bundled
```

### 构建 Windows 安装包

请在 Windows 上运行：

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

NSIS 安装包、更新元数据和 blockmap 会输出到 `packages/electron/dist`。没有配置代码签名凭据时，
构建会有意生成未签名安装包。签名方式和其他平台说明见
[桌面打包指南](../../packages/electron/README.md#packaging)。

## 运行云端镜像

Compose 默认使用精简镜像 `ghcr.io/youzini-afk/varin-slim:latest`。在 Linux Docker 主机上运行：

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

打开 `http://127.0.0.1:3000`，使用刚生成的密码登录。任何面向公网的部署都应置于 TLS 反向代理
或经过审核的隧道之后，具体转发要求见[反向代理配置](../../docs/ops/REVERSE_PROXY.md)。生产环境请将
`VARIN_IMAGE` 固定为已验证的不可变摘要，不要依赖浮动标签。

若智能体要在容器里编译 Python、Java、Go 或 Rust，叠加工具链覆盖层：

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

镜像同时发布 `linux/amd64` 和 `linux/arm64` 版本，并带有 provenance 与 SBOM 证明。持久化路径、
环境变量、容器及 SSH 回滚的完整约定见[云端部署](../../docs/ops/cloud-deployment.md)。

## 架构

```mermaid
flowchart LR
    S["渲染器：由 Workbench Profile 选定外壳扩展"] --> C["@varin/application-client"]
    S --> D["文档、搜索、语言与运行调试 API"]
    C --> T["带认证的 HTTP/WebSocket 或编辑器传输"]
    T --> A["应用宿主：@varin/web 服务"]
    D --> A
    A --> K["varin-kernel：私有 Rust 系统内核"]
    A --> B["@varin/runtime-broker"]
    B --> H["隔离的 @varin/pi-host 工作进程"]
    H --> P["Pi SDK + 受信任的 Pi 包"]
```

应用宿主是唯一的可信后端。每个宿主拥有一个私有 `varin-kernel` 子进程，它是持久化与贴近机器
资源的生产权威：不可变工作状态 root、内容对象与 GC、恢复元数据、canonical 文件资源与物化、PTY
和管道进程树、固定视图的文件与结构计算。宿主保留产品策略——actor 准入、文档协调、Thread/Run
生命周期、知识与模型编排——并通过私有 framed stdio 协议与内核通信，从不开放公开端口。每类资源
只有一个生产写者，内核之后不再保留 TypeScript 兜底权威。

Broker 管理一个目录工作进程和每个会话各自的工作进程。渲染器重新加载不会终止正在执行的任务，
Pi 工作进程异常也不会让渲染器一同崩溃。跨进程传输的是 Varin 协议 DTO；SDK 回调、凭据对象和
扩展实现细节不会越过这条边界。

Electron 在主进程里运行同一个宿主，而不是再造一套桌面后端；只有窗口、菜单、对话框这类真正的
原生能力才跨过 Electron preload 边界。

第三方 Pi 包是拥有当前用户操作系统权限的可执行代码。Varin 会展示观察到的能力，并对项目内
可执行资源设置授权门槛，但不会把受信任扩展宣传成完整的沙箱。在公开远程实例或安装陌生代码之前，
请阅读[安全策略](../translations/SECURITY.zh-CN.md)和[安全模型](../../docs/design/security.md)。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `kernel/` | 私有 Rust 系统内核：工作状态、文件资源、进程与计算 |
| `packages/application-client` | 与框架无关的 `RuntimeAPIs`、传输、带类型错误与桌面 IPC 契约 |
| `packages/ui` | 共享的 Pi 原生 React UI、状态、设置和扩展界面 |
| `packages/web` | 浏览器/远程前端、可信 Application Host 与云端 CLI |
| `packages/electron` | 原生桌面外壳、特权边界、打包、SSH 和更新 |
| `packages/mobile` | 连接 Varin 服务端的 Capacitor iOS/Android 外壳 |
| `packages/protocol` | 带版本且可安全 JSON 序列化的工作进程/产品端协议 |
| `packages/runtime-client` | 可在浏览器中使用的运行时请求/事件客户端 |
| `packages/runtime-broker` | 目录/会话工作进程的管理、路由和关闭 |
| `packages/pi-host` | 嵌入 Pi SDK 和扩展的隔离 Node 工作进程 |
| `packages/settings-store` | 各 Host 共享的原子化设置文件持久化 |
| `packages/extension-contract` | 清单、贡献、工作台、服务和发现协议 |
| `packages/extension-surface` | 与框架无关的归属域和事务式 Surface 注册表 |
| `packages/extension-sdk`、`-react`、`-cli` | 公开的作者 SDK、React 适配器和作者工具链 |
| `packages/extension-host` | 可信应用宿主的目录、构件、存储与服务 |
| `packages/extension-loader` | 带认证的 managed Surface 模块加载器与隔离运行域 |
| `packages/extension-builtins` | Varin 内置扩展的清单，含四套官方外壳 |
| `packages/docs` | 面向用户的文档站源码 |
| `docs` | 架构、harness、内核、工作台、迁移、恢复、云端和安全约定 |
| `scripts` | 开发、内核构建/测量、发布、云端、部署和校验工具 |

## 开发与校验

以根目录或各包的 `package.json` 脚本为准。下面这组本地基线覆盖 CI 的主要质量门槛：

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test:pi
bun run test:kernel
bun run test:cloud
bun run build
bun run test:pi:dist
```

`bun run kernel:check` 是 Rust 快速编译检查；`bun run test:kernel` 针对构建出的发行可执行文件
运行不可跳过的原生权威套件。`bun run test:docs` 测试文档校验器；
`bun run docs:validate` 一次检查用户文档和工程文档内容。

CI 固定为三条职责不同的门禁：Ubuntu 源码质量、Windows 运行时行为和 Ubuntu 生产构建。
类型检查、lint 和全仓测试只在权威门禁中执行一次；Windows 只补充平台相关测试。云端/运行时输入
发生变化时，Docker 工作流只验证容器契约，并构建配套的精简与工具链基础镜像及应用镜像；两个
候选应用都通过不可变摘要烟测后，才会提升可安装标签。

参与贡献前，请阅读[工程开发指南](../../docs/development.md)、[贡献指南](../translations/CONTRIBUTING.zh-CN.md)和精简的
仓库边界说明 [AGENTS.md](../../AGENTS.md)。

## 设计与运维文档

- [工程开发与知识导航](../../docs/development.md)
- [架构](../../docs/architecture.md)
- [路线图](../../docs/roadmap.md)
- [Agent Harness 契约](../../docs/design/agent-harness.md)，附[交付状态](../../docs/status.md)、[实施计划](../../docs/plan/agent-harness-plan.md)与[决策日志](../../docs/decisions/README.md)
- [Rust 系统内核设计](../../docs/design/rust-kernel-design.md)与[审查记录](../../docs/archive/rust-kernel-audit.md)
- [可组合工作台与 IDE 约定](../../docs/design/composable-workbench.md)
- [统一文件编辑器平台](../../docs/design/unified-file-editor-platform.md)
- [Varin 扩展平台](../../docs/design/varin-extension-platform.md)
- [从 OpenChamber 迁移到 Pi 的约定](../../docs/ops/openchamber-pi-migration.md)
- [插件 GUI 与状态归属设计](../../docs/design/plugin-gui-design.md)
- [恢复模型](../../docs/ops/recovery.md)
- [云端部署](../../docs/ops/cloud-deployment.md)
- [安全模型](../../docs/design/security.md)

## 项目沿革与许可证

Varin 是维护者 OpenChamber fork 的 Pi 原生重构。

Varin 作为组合后的完整作品，按照
[GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）发布。通过网络向用户提供
修改版时，必须按照许可证要求向这些用户提供对应源码。
