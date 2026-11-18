# Extensions & Runtime Composition

Varin extensions customize the Application Host and workbench UI and contribute services (tools, model protocols, context compaction, run drivers, event sources, shells, editors) to the native Agent runtime. Built-in product shells and capabilities use the exact same contracts and registries as third-party extensions.

Authoring guide & examples: [ops/varin-extension-authoring.md](ops/varin-extension-authoring.md) · [packages/extension-sdk/README.md](../packages/extension-sdk/README.md) · [examples/extensions/README.md](../examples/extensions/README.md).

## Package Boundaries

| Package | Responsibility |
| --- | --- |
| [extension-contract](../packages/extension-contract/README.md) | Browser-safe manifest, service, contribution, routing, workbench & discovery contracts |
| [extension-host](../packages/extension-host/README.md) | Catalog, immutable artifacts, grants, namespaced storage, Host supervisor & service bindings |
| [extension-surface](../packages/extension-surface/README.md) | Framework-neutral contribution/service registries & transactional owner scopes |
| [extension-loader](../packages/extension-loader/README.md) | Authenticated asset loading, activation events & Surface realm coordination |
| [extension-sdk](../packages/extension-sdk/README.md) | Author contexts, capability clients, provider helpers & conformance harnesses |
| [extension-react](../packages/extension-react/README.md) | Optional React 19 mount adapter |
| [extension-builtins](../packages/extension-builtins/README.md) | Built-in manifests & immutable Host assets |
| [extension-cli](../packages/extension-cli/README.md) | `init`, `check`, `build`, and `test` authoring CLI |

Application Host owns extension installation and execution (embedded in Electron, shared by remote Web/mobile clients, runnable headless). Switching Hosts or shells never migrates installed extensions, grants, or storage.

## Identity, Artifacts & Trust Model

- **Distinct facts**: `installed`, `selected version`, `candidate`, `desired enablement`, `reviewed grants`, and per-realm `actual generation` are separate states. Running code always loads from verified immutable artifacts (never live checkouts; no npm lifecycle scripts executed).
- **Code trust vs capability grants**: Installing/enabling a brokered Host extension grants OS-account execution (not an OS sandbox). Varin capability grants gate Host APIs per manifest version + realm; upgrades never auto-inherit newly requested capabilities, and revocation immediately blocks new API calls on live/draining owners.
- **Execution realms**:
  - *Declarative*: Data-only contributions (no third-party code).
  - *Managed Surface*: Shared page realm with tracked mounts/subscriptions.
  - *Isolated iframe/Worker*: Message-bridged, destroyable realm (Workers are background-only).
  - *Trusted-native Surface / Host*: Shared process/realm with explicit restart/reload semantics.
  - *Brokered Host*: Supervisor-owned child process communicating over capability IPC.
- **Extension storage**: Namespaced, revisioned atomic documents (`storage.open`). `application/profile/workspace/surface/session` are organizational labels only — not multi-tenant permission boundaries. Disable retains data; remove separates uninstall from `delete-data`.

## Plugin Center & Release Delivery

- Settings → Plugins separates **Discover** and **Installed** (service routing, workbench composition, catalog sources, and diagnostics live under Advanced). Built-in extensions update with Varin releases and cannot be individually uninstalled.
- **Public catalog**: Defaults to [Varin-plugins](https://github.com/Astrmira/Varin-plugins) `catalog/v1.json` (configurable HTTPS catalogs, ETag-cached). Catalog metadata is decoupled from installed Host records — a catalog outage or delisting never breaks installed plugins or rewrites update origins.
- **Release delivery** (`ExtensionReleaseManager`): Resolves GitHub Releases, npm registry tarballs (no npm CLI required), and local `.tgz` uploads (`package/` root, symlink/traversal rejected, streaming digest check). Preview pins an immutable artifact + manifest + capability diff; confirm installs that exact preview ID (initially disabled until reviewed & enabled). Deep links (`varin://extensions/install`) open preview only — never auto-install.

## Activation, Candidate Updates & Rollout

- **Lazy activation**: Manifests are discoverable before activation; lazy entrypoints wait for real command, visibility, workspace, or service demand. Preparation resolves dependency graphs, grants, and artifacts before swapping generations atomically; failures leave the previous generation intact.
- **Draining**: Normal replacement closes new admission while letting pinned exchanges finish; explicit disable/revocation/crash cancels aggressively (still distinguishing cancel intent from confirmed stop).
- **Coordinated updates**:
  - Host data migrations write journals under `storage-publications` keyed by publication ID so crash recovery completes or rolls back consistently before activating code.
  - `manifest.updateReadiness.surfaceEntrypoints` coordinates Host + named Surface candidate readiness before committing Catalog selection.
  - **Trusted-native Host updates** cannot run two generations side-by-side; they record a restart-and-apply handoff intent in Catalog and activate on a clean Host restart.

## Service Routing & Runtime Composition

- `ServiceRoutingStore` (revisioned) maps `(service, scope)` to stable `providerKey`s (`providerId` identifies a live generation). Ordered multi-provider composition requires explicit `composition: "ordered"`.
- **Frozen Run bindings**: Rust's [CompositionRegistry](../kernel/crates/varin-runtime/src/composition.rs) binds resolved Host/Rust services per Run. Restart recovery rebuilds the exact original artifact/grant/dependency graph — never silently swapping in today's default provider.
- **Key extension service points**:
  - **Tools** ([extension-tool-owner.ts](../packages/web/application-host/lib/kernel/extension-tool-owner.ts)): Single manifest descriptor powers discovery, `disclosure` metadata, `references.inputs/outputs` short-ref mapping, `requirements` (`source`/`physical`/`live`), and `call.tools.invoke` nested calls (scoped by opaque Host token). Pre-dispatch rejections return `not_dispatched`; post-dispatch callback failures record `effect: unknown`.
  - **Model protocols (`varin.models@1`)**: Contribute channels, catalogs, OAuth (`varin.models.authentication`, pinned exact HTTPS token endpoint), and custom chat/SSE `serialize`/`parse` codecs while Rust retains HTTP/SSE, usage, secrets, and recovery.
  - **Run drivers (`varin.agent.driver@1`)**: Full custom execution loops via `provideAgentDriver` (distinct from `policy@4`; see [runtime.md](runtime.md#pluggable-run-drivers-varinagentdriver1)).
  - **Policy / Context / Budget / Compaction / Observer**: Scoped runtime hooks (`varin.context.budget@1`, `varin.context.compaction@1`, etc.). *Note: `varin.retrieval.plan@1` is deprecated and unused by native `code_retrieval`.*
- **Agent-authored extensions**: `extension_package` stages from a captured SourceView (using only in-capture deps; installs disabled; apply requires explicit reviewed candidate). Source reads serve verified UTF-8 pages from immutable artifacts only.

## Plugin Credentials & Durable Inbound Events

- **Credentials (`varin.credentials`)**: Backed by [credentials/service.ts](../packages/web/application-host/lib/credentials/service.ts) (separate from model/MCP/search stores). Scoped strictly by `(authenticated principal, extension, connectionId)` derived from the trusted Surface lease or Catalog Thread/Run — never caller-supplied JSON. SDK helpers: `credentialNamespace(call.capabilities)` and `credentials(call.capabilities, connectionId, expectedAccount?)`. Plugins implement provider OAuth via `authenticate` reusing Host `AuthorizationFlows`.
- **Durable inbound events**: Service events marked `durable` expose discoverable sources (`sourceId`, push/stream/poll, recovery coverage, filter schema; see [SDK](../packages/extension-sdk/README.md#durable-inbound-event-sources)).
  - Host runs one shared listener per `(principal, extension, source, connection, account)` independent of UI or Bot sleep.
  - Events carry `(id, revision, occurredAtMs, attributes, body/media, files[], optional state: { key, sequence, value })`. Host writes bytes to ContentStore and commits Catalog metadata before ACKing the plugin.
  - Cross-Host watches pull over authenticated managed HTTP/SSH connections using per-consumer cursors/generations and re-admit file bytes locally on the receiving Host.
