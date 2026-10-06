# BC0–BC9 深入验收

Status: current acceptance — BC0–BC9 已有生产路径，平台实现与完整产品验收仍未完成。
Last updated: 2026-10-06

既有审查日期：2026-09-29，基线 `a4aae30d`，修复提交 `107912fa`；后续包括 `4894f7cb` 的 guest 配方。
本次文档核对以 `4b6c604b` 为代码基线，没有重跑下列测试、真机或付费模型。

## 既有证据范围

来源覆盖、后台整理、Host SSH、Linux 桌面、成果交还、guest 配方与平台能力声明均已有后续修复。
阶段表记录现在可以依赖的边界；逐批数字和执行过程见[整理前记录](https://github.com/Youzini-afk/Varin/blob/4b6c604b45bc5adb4582638431cd1af84e1c2773/docs/reviews/bot-computer-use.md)。

- 记忆证据含真实 TDB 重开、分支/来源修订、遗忘、迟到提案与中断恢复，没有真实模型效果或缓存命中证据
- 连接/桌面证据含真实 HTTP/WebSocket/Unix socket、Node REPL 和注入 runtime 行为，没有完整双机图形场景
- `4894f7cb` 的 [Linux CI 构建](https://github.com/Youzini-afk/Varin/actions/runs/36631489354)包含 guest bundle；没有真实 KVM/libvirt 启动或升级证据
- 后续记录的 UI 2,050 项、Web 2,901 项通过及 5 项跳过属于当时回归；Pi 全套没有在所有修复后重跑，不能报告为全套通过

功能存在、定向行为正确和安装后可用分别判断，不能据此接受“BC0–BC9 全部完成”。
[更早验收](../archive/bot-computer-use-acceptance.md)只保存历史判断。

## 分阶段判断

| 阶段 | 当前判断 | 决定性依据与剩余项 |
| --- | --- | --- |
| BC0 Bot | 核心身份与工作路径已接线，关键生命周期错误已修复 | Bot catalog、入口、人格、模型、根任务和工作列表有实际消费者。删除入口后的子任务准入现已保留。真实模型下跨日恢复与完整界面操作未验证。 |
| BC1 统一记忆 | 源码缺口已补，定向验证通过 | 共用 TDB 写入/纠正/遗忘及来源范围；主动与后台共享覆盖，工具与设置均能读取原始片段。 |
| BC2 后台整理 | 源码缺口已补，定向验证通过 | prepared 回执、分段、来源修订、取消和跨分支恢复已接线；主动来源不会再仅凭正文去重。真实模型效果未验证。 |
| BC3 召回与咨询 | 生产路径已接线 | 工作关联、文本/向量、快速判断、增量材料、只读咨询和原始来源追读均有消费者；真实模型选材质量和缓存命中未验证。 |
| BC4 本机 Computer Use | Windows 有有限运行证据；平台合同未完整完成 | 原生观察/输入与持久 REPL 已接线。本次修复脚本代次、截图输出、进程退出等待和跨请求拖拽。Linux/macOS 没有实际图形会话运行证据；Wayland 已移除会误归属窗口的单次 Screenshot portal 自动截图，正式 RemoteDesktop/ScreenCast 会话未实现；macOS 仍为 JXA/旧捕获 API 路线。 |
| BC5 实时桌面与交接 | 媒体和输入分离已实现；原生运行待验证 | 控制交接、代次与重启后的人工归属已有回归。独立 capture helper 消除长动作阻塞；Linux Xvnc/noVNC 走只读 RFB 媒体，输入仍走 Host。真实图形会话尚未运行。 |
| BC6 远端常驻 | 连接和桌面准备路径已接通；远端实测待验证 | 共享 Host 拥有 SSH 生命周期、恢复意图与 Web HTTP/WS 网关；可对已连接 Linux Host 显式准备持久桌面，远端桌面镜像含 VNC 媒体。远端组件部署和完整 Bot 常驻尚未实测。 |
| BC7 虚拟机 | 可用 guest 配方和共享桌面接线已实现，真实运行待验证 | libvirt UUID/卷归属、官方 Debian 镜像核验、NoCloud、guest Host/Xvnc、注册与恢复、关机后运行组件升级均有源码与定向行为验证。当前环境没有真实 KVM/libvirt/guest 图形会话，不能宣称创建出的电脑已经实际可用；托管配方限 Linux x64 本地 libvirt。 |
| BC8 工作台整合 | 工作、桌面、成果与交还已接通；实际办公流程待验 | 电脑操作记录真实 Thread 关系，保留多工作；Bot 工作列表可进关联桌面与下载登记成果。人工交还以耐久事件续接对应 Thread；版本改变阻止旧成果下载。外部应用修改与编辑器草稿的完整办公流程及远端实机仍待验证。 |
| BC9 分发 | Linux x64 guest 构建/升级路径已接线，整体仍未完成 | 驱动随同一 Host generation 原子发布，Linux 发行包构建时加入经散列核验的 guest runtime；用户数据与可替换 runtime 分开。真实 Linux 安装/升级、macOS 稳定 bundle/权限身份及完整安装包操作仍未验证或实现。 |

## 本次直接修复

| 问题 | 基线行为 | 修复与证据 |
| --- | --- | --- |
| Bot 入口删除 | 根任务被归档，现存子任务受到祖先归档限制而无法继续 | `thread-registry.ts` 保留 settled 的 Bot 根身份，清除已删除聊天的报告引用；`thread-admission.acceptance.test.ts` 通过真实 Registry 重新准入子任务。 |
| Bot 损坏记录 | 损坏 profile 可能被当作不存在或从列表消失 | `bot-service.ts` 对已存在的坏记录报错，不以默认 profile 覆盖。 |
| 整理模型继承 | Bot 模型偏好为空时，后台整理没有模型，即使入口已在使用 Pi 默认模型 | Host 读取该 Bot 入口的真实模型选择，冷态从其原生 model-change 历史解析；不借用其他聊天。 |
| 接管竞态 | 等待 release 时仍为 agent owner，新输入能进入队列 | 接管在第一次等待前阻断输入，执行前再次检查 owner/代次；交还失败不会放行自动输入。 |
| 旧脚本恢复 | 接管前的脚本睡眠后可在交还后继续输入 | 新增只读 `computer.control`；REPL 固定目标及 automation epoch，Host 对每次动作校验。未知/部分动作回执让普通脚本序列失败，避免不知情地继续。 |
| REPL 异常挂起 | Node 原生 REPL 把同步异常和 await 拒绝送入 domain，默认 eval 回调不会完成；Agent 一直等待 | 接通该错误路径，并保留异常后的独立新求值；真实 Node worker 回归覆盖同步异常、远端动作未知、错误后继续和截图输出。 |
| 人工归属 | 省略 holderId 可绕过检查；Host 重启默认切回 agent；旧连接关闭可误删新订阅 | 强制匹配持有者，执行时复查可达性和代次，持久保留人工归属，按具体订阅实例退订；断开时清理受管输入并保持人工归属。 |
| 原生进程终止 | kill 发出后即可启动替代 driver，未等旧进程真正退出 | supervisor 追踪 close，替换和 dispose 等待实际退出。 |
| 人工输入界面 | 丢弃画面负坐标原点；Ctrl+C 变成 c；没有 pointer move，拖拽松手可能丢失；切目标短暂沿用旧状态 | 按 frame bounds 缩放，保留组合键，pointer capture + move，HTTP 输入顺序化和代次校验；目标切换重建 pane；增加可用 IME/移动输入的文本入口，失败保留草稿。 |
| Linux/macOS 拖拽 | 每次成功请求后的 release_input 会立刻松开人工按下的鼠标，连观看采集也会结束拖拽 | 成功的人工作用/只读请求保留持有状态，异常、明确释放和 EOF 清理。Linux 常驻循环用注入的 runtime 做了实际请求序列验证；不冒称 Linux 原生输入验证。 |
| 脚本图像与 macOS 目标图 | REPL 只能返回 inspect 文本；macOS 窗口捕获失败可能以整桌图冒充原窗口 | 增加 `computer.emitImage`，输出真实 image block；删除坐标身份错误的整桌图回退，保留失败。 |
| 远端转发 | 未传 abort；坏/丢失响应正文可能算普通失败；双向镜像递归扩张；掉线仍留下 available desktop | 贯通取消，失去有效回执报告 unknown，不重放；拉取仅由目标 Host 拥有的资源，按 Host 身份固定桌面引用，掉线/移除更新桌面状态。 |
| 观看连接 | 在 subscribe 完成前关闭页面会泄漏订阅；远端流结束后本地流悬挂；慢客户端积累旧帧 | 提前登记 close，迟到完成立即退订；远端终止关闭 SSE 以便客户端重连；网络背压期间丢弃过时帧。 |
| VM 磁盘与域归属 | 分配失败直接 vol-delete 同名盘；已有同名域被接管，domblklist 里的盘被当成自身资产 | 在变更前耐久保存随机 UUID；仅恢复同一身份；失败不盲删盘；已确认分配先持久化再 define。未知结果先查询，保留无法证明的状态。 |
| VM 删除与 provider | undefine 成功后磁盘删除失败不能正常重试；provider URI/pool 改动会把旧身份送到新后端 | 删除支持域已经不存在的重试，仅删除匹配创建身份的记录盘；provider 改绑必须先恢复原连接才能操作旧机器；列表不再用旧状态覆盖并发删除。 |
| VM 设置入口 | 通用 settings sanitizer 丢弃 computerVmProviders，保存后无法发现 provider | 接通同一设置读写和校验；测试覆盖保存、格式化响应、真实 configuredVmProviders 消费。 |
| 构建原子性 | 编译完但验证前删除并重拷全局 driver 目录，旧 Host 可遇到缺失或混合版本 | 把 driver 放进 server/private-dev generation，同一次 rename 发布代码与资产；已做真实 Host 构建。 |

## 仍须实现的合同

macOS JXA 路线尚未替代为计划中的稳定 bundle/ScreenCaptureKit 组件；能力声明和权限身份仍需对应平台实现。
Wayland 正式 RemoteDesktop/ScreenCast 会话也未实现，已停止在自动路径使用无法确认目标身份的单次 Screenshot portal。
这些属于实现缺口，不与“缺少机器验证”混列。

## 待补的原生证据

托管 VM 的创建、guest 引导、桌面操作、观看和关机后升级已有产品接线，记录中尚无真实 KVM/libvirt 运行证据。
配方目前要求 Linux x64 Host 与本地 `qemu:///system`；按 BC6 接入已有远端 VM 不等同于托管其生命周期。
Debian/Ubuntu 显式准备、Xvnc/桌面、浏览器、远端 Host 及安装/升级也仍需实际环境验证。
上表 BC1–BC3 已记录补齐共同来源覆盖和原始片段追读，不再把这些旧缺口列为尚未实现。

## 工程判断

保留现有 Pi、Host、TDB、Rust 的职责划分是合适的。Bot 和记忆大体沿既有 owner 扩展，prepared 记录比仅保存模型结果可靠。ComputerService 把 catalog、driver、控制、媒体、remote 和 VM 装配集中在一个大文件，后续补齐远端/VM 时应按这些实际职责拆开，继续由同一 Host 统一授权；不应再增加一套电脑或 Bot 后端。

早期交付报告曾把接线提升为完整阶段交付；后续补齐和当前边界以上表为准。模拟 virsh 或静态 JXA 检查不代表真实平台已通过。

## 验证

本次使用现有定向行为测试、必要回归、TypeScript、真实 Application Host 构建和隔离驱动检查；没有调用付费模型、创建真实 VM、修改用户桌面内容或发布安装包。

- Host：Bot、记忆整理/召回、上下文、computer、线程准入、设置消费者测试。
- Pi：computer 工具、持久 REPL、取消、图像输出、未知回执停止；memory 工具。
- UI：坐标/快捷键映射、上下文面板与 i18n；UI 类型检查。
- 协议与运行时：protocol build、Host 产品/测试类型、Pi 类型、变更文件 lint。
- 分发：真实 `build:application-host:raw`；在临时安装布局中验证构建后的 driver 解析和 Windows ping，再删除本次临时目录。
- 原生：Windows PowerShell 解析与常驻 helper ping；Linux AST 与注入 runtime 的常驻请求循环；macOS JS 语法。

实际结果：Host 综合定向运行 **179 项通过**；后续修改只复验受影响的 computer/Bot/线程准入/settings 范围，**121 项通过**（与前一组重叠，不能相加）。Pi computer/memory **16 项通过**；UI 映射/面板/i18n **23 项通过**；文档工具 **9 项通过**。protocol 构建、Host 产品/测试类型、Pi/UI 类型和变更 TS/TSX lint 通过。真实 Host 构建的发布边界包含 449 个可达运行模块，排除了 52 个旧实现/测试产物；临时安装布局验证了六个驱动文件、代次内路径解析、测试 helper 排除及 Windows ping。

VM 命令及 XML 语义另按 [libvirt virsh](https://libvirt.org/manpages/virsh.html) 与 [Domain XML](https://libvirt.org/formatdomain.html) 核对；这些资料不构成真实 hypervisor 的运行证据。

平台接口判断另核对了 [XDG Screenshot](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html)、[XDG RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)、[XDG ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) 与 [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)。单次截图请求没有长期会话的源身份和持续输入语义；Apple 已将现用的 [CGWindowListCreateImage](https://developer.apple.com/documentation/coregraphics/cgwindowlistcreateimage) 标记为废弃。这些文档支持接口取舍，不等于相应平台实机通过。

真实 Linux/macOS 桌面、真实 libvirt、完整 Host↔Host 图形操作、正式安装包、付费模型效果与服务端缓存命中仍未验证。本报告不将上述空缺计为通过。
