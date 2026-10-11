# Original-owner MCP user interactions

Date: 2026-10-11. Baseline: `ee86b1fbf592ee2939bec5603929d2f2a79aa2c7`.
Status: finite slice accepted after original-owner composition and independent design review.

## Finite scope

This slice implements reviewed form and URL responses for requests associated with an original HTTP
response stream or an already accepted MCP Task. It preserves the installed 2025-11-25 protocol and
original shared MCP authority, connection, configuration and credential owners. A known related Task
has priority even when its message arrives on another ordinary request's HTTP stream. Unknown Task
identity cannot fall back to that stream. Ordinary unassociated stdio requests cannot yet be routed
safely; they receive an explicit unavailable-association response rather than a guessed Thread.

Sampling and dedicated `-32042` error-source interaction cards remain subsequent capabilities. An
ordinary RPC error retains its original protocol body and is never automatically replayed. The final
runtime/default/Pi and user-asset migration remains the maintainer's post-acceptance work.

## Common owners and user-facing path

The original Catalog stores short interaction records linked to real Operations. Immutable requests,
normalized presentation and reviewed responses use ContentStore/publication and existing GC. These
records are neither additional execution Operations nor synthetic `ask_user` calls or Run Waits.
Answering does not create User history, invoke a model, grant a tool permission, or resume an old Run.
An accepted Thread Task can continue asking on its original owner after its calling Run has finished.

Generated schema contracts feed `ThreadsAPI`, the authenticated list/read/respond routes, the original
ThreadAdapter and AgentRuntimeClient, and the shared UI. The presentation is separately paged instead
of expanding every Thread snapshot with all historical request bodies. UI drafts belong to the actual
interaction identity. Server messages and schema labels remain plain remote content.

The original authority's installed receiver determines client-level capability negotiation before
initialize. Connection order must not change capability: Pi-first preparation and later Native work
share the same connection. A Pi-only authority without a receiver does not advertise the feature;
a shared Pi request without a real Native invocation association does not borrow another Thread.

## Distinct facts

- A persisted user choice does not establish response transmission.
- Sending begins at the original short admission fence; the original SDK sends one response only.
- Transport completion is evidence about this response, not external business completion or a Task's
  physical stop. Uncertainty does not authorize a second response or a replay of the original tool.
- URL consent, an explicit external navigation attempt, and a matching server completion notification
  remain distinct. No URL, favicon or metadata is prefetched, and no embedded page is inspected.
- The end of an ordinary RPC closes its response eligibility. It does not retroactively erase an
  already recorded choice or turn a received external completion into a new tool result.
- Reopening cannot revive a lost inbound JSON-RPC request on a new client. Its recorded history stays
  readable; a new request needs its own reviewed response.

## Concrete findings and corrected paths

Independent original-wire probes found that an SSE stream ending without a final response synthesized
an SDK JSON-RPC error which looked like a real received response. The original transport now carries
private failure provenance through its existing client callback. Stream EOF remains Unknown, while a
real matching RPC error preserves its full body and ends that finite RPC. Neither case replays the
tool. Native ordinary tool calls now use the same original one-shot connection path as services;
an actual HTTP session-expiry response is checked for exactly one call, without hidden initialize.

The real public client/Host/Rust chain exposed a Catalog list query using a nonexistent Run column.
It now joins the original persisted branch owner. The same original chain passes through actual
identity checks, request body storage, answer validation and protocol response transmission.

Two consumer failures were independently reproduced and fixed: an accepted URL became inoperable
when its original finite RPC ended, and a slow manual refresh could overwrite newer external-complete
facts. The original external opener remains explicit and available for an accepted URL; it never
claims a popup opened or a page completed without evidence. The shared panel/read merge keeps the
newer revision for the same interaction. Browser form validation no longer imposes HTML nonempty or
full-match pattern semantics over the saved JSON Schema owner.

A second original-wire ordering exposed premature removal of the original RPC's abort listener:
response POST completed before the invoking RPC, and the retained URL watcher missed `rpc_closed`.
The watcher now retains that listener until its own lifetime ends. Later client loss, source/Goal
termination and reopen close only the still-retained URL-completion association; prior choice,
delivery and already observed completion are unchanged. Completed or declined interactions are not
reopened. Both original failing wire probes pass unchanged after their minimal fixes.

Other finite owner checks preserve original protocol error bodies on subscribe/explicit unsubscribe,
prevent a second SDK response after send failure, retain finite numeric IDs such as `1.5`, and retry
only known local settlement facts after a lost Catalog acknowledgement. A dropped UI connection
cannot retract a choice already admitted by the original owner. Fixture-only ESM resolution and
preparation ordering corrections are not counted as product defects.

## Reproduce the original composition

Build the normal protocol, application-client, extension and Pi Host dependencies before these tests.
The narrow ignored tests use the real Rust Engine, RunTools, Catalog, ContentStore, supervisor,
ToolBridge, PermissionService, shared MCP authority and installed client. The public response path is
actual application-client → authenticated registered route → ThreadAdapter → AgentRuntimeClient →
original Rust commands. Peer work and model output are controlled. HTTP uses the installed transport
with in-memory fetch; Task stdio uses an actual process. No listener or product socket is opened.

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::mcp_interaction_review -- --ignored --nocapture --test-threads=1
```

- HTTP ModelStep form/URL and real PolicyAction graph: typed user answers reach the original receiver,
  next requests retain original effects/results, a late URL notification is separate, duplicate user
  submission sends no second answer, and GC/reopen preserves request/response bodies.
- Accepted stdio Tasks: the original calling Run and tool registration finish before user interaction;
  the Task still receives its answer and result. Cancelling the exact other Task rejects its late
  answer without changing the original immutable JobAccepted or resuming the old Run.
- Source-less child and actually installed brokered SDK `tools.invoke`: both show and answer on the
  real child Thread/branch and distinct original Operations, preserve model/nested origins and
  provider pairing, and return the actual receiver's result through their original callers.

The independent review also exercises mixed HTTP streams with a real accepted Task, unknown Task
rejection, ordinary unassociated stdio, one attempted response on send failure, and local known-sent
acknowledgement loss. Its private Catalog port is controlled in fault-injection probes; this is
explicitly distinct from the Rust composition above. Consumer UI and authenticated route tests use
controlled lower ports and do not substitute for remote delivery evidence.

All eleven original MCP composition tests pass on the final production source: the three new
interaction chains plus the original content, four resource and three Task chains. The affected Goal
and HostJob suites pass 22 cases, and the persisted Catalog list test passes. Independent review
passes eight JS/UI/wire probes and seven original Catalog scenarios, including Goal pause at open
and send, source retirement, old answers after reopen, unknown sending recovery and retained URL
completion owners. These are separate evidence classes, not additive completion metrics.

Original SDK service/Task/resource/HTTP regressions pass 15 cases; the new interaction owner cases
pass four. Host interaction/Task/resource/permission/child/public-consumer tests pass 43 cases. Shared
UI behavior passes 87 cases. Production/test Host, complete Pi Host and UI type checks, changed-source
lint and generated wire checks pass. The normal Host bundle includes 554 reachable production
modules and excludes 116 legacy/test artifacts. CLI and Web assets build; existing Vite/CSS/chunk
warnings remain outside this slice. Ordinary cloud-runtime staging and lock refresh verify the production layout, without starting
product IPC. Both lock graphs are semantically unchanged; formatting-only regeneration is omitted.

The freshly built Linux x64 ELF is staged with build identity `0.9.25` and wire **7**, SHA-256
`525cb018b61c6abd5cf14f5edbe2a9adc7c3775151d861cceabf8bd28b7fadb4`.
Catalog **52**, input **7**, content **4**, manifest **2** and policy **4** remain explicit separate
format boundaries. Fourteen existing kernel warnings are retained, with no unrelated cleanup.

The source freeze covers 5,009 non-documentation kernel/package/script/example and root build inputs,
SHA-256 `9458bc357b3bca3ab94f720fec4d7bcb9611505d31f6711e74c21a960de36f00`.

## Product acceptance entry

On an Agent-runtime Thread with an explicitly configured eligible MCP server, invoke its selected
tool through the ordinary permission path. Form or URL requests appear in the conversation's
“MCP server requests” section. Review the server and original request, edit values and choose
Accept/Decline/Cancel request. For URL mode, opening the displayed website is a separate explicit
action; recorded consent and server-reported completion are shown separately. An accepted independent
Task can still show a request after its calling Run finishes. The normal original Operation/Task
Stop path withdraws its response eligibility; closing or refreshing the panel only ends its reader.

The automated entry above supplies deterministic peers and needs no external server, account or
browser. Real external-service/browser and complete product-platform acceptance remain the next
reader's separate checks.

## Remaining verification and implementation boundary

No complete product socket IPC, real external MCP account/service, browser navigation, paid model,
desktop or cross-platform/performance acceptance is claimed. The maintainer's earlier Windows result
remains scoped to its original cases and commit. General sampling, dedicated error-source URL cards,
remaining environment/Web/material/PDF/academic/Bot, source/retrieval and context/provider capabilities
still need implementation or acceptance. This finite slice does not complete either overall design.
The user retains final default-runtime switching, Pi removal and asset migration after acceptance.

## Fixed protocol references

The implemented modes and explicit user actions follow the
[2025-11-25 elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).
Task correlation follows the original
[Tasks specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks),
and HTTP source association uses the actual
[transport response stream](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
Newer protocol-era proposals are not treated as fields available in this pinned client.
