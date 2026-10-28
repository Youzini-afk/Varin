# Varin Q 版桌宠：状态差分与配色蓝图

状态：2026-10-29，设计提案，尚未实施。Q 版、丰富工作差分与主题重点色联动已确认；32 种表现与 8 个配色族作为规划基线，具体动作、资源格式和交互细节按本稿评审。本文不引入角色原始图片或第三方动画 SDK。

## 已确认的角色与产品方向

- **Q 版，约 2.5–3 头身**，保留成年角色身份；不是原比例桌面立绘方案。
- 要丰富的工作状态差分，并联动 Varin 的真实工作；不是先限定成几个姿势。
- **瞳色固定**；**发饰、毛衣、裙子内里、吊坠**可以根据重点色变化。主题变体不限定为基础稿的黑灰发饰；Logo 几何形状与人物自身左侧位置仍固定。
- 保留银白头发、唯一左侧圈丸、横向编发与黑蝴蝶结、奶白外衫、深灰结构外裙、吊坠/工作牌位置。不得整图镜像或全图 hue-rotate。
- 现有三视图与角色设定是身份参考，不是 Q 版母版、差分或分层动画资产。正式资产需要完成 Q 版转译、透明边缘清理和一致性验收；角色资产授权与代码许可分别确认。

## 规划范围

**先规划 32 个可命名的表现：6 个核心工作、8 个工具活动、5 个等待、6 个异常恢复、7 个生活互动；配色做 8 个色系。**

32 是可识别的美术/表现目录，不是32个新后端状态，也不要求画 32×8=256 套独立全身图。采用姿态、表情、道具、状态标记、重点色分层组合；差异大的动作才单独重画。各差分可以静态开始，但完整目录先设计好，不以技术验证阶段的动作数量替代完整设计目录。

## 1. 核心工作：6 种

| 编号 | 表现 | Q版动作/表情 | 实际触发与边界 |
|---|---|---|---|
| C01 | 待命陪伴 | 放松站姿、温和微笑 | 已连接、无当前活动；未连接不能假装待命 |
| C02 | 接到任务 | 抬头、接过小任务卡 | 明确受理 `accepted`，不能只凭按钮被点击 |
| C03 | 准备工作 | 整理袖口/展开小清单 | `preparing`；`runnable` 可共用准备收尾，非独立复杂动画 |
| C04 | 思考/组织答案 | 手指轻抵脸颊、专注 | `generating`；仅代表生成活动，不宣称读取私有思维 |
| C05 | 输出/交流 | 看向用户、轻手势、对话标记 | 已观察到公开文本增量；与 generating 共用基础姿态但有表达差分 |
| C06 | 工作完成 | 合上清单、满意小笑、轻点头 | 真实完成终态；表示本轮完成，不承诺用户全部目标已验证成功 |

## 2. 工具活动：8 种

| 编号 | 表现 | 差分/道具建议 | 分类依据 |
|---|---|---|---|
| T01 | 阅读文件/论文 | 捧书或资料页、目光向下 | 已实际运行的读取/材料工具 |
| T02 | 写作/编辑 | 坐着写字或抱写字板 | 文本编辑/文档操作 |
| T03 | 编程/终端 | 小键盘、专注敲击 | 终端/代码执行；启动 shell 不等于测试成功 |
| T04 | 搜索/浏览 | 放大镜、轻前倾 | 搜索、浏览器读取/导航 |
| T05 | 计算/实验 | 看小图表或计算板 | 明确计算/研究工具活动；不凭终端输出猜“训练中” |
| T06 | 整理/归档 | 整齐叠资料/小文件夹 | 文件整理、归档等已识别操作 |
| T07 | 检查/验证 | 拿检查单逐项确认 | 明确验证工作；普通执行无法识别时用通用工作姿态 |
| T08 | 协作/调度 | 分发任务卡、看几个小状态点 | 有 children/family/delegation 事实 |

工具类别是 UI 的可维护映射表，不是靠模型自由生成状态名称。消费已识别的工具/operation 身份及运行阶段；未识别工具回退通用工作。不要展示工具参数、路径或网页正文。一个工具可能同时满足多个类别，以主要活动为准，不快速换装闪烁。T02/T03、T01/T07可共用姿态骨架，但道具、眼神和小动作不同。

## 3. 等待：5 种

| 编号 | 表现 | 画面 | 事实要求 |
|---|---|---|---|
| W01 | 任务排队 | 抱任务卡、等候姿态 | `QueuedInput.state=queued` / operation queued；与已运行任务可并存，角标表示数量 |
| W02 | 等待授权 | 举小盾牌/确认卡、认真看用户 | 明确 permission request，不从所有 `waiting` 推断 |
| W03 | 等用户回答 | 疑问表情、问号卡 | 明确用户问题/输入请求；与权限审核使用不同图标和文案 |
| W04 | 等子任务/外部结果 | 侧看任务板、安静坐等 | child wait、reply wait 等可靠原因；无原因只写“等待中” |
| W05 | 等待重试 | 看小计时器、耐心表情 | provider `retry_scheduled` 等明确事件；只在有 retryAt 时倒计时 |

W02/W03 的点按只进入现有确认/回答界面，不自动批准、不把摸头动作绑定 allow。W04不是“摸鱼”；运行与等待都可用轻松风格，但语义仍清晰。

## 4. 异常与恢复：6 种

| 编号 | 表现 | 画面 | 必须保留的语义 |
|---|---|---|---|
| E01 | 工作失败 | 小皱眉、翻开问题卡 | 明确 Run failed / Operation failed；单个工具失败不自动等于整轮失败 |
| E02 | 正在取消/收尾 | 停手、收拾资料、暂停手势 | `cancel_requested=true` 且工作未证实停止；不能提前松口气 |
| E03 | 已确认停止 | 放下道具、平静点头 | 该作用域的执行/Operation已明确实际停止，不能仅由Run cancelled触发；已交接子工作仍单独显示。停止未确认时保留E02/E06，或中性标记“本轮已取消” |
| E04 | 断联/状态未知 | 淡化连接小标记、困惑但不哭 | observer/Host不可用或状态过期；旧busy可标最后已知，不伪造终态 |
| E05 | 重连/同步 | 整理散开的状态卡 | 传输恢复并正在取快照；恢复后不补播旧成功庆祝 |
| E06 | 结果待核查 | 举放大镜和问号结果卡 | outcome indeterminate / effect unknown 等；与普通失败不同，不能自动重做 |

不要用红色大哭或负罪感惩罚用户；错误提示可爱但可读。取消意图、效果未知、已确认停止必须分别可辨。

## 5. 生活互动：7 种

| 编号 | 表现 | 建议 |
|---|---|---|
| L01 | 出场/欢迎 | 短挥手，不打断输入、不抢焦点 |
| L02 | 呼吸/眨眼 | 全部基础姿态可叠加的轻循环 |
| L03 | 轻点回应 | 微笑/歪头，短反馈有冷却，不自动发送消息 |
| L04 | 拖动/被提起 | 轻收腿、惊讶表情；明确拖动阈值，勿误触点击 |
| L05 | 落地/整理 | 站稳、整理衣摆，落点锚点一致 |
| L06 | 困倦/伸懒腰 | 无打扰的闲置姿态；不代表 runtime 睡眠或停止 |
| L07 | 安静陪伴 | 坐着/靠边，免打扰或减少动态时仍可读状态 |

这一组纯 presentation，不触发工具、读屏、摄像头或全局键盘监听。用户无需养成、喂食或每日打卡。

## 6. 多任务时显示哪一个

- 绑定明确 Host 和关注 Thread/branch，不能把另一 Host 的同名 Thread 当当前任务。
- 状态分轴而非单一 emotion：`connection + attention + execution + queued/unread + interaction`。
- 视觉优先：需用户处理事项（授权/提问/未知效果）→取消收尾/明确失败→关注任务的活动→新结果→待命。断联是覆盖层，不能被成功或忙碌覆盖。
- 用户正在拖动时优先保留拖动姿态，同时保留状态徽标；结束后恢复工作姿态。
- 多项同时存在时，角色只展示一个主动作，小卡列出“2项等待确认、3项进行中”；不让角色每秒切换、不复制多只角色、不自动切对话。
- 成功反馈仅按具体 Run/事件去重播放；`busy→idle`、未读增加、HTTP请求返回都不等于“全部完成”。

## 7. 配色：8 个色系，跟随真实主题重点色

[packages/ui/src/lib/theme/themes/index.ts](../../packages/ui/src/lib/theme/themes/index.ts) 明确装配 Varin、Flexoki 与 presets，目前装配42个主题JSON（21组明暗）。`colors.primary.base` 是本表核对的重点色值；**8个色系是桌宠美术组织提案，不是产品只有8个内置主题**。

| 桌宠色系 | 内置实例（dark / light） | 视觉意图 |
|---|---|---|
| 1 默认雾蓝 | Varin `#7aa7ef` / `#4b6fac` | 最接近当前角色基准 |
| 2 冰青 | Nord `#88C0D0` / `#5E81AC`；Ayu `#3FB7E3` / `#4AA8C8` | 清爽冰青；Nord浅色实际偏蓝，不强制变青 |
| 3 鸢尾紫 | Aura `#A277FF` / `#A277FF`；Dracula `#BD93F9` / `#7C6BF5`；Monokai紫 | 柔和紫调 |
| 4 薄荷/松绿 | Vitesse Dark `#4d9375`；Vitesse Light `#1c6b48` | 清浅绿/深松绿 |
| 5 橄榄绿 | Fields of the Shire `#7a8a5a` / `#4a6030` | 低饱和自然暖绿 |
| 6 暖杏 | Vesper `#FFC799` / `#a06535` | 杏色/暖棕，温暖陪伴 |
| 7 琥珀橙 | Flexoki `#DA702C` / `#BC5215` | 更有活力但不荧光 |
| 8 黑白 | Mono `#FFFFFF` / `#000000` | 中性单色，要以灰阶层次保证可见 |

其余多种蓝/青/紫主题可直接取各自真实 accent，而不是强制等同 Varin 色。Mono Plus 其实是蓝色重点色，不应因名称含 Mono 被错误归到纯黑白。主题目录以[实际注册入口](../../packages/ui/src/lib/theme/themes/index.ts)、[预设装配](../../packages/ui/src/lib/theme/themes/presets.ts)及各主题 JSON 为准，不维护第二份完整主题清单。

### 换色部位

- **发饰**：保留双片几何形状、方向与左侧位置；可使用重点色的深浅两档，不再坚持全变体黑灰固定。
- **毛衣**：主色取低饱和版本，让肤色和眼睛仍突出。
- **裙子内里**：同色系更浅、更柔和，保留与深灰外裙对比。
- **吊坠内芯**：同色系透亮版本，金属边框保留材质。
- **固定**：瞳色、银白头发、肤色、奶白外衫、深灰外裙/腰封/鞋等基础识别部分。以后若改这些，另由用户确定。
- 道具/状态卡可跟随 UI theme，但错误/警告/成功语义色不被 accent 覆盖；必须同时有形状/文字，不能只靠颜色识别。

深色主题不等于把角色整体调暗；浅色主题也不把她漂白。不同部位同色系、不同明度饱和度，须分别画色样与阴影。任意自定义 accent 是后续可选能力，不作为现有产品能力。若引入，应通过主题 owner 提供合法色值，并对四个换色区域生成相应配色，而不是创建另一套主题存储。

## 8. 分层资产方案：丰富而可维护

建议母版：Q版正面/斜前基准、脸部表情板、各姿态脚底锚点、服装可换色区遮罩。常用小姿态的表情可组合；手持物遮挡关系复杂的姿态单独画，不能靠“任意拼贴”承诺复用全部。

建议资源元数据（概念结构，不是可执行接口）：

```text
CompanionAsset {
  id; version; characterRevision; // 同一角色母版
  poseId; expressionId; propId; motionId;
  facing; anchor; bounds; hitAreas;
  layers: { base, expression, propFront, propBack, accentMasks };
  recolorSlots: ['hairClip', 'sweater', 'underskirt', 'pendantCore'];
  paletteRecipe; // 原重点色→部位明暗/饱和度，不全图滤色
  frames; durations; loop; transitions; fallback;
  supportedCombinations; reducedMotionAsset;
  source; author; license;
}
```

工作状态映射与资源分离：`semantic state → visual recipe → available asset`。缺失某个动作时用同语义标记+基础姿态，不回退成错误的成功或待命。共用呼吸/眨眼和入场/离场过渡；耳后圈丸、Logo、工作牌不因切换姿态换边。发布前保留各配色样张做对照，不需把所有组合预渲染成大图库。

## 9. 源码依据与呈现边界

- [packages/protocol/src/agent-runtime.generated.ts](../../packages/protocol/src/agent-runtime.generated.ts)：RunState=`accepted/preparing/runnable/generating/executing/waiting/completed/failed/cancelled`；OperationPhase=`accepted/preparing/queued/running/waiting/settling/terminal`；Outcome=`succeeded/failed/cancelled/indeterminate`；Effect=`none/dispatched/partial/confirmed/unknown`；Run/Operation各有`cancel_requested`、`waiting_on`。不能单凭waiting字符串确定等待对象。
- [packages/application-client/src/threads.ts](../../packages/application-client/src/threads.ts) 的 ThreadSnapshot 已含 activeRun、runFailure、inputs、operations、children/childActivity 等。InputState=`queued/delivered/cancelled`。`decidePermission`等现有API仍是原界面的操作入口。权限/问题沿原具体请求事实做投影；具体已核对见下一项。
- `packages/ui/src/components/thread/ThreadOverview.tsx:74–99`：当前run取`activeRun`或对应分支`latest_run`；等待operation须`operation.waiting_on === run.waiting_on`且非terminal。`executor === ask_user`识别问题，`waiting_on`以`permission:`开头识别审批。`ThreadPermission.tsx`进一步检查control result中的`permission`、`decision === null`、phase waiting、未cancel requested；`ThreadQuestion.tsx`从`operation.intent.call.arguments`经`readUserQuestions`读取，terminal不显示。桌宠应抽取共享只读selector，保留这些范围与就绪条件，而非另造问答或授权store。其他MCP交互、launch pause、恢复异常还需沿各自原owner细化；未知类型回退“需处理/等待”，不套用ask_user。
- 完成/失败/取消可读取对应分支`latest_run`的明确state（activeRun消失本身不是完成）；未读使用Thread的`activity_cursor/read_cursor/unread`事实，二者独立。重试仅取明确retry事件；取消还要保留Operation/子任务剩余工作，不能把Run cancelled说成所有外部进程已停止。
- [packages/ui/src/lib/agent-runtime/thread-projection.ts](../../packages/ui/src/lib/agent-runtime/thread-projection.ts) 已处理 snapshot/cursor observe、progress identity及重连。`retry_scheduled`和公开文本增量可作为细分表现事实；不凭时间猜测。
- `useTraySync.ts` 实际仅推main branch busy/idle、unread且`approvals:[]`。不能直接复用托盘快照就声称完整审批/错误状态已具备。
- Electron `main.ts` 的 `createMiniChatWindow`及`thread-window-target.ts`已实现按Host/Thread/branch复用；桌宠点按接入既有Mini Chat，不另建会话数据库/模型调用链。
- 角色窗是独立presentation；拥有自己的观察订阅，不依赖主窗必须常开。preload/desktop typed catalog/main sender校验和本地凭据边界沿用。关闭桌宠不取消工作。
- 原生窗口必须另外验证穿透、焦点、多屏/DPI、退出/托盘恢复。透明像素不自动原生穿透；Wayland定位/置顶有限制。具体支持范围以目标平台验收为准。[Electron交互](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[窗口API](https://www.electronjs.org/docs/latest/api/base-window)、[screen](https://www.electronjs.org/docs/latest/api/screen)。

## 10. 设计交付顺序（不删减目录）

1. 先定Q版母版和8色系小色样；按最新四个换色区域分层。
2. 画32项缩略动作/表情分镜，一次看完整表现范围；识别可以共用的姿态。
3. 将状态目录与真实字段逐项对齐；未有可靠事实的工具细类保留视觉设计，但软件回退通用活动。
4. 再做定稿差分、短循环和交互过渡；最后选择静态差分、序列帧或分层模型实现。Live2D若采用需另行分层/rig与许可审查，三视图无法直接充当模型。

## 11. 桌面入口、多窗口与生命周期

桌宠是共享 Application Host 的呈现客户端，不是新的会话 backend。对话、队列、授权、实际执行和耐久历史继续归原 owner；职责遵循[架构](../architecture.md)及[Electron 模块说明](../../packages/electron/README.md)。

- **入口**：用户在设置或托盘主动开启；单击角色显示状态卡，明确点击对话入口才打开现有 Mini Chat。无关注任务时提供选择任务/新建草稿，不因加载角色自动创建会话。默认不抢焦点，不自动提交消息。
- **作用域**：单实例角色明确绑定一个 Host，可选固定 Thread/branch 或跟随所选任务。关注作用域使用 `runtimeTargetKey + threadId + branchId`，复用 [thread-window-target.ts](../../packages/electron/thread-window-target.ts) 的身份语义。不同窗口的 Zustand 不是共享内存，不能把主窗状态当可靠全局 owner。
- **观察**：角色拥有自己的轻量 Catalog/关注任务订阅，主窗关闭后仍可显示真实状态；不为每个任务订阅全文，也不把所有 Host 混成无来源计数。Host切换取消旧观察、清理临时姿态并改变generation；迟到旧事件不得更新新作用域。
- **动作**：点开原 Mini Chat 时继承来源窗的 runtime 配置和真实Thread/branch，不把凭据放入 URL。权限/提问跳原界面，沿原请求再校验；角色不因同源获得任意原生能力。
- **可信边界**：沿 [desktop typed contract](../../packages/application-client/src/desktop.ts)、preload和main检查新增窄命令。main核验sender窗口/调用frame及参数，不接收任意window ID、IPC方法、路径或endpoint；不自动扩大remote-safe白名单。
- **位置与恢复**：主进程以DIP管理位置，保存显示器锚点和偏移；响应屏幕拔插、缩放、旋转和workArea变化。失去副屏后回到可见工作区。透明区域需原生穿透策略，CSS透明不代表能点到下层应用；无法可靠逐区域穿透的平台提供明确交互模式及托盘恢复入口。
- **生命周期**：关闭角色不取消Run；退出Varin结束角色，不另起守护进程。单独定义角色是否计入“产品窗口”，接入现有退出确认、beforeunload和Host drain顺序，避免透明窗拦住退出或主窗关闭意外结束角色。隐藏/显示、崩溃重开、更新退出均清理监听与计时器。
- **平台降级**：Windows/macOS测试原生穿透、焦点和置顶；macOS额外覆盖Spaces/全屏。Linux按X11/Wayland区分；Wayland全局定位/置顶受限时退为普通伴随窗口，不强制切显示协议或索要无关权限。

## 12. 动画编排与低打扰

同一时刻一个主动作，表情、道具和状态标记补充语义。快速工具进展合并为稳定活动，不按每条网络事件切动作；状态标签可立即更新，动作在可打断点平滑过渡。授权/提问、取消和断联可立即中断装饰性庆祝，不等待整段动画播完。

- 站立、坐姿及拖动姿态共用约定锚点；道具收起后再进入不兼容姿态，避免手穿过物件、裙摆跳变。过渡从当前姿态继续，不反复重播入场。
- 重连只恢复当前事实，历史完成不补播庆祝；新任务开始时立即结束上轮成功姿态。短暂出现又消失的排队不必完整播放等候动画。
- `reduced motion` 使用静态差分或轻淡入；免打扰抑制气泡、音效和主动出场，仍保留状态卡及托盘入口。隐藏时停RAF/序列帧/物理循环，观察订阅与动画生命周期分开。
- 轻点互动有节制，不重复索要注意，不设计好感度惩罚。默认无声音、无主动读屏/窗口扫描，结果气泡不暴露正文、工具参数、敏感文件名。
- 主题切换只改变四个accent槽位及相关UI，不重播动作、不重建会话、不改变状态语义。配色过渡遵循减少动态设置，始终保留眼睛与身份特征。

## 13. 资产交付与验证

每个资源批次保留可编辑母版、导出成品、manifest和预览联系表；不把未确认授权的原图或角色资料直接加入发行包。

1. **母版**：Q版正面/斜前及必要背面结构、比例网格、左右定位、表情五官基准、衣装层级、四个换色遮罩和脚底锚点。
2. **差分**：32类缩略分镜覆盖表，标明共用姿态/独立重画、持物前后层级、表情范围；严禁靠镜像制造相反朝向。
3. **动画**：入场、循环、退场、可打断点、兼容组合及缺资源fallback；静态差分与动态资源均有低动态版本。采用Live2D时另交分层遮挡补绘、rig、物理参数和授权记录，不能用三视图代替模型。
4. **配色**：8族代表样张及明暗背景预览，四个区域同色系分明度/饱和度；瞳色等固定区不得受遮罩污染。Mono黑白需额外保留层次而不是纯色填平。
5. **图像QA**：黑/白/灰/彩色背景检查alpha边缘、残渣、裁脚、道具穿插、手指、单圈丸、Logo形状/方向、工作牌位置；预览导出尺寸与实际显示尺寸均检查。
6. **状态QA**：按真实Run/Operation及观察流fixture覆盖重复/乱序/迟到、排队与运行并存、问题与权限、单工具失败后继续、取消中与真实停止、效果未知、断线重连、多个子任务。测试行为，不复制状态枚举或截图当作实现证明。
7. **壳QA**：重复开启单实例、关闭不同窗口、beforeunload取消退出、renderer崩溃恢复、托盘重置、DPI/副屏拔插、拖动失焦、透明区域点击、键盘可达，以及隐藏后动画停止。原生行为须在支持的平台实测。

本设计的完成条件是状态目录、换色规则、资源合同和产品边界清晰；实现阶段再按[开发验证指南](../development.md)选择类型/契约/行为测试与对应平台验收，不以文档评审代替功能验证。
