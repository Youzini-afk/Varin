# 共用几何与透明边缘

`seated-open-canonical-v1.png`固定512²视口、头身和道具几何。它来自此前原画候选的同一帧，具体可重导来源见`origin.json`；不再各族独立重造人物比例。

`seated-open-canonical-alpha-v1.png`为同几何的共用透明派生。`derive_alpha.py`只处理边连通白底、经逐区视觉核验的空发环与边界白底污染；人物内部RGB不变，不缩放、不挪位置。黑/白/灰背景检查见`canonical-alpha-qa.png`。这仅是静态边缘审核，不是连续动画通过。

后续原画的静止区域沿用该透明度；变化的发丝/手臂等轮廓需重新制作自己的alpha，不能用旧遮罩裁掉新姿态，也不能让每组重新抠同一片静止头发。运行资源记录几何与alpha两个来源，保持各自SHA。

`seated-open-canonical-alpha-draft-v0.png`仅保留早期输入候选的历史复现依赖。它还没有去除已核查的空发环，不是当前透明基准；详细区别见`alpha-draft-v0.json`。
