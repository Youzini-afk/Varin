# 原 Computer 应用能力与原生工具

基线：`b5265a757bd96ec561ed748f39fce8fb8b4799bf`。依据[运行时设计 §19](../design/agent-runtime-design.md)与[能力设计的 Computer 职责](../design/runtime-extensibility-design.md)：应用适配继续使用原桌面、分配、控制通道、效果回执和真实停止事实。

## 实现范围

原 builtin 声明、普通 broker、native invocation 与 ComputerService 接通 open、put、install、browser、Office、evidence 和 environment 读取。browser/Office 的只读与效果动作有独立 schema；evaluate 或嵌套写入不能靠只读工具、调用者标签或 child 身份获得控制。截图沿已有 typed media，原 journal 保实际 native execution。

`computer_control` 只沿已有 automation/peer reserve 取得或核对真实控制分配，再读取原 state。正常流程是 control → fresh snapshot → 携原 epoch 输入，未额外创建调度或授权 owner。观察租约升级为控制租约后，旧观察 epoch 失效；明确前置拒绝后重新观察可继续，不自动重放未知效果。

脚本内 tools.invoke 的取消直接中断该原调用的 dispatch signal，不等待 Catalog RPC 才开始物理排空。Tool 取消、效果未知和输入 writer 真正结束仍分列。手动接管后的 fresh-scene 要求只能由当前 controller 自己的观察满足，其他 observer 不能代为解除。

environment 只展示已接受 Run 的来源、默认桌面和分配。原 Pi session 的环境改绑与 forward 尚未接原生 placement/Job owner，返回明确不可用信息；不伪造 Pi 身份、不制造后台监听器。默认运行时和用户资产保持原状。

## 实际修复与有限证据

- Linux 应用桥正常取消会明确返回 outcome unknown。普通工具现在保该事实，独立于正常 driver return 所证明的 stopped；不降成 partial/cancelled。媒体编码错误同样不抹掉原 dispatched/unknown 回执。
- 真实源端服务 → 认证目标 Router → 目标 owner 的双 owner 测试确认：stale epoch 与已撤销 assignment 在派发前拒绝，目标 driver 零调用，源端保 none/failed/stopped。证明来自原拒绝阶段，不按 HTTP 状态码猜测。
- 原远端控制 claim 已接受但 ACK 丢失、drop 未确认时，控制工具保 assignment unknown 和未确认停止。元数据读取本身失败也不能转成 none。普通 control → snapshot → act 链与 fresh-read 恢复链均已验证。
- 原 root 接管/交还、child observer 读取与 root 再输入组合已覆盖：child 的成功观察不会清 root 的要求；root 自己重新观察后仍可正常输入。
- 原 installer/file helper 的正常退出与尚未派发分开。helper 已退出可证明 stopped；缺少结构化前置阶段证明时，安装错误的 effect 仍为 unknown，不从 code 2 或文本猜 none。
- 原 builtin 包构建通过，真实 broker/SDK 调用消费本次声明与冻结默认配置，嵌套调用仍使用原权限。Node child IPC、直接认证 Router 和实际服务/driver adapter 都参与测试；Catalog、平台 driver、vmExec/backend 为受控端口，没有操作真实桌面、执行安装或请求模型。

独立审查以这些功能为入口追到原脚本取消、peer assignment、共享 input lane、旧 observe、typed media 与 Linux helper，已复验上述实际失败路径。外部小探针用于独立确认，相关回归已并入下面原仓库入口。

应用接入阶段的 Node 组首跑 43 条中 41 条通过；两条新 control 断言把原 capabilities probe 误算作应用输入，修正为真实应用 dispatch 后精确复跑 2/2 通过，未机械重跑其余 41 条。独立反例另外复验了原目标实际收到的输入。该阶段协议与 builtin 包构建、完整 Host production/tests 的 `tsc --noEmit` 通过；较早一次并发类型命令被系统以 exit 137 结束且没有诊断，未计通过。上述类型检查不是完整 Web browser/CLI 构建或实际桌面验收。

## 桌面生命周期与原产物消费者

以 `416a535c8acaeb29942fd14d6ceb97cabd7dad39` 为基线的后续增量沿同一 builtin/broker 接入 `computer_prepare`、`computer_desktop_lifecycle` 和 `computer_artifact`。prepare 先取得真实未准备目标的控制分配再执行原 Linux helper；start/stop 核原 epoch，旧排队输入和观察不跨生命周期世代。原产品人工入口和 Pi harness 仍使用同一服务。child 未获控制不能借新入口绕过分配。

setup/apt 原 helper 没有合作式中断协议。取消保持 pending，原 lane 等该 helper 真正退出后才报告 stopped；独立物理输入 stop 仍可及时释放输入。此限制没有通过杀观察者或猜测孙进程已经结束掩盖。

artifact 使用真实 `ComputerWorkRef` 解析原 Thread/branch 及 Bot/Thread scope，保原 Storage artifact record、Host identity 与文件 revision。原 Bot work 和下载消费者直接消费，不创建 Pi Registry 记录。原下载客户端还会核收到的字节长度和 SHA-256；文件在流出期间改变会使交付拒绝，不能声称 helper 的可变文件流本身就是不可变对象。

本增量还修正资源 Host 把 peer 的外来 Thread 错登记为本地工作、导致自身 Bot work 查询失败的路径。工作关联只留在真实协调 Host 的原 mirror；目标 Host 的 peer assignment、控制投影和证据继续保留。明确的 Catalog not-found 使用结构化错误码，缺失 owner 与存储故障分别处理。

远端 stop 由目标原 reset 返回它实际终结的 assignment IDs，只回调用 peer 的原身份。来源端逐确切 ID 走原 release；release ACK 失败单列，不抹掉已确认的桌面停止。独立交错反例已确认：stop 前及 helper 在途时加入的 child observer 都结束；reset 后、响应抵达前的新 observer 仍保留，随后 fresh control → start 可继续。没有依赖控制 SSE 碰巧及时抵达或完成时一把清空全部分配。

本增量新增或增强的 13 个不同 Node 用例均已有有效通过证据，覆盖原 broker、local/remote owner、认证 Router、child 权限、helper 取消排空、人工/Pi 入口与 Bot artifact 消费者。独立 peer/stop 反例已闭合；新 builtin 产包、最终 protocol 构建和完整 Host production/tests `tsc --noEmit` 通过。中途 fixture 的调用身份、fresh observation、错误字段与必填上下文修正分别只复跑受影响项；两次类型诊断按真实合同修复，未放宽编译器，也未将失败首跑计入通过。原 Rust NotFound 错误投影已随当前 kernel 编译核对。

## 复跑入口与边界

- `packages/web/application-host/lib/kernel/computer-runtime.test.ts`：普通工具、原 broker、双 owner/direct Router、原效果、取消、handback 与安装回执用例。
- `packages/web/application-host/lib/computer/computer-service.test.ts`：原 ComputerService 的对应服务合同。
- `packages/extension-builtins` 的原 build：生成实际 builtin 包及指纹。

先独立检查测试 imports、hooks、constructor/default transport，再选择 Node `--import tsx` 的精确允许入口。这里没有启动 HTTP/Unix/产品 listener，没有执行默认 KernelClient、真实 CDP/UNO 桌面、apt、用户账号或跨平台安装。双 owner 的传输与控制事件 stream 受控，不能外推实际双机网络时序、平台视觉/输入成熟度或完整产品 IPC。
