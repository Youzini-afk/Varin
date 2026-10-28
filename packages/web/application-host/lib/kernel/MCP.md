# MCP capabilities

Agent MCP configuration, OAuth storage, connections and their tool catalogs are owned by the shared
Application Host [`McpAuthority`](../mcp/DOCUMENTATION.md) in `lib/mcp`. This adapter leases that
owner; it creates no second MCP client, installer or secret store. Native settings, trust and
credential owners serve every product Thread. Historical Pi configuration and accounts are not imported.

## Preparation and frozen identity

`AgentRuntimeClient` accepts a trusted `McpPreparer`. It runs during launch preparation, after
input admission and (where selected) environment materialization. The callback receives the
admitted source identity and canonical execution directory, not a renderer-provided cwd. Configuration
location and execution location remain distinct. A neutral global execution scope does not claim to
represent a workspace snapshot; workspace capabilities must use the admitted execution environment.

Only explicitly selected direct dependencies prepare at launch. Deferred/codemode servers remain
unprepared until `mcp_discover` names one; an unavailable unused server cannot hold ordinary chat.
Configured, cached and connected counts remain separate readiness facts. The owner supplies a retained
immutable configured catalog plus server/environment resource keys. The private
`runtime.launch.mcp.prepare` operation can append that catalog only before launch binding and before any
model step. Exact retries are idempotent; changing a frozen owner or schema fails. The normal launch
selection comparison is unchanged. The credential-free owner identity, generation and tool descriptions
are durable; live clients, OAuth tokens and permission grants are not.

Direct tools remain directly exposed. `mcp_discover` without a server lists configured metadata
without connecting; naming a server performs that dependency's preparation as a durable Operation.
Configured deferred/codemode tools are reached through `mcp_call` with the discovered server, tool and
exact schema version. Scripts use the same selected tools through their ordinary nested invocation;
there is no separate MCP-only script registry. The
concrete target's complete input schema is validated by the retained owner before authorization and
again before transport dispatch. Hidden tools are absent. Remote annotations do not grant permissions
or prove independent/read-only effects.

Discovery returns concise candidates by default. `server` scopes preparation to one dependency;
`tool` reads an exact tool contract directly, `query` ranks known names, descriptions and schema terms,
and `detail: full` requests original contracts. Multiple same-named tools remain candidates until their
server is selected. Offline cached descriptions identify their unprepared state and carry no executable
schema version. Unprepared server contents are explicitly outside the search coverage.

The original request's visible-output budget travels through the private Host call. Discovery pages
whole tool/server/service entries and returns `next` through `mcp_discover`; a cursor binds the original
selection and directory identity. It never mixes versions after a catalog change. A single oversized
contract returns an explicit overview and a `path` reader over its original JSON structure; large scalar
values continue as exact JSON text fragments. Projection never becomes a replacement execution schema.
Search terms are reused for the retained declarations; the lease owns and releases these derived views.

## Execution and permission

Agent scopes read trusted project settings through the native Host settings owner and the common
read-only native project-trust reader. The original configuration cwd, execution cwd and Source owner
are admitted before preparation; callers cannot substitute another directory. Trust changes use the
admitted-workspace settings API and the native `project-trust.json` revision transaction.

A private framed Host/kernel rendezvous supports only MCP authorize, execute and cancellation messages.
It is not a generic Host-service forwarding endpoint. Requests are bound to kernel epoch, Run,
actual ModelStep/policy/nested origin, Operation, tool call and retained owner generation. Rust verifies
that the call's description matches its frozen execution context. The Host rejects changed identities and caches dispatched calls so
repeated frames cannot duplicate remote effects.

The existing shared permission evaluator remains the rule authority. Unknown tools default to ask;
explicit allow/deny rules retain their meaning. Ask opens a separate permission Operation/Wait,
not `ask_user`. Its one-shot decision is bound to the exact arguments, actor, tool/owner and policy
generation. Execution rechecks the current policy and owner before dispatch; drift rejects the call
without opening a new dialog while a resource claim is held.

Remote calls and selected-server preparation create durable Operations. Metadata listing without
server selection sends no remote request. Server/environment keys coordinate dispatch admission; they do not assert remote
transaction isolation or that an ordinary MCP server stopped after a cancellation notification.

## Resources, prompts and explicit output

`kernel/protocol/schema.json` owns the built-in capability declarations. Generated Host descriptions
and frozen `McpBinding.routes` distinguish direct tools, server-argument requests and discovery;
Rust interprets these typed routes instead of maintaining another tool-name list. Child narrowing,
retention, rebinding and restart carry the same routes with the original server resource identities.

Named `mcp_discover` returns the negotiated resources/prompts service versions alongside tools.
`mcp_list_resources` selects resources or templates and preserves the server's opaque page cursor;
`mcp_list_prompts` returns the complete page and concrete prompt versions. `mcp_read_resource`
uses the resources service version; `mcp_get_prompt` uses the selected prompt version and string
arguments. Each remote request uses the same one-action permission and original server claim.
A resource URI is sent only to that MCP server. It need not have appeared in a list, and does not
grant the Host permission to open a local file or fetch a URL.

The original authority uses its negotiated client for these narrow protocol requests. It preserves
the complete page, including `_meta`, instead of substituting a display cache or a successful empty
page on failure. Calls enter the client once; the SDK resource wrapper's read-only HTTP retry is not
used for a native durable operation. Prompt descriptors remain with the original authority, are
invalidated by a replacement client or `prompts/list_changed`, and are checked again before dispatch.
Remote role labels, annotations and descriptions are result data, not instructions or permissions.

`mcp-output.ts` projects only the protocol's `tools.content`, `resources.contents` and
`prompts.messages[*].content` fields into the existing `OutputBody`. Known text/image/audio and
embedded text/blob payload strings become ordered Text/Media parts. Their original payload fields
contain `{outputPartIndex}`; surrounding URI, MIME, role, annotations and metadata remain in `data`.
If a resource has both text and blob, text precedes blob; a missing blob MIME becomes
`application/octet-stream`. The marker is this adapter's documented projection, not a generic
JSON-to-media capability. Policies and nested callers resolve payloads through their exact part
indices; a nested image needs explicit emission to become the outer script's image.
`structuredContent`, unknown fields/types and resource links remain ordinary data; links are not
automatically fetched. Original tool identity supplies media provenance when Rust admits the receipt.

Media uses the same ContentStore/publication, model serialization, scoped readers and GC roots as
other tool results. A selected provider that does not support a media type reports an explicit
serialization failure; protocol media is not silently discarded. Malformed encoded media follows
the shared per-part admission diagnostic without changing the original result's effect evidence.

## Cancellation, results and lifetime

Before transport entry, rejection has a `not_dispatched` receipt. A received successful MCP response
confirms the tool result. A remote `isError` response retains its content and the existing
Indeterminate/Unknown result because it does not prove rollback; a returned response ends that RPC.
Cancellation, disconnect or failure after dispatch reports an unknown effect and is never retried here.
For native tool and service requests, the original connection's one-shot lifecycle detaches an expired HTTP
session without replaying the call or closing another in-flight RPC. A real matching RPC response or the original transport's session-expired error ends that finite
request; effects can remain Unknown. The latter retains the local `mcp-session-expired` reason.
A locally synthesized stream-EOF error is not a received response and cannot provide stop evidence. The default policy still stops at that barrier. A separately chosen new operation can
reconnect through the same owner and must pass current schema, credential and permission checks.
Late owner promises remain observed after cancellation, so rejected late work does not leak unhandled
promises or reopen a completed call. MCP Tasks recovery is a separate negotiated capability, not
inferred from ordinary `tools/call`.

Same-process parked Runs retain their owner lease and frozen schema. Terminal Runs and kernel transport
loss release their Host registrations. Durable configured capability identity is separate from live
connection handles. A restarted Host reacquires the admitted configuration/environment, validates the
same configured generation and direct schemas, and safely prepares a recorded deferred target only
when its expected schema still matches. An unavailable or changed generation is an explicit failure;
a dispatched unknown effect is never replayed by this rebind. A new Run
inherits source selection but prepares a fresh MCP catalog, so old lease identities do not silently
become the successor's capability grants.

## Negotiated durable Tasks

The original authority uses the installed client's task-augmented `tools/call`, `tasks/get`,
`tasks/result` and negotiated `tasks/cancel`. It does not create a second transport, task journal or
credential owner. Server `tasks.requests.tools.call` is checked before interpreting a tool's
`execution.taskSupport`: a required tool on a capable server has Job/Thread semantics, an optional
or forbidden tool remains an ordinary RPC by default, and a server without Tasks retains ordinary
RPC semantics. `mcp_start_task` explicitly selects an optional/required supported tool using the
original server, tool, schema version and arguments; an optional `ttl` is only a requested retention
period. The receiver's actual task ID and retention period remain authoritative.

The schema declares `mcp_start_task`, `mcp_task_get`, `mcp_task_wait` and `mcp_task_cancel`, including
their typed routes. Management accepts the original local `operationId`, never an arbitrary remote
task ID. Reads use original family membership; control uses the caller's Thread subtree. Local
management remains discoverable after a server configuration is removed, so previously stored output
can still be read. It cannot reopen a removed or changed remote owner.

Management tool calls use the same one-action permission evaluator, ask/decision rendezvous and
execution-time revalidation as other remote tools. Even `mcp_task_get` can reconnect and refresh
remote state, so it is a durable Result call rather than a read-only Catalog projection; a successful
read records no effect. These tools need no server dispatch claim. Background observation and direct
user follow-up controls keep their existing admission paths and do not create repeated tool dialogs.

The original Operation records its exact endpoint/configuration/grant and local dispatch intent
before remote entry. A validated CreateTaskResult is written to ContentStore before immutable
JobAccepted publication. That acceptance releases the original server dispatch slot in Catalog and
shared admission memory, while the remote execution continues. The Task retains its own original
connection lease after normal Run completion. Neither acceptance nor cancellation acknowledges that
remote work physically stopped. A missing creation response remains Unknown and is never replayed
or associated by guessing a `tasks/list` entry.

Status, eventual result and physical-stop evidence are separate. Completed/failed protocol status
provides terminal execution evidence even when result retrieval is unavailable. Cancelled status,
TTL expiry and missing tasks do not. The original Task result reference stores complete response or
application-error content and ordered media independently from the immutable creation receipt and
any already-delivered Unknown call result. `mcp_task_get` reads those facts and bytes;
`mcp_task_wait` uses the existing durable observation Wait and delivers the original result or its
explicit unavailability. Cancelling an observer does not cancel the target. The existing job-stopped
follow-up still requires real stop evidence, rather than result readiness or a cancellation ACK.

Polling, result streams and cancellation use independent original-client requests; a blocked status
or result read does not hold Catalog or prevent cancellation. Reopening resumes only a known accepted
ID with the exact original scope and grant. If the live Host received an ID but lost Catalog's
acceptance reply, it may resubmit only that identical local acceptance, not the remote call. A Host
crash before durable acceptance cannot recover an unknown remote ID. Expired/unavailable owners are
visible, and no current account or workspace is substituted. Original frozen MCP/extension bindings
also exist for Runs without a child-delegation directory; this does not enable child dispatch.

For `input_required`, the coordinator opens the actual `tasks/result` request, preserving the
original roots handler and related-task association. Form/URL elicitation now uses the original
interaction owner below. Basic sampling uses the separate two-review model execution below.

## Reviewed server-initiated form and URL requests

The original authority's installed receiver supplies form/URL capability during protocol connection.
The authority advertises only the interaction capabilities its receiver supports. Each native
call supplies its Operation/executor identity, not a second enabled-tools or grant list. Known related-task identity wins over the HTTP
response stream even if another call owns that stream. Unknown Task or unassociated ordinary stdio
requests receive an explicit unavailable-association error rather than an inferred current Thread.

Original Catalog `mcp_interactions` rows contain short original-client/request/Operation facts and
immutable ContentStore references. The sole decoder normalizes the saved form schema and validates
answers without coercion, filling defaults or interpreting remote text as instructions. UI renders
those fields and submits original primitive/enum-array values, including false, zero and empty text.
Authenticated `ThreadsAPI` list/read/respond routes verify exact Thread/branch before reaching this
same owner. Cursor events refresh a separate paged panel, and revisions prevent stale read replies
from replacing newer facts. No synthetic User input, tool permission, Run Wait or continuation is
created. Model, policy, child and installed nested tool calls retain their real origin.

A persisted choice, send admission, send completion/uncertainty, and URL external completion are
separate facts. Original grant/client/source/Goal/cancel fences run before the one SDK response send.
Send failure never sends a second error response. Interrupted local result acknowledgements retry
only the same short fact; identical UI retries cannot resend remote content. Catalog reopen preserves
history but closes lost inbound requests, never attaching them to a replacement client.

URL content is plain remote text with the exact URL/host. Opening uses the existing external opener
only on an explicit user action; no fetch, preview, favicon, embedded access or inferred completion.
Server completion can precede local consent or arrive after the finite RPC ends, while that actual
client still owns the matching elicitation ID. Consent/opening does not itself prove completion.
Subscribe and explicit unsubscribe retain their own real invocation
association/error body; background observer cleanup cannot impersonate a user-facing call.

### Reviewed isolated sampling

An installed sampling receiver advertises only the basic `sampling` capability before initialize.
It uses the same original HTTP response-stream or accepted-Task association; ordinary unassociated
stdio cannot borrow a Thread. The original interaction links a real generation Operation in the
existing Catalog. Its execution is distinct from the parent MCP call and from response delivery.

The first review edits the complete request and explicitly selects a model from the existing model
authority. Renderer input cannot supply provider endpoints or credentials. The actual registered
adapter, serializer, transport and private credential bridge execute that selection. Approved
systemPrompt/user/assistant roles apply only inside this isolated sampling request, with explicit
sampling provenance. Main Thread history, memory, Goal instructions, tools and opaque continuation
are not imported. Model preferences are hints, not authority to change the reviewed selection.
The original tool origin's frozen Goal identity still governs inference admission and usage through
the existing Goal budget ledger. Isolated prompt content does not exempt the generation from its
execution budget; observed usage and interrupted missing usage remain accounted for exactly once.

A second review accepts or rejects the actual generated output before it is sent to the original
server. Rejection cannot erase observed output, usage or a provider receipt. The interaction owns
review/delivery; the generation Operation owns dispatch, cancellation and execution evidence. The
original RunSupervisor observes that worker independently, including when an accepted Task outlives
its parent Run. Its exact operation-scoped credential binding survives natural Run cleanup but not
current account/scope withdrawal, original request fences or kernel close.

Original and edited requests, the exact provider snapshot, observed output and receipt use the sole
ContentStore, publication protection and GC. Pages and lifecycle sweeps carry short projections;
explicit reads hydrate bodies outside Catalog. Previous failed preparation attempts stay readable
through their original Operation after the user corrects the request. Reopening never regenerates
a dispatched model request or resends an interrupted reply.

This implementation accepts text/image blocks and block arrays and returns text. Tools/toolChoice,
audio, context inclusion, task-augmented sampling and unmapped provider metadata receive explicit
diagnostics rather than being silently discarded. Original `_meta` Task association is distinct from
requesting task augmentation. Token limits are bounded by the reviewed original request and selected
model capacity; unsupported adapter limits or stop sequences remain actionable errors. Provider
completion, local executor stop, missing/actual usage and reply delivery are separate facts.
Controlled streams and native/Host/SDK fixtures do not certify real provider or installed-product behavior.

### Error-source URL requirements

An actual matching `-32042` response can supply URL requirements without creating an inbound server
request. The installed client's synchronous error observation hook retains exact outgoing method/ID,
Operation/executor, actual client and endpoint before a following completion notification arrives.
The same hook covers ordinary stdio, whose outgoing response association is already known, plus
HTTP tools/services/subscription and original Task creation/get/result/cancel paths. Synthetic transport
errors cannot use this hook as received-response or stop evidence.

The complete original error, including unknown fields, remains the execution receipt or Task
observation/result. Local `interactionProblem` diagnostics explain an invalid URL requirement or
ambiguous active identity without trusting remote diagnostic names or changing the original error.
The original Catalog stores each error's normalized URL cards against one shared immutable body;
all card metadata publishes atomically. Paged items omit the full error, while exact read returns it.

Error-card delivery is null. The public response entry records a local choice only, including after
a natural Run failure or lost completion watcher. No protocol response, old Run resume, task recreation
or tools/call retry follows. Original source/Goal/cancel/client/grant fences close automatic tracking;
manual review and explicit navigation of retained evidence do not reacquire execution permission.
External completion is a separate original-client/elicitation-ID fact. Ambiguous active ID reuse
invalidates that association instead of guessing which invocation a later notification belongs to.

For accepted Tasks, nonterminal premature `tasks/result` errors remain diagnostic rather than cached
future terminal results. A fresh known-terminal result error remains the actual underlying error.
Status/completion or an explicit original Task read can continue observation of the same accepted ID,
never replay creation. A get normally joins an existing request. If its original Catalog read already
sees the blocked error, its new recheck waits for any delayed local acknowledgement before issuing
or joining the next original Task read. It does not silently add retries to ordinary joining.

An accepted server-request URL can retain its exact completion watcher after normal Task result
retirement, as after an ordinary RPC. Sending ends with `rpc_closed`; the Task is not revived.
Original cancel/source/Goal/owner-loss fences still withdraw that association, and Catalog rechecks
them before publishing a delayed completion. Actual protocol/Host/SDK composition and controlled peer behavior remain distinct from
real network, provider and installed-product acceptance.

## Resource observers

The schema-owned `mcp_subscribe_resource(server, schemaVersion, uri)` is a finite Result with
Thread lifetime. Its original Operation retains a typed `mcp_resource_subscription` facet after
the subscribe RPC settles; that facet never changes the original outcome, effect, external receipt
or model tool/result pair. `mcp_unsubscribe_resource(operationId)` and the ordinary user Stop path
withdraw that exact observer. Tool management keeps the original permission and subtree checks.
Closed observers remain readable through their real finite model/policy history identity, rather
than being misclassified as active execution or disappearing when their RPC finishes.

The actual McpAuthority connection and URI own a shared live holder set. Two Threads sharing that
client do not issue independent remote unsubscribe requests: only its last holder can unsubscribe.
Removing a holder synchronously closes local delivery before awaiting remote cleanup. Local release,
shared registration, acknowledged unsubscribe and unknown cleanup are distinct facts. An explicit
unsubscribe result preserves the actual server acknowledgement and metadata; a shared release has
no server acknowledgement. None of these facts asserts that remote business work stopped.

Validated updates enter the original ContentStore, passive Input queue and immutable Environment
history. Body serialization/durability stays outside Catalog. The ConversationItem, input and
history node share the same identity; notification origin retains the original Operation, local
listener incarnation and local fact ID. Retries after an uncertain local publication use that same
ID. Only unsent invalidations coalesce; an in-flight fact cannot be overwritten by a later update.
The subscribe receipt does not wait for observer body work. Passive updates do not create a Run,
revive idle work, satisfy unrelated waits or grant a resource read. An authorized model boundary
consumes the existing queue. Resource URIs and remote metadata remain external data, not instructions.

The [MCP resource schema](https://modelcontextprotocol.io/specification/2025-11-25/schema#resourceupdatednotificationparams)
allows sub-resource notifications without defining a subscription ID or universal URI ancestry.
Exact original-client/URI holders receive the complete notification. Other live holders on that same
client/grant receive only a short unresolved-association fact, even if another holder matched exactly.
That diagnostic contains neither the unmatched URI nor its metadata/body and does not claim that
the watched resource changed. No string-prefix routing, automatic fetch, parallel client per observer
or permanent unassociated-notification inbox is introduced.

Accepted global observers can survive normal Run completion. Workspace observers require their
original source: the source-release path first commits a short withdrawal fence, synchronously
detaches the exact listener and acknowledges local release before unpinning/retiring its grants.
It does not wait for slow notification bytes or a remote unsubscribe ACK. Tree/Goal termination
withdraws observers belonging to the actual retained Run membership, including already-terminal Runs.
Previously admitted passive facts remain durable after cancellation.

Host/connection loss creates an explicit observation gap. Reopening can establish a new interval only
for a durably accepted observer under its original endpoint, configuration, credential grant, source
and current policy. The old gap remains history when the new listener becomes active. This protocol
provides no durable remote notification cursor or replay promise; a subscribe whose acceptance is
unknown is not automatically repeated. This slice adds no separate resource Wait or activation rule.
