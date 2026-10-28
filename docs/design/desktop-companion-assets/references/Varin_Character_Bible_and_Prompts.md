---
title: "Varin 娘｜角色设定档案与生图提示词"
version: "1.0-draft"
updated: "2026-10-27"
status: "当前视觉基准稿；已确认项优先，未定项不可擅自当作官方设定"
project: "https://github.com/Youzini-afk/Varin"
---

# Varin 娘｜角色设定档案与生图提示词

> **一句话设定：** 一位温柔、略显慵懒、偶尔有些俏皮的成年银发蓝眼女性；看似随和，却能让复杂的 AI Agent 任务有条不紊地完成。
>
> 
> **本文件用途：** 后续角色立绘、三视图、插画、头像、Q 版和表情包的统一设定；也是交给画师或图像生成模型的创作说明。它整理的是截至 2026-10-27 对话中形成的**当前方案**，不代表已公开发布的官方角色资料。

## 0. 使用原则与参考优先级

本角色的连续性比单张图片的华丽程度重要。发生冲突时，按以下顺序处理：

1. **本文件中注明「已确定／禁止更改」的项目**（特别是 Logo 配色、侧丸位置、背面发型）。
2. **用户亲自提供的 Varin Logo 原图**：两段几何形状，上部深炭黑、下部灰色；不要跟着以往生图稿误画成蓝色。
3. **用户提供的背面发型局部参考**：后脑横向编发、细黑色蝴蝶结／发带、人物左侧单个小圈丸。
4. **最近认可的三人全身转面参考图**：保留服装、人物五官、长发色、动作基调。已接受的高清文件名为 `Varin_3view_upscaled_4x.png`（若本地将该文件与本 MD 放在同一目录，可直接查看）。
5. 本文件的文字描述与提示词；仍然缺失的细节，以克制、不增加新装饰为原则处理。

> **注意：** 旧生图中的「蓝色 Logo 下半段」「后视双丸子」「过度散乱的章鱼状头发」「复杂腰链」都是历史生成偏差，**不是**角色设定。

---

## 1. 基本角色档案

| 字段 | 设定 | 确定程度 |
|---|---|---|
| 角色名称 | **Varin**；可称「Varin 娘」，「小瓦」可作为非正式昵称 | 名称已确定，中文昵称非正式 |
| 所属项目 | [Youzini-afk/Varin](https://github.com/Youzini-afk/Varin) | 已确定 |
| 项目定位 | 开源 Agent Harness：组织模型之外的工具、上下文、执行、权限、协作与恢复 | 项目事实 |
| 拟人化形象 | **成年女性**，约 25 岁，明确是 20 多岁的成年人 | 已确定 |
| 主体风格 | 温柔治愈、清爽成熟、日常幻想感、可爱而不幼态 | 已确定 |
| 次要性格 | 偶尔俏皮、轻微吐槽、有一点小得意与慵懒 | 已确定 |
| 核心特质 | 可靠、有耐心、擅长组织工作、会照顾任务的后续与收尾 | 已确定 |
| 外观关键词 | 银灰至珍珠白渐变长发、清澈蓝眼、单侧圈丸、折页 Logo 发饰、宽袖浅色外衫、蓝灰内搭、深灰叠裙 | 已确定 |
| 身高、生日、血型、籍贯 | **未设定** | 不要从旧图片或生成文字中推导 |
| 官方中文名、详细背景故事 | **未设定** | 可用于今后二创扩展，不应擅自宣布 |

### 角色内核

Varin 不是某个模型的人形化，也不是机器人战士或程序员制服少女。她代表的是**让 AI 真正做完工作的环境与协作方式**：计划、调用工具、分配任务、检查成果、记住进度、必要时恢复执行。

她平时像一位安静的姐姐，爱用轻松的口吻安排事情；遇到复杂任务也不慌。专业感来自**稳定、细致的行动**，不靠机械外骨骼、全息特效或夸张制服表达。

可选口头禅与社区文案（**创作提案，非官方台词**）：

- 「你先去睡吧，剩下的交给我。」
- 「别急，我还有检查点呢。」
- 「嗯……Verifier，再检查一次？」
- 「不是摸鱼，是在等其他 Agent 交作业。」
- 「这次真的完成啦。」

### 两种表现方式

- **常规比例：** 外表温柔、眼神清澈、微微困倦，偶尔有一点坏笑；姿态自然、有成年女性的松弛感。
- **Q 版：** 更软萌、爱撒娇与吐槽、表情更鲜明，但依然有温柔与可靠感；不能变成另一套发型和服饰。

---

## 2. 视觉识别与配色

### 2.1 品牌 Logo（强制一致）

角色发饰来自用户提供的 Varin Logo，保留**两片独立的折叠几何形**以及原有方向和负空间。不要擅自变为闪电、单线 S、齿轮或泛用科技标志。

| 部分 | 颜色 | 用途 |
|---|---|---|
| Logo 上半片 | `#20272A` | 深炭黑／近黑灰 |
| Logo 下半片 | `#77837F` | **灰色（略带中性灰绿调），绝不是蓝灰色或亮蓝色** |
| Logo 参考底色 | `#EFEFE8` | 暖灰米白；只是品牌参考背景，不一定画在发夹上 |

**位置锁定：** 发饰佩戴在**人物自身左侧**的鬓发上方。正面图中对应观者画面**右侧**；纯背面图对应观者画面**左侧**。不同视角按解剖左右重建，**不要水平镜像 Logo 或任意换边**。

**材质建议：** 磨砂深灰金属或树脂，轻微柔和高光；形状与配色比华丽反射更重要。头饰中的蓝色若出现，只能是极轻微环境反光，不可改变下半片的固有灰色。

### 2.2 人物配色（建议值，非产品官方色板）

| 材质／部位 | 建议色与感受 |
|---|---|
| 头发 | 根部冷浅灰 → 发尾珍珠白，整体柔和偏银白 |
| 虹膜 | 清澈冰蓝、偏冷的蓝色，略深外缘 |
| 内搭 | 中低饱和度雾蓝灰；细微竖向针织纹理 |
| 外衫 | 奶白／冷米白，与头发有轻微明度区分 |
| 腰封、外裙 | 石墨灰、炭黑灰，保持完整的大色块 |
| 内裙 | 浅雾蓝，主要在裙摆开口与折叠处露出 |
| 靴子 | 深灰黑，少量低亮度金属扣 |
| 胸前吊坠 | 细银色金属边框，内部透明浅蓝／蓝灰色 |
| 工作牌 | 灰白牌面、深灰夹扣，小尺寸 Logo 可以采用官方黑灰双色 |

**色彩比例建议：** 米白与银发形成明亮主体，石墨灰压住衣装轮廓，雾蓝用于内搭、虹膜和局部内衬。**不要让蓝色覆盖 Logo 下半段**。

---

## 3. 面部与发型（高优先级）

### 3.1 五官

- 明确的成年女性气质（约 25 岁）；柔和脸型、精致但不幼态。
- 眼睛为干净透亮的蓝色，可有深浅过渡；眉毛和睫毛是冷灰调。
- 习惯微微一笑，目光温和、有一点犯困；微表情可俏皮，但不做持续性的冷酷或傲慢脸。
- 不以夸张大头、大瞳孔或儿童体态来制造可爱感。

### 3.2 发色、发量、发丝

- **颜色：** 冷灰发根逐渐过渡到浅银、珍珠白发梢，不染大面积蓝色。
- **长度：** 长发主要自然垂落至臀部附近、部分发尾略长；整体发型不能短成齐肩发。
- **纹理：** 柔顺、带少许自然波度和重量感。以少量宽发束组织体积，发梢温和收拢。
- **禁止：** 头发横向炸开、数十条触手状发束、密集螺旋卷、悬浮无重力、过多细碎发丝遮住衣服。

### 3.3 唯一正确的绑发结构

这是已反复校对的关键点：

1. **半扎发为整体基础**，大部分长发仍自然披在背后。
2. 左右两侧的少量头发沿后脑编成一圈**横向冠状细辫／编发带**，在后脑中上部相汇。
3. **人物左侧耳后附近有且仅有一个小圈丸／小环状发髻**，尺寸适中，不是大丸子。它应能从正面斜侧或左侧看到。
4. 编发后方以**细黑色蝴蝶结和两条垂下的丝带**作收束；**后脑中间的蝴蝶结不是第二个丸子**。
5. 背面参考图的关键轮廓是：圆润后脑 → 横向辫带 → 中间细蝴蝶结 → 长而柔顺的披发；**后视画面左侧的小圈丸**仍须存在。
6. **绝不改成：** 对称双丸子、居中高丸子、人物右侧丸子、完全散发、复杂多重盘发。

### 3.4 发型的三视图定位检查

| 角度 | 必须看见或合理推导的结构 |
|---|---|
| 正面 | 人物左侧的 Logo 发饰、左侧圈丸的轮廓、偏自然的刘海、面部两侧垂发 |
| 背面 | 横向冠状编发、后脑细黑蝴蝶结、**画面左侧唯一小圈丸**、整齐下垂的银白长发 |
| 右侧四分之三 | 沿用目前已认可的斜前朝向，Logo 与单侧圈丸不得因换视角而跑位 |

> 绘制原则：后视头发应**比此前生图更安静**，让大部分发束垂直向下。允许底部略有轻微自然弧度，不需要靠巨大横向蓬发制造动态。

---

## 4. 服装结构（以当前认可立绘为基准）

### 4.1 总体风格

**Soft Fold｜柔软折页。** 有一点日常幻想感和改良和风的剪裁灵感，但本质是现代、轻柔、舒适的原创多层衣装。精致程度适中；不做科技制服、机甲、战术装备或繁重 RPG 服装。

**穿着层级，由内至外：**

1. **雾蓝灰色针织内搭：** 合身、高领／小立领，细密竖纹，领边小范围起伏，胸前有单枚吊坠。
2. **奶白宽袖外衫：** 轻薄、肩线柔和、自然敞开；略有和风式宽袖和折叠衣襟，但不是正式和服。袖口内侧可见少量雾蓝灰色里料或细滚边。浅色布料上可有极淡的抽象折页纹样。
3. **深灰结构腰封：** 一条有真实围合逻辑的黑灰布质宽腰封，压住内搭下摆并固定裙装。只需少量简洁层片和**一个清楚的扣合结构**，不要多套腰带互相打架。
4. **石墨灰不对称叠裙：** 以少量大片布料交错，形成明确的斜向外裙折线和不对称裙摆。
5. **浅雾蓝内裙：** 连续、完整的一层，与深灰外层形成对比；只在主要开口和底边适度露出。
6. **深灰黑短靴：** 低至中等鞋跟的系带／搭扣短靴，鞋头利落，不应沉重笨拙。

### 4.2 裙摆与露腿程度

采用**中度偏大的自然开口**，比早期保守版本更贴近用户喜欢的最初站姿：正面可以自然露出一侧大腿的一部分，具有轻盈感和适度的俏皮感；内裙仍应衬托开口。开口属于合理的服装剪裁，避免不合结构的超高开衩。

结构规则：**两片主要深灰外裙片＋一层连续雾蓝内裙**；不要不断增加随机尖角、额外布条或互相穿插的裙片。正反面需要能解释为同一件衣服。

### 4.3 胸前吊坠

- **保留**一枚小巧精致的几何菱形吊坠，佩戴在内搭的领口下方，位置居中。
- 细链条，银灰边框，浅雾蓝／透明色内芯；不要做大胸针、科技核心或多个吊坠。
- 它负责为上半身增加一点精致感，与发饰形成轻微呼应，但**不能替代官方 Logo**。

### 4.4 腰带与工作牌

- **腰封：** 黑灰布质的整体宽腰封，带清楚的包裹方向和一枚固定扣，前、背、侧连贯一致。
- **工作牌：** 单枚**竖向小尺寸 ID 卡**，挂在**人物左腰**，使用简洁夹扣／短挂带，卡面可印缩小的黑灰双色 Varin Logo。无需编造姓名、公司编号等可读信息。
- **减少：** 金属链、菱形吊坠串、多个圆环、多余皮带与零散挂饰。工作牌是腰间主要辨识配件。
- **背面：** 腰封真实环绕腰部；即便被披发挡住，也不得突然变成另一种蝴蝶结腰带或消失。

### 4.5 袖子、鞋子与手部

- 袖子呈自然向下的宽口轮廓，不能厚得像铠甲或硬披风；袖口留出自然手腕与手部位置。
- 靴子左右同款，鞋跟高度、扣件数目与轮廓三视图保持一致。
- **手部为重点质检区域：** 每只手五根手指，指节和掌心正常，手腕与袖口连接清楚。常用姿势为一只手指轻触下巴／脸颊，另一只手自然垂落；手指不要反折、粘连、额外长出或被袖子截断。

---

## 5. 三视图／设定图标准

### 5.1 已定视角与排布

**左：正面；中：背面；右：沿用最新参考中的右侧位置的斜前四分之三视角。** 这三幅是**同一个人、同一套衣服、同一个发型、同一身高和比例**。

- 左／右视角指镜头排布时，以图中方向为准；**身体饰品仍按人物自身左右定位**，不可镜像。
- 三人从头顶到鞋底整体等高，均为完整全身，无裁切。
- **正面：** 放松的自然承重站姿，一腿轻微前移，膝盖、脚踝位置符合解剖结构；手指自然。
- **背面：** 正常直立、不夸张扭身，重点露出后脑编发和小圈丸。头发垂顺，适当让衣装轮廓可见。
- **斜前四分之三：** 温和地看向镜头，保持标志发夹、吊坠、工作牌、开口和鞋子一致。
- 同一光源和一致的绘画精细度；所有布料相同材质、纹理和颜色。

### 5.2 画面规范

- **纯净角色图：** 仅三位全身人物，不加标题、色卡、详情分镜、道具展示、环境、猫、咖啡杯等。
- **背景：** 优先真正带 alpha 通道的透明 PNG；如模型不支持真实透明，则使用纯白背景并在后期抠像，**不要把棋盘格当成画面背景画进去**。
- 背景不使用深灰渐变光晕；不添加地板、大投影或室内景。
- 推荐宽幅构图 `3:2` 或 `16:9`，三个人物之间留适当空隙。
- 建议先输出三视图作为母版，再单独生成人物头像、表情、Q 版和场景插画。

### 5.3 多视图校验表

- [ ] 每个视角都是约 25 岁的成年女性，五官一致。
- [ ] 发饰只在**人物左侧**；黑色上半片、**灰色下半片**，形状符合原 Logo。
- [ ] **人物左侧只有一个小圈丸**；背面画面左侧可见，不能变成双丸子。
- [ ] 背面为横向编发＋黑色小蝴蝶结＋顺滑长发；没有「章鱼触手」。
- [ ] 蓝灰高领内搭、奶白宽袖外衫、深灰腰封、深灰叠裙、浅蓝内裙结构保持一致。
- [ ] 胸前只有一枚小菱形吊坠；人物左腰只有一枚工作牌。
- [ ] 裙摆中度偏大开口，内裙连续，不凭空新增尖角或层数。
- [ ] 腰封固定点与边缘前后衔接清楚。
- [ ] 两只手的指头数量、握持关系与手腕结构合理。
- [ ] 腿部承重自然，没有畸形关节、错误交叉或左右腿混淆。
- [ ] 三人身高、鞋跟、袖长、发长和皮肤／服饰配色一致。
- [ ] 需要透明图时，输出文件**确实有 alpha 通道**（不能只靠视觉上看着像棋盘格判断）。

---

## 6. 生图提示词使用方法

**强烈建议每次同时提供三张参考：**

1. 已认可的 Varin 三视图成稿；
2. 用户提供的**原始黑灰双色 Logo**；
3. 用户提供的**后视编发与小圈丸局部参考**。

**参考权重顺序：** 身份／服装一致性 > 发型与发饰位置 > 结构正确 > 画风与光影 > 额外装饰。若仅需局部改动，请明确「只改 XX，不改其他部分」，并优先使用局部蒙版编辑而不是整张重新生成。

下面的提示词可直接使用；需要英文时见第 8 节。

### 6.1 中文「角色一致性前缀」（可接在所有正向提示词开头）

```text
原创开源 AI Agent 工具 Varin 的拟人化二次元角色，唯一同一位约25岁的成年女性。气质温柔、可靠、治愈、稍微慵懒，偶尔有一点俏皮的坏笑；成熟但可爱，不幼态。清澈冰蓝色眼睛，柔顺冷灰到珍珠白渐变长发，自然轻薄偏分刘海。半扎发、后脑横向细编发，人物自身左侧耳后唯一一个小圈丸，后脑中部以细黑色蝴蝶结丝带收束，其余长发安静下垂至臀部附近，不凌乱、不触手化。人物左侧鬓发上佩戴 Varin 官方双片折页Logo发夹：上片 #20272A 深炭黑、下片 #77837F 灰色，严格沿用原图形状，不许画成蓝色。蓝灰色细竖纹小立领内搭，胸前一枚小巧银色菱形浅蓝吊坠；奶白色轻柔敞开式宽袖外衫，袖口少量灰蓝内衬；深石墨灰结构清晰的宽腰封，人物左腰单枚竖向工作牌；深灰两片式斜向交叠外裙，浅雾蓝连续内裙，中度偏大的自然前侧开口，露出一侧部分大腿；深灰黑色短靴。柔和精细的日系角色立绘，人体解剖正确，质感统一，简洁克制，参考图人物身份、五官、衣饰布局保持一致。
```

### 6.2 「纯净三视图」正向提示词

```text
请以所附最近确定的Varin三视图作为身份与服装母版，以原始Logo图为发饰颜色和形状母版，以用户给出的后脑发型局部为发辫／圈丸结构母版。输出同一个角色的纯净三视图：左侧完整正面，中间完整背面，右侧完整斜前四分之三角度，等比例、等高度、等大小。每个角度遵循相同衣服层级、裙摆开口、腰带扣件、胸前吊坠、人物左腰工作牌和深灰靴子。背面画面左侧有且仅有一个小圈丸，后脑冠状编发在中间细黑蝴蝶结处汇合，大部分银白长发柔顺垂直向下，禁止过度飞扬。正面站姿自然、膝盖脚踝正确、双脚正常承重，手部五指准确、无粘连。柔和的高质量日系动画设定画风，精细但清爽的线条与阴影。真正透明alpha背景（若不可用则纯白），无标题，无其他物品，无细节插图，无背景，无大阴影，仅三个人物。
```

### 6.3 「单人全身标准立绘」正向提示词

```text
基于提供的Varin定稿三视图，制作单人全身日系角色立绘。保留银灰至珍珠白长发、人物左侧小圈丸与黑灰双色Varin折页发夹、蓝眼、蓝灰高领内搭、胸前精致小菱形吊坠、柔软奶白宽袖外衫、结构清楚的深灰腰封、人物左腰工作牌、深灰不对称叠裙与雾蓝内裙、露出部分大腿的自然裙摆开口、深灰短靴。25岁左右的成年女性，温柔微笑，轻微困倦与狡黠。自然站姿，一只手轻触脸颊，另一手放松，五指准确。发束受重力自然下落，不要夸张风吹或章鱼形状。完整人物，不裁脚。背景纯白或透明，无文字、无附加道具。
```

### 6.4 「头像／半身」正向提示词

```text
以定稿Varin人物为唯一形象参考，绘制精致二次元成年女性半身头像。清澈冰蓝眼睛、自然微笑、柔顺银灰至珍珠白长发和自然轻薄刘海。人物左侧清楚露出黑灰双色原始Varin Logo发夹，发夹后方连接细编发与唯一小圈丸。浅雾蓝立领内搭、奶白外衫领口、胸前小菱形吊坠可见。温柔治愈的姐姐感，略带俏皮，色彩柔和，脸部稳定，五官准确。简单浅色背景，不加额外耳朵、光环、机械配件。
```

### 6.5 「Q版／表情包」正向提示词

```text
以Varin定稿立绘为依据的Q版角色，约2.5到3头身，圆润可爱但不改变设定身份。银灰渐变长发、清澈蓝眼、人物左侧唯一小圈丸、黑灰双色几何Logo发夹、黑色小发带、奶白宽袖外衫、蓝灰内搭、深灰斜叠裙、浅雾蓝内裙、胸前菱形吊坠、左腰工作牌和黑色短靴均简化但保留位置关系。温柔眯眼笑、抱任务清单、稍微得意或者轻轻犯困。轮廓清晰，表情适合聊天表情包，高质量日系Q版插画，透明背景，无字或留给后期加字。
```

### 6.6 「日常场景插画」正向提示词

```text
保持Varin定稿角色的脸、发型、唯一左侧小圈丸、黑灰双色Logo发夹、衣装和工作牌完全一致。温暖安静的工作室日常：她坐在窗边工作桌旁，轻松地整理笔记或看着任务清单，手边有一杯热饮，电脑屏幕只作为远景陪衬。阳光柔和，微笑治愈，偶尔俏皮，银白长发自然垂落，不挡住主要面部特征。干净精细的日系插画，日常幻想氛围，没有赛博全息屏、机甲或战斗装备。
```

### 6.7 「只修改局部，其他不变」编辑提示词

```text
请基于输入原图做局部修正，而非重新设计人物。严格保留所有未指定区域的构图、姿态、脸、衣服层次、配色、工作牌、吊坠、Logo发饰、鞋子和细节。只修改【在这里填写需要修正的位置】；具体改为【在这里填写唯一目标】。禁止连带改变人物左右关系、发饰的黑灰配色、人物左侧唯一小圈丸和其余已确定细节。保持原图人物比例、画风、光照一致。
```

**示例（专门修后视头发）：**

```text
只编辑中间背面人物的头发形状。保持原本横向冠状编发、黑色细蝴蝶结，以及后视画面左侧唯一的小圈丸，不移动也不新增丸子。仅将过度外张、触手状的发束整理成顺滑的几组自然垂落长发，发梢略微弯曲。前视人物、右侧四分之三人物、所有服饰和工作牌、吊坠、手部、背景全部不变。
```

---

## 7. 负面提示词／排除项

> 适用于支持 negative prompt 的工具；不支持负面通道时，可以将最关键的限制改写成正向规则。

```text
儿童脸、未成年感、萝莉体型、过度幼态、机器女仆、科技制服、赛博盔甲、机甲、战术背心、大量皮带和链条、繁重RPG装备、夸张胸前装饰、多枚项链、多张工作牌、错误品牌标志、蓝色Logo下半片、亮蓝色发夹、任意改变Logo形状、发饰换边、人物右侧丸子、两个丸子、对称双丸子、丸子移到后脑正中、取消圈丸、取消编发、过度散乱的头发、章鱼触手状发束、头发向四面八方爆开、漂浮无重力长发、过多细碎线条、随机裙片、无法解释的腰带连接、过度夸张超高开衩、脚踝扭曲、腿部交叉错误、关节错位、多余四肢、多根手指、缺手指、手指粘连、畸形手掌、手指反折、不同视角不同角色、左右镜像错误、人物被裁掉鞋子、不必要文字、色卡、UI排版、人物之外的物品、棋盘格作为绘画背景、灰色渐变背景、烟雾特效、过重锐化、刺眼高饱和蓝
```

最关键的五项：**灰色 Logo 下半片／左侧唯一小圈丸／背发自然垂落／腰封结构明确／手腿解剖正确**。不要过度依赖负面提示词，最好同时上传对应参考图。

---

## 8. English prompts (for image generators)

### 8.1 Character identity — reusable master prompt

```text
Varin, an original anime-style personification of an open-source AI agent harness. A clearly adult woman around age 25, gentle, dependable, warm, softly playful, slightly sleepy and occasionally mischievous; mature and cute, never childlike. Clear icy blue eyes and smooth very long hair fading from cool ash gray roots to pearl white ends, with soft wispy side-parted bangs. Her hair is half-up with a neat braided crown across the back of the head, tied by a small black ribbon bow; exactly ONE small looped side bun behind HER LEFT ear (viewer-right in the front view, viewer-left in the back view). The rest of her hair falls naturally and quietly down her back, with just a few broad flowing sections, not excessive tendrils. An angular two-piece Varin fold-mark hair clip above her LEFT temple, EXACT original logo silhouette and orientation: dark charcoal upper piece #20272A and NEUTRAL GRAY lower piece #77837F, absolutely not blue.

Outfit: a fitted dusty blue-gray ribbed mock-neck knit top, a single delicate silver geometric diamond pendant with a pale-blue translucent center, a softly draped ivory open-front wide-sleeved outer jacket with subtle blue-gray inner cuff lining, a clearly constructed charcoal fabric waist sash with one simple fastening, a single vertical ID badge attached at HER LEFT waist, an asymmetric charcoal wrap skirt made of a few large coherent fabric panels over a continuous mist-blue underskirt, a moderately generous natural slit revealing part of one thigh, and dark charcoal-black ankle boots with modest heels and restrained buckles. Soft everyday fantasy fashion, elegant but not military, futuristic armor, or overdecorated. Maintain identical anatomy, facial identity, garment geometry, colors, accessories, and left-right orientation across views. High-quality clean anime concept art, refined linework, restrained details, gentle soft shading.
```

### 8.2 Clean three-view turnaround

```text
Use the approved Varin character sheet as the master identity and costume reference, the supplied original monochrome Varin logo as the exact hair-clip design, and the supplied back-hair close-up as the canonical braid and left-side loop-bun structure. Create THREE equally scaled, complete full-body figures, arranged from left to right: FRONT, BACK, and matching FRONT THREE-QUARTER view. Precisely the same adult woman, outfit, pendant, ID badge, left-temple logo clip, single left-side hair bun, sash construction, skirt layering, and boots in every view.

BACK VIEW: a smooth braided crown across the back of the head meeting at a small central black ribbon bow, ONE side bun on HER LEFT (viewer-left in back view), with the majority of the silver hair falling gently downward in coherent strands. No twin buns or wild tentacle-like locks. Front view has a comfortable natural weight-bearing stance and correct knees, ankles, wrists and five fingers on each hand. Clean isolated character only, aligned proportions, consistent lighting, no writing, no inset pictures, no props, no scene. TRUE ALPHA TRANSPARENCY if supported; otherwise plain white for later masking. Do not render a checkerboard pattern as pixels.
```

### 8.3 Chibi variant

```text
A cute 2.5- to 3-head-tall chibi version of the same adult-inspired Varin mascot, retaining her icy blue eyes, ash-to-pearl long hair, exactly one left-side loop bun, braided crown and black ribbon, and exact dark-charcoal plus neutral-gray Varin hair clip. Simplify but preserve the ivory wide-sleeved jacket, dusty-blue high-neck inner top, charcoal wrap skirt with mist-blue layer, single diamond necklace, ID badge at her left waist, and dark ankle boots. Gentle, comforting, mildly playful expressions; high-quality clean sticker-like anime art, clear silhouette, transparent background, no words.
```

### 8.4 Negative prompt (English)

```text
child, loli, underage appearance, robotic armor, military uniform, cyberpunk bodysuit, excessive belts, multiple metal chains, blue bottom half of logo, incorrect or mirrored logo, hair clip on wrong side, two buns, symmetrical buns, bun on character's right, central large bun, missing braids, chaotic hair, tentacle hair, excessively flying strands, random skirt ribbons, contradictory fabric layers, duplicated badges, extra pendants, oversized breastplate, unnatural leg crossing, twisted anatomy, malformed fingers, extra fingers, missing fingers, broken wrists, mismatched characters across views, cropped feet, labels, text, color palette boards, extra objects, checkerboard rendered into image, dark gradient background, oversaturated blue
```

---

## 9. 给画师／图像模型的简短交付摘要

> **Varin 娘：** 约 25 岁成年女性，温柔可靠、稍慵懒又有点俏皮。银灰渐变珍珠白长发、清澈蓝眼；半扎编发与中间细黑蝴蝶结，人物**左侧唯一小圈丸**；同侧鬓发佩戴 Varin 官方**上深炭黑、下灰色**折页 Logo 发夹。服装为蓝灰高领针织内搭、胸前单枚小菱形吊坠、奶白宽袖外衫、结构明确的深灰腰封、人物左腰一枚工作牌、深灰不对称交叠长裙和浅雾蓝内裙、黑灰色短靴。裙摆自然中度偏大开口。总体清爽柔和、日常幻想系，不穿机甲或科技制服。手部解剖正确，长发柔顺不乱，背面编发与单侧圈丸不可改成双丸子。

### 适合社区使用的衍生内容（可选）

- **README／官网：** 正式半身、柔和表情、简洁背景。
- **项目头像：** 保持原始 Logo 作为产品主标识；人物头像作为衍生角色素材。
- **表情包：** 任务完成、继续执行、等待确认、Verifier 检查、困倦、轻微吐槽。
- **四种工作模式主题插画：** 编程、科研、办公、通用；可以更换小道具和场景，**不改变基础服装与发饰**。

### 尚未最终确定／发布前确认

- 正式中文姓名（如果需要）、身高、生日、背景故事。
- 胸前吊坠与工作牌的最终矢量设计，是否需要专门出局部定稿。
- Logo 人物素材的对外授权条款；**项目代码的 AGPL 许可不应自动视为插画及角色资产的许可**。公开二创规范可另行制定。
- 是否制作严格正交的左右侧面、背部头发分层稿、表情差分与 Q 版结构母版。

---

**版本说明：** 此文档是从用户和助手的多轮设计讨论汇总的创作基准。视觉上已明确的是人物年龄气质、配色、Logo、本体侧丸与背编发、服装核心层级、胸前吊坠、腰间工作牌和中度偏大的裙摆开口；对未明确的尺寸及背景资料保留「待定」，以免生成模型把一次性的细节误认为永久人设。
