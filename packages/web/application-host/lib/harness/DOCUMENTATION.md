# Host harness services

This directory contains shared resource and product-domain services. Native Thread adapters in
`../kernel/` supply the original Catalog invocation, Source, Run and Operation authority. The directory
has no conversation registry, session worker, execution loop or fallback file writer.

Read [architecture](../../../../../docs/architecture.md), [resources](../../../../../docs/resources.md),
[retrieval](../../../../../docs/retrieval.md) and [runtime](../../../../../docs/runtime.md) for the
cross-cutting contracts.

## Component map

| Responsibility | Implementation |
| --- | --- |
| Fixed source preparation, materialization and integration | `working-state/` |
| Quick investigation admission and profile configuration | `../kernel/thread-collaboration.ts`, `../kernel/child-profiles.ts` |
| URL discovery/fetch, scholarly records and original material | `web-search.ts`, `web-fetch.ts`, `research-search.ts`, `web-materials.ts` |
| PDF/document views and material collections | `document-reading.ts`, `document-material.ts`, `material-collections.ts` |
| Editable Office packages and actual rendering | `../office/`, `../kernel/office-runtime.ts`, `../kernel/binary-file-owner.ts` |
| Built-in browser capability and native page owner | `../kernel/browser-runtime.ts`, Electron `browser-owner.ts` |
| Research attempt orchestration and fixed input | `experiments.ts`, `experiment-workspace.ts`, `experiment-backend.ts` |
| Machine commitments and observations | `resources.ts`, `gpu-resources.ts` |
| Environment forwarding | `environment-forwards.ts`, `environment-forward-server.ts` |
| Managed Source and MCP dispatch | `managed-source-service.ts`, `managed-mcp-service.ts` |
| Product settings actions | `settings-service.ts`, `settings-actions.ts` |
| Network target/proxy/redirect policy | `egress.ts` |

The table locates owners rather than duplicating the public API. Protocol and application-client types
supply concrete request shapes. Source identity, execution placement and navigation project remain
separate: changing a selected project or Host cannot retarget already admitted work.

Outbound HTTP(S) uses the executing Host's network in every deployment. Desktop, standalone Web and
Docker may reach localhost, LAN addresses, container DNS names and synthetic proxy addresses without
an extra enablement switch. `egress.ts` owns proxy/NO_PROXY selection, frozen request routing, cancellation
and transport errors; `http-target.ts` classifies IP addresses for diagnostics only. Model discovery,
search connections, image reads and rendered-page resources share this transport. Web acquisition also
honors the user's explicit domain rules on every resource and redirect. HTTP(S) validation does not
grant `file:`/`data:` access or transfer origin credentials across redirects.

Office originals use the same material snapshot records as PDFs. The overview retains a section
index without eagerly flattening the whole workbook; `office_read` finds content, ranges and objects
in the original file. Collection keyword search covers the retained representation. Parent-history
inheritance uses recipient-owned material references after verifying the parent's original ACL.
Deletion maintenance reads native lineage and drains execution before releasing records; persisted
collections and surviving explicit/inherited references retain their source bytes.

## Files, sources and processes

WorkingState preparation and integration use Rust Storage, file leases and original receipts.
Source capture fixes its original branch/revision; publication validates the original source, base,
target and candidate owner. A failed or unknown effect is not permission to reset or delete a Thread,
worktree or user asset. Historical session-owned records cannot authorize native publication or release.

Documents coordinates admitted disk mutations with editor buffers and the Rust backend. Mixed changes
retain intent, original receipts, conditional compensation and needs-attention states. See
[Documents](../documents/DOCUMENTATION.md) and [Recovery](../recovery/DOCUMENTATION.md).

Native process owners retain cwd, input, output and stop identity. Observing output cannot trigger
completion, and cancelling an observation does not prove that the process stopped. Actual exit and
writer receipts govern release. See [process consumers](../process/DOCUMENTATION.md) and [Terminal](../terminal/DOCUMENTATION.md).

## Retrieval and materials

Search and retrieval use admitted native sources and actual revisions. Quick retrieval is an
internal native Agent Run owned by the original code_retrieval Operation; formal retrieval uses
the same execution/tools through collaboration. Rust owns traversal, reads, structure and process
effects. Host supplies configuration and domain adapters, without a second planning/selection loop.
The original tool returns Job acceptance immediately. `retrieval_control` observes its latest actual
assistant message/action, parks the main Run when requested, or cancels that investigation. The native
Catalog queues one final answer through ordinary message ingress after executor/resource release,
including when the original parent Run has already completed. UI trace reads remain a presentation
API; the model does not need to retrieve tool evidence or ask another model to summarize progress.

Web search resolves a stable connection catalogue with independent credentials, default/fallback routes and
actual adapter capabilities. Missing settings enable the keyless Exa/Parallel route; explicit disabling,
empty connections and invalid settings do not. Objective guides queries without an extra request. Exact
connection selection never falls back; valid empty results differ from failures. Applied filters retain
upstream/post-filter/ranking semantics and time basis. Source preferences cannot relax network policy.
Selection-only preferences retain the anonymous route; an explicit empty connection list still disables
all connections. Upstream pages are retained whole: display cursors consume the current filtered page
before advancing, reuse its response cache, and reject changed page ordering after a refetch.
MCP search completes on the matching JSON-RPC response event and closes its SSE reader without waiting
for connection EOF. Provider attempts use the existing MCP request timeout budget, including response
body reads; a timed-out request is aborted before the configured fallback starts. This is a network
attempt budget, not a Run or result-size limit. Caller cancellation never starts another provider.

Search and scholarly metadata observations use `web-sources.ts` and the original material owner. They
remain distinguishable from downloaded pages/full papers. Fixed citations carry revision/range, while
native typed descriptors establish delivery. A copied citation alone cannot grant access. Reports,
paged history and compaction carry only sources acquired through that typed ancestry.

`web-fetch.ts` separates acquisition, extraction and display completeness. Question-guided selection
returns original ranges, structure and continuation. Optional assistance uses original purpose-scoped
inference receipts, validates connection/range output, and never replays an unknown paid operation.
Pages that fit the requested display return directly without assistance. Longer sources include unmatched
structural blocks as well as lexical candidates; actual model capacity determines full versus partial
coverage. Partial packs interleave relevance with page-wide coverage and use logarithmic token counting.
GET/HEAD rendering belongs to the actual BrowserOwner through Host egress, including every resource and
redirect. Electron's temporary capture session denies independent network, worker/frame/socket and
interactive requests; login-dependent work needing those capabilities continues through Browser Use.
Caches expire actively, share only compatible producers, and drain the last consumer on cancellation.

PDFs and Web materials share original-byte views, explicit grants, revision checks and page-image parts.
`ThreadMaterials.upload` uses `documentReader` to retain original PDF bytes in MaterialStore under the
admitted Thread scope. Submission, the three enqueue paths and child continuation pass the captured
snapshot, without browser extraction or a separate Rust PDF wire. Knowing a material ID does not grant
access; collection sharing is an explicit owner operation.

## Research jobs

`research-identity.ts` validates trusted native Thread/branch/source/family identities. Sharing a
workspace does not authorize another task's attempts. Read scope does not imply process control.

`experiments.ts` returns the original durable attempt before capture, placement and materialization.
Until fixed input exists, its spec is explicitly absent: it is observable/cancellable but cannot rerun
an invented spec. Stable request identity reconciles accepted retries before another capture. Source
and transfer grants retain their own Operation lifetime rather than ending with an ordinary Run.

The accepted worker owns its lifetime independently of HTTP observation. Attempt, execution backend,
collected artifact and published log high-water remain distinct. Stored chunks beyond that high-water
are not delivered output. Collection failure cannot become successful empty artifacts; explicit collect
retries collection, not execution. Read locators are provenance, not proof of downloaded bytes.

Native research adapters bind real Catalog invocations to these records and use Catalog Wait for
observation. User submission is a User Operation. Tree cancellation reaches the original attempt and
reconciles its late receipt; normal Run settlement/archive does not terminate independent experiments.

## Service-forward ownership

`environment-forwards.ts` owns listeners, opening/closing work and streams for native work identities.
`kernel/environment-forward-runtime.ts` binds tools to the original Catalog HostJob. A local address
creates no listener; a managed target is fixed once. Credentials stay with the connection owner.

Acceptance means the coordinator listener is ready, not that the target service answered. Closing
drains that listener and its streams, not the remote process. Lost replies query the original owner
without opening a replacement. An unavailable epoch cannot prove physical stop. Bot Sleep includes
these Jobs; wake does not silently recreate a closed forward. Its loopback address is local to the
coordinator, not necessarily the operating desktop.

## Related domain owners

Bot profiles and lifecycle live in `../bots/`, while Catalog owns their native Thread entries and
execution. Sleep, wake, deletion and Computer cleanup retain their actual stop/receipt obligations.
[Memory](../memory/DOCUMENTATION.md) owns notes and Bot knowledge; [Computer](../computer/DOCUMENTATION.md)
owns desktop assignments. Catalog owns follow-up definitions, occurrences, waits and ingress; Host
observers described in [kernel adapters](../kernel/DOCUMENTATION.md) are transient subscriptions.

## Settings self-control

`settings_search/read/update/action` share the catalog's field constraints and executable per-verb
schemas. Discovery does not prove owner availability. Saved layers, merged **configured next-use**
values and an active Run snapshot are distinct: accepted model requests retain their configuration.
JSON `set` replaces its declared path; native context tuning exposes leaf fields, while provider/MCP
patch actions preserve omitted secret fields through their actual owner. Secrets are status-only.

App and Agent-file groups use their original serialized CAS writers. A conflict does not silently
retry against a new revision. Compound receipts retain original input index, scope, revision, mutation
certainty and consumption timing; later owner failure never rolls back or erases an earlier commit.
There is no cross-owner transaction. An owner-normalized/rejected value is returned as actual saved
state, not falsely acknowledged as the requested input. Async observation failure preserves the last
known operation identity/state; subsequent status calls retry observation, never the effect. Durable
status updates compare the original observed record revision and cannot overwrite terminal receipts.

Client writes resolve one authenticated Thread/branch-to-Surface binding for the entire client batch.
Synchronous UI stores offer same-turn compare-and-swap with value-sensitive opaque revisions. Async
Desktop IPC owners advertise last-write-wins and refuse a CAS guard they cannot enforce. Missing,
ambiguous, disconnected or unacknowledged surfaces never imply success.

`self.bot-profile` resolves the admitted Thread's Bot, not a supplied Bot id. Its real record revision
protects name/instructions/model edits. Name is immediate; instructions/model propagate to the Bot's
direct conversations at safe request boundaries, not delegated work. A saved profile with failed
propagation retains the committed revision and reports the separate propagation problem.
`self.conversation-model` addresses only the admitted Run and uses the original Operation identity for
selection idempotency. Desired, active and admitted model controls are separate; changing this selection
does not change Bot profiles, Agent presets or future-session defaults.

The Host extension/MCP approval policy is not Rust Source/Storage authority. Tool enablement selects
availability, not native grants. Ordinary preference grants do not grant permission-policy management
or credential routing: compound items are normalized to declared field targets before the gate.
Static sensitive fields expose explicit management delegation for that field's future values; provider
credential destination grants instead include the exact base URL/mount, account, transport and opaque
provider parameters. Validated suffix paths remain below that mount and ordinary model/budget choices
do not change the credential destination. Custom provider parameters remain conservatively sensitive
until their owner declares routing semantics; the approval explains that scope. Bypass does
not silently delegate those management powers. Project policy remains narrowing-only. Smart and
accept-edits are retained as readable legacy values but are not implemented; their effective behavior
is normal, and new writes use supported normal/bypass choices. Allow-always's own Agent-settings write
can advance a submitted global CAS only through that exact admitted before→after transition; any other
concurrent write still conflicts.

Project schedules use their existing scheduler and Source Host receipts. See [scheduled tasks](../scheduled-tasks/DOCUMENTATION.md)
and [MCP authority](../mcp/DOCUMENTATION.md).

Compatibility-only compaction recovery, dispatch/worktree knobs, old auto-worktree/auto-accept
preferences and the unused permission-judge slot remain readable with their stored values, but are
explicitly unsupported rather than advertised as functioning controls. This does not add a native
recovery/dispatch/worktree execution implementation; original Source and runtime owners remain intact.

## Verification

Use focused Web suites for changed domain adapters and `test:kernel` for real native resource
consumers. Controlled transports/providers establish only their tested lifecycle boundaries; real
remote-machine, Slurm, installed-product and model-quality behavior require their own evidence.
Commands are in [development](../../../../../docs/development.md).
