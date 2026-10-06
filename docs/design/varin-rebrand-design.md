# Varin 全面更名设计

Status: historical naming decision; product/source cutover implemented at D-313. Publication state belongs to release records, not this design.

Last updated: 2026-10-06

本设计确定产品由 **Piarium 全面更名为 Varin**。实施顺序见
[阶段 B](../archive/agent-harness-plan-2026-10-06.md#阶段-bvarin-全面更名d-313)，实际完成情况只记入
[能力状态](../status.md)。产品源码、品牌资源和 GitHub 仓库已切换；新发行资产与 npm 发布状态单独记录。

## 1. 产品决定与边界

Varin 是独立的 Agent 工作台与完整 Harness，拥有自己的工具环境、上下文管理、检索、工作状态、
线程协作、执行、定时接续与多端体验。Pi 是内置运行时依赖；产品身份不再以 Pi 的外围应用来表达。
科研与未来办公能力可以沿同一品牌扩展，不需要为每种用途另起主产品名。

主品牌只使用 **Varin**，不强制扩成 Varin AI 或 Varin Harness，也不为名字编造缩写来源。
对外介绍根据受众说明工作台和 Agent 执行能力；内部包和技术边界按真实职责命名。
本阶段不改变 Agent/IDE 与通用/科研的两个界面切换，也不改变独立的工作侧重配置。

**当前没有需要照顾旧版本的用户，采用一次切换，不建设兼容层。** 新产品只读写新名称；
不保留旧 CLI 别名、旧环境变量回退、双配置目录、双写、旧协议接收器、旧包导出、旧更新通道或自动迁移器。
此前为了当前格式正常恢复而存在的事务、进程监督和故障恢复继续保留，更名不改变这些责任。

代码库及当前文档全部纳入范围；只换标题、Logo 或安装包不能算完成。实际 Pi SDK/包/原生数据、
其他第三方合同和来源归属按真实名称保留，不能全文替换所有 `pi`、`Pi` 或 OpenChamber 字样。

## 2. 命名合同

下表定义自有身份的目标。外部资源一栏是目标名称，不代表已注册、已迁移或已取得发布权限。

| 对象 | 当前形式示例 | 目标 |
| --- | --- | --- |
| 主产品与可见文字 | `Piarium` | `Varin`，各语言保持同一品牌拼写 |
| 技术前缀与 CLI | `piarium` | `varin` |
| 包命名空间 | `@piarium/*` | `@varin/*`；包括依赖、imports、exports 和 workspace filter |
| 仓库根包 | `piarium-monorepo` | `varin-monorepo` |
| 自有符号 | `Piarium*` / `piarium*` / `PIARIUM_*` | `Varin*` / `varin*` / `VARIN_*`，按实际语义处理 |
| 桌面应用标识 | `dev.piarium.desktop`，开发态 `.dev` | `dev.varin.desktop`，开发态 `.dev` |
| 移动应用标识 | `dev.piarium.mobile` | `dev.varin.mobile`，同步原生工程标识 |
| 系统服务标识 | 如 `dev.piarium.web` | 对应 `dev.varin.*` |
| Rust crate 与可执行文件 | `piarium-kernel`，平台后缀按现状 | `varin-kernel`，目录、Cargo、启动器和产物清单同步 |
| 自有事件、桥与协议标识 | `piarium:*`、`__PIARIUM_*`、`piarium.kernel.v1` | 对应 `varin:*`、`__VARIN_*`、`varin.kernel.v1` |
| 自有扩展、工作台与主题 ID | 如 `piarium.ide`、`piarium.research` | 对应 `varin.*`，默认注册与消费者同改 |
| 自有存储、缓存、临时文件前缀 | 名称中包含 Piarium/piarium 的路径或 key | Varin/varin；遵循原平台路径规范和 owner，不另造数据体系 |
| 新发行资产 | `Piarium-<version>-…` | `Varin-<version>-…`，校验和、更新清单和下载引用一致 |
| 外部托管目标 | GitHub `Youzini-afk/Piarium`、GHCR `piarium*` | 目标为 `Youzini-afk/Varin`、`varin*`，以实际可用和已配置资源为准 |

协议内容未变化时不为改品牌机械增加版本号；当前生产者和消费者一起采用新身份，不提供旧名称协商。
新安装包使用新的应用身份，不追求覆盖安装旧 Piarium。版本号沿正常发行决策处理，本设计不擅自移动 tag、
覆盖旧资产或重置版本序列。

## 3. 已确认的改动入口

以下是实施定位依据，不是全仓穷举，也不是第二份运行时配置：

- 根 `package.json`：根包名、`@piarium/*` build/test/lint filter、开发脚本和 `PIARIUM_*` 参数。
- `packages/web/package.json`：公开包 `@piarium/web` 与 `bin.piarium`；CLI 帮助和服务安装在其下游。
- `packages/electron/package.json`、`main.ts`：产品名、appId、Linux desktop 字段、产物名称与 GitHub updater。
- `packages/mobile/capacitor.config.ts`：appId/appName；对应 Android/iOS 工程、构建和安装脚本必须同步。
- `packages/protocol/src/types.ts`、`session.ts`、`packages/ui/src/lib/piariumEvents.ts`、`desktop.ts`：
  常量、恢复标记、SSE 事件和 preload 全局对象；需要追踪真实发送方、接收方及类型声明。
- `kernel/Cargo.toml`、`kernel/crates/piarium-kernel` 与 kernel 生成/构建/打包脚本：crate、协议、二进制和资源路径。
- `scripts/generate-product-brand-assets.ts`：当前直接消费 UI Logo 几何源，继续用同一条资产生成链。
- `.github/workflows/desktop-release.yml`、`docker.yml`：构建变量、镜像坐标、产物发现与发布引用。

实施时先从 Git 跟踪文件建立按责任划分的清单，搜索名称的大小写、文件名和间接生成位置。
依赖缓存、node_modules、build 输出及本地临时目录不作为源码替换对象；发现生成文件时先找到生成源。

## 4. 全面切换的工程处理

### 4.1 产品呈现与品牌资源

应用标题、输入区 Agent 身份、启动/空白/错误页面、关于页、设置、通知、安装/卸载、系统菜单、
Web manifest、网站元信息、社交预览和文档首页统一使用 Varin；翻译键与各语言值一起检查。
品牌名不翻译，周围说明保持本地化，旧“Pi 的前端”定位文案改为实际产品能力。

Logo 组件、可访问名称、资源文件和生成脚本采用 Varin 命名。名称切换时曾保留原方块 π 图标，
随后用户定稿为“回折”：上下横边向外延伸，上半条向右上、下半条向左下小幅错开。
`packages/ui/src/components/ui/varin-mark.ts` 保存定稿的两条折带；日常 UI、桌面/Web/PWA、托盘、
移动与 Widget 使用平面标志。开屏和工作台切换保留原正方体、相机与动效，只将同一份标志放到顶面。
应用图标采用浅白底、深色双折带；Android 自适应图标的独立背景与前景采用同一配色。
加载动画顶面的标志跟随开屏配色：浅色正方体配深色折带，深色正方体配浅色折带。
`branding:generate` 与 `splash:emit` 分别生成静态资产和预绘制启动页，禁止在各端另画近似形状。

重复的可见品牌值沿现有配置/组件适度收敛；平台 manifest 可以由已有构建工具生成。
不为这次更名引入可切换多品牌框架、运行时品牌服务或逐渐启用的 feature flag。

### 4.2 包、模块与原生构建

变更 workspace package 名及全部实际引用，包括动态 import、别名、TS paths、Vitest/Vite/Bun 配置、
测试夹具、打包排除/复制规则和 Cloud production manifest。Bun/Cargo 与独立 cloud runtime lock
通过对应工具更新，防止开发树能解析而生产安装仍引用旧包。

有自有品牌语义的源码/目录/文档文件一起更名并更新链接、生成器和导入；不保留只转发到新位置的旧文件。
`pi-host`、`pi-runtime` 等实际表示 Pi 适配职责的模块名可以继续保留；其中自有 `Piarium` 品牌符号照常更改。
上游包内部名字、补丁目标、第三方发行 URL 和原生 Pi 格式不能跟着品牌误改。

Rust crate、协议生成源、TS 生成输出、构建产物 manifest 和 Host 二进制查找共同更新。
旧本地 dist 或旧 kernel 可执行文件不能为新命名提供偶然成功的依赖；验证新产物时从实际输入重新生成。
更名不顺带升级依赖、重写进程划分或改变打包能力。

### 4.3 通信、注册与运行时身份

HTTP/SSE、WebSocket、worker/broker、Electron preload/IPC、kernel、Surface 注册、内置扩展 ID、
协议 scheme 和实际存在的发现/服务标识按发送→路由→接收的完整链修改。通用方法名、第三方协议字段和
没有品牌含义的 ID 不改。不能只改类型和文案而让运行时仍发旧事件。

自有权限、来源和会话标记随新身份同步，但不改变其授权边界；名称相同并不替代认证。
不为新旧客户端互通增加协议分支。桌面、Web、移动和远端 Host 应使用同一套更名后的合同。

### 4.4 配置、凭据与本地数据

新版本只使用新自有目录、设置 key、数据库/缓存命名、cookie、localStorage/IndexedDB key、环境变量、
自有凭据 service key、临时目录和系统启动注册；各 owner 继续管理原来的数据职责。
支持显式自定义路径的正常能力保留，不把“没有旧路径 fallback”变成“禁止用户选择已有路径”。

原生 Pi 配置、AuthStorage、会话 JSONL 和上游读取规则保持真实 authority；不能把共享 `.pi` 目录改名或删除。
第三方 OAuth 回调、OS keychain 及签名标识如确实包含自有品牌，需同步它们实际登记方，不能猜改一个字符串就算生效。

没有旧版本迁移目标，也不自动扫描、复制、合并或删除旧 Piarium 数据。开发者的源码、Git、实验产物、凭据和
外部配置仍是已有成果；具体要保留的数据另做一次性人工操作，不进入产品代码或常驻“升级助手”。
清理确定可再生的输出时限定到已核实路径，不使用跨用户目录的全局匹配删除。

### 4.5 仓库、发行与部署

现有仓库改名优先于新建仓库再复制，保留 Git 历史、issue、PR 和既有 tag 的事实。
当前 README、源码/发布链接、clone 命令、包元数据、镜像名、compose、systemd/launchd/桌面入口、
更新 feed、release asset 匹配器、checksums 和 optional component 下载坐标一并梳理。
新版本的服务、CLI、镜像、安装包和自动更新使用新名称；不维持两套发行产品或依赖旧地址重定向作为正式配置。

外部仓库、npm scope、镜像 registry、域名、OAuth/签名后台和 CI secrets 的状态必须据实确认。
`@varin/*` 可以作为本地 workspace 合同设计，不能据此声称 npm scope 已可发布。若目标资源不可用，
明确具体冲突并单独决定该分发坐标，不悄悄恢复旧品牌或扩出通用兼容框架。第三方约定的环境变量名保持不变。

更名实施与新版本发布分别处理，不自动注册购买域名或覆盖历史发行。实施阶段在已有授权内准备完整仓库改动和可核对的
外部操作清单，已有更名/发布授权直接使用，不重复询问；确实缺少授权时只针对那项动作确认。
仓库外某个地址尚未切换与内部代码未完成分别记录，不把占位地址标为可用。

### 4.6 文档、历史与归属

当前 README、AGENTS、设计、实施说明、API/CLI 帮助、用户文档、包文档和示例统一新名称，并更新品牌化文件名
及入站链接。过去的 changelog、追加式决策正文、旧发行资产和 Git 提交保留当时的名称；当前索引可以解释更名。
来源、版权和许可证中的真实作者/项目归属不改写成 Varin，不改写第三方历史。

验收看当前产品是否统一，不要求仓库任何字节都不存在 `Piarium`。残留按“当前自有名称遗漏、真实上游名称、
历史记录”作具体判断，不新增永久品牌扫描门禁、巨大例外名单或对源码字面量的固定计数测试。

## 5. 实施顺序与交付判断

阶段 B 优先于尚未实施的阶段 F，避免快速决策模型的新代码继续扩大旧命名。
B0 固定映射和真实入口；B1 完成包/构建/运行时/存储合同；B2 完成呈现和品牌资产；
B3 接齐发行、部署和当前文档；B4 通过适量真实链路检查收口。它们是同一次切换的工作切片，
不能把只有显示名更新的中间态发布为“全面更名完成”。不等待每个切片各跑一遍全量 CI。

交付证据选择实际可能出错的连接处：

- workspace 与生产依赖按新名称解析，kernel 与 Host 启动器消费同名的新产物。
- 现有类型/lint 和相关行为覆盖能检出漏掉的引用；一次合适的构建确认生成与打包路径，不重复建设测试矩阵。
- 以新自有数据目录启动当前可用 surface，确认 UI、Host、worker/kernel 通信和一项真实工作能力接通。
  现有 packaged smoke 可以复用，不要求手动遍历所有设置或每个平台重新验收全部功能。
- 发行文件名、manifest、feed 和 optional component 坐标成套对应；未实际发布或未测的平台明确记录。
- 当前文档、用户入口和新产品资源不再依赖旧名字；历史和上游命中解释清楚，代码里没有新加兼容分支。

本阶段不新建 benchmark、付费模型验证或全量跨平台手工回归要求。发现具体链路问题就修复并验证受影响部分。
交付报告分别说明源码/产品完成度、外部资源切换、产物及实际验证，不能用“替换了多少处”代表功能正确。
