# Agent harness — 知识与记忆归属

Status: current domain contract — 普通 Agent 笔记与 Bot 知识分别归属；沿用原 §7 编号。
Last updated: 2026-10-06

交付边界见 [status](../status.md)。本章解释数据用途，存储实现与当前依赖版本由
[Knowledge 模块](../../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)维护。

## 7. 知识与记忆

TriviumDB 是知识、计划、观察和符号图的当前存储选择，不是所有 Agent 状态的统一数据库。
普通 Agent 的显式笔记和系统指令编辑使用 Rust typed record；Bot 长期记忆使用已有 KnowledgeStore。
两者不互相隐式导入，也不因使用同一个 `memory` 工具就共享后台整理策略。

### 7.1 归属与位置

Application Host 持有异步领域 facade。权威 workspace/user/Bot 知识库在一个私有 Node storage owner 中打开，
派生 semantic/vector 库由另一个 storage owner 持有。同步原生数据库读写、查询、checkpoint 和 close 都在所属进程中执行；
Pi worker、renderer 和 Electron 主线程不直接打开这些可写库，也不存在 in-main fallback。

权威知识按 Host 和实际数据 owner 分区；普通 workspace/user `.tdb` 与 Bot/session 的安全 scope key 沿
Knowledge 模块解析。数据 owner 不等于 Documents 目录根。派生语义库保留自己的范围、向量空间与 generation 身份；
换 embedding 模型或维度只重建派生向量，不重写计划、原始知识或 Pi 历史。

一个 owner 的进程丢失会使在途结果不确定；Host 不自动重放写入或改用另一数据库。成功的权威写入等待 WAL 持久回执，
后台 checkpoint 不是提前返回成功的理由。关闭失败保留可重试状态，完整持久化和 IPC 合同见模块文档。

### 7.2 数据模型与保留

现有 KnowledgeStore 保留 event、file、symbol、session、block、knowledge 及其图关系。
字段和 mutation 形状以 [`store-contract.ts`](../../packages/web/application-host/lib/knowledge/store-contract.ts)为准，
不在设计中复制一份易失效 schema。

- event 记录实际观察；没有观察到的命令、退出或文件变化不能补成成功事件
- block 承载 plan/todo 等可编辑工作材料，保留版本和 CAS；压缩摘要属于 Pi compaction，不是知识块
- file/symbol 承载来源修订与结构关系；索引不是文件内容权威
- knowledge 保留正文、来源、有效性、取代与召回事实；模型推断不能冒充用户明确要求
- 事件保留策略与长期记忆的显式修改/遗忘分别处理；释放引用前检查实际使用者

用户层、Bot 层和任务来源保持可区分。来源读回核对原始 Pi entry、事件或 Run 报告的修订与范围；
原件缺失或改变时报告该事实，不把另一版内容当作原证据。

### 7.2.1 普通 Agent 的显式笔记

[`agent-personalization`](../../packages/web/application-host/lib/memory/DOCUMENTATION.md)拥有 global/project/session
笔记和 scoped system-prompt overrides。工具省略 scope 时保存到当前 session；`user` 和 `workspace` 分别映射到
全局和当前 project，不能越权读取其他项目或会话。

普通 Agent 不运行自动知识提议、语义召回或后台记忆整理。选段保存直接给用户可编辑原文，不调用 organizer。
下一请求按 global、project、session 装配匹配笔记和指令；项目归类、Pi 原生会话历史和用户原有文件各自保留。

### 7.2.2 Bot 长期记忆

Bot 的显式记忆与后台整理通过同一个 MemoryService 和 KnowledgeStore。Host 根据真实 Bot 注册关系选择 owner，
不接受调用方自报模式。用户启用的自动整理可提交有效 accepted 记录，无需先经过逐条提议托盘；
推断、经验和用户明确要求仍有不同来源含义。历史 suggested 条目保留其审阅入口，不恢复已退出的
`models.knowledgeSuggestions` 模型路径。

纠正、遗忘、取代和来源覆盖在原 owner 上进行。背景整理持久保存 prepared proposals 与已处理来源范围，
重启后对账，不用一次列表游标冒充完整来源覆盖。明确记忆与用户遗忘必须约束迟到的自动提议。
具体写入、选段提取、召回和原文读取合同见[记忆模块](../../packages/web/application-host/lib/memory/DOCUMENTATION.md)
与 [Bot 设计](bot-operated-workbench-design.md)；模型质量和跨日体验不能从接线或 mock 成功推出。

### 7.3 观察与写入者

Documents、LSP、Git 和用户终端沿各自真实事件产生观察，Host 校验 owner 和修订；观察失败不反噬已经成功的文件提交。
同一会话已从工具结果得到的 Agent 修改，不再伪装为新的用户编辑送回模型。

用户终端的命令、cwd 和退出事实来自本代际 shell integration 的 OSC 帧；缺少 integration 时保留 `not-observed`。
标识用于绑定观察来源，不是不可伪造的安全凭据。命令进入模型上下文前编码控制字符和标签边界，
不破坏用户已有 shell hooks，也不把 Harness `bash` 当成用户终端事件。

同一目标会话的重复观察按真实事件身份去重。普通 shell 完成通过 Harness 的环境增量提供；没有进程重附着证据时，
Host 重启不能被描述成 shell 仍在运行。逐路径编辑引用已有 Recovery before/after 对象，不复制另一份文件修改权威。

plan/todo、用户笔记和 Bot 记忆各自通过领域写入入口。后台压缩只产出固定历史范围的续接表示，不回写这些数据。
请求前环境交付、游标和历史保留见[上下文合同](harness-context.md)。

### 7.4 读取与派生检索

KnowledgeStore 提供索引、正文与图操作；Bot recall 可以融合文本和独立向量来源，按有效状态、来源修订和授权 scope 筛选。
普通 Agent 笔记直接随匹配上下文装配，不走此召回链。符号图、计划面板和背景来源查询保留各自消费者。

TriviumDB 保存向量，不生成向量。embedding/provider 配置与凭据仍由 Pi inference owner 负责；
Host 只接收去凭据绑定和结果。无向量、未配置、失效或失败不影响已有文本/图能力，也不能伪装为有效零命中。
不得把上游支持的 BM25/TQL 功能自动写成 Varin 已采用的排序路径。

语义库仍有 workspace-root 物理分片；不能把资源寻址解耦写成全部索引已消除 workspace 身份。
固定来源、草稿覆盖和持续盘点的当前边界见[资源设计](resource-oriented-harness-design.md#14-后续修正固定来源视图与索引盘点)。

### 7.5 实现与证据

依赖版本、payload cache 取舍、checkpoint 调度和私有进程协议统一由 Knowledge 模块维护。
早期数据库缺陷及版本升级经过留在决策与交付记录，不作为当前缺陷重复陈列。

知识正文、命令、文件和原始来源按用户数据对待，不进入日志、URL 或广播事件正文。
测试存在只说明覆盖入口；真实原生持久化、进程中断、平台发行和模型效果分别记录已运行的证据。
