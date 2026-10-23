# Shared UI

`@varin/ui` is the React presentation shared by Web, Electron, and mobile. It owns client-side
projections and workbench kernels, not privileged filesystem, credential, shell, or process work.
Surface packages provide `RuntimeAPIs`; shared code imports the contracts and transport primitives
from `@varin/application-client` without hardcoding origins, IPC channels, credentials, or local paths.

[Workbench and presentation](../../docs/workbench.md) explains the cross-feature invariants.
[Extensions](../../docs/extensions.md) explains contribution and service ownership.
[Runtime](../../docs/runtime.md) explains the native Thread/branch, Catalog and Application Host boundary.
Use these for architecture, then the local owner below for implementation changes.

## Module navigation

| Area | Owner and local reference |
| --- | --- |
| Official shells | `src/workbenches`: Agent, IDE, Research, Bot, and Settings composition |
| Extension integration | `src/lib/extensions`: catalog, loader, mounts, replacement/slot consumers, and owner-bound services |
| Profile handoff | `src/lib/workbench/profile-transition.ts` and `src/lib/extensions/workbench-shell-transition.ts` |
| Text state | [Document Registry](src/lib/documents/DOCUMENTATION.md) |
| Groups, tabs, providers, restore | [Editor Workbench Kernel](src/lib/workbench/editors/DOCUMENTATION.md) |
| Desktop/Web file editor | [Monaco](src/lib/monaco/DOCUMENTATION.md) |
| Mobile and embedded editors | [CodeMirror](src/lib/codemirror/DOCUMENTATION.md) |
| Agent/editor attachments and patch review | [Agent/editor bridge](src/lib/agent-editor/DOCUMENTATION.md) |
| HTTP, browser URLs, switching | [Application client](../application-client/README.md) |
| Shared projections and preferences | [Store ownership](src/stores/DOCUMENTATION.md) |
| Agent resource-panel navigation | [Context surfaces](src/lib/surfaces/DOCUMENTATION.md) |
| Settings primitives and save feedback | [Settings components](src/components/sections/shared/DOCUMENTATION.md) |
| Conversation controls | `src/components/thread`, `src/lib/agent-runtime`, and `ThreadsAPI` |
| Conversation presentation | `src/components/conversation`: virtual timeline, message/tool cards, selection menus, sidebar and transitions |
| Purpose-specific tools | `ChatDelegation`, `ChatResourceTools`, `ChatSourceTools`, `ChatProcessTool`, `ChatWorkTools`, `ChatMaterialsTool`, `ChatEnvironmentTools`, `ChatComputerTools`, `ChatFollowupTool`, `ChatMcpTool`; `toolInvocation` preserves gateway and native operation ownership |
| Interactive content | `src/lib/interactive-ui`, `src/components/interactive-ui`; [contract and lifecycle](../../docs/interactive-content.md) |
| Theme and shared chrome | `src/lib/theme`, `src/styles`, and `src/components/ui` |
| Icons | [Sprite-backed Icon contract](src/components/icon/README.md) |

Lower framework-neutral `lib` owners do not import official `workbenches`. Narrow `features`
adapters connect React/stores to those kernels. Extension code must not import product UI internals
when the SDK's framework-neutral mount/controller contract provides the seam.

## State and lifecycle

Shells own presentation. Documents, open groups, terminals, runtime identity, and domain facts remain
with their existing shared or Host owner. Same-Host directory resolution can retain the rendered shell,
but must not supply the previous workspace ID as the new target. Failed resolution, Host replacement,
or a revoked contribution is a different state and cannot keep a stale authority alive.

Async work captures Host/API epoch and its actual Thread, branch, resource, or contribution
identity. Changing targets invalidates both the request and its intended mutation target. A cached view
can preserve continuity but cannot turn missing, loading, failed, or inaccessible data into success.
Complete authoritative snapshots and partial save responses have different merge semantics.

Conversation cards project native history IDs and original request metadata. File navigation resolves the
history item's original source through the Host before opening Documents; the selected navigation project
does not identify a task's working copy. Child rows follow Catalog execution admission order, while reports
remain attached to their original execution. Context summary history is read through its parent-owned job.

Child file review binds an immutable publication to its original parent source. Explicit User apply/undo
commands use native user Operations and the existing Integration journal. Preview refresh reads those
records; it does not repeat writes. Dirty editor buffers keep their Documents revision checks.

High-frequency document text, cursor motion, streaming output, and transition frames stay close to
owners with narrow subscriptions. Zustand holds appropriate navigation, preference, and keyed query
state; it is not a universal storage layer. Dirty text never belongs in Local Storage. Profile changes
must not recreate text models, accepted execution, or terminal processes.

Connected workbench mounts participate in the existing Surface preparation lease. Their real hidden
mounts validate before publication; closure, replacement, and render failure fence that lease. Once the
Host confirms durable selection, local mount cleanup cannot claim the catalog or an external effect
rolled back. Detailed lifecycle mechanics belong to the extension packages.

## Conversation and resource projections

Tool headings summarize the requested action and its subject before disclosure, then add returned
facts where useful (process state, confirmed input, output size, matches or restored paths). Each
purpose-specific renderer keeps its interaction model; `ToolHeadingText` shares typography only.
`ToolTargetScope` resolves process commands and child names from loaded native call identities,
including gateway targets. It does not fetch additional history or retain a cross-thread cache.
Missing subjects stay unknown, and requested mutations never substitute for completed receipts.
Narrow viewports wrap subjects instead of hiding them; original arguments remain in details.

Chat layout offers chronological, grouped-answer, and conversation-first (`dialogue`) modes.
Conversation-first is the default for unset preferences and resets; saved choices retain their mode.
Conversation-first preserves every spoken message in arrival order. Ordinary tools and public
thinking between messages share one initially collapsed activity row: the active segment shows
the current action, while a later spoken message or the end of the Run leaves a receipt-based
summary. Dispatches, questions and usable UI/image outputs (including observed script descendants)
remain independent rows in all three modes. Opening a segment mounts the existing purpose-specific tools, preserving their controls and
resource identities. Failed, cancelled, and uncertain work stays visible in the collapsed status.
Provider-item identities and arrival order survive streaming-to-history replacement; disclosure
choices belong to the original segment and the conversation, rather than the latest render.
The settings preview uses these same projections with inert, manually stepped examples.

Ordinary successful calls recede without a repeated completed badge. Applied changes, drafts and branch
edits keep distinct effect labels; activity summaries count confirmed calls, not guessed unique files.
Follow-up rows distinguish current task state from a recorded invocation and empty lists from creation.
Script call history loads on expansion; headings only use already observed facts. Sorted activity rows
remain mounted through collapse so the existing virtual list can measure the height transition.

Turn footers keep actions on the left and usage directly visible on the right. Positive cache read/write
metrics appear inline. Cache rate is cached reads / complete input, derived by the native provider owner;
aggregate rates require known, deduplicated receipts and use weighted token totals. Original protocol
usage is retained independently of this complete-input presentation field.

`ThreadQuestions` owns a nonmodal, composer-width dock above the input. `ask_user` schema 2 accepts
stable question/option IDs, multiple questions, single/multiple choice and free text. A complete answer
is submitted once to its original Operation; Catalog validates against the original question and keeps
its ordinary Wait/history ownership. `question_status` returns both readable and structured answers.
Memory-only drafts retain selection, text, navigation and scroll per Host/Thread/branch/Operation;
collapsing, navigating or switching presentation does not discard them. Uncertain submission re-reads
the original Operation before retrying its frozen intent. Question receipts stay in the original turn.

`ThreadPermission` keeps allow-once / always / deny separate from questions. Always saves a user rule
through the Host configuration owner before deciding the original permission; partial saving/decision
failure is shown explicitly. The visible scope currently covers the named extension/MCP capability
and its arguments on the selected Host. Native source grants still own filesystem/process scope.
Workspace restrictions take precedence. Subsequent authorization reads current policy; a saved rule
does not bypass the original owner, pinned invocation or execution checks. Rules remain removable in
the existing permission settings. Settings page layout is outside this chat implementation.

The native Catalog owns accepted input, history, queues and execution receipts. `useThreadStore`
projects navigation and summary clocks; `ThreadProjection` observes the selected branch. Progress
streams are transient and sequence-scoped. A lost connection rebuilds from durable history rather than
inventing completion or automatically resending input. Drafts retain exact uncertain command intent.

Opening a new conversation creates only a local composer. Its first explicit send creates the Thread,
prepares the selected source and uploads staged PDFs. The composer keeps its key across that transition,
so editor attachments and message handoff stay attached. Creation and uncertain submission retries reuse
their original keys. Source Host discovery is available before creation and grants no file access.

`ThreadConversation` projects native Agent facts through `ThreadsAPI`. Its child, family, follow-up,
plan, Goal, permission, question and recovery components keep their original owner and revision.
The work overview projects current execution, plan steps, child tasks and saved outputs. Its quick and
full views use compact floating cards in a reserved layout column, so neither covers the conversation
or composer. Cards fit their content with internal scrolling when needed; the full card has a resizable
width. Narrow conversations stack the card above the chat. Disclosure and width state remain outside
streaming timeline subscriptions. Empty capability categories are not shown.
Plan summaries show up to three steps around the current work, with two wrapped lines per
step and a link to the full plan. The plan detail switches its content area between reading
and editing, grows the editor with its text, and keeps save/cancel controls in view. Concurrent
plan changes retain the draft and offer the latest revision for comparison before rebasing.
Workspace, goal, follow-up, memory, research and recovery editors mount on first inspection and retain
their drafts across panel navigation. Context resources and compression jobs share the context detail.
The plan reader stays subscribed to its existing branch events, while tool/operation bodies are read
only in their detail view. Full execution controls remain available from the overview menu.

Saved file changes and interactive HTML are projected from native calls and receipts. The overview
uses its own disposable history reader, so timeline virtualization cannot remove its entries. It finishes
the current Run's page boundary for file counts and reads older pages as the output list is browsed.
Failed writes are excluded; editor drafts, committed working-copy changes and applied files keep their
different labels. File navigation retains the original history item; HTML opens the saved content ref
with its original Thread/branch. Neither view substitutes the current project's Git changes.

The overview's child section is a task list. Row context menus and hover buttons share actions for
opening, inspecting, renaming, copying, sending another instruction and stopping the selected task.
Completed tasks offer continuation through the existing message request path; read-only views hide
mutations. Agent profile settings, family browsing and message-directory controls do not sit below
the list. Renaming uses the Thread catalog owner, and an uncertain instruction retry retains its key.
Showing a resource or history view does not launch work. A follow-up registration observes its original
Job/source and cursor; it never stops the observed Job or uses a renderer timer as a scheduler.

The right-hand Collaboration surface reads the native family message feed, including exchanges between
peers. Its virtual list prefetches older messages and merges new arrivals by original message identity.
Member selection mounts one original Thread history/progress reader with a separate viewport key; main
conversation scroll state stays independent. Completed members are paged through the native history
directory. User replies and per-recipient send attempts use the original message admission API, with
drafts and uncertain keys retained in the existing in-memory draft store. File cards read immutable
Integration journal versions on inspection; current working files are never substituted for an old diff.

`HistoryPresentation` projects semantic history into the timeline without replacing its IDs. Model
labels and token receipts come from the original frozen request, not today's selected model; usage is
counted once per request even when it produced several visible items. Tool-call identity includes its
Run and request. Cancelled, indeterminate, accepted background work and success have distinct states.
`thread-history` caches read-only bodies by Host epoch, Thread and branch, merging live tails and
prefetched pages through native parent IDs. It retains reading history on return, bridges unseen
appends, drops a rewound future, and aborts reads on view-owner departure. Whole-Run usage is a
separate cancellable Host read; bodies and progress never await that scan. Summaries carry their
original cut and appear once after the ended Run, with unknown receipts kept distinct from zero.
`chatTimelineBlocks` separates logical turns (quotes and copy) from measured user,
message, activity and footer rows. Stable native row IDs let the virtual list compensate prepends
and height changes; sticky user prompts use the list's own sticky-header support. Upward prefetch
starts a viewport ahead and extends by observed speed and read latency. Ordinary history scrolling
does not enter a frozen view or require a loading button; only read failures expose retry.
The navigation rail reads a separate complete native Run index, with one pointer per Run and
ordinals from the selected branch's ancestry. Loaded body pages, virtual rows and activity folding
do not define its count or order. Hover previews read the Run's prompt/response; selecting an
unloaded Run first loads its original history anchor, then maps it to a measured row.
The header context ring and context sidebar share a separate anchored context inspection. The Host
counts immutable ancestry metadata and reads the latest original model receipt beyond visible pages;
tool-result bursts cannot erase usage just by pushing that request out of the loaded tail. Inspection
runs alongside snapshot/progress rendering. Compaction clears the old footprint until a new request
reports usage. Sidebar message bodies remain paginated, and unavailable billing stays unknown.
`timelineViewStore` owns scroll positions only. Message handoff animation targets the history ID from
the accepted input receipt. A retained outgoing scene is inert during conversation switching.

Thinking is visible by default. `collapsibleThinkingBlocks` selects a one-line live preview versus
automatic expansion; it never prevents manual folding. `ChatThinkingBlock` follows wrapped preview
lines, and expanded text grows into a bounded reading viewport. Scrolling up pauses that viewport's
following until the reader returns to the end or selects Follow new output. Disclosure and reading
position use the native assistant message ID across live/history handoff, retained only as disposable
presentation state. The animated fold keeps its body mounted and inert while closed; reduced-motion
preferences disable movement.

`ThreadContent`/`ThreadMedia` consume declared typed text/media holders, not arbitrary JSON that looks
like an image descriptor. Visible image previews and explicit attachment reads retain the original holder, part ordinal and execution
identity. Object URLs belong to the mounted view and are revoked on cancellation or target change.
Incomplete output-body pages must not be rendered as a complete report or reinterpreted as Markdown.

`components/materials/PdfMaterialReader` is the shared reader core. Thread adapters provide the
authenticated material transport and guarded draft destination. PDF upload retains original bytes in
the Host material owner; submit, queues and child continuation carry a fixed snapshot reference.
Research artifacts first resolve through the original artifact owner and then use the returned snapshot. Selected regions go to the enclosing conversation's
guarded composer; there is no global material event that can target a different Thread.

`lib/attachProcessTerminal` attaches an accepted process. Remote cwd and resource identity are metadata,
not permission to resolve that path on the coordinating Host or create a replacement local shell.
Closing an attached tab detaches; it does not stop its Job. Thread retry first reopens the original
owner/branch/operation through the Host. Attached Jobs are not persisted as restartable local shells.

Computer activity is an event projection of the Host operation. Its launcher does not probe/capture
screens or acquire control. Bot sleep/archive/delete progress is also Host-owned; opening history
never wakes a Bot. Ordinary navigation filters the native Catalog’s `bot_id` ownership before
displaying conversations.

Tool presentations use their recorded domain objects: material collections retain snapshot readers and
explicit family shares; forwarding distinguishes the service endpoint from the coordinating Host's
access address; extension review binds the original candidate integrity. Computer links open the exact
recorded desktop. Office comparisons require returned before/after readback, while export and the live
document's dirty flag remain separate. MCP task cancellation, executor stop, retained output and resource
notifications retain their separate meanings. Follow-up rows consume the existing snapshot and revisioned
control API; opening history never starts a renderer scheduler. Question choices use one wrapping
column with native radios/checkboxes, free text and explicit whole-request submission.

Source files, Git snapshots, material pages, and editor drafts retain their own identities. Explicit
resource roots resolve through Documents instead of borrowing a conversation's workspace. A file-change
preview only describes received arguments until a real result supplies its mutation outcome.
File write/edit previews appear while arguments stream, even when content precedes the path;
the completed path fills the same preview without resetting its reading position. Wrapped,
measured rows keep long lines within the viewport, and the inner scroll follows incoming
content until the user scrolls up. Explicit navigation resumes following or jumps between edits.

## Settings and authoring conventions

Settings UI consumes shared catalog identities and the original domain APIs. Device-local entries use
`client-settings-bridge.ts` and acknowledge what the target Surface actually applied. Forms preserve
unsaved field drafts and their opened revisions across refresh; conflict is not an instruction to
resubmit an entire old document. Same-owner and cross-owner results retain their real atomicity.

`components/sections/agents` uses `AgentProfilesAPI` for native profiles and exact registered tool names.
Host changes retire old reads and drafts; omitted tools, empty selection, and reset are distinct.
Accepted Runs are not rewritten by editing a default. Functional models stay with their owning settings domains.

Agent avatars share one role-independent library: `components/ui/agent-avatar-art.ts` owns the SVG paths
and `AgentAvatar` renders them at every size. Stable IDs come from the protocol registry. Native dispatch
persists a random choice on the child relation, or uses the profile's fixed choice; reuse and rename retain it.
The profile picker controls future dispatches. Legacy identities use the frozen identity-based palette in
`@varin/protocol`, so expanding the library does not change their appearance. Existing status indicators remain
separate from avatars; displaying a message does not fetch an extra profile or image.

Provider editing separates connection configuration, model discovery, and authentication. Discovery
and login have different interaction identities and cancellation. Saving a configuration is not
successful login. Credentials stay in their native owner, never renderer settings. See
[provider authority](../web/application-host/lib/models/DOCUMENTATION.md) and
[memory/personalization authority](../web/application-host/lib/memory/DOCUMENTATION.md).

Use semantic theme tokens for surfaces, actions, selection, feedback, and syntax. Theme changes update
projections rather than rebuilding models. Shared primitives own shared focus and interaction chrome;
a single layout exception does not justify another wrapper or a public contribution type.
The fold logo's source is `src/components/ui/varin-mark.ts`; generated assets must not develop independent shapes.
Custom theme format lives in [the theme guide](../../docs/ops/CUSTOM_THEMES.md).

Visible text and accessibility labels resolve through `@/lib/i18n` during render or hook execution.
Every shipped message catalog receives real translations for new semantic keys; parity tests check key
shape. Keep parameters as values rather than fragments of grammar. Product names, paths, commands,
provider/model names and user content stay literal. Locale changes should not remount the application.

## Verification and performance

Use the scripts in `package.json` and tests beside the changed owner. Behavior evidence should exercise
real transitions: interrupted/repeated actions, stale target completions, drafts, connected mounts,
queue identity, cleanup, and provider failure. Layout constants or a copied literal enum are not useful
behavior tests. Scope shared-contract checks to actual consuming surfaces.

Visible demand owns refresh and subscriptions. Hidden views release DOM observers, language requests,
Git/PR refresh work and presentation timers; hiding a view does not cancel independently owned backend
work. Preserve unrelated object identities instead of rebuilding full histories/catalogs on each delta.
Measure cold load, warm switches, paint, and cleanup on the relevant platform before adding budgets.
A virtualized viewport size is not a stored-history/content limit.

Reduced motion, keyboard navigation, focus return, narrow layouts and touch must be checked through their
real interaction paths. Unit/contract tests and source inspection do not establish browser timing,
real-device usability, authenticated provider success, or packaged Electron/mobile acceptance.
