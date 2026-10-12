# 原来源的 hover、symbols 与 call hierarchy

基线：`307322f7ef135a7f200e7016a6ffe06ceaf67194`。本片完成有限实现与真实来源组合复验。
Catalog **58**，私有 kernel wire **17**。独立设计/行为审查接受本片，无剩余已发现行为阻断。完整两设计与外层产品验收仍未完成。

## 有限能力与同一 owner

新增 `language_hover`、`language_symbols`、`language_document_symbols`、
`language_call_hierarchy` 四个普通只读 Source 工具。工程 symbols 的 path 选择语言、
query 搜索工程，保持已有 Pi symbols 的含义；文档 symbols 保留层级树。
call hierarchy 用原文件位置与 incoming/outgoing 方向，一次查询完成准备和关系读取。

旧 definition/references/diagnostics 名称与显式用户工具数组保持；发行默认从原 Rust
声明目录获得新能力。没有 Host/UI 的第二份 grant 或工具名称表，不把当前配置目录当
查询 cwd，也没有扩展调用可以选择任意 LSP method 的新入口。

Run 仍沿 SourceQueryOwner、LanguageViewBinder、LanguageSupervisor、LanguageBridge
与原 Rust executor，消费 live_root、fixed_branch 或 materialized 的实际来源。
固定来源的派生物理工程、shared preparation、原 Run 引用、最后进程排空与资源回收沿
[固定工程视图合同](runtime-fixed-language-2026-10-12.md)，没有新进程或 Source owner。
原 whole-project source scope 保持；service context 不授予 Run 更多路径。

## 新结果形状的来源与生命周期

- Hover 保留原 kind/value 内容及可选 range。没有 range 就不制造一个。Markdown 链接
  是语言服务返回的文字，不执行、fetch 或视为已授权文件读取。
- DocumentSymbol 的合法无 URI 节点继承原查询文件；WorkspaceSymbol 的显式 URI 必须
  映射到原 scope。越界或不可映射的 URI 不被删除后改绑成查询文件。子节点逐项保留
  自己的资源、range 与 selectionRange，实际遗漏明确投影。
- Call hierarchy 的 opaque provider item 只存在于本次原 supervisor 查询的局部内存，
  不进入模型、历史或重开句柄，也不清空 editor/knowledge 的共享 token 表。
  每次后续 RPC 前重核本次 Run 权限和取消，并保原 provider/session/view/document 世代。
- 关系以 `{from,to,fromRanges}` 表达。incoming 的 site 位于 caller；outgoing 的 site
  位于 prepare 返回的真实 item 文件，可能不是输入 path。Rust 按这份 from 文件校验
  UTF-16 范围，不能用被调用文件或输入 anchor 的字节冒充。按
  [LSP Position 合同](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/types/position.md)，
  输出列号超过已有行长时用该行末尾位置；仍不接受不存在行或反向范围。这是原协议解码，
  不放宽模型传入的工具位置，也不推断新的计算版本。
- 原 Rust 后验共享一次查询的文件 observation cache，但 hover、树和关系分别做有限
  投影，没有任意 JSON 递归授权器。每个资源自己的 observedRevision 是真实读取事实；
  跨文件计算没有版本证据时 rangeRevision 仍为 null，不升级为 provider 已计算该版本。
- 真空结果、unsupported、malformed、stale 与取消保持区别。已提交内容由原 ContentStore、
  工具历史或原 Policy graph 节点回执持有；重开读原内容不重放语言请求或 opaque items。

## 组合验收入口

本片扩原 Rust → Host → 捆绑 TypeScript 真实组合，而非把旧 TypeScript stand-in 的
固定符号输出当产品结果。受控部分是模型/策略决定与 stdio 测试传输；实际文件/分支、
managed process、LSP 字节、授权、回执、GC 与重开仍用原 owner。

- 原 fixed 主链在不同 live 工程、同 revision 共享、另一 revision 隔离及重开新查询中
  消费四种新结果；captured greet 调用 decorate，新 revision 改为真实无函数调用实现。
- 同一 fixture 的 materialized 与 live_root 场景验证真实工作副本/磁盘；文档 Shelf.invoke
  提供嵌套符号。捆绑 TypeScript 对 import alias 的 call prepare 实际可返回空；测试消费
  前一真实 definition 的声明位置继续查询。单独的原 JSON-RPC provider 探针检查
  prepare 目标不等于输入文件时的调用位置归属，不把受控 peer 算作另一次真实 TS 结果。
- 默认 Retrieval/Worker child 沿原 dispatch/freeze/handoff 独立运行并保存新结果与报告。
  Worker 的完整 Host code-result settlement 仍不是这个 fixture 的证据。
- Policy ToolGraph 在同一真实来源执行新方法，然后通过实际 ReadResult 分块消费原结果；
  只读可重放节点由原 graph receipt 持有结果，不新建重复效果 Operation，
  也不伪装为模型 tool-call/tool-result 历史。

最终同版本五条真实场景 **5/5** 通过（45.36 秒）；上述进程使用新 wire 17 的已构建
二进制，不调用付费模型或用户电脑。其他有限证据：

- 原 Host/Pi/knowledge 六文件 **70/70**；改变后的 Host tests 类型与 lint 通过。
- Host production/types、CLI 类型和 cloud-runtime 构建通过；发行布局 **12/12**、
  Host production boundary **7/7**。stage 与 cloud 二进制同为 wire 17，
  SHA-256 `efb9c735393bcfde5818812bba3b553b0506dfb49fd70032bf85fc41ba529198`。
  构建/布局不替代产品 IPC 或全平台启动。
- 原默认/显式 child 目录 **6/6**，原窄 source grant 拒绝语言后端准备 **1/1**；
  Rust 输出范围合同 **1/1**，原 language bridge **4/4**。
- 独立原反例：provider 切代、合法 dot-prefix 文件映射均失败后修好；原 query 取消、
  prepare 目标跨文件关系 site，以及晚到 watcher 成功/失败不覆盖新绑定探针通过。
- 新 Policy fixture 初版误假定每个只读节点必须有 Operation，结果消费后断言失败。
  修正为既有 replayable graph receipt 权威，再验证真实 ReadResult、服务停止、GC 与
  重开后的原节点正文。生产没有为满足测试添加重复效果账本。
- 排查时另一个旧 native-process helper 试图监听产品 IPC，受环境拒绝且未进入 TS；
  该次无验证价值，未重试。上面的真实结果均来自已有 Rust stdio 验收链。

复跑指向新 wire 17 的构建二进制：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  language_source_review -- --ignored --nocapture --test-threads=1
```

## 真实验收发现与最小修复

1. 原 Host initialize 没声明客户端 callHierarchy，捆绑 TypeScript 按真实客户端能力
   不开启该功能。补原声明后由服务器自己报告支持，未伪造 server capability。
2. 独立探针用同 view 的不同 provider、碰巧相同 generation/documentVersion，复现
   A prepare 的 opaque item 被下一 RPC 送给 B。后续请求绑定真实 prepared providerId
   和 generation，原反例返回 stale 且 B 不收到旧 item。
3. 原 Run 准入拒绝曾落入 RPC 失败分类，使共享语言 session 被标 degraded。准入/fence
   与 RPC 错误分类分开，仍在原 active/readers finally 内，其他 Run 不被伪服务错误污染。
4. 捆绑 TS 的 module caller end 列号包含行末偏移。旧 Rust 严格列号检查将其误丢为 stale；
   原 Position 合同要求按行长解释，修复使用原已授权文件字节规范化列，而不是改测试
   接受假 partial、修改 provider 结果或放松路径准入。

5. 合法文件名 `..inside.ts` 曾被父路径 prefix 检查误拒，workspace symbol 的显式位置
   又降级成查询文件。父路径按真实路径组件判断；任何显式 location 映射失败都明确
   遗漏，仅无位置的真实 document symbol 可继承。独立原反例已复验，不增加别名或兜底。

6. 新 CH 消费真实打开 util 后，materialized 文件改写暴露既有 provider 缓存接缝：
   原 watcher 确有 didClose 与 watchedFiles，捆绑 TS 却仍发布旧 import 诊断。修复将原
   source reader 已读到的新正文先按同一 Host 版本发送 didChange，再关闭回到磁盘；
   不能用延时重试或伪清诊断替代。异步读只处理自己捕获的旧 open，较新绑定不被覆盖；
   fixed/editor 的原 owner 不受此路径影响。原 materialized 失败链修后通过；独立探针
   对迟到旧正文与迟到旧读取失败均确认新版绑定未被覆盖或关闭。

## 尚未由本片证明

原 nested-tools 的目录/执行合同已有独立证据，本片新 rich language shape 尚未经完整安装
扩展的 runtime.tools.invoke 组合复验，不能用声明可见性冒称其实际执行。其余 editor-only
查询、编辑候选/写入命令、草稿、远端映射、全 provider/平台/产品 IPC 和大工程成本分别保留。
两份设计整体未完成，最终默认切换、Pi 删除和全面资产迁移仍由用户验收后执行。
