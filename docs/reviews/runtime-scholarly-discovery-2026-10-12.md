# 学术发现：原服务与普通执行入口

本片范围是 OpenAlex / Semantic Scholar 的原只读 metadata 服务接入普通 Native 工具。
不包含 fast-decision/rerank 的独立推理与 Goal 计量，不替换 Pi 或切换默认 runtime。
实现基于 `21edb3a6` 后的原材料集合 owner；产品/平台与真实远端质量验收保持独立。

## 唯一入口和生命周期

- `RESEARCH_DISCOVERY_TOOL_DECLARATIONS` 同时生成 `varin.builtin.research-discovery` 的实际
  manifest/artifact、`varin.research.search@1` 服务、`research_search` schema 与 Host decoder。
  `research.discovery` 只接原 `research-search.ts`；没有第二套模型、引用图、cache 或结果库。
- 原 extension owner 核当前 policy、完整调用、Catalog Run/Operation、接受的 owner/config，
  再进 capability。启用配置仅来自原用户与可信 project 的 `harness.tools.research_search`；
  接受后按原冻结 binding 执行。无文件来源也不制造物理 workspace、grant 或 Pi session。
  无关 Web/auth 设置不是 scholarly owner 的权威。
- 调用只取一个请求页，不夹断用户 limit、不自动续页。真实 provider 限制/HTTP 错误显式返回。
  OpenAlex 搜索与 citations 保 provider cursor；references/related 保原 source、relation 与
  列表 offset。S2 graph 的 related 明确 unavailable，不伪装空结果。
- HTTP 失败等待原 body cancellation；成功响应等待原 body reader。取消后不启动依赖的第二请求，
  callback 真正结束后才报告 stopped。错误/畸形/合法空页/可缺省字段各自保语义。
- paper identity 与 open-access location 仍是 metadata。只有明确选择 URL 才沿原 egress/material
  producer 下载；原 collection、Storage、PDF/public reader 各保自己唯一权威。外部标题/摘要进入
  普通工具结果，没有新增系统指令或权限入口。

## 原失败条件及修复

独审先在旧原 owner 建立反例，再用同一探针复验：

1. OpenAlex 第一次搜索缺 `cursor=*`，无法得到真实后继；现第一/后继页按原 cursor。
2. S2 非数字 cursor 静默当第一页；现派发前拒绝不合法/不安全整数 offset，零请求。
3. `{error:...}` 搜索、缺 paper identity、缺 relation list 被返回成功空；现缺必需 envelope/identity
   显式失败，合法 null/缺省 abstract/year/author ID 等仍接受，计数 0 与数字 CorpusId 保留。
4. 首次 relation 响应正文仍在读时取消，结束后又发第二 HTTP；现检查原 signal，无后继请求。
5. 非 OK HTTP 的未结束正文被遗弃且调用先结算；现等待原 `body.cancel()` 完成，无 observer race。

未增加任意请求上限、额外 fallback、工具授权名单或为了假设问题扩张校验。

## 有限跨层证据

实际新增组合入口：
`kernel/crates/varin-kernel/src/scholarly_discovery_review.rs`，Node peer 为
`packages/web/application-host/lib/kernel/scholarly-discovery-host.test-helper.ts`。

它使用实际 installed builtin、Catalog/RunSupervisor、原 permission/ToolBridge、原 egress owner
和 Rust Storage。只有外部 HTTP 字节及模型下一动作受控，交付使用 subprocess stdio：

- root 两 provider 的 search/paper/relation 数据、OA 原 cursor/列表续页，真实结果回模型。
- 原 PolicyToolGraph read 与只选 scholarly 的 source-less child；child 保原冻结 declaration。
- 原 deny rule 经过同一实际 retained lease，provider 请求计数不变。
- paper identity 明确加入原 collection 但不假造 snapshot；明确 URL add 才产生一次 PDF 下载。
- `document_read` 与实际 public client → authentication route → 原 reader 读取 text/PNG。
- Catalog content GC 后保完整 ToolResult；Host 进程与 Catalog/Storage 关闭重开，历史精确不变，
  原 PDF 仍可公开读且零 metadata/PDF HTTP。不是 Rust OS 进程崩溃注入。

首轮 fixture 故障由 Catalog 正确拦下：测试没有安装已冻结的 dispatch 目录，以及随后试图
重绑不同目录。最终 fixture 保原 declaration/generation/BindingPreparation，未改产品准入。
另修复复用 fixture 对多个工具未按实际目录排序，以及未携带原模型 configuration/credential
scope 的测试装配错误；真实 BindingPreparation 保持原完整身份校验。

独审还运行原 Pi tool → HostServicesBridge → 同一个 service → 受控 fetch → 原 formatter，
验证 `paper_id` 映射、关系两页、S2 unavailable、外部标题转义与原结果身份；实际打包 manifest
和单声明一致。取消原条件在 owner/native-domain 探针验证，本新增 Catalog 整链没有注入取消。
本轮未实跑 scholarly nested；通用嵌套入口只有继承证据/源码复核。

## 复跑

先按开发文档准备锁定依赖并构建 `@varin/extension-builtins`：

```bash
bun run --cwd packages/extension-builtins build
bun run --cwd packages/web test application-host/lib/harness/research-search.test.ts application-host/lib/kernel/research-discovery.test.ts
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel scholarly_discovery_review:: -- --ignored --nocapture
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.application-host.tests.json
node --import tsx --test packages/pi-host/test/harness/research-search-tool.test.ts packages/pi-host/test/harness/select-tools-web.test.ts
```

本片不改变 Rust 生产协议/格式；Rust 新代码只是 cfg(test) 实际组合。
最终实际新增组合通过（7.03 s）；原 owner/adapter 定向 25 项、Pi 消费者 17 项、独审同条件探针、
完整 Host source/test 与 builtin 类型、改动 lint 均通过。fresh builtin/Host/CLI/Web/PWA 构建、
cloud layout 12 项和 production boundary 7 项通过。Rust 生产未改，继续沿用上一材料阶段
已核 wire9/0.9.25 staged kernel；本片没有以重复编译证明额外平台能力。
复用 fixture 改动后，原材料集合/分享/丢回应恢复与原 Web/PDF/public reader 两条实际组合分别
复跑通过（7.39 s / 7.56 s）。独立审查接受本片有限范围，无剩余生产阻断。
PDF.js fixture 标准字体警告仍在，text 与 PNG 签名验证不等于字体渲染质量验收。
受控响应不能证明真实 provider 的可用性、账户限额、质量或延迟。
完整产品 IPC、桌面/浏览器、平台与性能未由 stdio 验证；原环境访问限制保持。
模型驱动只验证实际调用/结果配对，没有运行真实 provider serializer/system-prompt 质量验收。
两份设计整体尚未交付，最终全面迁移仍交用户验收后负责。
