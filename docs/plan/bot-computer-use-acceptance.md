# BC0–BC9 implementation history

Current acceptance: [2026-09-29 deep review](bot-computer-use-review.md). The implementation claims below describe earlier delivery reports. They do not establish completion of BC0–BC9; the current review records concrete repairs and outstanding implementation contracts separately from untested environments.

Date: 2026-09-29. Reviewed baseline: `eb14dea3` (BC0–BC4, following `6283a4bd`).

## Judgment

The implementation is **partially wired, not complete against BC0–BC4**. The
existing Host/Pi/TDB ownership is a useful foundation, but several production
paths were either disconnected or contradicted their stated behavior. Passing
the original focused tests did not establish the complete product contract.

This review follows the actual Bot entry, durable owner, memory writer,
organizer, recall/context, computer tool, driver queue, and platform input paths.
It repairs concrete defects in those paths. BC5 (server-side control
ownership, real desktop frame stream, takeover/handback), BC6 (remote
Host catalog mirroring with authenticated operation forwarding), BC7
(libvirt VM lifecycle), BC8 (shared Workbench/Settings product integration
with work associations), and BC9 (driver assets on the packaging path with
checkout-independent resolution) are implemented — see their sections below.
What remains unverified is live-environment evidence, not wiring: a real
second Host, a real hypervisor, real Linux/macOS desktops, and a produced
installer have not been exercised in this environment.

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

Implemented behavior covered by focused tests (`workspace-runtime.native.test.ts`,
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
  owning scope id, and the calling session's work association. A default
  active search also includes available user/session memory, matching automatic
  recall; an explicit scope stays narrow. Sources keep their true scope labels,
  and final rows are revalidated against their authority store.
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
  read-only `DISCUSSION_TOOLS` set. Follow-up review found that the combined
  `memory` tool in that set also exposed remember/correct/forget. It is now
  excluded; `recall` remains available for read-only memory lookup. The stale
  e2e assertion that enumerated the pre-BC3 tool list checks membership against
  `DISCUSSION_TOOLS` itself.
- A consulted Bot's configured model takes precedence; when that preference is
  empty, Pi passes the caller's current model as the explicit fallback rather
  than failing a valid consult after Bot model clearing.
- Consult identity, work association, and goal lookup now use the durable
  session owner resolver. The active-only binding expires when a Run settles;
  using it made reopened consults silently lose their Bot memory/persona or
  treat a settled child as an unbound session. Catalog read failures surface
  instead of being converted to empty associations.

Remaining gaps (not falsely complete):

- The consult session binds the Bot's persona/model/memory at spawn through
  the Thread record; an in-flight consult keeps its frozen Run model even if
  the Bot's configured default changes mid-run.
- Work association traversal stays within the Thread's owning scope —
  ancestors and descendants in another catalog scope are not followed.
- Vector and fast-decision enrichment still require a configured inference
  binding; unconfigured deployments fall back to text retrieval by design.

### BC4: native drivers have checkpoint cancellation and multi-window inventory; platform depth still uneven

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
- **Input release**: active helpers release only synthetic input they tracked.
  A predecessor killed between a key/button down and up loses that ownership;
  no replacement can distinguish the injected state from human-held input.
  The previous Windows startup sweep sent key-up events for every modifier and
  mouse button, including ones the user held, so this review removed it.
  A lost-driver action remains `unknown` and requires a fresh observation.
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
- The macOS snapshot's AX child-index path is now preserved through the Host
  observation and replayed at action time. Missing paths and ambiguous
  CGWindow/AX window matches fail rather than choosing a same-named control.
  This is source-level correction; it still needs a macOS machine run.
- Host actions cannot override an observed window with another window selector;
  the second window requires its own observation.
- Linux AT-SPI window handles are zero-based child indexes. Host observation
  and app inventory now retain handle `0`; previously they silently dropped
  the first (often only) Linux window and lost action/window binding.
- The Wayland portal screenshot wait now has a working timeout callback and
  accounts for a Response arriving before the request path is returned. It
  remains unverified on a compositor with an actual portal dialog.
- A Pi script timeout/client abort now reaches the Host's driver cancellation
  flag for an in-flight action or observation. Previously the bridge stopped
  waiting while the native helper could keep typing. This is checkpoint-based
  cancellation, with partial GUI effects still reported honestly.
- Windows posted input now checks `PostMessage` acceptance. A cancelled
  app-bound drag posts its button-up in `finally`, and a failed key chord
  attempts to release every modifier it posted; the old global-input cleanup
  did not own those window-message states.
- A crash during held input is not automatically repaired; driver-owned input
  is released during orderly cancel/failure, but a new helper cannot safely
  reconstruct the prior helper's ownership from OS key state.
- DPI *transitions* (window dragged across mixed-DPI monitors mid-session)
  are reported per-observation via `dpiScale`, but no live monitor-topology
  event handling exists.
- GPU-exclusive windows (some games/secure surfaces) remain a capture gap the
  fallback only papers over.
- Packaging/driver assets in the installed distribution still belong to BC9;
  this review cannot describe an installed BC4 feature as verified.

### BC5: server-side control ownership and a real desktop frame stream — implemented

The shared desktop view now exists inside the existing Computer Use service,
not as a separate demo path:

- **Control ownership lives on the desktop lane** (`computer-service.ts`):
  every lane carries `{ owner: "agent" | "human", holderId?, reachable, since }`.
  `takeover` reuses the cancel interlock — it bumps the lane generation (so
  queued automation and any stale script batch can never run), calls the
  driver's checkpoint-cancel side-channel, serializes `release_input` behind
  the in-flight op, deletes the desktop's observations, and only then marks
  `owner: "human"`. `handback` verifies the holder, releases input again,
  flips `owner` back to `agent`, and invalidates observations so the next
  automated step re-reads the scene the human left behind (`requiresObservation`).
- **`act` is forbidden while a human owns the desktop** — the rejection is a
  Host-level `forbidden` error, so a script that resumes mid-takeover fails
  instead of typing into a user's session. The same check re-runs at
  execution time for human input queued in the lane.
- **Human input goes through the same lane** as `inject_input`: absolute
  screen coordinates, no app/window binding, rejected (`forbidden`) unless a
  subscribed viewer holds control, and re-validated at execution so a queued
  input cannot fire after a handback.
- **Viewer disconnect ≠ handback**: when the holder's stream closes, control
  stays `human` with `reachable: false` — a recoverable pending owner. Input
  attributed to a disconnected holder is rejected; reconnecting with the same
  viewer id restores reachability. A different viewer can still force a new
  `takeover`.
- **Frame service** (`subscribeFrames`): the Host polls the driver's new
  `capture_frame` op at ~4 fps while at least one viewer is attached —
  frames never travel on agent observation calls. Multiple viewers each get
  the same frame stream; the last unsubscribe stops polling and never cancels
  work. Capture failures surface as `error` events, not fake black frames.
- **Transport**: `GET /api/computers/desktops/:id/stream?viewer=<id>` is a
  dedicated SSE channel carrying `{type:"frame"|"control"|"error"}` — big
  image payloads stay off the global event bus. `GET/POST control`,
  `takeover`, `handback`, `input` complete the control plane; `forbidden`
  maps to HTTP 409.
- **Drivers**: all three drivers grew `capture_frame` (Windows: full virtual
  screen union → JPEG via `CopyFromScreen`; Linux: X11 root-window pixbuf or
  the Wayland portal for a whole-screen image; macOS: `CGWindowListCreateImage`
  over `kCGNullWindowID`) and `inject_input` (absolute-coordinate
  SendInput / AT-SPI `generate_mouse_event`+`generate_keyboard_event` /
  CGEvent). Windows is smoke-verified (2560×1440 JPEG frame, `inject_input`
  move, `release_input`); Linux/macOS remain syntax-verified only.
- **Workbench surface**: the Computers settings page gained a Watch button
  opening `ComputerDesktopView` — an `<img>` fed by the SSE stream, control
  status line, takeover/handback buttons, and click/key/wheel forwarding that
  maps image coordinates to desktop pixels. Closing the dialog unsubscribes
  only.

Honest limits that remain:

- Frames share the serialized driver lane — a long automation op pauses the
  viewer's frame cadence for its duration (input still lands correctly).
- `inject_input` supports click/down/up/move/scroll/key/text; drag-as-human
  composes from move+down/up like a real user would.
- The view landed as a first-class Workbench tab surface in BC8 (see below);
  the settings dialog remains as the quick-look entry.
- Linux Xvnc/noVNC transport for *independent* remote desktops is BC6's lane;
  this Host-driven poll is the shared contract for local desktops now.

## BC6 remote Hosts (implemented)

Remote Computer Use reuses the configured `desktopHosts` entries — the same
authenticated Host↔Host client settings managed-remote already consumes —
rather than introducing a parallel connection system.

- **Catalog mirror**: `createComputerService` accepts a `remoteHosts` resolver
  (wired in `index.ts` from `configuredHosts(readSettingsFromDisk())`). Each
  `list()` triggers a debounced `syncRemote`: a `GET /api/computers` against
  the remote Host rewrites that Host's `computer.machine`/`computer.desktop`
  records (`remote:r<index>:…` ids) into the local catalog. A Host that
  cannot be reached leaves its previous mirror with `unavailable` + the real
  transport detail instead of silently vanishing.
- **Remote authority stays remote**: `ComputerDesktop.remote` binds each
  mirrored desktop to its apiUrl/token/hostId. `observe`, `act`, `listApps`,
  `cancel`, `release`, `control`, `takeover`, `handback`, `input`, and frame
  subscriptions resolve the binding and forward over authenticated HTTP to
  new Host↔Host routes (`…/observe`, `…/act`, `…/apps`, `…/cancel`,
  `…/release`) plus the existing BC5 control endpoints. Observation freshness,
  control ownership, action serialization, cancellation, and input release
  all execute on the remote Host's own service.
- **Remote observation ids are preserved**: `observe` re-binds only the
  returned desktop id to the local mirror key; `observation.id` stays the
  remote value because the remote store validates freshness against it.
- **Failure honesty**: a private `RemoteTransportError` separates transport
  loss from structured remote rejection. A transport failure on `act`
  resolves `{ accepted: true, outcome: "unknown" }` — input may already have
  landed and is never replayed — while a remote `HarnessServiceError` keeps
  its code (forbidden/stale/not-found).
- **Streams**: remote frame subscriptions open an upstream SSE connection to
  the remote `…/stream` endpoint and forward `frame`/`control`/`error`
  events; upstream loss surfaces as a terminal error event.
- **Persistence boundary**: the remote Host is the process that must stay
  alive — the local catalog mirror is rebuildable state, so a local client
  closing loses nothing except cached records. The desktop Hosts
  themselves already run independently of this UI.

Honest limits that remain:

- Bot threads/tasks still execute where their pi-host lives; remote session
  continuity (a Bot driving a remote desktop from a remote pi-host) remains
  open — BC8 integrated the viewing/control surface, not remote execution.
- Linux Xvnc/noVNC provisioning of an *independent* desktop on a headless
  remote remains unimplemented; BC6 assumes the remote Host already owns a
  reachable desktop.
- Remote paths are covered by focused tests with a fake `fetch`; no real
  second Host has answered yet — a live Host↔Host integration run is still
  owed.

## BC7 virtual machines (implemented, provider-verified pending)

A real libvirt backend — not a provider interface stub.

- **Provider layer**: `vm-provider.ts` defines the `VmProvider` contract and
  parses `computerVmProviders` entries from Host settings
  (`{ id, kind: "libvirt", uri, storagePool?, network? }`). The URI carries
  the target — `qemu:///system` local, `qemu+ssh://user@server/system` for a
  libvirt daemon on the user's own server; credentials stay in ssh/agent,
  never in settings.
- **virsh implementation** (`libvirt-provider.ts`): every operation is a real
  CLI invocation (`virsh -c <uri> …`). Identity is the domain UUID; state is
  `domstate` truth, never assumed.
- **Idempotent create**: `domuuid <name>` resolves first — a retried call
  after a lost response adopts the existing domain (returns `created:false`)
  instead of duplicating it. Fresh creates allocate a qcow2 volume
  (`vol-create-as`, or `vol-clone` from a `baseImage` so user data never
  lands on the template) then `define /dev/stdin` with generated domain XML
  (virtio disk/net, VNC console, guest-agent channel).
- **Failure journal**: every create writes `resolve/volume/define/cleanup`
  steps to the machine record — including on failure. A failed define cleans
  up only the volume this call allocated; when define ran but the UUID could
  not be resolved the volume is retained (the domain may exist). Volume
  allocation failure attempts cleanup and records the real result.
- **Lifecycle**: `start` / ACPI `shutdown` / `reboot` (shutoff → start, since
  reboot errors on stopped domains) / `delete` — `destroy` first when still
  running, then `undefine`; recorded volumes are deleted only when
  `deleteDisks` is true, and a failed `vol-delete` surfaces instead of
  pretending.
- **Catalog**: `computer.machine` records with `provider:"virtual"` carry the
  `vm` binding (providerId, URI, domainUuid, volumePaths, journal). Domain
  state maps to machine status (`running`→active, paused/shutoff/crashed→
  unavailable with detail). Deleted domains archive the record — the journal
  stays as evidence.
- **Surface**: `GET/POST /api/computers/vms`, `POST …/vms/:id/(start|shutdown|
  reboot|delete)`; the Computers settings page gained provider management and
  a create/lifecycle section (28 keys × 10 locales).

Honest limits that remain:

- A created VM is a *machine*; its desktop appears in the BC4/BC5/BC6 paths
  only once a Varin Host runs inside the guest and is reachable as a remote
  Host. Guest bootstrap (OS install, desktop, browser, guest agent, Host
  registration) requires a prepared `baseImage` — the recipe is documented
  below but not automated by this change.
- Base image recipe (manual, repeatable): install a desktop Linux on a
  qcow2 volume with cloud-init or a console installer; inside the guest,
  install `varin` (Host + computer driver), enable it on boot, then shut
  down and use the volume path as `baseImage` for clones.
- No libvirt hosts the test environment — every check runs against a
  scripted `virsh` seam. Real `vol-create-as`/`define`/`domstate` behavior,
  VNC reachability, and guest-Host registration are unverified and marked
  as such.
- A server without virtualization still serves real remote desktops via
  BC6 — the provider list just stays empty and `probe()` reports the real
  `virsh` error.

## BC8 shared product integration (implemented)

The desktop view is now a first-class Workbench surface — not a second
state machine. Everything below reuses the same `ComputerService`,
`computer` tool, desktop ids, and control semantics built in BC4–BC7.

- **Context surface**: `'computer'` is a real `ContextPanelMode` and a
  registered `CONTEXT_SURFACES` rail entry (icon `computer`, label
  `contextPanel.mode.computer`, `availability: 'always'`). Clicking it opens
  a singleton computer tab; `openContextPanelTab` with
  `dedupeKey: 'desktop:<id>'` opens a per-desktop tab, so several machines'
  desktops coexist and each tab keeps its bound desktop across reloads via
  the persisted `targetPath`.
- **`ComputerWorkSurface`**: desktop catalog picker (with default-target and
  sole-desktop fallback), refresh, and the same `ComputerDesktopPane` the
  settings dialog wraps — identical frame stream, ownership, takeover/
  handback, and human-input path; closing the tab unsubscribes only.
- **Work association**: `observe`/`act` accept the caller's harness
  `sessionId` and stamp `desktop.usage = { sessionId, at }` on the desktop
  record (one revision-retry, projection-only — a usage write failure never
  flips a dispatched GUI op). Remote mirrors keep the local usage field
  across `syncRemote` rewrites; `ensureLocal`/`probe` body rewrites carry it
  forward. The surface renders the association as a session link that opens
  the owning conversation — the Thread/Run records stay authoritative.
- **Settings**: Computers page gained an "Open in panel" action per desktop
  (bound to `useEffectiveDirectory`), the catalog line now shows the
  machine's `coordinatorHostId`, and Bot model/persona/work items plus the
  fast-decision bindings remain in their existing settings sections — no
  hidden JSON or source edits required for any of it.
- **Ordinary sessions select a computer without Bot mode**: the `computer`
  tool's `desktopId` parameter and the configured default target are
  unchanged and work in any session; the rail surface is available in the
  same window so a human can watch or take over while a normal task drives
  the desktop.

What BC8 deliberately did not add:

- No desktop-state copy into Thread/Bot records — the association is the
  `usage` pointer on the real desktop record plus the UI projection, per
  the replacement table.
- No Office editor claims — no purpose-built office editor exists, and no
  Computer Use demo masquerades as one. File-type handling stays with the
  existing Documents pipeline, which already reflects external application
  edits through disk revisions/conflicts without overwriting dirty buffers.
- No new machine for "one lucky web flow" — the delivery condition is the
  shared surface, not a per-page state machine.

Focused evidence: `computer-service.test.ts` gained two usage-association
cases (stamp on observe/act; preserved across probe rewrites) — suite 32/32;
`useUIStore.contextPanel.test.ts` gained computer-surface tab semantics —
suite 17/17; i18n parity 4/4 across all ten locales.

## BC9 distribution and cleanup (implemented, installer run pending)

Driver assets now travel with the package instead of the source checkout.

- **Staging**: `build-application-host.mjs` copies `packages/computer-driver`
  into `packages/web/computer-driver/` on every build (dev generations and
  production `server/` alike), excluding dev-only helpers
  (`check-syntax.ps1`, `smoke.ps1`, `__pycache__`). The directory is a
  generated artifact — gitignored, removed by `--clean`, and listed in
  `@varin/web`'s `files` so the npm package ships it.
- **Resolution**: `computerDriverDir()` now resolves
  `VARIN_COMPUTER_DRIVER_DIR` → the repository checkout (dev/live edits) →
  the staged package copy. Verified layouts: dev source, compiled `server/`
  (`server/lib/computer/driver-host.js` → `packages/computer-driver` while
  the checkout exists, otherwise the staged dir), and an installed
  `node_modules/@varin/web/` tree (`…/@varin/web/computer-driver`). Electron
  packages reach the same copy through `asarUnpack`'d `node_modules` — no
  extra resource entry or parallel backend.
- **Upgrade boundary**: the atomic `server/` + `computer-driver/` swap only
  replaces Varin's own runtime assets — user workspaces, browser profiles,
  Pi session data, Bot memory, and `desktopHosts`/`computerVmProviders`
  settings are untouched. User-managed remote Hosts upgrade on their own
  schedule (their machines/desktops stay authoritative there); Varin-managed
  VMs keep their recorded volumes across upgrades since lifecycle keys on
  the persisted domain UUID.
- **Cleanup**: no `knowledgeSuggestions`/`review-only` write path survives;
  no new Electron-side business entry was added — the shell only sets env
  before importing the Host module, as it already does for the kernel.

Honest limits that remain:

- No installer was produced in this run — the extraResources/files claims
  are verified by the real `build:application-host` staging output plus the
  resolution test, not by a packed app smoke. `package`/`package:win:x64`
  still owes a real run on a packaging runner.
- Platform coverage is still asymmetric: Windows driver is the only one
  smoke-tested on real hardware; Linux (Wayland portal) and the unverified
  macOS JXA driver ship with honest capability/status reporting.
- libvirt stays unverified without a hypervisor; macOS signing/notarization
  and per-arch Linux packages were not exercised here.

Focused evidence: `driver-host.test.ts` gained the resolution-order case —
suite 9/9; the real `build:application-host` run staged all six driver
files and reported `Staged computer-driver assets.`

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
multi-window), `observe` bound an explicit hwnd selector, a planted cancel
flag aborted an operation checkpoint with progress detail, and the BC5 ops
`capture_frame` (2560×1440 JPEG full-screen frame) and `inject_input`
(pointer move) completed through the live resident driver. No input was
injected into the user's working desktop. Linux scripts were compiled with
Python but never ran on a Linux desktop; the Wayland portal path is
source-verified only. macOS JXA was `node --check` parsed but never executed
under osascript. Actual model quality/cache hits, remote machines, VMs,
installed packages, and end-to-end Bot task continuity are not established by
these checks.

BC5 focused coverage: 39 computer-suite tests pass, including takeover
dropping queued actions, mid-flight ops reporting cancelled across the
generation bump, human input gated by ownership and holder identity,
disconnect marking the holder pending-recovery (reachable=false) without
handing back, reconnect restoring it, and independent multi-viewer frame
subscriptions that stop when the last viewer leaves.

BC6 focused coverage: 43 computer-suite tests pass, adding catalog mirroring
from a configured remote Host (remote desktops carry the `remote` binding),
an unreachable Host degrading its mirror to `unavailable` with the real
transport detail, observe/act forwarding that preserves the remote
observation id verbatim, and a transport failure on `act` reporting
`outcome: "unknown"` without replay. All BC6 coverage runs against a fake
`fetch`; live Host↔Host integration remains unverified.

BC7 focused coverage: 61 computer-suite tests pass across 4 files — the
provider layer proves `virsh version` probing, real idempotent create
(domuuid resolve → volume → stdin-XML define → UUID), adoption instead of
duplication, scoped cleanup of only this call's volume, and delete-keep-
disks vs delete-with-disks. The service layer proves journal persistence on
failed creates, UUID-keyed lifecycle with status sync, and record archival.
No real hypervisor was reached — all virsh calls are scripted; live libvirt
verification remains owed.

Windows target/input handling follows the official contracts for
[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
and [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput):
activation can fail, and successful insertion of input is not proof of the application's business result.

This follow-up ran the focused Host computer/thread/memory/inference tests,
Pi's targeted consult-tool test, TypeScript checks, native-source syntax checks,
and a Windows driver ping/release protocol smoke. The broader real-Pi session
e2e made no progress output after roughly 90 seconds and was stopped; it is
**not** counted as passing evidence. Native Linux/macOS desktop behavior and
the installed distribution remain unverified.
