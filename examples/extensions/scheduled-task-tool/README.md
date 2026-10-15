# Project calendar tool

This ordinary brokered extension exposes `scheduled_task` through `provideTool` and the
`tasks.schedules` Host capability. Build `host.ts` as bundled CommonJS `host.cjs` with the SDK,
then install through the existing extension catalog and review the capability grant.
There is no special kernel callback or second asset writer.

The Host derives the project from the permission-admitted invocation's real workspace source.
The extension cannot supply a project path, credentials, origin or Run authority. Model and
policy calls use the same invocation, effect receipt and original project/Markdown service.
Project scheduling requires an admitted project Source. A managed Source routes to its owning
Host through `createManagedScheduleOwner`; the target validates the original Source and current
whole-project permission, then uses the same project/Markdown owner and original operation receipt.
An unavailable target does not fall back to a same-named local project.
A new GUI definition without an ID derives a stable ID from its original operation; manual
run-now uses that same original operation identity for an uncertain retry.

An Agent definition uses `runtime: "agent"`, `execution: { "prompt": "..." }`, an explicit IANA
timezone, a schedule, and a `target`. New work selects `kind: "new_work"`, a registered
`model: { providerId, modelId, thinkingLevel? }`, `sourceMode` (`fixed_branch`, `materialized`,
or `live_root`), and `goal: null` or `{ budget: null | { maxOutputTokens } }`. Existing work
uses `{ kind: "existing_work", threadId, branchId }` and retains that work's actual selection.
`missedPolicy` is `skip` or `coalesce_once`; defaults preserve one overdue once occurrence
and skip unobserved recurring slots. Definitions retain explicit native Thread targets and model
selections; historical session targets are not imported.

Run-now returns the accepted occurrence identity, not execution success. Inspect the original
Thread/Run/Goal for progress and results. Disabling holds scheduled unconsumed work; cancelling
one occurrence does not disable later slots. Definition deletion revokes unconsumed work while
keeping actual results. Stopping a current Run does not disable a standing calendar definition.
Loop updates/removal carry the original Markdown revision. An uncertain asset mutation remains
unknown rather than being silently replayed or described as no-effect.
