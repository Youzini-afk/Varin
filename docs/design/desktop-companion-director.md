# Varin 主管式桌宠：项目台、负责人和子任务精灵

状态：2026-10-29，用户最新角色方向已确认；主管式投影与视觉原型制作中，**旧的项目工具 → Varin 身体动作直连不作为最终默认表现推广**。本文覆盖[多任务关注方案](desktop-companion-multitask-attention.md)中的角色和表现叙事；其只读全局事实、异步身份、完整待处理与可访问入口仍然保留。

完整的管理、异常与日常演员表演见[主管动作矩阵](desktop-companion-director-performance.md)，包括逐动作 E/H/X、主 agent/子队分工、现有源复用与真实补画缺口。

## 1. 她是谁：主管与秘书，不是所有项目的亲自执行者

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

主体的柔和生活感保留，但工作动作的叙事改为办公室里的总览与协调：看简报、记事项、递交卡片、检查进度。文字始终描述可靠事实，例如“2 个项目任务正在推进”“B 需要你的授权”，而不是未经证实的“我正在规划项目”“我已审核报告”。

## 2. 主 agent：同一家族的项目负责人，不再创造第二个 Varin

- 身份源是已有 `ThreadAttentionBranch.threadId + avatar`，调用 `agentAvatarForIdentity(threadId, avatar)`；与侧栏/聊天中同一线程头像一致。branch 和 currentRun 标定该项目当前执行，不能伪装为 child execution。
- 头像主体、脸和用户选定的色形保留；只在桌宠项目台加**负责人角色外观**。设计比较过短肩领/短披肩与菱形扣、分派斜带与侧文书夹、双翻领与肩签；用户已认可第一种概念方向，但混合头像的通用套装存在穿模，正逐头像修正。生产适配仍须依据 24px 左右的剪影和遮挡关系审阅，不靠颜色或皇冠区分，也不改头像库的全局默认值。
- 子精灵沿既有头像形状，无负责人外套。负责人在项目卡的标题/进度栏旁占固定位置，子队在其下方或外侧扩展，层级由位置与轮廓建立，不把负责人简单放大成第二个桌宠。
- 无当前 Run 时，真实负责人仍可作为项目身份的静态标记；不显示忙碌、不演派发。新 Run 使用原头像的新执行状态，旧完成回执不能让新执行消失。
- 负责人角色装饰是此表面的呈现层，不写回用户的 avatar 设置，不创建新 agent profile。

## 3. 项目台：少量稳定卡片，更多项目有明确入口

桌宠旁显示由实际可读空间决定的 2–3 个紧凑项目卡/文件夹。每张只保留标题短名、实际主 agent、一个状态短语和待处理标记；工具参数、路径、模型正文不进入透明装饰面。卡片使用稳定 thread/branch key，不因每次 updatedAt 或 token 到来全盘洗牌。

可见席位优先保证正在检查的项目与需要用户的事项，其余维持既有在台顺序；新增背景项目进入安静的“另有 N 项”入口，不抢占所有卡。这个数量是当前 Host 明确覆盖的项目任务展示集合，不是全世界任务总数，也不把父任务的子请求再计一次。

**点选项目是打开检查镜头，不是更换 Varin 的工作身份。** 既有可访问面板承载真正点击：总览、需要你、正在检查的项目、项目负责人、展开的小队。透明卡片本身继续穿透，不扩大点击区；项目卡旁的查看动作通过明确的交互入口完成，不能让透明图层偷走桌面点击。

- 总览：所有真实项目任务状态和待决事项。
- 检查 A：展开展示 A 的实时执行细节，可保留阅读/编辑/搜索等细分类别在 **A 的内容区域**。
- 身体：仍是跟进整个项目台的主管；检查 A 的工具改变不驱动身体换成 A 的执行姿态。
- 同时 B 需要授权：独立“待你决定：B”区域保持可见，检查 A 不把 B 的请求静音，也不强制关闭 A 的检查面板。

## 4. 身体只对管理层有意义的变化回应

单一播放器和真实接触回收继续保留。新的 `DirectorIntent` 与项目 `CompanionIntent` 分离；后者可用于检查详情，但不再直接选择主体动作。

| 全局事实/变化 | 管理表演 | 持续与边界 |
|---|---|---|
| 已同步且有执行/未结算工作 | 安静审阅概况、短记录、看项目台 | 背景稳定；工具突发只更新卡内事实，不重启身体 |
| 首次同步发现已有工作 | 当前项目卡直接在位，主体进入跟进 | 不补演所有历史接单、分派或结果 |
| 连续观察到新的顶层 Run 真正受理 | 短接收工作卡、放入项目台 | 文案“新一轮已受理”；不假定来源必然是用户，也不逐工具演接单 |
| exact 项目新派发子执行 | 主 agent 向其子队分派；Varin 可短示意协调 | 由真实 relation 和 execution 新边缘触发，不把主 agent 派发冒称 Varin 执行了后端命令 |
| 多个真实可响应请求或不确定结果 | Varin 把待决事项递向用户、停在温和关注姿态 | 每项卡有项目/请求身份；通用“需要你”姿态不等于全局授权锁 |
| 某顶层 Run 非终态→明确 completed/failed/cancelled | 接收该项目的状态卡，短指示结果 | 按真实结局说“A 本轮完成/失败/取消”；未结算子工作仍保留，不全局庆祝、不生成不存在的报告文件 |
| 项目失败/准备问题 | 结果/问题卡上明确标注，主体温和检查 | 失败不会让整个项目台崩溃；不可回答的信息不伪装为审批请求 |
| 未观察到当前执行或待决事项 | 可用、等待用户的新安排 | 只描述当前覆盖范围，无“你的所有目标已完成”承诺 |
| 断联/同步 | 停止新管理边缘，保留最后已知卡的未知标记 | 不做新结果庆祝、不把未知清成零 |

### 复用现有获批姿态而不浪费原画

托腮图可用于审阅项目概况；键区短输入用于记录事项的管理隐喻；指屏/输出图用于指出真实状态卡；接单胸前回应图用于收到新一轮工作；分派手势用于项目台协调。已有检索/阅读装饰可移入检查卡的局部内容，不必把它们都围到 Varin 身边。

这不是给旧“她正在执行工具”文案换个标题。**触发粒度、叙事主体、场景锚点都改变**：项目工具事实不再驱动主身体；项目主 agent 是执行者；Varin 的少量动作以全局待决集合和真实管理边缘为依据。

## 5. 五组代表性分镜

### A. 三项目并行，工具每 50ms 变化

A 卡显示资料阅读，B 卡显示实验执行，C 卡显示文本生成；各自有真实主 agent。Varin 看项目台、短记一笔、回到安静跟进。A 的读取→搜索→改写只更新 A 卡/检查详情，没有人物连续换道具。各工作中的负责人以稳定小队席位出现；较小的真实子 agent 围绕所属负责人交流，不把全部任务堆成卡片。检查只改变详情镜头，不决定其他真实小队是否可见。

### B. 新项目真实受理

观察到新顶层 Run accepted，项目台新增一张有标题/身份的卡；Varin 轻接一下卡、放入工作列，主 agent 在卡旁就位。若下一帧已进入执行或 urgent 请求到来，短接收动作中性收束，不为最短播放时间假装仍在准备。初始快照已有的项目不重演这一幕。

### C. B 授权、C 问题同时需要用户

Varin 向用户呈上待决事项，不把 B 的锁套到整张项目台。B 卡标“需要授权”，C 卡标“等待回答”，待处理列表两项都可达。用户批准 B 后仅 B 项更新；C 保留，所以主体继续“需要你”的温和姿态，不做“全已批准”点头。拒绝/取消中性更新；真实回答/permission receipt 仍 exact scope，不因任一项消失推断许可。

### D. A 本轮完成，B 仍工作

Varin 接收 A 的结果状态卡，轻指 A 的完成标记；B 主 agent 保持实际执行状态。若 A 有子工作/操作仍未结算，卡明确“A 本轮完成，仍有工作”。桌宠不闭盖表示全部结束，也不杜撰报告成品。新的 B 请求出现时，A 的短回应直接让位；之后不补播。

### E. 用户检查 C，而 D 出现结果未知

检查面板展现 C 的主 agent、当前工具概括和真实子队；主体不化身 C 去执行工具。D 的未知结果进入独立待处理区域，Varin 呈上需要核对的事项；用户可继续看 C 或打开 D。检查选择不等于自动切换执行、不改变批准目标、不隐藏其他项目。

## 6. 精确关系：只画真实负责人和真实子队

全局 attention 已有 branch 的实际主 agent 身份；backend `7fa96e77` 已实现并以 native fixture 验证同事务紧凑 `teamExecutions`，不是未来占位合同。每项包含原 parent thread/branch/run、child operation、execution ID、child thread/branch、原已保存头像、owner state、childRunId/childRunState 及必要 activity。只有 exact relation 才把子请求接到具体父 branch；单独 parentThreadId 仍不足以猜分支归属。

当前关系范围是现有 Family CURRENT 中每个真实 child 的最新 execution；包括仍需交付/结算的终态成员，不含任意历史。child Run terminal 而 delegated owner 仍 ready 时为 settling；owner 真正 terminal 才离场。原 parentRun 跨 continuation 保留。没有任务输入/正文/工具参数，没有新的调度或写入，沿同一个全局只读 attention 流更新，不为每个项目开 full snapshot/projection。
每个可见工作席显示实际主 agent，并通过 `portfolio.teams` 的 projectKey 展示自己的真实直接子队（最多三席、每席最多三个可见成员，各有真实 overflow）；空队保持空，不凭负责人工作状态捏造子成员。未覆盖的小队信息显示未读取/未知，不能用装饰精灵凑数。旧父 Run 派发的真实工作可继续属于同一父 branch，精灵按自己的原 parentRun/execution 校验；terminal 所有结局都中性离场，失败保留在结果/待处理。准备失败但未终结可显示温和问题标记。

同一 child 多 execution 的头像身份不变，仍有工作就不能被旧终态移除。原全局 ledger 只计一次请求；父卡“子任务需要你”是指向同一项，不复制请求数字。

## 7. 单一表演、稳定信息与可访问性

- 全局最新管理意图只有一个，不排队缓存所有项目边缘。普通身体姿态可以稳定；所有项目卡事实、待决事项和观察健康立即更新。
- 拖动、隐藏、重连与切换 Host 丢弃短管理边缘；恢复只显示当前项目台，不补播旧接单、旧结果和旧分派。
- 在屏幕阅读器中明确区分“Varin 项目总览”“正在检查 A”“B 需要你”；不用动画和颜色作为唯一信息。减少动态模式固定管理姿态和角色身份，仍保留完整项目状态。
- 显式面板才接受键盘/指针；透明项目卡、精灵、连接线仍完全穿透。主 agent 的角色外观使用本地白名单资源，不引入任意 SVG/HTML/remote URL。
- 检查关系未知、外部 Harness 未覆盖、Host 断联各自保留其边界。没有选中项目不是 idle 事实；选中项目完成不是 portfolio 完成。

## 8. 实施接口与验证边界

`directorPresentation.ts` 先提供独立纯投影原型：输入全局 attention、观察健康、检查身份与本地可见/拖动状态；输出管理 body verb、稳定项目卡、真实主 agent identity、检查镜头、覆盖范围及 exact 短边缘。不导入工具分类，不调用写 API，不生成报告。现有 `attentionCoordinator`、ledger、面板和 child identity 校验继续复用，旧 `projectCompanionIntent` 保留给项目执行详情。

候选 `directorPortfolio.ts` / `useDirectorPortfolio` 将投影映射为最多三个稳定 A/B/C 席位及每个可见项目各自的直接子队；传给非交互场景的是短 opaque key、白名单头像、状态/类别枚举和当前已证实的计数。默认同时发送可读的真实任务短标题 caption（最多 24 个 Unicode 码点，超长末尾省略，空白规范化并清除控制/双向覆盖字符），以纯文本节点绘制；A/B/C 只作稳定席位辅助，不迫使用户打开面板才能知道主体。隐藏任务名选项省略 caption，但不改变席位或执行状态。完整标题与 thread/branch/run/request 身份留在交互 UI 的 legend；短标题绝不作为 HTML、URL、命令或导航目标解释。epoch/cursor 不匹配或健康未知时计数为 unknown，移除工具细节与小队，不把旧事实写成零。项目工具细节按自己的 identity/run 核验，独立于 Varin 身体 cue；身体 cue 只控制管理交接/倾听/汇拢。子任务检查不复制成另一个根项目，也不把其孙任务画到根负责人的直接小队。

实际主体姿态映射、项目台构图、主 agent 角色外观对齐后，只先接隔离 review 消费者；不升级默认 app 或已选资源。验收至少覆盖：无检查选择但多项目执行、每 50ms 工具变化不影响主体、两请求独立解决、一个项目完成另一个仍忙、检查镜头变化不切 body actor、历史结果/重连不重演、exact 负责人/子执行关系和 terminal 退出。

### 请求类别与短标题的呈现合同

项目 notice 从同一 attention snapshot 的实际归属事项去重生成：可操作授权为 permission，问题或 elicitation 为 question，其余审阅与异常为 inspect，多类为 mixed；陈旧来源为 unknown，无事项时省略。卡片与 brief 使用真实类别，不从 needs-user 猜授权。requestCount 只统计真实待决，uncertainCount 独立；失败和结果未知不会变成可回答请求。B 授权与 C 问题并存分别显示锁与问号，B 单独解除不清除 C。

浮层默认显示有界纯文本短标题，A/B/C 只辅助辨识；用户可隐藏任务名，完整标题和实际导航仍在交互面板。字符清理和转义不改变执行身份或权限。当前接线属于隔离 review 候选，公共角色资源尚未切换。

### Normal-entry integration (2026-10-29)

Management presentation is independent of the developer review switch. Normal playback enables it only after the installed bundle passes the existing accepted-art decoder and contains the complete upright management action capability (`director-supervise`, both LISTEN directions, GATHER, intake, local attention, and closed idle). A review-only bundle is rejected by the normal loader; this capability check does not promote any source. The legacy selected bundle remains on its previous path until the parent-controlled exact asset selection is installed.

In management mode the real current-Host attention projection drives the portfolio. A chosen project is an inspection lens, not Varin becoming its tool executor. The existing accessible attention panel provides project inspection, exact per-project requests, opening the corresponding real task, and returning to the overview. The normal compact menu exposes “Projects and requests” and a decorative-title privacy switch. Offline fixture controls and permissive candidate decoding remain exclusively in the explicit development review entry.

Local attention and global idle eligibility use this same management mode. A cold welcome is permitted only on the current, available portfolio; work supersedes rather than queues it. Hover/tap, hidden/drag cleanup, scope-bound recovery and the accepted source pickup graph retain the same single body controller. The decorative window remains inert and cannot approve or execute project work. This section records implementation, not an additional normal-entry native acceptance claim.

## Selected normal-entry checkpoint (2026-10-29)

The exact reviewed candidate `40c6f4f9f0c46c2b4c248fcf798fe3c726b77bb6dac7a59accbd485db2eeb4d2` was selected through the artifact-bound selector. The installed accepted bundle is `ed6830296471e492521e7f0b9adc026f057a0e744726faa86462c5cee90ad2aa`; the earlier `399bf` baseline remains preserved in source history and reconstruction inputs. Normal playback now enables the director capability from accepted assets, while candidate admission and offline examples remain development-review-only.

See `desktop-companion-assets/director-performance/selection-review.json`, `native-squad-validation.json`, and `native-normal-validation.json` for separate art-selection, multi-project offline/native, and normal real-Host-empty smoke scopes. These records do not claim live paid concurrent runs, release performance, or every frame on every OS. The UI and Electron type checks, targeted projection/interaction/renderer/validator tests, full web/main builds, and native window cleanup were checked at this checkpoint.
