# Committed Run activity projection

This installable brokered extension consumes `varin.run.activity@1` and maintains a queryable
per-Run activity projection. It handles accepted, changed (including terminal), and cancellation
request facts. It receives only committed cursor/Run/revision/kind/state metadata, never prompts,
transcripts, tool payloads, credentials or token streams. The projection is derived data, not another
Run authority. Installing this package alone does not activate a subscription.

## Build, install, select

Build the current SDK, then bundle this ordinary extension:

```sh
bun run --cwd packages/extension-sdk build
packages/extension-builtins/node_modules/.bin/esbuild examples/extensions/run-activity/host.ts --bundle --platform=node --format=cjs --alias:@varin/extension-sdk=./packages/extension-sdk/dist/index.js --outfile=examples/extensions/run-activity/host.cjs
```

Install/enable this folder through the existing local extension flow. It needs no capability grants.
The example initializes only empty schema-0 storage documents to its schema 1. Existing nonempty or
unknown storage formats are rejected without discarding data.
Use the existing service-routing settings/API to select it for a project or session. For example:

```json
{
  "serviceId": "varin.run.activity",
  "version": 1,
  "providerKey": "example.run-activity:host:varin.run.activity@1",
  "scope": { "sessionId": "YOUR_NATIVE_THREAD_ID" },
  "allowFallback": false
}
```

Routing writes include the document's current `expectedRevision`. A `projectId` scope selects all
native threads whose saved context belongs to that project. This first slice requires one
unambiguous project scope per thread. A thread with branches in different projects keeps running,
but its observer is withdrawn and reports ambiguous scope. Branch/Run-specific multi-project
subscription selection remains future work; it is not replaced by a core Run restriction. Existing
scope precedence and ambiguity rules apply. No matching explicit routing rule or legacy explicit service selection means no observer
activation. Chat admission does not wait for observer startup, execution or acknowledgement.

## Read the actual projection

Use the existing `RuntimeAPIs.extensions.invokeService` client or authenticated
`POST /api/varin/extensions/v1/services/invoke` route. The stable subscription ID is exactly:

```ts
const subscriptionId = JSON.stringify([
  'varin.run.activity@1',
  'example.run-activity:host:varin.run.activity@1',
  threadId,
  projectId ?? '',
]);
const request = {
  serviceId: 'varin.run.activity', version: 1, method: 'getSnapshot', args: [subscriptionId],
  routing: { sessionId: threadId, ...(projectId ? { projectId } : {}) },
};
```

`getSnapshot` returns `null` before the first projection or `{ subscriptionId, cursor, projection }`.
The projection is keyed by Run ID; each row contains thread/Run identity, last fact cursor, Run
revision, event kind and observed state. `inspect` with an empty argument list returns the author
contract. The same query path is available to an ordinary Surface extension; no private filesystem
access is needed to view the result.

## Delivery and lifetime

The Host independently reads the existing committed Catalog log and routes only relevant facts.
Each pump is bounded by the source cursor already processed by the Host, so it cannot prefetch past
an unprocessed scope change. Context/branch publication immediately closes the old subscription
until its scope is resolved again. Each selected thread has its own pump. A slow/crashed extension can stall its own cursor; it cannot
hold the Run producer, original tool receipt, Host control loop or a different broker worker. Threads
using the same extension worker intentionally share that worker's failure boundary.

The Catalog validates that a delivery cursor belongs to the subscription's thread and records the
existing `selected -> sent -> committed` states. The worker atomically updates its projection and
cursor using ordinary extension storage before returning an exact subscription/cursor/invocation
acknowledgement. A lost acknowledgement replays the same fact; `(subscriptionId, fact.cursor)`
deduplication prevents applying it twice after worker/Host restart. This is at-least-once delivery,
not an exactly-once claim about arbitrary external effects. Projection storage must be preserved
alongside the extension; deleting it is not a request to replay already committed deliveries.

Normal provider replacement can finish an already pinned invocation and changes the binding for the
next fact. Explicit revocation or selection/scope removal cancels the subscription and rejects a late
acknowledgement. Exact acknowledgement validation plus a valid original pin is the Host admission
point; subsequent Catalog persistence records that already accepted fact, even if revocation follows.
Host shutdown releases subscriptions without waiting for worker callbacks. Kernel exit cancels old
subscriptions/acknowledgements but retains the Host listeners and selection intent. A successful kernel
handshake (or its first runtime frame) triggers a fresh committed-head read and uncommitted backlog replay;
exit alone never starts a restart/poll loop. Failures are reported; the next
relevant fact/provider change or Host restart resumes uncommitted facts, with no timer polling.

The reducer must be pure and only compute derived projection data. Business actions need a new
explicitly authorized command with observer provenance and an idempotency key; they must never be
hidden in the original tool success path. This projection-only API deliberately does not submit them.
