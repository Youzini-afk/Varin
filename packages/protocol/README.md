# @varin/protocol

Shared native runtime, application, and resource contracts for Varin. The browser-safe root exports
DTOs and pure helpers; it does not own conversation state, execution, credentials, or transport lifetimes.

## Native runtime contracts

`src/agent-runtime.generated.ts` is generated from `kernel/protocol/schema.json`. The Rust Agent Catalog
owns Thread/branch identity, Runs, Operations, input admission, history, queues, Goals, followups and
execution receipts. Consumers retain those original identities and revisions rather than reconstructing
state from renderer timing or a generic busy flag. The Application Host exposes the authenticated
product boundary through `ThreadsAPI` in `@varin/application-client`.

Change the schema and owning Rust implementation together, then regenerate from the repository root:

```sh
bun run kernel:protocol
```

Do not edit generated DTOs by hand or add a second TypeScript execution authority. The kernel wire
protocol is version 46. This is independent of kernel resource storage format 22 (SQLite
`user_version` 16) and Agent Catalog format 77. A wire version is not a database migration version;
unsupported stores are rejected without rewriting existing assets.

## Domain contracts

| Source | Responsibility |
| --- | --- |
| `harness.ts` | Shared shell/output, document/material, search, source and memory DTOs |
| `harness-settings.ts`, `harness-settings-service.ts` | User settings and validated configuration shapes |
| `harness-agents.ts`, `harness-presets.ts` | Native Agent profiles, exact tool names, preset observation and model inheritance |
| `harness-inference.ts`, `harness-model-slots.ts` | Inference receipts and configured model roles |
| `harness-mcp.ts` | MCP connection and interaction contracts |
| `harness-computer.ts`, `harness-experiments.ts` | Computer and research domain projections |
| `harness-web.ts`, `harness-images.ts`, `web-page-text.ts` | Web/material requests, explicit image data and page-text helpers |
| `explore-model.ts`, `explore-model-loop.ts`, `research-search.ts` | Retrieval planning and research search contracts |
| `plan.ts`, `harness-todo.ts`, `agent-personalization.ts` | Plan and personalization structures |
| `source-integration.ts`, `environment-access.ts` | Source integration and environment access identities |
| `language-id.ts`, `utf8.ts`, `permission-gate.ts`, `work-focus.ts` | Shared language identity, byte slicing, permission evaluation and work focus |
| `types.ts` | Basic JSON/image/thinking types and content-free editor-input references |

`AgentRuntime` is `agent`. Missing profile tool selection inherits defaults, an explicit empty array
disables tools, and an unavailable capability directory is not an observed empty directory. Accepted
execution retains its frozen profile; editing defaults does not rewrite a running task.

`ShellExecResult` distinguishes `preparing`, `background`, `completed`, and `spawn-failed`. Admission,
foreground observation, effect outcome and physical process stop are separate facts. Cancellation of
an observer is not proof that its original process stopped.

`FetchResult` preserves material, parser and image failures. PDF uploads enter through the
Thread-scoped Application Host material API, which retains original bytes and issues a fixed snapshot.
The public material reference is not a filesystem or content-hash grant, and PDF upload does not add a
Rust ingestion wire or browser-side parser authority.

`AgentInputContext` carries disk selection or an opaque Documents snapshot reference with dirty-path
metadata. Draft text stays on the authenticated Documents channel. `AgentInputSnapshotConsumer` binds
that snapshot to its actual Thread and branch; neither a renderer path nor a snapshot hash authorizes
another consumer.

## Node-only inference transport

`@varin/protocol/node/embeddings` is the credential-free, stateless OpenAI-compatible embedding wire
implementation used by the Application Host. It is not exported from the browser-safe root. Callers
own provider selection, credentials, authorization, lifetime and retry policy. Native inference uses
one dispatch, no adaptive resubmission, and exposes actual dispatch/response/usage observations.

## Verification

Use the scripts declared by this package:

```sh
bun run --cwd packages/protocol test
bun run --cwd packages/protocol type-check
bun run --cwd packages/protocol lint
```

Protocol changes also require checks in the actual Rust, Host and UI consumers. Type declarations alone
do not establish admission, authorization, recovery or external-effect behavior.
