# 原来源生命周期与公开诊断

基线 `aa0414808a2e53d1ca70d977c244f7393a8c312d`。本片收口 fixed/materialized
新输入、原 Run 恢复与 Context 消费仍依赖旧 live 目录的问题。Catalog **58** 保持；
私有 wire **13** 直接替换旧失败投影合同。

## 唯一来源与实际准入

- Documents 持久 workspace 注册保原 Host 身份、配置命名空间与当前信任；新增
  `admitWorkspaceRegistration` 不 realpath 旧项目，也不授文件执行权限。首次 capture、
  live 以及真实文件/进程/集成目标继续沿原物理准入。
- 原 Storage branch/revision/pin 唯一提供固定字节。公开 input、重绑、恢复和 child
  核同一来源，不将 branch head、当下 live 目录或另一 working copy 当替代。初始 Context
  也走原 branch-only reader；准入只读 pin 元数据，真实资源消费者再显式加载原 capsule。
- 原 AgentRuntimeClient 绑定 Documents 准入。fresh grant 前、来源准备后和 start 前
  检查当前注册/信任；缺 owner 明确失败，准备期间撤权会释放已签 grant。独立脚本、研究
  与 PDF source 消费复用该入口。MCP 固定全局 scope 不借配置路径取得项目执行 cwd。
- child 初始/后继来源准备沿原 Catalog 选择与 Storage pin，清理原 unused/orphan 来源
  依据原释放事实，不再为释放要求旧目录或当前读取许可。没有第二 pin/分支库或虚假 Run。
- materialized 仍指向原 environment Run 派生的 exact managed path。缺 copy 或该 key
  链接到另一 managed copy 均拒绝；恢复不重新物化，不承诺 pathname 以外的 inode 身份。
- 原有限 SourceFailureCode 串通 Rust launch/child、Host reader、认证 route、公开 client、
  retrieval 与 UI。只有真实 typed owner 分类；任意异常伪造同名 code 不能取得来源错误
  投影。显示文字由既有 client/Rust 控制，原上游异常正文不回显。

## 真实组合与复跑

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::source_lifecycle_review::public_fixed_and_materialized_sources_survive_old_root_loss_and_real_storage_reopen -- --ignored --exact --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::retrieval_inference_review::source:: -- --ignored --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::retrieval_inference_review::child_review::default_child_dispatch_reads_its_admitted_source_and_keeps_original_history_after_gc -- --ignored --exact --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib agent_runtime::pdf_source_review::document_only_native_sources_and_artifacts_reach_public_pdf_reader_and_reopen -- --ignored --exact --test-threads=1
```

`source-lifecycle-host.test-helper.ts` 使用原 application-client、认证 Thread route、
ThreadAdapter、Documents、resource scope、Context/Memory、凭据 owner 与真实 Storage。
Rust fixture 调用实际 RunAssembly，保其工具与上下文准备，仅替换准备好的 ModelProvider；
该受控 provider 仍经原 Responses serializer 生成请求并实际调用 `file_read`。

真实 capture 后主动改变 branch write head 与 live 文本、移走原目录，固定新输入仍见原
instructions/字节。故意保留已受理但未 start 的 Run，再关闭 Host、Storage 和 Catalog；
重开后从公开 `retryPreparation` 恢复原 Run/input，签 fresh grants，之后再提交新输入。
materialized 验证实际修改过的 working copy；后续重开前移走该 copy 时，持久 launch
显示 `source_environment_unavailable`，没有 materialize 或 start 调用。

此精确组合加上后述研究 pin 原链后最终 **1 passed / 0 failed**，7.35 s，涵盖两来源。早期夹具遗漏 Memory owner
导致失败，接回原 owner 后修复；没有把最早错误 filter 的 0 tests 计为成功。元数据撤权、
未知注册、错误 revision 在公开 submit 前拒绝；正常输入的历史身份和恢复不重复。

纯 Host 最终选中 15 文件 **113 passed / 1 skipped**，16.60 s；覆盖原 Documents 注册、
Context/技能、分支资源、公开错误、fresh grant 前后撤权和 managed key 替换等实际行为。
本轮发现的旧媒体夹具断言已按当前 input 合同修正：传图使用 inline bytes，未提供图字段
的文本编辑保原图，明确空数组清图；没有为旧断言修改生产语义。共享 ThreadConversation
行为 **82 passed**，6.35 s，验证可操作来源错误与原持久 launch 展示。

原 source retrieval 两项通过（68.95 s），保固定/实际 working-copy 字节与原模型取消排空；
原 default child 检索通过（16.52 s），保真实派发、来源、历史和 GC。原 PDF 三来源/13MiB/
公开 reader/重开通过（33.83 s）；此前两次失败分别来自其共享夹具漏接新增注册 owner，
以及新 Documents 夹具违反已有 Promise 签名。修复夹具接真实 Documents/注册 ID 后复跑，
未为错误夹具增加生产放宽。PDF 字体加载 warning 仍在，不作为字体渲染质量通过。

共享依赖、Host/CLI、Host 声明与 UI types、Web/PWA、协议生成与文档链接检查已通过。
Linux x64 debug Kernel 以 build identity `0.9.25` / wire 13 构建，正常 stage 的 SHA-256 为
`2390d42380dac073328573ff91c5a03d85448192c95e19e3cf19c2088aa54540`。
cloud layout 12 条、Host production boundary 7 条通过；无锁文件语义变更。debug 构建不构成
性能证据，原 Rust warnings 与 Web chunk 提示保持。

## 独立反例与最小修复

独审实际复现两条控制/清理接缝，均沿原失败条件复验：

1. 已生成研究输入 fixed pin 后撤 trust，旧 `release` / `reconcileUnaccepted` 会重新准入
   来源，抛错后 pin 残留、operation grant 未退休。现在只由私有 cleanup 验原
   caller/Run/Launch/Operation/execution owner 和 branch.pin receipt，取得原
   `storage.read + storage.maintenance` 做确切 unpin；maintenance 是 Rust 跨 actor
   释放原 pin 的现有要求。没有 readBranch/正文/物理根，也没有通用撤权旁路。新工作仍被拒。
2. 原“start 前”检查实际早于 credential/policy/extension/Memory/Plan 异步准备。
   在 Memory reconcile 返回前撤 trust，两个原 start 入口仍能发送 `runtime.run.start`。
   将末次检查移动到这两个原 RPC 边界后，独审原探针都不再 start；source grant 被释放，
   有凭据入口还释放原 credential owner。检查总数仍为三，不增加层层检查或新协调状态。

核真实 Rust 协议还发现既有研究 producer 向 revision pin 发送 `persistent:true`，该标志
只属于 current working-root pin；revision pin 本身已耐久。移除错误字段后，在本片原
stdio fixture 接真实 `runtime.host_job.user` 与生产 `createResearchSourceAuthority`：
实际建立 pin、撤 trust、直接 release，以及故意丢原 pin ACK 后 reconcile，两条都由真实
Storage 删除原 pin。清理期间没有 branch/root/blob 读取或重新 pin。这证明原输入准入/
清理与 Storage 接缝，不代表执行了研究计算或完整 ExperimentService 作业。

独审另沿原 ThreadCollaboration 和真 Documents 跑三条受控端口探针：pin 后撤权、同窗口
取消、已撤权 orphan 清理；都不启动新 Run，原临时/retained pin 与 grant 正常释放。
其 Storage 端口受控，与前述真实 Storage 研究探针分开计证。script 原取消仍由 Runtime
ProcessControlRegistry/guardian 执行，撤权后无法细化 terminal 时保 Unknown；本片仅核
该源码责任链，没有把未知旧 callback 的停止状态改成成功。

修复后研究 focused 4 条、start/工具组合/公开 continuation 33 条及最后 Host tests TypeScript
通过。Host/CLI/声明重新构建并经正常 cloud builder 打包，cloud 与 stage Kernel SHA-256
一致。独审核上述真实链和两条原红探针修后结果，当前冻结范围无剩余行为阻断，接受此
有限生命周期片；没有据此声称完整 cleanup/cancel 组合矩阵或全设计验收完成。

## 证据边界与后续

新增组合使用实际 Storage 与 Catalog 关闭重开，不只重建 Host；但没有新增并发 Storage GC
或强杀 reader 试验。模型配置/生成受控，HTTP 为内存投递、内核 transport 为测试 stdio；
不能外推到真实账户、模型质量、完整产品 IPC、全部平台或性能负载。

完整非 live semantic overlay/publication、LSP 依赖闭包、远端一致来源及两设计其余能力
仍待实现。默认 runtime 切换、Pi 删除和用户资产全面迁移由用户验收后负责。
