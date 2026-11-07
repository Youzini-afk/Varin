# Varin cloud deployment

Varin has one cloud release layout shared by containers, local deployment checks and SSH
releases. It contains the compiled Web Host/UI/CLI, the application-client, protocol, script-runtime,
settings-store and required extension packages, plus the target `packages/web/kernel` executable
and manifest. The exact package closure is `CLOUD_RUNTIME_PACKAGE_DIRS` in
[`scripts/build-cloud-runtime.mjs`](../../scripts/build-cloud-runtime.mjs).

The builder stages a dedicated production `bun.lock`; native dependencies are installed for the
target OS and CPU rather than copied from a developer machine. The Rust executable is copied with
its SHA-256/build/wire/architecture manifest and exercised by `verify-kernel.mjs`. No separate
agent worker, SDK dependency closure, Node Storage or PTY authority is installed.

## Container images

正式版本发行采用以下命名的边界是：包含本发布实现、且版本 **大于 0.9.38**。
独立的按提交发布使用 `commit-<完整 SHA>`，不占用版本号，源码 package version 仍为 0.9.38 也可以构建。
已发行的 `v0.9.38` 及更早版本不重新解释，不补写其精确版本、SHA 标签，也不替换已有 digest。

| 镜像 | 内容与兼容名 |
| --- | --- |
| `ghcr.io/youzini-afk/varin` | 标准应用，采用 slim runtime；Compose 默认。`varin-slim` 是同一已验证 digest 的兼容名。 |
| `ghcr.io/youzini-afk/varin-toolbelt` | 预装开发工具链的应用，不再使用新版本的 `varin` 标签承载该变体。 |
| `ghcr.io/youzini-afk/varin-runtime-slim` | 标准基础镜像：Bun、Node、Git、SSH、cloudflared，以及安装 native production modules 所需的 Python 和编译工具。 |
| `ghcr.io/youzini-afk/varin-runtime-toolbelt` | 开发工具链基础镜像。`varin-runtime-base` 保留 toolbelt 含义，并指向同一 digest。 |

Toolbelt 在标准环境上增加 Java/Maven、Go/gopls、Rust/rust-analyzer/rustfmt、LSP、GitHub CLI、
ripgrep、无常驻 daemon 的 rootless BuildKit，以及 amd64 上的 Chrome/Playwright。arm64 保留其他
工具，并明确报告未安装 Chrome。Dockerfile 的历史 `runtime-base` target 仍等价于 `toolbelt`；
默认应用 Dockerfile 继续采用 `varin-runtime-slim`。标准环境仍含 Python 和 native 构建前置，
不是没有工具的 sandbox。

### 命名切换与现有部署

第一次符合上述边界的稳定发行会把 `varin:latest`、对应的 `varin:<major>.<minor>` 和
`varin:<major>` 浮动别名改为标准环境。例如 0.9 系列的第一次新稳定发行涉及 `varin:latest`、
`varin:0.9`、`varin:0`。同一新发行的 `varin:<完整版本>` 和 `varin:sha-<完整提交 SHA>` 也采用标准环境。
`varin-slim` 保持标准含义，`varin-runtime-base` 保持 toolbelt 含义；新 `*-toolbelt` 仓库发布对应的
精确版本、SHA 和稳定浮动别名。旧 `varin:0.9.38` 及其原 SHA/digest 引用继续代表原 toolbelt。
不为历史版本回填新仓库别名。

依赖 Java、Go、Rust、LSP、Chrome 或其他预装工具的部署，应在跟进新发行前改用
`varin-toolbelt` 或下面的 Compose overlay。只跟随 `varin:latest` 的现有部署会在升级后失去这些
额外工具，不能把镜像名称相同视为环境内容不变。追求可复现部署时固定精确版本或已核验 digest。
新 `*-toolbelt` 仓库及其 `latest` 不是同一件事：仅完成按提交发布后，仓库可以已有 `commit-*`，
但首次正式版本推广前仍可能没有 `latest`。因此这段过渡期必须同时固定应用和 base 的已发布引用，
不能假定默认 toolbelt overlay 的 `latest` 已可拉取；也可继续固定旧环境：

```bash
VARIN_IMAGE=ghcr.io/youzini-afk/varin:0.9.38 \
VARIN_RUNTIME_BASE_IMAGE=ghcr.io/youzini-afk/varin-runtime-base:0.9.38 \
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

正式版本入口拒绝以 `<=0.9.38` 的版本发布，默认拒绝覆盖任何已存在且 digest 不同的精确版本/SHA 标签。
相同 digest 的部分发布可以续做。**历史 tag 上的旧 workflow/helper 仍是旧代码**，不受这些新检查
约束；不要通过重跑旧 tag 的 Docker workflow 修复或回滚部署。回滚应选择保留的已核验镜像引用，
并单独确认持久化数据格式兼容性。更强的历史 workflow/registry 写入限制需要 owner 另行配置权限，
本流程不会修改权限、可见性、凭据或历史 Git tag。

### 正式版本发布

四种产物在发行时构建 `linux/amd64` 和 `linux/arm64`，不是每次 main push 都发布。
`Docker Images` 只接受与 package version 匹配的 `v<version>` tag push，或显式选择该 tag 的手动运行。
先接受精确 tag/SHA/version 并验证生产锁，候选构建与该 SHA 的完整源码、Rust/native 及平台资格并行。
完整资格与两种真实应用 smoke 全部通过后才允许最终标签推广；计算完成不代表发行合格。
每个应用只消费本次对应基础镜像的 immutable digest，不读取浮动 base。

需要保留版本号重发时，先将对应 Git tag 移到修复提交，再手动选择该 tag 并启用 `replace_version`。
本次验证通过后可替换所选精确版本及其适用的浮动别名，全部 SHA 标签和原 digest 保持原样可用。
普通 tag push 和未启用该项的重试仍拒绝同版本不同内容；重发仍执行完整资格、镜像检查与推广前 tag 核对。

手动输入 `runtime_slim_image` 或 `runtime_base_image` 分别选择标准或 toolbelt 基础镜像。
**该输入同时授权把实际消费的基础镜像发布为本次发行的 companion base**，不是只修改应用构建参数。
输入首先解析为固定 digest，并核对双架构、`runtime-base` role、variant 和环境元数据；应用镜像、
错变体或缺架构的镜像不能充当 base。应用 job 导出实际消费的引用，推广阶段使用同一引用，
不因为跳过 base 构建就遗漏基础镜像标签。旧自定义基础镜像及已经发布的 `v0.9.38` base 可能缺少这些新增元数据，不能验证时按新契约拒绝，
需要先重建；省略 override 会从同一候选源码构建。历史镜像仍可原样拉取，不等于能够绕过新 base 准入。

应用和基础镜像携带 `io.varin.image.role`、`io.varin.image.variant`、`VARIN_IMAGE_VARIANT` 和
`/etc/varin/image-capabilities.json`；标准环境的 variant 值仍为 `slim`。元数据描述已安装内容，
不授予权限，也不保证 Browser/Computer owner 已配置。镜像保留 provenance 和 SBOM。

两种 amd64 应用必须按 digest 拉取并启动，通过精确 `releaseId` 的 `/health`、native kernel 和
brokered services 检查，再验证 role/variant/capabilities，并收到真实 SIGTERM。
15 秒 supervision 窗口内必须有 graceful 回执和前台退出码 143；不完整或强制退出失败。
arm64 的 native 依赖与 kernel 在镜像组装时校验，但这不等同于 arm64 服务启动验收。

推广在两个发布通道共享的全局锁内重新核对 Git tag，并按以下顺序执行：

1. 核对完整四种来源的固定 digest、双架构和 role/variant，再把候选复制到全部六个目标仓库。
   复制必须保持来源 index digest；候选标签只使用该 run/attempt 的唯一名称。
2. 用独立空认证配置读取每个目标仓库候选 digest、两个平台 manifest/config，验证匿名拉取权限。
   新 `varin-toolbelt`、`varin-runtime-toolbelt` 包可能默认私有；已登录的 push/smoke 成功不证明普通
   用户能访问。若失败，停止在正式别名之前，由 owner 按预期公开访问策略配置包，再续跑推广；
   workflow 不自动扩大可见性或请求新凭据。这一门禁验证 registry 内容访问，不宣称已匿名下载每一层。
3. 对全部目标的精确版本、SHA 与计划更新的浮动标签完成预检。仅明确不存在可当作新标签；
   认证失败、网络错误或未知结果都停止。已有 SHA 标签只能与目标 digest 相同；精确版本默认也如此，
   只有手动启用 `replace_version` 才允许替换本次所选版本。
4. 先补齐全部精确版本/SHA 标签，再更新浮动别名，每次复制后核对目标 digest。
   仅远端保留的最高稳定 Git release tag 可以更新整组 `latest`、major/minor、major 别名。
   更旧稳定发行和 prerelease 只处理其精确版本/SHA，避免部分新发行后又被旧重试回退。
   即使更高稳定 tag 尚未通过资格检查，也保守地暂停旧发行的所有浮动更新，包括旧版本线的 minor 别名。
   该顺序依据要求保留已发行 Git tags，不以复用 base 中的旧 OCI version 标签推测发布时间。
5. 回读完整目标清单，所有 digest 一致才报告完成。

这不是跨仓库原子事务。中断后只续跑推广，复用原来已经验证的 immutable 来源与成功 build job 输出；
已写入相同 digest 的标签会跳过。重新构建可能因时间戳/attestation 得到新 digest，不能借重试覆盖冻结的
精确版本/SHA。Git tag 被移动、访问结果未知或冲突时，先查明状态，不把失败当作未执行。

### 独立按提交发布

`Docker Commit Images`（`docker-commit.yml`）只接受从本仓库 `main` 手动发起的运行，不接受分支、PR
或版本 tag 上的 dispatch。默认构建 dispatch 时固定的 main SHA；`source_sha` 可以指定这个 main
快照历史中的完整、小写 40 位 SHA。恢复时未填写 `source_sha` 则沿用已保存候选的来源，不换成新的 main。
后续 main 正常前移不会改变已受理来源，也不会使长构建失效；若已受理来源或发布工具提交被移出 main 历史，
推广拒绝继续。这里验证的是 Git 来源和受信入口，不是对 GitHub branch protection 设置的审计。

使用 GitHub Actions 页面：选择 **Docker Commit Images → Run workflow → Branch: main**。
首次构建只填写需要的 `source_sha`，或留空选择本次 main；不要选择旧版本 tag。
等价 CLI：

```bash
# 当前 main 的精确来源；没有版本 bump、Git tag 或 GitHub Release 创建。
gh workflow run docker-commit.yml --repo Youzini-afk/Varin --ref main

# SHA 为已核实的 main 历史完整提交号。
gh workflow run docker-commit.yml --repo Youzini-afk/Varin --ref main -f source_sha="$SHA"
```

workflow 和准入、推广、容器烟测脚本固定来自 dispatch 的 tooling SHA；Docker 构建上下文来自所选 source SHA。
准入后的候选计算与源码完整 CI 并行；完整 CI 及两个真实 smoke 成功后才保存合格 receipt，最终推广继续验证该 receipt。
历史 main 源码仍须通过当前资格检查并提供所需的
role/variant/capabilities 契约，不能因为“曾在 main”就跳过缺失的检查。四个产物均构建双架构，应用消费
对应的固定 base digest；这个入口不接收任意 base override。

两个 amd64 应用按 digest 真实启动，核对 `/health` 的 `releaseId: image-<source SHA>` 和源码版本，
再通过 kernel、brokered services、镜像能力和 graceful SIGTERM 检查。每个平台配置中的 OCI revision/version
描述实际源码；独立的 `io.varin.build.tooling_sha`、run ID/attempt 描述构建流程，
`io.varin.image.base` 固定应用实际消费的 companion。不能用 workflow 上下文默认 revision 代替所选源码。

验证后先保存完整四个 digest 的候选 artifact，再进入同一推广 owner。它复制全部六个仓库的候选，检查匿名
manifest/config，并在未曾认证拉取应用层的新 runner 上用空 Docker 认证配置执行 **linux/amd64 匿名 pull**。
随后整批预检并仅写入以下不可变标签，最后回读全部目标和匿名引用：

- `varin:commit-<SHA>` 与 `varin-slim:commit-<SHA>`：同一个标准应用 digest。
- `varin-toolbelt:commit-<SHA>`：工具链应用。
- `varin-runtime-slim:commit-<SHA>`：标准 base。
- `varin-runtime-toolbelt:commit-<SHA>` 与 `varin-runtime-base:commit-<SHA>`：同一个工具链 base digest。

这是真实 GHCR 发布，不是 CI 的临时 registry。成功 run 的 Summary 和 `varin-commit-publication-<attempt>`
artifact 给出六个可拉取引用、digest、source/build/tooling 身份；只有完整回读成功才生成 `status: complete`。
amd64 pull 之间可能复用共享层缓存；双架构元数据与构建验证不等于 arm64 服务启动验收。
新 package 若仍私有，匿名门禁会在 commit 标签前停止，须由有权限的 owner 按预期公开访问策略处理，
workflow 不会自行更改可见性、权限或凭据。

此通道不写 `latest`、major/minor、major、版本号或正式 `sha-*` 标签，也不增加 `main`/`edge` 浮动别名，
避免手动验证构建悄悄升级其他部署。它不触发 Desktop、npm 或完整 GitHub Release。
以后创建 `v0.9.39` 仍自动进入正式 `Docker Images`，使用该版本 tag 的源码和独立精确标签；先前的
`commit-*` 不占用 0.9.39，也不要求两次独立构建的 digest 相同。相同正式版本不能重新指向另一份源码。

首次成功发布所选 SHA 后，可以显式拉取或选择 Compose 镜像：

```bash
docker pull "ghcr.io/youzini-afk/varin:commit-$SHA"
docker pull "ghcr.io/youzini-afk/varin-toolbelt:commit-$SHA"

VARIN_IMAGE="ghcr.io/youzini-afk/varin:commit-$SHA" \
VARIN_RUNTIME_BASE_IMAGE="ghcr.io/youzini-afk/varin-runtime-slim:commit-$SHA" \
docker compose up -d

VARIN_IMAGE="ghcr.io/youzini-afk/varin-toolbelt:commit-$SHA" \
VARIN_RUNTIME_BASE_IMAGE="ghcr.io/youzini-afk/varin-runtime-toolbelt:commit-$SHA" \
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

#### 失败与恢复

跨仓库推广不是原子事务。优先在原 run 选择 **Re-run failed jobs**，保留成功 build 的原 digest 和候选清单。
不要把 **Re-run all jobs** 当成幂等：时间戳、attestation 或上游解析会使同一源码重建出不同 digest，
不同 digest 与已有 `commit-*` 冲突时仍会拒绝，不能用重建覆盖部分发布。

需要从新的 main tooling 恢复时，指定原 run ID；`resume_run_attempt` 可省略选择该 run 最新保存的候选
artifact，也可显式选择确切 attempt。它不会从失败、过期或不可验证的新候选悄悄回退到旧候选：

```bash
gh workflow run docker-commit.yml --repo Youzini-afk/Varin --ref main \
  -f resume_run_id="$RUN_ID" -f resume_run_attempt="$ATTEMPT"
```

恢复只接受同仓库、同 workflow ID/path、从 main dispatch 的 run，核对对应 attempt 的
`Record verified candidate` job 成功、artifact 身份与 ZIP 字节摘要、唯一清单及其源码版本/祖先关系。
原 run 整体可以因推广失败而为红色，但 producer 不能失败、跳过或缺失。候选中的每个平台配置重新绑定
来源、构建 run/tooling/attempt 和实际 base；允许同一 run 的 base attempt 1、app attempt 2，
不允许未来 attempt 或另一来源混入。恢复跳过四个 build，仍重新执行精确源码资格和两个实际容器烟测，
再保存新 run 的候选清单并以原 digest 续做。已存在且相同 digest 的 commit 标签跳过，未知请求结果先回读。

候选 artifact 名称是 `varin-commit-images-<attempt>`；保留期受仓库 Actions artifact 设置约束。
artifact 被删除、过期、摘要不符，或原候选 registry digest 已不可访问时，不能宣称可恢复；先检查原发布状态。
若已有部分不可变标签，不能通过删 tag、强推或另一次重建抹掉冲突。失败时成功写入的标签可能保留，
只有随后完整清单核验通过才算发布完成。
失败的推广 job 也保留 `status: incomplete` 回执，列出已知的预期引用和停止阶段；它不会把未知写入结果
描述为“未执行”，也不代表此前成功写入的标签已回滚。

### 不发布的 CI 验证

PR/main 的容器验证仍是只读发行检查：CI 按 kernel、构建图、依赖和容器配置等输入调用
`container-check.yml`，使用 runner 本地 registry 和共享 Buildx builder，先验证标准环境，
公共/base 变化再验证 toolbelt。完整资格检查验证两种环境；普通 renderer 变化不重复构建镜像。
该 workflow 没有 GHCR 发布权限。它还在同一本地 registry 上运行极小 scratch 双架构夹具，
真实验证 Buildx adapter 的不存在标签识别、跨仓库 index digest 保真、两个通道的全计划冲突和同 digest 重试。
这些夹具只证明推广协议，不代替后续真实应用启动，也不证明 GHCR 的实际可见性。
`container-check.yml` 仅支持 `workflow_call`；完整资格会构建双架构产物，验证两个 amd64 应用启动，并在 QEMU 下
验证 arm64 原生依赖与内核，后者不等于原生 ARM 主机完整服务验收。手动运行 `ci.yml` 时可以启用
`container_benchmark`，重复同一构建图，检查热构建不重编 Rust，并上传冷/热计时与 digest。
这些操作仍不发布 GHCR，也不会产生可供部署的公开镜像引用。

正式和 commit 候选共用两阶段 Bake 图：先共享两种 base 的公共层，再固定各自 base digest 同时组装应用，
Rust/Web 公共阶段只构建一次。Rust 依赖 recipe 层和完整 vendor 补丁参与缓存身份，真实源码与版本身份仍单独编译。
大型中间层写入各镜像的 `buildcache-v2` registry 引用；只读 CI 只能读取，不能污染发布缓存。缓存是计算加速，
不是信任或资格证据。历史源码仍使用自己的 Dockerfile，因此只有包含这些阶段设计的源码获得相应编译优化。

### Docker Compose

先为镜像的 UID/GID `1000:1000` 准备可写 bind mounts，再启动：

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
export VARIN_UI_PASSWORD="$(openssl rand -base64 24)"
docker compose up -d
```

新命名发行发布后，默认拉取 `ghcr.io/youzini-afk/varin:latest`，即标准环境。
发布切换前旧 `varin:latest` 仍是 toolbelt；需要预先固定标准环境时显式设置
`VARIN_IMAGE=ghcr.io/youzini-afk/varin-slim:0.9.38`。开发工具链环境使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

overlay 同时选择 `varin-toolbelt` 应用和 `varin-runtime-toolbelt` 本地构建 base，不改变挂载、用户、
认证或关闭预算。`VARIN_IMAGE` 覆盖拉取的应用，`VARIN_RUNTIME_BASE_IMAGE` 覆盖本地构建 base；
本地覆盖不会发布镜像。需要可复现构建时同时固定两者的版本/digest。

The persistent paths are:

| Host path | Container path | Purpose |
| --- | --- | --- |
| `data/varin` | `/home/varin/.config/varin` | settings, runtime registry, auth keys, clients, pairing, tunnels, and Rust kernel state/recovery roots |
| `data/ssh` | `/home/varin/.ssh` | SSH identity used by workspace Git operations |
| `data/cloudflared` | `/home/varin/.cloudflared` | managed-local Cloudflare configuration and credentials |
| `workspaces` | `/home/varin/workspaces` | user projects |

Keep the data mount persistent so settings, credentials, installed extension artifacts and native
conversation/resource stores survive container replacement. The Catalog upgrades explicitly supported
older formats at its open boundary before execution; other storage domains follow their own format
checks. Unsupported, newer or corrupt stores are rejected without overwriting user assets. This is
not a general conversion guarantee; see [storage ownership](../architecture.md).

Verify the service and its native kernel readiness:

```bash
curl --fail http://127.0.0.1:3000/health
```

Deployment validation checks `status: "ok"`, the expected `varinVersion` and `releaseId`, and
`kernel.ready: true`. An HTTP response by itself is not proof that the kernel is ready. Published
images expose `releaseId: image-<git-sha>`; SSH releases use their content-addressed release ID, so a
probe cannot mistake a previous process with the same semantic version for the candidate.

### Runtime environment

| Variable | Behavior |
| --- | --- |
| `VARIN_UI_PASSWORD` | Required when the server is reachable beyond loopback |
| `VARIN_HOST` | Bind address; Compose defaults to `0.0.0.0` |
| `VARIN_DATA_DIR` | Persistent Varin data root |
| `VARIN_WORKSPACE_ROOT` | Root for mounted projects |
| `VARIN_SHUTDOWN_TIMEOUT_MS` | One complete Host stop budget, integer 1–2147483647 ms; default 10000 |
| `VARIN_STOP_GRACE_PERIOD` | Compose supervision grace; default `15s`, must exceed the Host stop budget |
| `VARIN_RESEARCH_RESERVE_CPU_CORES` | Explicit CPU capacity reserved from research admission; default 0 |
| `VARIN_RESEARCH_RESERVE_MEMORY_MB` | Explicit memory reserved from research admission; default 0 |
| `VARIN_TUNNEL_PROVIDER` | Tunnel provider, currently `cloudflare` when configured |
| `VARIN_TUNNEL_MODE` | `quick`, `managed-remote`, or `managed-local` |
| `VARIN_TUNNEL_HOSTNAME` | Hostname for managed-remote mode |
| `VARIN_TUNNEL_TOKEN` | Runtime-only Cloudflare token for managed-remote mode |
| `VARIN_TUNNEL_CONFIG` | Container path to managed-local cloudflared configuration |

`/health` is readiness: it returns HTTP 503 as soon as the Host drains or its kernel is unavailable.
`/live` is a lightweight HTTP-process liveness check and does not assert that new work can be admitted.
A normal foreground SIGTERM exits 143; an incomplete stop exits 1 and logs its owner/reason, elapsed
time and deadline. The default 10-second application budget preserves the previous setting, with
5 seconds of Compose supervision margin. These are initial defaults, not a measured drain SLA.
Set both budgets from representative workloads, and keep the external grace larger. A blocked Node
event loop cannot guarantee its own timer; the container supervisor remains the final boundary.

Set Docker/Compose CPU, memory and PID limits for the deployment explicitly. Host research diagnostics
report cgroup/affinity effective capacity, visible-ancestor scope, current headroom and pressure counters.
A logical research reservation or Rust compute slot is not a hard limit on all model, shell, LSP, extension
and background processes. The current container shares one failure domain; this change does not add
per-tool cgroups, a global semaphore, a hard queued-task count or an unmeasured memory-per-job estimate.

Container validation constrains its disposable candidate to 0.75 CPU, 2 GiB and 512 tasks, then checks
health, native runtime and brokered services. It copies the selected source's unchanged resource probe
to a temporary path and runs it inside that same container, comparing effective capacity/headroom to
Docker's configured limits before the real SIGTERM check. These are test fixtures, not deployment
defaults or a mixed-workload benchmark; this probe check does not replace research admission tests.

Passwords and tunnel tokens are runtime values. They are never accepted as Docker build arguments or
embedded in an image.

## Cold backup and isolated recovery

Use the [cold-backup procedure](cold-backup.md) for complete declared data/workspace roots, a verified
manifest and fenced inspection/recovery copies. Stop every writer first. Do not delete WAL files or
start a copied hostId on the production network; a separately runnable clone is not yet supported.

## SSH deployment

The maintainer helper builds the same canonical cloud tree, uploads an immutable archive, verifies
its SHA-256 digest on the remote host, installs production dependencies for that host, verifies the
native package/executable closure, and only then replaces the active release.

Remote requirements:

- Linux with Node.js 22.19 or newer;
- Bun available to the non-interactive SSH session;
- `tar` and normal POSIX filesystem symlink support;
- a stable directory for Varin data that is not inside an individual release.

Configure targets in `~/.config/varin/varin-dev.json`. Start from
[`scripts/varin-dev.config.example.json`](../../scripts/varin-dev.config.example.json):

```json
{
  "remoteDeployments": [
    {
      "id": "production",
      "label": "Production",
      "host": "user@example-host",
      "port": 3000,
      "dir": ".local/share/varin/deployments/production",
      "bindHost": "0.0.0.0",
      "dataDir": "~/.config/varin/production",
      "envFile": "~/.config/varin/production.env",
      "healthTimeoutSeconds": 60,
      "apiOnly": false
    }
  ]
}
```

Create the referenced environment file on the remote host and restrict its permissions:

```bash
install -m 600 /dev/null ~/.config/varin/production.env
printf '%s\n' 'VARIN_UI_PASSWORD=replace-with-a-long-random-value' \
  >> ~/.config/varin/production.env
```

Add provider or tunnel environment values to the same file when needed. The password is read on the
remote host; it is not copied into SSH arguments, logs, or the deployment archive.
Deployment refuses to source the file unless it is owned by the SSH deployment user and has mode
`0400` or `0600`.

Deploy with:

```bash
bun run varin-dev remote-deploy-web --remote-id production
```

The remote directory contains:

```text
incoming/       uploaded archives and deploy helper
releases/       immutable content-addressed releases
current -> ...  active release
previous -> ... last healthy release
cache/bun/      reusable target-platform dependency cache
```

The deploy helper builds and verifies the candidate while the active process keeps serving. It
atomically switches `current` before stopping that process, so a link-switch failure leaves the
active runtime untouched. After the switch it stops the old runtime, starts the candidate, and polls
`/health` for the expected Varin version, candidate release ID and a ready native kernel. If startup or health
validation fails, it stops the candidate, restores `current` to the previous release, restarts it,
and verifies the rollback. Releases are not pruned automatically; the operator retains the full
rollback history until deliberately removing old, inactive directories.

A root-level atomic deployment lock serializes concurrent updates. Every release id is permanently
bound to the uploaded archive's complete SHA-256 digest, so retrying the same archive is idempotent
while reusing an id for different content is rejected.

## Building the canonical runtime directly

```bash
bun run build:cloud-runtime
```

By default this writes `artifacts/cloud-runtime` and
`artifacts/varin-cloud-runtime.tgz`. To install target-platform production dependencies for a
local smoke run:

```bash
node scripts/build-cloud-runtime.mjs --install --no-archive
node artifacts/cloud-runtime/packages/web/bin/cli.js serve --foreground
```

The build fails when a required workspace dependency or compiled Host output is missing, the
production lock is inconsistent, or the staged native executable/manifest cannot be verified.

When a runtime dependency or override changes, deliberately refresh and review the dedicated lock:

```bash
bun run update:cloud-runtime-lock
```

Normal cloud builds verify that committed lock with `--frozen-lockfile`; they never resolve a newer
transitive dependency merely because an image or SSH deployment was rebuilt later.
