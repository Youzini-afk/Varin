# Self-Hosted External Access Kit

Standalone reference configs for exposing a local Varin Host over HTTPS via **FRP `v0.65.0`** + **Caddy `2.10.2-alpine`** (or an existing Nginx/Caddy reverse proxy). Copy and adapt to your own VPS — do not overwrite an existing production service in place.

## Files & Architecture

| File | Purpose |
| --- | --- |
| `compose.yaml`, `.env.example` | Standalone `frps` + `caddy` Compose stack (no secrets in `.env`) |
| `frps.toml`, `Caddyfile` | Read-only service configs mounted by Compose |
| `offline/index.html` | Real `503` offline page for browser document navigations only |
| `snippets/frps.toml`, `snippets/frpc.toml` | Native `frps` and self-managed `frpc` examples |
| `snippets/Caddyfile`, `snippets/nginx.conf` | Snippets for integrating into an existing HTTPS reverse proxy |
| `validate.sh` | Local sample validation (Python 3.11+, never touches real `.env`/secrets; `--engines` checks Compose + Caddy) |

```text
Browser / Remote Varin -- HTTPS :443 --> Caddy
                                           |
                                private Docker bridge :7300
                                           |
Varin Host frpc -- CA-verified TLS + token --> frps :7000
         |
         +--> Host guarded external listener 127.0.0.1:3100
```

- **Ports**: `7000` (frps control), `7300` (internal TCP proxy, **never** published externally), `3100` (Varin guarded public listener). Compose publishes only `80/tcp`, `443/tcp`, `443/udp`, and the control port.
- Native same-host `frps` uses `proxyBindAddr = "127.0.0.1"`; Compose binds on its private bridge network instead.

## 1. Prepare Config, Token & FRP PKI

```sh
cp .env.example .env
# Edit .env: VARIN_DOMAIN=varin.example.com (hostname only, no scheme/path/port)
umask 077
mkdir -p secrets pki && chmod 700 secrets pki
test ! -e secrets/frp-token && openssl rand -hex 32 > secrets/frp-token
```

Generate a dedicated CA + server cert for `frpc → frps` (replace both occurrences of `forwarding.example.com` with your control hostname; keep `pki/ca.key` and `secrets/frps.key` off the Varin Host):

```sh
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

Copy only `secrets/frp-token` and `pki/ca.crt` to your Varin Host over a trusted channel. Never place tokens in `.env`, URLs, CLI args, Git, or logs.

## 2. Validate & Start on VPS

```sh
sh validate.sh
docker compose config --quiet
docker compose pull
docker compose run --rm --no-deps frps verify -c /etc/frp/frps.toml
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d
docker compose ps && docker compose logs --tail=50 frps caddy
```

## 3. Connect Varin Host

Configure on the target Varin Host (not a remote browser client):
- **Public Origin**: `https://varin.example.com` (exact match with HTTPS entry)
- **Guarded backend**: `127.0.0.1:3100` (not the unguarded local UI port)
- **Varin-managed `frpc`** (or external `snippets/frpc.toml`): control `forwarding.example.com:7000`, proxy name `varin-home`, remote port `7300`, `frpc` v0.65.0 binary, token, CA file, and matching TLS server name.
- For multiple untrusted Hosts, run separate `frps` instances/tokens (a single `frps` token is shared service-level auth, not per-Host isolation).

## Streaming, Privacy & Offline Rules

- **No buffering/compression**: Caddy sets `flush_interval -1` with native WS upgrade; Nginx disables proxy request/response buffering, temp files, cache, and gzip with `client_max_body_size 0` and HTTP/1.1 upgrade headers.
- **No access logs**: Access and HTTP request-error logs stay off so pairing tokens, cookies, and query secrets never hit disk.
- **Offline HTML (`503`)**: Served **only** for `GET`/`HEAD` browser document navigations (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, `Accept: text/html`, no `Upgrade`) outside `/api`, `/auth`, `/health`. API, SSE, uploads, and WebSockets preserve real proxy/upstream errors.
- **Public DNS vs bare IP**: Default Caddy auto-HTTPS requires a public DNS name (not an IP address).

## Troubleshooting & Lifecycle

| Symptom | Check |
| --- | --- |
| Compose missing file / perms | `docker compose config --quiet`, mount paths, secret file ownership/modes |
| FRP won't connect | Control port, cert SAN/CA/expiry, matching token, proxy name conflicts, `allowPorts`, local `HTTP(S)_PROXY` env |
| Homepage returns `503` | `frpc` connected on `7300`, Host running/enabled, forwarding to guarded `3100` |
| Auth rejected after pairing | Exact `Host`/`Origin`, Cookie preservation, device grant (never bypass auth for loopback) |
| Chunked SSE / WS drops | Upstream/CDN buffering, gzip, upgrade headers, idle timeouts |

Upgrade with pinned versions (`docker compose pull && docker compose up -d --force-recreate`); stop/remove without wiping Caddy ACME certs via `docker compose down` (avoid `--volumes` unless intentionally decommissioning).
