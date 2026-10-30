# 桌宠动画制作路线调研

核验日期：2026-10-28。本文是制作路线研究，不表示已完成对应工具集成或动画质量验收。保留已确认的 Q 版身份、默认配色、坐姿电脑工作和提起后落座设计。

## 结论

本项目确定采用**全帧关键原画、连续中间画与明确时间轴**的制作路线，整个人物连续表演先行。全部表现、保持、过渡、资源需求与生产流程先完整设计，再按整体方案分批制作。不能把大动作做成孤立片段，而把细微动作默认交给未经验证的切片模型；也不能以单段样片取代完整设计。现有 Canvas 切片试样已经暴露僵硬问题，不作为默认成品基础。

桌宠至少包含三个不同层次：画出或建模动作所需的信息；制作姿态、时间曲线和连接；根据真实产品事件播放与打断。换播放框架不能自动完成前两层。现有试样的问题主要是扁平素材拓扑、可读动作和编排不足，而非输出帧率低。

## 已核验的项目

### VPet：完整动作资产与进出场

固定源码版本 `515d7887fa3479d03dd11cd567a2cf752bd5b15f`。GitHub 目录树统计自带 vup 角色有 6,181 个 PNG，位于 609 个含 PNG 的目录；目录数不等于独立动作数。

WorkONE 普通状态有开始 10 帧、两个循环变体 10/8 帧、结束 10 帧。主要帧名后缀为 125，播放器将其解释为毫秒；这是约 8 fps 的原画节奏，并非本项目丝滑目标的标准。提起也有专门的动态与静态姿态。PNGAnimation 会合成横向 sprite sheet 缓存，GraphInfo 区分 Start、Loop、End。

启示：学习完整的动作结构和专用姿态，而不是照抄稀疏帧率。代码许可不自动覆盖角色动画。

- [PNGAnimation](https://github.com/LorisYounger/VPet/blob/515d7887fa3479d03dd11cd567a2cf752bd5b15f/VPet-Simulator.Core/Graph/PNGAnimation.cs)
- [GraphInfo](https://github.com/LorisYounger/VPet/blob/515d7887fa3479d03dd11cd567a2cf752bd5b15f/VPet-Simulator.Core/Graph/GraphInfo.cs)
- [工作素材](https://github.com/LorisYounger/VPet/tree/515d7887fa3479d03dd11cd567a2cf752bd5b15f/VPet-Simulator.Windows/mod/0000_core/pet/vup/WORK/WorkONE)
- [提起素材](https://github.com/LorisYounger/VPet/tree/515d7887fa3479d03dd11cd567a2cf752bd5b15f/VPet-Simulator.Windows/mod/0000_core/pet/vup/Raise)

### BongoCat：模型参数，不是三张图的同一种实现

ayangweb/BongoCat 在 `47a73ed1765b13fdd674ec356d51b5b16a6b5a5b` 的 standard 模型包含 moc3、三张纹理、三个 expression 和两个独立 motion 文件。motion group 重用文件不能重复计数。motion1 的 30 fps 是参数曲线元数据，不是 30 张图片每秒。

实际代码驱动头、眼球、左右手和鼠标等 19 个参数，自动呼吸采用不同周期并叠加，避免覆盖输入驱动的姿态。当前实现是 Rust/Cubism；不能根据旧教程或 topic 标签认定仍是 Tauri。其他同名 BongoCat 项目有三张姿态切换实现，两者不可混为一谈。

启示：坐姿工作适合参数模型，但前提是完成可变形模型制作，给现有抠图接 SDK 不会自动获得这些能力。

- [模型清单](https://github.com/ayangweb/BongoCat/blob/47a73ed1765b13fdd674ec356d51b5b16a6b5a5b/resources/models/standard/cat.model3.json)
- [参数](https://github.com/ayangweb/BongoCat/blob/47a73ed1765b13fdd674ec356d51b5b16a6b5a5b/crates/bongocat-live2d/src/parameter.rs)
- [自动动作](https://github.com/ayangweb/BongoCat/blob/47a73ed1765b13fdd674ec356d51b5b16a6b5a5b/crates/bongocat-live2d/src/automatic.rs)

### Shimeji：姿态少，但行为不只是重复摆动

可读源码分支的 actions.xml 为动作配置姿态、锚点、速度和持续时间；拖动中按鼠标相对位置换姿态，抛掷衔接下落、反弹、站稳。behaviors.xml 按地面、墙壁等条件和权重选下一行为。经典模板的 46 张基础姿态不是一段 46 帧动画。

启示：角色回应和动作后果同样重要。但传统稀疏姿态切换不等于精细日系动画，不能用它降低 Varin 的质量目标。

- [动作配置](https://github.com/DalekCraft2/Shimeji-Desktop/blob/main/conf/actions.xml)
- [行为配置](https://github.com/DalekCraft2/Shimeji-Desktop/blob/main/conf/behaviors.xml)
- [经典模板说明](https://github.com/Valkryst/VShimeji)

### AIRI 与 Mate Engine：动作叠加需要明确所有权

AIRI 官方当前手册包含 Live2D、Spine、VRM、MMD、Tachie 等模型路线。实际 Live2D 代码将表情、眨眼、口型、注视等分层处理，并关闭会相互覆盖的 SDK 控制器；不是不断增加更多彼此竞争的动画。其模型缓存、异步加载和销毁经验适合参考，但移动端原型测试不是 Varin 的性能证明。

Mate Engine 的 Unity 代码将 Animator 动作与头、脊柱、眼睛跟踪分开，按状态决定能否叠加跟踪。这说明连续控制应建立在完整模型与动作之上。它的 3D 路线需要新模型、绑定和材质，不能无成本保留当前 2D 插画表现；不建议只为当前僵硬问题转成 3D。

- [AIRI 官方手册](https://airi.moeru.ai/docs/en/docs/manual/tamagotchi/setup-and-use/)
- [AIRI 实际分层控制](https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-live2d/src/components/scenes/live2d/Model.vue)
- [AIRI 生命周期](https://airi.moeru.ai/docs/en/blog/DevLog-2026.03.14/)
- [Mate Engine Animator](https://github.com/shinyflvre/Mate-Engine/blob/main/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarAnimatorController.cs)
- [Mate Engine 跟踪](https://github.com/shinyflvre/Mate-Engine/blob/main/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarMouseTracking.cs)

## 生图、改图和视频模型的边界

不需要先使用视频模型。项目源码证明的是最终资产与播放格式，不能据此断言作者所有上游美术工具，也不能声称他们完全没有使用生成模型。

- 生图/改图可提供关键姿态、手型、表情和隐藏面候选；还需要一致性修订、连续中间动作、接触关系与分层拓扑。
- 可动模型由网格、权重、参数关键形状、遮挡层次与时间曲线构成。自动网格只是制作起点。
- 视频生成可用于探索完整动作或候选片段；经过人物一致性、抠像、锚点、循环与连接修订后，可以烘焙为动画资产。它不是不可用，也不是直接得到可打断桌宠的捷径。
- 光流插帧估计已有画面的中间状态，不会修复错误的手指、透视和运动意图。整张姿态透明叠化也不是合理的身体过渡。

## 工具与许可应分开评估

Live2D 官方明确要求拆出眼部等部件并补画运动后露出的区域，适合作为精细原画模型制作参考。其 SDK 发布许可不是无条件开源；可导入不定数量模型的功能可能属于 Expandable Application，需要官方分类和相应许可，不能自行套用小规模豁免。

Spine 提供成熟的骨骼、网格和动作混合，但 runtime 许可有 Editor 条件；不能直接当作宽松开源依赖。合法工具制作后导出普通帧资产与集成专有 runtime 是不同路线，作品权利仍需分别核对。

Rive runtime 为 MIT，当前支持位图网格。2026-10-28 直接核验价格页显示免费导出带 splash，付费可移除；此日期是查询日期，不是政策变更日期。需要验证具体制作能力和目标 renderer，不把营销中的自动绑定当成艺术质量保证。

Inochi2D/Creator 提供开源位图 puppet 路线，SDK 为 BSD-2-Clause；当前 C FFI/WASM 路径与版本成熟度仍需集成核验，不能声称 Electron 即插即用。官方编辑器评估包提醒与源码许可也要分开描述。

- [Live2D 拆图](https://docs.live2d.com/en/cubism-editor-manual/divide-the-material/)
- [Live2D Expandable 条款](https://www.live2d.com/en/sdk/license/expandable/)
- [Spine 许可](https://us.esotericsoftware.com/spine-editor-license)
- [Spine 导出](https://us.esotericsoftware.com/spine-export/)
- [Rive runtime 许可](https://github.com/rive-app/rive-runtime/blob/main/LICENSE)
- [Rive 当前价格](https://rive.app/pricing)
- [Inochi2D SDK](https://github.com/Inochi2D/inochi2d)
- [Inochi 官方下载](https://inochi2d.com/download/)

## 对 Varin 的实施判断

完整连续表演设计先行，资源清单按全部状态、保持和连接关系展开，不设置任意的小素材上限。常态坐姿的眼神、呼吸、手部、头发和重心调整也需要认真制作，与明显姿态变化一样具有关键姿势、时间关系和视觉验收；不能因为幅度小就默认交给程序摆动。逐帧、网格、骨骼或其他工具的选择应以真实连续效果决定，不预设“大动作片段、小动作模型”的分工。需要新角度、隐藏面或中间姿态就补画，不能用拉伸已有裁片替代。任何采用的变形须证明不会产生既有僵硬与接缝；已经烘焙的动作不再重复施加同部位变形。

制作工具与产品播放格式解耦。优先保留可编辑分层源图、动作时间线和无损透明输出；产品只消费经过审核的动作资产、局部可动层及播放元数据。最终工具选择应服务完整方案，不因已有 Canvas 实验而固定路线，也不以再做一个小样代替整体规划。

当前窗口与状态实验可保留；角色试样不是最终 rig。后续验收应覆盖完整动作族及跨族过渡，检查目标尺寸下的动作可读性、身份一致、接触、遮挡、节奏、循环与中断。离屏 60 fps 编码、静态重建和参数连续检查不替代这些视觉判断。

研究限制：本轮读取官方文档和实际源码/素材目录，未运行第三方桌宠或付费编辑器，未进行实机视觉与性能横评。工程建议是基于这些证据及当前试样问题的判断，不是产品排名或普遍性能结论。
