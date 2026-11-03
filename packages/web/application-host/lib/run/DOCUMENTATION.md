# Run, debug, and test

Application-host supervisors for workspace tasks, DAP adapters, and test providers.
JSON-RPC and product lifecycle stay in this module. Production spawn, raw streams and actual
process-tree lifetime come from the Rust kernel. Renderers never spawn these processes.

## Entrypoints

- `runtime.ts`: `createRunRuntime({ documents, spawn, pathModule, env, isTrusted })`
- `tasks.ts`: `varin.tasks.json` configurations; host-owned `node` scripts use the manifest-selected Node runtime (`@varin/protocol/node/runtime`)
- `debug-supervisor.ts`: DAP session per workspace, generation, breakpoints, watch
- `test-supervisor.ts`: discovery/run tree; builtin Node test runner plus extension adapters
- `routes.ts`: authenticated `/api/tasks/*`, `/api/debug/*`, `/api/tests/*` and SSE events
- `capability.ts`: `workspace.tasks`, `workspace.debug`, `workspace.test`
- `fixture-adapter.ts` / `fixture-tests.ts` / `node-adapter.ts`: test and builtin adapters

## Status

Each workspace debug/test/task owner is `absent`, `starting`/`running`/`paused`, `stopped`,
`failed`, or `empty`. A crash or failure affects only that owner. Stale UI results whose
`generation` does not match the current owner are dropped.

Project-provided (`source: 'workspace'`) commands run only when `isTrusted(root)` is true.
Production Web sets `isTrusted` to false. There is no HTTP route that registers adapters
or providers.

Breakpoint mutation always sends the observed owner as `expectedSessionId` plus `expectedGeneration`,
or sends both as `null` when it authoritatively observed no active session and is preconfiguring. The
supervisor applies a mutation only to that owner state; `ready` and `stale` both return the current owner
identity (when active) and authoritative breakpoint list.

## Routes

- `POST /api/tasks/list|run|cancel|dispose-workspace`
- `GET /api/tasks/events?workspaceId=` SSE
- `POST /api/debug/status|breakpoints|start|stop|control|dispose-workspace`
- `GET /api/debug/events?workspaceId=` SSE
- `POST /api/tests/discover|run|cancel|status|dispose-workspace`
- `GET /api/tests/events?workspaceId=` SSE

Credentials stay in headers. Payloads must not include file bodies.

Application-host endpoint/workspace switch disposes owners. Electron reuses this Web host.
The official IDE Run view unsubscribes when hidden and does not keep refreshing.

## Native lifetime handoff

[Process owner helpers](../process/DOCUMENTATION.md) include pending launches in cancellation,
replacement and disposal. Closing RPC is not process exit. Rejected native completion or denied
termination preserves the owner/writer; markMutated/close failures are retryable. Builtin tests wait
for native completion, not an exit-only Promise that could hang on kernel loss. Stream errors reject
RPC rather than throw from event callbacks. Native consumer tests run in `bun run test:kernel`.
