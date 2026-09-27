# Varin Motion 与可替换过渡场景

Status: current motion architecture; Bootstrap Projection and the generic Motion service remain future work

Last updated: 2026-09-02

本文规定 Varin 动画与界面交接的产品边界、公共契约和实施顺序。它建立在
[可组合工作台约定](composable-workbench.md) 之上，不新增第二套扩展系统，也不把
官方 Agent Workspace、IDE Workbench 或当前立方体动画变成 Core 中不可替换的产品结构。

## 1. 目标

Varin 的界面可以由 Varin 扩展重新组合或整体替换。Motion 基础设施必须同时满足：

- 用户可以替换启动场景、完整 Workbench Profile 过渡和其他全局视觉场景；
- 完整 Shell 可以拥有任意 DOM、Canvas、WebGL、WebAssembly 或框架树，不要求存在会话栏、
  标题栏、MCP 卡片、编辑器标签或其他官方元素；
- Shell 和普通 Surface contribution 完全拥有自己内部的导航、组件和动画；
- Varin 只规定跨 owner 交接所需的生命周期、权威切换、失败回退和 stale completion 处理；
- Agent / IDE 切换时继续保持 Documents、editor groups、terminals、sessions、Git 和 Pi Runtime
  状态，不用动画卸载共享内核；
- 动画扩展可以使用 Varin 提供的公共积木，也可以完全自行实现；
- `prefers-reduced-motion` 是 Surface 传入的用户偏好，不是要求扩展必须采用某一种固定视觉。

Varin Motion 属于 Varin 扩展平台。它与 Pi Packages、Pi 插件 hooks 和 Pi 的会话压缩生命周期
无关。

## 2. 不以官方页面结构作为公共契约

公共 Motion API 不定义下面这些必需对象：

```text
session-list
chat-header
mcp-card
settings-page
editor-tab
agent-sidebar
```

这些可以是官方 Shell 的实现细节，也可以完全不存在。社区 Shell 可以把会话画成节点图、把文件和
Agent 放进无限画布、只提供命令面板，或者采用 Varin 当前没有的交互模型。

因此：

- `sessions.transition`、`mcp.detail.transition` 等名称不得成为所有 Shell 必须渲染的公共槽位；
- 官方 Shell 可以在自己的 namespace 中提供这类局部 seam；
- Core 不能查询或操纵扩展私有 DOM 来推断界面结构；
- 跨扩展共享元素只通过双方自愿注册的 opaque anchor key 协作；缺少 anchor 时正常降级，不把它
  当作界面不完整；
- replacement target 表示可选择的能力 owner，不表示目标 Shell 内必须有某一种可见控件。

## 3. Motion 分层

### 3.1 Transition Scene

Transition Scene 是跨完整 Surface 或 Shell 的全局视觉层。首个正式场景为
`workbench-profile`：在旧 Shell 上覆盖、在完全覆盖时允许 Core 提交 Profile，再揭示新 Shell。

后续可以增加 `bootstrap`、window handoff 或 distribution 自定义场景，但不能用同一个字符串暗中赋予
不同生命周期语义。每种 scene 都有 versioned frame contract。

### 3.2 Surface 内部 Motion

一个 Shell 或 view 内部的路由、列表、组件、按钮、流式消息和布局动画由该 contribution 自己拥有。
Varin 不接管它的 DOM，也不要求它逐项注册动画。

未来公共 Motion service 可以提供：

- semantic timing/easing tokens；
- presence、collapse、reorder、shared-element 等可选 primitives；
- extension-namespaced transition scopes；
- optional anchors 和 overlay portal；
- reduced-motion preference 与动画诊断。

这些是可调用服务，不是 UI schema。扩展可以只使用一部分，也可以完全不用。

### 3.3 Bootstrap Projection

浏览器拿到 HTML 后、React 和扩展 catalog 尚未启动前，必须先画出一个首帧，否则云端和冷启动会出现
黑屏。这一阶段不能临时等待普通 Surface entrypoint 执行。

可替换启动场景采用两段式 ownership：

1. Application Host 从上一次成功选择的 extension artifact 生成、校验并缓存一个轻量 bootstrap
   projection；HTML 首帧只读取这份不可执行或受限执行的投影；
2. Surface runtime 可用后，普通 Transition Scene 接管 hold/reveal 和完整代码动画。

Bootstrap projection 不是第二套插件。它是所选 Varin 扩展 artifact 的派生产物，随 candidate
事务一起 stage，只有 candidate 成功后才替换当前投影。缺失、损坏或加载失败时使用 Core 的纯色首帧，
而不是阻止应用启动。

这一边界对应真实启动顺序，不是对动画创作的产品限制。任意代码型场景仍可在 Surface runtime 建立后
运行；要从第一帧自定义，则扩展额外提供可提前投影的 bootstrap entry。

## 4. Ownership

### 4.1 Varin Core / Shared Workbench Kernel

Core 只拥有：

- 当前 application host、Surface、workspace 和 Profile identity；
- transition ID、phase、source/target identity 和 stale-generation 判定；
- candidate Shell 与 candidate scene 的 stage/ready；
- `covered` 之后的 revision-checked Profile commit；
- commit 失败时继续保留旧 Shell；
- scene 缺失、disabled、failed、withdrawn 时的 Core fallback；
- Recovery Shell 和 reduced-motion preference projection；
- transition 结束后的 mount、timer、listener 和 owner cleanup。

Core 不拥有 scene 的几何、元素、颜色、音效、镜头、粒子或信息架构。

### 4.2 Transition Scene contribution

Scene contribution 拥有：

- 自己 container 内的完整 DOM/Canvas/WebGL/framework root；
- covering、covered、revealing 的视觉表达；
- 前进/后退方向和 quick/standard/reduced tempo 的实际表现；
- 自己创建的 animation、timer、RAF、object URL、listener 和 disposer；
- 可选的提前 phase-complete 信号；
- 自己 namespace 下的配置和 storage。

Scene 不拥有 Profile document、candidate Shell、共享 document/session/terminal state，也不能绕过
Core 的 revision commit。

### 4.3 Shell 和普通 contribution

Shell 内有什么页面和元素完全由 Shell 决定。它可以：

- 自己完成所有内部动画；
- 使用一个第三方 Motion service；
- 暴露自己的 optional transition seams；
- 注册 shared-element anchors；
- 完全禁用内部动画；
- 在不改变 Profile 的情况下切换自己的布局。

Core 不因为官方 Shell 有某个区域，就把该区域提升为所有 Shell 的必需结构。

## 5. Workbench Profile 过渡事务

目标事务顺序：

```text
resolve target Profile
        │
        ├── stage candidate Shell ─────────┐
        └── resolve/activate target scene ─┤  可并行
                                          ▼
                              scene covering
                                          ▼
                                scene covered
                                          ▼
                      expectedRevision Profile commit
                         │ success              │ failure
                         ▼                      ▼
                    new Shell              old Shell
                         │                      │
               commit + first paint            │
                         └──────── scene revealing ────────┘
                                          ▼
                                      dispose scene
```

不变量：

1. target scene contribution 和 owner generation 在事务开始时捕获，揭示完成前不因 Profile commit
   改成另一 contribution；
2. candidate Shell 可以在 covering 期间并行准备，但 Profile 只在 `covered` 后提交；
3. scene completion 必须带 transition ID 与 phase，旧动画事件不能推进新事务；
4. candidate mount、scene activation、Profile revision 或 catalog identity 失败时旧 Shell 保持权威；
5. failure 也完成 revealing，不把错误页面留在遮罩后面；
6. 新用户选择可以 supersede 尚未提交的旧事务，旧 candidate 和 scene 必须 dispose；
7. committed Shell 不因之后出现的另一切换而回滚；
8. Profile 选择不隐式 enable scene 或 Shell extension；disabled/missing selection 使用 fallback；
9. Profile 切换不重新读取全部文档、不销毁终端、不重建 Pi session。
10. 成功提交 Profile 只表示配置权威已切换；scene 必须继续保持完全覆盖，直到目标 Shell contribution
    已实际挂载并跨过浏览器绘制边界。旧 transition 的 mount/paint 完成信号不能揭示新 transition。

## 6. 公共 Transition Scene 契约

### 6.1 Stable identities

`@varin/extension-contract` 是唯一字符串 owner：

```text
contribution kind: transition-scene
replacement target: workbench.transition
data contract: varin-transition-scene/v1
scene: workbench-profile
```

完整自定义 Shell 不必在自己的 DOM 中渲染 `workbench.transition`。该 target 由 Shell 外的 Surface
transaction host 消费。

### 6.2 Manifest data

Scene descriptor 只声明可序列化事实：

```ts
interface VarinTransitionSceneContributionDataV1 {
  contract: 'varin-transition-scene/v1'
  scenes: Array<'workbench-profile'>
  durations: {
    'workbench-profile': {
      covering: { quick: number; standard: number; reduced: number }
      revealing: { quick: number; standard: number; reduced: number }
    }
  }
  fallback?: boolean
}
```

Duration 是 scene 对自己动画的声明，不是 Core 猜测的超时。数值为非负 safe integer；`0` 明确表示
立即完成。契约不设置臆测性的最大时长。Scene 可以通过 controller 提前完成；否则 Core 在声明的
duration 后推进，避免某种框架必须暴露私有 animation 对象。

Malformed contribution 是该 contribution 的失败，不改写 Profile，不投影成默认 duration。

### 6.3 Runtime frame

每次 phase 通过 framework-neutral controller 发布：

```ts
interface VarinTransitionSceneFrameV1 {
  contractVersion: 1
  transitionId: number
  scene: 'workbench-profile'
  phase: 'covering' | 'covered' | 'revealing'
  direction: 'forward' | 'backward'
  tempo: 'quick' | 'standard'
  reducedMotion: boolean
  fromProfileId: string | null
  toProfileId: string
}

interface VarinTransitionSceneControllerV1 {
  getSnapshot(): VarinTransitionSceneFrameV1
  subscribe(listener: () => void): () => void
  complete(transitionId: number, phase: 'covering' | 'revealing'): void
}
```

Managed/native mounts得到 stable controller，可以订阅更新。React adapter 只包装这一 external-store
contract，不把 Varin 的 React singleton 传给扩展。Isolated iframe 保持一次 mount，Surface host 将
同一 frame 作为 `varin-message` 发送；它可以依靠 descriptor duration 完成，后续通用的 realm event
通道可让它主动提前完成。

### 6.4 Selection

- target Profile resolved layout 中显式 `workbench.transition` selection 优先；
- 未选择时使用 `data.fallback === true` 的兼容 contribution；
- 同一 target 有多个 fallback 是 registry conflict，不依赖加载顺序猜测；
- explicit selection missing/disabled/failed 时使用 Core fallback，并保留原 selection 供重新启用恢复；
- 事务捕获 contribution ID、extension ID、entrypoint、realm 和 generation；只按 contribution ID
  重新查找不够；
- scene update/disable 只影响下一次事务；正在运行的 scene 若 owner 被撤销，则当前事务转入 Core
  fallback 并继续完成，不把 Surface 卡在遮罩中。

## 7. Core fallback

Recovery 必须独立于普通扩展。Core fallback 只提供：

- 一个使用 semantic surface token 的不透明覆盖层；
- 按声明 duration 或 reduced-motion preference 进行的简单 opacity 交接；
- transition ID/phase completion；
- 可见诊断，不伪造所选 scene 成功运行。

当前 Varin 立方体/地板动画不属于 Core fallback。它迁移为 enabled-by-default 的普通 built-in
Transition Scene contribution，因此能够被选择、停用和替换。

## 8. 性能契约

交互：用户触发 Workbench Profile 切换后，覆盖动画立即获得一层稳定 overlay；candidate 准备与动画
并行，不因整个 catalog 或 document tree 重算而卡住。

结构性要求：

- 一个 transition 只有一个 scene mount 和一个 phase external store；
- phase 更新只通知当前 scene，不进入 broad Zustand store；
- hidden/inactive scenes 没有 RAF、timer、listener 或渲染工作；
- scene geometry 不在每帧 React render 中重建；
- owner、transition 和 timer cleanup 可重复调用且只生效一次；
- scene 的透明终帧先跨过浏览器绘制边界，再从 DOM 和 compositor 脱离；全屏 WebGL Canvas
  脱离前不得强制丢失 context，GPU context 在脱离后的绘制边界释放；
- Profile commit 后不重新 mount scene；同一实例完成 revealing；
- catalog 变化只检查捕获的 owner identity，不扫描页面 DOM；
- bootstrap projection 保持足够小以直接参与首帧，不在首帧加载完整扩展 catalog。

现有默认场景的 quick/standard/reduced duration 是已实现视觉时间轴的事实，不是平台级上限。第三方
场景可以声明不同数值。

默认立方体场景自身还有一项实现不变量：瓦片数量不是固定值。Renderer 会把当前 viewport 沿镜头从
透视到俯视的路径反投影回地板坐标，生成覆盖该视口所需的真实瓦片；窗口越大，瓦片越多，单块尺寸和
Logo 基座仍保持一致。Resize 只重建瓦片数据与 GPU buffer，不重建 React 或 DOM。每块瓦片保留自己的
延迟、位移、缩放、透明度和稳定的呼吸选择，但整片地板只有一个 Canvas owner：优先用 WebGL2 的
instanced draw（一次提交绘制所有瓦片），不可用时回退到 Canvas 2D。大面积地板 mask 在不透明
backdrop 下离散交接，避免每帧重新栅格化整棵 DOM。

默认 `workbench-profile` 场景以 Logo 脚下的注册单元为唯一空间原点：covering 时外围瓦片先回位并
逐圈向中心闭合，地板闭合后 Logo 出现；revealing 是同一时间线的严格反播放，Logo 先下沉，瓦片再从
中心向外围逐圈散开。Profile 的前后顺序仍传给公共 frame，供自定义场景使用，但官方场景不把它解释为
从屏幕一角开始的方向性擦除。

WebGL 网格线使用屏幕空间导数做解析抗锯齿，不打开全屏 MSAA：近处保留投影后的地板线宽，远处至少
保持一个 CSS 像素的连续覆盖；当单元周期缩小到只有 3–6 条线宽、已不能稳定分辨线与间隙时，两个
网格轴分别平滑淡出。半透明 line token 合成在不透明瓦片之上，不能把网格边界变成提前泄露应用的洞。

远景同样由真实瓦片构成，不再用只能画线、不能呼吸或逐片消散的 repeating-gradient 冒充。透视接近
地平线后，瓦片投影会趋近于不可辨识尺寸，scene 才通过 horizon mask 渐隐；地平线以上继续由同色
不透明 backdrop 接住，不暴露尚未就绪的应用。覆盖与增长关系以手机、常见桌面、5K 超宽与 8K
viewport 的几何测试固定。瓦片数量是当前视口和相机几何的结果，不是 Canvas renderer 或 Transition
Scene 平台的硬上限。

## 9. Surface 与执行模式

| Surface / mode | Workbench Transition Scene |
| --- | --- |
| Web managed | 完整 mount/controller；CSS、DOM、Canvas、WebGL 均可 |
| Electron managed | 复用同一 Web Surface host，不新增 preload 动画 API |
| Hosted mobile | 远端 Web Host + mobile Surface；只有支持 mobile 的 scene 参与 |
| Capacitor | 使用同一 Surface contract；不取得设备文件权限 |
| declarative | descriptor 可被索引；可执行 entrypoint 未激活前不冒充 renderer |
| isolated iframe | iframe mount + serialized frame；realm teardown 物理卸载 |
| isolated Worker | 无视觉 contribution，继续拒绝 transition-scene |
| trusted native | 可以实现 scene；cleanup 失败保持既有 restart-required 语义 |
| headless | 验证 contract/selection/transaction，不渲染 scene |

## 10. 可选 shared-element 与局部 Motion

共享元素不能通过 Core 查询 CSS selector。未来公共服务使用 extension-owned opaque identity：

```ts
motion.registerAnchor({
  namespace: 'dev.example.shell',
  key: 'resource:<opaque-id>',
  element,
})
```

- namespace 默认属于 extension owner；
- 跨 extension 共享 key 需要双方显式使用共同公开协议；
- anchor 只在当前 Surface 与 mount generation 内有效；
- unmount/disable 自动撤销；
- 没有匹配 anchor 时正常执行普通 transition；
- Core 不把 anchor 名称解释成会话、文件或 MCP 结构；
- 注册 anchor 不转移 resource/session/document 权威。

Motion tokens 和 primitives 作为后续 SDK 服务提供。官方 UI 会成为第一个消费者，但第三方 Shell 不被
要求使用官方 token、组件或动画引擎。

## 11. 诊断与失败

Extension Inspector 后续显示：

- 当前/捕获的 scene contribution 与 owner generation；
- selected、fallback、Core fallback 的实际结果；
- scene activation、mount、render、withdraw 和 phase completion failure；
- declared/observed phase duration；
- reduced-motion projection；
- cleanup failure。

日志只记录 identity、phase、duration 和 error，不记录页面正文、会话内容、文件内容或扩展私有状态。

## 12. 实施 Phase

### Phase 1 — Architecture

- 本文成为 Motion ownership 权威；
- `roadmap.md` 和扩展作者文档链接到本文；
- 固定“不规定页面元素”和“Core 只拥有交接”的产品决定。

### Phase 2 — Public Transition Scene contract

- `extension-contract` 增加 kind、replacement target、data/frame parser 和 JSON schema；
- `extension-sdk` 增加 framework-neutral controller/mount helper；
- `extension-react` 增加可选 React adapter；
- public tests 覆盖 malformed data、zero duration、controller stale completion 和 export shape；
- 不发布 npm tag，等待单独批准。

Implementation status (2026-08-23): complete. `transition-scene`、`workbench.transition`、manifest
data/frame parser、framework-neutral controller/mount helper、React adapter 和 fallback conflict
validation 已进入公共包；没有发布 npm tag。

### Phase 3 — Workbench runtime consumer

- 当前立方体场景注册为 built-in Varin extension；
- target Profile scene 与 candidate Shell 并行准备；
- scene owner 在 covering/revealing 之间冻结；
- Profile 只在 covered 后提交；
- missing/disabled/render failure/withdraw 使用 Core fallback；
- Agent / IDE / custom Shell 均走同一事务；
- Extensions 页面可以选择 `workbench.transition` replacement。

Implementation status (2026-08-23): complete. 立方体/地板场景现在由
`varin.builtin.transition-scene` 提供；目标 Profile 的 scene 与 candidate Shell 并行准备，完整 owner
generation 捕获到 revealing 结束。Scene mount 实际 ready 后才启动其声明时钟；malformed、missing、
disabled、withdrawn 或 render failure 使用 Core 的不透明即时交接。

### Phase 4 — Bootstrap projection

- 定义 bootstrap projection artifact 和完整性记录；
- Host 随 candidate stage/commit 原子更新 projection；
- Web HTML、Electron in-process Web 和 cloud 使用同一 bootstrap owner；
- malformed/missing/read failure 使用 Core 首帧且不阻止启动；
- 首帧不加载完整 catalog，不执行未提交 candidate。

### Phase 5 — Generic Motion service

- framework-neutral timing/preference service；
- optional anchors、overlay portal 和 extension-namespaced transition scope；
- 官方 Agent/IDE 内部导航作为消费者，不把其元素名称加入 Core；
- React adapter 和非 React 示例；
- Inspector 的 owner、active work 和 cleanup 诊断。

### Phase 6 — Ecosystem handoff

- CLI transition-scene template；
- managed、isolated iframe、disable/update/rollback conformance；
- 外部示例 scene 和完整 Shell 示例；
- public package build/pack/install 验证；
- 协调下一个 npm tooling 版本，但发布仍需单独批准。

## 13. 本轮明确不混入的工作

- 不在普通页面里新增固定的会话/MCP/设置动画槽位；
- 不改变 Pi plugin 或 Pi Package 生命周期；
- 不在 Motion Phase 内引入 Cordis、编辑器引擎改造、Code OSS 或第二个 contribution registry；Monaco 文件编辑器属于独立的 [统一文件编辑器计划](unified-file-editor-platform.md)；
- 不把当前动画配置塞入 Profile document 的新私有字段；
- 不让 Profile 选择暗中启停扩展；
- 不让 renderer 获得新的文件、进程或凭据权限；
- 不用猜测性最大时长或扩展数量限制代替 owner cleanup；
- 不在 Transition Scene Phase 顺手重构官方 Shell 内部微动画。
