# Original-owner MCP resource observation

Date: 2026-10-11. Baseline: `4d9ba24850b365d2870d7e3d76fc032b51ec95a5`.
Status: finite slice accepted after original-owner integration and independent review.

## Finite contract and original owners

The schema declares `mcp_subscribe_resource(server, schemaVersion, uri)` and
`mcp_unsubscribe_resource(operationId)`. The original McpAuthority, installed client, configuration,
credentials and grants own real MCP traffic. The subscribe RPC is finite Result/Thread work; its
original Catalog Operation retains one typed observer facet after the RPC settles. Original RPC
outcome, effect, receipt and call completion are not overwritten by later observer state. This adds
neither a Task/HostJob nor a second durable store, tool list, transport or credential owner.

Model, policy, nested SDK and source-less child calls use the original frozen declarations and
PermissionService. Explicit management retains the same permission gate. Background updates do not
open permission dialogs, fetch resources, interpret instructions or activate a Run. They become
passive Environment facts in the original input queue and ContentStore, delivered only at an existing
authorized closed boundary. Idle work stays idle; a later authorized request can consume the facts.

The actual client plus exact URI owns shared holder membership across Threads. Removing one holder
does not unsubscribe another. Only the last holder requests remote unsubscribe. Local listener release,
shared ownership, actual remote acknowledgement and unknown cleanup are distinct. An unsubscribe ACK
is not proof that remote business work stopped. Explicit unsubscribe preserves the original full ACK,
including metadata, in its own output; shared release does not invent an ACK.

Catalog **51**, input domain **7** and kernel wire **6** replace prior internal formats directly.
Content **4**, manifest **2** and policy **4** remain unchanged. The common `McpEndpoint` and original
owner reacquisition module replace Task-specific naming; no compatibility reader or fallback is added.
The [owning MCP document](../../packages/web/application-host/lib/kernel/MCP.md) records the interfaces.

## Notification, cancellation, source and recovery

The callback retains original-client identity before subscribe acknowledgement. Only durable original
acceptance admits notifications. Each locally accepted fact has one identity; an interrupted local
reply retries that same immutable fact. Only never-sent pending invalidations coalesce. A live Host
may reconcile an ACK it actually received, but cannot replay unknown remote creation or overwrite a
previous Unknown call/history. Host loss before acceptance remains an explicit uncertainty.

The protocol permits a notified URI to name a sub-resource without providing a universal ancestry
algorithm or subscription ID. Exact URI holders receive complete original params. Other holders on
the same authorized client receive only an unresolved-association fact about their own subscription,
even if another holder matched exactly. No unmatched URI, metadata or body is broadcast, no prefix
relationship is guessed, and this uncertainty is not represented as a connection failure. An explicit
resource read remains a separate authorized operation.

Ordinary Run completion does not end a global Thread observer. Tree Stop and Goal completion/cancel
include observers on terminal Runs. Workspace observers are additionally bounded by their original
source: Catalog fences admission, the actual listener detaches, and short local release metadata is
confirmed before existing source unpin/grant retirement. Slow notification body storage and remote
cleanup do not hold that boundary. A staged late fact must fail its original publication fence;
already accepted facts remain durable and idempotently readable.

Recovery preserves the original endpoint, configuration, credential, scope and source binding. A
known accepted observer records a durable gap before a new local listener interval. It does not claim
remote replay or uninterrupted delivery. Changed/revoked owners remain unavailable; recovery cannot
borrow a successor's source or current account. Ordinary configuration replacement can retire an old
connection for new admissions while preserving its still-authorized accepted holders.

Public history projection follows actual model request/call or policy action/node lineage and the
real Operation facet, including closed observers. Forked history does not grant control over the
original branch. Optional lookup returns null only for an absent Operation; storage and body errors
remain errors. Shared UI distinguishes observer state, local release and remote cleanup, using the
original authenticated operation control route.

## Concrete integration repairs

1. A real pre-ACK update reached the input queue, but the next model failed context compilation:
   its stored ConversationItem ID was the local fact UUID instead of the canonical input/history ID.
   Body and history now use the same original `mcp-resource:operation:fact` identity. The head/CAS
   invariant was preserved, and the original Engine-to-stdio chain now reaches the next request.
2. Independent real stdio reproduction found ordinary configuration replacement silently dropped
   old accepted-holder updates while still showing active. Original holders now retain delivery
   under the same grant checks; explicit revoke and account replacement still fence them.
3. A new same-URI holder waited for prior cleanup after its initial authorization check. Revocation
   during that wait still admitted a subscribe. The original authority now rechecks policy, service
   and credentials at actual holder/RPC entry; the unchanged stdio probe rejects the new admission.
4. An operation already marked ToolDispatched could reach first observer creation after its Goal
   ended, because no facet existed when Goal cleanup scanned. A narrower ended-only check also failed
   when the user explicitly started a replacement Goal on the same Run. First creation now reuses
   the existing frozen-origin `goals::tool_allowed` authority; accepted-facet replay remains separate.
5. Rejection by the local begin command precedes all remote observation, so it must not produce an
   Unknown remote effect. That precise pre-observe window now reports NotDispatched with its original
   diagnostic and local executor stopped. Uncertain publication after actual observation stays distinct.

6. Two consecutive local acceptance-publication failures left a real known ACK waiting indefinitely
   for an unrelated event even after storage recovered. The existing single live publication lane now
   retries the same ACK before notifications; cancelling observation does not discard an already
   received RPC fact. The unchanged silent-peer probe confirms automatic local recovery and one remote
   subscribe. Only Host disposal ends that live reconciliation; no new durable retry owner is added.
7. The same post-ACK local failure returned Unknown with executor-stopped false. Independent original
   Host/stdio and Catalog reopening reproduced a retained server dispatch occupancy despite the actual
   finite RPC having returned. A stopped-true control releases it without changing Unknown history or
   acceptance. The precise post-ACK window now returns the original Unknown receipt with actual
   finite-RPC stop evidence. The complete original-owner recovery and next-call chain passes.

8. An acceptance response delayed behind source withdrawal could overwrite a newer in-memory
   snapshot and downgrade acknowledged cleanup to unknown. The original coordinator now adopts
   pending snapshots through one revision-aware helper and keeps confirmed withdrawal monotonic.
   The unchanged real-stdio/controlled-response probe preserves the ACK without reviving observation;
   no new persistent revision or cleanup authority was added.

Additional lead review preserved raw unsubscribe metadata, immutable in-flight local publication,
pre-ACK facts, explicit source-storage errors, and closed observer visibility. Test harness corrections
are separate: real policy output uses PolicyToolData/Output, passive input receipt has no invented key,
GC during a publication lease is Deferred, and fixture cancellation dispatches the original control
route rather than expecting it to return an Operation. These are not counted as production bugs. The full Pi Host test type-check also caught a
pre-existing Task transport fixture cast; it now uses the actual onMessage parameter type. The earlier
Task record is corrected to distinguish its production build from this full test-type check.

## Reproduce the original composition

After normal protocol and Pi Host builds, these narrow ignored tests use the original Rust Engine,
RunTools, Catalog, ContentStore and supervisor; original Host ToolBridge and PermissionService;
production resource coordinator/recovery; and the installed MCP client with a deterministic stdio peer.
They do not start product sockets or use a paid model.

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::mcp_resource_review -- --ignored --nocapture --test-threads=1
```

- Model lifecycle: cross-Thread shared URI, finite RPC and normal Run retirement; pre-ACK and passive
  idle updates; exact payload and nonexact diagnostics; original next model; last-holder cleanup
  rejection; GC and Catalog/Host reopen gap; explicit unsubscribe and staged-late cancellation.
- Policy lifecycle: real policy origin, original passive delivery into a later authorized request,
  without fabricated provider tool pairs.
- Interrupted local acceptance: actual subscribe ACK, failed local publication, original Unknown
  boundary, same-ID background recovery and a later explicitly authorized same-server call.
- Child/nested lifecycle: real source-less child admission and its own selected MCP composition,
  actually installed brokered SDK nested invocation, original origins and next child request, tree Stop.

The shared stdio and child fixtures are also used by the original MCP Task tests; fixture extraction
must preserve those original Task chains. Independent tests separately cover real authority/stdio
lifecycle, original Catalog Goal/source boundaries, and Host local-publication fault injection with
a controlled Kernel port. Controlled acknowledgement or publication ports are not represented as
full Rust IPC or physical remote stop evidence.

The four original resource chains pass, and the three original Task chains pass after shared-fixture
extraction. All runtime test targets compile. Forty affected Goal, passive-input, HostJob, child and
composition cases pass; the twelve Goal cases were rerun after the final frozen-origin gate change.
These regression counts do not replace the original cross-language consumption evidence.

Installed-client resource/service/Task tests pass eleven cases. Five independent real stdio lifecycle
probes pass, together with original Catalog Goal/source/GC probes. Five final Host publication-fault
probes pass; their Kernel publication port is controlled and their MCP client/stdio owner is real.
Original Host coordinator, permission, child preparation and public consumer tests pass 34 cases.
The public consumer subset includes actual application-client → authenticated registered route →
ThreadAdapter → AgentRuntimeClient requests and real source-release coordination above controlled
lower ports. Shared UI behavior passes 77 cases. Host production/test, Pi Host and UI type checks,
changed-source lint, generated protocol and engineering documentation checks are recorded separately.

The normal Host bundle contains 553 reachable production modules and excludes 104 legacy/test
artifacts. CLI and Web assets build. Ordinary cloud-runtime staging and lock refresh verify the
production layout; both lock graphs are semantically unchanged and formatting-only regeneration is
not retained. This staging does not establish installed-product smoke or deployment. Existing Web
build warnings about a Vite option, CSS highlight and chunk sizes are not hidden or turned into
unrelated cleanup.

The freshly built Linux x64 ELF is staged with build identity 0.9.25 and wire 6, SHA-256
`a080c0c8b5bcb284470c3b4279c260f71e968abada6f31d0f27642fa64a699f2`.
The source freeze covers 4,996 non-documentation kernel/package/script/example and root build inputs,
SHA-256 `0e68d608afdf5fbc9a03aa5b64f609c6a49dc478a2d3c4c8e40d4b6479df9ccc`.
The fourteen existing kernel warnings remain; no unrelated warning cleanup is included.

## Remaining boundary

No complete product socket IPC, real desktop, external MCP account/deployment, remote model,
cross-platform package or performance acceptance is claimed. Earlier maintainer Windows evidence
remains scoped to its original commit and cases. General server sampling/elicitation, remaining
environment/Web/material/PDF/academic/Bot, source/retrieval and context/provider capabilities still
need implementation or acceptance. This finite slice does not complete the two overall designs.
The user retains final default runtime switching, Pi removal and asset migration after acceptance.
