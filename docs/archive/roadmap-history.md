# Delivery roadmap — 历史阶段明细（自 roadmap.md 迁入）

Status: historical record — archived 2026-09-27。已完成/被取代阶段的逐段叙述保留于此，不再更新；
当前阶段状态见 [roadmap.md](../roadmap.md) 的 Phase status 表，能力证据见
[agent-harness-status.md](../agent-harness-status.md)。

---

## Stage Q — Testing and CI redesign (implemented, D-292/D-293)

1. Map the maintained test families and actual runner/build entrypoints across every package, kernel,
   and delivery script; use existing CI evidence to find concentrated cost and unreliable coverage.
2. Remove obsolete implementation constraints, merge redundant scenarios, and replace misleading
   assertions or fixtures while retaining the relevant behavior at its owning layer.
3. Make discovery portable, eliminate duplicate execution/build work, and assign source, platform,
   and release checks to their actual responsibility; report the underlying failure rather than only a wrapper error.
4. Verify the resulting scope and feedback cost, update current evidence references, and close Q before
   the D-296 retirement and AI4S implementation slices. No fixed deletion ratio, coverage quota, test count,
   or retry-until-green policy.

Delivered per [testing-ci-audit.md](testing-ci-audit.md): single-owner kernel/i18n/Electron
suites, quoted-glob discovery, retargeted recovery evidence on the production journal engine,
artifact-driven CI with docs-only gating, and the cloud daemon boot failure fixed at its product
root cause (a production dependency declaration). The former VS Code companion is outside the
formal product surface under D-294/D-295. D-296 has retired its remaining package, entrypoints,
contracts, and current documentation before AI4S begins; root build and built-server knowledge smoke
are locally verified.

## D-296 — Former VS Code companion retirement

The retirement stage removes the companion package and every current development, build, packaging,
installation, marketplace, and companion-only contract entrypoint. It keeps references that describe
LSP packages, TextMate formats, external editor launching, or provenance, and leaves historical
changelog and decision bodies intact. The documentation, implementation, root build, and built-server
knowledge smoke are complete and locally verified. Packaged, cross-platform, and remote-CI checks are
not inferred from this result. No compatibility archive is planned, and AI4S follows.

## Phase 0 — Foundation (complete)

- Architecture, security, and contribution contracts.
- npm workspaces and TypeScript quality baseline.
- Versioned, bounded JSONL host protocol and tests.
- Windows and Linux CI for the platform-neutral packages.

Acceptance: clean install; formatting, typecheck, tests, and build pass; protocol rejects malformed
or oversized frames.

## Phase 1 — Pi host (complete)

- Runtime discovery for bundled/system/source/custom Pi.
- Direct SDK worker lifecycle and handshake.
- Sessions, prompt/steer/follow-up/abort, snapshots, and event streaming.
- Model/auth, settings, package, and command operations.
- Generic extension UI bridge.
- Smoke load against the maintained local extensions.

Acceptance: a headless integration test creates or opens a disposable session, completes a prompt
with a fake provider, exercises extension UI, and shuts down without a child process leak.

## Phase 2 — Desktop integration prototype (complete, superseded)

- Secure Electron main/preload boundary.
- React shell, onboarding, projects, session list, chat timeline, composer, and tool cards.
- Provider/model and Pi settings.
- Package/extension manager and diagnostics.
- Worker crash/restart and reconnect behavior.

Acceptance: the prototype proved the broker/preload/session path before its temporary shell was
removed in favor of the imported OpenChamber product base. Its protocol and host work continue in
the maintained packages rather than a parallel desktop application. The prototype's process and
security boundary is recorded in [phase-2-desktop.md](phase-2-desktop.md); read it as provenance for
the retained Electron boundary, not as the current desktop specification.

## Phase 3 — Recovery semantics prototype (superseded)

- The prototype validated conversation-only, files-only, combined restore, checkpoint, undo/redo,
  transaction, and crash-safety semantics.
- Its complete-workspace and shadow-Git implementation was removed rather than kept as a second
  recovery authority. Production recovery now uses the selected `varin.workspace-recovery@5`
  Host service and its affected-file journal; optional Pi recovery packages retain only their own
  independent commands, configuration, and history.

Acceptance: the prototype evidence informed the retained UX and safety contract; production
acceptance is owned by [native-workspace-recovery-design.md](../native-workspace-recovery-design.md).

## Phase 4 — OpenChamber fork product base (complete)

- Import the clean `Youzini-afk/openchamber` fork snapshot into Varin with provenance and MIT
  attribution; keep every source fork worktree read-only.
- Preserve custom providers, remote/cloud access, workspace security, archive restore, delayed child
  sessions, session UX, Electron/web/mobile/VS Code surfaces, and reviewed fork customizations.
- Adopt the mature build and product shell without copying tracked secrets, obsolete release
  identities, or OpenCode branding into Varin artifacts.
- Keep the connected Capacitor iOS/Android implementation and remove the unused parallel Expo/React
  Native tree and dependencies.

Acceptance: the imported product shell builds in Varin and fork-specific regression coverage is
retained before engine surgery begins.

## Phase 5 — Direct Pi-native engine migration (complete)

This phase replaced the imported OpenCode engine with Varin-owned Pi contracts. The architectural
result is specified in [architecture.md](../architecture.md); the source and non-regression contract is
[openchamber-pi-migration.md](../openchamber-pi-migration.md). The entries below are the delivery
record, kept at full detail because each one names an ownership decision that is still binding.

- Implemented foundation: reusable Pi protocol client, browser-safe surface client, and
  catalog/per-session worker broker; Electron owns its handshake, packaged entry verification,
  and bounded shutdown lifecycle. The authenticated WebSocket gateway now shares that broker with
  web/desktop/mobile, validates every public method, routes per-worker event sequences, and works
  through the existing encrypted relay allowlist. Protocol v1 now projects Pi session trees,
  messages, stream deltas, models, and provider-owned auth prompts/events into stable Varin DTOs;
  SDK callbacks, signatures, and credentials remain worker-private. Pi-native user/project/operator
  provider configuration, scoped deletion, credential provenance, and credential-safe model discovery
  are implemented behind the same runtime boundary.
- Implemented native session contract: complete branch/all entry reads, tree/header/entry/summary/stats,
  real runtime/queue state, model thinking selection, native rename, atomic archive/restore metadata,
  and safe deletion. Product-level queue, transport-frame, gateway concurrency, and discovery ceilings
  are absent by default; deployment budgets are opt-in.
- Implemented unrestricted scoped plugin settings, extension-owned JSON/JSONC configuration
  documents, and Pi custom-component snapshots. Pi-native conversation rollback preserves
  text/images. Combined rollback, checkpoints, undo/redo, retention, and crash reconciliation now
  use the selected `varin.workspace-recovery@5` Host service and affected-file journal. The
  full-workspace shadow-Git prototype and the interim plugin-delegated recovery bridge are not in the
  production authority path; `pi-workspace-history` and `pi-wtf` remain optional independent Pi packages.
- Implemented Pi-native desktop first-launch and local recovery readiness. Both negotiate the real
  runtime WebSocket handshake and show Pi/host/Node/source versions; the former OpenCode installer,
  binary-path picker, and `/health` polling are removed while remote connection selection remains.
- Implemented the Pi-native main header session path: title, working directory, runtime activity,
  context statistics, rename, full-history Markdown export, subtree archive, and subtree deletion
  now use Pi protocol/store data. The old sync cache, OpenCode message exporter, session worktree
  attachment, share actions, and legacy mini-chat launch path are no longer loaded by the header.
- Implemented Pi-native root launch and desktop navigation: URL/deep-link parsing, native
  open/new-session events, previous/next navigation, keyboard/menu/command-palette actions,
  global catalog bootstrap, and native tray projection now use Pi summaries, snapshots, and session operations.
  Worktree actions create the Git worktree first and then a Pi session in its directory; failures
  roll back a newly-created worktree when session creation cannot complete. The tray keeps the
  platform IPC contract but no longer polls OpenCode or imposes an arbitrary session-count cap;
  native menu/tray actions no longer route Pi session IDs into the legacy mini-chat renderer.
- Implemented Pi-native root effects and interaction controls: PWA shortcuts and retention now
  consume the global Pi catalog, the window title follows the active Pi working directory, and
  Escape abort, runtime status, model favorites, thinking levels, timeline focus, expanded input,
  attachments, and dictation all target the active Pi session. The orphaned OpenCode
  session-retention hook and stale sync documentation were removed after the Pi-native retention
  hook became the sole production implementation.
- Implemented the Pi-native main application root: context panels, plans, project notes/todos,
  inline comments, drafts, archive management, project actions, worktree management, and command
  discovery no longer require the OpenCode SyncProvider. No production application root mounts that
  provider. Pi commands are discovered from live sessions or an in-memory
  workspace catalog, so extension, prompt-template, skill, and recovery-plugin updates appear
  without Varin-owned copies.
- Implemented: terminal selections, pull-request comments/check failures, merge conflicts, and
  worktree-integration conflicts now seed the active Pi composer or create a Pi session in the
  required directory. Visible text and hidden instructions travel through Pi's native prompt
  contract; the old global new-session draft, synthetic OpenCode parts, and externally-viewed sync
  marker are no longer loaded by terminal, Git, pull-request, or context-panel surfaces. Git
  worktree bootstrap status is tracked by path instead of mutating the legacy session UI store.
- Implemented: VS Code active-editor suggestions now target the Pi composer instead of writing to
  the detached OpenCode input store. Accepted selections preserve relative path and line range in
  session-scoped Pi context; whole files become explicit readable path context. Pi session events
  now drive one completion/error attention state shared by background-session indicators, session
  switchers, and mobile widget snapshots, and opening a session clears that state.
- Implemented a coherent Varin product identity across the Windows installer, Electron AUMID,
  native/PWA titles, updater feed, `varin://` deep links, `varin-ui://` packaged origin,
  authentication device labels, translations, and generated icon assets. The retained cube motif
  now carries Varin's own π mark rather than the upstream OpenCode mark.
- Implemented Pi-native scheduled execution end to end: the scheduler creates a Pi session,
  selects its Pi provider/model/thinking level, and dispatches either a Pi extension command or
  agent prompt. The editor and run-now navigation use the same Pi catalog/session contract; legacy
  OpenCode agent variants, permission policy, goal token ceiling, and session IDs were removed.
- Implemented: all four production UI roots now use Varin protocol DTOs without importing the
  OpenCode SDK. The unreachable SDK client, complete sync/optimistic state graph, old chat composer,
  turn projector, session sidebar, compiled test remnants, Vite aliases, dependency entries, and
  lockfile package were removed together. Pi Skills autocomplete was reattached to the live Pi
  command/resource catalog rather than discarded with the old composer.
- Implemented: sync, lifecycle, provider, scheduling, control, and notification flows now use the
  Pi host/broker contracts. The OpenCode child lifecycle, proxy, watcher, downloaded CLI, provider
  persistence, and obsolete UI code are no longer part of the production graph.
- Implemented: cloud delivery now builds one canonical production workspace containing Web,
  protocol, runtime broker, and the bundled Pi host. The application image installs native
  dependencies on its target architecture and runs on a Varin-owned multi-architecture runtime
  base with the fork's complete development toolbelt, plus a slim runtime without language
  toolchains. CI publishes digest-linked slim and toolbelt base/application images and performs a
  real bundled-host health smoke on both. Compose defaults to the slim image and uses Varin-owned
  paths and state.
  SSH deployment verifies a content-addressed archive, installs into an immutable release, switches
  `current` atomically, waits for a ready bundled Pi runtime, and automatically restores the last
  healthy release on failure. No cloud path installs, configures, or probes an OpenCode runtime.
- Implemented: About now reads the server's real `varinVersion`, links to the Varin repository,
  and no longer probes or displays a nonexistent OpenCode upgrade endpoint. The unreachable
  OpenCode upgrade toast, its persisted preferences, and its Web settings API shim were removed;
  Varin application updates and the independent PWA install prompt remain intact.
- Implemented: managed Git worktrees now live below Varin's own data directory and use the
  canonical Varin path-based project ID plus `varin/<name>` default branches. Worktree setup
  no longer writes `.git/opencode`, OpenCode project JSON, or `opencode.db`; Git itself is the
  authoritative registry and the Varin UI passes the configured setup command explicitly.
- Implemented: both reachable file trees now use the required cross-runtime `FilesAPI` directly;
  the unreachable OpenCode directory-list fallback and the server's `.opencode/plans` missing-path
  exception were removed. Web list mapping and the server directory-list contract are tested.
- Implemented: project onboarding and directory selection now use Varin runtime capabilities end
  to end. `FilesAPI` resolves the active host home, lists directories, and explicitly creates new
  project directories outside the current workspace; `GitAPI` clones with the selected identity on
  Web/Electron/mobile and VS Code. The reachable directory dialog no longer calls `opencodeClient`
  or assembles private filesystem routes.
- Implemented: About, the desktop Help menu, and the runtime-status shortcut now open one production
  Varin diagnostics surface. It reports the negotiated Pi handshake, `/health`, package/resource/
  agent-provider diagnostics, fleet/recovery availability, and project/session state without reading
  OpenCode SDK endpoints or copying provider settings, package source URLs, message bodies, or fleet
  goals. The old invisible OpenCode status dialog and `window.__opencodeDebug` entry point were removed.
- Preserve local/remote authentication, workspace containment, audit, reconnect, materialization,
  queue, parent/child session, revert, fork, and archive behavior.

Acceptance: the OpenChamber-derived product runs its complete chat/session/provider journey on Pi
without starting or bundling OpenCode and without a permanent OpenCode compatibility facade.

## Phase 6 — Recovery UX and ecosystem integrations (complete)

This phase built the recovery interaction model and the first-class plugin adapters without forking
any plugin. Current native-ownership and adapter boundaries live in
[plugin-gui-design.md](../plugin-gui-design.md), [architecture.md](../architecture.md), and
[extension-compatibility.md](../extension-compatibility.md).

- Implemented: persist the conversation-only, conversation+files, or always-ask policy across
  application settings. Optional `pi-workspace-history` and `pi-wtf` packages remain manageable
  through Pi's native package operations without being installed, invoked, or reported as Varin's
  recovery authority.
- Implemented: replace the imported OpenCode plugin registry/file editor with a single Pi-native
  package manager. It lists configured sources, updates one or all packages, removes packages, and
  passes arbitrary npm, Git, local-path, or future Pi sources directly to `PackageManager`. The
  recommended integration cards are convenience entries, not an allowlist.
- Implemented: provision only the packages that remain application foundations, such as the
  maintained MCP adapter and permission system. Recovery packages are ordinary optional Pi packages;
  startup never repairs, reinstalls, or activates them on behalf of native recovery.
- Implemented: connect timeline recovery to the selected policy with Pi entry IDs. Conversation
  navigation remains Pi-native; combined file recovery uses affected-path checkpoints from
  `varin.builtin.recovery`, with cross-surface dirty-buffer fencing, operation-level workspace
  leases, confirmed-conflict fingerprints, crash compensation, and configurable retention.
- Implemented: put native recovery status, checkpoint/history storage, retention, undo/redo, and
  attention-required operations in the right sidebar/settings while retaining the Pi timeline's
  normal rollback and branch UX. `pi-wtf` prompt-repair commands and any
  `pi-workspace-history` history stay independent of this path.

- Implemented: native package installation/update and unrestricted configuration documents for
  `pi-subagents` and Magic Context. Subagent tree controls and Magic Context memory/session
  diagnostics remain dependent on their public event/data contracts.
- Implemented: the first-class `pi-subagents` settings surface now edits scoped defaults and model
  policy (including default provider, thinking ceiling, strict and per-agent scopes), the current
  Watchdog review/LSP schema, Fleet and async behavior, delegation limits,
  sessions/artifacts/worktrees, Intercom, scheduled runs, completion/control notifications, and
  turn/tool/usage budgets in the plugin's native documents. Unknown keys remain intact and the raw
  documents remain authoritative. Per-agent overrides now use the live provider catalog's runtime
  names while still accepting arbitrary future/package names; all current scalar/list/clear
  sentinels, output defaults, pre-read files, provider overrides and per-agent tool budgets are
  structured, and custom/package frontmatter precedence is
  explained rather than flattened into the generic Agents page. Fields owned by Agent Markdown or
  individual runs are diagnosed at their invalid override path, while unknown future keys remain
  round-trippable. Current notification channels/events and proactive skill delegation are also
  covered.
- Implemented: the first-class Magic Context settings surface now follows the current Pi Zod loader
  rather than the retired OpenCode-era page. Separate user/project drafts, six focused capability
  areas, project security filtering, Pi-only runtime controls, context/compression budgets, memory
  and Git indexing, embedding/SQLite/Synapse, internal-agent tuning, and all current Dreamer tasks
  write the canonical CortexKit JSONC files without losing comments or unknown fields. Polymorphic
  per-model maps remain explicitly visible and editable through the authoritative Advanced document.
- Implemented: Magic Context session operations now discover and invoke its current registered
  `ctx-*` commands in a live session. Status stays in the plugin-owned dialog; flush, embedding
  status/start/pause, Sidekick augmentation, wrap-up, full/ranged recompression, session upgrade,
  and selected Dreamer tasks preserve provider validation and confirmations. The newest public
  `ctx-status` branch entry is rendered in settings without reading SQLite, and augmentation is
  presented truthfully as a new user turn. The runtime UI separates Context health, session
  maintenance, Sidekick augmentation, and long-running Dreamer/embedding work.
- Implemented: first-class plugin cards now report package configuration/presence separately from
  current-session observations. Subagents and Magic Context use agent-provider availability,
  Web Access uses its registered command, recovery plugins use recovery-provider status, and MCP
  uses its public status channel. Transport failures, no active session, unavailable providers,
  and successful-but-absent observations remain distinct; no generic loaded or reload-needed state
  is fabricated where Pi exposes no such contract.
- Implemented: Agents executes every action advertised by the `pi-subagents` provider instead of
  rendering inert badges. Provider-level creation and model-resolution actions, structured agent
  editors, scope selection, inspect/update/eject/enable/disable/reset/delete, focused
  destructive confirmation, project-trust gating, result reporting, and catalog refresh all route
  through the plugin-owned management tool. Durable workflow definitions were removed with
  `pi-subagents` 0.55; `workflowScript` and `/prompt-workflow` remain plugin-owned execution flows.
- Implemented: Fleet is a provider-neutral live-work surface. `pi-subagents` still uses public
  `subagents:rpc:v1` `fleetStatus` v1 for delegated agents. `pi-background-tasks@2.4.2` uses EventBus
  v1 for background agents and shell tasks, including advertised `run`, bounded `logs`, and `kill`.
  Composite identity is `providerId + key`. One degraded provider does not hide another. The public
  DTO carries kind, state, name, optional description/tokens/bytes, and advertised actions only;
  private paths, PIDs, and plugin kill messages never cross to the renderer. The plugin-owned
  inspector, stop selector, and doctor stay command-backed for subagents.
- Implemented: Hermes Memory settings edit only the Host-resolved agent-root
  `hermes-memory-config.json`. `projectsMemoryDir` accepts a one-level relative name or an absolute
  child of that agent directory. Runtime availability is `memory-insights` command presence only.
- Implemented: `pi-rtk-optimizer@0.9.0` is recommended and adapted through its one strict-JSON
  agent-root authority after its entry point and exact `rtk` command registration were verified on
  Varin's bundled Pi at the time (`0.84.1`). Its upstream peer declaration still stops at Pi 0.80,
  but Varin does not maintain a fork or old-Pi compatibility layer. Command presence proves
  extension loading only, not availability of the external RTK binary.
- Implemented: Agents, Commands, Prompts, Skills, Pi Packages, and Plugin Settings now observe one
  ownership model. Agents exposes provider-owned source/package/invocation facts without inventing
  a universal override schema; Commands is a read-only live catalog with native source provenance;
  Prompts shows its filename-derived slash invocation and `argument-hint`; package rows distinguish
  configured sources from missing local installations, expose resolved/structured-entry state, explain Pi's
  cross-scope update semantics, and route configuration to the matching specialized or Advanced
  plugin surface.
- Implemented: retire the unreachable OpenCode-era Magic Context, OpenAgent, and Agent
  Orchestration pages after recording their capability disposition. Their private `/api/*`
  stores, stale schema normalizers, layout assertions, and dedicated translations are removed;
  Pi-native provider catalogs, plugin adapters, resource pages, and still-live chat dependencies
  remain intact.
- Implemented: remove the unreachable OpenCode agent CRUD sidebar and generic permission-map
  editor. Pi provider actions and plugin-native configuration remain authoritative for agent
  definitions, model policy, and permissions.
- Implemented: Pi-native `pi-mcp-adapter` package management, public `status/v1` runtime snapshots,
  reconnect/auth/logout/enable/disable command orchestration, and the plugin-owned read-only
  `configCatalog/v1` effective server projection. MCP settings appear only for an installed adapter;
  the split page lists each effective server once on the left and edits an explicit revisioned native
  source on the right. Varin never merges adapter sources in the renderer, and the catalog excludes
  arguments, environment, headers, tokens, OAuth, and URL credential material. Desktop header and
  mobile controls consume the same public status/command path; the old OpenCode MCP stores, draft
  editor, and OAuth callback route are removed. Each native source keeps a structured,
  comment-preserving editor plus its complete raw JSON/JSONC draft. Partial overrides stay valid,
  transport changes remove obsolete fields, and URL changes clear local URL-bound credentials rather
  than carrying them to another endpoint. Tools/resources/results already use the generic Pi tool
  projection; richer MCP Apps rendering remains dependent on an explicit public webview contract.
- Implemented: the first-class `pi-web-access` adapter now edits its native `web-search.json`
  through focused routing, provider/credential, Curator/browser, content, and security areas. It
  models the plugin's current single/concurrent/all/ordered-fallback semantics, every documented
  credential source and provider endpoint, public tool names, remote bind risks, Chromium-cookie
  opt-in, GitHub/video/PDF behavior, domain policy, and SSRF exceptions without dropping unknown
  fields. Custom Pi agent directories are propagated through `PI_CODING_AGENT_DIR`, keeping the
  GUI and extension on the same file. The live-session panel now discovers the registered command
  catalog, opens the native Search Curator with optional initial queries, invokes Gemini Web account
  diagnostics, opens the plugin-owned stored-result selector, and invokes the public
  `/curator on|off|summary-review` modes while leaving persistence and immediate effects with the
  plugin. Search/fetch tools, widgets, dialogs, and custom entries use the generic extension
  projection; provider health and activity still require a public versioned contract from the
  extension.

Acceptance: each adapter has an unavailable/degraded state, version compatibility diagnostics, and
an integration smoke test without exposing credentials.

## Phase 7 — Windows release (complete)

Windows x64 and ARM64 ship as required release assets from matching native runners. Desktop runtime
discovery, install planning, the installer graph, and the packaging smoke path are done. Packaging
commands and signing live in [packages/electron/README.md](../../packages/electron/README.md).

- Implemented: Electron's Node mode hosts the compiled Varin Host bootstrap and broker; running the
  desktop shell requires no separate Node download. Windows product/installer identity and GitHub
  updater metadata target `Youzini-afk/Varin`.
- Implemented: desktop starts without forcing a Pi warmup. The Runtime Manager discovers user-global,
  standalone, source, and explicit custom Pi installations; probes the real package root and Host
  handshake; and activates a successful selection without restarting Varin. Existing sessions stay
  on their owning generation while new work moves to the selected generation.
- Implemented: installation planning prefers the package manager that owns an existing Pi, otherwise
  detected npm/Bun/pnpm, and otherwise a verified standalone payload when the distribution supplies
  one. Newer Pi versions are kept; only missing or older versions expose install/upgrade actions.
- Implemented: the Windows x64 pipeline produces an unsigned NSIS installer, blockmap, and
  `latest.yml`. Packaging verifies the manifest-bound Rust kernel, target TriviumDB and sherpa binaries,
  rejects the retired `better-sqlite3`/`node-pty`/`bun-pty` authority packages, and performs a clean-profile
  unpacked-app smoke including Host health, recovery, native semantic/structure, renderer app-ready state,
  and terminal create/close.
- Implemented: the ordinary installer graph carries no Pi SDK package. `build.files` ships only the
  bundled main process and preload, so the SDK is never a packaged payload; the Host resolves the
  selected package root at runtime. `afterPack` proves this by driving a real Runtime Manager probe
  and live external Host handshake against an out-of-tree package root before the build is accepted.
- Implemented: the release workflow packages Windows ARM64 on the native `windows-11-arm` runner and
  publishes `latest-arm64.yml` beside its architecture-specific installer and blockmap, keeping the
  x64 and ARM64 updater channels separate.
- Signing is supported but unused by public releases. `package.mjs` accepts `CSC_LINK`/`WIN_CSC_LINK`
  (and maps the legacy `WINDOWS_CSC_*` names) and otherwise falls back to an unsigned NSIS installer.
  Producing signed artifacts is a credential decision, not outstanding engineering.
- Not delivered: the optional offline distribution with a verified standalone payload. Runtime
  installation and standalone-runtime selection exist in the broker, but no pipeline produces that
  payload and no release asset carries it.

Acceptance: met for install on a clean Windows user profile and the Phase 5–6 smoke journey, which
run in CI on every release. Update-in-place, crash recovery, and uninstall data retention are
verified manually; they have no automated release gate.

## Phase 8 — OpenChamber upstream capability absorption (complete)

The reviewed fork/upstream reconciliation and capability-by-capability disposition live in
[openchamber-upstream-20260813.md](openchamber-upstream-20260813.md). The merge is used as an audit
source rather than copied over the Pi-native engine. Every capability in that ledger now carries a
final disposition: adopted at its Pi owner, supplemented beyond the upstream implementation, or
reviewed and deliberately not copied.

- Implemented: directly portable rendering and terminal hardening. Raw Markdown HTML stays inert
  text, `script` and `style` are forbidden again at the sanitization boundary, final Pi bash output
  resolves ANSI styling, carriage-return progress, cursor movement, and line erasure under an
  explicit allocation budget, and code line-number cells stay on one line.
- Implemented: retained relay request-body integrity and mobile transient reconnect behavior.
- Implemented as Pi-native features: the Work Status wide-chat panel, guided
  diff/branch/pull-request walkthroughs, and Markdown task loops for the existing scheduler. Each
  names its authoritative Pi data source and left no duplicate owner behind.
- Implemented: the remaining adopted upstream fixes across provider configuration and OAuth, Git
  worktree and base-branch resolution, pairing/relay reachability, desktop file and window behavior,
  Electron 43 with self-healing installation, native directory permission recovery, first-use bundle
  loading, and the session-settling contract for an unexpected Pi worker exit.
- OpenCode session sync, provider routes, MCP ownership, and lifecycle code remain excluded; only a
  reproducible underlying invariant was reimplemented at its Pi owner.

Acceptance: every adopted capability names its authoritative owner, preserves fork behavior where
it is still required, and has no production dependency on OpenCode or a duplicate compatibility
implementation.

## Phase 9 — Varin extension platform (complete)

The complete target architecture is specified in
[varin-extension-platform.md](../varin-extension-platform.md). Varin extensions are a separate
product/runtime from Pi packages: the former extend the workbench and application host, while the
latter continue to extend Pi through Pi's own `PackageManager` and extension runner.

Delivery is split into complete platform slices without reducing the target customization model:

1. Implemented foundation: extension contract, application-host identity/catalog,
   desired/actual-state and capability-grant records, package-source abstraction, read-only catalog
   Runtime API, revision-checked recovery mutations, and a protected renderer-independent fallback
   manager. This slice does not execute extension code;
2. Implemented Surface slice: owner-scoped lifecycle, atomic contribution/service registries,
   replacement and provider selection, retained layout references, and the Settings workbench plus
   primary Command Palette commands migrated from hard-coded switches;
3. Implemented external Surface slice: authenticated content-addressed artifacts, managed dynamic
   activation, candidate update, capability review, rollback, and Web/Electron/VS Code parity;
4. Implemented Host slice: brokered entrypoints, revisioned storage and migration, versioned service
   dependencies, provider selection, crash isolation, and multi-window host state;
5. Implemented isolated iframe/Worker and explicitly trusted-native modes with truthful physical
   unload, capability boundaries, and restart semantics;
6. Implemented maintained Pi integration adapters as separate built-in Varin extensions while Pi
   Packages and Pi Plugin Settings retain independent lifecycle and native authority;
7. Implemented replaceable navigator, chat, panel, layout, and workbench shell contributions plus
   revisioned workbench/distribution profiles and the fixed recovery path;
8. Implemented stable multi-provider service routing across distribution, profile, user, workspace,
   project, runtime, session, agent, model, and invocation scope;
9. Implemented ecosystem delivery: public contract/Surface/SDK/React/CLI packages and schemas,
   managed/isolated/Host conformance harnesses, arbitrary npm/Git/local install and transactional
   update/discard/remove workflows, a public-state Extension Inspector, explicit profile extension
   sets, and optional discovery metadata that never acts as an allowlist. Capability-bearing first
   installs remain disabled for explicit decisions; candidate review and the persistent apply request
   are separate, so reviewed updates never execute until the user applies them.

Acceptance: managed or isolated extensions enable and disable without a document reload; failed
activation/update leaves no partial effects and preserves the previous generation; Pi package and
Varin extension lifecycle/configuration remain independent; every shared contract has explicit
Web, Electron, VS Code, hosted-mobile, Capacitor, and headless behavior; the recovery kernel can
always enter safe mode with non-kernel extensions disabled.
## Phase 10 — Composable workbench and IDE Workbench (delivered)

The current architecture, product decisions, and ownership contract are specified in
[composable-workbench.md](../composable-workbench.md). Historical delivery slices remain in this
roadmap only; the architecture document intentionally does not preserve their numbering.

This phase turned Varin from a fixed agent workspace into a workspace platform whose entire UI can
be recomposed or replaced by Varin extensions, and delivered two first-party working shapes on top
of it:

- **Agent Workspace** — sessions, tasks, Fleet, context, and recovery at the center.
- **IDE Workbench** — projects, editors, search, Git, terminal, diagnostics, and debugging at the
  center, with the agent as a first-class dockable panel.

Neither is a hard-coded mode. Both are ordinary first-party Varin extensions selected through a
Workbench Profile. There is no global `ideMode`/`agentMode` branch, no second application, and no
fork of Code OSS. The unified editor platform now gives desktop/Web Agent and IDE one shared Monaco
path, while mobile and embedded editors keep a lightweight CodeMirror adapter; the Document Registry
and Host authorities delivered here stay unchanged. See
[unified-file-editor-platform.md](../unified-file-editor-platform.md). Pi Packages and Pi Plugin Settings
keep their independent lifecycle and native authority and are not folded into the Varin extension
lifecycle.

Stable identities established by this phase:

| Identity | Value |
| --- | --- |
| Agent profile | `default`, label `Agent` |
| IDE profile | `varin.ide`, label `IDE` |
| Agent Workspace extension | `varin.builtin.agent-workspace` |
| IDE Workbench extension | `varin.builtin.ide-workbench` |
| Declared shell surfaces | Agent: web, desktop, mobile. IDE: web, desktop only |
| IDE layout service | `varin.workbench.layout` v1 |
| Profile document schema | `VARIN_WORKBENCH_PROFILE_SCHEMA_VERSION = 1` |

Each built-in shell contribution is its extension ID suffixed with `.shell`.

### Delivered slices

1. **Workbench composition foundation.** `@varin/extension-contract` is the single owner of the
   workbench seams: replacement targets (including `workbench.shell`, `activity`, `primary-sidebar`,
   `editor`, `secondary-sidebar`, `panel`, `status` alongside the existing agent-era targets),
   contribution slots, and editor/debug/test/task context keys. The profile document carries a
   revision and every mutation is `expectedRevision`-checked. Layout layers merge
   `distribution → user → workspace`; profile selection now resolves `user → active` (D-298). Shell
   state is reported truthfully as one of `builtin`, `disabled`, `failed`, `missing`, or `ready`.
   `@varin/extension-host` persists the document, the Web application host serves it, and the UI
   stages a candidate shell and only commits the selection after it mounts, so a failed or superseded
   candidate leaves the previous shell active. Profile selection never silently changes the desired
   extension set.
2. **Workspace identity and DocumentsAPI.** The application host owns one revisioned document
   authority (`packages/web/application-host/lib/documents`) with workspace resolve/read/write/move/delete, an
   SSE watch, and crash-recovery journals behind authenticated `/api/documents/*` routes plus a
   resource-scoped `workspace.documents` host capability. Revisions are opaque and writes are
   expected-revision checked. Workspace IDs and journals are scoped per application host, so another
   host never inherits a same-path selection. Watch events carry resource metadata only; file bodies
   never reach logs, event payloads, or URLs. Shared contract fixtures hold Web and VS Code to the
   same behavior, and Electron continues to reuse the Web host in-process instead of gaining a
   generic filesystem IPC. `FilesAPI` stays browse/binary/CRUD and `WorkspaceAPI` stays
   project/tree/git/upload; the duplicate text read/write shapes were deleted rather than kept.
3. **Document Registry and editor migration.** A per-document external store
   (`packages/ui/src/lib/documents`) became the only client-side text authority, keyed by
   `{workspaceId, resourceId}`. It distinguishes `missing`, `binary`, `unsupported-encoding`,
   `deleted`, `error`, and `conflict` from a successful empty read; models a real three-way conflict
   (ancestor plus disk versus live buffer); attributes external change to `agent` or `disk`; and
   preserves edits typed while a save is in flight. Encoding, BOM, and line endings are preserved.
   Crash recovery restores drafts without silently writing to disk.
4. **Editor Workbench Kernel.** Editor groups, tabs, preview/pinned state, resource providers,
   owner-scoped commands, context keys, menus, and the terminal/problems/output panel container were
   extracted into a shared kernel any shell can mount. High-frequency cursor and scroll state stays
   in memory on the tab view state; snapshots are explicit and structurally debounced rather than
   per-keystroke; dirty buffers remain in the Document Registry. `FilesView` became a composition of
   the sidebar tree and the shared editor area with no second document or tab model, and legacy open
   paths migrate once into the kernel.
5. **Agent Workspace as a built-in extension.** The existing default workspace was re-registered as
   an ordinary built-in Varin extension contributing a shell, rather than remaining the hard-coded
   application root.
6. **Official IDE Workbench profile.** The IDE shell ships as a built-in extension declaring web and
   desktop support only; mobile and VS Code deliberately do not claim it. Its layout is a versioned
   split/stack/editor-area document in profile- and workspace-scoped extension storage: missing and
   empty documents fall back to the distribution default without writing it, while malformed or
   failed reads keep the last valid in-memory document and raise a diagnostic instead of overwriting
   host state. Existing profile documents are migrated in place to gain the IDE profile and its
   distribution shell layers.
7. **Search and language services.** Streaming workspace content search and a host-owned language
   service supervisor (JSON-RPC transport, provider registry, capability gating, fixture server) landed
   in the application host. Desktop/Web now project its rich DTO through Monaco, while the first-party
   TypeScript/JavaScript server is a lazy, disableable brokered Varin extension with immutable assets
   rather than a supervisor hardcode. Failures are typed and distinguishable —
   `failed`, `untrusted`, `stale-completion`, `unsupported` — stale diagnostic versions are dropped,
   and hidden views start no language servers.
8. **Agent and editor transactions.** Agent file changes and open editors are reconciled explicitly
   (`packages/ui/src/lib/agent-editor`): attachments are runtime- and session-scoped, unsaved buffers
   become explicit prompt text rather than implicit context, tool path hints never override
   DocumentsAPI watches, and patch accept/reject writes go through expected-revision writes so an
   agent edit cannot silently overwrite a dirty buffer.
9. **Public Workbench SDK.** The workbench authoring surface was exposed through the existing
   workspace packages — `@varin/extension-sdk` (plus its testing entry), `@varin/extension-react`,
   and `@varin/extension-cli` project templates — rather than by adding another package. Authoring
   documentation, runnable examples, and a public-state Extension Inspector in Extensions settings
   shipped with it, localized across every shipped locale.
10. **Run, debug, and test workbench.** The application host owns task processes, test providers, and
    a standard Debug Adapter Protocol implementation with content-length framing, a debug supervisor,
    and a Node adapter; `RuntimeAPIs` gained `tasks`, `debug`, and `tests`. Renderers never start a
    debugger or a task process. Run views hold SSE subscriptions only while visible and drop them
    when hidden. Agent attachments may quote a test failure or stack frame as prompt text but never
    confer process, debug, or test-runner capability.
11. **VS Code Companion transition.** With the official IDE covering the editor path on Web and
    Electron, the VS Code extension was reduced to a companion: it opens and focuses Varin, sends
    editor context, switches sessions, and keeps the workspace bridge. The parallel Settings panel,
    session editor tabs, and agent-management shell were removed rather than maintained as a second
    product UI. Run, debug, and test remain truthfully `absent`/`unsupported` there, and the official
    IDE chrome is not loaded into the former VS Code webview. The keep/migrate/refuse disposition is
    retained here as historical delivery context; the companion is retired under D-296.
12. **Unified desktop/Web editor through collaboration workflows.** Agent and IDE now share Monaco
    models, rich Host language features, atomic workspace edits, file/Git diffs, breakpoint/current-
    frame/test-failure decorations, exact panel navigation, inline comments, and session-scoped Agent
    attachments. Working diffs bind the live dirty buffer; staged/original snapshots stay immutable;
    nested Git roots and debug/test owner generations survive without becoming new authorities.

### Hardening after the slices

Follow-up work made several invariants explicit rather than incidental: document authority
invariants, transactional workbench shell transitions, the editor workbench as the authoritative tab
owner, per-provider workbench lifecycle isolation, public editor contribution mounting,
revision-safe agent editor merges, durability-aware runtime switches, incremental editor change
synchronization, standards-conformant debug adapter behavior, authoritative run panel state,
complete streaming search results, IDE file actions routed through workbench owners, built-in
workbench service initialization ordered after reconciliation, and cloud workspace restore after
authentication.

Acceptance: Agent and IDE both register as ordinary built-in extension manifests with no `ideMode`
ownership branch; profile selection and extension-set application stay separate and separately
failable; a shell commits only after its candidate is ready and the recovery path stays reachable
when no shell is active; one DocumentsAPI owns content with expected-revision atomic writes and
distinguishable missing/empty/binary/failure/conflict states; editor groups, multiple dirty
documents, and multiple views of one document behave correctly across a profile switch; hidden views
perform no background work; language, debug, and test results are provider-isolated with stale
results rejected and project trust enforced at the host; and no Pi plugin private state is copied
into the renderer.

The next composability slice is [Varin Motion and replaceable transition scenes](../varin-motion-platform.md).
It does not define a fixed page-element schema: complete Shells continue to own their information
architecture and internal animation, while Core owns only cross-owner staging, authoritative handoff,
failure recovery, and the first-paint bootstrap boundary.

The public Transition Scene contract and its first runtime consumer are delivered. The default cube
scene is an enabled-by-default built-in Varin extension selected through `workbench.transition`,
while a complete external scene can replace it without importing Varin's product React tree. The
remaining Motion work is the pre-React bootstrap projection and the optional generic service for
Shell-owned local motion; neither introduces fixed page-element names.

The file-editor convergence in
[unified-file-editor-platform.md](../unified-file-editor-platform.md) is complete. Desktop/Web Agent and
IDE share one Monaco model, language bridge, diff/debug/test projection, and Agent collaboration path;
mobile and embedded CodeMirror submit to the same document authority; the public editor contract and
optional owner-scoped Monaco augmentation service are shipped. Retired desktop/VS Code CodeMirror
paths and migration-only comparison code were removed. No editor engine receives document,
filesystem, process, or extension-lifecycle authority. The final verification evidence and any
environment-specific omissions are recorded in that design document rather than inferred from this
ledger.

UI dependency-boundary and extension-contract governance is complete. Current ownership is recorded in
[architecture.md](../architecture.md), [varin-extension-authoring.md](../varin-extension-authoring.md),
and the [`@varin/application-client` README](../../packages/application-client/README.md); executable
conformance remains in the package tests and architecture checks.

## Agent harness — Phase 2/3/3b (2026-09-03)

> **Authority note (2026-09-04).** Per-capability delivery state now lives in
> [agent-harness-status.md](../agent-harness-status.md) (four levels: implemented / wired /
> proven / default-on, with evidence links). The entries below are the historical
> delivery narrative and are no longer updated; where they disagree with the status
> matrix, the matrix wins. P0 integrity, the T1 real-child thread slice, T2 permissions,
> and the core T3 context-shadow path have since shipped; compaction takeover remains
> explicitly default-off pending replay evidence. Follow
> [agent-harness-plan.md](../agent-harness-plan.md) for the current order.

### Phase 2: Context layer (modules + wiring complete 2026-09-03)

- **2.1 Knowledge store v1**: TriviumDB-backed workspace knowledge base
  (`lib/knowledge/store.ts`). Event/session/block/knowledge nodes,
  placeholder vector mode (dim=8), single-writer queue, cascade delete,
  retention. 17 tests. **Wired**: lazy per-workspace store opening in
  `index.ts`, `getKnowledgeStoreForSession` resolver.
- **2.2 Zone 2 assembly**: `varin-context` message template with budget
  folding (`lib/harness/zone2.ts`). 13 tests. **Wired**: `zone2-extension.ts`
  in pi-host hooks `before_agent_start`, requests `zone2.assemble` via
  bridge, returns custom message. 1s timeout (critical path).
- **2.3 Host observers**: Document/terminal/diagnostic/git event handlers
  writing to knowledge store (`lib/knowledge/observers.ts`). 10 tests.
  **Wired**: observer infrastructure in `index.ts` (sessionObservers map).
  Event source subscription TODO.
- **2.4 Memory agent**: Gating table, `memory_edit` ops (replace/patch/
  create/delete/mark_plan), prefix reuse, interval adaptation
  (`lib/harness/memory-agent.ts`). 30 tests. **Wired**: runner field in
  service-host. Model access TODO (currently null).
- **2.5 todo tool**: Plan block management with confidence confirmation
  (`lib/harness/todo-tool.ts`). 12 tests. **Wired**: `todo-tool.ts` in
  pi-host calls `todo.upsert` via bridge, registered in `selectHarnessTools`.
  e2e: 1 test (todo → bridge → router → service → store).
- **2.6 Compaction**: `varin-compaction` summary with non-stacking
  guarantee, re-injection (`lib/harness/compaction.ts`). 10 tests.
  **Wired**: `compaction-extension.ts` in pi-host hooks
  `session_before_compact` (5s timeout) + `session_compact`. e2e: 2 tests
  (compaction.before + compaction.after). D-022 verified Pi consumes
  `{ compaction }` return value (zero LLM calls).
- **2.7 Knowledge suggestions**: Three triggers, review tray actions,
  supersedes chain (`lib/harness/knowledge-suggestions.ts`). 10 tests.
  **Not wired** (TODO).
- **2.8 Embedding providers**: Knowledge recall reuses `harness.embedding`
  / `harness.embed` with a derived vector generation store
  (`lib/knowledge/vectors/`). Authority `.tdb` stays placeholder-dimension.
  **Wired** (D-196). No MiniLM fallback; real remote quality unobserved.
- **2.9 Model slots**: Nine slots + permissionJudge, presets, resolution
  (`lib/harness/model-slots.ts`). 12 tests. **Not wired** (TODO).
- **2.10 recall tool**: Workspace + user store merge, formatted output
  (`lib/harness/recall-tool.ts`). 5 tests. **Wired**: `recall-tool.ts` in
  pi-host calls `recall.search` via bridge, registered in
  `selectHarnessTools`. e2e: 1 test (recall → bridge → router → service →
  store). User store TODO (currently null).

**Phase 2 wiring summary**: 5 new `HarnessServiceMap` methods
(`zone2.assemble`, `compaction.before`, `compaction.after`, `todo.upsert`,
`recall.search`). Provider injection pattern in `HarnessServiceHost` —
providers are optional, services not registered when provider is null.
pi-host extensions use short timeouts and catch errors to avoid blocking
the agent when Phase 2 services are unavailable. 76/76 pi-host harness
tests pass, 102/102 web harness+knowledge tests pass. See D-023.

### Phase 3: Retrieval and sub-agents

- **3.1 Symbol graph collector**: LSP-powered symbol/reference collection
  (`lib/knowledge/symbols.ts`). **Not wired** (TODO).
- **3.2 explore pipeline**: Pure algorithm mode (zero model calls),
  query expansion, parallel rg fan-out, ranking
  (`lib/harness/explore.ts`). 17 tests. **Not wired** (TODO).
- **3.3 related tool**: Graph neighbors by PageRank
  (`lib/harness/related-tool.ts`). **Not wired** (TODO).
- **3.4-3.5 ThreadRecord + Thread registry**: Redesigned with
  host-persisted ThreadRegistry (`lib/harness/thread-registry.ts`).
  JSON persistence (atomic temp+rename), in-memory cache, hidden threads
  (persisted `hidden` field on ThreadRecord), idempotent completion,
  callbacks for protocol events. State transition table with validation.
  `globalEventSeq` initialized from persisted records on `loadParent`.
  31 unit tests. **Wired**: 7 thread service methods
  (dispatch/list/wait/send/read/merge/kill), 7 pi-host tools, two
  protocol events (`harness.thread.changed`/`done`; the dequeue hand-off
  is a registry callback, not an event). e2e: 9 tests.
  See D-024/D-026. Worker runtime (`worker-runtime.ts`) deleted —
  superseded by the thread registry.
  **§9.3 redo (D-026)**: blocking wait (subscribe + timeout + abort
  signal, not polling), incremental threads (observer cursors, `full`
  param), read_thread `what: "blocks"|"report"|"steps"` with `since`
  cursor, dispatch concurrency limit (maxConcurrency=12, `queued`
  result), send wakes idle/waiting-for-input, eventSeq monotonic per
  thread, kill `keepWorktree` (default true), TTL table +
  DEFAULT_WAIT_TIMEOUT_MS. Protocol params no longer carry
  `parentSessionId` — services resolve it from `ctx.sessionId`.
  Dispatch validates role against `ROLE_DEFINITIONS` (unknown role →
  error). Thread tools failure paths return `isError:true` with harness
  error code. `thread.wait` carries `timeoutMs+buffer` through the
  `harness.request` contract (router clamps it to
  `HARNESS_MAX_REQUEST_TIMEOUT_MS`) and observes `ctx.signal`; three e2e
  tests cover blocking past the transport default, waking on a state
  change, and the timeout hand-off. `wait` reports a `waiting` count so
  waiting-for-input threads are visible. Dequeue happens in
  `updateThread` on any terminal transition via `onThreadDequeued`.
  Protocol contract tests: 15. See D-026/D-027/D-028.
  **TODO**: worktree management, activity sensors (stalled/looping),
  Zone 2 threads section, Fleet provider, broker child session
  integration, transcript slice ("steps") wiring to memory agent
  blocksSnapshot, progress/decisions/errors blocks extraction.
- **3.6 Role catalog**: Six roles, team prompt, slot-based resolution.
  Moved to `@varin/protocol/harness-roles.ts` so pi-host can build the
  team prompt and reject unconfigured roles; `lib/harness/roles.ts`
  re-exports it. `frontend` uses its own `models.frontend` slot (§9.2.2).
  14 tests. **Wired**: `dispatch` lists only resolved roles in its
  promptGuidelines and rejects the rest with `unknown role`; the host
  service takes worktree/tools/systemPromptFragment from the definition.
  See D-028.
- **3.7 Review sensor**: Opens a hidden review thread after a settled
  turn with journaled changes (`lib/harness/review-sensor.ts`), gate mode
  for blocking. Ported from the deleted worker runtime to the thread
  registry. 6 tests. **Not wired** (TODO: `agent_settled` hook + Zone 2
  `<review>` injection).
- **3.8 LSP navigation**: symbols/definition/references/hover with
  ready/empty/unavailable states (`lib/harness/lsp-nav.ts`). 13 tests.
  **Not wired** (TODO).

### Phase 3b: Native permission authority (completed 2026-09-15, D-283)

- **3b.1 One interactive gate**: broker-pinned actor identity and Host
  capability/path checks remain non-interactive; pi-host's native `tool_call`
  gate owns user confirmation for Harness, Pi built-ins, MCP, package tools,
  and nested-thread tools. Actual tool source and Host-canonicalized targets
  define the approval scope; unknown third-party side effects ask.
- **3b.2 Smart inside the same gate**: `models.permissionJudge` is resolved in
  SessionHost. Only ordinary complete asks may be auto-allowed; high-risk,
  unknown, or incomplete evidence never reaches the model, and failures ask.
- **3b.3 Dual-track cleanup**: `@gotgenes/pi-permission-system` is no longer
  foundational and its Varin-specific service yield, settings/composer/status
  bridge, and compatibility path are removed. The foundational manifest now
  contains only the maintained MCP adapter.

Current delivery evidence and remaining blockers live only in
[`agent-harness-status.md`](../agent-harness-status.md); D-044 remains only as the
historical coexistence record superseded by D-283.
