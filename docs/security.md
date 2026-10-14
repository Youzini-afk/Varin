# 信任与安全边界

Varin 能读取文件、调用模型、运行命令和操作电脑。Renderer、模型工具参数、项目内容、第三方扩展不是相同信任级别。
[架构](architecture.md)、[资源](resources.md)、[扩展](extensions.md)解释实际执行这些边界的 owner。

## 数据与权限

Provider/MCP 凭据、会话正文、文件、草稿、来源历史、扩展配置和 OS 访问由所属 owner 管理。诊断不得记录 prompt、密钥、
bearer/pairing token、Authorization header、任意环境值或文件正文。外部模型/Web 服务是数据接收方，不是可信本地库。

项目信任约束可执行资源和 MCP 配置；settings/skill 文本不能通过声明授予文件、进程或凭据访问。
第三方 Pi package 和 trusted Host extension 是可执行代码，能力标签不降低其 OS 权限。
工具策略与逻辑资源准入不等于 hostile-code sandbox。

远端客户端经过鉴权路由、显式 capability 和 allowed-directory policy。物理使用时规范化路径；workspace ID、
另一个 Host 上同名路径不是授权。固定来源仍须当前 registration/trust 和原 Storage grant。
撤权阻止新访问，不改写历史或虚构已受理效果回滚。

## Renderer 与桌面

Electron 启用 context isolation，关闭 Node integration。Preload 方法显式且校验输入，没有通用 IPC 到 main 的逃逸入口。
Host token、自定义 header、本地/relay 身份留在 main；敏感 bootstrap 只给批准的 packaged/local/development origin，
不放 Chromium 命令行参数。

远端页面保留适用的展示/窗口操作，但不能枚举已保存 Host 或借 main 任意网络探测。外部导航只接受支持的 HTTP(S)，
不开放 file/script/custom URL。编辑器保存通过 Host Documents；替换失败保留原文件，不先删除目标强行 rename。

## Host、扩展与私有进程

公开 Surface、extension broker、Pi worker、私有 kernel 协议是不同边界。接收 owner 核验身份、epoch、generation 与精确操作形状。
传入别人的 session/Run ID 不能成为代其执行的权限。

Pi 扩展在 Pi worker；Varin brokered Host 扩展在受管 child；isolated Surface 只有授予的 capability。
Trusted-native 有显式 trust/restart 语义。新代次准备不能破坏已受理 pin，撤权继续阻止旧 owner 的新调用。
Surface 可见不证明其必需 Host generation 已 ready。

Kernel bootstrap 经 stdin 传 fresh local endpoint 与一次 bearer，control/content 鉴权同一 epoch。
Knowledge/semantic 存储也由私有 child 拥有，不建立未鉴权数据库或通用文件 API。

## 网络、恢复与停止

Host egress 执行目标策略、private/reserved address 限制、redirect 和 proxy/DNS/TLS 结果。Browser cookie 访问显式启用。
网络失败不是关闭验证或重放未知副作用的理由。

Recovery/Integration 要求原 Source/root、当前 maintenance 权限、条件文件版本和真实 dirty-state 观察。
用户确认不能替代不可用的 Surface barrier；补偿只改本操作尚未被别人改动的输出。

Cancellation intent、observer 结束、effect outcome 和真实 executor stop 分开。未知远端/原生工作保留原 cleanup owner。
HTTP abort、经过一段时间或 IPC 丢失，不证明进程树、文件 reader、package worker 或输入 lane 已排空。

## 依赖与验证

Manifest、lockfile、shipped patch 和 `scripts/audit-dependencies.mjs` 定义当前修复及窄范围 advisory exception。
根据改动检查实际依赖图，不能拿历史版本号当永久安全下限。Native inventory 和发行打包需要对应 artifact/platform 检查。
操作入口见[依赖维护](ops/dependency-updates.md)。

定向 security/protocol/permission 测试证明声明的路径，不认证全部第三方代码、安装产物、OS 或远端部署。
区分失败、跳过、未知与未执行，验证选择见[开发指南](development.md)。
