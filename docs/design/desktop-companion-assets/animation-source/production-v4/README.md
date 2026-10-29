# 桌宠完整动作源

本目录保存选定的固定画布源，不保存生成试稿、审图片或图集副本。角色动作沿实际画出的手、躯干、腿和电脑接触连接；不是冻结身体后换脸，也不按每帧人物包围框重新缩放。

- `companionship/`：闭盖待命、眨眼、触碰回应、摸发、整理袖口、坐姿调整、伸展，以及分开的入睡、睡眠保持和醒来。
- `response/`：开盖完整注意、键盘支撑的短回应、轻松收手回应。
- `coordination/`：通用胸前整理与低掌呈现，不依赖某个任务在左还是右。
- `coordination-expressions/`：真实提问、结果及严肃提示的表情变体。待授权不等于已批准，未知效果不等于失败。
- `quiet-open-blink/`：实际开盖R同姿眼睑变化，嵌入既有静置循环，不新增休闲调度器。
- `relocation/`：保持开盖角度的提起、承托、触凳和收腕图；与回应共享悬停/触键源，复用原始R。

`suite-manifest.json`只绑定已有事实动作和现有本地互动；新增的伸展、擦袖、坐姿调整与摸发共用原60秒休闲机会，每个合格静置周期最多一条，跨周期轮换。5分钟睡眠期限不变。新任务、隐藏、拖动及更高优先级互动取消旧意图，不排队补演。眨眼使用稀疏原画曝光，睡眠只循环doze，不循环哈欠。

`suite-detached-index.json`按实际512源SHA连接同姿去凳图；`relocation/pickup-manifest.json`沿现有播放器声明当前阶段的完整有序续接、早放和重抓。窗口根随拖动立即移动，不等待手部准备结束。闭盖旧机械连接保持，不用无明显改善的试稿替换。

从仓库源重建冻结的既有基础，再编译新动作候选（不安装；基础选择只复现已经审定的固定 SHA，不自动接受新动作）：

```sh
SOURCE=docs/design/desktop-companion-assets/animation-source
python tools/desktop-companion-animation/build_upright_bundle.py \
  --root "$SOURCE/production-v2" --output /tmp/varin-base-candidate
python tools/desktop-companion-animation/select_upright_bundle.py \
  /tmp/varin-base-candidate/bundle.json /tmp/varin-base-selected \
  --expected-sha f9200cb984d6938979a6068f42343957f46552bfe4612a3d2ea3964cc649c5b9
python tools/desktop-companion-animation/build_interaction_expansion.py \
  --root "$SOURCE/production-v4" --base-source "$SOURCE/production-v2" \
  --base-bundle /tmp/varin-base-selected/bundle.json \
  --performance-manifest "$SOURCE/production-v4/suite-manifest.json" \
  --detached-index "$SOURCE/production-v4/suite-detached-index.json" \
  --pickup-manifest "$SOURCE/production-v4/relocation/pickup-manifest.json" \
  --output /tmp/varin-full-motion-candidate
```

冻结基础的选定 bundle SHA 必须为 `399bf528c3ee7b601ddbd1ca126df123a8a04b78d353b5a3216d1fce8ab1d268`；依据见 `production-v2/integration/portable-runtime-verification.json` 与原始审定记录。若候选 SHA 不同，应调查源码/工具差异，不可动态取新 SHA 绕过选择约束。

如基础inventory尚未准备，先用既有`prepare_upright_inventory.py`和`prepare_upright_recovery.py`对production-v2源码根生成其integration清单。不要对不可变硬链接的开发暂存基准执行写入。

图像SHA/接触源、播放器路由、实际连续播放和原生窗口是不同验证层。成功构建不是自动视觉接受；最终安装须来自整套实际检查后的同一个候选代次，不混用旧新图集。静态源仍有少量衣摆/发丝轮廓变化，不能将来源登记宣称为逐像素相同。
