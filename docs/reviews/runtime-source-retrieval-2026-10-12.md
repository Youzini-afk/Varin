# 固定与物化来源的原检索链

基线 `7c33c58c`。本片将普通 `code_retrieval` 接入原固定 revision 与真实 materialized
working copy；Catalog **58** 不变，私有 wire **12** 直接替换旧查询格式。

## 共同合同

- 唯一来源仍为原 Run 的 LaunchSource、ToolBinding 和 Storage grant。私有查询直接传
  LaunchSource，并将实际注册 physicalRoot 单独表达；固定来源没有物理根，不回退到 live。
- 固定来源使用原 branch/revision 的 compute/tree/blob reader；materialized 使用原 managed
  location 和实际 working copy。原 Documents 字节解码、BOM、版本、空文本与不可读状态保持。
  byte compute 显式请求完整范围，一次捕获跨全部分页，不把默认 64 KiB 当作完整文件。
- 配置 routing 只取 Documents 持久注册 canonicalPath，不要求旧 live 目录仍存在，也不把
  materialized 内部路径伪装成配置目录。该命名空间不是文件授权。
- 非 live 的结构阶段使用原 tree-sitter 和已授权固定字节，不进入 live LSP fallback。
  原 live published semantic reader 不能代表另一来源。已选择而未支持的 semantic 阶段有
  Rust 生成的简短可操作说明；明确 disabled 不伪报 unsupported。
- source、rerank、fast-decision、Explore LLM 仍使用原 query/model/credential/inference/Goal
  owner。外发前实际版本检查由原模型 guard 执行；最后 Host 只做短授权检查，Rust 从实际
  字节重建 spans、revision 和 required groups。固定大文件的最后重建也沿原 blob 分页。
- `code_retrieval` 的 Source 要求及 Worker/Retrieval 缺省选择来自原 Rust builtin 声明。
  显式用户工具数组保持原样；固定 Policy 读仍校验同一 frozen source 与实际 grant。
- 廉价 query 取消不伪造计算 reader 或模型停止：原 compute 到终态才 release，原 HTTP/native
  模型排空才结算对应 pending/unknown。没有新增持久 query Operation、影子索引或第二计量账。

## 整合中修正的实际问题

新增 source reader 最初在 Host 最后阶段重复全文比对，单路径变化会把原本可保留的其他
合法结果一起清掉。已撤回该重复裁决，恢复短 path admission；外发版本约束不放松，
末端取舍仍由原 Rust source reconstruction 唯一决定。分别验模型执行期间源变化和
Host 回包后、Rust 读取前源变化，不能用其中一个窗口替代另一个。

原 immutable FileRead 的单响应大小也不是总文件上限。固定最终重建采用原读者分页，
对实际 hash/长度/offset/EOF 续页核对，不新增任意文件总量限制。

## 复跑入口与证据边界

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib retrieval_inference_review:: -- --ignored --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib retrieval_source_adapter_review:: -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_capabilities::tests -- --test-threads=2
```

`retrieval-inference-host.test-helper.ts` 使用真实配置、Documents、Storage、compute、原 query、
原模型适配器及 Catalog/Goal，仅把产品 transport 换成测试 stdio，控制外部 provider 字节。
`retrieval_source_review.rs` 覆盖保留旧 revision 后改变 branch head、移走原 live 目录、真实
materialize/capture/file.apply CAS、超过 64 KiB 的文件尾、版本变化、原 grammar 与取消排空。
`retrieval_child_review.rs` 通过真实 default profile 编译、dispatch 目录、JobAccepted、来源
handoff/pin/attach、child Run 和原检索 endpoint；没有手造 child 工具支持名单。

child fixture 的父来源采用既有 whole-root handoff 准入，执行 query grant 再收窄为 allowed。
这不是 partial-scope handoff 支持证据。受控 child 模型只调用目标检索 endpoint，不能据此
声称其余缺省工具已经全部经过本片 RunAssembly/Host 消费。固定来源不创建可写副本。

生产冻结后的原生组合首跑 **7 passed / 1 failed**，185.22 s；唯一失败来自新 child 夹具
把原有序 tool schema 数组重新排序，触发真实 tools_ref 激活冲突。保留原顺序后，原 child
测试单独复跑 **1 passed**，两种来源 17.44 s。未放宽生产检查，也不把首跑改写成 8/8。
另外原 Rust source adapter 两条（固定 Policy 来源/撤权、超过一响应帧的实际 blob 分页）、
原 child capability 六条、无监听 Host source/composition 六条通过。原 Pi Explore 三文件
36 条通过；Host tests TypeScript、共享依赖/Host/CLI/Web/PWA 构建及协议生成核对通过。

独审先从设计形成验收，再审冻结实现并补独立 Host 窗口探针：伪造正文在外发前被拒，
fixed 不读 live，materialized 版本变更留给 Rust 末端取舍，reader 全部到实际终态后释放。
该探针的 native 响应和 rerank lease 是受控端口，不能计为真实 Storage 或模型计量证据。
独审复核上述真实日志后未发现本片剩余行为阻断。

保留性证据精确限定为 **Catalog ContentStore collection + Catalog 重开**后原 history、
launch、child source facts 保留；本片没有重新打开 Storage 再查询源，也没有主动并发
Storage GC/杀 reader 的新试验。原 reader 生命周期源码追踪不冒充这两类执行结果。

新 Linux x64 debug Kernel 以 build identity `0.9.25` / wire 12 构建，经正常 stage/cloud
builder 复制的二进制 SHA-256 均为
`219567dbc7ef7d13497fa3f52702944875768aa02302d7c0db175c588cc09b32`。
cloud layout 12 条、Host production boundary 7 条通过，锁文件语义无变化。debug 构建
不是性能证据；既有 Rust warnings、Web chunk 提示不作为本片性能结论。

## 尚未交付的能力

固定/物化 semantic overlay 与 publication、完整语言工程依赖闭包及远端一致来源仍待实现。
已受理固定 query 可在旧目录改名后运行，不代表所有新 Thread input/rebind UI 准入都已摆脱
旧目录：原 `createThreadSourceAdmission` 仍有 Documents.inspectWorkspace 依赖，后续沿来源
生命周期收口。缺 registration 当前无 live fallback，但通用配置失败投影仍会丢失细分原因。

实际产品 IPC、平台、账户、模型质量及性能/负载没有由本片 stdio 或受控字节替代。
默认 runtime 切换、Pi 删除和用户资产全面迁移由用户验收后负责；两设计整体尚未完成。
