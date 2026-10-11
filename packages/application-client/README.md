# @varin/application-client

Framework-neutral Varin application client boundary.

## Purpose

This package owns the `RuntimeAPIs` aggregate interface and the API interfaces (Terminal, Git,
Files, Documents, Settings, Permissions, Notifications, Extensions, Language, LanguageSupport, Tasks, Debug, Tests,
etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
`LanguageSupportError`, `RunServicesError`, `WorkspaceSearchError`), pure DTO types (`WorktreeMetadata`,
`DraftStarterRef`, `FileEditorSettingsPatch`, `ThreadResultHistory`), and the single desktop IPC contract (`desktop.ts`).

`thread-history.ts` describes the user-only Thread history list and release response. The Host owns
selection validation and object cleanup; the UI sends a frozen branch/revision selection. Logical bytes
referenced by a version and bytes actually removed by cleanup are distinct fields. These DTOs do not
add an Agent tool or a second state store.

`ThreadsAPI.resume(runId, waitId)` explicitly consumes the displayed policy Pause and returns its
durable receipt. Retrying the same command preserves that receipt and cannot resume a later Pause.
`retryPreparation(runId)` is a separate launch-preparation retry; queueing input is not a resume
command. The UI reads derived `LaunchIntent.startable`/`pause` projections rather than guessing
eligibility from a waiting Run or a Wait ID prefix.

`ThreadsAPI.inspectTools(identity, runId)` queries the authenticated Host for the Run's activated
tool directory, selected provider identities, and per-service preparation state. An extension still
preparing is not callable. Revoked providers are unavailable immediately; a normally retiring provider
can remain callable through its original Run pin. Listing a callable tool does not grant permission:
each actual invocation is authorized against its original operation and current permission policy.

`ThreadsAPI.inspectPolicy` and `ThreadSnapshot.policySelection` separate the committed strategy
generation and desired update from the current Host's preparation status. Preparation is not activation.
`restartPolicy(identity, runId, selectionId)` explicitly restarts only that displayed candidate's private
checkpoint at a closed decision boundary; the candidate ID and active generation are rechecked by
Catalog. Conversation history and independent tasks remain intact. `cancelPolicyUpdate` cancels that
unpublished candidate, not the Run. Neither operation resumes an explicit Pause.

`ThreadsAPI.goals` starts an explicitly authorized continuing objective, updates its objective/budget,
and applies revision-checked pause/resume/complete/cancel controls. Writes return short admission
receipts; `list` and `ThreadSnapshot.goals` contain separately read current usage and objective views.
An uncertain creation retry keeps its original key and input. Update/control conflicts require reading
the current revision before a new explicit action. Ordinary message submission and conversation fork
are not Goal creation commands. Goal-owned followups are controlled through their Goal.

`ThreadsAPI.followups` registers one explicit instruction for an absolute `at` instant, accepted
`process_stopped`/`job_stopped` operation, original-source file condition, research `artifact`/`collection`, or flat `any`/`all` combination. Register retains a stable key and exact source Run/trigger/body for uncertain
retries. `list` exposes short lifecycle metadata, while abortable `get` reads the original instruction.
Control uses the displayed revision. Triggering, input binding and actual history delivery are distinct:
a bound but undelivered occurrence can still be paused/cancelled without cancelling its shared Run or
process. Agent-only optional waiting is not part of this User API. Independently registered followups
retain their explicit actor even under a Goal; automatic Goal-owned definitions use Goal controls.

`repeat: 'each'` explicitly authorizes the same instruction on each accepted file-change or research metadata edge; omitted
`repeat` means once. Repeated Any consumes finite leaves once; repeated All pairs FIFO changes from
every repeatable leaf. The definition retains its observer after delivery. Pause holds accepted work;
Cancel withdraws future and undelivered occurrences, without changing delivered Runs or results.
`pending_occurrences` and latest `.occurrence` are compact projections. Abortable
`followups.occurrences(identity, followupId, after?)` pages original occurrences in accepted-cursor
order and returns `nextCursor`; source `trigger_cursor` has a different meaning. The GUI retains
continuous controls, explicit retry of undelivered work and a refreshable history page. Run navigation
reuses the original read-only `family` reader with the exact delivered Run, not another execution target.

Abortable `followups.occurrence(identity, followupId, occurrenceId)` reads one exact occurrence and
the original metadata accepted for its source facts. The GUI loads details on demand, checks their
occurrence/source cursors and discards late replies after identity or selection changes. Bodies are
shown as data, never executed markup or another trigger. The short history list does not fetch them.
These are historical metadata, not a new immutable artifact-byte snapshot; original artifact reads
remain current-domain operations with their own authority and availability.
`artifact` accepts an optional `artifactId` or `name`, not both; no selector means any original artifact.
`collection` explicitly observes the original collection completion, including empty or failed results.
An explicit Any observes both. Failed collection absence, missing in a completed snapshot, pending
metadata and a zero-byte available artifact retain different meanings.

`followups.jobSources(identity, runId)` discovers original accepted domain Jobs in the actual task
family, including independent User, historical and child/sibling work absent from the current history
page. It returns short binding/origin/lifecycle metadata and accepts AbortSignal. The selected Run must
belong to the selected Thread/branch; a target Job's `sourceRunId` remains attribution, never the
follow-up execution source. A Job's executor stop is separate from artifact collection and unknown
business outcomes. The UI retains the original selected Run/key/trigger when retrying an uncertain
registration and discards stale Host/selection responses. Required `observationKinds` comes from the
original owner and determines the UI's available source kinds without a second domain support table.

`ThreadsAPI.family` reads the original task family without selecting another execution target.
The caller `ThreadIdentity` is separate from the target request. `list` discovers actual related
Threads, `runs` lists direct and inherited historical Run owners, `read` uses fixed recent/range/search
pages, and `item` expands the original semantic JSON in byte pages. These methods accept AbortSignal;
Host/caller/target changes must discard old views. Anchors survive append/fork/rollback but expire with
the runtime owner epoch. An empty scan page can still have a continuation cursor. Partial JSON is not
a complete tool exchange. This API contains no target launch, source preparation or control method.

`ThreadsAPI.research` projects the original experiment, source and resource owners for an actual
Agent `ThreadIdentity`. `scopes` lists retained source Runs, including earlier branches; callers
select an explicit `sourceRunId` for every domain request. `canSubmit` is separate from historical
read/control access. The Host derives workspace, family and actor authority; these are not renderer
arguments. Attempts carry the current caller's control permission. Logs and binary artifacts retain
the original attempt, stream/artifact and byte offsets, and reads accept AbortSignal.

Research `submit` requires a stable User request ID and exact intent. An uncertain response must
retry that same pair. It admits an independent User command and original domain attempt without
starting the historical source Run. `cancel` requests the original job's stop; closing a reader does
not cancel a job. Collection remains a separate domain action. These APIs do not own a second
experiment store or switch the Research workbench's default runtime.

The desktop contract defines:

- `VarinDesktopCommandMap` — typed `{ args, result }` for all 58 `desktop_*` commands
- `VarinDesktopBridge` — the typed bridge interface implemented by Electron preload and consumed by the UI
- `PreloadBootstrapPayload` — discriminated union carrying credentials only for local pages
- `VarinDesktopEventMap` — typed desktop events (update progress, SSH status, menu actions, etc.)
- exhaustive command/event catalogs and runtime guards, plus `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS`

It has no React, Zustand, or UI component dependencies. It depends only on `@varin/protocol` and
`@varin/extension-contract`.

## Consumers

- `packages/web` — Web/remote surface API implementations
- `packages/ui` — shared React presentation and client-side kernels
- `packages/electron` — Electron main/preload import the focused `@varin/application-client/desktop`
  subpath so bundling the native bridge does not pull in unrelated HTTP/relay transport modules

All three product consumers import contracts and transport primitives directly from
`@varin/application-client`; the former UI forwarding modules have been removed. Relay is injected
through `registerRelayTunnelProvider` and `registerRelayTunnelLifecycle`, so this package never imports
the UI tunnel implementation. Selecting Relay without a registered lifecycle fails explicitly.

## URL-auth mint lifetime

`transport/runtime-auth.ts` owns the shared in-flight URL-token mint, including its 10-second
deadline across credential lookup, HTTP/relay fetch and response-body parsing. Concurrent consumers
share that operation; a stalled mint must release its shared promise so a later connection can retry
without restarting the application. Fetch receives the owner's abort signal and late completion is
checked before token publication, even when a transport ignores cancellation. Runtime/origin generation
checks still prevent an old authority from overwriting a new token. Token values are never logged.

The UI connection candidate separately bounds authentication, socket open and handshake as one startup
attempt. A startup timeout means no agent input was dispatched by that candidate; a timeout after a
prompt was sent has different, ambiguous execution semantics. `test/runtime-auth-timeout.test.ts`
exercises a stalled response body, concurrent mint sharing, retry and late-publication rejection.

## Task-family message contract

`ThreadsAPI.messages` exposes immutable `inform`/`request` acceptance and original incoming/outgoing message
views. The caller supplies its `ThreadIdentity` separately from the peer request. The trusted Host
sets User identity; clients cannot choose Agent actor/sender fields. `replyTo` addresses the exact
original peer without guessing its current branch. A send receipt confirms acceptance, while message
views separately report the actual history delivery Run/cursor and request activation. A bound Run
is not proof that it completed the requested work. Pending holds and failed/cancelled activation keep
the original message readable; message views never become another execution owner.

Read calls accept AbortSignal and all calls keep the existing runtime endpoint-generation checks.
A lost send response must be retried with the same original key and intent. Aborting the transport or
closing a UI does not retract a message already accepted by the Catalog. A request can enter the
current Run or admit a new root/child execution through its existing owner. Manual pauses, unanswered
questions and Goal limits remain effective. Receipt `acceptedAtMs` is the original committed time.
A nullable `replyWait` view reports an Agent's original observation, exact Operation/Run, absolute
deadline, winning reply/expiry/cancellation and actual lifecycle-history delivery. These are projections,
not client timers or execution state. User sends have no observation owner and do not accept `wait`.
The UI can end its own Agent observation through the existing Operation control; this never withdraws
the original message, changes a won result or hides a late linked reply.

## Delegated execution continuation

`ThreadsAPI.collaboration.continueChild` submits an explicit User continuation on the original child
Thread/branch with a stable key, exact previous Run and expected head. It returns durable execution
acceptance, which may precede source preparation and Run creation. Retry an uncertain response with
the original intent; do not select a later Run or new key automatically. Configuration and source are
derived by the owning runtime, not supplied by this API.

`ThreadSnapshot.delegatedExecutions` and `collaboration.executions` expose each execution separately.
`readExecutionReport` reads the specified execution's original report item; the returned execution
and item identities must match the request. Parent access retains the existing same-Thread historical-fork read scope, while the
child snapshot lists only its own original execution branch; reading does not grant continuation or control. All reads accept AbortSignal and preserve endpoint-generation
checks. The original ChildTask and `readReport` remain the dispatch-round view; they never silently
switch to the latest continuation. Active child boundary/interrupt input uses the ordinary queue;
its next Run must use the dedicated continuation admission.

## History

This package was extracted from the former UI-owned API and transport modules to clarify the boundary
between framework-neutral client behavior and React presentation.
