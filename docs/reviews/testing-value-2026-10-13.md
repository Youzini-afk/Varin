# 测试价值清理：2026-10-13

本轮按当前 owner、真实消费者与失效后果核对全仓测试家族和入口，深入处理下列有依据的局部问题。
这不是逐条审完所有断言、整体性能测量或运行全套测试的声明。入口/构建装配由同轮独立改动处理；
既有 [测试设计](../design/testing-ci-design.md) 与 [历史清理](../archive/testing-ci-audit.md) 仍适用。

## 本次去留

| 处理 | 原因与保留证据 |
| --- | --- |
| 删除 UI 的 `api/files-errors.test.ts`、`api/documents-errors.test.ts`；删除 application-client exports 中重复的 DocumentsError 构造器断言 | 实际所有者是 application-client，UI 文件没有 UI 行为。将已知/未知 reason、HTTP status、错误识别断言归并到 Web `src/api/files.test.ts`、`documents.test.ts` 的真实客户端失败路径。取消、旧 Host 回包、文档 SSE 次序等原用例保留。 |
| 改写 composer `editor/__tests__/dom.test.ts` | 原 mock 无论 selector 都返回可 focus 对象，并断言源码里的同一 selector。真实 DOM 显示它命中同时带两种 data 属性的外层容器。修正 `dom.ts` 的选择器；新用例查询真实 DOM，观察内容节点被 focus、容器未被 focus，并覆盖旧容器形式与未挂载状态。 |
| 缩小 `working-state/draft-baseline.test.ts` 夹具 | 当前 overlay/调用方策略不需要每例启动退休的 TS SQLite catalog 和 WorkingStateStore。改用只保存写入字节的窄回执边界；保留改/增/删、mode、原 source identity、嵌套类型变化、真实 materializer 消费、写入前冲突拒绝。移除只验证旧 TS publish/结果读取/createDraftBaseline 的尾部断言。没有删除或替代 Rust 持久化证据。 |
| 拆开 script-runtime source/dist 执行归属 | `test` 仅执行直接导入 src 的 core/frames 测试，不再内部 tsc 后重复 worker.dist；`test:dist` 继续独占已有编译 worker 行为。未删 worker 行为测试，也未让 dist 隐式重建。 |
| 修 native-process 与 retrieval 测试夹具的失败回收 | 资源一经取得便登记释放；初始化尚未返回就失败时同样回收。单项 teardown 失败不跳过后续资源，并保留原错误与清理错误。测试分别观察真实临时目录删除、调用方 Documents 未被误释放，以及真实 loopback listener 在后续初始化失败后关闭。资源替身只用于故障安排，不代表 Rust/process/模型能力通过。 |

DOM 旧实现对新用例实测 1 fail / 2 pass；失败发生在真正的 editable 节点没有收到 focus。
原测试会错过这个缺陷，影响键盘聚焦、选中内容加入聊天、模型/Agent 控件返回输入框等实际调用方。
这里验证 DOM 选择与调用对象，不声称浏览器原生焦点或特定平台输入行为已经验收。

## 风险到有效测试的地图

| 用户后果 / 风险 | 当前应保留的行为边界与代表入口 |
| --- | --- |
| 输入、队列、终端、导航显示错误或旧异步回包覆盖新选择 | UI 真实 React/DOM 行为与 stores；`ThreadConversation.behavior`、`TerminalView.behavior`、`usePiSessionStore`、document registry。纯 presentation 常量不是同等证据。 |
| HTTP 错误被变成成功空值；Host 切换/取消后旧结果泄漏 | `application-client/test/*-http`、Web `src/api/documents` / `files`，以及 protocol codec/runtime 解码器。不同 transport/consumer 的同类输入不是自动重复。 |
| 权限、身份、作用域或撤权被绕过 | 实际 Host admission/route 与 Rust grant/epoch 消费者；`policy-independent-review.native`、`file-resource-audit.native`、`thread-resource-scope`。不按执行耗时删唯一拒绝/撤权反例。 |
| 编辑丢失、pin 提前释放、重启后重复副作用、错误恢复 | `storage-adapter.native`、`journal-recovery-review.native`、Documents `authority-surface-identity.native`、`kernel-durable-engine.native`。TS 字节 Map / 退休 store 只能支持上层策略安排，不能证明当前存储权威。 |
| 固定来源混入后续父目录、分支或其他环境字节 | `source-inheritance-review.native`、`source-picker-review.native`、working-branch 消费者；本次 draft overlay 是输入变换证据，不替代这些真实 source tests。 |
| 进程尚活着却回收目录、停观察被误当 kill、取消后错误续接 | kernel process / `process-wait-review.native`、shell process-tree 与 managed-process 消费者。控制、输出、退出、目录引用各有独立后果，不能仅因 fixture 相似合并掉。 |
| 扩展准备失败替换了有效世代、更新影响在途调用、释放阻塞无关工作 | extension-host lifecycle/service registry、extension-loader `managed-surface-loader`、真实 policy/extension consumer suites。保留候选准备、旧世代 drain、明确撤权等不同语义。 |
| 原生/发行安装产物缺文件或不可启动 | Electron packaging/runtime、mobile identity、extension-builtins packaging、cloud layout 与实际产物入口。NSIS/app ID/schema 等外部合同可以合法含常量检查，不能仅因读源码而删掉。 |
| Pi worker/原生 runtime 测试看似并行重复 | 当前生产 cutover 尚未完成。Pi session/broker、原生 kernel 和客户端不是同一实现；不凭未来设计删除仍被消费者使用的 Pi 行为。 |

## 仍需注意的缺口

- Markdown 安全现有 `markdownCore.test.ts` 只测 escape helper 与 forbidden-tag 数组，未穿过实际
  `renderMarkdownSync → DOMPurify`。保留现有保护，但它不能证明最终富文本 DOM 安全。
- 巨型 Host orchestration fixtures 中还有故障注入用的 TS storage/surface doubles。不能整体删，
  也不能把它们的成功写作 Rust persistence 或真实 UI 已验证；优先按出现的真实风险迁移到现有 owner/consumer。
- 入口审查发现的 Cargo、专用产物套件发现与重复构建须按实际运行器处理；测试存在不等于默认入口执行。

## 本轮实测边界

- 定点 Vitest：composer 与 Files/Documents 22 项通过；draft baseline 4 项通过；native fixture rollback 3 项、retrieval fixture rollback 2 项通过。
- Script source core/frames 12 项通过。由于当前 checkout 的依赖链接不完整，以相同 source 临时转译后交给 Node test runner，未修改产品 dist；这不是声称原 `--import tsx` 命令或 worker.dist 已执行。
- composer/Web API 与 script-runtime 的定点 TypeScript 检查通过。Host 类型图仍受未安装依赖阻塞，未宣称 Host 全量 type-check 通过。
- 未跑全套、release kernel 重建、实机/物理多机、付费 provider 或安装产物验收；未以 skip 或放宽断言代替这些证据。
