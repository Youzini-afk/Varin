# Host MCP service

This directory owns the Agent runtime's MCP configuration, credentials, discovery, connections and
protocol client. `McpAuthority` is shared within an Application Host across compatible consumers.
It does not create a Pi session or depend on Pi's MCP client/configuration loader. The default Pi
runtime retains its separate MCP authority and assets.

`application-host/index.ts` composes this owner with model-account resolution, trusted project
configuration, Rust process services and the existing interaction/Task/resource adapters. Rust
Catalog remains the authority for accepted Operations, effects, Tasks and recovery. See the
[runtime MCP contract](../kernel/MCP.md) for execution permission, media, sampling and elicitation.

## Component map

| Responsibility | Entry |
| --- | --- |
| Sources, complete definitions, independent policy overrides | `configuration.ts`, `settings.ts` |
| Revision-checked original-file editing | `config-text-file-editor.ts`, `revisioned-text-file-editor.ts` |
| Scope, authority leases, instance pool and withdrawal | `authority.ts`, `compositions.ts`, `lease-composition.ts` |
| Connection and independent directories | `connection.ts`, `directory.ts` |
| Generic protocol client and transports | `client.ts`, `transport.ts`, `protocol.ts` |
| OAuth and model-account references | `auth.ts` |
| Argument-header schema semantics | `headers.ts` |
| Task, interaction and subscription contracts | `tasks.ts`, `interactions.ts`, `resources.ts` |

## Sources, trust and identity

The native Host reads `VARIN_DATA_DIR/mcp.json`, that file's explicit external `sources`, and a
trusted project's `.mcp.json`. External sources are read in configured order, Host definitions then
take precedence, and the trusted project can replace an entire same-name definition. A replacement
never splices one source's command or URL with another source's credentials. `mcpPolicies` applies
enablement/exposure overrides separately. Project configuration cannot select a user model account.

Settings show actual source and state, save the selected original file and check its revision.
Malformed sources keep their last valid snapshot and report an error; invalid individual entries
do not disable independent valid servers. Actual source removal and explicit disablement have their
own withdrawal semantics. Reads never clear or rewrite a bad file. The common project-trust reader
in `@varin/settings-store` preserves the existing trust asset without loading the Pi SDK.

Server definition, cached directory and live instance are different objects. Binding identity includes
the real resource Host, configuration origin/version, admitted execution environment and account.
`configCwd` is the original project location; `executionCwd` is the actual process location, including
a materialized work branch. Display names, equal URLs and path strings do not grant shared authority.
Managed-source routing preserves the owning Host and original source permit.

Compatible consumers share an instance by default. `isolation: "session"` additionally partitions
instances by session while allowing that session's consumers to share. `lifecycle.keepAlive` and
`lifecycle.idleTimeoutSeconds` configure idle retention and cannot be combined. By default the last
holder releases the instance immediately. Active leases, Tasks and subscriptions prevent idle
collection; a new holder cancels the idle timer. Pool-retained instances still observe configuration
withdrawal after their views have left. These options use the existing raw configuration editor.

## Preparation and four independent directories

The generic client negotiates protocol/version capabilities and supports stdio and Streamable HTTP.
Production stdio runs through the existing Rust process owner, including real cwd, stop and remote
ownership. The Host does not create a second process authority.

A successful handshake publishes connected state. Tools, resources, resource templates and prompts
then prepare independently, with their own pagination and readiness. Tool calls await the required
tool declaration; a slow resource/template/prompt list cannot hold them. Resource/prompt requests
likewise do not await tools. Preparation belongs to the instance, so cancelling the first waiter
does not cancel other consumers' preparation.

Each directory reports `unprepared`, `refreshing`, `ready`, `failed` or `needs-auth`. Failure preserves
previous data without calling it a fresh successful empty list. A list-change notification during
pagination invalidates that candidate; the replacement is read before publication. Independent
servers prepare, refresh and retire without a global readiness barrier.

`mcp-directory.json` is rebuildable offline discovery material. Successful directory fields commit
independently and merge asynchronously, rather than rewriting the full cache during each search or
dispatch. Offline search does not connect a server and cached schemas never authorize execution.

Cache identity uses non-secret definition/environment and account scope. Explicit `${VAR}` references
are captured in memory for the original connection; reconnect cannot silently reread them as another
account or command target. Changed values withdraw affected bindings. Because those references do
not establish durable account continuity, their offline directories are neither read nor persisted
across restarts. Secret values and their hashes are not persistent cache keys.

## Tool schemas and exposure

Direct, codemode, deferred and hidden exposure all resolve through the same authority, declaration
version and original Operation path. Discovery metadata does not authorize dispatch. Deferred calls
and ordinary scripts use the existing invocation mechanism, without a separate MCP execution loop.

The original `inputSchema` is the execution contract. Ajv validates without coercion, inserted defaults
or removed fields. `modelInputSchema` is a separate projection that removes only validated
`x-mcp-header` routing annotations; ordinary data and constraints remain intact. An unsafe or
unsupported single schema is discoverable with `mcp-schema-unsupported` and deferred exposure, while
valid tools still publish. That tool's execution fails explicitly instead of using a loose validator.
This does not promise that every model provider accepts every JSON Schema dialect.

Calls verify the retained declaration before dispatch. A new directory publishes a new candidate at
the existing composition boundary and does not rewrite a prepared model request. MCP annotations
describe tools; they cannot grant permission or prove that an effect is harmless.

## Authentication, disconnect and recovery

`mcp-auth.json` stores MCP OAuth separately from model accounts using the shared atomic file store.
The generic OAuth flow retains issuer/resource, scopes and client identity. Normal token refresh and
scope reordering preserve account continuity; an actual scope/account change invalidates the binding.
Cancelling a sign-in wait closes its temporary callback listener. Model-account references resolve
through the native [model service](../models/DOCUMENTATION.md), never the old Pi account directory.

HTTP 404 with an existing session invalidates that session, including POST and SSE/listen GET paths.
The original request is sent once. The client preserves the negotiated metadata needed to describe
its old binding and reports session expiry; it does not reconnect and replay a callback. A later new
Operation can prepare a connection using the original lease's definition and account, and must
validate the newly discovered schema. Changing a same-name server to another URL does not retarget
that old lease. Unknown dispatched effects, remote tool errors and cancellation are not non-dispatch
proof. Durable Task recovery uses its actual accepted remote ID, not ordinary RPC replay.

Tasks and resource subscriptions retain independent holders beyond the initiating view or Run.
Lost or gracefully closed subscription streams record notification gaps, not an invented complete
event history. Server-initiated requests are associated with the original Operation/Task and handled
outside protocol-reading callbacks; user interaction or sampling cannot block unrelated responses.
Cancellation intent, response receipt and physical executor stop remain distinct facts.

## Rationale and support boundaries

The pi-mcp-adapter comparison informed offline discovery, lazy connections and OAuth/content handling.
Varin deliberately uses complete connection replacement, instance-owned preparation, asynchronous
field-level caches, separate original/model schemas and no callback-level replay. The reference's
Pi-session lifetime, synchronous cache, fixed output limits and temporary-file ownership are not this
service's contract. This comparison did not incorporate its code; existing repository/dependency
license obligations remain in [THIRD_PARTY_NOTICES](../../../../../THIRD_PARTY_NOTICES.md).

Controlled SDK/HTTP fixtures verify protocol and lifecycle behavior, not every real server or
deployment. Live OAuth, stdio process trees, managed remote Hosts, MCP Apps and installed-product
interaction paths require their own acceptance. See [runtime acceptance](../../../../../docs/runtime-acceptance.md).
