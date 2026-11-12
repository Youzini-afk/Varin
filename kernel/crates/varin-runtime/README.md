# Agent runtime crate

`varin-runtime` owns Varin's native Thread/branch history and execution facts through `varin-kernel`.
The product uses this Catalog for conversations, queued input, Runs, Operations and durable events.
It does not import historical Pi sessions or duplicate Host domain asset stores.

Read [runtime ownership and mechanisms](../../../docs/runtime.md) for the cross-layer contract.
This document is the local code map and maintenance boundary, not an implementation timeline.

## Code map

| Responsibility | Entry points |
| --- | --- |
| Single durable owner, short metadata transactions, format preflight | [catalog.rs](src/catalog.rs) |
| One-time supported-generation conversion before recovery | [catalog_upgrade.rs](src/catalog_upgrade.rs) |
| Original delegated model selection, short history and frozen binding commit | [catalog_delegation_model.rs](src/catalog_delegation_model.rs) |
| Sparse Unicode ranges into original stored history bodies | [content_text.rs](src/content_text.rs) |
| Thread titles, archive/pin, read positions and visibility tombstones | [catalog_threads.rs](src/catalog_threads.rs) |
| Transaction-consistent, metadata-only Host attention (including hidden unsettled work) | [catalog_attention.rs](src/catalog_attention.rs) |
| Deleted conversation metadata retirement and surviving reference protection | [catalog_retention.rs](src/catalog_retention.rs) |
| Worker lifecycle, cancellation, policy actions, model/tool settlement | [execution.rs](src/execution.rs), [supervisor.rs](src/supervisor.rs) |
| History/request commit, safe restoration, explicit navigation | [catalog_execution.rs](src/catalog_execution.rs), [catalog_recovery.rs](src/catalog_recovery.rs), [catalog_navigation.rs](src/catalog_navigation.rs) |
| Fixed attachment descriptors, delivery relations and retention | [catalog_attachments.rs](src/catalog_attachments.rs) |
| Stable typed model references, execution numbering and scoped public export | [catalog_model_references.rs](src/catalog_model_references.rs), [catalog_export.rs](src/catalog_export.rs) |
| Immutable bodies, media, publication and collection | [content.rs](src/content.rs), [output.rs](src/output.rs), [content_collection.rs](src/content_collection.rs) |
| Scope-local bindings, tools and context transforms | [composition](src/composition.rs) |
| Resource conflict/capacity admission and nested calls | [resource_admission.rs](src/resource_admission.rs), [execution_capacity.rs](src/execution_capacity.rs), [nested_tools.rs](src/nested_tools.rs) |
| Context checkpoint/summary plans and capacity | [context_job.rs](src/context_job.rs), [context_execution.rs](src/context_execution.rs), [catalog_context_jobs.rs](src/catalog_context_jobs.rs), [context_capacity.rs](src/context_capacity.rs) |
| Protocol adapters, frozen bodies and credential resolution | [providers](src/providers/README.md), [request_body.rs](src/request_body.rs) |
| Child/family work, current/history directory, messages and continuation | [catalog_collaboration.rs](src/catalog_collaboration.rs), [catalog_delegated.rs](src/catalog_delegated.rs), [catalog_family.rs](src/catalog_family.rs), [catalog_messages.rs](src/catalog_messages.rs), [catalog_activation.rs](src/catalog_activation.rs) |
| Durable conditions and deliveries | [catalog_observations.rs](src/catalog_observations.rs), [catalog_followups.rs](src/catalog_followups.rs), [catalog_process_wait.rs](src/catalog_process_wait.rs), [catalog_reply_wait.rs](src/catalog_reply_wait.rs) |
| Bot arrangements, event receipts and matching | [catalog_followup_events.rs](src/catalog_followup_events.rs), [catalog_followup_event_transport.rs](src/catalog_followup_event_transport.rs), [catalog_followup_event_files.rs](src/catalog_followup_event_files.rs), [catalog_followup_external.rs](src/catalog_followup_external.rs) |
| Goals, Bot suspension and memory work | [catalog_goals.rs](src/catalog_goals.rs), [catalog_bot.rs](src/catalog_bot.rs), [catalog_memory_work.rs](src/catalog_memory_work.rs) |
| Request usage, retained billing attribution and content-free ledger | [catalog_usage.rs](src/catalog_usage.rs), [catalog_usage_ledger.rs](src/catalog_usage_ledger.rs) |
| External Harness bindings, admissions and observations (not native execution loops) | [catalog_external.rs](src/catalog_external.rs) |
| Independent domain Jobs and calendar occurrences | [catalog_host_jobs.rs](src/catalog_host_jobs.rs), [catalog_calendar.rs](src/catalog_calendar.rs) |

Private domain types stay in Rust. [The kernel schema](../../protocol/schema.json) generates wire
Rust/TypeScript DTOs and shared state enums; `types_generated.rs` is generated output. Current format
constants and read-only validation live beside their domains. Internal structures may evolve freely;
opening an existing supported generation converts it once, then all business readers use the current
representation. Do not add parallel old-format execution/read paths or a second format ledger.

## Boundaries to preserve

- One `runtime.owner` lock protects `conversation.sqlite`. WAL/FULL transactions commit facts and
  events together. Read-only preflight identifies supported generations and rejects unknown/newer or
  malformed stores before writable recovery. Supported upgrades are 78 → 79 → 80 → 81 → 83 → 84 → 85 → 86 → 87 → 88 → 89 → 90 → 91 → 92 → 93 → 94
  and standalone 82 → 83 → 84 → 85 → 86 → 87 → 88 → 89 → 90 → 91 → 92 → 93 → 94. The first two steps initialize external-agent records and the usage ledger;
  old receipts lack settlement attribution and are not backfilled. The 80 → 81 step creates Zone2
  capture tables; 81 → 83 indexes original history text ranges without copying bodies. Standalone 82
  already contains those indexes but no Zone2 tables, so 82 → 83 initializes only that missing domain.
  Preflight recognizes each actual layout rather than assuming all generations >=81 contain Zone2.
  Original content identities, captures and paid receipts survive. Conversion, marker and upgrade
  event commit atomically before epoch changes or recovery. Format 89 extends the original follow-up
  owner with Bot-owned arrangements, source receipts, per-arrangement matching watermarks, object routes
  and remote consumers. Existing work follow-ups retain their source Runs and original receipts;
  event delivery reuses native ingress or the real external turn ledger without synthetic Runs.
  Format 90 adds pending/prepared extension admission only to new automatic roots. Existing launches
  retain their exact semantics with no marker; the upgrade does not rewrite identities or receipts.
  Format 91 restores missing Responses cache-write counts from retained raw ModelStep/planning receipts
  and their matching existing ledger rows, preserving frozen pricing and settlement identity. Missing
  evidence stays unknown; conversion never creates historical charges or replays execution effects.
  Format 92 protects frozen quote relations in original input bodies from readers that cannot project
  them. It does not rewrite historical bodies, resource identities or idempotency receipts.
  Format 93 adds Catalog-local typed model references and execution numbering. Catalog 92
  accepts either the quote-only layout with all seven index tables and both external item columns
  absent, or the complete validated collaboration index. Existing spaces, references and allocation
  high waters survive unchanged; partial or malformed layouts are rejected before writable recovery.
  Format 94 protects the separate frozen source mappings in readable compaction recipes. Old recipes
  keep their original source slicing, quotation and retention semantics without rewriting their bodies.
  Preflight for 82/83 scans User/Assistant reference metadata for index-object presence, not content
  bodies. This startup work scales with history records; typed index validation remains at use and
  malformed indexes never trigger request-time repair or a full-body fallback.
  Failure or process interruption before commit rolls back the conversion; reopening retries it.
  Existing immutable bodies, identities and original receipts remain in place without a full database copy.
  A failed open cannot turn history into an empty cache or replay a dispatched effect.
- Catalog owns references and identity/CAS checks. Providers, tools, extension callbacks, filesystem
  scans, body hydration/serialization and network work execute outside its lock. Capture the relevant
  epoch/revision/head, prepare on a worker, then recheck at publication.
- Immutable ContentStore bodies are installed before their metadata references. Publication leases
  span staging and commit; GC follows domain roots and typed dependencies. Public media/body reads
  require their actual history/input/Operation/event/family holder, not possession of a hash.
- `RequestPrepared`, dispatch, model completion, tool acceptance and external receipt are distinct
  facts. Never replay an ambiguous dispatched model/effect to repair missing acknowledgement.
- Operation business outcome/effect and `executor_stopped` are independent. Cancellation intent,
  reader abort, output completion and missing occupancy do not prove an external executor stopped.
  Late receipts keep the original executor epoch and cannot settle replacement work.
- A model request retains its actual provider/tool/context bindings and original receipts. Recovery
  never resends a dispatched request or repeats an effect to replace missing acknowledgement.
  Ordinary root assembly prepares the executable's current builtins and the Host's current enabled
  extension directory for new, queued and recovered Runs. Binding commits this complete composition,
  including empty, independently of the retained Agent/source/principal/model identity. Historical
  declarations and tool-name lists do not become permanent limits on subsequent requests; explicit
  Agent and Source selections still apply. Existing request snapshots and results are unchanged.
  Delegated capabilities and context-job recipes retain their separate admission owners. Within a
  running process, relevant Host changes use the existing closed-boundary tool-update path, and
  retained endpoints keep their normal retirement and revocation semantics.
- Branch history has one writer. Background summary, memory and planning work uses separate admitted
  identities. A Wait releases active execution while retaining the dependency/continuation; cancelling
  observation does not cancel the observed Job or withdraw an independent follow-up definition.
- Current memory is a request projection of the existing Memory owner. It is not a second note store.
  Only successful original delivery facts advance acknowledgement; summaries/navigation never delete
  the underlying memory to make a context projection agree.

Thread product metadata is committed with its event and original command receipt. Rename, pin,
archive and delete use a metadata revision; read acknowledgements monotonically advance only through
the observed durable event cursor. Metadata changes do not create unread activity. A delete is a
visibility tombstone that requests content maintenance. It rejects new user input,
messages, explicit child continuations and forks while already accepted queue/child/Run work retains
its original execution and settlement duties. Internal owner discovery includes archived/deleted
Threads; the separate product Catalog query omits tombstones and auxiliary inference Threads.
Maintenance waits for terminal Runs and original executor/model settlement before retiring owned
history, requests and receipts. Surviving branch ancestry and relational consumers keep shared data
reachable. Small Thread/branch identities, content-free creation receipts, direct Bot bindings and deletion
receipts remain for stable identity and replay. Principal attribution stays solely on Threads.
Explicit Bot deletion also retains reserved identities but clears titles, pins, title progress and history
heads. Legacy missing creation facts stay unknown; reads/maintenance remain possible without treating
unknown ownership as ordinary-thread execution permission. Bot entry resolution and fallback creation
are one Catalog transaction, not a Host read/create race. Calendar invocation identities have no body
or input FKs. Format 88 gives legacy definitions an atomic random manual-key prefix: new UI requests
freeze it with their key, retries never retrofit it, and old unknown requests fail closed without blocking
new manual work or changing scheduled cursors.
ContentStore then collects unreferenced immutable bodies through its existing reader/publication fences.
Inline metadata commands are not ContentStore roots. Active deleted conversations are reconsidered on
durable execution events and Host restart; deletion does not cancel their original execution duties.

## File handoff

`dispatch` and `send` accept strict `AttachmentSelection` values: one existing `ref` or one
sender-source `path`. The original Storage/material owner fixes content and retains the receiving
scope using the original operation identity before Catalog admission. Catalog performs no source
I/O under its lock and never resolves a hash, filename or text mention as read authority.
`attachment_deliveries` records the ordered descriptors with the same transaction as the original
message, queued input or dispatch. Retries compare both original intent and fixed descriptors.
A message can contain only attachments; dispatch still requires a task.

User `fileAttachments` and explicit `OutputPart::Attachment` parts survive history, queues,
reports and provider projection. Image bytes retain the existing typed-media path; a text-only
model gets an explicit notice and the file descriptor without changing the original image.
Dispatch model preparation derives image requirements from owner-prepared MIME types.
Command paths remain an on-demand resource-owner view, never durable attachment identity.

Material maintenance exposes typed delivery edges and typed inherited parts. The 84 → 85 upgrade
freezes legacy inherited material references once, with the format marker and existing receipts;
new dispatches do not scan ordinary text for snapshot IDs. Shared historical holders and forwarded
messages keep independent relationships until original Catalog retirement releases them. Bytes,
execution paths and derived parser caches remain with their original resource owners.

## Request and context cost model

`ConversationHistory` shares immutable item `Arc`s across policy views and prepared requests. A Run
worker retains only its latest compiled prefix under exact epoch/Run/branch/checkpoint/ancestry identity;
new steps hydrate the new suffix, while current memory/Goal/policy evidence is freshly projected.
Navigation, changed checkpoints and worker exit discard the derived cache.

Collaboration messages and original reports append through the existing input/history owner. The engine
never enumerates teammates at each model step. Report delivery is acknowledged by the actual receiving
history transaction, not by parsing prompt text or observing a directory. Ordinary idle Agents are not
started by passive reports; Bot continuation keeps its existing policy. Old delivery facts retain their meaning.

[Model references](src/catalog_model_references.rs) persist small typed original-owner/selection mappings
and per-Agent admission sequences. They contain no resource bytes and grant no access. Fixed file reads
retain the original source/version/format; accepted controls retain their selected execution across retries.
OutputBody keeps the original data and an optional stable model_data projection. Providers consume that
projection without rewriting historical bodies or introducing another receipt authority.
The shared provider composition includes non-null business data and ordered text/media once; empty
objects, false and zero remain meaningful. Source types retain role/permission boundaries without printing
internal provenance chains beside every result or image. Output previews address the frozen raw or
model_data field before adapters receive their semantic view, so continuation reads select the same bytes.

Follow-up preparation captures original operation/follow-up references under the publication guard,
then hydrates result bodies off-lock. Process and Host Job data remain separate from their text/media;
a final Job result supersedes only identical acceptance details from that same original Job. Event inputs
show useful source/object/sender/time facts once. Identity, transport cursors, receipt epochs and scheduling
controls remain in the original Catalog records. Existing consumption-boundary event sharing and ordered
state replacement still use those original identities, never text similarity or image hashes.

`RequestBody` is the only provider-body representation. Responses/Azure/Codex can retain independent
item fragments and tool schemas; Codex also retains the exact ordered system-text join. Grouped
protocols reuse complete messages under their actual source sequence and tool-call dependencies;
changing a trailing group rebuilds that group. Lease validation and credential dispatch checks still run on
every call. The final contiguous bytes are shared with HTTP/signing and retained in snapshots without
JSON rewriting. Vector validation, full-body assembly, persistence/hashing and media processing remain
real costs; fragment reuse does not establish lower peak memory or provider cache savings.

Compaction's Budget Decision and algorithm producer are separate contracts. Frozen text and model-node
DAG plans use the same summary Run/publication path. Its supervised executor loads original material
once and runs ready nodes concurrently, releasing successors as their own dependencies complete.
Original ModelSteps persist each request, dispatch, output and usage; the active-request index remains
exclusive for a conversation or one summary node. Audit history may reflect completion order, while
node inputs follow only the frozen recipe. Pure text produces zero ModelSteps. Complete serialized
capacity is checked before dispatch; reopening consumes completed nodes and never replays an unknown
dispatch. A failed node cancels and joins its remaining workers before the Run settles.

Summary recipes freeze the previous summary and all original material in the selected history range,
including originals retained by the preceding checkpoint. Native automatic compaction selects the latest
complete exchange as its capture boundary. The model returns a summary and original-block references;
it chooses retention throughout that material, rather than inheriting a predetermined recent suffix.
Offline tokenizer counts accompany each retention group, and the continuation budget covers summary plus
originals. User message parts and complete provider/tool exchanges share a group. Costs identify
unmeasured media/provider content and are not provider billing measurements. The original history remains
durable; checkpoint references keep selected items, including their media, alive through collection.
`token_count` loads a generic tokenizer binding frozen in model configuration and request snapshots:
an encoding name or a content-addressed Host-prepared `tokenizer.json` file. The Host owns discovery,
public downloads, gzip cache preparation and collection; Rust decompresses/hashes/parses each live
file binding once. Live counters share both file tokenizers and owned tiktoken encodings through weak
registry entries. A Run compiler retains its lazy counter across tool steps; the last counter releases
the vocabulary. Missing/unusable files use a labeled reference encoding without stopping the Run.
OpenAI mappings come from tiktoken. Matching trims/lowercases identifiers for lookup and recognizes
known model names at channel/deployment/tag boundaries, including suffix paths and fine-tune base IDs.
Numeric versions stay intact, conflicting encodings remain unmatched, and explicit tokenizer bindings
take precedence. The original provider request model is unchanged. Unmatched models use the o200k reference.
No model-specific vocabularies or parallel encoding tables are bundled. Immutable request fragments cache counts; changed
tokenizer bindings invalidate calibration/reuse identities. Summary input uses its own model tokenizer;
retained material uses the frozen conversation tokenizer. New summary sources contain readable text and
actual ordered media, with frozen source/part, retention-group and verified history-read relationships
kept separately. UTF-8 ranges address that fixed text, not serialized conversation records; each
fragment carries its prepared role, group cost and existing `summary_read` target. User quotes remain
evidence while sharing their original message's retention group. The continuation estimate covers the
complete original exchange's common provider view, including actions, arguments, statuses and all
visible parts, without counting hidden receipts or auxiliary quotation headings. Original records,
media owners and read permissions remain unchanged. Already-frozen recipes retain their earlier
quotation bytes, ranges, group assignments and cost interpretation when reopened.
Later input is appended after the frozen cut. Resource/personalization refresh preserves the selection;
forking or navigation that discards the summary also discards its selection.
Model nodes use [summary_tools.rs](src/summary_tools.rs) for read-only original history/output and related
records; normal Tool invocations retain query audit and recovery. Text plans remain tool-free.

## Composition with the kernel and Host

The kernel's [Run assembly](../varin-kernel/src/run_assembly.rs) connects this crate to real source,
resource and tool owners. [Host integration](../../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)
provides authenticated launch/control, credentials, MCP/extension bridges and domain adapters.
[Recovery](../../../packages/web/application-host/lib/recovery/DOCUMENTATION.md) combines original
file journals with guarded history navigation. Source Hosts retain their own resource receipts;
Catalog coordination never makes a remote hash or path local authority.

The [MCP contract](../../../packages/web/application-host/lib/kernel/MCP.md) documents retained server
bindings, Tasks, resources and reverse interactions. Its finite/drained callbacks and physical process
stop are separate evidence. Fixed branches currently provide no workspace-MCP execution cwd; managed
child composition does not merge arbitrary parent Source cuts.

## Verification

Local behavior tests accompany their owning domains; [execution tests](src/execution_tests.rs),
[supervisor waits](src/supervisor_wait_tests.rs), [content tests](src/content_tests.rs) and
[provider tests](src/providers/tests.rs) exercise shared seams. Kernel `*_review.rs` files and Host
`*.native.test.ts` consumers cover real owner composition at their stated fixture/platform boundary.
A source-level fixture is not live-provider, installed-product or physical multi-Host acceptance.

Use [development guidance](../../../docs/development.md) and repository scripts for commands. Choose
checks from the behavior changed; documentation-only consolidation does not require a runtime build.
Keep unresolved external effects, platform limits and unexecuted acceptance explicit rather than
substituting test counts for coverage.

## Quoted user input

Frozen quote objects and exact original UTF-16 occurrences live in the existing user-input
ContentStore payload. `input_quotes.rs` validates object/range bindings and performs the single
ordered native model projection. Selected text is not truncated; repeated occurrences deliver one
copy per input. Source metadata stays in history, while quoted assistant/tool material retains
external-data provenance. Images/files keep the existing media dependencies and attachment delivery
edges. UI snapshots named by structured quote sources remain roots in the original retention graph.

Raw receipt identity can omit prepared resource descriptors, but admission cannot. Queues, User
messages, history forks and reopen consume the same immutable input. Message/plain-text edits retain
selected objects and clear stale positions; they preserve original message routing and receipts.
