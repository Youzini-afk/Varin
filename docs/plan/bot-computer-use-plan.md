# Bot 与 Computer Use：剩余交付计划

Status: active residual plan — BC0–BC9 已有生产路径；平台实现与完整运行/分发证据仍有缺口。
Last updated: 2026-10-06

阶段判断与已有证据只在[当前 BC 验收](../reviews/bot-computer-use.md)维护。
本页安排剩余工作，不重新执行已经接通的 Bot 身份、统一记忆、Host 连接、桌面、成果与 guest 配方批次。
[早期交付记录](../archive/bot-computer-use-acceptance.md)保存当时的实现判断。

## 合同与范围

- [Bot 工作台](../design/bot-operated-workbench-design.md)负责长期主体、记忆和工作关系
- [Computer Use](../design/computer-use-design.md)负责真实现场、输入、观看、交接与电脑生命周期
- [可组合执行环境](../design/execution-environment-design.md)负责位置、文件、服务与应用桥；其独立缺口见[EE 验收](../reviews/execution-environments.md#剩余产品缺口与原生验证)
- [办公连续性](../design/office-work-continuity-design.md)仍是 O0–O4 产品工作，不由浏览器或 UNO 桥的存在自动完成

Pi 保留模型/会话权威，Host 负责产品编排、权限与连接，Rust/TDB/原始来源各自保留资源与正文权威。
不增加 Bot 私有运行时、桌面后端或复制任务状态的 Job 表。普通主线、科研与 Bot 复用 attached-root
Thread/Run 生命周期；当前实现见 [agent-root](../../packages/web/application-host/lib/harness/agent-root-runtime.ts)
和 [attached-root](../../packages/web/application-host/lib/harness/attached-root-runtime.ts)。

## 尚须实现

| 工作 | 交付条件 | 所属阶段 |
| --- | --- | --- |
| macOS 稳定原生组件 | 用稳定 bundle/权限身份和实际捕获/输入接口替换现有 JXA/旧捕获路线；明确能力与失败边界 | BC4、BC9 |
| Wayland 持续授权会话 | 正式 RemoteDesktop/ScreenCast 会话固定目标与输入归属；不能用单次 Screenshot portal 冒充同一窗口或持续观看 | BC4、BC5 |
| 发行与升级的未闭合部分 | 对每个支持的平台核对正式产物的组件身份、启动、权限和数据保留；缺少组件与尚未运行分别报告 | BC9 |

共享的环境资源定位、跨机 forward 可达性、Bot scope 取消、可见进程身份与版本化配方，
统一从 EE 验收选择工作；不在 BC 再维护一套相同清单。

## 尚待补充的原生与产品证据

| 场景 | 必须观察到的事实 | 当前限制 |
| --- | --- | --- |
| Bot 长期工作与记忆 | 重开/跨日后正确关联任务；来源可追读；修订、遗忘与迟到整理不会复活旧内容 | BC1–BC3 已有定向证据，真实模型提炼/选材质量与缓存效果未验证 |
| 本机应用与人工交接 | 同一显示/窗口身份、真实输入停止、人工修改后可继续；拖拽与失联状态准确 | Windows 只有有限原生证据；完整 Linux/macOS 图形场景未验收 |
| Linux 持久桌面 | Debian/Ubuntu 准备、Xvnc/systemd、观看和受管输入在真实桌面工作 | 语法、套接字与注入 runtime 测试不代替原生运行 |
| 远端常驻 Host | 前端关闭不终止协调；重新连接回同一任务/桌面；认证 HTTP/WS 与成果读取贯通 | Host 连接路径已有接线，真实 SSH/双机图形与完整 Bot 常驻未验收 |
| 托管 libvirt guest | 创建、镜像/种子校验、NoCloud、Host 注册、观看、操作、恢复与关机后升级真实成功 | 受管配方限 Linux x64 Host + 本地 qemu:///system；构建成功不是 KVM 启动证据 |
| 成果与办公交接 | 登记/下载字节符合固定修订；外部应用变更、编辑器草稿与人工交还关系正确 | 远端大文件与完整办公流程仍待验证；原远端在线是现有成果读取条件 |
| 正式安装/升级 | 安装产物启动真实组件，用户文件、浏览器 profile、Pi 与 Bot 数据保持正确 | 不从源码类型检查或 guest bundle 构建推定全平台安装可用 |

连接已有 VM 与由 Varin 创建/管理 VM 生命周期是两种能力。Hyper-V、macOS 原生虚拟化及全厂商云管理
没有因本计划成为承诺；只有明确需求时沿同一合同扩展。Slurm 等研究后端归[科研设计](../design/research-cluster-design.md)。

## 必须保留的正确性与安全边界

- 接管在执行端阻止旧代次输入；观看不抢控制，失联不自动交回给 Agent
- GUI/远端响应丢失保留 unknown/partial，先观察或查询同一身份，不自动重放副作用
- VM 操作绑定 provider、UUID 与实际卷归属；不能因同名接管或删除用户磁盘
- 记忆正文、来源覆盖、纠正/遗忘和提交回执保持同一权威；未耐久提交不能推进处理完成
- 文件成果保留来源与修订；凭据、cookie、输入正文和敏感内容不进入常规诊断日志
- 平台能力声明以实际组件与结果为准，缺失能力不能伪装为成功空结果

这些是继续工作时的非回归条件，不是另一套实现。当前生产入口在
[ComputerService](../../packages/web/application-host/lib/computer/computer-service.ts)、
[Host 连接](../../packages/web/application-host/lib/connections/ssh-manager.ts)、
[Pi 工具](../../packages/pi-host/src/harness/computer-tools.ts)和[知识模块](../../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)。

## 推进与验收

按可用平台和实际依赖选择一条剩余纵切。新实现要连通协议、Host、实际工具/界面消费者与分发；
复用已有行为测试，不按阶段固定新增测试数量。有关操作需真实机器、付费模型或系统权限时，按实际授权执行。

完成后更新 BC 或 EE 的对应记录：具体 commit/构建、平台、场景、实际结果和未测边界。
只有该场景证据闭合才关闭相应事项；不能用一个网页流程、静态 JXA 检查或模拟 virsh 宣布 BC0–BC9 全部完成。
