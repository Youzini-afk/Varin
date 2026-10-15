# Memory then read

An ordinary brokered Host extension contributes `memory_then_read` with the existing `provideTool`
SDK. It performs one explicit `memory` operation, then optionally invokes the selected native `file_read`
tool after a succeeded memory Result. It uses no model call, policy action, script environment,
Computer Use, direct filesystem access or separate memory store.

## Build and install

Use the extension SDK, contract and CLI from the matching current Varin workspace build containing
`call.tools.invoke`. The package's `0.2.0` dependency versions do not assert an npm publication.
With those dependencies available, run this package's `build`, `check` and `test` scripts:

```sh
npm run build
npm run check
npm test
```

`varin-extension build` bundles `host.ts` into the manifest's `dist/host.cjs`. Install the built
directory through the normal extension catalog. Review its `runtime.tools` Host capability grant,
select the contributed service through normal routing, and enable the inner `memory` and optional
`file_read` tools in the intended Run. No root package or workspace configuration changes are required.
The manifest descriptor is the single declaration used by discovery and `provideTool` registration.

## Input

For a memory lookup followed by a bounded file read:

```json
{
  "memory": { "action": "read", "scope": "currentThread" },
  "read": { "path": "README.md", "offset": 0, "length": 2048 }
}
```

Omit `read` to perform only the memory operation. The `memory` object is forwarded unchanged to the
real selected tool. Its current schema has `action`, optional `scope`, `id`, `content`, `query` and
`revision`. Actions are `read`, `search`, `save` and `delete`; scopes are `global`, `project` and
`currentThread`. A save needs nonempty `content` and the current catalog `revision`; delete needs
`id` and `revision`. Obtain that revision from a real memory read. The example never guesses it,
automatically retries a stale write or derives a note from an unread file.

The wrapper's `read` field invokes native `file_read`; its schema uses `path`, optional `offset` and
optional `length`, with byte offsets/counts.
These are not line numbers or `limit` arguments. Paths resolve against the original admitted Source;
the extension does not supply a workspace or Source override. Schema references are the owning
[`memory.rs`](../../../kernel/crates/varin-kernel/src/memory.rs) and
[`tools.rs`](../../../kernel/crates/varin-kernel/src/tools.rs). Core validates the selected tool's
frozen schema and action-specific requirements at each inner invocation.

## Results, failures and authority

The Result contains `memory`, the original `{ operationId, completion }`, and a `read` field:

- `not_requested`: the input omitted `read`
- `skipped`, with `memory_not_succeeded`: memory did not return a succeeded Result
- `invoked`, with `receipt`: the original read operation identity and completion

`not_dispatched`, failed/cancelled/indeterminate Results, effects, domain content and `job_accepted`
are preserved without conversion into success. A JobAccepted receipt means admission of independent
work, not its terminal success, and does not start the read. Native memory currently returns Results;
the consumer's JobAccepted handling preserves the general nested-call contract. Read failure does not
undo a prior memory save. Capability/transport rejection and cancellation reject the outer callback;
they are not converted into successful empty output or a fabricated domain receipt.

Memory commits and its required delivery facts belong to the real memory owner, independently of
printing, this summary, or success of the later read. The two operations are not an atomic transaction.
The extension does not establish a new operation owner, write history or claim rollback/physical stop.

Only `{ callId, name, arguments }` is sent through `call.tools.invoke`. Stable local IDs `memory` and
`read` are distinct within the callback; core binds each to the original parent invocation. The client
is not retained after that callback. No `runId`, `origin`, `source`, `schemaVersion`, `tools` or `grants`
authority fields are accepted as wrapper inputs or supplied by the extension. Each inner call keeps
its own selection, schema, permission, resource, cancellation and effect checks. Approval of the outer
tool or its `runtime.tools` grant does not approve either inner operation or bypass a disabled tool.
The outer declaration is an effect because memory may write; it does not expand the inner grants.

## Verification boundary

`host.test.ts` exercises the actual SDK `provideTool` registration and service `execute([input], call)`
shape, including its invocation-scoped capability adapter. Controlled completion inputs verify this
consumer's argument forwarding, order, optional-read selection, receipt preservation and rejection.
They are unit fixtures, not evidence of an installed broker, Kernel permission path, real memory commit
or SDK-to-domain IPC. Those integration checks belong to the runtime's owning suites.
