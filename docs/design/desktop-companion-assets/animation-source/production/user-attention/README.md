# 面向用户的全帧原画候选

当前重点是`registered/attention-sequence-v2`、`registered/permission-cycle-v2`和`registered/completion-wave-v2`：沿统一坐姿逐次定向补绘，保护非运动区域，保留真实手臂、眼态、肩袖与回收姿势。`current-inventory.json`登记93个闭合重建依赖文件；`rebuild_current.py`可不调用生图重建这三组。独立临时目录重导的39个当前PNG/JSON/遮罩等文件与登记SHA逐字节一致。**这是可恢复的动画候选，不是已通过的桌宠成品；重导通过不替代正常速度视觉验收。**

此前六组许可、提问/点头、闭盖欢迎、开盖完成及轻点关注的36张组图提取关键画保留为早期探索。它们跨组比例有漂移，不能直接强接成当前动画。

来源、提示词、提取脚本、显式原画时序与QA记录保留在本目录。`inventory.json`记录59个源文件的SHA256。配准、人物/电脑一致性和中间动作仍继续制作；尚未验收的原画不进入生产播放。当前重建说明见[说明](metadata/REBUILD_CURRENT.md)。

原始组图在`sources/`，提取关键画与时序在`frames/`。图集与HTML可由仓库`tools/desktop-companion-animation/`重导，不重复归档。提取图保留自身版本，后续修订由Git和新资源版本跟踪。

许可完整回合中的定时收手仅用于审阅：正式W02必须等待真实输入，再选择适当退出；动画从不批准权限。当前原始坐姿实际为偏用户的中性目光，旧研究包的gaze-screen名称不构成视线证据，运行映射需使用新绘制读屏眼态和连接。
