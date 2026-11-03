# 完整桌面性能观察

这是同一已提交源码、同一完整前端、同一 synthetic 数据/config 的 Electron/Tauri A/B 采集入口，不是 release qualification。它不会禁用动画、替换工作台或使用 exporter 作为 Electron 基线。

## 可复跑入口

在匹配架构、有原生显示与固定官方构建工具/CEF SDK的一次性 OS 账户执行。SDK 必须在 checkout 外，避免 checkout clean 删除它。不要使用真实用户 profile、登录或文件。

```sh
node --test packages/tauri/scripts/benchmark-processes.test.mjs packages/tauri/scripts/benchmark.test.mjs packages/tauri/scripts/benchmark-suite.test.mjs
CEF_PATH=/absolute/pinned/cef node packages/tauri/scripts/benchmark-build.mjs --output artifacts/desktop-benchmark-products
VARIN_BENCHMARK_DISPOSABLE_OS_USER=1 node packages/tauri/scripts/benchmark-suite.mjs --pair artifacts/desktop-benchmark-products/pair.json --output artifacts/desktop-benchmark-evidence
```

现有 CI 已产生同 SHA、同 target 的完整 Tauri candidate 时，可避免再次编译 Tauri，只构建并验证完整 Electron 基线：

```sh
node packages/tauri/scripts/benchmark-build.mjs --candidate /absolute/native-candidate/candidate.json --output artifacts/desktop-benchmark-products
```

这条路径仍检查 runtime、native inventory、原 update archive 与前端字节一致性；不接受旧 SHA、dirty runtime 或被改动的 candidate。

输出目录必须尚不存在。默认四次交替 A/B 顺序。`--repetitions 1` 仅用于入口诊断。Linux 可显式在 `dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24'` 下运行，并设置 `VARIN_BENCHMARK_VIRTUAL_DISPLAY=1`；这不证明物理跨屏、GPU 合成或输入法。环境字段可用 `VARIN_BENCHMARK_GPU`、`VARIN_BENCHMARK_DISPLAY`、`VARIN_BENCHMARK_POWER_MODE`、`VARIN_BENCHMARK_BACKGROUND_LOAD` 记录实际条件；没有记录的条件明确标为 unreported/uncontrolled。

## 工作负载与证据边界

- Remote idle：真正认证远端 Host 的完整工作台空闲 30 秒。远端服务单独记录进程树，不偷偷计入某一外壳。当前是新 profile、OS cache 未控制，不代证冷/暖启动分组。
- Long chat：真实 Host API 配置受控 SSE provider，Rust owner 完成 40 个历史 turn 后才快照。实际 UI 导航、滚动、输入并发送流式内容，检查终态与 provider 完成回执。不是模型性能；尚不代证图片/纹理释放。
- Workspace transitions：实际菜单切换 Workbench、IDE、Bot，等待提交态及正常动画。产品在 busy 时禁用切换器，当前路径不代证 reverse-in-flight。
- Companion drag：`--manual` 下预留 120 秒原生操作窗口。仓库目前只带preview与lock，没有完整atlas；lock指向 `Youzini-afk/Varin-companion-assets` 的 `ebfbcd3383b120b4427ce7820e5eda21e63e6b60`、`pack/varin`，45项约121 MB。实际完整资产、许可核验及安装仍需完成，不能用preview代替。必须在隔离 profile 内安装完整 pack，执行全部动作、物理跨屏拖动、透明区域穿透。默认明确未执行；没有内置假 sprite 或缺少动作时的替代成功路径。
- Browser interaction：自动从真实工作台展开 rail、打开原生 Browser pane、地址栏导航；私有 driver 只驱动匹配 fixture URL 的同一个原生页面。真实 synthetic 登录、Chromium 文件选择自动化、上传、滚动与下载均保留原 owner。主页面只读 Browser owner 的 completed download，再读取原落盘文件字节并核验 SHA-256。服务端上传 hash、login/download 回执另行检查。DOM.setFileInputFiles 仅指定本轮固定 synthetic 文件，是 Browser automation 路径，不证明 OS chooser、物理输入或 resize/display 对齐。
- Local/hybrid：自动从真实 Host switcher 打开同源远端新窗口。两边均用原 composer 提交：本地完成一个有界 CPU 任务，再通过原 process card Stop 取消长任务；远端完成一条 SSE 对话，再用 composer Stop 取消另一条。只读原 owner 的 Run/operation/process 回执，要求实际 writerActive=false 与原 job terminal/cancelled，不能把取消意图当停止。两个窗口分别保留输入与renderer观察；受控 provider 还须确认正常完成和被取消的原 SSE 请求。
- Repeated lifecycle：五轮 IDE/Workbench 切换、六个 settled checkpoints，记录进程、handles、内存及可用 GPU。尚不代证全部窗口/任务/subscription/texture 无增长。

`--manual` 仅把仍需完整pack与物理跨屏证据的 Companion 场景加入执行；默认六个自动化场景并明确未执行 Companion。它会在手动场景启动时输出 operator 指令位置。私有 synthetic profile、服务 token 和临时 upload 文件仅在本轮保留，结束后清理；因此指令中的临时路径不是持久交付物。实际手动输入也不自动使 native coverage 合格。

## 失败与清理

源 SHA、runtime inventory、完整 Electron 包 inventory、前端树、fixture 和 workload hash 都必须一致。旧 stage 或 dirty build 不接受。端口/token 在每次恢复 remote snapshot 时必须保持一致。先等 seed Host 真实停止再复制 durable 数据，每轮结束等待服务进程树退出；异常强杀不等于成功退出。若 setup/teardown 报告 `cleanupUncertain`，立即停止后续 A/B，保留该轮私有目录及共享 seed workspace；raw run、comparison 和 suite 标明保留路径，不在进程归属仍未解决时删除数据。

`preflight.json`、每次 raw JSON/JSONL、`comparison.json` 和 `suite.json` 保留缺失/失败/未执行状态。空数据不转换为零成本；CPU/内存缺失、GPU不可用、输入阈值以下无样本、renderer观测缺口均保留 unknown/incomplete。采样与只读owner观测的开销包含在两边测量中；尚未单独校准其成本。原始target identity保留，汇总按main-workbench、remote-workbench、native-browser区分角色。RAF 不是屏幕呈现时间，Event Timing 不是无阈值端到端输入延迟。

正常测量入口完成可以返回 0，但报告始终 `qualification: not-accepted`；启动、seed、原owner执行或退出失败返回非零。任何节省百分比与完整七场景通过结论都需要实际产品运行和额外 native evidence，不能从本文件或 Node harness tests 推断。
