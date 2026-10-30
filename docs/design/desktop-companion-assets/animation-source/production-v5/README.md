# v5 动作重修工作源

本目录只保存当前保留的外观参考、姿态锚点与提醒整句工作源；不包含抽图试稿、失败版本、对照视频或自动安装结果。完整动作、中间帧与提放衔接继续制作，公开运行包没有替换。

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

这里只做整幅等比缩放和固定凳底图合成，不按每帧包围框缩放，不贴脸，不做非刚性变形。输出 `prepared.json` 记录实际显示PNG的SHA；后续提起映射必须引用该SHA，不能误用原始前景SHA。中立姿态提供一张同姿完整去凳身体 `detached/open-neutral.png`，用于进入提起时的候选对照；其他姿态仍没有counterpart，工具保持缺失，不自动补图或接入播放器。

已检查中立、倾听、提醒三姿态在灰/暗底上的凳面接触和遮挡。这个检查不代表完整动作已通过；升降手、回位、身体重心和真实打断还须连起来审。更多不同的身体动词及道具接触按 [v5动作语言](../../../desktop-companion-motion-language-v5.md) 和 [接触方案](../../../desktop-companion-prop-contact-v5.md) 制作。

中立去凳图采用新绘制的完整后发，不用旧凳腿形状裁切后发，也不采用会留下接缝的限域underpaint组合。360px灰/暗底检查中，脸、手、膝与双靴保持同姿读取；实际提起/落座时序尚须随完整动作连接检查。

## 提醒整句

`motions/reminder.json` 保存离键、低/高抬手、短举食指、松指、落肘、接近键区、落手的初始曝光与阶段退出顺序。`sourceId` 解析到本目录 `seated-preparation.json` 的生成图；不是把原始前景当显示图。00/末尾共享中立，峰值共享既有提醒锚点，其他六张各有自己的真实原画。

该句仅用于提醒注意，不再拿去改名作接单、授权、问题或结果。单句已有360px持帧审阅；落肘段的速度与同姿提放仍继续校核，不通过定格图数量宣称顺滑。这里没有保存试稿、失败中位图、GIF/视频或派生图集。
