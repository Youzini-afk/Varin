# Development roadmap

Status: forward-looking work map — not a second delivery ledger or a release schedule.
Last updated: 2026-10-06

[Current status](status.md) describes what is implemented. This page lists the remaining directions
and the contracts to use when choosing work. Existing phase names are retained for traceability;
no dates or new implementation commitments are introduced here.

## Remaining directions

| Direction | Work that remains | Starting point |
| --- | --- | --- |
| Composable execution environments | Complete ordinary-session environment selection, environment-aware resource access, cross-machine service reachability, scoped cancellation and versioned environment recipes | [Execution-environment contract](design/execution-environment-design.md), [acceptance gaps](reviews/execution-environments.md#剩余产品缺口与原生验证) |
| Computer Use and persistent computers | Finish missing native platform components; validate real desktop, guest creation, handoff and installation/upgrade flows | [BC implementation plan](plan/bot-computer-use-plan.md), [current acceptance](reviews/bot-computer-use.md) |
| Research execution and resources | Close the remaining D-300 resource-management and remote-execution contracts without treating existing local/managed-remote slices as complete cluster support | [Research design](design/research-cluster-design.md), [Harness work map](plan/agent-harness-plan.md) |
| Runtime and deployment reliability | Complete RR6 packaged-session and external-proxy scenarios against the current task/resource model | [RR plan](plan/agent-runtime-reliability-plan.md), [status](status.md#尚待补充的运行证据) |
| Office and daily-work continuity | Implement the accepted O0–O4 materials-to-editable-deliverable and follow-up workflow using existing document, artifact and task owners | [Office design](design/office-work-continuity-design.md) |
| Workbench experience | Review the proposed layout/typography/interaction changes before implementation; keep future motion work distinct from the existing transition system | [Experience candidate](design/varin-product-experience.md), [motion design](design/varin-motion-platform.md) |

## Dependencies and boundaries

Execution-environment and Computer Use work share Host, resource, desktop and lifecycle foundations.
Their existing reviews distinguish missing product behavior from missing native evidence; addressing
one does not automatically close the other. Office continuity can reuse those foundations but remains
its own unimplemented product contract.

Research work reuses ordinary Thread/Run, messages, retrieval and execution authorities. Slurm and other
native cluster adapters remain deferred until an actual deployment requires them. The current runtime
stays on the stable Pi SDK; the [durable-runtime assessment](reviews/pi-durable-runtime.md) is evaluation
material, not a scheduled migration.

Explore, Web/scholarly search, compaction and ordinary collaboration already have production paths.
Further quality, latency and usability work begins from a concrete observation and its owning module,
not by restarting the old F/C/L or D-339 implementation phases. The [performance record](performance.md)
separates measured critical paths from unmeasured provider effects.

## Where execution work lives

[Plan navigation](plan/README.md) identifies active contracts and their review owners. A plan describes
scope, ordering and completion conditions. A review records the baseline, scenarios and results. The
status page links those records without maintaining another copy of their detailed findings.

## Historical phases

The old completed-phase ledger and migration narrative are no longer mixed with future directions.
Use the [Harness stage map](plan/agent-harness-plan.md) for R/Q/S/W/B/F/C/L/N and
[roadmap history](archive/roadmap-history.md) for Phase 0–10 and retired prototypes.
[Decision volumes](decisions/README.md) retain the reasons behind changes and superseding decisions.
