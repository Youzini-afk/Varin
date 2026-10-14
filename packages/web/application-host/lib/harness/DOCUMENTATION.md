# Host harness services

This directory contains product task/resource services and the Pi HarnessRouter adapter. The same
file, research, material, Computer, MCP and knowledge owners also serve Agent runtime adapters in
`../kernel/`. Sharing a domain service does not merge Pi's ThreadRegistry with the Rust Agent Catalog.

Read [architecture](../../../../../docs/architecture.md), [resources](../../../../../docs/resources.md)
and [retrieval](../../../../../docs/retrieval.md) for cross-cutting contracts. Agent execution, durable
Operations and native follow-ups are described in [runtime](../../../../../docs/runtime.md).

## Pi request admission

`router.ts` receives broker-authenticated worker events and dispatches allowlisted Host services.
`service-host.ts` owns shared output/cursors and per-session services. `agent-root-runtime.ts`,
`research-root-runtime.ts` and `attached-root-runtime.ts` attach real Pi sessions to their durable task
owners; a shell mounting or a settings read does not create an execution.

Root lifecycle admission precedes a request, but the lifecycle queue is released while the actual
service runs. Slow tools must not serialize unrelated tools or compaction-worker queries. Cancellation
reaches the Router independently; shutdown cancels admitted requests before draining root queues.
A tool-set refresh in the same worker generation updates grants without replacing live shell/input
state; worker replacement retires the old generation.

Project binding supplies organization and a default cwd, not a universal filesystem boundary. Explicit
paths/cwd resolve through actual Host path/allowed-directory policy. Changing one command's cwd does
not change the session default. Path admission and resource leases still apply to unbound conversations.

## Component map

| Responsibility | Implementation |
| --- | --- |
| Authenticated Pi dispatch and service grants | `router.ts`, `service-host.ts` |
| Task catalog, Run lifecycle, admission and waits | `thread-registry.ts`, `thread-runtime.ts`, `thread-wait-runtime.ts` |
| Isolated sources, publication and selected code transfer | `working-state/` |
| Real shell handles and command presentation | `shell-supervisor.ts`, `shell-discovery.ts` |
| Large output and delivery cursors | `output-store.ts`, `observation-cursors.ts`, `output-organize/` |
| Scoped native content search and progressive Explore | `search-service.ts`, `explore-service.ts`, `explore-query-*.ts` |
| LSP navigation/diagnostics for the admitted view | `lsp-nav.ts`, `diagnostics-service.ts` |
| URL discovery/fetch, scholarly records and original material | `web-search.ts`, `web-fetch.ts`, `research-search.ts`, `web-materials.ts` |
| PDF/document views and material collections | `document-reading.ts`, `material-read-service.ts`, `material-collections.ts` |
| Research attempt orchestration and fixed input | `experiments.ts`, `experiment-workspace.ts`, `experiment-backend.ts` |
| Machine commitments and observations | `resources.ts` |
| Environment placement and forwarding | `environment-services.ts`, `environment-forwards.ts` |
| Pi durable follow-ups | `followups.ts` and its source observers |
| Shared live MCP connections | `mcp-service.ts`, `managed-mcp-service.ts` |
| Network target/proxy/redirect policy | `egress.ts` |

The exact public service names and DTOs are in `packages/protocol`; the table is navigation, not a
second API declaration. Some domains have narrower modules linked below.

## Collaboration and immutable results

Ordinary Pi dispatch uses Worker/retrieval configurations and the caller's admitted tool/model choices.
Input preparation precedes Run admission: preparing work is visible but cannot be dequeued. Once its
baseline is ready, admission starts or queues the Run. Cancellation follows the original actor lifetime.
Task ancestry controls discovery/history reads; read access does not grant sibling lifecycle control.

Directed messages enter Pi history through original idempotent notification/continuation paths. The
teammate roster is request-local, excludes the observer and does not replay a second inbox into context.
A wait without a duration is an event subscription, not repeated model polling. Persisted targets,
positions and deadlines let the original owner restore subscriptions after restart. New addressed
input can interrupt a live wait without pretending the dependency completed.

`working-state/code-submission.ts` fixes selected source changes and records accepted/queued/applied
separately. Stable operation identity returns the original receipt even after the recipient edits later.
The acknowledged baseline folds only sent source changes, excluding recipient edits and unsent work.
Integration uses the original source/base/target and conditional mutations, not an unqualified file copy.
Attached root deletion does not delete the user's Pi transcript as if it were a child-owned asset.

Rust-backed WorkingState, file gates and Recovery hold physical/durable authority. The old TS store or
local SQLite journal exists only as an isolated fixture seam; production cannot fall back to it.

## Files, documents and shell

`document.readSource` and path overlays select authorized live bytes, fixed drafts or the exact working
branch. `document.surfaceWrite` coordinates Registry buffers and admitted disk mutations through
Documents and the Rust backend. The Pi worker does not become a fallback writer when the Host fails.
Mixed batches retain intent, original Surface receipts, conditional compensation and needs-attention.
See [Documents](../documents/DOCUMENTATION.md) and [Recovery](../recovery/DOCUMENTATION.md).

ShellSupervisor adapts the existing terminal/native process owner. Each command fixes its own cwd;
process handles retain stdin/output/stop identity. Observing output does not trigger completion, and
cancelling an observation does not kill a process. Native exit/writer receipts decide release. Raw
output is retained with bounded delivery; output organization changes presentation, not original bytes.
See [process consumers](../process/DOCUMENTATION.md), [Terminal](../terminal/DOCUMENTATION.md) and
[output organization](output-organize/DOCUMENTATION.md).

## Retrieval and material

Search/explore use admitted native sources and actual revisions. Host policy, candidate ranking and
packing stay in TypeScript; Rust owns file traversal/body and structure computation. Graph relations
are supplemental facts, not permission to trust old positions. The full mechanism belongs to
[retrieval](../../../../../docs/retrieval.md) and [structure](../structure/DOCUMENTATION.md).

Web search has a Host-owned keyless default and disclosed failure-only fallback; an explicitly selected
provider never silently becomes another provider. Domain filtering applies before disclosure, an empty
allowed set makes no request, valid empty results differ from failures, and cancellation ends the chain.
Web fetch retains original-page/snapshot authority independently of discovery snippets.

Scholarly search returns one provider page and its actual continuation, identity and metadata/content
state. It does not merge records on title similarity or claim metadata is the paper. Local PDFs and Web
materials share original-byte views, explicit grants, revision checks and actual page-image parts.
Material collection sharing is an explicit owner operation, not access inferred from a known ID.

## Research jobs

`research-access.ts` and `research-identity.ts` derive Pi callers from durable session binding and Agent
callers from Catalog Thread/branch/source/family. Sharing a workspace does not authorize another task's
attempts. Read/resource capabilities do not imply process-control permission.

`experiments.ts` returns the original durable submitted attempt before capture/placement/materialization.
Until fixed input exists, its spec is explicitly absent; it is observable/cancellable but cannot rerun a
nonexistent spec. Stable request identity reconciles accepted retries before another capture. Source and
transfer grants retain their own Operation lifetime rather than being retired with an ordinary Run.

The accepted worker owns its lifetime independently of the HTTP response. Attempt, execution backend,
collected artifact and published log high-water remain distinct. A persisted chunk beyond that high-water
is not delivered output. Collection failure cannot become successful empty artifacts; explicit collect
retries collection, not execution. Read locators are provenance, not proof the bytes were downloaded.

Agent research adapters bind the real Catalog invocation to these original domain records and use
Catalog Wait for separate observation. User submit is a User command, never a synthetic ModelStep/Pi
session. Native tree cancellation reaches the original attempt and reconciles its late receipt.
Normal Run settlement/archive does not terminate independent experiments. Real remote-machine, Slurm,
installed-product and model-quality coverage must be established separately.

## Service-forward ownership

`environment-forwards.ts` owns listeners, opening/closing work and streams for tagged Pi/Agent owners.
`kernel/environment-forward-runtime.ts` binds Agent tools to the original Catalog HostJob. A local
address creates no listener; a managed target is fixed once. Credentials stay with the configured
connection owner, not durable Job metadata.

Acceptance means the coordinator's listener is ready, not that the target service answered. Closing
drains that exact listener and streams, not the remote process. Lost replies query the original owner
without opening a replacement. An unavailable original epoch cannot prove physical stop. Bot Sleep
includes these Jobs; wake does not silently recreate a closed forward. The loopback address is local to
the coordinator and does not establish reachability from another operating desktop.

## Bot lifecycle

BotService owns a tagged Pi or Agent entry, profile and durable activity intent. Creating/updating a
profile does not convert an existing runtime or import another entry's assets. Default creation remains
Pi. Model resolution uses the actual selected runtime, not the renderer's first catalog item.

Sleep closes new admission before cancelling original child, context, memory, process, domain and
Computer work. Host preparation/mutations remain owned until their underlying promises settle even
when their observers already cancelled. Unknown remote stop keeps Sleep incomplete. Wake releases
eligible holds through normal continuation rules; it does not replay unknown effects or resolve user
Pause/questions. Deletion first completes that same stop and respects foreign retained references.

VM shutdown follows confirmed work termination and applies only to this operation's managed VM when
other work/human control does not retain it. An ACPI request is not observed shutoff. Retry/restart uses
the original identity; wake starts only VMs it stopped. Workspace files, other tasks and native Pi assets
are not swept with a Bot record. See [Computer](../computer/DOCUMENTATION.md) and [memory](../memory/DOCUMENTATION.md).

## Follow-ups and settings

Pi `followups.ts` retains definitions, occurrences and source cursors in the original kernel records.
Compatible observers share subscriptions; typed observations precede cursor advancement. Composite
leaves remain implementation detail. Source-less/Agent follow-ups instead use their Catalog owner,
with transient Host observation adapters described in [kernel adapters](../kernel/DOCUMENTATION.md).

Deliveries use the original directed-message/continuation identity. A lost shell is unavailable, not
restarted. An occurrence, optional Wait, delivery and watched resource have separate lifetimes. Opening
a management view never triggers a model. User mutation routes derive the actual authenticated session
owner; supplied body fields cannot override it.

Settings tools route to actual owners and frozen Surface targeting. Tool exposure, configured readiness
and permission are different. Project schedules use the same scheduler as their GUI; native managed
project mutations go to the Source Host's original receipt owner. See
[scheduled tasks](../scheduled-tasks/DOCUMENTATION.md) and [MCP authority](../../../../pi-host/src/mcp-authority.md).

## Verification

Use the existing Web focused suites for changed domains and native `test:kernel` for real resource
consumers. Fake provider/transport/driver tests establish wiring and lifecycle only. Historical phase
labels and test counts are not current all-platform acceptance. Commands and remaining real-environment
checks are linked from [development](../../../../../docs/development.md).
