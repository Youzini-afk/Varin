# 性能边界与测量

在理解身份与寿命的 owner 内减少工作，避免跨进程搬运大中间结果或每个事件重建派生状态。
合成路径变快不等于模型延迟下降、provider 缓存更好或安装产品启动更快。

## 当前取舍

- Documents 按已提交 registry 惰性建立 ID/path 索引并共享冷加载；失败候选不发布索引。热精确查找变轻，首次索引和全列表仍随规模增长。
- Pi Thread Registry 复用已提交 catalog 身份/派生索引，同时保留目录发现及重启/损坏检查。Catalog 写入仍是整份工作。
- Node IPC 直接校验已解码 envelope，不第二次 stringify/parse；文本 framing 仍有 decoder。Rust control/content 分开保护取消元数据。
- Pi timeline 保持历史 row，只更新 live overlay，overlay 绑定实际 row generation，避免复用 row 借到新内容。
  这减少 React 工作，不是浏览器 FPS 保证。
- Knowledge 在 storage owner 内完成 revision 检查及完整 block 评分，只传紧凑 document score。
  首次索引和高维评分仍有成本；authority/semantic 进程分离保护无关写入。
- Native compute 复用捕获 digest，每语言只缓存最近完整 tree-sitter recipe。编译失败保留旧缓存；频繁换 recipe 会重编译，
  换来不随历史数量增长的内存。
- 支持的 Linux namespace 观察复用未变路径 inventory，但仍哈希所有捕获正文，fence 仍遍历 watched directory。
  Windows/unknown coverage 全量检查，见[Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md#filesystem-observation)。
- 文件基线先捕获并保存正文，再用原始物理状态作一次完整验证读取；显式范围与普通路径共用这次正文验证。
  常规文件由四次源读取降为三次，原先重复验证的范围文件由六次降为三次。对象校验、目录枚举和存储写入另计，
  这不是跨捕获的正文缓存；每次仍读取全部选定正文。
- Agent 请求按实际协议复用不可变 item 或完整消息组、工具 schema 和精确选定 wire bytes；
  工具结果复用同时核对原调用依赖，末组变化只重编该组。编译复用、provider 前缀缓存、真实计费应分别测量。
- Agent 压缩按 DAG 的就绪队列并发执行模型节点，归并节点在自身依赖完成后立即启动；
  原始材料一次加载，节点只读取自身依赖回执。模型响应时间与实际并行收益仍取决于服务端。

长 read/compute/materialization 在短 Catalog/Storage owner 段之外执行，但保留原取消和资源寿命。
提前返还 transport credit 不得提前释放物理 reader/writer；真实回执和背压优先于表面上的即时取消。

## 现有工具

在隔离 fixture 上记录精确 source/binary 身份。命令以 package.json 为准，不为局部修复另建 benchmark 框架。

```sh
node --import tsx scripts/measure-document-registry.mjs
node --import tsx packages/web/scripts/thread-registry-perf.ts
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 engine
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 ipc
node packages/runtime-broker/scripts/measure-ipc.mjs
VARIN_PERF_UI=1 bun run --cwd packages/ui test src/components/pi-session/PiTimeline.streaming.test.tsx
```

`scripts/measure-kernel.mjs` 接受 `--compute-hotpaths`、输出 JSON 路径和 staged release executable。
比较双方使用明确源码、相同 toolchain/config/corpus；版本字符串相同不能证明 binary 来源。
实际浏览器 profiling 见 [scripts/profile-browser.md](../scripts/profile-browser.md)。

结果同时写清 cold/warm、fixture、平台、样本数、分位定义、工作计数和内存采样方法，先验证输出一致再解释速度。
阶段 RSS 不是峰值，两次 warm 观察不是稳定延迟分布，序列化返回体积不是精确网络流量。
回归优先断言实际工作和结果，不依赖脆弱的挂钟阈值。

旧测量批次保留在 Git；新性能结论需要当前改动对应的 workload/revision，不能把历史数字当作本分支认证。
