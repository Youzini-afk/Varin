# @varin/protocol

Varin protocol types, schemas, and event/method definitions.

## Harness events and methods

### Broker events

| Event | Direction | Description |
|-------|-----------|-------------|
| `harness.request` | pi-host → host | Request a harness service; session identity comes from the broker actor, never this payload |
| `harness.cancel` | pi-host → host | Abort an in-flight request and/or the explore query it belongs to |
| `harness.respond` | host → pi-host | Response to a harness request |
| `workspace.mutation.request` | pi-host → host | Request a file mutation (before/after) |
| `workspace.mutation.respond` | host → pi-host | Accept/reject a mutation request |

### Harness service methods

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `shell.exec` | `{ command, cwd?, waitMs?, toolCallId? }` | `ShellExecResult` | Start/idempotently recover a shell command; the wait window only decides foreground vs background |
| `shell.read` | `{ id, offset?, length?, waitMs? }` | `OutputSlice & { running, exitCode? }` | Read immediately, page history, or wait for new background output/exit without stopping the process |
| `shell.write` | `{ id, text }` | `{ accepted }` | Write to background shell stdin |
| `shell.kill` | `{ id }` | `{ killed }` | Kill a background shell |
| `output.store` | `{ text, label? }` | `{ ref: OutputRef, total }` | Store large output for the current Host generation |
| `output.read` | `{ handle, offset?, length? }` | `OutputSlice` | Read stored output |
| `search.content` | `{ pattern, limit?, contextLines? }` | `SearchContentResult` (`filesDropped?` / `fileCoverage?` only in explore candidate mode) | Content search |
| `document.readSource` | `{ path }` | disk sentinel or fixed draft bytes | Select the authenticated source for native `read` without changing its schema |
| `document.surfaceWrite` | `{ path, action, content?, edits? }` or `{ changes[] }` | disk sentinel, or per-path applied/conflict/unavailable/compensated/needs-attention | Shared surface-aware plan for native `write` / `edit` / `apply_patch` |
| `document.pathOverlay` | `{ path, pattern? }` | disk sentinel or fixed relative path entries | Content-free fixed dirty paths and virtual directory ancestors for native `find` / `ls` |
| `document.branchWrite` | `{ path, action, content?, edits?, expectedRevision? }` or `{ changes[], expectedRevision? }` | disk sentinel, committed revision, conflict, or rejection | Commit text mutations to an unpublished WorkingState delta |
| `workingBranch.ensureMaterialized` | `{}` | virtual / materialized path / failed | Freeze the current branch revision and switch the Run to a real directory |
| `fs.lock` | acquire `{ paths[], timeoutMs? }`; release `{ leaseId }` | `{ held, leaseIds[] }` / `{ held: false, released }` | Acquire an ordered canonical path batch or release one owner-bound lease |
| `lsp.diagnostics` | `{ path, waitMs? }` | `DiagnosticsResult` | Bind the path's current disk revision and wait for the publication computed from it |
| `lsp.diagnosticsSnapshot` | `{ path }` | `DiagnosticsResult` | Get diagnostics snapshot |
| `lsp.symbols` | `{ path, query }` | `LspNavigationResult` | Find workspace symbols using the path's language provider |
| `lsp.definition` | `{ path, line, character? }` | `LspNavigationResult` | Find a definition at a one-based position |
| `lsp.references` | `{ path, line, character? }` | `LspNavigationResult` | Find references at a one-based position |
| `lsp.hover` | `{ path, line, character? }` | `LspNavigationResult` | Read type/signature documentation at a one-based position |

`LspNavigationResult` and `DiagnosticsResult` carry the `revision` and `source` (`disk | surface-draft`)
their answer was computed from. Navigation also lists `unpinnedPaths`: files whose positions the
language server read itself, which LSP cannot attribute to a version.
| `web.fetch` | `{ url, render? }` | `WebFetchResult` | Fetch a URL (SSRF-guarded) |
| `web.search` | `{ query }` | `WebSearchResult` | Web search |
| `zone2.assemble` | `{ sinceTurn, branchEntryIds, memoryMode, afterEventId?, query?, contextUsage? }` | `{ content, eventCursor }` | Assemble branch-aware, cursor-based Zone 2 context |
| `compaction.before` | `{ firstKeptEntryId, tokensBefore, branchEntryIds, removedEntryIds, mode }` | `CompactionBeforeResult` | Verify keeper coverage before optional takeover |
| `compaction.after` | `{ summary, firstKeptEntryId, tokensBefore }` | `{ acknowledged }` | Post-compaction hook |
| `todo.upsert` | `{ items, branchEntryIds, confidence?, confirmed? }` | `{ text, confirmed?, askedConfirmation }` | Upsert the active branch plan after pi-host confirmation when needed |
| `recall.search` | `{ query, k? }` | `{ text, results[] }` | Recall search |
| `memory.blocks.get` | `{ branchEntryIds }` | `{ blocks[] }` | Resolve the closest visible block revision on the active branch |
| `memory.blocks.apply` | `{ cursorTurn, branchEntryIds, coveredEntryIds, ops[] }` | `MemoryApplyResult` | Atomically validate branch-local keeper operations and update coverage after full acceptance |
| `explore.search` | `{ question, anchors?, paths?, limit? }` | versioned snippets (optional `unit` / `structure`) + source issues + not-requested candidates + OutputRef | Algorithm-only facade over the same query engine: start original sources, freeze views, finish |
| `explore.query.start` | `{ question, anchors?, paths?, limit?, budgetMs?, reserveForJudge? }` | `{ queryId, vocab, deadlineAt, sources }` | Pin actor/scope/input source and start original lexical, graph, and semantic work |
| `explore.query.plan` | `{ queryId, plan }` | `{ launched, reused, sources }` | Submit grouped search expressions; they launch real searches on this query |
| `explore.query.views` | `{ queryId }` | candidate views before pack | First-wave wait, then freeze pre-present units for the candidate model |
| `explore.query.select` | `{ queryId, groups }` | accepted/rejected/gaps | Validate view/range identity and extract current source |
| `explore.query.followup` | `{ queryId, searches?, locates?, gaps? }` | new views + reused queries | Optional gap searches and mechanical locates; dedupes launched queries and reads |
| `explore.query.finish` | `{ queryId }` | same as `explore.search` | One presentation of already-decided excerpts |
| `explore.query.cancel` | `{ queryId }` | `{ cancelled }` | Abort query work; late results cannot revive it |
| `explore.query.release` | `{ queryId }` | `{ released }` | Drop the short-lived query after the public explore tool ends |
| `related.query` | `{ anchor }` | file-level defines / imports / importers / connection endpoints + query-time `roles` + source status | Symbol-graph topology for a path or name; not `lsp.references`. File roles are a query decoration, not graph facts |
| `surface.snapshot.commit/release` | content-free `AgentInputContext` | lifecycle acknowledgement | Bind or release an opaque Documents snapshot after input delivery |
| `thread.dispatch` | `{ task, preset?, input?, scope?, worktree? }` | `ThreadDispatchResult` | Dispatch a sub-agent thread; `input: "inherit"` fixes the parent's committed input at dispatch |
| `thread.list` | `{ ids?, full? }` | `ThreadListResult` | List threads (incremental) |
| `thread.wait` | `{ ids?, timeoutMs? }` | `ThreadWaitResult` | Block until thread state change |
| `thread.send` | `{ threadId?, to?, message, from, kind?, context?, requestId?, replyTo? }` | `ThreadSendResult` | `inform` (default) delivers only — held durably for non-running targets, never starts a Run; `request` wakes a waiting target and on a settled thread starts a new Run (`context`: `continue` resumes the retained session, `fresh` rebuilds the input) or parks behind the shared root budget (`delivery: "scheduled"`). `to: "parent"` targets the caller's own parent; `requestId` is the idempotency key; `replyTo` answers a request and completes the requester's wait |
| `thread.read` | `{ threadId, what?, since? }` | `ThreadReadResult` | Read thread notes/report/steps |
| `thread.merge` | `{ threadId, resultRevision? }` | `ThreadMergeResult` | Integrate a fixed native result and identify disk, marker, or editor-surface conflicts |
| `thread.update` | `{ threadId, resultRevision? }` | `ThreadUpdateResult` | Rebase the calling thread's working baseline onto a selected parent result revision; keeps the thread's own deltas, merges clean text edits, and reports divergent paths as conflicts |
| `thread.kill` | `{ threadId, keepWorktree? }` | `ThreadKillResult` | Kill a thread |

`agent.prompt`, `agent.steer`, and `agent.followUp` accept an optional
content-free `inputContext`. UI surfaces capture dirty document bodies through
the authenticated Documents API first; the runtime method carries only the
opaque Host reference or an unavailable dirty-path set. Omission means disk.

### Thread events

Two host events, both carrying state only — never message bodies.

| Event | Direction | Description |
|-------|-----------|-------------|
| `harness.thread.changed` | host → clients | Thread projection changed (`Thread` plus its current `ThreadRun`) |
| `harness.thread.done` | host → clients | Thread completed; carries the `ThreadReport` |

The registry raises them through its `onThreadChanged` / `onThreadDone`
callbacks. `onThreadDequeued` is a registry callback only, not a protocol
event: it asks the host to spawn a child session for a thread that was
waiting on a concurrency slot.

### Thread lifecycle

```
Thread.lifecycle: queued → active → settled → archived
Thread.attention: none | user | permission | stalled | looping
Thread.integration: none | dirty | merge-ready | conflict | merged
ThreadRun.workerState: starting → running → exited | lost
ThreadRun.outcome: success | failure | cancelled | lost
```

These axes are intentionally independent: a successful Run may leave its
Thread `merge-ready` or `conflict`, while a lost Run leaves durable work and
attention intact. `ThreadLaunchManifest` freezes the preset's tool allowlist,
worktree mode, scope, prompt fragment, parent-block snapshot choice, parent
concurrency, and the Host-owned persistent editor-draft baseline identity.
The baseline body remains in WorkingState rather than the catalog or model
arguments, so queued and restarted Runs do not depend on the ephemeral surface
snapshot. Reaching a terminal Run frees a concurrency slot and may promote the
oldest queued Thread.

### ShellExecResult variants

| Kind | Fields | Description |
|------|--------|-------------|
| `completed` | `exitCode, durationMs, cwd, stdout, stderr, handle?, shown?` | Command finished |
| `background` | `id, waitedMs, cwd, outputSoFar` | Command backgrounded after waitMs |
| `spawn-failed` | `reason, interpreter, hint` | Shell could not start |

### HarnessSettings

Most fields are resolved while the session runtime is assembled. Context
preparation is the intentional live exception: the user-owned global default
is read on each request boundary so toggles apply without a worker restart.

```typescript
interface HarnessSettings {
  tools: Partial<Record<string, boolean>>;   // per-tool switch, default true
  shell: "auto" | "git-bash" | "powershell" | "wsl";
  output: { visibleBytes: number };          // default 32768
  bash: { waitMs: number };                  // configurable foreground wait; default 10000
  models: Partial<Record<HarnessModelRole, ModelSelection>>;
  dispatch: { concurrency: number; askBefore: Partial<Record<string, boolean>> };
  knowledge: {
    eventRetentionDays: number;
    autoOrganize: { workspace: boolean; user: boolean; bot: boolean };
  };
  context: { backgroundPreparation: boolean; preparationWaterline: number }; // user-only
  review: { enabled: boolean; gate: boolean }; // automatic review, default off (D-285)
  web?: {
    render?: boolean;
    search?: { provider: "brave" | "exa" | "tavily" | "jina" | "searxng"; endpoint?: string; credentialRef?: string };
    domains?: { allow?: string[]; block: string[] };
  };
  permissions?: { mode?: PermissionMode };   // default "normal"
}
```

Legacy persisted `memory` settings remain readable as a migration input only
(`memory.mode: "off"` maps to `context.backgroundPreparation: false`); new
writes use `context`. `SessionSnapshot.harness.context` reports the resolved
preparation state and the latest prepare/commit phase or failure when the
runtime supports the Harness.

Thread-runtime availability is not a user setting. The Application Host
advertises `capabilities.harnessThreads` in the private Host handshake; only
then does pi-host register the seven thread tools. Child sessions receive their
frozen preset or inherited model and active tool list in `session.create/open`.
The same handshake owns `harnessLspNavigation`, `harnessWebRead`, and
`harnessWebSearch`. `harnessWebRead` means the Host permits a configured
session-local reader model to consume its guarded `web.fetch` result; model and
credential execution remains in pi-host. `harnessWebSearch` advertises the
structural Host service. The provider identity, render permission, and domain
policy are frozen from Pi settings for one worker generation; `websearch` is
registered only when that session has a configured provider. Search credentials
stay in Pi auth and are resolved per request, so revocation does not require a
worker restart and never reuses a cached key.

## Exports

- `harness.ts` — `HarnessServiceMap`, `HarnessMethod`, `HarnessError`, `HarnessRequestData` (no session identity; carries only the optional per-request `timeoutMs`), `HarnessActorIdentity`, `HarnessActorContext`, `HarnessCapability`, `HARNESS_METHOD_CAPABILITY`, `HARNESS_MAX_REQUEST_TIMEOUT_MS`, `OutputRef`, `OutputSlice`, `ShellExecResult`, `DiagnosticsResult`
- `language-id.ts` — `languageIdForPath`, `editorLanguageIdForLanguage`. Single language identity for the Host language views, provider matching, and the editor; a second table split one file across two sessions and hid extensions from one side
- `harness-settings.ts` — `HarnessSettings`, `HarnessModelRole`, `ModelSelection`, `mergeHarnessSettings`
- `harness-presets.ts` — Execution preset catalog: `PresetId`, `ExecutionPreset`, `EXECUTION_PRESETS`, `resolvePresets`, `buildTeamPrompt`. Shared because pi-host builds the `dispatch` team prompt from the resolved presets while the host builds threads from the same definitions
- `harness-threads.ts` — orthogonal `Thread` / `ThreadRun` types, immutable `ThreadLaunchManifest` (with `inputOrigin`/`inheritedContext`), `ThreadRunFrozenConfig` (`inputOrigin: task|inherit|continue|fresh`), observer cursor, seven thread service DTOs, and `DEFAULT_TTL_TABLE` telemetry for the opt-in keepalive experiment (not a default wait schedule)
- `harness-fresh-input.ts` — shared `assembleFreshInput`/`minePiBranchEntries` for a `fresh` Run's seed input (task, still-valid requirements, selected results, open items, history anchors); used by pi-host for in-session rebuilds and by the Application Host for settled-Thread continuation
- `harness-tools.ts` — Tool-specific protocol types, `HARNESS_TOOL_META`
- `utf8.ts` — browser-safe UTF-8 byte slicing used by Host output stores and pi-host truncation; returns `nextOffset` / `eof`
- `permission-gate.ts` — `PermissionPolicy`, `PermissionRule`, `evaluateGate`, `isHighRisk`, `HIGH_RISK_PATTERNS`, `defaultRules`, `mergePolicies`
- `types.ts` — `AgentInputContext` (disk or content-free surface snapshot reference), `SessionStats` (includes `toolErrors`, `toolRetries`, `outputBytes`, `cacheHitRatio`)
