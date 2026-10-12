# 已有 Bekko 本地嵌入接入原生推理

日期：2026-10-12。基线：`0ca05eb22be52dd9861afdf8010affb1bd83bd22`。

## 范围与当前合同

依据运行时设计 §12 的用途适配、计量和恢复合同，以及用户确认的已有本地 Bekko 组件，
本片接通原 `local-semantic` 执行器到 native 检索。没有增加另一套本地模型产品。
未配置 embedding 时使用已安装组件；显式 HTTP、disabled、invalid、unavailable 不暗中
转用本地。原 HTTP 设置 DTO、Pi/知识索引的启用条件保持，native 选择是单个 tagged lease。

- Catalog **61**、wire **21**：HTTP 与 local component 是显式执行器类型。本地保留原已
  验证 manifest digest、模型和协议身份，不制造 endpoint/credential；原 provider 和
  kernel 辅助生成消费者同步迁移，旧内部格式直接拒绝。
- 主任务与 child 的 query 和 fixed/materialized 文档向量都使用原 InferenceCall
  parent/ordinal、Operation、Goal 与 ContentStore。每个实际执行粒度单独保存事实，前台
  不借后台 index ledger；合法 cache 命中不产生计算或虚构回执。
- 共享 CPU worker 的 queued→dispatch-ready→原 source/grant/Catalog 校验→execute→
  started/settled 区分明确。native 不跨调用合批等待另一调用授权，普通 CPU 调度保留。
  queued 取消必须有未执行 ACK，active 观察者取消不等于物理停止，也不终止无关请求。
- execute 后丢失 started ACK 而 worker 退出只证明停止，`requestStarted` 保持 unknown；
  短 pending barrier 不把它压为 false。原结果、错误和已观察 usage 保留，重开不重跑。
  输入 tokenizer 数量明确为 estimated，encoder 输出零与未获得输入证据分开，无虚构价格。
- 原组件/查询/scan 引用维护模型代：替换只影响新准入，旧调用保持原代；相同字节重新导入
  复用原代。关闭先释放选择并实际停止所属 worker，再等待 callbacks/retirement，避免等待环。

## 实际组合与证据边界

四条原 Rust stdio 用例已串行通过：

1. 原 component manager 导入归档、真实验证子进程与 worker、active pointer、默认本地
   选择、fixed_branch/materialized Source、Catalog/Goal、历史及重开。完整 warm cache
   的第二次同查询没有新增 worker 请求。
2. 原 child dispatch/profile/source/Run 路径，嵌入 Operation 归属实际 child，结果进入其历史。
3. queued 与 active 取消贯穿原 Catalog/Goal；未启动事实、实际排空、晚到向量和无关共享
   请求分别检查，没有用 rejected Promise 代替停止证明。
4. 多粒度请求先成功后失败，原成功计量与真实错误正文均保留。

真实 worker 层另外覆盖排队时 source 栅栏、完整调用间隙的退休 pin、started 后退出保留
usage；Host 原 owner 验证候选未完成时的关闭以及禁用/无效配置不回退。组件旧格式拒绝与
错误投影沿原安装/启动读取检查。上述模型模块输出受控，实际 ONNX 权重、质量、真实硬件
吞吐与延迟尚未在本片执行。

重型用例并行时曾使 materialized 首次查询出现合法 partial：原正文明确 unavailable=1，
第二次补算之前缺失的 b.ts，query vector 本身命中。没有修改产品 deadline 或强制扫全；
最终按串行资源隔离，并先确认完整覆盖，再断言整个缓存路径零新增计算。

独立审查已接受本片。另一个最小探针让真实 worker 在 execute 后、started ACK 前退出，
原 Host 保留 `requestStarted:null` 与 missing usage；第一次回执发布失败后只重投原事实，
admit、dispatch、execute 各一次。该探针的 Catalog RPC 受控；原 Catalog 的 Unknown、
Goal、重开及晚到 refinement 由 Rust 用例单独覆盖，不把两者混称一个完整产品测试。

旧 HTTP 组合回归也已通过：原 embedding/rerank 共用 session 并保留重开用量、取消后等待
实际响应体排空，以及 progressive decision 多行动/多批次保留同一查询 owner。服务响应
字节受控，没有访问真实付费模型。Host 聚焦用例、组件格式/诊断、完整 Web aggregate 类型
及当前协议的 Rust 二进制构建均通过；最终产包结果下述记录。

Host、CLI、Web/PWA 与 cloud runtime 原产包路径通过，协议生成检查、变更文件 lint 和
文档本地链接检查通过。Linux x64 debug 内核使用产品身份 0.9.25、wire 21；原 target、
Web stage 和 cloud tree 三份 SHA-256 都是
`b3b4f0fc8c7474590fe6fa4bcd9d10bc00ecbb2c16a1d9ab31438a710099bbbe`。
这是构建及 staged 布局证据，没有把 debug 包作为 release 性能或已安装产品启动的证据。

## 复跑和组件交付

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel installed_local_encoder_ \
  -- --ignored --nocapture --test-threads=1
bun run --cwd packages/web test -- application-host/lib/knowledge/semantic/local-worker.test.ts
```

先按仓库脚本构建当前 protocol/Host 等依赖。Rust↔Host 为原测试 stdio，组件验证和 broker
分别使用原 Node 子进程/Worker 通道；这些结果不代表完整产品监听 IPC 或各桌面平台验收。

组件当前 manifest v3 / worker protocol 1。原 v2 文件保留，但新 Host 不启动旧 worker；
需用当前 `scripts/build-local-semantic-component.mjs` 构建并导入 v3 归档。builder、安装器与
active reader 使用当前合同，错误提示要求重建/导入，没有旧协议适配或迁移器。本片没有
下载真实权重或发布 Release 组件；真实 ONNX 包构建/安装仍是交付验收项。

默认 runtime 切换、Pi 删除与用户资产迁移继续由用户验收后处理。更广扩展冻结依赖/共享
实例生命周期、容量反馈与剩余两设计能力仍在后续范围。
