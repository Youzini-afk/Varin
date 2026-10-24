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
| Progressive retrieval and candidate ranking | `explore.ts`, `explore-query.ts`, `retrieval-pipeline.ts` |
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

Web search has a Host-owned keyless default and disclosed failure-only fallback. An explicitly selected
provider never silently becomes another provider. Domain filtering applies before disclosure; valid
empty results differ from failures. Web fetch retains original-page/snapshot authority independently
of discovery snippets. Scholarly search returns the provider's real page, continuation and content
state; a metadata record is not the paper itself.

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

Settings actions route to actual owners and frozen Surface targets. Exposure, readiness and permission
are separate. Project schedules use their existing scheduler and Source Host receipts. See
[scheduled tasks](../scheduled-tasks/DOCUMENTATION.md) and [MCP authority](../mcp/DOCUMENTATION.md).

## Verification

Use focused Web suites for changed domain adapters and `test:kernel` for real native resource
consumers. Controlled transports/providers establish only their tested lifecycle boundaries; real
remote-machine, Slurm, installed-product and model-quality behavior require their own evidence.
Commands are in [development](../../../../../docs/development.md).
