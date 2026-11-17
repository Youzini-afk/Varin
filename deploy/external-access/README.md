# 自建外部访问部署文件

这是一套可独立复制的普通配置文件，不是 VPS 部署器。用户或其授权的 Agent 负责选择服务器、DNS、安装、启动、升级和清理；Varin 只管理自己的受控公网入口、设备授权以及可选的本端 frpc。不要把这套文件覆盖到已有服务后直接重启。

本配套使用 FRP `v0.65.0` 和 Caddy `2.10.2-alpine`。下文提供配置、启动、日志和实际访问的检查方法，可由用户或 Agent 按目标环境选用。

## 文件与边界

| 文件 | 用途 |
| --- | --- |
| `compose.yaml`、`.env.example` | 独立 frps + Caddy，参数不含秘密 |
| `frps.toml`、`Caddyfile` | Compose 使用的只读服务配置 |
| `offline/index.html` | 仅导航使用的真实 503 离线页 |
| `snippets/frps.toml`、`snippets/frpc.toml` | 原生 frps 和用户自行运行的 frpc 示例 |
| `snippets/Caddyfile`、`snippets/nginx.conf` | 已有 HTTPS 服务接入示例 |
| `validate.sh` | 不启动服务的本地样例检查；不读取实际 `.env` 或部署秘密 |

```text
浏览器/其他 Varin -- HTTPS :443 --> Caddy
                                  |
                        私有 Docker bridge :7300
                                  |
Varin Host 的 frpc -- 验证 CA 的 TLS + token --> frps :7000
         |
         +--> 同一 Host 的受控入口 127.0.0.1:3100
```

`7000` 是 frps 控制端口，`7300` 是 frpc 建立的 TCP 映射，`3100` 是 Varin 受控公网监听端口，三者不能混用。Compose **只发布 80/tcp、443/tcp、443/udp 和控制端口**，不发布 `7300`。专用 bridge 只连接这两个服务，不使用 host network、路由网关模式、直接路由或 Docker socket；`expose` 不是安全边界。本机 Docker 管理员仍能访问容器网络并读到秘密，VPS 是受信代理，会处理 HTTP 明文。

原生同机 frps 片段用 `proxyBindAddr = "127.0.0.1"`。Compose 不能照抄这个绑定，因为另一个容器的回环不是 frps 的回环。已有网络若允许外部路由到容器 IP，须由运营者恢复网络隔离后再部署，不能只以“没有端口映射”判定安全。不要将应用端口、仪表盘或管理端口加到公网放行清单。

## 1. 准备参数与秘密

前提：一台已有 Docker Engine 与 Compose v2 的 Linux VPS，运营者管理的公网 DNS 名称、可达的 TCP 80/443 和控制端口，以及 OpenSSL。HTTP/3 使用 UDP 443，可不开放；FRP 本例不启用 UDP、KCP、QUIC、Dashboard 或 Prometheus。已有 80/443 服务时使用 `snippets/`，不要抢占它的端口。以下命令由部署者审阅后在目标目录运行，本文件本身不会执行它们。

```sh
cp .env.example .env
# 编辑 .env：VARIN_DOMAIN=varin.example.com（不要写 scheme/path/port）
# FRP_CONTROL_PORT 只改宿主发布端口，容器内仍为 7000。
umask 077
mkdir -p secrets pki
chmod 700 secrets pki
# 新安装才执行；不要覆盖已有 token/CA/key。
test ! -e secrets/frp-token && openssl rand -hex 32 > secrets/frp-token
```

没有共用默认 token。`secrets/frp-token` 是服务连接秘密，不是浏览器配对秘密，不放 `.env`、URL、命令参数、Git、聊天、截图或普通诊断包。Compose 的 file secrets 是只读挂载，**不是自动加密的秘密仓库**；本地文件权限仍须保护。不要把 `secrets/` 或 `pki/` 打进部署文件下载包。

FRP 使用自己的服务证书，不复用或依赖 Caddy 自动签发证书的私有目录。下面建立一套仅供 frpc 验证 frps 的 CA；替换 **两处** `forwarding.example.com` 为实际控制服务 DNS 名。这不自动配置 DNS。若控制连接只使用固定 IP，将 SAN 改为 `IP:实际地址`，并在客户端使用匹配的 TLS 名称/IP。

```sh
# 仅新安装。私钥不打印到终端。已有 PKI 时改用你的签发流程。
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout pki/ca.key -out pki/ca.crt -days 3650 -sha256 \
  -subj '/CN=Varin FRP CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout secrets/frps.key -out pki/frps.csr \
  -subj '/CN=forwarding.example.com'
printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature' 'extendedKeyUsage=serverAuth' \
  'subjectAltName=DNS:forwarding.example.com' > pki/frps.ext
openssl x509 -req -in pki/frps.csr -CA pki/ca.crt -CAkey pki/ca.key \
  -CAcreateserial -out secrets/frps.crt -days 365 -sha256 -extfile pki/frps.ext
chmod 600 secrets/frp-token secrets/frps.key pki/ca.key
openssl verify -CAfile pki/ca.crt secrets/frps.crt
openssl x509 -in secrets/frps.crt -noout -checkhost forwarding.example.com
```

通过自己已信任的传输渠道，把 **token 与 CA 公共证书 `pki/ca.crt`** 安全放到 Varin Host。CA 证书无需保密，但完整性必须验证；不要向 Host 发送 `pki/ca.key` 或 `frps.key`。CA 私钥应单独加密备份/离线保存。使用前确认服务器证书有效期，365 天是本示例的签发期限而非自动续期。后续在到期前用同一 CA 签发新服务证书并重启 frps，保持客户端 CA 不变；更换 CA 要先安排两端信任迁移。

## 2. 验证并启动 VPS 服务

```sh
# 不启动服务；不会展开或打印 token。
sh validate.sh
# 可选：已有 Docker Compose 和 Caddy 2.10.2 时检查临时样例树，不启动服务。
sh validate.sh --engines
# 读取你自己的 .env 检查 Compose。不要把完整配置转储公开分享。
docker compose config --quiet
docker compose pull
# 验证已挂载的真实 FRP 配置；run 不发布服务端口。
docker compose run --rm --no-deps frps verify -c /etc/frp/frps.toml
# 检查 Caddy 的适配和模块配置，不启动监听器或签发站点证书。
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d
docker compose ps
docker compose logs --tail=50 frps caddy
```

配置以只读 bind mount 提供；缺少文件应报错，不自动创建同名目录。容器根文件系统只读、去除不必要 capability；Caddy 仅有低端口绑定能力。Caddy `/data` 和 `/config` 是持久卷，含证书私钥/账号信息，应按秘密备份。管理 API 已关闭；配置变更使用受控重建，而非暴露管理 API。`unless-stopped` 在 Docker 重启后恢复服务，但不会替代主机服务和网络管理。

Caddy 对正常公网 DNS 名使用原生自动 HTTPS；DNS A/AAAA 都必须正确，证书验证要求外部可达、出口 DNS/ACME 可用、持久卷可写。不要使用 `tls_insecure_skip_verify` 或浏览器忽略证书错误来验收。FRP 本地 CA 与浏览器 HTTPS 证书是两条独立信任链。

## 3. 接入 Varin Host

在当前实际运行工作的 Host 上配置，而不是在查看设置的前端电脑上配置：

- 公网 Origin：`https://varin.example.com`，与 HTTPS 入口完全一致。
- 后端：受控公网入口 `127.0.0.1:3100`，不要指向普通本机应用监听端口。
- Varin 管理 frpc：控制地址 `forwarding.example.com`、发布端口 `7000`（或 `.env` 中选择的端口）；代理名 `varin-home`、映射端口 `7300`；现有 frpc v0.65.0 绝对路径、token 以及 Host 上 CA 文件绝对路径；TLS server name 与服务证书 SAN 匹配。使用设置/API 所要求的安全凭据入口，不在命令行位置参数传 token。
- 自行管理 frpc：使用 `snippets/frpc.toml`，选择外部管理转发，只向 Varin 登记公网 Origin 与受控后端。不要同时让 Varin 与系统服务运行同一个代理名/映射。设置中的停用仍关闭 Varin 业务入口，不会替你停止外部进程。

启用后检查实际连接状态，再通过 HTTPS 创建/兑换设备配对。FRP token 仅授权转发服务连接，不替代 Varin 设备认证。固定域名和稳定 Host 数据目录下，重启转发器不应撤销设备授权。另一台 Varin 使用同一个 HTTPS 地址作为原 HTTP 工作连接，沿原发现、配对和能力权限接入。

已有反代可将片段中的 `127.0.0.1:7300` 换成设置展示的**实际受控后端**。异机后端须由现有可信私网或加密链路到达；反向代理本身不能替代穿透。保留精确 Host（含非默认端口）、Origin、Cookie、Authorization、查询串和 WebSocket 升级。不重写 Cookie Domain，不添加来自回环就免认证的规则。

## 流式、日志与离线约定

Caddy 在本样例中不启用请求/响应缓冲、压缩、缓存或重试写请求，`flush_interval -1` 立即转发；WS 由 `reverse_proxy` 原生升级。Nginx 片段统一禁用代理请求/响应缓冲、磁盘响应临时文件、缓存和 gzip，并保留 HTTP/1.1 升级。Nginx 的读/写空闲超时示例为 1 小时，不是会话/授权期限；按实际长期空闲连接策略调整。上传上限由业务管理，Nginx 示例 `client_max_body_size 0` 不额外加上限；运营者可明确设置适合自己的限制。

访问日志关闭。Caddy 还排除可能含请求 URI/头的 HTTP 错误日志，保留服务/TLS 日志；Nginx 站点请求错误日志丢弃。这有意牺牲逐请求诊断，避免 pairing/query/认证秘密被持久化。不能用临时 debug、`curl -v`、记录全部头或正文补回日志而未先处理秘密。不要给示例加第三方分析、CDN 缓存或会落盘的请求捕获。

离线 HTML 只替换 **GET/HEAD + `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document` + 接受 HTML + 无 Upgrade** 的非 `/api`、`/auth`、`/health` 请求：

- 无上游连接时返回 503；Host 明确返回 503 的页面导航也显示离线页。
- API、SSE、文件传输和 WS 不拦截上游错误，保留原状态、头与正文；无上游时保留代理真实网关错误，不伪造 JSON 业务响应。
- 老客户端缺少 Fetch Metadata 时保留原错误；不能只凭 `Accept: text/html` 判断导航。
- 已经开始的流中途断线不能改写成离线 HTML，也不自动重发结果未知的写请求。
- VPS 关机、DNS 或 TLS 失败时无法提供离线页，客户端会看到真正网络错误。

## 多个 Host、已有服务与 IP 地址

一个 Host 对应唯一代理名、内部映射端口和公网域名，例如 `varin-home:7300 → home.example.com`、`varin-work:7301 → work.example.com`。显式扩展 `allowPorts`，添加 Caddy 站点并分别指向对应映射；不要发布这些应用端口。每个 Host 的设备授权留在自己的数据目录中。

一个 frps 的简单 token 是**服务级共享权限，不是按 Host 的隔离机制**。多个不互信的 Host 应使用独立 frps 实例、token、控制端口和私有网络，再由 HTTPS 服务接入，或采用自己已审计的鉴权设施。不要把多个 token 拼成一个示例 token，也不要为接入本例重置已有 frps 的所有客户端凭据。原生片段的 `proxyBindAddr`、`allowPorts`、TLS 和 token 都会影响该实例现有代理，合并前先盘点依赖。

本 Compose 的默认支持路径是公网 DNS 名。**把 IP 填进 Caddy 站点不等于取得公网受信证书**：Caddy 默认对 IP/内部名称使用本地 CA，其他浏览器不自动信任。Let's Encrypt 公网 IP 证书有效期为 **160 小时**，必须采用支持 IP 标识和 `shortlived` profile 的 ACME 客户端以及原生自动续期/代理重载。本套固定版本未验证公开 IP ACME 签发，不承诺自动支持它。已有可续期的 IP 证书可由运营者配到现有 HTTPS 服务；例如 Caddy 使用 `tls /path/fullchain.pem /path/privkey.pem` 并由其证书流程负责刷新，不能把一次手动签发当作长期部署。Varin 不新增证书巡检任务。

## 排障与验收

先定位阶段，不以“容器启动了”替代访问成功：

| 现象 | 检查 |
| --- | --- |
| Compose 缺文件/权限错误 | `docker compose config --quiet`；本地文件存在、挂载路径、文件属主/权限与 secret 源 |
| FRP 连接失败 | 控制端口、证书 SAN/CA/到期、两端 token、代理名冲突、`allowPorts`；不要把 token 印到日志 |
| 首页 503 | frpc 是否发布 7300、Host 是否运行/启用、映射是否指向 guarded 3100，而非本机普通入口 |
| HTTPS 不可信 | DNS A/AAAA、80/443 可达、Caddy 服务/TLS 日志、时钟和持久卷；不要绕过验证 |
| 配对后仍拒绝 | 精确 Origin/Host、设备授权和 Cookie；不能以代理身份绕过业务认证 |
| 流成批出现/WS 掉线 | 逐层排除上游/CDN 缓冲、压缩、升级头和空闲超时；不能只测试首页 |

未带凭据的连接测试不要加入 token/cookie，也不要开启 verbose：

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://varin.example.com/
# 断开转发后：导航须为 503，类型为 text/html。
curl -sS -I -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Dest: document' https://varin.example.com/
# 同样离线时：API 不能得到本套离线 HTML（真实状态可能为 502/503）。
curl -sS -D - https://varin.example.com/api/threads
```

发布/升级前在隔离测试部署逐项记录结果，不在未授权生产实例做停机实验：

1. 实际镜像拉取、Compose 配置、只读挂载、受限 capability、卷写权限和冷启动；从 VPS 外确认 7300 与任何管理端口不可达，控制端口必须验证 TLS/token。
2. 真实 `HTTPS → Caddy → frps → frpc → guarded Host`：页面/资源、Cookie 配对、写操作 Origin、API、SSE 的逐块时序、WS 双向消息、较大上传/下载完整性与原 HTTP 工作连接发现。
3. 分别停止 frpc、关闭 Host、停用入口：浏览器导航 503；JSON/SSE/上传/WS 错误不换成 HTML；处理中断不自动重放写入。
4. Host 重启、VPS/容器重启与网络恢复：稳定域名、启用意图和设备授权符合预期；旧 WS/SSE 重连不恢复已撤销权限。
5. Caddy 自动证书签发、其原生续期路径及配置重载；FRP CA/服务证书匹配；HTTPS 证书错误真实失败。至少一次前端、Host、VPS 分离链路。
6. 请求中放入**虚构标记**（不是实际秘密），核对运行日志无 URL secret、Cookie、Authorization、正文；检查没有业务缓存或请求正文临时文件。

`validate.sh` 需要 Python 3.11+，只检查随包样例，不读取运行状态，不发业务网络请求、不安装组件、不改防火墙、不签发证书、不开始监听。`--engines` 明确选择已有 Docker Compose 配置解析，以及已有 Caddy 2.10.2 的真实 adapt/validate；它只复制样例到临时目录，使用虚构 token/文件和独立 Caddy 数据目录，不接触实际部署秘密。缺少所选引擎返回退出码 2。可用 `FRPS_BIN=/绝对路径/frps FRPC_BIN=/绝对路径/frpc sh validate.sh` 额外验证 v0.65.0 配置装载；它只生成并删除临时假 token。缺少引擎的阶段会明确显示未运行，不能据此宣称 Compose 或 HTTPS 已验证。自管 frpc 若受 `HTTP_PROXY` / `HTTPS_PROXY` 环境影响，先检查其服务环境；不要误将代理链故障归为 CA/token 错误。

### 仅本机 Compose 冒烟计划（尚未执行）

此计划是单独的工程验收，不是生产部署或远程探测，也不等价于公网 ACME 验收。需要部署者明确选择一台已有 Docker 的测试机器，使用一次性目录、项目名、网络、token、CA 和卷；不挂载用户 Varin 数据，不安装系统信任根，不复用生产 token/证书。不要原地改生产 Compose。

1. 将样例复制到临时目录，设置独立 Compose 项目名（通过 `-p varin-kit-smoke`），生成仅测试用的 FRP CA/key/token。直接编辑临时 Compose 的 **全部** `ports` 项，而不是追加覆盖：控制端口用 `127.0.0.1:17000:7000/tcp`；HTTP/HTTPS 用 `127.0.0.1:18080:80/tcp`、`127.0.0.1:18443:443/tcp`，HTTP/3 如需测试只用 `127.0.0.1:18443:443/udp`。应用映射 7300 仍不发布。先审查 `docker compose ... config` 的最终端口清单，任何 `0.0.0.0` 或 `::` 发布都应停止测试。
2. 临时 `.env` 设置 `VARIN_DOMAIN=localhost`，在临时 Caddy 全局块加 `skip_install_trust`。Caddy 对 localhost 自动使用自己的内部 CA，**不进行公网签发**。HTTPS 请求使用 `https://localhost:18443`；测试 Host 的 Origin 和证书名分别匹配该地址及 localhost。
3. 在测试机器回环开启一次性 HTTP 测试后端（或一次性 Varin 数据目录），frpc 在该机器本地连接 `127.0.0.1:17000`，TLS server name 按测试 frps 证书设置，并将本地后端映射到 7300。不能让容器回环代替宿主回环；这里 frpc 与后端都在宿主测试进程中。
4. 启动这个独立项目后，仅从测试 Caddy 容器复制 `/data/caddy/pki/authorities/local/root.crt` 到临时目录。`curl --cacert 临时root.crt https://localhost:18443/...` 使用显式信任，不加 `-k`，不运行 `caddy trust`，不改系统/浏览器信任库。测试 Cookie/Origin 时使用假的设备凭据或一次性 Varin 数据；不要导入生产 Cookie。
5. 验证页面、Host/Origin/认证头、逐块 SSE、WS 升级与双向数据、较大上传/下载；断开一次性 frpc 后严格测试导航 503 与 API/SSE/WS 保留真实错误。还应分别发送伪导航头到 `/api/...`、普通 fetch 到 UI 路径、POST 到 UI 路径，确认都不落入导航离线页。用虚构 secret 标记检查服务日志。
6. 重启此测试项目，确认同一测试证书卷仍可用及 frpc 恢复。测试结束只关闭/删除**明确的临时项目**及其卷、进程、目录。记录镜像摘要、架构、Compose/Caddy 版本和每项结果。localhost 内部 CA 成功不证明公网 DNS/ACME、真实浏览器或三机分离链路成功。

## 升级、备份与移除

- 先保存配置、镜像版本/摘要和受保护的证书卷备份；确认上游 release notes、镜像来源及对应 frpc 兼容性。不要把版本改为 `latest`。当前 pin 可进一步换成运营者验证过的多架构 manifest digest；不要错把单一架构 digest 当作所有平台镜像。
- 在隔离部署完成上述验收，再更改明确的 image 版本。`docker compose pull` 后 `docker compose up -d`；配置或秘密文件变更时 `docker compose up -d --force-recreate`。重建可能断开实时连接，先安排维护窗口。tokenSource 在加载时读取，换 token 要协调两端和重启，不能假定自动热更新。
- 回退使用原镜像和配置并保留卷，确认新版本是否改了证书存储格式后再决定回退。普通升级不要删除 `/data`，否则可能丢失 ACME 账户并触发重复签发限额。
- 仅停止：`docker compose stop`。移除本项目容器与网络、**保留证书卷**：`docker compose down`。这不撤销 Varin 设备授权，也不清理 Host 外部配置。
- `docker compose down --volumes` 会删除本项目持久证书/账号卷，不能作为默认清理命令。先明确备份和永久删除意图再执行；随后由运营者分别处理 DNS、防火墙、token、CA 私钥和部署目录。不要删已有反代或其他 Compose 项目的卷。

## 上游依据

- [FRP v0.65.0 服务端完整配置](https://github.com/fatedier/frp/blob/v0.65.0/conf/frps_full_example.toml)、[官方 frps 镜像](https://github.com/fatedier/frp/pkgs/container/frps)、[tokenSource 文件认证](https://gofrp.org/en/docs/features/common/authentication/)。本例只用 v0.65.0 已有字段，不使用后来新增的 exec token source。
- [Caddy 2.10.2](https://github.com/caddyserver/caddy/releases/tag/v2.10.2)、[反代/流式/响应拦截](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[错误路由](https://caddyserver.com/docs/caddyfile/directives/handle_errors)、[文件状态码](https://caddyserver.com/docs/caddyfile/directives/file_server)、[日志全局选项](https://caddyserver.com/docs/caddyfile/options#log)。
- [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Let's Encrypt IP/160 小时证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。
- [Nginx 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[错误页与内部位置](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page)。
- [Compose 服务/端口/只读挂载](https://docs.docker.com/reference/compose-file/services/)、[Compose 网络](https://docs.docker.com/reference/compose-file/networks/)。
