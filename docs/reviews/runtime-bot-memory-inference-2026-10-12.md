# 原 Bot 记忆整理与选段推理

日期：2026-10-12。基线：`534a9afca6e55f13030267e6222d667a6b792ee3`。

## 有限范围与原权威

[运行时设计 §24/§25](../design/agent-runtime-design.md#24-完整能力替代清单)要求保留
Bot 独立身份、记忆及睡眠/恢复，并将领域工作接入统一 Operations；
[原模型槽位](../design/harness-context.md#85-子-agent模型槽位与模型切换)已经明确
`models.memoryOrganizer` 服务 Bot 整理和显式选段。这里接这两个已有消费者及原可选
`memory-organization` classifier，不新增普通 Agent 自动抽取或通用后台记忆产品。

**本片尚未迁移 Bot 主会话入口、native 来源/召回/checkpoint，以及完整 native Bot
主任务/child/Computer 的 Sleep 链。** 原 Pi 会话和资产继续存在；后台推理接线不能当作
完整 Bot 或两设计全部完成。Catalog **63**、private wire **23** 直接替代旧内部格式。

- BotService 仍独占身份、归档和 activity；原设置/HostCredentialAuthority 决定可用模型与
  凭据。自动整理保留明确的 Bot profile fallback；选文沿原独立槽位，禁用不能暗回退。
- 真正的 MemoryWork Thread/branch/Run 和非工具 parent/stages 归 Catalog；generation
  与可选 classifier 使用原 inference ledger、派发边界和完整回执。没有假 Explore、
  ToolIntent、借用源会话 Goal，或另一付费请求账本。后台分支不能经普通会话入口执行。
- ContentStore 保存整个不可变 batch 配方：原排序/索引、精确来源范围与 revision、
  presented targets/CAS、prompt 和模型/output 配置。Knowledge 只保存 work 引用、
  prepared proposals 与 coverage；MemoryService 仍是唯一记忆 mutation owner。
- 原成功输出先于 prepared 持久化。恢复用原配方解释原输出，不用今天的模型、来源排序
  或候选重解释旧 `u0`。已写记忆/未 ACK coverage 按原 proposal provenance 结算。
  classifier 恢复沿原 SDK wire/answers 解释，不能因重启把原否定变成 keep-all。
- generation 仅原 `Stop`、非空有效文本及合法来源引用能形成提案；截断、坏 JSON 和
  消费失败保留原 text/raw/usage。消费拒绝不把成功 provider receipt 改成失败或 no-effect。
- 网络重试、同一选区重渲染和并发观察复用原 requestKey；成功结果可再读，仍过当前交付
  gate。明确 Retry 仅在原本地执行停止后建立关联的新 attempt，原 Unknown 仍保留并告知
  费用可能未确认。自动整理不得重发已经派发的 Unknown；未排空只允许继续观察。
- Sleep 先关闭原准入，再通过短 IDs/status 取消原 Run，依据原 InferenceStatus 等实际
  本地排空。大 recipe/output 缺失不能阻止控制取消；完整读取仍诚实失败。Wake 仅在原
  generation 可证未外发时 Resume，同一已完成 decision 和历史取消/回执保留。

## 真实反例及修复

1. 独审复现 Sleep 在 generation 未外发时取消原 Run，Wake 只清本地 gate，原范围永久
   被保留。新增原 owner 的 typed Resume，仅重开安全的 no-send generation；不重放
   Unknown，也不丢掉已经付费完成的 decision。
2. 独审复现旧 entry 的 Unknown 每次扫描刷新同 session 失败时间，使后来新 entry 永远
   到不了读取/准入。改为先按已覆盖/已保留的精确范围收集；仅同 sourceKey 应用 backoff，
   同错误不刷新时间，旧 work 不覆盖另一批 prepared/progress。原反例修后可接新 entry，
   旧 Unknown 仍保留。
3. 独审复现 registry 含任意 archived Bot 时，零工作也因准入校验阻断整个 Host shutdown。
   原工作查询/停止与新执行准入分开；逐 scope 尝试并聚合失败，移除原订阅。Host 先停
   organizer producer，再关 semantic inference；两者的停止/待提交回执错误都进入原汇总，
   不因共享推理 owner 的第二次失败跳过其它 owner 清理。
4. 真正模型/凭据链暴露对非 reasoning 模型硬传 `minimal` 的错误。现在由原 model owner
   决定默认配置，保留普通非 reasoning fixture，不通过伪造模型能力绕过失败。
5. 真正选文重复请求暴露 TS 属性顺序与 Rust JSON 排序不同导致同来源误冲突。claims 用
   结构相等保留全部字段和数组顺序，实际 range 改变仍拒绝，不删除身份字段。
6. 控制检查发现 Sleep 先读完整配方/输出。新短 status 仅复用已有 InferenceStatus，
   不增持久状态权威；原完整 reader/GC 的缺内容错误不被吞掉。
7. 实际 Knowledge 子进程重开暴露把 `knowledgeRevision` 持久化进配方的错误。它原本
   是当前 writer incarnation 的短期 fence，同数据重开也会变化。配方删除该字段，
   每次准备只捕获本次活跃 writer 的 revision；恢复仍靠原来源、冻结目标 CAS、proposal
   provenance 和 writer 内忘记/去重约束。不创建另一份持久版本，也不改旧 epoch 凑相等。

源码核查也撤回了没有真实入口支持的“现存 Bot 会话转给另一 Bot”设想。现有删除入口
清 entry 后删原源，历史 Run/event 保原归属；不为假想转移新增名单或重复准入限制。

## 验收记录

已完成的有限行为证据：
- Catalog 七项覆盖真正独立 Run/无 Goal、精确范围准入、关闭重开与旧 epoch fence、
  已派发 Unknown 不重放、原配方/输出/用量与 consumed、no-send Wake 和明确关联 Retry。
  消费完成并从 pending list 消失后执行实际 ContentCollection sweep，再关闭重开仍精确
  恢复原 recipe/output。这部分实际关闭重开 Catalog；受控 receipt 不冒充真实 provider。
- Rust↔Host 三项组合通过。第一项经原 BotService、model/credential authority、原
  Responses adapter 和 Knowledge 子进程，覆盖自动整理、实际配置的 advisory decision、
  选区 preview/重复/并发、明确 Save 及已完成结果仍受 disable gate 约束。取消时移除原
  recipe manifest，完整读取失败，但短控制仍取消原模型；受控 transport 未 release 前
  Sleep 不完成，实际本地排空后才 asleep，原 partial event 与 Unknown 事实保留。
- 第二条真实组合在完整模型输出已持久化/尚未 prepared，以及 classifier 已结算/尚未
  保存材料决定处重启 Host。使用同一原 Knowledge 存储子进程边界，原 work、配方与
  inference 完全保留；改变今天的 Bot 模型不重发旧请求，原否定判断恢复为 reviewed-empty。
  此组合重启 Host/Knowledge，Catalog 保持运行；不能把它描述成同时重启全部进程。
- 第三条真实组合让原 Responses 返回 `Length` 且正文恰是合法完整 JSON。仍拒绝 draft，
  保留原 items/raw/finishReason/usage；同 key 不再发请求，明确新 key + retryOf 才建立
  第二次请求，旧 child receipt 深相等。没有将消费失败改为免费或未派发。
- 原 organizer 领域测试 32/32，实际 MemoryService 与 TriviumDB engine；原 inference
  结果使用明确 seam。包含 first write 后 Sleep 不再执行第二 proposal、原 provenance 与
  prepared 范围保留。这不是 native transport 的替代。
- Dialog DOM 10/10、实际认证 direct Router 7/7：request identity、rerender/关闭、
  原来源验证、typed retry disposition、preview 与明确 Save 分离。旧 Supertest 文件只
  更新合同和类型，未执行。
- 独立探针覆盖 original success/disable、Unknown 本地停止/未停止、samekey/changed
  range，以及原 pinned llama SDK 的八条受控 wire transcript 恢复。未发网络请求。
- 独审四处反例均修复复核；当前 writer 局部 revision 修复后，上述真实重开反例以及
  原 late-forget/prepared correction 测试原断言再次通过。没有把阅读整合日志称为独审
  重新运行 Rust 套件。

第一次整合还纠正了三处 fixture：首次实际创建应为 201；Host 重开时原事件要在测试
bootstrap 完成后交原消费者；Responses delta 必须包含真实 item_id。失败日志不计通过，
修后同一业务链复跑，未放宽生产校验。

在仓库规定工具链和已构建原依赖后运行：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib catalog::memory_work::tests -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib bot_memory_ -- --ignored --test-threads=1
cd packages/web
node node_modules/vitest/vitest.mjs run --config vitest.config.ts application-host/lib/memory/memory-organizer.test.ts application-host/lib/memory/selection-memory-routes.direct.test.ts --maxWorkers=1
```

入口及 imports/hooks 分别只读预检后执行。Rust↔Host 为原 stdio rendezvous，
Host↔Knowledge 为原 Node fork/process.send，模型仅替换出站 transport 的响应字节，
另一个 classifier 经原 egress owner 的受控 fetch。没有产品 HTTP/Unix listener、
真实 provider 账户、模型质量/费用、Desktop/跨平台安装或性能通过的结论。

完整 Web aggregate 类型检查通过，包含 Host 声明/全部测试、browser 和 CLI。最终
Host 生产构建/测试类型、变更 TS lint、协议生成与 Web browser/PWA 生产构建通过；
原 cloud stage 验证 frozen production lock 和布局，未生成/发布 Release。新测试 helper
按原 production boundary 排除，不进入 Host 发行树。工程文档检查通过，Web 保留原
大 chunk warning。
Linux x64 debug kernel 已按 build identity `0.9.25`、wire `23` 构建并通过原脚本 stage；
原 14 条非本片 warning 保留。本地与 Web staged kernel SHA-256 相同：

`76ae24552c2dc03b710b33953e9af88358b25f5b8f9e1d732e46fee6dca70694`

这不是 Release 或安装 smoke。完整 native Bot 及两设计其余能力继续按真实消费者推进。
