# BC0–BC4 implementation acceptance

Date: 2026-09-29. Reviewed baseline: `eb14dea3` (BC0–BC4, following `6283a4bd`).

## Judgment

The implementation is **partially wired, not complete against BC0–BC4**. The
existing Host/Pi/TDB ownership is a useful foundation, but several production
paths were either disconnected or contradicted their stated behavior. Passing
the original focused tests did not establish the complete product contract.

This review follows the actual Bot entry, durable owner, memory writer,
organizer, recall/context, computer tool, driver queue, and platform input paths.
It repairs concrete defects in those paths. It does not implement BC5–BC9, and
does not treat missing BC0–BC4 features as merely untested platforms.

## BC0–BC2 follow-up review (2026-09-29)

The execution-agent additions at `7e17bd77` and `51b2bdd6` connect real Bot
management and a durable organizer journal. The review found defects in the
actual write and recovery path; focused reproductions preceded these repairs:

| Area | Observed failure | Follow-up correction |
| --- | --- | --- |
| Supplement write | An invalid target was rejected after TDB had inserted the new row; the rejected content was visible in the live store | Validate the target inside the writer queue before any insert or retirement. A rejected write leaves the store unchanged. |
| Forgotten source | Forgetting one memory suppressed all later decisions from the same conversation | Use a stable covered-range key for new organizer memories; source-content fingerprints remain separate. Later ranges in the same session can form memories. |
| Prepared replay | A new turn appended after preparation changed the reconstructed fingerprint, causing re-narration instead of replay | Persist prepared end cursors and replay that frozen range before covering appended material. Malformed stored proposals now fail visibly. |
| Partial commit | If proposal 1 committed and proposal 2 failed, replay recovered the content but terminal `produced` omitted proposal 1 | Recover the earlier row's ID from its source-range provenance. |
| Source changed mid-inference | A revised Run report could still commit the old conclusion | Re-read the bounded source before preparation and commit. A changed source stays pending for fresh inference. |
| Model capacity | Eight 3 KB sources were sent together as a 24,986-character prompt despite a 12,800-character source budget | Bound the aggregate source batch and drain the remainder in later passes. An individual source beyond the model budget is now a visible failed row. |
| Retry and failure visibility | Manual retry still obeyed the five-minute automatic backoff; source read failures had no progress row; a broken Bot catalog silently became an empty sweep | Manual retry bypasses backoff, source errors persist, and catalog/sweep errors reach Host diagnostics. |
| Bot entry and UI | Reopening a live worker ignored the profile model; Bot memory change events missed the selected scope; work-list read errors appeared as an empty list | Reconcile the worker model, use one `bot:<id>` event identity, and surface work-list errors. |
| Bot persona | Every send queried the Host, and a process-local receipt survived branch navigation/compaction after the hidden instruction disappeared | Push profile edits to the live worker, cache a direct-open recovery lookup, and deduplicate against the active Pi context. Clearing the persona appends a revocation. |

### Follow-up closure of four BC0–BC2 gaps

- Long conversation events and Pi messages now advance with durable source
  offsets. A terminal row covers only the prefix actually sent; reopening the
  organizer continues the remainder without splitting UTF-16 surrogate pairs.
  Run-report part endpoints are persisted too, so an adaptive model-budget
  retry cannot silently change already covered part boundaries.
- The Host resolves the selected model's real context and output limits. It
  admits the **whole** system/source/existing-memory prompt with an output
  reservation; Pi repeats the same check before provider dispatch. A missing
  model descriptor raises a Host diagnostic rather than using an invented fallback.
  UTF-8 byte accounting is conservative across ordinary byte-level tokenizers,
  but providers with additional hidden framing may still reject a request;
  that rejection remains a retryable failure, never empty coverage.
- Prepared proposals carry a frozen source range, target revision and
  per-proposal identity. A memory write is durable before terminal source
  progress; restart reconciles already committed proposals from their durable
  provenance, including writes to the separate user store and human-edited
  content. If a source disappears before all proposals commit, the prepared
  receipt remains unresolved and visible. This is a recoverable commit
  protocol across Pi history and TDB stores, **not** an atomic transaction
  spanning them.
- Clearing a Bot's model preference asks Pi to perform its fresh-session model
  selection again, including the case with no explicit default; it does not
  leave the prior Bot model stuck on an already open entry session.

Directly reopened Bot sessions may still make one Host persona lookup before
the first turn. The user scope remains a proposal target, not an organizer
source. BC3–BC4 gaps below remain separate from this closure.

## Defects corrected in this review

| Area | Baseline defect | Correction and evidence |
| --- | --- | --- |
| Bot entry | Concurrent opens could create distinct entry sessions; any reopen error created a replacement; catalog write failure still returned success | Serialize profile/entry mutations per Bot, replace only on `session_not_found`, require durable binding before returning. `bots/bot-service.test.ts` covers concurrent opens, failed reopen/write, and archive racing entry creation. |
| Bot owner | Memory writes used only the live Run binding; after settlement they could fall into a session store. Initial context binding could precede Bot entry persistence | Resolve the durable Bot profile and catalog owner; resolve context ownership on demand and reset the recall cache on owner changes. Explicit `scope: bot` now resolves the calling Bot instead of always rejecting. |
| Root lifecycle | Bot and research attachment could both adopt/settle the same attached Run | Give Bot entry attachment precedence and check the existing root purpose before adopting a binding. Existing research-root behavior tests remain applicable. |
| Source coverage | `formed`/`reviewed-empty` permanently excluded a session, even after new turns. Initial collection skipped earlier entries, while clipped source text was acknowledged as fully reviewed | Resume from committed cursors on each source update, start an uncovered history at its beginning, and send the actual covered text. Continued-session and long-source regression cases were added. Provider capacity errors remain errors instead of silently acknowledged omissions. |
| Source failures | Unreadable entries became empty history; malformed proposal rows were silently discarded, potentially committing `reviewed-empty` | Preserve read failures, reject malformed envelopes/unknown source references before writes, and never substitute the first source for missing provenance. |
| Effective memory | Automatic organization still defaulted to `suggested`, which recall excludes, retaining the old review gate | The automatic-memory switch produces effective memories. Nature and producer provenance remain separate from acceptance, and now survive recall/context formatting. Explicit remembering can accept an existing proposal or intentionally remember a previously forgotten fact again. |
| Late memory writes | Correction read a fresh target after model inference and then CAS-checked that fresh target, allowing an intervening human edit to be overwritten | Compare with the revision presented to the model, reject new proposals against a changed store revision inside the storage write queue, and suppress paraphrased automatic retries from a retired source range. Targeted tests cover in-flight forgetting and source suppression. This is not yet the complete coverage transaction described below. |
| Shutdown | Organizer cancellation was fire-and-forget, after several dependencies had closed; late inference could commit during shutdown | Stop and drain organizer tasks before closing producer dependencies, cancel active inference, and check disposal before commits. Startup reconciliation begins after its consumers are assembled. |
| Recall delivery | Session-scope rows were revalidated through the Bot/workspace store; cache invalidation omitted the session store. Advisory judging could drop directly associated work memories | Resolve each store correctly, include its revision, keep direct associations outside advisory filtering, and revalidate results after model selection. Fix zero-remaining-budget extra results. |
| Context receipts | Corrections used a different revision hash from ordinary recall; invalidations were still emitted after being acknowledged | Use one canonical memory revision and filter acknowledged invalidations/corrections; emit an updated row once while its revision remains in the model history. |
| Computer discovery | `ensureLocal()` had no production caller; fresh installations could have an empty computer catalog | Initialize and probe the local target lazily through the shared service, independently of opening Settings. Failed probes retain their actual unavailable state. |
| Driver queue | Queued request timers started before dispatch; a timed-out queued action could later execute. Disposal could pump queued callbacks into another process | Queue actual request objects, start budgets when dispatched, reject all outstanding work on process loss/disposal, and ignore obsolete process events. Tests use a real controlled child process. |
| Observation targeting | Missing observation IDs silently reused the latest element map; validation occurred before queue execution; app-name keys broke PID selectors | Resolve the explicit observation at dispatch, bind to the observed PID, invalidate observations across driver replacement/cancel, and require references for element/window-coordinate operations. |
| Script runtime | Regex variable hoisting changed JavaScript semantics. Promise racing left timed-out scripts running; the tool ignored cancellation | Use Node's native REPL in a terminable worker, persistent lexical bindings/top-level await, request cancellation, and per-evaluation target selection. Tests cover delayed input after timeout, loops after `await`, recovery, and preserved bindings. |
| Input release | Cancel reported released input before release completed; disposal discarded queued callers. Drivers released all modifiers, including ones they had not pressed | Wait for actual release, reject queued work during disposal, and track/release only driver-owned synthetic input. In-flight native operations still have the limitation listed below. |
| Native contracts | Windows global typing could reach an unrelated foreground window, ignored several SendInput failures, and cast negative wheel deltas incorrectly. Linux inventory returned text where Host expected `apps` | Check/activate the Windows target for global input, check dispatch results, use current geometry and owned input cleanup; return Linux structured inventory and verify keyboard target/element identity. Linux Wayland limitations are no longer advertised as generic coordinate/capture support. |
| Action receipts | Lost driver responses and failed post-action capture could be read as proof that nothing executed | Return an explicit unknown effect after submission failure; preserve accepted input when only the following capture fails. The tool asks for observation before any retry. |

Paths in the table refer to modules below
`packages/web/application-host/lib/` unless another package is named.

## Required work still outstanding

These are implementation gaps, not approvals or a request to add another audit framework.

### BC0: durable Bot identity, entry, and work path — implemented, follow-up gaps above

- `instructions` now enter model input: the Pi worker resolves the Host-owned
  `session.instructions` (the Bot persona for entry sessions) on every
  `agent.prompt`/`steer`/`followUp` and queues them through the established
  hidden `varin.instructions` custom-message channel ahead of per-request
  instructions. Identical content is not re-injected; a changed persona is
  delivered on the next turn. Persona applies to the Bot's own entry
  conversation — dispatched child Threads receive their task briefs, not the
  persona, which matches the product boundary.
- Model updates take effect: `update()` applies `model.select` to the live
  entry worker when one exists, `ensureEntry`/reopen passes the stored model,
  and clearing the preference reselects Pi's fresh-session default for the
  live entry as well as later opens.
- Bot management UI exists: the harness "Bots" settings page lists, creates,
  edits name/instructions/model, archives, opens the entry conversation, and
  navigates to real work items (`sessionId` of each item's latest Run).
- Cross-entry work visibility: `bot-root` Threads in one owner scope form a
  family — a replaced entry's new root sees, reads, messages, waits on,
  merges, updates, and kills children dispatched under predecessor roots,
  while unrelated scopes and research roots keep strict per-parent isolation.
  Zone 2 thread material follows the same family rule.
- Bot profile/work DTOs live in `packages/application-client/src/bots.ts` and
  are consumed by the Host service, routes, and UI.

### BC1–BC2: one recoverable coverage transaction, single producer

Implemented behavior covered by focused tests (`memory-organizer.test.ts`,
`store.test.ts`, `knowledge-catalog-routes.test.ts`):

- The background organizer is the only automatic memory producer. The
  `knowledge-suggestion-extension`, Host `knowledge.suggest` service,
  `knowledgeSuggestions` model slot, and `autoAcceptSuggestions` settings are
  removed; `knowledge-suggestions.ts` retains only review-tray helpers
  (accept/dismiss/supersede candidates) for rows callers wrote as `suggested`.
- Coverage is a durable transaction: units are claimed `processing`, narrated
  proposals persist on a `prepared` row (with the source fingerprint) before
  any memory commit, and a crash/commit failure replays exactly those
  proposals instead of re-narrating. Terminal writes clear prepared fields.
- Coverage binds to content, not just cursors: every unit carries a `sourceKey`
  fingerprint; a terminal row whose source changed (revised run report,
  extended session range) reopens for reprocessing.
- `supplement` proposals persist a real `supplements` graph edge to a
  same-scope existing memory (invalid/cross-scope/self targets rejected);
  `correct` supersedes with an expected-revision check against the presented
  revision.
- Batching is capacity-aware: `contextWindow` and `maxTokens` (via `model.list`)
  bound the complete prompt and reserved answer. Session event/entry cursors
  advance only over material actually included, and oversized run reports
  subdivide into parts with durable endpoints.
- Model resolution honors `models.memoryOrganizer`, and a `bot:<id>` scope
  inherits the Bot's own model when the slot is unset. The narrate→commit
  window is guarded by a revision compare, and forgetting an organizer-derived
  row suppresses re-derivation from the same session/run source.
- Progress is visible: `GET /api/harness/knowledge/organizer` and
  `POST .../organizer/retry` back a Knowledge Settings surface that shows the
  organizer model, per-source status (pending/processing/prepared/formed/
  reviewed-empty/failed with errors), and a retry action. Bot scopes are
  swept via the bot registry (hashed store keys cannot be reversed).

Remaining gaps (not falsely complete):

- The user scope is a proposal target, not a source scope — organizer source
  enumeration covers workspace and `bot:<id>` stores only.
- Prepared replays re-validate proposals through dedupe and target checks,
  not by re-narration; a heavily changed memory landscape drops stale
  proposals rather than regenerating better ones for that run.
- The fast-decision filter is per-batch all-or-nothing; unanswered materials
  fall through to the generative pass.

### BC3: inference binding separated from indexing; Bot consultation bound — implemented, follow-up gaps above

Implemented behavior covered by focused tests (`workspace-runtime.test.ts`,
`memory-recall.test.ts`, `knowledge-recall.test.ts`,
`thread-services.test.ts`, `thread-runtime-session.e2e.test.ts`):

- Inference binding no longer depends on a resource workspace. `bot:`,
  `session:`, and `user` scopes resolve embedding, rerank, and fast-decision
  bindings through a shared global inference state (`GLOBAL_INFERENCE_SCOPE`)
  that watches the same `configCwd` configuration but never inspects a
  document root or scans files. `indexStatuses` still reports only real
  resource workspaces. A global binding change refreshes every knowledge
  vector registration (`refreshAll`), not just indexed workspaces, so a
  reconfigured embedder rebuilds Bot/session indexes too.
- `memory.search`, automatic Zone 2 recall, and the `recall` tool share
  `recallSources`. `memory.search` now passes the hybrid vector runtime, the
  owning scope id, and the calling session's work association — the same
  inputs automatic recall uses. Sources keep their true scope labels, and
  final rows are revalidated against their authority store.
- Work association is durable, not textual: the association is the session's
  bound Thread, its ancestor chain, and its descendant follow-up Threads,
  expanded with every Run and session id those Threads produced. Associated
  memories are pinned ahead of ranked hits under their own budget of `k` —
  an obligation is delivered even when it crowds out every generic hit —
  and are never removed by the advisory fast-decision pass. When no
  execution workspace exists, judging resolves through the shared global
  binding instead of being skipped.
- `dispatch kind: "discussion"` accepts a `bot` parameter. The Host resolves
  the Bot, rejects archived/missing Bots and `bot` combined with `preset`,
  `research`, or `worktree`, binds the Run to `params.model ?? bot.model`,
  and persists `consultBotId` on the Thread record. The consult Thread stays
  in the requesting work's catalog and parent — the ordinary
  send/wait/report path carries the answer — while its session resolves the
  Bot persona and the `bot:<id>` memory scope through the Thread record, so
  both survive worker restart. Pi's tool schema exposes the same parameter
  and leaves the model to Host resolution when a Bot is consulted.
- Consult tool gating is unchanged: a `discussion` Thread receives only the
  read-only `DISCUSSION_TOOLS` set. The stale e2e assertion that enumerated
  the pre-BC3 tool list now checks membership against `DISCUSSION_TOOLS`
  itself.

Remaining gaps (not falsely complete):

- The consult session binds the Bot's persona/model/memory at spawn through
  the Thread record; an in-flight consult keeps its frozen Run model even if
  the Bot's configured default changes mid-run.
- Work association traversal stays within the Thread's owning scope —
  ancestors and descendants in another catalog scope are not followed.
- Vector and fast-decision enrichment still require a configured inference
  binding; unconfigured deployments fall back to text retrieval by design.

### BC4: native drivers now interruptible and multi-window; platform depth still uneven

Follow-up work (this change) closed the main seams that remained after
`eb14dea3`:

- **In-operation cancellation is real now** — stdin stays sequential, so a
  cancel travels on a side-channel: the Host writes
  `$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel` and the drivers poll it at
  internal checkpoints (per tree node, per click repeat, per drag step, per
  scroll, per key chord, per typed-character batch). The aborted op returns
  `{ok:false, cancelled:true}` with its progress detail; the Host maps it to
  `outcome:"partial"` — part of the input already reached the desktop — and
  the caller-visible tool text says so. `driver.cancel()` is wired into the
  service's `computer.cancel` ahead of `release_input`; a real child-process
  test proves the flag lands where a driver polls it.
- **Generation recovery**: every spawned helper sweeps held input at startup
  (Windows: `Send-ReleaseInput -Sweep`; Linux/macOS: `release_input()`), and
  the Host additionally issues `release_input` once after each respawn before
  the driver serves work — a resurrected desktop never inherits a held button
  from a crashed predecessor.
- **Windows multi-window identity** is implemented and smoke-verified on a
  live desktop: `EnumWindows` builds a per-process window map once per call;
  `list_apps` and snapshots return the full `windows[]` inventory with hwnd,
  title, bounds, visibility, minimized and `main` flags (62 apps / 53
  multi-window observed); `observe`/`act` accept a `window` selector
  (hwnd number or title) and actions bind the observed hwnd automatically;
  PostMessage paths target the element's own hwnd rather than the process
  main window; `GetDpiForWindow` reports `dpiScale` per observation; occluded
  capture still uses `PrintWindow` with a screen-grid fallback.
- **Linux**: AT-SPI window enumeration produces the same `windows[]`
  inventory (handle = AT-SPI child index — Linux has no cross-process window
  id); `window` selectors work by index or title; cancel checkpoints are in
  the same loops; under Wayland, screen capture goes through the
  `org.freedesktop.portal.Screenshot` interface (non-interactive; denied
  compositors honestly report no screenshot) and synthetic input depends on
  compositor acceptance — `capabilities.detail` says which state applies.
- **macOS driver exists now** (`macos/driver-host.js` + `runtime.js`, JXA
  under osascript): CGWindowList window inventory, System Events AX tree,
  CGEvent input, `CGWindowListCreateImage` capture, same op vocabulary and
  cancel side-channel. **It has never run on a real machine** — the
  capability table marks it `UNVERIFIED` and AX permission failure degrades
  to `unavailable` rather than pretending.

Remaining honest limits:

- Linux/macOS drivers are syntax-checked only (`py_compile`, `node --check`);
  neither ran on a real desktop. Portal screenshot timing/dialog behavior is
  compositor-dependent.
- `interruptibleInput` means checkpoint interruption — a single native call
  (one SendInput batch, one UIA pattern invoke) still runs to completion.
- DPI *transitions* (window dragged across mixed-DPI monitors mid-session)
  are reported per-observation via `dpiScale`, but no live monitor-topology
  event handling exists.
- GPU-exclusive windows (some games/secure surfaces) remain a capture gap the
  fallback only papers over.
- Packaging/driver assets in the installed distribution still belong to BC9;
  this review cannot describe an installed BC4 feature as verified.

## Verification boundary

Focused checks cover the changed Host services, storage-backed memory behavior,
context receipts, existing research roots, real child-process driver supervision
(including an end-to-end cancel-flag write into a live child), and the Pi
tool/REPL. The affected Host checks passed; Pi tool/inference checks passed.
Host production/test TypeScript checks, Pi TypeScript checks, protocol build,
and changed-source ESLint passed. These counts describe focused behavior
coverage, not proof of the missing product paths listed above.

Windows gained real-machine evidence beyond parsing: the resident driver's
`list_apps` enumerated 62 processes with per-window hwnd inventories (53
multi-window), `observe` bound an explicit hwnd selector, and a planted cancel
flag aborted an operation checkpoint with progress detail. No input was
injected into the user's working desktop. Linux scripts were compiled with
Python but never ran on a Linux desktop; the Wayland portal path is
source-verified only. macOS JXA was `node --check` parsed but never executed
under osascript. Actual model quality/cache hits, remote machines, VMs,
installed packages, and end-to-end Bot task continuity are not established by
these checks.

Windows target/input handling follows the official contracts for
[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
and [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput):
activation can fail, and successful insertion of input is not proof of the application's business result.
