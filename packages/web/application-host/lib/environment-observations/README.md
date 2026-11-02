# Environment observations

## Ownership and identity

Documents post-commit callbacks, successful Git status samples and tagged user-terminal
command completions are lightweight producers. There is no filesystem-wide watcher, LSP
warm-up or PTY-output mirror. Native Agent tools already own their tool history and are not
mirrored as user observations. Fixed branches and non-local Sources never borrow local cwd.

`runtime.ts` allocates or preserves the producer capture identity and original observation
time before asynchronous source resolution. At the first successful native source snapshot,
it binds that workspace event to an exact Thread/branch/Run/Source. This is initial dispatch
attribution, not a claim that the selected Run was already active at observation time. A new
Run in the same workspace may receive an earlier timestamped change. Documents allocate one UUID
per actual committed subchange; an operation ID is provenance, since apply and compensation
may share it. Terminal identity includes the Host incarnation and terminal generation/command
sequence. Git dedupes consecutive queued samples, not all occurrences of the same state.
Git branch-transition attribution and sample time are frozen before asynchronous root resolution;
a sampled state is not a complete external change log or a claim that the state remains current.
After binding, retries retain the original owner and body. Epoch is a dispatch fence, not
part of the immutable event identity.

Catalog and ContentStore own original bytes, capture identity/body conflict checks, admission,
legacy import progress and delivery evidence. KnowledgeStore remains the owner of actual
Bot knowledge and plans, but no new environment capture passes through its event journal.
There is no cross-store transaction between a Documents commit and the first Catalog capture:
a crash in that interval can lose an observation. This is not advertised as durable delivery.

## Scheduling and failure outcomes

`coordinator.ts` is a volatile bounded per-source queue with one in-flight batch per source.
Repeated wakes coalesce; individual edit and command facts do not. Batch/count/byte budgets
bound retained JavaScript data and native frame pressure, not the size of already-accepted
original content. Sources take turns on the existing native request window. Intake before
asynchronous source resolution is bounded too. Overflow reports a gap rather than silently
truncating a command or acknowledging a lost capture.

A matching native receipt releases the original body. A definite pre-dispatch failure keeps
it pending; an ambiguous response retains the exact envelope as unknown. Recovery first
looks up original receipts, then may resubmit the same idempotent identity/body under the
same source identity with a refreshed epoch. Receipt absence is not proof that an earlier
executor stopped; atomic native dedupe makes this particular replay safe. A different
current Source cannot take over old work. Closing first stops and drains the owned Git/terminal root-resolution adapters, then
reconciles the finite capture prefix while Documents and native owners are still alive; unresolved identities remain explicit.

## Request and representation boundaries

Preparation reports already-durable native progress plus Host pending/unknown/gap diagnostics.
It never waits for producer queues or legacy import to become empty. Native input consumption
freezes its own committed, finite selection page; the Host snapshot is informational, not a
second cutoff authority. Later passive observations wait for a later legitimate request and
cannot veto completion or trigger paid continuation. Existing explicit Bot-work notifications
and mandatory user ingress keep their separate activation rules.

Native captures retain their original canonical event once and create a frozen versioned
model representation. Narrative body fields (command/cwd/path/branch/note) share a 4 KiB preview budget, with command identity and
exit status preserved and omitted-byte counts explicit. Original bytes are a dependency of
that representation for existing ContentStore GC. `read_thread` with
`query: {kind: "observation", observationId: "..."}` retrieves paged originals through
historical conversation authorization, not through a bare content hash. Delivery evidence
identifies the exact representation shown, never implies omitted raw bytes were shown.

Shell integration retains at most 512 KiB per OSC frame, matching the terminal-history memory
allocation. An oversized complete or unfinished frame is discarded as a whole and counted
in `TerminalSessionInfo.discardedIntegrationFrames`; it is not a truncated completed command.
This parser coverage signal is distinct from a Catalog receipt for a completed capture.

## Preserved legacy state

The read-only importer in `knowledge/context-publication.ts` runs in the background. Native
Catalog transactions commit each original legacy page and its scanned prefix together, so
skipped records do not create repeated rescans. Old `observation:<run>:<node>` identities,
rendered content and digests remain exact; today's projection is only for newly captured facts.
Unavailable or damaged journals preserve their files and cannot hold a request boundary open.
