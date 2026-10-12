# Scoped 服务依赖与组合寿命

实现基线：`916c70f52abb1a89814d8a5b3afef2509a49366d`。本片覆盖能力组合设计
§4.1、§5.1–§5.4、§8、§9、§11 的唯一选择、冻结依赖、共享实例及引用寿命。
独立审查的五条真实反例及原作者产包链发现的挂载回归均已修复并原路复验。
本片行为审查接受；类型与产包结果单列，不以局部测试代替产品验收。

## 当前合同

- 原 ServiceRoutingStore 是唯一可变选择权威。删除 registry、Surface、客户端和公开
  route 的旧全局 selection API；精确 provider ID 数组只是本次组合冻结的引用。
- requirement 明确声明非空 `realms`。Host 只解析 Host 依赖，Surface 只解析 Surface
  依赖，混合包的本地 Monaco 服务不再成为无界面 Host 的虚假依赖。没有缺字段补旧读法。
- 在 activate 前准备完整 DAG，包括原包、授权事实和每条 selected/single/all/optional
  边。相同图和实际依赖代共享实例；不同项目捕获 B/C 时得到不同 A 实例。Thread、scope
  或 routing revision 本身不制造实例。共享准备中一个等待者取消不影响其他真实等待者。
- binding、pin、在途调用各持有实际引用。普通替换只改变新选择；撤权沿确切依赖边传播。
  资源在原回调、disposer 和 transport 真正停止后释放。旧调用 pin 不冒充当前选择 scope。
- SDK 的 `services.use/useAll` 只消费 activate 前冻结的成员。嵌套 A→B 调用保留原
  Run/Operation/source/权限与取消事实，可信 Host 在验证实际边后委派原调用上下文；
  共享实例不保存某个 Run 的授权。
- 原生 WorkbenchLayout 的真实 registry owner 保留。它没有包 artifact，不制造假 host
  artifact 或 provider 别名；普通安装扩展、tool 和 policy 必须具备完整组合图。

## 持久与产品消费者

Catalog **62**、wire **22** 直接拒绝旧内部格式。tool binding 的图沿原 extensions 引用，
policy target 的完整图沿 ContentStore；Catalog 只保存短身份与引用。capture、正文写入、
publish 的原 Run/epoch/generation 栅栏和 publication 保活保留。GC 从 policy selection、
Run launch、delegated execution 的真实引用追踪。child 和恢复读取原保存图，不查询今天的
routing 来替换旧依赖；已失效的原包或授权给出不可用诊断，不自动重做效果。

Surface 每个实际 owner 用一个经过原认证的 POST event stream 持有组合。包括仅使用本地
服务的 owner，也由 Host 校验原 artifact、声明和授权。候选组先获得每个成员的 ready，
再进入原 Host/Surface publication；失败保留原可见资源。stream 关闭结束选择引用，已
受理调用独立排空。意外 EOF、错误或撤销使该组合失效，不重连后静默替换现有 handle。

实际产品 scope 来自原 session/runtime/目录/profile owner。service routing 的 workspace
沿原配置目录 namespace；Documents workspace UUID 交给原 Workbench layout/shell 解析，
profile ID 沿原用户 profile 选择，二者不互相冒充。Settings 从同一 local factory 和 mounted
registry 读取候选。

## 已执行的代表性证据

- 实际 broker 和 trusted-native A 在 activate 捕获 B/C；同图跨 Thread 共享、不同图隔离，
  all/optional 以及原整规则 allowFallback 保留。撤销 B 只取消 A→B，A→C 仍工作。
- 独立探针关闭并重开真实 Host：恢复原 frozen composition 调用 B，同 scope 的新准备
  使用当前 C；一个共享等待者取消后另一等待者成功，B 只激活一次。
- 实际 Web client → 原认证 Express Router → event stream → 原 broker 的整链，检查
  P/B 与 Q/C、P 改选 C 后共享真实 A/C、旧 P 仍调用 B、错误 owner/principal 拒绝。
  使用原 `createUiAuth` 签发的 Application Token 与真实跨域客户端 header；只有签发时
  的浏览器身份输入使用受控 fixture，实际 service 请求没有测试专用 bearer 绕过。
  POST 请求正文结束不关闭响应 lease；真实读者 detach 后旧方法继续排空，完成才退役 A/B。
- 原工具调用链验证共享 A/B 接不同 Run 的原 Operation；只读父调用不会因为 B 有写入
  grant 就获得写权限。合法调用保留原效果回执，取消等待真实嵌套工作结束。
- 原 policy Catalog 用例包含超过 1 MiB 的 4096 节点图：独立正文读写不占 Catalog 锁，
  短记录不内联图，在途 publication、旧/新 selection、launch 经 GC 和重开保留。
- 原预算消费者实测修复同 artifact 重新 activate 后沿用旧配置缓存的问题；值缓存加入
  实际 provider generation，不持 worker，仍复用当前实例的无关 routing 变化。
- 原编辑器消费者实测修复切换 Host 后、异步 workspace 重新解析前读到旧 Documents
  workspace ID 的窗口；原 getter 核对 runtime generation，保留 Windows 路径等价。
  当前 profile ID 并不由 workspace override 改变，没有将它错误记为 profile 故障。
- 原 Rust Engine → Host stdio → Agent 产包 → 原启用/更新 → 实际 Loader/Workbench
  的普通与 grouped 两条业务链分别通过。覆盖首装禁用、合法启用、动态工具、候选失败
  保旧、完整就绪组、旧 pin 排空和结果恢复，模型响应受控；不是只构造 manifest 的测试。

## 独立反例及修复

1. Host 候选 A→B 在最终计划复核后、进入 Catalog CAS 前遇到 routing 改 C，仍可发布旧
   计划。原 routing owner 现在向原提交点提供同步已提交修订与在途修改核验；原探针拒绝
   该候选，已生效 artifact 保持不变，没有再建选择表。
2. 普通退休、仍被 pin 持有的 A→B 遇到 B 真正进程退出，原 crash 扫描漏过 retiring A。
   改用原精确依赖闭包覆盖 active 和 retiring；原 pin 得到失效信号，另一个 A→C 仍可调用。
3. Surface 本地 factory C 在 activate 等待期间被新的 B 路由取代，仍短暂发布 C。原
   service-binding signature 同时保护准备 supersession 和最后发布检查；独立可见序列
   从包含 C 变为只有旧 B。仓内用例也验证没有 watcher 通知时的最终读取栅栏。
4. A 尚在等待共享 B.activate 时显式禁用 A，原 pending 根没有进入 owner grant 表，等待
   未及时结束。原 pending 记录现在保存真实节点身份并取消该根的等待引用；原探针确认
   A 立即拒绝，独立 B root 未收到取消，释放 gate 后继续成功。
5. 真实跨域 Application Token 的可写路径仍列已删除的 select，导致新 lease 被 401 拒绝。
   原鉴权路径集合精确替换为 lease，原 token 签发与身份解析探针通过；旧 select 仍拒绝。

原作者产包整链另发现首个 Workbench 挂载被 canonical owner 校验拒绝：Loader 为带
executable entrypoint 的 static contribution 合法保留 manifest owner，Host 却只接受无
entrypoint 的声明。把原 Loader 的稳定 owner ID、static/空 declarative/grouped 资格抽到
extension-contract 同一个纯 helper，双方一起消费；没有删除 placeholder、跳过 lease 或
放宽为任意 owner。原两条完整业务链修后通过，独审核对原规则等价。

另一个有界集成修复清除了已结束 P 留在候选组中的旧 consumer：P 的路由随后不可用不再
阻止仍存活 Q 的发布；旧候选资源实际退役，Q 已持有的旧调用继续完成。

以上 event stream 使用直接 Router/ReadableStream 适配，没有运行产品 HTTP 或 Unix
listener。Rust↔Host 的原 stdio、Host↔broker 的原 Node 子进程消息通道、受控 DOM 和真实
扩展方法分别记录，不等同于真实浏览器/Electron、完整产品 IPC 或性能验收。

## 类型与构建

- 完整 Web `type-check` 通过，包含原 Host 生产声明、Host 测试、browser 和 CLI 范围。
  原测试 fixture 同步迁移当前图/lease 合同，没有排除失败测试或放宽编译器。
- 改动 TypeScript/TSX 的 ESLint、唯一改动 broker MJS 的语法检查、改动 Rust 文件的
  仓库 edition 2021 格式检查及 `git diff --check` 通过。旧 lifecycle 测试的宽泛 `any`
  改为明确的受控部分依赖；原 15 条行为用例和 Host 测试类型继续通过。
- 当前 Linux x64 debug kernel 构建、Web build、cloud runtime 布局与 frozen lock 校验
  通过。未执行 cloud 依赖安装或 installed-runtime smoke。Vite 仍提示大 chunk；Rust
  仍有 14 条此前未改领域 warning，没有为本片顺带重写这些模块。
- product identity `0.9.25`、wire `22` 的 kernel 本地、Web stage、cloud stage 字节一致：
  `cc101cc132149b7f994ec0d2aca8247a5a3447d694b599c7f3f0324c3574682f`。
  此为 debug 构建证据，不作为 Release 性能或全平台安装证据。

## 复跑入口

先构建当前 extension-contract、extension-host、extension-surface、extension-loader 和 SDK。
按仓库约定，源码 Node 用例需解析当前源码或先构建其实际 dist 依赖。

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test \
  packages/extension-host/test/scoped-composition.test.ts
bun run --cwd packages/web test -- src/api/extensions-composition-consumer.test.ts
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test policy_switch_review
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::authored_extension_review::model_authored_files_stage_disabled_then_original_enable_reaches_dynamic_model \
  -- --ignored --exact --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::authored_extension_review::grouped_updates_wait_for_actual_surface_members_then_recover_original_results \
  -- --ignored --exact --test-threads=1
```

默认 runtime 切换、Pi 删除、用户资产迁移仍由用户验收后处理。更广两设计交付及真实外层
验收没有由本片的冻结图或局部通过记录替代。
