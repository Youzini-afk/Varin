# Varin 状态与交互演示

- `varin-upright-showcase.mp4`：116 秒连续状态与模拟交互展示，1280×720，24 fps，无音乐与配音。
- `varin-upright-overview.jpg`：六类状态简洁总览。
- 不是桌面录屏；所有任务、答复、授权和指针动作是演示输入，不表示真实任务执行或用户批准。

## 复现与证据

`render-showcase.mjs` 直接导入仓库生产 `CompanionPlayback`，用最小 DOM/EventTarget 与受控 RAF 运行同源 `sceneRenderer`，不另造动画时间规则。人物只从选定 bundle 的真实 atlas 裁切；按实际曝光的 cue 联动周边矢量图层，不生成、补画或插值人物帧。384px 角色。模拟指针路径只是窗口平移，world plate 的冻结位置、100ms 淡出/淡入与 clear 按实际播放器 worldEvent 实现。

`scene-renderer.mjs` 与 `scene-cues.mjs` 是当前仓库 TypeScript 源离线编译，不是另一套手画场景。

在本目录执行：`node render-showcase.mjs --repo /path/to/varin-repository`，然后 `python finish-delivery.py`。归档位于仓库既定目录时可省略 `--repo`，默认自动定位仓库根目录。需要仓库已有 sharp/esbuild、Node、Python Pillow、ffmpeg/ffprobe 与 Noto Sans CJK 字体；不安装新软件。编码为单线程，帧通过 stdin 流入 ffmpeg，不堆积临时帧。`--trace-only` 只验证真实播放器状态与时间线。

`showcase-timeline.json` 含每一显示采样时刻的真实曝光 SHA、package、cue、位置、world 事件、模拟输入，以及 bundle、world plate 和实际执行源码的 SHA。`delivery-verification.json` 记录成片规格、全片解码、覆盖及 SHA。PNG/JPG 抽样仅作内部画面校验，不作为“六张海报”替代连续成片。

审核边界：此视频验证离线连续艺术表现，不宣称验证真实 Host 执行、OS 点击穿透或桌面置顶行为；原生验收由另行实际构建与运行记录证明。

从仓库源码重新构建两个场景模块（使用仓库已有 esbuild，不安装软件）：

```sh
REPO=/path/to/varin-repository
ESBUILD=$REPO/node_modules/.bun/esbuild@0.28.2/node_modules/esbuild/bin/esbuild
node "$ESBUILD" "$REPO/packages/ui/src/components/companion/sceneRenderer.ts" --bundle --format=esm --outfile=scene-renderer.mjs
node "$ESBUILD" "$REPO/packages/ui/src/components/companion/sceneCues.ts" --bundle --format=esm --outfile=scene-cues.mjs
```

## 原生观察与离线演示的界限

父级在同一选定 bundle 上已实际观察六类原生场景、边缘重排、点击穿透、置顶与关闭。原辅助加载提示的旧日志未保留原因；工程已修正装饰凳的image-ready显示门槛及主动关闭日志识别，并在09:54:27 UTC完成闭盖快速拖放、开盖连续重拖、阅读恢复与正常关闭的独立原生复验，新日志无对应辅助/readiness/timeout/hash告警。本离线片不作为修复证据；原生复验另见来源闭包的`integration/native-validation.json`，也不宣称逐像素验证全部悬空中间帧或Windows/macOS。上述原生观察来自父级实际验收，不是这段视频的录屏内容。

本归档不含中间抽帧和编码日志。重新运行脚本时会生成内部 QA 抽帧供 `finish-delivery.py` 制作总览；可在校验后删除它们。
