[English](../../README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [日本語](README.ja.md)

# Varin

<p align="center">
  <img src="../../packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](../../LICENSE)

**独立的 Agent 工作空间与执行框架，用于编程、研究和项目工作，覆盖桌面、Web 与移动端。**

Varin 使用自己的原生 Rust Agent runtime。Catalog 拥有 Thread、分支、持久对话历史与执行状态。
共享 Application Host 负责模型连接与账号、Agent 资源配置、MCP 配置和可信工作区服务。
客户端通过同一套应用 API 呈现并控制这些服务。详见[架构](../../docs/architecture.md)。

> [!IMPORTANT]
> Varin 尚未达到 1.0，正在积极开发。产品界面与私有运行时协议同步演进，新旧版本不保证互通。
> 请备份重要工作区，并在持久部署中固定经过验证的镜像摘要。现有用户资产不会被自动导入、迁移或改写；
> 不支持的内部存储格式会被拒绝打开。

## Varin 提供什么

- **原生对话：** Thread 与分支历史、流式响应、输入队列、模型与思考级别选择、子任务、计划、权限和恢复，
  均由原生 Catalog 支撑。[运行时](../../docs/runtime.md)
- **编程工作区：** 文件、差异、Git、worktree、终端、工作区搜索、语言服务器和调试。
  桌面与 Web 共用 Monaco，移动端轻量编辑器使用同一个文档权威，并明确处理未保存缓冲区与冲突。
  [工作台](../../docs/workbench.md)
- **执行与恢复：** 经准入的来源区分实时文件、快照和物化工作。Rust 拥有存储与执行资源；
  权限、取消意图和实际完成是独立事实。[资源与恢复](../../docs/resources.md)
- **研究与上下文：** 精确和语义检索、语言导航、作用域笔记、Bot 知识、Web 与学术发现，
  以及保留来源和页面图像的 PDF 材料。[检索与上下文](../../docs/retrieval.md)
- **Host 管理的配置：** 通过专用设置配置模型渠道、账号、端点、Agent 指令与技能、MCP 连接。
  凭据和特权执行由可信 owner 持有。[模型](../../packages/web/application-host/lib/models/DOCUMENTATION.md)、
  [Agent 资源](../../packages/web/application-host/lib/agent-resources/DOCUMENTATION.md)、
  [MCP](../../packages/web/application-host/lib/mcp/DOCUMENTATION.md)
- **本地与远程使用：** Electron 内嵌 Application Host，Web 和 Capacitor 移动客户端连接同一 Host。
  远程 Host、配对、隧道及容器/SSH 部署保留明确的访问与平台边界。
  [安全](../../docs/security.md) · [运维](../../docs/ops/README.md)

四个内置 Workbench Profile 分别选择 **Agent Workspace**、**IDE Workbench**、**Research Workbench**
或 **Varin Bot**。Agent、Research 和 Bot 支持桌面、Web 与移动端，IDE 支持桌面与 Web。
这些 Profile 都是 Varin 扩展，可以替换整个外壳或单独的贡献；工作焦点、文档和 Thread 身份独立于界面呈现。

模型供应商、Computer/VM 和打包支持取决于实际环境。定向测试不等于完整的平台验收；
详见[运行时验收](../../docs/runtime-acceptance.md)。

## 开发 Varin 扩展

Varin 扩展通过公开契约贡献工作台界面和可信 Host 能力。作者工具包包括 `@varin/extension-contract`、
`@varin/extension-sdk`、可选的 React 19 适配器 `@varin/extension-react`、`@varin/extension-surface`
和 `@varin/extension-cli`。

当所用 registry 中有可用的发布版本时：

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

源码工作流、manifest、能力、生命周期、发布与测试契约见[扩展](../../docs/extensions.md)及
[作者指南](../../docs/ops/varin-extension-authoring.md)。

## 下载桌面版

请在 [GitHub Releases](https://github.com/Youzini-afk/Varin/releases) 查看可用产物及平台、版本信息。
源码和容器使用方式如下。

## 从源码开始

前提：Node.js 22.19 或更新版本（源码开发基线为 Node.js 24）、Bun 1.3.14、Git，
以及 [kernel/rust-toolchain.toml](../../kernel/rust-toolchain.toml) 指定的 Rust 工具链。
平台配置与验证见[开发指南](../../docs/development.md)。

Rust kernel 是必需组件。没有 staged binary 时，源码开发可以通过 Cargo 启动它；
`bun run kernel:build` 生成打包布局所需、经 manifest 校验的 release 可执行文件。
就绪检查面向实际 Application Host 与原生 Thread catalog。

### Web 开发

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

打开终端打印的 Vite URL。该命令在可用开发端口启动 UI 与可信 Application Host。
开始模型工作前，请在设置中配置模型连接与账号。

### 桌面开发

```bash
bun run electron:dev
```

若要测试打包的 UI 资源：

```bash
bun run electron:dev:bundled
```

### Windows 安装包

在 Windows 上运行：

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

NSIS 安装包、更新元数据和 blockmap 输出到 `packages/electron/dist`。未配置签名凭据的构建不带签名。
详见[桌面打包](../../packages/electron/README.md#packaging)。

## 运行云端镜像

Compose 默认使用 `ghcr.io/youzini-afk/varin-slim:latest`。在 Linux Docker 主机上：

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

打开 `http://127.0.0.1:3000`，使用生成的密码。面向互联网的部署需要 TLS 反向代理或经批准的隧道，
并遵守[转发规则](../../docs/ops/REVERSE_PROXY.md)。生产部署请将 `VARIN_IMAGE` 固定为经过验证的不可变摘要。

如需容器内的 Python、Java、Go 或 Rust 开发工具：

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

持久化路径、环境变量、镜像变体、支持的架构，以及带健康检查和回滚的 SSH 部署，见
[云端部署](../../docs/ops/cloud-deployment.md)。

## 架构与开发

从[文档索引](../../docs/README.md)、[架构](../../docs/architecture.md)和[开发指南](../../docs/development.md)
开始。Application Host 集成原生 Catalog 执行、Rust 拥有的存储与资源，以及独立的知识和扩展 owner；
renderer 不拥有凭据或持久执行。

贡献前请阅读 [CONTRIBUTING](../CONTRIBUTING.md) 和 [AGENTS](../../AGENTS.md)。命令以 package scripts
为准，验证应针对改动选择。

感谢 [LinuxDO](https://linux.do) 社区的支持。

## 来源与许可证

Varin 是一个独立项目，源于维护者的 OpenChamber 分支。

组合后的作品以 [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）分发。
通过网络向用户提供修改版本时，必须按许可证要求提供对应源码。保留的版权与第三方义务见
[THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。
