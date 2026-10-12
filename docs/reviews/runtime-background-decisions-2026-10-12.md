# 独立 decision：原推理、材料和 Goal 生命周期

本片基于 `41a8299f`，把原 TypeSafe / Cloudflare System One 分类器接入普通
`research_decide`。它使用实际材料与专用 decision 配置，不借主聊天模型，也不启动 Pi worker。
Native Llama、rerank 和其他辅助用途仍是后续实现；Pi 原有 Llama 路径保留。

## 唯一权威和真实消费者

- 单一 builtin declaration 生成安装 artifact、service、tool schema 和 Host decoder。
  原 extension owner 核完整调用、policy、Run/Operation、执行 owner 与接受的配置。
  `research_decide` enabled 只取原设置；没有额外工具名单、Pi session 或假文件来源。
- 原 HostCredentialAuthority / ProviderConfigurationManager 解析专用 classifier、endpoint、
  模型 headers 与凭据。headers 不从同 ID 的 chat model 借用；秘密不进 Catalog。
  冻结的配置候选与 credential scope 分开，显式停用/撤销仍拦派发。
- 原 Host semantic inference owner 保真实 transport promise；每次实际 SDK HTTP 请求，
  包括收费重试，都有原 Catalog Operation、稳定 ordinal、父工具和原 Goal 身份。
  不创建第二推理队列、Run、账本或重放整批 SDK 的恢复路径。
- Catalog **55**、wire **9**。大输入、原 HTTP bytes 与原始 usage 在 ContentStore 锁外写入，
  再原子提交短事实；GC 包含当前引用和历史结算引用。内部旧格式直接拒绝，不增迁移 reader。
- usage 在答案解析和取消投影之前保存。缺失/部分 usage 不补零；原 Goal 原子计入或一次细化。
  新请求在预算/未知用量边界停止，已在途的另一请求不因普通预算变化被误取消。
- 精确 Stop、父调用/Run/Goal 取消和 kernel exit 沿原控制事件到真实 HTTP/body。
  停止请求不冒充 transport 排空或远端没收费。工具状态、公开 Operation 与短 UI 投影
  消费原取消事实；不为取消一个推理而停止无关父 Run。
- 材料沿原 Thread/family ACL、Storage、PDF/text reader。实际 reader 的 snapshot/hash/range
  和预算后正文范围进入原材料描述；调用者 label 保留并标明来源。
  拒绝读取不伪造空正文，派发前重核原来源及派生材料权限/版本。

## 本片发现并修复的组合问题

1. 专用 classifier 模型 headers 未进入真实认证路径。现由原凭据 owner 解析实际模型，
   改动 scope 会撤销旧绑定，目录和 Catalog 不保存秘密。
2. Cloudflare 外层与 Completed 内层 envelope、score 0、缺少某候选及部分 usage 的语义
   未完整保留。现同一纯 adapter 还原原响应，不把未回答计作 0 分或免费。
3. 普通 durable event 可能在 admission ACK 前误杀尚未登记的请求，或在正常结算后误取消
   成功请求。现只登记已接受身份，消费原状态；正常终态不是取消证据。
4. 收到原 HTTP body 后内容发布失败，父工具若先完成，可能放行下一收费工作。
   原短 `receipt_pending` 在 body 尚未耐久时记录 Missing 屏障，原 Host 保留精确 body，
   仅由原 event/ready 重投发布。它不重跑 HTTP，不引入 timer。两次写入均失败时仍持原 callback。
   full receipt 先成功、短屏障后到属于幂等空操作，不回退已知事实；确切 no-send 不计收费。
5. HTTP body 已读完、settle 尚未提交时点精确 Stop，Catalog 已记取消但 Host 曾仍交付 ok。
   现 settle/status 返回原 `cancelRequested`，可信 nominal failure 把它投到工具 cancelled，
   保留原已知 usage。为阻止 SDK 重试而内部 abort 的发布错误仍是 failed，不冒充用户取消。
6. 派发后显式关闭原 decision provider，原 HTTP 已返回的答案仍曾成功交付。
   现原 receipt/usage 先耐久，再用原 provider/purpose/material 权威核交付；撤权抑制答案，
   已观测费用与来源仍保留。普通 endpoint 候选变化不替换或撤销已冻结连接。

## 有限证据与复跑

实际组合入口为 `kernel/crates/varin-kernel/src/background_decision_review.rs` 和
`packages/web/application-host/lib/kernel/background-decision-host.test-helper.ts`。
它接实际 installed builtin、extension/ToolBridge、Catalog/RunSupervisor、原凭据和 egress
owner、Storage/PDF reader；只用 subprocess stdio 交付与受控外部 HTTP 字节。

- 原 PDF 下载一次后 decision 使用提取文本，已知/畸形答案/部分 usage 进入工具历史与 Goal；
  Catalog content GC、关闭重开后正文和原 receipt 精确保留。
- 公开 client → 认证 route → 原 ControlCommands 精确停止推理；HTTP/body 未排空前不宣称停止。
  body 已读完的取消窗口保已知费用，父 Run 不受无关取消。
- 原 Cloudflare SDK 首 503 后实际重试，每次请求有独立原 Operation；首请求缺 usage 时
  下一次收费派发被原 Goal 拦下，实际 HTTP 只有一次。
- 保持 full receipt 发布不可用直到原短屏障提交，再允许精确重投；Missing 消失、实际 usage
  只计一次，没有新增 HTTP 或下一主模型派发。
- 原 Catalog 恢复/细化覆盖已派发未知、确切 no-send、foreign owner 拒绝、原回执重复幂等，
  以及已在途请求与新收费边界的区分。

组合 fixture 的首轮失败也保留其真实含义：一次 full 发布失败后，事件可先重投成功，
晚到短屏障无需制造 Missing；最终探针显式维持发布不可用直到短屏障提交。
取消窗口须同时拦住原 callback 和 reconciliation 的同 receipt 发布，才能确实让 Stop 先提交；
已确定取消的终态应按原事件身份 inspect，不应强求它仍出现在 active 集合。
这些是测试时序/查询装配修正，没有因此改变产品状态或放宽准入。

```bash
bun run --cwd packages/extension-builtins build
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test decision_inference
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib background_decision_review:: -- --ignored --nocapture
bun run --cwd packages/web test application-host/lib/harness/research-decide.test.ts
node --import tsx --test packages/pi-host/test/credential-authority-review.test.ts packages/pi-host/test/harness/native-classifier.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.application-host.tests.json
node scripts/generate-kernel-protocol.mjs --check
```

最终新增实际组合 4/4 通过（17.07 s）；原材料/分享/重开组合复跑通过（8.62 s）。
原 decision Catalog 3 项、Goal 12 项、MCP sampling Goal 3 项通过，证明新用量细化没有
改写既有 Goal 生命周期。领域 23 项、原 credential/classifier 19 项通过；独审原取消和撤权
条件及普通 endpoint 替换对照复验通过，接受本片有限范围。
Pi/Protocol、Host source/test、UI 类型、改动 lint、协议生成、Rust 格式及 docs link check 通过。
fresh builtin、Host/CLI、Web/PWA 构建通过，cloud layout 12 项和 production boundary 7 项通过。
本轮 Rust 生产已重新构建并按 wire9/0.9.25 identity 用官方 prebuilt staging 路径安装本地
debug kernel，SHA-256 为 `0df149200edbce7001fa949904aa3f08740200b96689c3e0c16863e0f7719d8c`。
这是同源二进制/打包核验，不是 release 优化性能或完整产品 IPC 运行证明。

本轮 decision 的 PolicyToolGraph、nested 和 source-less child origin/Goal/ACL 是源码消费追踪，
没有用旧 scholarly 实跑结果冒称本轮也全部组合通过。正常 Pi consumer 继续共用纯领域逻辑；
旧 Pi broker 的失败用量/observer 取消行为未由本片替换或宣称修完。

受控 HTTP 不证明真实服务账户、费用、质量、延迟；stdio 不证明完整产品 IPC。
真实桌面/浏览器/跨平台、冷启动/并发性能和长期负载仍待实际外层验收。
PDF fixture 字体警告不影响本片 text 断言，也不构成渲染质量证明。
两份设计整体未完成，默认切换、Pi 删除和用户资产全面迁移仍由用户验收后负责。
