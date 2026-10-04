# 关键路径性能设计与测量

Status: implemented and locally measured — synthetic workloads, not an end-to-end release benchmark.
Last updated: 2026-10-04

本次改造覆盖 Documents Registry、Thread Registry、Node IPC、Pi 聊天时间线、Knowledge 检索与 Rust 文件/结构计算六条路径。目标是删除重复读取、重复序列化、跨进程搬运中间结果和每次增量重建历史数据的工作，把缓存绑定到实际权威状态及其生命周期。

原始测量数据、环境和适用范围见 [performance-critical-paths-20261004.json](performance-critical-paths-20261004.json)。源码、测试和各模块文档仍是契约权威；本文记录设计理由、测量条件、结果及复现入口。

## 1. 环境与证据边界

- 基线源码：`438b60c40287fa73c63f0b58fec349e5676d7ea5`。
- 优化后实现源码：`762558c505b8c1e7f2e61ee0ce6468e002194141`；性能文档单独提交，以上 commit 已包含五组生产代码变更。
- Windows x64，OS release 10.0.26200；AMD Ryzen 5 5600GT，12 个逻辑处理器，系统识别的物理内存约 31.3 GiB。
- Node 24.18.0、Bun 1.3.14、Rust 1.97.1 / MSVC release、TriviumDB 0.8.8。
- 最终计时任务串行运行，没有同时运行本次任务启动的构建或测试；不清空 OS 文件缓存。所有数据均由 fixture 生成。
- Documents/Threads 的 before 使用从基线 commit 导出的源码；Knowledge/IPC 脚本保留旧算法仅用于测量，生产路径只有新实现。
- Kernel before 从该 commit 的完整 Kernel tree 重建，before/after 使用同一 toolchain、release 配置及 emitted Host adapters。以 binary SHA 和 source provenance 识别二进制，不把版本号当作源码证明。
- UI 性能用例正文保持一致，但最终 mock 增加了代际回归所需的 Hook，同行测试集合也有变化；计数可直接比较，耗时仅作同规模参考。
- 下列结果没有包含模型服务延迟、真实浏览器布局/绘制、实际用户大库或所有平台的启动体验。内存阶段采样也不等于峰值内存。

## 2. 设计改造

| 路径 | 原有成本 | 实现与生命周期 |
| --- | --- | --- |
| Documents Registry | 每次按 ID/路径线性扫描；包含路径还需过滤排序；并发冷读与同根创建重复读写 | 对已发布不可变 document 建立惰性 ID/路径索引；包含查询逐级寻找祖先；共享进行中的冷读；排队创建重查已提交状态 |
| Thread Registry | owner 查询反复读取、解析已经缓存的全 catalog；快照对每个 Thread 扫描全部 Runs | 以已提交 catalog 身份建立派生索引；跳过已经持有且路径一致的 catalog；并发目录发现合并；草稿继续使用直接读取 |
| Node IPC | Node 已解码对象再次 stringify/parse；Host 端为每条消息创建文本 decoder | 原 envelope 校验抽为同一 `validateEnvelope`；两侧直接校验 Node JSON IPC 对象；文本 framing 仍由字符串 decoder 处理 |
| Pi 时间线 | 每个 live delta 替换全量列表 data；未打开的导航菜单仍读取全部历史提示并创建条目 | 稳定历史 rows 与 live overlay 分离；overlay 进入 renderer/extraData；导航打开后才读取提示；派生索引跟随 rows 身份 |
| Knowledge | 每文档一次 revision IPC，再取全部 block body 到 Host 聚合 | 存储 owner 在同一个排队操作中校验 revision、计算每个文档精确最佳 block 分数，再返回精简 document scores；reconciliation 一次读取紧凑目录快照 |
| Rust compute | 同一份文件字节重复整文件 SHA；同一 grammar/recipe 每文件重新编译 Query | 捕获时生成的 digest 同时供给对象身份、revision 和 contentHash；每个 language entry 保留最近 recipe 的编译结果，按 immutable recipeId 复用 |

### 保持权威状态清晰

两个 Registry 的索引都依赖**已经成功发布的对象**。失败候选不进入读索引；成功原子写入后才替换权威对象，对外返回值保持隔离。Thread catalog 的 clone/write/publish/notify 顺序和写入频率未改，正常目录发现、显式重启协调与损坏状态重验仍执行。

Knowledge 的新私有方法 `searchDocumentScores` 将 revision 校验和评分放在同一个 owner 操作内，中途没有 publication 插入点。每篇有效文档的完整 block 集合都会评分，所有文档完成后才做 document Top-K，避免先截断全局 block Top-K 而挤掉短文档。最终召回仍重新核验 accepted/content authority；负分、数值 ID 同分排序、取消和关闭排空均有行为覆盖。私有存储进程协议由 3 升为 4，数据文件格式不变。

UI 的 live overlay 显式绑定 **row 对象身份**。独立审查通过实际 LegendList 源码确认了“旧 assigned row 配当前 render callback”的合法转场。修复后，已退场的 standalone row 返回空行；旧 persistent row 保留自身快照，同 ID 的新一代 row 不能借用旧代内容。撤回、持久化及时间戳变化都由回归覆盖。

Kernel Query 缓存直接属于 language entry，没有按历史 recipe 持续增长的第二张 Map。每个已缓存 language 最多保留一份完整 recipe；全部 Query 编译成功后才替换，失败仍保留旧项。既有 32-language 重置与 worker 退出会一起释放缓存，替换期间新旧对象可以短暂共存；旧 recipe 随时可重新编译执行。

模块依据：

- [Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)
- [Harness / Thread Registry](../packages/web/application-host/lib/harness/DOCUMENTATION.md)
- [Protocol](../packages/protocol/README.md)
- [UI state / projection](../packages/ui/src/stores/DOCUMENTATION.md)
- [Knowledge vector runtime](../packages/web/application-host/lib/knowledge/vectors/DOCUMENTATION.md) 与 [semantic store](../packages/web/application-host/lib/knowledge/semantic/DOCUMENTATION.md)
- [Kernel](../packages/web/application-host/lib/kernel/DOCUMENTATION.md)

## 3. 测量结果

### Documents：索引代替重复路径计算

真实 Registry 实现，10,000 个根目录，内存文件系统 fixture；每组 100 次查询，3 轮中位数。计时包含 Registry 逻辑，不代表真实磁盘延迟。前后各校验了 900 个查询结果。

| 场景 | Before | After |
| --- | ---: | ---: |
| 100 次 ID 查询 | 7.959 ms | 0.091 ms |
| 100 次精确路径查询 | 653.023 ms | 0.191 ms |
| 100 次最近包含目录查询 | 983.785 ms | 0.586 ms |
| 32 个并发冷查询的文件读取数 | 32 | 1 |
| 16 次并发同根创建的写入/rename 数 | 16 / 16 | 1 / 1 |

索引需要付出首次建立成本：首次 ID 查询为 **3.488 → 4.585 ms**；紧接其后的首次路径查询为 **0.010 → 12.850 ms**。旧实现这一项恰好命中数组第一项；新实现会建立完整路径索引，因此不能把预热收益描述成每个冷请求都更快。路径索引单独惰性建立，只按 ID 查询不会承担该成本。

### Threads：保留新目录发现，删除反复丢弃的 catalog 读取

3 个 scope，每个 1,000 个 Thread / 4,000 个 Run，总 catalog 9,874,242 字节。使用真实临时目录；结果克隆计入耗时。普通查询 8 次、单 Thread 查询 800 次，均取排序后 0-based `floor(n/2)` 项，即偶数样本的上中位观测，不是两中间值的均值；冷快照和并发批次各一次。

| 场景 | Before | After |
| --- | ---: | ---: |
| 冷 scope 快照 | 126.634 ms | 89.885 ms |
| 热 scope 快照 | 30.175 ms | 13.239 ms |
| 单 Thread 快照 | 0.059 ms | 0.013 ms |
| 无绑定 session owner | 280.161 ms | 0.302 ms |
| 历史 session owner | 275.794 ms | 0.165 ms |
| 8 个并发无绑定查询整批 | 2,132.712 ms | 0.265 ms |

8 次 owner 查询的 catalog 读取为 **24 次 / 78,993,936 字节 → 0**。顺序查询仍执行 8 次目录发现；8 个并发查询共用 1 次发现。新 scope、失败后修复的 catalog 和显式重启重新读取的语义都有测试。

### Knowledge：计算留在 owner，跨进程只交付分数

1,000 篇文档，每篇 8 个 block，每 block 2,048 字节，**二维合成向量**。使用真实 TriviumDB；每一对旧/新调用都深比较完整结果。首次新查询会建立 document-block 索引；之后只有 2 个 warm 样本，表中明确使用均值，不作统计显著性推断。

| 场景 | Before | After |
| --- | ---: | ---: |
| Engine 首次观察 | 299.232 ms | 148.254 ms |
| Engine warm 两次均值 | 275.634 ms | 46.216 ms |
| Engine warm CPU 两次均值 | 296.5 ms | 55.0 ms |
| IPC 首次观察 | 496.870 ms | 179.723 ms |
| IPC warm 两次均值 | 456.147 ms | 48.993 ms |
| 每次检索的 IPC 请求数 | 1,002 | 1 |
| warm 响应返回值序列化体积 | 18,632,663 B | 51,024 B |

返回值序列化体积下降约 **99.73%**。字节数来自 Node V8 对参数/返回值的序列化，不包含完整传输 framing；不应标为精确网络流量。新查询仍校验当前文档 revision，仍对候选文档评分；首次 document-block 索引加载成本也仍存在。二维 fixture 用于隔离 owner/IPC 开销，不能外推为高维真实 embedding 的同等加速比。

### Node IPC：删除第二次 JSON 往返

真实 Node 子进程，`serialization: "json"`，每次携带增长中的完整 assistant 前缀和 32 字节 delta；3 轮交替运行取中位数。修改后调用实际构建产物中的 validator。

| 场景 | Before | After |
| --- | ---: | ---: |
| 256 条消息，最终 8 KiB，整批 | 8.278 ms | 5.795 ms |
| 2,048 条消息，最终 64 KiB，整批 | 189.481 ms | 119.173 ms |
| 2,048 条消息，接收校验累计 | 84.673 ms | 0.401 ms |

大场景整批耗时下降 **37.1%**，每轮消息数、连续序号、累计正文 67,141,632 字节均一致。该结果是传输 fixture 的吞吐变化，没有包含模型或 UI 时间。

### UI：增量更新不再遍历全部历史提示

2,000 轮历史、100 次 delta，运行真实 React Timeline owner；列表布局、弹层定位和消息内容被隔离。

| 工作量 | Before | After |
| --- | ---: | ---: |
| 历史提示内容读取 | 200,000 | 0 |
| 全量列表 data 引用替换 | 100 | 0 |
| 参考耗时 | 1,111.810 ms | 54.676 ms |

性能用例正文未改，但最终 mock 为代际测试增加了少量 Hook/判断，同行测试集合也不同。这两个耗时值仅作为参考，**不能算作严格同设施 A/B 的加速倍数，也不是浏览器 FPS**。自动回归断言工作量与实际可见 live 内容，不设置易抖动的时间阈值。

### Kernel：同源码配置、同结果身份的原生比较

31,450,000 字节文件的无命中 live/pinned search，以及 128 份不同 TypeScript 文件的结构分析（总 12,324 字节）。每组记录 first call，2 次 warmup 后收集 8 个正式样本；corpus 创建和 object upload 不计入操作耗时。分位数使用 nearest-rank：排序后取 `ceil(q × n) - 1` 项，因此此处 p95 是 8 个样本中的最大观测。

| 场景 | Before p50 | After p50 | Before p95 | After p95 | p50 降幅 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 31.45 MB live search | 107.471 ms | 77.038 ms | 108.466 ms | 78.196 ms | 28.3% |
| 31.45 MB pinned search | 92.087 ms | 76.149 ms | 105.823 ms | 78.048 ms | 17.3% |
| 128 files structure | 3676.992 ms | 183.953 ms | 3784.001 ms | 197.676 ms | 95.0% |

Before binary SHA：`69a5a41b9ef73bceff669a731e09519efd1d16c9b61746a9ac5a532f0c9be1b2`。

After binary SHA：`b82481315030ac9fe938b1dbb8904fb6705d6f6be296f4c7c31ad61f0361aa57`。

两份测量的 corpus、结构结果及脚本 SHA 完全相同。结构结果 SHA 为 `1f49cb4155381514d83c51f51a13e3be28b4bd7262cf6c60f37ef63f7ff29771`；first structure batch 为 **3662.476 → 248.332 ms**。操作后两进程合计 RSS 阶段采样为 135.98 → 131.71 MiB；这里只记录观察，不将其解释为峰值内存收益。

按源码调用路径，live search 的整文件 SHA 从 3 次降至 1 次，pinned search 从 2 次降至 1 次；live structure 从 4 次降至 1 次。它们是调用路径分析，不能把计时反推成运行计数。Rust 回归另外验证 8 个不同文档共用 3 次 Query 编译，同时保持各自的 symbol/call/import 结果。

## 4. 复现入口

在已安装依赖的仓库中，从根目录运行：

~~~powershell
node --import tsx scripts/measure-document-registry.mjs
node --import tsx packages/web/scripts/thread-registry-perf.ts
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 engine
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 ipc
node packages/runtime-broker/scripts/measure-ipc.mjs
~~~

Knowledge 脚本使用脚本自身的模块路径，以上根目录命令可解析同一份源码和依赖。UI 从其 package 运行：

~~~powershell
$env:VARIN_PERF_UI = '1'
bun run --cwd packages/ui test src/components/pi-session/PiTimeline.streaming.test.tsx
Remove-Item Env:VARIN_PERF_UI
~~~

Kernel 需先通过标准构建入口 stage 两份确定来源的 release binary，再由同一个测量脚本及 emitted Host adapters 依次运行：

~~~powershell
node scripts/measure-kernel.mjs --compute-hotpaths artifacts/kernel-compute-before-exact-final.json artifacts/kernel-compute-before-exact/varin-kernel.exe
node scripts/measure-kernel.mjs --compute-hotpaths artifacts/kernel-compute-after-final.json artifacts/kernel-compute-after/varin-kernel.exe
~~~

`artifacts/` 是本地测量输出，不随 Git 保存。复现旧版 Registry 时，在隔离 checkout 中取基线源码、放入当前测量脚本，并让其解析相同 workspace dependencies；Documents 脚本也支持 `--module <baseline-path>`。Kernel baseline 使用 Git 导出的完整 `kernel/**`，相同 lockfile/toolchain/config；共享 Cargo target 时需要确保本地 crate 确实重编译，不能仅根据 staging 成功判断来源。最终对比的源码 provenance、二进制身份与测量结果摘要保存在同目录 JSON 证据文件中。

## 5. 验证

| 范围 | 结果 | 主要覆盖 |
| --- | --- | --- |
| Documents Registry / Authority / Watch | 47 passed | 冷读合并、失败提交不发布、返回值隔离、目录根和 Windows 路径 |
| Harness | 145 passed | Thread/Run、失败提交、归属发现、重启/损坏恢复、状态与环境消费者 |
| Protocol | 70 passed | 同一 envelope 校验及原错误行为 |
| Broker 聚焦 | 11 passed | 真实 JSON IPC、pending 失败、worker 退役和 identity |
| UI 核心 5 文件 | 37 passed | live 内容、导航、滚动、waiting、右键和旧行/新 callback 转场 |
| Knowledge 4 文件 | 37 passed | 精确文档排序、revision、accepted scope、重开、取消、关闭与进程故障 |
| Rust compute | 4 passed | digest 身份、损坏拒绝、Query 复用、配方替换/重访、取消 |
| Kernel native compute | 16 passed | 真实 release binary、live/pinned/opaque draft、中文/emoji/CRLF、背压和取消 |
| 三个 runtime 包的 dist smoke | 6 passed | 编译产物握手、外部 SDK、worker 复用、构造 |
| 已构建 Knowledge 的纯 Node smoke | 2 passed | CJS/ESM、写入和召回、结构关系及默认维度 |

所有工作区类型检查完成；首次集成检查发现的新增 benchmark 空索引与两个测试类型问题均已修复，只续跑受影响子步骤。完整 `bun run build` 通过，包含 Web、Electron 构建及 mobile assets；最终 Query cache 收敛后又重建、stage 并验证最终 Kernel，而未重复无关的前端构建。修改过的生产/测试 TS 定向 lint 和 `git diff --check` 通过。文档链接在提交前核验。

独立只读审查促成并再次确认了 UI 旧行转场修复与 Kernel Query 缓存收敛；Registry 原子发布、Knowledge 精确聚合/取消和 IPC 校验生命周期也通过审查。

## 6. 当前取舍

索引将重复线性工作换成了首次建立成本与派生内存。Registry 只按已发布代际保留派生索引；全文列表输出和 Thread catalog 写入本身仍有随数据规模增长的成本。Knowledge 首次建立 block 索引仍需加载其元数据，之后每次查询也仍执行当前版本校验和精确评分。

Kernel 每个语言只缓存最近 recipe，频繁在同一 grammar 的不同 recipe 间切换会重新编译，换来可控的缓存保留范围。每次仍重新读取文件并核验 grammar；协作式预算和 Query 编译不可中途打断的现有平台边界没有改变。file.scan 逐页检查目录漂移也保持原契约。

此次证据没有覆盖实际浏览器 FPS、真实模型交互耗时、跨平台安装包或长期大库峰值内存；这些不能由局部合成吞吐替代。各测量脚本可继续作为真实工作负载定位与回归观察入口。
