# Bounded planning policy

An ordinary installed `varin.agent.policy@1` extension that requests one auxiliary planning model
job, reads its committed plan, and chooses a real evidence graph from the plan's content. The main
model answers using core-validated evidence. The existing evidence-policy v2 remains independent.

## Build, install and select

From the repository root:

```sh
bun run --cwd packages/extension-sdk build
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/planning-policy/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/planning-policy/host.cjs
```

Open **Settings → Varin Extensions → Install or update → local folder**, choose this directory,
and use its normal enable/update lifecycle. After source changes, rebuild then **Reload local
directory**. This uses ordinary immutable installed artifacts, never a privileged test installer.
It requests no direct filesystem, network or credential capability.

Select the provider through existing service routing, with the routing document's current
`expectedRevision` and an actual project ID:

```json
{
  "serviceId": "varin.agent.policy",
  "version": 1,
  "providerKey": "example.planning-policy:host:varin.agent.policy@1",
  "scope": { "projectId": "YOUR_PROJECT_ID" },
  "allowFallback": false
}
```

A session rule uses the native thread ID as `sessionId`. Use the selected native runtime path;
installing this extension does not switch the product's Pi default or grant a native source/tool.

## Explicit planning-model configuration

In the existing global Harness model settings, explicitly choose the **Agent planning** model
role. Its global settings shape is:

```json
{
  "harness": {
    "models": {
      "agentPlanning": {
        "enabled": true,
        "providerId": "YOUR_EXISTING_PROVIDER_ID",
        "modelId": "YOUR_EXISTING_MODEL_ID"
      }
    }
  }
}
```

Use a provider/model already configured through the normal model and credential settings. These
placeholders are not a runnable paid-service configuration. Installation never writes settings or
auto-enables this role; it has no fallback to the main model. The policy declares
`capabilities: ['agentPlanning']`, so only a selected policy requesting this duty prepares it.
Capability status distinguishes `available`, `disabled`, `unconfigured`, `invalid`, and
`unavailable`. The policy sees a capability ID and public status, never endpoints, provider
configuration, tokens or credential handles. A non-available role stops this example explicitly.

## Demonstrate content-dependent planning

Before the native Run's fixed branch/revision is captured, create `planning-context.md` in the
selected project. For example:

```text
Available evidence files:
- research/latency.md: measured cold-start and steady-state timings.
- research/correctness.md: failure recovery and result validation findings.
Choose the file relevant to the current user's question.
```

Create both files with real evidence. Enable the ordinary `native_file_read` tool and use its
existing authorized fixed branch/revision source. Ask about latency, then in a separate Run ask
about recovery. A planner returning different `reads` produces different actual native read graphs;
quality of that choice depends on the configured model. No real model call is made merely by
building or installing this package.

The sequence is:

1. Read `planning-context.md` through a one-node fixed-source graph and retain its committed reference.
2. Select the admitted planning capability and return `request_model_job` with pinned policy
   instructions and the owned evidence reference. Core freezes the current task context itself.
3. Receive `model_job_completed` with `action_id` and a typed `receipt`: dispatch state, outcome,
   scoped output reference, usage measurement/token metadata, finish reason, failure and usability.
4. Retrieve the successful output via ordinary `read_result`/`result_chunk`. Its complete JSON
   envelope is `{ "kind": "model_derived_evidence", "text": "..." }`.
5. Parse the text strictly as `{ "version": 1, "reads": [{ "path": "research/latency.md" }] }`.
   It permits one to three distinct project-relative paths, no extra fields or traversal. Core
   still independently validates source, schema, permissions and trusted read eligibility.
6. Submit a graph for those selected paths, then use `request_model_with_evidence` for the context
   and committed reads. Core resolves and labels this external data in the actual main request.
   The policy never fabricates user messages, tool exchanges or conversation ModelSteps.

## Bounds and trust

This example declares a 16 KiB context read, 16 KiB complete serialized plan-result inspection
budget, at most three planned reads, one planning request, and at most eight main-answer requests.
These are this author's demonstration choices, not new global runtime hard limits. Keep the context
file small enough for its declared read. Incomplete/oversized or malformed plans fail rather than
silently truncating or falling back. Evidence bodies remain references outside the checkpoint.

Planning is tool-free. Auxiliary tool calls are retained as unusable provider output and never
executed. A plan is untrusted model-derived data, not user authorization, executable instructions,
or a new tool permission. `decide()` performs only bounded local decisions and requests operations;
it never opens a provider connection. Main-model tool calls retain the existing `execute_tools`
settlement path, and unknown effects stop the example rather than trigger a replay.

The ordinary Run/policy identity includes the installed artifact, configuration and capability
requirements. In-flight work retains its pinned generation; later Runs can select updates. Cancel,
revocation, Run termination, restart and kernel epoch fences use the existing bridge and durable
operation owner. A dispatched request of uncertain outcome is not automatically replayed. Missing
usage is not zero cost. This example does not promise model quality, exactly-once remote billing,
or a general writable Agent planner.
