# @varin/application-client

Framework-neutral Varin application client boundary.

## Purpose

This package owns the `RuntimeAPIs` aggregate interface and the API interfaces (Terminal, Git,
Files, Documents, Settings, Permissions, Notifications, Extensions, Language, LanguageSupport, Tasks, Debug, Tests,
etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
`LanguageSupportError`, `RunServicesError`, `WorkspaceSearchError`), pure DTO types (`WorktreeMetadata`,
`DraftStarterRef`, `FileEditorSettingsPatch`, `ThreadResultHistory`), and the single desktop IPC contract (`desktop.ts`).

`AgentProfilesAPI` edits Pi or Agent profiles through the authenticated Host, without selecting a
conversation runtime or creating a Pi Session. Read projections separate shared fields from the selected
runtime's default, explicit or unconfigured tools. Save uses the original settings revision: omitted tools
preserve the choice, `[]` selects no tools, and `null` resets that runtime. Deleting a custom profile removes
it for both runtimes. `AgentProfilesError` retains the Host's safe failure code/message. Host changes and
aborted reads cannot publish a stale settings view; accepted tasks retain their original frozen profile.

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
`process_stopped`/`job_stopped` operation, original-source file condition, research `artifact`/`collection`,
original-job `log_literal`/`log_end`, original-machine `metric`, or flat `any`/`all` combination. Register retains a stable key and
exact source Run/trigger/body for uncertain retries. `list` exposes short lifecycle metadata, while
abortable `get` reads the original instruction and `registration_trigger` (including literal text).
Control uses the displayed revision. Triggering, input binding and actual history delivery are distinct:
a bound but undelivered occurrence can still be paused/cancelled without cancelling its shared Run or
process. Agent-only optional waiting is not part of this User API. Independently registered followups
retain their explicit actor even under a Goal; automatic Goal-owned definitions use Goal controls.

`repeat: 'each'` explicitly authorizes the same instruction on each accepted file-change, research
metadata edge, log-literal match or known metric crossing; omitted `repeat` means once. Repeated Any consumes finite leaves once; repeated All pairs FIFO changes from
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

`metric` selects a real `machineId`, CPU/memory dimension or stable `gpuUuid`, strict `above`/`below`
and a finite threshold. Memory dimensions use MiB; percentage dimensions use percent. Machine/GPU choices come from the existing `research.resources` API for the
original source Run, not a second directory or permission list. The UI sends UUIDs while displaying
ordinals/names. Local sampling follows active definitions without an open panel; remote sampling is
currently unsupported. Initial known satisfaction fires once; Each requires known false-to-true.
Missing, stale or unread values stay unknown and do not rearm a previously satisfied condition.
Short metric state and occurrence evidence retain original revision, value, time, identity and gap.
Historical gaps are visible; overwritten unobserved crossings cannot be replayed. Uncertain retries
keep the exact original key/source/selector, and late directory reads cannot switch Host/Thread/Run.

`log_literal` selects stdout or stderr and matches exact UTF-8 literal bytes, preserving whitespace
and case. An omitted `fromOffset` starts at byte 0, including already published output; a future offset
waits for new output. Each includes overlapping matches; Once observes the first. `log_end` is a finite
single fact for one stream, independent of artifact collection. It can join repeated Any alongside a
repeatable source; repeated All requires every source to repeat. Empty literals are invalid.
Short sources expose only the stream, offset and literal byte length; source `log` state exposes cursor,
end and short failure status. `exhausted` is the Catalog's projection of whether the original source
queues can produce another occurrence; consumers do not infer it from individual leaves. Exhaustion
without a match has no occurrence, and an Agent observation can finish as `exhausted`. The original
observation owner derives `delivery_pending`: an undelivered observation on a terminal Run has no
further delivery obligation. Consumers distinguish it from a live observation awaiting history delivery.
Original literals
are read only on explicit detail expansion. Occurrence evidence freezes the matched byte range or stream end, publication high-water and original Job/attempt
revisions; log text is not copied into list or occurrence metadata reads. Pause/resume keep the cursor,
and cancelling the observation never cancels its accepted Job.

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

`ThreadsAPI.mediaRead` reads typed bytes through an original history/input/Operation/event,
policy-evidence, family or child-report holder. The expected content reference is an equality check,
not permission to read any content hash. `readThreadMedia` assembles the original chunks, validates
identity/ranges, and aborts on Host change without keeping a persistent byte cache. Semantic history
and family pages contain StoredMedia descriptors; ordinary output `data` is never scanned for images.

`collaboration.readReport` and `readExecutionReport` return the exact operation/execution/history
identity plus `format: text | output_body`. An output-body page is a UTF-8 JSON fragment; assemble
its original complete range before parsing `OutputBody<StoredMedia>`. Media uses that same child
report holder and exact execution ID, including later Runs. Both report readers accept AbortSignal;
cancelling a read does not cancel the child or alter its report.

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

`ThreadsAPI.listMcpInteractions` returns compact `McpInteractionItem` pages; exact read/respond adds
the complete original evidence. A tagged `server_request` retains reviewed response delivery, while
`rpc_error` URL cards have null delivery and record only local choices. Natural Run failure or a
closed completion watcher does not remove the user's ability to review that retained error. The
shared panel fetches full JSON on demand; neither local choice nor explicit external navigation
retries the old RPC or resumes its Run. Public identity checks remain the original Thread/branch path.

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

## Agent profile settings

`AgentProfilesAPI` reads and revision-checks updates to the original user Agent profile settings for
an explicit `pi` or `agent` runtime. The Host returns editable shared configuration separately from
runtime tool selection (`default`, `explicit`, or `unconfigured`) and the actual Agent capability
directory. Pi's directory is `null`, not an observed empty list. Raw persisted tool-selection unions
never enter these DTOs. Save omits tools to preserve them, sends `[]` for no tools, or `null` to reset
only the selected runtime. Creation requires a custom config with an empty key and explicit tools;
the Host allocates its identity. Removing a custom profile removes its shared definition for both
runtimes. The HTTP client preserves the Host's safe failure code and message and rejects late
responses after Host changes or cancellation. No operation changes the conversation runtime.

## Typed output media

`ThreadsAPI.mediaRead` reads one byte chunk through its original history item, queued-input revision,
Operation completion/result/external receipt, policy evidence, or fixed family-view holder. The caller's
Thread identity stays separate from a family target. `expectedContentRef` checks the image displayed by
that holder; it never authorizes a bare content-object read. Requests use the existing authenticated Host
transport and AbortSignal/endpoint-generation checks.

`readThreadMedia` captures that exact selection, reads its chunks, verifies the media/source identity,
ordinal, chunk sequence/count, byte total and base64, and returns ephemeral bytes. It owns no cache,
content service or permissions. It rejects cancellation and Host replacement before publishing bytes.
Stored `OutputBody.parts` retain text/media order; `data` remains opaque, including media-looking JSON.
Operation results have explicit `control.value` and `output.output` variants. For input edits, omitted
images preserve original accepted media, `[]` removes it, and newly uploaded inline images replace it;
public StoredMedia hashes cannot be submitted as replacement-image authority.

Child report reads return `ChildReportPage` with an original-owner `format` of `text` or `output_body`.
`text` contains the requested UTF-8 byte page, including when its content is the Stored OutputBody JSON;
callers cannot choose or reinterpret that format. Both original-dispatch and explicit-execution readers
accept AbortSignal. Report media uses the `child_report` holder with its original dispatch, returned
execution identity and report item; it never borrows a latest Run or a family-view anchor.
