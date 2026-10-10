# Delivery and explicit pause policy

This ordinary SDK extension demonstrates `deliver` → `pause` → explicit Run resume → `deliver` →
`complete` through `varin.agent.policy@3`. It requests no provider inference and owns no conversation
history, Wait database, timer or resume transport.

## Build, install and select

From the repository root, using its existing SDK and bundler:

```sh
bun run --cwd packages/extension-sdk build
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/delivery-pause-policy/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/delivery-pause-policy/host.cjs
```

Open **Settings → Varin Extensions → Install or update → local folder** and select this directory.
The normal installer captures an immutable artifact. After edits, rebuild and **Reload local directory**.
Select the provider through existing service routing, using the document's current `expectedRevision`:

```json
{
  "serviceId": "varin.agent.policy",
  "version": 3,
  "providerKey": "example.delivery-pause-policy:host:varin.agent.policy@3",
  "scope": { "sessionId": "YOUR_NATIVE_THREAD_ID" },
  "allowFallback": false
}
```

A project rule can use a real `projectId` instead. Installation does not switch the product's Pi default.
A new native Thread run shows its first delivery and pause reason. Queueing another message leaves the
Run paused. Choose **Resume run** to submit the exact `runId` and `waitId` shown by the current snapshot.
The second delivery appears before the Run completes. A failed subsequent launch preparation has its
own **Retry preparation** action; it does not repeat or implicitly authorize the Pause command.

## Updating the policy

The explicit `transitionState` hook accepts only this example's version 1 private states at their
matching delivery or resume event. It does not infer compatibility from arbitrary JSON or copy
another policy's state. Reloading an implementation with this same state contract can activate at
the next real closed boundary. A paused Run stays paused; its update can activate after explicit
resume, without replacing the original Wait or fabricating input. An unsupported private-state
version keeps the former active policy. The user can explicitly choose **Restart policy state** for
the displayed candidate, preserving the Run and its history while clearing only policy state.

## Evidence boundaries

The portable installed-artifact test exercises SDK registration, broker invocation and parsing of all
four policy boundary kinds. The native integration test drives the actual HTTP resume command and
Catalog history. These are separate evidence layers: broker-provided events alone do not prove a
Pause transaction or resume receipt.
