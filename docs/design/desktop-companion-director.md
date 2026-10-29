# Varin 主管式桌宠：项目台、负责人和子任务精灵

状态：2026-10-29，当前 `1303` 仍是已部署的开发产物，**用户已否定其整体动作联动与运动一致性，视觉质量未获认可**。Bot 统筹 / Agent 提醒、真实角色归属及只读事实合同继续保留；下一轮目标改为完整、舒服的通用身体表演，取消“任务 B → 人物看 B／指 B”的定向绑定。本文第 3–5、7 节描述新的设计目标，**不表示运行时已经完成新映射**；第 8 节及末尾记录当前实现和验证边界。

本文继承[多任务关注方案](desktop-companion-multitask-attention.md)的只读全局事实、异步身份、完整待处理与可访问入口。更细的原画 E/H/X 与演员编排见[主管动作矩阵](desktop-companion-director-performance.md)，其定向表演细节须按本页最新目标另行修订；本次不改历史来源或验收记录。

## 1. 她是谁：主管与秘书，不是所有项目的亲自执行者

下列统筹分镜属于 **Bot 模式**。Agent 模式是用户直接与项目主 agent 对话，Varin 只提醒真实事项/授权/问题/结果；检查项目不等于她听取汇报或批示。工作台模式与每个项目归属分别核验，Bot 视图中的普通 Agent 后台任务也不能被改演成 Varin 派发。

Bot 的权威 `BotProfile.entry` 是 Varin 本体入口 E，不是另一个负责人。只有由稳定、精确分支关系证明的 E→A/B 直接任务才是项目负责人；A→a1 才是较小子精灵。缺少或冲突的根/关系证据显示普通 task 身份，不猜负责人层级；E 的请求仍在主体提醒和列表中保留精确导航，但不另画团子。

```text
用户：交代工作 / 做出决定 / 查看结果
                    ↕
Varin：接待、协调、跟进、递交待决事项、呈现已确认结果
                    ↕
项目任务卡 A         项目任务卡 B         项目任务卡 C
实际主 agent         实际主 agent         实际主 agent
    └─ 子精灵小队        └─ 子精灵小队        └─ 子精灵小队
```

“项目任务”是对现有真实 thread/branch 的展示称呼，不新增 business Project 实体、项目关系、调度器或授权层。每个项目真正的负责人是该 thread 的主 agent；Varin 是管理整个工作台的角色，不是这个主 agent 的大号版本。子 agent 的真实身份和任务关系继续由原运行系统决定。

默认视野是当前 Host 的整个原生项目任务组合，而不是“先选一个线程，她才知道有工作”。即使没有打开检查项目，只要真实项目在工作，Varin 仍表现为跟进和阅览概况；断联则明确同步/未知，不闭盖假装所有项目空闲。

### 视觉的三层职责

| 层 | 表达什么 | 不表达什么 |
|---|---|---|
| Varin 主体 | 接收新工作、审阅概况、协调、关注待决事项、接收某项已确认结果 | 不随每个文件读取/写入/搜索重演操作；不冒称她本人执行所有工具 |
| 项目任务卡 | 具体任务标题、真实执行状态、待处理/不确定标记、负责人和范围 | 不造“规划中/已审核/已验证”的事实；不因为一轮 completed 就宣称整个项目目标成功 |
| 主 agent 与子精灵 | 哪个实际 agent 在承担工作，以及真实分派/等待/结算关系 | 不把工具变成新 agent、不随机生成不存在的工作人员、不根据计数变化演成功 |

主体的柔和生活感保留；Bot 表达接到安排、认真处理和向用户呈交，Agent 表达陪伴与提醒。身体不承担具体任务的空间指代，也不凭空拿取纸件、记笔记或制作报告。文字始终描述可靠事实，例如“2 个项目任务正在推进”“B 需要你的授权”，而不是未经证实的“我正在规划项目”“我已审核报告”。

## 2. 主 agent：同一家族的项目负责人，不再创造第二个 Varin

- 身份源是已有 `ThreadAttentionBranch.threadId + avatar`，调用 `agentAvatarForIdentity(threadId, avatar)`；与侧栏/聊天中同一线程头像一致。branch 和 currentRun 标定该项目当前执行，不能伪装为 child execution。
- 头像主体、脸和用户选定的色形保留；只在桌宠项目台加**负责人角色外观**。设计比较过短肩领/短披肩与菱形扣、分派斜带与侧文书夹、双翻领与肩签；用户已认可第一种概念方向，但混合头像的通用套装存在穿模，已逐头像完成当前适配。后续视觉复核仍须依据 24px 左右的剪影和遮挡关系审阅，不靠颜色或皇冠区分，也不改头像库的全局默认值。
- 子精灵沿既有头像形状，无负责人外套。负责人在项目卡的标题/进度栏旁占固定位置，子队在其下方或外侧扩展，层级由位置与轮廓建立，不把负责人简单放大成第二个桌宠。
- 无当前 Run 时，真实负责人仍可作为项目身份的静态标记；不显示忙碌、不演派发。新 Run 使用原头像的新执行状态，旧完成回执不能让新执行消失。
- 负责人角色装饰是此表面的呈现层，不写回用户的 avatar 设置，不创建新 agent profile。

## 3. 下一轮任务层：稳定身份承担指代，更多项目有明确入口

桌宠旁以少量稳定负责人及其真实小队显示工作，短标签承载标题、状态和待处理标记，而不是堆叠纸卡。工具参数、路径、模型正文不进入透明装饰面。卡片使用稳定 thread/branch key，不因每次 updatedAt 或 token 到来全盘洗牌。

可见席位优先保证正在检查的项目与需要用户的事项，其余维持既有在台顺序；新增背景项目进入安静的“另有 N 项”入口，不抢占所有卡。这个数量是当前 Host 明确覆盖的项目任务展示集合，不是全世界任务总数，也不把父任务的子请求再计一次。

**点选项目是打开检查镜头，不是更换 Varin 的工作身份。** 既有可访问面板承载真正点击：总览、需要你、正在检查的项目、项目负责人、展开的小队。透明卡片本身继续穿透，不扩大点击区；项目卡旁的查看动作通过明确的交互入口完成，不能让透明图层偷走桌面点击。

- 总览：所有真实项目任务状态和待决事项。
- 检查 A：展开展示 A 的实时执行细节，可保留阅读/编辑/搜索等细分类别在 **A 的内容区域**。
- 身体：保持当前通用监督或陪伴姿态；检查 A 不自动触发侧听、转向或指向 A，A 的工具改变也不驱动身体换装。
- 同时 B 需要授权：独立“待你决定：B”区域保持可见，检查 A 不把 B 的请求静音，也不强制关闭 A 的检查面板。

## 4. 下一轮身体：完整通用句子，不绑定任务位置

**身体表达“发生了哪类事情”，任务层表达“具体是谁”。** 人物只围绕自己的坐姿、电脑支撑及面向用户的关系完成动作。B 在左、右、上方，或任务席位发生变化，都不能要求另一套看向／指向 B 的身体来源。任务定位依靠真实头像、短标题、独立状态标记和可访问列表，不靠人物视线与指尖。

| 真实情境 | Bot 统筹的通用句子 | Agent 桌宠的通用句子 |
|---|---|---|
| 经已核验 Bot 根实际派发新项目 | 轻坐正 → 小幅收拢手势 → 回舒服监督位；不向某个负责人槽位递物 | 普通新 Run 不触发收件；对应主 agent 自己进入工作状态 |
| 工作推进／用户检查项目 | 安静监督，偶尔自然短停手；检查只改变详情 | 安静陪伴；不演听取汇报、批示或执行项目工具 |
| 真实授权／问题 | 认真停一拍 → 面用户短开掌 → 真收手等待决定 | 抬眼注意用户 → 一次轻提醒 → 回可继续查看的稳态 |
| 观察到某项目本轮结果 | 小幅放松肩部、克制确认 → 回稳态，不接不存在的报告 | 一次面用户提示，不演接报告、汇总或派发 |
| 异常／结果未知 | 笑意收敛、停手关注，不责备、不慌乱 | 同样温和提醒；文字区分已确认失败与未知结果 |
| 当前覆盖范围明确安静 | 舒服共处及合资格的有限生活动作 | 同一人格；不把未选择项目当作全局空闲 |

这些是下一轮分镜意图，不是现有素材改名即可宣称完成。每句必须在正常小尺寸下呈现连贯的起势、停留和回收：头颈、肩背、躯干、双手与电脑承托共同过渡，不能从中性脸直接切到低头脸来代替整段动作。人物比例、服装、发饰、头发、手位和电脑接触要贯穿运动一致；入口和终点相同不代表中间已合格。

### 原画复用边界

保留既有身份、可靠坐姿、支撑姿态、微笑和真实回收来源；逐句常速审查后决定复用或补画。旧左右侧听、定向指示、派发来源仍归档保留，但不强塞进默认状态映射，也不把“左右看”改名为“通用监督”就视为新设计。未经完整身体联动复核的托腮、低头或脸部切换，不因单张图好看而直接上线。

## 5. 下一轮五组代表性分镜

### A. 三项目并行，工具每 50ms 变化

A、B、C 保留稳定负责人、短标题与实际工作状态。A 的读取→搜索→改写只更新它自己的状态，不触发 Varin 的脸、手或道具切换。人物保持舒服的监督／陪伴句子；不会逐个扫视项目，也不因席位重排转头。

### B. Bot 新项目真实派发，或 Agent 新 Run 开始

只有已核验 Bot 项目的新派发边缘能触发一次通用接到安排的短句；负责人在自己的稳定位置就位，人物不向它看、指或递纸。Agent 新 Run 只改变项目层。首次快照、重连和刚核验归属不重演历史开工；已开始执行不需要伪装仍在 accepted 阶段。

### C. B 授权、C 问题同时需要用户

人物只做一次面用户“需要你决定”的完整句子。B 自己保留锁与授权短签，C 自己保留问号与待答短签；不逐项排队转头或呈交。用户真实批准 B 后只更新 B，C 继续可见；只看过 B 不算批准。事实立即更新，人物不因每个计数变化重启整句。

### D. A 本轮完成，B 仍工作

A 自己显示精确本轮结果，B 继续工作。人物最多一次通用克制确认，不轻指 A、不接 A 的虚构状态卡，也不全局庆祝。A 尚有未结算工作时照实保留。新紧急事项立即显示，当前句子走最近安全回收；不排队补播旧完成动作。

### E. 用户检查 C，而 D 出现结果未知

检查面板仍显示 C；D 的核查标记留在 D 自己的身份旁和待办列表。人物可用一次温和关注提醒用户，但不切成看 C／再指 D 的空间追踪。用户自由继续检查或打开 D；检查、查看、本地社交回应都不能清除真实待办。

## 6. 精确关系：只画真实负责人和真实子队

全局 attention 的 branch 是执行身份，不单凭 parentThreadId 判定角色。只读 `botEntries` 从 Host 校验过的 Bot profile entry/revision 提供本体边界，`delegations` 从既有稳定派发关系提供精确父子分支与原始 acceptedCursor；终态移出 CURRENT 不能让项目负责人退化成未知子任务。backend `7fa96e77` 已实现并以 native fixture 验证同事务紧凑 `teamExecutions`，不是未来占位合同。每项包含原 parent thread/branch/run、child operation、execution ID、child thread/branch、原已保存头像、owner state、childRunId/childRunState 及必要 activity。只有 exact relation 才把子请求接到具体父 branch；单独 parentThreadId 仍不足以猜分支归属。

当前关系范围是现有 Family CURRENT 中每个真实 child 的最新 execution；包括仍需交付/结算的终态成员，不含任意历史。child Run terminal 而 delegated owner 仍 ready 时为 settling；owner 真正 terminal 才离场。原 parentRun 跨 continuation 保留。没有任务输入/正文/工具参数，没有新的调度或写入，沿同一个全局只读 attention 流更新，不为每个项目开 full snapshot/projection。
每个可见工作席显示实际主 agent，并通过 `portfolio.teams` 的 projectKey 展示自己的真实直接子队（最多三席、每席最多三个可见成员，各有真实 overflow）；空队保持空，不凭负责人工作状态捏造子成员。未覆盖的小队信息显示未读取/未知，不能用装饰精灵凑数。旧父 Run 派发的真实工作可继续属于同一父 branch，精灵按自己的原 parentRun/execution 校验；terminal 所有结局都中性离场，失败保留在结果/待处理。准备失败但未终结可显示温和问题标记。

同一 child 多 execution 的头像身份不变，仍有工作就不能被旧终态移除。原全局 ledger 只计一次请求；父卡“子任务需要你”是指向同一项，不复制请求数字。

Bot 收件只由已核验根的真实新派发事件触发：同 epoch 的前后 snapshot cursor 区间中出现原 acceptedCursor，即使首个可见 Run 已在 executing 也可一次接件；首屏、重连、刚核验根、已终态派发不补演开工。收件尚无 child Run 时不借用 parentRun 冒充其执行身份。

## 7. 下一轮并发仲裁：保留完整句子，事实不等动画

- 单一播放器只执行一个身体句子。同类普通事件不重启当前句子；不同普通事件到自然收手点再选最新仍有效的一句，不缓存逐项目手势队列。所有项目事实、待决事项和观察健康立即更新。
- 紧急事项不能被最低播放时长压住；身体走最近可信支撑/回手出口。抓放最高优先，完成后恢复最新稳态，不补演被中断的旧事项。局部社交不改管理 subject 或请求归属。
- 任务层的强调在对应身份自己的位置有限发生，不让负责人飞到人物面前来强迫一套定向身体响应；重复事件不引发群体反复进出。
- 拖动、隐藏、重连与切换 Host 丢弃短管理边缘；恢复只显示当前项目台，不补播旧接单、旧结果和旧分派。
- 在屏幕阅读器中明确区分“Varin 项目总览”“正在检查 A”“B 需要你”；不用动画和颜色作为唯一信息。减少动态模式固定管理姿态和角色身份，仍保留完整项目状态。
- 显式面板才接受键盘/指针；透明项目卡、精灵、连接线仍完全穿透。主 agent 的角色外观使用本地白名单资源，不引入任意 SVG/HTML/remote URL。
- 检查关系未知、外部 Harness 未覆盖、Host 断联各自保留其边界。没有选中项目不是 idle 事实；选中项目完成不是 portfolio 完成。

## 8. 当前实现接口与验证边界（尚未完成上述新映射）

`directorPresentation.ts` 当前提供只读投影：输入全局 attention、观察健康、检查身份与本地可见/拖动状态；输出管理 body verb、稳定项目卡、真实主 agent identity、检查镜头、覆盖范围及 exact 短边缘。不导入工具分类，不调用写 API，不生成报告。现有 `attentionCoordinator`、ledger、面板和 child identity 校验继续复用，旧 `projectCompanionIntent` 保留给项目执行详情。

`directorPortfolio.ts` / `useDirectorPortfolio` 将投影映射为最多三个稳定 A/B/C 席位及每个可见项目各自的直接子队；传给非交互场景的是短 opaque key、白名单头像、状态/类别枚举和当前已证实的计数。默认同时发送可读的真实任务短标题 caption（最多 24 个 Unicode 码点，超长末尾省略，空白规范化并清除控制/双向覆盖字符），以纯文本节点绘制；A/B/C 只作稳定席位辅助，不迫使用户打开面板才能知道主体。隐藏任务名选项省略 caption，但不改变席位或执行状态。完整标题与 thread/branch/run/request 身份留在交互 UI 的 legend；短标题绝不作为 HTML、URL、命令或导航目标解释。epoch/cursor 不匹配或健康未知时计数为 unknown，移除工具细节与小队，不把旧事实写成零。项目工具细节按自己的 identity/run 核验，独立于 Varin 身体 cue；当前身体 cue 仍控制管理交接/定向倾听/汇拢；这是待改造的现实现，不是下一轮应继续绑定任务位置的要求。子任务检查不复制成另一个根项目，也不把其孙任务画到根负责人的直接小队。

正常入口现消费已选 B 2.5D 小队及精确项目角色投影；离线 fixture 与候选加载仍仅在显式 review 入口。回归范围包括：无检查选择但多项目执行、每 50ms 工具变化不影响主体、两请求独立解决、一个项目完成另一个仍忙、检查镜头变化不切 body actor、历史结果/重连不重演、exact 负责人/子执行关系和 terminal 退出。

### 请求类别与短标题的呈现合同

项目 notice 从同一 attention snapshot 的实际归属事项去重生成：可操作授权为 permission，问题或 elicitation 为 question，其余审阅与异常为 inspect，多类为 mixed；陈旧来源为 unknown，无事项时省略。卡片与 brief 使用真实类别，不从 needs-user 猜授权。requestCount 只统计真实待决，uncertainCount 独立；失败和结果未知不会变成可回答请求。B 授权与 C 问题并存分别显示锁与问号，B 单独解除不清除 C。

浮层默认显示有界纯文本短标题，A/B/C 只辅助辨识；用户可隐藏任务名，完整标题和实际导航仍在交互面板。字符清理和转义不改变执行身份或权限。当前接线用于正常入口；显式 review 仍用于离线情境与候选比较。

### Normal-entry integration (2026-10-29)

Management presentation is independent of the developer review switch. Normal playback enables it only after the installed bundle passes the existing accepted-art decoder and contains the complete upright management action capability (`director-supervise`, both LISTEN directions, GATHER, intake, local attention, and closed idle). A review-only bundle is rejected by the normal loader; this capability check does not promote any source. The accepted bundle below is now selected; normal playback uses its supported director and local-interaction capabilities.

In management mode the real current-Host attention projection drives the portfolio. A chosen project is an inspection lens, not Varin becoming its tool executor. The existing accessible attention panel provides project inspection, exact per-project requests, opening the corresponding real task, and returning to the overview. The normal compact menu exposes “Projects and requests” and a decorative-title privacy switch. Offline fixture controls and permissive candidate decoding remain exclusively in the explicit development review entry.

Local attention and global idle eligibility use this same management mode. A cold welcome is permitted only on the current, available portfolio; work supersedes rather than queues it. Hover/tap, hidden/drag cleanup, scope-bound recovery and the accepted source pickup graph retain the same single body controller. The decorative window remains inert and cannot approve or execute project work. This section records implementation, not an additional normal-entry native acceptance claim.

## 当前部署开发产物与验证边界（2026-10-29）

当前公共 selected bundle 为 `1303a69840be467335a6400d9d8ebbd73d94b7a0fcd5cebebb22b44a9588bc18`，对应候选 `5729`；它替换此前的 `ed683`，目前仍部署用于开发。**用户最新反馈明确否定整体动作联动与运动一致性；selected/accepted 技术标记不代表当前视觉质量获认可，不能视作最终成品验收。** B 2.5D 小队用于正常 director 入口；开盖 hover、开/闭盖连续轻点的有限变化、安静顺侧发均已纳入已选资源及各自事实/姿态准入，不再统称 review-only。原选择与验证 JSON、冻结源目录中的 README/manifest 均保持原样，记录各自制作或审核当时的状态；其中 candidate-only/未切 selected 字样是历史归档说明，当前选用状态以本节为准，不改归档 inventory 哈希。

既有有限 Linux 功能 QA 未发现阻塞；这不抵消用户对视觉效果的否定。原生 hair/hover 连续捕获仍未得到充分结论，不能因资源已选就声称所有动态均已验收。没有 Windows/macOS 或所有中间帧认证。拖动时小队隐藏、落座后按最新事实恢复，当前没有小队动画避让。权限/问题保持精确项目归属；本地查看、hover 或轻点不是批准或回答。

### Product role binding: Bot versus Agent (2026-10-29)

The selected upright art capability does **not** determine the product role. The companion reads the existing authenticated `ExtensionsAPI.hostState` / `waitForHostState` workbench snapshot and resolves the authoritative user profile and built-in shell. `varin.bot` + Bot Workspace means **Bot coordinator**: intake, handoff, listening and presentation remain available. The default Agent profile + Agent Workspace means **Agent companion**: the user talks directly to the project lead; a new Run does not imply a delegation by Varin, and inspecting a project does not make its leader report to her. Exact pending items and observed results can prompt a user-facing notice while the project's own lead/team retains its work state.

Thread `runtime: 'agent'`, parent/child links, the existence of a Bot, directory selection and task titles are not product-mode evidence. Missing/non-authoritative/custom shell state remains `unknown` and uses non-delegating notification semantics until a known role is restored. Endpoint generation and workbench revisions fence stale responses. Switching product roles clears transient intake/result choreography and establishes a new edge baseline; historical work is not replayed as a new delegation.

The existing normal profile switch is the main window's **WorkbenchProfileSwitcher** (Agent / IDE / Varin bot), not the workspace directory selector. Offline coordination fixtures remain explicitly labelled and do not supply the real product mode. No Host protocol, execution authority, public art or native window geometry changes in this role-binding stage.
