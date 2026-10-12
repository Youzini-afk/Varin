# llama.cpp decision 的真实准备、计算与取消

基线：`59b2d5f7`。本片接原 llama.cpp classifier 到普通 `research_decide`，复用原配置、
凭据、材料、egress、Catalog/Goal 与 SDK；没有新增推理队列、模型权限名单或收费恢复重放。
两份设计仍在实施，rerank 和其他推理用途消费者尚未完成。

## 共同合同

- Catalog **56**、wire **9**。原 InferenceBinding/Status 必需 `requestKind`：
  `preparation` 与 `model_compute` 都受原 Operation/父调用/Goal/权限/取消控制；只有真实
  model compute 登记和细化 Goal usage。准备请求不伪造零 token，也不成为未知收费屏障。
- 纯 `classifierRequestRoutes` 是协议路径唯一声明；原凭据 owner 冻结连接，Host 只消费。
  llama.cpp 沿 SDK server-root 去掉 `/v1`，使用 `/tokenize`、`/apply-template` 和
  `/completion`，明确拒绝与该协议不兼容的单 endpoint override。
- 每次实际 completion HTTP，包括 SDK retry 与概率深度扩展，都有不同的原 Operation。
  原 `tokens_evaluated` / `tokens_predicted` 是 input/output 证据，完整 timing/cache/raw
  receipt 留在 ContentStore。缺失维度不以 `n_predict`、timing 或 SDK 缺省值补齐。
- 原 SDK `Promise.all` 提前失败不等于传输停止。adapter 持有实际 fetch/body，必要时停止
  仍活动的 sibling 与后续发送，等待排空后才返回；正常完成不被清理流程误报取消。
- 普通部分失败保留已完成答案和真实零分，状态仍 failed、原候选顺序仍 `fallback:"order"`，
  missing 只列未回答项。显式 Stop/撤权抑制答案但保留真实用量和来源。

## 实际发现与最小修复

1. SDK 以全局 pending label promise 共享同模型请求。A 取消会使仍活跃 B 一起失败。
   同一原 patch 改为单次 classify 内共享，不另建缓存/分类算法。
2. 后题失败会清掉前题答案，且 tokenizer 错误可在 sibling template body 未停时提前返回。
   SDK 增量保存完成答案；adapter 按真实传输等待，不把 AbortSignal 当停止证据。
3. research score 的各问题只有 key 不同，但 SDK prompt 不含 key，实际发出的各题相同。
   指令显式带 JSON 引用的目标 candidate ID；受控响应按实际 prompt 选择答案，不按请求次数。
4. Native 接口只实现三种协议，但 Pi 原 custom classifier 是真实开放扩展点。
   共享纯 adapter 保留显式 custom implementation 的路线和原 usage，不把 Native 支持范围
   变成全产品硬限制。
5. 原 credential owner 曾在无 key 的本地 llama.cpp 到达 HTTP 前拒绝；直接 adapter 无 key
   用例无法发现。修复必须在同一个原 owner 内表达真实已配置连接的匿名绑定，保 frozen scope、
   model headers 与撤权；声明了错误 key/helper 的连接不能降级匿名，也不填假 key。
6. 重新安装真实发布的 Pi 1.0.4 后，原 MCP patch 的四个 new-line hunk offset 导致 Bun 留下
   重复 method signature。仅修四个 offset，保 MCP 行为和版本；锁定 tarball 完整性与实际
   安装的 import/原 MCP consumer 单独复核。外部 SDK 仍由原内存 loader 应用同一 patch。

## 实际组合与复跑入口

主组合仍是 `background_decision_review.rs` 和 `background-decision-host.test-helper.ts`，
连接已安装 builtin、原 extension/ToolBridge、Catalog/RunSupervisor/Goal、HostCredentialAuthority、
材料/Storage 与 egress。交付用 subprocess stdio，外部 HTTP 是受控字节，没有连接真实模型。

- 一个 keyless Llama 调用执行四次真实 compute（503、retry、深度扩展、后题）和十次准备，
  Goal 精确 36 input / 4 output；原 prompt 明确 A/A/A/B，准备不改变计费。
- 后题畸形保前题零分，原顺序/failed/missing 与 24/2 用量共同投影；output usage 缺失时
  原 Goal 阻止后续派发，只有一次实际 compute，已知 17 input 保留。
- 精确 public client/认证 route Stop 与内部 tokenizer 失败分别使并行 preparation body
  真正排空；body 尚活动时原 tool 仍 running，二者终态不混成同一种用户取消。
- 原请求、回执、结果和历史经过 GC、关闭重开保持；旧 TypeSafe/Cloudflare 取消、PDF、
  receipt-pending 与 retry 组合保留回归。
- 独审另从真实 Host credential/settings/semantic/egress/SDK 消费链检验冻结、显式撤权、
  body 后 Stop、同模型 A/B 隔离。其 recording Catalog port 仅证明 Host 合同，真实 Catalog/
  Goal 证据来自上述 stdio 组合，不互相冒充。

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test decision_inference --test goal_lifecycle --test mcp_sampling_goals
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib background_decision_review:: -- --ignored --nocapture --test-threads=2
node --import tsx --test packages/pi-host/test/credential-authority-review.test.ts packages/pi-host/test/harness/native-classifier.test.ts packages/pi-host/test/pi-sdk-adaptation.test.ts
bun run --cwd packages/web test application-host/lib/harness/research-decide.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.application-host.tests.json
node scripts/generate-kernel-protocol.mjs --check
```

最终原 decision Catalog 4 项、Goal 12 项、MCP sampling Goal 3 项通过。共享领域 24 项，
原 credential/classifier/SDK adaptation 28 项通过；原 MCP 受影响 consumer 12 项通过。
独立 Host/SDK 原合同探针 9/9 通过（56.50 s），实际源、加载 dist 和 SDK 的 7 个 hash
在复验前后相同。独审接受此有限片，没有剩余本片行为阻断。

独审初版 tokenizer 错误发生在 template 尚未发送之前，无法验证 sibling 排空；同模型
并发计数也曾错误地把独立 HTTP signal 当作调用身份。修正真实 body barrier/生产阶段后
原条件复验通过。keyless probe 的 `credential-missing` 是真实产品缺陷；后续 localhost
fixture 缺少生产 Desktop 的 `allowLocalTargets` 配置是测试装配问题，按原配置补齐，未放宽
产品 SSRF，也未尝试真实 socket。修前失败没有被计作成功。

Pi raw dist 和 source/test 类型、Host source/test 与 UI 类型、改动 lint、协议生成及
文档链接检查通过。UI 第一次类型检查读到旧 Protocol dist，沿原 build script 更新后通过，
未改 UI 合同来掩盖旧产物。fresh Protocol、Host/CLI、Web/PWA 构建，cloud layout 12 项和
production boundary 7 项通过。两份锁文件与正常 production builder 生成结果语义一致。
本轮 wire9 / 0.9.25 身份的 debug kernel 已新构建并按原 prebuilt staging 路径安装，
SHA-256 为 `0efba6ce6947e7dba2aa1db03419a6b28983f16d19fdb61335b159c2682f65d3`。
这证明同源二进制与打包布局，不是 release 性能或产品 IPC 证明。

匿名修后两条 Llama 组合（含五模式）通过（21.10 s）；最终同冻结源共享六条组合全部通过
（44.00 s），包括原 TypeSafe/Cloudflare 回归。PDF fixture 的已知字体警告不影响文本断言，
也不构成字体/渲染质量证据。

受控字节没有证明真实 llama.cpp 版本、tokenizer/template 配置、模型质量、计费或延迟。
stdio 不证明完整产品 IPC；桌面/浏览器、真实账号/安装和跨平台性能仍需外层验收。
本片未把源码追踪的全部 Policy/nested/child 组合当成新实跑；旧 Pi broker 的 observer
失败/取消投影保持既有边界。最终默认 runtime 切换、Pi 删除与资产全面迁移由用户验收后负责。
