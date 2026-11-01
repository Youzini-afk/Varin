# 性能边界与测量

在理解身份与寿命的 owner 内减少工作，避免跨进程搬运大中间结果或每个事件重建派生状态。
合成路径变快不等于模型延迟下降、provider 缓存更好或安装产品启动更快。

## 当前取舍

- Documents 按已提交 registry 惰性建立 ID/path 索引并共享冷加载；失败候选不发布索引。热精确查找变轻，首次索引和全列表仍随规模增长。
- Node IPC 直接校验已解码 envelope，不第二次 stringify/parse；文本 framing 仍有 decoder。Rust control/content 分开保护取消元数据。
- Thread projection 分开读取持久历史和临时输出，重连按原事件 cursor 追平；UI 更新成本与实际浏览器帧率仍需独立测量。
- Knowledge 在 storage owner 内完成 revision 检查及完整 block 评分，只传紧凑 document score。
  首次索引和高维评分仍有成本；authority/semantic 进程分离保护无关写入。
- Native compute 复用捕获 digest，每语言只缓存最近完整 tree-sitter recipe。编译失败保留旧缓存；频繁换 recipe 会重编译，
  换来不随历史数量增长的内存。
- 支持的 Linux namespace 观察复用未变路径 inventory，fence 仍遍历 watched directory；
  Windows/unknown coverage 完整核对目录。此机制只减少命名空间枚举，不决定正文能否复用，见[Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md#filesystem-observation)。
- 物理基线合并普通路径和显式范围，先捕获，再按原物理状态验证。Rust 在源原生身份/change time、
  已验证对象及其对象身份仍匹配时复用正文事实；未命中或身份不可用时重新读取、哈希和校验，
  不只靠 size/mtime 判断未变。复用缓存不持有对象，GC 后不能借旧缓存恢复已释放正文，重启也不保留缓存。
  入口见 [capture_resources.rs](../kernel/crates/varin-kernel/src/storage/capture_resources.rs)。
- Native Workspace adoption 另走已打开句柄的 clone/reflink，成功后读取固定副本计算 hash；不支持时流式导入。
  结束仍核对来源身份、change time、属性和目录变化，控制文件另作内容验证。后续原生分叉共享不可变树与 dirty 区间，
  不重新捕获原目录。CoW 减少复制不等于免除正文读取、哈希、对象提交或元数据成本，也不构成已测速度结论。
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
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 engine
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 ipc
```

`scripts/measure-kernel.mjs` 接受 `--compute-hotpaths`、输出 JSON 路径和 staged release executable。
比较双方使用明确源码、相同 toolchain/config/corpus；版本字符串相同不能证明 binary 来源。
实际浏览器 profiling 见 [scripts/profile-browser.md](../scripts/profile-browser.md)。

结果同时写清 cold/warm、fixture、平台、样本数、分位定义、工作计数和内存采样方法，先验证输出一致再解释速度。
阶段 RSS 不是峰值，两次 warm 观察不是稳定延迟分布，序列化返回体积不是精确网络流量。
回归优先断言实际工作和结果，不依赖脆弱的挂钟阈值。

旧测量批次保留在 Git；新性能结论需要当前改动对应的 workload/revision，不能把历史数字当作本分支认证。
