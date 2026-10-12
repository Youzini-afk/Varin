# Documents 草稿与原生固定来源

基线：`6ff42d49f17e64c97a66e854f9b2c64c3ec804df`。本轮依据[运行时设计 §15](../design/agent-runtime-design.md#15-文件工作视图与子任务基线)连接已有 Documents、WorkingState 和来源消费者；默认运行时保持 Pi。

## 当前合同

- Source picker 显式选择 saved-files 或 surface-drafts，并显示 captureScopes 和实际 provenance。目录经原 Documents 注册一次，后续请求固定 workspaceId/key/完整内容选择；相同 key 的不确定重试不重新捕获草稿或解析已移动的目录。
- 快照拥有者使用真实 `pi-session` / `thread` 标记。Pi 原 own-write 更新规则保留；Thread 捕获不可变，编辑器继续修改不改变旧请求。原编码/BOM、行尾、文档实例及修订随 provenance 保留；正文进入原 WorkingState 对象与固定 root，不写入 Catalog 控制记录。
- 同一覆盖视图同时解析设置、指令和 skills，包含草稿新建的目录/文件及其真实外部依赖。固定 child 继续继承原 pin/root、baseRef 和持久来源关系，不重新读取现场，也不复制另一套草稿正文。
- Git 子目录使用选定根内的相对 inventory；hash-object 输入指向真实文件，Git index identity 进入原捕获稳定性判断。工作树字节、Git index 和编辑器草稿仍是不同事实，不宣称本片能恢复 Git index。
- 原 branch-create receipt 先于重新捕获读取；快照释放、原目录移动及 Host/Storage 重开后可恢复同一已提交来源。当前注册/信任检查仍执行，真实 live 文件操作仍执行物理准入。
- 共享准备只协调并发观察者。单个观察者取消不取消其他人；最后一个观察者等待真正捕获排空，后续 retry 不越过 cleanup。未转入固定 root 的临时对象由原 owner 释放。

## 行为证据

| 路径 | 本轮结果与边界 |
| --- | --- |
| 原 Registry / picker / Pi 消费者 | Registry 的 41 个行为用例及后续 8 个 alias 聚焦用例通过；picker 初始 5 个行为用例、workspaceId 合同后的 saved/draft 两个精确重试用例通过；原 Thread source 6 个及 Pi dirty-input 消费 1 个通过。它们使用真实 UI/Registry，Host seam 受控，不计为产品网络 IPC。 |
| Documents → source preparation | 原 Documents 的 4 个 owning 用例通过，覆盖 BOM/CRLF、不可变/consumer 隔离、已提交 receipt 与未知重试、取消排空、部分上传释放和显式 source 拒绝。WorkingState 使用小型受控树，此行不计 Rust Storage 证据。 |
| 来源资源闭包 | owning resource 用例经过纯 Node 驱动通过：草稿 settings 引入外部 skill、磁盘不存在的草稿 skill 目录使用同一固定内容，磁盘 settings 未改。 |
| Git 子目录 | 原 Git owning 用例的增强场景通过：CRLF/Unicode、选定子目录、无关兄弟路径变化及仅 index 变化。独立实际仓库探针同时确认目录内 34 项均有原字节 hash，没有混入兄弟 dirty 路径。 |
| 独立跨 owner 检查 | 原 draft-resource-closure、alias-receipt、mixed-case-drafts 反例修复后通过；Storage 注册元数据与物理执行准入、fixed child pin/来源 lineage 分别追到原 owner。 |
| Rust ↔ Host 原 source lifecycle | 原 exact stdio 用例通过，实际运行 6.10s。固定/物化两模式消费原 Documents 草稿及 BOM/CRLF，GC 后仍可读；释放快照、改磁盘/branch head、移根及 Host/Storage 重开均保原正文/provenance；撤信任拒绝 prepare/submit，pending Run 接续不重复输入，managed copy 缺失明确拒绝。经过真实公共 client/认证 Router/Adapter/Storage；网络传输由 direct Router + stdio 代替，模型受控。 |

真实 route 检查发现 source/prepare 字段 allowlist 仍保留旧 path 合同，导致合法新 UI 请求在进入 preparer 前返回 400；已在原认证 Router 更新 workspaceId/content/captureScopes，未增设第二套授权入口。旧 stdio fixture 的局部变量遮蔽和缺失 source.tools 转发分别修正，不将这些未进入业务的失败计作产品行为证据。

独立检查另复现“另一个不相交项目的离线 dirty buffer 让当前选根 capture 整体失败”。范围相关性现由原 Documents identity owner 判定：明确不相交的注册根可排除；新父根/嵌套根仍执行真实物理 identity 与 alias 发现，候选失败不伪装 clean disk。UI 不解析 opaque identity，也不维护另一份根目录名单。真实 Documents + Registry 修后探针已覆盖上述区分；独立原反例也已通过：编辑后才注册的 nested root 捕获确切草稿，另一离线根不进入正文，两份 buffer 和 disk 都未被改动。本轮未留下已确认的 Source 功能阻断。

## 类型、构建和复跑入口

- protocol/application-client 产物已重新生成；Host production 与完整 Host tests TypeScript 检查通过，UI TypeScript 检查通过。
- 上述完整类型结果对应 Source 合同冻结点。其后的 scoped-identity 小修通过 application-client build、Registry/原测试和 Web Documents API 的 scoped TypeScript 检查；Host scoped 检查中本片诊断为零，命令仍因并行未完的 recovery/journal-engine 类型错误退出失败，未称整图通过。没有机械重跑原 Source 套件。
- 原 `scripts/build-kernel.mjs` production release 构建通过：linux/x64，build identity `0.9.25`，protocol `24`，60,957,680 bytes，SHA-256 `32da96021ac252d015afbee79a7e719d2d20c797e7f9fa99f791ed321faee4b1`。未启动产品 listener，不为随后只改测试 fixture 重编 production。
- UI 行为位于 `packages/ui/src/components/thread/ThreadSourcePicker.behavior.test.tsx` 与 `packages/ui/src/lib/documents/registry.test.ts`。
- Host owning 行为位于 `packages/web/application-host/lib/kernel/thread-sources.test.ts`、`thread-resource-scope.test.ts` 和 `harness/thread-worktree.test.ts`。
- 多根离线回归归入原 `packages/web/test/integration-surface-vertical.native.test.ts` 的选根用例；本轮通过提取该实际 case 与原 direct Documents transport 的纯 Node 入口运行，未执行该文件的其他原生用例。
- 原 Rust/Host 组合入口为 `kernel/crates/varin-kernel/src/source_lifecycle_review.rs` 与同名 Host helper。运行前需检查该入口及传输，不将监听型 native 套件混入本片。
- 文档检查：270 个文件、1,888 个本地链接、零错误；staged diff 空白检查通过。

## 尚未交付的范围

本片只固定来源，未实现 native 对话回退与组合文件恢复。随后沿原 affected-file journal、HistoryBranch 和 Documents 冲突处理接入，不因切换会话覆盖 Git 状态、用户外部修改或未保存缓冲。正式安装、全产品网络 IPC、实际模型服务、跨平台文件/编辑器和大项目捕获性能未由这些证据证明。
