# Memory ownership and Agent personalization

Ordinary Agent memory is explicit, lightweight text. `agent-personalization.ts` owns one
Rust typed record (`agent.personalization`) containing global, project and session notes
and scoped system-prompt edits. Projects use the configured project ID, including its
additional folders. Session notes use the native Pi session ID. There is no implicit
import of old knowledge records or background extraction for ordinary chats.

`agent-memory-services.ts` routes ordinary `memory` calls to this authority. Omitted scope
means the current session; the tool's `user` and `workspace` scopes mean global and project.
The tool cannot read another project's or session's notes. Selected-message saves preserve
the chosen text for user editing without calling the memory organizer. The settings catalog
and authenticated `/api/agent-personalization` routes expose CRUD, scope changes, and prompt
edits. Writes publish only after the Rust receipt. UI edits carry their opened revision;
a conflict stays visible instead of silently overwriting another edit.
The personalization path participates in the production JSON-body middleware for memory saves,
deletes and prompt saves. Its HTTP regression uses that middleware rather than a test-only global parser.

`session.instructions` resolves the actor's current ownership, project, catalog revision and
thread role. Tool presentation uses that identity at the run boundary: ordinary memory has
global/project/session note parameters; Bot memory has provenance and revision-chain parameters.
Main/Worker/read-only Computer and team presentation describes the calling role. A project scope
is only offered when the conversation has a project. Host authorization remains authoritative.

Pi applies global, project, then session prompt section overrides. Matching notes establish a
system memory snapshot when the first run starts. The snapshot and its system sections are recorded in the native Pi branch;
it stays unchanged while memory mutations arrive at the conversation tail. Direct memory results
carry saved text/deletion and the committed revision. Nested calls, including Codemode, forward
the same receipts through the enclosing tool result without relying on the script to print them.
External/UI changes are retained as `varin-memory` messages only after the provider starts responding;
failed requests retry undelivered changes. Per-entry receipt revisions handle out-of-order parallel
results. Writes still commit immediately to the Rust authority; new conversations see current notes.

A successful compaction stores the new `agentMemorySnapshot` and effective `systemMessage` in the same native compaction entry.
Request-boundary capacity validation includes the new snapshot before publication. Preparing, cancelling or failing a
summary never advances the snapshot. Reopening or navigating a branch reconstructs its checkpoint
and delivered changes from Pi history; this is not another memory database. The next request renders
the stored snapshot and appends any newer changes. Deleting the last note removes every memory section
at the next committed snapshot. Compaction can change the cached prefix; this design avoids memory
mutations rewriting that prefix between compactions, without promising provider cache hits.

Unchanged official sections continue to follow the runtime;
explicit edits remain user-owned. Reset removes only that scope's overrides. `SYSTEM.md`,
`APPEND_SYSTEM.md`, project instructions, extensions and skills retain native Pi loading.
The settings page shows the current memory snapshot in the assembled preview and the last system text observed at
the actual model-request boundary. The latter is an in-memory observation of an attempted
request, not evidence of provider delivery, and is lost when the worker stops.

Bot ownership is determined by the original Host registry or Catalog Thread binding, not a caller-supplied mode. Bot requests
never receive Agent prompt overrides or Agent notes. Bot memory continues through
`memory-service.ts`, Bot/user/current-conversation knowledge stores, `recall`, and the optional organizer.
The organizer only enumerates Bots; ordinary context assembly bypasses knowledge recall.
Plans, observations, materials, symbol indexing and other knowledge-store users remain intact.

## Bot background inference

The existing organizer and explicit Bot selection preview use `memory-inference.ts`, the original
Host model/credential authority and native inference adapters. `models.memoryOrganizer` selects the
dedicated narrator; an unset slot keeps the existing Bot model fallback. Explicit disable, invalid
selection and unavailable configuration are not permission to pick another model. Ordinary model
updates preserve an admitted recipe; actual Bot Sleep and enable gates fence new execution and delivery.
Optional `memory-organization` decision calls use their original classifier request/receipt path.

Catalog owns a separate `MemoryWork` Run and its stage operations; it does not borrow a settled
conversation's ToolIntent, query or Goal. ContentStore retains the ordered original sources, exact
revisions/ranges, presented targets, model binding and complete recipe. Knowledge progress records the
work reference and prepared proposals. Reopening reads original output and classifier wire receipts,
not a newly collected batch or a new model call. A complete generation requires Stop and valid source
citations; partial/Length output and its actual usage remain on the original operation.

Sleep first closes the Bot gate, then cancels its durable work and waits for actual local executor
drain. Wake can explicitly resume a proven unsent generation; completed advisory results are reused.
Dispatched Unknown work keeps its original evidence and exact source claim without blocking unrelated
new entries in the same Bot conversation. Prepared memory mutations recheck the current gate before
each new write. An already committed MemoryService receipt is still reconciled after the gate closes.

Selection requests keep one identity across rerenders/network observation. A separate explicit Retry
can create a linked attempt only after the original local executor has stopped. Unknown provider
billing is retained and disclosed; local drain does not claim remote cancellation or a free retry.
Successful original output is reused. Preview writes no memory; Save and undo remain the existing
MemoryService/source-revision path. Ordinary Agent selection stays a no-model editable note.

Agent Bot entries use the same memory domain. `bot-history.ts` reads original immutable HistoryItems
through Catalog-owned Bot, Thread, branch and ancestor checks. Native source spans retain the actual
Thread/item identity and their branch/head read witness; the witness is not a second coverage or
deduplication key. Pi entries, events and Run reports keep their distinct typed source identities.
Host and UI use the same text projection and UTF-16 offsets, so Markdown rendering cannot change a
saved selection. Changed, missing and unavailable originals remain different source results.

`kernel/bot-memory-owner.ts` resolves each request's actual Run and Bot binding. Bot/user/current-Thread
scopes use their original Knowledge stores; a child does not inherit its parent's local store. Its
selected tool contracts and actual admitted role remain authoritative. A read-only file source does
not by itself prohibit an independently admitted note or plan mutation. Mutations keep an exact origin and intent, and their original
MemoryService result is committed with the Knowledge write in the same transaction. A late observer
or closed Sleep gate can still reconcile that receipt without repeating the write. New writes honor
the gate and cancellation before dispatch; a running transaction remains owned until it settles.

The shared Knowledge context algorithm retains recalled items and original work associations. Recalling
the same row from another work item does not erase earlier provenance. Corrections and retirement are
projected into the original native memory state and real request facts, while an already prepared
RequestSnapshot remains immutable. Forgetting a corrected item removes its retained correction body.
Only successful summary publication replaces the system checkpoint; preparing or finishing a candidate
does not itself publish it. The organizer and explicit selection preview enumerate the same native
sources rather than synthesizing Pi sessions.

For Bot recall, the original ContextJob freezes a typed reference to the selected immutable memory
projection and includes those actual facts in its summarization material. Only successful publication
installs that reference as the checkpoint baseline. Later requests project new, corrected or retired
rows relative to it, including changes committed while the summary was running. Recipe and checkpoint
ContentStore manifests both retain the original referenced state. Prompt/resource refresh preserves
the accepted baseline; no ordinary-note store or second memory revision ledger is introduced.

The old Magic Prompts, prompt-template resource editor/expansion and ordinary knowledge
catalog are removed. Product actions use `actionInstructions.ts`; native skills remain
editable resources. Existing user-owned prompt files are not deleted, but Varin no longer
loads them as command templates.

Verification owners: `agent-personalization.native.test.ts` exercises real Rust persistence,
scope isolation and stale edits; Pi `session-e2e.test.ts` exercises actual outgoing requests
with a faux provider; UI `AgentSettings.behavior.test.tsx` covers editing and scope selection.


Native conversations use this same catalog through `kernel/thread-context.ts`. A trusted
Host admission supplies mode, role and nullable project; the current-thread scope is the actual
native Thread ID. The generic preparer requires that scope explicitly. Its `main` adapter alone
resolves a main conversation's project from the admitted workspace. Child contexts do not inherit
parent session notes or a parent's assembled system prompt. Bot contexts exclude ordinary notes
and prompt profiles.

`memory` exposes read/search and revision-checked save/delete. Native calls carry their real
Run, request/call-derived operation and admitted scopes through the private epoch-fenced memory
bridge. The existing personalization typed record remains the only note writer. The current document
adds only per-note latest revision metadata and its last mutation receipt. Historical receipts reuse
the existing atomic `storage.record.put` operation result: a lost return is reconciled using the
same stable origin and exact intent, never by repeating the mutation. `runtime.memory.reconcile`
queries those original receipts on an independent worker and settles the original native operation.
Missing or unknown outcomes stay unresolved. Existing valid notes need no migration or format reset.
UI stale edits and native mutations share the same record CAS. Scope moves retain both deletion of
the old scope and addition in the new scope.

The native conversation exposes the existing notes editor with its admitted global, project and
current-Thread scopes. It reuses the ordinary notes routes, editor and CAS rather than another store.
The Host resolves native session scopes from the persisted Thread and context checkpoints; a
native namespace only selects that lookup and does not grant a role. Missing, inconsistent or
unavailable native ownership fails closed. The legacy Pi resolver is retained only for Pi identities.
Bot contexts have no ordinary-notes entry, and the Host independently rejects their session writes.

An immutable context checkpoint now separates the frozen memory snapshot from current explicit
prompt configuration. Ordinary note edits are immediately readable but do not rewrite the system
memory prefix. Explicit profile changes re-render from the original sections plus the old memory
snapshot at a safe boundary. A dedicated `ContextPreparation` runs outside Catalog locks before a
new ordinary or policy-planning request freezes; an already prepared request is never rewritten.
Cancellation exits that boundary through the normal durable Cancelled terminal path without waiting
for the Host callback. Other preparation failures atomically fail the Run with a
`context.preparation_failed` fact containing a stable code and safe message, not the raw Host error.
No new model request/step or planning operation is fabricated for a pre-admission failure.

The native Catalog stores a read-only, scoped memory projection, not a CRUD copy. Newer per-note
facts are selected once per frozen request with stable identities and real EnvironmentFact provenance.
Their complete bodies remain in immutable RequestSnapshots. They are not additional raw-history
messages. Subsequent requests retain these facts until a successful compaction snapshot covers them;
recording delivery must not make an old snapshot forget a newer note. Native tool receipts suppress
the corresponding fact only after matching the real confirmed memory Operation, original
request/call, origin and exact receipt body. Arbitrary tool/MCP JSON is not receipt authority.

Selected, sent and successfully completed delivery records reuse real Catalog fact-event cursors.
Failed or cancelled requests never mark a fact committed. Planning requests use their real auxiliary
request/operation identity, quote the context as data and keep their own delivery records. A fork
copies the scoped projection's known-note identities but does not copy another branch's delivery ACKs.

Explicit compaction freezes a candidate memory snapshot and prompt configuration with its ancestor
range. Successful publication atomically replaces summary, snapshot and effective system. Newer
notes and original conversation tail survive. Failed/cancelled candidates leave the old checkpoint;
profile CAS rejects stale candidates, and deleting the last note clears its memory sections in the
next successful snapshot. This is explicit compaction, not automatic budget compression.

Context domain 3 is checked through read-only SQLite before any writable open/recovery. Unsupported
or malformed native context formats preserve their assets. Declared TEXT primary keys and revision
uniqueness require complete non-partial BINARY/ASC indexes; foreign-key targets/actions are checked.
ASC is the canonical format requirement, not a claim that DESC weakens uniqueness. No migration or silent reconstruction is
provided. Per-note tombstones and original typed-record operation receipts are retained while old
conversation checkpoints or unresolved effects may reference them. No automatic receipt/tombstone
GC is claimed; the memory owner does not release those operation records prematurely.

Native implementation verification is owned by the independent memory delivery review suites;
implementation/build status and acceptance evidence are recorded in the implementation plan after
source and binary freeze. These contracts do not imply that the complete native context design or
Pi cutover is finished.
