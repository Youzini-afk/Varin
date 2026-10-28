# 坐姿工作全帧原画候选

本批保存typing6和opening6的原图、透明原画、逐画时序及清理/登记脚本。它们是关键姿态候选，不是已完成的连续动作；详细边界见[QA](PHASE1-QA.md)。不设置每秒60张原画的目标，按实际动作编排各画持续时间。

`inventory.json`包含31个来源文件的SHA256。登记只使用整体整数平移，原画没有通过骨骼变形或全身淡化合成动作。图集/审阅视频由仓库工具重导，不在本目录重复保存。

在本目录运行 `python3 register_typing.py`、`python3 cleanup_typing.py` 重导typing；运行 `python3 extract_components.py` 重导opening。需要Pillow、NumPy和SciPy；复现不等于视觉合格。
