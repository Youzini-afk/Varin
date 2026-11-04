# 联网检索的后续验证与扩展

原设计的搜索连接、问题阅读、固定来源、typed 协作交付及可选辅助已接入。当前合同见[检索](../retrieval.md#web学术与文档材料)、
[协作](../collaboration.md)和[Host harness](../../packages/web/application-host/lib/harness/DOCUMENTATION.md)。原问题分析与分阶段方案由 Git 保留。

## 仍需实际任务判断的选择

- 默认辅助保持关闭。用用户的真实问题比较开关前后的有效来源、首次有效结果时间、主模型输入、辅助 Token 与失败恢复成本，
  再决定适用条件。固定协议测试不证明模型判断质量。
- 匿名 Exa/Parallel 已有真实请求观察，但免费额度、近期索引和中文覆盖会变化。补充精确报错、指定版本、近期变化、
  来源冲突与无结果任务的比较后，再决定新的中文/技术文档渠道和默认排序，不凭单次命中更换供应商。
- Electron capture 的网络/取消边界有隔离 fixture；有登录态的真实页面、JavaScript 复杂页面和 Windows/macOS 实机
  还需验证。被只读获取限制的交互继续使用 Browser Use，不能为提升命中率绕过原 Host egress。
- 统一搜索选择尚未包含任意第三方 MCP 工具或联网模型。新增适配器必须声明真实输入、输出、凭据归属与生成内容性质，
  并验证确实执行联网；现有 MCP 仍可由 Agent 直接使用。
- 当前来源预览支持固定原文、上下文、续读及原网站。刷新、收藏与围绕来源继续提问沿现有任务/材料工具；
  若增加直接 UI 操作，应调用原 owner，保留新旧观察和显式收藏意图，不另建来源管理数据库。

## 设计依据

系统固定来源身份、读取权限和实际执行状态，Agent 自主决定调查顺序、对照来源和组织结论。
来源相关性与可靠性不是获取成功标志。优先来源、限定范围和网络授权分别表达。
简单问题直接搜索阅读，持续调查复用已有 Agent、消息和后台任务，不新增另一套调研执行循环。

适配依据为供应商正式接口：[Exa MCP](https://exa.ai/docs/get-started/exa-mcp)、
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)、
[Brave Search](https://api-dashboard.search.brave.com/api-reference/web/search/get)、
[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。
设计借鉴 smartsearch 的渠道组织与判断/执行分离，未复制其源码。
