# 原 immutable object reader 与实际取消排空

日期：2026-10-11（Asia/Singapore）。基线：`0e5456128c7583254a4a77edd052b7bef1016d39`。
状态：源码整合、分层组件验证与独立审查通过；完整 IPC/产品/平台未验范围如下保留。

本片是原 `storage.getBlob` 的有限读取边界修复，不是日志条件实现或两设计全部完成。
用户要求完成本片、独审及发布后暂停；续接范围见下文。

## 共同读取与唯一权威

公开 `getBlob` 的四种原来源、byte range 与 `KernelObjectSlice` 不变。Storage 只捕获实际
Host/epoch/grant、owner/record-slot/branch-path/pin-path、hash、记录长度与范围。原固定来源
native `file_read` 也进入同一个 `BlobReadTask`；生产同步正文 dispatch 已删除。

实际 open/stat、首次完整对象 hash、seek/range read、base64 和文本投影在已有 file workers
执行，使用同一个 File 句柄。小范围首次读取仍验证整个对象；范围之外的损坏不能漏过。
原响应帧上限约束一次传输，不新增总文件大小或日志长度限制。完成仅重验原授权、source、
记录长度及 cancellation，移动已构造正文。只有完整验证且仍获授权的完成更新原
`verified_objects` 缓存；取消、损坏或失去 source 的回复不产生成功空值或缓存事实。

Storage 的短暂 exact-hash reader 引用进入原 GC roots 与 pending physical deletion 检查。
同 hash 的多个 reader 各自保活，queued completion 和 worker 收尾也持原引用。它只保留
字节，不进入 `blob_owned`、不成为新访问凭证，不创建耐久查询 Operation 或第二个正文库。
原 owner/pin/record 被释放或 grant 退役后，旧字节仍保到 reader 实际结束，迟到正文则依
当前原权限拒绝。最后引用释放后，原 GC 可回收。Catalog 39、Storage 13 和协议均未改格式。

原 pending 请求与 ResourceReply 保持到实际完成；原 Kernel Drop 先取消、join 这些 workers，
再释放 Storage owner lock。重开没有短暂 reader 的恢复或重派。其他 Storage 写入、GC 遍历
及物理 live-file read 的既有执行边界不因本片而被宣称全部隔离。

## 真实消费者与独立反例

Host `KernelClient.getBlob` 使用原 `settleCancellation`。Abort 立即发送原控制帧，但调用者
Promise 等 native 终态，避免 `openExperimentInputTransfer.close()` 或 resource-read finally
把已发取消误当实际 reader 排空。断线仍是 disconnected，不是成功 stop receipt；native
字节保活与 Storage owner 生命周期独立于 Host Promise 是否被拒绝。

独立固定探针以真实 public client、scoped grant 和原 input transfer 消费者连接受控 wire peer：
已发布基线 client 模块精确回放时，两条断言均失败，native 请求尚保留而 Promise 已拒绝，
transfer.close 已完成且提前 retire。正常加载修后源码，同一探针两条转绿；真正 cancelled
回复前 read/close 均未完成、retire 为 0，回复后只退原读 grant 一次。基线回放仅替换该模块
的精确原文，其余依赖保持原来源；这是客户端回归归因，不冒充整仓基线或真实 IPC。
同一风险保留在仓库 `blob-read-consumers.test.ts`，便于用户复跑。

## 分层证据

冻结 Kernel lib **141 passed / 0 failed / 11 ignored**，其中本片实际 owner 六项覆盖：

- cold 全对象 hash 被持住时，Storage health/record 请求与取消推进，取消完成不早于 reader；
- 两个同 hash reader、queued completion、owner 释放和原 GC；失去访问来源仍拒读；
- 请求范围之外损坏，以及取消的已验证结果不能提前使缓存变热；
- 原 revoke/retire、worker panic 后的正文拒绝和保活清理；
- Drop 持 Storage owner lock 到实际 reader join，再允许健康重开；
- 原 fixed ResourceCall/ResourceReply 沿同 worker，保原文本与字节 offset。

既有 inventory/capture 组合与新 reader 聚焦 **24/24**，已包含在宽 Kernel 结果中。
最初新 fixture 的导入/错误展示问题及把 branch.create 的 headRevision 误读为 revision 已修；
没有将未进入产品路径的 fixture 错误称为生产缺陷，也没有放宽业务断言。一次误运行整库
格式化已撤回所有无关修改，最终仅保本片明确文件。

workspace all-targets check、Rust 2021 定向格式、生成协议核对、Host 生产声明、测试类型和
修改 TS lint 通过。原 Host 五文件 **34/34**，ExperimentService 原消费者 **31/31**；首次
命令误列一个不存在的 experiments 路径，仅算实际五文件，随后正确路径单独运行。
本片新增常驻 public/transfer 回归 **2/2**，三次实际运行合计七文件 **67/67**；同两条
外置反例与常驻用例是相同风险，不叠加为额外能力或完整 IPC 证据。
实际 Host production bundle **536 reachable / 72 excluded**。

同源码 fresh Linux x64 `0.9.25` binary SHA-256：
`961b705802208d750c36d46246cbc7a5d32ba094749144bc241584b2286314eb`。
编译产物与 staged manifest executable 一致。准确 binary 的原 child guardian/树停止/固定
结果组合 **1/1**，通过原实际进程及领域 owner 验证；测试中的同步 Storage driver 复用同一
prepare/run/finish 算法，不能将这个组合单独称为生产 wire 排空证明。
独审先验形成于读实现之前，冻结生产输入核对一致，无确认行为阻断。新增常驻用例
后再次核对原 5,288 项未变，加该文件形成 5,289 项最终指纹。文档检查 **216 files /
1,707 local links / 0 errors**。这些数量用于标明实际运行范围，不折算设计完成度。

## 复跑入口与未验范围

按[开发指南](../development.md)准备锁定工具链，在仓库根执行：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/blob-read-consumers.test.ts \
  application-host/lib/kernel/request-credit.test.ts \
  application-host/lib/kernel/file-capture-consumers.test.ts \
  application-host/lib/kernel/resource-storage.test.ts \
  application-host/lib/kernel/research-source.test.ts \
  application-host/lib/harness/experiment-workspace.test.ts \
  application-host/lib/harness/experiments.test.ts)
```

原真实 native authority 全链入口仍为 `bun run test:kernel`。本环境 Unix IPC 限制使完整
Host-to-kernel IPC 验收未执行；没有改 transport 或重试绕过。以上 native owner 与受控 wire
的真实 Host 消费证据分层成立，不合成为未跑的全 IPC。未调用真实模型、研究/GPU/远端作业
或用户电脑；浏览器、其他平台、物理断电和性能测量也不在本片证据内。

## 暂停与续接

本片完成独审、commit/push 和精确远端核对后暂停，不自动启动下一阶段。

- 下一条已讨论但未实现的是原 durable log 的 literal/log_end 条件、字节游标和实际 EOF；
  不能把这次 reader 前置算作日志匹配完成。任意 regex 与 metrics 等领域条件仍待正确合同。
- 两设计其余能力还包括 Computer/人工接管/远端执行、Web/材料/PDF/学术/Bot、MCP 的
  resources/prompts/Tasks 与持久脚本，以及 SourceView/检索/上下文/provider 长尾。
- 已实现能力仍需外部可运行环境的完整 Host、产品交互、平台与性能验收；这些不按提交数
  或测试条数折算完成度。
- 用户先验收，再负责默认 runtime 切换、Pi 删除与资产全面迁移；本次暂停不改变此交付分工。
