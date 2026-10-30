# Memory ownership and Agent personalization

Ordinary Agent memory is explicit, lightweight text. `agent-personalization.ts` owns one Rust typed
record (`agent.personalization`) containing global, project and Thread notes and scoped system-prompt
edits. Projects use the configured project ID; Thread notes use the native Thread ID. There is no
implicit import of historical sessions or knowledge records and no background extraction for ordinary chats.
New Agent notes append through the serialized mutation owner without a preliminary read. Updates and deletions
require the observed revision; original operation receipts deduplicate retries for both paths.

`kernel/memory-owner.ts` routes native memory tools through the admitted Run, operation and scopes.
The tool cannot read another project's or Thread's notes. Selected-message saves preserve chosen text
for editing without calling the Bot organizer. Authenticated `/api/agent-personalization` routes expose
CRUD, scope changes and prompt edits. Writes publish after their Rust receipt; UI edits carry the
opened revision and expose conflicts rather than silently overwriting a later edit.

Bot ownership comes from the Catalog Thread binding, never a caller-supplied mode. Bot requests
exclude ordinary Agent prompt overrides and notes. They use `memory-service.ts`, Bot/user/current-Thread
knowledge stores, recall and the optional organizer. Plans, observations, materials and indexing keep
their existing knowledge-store owners. Native resources and skills have their separate
[resource owner](../agent-resources/DOCUMENTATION.md).

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
deduplication key. Events and Run reports retain their distinct typed source identities.
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
sources.

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

## Continuous Bot memory

`bot-recall-context.ts` projects the current work and attributed incoming identities onto original
matters and registered project metadata. Related descriptions enrich the search query; explicit
memory-enabled work links pin provenance matches. The Bot entry is not a blanket association with
every descendant. Matter revisions, link changes and project metadata invalidate the recall cache
without reshuffling already delivered request facts. These hints neither grant source access nor
read unrelated tool transcripts. Forgotten passages are removed before constructing the query.

Original Knowledge environment observations publish to Catalog as soon as their writes settle,
outside the source write tail. The existing work-event ingress forwards task intervention to the
assistant and rechecks current follow access at delivery. Restart replays the original observations
against durable Catalog receipts. History recovery/navigation contributes its own original receipt;
neither event substitutes old reports for current file reads.

Memory bodies are free narrative; `nature` is optional. Selection and organization can cite several
exact original spans in one proposal. Instruction status still requires its actual user source;
reference material never gains authority through its wording. `remember`/`correct` accept source
references and exact same-scope `derivedFrom` memory versions. User edits remain independent user writes.

`bot-history.ts` reads recent actual incoming events and exchanges without hydrating tool logs.
Background collection uses `HistoryPage.afterId` and per-branch `history-cursor:` progress. It freezes
heads, hydrates only a model-budgeted chronological tail and advances only actually observed metadata.
The original span coverage handles partially processed large messages; one immutable batch can be
reused while its ranges settle. Empty metadata discovery never creates an empty memory store or calls
a model. Explicitly followed ordinary branches require a separate `memory` association.

Archive marks an item no longer applicable, preserving readable history. Forgetting also excludes
its original ranges and dependent memories from subsequent model reads. Same-store dependency links
are exact revisions; a correction invalidates dependent accounts atomically with the original mutation.
Default recall and the UI hide forgotten rows even when earlier revisions are requested.

The native memory projection records invalidations and source exclusions. A new exclusion fixes
`redactedThrough` once; opaque provider continuations through that boundary are removed, while newer
unaffected continuations retain their normal lifecycle. If an accepted summary absorbed invalid content,
native context rebuilding follows original checkpoint/history references and excludes affected source
ranges, inherited summaries and attributed quoted payloads. Original UI history remains unchanged.
The same projection applies to model-facing history readers and selective task-background handoffs.

## Ordinary Thread context

Native conversations use this same catalog through `kernel/thread-context.ts`. A trusted
Host admission supplies mode, role and nullable project; the current-thread scope is the actual
native Thread ID. The generic preparer requires that scope explicitly. Its `main` adapter alone
resolves a main conversation's project from the admitted workspace. Child contexts do not inherit
parent Thread notes or a parent's assembled system prompt. Bot contexts exclude ordinary notes
and prompt profiles.

`memory` exposes read/search and revision-checked save/delete. Native calls carry their real
Run, request/call-derived operation and admitted scopes through the private epoch-fenced memory
bridge. The existing personalization typed record remains the only note writer. The stored document
contains per-note latest revision metadata and its last mutation receipt. Historical receipts reuse
the existing atomic `storage.record.put` operation result: a lost return is reconciled using the
same stable origin and exact intent, never by repeating the mutation. `runtime.memory.reconcile`
queries those original receipts on an independent worker and settles the original native operation.
Missing or unknown outcomes stay unresolved. Existing valid notes need no migration or format reset.
UI stale edits and native mutations share the same record CAS. Scope moves retain both deletion of
the old scope and addition in the new scope.

The native conversation exposes the existing notes editor with its admitted global, project and
current-Thread scopes. It reuses the ordinary notes routes, editor and CAS rather than another store.
The Host resolves Thread scopes from the persisted Thread and context checkpoints. A namespace
does not grant a role; missing, inconsistent or unavailable native ownership fails closed. Bot
contexts have no ordinary-notes entry, and the Host independently rejects their Thread-note writes.

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
next successful snapshot. Automatic capacity preparation uses its own selected policy and the same publication boundaries.

The current context domain format is checked through read-only SQLite before any writable open/recovery. Unsupported
or malformed native context formats preserve their assets. Declared TEXT primary keys and revision
uniqueness require complete non-partial BINARY/ASC indexes; foreign-key targets/actions are checked.
ASC is the canonical format requirement, not a claim that DESC weakens uniqueness. No migration or silent reconstruction is
provided. Per-note tombstones and original typed-record operation receipts are retained while old
conversation checkpoints or unresolved effects may reference them. No automatic receipt/tombstone
GC is claimed; the memory owner does not release those operation records prematurely.

## Verification

`agent-personalization.native.test.ts` covers real Rust persistence, scope isolation and stale edits.
Native memory delivery suites exercise request facts and checkpoint publication; UI behavior tests
cover editing and scope selection. These local checks do not establish live-provider or installed-product
acceptance. Use the [development guide](../../../../../docs/development.md) for current commands.
