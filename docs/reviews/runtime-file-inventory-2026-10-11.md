# 文件 inventory 与真实 reader 排空

日期：2026-10-11（Asia/Singapore）。基线：`5177496b2e6fcbb18e9f295c031217cc3b499904`。
状态：本片源码整合、分层组件验证与独立审查通过；完整 Host IPC 与跨平台尚未实跑。

## 有限交付范围

原 `file.scan` / `file.measure` 复用 Kernel 的 `file_workers`、请求取消表与完成队列。
Storage 只准入原注册根、真实 grant、参数和可选已有 lease，完成时核当前原授权与根登记。
文件系统解析、目录读取/stat、排序/去重、路径 JSON fingerprint 和结果构造均在 worker；
完成消息移动原结果，公共 response envelope 不再在 actor 内克隆结果。旧同步两方法与遍历实现已删除。
没有新 Catalog、持久 inventory Job、快照缓存或调度器，内部存储格式不变。

扫描保留原 scope、隐藏目录、symlink、非 UTF-8 错误、稳定路径顺序与分页契约。
Fingerprint 只是路径集合；同路径改正文不改变它，路径增删会拒旧 continuation。
每页仍重新扫描，没有宣称消除重复 inventory 成本。Measure 保留 missing/null、logical bytes、
Unix allocated blocks 与其他平台未知 allocation。合作式取消穿过目录项和 hash 写入；
单次 OS 调用和标准库排序没有强制抢占或固定延迟承诺。

## 真实消费者、取消与恢复

`KernelClient.fileScan/fileMeasure` 使用原 `settleCancellation`：取消帧先发送，原 Promise
等最终工作响应。断线拒绝不是 reader 已停止的证据。原 pending 请求直到 worker 完成才移除；
明确 revoke/retire 或 cancel 后拒迟到成功，shutdown 先取消并 join 原 workers，再释放 Storage owner。

Experiment 的前后两次扫描传入其已经持有的 source `leaseId`，与 captureBatch 共用原
`captureDrained` 跟踪。可选 lease 只延长原 exclusion，不为普通 scan/measure 新建锁。
同一 lease 原来就只允许一个 active file worker；现在共享这个检查，而非增加计数器或全局串行。
真实目录和路径覆盖在 worker 沿原 canonical lease resource 规则核验。

release/revoke/retire 在 worker 持读时保留原 lease，实际完成（包括失败/取消）后才移除。
原恢复通过重新获得同 scope lease 证明旧 reader 已结束；重启的新 Kernel 获得原 Storage owner
锁则证明旧 Kernel 已退出。不会因调用者收到 abort、丢 transport 或换扩展 generation 伪造排空。
WorkingState 的 scanPaths/measure 继续使用原未绑定 lease API 和同一 wire 结果。

## 实跑证据与复跑

冻结源码的 Kernel lib **119 passed / 0 failed / 11 ignored**，workspace all-targets check 通过。
其中新 inventory **9/9** 实际驱动原 Kernel/Storage；原 protocol、lease 和 file observation
风险回归合计另 **11/11**。Host 原 request-credit 与 experiment-workspace **17/17**，
Host 测试类型、四个修改 TS 文件 lint 和协议生成核对通过。

独立审查另用外置窄探针串联真实 prepareExperimentInput → KernelScopedClient → KernelClient，
只替换 wire peer。两次扫描分别覆盖取消 ACK 和实际 failAll 断线，**4/4**：原 lease/root/grant
正确，取消帧先行、未 ACK 前领域 Promise 与 lease 仍被保留，真实取消响应后只释放一次；
断线维持 undrained 且不提前 retire。没有启动 socket 或把 fixture 当真实 Rust transport。

同冻结源码新建并 staged 的 Linux x64 `0.9.25` binary SHA-256：
`8abc127fd86ad7acc5c2150c8f8efe5e8ec27c0d84db119dc0e00da6097e307c`。
准确 binary 的原实际 process/Storage 来源读取与双 grant 核验 **1/1**，只作为共享 runtime
回归，不替代 metadata 的真实 Host IPC。构建前后 **1,260** 个 Kernel/Host 源码、schema 与
配置输入指纹一致。实际 Host bundle **535 reachable / 72 excluded**。
Host 生产声明检查通过。独审按预先设计合同追踪实际数据/取消/lease/恢复链，
确认无剩余代码阻断；15 项独审冻结源码/schema/测试指纹最终全部吻合。
文档检查 **211 files / 1,689 local links / 0 errors**，diff whitespace 检查通过。

依据[开发指南](../development.md)准备锁定工具链，在仓库根执行：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml --workspace --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/request-credit.test.ts \
  application-host/lib/harness/experiment-workspace.test.ts)
node scripts/generate-kernel-protocol.mjs --check
```

Kernel inventory 用例直接驱动原 `Kernel::handle`、实际 Storage 和完成队列，在真实目录读取处
使用逐 task hold，验证控制可继续、取消/撤权、物理 lease 与 shutdown。Host 用例驱动原客户端
信用/取消/断线和两次 preparation 扫描，传输为内存 fixture。两层不合称完整 Host IPC。

完整 Application Host Unix IPC、超大目录性能、macOS/Windows 和产品打包尚未实跑。
本地实验 artifact 收集仍经原单文件 `file.capture`，其正文读取/验证/安装仍是下一片实际控制
边界。不能因 metadata 隔离就宣称所有大文件 I/O 已离开 Storage。两设计整体仍在实施，
默认 runtime 切换、Pi 删除和全面资产迁移交用户验收后负责。
