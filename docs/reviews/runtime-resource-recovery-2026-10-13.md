# 文件等待与草稿恢复验收

## 实现

文件资源等待改用 `file.lease.wait`。原 Storage owner 保存请求，释放、撤权、取消和实际 worker
排空时唤醒；等待者不持有部分路径，也不占请求 credit。冲突请求保持顺序，无关路径继续推进。
`file.lease.acquire` 保留即时检查用途。取消与取得租约交错时仍返回实际回执，由原消费者释放。

检索计划的三个发行实现和 SDK 共用同一服务声明。冷查询能取得 `describe` 的合同，实际注册后
保持同一描述和 provider 关联；查询本身不启动 worker。

确认草稿冲突后，恢复通过原 Documents owner 捕获 buffer/base，在原恢复路径的 safety 引用中
保存内容。磁盘替换和 Registry 的 buffer/base 替换各有回执；撤销恢复原磁盘和原未保存草稿。
正常新建文件的目标可以是 missing。过期确认、未知 Surface 结果和后续编辑不会被猜成成功。

真实链路检查同时修正了四处问题：

- 私有协议复用已生成的 `RecoveryConversation` 联合类型，避免合法来源被空结构拒绝。
- Registry 屏障等待相关读取及保存，只在实际文件通知被延后时重读；预览结束不制造新读取。
- Rust 对 combined 的 Surface 附件核验内容引用，其他文件状态保持原合同。
- 恢复按操作 ID 协调，Documents 使用共享存储上下文及路径租约，避免重新排入自己持有的工作区队列。

## 行为证据

测试由独立 hack 编写及执行，主代理负责生产实现和结果审查。

| 范围 | 结果 |
| --- | --- |
| 实际文件 worker 的 retained lease 排空 | Rust 1 个用例通过，覆盖显式及隐式租约 |
| 真实 IPC 的冲突顺序、无关路径、取消及撤权 | 3 个用例通过 |
| scoped recovery 原租约消费者 | 4 个原用例通过 |
| 原 ApplicationExtensionRuntime、broker、SDK 的检索合同 | 1 个用例通过，覆盖三个发行实现 |
| 实际 Rust Recovery store、Documents Authority、Document Registry | 5 个用例通过 |
| 原 recovery engine / Registry | 26 / 41 个用例通过 |
| 受影响的原 UI 夹具 | 3 个用例通过 |

新增恢复用例包含 CRLF/BOM、missing、存储重开与 GC 后撤销、过期确认、确定性导航失败补偿、
已提交导航丢回复后按原操作继续；并验证相关编辑被屏障协调、无关编辑仍可进行。
存储重开使用真实 Kernel，Authority 和 Registry 保持连接；这不代表整个 GUI 重启或断电验收。
原故障夹具改按具体文件及实际写入注入失败，保留持久状态和不覆盖检查。

Kernel 构建、Host/UI 类型检查、改动 lint、生成协议核对和实际 Host bundle 已通过。
本记录没有真实模型请求或桌面输入；整机、多环境和性能负载仍按各自范围验收。

入口：`runtime_file_lease_review.rs`、`file-lease-wait.native.test.ts`、
`extension-host/test/runtime-contracts.test.ts`、`recovery/dirty-recovery.native.test.ts`。

## 固定请求的共享与持久化

执行器与 `RequestPrepared` 共用不可变 RequestSnapshot；媒体持久化仅投影语义视图，借用原
provider 正文。当前存储形状、取消边界和已派发请求不重放规则保持。历史编译和序列化仍访问完整
输入，本项没有测得吞吐量或远端缓存收益。

独立 hack 运行 execution 14 项、prepared request recovery 12 项、content 8 项，并补一项真实
RequestPrepared → load_snapshot → GC → Catalog 重开的媒体用例，共 35 项通过。新增用例核对
700KB 媒体、Unicode、文本顺序与 provider opaque JSON 的完整内容；不以指针或源码形状作验收。
两 crate 的测试构造编译通过。旧夹具改用 Catalog 外层历史 ID，保留原文断言。
