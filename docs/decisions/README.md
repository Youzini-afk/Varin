# 决策日志

Status: historical rationale index — 条目正文追加记录，索引负责定位。
Last updated: 2026-10-06

决策解释“当时为什么这样做”。当前行为和完成边界分别查[架构](../architecture.md)、
[领域设计](../design/README.md)与[状态](../status.md)，不从旧条目的状态推导当前产品能力。

## 按领域查

| 分卷 | 范围 |
| --- | --- |
| [基础与治理](foundation-governance.md) | 基础契约、测试治理、产品身份与交付政策 |
| [工具与环境](tool-environment.md) | Shell、输出、工具、设置、等待与可组合执行环境 |
| [上下文与知识](context-knowledge.md) | 观察材料、压缩、知识、模型槽位与召回 |
| [权限](permissions.md) | 原生权限与插件共存边界 |
| [检索](retrieval.md) | Explore、语义索引、快速决策及 Web/科研检索 |
| [结构与符号图](structure-symbol-graph.md) | Tree-sitter、结构采集、符号关系和 LSP |
| [工作状态与线程](workingstate-threads.md) | Thread/Run、协作、Integration、恢复与代码提交 |
| [Rust 内核](stage-r-kernel.md) | Stage R 的职责迁移与验收 |
| [科研集群](research-cluster.md) | 研究工作台、能力路由、实验与资源 |
| [运行时可靠性](runtime-reliability.md) | RR 与 HR 任务/资源模型替代 |

## 按编号查

[完整追踪索引](index.md)保留 D-xxx 的日期、主题、替代关系和历史回写位置。
原来入口中的长表已分离，不再要求读者先读整份追踪台账。D-116–D-119、D-180、D-181
是既有空号，见 D-132；不为补齐编号而创建决定。

## 记录方式

涉及持久取舍时，在相应分卷追加原因和影响；需要更正已有判断时，引用旧编号追加新决定，
不改写旧正文。日常操作日志和每次测试输出不必各自成为一个决策。可使用原有格式：

```text
### D-<编号> · <日期> · <主题>
类型：偏离 | 实验结果 | 问题与解法 | 默认值调整 | 待问
决定：采用的选择。
原因：依据，以及为何不选主要替代方案。
影响：需要同步的实现、契约或计划。
状态：当时的实施或待处理状态。
```

更新[追踪索引](index.md)即可连接到分卷；索引不是不可变的决策正文。
旧记录引用 Agent Harness §5–9 时，到设计目录的 tools / retrieval / knowledge / context /
verification 专卷按原节号查找。历史阶段细节见[计划快照](../archive/agent-harness-plan-2026-10-06.md)。
