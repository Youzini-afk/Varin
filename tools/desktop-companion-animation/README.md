# 全帧原画序列工具

本目录只整理已经制作的连续原画，不生成中间动作、不绑定骨骼、不做全身淡化，也不修改业务状态。质量依据是正常速度下的整个人物表演，不是图集成功导出。

## 原画与时间轴

动作目录建议使用 `user-attention/<action>/` 等描述性名字，避免跨方案的 P 编号歧义。原画用 `enter-001.png`、`hold-001.png`、`exit-001.png` 等名称；编号是绘画顺序，不代表固定帧时长。相邻动作共享明确命名的起止姿态。

`sequence.source.json` 与原画放在同一动作目录。`canvas` 是该动作登记画布；同一动作族共用画布和角色尺度，不由打包器推断或缩放。原图可裁切，`offset` 指其左上角在登记画布的位置。所有 `contacts` 坐标也以登记画布为基准，裁切不会改变它们。图像须含实际透明背景，工具不会自动抠图。

下面是结构示例，不是已完成的动作或帧时长建议：

```json
{
  "id": "attention.ask",
  "family": "USER_ATTENTION",
  "canvas": [1024, 1024],
  "entryPose": "seated-work.rest-hands",
  "exitPose": "user-attention.open-palm",
  "loop": null,
  "frames": [
    {
      "source": "enter-001.png",
      "durationMs": 125,
      "offset": [0, 0],
      "phase": "enter",
      "pose": "seated-work.rest-hands",
      "contacts": {"seat": [512, 760]},
      "exitTo": []
    }
  ]
}
```

- `durationMs` 是每张原画的明确时长，无固定 FPS 合同。
- `loop` 可为 `[start, endExclusive]` 原画索引；作者负责末尾与开头视觉连续。工具不自动倒放，不自动补帧。
- `exitTo` 是该画允许接续的姿态名称，尚不驱动任何运行时业务。接触变化及连接画必须实际制作。
- 不完整动作可以记录源稿，但不能把少量原画反复循环冒称完整连续动画。

## 打包

需要 Python 3.10+ 与 Pillow。当前环境已提供，无新增应用运行依赖。

```sh
python tools/desktop-companion-animation/pack_sequence.py \
  path/to/sequence.source.json path/to/output
```

工具保留原像素与显式时长，仅裁去全透明外边缘、保留坐标偏移、按顺序装入 PNG 图集，并输出 `sequence.json`。透明 texel 边缘外扩防止采样串色。`--max-size` 默认 2048 是可调整的打包参数，不是艺术尺寸上限；无法容纳时明确报错，不缩小素材。输出文件夹应专用于该次导出，旧的多余页面不自动删除。

运行消费者依照 `startMs` / `durationMs` 选择画面，用 `rect` 从对应 `page` 裁出，并在统一画布的 `offset` 处绘制。恢复或打断选择已制作的相容姿态与连接画，不将任意两幅全身图做透明叠化。离线图集成功只证明资源整理成立，尚不证明 Electron 已接入。

## 连续审阅

```sh
python tools/desktop-companion-animation/make_review.py \
  path/to/output/sequence.json path/to/review.html --stage keyposes
```

HTML 内嵌图集，可独立打开，提供正常速度、慢放、逐原画和时间拖动。只有已制作中间运动的序列才标为 `--stage motion-candidate`；它仍是待验收候选，不是自动通过。默认不循环，作者尚未制作首尾衔接时不能暗示能循环。重复选项仅用于人工反复查看整段；不会使用任意两帧混合或补运动。审阅文件是可重导产物，不需要每轮都永久提交其内嵌图集副本。
