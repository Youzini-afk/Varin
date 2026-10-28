# 桌宠视觉资料与进度索引

2026-10-29 默认配色设计checkpoint。返回[桌宠设计](../desktop-companion.md)；动作与过渡见[分镜编排](SHOT_PLAN.md)。这些图片位于设计资料目录，**不是生产加载资源、sprite sheet、已完成动画或软件功能**。

## 恢复时先读

1. 当前角色身份只使用[已选Q版母版](masters/Varin-chibi-original-reference.png)。站姿用于脸、比例和服装识别；待命/工作使用坐姿电脑场景。
2. 画风与表演强度使用用户最终选定的[第一版工作闭环](storyboards/01-work-cycle.png)，不采用archive里的playful/balanced迭代。角色自然抬眼、歪头、轻摊手、认真输入、闭眼笑挥手，不继续追求更强表情。
3. [08提起与落座](storyboards/08-reposition-lift-and-sit.png)替代07第3/4格：只提起人，旧凳原地淡出，新落点凳淡入，人抱闭盖电脑后自然坐下。07其余格保留。
4. 8板共44格，含重复、过渡、分支及已替代格，不等于32类独立生产差分已完成。下一步需逐状态拆分/校准、透明边缘与解剖QA、制作过渡和循环，再接真实运行状态。
5. 当前仅默认色。未来可换发饰、毛衣、裙内及吊坠的重点色，蓝眼固定；这一最新规则覆盖原角色文档中发饰永久黑灰的旧限制。

## 原始来源与当前母版

| 文件 | 用途与状态 |
|---|---|
| [原三视图](references/Varin_turnaround_superres_4x-g.png) | 用户提供的角色身份/衣装参考，原样保存；不是Q版或分层模型 |
| [原角色设定与提示词](references/Varin_Character_Bible_and_Prompts.md) | 用户提供文本，原字节保存；旧发饰固色规则已由上面的最新换色规则覆盖，不能把旧文重解释为现行限制 |
| [Q版母版](masters/Varin-chibi-original-reference.png) | 已选定；其余站姿/吊坠/坐姿探索稿均不作为身份参考 |

## 当前分镜与实际图格

编号按图中从左到右、从上到下读取。下表是已保存图的用途；SHOT_PLAN中的起始/动作/终态是后续动画编排，不能把规划的每一细节都视为图像已完成。

| 图片 | 格数 | 图格意图与限制 |
|---|---:|---|
| [01 工作闭环](storyboards/01-work-cycle.png) | 6 | 闭盖坐姿待命→开电脑接任务→键入→停手问用户→回应后继续→开盖闭眼笑挥手完成；已选表演基准 |
| [02 电脑活动](storyboards/02-computer-activities.png) | 6 | 阅读/托腮→写作输入→编程专注→浏览触控板→观察计算→核查；部分活动仅靠小动作区分，生产差分仍需识别度验收 |
| [03 整理协作](storyboards/03-organization-collaboration.png) | 4 | 整理→调度→队列→等外部结果；数量图标是示意，不是运行数据 |
| [04 等候回应](storyboards/04-waiting-response.png) | 6 | 排队→授权→提问→外部等候→重试→恢复工作；这是分支对照，不是一条必须发生的等待流程 |
| [05 异常恢复](storyboards/05-errors-recovery.png) | 6 | 失败停手→求助→断联→同步→结果未知→核查；不混淆失败和未知，不自动批准重试 |
| [06 取消收尾](storyboards/06-cancellation.png) | 4 | 停止新输入→等待收尾→确认停止→回待命；必须有实际停止事实，单Run cancelled不足以表明所有执行已停 |
| [07 生活互动](storyboards/07-daily-interactions.png) | 6 | 欢迎、眨眼回应、旧拖动、旧落位、困倦、安静；**第3/4格作废，由08替代**，原图不裁改以保留过程 |
| [08 提起落座](storyboards/08-reposition-lift-and-sit.png) | 6 | 合电脑准备→提起且旧凳淡出→抱电脑无凳悬空→新落点凳淡入→落座→整理衣摆；炭灰外裙保留 |

拖动只改变位置，不取消、暂停或重启实际任务，也不批准权限；人物合盖不是engine停止。放下后按最新工作事实恢复姿态。图中的界面符号只作设计示意，正式运行值由原状态owner提供。

## 动画源图与分层研究

[stage 1检查点](animation-source/stage1/README.md)保存真实人物canonical、clean-v3、初始mask、10层互斥分区与局部underlap、脚本、锚点和QA。静态分区逐RGBA重组差0；underlap中性合成最大差5，不是0。当前仍有头发语义余集、隐藏面与脸待完成，仅研究小幅pose。

[独立道具研究](animation-source/props/README.md)保存原始atlas、凳/笔电底座/机盖的独立提取与同画布配准、复现脚本和静帧合成QA。固定开盖坐姿的道具已具备研究资源，不等于闭盖、抓握、开合或提起动画已完成；真实抬头、独立目光、自然闭眼与手态仍需补绘。

[真实美术接线试样](../../../tools/desktop-companion-motion-lab/ART_STAGE2.md)保存实际 Canvas 分层渲染、静态重建、头发附件带与范围诊断。历史小幅动作影片附录制源码和 SHA，正常幅度的领口缺口也保留为补绘依据；不是最终动画验收。工作台从本目录复用相同素材，不重复归档整套源图。

[抬头与低头参考](animation-source/head-angles/README.md)保存新增俯仰原图、相似变换配准与近似面部标记点。它们是补充视角的美术参考，尚非可直接替换的运行时头部：服装和发束有生成差异，必须局部提取与接缝处理，不能用整块交叉淡化制造重影。标称角度是绘制意图，不是测得的三维角度。

[v3 坐姿动画研究](../../../tools/desktop-companion-motion-lab/ART_STAGE3.md)把新增眼态、手态与颈肩补绘接入连续变形，保存 8 秒实际绘制影片和来源校验。俯仰参考尚未接入；片中头部依然是平面滚转/位移，近手运动大多被电脑遮挡，还不是完整的工作表演。

最终路线是认可美术的分层动画，不用[debug几何实验](../../../tools/desktop-companion-motion-lab/README.md)代替成品角色。debug证据保持独立；本源图阶段也不是最终rig或软件动画已完成的声明。

## 未选探索归档

为保留恢复线索，未选稿与current目录隔离，**不参与后续角色或表演参考选择**。归档不是待自动启用的候选。

| 文件 | 归档原因 |
|---|---|
| [playful](archive/not-selected/01-work-cycle-playful.png) | 表演过强，未选 |
| [balanced](archive/not-selected/01-work-cycle-balanced.png) | 中间迭代未选；最终选回01第一版 |
| [初始比例稿](archive/not-selected/exploration/standing-proportion-rejected.png) | 身材比例方向未选 |
| [standing v2](archive/not-selected/exploration/standing-master-v2.png) | 旧角色母版，已被当前Q版替代 |
| [吊坠 v3](archive/not-selected/exploration/standing-pendant-v3.png) | 未选吊坠迭代，不能叠加到当前母版 |
| [坐姿母版 v1](archive/not-selected/exploration/seated-work-v1.png) | 未选角色母版，后续从认可Q版建立坐姿 |
| [旧C02](archive/not-selected/exploration/C02-accepted.png)、[旧C04](archive/not-selected/exploration/C04-thinking.png)、[旧L02](archive/not-selected/exploration/L02-blink.png)、[旧W02](archive/not-selected/exploration/W02-authorization.png) | 站姿工作差分方向废弃，保留探索记录 |
| [08飞凳中间稿](archive/not-selected/exploration/reposition-floating-stool-rejected.png) | 悬空阶段仍有凳子，已被08最终稿替代 |
| [08缺裙中间稿](archive/not-selected/exploration/reposition-skirt-rejected.png) | 去凳后丢失炭灰外裙，已被08最终稿替代 |

## 完整性与许可边界

- 所有图像及原角色文档按原字节复制，没有重压缩、裁剪或修图。新[manifest](manifest.json)仅含相对路径、SHA-256、字节数、图像尺寸、用途和采用状态；不保存工具日志、私有传输地址或运行凭据。
- manifest覆盖所有来源资产，不为它自身或维护说明做自引用校验。恢复时可逐项重新计算SHA-256，核对身份母版、当前分镜、替代关系和未选归档。
- 本目录是设计进度记录。角色/插画素材的独立授权条款尚未确定；**不得仅凭项目代码许可证推定这些图片及角色设定自动获授AGPL许可**。本checkpoint不新增许可承诺，也不声明未经确认的版权归属。再分发、生产打包或外部二创授权需另行确认相应素材条款。
