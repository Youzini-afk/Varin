# Original MCP error-source URL interactions

Date: 2026-10-11 (UTC). Baseline: `023f0b8ad29ccf5fcede1dbede3008c146dee505`.
Status: finite implementation and independent behavior review accepted. Product/platform acceptance remains separate below.

## Finite scope and owners

The installed 2025-11-25 protocol can return `-32042` with URL requirements in an actual response to
an outgoing RPC. This slice attaches those requirements to that original RPC's Operation, executor,
method, request ID, actual client and endpoint. Unlike unassociated inbound stdio requests, a stdio
response already has an exact originating request. No inferred current Thread is needed.

The existing MCP authority/client/configuration/credential, Catalog and ContentStore remain the
owners. No additional execution, question, Wait, task journal or retry controller is introduced.
The common response hook covers ordinary tools, resource/prompt services, subscribe and explicit
unsubscribe, task creation, and get/result/cancel for an accepted Task. A shared subscription's prior
ACK and background cleanup cannot impersonate another user's new remote RPC.

The complete received error remains in the original receipt or Task observation/result, including
unknown fields. A real finite error response ends that RPC, while its effects may stay Unknown.
An error during task creation cannot fabricate an accepted task ID. An error while observing or
cancelling an accepted Task does not itself establish the Task's terminal state or physical stop.

## Stored evidence and public consumption

`McpInteractionBinding.source` explicitly distinguishes an inbound `server_request` from `rpc_error`.
An error-source record has `delivery: null`, because there is no incoming JSON-RPC request to answer.
Each error stages one shared immutable object containing the complete error and normalized URL
presentations. Its short selector records publish atomically. Paging loads that shared body once
outside Catalog and returns `McpInteractionItem` without copying the full error for each URL.
Exact read/respond returns `McpInteractionView` with the original `request` evidence.

The actual application client, authenticated Thread routes, ThreadAdapter, AgentRuntimeClient and
conversation panel consume this contract. The panel exposes the exact URL and website host and uses
the existing explicit external opener. No prefetch, embedded inspection or automatic navigation is
performed. Original JSON is read only on explicit expansion and displayed as untrusted data.

Accept, decline and cancel on an error card are local review choices. They send no MCP answer,
replay no tool, create no user-history input and resume no Run. Natural Run failure is not a reason
to disable the card: that failure may be why the user needs to review it. Historical local review
also remains possible after source/Goal cancellation or reopen, under the original public read
identity checks. Such review cannot revive the old automatic completion association or an Agent grant.

Local choice, a browser opening attempt, a matching external-completion notification, and the original
execution result remain distinct. Completion does not change the old error or promise that a new
attempt is safe. Any later ordinary user input follows the existing fresh execution and permission path.

## Task result boundary

The fixed Tasks protocol requires nonterminal `tasks/result` to block. A premature `-32042` while
the known Task is nonterminal is therefore an observation/protocol anomaly, not a successful standard
input flow. Its original error is retained, but cannot be cached and later promoted into a different
terminal result. Repeated observation of an unchanged input requirement does not manufacture an
unbounded sequence of identical cards. A matching completion, actual Task status change or explicit
existing Task read can continue observing the same accepted ID without recreating the task.

Conversely, a fresh `tasks/result` for a known terminal Task can legitimately return the underlying
JSON-RPC error, including `-32042`. That remains its original terminal error result, separately from
the URL cards and immutable JobAccepted/model receipt. No error card revives the Task.

Protocol references: [URL elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
and [Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks).

## Confirmed findings

The original native publication probe exposed a late-completion fence gap. Source retirement,
Operation cancellation or reopening had already closed a card, but a delayed command from the old
Host callback could still mark it externally complete. Goal pause could do the same before the
next pending sweep changed the card's availability. Completion now checks the same original
owner/epoch/Goal/source/cancel facts at its short Catalog commit boundary. A fenced late fact is an
idempotent no-op, not an endlessly retried publication failure. Already recorded completion remains;
natural finite Run failure and valid accepted-URL completion after ordinary RPC close are preserved.
The independent unchanged native failure cases pass after this owner fix.

A separate ordinary-wire probe demonstrated that deleting a conflicting active elicitation ID was
insufficient: a third RPC could reuse it and receive the old ambiguous completion. Only IDs actually
shown to be ambiguous stay withdrawn in that original client's completion map until the client ends.
No completion is guessed or broadcast, and both original error bodies remain readable.

The original full Rust/Host/SDK chain also exposed a natural-Task-retirement boundary. An accepted
URL had already sent its response, but normal Task result settlement unbound it as owner loss and
withdrew a still-valid external-completion identity. Natural completed/failed Task retirement now
closes sending with `rpc_closed`, retaining that accepted URL's original client watcher. Cancellation,
source/Goal withdrawal and owner loss still close it. Catalog separates send liveness from original
completion ownership; a terminal Task cannot receive a new answer or be revived by completion.

A proposed Task refresh change was not accepted merely because an explicit get joined an existing
in-flight get. That path returns the actual status/error projection and does not promise a second
remote request. A narrower real failure was confirmed: the error diagnostic had already committed
and become visible, but its delayed Host acknowledgement swallowed a subsequent explicit recheck.
Only when this command's authorized Catalog read already sees that `-32042` status/result diagnostic
does it retain a new recheck intent, join the old local settlement and use the existing Task owner to
perform the next get. Ordinary joining remains unchanged; original errors stay in their observation
history and tools/call is never replayed.

## Verification evidence

The lead's actual Rust → Host → installed SDK → public application consumer composition covers
ordinary HTTP and stdio errors, task-creation errors, premature nonterminal Task errors followed by a
fresh successful result, and genuine terminal Task errors. The controlled peer supplies multi-URL
errors, large Unicode and unknown error fields, and completion immediately after the error response.
Assertions check local choices after Run termination, no JSON-RPC answer, no repeated tools/call,
original receipt preservation, compact lists, GC and reopening. Existing server-request, PolicyAction,
source-less child and installed nested-SDK interaction chains remain regression consumers.

The consumer-only evidence uses the actual application client, authentication route, Adapter,
AgentRuntimeClient and original Host interaction owner over a controlled native request port.
That is distinct from the Rust composition, and component tests are not substituted for either.
Final source-selected checks passed:

- Fourteen actual Rust → Host → installed MCP → public-consumer chains, including the original
  accepted-Task URL retirement failure, five error-source cases, and the previous resource, Task,
  server-request, policy, source-less-child and installed nested-call consumers. MCP stdio uses a
  real subprocess; HTTP uses the installed transport with controlled in-memory fetch.
- Twenty-two affected Goal/HostJob lifecycle tests and compilation of all runtime test targets.
  The final native composition compiles the final runtime library; no broad socket suite was run.
- Sixteen installed MCP SDK lifecycle/interaction/resource/Task tests; twenty-one Host Task and
  interaction-owner tests; ten public client/authenticated-route/Adapter/runtime-owner tests;
  ninety-one shared interaction/conversation UI behavior tests.
- Independent review's unchanged failure probes: nine native owner-fence scenarios plus two
  accepted Task URL natural-termination positives, eight original HTTP/stdio wire probes, and
  five public/observation-coordination probes. These are separate evidence classes, not an
  aggregate system coverage percentage. All four confirmed findings above were repaired and
  rechecked; the broader ordinary-in-flight-join hypothesis was rejected.
- Pi production build and full source/test types; Host production and test types; UI types;
  changed-file lint; generated wire checks; maintained SDK patch reverse/forward round trip;
  fresh Host production bundle and Web Vite/PWA build. Existing warnings were reviewed without
  broad unrelated cleanup.

The non-documentation source-input manifest contains 5,009 files, with SHA-256
`f23e05ba754ba230d13deae299ed1b6654e978a9cce911268e75dd5da55ad026`.
The final library, composition and packaged builds are checked against this same frozen input set.
Build outputs are not silently reused across a changed source generation.

The freshly built Linux x64 kernel is staged with build identity `0.9.25`, wire **8**, manifest
schema **3**, and binary SHA-256
`1f76484de64f55fab08801f5bd01e5e6738da49be7c6d0fdec9164e927a0225f`.
The Host production bundle reaches 554 modules and excludes 116 legacy/test modules. Fresh CLI,
Web UI/PWA and the cloud production layout validate together. Both development and cloud lockfile
refreshes preserve their semantic dependency graphs; formatting-only lock churn is not committed.
Generated protocol, documentation links and diff whitespace checks pass. These build/layout checks
neither launch product IPC nor establish real external model, browser or deployment behavior.

## Reproduction entry points

Use the repository-pinned Rust/Bun versions, Node with its `--import tsx` loader, prepared workspace
dependencies and the normal owning package build/type scripts. The finite original-owner chain needs
no product socket or network listener:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib mcp_ -- --ignored --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test goal_lifecycle --test host_job_review -- --test-threads=2
node --import tsx --test packages/pi-host/test/native-mcp-http-lifecycle.test.ts packages/pi-host/test/native-mcp-interactions.test.ts packages/pi-host/test/native-mcp-resources.test.ts packages/pi-host/test/native-mcp-tasks.test.ts
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts packages/web/application-host/lib/kernel/mcp-interaction-runtime.test.ts packages/web/application-host/lib/kernel/mcp-task-runtime.test.ts packages/web/application-host/lib/kernel/thread-mcp-interactions.test.ts
(cd packages/ui && node ../../node_modules/vitest/vitest.mjs run src/components/thread/ThreadMcpInteraction.behavior.test.tsx src/components/thread/ThreadConversation.behavior.test.tsx)
```

## Formats and remaining scope

Catalog **53** and Kernel wire **8** directly reject obsolete internal formats. Input **7**, content
**4**, manifest **2** and policy **4** are unchanged. No external workspace, Pi or user assets migrate.

Sampling, broader MCP interaction association and the remaining environment/Web/material/PDF/academic/
Bot, source/retrieval/context/provider capabilities continue under the two full designs. Full product
socket IPC, actual desktop/browser, external account/provider, platform and performance acceptance
remain separately unverified here. Tests use actual subprocess stdio or the installed HTTP transport
with in-memory fetch, without a listener. The user's final default-runtime/Pi/asset migration remains
post-acceptance work.
