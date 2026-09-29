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

### BC0: the long-lived Bot still lacks its complete product path

- `bot-service.ts` persists `instructions`, but no model-input consumer reads
  them. Updating the stored model does not update an already-open entry worker.
- The sidebar opens the first active Bot. Profile editing and the durable
  `listBotWork` result have no complete user-facing management/navigation
  consumer. Replacing an entry does not by itself let the new root manage every
  old root's children through the parent-based thread tool hierarchy.
- Bot profile DTOs are duplicated between Host and UI instead of having the
  shared application-client owner required by the plan.

The next implementation should finish identity/configuration and work routing
through existing owners; adding another Bot Job table would not resolve these gaps.

### BC1–BC2: source coverage is not yet one recoverable memory transaction

- Active tools and the old `knowledge-suggestion-extension` do not share the
  organizer's source-range coverage. Exact-content deduplication cannot prove
  that a paraphrased fragment was already handled. Both automatic producers
  still exist.
- Knowledge commits and progress commits remain separate. Failure between them
  can cause the next model attempt to generate a different proposal for the
  same range. The source guard repaired here protects a forgotten range, but
  is not a durable proposal/commit receipt for an entire batch.
- Session progress is still cursor-based. Branch changes, changes to covered
  source content, and revised Run reports require source-revision reconciliation.
- `supplement` still writes another row without persisting the promised relation.
  Claims about graph organization therefore exceed this implementation.
- Missing organizer-model configuration quietly returns. There is no implemented
  “inherit this Bot's main model” binding or complete pending/failure progress UI.
- Source batching still uses fixed counts, and the source-unit abstraction needs
  model-capacity-aware subdivision rather than silent clipping or perpetual
  oversized retries. This review removes dishonest coverage, not that remaining
  scheduling work.

Complete the durable source/revision → prepared proposal → committed result and
coverage contract inside the existing memory/storage owner, then converge the
old suggestion producer. Do not layer another independent scheduler database on it.

### BC3: unbound inference and Bot consultation are incomplete

- Knowledge vector binding calls `resolveKnowledgeEmbedder(scopeId)`, whose
  `getWorkspace()` first resolves a document workspace. A `bot:` scope is not
  a document workspace. Automatic quick decision is also skipped when the Bot
  has no execution workspace. Text retrieval working does not prove either path.
- `memory.search` currently has a narrower retrieval path than automatic recall.
  Work-associated material is still selected under a small shared result budget;
  obligations need their actual work/follow-up association, beyond provenance ranking.
- `dispatch kind: discussion` creates another child using ordinary dispatch
  configuration. This is not the specified correlated consultation with the Bot,
  its decision context and shared work updates. Merely being asynchronous does
  not demonstrate the complete consultation/wait behavior.

Separate inference binding from resource indexing, retain the existing global
configuration owner, and finish consultation on the existing message/follow-up path.

### BC4: native coverage and interrupted actions remain partial

- No macOS driver exists. This is missing implementation, not just missing
  packaging. The Linux Wayland portal path is also absent.
- A resident helper processes one native operation synchronously. Cancellation
  can prevent queued input and terminate JavaScript, and release follows the
  current native operation, but long native typing/tree/capture calls cannot yet
  be interrupted within that operation. Do not claim immediate takeover; BC5
  must consume a real driver cancellation/control boundary.
- The Windows driver is still primarily process/main-window oriented. Full
  multi-window identity, DPI/display transitions, occluded/GPU window capture and
  native input interruption need real platform behavior evidence.
- Unknown-effect results are now explicit, but desktop restart/control-generation
  recovery still belongs to the complete native action/control lifecycle. No
  generic GUI transaction guarantee is possible.
- Driver assets and OS dependencies are not yet in the installed distribution.
  This belongs to BC9, but means this review cannot describe an installed BC4
  feature as verified.

## Verification boundary

Focused checks cover the changed Host services, storage-backed memory behavior,
context receipts, existing research roots, real child-process driver supervision,
and the Pi tool/REPL. The affected Host checks passed (93 cases across 12 files,
including two final recall/receipt regressions); Pi tool/inference checks passed
(24 cases). Host production/test TypeScript checks, Pi TypeScript checks,
protocol build, and changed-source ESLint passed. These counts describe focused
behavior coverage, not proof of the missing product paths listed above.

Windows PowerShell parsing, native helper loading, and read-only capability
discovery were exercised. No input was injected into the user's working desktop.
Linux scripts were parsed with Python, not run on a Linux desktop. macOS,
Wayland portal, actual model quality/cache hits, remote machines, VMs, installed
packages, and end-to-end Bot task continuity are not established by these checks.

Windows target/input handling follows the official contracts for
[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
and [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput):
activation can fail, and successful insertion of input is not proof of the application's business result.
