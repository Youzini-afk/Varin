# @varin/application-client

Framework-neutral Varin application client boundary. Depends only on `@varin/protocol` and
`@varin/extension-contract` (no React, Zustand, or UI component dependencies).

## Package Boundary & Consumers

- **Subpath exports**:
  - `.` — `RuntimeAPIs` aggregate, typed domain APIs (Terminal, Git, Files, Documents, Settings,
    Permissions, Notifications, Extensions, Language, LanguageSupport, Tasks, Debug, Tests,
    Threads, etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
    `LanguageSupportError`, `RunServicesError`, `WorkspaceSearchError`), pure DTOs
    (`WorktreeMetadata`, `DraftStarterRef`, `FileEditorSettingsPatch`, `ThreadResultHistory`),
    transport primitives, and standalone Host clients.
  - `./desktop` (`src/desktop.ts`) — single desktop IPC contract, imported directly by
    `packages/electron` main/preload so bundling the native bridge never pulls HTTP/relay modules.
  - `./locale` (`src/locale.ts`) — shared locale normalization.
  - `./settings-locales/*` (`src/settings-locales/`) — static settings dictionaries shared by UI
    labels and Host tool discovery. Edit translations here; UI message modules re-export them.
    `settingsSearchTranslations` builds a cached search index on demand for `querySettingsCatalog`.
- **Consumers**: `packages/web` (web/remote implementations), `packages/ui` (shared React
  presentation and client-side kernels), and `packages/electron` (`./desktop`).
- **Relay injection**: Relay transport is injected through `registerRelayTunnelProvider` and
  `registerRelayTunnelLifecycle`; this package never imports the UI tunnel implementation.
  Selecting Relay without a registered lifecycle fails explicitly.

## Transport, Host Switching & URL-Auth

- **Authenticated HTTP vs browser URLs**:
  - Ordinary APIs pass route paths to `runtimeFetch` (`src/transport/runtime-fetch.ts`).
  - Browser-owned URLs (iframes, downloads, assets, WebSockets) use the runtime URL/auth resolver
    (`src/transport/runtime-url.ts`). Never pass a browser URL back into `runtimeFetch` or place
    long-lived bearer credentials in a URL.
- **Multiplexed observations** (`src/transport/observation-transport.ts`):
  - Direct-browser long observations multiplex the fixed `src/transport/observation-protocol.ts`
    route allowlist over `/api/varin/observations/ws`, keeping HTTP/1 connections available across
    views and tabs (relay requests retain their own transport).
  - Each channel preserves original HTTP status, headers, and body. Peers negotiate binary frames
    and a byte-credit receive window (bounds queued bytes, never total response size; older peers
    retain the pull protocol).
  - Desktop streams negotiate length-prefixed JSON metadata and image bytes via
    `src/transport/binary-events.ts`; `RuntimeEventSource` (`src/transport/runtime-event-source.ts`)
    retains reconnect and cancellation semantics for both binary streams and SSE.
  - Cancellation closes only that observation; socket failure fails unfinished channels without
    replay. The Host validates WebSocket identity/Origin and reuses route authorization. Local
    extension observations stay on the local Host when a remote runtime is selected.
- **Host switching**:
  - React features consume `RuntimeAPIs` via provider hooks; framework-neutral consumers use the
    registered accessor only when hooks cannot own the lifecycle.
  - Switching Host replaces endpoint/auth ownership and fences async work by Host generation so
    stale completions cannot publish. Asset caches key by Host + content revision and revoke retired
    object URLs. Unsupported capabilities return typed unavailable results rather than empty
    successes or accidental fallthrough.
- **URL-auth mint lifetime** (`src/transport/runtime-auth.ts`, tested in
  `test/runtime-auth-timeout.test.ts`):
  - Owns the shared in-flight URL-token mint with a **10-second deadline** across credential lookup,
    HTTP/relay fetch, and response-body parsing.
  - Concurrent consumers share the mint; a stalled mint releases its shared promise so later
    connections can retry without restarting the app. Fetch receives the owner's abort signal, late
    completions check runtime/origin generation before publication, and token values are never logged.
  - Authentication or observation failure never establishes the outcome of input already accepted by
    the native Catalog.

## Desktop IPC Contract (`src/desktop.ts`)

- `VarinDesktopCommandMap` — typed `{ args, result }` for the exhaustive `desktop_*` command catalog.
- `VarinDesktopBridge` — typed bridge interface implemented by Electron preload and consumed by UI.
- `PreloadBootstrapPayload` — discriminated union carrying credentials only for local pages.
- `VarinDesktopEventMap` — typed desktop events (update progress, SSH status, menu actions, etc.).
- Exhaustive command/event catalogs, runtime guards, and `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS`.

## Native Threads API (`src/threads.ts`, `src/threads-http.ts`)

Read calls accept `AbortSignal`, fence against endpoint-generation changes, and discard stale
responses after Host or selection changes. Unless noted, Host owns durable receipts, permissions,
and cleanup; aborting a transport or closing a view never cancels accepted Catalog execution.

| Surface | Key Methods / Files | Core Contract |
| --- | --- | --- |
| Thread catalog & history | `list`, `update`, `delete`, `markRead`; `src/thread-history.ts` | Stable `main_branch_id`, metadata revision, durable activity/read cursors. Uncertain retries reuse key + expected revision; same-key receipts cannot overwrite newer cache. `delete` writes a tombstone without cancelling accepted execution; restore via `update({ archived: false, ... })`. History release separates logical vs reclaimed bytes. |
| Sources & identity | `sources`, `prepareSource`; `DocumentsAPI.resolveResourceIdentity` | Resolves folders via selected Host's Documents owner; freezes non-secret `resourceOwner` + `workspaceId` + key/mode/scopes (retries reuse frozen intent). Managed sources use saved target files; materialized sources retain `environmentRunId`; last observer cancel drains prep. `resolveResourceIdentity(..., { withinWorkspaceId })` returns `null` only when disjoint; never parse IDs as paths. |
| Navigation & recovery | `prepareNavigation`, `navigate`, `navigationReceipt`, `recoverySource` | Stable key + expected/target head; only an original receipt authorizes undo to a removed descendant. `ThreadSnapshot.recovery` separates combined file/history recovery from standalone conversation undo. |
| Run control & inspection | `resume(runId, waitId)`, `retryPreparation(runId)`, `inspectTools`, `inspectPolicy`, `restartPolicy`, `cancelPolicyUpdate` | `resume` idempotently consumes only the displayed Pause (read derived `LaunchIntent.startable`/`pause`; queueing input ≠ resume). `inspectTools` exposes activated directory & prep state (preparing ≠ callable; revoked unavailable immediately; retiring stays callable via Run pin; listing ≠ permission). `restartPolicy` resets only the candidate's private checkpoint at a closed boundary without resuming Pause. |
| Goals | `ThreadsAPI.goals`, `ThreadSnapshot.goals` | Revision-checked continuing objectives returning short admission receipts (usage/objective read separately). Retries reuse key/input; ordinary submit/fork never creates a Goal; Goal-owned followups use Goal controls. |
| Family inspection | `ThreadsAPI.family` (`list`, `runs`, `read`, `item`) | Read-only cross-family view with caller `ThreadIdentity` separate from target. Anchors survive append/fork/rollback but expire with runtime epoch; empty pages can carry cursors; no launch or control methods. |
| Delegated continuation | `collaboration.continueChild`, `executions`, `readReport`, `readExecutionReport` | Explicit User continuation with stable key, previous Run, expected head (retries reuse intent; runtime derives config/source). `ChildReportPage` carries owner-set `format: 'text' \| 'output_body'` (assemble complete UTF-8 range before parsing `OutputBody<StoredMedia>`). Original `ChildTask`/`readReport` remains dispatch-round view. |
| Materials | `materials.upload`, `read`, `readSource`, `readArtifact` | `upload` ingests base64 `application/pdf` -> fixed `snapshotId`. `read` returns `FetchResult` from `snapshotId` (rechecks reading/OCR settings; hash verifies equality, never grants access). `readSource` / `readArtifact` (`/api/threads/materials/read-artifact`) require explicit retained research `sourceRunId`. |
| Research | `ThreadsAPI.research` (`scopes`, `submit`, `cancel`, logs/artifacts) | `scopes` lists retained source Runs; every domain call passes explicit `sourceRunId`. `canSubmit` is separate from read/control. `submit` uses stable User request ID + intent (does not restart historical source Run); `cancel` requests stop (closing readers does not); collection is separate. |
| MCP interactions | `ThreadsAPI.listMcpInteractions` | Compact `McpInteractionItem` pages with full evidence loaded on demand. `server_request` retains reviewed response delivery; `rpc_error` URL cards record local choices only and stay reviewable after Run failure without retrying the RPC or resuming the Run. |

### Task-family messages, questions & follow-ups

- **Messages** (`ThreadsAPI.messages`: `feed`, `inform`/`request`, `replyTo`,
  `collaboration.exchange`):
  - Trusted Host sets User identity (clients cannot set Agent actor/sender). `replyTo` targets the
    exact peer; `feed` pages immutable numeric acceptance cursors without activation effects.
  - Send receipts (`acceptedAtMs`) confirm Catalog acceptance separately from history delivery or
    completion; retry lost sends with the same key and intent.
  - `replyWait` projects an Agent's observation/deadline/winner (never client timers; User sends do
    not accept `wait`). Cancelling an Agent observation via Operation control never withdraws the
    message or hides a late reply.
- **Questions & permissions**:
  - `answerQuestion` submits the full `answers[]` (`questionId`, `selectedOptionIds`, `text`,
    `skipped?`) validated against the immutable `ask_user` set; equal retries reuse the receipt;
    cancellation uses `cancelOperation`.
  - Permission `allow_always` persists the displayed rule through the Host settings owner before
    resolving the one-action permission; renderers cannot supply rules.
- **Follow-ups** (`ThreadsAPI.followups`, `src/thread-workflows.ts`):
  - Registers one instruction for `at`, `process_stopped`/`job_stopped`, original-source file
    condition, research `artifact`/`collection`, job `log_literal`/`log_end`, machine `metric`, or
    flat `any`/`all`. Retries reuse key, source Run, trigger, and body; control uses revision.
  - `repeat: 'each'` repeats on each accepted match/crossing (omitted = once); repeated `any`
    consumes finite leaves once; repeated `all` pairs FIFO changes from all repeatable leaves.
    Pause holds accepted work/cursors; cancel withdraws future/undelivered occurrences without
    cancelling delivered Runs or the underlying Job.
  - `list` returns compact metadata; abortable `get`, `occurrences(identity, followupId, after?)`
    (`nextCursor` ≠ source `trigger_cursor`), and `occurrence(identity, followupId, occurrenceId)`
    load details on demand as inert data (never executed markup).
  - Source specifics:
    - `artifact` takes `artifactId` XOR `name` (neither = any); `collection` observes completion
      including empty/failed snapshots.
    - `metric` selects `machineId`, CPU/memory (MiB or %) or stable `gpuUuid` from
      `research.resources`, strict `above`/`below`, and finite threshold. Local sampling only;
      unknown/stale values do not rearm; historical gaps stay visible without replaying crossings.
    - `log_literal` matches non-empty exact UTF-8 bytes on stdout/stderr (omitted `fromOffset`
      starts at 0; `each` allows overlaps); `log_end` is finite per stream. Evidence freezes byte
      ranges/revisions without copying log text into lists. Catalog projects `exhausted` and
      `delivery_pending`.
    - `jobSources(identity, runId)` discovers task-family Jobs and returns authoritative
      `observationKinds`.

### Typed output media (`src/thread-media.ts`)

- `ThreadsAPI.mediaRead` reads one byte chunk through its original holder (history/input/Operation/
  event, policy evidence, family view, or `child_report` with dispatch + execution + report item).
  `expectedContentRef` verifies equality only and never grants bare hash access.
- `readThreadMedia` assembles and validates chunks, ordinal, byte total, and base64 into ephemeral
  bytes with no persistent cache, aborting on cancellation or Host switch.
- `OutputBody.parts` preserves text/media order while `data` remains opaque (never scanned for
  images). Operation results distinguish `control.value` and `output.output`. On input edits,
  omitted images preserve media, `[]` removes it, and new inline uploads replace it (public
  `StoredMedia` hashes cannot authorize replacement).

### Composer resources & frozen chat quotes

- **Skills & source files** (`src/thread-source-files.ts`): `ThreadSubmit`, queued input, and child
  continuation carry `skills` selectors (`resourceId`, `version`, UTF-16 `start`/`end`) as part of
  durable input identity (prepared in text order, deduplicated; leading `/skill:name` keeps the
  original parser).
  - `ThreadsAPI.resources.skills` and `draftSkills` resolve branch or pending-source skills by exact
    locator/version (drift fails explicitly rather than falling back by display name).
  - `threads.sources.files` and `draftFiles` return metadata-only Source-relative entries (`path`,
    `relativePath`, `name`, `type`, `nextCursor`, default page size `50`). Missing source yields
    empty only for chat-only Threads; source read errors reject explicitly.
  - `references` carry task/branch or source-directory locators and ranges as context only.
- **Frozen chat quotes** (`src/content-reference.ts`, `src/content-reference-input.ts`): Native
  submit, queue, child continuation, and User messages accept `contentReferences` +
  `contentReferenceOccurrences` bound to UTF-16 draft ranges (plain marker-shaped text is not a
  binding; metadata never grants file access; Rust projects once preserving order). Queue
  `editInput` accepts replacement quotes as its final argument (omission keeps frozen objects; text
  edits clear old positions). Navigation prep returns quotes, files, and image bindings without
  duplicating file-backed images.

### Thread observation (`src/thread-observation.ts`)

- `getThreadObservationBus(api)` owns one shared transport per selected Host/API. Subscribers pass
  optional thread, branch, and exact or namespace (`run.*`) kinds. Host enforces authorization
  (global cursor gaps ≠ lost authorized events).
- Reconnect replays the durable cursor; live progress-interest changes coalesce via
  `updateObservationInterests` (connection-scoped observation ID) without disrupting other views.
- Disconnects, cursor resets, and kernel epoch changes emit `resync`; initial connection emits a
  ready resync (`onReady` fires after response headers). Endpoint switches close the old bus.
- `snapshot(identity, signal, { afterHeadId })` permits delta merge only when returned
  `historyPage.afterHeadId` matches; omission means full history replacement (non-history fields
  are always complete).

## Agent profile settings

- `AgentProfilesAPI` (`src/agent-profiles.ts`, `src/agent-profiles-http.ts`) edits revision-checked
  user profiles for `runtime: 'agent'`, separating editable config, tool selection (`default` /
  `explicit` / `unconfigured`), and the live capability directory (`null` = unavailable, not empty).
- Save omits tools to preserve them, sends `[]` for none, or `null` to reset. Custom creation uses
  an empty key and explicit tools (Host allocates identity). Accepted Runs keep their frozen profile.
- Built-in `contextCompaction` includes a native `automation` descriptor (defaults to conversation
  model; filtered out of role/mention pickers; timing/capacity remain in context settings).
- Model/auth, MCP connections, and user/project skills live in `src/model-connections.ts`,
  `src/mcp-connections.ts`, and `src/resource-management.ts` (Host resolves project trust/paths;
  edits do not alter frozen Run checkpoints).

## Host Connections, Plugin Center & Standalone Clients

- **Host-owned connections** (`createHostConnectionsHttpAPI`, `src/host-connections.ts`): Always
  uses the selected Agent Host's authenticated HTTP transport—even inside Electron, never desktop
  IPC—for saved resource addresses, SSH processes, localhost probes, and logs. Fences endpoint
  generation; stopping UI SSH observation does not disconnect Host processes.
- **Plugin center** (`ExtensionsAPI.pluginCenter`, `src/plugin-center.ts`;
  `src/plugin-install-intent.ts`): Uses the authenticated Application Host transport with
  response-body generation fencing. Listing reads cached public catalogs; refresh, release preview,
  and installed update checks (by extension ID) are explicit separate requests; archive imports
  upload to the same Host. Install binds retained preview ID, expected Host, and catalog revision
  (never resolves `latest` post-review; source replacement is an explicit flag).
  `plugin-install-intent` parses public npm/GitHub release links only (no local paths/credentials;
  grants no trust or permission).
- **Standalone Host clients** (exported from package root, not on `RuntimeAPIs`):
  - `createExternalAgentsHttpAPI` (`src/external-agents.ts`) — `/api/external-agents/*` with
    Harness/session/turn identities (not fabricated native Runs).
  - `createUsageHttpAPI` (`src/usage.ts`) — `/api/usage/summary` with explicit date boundaries.
  - Both fence endpoint generation and reject stale results after Host switches.

## Shared Conversation Organization & Project Bindings

`RuntimeAPIs.conversationOrganization` (`src/conversation-organization.ts`,
`src/conversation-organization-http.ts`) owns the authenticated principal's Catalog navigation
space (mixed project/group containers + native/external conversation positions; not a history or
execution owner):

- **`read`**: Returns durable cursor, container/parent revisions, Bot provenance, and query-bound
  continuation. Pass `pageNodes: true` for authoritative mixed-node pagination (`items: { kind:
  'container' | 'native' | 'external', id }[]`, page/ancestor `containers`, page `conversations`);
  omitted/false keeps legacy full-container index + conversation-only pagination without `items`.
  Query parser rejects unknown fields and non-boolean flags.
- **`command` / `observe` / `metadata` / `project`**: `command` uses an admission key + affected
  revision checks (cancelled waits never reverse committed moves). `observe` shares the Host Thread
  observation bus. `metadata` returns per-item outcomes for a fixed selection (retry unconfirmed
  items with same key/revision/patch; external delete waits on turn/dispatch lifecycle). `project`
  coordinates committed Settings registration/removal with Catalog without faking rollback.
  Creation APIs accept `organization: { containerId }` (omit = inherit, `null` = root).
- **Project resource bindings**:
  - `ProjectEntry.source` freezes non-secret `SourceResourceOwner` + Documents `workspaceId`
    (omitted = local Host). Remote paths resolve only on the selected source Host; same-named paths
    on different Hosts are distinct projects; offline registered projects stay editable for metadata.
  - Model settings with `projectId` use trusted `.varin/settings.json` for local projects and the
    coordinating Host's `AgentSettingsService` for remote projects.
  - Native submission omits `source` to inherit or passes `source: null` for chat-only
    (`creationDefaults` is read-only; moving navigation parent never changes source). Project
    drafts/receipts and `ThreadPrepareSource.selection` freeze `ProjectSourceSelection` (committed
    adoption IDs or explicit `live_root`), verified directly on the source Host.
  - Remote file views carry that logical selection through ResourceFiles/uploads/transfers without
    mutating conversation source; choosing an explicit directory clears it. Remote resource
    management (`expectedSource` drift-checked) retains the physical project registration for
    Skills, instructions, and trust store checks.
