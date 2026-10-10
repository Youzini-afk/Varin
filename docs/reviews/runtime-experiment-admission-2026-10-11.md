# 实验受理、准备与真实排空

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`6d0dcad60a759247649702f5d06408de26bd4e82`。
状态：本基础纵切已完成源码整合、当前消费者组合和独立反例复验；产品/平台证据边界另列。

这是一条研究域基础纵切：原 ExperimentService 从持久受理到独立准备、执行、停止、恢复，并同步真实 Pi/User 消费者。原生 Agent 的研究调用身份、普通目录 Job/Wait、child/source 和 native User 界面是下一纵切，本记录不将其算作已经交付。默认 runtime 切换、Pi 删除和全面资产迁移仍由用户验收后负责。

## 唯一 owner 与受理合同

原 Rust Storage 的 experiment.spec/attempt/job/artifact 和 resource.commitment 继续拥有全部领域事实；原 backend 拥有执行身份、输出与停止证据。没有新增实验队列库、资源账本或清理数据库。进程内 flights/controllers/observer handoff 仅协调原记录上的在途工作。

同一显式 requestId 先查原已受理回执，再接触当前来源或 backend。新请求先在真实调用者下核短来源元数据、归属和输入引用，固定原规范化意图与 canonical source/scope/cwd，再持久受理。捕获、不可变 spec、资源准入、目录准备和 spawn 独立继续。受理回执允许 spec/specId 为 null，原 submitted 状态和必需 cancelRequested 分别描述准备中与停止请求，不伪造已固定输入或运行作业。

Pi 默认请求键来自实际 tool call；显式键原样保留。UI 的未知 rerun 回应保留原键、spec、machine 和请求内容，再试不会偷偷造第二次工作。确认受理即展示可取消 attempt，不等下一次刷新；不存在 spec 时不提供固定 spec rerun/collect。坏 attempt 不过滤成成功空列表。

## 执行、停止与恢复

源码捕获复用 Rust 的原 physical source lease 和 capture-batch worker；body 读取/hash 不在 TypeScript 控制更新中完成。candidate branch 的原 create identity 在发布前登记，恢复核原 receipt 与 immutable root。原 candidate→spec 接收者先短登记，已交给 spec 的 branch 保留；取消未发布和去重失败者只释放自己确切创建的 branch。删除也使用原稳定 operation 回执，丢 ACK 不换身份再清理。已提交却丢失/变更的 branch 不从当前文件重捕。

Cancel 先短 CAS 保存 stopping/cancelRequested，再中止准备或请求原 backend 停止。它不等待整个 workspace 恢复，也不占用 capture/prepare/spawn 的长串行锁。Late spawn 回执保留真实返回 handle，已取消工作按该原 handle 停止；未知派发不自动重发。结束等待与停止实验分开。Thread stop 只封住当前受理边界并排空已受理工作，不永久封禁未来 Run。

- captureBatch 和 fileMaterialize 保留原 KernelClient 请求直到真实响应；caller abort 不是 writer 停止证明。Rust retained lease 延续到实际 worker 结束。
- 本地准备恢复要求原 materialize committed root 与真实 target subtree lease 可取得。仅 committed 记录早于 backup cleanup，不能单独证明排空。
- 远端准备派发 commit 后保留原 Promise；断连后只查原 immutable material 的 ready 事实。未发现 ready 是 unknown，不能假定没有写者或再派一次未知准备。
- 资源受理丢回应由原 ResourceService.reconcileAdmission 查询原 workspace/machine/attempt/resources。Managed target 同时核原 authenticated principal/coordinator，只读原分配并恢复原回执映射；不再 admit。纯 missing 保持 unknown，原 released 记录才证明没有现存分配。
- Backend 的 terminal status、writerActive=false、原输出 cursor 排空同时成立后才能终结。running/starting 即使暂时 writerActive=false 也不能被写成完成。

## 证据与边界

最终 portable Host 6 个文件 **43/43**：原实验 owner 与真实输入 helper **28**，资源两侧原 owner/实际路由与认证 handler **2**，managed prepare **4**，KernelClient 原请求信用/取消结算 **9**。Pi 同一 consumer **16/16**，ResearchFactsPanel **15/15**；这些数量不叠加成完整产品端到端覆盖。

Host 完整测试类型、Pi/UI 类型、协议构建及实际 Host bundle（531 reachable / 72 excluded）通过。全部改动与新增 TypeScript lint 通过。23 个冻结代码/测试文件在最终组合、实际构建与独审前后指纹相同，文档链接检查通过。

独审先独立形成受理、权限、停止、恢复和消费者合同，再复现六条失败反例：异步 source 解析丢原权限；显式请求键加入新 Run 后重复执行；取消前未发布 candidate 与相同 spec 去重候选各自未清理；非法资源在未知准入状态中自困；恢复 inspect 期间的取消被旧 observer 快照丢失。修复后六条按原触发复验 **6/6**；受理前的合法权限/参数拒绝额外要求零 attempt、零 spawn。最终源码复核又在同一权限修复链发现不可互读 Thread 的 inline spec 去重错误：第二 Thread 的作业能运行却读不到借来的 spec。修复将隐式去重绑定原创建 Thread/session，显式跨 Thread specId 仍单独核原权限。该反例和之前六条在最终冻结源码上合计 **7/7** 通过，独立源码复核接受本基础片，无剩余已确认阻断。

Portable 证据直接执行原 ExperimentService、输入准备 helper、KernelClient 请求结算、ResourceService、ManagedTargetClient、managed routes/auth handlers、ManagedRemoteExecutionService 与研究 UI/Pi 消费者。Storage、HTTP 网络和可控 backend 在对应测试中明确为 fixture；实际资源对账链跨两侧原 owner，但没有连接真实远端机器或执行真实实验。

原 experiments.native.test.ts 已按异步受理合同调整，保留真实 Rust Storage/branch/process 复跑入口，本环境未运行。完整 Host IPC、真实 managed machine、跨平台安装和真实科研质量不计通过。首次 Pi tsx CLI 在创建自身 Unix socket 时失败，测试未开始；后续仅用官方 Node 的受支持 TS loader 执行同一纯 consumer 测试，不监听 socket，不改产品 transport。

原 Rust file.scan 仍同步枚举目录元数据，分页也沿用该原实现。此片消除了正文捕获、准备、spawn 对 Experiment 控制串行器的长占用，不宣称任意超大目录扫描都离开 Storage actor。没有为本片修改 Rust 或以旧 binary 冒称新原生集成验证。

## 复跑入口

依[开发指南](../development.md)准备锁定工具链，在仓库根执行：

```bash
(cd packages/web && bun x vitest run \
  application-host/lib/harness/experiments.test.ts \
  application-host/lib/harness/experiment-workspace.test.ts \
  application-host/lib/harness/resources.test.ts \
  application-host/lib/harness/managed-remote-client.test.ts \
  application-host/lib/kernel/request-credit.test.ts \
  application-host/lib/kernel/request-window.test.ts)
(cd packages/pi-host && node --import tsx --test test/harness/experiment-tools.test.ts)
(cd packages/ui && bun x vitest run src/workbenches/research/ResearchFactsPanel.behavior.test.tsx)
(cd packages/web && bun run type-check:application-host:tests && bun run build:application-host:raw)
(cd packages/pi-host && bun run typecheck)
```

在支持原 Host IPC 的验收环境使用同源码准确 kernel executable，并按 Web 的 native test 入口运行 experiments.native.test.ts、experiment-workspace.native.test.ts 和 resources.native.test.ts。Socket 路由测试 experiment-routes.test.ts / managed-remote-routes.test.ts 也保留其真实传输边界；内存 handler 验证不代替它们。
