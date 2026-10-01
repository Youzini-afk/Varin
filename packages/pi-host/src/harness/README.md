# Agent Harness — pi-host Side

The pi-host harness tools are custom tools registered in the Pi session's
`customTools` array. They call host-side services via `HostServicesBridge`.

## Tools

| Tool | Description | Host Service |
|------|-------------|--------------|
| `bash` | Execute shell commands (PTY, persistent shell) | `shell.exec` |

> **Note**: Under PTY-based shells (git-bash, wsl, bash), stdout and stderr
> are merged into a single stream. The `stderr` field in `ShellExecResult`
> will be empty; all output appears in `stdout`. PowerShell is the only
> interpreter that separates the streams (but it is not yet wired).
| `read` | Pi-native paging/truncation/images with fixed editor-draft or working-branch source selection | `document.readSource` |
| `find` / `ls` | Pi-native glob/list rendering with fixed dirty-only or exclusive working-branch paths | `document.pathOverlay` |
| `grep` | Bounded rg plus fixed editor-draft overlay, or exclusive working-branch corpus | `search.content` |
| `apply_patch` | Codex-format multi-file patch (OpenAI only); Varin mutations go through Host branch/surface write authority | `document.branchWrite` + `document.surfaceWrite` |
| `get_output` | Retrieve stored/shell output by handle; optionally wait for new bytes or exit | `output.read` / `shell.read` |
| `write_to_process` | Write stdin to background shell | `shell.write` |
| `kill_shell` | Terminate a background shell | `shell.kill` |
| `diagnostics` | Get LSP diagnostics for a file, bound to its disk revision | `lsp.diagnosticsSnapshot` |
| `symbols`, `definition`, `references`, `hover` | Navigate a real language server with one-based positions, bound to this turn's fixed text | `lsp.*` |
| `explore` | Locate and read related context in one call; `question` plus optional literal `anchors` | `explore.query.*` (algorithm-only `explore.search` is the same engine) |
| `related` | File-level import topology and connection endpoints from the symbol graph | `related.query` |
| `websearch` | Default keyless Exa search with disclosed Parallel failover, or the user's explicit search provider; batched query/objective/URL/page items with per-item status | `web.search` |
| `webfetch` | Read a source URL or a pinned `snapshot_id`, find literal text, expand extracted Markdown line ranges, or read structural positions (page/section/table/figure/appendix) where the parser supports them | `web.fetch` |
| `document_read` | Read an authorized local PDF or pinned snapshot through independent overview, text, page-image, and structure views; page images include actual PNGs and optional normalized crops | `materials.read` |
| `research_search` | OpenAlex / Semantic Scholar paper search, details, and paged relation expansion (references/citations/related) | `research.search` |
| `materials` | Named collections of snapshot/URL/paper references with collection-scoped keyword search and explicit cross-thread `share` grants | `materials.collections` |
| `research_decide` | Batch fast-decision scoring/selection over real URL/snapshot/paper/section/query candidates | `research.decide` |
| `dispatch`, `threads`, `wait`, `send`, `read_thread`, `merge`, `kill` | Operate Host-owned durable child threads | `thread.*` |
| `submit_facts` | Retrieval child delivers Host-validated facts | `thread.facts.set` |
| `experiment` | Submit and manage attempts, page logs and collected text artifacts | `experiment.submit/list/get/logs/artifact/wait/cancel/collect` |
| `resources` | Read machine capacity, commitments, observations and queued work | `resource.list` |
| `research_source` | Register or inspect provenance and retained source objects | `source.register/list` |

Research tools register only when the Host advertises their actual services and the session's frozen
tool selection permits them. Queries are native read actions; starting/stopping attempts retains the
process permission gate. A resource query does not confer process-control capability. Experiment
output remains available through its attempt/artifact identity even when it was produced outside the
Agent's own working directory. See the Host harness documentation and current status for backend and
recovery evidence; the optional backend resolver alone is not a delivered remote scheduler.

## Registration

`HostController` admits `harness.embed` in the ordinary request queue, after preceding configuration and
session lifecycle work, then releases the queue while its provider request is in flight. Independent
embedding batches can use the Host index scheduler's configured concurrency. Batch identity reservations,
queued cancellation and actual fetch cancellation remain in `BackgroundInferenceRuntime`; cancelling one
batch does not cancel another. This does not move inference ahead of lifecycle admission or alter the
configured concurrency setting.

Tools are selected by `selectHarnessTools()` during `SessionHost.#createRuntimeFactory()`.
Web search is available whenever the Host advertises its search service, unless the user disables
`harness.tools.websearch`. It does not require a search key or reuse model-account search. Empty results
are normal observations; provider errors remain errors. Tool cancellation reaches the Host, and returned
details preserve the actual provider, any failover notice, and source URLs for the existing source panel.
`webfetch` accepts `find` and inclusive one-based `start_line`/`end_line` over extracted Markdown;
it uses the same Host fetch/cache and does not invoke a reader model unless a prompt and reader are configured.
`document_read` is included only after the Host handshake advertises `harnessDocumentRead`; otherwise the
tool is absent. It accepts exactly one `path` or `snapshot_id`; the Host authorizes local paths and pins
their PDF bytes into the same material authority used by network snapshots. Start with `view: "overview"`
to get source hash, page geometry and text status without extracting the full text. `text`, `page-image`,
and `structure` are separate requests; page images work without text/structure extraction. Select a page
or page range for focused reads, and pass regions in normalized top-left coordinates on the rotated page.
`parser: "docling"` and `ocr: true` explicitly request optional Host components; unavailable components
remain unavailable while native text and page images can still be read. Reuse the returned current
`snapshot.snapshotId` for later reads. Its `sourceHash` and page/region links identify the original PDF;
the `varin-material://` link is intercepted by the UI and reopens this reader in the same session. An
optional analysis id identifies one derived structure result. The Host-owned user setting
`harness.documentReading` configures direct executable paths/language, not model-supplied shell commands.
The read override for Pi's built-in `read` is included only after the Host handshake advertises
`harnessDocumentRead`; otherwise Pi's built-in `read` remains registered. The
same-name `find` and `ls` overrides require `harnessDocumentPathOverlay` and
are independently disabled by `settings.tools.find` / `settings.tools.ls`.

```typescript
const customTools = selectHarnessTools(settings, {
  bridge: hostServicesBridge,
  sessionId,
  cwd,
  documentReadAvailable: harnessDocumentReadEnabled,
  documentPathOverlayAvailable: harnessDocumentPathOverlayEnabled,
  // other negotiated capabilities and runtime dependencies
});
```

## Extensions

- `createToolResultTruncationExtension` — truncates large non-shell tool results,
  stores full text via `output.store`, adds `[output: N bytes]` marker. `bash`
  and `get_output` keep Host-organized display and are not head/tail cut again.
- `createHarnessCounterTracker` — tracks `toolErrors`, `toolRetries`,
  `outputBytes`, `observationCalls`, and `cacheHitRatio`. Auxiliary per-model usage
  aggregation was removed in D-080; ordinary Pi session cost and token statistics remain unchanged.
- `createPermissionGateExtension` — Varin's sole interactive `tool_call`
  permission authority. It covers the actual Pi registry (Harness overrides,
  built-ins, MCP and package tools), asks Host `permission.inspect` to bind
  canonical workspace resources, keeps session grants scoped to the normalized
  source/action/resources, and emits credential-free decisions through
  `permission.audit`. Unknown or incomplete third-party actions ask; Smart mode
  can auto-allow only ordinary complete asks. `/varin-permissions` revokes
  remembered session grants.
  An allowed call also returns the Host-canonical path/thread effects discovered
  by `permission.inspect`; Pi merges them with the owned tool's effect declaration
  before scheduling. Denied calls never run the tool's resource-preparation hook.
- Automatic memory formation runs exclusively through the Host-side background
  organizer (`harness.memoryOrganize`) over durable session/run source material.
  There is no per-message suggestion extension; explicit user marks still write
  through `memory.remember`/`context.putKnowledge`.
- `createContextGuidanceExtension` — adds stable source and collaboration guidance
  to the system prompt. It does not fetch dynamic material at turn start.
- `createRequestContextInjector` — prepares environment deltas and a complete
  authorized teammate snapshot before every actual model request, including tool
  continuations. Environment facts are appended to native Pi history only when
  the provider starts responding, with receipts acknowledged to Host; a stream
  that fails before starting does not claim delivery. The current teammate table
  remains transient and unchanged teammates remain visible. Unavailable and empty
  observations are distinct. No snapshot receipt or status-summary model is used.
- `createContextPreparationExtension` and `attachContextRequestBoundary` — account
  for the full candidate input (including both additions) before admission, reuse
  a fixed background summary candidate and commit through Pi's SessionManager.
  Compaction refreshes observations against retained raw-history receipts. History
  grows without replacing old facts; native tool/message pairing and continuation
  remain Pi's responsibility. The retired continuous keeper/takeover path is absent.
  Both manual and automatic preparation use an internal broker-owned compaction
  process. It sees the complete replaced history and either the retained originals
  or explicitly attributed reference excerpts. Its Pi Agent loop can query frozen
  history, output handles and related records without consuming the parent cursor.
  Every worker request includes query results in its capacity check. Active input
  keeps only the newest compaction summary; superseded summaries remain in the
  native journal. Cancellation retires both the worker and its Host queries.

## HostServicesBridge

The `HostServicesBridge` sends `harness.request` events to the host via
the broker. The host's `HarnessRouter` dispatches to the appropriate
service and responds via `harness.respond`. Worker payloads do not carry a
session identity; the broker pins identity after `session.create/open` and
adds the trusted Actor envelope consumed by the Host.

SessionHost also gives the bridge the latest accepted `AgentInputContext`.
That object contains only disk/source state, dirty paths, and an opaque Host
snapshot reference; editor text never enters the worker request. Prompt,
steer, and follow-up temporarily select a new context, commit it after Pi
accepts the input, and restore/release it when delivery fails. Snapshot
bookkeeping failure after `agent_start` degrades the source to unavailable and
cannot turn an already-running prompt into a failed submission.
`grep`, `explore`, the Host-advertised same-name read/find/ls overrides, and the `lsp.*` navigation
tools consume this same fixed source. An expired related dirty source is unavailable, never a disk
fallback. Writing a path ends the draft's authority for it: after the journal acknowledges a
successful `write` / `edit` / `apply_patch`, every one of those tools reads that path from disk again,
so an agent reads back its own write. Navigation answers report the revision and source they were
computed from; positions in files the language server read itself are marked unpinned. `diagnostics`
is deliberately different: it describes the file as written to disk, because it is feedback about
what an agent just wrote.

```
pi-host: bridge.request("shell.exec", { command, cwd, waitMs })
   → emit("harness.request", { method, params, requestId })
   → host: HarnessRouter.processEvent() → ShellSupervisor.exec()
   → emit("harness.respond", { requestId, result/error })
   → pi-host: bridge resolves promise
```

`bash(waitMs: 0)` still waits for Host acceptance and returns the real terminal-runtime
identity; it does not synthesize an id or cancel the process. Omitted `waitMs` uses the
session's resolved `harness.bash.waitMs` (10 seconds by default). The bridge deadline is
derived from that observation window, while the process has no implicit execution deadline.
The 10-second soft default was selected from this workspace's 7H runs: focused checks
completed in roughly 1–9 seconds while package type-checks crossed the boundary and are
better handed back as background work. It is configurable and is neither a hard limit nor
a latency claim for other machines.
`get_output(waitMs)` waits only when an incremental shell read has no unread bytes and no
terminal fact yet. Cancelling that observation sends `harness.cancel` and leaves the shell
running; `kill_shell` remains the process termination operation.
The Pi `toolCallId` is carried to `shell.exec` as the acceptance identity. A lost
response can be recovered with `get_output(toolCallId)` or an idempotent retry of that
same call; Host never starts a second process for the same identity and command. This
map is session-process state, so an ordinary shell still does not claim Host-restart
reattachment or durable logs.

Harness-owned tools also carry a `prepareExecution` contract into Pi's real batch executor.
The hook runs after schema validation and the native permission gate. Canonical file effects
order overlapping read/write calls, multi-file patches declare their complete path set, and
shell/thread controls use their actual target identity. Independent resources overlap. An
unknown third-party sequential tool stays an ordered barrier, with calls on either side still
parallel inside their side. The Host Documents/WorkingState gates remain the final mutation
and alias authority; scheduling does not replace revision checks or recovery.
The upstream seams are tracked in `patches/@earendil-works%2Fpi-agent-core@0.85.1.patch`
and `patches/@earendil-works%2Fpi-coding-agent@0.85.1.patch`: the core builds the
resource dependency graph in the actual tool-call batch path, while coding-agent
preserves effect declarations through `ToolDefinition` wrapping and carries the
permission hook's Host-authoritative plan. There is no second Agent loop.

## Path Locking

The Host still exposes `fs.lock` for callers that need an explicit critical section. Its production
implementation delegates the already-authorized Documents resource to the Rust kernel `file.lease.*`
authority; the Host does not keep a second in-memory production lock table. Varin `write`, `edit`, and
`apply_patch` do not wrap `document.surfaceWrite` in `fs.lock`, because Documents acquires the same kernel
resource gate internally and nesting the two would self-deadlock. The `withPathLock` wrapper remains only
for callers that perform work outside the Host Documents mutation path.

## Child Session Launch

The Application Host advertises `harnessThreads` in the private Host
handshake. Thread tools are absent when that capability is missing. A real
child launch supplies its resolved role model and tool allowlist to
`session.create/open` before Pi constructs the AgentSession; read-only roles do
not merely rely on a prompt asking them not to write. `submit_facts` registers
only when that frozen allowlist includes it, so the root session cannot submit
retrieval facts. `session.create/open`
receives the Documents workspace id for the current scratch or materialized
cwd (execution identity). Thread catalog, WorkingState, and parent/child
lifecycle stay on the original owning workspace; Host session bindings carry
that identity across register, dispatch, Zone 2, and lost resume. The role fragment and
scope stay in the first task message, keeping the base system prefix stable;
scope also travels in the broker-owned Actor envelope. Host path services,
including fixed-source read, enforce it. This is not an OS sandbox over shell
text, third-party tools, or the built-in read used when the Host override is
unavailable or disabled.

## Mutation Journal Integration

`createWorkspaceMutationJournalTools` accepts an optional `HostServicesBridge`. Isolated Runs try
`document.branchWrite` first. In Varin mode, real workspace/surface mutations then call
`document.surfaceWrite`: snapshot-owned paths edit the Document Registry buffer and disk-target paths are
applied by Host Documents through the Rust file-resource backend. If the Host mutation backend cannot take
the request, the worker fails explicitly; it does not fall through to Pi's local file writer or the legacy
`workspace.mutation.request` loop. Host-confirmed disk writes still request post-write LSP diagnostics after
the mutation gate has been released. The journal loop remains a standalone/no-Host helper path used by its own
tests and is not Varin's production disk authority.

`apply_patch` uses the same shared plan. Mixed surface/disk batches return per-path
applied/conflict/compensated/needs-attention instead of a generic failure after a partial write, and the worker
never performs a second direct-disk apply behind the Host.
