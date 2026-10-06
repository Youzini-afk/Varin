# Pi 1.0 durable runtime assessment

Status: recorded SDK assessment — not a production runtime adoption.

Extracted from the architecture at `27c30f35`; this reorganization adds no new upstream evaluation.
[Current architecture](../architecture.md) · [SDK maintenance](../ops/dependency-updates.md)

## Pi 1.0 durable runtime assessment

The stable AgentSession/SessionManager integration remains the production runtime. Pi 1.0 removed
experimental AgentHarness/pico3 exports from agent-core; Varin consumes the stable Agent loop instead.
[`pi-durable`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md) is an
independent experimental harness with atomic entry/document/task commits, idempotent input admission,
owned child tasks, durable queues, task graphs and restart recovery. These are useful for long-running
Bot work, but are not a drop-in replacement for current SDK extensions or existing Pi JSONL assets.

Source review established the following integration requirements:

- Runtime tool execution builds its environment when executing or rerunning a tool
  (`packages/durable/src/harness/tool.ts`); the coding demo selects NodeExecutionEnv from the current
  conversation cwd. Varin must retain the target and operation identity fixed at Host acceptance
  across environment changes and recovery. A replay-safe declaration alone does not make external
  side effects exactly once; recovery must reconcile the original Host/Rust operation.
- Durable generation/tool tasks and the task ownership graph must map to one Thread/Run lifecycle.
  Native session entries remain Pi-owned; transferred workspace, file, process and compute resources
  remain Rust-owned. A second lifecycle catalog or duplicate mutable resource store is not an adapter.
- Native durable tool hooks/executionMode are a different contract from the stable extension runner's
  tool_call hook, nested receipts and Varin's resource dependency plans. Permission, scoped source,
  scheduling, recovery, MCP and extension UI behavior need explicit equivalence before adoption.
- Its SQLite/JSONL storage has one process owner; the application must retain exclusive worker writer
  ownership. Existing native Pi session files must remain accessible through their owning SDK.
- The experimental pi-server is an attachment/service router over application-owned durable Sessions.
  Authentication, catalog ownership and worker lifecycle remain application responsibilities. It does
  not replace Varin's authenticated Surface protocol and validated Host contracts by itself.

The next meaningful evaluation is restart recovery at admission, tool intent and result publication:
repeat a request ID, change the environment while interrupted, reconcile a non-replayable side effect,
and cancel owned foreground/background work. Compare with the current implementation's real behavior
and complexity before choosing a runtime transition. No durable dependency or alternate writer is
installed in production by the stable SDK upgrade.
