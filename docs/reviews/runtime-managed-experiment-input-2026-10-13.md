# Managed Source 实验输入

依据[运行时设计 §22](../design/agent-runtime-design.md#22-多环境远端与平台)和
[能力组合设计 §5.3](../design/runtime-extensibility-design.md#53-环境是一组相互一致的能力)，
补齐从来源 Host 捕获 Experiment 输入的消费者。实验执行机器仍由原 Experiment backend 选择。

## 实现

来源端 B 在原 Storage 固定输入，支持实时目录、固定分支修订和原有物化工作副本。私有输入分支、
原创建回执及 `experiment.input-capture` 记录保留 principal、协调 Host、authority、epoch、Source、
Run 和 Operation。B 不创建第二个 Agent Run 或 Experiment attempt。固定来源保持原 pin 到清理，
来源读取 grant 保持原权限，内部记录和分支由独立的同 Operation Storage grant 写入。

协调端 A 通过封闭的 admit/capture/read 服务获取清单和分页字节。Storage 按长度与 SHA-256 安装
实际对象，完整分支 root 必须与 B 一致，再交原 Experiment spec、物化和执行流程。
A 的输入保存来源身份，`sourceRoot` 为 null，B 的路径不参与 A 的文件解析。
传输复用派生的固定目录查询；实际字节读取仍核原 grant 和分支路径。

失败区分 B 的创建与 A 的输入创建。取消先排空真实请求和读取，再清理 B 的原分支、pin 与记录；
A 独立上传 grant 退休时由 Storage 清掉流和临时对象 owner。丢失创建回复按原回执恢复，
清理命令在派发前保存确切 Operation ID，丢失删除回复查询该回执，失败事务可重新清理。
来源 Host 重开后沿旧地址维护原输入，不重新获取项目读取权限。普通 Run retirement 保留
caller-owned 输入，明确退休该来源才释放。Host 管理 grant 的名字也改为实际 Host generation，
修复同进程重开不同世代时的身份冲突。

## 实际证据

本轮未新增或修改提交的测试文件。复用相关用例，并在忽略目录 `artifacts` 下执行双内核探针。

| 范围 | 结果 |
| --- | --- |
| live / fixed / materialized → A 安装 → 原物化器 | 通过；含中文、emoji 和 400,000 字节的多页文件 |
| A 同名路径、B 捕获后变化、重复取得原捕获 | 原输入 root 和字节保持一致 |
| 捕获完成后注入丢回复、第二页传输时取消 | 未发布 A 输入，B 原 authority 退休 |
| 原生删除实际完成后注入回包丢失 | 原清理 checkpoint 恢复，无不同 grant 重用参数冲突 |
| A Storage 重开 | 按原候选和创建回执恢复同一个输入 root |
| B Storage/Host generation 重开、项目 trust 撤回 | 原地址清理与重复清理通过 |

探针执行真实 Rust Storage、Source authority、生产 ManagedSourceService、SourceQueryService、
ResearchSourceAuthority、上传及物化器。A 的 Run/Launch/Operation getter、B Documents/trust
准入受控；客户端直接调用 B 服务并经过生产响应解码器。它没有产品 HTTP listener、完整 Catalog
Experiment submit，也不是两台物理机器或实际网络断线验收。

探针和原始输出在 `artifacts/managed-experiment-input-probe.ts`、
`artifacts/managed-experiment-input-2026-10-13.log`，不提交。原 Source/工作区/生命周期用例 28 项，
原 Experiment/认证路由用例 40 项通过。Rust debug kernel 构建通过，保留已有编译/链接 warnings。
Host production/tests 类型、改动文件 lint、实际 Host bundle 和 diff 检查通过。

交互 PTY、持久脚本、项目 MCP/日历配置、跨 Host 组合恢复和完整平台/网络验收仍在总实施清单中。
