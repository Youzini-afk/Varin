# Bot 形象与自定义素材

每个 Bot 可在「设置 → Agent → Varin → 档案 → 形象」中选择形象；右侧面板的档案页提供同一入口。
侧栏、Bot 选择器、聊天首屏、右侧工作面板、手机标题和返回 Bot 的入口使用同一份选择。
形象只影响呈现，不进入系统提示词，也不改变模型、指令、记忆或正在执行的工作。

## 选择与预览

内置 Varin 可跟随当前客户端的主题、保持原始雾蓝，或为这个 Bot 指定固定颜色。换色只作用于服装和
原本参与主题换色的装饰、道具与效果；眼睛、头发、肤色保留，动作不重新开始。

导入的 PNG、JPEG、WebP、GIF 保留原色。透明图片按自然轮廓显示；有背景的图片使用圆角呈现。
大形象与小头像可以分别调整水平位置、垂直位置与缩放；小头像也可由形象包提供单独图片。
选择时先预览，点击「应用」才修改 Bot；这与名称、指令的未保存草稿独立。
导入本身会把素材加入当前 Host 的形象库，取消选择不会删除已导入的素材。

形象库可删除未使用的素材；仍被 Bot 使用时会列出使用者，先为这些 Bot 更换形象再删除。
归档 Bot 仍保留形象引用。导入同一份素材不会重复添加；不同素材中相同的原图和预览也由内容存储复用。

## 外部形象包

作者可以把图片与以下 `appearance.json` 放在 ZIP 中。清单必须位于 ZIP 根目录，图片路径相对该根目录。

```json
{
  "schemaVersion": 1,
  "name": "Moon",
  "image": "images/idle.png",
  "portrait": "images/avatar.png",
  "states": {
    "thinking": "images/thinking.webp",
    "working": "images/working.gif",
    "waiting": "images/waiting.png",
    "sleeping": "images/sleeping.png"
  }
}
```

`schemaVersion`、`name` 和 `image` 必填；`portrait`、`states` 可省略。仅一张基础图片即可使用。
动画可用 GIF、动画 WebP 或 APNG；普通 PNG/JPEG/WebP 作为静态图片。清单只描述素材，不包含可执行脚本。
导入时会解码图片并检查清单，缺失图片、重复文件名、未知状态等错误会指出具体位置。

可选状态：

| 状态 | 用途 |
| --- | --- |
| `idle`、`listening` | 空闲、用户正在输入 |
| `thinking`、`preparing`、`replying` | 思考、请求准备、正在回复 |
| `working`、`supervising` | 自己工作、跟进团队 |
| `waiting`、`sleeping`、`waking`、`offline` | 等用户处理、休息、唤醒、离线 |
| `tool-read`、`tool-search`、`tool-web`、`tool-edit` | 阅读、搜索、浏览、编辑 |
| `tool-shell`、`tool-memory`、`tool-plan`、`tool-other` | 终端、记忆、计划、其他工具 |

未提供某个状态时使用基础图片；工具状态和回复也可复用 `working` 图片。界面中的状态文字始终来自真实工作状态。
小头像使用静态预览；大形象在可见且允许完整动效时播放动画，隐藏、离屏或选择减少动态时显示静态帧。
各状态图片使用接近的构图能让切换更自然，但无需复刻 Varin 的骨骼、双手或道具。

## 存储与运行边界

- Bot 档案的 `appearance` 保存形象引用、固定配色和两种构图；旧档案省略此字段时沿用内置 Varin 与主题配色。
- 自定义素材由 Host 通过既有 Rust Blob/record 接口写入 `__varin_bots__` 下的 `bot.appearance` 记录。
  记录引用保留原始媒体及静态预览；删除记录释放引用，实际空间回收交给原存储所有者。
- `GET/POST /api/harness/bot-appearances` 读取库或用 multipart 的 `file` 字段导入。
  `GET/DELETE /api/harness/bot-appearances/:id` 读取或删除素材；`GET .../:id/media/:hash` 返回该素材中声明的图片。
  这些入口沿用 Host 鉴权；客户端经 `BotsAPI.appearances` 使用，不读取导入者本机路径。
- 资源按需读取，客户端共享图片解码与 Object URL；没有使用者时释放，切换 Host 时清除。
  新图片准备好后再替换旧形象，切换构图不重新下载素材。
- 工作舞台依赖 `BotStageActor` 的图层、几何和动画生命周期。内置 Varin 保持原有互动；导入图片使用
  独立舞台显示团队、派发与回报，文件不需要提供手部或视线骨骼。
- 桌宠保留桌面端素材库和动作系统；导入 Bot 形象不会自动改动或安装桌宠。

入口实现：`application-client/src/bot-appearance.ts`、Host `lib/bots/bot-appearances.ts`、
UI `BotAppearanceSettings.tsx` 与 `workbenches/bot/BotFigure.tsx`。
