# Typed output media and original consumers

Date: 2026-10-11. Baseline: `110175e24f22f96809c51899cb049701e43f8463`.
Status: finite slice accepted after original-owner integration and independent review.

## Finite contract

Original Computer screenshots and explicit managed-script images use one `OutputBody<M>`:
opaque `data` and ordered `parts` containing text or media. Ordinary JSON, including objects that
look like media descriptors, stays ordinary data. `IncomingMedia` accepts MIME and inline bytes;
the receiving owner stamps the actual invocation/input/policy source. `StoredMedia` retains that
source and an immutable ContentStore reference. Workers resolve bytes only for an actual reader or
selected provider. There is no free-hash media capability or second image database.

Computer projects its same original observation/action snapshot. Desktop, app, window, observation,
capture and screenshot geometry remain in `data`; the known screenshot field points to its exact
media part. This is an explicit producer projection, not recursive JSON field guessing. Managed
Node exposes `emitImage({media_type, data_base64})` in the current cell scope. Printing a JSON object
or data URL stays text. An inner tool's image reaches its original caller; the script must explicitly
emit it for the outer result. Previously emitted parts survive an outer exception. Nested calls do
not manufacture model calls or tool-result pairs; original committed memory facts remain independent.

Ordinary SDK Result tools use awaited `call.output(part)` through their original invocation scope.
Accepted Jobs already have a canonical domain receipt and cannot append output through that API.
Their owning accept/terminal API takes the same typed body. Policy `Deliver`, `ReadResult`, planning
evidence and examples consume the new body explicitly. `Operation.result` distinguishes Control from
Output rather than guessing from JSON keys.

## Persistence and reads

Media bytes and their containing bodies are staged durably outside Catalog before publishing the
original owner references. ContentStore manifest dependencies are supplied by typed writers; GC
never treats an arbitrary JSON `content_ref` field as authority. Existing publication, original
history/fork/request/context/Operation/event roots, cancellation and epoch checks remain in use.
Semantic RequestSnapshot views retain references. The separately retained exact serialized provider
wire can contain encoded images because it is evidence of the actual request, not another media owner.

The original authenticated Thread client/route/adapter calls `runtime.output.media.read`. A request
selects an existing history item, queued input revision, Operation completion/result/external receipt,
original event cursor, policy evidence, anchored family item or child report. The expected content
hash is only an equality check against that original holder. Bytes use the existing body worker and
chunk protocol. Closing an observation cancels its reader, not the tool, Run or physical producer.

Queued text edits preserve the original admitted images unless an explicit replacement or empty
array is supplied. UI history and queued inputs read their original descriptors. Family history
returns stored descriptors and `read_thread` has an explicit original-anchor media selection.
Child reports retain their exact operation/execution/history identity and distinguish text pages
from typed-output JSON pages. Both original and later reports render through the shared consumer;
parent-thread forks retain the same report access as the original public report API.

Catalog **48**, runtime content **4**, manifest **2**, Kernel wire **3**, policy service **4**, private
script-worker **2**, `read_thread` **2** and `child_report` **3** replace their old internal contracts
directly. External workspace/Pi/configuration assets are not migrated.

## Actual model compilation

The original result batch and call IDs remain authoritative. Responses (including its Azure/Codex
profiles), Anthropic and Bedrock use supported image blocks in original tool results. Chat/Mistral
and the Google/Vertex fallback complete the original result batch before source-labelled image
turns. Mistral's call-ID and image-URL profile rules remain explicit. Pi messages use their original
image blocks. A model without images or an adapter-unsupported MIME fails explicitly rather than
silently omitting media. Provider opaque/signature data retains its original connection/family scope.
Serializer probes establish actual local request shapes, not remote model acceptance or image quality.

## Integration findings and verification

The earlier first kernel run did not pass: content initialization wrote
version 4 while reopen inspection still expected 3, and the old child report selector ignored typed
Deliver output. Both production seams were corrected rather than hiding those failures in fixtures.
The current shared format constant owns initialization/inspection; typed child output is selected and
read through its original report owner.

The managed-Node integration exposed a prior fixture omission: the hand-driven Host returned
completion without publishing the original receipt sent by the real AgentToolBridge. Restoring that
boundary exposed managed-environment Job acceptance being checked by the HostJob-only reader. The
shared capture now uses the actual domain: managed-process acceptance from its original completion,
HostJob acceptance from its immutable acceptance reference. A HostJob's late acceptance can differ
from the original Unknown model exchange; neither that exchange nor the acceptance is overwritten.
The exact accepted Job body still matches after the environment closes; repeated receipts are inert.

The same real chain then rejected a legitimate Computer observation's no-effect evidence: computed
body identity serialized a typed struct in field order, while the writer serialized a JSON Value in
canonical key order. The identity function now uses the writer's same representation. The original
confirmation check remains strict; independently changing ordinary data still fails confirmation.

Independent review reproduced an ordinary SDK accepting malformed image encoding after a confirmed
domain effect. Rust response handling then replaced the whole result with Unknown, while late-receipt
handling rejected it. SDK output now validates canonical bytes before registration. For an already
executed Result, the shared Rust boundary retains data/outcome/effect/executor-stop and valid parts;
an unadmitted malformed media part becomes an explicit diagnostic at the same position, without
its bytes. Both response and late receipt use this same conversion. Valid but model/adapter-unsupported
media still fails serialization explicitly. Canonical accepted Jobs are never repaired after admission.

The controlled driver originally omitted its post-action snapshot, and the new reopen assertion
originally retained a fixture-owned RunTools/Catalog handle. Correcting these fixture omissions did
not relax product screenshot, ownership or recovery rules. They are not listed as product defects.

Current verified evidence:

- Final runtime execution across **37 targets: 461 passed, 0 failed, 2 ignored and 9 explicitly
  excluded socket cases**. This includes original queued input, recovery, memory delivery, policy
  switching, no-effect identity and HostJob late acceptance with its unchanged first exchange.
- Final kernel library **148 passed, 18 ignored, 3 socket-listener cases explicitly excluded**.
  The original managed Node **6**, child guardian **1** and process/follow-up **2** cases separately
  pass on the same freshly built guardian. The new image case runs the default policy through its
  actual no-effect checks and next provider request, then checks family/fork/GC/reopen.
- Independent runtime probes use actual Catalog/ToolBatch, nine provider profiles, source-bound
  reads, fork, publication-pinned GC, original context-job compilation/publication and reopen.
  The repaired no-effect probe confirms an identical body and rejects changed data. Five focused
  probes pass; these are controlled requests, not live model calls.
- SDK/contract **120** tests pass, including actual installed SDK/broker malformed-output handling.
  Original installed policy consumers **42**, shared script evaluator/compiled stdio **18**, and
  the separately scoped Computer/invocation/tool-bridge consumers pass their bounded suites.
- Public application-client/registered Host route/adapter **3**, client reader/report **5**, and
  the final shared report/media/conversation UI **91** tests pass. The original family projection
  tests also pass. An independent cross-language probe feeds real post-reopen Rust chunks into the
  actual client reader. HTTP/DOM/physical drivers are controlled at their stated seams.
- Protocol generation, Host source/test and client/UI types, focused changed-source lint and actual
  production Host build pass. The Host bundle has **546 reachable modules**, excluding **80**
  legacy/test artifacts. Native socket test fixtures are migrated and type-checked, not executed.
- The Linux x64 debug ELF is staged by the normal build script with identity **0.9.25**, wire **3**,
  SHA-256 `9e6e650770d290b1c4108a2290806fa2fde076ce41955c83cd3c2691a6650a73`.
  The frozen source-input manifest covers **4,964** non-documentation kernel/package/script/example
  and root build inputs, SHA-256
  `211eb2e0262fbbc5219ad94f62576997c0675adf867308dd5d7a126767bd3e8c`.
  It is rechecked before publication. The build retains the same 14 existing kernel warnings.

Independent review accepts this finite slice with no remaining confirmed production blocker.

An earlier overly broad provider-test invocation also executed old listener cases. It is excluded
from this phase's allowed acceptance evidence; later selections explicitly exclude those entries.
No socket capability, live provider support or full product IPC is inferred from that invocation.

## Evidence boundaries and reproduction

The representative driver is `kernel/crates/varin-kernel/src/managed_script_review.rs`, using the
actual Engine, RunTools, Catalog, original guardian/process/ScriptRuntime/Node and ComputerService.
Only model generation, installed binding/permission responses, test transport and physical driver
are controlled. It captures the actual next Responses serialization, direct plus explicit nested
images, failed outer output and independent memory fact, then original media reads after fork, GC
and reopen. It is not full product socket IPC or a real desktop test.

Additional original-child memory/plan coverage exercises typed Deliver/report, parent-fork media
access, read cancellation, GC and reopen from both actual tool origins. The public client test
`packages/web/application-host/lib/kernel/thread-media.test.ts` traverses registered authenticated
routes and the real adapter/client, with only final private RPC controlled. Provider, runtime,
installed-policy/extension, shared Node/Pi and UI tests cover their own distinct boundaries.

For the actual Node driver, build the current kernel guardian and shared script/builtin packages,
then set `VARIN_TEST_KERNEL_EXECUTABLE` to that same built executable and run the named ignored
`actual_node_and_computer_media_reach_original_provider_results_after_outer_failure` kernel test
with `--test-threads=1`. Do not count a stale binary or a missing-environment failure as execution.
The ordinary Rust and package commands remain in their owning README/package scripts.

Full Host socket IPC, real desktops, packaged platforms, external providers, remote machines and
performance remain external acceptance work. MCP image/audio/resource projection, Web/material/PDF
producers, richer Computer bindings and the other two-design capabilities are still separate work.
Current research Job producers have no media parts. Their accept/terminal API still strictly rejects
malformed incoming media; a future Job media producer must close its execution-to-receipt error path
before claiming support. The shared Pi custom install keeps its own evaluator surface. Default runtime switching, Pi removal
and full asset migration remain the user's final acceptance/migration step.
