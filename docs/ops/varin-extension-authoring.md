# Authoring Varin extensions

Varin extensions customize the Application Host and workbench and contribute services (tools, model
protocols, context hooks, run drivers, event sources, shells, editors) to the native Agent runtime.
This guide covers the public authoring path—no imports from `packages/ui`, private React components,
or a Varin source checkout are required.

Related references: [architecture & runtime composition](../extensions.md) ·
[SDK reference](../../packages/extension-sdk/README.md) ·
[contract reference](../../packages/extension-contract/README.md) ·
[working examples](../../examples/extensions/README.md).

## Authoring packages

| Package | Use |
| --- | --- |
| `@varin/extension-contract` | Browser-safe manifest, contribution, service, routing, workbench, and discovery DTOs + JSON schemas |
| `@varin/extension-sdk` | Framework-neutral managed, isolated, and Host activation contexts & provider helpers |
| `@varin/extension-sdk/testing` | Surface, isolated-realm, and brokered-Host lifecycle conformance harnesses |
| `@varin/extension-surface` | Surface owner lifecycle and registry substrate for advanced tests or alternate hosts |
| `@varin/extension-react` | Optional React 19 adapter (React is not part of the core contract) |
| `@varin/extension-cli` | `init`, `check`, `build`, `test`, and `release` author CLI |

These packages form the AGPL-3.0-only authoring distribution.

## Create a project

```sh
npx @varin/extension-cli init ./my-extension \
  --id dev.example.my-extension \
  --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

`init` is non-interactive and refuses to overwrite non-empty directories. Optional `--template` values:

| Template | Generates |
| --- | --- |
| `surface` | Interactive counter beside the conversation composer using `defineSurfaceMount` |
| `shell` | Framework-neutral `workbench.shell` replacement using `defineShellMount` |
| `editor` | Custom resource editor matched by language or filename |
| `view` | Sidebar view on `workbench.primary-sidebar.views` |
| `language` | Brokered Host language provider (`defineLanguageProvider` + `runtime/` starter) |
| `debug` | Brokered Host debug adapter (`defineDebugAdapter` + `runtime/` starter) |
| `test` | Brokered Host Node test provider (`defineTestProvider`, `kind: "node-test"`) |

Shell, editor, and view templates import only `@varin/extension-sdk` and `@varin/extension-contract`.
Documents, terminals, and sessions remain in Core even when a custom Shell redraws all chrome.

## Manifest authority & build mapping

`varin.extension.json` is the authoritative package contract (`package.json` holds npm metadata and
must match `version`). The parser in `@varin/extension-contract` is the runtime authority across
npm, Git, local directories, and built-ins; a source string or display name is never extension
identity.

```json
{
  "$schema": "https://raw.githubusercontent.com/Astrmira/Varin/main/packages/extension-contract/schema/varin.extension.schema.json",
  "schemaVersion": 1,
  "id": "dev.example.memory-workbench",
  "displayName": "Memory Workbench",
  "version": "1.2.0",
  "engines": { "varin": "*" },
  "metadata": {
    "description": "A custom memory workspace",
    "homepage": "https://example.dev/memory-workbench",
    "repository": "https://github.com/example/memory-workbench",
    "icon": "assets/icon.svg",
    "keywords": ["memory", "workspace"]
  },
  "entrypoints": {
    "host": { "file": "dist/host.cjs", "mode": "brokered", "activation": ["service-request"] },
    "surfaces": [
      { "id": "dev.example.memory-workbench.main", "file": "dist/surface.cjs", "mode": "managed", "supports": ["desktop", "mobile", "web"] }
    ]
  },
  "provides": { "services": [{ "id": "dev.example.memory", "version": 1, "multiple": true }] },
  "capabilities": { "host": ["extension-storage"], "surface": ["notifications"] },
  "storage": { "schemaVersion": 1 }
}
```

- **Identifiers & paths**: Manifest, entrypoint, contribution, and service IDs are lowercase
  namespaced identifiers; contribution IDs must be qualified by the extension ID. Entrypoint files
  are forward-slash relative paths that cannot escape the package.
- **Dependencies**: Declare service dependencies in `requires.services` with explicit `realms`
  (`["host"]`, `["surface"]`, or both). The retired `integrates` field is rejected; discovery
  metadata never grants capability access.
- **Build mapping**: Map entrypoint IDs to sources in `package.json`:

```json
{
  "varin": {
    "build": {
      "entrypoints": {
        "host": { "source": "src/host.ts" },
        "dev.example.my-extension.main": { "source": "src/surface.ts" }
      }
    }
  }
}
```

  `varin-extension build` bundles Host code for Node 22 and Surface modules for ES2022 browsers,
  never runs lifecycle scripts, and selects CJS/ESM from `.cjs`/`.mjs` (else `package.json.type`).
  List extra runtime assets (such as `runtime/`) in `package.json.files`.

## Execution modes & activation

| Realm | Mode | Behavior & isolation boundary |
| --- | --- | --- |
| Surface | `declarative` | Manifest-only discovery descriptors; no JS executes (does not synthesize views/commands). |
| Surface | `managed` | Framework-neutral bundle in the Surface realm; Varin tracks SDK registrations; raw browser effects need explicit disposers. |
| Surface | `isolated` | Host-materialized IIFE in a sandboxed iframe/Worker over a versioned MessagePort; no ambient DOM/network; realm destroy = physical unload. |
| Surface | `native` | Explicitly trusted same-realm code; failed cleanup becomes `restart-required`. |
| Host | `brokered` | Supervisor-owned Node process using capability/service/storage RPC (crash/lifecycle isolation, **not** an OS sandbox). |
| Host | `native` | Explicitly trusted Application Host code; updates require clean restart and cleanup is cooperative. |

- **Activation events**: Manifest contributions index without running code. Entrypoints with no
  `activation` list, `application-startup`, or `background` start eagerly; `command`,
  `contribution-visible`, `workspace-match`, and `service-request` stay inactive until triggered.
  Disabling clears the trigger latch.
- **Capability grants**: Recorded per manifest version and realm. First installs requesting
  capabilities—and candidates adding capabilities—stay blocked until every request has an explicit
  allow/deny decision (a denial still completes review). See
  [trust model](../extensions.md#identity-artifacts--trust-model).

## Surface & Workbench SDK

`@varin/extension-sdk` re-exports workbench targets, slots, context keys, and profile IDs
(`default`, `varin.ide`). Managed/native registrations are staged and published atomically per owner
generation, then withdrawn before reverse-order cleanup; stale generations cannot publish.

### Managed & isolated Surface entrypoints

```ts
import { defineSurfaceExtension, defineSurfaceMount } from "@varin/extension-sdk"

export default defineSurfaceExtension((context) => {
  context.contribute({
    contractVersion: 1, data: {}, id: "dev.example.my-extension.page",
    kind: "page", supports: ["desktop", "mobile", "web"], title: "My Page",
  }, defineSurfaceMount((container, mount) => {
    container.textContent = String(mount.props.title ?? "My Page")
    return () => { container.textContent = "" }
  }))
  context.onDispose(() => stopExternalBrowserEffect())
})
```

`defineSurfaceMount` receives `(container, mount)` (`HTMLElement`, props, owner generation,
`AbortSignal`, `reportError`) and returns a sync/async disposer invoked once on prop/generation
change, withdrawal, or disable. Isolated extensions use `defineIsolatedExtension(context => ...)`
and call capabilities/services via `context.capabilities.has(...)` / `.call(...)`.

Optional `@varin/extension-react` wraps the same mount contract (`defineReactShell`,
`defineReactView`, `defineReactEditor`, `defineReactSettingsPage`, `defineReactMessageRenderer`,
`defineReactToolRenderer`, `defineReactSessionDecoration`) with extension-owned React roots (never
sharing Varin's React singleton). `defineReactShell` provides `VarinWorkbenchCompositionHost` via
`useWorkbenchCompositionHost()` for mounting declared seams with JSON-safe props (not available in
isolated iframe/Worker Shells in v1).

### Settings, commands & conversation presentation

| Contribution | SDK helper | Product location & notes |
| --- | --- | --- |
| `settings-page` | `defineSettingsPageMount` | Settings nav (`data.slug`, literal `data.title`, optional `group`/`kind`/`keywords`/`primary`). `kind: "split"` mounts separate `sidebar`/`content` instances (keep shared state in the extension). |
| `command` | `defineCommand` | Command palette (literal `data.title`, optional `keywords`); execution ID = contribution ID; receives `{ currentDirectory, isMobile }`; optional `isAvailable`. |
| `message-renderer` | `defineMessageRenderer` | `VARIN_CONVERSATION_SLOTS.messages` (`matches` + `mount`, props `VarinMessageRendererPropsV1`) |
| `tool-renderer` | `defineToolRenderer` | `VARIN_CONVERSATION_SLOTS.tools` (`matches` + `mount`, props `VarinToolRendererPropsV1`) |
| `session-decoration` | `defineSessionDecoration` | `VARIN_CONVERSATION_SLOTS.sessionDecorations` (`matches` + `mount`, props `VarinSessionDecorationPropsV1`) |
| `composer-action` | `defineSurfaceMount` | `VARIN_CONVERSATION_SLOTS.composerLeading` / `composerTrailing` |

```ts
import { defineToolRenderer } from "@varin/extension-sdk"

export const lookupRenderer = defineToolRenderer({
  matches: (input) => input.call.name === "dev.example.notes.lookup",
  mount(container, mount) {
    container.textContent = mount.props.result ? "Lookup finished" : "Looking up notes…"
    return () => container.replaceChildren()
  },
})
```

- Renderer `matches` and `mount` receive detached, read-only JSON snapshots (presentation only, not
  execution/cancellation). Callable command/matcher contracts are same-realm only (not serialized
  over an isolated MessagePort).
- **Consumer boundaries**: `keybinding`, `menu-item`, `sidebar`, `status-item`, and unhosted `page`
  contributions currently have no dedicated product consumer. `varin-extension check` surfaces these
  as nonfatal `authorDiagnostics`.

### Shell seams & Transition Scene

- A `shell` contribution declares `VarinWorkbenchShellContributionDataV1` listing supported
  replacement targets and slots per surface (validated at parse time). The six IDE structural
  targets (`workbench.activity`, `workbench.primary-sidebar`, `workbench.editor`,
  `workbench.secondary-sidebar`, `workbench.panel`, `workbench.status`) are real
  `WorkbenchReplacement` hosts; `editorActions` and `panelViews` receive JSON-safe props from
  `@varin/extension-contract`.
- A `transition-scene` contribution replaces `workbench.transition` using
  `contract: "varin-transition-scene/v1"` with declared `scenes` and `durations` (`quick`,
  `standard`, `reduced`; `0` = immediate). Managed mounts use `defineTransitionSceneMount`,
  subscribe to `mount.props.transition` (`getSnapshot()`, `subscribe()`), and may call
  `transition.complete(transitionId, phase)` early; otherwise Varin advances at the declared
  duration. Core owns profile persistence, Shell handoff, and rollback; see
  [workbench transitions](../workbench.md#profiles-shells--visual-transitions).

### Custom editors & optional Monaco service

- **`editor` contributions** declare `data.languageIds` or `data.filenames` (optional finite
  `data.priority`, no slot). `defineEditorMount` receives `mount.props.document` (Varin keeps
  buffer, dirty state, conflicts, recovery journal, and disk revision authoritative). Use
  zero-based UTF-16 `applyEdits`:

```ts
const snapshot = mount.props.document.getSnapshot()
const result = await mount.props.document.applyEdits(
  [{ from: 0, to: 4, insert: "Varin" }],
  snapshot.documentVersion,
)
// Handle result.status: "applied" | "stale" | "conflict" | "invalid-range" | "overlapping-ranges" | "unsupported"
```

  `replaceContent(content, expectedDocumentVersion)` is available for simple editors. Isolated
  iframe editors receive a `VarinIsolatedEditorMountMessage` over `varin-message` and use granted
  `workspace.documents` with both `expectedRevision` and `expectedDocumentVersion`.
- **Optional Monaco service (`varin.editor.monaco@1`)**: Declare as optional in `requires.services`
  (`realms: ["surface"]`) and use `createVarinEditorMonacoClient(context)` in managed or isolated
  mode. Exposes only serializable active-view snapshots, selection/range, focus/reveal/action, and
  owner-scoped declarative decorations (`ready` | `absent` | `stale` | `unsupported`), plus
  `getState()` / `waitForState({ afterRevision })` without polling. Never exposes raw Monaco
  editors/models, DOM nodes, callbacks, or `RuntimeAPIs`.

### Context expressions (`when`) & compatibility

Contributions (except `shell` and `transition-scene`, rejected at parse time) may declare
`VarinContextExpressionV1` visibility predicates:

| Operator | Fields | Semantics |
| --- | --- | --- |
| `defined` | `key` | True when key exists |
| `equals` | `key`, `value` | True when key exists and strictly equals `value` |
| `not` | `expression` | Negates inner expression |
| `all` / `any` | `expressions` | Conjunction (empty = true) / disjunction (empty = false) |

Publish custom keys via `context.context.set("ready", true)` (or `await` in isolated mode) and
reference them as `<extensionId>.ready` in `when`. Candidate writes stay hidden until commit and
stale writers return `false`. Unknown contribution `contractVersion` values parse for catalog
retention but report `unsupported-contract-version` in Surfaces and fail `varin-extension check` as
`incompatibleContributions`.

## Host entrypoints, storage, tools & native hooks

```ts
import { defineHostExtension } from "@varin/extension-sdk"

export default defineHostExtension(async (context) => {
  context.services.provide(
    { id: "dev.example.my-service", version: 1, multiple: true },
    { read: async ([path], call) => readFile(path, { signal: call.signal }) },
  )
  const doc = await context.storage.open({ scope: "workspace", key: "settings", schemaVersion: 1 })
  await doc.update({ started: true }, doc.snapshot.revision)
  context.effect(() => stopOwnedHostResource())
})
```

- **Invocation context & assets**: Host service handlers receive `(args, call)` with `call.callId`
  and cooperative `call.signal`. Resolve packaged executables via
  `context.assets.path("runtime/server.mjs")` (immutable selected artifact, package-contained).
  Workspace clients (`createWorkspaceDocumentsClient`, `createWorkspaceLanguageClient`,
  `defineLanguageProvider`, `defineDebugAdapter`, `defineTestProvider`) run Host-side only; see
  [SDK reference](../../packages/extension-sdk/README.md).
- **Storage**: `context.storage.open({ scope, key, schemaVersion? })` opens revision-checked
  documents scoped to the injected extension ID (`application`, `profile`, `workspace`, `surface`,
  `session` are organizational labels, not permission boundaries—embed entity IDs in `key`).
  Manifest `storage.schemaVersion` + `migrate(...)` applies only to the `application/state`
  compatibility document; transform other documents explicitly on read/update.
- **Service bindings**: `requires.services` supports `binding: "single"` (exactly one compatible
  provider), `"selected"` (persisted scoped routing resolver), and `"all"` (`context.services.useAll`
  / Surface `useServices`). Preparation pins exact generations so in-flight calls never switch
  implementations.
- **Host tool services**: Register with `provideTool(context, declaration, execute)` reusing the
  manifest service descriptor (`name`, `description`, input/output JSON Schemas, `completion: result
  | job`, `operation: read | effect`, optional `lifetime`, `requirements: { source?, process? }`,
  `disclosure`). `call.output` (ordered Result text/media parts) and `call.tools` (frozen-directory
  nested calls) require reviewed Host `runtime.tools`. See
  [SDK tool contract](../../packages/extension-sdk/README.md) and
  [nested-tools example](../../examples/extensions/nested-tools/README.md).
- **Native Agent policy (`varin.agent.policy@4`)**: Implement with `provideAgentPolicy` and select
  via scoped service routing. Policies request models, settle tool exchanges, submit `tool_graph`s,
  read committed result chunks (`read_result` with `format: "output_body" | "model_evidence"`), and
  `deliver({ data, parts })`. For auxiliary planning, declare `capabilities: ['agentPlanning']`
  (global Harness slot owns model selection) and return `request_model_job` using admitted
  `model_capabilities`; `decide()` must never perform direct model/network calls. See
  [evidence-policy](../../examples/extensions/evidence-policy/README.md) and
  [planning-policy](../../examples/extensions/planning-policy/README.md).
- **Other native hooks**: For replaceable Run drivers (`varin.agent.driver@1`), custom model
  protocols (`varin.models@1`), context fragments/budget/compaction (`varin.context.*`), and durable
  inbound event sources (`varin.events`), see the
  [SDK reference](../../packages/extension-sdk/README.md) and
  [contract reference](../../packages/extension-contract/README.md).

## Native retrieval plans

`code_retrieval` is a native background Agent using ordinary model, tool, source, context, and
Operation owners. It does not consume `varin.retrieval.plan@1`, and the former staged retrieval
packages are no longer distributed.

`provideRetrievalPlan` and `varin.retrieval.plan@1` remain deprecated compatibility exports for
existing packages and explicit custom consumers; saved routing rules remain inspectable and
unresolved rather than silently remapped. Extend retrieval through ordinary tool, policy, and
context contracts; see [retrieval ownership](../retrieval.md).

## Runtime contract discovery

- **Tool discovery & invocation**: Common tools are declared directly; additional docs use native
  `tool_describe` (`{}`, `{ "namespace": "development" }`, `{ "name": "runtime_contract" }`), and
  undeclared tools execute via `tool_invoke({ name, arguments })` against the Run's frozen directory
  and permissions (SDK callers use `call.tools.list/describe/invoke`).
- **Disclosure paths**: Tools may supply `disclosure: { summary, aliases?, namespace?, operations? }`
  pointing into existing `oneOf`/`anyOf` or `$defs` branches (e.g., `/oneOf/0`,
  `/$defs/content/oneOf/1`) without replacing the validator schema. Full descriptions page via
  `next`, and oversized contracts provide an explicit `path` reader.
- **`runtime_contract` tool** (current-catalog & source views; never grants invocation or warms cold
  providers):
  - `{ "action": "list", "kind": "service" }` — lists current declarations and preparation facts.
  - `{ "action": "describe", "kind": "service", "serviceId": "varin.context.fragments", "version": 1, "member": { "kind": "method", "name": "describe" } }` — describes a method or `event` schema (`extensionId` disambiguates).
  - `{ "action": "describe", "kind": "ui_slot", "id": "workbench.editor.actions" }` — reads slot props schema (separating Shell hosting declarations from `live: "unobserved"`).
- **Client API**: Authenticated clients call
  `RuntimeAPIs.extensions.queryContracts(request, { directory?, surface? })` (exact DTOs in
  `packages/application-client`).
- **Declaring service contracts**: Include `contract: { methods, events?, participation? }` in the
  service provision (methods carry `inputSchema`, `outputSchema`, optional description/examples, and
  package-relative `source: { path, line? }`; events carry schema + optional source). Import the
  same descriptor at activation; undeclared owners report `undeclared`.

## Host credentials for connected services

Declare the `varin.credentials` Host capability, store nonsecret connection config in plugin
storage, and access secrets only inside authenticated Host service invocations:

- **Scoped access**: Call `credentials(call.capabilities, connectionId, expectedAccount?)` and
  `credentialNamespace(call.capabilities)` (stable plugin-specific user namespace for nonsecret
  plugin storage). The Host derives the user from the Surface lease or original Agent Run—never from
  activation-time clients, unauthenticated calls, or caller-supplied user IDs.
- **Operations**: `put`, `inspect` (returns safe metadata including `account`; store it and pass as
  `expectedAccount` so replacement invalidates stale selections), `resolve` (Host-only secret—never
  forward to Surface, tool results, model context, or logs), `remove`, and authorization
  `start`/`read`/`reply`/`cancel`.
- **OAuth `authenticate` method**: Provide `authenticate` on a Host service in the same extension
  entrypoint and **first** `await assertCredentialAuthentication(call.capabilities)` before reading
  config, processing arguments, or returning state/tokens (do not expose an unguarded alternate RPC).
  Pass `{ serviceId, version, provider }` to `start`/`resolve`. Handle the
  `VarinCredentialAuthenticationCall` union (`begin`, `complete`, `refresh`); device codes reuse the
  Host authorization interaction. The Host pins the service generation, merges concurrent refreshes,
  and rejects stale completions.
- **Adapter ownership & lifecycle**: Your adapter owns OAuth app config, state/PKCE verification,
  callback/loopback handling, request signing, and remote revocation. Local deletion ≠ remote
  revocation; uninstall-with-data-deletion removes the extension's Host credential namespace. Single-owner
  Host login (password/passkey/pairing) is unchanged.

## Check, test & Extension Inspector

```sh
varin-extension check   # Manifest, versions, path containment, entrypoint files
varin-extension build   # Bundle Host (Node 22) and Surface (ES2022)
varin-extension test    # Rebuild + run public conformance harnesses
```

- All four CLI commands (`init`, `check`, `build`, `test`) accept `--quiet` and `--json` with
  non-zero exit codes on failure. `check --json` reports `incompatibleContributions`, `missingFiles`,
  `referencedFiles`, and nonfatal `authorDiagnostics`.
- `test` runs managed/native Surface (activation, commit, disposal, leak detection), isolated
  Surface, and Host activation/storage/abort harnesses in-process (not a real broker/Host; required
  Host dependencies or privileged capabilities require calling `@varin/extension-sdk/testing`
  directly). Editor authors can also run `runEditorExtensionConformance`.
- **Extension Inspector** displays selected/candidate artifacts, realm generations/cleanup status,
  manifest & live contributions, active Shell & dormant Profile selections, document/language/debug/test
  ownership, live service providers, optional Monaco registration counts, capability decisions, and
  attributed diagnostics—never scraping private DBs, credentials, or conversation content.

## Install, updates, lifecycle & profiles

- **Settings → Plugins**: Supports **Discover**, **Installed**, direct install (GitHub Releases,
  npm, Git, local folders, imported archives), and pasted public install links. Local folders build
  immutable artifacts without modifying the working tree (run `npm install` in the project first;
  Varin never runs it). Use **Reload local directory** to stage changed local code as a candidate.
- **Code trust & grants**: Release previews inspect immutable bytes without running code and always
  install disabled. Advanced dev installs without capability requests enable on first install;
  capability requests stay disabled until reviewed. Mutations bind to their reviewed Host, artifact,
  and catalog revision. External sources cannot overwrite built-in IDs.
- **Candidate updates**:
  1. Host validates manifest, engine range, integrity, and capability delta.
  2. Added capabilities require explicit decisions in Extensions.
  3. **Apply update** confirms identity and prepares new generations; **Discard update** removes
     the candidate.
  4. Opt into coordinated Host+Surface readiness with `updateReadiness: { surfaceEntrypoints: ["panel"] }`.
     Enabled trusted-native Host updates require **Restart and apply** (durable restart handoff).
     See [candidate updates & rollout](../extensions.md#activation-candidate-updates--rollout).
- **Disable, remove & profiles**: Disabling reconciles generations while keeping storage, routing,
  and artifacts. Removal defaults to **retain data**; **delete extension data** removes only that
  extension's Varin storage & credential namespace (never workspace/project files). Workbench
  profiles store layout + `extensionIds`; **Apply set** reconciles via one revision-checked catalog
  mutation (see [profiles & shell switching](../workbench.md#profiles-shells--visual-transitions)).

## Prebuilt release delivery & discovery catalogs

- **GitHub Releases**:

```sh
varin-extension release ./my-extension --output ./release --platform any --arch any
```

  Writes a `package/` `.tar.gz` and SHA-256-bound `varin.release.json` (default tag `v<version>`;
  multi-series repos support `owner/repository#stable?tagPrefix=weather-v&manifest=weather.release.json`).
  See [CLI release workflow](../../packages/extension-cli/README.md#release-packages). List runtime
  files in `package.json.files` (links, traversal, `.git`, `.env*`, and `node_modules` are excluded).
- **npm delivery**: Reads registry metadata and integrity-pinned tarballs directly without an npm
  CLI on the Host (`engines.varin` aids metadata selection; selectors accept dist-tags or SemVer
  ranges like `@example/weather@>=1.0.0 <2.0.0`). Confirming a preview installs those exact bytes,
  never re-resolving `latest`.
- **Optional discovery catalogs**: Validated by `parseVarinExtensionDiscoveryDocument` and
  `@varin/extension-contract/schema/discovery` (ETag-cached HTTPS JSON; listings grant no trust and
  never overwrite saved sources). Official catalog:
  [Astrmira/Varin-plugins](https://github.com/Astrmira/Varin-plugins).

```json
{
  "schemaVersion": 1,
  "entries": [{
    "id": "dev.example.my-extension", "displayName": "My Extension",
    "description": "A custom workspace extension", "author": "Example",
    "categories": ["Workspace"], "icon": "../assets/my-extension.svg",
    "repository": "https://github.com/example/my-extension",
    "source": { "kind": "npm", "display": "@example/varin-my-extension", "specifier": "@example/varin-my-extension" }
  }]
}
```

## Publishing checklist

1. Keep `package.json` and `varin.extension.json` versions identical.
2. Declare only capabilities the entrypoints actually call.
3. Bundle framework dependencies; never depend on Varin's React or internal packages.
4. Ship `varin.extension.json`, built entrypoints, styles, and referenced assets in the package.
5. Run `varin-extension test` plus your extension's own UI/integration tests.
6. Test installation in a clean Application Host across every declared Surface.
7. Stage an update and verify both **Apply update** and **Discard update** before publishing.

## Varin public tooling releases (maintainers)

Maintainers publish the five public authoring packages (`extension-contract`, `extension-surface`,
`extension-sdk`, `extension-react`, `extension-cli`) as one exact-version set:

```sh
bun run release:npm:prepare 0.2.0
# review & commit on main, then tag:
git tag -a npm-v0.2.0 -m "Publish Varin npm tooling 0.2.0"
git push origin npm-v0.2.0
```

`.github/workflows/npm-publish.yml` accepts only `npm-v*` tags on `main`, builds/tests/packs and
smoke-installs tarballs in a disposable project, and publishes in dependency order using npm Trusted
Publishing via GitHub OIDC (`Astrmira/Varin`, no `NPM_TOKEN` or environment gate; reruns skip only
identical integrity digests and fail closed on mismatch).
