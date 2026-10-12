# 原 live-root 检索与独立 rerank 请求

基线：`1fcaf81e`。本片把 dedicated rerank 接到真实 Native `code_retrieval` 的 model stage，
复用原 Documents/Storage、检索组合、配置/credential/egress、Catalog/Goal 与 HTTP 协议 parser。
它不是新的研究工具，也未完成其他检索模型用途、材料 rerank 或两设计整体。

## 共同合同

- Catalog **57**、wire **10** 直接替换内部合同。共享 `inference-requests.ts` 负责 decision/rerank
  的真实 HTTP/正文排空与原回执发布；不保 decision-only 别名或另建推理账本。
- 既有 `harness.codeRetrieval.decision` 是模型参与选择器，`harness.rerank` 是专用连接。
  extension plan 继续选结构/语义组合。source 不调用模型；显式失效不降级其他付费模型；
  auto 保显式启用的 Explore LLM 槽和原 fast-decision 选择；当前尚未实现的 Native consumer
  明确报 unsupported，不因未实现改发另一付费模型。缺省/禁用 Explore 槽才继续已有 Native 候选。
- 普通 code_retrieval 是廉价读，没有持久父 Operation。真实 Kernel 入口从原 InvocationRunner/
  NestedTools scope 委派唯一查询身份，Host 无新建委派接口。原 HTTP child 独立保 Operation、
  ToolOrigin、FrozenGoal、费用与停止证据；scope 退出阻止新派发，不抹除迟到回执。
- 原 authorized immutable snippets 带版本/路径/行段送模型；权限和来源在等待前后重核，Rust
  最终仍从原版本字节重建正文。真实零分有效，部分排名优先显示已排名项，未评分/超原预算项
  保原顺序和 partial。没有文件 lease 跨 HTTP。
- common http-rerank 没有定义 input/output token 维度。完整 raw usage/meta 留在 ContentStore，
  不把 total_tokens 重命名为 input，也不造 output=0；实际收费请求沿原 Goal Missing 屏障。
  协议特定的已知计量仍需单独完成，不能把受控响应的总 token 当作已核账单。

## 实际跨层证据

`retrieval_inference_review.rs` 和 `retrieval-inference-host.test-helper.ts` 使用实际 Catalog、
RunSupervisor、KernelToolExecutor、原 source grant/Storage/compute、Documents、安装后的
extension plan、HostCredentialAuthority 与 semantic inference。仅 request/frame delivery
替为 subprocess stdio；原 KernelClient grant/token 和公开 client/认证 route 均实际执行。
外部 rerank 响应由受控 egress 提供，没有调用真实付费 provider。

- rank 模式验证原三份授权文件实际进入请求，未授权 private 文件不进入；C/A/B 排名保 A 的零分、
  缺 B 的 partial。原模型回合结果、HTTP child、Goal Missing、GC 和关闭重开一起验证。
- source 和当时显式尚不支持的 fast-decision 模式（当前共享夹具改为仍未接的 llm）均零 HTTP，保原检索结果与真实可用性。
- 模型等待中修改文件，最终 Rust 不交付旧版本段，也不把新正文贴上旧 revision。
- Stop 通过 application-client → 认证 route → ControlCommands。HTTP body 尚活动时保 child
  pending 与 Goal pending，真正排空后才结算停止证据；已取消的查询不能复活 source history。

初次取消请求返回 400 是共享 stdio driver 只连接 operation.cancel、遗漏 run.cancel；补接
同一个原 ControlCommands 后才进入实际取消业务。随后真实复现 Run 终态屏障拒绝仍活动的
HTTP child，报 `foreground operation is unsettled`。最小修复在真实 query scope 准入时，
沿既有 handed_off 表达外部 child 已接管，仍保 Lifetime::Run；原 decision tool-parent
不改变，全局 foreground gate 不放宽。原 Run 取消、恢复、Goal、历史 active 查询与 GC
不忽略该 child。修后两项实际组合（五模式）23.62 s 通过；上述修前失败不计成功。

独审从实际 HostCredentialAuthority/settings/semantic/egress 消费链另外复现并要求收口：

1. 删除原 rerank 设置（UI Off）后旧 lease 仍可新外发。按同一 selection reader 记录明确
   Off 的撤权代；已观察 Off 的旧 lease 不能在重新启用后复活。正常或畸形新候选不自动退休
   原已接受连接，真实 provider/credential 显式撤权仍由原 owner 负责。
2. 非空文档收到 `results:[]` 被当部分成功。用途级的同一评分验证同时约束 receipt 解释和
   结果投影；该响应保完整 raw/Missing，但标 invalid_response/model failed 并保原来源顺序。
   通用 parser 不禁止合法空输入，部分评分与真实零分仍有效。
3. auto 未看显式 Explore LLM 槽，可能转发到低优先 rerank。实际旧 producer 是原 slot →
   completeExplore → reserveForJudge；Native 尚无该消费者。现使用共享 slot parser/resolver
   保留用户显式选择并报 unsupported，不创建假 LLM 能力、第三份模型目录或新的权限限制。
   本项是有限配置语义对齐，没有声称重跑完整 Pi session 或实现 Native LLM judge。

## 复跑入口与边界

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib retrieval_inference_review:: -- --ignored --nocapture --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib background_decision_review:: -- --ignored --nocapture --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test decision_inference --test goal_lifecycle --test mcp_sampling_goals
node --import tsx --test packages/pi-host/test/credential-authority-review.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.application-host.tests.json
node scripts/generate-kernel-protocol.mjs --check
```

最终同冻结源，新 rerank 两条实际组合（含六模式）通过 29.47 s，原 decision 六条组合
通过 52.10 s，覆盖共享准备/计费 retry、真实 body 排空、发布失败与迟到回执。原 Scope
四条、decision Catalog 四条、Goal 十二条及 MCP sampling Goal 三条通过；retrieval/domain
四十九条、终态 Run 仍可精确 Stop 的共享 UI 八十一条通过。真实 credential owner 整文件
十三条与 shared rerank/classifier 十五条通过；新的真实 settings/lease 合并用例通过。

独审原三反例与八个对照共十一项复验通过（37.65 s），五个源码/dist hash 前后相同。
独立 Host 探针使用真实配置/凭据/egress/model stage，但录账端口只证明 Host 合同；真实
Catalog/Goal/GC/重开与 public Stop 由上述 stdio 组合证明。源码复核另确认 query handoff
不跳 Run/Goal 取消或恢复、scope 退出阻新外发、精确旧 owner 可结算迟到回执和 GC 历史 roots。
未做活跃 query 崩溃后真实外部 provider 续接实验，不把源码核验称为该项实跑。

初次 Pi 合跑出现目录 cleanup ENOTEMPTY（26/27），原失败单例与最终相关整文件已重跑通过；
初次 boundary 文件误用 Vitest，未进入 Node 测试，按原 Node runner 重跑七项通过。
cloud layout 十二项通过。修前失败均保留在证据记录中。PDF fixture 的已有字体警告不是
字体质量证明，kernel 的十四条原未改域 warning 未作为本片新错误掩盖。

Protocol/Pi raw dist、Host/CLI、Web/PWA 与最终 Host raw 重建通过；Host source/test、Pi、UI、
CLI 类型、改动 lint、协议生成、文档链接及 diff 检查通过。正常 production builder 校验
锁文件语义不变，打包的新 rerank export 与实现同时存在。fresh wire10 / 0.9.25 debug kernel
按原 staging 路径核 SHA-256：
`4bf9ec4a91c68e785c7172058ce020f03bc16a56c0e4c22cb8d6dd36b6ab808f`。
这建立同源编译与布局证据，不建立 release 性能结论。

受控 stdio 不证明完整产品 IPC、真实 provider/model
质量、价格或延迟；固定/物化/远端检索、其他模型用途和全部平台仍按各自未完边界保留。
用户仍负责最后验收后的默认 runtime 切换、Pi 删除与资产全面迁移。
