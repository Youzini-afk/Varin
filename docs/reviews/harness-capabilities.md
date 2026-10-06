# Harness 能力与证据明细

Status: evidence inventory — 保留逐能力记录；当前产品概况见 [status](../status.md)，较新的修订优先于旧记录。
Last updated: 2026-10-06

本页从原八列表格整理而来，保留各项的 owner、接线、默认配置、证据和剩余事项。
行内测试名称、数量和验证结论属于其记录时点；本次整理未重新执行全部历史验收。
已确认过时的预设/提示描述在对应条目上方注明当前实现，不将旧测试名单冒充新的运行结果。

## 如何理解记录

| 字段 | 回答的问题 |
| --- | --- |
| Implemented | 是否已有实现；具体测试结果另看证据 |
| Wired | 是否已进入实际生产调用链 |
| Proven evidence | 哪个基线、场景或平台有验证记录 |
| Default-on | 当前或所记录版本是否默认启用，是否需要用户配置 |

这些是不同问题，不是四个可以互换的“完成”等级。已有实现不代表所有平台可用，
没有付费模型测评也不自动否定已经验证的调用链。过时记录需要有来源的修订，而不是改一个勾号。

Owner 中的 host 通常指 Application Host harness/knowledge，pi-host 指 Pi 工具与会话集成，
protocol 指共享协议，ui 指共享客户端。当前 owner 详情从[架构](../architecture.md#authority-map)进入。

## 能力矩阵

按领域展开，每项可单独定位和阅读，不必一次加载整张长表。

### 基础与工具

#### 0.2 恢复 coverage 路径级（R1）

**记录中的状态：** Owner host recovery；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `lib/recovery/engine.test.ts`（partial / none / ready 三态）；
`piRecoveryPolicy.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** —（设计文档状态头已记录 R1 implemented）

#### 0.3 `HARNESS_TOOL_META` 与 unjournalled 判定

**记录中的状态：** Owner protocol / host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `protocol/test/harness-tools.test.ts`；
`turn-coordinator.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** —

#### 1.1 worker→host 请求通道（bridge / router）

**记录中的状态：** Owner protocol / pi-host / host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `pi-host/test/harness/host-services-bridge.test.ts`、`harness-e2e.test.ts`；
`protocol/test/harness.test.ts`（响应关联与失败保留）；
`runtime-broker/test/worker-event-identity.test.ts`；
`host/router.test.ts`、`service-host.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** broker 在 create/open/fork 方法响应后 pin session；
请求 payload 无 sessionId；
Router 只使用 broker Actor，并由 Host 注册表补齐 workspace 与静态能力（D-035）

#### 1.2 Zone 0 字节稳定

**记录中的状态：** Owner pi-host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `pi-host/test/zone0-stability.test.ts`、`pi-hooks-contract.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** —

#### 1.3 `bash` / shell 监督器（D-200 / D-205 / D-206 / D-209）

**记录中的状态：** Owner host / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `terminal/runtime.test.ts`（程序化 create/attach、全局 Harness id、完整创建身份、HTTP 冲突、真实 force-kill/exit）；
`terminal-harness-bridge.test.ts`（同一 handle 上用户附着与 agent 读写）；
`shell-assembly.native.test.ts`（本机真实 Git Bash 后台附着与输入回显、PowerShell 连续调用与非零退出、跨 supervisor id）；
`shell-supervisor.test.ts`（转后台继续采集、自然退出不靠 read、kill 失败、真实退出、迟到/释放失败 writer 保留与重试）；
`openHarnessTerminal.test.ts` / `useTerminalStore.test.ts`（detach tab、不重开）；
`runtime-broker/test/runtime-manager.test.ts`（无选择时用 bundled，显式 system 保持优先）

**降级或替代路径：** Host 不提供能力时保留 Pi 内置；
已配置解释器/设置失败明确 unavailable

**剩余事项与记录边界：** macOS / Linux 真机 smoke 未做；
浏览器完整点击链未跑。bundled Pi 是 runtime 选择，不是 `harness.shell`

#### 1.4 `OutputRef` 与 `tool_result` 截断

**记录中的状态：** Owner host / pi-host / protocol；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/output-store.test.ts`（epoch、HMAC、水位、Unicode）；
`protocol/test/utf8.test.ts`；
`tool-result-truncation.test.ts`；
`harness-e2e.test.ts` #5；
`session-e2e.test.ts`（真实 Pi agent loop：read 大文件只见预览/句柄，再用 get_output UTF-8 分页）

**降级或替代路径：** Pi 默认（结果原样进上下文）

**剩余事项与记录边界：** —

#### 1.5 `grep` 覆盖

**记录中的状态：** Owner host / pi-host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/search-service.test.ts`；
`harness-e2e.test.ts` #4、#6

**降级或替代路径：** Pi 内置 grep

**剩余事项与记录边界：** —

#### 1.6a 按需 `diagnostics`；写入完成后直接返回

**记录中的状态：** Owner host / pi-host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `diagnostics-adapter.test.ts`（真实 fixture LSP 进程、版本化 error→clean、pending/unavailable）；
`session-e2e.test.ts`（真实 Pi agent loop → Host bridge → fixture LSP）；
`output-tools.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** —

#### 1.6b `apply_patch`（Codex 语法，OpenAI 家族）

**记录中的状态：** Owner pi-host；Implemented ✓；Wired ✓；Default-on ✓（仅 OpenAI）。

**保留证据：** `pi-host/test/harness/apply-patch-tool.test.ts`（12 解析用例）

**降级或替代路径：** 不注册

**剩余事项与记录边界：** 多文件回滚未在真会话验证

#### 1.7 workspace 规范路径租约

**记录中的状态：** Owner host / pi-host / protocol；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/path-authority.test.ts`（Documents identity / Windows）；
`path-lock.test.ts`（跨会话、lease ownership、超时）；
`apply-patch-tool.test.ts`（多文件单批）

**降级或替代路径：** —

**剩余事项与记录边界：** 保证仅覆盖同一 Application Host 内由 Harness 管理的写入，不覆盖终端、Git、外部进程或另一 Host（D-036/D-041）

#### 1.8 计数器（toolErrors / toolRetries / outputBytes / observationCalls / cacheHitRatio）

**记录中的状态：** Owner pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `counter-tracker.test.ts`；
`session-e2e.test.ts`（真 Pi 工具失败/重复调用 → SessionStats）；
`harnessCounterPresentation.test.ts`（缺字段不造 0、字节/观察/命中率投影）；
Context sidebar 生产引用

**降级或替代路径：** 非 Pi/Harness runtime 不发布字段则整段不显示

**剩余事项与记录边界：** —

#### 1.9 `HarnessSettings` + 设置页

**记录中的状态：** Owner protocol / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `protocol/test/harness-settings.test.ts`（模型槽位、context/review 设置与用户/workspace 所有权）；
`pi-host/test/harness/session-e2e.test.ts`；
Settings 生产入口

**降级或替代路径：** —

**剩余事项与记录边界：** review 用户所有且默认 `enabled:false, gate:false`；
workspace 值不能放宽用户权限或改绑用户模型/provider

#### 1.10 静态提示片段

**现状修订：** 当前装配：模型输入沿原生系统分段构建；实际工具和启用团队变化可以更新对应段。旧记录的“注册全部工具后 system 不变”不能解释为当前全局不变量。见 [Pi harness](../../packages/pi-host/src/harness/README.md)与 [zone0 测试](../../packages/pi-host/test/zone0-stability.test.ts)。

**记录中的状态：** Owner pi-host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `zone0-stability.test.ts`（注册全部工具后 system 不变）

**降级或替代路径：** —

**剩余事项与记录边界：** —

#### 1.11 工具卡片紧凑渲染

**记录中的状态：** Owner ui；Implemented ✓；Wired ✓；Default-on ✓（live 模式）。

**保留证据：** `toolSummary.test.ts`（摘要、已知只读分组、未知工具不猜只读）；
`PiTimelineEntries.renderMode.test.tsx`（真实 SSR：grep+read 折叠、write 独立）

**降级或替代路径：** 每组/每卡仍可展开完整 arguments/result/details

**剩余事项与记录边界：** sorted 模式已有整段 activity 容器，不做第二层默认折叠（D-048）

### Web 与材料

#### 1b.1 抓取服务（SSRF、重定向、提取、PDF、缓存）

**记录中的状态：** Owner host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/web-fetch.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** —

#### 1b.2 `webfetch` 工具 / session-local reader

**记录中的状态：** Owner pi-host / host；Implemented ✓；Wired ✓；Default-on ✓（fetch；reader 在用户配置槽位后）。

**保留证据：** `webfetch-tool.test.ts`（单次 fetch + reader/fallback）；
`session-e2e.test.ts`（真实 Pi：Host SSRF fetch 一次 → 配置 reader slot → 主回合收到答案）；
`thread-runtime-capability.test.ts`（Host 能力门）

**降级或替代路径：** reader 未配/失败时返回已提取正文，不重复 fetch

**剩余事项与记录边界：** reader 使用 pi-host 的 session model/credential authority；
已删除无调用方的 Host `web.read` 模型栈（D-066）

#### 1b.3 默认网页搜索 / 自配 provider / 原文续读（D-289）

**记录中的状态：** Owner host / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓（无搜索配置即默认可用；可显式关闭）。

**保留证据：** `web-search.test.ts`（免密钥 Exa/Parallel、SSE/结果解析、取消、限流换源、自配不降级、域名策略）；
`session-registration.test.ts`（固定绑定及坏配置）；
`web-search-routes.test.ts`（独立凭据）；
`websearch-tool.test.ts` / `webfetch-tool.test.ts`（空结果、取消与原文查找/行范围）；
`session-e2e.test.ts` default web search（真实 Pi 工具循环、HTTP fixture）；
真实 Exa 查询见上文

**降级或替代路径：** 默认路线明确失败时顺序尝试 Parallel并说明原因；
空结果不换源；
自配服务失败/撤销明确 unavailable 或 error，不静默替换

**剩余事项与记录边界：** 不使用模型账户；
免费额度与网络可达性由供应商/环境决定。设置按 worker generation 冻结。现场外网页面抓取受本机代理 DNS/既有 SSRF 策略阻挡，未宣称全平台页面访问已实测

#### 1b.4 Electron 离屏渲染

**记录中的状态：** Owner electron / host；Implemented ✓；Wired ✓（桌面）；Default-on ✓（桌面，用户开启 `web.render` 后按请求使用）。

**保留证据：** `session-registration.test.ts`（`web.render=false` 时请求不进入 fetch/renderer；
开启时携带冻结策略）；
Electron + Web type-check；
既有 `desktop_web_render` 与 Application Host 共用 `renderDesktopWebPage`

**降级或替代路径：** `renderer-unavailable`；
Web/云 Host 无 renderer 时不伪装成功

**剩余事项与记录边界：** 本轮未跑完整 Electron packaged smoke；
实现复用同一离屏 BrowserWindow helper，不新增第二 renderer

#### 1b.5 来源面板

**记录中的状态：** Owner ui / pi-host；Implemented ✓；Wired ✓；Default-on ✓（有来源时）。

**保留证据：** `harnessWebSources.test.ts`（只接收持久、安全 URL）；
`useWebSourcesStore.test.ts`（稳定去重、pin/remove tombstone）；
webfetch/websearch details → PiChatView transcript projection → session state panel 生产链；
i18n parity

**降级或替代路径：** 无持久 web 工具结果时不显示

**剩余事项与记录边界：** pin/remove 是本地展示状态；
来源权威仍是 Pi transcript，重新打开可重建（D-067）

#### 1b.6 第三方 Web 替换语义

**记录中的状态：** Owner pi-host；Implemented ✓；Wired ✓；Default-on ✓（原生工具按 Harness 设置）。

**保留证据：** `pi-host/test/harness/select-tools-web.test.ts`（安装/存在 `pi-web-access` 不改变原生工具；
显式 `tools.webfetch/websearch=false` 才关闭）

**降级或替代路径：** 用户显式关闭原生同名工具后，普通 Pi package 工具可接管其名称

**剩余事项与记录边界：** 已删除按 `pi-web-access` 包名/启用状态自动让位分支；
包存在本身不再改变运行行为（D-283）

#### 1b.7 Web 配置代际与统一域名策略

**记录中的状态：** Owner protocol / host / pi-host / ui / electron；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `harness-settings.test.ts`（user-owned provider/render、workspace domain 只收紧、显式空 allow=deny-all）；
`session-registration.test.ts`（新旧 generation 绑定、renderer gate）；
`web-search.test.ts`（工具过滤只能继续收紧）；
`web-fetch.test.ts`（初始 URL/重定向前 domain+SSRF、显式空 allow）；
UI type-check + i18n parity

**降级或替代路径：** Host/web renderer/provider 缺失分别表达 unavailable；
不把空/失败塌成成功

**剩余事项与记录边界：** fetch/search 共用冻结的 user/workspace domain ceiling；
删除无生产消费者的 `maxFetchesPerTurn`；
来源面板只接已通过 Host 策略的实际结果（D-283）

### 上下文与知识

#### 2.1 知识库 v1（TriviumDB）

**记录中的状态：** Owner host knowledge；Implemented ✓；Wired ✓（按工作区懒加载）；Default-on ✓（仅被 todo / recall 使用）。

**保留证据：** `knowledge/store.test.ts`（34，含大小写不敏感子串、短词只精确、重开后不重建内存、写入后计数与形状跟随）；
`store.smoke.test.ts`（Node 加载构建产物，CI `test:node-smoke`）

**降级或替代路径：** —

**剩余事项与记录边界：** 钉住 **0.8.6**，`payloadCacheMb: 0`——其解析 payload 缓存把 `getPayload` 变成 O(库大小)，已向作者报告（D-141）。D-019/D-020 在 0.8.6 上核实已修，块/知识/事件的 JS 过滤与 `recall` 的 JS 扫描保留为「可换」。`flush()` 仍随库线性增长（两版一致），D-140 去抖保留。Electron asar 打包 smoke 未做；
v9 格式与 `.pld` sidecar 只在测试临时库上验证

#### 2.2 Zone 2 组装

**记录中的状态：** Owner host / pi-host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/zone2.test.ts`（含 `</user-terminal>` 不能拆段）；
`knowledge/context-runtime.test.ts`（用户命令进 Zone 2、harness 过滤、两个目标 Pi session 各自入库、per-target 去重、游标不倒退）；
`pi-host/test/harness/session-e2e.test.ts`（Documents 用户写入与用户终端命令在下一真实 Pi turn 出现、event cursor 不重复、system 不变）

**降级或替代路径：** 无材料时不追加消息

**剩余事项与记录边界：** Git 与 prompt-relevant accepted knowledge 已接。无 shell integration 时不造 `<user-terminal>` 伪命令。D-233 纠正结构编码、per-target 持久幂等与退出事实；
不得标 Proven

#### 2.3 host 观察者

**记录中的状态：** Owner host knowledge；Implemented ✓；Wired ✓（Documents + user-change LSP + Git status + user-terminal 带代际 OSC）；Default-on ✓。

**保留证据：** `documents/authority.test.ts`（提交后通知且观察失败不反噬写入）；
`knowledge/context-runtime.test.ts`（多会话 fan-out、agent 过滤、诊断因果、raw Git status → workspace → event → Zone 2 与去重、用户终端按目标 Pi session 持久化且重复 delivery 最多 nudge 一次）；
`terminal-projection.test.ts`（user/harness 分流、nudge 失败不反噬、重复 commandId 不 nudge）；
`store.test.ts`（`putEvent` 按 target Pi session + commandId 的持久索引在单写队列内幂等并回填旧行）；
`git-status.test.ts` / `git-status-runtime.test.ts`；
`git/routes.test.ts` / `workspace-routes.test.ts`；
`session-e2e.test.ts`（Documents 与 user-terminal 纵切）；
`terminal/shell-integration.test.ts`（只接受本代际标识帧）；
`shell-integration-scripts.test.ts`（`sh` 不注入、Bash/zsh/PowerShell 保留用户 hook、Windows PowerShell native/cmdlet/重复同码归属）；
`runtime.test.ts`（只注入 user、untagged OSC 不生成命令、`/bin/sh` 无 `--init-file`、restart 后新 zsh D 不结算旧命令且下一 commandId 属新 generation）

**降级或替代路径：** 观察失败只降级本轮上下文并记录 Host 错误；
不新增 Git 轮询；
无 integration 为 not-observed

**剩余事项与记录边界：** Git 外部变化在现有 status 下一次刷新时可见，不声称后台实时；
Harness shell / agent 自身事件不重复进 Zone 2（D-054）。D-233 纠正命令事实后不得标 Proven。zsh / macOS / Linux 用户终端与完整桌面 Host 重启仅未实测；
不声称 Host 重启去重

#### 2.4 记忆 keeper（off / assist / takeover）

**记录中的状态：** Owner —；Implemented 已删除（D-284）；Wired —；Default-on —。

**保留证据：** 生产路径已移除：keeper 扩展、coverage 接管、memory_edit、nudge 链、memory-mode UI 与 `memory.blocks.*`/`compaction.before` 服务；
既有测试证据只属历史

**降级或替代路径：** —

**剩余事项与记录边界：** 由 2.4A/B 与 2.6A/B 行取代；
plans/todos/用户笔记/accepted knowledge 保留

#### 2.5 `todo` / `plan` 块

**记录中的状态：** Owner host / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/todo-tool.test.ts`（confidence 不改变写入）；
`pi-host/test/harness/todo-tool.test.ts`（工具不弹写后确认、不发送确认字段）；
`phase2-e2e.test.ts`；
session state 侧栏可见可编辑（D-046）

**降级或替代路径：** 不注册

**剩余事项与记录边界：** confidence 只作信息。需要批准时由既有 pre-tool plan/permission 流程处理；
`todo.upsert` 没有第二确认协议（D-206/D-209）

#### 2.6 接管压缩

**记录中的状态：** Owner —；Implemented 已删除（D-284）；Wired —；Default-on —。

**保留证据：** coverage 接管扩展与 Host compaction.before 服务已移除；
压缩由 Pi 触发、context-preparation 候选提交

**降级或替代路径：** —

**剩余事项与记录边界：** 由 2.4A/B 与 2.6A/B 行取代

#### 2.7 Agent 轻记忆与系统提示词

**记录中的状态：** Owner host / ui / pi-host / kernel；Implemented ✓；Wired ✓（全局、项目、会话管理；内置提示词可编辑）；Default-on ✓。

**保留证据：** `agent-personalization.native.test.ts`（Rust 持久化、范围隔离、旧版本拒绝、选择保存/撤销）；
`session-e2e.test.ts`（真实 Pi 请求中的新指令与记忆、Bot 隔离）；
`AgentSettings.behavior.test.tsx`（官方文本编辑与范围）

**降级或替代路径：** 普通 Agent 直接加载记忆，无 recall 和后台整理；
Bot 保留独立长期记忆

**剩余事项与记录边界：** 旧 KnowledgeSettings/catalog 已删除；
未运行图形应用及付费模型验证。详见 memory/DOCUMENTATION.md

#### 2.8 知识库语义召回（D-196 / D-198）

**记录中的状态：** Owner host knowledge；Implemented ✓；Wired ✓；Default-on ✓（未配远程保持文本；有效配置启用派生向量）。

**保留证据：** `knowledge-recall.test.ts`（向量命中、范围/状态/修订、完整长条目分块、换空间）；
`vectors/acceptance.test.ts`（自动维度、绑定异常保留文本、不自循环重试、并发 bootstrap 不串 query、resolver 取消/关闭）；
`knowledge-services.test.ts`（actor 工作区传递、公开 recall / Zone 2 取消）；
知识库 134 项及新增边界/公开接线 9 项通过

**降级或替代路径：** failed/unavailable/partial/empty 分列，绑定解析异常也保留文本

**剩余事项与记录边界：** 复用共享代际库、chunker、缓存与调度；
受影响 id 即时失效，配置刷新与关闭已接。证据来自真实模块和 faux provider，不证明完整桌面 IPC 或真实外部质量；
权威 `.tdb` 不变，不回退 MiniLM

#### 2.9 普通模型槽位

**记录中的状态：** Owner protocol / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓（依赖能力各自按配置启用）。

**保留证据：** `protocol/test/harness-model-slots.test.ts`、`roles.test.ts`；
`pi-host/test/harness/session-e2e.test.ts`（reader / permissionJudge 实际功能调用）；
Harness Settings 生产入口

**降级或替代路径：** 未配置辅助槽位不注册或走无 LLM 路径；
仅 hardImplement / review 明示回退主模型

**剩余事项与记录边界：** 当前普通槽位不含 embedding/rerank；
后者是独立配置种类（3.16B/E）。聊天模型列表仍依赖 Pi session。三套预设只填空槽位；
D-080 的普通会话统计与 ThreadRun 记录保持

#### 2.10 `recall`

**记录中的状态：** Owner host / pi-host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `host/recall-tool.test.ts`（workspace + user 合并）；
`store.test.ts`（停用后 reopen 不再召回旧正文）；
`phase2-e2e.test.ts`

**降级或替代路径：** 不注册

**剩余事项与记录边界：** Application Host 已懒加载 `user.tdb`；
Settings 目录与公开 recall 共用同一权威。suggested/dismissed/retired 不进入有效召回

#### 2.11 会话下一步选择（D-325）

**记录中的状态：** Owner protocol / application-host / pi-host / ui；Implemented ✓；Wired ✓；Default-on —（用户显式启用且绑定 `models.nextStep` 后）。

**保留证据：** `runtime.test.ts`（默认关闭、单次调用、多候选、空结果与重复去重）；
`protocol/test/session-features.test.ts`、`pi-host/test/session-features.test.ts`（候选数组与持久空结果标记）；
`harness-settings.test.ts`（用户级启用、workspace 不能打开）；
Harness Settings 与 PiAssistBar 生产入口；
protocol/web/pi-host type-check

**降级或替代路径：** 未启用、未绑定或模型失败不调用/不影响主会话；
零候选持久标记；
迟到结果丢弃；
点击只填草稿

**剩余事项与记录边界：** 真实模型质量、延迟和完整桌面纵切未测；
不把 faux 文本当质量证明

#### 2.4A/B（D-284） 请求预算与后台摘要准备

**记录中的状态：** Owner pi-host / protocol；Implemented ✓；Wired ✓；Default-on ✓（`harness.context.preparation.enabled` 默认开，可独立关闭）。

**保留证据：** `context-preparation.test.ts`（12：水位下不准备、固定范围/分支/模型绑定、候选失效条件、在飞复用、split-turn 前缀、失败后不卡死）；
`session-e2e.test.ts` context preparation 链（真 Pi+faux：后台摘要挂起时前台回合完成、压缩复用候选不二次摘要、schema-only 工具+toolChoice none+无执行器、同 system prompt）

**降级或替代路径：** 候选缺失/失效时同步准备；
摘要失败不截断历史、不带病提交

**剩余事项与记录边界：** 软水位 75%/规划目标 60% 为可配置默认非实测最优；
faux 不证明真实模型质量或缓存收益；
第二次准备由压缩后仍超水位触发属合法行为

#### 2.6A/B（D-284） 按需切换、history 与旧消费者收口

**记录中的状态：** Owner pi-host / host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** 同上 e2e（压缩提交→`compaction.after`→history 读回被摘要原文→后续真实回合用回读材料）；
`history-fresh.test.ts`（10：分支总览、原文回读、query+path 过滤、未知 entry、上限提示）；
keeper/coverage/memory_edit/memory-mode UI/旧协议字段与 `memory.blocks.*`/`compaction.before` 服务已删除

**降级或替代路径：** 容量不足候选未完则等待同次调用，不先截断；
摘要请求自身超窗沿同一机制收束

**剩余事项与记录边界：** Zone 2/知识/线程观察基线只在真实 `session_compact` 后重置，候选 ready 不动游标；
retired `memory.mode:"off"` 作为迁移读关闭后台准备

#### 上下文完整取舍/fresh（D-286 / D-287）

**记录中的状态：** Owner pi-host / host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `inherited-input.acceptance.test.ts`（真 Pi active context、工具正文/图片/输出复制与派发时冻结）；
`fresh-history.acceptance.test.ts`（新 Run → 同 Thread 旧 Run 授权 history 回读）；
`history-fresh.test.ts`（结构化输入与分页）

**降级或替代路径：** —

**剩余事项与记录边界：** 不依赖新评分/清洗模型；
真实 provider 的摘要质量和缓存收益仍是使用观察，不是调用链接线证据

### 检索与语言

#### 3.1 符号图采集器与查询

**记录中的状态：** Owner host knowledge；Implemented ✓；Wired ✓（defines + imports/connects/associates + 解析出的 references/calls；explore 路径候选 + 摘录注解 + `related`）；Default-on ✓（随 Documents mutation + 打开后火忘冷扫描；resolved 行由查询期 collector 与 lsp 导航回写）。

**保留证据：** `knowledge/store.test.ts`（节点/边、代际、match、反向 import、紧凑候选 close/reopen 后补关系；
resolved relation 行的固定/未固定、重解析替换、目标删除级联、staleTarget、generation 消亡；
D-246 anchor 批次重解析两缩一缩空、不同 anchor 隔离）；
`knowledge/relations.test.ts`（真 supervisor+fixture 的 collect→持久化、piggyback record、无库降级）；
`import-resolve.test.ts`；
`symbol-runtime.test.ts`；
`catalog-scan.native.test.ts`（并发扫描合并、无事件正文修改后重扫、连接移除/恢复、不重采集消费文件）；
`typescript-service.test.ts`（D-246：显式根、嵌套首文件 cross-file caller、无根回退 cwd 不猜、setWorkspaceRoot 生命周期）；
`related-scope.test.ts`（D-246：scope 过滤定义/引用/importers/connections、anchor 外拒绝、partial 组合状态、pathInRoots 一致性）

**降级或替代路径：** 未知语言只 touch file；
结构 unavailable 保留最后图；
范围绑定磁盘 revision，脏缓冲不入图——resolved 行同样只持久化磁盘绑定答案，跨文件站点一律 unpinned、目标 revision 移动报 staleTarget（D-240）。未确认关联仅存在 file metadata，不建 link 节点

**剩余事项与记录边界：** D-236 已移除同名闸门再访的重读/重解析；
extractor 3 使旧目录下次重采集。当前 2520 文件冷建 185767.1 ms、显式未变重扫 10314.095 ms，详见下方观察；
没有同语料改前对照。D-140/D-141 的 18.4/4.8 分钟保留为历史。仍不冷启 LSP——resolved 行只在真实查询驱动下由已运行的语言视图产生；
目录限 TS/TSX/JS/JSX。D-237 已补完整重扫的外部删除对账：missing 确认、代际条件删除与排队取消；
失败/截断/未知 inventory 保留旧图。D-240 已接 references/calls 边与 relation collector；
D-246 返工修正 LSP 根推断（来自 initialize 而非首个文件父目录）、related/explore actor scope 贯穿、权威 anchor 批次重解析（清掉消失 site）、partial 组合状态、explore 公开链暴露 findReferences/findCallers/findCalls；
PageRank/多跳仍未做。完整桌面冷建未实测

#### 3.15 快速 explore：查询上下文、分组计划、成组选段与局部补查（D-175–D-189）

**记录中的状态：** Owner protocol / host / pi-host；Implemented ✓；Wired ✓；Default-on ✓（公开 `explore` 默认；配置 `models.explore` 后同一路径启用模型，未配置保留算法/向量）。

**保留证据：** `explore-query-run.test.ts`（start 到达即读、原问题词法与慢语义并行、同文件晚到语义重建、稳定 viewId、required 组、单元来源排名、来源终态与冻结）；
`explore-query-services.test.ts`（固定来源、完整 actor、受限 scope、取消与响应未送达、fixed roots 传递）；
`router.test.ts` / `service-host.test.ts`（授权 cancel、request actor key、session 换代清理）；
`semantic/runtime.native.test.ts`（查询取消停止等待）；
`explore-model.test.ts` / `explore-tool.test.ts` / `host-services-bridge.test.ts`（模型输入、Host accepted、补查失败保留首选、timeout/dispose 实传 cancel）；
`session-e2e.test.ts`「runs plan expressions through ModelRuntime…」（公开 `explore` → `completeSimple` → 新表达搜索 → 最终原文）；
`knowledge/store.test.ts` / `knowledge/semantic/store.test.ts`（scope 内 Top-K、`.` 快路径、文档更新删除）

**降级或替代路径：** 未配置或调用失败保留已取得材料，不回退主模型；
取消/失败/不可用/无命中/截止未完成分列

**剩余事项与记录边界：** 真实 `models.explore` 质量与墙钟未观察，不作为启用门。120s/8s 是尚未按真实 provider 定标的工作预算，不是 SLO。D-189 已让受限 scope 的图/向量后端在有效 roots 内计算 Top-K，reverse importer 在截断前过滤；
`.` / 空 roots 保留未受限语义快路径。native ONNX 当前批不能被 JS signal 硬抢占，取消会停止等待并丢弃迟到结果。远程嵌入、向量复用、语义草稿覆盖与专用 reranker 见 3.16B–E；
router 取消与超时目前同为 `timeout` 码；
`harness-e2e` #3 是既有 D-103

#### 3.16B 远程 embedding 配置、后台绑定与 OpenAI 兼容调用（D-190）

**记录中的状态：** Owner protocol / pi-host / host / ui；Implemented ✓；Wired ✓；Default-on ✓（配置有效即走远程同一 space；未配置时仅在用户已安装本地组件后使用 MiniLM，D-288）。

**保留证据：** `protocol/test/harness-settings.test.ts`（workspace 不能留下 embedding/rerank）；
`pi-host/test/harness/openai-embeddings.test.ts`（乱序/缺项/维度/NaN/取消）；
`pi-host/test/harness/background-inference.test.ts`（user/operator-only resolver、项目 provider 重定向隔离、binding 竞态、cancel→fetch、endpoint/credential space）；
`semantic/harness-316.native.test.ts`；
`session-e2e.test.ts`（旧手工 consumer 链）；
`semantic-workspace.e2e.test.ts`（D-235：共用生产装配、真实 SessionHost/HTTP adapter、双执行目录路由、无效配置/失败状态）；
`workspace-runtime.native.test.ts`（配置与取消生命周期）

**降级或替代路径：** 远程失败/未绑定 Pi：语义 `failed`/`unavailable`，词法与图继续；
同一查询不静默切回本地 MiniLM

**剩余事项与记录边界：** 真实远程 provider 延迟、质量、成本未观察，不作为启用门。知识库语义召回已按 2.8 / D-196 单独接线，不回退 MiniLM。Host 从不接收或持久化 provider secret

#### 3.16C 向量复用、完整编码与前台优先（D-191）

**记录中的状态：** Owner host；Implemented ✓；Wired ✓；Default-on ✓（随语义索引）。

**保留证据：** `semantic/harness-316.native.test.ts`（embedText 复用、单块重嵌、并发扫描合并、前台插队、partial 首发、迟到 revision、scoped 缓存仍做授权 Top-K）；
`semantic/chunker.test.ts`（超长单行续切、多块覆盖无缺口）；
`semantic/minilm.test.ts`（Node ORT session 线程）

**降级或替代路径：** 缓存满按字节软预算淘汰，不拒绝查询；
后台当前批完成后前台优先

**剩余事项与记录边界：** 完整冷扫墙钟仍未量得（沿用 3.16A）。远程 Host 侧按字符长度续切，不是远程 tokenizer 精确计数

#### 3.16D 固定草稿与线程分支语义覆盖（D-192）

**记录中的状态：** Owner host；Implemented ✓；Wired ✓；Default-on ✓（公开 explore 的 `semanticRecall`）。

**保留证据：** `semantic/harness-316.native.test.ts`（立即遮蔽、dirty-only、删除、supersede、捕获后继续编辑、兄弟线程隔离、缺向量≠缺正文）

**降级或替代路径：** 草稿/线程向量未完成：语义 gap/partial，词法与读取继续用已固定原文

**剩余事项与记录边界：** 物化 child 使用自身 Documents workspace，virtual 使用固定 WorkingBranch；
copyIgnored 不自动扩大范围。D-235 公开 SessionHost 纵切已覆盖原生写入通知、后台发布后同回合 explore；
完整 nested dispatch/桌面启动未测

#### 3.16E 专用 HTTP reranker（D-193）

**记录中的状态：** Owner protocol / pi-host / host / ui；Implemented ✓；Wired ✓；Default-on ✓（`harness.rerank` 有效且本轮未用 LLM 选择时）。

**保留证据：** `pi-host/test/harness/http-rerank.test.ts`（非法/缺失 ID、部分响应）；
`explore-rerank.test.ts`；
`explore-query-services.test.ts`（select=used 不调用、select=unconfigured 调用）；
`session-e2e.test.ts`（旧手工 consumer 链）；
`semantic-workspace.e2e.test.ts`（D-235 共用生产装配 → 真实 Pi `/rerank` adapter，结构化状态为 used）

**降级或替代路径：** 失败保留来源排名与可读材料，details 标明未参与/失败；
explore 整体不失败

**剩余事项与记录边界：** 真实 rerank provider 质量与费用未观察。当前 registry 无标准 rerank 方法，使用可配置 HTTP `/rerank` 契约，不把 chat/embeddings 改名为 rerank

#### 3.2 `explore` + `grep` + `read` + `find`/`ls` 的磁盘/发起窗口草稿纵切；根会话 `edit`/`write`/`apply_patch` 写回同一缓冲（D-225 / D-228 / D-232 纠正身份、WAL 与补偿）

**记录中的状态：** Owner pi-host tool / host Engine / Documents / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `explore.native.test.ts`；
`explore-service.native.test.ts`；
`search-service.test.ts` / `search/content.test.ts`（dirty 排除先于有界 cap、regex/fixed/case/glob/context、写入后该路径改按磁盘搜索）；
`document-read-source.native.test.ts`（固定字节、BOM、dirty-only、过期、写后读回自己的写；
经 router 写缓冲后同一回合 read 见新正文）/ `pi-host/test/harness/read-tool.test.ts`（原生分页与图片）；
`documents/authority.test.ts`（写入失效：原生写、Documents 写、根外路径不失效、过期仍不回退磁盘、overlay 与 clone 同步；
缓冲写、二次 edit、用户续编 conflict）；
`documents/authority-surface-identity.native.test.ts`（CRLF 二次 edit + apply_patch 不改盘、两 surface 路径一次 Registry undo、UTF-16/BOM 字节恢复、重开 catalog 为 compensated/needs-attention、owner 不可用不对账猜成功）；
`documents/surface-mutation.test.ts`（共享计划、同一 operationId 整组 undo、前向 abort 后补偿用新 signal、delete/NUL unavailable）；
`recovery/turn-coordinator.test.ts`（确认工具前 await，before/失败不失效）；
`document-path-overlay.test.ts`；
`find-ls-tool.test.ts`；
`workspace-mutation-journal.test.ts`（surface 不 journal、普通路径仍 journal）；
`apply-patch-tool.test.ts`（surface 匹配不写盘且携带 revision/hash、readSource unavailable 即使磁盘可匹配也不写、混合失败诚实状态）；
`session-e2e.test.ts` 固定 surface find/ls 与「fixed surface edit」公开 Pi edit → Host → Registry

**降级或替代路径：** 已知 dirty capture 不可用时相关 read/search/find/ls/LSP 导航都不读磁盘；
其余路径继续 disk；
Host 未声明对应 capability 时保留 Pi built-in。D-225/D-228/D-232：snapshot 拥有的路径写 Registry 缓冲，不隐式保存；
用户续编 conflict 保留其正文；
混合写入先预检全部磁盘成员并持久记录外部阶段。磁盘写到 target-after 捕获之间崩溃仍明确 needs-attention，不冒充自动恢复

**剩余事项与记录边界：** D-090 第一组已验证：`limit` 只管输出条数（`explore.native.test.ts` T1）；
search-service 收 actor/inputContext，explore 不再自带草稿匹配（`explore-service.native.test.ts` T2）；
词项分组与 anchors 字面优先、非硬过滤（T3/T4）；
测试路径不默认降权（T5）；
按需物化记 `not-requested`（T6）；
互补打包（T7）；
自身字节预算与句柄（T8）；
工具接受并转发 `anchors`（`explore-tool.test.ts` / `session-e2e.test.ts` T9）。D-092 已验证：候选模式 30 个匹配文件×每文件 12 命中、预算 200 时 30 个文件都进候选且总命中 ≤ 200，路径序最后的文件仍在（`search-service.test.ts` breadth-first）；
文件数超过预算时报 `filesDropped` 且与命中裁剪分列；
grep 同输入仍是默认 limit 100 的深度优先截断。六个小项已收：`showHandle` 为真时 `result.text` ≤ `byteBudget`（`explore.native.test.ts` / `explore-service.native.test.ts` T8）；
返回对象不含 `searchIncomplete`；
空白 anchor 过滤后 `supplied` 保留原样（`explore-service.native.test.ts`）；
每路 `rgSearch` 用局部 partial；
`fileScore` 每文件一次；
一个 anchor 文件排在只匹配 3 个拆词组的文件之前。验收复验补的两项已修并有断言：`filesDropped` 取单次查询最大值作下界（`explore.native.test.ts` 跨词项不求和、`explore-service.native.test.ts` 250 文件 × 两个重叠根仍报 50 而非 100，正文"at least"）；
工具 schema 接受空白 anchor 交由 Host 过滤（`explore-tool.test.ts` 对 `tool.parameters` 直接 `Value.Check`，非字符串仍拒）。D-232 的生产链与定向反例已接，但磁盘写成功到 target-after 捕获之间仍以 needs-attention 收口；
完整桌面 Registry、生产 Host 进程重启对账与 macOS/Linux 会话未实测，3.2 写入纵切不得标 Proven。证据见 D-228/D-232 记录。之后：结构切片消费 6.4 带修订范围、上下文覆盖、模型增强

#### 3.3 `related`

**记录中的状态：** Owner host / pi-host / protocol；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `related-tool.test.ts`（Host：没有 vs 不完整、反向 import、空目录 vs 未收录、未解析 specifier；
resolved references/callers/callees 段与状态）；
`pi-host/test/harness/related-tool.test.ts`（默认注册、`tools.related: false` 省略）；
`session-e2e.test.ts`「session e2e — related」（真 Pi：`activeTools` 含 `related`，已打开 store 返回定义/Imported by，正文含 `lsp.references` 分工、不含 rank）

**降级或替代路径：** store 未打开 → `unavailable`（不开库）；
空目录 / 未收录路径 / 名字未命中 → `empty`；
查询抛错 → `failed`；
relation 段按 per-source 状态区分 ready/empty/unavailable/unsupported/partial/failed

**剩余事项与记录边界：** 名字锚点现在对每个定义做一次有界 references+definition+callHierarchy 解析并把结果写回图（D-240）；
路径锚点回答本文件已存站点与指向本文件的 call 边。不做 PageRank / 多跳。目录未扫到的语言是不完整或 empty，不是失败

#### 3.8 LSP 导航工具与按来源隔离的语言视图

**记录中的状态：** Owner protocol / host / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓（Web/Application Host）。

**保留证据：** `host/lsp/supervisor.test.ts`（视图隔离、Host 单调版本、同修订不重发、`expectedRevision` stale、关标签页不动 agent 视图、LRU 上限与空闲释放；
callHierarchy 三方法与按会话 item token、能力缺失报 unsupported）；
`host/lsp-nav.test.ts`（真实 fixture 进程下 `surface` 保持 absent、固定草稿、草稿不可用不回退磁盘、`unpinned`、stale 重试一次、一基位置/三态；
磁盘绑定结果写回图谱、草稿绑定不写回）；
`host/lsp/typescript-smoke.test.ts`（真 TypeScript server：跨文件 references 与双向 callHierarchy）；
`diagnostics-adapter.test.ts`（磁盘修订随写入变化、后缀同名不串台、pending）；
`knowledge/symbol-runtime.test.ts` / `store.test.ts`（符号行携带 revision、空修订被拒）；
`ui/language-id.test.ts`（单一身份表）；
`lsp-tools.test.ts`；
`thread-runtime-capability.test.ts`（握手能力门）

**降级或替代路径：** Host 不声明 `harnessLspNavigation` 时四个工具不注册；
agent 视图惰性起进程、空闲释放，占用可由 `inspectViews()` 查询

**剩余事项与记录边界：** `symbols` 需一个代表文件路径来选择语言 provider；
未知后缀明确 unavailable（D-051）。跨文件位置只能标 `unpinned`：LSP 不报告它自读文件的版本，且可用的 Documents mutation 观察不覆盖 Pi 原生写入，因此不做 stale 判定。`explore` 结构展开尚未消费带修订的符号范围；
Host 视图占用尚无 UI 呈现。隔离线程因自身 workspaceId 各有一个语言服务器进程，进程复用不在 D-087 范围内。D-240：磁盘绑定的 lsp.references/lsp.definition 结果经 `recordRelations` 写回符号图（D-240），callHierarchy 能力已声明并映射

### 工作状态与协作

#### 3.18A–E（D-285 / D-287） 可续做任务线程与定向协作

**记录中的状态：** Owner protocol / pi-host / host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** 既有 protocol/service/runtime/registry/dequeue/route 证据；
新增 `thread-admission.acceptance.test.ts`、`thread-wait-admission.acceptance.test.ts`、`thread-message-identity.acceptance.test.ts`、`thread-delivery.acceptance.test.ts`、`thread-runtime-session.e2e.test.ts`（同根原子准入、非唤醒 inform、native request receipt、消息幂等/回复身份、旧结果跨 Run 可读与公开连续交付）；
物化更新见 `materialized-baseline-update.acceptance.native.test.ts`

**降级或替代路径：** —

**剩余事项与记录边界：** Run 配置由每次 Run 冻结并被 spawn/dequeue/resume/restore/continue/fresh 消费；
旧 role/send/per-parent 路径已删除

#### 3.4 / 3.5 原生线程运行时与 7 个工具

**现状修订：** 旧标题中的“7 个工具”属于早期接口清单；当前协作还包含选定代码提交、任务等待和会话互读，以 [D-339](../design/agent-collaboration-design.md)和实际 registry 为准。

**记录中的状态：** Owner protocol / broker / host / pi-host；Implemented ✓；Wired Partial；Default-on —。

**保留证据：** `workspace-identity.native.test.ts`（Documents 给原目录与 scratch 不同 workspaceId；
session.create + Harness router + 公开 dispatch 建孙线程；
孙写入 owning catalog 且 `parent.kind` 为父 Thread；
threads/wait/Zone 2/lost resume 看直接子层）；
`thread-registry.test.ts`（session binding 重启后仍指向 owning workspace；
catalog 无 binding 可重建；
stale binding 拒绝）；
`thread-services.test.ts` / `zone2-threads.test.ts`（execution workspaceId 不能冒充 owning catalog；
binding 无 owner 拒绝 thread tool；
生产 `thread.kill` → runtime cascade 含 queued 子孙；
`src/foo..bar` / `version...txt` 经 dispatch 接受；
非法 scope 带草稿 cleanup）；
`dequeue-permissions.test.ts`（生产 `onThreadDequeued` → `session.create` 带 accept-edits，live bypass 不能放宽）；
`knowledge-owning.test.ts`（owning≠execution 时 recall/suggest/Zone 2 打 owning store）；
`thread-worktree.test.ts`（父 worktree 内独立 `git init` 持久化 `executionBaseline`，inspect 不对该执行 SHA 报 bad object）；
`working-state/execution-baseline.test.ts`（Git 父仓库 isolated dispatch → `document.branchWrite` → `workingBranch.ensureMaterialized` → shell 写 → settle/drain → native result → merge 根目录；
reclaim/rematerialize 不引用已删子仓库对象；
staging-promoted 恢复写出可解析 execution baseline）；
`working-branch-view.test.ts`（lease 后重读正文与 `@revision`；
`explore.query.start` pin 后词法/原文/语义仍用快照）；
`thread-runtime.test.ts`（create 传入冻结 permissions；
dirty 文件内容中途替换且路径集合不变时 `baseline-changed` 且不留 branch；
kill 取消在飞 preparation；
archive 先归档子孙；
父 archive/kill 与子 restore/merge 并发不复活、不留活跃 Run）

**降级或替代路径：** Host 未声明 harnessThreads 时不注册

**剩余事项与记录边界：** D-216–D-224 已接线 owning/execution、执行 Git baseline、查询级固定视图、dispatch 内容身份、branch Integration WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle serialization 与 scope 完整 `..` 段。D-231 已补 retrieval 受管 scratch、持久 managedRoot 与 Host/backend 再授权；
旧记录缺根时拒绝自动动作。真实付费嵌套 Pi 与完整桌面重启未测。`nested-threads.test.ts` 中部分 fixture 把 `resolveRuntimeWorkspaceId` 钉成同一个 `"ws"`，这部分不能作为 owning/execution 身份证据

#### 3.6 执行预设目录 / 团队提示

**现状修订：** 2026-10-06 核对：常规内置预设现为 Worker 与 retrieval，旧 hard-implement/frontend/review/check 列表仅属此前记录。团队指导来自当前允许的 dispatch 工具和可用配置。当前实现见 [预设目录](../../packages/protocol/src/harness-presets.ts)、[线程工具](../../packages/pi-host/src/harness/thread-tools.ts)，已有验收见 [D-339](../design/agent-collaboration-design.md)。

**记录中的状态：** Owner protocol / pi-host / host；Implemented ✓；Wired Partial；Default-on —。

**保留证据：** `host/presets.test.ts`（hard-implement/frontend 含 nest 工具，review/retrieval 不含 dispatch；
retrieval 含 submit_facts / explore，不含 bash/edit/write）；
`thread-services.test.ts`（未授权 dispatch 拒绝、binding 无 owner 拒绝、生产 kill cascade、dotted relative scope 接受、retrieval 无 model 拒绝、`carryBlocks: false`）；
`workspace-identity.native.test.ts`（execution workspaceId 下公开 dispatch 仍写入 owning catalog）；
`dequeue-permissions.test.ts`（queued dequeue 把 accept-edits 送进 session.create）；
`nested-threads.test.ts`（captureScopes 继承父冻结范围）；
`protocol/test/permission-gate.test.ts`（缺省 overlay 冻结为 normal；
accept-edits 不被 live bypass 放宽）

**降级或替代路径：** 未配置槽位的预设不出现；
无 nest 工具的预设不能嵌套

**剩余事项与记录边界：** D-285 已把必填 role 改为可选 preset 并去掉便宜/强标签，预设 allowlist 保留。D-219 / D-222 / D-223 已接线冻结 overlay、dequeue 生产回调、级联 lifecycle serialization 与 scope 完整 `..` 段。D-227 已把 retrieval 做成事实 Thread；
D-231/D-234 补受管输入与耐久证据，见下一行。真实付费嵌套 Pi 会话未测

#### 3.6 retrieval 长任务事实检索（D-227 / D-230 / D-231 / D-234）

**记录中的状态：** Owner protocol / host / pi-host；Implemented ✓；Wired Partial（faux 公开纵切与定向反例已接线；真实付费 retrieval 与完整桌面重启未测）；Default-on ✓（配置 `models.retrievalAgent` 后同一 dispatch 路径启用；未配置不注册）。

**保留证据：** `protocol/test/harness-threads.test.ts`（`thread.facts.set` 方法表、seal 不发明 source-checked、question 用 brief、completion 为 delivered）；
`retrieval-evidence.test.ts`（无关 claim 只 source-checked、顺序无关聚合、短 URL receipt、换绑 URL 拒绝、耐久 excerpt、output handle 复制后 dropSession 仍可读、后续磁盘变化不丢当时身份）；
`thread-facts.test.ts`（child 校验、settle 去掉建议字段、cancel 保留 facts、lost 保留 pending 且新 Run 清空、deferred-reader settle 与 lost→resume 拒绝旧 submit）；
`retrieval-artifacts.test.ts`（重开 catalog 仍可读 excerpt）；
`nested-threads.test.ts`（retrieval dispatch 在返回/排队前沿正常 isolated 分支固定父虚拟或物化状态，不回根 live）；
`thread-worktree.test.ts` / `materialization-switch.test.ts`（持久 managedRoot、归属拒绝、只读输入物化/回收）；
`web-fetch.test.ts`（仅 active retrieval 请求可得耐久 receipt；
普通 fetch 不铸 receipt；
取消不缓存）；
`thread-services.test.ts`（无 model 拒绝）；
`select-tools-web.test.ts`（根会话不注册 submit_facts）；
`retrieval-session.e2e.test.ts`（父公开 dispatch → 真 child SessionHost → explore/read/related/submit_facts → settle → Zone 2 / wait / read_thread；
outside 不进 facts；
invented range 不 source-checked；
不写盘；
不复制父对话）

**降级或替代路径：** 未配置槽位：角色不出现且 Host 拒绝无 model 的 retrieval dispatch，不借主模型。scope 外/不存在/越界不得标 source-checked。无 bash，故默认不能改工作区

**剩余事项与记录边界：** D-231/D-234 的生产链与定向反例已接，但不得标 Proven。旧 worktree 记录缺 managedRoot 时拒绝自动动作；
不把 faux provider 写成真实模型质量。webfetch/websearch 仅 Host 已装配时可用。取消/失联复用既有 Thread 生命周期。不预加载整仓，不新建向量库或 daemon。真实付费 retrieval、完整桌面 Host 重启、授权 web 抓取仅未实测

#### 3.7 按需审阅 Agent

**现状修订：** 当前审阅工作通过普通 Worker/用户配置派发，不再维护一个常规内置 review 类别；自动审阅门禁的移除仍然有效。见 [协作设计](../design/agent-collaboration-design.md)。

**记录中的状态：** Owner host / protocol / ui；Implemented ✓；Wired ✓；Default-on 用户或主 Agent 按需派发。

**保留证据：** 原自动传感器、隐藏派发与完成门禁于 2026-10-03 移除；
审阅 Agent 继续通过普通 dispatch 使用

**降级或替代路径：** 结果发布不自动启动另一轮模型调用

**剩余事项与记录边界：** 名称、职责、提示词、工具和模型参数可编辑，派发后配置固定

#### 3.10 session state rail / overlay / discussion threads

**记录中的状态：** Owner ui / host；Implemented ✓；Wired ✓；Default-on ✓（工作区持久消息与 session state 有内容时）。

**保留证据：** `thread-routes.test.ts`（session 权威、鉴权、integration、archive/restore/reclaim/space、整线程 DELETE）；
`thread-runtime.test.ts`（同 session 转换、归档及普通 settled 恢复、删除级联；
D-248 返工：exclusive lease、阶段化结构化结果、幂等重试、deleteKnowledgeSession、UI 确认文案）；
Pi `thread-runtime-session.e2e.test.ts`；
`HarnessThreadsPanel.test.ts`（事件与占用投影）；
`HarnessThreadsPanel.behavior.test.tsx`（真实 React：等待恢复后用新 Run/cwd 打开、占用失败不打开并显示原因）；
`HarnessThreadIntegrationPanel.behavior.test.tsx`；
`PiTimelineEntries.renderMode.test.tsx`；
`varinEvents.test.ts`

**降级或替代路径：** Host 无线程运行时时不显示入口；
原线程工具仍可操作

**剩余事项与记录边界：** 浏览器完整归档→回收→恢复点击链未跑。rail、overlay 与时间线标记共用一个 session-scoped feed（D-062–D-064）。合并预览见 D-203；
归档/占用见 D-204；
删除返工见 D-248

#### 3.4a 内容寻址工作分支、草稿基线与结果物化

**记录中的状态：** Owner host / protocol / pi-host；Implemented ✓；Wired Partial（D-216–D-224 已接线 owning/execution、执行 Git baseline、查询级固定视图、dispatch 内容身份、branch Integration 锁顺序/WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle serialization 与 scope 完整 `..` 段；D-231 又补受管 retrieval scratch、managedRoot 与只读 settle。旧记录缺 managedRoot 时拒绝自动动作，真实付费嵌套 Pi / 完整桌面重启未测）；Default-on —。

**保留证据：** `kernel/storage-adapter.native.test.ts`（真实 Rust roots、固定读取、路径范围、虚拟写入 CAS、base revert、重启与对象所有权）；
`working-state/materialized-baseline-update.acceptance.native.test.ts`（真实内核物化基线）；
`working-state/draft-baseline.test.ts`；
`working-state/materializer.test.ts`；
`working-state/branch-view.test.ts`；
`working-state/working-branch-view.test.ts`（Host router 上的 read/grep/find/ls，lease 后正文与 provenance 一致，explore start pin 后词法/原文/语义不读后写）；
`working-state/working-branch-writes.test.ts`（虚拟 write 不碰父盘、兄弟隔离、迟到修订冲突、物化后 publishDirectoryResult）；
`working-state/execution-baseline.test.ts`（isolated init 虚拟写+shell 写 settle/merge，无 bad object；
reclaim/rematerialize；
crash recovery baseline）；
`working-state/virtual-write-invariants.test.ts` / `virtual-write-tree.test.ts` / `materialization-switch.test.ts`（失败物化并发写、孙 merge 后再写再物化、writeRevision 标签、树拒绝、semantic pin、abort/crash 恢复）；
`working-state/workspace-baseline.test.ts`（Git 变化集与 ignored/captureScopes、unborn/非 Git、字节诚实、取消不建分支、listing 失败不发明完整 inventory、gitlink 列出）；
`thread-runtime.test.ts`（surface 释放后的 queued spawn、revision 0、copyIgnored scope、虚拟 spawn 绑定、scratch 回收、bash 预算预占、prepare 后父漂移隔离、Git 失败/捕获窗口变化/writer/gitlink/dirty 内容替换不建完整分支、setWorkingState 失败清理未绑定 branch）；
`thread-services.test.ts`（dispatch 必准备、失败删除、baseline-changed 可重试）；
`nested-threads.test.ts`（父虚拟分支作孙基线、嵌套 merge 不写根盘、父结果再入工作区、captureScopes 继承父冻结范围）；
`working-state/integration-coordinator.test.ts`（虚拟新文件省略 mode 仍可应用到工作区；
物化父 directory 不把 recovery objects 写入父目录且 live/reconcile 走 execution Documents gate；
无法解析 execution directory 则 needs-attention；
branch 集成对账/撤销）；
`dequeue-permissions.test.ts`；
`knowledge-owning.test.ts`；
`thread-registry.test.ts`（binding 重建与 stale 拒绝）；
`thread-worktree.test.ts`（fixed/live、virtual scratch、detached Git 上下文、`executionBaseline`）；
`workspace-identity.native.test.ts`；
`working-state/path-requirement.test.ts`；
pi-host `read-tool.test.ts` / `find-ls-tool.test.ts`（working-branch provenance）；
`workspace-mutation-journal.test.ts` / `apply-patch-tool.test.ts`（`document.branchWrite` 优先；
Varin Host 的 disk/surface target 都经 `document.surfaceWrite`，pi-host 不保留本地磁盘 fallback）

**降级或替代路径：** 旧 Git base/resultCommit 是导入来源；
带草稿的 Thread 缺原生结果时不走旧合并旁路；
shared/none 仍读 live 父目录

**剩余事项与记录边界：** D-239 已接旧结果引用释放 UI、Host 依赖重查与中断对账；
当前分支/结果和仍在使用的版本保持保护。D-277 已把生产 baseline/materialization/copy-or-clone/reclaim 后端迁入 kernel；
未测文件系统不宣称 CoW 已证明。整个 Thread/当前分支删除 UI 仍按其产品面单独验收。D-220–D-223 已关执行 baseline / 固定视图 / dispatch 内容身份、branch Integration WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle 与 scope segment 反例；
D-231 补受管 retrieval 目录和只读 settle。旧记录缺 managedRoot 会拒绝自动动作；
真实付费嵌套 Pi 与完整桌面重启未测。物化预算与占用治理见 D-204；
显式 copyIgnored 已随 branch 冻结并捕获后续新增/修改/删除；
基线读工作目录字节，不把 Git blob 冒充转换后正文

#### 3.5a 固定修订 Integration、草稿写回与绑定预览（D-203）

**记录中的状态：** Owner host / protocol / ui；Implemented ✓；Wired ✓；Default-on ✓（UI 与 agent 共用 Host 定向执行；缓冲不保存）。

**保留证据：** `integration-coordinator.test.ts`（旧预览拒绝、持久 intent/回执、故障与条件补偿）；
`integration-surface-vertical.test.js`（真实 Documents barrier + Registry + Coordinator，磁盘/草稿同一操作合并及撤销，草稿变 clean）；
`documents/authority.test.ts`（定向注册、取消与固定来源更新）；
UI `documents/registry.test.ts`（实例替换、观察者异常、重试/撤销）；
`HarnessThreadIntegrationPanel.behavior.test.tsx`（真实 React 挂载、无请求循环、迟到丢弃、提交审阅绑定）；
`thread-routes.test.ts`、Pi `phase3-e2e.test.ts`

**降级或替代路径：** 不明执行状态保留 needs-attention；
不可用缓冲不写盘；
失败不等于未写入；
旧输入来源不冒充新正文

**剩余事项与记录边界：** 草稿目标支持文本；
缓冲无法表达的类型/权限位变化明确 unavailable。完整浏览器点击链未跑；
可应用性不代表测试或行为兼容

### 执行观察与权限

#### 3.17 按命令整理 bash / get_output（D-197 / D-199 / D-241 / D-247）

**记录中的状态：** Owner host / pi-host / protocol；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `output-organize/organize.test.ts`（pretty 诊断、未知正文、混合命令、失败位置/watch 提示、UTF-8 首尾、超预算大块/提示、分片；
包管理器通配：脚本回显识别内层工具、exec/dlx/x 直接定二进制、install/audit 摘要与错误块必需、warn/进度噪声折叠、生产 `shell.exec` 链；
D-247 返工：未知 `pnpm dlx custom-tool` 走 generic、唯一 warning 保留与重复折叠、checksum failure 进度行保留、EBADENGINE 唯一 warning 在非零退出进 required、watch/interactive prompt 保留、分片输出首尾保留）；
与 `observation-services.test.ts` 25 项通过；
Pi 公开工具相关测试 24 项，最后截断复验 10 项通过

**降级或替代路径：** 未识别或不可归属的混合输出走通用展示；
显式分页与 `out_` 读原文；
旧 Host 未整理结果保留通用截断

**剩余事项与记录边界：** 只对实际 Host 整理结果免二次裁切。原文、字节游标与退出码保持；
增量末片也标当前观察。包管理器通配已接（D-241）：`npm`/`pnpm`/`yarn`/`bun` 头先归管理器层，回显/嗅探识别内层工具则交给其解析器并保留包裹行，否则折叠 PM 噪声、保错误与摘要。D-247 返工修正：exec/dlx/x 后未知二进制走 generic 不走 PM 折叠；
唯一 warning 保留、仅重复相同 warning 折叠；
含 failed/error/checksum/permission 的进度行不折叠；
非零退出时 failure-relevant 噪声与唯一 warning 进 required。不接声明式规则、TOML、jest 专名或模型总结；
不是完整 shell 解释器

#### 3.9 观察类工具增量视图（`get_output` / `diagnostics`）

**记录中的状态：** Owner protocol / host / pi-host / ui；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `observation-cursors.test.ts`（观察者/类型隔离与清理）；
`observation-services.test.ts`（Unicode 字节游标、显式分页不推进、压缩重置、诊断新增/消失）；
`shell-supervisor.test.ts`（转后台后继续采集并解析退出）；
`harness-e2e.test.ts` #3/#7（完整 bridge 链）；
`output-tools.test.ts`；
`counter-tracker.test.ts`

**降级或替代路径：** 显式 offset/length 与 `full: true` 保留全量/随机访问；
Host 重启回到全量基线

**剩余事项与记录边界：** 当前游标覆盖 Pi 会话观察者；
未来用户面板若直接观察 shell/diagnostics，应使用独立 observer id（D-052）

#### 3b.1 原生 `tool_call` 唯一权限门

**记录中的状态：** Owner protocol / pi-host / host；Implemented ✓；Wired ✓；Default-on ✓。

**保留证据：** `permission-gate-extension.test.ts`（Pi builtin、MCP 同名 read、未知 package、规范资源范围 grant、inspect 失败不可记忆、取消即拒绝）；
`session-e2e.test.ts`（真实 Pi 工具循环中的 allow/deny）；
`host/permission-gate.test.ts`（规则/高风险/merge）；
`router.ts` + Host `permission.inspect` 复用 actor/capability/path authority；
跨包 type-check/lint

**降级或替代路径：** unknown / evidence incomplete → ask；
Host inspect/path authorization 失败不产生 session grant

**剩余事项与记录边界：** 实际来源来自 `getAllTools().sourceInfo`，第三方 annotation/名称不自行授予权限；
会话 grant 绑定来源、动作、owning/execution workspace、cwd、规范资源/网络/thread scope；
`/varin-permissions` 可撤销；
`permission.audit` 只投影无正文/凭据目标（D-283）

#### 3b.2 Smart 权限判断

**记录中的状态：** Owner pi-host；Implemented ✓；Wired ✓；Default-on 用户选择 Smart 且配置 `permissionJudge` 后。

**保留证据：** `session-e2e.test.ts`（配置槽位后真实模型调用）；
`permission-gate-extension.test.ts`（普通完整 ask 可放行；
unknown/high-risk/incomplete 不调用 judge；
judge 失败回 ask）

**降级或替代路径：** 无槽位时不可选；
模型失败/非 allow 回 ask；
高影响和证据不完整走确定性 ask

**剩余事项与记录边界：** 不借主模型；
Smart 只是在唯一原生 gate 内解析普通 ask，不是第二权限引擎（D-283）

#### 3b.3 旧 foundational 权限双轨清理

**记录中的状态：** Owner protocol / pi-host / ui；Implemented ✓；Wired ✓；Default-on —。

**保留证据：** `foundational-pi-packages.test.ts`（manifest revision 3 仅 MCP）；
source audit：permission-system state bridge、service yield、Plugin Settings/Composer/quick mode/config model/专属 i18n 与共存测试均删除；
protocol/pi-host/ui type-check + lint

**降级或替代路径：** 无旧插件 fallback/双重提示兼容层

**剩余事项与记录边界：** `@gotgenes/pi-permission-system` 不再 foundational，也无 Varin 一等 adapter；
用户仍可像普通 Pi package 一样自行安装第三方扩展，但它不能替换/绕过 Varin 原生确认门（D-283；
D-044 仅保留为历史）

#### T4 可选配对回放记录器

**记录中的状态：** Owner evaluation / scripts；Implemented ✓；Wired ✗（尚无真实模型配对结果）；Default-on —。

**保留证据：** `evaluation/harness/cases.json`（6 个历史任务）；
`scripts/harness-replay.test.mjs`（commit/ancestor、记录、配对与失败分类）

**降级或替代路径：** 不运行不产生模型请求/设置变化

**剩余事项与记录边界：** 自动执行尚缺单会话配置；
只有实际安排配对时才需要，不再阻塞其他功能或默认启用（D-078）
