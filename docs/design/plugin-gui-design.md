# Pi ecosystem GUI design

Status: implemented; this is the ownership contract adapters are held to

Last updated: 2026-09-15

## 1. Purpose

Varin gives frequently used Pi packages a first-class graphical experience without becoming a
second package runtime or configuration authority. This document fixes the page boundaries,
provider ownership, and acceptance criteria used to retire the imported OpenChamber pages.

The old Magic Context, OpenAgent, and Agent Orchestration pages are historical capability clues.
They are not interaction or data-model templates: they predate the current packages, omit current
settings, and encode OpenCode-era assumptions. New screens are derived from the installed Pi
package's current schema, commands, public events, and documented lifecycle.

## 2. Product rules

1. **Native files remain authoritative.** Pi settings, package manifests, extension JSON/JSONC,
   session JSONL, extension databases, and extension artifacts are not mirrored into a Varin
   store.
2. **A GUI adapter is a view, not a reduced replacement schema.** It edits well-understood native
   keys and preserves every unknown key. A raw JSON/JSONC editor remains available for the complete
   document.
3. **Package configuration wins.** The Agents catalog may provide common discovery and lifecycle
   actions, but a provider-specific editor takes precedence over generic fields.
4. **Runtime actions require a public contract.** Varin may call registered Pi commands, a
   documented event-bus bridge, or a versioned extension contract. It does not scrape terminal
   text, inspect private databases, or infer success from private files.
5. **Configured and active are different states.** A package can be present in user/project
   settings but not loaded in the current session. Every adapter shows scope, source, active state,
   and actionable diagnostics separately.
6. **No pre-release compatibility stack.** All Varin surfaces use the single protocol v1 and
   change in lockstep. There are no legacy request aliases or version branches.
7. **Risk is explained where the action occurs.** Destructive repair, history navigation, remote
   bind, cookie access, executable configuration, and credential sources receive focused warnings;
   ordinary settings are not hidden behind blanket restrictions.

### 2.1 Pi packages versus Varin extensions

This document describes graphical integration for Pi packages. It does not make those packages
Varin extensions. Pi packages remain owned by Pi's `PackageManager` and extension runner; the
future Varin extension platform has a separate application-host manager, lifecycle, manifest,
state, and Surface contribution model.

The current first-class adapters are built into Varin. During the migration defined by
[varin-extension-platform.md](varin-extension-platform.md), they may become built-in Varin
integration extensions that consume the same public Pi contracts. Disabling such a UI integration
must not disable, remove, reconfigure, or take ownership of its Pi package, and changing the Pi
package must not silently mutate the Varin extension's installation or layout state.

## 3. Information architecture

| Surface | Responsibility | Must not own |
| --- | --- | --- |
| Pi Packages | Install, enable, disable, update, remove, scope, source, version, reload state | Extension-specific configuration |
| Plugin Settings | First-class GUI adapters plus advanced native document editing | Package installation semantics or copied plugin state |
| Agents | Unified provider catalog and provider-advertised lifecycle actions | A universal agent schema that overrides providers |
| Fleet | Live and recent delegated work, task graph, controls, artifacts | Agent definitions or terminal-text parsing |
| Commands | Read-only live slash-command catalog and provenance | A second command registry |
| Prompts | Pi-native `.md` prompt templates through the resource loader | OpenCode command files or extension commands |
| Skills | Pi resource discovery/management when supported by the loader | An OpenCode skills store |
| Recovery sidebar | Current-session health, undo/redo/checkpoints/repair | Workspace snapshot storage |
| Recovery settings | Default rollback policy, package/configuration entry points | Per-message rollback itself |

An unknown package remains usable through Pi's generic extension UI bridge. If Varin does not
have a specialized adapter, Plugin Settings opens its declared or user-selected native JSON/JSONC
document rather than fabricating common fields.

The current catalog surfaces follow those boundaries directly:

- Pi Packages distinguishes a configured source from a source that is actually present on disk,
  shows its resolved path and whether Pi stores a structured package entry, and links to Plugin
  Settings. Its package switch disables every Pi resource type from that source while retaining the
  installed files, native configuration, and any existing resource filters for exact restoration.
  Pi's update operation is
  truthfully described as source-wide across user and project scopes; the scope selector applies to
  installation and removal, not to a fictional scoped update implementation.
- Pi Packages also presents the four global foundational integrations maintained by Varin: MCP,
  permission policy, workspace history, and prompt repair. Missing items are installed in the
  background on first observation, but they remain normal Pi packages with the same enable, disable,
  update, configuration, and removal controls. User removal is sticky until Restore; an existing
  disabled item is never treated as missing; a configured source with missing files is diagnosed
  instead of overwritten. Foundational items do not also appear in Recommended Integrations.
  “Automatically add future foundational integrations” applies only to entries added by later
  manifest revisions and does not update, enable, or reinstall current entries.
- Commands projects each extension, prompt, or skill command's native source path, scope, origin,
  source identifier, and prompt argument hint. It remains read-only and links resource commands to
  Prompts or Skills instead of editing them in place.
- Prompts renders the filename-derived `/command` invocation and native `argument-hint` while all
  Markdown/frontmatter parsing, collision decisions, package read-only state, and project trust
  remain owned by Pi's resource loader.
- Agents displays provider/source/package/invocation facts and calls only provider-advertised
  actions. A missing model is labelled as a provider default or unreported value, never guessed to
  be an inherited common setting.
- The composer, command picker, inline skill picker, sent-message links, and skill activity rows
  share one runtime/session/workspace-keyed Pi catalog. Callable skills use Pi's native
  `/skill:name` invocation; the editable resource catalog enriches them with file and scope data
  but never creates a second command registry. Successful skill/package/plugin-configuration
  mutations and `/reload` invalidate that catalog at their host-success boundary.

### 3.1 Retired-page capability disposition

The removed screens are represented here by capability, rather than kept as dormant source code
that can accidentally become a second configuration system.

| Retired surface | Useful capability clue | Varin disposition |
| --- | --- | --- |
| Magic Context | Compression thresholds, memory/search, embeddings, SQLite, internal agents, fallbacks, and Dreamer schedules | Implemented in the current schema-driven Magic Context adapter with separate user/project documents and Advanced JSONC. |
| Magic Context | Runtime status, diagnostics, memory inspection, recompression, wrap-up, dream, augmentation, and embedding actions | Current registered `ctx-*` commands are integrated as provider-owned session operations, including focused cost/maintenance confirmation and persisted public result entries. Private database inspection still waits for an explicit public contract. |
| Magic Context | OpenCode plugin registration, OpenCode TUI sidebar, and Oh My OpenAgent hook-conflict diagnostics | Rejected as OpenCode-only behavior. Pi package health is derived from Pi package/runtime contracts instead. |
| OpenAgent | Agent/category model routing, fallback chains, hook toggles, team/background task, Tmux, skills, MCP, and experimental settings | Rejected as a generic Varin schema because these were fields of the unrelated Oh My OpenAgent OpenCode plugin. A future Pi package receives its own adapter only from its current native schema. |
| OpenAgent | Discovering agents, showing defaults/source, and invoking lifecycle actions | Implemented by the provider-owned Agents catalog. Provider configuration remains higher priority than generic catalog presentation. |
| OpenCode agent editor | Generic agent create/rename/duplicate controls and a shared OpenCode permission-map editor | Rejected from the Pi catalog. Definitions and permissions are mutated only through provider-advertised actions, a specialized package adapter, or that package's native configuration document. |
| OpenCode Commands, Skills, and external Skills Catalog stores | Slash completion, inline skill links, command dispatch, resource editing, supporting files, and catalog installation | Callable/resource behavior is replaced by Pi `command.list`, `resource.list/get/create/update/delete/copy`, and Pi Packages. The client accepts only native `/skill:name`; old `/name` aliases, OpenCode CRUD/catalog endpoints, duplicate persisted selections, and browser debug globals are retired. The unused private supporting-file editor is not carried forward: Varin will add it only through a native Pi resource contract, not by restoring OpenCode HTTP paths. |
| Agent Orchestration | Switching among native OpenCode, oh-my-opencode-slim, and oh-my-openagent modes | Rejected. Varin has one Pi runtime and does not retain an OpenCode orchestration-mode compatibility layer. |
| Agent Orchestration | Provider discovery, presets, model policy, fallback, runtime limits, and feature controls | Discovery/actions live in Agents; settings belong to the contributing Pi package adapter or its native JSON/JSONC document. No shared form fabricates unsupported fields. |

The cleanup removes only the unreachable OpenCode pages, their private HTTP stores, their schema
normalizers, and tests/translations that existed solely for those pages. It deliberately retains
the Pi-native Agents provider registry, Plugin Settings adapters, Prompts and Skills resource
pages, generic extension UI bridge, and the target-keyed Pi runtime catalog used by chat.

## 4. Shared adapter shell

Every first-class adapter uses the same frame:

- identity: display name, package source, installed version, configured scope, and active session;
- observation: package installation and current-session evidence are separate; `no session`,
  `not observed`, `available`, and probe failure are not collapsed into a guessed health state;
- scope: user and project documents are visibly distinct, including precedence and conflicts;
- changes: dirty state, validation diagnostics, reload requirement, atomic save, and revision
  conflict handling;
- navigation: focused sections for common settings and an Advanced section for the complete native
  document;
- runtime actions: enabled only when the active provider advertises them;
- provenance: inherited/effective values show their source when the extension exposes it.

The shell never writes a default just because a form rendered it. Unchanged native keys remain
absent, so future plugin defaults and migrations continue to work.

### 4.1 Quick configuration and native-document editing

The default adapter view is a task-oriented quick configuration layer, not a schema dump. A native
property path may appear as secondary provenance or in the Advanced editor, but it is never the
primary label of an ordinary control. Controls use user outcomes such as “Default model”, “Search
strategy”, and “Sessions kept per workspace”. Low-level tuning is not promoted merely because its
schema is known.

Structured controls and Advanced editing of the same source share one draft, revision, validation
state, and Save action. An adapter must not load a second raw draft that can overwrite unsaved form
changes. Text-backed JSONC documents retain comments, trailing commas, formatting outside the
edited path, and unknown keys. Object-scoped settings retain unknown values through their native
host update API; the renderer does not claim to preserve comment syntax that API does not expose.
Invalid raw content disables structured controls while leaving Advanced available for repair.
Switching plugin, scope, or source keeps an independent mounted draft or requires the current draft
to be explicitly saved or discarded first.

Opened native authorities subscribe through the shared Pi runtime `config.watch` contract. The Host
resolves the same trusted root/path/symlink boundary used by the corresponding read and emits only
an invalidation; renderers never receive a filesystem watcher or an arbitrary path capability.
Clean drafts re-read the authority after an invalidation. Dirty drafts keep every local edit, mark
the external change visibly, and block saving until the user explicitly reloads the authority. Text
documents, object documents, and both settings scopes retain their loaded revision; every save sends
that value as `expectedRevision`, and the Host compares it while holding the write lock. The file
notification is therefore a refresh signal, not the concurrency boundary, and a race before an
invalidation is observed still fails as a conflict. A read or watch failure preserves the last valid draft,
while missing files remain distinct from present empty documents. Surface disconnect, runtime
replacement, target change, session close, and Host shutdown release their watches. A native
authority with ordered fallback filenames watches every candidate that can become authoritative,
not only the file selected by the last read.

Every selected adapter shows the package observation separately from its configuration authority:
the package source/version, active session or workspace target, current native document and scope,
dirty/invalid state, and the exact evidence for runtime availability. “Not observed” is not reported
as unhealthy, and an absent key in one layer is “not set in this source”, not a guessed effective
value.

| Adapter | Quick tasks | Native authority shown in the quick view | Advanced-only by default | Local warnings that remain visible |
| --- | --- | --- | --- | --- |
| pi-subagents | Agents and definition actions; per-scope model/provider/thinking/output overrides; delegation; review; limits | Provider actions/Agent Markdown, user/project `settings.json#subagents`, and global runtime `config.json` are three distinct save owners | per-agent model-scope maps, external runners, worktree/storage paths, Intercom, notification batching, detailed LSP/retry tuning, complex prompts and future runtime fields | definition versus override precedence, project trust, hard budgets and destructive provider actions |
| Magic Context | Context; memory; TodoWrite/Mural; internal models; maintenance schedules and session operations | Independent user/project JSONC drafts with ignored project keys reported | per-model maps, prompts/permissions, sampling fine-tuning, SQLite/Synapse details and future fields | fail-closed behavior, lossy compression, project-ignored keys, model-cost maintenance actions |
| pi-web-access | Search; all 0.24 providers and credential sources; Browser/Curator; summary/content/PDF limits; safety | Agent-root `web-search.json`; command presence is only loaded-state evidence | authenticated-fetch profiles, custom tool names, provider-specific fine tuning and future fields | executable credential sources, browser-cookie access, remote bind, fresh scraping and SSRF exceptions |
| pi-mcp-adapter | Runtime servers and actions; selected-source server overrides; behavior and interaction policy | One visibly selected source from the adapter-owned effective catalog; normal mode currently reports six precedence layers and exclusive mode one Pi source | bearer/OAuth details, complex output guards, tracing/filter details and future fields | URL credential reset, sampling auto-approval, socket trust and source-local versus effective state |
| pi-workspace-history | Protection and retention | Independent user/project `settings.json#workspaceHistory` drafts | scan budgets, Git timeout and future storage-engine tuning | lowering retention deletes old history; changing the storage directory does not migrate old history; home-directory capture |
| pi-wtf | Command words and the three generated command behaviors | Global `wtf.json`; previews are distinguished from commands currently loaded in a session | future plugin-owned fields | `!` rewrites session history and never restores file or external side effects |
| pi-openai-codex-compat | Codex request, reasoning, remote-compaction, apply-patch diagnostics and tool options | Independent global `openai-codex-compat.json` and trusted project `.pi/openai-codex-compat.json` drafts | unknown future plugin fields | absent keys stay unset; environment overrides remain plugin-owned |
| pi-observational-memory | Observation, reflection, compaction, pool and worker settings | Independent user/project `settings.json#observational-memory` drafts | unknown future plugin fields | invalid thresholds and incomplete worker models block save without rewriting the draft |
| pi-lens | Diagnostics; formatting and fixes; context delivery; project scale, rules, and security scans; native runtime actions | Resolved user authority (`PI_LENS_CONFIG_PATH` or `~/.pi-lens/config.json`) plus the nearest ordered project `.pi-lens.json` / `pi-lens.json` authority | future namespaces, detailed rule policies, LSP server maps and tool-specific tuning | project-ignored global keys stay visible, absent values remain unset, and native command availability is observed per session |
| @cortexkit/aft-pi | Editing mode; tool surface; search, semantic, call-graph, inspection deadlines, LSP, backup, sandbox, and GitHub routing-shim controls | Host-resolved CortexKit user `aft.jsonc` authority plus project `.cortexkit/aft.jsonc`; both are revisioned JSONC drafts | formatter/checker maps, server definitions, shell feature objects, transport, credentials, path lists, and future fields | invalid known fields block structured save; unknown fields and project-stripped fields stay visible and are preserved; runtime observation is command-only |
| pi-hermes-memory | Memory policy and limits; review; flush; capacity; correction/failure recall; session search and model overrides | Host-resolved global `hermes-memory-user` authority (`hermes-memory-config.json` under the active Pi agent directory) | `memoryDir`, custom policy text, child extension paths, four correction arrays, and future fields | unknown fields are preserved and non-blocking; modern overflow strategy takes precedence without deleting the legacy field; runtime observation is command-only |
| pi-rtk-optimizer | Rewrite/suggest behavior; missing-binary guard; notifications; output, read/source, and truncation controls | Strict JSON at global `<agentDir>/extensions/pi-rtk-optimizer/config.json` | removed rewrite categories, unknown future fields, and complex legacy shapes | missing fields remain absent; unknown and legacy fields are preserved; numeric controls use only native 40–4000 and 1000–200000 ranges; runtime presence is the exact `rtk` command, not binary availability |

Agent definitions and settings overrides are deliberately not one transaction. A definition action
may succeed while an unsaved override draft remains, or vice versa; the UI presents and reports
those operations separately. The same rule applies to immediate plugin commands versus saved
configuration: session actions never imply that a draft was persisted.

## 5. Adapter contracts

### 5.0 Context and memory package boundaries

`pi-openai-codex-compat` and `pi-observational-memory` are adapted only through their current native
configuration authorities. Varin does not assign compaction ownership, infer cross-plugin
priority, or add coexistence policy in this phase. `context-mode` remains available through the
generic installed-package editor because it does not expose one canonical user configuration
document suitable for a dedicated form. `pi-memory` is not a maintained adapter target.

### 5.1 pi-subagents

Authority:

- user/project Pi `settings.json` under `subagents`;
- `<agentDir>/extensions/subagent/config.json` for runtime behavior;
- `varin.agent-provider.discover/v1` and `subagents:rpc:v1:*` for definitions and actions;
- public lifecycle status/events/artifacts for active and recoverable tasks.

Target settings sections:

1. Agents: the real provider catalog, immediate create/edit definition actions, and a
   visibly separate user/project `agentOverrides` editor.
2. Delegation: scoped model/provider/thinking defaults, thinking ceiling, global and per-agent model
   scope policy, plus separately saved global spawn/wait behavior.
3. Review: watchdog activation, main/child review models, severity, and blocker follow-up.
4. Limits: global depth, spawn, concurrency, parallelism, and budget guardrails.
5. Advanced within each save owner: the complete scoped settings object or global runtime document,
   sharing the visible form's draft and Save action.

The current settings adapter discovers agents from the live `pi-subagents`
catalog, exposes provider-advertised create/update actions, and uses
the descriptor's runtime `name`—never Varin's opaque descriptor id—as the `agentOverrides` key.
The definition dialog's Advanced JSON is specifically the plugin's management-action config, not a
raw editor for Agent Markdown. It exposes only top-level fields accepted by the installed 0.55
management `create`/`update` contract. Unknown native frontmatter remains
plugin-owned and is not shown as editable JSON; normal updates preserve it through the plugin's
serializer. Manually adding an unsupported action key is rejected before dispatch instead of being
silently ignored. Removing a supported advanced key sends that field's plugin-defined clear or
default value, so a JSON edit cannot degrade into a misleading “no changes” response.

`pi-subagents` 0.55 removed durable `.chain.*` definitions. Varin therefore no longer advertises
create/edit workflow resources that the plugin rejects. Repeatable orchestration remains plugin-owned
through `workflowScript` and `/prompt-workflow`; it is an execution flow, not a persisted Agent
catalog entity. Future thinking tokens still render as an unsupported value and remain unchanged
until the user chooses a supported level.

It supports the complete current override contract, including `defaultProvider`, saved output,
output return mode, default reads, `tools: "inherit"`, and a structured three-state `toolBudget`,
while preserving arbitrary future agent names and unknown future keys. `false` is rendered as the plugin's
“clear resolved value” sentinel, which is distinct from an absent override and, for list fields,
from an explicit empty array. Runtime configuration includes the current control notification
event/channel lists and proactive skill-delegation settings. The one-value watchdog delivery and
late-warning enums remain in Advanced until the plugin exposes an actual user choice.

Agents consumes every current provider action advertised by the extension: create, edit/inspect,
update, delete, eject, enable, disable, reset, and model-resolution inspection. It does not stop at
displaying action badges.

Fleet is a separate live-work surface. It is provider-neutral: each Host adapter reports its own
`active` / `degraded` / `incompatible` / `unavailable` state, and the registry merges entries under
`providerId + key`. The page is master/detail (list then detail on narrow panes) and does not parse
plugin wire in the renderer.

Implemented Fleet providers:

- `pi-subagents` after `subagents:rpc:v1` advertises `fleetStatus: { version: 1 }`. Entries are
  `delegated-agent` / `running`, with agent/role, caller-facing goal as `description`, model, effort,
  timing, and token totals. The host drops RPC text, tool details, run IDs, and async paths. Native
  inspector, stop selector, and doctor remain command-backed.
- `pi-background-tasks` through published EventBus v1
  (`pi-background-tasks:request:v1` / `response:v1` / `terminal:v1`). `isAgent:true` becomes
  `background-agent`; other tasks become `background-task`; plugin `killed` becomes `stopped`.
  Provider `run` and entry `logs` / `kill` are advertised on the DTO. The Host omits `command`,
  `cwd`, output paths, PIDs, and the plugin kill message. There is no Plugin Settings schema and no
  `.pi/tasks` reader.

Per-entry controls render only for DTO actions Varin knows how to invoke (`logs`, `kill`, `run`).
Richer workflow graphs remain a later public-contract slice.

Acceptance:

- settings round-trip unknown keys at both scopes;
- provider-owned actions update the catalog without a renderer refresh;
- an async child task appears in its parent session and Fleet with structured state;
- a background-task EventBus fixture can run, list mixed running/recent work, load bounded logs
  without a file path, stop a running task, and survive session replacement without leaking stale
  rows;
- unavailable or malformed provider contracts degrade only that provider, not parsed terminal text.

### 5.2 Magic Context

Authority:

- the package's current Zod schema and generated JSON schema;
- user/project `magic-context.jsonc`, preserving comments and trailing commas;
- registered `ctx-*` commands and public custom entries/components;
- public database or status contracts only when the package exposes them.

Target sections:

1. Overview and health: active scope, context state, diagnostics, and available session operations.
2. Session operations: status, flush, augmentation, wrap-up, session upgrade, dream, and embeddings.
3. Core and compression: TTL, thresholds, tags, history budget, commit trigger, system injection,
   TodoWrite projection, Mural rendering, transforms, sub-context behavior, and lossy controls.
4. Memory and embeddings: memory, automatic search, Git indexing, embedding, and SQLite settings.
5. Agents and schedules: historian, dreamer, sidekick, model/thinking/timeout, fallbacks, schedules,
   and promotion thresholds.
6. Safety and advanced: safety-sensitive flags and the complete native JSONC document.

Project configuration is not rendered as an identical user form. Keys stripped or disallowed by
the package's project override rules are explained and remain user-only. Expensive recompression
requires a focused confirmation that explains range and model cost; routine operations do not.

Implemented configuration slice: the native settings page now separates Context, Memory, Models,
and Maintenance. It keeps independent unsaved
user/project drafts, hides fields the real project loader strips, reports ignored fields already
present in a project document, validates the plugin's numeric five-field cron and embedding
requirements, and preserves polymorphic per-model maps for Advanced JSONC editing instead of
flattening them into scalar controls. TodoWrite and the top-level `mural` block use their current
native paths rather than the removed experimental namespace. Starting with Magic Context 0.39,
Historian and Dreamer model execution is harness-scoped; Varin uses `historian.pi`, `dreamer.pi`,
and `dreamer.pi.tasks` for new values on that version. A legacy flat value already accepted by the
plugin remains visible and editable until the user or plugin migrates it, while an existing nested
Pi value wins exactly as it does in the plugin loader.

Implemented session-operations slice: when a live session advertises the current command set, the
adapter opens the plugin-owned status dialog, flushes pending context, queries embedding status,
starts or pauses embedding, shows the plugin-owned todo dialog, submits Sidekick augmentation, and
invokes wrap-up, full or ranged
recompression, session upgrade, or a selected Dreamer task. Augmentation is labelled as a real new
user turn rather than a preview. Wrap-up, upgrade, and Dreamer receive focused explanations of
model cost/state effects. Full and ranged recompression deliberately keep Magic Context's native
two-invocation, 60-second confirmation instead of trying to infer its armed state from output
prose. The adapter renders the newest persisted public `ctx-status` entry from the current Pi
branch with the same renderer used by chat. It never reads SQLite or copies status into Varin
storage.

The runtime surface groups those operations by intent: Context health contains the newest public
status entry and lightweight refresh/flush actions; session maintenance owns wrap-up,
recompression, upgrade, and Sidekick augmentation; Dreamer and embedding workers are kept in their
own long-running section. It does not synthesize progress that the extension has not published.

Acceptance:

- every field shown by the GUI maps to the current package schema and correct scope;
- unknown JSONC content and comments survive a GUI edit;
- commands are invoked through the active extension and transport failures remain distinct from
  provider-reported status entries;
- no memory or SQLite content is copied into Varin storage.

### 5.3 pi-mcp-adapter

Authority:

- the adapter-owned effective source catalog and merge order (normally six native sources, or the
  single Pi source while exclusive mode is active);
- `pi-mcp-adapter/status/v1` for effective runtime state;
- its registered panel, reconnect, authentication, logout, enable, and disable commands;
- the adapter's OS keyring/OAuth implementation for credentials.

The dedicated MCP page is visible only while `package.list` reports an installed and enabled
`pi-mcp-adapter`. Its split view uses the adapter's read-only `configCatalog/v1` RPC as the left-hand
catalog: one row per deduplicated effective server, with runtime state joined by server name. The
right pane shows the selected server, its runtime actions, and the highest-precedence native source
that directly defines it. New-server and adapter-settings actions choose an explicit native source;
source-local edits still use the revisioned `config.text` contract and preserve the raw JSON/JSONC
draft. Varin never folds source documents in the renderer.

The public catalog contains only server identity, disabled state, transport kind and sanitized
command/URL/socket display data, plus direct native-source membership. It does not expose arguments,
environment, headers, bearer material, OAuth data, URL user information, query strings, or
fragments. Imported or programmatic effective servers may therefore have no editable source. The
adapter remains the sole owner of merge order, imports, URL credential binding, and effective
transport selection. Varin edits one selected native document and re-reads the adapter-owned
catalog after save.

Saving a changed existing server URL clears URL-bound credentials present in that selected source,
matching the adapter's cross-source credential binding instead of carrying old endpoint secrets
forward. The cleanup happens at the revisioned Save boundary, so temporary typing is reversible and
restoring the loaded URL preserves its credentials. Switching transport clears fields owned by the
previous transport while preserving unrelated and unknown server fields. Partial server overrides
remain valid, so the GUI does not require a transport when a lower-precedence source supplies it.
Host-config discovery stays explicit and defaults off. Socket configuration keeps a local trust
warning beside the path. OpenCode is available only as an explicit compatibility import supported
by the adapter; it is never an authoritative Varin source.

The public `status/v1` snapshot remains the runtime authority and does not expose config provenance
or failure text. The separate `configCatalog/v1` projection supplies effective identity and direct
source membership, computed inside the adapter with the same loader used at runtime. Server actions
remain command-backed; names containing whitespace are shown but their per-server buttons stay
disabled because the adapter's current command parser has no quoting contract. The extension panel
remains available for those servers.

Acceptance:

- all status and actions use public adapter contracts;
- the effective catalog and runtime snapshots never add credential material to renderer state or logs;
- each effective server appears once and native source selection never requires a renderer-side merge;
- absent status support yields configuration-only/degraded UI.

### 5.4 pi-web-access

Authority:

- the agent-root `web-search.json` document;
- registered search, curator, Google-account, and shortcut commands;
- public extension widgets/custom entries and any future versioned activity contract.

Target sections:

1. Overview: installed/active state and provider availability when publicly reported.
2. Routing: provider, search provider, workflow, summarization model, and tool names.
3. Browser and Curator: browser opening, cookie opt-in/profile, validation action, curator lifecycle,
   bind, and timeout.
4. Provider options: provider-specific non-secret settings.
5. Security and advanced: SSRF policy, remote Curator warnings, credential-source syntax, shortcuts,
   and the full native JSON document.

Implemented configuration slice: the first-class adapter now models automatic, named, concurrent,
all-provider, and typed ordered-fallback routing without presenting `provider` and
`searchProvider` as independent choices. Its quick view is organized as Search, Providers &
credentials, Browser & Curator, Content, and Safety. Stable high-frequency controls include masked
credential sources, provider endpoints/models, OpenAI credential-provider priority, Curator bind
modes, Chromium-cookie opt-in, summary and inline-content limits, GitHub/video/image/PDF switches,
PDF provider/size/page limits, domain policy, and SSRF exceptions. Tool-name aliases, shortcuts,
less common budgets, authenticated-fetch profiles, and provider-specific tuning remain in the same
draft's Advanced editor while
unknown native keys are preserved. Varin propagates its selected Pi agent directory through
`PI_CODING_AGENT_DIR`, so the file edited by the GUI is the file loaded by extensions even when a
custom agent directory is used.

Implemented session-operations slice: the adapter discovers the live session's registered command
catalog, opens `/websearch` with an optional native comma-separated query list, invokes the
plugin-owned Gemini Web account diagnostic, opens the plugin's persisted-result browser, and calls
the public `/curator on|off|summary-review` modes. Those runtime actions intentionally remain
separate from the saved `workflow` draft: the plugin owns persistence and immediate session
effects, while the settings form remains a revision-safe view of `web-search.json`. Command
discovery proves only that an operation is loaded; provider health, search activity, and richer
Curator state remain unreported until the extension publishes a versioned runtime contract. The
plugin continues to own every dialog, follow-up message, browser server, stored result, and delete
action.

Secrets use masked inputs and are never tested, summarized, or reported as provider health. The
advanced editor preserves native credential source references. A remote Curator bind explains
plain-HTTP/token-in-URL exposure and highlights
`0.0.0.0`; it is allowed after an explicit choice rather than prohibited by a product allowlist.

Acceptance:

- common settings preserve every unknown native key;
- browser/cookie validation and runtime activity appear only through public contracts;
- high-risk remote configuration is explicit and still configurable;
- search/fetch tools and results continue through the generic Pi extension bridge.

### 5.5 Native recovery, pi-workspace-history, and pi-wtf

Authority and detailed semantics are defined in [recovery.md](recovery.md). The normal rollback
entry point remains attached to a user message. The right sidebar reports current-session native
recovery health and operations. Settings owns policy, storage location, retention, cleanup, and
workspace-history deletion without becoming a second file or conversation authority.

The selected `varin.workspace-recovery@5` Host service owns affected-file checkpoints, dirty-buffer
fencing, combined restore, undo/redo, retention, and crash reconciliation. The official provider is
the replaceable `varin.builtin.recovery` extension. `pi-workspace-history` keeps its own optional
history and configuration, and `pi-wtf` keeps prompt-repair and command-word behavior; neither is
installed, invoked, or treated as an authority by native Varin recovery.

Acceptance:

- the `conversation`, `both`, and `ask` policy is honored at every message rollback;
- combined rollback is available only through the selected versioned Host service;
- sidebar and settings actions refresh that service's authoritative state;
- optional Pi package presence, native-recovery readiness, cancellation, and provider failures remain
  distinguishable.

### 5.6 pi-lens

Authority:

- user JSON at `PI_LENS_CONFIG_PATH` when set, otherwise `~/.pi-lens/config.json`;
- the nearest project JSON found while walking from the runtime working directory to the filesystem
  root, checking `.pi-lens.json` before `pi-lens.json` at each level;
- the active session's registered `lens-*` commands for immediate actions;
- no private cache, report, instance registry, or NDJSON log as Varin state.

The Host resolves both authorities and returns only the selected path, content, and revision. The
renderer names the closed `pi-lens-global` or `pi-lens-project` authority and never receives an
arbitrary absolute-path capability. The quick form keeps user and project drafts independent. User controls cover the current flag
registry plus formatting mode, warning autofix budget, widget visibility, ignore patterns, and the
runner timeout floor. Project controls contain only fields the package actually honors there:
mutation switches, ignore/rule policy, project and review-graph budgets, Trivy, and Helm render
validation. A user-only key found in a project document is reported but never removed; arbitrary
future fields remain round-trippable through Advanced.

All fields are optional at the source layer. The form never writes pi-lens defaults merely because a
control was rendered. Every project candidate from the working directory through its ancestors is
one ordered authority chain, so all are watched and creating a nearer or same-directory
higher-precedence file immediately changes the selected draft. JSON revisions and
the shared Host lock prevent an external agent edit from being overwritten before the watch event
arrives.

Runtime actions are limited to commands actually returned by `command.list`: session activation,
context injection, diagnostics widget, technical-debt index, project map, health, performance, and
tool installation status. Varin shows task labels rather than raw command identifiers and still
dispatches the exact native slash command. It does not parse command output into a parallel status
model.

Acceptance:

- both native scopes preserve unknown keys and choose the correct project filename by precedence;
- project-global-only keys are diagnosed without becoming a save blocker or being deleted;
- clean external changes reload, dirty changes remain intact, and stale saves conflict in the Host;
- runtime buttons appear only for commands observed in the active session;
- no pi-lens private diagnostics cache or telemetry log becomes a Varin authority.

### 5.7 @cortexkit/aft-pi

Authority:

- the Host-owned `aft-user` authority resolving the platform-native CortexKit user
  `aft.jsonc` path;
- trusted project `.cortexkit/aft.jsonc` through the revisioned project text-document contract;
- the active session's `command.list` result for the presence of `aft-status`;
- no bridge cache, semantic index, call graph, backup tree, status output, or custom UI component as
  Varin state.

Both scopes are JSONC drafts. Structured edits preserve comments, trailing commas, unknown fields,
and the `bash` custom-object form. Known invalid fields block structured saving so AFT's partial
loader cannot silently skip a malformed known section. Unknown top-level fields remain non-blocking:
AFT's partial loader ignores them, while Varin preserves them and explains that they are not
currently effective.

The project view follows AFT's native one-way and user-only merge rules instead of presenting the
user form as if every field took effect. It reports but does not remove user-only top-level fields,
`aft_safety` disablement, semantic backend/credential/query settings, executable-origin LSP settings,
sandbox disablement, the GitHub CLI shim, and project write allowances. User quick controls include
the bounded inspect diagnostics timeout and GitHub CLI shim added in AFT 0.52.1. Project quick
controls expose only fields the loader actually honors. Additional project read denials and complex
native values remain available in Advanced.

Runtime observation is deliberately command-only. Varin marks AFT observed only when
`command.list` contains `aft-status`. It does not execute `/aft-status`: that command renders through
`ctx.ui.custom`, while Varin's RPC bridge can only project static custom UI. Saving uses the Host's
revision check and active-Host configuration reload boundary, but the UI does not claim that every
AFT subsystem hot-reloads or that a newly saved value is already effective.

Acceptance:

- both authorities preserve JSONC syntax, unknown fields, custom `bash` objects, dirty drafts,
  external changes, and revisions;
- invalid known fields block saving while unknown and project-ignored diagnostics remain
  non-blocking;
- project diagnostics match AFT's native strip/one-way merge rules and no hidden field is presented
  as effective;
- runtime availability depends only on observing `aft-status`, with no command execution or status
  output parsing.

### 5.8 Retired permission-system adapter (D-283)

Varin no longer provides a first-class adapter, Composer control, status bridge,
quick mode, or foundational provisioning for `@gotgenes/pi-permission-system`.
Interactive approvals are owned by the native Varin Harness permission gate and
its Harness Settings policy. The package may still be installed by a user as an
ordinary Pi package through Pi's generic package surface, but Varin does not
read or edit its policy files and it cannot replace or bypass the native gate.
The previous adapter contract is retained only in history/decision records.

### 5.9 pi-hermes-memory

Hermes Memory has one configuration authority: the Host-resolved `hermes-memory-user` file
`hermes-memory-config.json` under the active Pi agent directory. The renderer does not guess `HOME`
or the agent root. It has no project configuration authority. Project memory directories, Markdown
files, and SQLite stores contain plugin-owned data and are never read or presented as settings.

The strict JSON draft uses the shared revision, dirty-draft, external-change, and Host reload
contract. Quick controls leave absent fields absent so the plugin keeps ownership of defaults.
Known invalid loader fields block structured saving. Unknown top-level fields are ignored by the
current plugin loader, reported without blocking, and preserved in Advanced. Advanced also owns
`memoryDir`, custom policy text, child extension paths, the four correction-pattern arrays, and
future fields. If both `memoryOverflowStrategy` and legacy `autoConsolidate` exist, both remain
unchanged and the UI explains that the modern field takes precedence.

Runtime observation checks only whether the active session's `command.list` contains
`memory-insights`. Varin does not execute the command, parse notifications or TUI output, inspect
memory data, or infer background-review, Markdown, or SQLite health. No session, command-list
failure, and command not observed remain separate states.

### 5.10 pi-rtk-optimizer

RTK Optimizer has one strict-JSON configuration authority:
`<agentDir>/extensions/pi-rtk-optimizer/config.json`. The active agent directory comes from the
existing Host-resolved `config.text` root; the renderer does not invent a home path or a project
configuration. Quick controls edit the same raw draft as Advanced. Missing fields stay absent, and
unknown or legacy fields round-trip without being promoted back into the Quick surface. In
particular, the removed rewrite-category controls are not restored.

The form covers `enabled`, rewrite/suggest mode, the missing-binary guard, rewrite notifications,
and the current `outputCompaction` tree. Smart-line truncation accepts only the plugin's 40–4000
range and final character truncation only 1000–200000. Known invalid values block saving for repair
in Advanced; unknown and legacy values remain visible and non-blocking.

Runtime observation is deliberately command-only. Only an exact `rtk` entry from `command.list`
means the extension loaded. It does not establish that the external `rtk` binary is installed.
Varin may dispatch `/rtk show`, `/rtk verify`, `/rtk stats`, and `/rtk clear-stats`, but does not
parse their notification text into status or copy metrics into Varin state.

## 6. Implementation order

1. Recovery correctness and sidebar controls, because the host operations already exist and the
   message-level contract is user-facing today.
2. Shared adapter shell and capability states.
3. Subagents settings, provider lifecycle actions, and Fleet projection.
4. Magic Context schema-complete settings and command operations.
5. Web Access advanced routing/security and public runtime status when available.
6. MCP provenance improvements without replacing its native panel.
7. pi-lens settings and command actions over its native JSON and public command catalog.
8. AFT settings over its native CortexKit JSONC authorities and command-only runtime observation.
9. Permission-system policy and runtime settings over its native scoped JSONC documents and native
   command catalog.
10. Hermes Memory settings over its single native agent-root JSON authority and command-only
   runtime observation.
11. Provider-neutral Fleet plus `pi-background-tasks` EventBus v1 (list, run, bounded logs, stop)
   without a fabricated settings schema.
12. RTK Optimizer over its one native strict-JSON authority, with command-only runtime observation
   and no fork or old-Pi compatibility layer.
13. Cross-page navigation, unknown-plugin discovery, and final removal of superseded pages after
   capability parity or an explicit rejection is documented and tested. This retirement is now
   complete for the imported Magic Context, OpenAgent, and Agent Orchestration pages.

Each step is independently type-checked, linted, tested, committed, and pushed. File deletion occurs
only after its capability has a Pi-native home or is explicitly rejected as obsolete.
