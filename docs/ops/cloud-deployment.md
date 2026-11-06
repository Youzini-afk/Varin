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

The Docker workflow builds four manifests and publishes explicit variant names plus compatible aliases to GHCR:

| Image | Role |
| --- | --- |
| `ghcr.io/youzini-afk/varin-slim` | Application on the slim runtime. Compose default. |
| `ghcr.io/youzini-afk/varin-toolbelt` | Application on the language-toolbelt runtime. `varin` remains a compatibility name for the same tested digest. |
| `ghcr.io/youzini-afk/varin-runtime-slim` | Slim base: Bun, Node, Git, SSH, cloudflared, and the compilers needed to install native production modules. |
| `ghcr.io/youzini-afk/varin-runtime-toolbelt` | Toolbelt base (`varin-runtime-base` remains a compatibility name): the slim runtime plus Python, Java/Maven, Go/gopls, Rust/rust-analyzer, LSPs, GitHub CLI, ripgrep, daemonless BuildKit, and Chrome on amd64. |

Both application and both runtime variants are built for `linux/amd64` and `linux/arm64` **at release time**, not on every
main push. `Docker Images` accepts `v<package version>` tag pushes, or a manual run whose selected
workflow ref is that release tag; branch/manual-main runs cannot publish. Stable releases receive
exact version, major/minor, major, `latest`, and full `sha-*` tags. Prereleases receive only their
exact version and SHA tags. No workflow updates a `main` image alias. Local Dockerfile/Compose builds default to the released
`varin-runtime-*:latest` base; set `VARIN_RUNTIME_BASE_IMAGE` to a version/digest for reproducible local builds.

The explicit `*-toolbelt` names are added by the next qualified release; no historical tag is rewritten.
`varin:latest` and versioned `varin` tags remain toolbelt. Compose continues to select `varin-slim`;
changing the unqualified image default requires a separately announced future version boundary.
Until a release containing these aliases is published, use `VARIN_IMAGE=ghcr.io/youzini-afk/varin:<version>`
and `VARIN_RUNTIME_BASE_IMAGE=ghcr.io/youzini-afk/varin-runtime-base:<version>` with the toolbelt overlay.

Images carry `io.varin.image.variant`, `io.varin.image.role`, `VARIN_IMAGE_VARIANT`, and
`/etc/varin/image-capabilities.json`. This metadata describes installed software, not permissions or
a guarantee of a working Varin Browser/Computer owner. Slim still includes Python and native-module
build prerequisites; it is not a tool-free sandbox. Toolbelt reports Chrome only on amd64.

Before any GHCR candidate write, the workflow accepts the exact tag/SHA/version and runs full source,
Rust/native and platform qualification for that SHA. Each application consumes the matching base
manifest digest from this release (or an explicitly supplied immutable-resolved override), so it
cannot silently pick up a newer floating base. Images retain provenance and SBOM attestations.

Uniquely named candidates are pulled by digest; both amd64 applications must start, pass `/health`
and native Host closure checks before those same digests are promoted. The exact running candidate
also validates installed-variant metadata and receives a real SIGTERM: a graceful receipt and foreground
exit 143 are required within the 15-second smoke supervision window; incomplete/forced exits fail qualification. Promotion rechecks the tag
and serializes public alias changes across releases without canceling in-progress publication.
The alias set is not a cross-image atomic transaction; a manual interruption or registry failure
requires completing/retrying that accepted release. Arm64 native dependencies/kernel are checked
during image assembly; this is not a full arm64 server-startup qualification.

PR/main validation is separate and read-only. CI invokes `container-check.yml` only for applicable
container inputs, including kernel, build graph and runtime dependency changes. A private runner-local
registry and one shared Buildx builder validate slim, plus toolbelt for shared/base changes; common
application stages are reused within that runner. Ordinary renderer changes do not rebuild images.
Full qualification validates both variants. No validation job can publish to GHCR.

The slim runtime is enough to run the Varin server, Git, SSH, and tunnels. The toolbelt base
adds a cloud development toolbox: Python, Java/Maven, Go/gopls,
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
