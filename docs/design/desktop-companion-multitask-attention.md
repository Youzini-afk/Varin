# 桌宠多任务关注、待办与子 agent 精灵

状态：2026-10-29 **只读全局 attention 与交互面板基础已实现，并完成 Linux 原生有限验证；主管表演与项目台仍在独立候选联调。** 本方案针对多任务相互挤兑与难以理解的问题，区分已验证基础和未验收表演。继承[动画制作](desktop-companion-animation-production.md)、[交互扩展](desktop-companion-interaction-expansion.md)的单播放器、真实接触回收、只读观察和原 Host 边界。

> 角色方向更新：用户明确 Varin 是主管/秘书。本文的数据、待处理和身份安全方案继续沿用；“关注任务即身体执行主体”的旧叙事由[主管式项目台方案](desktop-companion-director.md)覆盖。检查选择不再把 Varin 变为某项目执行者。

## 结论：一个主角，一件正在表达的事，一份随时可查的待办

Varin 是整体主管与秘书，不是某个线程的执行器。身体在任一时刻表达一个明确的管理语句；项目卡、真实负责人和子队保留自己的身份与执行提示。检查某个项目只是查看镜头，不把 Varin 变成该项目的执行者。其他项目的事实和待处理事项无需抢走身体才能出现。

用户始终能回答三个问题：

1. 她正在管理什么？——“查看论文整理项目”；阅读材料是该项目负责人的执行详情。
2. 还有什么需要我？——“实验复现需要确认；另有 1 个问题（已观察范围）”。
3. 为什么没有跟着每个工具切换？——“关注任务正在处理多项工具；详情显示最新状态”。

**立即的是事实和待办；稳定的是镜头和表演；不可延迟的是身份变更、权限真相和错误。** 不把它简化为全局 debounce，也不增加执行调度器。

## 设计起点：原有代码的能力与约束（扩展前）

| 现有入口 | 真实能力与限制 |
|---|---|
| `packages/ui/src/apps/renderCompanionApp.tsx` | 菜单明确选择一个 Thread/branch；挂载、菜单打开时 `threads.list`；一个 `ThreadProjection`；更换关注会清空 scene/progress/completion/answer receipt。现在不是全局观察。 |
| `packages/application-client/src/threads.ts` 的 `ThreadsAPI.list` | 返回目录 `ThreadSummary[]`；默认排除归档/删除。每个 branch 有 `active_run_id` 和 `latest_run`，可描述该目录读取时的 Run 状态；没有各分支权限、问题、效果未知清单，也没有“全 Varin 任务数”的定义。 |
| `ThreadSnapshot` / `ThreadProjection` | exact identity、activeRun、operations、inputs、children、childExecutions、childActivity 等；带 `eventCursor`。完整快照还有历史/上下文等开销。projection 自己订阅全 Host observe，每个 durable 通知触发合并 snapshot；不能为目录每一行直接复制它。 |
| `ThreadsAPI.observe` | 一条 Host 观察流；progress 带 kernel epoch、thread/branch/run/request/stream/sequence；durable 流封套可能只有 cursor，另有 `RuntimeEvent` subject/kind/data，但不能假定所有 durable 通知带可安全路由的 branch ID。已有复用传输，不需要第二 Host。 |
| `presentation.ts` / `progressPresentation.ts` | 同关注分支事实、准确 permission gate、run/request scoped 进展；只保存表现所需类别/长度变化，不保留正文。`projectCompanionIntent` 是单任务投影，不应改成全局优先级排序器。 |
| `sceneFacts.ts` | 授权/回答只认已观察的对应 operation/request；多请求不明确时中性回收。其局部 `count` 目前用于子工作，不能兼任全局待办数量。 |
| `playback.mjs` / `useCompanionPlayback.ts` | 一个实际播放器，latest intent 替换 pending；安全桥和抓放从实际曝光出发。402 个内部节点是画面接触/衔接图，不是 402 个业务状态，也不是多任务队列。 |
| `desktop_focus_main_window` | 可以打开指定 thread/branch；没有在此合同中发现“读主窗当前任务”的订阅。既有菜单置顶指的是窗口置顶，不是关注固定。 |

注意：已读目录、已同步快照、仅有进展、已过期快照是四种不同证据；`unread` 和 `activity_cursor` 不等于“需要批准”。`latest_run.completed` 不等于独立 operation、子工作全部停止，更不等于用户整个目标成功。

## 四个分离的呈现槽

```text
既有 Host：目录 / snapshot / observe（epoch + cursor + identities）
                 │
        只读事实缓存 + 覆盖范围/健康度
          ├── 关注选择：用户决定是谁 ─────────────┐
          ├── 待处理账本：需要关注什么 ──→ 摘要 / 可操作面板
          └── 关注任务最新意图 ─→ 表现稳定器 ─→ 单播放器 ─→ 曝光 cue
                                              │            │
                                         实际抓放优先   透明装饰 / 子头像
```

1. **关注身份槽**：`hostGeneration + threadId + branchId`；Run 是此身份之下的一轮工作，不把新 Run 当新线程。关注名称缺失时用中性“未命名任务”和详情中的身份区分，不猜任务内容。
2. **即时事实槽**：关注任务的最新事实、Run/request 身份、数据健康度；原业务 owner 不变。
3. **待处理槽**：独立于身体的多项集合，按 exact operation/request 身份去重；允许权限、问题、失败、待核对并存；请求存在但尚未达到 owner 可响应条件时单列“准备中”，不计入需要用户现在处理。不是待播动画队列。
4. **实际表演槽**：只有当前曝光与一个最新目标。过时目标替换，不积压“读→写→搜→庆祝”。场景和精灵入场只跟实际曝光 cue，不跟尚未画出的目标动作。

`focusKey` 不包含标题；`eventKey` 至少包含 epoch、thread、branch、run，以及适用的 operation、permission/question 或 request 身份。缓存、异步响应、receipt 和去重键都带范围；Host 切换时全部失效。业务键使用结构化元组，不以可能含分隔符的字符串拼接产生冲突。

## 关注如何选：稳定而不失联

### 默认：固定关注，用户显式切换

保留现有选择语义，文案从模糊的“线程”变成“正在关注”。选择 A 后，B 的工具更新、完成或普通等待**不切走 A**。A 完成后仍显示“A 本轮完成”，不自动跳去 B，也不宣称“全部完成”。未选择时显示“尚未关注任务”，不把本地休息解释为全 Varin 空闲。

新的“固定关注此任务”是关注策略，不复用窗口 `pinned`。本轮只有固定模式，因此，不画没有实际效果的开关。菜单的“查看待处理”只是打开清单；“关注此任务”才改变身体归属；“在主窗打开”只导航，可独立于关注。

### 可选跟随主窗：有真实合同后才提供

若后续复用或建立可信的跨窗口只读 focus 消息，显式提供“跟随主窗正在查看的任务”。消息必须携带 Host generation、thread/branch、单调 selection revision，且来源是实际已提交的 UI 选择；不能用窗口焦点、最近工具事件、目录更新时间猜选中任务。切换外壳/编辑器但没有任务选择，不清空也不伪造新任务。菜单手动选择进入固定模式，避免下一个 UI 消息马上抢回。

本轮不新增“自动轮播任务”模式。稳定身体 + 即时待办已解决主要问题；将来若要自动关注，需独立验证用户是否愿意被自动切镜头，不先引入复杂优先级竞争。

## 待处理优先级不是全局抢镜优先级

- 当前关注任务的 permission/question/effect unknown/cancelling/failure 按其真实投影即时更新文案；身体停止普通重复并走最近可用安全出口。没有图或资源未准备好时先保留中性画，不能等动画才提示事项。
- 非关注任务产生需要用户的事项：**马上进入待处理摘要和可访问列表，但不偷换关注任务**。提示带任务名和种类。角色可做不带批准含义的一次短关注，若抓放/权限姿态在进行则不补排这次动作。
- 效果未知、明确失败、待授权、待回答在面板分组呈现，不能让最高级一项把其他项从数据集合中覆盖掉。断联是整个观察范围的健康横幅，不代替已知待办；旧条目加“最后已知，正在同步”，不计为已证实当前数量。
- 同优先级按首次观察顺序稳定排列，稳定身份作最终 tie-break；新事件不会每次重排。允许“下一项”“上一项”和按任务分组。严重项可以置顶分组，但一般问题一直可达，摘要始终包括还有其他类别，不无限饥饿。
- 一条项被查看不等于解决；可标本地“已查看”减少重复提醒，但不能从未解决列表消失。拒绝、回答、超时、取消等需各自真实 owner 事实。桌宠不发 `decidePermission` / `answerQuestion`，也不为用户自动标记对话已读。
- 后台事项解决只更新该项；不能让 A 的 allow receipt 给 B 的锁开门。正在显示的唯一精确 receipt 可短回应；多项、脱离关注、重连历史或被新 urgent 事实取代时中性收回。

## 可读界面：短摘要和显式面板，不做透明点击陷阱

日常表面保持小巧：关注标题 + 一行状态；需要注意时加一行“B 需要确认 · 另有问题”。多个任务不在身体周围堆满长气泡。默认只放短标题、不放工具参数/路径/提示正文；可隐藏任务名，保留“关注任务 / 另一任务”。标题长度截断不改变详情可读性。

透明装饰面继续非交互、不抢焦点、不扩大人物点击区。其文案只作视觉提示；屏幕阅读器入口在真实可交互 DOM 面板而非 canvas。**通过现有角色菜单新增“任务与待处理”打开明确可聚焦的小面板**；不是把透明场景表面改成可点击层。初版可扩展现有 controls 容器，不必新建窗口。

```text
任务与待处理                         [关闭]
关注：论文整理 · 固定                 [在主窗打开]
当前：阅读材料                       [更换关注]

需要你（已同步的关注范围）
实验复现       需要确认               [打开任务] [关注]
数据检查       等待回答               [打开任务] [关注]
资料整理       操作结果待核对         [打开任务] [关注]

其他任务（目录快照；详细状态未全部观察）
可见分支的运行摘要 / 最后同步状态      [刷新]
```

按 Tab 到达所有控制，Esc 关闭并返回打开入口；不因后台事件抢焦点。文字 + 图标表达种类，不只用颜色；live region 只读出新待处理/关注变更/断联等有意义事件，不播每个工具和 token。多项到来可在同一 UI 提交中合并公告但保留全部条目。减少动态模式保留静态标记、名单和必要接触/落座，不强迫读者靠动画理解。

## 同一任务快速换工具：新鲜事实，不是频繁换装

区分三种变化：

| 变化 | 事实更新 | 表演处理 |
|---|---|---|
| 同 thread/branch/run 内，工具或 text 每 50ms 变化 | 立即更新事实缓存；面板可展示最新概括 | 同语义类别保持当前姿态；混合类别用“处理多项工具”/通用观察，不逐工具重启动作。 |
| 同关注分支新 Run/request | 清除旧 progress/receipt；新一轮与请求不可混接 | 不重播旧结束；目标重算，保留机械接触安全桥。 |
| 用户选择另一 thread/branch | 立即改关注标题，显示“正在同步 B” | 撤回 A 的语义道具，身体从真实曝光中性回收；等 B 有当前事实后表现 B，绝不把 A 的阅读动作标成 B 正在阅读。 |

稳定器只稳定**非紧急装饰选择**：同一类别不重置播放；候选在下一个作者标记安全点仍有效才进入；持续多类竞争可停在中性工作观察，等出现单一稳定类别再切。可以用短的、可测量的表现 hold/hysteresis 预算防止翻转，但它是视觉参数，不能决定业务状态，也不能延长已结束工具的 active 道具。工具结束后立即撤回 active 语义，剩下只允许中性收束；不为“最少播放两秒”假装工具还在运行。

任何最短停留都由失联、身份改变、权限/问题/效果未知、取消和失败打断。urgent 的文字/可访问提示不等安全点；身体只受真实画面安全回收约束。如果安全出口或图未就绪，暴露同步/资源问题并保持中性，不无限等待、不跳接手和电脑。可验证最大视觉反应延迟来自已接受路径的实际时长与加载状态，不用任意固定秒数定义“已处理”。

完成只在同 Run 当前观察到非终态→completed 时形成短暂可消费边缘。后台完成进概览；关注完成被新 Run/urgent/拖动覆盖就放弃庆祝，不等空闲补演。列表可以保留最新结果供查看，但这不是动画重放日志。

## 数据边界与本轮实现范围

原 `threads.list` 只有目录/Run 粗信息；全目录复制 `ThreadProjection` 会造成每个 durable 通知扇出完整 snapshot。用户要求的完整后台待处理不能靠目录计数或局部防抖替代。因此本轮范围包括下面的**轻量 Catalog attention 合同、UI 全局待处理与稳定关注、真实子头像联动**，不是把全局能力延期。

详细正文只由一个关注分支 projection 读取；全局紧凑事实使用一个 single-flight reader。companion 的观察协调器共享一条原 Host observe，向详细 projection 分发事件，并只在 durable 变更时合并刷新 attention；50ms progress 不触发全局读取。读频率预算是资源策略，不改变请求事实。所有读取带取消与 Host generation/epoch 隔离；一次失败保留标记最后已知的数据，不显示零待办。

## 已批准的完整架构：轻量全局关注读模型

**最终推荐不是永久停留在“只看选定任务”**。保持详细内容只观察主关注分支，同时为本 Host 的可访问原生任务建立一个轻量、准确的 attention 读模型。这样后台待授权能立即被看见，身体仍不会抢镜；全目录开 N 个重型 projection 不是推荐路线。此合同已经进入源码实现，最终产品验收仍须完成真实 native/UI 联调；不因类型与单测存在就宣称全部平台交付。

### 范围与“任务”的定义

- 全局指**当前连接 Host 与当前调用者可访问范围**，不声称跨 Host、跨账号或所有外部应用。结果必须返回 `coverage`，外部 Harness 尚无等价映射时标明不覆盖，不伪造 native Run。
- 列表实体是 Thread/branch；Run 是一次执行；一个可处理事项是 exact operation/request。展示“3 个任务有待处理，5 项请求”，两种数量分别去重计算，不能混用。全量计数和条目必须来自同一事务一致切面；只统计 actionability=ready 的用户请求，其余需核对/收尾单列。
- 子 thread 在全局查询中仍是独立事实实体；父子关系用于分组而非复制事项。父任务显示“子任务 B 需要确认”只是指向 B 的同一条 item，不在总数中再加一项。父活动概览不替代 child request 事实。
- 默认包含仍有未解决事项或未结算执行的归档/删除 thread，附其隐藏/删除标志；普通目录隐藏不抹掉原 owner 请求。主窗若不允许打开，显示“原任务不可打开”，不得转交其他线程批准。没有未解决工作时，不加载所有历史已归档失败。
- 主关注可不在当前目录，但始终按原身份读取；目录缺行不取消关注，也不证明工作结束。

### 本轮应用合同

`ThreadsAPI.attention(signal?) -> ThreadAttentionSnapshot`，定义在 `packages/application-client/src/threads.ts`：

- `epoch: number`、`eventCursor`；不另造 revision 源。
- `coverage: {native: 'complete', external: 'unsupported', scope: 'host'}`；原生范围沿当前 Host 的 product-visible 目录及隐藏但未结算实体，内部 inference/retrieval 不冒充用户任务。
- `branches` 含 thread/branch/title/avatar/parent、归档/删除标志、`activeRunId`、`currentRun`、`latestRun`、`hasUnsettledWork`。latest Run 可以是排队的另一轮，不等于当前 active Run。
- `items` 是 exact identity key 的扁平集合，含 thread/branch/run、适用的 operation/request/permission ID、revision、kind、`actionable`；没有 prompt、参数、原始错误、路径或权限正文。
- kind 覆盖 permission、question、computer_permission、mcp_elicitation、mcp_sampling_request、mcp_sampling_output、mcp_error、effect_unknown、run_failed、preparation_failed、cancelling。
- `counts.actionRequired/affectedBranches/unknownEffects` 与条目来自同一事务一致切面。结果/取消说明不必是可回答请求；准备失败是可能可重试的 waiting 情形，不等于 Run terminal。

本轮采用**一次完整紧凑结果**，经既有 bounded-frame content transport 传输，不维护分页缓存、不把分帧传输误作不一致的逐页查询。UI 每页只渲染有限条目，有可访问上一页/下一页，不限制任务总数。以后若数据规模确需服务端分页，才建立有界不可变紧凑页缓存；不得使用 Family rowid 上界游标冒充状态快照，也不得长期跨用户分页持有 SQLite 读事务。

computer/MCP 类别沿原 owner metadata 查询；`pending_mcp_interactions` 会改变 availability，不能直接调用它充当只读摘要。`requestId` 与 `permissionId` 不互换；ask_user 没有独立 question ID 时使用原 operationId。外部 Harness 当前明确不覆盖，不合成 native Run。

### 权威、读取与生命周期

1. **Rust Catalog 仍为状态权威**。首选在既有 runtime 增加窄的批量只读查询，用原 permissions/operations/run/child admission 事实投影，不查询历史正文和 context inspection；Application Host 只鉴权、调用、映射 typed DTO。没有新表、后台调度或 renderer 写入。若现查询可高效批量复用则不额外造 kernel 方法，需用实际查询计划证明。
2. 一致性读取中先取得 epoch/cursor，再读取受同一致性边界保护的行；订阅先启动，读取期间事件记录为 dirty，完成后按 cursor 追平。若复用当前 snapshot 的“读前 cursor + replay”策略，必须验证不存在短暂请求开关丢失；未被看到的已解决请求不需要补播，但不能把当前未解决漏掉。分页不能混用不同 revision 的页；token 失效时重建，不把新旧页拼成 complete。实现可用现有 SQLite 只读事务一致读取紧凑结果，配合取消和 epoch 后验证，如未来需要分页，再由 Host 短期保留不可变紧凑页；这只是瞬时读缓存，不是新业务存储。不要长期持有 SQLite 读事务跨用户分页。现 Family rowid 上界游标不能证明行状态不变，不能直接套作快照 token。若首版采用单响应，必须在资源预算超限时明确 partial/too-large 并提供受限分组继续读，不能悄悄截断称 complete。
3. **请求存在和现在可回答分开**。permission 在 Catalog 存 `call_ref/scope_ref/epoch/decision`（`catalog_permissions.rs`），不是 UI hydrated 的 `call/scope`；读模型必须复用/提取原 owner 的 eligibility predicate，不在 Rust 照抄 `unresolvedPermissionId` 的对象形状。question 的 ready 也不能用 `ask_user && nonterminal`：`catalog_questions.rs` 要求 handed_off、未取消、Run waiting、matching wait、wait 未取消、job acceptance consumed、active branch owner 匹配。存在但尚不可答显示“正在准备提问”，不计入“需要你回答”。ready 只代表读取时证据，实际打开/提交仍由原 owner 重新检验。全局查询不只看最新 activeRun：原 holder 请求按其真实 owner eligibility 保留/关闭，不由 UI 猜测。native permission 的 `validate_live_permission` 会排除 terminal/cancelled/nonactive Run，question 同样要求 active owner；这些请求不能在该 Run 结束后继续标 actionable。旧 effect/其他 holder 未解决项则另行保留，不能混同这两类 native 请求。
   `active_thread_operations` 当前查询包含非 terminal、indeterminate 与部分资源订阅，但不是任意终态 unknown/error 的完整索引（`catalog_history.rs`）；新读模型需明确覆盖所有尚需 reconciliation 的 metadata，不能把现 helper 返回集误当全量。
4. run failed 是结果关注，不是永远阻塞请求。只收每分支相关最新失败及仍需处理的准备失败；本地“已查看结果”可压低重复提醒，不改事实。新 Run 取代旧失败展示，但未解决的旧权限/效果未知仍按原 owner 保留。取消中是状态说明，不默认要求用户再次操作。
5. 关闭项来自明确结果或一致完整快照不再包含该项；区别“本次响应 partial/权限被收回/Host 断联”。失去访问是 unavailable，不是 approved/completed。客户端可删当前清单项，但批准/回答动画仍需独立精确 receipt，不能以 summary 项消失推断 allow。
6. 同一连接一份 attention subscription，主关注保留一份详细 projection；可在 UI 观察层共享底层流以免重复解码，不为每个目录任务创建 projection。请求采用 single-flight + dirty 合并，保留不饿死的最大刷新预算；durable invalidation 不必承载全结果。进展 text/token 不触发 attention 查询，只有影响此读模型的 durable 变更失效。
7. cursor 过期/epoch 改变：抛弃历史边缘，保留标记最后已知的 UI 至重新完整读取，不再沿旧 epoch 判断完成。重连不补播过去批准、回答、召唤或庆祝。针对请求先到/快照后到、变更时分页的行为测试必须证明不会回退 revision。

### 资源、安全和实现成本

- 数据量随当前分支/未解决事项增长，不随历史 token 数增长；分页/传输字节预算是资源边界，不拒绝用户拥有更多任务。每页大小沿已有服务约束或测量确定，不能任意硬编码“最多 10 个任务”。旧 token 在 owner 规定的保留窗口内可复用，超期返回明确 resync，不长期维持新的持久状态。
- endpoint 使用现有 Host 认证与访问控制；不增加自动批准/回答能力；别的用户、不可访问 thread 的标题/计数也不能泄漏。只返回注册 avatar token，标题在 DOM 作为纯文本处理；日志不记录敏感正文。MCP/computer 请求仅给原 owner 身份与安全种类，用户动作一律导航到现有对应任务界面审阅，不在桌宠处理真实 payload、不自动批准。装饰 native descriptor 不收此全目录内容，只收当前最小安全表现。
- 失败隔离：attention 摘要读取失败不取消主关注执行，也不重启 Host；主关注详细读取失败不擦除另一个分支已确证 current 事项。用独立 health 表示 partial，不用单一全局连接 boolean 掩盖。
- 成本属于**一个窄读模型跨层实现**：kernel/原读取 owner 批量投影与一致性测试，application-client DTO/HTTP，原 Host route/鉴权/失效接线，UI 共享读取与 ledger，再做并发/断线/分页测试。不是只改菜单，但也不涉及执行写路径、存储迁移或新服务。若需 schema protocol 变更，按仓库生成流程更新并核验真实 native consumer；不能只靠 TS mock 宣称正确。
- 性能验收记录：相同目录和事件流下的全量读取字节/查询数、增量失效次数、同时在途读取、后台 permission 可见延迟；与 N 个 full snapshot 的基线比较。提示延迟预算由实际 transport 与 workload 确认，而非用几秒 hold 遮掩问题。

**已批准实施决策**：本轮包含完整多任务后台待处理，此轻量只读合同与 UI 一并实现；不把“多任务准确提示”留成没有时间和 owner 的未来工作。关注/表演稳定器、头像和读模型可以并行开发，最终同一组多任务场景验收。只读 scope 不等于不允许合理完善既有后端合同。

## 子 agent 化成现有头像的小精灵

用户所说“指挥一群小精灵，派发时出现，结束时消失”可以直接建立在现有身份上，不再发明每种工具一个新角色。

### 身份与资源复用

当前子队属于关注的父 thread/branch，而不只属于其最新 Run。旧父 Run 派发的孩子仍可能真实运行；按每个 child/execution 自身的原 parent_run_id 校验，不用 snapshot.activeRun.id 过滤。主 Run 更新不重排仍在工作的孩子。

- `components/ui/AgentAvatar.tsx` 调用 `@varin/protocol` 的 `agentAvatarForIdentity(identity, avatar)` 和 `agent-avatar-art.ts`。复用同一 child thread ID 与已保存 avatar，保证聊天卡、子任务列表、桌宠一致。
- `ChatDelegation.tsx` 现有优先链为 child avatar、exact execution avatar、agent avatar、同线程目录保存值；`ChildTasks` 用 child ID/头像。桌宠以当前确证的 execution/child 对应资料建立相同身份解析，不导入主窗 store 当跨窗口权威。没有显式头像时用既有确定性 identity fallback，不随机分配。
- 通过 `execution.child_operation_id → children.operation_id` 找到对应 child，再取得 `child.child_thread_id + child.avatar`；若需要 execution 中头像作为 fallback，仍须先验证两者 child identity 一致。对每一只精灵校验 `hostGeneration + parent_thread_id + parent_branch_id + parent_run_id + child_operation_id + execution_id + child_thread_id + child_branch_id`。**头像身份**按 child thread 稳定，**一次派发/续跑的生命周期**按 execution_id；同一孩子新轮次不能吃到旧完成回执。
- `ThreadSnapshot.childActivity` 的 key 是 **execution_id**。`thread-adapter.ts` 将子 Run 终态尚待结算映为 `settling`，不能看到 settling 就胜利飞走。`children`/`childExecutions` 可从当前快照移除已结算成员；数量下降不是完成证明。`currentChildren` 使用 Family CURRENT，terminal execution 仍可能因报告/投递未结算而留在 current directory，因此“仍是 current member”也不是仍在执行。投影先检查最新 exact execution 的真实 terminal，再看该 execution 的 activity；不可用过时 activity 把已终态成员重新画成 running。

### 表演与布局

派发新 execution 得到确证且其父范围匹配当前关注时，头像从角色真实 dispatch cue 的出口短入场，进入稳定小队席位；初始快照/重连已有孩子只静态在席，不补演召唤。头像不长出另一套与原 art 冲突的人形；用克制的托盘光点、短轨迹和轻微浮动给现有头像“精灵”感。

稳定席位以 child identity 分配，增删其他成员不全队重排；主活动从 dispatch 转为 reading/editing 时，同一小队转为下沿安静紧凑簇，不重新召唤。权限/问答主场景可收为 team badge/名单提示；版面不足中性收起装饰时，摘要仍说明子工作持续，不能把主场景切换演成孩子结束。同一 child 多 execution 时头像保持一个，详情列出不同执行；不能据单个 execution 完成把仍有工作的一只精灵移走。席位容量由可读尺寸与屏幕边界决定，多余成员折成“另有 N 位（当前已观察小队）”，不是后台任务硬上限；不可随机轮播制造身份漂移。关注分支变化时全队中性收回，再展示新队。

| 真实状态 | 精灵表现 |
|---|---|
| preparing / ready 且尚无确定运行细节 | 在席待发；不声称已开始执行 |
| childActivity running | 小幅稳定浮动/朝工作方向，不围人物高速转圈 |
| waiting | 稳定悬停 + 等待标记，不默认画权限锁 |
| settling | 轻收束但仍在席；不画完成勾 |
| 非终态 preparation_failed | 安静异常标记，摘要保留对应任务；这是准备问题，不假称该执行已终结 |
| exact execution failed | 精灵中性收回，错误明确留在全局待处理/结果列表，不画完成勾，也不永久占据工作席位 |
| 当前 exact execution 明确 completed | 若实际看过其活动且没有同 child 新活动，短收回离场；其结果保留可查，非全队庆祝 |
| cancelled | 中性撤回；取消意图未证实结算时不先消失 |
| 快照不再包含 / unknown / 关注变化 | 中性收回或置为最后已知；不补演完成，不以 count 差触发胜利 |

如需核实刚离开快照的一个已展示 execution，复用 `ThreadsAPI.collaboration.executions` / 现分页查询做**有界单次按需读取**，而非为每只精灵开新的全流订阅。拿不到 terminal 证据就中性退场。只保留当前在席、正在收束及详情展开需要的最小记录；不保存永久头像事件日志。

精灵仍在完全穿透的装饰层，不变成悬浮按钮。UI 先通过现有 `agentAvatarForIdentity` 得到 `AgentAvatarId` 白名单 token；native scene descriptor 只传该 token、有限席位 key 与枚举状态/确证 overflow 数，不传 SVG、HTML、remote URL 或任意绘制指令。无 API/preload 的 inert scene window 从打包的同一头像艺术库解析 token；非法 token 拒绝或使用既有确定性 fallback，不发网络请求。execution 与 parent 身份验证在 UI 事实投影完成；native 只验证描述符结构/容量，不成为第二事实 owner。面板提供小队名单、状态、打开子任务（精确 child thread/branch）。减少动态时直接入席/撤回，必要状态仍可读；拖动期间收起世界装饰，落座后显示最新当前小队，不重播期间派发。

## 场景轨迹与验收（事实、身体、摘要分别断言）

| 场景输入 | 必须看到的结果 |
|---|---|
| 1. A 阅读/编辑/检索每 50ms 交替，B 同时输出 | 关注仍 A；最新事实不断更新；身体不重启三种动作，可用中性多工具观察；B 不抢镜；无积压待播列表。 |
| 2. A 阅读，B 权限，C 问题（B/C 在已观察范围） | A 关注不变；B/C 同时进入摘要/列表；第一条不覆盖第二条；未观察范围明确不保证发现。 |
| 3. B 有两个权限，C 又有一个权限 | 按三条 exact request 身份可查；稳定顺序；任何一个 allow 不让全组锁打开；查看不等于已解决。 |
| 4. A 完成，B 仍忙 | “A 本轮完成”；A 可一次庆祝，B 概览仍忙；没有“全完成”或自动切 B。 |
| 5. A completed 后立即新 Run accepted | 新 Run 立即成为事实；旧庆祝丢弃；旧 request 的 text/retry 不污染新轮次。 |
| 6. A 失败，B 权限同时到来 | A 失败事实与 B 待授权都可见；身体不在两者间轮播；工具失败不得替代 Run failed。 |
| 7. A 取消中仍有操作/子工作 | 取消中，不说已停；子精灵继续对应真实 running/settling；没有假完成离场。 |
| 8. 断联期间最后已知有 B 权限 | 同步健康度显著可见；B 标最后已知，不能变成 0；恢复快照重建，不重播 allow/完成。 |
| 9. 隐藏期间 A 读→写→完成→新 Run，恢复 | 只表现最新 Run；无旧动画追赶；首次恢复不推断未看见的成功边缘。 |
| 10. 正拖动时 B 权限、A 完成 | 跟手/接触安全最高；摘要事实仍更新；落座只消费最新目标，丢弃旧庆祝和短提醒。 |
| 11. 用户在 A 锁姿态切到 B | 标题立刻 B 同步中；A 锁中性撤回；A 的迟到 allow 不能成为 B 的通过；A 未解决项在已观察账本中独立保留。 |
| 12. 关注线程从默认目录消失 | 不推断 deleted/finished；如确证删除则显示已隐藏/不可用，存续执行未知；不自动挑下一行继承原 Run。 |
| 13. Host 切换，旧 snapshot/stream 后到 | epoch 拒收，旧头像/待办/receipt 不进入新 Host；新 Host 未同步不显示空闲或零待办。 |
| 14. 混合工具 snapshot 缺类别/短工具完全落在两次读取间 | 展示通用工作/未知细节；不从工具参数猜类别，不补造未观察动作。 |
| 15. 首次打开已有 completed Run | 显示其本轮结果，不触发新完成挥手；初始数据不是边缘。 |
| 16. 三只子头像依次派发，第二只等待 | 复用聊天头像，各有稳定席位；只第二只静止等待，主角不替其执行；没有权限事实不画锁。 |
| 17. 子 execution 从 ready→settling→离开当前快照 | settling 仍在席；离开仅中性撤回，除非精确补读证实终态；count 下降绝不等同完成。 |
| 18. 同 child 新 execution 启动，旧 execution completed 后到 | 头像身份/席位不变，新轮次仍活动；旧 receipt 不让它消失。 |
| 19. 小队超过可读席位 / 减少动态 | 稳定显示部分头像 + 剩余已观察成员数；名单可遍历；无需动画/颜色即可理解全部状态。 |
| 20. 目录过大、连续 durable、部分读取失败 | 有限在途请求与公平读取；显示覆盖/待刷新/未知，不把部分成功说成全局准确；没有每 token 全目录刷新风暴。 |
| 21. 重复打开面板、快速切关注、关闭面板后旧请求完成 | 清理/复用观察无重复订阅；aborted/过 epoch 回调不发布；关闭不自动取消实际工作。 |

## 分阶段交付与退出条件

**可独立验证的 UI 批次**：明确关注标题和覆盖范围；全局紧凑读模型驱动多待办列表；事实/身体分离；工具突发稳定器；新增头像小队只消费父 snapshot。不声称全局监控完成。验证上述身份、receipt、50ms 突发、拖动/隐藏和减少动态场景，并在真实透明窗口检验不截点击、面板可达。

**可独立验证的观察批次**：shared observation/cache + 当前 Host 完整原生 attention 读模型；测量 subscription 数、在途读取上界、snapshot 次数、事实提示延迟、身体切换次数；连续事件下仍要公平。只有当前 scope 完整且 health current 时给精确范围计数，否则显示部分/未知。

**完整交付所需读模型（与前两批并行）**：按上述推荐实现轻量 attention snapshot/invalidation，满足自动全目录待处理保证；证明初始读取竞争、断线 cursor 追平、归档/删除存续工作、多 request 与权限撤销，不让 UI 自建权威。可选跟随主窗另有 focus 消息合同，和此全局事实合同分开。

文档检查不代替 runtime/实机验收。实现包含 `attentionCoordinator`、`attentionLedger`、`attentionPresentation`、`CompanionAttentionPanel`、`childTeam` 与原应用接线；父任务统一最终验证、资源接入与提交。已有单播放器和 Host 权限边界不变。

## 已验证的基础范围

Linux 原生窗口使用 `cb4f9350` attention/面板基础、`7fa96e77` 协议 71 QA kernel 和未改变的 upright-v2 资源，实际验证了当前 Host 原生任务覆盖提示、健康空待办、刷新/展开、Esc 关闭与入口焦点恢复、360×480 可达布局及主窗退出后的附属窗口清理。设置已逐字节恢复。精确产物与日志身份见 [foundation 验证记录](desktop-companion-assets/attention-foundation/native-validation.json)。

这次没有制造付费模型任务；并发请求归属由实际运行的 Catalog fixtures 覆盖，不冒称 GUI 多任务实测。它不构成主管新身体语句、项目负责人角色库、portfolio 联动或 Windows/macOS 的最终验收。
