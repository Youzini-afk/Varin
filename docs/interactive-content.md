# 聊天交互内容与引用

Agent 使用 `render_ui` 生成聊天内的 HTML 图表、计算器和其他交互内容。普通回答继续使用现有 Markdown、
数学公式、表格与 Mermaid。作品卡片提供预览、源码、展开、复制、下载、重置和引用；页面内操作在浏览器执行。

## 写入与修订

```ts
type RenderUiInput = {
  ref?: string;
  title?: string;
  entry?: string; // 默认 index.html
  changes: (
    | { file: string; op: "write" | "append"; text: string }
    | { file: string; op: "edit"; edits: { oldText: string; newText: string }[] }
    | { file: string; op: "delete" }
  )[];
};
```

省略 `ref` 新建作品；继续制作使用回执中的作品或修订引用。一次完整调用按顺序推演全部修改，整体成功后保存一个
不可变修订。单次 `edit` 的所有替换匹配该步骤开始前的原文，要求唯一、不重叠。文件是作品内的相对路径。

作品引用在受理时固定基准；期间已有更新则返回冲突。旧修订也不能覆盖后来修改。无变化返回原修订。
写入成功即保存，没有草稿/发布步骤；源码保存不以页面运行成功为前提。回执只包含引用、标题、修订、入口和目录。
直接 `render_ui` 和经 `tool_invoke` 返回的作品使用同一聊天卡片；展示保留原调用与历史身份。

同一轮连续制作在主卡片展示当前进展，后续调用保留简短回执。后来轮次的修改不会改写以前消息绑定的修订。
参数尚未完整到达时是临时预览；失败或中断不会生成修订，也不会自动重放写入。
经 `tool_invoke` 调用时，嵌套参数也进入同一流式投影。完成消息接替流式消息或虚拟列表重新挂载卡片时，
完整写入的 HTML 先保留为预览，随后与已保存修订对齐。

## 流式呈现与页面状态

原生 provider 的工具开始与参数增量进入 `ThreadProjection`。增量 JSON 解码器只扫描新增片段，保留未完成转义。
作品投影按修改语义生成预览，按浏览器绘制节奏更新 iframe 内 DOM；有 ID / `data-key` 的节点优先复用。
传输期间禁用作品脚本和事件处理，保存回执与完整资源对齐后执行脚本。
已加载 HTML 的展示独立于视图登记；恢复视图状态期间先呈现页面，登记失败时使用本地已有状态运行。
同一修订在同一个 iframe 中只执行一次，观察连接重连不会重复运行作品脚本。
预览速度取决于提供商实际输出；当前 Google 协议路径收到完整函数参数后一次呈现，不制造参数增量。

视图会话独立于聊天虚拟列表，保留参数、控件值和滚动位置。展开到侧栏或全屏会恢复同一视图状态；不同客户端
独立打开时分配不同视图身份。执行环境需重建时恢复显式状态，不保留任意 JavaScript 闭包、计时器或网络连接。
源码投影可以在卡片卸载后继续更新已展开视图，无需让全部历史 iframe 常驻。

页面端的固定接口：

```js
const initial = window.varinUI.state; // 初始 JSON 状态，未保存时为 null
window.varinUI.saveState({ amount: 500000 });
window.varinUI.setContext({ selectedPlan: "A", monthlyPayment: 2100 });
```

控件值和滚动位置自动保存，复杂组件用 `saveState` 保存业务状态。`setContext` 提供“用当前参数继续讨论”的内容；
该宿主操作只添加输入框引用，不自动发消息。页面没有模型请求、文件系统或 Host 凭据接口。

HTML 在不共享主页面 origin 的 `allow-scripts` 沙盒运行。主题使用 Varin 的实际颜色、字体和减少动态效果偏好。
相对样式、脚本、数据和静态模块导入解析到作品文件；字面量动态导入也支持，计算生成的模块路径不经过打包转换。
`media:<resourceId>` 使用当前会话已有图片资源，保存时固定其字节。模块名 `d3`、`chart.js/auto` 分别映射到固定的
7.9.0、4.4.8 网络版本，按需加载；其他外部资源仍需要网络。下载生成包含本地文件、媒体和状态的 HTML，保留外部依赖。

## 资源与实际画面

现有 `resource_read` 增加 `kind: "ui"`，没有新增发现或指南工具。

| 引用 | 含义 |
| --- | --- |
| `ui:…` | 读取开始时解析作品最新修订，结果返回固定修订 |
| `ui:…@N` | 不可变源码修订 |
| `ui-view:…` | 原客户端实际打开的实例，可请求新观察 |
| `ui-snapshot:…` | 固定的源码/预览身份、状态、结构与已取得的画面 |
| `ui-selection:…` | 用户选中的文字或区域，绑定固定快照 |

```js
resource_read({ kind: "ui", ref: "ui:…@3", view: "source",
  file: "index.html", startLine: 40, endLine: 100 });
resource_read({ kind: "ui", ref: "ui-view:…", view: "screen" });
resource_read({ kind: "ui", ref: "ui-selection:…", view: "structure" });
```

`summary` 返回简短元数据与可用实例；`source` 返回目录或指定文件；`state`、`screen`、`structure` 读取实例或固定快照。
长正文沿现有读取分页默认值返回 `next`，`offset/limit` 为 UTF-8 字节。续读绑定固定修订或快照，不在分页中重新取实时状态。
图像走工具媒体块，不作为 base64 正文；不支持图像的模型收到明确省略说明，来源和文字保持可读。

画面观察由对应客户端处理。桌面优先截取 iframe 实际可见区域，标记 `screen`；其他平台使用当前 DOM 重绘，标记
`dom`。DOM 重绘不能保证重现跨域图片、视频及所有浏览器效果，不能视为原生像素截图。结构、状态、图像保留各自
实际捕获时间与范围。只读观察不点击、滚动或重置页面；视图关闭、跳转、断连或捕获失败返回具体原因。

## 用户引用

选中文字后可引用；框选需主动进入选区模式，在已捕获画面上选择区域，Esc 或取消退出。输入框显示“引用点 1、2…”
附件，可预览、删除和定位来源。删除某项不会使同一草稿中已有编号改指其他对象；发送成功后清理原批次，保留后来新增项。

引用固定选取时的内容、源码/预览身份、状态和位置。页面后续变化不改写引用，也不把旧坐标应用到新布局。
普通消息、图片、PDF 与交互作品共用 `ContentReference` 和现有附件受理链，各自保留原 owner 的来源证明。
模型首次收到所选文字或图像及简短出处，完整源码和状态按需读取。失败、排队和不确定重试保留原输入。

## 实现归属

| 入口 | 职责 |
| --- | --- |
| [内置工具](../packages/extension-builtins/src/interactive-ui-tools.ts) | 稳定 schema，通过现有扩展服务及原 Operation 执行 |
| [Host 领域](../packages/web/application-host/lib/interactive-ui/runtime.ts) | 修订语义、原调用回执、实际视图观察与资源读取 |
| [存储适配](../packages/web/application-host/lib/interactive-ui/store.ts) | 会话家族作用域内的 Rust record/blob，复用未变内容对象 |
| [客户端合同](../packages/application-client/src/interactive-ui.ts) | DTO、绑定 Host 的 HTTP 和复用观察通道 |
| [作品投影](../packages/ui/src/lib/interactive-ui/work-projection.ts) | 临时参数、已保存资源与视图会话的对齐 |
| [卡片与沙盒](../packages/ui/src/components/interactive-ui/InteractiveUiCard.tsx) | 呈现、实际捕获、展开、引用和导出 |

Rust Storage 保存 `ui.work`、`ui.view`、`ui.snapshot`、`ui.selection` 与内容对象；Host 不另建文件数据库。
源码提交仅串行化同一作品，视图状态仅串行化同一实例。等待客户端观察不占全局执行锁，关闭观察不取消已受理写入。
存储提交后丢失响应只核对原操作，不重新写入；未确认结果保持 unknown。

工具列表不因开始制作或追加编辑而增长。引用与观察追加到原回执或新消息，不回插系统提示，也不强制生成后的检查流程。
