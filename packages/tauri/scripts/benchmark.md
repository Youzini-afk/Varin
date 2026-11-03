# 完整桌面性能观察

这是同一已提交源码、同一完整前端、同一 synthetic 数据/config 的 Electron/Tauri A/B 采集入口，不是 release qualification。它不会禁用动画、替换工作台或使用 exporter 作为 Electron 基线。

## 可复跑入口

在匹配架构、有原生显示与固定官方构建工具/CEF SDK的一次性 OS 账户执行。SDK 必须在 checkout 外，避免 checkout clean 删除它。不要使用真实用户 profile、登录或文件。

```sh
node --test packages/tauri/scripts/benchmark*.test.mjs
CEF_PATH=/absolute/pinned/cef node packages/tauri/scripts/benchmark-build.mjs --output artifacts/desktop-benchmark-products
VARIN_BENCHMARK_DISPOSABLE_OS_USER=1 node packages/tauri/scripts/benchmark-suite.mjs --pair artifacts/desktop-benchmark-products/pair.json --output artifacts/desktop-benchmark-evidence
```

现有 CI 已产生同 SHA、同 target 的完整 Tauri candidate 时，可避免再次编译 Tauri，只构建并验证完整 Electron 基线：

```sh
node packages/tauri/scripts/benchmark-build.mjs --candidate /absolute/native-candidate/candidate.json --output artifacts/desktop-benchmark-products
```

这条路径仍检查 runtime、native inventory、原 update archive 与前端字节一致性；不接受旧 SHA、dirty runtime 或被改动的 candidate。

输出目录必须尚不存在。默认四次交替 A/B 顺序。`--repetitions 1` 仅用于入口诊断。Linux 可显式在 `dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24'` 下运行，并设置 `VARIN_BENCHMARK_VIRTUAL_DISPLAY=1`；这不证明物理跨屏、GPU 合成或输入法。环境字段可用 `VARIN_BENCHMARK_GPU`、`VARIN_BENCHMARK_DISPLAY`、`VARIN_BENCHMARK_POWER_MODE`、`VARIN_BENCHMARK_BACKGROUND_LOAD` 记录实际条件；没有记录的条件明确标为 unreported/uncontrolled。

未打包成 AppImage 的采集入口拒绝继承 `APPIMAGE` 或 `CHROME_DEVEL_SANDBOX`，包括空值；不会替调用者更改沙箱或配置 root/SUID。Linux/Windows 在测量时钟开始前构建独立 native process owner，再通过它启动产品；只有本轮原 OS 作用域确认耗尽后才能释放私有目录并继续 A/B。macOS 尚无同等 owner，preflight 会在启动前 blocked。以下七类是已实现的工作负载，不是已通过的完整产品性能结论。

## 工作负载与证据边界

- Remote idle：真正认证远端 Host 的完整工作台空闲 30 秒。远端服务单独记录进程树，不偷偷计入某一外壳。当前是新 profile、OS cache 未控制，不代证冷/暖启动分组。
- Long chat：真实 Host API 配置受控 SSE provider，Rust owner 完成 40 个历史 turn 后才快照。实际 UI 导航、滚动、输入并发送流式内容，检查原 Thread Run 终态、UI 内容与 provider 完成回执。不是模型性能；尚不代证图片/纹理释放。
- Workspace transitions：实际菜单切换 Workbench、IDE、Bot，等待提交态及正常动画。产品在 busy 时禁用切换器，当前路径不代证 reverse-in-flight。
- Companion drag：Linux X11 自动通过真实 Settings → Desktop companion → Download → 必要时 Use → Wake。每轮在私有 profile 从既有固定源下载完整45文件121,431,042字节，通过原 assets owner 安装，再验证 installedVersion、固定源与全部文件 SHA-256。保留30秒正常播放；系统光标经 xdotool 实际 hover/tap/repeat/drag-release，要求命中唯一同进程树、同几何窗口，验证真实bounds移动及释放后稳定，然后 Sleep 并观察原surface消失。原生产 decoder/painter 的只读 ledger 分别记录启用后成功解码、成功绘制、释放数与正常路径 notCovered；静态姿势的 readiness 使用原 painter 保留的最后成功绘制回执，不重播动作，也不把启用前的绘制补入观察计数。独立 asset diagnostic 对同一固定bundle的550 packages/1284 frames及43张PNG进行解码、离屏draw/readback与释放，不更改正常播放器动作或计时。该诊断不等于550条正常Host动作路径，也不计入正常性能窗口。物理跨屏、透明GPU合成与OS点击穿透仍未验收。
- Browser interaction：自动从真实工作台展开 rail、打开原生 Browser pane、地址栏导航；私有 driver 只驱动匹配 fixture URL 的同一个原生页面。真实 synthetic 登录、Chromium 文件选择自动化、上传、滚动与下载均保留原 owner。主页面只读 Browser owner 的 completed download，再读取原落盘文件字节并核验 SHA-256。服务端上传 hash、login/download 回执另行检查。DOM.setFileInputFiles 仅指定本轮固定 synthetic 文件，是 Browser automation 路径，不证明 OS chooser、物理输入或 resize/display 对齐。
- Local/hybrid：自动从真实 Host switcher 打开同源远端新窗口。两边均用原 composer 提交：本地完成一个有界 CPU 任务，再通过原 process card Stop 取消长任务；远端完成一条 SSE 对话，再用 composer Stop 取消另一条。只读原 owner 的 Run/operation/process 回执，要求实际 writerActive=false 与原 job terminal/cancelled，不能把取消意图当停止。两个窗口分别保留输入与renderer观察；受控 provider 还须确认正常完成和被取消的原 SSE 请求。
- Repeated lifecycle：五轮 IDE/Workbench 切换及真实 Settings modal 开关、六个 settled checkpoints，记录进程、handles、内存及可用 GPU。尚不代证全部窗口/任务/subscription/texture 无增长。

计划包含七个自动化场景，实际执行受下面的原进程清理证明约束。桌宠场景需要独立 Linux X11 display、`xdotool` 和 `openbox`（官方 apt 包）；suite 启动自己的 `openbox --sm-disable`，记录版本/pid并在结束时只停止自己的子进程，不替换已有WM。不可用时明确标记第七类 blocked，其余六类仍可选择。`--manual` 为兼容参数，不把物理验收改为自动通过。

锁定素材来源为 `Youzini-afk/Varin-companion-assets` 提交 `ebfbcd3383b120b4427ce7820e5eda21e63e6b60` 的 `pack/varin/`。来源README说明角色/插画许可尚未确定，不能声称代码AGPL覆盖图片。这里仅测试现有产品下载到一次性私有profile，不把素材加入源码、安装包或上传artifact。只输出数值、动作/文件身份、coverage与缺失状态，不输出PNG、canvas像素或profile。数据、服务token、下载资源与诊断canvas由本轮隔离owner管理；未确认终止时保留私有数据，不把不确定的清理记为完成。

重复运行会重复真实下载，网络和安装窗口单独标记；只有实际已绘制后的正常 idle 与系统指针输入窗口参与该场景的 CPU/内存与 renderer 汇总；两种阶段保留独立标签，合并值不称为纯 idle 成本。文件校验、下载与独立素材诊断均排除。累计 CPU 仅在相邻有效采样之间相减，不跨排除区间；renderer 仅采用采集器实际读到的对应序列，并排除阶段边界，未采到的记录不补作有效帧。独立诊断停止会等待未完成解码、释放 bitmap 后返回。原始记录保留对应阶段，且全部normal动作覆盖尚未完成。

## 失败与清理

源 SHA、runtime inventory、完整 Electron 包 inventory、前端树、fixture 和 workload hash 都必须一致。旧 stage 或 dirty build 不接受。端口/token 在每次恢复 remote snapshot 时必须保持一致。先等 seed Host 的原 `stop()` 完成并观察直接子进程退出，再复制 durable 数据；这个 fixture owner 合同不代证完整 GUI/CEF 作用域。

`observedCounterScopeEmpty` 只表示一次采样未找到仍活动的已观察进程，不能证明 `ownershipDrainConfirmed`：子进程可能在两次采样间创建并脱离原父进程。Electron 的 benchmark receipt 写在正常退出前；Tauri 的 `nativeDrain` 覆盖受管 Host 与原生窗口 owner，但写在最终 CEF shutdown 前。两者都不是完整 Chromium 外部进程的终止回执。独立 owner 在启动门打开之前绑定根进程的 OS birth identity，collector 只接受相同身份，不能把立即退出后的复用 PID 当成本轮根进程。Linux 使用本轮 sole-reaper/subreaper 的 kernel ECHILD，Windows 使用从挂起启动时即加入并保留的原 Job Object；只有原私有协议流的完整终态和 guardian 正常结束才能设置 `ownershipDrainConfirmed=true`。作用域证明、根进程退出、产品 receipt、renderer 与资源覆盖分别记录；即使作用域已干净退出，缺失的产品测量仍是 incomplete。

观察失败或 deadline 到期时，仅通过原 owner 的私有控制通道请求停止，不按数值 PID/PGID 调用 kill 或 taskkill。Linux 的信号目标是经过 kernel child 关系确认的原 pidfd；Windows 是保留的原 Job。强制停止后确实耗尽的作用域允许释放该轮副本，但始终把工作负载记为 failed，绝不转成成功样本。admission 未确认、guardian 丢失、控制失败或作用域证明缺失都报告 `cleanupUncertain`，保留私有目录及共享 seed workspace 并停止后续 A/B。产品 stdout/stderr 不进入 owner 协议或报告；未解决的 guardian 不以 stdio 引用阻止控制器报告失败。

raw run、comparison 和 suite 保留可用的根进程退出事实、采样观察与独立 OS 归属证明。报告写入失败也保留私有副本，并向外传播停止/保留义务，即使 OS 已确认耗尽。源 fixture 永远不由每轮清理删除；fixture 服务仍由自己的原 stop owner 负责，桌面 scope 不能代替服务终止回执。

`preflight.json`、每次 raw JSON/JSONL、`comparison.json` 和 `suite.json` 保留缺失/失败/未执行状态。空数据不转换为零成本；CPU/内存缺失、GPU不可用、输入阈值以下无样本、renderer观测缺口均保留 unknown/incomplete。采样与只读owner观测的开销包含在两边测量中；尚未单独校准其成本。原始target identity保留，汇总按main-workbench、remote-workbench、native-browser区分角色。RAF 不是屏幕呈现时间，Event Timing 不是无阈值端到端输入延迟。

损坏的私有 JSON 只报告 `invalid-json`，其他异常仅输出固定类别或允许的系统错误码，不保存任意异常文本、解析器原文、env、argv 或 token。owner receipt 另有严格字段、顺序与本轮 nonce 校验，公开摘要不复制其原始 reason。renderer JSONL 与 receipt 在校验原字节后才写入报告，不能先复制未经校验的内容再报错。

报告始终 `qualification: not-accepted`。只有执行与清理均无未解决失败的 suite 才能返回 0；任何强制停止或未确认的归属都不能成为通过的工作负载。启动、seed、原owner执行或退出失败也返回非零。任何节省百分比与完整七场景通过结论都需要实际产品运行和额外 native evidence，不能从本文件或 Node harness tests 推断。
