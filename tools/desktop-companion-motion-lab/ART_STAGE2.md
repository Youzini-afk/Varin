# 真实美术接入：首段受限动作试样

入口：`art-study.html`。默认使用真实人物分层；前阶段debug动作实验仍在`index.html`，不是要交付的人物造型。

## 当前证据

- canonical clean-v3 为1382²；原1254²未缩放，只增加四边64px透明留白。
- 10个互斥可见分区实际Canvas重建与canonical逐RGBA差0。`evidence/art-study/static-report.json`。
- 24px局部边缘延伸不是全新隐藏面补绘。真实underlap中性RGBA最大差5；源主体alpha253/254叠加会影响透明度，不能沿用静态分区差0结论。
- `real-art-limited-motion.mp4`：800²、480帧、8秒、60fps离屏编码。头按真实neck(738,510)微转，胸口小呼吸，手掌根固定、末端局部轻抬后回原键面。下身/凳/笔电不整体摇动。
- `recording-provenance.json`记录影片、渲染代码和实际素材SHA256；离屏渲染不等于浏览器/桌面运行性能通过。
- 6个时刻检查592212个原图内部像素，alpha低于200的漏空数为0；排除原轮廓4px，不覆盖新轮廓与服饰语义美术验收。手掌锚点数学位置不动。
- 影片保持原open-face；局部眨眼试验有单独关键图但尚未通过，不混入此片。一次播放首段试样，不是无缝loop或全部状态动画。

## 动作、美术边界

1. 目前是小角度切片/局部mesh实验：头约不足半度，胸口约1px原图幅度。不能据此扩大转头、抬臂、站起。
2. 部分hairBack仍是剩余语义区，含少量服饰/飘带；不独立摇动该层冒充头发物理。
3. 手是局部指端权重而非各指独立骨骼；远手被机盖遮挡，近手在键盘上。固定开盖只用于这条坐姿动作。
4. 生成注册的隐藏眼区补片和睑mask仍待局部接缝/闭眼轮廓验收；不缩放整张脸制造眨眼。
5. 提起抱机、悬空腿裙、落座压裙、挥手/摊手都缺专用补绘与遮挡，不接真实图版本的drag。
6. 没有连接Agent执行；动画不制造任务完成，不改变Run/Operation。

## 复现

先执行 `npm run prepare:art`，从仓库的既有 stage1 / props 原素材复用逐字节相同的文件；复制项及其 SHA256 见 `shared-art-assets.json`。原素材不被改写，本目录不重复存储这些图片。

`npm run test:art-static` → 静态精确重建；`npm run test:art-integrity` → 内部alpha/掌根约束；`npm run render:art` → 480帧真实美术试片PNG。

视频合成：

```sh
ffmpeg -framerate 60 -i evidence/art-study/cutout-frames/%04d.png -c:v libx264 -crf 18 -pix_fmt yuv420p evidence/art-study/real-art-limited-motion.mp4
```

完整逐帧仅为本地复现中间产物，不需要进入仓库checkpoint。

## 本阶段检查点与历史绑定

`real-art-limited-motion.mp4` 是**历史受限v1接线/漏缝试片**，不是当前正常幅度验收或主要动画预览。其录制时源码保存在 `evidence/art-study/recorded-source-v1/`，与 `recording-provenance.json` 原SHA一致；后续src已增加v2附件带与幅度对比，不能把旧片当作新src已通过。

正常幅度诊断已做：natural约-0.70°→+1.20°、抬头5px；limit约-1.10°→+1.89°、抬头8px。v1有长发横切缝，v2在head/back-hair同变换附件带后消除主要发根横缝，但真实领口隐藏面不足，nearest-color蓝色填片露出。`seam-attached-natural-2.3.png`明确保留该失败，不列为通过。正在另补真实后颈/领内圈、前侧发束、肩衣遮挡面和头部pitch/视线，不能靠永久缩幅修饰资源缺口。

本检查点未载入未通过的旧blink；新的闭眼补绘属于下一阶段，未在这份检查点声称通过。

历史影片需使用 `recorded-source-v1` 中的同名代码，不能以现行 `src` 的重录覆盖后仍沿用原影片 SHA。常规命令检查当前代码；历史源码仅为来源追溯。关键图保留静态重建、锚点、四个试片时刻及修正前后自然幅度和极限幅度接缝图，其他密集诊断帧不重复归档。
