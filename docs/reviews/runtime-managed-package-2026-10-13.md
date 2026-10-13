# Managed Source 扩展包 staging

## 实现

`extension-source.ts` 是本地及来源 Host 共用的捕获实现。固定来源持有原 pin；物理来源核对完整
inventory 和内容。包的来源记录包含 resource owner、Run、Operation 与原 revision/root。

来源 Host 持有捕获对象；封闭的 `package_capture` / `package_read` 按冻结目录分页传输字节。
协调端核验页边界、长度和 hash，再写派生编译目录。目标对象地址没有进入协调端 Storage。
编译、首次禁用安装、候选及 capability 审阅继续使用原 artifact/catalog owner。

捕获属于 caller-retained source authority。单请求取消等待真实 reader 回调退出，authority
retirement 也释放已完成或丢回复的捕获。语言释放单独取消并排空准备中的语言查询，再交原
supervisor 释放 view；包及普通读取继续独立执行。

验收还发现原候选撤回遗漏了未形成就绪组的准备。现按原候选 artifact 取消对应节点，显式撤回
等待自己的原准备退出；通用刷新不等待这些取消任务。selected winner 和共享依赖的其他消费者保留。
已完成准备的候选按正常 terminate 收尾，不增加强杀要求。

## 证据

生产实现由主代理完成，测试由独立 hack 编写、运行并与主代理核对。

| 范围 | 结果 |
| --- | --- |
| 双 Storage / Catalog / Source client / 认证 Router / compiler / artifact catalog | 1 项通过 |
| 原 managed-source-service，包括语言准备排空与独立读取 | 17 项通过 |
| 原 package-authoring 的安装、更新、取消恢复及候选撤回/替换 | 5 项通过 |
| 原本地 model-authored 完整链 | 1 项通过 |

双 Host 用例包含 live/fixed 捕获、A 同名路径陷阱、B 捕获后修改、分页原字节、原 provenance、
首次禁用及新增 capability 审阅。取消时实际 B reader 回调被保留，GC 在退出前保留内容、退出后
回收；语言释放后原捕获仍可编译。它使用真实 Rust owners 和 direct Router/stdout 传输，未启动
产品 HTTP listener，不代表真实双机网络验收。语言准备排空另使用受控 Documents admission，
不把它称为 LSP 协议或语言服务器实机验证。

旧候选替换测试改查实际 terminate 的 owner generation，保留 selected、旧候选拒绝及新候选身份
断言；正在激活时的取消、排空和 CAS 顺序断言未放宽。旧夹具补接原 Storage lease waiter；
该同步夹具仅交付无争用等待，排队/公平/取消由原 IPC 与 retained-worker 用例覆盖。

Host/extension-contract/extension-host 类型、改动 lint、extension-host 构建及实际 Host bundle 通过。
入口：`managed_extension_package_uses_original_capture_and_releases_after_reader_drain`、
`managed-source-service.test.ts`、`package-authoring.test.ts` 和原 local authored-chain。
