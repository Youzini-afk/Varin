# 原查询 embedding 与统一推理会话

基线 `a000fa18a550e1b60ef9528af8e22cafdb6f8230`。本片是完整 SourceView 语义检索的
计量与生命周期前置合同：native query embedding 接原 Catalog/Goal，同一查询的语义、
decision、rerank 和 Explore 共用原会话。非 live semantic 仍显式 unsupported；本片不
把已有 live 索引当作固定来源的覆盖。Catalog **58** 保持，私有 wire **14** 直接拒旧。

## 原执行 owner 与消费者

- 原 `createRetrievalOwner` 从 model-step、policy-action 或 nested-call 的真实 origin 与
  toolCallId 派生调用身份；一次 `assertFresh` 后由同一 `InferenceCall` 分配全部实际
  请求 ordinal。原 source producer、Documents/grant、extension selection、PipelinePlan
  与 Rust 末端版本/正文重建不变，没有伪 ModelStep、第二查询任务或并行计量库。
- query embedding 使用原 purpose 配置、冻结 HostCredentialOwner、egress 与共享
  OpenAI-compatible serializer/parser。实际 HTTP 沿原 inference admit/dispatch/settle，
  正文和原 usage 保在 ContentStore。维持原零自动重试、无付费准备探测和无静默后端切换。
- 原 semantic storage ledger 只保后台 index-build；删除其 native retrieval-query 写读
  合同与 retrieval response 的重复 receipt 字段。旧内部 query 记录明确拒绝，不迁移、
  清空或作为 fallback。后台原 no-send/unknown/overlap/WAL 恢复语义保持。
- 缓存沿原空间、用途、实际编码文本，并增加捕获的 credential-scope 分区；命中仍核
  当前 source/binding/账户授权，但不产生新 HTTP Operation 或零用量伪回执。原已存在
  请求阻止恢复时重发付费工作，普通缓存不是绕过原会话恢复门的权限。
- 原始 usage 先于向量有效性结算；`prompt_tokens` 可计 input，`total_tokens` 不被改名
  为 input，缺失 output 不补零。原 output-budget Goal 会在未知用量后阻止下一次实际
  派发；该下一步可以已受理，保留真实 not-dispatched 事实，不从历史中抹掉。
- query observer 结束时关闭新 scheduler 准入；已开始的原 HTTP/body/receipt 留在原
  session 直到实际排空或已持久化未知屏障。Kernel generation 仍由原监督执行器负责，
  Host 不另造终态裁判。取消可以先停止 source 交付，不能以观察结束证明远端没有收费。

## 原组合与复跑

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::retrieval_inference_review::semantic:: -- --ignored --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::retrieval_inference_review::llm::semantic_decision_and_explore_use_one_query_session_with_contiguous_ordinals -- --ignored --exact --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::background_decision_review::llama_stop_or_failed_tokenizer_drains_parallel_preparation_without_model_charge -- --ignored --exact --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::background_decision_review::failed_receipt_publication_blocks_following_paid_work_then_refines_original_usage -- --ignored --exact --test-threads=1
node --import tsx --test packages/pi-host/test/harness/openai-embeddings.test.ts
```

原 stdio 组合使用真实 Storage、Documents、tree-sitter/compute、scan/chunker、semantic
store publication、设置/凭据、extension composition 和 Catalog/Goal；HTTP provider bytes
由内存 transport 控制。不是直接塞一个 SemanticHit，也没有新建监听 socket。
查询词与源码仍有重合，本片重点断言实际请求、Operation/Goal 与恢复，不单独证明
仅靠语义才能召回的新增材料、每条最终 snippet 或新来源的向量覆盖。

新语义组 **2 passed**，84.34 s。正常组实际覆盖 semantic+rerank 同会话、预算门拒下一
HTTP、非法向量先记 usage、缺 usage、cold 零 HTTP、warm 新 invocation 不再付 embedding
费用、换凭据重新请求七种配置。Stop 组公开取消后原 HTTP body 被故意持有，原 Goal 仍
pending；释放真实 reader 后按 missing/indeterminate 结算，Catalog 关闭重开保原事实。
正常组重开也核原 tool history、全部 inference Operation 与 Goal usage 不变。

原 semantic+TypeSafe decision+Responses Explore 渐进 fanout **1 passed**，18.45 s；
实际三个用途落同 parent、连续 ordinal，模型只处理其原被分配的职责。此验证使用原
Responses serializer 和 classifier，不能推导任何真实模型质量或费用结果。

共享 llama SDK 并行准备失败/取消排空 **1 passed**，16.55 s；原 receipt ACK 丢失、
后继付费门与原 usage 细化 **1 passed**，9.52 s。它们是原公共 owner 的故障回归，
并非声称新增 embedding 单独跑完所有丢 ACK、进程强杀与恢复窗口。

纯 Host focused **11 passed**，45.56 s；含真实 index ledger 的 completed 复用、换账号
拒复用、未知重叠、WAL 无 close 重开、no-send 恢复与并发 resume。首跑一个 fixture
清理遇 ENOTEMPTY，按同模块现有目录清理重试修正后复跑；未为该清理竞争改变生产语义。
新语义组首次预算断言也曾失败：它错误认为没有 HTTP 就没有受理 Operation，现已按
实际 admit/dispatch/receipt 三个事实纠正，保留了原 no-send Operation。

共享 Pi embedding wire 原用例 **6 passed**，覆盖重试、backoff 取消、长 Retry-After、
返回排序/维度/非有限值和 provider 拒绝后的原自适应拆分；native 本片仍零自动重试。
Host source/tests types 与变更 TS lint 通过。

## 收尾与证据边界

独立受控端口探针覆盖 query callback 先正常返回、先抛错两种实际早退：同 session
保持到 held body 排空，晚到 request 与同 parent 重开被拒，owner close 不提前完成，
迟到实际 usage 只结算一次。另一条探针沿真实 SemanticInferenceLease.consume 和原
InferenceCall 保留 total-only 的原 `total_tokens=13`，input/output 均 null；凭据只到
受控连接，不进入持久请求/回执。这些是 owner 端口证据，与前述真实 Catalog 重开区分。

独审核共同 source/inference/恢复合同、上述真实组合与三条独立窄探针，本片无剩余行为
阻断，接受此有限范围。Rust 收尾只做标准格式化；生产 `tools_retrieval` 去空白文本
不变，测试另有两个可选尾逗号、两个等价 map 闭包块。没有把格式变更当新业务用例。

共享 protocol、Host 声明/实际 bundle 和 CLI 构建通过；协议生成校验为 wire 14。
Linux x64 debug Kernel 以原 build identity `0.9.25` 重新构建、正常 stage，SHA-256 为
`00507663bfc596de2f5747b9d48341e81e9624a2f392b1613f9f6817ebb95fe7`。
正常 cloud builder 更新并冻结核验原 production lock，Host production boundary **7**、
cloud layout **12** 条通过。首次 layout 命令误指不存在的 root Vitest 配置，未执行用例；
按 root 原脚本去掉该多余参数后真实运行。debug 构建与这些检查不构成性能或完整产品
启动证据；既有 Rust warnings 保持。

上述 native 组合是测试 stdio 与受控 provider bytes，未运行旧产品 socket semantic
套件、真实账户、完整 Host IPC、跨平台或性能负载。旧 socket fixture 已迁到新内部合同，
类型通过不算其业务测试通过。固定/物化 semantic overlay/publication、完整 LSP 依赖
闭包与远端一致来源继续在后续实现；用户验收后负责默认切换、Pi 删除及全面资产迁移。
