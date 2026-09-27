# Varin extension platform

Status: implemented; the authoring toolchain is prepared for npm but not published yet

Current boundary (D-296): supported application-host surfaces are Web, Electron, hosted mobile,
Capacitor, and headless consumers. The former VS Code companion and its host bridge are retired;
historical references in delivery notes do not define a current target.

Last updated: 2026-09-02

## 1. Decision

Varin is a composable Pi-native workbench and extension platform. The product shipped by this
repository is the default distribution of that platform, not a permanently fixed shell with a small
set of add-on slots.

The target customization ceiling is deliberately high:

- extensions may add, decorate, reorder, hide, or replace product contributions;
- the session navigator, chat timeline, composer, Agents, MCP, settings, panels, and workbench shell
  are replaceable above a narrow recovery kernel;
- built-in product features ultimately use the same contribution and lifecycle contracts as
  external Varin extensions;
- an extension may provide UI only, host services only, or coordinated host and surface entrypoints;
- declarative, managed-code, isolated-app, and trusted-native UI modes coexist instead of forcing
  every extension into one framework or one reversibility model;
- service selection may later vary by workspace, session, agent, model, or invocation without
  hard-coding package-to-package coexistence rules.

This platform is separate from Pi's package and extension system. A Pi package extends the Pi agent
runtime; a Varin extension extends the Varin product and workbench. The two systems communicate
through typed integration contracts but keep separate identities, managers, configuration,
lifecycle, and enablement state.

Cordis and its temporal/spatial composition model are design references only. No Cordis dependency
or public Cordis-shaped API is selected by this document.

## 2. Terms and ownership

| Term | Owner | Runs in | Purpose |
| --- | --- | --- | --- |
| Pi package / Pi extension | Pi `PackageManager` and Pi extension runner | Pi session worker | Tools, hooks, commands, providers, agents, context processing, and Pi resources |
| Varin extension | Varin Extension Manager | Varin host and/or a UI surface | Workbench pages, renderers, workflows, layout, themes, product services, and integrations |
| Integration adapter | A Varin extension, built-in or external | Varin host/surface | Projects a Pi package's public configuration, state, and actions without taking ownership from it |
| Contribution | Varin Surface Runtime | A UI surface | A page, view, panel, command, menu, renderer, theme, layout item, or replacement implementation |
| Service | Varin component runtime | Host or surface realm | A versioned capability provided by one component and consumed by another |
| Distribution profile | Varin product distribution | Varin application host | A selected set of built-in/external extensions, defaults, layout, and service selections |
| Application host | Varin Web server or Electron-local server | Trusted Node runtime | Owns Varin extension installation, desired state, assets, host entrypoints, and surface catalog |
| Pi runtime target | Local or remote Varin Pi runtime selected by the user | Pi host/broker | Owns Pi sessions, Pi packages, models, commands, and agent execution |

An application host and a Pi runtime target are intentionally different identities. Desktop can
keep its local Varin extensions while connecting to another Pi runtime. Extension caches,
catalogs, assets, and desired state are keyed by application-host identity; integration state that
depends on Pi is additionally keyed by Pi runtime identity.

An extension repository may also maintain a companion Pi package, but they are published and
installed as separate product objects. For example:

```text
pi-observational-memory              Pi package
@varin/observational-memory-ui     Varin extension
```

The Extension Manager may expose a bundle action that installs both after an explicit user choice,
but one side is never silently enabled, disabled, updated, or removed as a consequence of changing
the other.

## 3. Goals

1. Make deep customization a product capability rather than a collection of internal switch
   statements.
2. Dynamically enable and disable reversible or isolated extensions without reloading the whole UI.
3. Allow maximum-freedom native extensions without falsely claiming that arbitrary same-realm
   JavaScript can be physically unloaded.
4. Keep Web, Electron, hosted mobile, and Capacitor behavior explicit for every shared
   contribution and capability.
5. Keep privileged operations in the application host, Pi host, or Electron main process rather than
   granting them implicitly to renderer code.
6. Preserve Pi session JSONL, Pi settings/packages, extension-native files, and plugin-native
   databases as their documented authorities.
7. Let built-in and external features use one component, service, contribution, and lifecycle model
   above the recovery kernel.
8. Support transactional activation, deterministic teardown, failed-update rollback, and truthful
   per-realm diagnostics.
9. Support extension-defined configuration and persisted data without imposing a universal product
   schema.
10. Leave room for future service orchestration by workspace, session, agent, model, or invocation.

## 4. Non-goals

- Replacing or wrapping Pi's package manager with the Varin Extension Manager.
- Loading Pi extensions directly into a browser or Electron renderer.
- Making Pi packages depend on Varin in order to work in the Pi CLI.
- Requiring React, a Varin form schema, or the Varin design system for every UI extension.
- Claiming that a disposer can reverse an external effect that has already escaped its controllable
  boundary, such as an observed network message or an irreversible external write.
- Claiming that a Node child process or browser iframe is an operating-system security sandbox.
- Keeping unreleased historical API aliases or compatibility branches after the platform contract
  changes during pre-release development.
- Adopting Cordis, Module Federation, Web Components, or another implementation technology as part
  of the public extension contract.

## 5. Customization model

### 5.1 The fixed recovery kernel

Only the minimum product substrate required to boot and recover is fixed:

- application bootstrap and authenticated connection setup;
- extension manifest validation and Extension Manager startup;
- capability/trust decisions at the owning privileged boundary;
- the component supervisor and surface registry substrate;
- crash boundaries, safe mode, and a built-in recovery route that can disable extensions;
- protocol/version negotiation and authoritative runtime selection;
- a fallback error surface when the selected workbench shell cannot start.

The ordinary Extension Manager UI may itself be contributed and customized, but the kernel retains
an intentionally plain fallback manager so a broken shell or extension cannot make recovery
impossible.

The kernel does not own chat, session navigation, Agents, MCP, Provider settings, themes, project
browsing, terminal UI, or a particular workbench layout.

### 5.2 Customization operations

The platform distinguishes four operations instead of treating every extension as an unordered DOM
patch:

| Operation | Meaning |
| --- | --- |
| Add | Register another item in a multi-contribution collection, such as a page, command, renderer, or status item |
| Augment | Contribute to a documented region or pipeline before/after an existing owner |
| Replace | Offer an alternative implementation for a single-owner capability such as `chat.composer` or `workbench.shell` |
| Compose | Provide or consume versioned services so independently implemented capabilities cooperate |

Additive contributions coexist. Replacement points select one active implementation through an
explicit policy: user choice, workspace profile, distribution default, then the built-in fallback.
Module load order and arbitrary numeric priority never silently decide ownership.

Ordered augmentation pipelines use stable contribution IDs plus user/profile order and optional
`before`/`after` relationships. Ordering cycles are diagnosed and the conflicting augmentation is
left inactive; Varin does not guess an order.

### 5.3 Customization ceiling

The target contribution families cover the complete workbench:

- themes, design tokens, icons, locale messages, keybindings, and command palette entries;
- activity bar, primary sidebar, secondary sidebar, bottom panel, status area, headers, and layout;
- complete pages, routes, split-view sidebars, tabs, dialogs, inspectors, and context menus;
- settings pages and sections;
- session navigator rows, badges, grouping, actions, and a replaceable navigator implementation;
- chat timeline items, message/tool/custom-entry renderers, composer actions, attachments, and a
  replaceable timeline or composer;
- Agents, Fleet, MCP, Provider, Recovery, Commands, Prompts, Skills, package, and integration views;
- file, Git, terminal, walkthrough, diagram, and project/workspace surfaces;
- notifications, background status, scheduled-work UI, and diagnostics;
- an alternative `workbench.shell` that replaces the default product organization.

The contribution API provides Varin-native primitives for consistent integrations, but a
contribution may also mount an arbitrary framework-neutral Surface within its granted region.

## 6. Target architecture

```text
                         Varin application host
┌──────────────────────────────────────────────────────────────────────┐
│ Extension Manager                                                   │
│  installation · desired state · updates · manifests · trust         │
│                                                                      │
│ Extension Supervisor                                                │
│  owner scopes · lifecycle · dependencies · rollback · diagnostics    │
│                                                                      │
│ Host Service Runtime                 Extension Asset Service         │
│  brokered/native host entrypoints    manifests · bundles · assets    │
└───────────────────────┬───────────────────────────────┬──────────────┘
                        │ typed extension protocol       │ authenticated assets
                        ▼                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Varin Surface Runtime                                             │
│  per-window supervisor · contribution registry · service clients    │
│  declarative · managed · isolated · trusted-native entrypoints       │
│                                                                      │
│ Default workbench and external Varin extensions                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ existing Varin runtime protocol
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Pi runtime target                                                   │
│  Pi sessions · Pi PackageManager · Pi extensions · models · tools   │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.1 Proposed package ownership

The exact package names may be finalized during implementation, but ownership remains separated:

| Package | Responsibility |
| --- | --- |
| `@varin/extension-contract` | Browser-safe manifest, lifecycle, contribution, service, and wire DTOs |
| `@varin/extension-host` | Installation records, desired-state store, supervisor, host entrypoints, asset catalog, and migrations |
| `@varin/extension-surface` | Surface supervisor, owner scopes, contribution registry, module/iframe lifecycle, and layout resolution |
| `@varin/extension-sdk` | Framework-neutral extension author API and build-time types |
| `@varin/extension-react` | Optional React 19 adapter; not the core contract |

`@varin/protocol` remains the Pi worker/surface contract. Varin extension contracts are not
renamed Pi extension messages and do not make Pi workers aware of Varin UI modules.

The shared UI receives an `extensions` capability through `RuntimeAPIs`; Web, Electron-through-Web,
hosted mobile, and Capacitor define explicit behavior. Extension code never hardcodes a
server origin, port, credential, local path, or Electron IPC channel.

### 6.2 Application-host ownership by surface

| Surface | Application host behavior |
| --- | --- |
| Web / cloud | The trusted Varin server owns extension installation, host entrypoints, assets, and desired state |
| Electron | The in-process local Web server remains the application host; Electron main owns only inherently native grants |
| Hosted mobile | The paired Varin server is the application host; the mobile client activates only compatible surface entrypoints |
| Capacitor without a host | Built-in surface extensions work; external host-dependent extensions return a stable unsupported state |
| Headless/test | The host supervisor and service runtime run without a Surface for tests, automation, and diagnostics |

Changing the active Pi runtime does not silently replace the application host's extension
installation. Runtime-dependent adapters rebind their Pi clients and reject stale completions from
the previous runtime.

## 7. Extension package and manifest

### 7.1 Identity

Every extension has an immutable manifest ID and SemVer version. Installation source, resolved path,
content integrity, and installed version are separate facts. Source strings and display names are
not stable identity.

Only one version is selected for an extension ID in a distribution profile, although the old and
candidate versions may coexist temporarily during a transactional update. Different application
hosts may select different versions.

The manifest is a standalone Varin artifact, provisionally `varin.extension.json`, so the
platform is not limited to npm and cannot be confused with Pi's package metadata. npm, Git, local
directories, and future package sources may point to the same manifest contract.

### 7.2 Illustrative manifest

The following shape communicates the target ownership; it is not a frozen schema:

```jsonc
{
  "schemaVersion": 1,
  "id": "dev.example.memory-workbench",
  "version": "1.2.0",
  "engines": { "varin": ">=0.2.0 <0.3.0" },
  "entrypoints": {
    "host": {
      "file": "dist/host.mjs",
      "mode": "brokered"
    },
    "surfaces": [
      {
        "id": "main",
        "file": "dist/surface.mjs",
        "mode": "managed",
        "supports": ["web", "desktop", "mobile"]
      }
    ]
  },
  "requires": {
    "services": [{ "id": "varin.sessions", "version": 1 }]
  },
  "provides": {
    "services": [{ "id": "dev.example.memory", "version": 1, "multiple": true }]
  },
  "capabilities": {
    "host": ["extension-storage", "pi-runtime-client"],
    "surface": ["commands", "notifications"]
  },
  "integrates": {
    "piPackages": ["pi-observational-memory"]
  }
}
```

A Varin extension manifest cannot declare a Pi extension entrypoint. `integrates.piPackages` is
compatibility and navigation metadata, not shared lifecycle ownership.

### 7.3 Static and dynamic contributions

Simple contributions may be declared in the manifest and indexed without executing extension code.
Dynamic contributions are registered during `activate(ctx)`. Both enter the same registry and use
the same stable contribution IDs, replacement policy, visibility conditions, and teardown model.

The manifest declares requested capabilities and entrypoint compatibility. The application host
records the exact capability grant separately, so an update that adds a capability does not inherit
approval merely because the extension ID stayed the same.

## 8. Lifecycle and dynamic enablement

### 8.1 Three independent facts

The platform never collapses these states:

```text
installed   package artifacts and manifest are present
enabled     the user's desired policy says the extension should run
active      a particular host/surface entrypoint is currently running successfully
```

An installed and enabled extension can be inactive because its dependencies are missing, its
capabilities were not granted, the current Surface is unsupported, activation failed, or a selected
replacement excludes it. Those reasons remain explicit.

### 8.2 Per-entrypoint states

Each host or surface instance moves through a serialized state machine:

```text
inactive
  -> resolving
  -> loading
  -> activating
  -> active
  -> deactivating
  -> inactive

resolving/loading/activating -> rolling-back -> failed or waiting
active -> updating -> active, or old active instance restored
```

`waiting` means the desired state is still enabled but a required service, capability, or compatible
Surface is absent. `failed` records an attempted transition and actionable diagnostics. Neither is
silently rewritten to disabled.

The host stores a monotonic desired-state revision. Every asynchronous transition captures the
application-host identity, extension ID, entrypoint, instance generation, and desired revision.
Late completions from a superseded enable, disable, update, host switch, or runtime switch cannot
publish services or contributions.

Rapid toggles serialize per extension and reconcile toward the newest desired revision. Cleanup for
an older active generation completes before its owner is discarded; a new generation never inherits
untracked effects from the old one.

### 8.3 Activation transaction

Activation is staged rather than incrementally exposed:

1. Validate manifest compatibility and current capability grants.
2. Resolve required services and selected replacement ownership.
3. Create an isolated owner scope and an activation `AbortSignal`.
4. Load the entrypoint in its declared execution mode.
5. Run `activate(ctx)` against staging service/contribution registries.
6. Validate unique IDs, service versions, replacement conflicts, and ordering relationships.
7. Commit the staged services and contributions as one visible generation.
8. Publish the actual-state result with the captured desired revision.

If any step fails, the supervisor aborts in-flight work, disposes the owner scope in reverse order,
terminates isolated realms, discards staging registries, and reports failure. Users never see a
half-registered page or service.

No speculative global activation timeout is imposed. The supervisor exposes a transition that is
still running, accepts cancellation, and can terminate an isolated realm. A native same-realm
entrypoint that cannot finish cleanup may require a Surface reload; Varin reports that truthfully
instead of pretending it was unloaded.

### 8.4 Deactivation transaction

Deactivation proceeds in dependency-safe order:

1. Mark the instance draining and reject new calls into its services/actions.
2. Move the workbench away from a view or shell that is about to disappear.
3. Deactivate required dependents before withdrawing the provider service.
4. Abort instance-owned async work and invalidate its generation.
5. Unmount contributions and remove registry visibility atomically.
6. Run extension cleanup and owner-scope disposers in reverse registration order.
7. Terminate iframe, Worker, or brokered host process where applicable.
8. Publish the inactive state while retaining configuration and persistent data.

A clean deactivation is idempotent and tolerates partial activation, repeated shutdown, Surface
closure, and host process exit.

Host and Surface entrypoints remain separate instances. When a Surface requires an extension-owned
Host service, the Host provider commits first and the Surface commits afterward; teardown removes
Surface consumers before the Host provider. One unsupported or failed Surface does not roll back
compatible windows or the Host service unless the manifest deliberately declares them as one atomic
activation group. Product status therefore reports per-entrypoint results instead of one misleading
global loaded flag.

### 8.5 Update transaction

Updates use candidate activation rather than destructive in-place replacement:

1. Download/resolve the candidate into a content-addressed installation directory.
2. Validate the manifest, integrity, compatibility, and capability delta.
3. Record capability decisions, then persist a separate explicit application request from the user.
4. Prepare configuration/data migration and candidate Host/Surface instances against staged state.
5. Validate all compatible entrypoints in the initiating Surface before the persistent commit boundary.
6. Commit selected version, migration, Host services, and the staged Surface generation without a
   fallible operation after the persistent selection.
7. Deactivate the old generation. A superseding queued lifecycle request then reconciles normally.

If candidate activation fails, the old version remains selected and active. Extension-owned
external migrations that cannot be reversed must declare that fact and receive focused confirmation;
the platform does not mislabel them as transactional.

Capability review and application intent are independent facts. Finishing review never executes a
candidate. Trusted-native Host updates persist the application request and complete it only after the
application host restarts; merely staging or reviewing that candidate cannot select it.

### 8.6 Logical and physical unload

Dynamic disable guarantees no remaining observable platform contribution or accepted service call.
It does not promise that every execution mode releases module bytes identically:

| Surface mode | Disable behavior | Physical code reclamation |
| --- | --- | --- |
| Declarative | Remove registry records | No executable module loaded |
| Managed module | Abort, unmount, dispose all owned effects | Browser ESM module record may remain cached |
| Isolated app | Close MessagePorts and destroy iframe/Worker | Realm can be reclaimed when no external references remain |
| Trusted native | Call extension cleanup and remove tracked effects | Full reclamation may require reloading that Surface |

Content-hashed module URLs allow candidate versions to load without confusing browser caches. The
platform does not accumulate arbitrary cache/count ceilings without measurements; diagnostics expose
retained native module generations so a real reload policy can be calibrated later.

## 9. Effect ownership

Every activation creates an `OwnerScope`. Platform registrations automatically belong to that scope:

- services and service subscriptions;
- contributions, commands, keybindings, menus, routes, and renderers;
- Pi/runtime event subscriptions and application-host RPC handlers;
- timers, tasks, streams, Workers, iframes, and MessagePorts created through the SDK;
- stylesheets, fonts, object URLs, and extension asset handles;
- extension storage watches and configuration subscriptions;
- native grants or host resources returned through capability APIs.

An illustrative framework-neutral entrypoint is:

```ts
export async function activate(ctx: VarinExtensionContext) {
  ctx.contributions.register(...)
  ctx.services.provide(...)
  ctx.events.on(...)

  ctx.effect(() => {
    const external = startExternalEffect()
    return () => external.stop()
  })
}
```

The SDK records cleanup for its own APIs. Arbitrary browser or Node APIs remain the extension's
responsibility through `ctx.effect()` or its returned `deactivate()` hook. Managed lifecycle is a
strong contract, not a claim that the runtime can discover mutations made behind its back.

Disposers are LIFO, may be asynchronous, and are called at most once per owner generation. Cleanup
continues after an individual disposer fails; all failures remain attributed to extension,
entrypoint, generation, and effect kind.

## 10. Services and dependencies

### 10.1 Versioned services

Services use stable namespace-qualified IDs and explicit major contract versions, for example:

```text
varin.sessions@1
varin.commands@1
varin.extension-storage@1
dev.example.memory@1
dev.example.compaction@1
```

Service identity is not an npm package name. A provider may be built-in or external, and several
providers may implement a multi-provider contract.

Extensions consume one another through service contracts rather than importing another installed
extension's private files or JavaScript bundle. This keeps update, dependency, and teardown
ownership observable while still allowing extensions to define new domain-specific services.

Across processes or browser realms, a service is represented by a JSON-safe RPC/event client or a
scoped `MessagePort`; raw JavaScript objects and privileged handles do not cross the boundary.

### 10.2 Required, optional, and multiple dependencies

Consumers can declare:

- required single service: activation waits for the selected provider;
- optional service: activation succeeds and receives availability changes;
- multiple service: all compatible providers are exposed as a catalog;
- selected service: user/workspace/routing policy chooses one from multiple providers.

Required activation edges must be acyclic because neither side of a cycle can become active first.
The supervisor reports the complete cycle. Mutual runtime cooperation remains possible through
optional/lazy service lookup or a third integration component; the platform does not choose an
arbitrary cycle break.

When a required service is withdrawn, consumers drain and deactivate before the provider. When it
returns, enabled consumers activate again. Optional consumers receive a versioned availability
change without being restarted unless their own manifest requests reconciliation.

### 10.3 Selection and orchestration

Multiple providers are not forced into one global singleton. The application host persists stable
provider keys separately from generation-bound runtime IDs and can bind a service by:

- distribution default;
- user or workspace profile;
- project;
- Pi runtime target;
- session;
- agent or subagent;
- provider/model;
- invocation or workflow step.

Rules are resolved from distribution through invocation scope. A rule may match several dimensions;
equally specific conflicting rules are reported as ambiguous rather than resolved by package order.
If a selected provider disappears, fallback to a less-specific rule occurs only when that rule opted
into fallback. The rule remains persisted so reinstalling or re-enabling the provider restores the
selection without rewriting plugin-owned configuration.

This routing layer is the home for later context, memory, compaction, recovery, or tool-service
orchestration. Varin extensions advertise capabilities and consume the selected service; they do
not inspect one another, mutate Pi package configuration, or invent coexistence bans.

## 11. Contribution runtime

### 11.1 Registry model

Every contribution has:

- a stable extension-qualified contribution ID;
- contribution kind and contract version;
- owner generation;
- supported Surface kinds and required capabilities;
- placement/replacement metadata;
- visibility conditions derived from public state;
- an implementation handle appropriate to its execution mode;
- optional search, command, locale, icon, and layout metadata.

The Surface Registry is an external store. React uses a small adapter such as
`useSyncExternalStore`; other frameworks can subscribe directly. Registering or withdrawing a
generation causes the workbench to render or unmount it without refreshing the document.

Current hard-coded registries such as the settings `pageOrder`, `renderPageSidebar`, and
`renderPageContent` switches are migration inputs, not the final extension API.

### 11.2 Workbench ownership points

Replacement-capable ownership points include at least:

```text
workbench.shell
sessions.navigator
chat.timeline
chat.composer
agents.workbench
mcp.workbench
workspace.explorer
settings.workbench
```

Smaller additive/augmentation points remain available within them. A replacement implementation
receives a documented model and capability clients, not private component state from the previous
owner.

### 11.3 Layout and user choice

The layout model stores contribution IDs rather than component types. Visibility, order, docking,
split sizes, and selected replacement are scoped by distribution profile, user, workspace, and
Surface kind. Missing contributions remain as recoverable layout references so reinstalling or
re-enabling an extension can restore the user's placement.

Layout persistence distinguishes missing extension, successful empty layout, malformed state, and
read failure. A transient catalog failure never deletes saved placement.

### 11.4 Framework neutrality

Core extension contracts contain no React component type. The managed Surface API provides a mount
host and lifecycle context. Official adapters may convert React, Web Components, or declarative
Varin views into that contract.

An extension can use Varin design primitives for product consistency or render a fully custom DOM,
Canvas, WebGL, WebAssembly, or framework application within its contribution. Deep customization is
not limited to generated settings forms.

## 12. Surface execution and trust modes

### 12.1 Declarative

The manifest contributes data-only pages, settings, commands, menus, status items, or render specs.
Varin owns rendering and no third-party Surface code executes. This mode is convenient and highly
portable, not mandatory.

### 12.2 Managed module

Varin loads a framework-neutral bundled module and passes a scoped Surface context. Platform API
effects are owner-tracked; raw browser effects must register cleanup. The extension can provide a
complete custom page or shell, not only standard fields.

### 12.3 Isolated app

Varin creates a sandboxed iframe and/or Worker, establishes a versioned MessagePort handshake, and
grants selected capability clients. The extension controls its own DOM, CSS, framework, and internal
state. Deactivation destroys the realm, providing the strongest practical physical-unload behavior.

Isolation prevents ambient access to Varin internals but is not described as an operating-system
sandbox. Network and browser capabilities depend on iframe policy and explicit grants.

### 12.4 Trusted native module

An explicitly trusted module runs in the Surface realm and may use advanced native APIs, design
system internals, or low-level shell replacement hooks. It has the greatest integration freedom and
the weakest automatic isolation. Varin removes registered contributions and calls cleanup, but may
require a Surface reload to guarantee that untracked same-realm mutations are gone.

Native mode is not banned or hidden behind a marketplace allowlist. The user sees its actual trust
and reload semantics before activation.

### 12.5 Host entrypoints

Host extensions have two corresponding choices:

| Mode | Behavior |
| --- | --- |
| Brokered | Run in a supervisor-owned Node child/worker boundary and access Varin through capability RPC; process termination provides crash and lifecycle isolation |
| Trusted native | Run in the application-host process for capabilities that genuinely require it; cleanup is cooperative and host restart may be required after failure |

A brokered Node process still has the operating-system permissions of its account unless a future
deployment adds an actual OS sandbox. Capability mediation improves ownership and API boundaries but
is not presented as stronger containment than it provides.

## 13. Assets and browser loading

The application host, not the selected Pi runtime, owns Varin extension assets. Assets are
content-addressed and authenticated; the manifest and selected installation record include their
integrity. A Surface never constructs filesystem URLs or embeds a long-lived bearer token in an
asset URL.

The browser implementation uses two shapes:

- managed/native module artifacts fetched or resolved through the authenticated extension asset
  capability, with content hashes included in module identity;
- isolated-app bootstrap documents or Workers created from authenticated content-addressed bytes,
  followed by a versioned MessagePort capability handshake. Their blob/srcdoc identity is owned by
  one realm and carries no reusable application credential.

The browser asset implementation must work for Web, packaged Electron, hosted mobile, and runtime
switching. A focused prototype will choose between a self-contained fetched ESM
bundle and a scoped asset origin; this choice is private to the asset service and does not change the
manifest, contribution, or lifecycle contracts.

Extension-provided subresources are resolved through `ctx.assets`, keyed by application-host
identity, extension installation, content hash, and asset path. Object URLs are revoked with their
owner scope.

## 14. State, configuration, and data ownership

### 14.1 Platform-owned records

The application host owns:

- installed source, resolved version/path, content integrity, and manifest snapshot;
- selected version and candidate-update state;
- enabled policy and capability grants;
- distribution/profile membership;
- per-entrypoint actual state and diagnostics;
- layout references and selected replacement implementations;
- extension-scoped storage revisions and migration status.

These records live below `VARIN_DATA_DIR`, not Pi's agent directory. Writes use the existing
Varin atomic/revision discipline and preserve the previous authoritative state on read or write
failure.

### 14.2 Extension-owned records

An extension may use host-provided namespaced storage or its own documented external authority.
Host-provided storage supports explicit scopes:

- application/user;
- distribution profile;
- workspace/project;
- Surface/window preferences;
- session-ephemeral state.

The extension owns its schema and migrations. Varin owns atomic storage mechanics, revisions,
namespace isolation, and truthful failure signaling. Absence, authoritative empty data, malformed
data, and read failure are distinct.

Disabling an extension preserves configuration and persistent data. Uninstall offers an explicit
retain-or-delete decision and never silently removes project data. Removing package artifacts and
deleting extension data are separate operations.

### 14.3 Pi integration authority

An integration adapter continues to edit or query the Pi package's native authority through the
Varin protocol:

- Pi settings and package filters remain owned by Pi;
- native JSON/JSONC documents remain authoritative and revision checked;
- Pi session JSONL and plugin databases are never copied into Varin extension storage;
- public commands, events, RPC snapshots, and provider actions remain the only runtime integration
  contracts;
- adapter UI state may be cached for continuity but is not proof of current Pi package activity.

## 15. State synchronization invariants

The application host is authoritative for installation, enabled policy, grants, selected versions,
and profile/layout state. Each Host/Surface instance is authoritative only for its own actual
activation result.

Catalog snapshots and events carry a monotonic revision and application-host identity. Consumers:

- preserve the last valid catalog on transport failure;
- never turn failed load into an empty extension list;
- reject stale completion after application-host or Pi-runtime switching;
- compare disappearance only between complete authoritative snapshots from the same host and scope;
- keep actual state per Surface/window rather than claiming one Surface failure disabled all others;
- capture local mutation revision before refresh so in-flight catalog loads cannot overwrite a
  newer enable, disable, install, update, or layout mutation;
- serialize persisted writes per owner and reject stale writes;
- drain or explicitly cancel captured-owner writes during host/surface shutdown.

Multi-window state converges on host desired state but preserves per-window activation diagnostics.
Closing one window deactivates only its Surface instances. Host entrypoints remain active while any
enabled policy/service activation requires them, according to their declared activation event.

## 16. Activation events and resource behavior

An installed extension is not loaded merely because it appears in the catalog. Entrypoints declare
when they are needed, for example:

- application startup;
- first contribution visibility;
- first command invocation;
- first service request;
- workspace/project match;
- explicit always-on background capability.

Activation events are extension intent and profile policy, not product-imposed throttles. Enabled
extensions whose trigger has not occurred remain `inactive`, not failed.

The platform records activation duration, active realms, owned effect counts, background processes,
asset/module generations, and cleanup failures. It does not add speculative global memory, count,
duration, or concurrency ceilings. Real measurements and deployment requirements may later define
configurable budgets or warnings.

Declarative contributions can be indexed without loading code. Surface bundles and host entrypoints
load only on compatible surfaces and activation events. Isolated realms can be terminated for
physical reclamation; native module cache behavior remains visible in diagnostics.

## 17. Pi package integration

Pi Packages and Varin Extensions remain separate product pages and protocol entities:

| Pi Packages | Varin Extensions |
| --- | --- |
| Install/update/remove through Pi `PackageManager` | Install/update/remove through Varin Extension Manager |
| Enable/disable Pi resource types and reload the Pi runtime | Reconcile Varin host/surface entrypoints |
| Scope is Pi global/project | Scope is application/profile/workspace/Surface policy |
| Configuration is Pi/plugin native | Configuration is Varin-extension native |
| Can run without Varin | Extends the Varin product |

`Plugin Settings` remains the Pi-package configuration surface. Specialized adapters become
built-in or external Varin integration extensions over time, while the selected native Pi
document remains authoritative. A future product label should distinguish `Pi Plugin Settings` from
`Varin Extensions` unambiguously.

Enabling a Varin integration extension does not enable its companion Pi package. Enabling a Pi
package does not silently install a Varin UI. The UI may offer one explicit combined action while
reporting the two resulting operations separately.

## 18. Built-in distribution and migration

### 18.1 Built-ins use the platform

Built-in extensions may remain statically compiled for startup and release reliability, but they
register through the same owner, service, and contribution registries. Static linking is an asset
delivery optimization, not a privileged product contract.

The default distribution profile selects:

- the default workbench shell and layout;
- built-in chat, session, project, settings, and resource extensions;
- maintained Pi integration adapters;
- recovery-kernel contributions that have a fixed fallback implementation.

Users may replace or disable ordinary built-ins. The recovery kernel remains available even if the
selected shell fails.

### 18.2 Migration rule

Existing features migrate capability by capability. A hard-coded implementation is removed only
after its complete behavior has a contribution/service owner or has been explicitly rejected. There
is no parallel permanent implementation and no compatibility wrapper around the old switch.

High-value migration seams already visible in the current code are:

1. settings metadata, navigation, sidebars, pages, and search registry;
2. command palette, menus, keybindings, and status widgets;
3. message/tool/custom-entry renderers;
4. Plugin Settings adapters, Agents, Fleet, and MCP workbenches;
5. right sidebar and bottom-panel surfaces;
6. session navigator and composer/timeline augmentations;
7. complete workbench shell selection.

The current generic Pi extension UI bridge remains independent and usable throughout migration.

## 19. Developer experience

The platform requires first-class tooling rather than asking authors to hand-build private loaders:

- manifest schema and editor diagnostics;
- framework-neutral `@varin/extension-sdk` types;
- optional React and Web Components adapters;
- a build command that emits content-addressed Surface/Host artifacts and an integrity manifest;
- local-directory development installation without copying the working tree;
- lifecycle-aware development reload that activates a candidate and rolls back on failure;
- a headless host test harness and real-browser Surface harness;
- conformance tests for enable/disable, partial activation, async cleanup, update rollback, runtime
  switch, and malformed state;
- an Extension Inspector showing owner scopes, services, contributions, dependencies, activation
  timeline, grants, assets, and cleanup failures;
- stable logs attributed by extension ID, version, entrypoint, realm, owner generation, and runtime
  target, without serializing credentials or private plugin data.

Public SDK documentation must describe which APIs are owner-tracked and which raw effects require an
explicit disposer. Reversibility is observable contract behavior, not marketing language.

## 20. Trust and capability model

Capabilities correspond to concrete privileged operations or data boundaries, not broad labels used
to discourage ordinary configuration. Examples include:

- Pi runtime client access;
- application-host extension storage;
- workspace files or Git;
- subprocess/PTY execution;
- outbound network;
- provider/model requests;
- notifications and background work;
- Electron-native operations;
- native Surface execution.

Managed and isolated entrypoints receive scoped capability clients. The privileged implementation
and input validation remain in Web server, Extension Host, Electron main/preload, or Pi host. Remote
pages do not inherit local desktop privileges.

Trusted-native code has ambient access that cannot be reduced to the same claim. Varin shows that
mode and its capability delta explicitly. Project-local executable extensions also require the
existing project trust boundary.

Capability requests on a first external install are reviewed before the extension can be enabled.
Capability changes on update are reviewed before candidate activation. Ordinary updates that do not
change capability needs are not blocked by repeated generic warnings, but still require the separate
explicit apply action.

## 21. Compatibility and versioning

The platform separates four version axes:

1. manifest `schemaVersion`;
2. Varin engine compatibility range;
3. contribution/service contract major versions;
4. extension data schema and migrations.

During pre-release development, all Varin-owned surfaces and built-ins move in lockstep and the
current contract replaces unreleased predecessors. Once an external SDK is declared stable, a major
contract is either supported explicitly or rejected with an actionable incompatibility diagnostic;
Varin does not silently reinterpret unknown fields or keep unbounded legacy aliases.

Extensions bundle their framework dependencies rather than relying on Varin's React or state-library
version. Only the framework-neutral SDK contract is shared. The optional native React adapter has an
explicit engine/adapter compatibility range.

Service consumers request a major contract version. Minor additions remain optional and
feature-detected through capability descriptors rather than package-version guesses.

## 22. Failure semantics and acceptance invariants

The platform is not complete until these invariants hold:

- disabling a declarative, managed, or isolated extension removes all visible contributions and
  rejects new service calls without a document reload;
- a failed activation leaves no committed contribution, service, event subscription, command,
  stylesheet, object URL, Worker, iframe, or brokered child;
- a late async completion from a prior owner generation cannot resurrect state or registrations;
- required dependents stop before a provider service is withdrawn;
- a failed candidate update preserves the old selected version, active generation, configuration,
  and layout;
- transient catalog/config failure preserves the previous valid state and is never rendered as a
  successful empty result;
- application-host and Pi-runtime switches reject stale state and never reuse credentials, paths,
  URLs, or grants from the previous owner;
- disabling and uninstalling are distinct, and neither silently deletes persistent extension or
  project data;
- Pi package and Varin extension enablement remain independent in storage, protocol, UI, and
  diagnostics;
- a Surface that cannot support an entrypoint reports stable unsupported/waiting state without
  disabling compatible Surfaces;
- trusted-native or irreversible external effects report restart/non-reversible semantics instead
  of claiming a clean rollback;
- Web, Electron, hosted mobile, Capacitor, and headless behavior is intentionally specified
  for every shared contract;
- the fallback manager can start with all non-kernel extensions disabled after a crash loop.

## 23. Cordis disposition

Cordis contributes useful reference concepts:

- owner-scoped inverse effects;
- dependency-aware activation and teardown;
- configuration reconciliation;
- staged activation and rollback;
- lifecycle diagnostics and development reload.

Varin additionally requires separate Pi/Varin product identities, cross-process services,
multiple browser execution modes, authenticated remote assets, trust/capability mediation,
workbench contribution semantics, multi-Surface state, layout/profile persistence, and
session/agent/model-aware routing.

The public Varin contracts therefore remain implementation-neutral. A later prototype may compare
Cordis with a Varin-owned supervisor behind those contracts. Adoption is based on observable
lifecycle correctness, maintenance cost, runtime impact, and fit with cross-process invariants—not
the popularity of the current technology.

## 24. Settled decisions and remaining design work

Settled by this design:

- Pi packages and Varin extensions are separate systems.
- The default Varin product is a distribution of replaceable built-in extensions above a narrow
  recovery kernel.
- Deep UI customization includes alternative pages, workflows, renderers, and workbench shells.
- Dynamic disable guarantees vary honestly by declarative, managed, isolated, and trusted-native
  execution mode.
- The core SDK is framework neutral; React support is an adapter.
- Desired state is application-host authoritative; actual state is reported per entrypoint/realm.
- Native/plugin data remains authoritative and is not mirrored to make a GUI easier.
- Cordis is a reference, not a dependency or public abstraction.

The pre-release implementation decisions are resolved in the public contract and owning runtimes:
the manifest and identifier grammar are versioned
in `@varin/extension-contract`; assets are authenticated and content addressed; capability decisions
are version- and realm-bound; workbench profiles and service routing have revisioned scope models;
built-ins use ordinary contribution owners; and brokered Host entrypoints use a supervisor-owned Node
child process while trusted-native Host code keeps explicit restart semantics.
