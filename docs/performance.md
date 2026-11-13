# 性能：成本、边界与测量

衡量改动的标准是用户实际感受：流式输出是否顺畅、操作是否及时响应、结果是否正确、多端是否一致、断线后能否恢复。
合成路径变快不等于模型延迟下降、provider 缓存更好或安装产品启动更快，这几件事要分开看。

## 成本与边界

**成本集中在哪里。** Host 到 Rust 的每次调用都是一次跨进程往返，在循环里逐项调用会把一个视图变成几十次往返；
对 IPC 做 `Promise.all` 也不会变成批量接口，因为另一端未必能并行处理。文件锁、fsync 和整文件重写每次是毫秒级，
Windows 上更慢。单个 SQLite 连接、单个 actor 线程或很小的请求窗口，会让所有经过它的工作排队。一个事件分发给
N 个观察者，每个观察者的反应成本都乘以 N；如果反应是“全部重拉”，代价随系统规模增长。

**信任边界在哪里。** 不可信的输入来自 renderer 和远端客户端的请求、扩展与 broker 消息、provider 与网络响应、
文件内容、外部进程输出，在这些入口检查有实际意义。Host 与 Rust 之间的私有 wire 是同一构建在认证 epoch 内的通道，
类型由 schema 生成，接收方解码得到的就是类型化的值；在两端或每一层重复做通用形状校验，不会多防住什么。
同一进程内由生产方给出的值也是如此。

**哪些事实可以复用。** 有的事实不会改变，例如 Thread 属于哪个主体，Run、Operation、Input 属于哪个 Thread。
有的只有一个已知写入方，例如主体列表、配对客户端。前者可以在进程内缓存，后者可以常驻内存，由写入方更新。
每次请求从磁盘加锁读取、甚至回写这些数据，只会增加延迟和串行。
普通设置文件仍允许外部写入，不能仅靠可能延迟的目录通知保证新鲜度；每次读核对文件签名，只复用未变的正文。

**耐久性的实际要求。** 断电丢失最后几次提交是可以接受的；数据损坏，或者记录引用了从未写入的正文，是不可接受的。
WAL 配合 `synchronous=NORMAL` 满足这个要求，前提是正文先写入，再提交引用它的记录。

**多余的防御。** 历史上积累的防御层（同一个值多层校验、按请求做文件事务的鉴权、递归扫描请求体收集 ID、
任何变化都全量重拉的观察者）让系统变慢，却没有让它更安全。判断一个检查值不值得留下，看它防的是不是真实存在的输入
或故障；不是的话，连同只为证明它存在的测试一起删掉通常更好。吞掉错误让路径“看起来安全”，往往只是把问题藏起来。

**锁与长工作。** Catalog、Storage 这类 owner 的临界段越短，排在后面的读写越少；长时间的读取、计算和物化放在临界段之外做，
取消和资源寿命照常由原 owner 负责。

各模块已经做过的具体优化写在对应的模块文档里，这里不重复，以免两处描述不一致。

## 当前实现入口

- [鉴权与主体](../packages/web/application-host/lib/ui-auth/DOCUMENTATION.md)、
  [设置缓存](../packages/settings-store/DOCUMENTATION.md)：热读取复用状态，写入仍走原耐久 owner。
- [Rust 读取](../kernel/crates/varin-runtime/README.md)、[私有传输](../kernel/README.md#transport-lifetime)：
  组合视图、独立读取连接与控制/正文调度。
- [客户端观察](../packages/application-client/README.md)、[UI 状态](../packages/ui/src/stores/DOCUMENTATION.md)：
  共享连接、精确失效与流式增量，不削减历史、列表或输出内容。

## 测量

同一 workload、同一构建类型的前后对比才能说明改动的效果，同时要确认结果仍然正确、用户感受没有变差。
现有脚本可以按需扩展：

```sh
node --import tsx scripts/measure-document-registry.mjs
node --import tsx scripts/measure-interaction-hotpaths.mjs /path/to/checkout artifacts/performance/host.json
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib measure_catalog_read_hotpaths -- --ignored --nocapture
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 engine
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 ipc
```

[measure-interaction-hotpaths.mjs](../scripts/measure-interaction-hotpaths.mjs) 可用同一脚本读取基线与修改后的 checkout，记录 Host Documents 文件操作、
前端嵌入解析/位置计算及快照调用计数。Documents fixture 未绑定 Rust 耐久存储；快照计数使用替身 native port，
不能当作完整保存或服务端执行时间。Catalog 的手动基准运行真实 SQLite owner。
[scripts/measure-kernel.mjs](../scripts/measure-kernel.mjs) 接受 `--compute-hotpaths`、输出 JSON 路径和 staged release executable。
实际浏览器 profiling 见 [scripts/profile-browser.md](../scripts/profile-browser.md)。

工作量计数（IPC 次数、快照与列表读取次数、渲染次数）通常比挂钟时间稳定，适合放进回归测试；挂钟数字受
cold/warm、平台和样本数影响，记录时说明这些条件更容易复现。对用户最直接的指标是首 token 延迟、流式增量间隔，
以及发送、取消、审批的反馈延迟。旧的测量数字保留在 Git 中，只对应当时的代码。
