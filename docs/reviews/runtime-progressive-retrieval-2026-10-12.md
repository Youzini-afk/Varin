# Native 检索的原渐进 fast-decision

基线：`4ff94efc`。本片复用原 ExploreQueryRun / runExploreFastDecisionLoop，将真实材料判断
与已签发后续动作接入 Native live_root code_retrieval。没有另写最终片段打分器冒充渐进检索。
Catalog **57**、wire **10** 保持；原 query delegation、HTTP child、Goal 和 ContentStore 权威不变。

以下是该基线当时的结果；后续 Explore LLM 与共享 session/逐请求回执合同见
[Explore LLM 增量](runtime-explore-llm-2026-10-12.md)，不把后续实现倒记为本片证据。

## 共同合同

- 原 codeRetrieval selector 与 fastDecision explore/default/Off 决定是否参与。source/rerank
  仍走自己的既有路径；auto 显式 Explore LLM 槽继续报 unsupported，完整 LLM consumer 未在此片实现。
  已显式选定但失效的 classifier 不偷偷切另一付费模型。
- DecisionInferenceLease 只有 `run`，其 session 的 `decide` 可完成原查询内多个顺序批次。
  一次请求 session 持续原 HTTP ordinal，包括 SDK 准备、retry 和多批计算；assertFresh 只在
  session 入口检查。原 research_decide 单批消费者同步使用该合同，没有旧 execute 别名。
- 每批用量来自该批原 receipt 切片，不能重复累加前批；loop 汇总不把缺失维度补零，真实零值保留。
  Catalog 独立逐 HTTP 计费，已知 input/未知 output 与整条 Missing 分开，原 Goal 阻止后续收费。
- 已选 model stage 明确分 snippets 与 progressive 两种执行形状，不是第二模型设置。后者在
  run.finish 前调用原 loop，原 source progress/issued actions/selection/followup 继续唯一。
  quiet、原取消或真实配置 deadline 结束，不新增固定 round 上限。
- query owner 将模型材料回查原 issued view、snapshot、修订和行段，前后复核原 grant/Documents。
  合法结构片段仍用原切片表示，不重建第二 parser。模型回包只回答已询问 ID，不能提供文件、
  命令或扩大来源权限。最终正文仍由 Rust 从实际版本字节重建。
- 普通成功批的 missing/false/0 不当 yes；没有正选时保原 source pack。失败批不应用答案或执行
  动作，只保其真实 usage/missing/raw 事实并停止；前面成功批的 selection 留在原 query。
  明确取消/撤权不复活交付，HTTP 排空和迟到回执仍独立于廉价查询退出。

## 实际消费者与验收

共享 stdio 夹具现按职责命名为 `retrieval_inference_review.rs` 与
`retrieval-inference-host.test-helper.ts`，保留前片全部 rerank 路径，不复制另一套 Catalog。
原 KernelClient、Catalog/RunSupervisor、Storage/compute、Documents、安装的检索组合、
Host credential/settings/egress 和 SDK 实际执行；外部 provider 只用受控字节。

- seed 的实际代码发出 hiddenHelper symbol 候选；模型选择原 action 后，原 followup 读取
  原签发的 helper read，读取另一份实际文件，新材料触发后续 HTTP 批次。模型附送的未询问 private 路径 ID 无权执行。
- 每个收费请求的 ordinal、owner、ToolOrigin/Goal、原结果、GC 与关闭重开共同核对。
- 首批只有 input 用量时，后批不得产生第二次外发；已确认 input 留存，output 明确未知。
- 后批失败保先前成功选择、真实费用和失败状态；精确公开 Stop 时 query 可结束，而 held
  HTTP body 与 Goal pending 要等原执行端真正排空后才结算。

首轮测试将 partial Actual receipt 误断为整条 Missing，导致断言失败。原记录实际是
input=7/output=null、第二 ordinal NotDispatched。按既有 Goal 的分维度计量修正测试预期，
没有更改产品计量来掩盖失败。第二轮测试把第 2 HTTP 当成必有 helper 正文的批次；
持久原请求表明它合法地先询问新发现的 helper read。夹具改为选择这个实际签发 action，
仅在材料真正到达时注入失败，不按 HTTP 序号猜查询进度。两次原失败记录保留。

## 复跑与边界

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib retrieval_inference_review:: -- --ignored --nocapture --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib background_decision_review:: -- --ignored --nocapture --test-threads=2
bun run --cwd packages/web test application-host/lib/harness/explore-fast-decision.test.ts application-host/lib/harness/research-decide.test.ts application-host/lib/harness/retrieval-pipeline-review.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.application-host.tests.json
```

最终同冻结生产源码：共享实际检索三条测试（十个模式）通过 62.52 s；原 research_decide
六条实际组合通过 57.24 s，覆盖原 TypeSafe/Cloudflare/llama.cpp、准备/计费 retry、Goal、
发布失败、PDF 材料和公开取消。这些使用真实 Catalog/RunSupervisor/Storage/历史/GC/重开，
不是 Host 录账替身。kernel 十四条已有未改域 warning 与 PDF fixture 字体警告仍保留。

聚焦 loop/research/pipeline 三十五项通过，原 rerank Off 用例首次合跑超时，独立重跑通过
4.27 s；累计三十六个不同用例通过，不把初次超时改写成成功。独审另有十一个真实 Host
探针通过，关键五个源码 hash 前后相同：原配置、SDK、egress、渐进 action、逐批计量、
Off/凭据撤权、失败与实际 body 排空。其录账端口不充当 Catalog/Goal 证明。独审 body
初次夹具 finally 重复 enqueue 清理失败，只修外部夹具后单例通过 4.91 s，原失败日志保留。

Host 完整 source/test 类型检查、改动 lint、diff 和文档链接检查通过。fresh Host/CLI 及
正常 production cloud builder 通过，锁文件语义未变；cloud layout 十二项与 production
boundary 七项通过，协议生成检查通过。Rust 生产代码、wire10/Catalog57 与 UI 未修改，
沿用前片已核 debug kernel 和 Web/PWA 构建，不虚称本轮重建整套平台。

本片不证明实际外部模型质量、账单或延迟，不证明完整产品 IPC、平台或账号。
Native LLM 检索规划/联合选材、固定/物化/远端来源和其他设计余项仍分别推进。
默认 runtime 切换、Pi 删除及全面资产迁移由用户验收后负责。
