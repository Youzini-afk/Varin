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
