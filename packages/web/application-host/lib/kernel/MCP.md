# MCP tools

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
exact schema version. This is typed discovery
and invocation, not a claim that a JavaScript codemode executor has been implemented. The
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
ModelStep, Operation, tool call and retained owner generation. Rust verifies that the call's description
matches the frozen model request. The Host rejects changed identities and caches dispatched calls so
repeated frames cannot duplicate remote effects.

The existing shared permission evaluator remains the rule authority. Unknown tools default to ask;
explicit allow/deny rules retain their meaning. Ask opens a separate permission Operation/Wait,
not `ask_user`. Its one-shot decision is bound to the exact arguments, actor, tool/owner and policy
generation. Execution rechecks the current policy and owner before dispatch; drift rejects the call
without opening a new dialog while a resource claim is held.

Remote calls and selected-server preparation create durable Operations. Metadata listing without
server selection sends no remote request. Server/environment keys coordinate dispatch admission; they do not assert remote
transaction isolation or that an ordinary MCP server stopped after a cancellation notification.

## Cancellation, results and lifetime

Before transport entry, rejection has a `not_dispatched` receipt. A received successful MCP response
confirms the tool result. A remote `isError` response is a failed tool result and does not prove rollback.
Cancellation, disconnect or failure after dispatch reports an unknown effect and is never retried here.
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
