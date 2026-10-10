# Scheduled Tasks module

Project-owned calendar assets, per-definition execution owners, Markdown loops and authenticated HTTP routes.

## Ownership

- GUI definitions live in the project config owned by `../projects/project-config.ts`. A definition explicitly selects `runtime: "agent"`; absent or `"pi"` keeps the existing Pi owner. Native state is never persisted into `lastStatus`, `nextRunAt` or a synthetic Pi session ID.
- A loop definition lives in its `.agents/loops/*.md` file. Its JSON row is an external asset projection; Pi-only execution fields remain with the Pi scheduler. Native definition generations, actual UTC slots and occurrences belong to Catalog; prompt bodies belong to ContentStore.
- Pi sessions, model selection, thinking, goals, commands, and prompts are executed through `pi-executor.ts`; this module has no OpenCode runtime owner or compatibility route.

## Agent calendar

`calendar-owner.ts` reads canonical assets, supplies pure `recurrence.ts` arithmetic and prepares a
cold occurrence through the original ThreadAdapter/source/model/context owners. It has no timer or
execution queue. Catalog's existing native deadline worker durably accepts the actual occurrence;
`catalog_ingress` / `catalog_activation` deliver its Environment input through the original Run or
child execution owner. A new-work occurrence creates a genuine Thread first, then admits its Run,
source, context and optional initial Goal together. Existing-work targets use the actual admitted
project scope, current model/source, Goal controls and child fixed-result lifecycle.

The GUI's **Agent calendar** editor and shared `ScheduledTasksAPI` support once/daily/weekly/cron,
explicit IANA timezone and `skip` / `coalesce_once` missed policy. Defaults are once catch-up once
and recurring offline skip. A late online wake keeps its observed slot until the following actual
slot has been crossed, rather than applying the Pi five-second slack. Slots are actual UTC instants;
An ambiguous once wall time selects its earliest actual UTC instant consistently. DST folds retain each real daily/weekly occurrence, and a backward clock cannot rewind the native
cursor. The existing cron parser owns cron arithmetic; hashed `H` fields use one stable definition/generation seed for every direction and restart. Dates outside the native timer's signed-i64
nanosecond range fail explicitly, per definition, without stopping other calendars.

New work selects registered `providerId` / `modelId`, optional thinking/temperature, source mode
(`fixed_branch`, `materialized`, `live_root`) and an explicit nullable Goal budget. Existing work
selects only its exact `threadId` / `branchId`; it cannot replace that work's authority or model.
A stable Run-now key returns **an accepted occurrence**, not execution success. Its actual Run/Goal
facts drive status and non-overlap; paused/waiting/budget-blocked Goals remain active. The shared UI
opens the real ThreadConversation for execution controls and results. Finished occurrences move to
history. Disabling holds undelivered scheduled occurrences, but explicit Run-now remains available.
Deleting or semantically replacing a definition cancels unconsumed old occurrences, retaining
already-produced work and results. Stopping current work cancels then-accepted related input but
does not disable the standing recurring definition.

After restart, pending occurrences require successful current asset synchronization before new
activation. Same-definition synchronization does not reset generation, cursor or a consumed once
slot. Invalid project/config reads fail rather than become an empty authoritative scan. Independent healthy projects still synchronize and recover, with failed projects reported separately. A malformed
native Markdown file retains its last-good definition with `asset_invalid` hold until repaired.
Owner changes wait for actual previous-runtime work to settle: native has a temporary
`previous_runtime_active` hold, and Pi checks retained original native Run/Goal facts even after the
native definition is removed. Same once intent also retains a managed `onceAcceptance` handoff. Changing its executor does not
replay an already accepted slot, even after the old owner has stopped. A Pi acceptance derives from
its original accepted `lastRunAt`; this never asserts success or reconstructs an old ambiguous DST
offset. The native consumed slot uses its explicit deterministic rule. Agent-to-Pi handoff first
stores the original definition/generation pointer in the asset, then tombstones native acceptance,
reads the final original occurrence and persists the short acceptance fact before Pi can start. This
closes acceptance between the initial read and tombstone and survives a Host crash in between.
Caller JSON/Markdown cannot forge these managed fields. Changing the actual instruction/rule or
same-owner execution selection clears the carried fact. Explicit Run-now remains independent.
Late Pi session/terminal callbacks update only their original accepted asset intent under the same
file lock; they cannot disable a new native definition or overwrite a replacement's status.
No separate cross-runtime execution ledger is created.

An ordinary SDK example is [Project Calendar Tasks](../../../../../examples/extensions/scheduled-task-tool/README.md).
Its broker calls `tasks.schedules` through the original retained tool invocation, permission and
call-scoped source. It derives the configured project from that admitted source. Original
ModelStep/PolicyAction identity determines Run-now keys. A completed asset write whose subsequent
publication response is lost remains Unknown; it is not silently replayed or declared no-effect.

## Markdown loops

Varin discovers `~/.agents/loops/*.md` and project `.agents/loops/*.md` from the selected directory upward to its Git worktree root. The nearest project definition wins, then farther project ancestors, then the user definition.

```markdown
---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: openai-codex/gpt-5.3-codex
thinking: high
agent: reviewer
timezone: Asia/Shanghai
run_as_goal: true
goal_token_budget: 25000
---
Summarize repository changes since yesterday.
```

`name`, `schedule`, `model`, and the body are required. `enabled` defaults to `false`: merely pulling repository content must not start unattended model runs. `thinking`, `agent`, `run_as_goal`, and `goal_token_budget` map to Pi concepts. OpenCode permission and variant fields are not accepted or synthesized.

Native loops explicitly select their owner and current authority, for example:

```markdown
---
name: project-review
runtime: agent
schedule: "0 9 * * 1-5"
timezone: Asia/Singapore
enabled: false
missed_policy: skip
target:
  kind: new_work
  model: { providerId: configured-provider, modelId: configured-model }
  sourceMode: fixed_branch
  goal: null
---
Review the saved project source and report the actual result.
```

For an existing target, use `target: { kind: existing_work, threadId: "thread:…", branchId: "branch:…" }`.
Native model/source/Goal fields belong in `target`; legacy Pi `model`, `thinking`, `agent`,
`run_as_goal` and `goal_token_budget` are not native profile authority. Newly discovered loops default
to disabled. The registered provider/model IDs in the example must be replaced by actual selections.

Loop identity is the canonical file path, not its name. A same-named GUI task remains a separate JSON-owned task. Renaming a loop changes the existing loop task in place. A malformed file keeps the last good projection and exposes its parse error; removing the file removes only that projection. Higher-precedence malformed files continue to shadow lower definitions, preventing duplicate execution during an edit or merge conflict.

The list route reconciles disk files before returning tasks, and the runtime watches every discovered `.agents/loops` directory (project ancestors plus the user scope) — a Markdown edit, creation, or deletion triggers a debounced resync without anyone opening the task list. Varin writers serialize the loop revision check with update/delete in one process, so two Agent/UI operations using the same stale revision cannot both succeed. The filesystem has no cross-process compare-and-swap primitive; an unrelated external editor is still checked immediately before atomic rename/unlink but is not claimed as globally locked. Unknown frontmatter keys are preserved by enabled toggles. Runtime state is never written into Markdown.

## Routes

- `GET|PUT|DELETE /api/projects/:projectId/scheduled-tasks`
- `GET|PUT|PATCH|DELETE /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
- `POST /api/projects/:projectId/scheduled-tasks/:taskId/run` (native requires stable `key`)
- `POST /api/projects/:projectId/scheduled-tasks/:taskId/occurrences/:occurrenceId/control` (original revision; cancel/retry)
- `POST /api/projects/:projectId/scheduled-tasks/:taskId/calculation/retry` (original definition revision)
- `GET /api/varin/scheduled-tasks/status`
- `GET /api/varin/events`

## Pi completion tracking and follow-ups (D-307)

`pi-executor.ts` no longer treats `agent.prompt` acceptance as success. A session-settle tracker
(`session-settle.ts`) is registered before dispatch and observes `agent_start`, `agent_end`,
`agent_settled`, `session.closed`, and `worker.exit`; the run reports success only after the real
session settles. Goal runs keep the scheduler identity across successive settled turns until the actual final goal status — `complete` succeeds,
`blocked`/`budgetLimited` fail, `paused` with reason `waiting` is an intentional follow-up wait, and
any other terminal or lost state fails. Failures retain `sessionID` for traceability without writing
`lastSessionId`. The session identity is persisted as soon as it is created, so an interrupted run keeps a
traceable session pointer. There is no wall-clock watchdog that releases a task while its Pi session is still running;
shutdown stops timers/watchers before their dependencies, and the loop watcher observes the nearest existing
ancestor so creating `.agents/loops` for the first time is discovered.

## Pi restart recovery

On each `syncProject` (startup and every resync) the runtime reconciles persisted state it cannot own:
a task whose `lastStatus` is `running` while nothing is in flight for it is marked `error` ("run interrupted")
instead of pretending the dead session still runs, and its next slot is recomputed. Missed-time policy is
explicit: a `once` task whose due time passed while the host was down catches up exactly once
(`lastRunAt >= dueAt` suppresses repeats, including after a failed run), while recurring kinds skip missed
slots and keep their freshly computed `nextRunAt`. Queue/running keys dedupe catch-up against in-flight runs.

## Pi harness management (D-307)

Agents manage the same authority through `schedule.*` harness methods and the pi-host `scheduled_task` tool
(gated on the `harnessScheduledTasks` handshake capability). The caller's workspace resolves to the
configured project — an agent cannot manage an arbitrary projectId. Loop reads/writes/enables/removes pass
the Markdown content revision through as a CAS guard; `schedule.run` waits for the real session settle, so
the tool uses the harness maximum request timeout and a longer-running task reports timeout while its true
terminal state lands in `state`. Manual run-now uses the same global/project admission queue and may run a disabled task; disabling controls future calendar fires, not an explicit invocation. `schedule.status` is scoped to the caller's project, while the existing desktop status route retains its global quit-risk view.

Native follow-ups are implemented under [Stage W / D-307](../../../../../docs/design/agent-follow-up-design.md):
the `follow_up` tool, the durable follow-up service, and session-level waiting UI reuse the existing
Thread/Run lifecycle, kernel records, and broker admission. Calendar/Markdown tasks retain their external definition owner. Pi loops create new sessions; Agent
calendars explicitly select new or existing work. The same asset ID never grants both execution owners.
