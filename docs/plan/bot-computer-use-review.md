# BC0–BC9 深入验收

Status: current acceptance — BC0–BC9 remain Partial.

日期：2026-09-29。审查基线：`a4aae30d`；验收修复提交 `107912fa`。随后按用户要求继续补齐，进度见下节。

## 后续补齐进度

第一批完成记忆缺口：主动记录与自动整理共享带修订的原始来源范围；主动改写提供原文片段，后台每项提案也必须引用明确片段。遗忘抑制对应证据，其他句子仍可整理。后台按 Pi 全部原生分支的逐片段覆盖恢复，来源修订变化后重新处理，不依赖当前分支游标。Agent 的 `memory get(includeSource)` 和记忆设置的“查看原始片段”读取同一授权来源；原文变化/不可用明确区分。

验证：Host 记忆/来源/catalog/context 定向 **47 项通过**，包括真实 TDB 关闭重开、主动遗忘后的其他句子、分支变化、原文修订、迟到提案和中断恢复；Pi memory **8 项通过**；UI knowledge/i18n **8 项通过**；protocol 构建、Host 产品/测试类型、Pi/UI 类型及变更文件 lint 通过。此批没有调用真实模型，不能据此判断提炼质量或缓存命中。电脑、远端、VM 与分发继续进行。

第二批把 SSH 生命周期和连接设置移入共享 Host，Electron 只保留调用与原生事件适配。Web 设置接同一 Host 路由；实际 HTTP/WebSocket 网关让浏览器使用服务器侧 SSH 隧道，局部凭据不转交远端，运行时 URL 保留连接路径。已加入 Host 启动恢复连接意图、断开/关闭时阻断迟到启动，以及切换 Host 后的界面归属清理。Host 连接测试 **10 项通过**（含真实 HTTP/WebSocket 端口），UI 运行时/事件 **9 项通过**，Host/UI/Electron 类型与 lint 通过。真实 SSH/Linux 桌面尚未运行。

第三批接入显式 Linux 桌面准备：Debian/Ubuntu 的安装脚本配置原生包与 Firefox ESR，systemd 管理独立用户的 Xvnc/xfce4/浏览器及持久 profile。RFB 只走私有 Unix socket，并在 Xvnc 禁用键鼠与剪贴板输入；Host 以认证 WebSocket 桥接 noVNC 观看，人工输入继续走控制归属和代次检查。观看采集与动作各有原生 helper，长动作不再阻塞画面；断开观看会释放该观看者持有的拖拽。Host computer 定向 **58 项通过**，Pi computer **8 项通过**，真实 WebSocket/本地套接字往返、Host 构建、类型检查、Python 语法与 shell 语法通过。当前 Windows 环境没有 Linux 图形会话，Xvnc/systemd/安装仍需实机验证；普通用户准备需要 root 或非交互 sudo 权限。

**结论：不能接受“BC0–BC9 全部完成”。** Bot、记忆、Computer Use、桌面视图、远端转发与 libvirt 的生产路径确实存在；但基线有控制交接、磁盘归属、配置保存、入口生命周期等实际错误，且 BC6–BC9 的若干交付条件根本尚未实现。功能存在、行为正确和安装后可用是不同证据。下文是本次验收结论；[旧验收记录](bot-computer-use-acceptance.md)保留历史，不覆盖本报告。

## 分阶段判断

| 阶段 | 当前判断 | 决定性依据与剩余项 |
| --- | --- | --- |
| BC0 Bot | 核心身份与工作路径已接线，关键生命周期错误已修复 | Bot catalog、入口、人格、模型、根任务和工作列表有实际消费者。删除入口后的子任务准入现已保留。真实模型下跨日恢复与完整界面操作未验证。 |
| BC1 统一记忆 | 源码缺口已补，定向验证通过 | 共用 TDB 写入/纠正/遗忘及来源范围；主动与后台共享覆盖，工具与设置均能读取原始片段。 |
| BC2 后台整理 | 源码缺口已补，定向验证通过 | prepared 回执、分段、来源修订、取消和跨分支恢复已接线；主动来源不会再仅凭正文去重。真实模型效果未验证。 |
| BC3 召回与咨询 | 生产路径已接线 | 工作关联、文本/向量、快速判断、增量材料、只读咨询和原始来源追读均有消费者；真实模型选材质量和缓存命中未验证。 |
| BC4 本机 Computer Use | Windows 有有限运行证据；平台合同未完整完成 | 原生观察/输入与持久 REPL 已接线。本次修复脚本代次、截图输出、进程退出等待和跨请求拖拽。Linux/macOS 没有实际图形会话运行证据；Wayland 只实现 Screenshot portal 路径，未实现正式 RemoteDesktop 输入会话；macOS 仍为 JXA/旧捕获 API 路线。 |
| BC5 实时桌面与交接 | 媒体和输入分离已实现；原生运行待验证 | 控制交接、代次与重启后的人工归属已有回归。独立 capture helper 消除长动作阻塞；Linux Xvnc/noVNC 走只读 RFB 媒体，输入仍走 Host。真实图形会话尚未运行。 |
| BC6 远端常驻 | 连接和桌面准备路径已接通；远端实测待验证 | 共享 Host 拥有 SSH 生命周期、恢复意图与 Web HTTP/WS 网关；可对已连接 Linux Host 显式准备持久桌面，远端桌面镜像含 VNC 媒体。远端组件部署和完整 Bot 常驻尚未实测。 |
| BC7 虚拟机 | 生命周期子集已实现，创建可用电脑的合同未完成 | libvirt 真实 CLI 路径存在；本次修复了已有盘误删、按名字接管外部域、固定 UUID、分步回执、删除重试、provider 改绑与设置保存。创建仍只定义机器/磁盘；guest OS、桌面、浏览器、Host 安装、注册与自动进入共享桌面的流程尚未实现。 |
| BC8 工作台整合 | 部分完成 | 已有共享桌面页签、Settings 入口、默认目标和最近会话链接。本次修复坐标、快捷键、拖拽、文本输入和切换目标后的旧画面。`desktop.usage` 仅是最近会话投影，尚不等于工作—电脑—成果闭环；远端成果引用/取得、人工交还事件对执行续接的集成仍不完整。 |
| BC9 分发 | 资产构建路径已修复，整体未完成 | 驱动已改为随同一 Host generation 原子发布，编译产物可独立于 checkout 解析。原生依赖安装、Linux 桌面组件、macOS bundle/权限身份及完整安装包操作验证仍未交付或未验证。复制几份脚本不能代表这些部分已完成。 |

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

这些是源码中的功能缺口，不是因缺少真机而暂缓作结论：

5. **创建到可用 VM 桌面。** libvirt define/start 与 guest 系统、桌面、Host 引导/注册之间缺少产品实现。手工 baseImage 配方不能算自动准备；provider 不可用时只能如实报错。
6. **工作、成果和交还续接。** 最近 session 指针不能表达多工作关联、远端成果版本和可用回执；控制交还目前也没有完整接入已有工作事件/继续执行通路。
7. **正式平台组件。** Debian/Ubuntu 的显式准备已提供 Python/GI/AT-SPI/Gdk、Xvnc、xfce4 与浏览器安装路径，仍需 Linux 实机运行及其他发行版选择。macOS JXA 不等同于计划中的稳定 bundle/ScreenCaptureKit 组件，能力声明和权限检查还需实际平台实现与运行验证；Wayland 正式输入会话也未实现。

## 工程判断

保留现有 Pi、Host、TDB、Rust 的职责划分是合适的。Bot 和记忆大体沿既有 owner 扩展，prepared 记录比仅保存模型结果可靠。ComputerService 把 catalog、driver、控制、媒体、remote 和 VM 装配集中在一个大文件，后续补齐远端/VM 时应按这些实际职责拆开，继续由同一 Host 统一授权；不应再增加一套电脑或 Bot 后端。

目前的完成报告把“文件存在/函数已接线”提升成了完整阶段交付，尤其掩盖了 BC6–BC9 的缺失消费者。应按上表验收，不沿旧标题宣布完成，也不把模拟 virsh 或静态 JXA 检查解释为真实平台通过。

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

真实 Linux/macOS 桌面、真实 libvirt、完整 Host↔Host 图形操作、正式安装包、付费模型效果与服务端缓存命中仍未验证。本报告不将上述空缺计为通过。
