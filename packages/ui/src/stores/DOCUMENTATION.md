# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (directory, Host, branch, Thread)
- updated imperatively from multiple surfaces

Do not put high-frequency local component state here just because it is convenient.

## Architecture

### Feature cache / query stores

Performance-sensitive centralized keyed caches — consume narrow slices instead of re-fetching in multiple places:

- `useGitStore.ts`
- `useGitRepositorySelectionStore.ts`
- `useGitHubPrStatusStore.ts`
- `useFileSearchStore.ts` — cache and in-flight keys include Host + directory and clear on endpoint reset

### UI state stores

Coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags:

- `useUIStore.ts`
- `useDirectoryStore.ts`
- `useFeatureFlagsStore.ts`
- `useUpdateStore.ts`
- `useWorkOverviewStore.ts` — retains explicit panel/disclosure choices by runtime and conversation ID; plan/task updates never write preferences, and this store owns no execution/source state
- `usePreferencesStore.ts` — owns speech preferences (default Whisper large-v3 Turbo when unset); recording start reads model/provider/language here while the Host supplies downloadable STT models and languages

### Thread / project coordination stores

- `useProjectsStore.ts` — navigation-project metadata
- `useThreadStore.ts` — selected native Thread/branch and rebuildable Catalog summaries
- `useThreadDraftStore.ts` — in-memory composer drafts and pending input receipts
- `useMultiRunStore.ts` — explicit multi-run launch intent and per-attempt status
- `useConversationOrganizationStore.ts` — active Host's Catalog organization tree projection and cursor observation

Key invariants across these stores:

- **Host & identity fencing**: `threadHostKey` includes endpoint + selected Host identity; `threadIdentityKey` adds real Thread and branch. Catalog binding captures an epoch, aborts observation on Host replacement, and rejects stale requests. Selected branches validate against the live Catalog. Metadata revisions, activity/read cursors, and tombstones merge monotonically so an older receipt never overwrites a newer event projection.
- **Catalog & sidebar**: `ThreadSidebar` filters Bot-owned conversations by authoritative `bot_id` and sorts by pin, update time, and identity. Archive and delete are distinct; deletion hides navigation via a retained tombstone without owning execution/resource cleanup. `markRead` acknowledges only the presented cursor; passive completion/failure bells show for root conversations only (child unread cursors stay intact without a navigation bell).
- **Thread creation & live projection**: Creation keys survive uncertain responses; creating a Thread does not start a Run. Staged workspace paths resolve through the authenticated Host and Documents owner. `ThreadProjection` (`packages/ui/src/lib/agent-runtime/thread-projection.ts`) owns live snapshot/progress observation, not the Catalog summary array.
- **In-memory drafts** (`useThreadDraftStore.ts`): Retains text, images, PDF snapshot refs, model/thinking choice, delivery mode, prepared source, and exact pending input, keyed by Host + Thread/branch, and is never persisted. Submission and retry ownership live in [Composer](../components/chat/composer/DOCUMENTATION.md); a failed observation never erases accepted input or restores acknowledged draft material.
- **Multi-run intent** (`useMultiRunStore.ts`): Retains stable command keys and prepared source identities per model. Stopped launches, failed preparation, and unknown delivery keep existing Threads/worktrees; unconfirmed worktree creation is never auto-replayed, and retries preserve the original intent.
- **Scoped native catalog & organization observation**:
  - The native sidebar subscribes to the shared Host observation bus: initial load/resync reads the full catalog, while scoped durable changes batch dirty Thread IDs through `inspectMany`, preserve untouched summary references, and re-sort only the result. Missing/hidden/deleted results remove only requested IDs; failed delta reads keep current rows and retry.
  - `useConversationOrganizationStore.ts` shares that bus over HTTP: classification/metadata changes refresh loaded windows, native activity invalidates loaded recent-sort windows only, and token progress / read acks / unrelated operation events do not reload the tree. Refreshes coalesce and stop at the loaded window; failed pages keep their prior view and retry only that page.
  - `useConversationOrganization()` manages shared binding lifetime without subscribing callers to every store field; rendering views pass a shallow selector for only the fields they display.
- **Native submission & connection recovery**:
  - `packages/ui/src/lib/agent-runtime/threadInputDelivery.ts` keeps one observation per Host generation, Thread/branch, and original command key. Submission, enqueue, and child continuation retain exact captured input while delivery is unknown; only an explicit first-attempt pre-admission rejection releases that intent.
  - `ThreadProjection` rebuilds snapshots from the durable event cursor. Transient stream progress scopes to the active Run + stream sequence; gaps or closed connections clear transient UI and refresh history without resending input, stopping the Run, or fabricating idle state.
- **Persistence, settings sync & directory home**:
  - Permission grants remain authoritative in the Application Host ([security contract](../../../../docs/security.md)).
  - `utils/safeStorage.ts` isolates quota/access failures per key with ephemeral overrides/tombstones, retries durable storage on later writes, queues deferred flushes, and clears malformed Zustand JSON so hydration recovers.
  - Successful settings synchronization is authoritative: omitted fields in a complete snapshot reset to client defaults (including an empty project list), transport/load failure dispatches no sync and preserves state, and partial save responses do not clear unrelated preferences.
  - Directory restoration runs after auth/settings sync: web, mobile, and remote desktop use the active Host's `WorkspaceAPI` root (never OS home or another Host's cache); local desktop keeps its preload-provided home. Inline-comment drafts, resource-library views, and other scoped stores keep their own persistence contracts.

### `useTerminalStore.ts`

`useTerminalStore` owns terminal tab arrangement per directory plus PTY scrollback.

Scrollback is deliberately **not** stored on the tab. `buffers` is a separate map keyed by directory and tab id, and `getBuffer()` returns a shared frozen empty buffer for tabs with no output. Keeping streaming PTY chunks outside `sessions` prevents every chunk from invalidating tab-strip subscriptions, re-running project-action monitors, and triggering Zustand persist writes.

Invariants:

- Output actions (`appendToBuffer`, `replaceBuffer`) must leave `sessions` referentially unchanged; only `buffers` and `nextChunkId` may change.
- Buffer entries belong to their tab: `closeTab`, `removeDirectory`, `clearAll`, and rebinding a tab to another terminal session must drop the entry.
- Output for an unknown tab is ignored rather than creating an orphan buffer.
- Only `sessions` and `nextTabId` are persisted; `partialize` reuses its previous projection while both are referentially unchanged, and the storage adapter skips unchanged writes.
- Consumers reacting to output must subscribe to `buffers`, not `sessions`.

## Git / PR Stores

### `useGitStore.ts`

Centralized active-runtime, per-directory Git cache.

- Source of truth: `directories: Map<string, DirectoryGitState>` holding repo detection, status, branches, log, identity, diff cache, per-directory loading flags, and freshness timestamps.
- Prefer `ensureStatus()` and `ensureAll()` (both dedupe in-flight requests); loading state is per-directory, never global.
- Runtime reset replaces live entries with that runtime's persisted branch seeds and invalidates old completions.
- Status, branches, log, identity, repository probes, and prefetch diffs commit through runtime + per-channel generations; status mutations advance a revision so older refreshes cannot undo optimistic or confirmed index changes.
- Branch persistence is versioned, bounded, runtime-scoped, and claims the legacy cache once.
- Diff cache enforces per-directory and aggregate count/UTF-8-byte limits and rejects oversized single entries.

### `useGitRepositorySelectionStore.ts`

- Stores the IDE's selected Git top-level directory by opaque workspace identity as a workspace-scoped view preference — separate from the product workspace and from a Thread Run's source directory.
- Choosing a nested repository never switches the Explorer, editor, terminal, or execution source; restored/selected repos are validated to stay inside the active workspace.
- Git diff paths are repository-relative and must be rebased through the selected repository root before becoming workspace resource IDs.

### `useGitHubPrStatusStore.ts`

Centralized PR cache keyed by a collision-safe tuple of runtime, directory, branch, and requested remote.

- Each entry stores PR status payload, loading/error state, initial-resolution flag, refresh timestamps, watch count, runtime params, and resolved identity.
- `ensureEntry()` initializes lazily; `setParams()` attaches runtime context and advances entry revision so stale queued/successful/failed requests cannot overwrite a newer authority.
- `startWatching()` / `stopWatching()` are for live visible PR consumers only; `refreshTargets()` handles one-shot multi-target bootstrap without enabling live watches.
- Runtime reset disposes timers, watchers, API refs, and request ownership while keeping inert namespaced snapshots isolated.
- Persisted cache is versioned, TTL-filtered, and bounded for page-refresh continuity only (not background syncing).

## Ownership Rules

Breaking these rules reintroduces idle CPU churn, stale UI, or rerender fanout:

1. No broad `directories` or `entries` subscriptions in feature components.
2. No root pollers for Git or PR, and no broad idle sweeps across many directories.
3. Prefer store `ensure*` actions over direct runtime API calls from views.
4. Visible consumers drive refresh; hidden consumers do not (closed context panel / hidden sidebar / hidden file tree must not run live Git/PR work).
5. Header must not depend on the PR store.
6. Thread Catalog refreshes preserve Host + request-generation ownership; Catalog summaries never replace authoritative Run, history, or submission state.

## Selector Rules

Use leaf selectors so Zustand's per-`set` selector checks stay referentially stable:

- **Good**: `useGitStatus(directory)`, `useGitBranches(directory)`, `useGitBranchLabel(directory)`, `useGitRepoStatusMap(directories)`, `usePrVisualSummaryByKeys(keys)`
- **Bad**: `useGitStore((s) => s.directories)`, `useGitHubPrStatusStore((s) => s.entries)`, render-time scans over all PR entries for one project badge

## Performance Rules

1. **Preserve unaffected references**: Updating directory `A` must keep derived references for directory `B` stable where possible.
2. **Per-entity loading state**: Never add global `isLoading*` flags for keyed cache work.
3. **Avoid hidden work**: Only visible surfaces (e.g., `PullRequestSection`) acquire watches; hidden sidebars do not.
4. **One-shot hints over polling**: Refresh the affected directory after an authoritative mutation result (never on streaming previews/arguments).
5. **Preserve `diffStats`**: Light status fetches may omit `GitStatus.diffStats`; never erase richer existing `diffStats`, and ensure a full status fetch when a view needs per-file `+/-` stats.
6. **Keep diff cache bounded**: Do not raise diff-cache limits casually.

## Refresh Model

- **Git**: `GitView` / `DiffView` ensure current-directory state when visible; explicit Git actions refresh status/branches/log; successful file-mutating tools issue a one-shot refresh hint; no root polling.
- **PR**: Visible PR consumers acquire/release their own watch; one-shot discovery never starts a background watch; header does no live PR work; no background sweeps outside visible demand.

## When Editing These Stores

Before changing store shape or selectors, verify:

1. Keyed by the right identity (Host, directory, Thread/branch, root)?
2. Forces unrelated consumers to rerender?
3. Visible-demand-driven rather than background-driven?
4. Existing store cache already covers this data?
5. Fetch ownership lives in a store action rather than duplicated in a component?

## Validation Checklist

After meaningful Git/PR or Thread store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view loads status, branches, log, and identity.
3. Diff view opens the correct file and stays in sync.
4. Thread navigation preserves the actual Host and branch.
5. Failed or unknown multi-run attempts retain their Threads and worktrees.
6. Hidden surfaces do not reintroduce live background work.
