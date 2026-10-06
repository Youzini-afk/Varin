# Agent harness — 工具集（code profile v1）

Status: domain contract — 工具与执行语义；当前注册集合和参数以 Pi harness 实现为准。
交付事实见 [../status.md](../status.md)，计划骨架见 [../plan/agent-harness-plan.md](../plan/agent-harness-plan.md)。

## 5. 工具集（code profile v1）

### 5.0 清单

Pi 1.0 的运行时参考文档由只读 `pi_docs(document?, offset?, limit?)` 提供。它读取当前所选 SDK 的
`docs` 资产，省略 document 时列出参考文件；使用 Pi 原生分页。这个来源与工作区文件不同，文档名
不进入 Host 的工作区路径解析，因此本地 harness 配远端工作区、受限源码 scope 都能读取 SDK 说明，
同时保留原有文件权限。工具本身仍受权限规则和会话工具集合约束；路径穿越、指向 SDK 文档目录外的
别名均拒绝。它使用原生 codemode exposure，脚本通过 `tools.pi_docs` 调用；旧会话恢复工具集合时
不需要新增直接工具声明。codemode 的说明通过原生 factory 的 `docsReference` 接入这个入口。

| 工具 | 来源 | 并发 | 一句话 |
| --- | --- | --- | --- |
| `bash` | 覆盖 Pi | 独占（`executionMode: sequential`） | PTY、持久会话 shell、超时转后台不杀 |
| `grep` | 覆盖 Pi | 并行 | rg 搜索、固定 surface 叠加、分组排序与有界结果 |
| `edit` / `write` | 覆盖 Pi | 工具层允许并发；实际提交受资源 gate 与修订检查约束 | 附加新引入的诊断；资源粒度调度目标见 5.9 |
| `apply_patch` | 新增 | 从同一 patch 解析完整路径集，按资源冲突调度 | Codex 语法多文件编辑，按模型家族启用；底层仍由同一 mutation authority 原子/补偿处理 |
| `read` / `find` / `ls` | 同名适配 | 并行 | `read` 保留 Pi 原生分页、截断与图片；find/ls 取得 Host 的固定 dirty path/虚拟祖先并经 Pi 原生定义合并磁盘结果，过期相关来源不可回退 |
| `get_output` / `write_to_process` / `kill_shell` | 新增 | 读并行，写与杀独占 | 后台 shell 与输出句柄；对运行中 shell 默认返回上次读取之后的增量（第 5.5 节） |
| `diagnostics` | 新增 | 并行 | `pending` 后按需查 |
| `todo` | 新增 | 串行 | 主 agent 自己的计划（第 5.6 节） |
| `explore(question, anchors?, paths?, limit?)` | 原生，接通后默认注册 | 并行 | 用主 agent 的问题与已知锚点做确定性召回、结构切片与互补打包，返回带版本的代码原文；`limit` 只管输出条数；模型机制按已配置槽位使用（第 5.7、6.1 节，D-090） |
| `dispatch` / `threads` / `wait` / `send` / `read_thread` / `merge` / `kill` | 新增 | 并行按任务与真实作用域；wait 等待让出执行名额；同目标状态修改串行 | 派发工作（预设可选）、读取状态/成果、定向通知或请求、续做与选择上下文、集成固定结果、终止（第 5.7、9.2、9.3 节） |
| `webfetch` / `websearch` | 新增 | 并行 | 抓取与搜索，SSRF 策略、阅读子 agent、provider 抽象（第 5.8 节） |
| `related` / `recall` | 新增（第 3 阶段） | 并行 | 知识库结构与记忆（第 6.2、7.4 节） |
| `symbols` / `definition` / `references` / `hover` | 新增（第 3 阶段） | 并行 | 真实 LanguageSupervisor 导航；路径受 Host authority/scope 约束，位置对 agent 一基（D-051）；正文来自 agent 视图并携带修订与来源，跨文件位置区分已固定与未固定（第 6.4 节，D-087） |

不在 v1：沙箱（第 9.1.1 节）；浏览器操作（点击、表单——
research 与 knowledge-work profile 再评估）。

### 5.1 贯穿所有工具的原则

1. **同名覆盖，不并列。** 模型不应有两种方式做同一件事。
2. **两份输出。** `content` 文本为模型的下一步决策而写；`details` 为 Varin 工具卡片渲染而写。两者不互相
   妥协。
3. **输出句柄。** 超过阈值（默认可见 32 KiB，首尾各半；`bash` 默认尾部加权，因为退出信息在末尾）的输出由
   host 存全文，模型看到预览与 `[省略 N 字节 — get_output("out_x", offset, length)]`。句柄是会话作用域，
   **压缩后仍有效**。截断发生在结果进入上下文之前，不是事后修改。截断在 `tool_result` 钩子层实现，因此对**所有**
   工具生效，包括 Pi 原样保留的 `read` / `find` / `ls`——读一个 5,000 行文件不会整个进入窗口。

   句柄有两种耐久级别，不混用（D-034）。**`OutputRef` 是临时的**：只在 host 进程内、按会话预算 FIFO 淘汰，
   不得写入任何持久记录；句柄编码 `out_<hostEpoch>_<sequence>_<mac>`，epoch 与截断后的 HMAC 均为 128 bit，host 按会话记
   `{ nextSequence, evictedThrough }`
   两个水位，于是 host 重启（epoch 不同）或被淘汰（序号低于水位）都能返回 **`expired`**，从未签发的返回 `not-found`——
   两种"不在"不合并。**`TranscriptRef`（`{ runtimeId, sessionId, fromEntryId, toEntryId }`）是耐久的**：指向 Pi 会话
   文件本身，线程报告引用持久记录用它，不用 `OutputRef`。**持久记录可能只有截断预览**：`TranscriptRef` 不承诺找回已随 Host 重启
   或淘汰消失的中间正文。可重建来源引用能实际读取正文的 Git/恢复对象；不可重建观察须有操作所属的耐久产物，或明确临时可用。
   文件路径、revision、hash 本身不是正文存储；压缩恢复不能仅依赖临时句柄。所有偏移与长度一律是 **UTF-8 字节**，切片在字节边界处
   向最近的字符边界回退，分页返回 `nextOffset` 与 `eof`，调用方不得假设 `next = offset + length`。从旧 catalog 迁移时
   `fromEntryId / toEntryId` 可为 null，表示该 Pi 会话当前分支的首项 / 叶项，不再保留旧的临时 handle。
4. **错误即指令。** 每条失败文本 = 发生了什么 + 一个具体的下一步。
5. **shell 由 harness 决定。** 模型不选 shell、不选编码、不选交互模式。
6. **非零退出不是工具错误。** 它是正常结果，给退出码与 stderr，不加错误框架；否则模型会把测试失败当成
   工具损坏。
7. **两种"空"不合并。** `0 hits (searched 1,204 files)` 与 `search unavailable: ...` 是两条不同文本。这是
   仓库既有不变量在工具层的体现。
8. **紧凑不删证据。** 工具卡标题从 arguments/details 投影一行摘要；同一 assistant step 内连续 2 个以上、且名称明确列入
   只读集合的调用折叠成一组，写入、shell 与未知扩展工具都打断分组。组和单卡始终可展开原始 arguments/result/details；
   renderer 不根据“未知工具看起来像查询”猜它只读（D-048）。sorted 模式已有整段 activity 折叠，不再套第二层默认分组。

阈值、超时、并行度均为默认值，可由设置覆盖；本文档不设硬上限。默认呈现应足以完成本次调用的用途；缓存命中时可减少
旧结果的重复输入成本，具体折扣和有效期按 provider 计算。临近窗口时先处理上下文容量，不临时降低正常工具的信息质量；
单份材料本身超窗时使用明确分页与全文入口。参照：Claude Code 的 Bash 默认截断 30,000 字符、Grep 落盘阈值 20K 字符、Grep 默认
250 条。

### 5.2 `bash`（覆盖）

保留名字 `bash`——模型的先验是 bash 语法。**锁的是"谁选解释器"，不是"只有一个解释器"**：模型每次调用不选 shell
（这是确定性的来源，Claude Code / Codex / Devin 都如此），解释器由 harness **按工作区环境**选定并在会话内固定：

| 环境 | 解释器 |
| --- | --- |
| 原生 Windows 工作区 | Git Bash（Pi 与 Claude Code 均要求其存在） |
| WSL 内的工作区（`\\wsl$` 路径） | `wsl.exe -d <distro> bash` |
| SSH 远程 / 远程实例 | 远端 shell |
| 容器 | 容器内 shell |
| macOS / Linux | `bash` |

工作区设置 `harness.shell: auto | git-bash | powershell | wsl`（默认 `auto`）供用户覆盖——整套工具链是 `.ps1` 的团队
可切 PowerShell。该值来自现有 Pi `settings.json`（用户默认 + 受信任项目覆盖），在**该会话注册时**生效，不另建配置
文件。Application Host 在构造时用与 Git 服务相同的 Windows 安装根、PATH 和已解析的 `git.exe` 位置发现可执行的
`bash.exe`，优先 `usr\bin` 而不是 `bin` 启动器。未发现时工具返回准确原因和安装/改设置入口，不能把已安装误报成未安装。
注册与工具准入按 actor 的 worker 代际协调：首个请求等待本代配置，关闭或换代后的迟到结果不能复活会话。设置不可读与配置非法
都明确 unavailable，不当成 auto；首次注册保留已经捕获的输入快照。PowerShell 用 ConPTY 可用的交互启动与自身命令包装（D-205）。
此外 Windows 原生工具随时可从 bash 内调用（`powershell.exe -c ...`、`cmd //c ...`），harness 不
禁止。Codex 原生 Windows 与 Cursor 默认 PowerShell；Varin 跟随 Pi。Git Bash 的已知坑（MSYS 路径自动转换会误转
形如路径的参数，`MSYS_NO_PATHCONV=1` 可关；CRLF；fork 慢）由 shell 监督器的默认环境处理，不暴露给模型。

当前公开工具参数包括 `command`、`waitMs?`、可选受管 `target` 与目标 `cwd`；普通本机调用沿用会话目录。
Pi 工具等待默认 10 s；bridge 为观察窗口预留返回时间，超出通用请求上界时不另设更短的传输期限。观察取消不等于进程终止。
**等待期限不等于进程期限**：命令在 `waitMs` 内结束则同步返回；否则**自动转后台**，返回"已等待 N 秒，仍在运行，shell id X"与截至此刻的输出，
模型继续工作，稍后用 `get_output(X)` 取结果、`write_to_process(X, text)` 喂 stdin、`kill_shell(X)` 终止。这是
Devin CLI `exec` / `get_output` / `write_to_process` / `kill_shell` 与 Codex `exec_command(yield_time_ms)` /
`write_stdin` 共同的形状：由 harness 按经过时间决定前后台，模型不需要预判一条命令要跑多久，构建与测试也不会在
中途被 harness 自己杀掉。后台进程随会话生命周期终止；可选的后台硬上限是配置项，默认不设。

执行模型由 host 的 shell 监督器拥有，对照三家的实际做法选择：

- **PTY，不是管道。** Codex 的 `unified_exec` 是 PTY；Claude Code 是持久管道 shell，因此"不能原生处理 vim、sudo 这类
  TTY 交互提示"。Varin 选 PTY，复用 host 现有终端运行时：后台 shell 天然就是用户可附着、可输入的终端 tab（第 2 节
  已定的 UI 投影），程序的行为与在终端中一致。给模型的文本剥去 ANSI 与控制序列（host 已有 replay-safe 字节逻辑），
  终端 tab 显示原始字节。后台命令使用 terminal runtime 的同一会话身份（D-206）：监督器经
  `createTerminalSession` / `attachTerminalSession` 创建与附着，HTTP 不能指定 owner/spawn。`sh_N` 由全局 terminal runtime
  分配，监督器使用返回的实际 id；同名会话只有完整创建身份一致且仍在运行时才能复用，HTTP 不能接管 Harness handle。
  关闭查看界面只脱离附着，显式终止仍走统一关闭链。哨兵格式与默认环境变量集在 `lib/harness/DOCUMENTATION.md`。
- **stdin 开着，harness 永不代写。** 等输入的程序会停在提示上；`waitMs` 到了它转后台，模型在输出里看到提示文本，
  用 `write_to_process` 回答或 `kill_shell` 放弃。Pi 内置 bash 的 stdin 是 ignore，与 `write_to_process` 不相容，
  因此这里不沿用。
- **每次 `bash` 是独立命令。** cwd 来自本次显式参数或请求受理时冻结的默认目录；`cd`、环境变量、
  venv 和 `nvm use` 不跨调用继承。需要同一命令环境时在该命令中准备；需要继续交互时使用返回的实际进程句柄。
  超过 `waitMs` 只结束前台观察，不启动一条继承其状态的替代 shell。Bash 家族仍按所选解释器加载用户启动配置，
  具体启动与结果形状见 [bash tool](../../packages/pi-host/src/harness/bash-tool.ts)。
- **环境变量只改交互与显示，不改工具语义。** 叠加在用户环境之上：`GIT_TERMINAL_PROMPT=0`（git 不弹凭据框）、
  `PAGER=cat GIT_PAGER=cat`（不弹分页器）、`NO_COLOR=1`（减少 ANSI 噪音）、`PYTHONUNBUFFERED=1`、Linux 上
  `DEBIAN_FRONTEND=noninteractive`。**不设 `CI=1`**：许多构建工具在 `CI` 下改变语义（Create React App 把 warning 当
  error、yarn 变为 frozen-lockfile、部分 CLI 关闭功能），会让 agent 看到的构建结果与用户终端不一致；它原本用于压掉交互
  提示，而 PTY 加 `write_to_process` 已能看到并回答提示。**locale 不硬编码**：host 启动时探测机器上可用的 UTF-8
  locale（`C.UTF-8` 在旧版 macOS 不存在，硬设会让每条命令刷 `setlocale` 警告），没有则不设，PTY 自身按 UTF-8 解码。
  PTY 提供真实 `TERM`，不设 `TERM=dumb`。整套默认环境在设置中可见、可按工作区修改。
- `kill_shell` 与会话结束时终止整个进程树；复用 host 已有的 process-tree termination。没有超时杀死。
- 后台命令的完成由 PTY exit 事件产生，不以模型调用 `get_output` 为前提；start/end 各记录一次，重复观察只读已有事实。
- `bash` 的命令正文是不透明副作用，因此保持资源屏障；其他工具按已验证参数提供资源计划，不再因一个已知 sequential 工具把所有独立调用逐条执行（5.9）。
- 执行期间向 mutation authority 注册为 `process` writer（`WRITER_MODES` 中已存在的模式），使恢复系统知道本轮
  文件覆盖不完整。这是恢复设计已预留的语义。
- 会话关闭等待 PTY 实际退出，再释放写者；中断请求不等于命令已经结束。失败保留活动状态与可重试关闭，已从会话表移除的
  shell 在关闭完成前仍参与目录回收判断。writer 释放失败同样保留目录保护并可在后续关闭重试；线程不能只凭 Pi close
  响应就删除执行目录（D-205/D-209）。

模型看到的文本形状：

```text
exit 0 · 1.2s · cwd packages/web
<stdout 首部>
…
<stdout 尾部>
[stderr 3 行]
[输出共 61,204 字节，显示首 12,288 + 末 20,480 — get_output("out_7f3a", offset, length)]
```

三类结果各有文本：非零退出（正常结果，不是错误）；转后台（正常结果，附 shell id 与已等待时长）；spawn 失败
（工具错误，附 shell 路径与修复方式）。系统提示明令不用 `bash` 跑 `grep` / `rg` / `find` / `cat`——内置工具有
正确的 ignore 规则、权限与截断（Claude Code 的同款约束）。

**输出压缩：按命令整理默认展示（3.17，D-160 / D-197 / D-199 / D-241）。** vitest / tsc / eslint / git 识别失败块、定位与统计，
只收起明确的成功或重复噪声；未知内容保留。常见 pretty/plain 格式、失败块续文与交互提示都属于可读正文，不能因为看见统计行就丢弃其他行。
未识别命令或无法可靠区分来源的混合输出走通用首尾展示；工具名出现在参数中不等于正在执行该工具。目标形状仍是五层：**命令专用解析器**（`vitest` / `jest`、`tsc`、
`eslint` / `biome`、`git`、`cargo`、`pytest` 等，从可靠的执行位置识别命令，用已知格式组织统计与失败块）→
**输出形状嗅探**（经 `npm test` / `make check` 包裹时按输出本身识别）→ **包管理器通配**（`npm` / `pnpm` / `yarn` / `bun` 头 token，已接，D-241）→
**声明式规则**（用户/项目可加的"删这些行、截这些、保留这些"，覆盖长尾）→ **通用兜底**（去 ANSI、连续去重、首尾切）。
全文照旧进 OutputStore，句柄不变。沿用 32 KiB 可见预算，超出时标明省略并提供原文读取；单个大块也要留下可用的首尾，不能只返回省略提示。
分片展示只代表本次观察，退出码只取进程事实。获得 Host 整理结果后免于二次裁切；旧 Host 的未整理结果保留通用截断，显式分页保持原始 UTF-8 与字节游标。
**不用小模型做总结替代**：规则整理不需要额外模型调用，但解析器也可能漏识别格式，因此以保留未知内容为前提。模型总结**可以作为附加**放在非结构化输出上
（"这是头、这是尾、这是模型认为重要的几行、全文在句柄"），减少拉取的同时不让 agent 误以为看到了全部。先做的四个（vitest、tsc、eslint、git）已按 D-197 进入公开 `bash` 与增量 `get_output`。
包管理器通配已按 D-241 接线：`npm`/`pnpm`/`yarn`/`bun` 头的脚本运行与内置命令（`npm test`、`pnpm run build`、`yarn add`、`bun install`）
以及 `exec`/`dlx`/`x` 包裹下未识别的二进制都先归到管理器层；管理器自己回显的脚本命令（`>` / `$` 行）是可靠的执行位置，
能解析出内层命令就把其后正文交给对应解析器（kind 记为内层工具，包裹行保留在正文里）；解析不出时先对正文做形状嗅探，
仍不识别则按管理器形状整理——错误块与 install/audit 摘要是必需项，`npm warn`/进度/下载类重复噪声折叠成计数，其余正文原样保留。
其余命令与未识别输出仍走通用展示；声明式规则和附加模型总结尚未接。

### 5.3 `grep`（覆盖）

覆盖 Pi 内置 `grep` 而非新增 `search`，以保持同名覆盖原则。现行参数是 `pattern`、`path`、大小写、fixed string、
`-A/-B/-C` 等价邻行、多个 include/exclude glob 与 `limit`；曾暴露但从未实现的 `--type` 和 files/count mode 已删除，
不让假参数继续占工具 schema。`limit` 默认 100 条命中，达到限制时返回 partial，模型可缩小 path/glob 或提高 limit。

- 走 host 的 `createWorkspaceContentSearch`（ripgrep，尊重 `.gitignore`，有界）；调用方的 include/exclude glob 直接传给 rg，
  surface 路径用同一组规则过滤。
- 排序按文件分组；当前按命中数、源码/测试路径偏好和路径深度确定顺序。mtime 与 Git modified 尚未接入，不把占位字段
  写成已生效的排序信号。
- **不含符号模式。** 符号导航（定义、引用、工作区符号、悬停签名 `hover`）是独立的 LSP 工具，第 3 阶段与 `related` 一起
  交付——Claude Code 也把 LSP 与 Grep 分开，Devin 的 `hover_symbol` 与定义、引用并列。grep 的 schema 保持与 rg 一致，
  不混入 rg 没有的语义。
- Host 搜索当前有 20 s 工作默认；取消、rg 失败或超时返回 unavailable，命中数超过显示 limit 才返回 partial，不能把 unavailable
  写成零命中。
- D-085 已让 `grep` 消费与 `explore` 相同的固定 surface snapshot：先在 rg 流式计数前排除 dirty path 的旧磁盘命中，再在固定
  草稿上执行相同 regex/fixed/case/glob 过滤，最后统一排序和截断。草稿缺失或过期时整个相关查询 unavailable，不回退磁盘。

### 5.4 `edit` / `write`（已覆盖，附加诊断）

参数形状**不变**（`path` / `oldText` / `newText`），保持模型先验。改变的是返回：写入后若该工作区有对应语言的
LSP 在运行，**等待该文件的下一次诊断发布**（事件驱动，不是固定休眠），上限默认 5 s——大型 TypeScript 项目的诊断
更新常需数秒，过短的固定等待会让 `pending` 成为常态而使该功能失去意义。取到后**只返回本次编辑新引入的**诊断
（与编辑前快照做差）。

```text
edited packages/ui/src/lib/foo.ts (+3 −1)
diagnostics (typescript): 1 new error
  42:7 TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

三种非成功态各有文本：`unavailable (no language server for .py)`、`pending (server busy) — call
diagnostics("foo.ts")`、`clean`。永不沉默。实现路径优先用 `tool_result` 钩子替换 `content`，这样恢复日志的
覆盖与诊断附加互不耦合。

根会话 `edit` / `write` / `apply_patch` 与本轮固定输入共用同一正文权威（D-225，身份、WAL 与补偿由 D-228/D-232 纠正）。虚拟线程仍先走 `document.branchWrite`。
其余路径进入共享 Host 计划 `document.surfaceWrite`：本轮 snapshot 拥有的路径按固定正文匹配，写回同一 Document Registry
缓冲，并核对 owner / generation / registration / document instance / `localEditRevision` / `baseRevision`。
UI publication 的 `bufferHash` 是规范化编辑器 buffer 身份；snapshot 正文是带原行尾的序列化文件正文，二者不得直接比较。
写回 Registry 前转换成编辑器规范形式；写回后的 snapshot 仍按文件行尾呈现。
用户在计划后继续编辑则明确 stale/conflict，不覆盖缓冲，也不回退写磁盘，且不隐式保存。普通磁盘路径保持既有 journaled
disk 写入。多文件同时含 surface 与 disk 时，在同一 Documents resource gate 内先核对全部磁盘成员的原始字节身份，再允许任何
surface dispatch；第一笔写入前把 intent 记入独立 `agent-mutation` 操作（不冒充 Integration）。WAL 区分明确 failed receipt 与
已 dispatch 但无认证回执，并记录补偿 intent、观察结果和 target-after；
apply 与 undo 共用同一个真实 `operationId`，一次 batch 只能整组撤销。取消 / I/O throw / 断连后走条件补偿或 needs-attention，
补偿不复用已 aborted 的前向 signal。按路径返回 applied / conflict / compensated / needs-attention，不允许“前面已写、后面失败”
却只报普通失败且无记录。`apply_patch` 仅当 `document.readSource` 明确返回 `source=disk` 时才读磁盘；unavailable/stale/传输错误必须停止，
整文件替换携带所读 surface revision/hash。磁盘写成功到 target-after 捕获之间崩溃时不猜写入结果，恢复状态/UI 明确 needs-attention。
删除、二进制、symlink、mode 等 surface 无法表达的操作明确 unavailable/conflict。
成功写入后同一回合后续 read/edit 看到新缓冲正文，不退回旧 snapshot 或旧磁盘。参数保持同名先验。

**编辑格式跟模型家族走。** Codex 系模型按 `apply_patch` 语法训练（`*** Begin Patch` / `*** Update File:` /
`@@` hunk / `*** End Patch`，一次可改多文件，仅相对路径）；Claude 系按 str_replace 训练。Devin CLI 两者并存，
Cursor 为每个前沿模型单独调工具。Varin 支持任意 provider，因此提供 `apply_patch` 工具，由 profile 按会话模型
家族启用其一或两者；两者共用同一 mutation boundary 与诊断附加，恢复日志按 patch 中声明的路径逐文件记录。

### 5.5 `get_output`、`write_to_process`、`kill_shell`、`diagnostics`

`get_output(handle, offset?, length?, waitMs?)` 统一读取两类东西：已完成输出的句柄（`out_x`）与仍在后台运行的 shell（`bash`
返回的 shell id）。没有它句柄是死的。`write_to_process(id, text)` 与 `kill_shell(id)` 服务后台 shell。
`diagnostics(path?)` 供 `pending` 态后按需查询。

**反复读同一个对象时默认返回增量**（第 8.7 节）。对运行中的 shell，不带 `offset` 的 `get_output` 返回上次读取之后的新
输出，开头一行引头 `[shell sh_3 · +2.1 KB since last read (40 s ago) · still running]`；没有新输出就一行"无新输出，仍在
运行，最近输出 40 秒前"。显式 `offset` / `length` 才是随机访问，用于回看。`diagnostics` 对同一路径的重复查询只报新增与
消失的条目。游标由 host 按（会话，对象）保存，不占模型的上下文，压缩后第一次读取回到全量。已完成的输出句柄是静态的，
没有增量语义，仍按 `offset` / `length` 分页。

D-302 / 7H 已在同一工具上增加可取消的事件等待，保留默认立即读取和显式历史分页；后台完成事实接入 7G 环境增量。
等待只结束本次观察，不终止进程；普通 shell 仍不承诺跨 Host 重启生存。
具体启动、等待、通知和生命周期设计见 5.9.2。

### 5.6 `todo`（新增，主 agent 自己的计划）

主 agent 对记忆系统零义务（第 8.4.1 节），但它可以为**自己的注意力**维护一份计划。`todo({ items: [{ text, status }],
confidence? })`——整表替换语义，Claude Code TodoWrite 的形状，模型训练过。写入知识库的 `plan` 块（主 agent 是该块唯一
的模型侧结构所有者，用户可以在面板编辑），显示在计划面板；用户修改作为新事实进 Zone 2，agent 自己的修改已在工具结果中。
后台压缩不编辑 plan，也不因停止 keeper 而隐藏计划。`confidence` 可选：主 agent 声明对计划的信心，
只作说明，不以自报分数自动增加确认步骤。只有用户显式选择 plan mode 或配置计划审批时才按该选择等待。系统提示只建议
"非平凡任务先计划"，harness 不检查它是否被调用，也不因其陈旧而提醒。confidence 只作信息；plan mode 或权限策略需要
批准时由既有 pre-tool 流程处理，`todo.upsert` 写入后没有第二次确认协议（D-206/D-209）。

### 5.7 `explore`、`dispatch` / `wait`（新增）

**`explore(question, anchors?, paths?, limit?)` 是正式默认的快速检索能力**，规格统一见第 6.1 节（D-173）。它使用词法、路径、
符号和可用向量，帮助主 agent 发现实现入口并取得少量当前代码原文。`question` 描述所需材料，`anchors` 提供已有线索，`paths`
限定范围，`limit` 限定输出条数。锚点优先取得候选而非隐式过滤；具体关系可在原文中核实，开放问题的推理留给主 agent 或 retrieval。
当前路线包含 LLM 的局部语义决策：查询理解/搜索表达与候选相关性判断经 `models.explore` 接入，搜索、读取、版本与呈现归算法。
每次模型调用围绕一个明确决策；允许保持原问题、有当前材料依据的局部补查，不在工具内开展开放自主调查。成组选段须保留
必需源码范围，跨进程阶段延续同一次查询。扩散模型与后训练留后续，不推迟当前 LLM 接线（D-174/D-175）。
来源、版本、草稿与输出句柄沿既有实际 authority；接线与未观察项只记在 status，不能把真实 provider 延迟、质量或完整冷扫时间写成已验证。

`dispatch(task, { input?, preset?, scope?, worktree? })` 异步开一条工作线程，父继续推进。默认普通模型执行，不强制选择角色；
预设配置、背景起点与工作分支分别表达（9.2）。成果形状按用途：review 给发现与依据，检索给事实/来源，实现给实际变更与
说明。过程中有用的问题和信息可以定向交流，普通过程不广播。已有工作可继续或 fresh，不因返回过一次结果就必须重建线程。

父 agent 通过增量观察和定向消息协调工作（第 9.3.6 节）：`threads(ids?)` 非阻塞返回一张增量状态表；
`wait(ids?, timeout_ms?)` 等待所选线程的结果、对应答复或需处理的状态变化，超时返回当前观察，**超时是正常结果**；省略期限时持续事件等待，
不按缓存 TTL 唤醒（第 9.2.6 节）；`read_thread(id, what?)` 默认读线程状态与已有报告，需要时读取计划/用户笔记或转录切片；
不为提供 progress/decisions 块启动 keeper。send 给线程传话；kill 终止执行并保留工作结果，目录按 9.3.4 回收。
merge 集成选定的不可变子结果，返回应用、冲突和恢复状态；文本冲突保留标记，非文本提供父/子版本选择（9.2.5b）。
未配置且未声明继承的专用预设不可用，普通派发仍可用；等待/通信与恢复语义按9.2/9.3，不再只接受 active 子线程。

### 5.8 `webfetch` / `websearch`（新增）

**Web 与科研材料。** 当前 `research_search` 支持发现、详情和分页关系；`document_read` 提供固定 PDF 原件的
文本、页图与结构视图，`materials` 管理授权材料集合，`research_decide` 复用快速决策配置。
注册按 Host 能力和工具设置生效；解析器、provider 和平台可用性分别报告。领域合同见
[Web 与科研检索](web-research-search-design.md)，实际交付及未测边界见 status。

web 能力由 Harness 原生提供，搜索与模型账户无关（D-289）。普通用户无需再申请搜索密钥或安装 MCP。
搜索找到来源，`webfetch` 读取来源正文、查找片段并按行展开；来源面板沿同一工具结果展示 URL。
远程搜索服务负责索引，Host 负责 provider 选择、取消、域名策略与结果呈现。搜索本身不增加 LLM 子对话。

**参考 `pi-web-access`（0.24）的能力清单，原生地做得更好。** 它有：多搜索 provider 路由（自动 / 指定 / 并发 / 全
provider / 有序回退）、完整 provider 与凭据体系（含可执行凭据源、API 网关）、Curator（独立本地 HTTP server 做结果
整理与 summary-review，带 bind 与远程暴露警告）、Chromium cookie opt-in、内容控制（摘要与内联长度、GitHub / 视频 /
图片 / PDF 开关与限制、认证抓取 profile）、SSRF 策略与例外、域名策略、持久化结果浏览。Varin 有 host 与工作台，因此：
Curator 变成工作台的"来源"面板（可审阅、钉住、删除，走已有认证通道，不再有独立 server 与 token-in-URL 风险）；
凭据进 Pi AuthStorage 或系统钥匙串，绝不落明文 JSON；持久化结果进知识库（URL、抓取时间、提取文本；压缩时丢正文
留 URL）；认证抓取用 Electron 的**独立 Varin 浏览器 profile**，不碰用户日常浏览器的 cookie；GitHub 走 `@octokit`
（host 已有依赖）取 issue / PR / 文件而非抓 HTML；有序回退与并发查询原生实现、配置在 Settings；对话框与后续消息变成
工具结果与 Zone 2。视频转录与图片描述 v1 不做。

**`webfetch(url, { prompt?, find?, start_line?, end_line? })`**：Host 抓取，`find` 对提取正文做不区分大小写的字面查找，返回命中行与相邻上下文；行范围按一开始的提取 Markdown 行号包含两端，未指定范围时沿原正文呈现。查无结果是正常观察，非法范围是明确参数错误。SSRF 策略复用 [security.md](security.md) 已有规则——私有与保留网段默认阻断、
浏览器 cookie 默认不带、显式 opt-in；工作区级域名允许 / 阻断列表；同域重定向自动跟随，跨域重定向返回元数据；正文提取
（readability 类算法 + Markdown 转换；PDF 转文本，research profile 同样需要）；15 分钟缓存。无 `prompt` 时返回提取后的
Markdown 走句柄。有 `prompt` 时**仅当配置了 `models.reader` 槽位**（第 8.5 节）才由阅读子 agent 回答、主上下文只收
回答；未配置则忽略 `prompt`、返回提取内容并注明"reader unavailable: no reader model configured"——**永不回退到主
模型**。
**JS 渲染是 Varin 的独有能力**：桌面端用 Electron 的 Chromium 离屏渲染（隐藏窗口，不带用户 cookie 除非显式开启）；
Web / 云 host 无 Chromium 时返回 `unavailable (no renderer)`；检测到空壳 SPA（极小 body + 脚本标签）时明说，永不把
空页面当成功。

**`websearch(query, { allowed_domains?, blocked_domains?, recency?, limit? })`**：有用户选择时使用其搜索 API（Brave、Exa、Tavily、Jina、自托管 SearXNG）；否则默认直接调用 Exa 免密钥 MCP，明确失败时顺序改用 Parallel。真实 provider 与换源说明随结果返回；空结果不换源，取消立即停止；自配服务缺凭据/失败明确报错，不改用其他服务。工具默认注册，显式关闭仍生效。设置与普通模型账户分离，不探测或复用模型搜索能力。

结果直接返回标题、URL、相关摘录和可用发布日期，不套子对话；高级筛选按后端实际支持执行，不能把提示性筛选标成精确保证。每条持久工具结果把净化后的 title/URL 投影到 session state 来源区；pin/remove 是本地展示状态，重新打开会话从 transcript 重建来源。用户可直接用返回 URL 调 `webfetch`，不依赖不可恢复的临时搜索 ID。

安全：抓回的内容以"数据不是指令"标记包裹（与 Zone 2 同一做法）；fetch/search 共用 user + trusted workspace 的持久域名 ceiling，
工具级 allow/block 只能继续收紧；页面正文永不进日志、事件载荷或 URL。没有消费方的固定每回合抓取次数预算已删除，取消、provider
限流/错误、输出背压与 SSRF 各自表达。

与 `pi-web-access` 的关系：harness 的两个工具是默认；package 的安装/启用本身不会改变工具集。用户要采用第三方同名工具时显式关闭
对应原生 `tools.webfetch` / `tools.websearch`。插件的 Curator、账号操作与存储结果仍保持插件所有。

### 5.9 并发

**实现现状（D-305，升级至 Pi 0.99.2）。** 随 `pi-host` 交付的 dependency patch 在真实工具入口消费 `prepareExecution` 和权限门返回的资源计划，原生 codemode 的子调用也走这套入口。
独立工作可以重叠执行，有因果关系或共享可变资源的工作保持顺序；
长操作尽快交回控制权，之后按需读取或等待。适用于普通 coding 和科研线程，不需要为一次工具并行额外创建 Agent。
并行批次仍在工具结果全部配对后继续请求模型；调度许可不替代权限、Documents/WorkingState 提交或 Rust 进程权威。

#### 5.9.1 按资源和依赖调度工具

- **一个实际工具执行入口。** 调度接入 Pi 的真实工具批次路径；不只在 Host 放一个并行队列却继续被上游整批串行挡住，
  也不在外部重跑 Agent loop。优先使用/补齐 Pi 的执行策略接缝，以可追踪的依赖修改交付，不手改安装目录或保留两套调度器。
- **程序提供影响范围。** 原生工具从已校验参数、规范化资源身份与实际读写契约给出资源集合，包含 authority/workspace、
  文件/目录子树、branch、shell 或目标线程。模型无需逐次填写依赖图；一次请求依赖尚未取得的结果时，应在结果返回后再发下一批。
  不按工具名、shell 命令关键词或模型自称“只读”推断权限/副作用，第三方工具沿实际来源和声明处理。
- **保留必要顺序。** 同一资源上写后读、读后写、写后写按调用顺序协调；独立读取、无关文件修改和无依赖的网络查询可重叠。
  多文件 patch 先确定全部规范路径，一次协调其完整集合；目录/子路径与路径别名不能漏冲突。继续复用 Documents/WorkingState
  的修订检查、持久操作和补偿；调度许可不代替底层提交权威。同一 branch 的短暂 CAS 提交串行不等于整项工具必须串行。
- **串行约束只约束必要范围。** 已知资源可以使用各自执行顺序；影响未知且要求 sequential 的工具仍是有序屏障，
  但屏障前后的独立批次各自并行，不再因出现一个屏障就把整批所有调用逐条执行。不能为追求并行越过尚未证明独立的屏障。
  共享 shell 的 cwd/环境修改需要顺序；独立进程可以重叠，但独立进程身份不证明它们不会读写相同文件。
- **审批、取消和结果保持原契约。** 排队前确定依赖，获得许可后执行；等待人工审批不占着文件提交锁。
  同资源失败/拒绝不能让依赖调用误以为前置成功，独立已获许可的调用可以继续。结果按真实 toolCallId 配对，完成进度可先展示，
  不在仍有未匹配工具结果时强行请求模型。取消未开始的工作不留下幽灵调用，已开始的副作用按实际结果与恢复状态报告。
- 不引入调度模型、apply model、固定并发配额或按文件数量限流；背压来自现有 provider/资源能力和实际负载。
  不把同文件多位置编辑、多文件单 patch、多工具并行、多 Agent、后台进程混作一种性能证据。

#### 5.9.2 长命令交回控制权，事实与正文分开交付

目标路径：`bash` 启动 → 短等待后直接完成或返回 shell/执行身份 → Agent 继续工作 → 完成事实进入下一次请求的环境增量 →
需要时 `get_output` 展开正文。命令执行、工具返回与模型恢复是三个独立时点。

1. **启动与等待。** 保留 `bash(command, waitMs?)`；7H 允许 `waitMs: 0` 明确要求启动后即返回身份，通常调用采用可配置的
   短等待后自动转后台。默认等待值按现有交互与代表性短命令测量选择，本设计不猜一个通用秒数。后台分离不终止进程，
   完成恰好发生在分离时也只能形成一个执行和一个真实结果。前台 shell 转后台后不再接收下一条普通命令；新的前台 shell
   对 cwd/环境的继承必须如实表达，不宣称能复制前一进程中任意未导出的环境、函数或激活状态。
2. **等待期限统一。** 协调工具、bridge、router 与进程启动/等待责任，修复当前 30 s 请求期限早于 60 s 后台返回的路径；
   不只是把超时改成更大的固定数。等待结束返回 running/退出事实，取消观察只结束观察，显式 `kill_shell` 才请求终止。
   进程执行期限只有明确产品配置/用户请求才存在；审计并删除未被执行端消费的 `runMs` 等空参数，不把等待超时变成暗中的杀进程。
3. **按需读与事件等待。** 沿用 `get_output(handle, offset?, length?, waitMs?)`，增加可选 `waitMs`：默认立即读；指定等待时，
   已有未读输出/终态直接返回，否则由新输出、实际退出、取消或本次观察期限结束唤醒。静态输出/显式历史切片直接读取，
   不为已存在的字节等待。返回运行状态、退出码或“无新输出，仍运行”，不用循环轮询或“没有输出=卡死”的推断。
   长期等待复用执行准入的让出/恢复接缝；让出模型名额不释放仍被进程占用的机器、writer 或目录责任。
4. **完成通知接 7G。** 真实完成、失败、取消确认等新事实，带执行身份、命令简述、退出码和详情入口，作为来源明确的
   环境增量在下一次安全模型请求前交付、之后留史。后台通知不用 `<user-terminal>` 冒充用户行为，不灌入全部日志，
   不往团队现状四列表加进程清单。尚在运行/输出增长由工具和 UI 按需呈现；不能从日志关键词臆造“等输入”“失败”或科学判断。
5. **交付不漏不重。** 命令执行身份/终态修订、每个模型接收者的事实收据与输出字节游标分开。`bash`/`get_output` 已实际
   把同一终态交给该模型时，不再作为新消息重复播报；仅读过日志不算读过随后退出事实，完成通知也不消费未读日志。
   UI 阅读不消费模型收据。7G 准备失败、取消、压缩/fresh 仍按实际保留原文恢复必要状态，不给历史中已知终态反复追加“新完成”。
6. **何时恢复模型。** Agent 正在推进其他工作时，下次自然请求接收变化；已经空闲时，只有明确建立的等待或用户/Agent
   选择的完成后续做关系才通过既有会话队列恢复。普通后台启动不自动订阅续做，输出增长不发起模型调用；订阅只记录一次
   明确意图、可取消、完成早于订阅也可处理，并与自然续接合并，避免重复模型回合或在 active 会话旁开第二个 loop。
7. **运行权威和生命周期。** Host 做授权、路由和呈现，Rust/既有 terminal runtime 拥有真实进程、输出与退出；
   终止仍到实际进程树，确认退出前不释放 writer/目录保护。执行身份关联原 toolCallId，启动响应丢失后能查询已受理执行，
   不能盲目重试命令造成双进程。查询入口复用既有会话/终端事实，并向模型提供可发现的找回方式。
   普通 shell 按会话生命周期管理，不因此承诺跨 Host 重启重附着或耐久全文；确需断线/重启继续的实验使用 D-300 durable attempt，
   二者共享底层能力和事实呈现，不把每条 shell 都强制变成实验。不可恢复/日志过期如实表达。

验收同时覆盖工具执行并行与资源提交，不以单纯 `Promise.all` 或工具声明证明生产并发；代表性端到端场景和未实测边界见 plan 7H。

#### 5.9.3 会话等待、触发与续接（D-307，待实施）

在 7G/7H/7I 基础上，后续 [阶段 W](../archive/agent-harness-plan-2026-10-06.md#阶段-w会话等待触发与续接d-307) 让 Agent 自然登记
“条件满足后在原工作中继续”的意图。完整设计见 [agent-follow-up-design.md](agent-follow-up-design.md)。
时间、执行/实验事件、产物/指标/日志条件由程序观察；明确条件成立或约定评估时点到达才交付后续，
不通过无变化的模型轮询维持等待。简单场景沿长任务返回的身份直接登记，复杂来源按需披露说明。

登记可非阻塞，明确暂停才让出模型槽并抑制 Goal 空转续做；实际进程和资源照常管理。
活跃目标通过 7G/消息在自然请求中处理，空闲且已登记继续意图的目标通过同一准入恢复原 session/Thread。
主/子线程均适用，触发与用户新消息合并协调，不新开隐藏会话、不重复运行、不复活已取消或删除目标。
现有日历新任务保留用途，但启动接受与真实完成分开；等待定义耐久不等于普通 shell 能跨重启存活。
本节登记后续设计，现有短等待、后台句柄和 scheduler API 不代表完整能力已接线。

### 5.10 禁用与替换（适用于全部 harness 能力）

发行版模型的另一半是**每一块都可以被用户关掉、换成 Pi 生态的其他部分**。harness 的每项能力在 Settings 的"Agent
harness"页有独立开关，关掉后的行为明确，不留半开状态：

| 能力 | 关掉后 |
| --- | --- |
| 单个工具（`bash` / `grep` / `edit` / `write` / `apply_patch` / `dispatch` / `todo` / web 等） | 覆盖类回到 Pi 内置实现；新增类不注册。用户可安装任何 Pi 包提供替代 |
| 输出句柄截断 | 工具结果原样进入上下文（Pi 默认行为） |
| Zone 2 组装 | 不追加简报；`before_agent_start` 不返回 `message` |
| 后台摘要准备 | 不提前发起摘要请求；容量不足或用户手动压缩时使用同一摘要实现，允许等待；计划/知识仍可用 |
| 自动压缩（Pi 开关） | 不自动准备或提交压缩，手动压缩仍可用；超出可用容量时明确报告，不靠裁剪伪装成功 |
| 知识库 | 不写入 event / block；`recall` / `related` 不注册；已有 `.tdb` 保留不删 |
| 子 agent 团队 / 单个角色 | `dispatch` 不注册或该角色从团队移除，主 agent 自己做；槽位未配置的角色本就不存在 |
| `explore` 与模型选择 | 工具本身有独立开关；models.explore 服务局部语义决策，清空时无该模型调用并保留算法/向量材料。嵌入/重排绑定分别见第 8.5 节 |
| Varin 权限门 | 不提供关闭整个交互权限门的独立开关；用户通过 mode/rules 控制策略，`bypass` 是明确的用户选择。会话记忆授权可用 `/varin-permissions` 撤销 |

规则：

- **不按包存在自动让位。** 同名第三方工具不会仅因 package 安装/启用就改变会话工具集或权限 owner；用户要替换原生
  `webfetch` / `websearch` 等能力时显式关闭对应原生工具。权限确认始终由 Varin 原生 gate 统一拥有，第三方工具本身仍经过该门。
- 设置**按字段决定所有权**（D-031），不是整份设置一条规则；工作区级只在项目已 trusted 时生效（复用 Pi 的 project trust）：

  | 字段 | 所有权与合并 |
  | --- | --- |
  | 模型槽位 `models.*`、provider 凭据 | user-only |
  | 后台摘要准备与调度偏好 | user-only，全局默认与会话覆盖沿既有配置路径；有效窗口/输出设置继续由模型配置解析，不新增 harness 容量副本；旧 keeper 设置退出规则见 8.4.6 |
  | `knowledge.autoAcceptSuggestions.user` | user-only——一个仓库的配置绝不能替用户打开"自动写入用户级长期记忆" |
  | `knowledge.autoAcceptSuggestions.workspace`、`knowledge.eventRetentionDays` | 工作区可设 |
  | `tools.*`、`shell`、检索策略、`dispatch.concurrency`、`output.*`、UI 偏好 | user 默认 + 工作区覆盖 |
  | `permissions.mode` / `rules`、`dispatch.askBefore` | 工作区**只能收紧**（`bypass < accept-edits < normal`，只能向右；只能追加 ask / deny 与"派发前询问"）；`smart` 需用户显式开启 |
  | `web.*` 域名策略 | user 与工作区取更严格组合 |
  | 能力可用性（如线程运行时是否存在） | **不是设置**，由 host 经 RunManifest 注入，只读 |

- 普通模型/工具设置在下一次会话构造或明确的新 Run/执行配置世代生效，不能隐式改动正在执行的配置。Workbench 布局独立变化；
  权限撤销属于执行门的实时限制，不必修改工具 schema（目标契约，接线状态另记）。
- 开关状态在会话开始时写入 `session` 节点并显示在诊断面板，便于排查"为什么这次没有 X"。

v1 工具在 pi-host 内，不是 Pi 包，因此不出现在 Plugin Settings。若将来需要让用户以第三方工具替换某一项，把
`harness-tools.ts` 提升为 Pi 包是搬家而非重设计——同名覆盖 Pi 包同样可以做。

### 5.11 对话式设置与 Agent 管理（D-306，待实施）

设置页与对话管理同一套配置，目标覆盖现有大部分设置及相关管理动作。完整设计见
[agent-settings-design.md](agent-settings-design.md)，实施见 [plan 阶段 S](../archive/agent-harness-plan-2026-10-06.md#阶段-s对话式设置与-agent-管理d-306)。
共用设置描述与真实 owner 的读取、校验、写入和生效逻辑，UI 搜索与 Agent 目录从同一来源派生。
原生查询/修改工具提供实时配置、来源、支持范围、动态选项及实际结果；Skills 按需解释组合方法。

常驻短能力入口，相关设置按 search/read 披露；简单项查询后即可修改，复杂项继续展开说明、选项和示例。
不强制先读 Skill，不把完整目录或动态配置快照放进 system，不因发现新字段增添一批工具定义。
set/reset 保留真实字段所有权与 revision，普通修改沿已有授权，安装/登录/连接走原领域动作。
保存与生效分别表达，冻结 Run 的配置只在原有合法边界更新；UI/Agent 同步同一状态，远程 Host 与本地客户端目标区分。
本节是接受的设计，不表示现有后台设置 API 已完成 Agent 接线。
