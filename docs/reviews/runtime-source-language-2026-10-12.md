# 物化来源的原语言服务

日期：2026-10-12。基线：`f522d29a874e3528ca1773ff84fb2295f48d57e4`。

本片接通 live/materialized 的 `language_definition`、`language_references`、
`language_diagnostics` 原生来源链。materialized 分析真实 working copy，明确保留
`dependencies: live`。固定分支的完整工程视图仍待实现；本记录不代表两份设计全部完成。

## 所有权与实际入口

- `source-query.ts` 从原 retrieval owner 提取共同的 Source 读取、注册/信任、grant、
  compute/完整字节和修订合同。语言与检索不各建一套源解析或权限路径。
- 原项目 namespace 选择 provider/config；实际 physical root 决定 cwd、root URI、
  workspace folders、URI 映射与 watcher。物化目录不会变成假的 Documents 项目，
  也不因旧 live 目录的位置而改读另一个源。
- 原 KernelProcessService 接可信 Host source callback，在实际 spawn 前重验；
  Rust 仍拥有进程、管道、writer 和退出事实。语言准备不为 Run 增加 process 工具权限。
- 原 supervisor 的 SourceView 保存活跃 Run/grant 引用及本 view 的退出关联。
  查询取消不撤服务引用；原生 view 不受旧 Pi/editor 固定闲置回收影响。
  精确撤权、终态通知、最后引用和真实退出是不同阶段。
- child 结果捕获等同一语言 owner 排空，再通过原 Storage directory-writer 屏障。
  取消该等待只结束观察，未停止的资源仍由原 owner 持有。
- 来源工具目录由 `runtime.source.tools` 从 Rust 原声明/requirements 返回。
  SourcePreparer 的三套工具名单和旧 launch 续接的两套名字映射已删除。
  Worker 默认包含 Physical 语言工具；只读 Retrieval 默认不包含。显式选择保留并由
  原准入提示选择 `isolated_write` 或来源兼容工具，不静默裁剪用户数组。
- 私有 wire **15** 直接替换旧语言 envelope，原 source selection 与 document revision
  分开保存；Catalog **58** 无新增持久域。原 Rust 仍后验输入及逐个返回目标的来源、
  grant、UTF-16 范围和真实 observed revision。

## 真实组合中发现并闭合的问题

1. LanguageQuery 先走通用 `file.read` 返回，新的 source/root 描述不可达。
   第一次真实 stdio 运行因此未到 TS 就返回 unavailable。修复保留原读准入，
   让该操作先返回它自己的短描述；普通 FileRead 不变。
2. 第一次 watch 准备期间原目录暂失，Node 仍可能给出一个失效但非空的 handle。
   目录移回后复用它会漏掉依赖修改，旧 versioned diagnostics 被误报 ready。
   真正 source 准入失败现在清掉未证实的 watch，下一次合法请求由原 owner 重建；
   原断线重连合并在同一 watcher 内。
3. 释放 B 曾错误等待无关 A 的慢退出。等待现只匹配该 source 的原 Run/grant。
   最终真实组合又抓到：较早被终态通知撤回的 Run，仍须在同一 view 最后退出时
   找到自己的排空。退出关联现保留到本 view 真正结束，既不丢原关系，也不全局互等。
4. watch 恢复修复最初把一个 provider 的取消当成整个 source 失效，误关同 root
   另一语言的 watcher。原取消现在先按本 startup 传播；另一语言的真实依赖变化仍
   使在途查询 stale。

原反例在最终实现上独立复验通过。目录 invalidated 的后代展开也对齐原 watcher
合同；本机真实目录替换同时发了后代事件，没有复现该项失败，不把静态合同纠正
算成一次已复现故障。

## 本次证据

| 场景 | 实际结果与边界 |
| --- | --- |
| 原 Rust/Host/受管进程与 bundled TypeScript | 最终冻结链 1 项通过，9.11 秒。三个主 Run、15 份原 tool history；A live 与 B working copy 的 relative imports、tsconfig extends/paths 不同，真实 B 结果、CAS 依赖修改及新位置/修订保持 |
| 冷与热语言结果 | 首次冷 definition 的真实本文件 import alias 保留进历史；后续定义/引用验证实际跨文件。diagnostics 的测试调度 gate 等真实 TS publication 后再调用原 owner，不证明普通 cold diagnostics 自身等待或时延。无 Run 外 owner 预热 |
| 停止与重开 | 真实 RunAssembly 终态 frame 到 KernelClient；撤权 ACK 时实测 writerStopped=false，显式同 owner 排空后 true。Catalog 与 Storage 实际关闭重开，历史、原固定 revision 和修改后的物化文件保留；未声称 LSP 状态跨重启存活 |
| 共享引用 | 前两个测试 Run 刻意保留源引用，证明同环境有引用时共享同一服务；不是普通已完成顺序 Run 必然保温的保证 |
| Child 目录/准入 | 实际 Host model/profile owner 与 Rust descriptors、Catalog freeze/resolve_selection 验默认 Worker、默认只读 Retrieval 和显式隔离语言 profile；不是实际 child LSP 执行 |
| 原共享消费者 | Rust child capability 6 项、language bridge 4 项；真实固定/物化 semantic 1 项、实际 child dispatch/source/retrieval/history/GC 1 项通过。后者不替代 child LSP 执行 |
| 原 Host/UI | 9 个 focused 文件 89 项；source/retrieval/followups 4 文件 24 项；ThreadConversation 82 项；child settle 取消精确用例通过。集合有重叠，不相加为总数 |
| 类型/构建 | Host production/tests、协议生成核对、相关 ESLint；当前 Rust binary、Host declarations/bundle/CLI 与安装布局分别核验 |

独立生命周期探针使用原 owner/supervisor、真实文件系统和受控流协议，覆盖上述
watcher 恢复、跨 view 独立退出、同 Run 重试和跨语言取消。它们不冒充真实 Python
编译器或完整产品 IPC；实际 TS/Storage/历史证据来自上表的 Rust stdio 链。

原 `child-continuation-host.test.ts` 的四个 startup fixture 用例仍失败：它们声明的
fake store 没接入来源 owner，在 prepareChild 前已失败。本片不把该旧文件全套记为通过；
新 settlement 取消用例和原真实 child 来源回归分别通过。既有 diagnostics 用例则改为
真正修改磁盘后观察失效，保留生产中“相同 revision 不重复失效”的行为。

## 复跑入口

使用仓库锁定工具链和已有 bundled TypeScript 资产。先按
[开发说明](../development.md) 构建当前 kernel；`VARIN_TEST_KERNEL_EXECUTABLE` 指向
该二进制。下列原测试采用进程管道/stdin/stdout rendezvous，不启动产品监听器：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel \
  language_source_review::materialized_typescript_dependencies_history_and_shared_process_stop_survive_reopen \
  -- --ignored --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_capabilities::tests
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib language::review_tests
```

Host 的 focused 入口为 `language-owner.test.ts`、`language-bridge.test.ts`、
`lsp/preparation.test.ts`、`lsp/supervisor.test.ts`、`harness/lsp-nav.test.ts`、
`harness/diagnostics-adapter.test.ts`、`tool-composition.test.ts`、
`thread-followups.test.ts`、`documents/watch.test.ts`；依各包 `package.json` 的
Vitest 命令运行。产品 socket/native IPC 用例此次未运行。

## 仍需完成或外部验收

固定分支完整工程/依赖视图、远端一致来源、实际 child LSP 执行、重启后新的 LSP
查询、所有 provider/平台、真实项目规模与完整产品 IPC 分别保留。物化目录不是 OS
sandbox，也不固定目录外配置、symlink 或 compiler libraries。其他 runtime/extension
设计能力继续推进；默认切换、Pi 删除和资产全面迁移由用户验收后负责。
