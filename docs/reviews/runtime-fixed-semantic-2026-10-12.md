# 固定与物化来源的语义候选

基线 `c8435ca4cf12474770cec9a6ca3ea81441d341a3`。本片把原 native query embedding
归属合同接到实际 non-live source-vector 生产，不要求先有 live 命中。实现为原 immutable
publication 的保留基底、完整 mask 和 query-owned transient extras；不是新的持久分支
索引，也不声称原工作副本是整库原子快照。Catalog **58**、私有 wire **14** 保持。

## 原生产与消费链

- `createRetrievalSourceOwner` 沿原 Documents 注册/信任、Run grant 和精确固定 revision
  或 managed copy。固定枚举使用原树元数据，物化枚举保每个实际文件 revision。索引集合
  按注册路径身份交集，不 realpath 旧 live 目录，不把集合选择变成第二权限。
- 原 `unitsFixed`、grammar recipe 与 tokenizer-aware packing 生成真实块。捕获的 reader
  只有 exact document/revision/recipe/space 匹配才可保留；新 pinned metadata/vector
  方法都读同一个 token。所有不属于该来源的旧行都被遮蔽，范围在 Top-K 之前收窄。
- 原 store owner 支持无文件的 empty backing，冷 view 不复制整库、不替换 writer 的
  latest publication。实际准备在第一次 semantic search 才开始，同查询共用一次准备，
  基础关键词工作不等 document embedding。绑定 ready、捕获 publication coverage 与
  完成的 transient source coverage 分别表达。
- 完成的 chunks 和数值沿原缓存软字节预算。兼容 document 资产不会仅因换 API key
  重嵌；当前来源、binding、credential 仍须有效，query 向量缓存继续账号分区。
  两个并发冷调用保持各自真实 inference owner，不宣称跨调用在途付费去重。
- 前台 document/query HTTP 共用原 InferenceCall/ordinal/Catalog/Goal/ContentStore；
  不进入后台 index ledger。维度从首个真正需要的响应获得，没有付费探测或自动重试。
  完整 source-version fence 落在原 dispatch intent ACK 后、实际 requestStarted/HTTP
  前；失败保留原 admitted no-send。候选安装前另核版本，不能删掉已发生 HTTP 的 usage。
- Release 取消并等待实际准备后释放 reader；query observer 可先结束，原 inference
  owner 仍保 HTTP/body/receipt 排空。最终 Rust 沿原 source 重建 revision/span/正文，
  独立丢掉后变材料，不把旧评分改名为新正文；原 history 与来源 pin/GC authority 保持。

## 真实 stdio 入口与已运行证据

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::retrieval_inference_review::fixed_semantic:: -- --ignored --test-threads=1
```

实际 fixture 运行原 Storage、Documents、compute/tree-sitter、packing、semantic store、
设置/凭据、extension composition、Catalog/Goal 和 Rust tool history；provider bytes
由受控内存 transport 提供。没有构造现成 SemanticHit 代替 source 生产，也没有 listener。

第一次执行编译通过、三条断言失败。两个误把固定 revision 的 headRevision 当作独立
writeRevision；另一个误假定 native 枚举先给 a.ts。实际冷源交付/取消排空已走到，修正
这些 fixture 事实后第二次 **3 passed，71.27 s**，没有为它们改产品语义。

- 冷 fixed 与 warm 基底：问题词和源码零词法重合，实际 units/编码与向量驱动最终
  snippet。旧 live 根移走、branch write head 前进仍读取 revision 0；更高分的范围外
  与 live-only 内容均不能进入结果。warm 只处理真正不同的源文件。
- materialized 四次合法调用：真实工作副本、新问题、原文件 CAS 修改和仅换 key；
  同内容复用 chunks/document vectors，改内容只新编码该文件，换 key 不重嵌 document
  资产但 query vector 重新取得。原请求 ordinal、HTTP/Goal 与后台 ledger 分别核验。
- 两个陈旧窗口：实际 document 外发前改文件，该源不进入 HTTP；Host 已返回后、Rust
  最终重建前改另一个文件，陈旧片段被丢弃，独立有效材料保留。语义覆盖明确 partial。
- Stop：held document body 时要求原 cheap search 已进入；公开取消后不交付晚到来源，
  原 Goal 仍 pending，实际 reader 释放后才有唯一 missing/indeterminate receipt。
- 每条销毁原 owner 后实际重开 Catalog 和 Storage，核同 history、LaunchSource、全部
  原 inference Operation、Goal，以及原 revision 0 blob。不是重启后再运行一遍查询。

warm fixture 移走原 live 目录后，已存在的后台 watcher 报一次 workspace unavailable；
该诊断保留，固定查询仍沿已保留 reader 与原 source 完成，不假装后台扫描成功。

最后的 guard 修改已精确复验原两种 stale 窗口：**1 passed，26.48 s**。原 Catalog
确实保留 dispatch ACK 后、HTTP 前的 not_dispatched receipt，连续 ordinal 与重开
后的原事实不变。成功 HTTP 数与受理 Operation 数分别断言，未强行把二者相等。

## 独审、共享消费者与产物

独审从两设计和旧失效路径形成标准后再读冻结 diff，接受该有限范围，未见剩余行为
阻断。新增一个独立受控端口探针挂住真正的 `beforeDispatch`，随后取消、发 kernel
exit 并 close owner：guard 排空前 request/run/close 都不提前完成，fetch 一直为零；
释放后只结算原 ordinal 1，保 requestStarted=false、localExecutorStopped=true 与
missing usage。这是 owner 端口证据；真实 Catalog no-send/reopen 与 HTTP body drain
由上面的 stdio 场景分别建立。该外部探针第一次以 .ts 启动不满足外部 ESM 包规则，
改 .mts 后实际执行通过，没有为此改产品。

原 focused 九文件 **50 passed，14.70 s**，覆盖 source/query、真实 store/retained
reader/empty backing、调度、原 workspace inference、source composition 与 structure
port。新增版本检查用例证明一次实际外发检查加一次安装检查，以及 Off/no-send；
受控 source port 不被当作另一份 Rust 来源证据。Host source/tests types 与本片全部
23 个变更 TS 文件 ESLint 通过；工程文档检查 249 文件、1813 链接、零错误。

有限共享回归：原 live semantic+TypeSafe decision+Responses Explore **1 passed，
23.47 s**；原 child source/history/GC **1 passed，18.04 s**；Pi 固定 branch view
与后续父盘漂移消费者 **1 passed**。child 首次过滤误写模块名，选中零条，不计成功；
校正为原 child_review 模块后真实运行。未启动旧 socket/native semantic suites。

Host 声明、实际 bundle 与 CLI 构建通过。原 production cloud lock 冻结核验与打包通过，
新增 source-query 模块进入实际产物，锁文件无改动。cloud layout **12 passed**，Host
production boundary 用原 Node runner **7 passed**；最初误用 Vitest 的 boundary 命令
返回无 suite，按原 node:test 入口重跑后才记通过。

本片 Rust production 输入与上一已构建基线相同，只有 cfg(test) review 与文档变化，
没有重复构建或把旧二进制冒充新 Rust 实现。测试按项目 edition 2021 标准格式化，
核改动仅排版、可选尾逗号与 import 排序。现有 Linux x64 debug Kernel、正常 stage
与本次 cloud 产物 SHA-256 均为
`00507663bfc596de2f5747b9d48341e81e9624a2f392b1613f9f6817ebb95fe7`。
这些产物检查不等于完整产品启动或性能测试，原 Rust warnings 保留。

## 边界与后续

这里建立固定/物化实际源的远程 embedding 语义候选。没有替代原 live/Pi 后台 index，
没有实现 native 本地 embedding、完整 LSP 依赖闭包、远端一致来源或整库性能目标。
stdio 与受控数值证明调用链、来源和计量，不证明真实 provider 质量/费用、完整产品
IPC、安装后桌面/移动端或跨平台表现。默认切换、Pi 删除及全面资产迁移仍由用户验收后负责。
