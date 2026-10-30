# Scheduled Tasks module

Project-owned calendar assets, Markdown loops and authenticated HTTP routes. Calendar is the
only execution owner; the Host supplies asset discovery and cancellable preparation.

## Ownership

- GUI definitions live in the project config owned by `../projects/project-config.ts`.
  Persisted definitions require `runtime: "agent"` and a native target. Fresh GUI requests may
  omit the runtime tag. Unsupported or malformed existing stores fail without rewriting files.
- A loop definition lives in its `.agents/loops/*.md` file. The JSON row is an asset projection.
  File writes use the original revision/CAS and atomic replacement; discovery never rewrites Markdown.
- `runtime.ts` discovers project and user loops, watches their directories, and serializes each
  project's asset synchronization. Its debounce only refreshes files. It has no execution timer,
  queue, executor or parallel task-status writer.
- `calendar-owner.ts` projects valid definitions and prepares cold occurrences through the original
  ThreadAdapter/source/model/context owners. Native generations, UTC slots and occurrences belong
  to Catalog; instruction bodies belong to ContentStore.

## Definition and execution

Bot home directories also participate in asset discovery with `bot:<id>` scope identities. The same
Calendar owner reads their definitions. The Bot workspace defaults a new GUI schedule to the Bot's
actual existing entry Thread/branch; no Bot timer, synthetic user message or second scheduler is used.
Project/Bot scope selection remains user-controlled while asynchronous discovery completes.

A definition supports once/daily/weekly/cron, an explicit IANA timezone and the `skip` or
`coalesce_once` missed policy. Once defaults to catch-up once; recurring calendars default to skip.
New work selects a registered `providerId`/`modelId`, optional thinking/temperature, a source mode
(`fixed_branch`, `materialized`, `live_root`) and an explicit nullable Goal budget. Existing work
selects only its exact `threadId`/`branchId`, inheriting that work's actual model/source/Goal.
The only execution field is `prompt`; model and source selections live in `target`.

`source: { kind: "project" }` uses the definition's local project. A workspace source stores the
registered `workspaceId` and exact `resourceOwner` returned by the shared source directory, including
managed Host, connection and endpoint identities. It never stores credentials or substitutes a path
for a missing registration. Source discovery and path resolution are authenticated and project-scoped,
do not create a Thread, and reuse the ordinary Thread source directory. An unavailable managed Host
keeps its saved selection; there is no local fallback.

Catalog's deadline worker accepts an occurrence durably. `catalog_ingress` and `catalog_activation`
deliver its Environment input through the original Run or child-execution owner. New-work occurrences
create genuine Threads before admitting their Run, source, context and optional initial Goal together.

## Recurrence and receipts

`recurrence.ts` calculates actual UTC slots, without timers or catch-up execution loops. An ambiguous
once wall time consistently selects its earliest actual UTC instant. Daily/weekly DST folds retain
each real occurrence. A backward clock cannot rewind the native cursor. Cron arithmetic belongs to
the cron parser; hashed fields use a stable definition/generation seed across restarts. Dates outside
the native timer's signed-i64 nanosecond range fail explicitly for that definition.

Run-now requires a stable request key and returns an accepted occurrence with actual Thread/branch
identity. Acceptance is not completion. Native Run/Goal facts determine status and non-overlap;
paused, waiting and budget-blocked Goals remain active. Occurrence cancel/retry and calculation retry
carry the original expected revision. The UI uses ThreadConversation for execution controls/results.

Disabling holds undelivered scheduled occurrences while explicit Run-now remains available. Deleting
or semantically replacing a definition cancels unconsumed old occurrences and retains already-produced
work/results. Cancelling an occurrence does not disable its standing recurring definition. Active work
from a deleted definition remains included in running status until the original owner settles it.

Same-definition synchronization does not reset the generation, cursor or consumed once slot. Native
once acceptance belongs solely to Catalog, with no external owner-handoff field or asset-state writer.
After a restart, new activation requires successful current asset synchronization.

## Failure and lifecycle boundaries

Invalid project/config reads never become empty authoritative scans. Each valid project can synchronize
independently, with failed projects reported separately. A malformed replacement of a known native
Markdown file retains its last-good definition with `asset_invalid` hold until repaired. A new invalid
or unsupported loop fails explicitly before a projection is written. Old Pi assets remain untouched
and unsupported; they are neither imported nor reactivated.

Listeners are installed before pending-work discovery. A held preparation cannot block independent
recurrence calculation. Epoch loss, occurrence removal and shutdown abort preparation observation;
they do not manufacture execution success/failure or release an original native owner. Original
Thread, process, tool, source and effect receipts retain their own stopping and cleanup responsibilities.

## Focused checks

- `calendar-owner.test.ts`: asset synchronization, run-now key forwarding, invalid assets, concurrent
  held preparation/calculation, cancellation observation and retained active work.
- `calendar-routes.test.ts`: authenticated public transport, occurrence CAS, Host replacement and sources.
- `recurrence.test.ts`: actual UTC slots, once catch-up, DST folds, backward clock and invalid deadlines.
- `loops.test.ts` and `../projects/project-config.test.ts`: native asset validation, revisioned file edits,
  discovery, unsupported-file preservation and last-good projection.
- Rust `catalog_calendar_tests` owns durable once/non-overlap/receipt state-machine evidence.
