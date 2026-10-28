# 动画源图与分层研究：stage 1

2026-10-29阶段检查点，**NOT FINAL RIG**。返回[视觉资料索引](../../README.md)；[产品设计](../../../desktop-companion.md)；[独立debug运动实验](../../../../../tools/desktop-companion-motion-lab/README.md)。

最终角色呈现路线是认可美术的局部分层与连续运动，**不是用debug小人或SVG代替角色成品**。本目录保存真实人物源图与初步分层；debug实验只验证时间、IK和衔接，两者分别保留。原始认可Q版身份母版不变，本目录canonical是动画源图研究，不替换身份基准。

## 当前文件与状态

- `canonical-seated-v1.png`、`canonical-seated-v2.png`：源图迭代，原样留存；`torso-separation-trial-v1-REJECTED.png`是被拒绝的独立躯干尝试，不用作当前层。
- [clean-v3](canonical-seated-clean-v3.png)：1382×1382 RGBA，由1254×1254的v2仅平移+64,+64加透明边界，不缩放。清理改变29,998个alpha像素；RGBA改变31,071个像素，原轮廓内超过5px的改变为0，见[报告](cleanup-report.json)与[黑灰白背景QA](cleanup-qa-black-gray-white.jpg)。
- `layers-draft/`：4个初始语义mask。`layers-draft-manifest.json`保留近似实测锚点；`waistProjection=(682,741)`不是坐骨支撑点，暂定`hipSeat=(665,810)`。实际运动仍需接触校准。
- `layers-partition-v1/`：10个互斥可见面分层，中性重组与clean-v3逐RGBA最大差0，见[重组图](partition-reconstruction.png)、[分层QA](partition-qa.jpg)与[manifest](partition-manifest.json)。这只证明静态重建，不证明关节可任意转动。
- `layers-underlap-v1/`：10个局部搭接层，使用修正后的`source alpha >= 250`条件，在更前方遮挡层下最多延伸24px，颜色来自内部采样。不是完整隐藏面重绘。手和头因前方无可填遮挡区域，新增搭接像素为0。
- underlap中性合成**全RGBA最大差5**，原alpha>250区域最大差4；不能沿用静态partition的0，见[underlap报告](underlap-manifest.json)与[中性重组图](underlap-neutral-reconstruction.png)。

## 能力和未完成部分

当前只能研究小幅pose与局部接缝，不是完整16节点生产rig。`hairBack`还是语义余集，包含部分丝带/衣物碎片；后续需细化前后发归属。隐藏面、肩腕动作接缝、脸底/眼睑、电脑/凳子接触与透视仍需制作/验证；本快照不夹入这些正在迭代的素材。没有完整打字指骨、提起收腿、抱机与落座美术验收，也不声称整套动画或运行状态接线已完成。

## 复现与校验

依赖Python 3、Pillow、NumPy、SciPy；使用三个脚本的本目录相对路径入口，不需要原工作区。建议先复制本stage目录到临时工作目录再运行，以免覆盖保存的检查点：

```sh
python3 clean_and_segment.py
python3 partition_layers.py
python3 add_joint_underlaps.py
```

脚本会重写输出图像/报告，并额外生成`mask-draft-qa.jpg`。像素算法不变；入库仅清理内部协作措辞，并让初始mask脚本输出当前已校准的`waistProjection/hipSeat`锚点元数据，而非旧的`pelvis`误名。重新编码的文件hash可能依赖图像库版本，像素差指标应另行复核。

[inventory](inventory.json)保留每项冻结来源的`sourceSha256/sourceBytes`和入库版本的`sha256/bytes`；仅README、脚本元数据/说明及partition说明有变化，所有图片原字节不变。inventory本身不做自引用。恢复先核hash，再阅读本页状态边界，不把静态重组0误用于underlap或动态画面。

素材许可遵循[资产索引说明](../../README.md)：代码许可证不能自动推定角色图片许可，本检查点不新增版权归属或许可承诺。
