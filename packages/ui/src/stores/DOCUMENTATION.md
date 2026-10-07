# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Not all state in the UI belongs here.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (for example directory, branch, session id)
- updated imperatively from multiple surfaces

Do not put high-frequency local component state here just because it is convenient.

## Architecture

There are multiple store categories in this directory.

### Feature cache / query stores

These are the most performance-sensitive.

- `useGitStore.ts`
- `useGitRepositorySelectionStore.ts`
- `useGitHubPrStatusStore.ts`
- `useFileSearchStore.ts`

These stores act like centralized keyed caches. UI should consume narrow slices from them instead of re-fetching the same data in multiple places.

### UI state stores

Examples:

- `useUIStore.ts`
- `useDirectoryStore.ts`
- `useFeatureFlagsStore.ts`
- `useUpdateStore.ts`

These stores coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags.

`useWorkOverviewStore` retains explicit panel/disclosure choices by runtime and conversation ID.
Plan, task and other content updates do not write these preferences. Missing choices use the view's
defaults: the overview is closed, content sections are expanded, and Sources is collapsed.

The overview reads plan/progress/decision blocks by conversation ID, independently of their
knowledge owner or execution directory. Block events and successful `todo` completion both
refresh that projection; branch navigation reloads the visible revisions. Blocks, review items,
Git status and task-list reads reject superseded responses. Reconnecting the event stream
refreshes these projections without changing disclosure choices. Pending questions include
the reachable task family's sessions; Computer Use keeps its own revision-aware event projection.

`useWebSourcesStore` reconciles source metadata with the active native transcript. Unpinned
sources removed by branch navigation disappear; explicit pins remain. User dismissals are
preserved during reconciliation. A runtime change clears this transient projection so material
from another Host cannot appear under the same conversation ID.

`usePiInteractionStore` projects native questions separately from generic extension dialogs. Popup
visibility, expiration overrides and answer drafts are transient UI choices. Hiding a popup sends no
runtime response; answering or explicitly closing the overview item uses `extension.ui.respond`.
Question dialogs remain available after a session worker closes, while native snapshots reconcile
their current branch. Runtime changes clear the projection and drafts along with other interaction state.
The interaction subscription follows replacement runtime clients after reconnect. Native question
events also update the session snapshot projection, including buffered events replayed after a resync.
The interaction store follows changes to that snapshot's question list, so authoritative RPC reads
restore questions missed during a disconnect without resetting hidden choices or answer drafts.
The `varin.user-question` journal stays in native history but is not a visible conversation entry.

The composer follow-up strip is scoped by runtime and session, reads again on event-stream reconnect,
and invalidates older in-flight reads. It shows only waiting/triggered registrations. Actions use the
registration's session and revision, apply the returned state immediately, and refresh even after a
rejection. Completed registrations remain in the task hub's history instead of above the composer.

### Session / project coordination stores

Examples:

- `useProjectsStore.ts`
- `usePiSessionStore.ts`
- `useSessionFoldersStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

`useBotSessionIndex.ts` caches the Host's Bot-owned Pi session IDs for the active runtime. Ordinary
Workbench/IDE navigation waits for this authority before showing conversations; a failed read stays
visible as an error. Entering those modes from Bot refreshes the index, while ordinary mode switches
reuse the cached result.

`usePiSessionStore.ts` loads the native `session.list` catalog and owns live session snapshots,
entries and submission state. Catalog requests use a generation and runtime identity; an older
completion cannot replace a newer catalog. Failed reads keep the existing summaries and expose an
error. Display grouping and sorting belong to `components/pi-session/sessionPresentation.ts`,
not the incidental catalog array order.

Session creation commits the native snapshot, then notifies the optional `onCreated` caller before
waiting for history/catalog hydration. The pending composer uses this phase to transfer its draft
to the real runtime/session key in the same paint as selection; slow hydration never clears the input.
The draft store continues to own the transfer, and creation still waits for the native reads before returning.

Permission grants remain authoritative in the Application Host; renderer preferences are not a
second permission store. See [the security contract](../../../../docs/design/security.md).

Shared safe storage treats durable failures per key. A quota or access failure creates an ephemeral override or tombstone for that key without disabling reads and writes for unrelated keys; later writes retry the durable backend. Deferred adapters retain failed operations for a later flush, and malformed Zustand JSON is removed and treated as missing so hydration can recover.

Project and UI settings use successful settings synchronization as authority. Omitted fields in a complete snapshot reset to canonical client defaults, including an omitted project list becoming empty; transport or settings-load failure dispatches no synchronization event and preserves current state. Settings save responses are partial patches and must not clear unrelated in-memory preferences or local mirrors.

`usePreferencesStore` owns speech preferences for both settings and composer
dictation. The recording start reads the current model/provider/language from
that store; there is no independent dictation preference cache. The Host supplies
the downloadable STT catalog and its supported languages. Shared client defaults
select Whisper large-v3 Turbo without replacing an explicitly saved model.

Project ordering defaults to manual. `useSessionDisplayStore.ts` persists the selected order and
disclosure preferences under `varin.sessionDisplay.v1`; it does not migrate an older order.

Session folders persist in runtime-specific v1 browser keys without silently evicting older runtime namespaces. Runtime switch, page hide, app freeze, and unload synchronously flush the pending browser snapshot before lifecycle suspension or namespace replacement. A runtime switch then cancels stale old-runtime disk work and starts generation-owned disk hydration. Missing or malformed server files are not authoritative empty snapshots; disk data may replace browser state only when it carries a real revision and no newer local folder mutation occurred. Server writes are serialized and reject non-newer revisions so delayed or duplicate requests cannot overwrite the current state. File-search cache and in-flight keys include runtime plus directory and are cleared on endpoint reset.

`usePiDraftStore.ts` keeps prompt text, images, instructions and staged model/thinking choices in
memory. Existing-session keys contain runtime and session ID; pending-session keys contain runtime
and normalized workspace path. Creating a session transfers its pending draft rather than copying
it into a second persistent chat store. See [Composer](../components/chat/composer/DOCUMENTATION.md)
for submission ownership and attachment behavior.

Inline-comment drafts and pinned sessions have their own persisted, scoped stores. Do not infer
that every chat-related store has the same persistence or migration behavior. Authoritative session
deletion must clear the relevant scoped state without resurrecting it during a later lifecycle flush.

Timeline projection and streaming identity rules belong to
[chat presentation](../components/chat/message/parts/DOCUMENTATION.md#timeline-projection).

### `useTerminalStore.ts`

`useTerminalStore` owns terminal tab arrangement per directory plus PTY scrollback.

Scrollback is deliberately **not** stored on the tab. `buffers` is a separate map keyed by
directory and tab id, and `getBuffer()` returns a shared frozen empty buffer for tabs that
have produced no output. PTY output arrives at streaming frequency, so keeping it inside
`sessions` made every output chunk allocate a new tab, a new directory entry and a new
`sessions` map. That invalidated every tab-strip subscription, re-ran the project-action
run monitor, and made Zustand persist rewrite the session-storage snapshot per chunk.

Invariants to preserve when editing:

- Output actions (`appendToBuffer`, `replaceBuffer`) must leave `sessions` referentially
  unchanged; only `buffers` and `nextChunkId` may change.
- Buffer entries are owned by their tab. `closeTab`, `removeDirectory`, `clearAll`, and
  rebinding a tab to a different terminal session must drop the entry.
- Output for an unknown tab is ignored rather than creating an orphan buffer.
- Only `sessions` and `nextTabId` are persisted. `partialize` reuses its previous
  projection while both are referentially unchanged, and the storage adapter skips a write
  for an unchanged projection, so streaming output performs no persistence work.
- Consumers that react to output must subscribe to `buffers`, not `sessions`.

## Git / PR Stores

The Git and PR stores are the most important stores to understand before editing this directory.

### `useGitStore.ts`

`useGitStore` is a centralized active-runtime, per-directory Git cache.

Core model:

- active runtime owns one `directories` map keyed by directory
- each directory entry contains:
  - repo detection
  - status
  - branches
  - log
  - identity
  - diff cache
  - per-directory loading flags
  - freshness timestamps

Important properties:

- `directories: Map<string, DirectoryGitState>` is the source of truth
- loading state is per-directory, not global
- `ensureStatus()` and `ensureAll()` are the preferred entry points for consumers
- in-flight dedupe exists for status and `ensureAll()`
- runtime reset replaces all live entries with that runtime's persisted branch seeds and invalidates old completions
- status, branches, log, identity, repository probes, and prefetch diffs commit through runtime and per-channel generations
- status mutations advance a revision so older refreshes cannot undo optimistic or confirmed index changes
- branch persistence is versioned, bounded, runtime-scoped, and claims the ambiguous legacy cache once
- diff data has per-directory and aggregate count/UTF-8-byte limits; oversized single entries are rejected

### `useGitRepositorySelectionStore.ts`

The IDE's selected repository is a workspace-scoped view preference, separate from the product
workspace and from a Pi session cwd. It stores the resolved Git top-level directory by opaque
workspace identity, so choosing a nested repository never switches the Explorer, editor, terminal,
or session workspace. The IDE validates that a restored or newly selected repository remains inside
the active workspace before using it. Git diff paths are repository-relative and must be rebased
through that selected repository root before becoming workspace resource IDs.

### `useGitHubPrStatusStore.ts`

`useGitHubPrStatusStore` is a centralized PR cache keyed by a collision-safe tuple of runtime, directory, branch, and requested remote.

Core model:

- each entry stores:
  - current PR status payload
  - loading / error state
  - whether initial status was resolved
  - refresh timestamps
  - watch count
  - runtime params
  - resolved identity

Important properties:

- `ensureEntry()` initializes a key lazily
- `setParams()` attaches runtime context
- parameter changes advance an entry revision; stale queued, successful, and failed requests cannot update a newer authority
- `startWatching()` / `stopWatching()` are for true live PR consumers only
- `refreshTargets()` supports one-shot multi-target bootstrap without turning on live watching
- runtime reset disposes timers, watchers, API references, and request ownership while inert namespaced snapshots remain isolated
- persisted cache is versioned, TTL-filtered, and bounded for page refresh continuity, not broad background syncing

### `usePiSessionStore.ts`: submission and connection recovery

The selected visible session is observed while either its authoritative snapshot is busy or it
has a dispatched/unresolved submission. An idle cached snapshot cannot disable recovery of a
message whose acknowledgement and first events were lost. Observation requests have their own
bounded deadlines; a read timeout can retire only the captured active client and reconnect the
transport. It must not stop the worker, replay a prompt, or manufacture an idle result.

Prompt/steer/follow-up acknowledgement deadlines describe an unknown outcome, not a failed
execution. Preserve the captured editor view and submission while reconciling through the owning
Host. UI and Pi independently timestamp user messages: missed-event reconciliation uses an unseen,
unique matching user entry, not timestamp equality or a generic busy flag. Ambiguous or transformed
input stays unresolved instead of being automatically retried. Late failures cannot restore a draft
after its submission was reconciled, replaced or retired by a runtime change.

`HostController` handles synchronous `session.snapshot`/`session.reconcile` cuts outside its mutation
queue so an input/preflight hook cannot block the very reads used to diagnose it. Source-level
coverage includes `submission-recovery.test.ts`, `usePiSessionStore.test.ts`, the runtime-client wire
tests and the real Pi preflight fixture in `packages/pi-host/test/host-controller.test.ts`. These
fixtures do not by themselves establish a packaged-desktop reproduction of every send stall.

## Ownership Rules

These rules are important. Breaking them tends to reintroduce idle CPU churn, stale UI, or rerender fanout.

1. No broad `directories` or `entries` subscriptions in normal UI components.
2. No root pollers for Git or PR.
3. No broad idle sweeps across many directories.
4. Prefer store `ensure*` methods over direct runtime API calls from views.
5. Visible consumers should drive refresh. Hidden consumers should not.
6. Header should not depend on PR store.
7. A closed context panel (or hidden git surface) should not create live PR work.
8. File tree Git status should update only when the file tree is visible.
9. Session catalog refresh must preserve runtime and request-generation ownership.
10. Catalog summaries must not replace authoritative live session activity or submission state.

## Selector Rules

Use leaf selectors.

Good:

- `useGitStatus(directory)`
- `useGitBranches(directory)`
- `useGitBranchLabel(directory)`
- `useGitRepoStatusMap(directories)`
- `usePrVisualSummaryByKeys(keys)`

Bad:

- `useGitStore((state) => state.directories)` in feature components
- `useGitHubPrStatusStore((state) => state.entries)` in feature components
- render-time scans over every PR entry for a single project/group badge

Why this matters:

- Zustand reruns selectors on every `set`
- rerenders are avoided only if the selected result stays referentially stable
- broad subscriptions magnify fanout even when only one directory changed

## Performance Rules

### 1. Preserve references for unaffected entities

If directory `A` changes, directory `B` should keep the same derived reference where possible.

### 2. Keep loading state per entity

Do not add new global `isLoadingWhatever` flags for keyed cache work.

### 3. Avoid hidden work

If a surface is not visible, it should not keep refreshing Git/PR state.

Examples:

- `PullRequestSection` may watch a PR while visible
- `SessionSidebar` may bootstrap missing PR data for expanded visible groups
- hidden sidebar should not watch PRs

### 4. Prefer one-shot event hints over polling

Example already in use:

- successful mutating tools emit a centralized Git refresh hint through `sessionEvents`
- visible `GitView` / `DiffView` consume the hint and refresh current-directory status

This is preferred over background polling.

### 5. Treat `diffStats` carefully

`GitStatus.diffStats` may be omitted by light status fetches.

Rules:

- do not erase richer existing `diffStats` with a lighter payload
- if a UI surface requires per-file `+/-` stats, it must ensure a full enough status payload exists

### 6. Keep diff cache bounded

Diff cache has explicit limits because large repos can otherwise blow up memory.

Do not raise limits casually.

## Refresh Model

### Git

Expected model:

- `GitView` / `DiffView` ensure current-directory Git state when visible
- explicit Git actions refresh status/branches/log as needed
- successful file-mutating tools can issue a one-shot Git refresh hint
- no root-level background Git polling

### PR

Expected model:

- `PullRequestSection` is the only true live PR watcher
- `SessionSidebar` may do one-shot bootstrap for expanded visible project/worktree groups if PR info is missing
- no live PR work for header
- no background PR sweeps outside visible demand

## Known Intentional Fallbacks

There is still one explicit fallback path worth knowing about:

- `SessionSidebar` may call `checkIsGitRepository(...)` during initial worktree/project discovery when store state is not populated yet

This is currently acceptable as a narrow bootstrap fallback.

Do not widen it into a polling or broad refresh system.

## When Editing These Stores

Before changing store shape or selectors, ask:

1. Is this keyed by the right identity (directory, branch, session, root)?
2. Will this force unrelated consumers to rerender?
3. Should this be visible-demand-driven instead of background-driven?
4. Is there already a store cache for this data?
5. Am I duplicating fetch ownership in a component when it should live in a store action?

## Validation Checklist

After meaningful Git/PR store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view still loads status, branches, log, identity.
3. Diff view still opens the correct file and stays in sync.
4. Worktree sessions still show branch labels in header.
5. Expanded sidebar projects/worktrees can show PR state without requiring prior selection.
6. Hidden surfaces do not reintroduce live background work.
