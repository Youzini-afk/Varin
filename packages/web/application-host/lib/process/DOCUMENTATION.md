# Native process consumers

## Ownership

Production Application Host injects `KernelProcessService` from
[../kernel/process-service.ts](../kernel/process-service.ts). Rust owns the actual PTY/pipe,
process identity, raw output offsets, stdin acknowledgement, termination and directory writer.
This module only adapts Node stream shapes and coordinates a product owner's asynchronous
startup/stop. It cannot spawn a production OS process or decide that a native writer has exited.

`ManagedProcessOwner` tracks a pending launch, cancellation controller and returned child.
Cancellation before admission does not spawn; cancellation during admission waits for the
candidate and its actual stop. `ManagedProcessLaunchError` carries a child whose handoff failed.
`terminateOwnedProcess` includes pending startup in disposal. Unknown exit or denied termination
rejects and preserves the owner; a rejected launch is not proof that no child exists.

## Production consumer map

| Product owner | Native backend | TypeScript responsibility |
| --- | --- | --- |
| Terminal runtime, HTTP/WebSocket and Harness shell | Kernel PTY | Same terminal handle, attachments, UTF-8 display, bounded replay, OSC 633 and command presentation |
| Thread worktree setup | Kernel pipe process | Setup policy, timeout request and preparation stages |
| Language supervisor | Kernel pipe process | LSP framing, versions, language views, diagnostics and provider activation |
| Debug supervisor | Kernel pipe process | DAP framing, breakpoints, generation and adapter selection |
| Workspace task runner | Kernel pipe process | Trusted task configuration, status and textual output |
| Test supervisor | Kernel pipe process | Discovery generations, protocol, builtin Node runner and result tree |

Admission shares the Rust file lease boundary. Active or unknown native processes protect their
working-directory ancestry from remove/rename/materialization. Closing a protocol connection does
not release the Documents mutation writer: actual process close and writer-close must succeed.
Writer cleanup failure remains retryable, not silently swallowed.

The production `process-identity.ts` resolver checks retained Thread ownership before requiring
Documents enrollment, while already-enrolled Threads keep distinct owning/execution IDs. A sibling
without a retained record is not admitted by proximity. The service is private to the Host. The authenticated terminal process-inspection route reports
retained state for an admitted root. Kernel loss becomes terminal status `error` and rejects shell
and adapter work without inventing an exit code or rerunning the command.

## Scope

Pi session/catalog/inference worker creation stays with runtime-broker. Short Git semantic commands
under the file gate and shell-discovery/bootstrap probes remain domain adapters: this is not a
replacement of every child_process import. Debuggee children spawned inside a native DAP adapter
belong to that native process tree, not another Host backend. Node/Bun PTY providers are not selected
in production, and D-282 removed their distribution packages and Electron rebuild probe.

The OS implementation is in `kernel/crates/varin-kernel/src/process/` and
`storage/process_resources.rs`. A guardian is the same packaged executable and owns no SQLite
connection. The sole Storage retains durable records. Windows uses named Jobs; Linux uses sessions
plus a subreaper for reparented descendants; other Unix platforms use managed-session observation.
This is not a hostile-code sandbox. Unproven old-epoch exits stay unknown rather than being inferred
from a stale PID. Linux/macOS implementation is not claimed as locally tested on Windows.

## Verification

`native-process.test-helper.ts` uses an isolated real release kernel, never a production import.
`bun run test:kernel` requires that binary and runs
[../kernel/kernel-process.native.test.ts](../kernel/kernel-process.native.test.ts) and
[../kernel/process-consumers.native.test.ts](../kernel/process-consumers.native.test.ts): binary streams, PTY/resize,
input deduplication, bounded backpressure, leases/revocation, descendant drainage, Host/kernel loss,
retained writers, and actual LSP/DAP/task/test consumers. Existing synchronous fake-child unit seams
are kept distinct from native evidence.
