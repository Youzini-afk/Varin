# Varin cloud deployment

Varin has one cloud release layout shared by containers, local deployment checks, and SSH
deployments. The layout contains the compiled Web server plus the complete private Pi runtime
closure:

- `@varin/protocol`;
- `@varin/pi-host`;
- `@varin/runtime-broker`;
- `@varin/settings-store`;
- `@varin/web`;
- the target `packages/web/kernel` executable and manifest.

These packages remain one workspace because the broker resolves the bundled host through package
exports and Pi loads runtime resources from the installed package tree. Desktop Host workers bind a
selected Pi package root at process start; the cloud builder still copies the pinned
`@earendil-works/pi-*` packages into the staged `pi-host` production graph so images stay
self-contained. The cloud builder creates a dedicated production `bun.lock`; native dependencies are
installed on the target OS and CPU instead of being copied from the developer machine. The Rust kernel
is built for the release target, copied with its SHA-256/build/architecture manifest, and exercised by
`verify-kernel.mjs` before an image or SSH release is accepted. Storage/PTY do not install a second
`better-sqlite3` or Node PTY authority.

## Container images

The Docker workflow publishes four images to GHCR:

| Image | Role |
| --- | --- |
| `ghcr.io/youzini-afk/varin-slim` | Application on the slim runtime. Compose default. |
| `ghcr.io/youzini-afk/varin` | Application on the language-toolbelt runtime. |
| `ghcr.io/youzini-afk/varin-runtime-slim` | Slim base: Bun, Node, Git, SSH, cloudflared, and the compilers needed to install native production modules. |
| `ghcr.io/youzini-afk/varin-runtime-base` | Toolbelt base: the slim runtime plus Python, Java/Maven, Go/gopls, Rust/rust-analyzer, LSPs, GitHub CLI, ripgrep, daemonless BuildKit, and Chrome on amd64. |

All four images are built for `linux/amd64` and `linux/arm64`. Main builds receive `main`, `latest`,
and `sha-*` tags; version tags also receive semantic-version tags. Each application build consumes
the matching base manifest digest produced by the same workflow, so it cannot silently pick up a
newer floating base halfway through a build. Images include provenance and SBOM attestations.

Builds first publish uniquely named candidate manifests. CI pulls both application images by digest,
starts each amd64 container, checks `/health`, and imports the bundled broker and Pi host. Only those
verified digests are promoted to `main`, `latest`, `sha-*`, or semantic-version tags; a failed or
cancelled candidate leaves the previously verified installable tags untouched. Pull requests build
the coupled slim and toolbelt image pairs against a private runner-local registry and run the same
health and host smoke without publishing to GHCR. A manually supplied slim or toolbelt base tag is
resolved to its manifest digest before the matching application build begins.

The slim runtime is enough to run the Varin server, Git, SSH, and tunnels. The toolbelt base
preserves the maintainer fork's cloud development toolbox: Python, Java/Maven, Go/gopls,
Rust/rust-analyzer/rustfmt, GitHub CLI, ripgrep, TypeScript language tooling, daemonless rootless
BuildKit, and cloudflared. Chrome/Playwright is installed on amd64; the arm64 toolbelt image keeps
the rest of the toolbox and reports the intentional Chrome omission during the image build.

### Docker Compose

Prepare writable bind-mount directories for the image's UID/GID `1000:1000`, then start Varin:

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
export VARIN_UI_PASSWORD="$(openssl rand -base64 24)"
docker compose up -d
```

Compose pulls `ghcr.io/youzini-afk/varin-slim:latest` by default. To run the language-toolbelt
image instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

The persistent paths are:

| Host path | Container path | Purpose |
| --- | --- | --- |
| `data/varin` | `/home/varin/.config/varin` | settings, runtime registry, auth keys, clients, pairing, tunnels, and Rust kernel state/recovery roots |
| `data/ssh` | `/home/varin/.ssh` | SSH identity used by workspace Git operations |
| `data/cloudflared` | `/home/varin/.cloudflared` | managed-local Cloudflare configuration and credentials |
| `workspaces` | `/home/varin/workspaces` | user projects |

On the first runtime generation, Varin may download any missing foundational Pi packages into the
agent directory inside `data/varin`. This bootstrap is deliberately outside `/health`, so a slow or
temporarily unavailable package source does not make the Web service unhealthy. Creating the first
new session waits for the bootstrap result and exposes any per-package failure in Pi Packages;
existing sessions are not restarted. Keep the data mount persistent so user disable/removal intent
and installed package artifacts survive container replacement.

Verify both the HTTP service and bundled Pi worker:

```bash
curl --fail http://127.0.0.1:3000/health
docker compose exec varin node --input-type=module -e \
  "const broker=await import('./packages/web/node_modules/@varin/runtime-broker/dist/index.js'); console.log(broker.resolveBundledPiHostEntry())"
```

`/health` is ready only when `piRuntime.ready` is true and reports `source: "bundled"`. Published
images also expose `releaseId: image-<git-sha>`; SSH releases expose their content-addressed release
id, so a probe cannot mistake a still-running previous process with the same semantic version for
the new candidate.

### Runtime environment

| Variable | Behavior |
| --- | --- |
| `VARIN_UI_PASSWORD` | Required when the server is reachable beyond loopback |
| `VARIN_HOST` | Bind address; Compose defaults to `0.0.0.0` |
| `VARIN_DATA_DIR` | Persistent Varin data root |
| `VARIN_WORKSPACE_ROOT` | Root for mounted projects |
| `VARIN_TUNNEL_PROVIDER` | Tunnel provider, currently `cloudflare` when configured |
| `VARIN_TUNNEL_MODE` | `quick`, `managed-remote`, or `managed-local` |
| `VARIN_TUNNEL_HOSTNAME` | Hostname for managed-remote mode |
| `VARIN_TUNNEL_TOKEN` | Runtime-only Cloudflare token for managed-remote mode |
| `VARIN_TUNNEL_CONFIG` | Container path to managed-local cloudflared configuration |

Passwords and tunnel tokens are runtime values. They are never accepted as Docker build arguments or
embedded in an image.

## SSH deployment

The maintainer helper builds the same canonical cloud tree, uploads an immutable archive, verifies
its SHA-256 digest on the remote host, installs production dependencies for that host, resolves the
bundled Pi host, and only then replaces the active release.

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
`/health` for the expected Varin version and a ready bundled Pi runtime. If startup or health
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

The build fails when a private Pi workspace dependency is missing, compiled host/broker output is
absent, the production lock cannot be generated, or the installed runtime cannot resolve its bundled
Pi host.

When a runtime dependency or override changes, deliberately refresh and review the dedicated lock:

```bash
bun run update:cloud-runtime-lock
```

Normal cloud builds verify that committed lock with `--frozen-lockfile`; they never resolve a newer
transitive dependency merely because an image or SSH deployment was rebuilt later.
