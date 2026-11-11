# @varin/web

Varin's browser, remote, and trusted server runtime.

This package serves the shared Varin UI and owns the trusted Application Host. Native Thread routes
use `@varin/application-client` and `@varin/protocol`; the packaged Rust `varin-kernel` contains the
Agent Catalog and execution runtime. The Host supplies models, credentials, extensions and domain
services without owning another conversation store or execution loop.

The Application Host, shared packages, UI and manifest-verified Rust kernel are one release unit.
Publishing only the browser bundle is not a supported deployment. The canonical cloud builder stages
`packages/web/kernel` and runs release smoke against the assembled runtime.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run dev:web:full
```

Both root development launchers prepare shared package exports before starting consumers, reusing
the build cache. `bun run dev` starts the HMR UI and API; `dev:web:full` waits for the first successful
frontend build before starting the API. Preparation failure or cancellation does not start either.
The Vite proxy preserves browser Host/Origin and upstream forwarding headers for HTTP and WebSockets.
For TLS-terminating Nginx/NPM setup, see [development proxy configuration](../../docs/development.md#开发模式反向代理).

Or build and start the production-like server:

```bash
node scripts/build-cloud-runtime.mjs --install --no-archive
node artifacts/cloud-runtime/packages/web/bin/cli.js serve --foreground
```

The canonical cloud builder compiles the Application Host, shared packages and Web UI, stages the
Rust executable, and creates the production dependency layout and lockfile.

## Model references and invocation evidence

The Application Host adapts declared resource fields through the native Catalog's private
`runtime.model_reference.*` methods. It does not maintain a TypeScript alias registry.
Original `HostToolCall.arguments` remain the accepted evidence; typed resolution is frozen
before permissions/effects and carried separately in `resolvedArguments`. Domain adapters
verify those exact resolved arguments without rewriting the original invocation.

Owner-authored `OutputBody.model_data` is model presentation only. Original `data`, attachment
parts and navigation keys stay available to UI and recovery. Settings revisions, file read
versions and browser/Computer observations retain their original consistency evidence.
Observed file references reach the attachment owner for conditional capture before Office,
material ingestion or browser upload; replay retains the original captured bytes. Extension
reference metadata selects explicit positions and never scans opaque third-party payloads.

Structured conversation export (JSON version 2) retains original data and attachment descriptors
alongside the recorded model projection. Its `modelReferences` snapshot carries the original
reference space, owner targets and invocation bindings for exactly the emitted history cut.
Hidden tool records and unrelated references held by the same Run do not enter that snapshot.
This is archival association metadata, not an importer or a new authority to access those targets.

## Type and test boundaries

`bun run --cwd packages/web type-check` prepares shared runtime dependencies and emits/checks the
Application Host declarations, then runs `type-check:prepared`: private protocol generation check,
Host test types, browser types and CLI source/test types. Named test helpers (`*.test-helper.ts`) and
fixtures (`*.fixture.ts`) stay out of production Host output. The declaration-cache config includes
their signatures for cross-layer tests; the test config checks their source. Old cache files are removed
in place before emission so excluded or deleted modules cannot survive through stale declarations.
Host bodies use
their Node compiler settings; browser code retains its DOM settings. The existing `#application-host`
imports let cross-layer tests use those generated signatures without recompiling the Host as browser
code. Native Vitest resolves those same imports to the original Host source, so it does not substitute
declarations or a mock implementation at runtime. `*.native.test.ts` still runs only through the
[dedicated kernel acceptance entry](../../docs/development.md).

The root aggregate prepares the same shared outputs and Host declarations once, then uses
`type-check:prepared` for Web's remaining checks. That entry requires fresh dependencies and declarations.
For this package, `build` and `build:raw` both call `scripts/build-products.mjs web --publish`.
They prepare or verify reusable shared outputs, Host, kernel, CLI and browser artifacts, then publish
the completed product directories. The `:raw` name does not bypass dependencies or native build here;
use `build` or `type-check` as the ordinary package entry.

The ordered extension-routing consumer check uses real settings controls, the original Web client,
the authenticated Express Router and extension-routing file CAS, without a listener or kernel process.
After preparing the shared dependencies, run it from the repository root:

```bash
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts packages/web/src/api/extensions-routing-consumer.test.ts --maxWorkers=1
```

It covers reordering, missing members, Host/client reload, stale revision rejection, explicit empty
selection versus automatic routing, and the existing single-provider and workspace rules.

## Generated blocks in the HTML entry points

`index.html` and `mini-chat.html` paint the splash before any module is evaluated, so they cannot
import the modules that define it. They embed generated output instead, between `SPLASH-CSS`,
`SPLASH-MARK`, and `SPLASH-JS` sentinels. After changing anything in
`packages/ui/src/components/ui/varin-splash-*.ts`:

```bash
bun run splash:emit
```

Commit the generated HTML changes with the generator changes. Splash tests cover projection and
playback behavior; they do not freeze the generated CSS/HTML or the renderer's source text.

## Cloud and remote deployment

Use the Varin container images, Docker Compose, or the atomic SSH deployment helper. Image names,
persistent paths, environment variables, remote configuration, health validation, and rollback
behavior are documented in [Cloud deployment](../../docs/ops/cloud-deployment.md).

## Runtime data

Set `VARIN_DATA_DIR` to choose the persistent data root. The Linux default is
`~/.config/varin`. It contains settings, native Catalog/content data, authentication keys, remote
clients, pairing state, notifications, tunnel state, workspace identity, and document recovery
journals; it must remain outside immutable release directories.

Outbound HTTP(S) connections can reach the executing Host's localhost, LAN and Docker network,
including model gateways such as `http://magpie:3425/v1`. No private-network toggle is required.
The Host's proxy and `NO_PROXY` settings still determine routing; explicit web-domain rules still apply.
Workbench browser previews and screenshot resources also accept explicitly selected intranet targets;
preview registration and forwarding retain their existing session and target-token checks.

Binding beyond loopback requires `VARIN_UI_PASSWORD`. Tunnel tokens and passwords are runtime-only
configuration and must not be placed in package archives or build arguments.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Incorporated permissive
material retains the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Stop and admission contract

`stop()` synchronously withdraws readiness and fences new HTTP writes, native execution admissions
(including requests still waiting for a transport credit) and terminal input. `/health` returns 503
with `ready: false` while draining. `/live` remains a lightweight HTTP liveness check,
without waiting for identity storage or kernel readiness. Known read/observation and cancellation/release routes stay
available while their original owners drain. New effectful WebSocket upgrades are fenced at each
owner and rechecked after authentication waits. Effect-capable generic peer, preview and service-forward
bridges close on drain rather than forwarding new bytes. The realtime observation bridge retains
original pull/cancel and approved reads, but refuses new provider-acquiring Surface leases. Closing
a bridge is not an executor-stop receipt and does not release the remote execution owner. Unknown commands and side-effecting GET login/key
routes are refused. This fence does not roll back requests already inside their original owners.
Direct HTTP observation streams remain open during owner drain and end at the final transport
teardown, so an idle SSE observer cannot prevent an otherwise completed stop.

`VARIN_SHUTDOWN_TIMEOUT_MS` is one process-wide stop budget (default 10000 milliseconds, positive
integer up to 2147483647). Every Host stop phase, native kernel drain and final HTTP close consumes
that same monotonic deadline. Configure the container/service supervisor's grace period above this
budget. A failed or unresponsive owner ends the graceful sequence with `shutdown-incomplete`; it
does not license closing dependent databases, dropping native workspace writers, replaying an
unknown effect, or reporting that cancellation completed. An embedding caller receives the failure
and retains responsibility for terminating the process. The foreground CLI exits 1 on incomplete
stop; a successful SIGTERM stop keeps its existing exit code 143.

`[Shutdown]` JSON records report `outcome`, fixed `owner`/`reason`, `elapsedMs` and configured
`deadlineMs`, without request content or owner identities. This budget is a stop deadline, not a
queue TTL, model execution limit or observation timeout. Caller cancellation of a queued request
remains distinct from an admitted effect's original completion. No universal model-stream deadline
or comprehensive queue/execution/observation budget has been introduced. Individual owners retain
their existing cancellation and actual-exit contracts; deadline expiry is a crash-recovery path,
not proof of a clean checkpoint. The supervisor must also bound a stalled JavaScript event loop.


### Plugin credentials

The Host's model-neutral credential lifecycle lives in `application-host/lib/credentials/service.ts`;
the model adapter keeps channel, endpoint/header and Run semantics. `extensions/credentials.ts`
registers `varin.credentials`, using trusted Surface/Run principal attribution and existing
`AuthorizationFlows`. Plugin secrets are stored separately from connection settings and existing model
credentials. The plugin handles provider-specific OAuth and remote revocation, while Host storage
handles scoped references, concurrent refresh and stale-write protection. No provider-specific business
state or public account service is introduced. Existing password/passkey/pairing entrypoints retain
a durable Host-owner subject; this does not add multi-user enrollment.
