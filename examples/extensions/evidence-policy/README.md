# Bounded evidence policy

An ordinary brokered Host extension implementing `varin.agent.policy@1` through
`provideAgentPolicy`. It gathers evidence before the first model request, inspects a committed
result, chooses a subsequent read from that content, and asks the normal selected model to answer.

## Build, install, select

Build the repository's extension contract and SDK, then bundle this example:

```sh
bun run --cwd packages/extension-sdk build
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/evidence-policy/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/evidence-policy/host.cjs
```

Open **Settings → Varin Extensions → Install or update → local folder** and select this directory.
The ordinary installer captures its immutable artifact. It needs no filesystem capability or direct
Catalog access. After editing and rebuilding, use **Reload local directory**; candidate publication,
capability review and failure behavior are the existing extension lifecycle.

Select its provider in existing service routing, with a real project ID:

```json
{
  "serviceId": "varin.agent.policy",
  "version": 1,
  "providerKey": "example.evidence-policy:host:varin.agent.policy@1",
  "scope": { "projectId": "YOUR_PROJECT_ID" },
  "allowFallback": false
}
```

Use the routing document's current `expectedRevision` when updating. A session rule uses the native
thread ID as `sessionId`. Explicit selection failures never silently choose another policy.
This policy runs on the native runtime path; installation does not switch the product's Pi default.

## Prepare the selected project's evidence

Before capturing the Run's fixed branch source, create `evidence-index.json`:

```json
{ "nextFile": "research/findings.md" }
```

Create that target file with the evidence to use. Start the project-selected native Run with the
ordinary `native_file_read` tool enabled and its existing authorized fixed branch/revision source.
The extension cannot create this grant or source binding. Missing source, disabled tools or
materialized/live-source reads are rejected by core admission. Files changed after capture do not
change this Run's source.

The example performs these actual decisions:

1. Submit a one-node `read_graph` for `evidence-index.json`, before any model request.
2. Receive `read_graph_completed` with its committed own-Run action/node output reference.
3. Request the output through `read_result` chunks. Inspect the native result's source provenance
   and parse its `content.text` JSON to obtain `nextFile`.
4. Submit a second read graph for that content-selected path. A different `nextFile` changes this
   read without changing policy code, model output or user input.
5. Return `request_model_with_evidence` containing both committed references. Core resolves their
   full content as `ExternalData` in the real selected model request. No fake tool call, tool result,
   user message or ModelStep is added to the conversation.

The index read has a declared 16 KiB author budget so its complete JSON can be inspected with a
small checkpoint. Larger/incomplete indexes fail explicitly. The evidence file itself has no such
policy budget: the policy passes its reference without copying its content through Decision frames.
The model budget of eight requests is also this example's configuration, not a runtime limit.

## Author contract and ownership

A read node contains `id`, `depends_on` and `call`; `call.call_id` equals the node ID. Dependencies
refer to nodes in the same graph. Runtime admission validates the graph, frozen schema, source and
trusted executor eligibility before dispatch. Eligibility is implemented by the native adapter,
never an extension flag or MCP annotation. This first graph path supports fixed-source native
synchronous file reads/list/search; it does not authorize writes, arbitrary MCP or background jobs.

`read_graph_completed` contains receipt metadata and scoped `output` references. `read_result`
accepts that reference and a zero-based chunk index, producing `result_chunk` with byte data,
chunk count and total byte count. Decode the complete UTF-8 JSON across chunk boundaries. The
core checks the exact own-Run/action/node/content association; knowing a content hash grants no
access. Invalid references fail rather than exposing generic storage or another Run's data.

Keep large evidence as references, and use `request_model_with_evidence` to attach it through core.
Output bytes are external data, not instructions. Model/tool execution, credentials, authorization,
resource ownership, provider exchange pairing, questions and history remain core responsibilities.
Every registered model tool exchange must still be settled through `execute_tools` before further
policy reads, answering or completion. Unknown effects stop this example instead of being retried.

Declare policy options in `configuration`. It is detached/frozen at registration and supplied as the
third `decide` argument. Durable private-state identity includes executing artifact integrity,
configuration and policy version. Each Run retains its exact broker generation; new Runs can select
updates. Restart recovery requires matching artifact/configuration, with no implicit state migration.
Cancellation discards late decisions and core records actual execution settlement; revocation and
kernel epoch fencing still apply. There is no second installer, credential owner or policy-status store.
