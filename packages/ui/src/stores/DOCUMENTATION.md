# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Not all state in the UI belongs here.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (for example directory, branch, Thread identity)
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
Plan, task and other content updates do not write these preferences. Consumers choose display defaults
for missing preferences; this store does not own plan, task, source or execution state.

### Thread / project coordination stores

- `useProjectsStore.ts` owns navigation-project metadata.
- `useThreadStore.ts` owns the selected native Thread/branch and rebuildable Catalog summaries.
- `useThreadDraftStore.ts` owns in-memory composer drafts and pending input receipts.
- `useMultiRunStore.ts` owns the UI's explicit multi-run launch intent and per-attempt status.

`threadHostKey` includes both endpoint and selected Host identity. `threadIdentityKey` adds the real
Thread and branch. Catalog binding captures an epoch, aborts observation on Host replacement and
rejects stale requests. Selected branches are validated against the actual Catalog; a remembered label
or previous Host's ID is insufficient. Metadata revisions, activity/read cursors and tombstones merge
monotonically so an original command receipt cannot overwrite a newer event projection.

`ThreadSidebar` filters Bot-owned conversations using each authoritative summary's `bot_id`, and
sorts visible conversations by pin, update time and identity. Archive and delete are different commands.
Deletion hides navigation through a retained tombstone; accepted execution and resource cleanup remain
with their original owners. `markRead` acknowledges only the cursor actually presented.
The shared sidebar catalog shows passive completion/failure reminders only for root conversations.
Child unread cursors remain intact; their work stays visible without a completion bell in navigation.

The store's creation key survives an uncertain response. Creating a Thread does not itself start a Run.
A selected workspace path is staged on the new Thread draft; actual source resolution/preparation uses
its authenticated Host and Documents owner. `ThreadProjection` owns live snapshot/progress observation,
not the Catalog summary array.

`useThreadDraftStore` retains text, images, PDF snapshot references, model/thinking choice, delivery mode,
prepared source and the exact pending input. It is never persisted. Draft keys include Host and
Thread/branch. Submission and retry ownership are documented in
[Composer](../components/chat/composer/DOCUMENTATION.md); a failed observation cannot erase an accepted
input or restore already-acknowledged draft material.

`useMultiRunStore` retains stable command keys and prepared source identities for each selected model.
Stopped launching, failed preparation and unknown delivery keep existing Threads and worktrees.
Unconfirmed worktree creation is not automatically replayed. A retry must preserve the original launch
intent rather than deleting resources and recreating an apparently clean batch.

Permission grants remain authoritative in the Application Host; renderer preferences are not a second
permission store. See [the security contract](../../../../docs/security.md).

Shared safe storage treats durable failures per key. A quota or access failure creates an ephemeral
override or tombstone for that key without disabling unrelated reads and writes. Later writes retry the
durable backend. Deferred adapters retain failed operations for a later flush; malformed Zustand JSON
is removed and treated as missing so hydration can recover.

Project and UI settings use successful settings synchronization as authority. Omitted fields in a
complete snapshot reset to canonical client defaults, including an omitted project list becoming empty.
Transport or load failure dispatches no synchronization event and preserves current state. Partial save
responses do not clear unrelated in-memory preferences or local mirrors.

`usePreferencesStore` owns speech preferences for Settings and dictation. Recording start reads the
current model/provider/language from that store; the Host supplies the downloadable STT catalog and
supported languages. Shared defaults select Whisper large-v3 Turbo without replacing a saved choice.

Inline-comment drafts, resource-library views and other scoped stores retain their own persistence
contracts. File-search cache and in-flight keys include Host plus directory and are cleared on endpoint
reset. Do not infer that every chat-related store has the same persistence or lifecycle behavior.

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
workspace and from a Thread Run’s source directory. It stores the resolved Git top-level directory by
opaque workspace identity, so choosing a nested repository never switches the Explorer, editor, terminal,
or execution source. The IDE validates that a restored or newly selected repository remains inside
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

### Native submission and connection recovery

`lib/agent-runtime/threadInputDelivery.ts` keeps one observation per Host generation, Thread/branch and
original command key. Submission, enqueue and child continuation retain their exact captured input
while delivery is unknown. Only an explicit first-attempt pre-admission rejection releases that intent;
a timeout, lost response or view closure is not execution failure.

`ThreadProjection` reconstructs snapshots from the original durable event cursor. Transient stream
progress is scoped to the active Run and stream sequence. A gap or closed connection clears that
presentation and refreshes history; it never resends input, stops the Run or manufactures idle state.

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
9. Thread Catalog refresh must preserve Host and request-generation ownership.
10. Catalog summaries must not replace authoritative Run, history or submission state.

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
- render-time scans over every PR entry for a single project badge

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
- hidden sidebar should not watch PRs

### 4. Prefer one-shot event hints over polling

Refresh the actual affected directory after an authoritative mutation result. A tool argument or
streaming preview is not proof that files changed. Prefer one-shot invalidation with a visible consumer
over a new background polling loop.

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

- real visible PR consumers acquire and release their own watch
- one-shot discovery does not establish a background watch
- no live PR work for header
- no background PR sweeps outside visible demand

## When Editing These Stores

Before changing store shape or selectors, ask:

1. Is this keyed by the right identity (Host, directory, Thread/branch, root)?
2. Will this force unrelated consumers to rerender?
3. Should this be visible-demand-driven instead of background-driven?
4. Is there already a store cache for this data?
5. Am I duplicating fetch ownership in a component when it should live in a store action?

## Validation Checklist

After meaningful Git/PR store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view still loads status, branches, log, identity.
3. Diff view still opens the correct file and stays in sync.
4. Thread navigation preserves the actual Host and branch.
5. Failed or unknown multi-run attempts retain their Threads and worktrees.
6. Hidden surfaces do not reintroduce live background work.
