# 可组合执行环境：当前实现与验收边界

Status: current acceptance map — EE1–EE6 有生产路径；任意部署组合和完整原生应用场景尚未验收。
Last updated: 2026-10-06

代码复核基线：`4b6c604b`。既有独立验收记录于 2026-10-01；本次只重新核对文档与源码，
没有新增 Linux 桌面、Chromium/UNO、apt、跨机或 guest VM 运行证据。
[环境设计](../design/execution-environment-design.md)负责合同，[BC 验收](bot-computer-use.md)负责共享平台边界。

## 当前实现

| 范围 | 生产路径与已保留的行为 | 边界 |
| --- | --- | --- |
| EE1 环境绑定 | Thread catalog 持久化 workTarget/desktopId；子 Thread 按字段继承；environment.get/set 校验真实目标；后续受理操作才使用新位置 | 不迁移已受理操作或已有资源 |
| 普通主线 | agent-root-runtime 已在 agent_start 将普通会话接入同一 Thread/Run；computer 的 environment 动作调用同一 get/set | 不再由“仅 Thread 可 set”推断普通活动主线不能配置；完整根会话环境纵切未运行，独立 UI 选择入口仍未找到 |
| EE2 打开与文件传递 | open 在目标 Host 解析 URL/路径；受管 Linux 桌面 fileWrite 原子写入 home，返回 hash/字节数/修订 | 单次复制，不是持续同步；写入没有版本前置条件；unknown 不自动重放 |
| EE3 服务访问 | environment.forward 在协调 Host 建 loopback listener，经认证 Host↔Host WebSocket 桥接目标服务；查询/关闭按调用 session 隔离 | 返回地址只在协调机有效；live handle 不持久化 |
| EE3 事件续接 | desktop/artifact follow-up 复用现有 source、occurrence、Thread 投递与恢复；源 revision 处理重复变化和 ABA | 真实桌面变化到 Bot 续行的原生场景未验证 |
| EE4 软件配方 | desktop/dev/docs/data 组件清单、受管 Linux 安装入口与耐久 software 状态；apt 请求排队，bootstrap 状态可导入 | 安装状态独立于机器能力；真实 apt/cloud-init 未验证；不是版本化镜像模板 |
| EE5 浏览器 | 受管 Linux Chromium + 持久 profile；标准库 CDP 桥支持 tabs、层级 AX snapshot 与导航/输入/截图；跟随同一 lane 和控制代次 | Page.navigate 回执不保证加载完成；点击仍需坐标；Windows/macOS 无对应桥 |
| EE5 办公 | 同用户命名 pipe 连接实际 LibreOffice profile；RuntimeUID 定位活文档，modified 为事实字段；Writer/Calc 读写、另存与 PDF 导出有入口 | 无 UNO 或无法附着如实 unavailable；真实应用语义与可见进程身份未验收 |
| EE6 证据 | Rust cursor + 不可变 step 记录并发序号、分页、重启续写与 outcome；远端日志由拥有 Host 写入，协调端查询转发 | 仅元数据与 observation id；不提供完整画面轨迹、重演或自动恢复 |

### 生产定位

- [环境服务](../../packages/web/application-host/lib/harness/environment-services.ts)、[forward](../../packages/web/application-host/lib/harness/environment-forwards.ts)和[协议](../../packages/protocol/src/harness.ts)
- [普通根生命周期](../../packages/web/application-host/lib/harness/agent-root-runtime.ts)、[事件准入](../../packages/web/application-host/lib/harness/attached-root-runtime.ts)、[Host 装配](../../packages/web/application-host/index.ts)
- [ComputerService](../../packages/web/application-host/lib/computer/computer-service.ts)与[Pi computer 工具](../../packages/pi-host/src/harness/computer-tools.ts)
- [Linux runtime](../../packages/computer-driver/linux/runtime.py)、[浏览器桥](../../packages/computer-driver/linux/browser_bridge.py)、[办公桥](../../packages/computer-driver/linux/office_bridge.py)

普通根接入来自 `c152a1e7`，晚于原 EE 独立验收。`environment.set` 仍拒绝真正没有 Thread owner 的会话；
这条拒绝测试只覆盖无绑定情形，不足以证明普通活动根会话没有工具入口。
本次源码检查没有找到 UI 对 workTarget/environment.set 的直接消费者，也没有执行普通根到环境服务的完整验收。

## 剩余产品缺口与原生验证

### 功能与接口缺口

- 环境选择的独立 UI、idle/未附着会话行为及普通主线完整流程需要按新根生命周期核对；
  不重新实施已有 agent-root 或工具 get/set
- workTarget 主要消费于 shell/process；文件读写、搜索等尚未统一按环境资源定位
- forward 的协调机 loopback 地址尚不能直接供另一台操作电脑访问
- 共享桌面不能以整条 lane 取消代替 Bot scope；精确取消已受理远端 GUI/安装操作仍需协议与准入
- 显式 CDP port/profile 与默认 UNO profile 尚无完整的“当前可见桌面中那个进程”原生身份核验
- EE6 未把动作前后画面和应用状态随步骤持久关联；现有记忆入口不等于自动诊断或可靠重演
- 默认软件配方尚无完整版本、能力声明与升级迁移合同

### 尚待取得的原生证据

- Linux：Xvnc/systemd 准备、真实 apt 安装、Chromium 持久 profile/下载可见性、UNO 活实例与未保存状态
- 双机：Host↔Host forward 字节桥、远端桌面的浏览器/办公/证据操作，以及另一操作机实际可达性
- VM：NoCloud 种子、guest Host 注册、持久桌面与升级的完整链路
- 生命周期：Bot 休眠/唤醒、HTTP 断开、取消与进程退出在真实浏览器/办公/安装中的效果；副作用结果不明时保持 unknown/partial
- Windows/macOS 的浏览器/办公桥与本地 VM 后端没有由 Linux 组件获得支持；按实际产品范围另行设计或验证

缺少原生证据与尚未实现的产品合同分别关闭，不用定向测试通过替换任一类。

## 既有独立验收证据（2026-10-01）

以下是当时记录，未在本次重跑；测试组有交集，不相加为新的总数。

| 范围 | 当时观察到的结果 | 不支持的外推 |
| --- | --- | --- |
| 目标准入与 forward | 环境/转发/Router/Host 50 项、Thread 58 项、Pi 权限 9 项通过；含真实 TCP listener 的 session 隔离、关闭与迟到准入 | 未做真实跨机或 VM |
| 发布与配方 | 发布目录独立加载浏览器/办公模块；组件与 computer service 65 项、假 CDP 往返通过；包名按 Debian trixie 清单核对 | 未运行 apt、systemd/Xvnc 或真实 Chromium |
| 取消与证据持久化 | 真实 Rust kernel 26 项及 evidence 接受测试 1 项通过；并发、分页、重启续写和敏感字段得到覆盖 | 假 fetch 的远端转发不证明双机行为 |
| follow-up 与驱动 | Node runner 下真核 follow-up 53 项通过；Python 假 CDP、独立导入、人工手势模拟通过 | 模拟手势不证明原生输入；未运行真实 UNO |

这些验收修复保留了以下不变量：

- 准入前固定操作目标；环境读取失败阻止依赖操作，取消/关闭代次阻止迟到 listener 重新开口
- 只读浏览器/办公操作不释放人工持有的键鼠；写动作受控制 owner/epoch 约束
- 文件写入和安装只有子进程实际退出后确认取消；浏览器/办公 helper 取消不虚构应用回滚
- evidence 只保存固定操作词、目标摘要、身份与结果；不保存键入文本、JS、单元格、文件字节、凭据或任意异常正文
- 日志写入失败不翻转已经发生的动作结果；预留序号空洞不伪造操作
- 远端保留原 session 标识，日志与动作归拥有 Host，避免协调端双写或冒名

原批次说明中的 AX 扁平化限制、办公不能另存、未接入 Rust recordType 等描述已被上述修复替代，
不再列为当前缺口。需要逐批追踪时，使用[整理前记录](https://github.com/Youzini-afk/Varin/blob/4b6c604b45bc5adb4582638431cd1af84e1c2773/docs/reviews/execution-environments.md)
及其对应提交；不另复制一份交付流水账。
