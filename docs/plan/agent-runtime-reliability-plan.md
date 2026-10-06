# 运行时可靠性：剩余验收计划

Status: active acceptance plan — RR0–RR5 已有实现与既有定向证据；剩余工作是 RR6 的安装包、真实代理与平台纵切。
Last updated: 2026-10-06

[当前状态](../status.md)给项目概况；本页只安排尚未闭合的场景。
RR 的原始问题、修复批次与当时测试记录在[交付日志](../archive/harness-delivery-log.md#运行时可靠性专项-rr-叙述自-status-迁入同日)，
取舍在[运行时决策](../decisions/runtime-reliability.md)。本次整理没有重跑这些验收。

## 当前合同

RR2 的可变会话操作目录、镜像与 CAS，以及 RR4 的持久 queryScope，已被 D-337 的
[任务/资源模型](../design/resource-oriented-harness-design.md)替代。不得为完成旧计划恢复
`work_context`、旧 writer 或目录型存储归属。操作固定本次 cwd/target 和授权资源身份；
跨根查询、草稿与分支读取沿现有 Documents/WorkingState authority。

RR1 的恢复/停止、RR3 的执行/输出和 RR5 的出站网络合同继续有效：

- 恢复读取权威状态，不重发 prompt、工具或有副作用的操作
- 停止请求、受理、实际终止与结果未知分开；旧 Run 回执不能清算新 Run
- 已受理执行保留可查询身份；准备、运行、完成和启动失败不混为一态
- 代理、DNS、TLS、策略拒绝和取消保留各自事实；不以关闭安全保护换取成功
- Pi、Host、Rust 与 Documents 保留原有权威，不引入第二运行时或双 writer

具体实现从 [Harness 模块](../../packages/web/application-host/lib/harness/DOCUMENTATION.md)、
[客户端同步](../../packages/ui/src/lib/pi-runtime/client.ts)、
[出站传输](../../packages/web/application-host/lib/harness/egress.ts)和[安全设计](../design/security.md)进入。

## RR6 尚待取得的证据

每次选择与实际修改、目标构建和可用环境相关的场景，不把整张表变成每个小改动的固定门禁。

| 场景 | 需要建立的事实 | 当前证据边界 |
| --- | --- | --- |
| 安装包流式会话断线与恢复 | 无重复执行；历史、usage、工具结果和 idle 追平；仍在输出时无空洞或旧正文回闪 | 既有真实 socket/Store 证据不代替安装包工具调用 |
| 停止与断线/新 Run 交错 | requested、accepted、settled、unknown 正确收敛；无永久截流或旧回执污染 | 需要对应平台和当前安装产物的纵切 |
| 当前资源模型的跨目录操作 | 本次 cwd/target、文件、LSP、检索与授权身份一致；邻项目和私有来源不被误写或泄露 | 按 HR 合同重写场景，不验证已移除的 work_context |
| shell 与输出恢复 | heredoc/注释/语法错误后下一条命令可用；回执丢失后按原身份取得真实输出与退出码 | PowerShell 5.1、跨平台已打包会话及 kill/恢复仍缺相应记录 |
| 等待预算与慢准备 | 到期返回可追踪 preparing/background；不伪造 running、不无故杀命令 | 局部计时不能外推线上固定延迟 |
| 多项目检索与草稿 | 真实范围、来源修订与 partial/unknown 覆盖可见；未保存草稿和混合写入域不丢失 | 规模、跨根草稿与结果不明操作按[HR 边界](../status.md#尚待补充的运行证据)分别验证 |
| 真实出站代理 | 当前 Electron/Node Host 的有效代理路径可用；取消、DNS/TLS/代理失败准确；目标策略仍生效 | 受控代理测试不证明真实 fake-IP、系统代理或外部部署 |
| 安装与平台集成 | 正式程序启动、当前组件装配及对应能力正常；必要的重启只为应用更新 | 历史启动 smoke 不证明全部用户操作链 |

## 验收记录与完成条件

新证据记录在相应[验收记录](../reviews/README.md)，至少包含：

- 被验证的 commit/构建、平台与连接/代理方式
- 实际入口、场景、命令或可重复步骤，以及观察到的结果
- 失败、跳过、未运行和未知分别记载；说明是否覆盖真实 Host/Pi/WS、安装包或外部 provider
- 仍需行动的具体合同和下一步，不用测试数量替代覆盖判断

若发现产品缺陷，沿原 owner 修复并复验受影响消费者。不能运行某个平台时保留该场景，
继续独立可验证的工作。RR6 只有相应场景被实际证据闭合才完成；没有真实 provider 调用就不报告质量、成本或缓存收益。

## 执行边界

遵循 [AGENTS.md](../../AGENTS.md)和[开发指南](../development.md)，命令以相应 package.json 为准。
跨目录故障验证使用隔离夹具，保留用户文件、Pi 原生历史和 Git 现场。
本计划不构成发布、部署、修改真实代理/证书/凭据、关闭安全保护或写其他项目的授权。
