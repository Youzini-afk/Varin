# 外部 Agent 交互设计稿

在仓库根目录运行 `bun docs/design/external-agents/preview.mjs`，打开 `http://127.0.0.1:5189`。
运行时直接引用现有 SettingsPageLayout、SettingsSection、Button、Select、Input、Switch、Dialog、DropdownMenu、HarnessIcon 和 Varin 明暗主题。

预览包含设备切换、Agent 列表与详情、添加产品、托管安装进度及失败重试、默认选项、高级启动配置、停用与卸载。顶端评审工具可直接选择场景和窄屏。数据与操作均为前端示例，不调用 Application Host，不安装程序，不修改实际账号或配置。

本次管理设计不提供登录或账号管理。认证由用户在目标设备上通过 Agent 自身完成；实际连接报告需要认证时，说明在哪台设备完成即可。安装完成只表示程序已安装，不代表已经登录或模型可用。

启用开关常驻 Agent 详情页标题右侧，停用列表直接提供“启用”按钮；更多菜单保留切换来源、卸载等低频操作。

产品支持、安装与协议边界已并入[外部 Agent 文档](../../external-agents.md)。此处保留交互评审用的静态场景；正式设置页使用相同组件，数据接入实际 Host owner。

`bun docs/design/external-agents/preview.mjs --build` 生成可直接打开的单文件设计稿 `.git/design-preview/external-agents/preview.html`。源码独立于产品入口；实际实现见 `packages/ui/src/components/sections/external-agents`。
