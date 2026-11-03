# 完整桌面性能观察

这是同一已提交源码、同一完整前端、同一 synthetic 数据/config 的 Electron/Tauri A/B 采集入口，不是 release qualification。它不会禁用动画、替换工作台或使用 exporter 作为 Electron 基线。

## 可复跑入口

在匹配架构、有原生显示与固定官方构建工具/CEF SDK的一次性 OS 账户执行。SDK 必须在 checkout 外，避免 checkout clean 删除它。不要使用真实用户 profile、登录或文件。

```sh
node --test packages/tauri/scripts/benchmark-processes.test.mjs packages/tauri/scripts/benchmark.test.mjs packages/tauri/scripts/benchmark-suite.test.mjs
CEF_PATH=/absolute/pinned/cef node packages/tauri/scripts/benchmark-build.mjs --output artifacts/desktop-benchmark-products
VARIN_BENCHMARK_DISPOSABLE_OS_USER=1 node packages/tauri/scripts/benchmark-suite.mjs --pair artifacts/desktop-benchmark-products/pair.json --output artifacts/desktop-benchmark-evidence
```

输出目录必须尚不存在。默认四次交替 A/B 顺序。`--repetitions 1` 仅用于入口诊断。Linux 可显式在 `dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24'` 下运行，并设置 `VARIN_BENCHMARK_VIRTUAL_DISPLAY=1`；这不证明物理跨屏、GPU 合成或输入法。环境字段可用 `VARIN_BENCHMARK_GPU`、`VARIN_BENCHMARK_DISPLAY`、`VARIN_BENCHMARK_POWER_MODE`、`VARIN_BENCHMARK_BACKGROUND_LOAD` 记录实际条件；没有记录的条件明确标为 unreported/uncontrolled。

## 工作负载与证据边界

- Remote idle：真正认证远端 Host 的完整工作台空闲 30 秒。远端服务单独记录进程树，不偷偷计入某一外壳。当前是新 profile、OS cache 未控制，不代证冷/暖启动分组。
- Long chat：真实 Host API 配置受控 SSE provider，Rust owner 完成 40 个历史 turn 后才快照。实际 UI 导航、滚动、输入并发送流式内容，检查终态与 provider 完成回执。不是模型性能；尚不代证图片/纹理释放。
- Workspace transitions：实际菜单切换 Workbench、IDE、Bot，等待提交态及正常动画。产品在 busy 时禁用切换器，当前路径不代证 reverse-in-flight。
- Companion drag：`--manual` 下预留 120 秒原生操作窗口。必须在隔离 profile 内安装完整 pack，执行全部动作、物理跨屏拖动、透明区域穿透。默认明确未执行；没有内置假 sprite 或缺少动作时的替代成功路径。
- Browser interaction：`--manual` 下访问套件提供的同一原生页面，用 synthetic 登录、文件选择上传、下载及原生输入/resize。服务端必须确实收到 login/upload/download；下载实际落盘、内容正确和视口一致仍需原生回执。
- Local/hybrid：`--manual` 下产品启动真正本地 Host，并保留同源远端连接；seed 已通过原 owner 绑定真实 workspace。执行、停止与原进程/Run 的终态需逐项观察。默认明确未执行，不能用远端 seed 完成代证本地任务。
- Repeated lifecycle：五轮 IDE/Workbench 切换、六个 settled checkpoints，记录进程、handles、内存及可用 GPU。尚不代证全部窗口/任务/subscription/texture 无增长。

`--manual` 会在每次场景启动时输出 operator 指令位置。私有 synthetic profile、服务 token 和临时 upload 文件仅在本轮保留，结束后清理；因此指令中的临时路径不是持久交付物。实际手动输入也不自动使 native coverage 合格。

## 失败与清理

源 SHA、runtime inventory、完整 Electron 包 inventory、前端树、fixture 和 workload hash 都必须一致。旧 stage 或 dirty build 不接受。端口/token 在每次恢复 remote snapshot 时必须保持一致。先等 seed Host 真实停止再复制 durable 数据，每轮结束等待服务进程树退出；异常强杀不等于成功退出。若 setup/teardown 报告 `cleanupUncertain`，立即停止后续 A/B，保留该轮私有目录及共享 seed workspace；raw run、comparison 和 suite 标明保留路径，不在进程归属仍未解决时删除数据。

`preflight.json`、每次 raw JSON/JSONL、`comparison.json` 和 `suite.json` 保留缺失/失败/未执行状态。空数据不转换为零成本；CPU/内存缺失、GPU不可用、输入阈值以下无样本、renderer观测缺口均保留 unknown/incomplete。RAF 不是屏幕呈现时间，Event Timing 不是无阈值端到端输入延迟。

正常测量入口完成可以返回 0，但报告始终 `qualification: not-accepted`；启动、seed、原owner执行或退出失败返回非零。任何节省百分比与完整七场景通过结论都需要实际产品运行和额外 native evidence，不能从本文件或 Node harness tests 推断。
