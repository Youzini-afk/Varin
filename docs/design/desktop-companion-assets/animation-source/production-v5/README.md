# v5 动作重修工作源

本目录只保存当前保留的外观参考与三个有效姿态锚点；不包含抽图试稿、失败版本、对照视频或自动安装结果。完整动作、中间帧与提放衔接继续制作，公开运行包没有替换。

- `reference/open-neutral.png`：用于约束人物脸型、服装、发饰与吊坠的高分辨率工作参考。其生成的凳子不作为几何依据。
- `foreground/open-neutral.png`：安放双手的中立前景。
- `foreground/listen-crest.png`：胸肩随髋前倾、双手低位安放的倾听姿态。
- `foreground/reminder-crest.png`：近身短举食指的提醒姿态；不用于接单、授权或结果。

三个前景都是完整人物原画，不拆头脸或肢体来驱动。凳子应遮住的区域保留透明缺口，不能把这个前景直接当成悬空去凳人物；真正提起时需要另画显露后发的同姿身体。固定凳来自既有 `production-v2/relocation/frames/world-stool-grounded-v4.png`，使用相同像素与位置，避免逐帧重画凳体造成抖动。

用已有工具重建512画布的坐姿图，产物放在仓库外：

```sh
python tools/desktop-companion-animation/pack_sequence.py \
  docs/design/desktop-companion-assets/animation-source/production-v5/seated-preparation.json \
  /tmp/varin-v5-seated-sources --prepare-seated
```

这里只做整幅等比缩放和固定凳底图合成，不按每帧包围框缩放，不贴脸，不做非刚性变形。输出 `prepared.json` 记录实际显示PNG的SHA；后续提起映射必须引用该SHA，不能误用原始前景SHA。当前没有提供提起counterpart，工具会保留这项缺口，不自动接入播放器。

已检查中立、倾听、提醒三姿态在灰/暗底上的凳面接触和遮挡。这个检查不代表完整动作已通过；升降手、回位、身体重心和真实打断还须连起来审。更多不同的身体动词及道具接触按 [v5动作语言](../../../desktop-companion-motion-language-v5.md) 和 [接触方案](../../../desktop-companion-prop-contact-v5.md) 制作。
