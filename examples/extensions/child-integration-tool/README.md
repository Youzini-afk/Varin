# Fixed child result integration tool

This ordinary brokered extension contributes `integrate_child` through the existing `provideTool`
contract. Its single service declaration owns discovery, model metadata and invocation schemas.
Build `host.ts` as bundled CommonJS `host.cjs` with the SDK, then install the directory through the
normal extension catalog and review its `collaboration.integrations` Host capability grant.

The caller supplies `childOperationId` and the exact `publicationId` from a published child code
result. The Host derives the real parent Run, Thread, branch and source from the permission-admitted
invocation. A later Run of the same parent Thread/branch can consume that fixed publication.
A fixed read-only parent source has no implicit workspace writeback target.

Integration uses the original WorkingResult, three-way merge, Documents version checks and durable
file journal. `files-only` coverage includes file and Document content recovery; it does not mean
bypassing dirty editor buffers, and does not include Pi conversation-history rollback. A conflict may
coexist with successfully applied paths. Inspect the original `effect`, receipt and affected paths.
Cancellation or a lost response is not proof that an already-dispatched change had no effect.

The extension cannot supply its own execution/effect authority. Its actual Host domain promise stays
attached to the existing tool invocation even if the broker callback returns early. Recovery reads
the original journal and never reruns this callback to infer the result.
