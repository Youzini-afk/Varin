# MCP capabilities

MCP configuration, OAuth storage, connections and their tool catalogs are owned by the shared
Application Host `McpAuthority` exported from `@varin/pi-host/mcp-authority`. Existing Pi MCP
presentation delegates through `mcp.owner`; execution leases the same owner. Execution
never starts a Pi AgentSession, and the adapter creates no MCP client, installer or secret store.

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

## Execution and permission

Pi scopes read the existing session's effective project trust through the internal, out-of-band
`settings.context` cut. This preserves one-session trust without persisting it or waiting behind the
MCP manager's own request. Unlike `settings.get`, this cut does not reload or mutate settings. The
returned cwd must match the already admitted actor; callers cannot provide a different directory.

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
For native service requests, the original connection's one-shot lifecycle detaches an expired HTTP
session without replaying the call or closing another in-flight RPC. Only the original transport's
session-expired error provides stopped=true and the local `mcp-session-expired` reason; effects remain
Unknown. The default policy still stops at that barrier. A separately chosen new operation can
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
original client's supported roots handler and related-task association. Sampling and elicitation
are not advertised or silently answered by this slice; unsupported requests remain explicit.
Resource subscriptions/updates and fuller server-initiated interactions remain separate capabilities.
