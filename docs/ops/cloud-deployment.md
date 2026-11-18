# Cloud Deployment

Varin uses one canonical cloud runtime layout shared by Docker images, local smoke checks, and SSH deployments: compiled Web Host/UI/CLI, `application-client`, `protocol`, `script-runtime`, `settings-store`, required extension packages, and the verified platform `varin-kernel` binary + manifest. Exact closure: `CLOUD_RUNTIME_PACKAGE_DIRS` in [scripts/build-cloud-runtime.mjs](../../scripts/build-cloud-runtime.mjs).

## Container Images

Published to **`ghcr.io/astrmira`** (from v0.9.50+). Update `VARIN_IMAGE` / `VARIN_RUNTIME_BASE_IMAGE` if overriding from older namespaces.

| Image | Contents & Aliases |
| --- | --- |
| `ghcr.io/astrmira/varin` | Default slim app (`varin-slim` points to the same digest) |
| `ghcr.io/astrmira/varin-toolbelt` | App with preinstalled dev toolchains (Java/Maven, Go/gopls, Rust/rust-analyzer, LSPs, `gh`, `ripgrep`, rootless BuildKit, amd64 Chrome/Playwright) |
| `ghcr.io/astrmira/varin-node` | Standalone Resource Node (files/commands only; no UI, models, Bot, or Catalog) |
| `ghcr.io/astrmira/varin-runtime-slim` | Slim base (Bun, Node, Git, SSH, `cloudflared`, Python + native build tools) |
| `ghcr.io/astrmira/varin-runtime-toolbelt` | Toolbelt base (`varin-runtime-base` points to the same digest) |

Images include `/etc/varin/image-capabilities.json`, `io.varin.image.role`, `io.varin.image.variant`, provenance, and SBOMs.

### Release & Commit Workflows

- **Official releases (`docker.yml`)**: Triggered by matching `v<version>` tag push or manual `release_ref` from `main`. Builds `linux/amd64` + `linux/arm64`, pins apps to exact base digests, runs Linux qualification + real amd64 smoke (checking `/health`, `releaseId`, native kernel, brokered services, and graceful `SIGTERM` exit code `143` within 15s), verifies anonymous GHCR pull, then promotes immutable version/`sha-<SHA>` tags and (for highest stable tag only) floating `latest`/`0.9`/`0`.
  - Resume failed promotion without rebuilding: `gh workflow run docker.yml --ref main -f release_ref=vX.Y.Z -f resume_run_id=<ID> -f resume_run_attempt=<N>`
  - Move tag and re-publish same version explicitly: pass `-f replace_version=true`.
- **Commit images (`docker-commit.yml`)**: Manual dispatch from `main` only (`-f source_sha=<40-char SHA>` optional). Runs full CI + dual smoke and publishes immutable `commit-<SHA>` tags only (never touches `latest` or release tags). Resume with `-f resume_run_id=<ID>`.
- **Read-only PR check (`container-check.yml`)**: Runs against a local runner registry with no GHCR push privileges; tests promotion protocol with scratch multi-arch fixtures.

## Docker Compose

Prepare UID/GID `1000:1000` bind mounts before starting:

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
export VARIN_UI_PASSWORD="$(openssl rand -base64 24)"
docker compose up -d
```

For the toolbelt variant:

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

| Host path | Container path | Purpose |
| --- | --- | --- |
| `data/varin` | `/home/varin/.config/varin` | Settings, auth keys, pairing, tunnels, extensions, Rust Catalog/Storage/recovery roots |
| `data/ssh` | `/home/varin/.ssh` | SSH keys for Git |
| `data/cloudflared` | `/home/varin/.cloudflared` | Managed-local Cloudflare config/credentials |
| `workspaces` | `/home/varin/workspaces` | User projects |

Verify readiness (checks `status: "ok"`, expected `varinVersion` / `releaseId`, and `kernel.ready: true`):

```bash
curl --fail http://127.0.0.1:3000/health
```

### Resource Node (`docker-compose.resource-node.yml`)

Expose a dev/test machine's files and commands to an existing Agent Host without running a full app:

1. Point `VARIN_NODE_WORKSPACE` at the directory to share (mapped to `/home/varin/workspaces`; accessible by UID `1000:1000`). Node state lives in its own `varin_node_state` volume (never share state dirs with a full app).
2. Generate an offline pairing token (read-only by default; add `--allow-write` / `--allow-commands` only when intended — commands run as the node user, not a sandbox):
   ```bash
   docker compose -f docker-compose.resource-node.yml run --rm --no-deps \
     -v /abs/private-dir:/private varin-node pair --output /private/agent-pair.json
   ```
3. Start the node (`docker compose -f docker-compose.resource-node.yml up -d`, bound to `127.0.0.1:3001` by default; reach cross-machine via SSH forward or controlled HTTPS) and register its address + token in your Agent Host's Connections settings. Revoke with `revoke <clientId>` while stopped.

### Runtime Environment

| Variable | Behavior |
| --- | --- |
| `VARIN_UI_PASSWORD` | Required when reachable beyond loopback |
| `VARIN_HOST` | Bind address (Compose default: `0.0.0.0`) |
| `VARIN_DATA_DIR` | Persistent Varin data root |
| `VARIN_WORKSPACE_ROOT` | Root for mounted projects |
| `VARIN_SHUTDOWN_TIMEOUT_MS` | Host shutdown budget in ms (default `10000`) |
| `VARIN_STOP_GRACE_PERIOD` | Compose stop grace (default `15s`; must exceed shutdown timeout) |
| `VARIN_RESEARCH_RESERVE_CPU_CORES` / `_MEMORY_MB` | Explicit CPU/memory reserved from research admission (default `0`) |
| `VARIN_TUNNEL_PROVIDER` / `_MODE` / `_HOSTNAME` / `_TOKEN` / `_CONFIG` | Tunnel settings (`cloudflare`: `quick` / `managed-remote` / `managed-local`) |

`/health` returns `503` as soon as draining starts or the kernel is unavailable; `/live` checks HTTP process liveness only. Never pass passwords or tunnel tokens as Docker build args.

## Cold Backup & Isolated Recovery

See [cold-backup.md](cold-backup.md). Stop every writer first; never delete WAL files or boot a copied `hostId` on the live network.

## SSH Deployment

Builds the canonical cloud tree, uploads a SHA-256-verified archive, installs target-platform deps, validates the native kernel, and atomically switches `current -> releases/<id>` with automatic rollback to `previous` on `/health` failure.

- **Remote requirements**: Linux, Node.js >= 22.19, Bun in non-interactive SSH `PATH`, `tar`, POSIX symlinks, and a persistent data dir outside `releases/`.
- **Config**: `~/.config/varin/varin-dev.json` (template: [scripts/varin-dev.config.example.json](../../scripts/varin-dev.config.example.json)). Keep the remote `envFile` mode `0600` or `0400` owned by the deploy user.
- **Deploy**:
  ```bash
  bun run varin-dev remote-deploy-web --remote-id production
  ```

## Building the Canonical Runtime Directly

```bash
bun run build:cloud-runtime
# Local smoke without archive:
node scripts/build-cloud-runtime.mjs --install --no-archive
node artifacts/cloud-runtime/packages/web/bin/cli.js serve --foreground
```

When production dependencies or overrides change, refresh and review the dedicated lockfile:

```bash
bun run update:cloud-runtime-lock
```
