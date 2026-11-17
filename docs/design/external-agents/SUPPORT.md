# 外部 Agent 支持目标

设计阶段，2026-11-17。本轮只扩充支持清单与交互稿，不修改产品适配器。

参照本地 Codeg `4991406e6` 的 20 个内置产品，保留 Varin 已有的原生协议接入。当前 Varin 有 Codex、Claude Code、Pi 三个专用适配器及七个 ACP 启动预设；新增十个产品进入接入目标。DeepSeek 在目录中是一个产品，官方 ACP 与社区桥接是两个明确的连接选择。

“已有”表示代码已有入口，平台、版本与功能边界仍见[现行外部 Agent 文档](../../external-agents.md)。表中“计划”与设计稿演示不是正式兼容性声明。版本示例来自参考源码，不作为更新服务的最新版本数据。

## 产品清单

| 产品 | Varin 当前状态 / 目标入口 | 安装与管理设计 | 接入要点 |
| --- | --- | --- | --- |
| Codex | 已有：`codex app-server` | 已有程序；托管安装官方 CLI | 保留原生 thread/turn、插话、审批和恢复，不改接 codeg 使用的 codex-acp |
| Claude Code | 已有：SDK core 驱动指定 Claude CLI | 已有程序；官方安装说明 | 保留现有 SDK 适配，不增加 claude-agent-acp 依赖；本轮不做登录 |
| Pi | 已有：原生 RPC | 已有程序；托管安装 Pi | 保留原生 RPC，不为目录统一而换成 pi-acp |
| OpenCode | 已有：`opencode acp` | 完整官方发行包或已有程序 | 配置选项、工具与恢复以当前连接为准 |
| Gemini CLI | 已有：`gemini --acp` | 官方 npm 包或已有程序 | 不自动加入参考项目的 `--skip-trust`；保留原程序自己的授权 |
| Kimi Code | 已有：`kimi acp` | 官方 npm 包或已有程序 | 沿用目标设备配置，Windows 运行依赖按官方发行要求处理 |
| Cursor Agent | 已有：`cursor-agent acp` | 完整官方发行目录或已有程序 | 保留目录内配套文件，不按单文件 CLI 安装 |
| Qoder | 已有：`qoder --acp` | 官方 npm 包或已有程序 | Windows 架构按实际发行包，不在所有机器展示相同安装动作 |
| Grok | 已有：`grok agent stdio` | 官方 npm 包或已有程序 | 版本命令为 `grok version`；原工具权限与模式由后端管理 |
| DeepSeek Harness | 已有：`dsh --profile acp`；计划补 `deepseek-acp` 社区桥接选择 | 两条路线分别记录安装包与程序版本 | 目录合并展示产品，连接配置身份分开；现有官方会话不自动迁移到社区桥接 |
| Cline | 计划：`cline --acp` | 官方 npm 包或已有程序 | 核对 local/session backend、配置选项与自更新行为；不把 codeg 的环境覆盖直接施加给用户安装 |
| CodeBuddy | 计划：`codebuddy --acp` | `@tencent-ai/codebuddy-code` 或已有程序 | 原生 ACP；保留实际模型选项、工具状态、取消与会话恢复 |
| OpenClaw | 计划：`openclaw acp` | CLI 可托管安装，Gateway 继续使用用户已有部署 | ACP 桥接连接其 Gateway；CLI 安装成功不表示 Gateway 已配置或运行 |
| Hermes Agent | 计划：`hermes acp` | 优先已有官方安装；提供官方安装说明 | codeg 的 npm 包装是社区渠道；共享 gateway daemon 的结束边界需专门适配 |
| Google Antigravity | 计划：官方 ACP server | 完整解压官方发行目录 | ACP 服务与 localharness 配套安装；需补实际使用的客户端文件操作能力 |
| Kiro CLI | 计划：`kiro-cli acp` | 沿用官方安装器与原生更新命令 | 使用旧式 models/modes 及 `_kiro.dev/metadata`，思考选项需要协议适配 |
| ZCode | 计划：`zcode-acp-server server` | 可托管安装社区桥接；官方 ZCode 程序单独准备 | 清楚显示桥接依赖，不把桥接版本显示成官方程序版本 |
| TRAE CLI | 计划：`traecli acp serve` | 官方安装器、已有程序与官方更新方式 | 保留实际多文件发行和 Windows 启动器；标准 configOptions、工具与恢复 |
| Command Code | 计划：`command-code acp` | 官方 npm 包或已有程序 | 参考其 ACP 会话和配置映射；官方文档也使用 `cmd` 别名，Windows 需解析实际程序，不能命中系统 cmd.exe |
| MiniMax Code | 计划：`mcode acp` | 首先接已有程序与官方安装说明；托管渠道按发布包继续确认 | 使用真实 configOptions；不从私有会话文件拼装产品历史 |

自定义 ACP 入口继续保留，不将产品目录做成执行白名单。用户填写其他可用 ACP 程序后仍可建立配置。

## 设计稿如何体现差异

- 主列表展示实际已接入项，添加窗口提供“可添加 / 全部”与名称、命令、描述搜索。二十个产品共用紧凑列表和详情结构，不堆二十套配置表。
- 支持独立安装的程序可选“由 Varin 安装 / 选择已有程序”。依赖官方安装器的程序展示“使用官方安装器 / 选择已有程序”，提供官方说明和目标设备上的程序路径。
- 产品 Logo 复用 Varin 现有组件，并在设计稿内补充 Codeg 的产品标识及明暗资源。来源和许可证见 [assets/NOTICE.md](assets/NOTICE.md)；不修改生产图标注册表。
- OpenClaw 的 Gateway、ZCode 的官方运行时、Antigravity 的配套文件等信息只在对应安装详情里出现。Hermes 明确区分官方安装与社区 npm 包装。
- DeepSeek 在添加时选择“官方 ACP / 社区桥接”，对应不同的命令、参数和版本；详情显示已选择的路线。正式实现需要独立的配置身份，允许并存，保留既有会话绑定。
- 详情页直接提供启用开关，停用列表可直接启用。安装、启用意图、实际会话连接状态分别处理。
- 本轮不提供登录、账号管理、凭据迁移或自动修改认证配置。只有执行返回认证问题时，说明应在哪台设备通过原程序处理。

## 适配落点与已知缺口

**通用部分继续由现有 ACP 适配器承担。** Cline、CodeBuddy、TRAE、Command Code、MiniMax 等先核对初始化、会话创建/恢复、configOptions、输出和工具事件、审批及取消。独立差异留在对应后端的协议解释层，避免在通用会话推进代码叠产品名称判断。

**Kiro 要补元数据映射。** Codeg 的注册信息记录了 legacy models/modes 与 `_kiro.dev/metadata`，Varin 的配置选项 owner 应从实际字段生成模型和思考选择，不在设置页写死候选。

**Antigravity 要补原 owner 的文件回调接线。** Codeg 的记录表明其工具会调用 `fs/read_text_file` / `fs/write_text_file`；Varin 当前 ACP 请求处理主要是权限与问题，并未接这些文件回调。新增能力应映射到真实执行来源的 Documents/Storage，客户端只声明已实现的能力。发行包需要连同 `localharness_external` 安装；macOS/Linux 为 `.par` 入口，Windows 为 `.exe`。Linux 的 `--uid=` 来自该发行包的启动要求，不跨平台照抄。

**OpenClaw 与 Hermes 的连接不等于独占全部后台进程。** OpenClaw 官方文档明确 ACP 连接 Gateway；Codeg 对 Hermes 记录了多个会话共享 daemon 的停止影响。正式接入需区分本会话连接、当前轮次和共享服务，沿既有进程 owner 处理，不能关闭一个会话就结束其他会话使用的服务。

**社区桥接是明确选项。** `deepseek-acp`、`zcode-acp-server` 与 Hermes 的 npm 包装分别有自己的维护者和发布节奏。参考它们的交互实现可以减少摸索；安装来源与版本仍应准确展示。codeg 的 MCP 注入、私有历史解析、登录配置写入和全局 npm 强制重装不属于本次吸收范围。

这些缺口来自具体协议和运行方式。常规 ACP 产品不需要等待所有专用扩展完成后才能交付；每个接入的能力按已实现且实际协商的范围展示。

## 源码与官方依据

- [Codeg 注册表](https://github.com/spacering-net/codeg/blob/4991406e6/src-tauri/src/acp/registry.rs)：`builtin_acp_agents` 261 起；Cline 4908、CodeBuddy 5452、OpenClaw 4841、Hermes 5306、ZCode 7124、DeepSeek 7473、Antigravity 8083、Kiro 8362、TRAE 8414、Command Code 8470、MiniMax 8685。源码中的上游运行观察按参考记录使用，本轮未重复运行所有后端。
- Varin 当前实现：[profiles.ts](../../../packages/web/application-host/lib/external-agents/profiles.ts)、[ACP 连接](../../../packages/web/application-host/lib/external-agents/acp.ts)、[产品图标](../../../packages/ui/src/components/thread/HarnessIcon.tsx)。
- [OpenClaw ACP](https://docs.openclaw.ai/cli/acp)：Gateway 桥接、连接设置与会话映射。
- [Kiro ACP](https://kiro.dev/docs/cli/acp/)：官方 ACP 接口，实际安装版本仍需核对扩展字段。
- [Command Code ACP](https://commandcode.ai/docs/acp)：CLI、会话、配置选项与编辑器集成。
- [MiniMax Code](https://github.com/MiniMax-AI/minimax-code)：官方 CLI/ACP 和安装入口。
- [ZCode 社区桥接](https://github.com/william0wang/zcode-acp)、[DeepSeek 官方 Harness](https://github.com/deepseek-ai/deepseek-harness)、[deepseek-acp 包](https://www.npmjs.com/package/deepseek-acp)、[Hermes 官方项目](https://github.com/NousResearch/hermes-agent)。
