# Native Explore LLM 与原联合选材

基线 `419bec4f`。本片将 Native live_root code_retrieval 接入原 Explore 模型职责。
Catalog **58**、wire **11**，仍使用既有 inference ledger、ContentStore、Goal 和 query owner。

## 共同合同与所有权

- 原 codeRetrieval 和 Explore slot/default/Off 继续决定角色，实际 Host model/credential owner
  冻结配置。明确不可用不偷偷改另一付费模型；不继承主聊天模型或主历史。
- 原 Pi 的 prompts/parser/规划/完整渐进联合选材循环移动到 protocol 唯一纯模块，Pi 与
  Native 通过各自原 query port 消费。保留 replacement、retained、required group、显式空选、
  失败保前选、原序列等待和容量；没有固定轮数上限。
- auto 原职责保留：LLM 规划与联合选材、ready classifier 独立判断原 action。一次 query
  session 分配所有真实请求 ordinal；classifier 摘要只取自己这一批实际回执，不混入并发 LLM。
- 新生成在原 inference Operation/ContentStore/Goal 中，不加第二任务或用量库。query 的
  External delegation 是调用证明，真实原生模型 Operation 的执行 owner 是 Kernel。
  HTTP 路仍由原 External 执行者结算；公开 Host 方法不能伪造 Kernel 派发/回执。
- Rust model_session 原 adapter 与私有 CredentialBridge 执行 tool-free 辅助请求。snapshot、
  provider items/opaque/events/raw usage 锁外持久化；短控制记录只指正文。原用途与 ToolOrigin/Goal
  保持，不伪造 PolicyBoundary、MCP interaction、ModelStep 或附加对话 Run。
- 原 source/issued view/Documents/grant/revision 约束外发和交付。模型的 plan/search/locate
  继续进入原受限 query executor；最终 Rust 从实际字节重建，required group 不能在最后
  版本检查或正文预算处变成残组。
- cheap query 可取消退出，真实原生生成须实际停止才有停止事实；迟到 receipt 保原归属。
  重启保 checkpoint 的原计量/未知维度，不自动重放潜在收费请求。

## 已确认的有限修正

抽取原消费者时发现非空但完全无效的 groups 曾被 parser 过滤成 `[]`，可能错误清掉
前轮有效选择。最小修复只将该畸形答复判 invalid；真正 `groups:[]` 仍显式清空，混合
合法项保持原容忍。真实 Pi tool 的前选保留/明确清空两条对照已覆盖。

独审从实际已捕获模型绑定出发，将有效 settings 文档重置成 `{}`，发现旧 Explore 仍发送
三次生成；删除 slot 已正确禁止，却漏掉了删除整个 harness 父节。修复只将合法缺省父节
当成空配置，拒绝新生成；畸形候选与正常换模型不替换原已接受绑定。原失败条件复验为
零次 LLM，仍合法的 classifier 完成两批及原 symbol/read 动作；两角色各自 Off 不相互禁用。

另一条实际准备窗口反例：显式 `llm` 解析原模型期间，只将未参与的 FD 改 Off，旧校验却
拒绝本次检索。只把 FD 准备依赖限定到 `auto`，保留 LLM slot、codeRetrieval 和原身份校验；
没有引入第二配置世代或放宽同时选中角色的冻结条件。原条件修后 LLM 正常选材，FD 零调用。

同一 query 可能在第一 ordinal 注册凭据前失败、第二 ordinal 才实际入账。恢复检查现在
读取原 ledger 的所有精确父项，不以 ordinal 1 是否存在猜测；没有另建 session 表。
既有原恢复用例已改用第一项缺失、第二项存在的真实 Catalog 情形。

## 验收入口与证据

共享原 `retrieval_inference_review` / `retrieval-inference-host.test-helper`，新增
`retrieval_llm_review.rs` 使用原 native adapter/parser 与私有凭据桥，只有外部 HTTP 字节受控。
实际 Catalog/RunSupervisor/Storage、Host 配置、原 query/action/选择、public Stop 与最终历史
沿同一条真实消费者链；单独 Host 录账替身不作这些事实的证明。

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib retrieval_inference_review:: -- --ignored --nocapture --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib background_decision_review:: -- --ignored --nocapture --test-threads=2
node --import tsx --test packages/pi-host/test/harness/explore-model.test.ts packages/pi-host/test/harness/explore-tool.test.ts packages/pi-host/test/harness/explore-host.integration.test.ts
```

首个完整冻结的真实检索组合五条测试、十七个模式通过 127.78 s。两处独审修正后，
复用同一 Rust 测试二进制与最终 Host 源码，新原生 LLM 两条、七模式再次通过 51.53 s，覆盖原 plan/联合选材、auto classifier、显式空选、
后批失败保前选、required 成员在最后 Rust 重建时过期、未知用量与公开 Stop 实际排空。
原 research_decide 六条真实组合再过 46.71 s；原 MCP 双重审查采样一条、四场景再过 9.04 s。
这些保留实际 provider parser、Goal/历史/GC 和原准入。原 Catalog 两项 native owner/checkpoint
与四项 HTTP recovery 通过；原辅助规划/采样 Goal 回归二十项通过，另一个原人工 Catalog wait diagnostic 仍 ignored，不算通过。

共享 Pi/protocol 原消费者三十六项通过；Host 六个原 query/loop/pipeline/rerank 文件六十五项
通过。最终 Host source/test 类型检查与刷新后的 protocol/Pi、Host/CLI 构建通过。独立探针使用
真实配置/credential/query/Documents，受控生成端口不代替上述 Rust 计量、原回执与 GC 证据。
独审接受本片有限合同：原两条失败条件修后通过；另核双角色 Off、已选模型失效、冻结替换、
后答替换/显式空/无效保前选及 required/重叠组预算。一次探针预期 FD key 改动不影响 LLM，
实际原凭据 owner 的整份文件 revision 已变，LLM scope 合法失效；纠正探针判断，没有为假问题
改产品 owner。首轮 FD 探针错误设置已派发也只修夹具，原失败不计为产品缺陷。

fresh protocol/Pi、Host/CLI、Web/PWA 和正常 production cloud builder 通过，production lock
语义未变。cloud 中 Pi 与 Native 均导入唯一共享模块，旧 Pi 重复模块不存在。layout 十二项、
production boundary 七项、协议生成与文档检查通过。新 Linux x64 debug kernel 的 wire 11、
build identity 0.9.25 与实际 staged/cloud 字节 SHA256 一致：
`5486e47316d32126590bba2181d9382cf5070928d88118f8a2ee83630e622f8b`。
这是 debug 编译与布局证据，不是 release 性能测量。已有十四条 Rust warning、PDF fixture
字体警告与 Web chunk 警告保留；未运行含产品 IPC 的 Pi session-e2e，仅更新其共享 import。

当前不宣称完整产品 IPC、真模型/账号、质量/账单/性能或平台验收。固定/物化/远端来源、
其他领域用途及两份设计剩余能力仍分别推进；最终默认切换、Pi 删除和全面资产迁移由用户负责。
