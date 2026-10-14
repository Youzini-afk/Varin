[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | 简体中文 | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 为 Varin 贡献

欢迎改进运行时、桌面与远程端、扩展、文档、无障碍和平台支持。本文介绍公开贡献流程。
仓库规则见 [AGENTS.md](../../AGENTS.md)；环境、命令和验证方法见[开发指南](../../docs/development.md)；
模块职责见[架构](../../docs/architecture.md)。

## 开始之前

- 阅读[行为准则](CODE_OF_CONDUCT.zh-CN.md)。
- 先搜索已有 Issue 和 Pull Request，避免重复工作。通过
  [GitHub Issues](https://github.com/Youzini-afk/Varin/issues) 报告可复现的问题、提出功能建议和技术讨论。
- 按[安全策略](SECURITY.zh-CN.md)私下报告漏洞，避免在公开 Issue、Pull Request、日志或截图中泄露利用细节。
- 较大的产品或架构改动，应尽早讨论预期用户结果和影响范围。必要时用原型澄清具体设计问题。

## 实现改动

修改前阅读负责该行为的实现、实际调用方和最近的 README 或 DOCUMENTATION。保持改动聚焦，
保留无关工作，沿用既有代码风格和共享 UI 组件。

原生 Rust Agent runtime 是产品的会话与执行所有者。Thread/branch 历史、队列、Run 和 Operation
由 Catalog 管理；可信 Application Host 提供模型、凭据和领域能力。按实际职责归属修改，避免把状态
复制到另一层。保留历史 Pi 资产，不导入这些资产，也不恢复备用运行时。

通过公开接口集成扩展，保留插件自己的配置和数据。特权操作由可信 Host 执行，不能放到渲染器中。
按涉及的能力阅读[安全](../../docs/security.md)和[扩展](../../docs/extensions.md)说明，
不要记录凭据或用户私密内容。

过时的内部格式无需兼容读取器或自动迁移机制。不支持的存储必须保留已有资产。工作区文件、
Git 历史、Pi 原生数据和外部配置仍属于用户资产；当前格式的持久性和恢复要求仍然适用。

## 文档

代码、类型、schema、测试和包脚本确定当前行为；文档解释职责、机制、约束和有价值的设计理由；
Git 保存历史。行为变化时更新对应的当前说明。[文档入口](../../docs/README.md)用于定位所属文档，
进行中的设计和计划按 [AGENTS.md](../../AGENTS.md) 处理。

面向用户的公开文档、仓库首页 README、贡献指南和安全策略以英文为源语言。修改事实、命令、
安全建议或链接时，同步适用的已有译本；本地化根文档保留语言导航。

主工程文档使用中文，源码旁和包内文档沿用既有语言，无需另建平行译本。
公开文档的语言约定不改变工程文档的约定。

## 验证

根据改动影响的行为和调用方选择检查。具体命令查最近的 `package.json` 和
[开发指南](../../docs/development.md)。

优先复用有效的已有检查。保护重要行为或可复现故障时补回归测试，不要求每次改动都新增测试。
删除过时或重复的检查。共享协议需要实际调用方的证据，打包与平台行为需要相应运行环境；
仅通过类型检查不能证明这些行为。

UI 改动可用截图或录屏验证相关布局、主题和状态；性能结论应有代表性的测量。
说明实际运行了什么、哪些仍未验证。出现新失败或尚未解决的风险时，再扩大验证范围。

## 提交与 Pull Request

提交标题简洁说明改动。Pull Request 说明问题、改动后的行为、相关验证和重要限制；
职责归属或外部协议的变化有助于理解时一并说明，详细程度与工作相称。

更新分支时不要重写其他贡献者的工作。解决冲突时核对预期行为和状态归属，避免机械选择某一侧。
保留用户无关改动，不使用破坏性 Git 清理。

问题报告、文档改进、翻译更新和平台实测也都是有价值的贡献，请附上相关环境与复现步骤。

## 许可证

提交贡献即表示你同意相关内容可按 Varin 的
[GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）分发，
导入的第三方内容仍保留[第三方声明](../../THIRD_PARTY_NOTICES.md)要求的声明。
