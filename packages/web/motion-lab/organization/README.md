# 会话导航交互设计稿

在仓库根目录运行：

```sh
bun x vite --config packages/web/motion-lab/vite.config.ts
```

打开 `http://localhost:5199/?scene=organization`。顶部可切换工作台、Bot、IDE、浅深主题及窄窗口。

复用产品的主题系统、图标、AgentAvatar、BotFigure、ChatTimeline、ThreadComposer、菜单、对话框、输入控件、Toast、FlipList 及选中／悬停动效。会话、分类和模型配置使用本页示例数据；创建、移动、撤销、改名、置顶、归档只更新预览状态。API fixture 不连接实际 Host。

导航行、目录选择器和 Bot 工作详情是供讨论的新布局。IDE 编辑区仅提供排版背景，未接入 Monaco。正式产品入口与组织业务逻辑保持现状。
