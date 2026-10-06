[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | 简体中文 | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 为 Varin 贡献

感谢你帮助改进 Varin。无论是 Pi 运行时边界、桌面与远程端、扩展集成、文档、测试、无障碍，
还是平台支持，都欢迎贡献。

本文说明公开的贡献流程。具体实现工作还需要遵循 [AGENTS.md](../../AGENTS.md)、离改动最近的包 README，
以及负责该能力的架构文档。

## 文档语言

面向用户的文档默认使用英文：仓库首页 README、贡献指南、安全策略，以及 `packages/docs` 内容树
根目录都以英文为源语言。简体中文和其他语种是译本。

当事实行为、命令、安全建议或链接发生变化时，应在同一次改动中同步适用的语言版本。新的文档页
先写英文，再补齐 `zh-cn/` 及其他语种译本。每份本地化根文档都必须以语言切换导航开头，让读者
无需返回仓库首页即可切换语言。

## 开始之前

- 请阅读[行为准则](CODE_OF_CONDUCT.zh-CN.md)。
- 在 [GitHub Issues](https://github.com/Youzini-afk/Varin/issues) 中报告可复现的缺陷、提出功能
  建议或展开聚焦的技术讨论。
- 漏洞请通过[安全策略](SECURITY.zh-CN.md)中的私密流程报告。不要把利用细节发布到 Issue、
  Discussion、Pull Request、日志或截图中。
- 开始之前先搜索现有 Issue 和 Pull Request，避免重复工作。
- 对于较大的产品或架构改动，建议先说明用户结果和受影响边界，再投入完整实现。如果原型有助于看清
  取舍，也非常欢迎。

## 会影响贡献方式的项目原则

Varin 不是套在多个编程智能体 CLI 外面的通用壳。它只有一套 Pi 原生领域模型，以及一套当前有效的
预发布运行时协议。

1. **以 Pi 为权威。** 会话、模型、认证、设置、包和扩展运行时均由 Pi 负责。跨边界时投影成可安全
   JSON 序列化的 Varin 协议，不要把 Pi 状态复制进另一套应用 Schema。
2. **保留插件的状态归属。** 通过公开命令、事件、设置和能力桥接集成扩展。不要为了制作 GUI 而解析
   私有数据库或复制插件迁移逻辑。
3. **避免兼容层沉积。** 在 1.0 之前，各产品端同步演进。替代实现验收后，应删除过时的 OpenCode 和
   Varin 路径；除非确有持久化数据或独立客户端需要，不要堆积类似协议 v13/v14 的适配层。
4. **在可信边界执行权限校验。** 渲染器和远程客户端不能自行授权。文件系统、进程、网络、项目
   信任和凭据操作，必须由真正拥有该能力的宿主验证。
5. **不要添加武断的产品限制。** 避免静默截断、模型数量上限、过短超时和隐藏的并发上限。运维预算
   应是部署者明确选择的选项，并具有可见的失败语义。
6. **如实表达失败。** 权威来源失败不等于成功返回空数据。取消、部分失败、清理、重试、回滚和能力
   不可用都应被明确呈现。

改动涉及相应边界时，请阅读[架构](../../docs/architecture.md)、[插件 GUI 设计](../../docs/design/plugin-gui-design.md)、
[恢复](../../docs/ops/recovery.md)和[安全模型](../../docs/design/security.md)。

## 开发环境

### 环境要求

- Node.js 22.19 或更高版本；Node.js 24 是 CI 和当前支持的开发基线
- Bun 1.3.14
- Git
- 在 Windows 上运行 Pi shell 工具时，需要 Git for Windows 和 Git Bash

### 克隆与安装

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run check:pi
```

`bun.lock` 是依赖的权威记录。除非依赖变更确实需要，否则不要切换包管理器或重新生成锁文件。请仔细
审查生命周期脚本的变化；Varin 有意只允许确实需要执行的安装脚本。

## 常用开发入口

除非另有说明，所有命令都从仓库根目录运行。

| 目标 | 命令 |
| --- | --- |
| 带 HMR 与可信 API 的 Web UI | `bun run dev` |
| Web 构建监听器与服务端 | `bun run dev:web:full` |
| 使用 Web HMR 的桌面端 | `bun run electron:dev` |
| 使用已构建资源的桌面端 | `bun run electron:dev:bundled` |
| 为当前操作系统打包桌面端 | `bun run electron:build` |
| 构建 Windows x64 NSIS 安装包 | `bun run electron:build:win` |
| 烟测解包后的 Windows 应用 | `bun run electron:smoke:win` |
| 构建移动端资源 | `bun run mobile:build` |
| 构建规范的云端运行时 | `bun run build:cloud-runtime` |
| 校验文档站 | `bun run docs:validate` |

共享 UI 是源码级库，不是独立应用。请通过 Web 或 Desktop 验证 UI 行为，确保它运行在
真实的宿主上下文中。

## 选择负责改动的包

| 领域 | 主要负责包 |
| --- | --- |
| 共享组件、状态、设置、聊天与插件 GUI | `packages/ui` |
| 浏览器/远程服务、HTTP API、WebSocket 传输、云端 CLI | `packages/web` |
| Windows/macOS/Linux 外壳、preload/IPC、SSH、更新和打包 | `packages/electron` |
| Capacitor 原生外壳 | `packages/mobile` |
| 可安全 JSON 序列化的协议与校验 | `packages/protocol` |
| 浏览器/编辑器运行时客户端 | `packages/runtime-client` |
| 工作进程管理、路由、生命周期和关闭 | `packages/runtime-broker` |
| Pi SDK、会话、包、扩展和可信宿主操作 | `packages/pi-host` |

共享 API 改动往往会跨越多个包，但必须始终有一个权威层。不要用无关的本地 Store 或只存在于
渲染器的权限判断来绕过缺失的协议。

## 实现一项改动

1. 先确定权威数据源、可信执行边界、受影响的产品端和失败行为。
2. 编辑导入的产品代码之前，阅读 `AGENTS.md`、最近的包 README 或 `DOCUMENTATION.md`，以及与
   改动匹配的全部项目 Skill。
3. 保持改动聚焦。应包含直接需要的清理和测试，但无关重构应拆开，以免增加审查难度。
4. 在真正负责该行为的边界添加或更新最小范围的回归测试。
5. 验证协议涉及的每个运行端。共享类型通过类型检查，并不能证明 Desktop、Web、Relay 或移动端
   实际可用。
6. 用户行为、贡献流程、架构、安全或运维约定发生变化时，在同一改动中更新对应文档。

修改带版本或持久化的数据形状时，优先提供一次明确迁移，将旧数据转换到当前形状。只有真实用户数据
或独立部署的客户端确实需要时才保留旧读取器，并记录删除条件。

## 校验

### 通用基线

代码、依赖、导出或构建发生变化时，运行：

```bash
bun run type-check
bun run lint
bun run check:pi
bun run build
```

根据涉及的边界补充以下证据：

| 改动 | 额外校验 |
| --- | --- |
| Pi host、协议、Broker 或运行时客户端 | `bun run test:pi:dist` |
| Web 服务或传输 | `bun run --cwd packages/web test` |
| 云端运行时、Docker 或 SSH 部署 | `bun run test:cloud`，并构建一次规范云端运行时 |
| Electron 生命周期、架构或更新器 | `bun run --cwd packages/electron test:architecture` 和/或 `test:updater` |
| Windows 打包或原生模块 | `bun run electron:build:win`，随后运行 `bun run electron:smoke:win` |
| 导入、导出或删除 | `bun run dead-code`，并生产构建每个受影响的产品端 |
| 文档站 | `bun run docs:validate`，并手动检查改动过的本地链接 |
| 工作区 `package.json` 或根 lockfile | 运行 `bun run update:cloud-runtime-lock`，保持 `scripts/cloud-runtime.bun.lock` 与冻结安装一致 |

CI 会在 Windows 和 Ubuntu 上重复主要质量门槛。云端/运行时改动还会构建并烟测候选容器，只有通过后
才提升可安装标签。

如果某项必需检查无法在你的主机上运行，请明确写出没有验证的内容和原因。不要把未经测试的平台假设
写成支持声明。

### 用户可见改动

请提供与 Pull Request 当前 HEAD 对应的证据：

- 对有意义的静态状态提供前后对比截图；
- 对动画、焦点、拖放、手势或多步骤交互提供简短录屏；
- 共享响应式 UI 同时提供窄屏和宽屏状态；
- 颜色或界面层级变化时，同时覆盖浅色和深色主题；
- 根据改动覆盖加载、空、禁用、错误、长内容和高对比度状态；
- 性能、内存、CPU、启动或渲染声明需提供前后测量结果。

如果没有用户可见变化，请说明原因。

## 代码与安全风格

- 使用严格 TypeScript。只有边界确实是动态数据且已经校验时，才在说明理由后使用 `any`。
- 优先使用小型可辨识联合协议、提前返回和明确状态转换，避免深层嵌套或隐式回退。
- React 组件使用函数形式，并复用 `packages/ui` 现有的主题和排版 token，同时支持浅色与深色模式。
- Electron preload API 必须明确且带类型。不要添加通用 channel 逃生口，也不要在共享渲染器代码中
  导入 Electron。
- 永远不要在渲染进程中执行 Pi 扩展。
- 永远不要记录凭据、Authorization/配对数据、提示词正文、文件内容、包含用户数据的提供商响应，
  或完整环境变量值。
- 路径包含关系应基于规范化后的真实文件系统边界，而不是字符串前缀。
- 共享配置或元数据写入应使用锁和原子替换，并能测试并发编辑与崩溃恢复。
- 保留脏工作树中的用户改动和无关工作，不要把破坏性 Git 清理当作便利手段。

## 提交与 Pull Request

提交标题应简短、使用祈使语气，并在有帮助时使用约定式类型前缀，例如：

```text
feat: add Pi package capability diagnostics
fix: preserve session cwd across worktrees
docs: explain cloud rollback guarantees
```

Pull Request 应使审查者无需重走你的调查过程，就能验证结果。请包含：

- 用户或维护者遇到的问题，以及改动后的行为；
- 当邻近范围可能产生歧义时，说明非目标；
- 受影响的包、运行端、持久化格式、外部协议和信任边界；
- 自动与手动检查的准确命令及结果；
- 有意义的风险、失败、清理、回滚、兼容和安全考虑；
- 适用时提供当前的视觉或测量证据；
- 任何未能验证的内容。

更新分支时不要重写其他贡献者的工作。解决冲突时重新判断行为和状态归属，不要机械地选择某一侧。

## 非代码贡献

你还可以通过以下方式帮助项目：

- 报告可复现的缺陷或令人困惑的工作流；
- 在其他操作系统、浏览器、CPU 架构或显示尺寸上测试；
- 改进安装、部署、无障碍、本地化或故障排查文档；
- 验证常用 Pi 扩展的更新并记录兼容性证据；
- 提出更清晰的 Pi 原生交互或插件配置界面。

## 许可证

提交贡献即表示你同意相关内容可以按照 Varin 的
[GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）分发；导入的第三方内容仍应
保留[第三方声明](../../THIRD_PARTY_NOTICES.md)所要求的署名和许可证文本。
