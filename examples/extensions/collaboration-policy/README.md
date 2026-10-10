# Fixed-source collaboration policy

An ordinary installed `varin.agent.policy@3` extension that dispatches a read-only child before
requesting the parent model, performs an independent parent read, then explicitly waits for the
child report. It uses the existing `tool_graph` action and tagged call receipts; it adds no child
state store or special dispatch API.

## Build, install and select

From the repository root:

```sh
bun run --cwd packages/extension-sdk build
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/collaboration-policy/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/collaboration-policy/host.cjs
```

Open **Settings → Varin Extensions → Install or update → local folder**, choose this directory,
and use its normal enable/update lifecycle. Rebuild after source changes and use **Reload local
directory**. This selects an immutable installed artifact through the normal broker. No direct
filesystem, network or credential capability is requested by the extension.

Select the provider through existing service routing, using the routing document's current
`expectedRevision` and an actual native thread ID:

```json
{
  "serviceId": "varin.agent.policy",
  "version": 3,
  "providerKey": "example.collaboration-policy:host:varin.agent.policy@3",
  "scope": { "sessionId": "YOUR_NATIVE_THREAD_ID" },
  "allowFallback": false
}
```

Use the selected native runtime path; installing this example does not switch the product's Pi
default or grant a tool/source capability. Prepare a `fixed_branch` source with an authorized
whole-root read grant and the ordinary `file_read` tool. Create `source.txt` before capturing its
fixed revision. Choose the parent model through normal model/credential settings. The child uses
that exact admitted model and credential scope, with `workMode: read_only` and an explicit file-read tool subset. Running the example
can make model calls on that configured provider; building and installing it do not.

## Sequence and ownership

1. Submit one `dispatch` graph with the declared task, `workMode: read_only` and `tools: [file_read, file_list, file_search]` using dispatch schema version 2.
   The core commits the real policy-action/node origin, independent child Thread, source pin and
   preparation owner. `job_accepted.operation_id` identifies the original dispatch operation.
2. Keep that handle and submit a separate `file_read(source.txt)` graph. It can finish while
   child preparation is blocked. Its committed evidence stays a core-owned reference.
3. Submit `wait_child` for the original child handle. This returns another `job_accepted` for
   the observation call. Neither acceptance receipt says the child has finished.
4. The core collaboration policy checks the actual durable Wait before calling the installed
   policy again. While pending, it parks the Run with this example's unchanged `waiting`
   checkpoint. The extension does not poll, predict a terminal outcome or request a parent model.
5. The core delivers the actual report under its original agent identity, or an explicit
   observation-cancelled fact, and resumes the original graph boundary. Only then does this policy
   request the parent answer with its independent read evidence. A normally completing example
   needs one parent model request. Real parent tool calls still use `execute_tools`, then continue
   the answer; final `stop` completes the Run. The model must respect the actual delivered outcome.

A report that arrives before registration is handled by the existing retrospective Wait check.
Restart resumes the committed graph/checkpoint and accepted child, rather than dispatching a second
child. Cancelling observation leaves the child alive and does not manufacture a successful report.
The later report remains available through its original owner. Child failures likewise remain real
failures in the report, not an empty successful answer.

The example's task text and `source.txt` path are declared configuration in `host.ts`; they are
not runtime restrictions. Its checkpoint stores orchestration phase, original child handle and
read evidence references only. Core owns child status, Wait state, history, source authorization,
call/terminal receipts and recovery. Child context remains independent of parent session notes,
and its tool subset remains file-only and read-only: no recursive dispatch, writes or new grants.
In-flight work retains the selected policy artifact/configuration; this example does not promise
hot migration of incompatible private state. The runtime also supports frozen configured presets and independent child processes; this deliberately
read-only example does not exercise them. Unsupported configured tool names remain explicit unavailable
choices rather than being silently removed.

## Verification boundary

`policy-child.test.ts` exercises this actual bundled package through installation, routing, SDK and
broker, including a retained checkpoint after the broker is reopened. Those portable contract tests
supply events explicitly; they do not prove native Wait parking, source pinning or child execution.
The policy cases in `child-dispatch-review.native.test.ts` exercise those behaviors using the real
Host, kernel, Documents/WorkingState and loopback provider. Native business-path results must be
reported separately when that environment can start its required transport.
