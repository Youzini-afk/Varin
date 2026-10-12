# 精确扩展版本的按需源码读取

基线：`8a31e917412e8204adb9293c444ec2daa206ffb7`。本片实现扩展设计 §8.1 的
不可变包源码纵切；Catalog **58**、私有 wire **18** 保持。独立设计/行为审查接受
本片有限交付。两设计整体尚未完成。

## 合同与原 owner

- `queryContracts` 与普通 `runtime_contract` 共用 `read/source` 请求、schema 和 decoder。
  原 service metadata 提供 selected/candidate 的 artifact 引用，读取必须指定精确
  extension ID、slot、artifact integrity 和包内路径。版本号相同不代表内容相同。
  candidate 引用只说明候选包身份，不把 selected 的方法描述冒充候选方法描述。
- 原 `ExtensionPackageManager` 核对当前 slot；原 `ArtifactStore` 检查内容地址、index、
  manifest 与文件 hash。读取完成后再核同一 slot，其他目录 revision 改变不重读。
  旧目录尚在磁盘不等于仍是当前 slot；旧请求明确 stale，不自动跟随新版本。
- list/describe 仍只读元数据。源码读取不激活 provider、不准备缺失 artifact、不读取
  原可变 checkout，也不生成第二源码缓存、安装器或授权表。包内代码作为数据返回。
- UTF-8 字节页默认 16 KiB；补全末尾码点最多多三字节，返回精确 offset/byteLength/
  totalBytes/nextOffset。BOM、Unicode、空文件、EOF、缺文件、非法范围/文本、损坏和
  I/O 不可用分别表达。每页仍以 64 KiB 异步块扫描完整文件核原 hash，仅保留请求页；
  多次小页读取会重复扫描，没有把这项成本称为缓存命中或性能优化。
- 原认证 route 与普通调用 scope/grant 保留。断开从目录准入到实际文件读取都传递同一
  signal；文件 stream 关闭才结束读取。目录 lookup 若在断开后拒绝，也按原取消结束，
  不发送迟到错误响应。Run 结果仍交原 ToolResult/ContentStore、Policy evidence 和历史。

## 真实组合与修复

实际安装的冷包 `host.cjs` 含 Unicode 与多页源码。安装后改 live 文件，原 model 直接
小页读取、SDK nested 多页读取、Policy ToolGraph/ReadResult 与 source-free child 都读到
同一已安装原文。cold activation 失败哨兵从未执行。原模型配对、子报告、两份 Catalog
GC/关闭重开与 Policy 原结果引用保持；受控的是模型选择和 stdio 交付，不是内容 owner。

公开消费者从真实 Web adapter 进入原认证 Express Router，再进原 runtime/package/
artifact owner；直接调用 Router，不启动监听。安装和 local reload 使用原公开 API；
候选最终 slot 发布由原 PackageManager 受控触发，不称完整 Surface 激活验收。

本片处理的实际问题：

1. source route 最初在目录准入后才接取消，准入期间断开仍可能开始读取。原 signal
   范围前移并覆盖失败返回。修前是源码确认，修后原 consumer probe 通过；没有修前红
   测试证据。无新 transport、额外状态或通用重试层。
2. 同 semver、同 descriptor 只改代码时，原候选持久发布与 registry 切换之间会把新
   artifact identity 与旧 active provider 配对。独审用原 supervisor/selectCandidate
   发布 gate 复现，修复以原 retained executing artifact 核对投影；旧实例和在途调用
   保留，当前声明与未就绪选择不冒充新实现已注册。此项以原失败探针修后复验为准。
3. 新测试 EventEmitter 的 contextual `this` 曾令正式类型检查报 TS2339；改为原
   response 对象的 `emit`，不放宽 compiler、添加 any 或排除测试。另一个 public
   selectCandidate 测试最初会合法准备 broker，改用受控 PackageManager 发布来隔离
   只读测试范围，未改变产品行为。

## 证据边界与复跑入口

冻结后的实际结果：

- 原普通工具/broker/SDK、model、nested、Policy、child、GC/重开 **1 条整链通过**；
  最终冻结依赖重建后复跑 6.72 秒。公开 direct Router 与原 Web adapter **13/13**。
- 原 metadata/source 两文件 **12/12**，含仅代码变化及 schema 变化的两个真实
  supervisor 发布 gate；共享 schema **4/4**。原 artifact/Surface 资源/Host 入口
  读取消费者 **15/15**，没有另建 source-only 校验器。
- 独立原反例修后通过。额外一次真实 stream 顺序探针为
  `first-data → metadata-returned → abort-requested → close → query-rejected`；
  拒绝当刻已 `closed=true`、`fd=null`，不是之后等待关闭才观察状态。
- 正式 `bun run --cwd packages/web type-check` 修后完整 exit 0，包含协议一致性、
  原 Host 生产/测试、browser 与 CLI。contract/Host 类型、变更 lint、diff 检查通过。
- 原 Host 生产构建与 Web 客户端 bundle 已更新；Web 使用已有 low-memory build
  配置，未称 React Compiler 优化或交互式 Surface 通过。构建仍报告既有未识别的
  `maxParallelFileOps` 选项和 CSS `::highlight` 提示，不将 warning 记为零。
  cloud-runtime 从本轮产物重新 stage；布局 **12/12**、生产边界 **7/7**。
- Rust 生产实现未变，沿用已验证的 wire 18 Linux x64 / `0.9.25` 二进制；源码中的
  Rust 变化只增强 opt-in 验收 fixture，不伪称重建了生产内核。

主要复跑入口：

- `packages/extension-host/test/runtime-source.test.ts`：原文件页/身份/取消。
- `packages/extension-contract/test/runtime-contracts.test.ts`：同源 schema/decoder。
- `packages/web/application-host/lib/extensions/contracts-consumers.test.ts`：直接 Router
  的实际 client/owner 消费，与原 Web adapter tests 一起运行。
- `agent_runtime::runtime_contract_review::current_catalog_and_frozen_sdk_tools_share_actual_model_policy_receipts_after_reopen`：
  `cargo test -p varin-kernel --lib` 的 opt-in `--ignored --exact` stdio 整链。
- `bun run --cwd packages/web type-check`：原完整 Host/browser/CLI 类型入口。

验证偏离单列：曾误执行既有 `routes.test.ts`，其 Supertest 会监听本机临时 HTTP 端口；
该进程已结束，不重跑，不把其 6 项或运行结果纳入本轮允许证据，也不由此推导产品
IPC/监听能力可用。新源码 consumer 的直接 Router 证据独立保存。

本片不代表所有 legacy service 元数据、完整 API/更广 UI 贡献发现、Agent 产包到原授权
候选及实际 Surface 挂载释放已经完成；也不提供 retired accepted-Run binding 的任意
源码访问。真实产品 IPC、设备/账号、全部平台与安装升级及组合负载仍须分别验收。
默认 runtime 切换、Pi 删除和全面资产迁移仍由用户验收后负责。
