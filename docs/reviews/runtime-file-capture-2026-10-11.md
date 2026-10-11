# 单文件 capture 与实际正文消费者

日期：2026-10-11（Asia/Singapore）。基线：`f0c1bc70477657152427f758209f7de19b2e766e`。
状态：本片源码整合、分层组件验证与独立审查通过；未执行范围如下保留。

## 原 owner 与共同正文路径

原 `file.capture` 从同步 Storage dispatch 转到已有 `file_workers` / `CaptureDone`。
Single、Batch 和文件观察共用一个 capture body 算法：实际读、staging、两遍 source hash、
已存在 object 的完整验证均不占 Storage actor。旧 single 的重复 store/install 实现已删除。
原 mutation/reconciliation 的只读观察通过同一算法同步适配，仍是明确未隔离的其他 handler。

Single 保留 `{path,stateJson,ownerId}`，其 owner 使用原 operationId；Batch 继续使用原
operationId:index。store=false 不创建对象 owner；missing、空文件、directory、symlink、
unsupported 与错误分别表达。没有新持久 capture Job、正文库或兼容分支，存储格式不变。

worker 持久化并验证 staging，Storage 最后按当前 grant/root/cancel 核验，沿原顺序安装 bytes、
提交 blob/object ownership。有限 rename 与目录 fsync 仍在这个 owner 内；GC 不可能插入
原安装与 ownership 事务之间。没有把文件先搬到未保护的 object 路径，再等待另一次提交。

## 物理排他、取消与恢复

显式 lease 复用原 caller-owned exclusion 和唯一 active worker 规则。旧未带 lease 的 single
capture 过去由同步 owner 保证受管 writer 不会在读取期间插入；异步后在原 file_leases 表
保留一个临时 exact resource，完成时释放，不另建物理锁 owner。重叠判定与插入使用同一份
canonical resources，避免两次路径解析之间别名重定向改变受管目标。

原 pending 请求表保留 single 与 batch 的取消 token，完成才移除。取消、revoke、retire、
worker failure 和 spawn failure 均沿原完成/retained lease 清理；操作的最终取消响应不早于实际 reader
停止。Kernel shutdown join reader 后才释放 Storage owner。未完成 staging 不得产生 owner。

Host single capture 使用原 settleCancellation。FileResourceBackend 的 gate 把原 AbortSignal
传给实际 reader；同 lease 嵌套 gate 保持外层与本层取消，不额外获得 lease。最终工作响应
之后才释放原 gate。Experiment backend 的 active collection 也等原 capture Promise。
断线使旧 scoped grant/epoch 失效，其 processRelease 失败后不会继续 releaseAuthority；
新 Kernel 还须先获得原 Storage owner lock。Promise 被拒绝本身不算 reader drain。

## 组合证据

最终冻结 Kernel lib **128 passed / 0 failed / 11 ignored**，包括实际 Kernel 读/二次验证/
现存对象验证暂停、并发控制、原显隐 lease、原 blob 字节/GC、取消/撤权、坏对象与 shutdown。
workspace all-targets check 通过。原 Host 四文件 **30/30**，包括真实 gate 的外层/嵌套取消、
原单结果 owner、Experiment collection/release 以及断线旧 epoch。
Host 测试类型、生产声明、全部修改 TS lint、生成协议核对通过。

同源码 fresh Linux x64 `0.9.25` binary SHA-256：
`7b4fb59bfdded94f6799841ec089ff07aabf68dab796b1fc73db3e0d77bcbce4`。
准确 binary 运行原实际 child guardian/树停止/固定来源结果组合 **1/1**；原 fixture 已走
prepare → 释放 Storage lock → run → 当前授权/发布 → 归还 lease，无生产同步兜底。
构建前后 **1,262** 个源码/schema/配置指纹一致。实际 Host bundle **535 reachable / 72 excluded**。
文档检查 **212 files / 1,693 local links / 0 errors**。新正文模块和测试按仓库 Rust 2021
格式检查通过，diff whitespace 通过。

独立外置真实 Host consumer probes **4/4**：本地 Experiment 无显式 lease 的收集/owner 与
release 顺序、失败透传、原 FileResourceBackend gate→capture→条件 apply、原 KernelClient
single settleCancellation。第一轮探针仅有 JSON 键序的脆弱比较，改为语义比较后通过，未修改
产品源码掩盖失败。独审另复用已构建 lib-test，重跑 GC 交错与 Drop 保持 Storage owner 两项
**2/2**；最终 1,262 指纹吻合，按事先设计合同接受此片，无剩余确认代码阻断。一次误选生产
可执行文件为 test runner 时因缺 bootstrap 退出，随后从 Cargo 日志选择正确 lib-test；未建立
IPC 或绕过已有环境限制。

依据[开发指南](../development.md)准备锁定工具链，在仓库根执行：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/file-capture-consumers.test.ts \
  application-host/lib/kernel/request-credit.test.ts \
  application-host/lib/harness/experiment-workspace.test.ts \
  application-host/lib/kernel/scoped-recovery.test.ts)
```

源码测试分别驱动原 Kernel/Storage/真实文件和 Host 的实际 client→gate/backend 消费者，
后者只替换 wire peer，不能拼成完整 Host IPC。完整 Host Unix IPC、实际新 research-source
adapter→Storage 字节、跨平台和代表性大文件性能仍按原边界待验。

下一能力继续领域事件与两设计剩余合同。同步 mutation/recovery/GC 的实际成本、重复
inventory 复用和完整产品验收仍须分别处理；此片不等于整个文件层或两设计完成。
默认 runtime、Pi 删除和用户资产全面迁移仍交用户验收后负责。
