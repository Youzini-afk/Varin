# 原成功 usage 与请求预算校准

日期：2026-10-12。基线：`0a08698b2f4df9097faa4355bc8853dd01eaf9cc`。

## 范围与原权威

[原上下文设计 §8.4.2](../design/harness-context.md#842-请求预算准备水位与原文保留量)
明确要求上一次有效 usage 加新增材料估算、按 provider 的 cache 口径计数，禁止逐步远程
token-count。运行时设计 §13.2/§23.2/§24 保留完整实际输入、稳定前缀和已有能力。本片迁移
原 Pi `RequestBudgetObservation` 行为；此前含混写成“容量错误反馈”不能扩为错误学习、
自动收费重试或另一模型产品。Catalog **62**、private wire **22** 保持。

- 原 adapter 用短 `RequestBudgetProtocol` 声明真正的 transcript 路径、同 role 最后块合并
  规则及完整 input 解释。实际选中模型和原 wrappers 转发，不让预算层另按 provider 名单猜测。
- Catalog 仅 capture 原 Run/branch/epoch、数据库位置和 ContentPublication。单次只读 SQL、
  原 request snapshot/媒体加载和完整比较在 worker、控制 mutex 外；取消沿原 token，最终
  请求派发仍必须通过原 Run/epoch 提交线。没有第二份 usage 库或历史估值缓存。
- 只选同 branch 最新 completed 且 actual input 已知的 ModelStep，允许零；失败、中断、
  未知、估量不替代成功事实。最新合格样本的配置或前缀不符就本地估算，不回找旧匹配项。
  其他 branch、压缩后的不同祖先和 policy 独立模型不能借用此 conversation 证据。
- 核完整模型/连接/凭据/配置、工具声明、instruction/memory/resource checkpoint、child
  dispatch 和 Goal 绑定；语义历史及 serializer 固定字段保持精确。仅 adapter 已声明的
  最后 content/parts 数组允许原前缀后追加，不删除字段来制造相等。
- 当前完整本地估值减去旧完整本地估值，再加原实际 input，使用有符号运算后夹到有效范围。
  结果仍明确为估值，保留未计量媒体/opaque 提示；原 raw、Goal 用量和已准备快照均不改。
- OpenAI/Google/Mistral 原 input 已包含 cache，不重复加；Anthropic 必须具备分列输入与
  cache read/write；Bedrock 用原 total 减 output；Pi 按锁定 SDK 的非零 total 优先、否则
  完整分项语义。缺必要字段、非法 total 或未知 adapter 保留本地估算。实际 provider 字段
  含义不同是当前协议语义，不是历史格式兼容。

## 两条真实失败与最小修复

1. 独审通过原 Pi Messages serializer/parser 加内存 SSE 输入复现：`totalTokens=0`，
   input/output/cacheRead/cacheWrite 为 100/3/700/100，初版误作 `0-3` 得 unknown，
   相同请求保留本地 42 而非 900。锁定 SDK 使用非零 total，否则分项。只修 Pi 的解释，
   原回执不变；正 total、缺 total、零 total 三组均 900，真全零为 0，缺必要 cache 项
   仍 unknown，五组原探针修后通过。
2. 原 Engine→Host→选中预算扩展首次真实 main 续轮失败，旧代码在增长历史末尾插入
   固定 child dispatch 说明且用 Run ID 作 item ID，导致实际前缀不成立；Google 也不接受
   用户消息之后的 system 项。修复在新请求的原 system 前缀后插入原 binding context，再放
   原 Goal 项和原有增长历史；child item 身份由冻结引用与完整说明确定。Goal 仍为 user
   级要求，普通历史相对顺序、原正文和已准备请求不改。资源 activation 在完整组装后取值。
   同一原失败用例的普通 main 与真实 Goal main 修后通过，实际 Google serializer 也接受
   该 Engine 组装输入。没有通过忽略 child 字段或提高 Goal 权限来放宽前缀。

旧摘要 fixture 原本固定给任意请求 input=10；接入真实校准后，这会合法地改变它的摘要
边界。现默认受控 provider 按该次完整请求本地大小供给 fixture actual 值，新校准场景才
显式使用 10。所有 fixture 均转发原 serializer 能力，没有为保旧断言关闭生产校准。

## 有限验收与复跑

- `request_budget_review` 3/3：原 Catalog/ContentStore、跨 Run/关闭重开、最新配置不符、
  分支隔离、失败/中断/估量、完整追加、合并 role、cache 和媒体/opaque 不确定性。
  Anthropic 接原 SSE parser，其余受控协议数据各按真实 adapter 合同解释。
- 原主链中的新用例同时执行普通 main 和真正 `runtime.startGoal` main，经原 RunAssembly、
  Engine、ContextService、Host stdio 和已选普通预算扩展，断言实际 10 加完整序列化差值、
  零多余摘要、Goal user role 和同一输入的 Google 序列化。其模型生成是受控的。
- 最后测试清理与 touched Rust 格式化后，整个原 `context_budget_review` 三项 3/3 复跑，
  同时保留已完成摘要的原配方恢复、不重复收费，以及真实 child 准入后自己的预算作用域。
  原 child binding hook 1/1 验证冻结目录与实际声明未被改变；新 runtime 三项也再次通过。
- 原 `context_job_review` 6/6、`goal_lifecycle` 12/12、`prepared_request_recovery` 12/12
  回归通过，包含摘要的 Goal 计量但不注入 Goal 指令、取消不发布、已完成摘要恢复、
  派发未知不重放、prepared 取消不读正文和 Goal 暂停/替换。
- 独审先按原设计冻结验收，再审 diff，独立运行上述 Pi 反例并复验，核原 main/Goal
  真实日志；本有限片无未关闭阻断项。未把其阅读作者日志记作独审重新执行套件。

在仓库规定工具链和已构建原 Host/SDK/broker/预算示例后运行：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test request_budget_review
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test context_job_review --test goal_lifecycle --test prepared_request_recovery
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib context_budget_review -- --ignored --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_capabilities::tests::binding_hook_freezes_model_visible_configuration_without_changing_tool_schemas -- --exact
```

上述入口逐项读 imports/hooks 后运行。Rust↔Host 使用原 stdin/stdout rendezvous，Host↔broker
使用原 Node fork/process.send；不代表产品监听 transport、实际账户/模型用量质量、远端
token 精度、桌面/跨平台安装或性能已验收。未新增请求、下载模型或切换默认 runtime。

Host 全部测试类型项目、唯一变更 TS helper 的 lint、wire 22 生成一致性和工程文档检查通过。
生产 TS 未变，本片未重复完整 Web/browser 构建；前片的构建证据仍只代表其原基线。
最终 Linux x64 debug kernel 构建通过，原 14 条非本片 warning 保留；build identity 为
`0.9.25`，wire 为 `22`。本地与 Web staged kernel SHA-256 一致：

`934c20522e995c0a3943a21e19da6069d064e865c0274a9590ef845ec082a794`

这不是 Release、安装 smoke 或性能验收。
