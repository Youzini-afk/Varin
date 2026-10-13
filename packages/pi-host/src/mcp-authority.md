# Application Host MCP authority

`McpAuthority` owns the SDK's `McpServerConnection` instances in the Application Host.
`mcp-host-owner.ts` is the Pi-worker proxy; `createMcpExtension` retains Pi tool registration,
codemode/search exposure, renderers, manager UI and normal tool permission hooks. It delegates
configuration, transports, resources, OAuth and credential storage through `mcp.owner`.
Native execution uses the same authority without constructing a Pi `AgentSession`.
Pi session start only installs a deferred preparation callback: it cannot make Host RPCs before
broker actor registration. First model/manager/config access awaits that same callback. Direct
servers prepare for the first model request; deferred servers wait for an actual discovery/tool
operation that needs them. Missing readiness never appears as a successful empty catalog.

## Configuration and execution scope

The owner continues to read the SDK's user `mcp.json` and trusted project `.pi/mcp.json`.
`configCwd` identifies the admitted original project; `executionCwd`, `environmentId` and
`executionScope` identify the actual authorized process environment. A materialized isolated
Run uses its materialized cwd while retaining the original project configuration source. A
source-less Run may use an explicitly admitted neutral global execution scope. Transport type
is not a filesystem permission or a reason to reject a server.

Each server selection requires its own frozen `owner`: resource location, configuration/trust and
execution scope. Scope and resource keys include that location; the combined provenance has no
shared configuration owner. Native child delegation preserves these owners and exact definitions
separately from execution resource identities. Local child preparation groups each complete frozen
owner and composes its exact contribution; managed child contributions still report unavailable until
their original Source retention and derivation are connected. The original authority prepares the
child's own execution binding and the runtime commits it once before first use. A global configuration
file may still describe a workspace execution dependency; a fixed read-only child cannot borrow the
parent's mutable cwd. Neutral global dependencies remain neutral even when a child has a private cwd.

The Host supplies scope from its registered actor; the worker cannot send credential directories,
project trust decisions or execution paths. Worker scope handles also bind authority instance,
session, worker ID and worker generation. `control.mcp` is a normal-session capability; auxiliary
actors retain their explicit method allowlists. The Pi adapter receives credential-free server
presentation configuration, never OAuth tokens, HTTP authorization headers or stdio environment
values. Extension-registered servers still use Pi's existing registration/discovery precedence.

Config writes use the existing revision-checked `ConfigTextFileEditor`. OAuth uses the existing
`mcp-auth.json` and refresh locks. Opaque grant metadata lives inside that same credential state;
refresh preserves it, while a new OAuth authorization state rotates it. Provider-token servers
use the shared Host credential authority's token and scope callbacks. No token-derived durable
identity or second plugin/configuration store is introduced.

## Managed project contributions

The coordinator keeps its global contribution while a target Host independently prepares its own
project configuration against the admitted physical source. The target filters project definitions
before starting any connection, and a same-name project definition shadows the global definition.
Combined tools retain per-server owners and collision-safe public names; restoration validates the
original server/resource/schema, not an owner-local spelling of that public name.

A target view is a live reference under the original Source principal, authority and epoch. Its
immutable creation request is cancelled and drained before exact release, including a lost preparation
reply. Explicit withdrawal propagates original target tokens to permission waits and in-flight RPCs;
failed configuration candidates do not permanently revoke an older valid contribution. Source closure
awaits pending preparation, retained generations and scoped transport close without closing siblings.
The Host can adapt a resolved transport through the trusted scope seam. Target stdio uses the original
Source grant/root and Kernel process guardian; SDK close alone is not a native process-tree receipt.
Unknown dispatched effects are not replayed after reconnection.

This continuation supports ordinary tools, resource reads, prompts, Tasks, persistent resource
observers and finite reverse interactions. Managed child preparation remains an explicit
unavailable boundary; mixed local owners are composed from their original frozen dependency cuts.

## Preparation, binding and revocation

`inspect(scope)` reads configuration and existing readiness without starting transports.
Configured servers, cached declarations and connected tools are separate counts. Failed,
needs-auth, stale and disabled states remain explicit. `acquire(scope, { servers, signal })`
prepares only the caller's selected dependencies. Selected failures reject; an empty dependency
selection retains malformed configuration as explicit readiness information without blocking
unrelated conversation work.

A lease freezes initial tools, configuration/server metadata, an opaque scope reference and a
stable generation of the selected configuration dependencies. Unselected ordinary server edits
do not invalidate direct bindings. Inline credential-bearing configuration has no entry-local
external-edit revision, so its source-file metadata is conservatively included instead of a hash
of the credential value. Its `inspect()` projects current readiness separately.
`discover(server, signal)` prepares only the named server. `prepareTool(server, tool,
schemaVersion, signal)` retains a concrete target only if the exact declaration and credential
grant still match. Native generic-call arguments carry that expected target version, permitting
validated restart rebinding without silently changing the tool or account. The runtime must
never replay a previously dispatched operation whose effect is unknown.

Tool naming is derived from each complete server tool list, independent of which other servers
were selected first. Full JSON Schema validators are compiled once per declaration/grant version;
Ajv supports draft-07, 2019-09 and 2020-12 plus standard formats. Unsupported schemas fail before
dispatch. Validation never coerces arguments, inserts defaults or removes additional properties.
Remote annotations are descriptive and never grant permission or establish actual effects.

Per-scope definition identities are captured from the original configuration snapshot. An accepted
child may derive its execution scope from an exact still-live original definition after ordinary
configuration replacement, including a deferred server that was not yet connected. Source identity,
selected server set, current trust and credential/declaration checks remain with this authority.
Managed dispatch retention captures an authority-branded definition token from its original
composition snapshot, including deferred definitions. Tokens keep that original scope alive through
ordinary parent retirement until exact child dependency release. A proof-authorized child can derive
independent execution resources from those tokens; the separate explicit-continuation path accepts
only exact current definition versions and configuration identity. Neither API accepts serialized
tokens or changes ordinary acquisition's complete owner-equality check. Disable/removal and credential
withdrawal revoke retained definitions and derived connections.
After the last original scope is gone, unavailable historical configuration is an explicit failure;
there is no persisted configuration copy or latest-definition fallback.

Ordinary replacement retains referenced connections. Explicit disable/removal, hidden tool
withdrawal, sign-out and credential relink revoke admissions. Checks run before authorization
and again immediately before the SDK enters a request, including after reconnect. Native callers
may supply a trusted asynchronous `beforeDispatch` policy check; functions never cross Pi RPC.
Errors distinguish not-dispatched from failures/interruption after the dispatch boundary.

Abort signals reach MCP requests. Releasing a lease prevents new admissions and interrupts its
own in-flight requests, retaining transport references until they actually settle. Other leases
keep their shared transport. The last reference closes the connection; Host shutdown closes the
whole authority. OAuth UI flows are owned by their worker scope and cancelled on scope disposal.

## Verification ownership

`pi-native-tools.test.ts` exercises real local MCP transport sharing between Pi and native leases,
full argument validation, Pi permissions/codemode projection, manager config writes, revocation
and shutdown. Native bridge/permission suites own durable operation and live policy behavior.
SDK adaptation is maintained in the existing Pi package patch; refresh both installation and
production lockfiles when changing its exports or dependency graph.

## Native resources, prompts and protocol bodies

`observeResource` uses the same negotiated original client, credential checks and `requestOnce`
lifecycle. Each actual client/URI registration owns temporary local holders; only its last holder
can issue remote unsubscribe. Detach removes local delivery synchronously and returns a separate
cleanup result, preserving an actual acknowledgement when one exists. Scope/connection references
remain until the original request settles. A delayed old cleanup cannot remove a replacement group.
Local holder identities are not remote subscription IDs.

Notification callbacks capture only holders present on the receiving client, then perform current
credential and connection checks off the SDK reader callback before delivery. Replaced/revoked clients
cannot address a new listener. Exact URI associations retain opaque protocol fields; other same-client
holders receive only an unresolved-association diagnostic. This intentionally does not infer arbitrary
URI ancestry or spread an unmatched URI/body. Resource contents still require a separate admitted read.
Connection loss reports a gap; the authority does not invent remote replay or launch model work.

The native lease discovers negotiated resources/prompts on the same original client. Its narrow
service requests cover resource/template pages, resource reads, prompt pages and prompt retrieval.
They use the original connection's `requestOnce(callback)` lifecycle and call the callback's exact
client once; the resource presentation cache and read-only HTTP retry are not execution authority.
A session-expired error detaches only the failed current client without closing other in-flight calls.
The current operation is not replayed. A later new operation may reconnect and must recheck current
capabilities, credentials, prompt declarations and admission before dispatch. Authentication failures
retain the original connection owner's needs-auth transition. The original transport's branded
session-expired error supplies RPC-stop evidence, but not evidence of absent remote effects: the Host
retains an Indeterminate/Unknown result, a local `mcp-session-expired` reason and stopped=true.
The default policy's Unknown barrier remains in force; reconnecting does not authorize continuation.
A resource URI is sent only to its selected server,
including URIs absent from a listing. Pagination cursors, top-level `_meta` and unknown result fields
are retained. Unsupported negotiated capabilities fail explicitly.

A service version binds capability/protocol, original configuration and opaque credential grant.
Prompt retrieval additionally binds the exact listed prompt declaration. Current descriptors are
reused; a cold/restarted binding resolves the exact saved version through explicit pagination.
A new client or `notifications/prompts/list_changed` invalidates the descriptor cache. A late list
response cannot repopulate a cache invalidated while it was in flight. Prompt arguments must be
strings and include declared required arguments; undeclared string arguments remain the server's
responsibility. Remote roles, annotations and descriptions grant no instruction or execution authority.

`McpCompositions` routes discovery and service requests through the retained contribution whose
server definition and resource match the frozen snapshot, rather than a newer gateway definition.
Explicit hidden/disabled service withdrawal interrupts admissions; ordinary replacement retains the
old contribution for its original callers. Resource subscriptions/updates, server interactions and
negotiated durable MCP Tasks retain the independent original-holder lifetimes described below.

Managed server provenance also freezes the original Source authority address. Task-owner acquisition
can carry its coordinator Operation/executor identity through both composition paths. Retained
connections keep that original source reference; an ordinary Run view release is not daemon drainage.
Managed Task adapters now retain that original holder through a one-shot Source creation receipt and
A's Catalog HostJob cleanup acknowledgement. A owns status/result scheduling and cancellation; a lost
reply recalls only the original creation outcome. Local projection release is separate from durable
holder cleanup. Managed resource observers likewise retain the original SDK holder and creation ACK;
A listener projections disconnect independently, while explicit withdrawal awaits original unsubscribe
and callback drainage. Failed SDK observer acquisition drains its hidden URI holder before rejecting.
The coordinator records gaps rather than claiming notification replay.

Managed reverse requests route by the authority's trusted original scope. B retains only the actual
SDK responder, completion watcher and short Source delivery facts; A owns the existing interaction,
review, sampling model execution and credentials. An immutable request hash binds each original
connection/request identity. B admits the reviewed response once, before its SDK send, and only the
SDK settlement callback proves sent/not-sent/unknown. A durably publishes those facts before exact
revision acknowledgement and Source cleanup. Losing a transport acknowledgement never resends a
response or recreates a receiver/model decision. A background reconciliation flight belongs to one
original delivery, so a blocked peer does not block other deliveries or unrelated Run cleanup.

Closed SDK owners preserve unacknowledged request bodies. Reading them still requires the original
active Source grant and current project/read permission; revocation does not grant cleanup a new
body-reading permission. A missing original heap remains unavailable. A repeated Source open that
cannot prove it created this responder fails closed, including an ambiguous lost initial open ACK.
A body matching the original binding/hash remains a read-only historical fact so A can acknowledge
and clean it up. Late managed publication records an unavailable interaction, never new review or
model authority.
Explicit resource unsubscribe retains the new control Operation separately from the original
observer holder, including when its caller belongs to a later Run.
