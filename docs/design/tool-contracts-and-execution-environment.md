# 工具契约与执行环境优化设计

状态：2026-10-24 已实现。本文保留经讨论确定的取舍；当前行为已折入[资源](../resources.md)、[运行时](../runtime.md)、[检索](../retrieval.md)及源码旁说明。

本轮目标是让 Agent 更容易正确使用已有能力：找到完整的工具目录，按实际环境写命令，以自然的参数读取文件与文档，并准确理解工具结果。优化作用于通用、Coding、科研、办公、子 Agent 和内部检索等实际使用这些工具的入口。

## 1. 核心决定

| 议题 | 目标行为 |
| --- | --- |
| 工具目录 | 列出当前请求实际可用的全部分组；工具总数与直接披露数量分开表达 |
| Windows Agent 默认 Shell | 显式选择优先；自动模式优先已安装的 Git Bash，其次 pwsh、Windows PowerShell，最后 CMD |
| 单次 Shell 选择 | `process_spawn` 增加可选 `shell`，与 `shellCommand` 配合；自定义可执行程序继续走 `command + args` |
| 环境供给 | Shell 发现、用户 PATH 和 Varin 自带工具使用同一份可信 Host 解析结果，覆盖 Agent 与终端 |
| 模型获得环境信息的时间 | 在生成命令之前提供默认 Shell 和可选项；启动回执记录实际选择 |
| PTY 输入 | 保留原样输入，增加明确的提交行选项；写入确认与程序执行结果分别表达 |
| 进程结果 | 保留停止请求、真实退出、输出收尾三个事实，改善解释与后续读取入口 |
| 文件路径 | 统一接受 `.`、`./`、Windows 分隔符等正常相对写法，之后进入原资源准入 |
| 文件版本与写入 | 明确 `readVersion` 的条件写入用途；模型主要看到写入效果，内部恢复字段留给诊断 |
| 文档读取 | `document_read` 默认返回正文；路径、快照、PDF 和 Office 采用一致的读取意图 |
| 错误反馈 | 失败结果提供稳定的结构化错误，保留未执行、执行失败、效果未知的区别 |
| 脚本环境 | 保留现有持久 REPL，补齐参数说明、变量复用示例与针对性报错 |

这些变化由工具接口与执行环境承担。提示词只表达必要事实，不增加模式流程、强制先检查步骤或额外的任务编排。

## 2. 已核实的问题与边界

| 现象 | 当前实现及判断 |
| --- | --- |
| `tool_describe({})` 的 execution 数量小于组内工具数 | 顶层只统计未直接披露的工具，且过滤计数为零的组；目录说明却称其为可用分组。这是实际接口问题 |
| files、media 分组像是已经不存在 | 当前分类仍存在；是否出现在顶层受上述过滤影响，不应据此删除分类 |
| Windows shell 命令受到 Bash 语法影响而失败 | Agent 的 `shellCommand` 在 Rust 中写死启动 `powershell.exe`，没有使用终端面板已有的 Shell resolver |
| 本机有 curl，但参数不兼容 | 本机 `curl.exe` 存在；Windows PowerShell 5.1 将 `curl` 解析为 `Invoke-WebRequest`，pwsh 没有这个默认别名 |
| Codex 能用 rg，Varin 查不到 | 本次环境核对找到的是 Codex 自带的 rg；仅使用系统及用户 PATH 时未找到。Varin 终端有内置工具 PATH 补齐，Agent 内核继承路径未接入这份补齐 |
| PTY 写入 LF 后没有执行 | 原接口按文本字节写入；Windows PTY 的输入元数据已提示 CR。模型缺少清楚的“发送回车”入口与写入确认语义 |
| `process_stop` 首次返回未确认 | 原 owner 异步观察退出，返回 `stop_requested` 是合法状态；应清楚说明已请求以及等待入口 |
| exited 与 `outputComplete:false` 同时出现 | 进程退出和输出管道收尾独立，组合合法；不能把输出状态强行改成 true |
| `file_list` 拒绝 `paths:["."]` | 文件查询直接经过严格资源路径校验；进程 cwd 已经支持根目录别名，两处入口不一致 |
| 写入 applied，同时 `reconciled:false` | 正常写入已应用并重新观察核对；false 表示此次回执不是恢复协调得来，容易被理解为尚未保存 |
| script 第二次声明同名 const 失败 | 持久 Node REPL 的词法绑定行为；描述只有“Lexical bindings persist”，缺少直接可用的解释 |
| `document_read` 默认得到空正文或 OOXML 索引 | 按路径首次读 PDF 默认 overview，按 snapshotId 读 PDF 默认 text；Office 默认 overview，默认行为有实际分歧 |
| 错误有 content.error、code/message、裸 reason 等形状 | 执行层、准备层与通用入口各有投影，结构化信息在部分路径被字符串化 |

本机探查说明当前原因，不成为平台安装要求。后续实现不引用 Codex、Cursor 等其他产品的私有资源目录。

源码依据：

- [工具目录与通用调用](../../kernel/crates/varin-kernel/src/capability_tools.rs)、[模式披露与分类](../../kernel/crates/varin-runtime/src/tool_disclosure.rs)。
- [Agent 文件与进程工具](../../kernel/crates/varin-kernel/src/tools.rs)、[进程输入和停止](../../kernel/crates/varin-kernel/src/process_wait.rs)。
- [终端 Shell 发现](../../packages/web/application-host/lib/terminal/shells.ts)、[Host 环境](../../packages/web/application-host/lib/platform/environment-runtime.ts)、[内置工具路径](../../packages/web/application-host/lib/platform/bundled-tools.ts)。
- [文档来源入口](../../packages/web/application-host/lib/harness/document-material.ts)、[PDF reader](../../packages/web/application-host/lib/harness/document-reading.ts)、[Office reader](../../packages/web/application-host/lib/office/reader.ts)。
- [脚本工具声明](../../packages/extension-builtins/src/script-tools.ts)、[持久脚本运行时](../../packages/script-runtime/README.md)。

## 3. 执行环境的统一

### 3.1 解析职责与执行职责

可信 Application Host 负责发现本机 Shell、读取配置、整理 PATH 和定位随产品分发的工具。Rust ProcessManager / guardian 继续负责启动、输入、输出、进程树、取消、资源租约和耐久回执。

复用现有 `shells.ts` 与 `environment-runtime.ts`，将共享发现与解析从终端专属使用方式中提取出来。终端、Agent 进程以及脚本环境创建使用相同的基础环境构建结果；终端的显示、OSC 集成、窗口尺寸等专有参数仍由终端模块补充。

Host 将解析出的可执行路径、Shell 家族、启动参数和环境交给原生启动路径。模型不能借新增参数更换执行 Host、文件 Source、授权或工作目录根。此处不增加第二个进程管理器。

### 3.2 Windows 的自动选择

优先顺序为：

1. 本次 `process_spawn.shell` 的显式选择。
2. 执行 Host 上保存的 Agent 默认 Shell；若为 auto，再采用有效的显式 `VARIN_TERMINAL_SHELL`、`SHELL` 配置，依此排序。
3. 自动选择：Git Bash → pwsh → Windows PowerShell → CMD。

`shell: "auto"` 与省略 shell 都表示使用本次已公布的环境默认值。默认配置本身为 auto 时才进入平台候选顺序。

Git Bash 发现覆盖已解析的 Git 安装根、标准安装位置和 PATH；不只查找一个裸 `bash.exe` 名称。记录最终实际路径，区分 Git Bash、其他 Bash 发行环境和 WSL 启动入口。其他已安装 Shell 可显式选择。

WSL 使用不同的程序、依赖和路径体系，不进入本轮 Windows 本机的自动候选。它继续通过明确的环境选择或已有显式程序调用使用；本轮不增加 WSL 资源管理层。

macOS/Linux 保留已有用户 Shell 选择与平台发现策略，新增单次 shell 参数同样可用。不同 Shell 使用各自的命令参数，不能把 PowerShell 参数套给 Bash，也不能把 POSIX `-c` 无条件套给所有程序。

### 3.3 配置与终端面板

现有终端面板偏好保存在 UI store，是用户打开交互终端的选择。后台 Agent、Bot 和远端 Host 不能依赖某个 renderer 是否打开或最后一次选择了什么。

因此共享的是 Shell 发现、路径解析和基础环境构建；两类用途保留各自明确的默认偏好：

- 终端面板沿用现有“默认终端”设置。
- Agent 在现有“工具与执行”设置中增加“执行 Shell”一行，保存到对应 Host 的配置权威，默认 auto，显示实际解析结果。

终端面板的 auto 沿现有交互终端选择策略；Agent 的 auto 采用本稿顺序。两者复用实际候选目录，默认优先顺序由对应用途传入，避免更改 Agent 默认时顺带改变用户终端。

这是一个现有设置行及其实际生效接线，不扩展为新的环境管理页面。任务实际在远端执行时，显示并使用远端配置与可用项。

新配置在下一次请求准备时生效；已受理的启动固定原选择，运行中的 PTY 保持原进程。模型收到的默认 Shell 与该请求执行时使用的默认必须一致。

### 3.4 模型在调用前获得事实

在原有执行环境上下文中提供简短事实，例如：

```text
执行主机：Windows
默认 Shell：Git Bash（C:/Program Files/Git/bin/bash.exe）
可选 Shell：bash、pwsh、powershell、cmd
```

只包含实际已发现的信息。版本信息若已有可信探查结果可附带，不为每次工具调用重复启动所有 Shell 做版本探测。PATH 全文、凭据和环境变量正文不进入模型上下文。

可用性发现按 Host 生命周期和已有刷新入口复用；安装变化、显式刷新或执行时发现程序已失效时重新解析。已公布的默认程序在受理前失效时，返回具体错误和更新后的候选，由下一次调用使用更新结果，避免模型按 Bash 写的正文被临时交给 PowerShell。

远端执行的事实来自实际资源 Host。协调端安装了 Git Bash，不能据此为远端选择 Bash。

## 4. `process_spawn` 的 Shell 参数

### 4.1 两种现有启动意图

| 输入 | 行为 |
| --- | --- |
| `shellCommand`，省略 shell 或 shell 为 auto | 使用公布的默认 Shell 执行正文 |
| `shellCommand` 与显式 shell | 使用指定且实际可用的 Shell |
| `command + args` | 直接启动该程序，按原参数数组传递 |

`shell` 只用于 `shellCommand`；和直接程序参数混用时返回字段级错误。`cwd`、`env`、`mode`、`waitMs` 和输出读取继续使用现有语义。常见选择为 bash、pwsh、powershell、cmd；其他已支持平台 Shell 使用 resolver 返回的 ID。自定义程序或特殊启动参数可继续通过 `command + args` 表达，无需新增一套配置对象。

```json
{
  "shell": "bash",
  "shellCommand": "git status --short && rg -n 'TODO' src",
  "cwd": ".",
  "mode": "pipe"
}
```

```json
{
  "shell": "pwsh",
  "shellCommand": "Get-ChildItem -LiteralPath . | Select-Object Name",
  "mode": "pipe"
}
```

`pipe / pty` 决定进程连接方式，shell 决定命令解释器，两者可以组合。单次 shellCommand 创建独立进程；需要持续交互时沿用原 PTY processId，JavaScript 跨次变量则使用原 script environment。

### 4.2 参数、Profile 与启动结果

保留命令正文，按对应 Shell 的单个命令参数交给解释器。避免额外再套一层 CMD 或通过字符串拼接引入二次解析。中文、引号、空格路径、多行命令和反斜杠都属于正常输入。

Agent 的非交互命令沿用不加载个人交互 Profile 的启动方式，基础用户 PATH 由 Host 整理；Git Bash 所需工具目录由该安装的解析结果构造。终端面板现有的登录 Shell 设置仍用于交互终端。需要特定 Profile 或初始化脚本的任务可以显式启动对应程序，不让一次普通命令隐式执行另一套初始化流程。

启动回执记录实际 Shell ID 与可执行路径，UI 详情可查看；聊天标题仍以真实命令为主。直接启动程序的回执不伪造 Shell 字段。

显式选中的 Shell 不存在时返回 `shell_unavailable`，包含实际候选与简短原因。自动候选选择发生在命令受理之前；已经开始的命令即使失败，也不切换解释器重新执行。部分副作用仍沿原操作回执处理。

## 5. PATH 与基础工具供给

### 5.1 一份基础环境

Windows 按现有规则合并启动环境、系统及用户 PATH，按大小写不敏感的身份处理 `Path/PATH`，去除重复条目。保留用户明确的工具优先级，补齐本产品工具路径；不混入其他产品私有版本目录，也不修改系统环境变量。

同一基础构建结果用于：

- Agent 直接程序与 shellCommand 启动。
- 用户终端启动。
- Node 脚本环境及其普通子进程。

各消费者在这个基础上补充自己的协议或终端变量。Agent 显式传入 `env` 时继续保持“完整环境”的既有契约；空数组仍表示不继承，不能暗中补回用户明确清空的变量。选定 Shell 的可执行身份仍由受理时的解析结果提供。

对远端同样在实际执行 Host 构建，避免协调端 PATH、磁盘路径和 Node 安装信息泄漏到另一台机器。

### 5.2 ripgrep 的产品责任

目标是随产品提供一个可直接运行的 `rg`，使 Agent 与终端可以稳定使用。当前 npm `ripgrep` 提供的是 `lib/rg.mjs`，包存在、开发环境有 `.bin` shim，都不能代替安装产物中的可执行入口。

本轮采用随目标平台分发的原生 ripgrep 可执行文件：Windows 为 `rg.exe`，其他平台为对应架构的 `rg`。复用现有原生资源的构建、放置和许可声明机制，放在可执行的产品资源目录，避免依赖 asar 内部路径、全局 Node 或开发包管理器的 shim。

统一 resolver 为其提供路径。用户已有 rg 按用户 PATH 优先级使用，内置版本作为基础供给；原生进程按正常权限启动它。核对 npm ripgrep 的实际消费者后清理被替代的分发依赖，避免长期维护两套 CLI 供应。

安装包的目标平台验证直接从普通启动环境运行一次 rg 检索，不能借 Codex 注入的 PATH。这里验证的是“用户拿到安装包就能使用”，不是只检测文件名存在。

### 5.3 curl 与 Bash 的边界

Windows 已有 `curl.exe` 时直接利用它。Bash 模式使用该 Bash 环境实际解析出的 curl；PowerShell 5.1 中明确调用 `curl.exe`，并在对应 Shell 的工具说明中短句提示别名差异。

Git Bash 提供常用 Unix 风格命令体验，但不会凭空提供 rg。也不承诺所有 Linux 程序都存在。对 Git Bash 调用 Windows 程序时的路径转换保留其实际行为，不全局关闭转换或重写任意命令正文；直接 argv 路径为需要精确 Windows 参数的任务保留。

## 6. PTY 输入与进程回执

### 6.1 明确“原样写入”和“提交一行”

在 `process_write` 增加可选 `submit: boolean`，默认 false。`text` 继续必填，可以为空字符串。

- `submit:false`：将 JSON 解码后的 text 原样编码为 UTF-8 写入。
- `submit:true`：在 text 后追加原进程输入元数据指定的行终止符，然后写入。
- 空 text 加 submit 表示只发送回车；需要 Ctrl+C 等控制字符时继续使用原样输入。

```json
{ "processId": "…", "text": "git status --short", "submit": true }
```

这对 pipe 与 PTY 都有明确含义：采用各自公布的行终止符。不会改写 text 中已有的换行，也不自动消除末尾换行；调用方选择原样提供结束符或使用 submit。回执中的 requestedBytes / confirmedBytes 包含实际追加的字节。

追加动作在原操作输入确定时完成，并纳入已有输入序列和幂等回执。观察重试不能再追加一次回车；同一操作 ID 携带不同输入时沿原规则处理。

Windows PTY 当前推荐 CR，普通管道按其公布的结束符使用。原始模式的应用仍可通过 text 传入精确字符。平台建议结束符表达正常行提交方式，不代表能判断每个程序的内部输入模式。

JSON 只解码一次：`"\r\n"` 表示真实回车换行，`"\\r\\n"` 表示字面反斜杠序列。schema 的 text 说明与示例明确这一点，不能增加会破坏路径、正则或代码正文的二次转义解码。

### 6.2 写入确认的准确含义

`state: applied` 与 `confirmedBytes` 表示输入写入通道已完成；它们不承担判断应用是否消费输入或完成业务的职责。

保留原始字段与原 owner 的确认机制，在工具说明及输入详情中明确“写入终端/管道”。UI 将这类调用的完成解释为输入已发送，不能显示为命令执行成功。需要应用结果时读取原输出或等待原进程。

### 6.3 停止、退出和输出收尾

| 事实 | 判断来源 | 面向模型和用户的含义 |
| --- | --- | --- |
| 已请求停止 | `cancelRequested`、`status: stop_requested` | 停止请求已登记，尚在等待原进程树回执 |
| 已确认停止 | `stopConfirmed` / 原 executor 停止事实 | 原执行者已停止；退出码与终止方式按真实回执保留 |
| 输出完整 | `outputComplete` 且无输出错误 | 原输出通道已收尾，现有输出页可继续读取至末尾 |

`process_stop` 继续快速返回；需要等待时复用 `wait_process`。取消等待保持原有语义，只结束观察，不停止进程。Windows 强制终止得到的退出码按实际值保留，同时使用 `outcome`、`stopApplied` 解释终止来源。

已退出但输出未收完时，呈现“进程已退出，输出仍在收集”，保留游标。读取某一页尚有后续内容与输出源仍开放也是两个事实：`outputComplete:true` 不代表当前页已经读到最后。输出通道错误显示实际错误，不包装成继续等待。

这里不引入新的停止工具、隐藏等待轮询或固定 sleep 来掩盖竞态。

## 7. 完整而简洁的工具目录

`tool_describe({})` 从本次 frozen 工具集合生成目录，包含所有实际有工具的分组。顶层字段建议明确为：

```json
{
  "groups": [
    {
      "namespace": "execution",
      "description": "Processes, terminal interaction and managed scripts",
      "toolCount": 10,
      "directToolCount": 6
    }
  ]
}
```

这里的 10 / 6 仅为某次请求的示例，实际按选择和模式计算。`toolCount` 为全部可用工具，`directToolCount` 为本次模型声明内的数量。全部可直调的分组也可被发现。

分组查询继续返回简短工具列表、用途、`directlyCallable` 和详细查询入口。按名称查询返回 schema、版本与 invocation。顶层不灌入每个工具的完整参数。

目录说明与 namespace 分类共用定义；静态说明表达“支持按组或名称查询”，当前可用分组由该请求实际集合生成。files、media 等组名继续使用，其有无由实际能力决定，不能与“是否延期披露”混为一谈。

直接披露仍按原模式策略控制。修正目录不会将所有工具都注入 provider tools；MCP 保持原直接使用和发现入口，不再增加一道通用调用跳转。

## 8. 错误结构与结果投影

### 8.1 一致的错误读取方式

内置工具面向模型的失败数据统一提供：

```json
{
  "error": {
    "code": "shell_unavailable",
    "message": "The selected shell is not available on this execution Host.",
    "details": { "requestedShell": "bash", "availableShells": ["pwsh", "powershell"] }
  }
}
```

code 与 message 为基本字段，details 仅在能帮助修正调用时提供。字段错误可带原字段位置和实际可用值；不要求每次失败都生成长操作指南。

复用现有 `ExecutionError` 的 code/message/tool_name，向下传递时保留结构。准备、权限准入、尚未派发、执行失败与效果未知都通过共享错误投影生成上述结构，避免各工具把错误转成字符串后再从前缀解析。

`NotDispatched` 的原始原因和生命周期意义保留；需要传递结构化错误时沿原类型补充，旧历史按原始事实显示，不重写历史。已有存储格式、完成枚举及 private wire 的演进由原 owner 处理，不为展示统一建立另一套操作账本。

### 8.2 直调、通用入口与脚本嵌套

| 调用入口 | 模型/脚本读取错误的位置 |
| --- | --- |
| 直接工具调用 | 模型收到的工具结果 JSON 的 `error` |
| `tool_invoke` | 返回数据的 `error`；同时保留 reference、operationId、completion、result |
| `tools.invoke` | 返回 receipt 的 `error`；原 completion 与正文/媒体仍可读取 |

三处复用同一错误投影规则。成功、正常 Job 受理和等待用户回答或授权不生成失败 error；取消沿原取消状态表达。通用调用的目标错误不得伪装成网关自身的调用成功；目标尚未执行也不能伪装成已经执行后失败。

对扩展与 MCP 的自定义正文保留原结构；只有原执行状态或该协议明确的错误信号能决定失败，不能因为正文里恰好有一个 error 字段就改判。缺少领域错误码时使用明确的通用失败码并保留原消息，不按任意正文猜测精确根因。

错误统一不改变 `kind / outcome / effect / executor_stopped` 的职责。能否重新执行由实际副作用和调用条件决定，不增加一个靠 HTTP 状态或错误文案猜出的通用 retryable 开关。

## 9. 文件路径、版本与写入结果

### 9.1 统一入口路径处理

模型工具入口接受自然的相对写法：查询中的省略 paths、`["."]`、`["./"]` 都表示来源根目录；反斜杠规范化为资源分隔符，`src/./file.ts` 归为 `src/file.ts`。

同一规范化函数覆盖文件查询、读写与进程 cwd 的适用部分，然后由各操作判断目标类型：根目录可用于 file_list，file_read 根目录应返回 not_a_file，文件写入仍要求文件目标。

规范化后的路径参与游标条件、资源身份与准入。权限、symlink 和现有目录边界由原 owner 检查；不通过改写字符串把绝对路径、上级跳转或来源外路径变成另一个可访问目标。也不对虚拟来源调用本机 realpath。

### 9.2 版本与结果

工具说明明确：`readVersion` 是读取所得的文件状态令牌，应原样传给条件写入；`objectHash` 是内容对象标识。文件不存在时的版本也有意义，继续防止其他写入者先创建目标后被覆盖。

模型面的正常写入结果以 `status`、path、实际变更和可用的新状态为主。`reconciled` 归入内部诊断，不作为保存状态显示；原恢复 journal 保留该事实。写入完成的判断继续来自实际 apply 与观察核对。

版本冲突反馈具体路径与重新读取入口，不能自动跳过条件检查或未经模型决定重放写入。

## 10. 文档读取的默认行为

### 10.1 按读取意图统一

| 请求 | 目标行为 |
| --- | --- |
| 只给 path、snapshotId 或 artifact | 返回正文；保持对应来源原始字节与权限 |
| `view: overview` | 返回文档概览、结构入口与正文读取方式 |
| `view: text` | PDF 提取文本；Office 返回可读对象内容 |
| `office.view: content / find` | 执行相应 Office 内容读取或检索 |
| 页图或显式结构/OCR | 按现有能力与组件可用性执行 |

默认正文在 document_read 的模型入口统一解析。上传、材料登记和只获取元数据的内部 ingest 调用可以继续明确请求 overview，不能因为修改模型入口而让每次上传都启动完整解析。

Office 的 section、range、objectId、query 等明确选择仍生效。相互冲突的视图要求返回参数说明，而不是悄悄覆盖其中一个；明确的格式专用视图由 schema 说明其与通用 view 的关系。

### 10.2 概览和空文本要可理解

概览结果明确返回有效 view；没有请求正文时，textStatus 保持 not-requested，附带用原 snapshotId 读取正文的具体调用入口。Office 概览提供 section/object 的可读名称，原 OOXML part ID 继续作为引用身份保留在结构数据中。

空文本按真实原因表达：尚未请求、已请求但没有可提取文字、解析失败、组件不可用。PDF 无文本层且 OCR 未启用时，说明观察结果与可用读取方式；不把所有空字符串统一归为解析成功，也不擅自执行高成本 OCR。

正文使用既有页、行、section、offset/limit 和工具输出预算。发生分页或截断时返回实际范围、原 snapshotId 与可执行的后续读取参数；不要用“还有更多”代替定位。无需在本轮新增向量索引、文档 Agent 或另一套材料存储。

## 11. 持久脚本环境的易用性

`script_run` 的描述直接写明“将 JavaScript 放入 script 参数”，cell 只作为执行单元概念使用。保留现有 title 展示规则、异步执行、媒体转发和嵌套工具能力。

用短说明解释持久性：同一 environmentId 的变量可在后续调用使用；同名 let/const 不能重新声明。修改已有变量用赋值，单次临时变量使用块作用域，允许重复声明的临时绑定可用 var。

```javascript
// 前一轮已经声明过 result，本轮继续赋值。
result = await fetch(url);

// 这次调用独有的临时变量。
{
  const response = await fetch(url);
  print(response.status);
}
```

重复声明错误保留原 Node 错误，附短提示说明变量仍在当前环境，并给出复用或局部作用域的处理方式。Node 已产生的输出继续返回；不自动清空环境、改写用户脚本或重新执行失败 cell。运行时异常可能发生在副作用之后，错误展示不能让模型误以为整个 cell 都未执行。

## 12. 实现接入与交付范围

| 工作部分 | 主要入口与接入要求 |
| --- | --- |
| Shell、PATH、rg 供应 | `terminal/shells.ts`、`platform/environment-runtime.ts`、`platform/bundled-tools.ts`、Host 启动与平台资源打包 |
| Agent Shell 解析 | Run 准备与实际资源 Host 的环境绑定、`tools.rs` 的 spawn 参数处理；受理时固定可执行身份 |
| PTY 提交输入 | `process_wait.rs`、原输入 interaction / receipt；按实际字节进入原序列与幂等机制 |
| 目录完整性 | `capability_tools.rs`、`tool_disclosure.rs`；重评原先断言只显示 deferred 组的测试 |
| 错误质量 | 原 ExecutionError / ToolCompletion、provider 结果投影、gateway、script receipt；共享类型经原生成链更新 |
| 文件工具 | `tools_discovery.rs`、文件入口路径处理、写入模型结果投影；保留底层 journal |
| 文档读取 | builtin 声明、document-material、PDF / Office reader；区分模型默认和内部 ingest |
| 脚本说明 | `script-tools.ts`、现有 REPL 错误序列化与输出呈现 |
| UI | 复用现有 Shell 设置行、进程输入/停止摘要及详情，更新真实字段说明和本地化 |

实施可按共享环境与启动、目录与错误、文件与文档、脚本与呈现分成可审阅的改动。分批组织不改变最终覆盖范围，也不要求用户在每个技术步骤确认。

实际修改 private wire 时生成匹配绑定和内核产物；工具参数或明确契约版本变化同步更新所有正式调用入口。历史回执仍按保存时的事实呈现，不重新解释已经执行的命令。

本稿不包含提交、发布、升级版本号或修改用户机器的全局安装环境。实现完成后，将稳定行为折回 [资源](../resources.md)、[运行时](../runtime.md)、[检索](../retrieval.md) 及相邻模块说明，更新本文状态。

## 13. 验收场景

验证按实际失败类型选择，优先扩展已有 owner 的行为测试。静态类型或描述变化不默认增加独立测试套件。

| 场景 | 应观察到的结果 |
| --- | --- |
| Windows 同时有 Git Bash、pwsh | Agent auto 公布并使用 Git Bash；显式 pwsh 使用原参数对应的程序 |
| 显式 Shell 不可用 / 公布后程序失效 | 返回结构化错误和候选；正文没有交给另一个解释器执行 |
| 命令先产生效果再失败 | 保存原回执，不自动切换 Shell 或重放 |
| 普通桌面启动安装包，没有 Codex PATH | Agent 和终端都能执行随包 rg；PowerShell 5.1 的 curl.exe 能按标准参数运行 |
| 远端 Host 与协调端安装不同 | 模型环境事实、可选 Shell、PATH 与实际启动均来自远端 |
| 空格路径、中文与多行命令 | 保留 cwd、参数与正文意图，不发生二次 shell 解析 |
| PTY 原样输入与 submit | 原样字节保持；submit 追加一次指定结束符，同一回执续查不重复发送 |
| 停止进程与取消等待 | 真实退出才确认停止；取消 wait 不杀原进程；保留终止方式与退出码 |
| 已退出但还有输出 | 输出完整性如实变化，按游标续读不丢末尾；源已关闭与当前页读完分别判断 |
| 所有 files 工具均可直调 | 顶层仍有 files，数量与该组实际可用集合一致 |
| 直调、gateway、script 嵌套失败 | 共享错误可读取，原生命周期与媒体、正文证据保留 |
| `paths:["."]` 与省略路径 | 查询同一个根；文件读取根仍明确报目标类型错误；原边界检查继续有效 |
| 条件写入与普通写入回执 | 旧版本冲突仍被识别，成功写入的展示不受 reconciled:false 误导 |
| PDF / DOCX 路径与快照默认读取 | 都按正文意图返回；显式概览保持概览，并能继续定位正文 |
| 无文本、解析失败、缺少组件 | 分别显示实际状态；不会仅返回无法解释的空正文 |
| 脚本跨 cell 使用与重复声明 | 绑定仍可复用，错误给出针对性说明，已产生输出和原副作用状态保留 |

发布产物的 rg 与 Shell smoke 只验证此次接线；复杂进程树与输入幂等继续由现有 native 场景保护。不得用 mock 检测文件存在代替真实可执行验证，也不为本文建立额外监控、评分或大规模重复检查。

## 14. 外部行为参考

- [Microsoft：curl on Windows](https://learn.microsoft.com/windows/curl/)：Windows PowerShell 5.1 别名与 curl.exe 的区别。
- [Git for Windows](https://gitforwindows.org/)：Git Bash 的发行来源。
- [MSYS2：Filesystem Paths](https://www.msys2.org/docs/filesystem-paths/)：Unix 风格路径与 Windows 程序参数转换。

外部资料用于解释平台行为；实际可用项以执行 Host 的发现和原进程回执为准。
