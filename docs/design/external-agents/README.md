# 外部 Agent 交互设计稿

在仓库根目录运行 `bun docs/design/external-agents/preview.mjs`，打开 `http://127.0.0.1:5189`。
运行时直接引用现有 SettingsPageLayout、SettingsSection、Button、Select、Input、Switch、Dialog、DropdownMenu、HarnessIcon 和 Varin 明暗主题。

预览包含设备切换、Agent 列表与详情、添加产品、托管安装进度及失败重试、默认选项、高级启动配置、停用与卸载。顶端评审工具可直接选择场景和窄屏。数据与操作均为前端示例，不调用 Application Host，不安装程序，不修改实际账号或配置。

本次管理设计不提供登录或账号管理。认证由用户在目标设备上通过 Agent 自身完成；实际连接报告需要认证时，说明在哪台设备完成即可。安装完成只表示程序已安装，不代表已经登录或模型可用。

启用开关常驻 Agent 详情页标题右侧，停用列表直接提供“启用”按钮；更多菜单保留切换来源、卸载等低频操作。

[支持清单与适配依据](SUPPORT.md)覆盖 Codeg 的 20 个内置产品。添加目录支持“可添加 / 全部”筛选与名称、程序搜索，区分托管安装、官方安装器和已有程序；DeepSeek 在同一产品下提供官方 ACP 与社区桥接选择。本清单是实现目标，产品当前的实际支持范围仍以 `docs/external-agents.md` 为准。

`bun docs/design/external-agents/preview.mjs --build` 生成可直接打开的单文件设计稿 `.git/design-preview/external-agents/preview.html`。源码独立于产品入口；正式接入时复用这里验证过的组件组合，并连接实际设备及安装 owner。
