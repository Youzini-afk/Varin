# 冷备份与隔离恢复

`scripts/cold-backup.mjs` 提供 Linux 运维入口：完整复制明确声明的目录、校验内容与范围、恢复到新目录，
并默认禁止恢复副本启动 Application Host。它不重放 WAL、不转换数据库，也不是跨存储域热快照。
Node.js 要求与仓库一致。从与运行版本匹配的源码发行包运行该脚本。

## 一致性前提和范围

备份前必须停止 Varin 及全部写者，并禁用容器、systemd 等自动重启。除了 Host，还包括用户命令、
编辑器、其他容器、外部 Harness 和任何正在修改 workspace 的进程。先确认停机结果：`incomplete`
不等于全部写者已停止；此时要由原监督者结束进程树，再确认全部写者退出。停止后可以保留未完成
checkpoint 的 WAL 和 `.publish` 文件，它们属于原 owner 的 crash recovery 输入，不能删除。

`--writers-stopped` 是操作者对这一事实的明确断言，不是脚本自动验证。PID 文件、两次目录扫描和
单个 SQLite 锁都不能证明所有命名空间及存储域已静止。脚本在复制期间设置数据根启动 fence，阻止
新的正常 Host 启动，并检测源文件元数据变化和复制后的 hash 差异；这些检测不能替代停写前提。
遇到进程崩溃遗留的 `.varin-cold-backup.lock`，先确认复制进程已经退出，才可移除该目录。

必须包含完整 `VARIN_DATA_DIR`，不选择性省略以下域：

- Rust Storage 数据库、WAL、objects、文件/进程回执与恢复资产。
- Agent Catalog、WAL、ContentStore 和原 Thread/Run/operation 身份。
- Knowledge 私有文件、WAL、publication 状态、派生存储和 Host 配置。
- 持久 hostId、扩展安装、认证、配对和连接配置。整个备份是含凭据的私有资产。

另外通过 `--scope 名称=目录` 声明 workspace、SSH、cloudflared 等独立挂载。未声明的目录不在备份
范围内，也不承诺外部 Harness 私有历史、远端机器、Git 远端、模型服务或任何外部效果已被备份。
Git linked worktree 的 `.git` 指向的 common Git 目录、配置中引用的外部资产也必须单独声明；脚本
不会把普通文件中的路径当作复制指令或推断全部外部依赖闭包。
各源根不能重叠，目标不能落在源根内。目录内相对且不越界的 symlink 被保留；绝对/跨根链接、
socket、device、FIFO 拒绝并指出路径，不静默跟随或忽略。处理这些资产后重新备份。

```sh
# 先停止全部写者并禁用自动重启；此命令本身不会停止服务。
node scripts/cold-backup.mjs create \
  --data-dir /srv/varin/data/varin \
  --scope workspace=/srv/varin/workspaces \
  --scope ssh=/srv/varin/data/ssh \
  --scope cloudflared=/srv/varin/data/cloudflared \
  --output /srv/backups/varin-2026-11-06 \
  --writers-stopped
node scripts/cold-backup.mjs verify --input /srv/backups/varin-2026-11-06
```

目标必须不存在。根目录权限为 `0700`；文件保留普通权限位，不复制 setuid/setgid、ACL、xattr、
属主、时间戳或 hardlink 拓扑。源文件逐文件复制并同步，目录同步后才写入完成 manifest。
没有 manifest 的副本不完整，不可恢复。manifest 包含格式版本、工具版本、时间、原根路径、
声明范围、文件列表、类型、权限、大小、SHA-256 和链接目标；验证同时拒绝多余和缺少的文件。
数据库格式不由脚本猜测，原存储 owner 在隔离重开时负责验证/升级。工具版本不代表源数据库版本。

Hash 校验不是签名或加密。把备份放在受限磁盘或已有加密备份系统中，避免公共对象存储、工单附件
或日志上传。目录同步和文件同步无法承诺底层网络文件系统、硬件或外部快照服务的耐久语义。

## 隔离诊断副本

```sh
node scripts/cold-backup.mjs restore \
  --input /srv/backups/varin-2026-11-06 \
  --output /srv/isolated/varin-check
```

默认 `inspection` 模式。原 hostId、请求、原回执和 `unknown` 事实保持原样；`data` 目录在复制身份
之前就写入 `.varin-offline-restore.json`，正常 Host 在创建运行 owner 前拒绝启动。损坏的 marker
也不能绕过检查。不要删除 fence、启动旧版 Host 或直接启动原备份内的 `roots/data`。

这个 fence 是误启动保护，不是 OS sandbox。先在外部隔离网络、生产 workspace、凭据入口和原
服务，再用原 Catalog/Storage/Knowledge owner 做升级、完整性和恢复演练。owner 重开可能修改
副本；不要把“数据库可打开”称为只读检查。原始备份保持不变，必要时从它重新生成副本。
inspection 副本不能通过 activate 变成生产 Host。

独立运行的新 Host clone **尚不支持**。它需要由原 owner 定义新身份、历史导入、队列与周期任务
暂停、外部绑定重绑等合同；改 hostId 字符串既不能迁移 kernel 寻址，也不能证明原副作用没有执行。

## 灾备恢复原逻辑 Host

```sh
node scripts/cold-backup.mjs restore \
  --input /srv/backups/varin-2026-11-06 \
  --output /srv/recovery/varin --mode recovery
# 完成下面三个核查后，才解除本次恢复的数据根 fence。
node scripts/cold-backup.mjs activate --restored-root /srv/recovery/varin \
  --source-fenced --effects-reviewed --bindings-reviewed
```

激活要求操作者逐项确认：

1. 原实例和持同一身份的其他副本已被隔离，不能自动重启或重新连回生产服务。
2. 已核对备份时间之后的外部效果。恢复旧数据库不能撤销已发生的网络请求、命令或支付，缺失回执
   不代表未执行；原 `unknown` 不能批量改成未执行或触发重发。
3. 已核对原绝对 workspace 路径、挂载、SSH/tunnel、模型账号、外部 Harness 和周期任务绑定。
   工具不重写数据库中的路径，也不自动将恢复目录映射回生产路径。

三个标志也是操作者断言，工具不能替代网络 fencing 或外部效果对账。激活记录保存在
`activation.json`，只对显式 recovery 副本解除 fence。随后在所需原路径挂载各 scope，以匹配的
发行版本启动原逻辑 Host，由原 owner 执行 crash recovery。不要同时启动原实例。

## 验证边界

`node --test scripts/cold-backup.test.mjs` 用真实 SQLite WAL 和 TriviumDB 失败 publication 验证
字节复制、隔离重开、范围/hash 校验、未知状态保留和 recovery 激活门槛。它不替代真实 Catalog/
Storage 幂等与副作用恢复测试，也不宣称完整生产数据或容器故障演练已通过。相关 owner 证据仍走
[开发指南](../development.md)中的 Rust/native suite。只有停机窗口不能满足实际需要时，才另行设计
跨 Catalog、Storage、对象 GC、Knowledge 和 workspace 的热备份协议。
