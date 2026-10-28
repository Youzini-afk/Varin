# Varin 连续动画工作台（独立实验，非生产桌宠）

从仓库根目录进入本目录：

```sh
cd tools/desktop-companion-motion-lab
npm ci
npm test
npm run serve
```

`serve`需要Python 3，打开 `http://127.0.0.1:8765`。返回[桌宠设计](../../docs/design/desktop-companion.md)与[已选视觉资料](../../docs/design/desktop-companion-assets/README.md)。本包独立安装/运行，不接入根workspace、CI或生产打包。
无运行时第三方依赖。开发依赖`@napi-rs/canvas`用于离屏Canvas2D证据，Playwright只用于 `node test/browser.mjs`（需要系统 Chromium）；不安装任何商业动画SDK。此目录是仓库内独立实验，无Host接线或执行写入，不向产品增加生产依赖。

## 已实现与可验证范围

- 程序绘制的 **debug rig**，不是最终人物，不是Live2D，也不把全身PNG摇摆冒充分层动画。
- 五次多项式姿态通道：重定向保留当前位置、速度和加速度（C2）；终点速度/加速度归零。重定向的jerk可能变化，不宣称C3或无条件感知丝滑。最终强度须有真实美术和正常显示尺寸评审。
- 8秒回应/输入审阅研究片段；14秒工作→询问→继续压力片段。时间轴是明确模拟，不代表任务计时或自动完成；正式询问必须等真实事件。
- 手臂两段IK，肩随胸口呼吸而键盘接触目标独立；左右轻击不同频，短串间停顿。现在是手端小位移，不宣称已制作逐指骨骼或手掌/指尖分离美术。
- 眼比头快且8秒脚本眼先于头100ms；头/胸/下身/发/凳分层。当前后发为独立刚性调试形状，不是生产发丝mesh。
- root即时跟手；凳保存世界坐标淡出；闭盖280ms完成后双手160ms移到握持边缘，再以380ms将闭电脑平面转向胸前，人物420ms抬起；释放后落点凳280ms成形，再240ms落座，髋接触后380ms放平电脑、160ms松握、280ms开盖，最后恢复最新语义。当前闭盖/抱胸为粗略调试几何，未证明真实宽袖/手指遮挡安全。
- RAF只推进视觉时间，hidden停止并重置时钟，不补播隐藏期间装饰；语义接口仍可更新最新目标。dispose取消RAF/监听并释放图片引用。
- 连续时间采样不依赖帧数；实际8fps仍会视觉跳采样，数学连续不能改善屏幕刷新率。

## raw PNG契约（不是已有生产rig）

`version:1`、`profile:"seated-study"`，`layers`按实际后→前顺序声明。每项：

```json
{"node":"head","src":"assets/head.png","pivot":[0.5,0.4],"size":[600,600]}
```

所有图片必须同源，`pivot`是该PNG原画布的归一坐标；`size`是整个画布映射后的逻辑宽高。1254² source映射1024²只是统一比例缩放，不能裁切或把原图像素直接套假设1024锚点。节点原点必须由真实图层像素校准；一张未分层canonical不能当完整rig载入。层内完整canvas alpha保留，关节重叠与遮挡补绘另见ART_REQUIREMENTS（导演稿）。

必须完整具备这些节点才原子替换旧rig：chair、lowerBody、torso、head、hairBack、hairFront、upperArmL、forearmL、handL、upperArmR、forearmR、handR、laptopBase、laptopLid、eyes、mouth。加载任何一层失败保留旧rig，不显示半个新人物。当前node位置是**debug默认值**，生产校准应改为manifest绑定坐标而非硬拉真实人脸；因此当前加载器只验证格式/原子资源加载，不是最终自动rigging。

## 验证边界

Node tests验证时间分割、C2打断、IK可达、凳独立、拖放长帧边界和hidden。浏览器脚本另测实际canvas页面、拖动、48张采样截图和dispose。本次环境未完成真实浏览器运行，**不能把脚本存在当成浏览器已通过**。

未跑Varin全量build、Electron原生窗口、多屏/DPI/穿透/焦点，未接真实Run或Operation，没有生产分层美术验收。源码不改变实际Agent执行。后续优先真实部件对齐、接触与遮挡校准、局部发梢mesh和指尖rig，再做正常桌宠尺寸慢放/帧检；不要先增加32套动画数量。

## 资产范围不是永久16层

当前校验的16节点是 **seated-study 首条坐姿8秒profile** 的完整性要求，不是32类动作的永久完整模型。manifest保留实际layer列表、每层pivot/size；不同profile将另定最小节点与能力，不能靠只增一个mode名称假称已有美术。当前加载坐姿profile后禁用无素材的询问摊手与提起/落座；相应按钮只在debug rig验证几何。

提起需要下身离凳时腿与裙的替代姿态/补绘、闭盖抱胸手势、接触关系与遮挡切换，落座还需反向衔接。固定坐姿下身平移/旋转不能代表完成站起。未来扩展应按具体动作节点/遮挡合同演进，不为此创建通用动画引擎。

## 离屏几何证据

`node test/offscreen.mjs` 直接将同一个 `src/renderer.mjs` 连接 `@napi-rs/canvas` 的真实Canvas2D上下文，输出480帧study和360帧中断/拖动。`ffmpeg -framerate 60` 合成的视频仅证明离屏绘制内容，不证明浏览器RAF、DOM、GPU、原生桌面或60fps运行性能。PNG已人工查看：debug已从平托修为闭电脑竖面靠胸、双手握下侧边缘；仍不是最终人物抱胸美术。

### 首尾接缝

`test/seams.mjs` / `evidence/offscreen/seam-report.json` 对照0、479/60及8秒。主姿态channels的x/v/a差均为0，但呼吸在8秒相差1.7183逻辑px，后发/衣摆相位也不闭合。因此两段MP4明确为 **一次播放预览，不是无缝循环视频**。工作台重复事件流则保留同一Motion及连续时间，不在8秒清零次级相位。idle/typing当前是持续程序运动，不宣称已导出真正周期的循环资产。

### 拖动意图与快速打断

UI用6 CSS px阈值（不按canvas像素或DPR）区分点按/轻抖与拖动，跨阈值才beginDrag。core的直接调用仅用于压力测试，不表示pointerdown即提起。同处快速放回继承凳当前alpha，异处早放时旧凳保留世界锚点继续淡出，新凳独立淡入；不把尚可见凳瞬移到新位置。闭盖未完松手、落座中再提起均保留当前x/v/a；已握稳闭电脑时再提起不先松手重播整段。对应行为共19项Node测试；UI真实浏览器仍未通过环境前置。

导演复核：抱持debug静态方向已通过；下放先落座再放平电脑，避免电脑在髋悬空时先失去胸前支撑。椭圆手是接触代理，生产美术须分拇指（电脑正面）与绕侧/底手指并内收肘，不可把整手贴在电脑正面。


## 检查点与恢复

本快照仅保存连续时间、IK接触、交互打断与动作衔接的debug rig源码、独立package/lock、测试、导演/素材规格和关键离屏证据。7张PNG与2段MP4是调试几何，不是最终人物动画，不证明浏览器或Electron的帧率/性能。raw PNG加载profile仅覆盖8秒`seated-study`；14秒和拖动示例在debug rig中验证，不能据此声称真实素材已覆盖全部动作。

[导演稿](MOTION_DIRECTION.md)和[素材要求](ART_REQUIREMENTS.md)说明目标与未完成的制作工作；现有实现及已验证边界以上文和实际源码/测试为准。导演稿中的时间预算不表示该动作已具备生产美术，也不自动覆盖当前6 CSS px拖动阈值等实现契约。

冻结来源27项文件复制前后均逐项SHA-256一致。入库仅对README与两份导演/素材文档做入口路径及协作措辞清理，源码、测试、依赖锁和图像/视频/报告不变；随后更新[CHECKPOINT_SHA256SUMS](CHECKPOINT_SHA256SUMS)为入库版本，运行`sha256sum -c CHECKPOINT_SHA256SUMS`可复核清单。清单不包含自身。

未保存node_modules、840张离屏序列帧、运行日志或当前人物美术。需要重现离屏序列时，安装开发依赖后运行`npm run render:evidence`；MP4另需ffmpeg。此过程不作为已通过浏览器验收的替代。
