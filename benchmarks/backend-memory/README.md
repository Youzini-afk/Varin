# 后端内存实测

此诊断分支不应合并：分支上的 `ci.yml` 仅运行本次实验。应用从独立 checkout 的精确 `source_sha`
构建，测量脚本不进入应用镜像；不向外部 registry 发布镜像。

工作流为同一 SHA 构建 Linux/amd64 slim 与 toolbelt，各在独立全新容器中运行：
4 vCPU、4 GiB、无 swap、PID 512。60 秒健康后空载；准备 256 × 64 KiB 文件与 32 个空 Thread；
30 秒预热；120 秒典型样本（4 个顺序客户端，每请求后等待 500 ms）；600 秒高并发样本
（64 个顺序客户端，无等待）；60 秒恢复空载。每个客户端循环进行文件读取、目录列表、
Rust 文件名搜索、Rust Thread 快照、Rust Thread 列表、真实 shell 对整个 16 MiB 文件集计算 SHA-256。
每次响应均检查内容或身份，shell 检查真实退出码和聚合摘要。模型推理没有运行，也没有模型替身。

宿主 Python 每 250 ms 读取容器的 cgroup v2 和 /proc，采样器不在被测容器内。
`memory.current` 包含页缓存；工作集定义为 current - inactive_file；RSS 为进程 VmRSS 总和，
可能重复统计共享页。报告样本均值、中位数、P95、采样峰值、最后 30 秒中位数、前后窗口变化，
另保留内核记录的容器全生命周期 `memory.peak`。不强制 GC，不清页缓存。

这里的“典型”只是指定样本，不是用户群体平均值。高并发只有实际 CPU 使用接近 quota 时才可称
“该负载下 CPU 饱和”，不代表所有模型/浏览器/编译/语言服务/MCP任务的内存上限。
空 Thread 不代表大型非空对话历史。`fs.exec` 的 job receipt 由产品保留 30 分钟，因此反复请求
可能产生真实增长；每次只输出一个聚合 hash，避免 256 行输出堆积混淆基线。

原始证据在 Actions artifact：`samples.jsonl`、`requests.json`、`workload.json`、
`summary.json`、容器/镜像 inspect 与运行环境。所有密码、路径与正文都是本次生成的测试 fixture；
会话 cookie 不写日志或 artifact。

附加 `profile=cpu` 工况保留空载、预热与典型段，将高压段替换为4个持续并行的真实fs.exec请求，
每个job对16 MiB文件集完整校验100遍并验证聚合hash，持续180秒。这是CPU密集文件工具工况，
用来区分CPU真正打满与混合API吞吐瓶颈；不是内存人为填充，也不声称覆盖任意工具的峰值。
