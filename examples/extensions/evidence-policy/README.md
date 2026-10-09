# Bounded evidence policy

An ordinary brokered Host extension implementing `varin.agent.policy@1` with the SDK's
`provideAgentPolicy`. Install/enable this package and select its provider in existing service routing:

```json
{
  "serviceId": "varin.agent.policy",
  "version": 1,
  "providerKey": "example.evidence-policy:host:varin.agent.policy@1",
  "scope": { "projectId": "YOUR_PROJECT_ID" },
  "allowFallback": false
}
```

Use the routing document's current `expectedRevision` when updating. A session rule uses the
native thread ID as `sessionId`. Without a selected policy, the existing default loop remains.
Explicit selection failures do not silently switch a run back to the default loop.

Build with this repository's SDK:

```sh
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/evidence-policy/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/evidence-policy/host.cjs
```

The example bounds a research run to eight model requests, settles every registered tool exchange,
and stops on unknown effects rather than retrying them. Eight is this example's configurable policy
budget, not a runtime restriction. Model/tool execution, credentials, authorization, resource ownership,
provider exchange pairing, questions, and history remain core responsibilities. Pair it with the
project-context example to supply research instructions through the separate context contract.

Decision input contains immutable run state, history count/head identity, the committed event's
settlement facts and this implementation's private JSON checkpoint. It does not copy conversation
bodies, tool result bodies, images, credentials or model endpoints. This first policy contract can
request the selected model, settle its already-registered tool batch, wait on a durably registered
condition, complete, or fail. Independent tool graphs, subtask dispatch and multi-model planning are
not implemented by this slice. Slow research/model work belongs in ordinary authorized execution,
not inside `decide` or `describe`.

Declare every policy option in `configuration`; it is detached/frozen at registration and supplied
as the third `decide` argument. Do not use mutable extension storage, network work or external effects
inside policy decisions. The durable identity incorporates executing artifact integrity, declared
configuration and private-state version. Same-name code changes therefore cannot recover an old
checkpoint accidentally. Each Run retains its exact broker generation; a new Run can choose a new
policy. Restart recovery must find matching artifact/configuration or explicitly fail, never migrate
private state implicitly. Cancellation discards a late decision and core closes outstanding exchanges;
it does not claim that an accepted independent job was undone.
